/**
 * StoreMink's own credit notes: the arithmetic (renewal-cancel, design 6.7).
 *
 * Pure: no server import, no database, so the refund pass, the operator
 * console, the credit note sheet and the refund email all compute a note the
 * same way, and the tests reach every case without a mock.
 *
 * ★★ THE NOTES OF ONE INVOICE ADD UP TO THE INVOICE, NEVER MORE. A refund
 * credits at most what is left of the invoice (the total less the notes
 * already issued against it), and the database refuses anything past that in
 * total or in tax (billing_credit_notes_issue, migration 0264). A partial
 * note takes its tax in proportion, rounded down, and the LAST note (the one
 * that brings the credited total to the invoice total) takes whatever tax is
 * left, so the notes of a fully reversed invoice reverse exactly the tax it
 * charged. Proportion on the last note would leave a paisa or two of GST
 * declared and never reversed.
 *
 * Integer paise throughout (the cycle.ts rule), and every product of two
 * amounts goes through BigInt, so a large invoice cannot lose a paisa to a
 * float.
 */

import { platformInvoiceGst, recipientStateFor } from "./gst";
import type { CreditNoteDocument, CreditNoteTaxLine } from "./invoice-types";

export type { CreditNoteTaxLine };

/**
 * A credit note as the sheet prints it: the stored document plus where its
 * invoice's place of supply came from, the customer's State that follows from
 * it (GST, A6), and the LLP's particulars the note's parties recorded.
 *
 * ★ Still a separate type: folding these fields into `CreditNoteDocument`
 * (invoice-types.ts) would make them required on the literal fixtures two
 * credit-note page tests build, which belong to other owners. Every field is
 * always present on what `credit-note-store.ts` returns; the sheet still reads
 * them defensively for a document built by hand.
 */
export interface CreditNotePrintDocument extends CreditNoteDocument {
  /** `billing_invoices.place_of_supply_basis` of the invoice the note
   *  reduces: "recipient", "supplier", "outside_india", or null for an
   *  invoice issued before the basis was recorded. */
  placeOfSupplyBasis: string | null;
  /** The customer's State to print ("State: Delhi (07)"), or null. Never the
   *  supplier's State and never 96 (`creditNoteRecipientState`). */
  recipientStateCode: string | null;
  supplier: CreditNoteDocument["supplier"] & {
    /** The LLPIN the note's parties recorded (copied from the invoice's,
     *  migration 0266), or null; null too when no legal name was recorded,
     *  since the LLP line names the LLP (owner decision 7). */
    llpin: string | null;
    /** The registered office the note's parties recorded, or null. */
    registeredOffice: string | null;
  };
}

/**
 * The customer's State a credit note prints, by its invoice's basis.
 *
 * ★ THE INVOICE SHEET'S RULE: the place of supply is the merchant's State only
 * when it came from the merchant's own records (basis `recipient`, or none on
 * an invoice issued before the basis existed); `recipientStateFor` decides
 * that. A supplier fallback or a place of supply outside India names no State
 * for the merchant, so neither falls back to anything. Only a recipient (or
 * unrecorded) basis with no usable place of supply falls back to the State the
 * note's parties recorded, with 96 and junk dropped the same way.
 */
export function creditNoteRecipientState(input: {
  placeOfSupply: string | null;
  placeOfSupplyBasis: string | null;
  recordedStateCode: string | null;
}): string | null {
  const basis = input.placeOfSupplyBasis ?? null;
  if (basis !== null && basis !== "recipient") return null;
  return (
    recipientStateFor({
      placeOfSupply: input.placeOfSupply,
      placeOfSupplyBasis: basis,
    }) ??
    recipientStateFor({
      placeOfSupply: input.recordedStateCode,
      placeOfSupplyBasis: null,
    })
  );
}

/** A whole, non-negative number of paise; anything else counts as nothing. */
function paise(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** floor(a * b / c) for non-negative integers, exactly. */
function mulDivFloor(a: number, b: number, c: number): number {
  if (c <= 0) return 0;
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

/** What one credit note credits, in paise: `total = taxable + tax`. */
export interface CreditNoteSplit {
  totalPaise: number;
  taxPaise: number;
  taxablePaise: number;
}

/**
 * How much of an invoice a refund credits, and its tax, never exceeding what
 * is left.
 *
 * `total = min(amount, invoiceTotal - creditedTotal)`; null when that is 0
 * (nothing left to credit, or nothing refunded). When the note brings the
 * credited total to the invoice total it is the last one and its tax is the
 * remainder, `invoiceTax - creditedTax`; otherwise its tax is
 * `floor(total * invoiceTax / invoiceTotal)`. `taxable = total - tax`.
 *
 * ★ EITHER WAY THE TAX IS HELD WITHIN WHAT IS LEFT, and within the note's own
 * total. The remainder can exceed a tiny last note only after several partial
 * notes each rounded down (two partials and a one-paisa last note on an
 * invoice taxed at a high share); the database would refuse a negative
 * taxable value, so the note's tax is capped at its total there, and the
 * notes then fall short of the invoice's tax by that rounding.
 */
export function creditNoteSplit(input: {
  invoiceTotalPaise: number;
  invoiceTaxPaise: number;
  /** The notes already issued against the invoice. */
  creditedTotalPaise: number;
  creditedTaxPaise: number;
  /** The refund, or the invoice total for a note cancelling it. */
  amountPaise: number;
}): CreditNoteSplit | null {
  const invoiceTotal = paise(input.invoiceTotalPaise);
  const invoiceTax = Math.min(paise(input.invoiceTaxPaise), invoiceTotal);
  const creditedTotal = paise(input.creditedTotalPaise);
  const creditedTax = paise(input.creditedTaxPaise);

  const leftTotal = Math.max(0, invoiceTotal - creditedTotal);
  const leftTax = Math.max(0, invoiceTax - creditedTax);
  const total = Math.min(paise(input.amountPaise), leftTotal);
  if (total <= 0) return null;

  const last = creditedTotal + total === invoiceTotal;
  const tax = last
    ? Math.min(leftTax, total)
    : Math.min(mulDivFloor(total, invoiceTax, invoiceTotal), leftTax, total);
  return { totalPaise: total, taxPaise: tax, taxablePaise: total - tax };
}

/**
 * The tax lines a credit note prints, split the way its invoice was.
 *
 * ★ THE INVOICE SHEET'S RULE, so a note and the invoice it reduces never
 * disagree: tax is printed only when the note carries tax and a supplier
 * GSTIN; the split itself is `platformInvoiceGst`'s, the one function the
 * invoice sheet, the emails and the invoice register call (GST, A6):
 * intra-state (CGST and SGST, half the rate each) when the GSTIN's state is
 * the place of supply, IGST otherwise, and always IGST for a place of supply
 * outside India (96, which no GSTIN starts with, so no note issued before
 * changes). The
 * amounts come from the note's tax AMOUNT, so the halves add up to what the
 * note credits; the identifiers are the ones the issuing trigger copied from
 * the invoice. Empty when the note credits no tax.
 */
export function creditNoteTaxLines(input: {
  taxPaise: number;
  taxRateBps: number | null;
  supplierGstin: string | null;
  placeOfSupply: string | null;
}): CreditNoteTaxLine[] {
  const tax = paise(input.taxPaise);
  if (tax <= 0 || !input.supplierGstin) return [];
  const rateBps = paise(input.taxRateBps ?? 0);
  const split = platformInvoiceGst({
    taxPaise: tax,
    taxRateBps: rateBps,
    supplierGstin: input.supplierGstin,
    placeOfSupply: input.placeOfSupply,
  });
  if (!split.intraState) {
    return [{ name: "IGST", rateBps, amountPaise: split.igstPaise }];
  }
  return [
    { name: "CGST", rateBps: rateBps / 2, amountPaise: split.cgstPaise },
    { name: "SGST", rateBps: rateBps / 2, amountPaise: split.sgstPaise },
  ];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The part of a paid period after a moment, in paise and in days. */
export interface UnusedPartOfCycle {
  paise: number;
  /** Days from `from` to the end, a part day counted as a day. */
  daysLeft: number;
  /** The period's length in days. */
  daysTotal: number;
}

/**
 * The part of a paid period after `from`, in paise.
 *
 * `from` is clamped to `[periodStart, periodEnd]`; `paise =
 * floor(paidPaise * (end - from) / (end - start))`, held within
 * `[0, paidPaise]`; `daysLeft = ceil((end - from) / 1 day)`, `daysTotal =
 * round((end - start) / 1 day)`.
 *
 * ★ ROUNDED DOWN, NEVER ABOVE WHAT WAS PAID: a refund of the unused part can
 * only ever be less than the payment it comes from, by a paisa at most. A
 * period that is empty, reversed or unreadable has no unused part.
 *
 * `from` is the moment the operator acts, except for a removed feature, where
 * it is the date of the change (Terms 13: "the part of your current cycle
 * after the change"). For an addon invoice, which has no period of its own,
 * the caller passes its issue time to the subscription's current period end.
 */
export function unusedPartOfCycle(input: {
  paidPaise: number;
  periodStart: Date;
  periodEnd: Date;
  from: Date;
}): UnusedPartOfCycle {
  const start = input.periodStart.getTime();
  const end = input.periodEnd.getTime();
  const at = input.from.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { paise: 0, daysLeft: 0, daysTotal: 0 };
  }
  const span = end - start;
  const daysTotal = Math.round(span / DAY_MS);
  if (!Number.isFinite(at)) return { paise: 0, daysLeft: 0, daysTotal };

  const from = Math.min(Math.max(at, start), end);
  const remaining = end - from;
  const paid = paise(input.paidPaise);
  const part = Math.min(Math.max(mulDivFloor(paid, remaining, span), 0), paid);
  return {
    paise: part,
    daysLeft: Math.ceil(remaining / DAY_MS),
    daysTotal,
  };
}
