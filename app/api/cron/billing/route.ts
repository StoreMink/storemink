import { NextResponse } from "next/server";
import { logError, logInfo } from "@/lib/observability/logger";
import {
  getPlanPricingLive,
  getExtraLocationPricingLive,
} from "@/lib/plans/pricing";
import { PLAN_META, type Plan } from "@/lib/plans";
import {
  RENEWAL_BATCH,
  collectDueRenewals,
  downgradeExpired,
  evaluateCycleTurns,
  type PassCursor,
} from "@/lib/billing/renewal-worker";
import {
  chargeUnavailableReason,
  getRecurringCharge,
} from "@/lib/billing/gateway";
import {
  issueCapturedDrafts,
  reconcileStrandedAttempts,
} from "@/lib/billing/reconcile";
import { processBillingRefunds } from "@/lib/billing/refunds";
import { reconcilePendingCreditPurchases } from "@/lib/ai/credit-purchase";
import {
  promoteDueTaxChange,
  type PromotedTaxChange,
} from "@/lib/billing/platform-settings";
import { bustPlatformTax } from "@/lib/billing/public-tax";

// The billing heartbeat: the renewal passes, then the refund pass, in order
// (GST design 5.12: promote, collect, reconcile, repair, evaluate, downgrade,
// refunds).
//
//   PROMOTE   every run: a scheduled GST change that has started is copied
//             into the in-force columns (lib/billing/platform-settings.ts).
//   COLLECT   at T-4d: issue the next cycle's invoice and charge it.
//   RECONCILE every run: settle payments we never heard back about, then
//             Mink credit packs paid for and never confirmed.
//   REPAIR    every run: a captured payment whose invoice is still a draft
//             gets its invoice (issueCapturedDrafts, lib/billing/reconcile.ts).
//   EVALUATE  at T0:   paid: advance the cycle; failed: grace starts.
//   DOWNGRADE at T0+48h: claim the downgrade and close any open POS shift.
//   REFUNDS   every run: money on a closed invoice goes back
//             (lib/billing/refunds.ts).
//
// ★ THE ORDER WITHIN A RUN MATTERS. Evaluate must see the result of a
// collection that just landed, and downgrade must see a grace window that
// evaluate just opened, or each pass is a full cron interval behind the one
// before it, and a merchant's 48-hour buffer silently becomes 48 hours plus two
// intervals. Running them together also means one late run cannot leave a
// subscription half-processed. The refund pass runs LAST, so an invoice a plan
// end closed in this run is refunded in this run.
//
// ⚠ SCHEDULE THIS HOURLY. The cycle boundary and the grace deadline are both
// wall-clock instants, so the interval is the resolution of the whole system: a
// daily run would give some merchants nearly a day of unearned service and
// others nearly a day less notice than the 48 hours they are promised.
//
// ⚠ Deploying this route does NOT schedule it. Cloud Scheduler is a separate
// act: docs/cron-jobs.md records three jobs that were documented and never
// created, and the seo-refresh job that sat undeployed for months.
//
// Auth: `Authorization: Bearer <CRON_SECRET>`.

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // Fails CLOSED: an unset secret makes this endpoint unauthenticated, and it
  // can charge merchants and remove their plans.
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Plan and location prices, read LIVE.
 *
 * ★ Never the cached readers. This number decides a CHARGE, and quoting from a
 * cache an operator's reprice has not reached would debit the old amount — the
 * discipline `lib/plans/pricing.ts` already draws between
 * `getPlanPricing` and `getPlanPricingLive`.
 */
async function priceFor(plan: Plan, period: "monthly" | "yearly") {
  const [pricing, locationPrice] = await Promise.all([
    getPlanPricingLive(),
    getExtraLocationPricingLive(),
  ]);
  const row = pricing[plan];
  const inr = period === "yearly" ? row.yearlyInr : row.monthlyInr;
  const locInr =
    period === "yearly" ? locationPrice.yearlyInr : locationPrice.monthlyInr;
  return {
    planPaise: Math.round(inr * 100),
    locationPaise: Math.round(locInr * 100),
    planLabel: PLAN_META[plan].name,
  };
}

/**
 * How long the three paged passes may keep reading further pages, from the
 * start of the request. The request has 300 seconds; the rest is left for
 * reconcile, repair and refunds, which run once each.
 */
const PAGING_BUDGET_MS = 180_000;

/** A hard stop on pages per pass, whatever the clock says: 40 x 50 rows. */
const MAX_PAGES_PER_PASS = 40;

/**
 * Run one pass page after page until it returns a short page.
 *
 * ★★ WHY (21 Nov 2026). Each pass used to read one page of 50 and stop, in no
 * particular order, and most rows it read were still there an hour later. So
 * past a few hundred subscribers the same 50 could be read every hour while
 * the rest were never invoiced, advanced or downgraded, with nothing
 * reporting it. The passes now sort oldest first and hand back a cursor
 * (`PassCursor`), and this keeps asking for the next page.
 *
 * It stops at a short page, at an error (a failing pass is retried by the
 * scheduler, not hammered here), at the page limit, or when the time budget
 * is spent; in the last two cases the summary keeps its `next`, which is what
 * `more` reports. Counts are added up across pages.
 */
async function drain<S extends { errors: number; next: PassCursor | null }>(
  run: (after: PassCursor | null) => Promise<S>,
  deadline: number,
): Promise<S> {
  let total = await run(null);
  let pages = 1;
  while (
    total.next &&
    total.errors === 0 &&
    pages < MAX_PAGES_PER_PASS &&
    Date.now() < deadline
  ) {
    const page = await run(total.next);
    const merged = { ...total } as Record<string, unknown>;
    for (const [key, value] of Object.entries(page)) {
      if (typeof value === "number") {
        merged[key] = Number(merged[key] ?? 0) + value;
      }
    }
    merged.next = page.next;
    total = merged as S;
    pages += 1;
  }
  return total;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const pagingDeadline = Date.now() + PAGING_BUDGET_MS;
  const charge = getRecurringCharge();
  const chargeBlocked = chargeUnavailableReason();

  // ★ PROMOTE FIRST, ONE UPDATE. Nothing below depends on it (`termsAt`
  // applies a started change by time); it keeps the in-force columns true for
  // whatever reads them directly. The cached public source is busted only when
  // a change was promoted. A failure is counted (503, retried) and the renewal
  // passes still run.
  let promoted: PromotedTaxChange | null = null;
  let promoteErrors = 0;
  try {
    promoted = await promoteDueTaxChange(now);
  } catch (err) {
    promoteErrors = 1;
    logError("billing.cron.promote_tax_change", err);
  }
  if (promoted) bustPlatformTax();

  // ★★ PASS 1 ALWAYS RUNS. It ISSUES the invoice; whether it also CHARGES it
  // depends on the gateway. Skipping the whole pass when the charge is
  // unavailable — which is what this did — meant no invoice was ever written, so
  // pass 2 waited forever, nobody was downgraded, every subscriber got free
  // service past their cycle end, and the manual payment surface had nothing to
  // list. A null `charge` issues and finalizes the invoice, then stops: the
  // merchant pays it on /dashboard/plans. NOT a stub charge — an unreachable
  // provider is an UNKNOWN outcome, not a decline, so every attempt would sit in
  // reconciliation forever.
  const collect = await drain(
    (after) =>
      collectDueRenewals({
        now,
        limit: RENEWAL_BATCH,
        charge,
        priceFor,
        after,
      }),
    pagingDeadline,
  );

  // ★★ RECONCILE BEFORE EVALUATING. A payment we never learned about is money
  // already in — and pass 2 decides grace and downgrade from whether the
  // invoice is paid. Running it after would downgrade a merchant whose payment
  // this very request was about to discover.
  const reconcile = await reconcileStrandedAttempts({ now });

  // ★ MINK CREDIT PACKS PAID FOR AND NEVER CONFIRMED (21 Nov 2026). A pack is
  // not a payment attempt, so the pass above does not see it; until now one
  // whose merchant closed the tab was only settled when they next opened
  // Plans & Billing. Before the repair pass, which issues the receipt of any
  // pack this makes paid. Never throws; a purchase Razorpay could not be
  // asked about is simply asked about again next hour.
  const creditPacks = await reconcilePendingCreditPurchases({ now });

  // ★★ REPAIR AFTER RECONCILE, BEFORE EVALUATING (GST design 5.4b and 5.12). A
  // captured payment whose invoice is still a draft gets its invoice here, so a
  // payment repaired in this run counts as paid when the cycle turn is
  // evaluated. It never throws; its errors join this run's. A draft it could
  // not finish (`unissued`) is reported, not an error: it is logged by the pass
  // and asked again next run.
  const repair = await issueCapturedDrafts({ now });

  const evaluate = await drain(
    (after) =>
      evaluateCycleTurns({
        now,
        limit: RENEWAL_BATCH,
        // Only affects the wording of the overdue email (evaluateCycleTurns).
        autopayConfigured: !!charge,
        after,
      }),
    pagingDeadline,
  );
  const downgrade = await drain(
    (after) => downgradeExpired({ now, limit: RENEWAL_BATCH, after }),
    pagingDeadline,
  );

  // ★ AFTER DOWNGRADE, with the same clock: a plan end above closes its
  // unreached invoices, and this pass owes, sends and settles the money on
  // them. A refund that was refused or failed is NOT an error here (it is a
  // person's job, and the alert says so); only a database error is.
  const refunds = await processBillingRefunds({ now });

  const errors =
    promoteErrors +
    collect.errors +
    reconcile.errors +
    creditPacks.errors +
    repair.errors +
    evaluate.errors +
    downgrade.errors +
    refunds.errors;

  // More work than this run could reach: a paged pass stopped with pages
  // still ahead of it (the time budget or the page limit), or the repair or
  // refund pass filled its batch. Reported so a caller can run again sooner,
  // but NOT an error: a backlog draining is normal.
  const more =
    !!collect.next ||
    repair.more ||
    !!evaluate.next ||
    !!downgrade.next ||
    refunds.more;

  const body = {
    ok: errors === 0,
    collectionSkipped: chargeBlocked,
    promote: { promoted, errors: promoteErrors },
    collect,
    reconcile,
    creditPacks,
    repair,
    evaluate,
    downgrade,
    refunds,
    more,
  };

  if (errors > 0) {
    logError("billing.cron", new Error("billing pass reported errors"), body);
    // ★ 503 so Cloud Scheduler's retries engage (the seo-refresh contract). A
    // failed pass here means money was not collected or a plan was not applied,
    // which is worth retrying — unlike a merchant who simply has not paid.
    return NextResponse.json(body, { status: 503 });
  }

  // ★ 200 while a backlog drains, and 200 when collection is unconfigured. A
  // permanently-red job is one nobody reads (the domain-reconcile lesson), and
  // neither of those is an outage.
  logInfo("billing.cron", body);
  return NextResponse.json(body);
}

export const GET = handle;
export const POST = handle;
