import "server-only";

/**
 * The renewal worker — three passes over the subscription fleet.
 *
 * Design: docs/billing-architecture.md §2c, §7.
 *
 *   COLLECT   at T−4d: build and issue the next cycle's invoice, then charge.
 *   EVALUATE  at T0:   paid ⇒ advance the cycle; failed ⇒ grace starts.
 *   DOWNGRADE at T0+48h: claim the downgrade and close the till.
 *
 * ★★ WHY COLLECTION HAPPENS FOUR DAYS EARLY. RBI requires a pre-debit
 * notification ≥24h ahead, and a recurring debit takes X+3 days to confirm. Bill
 * AT cycle start and the 2-day grace expires before the payment result is even
 * known — downgrading merchants whose money is still in flight, which is Rule 6
 * violated by a scheduling mistake. Collecting at T−4d means the answer is
 * already in hand when the cycle turns.
 *
 * ★ EACH PASS IS INDEPENDENTLY RE-RUNNABLE, and correctness never depends on a
 * lock. Two workers racing produce ONE invoice
 * (`billing_invoices_one_per_cycle`) and ONE charge
 * (`billing_payment_attempts_one_in_flight`), because those are database
 * constraints rather than application checks. Pass 2 does take
 * `FOR UPDATE SKIP LOCKED` — its work is entirely in-transaction, so the lock
 * actually spans it — while pass 1 deliberately does not, because its lock
 * would expire before the gateway call it was meant to protect. See `claimDue`.
 */

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  lte,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  billingInvoices,
  billingSubscriptions,
  planEvents,
  posShifts,
  stores,
} from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  effectivePlan,
  limitsFor,
  normalizePlan,
  type Plan,
} from "@/lib/plans";
import {
  AUTO_COLLECT_MAX_STARTS,
  autoCollectDecision,
  autoCollectExhausted,
  collectionCutoff,
  collectionRoute,
  collectionStartsAt,
  cycleFrom,
  graceEndsAt,
} from "./cycle";
import { closeUnreachedInvoices } from "./close-cycle";
import {
  automaticAttemptsOn,
  collectInvoice,
  type CollectResult,
  type RecurringGateway,
} from "./collect";
import { earlierDebitsOf } from "./earlier-debits";
import {
  isVerifiable,
  loadMandateRecord,
  verifyMandate,
} from "./mandate-check";
import {
  amountDueForInvoice,
  ensureRenewalInvoice,
  finalizeInvoiceClaimed,
  getCycleInvoice,
  getInvoice,
  loadTaxSnapshot,
  type InvoiceRow,
} from "./invoice-store";
import type { TaxSnapshot } from "./tax-snapshot";
import {
  notifyAutopayStopped,
  notifyDowngraded,
  notifyGraceStarted,
  notifyInvoiceIssued,
} from "./dunning";
import { buildSubscriptionInvoice } from "./invoice";
import { resolveNextCycle, type ScheduledFields } from "./next-cycle";
import { billingMayApplyPlan } from "@/lib/payments/plan-change";

/** How many subscriptions one pass will touch. Bounded so a Cloud Run request
 *  finishes; the cron self-chains while there is more. */
export const RENEWAL_BATCH = 50;

type BillingPeriod = "monthly" | "yearly";

/**
 * Where one page of a pass stopped, so the next page starts after it.
 *
 * ★★ WHY THE PASSES PAGE (21 Nov 2026). Each pass took the first 50 rows the
 * database happened to return, with no ORDER BY, and most of those rows are
 * still there on the next run (a renewal already invoiced stays inside the
 * lead window for four days; a turned cycle whose payment is still in flight
 * stays `active`). So past a few hundred subscribers the same 50 could be
 * returned every hour and the rest never invoiced, never advanced and never
 * downgraded. Every pass now reads in a fixed order, oldest first, and the
 * cron keeps asking for the next page until a pass returns a short one.
 *
 * `at` is the row's sort time exactly as the database returned it (it is
 * passed straight back and cast, so no precision is lost); `storeId` breaks
 * ties.
 */
export interface PassCursor {
  at: string;
  storeId: string;
}

/** The rows strictly after `after` in (time, store) order. */
function afterCursor(
  time: unknown,
  storeId: unknown,
  after: PassCursor | null | undefined,
): SQL | undefined {
  if (!after) return undefined;
  return sql`(${time}, ${storeId}) > (${after.at}::timestamptz, ${after.storeId}::uuid)`;
}

export interface RenewalSummary {
  considered: number;
  collected: number;
  /** Renewals whose order and pre-debit notice were created this run. */
  notified: number;
  failed: number;
  pendingReconcile: number;
  manualRequired: number;
  errors: number;
  /** Set when this page was full: pass it back as `after` for the next. */
  next: PassCursor | null;
}

interface DueRow {
  storeId: string;
  plan: string;
  period: string;
  currentCycleSeq: number;
  currentPeriodEnd: string | null;
  billedLocations: number;
  /** Booked changes, which apply to the cycle this invoice is FOR. */
  scheduledPlan: string | null;
  scheduledPeriod: string | null;
  scheduledLocations: number | null;
  cancelAtPeriodEnd: boolean;
  mandateId: string | null;
}

/**
 * PASS 1 — collect for every cycle starting within the lead window.
 *
 * The invoice covers the NEXT cycle: it begins where the current one ends.
 */
export async function collectDueRenewals(input: {
  now?: Date;
  limit?: number;
  /** Start after this row: the `next` an earlier page returned. */
  after?: PassCursor | null;
  /**
   * ★★ NULL = ISSUE THE INVOICE, DO NOT CHARGE. Issuing is not charging: it
   * writes a document saying what is owed, which the merchant settles by hand on
   * /dashboard/plans. Gating ISSUANCE behind the charge — which is what this
   * pass used to do, by being skipped wholesale — meant no invoice was ever
   * written, so pass 2 waited forever, grace never opened, nobody was ever
   * downgraded, and every subscriber silently received free service past their
   * cycle end. It also made the manual payment surface unreachable: it lists
   * open invoices, and there were none. The two must be separable, because
   * manual payment is a complete billing path on its own.
   */
  charge: RecurringGateway | null;
  /** Injected so tests need no pricing table; production passes the LIVE
   *  reader, never a cached one — this number decides a charge. */
  priceFor: (
    plan: Plan,
    period: BillingPeriod,
  ) => Promise<{ planPaise: number; locationPaise: number; planLabel: string }>;
}): Promise<RenewalSummary> {
  const now = input.now ?? new Date();
  const summary: RenewalSummary = {
    considered: 0,
    collected: 0,
    notified: 0,
    failed: 0,
    pendingReconcile: 0,
    manualRequired: 0,
    errors: 0,
    next: null,
  };

  const limit = input.limit ?? RENEWAL_BATCH;
  let due: DueRow[];
  try {
    due = await withService(async (db) =>
      claimDue(db, now, limit, input.after),
    );
  } catch (err) {
    logError("billing.renewal.claim", err);
    summary.errors += 1;
    return summary;
  }
  // A full page means there may be more behind it.
  const last = due.at(-1);
  if (due.length >= limit && last?.currentPeriodEnd) {
    summary.next = { at: last.currentPeriodEnd, storeId: last.storeId };
  }

  for (const row of due) {
    summary.considered += 1;
    try {
      const result = await collectOne(row, now, input);
      if (result === "paid") summary.collected += 1;
      else if (result === "notified") summary.notified += 1;
      else if (result === "failed") summary.failed += 1;
      else if (result === "manual") summary.manualRequired += 1;
      else summary.pendingReconcile += 1;
    } catch (err) {
      logError("billing.renewal.collect_one", err, { storeId: row.storeId });
      summary.errors += 1;
    }
  }
  return summary;
}

/**
 * How long a renewal waits for the gateway to say whether its mandate still
 * stands before the invoice is issued anyway, as one to pay by hand. Counted
 * from when the renewal became due (four days before the cycle), so the
 * merchant still has three days' notice.
 */
export const MANDATE_CHECK_HOLD_HOURS = 24;

/**
 * Which subscriptions are due for collection?
 *
 * ★ COMPED STORES ARE EXCLUDED AT THE QUERY. They have no mandate and no
 * invoice, so billing them would invent an obligation an operator deliberately
 * waived — and `billingMayApplyPlan`'s comp-is-a-floor rule exists because that
 * mistake has been made here before.
 *
 * ⚠ DELIBERATELY NO `FOR UPDATE SKIP LOCKED` HERE, unlike pass 2. The row lock
 * would be released the instant this transaction commits, and the gateway call
 * happens well after that — a DB transaction and a Razorpay call are never one
 * atomic unit (spec §64). Holding it across the charge would mean keeping a
 * pooled connection open for the length of an external HTTP request, which is
 * how a fleet-wide renewal exhausts the pool.
 *
 * So two workers CAN select the same row, and it is still safe: one wins
 * `billing_invoices_one_per_cycle` and the other reads its invoice, then one
 * wins `billing_payment_attempts_one_in_flight` and the other is told
 * `already_in_flight` BEFORE it charges. The constraints are the guarantee; a
 * lock here would only have looked like one. If duplicated read work ever costs
 * enough to matter, the fix is a real lease column (the `data_jobs` pattern),
 * not a lock that expires before the work does.
 */
async function claimDue(
  db: Db,
  now: Date,
  limit: number,
  after?: PassCursor | null,
): Promise<DueRow[]> {
  return (
    db
      .select({
        storeId: billingSubscriptions.storeId,
        plan: billingSubscriptions.plan,
        period: billingSubscriptions.period,
        currentCycleSeq: billingSubscriptions.currentCycleSeq,
        currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
        billedLocations: billingSubscriptions.billedLocations,
        scheduledPlan: billingSubscriptions.scheduledPlan,
        scheduledPeriod: billingSubscriptions.scheduledPeriod,
        scheduledLocations: billingSubscriptions.scheduledLocations,
        cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
        mandateId: billingSubscriptions.mandateId,
      })
      .from(billingSubscriptions)
      .where(
        and(
          inArray(billingSubscriptions.state, ["active", "past_due", "grace"]),
          // ★★ THERE IS NO COMP EXEMPTION HERE ANY MORE, and its absence is
          // deliberate — see docs/comped-plans-spec.md §7 and migration 0078.
          // A comped plan is an entitlement OVERLAY resolved at read time; holding
          // a free upgrade never means the merchant stopped paying for the plan
          // underneath, so skipping collection would turn a gift into a silent
          // payment holiday. The predicate was also a latent trap:
          // `billing_subscriptions.plan_source` DEFAULTS to 'comp' and only
          // becomes 'paid' at activation, so a half-enrolled row was permanently
          // uninvoiceable and undowngradeable with nothing reporting it. The
          // matching predicate inside `billing_claim_downgrade()` went with it —
          // removing only the TypeScript ones would invoice and chase a
          // subscription that the atomic claim then silently refuses to downgrade.
          // ★★ A CANCELLED SUBSCRIPTION IS NOT INVOICED. It ends at the period end,
          // so raising a document for the cycle after it would bill a merchant who
          // explicitly stopped — and, because grace and downgrade follow an unpaid
          // invoice, would then chase them for it.
          eq(billingSubscriptions.cancelAtPeriodEnd, false),
          isNotNull(billingSubscriptions.currentPeriodEnd),
          // A cycle beginning at or before the cutoff is inside the lead window.
          lte(
            billingSubscriptions.currentPeriodEnd,
            collectionCutoff(now).toISOString(),
          ),
          // ★ A RENEWAL ALREADY PAID HAS NOTHING LEFT TO COLLECT. It stays
          // inside the lead window until its cycle turns, so without this every
          // hourly run re-read it (and counted it as collected again) for four
          // days, and those rows filled the page ahead of ones still owed.
          sql`not exists (
          select 1 from billing_invoices paid_next
           where paid_next.store_id = ${billingSubscriptions.storeId}
             and paid_next.kind = 'subscription'
             and paid_next.cycle_seq = ${billingSubscriptions.currentCycleSeq} + 1
             and paid_next.status = 'paid')`,
          afterCursor(
            billingSubscriptions.currentPeriodEnd,
            billingSubscriptions.storeId,
            after,
          ),
        ),
      )
      // ★ SOONEST CYCLE FIRST, in a fixed order, so pages do not overlap and
      // the renewal closest to its cycle turn is never the one left behind.
      .orderBy(
        asc(billingSubscriptions.currentPeriodEnd),
        asc(billingSubscriptions.storeId),
      )
      .limit(limit)
  );
}

async function collectOne(
  row: DueRow,
  now: Date,
  input: {
    charge: RecurringGateway | null;
    priceFor: (
      plan: Plan,
      period: BillingPeriod,
    ) => Promise<{
      planPaise: number;
      locationPaise: number;
      planLabel: string;
    }>;
  },
): Promise<"paid" | "notified" | "failed" | "manual" | "pending"> {
  // ★★ PRICE WHAT WILL APPLY NEXT CYCLE, not what applies today. `resolveNextCycle`
  // is the ONE place scheduled plan / period / location changes are resolved, so
  // this and `advanceCycle` cannot disagree — and if they did, the merchant would
  // be billed for something they did not get, silently, a month later.
  const nextShape = resolveNextCycle(row);
  // A cancelled subscription is filtered out in claimDue; this is the belt to
  // that braces, so a future caller cannot invoice one by accident.
  if (nextShape.ending) return "pending";

  const period: BillingPeriod = nextShape.period;
  const plan = nextShape.plan as Plan;
  const periodStart = new Date(row.currentPeriodEnd!);
  const next = cycleFrom(periodStart, period, row.currentCycleSeq + 1);

  const price = await input.priceFor(plan, period);

  // ★★ ONE TAX READING FOR THE WHOLE INVOICE (GST design 5.2): the terms in
  // force when this cycle's invoice is built, the builder's tax context and
  // the particulars stamped on it, read together. There is no tax-off
  // fallback any more: a reading that fails, or settings that charge GST
  // without StoreMink's GSTIN, state or SAC code, leave the renewal for the
  // next hourly run rather than issuing an invoice on a guess. Nothing is
  // written, so nothing is lost; the merchant keeps their plan meanwhile,
  // because the cycle has not turned yet (T-4d).
  let snapshot: TaxSnapshot;
  try {
    snapshot = await loadTaxSnapshot(row.storeId, now);
  } catch (err) {
    logError("billing.renewal_tax_snapshot", err, {
      storeId: row.storeId,
      reason: "read_failed",
    });
    return "pending";
  }
  if (!snapshot.ok) {
    logError(
      "billing.renewal_tax_snapshot",
      new Error("the GST settings are incomplete"),
      { storeId: row.storeId, reason: snapshot.reason },
    );
    return "pending";
  }

  // Locations are billed only if the plan can have them — `resolveNextCycle`
  // already zeroed the count for a plan without POS, so this is the shape, not
  // the rule.
  const locations =
    nextShape.billedLocations > 0
      ? { count: nextShape.billedLocations, unitPaise: price.locationPaise }
      : undefined;

  const built = buildSubscriptionInvoice({
    planLabel: price.planLabel,
    period,
    planPaise: price.planPaise,
    locations,
    tax: snapshot.tax,
  });

  const invoice = await ensureRenewalInvoice({
    storeId: row.storeId,
    cycleSeq: next.seq,
    periodStart: next.start,
    periodEnd: next.end,
    dueAt: next.start,
    built,
    stamp: snapshot.stamp,
  });
  if (!invoice) return "pending";

  // Already settled by an earlier run — nothing to do.
  if (invoice.status === "paid") return "paid";

  // ★★ A PAYMENT ON THIS INVOICE IS STILL UNRESOLVED: NEVER START ANOTHER
  // (Rule 1, found 21 Nov 2026). `processing` is derived from the attempts
  // and includes an `unknown` outcome: a timeout or a 5xx on the debit, where
  // the money may well have moved. The one-in-flight index covers `created`,
  // `processing` and `authorized` but NOT `unknown`, so the next hourly run
  // opened a second attempt and debited the mandate again while the first was
  // still waiting for reconciliation (which runs AFTER this pass). Stop here
  // instead: reconciliation settles the attempt (captured, or failed after its
  // 72 hours), the invoice leaves `processing`, and only then is it collected
  // again.
  if (invoice.status === "processing") return "pending";

  // ★★ ASK THE GATEWAY ABOUT THE MANDATE BEFORE THE INVOICE IS ISSUED
  // (21 Nov 2026). The issue notice below says either "we'll charge your saved
  // payment method, there's nothing you need to do" or "pay this", and it is
  // sent exactly once. StoreMink's own record says `active` from the day the
  // mandate was authorised, but the customer can cancel or pause it at their
  // bank at any time, and only a `confirmed` token may be debited. So the
  // record is brought in line FIRST (`verifyMandate`), and the notice tells
  // the truth. ★ A gateway that could not be asked stops this run BEFORE
  // anything is written: the invoice stays a draft and the next run asks
  // again, so the one notice is never sent on a guess.
  //
  // ★★ BUT NOT FOR EVER (`MANDATE_CHECK_HOLD_HOURS`). The invoice is what
  // every later step hangs on: with none, the cycle turn has nothing unpaid
  // to open grace on, and the store keeps its plan for nothing (that happened
  // until 2026-08-13 for another reason). And "could not be asked" can be
  // permanent: Razorpay answers a mandate that was deleted with a plain "the
  // id provided does not exist", which is not a verdict this code will act on
  // (a wrong key or account answers the same for EVERY mandate, and treating
  // it as "cancelled" would switch autopay off for every store at once). So
  // after a day of no answer the invoice is issued as one to pay by hand,
  // the mandate's record untouched; if the gateway answers later, the retry
  // check below lets autopay collect it after all.
  let mandate = await loadMandateRecord(row.mandateId);
  let mandateUnverified = false;
  if (!invoice.finalizedAt && input.charge && isVerifiable(mandate)) {
    const verdict = await verifyMandate(mandate!, input.charge, now);
    if (verdict.result === "unknown") {
      const holdUntil =
        collectionStartsAt(periodStart).getTime() +
        MANDATE_CHECK_HOLD_HOURS * 3_600_000;
      if (now.getTime() < holdUntil) return "pending";
      mandateUnverified = true;
      logWarn("billing.renewal_mandate_unverified", {
        storeId: row.storeId,
        invoiceId: invoice.id,
        mandateId: mandate!.id,
      });
    } else {
      mandate = verdict.mandate;
    }
  }

  // ★ Finalize BEFORE charging. The document number is what the merchant is
  // being asked to pay against, and the pre-debit notification quotes it.
  // ★ Issuing goes through `issueInvoice`, which reads the tax again at issue
  // and may rebuild a draft built earlier under other terms; an existing
  // draft it cannot rebuild (`kept_draft`) is still issued with its own
  // figures. Whatever it issued is what the merchant is told and charged:
  // the notice below quotes the ISSUED row, never `built`.
  let justIssued: { claimed: boolean; invoice: InvoiceRow } | null = null;
  if (!invoice.finalizedAt) {
    const issued = await finalizeInvoiceClaimed(invoice.id, now);
    if (!issued.invoice) return "pending";
    // ★★ NEVER COLLECT AN INVOICE WITH NO ISSUE DATE. Finalize claims only a
    // draft, so an invoice that is not a draft yet carries no `finalized_at`
    // comes back unissued: a draft someone closed by hand, or a state no code
    // writes. Charging against it would take money with no document behind it,
    // and quoting it in the notice would name no number. It is left exactly as
    // it is and counted with the other skips (`pendingReconcile`), the bucket
    // that already means "nothing was attempted this run".
    if (!issued.invoice.finalizedAt) {
      logError(
        "billing.renewal_unissued_invoice",
        new Error("invoice has no finalized_at after the finalize step"),
        {
          storeId: row.storeId,
          invoiceId: invoice.id,
          status: issued.invoice.status,
        },
      );
      return "pending";
    }
    justIssued = { claimed: issued.claimed, invoice: issued.invoice };
  }

  const amountDue = await amountDueForInvoice(invoice.id);
  if (amountDue === null) return "pending"; // Never guess an amount (Rule 10).

  // ★ TELL THE MERCHANT, once, on the run that actually issued it. Four days'
  // notice before the cycle turns — and when collection is gated this notice IS
  // how they learn they must pay, so it is not optional politeness.
  // ⚠ AFTER the amount is known and OUTSIDE any transaction: an email is a
  // network call, and holding a pooled connection across one is how a fleet-wide
  // renewal exhausts the pool.
  // ★★ LOADED BEFORE THE NOTICE, NOT AFTER. The email says either "there's
  // nothing you need to do" or "pay this" — and getting that wrong in the
  // reassuring direction is how a merchant does nothing and loses their plan.
  const route = collectionRoute({
    mandateStatus: mandate?.status ?? null,
    mandateMaxPaise: mandate?.maxAmountPaise ?? null,
    totalPaise: amountDue,
  });
  const willAutoCollect = !!input.charge && route.auto && !mandateUnverified;

  // ★★ THE REASON WAS COMPUTED AND THROWN AWAY. `collectionRoute` has always
  // said WHY a renewal cannot be auto-collected, `collectInvoice` returned it,
  // and `classify` collapsed all three into "manual" — no log, no metric,
  // nothing. So when an operator reprice pushed a cohort over a ceiling, the
  // only symptom was that invoices quietly stopped being paid automatically.
  if (!route.auto && !!input.charge) {
    logWarn("billing.renewal_not_auto_collectable", {
      storeId: row.storeId,
      plan,
      period,
      reason: route.reason,
      amountPaise: amountDue,
      mandateMaxPaise: mandate?.maxAmountPaise ?? null,
    });
  }

  if (justIssued?.claimed) {
    const issued = justIssued.invoice;
    logPlaceOfSupplyFallback(row.storeId, issued);

    // ★ What the LAST cycle cost, so a reprice is named rather than left for
    // the merchant to spot. Absent for cycle 1, which has no predecessor.
    const previous =
      next.seq > 1 ? await getCycleInvoice(row.storeId, next.seq - 1) : null;

    await notifyInvoiceIssued({
      storeId: row.storeId,
      plan,
      // ★★ THE ISSUED INVOICE'S OWN FIGURES, so the email's Price, GST and
      // Amount rows add up to the document it names. Equal to `amountDue`
      // today: nothing writes `billing_credits`, so nothing is ever applied
      // against an invoice.
      amountPaise: issued.totalPaise,
      tax: taxColumnsOf(issued),
      dueAt: next.start,
      invoiceRef: issued.invoiceRef,
      // ★ Autopay means the charge will ACTUALLY be taken — a gateway, a live
      // mandate, and an amount inside both its ceiling and the AFA limit. It
      // used to mean "a mandate row exists", which for every yearly subscriber
      // promised an automatic debit that could never happen.
      autopay: willAutoCollect,
      previousAmountPaise: previous?.totalPaise ?? null,
      // The previous cycle's GST, so the email can tell "GST started" from
      // "the plan price changed".
      previousTax: previous ? taxColumnsOf(previous) : null,
    });
  }

  // ★ No gateway: the invoice is issued and OPEN, and that is the whole job.
  // `manual` is the honest bucket — it already means "the merchant must pay this
  // themselves", which is exactly true here. Deliberately NOT a stub charge that
  // always fails: an unreachable provider is an UNKNOWN outcome, not a decline,
  // so every attempt would sit in reconciliation forever.
  if (!input.charge) return "manual";

  // The merchant has just been told to pay this one by hand, because the
  // gateway would not say whether the mandate still stands. No automatic try
  // on this run; a later run asks again (the retry check below).
  if (mandateUnverified) return "manual";

  // ★★ THREE AUTOMATIC TRIES, AT LEAST 24 HOURS APART, THEN THE MERCHANT PAYS
  // BY HAND (owner decision, 21 Nov 2026; the rule is `autoCollectDecision`).
  // This pass re-reads the same subscription every hour from T-4d until its
  // cycle turns or its grace ends, and a failed debit leaves the invoice
  // `open`, so without this every run started another try.
  // ★ A try is now a notified order and, a day or more later, its debit
  // (`collectInvoice`, then lib/billing/debit-pass.ts). The next try cannot
  // start until this one has failed, so for a card the tries fall about a day
  // and a half apart: T-4d, T-2.5d, T-1d, the last debit landing just after
  // the cycle turns (the invoice is `processing` then, so no grace opens on a
  // payment still in flight).
  // Asked only when the debit would really be sent; an invoice that cannot be
  // collected automatically is answered by `collectInvoice` as before.
  // ★ A count that could not be read is "leave it this run", never "no tries
  // yet".
  // ★ A TRY IS A DEBIT THAT WAS SENT (`autoCollectDecision`): an attempt
  // withdrawn before its debit is not counted at all, and one that ended
  // before its debit for another reason counts toward the backstop only.
  let startsBefore = 0;
  if (route.auto) {
    const history = await automaticAttemptsOn(invoice.id);
    if (!history) return "pending";
    const decision = autoCollectDecision({
      attempts: history.count,
      starts: history.starts,
      lastAttemptAt: history.lastAt,
      now,
    });
    // Out of tries: the invoice stays open on Plans & Billing, and the cycle
    // turn opens grace on it as for any unpaid renewal.
    if (decision === "exhausted") return "manual";
    if (decision === "wait") return "pending";
    startsBefore = history.starts;

    // ★★ A RETRY FIRST ASKS WHETHER AN EARLIER DEBIT TOOK THE MONEY AFTER ALL
    // (PR #303 review, 22 Nov 2026; lib/billing/earlier-debits.ts). A debit
    // Razorpay reported failed can be authorised late by the bank and
    // captured; starting another try then debits the same renewal twice.
    // Asked only when a debit was sent before (`history.count`), so a first
    // try costs no gateway call. Anything but a clear "nothing was paid"
    // leaves the invoice alone this run: a captured one is filed for a
    // person, an unsettled or unreadable one is asked again next hour.
    if (history.count > 0) {
      const earlier = await earlierDebitsOf({
        invoiceId: invoice.id,
        storeId: row.storeId,
        source: "collect",
        now,
      });
      if (earlier !== "clear") return "pending";
    }

    // ★★ A RETRY ASKS THE GATEWAY ABOUT THE MANDATE AGAIN. The check above
    // ran when the invoice was issued, days ago for a second or third try,
    // and a declined debit is exactly when a customer goes and cancels the
    // mandate. (On the run that issued the invoice it was asked moments ago.)
    // ★ Also the FIRST try of an invoice that was issued to pay by hand
    // because the gateway would not answer (above): it is asked again here,
    // and autopay collects only on a clear yes.
    if (!justIssued && isVerifiable(mandate)) {
      const verdict = await verifyMandate(mandate!, input.charge, now);
      if (verdict.result === "unknown") return "pending";
      if (verdict.result === "unusable") {
        // No later try can succeed. Say so once, at the moment the record
        // changed, so the merchant is not left waiting on a debit that is
        // never coming.
        if (verdict.changed) {
          await announceAutopayStopped({
            storeId: row.storeId,
            invoiceId: invoice.id,
            cause: "mandate",
            now,
          });
        }
        return "manual";
      }
      mandate = verdict.mandate;
    }
  }

  const outcome = await collectInvoice({
    invoiceId: invoice.id,
    storeId: row.storeId,
    amountDuePaise: amountDue,
    description: `${price.planLabel} ${period} renewal`,
    mandate,
    charge: input.charge,
    now,
  });

  // ★ An attempt has just failed at its first step (the gateway refused the
  // notified order). No debit was sent, so it is not one of the three tries;
  // when it is the last attempt the backstop allows, say so once, now
  // (`announceAutopayStopped` re-reads the history itself). A try that fails
  // at its debit is announced by the debit pass or by reconciliation,
  // whichever records it.
  if (
    outcome.status === "failed" &&
    startsBefore + 1 >= AUTO_COLLECT_MAX_STARTS
  ) {
    await announceAutopayStopped({
      storeId: row.storeId,
      invoiceId: invoice.id,
      now,
    });
  }

  return outcome.status === "notified" ? "notified" : classify(outcome);
}

/**
 * Tell the merchant automatic collection has given up on a renewal, and that
 * they must pay it by hand.
 *
 * ★ CALLED ONLY WHERE AN AUTOMATIC ATTEMPT IS RECORDED FAILED (this pass, for
 * a debit the gateway refused at once; reconciliation, for one that failed
 * later), so it is said once: each attempt fails exactly once. It re-reads
 * the facts itself and says nothing unless this store's subscription invoice
 * is still `open` (not paid meanwhile, no payment in flight, not closed) and
 * every automatic try is used.
 *
 * Best-effort, like every notice: it never throws, and a failure to send
 * changes nothing about the invoice, which stays payable on Plans & Billing.
 */
export async function announceAutopayStopped(input: {
  storeId: string;
  invoiceId: string;
  /**
   * `exhausted` (the default): every automatic try was used.
   * `mandate`: the mandate itself can no longer be charged (the customer
   * cancelled or paused it), so the tries left are worth nothing. The caller
   * passes this only on the call that recorded the mandate as unusable, which
   * is what keeps it to one message.
   */
  cause?: "exhausted" | "mandate";
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  try {
    const invoice = await getInvoice(input.invoiceId);
    if (!invoice || invoice.storeId !== input.storeId) return false;
    if (invoice.kind !== "subscription" || invoice.status !== "open") {
      return false;
    }

    const cause = input.cause ?? "exhausted";
    const history = await automaticAttemptsOn(input.invoiceId);
    if (!history) return false;
    // The same rule that stops the next try: three debits sent, or the
    // backstop on attempts that ended before their debit.
    if (
      cause === "exhausted" &&
      !autoCollectExhausted({ attempts: history.count, starts: history.starts })
    ) {
      return false;
    }

    const [sub] = await withService((db) =>
      db
        .select({
          plan: billingSubscriptions.plan,
          scheduledPlan: billingSubscriptions.scheduledPlan,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, input.storeId))
        .limit(1),
    );
    if (!sub) return false;

    await notifyAutopayStopped({
      storeId: input.storeId,
      // The plan the unpaid invoice is for: a change booked for the cycle end
      // is what the next cycle was priced as.
      plan: sub.scheduledPlan ?? sub.plan,
      amountPaise: invoice.totalPaise,
      tax: taxColumnsOf(invoice),
      // The cycle this invoice opens; null on a row with no period.
      dueAt: invoice.periodStart ? new Date(invoice.periodStart) : null,
      invoiceRef: invoice.invoiceRef,
      // What the email counts: every attempt that was not withdrawn.
      attempts: history.starts,
      cause,
      now,
    });
    return true;
  } catch (err) {
    logError("billing.autopay_stopped", err, {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
    });
    return false;
  }
}

/** An invoice's three tax columns, as the billing emails read them. */
function taxColumnsOf(invoice: InvoiceRow): {
  taxPaise: number;
  taxRateBps: number;
  taxInclusive: boolean;
} {
  return {
    taxPaise: invoice.taxPaise,
    taxRateBps: invoice.taxRateBps,
    taxInclusive: invoice.taxInclusive,
  };
}

/**
 * ★ A RENEWAL IS NEVER REFUSED FOR ITS PLACE OF SUPPLY, but two fallbacks are
 * worth knowing about, so they are logged once per invoice (on the run that
 * issued it; the hourly re-runs over the next four days log nothing):
 *
 * - `supplier`: no record names the merchant's state, so GST was charged as
 *   if they were in StoreMink's own state (CGST and SGST). An operator should
 *   ask the merchant to add their state under Billing details.
 * - `outside_india` while GST is charged: the merchant's billing account is
 *   outside India, so the invoice names place of supply 96 and charges IGST.
 *   New on-session payments from such a business are refused; a renewal
 *   already running is billed, never refused.
 *
 * Read from the ISSUED row: its stamp is the reading taken at issue.
 */
function logPlaceOfSupplyFallback(storeId: string, issued: InvoiceRow): void {
  if (issued.placeOfSupplyBasis === "supplier") {
    logWarn("billing.renewal_place_of_supply_fallback", {
      storeId,
      invoiceId: issued.id,
      placeOfSupply: issued.placeOfSupply,
    });
  } else if (
    issued.placeOfSupplyBasis === "outside_india" &&
    issued.taxRateBps > 0
  ) {
    logWarn("billing.renewal_outside_india", {
      storeId,
      invoiceId: issued.id,
      placeOfSupply: issued.placeOfSupply,
    });
  }
}

/**
 * ★ `not_collectable` and `already_in_flight` are NOT failures. Neither may
 * start a grace clock: the first means the merchant must pay manually (an
 * amount over the AFA limit, a revoked mandate), and the second means a charge
 * is already running. Only a gateway REJECTION is a failure.
 */
export function classify(
  outcome: CollectResult,
): "paid" | "failed" | "manual" | "pending" {
  switch (outcome.status) {
    case "paid":
      return "paid";
    case "failed":
      return "failed";
    case "not_collectable":
      return "manual";
    case "already_in_flight":
    case "pending_reconcile":
    // The notified order is in place; its debit comes a day or more later.
    case "notified":
      return "pending";
    default:
      return "pending";
  }
}

// ---------------------------------------------------------------------------
// PASS 2 — the cycle turns
// ---------------------------------------------------------------------------

export interface EvaluateSummary {
  advanced: number;
  graced: number;
  waiting: number;
  /** Subscriptions that reached the end of a cancelled cycle. */
  ended: number;
  errors: number;
  /** Set when this page was full: pass it back as `after` for the next. */
  next: PassCursor | null;
}

/**
 * At T0: advance a paid subscription into its new cycle, or start the grace
 * clock on one whose payment is known to have failed.
 *
 * ★★ AN UNRESOLVED PAYMENT IS LEFT ALONE. If the next cycle's invoice is
 * `processing` — which includes every `unknown` outcome — this does NOTHING: no
 * advance, no grace, no clock. Money may have moved and we do not yet know.
 * Starting a downgrade countdown on that is precisely what Rule 6 forbids, and
 * with the X+3 settlement window it is the ORDINARY state at the boundary, not
 * an edge case.
 */
export async function evaluateCycleTurns(
  input: {
    now?: Date;
    limit?: number;
    /**
     * Is automatic collection actually running? It changes only what the
     * overdue email SAYS — "we couldn't take payment" vs "this hasn't been
     * paid" — and defaults to FALSE because claiming an attempt that never
     * happened sends the merchant to check a card nobody charged.
     *
     * Passed in rather than read from `lib/billing/gateway.ts`, so this module
     * keeps having no opinion about the provider (the same reason `charge` is
     * injected).
     */
    autopayConfigured?: boolean;
    /** Start after this row: the `next` an earlier page returned. */
    after?: PassCursor | null;
  } = {},
): Promise<EvaluateSummary> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? RENEWAL_BATCH;
  const summary: EvaluateSummary = {
    advanced: 0,
    graced: 0,
    waiting: 0,
    ended: 0,
    errors: 0,
    next: null,
  };
  let pageEnd: PassCursor | null = null;

  // ⚠ Collected INSIDE the transaction, mailed AFTER it commits. An email is a
  // network call; sending it inside would hold a pooled connection open for the
  // length of an HTTP request, and would also announce a grace window that a
  // rollback then un-started.
  const graced: { storeId: string; plan: string; graceEndsAt: Date }[] = [];
  const ending: { storeId: string; plan: string }[] = [];
  // Plan changes made in the transaction, audited only once it has committed.
  const audit: PlanChange[] = [];
  let committed = false;

  try {
    await withService(async (db) => {
      const rows = await db
        .select({
          storeId: billingSubscriptions.storeId,
          plan: billingSubscriptions.plan,
          period: billingSubscriptions.period,
          billedLocations: billingSubscriptions.billedLocations,
          scheduledPlan: billingSubscriptions.scheduledPlan,
          scheduledPeriod: billingSubscriptions.scheduledPeriod,
          scheduledLocations: billingSubscriptions.scheduledLocations,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
        })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.state, "active"),
            isNotNull(billingSubscriptions.currentPeriodEnd),
            lte(billingSubscriptions.currentPeriodEnd, now.toISOString()),
            afterCursor(
              billingSubscriptions.currentPeriodEnd,
              billingSubscriptions.storeId,
              input.after,
            ),
          ),
        )
        // ★ Longest overdue first, in a fixed order (see PassCursor): a cycle
        // waiting on a payment still in flight stays in this set, and with no
        // order those rows could fill every page ahead of ones ready to turn.
        .orderBy(
          asc(billingSubscriptions.currentPeriodEnd),
          asc(billingSubscriptions.storeId),
        )
        .limit(limit)
        .for("update", { skipLocked: true });

      const last = rows.at(-1);
      if (rows.length >= limit && last?.currentPeriodEnd) {
        pageEnd = { at: last.currentPeriodEnd, storeId: last.storeId };
      }

      for (const row of rows) {
        // ★★ A CANCELLED SUBSCRIPTION ENDS HERE, and there is no invoice to wait
        // for — claimDue never raised one. Without this branch the merchant would
        // sit in `waiting` forever: still `active`, still entitled to a paid plan
        // they stopped paying for, and never actually cancelled.
        if (row.cancelAtPeriodEnd) {
          const ended = await endSubscription(db, {
            storeId: row.storeId,
            fromCycleSeq: row.currentCycleSeq,
            now,
            audit,
          });
          if (ended) {
            ending.push({ storeId: row.storeId, plan: row.plan });
            summary.ended += 1;
          }
          continue;
        }

        const nextSeq = row.currentCycleSeq + 1;
        const [invoice] = await db
          .select({ status: billingInvoices.status })
          .from(billingInvoices)
          .where(
            and(
              eq(billingInvoices.storeId, row.storeId),
              eq(billingInvoices.kind, "subscription"),
              eq(billingInvoices.cycleSeq, nextSeq),
            ),
          )
          .limit(1);

        // No invoice at all yet, or one still in flight: wait. Pass 1 will make
        // it, and reconciliation will settle it.
        if (
          !invoice ||
          invoice.status === "processing" ||
          invoice.status === "draft"
        ) {
          summary.waiting += 1;
          continue;
        }

        if (invoice.status === "paid") {
          await advanceCycle(db, {
            storeId: row.storeId,
            scheduled: row,
            fromCycleSeq: row.currentCycleSeq,
            fromPeriodEnd: row.currentPeriodEnd!,
            now,
            audit,
          });
          summary.advanced += 1;
          continue;
        }

        // `open` — the invoice exists, was attempted, and is not paid.
        // ★ Grace is measured from NOW, the moment we observed and can notify —
        // deliberately not from the cycle boundary. If this worker was down for
        // a day, anchoring to the boundary would silently consume the merchant's
        // notice period for an outage that was ours (Rule 6's spirit).
        const deadline = graceEndsAt(now);
        // ★ The conditional claim on `active` is what makes the notice
        // exactly-once: an hourly heartbeat re-reads these rows, so without
        // `returning()` the merchant would be warned every hour for two days.
        const claimed = await db
          .update(billingSubscriptions)
          .set({
            state: "past_due",
            graceStartedAt: now.toISOString(),
            graceEndsAt: deadline.toISOString(),
            updatedAt: now.toISOString(),
          })
          .where(
            and(
              eq(billingSubscriptions.storeId, row.storeId),
              eq(billingSubscriptions.state, "active"),
            ),
          )
          .returning({ storeId: billingSubscriptions.storeId });

        if (claimed.length === 0) continue;
        graced.push({
          storeId: row.storeId,
          plan: row.plan,
          graceEndsAt: deadline,
        });
        summary.graced += 1;
      }
    });
    committed = true;
  } catch (err) {
    logError("billing.renewal.evaluate", err);
    summary.errors += 1;
  }
  // Only a page that committed leads to the next one.
  if (committed) summary.next = pageEnd;
  if (committed) await auditPlanChanges(audit);

  // ★ A cancellation reaching its end IS a downgrade from the merchant's point of
  // view — their plan stopped and they are on Free — so it reuses that notice
  // rather than inventing a second one that says the same thing. They already
  // know they cancelled; what they need is confirmation and the way back.
  for (const e of ending) {
    await notifyDowngraded({ storeId: e.storeId, fromPlan: e.plan });
  }

  // ★ This is the LAST message that can change the outcome — 48 hours from now
  // the store loses its plan and its till. Best-effort, so a mail failure never
  // becomes a billing error.
  for (const g of graced) {
    await notifyGraceStarted({
      storeId: g.storeId,
      plan: g.plan,
      graceEndsAt: g.graceEndsAt,
      // Nothing was attempted while collection is gated, and claiming otherwise
      // sends the merchant to check a card nobody charged.
      autopayAttempted: input.autopayConfigured ?? false,
    });
  }
  return summary;
}

/**
 * Move a subscription into its next cycle.
 *
 * ★ ONE implementation, shared by the worker's evaluate pass and by manual
 * payment. A second hand-written copy would drift, and the failure mode is
 * silent: a merchant's cycle dates would depend on which route settled their
 * invoice.
 *
 * ★ Claims on the cycle it was told about, so two concurrent advances cannot
 * double-advance a subscription. Returns whether it actually moved.
 */
async function advanceCycle(
  db: Db,
  input: {
    storeId: string;
    /** The row's plan/period/scheduled fields — resolved by resolveNextCycle. */
    scheduled: ScheduledFields;
    fromCycleSeq: number;
    fromPeriodEnd: string;
    now: Date;
    /** Collects the plan change, for the caller to audit after commit. */
    audit?: PlanChange[];
  },
): Promise<boolean> {
  // ★★ ONE RESOLVER, so what was PRICED at T−4d is what is WRITTEN at T0. The
  // period matters twice over: it decides the plan amount AND the length of the
  // cycle, so a monthly→yearly switch that ignored it would give the merchant a
  // 30-day year or a 365-day month.
  const shape = resolveNextCycle(input.scheduled);
  const next = cycleFrom(
    new Date(input.fromPeriodEnd),
    shape.period,
    input.fromCycleSeq + 1,
  );
  const claimed = await db
    .update(billingSubscriptions)
    .set({
      currentCycleSeq: next.seq,
      currentPeriodStart: next.start.toISOString(),
      currentPeriodEnd: next.end.toISOString(),
      state: "active",
      graceStartedAt: null,
      graceEndsAt: null,
      // ★ EVERY BOOKED CHANGE TAKES EFFECT HERE, in the same statement that turns
      // the cycle — the merchant keeps (and keeps paying for) what they bought
      // until the period runs out, then it changes. Doing it in a second UPDATE
      // would let an interrupted run leave the plan and the cycle disagreeing.
      plan: shape.plan,
      period: shape.period,
      billedLocations: shape.billedLocations,
      scheduledPlan: null,
      scheduledPeriod: null,
      scheduledLocations: null,
      updatedAt: input.now.toISOString(),
    })
    .where(
      and(
        eq(billingSubscriptions.storeId, input.storeId),
        eq(billingSubscriptions.currentCycleSeq, input.fromCycleSeq),
      ),
    )
    .returning({ storeId: billingSubscriptions.storeId });
  if (claimed.length === 0) return false;

  // ★★ THE STORE ROW MOVES WITH THE CYCLE. Every gate reads `stores.plan`, and
  // advancing only `billing_subscriptions` left two defects: a renewal that was
  // PAID still lapsed to Free, because enrolment had stamped the first cycle's
  // end into `plan_expires_at` and nothing ever moved it; and a downgrade booked
  // for the cycle end changed what was billed but never what the store got.
  const write = await syncPaidEntitlement(
    db,
    input.storeId,
    shape.plan,
    input.now,
  );
  if (write.change) input.audit?.push(write.change);
  // ★ A booked move to a plan without Point of Sale stops the till here, so an
  // open shift is closed in the same transaction, as at a downgrade.
  if (hasPos(write.before) && !hasPos(write.after)) {
    await closeOpenShifts(db, input.storeId, input.now, BOOKED_CHANGE_NOTE);
  }
  return true;
}

/** A plan change the worker made to `stores`, audited once it has committed. */
export interface PlanChange {
  storeId: string;
  fromPlan: string;
  toPlan: string;
  note: string;
}

/** What an entitlement write did: its audit row, and the plan either side. */
export interface EntitlementWrite {
  change: PlanChange | null;
  before: Plan;
  after: Plan;
}

const ENTITLEMENT_COLUMNS = {
  plan: stores.plan,
  planSource: stores.planSource,
  planExpiresAt: stores.planExpiresAt,
  compPlan: stores.compPlan,
  compExpiresAt: stores.compExpiresAt,
};

type EntitlementRow = {
  plan: string;
  planExpiresAt: string | null;
  compPlan: string | null;
  compExpiresAt: string | null;
};

/** The plan a row entitles the store to — paid plan or comp overlay. */
function entitledTo(row: EntitlementRow, now: Date): Plan {
  return effectivePlan(
    {
      plan: row.plan,
      plan_expires_at: row.planExpiresAt,
      comp_plan: row.compPlan,
      comp_expires_at: row.compExpiresAt,
    },
    now,
  );
}

function hasPos(plan: Plan): boolean {
  return limitsFor(plan).posEnabled;
}

/**
 * Write the worker's plan changes to `plan_events`.
 *
 * ★ Its OWN transaction, after the one that changed the plan has committed
 * (the `auditEnrolment` rule): an audit failure must never undo a cycle turn
 * or a downgrade, and a rolled-back change must never be audited.
 * `source: "billing"`, never `"paid"` (§15).
 */
async function auditPlanChanges(changes: PlanChange[]): Promise<void> {
  if (changes.length === 0) return;
  try {
    await withService((db) =>
      db.insert(planEvents).values(
        changes.map((c) => ({
          storeId: c.storeId,
          fromPlan: c.fromPlan,
          toPlan: c.toPlan,
          source: "billing",
          actor: "billing-renewal",
          note: c.note,
        })),
      ),
    );
  } catch (err) {
    logError("billing.renewal.audit", err, { stores: changes.length });
  }
}

/**
 * Make `stores` carry the plan a live subscription pays for.
 *
 * ★★ `plan_expires_at` IS NULL FOR A PAID PLAN. That column is the end of an
 * operator's TIMED GRANT, and the daily plan-expiry job flips anything past it
 * to Free. A subscription's lifecycle belongs to this worker instead: the
 * cancellation turn and the post-grace downgrade both drop the plan explicitly
 * (`dropPaidEntitlement`), and a renewal still waiting on its payment keeps the
 * plan it has, which is what grace promises.
 *
 * ★ THE COMP FLOOR HOLDS (`billingMayApplyPlan`): billing may raise a plan an
 * operator granted, never lower it.
 */
export async function syncPaidEntitlement(
  db: Db,
  storeId: string,
  plan: string,
  now: Date = new Date(),
): Promise<EntitlementWrite> {
  const [store] = await db
    .select(ENTITLEMENT_COLUMNS)
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  if (!store) {
    const p = normalizePlan(plan);
    return { change: null, before: p, after: p };
  }
  const before = entitledTo(store, now);
  if (!billingMayApplyPlan(store.plan, store.planSource, plan)) {
    return { change: null, before, after: before };
  }
  await db
    .update(stores)
    .set({ plan, planSource: "paid", planExpiresAt: null })
    .where(eq(stores.id, storeId));
  return {
    change:
      store.plan === plan
        ? null
        : {
            storeId,
            fromPlan: store.plan,
            toPlan: plan,
            note: "renewal: the subscription's plan applies",
          },
    before,
    after: entitledTo({ ...store, plan, planExpiresAt: null }, now),
  };
}

/**
 * Take away the plan a subscription was paying for.
 *
 * ★ An operator's grant (`plan_source = 'comp'`) is not the subscription's to
 * take away — it is the same floor `syncPaidEntitlement` respects. `after` is
 * what the store is left with, so a caller can tell a store that still has a
 * plan (and a till) from one that is now on Free. A row it cannot read is
 * treated as landing on Free, which is what this did before it looked.
 */
async function dropPaidEntitlement(
  db: Db,
  storeId: string,
  note: string,
  now: Date,
): Promise<EntitlementWrite> {
  const [store] = await db
    .select(ENTITLEMENT_COLUMNS)
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  await db
    .update(stores)
    .set({ plan: "free", planExpiresAt: null })
    .where(and(eq(stores.id, storeId), ne(stores.planSource, "comp")));
  if (!store) return { change: null, before: "free", after: "free" };
  const before = entitledTo(store, now);
  if (store.planSource === "comp")
    return { change: null, before, after: before };
  return {
    change:
      store.plan === "free"
        ? null
        : { storeId, fromPlan: store.plan, toPlan: "free", note },
    before,
    after: entitledTo({ ...store, plan: "free", planExpiresAt: null }, now),
  };
}

/**
 * End a cancelled subscription at its period end.
 *
 * ★ A CONDITIONAL CLAIM on the cycle it was told about, so a second run — or a
 * resume racing the turn — cannot end it twice or end one that moved on.
 *
 * ★ THE PLAN IS DROPPED TO FREE IN THE SAME STATEMENT-PAIR as the state change.
 * `stores.plan` is what every gate reads, so leaving it while marking the
 * subscription `cancelled` would give away a paid plan indefinitely.
 *
 * ★★ EVERY INVOICE FOR A CYCLE THE PLAN DOES NOT REACH IS CLOSED, IN THE SAME
 * TRANSACTION (renewal-cancel, design 6.1 and 6.2, rule R3): draft, open,
 * processing or paid, each becomes `void`. An open one is then never chased, a
 * payment still in flight lands on a closed invoice, and a paid one is refunded
 * by the refund pass, which finds a captured payment on a `void` invoice.
 * Without it the merchant who cancelled could be charged, or kept, for a cycle
 * they never get.
 *
 * ★ NO STATE CONDITION in the claim, deliberately: the downgrade pass calls this
 * for a cancelling subscription in `past_due` or `grace` (design 6.2), and the
 * cancellation, not the payment, decides how it ends. `cancel_requested_at` and
 * `cancel_requested_by` are kept: they record who asked for the plan to end.
 *
 * Exported for the operator's "End the plan now" (design 6.8): same shape, same
 * claim, the caller's transaction.
 */
export async function endSubscription(
  db: Db,
  input: {
    storeId: string;
    fromCycleSeq: number;
    now: Date;
    audit?: PlanChange[];
  },
): Promise<boolean> {
  const claimed = await db
    .update(billingSubscriptions)
    .set({
      state: "cancelled",
      cancelAtPeriodEnd: false,
      // The cycle is over and there is no next one. Clearing it keeps the
      // billing_subscriptions_cycle_present CHECK satisfied, which requires a
      // cycle only for active/past_due/grace.
      currentPeriodStart: null,
      currentPeriodEnd: null,
      graceStartedAt: null,
      graceEndsAt: null,
      scheduledPlan: null,
      scheduledPeriod: null,
      scheduledLocations: null,
      updatedAt: input.now.toISOString(),
    })
    .where(
      and(
        eq(billingSubscriptions.storeId, input.storeId),
        eq(billingSubscriptions.currentCycleSeq, input.fromCycleSeq),
        eq(billingSubscriptions.cancelAtPeriodEnd, true),
      ),
    )
    .returning({ storeId: billingSubscriptions.storeId });
  if (claimed.length === 0) return false;

  // ★ After the claim (so a lost claim closes nothing) and before the plan
  // moves: subscription row first, invoice rows second, the lock order every
  // writer here keeps.
  const closed = await closeUnreachedInvoices(db, {
    storeId: input.storeId,
    lastReachedSeq: input.fromCycleSeq,
    now: input.now,
  });
  if (closed.length > 0) {
    logInfo("billing.renewal.closed_unreached", {
      storeId: input.storeId,
      lastReachedSeq: input.fromCycleSeq,
      invoices: closed.map((c) => ({
        id: c.id,
        previousStatus: c.previousStatus,
      })),
    });
  }

  const write = await dropPaidEntitlement(
    db,
    input.storeId,
    "cancellation: the paid period ended",
    input.now,
  );
  if (write.change) input.audit?.push(write.change);
  if (!hasPos(write.after)) {
    await closeOpenShifts(db, input.storeId, input.now, CANCELLED_NOTE);
  }
  return true;
}

/**
 * Advance one store immediately, because its next-cycle invoice was just paid.
 *
 * ★★ CALLED BY MANUAL PAYMENT so a merchant who pays during grace gets their
 * plan back at once. Leaving it to the hourly worker would keep someone who has
 * just paid locked out of their own till for up to an hour, while they watch the
 * screen. It re-reads and re-checks everything rather than trusting the caller —
 * the invoice really is paid, the subscription really is theirs, and the cycle
 * really has turned.
 *
 * Returns true only when a cycle actually advanced, so the caller can tell the
 * merchant something true.
 */
export async function advanceAfterPayment(
  storeId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const audit: PlanChange[] = [];
  try {
    const advanced = await withService(async (db) => {
      const [sub] = await db
        .select({
          storeId: billingSubscriptions.storeId,
          plan: billingSubscriptions.plan,
          period: billingSubscriptions.period,
          billedLocations: billingSubscriptions.billedLocations,
          // ★ The scheduled fields must come along: this path advances the cycle
          // just as the worker does, so it has to apply the same booked changes
          // or a merchant who pays during grace keeps a plan they downgraded off.
          scheduledPlan: billingSubscriptions.scheduledPlan,
          scheduledPeriod: billingSubscriptions.scheduledPeriod,
          scheduledLocations: billingSubscriptions.scheduledLocations,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          state: billingSubscriptions.state,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);

      if (!sub?.currentPeriodEnd) return false;
      // Only a subscription whose cycle has ENDED can advance. Paying an invoice
      // early — the T−4d collection window — settles it without moving the
      // cycle; the boundary is what moves it, and the worker will.
      if (new Date(sub.currentPeriodEnd).getTime() > now.getTime())
        return false;
      if (!["active", "past_due", "grace"].includes(sub.state)) return false;
      // ★★ A CANCELLING SUBSCRIPTION NEVER ENTERS ANOTHER CYCLE (rule R2). A
      // renewal payment that lands while the cancellation stands (an autopay
      // debit already under way, a checkout opened before cancelling) does not
      // restore or extend the plan: `advanceCycle` would renew a plan the
      // merchant cancelled, because it ignores `resolveNextCycle(...).ending`.
      // The plan ends as asked and the payment is refunded. Only Keep my plan
      // clears the flag, and then this advances them.
      if (sub.cancelAtPeriodEnd) return false;

      const nextSeq = sub.currentCycleSeq + 1;
      const [invoice] = await db
        .select({ status: billingInvoices.status })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.storeId, storeId),
            eq(billingInvoices.kind, "subscription"),
            eq(billingInvoices.cycleSeq, nextSeq),
          ),
        )
        .limit(1);
      if (invoice?.status !== "paid") return false;

      return advanceCycle(db, {
        storeId,
        scheduled: sub,
        fromCycleSeq: sub.currentCycleSeq,
        fromPeriodEnd: sub.currentPeriodEnd,
        now,
        audit,
      });
    });
    await auditPlanChanges(audit);
    return advanced;
  } catch (err) {
    logError("billing.advance_after_payment", err, { storeId });
    return false;
  }
}

// ---------------------------------------------------------------------------
// PASS 3 — the downgrade
// ---------------------------------------------------------------------------

export interface DowngradeSummary {
  downgraded: number;
  shiftsClosed: number;
  /** Cancelling subscriptions whose grace ran out: ended as `cancelled` by
   *  `endSubscription`, never downgraded for non-payment. */
  ended: number;
  /** Refused downgrades whose renewal turned out to be paid: advanced by the
   *  safety net instead of being left in grace. */
  advancedAfterGrace: number;
  errors: number;
  /** Set when this page was full: pass it back as `after` for the next. */
  next: PassCursor | null;
}

/**
 * Downgrade every subscription whose grace has run out.
 *
 * ★ The decision is `billing_claim_downgrade()` — ONE statement that re-checks
 * state, deadline, comp exemption AND whether the invoice was paid, so a
 * payment racing the worker, a payment at the exact boundary, and the job
 * running twice all resolve with no lock and no read-then-write window.
 *
 * ★★ A CANCELLING SUBSCRIPTION IS NOT DOWNGRADED, IT IS ENDED (renewal-cancel,
 * design 6.2, rules R2 and R3). It goes through `endSubscription`, never the
 * downgrade claim: the claim refuses a next invoice that is paid or processing,
 * which would leave a merchant who cancelled stuck in grace on a plan they
 * stopped, and it would mark an open invoice `uncollectible` where a plan end
 * closes it `void`. The cancellation decides; a payment that landed meanwhile
 * is refunded.
 *
 * ★★ THE SAFETY NET. When the claim refuses a subscription that is not
 * cancelling, `advanceAfterPayment` is tried after that transaction: it
 * advances only when the next invoice is already paid (a processing one keeps
 * waiting, an open one is left to the claim). Without it a renewal paid during
 * grace whose advance failed, or a resume that raced, would leave the store on
 * its paid plan in `past_due` for ever, since evaluate reads only `active` rows
 * and nothing else would ever move it.
 */
export async function downgradeExpired(
  input: {
    now?: Date;
    limit?: number;
    /** Start after this row: the `next` an earlier page returned. */
    after?: PassCursor | null;
  } = {},
): Promise<DowngradeSummary> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? RENEWAL_BATCH;
  const summary: DowngradeSummary = {
    downgraded: 0,
    shiftsClosed: 0,
    ended: 0,
    advancedAfterGrace: 0,
    errors: 0,
    next: null,
  };

  // ★ The PLAN is read here, before the claim — `billing_claim_downgrade()`
  // sets it to free, so afterwards there is no way to tell the merchant what
  // they lost. "Your Pro plan has ended" and "your plan has ended" are not the
  // same message. The cancel flag and the cycle come along: they decide which
  // way the subscription ends, and `endSubscription` claims on the cycle.
  let candidates: {
    storeId: string;
    plan: string;
    cancelAtPeriodEnd: boolean;
    currentCycleSeq: number;
    graceEndsAt: string | null;
  }[] = [];
  try {
    candidates = await withService(async (db) => {
      const rows = await db
        .select({
          storeId: billingSubscriptions.storeId,
          plan: billingSubscriptions.plan,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          graceEndsAt: billingSubscriptions.graceEndsAt,
        })
        .from(billingSubscriptions)
        .where(
          and(
            inArray(billingSubscriptions.state, ["past_due", "grace"]),
            isNotNull(billingSubscriptions.graceEndsAt),
            lte(billingSubscriptions.graceEndsAt, now.toISOString()),
            afterCursor(
              billingSubscriptions.graceEndsAt,
              billingSubscriptions.storeId,
              input.after,
            ),
          ),
        )
        // ★ Longest expired first, in a fixed order (see PassCursor): a
        // subscription whose payment is still in flight is refused by the
        // claim and stays in this set.
        .orderBy(
          asc(billingSubscriptions.graceEndsAt),
          asc(billingSubscriptions.storeId),
        )
        .limit(limit);
      return rows;
    });
    const last = candidates.at(-1);
    if (candidates.length >= limit && last?.graceEndsAt) {
      summary.next = { at: last.graceEndsAt, storeId: last.storeId };
    }
  } catch (err) {
    logError("billing.renewal.downgrade_scan", err);
    summary.errors += 1;
    return summary;
  }

  for (const {
    storeId,
    plan,
    cancelAtPeriodEnd,
    currentCycleSeq,
  } of candidates) {
    if (cancelAtPeriodEnd) {
      // ★★ ENDED, NOT DOWNGRADED: state `cancelled`, the flag and the grace
      // fields cleared, the plan dropped, an open POS shift closed when POS
      // stops, and every invoice above the cycle closed `void` (whether open,
      // processing or paid), all in this one per-store transaction.
      try {
        const audit: PlanChange[] = [];
        const ended = await withService((db) =>
          endSubscription(db, {
            storeId,
            fromCycleSeq: currentCycleSeq,
            now,
            audit,
          }),
        );
        if (ended) {
          summary.ended += 1;
          logInfo("billing.renewal.cancelled_at_grace_end", { storeId });
          await auditPlanChanges(audit);
          // ★ As for any plan end by cancellation (the cycle-turn path): the
          // merchant is told the plan stopped and how to come back. AFTER the
          // transaction commits, so a rollback never announces an end.
          await notifyDowngraded({ storeId, fromPlan: plan });
        }
      } catch (err) {
        logError("billing.renewal.end_cancelled", err, { storeId });
        summary.errors += 1;
      }
      continue;
    }

    try {
      const claimed = await withService(async (db) => {
        const res = await db.execute(
          sql`select billing_claim_downgrade(${storeId}::uuid, ${now.toISOString()}::timestamptz) as ok`,
        );
        const ok = (res.rows?.[0] as { ok?: boolean } | undefined)?.ok === true;
        if (!ok) return null;

        // ★★ THE STORE LOSES THE PLAN HERE. The claim only moves
        // `billing_subscriptions`; it used to be `plan_expires_at` (the first
        // cycle's end, never extended) that actually took the plan away — from
        // payers and non-payers alike. Paid plans now carry no expiry, so this
        // is the one place a non-payer is downgraded.
        const write = await dropPaidEntitlement(
          db,
          storeId,
          "renewal: unpaid when grace ended",
          now,
        );
        // ★ SAME TRANSACTION as the downgrade. posEnabled goes false, so the
        // till stops; an open shift holds uncounted cash and leaving it open
        // strands the drawer with no way to reconcile it (owner, 2026-08-11).
        // ★ Only when the till really stops: an operator's comp (on `plan` or
        // as an overlay) keeps the store's plan, and its drawer stays open.
        const closesTill = !hasPos(write.after);
        if (closesTill) {
          await closeOpenShifts(db, storeId, now, NON_PAYMENT_NOTE);
        }
        return { write, closesTill };
      });

      if (claimed) {
        summary.downgraded += 1;
        if (claimed.closesTill) summary.shiftsClosed += 1;
        logInfo("billing.downgraded", { storeId });
        if (claimed.write.change)
          await auditPlanChanges([claimed.write.change]);
        // ★ The claim is exactly-once, so this mails once. AFTER the
        // transaction commits — an email is a network call, and announcing a
        // downgrade a rollback then undid would be worse than saying nothing.
        // ★ And only to a store that is really on Free now: the notice says
        // "Current plan: Free", which is false for a store an operator comped.
        if (claimed.write.after === "free") {
          await notifyDowngraded({ storeId, fromPlan: plan });
        }
        continue;
      }
    } catch (err) {
      logError("billing.renewal.downgrade", err, { storeId });
      summary.errors += 1;
      continue;
    }

    // ★★ THE CLAIM REFUSED: the renewal may have been paid. AFTER the claim's
    // transaction, never inside it: `advanceAfterPayment` opens its own, re-reads
    // everything and advances only a paid next invoice, so a refusal for any
    // other reason (a processing payment, a claim another run already won)
    // changes nothing here. It never throws.
    if (await advanceAfterPayment(storeId, now)) {
      summary.advancedAfterGrace += 1;
      logInfo("billing.renewal.advanced_after_grace", { storeId });
    }
  }
  return summary;
}

/**
 * Force-close any open till for a store being downgraded.
 *
 * ★ `counted = expected`, so the variance is ZERO. A billing event must not
 * invent a discrepancy — a variance is read as a cashier being short, and
 * nobody counted this drawer. The note says who closed it and why, so the
 * Z-report explains itself.
 */
const NON_PAYMENT_NOTE =
  "Closed automatically: the store was downgraded to the Free plan for non-payment, which turns off POS. Cash was not counted, so this shift records no variance.";
const BOOKED_CHANGE_NOTE =
  "Closed automatically: at its renewal the store moved to a plan without POS, as booked. Cash was not counted, so this shift records no variance.";
const CANCELLED_NOTE =
  "Closed automatically: the store's cancelled subscription ended, which turns off POS. Cash was not counted, so this shift records no variance.";

async function closeOpenShifts(
  db: Db,
  storeId: string,
  now: Date,
  note: string,
) {
  await db
    .update(posShifts)
    .set({
      status: "closed",
      closedAt: now.toISOString(),
      closedBy: null,
      closedByName: "System",
      countedCash: sql`coalesce(${posShifts.expectedCash}, 0)`,
      variance: 0,
      note,
    })
    .where(and(eq(posShifts.storeId, storeId), eq(posShifts.status, "open")));
}
