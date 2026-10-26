-- Closes three gaps in the guards behind 0243 (keeping StoreMink's own
-- invoices when a store is deleted), found in its review, 26 Oct 2026.
--
-- ★★ AN ISSUED INVOICE CAN NO LONGER BE DELETED. Before 0243 the store
-- cascade deleted a deleted store's invoices, so nothing could refuse a
-- DELETE. Since 0243 an issued invoice outlives its store, and the only thing
-- keeping it was deleteStore's draft predicate (finalized_at IS NULL): a wrong
-- column there, or any other DELETE as app_service, removed a GST document
-- and its lines with it (the billing_invoice_items guard cannot refuse, because
-- it no longer sees a parent the same statement already deleted).
-- billing_invoices_keep_issued refuses deleting a row whose finalized_at is
-- set. A draft stays deletable: that is how deleteStore removes the drafts of
-- a store it deletes.
--
-- ★ THE PARTIES ARE RECORDED WHEN AN INVOICE IS ISSUED, NEVER CARRIED IN.
-- 0243's trigger kept a parties value already on the row, and the guard
-- ignores a draft, so a value written on a draft, or in the finalizing UPDATE
-- itself, became the permanent record. The trigger now overwrites it on the
-- transition to issued: an INSERT of an issued row, or the UPDATE that sets
-- finalized_at. An UPDATE of finalized_at on an invoice already issued
-- (finalizePaidAiCreditsInvoice re-finalizes through coalesce) is not a
-- transition and records nothing.
--
-- ★ THE GUARD ALSO FREEZES WHAT THE DOCUMENT PRINTS FROM THE ROW: the issue
-- date (finalized_at), the financial year (fy_label), both GSTINs and the
-- place of supply. The billing_03 guard never listed them, so they could
-- change after issue and disagree with the parties record. The app writes the
-- GSTINs and the place of supply only at insert, finalized_at only while it is
-- NULL (or through coalesce, which keeps it), and fy_label only in
-- billing_allocate_invoice_no while the invoice is still a draft.
--
-- Backward compatible: the replaced revision deletes no issued invoice, never
-- writes parties, and changes none of the newly frozen columns once an
-- invoice is issued.

-- ── 1. An issued invoice is never deleted ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.billing_invoices_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  if old.finalized_at is not null then
    raise exception
      'billing_invoices: % is finalized; an issued invoice is kept, never deleted',
      old.invoice_ref;
  end if;
  return old;
end;
$$;

DROP TRIGGER IF EXISTS billing_invoices_keep_issued ON public.billing_invoices;
CREATE TRIGGER billing_invoices_keep_issued
  BEFORE DELETE ON public.billing_invoices
  FOR EACH ROW EXECUTE FUNCTION public.billing_invoices_guard_delete();

-- ── 2. Record the parties on the transition to issued ───────────────────────
-- Same trigger (BEFORE INSERT OR UPDATE OF finalized_at), same owner rights.
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
      new.store_id, new.supplier_gstin, new.customer_gstin, new.place_of_supply);
  end if;
  return new;
end;
$$;

REVOKE ALL ON FUNCTION public.billing_invoices_snapshot_parties() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_invoices_snapshot_parties() FROM app_user;

-- ── 3. The guard: 0243's, plus the five columns the document prints ─────────
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
     or (old.parties is not null and new.parties is distinct from old.parties) then
    raise exception
      'billing_invoices: % is finalized; issue an adjustment instead of editing it',
      old.invoice_ref;
  end if;
  return new;
end;
$$;
