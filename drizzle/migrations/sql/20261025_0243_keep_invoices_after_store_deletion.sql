-- Deleting a store keeps StoreMink's own invoices to that merchant (owner's
-- decision, 25 Oct 2026). StoreMink must keep its tax invoices for GST, and
-- the invoice series is gapless per financial year, so deleting an issued
-- invoice punches a hole in it. Terms section 13 and Privacy section 7 say
-- these records are kept; until now the store cascade deleted them.
--
-- ★★ AN ISSUED INVOICE AND ITS PAYMENT ATTEMPTS OUTLIVE THEIR STORE.
-- billing_invoices.store_id and billing_payment_attempts.store_id become
-- nullable with ON DELETE SET NULL, the only two direct stores(id) foreign
-- keys that do not cascade. An invoice's lines hang off the invoice
-- (billing_invoice_items ON DELETE CASCADE from billing_invoices, unchanged),
-- and so do its attempts, so both stay with a kept invoice. Everything else
-- of the store still cascades: subscription, mandates, billing account,
-- account credits, reconciliation items, AI credit purchases (their
-- invoice_id was already ON DELETE SET NULL).
--
-- ★ DRAFTS ARE NOT DOCUMENTS. A draft has no number and was never issued,
-- so deleteStore (app/actions/platform.ts) deletes the store's drafts inside
-- its own transaction, before the store row, and their lines and attempts go
-- with them. It keeps one kind of draft: one with a payment that may have
-- reached the gateway (an order id, and not failed or cancelled), because
-- that attempt is the only record of money StoreMink may have taken. Such a
-- draft stays, detached like an issued invoice, for reconciliation
-- (lib/billing/reconcile.ts flags a payment captured for a deleted store).
--
-- ★★ THE GUARD STILL FREEZES AN ISSUED INVOICE.
-- billing_invoices_guard_immutable keeps refusing every money, number and
-- kind change exactly as before, and refuses moving an invoice to another
-- store or back onto one. The one store change it allows is from a value to
-- NULL, and only while that store is being deleted: the SET NULL action runs
-- after the store row is gone, so the row is no longer visible to the guard
-- (the 0014 pattern for legal_acceptances). A direct UPDATE blanking the
-- store of a live store's invoice is refused.
--
-- ★★ BOTH PARTIES ARE RECORDED WHEN THE INVOICE IS ISSUED. The document read
-- the supplier's and the buyer's names and addresses live; only the GSTINs
-- and the place of supply were stamped on the row. Once the store, its
-- billing account and its store_billing_settings were gone, a kept invoice
-- could no longer say who it was issued to. billing_invoices.parties is a
-- write-once snapshot of both, built by billing_invoice_parties(), and a
-- trigger stamps it in the same statement that sets finalized_at. A trigger
-- rather than app code for the reason the invoice number is allocated by
-- one: finalize is reached from renewal, enrolment, add-ons, AI credits and
-- manual payment, through two functions, and the revision this migration
-- replaces keeps finalizing during the rollout. The guard lets parties go
-- from NULL to a value once and never changes it afterwards.
--
-- ★ The GSTINs and the place of supply in the snapshot are the row's own
-- columns, copied, never re-read: one invoice must not name two GSTINs.
--
-- ★ THE BACKFILL IS THE BEST AVAILABLE, NOT WHAT WAS TRUE AT ISSUE. Invoices
-- issued before this migration get their parties from the settings as they
-- stand today, the only record there is; capturedAt in each snapshot says
-- when it was taken.
--
-- ★ 0014's durable check "every direct store foreign key cascades on
-- deletion" stops being true here. The manifest entry supersedes it and
-- carries the replacement: every other direct store foreign key cascades.
--
-- Backward compatible: the replaced revision writes store_id on every row
-- it inserts, never reads parties, and finalizes through an UPDATE of
-- finalized_at, which the trigger stamps as well.

-- ── 1. The snapshot column ──────────────────────────────────────────────────
ALTER TABLE public.billing_invoices
  ADD COLUMN IF NOT EXISTS parties jsonb;

-- ── 2. Issued invoices and their payment attempts outlive the store ─────────
ALTER TABLE public.billing_invoices
  ALTER COLUMN store_id DROP NOT NULL;
ALTER TABLE public.billing_invoices
  DROP CONSTRAINT IF EXISTS billing_invoices_store_id_fkey;
ALTER TABLE public.billing_invoices
  ADD CONSTRAINT billing_invoices_store_id_fkey
  FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE SET NULL;

ALTER TABLE public.billing_payment_attempts
  ALTER COLUMN store_id DROP NOT NULL;
ALTER TABLE public.billing_payment_attempts
  DROP CONSTRAINT IF EXISTS billing_payment_attempts_store_id_fkey;
ALTER TABLE public.billing_payment_attempts
  ADD CONSTRAINT billing_payment_attempts_store_id_fkey
  FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE SET NULL;

-- ── 3. Who an invoice is from and to ────────────────────────────────────────
-- The supplier is StoreMink (platform_billing_settings). The customer is the
-- store's billing account first, then the identity the merchant keeps under
-- Taxes & invoices (store_billing_settings), then the store's own name: the
-- billing account is written with no name or address today, so without the
-- fallbacks every snapshot would say nothing about who was billed. A free-text
-- business address becomes its first line and the rest. Blank strings are
-- dropped, never stored.
CREATE OR REPLACE FUNCTION public.billing_invoice_parties(
  p_store_id uuid,
  p_supplier_gstin text,
  p_customer_gstin text,
  p_place_of_supply text
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'version', 1,
    'capturedAt', now(),
    'supplier', jsonb_build_object(
      'name', nullif(btrim(p.legal_name), ''),
      'gstin', nullif(btrim(p_supplier_gstin), ''),
      'stateCode', nullif(btrim(p.state_code), ''),
      'address', addr.supplier
    ),
    'customer', jsonb_build_object(
      'name', coalesce(
        nullif(btrim(a.legal_name), ''),
        nullif(btrim(b.legal_name), ''),
        nullif(btrim(b.business_name), ''),
        nullif(btrim(s.name), '')
      ),
      'gstin', nullif(btrim(p_customer_gstin), ''),
      'stateCode', nullif(btrim(p_place_of_supply), ''),
      'email', coalesce(
        nullif(btrim(a.billing_email), ''),
        nullif(btrim(b.contact_email), '')
      ),
      'address', CASE
        WHEN addr.account <> '{}'::jsonb THEN addr.account
        ELSE jsonb_strip_nulls(jsonb_build_object(
          'line1', biz.lines[1],
          'line2', nullif(array_to_string(biz.lines[2:], ', '), '')
        ))
      END
    )
  )
  FROM (SELECT 1) AS one
  LEFT JOIN public.platform_billing_settings p ON p.id
  LEFT JOIN public.stores s ON s.id = p_store_id
  LEFT JOIN public.billing_accounts a ON a.store_id = p_store_id
  LEFT JOIN public.store_billing_settings b ON b.store_id = p_store_id
  CROSS JOIN LATERAL (
    SELECT
      jsonb_strip_nulls(jsonb_build_object(
        'line1', nullif(btrim(p.address ->> 'line1'), ''),
        'line2', nullif(btrim(p.address ->> 'line2'), ''),
        'city', nullif(btrim(p.address ->> 'city'), ''),
        'postalCode', nullif(btrim(p.address ->> 'postalCode'), '')
      )) AS supplier,
      jsonb_strip_nulls(jsonb_build_object(
        'line1', nullif(btrim(a.address ->> 'line1'), ''),
        'line2', nullif(btrim(a.address ->> 'line2'), ''),
        'city', nullif(btrim(a.address ->> 'city'), ''),
        'postalCode', nullif(btrim(a.address ->> 'postalCode'), '')
      )) AS account
  ) AS addr
  CROSS JOIN LATERAL (
    SELECT array_remove(
      regexp_split_to_array(btrim(b.business_address), '\s*[\r\n]+\s*'),
      ''
    ) AS lines
  ) AS biz
$$;

REVOKE ALL ON FUNCTION public.billing_invoice_parties(uuid, text, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_invoice_parties(uuid, text, text, text)
  FROM app_user;
GRANT EXECUTE ON FUNCTION public.billing_invoice_parties(uuid, text, text, text)
  TO app_service;

-- ── 4. The guard: identical, plus the two rules above ───────────────────────
-- Every arm is a boolean that is never NULL (IS DISTINCT FROM, IS NOT NULL,
-- EXISTS), so no arm can pass by evaluating to NULL.
CREATE OR REPLACE FUNCTION public.billing_invoices_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  if old.finalized_at is null then
    return new;
  end if;

  if new.subtotal_paise is distinct from old.subtotal_paise
     or new.discount_paise is distinct from old.discount_paise
     or new.tax_paise      is distinct from old.tax_paise
     or new.total_paise    is distinct from old.total_paise
     or new.currency       is distinct from old.currency
     or new.kind           is distinct from old.kind
     or (new.store_id is distinct from old.store_id
         and (new.store_id is not null
              or exists (select 1 from public.stores where id = old.store_id)))
     or new.cycle_seq      is distinct from old.cycle_seq
     or new.invoice_ref    is distinct from old.invoice_ref
     or new.invoice_no     is distinct from old.invoice_no
     or new.tax_rate_bps   is distinct from old.tax_rate_bps
     or (old.parties is not null and new.parties is distinct from old.parties) then
    raise exception
      'billing_invoices: % is finalized; issue an adjustment instead of editing it',
      old.invoice_ref;
  end if;
  return new;
end;
$$;

-- ── 5. Stamp the parties when an invoice is issued ──────────────────────────
-- BEFORE INSERT OR UPDATE OF finalized_at, the shape of the trigger that
-- allocates the number. A snapshot already present is never replaced.
CREATE OR REPLACE FUNCTION public.billing_invoices_snapshot_parties()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if new.finalized_at is not null and new.parties is null then
    new.parties := public.billing_invoice_parties(
      new.store_id, new.supplier_gstin, new.customer_gstin, new.place_of_supply);
  end if;
  return new;
end;
$$;

REVOKE ALL ON FUNCTION public.billing_invoices_snapshot_parties() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_invoices_snapshot_parties() FROM app_user;

DROP TRIGGER IF EXISTS billing_invoices_parties_snapshot
  ON public.billing_invoices;
CREATE TRIGGER billing_invoices_parties_snapshot
  BEFORE INSERT OR UPDATE OF finalized_at ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_invoices_snapshot_parties();

-- ── 6. Backfill every invoice already issued ────────────────────────────────
-- From today's settings: the best available record, see the note at the top.
-- The guard allows exactly this, NULL to a value, on an issued invoice.
UPDATE public.billing_invoices
   SET parties = public.billing_invoice_parties(
         store_id, supplier_gstin, customer_gstin, place_of_supply)
 WHERE finalized_at IS NOT NULL
   AND parties IS NULL;
