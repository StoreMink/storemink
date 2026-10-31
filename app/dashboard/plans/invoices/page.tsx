import { ResponsiveTable } from "@/app/dashboard/components/responsive-table";
import Link from "next/link";
import { ChevronLeft, FileText } from "lucide-react";
import { requireSectionAccess } from "../../lib/access";
import { getActingStoreId } from "../../lib/access";
import { listInvoices } from "@/lib/billing/invoice-history";
import { listCreditNotes } from "@/lib/billing/credit-note-store";
import type { InvoiceSummary } from "@/lib/billing/invoice-types";
import { invoiceListName } from "@/lib/billing/tax-copy";

export const metadata = { title: "Invoices" };

// Whole rupees print without decimals; anything else prints both paise
// digits ("₹500.50", never "₹500.5").
const inr = (paise: number) => {
  const rupees = paise / 100;
  const digits = Number.isInteger(rupees) ? 0 : 2;
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
};

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    : "-";

/** Merchant-facing wording — `uncollectible` is our word, not theirs. */
const STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-green-50 text-green-700" },
  open: { label: "Due", cls: "bg-amber-50 text-amber-800" },
  processing: { label: "Processing", cls: "bg-blue-50 text-blue-700" },
  uncollectible: { label: "Unpaid", cls: "bg-red-50 text-red-700" },
  void: { label: "Cancelled", cls: "bg-gray-100 text-gray-600" },
  // Labels only: a refund never changes its invoice's status (renewal-cancel
  // rule R9), so nothing writes these. A status set by hand still reads in
  // words; the refund itself shows as the line under the pill.
  refunded: { label: "Refunded", cls: "bg-gray-100 text-gray-600" },
  partially_refunded: {
    label: "Partly refunded",
    cls: "bg-gray-100 text-gray-600",
  },
};

/**
 * The one line under the status pill that says what happened to the money
 * (design 8.5), first match wins: a refund still moving matters more than
 * one that finished.
 */
/**
 * What the document is called before its number: "Tax invoice" when GST was
 * charged, else "Invoice" (`invoiceListName`, design 7.6). Only the number is
 * the link, so the link's name stays the number a merchant quotes.
 */
function documentWord(ref: string, taxPaise: number): string {
  const name = invoiceListName(ref, taxPaise);
  return name.slice(0, name.length - ref.length).trim();
}

function refundLine(inv: InvoiceSummary): string | null {
  const r = inv.refunds;
  if (r.inProgress) return "Refund on its way";
  if (r.delayed) return "Refund delayed";
  if (r.refundedPaise > 0 && r.refundedPaise >= inv.totalPaise) {
    return "Refunded in full";
  }
  if (r.refundedPaise > 0) return `Refunded ${inr(r.refundedPaise)}`;
  if (r.extraReturnedPaise > 0) {
    return `Extra payment of ${inr(r.extraReturnedPaise)} returned`;
  }
  return null;
}

export default async function InvoicesPage() {
  // Same section as the rest of billing. A read, so VIEW is enough.
  await requireSectionAccess("ai", "view");
  const storeId = await getActingStoreId();
  const [invoices, creditNotes] = await Promise.all([
    listInvoices(storeId),
    listCreditNotes(storeId),
  ]);

  return (
    <div className="dash-page-enter mx-auto w-full max-w-4xl">
      <Link
        href="/dashboard/plans"
        className="mb-4 inline-flex items-center gap-1 text-sm text-[#5b6472] hover:text-[#111827]"
      >
        <ChevronLeft className="h-4 w-4" />
        Plans &amp; Billing
      </Link>

      <h1 className="text-2xl font-bold text-[#111827]">Invoices</h1>
      <p className="mt-1 mb-6 text-sm text-[#5b6472]">
        Your StoreMink invoices and credit notes. Open one to print or save it.
      </p>

      {invoices.length === 0 ? (
        // ★ Says WHY it is empty. "No invoices" on a store that has been paying
        // reads as data loss; the real reason is almost always that they are on
        // Free, or that an invoice has not been issued yet.
        <div className="rounded-xl border border-[#e5e5e5] bg-white p-8 text-center">
          <FileText
            className="mx-auto mb-3 h-6 w-6 text-[#9aa1ab]"
            strokeWidth={1.5}
          />
          <p className="text-sm font-medium text-[#111827]">No invoices yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-[#6b7280]">
            Your first invoice is issued when you pay for a plan.
          </p>
        </div>
      ) : (
        <div className="dash-card overflow-hidden">
          <ResponsiveTable className="dash-table w-full">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Issued</th>
                <th>Period</th>
                <th className="text-right">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const s = STATUS[inv.status] ?? {
                  label: inv.status,
                  cls: "bg-gray-100 text-gray-600",
                };
                const refund = refundLine(inv);
                const ref = inv.invoiceRef ?? inv.id.slice(0, 8);
                return (
                  <tr key={inv.id}>
                    <td>
                      <span className="text-sm text-[#5b6472]">
                        {documentWord(ref, inv.taxPaise)}
                      </span>{" "}
                      <Link
                        href={`/dashboard/plans/invoices/${inv.id}`}
                        className="font-mono text-sm font-medium text-[#111827] hover:underline"
                      >
                        {ref}
                      </Link>
                    </td>
                    <td className="text-sm text-[#5b6472]">
                      {fmtDate(inv.finalizedAt)}
                    </td>
                    <td className="text-sm text-[#5b6472]">
                      {inv.periodStart && inv.periodEnd
                        ? `${fmtDate(inv.periodStart)} to ${fmtDate(inv.periodEnd)}`
                        : "-"}
                    </td>
                    <td className="text-right text-sm font-medium text-[#111827]">
                      {inr(inv.totalPaise)}
                    </td>
                    <td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}
                      >
                        {s.label}
                      </span>
                      {refund && (
                        <p className="mt-1 text-xs text-[#5b6472]">{refund}</p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </ResponsiveTable>
        </div>
      )}

      {creditNotes.length > 0 && (
        // ★ Only when there is one: an empty "Credit notes" table on a store
        // that has never been refunded reads as something missing.
        <section className="mt-8" aria-labelledby="credit-notes-heading">
          <h2
            id="credit-notes-heading"
            className="mb-3 text-lg font-semibold text-[#111827]"
          >
            Credit notes
          </h2>
          <div className="dash-card overflow-hidden">
            <ResponsiveTable className="dash-table w-full">
              <thead>
                <tr>
                  <th>Credit note</th>
                  <th>Issued</th>
                  <th>For invoice</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {creditNotes.map((note) => (
                  <tr key={note.id}>
                    <td>
                      <Link
                        href={`/dashboard/plans/credit-notes/${note.id}`}
                        className="font-mono text-sm font-medium text-[#111827] hover:underline"
                      >
                        {note.creditNoteRef}
                      </Link>
                    </td>
                    <td className="text-sm text-[#5b6472]">
                      {fmtDate(note.issuedAt)}
                    </td>
                    <td className="text-sm text-[#5b6472]">
                      {note.invoiceRef ? (
                        <Link
                          href={`/dashboard/plans/invoices/${note.invoiceId}`}
                          className="font-mono hover:underline"
                        >
                          {note.invoiceRef}
                        </Link>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="text-right text-sm font-medium text-[#111827]">
                      {inr(note.totalPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </div>
        </section>
      )}
    </div>
  );
}
