-- Money StoreMink receives for a cycle a plan never reaches goes back, and
-- the refund has a document (Terms v2 section 4; CPA 2019 s.2(46)(vi) and
-- 2(47); Dark Patterns Guidelines 2023 items 5 and 12; CGST Act s.34).
-- Owner decisions of 27 Oct 2026: a merchant may cancel at any time and is
-- refunded automatically; automatic sending ships switched off (auto_refunds
-- below) until the owner turns it on. The structure only: the refund pass,
-- the credit notes and every screen that reads these tables come with the
-- code of the same release. Pinned by lib/billing/refunds-migration.test.ts.
--
-- ★★ A CLOSED INVOICE IS THE MARKER. When a plan ends before a cycle that
-- already has an invoice, the app sets that invoice to 'void' (an unpaid
-- non-payment one is 'uncollectible' since 0205). A captured payment on a
-- void or uncollectible subscription invoice is money for a cycle the plan
-- does not reach, and the billing cron refunds it. No new invoice column:
-- billing_invoices.status is not frozen by the 0245 guard.
--
-- ★★ NO STORE COLUMN ON EITHER NEW TABLE. A refund and a credit note belong
-- to one invoice, and the invoice already carries the store (0243: SET NULL
-- when the store is deleted; the 0245 guard refuses moving an issued invoice
-- to another store). A second store key would be a copy that can disagree,
-- and a new non-cascading foreign key to stores would break 0243's durable
-- check that every other direct store foreign key cascades. Store deletion
-- therefore never touches these tables.
--
-- ★★ billing_refunds IS THE OBLIGATION AND ITS EXECUTION, ONE ROW PER REFUND.
-- A row is written BEFORE any gateway call, carrying an idempotency key WE
-- minted (the lib/payments/issue-refund.ts pattern). Statuses:
--   owed       decided, not yet sent (inserted by the cron or an operator)
--   pending    sent, or its answer was never read; the cron settles it
--   processed  Razorpay processed it (final)
--   failed     Razorpay refused it or reported it failed (final; a retry is
--              a NEW row an operator asks for)
--   cancelled  an operator decided it is not to be sent (final, with why)
--   recorded   a refund made outside this tool, recorded by an operator
--              (inserted final: a bank transfer, or one made by hand in the
--              Razorpay dashboard)
-- What a refund IS (invoice, payment, amount, reason, method, key, who asked
-- and their note) never changes once written. notified_at is written once,
-- when the merchant is told a finished refund reached them.
--
-- ★★ A REFUND NEVER EXCEEDS THE PAYMENT IT REVERSES. billing_refunds_guard
-- locks the payment attempt row and refuses a row that would take the live
-- and finished refunds of that payment (every status but failed and
-- cancelled) past its amount. Razorpay refuses that too; the database is the
-- guarantee. ⚠ The guard runs BEFORE an ON CONFLICT arbiter, so a second
-- automatic insert raises here rather than doing nothing: the cron checks
-- for an existing refund while holding the attempt lock, then inserts.
--
-- ★★ ONE AUTOMATIC REFUND PER PAYMENT, EVER. The cron writes at most one
-- system row per payment attempt (unique index), whatever runs twice; if it
-- fails, a person decides, so the cron never retries a refusal by itself.
-- An operator's retry (same reason, requested_by an email) is not blocked.
--
-- ★★ billing_credit_notes: StoreMink's own credit notes, a gapless series per
-- Indian financial year ("CN/2026-27/00001", 16 characters, the most a GST
-- credit note serial may have), allocated by trigger on insert, the
-- billing_invoices pattern. What the note prints from the invoice (the tax
-- rate, both GSTINs, the place of supply, both parties) is COPIED BY THE
-- TRIGGER from the invoice row, never carried in. The notes of one invoice
-- never add up to more than that invoice, in total or in tax. A note is never
-- edited or deleted.
--
-- Expand only: three new tables, their functions and triggers, four new
-- nullable or defaulted columns, two indexes on existing tables, grants.
-- Nothing the replaced revision reads or writes changes meaning, so it keeps
-- running unchanged during the rollout.

-- ── 1. Refunds ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          uuid NOT NULL REFERENCES public.billing_invoices(id) ON DELETE RESTRICT,
  attempt_id          uuid NOT NULL REFERENCES public.billing_payment_attempts(id) ON DELETE RESTRICT,
  reason              text NOT NULL,
  status              text NOT NULL,
  method              text NOT NULL DEFAULT 'razorpay',
  amount_paise        bigint NOT NULL,
  idempotency_key     text NOT NULL,
  provider_payment_id text,
  provider_refund_id  text,
  external_reference  text,
  failure_reason      text,
  -- 'system' for the cron, the operator's email otherwise.
  requested_by        text NOT NULL,
  note                text,
  resolution_note     text,
  sent_at             timestamptz,
  resolved_at         timestamptz,
  -- When the merchant was told this refund reached them (written once).
  notified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_refunds_amount_check CHECK (amount_paise > 0),
  CONSTRAINT billing_refunds_reason_check CHECK (reason IN (
    'cycle_not_reached', 'feature_removed', 'suspended_by_mistake',
    'declined_terms', 'duplicate_payment', 'goodwill', 'other')),
  CONSTRAINT billing_refunds_status_check CHECK (status IN (
    'owed', 'pending', 'processed', 'failed', 'cancelled', 'recorded')),
  CONSTRAINT billing_refunds_method_check CHECK (method IN ('razorpay', 'bank_transfer')),
  -- Razorpay's own rule for X-Refund-Idempotency (lib/payments/razorpay.ts).
  CONSTRAINT billing_refunds_key_shape CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{10,}$'),
  CONSTRAINT billing_refunds_key_key UNIQUE (idempotency_key),
  CONSTRAINT billing_refunds_requested_by_check CHECK (length(btrim(requested_by)) > 0),
  -- Every arm below is a boolean that is never NULL (IS NULL, IS NOT NULL,
  -- comparisons of NOT NULL columns, AND with a false arm), so no row passes
  -- by evaluating to NULL.
  CONSTRAINT billing_refunds_resolved_shape CHECK (
    (status IN ('processed', 'failed', 'cancelled', 'recorded')) = (resolved_at IS NOT NULL)),
  CONSTRAINT billing_refunds_sent_shape CHECK (
    status NOT IN ('pending', 'processed') OR sent_at IS NOT NULL),
  CONSTRAINT billing_refunds_gateway_needs_payment CHECK (
    method <> 'razorpay' OR provider_payment_id IS NOT NULL),
  -- Razorpay's floor is 1 rupee (rzpRefund refuses less), so a refund the
  -- gateway is to send is never written below it; a recorded one may be.
  CONSTRAINT billing_refunds_gateway_minimum CHECK (
    method <> 'razorpay' OR status = 'recorded' OR amount_paise >= 100),
  CONSTRAINT billing_refunds_processed_has_refund CHECK (
    status <> 'processed' OR provider_refund_id IS NOT NULL),
  CONSTRAINT billing_refunds_bank_transfer_is_recorded CHECK (
    method <> 'bank_transfer' OR status = 'recorded'),
  CONSTRAINT billing_refunds_recorded_has_reference CHECK (
    status <> 'recorded' OR provider_refund_id IS NOT NULL OR external_reference IS NOT NULL),
  -- A person always says why; the cron writes only the automatic reason.
  CONSTRAINT billing_refunds_person_gives_reason CHECK (
    requested_by = 'system' OR (note IS NOT NULL AND length(btrim(note)) > 0)),
  CONSTRAINT billing_refunds_system_is_automatic CHECK (
    requested_by <> 'system' OR (reason = 'cycle_not_reached' AND status <> 'recorded')),
  CONSTRAINT billing_refunds_cancel_says_why CHECK (
    status <> 'cancelled' OR (resolution_note IS NOT NULL AND length(btrim(resolution_note)) > 0)),
  CONSTRAINT billing_refunds_failure_says_why CHECK (
    status <> 'failed' OR (failure_reason IS NOT NULL AND length(btrim(failure_reason)) > 0)),
  -- Only a refund that reached the merchant is announced as such.
  CONSTRAINT billing_refunds_notified_shape CHECK (
    notified_at IS NULL OR status IN ('processed', 'recorded'))
);

-- One automatic refund per payment, ever: a second cron pass inserts nothing.
-- A failed automatic refund is retried by a person (a new, operator-requested
-- row with the same reason), never by the cron.
CREATE UNIQUE INDEX IF NOT EXISTS billing_refunds_one_automatic
  ON public.billing_refunds (attempt_id)
  WHERE requested_by = 'system';

CREATE UNIQUE INDEX IF NOT EXISTS billing_refunds_provider_refund_key
  ON public.billing_refunds (provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;

-- The cron's work list and the console's "needs a person" list.
CREATE INDEX IF NOT EXISTS billing_refunds_work_idx
  ON public.billing_refunds (status, updated_at)
  WHERE status IN ('owed', 'pending', 'failed');

-- Finished refunds the merchant has not been told about yet.
CREATE INDEX IF NOT EXISTS billing_refunds_to_notify_idx
  ON public.billing_refunds (resolved_at)
  WHERE status IN ('processed', 'recorded') AND notified_at IS NULL;

-- Per store, through the invoice (billing_invoices_store_idx).
CREATE INDEX IF NOT EXISTS billing_refunds_invoice_idx
  ON public.billing_refunds (invoice_id, created_at DESC);

CREATE INDEX IF NOT EXISTS billing_refunds_attempt_idx
  ON public.billing_refunds (attempt_id);

CREATE OR REPLACE FUNCTION public.billing_refunds_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
declare
  v_inv_final   timestamptz;
  v_att_invoice uuid;
  v_att_state   text;
  v_att_amount  bigint;
  v_att_payment text;
  v_used        bigint;
begin
  if tg_op = 'UPDATE' then
    -- What a refund IS never changes once written.
    if new.invoice_id          is distinct from old.invoice_id
       or new.attempt_id          is distinct from old.attempt_id
       or new.amount_paise        is distinct from old.amount_paise
       or new.reason              is distinct from old.reason
       or new.method              is distinct from old.method
       or new.idempotency_key     is distinct from old.idempotency_key
       or new.requested_by        is distinct from old.requested_by
       or new.note                is distinct from old.note
       or new.provider_payment_id is distinct from old.provider_payment_id
       or new.created_at          is distinct from old.created_at
       or (old.provider_refund_id is not null
           and new.provider_refund_id is distinct from old.provider_refund_id)
       or (old.notified_at is not null
           and new.notified_at is distinct from old.notified_at) then
      raise exception 'billing_refunds: % is fixed once written; record a new refund instead', old.id;
    end if;

    if new.status is distinct from old.status then
      if not ((old.status = 'owed' and new.status in ('pending', 'processed', 'failed', 'cancelled'))
              or (old.status = 'pending' and new.status in ('processed', 'failed'))) then
        raise exception 'billing_refunds: % cannot move from % to %', old.id, old.status, new.status;
      end if;
    elsif old.status in ('processed', 'failed', 'cancelled', 'recorded')
          and (to_jsonb(new) - 'notified_at' - 'updated_at')
              is distinct from (to_jsonb(old) - 'notified_at' - 'updated_at') then
      -- A final row changes nothing but the one-time notice stamp.
      raise exception 'billing_refunds: % is %, which is final', old.id, old.status;
    end if;
    -- Moving out of a counted status only frees an amount, so the cap needs
    -- no re-check here; nothing moves INTO a counted status by UPDATE.
    return new;
  end if;

  -- INSERT: a refund starts owed, or is recorded as already made.
  if new.status is null or new.status not in ('owed', 'recorded') then
    raise exception 'billing_refunds: a refund starts owed, or is recorded as already made';
  end if;
  if new.notified_at is not null then
    raise exception 'billing_refunds: a new refund has not been announced yet';
  end if;

  select i.finalized_at
    into v_inv_final
    from public.billing_invoices i
   where i.id = new.invoice_id;
  if v_inv_final is null then
    raise exception 'billing_refunds: only an issued invoice can be refunded';
  end if;

  -- Lock the payment so two refunds of it are decided one after the other.
  select a.invoice_id, a.state, a.amount_paise, a.provider_payment_id
    into v_att_invoice, v_att_state, v_att_amount, v_att_payment
    from public.billing_payment_attempts a
   where a.id = new.attempt_id
   for update;
  if v_att_invoice is distinct from new.invoice_id then
    raise exception 'billing_refunds: that payment does not belong to that invoice';
  end if;
  if v_att_state is null or v_att_state not in ('captured', 'refunded') then
    raise exception 'billing_refunds: only a captured payment can be refunded';
  end if;
  if new.method = 'razorpay' and new.provider_payment_id is distinct from v_att_payment then
    raise exception 'billing_refunds: a Razorpay refund must name the payment it reverses';
  end if;

  select coalesce(sum(r.amount_paise), 0) into v_used
    from public.billing_refunds r
   where r.attempt_id = new.attempt_id
     and r.status not in ('failed', 'cancelled');
  if v_used + new.amount_paise > v_att_amount then
    raise exception 'billing_refunds: refunds of that payment would exceed it (% + % > %)',
      v_used, new.amount_paise, v_att_amount;
  end if;
  return new;
end;
$$;

DROP TRIGGER IF EXISTS billing_refunds_guard ON public.billing_refunds;
CREATE TRIGGER billing_refunds_guard
  BEFORE INSERT OR UPDATE ON public.billing_refunds
  FOR EACH ROW EXECUTE FUNCTION public.billing_refunds_guard();

CREATE OR REPLACE FUNCTION public.billing_refunds_keep()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  raise exception 'billing_refunds: % is a financial record and is never deleted', old.id;
end;
$$;

DROP TRIGGER IF EXISTS billing_refunds_keep ON public.billing_refunds;
CREATE TRIGGER billing_refunds_keep
  BEFORE DELETE ON public.billing_refunds
  FOR EACH ROW EXECUTE FUNCTION public.billing_refunds_keep();

-- ── 2. Credit notes ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.billing_credit_note_counters (
  fy_label text PRIMARY KEY,
  next_seq integer NOT NULL DEFAULT 1 CHECK (next_seq >= 1)
);

-- Single UPDATE ... RETURNING, the billing_next_invoice_no pattern. Called
-- only by the issuing trigger: nobody else may burn a number.
CREATE OR REPLACE FUNCTION public.billing_next_credit_note_no(p_fy text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare v integer;
begin
  insert into public.billing_credit_note_counters (fy_label) values (p_fy)
    on conflict (fy_label) do nothing;
  update public.billing_credit_note_counters
     set next_seq = next_seq + 1
   where fy_label = p_fy
  returning next_seq - 1 into v;
  return v;
end;
$$;

CREATE TABLE IF NOT EXISTS public.billing_credit_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES public.billing_invoices(id) ON DELETE RESTRICT,
  refund_id       uuid REFERENCES public.billing_refunds(id) ON DELETE RESTRICT,
  reason          text NOT NULL,
  -- Allocated by the issuing trigger; never carried in.
  credit_note_no  integer NOT NULL,
  credit_note_ref text NOT NULL,
  fy_label        text NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  taxable_paise   bigint NOT NULL,
  tax_paise       bigint NOT NULL,
  total_paise     bigint NOT NULL,
  -- Copied from the invoice by the issuing trigger; never carried in.
  tax_rate_bps    integer,
  supplier_gstin  text,
  customer_gstin  text,
  place_of_supply text,
  parties         jsonb NOT NULL,
  issued_by       text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- No 'duplicate_payment': returning an excess payment reduces no supply.
  CONSTRAINT billing_credit_notes_reason_check CHECK (reason IN (
    'cycle_not_reached', 'feature_removed', 'suspended_by_mistake',
    'declined_terms', 'goodwill', 'other', 'invoice_cancelled')),
  CONSTRAINT billing_credit_notes_amounts_check CHECK (
    taxable_paise >= 0 AND tax_paise >= 0 AND total_paise > 0
    AND total_paise = taxable_paise + tax_paise),
  CONSTRAINT billing_credit_notes_ref_key UNIQUE (credit_note_ref),
  CONSTRAINT billing_credit_notes_no_key UNIQUE (fy_label, credit_note_no),
  -- A GST credit note serial may have at most 16 characters.
  CONSTRAINT billing_credit_notes_ref_length CHECK (char_length(credit_note_ref) <= 16),
  CONSTRAINT billing_credit_notes_refund_key UNIQUE (refund_id),
  -- A note for a closed unpaid invoice reverses no payment; every other note
  -- documents one refund.
  CONSTRAINT billing_credit_notes_refund_shape CHECK (
    (reason = 'invoice_cancelled') = (refund_id IS NULL)),
  CONSTRAINT billing_credit_notes_issued_by_check CHECK (length(btrim(issued_by)) > 0)
);

-- Per invoice, and per store through the invoice (billing_invoices_store_idx).
CREATE INDEX IF NOT EXISTS billing_credit_notes_invoice_idx
  ON public.billing_credit_notes (invoice_id, issued_at DESC);

CREATE OR REPLACE FUNCTION public.billing_credit_notes_issue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_inv     public.billing_invoices%rowtype;
  v_refund  public.billing_refunds%rowtype;
  v_total   bigint;
  v_tax     bigint;
  v_fy      text;
  v_seq     integer;
begin
  -- Lock the invoice so two notes of it are decided one after the other.
  select * into v_inv from public.billing_invoices
   where id = new.invoice_id
   for update;
  if v_inv.id is null or v_inv.finalized_at is null then
    raise exception 'billing_credit_notes: a credit note needs an issued invoice';
  end if;

  if new.refund_id is not null then
    select * into v_refund from public.billing_refunds where id = new.refund_id;
    if v_refund.id is null
       or v_refund.invoice_id is distinct from new.invoice_id
       or v_refund.status not in ('processed', 'recorded')
       or v_refund.reason is distinct from new.reason
       or new.total_paise > v_refund.amount_paise then
      raise exception 'billing_credit_notes: the note must match a completed refund of that invoice';
    end if;
  elsif v_inv.status not in ('void', 'uncollectible') then
    raise exception 'billing_credit_notes: only a closed invoice is cancelled by a note without a refund';
  end if;

  select coalesce(sum(total_paise), 0), coalesce(sum(tax_paise), 0)
    into v_total, v_tax
    from public.billing_credit_notes where invoice_id = new.invoice_id;
  if v_total + new.total_paise > v_inv.total_paise
     or v_tax + new.tax_paise > v_inv.tax_paise then
    raise exception 'billing_credit_notes: the notes of % would exceed it', v_inv.invoice_ref;
  end if;

  -- What the document prints comes from the invoice, never from the caller.
  new.tax_rate_bps    := v_inv.tax_rate_bps;
  new.supplier_gstin  := v_inv.supplier_gstin;
  new.customer_gstin  := v_inv.customer_gstin;
  new.place_of_supply := v_inv.place_of_supply;
  -- Every issued invoice has its parties since 0243 (backfilled, then
  -- stamped at issue); the fallback only covers a row that somehow lacks it.
  new.parties := coalesce(v_inv.parties, public.billing_invoice_parties(
    v_inv.store_id, v_inv.supplier_gstin, v_inv.customer_gstin, v_inv.place_of_supply));
  new.issued_at := now();

  v_fy  := public.billing_fy_label(new.issued_at);
  v_seq := public.billing_next_credit_note_no(v_fy);
  new.credit_note_no  := v_seq;
  new.fy_label        := v_fy;
  new.credit_note_ref := 'CN/' || v_fy || '/' || public.sm_pad(v_seq, 5);
  return new;
end;
$$;

DROP TRIGGER IF EXISTS billing_credit_notes_issue ON public.billing_credit_notes;
CREATE TRIGGER billing_credit_notes_issue
  BEFORE INSERT ON public.billing_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.billing_credit_notes_issue();

CREATE OR REPLACE FUNCTION public.billing_credit_notes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  if tg_op = 'DELETE' then
    raise exception 'billing_credit_notes: % is issued and is never deleted', old.credit_note_ref;
  end if;
  raise exception 'billing_credit_notes: % is issued; issue another note instead', old.credit_note_ref;
end;
$$;

DROP TRIGGER IF EXISTS billing_credit_notes_guard ON public.billing_credit_notes;
CREATE TRIGGER billing_credit_notes_guard
  BEFORE UPDATE OR DELETE ON public.billing_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.billing_credit_notes_guard();

-- ── 3. The operator switch, the history line, and who asked to cancel ──────
-- Off until an operator turns it on (console, Billing & tax): until then an
-- owed refund waits for a person to press Send.
ALTER TABLE public.platform_billing_settings
  ADD COLUMN IF NOT EXISTS auto_refunds boolean NOT NULL DEFAULT false;
-- The moment automatic refunds were installed (this migration). A payment
-- recorded on a closed invoice before it was kept by older code: the refund
-- pass files it for a person instead of refunding history by itself (owner
-- decision D7). The singleton row exists since billing_01.
ALTER TABLE public.platform_billing_settings
  ADD COLUMN IF NOT EXISTS automatic_refunds_from timestamptz NOT NULL DEFAULT now();

-- Written by the new revision when a cancellation is asked for, cleared on
-- Keep my plan. No CHECK ties them to cancel_at_period_end: the replaced
-- revision cancels without writing them during the rollout.
ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS cancel_requested_by text;
ALTER TABLE public.billing_subscriptions
  DROP CONSTRAINT IF EXISTS billing_subscriptions_cancel_requested_by_check;
ALTER TABLE public.billing_subscriptions
  ADD CONSTRAINT billing_subscriptions_cancel_requested_by_check
  CHECK (cancel_requested_by IS NULL OR length(btrim(cancel_requested_by)) > 0);

-- ── 4. The cron's read of closed invoices ───────────────────────────────────
-- Every hour the refund pass looks for a captured payment on a void or
-- uncollectible subscription invoice; without this it reads every invoice.
CREATE INDEX IF NOT EXISTS billing_invoices_closed_idx
  ON public.billing_invoices (updated_at)
  WHERE kind = 'subscription' AND status IN ('void', 'uncollectible');

-- ── 5. A repair item is filed once, ever ───────────────────────────────────
-- The refund pass files money older code kept as a reconciliation item for a
-- person, with detail.repair_key naming the invoice or payment. Unlike
-- billing_reconciliation_open_key (open items with a payment id only), this
-- holds in every status, so an item an operator resolved is never re-filed.
-- No trigger on this table, so ON CONFLICT DO NOTHING is a quiet no-op.
CREATE UNIQUE INDEX IF NOT EXISTS billing_reconciliation_repair_once
  ON public.billing_reconciliation_items ((detail ->> 'repair_key'))
  WHERE detail ? 'repair_key';

-- ── 6. Access ───────────────────────────────────────────────────────────────
-- ★ The schema's default privileges give every new table SELECT, INSERT,
-- UPDATE and DELETE, and every new function EXECUTE, to BOTH app_user and
-- app_service (probed on storemink_local, \ddp). So each grant below starts
-- from REVOKE ALL for all three, then grants back only what the app needs.
ALTER TABLE public.billing_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_credit_note_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_refunds FROM PUBLIC, app_user, app_service;
REVOKE ALL ON public.billing_credit_notes FROM PUBLIC, app_user, app_service;
REVOKE ALL ON public.billing_credit_note_counters FROM PUBLIC, app_user, app_service;
-- Only the issuing trigger (SECURITY DEFINER, run as the owner) allocates a
-- number, so nobody can leave a gap in the series by calling this directly.
REVOKE ALL ON FUNCTION public.billing_next_credit_note_no(text) FROM PUBLIC, app_user, app_service;
-- A trigger function is never called directly, and PostgreSQL checks EXECUTE
-- only when the trigger is created, not when it fires (probed on
-- storemink_local), so the app roles keep nothing on these either.
REVOKE ALL ON FUNCTION public.billing_credit_notes_issue() FROM PUBLIC, app_user, app_service;
REVOKE ALL ON FUNCTION public.billing_credit_notes_guard() FROM PUBLIC, app_user, app_service;
REVOKE ALL ON FUNCTION public.billing_refunds_guard() FROM PUBLIC, app_user, app_service;
REVOKE ALL ON FUNCTION public.billing_refunds_keep() FROM PUBLIC, app_user, app_service;
-- No DELETE anywhere: these are financial records. No UPDATE on credit notes:
-- nothing about an issued note ever changes.
GRANT SELECT, INSERT, UPDATE ON public.billing_refunds TO app_service;
GRANT SELECT, INSERT ON public.billing_credit_notes TO app_service;
