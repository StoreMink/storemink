import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import {
  countRefundsNeedingAction,
  getRefundQueue,
  type RefundQueueTab,
} from "@/app/actions/platform-billing";
import { canManage, requireOperator } from "../../require-operator";
import { REFUND_TABS, RefundTabs, RefundsTable } from "./refunds-table";

export const metadata = { title: "Refunds · StoreMink Admin" };

/**
 * Money StoreMink is returning to merchants (renewal-cancel, design 7.2).
 *
 * ★ Gated on its own with `requireOperator()`, not on the layout: a layout
 * redirect does not abort a concurrently rendering page (the §3 rule), and
 * these reads run across every store's payments.
 *
 * ★ Any operator may read; only a superadmin sees the buttons, and every
 * action checks again on the server.
 */
export default async function RefundsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireOperator();

  const sp = await searchParams;
  const raw = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: RefundQueueTab = REFUND_TABS.some((t) => t.key === raw)
    ? (raw as RefundQueueTab)
    : "needs_person";

  const [queue, count] = await Promise.all([
    getRefundQueue(tab),
    countRefundsNeedingAction(),
  ]);

  return (
    <div className="dash-page-enter">
      <Link
        href="/dashboard/billing"
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--dash-text-2)] hover:text-[var(--dash-text)] pointer-coarse:min-h-11"
      >
        <ChevronLeft aria-hidden className="h-4 w-4" />
        Billing &amp; tax
      </Link>

      <h1 className="text-2xl font-bold text-[var(--dash-text)]">Refunds</h1>
      <p className="mt-1 mb-5 max-w-2xl text-sm text-[var(--dash-text-2)]">
        Money StoreMink is returning to merchants: renewal payments for cycles a
        plan never reached, which the billing run finds by itself, and refunds
        an operator issues. Each refund goes back to the payment it reverses,
        and a credit note is issued when it completes.
      </p>

      <RefundTabs tab={tab} needsPerson={count ? count.total : null} />

      {/* ★ A read failure says so (§39): the count is null only when it
          could not be read, and a zero would be a wrong answer. */}
      {count === null ? (
        <p
          role="status"
          className="mb-4 max-w-3xl rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)] bg-[var(--dash-amber-soft)] px-3 py-2 text-sm text-[var(--dash-text)]"
        >
          The refunds that need a look couldn&apos;t be counted just now, so
          this list may be incomplete. Refresh the page to try again.
        </p>
      ) : null}

      <RefundsTable
        tab={tab}
        refunds={queue.refunds}
        creditNotes={queue.creditNotes}
        canManage={canManage(viewer)}
      />
    </div>
  );
}
