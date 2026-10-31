import Link from "next/link";
import type {
  InvoiceDocument,
  InvoiceLineView,
} from "@/lib/billing/invoice-types";
import "./invoice-sheet.css";
import { placeOfSupplyLabel, platformInvoiceGst } from "@/lib/billing/gst";
import {
  INVOICE_SHEET,
  gstSplitLabels,
  invoiceCountryLine,
  invoiceGstinLine,
  invoiceStateLine,
  istShortDate,
  llpLine,
} from "@/lib/billing/tax-copy";

// ---------------------------------------------------------------------------
// A StoreMink subscription invoice, printable (GST design 7.6).
//
// ★ PRINTABLE HTML, not a server-rendered PDF: the decision §17 made for a
// merchant's own order invoices, for the same reasons (no binary toolchain, no
// font packaging, and "Print, Save as PDF" produces a file every accountant
// accepts). `invoice.css` already isolates a sheet from all dashboard chrome.
//
// ★★ EVERY TAX FIGURE AND IDENTIFIER COMES FROM THE INVOICE ROW, never from
// live settings, and every name and address from the parties recorded when it
// was issued. An operator turning GST on in September must not make April's
// invoice claim it charged tax. `getInvoiceDocument` does that reading; this
// only lays it out.
//
// ★ WHAT DECIDES EACH BLOCK. The row's GST and its supplier GSTIN together
// decide the kind: both present is a "Tax Invoice" (title, "Original for
// recipient", place of supply, reverse charge "No", the supplier's GSTIN and
// State, the SAC column, the taxable value and the CGST and SGST or IGST
// lines from `platformInvoiceGst`); anything else is an "Invoice" with no GST
// block at all, because a "GST ₹0" line on a document naming no GSTIN reads
// as a claim. The merchant's State prints only when the place of supply came
// from their own records (`customer.stateCode`), never for a supplier
// fallback or a supply outside India (96); their country prints whenever one
// was recorded. The items table holds the body lines only: the `tax` and
// `discount` lines are printed once, in the totals. The LLP line prints on
// both kinds once an LLPIN was recorded, and carries the name, LLPIN and
// registered office only.
//
// ★ REFUNDS AND CREDIT NOTES ARE PRINTED WITH IT (renewal-cancel, design 8.7).
// A refund never changes the invoice's status (rule R9), so an accountant
// reading a "Paid" invoice must see on the same page that it was credited:
// each credit note issued against it, a refund still on its way, and an extra
// payment returned. Shown only when there is one.
// ---------------------------------------------------------------------------

/** Where a credit note opens on the merchant dashboard. */
export const MERCHANT_CREDIT_NOTE_PATH = "/dashboard/plans/credit-notes";

// The block mirrors the parties block's heading and line styles
// (invoice-sheet.css `.sminv-parties h2` and `p`); inline so it needs no
// stylesheet of its own and prints with the rest of the sheet.
const BLOCK_STYLE = {
  marginTop: 24,
  paddingTop: 16,
  borderTop: "1px solid #e5e7eb",
} as const;
const BLOCK_HEADING_STYLE = {
  margin: "0 0 6px",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#6b7280",
} as const;
const BLOCK_LINE_STYLE = {
  margin: "0 0 3px",
  fontSize: 12,
  color: "#374151",
} as const;

const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "1 Dec 2026", India time: every billing date's one style (R2-12). */
const fmtDate = (iso: string | null) => (iso ? istShortDate(iso) : "-");

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

/** The `tax` and `discount` lines: printed once, in the totals. */
const TOTALS_LINE_KINDS = new Set(["tax", "discount"]);

/**
 * The lines the items table prints: the body lines only (design 7.6), so the
 * GST and the discount never appear twice on one document.
 */
export function invoiceBodyLines(
  items: readonly InvoiceLineView[],
): InvoiceLineView[] {
  return items.filter((it) => !TOTALS_LINE_KINDS.has(it.kind));
}

export function InvoiceSheet({
  doc,
  creditNotePath = MERCHANT_CREDIT_NOTE_PATH,
}: {
  doc: InvoiceDocument;
  /** Where each credit note links; null prints the lines as plain text (a
   *  screen with no credit-note page of its own). */
  creditNotePath?: string | null;
}) {
  const hasTax = doc.taxPaise > 0 && !!doc.supplierGstin;
  const sheet = INVOICE_SHEET;
  const bodyLines = invoiceBodyLines(doc.items);
  const placeOfSupply = hasTax ? placeOfSupplyLabel(doc.placeOfSupply) : null;
  const supplierState = hasTax
    ? invoiceStateLine(doc.supplier.stateCode)
    : null;
  const customerState = hasTax
    ? invoiceStateLine(doc.customer.stateCode)
    : null;
  const llp = llpLine({
    legalName: doc.supplier.legalName,
    llpin: doc.supplier.llpin,
    registeredOffice: doc.supplier.registeredOffice,
  });

  return (
    <article className="invoice-sheet">
      <header className="sminv-head">
        <div>
          <h1 className="sminv-title">
            {hasTax ? sheet.taxTitle : sheet.plainTitle}
          </h1>
          {hasTax && <p className="sminv-copy">{sheet.original}</p>}
          <p className="sminv-ref">{doc.invoiceRef ?? doc.id.slice(0, 8)}</p>
        </div>
        <div className="sminv-meta">
          <Row label="Issued" value={fmtDate(doc.issuedAt)} />
          {doc.paidAt && <Row label="Paid" value={fmtDate(doc.paidAt)} />}
          {doc.periodStart && doc.periodEnd && (
            <Row
              label="Service period"
              value={`${fmtDate(doc.periodStart)} to ${fmtDate(doc.periodEnd)}`}
            />
          )}
          <Row label="Status" value={statusLabel(doc.status)} />
          {placeOfSupply && (
            <Row label={sheet.placeOfSupply} value={placeOfSupply} />
          )}
          {hasTax && (
            <Row label={sheet.reverseCharge} value={sheet.reverseChargeValue} />
          )}
        </div>
      </header>

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
          <h2>Billed to</h2>
          <p className="sminv-name">{doc.customer.legalName ?? "-"}</p>
          {addressLines(doc.customer.address).map((l) => (
            <p key={l}>{l}</p>
          ))}
          {doc.customer.billingEmail && <p>{doc.customer.billingEmail}</p>}
          {doc.customerGstin && <p>{invoiceGstinLine(doc.customerGstin)}</p>}
          {customerState && <p>{customerState}</p>}
          {doc.customer.country && (
            <p>{invoiceCountryLine(doc.customer.country)}</p>
          )}
        </div>
      </section>

      {/* Scrolls in its own box on a phone (invoice-sheet.css, R2-07). */}
      <div className="sminv-items-scroll">
        <table className="sminv-items">
          <thead>
            <tr>
              <th>{sheet.columns.description}</th>
              {hasTax && <th className="sac">{sheet.columns.sac}</th>}
              <th className="num">{sheet.columns.qty}</th>
              <th className="num">{sheet.columns.rate}</th>
              <th className="num">
                {hasTax && doc.taxInclusive
                  ? sheet.columns.amountInclusive
                  : sheet.columns.amount}
              </th>
            </tr>
          </thead>
          <tbody>
            {bodyLines.map((it, i) => (
              <tr key={i}>
                <td>{it.description}</td>
                {hasTax && <td className="sac">{doc.sacCode ?? "-"}</td>}
                <td className="num">{it.quantity}</td>
                <td className="num">{inr(it.unitAmountPaise)}</td>
                <td className="num">{inr(it.amountPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="sminv-totals">
        {hasTax ? <TaxTotals doc={doc} /> : <PlainTotals doc={doc} />}
        <Total label={sheet.totals.total} value={inr(doc.totalPaise)} strong />
      </section>

      <RefundsAndCredits doc={doc} creditNotePath={creditNotePath} />

      <footer className="sminv-foot">
        {hasTax ? (
          <p>{sheet.taxFooter}</p>
        ) : (
          // ★ Says WHY there is no GST rather than leaving a gap that looks like
          // an omission — the merchant's accountant will ask.
          <p>{sheet.plainFooter}</p>
        )}
        {llp && <p className="sminv-llp">{llp}</p>}
      </footer>
    </article>
  );
}

/** A discount, negative: a bare figure reads as another charge and the ladder
 *  visibly stops adding up (the §24 rule for order emails). */
function DiscountRow({ paise }: { paise: number }) {
  return (
    <Total label={INVOICE_SHEET.totals.discount} value={`−${inr(paise)}`} />
  );
}

/**
 * A tax invoice's ladder: the taxable value (the subtotal less any discount,
 * shown as Subtotal, Discount and Taxable value when there is a discount),
 * then the GST lines, split from the tax AMOUNT by `platformInvoiceGst` so the
 * halves always re-sum to what was charged. Taxable value plus GST is the
 * total in both price modes, because the row satisfies
 * `total = subtotal - discount + tax`.
 */
function TaxTotals({ doc }: { doc: InvoiceDocument }) {
  const totals = INVOICE_SHEET.totals;
  const gst = platformInvoiceGst(doc);
  const labels = gstSplitLabels(doc.taxRateBps ?? 0);
  const taxable = doc.subtotalPaise - doc.discountPaise;
  return (
    <>
      {doc.discountPaise > 0 && (
        <>
          <Total label={totals.subtotal} value={inr(doc.subtotalPaise)} />
          <DiscountRow paise={doc.discountPaise} />
        </>
      )}
      <Total label={totals.taxableValue} value={inr(taxable)} />
      {gst.igstPaise > 0 ? (
        <Total label={labels.igst} value={inr(gst.igstPaise)} />
      ) : (
        <>
          <Total label={labels.cgst} value={inr(gst.cgstPaise)} />
          <Total label={labels.sgst} value={inr(gst.sgstPaise)} />
        </>
      )}
    </>
  );
}

/**
 * An invoice with no GST: Subtotal, Discount when any. A row carrying a tax
 * amount but naming no supplier GSTIN (data that should not exist) prints its
 * stored tax line here, so the ladder still adds up to the total without
 * claiming a GST registration the document cannot name.
 */
function PlainTotals({ doc }: { doc: InvoiceDocument }) {
  const taxLine = doc.items.find((it) => it.kind === "tax");
  return (
    <>
      <Total
        label={INVOICE_SHEET.totals.subtotal}
        value={inr(doc.subtotalPaise)}
      />
      {doc.discountPaise > 0 && <DiscountRow paise={doc.discountPaise} />}
      {doc.taxPaise > 0 && (
        <Total
          label={taxLine?.description ?? "Tax"}
          value={inr(doc.taxPaise)}
        />
      )}
    </>
  );
}

/** The lines of the "Refunds and credit notes" block, in print order. */
export function refundsAndCreditsLines(
  doc: Pick<InvoiceDocument, "credits" | "refunds">,
): { key: string; text: string; creditNoteId: string | null }[] {
  const lines: { key: string; text: string; creditNoteId: string | null }[] =
    doc.credits.map((credit) => ({
      key: credit.id,
      text: `Credit note ${credit.creditNoteRef}, ${fmtDate(credit.issuedAt)}: ${inr(credit.totalPaise)}`,
      creditNoteId: credit.id,
    }));
  if (doc.refunds.inProgressPaise > 0) {
    lines.push({
      key: "in-progress",
      text: `Refund of ${inr(doc.refunds.inProgressPaise)}: on its way`,
      creditNoteId: null,
    });
  }
  if (doc.refunds.extraReturnedPaise > 0) {
    lines.push({
      key: "extra-returned",
      text: `Extra payment of ${inr(doc.refunds.extraReturnedPaise)} returned`,
      creditNoteId: null,
    });
  }
  return lines;
}

function RefundsAndCredits({
  doc,
  creditNotePath,
}: {
  doc: InvoiceDocument;
  creditNotePath: string | null;
}) {
  const lines = refundsAndCreditsLines(doc);
  if (lines.length === 0) return null;
  return (
    <section style={BLOCK_STYLE} aria-labelledby="sminv-refunds-heading">
      <h2 id="sminv-refunds-heading" style={BLOCK_HEADING_STYLE}>
        Refunds and credit notes
      </h2>
      {lines.map((line) => (
        <p key={line.key} style={BLOCK_LINE_STYLE}>
          {line.creditNoteId && creditNotePath ? (
            <Link
              href={`${creditNotePath}/${line.creditNoteId}`}
              style={{ color: "inherit" }}
            >
              {line.text}
            </Link>
          ) : (
            line.text
          )}
        </p>
      ))}
    </section>
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

/** Merchant-facing wording. `uncollectible` is our word, not theirs. */
function statusLabel(status: string): string {
  switch (status) {
    case "paid":
      return "Paid";
    case "open":
      return "Due";
    case "processing":
      return "Payment in progress";
    case "uncollectible":
      return "Unpaid - plan ended";
    case "void":
      return "Cancelled";
    // Labels only: nothing writes these two (a refund never changes its
    // invoice, rule R9), but a status set by hand still reads in words.
    case "refunded":
      return "Refunded";
    case "partially_refunded":
      return "Partly refunded";
    default:
      return status;
  }
}
