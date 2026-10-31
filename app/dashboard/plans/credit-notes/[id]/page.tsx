import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getActingStoreId,
  requireSectionAccess,
} from "@/app/dashboard/lib/access";
import { getCreditNoteDocument } from "@/lib/billing/credit-note-store";
import { PrintInvoiceButton } from "@/components/invoice/print-button";
import { CreditNoteSheet } from "../credit-note-sheet";
// The toolbar chrome AND the `@media print` isolation that hides everything
// except `.invoice-sheet`, the invoice page's own stylesheet.
import "@/components/invoice/invoice.css";

export const metadata = { title: "Credit note" };

/**
 * One StoreMink credit note, printable (renewal-cancel, design 8.8).
 *
 * ★★ The invoice page's gate, exactly: Plans & Billing's section, the store
 * from the session, never from the URL. `getCreditNoteDocument` is scoped by
 * that store THROUGH THE INVOICE the note credits, so another store's note,
 * an unknown id and a read failure all come back null and surface here as a
 * plain 404, which confirms nothing about the id.
 */
export default async function CreditNotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSectionAccess("ai", "view");
  const { id } = await params;
  const storeId = await getActingStoreId();
  const doc = await getCreditNoteDocument(storeId, id);
  if (!doc) notFound();

  return (
    <div className="invoice-wrap">
      <div className="invoice-toolbar invoice-noprint">
        <Link href="/dashboard/plans/invoices" className="invoice-back-btn">
          ← Invoices
        </Link>
        <PrintInvoiceButton />
      </div>
      <CreditNoteSheet doc={doc} />
    </div>
  );
}
