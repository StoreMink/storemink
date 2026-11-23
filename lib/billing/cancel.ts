import "server-only";

/**
 * Cancelling — and un-cancelling — a subscription (§34).
 *
 * ★★ CANCELLING IS A FLAG, NOT A GATEWAY CALL. The old path asked Razorpay to
 * cancel the Subscription, which meant it could fail for reasons that had nothing
 * to do with the merchant's intent — the commonest being _"Subscription cannot be
 * cancelled since no billing cycle is going on"_, which hit anyone cancelling
 * between authorising the mandate and the first charge and left them with no way
 * forward. Here the amount and the schedule are ours, so cancelling is
 * `cancel_at_period_end = true` and cannot fail for a provider's reasons.
 *
 * ★ THEY KEEP WHAT THEY PAID FOR. The plan runs to `current_period_end`, then
 * `evaluateCycleTurns` ends it — which is also why `claimDue` skips a cancelled
 * subscription: no invoice is raised for a cycle that will not happen, so nothing
 * can go unpaid, start a grace clock, or chase them for money.
 *
 * ★ THE MANDATE IS REVOKED IMMEDIATELY, and that is deliberate even though the
 * flag alone would stop the next charge. A live mandate is standing permission to
 * debit a card; someone who has cancelled has withdrawn it, and leaving it active
 * so that "it doesn't matter, nothing will charge it" is exactly the reasoning
 * that turns one bug into a debit.
 *
 * ★ RESUMING IS FREE, and worth having: the old flow could not offer it (the
 * gateway subscription was gone), so a merchant who changed their mind had to
 * re-authorise. Here it is clearing a flag — before the cycle ends, nothing has
 * happened yet. ⚠ It does NOT restore the mandate: that permission was withdrawn
 * and only the merchant can give it again.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  billingInvoices,
  billingMandates,
  billingSubscriptions,
} from "@/drizzle/schema";
import { logError, logInfo } from "@/lib/observability/logger";
import { withdrawUnsentDebits } from "./collect";
import type { NextInvoiceView, SubscriptionView } from "./invoice-types";
import { AFA_EXEMPT_PAISE } from "./mandate-types";
import { notifySubscriptionCancelled } from "./receipts";
import { advanceAfterPayment } from "./renewal-worker";

export type CancelResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** States in which there is something to cancel. */
const LIVE_STATES = ["active", "past_due", "grace"];

export interface Cancelled {
  /** When the plan actually stops. Null when no cycle was ever paid for. */
  accessUntil: string | null;
  /** True when autopay permission was withdrawn as part of this. */
  mandateRevoked: boolean;
  /** The subscription's state when it was cancelled: `active`, or `past_due`
   *  or `grace`, in which case the plan ends when grace ends. */
  state: string;
  /** When grace ends, for a subscription cancelled in grace; else null. */
  graceEndsAt: string | null;
  /** The next cycle's invoice at that moment, if one exists: whether it is
   *  open, paid or has a payment in flight decides what the merchant is told. */
  nextInvoice: NextInvoiceView | null;
}

/** What Keep my plan did, so the action can say something true (Table B). */
export interface Resumed {
  /** False until the merchant authorises a new mandate (it was revoked). */
  autopay: boolean;
  /** True when the cycle advanced at once: the renewal was already paid while
   *  the cancellation stood, and the cycle had ended. */
  advanced: boolean;
  /** The state the subscription was resumed in, before any advance. */
  state: string;
  /** When grace ends, for a subscription resumed in grace; else null. */
  graceEndsAt: string | null;
  /** The end of the current cycle, as it stood when resumed. */
  currentEnd: string | null;
  /** The next cycle's invoice, as it stood when resumed. */
  nextInvoice: NextInvoiceView | null;
}

/**
 * `cancel_requested_by` as stored: "merchant:<user id>" or "operator:<email>".
 * A blank value is stored as null (the column's CHECK refuses a blank one).
 */
function storedRequester(
  requestedBy: string | null | undefined,
): string | null {
  const value = typeof requestedBy === "string" ? requestedBy.trim() : "";
  return value.length > 0 ? value : null;
}

/** Who asked, by kind only, for screens and logs (never the id or email). */
function requesterKind(
  requestedBy: string | null | undefined,
): "merchant" | "operator" | null {
  const value = storedRequester(requestedBy);
  if (!value) return null;
  return value.startsWith("operator") ? "operator" : "merchant";
}

/**
 * The next cycle's subscription invoice (`cycle_seq = current + 1`), with
 * whether a payment on it is still in flight: an attempt that is `created`,
 * `processing`, `authorized` or `unknown`, in which money may still land.
 *
 * ★★ A SCHEDULED AUTOMATIC DEBIT IS NOT A PAYMENT IN FLIGHT (21 Nov 2026).
 * An automatic renewal is a notified order and, a day or more later, its
 * debit. Until the debit is sent (`debit_sent_at` is null) no money can move,
 * and cancelling withdraws it. So an invoice that is `processing` only for
 * such an attempt reads here as `open` with nothing in flight: "your renewal
 * invoice won't be charged" is the true sentence, where "a payment is under
 * way and can't be stopped" was not.
 *
 * ⚠ The correlated subquery names the outer table BY HAND
 * (`"billing_invoices"."id"`): Drizzle writes a select list's columns without
 * their table, so `${billingInvoices.id}` would render as a bare `"id"` and
 * resolve to the ATTEMPT's id inside the subquery, matching nothing.
 */
async function readNextInvoice(
  db: Db,
  storeId: string,
  currentCycleSeq: number,
): Promise<NextInvoiceView | null> {
  const [row] = await db
    .select({
      id: billingInvoices.id,
      status: billingInvoices.status,
      totalPaise: billingInvoices.totalPaise,
      invoiceRef: billingInvoices.invoiceRef,
      inFlight: sql<boolean>`exists (
        select 1 from public.billing_payment_attempts a
         where a.invoice_id = "billing_invoices"."id"
           and a.state in ('created', 'processing', 'authorized', 'unknown')
           and not (a.mode = 'automatic'
                    and a.state = 'processing'
                    and a.debit_after is not null
                    and a.debit_sent_at is null))`,
      scheduled: sql<boolean>`exists (
        select 1 from public.billing_payment_attempts a
         where a.invoice_id = "billing_invoices"."id"
           and a.mode = 'automatic'
           and a.state = 'processing'
           and a.debit_after is not null
           and a.debit_sent_at is null)`,
    })
    .from(billingInvoices)
    .where(
      and(
        eq(billingInvoices.storeId, storeId),
        eq(billingInvoices.kind, "subscription"),
        eq(billingInvoices.cycleSeq, currentCycleSeq + 1),
      ),
    )
    .limit(1);
  if (!row) return null;
  const inFlight = row.inFlight === true;
  return {
    id: row.id,
    status:
      row.status === "processing" && !inFlight && row.scheduled === true
        ? "open"
        : row.status,
    totalPaise: Number(row.totalPaise),
    invoiceRef: row.invoiceRef ?? null,
    inFlight,
  };
}

/**
 * Stop future charges, keeping the plan until the paid period ends.
 *
 * ★ A CONDITIONAL CLAIM, so a double-click cancels once and a subscription that
 * moved on in between is not silently re-cancelled.
 *
 * ★★ NEVER REFUSED FOR TIMING (renewal-cancel, rule R1). Cancelling a day
 * before the renewal, with its invoice already issued or even paid, is allowed:
 * the plan ends when the cycle ends (or when grace ends, for a merchant who
 * cancels in grace), the unpaid invoice is closed then, and a renewal payment
 * already taken is refunded. Nothing here checks a window.
 *
 * ★ WHO ASKED, AND WHEN, is recorded with the claim (`cancel_requested_by`,
 * `cancel_requested_at`): "merchant:<user id>" from the dashboard,
 * "operator:<email>" from the console. It stays on the row after the plan ends;
 * only Keep my plan clears it.
 *
 * ★ The facts the merchant is told come from the SAME transaction as the
 * claim: the state and grace end the claim returned, and the next cycle's
 * invoice read right after it.
 */
export async function cancelAtPeriodEnd(input: {
  storeId: string;
  now?: Date;
  /** "merchant:<user id>" or "operator:<email>". Blank is stored as null. */
  requestedBy?: string | null;
}): Promise<CancelResult<Cancelled>> {
  const now = input.now ?? new Date();
  const requestedBy = storedRequester(input.requestedBy);

  let sub:
    | {
        plan: string;
        state: string;
        currentPeriodEnd: string | null;
        cancelAtPeriodEnd: boolean;
        mandateId: string | null;
      }
    | null
    | undefined;
  try {
    sub = await withService(async (db) => {
      const [row] = await db
        .select({
          // Named so the confirmation can say WHICH plan is ending.
          plan: billingSubscriptions.plan,
          state: billingSubscriptions.state,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          mandateId: billingSubscriptions.mandateId,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, input.storeId))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.cancel.load", err, { storeId: input.storeId });
    return { ok: false, error: "Couldn't read your subscription. Try again." };
  }

  if (!sub || !LIVE_STATES.includes(sub.state)) {
    return { ok: false, error: "You don't have an active subscription." };
  }
  if (sub.cancelAtPeriodEnd) {
    return { ok: false, error: "Your subscription is already cancelling." };
  }

  let claimed: {
    state: string;
    graceEndsAt: string | null;
    currentPeriodEnd: string | null;
    nextInvoice: NextInvoiceView | null;
  } | null = null;
  try {
    claimed = await withService(async (db) => {
      const rows = await db
        .update(billingSubscriptions)
        .set({
          cancelAtPeriodEnd: true,
          // A booked change is moot once they are leaving, and leaving it set
          // would have `resolveNextCycle` disagree with itself if they resumed.
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          cancelRequestedAt: now.toISOString(),
          cancelRequestedBy: requestedBy,
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(billingSubscriptions.storeId, input.storeId),
            eq(billingSubscriptions.cancelAtPeriodEnd, false),
            // ★ Live at the moment of the claim, not only at the read above: a
            // plan that ended in between has nothing left to cancel.
            inArray(billingSubscriptions.state, LIVE_STATES),
          ),
        )
        .returning({
          state: billingSubscriptions.state,
          graceEndsAt: billingSubscriptions.graceEndsAt,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
        });
      const row = rows[0];
      if (!row) return null;
      return {
        state: row.state,
        graceEndsAt: row.graceEndsAt ?? null,
        currentPeriodEnd: row.currentPeriodEnd ?? null,
        nextInvoice: await readNextInvoice(
          db,
          input.storeId,
          row.currentCycleSeq,
        ),
      };
    });
  } catch (err) {
    logError("billing.cancel.claim", err, { storeId: input.storeId });
    return {
      ok: false,
      error: "Couldn't cancel your subscription. Try again.",
    };
  }
  if (!claimed) {
    return { ok: false, error: "Your subscription is already cancelling." };
  }

  // ★ Best-effort, and AFTER the claim. Withdrawing the standing permission is
  // the right thing to do, but failing to would not let a charge through — the
  // flag already stopped the next invoice — so it must not fail the cancel the
  // merchant asked for.
  const mandateRevoked = sub.mandateId
    ? await revokeMandate(sub.mandateId, now)
    : false;

  // ★★ WITHDRAW THE RENEWAL'S SCHEDULED DEBIT NOW (21 Nov 2026). A renewal
  // whose bank notice has gone out waits a day or more for its debit; the
  // merchant has just been told that invoice won't be charged. The debit pass
  // would refuse it anyway (it re-reads the cancellation, the invoice and the
  // mandate before every debit), so this is not what makes that true: it makes
  // the invoice read as unpaid from this moment. Best-effort for that reason.
  // A debit already sent is left alone, and is refunded if it completes.
  if (claimed.nextInvoice) {
    await withdrawUnsentDebits({
      invoiceId: claimed.nextInvoice.id,
      code: "plan_cancelled",
      reason: "the plan was cancelled before the debit",
      now,
    });
  }

  logInfo("billing.cancelled", {
    storeId: input.storeId,
    state: claimed.state,
    requestedBy: requesterKind(requestedBy),
  });

  // ★ Confirm it. A cancellation with no acknowledgement leaves the merchant
  // unsure whether it took — and the one thing they want to know is what they
  // keep, and until when. Best-effort: the cancellation is already committed.
  // ★ With the facts of the claim: in grace the plan ends when grace ends, and
  // a renewal invoice that is open, paid or has a payment under way each get
  // their own sentence; who asked decides how the email opens.
  await notifySubscriptionCancelled({
    storeId: input.storeId,
    plan: sub.plan,
    accessUntil: claimed.currentPeriodEnd,
    state: claimed.state,
    graceEndsAt: claimed.graceEndsAt,
    nextInvoice: claimed.nextInvoice,
    requestedBy,
  });

  return {
    ok: true,
    data: {
      accessUntil: claimed.currentPeriodEnd,
      mandateRevoked,
      state: claimed.state,
      graceEndsAt: claimed.graceEndsAt,
      nextInvoice: claimed.nextInvoice,
    },
  };
}

/**
 * Change their mind, before the cycle ends.
 *
 * ⚠ Does NOT restore autopay. The mandate was revoked, and only the merchant can
 * authorise a new one — so a resumed subscription renews by manual payment until
 * they do. Saying otherwise would have them expect a charge that never comes and
 * be downgraded for it.
 *
 * ★★ ALLOWED IN GRACE TOO (renewal-cancel, rule R2 and decision D4): a
 * merchant who cancelled while `past_due` or `grace` may keep their plan before
 * grace ends, on the same terms as before (pay, or be downgraded). The request
 * columns are cleared with the flag: no cancellation stands any more.
 *
 * ★★ THEN THE CYCLE MAY ADVANCE AT ONCE. A renewal paid while the cancellation
 * stood (an autopay debit already under way, a checkout opened before
 * cancelling) could not advance the plan: `advanceAfterPayment` refuses a
 * cancelling subscription. Once the flag is clear it can, so it is called
 * AFTER the claim commits: it advances only when the cycle has ended and the
 * next invoice is paid, and returns false otherwise (before the cycle end the
 * turn happens at T0 as usual). If that advance ever fails, the store keeps
 * its plan through grace and the downgrade pass's safety net advances it.
 */
export async function resumeSubscription(input: {
  storeId: string;
  now?: Date;
  /** "merchant:<user id>" or "operator:<email>": logged by kind only. */
  requestedBy?: string | null;
}): Promise<CancelResult<Resumed>> {
  const now = input.now ?? new Date();
  let claimed: {
    mandateId: string | null;
    state: string;
    graceEndsAt: string | null;
    currentPeriodEnd: string | null;
    nextInvoice: NextInvoiceView | null;
  } | null = null;
  try {
    claimed = await withService(async (db) => {
      const rows = await db
        .update(billingSubscriptions)
        .set({
          cancelAtPeriodEnd: false,
          cancelRequestedAt: null,
          cancelRequestedBy: null,
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(billingSubscriptions.storeId, input.storeId),
            eq(billingSubscriptions.cancelAtPeriodEnd, true),
            // ★ Only a subscription that has not yet ENDED can resume: active,
            // or past_due/grace before grace ends. Once `endSubscription` has
            // run the state is `cancelled` and the cycle is gone; flipping the
            // flag back would leave a paid state with no period, which the
            // cycle_present CHECK forbids, and would claim to restore a plan
            // that was already taken away. Pinned by rendering this WHERE with
            // the real dialect (cancel.test.ts), since the db mock does not
            // evaluate it.
            inArray(billingSubscriptions.state, LIVE_STATES),
          ),
        )
        .returning({
          mandateId: billingSubscriptions.mandateId,
          state: billingSubscriptions.state,
          graceEndsAt: billingSubscriptions.graceEndsAt,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
        });
      const row = rows[0];
      if (!row) return null;
      return {
        mandateId: row.mandateId ?? null,
        state: row.state,
        graceEndsAt: row.graceEndsAt ?? null,
        currentPeriodEnd: row.currentPeriodEnd ?? null,
        nextInvoice: await readNextInvoice(
          db,
          input.storeId,
          row.currentCycleSeq,
        ),
      };
    });
  } catch (err) {
    logError("billing.resume", err, { storeId: input.storeId });
    return {
      ok: false,
      error: "Couldn't resume your subscription. Try again.",
    };
  }
  if (!claimed) {
    return {
      ok: false,
      error:
        "That subscription can't be resumed. Subscribe again to start a new cycle.",
    };
  }

  // ★ AFTER the claim's transaction: `advanceAfterPayment` opens its own,
  // re-reads everything and never throws. While the flag was set it refused;
  // now it advances a renewal that was paid during grace.
  const advanced = await advanceAfterPayment(input.storeId, now);
  logInfo("billing.resumed", {
    storeId: input.storeId,
    state: claimed.state,
    advanced,
    requestedBy: requesterKind(input.requestedBy),
  });

  // The mandate was revoked on cancel, so autopay is off until they
  // re-authorise. Reported rather than assumed.
  const autopay = await mandateIsActive(claimed.mandateId);
  return {
    ok: true,
    data: {
      autopay,
      advanced,
      state: claimed.state,
      graceEndsAt: claimed.graceEndsAt,
      currentEnd: claimed.currentPeriodEnd,
      nextInvoice: claimed.nextInvoice,
    },
  };
}

async function revokeMandate(mandateId: string, now: Date): Promise<boolean> {
  try {
    const rows = await withService(async (db) =>
      db
        .update(billingMandates)
        .set({ status: "revoked", updatedAt: now.toISOString() })
        .where(
          and(
            eq(billingMandates.id, mandateId),
            eq(billingMandates.status, "active"),
          ),
        )
        .returning({ id: billingMandates.id }),
    );
    return rows.length > 0;
  } catch (err) {
    logError("billing.cancel.revoke_mandate", err, { mandateId });
    return false;
  }
}

async function mandateIsActive(mandateId: string | null): Promise<boolean> {
  if (!mandateId) return false;
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({ id: billingMandates.id })
        .from(billingMandates)
        .where(
          and(
            eq(billingMandates.id, mandateId),
            eq(billingMandates.status, "active"),
          ),
        )
        .limit(1);
      return !!row;
    });
  } catch {
    // Reporting "no autopay" when we cannot tell is the safe direction: the
    // merchant is told to expect a manual renewal, and a real mandate charging
    // them is a pleasant surprise rather than a missed payment.
    return false;
  }
}

/**
 * The subscription as the plans page shows it.
 *
 * ★ Returns a NEUTRAL view on a read failure rather than throwing: the page also
 * renders AI usage and the plan list, and a billing hiccup should cost the
 * subscription card, not the whole page. `active: false` hides the cancel and
 * change controls, which is the safe direction — a control that cannot work is
 * worse than an absent one.
 */
export async function getSubscriptionView(
  storeId: string,
): Promise<SubscriptionView> {
  const empty: SubscriptionView = {
    plan: null,
    period: null,
    status: null,
    currentEnd: null,
    cancelAtPeriodEnd: false,
    scheduledPlan: null,
    scheduledPeriod: null,
    scheduledLocations: null,
    autopay: false,
    active: false,
    nextInvoice: null,
    graceEndsAt: null,
    cancelRequestedBy: null,
    cancelRequestedAt: null,
  };
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          plan: billingSubscriptions.plan,
          period: billingSubscriptions.period,
          state: billingSubscriptions.state,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          graceEndsAt: billingSubscriptions.graceEndsAt,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          cancelRequestedAt: billingSubscriptions.cancelRequestedAt,
          cancelRequestedBy: billingSubscriptions.cancelRequestedBy,
          scheduledPlan: billingSubscriptions.scheduledPlan,
          scheduledPeriod: billingSubscriptions.scheduledPeriod,
          scheduledLocations: billingSubscriptions.scheduledLocations,
          mandateId: billingSubscriptions.mandateId,
          mandateStatus: billingMandates.status,
          mandateMaxPaise: billingMandates.maxAmountPaise,
        })
        .from(billingSubscriptions)
        .leftJoin(
          billingMandates,
          eq(billingMandates.id, billingSubscriptions.mandateId),
        )
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      if (!row) return empty;
      const live = LIVE_STATES.includes(row.state);
      // ★ Only a LIVE subscription has a next cycle to speak of: an ended one
      // will never enter it, and its leftover invoice is not the merchant's to
      // pay or to be told about here.
      const nextInvoice = live
        ? await readNextInvoice(db, storeId, row.currentCycleSeq)
        : null;
      return {
        plan: row.plan,
        period: row.period === "yearly" ? "yearly" : "monthly",
        status: row.state,
        currentEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        scheduledPlan: row.scheduledPlan,
        scheduledPeriod:
          row.scheduledPeriod === "yearly"
            ? "yearly"
            : row.scheduledPeriod === "monthly"
              ? "monthly"
              : null,
        scheduledLocations: row.scheduledLocations,
        // ★★ AUTOPAY MEANS THE RENEWAL WILL ACTUALLY BE TAKEN, not that a
        // mandate row exists. Read the other way, every yearly subscriber saw
        // autopay ON while `collectionRoute` sent each renewal to manual — the
        // Plans page contradicting the invoice email, and the merchant trusting
        // the reassuring one. The amount is not known here, so this answers the
        // half that IS: a live mandate whose own ceiling is inside the AFA
        // limit can carry SOME charge automatically. A ceiling above it can
        // never carry one at all, because the limit binds first.
        autopay:
          row.mandateStatus === "active" &&
          (row.mandateMaxPaise ?? 0) > 0 &&
          (row.mandateMaxPaise ?? 0) <= AFA_EXEMPT_PAISE,
        active: live,
        nextInvoice,
        // Grace has an end only while the subscription is in it.
        graceEndsAt:
          row.state === "past_due" || row.state === "grace"
            ? (row.graceEndsAt ?? null)
            : null,
        // ★ By kind only: the id or email of who asked never reaches the page.
        // Kept after the plan ends (it records who asked for it to end).
        cancelRequestedBy: requesterKind(row.cancelRequestedBy),
        cancelRequestedAt: row.cancelRequestedAt ?? null,
      } satisfies SubscriptionView;
    });
  } catch (err) {
    logError("billing.subscription_view", err, { storeId });
    return empty;
  }
}
