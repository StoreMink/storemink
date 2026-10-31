import { notFound } from "next/navigation";
import Link from "next/link";
import { getCreditNoteDocumentForOperator } from "@/lib/billing/credit-note-store";
import { PrintInvoiceButton } from "@/components/invoice/print-button";
import { CreditNoteSheet } from "@/app/dashboard/plans/credit-notes/credit-note-sheet";
import { requireOperator } from "../../../require-operator";
// The toolbar chrome AND the `@media print` isolation that hides everything
// except `.invoice-sheet`, the invoice page's own stylesheet.
import "@/components/invoice/invoice.css";

export const metadata = { title: "Credit note · StoreMink Admin" };

/**
 * One credit note, printable from the operator console (renewal-cancel,
 * design 7.2, "Print"). The same sheet the merchant prints.
 *
 * ★★ THE GATE COMES FIRST AND IS THE WHOLE ACCESS CONTROL.
 * `getCreditNoteDocumentForOperator` has no store predicate (a note on an
 * invoice kept after its store was deleted must still print here), so the
 * read runs only after `requireOperator()` has resolved a platform operator.
 * A layout redirect does not stop this page rendering (§3), which is why the
 * page gates itself. An unknown id, a malformed one and a read failure are
 * all a plain 404.
 */
export default async function ConsoleCreditNotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperator();
  const { id } = await params;
  const doc = await getCreditNoteDocumentForOperator(id);
  if (!doc) notFound();

  return (
    <div className="invoice-wrap">
      <div className="invoice-toolbar invoice-noprint">
        <Link
          href="/dashboard/billing/refunds?tab=credit_notes"
          className="invoice-back-btn"
        >
          ← Refunds
        </Link>
        <PrintInvoiceButton />
      </div>
      <CreditNoteSheet doc={doc} />
    </div>
  );
}
