import "server-only";

/**
 * Moving between plans and billing periods, on the new billing system (§34).
 *
 * ★★ THE DIRECTION DECIDES THE TIMING, NOT THE MERCHANT. Dearer applies NOW and
 * is paid for now; cheaper or equal waits for the end of the cycle they already
 * paid for. That is the §15b rule and its point is that **nobody is ever
 * refunded** — which keeps refunds, partial reversals and their disputes out of
 * the system. "Apply now" on a downgrade is the option that looks generous and
 * creates a refund.
 *
 * ★ IT COMPARES AMOUNTS, NOT TIERS. Rank would read monthly→yearly as "no
 * change" while the charge is ten times bigger, and would miss that a tier
 * downgrade can still be a price INCREASE for a merchant grandfathered on an
 * older price. `decidePlanChange` does that comparison and is shared with the old
 * path's tests, so the rule is proved once.
 *
 * ★ PERIOD CHANGES ARE FIRST-CLASS. They were impossible on the old path for a
 * mechanical reason — `scheduled_plan` cannot express "same tier, different
 * period" — and the schema carries `scheduled_period` precisely so it can.
 *
 * ★★ AND THE PRORATION USES THE SAME MACHINERY AS A LOCATION PURCHASE: an `addon`
 * invoice paid on session. One payment shape for every mid-cycle charge means one
 * place where money can go wrong, not three.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  billingInvoices,
  billingPaymentAttempts,
  billingSubscriptions,
  stores,
} from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  rzpCreateOrder,
  rzpFetchOrderPayments,
  verifyCapturedCheckoutPayment,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";
import {
  billingMayApplyPlan,
  decidePlanChange,
} from "@/lib/payments/plan-change";
import { PLAN_META, limitsFor, normalizePlan, type Plan } from "@/lib/plans";
import {
  subscriptionTotalPaise,
  type BillingPeriod,
  type LocationPrice,
} from "@/lib/plans/location-billing";
import { PERIOD_DAYS } from "./cycle";
import { buildAddonInvoice, prorationPaise } from "./invoice";
import {
  amountDueForInvoice,
  createAddonInvoice,
  finalizeInvoice,
  getInvoice,
} from "./invoice-store";
import { paymentCapturedAt, readTaxForPayment } from "./payment-tax";
import {
  beginAttempt,
  capturedDraftPurchases,
  fileRecoveredPurchase,
  readAddonOrderTarget,
  settleAttempt,
  verifyRecoveredCapture,
  type PurchaseCompletion,
} from "./collect";

export type PlanChangeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const LIVE_STATES = ["active", "past_due", "grace"];

/** A repeated plan change whose earlier, already paid change could not be finished yet. */
export const PLAN_CHANGE_RECOVERY_WAITING_MESSAGE =
  "Your earlier payment went through, and we'll switch your plan shortly. Please don't pay again. If it hasn't changed within a day, write to support@storemink.com.";

/** A confirm whose payment is in but whose plan could not be switched yet. */
export const PLAN_CHANGE_PAID_NOT_SWITCHED_MESSAGE =
  "Your payment went through, and we'll switch your plan shortly. Please don't pay again. If it hasn't changed within a day, write to support@storemink.com.";

export interface PlanChangeStart {
  /** Present when a payment is needed. Absent when the change was scheduled. */
  payment?: {
    invoiceId: string;
    providerOrderId: string;
    keyId: string;
    amountPaise: number;
  };
  /** True when it took effect (or will) without a payment. */
  scheduled: boolean;
  /** When a scheduled change lands. */
  effectiveAt: string | null;
  plan: Plan;
  period: BillingPeriod;
  /**
   * True when starting found an EARLIER plan change whose payment was already
   * captured (the merchant closed the tab before the confirm) and finished it
   * instead of opening a second payment (RC-F1b). `plan` and `period` are then
   * the ones that payment bought.
   */
  recovered?: boolean;
}

interface SubRow {
  plan: string;
  period: string;
  state: string;
  billedLocations: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  mandateId: string | null;
}

async function loadSub(storeId: string): Promise<SubRow | null | undefined> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          plan: billingSubscriptions.plan,
          period: billingSubscriptions.period,
          state: billingSubscriptions.state,
          billedLocations: billingSubscriptions.billedLocations,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          mandateId: billingSubscriptions.mandateId,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.plan_change.load", err, { storeId });
    return undefined;
  }
}

/**
 * What a plan or period change would do, decided without writing anything
 * (GST design 5.3, 5.6).
 *
 * ★ ONE DECISION FOR THE QUOTE AND THE PAYMENT. The subscribe screen's quote
 * (Stage 12) shows what pressing the button will do, and `startPlanChange`
 * does it; both call this, so the screen cannot promise a schedule the action
 * then charges for, or quote a part-period amount the order does not carry.
 *
 * Reads the subscription and LIVE prices only. Refuses, in the merchant's
 * words: no live subscription, a cancelling one, the Free plan, no change at
 * all, and a cheaper change while the next invoice is already issued.
 * Otherwise: a cheaper or equal change is `scheduled` for the cycle end, and
 * a dearer one is `immediate` with the part-period amount (before GST) for
 * the rest of this cycle.
 */
export async function planChangeTerms(input: {
  storeId: string;
  targetPlan: Plan;
  targetPeriod: BillingPeriod;
  /** LIVE prices: these decide a charge. */
  priceFor: (
    plan: Plan,
    period: BillingPeriod,
  ) => Promise<{ planPaise: number }>;
  locationPrice: LocationPrice;
  now: Date;
}): Promise<PlanChangeResult<PlanChangeTerms>> {
  const now = input.now;
  const sub = await loadSub(input.storeId);
  // Fails closed: unable to read means unable to rule out charging wrongly.
  if (sub === undefined) {
    return { ok: false, error: "Couldn't check your subscription. Try again." };
  }
  if (!sub || !LIVE_STATES.includes(sub.state) || !sub.currentPeriodEnd) {
    return {
      ok: false,
      error: "You don't have an active subscription to change.",
    };
  }
  // ★ A cancelling subscription has no next cycle to schedule into, and applying
  // a change now would contradict the cancellation. Resume first.
  if (sub.cancelAtPeriodEnd) {
    return {
      ok: false,
      error:
        "Your subscription is cancelling. Resume it first, then change your plan.",
    };
  }
  if (input.targetPlan === "free") {
    return {
      ok: false,
      error: "Cancel your subscription to move to the Free plan.",
    };
  }

  const currentPlan = normalizePlan(sub.plan);
  const currentPeriod: BillingPeriod =
    sub.period === "yearly" ? "yearly" : "monthly";

  // ★ Locations are dropped when the TARGET plan has no POS — charging for shops
  // a plan cannot use is indefensible, and `resolveNextCycle` applies the same
  // rule when the change lands, so the quote and the outcome agree.
  const targetLocations =
    limitsFor(input.targetPlan).posLocationsIncluded > 0
      ? sub.billedLocations
      : 0;

  const [currentPrice, targetPrice] = await Promise.all([
    input.priceFor(currentPlan, currentPeriod),
    input.priceFor(input.targetPlan, input.targetPeriod),
  ]);

  const currentAmountPaise = subscriptionTotalPaise(
    currentPrice.planPaise,
    sub.billedLocations,
    currentPeriod,
    input.locationPrice,
  );
  const targetAmountPaise = subscriptionTotalPaise(
    targetPrice.planPaise,
    targetLocations,
    input.targetPeriod,
    input.locationPrice,
  );

  const decision = decidePlanChange({
    currentPlan,
    currentPeriod,
    targetPlan: input.targetPlan,
    targetPeriod: input.targetPeriod,
    currentAmountPaise,
    targetAmountPaise,
  });
  if (decision.kind === "noop") {
    return { ok: false, error: decision.reason };
  }

  // ── Cheaper or equal: booked for the cycle end, no money moves ────────────
  if (!decision.immediate) {
    // ★ REFUSED INSIDE THE COLLECTION WINDOW, for the same reason a location
    // release is: the next cycle's invoice is already issued and immutable, so
    // applying the change at the turn would bill the OLD plan for a cycle spent
    // on the new one. Refusing for a few days beats a silent mispricing.
    if (await nextInvoiceIssued(input.storeId, sub.currentPeriodEnd)) {
      return {
        ok: false,
        error: `Your next invoice has already been issued. You can change plans again after ${fmtDate(sub.currentPeriodEnd)}.`,
      };
    }
    return {
      ok: true,
      data: {
        kind: "scheduled",
        plan: input.targetPlan,
        period: input.targetPeriod,
        effectiveAt: sub.currentPeriodEnd,
      },
    };
  }

  // ── Dearer: the difference for the rest of this cycle, now ────────────────
  const amountPaise = prorationPaise({
    currentPeriodPaise: currentAmountPaise,
    targetPeriodPaise: targetAmountPaise,
    period: currentPeriod,
    periodEnd: new Date(sub.currentPeriodEnd),
    now,
    periodDays: PERIOD_DAYS[currentPeriod],
  });
  return {
    ok: true,
    data: {
      kind: "immediate",
      plan: input.targetPlan,
      period: input.targetPeriod,
      prorationPaise: amountPaise,
      targetLocations,
      description: `${PLAN_META[input.targetPlan].name} plan · part period to ${fmtDate(sub.currentPeriodEnd)}`,
      currentPeriodEnd: sub.currentPeriodEnd,
    },
  };
}

/** What `planChangeTerms` decided. */
export type PlanChangeTerms =
  | {
      kind: "scheduled";
      plan: Plan;
      period: BillingPeriod;
      /** The cycle end, when the change lands. */
      effectiveAt: string;
    }
  | {
      kind: "immediate";
      plan: Plan;
      period: BillingPeriod;
      /** The part-period charge before GST; 0 or less is applied free. */
      prorationPaise: number;
      /** The billed-location count after the change. */
      targetLocations: number;
      /** The invoice line's words. */
      description: string;
      currentPeriodEnd: string;
    };

/**
 * Begin a plan or period change.
 *
 * Returns either a payment to open (dearer) or a booked change (cheaper/equal).
 */
export async function startPlanChange(input: {
  storeId: string;
  targetPlan: Plan;
  targetPeriod: BillingPeriod;
  /** LIVE prices: these decide a charge. */
  priceFor: (
    plan: Plan,
    period: BillingPeriod,
  ) => Promise<{ planPaise: number }>;
  locationPrice: LocationPrice;
  now?: Date;
}): Promise<PlanChangeResult<PlanChangeStart>> {
  const now = input.now ?? new Date();

  // ★★ AN EARLIER CHANGE WHOSE PAYMENT WAS CAPTURED IS FINISHED, NOT SOLD AGAIN
  // (RC-F1b). A merchant who paid for an upgrade and closed the tab before the
  // confirm has a captured payment on a draft add-on invoice; opening another
  // order now would charge them twice. Finish the one they paid for. A failed
  // read refuses, because "we could not check" is not "nothing was paid".
  const earlier = await finishEarlierPlanChange(input.storeId, now);
  if (earlier) return earlier;

  const decided = await planChangeTerms({ ...input, now });
  if (!decided.ok) return decided;
  const terms = decided.data;

  // ── Cheaper or equal: book it for the cycle end, move no money ────────────
  if (terms.kind === "scheduled") {
    const booked = await schedule(input.storeId, {
      plan: terms.plan,
      period: terms.period,
      now,
    });
    if (!booked) {
      return { ok: false, error: "Couldn't schedule that change. Try again." };
    }
    return {
      ok: true,
      data: {
        scheduled: true,
        effectiveAt: terms.effectiveAt,
        plan: terms.plan,
        period: terms.period,
      },
    };
  }

  // ── Dearer: charge the difference for the rest of this cycle, now ─────────
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { ok: false, error: "Payments aren't available now." };

  // ★ At the very end of a cycle the part period rounds to nothing, and Razorpay
  // refuses a ₹0 order. Apply it free rather than refusing the upgrade: the
  // merchant gains a few hours and the next invoice bills the new plan in full.
  if (terms.prorationPaise <= 0) {
    const applied = await applyNow(input.storeId, {
      plan: terms.plan,
      period: terms.period,
      locations: terms.targetLocations,
      now,
    });
    if (!applied) {
      return { ok: false, error: "Couldn't change your plan. Try again." };
    }
    return {
      ok: true,
      data: {
        scheduled: false,
        effectiveAt: null,
        plan: terms.plan,
        period: terms.period,
      },
    };
  }

  // ★★ ONE TAX READING FOR THIS PAYMENT (GST design 5.2): the part period is
  // taxed under the terms in force now and stamped with the reading's
  // particulars. Its refusals come before anything is written.
  const reading = await readTaxForPayment(
    input.storeId,
    now,
    "billing.plan_change",
  );
  if (!reading.ok) return { ok: false, error: reading.error };
  const snap = reading.snap;

  const built = buildAddonInvoice({
    description: terms.description,
    amountPaise: terms.prorationPaise,
    tax: snap.tax,
  });

  // Not finalized — an unpaid upgrade must not burn a GST number (the enrolment
  // rule). `confirmPlanChange` issues it once the payment verifies.
  const invoice = await createAddonInvoice({
    storeId: input.storeId,
    built,
    // ★ Reuses the addon target field to carry the LOCATION count that applies
    // after the change, so confirm writes what was priced. The plan and period
    // themselves are re-derived from the request and re-validated there.
    targetCount: terms.targetLocations,
    stamp: snap.stamp,
  });
  if (!invoice) return { ok: false, error: "Couldn't prepare your invoice." };

  const due = await amountDueForInvoice(invoice.id);
  if (due === null || due <= 0) {
    return { ok: false, error: "Couldn't work out what's due." };
  }

  const attempt = await beginAttempt({
    invoiceId: invoice.id,
    storeId: input.storeId,
    amountPaise: due,
    mode: "manual",
  });
  if (!attempt) {
    return {
      ok: false,
      error: "A payment is already in progress. Give it a moment.",
    };
  }

  const order = await rzpCreateOrder(creds, {
    amountPaise: due,
    receipt: invoice.id.slice(0, 30),
    notes: {
      store_id: input.storeId,
      invoice_id: invoice.id,
      sm_billing_key: attempt.idempotencyKey,
      plan: terms.plan,
      period: terms.period,
    },
  });
  if (!order.ok) {
    await settleAttempt(
      attempt.attemptId,
      order.outcome === "unknown" ? "unknown" : "failed",
      { failureCode: "order_create", failureReason: order.error, now },
    );
    return { ok: false, error: "Couldn't start the payment. Try again." };
  }

  await settleAttempt(attempt.attemptId, "processing", {
    providerOrderId: order.data.id,
    now,
  });

  return {
    ok: true,
    data: {
      payment: {
        invoiceId: invoice.id,
        providerOrderId: order.data.id,
        keyId: creds.keyId,
        amountPaise: due,
      },
      scheduled: false,
      effectiveAt: null,
      plan: terms.plan,
      period: terms.period,
    },
  };
}

/**
 * Settle an immediate (dearer) plan change and apply it.
 *
 * ★ THE TARGET IS RE-VALIDATED HERE, not trusted. The plan and period arrive from
 * the client, so this re-checks them against `PLAN_IDS` and re-runs the comp floor
 * — the invoice only carries the location count.
 */
export async function confirmPlanChange(input: {
  storeId: string;
  invoiceId: string;
  targetPlan: Plan;
  targetPeriod: BillingPeriod;
  providerPaymentId: string;
  signature: string;
  now?: Date;
}): Promise<PlanChangeResult<{ plan: Plan; period: BillingPeriod }>> {
  const now = input.now ?? new Date();
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { ok: false, error: "Payments aren't available now." };

  let found: {
    attemptId: string;
    providerOrderId: string | null;
    amountPaise: number;
    locations: number;
  } | null = null;
  try {
    found = await withService(async (db) => {
      const [inv] = await db
        .select({ locations: billingInvoices.addonTargetCount })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.id, input.invoiceId),
            // Scoped by store: an invoice id alone must never let one merchant
            // settle another's payment or benefit from it.
            eq(billingInvoices.storeId, input.storeId),
            eq(billingInvoices.kind, "addon"),
          ),
        )
        .limit(1);
      if (!inv || inv.locations === null) return null;
      const [att] = await db
        .select({
          id: billingPaymentAttempts.id,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, input.invoiceId),
            eq(billingPaymentAttempts.storeId, input.storeId),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      if (!att) return null;
      return {
        attemptId: att.id,
        providerOrderId: att.providerOrderId,
        amountPaise: att.amountPaise,
        locations: inv.locations,
      };
    });
  } catch (err) {
    logError("billing.plan_change.confirm_load", err, {
      invoiceId: input.invoiceId,
    });
    return { ok: false, error: "Couldn't confirm that payment." };
  }

  if (!found?.providerOrderId) {
    return { ok: false, error: "No payment to confirm." };
  }

  if (
    !verifyCheckoutSignature(
      creds.keySecret,
      found.providerOrderId,
      input.providerPaymentId,
      input.signature,
    )
  ) {
    logError(
      "billing.plan_change.bad_signature",
      new Error("signature mismatch"),
      { storeId: input.storeId, invoiceId: input.invoiceId },
    );
    return { ok: false, error: "We couldn't verify that payment." };
  }

  const observedPayment = await verifyCapturedCheckoutPayment(creds, {
    paymentId: input.providerPaymentId,
    orderId: found.providerOrderId,
    amountPaise: found.amountPaise,
  });
  if (!observedPayment.ok) {
    logError(
      "billing.plan_change.gateway_mismatch",
      new Error(observedPayment.error),
      { storeId: input.storeId, invoiceId: input.invoiceId },
    );
    return { ok: false, error: observedPayment.error };
  }

  // ★ The add-on invoice's time of supply is the payment's, not the confirm's
  // (R1-07): a payment made just before a scheduled GST change and confirmed
  // just after is issued under the terms it was paid under. Best-effort.
  const paidAt = observedPayment.gatewayRead
    ? await paymentCapturedAt(
        creds,
        input.providerPaymentId,
        "billing.plan_change",
      )
    : undefined;

  // ★★ ONE COMPLETION, WHOEVER ARRIVES (RC-F1b), and the plan and period come
  // from the ORDER the server created, never from the browser: the request's
  // `targetPlan` and `targetPeriod` are no longer what is applied.
  const outcome = await completePlanChangePurchase({
    storeId: input.storeId,
    invoiceId: input.invoiceId,
    attemptId: found.attemptId,
    providerPaymentId: input.providerPaymentId,
    source: "confirm",
    verifyCapture: false,
    paidAt,
    now,
  });
  switch (outcome.status) {
    case "completed":
    case "already_complete":
      if (
        outcome.data.plan !== input.targetPlan ||
        outcome.data.period !== input.targetPeriod
      ) {
        logWarn("billing.plan_change.client_target_ignored", {
          storeId: input.storeId,
          invoiceId: input.invoiceId,
        });
      }
      return { ok: true, data: outcome.data };
    case "not_captured":
      return { ok: false, error: "That payment didn't complete." };
    case "not_ready":
      return { ok: false, error: PLAN_CHANGE_PAID_NOT_SWITCHED_MESSAGE };
    case "refused":
      // ★ The money is IN. Never a bare failure (the §15 rule). Filed for a
      // person already.
      return {
        ok: false,
        error:
          "Your payment went through but we couldn't switch your plan. Contact support, and please don't pay again.",
      };
  }
}

/**
 * Finish a paid plan change: issue the add-on invoice, record the payment,
 * apply the plan and period the ORDER was created for (RC-F1b).
 *
 * ★★ THE SAME CODE FOR THE BROWSER CONFIRM, THE HOURLY RECONCILE AND A
 * REPEATED START. The confirm used to be the only path, so a merchant who
 * paid and closed the tab kept the old plan with their money on a draft.
 *
 * ★★ THE TARGET IS THE ORDER'S NOTES, which the server wrote when it created
 * the order (`plan`, `period`), never the browser's request. Read BEFORE
 * anything is written, so an unreadable order changes nothing.
 *
 * ★★ WHOEVER ARRIVES SECOND CHANGES NOTHING AND SENDS NOTHING: finalize claims
 * a draft, the paid move claims an open invoice (its winner sends the
 * receipt), and the apply below claims a live subscription in the same cycle
 * that is not already on the target.
 *
 * ★ STILL APPLICABLE OR FILED FOR A PERSON: the subscription is live, the
 * purchase was made in its current cycle, and (while the invoice is still a
 * draft) the subscription is not already on the target through some other
 * change. Anything else is filed with a note, and nothing is applied or
 * refunded automatically.
 */
export async function completePlanChangePurchase(input: {
  storeId: string;
  invoiceId: string;
  attemptId: string;
  providerPaymentId: string | null;
  source: "confirm" | "recovery" | "start";
  verifyCapture: boolean;
  /** Already read by the caller from the order's notes; read here when absent. */
  target?: { plan: string; period: string };
  fetchOrderPayments?: typeof rzpFetchOrderPayments;
  /** When the gateway captured the payment; the issue reads its tax terms then. */
  paidAt?: Date;
  now: Date;
}): Promise<PurchaseCompletion<{ plan: Plan; period: BillingPeriod }>> {
  const now = input.now;
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { status: "not_ready", reason: "no gateway credentials" };

  let facts: Awaited<ReturnType<typeof readAddonFacts>>;
  try {
    facts = await readAddonFacts(input);
  } catch (err) {
    logError("billing.plan_change.complete_read", err, {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
    });
    return { status: "not_ready", reason: "the purchase could not be read" };
  }
  const { invoice, attempt, storeExists, sub } = facts;
  if (
    !attempt ||
    attempt.invoiceId !== input.invoiceId ||
    attempt.storeId !== input.storeId
  ) {
    return {
      status: "refused",
      reason: "the payment does not belong to this store and invoice",
    };
  }

  type Done = PurchaseCompletion<{ plan: Plan; period: BillingPeriod }>;
  const file = async (
    reason: string,
    note: string,
    extra: {
      unapplied?: boolean;
      kind?: "state_conflict" | "amount_mismatch";
      observedPaise?: number | null;
      paymentId?: string | null;
    } = {},
  ): Promise<Done> => {
    await fileRecoveredPurchase({
      storeId: input.storeId,
      kind: extra.kind ?? "state_conflict",
      repairKey: `${extra.unapplied ? "purchase_unapplied" : "purchase_refused"}:${attempt.id}`,
      note,
      invoiceId: input.invoiceId,
      attemptId: attempt.id,
      providerPaymentId:
        extra.paymentId ??
        attempt.providerPaymentId ??
        input.providerPaymentId ??
        null,
      providerOrderId: attempt.providerOrderId,
      expectedPaise: attempt.amountPaise,
      observedPaise: extra.observedPaise ?? null,
      purchase: "plan_change",
      now,
    });
    return { status: "refused", reason };
  };

  if (
    !invoice ||
    invoice.storeId !== input.storeId ||
    invoice.kind !== "addon" ||
    invoice.addonTargetCount === null
  ) {
    return file(
      "the invoice is not this store's add-on invoice",
      "Plan change payment captured, but its invoice is not this store's add-on invoice. Check the payment and refund it or apply it by hand.",
    );
  }
  if (!storeExists) {
    return file(
      "the store no longer exists",
      "Plan change payment captured for a store that no longer exists. Decide whether to refund it.",
    );
  }
  if (attempt.state !== "captured" && input.source !== "confirm") {
    return { status: "not_ready", reason: "the payment is not captured" };
  }
  if (!attempt.providerOrderId) {
    return file(
      "the payment has no order",
      "Plan change payment with no Razorpay order. Check it by hand.",
    );
  }

  // ── The target, from the order WE created ────────────────────────────────
  let target = input.target;
  if (!target) {
    const read = await readAddonOrderTarget(creds, attempt.providerOrderId);
    if (!read) {
      return { status: "not_ready", reason: "the order could not be read" };
    }
    if (read.kind !== "plan_change") {
      return file(
        "the order is not a plan change",
        "Payment captured on an add-on order that does not name a plan change. Check what it bought, then apply it by hand or refund it.",
      );
    }
    target = { plan: read.plan, period: read.period };
  }
  if (
    (target.plan !== "basic" && target.plan !== "pro") ||
    (target.period !== "monthly" && target.period !== "yearly")
  ) {
    return file(
      "the order names a plan that cannot be applied",
      `Plan change payment captured for "${target.plan}" billed "${target.period}", which is not a plan that can be applied. Check the order, then apply or refund it by hand.`,
    );
  }
  const plan = target.plan as Plan;
  const period = target.period as BillingPeriod;

  let paymentId = input.providerPaymentId ?? attempt.providerPaymentId;
  if (input.verifyCapture) {
    const checked = await verifyRecoveredCapture({
      creds,
      providerOrderId: attempt.providerOrderId,
      providerPaymentId: attempt.providerPaymentId,
      amountPaise: attempt.amountPaise,
      currency: attempt.currency,
      fetchOrderPayments: input.fetchOrderPayments,
    });
    if (checked.status === "unreadable") {
      return { status: "not_ready", reason: "the gateway could not be read" };
    }
    if (checked.status === "mismatch") {
      return file(
        `the gateway disagrees: ${checked.reason}`,
        `Plan change payment captured, but ${checked.reason}. The plan was not changed. Decide whether to refund the payment or change the plan by hand.`,
        {
          kind: "amount_mismatch",
          observedPaise: checked.observedPaise,
          paymentId: checked.paymentId,
        },
      );
    }
    paymentId = checked.paymentId;
  }

  if (!["draft", "open", "processing", "paid"].includes(invoice.status)) {
    return file(
      `the invoice is ${invoice.status}`,
      `Plan change payment captured on an invoice that is ${invoice.status}. The plan was not changed. Decide whether to refund the payment.`,
    );
  }

  // ── Still applicable? ────────────────────────────────────────────────────
  if (!sub || !LIVE_STATES.includes(sub.state)) {
    return file(
      "there is no live subscription to change",
      "Plan change payment captured, but the store's subscription is no longer live. Decide whether to refund the payment.",
    );
  }
  if (
    !sub.currentPeriodStart ||
    Date.parse(invoice.createdAt) < Date.parse(sub.currentPeriodStart)
  ) {
    return file(
      "the cycle this change was paid for has ended",
      "Plan change payment captured for a cycle that has since ended, so the part period it paid for is over. Decide whether to refund the payment.",
    );
  }
  const onTarget = sub.plan === plan && sub.period === period;
  if (invoice.status === "draft" && onTarget) {
    return file(
      "the subscription is already on that plan through another change",
      `Plan change payment captured, but the subscription is already on ${PLAN_META[plan].name} billed ${period} through another change. Decide whether to refund this payment.`,
    );
  }

  // ── Issue the invoice, then record the payment ───────────────────────────
  // ★★ FINALIZE BEFORE SETTLING: the paid move claims only an open or
  // processing invoice, so a draft settled first stays unpaid behind captured
  // money (measured on production, 2026-09-06).
  if (invoice.status === "draft") {
    const issued = await finalizeInvoice(input.invoiceId, now, input.paidAt);
    if (!issued) {
      // ★ Captured money, a draft still: nothing settled or applied. Logged
      // so a run of these is visible; `issueInvoice` already logged why.
      logWarn("billing.confirm_issue_failed", {
        purchase: "plan_change",
        source: input.source,
        storeId: input.storeId,
        invoiceId: input.invoiceId,
        attemptId: input.attemptId,
      });
      return { status: "not_ready", reason: "the invoice could not be issued" };
    }
    if (
      !issued.finalizedAt ||
      !["open", "processing", "paid"].includes(issued.status)
    ) {
      return file(
        "the invoice was closed before it could be issued",
        "Plan change payment captured, but its draft invoice was closed before it could be issued. Decide whether to refund the payment.",
      );
    }
  }
  const settled = await settleAttempt(attempt.id, "captured", {
    providerPaymentId: paymentId,
    now,
  });
  if (settled && settled !== "captured") return { status: "not_captured" };
  const paidNow = await getInvoice(input.invoiceId);
  if (paidNow?.status !== "paid") {
    return file(
      "the invoice did not become paid",
      "Plan change payment captured and its invoice issued, but the invoice did not become paid. Check the invoice, then change the plan by hand.",
      { unapplied: true },
    );
  }

  // ── Apply: a claim, so it happens once ───────────────────────────────────
  const applied = await claimPlanChange(input.storeId, {
    plan,
    period,
    locations: invoice.addonTargetCount,
    cycleSeq: sub.currentCycleSeq,
    now,
  });
  if (applied !== true) {
    const current = await loadSub(input.storeId);
    if (
      current &&
      LIVE_STATES.includes(current.state) &&
      current.plan === plan &&
      current.period === period
    ) {
      return { status: "already_complete", data: { plan, period } };
    }
    return file(
      "the plan could not be changed",
      "Plan change payment captured and its invoice paid, but the plan could not be changed. Change it by hand; the merchant was told not to pay again.",
      { unapplied: true },
    );
  }
  logInfo("billing.purchase_completed", {
    purchase: "plan_change",
    source: input.source,
    storeId: input.storeId,
    invoiceId: input.invoiceId,
    attemptId: attempt.id,
  });
  return { status: "completed", data: { plan, period } };
}

/** Everything a plan change's or a location purchase's guards read, in one scope. */
async function readAddonFacts(input: {
  storeId: string;
  invoiceId: string;
  attemptId: string;
}) {
  return withService(async (db) => {
    const [invoice] = await db
      .select({
        storeId: billingInvoices.storeId,
        kind: billingInvoices.kind,
        status: billingInvoices.status,
        addonTargetCount: billingInvoices.addonTargetCount,
        createdAt: billingInvoices.createdAt,
      })
      .from(billingInvoices)
      .where(eq(billingInvoices.id, input.invoiceId))
      .limit(1);
    const [attempt] = await db
      .select({
        id: billingPaymentAttempts.id,
        invoiceId: billingPaymentAttempts.invoiceId,
        storeId: billingPaymentAttempts.storeId,
        state: billingPaymentAttempts.state,
        amountPaise: billingPaymentAttempts.amountPaise,
        currency: billingPaymentAttempts.currency,
        providerOrderId: billingPaymentAttempts.providerOrderId,
        providerPaymentId: billingPaymentAttempts.providerPaymentId,
      })
      .from(billingPaymentAttempts)
      .where(eq(billingPaymentAttempts.id, input.attemptId))
      .limit(1);
    const [store] = await db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.id, input.storeId))
      .limit(1);
    const [sub] = await db
      .select({
        state: billingSubscriptions.state,
        plan: billingSubscriptions.plan,
        period: billingSubscriptions.period,
        currentCycleSeq: billingSubscriptions.currentCycleSeq,
        currentPeriodStart: billingSubscriptions.currentPeriodStart,
      })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.storeId, input.storeId))
      .limit(1);
    return {
      invoice: invoice ?? null,
      attempt: attempt ?? null,
      storeExists: !!store,
      sub: sub ?? null,
    };
  });
}

/**
 * Apply a paid change, in BOTH places, as a claim.
 *
 * ★★ The UPDATE admits only a live subscription in the cycle the purchase was
 * made in that is not already on the target, so a confirm and the hourly
 * reconcile arriving together apply it once. ★ The comp floor holds, and the
 * cycle is not restarted (see `applyNow`). True when this call applied it.
 */
async function claimPlanChange(
  storeId: string,
  input: {
    plan: Plan;
    period: BillingPeriod;
    locations: number;
    cycleSeq: number;
    now: Date;
  },
): Promise<boolean | null> {
  try {
    return await withService(async (db) => {
      const claimed = await db
        .update(billingSubscriptions)
        .set({
          plan: input.plan,
          period: input.period,
          billedLocations: input.locations,
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          updatedAt: input.now.toISOString(),
        })
        .where(
          and(
            eq(billingSubscriptions.storeId, storeId),
            inArray(billingSubscriptions.state, LIVE_STATES),
            eq(billingSubscriptions.currentCycleSeq, input.cycleSeq),
            sql`not (${billingSubscriptions.plan} = ${input.plan} and ${billingSubscriptions.period} = ${input.period})`,
          ),
        )
        .returning({ storeId: billingSubscriptions.storeId });
      if (claimed.length === 0) return false;

      const [store] = await db
        .select({ plan: stores.plan, planSource: stores.planSource })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      if (
        store &&
        billingMayApplyPlan(store.plan, store.planSource, input.plan)
      ) {
        await db
          .update(stores)
          .set({ plan: input.plan, planSource: "paid", planExpiresAt: null })
          .where(eq(stores.id, storeId));
      }
      return true;
    });
  } catch (err) {
    logError("billing.plan_change.apply", err, { storeId });
    return null;
  }
}

/**
 * Finish an earlier plan change whose payment was captured, before opening a
 * new one (RC-F1b). Null when there is none; otherwise the answer.
 */
async function finishEarlierPlanChange(
  storeId: string,
  now: Date,
): Promise<PlanChangeResult<PlanChangeStart> | null> {
  const found = await capturedDraftPurchases({
    storeId,
    kind: "addon",
    limit: 10,
  });
  if (found === null) {
    return { ok: false, error: "Couldn't check your subscription. Try again." };
  }
  if (found.length === 0) return null;
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { ok: false, error: "Payments aren't available now." };
  for (const purchase of found) {
    const read = await readAddonOrderTarget(creds, purchase.providerOrderId);
    if (!read) {
      return {
        ok: false,
        error: "Couldn't check your subscription. Try again.",
      };
    }
    if (read.kind !== "plan_change") continue;
    const outcome = await completePlanChangePurchase({
      storeId,
      invoiceId: purchase.invoiceId,
      attemptId: purchase.attemptId,
      providerPaymentId: null,
      source: "start",
      verifyCapture: true,
      target: { plan: read.plan, period: read.period },
      now,
    });
    if (
      outcome.status === "completed" ||
      outcome.status === "already_complete"
    ) {
      return {
        ok: true,
        data: {
          scheduled: false,
          effectiveAt: null,
          plan: outcome.data.plan,
          period: outcome.data.period,
          recovered: true,
        },
      };
    }
    logWarn("billing.plan_change.earlier_purchase_waiting", {
      storeId,
      invoiceId: purchase.invoiceId,
      attemptId: purchase.attemptId,
      outcome: outcome.status,
    });
    return { ok: false, error: PLAN_CHANGE_RECOVERY_WAITING_MESSAGE };
  }
  return null;
}

/** Book a change for the end of the current cycle. */
async function schedule(
  storeId: string,
  input: { plan: Plan; period: BillingPeriod; now: Date },
): Promise<boolean> {
  try {
    await withService(async (db) => {
      await db
        .update(billingSubscriptions)
        .set({
          scheduledPlan: input.plan,
          scheduledPeriod: input.period,
          updatedAt: input.now.toISOString(),
        })
        .where(eq(billingSubscriptions.storeId, storeId));
    });
    return true;
  } catch (err) {
    logError("billing.plan_change.schedule", err, { storeId });
    return false;
  }
}

/**
 * Apply a change immediately, in BOTH places.
 *
 * ★★ THE COMP FLOOR HOLDS. `stores.plan` is the entitlement every gate reads, and
 * an operator comp must never be overwritten DOWNWARD by billing — the defect
 * that cost a real merchant their Pro plan (§15). Only `billing_subscriptions`
 * moves when the floor refuses; the merchant keeps the better plan they were
 * given and has paid for a change that leaves them no worse off.
 *
 * ★ THE CYCLE IS NOT RESTARTED. They paid a part period to the existing boundary,
 * so moving the boundary would either give away time or take it.
 */
async function applyNow(
  storeId: string,
  input: {
    plan: Plan;
    period: BillingPeriod;
    locations: number;
    now: Date;
  },
): Promise<boolean> {
  try {
    await withService(async (db) => {
      await db
        .update(billingSubscriptions)
        .set({
          plan: input.plan,
          period: input.period,
          billedLocations: input.locations,
          // Superseded — they just changed plan directly.
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          updatedAt: input.now.toISOString(),
        })
        .where(eq(billingSubscriptions.storeId, storeId));

      const [store] = await db
        .select({ plan: stores.plan, planSource: stores.planSource })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);

      if (
        store &&
        billingMayApplyPlan(store.plan, store.planSource, input.plan)
      ) {
        // ★ NO `plan_expires_at` on a paid plan (renewal-worker.ts): one left
        // over from an operator's timed grant would lapse a plan being paid for.
        await db
          .update(stores)
          .set({ plan: input.plan, planSource: "paid", planExpiresAt: null })
          .where(eq(stores.id, storeId));
      }
    });
    return true;
  } catch (err) {
    logError("billing.plan_change.apply", err, { storeId });
    return false;
  }
}

/** Has the invoice for the cycle AFTER `periodEnd` already been raised? */
async function nextInvoiceIssued(
  storeId: string,
  periodEnd: string,
): Promise<boolean> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({ id: billingInvoices.id })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.storeId, storeId),
            eq(billingInvoices.kind, "subscription"),
            eq(billingInvoices.periodStart, periodEnd),
          ),
        )
        .limit(1);
      return !!row;
    });
  } catch (err) {
    logError("billing.plan_change.next_invoice", err, { storeId });
    // Fails toward refusing: booking a change we cannot price correctly is the
    // outcome that silently mischarges.
    return true;
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}
