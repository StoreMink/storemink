-- drizzle/migrations/sql/20261029_0266_gst_on_storemink_fees.sql (requires
-- 20261028_0265_cancel_and_refund_help; the refunds and credit notes schema
-- of 0264 is in place).
--
-- GST on StoreMink's own fees, correct end to end (pinned by
-- lib/billing/gst-migration.test.ts). Owner-actions part (c) item 4; Terms
-- section 4.
--
-- ★★ A CHANGE OF GST CAN BE SCHEDULED. tax_enabled, tax_inclusive and
-- tax_rate_bps stay the values IN FORCE, exactly as the revision this
-- migration replaces reads them. next_tax_enabled, next_tax_inclusive,
-- next_tax_rate_bps and next_tax_starts_at hold ONE scheduled change, all set
-- or all NULL: an invoice built at or after next_tax_starts_at uses them. The
-- hourly billing run copies a change that has started into the in-force
-- columns. next_tax_notice_id names the operational announcement that gave
-- merchants notice when the change raises what they pay. The operator
-- schedules a change only after this release serves all traffic (design
-- section 9).
--
-- ★★ A TAX INVOICE CARRIES WHAT CGST RULES RULE 46 ASKS FOR. The SAC code is
-- a platform setting (sac_code) stamped on each invoice with the rate, the
-- GSTINs and the place of supply (billing_invoices.sac_code), and an invoice
-- charging GST cannot be ISSUED without the supplier GSTIN, the place of
-- supply and what it was decided from, the SAC code and a rate
-- (billing_invoices_tax_invoice_complete, a trigger on the issuing
-- transition, never on later status changes, so an older invoice can still be
-- paid, voided or refunded).
--
-- ★★ THE ISSUING CHECK STARTS WITH STOREMINK'S OWN SAC CODE. The trigger
-- judges an invoice only once platform_billing_settings.sac_code is set. On
-- an environment where GST was already switched on before this release (no
-- SAC code exists yet), the revision being replaced keeps issuing exactly as
-- it did during the rollout instead of being refused, and the first identity
-- save after it (which the CHECKs below force to include the SAC code) turns
-- the check on for good. Where GST is off, nothing is taxed until the
-- identity is complete, so the exemption never applies.
--
-- ★★ THE PLACE OF SUPPLY SAYS WHERE IT CAME FROM. place_of_supply_basis is
-- 'recipient' (the merchant's GSTIN or a state of theirs on record),
-- 'supplier' (IGST Act s.12(2)(b)(ii): no state of the merchant anywhere, so
-- StoreMink's own) or 'outside_india' (place of supply 96, a business
-- outside India). Only 'recipient' is recorded as the merchant's State in the
-- parties snapshot, so an invoice never says a merchant is in Punjab because
-- StoreMink is.
--
-- ★ THE LLP'S PARTICULARS GO ON EVERY INVOICE (LLP Act section 21): llpin and
-- registered_office are platform settings, recorded in the supplier half of
-- billing_invoices.parties when an invoice is issued (the 0243 snapshot), and
-- required, with the address and PIN, before GST can be on or scheduled.
--
-- ★ billing_invoices.tax_inclusive records whether the line amounts include
-- GST, so the printed document can say "Amount (GST included)" without
-- guessing. Invoices already written with an "(included)" GST line are marked
-- before the guard freezes the column. Frozen with the money once issued.
--
-- ★ ai_credit_purchases.amount_paise is what the merchant is charged for a
-- Mink credit pack, GST included when prices exclude GST. amount_inr stays
-- the listed pack price. The confirm path verifies the payment against
-- amount_paise, falling back to amount_inr * 100 for older rows.
--
-- ★ A merchant's GSTIN on their billing account must be well formed and agree
-- with the state saved beside it (place of supply for a registered
-- recipient is the state of registration, IGST Act section 12(2)(a)).
--
-- ★ The invoice prefix is at most 2 letters or digits: SM/2026-27/00001 is 16
-- characters, the most rule 46(b) allows.
--
-- ★ CONSTRAINTS ON EXISTING TABLES ARE ADDED NOT VALID AND THEN VALIDATED
-- WHEN THE DATA ALLOWS. An environment whose existing row would fail (GST
-- already switched on without a SAC code, a longer invoice prefix) keeps
-- working: the constraint still applies to every later write, so the next
-- console save must fix it, and the NOTICE names what to fix.
--
-- Backward compatible: every new column is nullable or has a default, the
-- replaced revision reads none of them, and the issuing trigger cannot refuse
-- it (with GST off it writes no taxed invoice; with GST already on, the
-- trigger waits for a SAC code that only the new console writes). Rolling
-- back to the replaced revision AFTER the identity is entered and GST is on
-- is not supported: switch GST off first (design section 9).

-- ── 1. platform_billing_settings: start time, SAC code, LLP particulars ────
ALTER TABLE public.platform_billing_settings
  ADD COLUMN IF NOT EXISTS next_tax_enabled boolean,
  ADD COLUMN IF NOT EXISTS next_tax_inclusive boolean,
  ADD COLUMN IF NOT EXISTS next_tax_rate_bps integer,
  ADD COLUMN IF NOT EXISTS next_tax_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_tax_notice_id uuid,
  ADD COLUMN IF NOT EXISTS sac_code text,
  ADD COLUMN IF NOT EXISTS llpin text,
  ADD COLUMN IF NOT EXISTS registered_office text;

COMMENT ON COLUMN public.platform_billing_settings.next_tax_starts_at IS
  'When the scheduled change (next_tax_enabled, next_tax_inclusive, next_tax_rate_bps) applies: to every invoice built at or after it.';
COMMENT ON COLUMN public.platform_billing_settings.next_tax_notice_id IS
  'The operational announcement that gave merchants notice of a scheduled change that raises what they pay.';
COMMENT ON COLUMN public.platform_billing_settings.sac_code IS
  'Services Accounting Code printed on every tax invoice (6 digits, chosen with the accountant). The issuing check on billing_invoices starts once it is set.';

ALTER TABLE public.platform_billing_settings
  DROP CONSTRAINT IF EXISTS platform_billing_settings_next_tax_notice_fkey;
ALTER TABLE public.platform_billing_settings
  ADD CONSTRAINT platform_billing_settings_next_tax_notice_fkey
  FOREIGN KEY (next_tax_notice_id)
  REFERENCES public.platform_announcements(id) ON DELETE SET NULL;

-- Every arm is a boolean that is never NULL (IS NULL, IS NOT NULL, a regex or
-- comparison on a value already known not to be NULL, or on a coalesce), so
-- no CHECK passes by being NULL.
ALTER TABLE public.platform_billing_settings
  DROP CONSTRAINT IF EXISTS platform_billing_sac_code_format,
  DROP CONSTRAINT IF EXISTS platform_billing_llpin_format,
  DROP CONSTRAINT IF EXISTS platform_billing_invoice_prefix_length,
  DROP CONSTRAINT IF EXISTS platform_billing_next_tax_shape,
  DROP CONSTRAINT IF EXISTS platform_billing_tax_needs_invoice_identity,
  DROP CONSTRAINT IF EXISTS platform_billing_next_tax_needs_invoice_identity;

ALTER TABLE public.platform_billing_settings
  ADD CONSTRAINT platform_billing_sac_code_format
  CHECK (sac_code IS NULL OR sac_code ~ '^99[0-9]{4}$') NOT VALID,
  ADD CONSTRAINT platform_billing_llpin_format
  CHECK (llpin IS NULL OR llpin ~ '^[A-Z]{3}-[0-9]{4}$') NOT VALID,
  ADD CONSTRAINT platform_billing_invoice_prefix_length
  CHECK (invoice_prefix ~ '^[A-Z0-9]{1,2}$') NOT VALID,
  ADD CONSTRAINT platform_billing_next_tax_shape
  CHECK (
    (next_tax_starts_at IS NULL AND next_tax_enabled IS NULL
     AND next_tax_inclusive IS NULL AND next_tax_rate_bps IS NULL)
    OR (next_tax_starts_at IS NOT NULL AND next_tax_enabled IS NOT NULL
        AND next_tax_inclusive IS NOT NULL AND next_tax_rate_bps IS NOT NULL
        AND next_tax_rate_bps >= 0 AND next_tax_rate_bps <= 10000)
  ) NOT VALID,
  -- What a tax invoice needs (rule 46(a), (g)) and what every invoice of an
  -- LLP needs (LLP Act s.21), before GST is on.
  ADD CONSTRAINT platform_billing_tax_needs_invoice_identity
  CHECK (
    tax_enabled = false
    OR (
      sac_code IS NOT NULL
      AND state_code IS NOT NULL
      AND legal_name IS NOT NULL
      AND btrim(legal_name) <> ''
      AND llpin IS NOT NULL
      AND registered_office IS NOT NULL
      AND btrim(registered_office) <> ''
      AND coalesce(btrim(address ->> 'line1'), '') <> ''
      AND coalesce(btrim(address ->> 'postalCode'), '') ~ '^[1-9][0-9]{5}$'
    )
  ) NOT VALID,
  -- The same, plus the GSTIN, before GST can even be scheduled on.
  ADD CONSTRAINT platform_billing_next_tax_needs_invoice_identity
  CHECK (
    next_tax_enabled IS NULL
    OR next_tax_enabled = false
    OR (
      gstin IS NOT NULL
      AND gstin <> ''
      AND sac_code IS NOT NULL
      AND state_code IS NOT NULL
      AND legal_name IS NOT NULL
      AND btrim(legal_name) <> ''
      AND llpin IS NOT NULL
      AND registered_office IS NOT NULL
      AND btrim(registered_office) <> ''
      AND coalesce(btrim(address ->> 'line1'), '') <> ''
      AND coalesce(btrim(address ->> 'postalCode'), '') ~ '^[1-9][0-9]{5}$'
    )
  ) NOT VALID;

-- ── 2. billing_accounts: the merchant's GSTIN and state agree ──────────────
ALTER TABLE public.billing_accounts
  DROP CONSTRAINT IF EXISTS billing_accounts_gstin_format,
  DROP CONSTRAINT IF EXISTS billing_accounts_gstin_matches_state;
ALTER TABLE public.billing_accounts
  ADD CONSTRAINT billing_accounts_gstin_format
  CHECK (
    gstin IS NULL
    OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
  ) NOT VALID,
  ADD CONSTRAINT billing_accounts_gstin_matches_state
  CHECK (
    gstin IS NULL
    OR (state_code IS NOT NULL AND left(gstin, 2) = state_code)
  ) NOT VALID;

-- ── 3. ai_credit_purchases: the exact amount charged ───────────────────────
ALTER TABLE public.ai_credit_purchases
  ADD COLUMN IF NOT EXISTS amount_paise bigint;
COMMENT ON COLUMN public.ai_credit_purchases.amount_paise IS
  'What the merchant is charged, GST included when prices exclude GST. NULL on purchases made before it existed: amount_inr * 100.';
ALTER TABLE public.ai_credit_purchases
  DROP CONSTRAINT IF EXISTS ai_credit_purchases_amount_paise_check;
ALTER TABLE public.ai_credit_purchases
  ADD CONSTRAINT ai_credit_purchases_amount_paise_check
  CHECK (amount_paise IS NULL OR amount_paise > 0);

-- ── 4. billing_invoices: SAC code, price basis, place of supply ────────────
ALTER TABLE public.billing_invoices
  ADD COLUMN IF NOT EXISTS sac_code text,
  ADD COLUMN IF NOT EXISTS tax_inclusive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS place_of_supply_basis text;
COMMENT ON COLUMN public.billing_invoices.tax_inclusive IS
  'True when the line amounts include GST (prices set as including GST when the invoice was built).';
COMMENT ON COLUMN public.billing_invoices.place_of_supply_basis IS
  'Where place_of_supply came from: recipient (the merchant''s GSTIN or a state of theirs on record), supplier (no state of the merchant anywhere: StoreMink''s own, IGST Act s.12(2)(b)(ii)) or outside_india (place of supply 96). NULL on invoices written before it existed.';

ALTER TABLE public.billing_invoices
  DROP CONSTRAINT IF EXISTS billing_invoices_sac_code_format,
  DROP CONSTRAINT IF EXISTS billing_invoices_place_of_supply_numeric,
  DROP CONSTRAINT IF EXISTS billing_invoices_place_of_supply_basis;
ALTER TABLE public.billing_invoices
  ADD CONSTRAINT billing_invoices_sac_code_format
  CHECK (sac_code IS NULL OR sac_code ~ '^99[0-9]{4}$') NOT VALID,
  ADD CONSTRAINT billing_invoices_place_of_supply_numeric
  CHECK (place_of_supply IS NULL OR place_of_supply ~ '^[0-9]{2}$') NOT VALID,
  -- A CASE whose every branch is a non-NULL boolean (and ELSE false), so the
  -- CHECK can never pass by evaluating to NULL. 96 is the GST code for a
  -- place of supply outside India, and only an outside_india invoice uses it.
  ADD CONSTRAINT billing_invoices_place_of_supply_basis
  CHECK (
    CASE
      WHEN place_of_supply_basis IS NULL
        THEN place_of_supply IS NULL OR place_of_supply <> '96'
      WHEN place_of_supply_basis = 'outside_india'
        THEN place_of_supply IS NOT NULL AND place_of_supply = '96'
      WHEN place_of_supply_basis IN ('recipient', 'supplier')
        THEN place_of_supply IS NOT NULL AND place_of_supply <> '96'
      ELSE false
    END
  ) NOT VALID;

-- ── 4b. Mark invoices already written with prices that included GST ──────
-- Before the guard of step 7 freezes tax_inclusive. The builder labels an
-- included GST line "GST @ 18% (included)" (lib/billing/invoice.ts), and that
-- line is the only record of the price basis an older invoice has. The 0245
-- guard does not know this column, so it lets the issued ones change here.
UPDATE public.billing_invoices i
   SET tax_inclusive = true
 WHERE i.tax_paise > 0
   AND i.tax_inclusive = false
   AND EXISTS (
     SELECT 1
       FROM public.billing_invoice_items it
      WHERE it.invoice_id = i.id
        AND it.kind = 'tax'
        AND it.description LIKE '%(included)'
   );

-- ── 5. Validate every new constraint the existing data already meets ──────
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('public.platform_billing_settings', 'platform_billing_sac_code_format'),
      ('public.platform_billing_settings', 'platform_billing_llpin_format'),
      ('public.platform_billing_settings', 'platform_billing_invoice_prefix_length'),
      ('public.platform_billing_settings', 'platform_billing_next_tax_shape'),
      ('public.platform_billing_settings', 'platform_billing_tax_needs_invoice_identity'),
      ('public.platform_billing_settings', 'platform_billing_next_tax_needs_invoice_identity'),
      ('public.billing_accounts', 'billing_accounts_gstin_format'),
      ('public.billing_accounts', 'billing_accounts_gstin_matches_state'),
      ('public.billing_invoices', 'billing_invoices_sac_code_format'),
      ('public.billing_invoices', 'billing_invoices_place_of_supply_numeric'),
      ('public.billing_invoices', 'billing_invoices_place_of_supply_basis')
    ) AS v(tbl, con)
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.tbl, c.con);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'GST migration: % on % is left NOT VALID because an existing row breaks it; it still applies to every later write, so fix that row from the console', c.con, c.tbl;
    END;
  END LOOP;
END $$;

-- ── 6. An invoice charging GST is issued only as a complete tax invoice ────
-- BEFORE INSERT OR UPDATE OF finalized_at, the shape of the two triggers that
-- allocate the number and record the parties. Only the transition to issued
-- is checked, so an invoice issued earlier is never refused a status change.
-- It runs as its owner because it reads StoreMink's settings row (the 0243
-- snapshot trigger's reason), and it judges nothing until a SAC code is set
-- there (see the header).
CREATE OR REPLACE FUNCTION public.billing_invoices_guard_tax_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if new.finalized_at is not null
     and (tg_op = 'INSERT' or old.finalized_at is null)
     and new.tax_paise > 0
     and exists (select 1
                   from public.platform_billing_settings p
                  where p.id and p.sac_code is not null)
     and (new.supplier_gstin is null
          or new.place_of_supply is null
          or new.place_of_supply_basis is null
          or new.sac_code is null
          or new.tax_rate_bps is null
          or new.tax_rate_bps <= 0) then
    raise exception
      'billing_invoices: an invoice charging GST is issued only with the supplier GSTIN, the place of supply and its basis, the SAC code and the rate';
  end if;
  return new;
end;
$$;

-- A trigger function fires whatever the caller's grant (PostgreSQL checks
-- EXECUTE only when the trigger is created, 0264), so no app role keeps it.
REVOKE ALL ON FUNCTION public.billing_invoices_guard_tax_invoice() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_invoices_guard_tax_invoice() FROM app_user;
REVOKE ALL ON FUNCTION public.billing_invoices_guard_tax_invoice() FROM app_service;

DROP TRIGGER IF EXISTS billing_invoices_tax_invoice_complete
  ON public.billing_invoices;
CREATE TRIGGER billing_invoices_tax_invoice_complete
  BEFORE INSERT OR UPDATE OF finalized_at ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_invoices_guard_tax_invoice();

-- ── 7. The guard: 0245's, plus the SAC code, the price basis and the basis
--       of the place of supply ─────────────────────────────────────────────
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

  if new.subtotal_paise  is distinct from old.subtotal_paise
     or new.discount_paise  is distinct from old.discount_paise
     or new.tax_paise       is distinct from old.tax_paise
     or new.total_paise     is distinct from old.total_paise
     or new.currency        is distinct from old.currency
     or new.kind            is distinct from old.kind
     or (new.store_id is distinct from old.store_id
         and (new.store_id is not null
              or exists (select 1 from public.stores where id = old.store_id)))
     or new.cycle_seq       is distinct from old.cycle_seq
     or new.invoice_ref     is distinct from old.invoice_ref
     or new.invoice_no      is distinct from old.invoice_no
     or new.tax_rate_bps    is distinct from old.tax_rate_bps
     or new.finalized_at    is distinct from old.finalized_at
     or new.fy_label        is distinct from old.fy_label
     or new.supplier_gstin  is distinct from old.supplier_gstin
     or new.customer_gstin  is distinct from old.customer_gstin
     or new.place_of_supply is distinct from old.place_of_supply
     or new.sac_code        is distinct from old.sac_code
     or new.tax_inclusive   is distinct from old.tax_inclusive
     or new.place_of_supply_basis is distinct from old.place_of_supply_basis
     or (old.parties is not null and new.parties is distinct from old.parties) then
    raise exception
      'billing_invoices: % is finalized; issue an adjustment instead of editing it',
      old.invoice_ref;
  end if;
  return new;
end;
$$;

-- ── 8. The parties record: the LLP's particulars, the merchant's country,
--       and the signup address ─────────────────────────────────────────────
-- 0243's function, plus: the supplier's LLPIN and registered office; the
-- customer's country when it is not India (the billing account's, else the
-- country given at signup), for the export particulars of rule 46; and a
-- third source for the customer's address, the business address older
-- stores gave at signup (stores.settings.business), used only when neither
-- the billing account nor Taxes & invoices holds one. Same signature, so the
-- issuing trigger and the document's fallback both pick it up. The fourth
-- argument is the merchant's own State: the snapshot trigger below passes
-- the place of supply only when it was decided from the merchant's records.
-- 0264's billing_credit_notes_issue() calls billing_invoice_parties with the
-- same four arguments only when an invoice has no recorded parties, which no
-- issued invoice lacks since 0243.
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
      'llpin', nullif(btrim(p.llpin), ''),
      'registeredOffice', nullif(btrim(p.registered_office), ''),
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
      'country', ctry.country,
      'email', coalesce(
        nullif(btrim(a.billing_email), ''),
        nullif(btrim(b.contact_email), '')
      ),
      'address', CASE
        WHEN addr.account <> '{}'::jsonb THEN addr.account
        WHEN cardinality(biz.lines) > 0 THEN jsonb_strip_nulls(jsonb_build_object(
          'line1', biz.lines[1],
          'line2', nullif(array_to_string(biz.lines[2:], ', '), '')
        ))
        ELSE addr.signup
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
      )) AS account,
      jsonb_strip_nulls(jsonb_build_object(
        'line1', nullif(btrim(s.settings -> 'business' ->> 'addressLine1'), ''),
        'line2', nullif(btrim(s.settings -> 'business' ->> 'addressLine2'), ''),
        'city', nullif(btrim(s.settings -> 'business' ->> 'city'), ''),
        'postalCode', nullif(btrim(s.settings -> 'business' ->> 'postalCode'), '')
      )) AS signup
  ) AS addr
  CROSS JOIN LATERAL (
    SELECT coalesce(array_remove(
      regexp_split_to_array(btrim(b.business_address), '\s*[\r\n]+\s*'),
      ''
    ), '{}'::text[]) AS lines
  ) AS biz
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN nullif(btrim(a.address ->> 'country'), '') IS NOT NULL THEN
        CASE WHEN upper(btrim(a.address ->> 'country')) = 'IN' THEN NULL
             ELSE jsonb_strip_nulls(jsonb_build_object(
                    'code', upper(btrim(a.address ->> 'country')),
                    'name', nullif(btrim(a.address ->> 'countryName'), '')))
        END
      WHEN nullif(btrim(s.settings -> 'business' ->> 'country'), '') IS NOT NULL
           AND upper(btrim(s.settings -> 'business' ->> 'country')) <> 'IN' THEN
        jsonb_build_object(
          'code', upper(btrim(s.settings -> 'business' ->> 'country')))
      ELSE NULL
    END AS country
  ) AS ctry
$$;

REVOKE ALL ON FUNCTION public.billing_invoice_parties(uuid, text, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_invoice_parties(uuid, text, text, text)
  FROM app_user;
GRANT EXECUTE ON FUNCTION public.billing_invoice_parties(uuid, text, text, text)
  TO app_service;

-- 0245's snapshot trigger function, with one change: the merchant's State
-- passed to the parties record is the place of supply only when that was
-- decided from the merchant's own records (basis 'recipient', or an invoice
-- written before the basis existed, which is what 0245 recorded). A supplier
-- fallback or a place of supply outside India records no State.
CREATE OR REPLACE FUNCTION public.billing_invoices_snapshot_parties()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  if new.finalized_at is not null
     and (tg_op = 'INSERT' or old.finalized_at is null) then
    new.parties := public.billing_invoice_parties(
      new.store_id, new.supplier_gstin, new.customer_gstin,
      case
        when new.place_of_supply_basis is null
             or new.place_of_supply_basis = 'recipient'
          then new.place_of_supply
      end);
  end if;
  return new;
end;
$$;

REVOKE ALL ON FUNCTION public.billing_invoices_snapshot_parties() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_invoices_snapshot_parties() FROM app_user;
