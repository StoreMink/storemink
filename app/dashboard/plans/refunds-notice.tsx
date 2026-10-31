import Link from "next/link";
import { getActingStoreId } from "../lib/access";
import {
  listRecentRefunds,
  type RecentRefund,
} from "@/lib/billing/invoice-history";

/**
 * "Refunds" on Plans & Billing (renewal-cancel, design 8.6): what StoreMink
 * has refunded, or owes, this store in the last 90 days, one row per payment,
 * newest five.
 *
 * ★ It renders NOTHING when there is nothing to say, the `OpenInvoices` rule:
 * a permanent "no refunds" panel is a money-shaped thing on a page a merchant
 * reads for reassurance.
 *
 * ★ A server component that reads for itself, so the page only mounts it.
 * The store comes from the session (the page has already checked Plans &
 * Billing access); the read is scoped by that store through the invoices.
 *
 * ★ No line promises an email. The email goes once a refund reaches the
 * merchant (refunds.ts step 7), whichever way it was made, and a promise
 * here would be wrong for every refund made before that ran.
 */
export async function RefundsNotice() {
  const storeId = await getActingStoreId();
  const refunds = await listRecentRefunds(storeId);
  return <RefundsNoticeList refunds={refunds} />;
}

const money = (paise: number) => {
  const rupees = paise / 100;
  const whole = Number.isInteger(rupees);
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
};

/** "30 Oct 2026" in India time, the shape the billing emails and the
 *  cancelling banner print. */
const istDay = (iso: string | null) => {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
};

/** What happened to this refund, in the merchant's words (design 8.6). */
export function refundNoticeLine(refund: RecentRefund): string {
  const on = istDay(refund.resolvedAt);
  switch (refund.status) {
    case "owed":
      return "Being prepared.";
    case "pending":
      return "On its way.";
    case "recorded":
      // A transfer made outside StoreMink says how it went; one made by hand
      // in the Razorpay dashboard went back the usual way, so it reads as a
      // refund Razorpay processed.
      if (refund.method === "bank_transfer") {
        return on
          ? `Refunded on ${on} by bank transfer.`
          : "Refunded by bank transfer.";
      }
      return on
        ? `Refunded on ${on}. It goes back to the account or card you paid with.`
        : "Refunded. It goes back to the account or card you paid with.";
    case "processed":
      return on
        ? `Refunded on ${on}. It goes back to the account or card you paid with.`
        : "Refunded. It goes back to the account or card you paid with.";
    case "failed":
      return "We couldn't send this refund automatically. Our team will contact you about it.";
    case "cancelled":
      return "Not sent. Write to support@storemink.com if you have a question about it.";
  }
}

/** Only a refund that reached the merchant has a credit note to open. */
function showsCreditNote(refund: RecentRefund): boolean {
  return (
    !!refund.creditNote &&
    (refund.status === "processed" || refund.status === "recorded")
  );
}

export function RefundsNoticeList({ refunds }: { refunds: RecentRefund[] }) {
  if (refunds.length === 0) return null;
  return (
    <section
      className="rounded-xl border border-[rgba(17,24,39,0.08)] bg-white p-6 shadow-sm"
      aria-labelledby="refunds-notice-heading"
    >
      <h2
        id="refunds-notice-heading"
        className="text-base font-semibold text-[#111827]"
      >
        Refunds
      </h2>
      <ul className="mt-3 divide-y divide-[rgba(17,24,39,0.06)]">
        {refunds.map((refund) => (
          <li key={refund.attemptId} className="py-3 first:pt-0 last:pb-0">
            <p className="text-sm font-medium text-[#111827]">
              {refund.invoiceRef
                ? `${money(refund.amountPaise)} for invoice ${refund.invoiceRef}`
                : money(refund.amountPaise)}
            </p>
            <p className="mt-0.5 text-sm text-[#5b6472]">
              {refundNoticeLine(refund)}
            </p>
            {showsCreditNote(refund) && refund.creditNote && (
              <Link
                href={`/dashboard/plans/credit-notes/${refund.creditNote.id}`}
                className="mt-1 inline-block text-sm font-medium text-[#111827] underline-offset-2 hover:underline"
              >
                {`Credit note ${refund.creditNote.ref}`}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
