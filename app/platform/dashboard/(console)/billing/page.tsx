import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getGstChangeNotices,
  getOpenReconciliationCount,
  getPlanPricingForConsole,
  getPlatformViewer,
  getTaxSettings,
} from "@/app/actions/platform";
import { countRefundsNeedingAction } from "@/app/actions/platform-billing";
import { DEFAULT_TAX_SETTINGS } from "@/lib/billing/platform-settings";
import { TAX_CONSOLE } from "@/lib/billing/tax-copy";
import { PLAN_META } from "@/lib/plans";
import { InvoiceListCard } from "./invoice-list-card";
import { AutoRefundsSwitch } from "./refund-settings";
import { TaxChangeForm } from "./tax-change-form";
import { TaxIdentityForm } from "./tax-identity-form";
import { TaxStatus } from "./tax-status";

export const metadata = { title: "Billing & tax" };

const BANNER =
  "mb-3 flex max-w-3xl items-center justify-between gap-4 rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)] bg-[var(--dash-amber-soft)] px-4 py-3 text-[var(--dash-text)] transition hover:border-[var(--dash-amber)] pointer-coarse:min-h-11";
const QUIET_LINK =
  "inline-flex items-center text-sm text-[var(--dash-text-2)] hover:text-[var(--dash-text)] hover:underline pointer-coarse:min-h-11";

/**
 * StoreMink's own tax identity (§34), and the way into the money queues.
 *
 * Four cards and the refunds card, in this order (GST design 6): GST status,
 * StoreMink's tax identity, Charging GST, the monthly invoice list (a
 * superadmin's alone: members do not see it), then Refunds. The banners for
 * the reconciliation queue and the refunds queue stay above them all.
 *
 * ★ Gated TWICE, deliberately. The console layout already redirects a
 * non-operator, but this page reads and edits the platform's GSTIN, so it does
 * not rely on a parent layout for its authorisation. A layout `notFound()` or
 * redirect does not abort a concurrently-rendering child page (the
 * `requireStorefrontStore` rule, §3), and the same reasoning applies here.
 *
 * Editing is superadmin-only; any operator may LOOK, because "are we charging
 * GST?" is a question support needs answered without a write grant.
 *
 * ★★ SETTINGS THAT COULD NOT BE READ ARE NEVER DRAWN AS "GST OFF" (review
 * R3-05). The status card says they could not be read (TAX_CONSOLE.readFailed)
 * instead of its sentence, and every save on the page (the identity, Charging
 * GST, cancelling a scheduled change, the refunds switch) is disabled until a
 * read succeeds: the cards hold defaults, and saving them would write blanks
 * over StoreMink's stored identity. The monthly invoice list reads nothing
 * from the settings, so it stays.
 */
export default async function PlatformBillingPage() {
  const viewer = await getPlatformViewer();
  if (!viewer) redirect("/dashboard/login");

  const [read, openItems, refunds, pricing, notices] = await Promise.all([
    getTaxSettings(),
    getOpenReconciliationCount(),
    countRefundsNeedingAction(),
    getPlanPricingForConsole(),
    getGstChangeNotices(),
  ]);
  // The viewer is an operator here, so a refusal is a read that failed.
  const unreadable = !read.ok;
  const settings = read.ok ? read.settings : DEFAULT_TAX_SETTINGS;
  const refundsWaiting = refunds?.total ?? 0;
  const canEdit = viewer.role === "superadmin";
  // One instant for every card, so the server and the browser draw the same
  // sentences.
  const now = new Date().toISOString();
  // The price-mode examples use the live Basic monthly price (design 6.4).
  const basicMonthlyInr =
    "pricing" in pricing
      ? pricing.pricing.basic.monthlyInr
      : PLAN_META.basic.monthlyInr;

  return (
    <div className="dash-page-enter">
      <h1 className="text-2xl font-bold text-[var(--dash-text)]">
        Billing &amp; tax
      </h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-[var(--dash-text-2)]">
        {TAX_CONSOLE.intro}
      </p>

      {/* ★ ABOVE the form, and only when there is something to see. A queue
          nobody looks at is the same as no queue, and these are money
          discrepancies, which do not become less true for being unread. */}
      {openItems > 0 && (
        <Link href="/dashboard/billing/reconciliation" className={BANNER}>
          <span className="text-sm">
            <strong>
              {openItems} payment{" "}
              {openItems === 1 ? "discrepancy" : "discrepancies"}
            </strong>{" "}
            need{openItems === 1 ? "s" : ""} a look.
          </span>
          <span className="shrink-0 text-sm font-medium">Review →</span>
        </Link>
      )}

      {/* ★ Refunds that need a person (design 7.1). At zero the way in stays,
          quietly: the Done and Credit notes tabs are what support opens to
          answer "did my refund go?", and they must not wait for a problem.
          A count that could not be read says so rather than reading as zero. */}
      {refundsWaiting > 0 ? (
        <Link href="/dashboard/billing/refunds" className={BANNER}>
          <span className="text-sm">
            <strong>
              {refundsWaiting} {refundsWaiting === 1 ? "refund" : "refunds"}
            </strong>{" "}
            {refundsWaiting === 1 ? "needs" : "need"} a look.
          </span>
          <span className="shrink-0 text-sm font-medium">Review →</span>
        </Link>
      ) : null}

      <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-1">
        {/* Always reachable, even at zero: someone looking for the audit trail
            of a closed item should not have to wait for a new one to appear. */}
        {openItems === 0 && (
          <Link href="/dashboard/billing/reconciliation" className={QUIET_LINK}>
            Reconciliation queue →
          </Link>
        )}
        {refundsWaiting === 0 && (
          <Link href="/dashboard/billing/refunds" className={QUIET_LINK}>
            Refunds and credit notes →
          </Link>
        )}
      </div>
      {refunds === null ? (
        <p
          role="status"
          className="-mt-4 mb-6 text-xs text-[var(--dash-text-2)]"
        >
          The refunds that need a look couldn&apos;t be counted just now.
        </p>
      ) : null}

      <TaxStatus
        settings={settings}
        canEdit={canEdit}
        now={now}
        unreadable={unreadable}
      />
      <TaxIdentityForm
        initial={settings}
        canEdit={canEdit}
        unreadable={unreadable}
      />
      <TaxChangeForm
        settings={settings}
        canEdit={canEdit}
        now={now}
        basicMonthlyPaise={Math.round(basicMonthlyInr * 100)}
        notices={notices}
        unreadable={unreadable}
      />
      {/* ★ A superadmin's alone: it names every merchant StoreMink invoiced,
          with their GSTINs. A member sees no card, not a disabled one. */}
      {canEdit ? <InvoiceListCard now={now} /> : null}
      <AutoRefundsSwitch
        initial={settings.autoRefunds}
        canEdit={canEdit}
        unreadable={unreadable}
      />
    </div>
  );
}
