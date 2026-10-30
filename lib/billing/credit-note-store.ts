import "server-only";

/**
 * StoreMink's own credit notes: issuing one, and reading them back
 * (renewal-cancel, design 6.7, owner decisions D3 and D9).
 *
 * ★★ ONE WRITER. Every credit note StoreMink issues goes through
 * `issueCreditNote`: the refund pass (a note for each completed refund, and
 * one for each closed unpaid invoice that charged GST) and the operator's
 * console (a refund recorded or sent by hand). A note is a GST document in a
 * gapless series ("CN/2026-27/00001"), so the rules for when one exists are
 * written once:
 *   - every completed refund (`processed` or `recorded`) gets one, except a
 *     returned duplicate payment, which reduces no supply (D3);
 *   - a refund gets at most one (`billing_credit_notes_refund_key`);
 *   - a closed unpaid subscription invoice (`void` or `uncollectible`) that
 *     charged GST gets one cancelling it, once no payment on it is captured or
 *     still in flight (D3); a captured payment is refunded, and its refund's
 *     note covers the invoice instead;
 *   - the notes of an invoice never add up to more than the invoice, in total
 *     or in tax (`creditNoteSplit`; the issuing trigger refuses it too).
 *
 * ★★ THE INVOICE IS LOCKED FIRST, then what is already credited is read, then
 * the note is written, all in one transaction. Two issuers for one invoice (two
 * refunds of it settling in the same run, or the pass and an operator) take
 * turns on the invoice row, so the second reads the first's note and credits
 * what is left, rather than both computing against the same balance and the
 * second being refused by the trigger. The trigger takes the same lock again,
 * which is a no-op inside the transaction.
 *
 * ★ THE TRIGGER WRITES THE DOCUMENT; THIS ONLY DECIDES THE AMOUNTS. The insert
 * carries the invoice, the refund, the reason, the three amounts and who
 * issued it. The number, the reference, the financial year, the tax rate,
 * both GSTINs, the place of supply and both parties are filled by
 * `billing_credit_notes_issue` from the invoice row, never carried in.
 *
 * ★ READS ARE SCOPED BY STORE THROUGH THE INVOICE (a note has no store column
 * of its own): `getCreditNoteDocument` and `listCreditNotes` join
 * `billing_invoices` and require its `store_id`, the `getInvoiceDocument`
 * rule. So a note on an invoice kept after its store was deleted is reachable
 * only by an operator (`getCreditNoteDocumentForOperator`) and by the refund
 * email (`creditNoteParticulars`), whose recipient rule is receipts.ts's.
 *
 * Not a "use server" file: it takes ids as arguments, the shape that must
 * never be a public endpoint.
 */

import { sql, type SQL } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import type { RefundCreditNote } from "@/lib/email/billing-emails";
import {
  creditNoteRecipientState,
  creditNoteSplit,
  creditNoteTaxLines,
  type CreditNotePrintDocument,
} from "./credit-notes";
import { parseInvoiceParties } from "./invoice-history";
import type {
  CreditNoteSummary,
  RecordedInvoiceParties,
} from "./invoice-types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** A bigint comes back from a raw query as TEXT. */
function toPaise(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// ── Issuing ─────────────────────────────────────────────────────────────────

/**
 * What to issue a note for: a completed refund, or a closed unpaid invoice
 * that charged GST (`invoice_cancelled`).
 *
 * `issuedBy` is "system" for the refund pass and the operator's email for a
 * console action (`billing_credit_notes_issued_by_check`: never blank).
 */
export type IssueCreditNoteInput =
  | { kind: "refund"; refundId: string; issuedBy: string }
  | { kind: "invoice_cancelled"; invoiceId: string; issuedBy: string };

/** A note this call issued. */
export interface IssuedCreditNote {
  id: string;
  /** "CN/2026-27/00001", allocated by the issuing trigger. */
  creditNoteRef: string;
  invoiceId: string;
  refundId: string | null;
  reason: string;
  totalPaise: number;
  taxPaise: number;
  taxablePaise: number;
}

/**
 * What `issueCreditNote` did.
 *
 * - `issued`: a new note.
 * - `exists`: the refund (or, for a cancellation, the invoice) already has
 *   its note; nothing was written.
 * - `not_needed`: no note is due, and none ever will be for this input:
 *   `duplicate_payment` (D3), `nothing_left` (the invoice is fully credited
 *   already, design edge case 4), `no_tax` (a closed unpaid invoice that
 *   charged no GST), `payment_captured` (the invoice has a captured payment,
 *   whose refund's note covers it), `not_issued` (a draft, voided before it
 *   was ever issued), `not_subscription` (an add-on or Mink credits invoice,
 *   which the plan end never closes).
 * - `not_ready`: not yet: `refund_not_finished` (owed, pending, failed or
 *   cancelled), `payment_in_flight` (a payment may still land on the closed
 *   invoice), `invoice_not_closed` (an issued subscription invoice that is not
 *   `void` or `uncollectible`).
 * - `not_found`: no such refund or invoice (or the id is malformed).
 */
export type IssueCreditNoteResult =
  | { outcome: "issued"; note: IssuedCreditNote }
  | { outcome: "exists"; note: { id: string; creditNoteRef: string } }
  | {
      outcome: "not_needed";
      why:
        | "duplicate_payment"
        | "nothing_left"
        | "no_tax"
        | "payment_captured"
        | "not_issued"
        | "not_subscription";
    }
  | {
      outcome: "not_ready";
      why: "refund_not_finished" | "payment_in_flight" | "invoice_not_closed";
    }
  | { outcome: "not_found" };

/** A refund is final, and so due its note, once it reached the merchant. */
const FINISHED_REFUND = new Set(["processed", "recorded"]);
/** A subscription invoice closed by the plan end or the downgrade. */
const CLOSED_INVOICE = new Set(["void", "uncollectible"]);

interface ExistingNote {
  id: string;
  creditNoteRef: string;
  refundId: string | null;
  reason: string;
  totalPaise: number;
  taxPaise: number;
}

/** The notes already issued against an invoice (under its lock). */
async function notesOnInvoice(
  db: Db,
  invoiceId: string,
): Promise<ExistingNote[]> {
  const res = await db.execute(sql`
    select n.id, n.credit_note_ref, n.refund_id, n.reason, n.total_paise, n.tax_paise
      from public.billing_credit_notes n
     where n.invoice_id = ${invoiceId}`);
  return (res.rows ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      creditNoteRef: String(r.credit_note_ref),
      refundId: textOrNull(r.refund_id),
      reason: String(r.reason),
      totalPaise: toPaise(r.total_paise),
      taxPaise: toPaise(r.tax_paise),
    };
  });
}

function credited(notes: ExistingNote[]): { total: number; tax: number } {
  return notes.reduce(
    (sum, n) => ({
      total: sum.total + n.totalPaise,
      tax: sum.tax + n.taxPaise,
    }),
    { total: 0, tax: 0 },
  );
}

/** Write the note; the issuing trigger fills in the rest. */
async function insertNote(
  db: Db,
  input: {
    invoiceId: string;
    refundId: string | null;
    reason: string;
    taxablePaise: number;
    taxPaise: number;
    totalPaise: number;
    issuedBy: string;
  },
): Promise<{ id: string; creditNoteRef: string }> {
  const res = await db.execute(sql`
    insert into public.billing_credit_notes
      (invoice_id, refund_id, reason, taxable_paise, tax_paise, total_paise, issued_by)
    values (${input.invoiceId}, ${input.refundId}, ${input.reason}, ${input.taxablePaise}, ${input.taxPaise}, ${input.totalPaise}, ${input.issuedBy})
    returning id, credit_note_ref`);
  const row = res.rows?.[0] as
    | { id?: unknown; credit_note_ref?: unknown }
    | undefined;
  if (!row?.id || !row.credit_note_ref) {
    // An insert that returns nothing has not issued a note; saying it did
    // would let the caller tell a merchant about a document that is not there.
    throw new Error("billing_credit_notes insert returned no row");
  }
  return { id: String(row.id), creditNoteRef: String(row.credit_note_ref) };
}

async function issueForRefund(
  db: Db,
  refundId: string,
  issuedBy: string,
): Promise<IssueCreditNoteResult> {
  const res = await db.execute(sql`
    select r.id, r.status, r.reason, r.amount_paise, r.invoice_id,
           i.finalized_at, i.total_paise, i.tax_paise
      from public.billing_refunds r
      join public.billing_invoices i on i.id = r.invoice_id
     where r.id = ${refundId}
       for update of i`);
  const row = res.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return { outcome: "not_found" };
  if (!FINISHED_REFUND.has(String(row.status))) {
    return { outcome: "not_ready", why: "refund_not_finished" };
  }
  const reason = String(row.reason);
  // ★ D3: returning an extra payment reduces no supply, so it has no note
  // (billing_credit_notes_reason_check has no 'duplicate_payment' either).
  if (reason === "duplicate_payment") {
    return { outcome: "not_needed", why: "duplicate_payment" };
  }
  // The refund guard admits only an issued invoice; a draft here is a row
  // somebody wrote by hand, and the trigger would refuse it.
  if (!row.finalized_at) return { outcome: "not_found" };

  const invoiceId = String(row.invoice_id);
  const notes = await notesOnInvoice(db, invoiceId);
  const own = notes.find((n) => n.refundId === refundId);
  if (own) {
    return {
      outcome: "exists",
      note: { id: own.id, creditNoteRef: own.creditNoteRef },
    };
  }

  const already = credited(notes);
  const split = creditNoteSplit({
    invoiceTotalPaise: toPaise(row.total_paise),
    invoiceTaxPaise: toPaise(row.tax_paise),
    creditedTotalPaise: already.total,
    creditedTaxPaise: already.tax,
    amountPaise: toPaise(row.amount_paise),
  });
  // ★ Edge case 4: a second payment refunded on an invoice already credited
  // in full gets its money back and no second note.
  if (!split) return { outcome: "not_needed", why: "nothing_left" };

  const written = await insertNote(db, {
    invoiceId,
    refundId,
    reason,
    taxablePaise: split.taxablePaise,
    taxPaise: split.taxPaise,
    totalPaise: split.totalPaise,
    issuedBy,
  });
  return {
    outcome: "issued",
    note: { ...written, invoiceId, refundId, reason, ...split },
  };
}

async function issueForCancelledInvoice(
  db: Db,
  invoiceId: string,
  issuedBy: string,
): Promise<IssueCreditNoteResult> {
  const res = await db.execute(sql`
    select i.id, i.kind, i.status, i.finalized_at, i.total_paise, i.tax_paise,
           exists (select 1 from public.billing_payment_attempts a
                    where a.invoice_id = i.id
                      and a.state in ('captured', 'refunded')) as captured,
           exists (select 1 from public.billing_payment_attempts a
                    where a.invoice_id = i.id
                      and a.state in ('created', 'processing', 'authorized', 'unknown')) as in_flight
      from public.billing_invoices i
     where i.id = ${invoiceId}
       for update of i`);
  const row = res.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return { outcome: "not_found" };
  // ★ A draft was never issued, so it declared no GST and has no number to
  // reverse (the issuing trigger refuses it too). Closing cycles voids drafts
  // as well, so this is ordinary, and final: a void draft never becomes due.
  if (!row.finalized_at) return { outcome: "not_needed", why: "not_issued" };
  // Only a subscription invoice is closed unpaid by the plan end (design 6.6).
  if (row.kind !== "subscription") {
    return { outcome: "not_needed", why: "not_subscription" };
  }
  if (!CLOSED_INVOICE.has(String(row.status))) {
    return { outcome: "not_ready", why: "invoice_not_closed" };
  }

  const notes = await notesOnInvoice(db, invoiceId);
  const own = notes.find((n) => n.reason === "invoice_cancelled");
  if (own) {
    return {
      outcome: "exists",
      note: { id: own.id, creditNoteRef: own.creditNoteRef },
    };
  }
  // ★ Money on it is refunded, and the refund's note credits the invoice: a
  // cancellation note as well would credit the same invoice twice.
  if (row.captured === true) {
    return { outcome: "not_needed", why: "payment_captured" };
  }
  // ★ A payment that may still land decides which note is right: wait until
  // it resolves (design 6.6 step 5).
  if (row.in_flight === true) {
    return { outcome: "not_ready", why: "payment_in_flight" };
  }
  // ★ D3: only an invoice that charged GST needs cancelling by a note.
  const totalPaise = toPaise(row.total_paise);
  const taxPaise = toPaise(row.tax_paise);
  if (taxPaise <= 0) return { outcome: "not_needed", why: "no_tax" };

  const already = credited(notes);
  const split = creditNoteSplit({
    invoiceTotalPaise: totalPaise,
    invoiceTaxPaise: taxPaise,
    creditedTotalPaise: already.total,
    creditedTaxPaise: already.tax,
    amountPaise: totalPaise,
  });
  if (!split) return { outcome: "not_needed", why: "nothing_left" };

  const written = await insertNote(db, {
    invoiceId,
    refundId: null,
    reason: "invoice_cancelled",
    taxablePaise: split.taxablePaise,
    taxPaise: split.taxPaise,
    totalPaise: split.totalPaise,
    issuedBy,
  });
  return {
    outcome: "issued",
    note: {
      ...written,
      invoiceId,
      refundId: null,
      reason: "invoice_cancelled",
      ...split,
    },
  };
}

/**
 * Issue the credit note a completed refund, or a closed unpaid invoice that
 * charged GST, is due. See the module comment for the rules.
 *
 * ★ THROWS ON A DATABASE ERROR, in both modes: the refund pass counts it in
 * its errors and tries the row again next run, and a console action reports
 * it. With `db` the whole call runs in the caller's transaction, which a
 * failed statement has aborted, so the caller must unwind (store-credit.ts's
 * rule); without it, the call opens a transaction of its own. A business
 * outcome (`exists`, `not_needed`, `not_ready`, `not_found`) never throws.
 */
export async function issueCreditNote(
  input: IssueCreditNoteInput,
  db?: Db,
): Promise<IssueCreditNoteResult> {
  const issuedBy = typeof input.issuedBy === "string" ? input.issuedBy : "";
  if (!issuedBy.trim()) {
    // A programming error, not an outcome: every note names who issued it.
    throw new Error("issueCreditNote needs issuedBy");
  }
  const id = input.kind === "refund" ? input.refundId : input.invoiceId;
  if (!isUuid(id)) return { outcome: "not_found" };

  const run = (handle: Db) =>
    input.kind === "refund"
      ? issueForRefund(handle, id, issuedBy)
      : issueForCancelledInvoice(handle, id, issuedBy);
  const result = db ? await run(db) : await withService(run);

  if (result.outcome === "issued") {
    logInfo("billing.credit_note_issued", {
      creditNoteId: result.note.id,
      creditNoteRef: result.note.creditNoteRef,
      invoiceId: result.note.invoiceId,
      refundId: result.note.refundId,
      reason: result.note.reason,
      totalPaise: result.note.totalPaise,
      taxPaise: result.note.taxPaise,
    });
  }
  return result;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** One note row joined to its invoice and its refund. */
interface NoteRow {
  id: string;
  creditNoteRef: string;
  issuedAt: string;
  reason: string;
  invoiceId: string;
  refundId: string | null;
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
  taxRateBps: number | null;
  supplierGstin: string | null;
  customerGstin: string | null;
  placeOfSupply: string | null;
  /** The invoice's `place_of_supply_basis` (GST, A6); the note has none of
   *  its own. */
  placeOfSupplyBasis: string | null;
  invoiceRef: string | null;
  invoiceIssuedAt: string | null;
  storeId: string | null;
  refundMethod: string | null;
  refundedAt: string | null;
  externalReference: string | null;
  providerRefundId: string | null;
  parties: RecordedInvoiceParties | null;
}

/**
 * Read one note with its invoice and refund, and its parties.
 *
 * ★ THE PARTIES ARE THE NOTE'S OWN RECORD, copied from the invoice by the
 * issuing trigger. Only a missing or unreadable record (one edited by hand)
 * falls back to today's settings, through the same SQL function the invoice
 * trigger and the invoice document use, with the note's own identifiers and,
 * as the customer's State, the recipient State its invoice's basis gives
 * (`creditNoteRecipientState`), never a supplier fallback or 96 (GST, A6).
 */
async function readNote(db: Db, where: SQL): Promise<NoteRow | null> {
  const res = await db.execute(sql`
    select n.id, n.credit_note_ref, n.issued_at, n.reason, n.invoice_id, n.refund_id,
           n.taxable_paise, n.tax_paise, n.total_paise, n.tax_rate_bps,
           n.supplier_gstin, n.customer_gstin, n.place_of_supply, n.parties,
           i.invoice_ref, i.finalized_at as invoice_issued_at, i.store_id,
           i.place_of_supply_basis,
           r.method as refund_method, r.resolved_at as refunded_at,
           r.external_reference, r.provider_refund_id
      from public.billing_credit_notes n
      join public.billing_invoices i on i.id = n.invoice_id
      left join public.billing_refunds r on r.id = n.refund_id
     where ${where}
     limit 1`);
  const r = res.rows?.[0] as Record<string, unknown> | undefined;
  if (!r) return null;

  const note: NoteRow = {
    id: String(r.id),
    creditNoteRef: String(r.credit_note_ref),
    issuedAt: String(r.issued_at),
    reason: String(r.reason),
    invoiceId: String(r.invoice_id),
    refundId: textOrNull(r.refund_id),
    taxablePaise: toPaise(r.taxable_paise),
    taxPaise: toPaise(r.tax_paise),
    totalPaise: toPaise(r.total_paise),
    taxRateBps: r.tax_rate_bps == null ? null : toPaise(r.tax_rate_bps),
    supplierGstin: textOrNull(r.supplier_gstin),
    customerGstin: textOrNull(r.customer_gstin),
    placeOfSupply: textOrNull(r.place_of_supply),
    placeOfSupplyBasis: textOrNull(r.place_of_supply_basis),
    invoiceRef: textOrNull(r.invoice_ref),
    invoiceIssuedAt: textOrNull(r.invoice_issued_at),
    storeId: textOrNull(r.store_id),
    refundMethod: textOrNull(r.refund_method),
    refundedAt: textOrNull(r.refunded_at),
    externalReference: textOrNull(r.external_reference),
    providerRefundId: textOrNull(r.provider_refund_id),
    parties: parseInvoiceParties(r.parties),
  };

  if (!note.parties) {
    logWarn("billing.credit_note_parties_unreadable", {
      creditNoteId: note.id,
    });
    const stateCode = creditNoteRecipientState({
      placeOfSupply: note.placeOfSupply,
      placeOfSupplyBasis: note.placeOfSupplyBasis,
      recordedStateCode: null,
    });
    const fallback = await db.execute(
      sql`select public.billing_invoice_parties(${note.storeId}::uuid, ${note.supplierGstin}::text, ${note.customerGstin}::text, ${stateCode}::text) as parties`,
    );
    note.parties = parseInvoiceParties(
      (fallback.rows?.[0] as { parties?: unknown } | undefined)?.parties,
    );
  }
  return note;
}

function toDocument(note: NoteRow): CreditNotePrintDocument {
  const parties = note.parties;
  return {
    id: note.id,
    creditNoteRef: note.creditNoteRef,
    issuedAt: note.issuedAt,
    reason: note.reason,
    invoiceId: note.invoiceId,
    invoiceRef: note.invoiceRef,
    invoiceIssuedAt: note.invoiceIssuedAt,
    taxablePaise: note.taxablePaise,
    taxPaise: note.taxPaise,
    totalPaise: note.totalPaise,
    taxRateBps: note.taxRateBps,
    supplierGstin: note.supplierGstin,
    customerGstin: note.customerGstin,
    placeOfSupply: note.placeOfSupply,
    placeOfSupplyBasis: note.placeOfSupplyBasis,
    recipientStateCode: creditNoteRecipientState({
      placeOfSupply: note.placeOfSupply,
      placeOfSupplyBasis: note.placeOfSupplyBasis,
      recordedStateCode: parties?.customer.stateCode ?? null,
    }),
    taxLines: creditNoteTaxLines({
      taxPaise: note.taxPaise,
      taxRateBps: note.taxRateBps,
      supplierGstin: note.supplierGstin,
      placeOfSupply: note.placeOfSupply,
    }),
    supplier: {
      legalName: parties?.supplier.name ?? "StoreMink",
      address: parties?.supplier.address ?? {},
      // ★ The invoice's rule (R2-08): no LLP line without a recorded legal
      // name, since the line names the LLP.
      llpin: parties?.supplier.name ? (parties.supplier.llpin ?? null) : null,
      registeredOffice: parties?.supplier.registeredOffice ?? null,
    },
    customer: {
      legalName: parties?.customer.name ?? null,
      address: parties?.customer.address ?? {},
      billingEmail: parties?.customer.email ?? null,
    },
    refund:
      note.refundId && note.refundMethod
        ? note.refundMethod === "bank_transfer"
          ? {
              method: "bank_transfer",
              refundedAt: note.refundedAt,
              reference: note.externalReference,
            }
          : {
              method: "razorpay",
              refundedAt: note.refundedAt,
              reference: note.providerRefundId ?? note.externalReference,
            }
        : null,
  };
}

/**
 * The store's credit notes, newest first (the invoices page, design 8.5).
 *
 * ★ Scoped by store THROUGH THE INVOICE. Returns [] on a read failure, the
 * `listInvoices` rule: the page shows no credit notes, which is wrong but
 * harmless, where throwing would take down a page that also lists invoices.
 */
export async function listCreditNotes(
  storeId: string,
  limit = 50,
): Promise<CreditNoteSummary[]> {
  if (!isUuid(storeId)) return [];
  const take = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  try {
    return await withService(async (db) => {
      const res = await db.execute(sql`
        select n.id, n.credit_note_ref, n.issued_at, n.reason, n.total_paise,
               n.invoice_id, n.refund_id, i.invoice_ref
          from public.billing_credit_notes n
          join public.billing_invoices i on i.id = n.invoice_id
         where i.store_id = ${storeId}
         order by n.issued_at desc, n.fy_label desc, n.credit_note_no desc
         limit ${take}`);
      return (res.rows ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: String(r.id),
          creditNoteRef: String(r.credit_note_ref),
          issuedAt: String(r.issued_at),
          reason: String(r.reason),
          totalPaise: toPaise(r.total_paise),
          invoiceId: String(r.invoice_id),
          invoiceRef: textOrNull(r.invoice_ref),
          refundId: textOrNull(r.refund_id),
        };
      });
    });
  } catch (err) {
    logError("billing.list_credit_notes", err, { storeId });
    return [];
  }
}

/**
 * One credit note for its store's merchant (design 8.8).
 *
 * ★ Scoped by store THROUGH THE INVOICE, so a merchant cannot open another
 * store's note by guessing its id. Null for an unknown id, another store's
 * note or a read failure; the page shows a plain 404 for all three.
 */
export async function getCreditNoteDocument(
  storeId: string,
  creditNoteId: string,
): Promise<CreditNotePrintDocument | null> {
  if (!isUuid(storeId) || !isUuid(creditNoteId)) return null;
  try {
    return await withService(async (db) => {
      const note = await readNote(
        db,
        sql`n.id = ${creditNoteId} and i.store_id = ${storeId}`,
      );
      return note ? toDocument(note) : null;
    });
  } catch (err) {
    logError("billing.get_credit_note_document", err, {
      storeId,
      creditNoteId,
    });
    return null;
  }
}

/**
 * One credit note for a platform operator (the console's Refunds page prints
 * the same sheet the merchant sees, design 7.2).
 *
 * ★ NO STORE PREDICATE: the caller's gate (`requireOperator`) is the access
 * control, and a note on an invoice kept after its store was deleted is still
 * readable here. Never call it from a merchant surface.
 */
export async function getCreditNoteDocumentForOperator(
  creditNoteId: string,
): Promise<CreditNotePrintDocument | null> {
  if (!isUuid(creditNoteId)) return null;
  try {
    return await withService(async (db) => {
      const note = await readNote(db, sql`n.id = ${creditNoteId}`);
      return note ? toDocument(note) : null;
    });
  } catch (err) {
    logError("billing.get_credit_note_document_operator", err, {
      creditNoteId,
    });
    return null;
  }
}

/**
 * A credit note's particulars, as the refund email prints them for a store
 * whose dashboard is closed (suspended or deleted), so the merchant still holds
 * the document (design 6.11). Exactly `RefundCreditNote`, the shape
 * `notifyRefundSent` and `notifyRefundRecorded` take as `creditNote`.
 *
 * By the note's id, or by the refund it documents (a refund has at most one).
 * Not store-scoped: the caller is the refund pass or an operator, and the
 * email's recipient is decided by receipts.ts.
 *
 * Null when there is no such note (a duplicate payment, or nothing was left
 * to credit). ★ Throws on a database error, `issueCreditNote`'s rule, so a
 * caller never mails a closed store "keep this email as your credit note"
 * without the note in it.
 */
export async function creditNoteParticulars(
  ref: { creditNoteId: string } | { refundId: string },
  db?: Db,
): Promise<RefundCreditNote | null> {
  const byRefund = "refundId" in ref;
  const id = byRefund ? ref.refundId : ref.creditNoteId;
  if (!isUuid(id)) return null;
  const where = byRefund ? sql`n.refund_id = ${id}` : sql`n.id = ${id}`;

  const run = (handle: Db) => readNote(handle, where);
  const note = db ? await run(db) : await withService(run);
  if (!note) return null;

  const doc = toDocument(note);
  const parties = note.parties;
  return {
    ref: doc.creditNoteRef,
    issuedAt: doc.issuedAt,
    invoiceRef: doc.invoiceRef,
    invoiceIssuedAt: doc.invoiceIssuedAt,
    supplier: {
      name: doc.supplier.legalName,
      address: doc.supplier.address,
      gstin: doc.supplierGstin ?? parties?.supplier.gstin ?? null,
      llpin: doc.supplier.llpin,
      registeredOffice: doc.supplier.registeredOffice,
    },
    recipient: {
      name: doc.customer.legalName,
      address: doc.customer.address,
      gstin: doc.customerGstin ?? parties?.customer.gstin ?? null,
      // The customer's State, printed with its code when the note credits
      // tax and the recipient has no GSTIN: the recipient State its invoice's
      // basis gives, never the supplier's State on a supplier fallback and
      // never 96 (GST, A6).
      stateCode: doc.recipientStateCode,
    },
    // The invoice's place of supply, printed as its own row when the note
    // credits tax (CGST rule 53(1A)): never the customer's State above.
    placeOfSupply: doc.placeOfSupply,
    taxablePaise: doc.taxablePaise,
    taxLines: doc.taxLines,
    totalPaise: doc.totalPaise,
  };
}
