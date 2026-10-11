-- Refund and store-credit integrity (the 2026-10-11 refund audit).
--
-- Four schema pieces and three Help edits, all additive:
--
-- 1. `cashback_reversal`, a new ledger kind. Cashback used to be issued the
--    moment an order was placed, before any payment, and nothing ever took it
--    back: abandoning a Razorpay payment, cancelling, or refunding the order in
--    full all left the customer holding the promotional credit. Cashback is
--    now issued once the order is PAID and reversed when the order is
--    cancelled or refunded. A reversal is its own kind, not a `spend`: a spend
--    row is keyed on the order id, and the unique index is per
--    (store, customer, kind, ref), so a reversal written as a spend would
--    collide with the order's real spend and fail.
--
-- 2. `reverse_customer_cashback()`, the one way a reversal moves money. It
--    takes AT MOST what the customer still holds: the balance CHECK forbids a
--    negative balance, and cashback the customer has already spent cannot be
--    taken back from a balance that no longer has it. Idempotent per ref, so
--    a retried refund or a second cancel reverses nothing twice.
--
-- 3. `orders.cashback_amount` / `orders.cashback_note`. The offer engine's
--    answer exists only while the checkout runs, and the payment may land
--    hours later, so the amount the order earns is kept on the order. Backfilled
--    from the ledger for cashback already issued, so a refund of an older order
--    can reverse it too.
--
-- 4. `order_returns.idempotency_key`. A till return retried after a lost
--    response, or sent from two tabs, created a second return and paid the
--    customer twice. The key makes the second submit answer with the first.
--
-- ★ No column is dropped, renamed or narrowed, and every new column is
-- nullable or defaulted, so the revision being replaced keeps working during
-- the rollout. That revision still issues cashback at placement and writes no
-- `cashback_amount`; an order placed by it during the rollout window keeps its
-- cashback and simply has nothing recorded to reverse.

-- 1. The ledger kind -------------------------------------------------------
ALTER TABLE public.customer_credit_ledger
  DROP CONSTRAINT customer_credit_ledger_kind_check,
  ADD CONSTRAINT customer_credit_ledger_kind_check CHECK (
    kind IN ('refund', 'grant', 'spend', 'reinstate', 'expire', 'cashback',
             'cashback_reversal')
  );

-- 2. The reversal ----------------------------------------------------------
-- Returns the rupees actually taken back (0 when there was nothing to take or
-- this ref was already reversed). The balance row is locked first so two
-- reversals for one customer cannot both read the same balance.
CREATE OR REPLACE FUNCTION public.reverse_customer_cashback(
  p_store    uuid,
  p_customer text,
  p_amount   numeric,
  p_ref      text,
  p_note     text DEFAULT NULL
)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_balance numeric;
  v_take    numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN 0;
  END IF;
  IF p_ref IS NULL OR btrim(p_ref) = '' THEN
    RAISE EXCEPTION 'reverse_customer_cashback: a ref is required';
  END IF;

  SELECT balance INTO v_balance
    FROM public.customer_credit_balances
   WHERE store_id = p_store AND customer_id = p_customer
   FOR UPDATE;

  IF v_balance IS NULL OR v_balance <= 0 THEN
    RETURN 0;
  END IF;

  v_take := least(v_balance, p_amount);

  BEGIN
    INSERT INTO public.customer_credit_ledger
      (store_id, customer_id, delta, kind, ref, note)
    VALUES (p_store, p_customer, -v_take, 'cashback_reversal', p_ref, p_note);
  EXCEPTION WHEN unique_violation THEN
    RETURN 0;  -- this ref was already reversed
  END;

  UPDATE public.customer_credit_balances
     SET balance = balance - v_take, updated_at = now()
   WHERE store_id = p_store AND customer_id = p_customer;

  RETURN v_take;
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_customer_cashback(
  uuid, text, numeric, text, text
) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.reverse_customer_cashback(
  uuid, text, numeric, text, text
) TO app_service;

-- 3. What an order earns ---------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cashback_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cashback_note text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'orders_cashback_amount_check'
       AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_cashback_amount_check CHECK (cashback_amount >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.orders.cashback_amount IS
  'Store credit this order earns from a cashback offer. Issued once the order is paid (ledger kind cashback, ref = order id) and reversed, up to the customer''s balance, when the order is cancelled or refunded.';

-- Cashback already issued before this migration: record it on its order so a
-- later refund or cancellation can reverse it. The ledger row is keyed on the
-- order id, which is how checkout and the till have always written it. This
-- runs BEFORE the trigger below exists, and the ledger row is there already,
-- so nothing is issued twice either way (the ledger is unique per ref).
UPDATE public.orders o
   SET cashback_amount = l.delta
  FROM public.customer_credit_ledger l
 WHERE l.kind = 'cashback'
   AND l.store_id = o.store_id
   AND l.ref = o.id::text
   AND l.delta > 0
   AND o.cashback_amount = 0;

-- ★★ ISSUED BY A TRIGGER, the credit-note reasoning (returns_04): an order
-- becomes paid or delivered from at least six places (the online payment
-- claim, a store-credit-only checkout, the pickup counter, the dashboard
-- status control, the courier tracking webhook and Mink's delivery-status
-- action), and the one a hook forgets is the one whose customer never gets
-- their cashback. The rule lives in the table instead.
--
-- Paid means money was taken: a paid payment status, or a cash-on-delivery
-- order that has been delivered (nothing marks COD paid automatically). A
-- cancelled order never earns it. Exactly once: the ledger is unique per
-- (store, customer, kind, ref) and the ref is the order id.
--
-- ⚠ The application only ever SETS cashback_amount after the order has
-- committed, never in the INSERT, because checkout and the till both delete
-- an order row when a later step fails; cashback written into that INSERT
-- would outlive the order it was earned on.
CREATE OR REPLACE FUNCTION public.issue_order_cashback()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.cashback_amount IS NULL OR NEW.cashback_amount <= 0
     OR NEW.customer_id IS NULL
     OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF NOT (
    NEW.payment_status IN ('paid', 'partially_refunded')
    OR (NEW.payment_method = 'cash_on_delivery'
        AND (NEW.status IN ('delivered', 'completed')
             OR NEW.delivered_at IS NOT NULL))
  ) THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO public.customer_credit_ledger
      (store_id, customer_id, delta, kind, ref, note)
    VALUES (NEW.store_id, NEW.customer_id, NEW.cashback_amount, 'cashback',
            NEW.id::text, NEW.cashback_note);
  EXCEPTION WHEN unique_violation THEN
    RETURN NEW;  -- already issued
  END;

  INSERT INTO public.customer_credit_balances
    (store_id, customer_id, balance, updated_at)
  VALUES (NEW.store_id, NEW.customer_id, NEW.cashback_amount, now())
  ON CONFLICT (store_id, customer_id) DO UPDATE
    SET balance = public.customer_credit_balances.balance + excluded.balance,
        updated_at = now();

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_order_cashback() FROM PUBLIC, app_user;

DROP TRIGGER IF EXISTS orders_issue_cashback ON public.orders;
CREATE TRIGGER orders_issue_cashback
  AFTER INSERT OR UPDATE OF payment_status, status, delivered_at, cashback_amount
  ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.issue_order_cashback();

-- 4. Till return retries ---------------------------------------------------
ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS order_returns_idempotency_key
  ON public.order_returns (store_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.order_returns.idempotency_key IS
  'Generated by the till per return attempt. A second submit with the same key answers with the first return instead of recording, and refunding, it twice.';

-- Help Centre ---------------------------------------------------------------
-- Each replace() quotes one sentence, so an edit elsewhere in the same
-- paragraph cannot turn it into a no-op; applyVerify fails if one does not
-- land.

-- Offers guide: when cashback is added, and that it comes back off.
UPDATE public.help_articles
SET body = replace(body,
  $old$The credit is added once the order is placed, and it appears in the customer's account alongside any refunds they hold.$old$,
  $new$The credit is added once the order is paid: straight away for an online, store-credit or in-store payment, and when the order is delivered or collected for cash on delivery and pay at store. It appears in the customer's account alongside any refunds they hold. If the order is cancelled, the cashback comes off their balance again, and a refund takes back a matching share of it, never more than they still hold.$new$),
  updated_at = now()
WHERE slug = 'create-and-manage-offers' AND status = 'published';

-- Store credit guide: credit restored by a cancellation is not owed twice.
UPDATE public.help_articles
SET body = replace(body,
  $old$A later dashboard refund does not automatically reinstate previously spent credit; it issues new credit only when staff explicitly choose <strong>Store credit</strong> as the refund destination.$old$,
  $new$A later dashboard refund does not automatically reinstate previously spent credit; it issues new credit only when staff explicitly choose <strong>Store credit</strong> as the refund destination. Credit that a cancellation has already restored is not counted as owed again, so the order then shows only the part paid with money as still to refund.$new$),
  updated_at = now()
WHERE slug = 'use-and-understand-store-credit' AND status = 'published';

-- Razorpay guide: live keys only.
UPDATE public.help_articles
SET body = replace(body,
  $old$<li>Sign in to Razorpay and create API keys under <strong>Settings → API keys</strong>.</li>$old$,
  $new$<li>Sign in to Razorpay, switch to <strong>Live mode</strong>, and create API keys under <strong>Settings → API keys</strong>. Live keys start with <code>rzp_live_</code>. Test-mode keys are refused, because payments and refunds made with them are not real.</li>$new$),
  updated_at = now()
WHERE slug = 'connect-razorpay-and-accept-online-payments' AND status = 'published';

-- POS returns guide: an exchange replacement comes back as store credit, and a
-- cash refund needs an open drawer when the store requires one.
UPDATE public.help_articles
SET body = replace(body,
  $old$<li>Only a legacy order with no usable tender record asks the manager to choose a supported counter refund method.</li></ul>$old$,
  $new$<li>Only a legacy order with no usable tender record asks the manager to choose a supported counter refund method.</li><li>A replacement order sent in an exchange was paid for with the goods the customer returned, so returning it gives store credit to the attached customer, never cash or a card refund. With no customer attached, the till takes the items back and the refund is completed from the dashboard.</li><li>If <strong>Require an open shift to sell</strong> is enabled, a cash refund waits until a manager opens the drawer. Card, UPI and store-credit refunds are not affected.</li></ul>$new$),
  updated_at = now()
WHERE slug = 'take-returns-at-the-counter' AND status = 'published';

-- POS shifts guide: the open-shift rule covers cash refunds too.
UPDATE public.help_articles
SET body = replace(body,
  $old$the register refuses sales, deposits, and unpaid pickup collection until a manager opens the drawer.$old$,
  $new$the register refuses sales, deposits, unpaid pickup collection, and cash refunds until a manager opens the drawer.$new$),
  updated_at = now()
WHERE slug = 'open-close-and-reconcile-cash-shifts' AND status = 'published';
