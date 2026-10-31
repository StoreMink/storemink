import type { CreditNoteDocument } from "@/lib/billing/invoice-types";
import type { CreditNotePrintDocument } from "@/lib/billing/credit-notes";
import "../invoices/invoice-sheet.css";
import { placeOfSupplyLabel, stateCodeFromGstin } from "@/lib/billing/gst";
import {
  INVOICE_SHEET,
  invoiceGstinLine,
  invoiceStateLine,
  istShortDate,
  llpLine,
} from "@/lib/billing/tax-copy";

// ---------------------------------------------------------------------------
// A StoreMink credit note, printable (renewal-cancel, design 8.8).
//
// ★ IT MIRRORS THE INVOICE SHEET: the same `.invoice-sheet` print isolation
// (components/invoice/invoice.css) and the same `sminv-*` inner classes, so the
// two documents an accountant files side by side look like one set.
//
// ★★ EVERYTHING ON IT IS THE NOTE'S OWN RECORD. The amounts are the note's;
// the tax rate, both GSTINs, the place of supply and both parties were copied
// from the invoice by the issuing trigger when the note was issued, and the
// CGST/SGST or IGST lines arrive precomputed (`creditNoteTaxLines`, the
// invoice sheet's rule). This file only lays them out.
//
// ★ GST, A6: the place of supply prints with `placeOfSupplyLabel`, so a
// place of supply outside India reads "Outside India (96)", and the customer's
// "State:" line comes only from the recipient State the store derived from the
// invoice's basis (`recipientStateCode`), never from the place of supply
// itself: a supplier fallback or 96 names no State for the merchant.
//
// ★ The invoice sheet's gates (R2-09): the supplier's GSTIN and State print
// only on a note that credits tax, and the LLP line (owner decision 7) prints
// in the footer once an LLPIN was recorded with a legal name.
//
// ★ It links nowhere, so the operator console's credit-note page can render
// the same sheet for a note on any store (Stage 9b).
// ---------------------------------------------------------------------------

const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "1 Dec 2026", India time: every billing date's one style (R2-12). */
const fmtDate = (iso: string | null) => (iso ? istShortDate(iso) : "-");

/** Why the invoice was credited, by `billing_credit_notes.reason`. */
export const CREDIT_NOTE_REASON_TEXT: Record<string, string> = {
  cycle_not_reached: "The plan ended before the period this invoice covers.",
  feature_removed: "A main feature of the plan was removed or reduced.",
  suspended_by_mistake: "The store was suspended by mistake.",
  declined_terms: "The plan ended when the updated Terms were declined.",
  goodwill: "Goodwill refund.",
  other: "Adjustment.",
  invoice_cancelled:
    "The invoice was cancelled because the plan ended before the period it covers.",
};

/** The reason in words; an unknown code reads as an adjustment rather than
 *  printing our vocabulary on a tax document. */
export function creditNoteReasonText(reason: string): string {
  return CREDIT_NOTE_REASON_TEXT[reason] ?? CREDIT_NOTE_REASON_TEXT.other;
}

/**
 * How the money went back, by the refund's method (design 8.8, review
 * finding 16). Null for a note with no refund (`invoice_cancelled`), which
 * cancels an unpaid invoice and returned no money.
 */
export function creditNoteRefundLine(
  refund: CreditNoteDocument["refund"],
): string | null {
  if (!refund) return null;
  const on = refund.refundedAt ? ` on ${fmtDate(refund.refundedAt)}` : "";
  if (refund.method === "bank_transfer") {
    const reference = refund.reference ? `, reference ${refund.reference}` : "";
    return `Refunded by bank transfer${on}${reference}.`;
  }
  return `Refunded to the original payment method${on}.`;
}

function addressLines(a: {
  line1?: string;
  line2?: string;
  city?: string;
  postalCode?: string;
}): string[] {
  return [a.line1, a.line2, [a.city, a.postalCode].filter(Boolean).join(" ")]
    .map((l) => (l ?? "").trim())
    .filter(Boolean);
}

export function CreditNoteSheet({ doc }: { doc: CreditNotePrintDocument }) {
  const hasTax = doc.taxLines.length > 0;
  const supplierState = hasTax
    ? invoiceStateLine(stateCodeFromGstin(doc.supplierGstin))
    : null;
  const placeOfSupply = hasTax ? placeOfSupplyLabel(doc.placeOfSupply) : null;
  // `?? null`: a document built before the field existed reads as no State.
  const customerState = hasTax
    ? invoiceStateLine(doc.recipientStateCode ?? null)
    : null;
  const refundLine = creditNoteRefundLine(doc.refund);
  // `?? null`: a document built by hand before the fields existed prints no
  // LLP line.
  const llp = llpLine({
    legalName: doc.supplier.legalName,
    llpin: doc.supplier.llpin ?? null,
    registeredOffice: doc.supplier.registeredOffice ?? null,
  });

  return (
    <article className="invoice-sheet">
      <header className="sminv-head">
        <div>
          <h1 className="sminv-title">Credit Note</h1>
        </div>
        <div className="sminv-meta">
          <Row label="Credit note no." value={doc.creditNoteRef} />
          <Row label="Date" value={fmtDate(doc.issuedAt)} />
          <Row label="Against invoice" value={doc.invoiceRef ?? "-"} />
          <Row label="Invoice date" value={fmtDate(doc.invoiceIssuedAt)} />
        </div>
      </header>

      <table className="sminv-items">
        <thead>
          <tr>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{creditNoteReasonText(doc.reason)}</td>
          </tr>
        </tbody>
      </table>

      <section className="sminv-parties">
        <div>
          <h2>From</h2>
          <p className="sminv-name">{doc.supplier.legalName}</p>
          {addressLines(doc.supplier.address).map((l) => (
            <p key={l}>{l}</p>
          ))}
          {hasTax && doc.supplierGstin && (
            <p>{invoiceGstinLine(doc.supplierGstin)}</p>
          )}
          {supplierState && <p>{supplierState}</p>}
        </div>
        <div>
          <h2>To</h2>
          <p className="sminv-name">{doc.customer.legalName ?? "-"}</p>
          {addressLines(doc.customer.address).map((l) => (
            <p key={l}>{l}</p>
          ))}
          {doc.customer.billingEmail && <p>{doc.customer.billingEmail}</p>}
          {doc.customerGstin && <p>{invoiceGstinLine(doc.customerGstin)}</p>}
          {customerState && <p>{customerState}</p>}
          {/* The invoice's rule: the place of supply decides the tax split,
              so it is printed when the note credits tax. */}
          {placeOfSupply && (
            <p>{`${INVOICE_SHEET.placeOfSupply}: ${placeOfSupply}`}</p>
          )}
        </div>
      </section>

      <section className="sminv-totals">
        <Total label="Taxable value" value={inr(doc.taxablePaise)} />
        {doc.taxLines.map((line) => (
          <Total
            key={line.name}
            label={`${line.name} ${line.rateBps / 100}%`}
            value={inr(line.amountPaise)}
          />
        ))}
        <Total label="Total credited" value={inr(doc.totalPaise)} strong />
      </section>

      {refundLine && (
        <p style={{ margin: "20px 0 0", fontSize: 13, color: "#374151" }}>
          {refundLine}
        </p>
      )}

      <footer className="sminv-foot">
        <p>
          This is a computer-generated credit note and does not require a
          signature.
        </p>
        {llp && <p className="sminv-llp">{llp}</p>}
      </footer>
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="sminv-label">{label}</span>
      <span>{value}</span>
    </p>
  );
}

function Total({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <p className={strong ? "sminv-total-strong" : undefined}>
      <span>{label}</span>
      <span>{value}</span>
    </p>
  );
}
