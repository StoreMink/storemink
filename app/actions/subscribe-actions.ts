"use server";

/**
 * Subscribing to a plan, on the new billing system (§34).
 *
 * ⚠ EVERY EXPORT OF THIS FILE IS A PUBLICLY REACHABLE ENDPOINT. That is what
 * makes the gate on each one load-bearing rather than decorative: these take a
 * merchant's money and change what their store is entitled to.
 *
 * ★ THE ONLY BILLING PATH. `subscription-actions.ts` and the Razorpay
 * Subscriptions machinery behind it were deleted on 2026-08-13 — StoreMink owns
 * the amount and the schedule now, so nothing here asks a provider to change a
 * plan (which is the call that never worked on UPI or e-mandate).
 */

import { refresh, revalidatePath, revalidateTag, updateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { getActingStoreId, getManagerUserId } from "@/app/dashboard/lib/access";
import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";
import { admins, billingSubscriptions } from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentStore, STORE_TAG } from "@/lib/store/resolve";
import {
  getExtraLocationPricingLive,
  getPlanPricingLive,
} from "@/lib/plans/pricing";
import { PLAN_IDS, PLAN_META, normalizePlan, type Plan } from "@/lib/plans";
import type {
  LocationBillingState,
  NextInvoiceView,
  PayableInvoice,
  SubscriptionView,
} from "@/lib/billing/invoice-types";
import {
  confirmInvoicePayment,
  listPayableInvoices,
  startInvoicePayment,
  type PaymentStart,
} from "@/lib/billing/manual-pay";
import {
  cancelAtPeriodEnd,
  getSubscriptionView,
  resumeSubscription,
} from "@/lib/billing/cancel";
import {
  confirmPlanChange,
  PLAN_CHANGE_RECOVERY_WAITING_MESSAGE,
  startPlanChange,
} from "@/lib/billing/plan-change";
import {
  confirmLocationPurchase,
  getLocationBillingState as readLocationBillingState,
  LOCATIONS_RECOVERED_MESSAGE,
  LOCATIONS_RECOVERY_WAITING_MESSAGE,
  releaseLocations,
  startLocationPurchase,
} from "@/lib/billing/locations";
import {
  confirmEnrolment,
  ENROLMENT_PAID_NOT_SWITCHED_MESSAGE,
  ensureBillingAccount,
  startEnrolment,
  type EnrolmentStart,
} from "@/lib/billing/enrol";
import { normalizeMandateMethod } from "@/lib/billing/mandate-types";
import { quoteCheckoutFor, quoteNextRenewal } from "@/lib/billing/quote";
import {
  getBillingDetails,
  saveBillingDetails,
} from "@/lib/billing/billing-details";
import type {
  BillingDetailsInput,
  BillingDetailsView,
  CheckoutQuoteResult,
  RenewalQuote,
  SaveBillingDetailsResult,
} from "@/lib/billing/quote-types";
import { BILLING_DETAILS, SIGNUP_STATE } from "@/lib/billing/tax-copy";

type BillingPeriod = "monthly" | "yearly";

// ---------------------------------------------------------------------------
// An EARLIER purchase whose payment was already captured (the merchant closed
// the tab before the confirm) is finished by the next Subscribe, plan change
// or location purchase instead of opening a second payment (RC-F1b). The
// results below carry the two outcomes so a screen cannot mistake them:
//
// ★ `completedEarlier: true` is a SUCCESS. The plan (or the locations) moved;
//   there is nothing to pay. It used to travel on the error arm, so Plans &
//   Billing showed "Your earlier payment went through, and your plan is now
//   active." in error styling and signup showed it as an error banner.
// ★ `waiting: true` is neither a success nor a failure to retry: the money is
//   in and the plan has not switched yet. The screen shows the message as an
//   information notice and offers no way to pay again.
// ---------------------------------------------------------------------------

export type SubscribeStart =
  | ({ ok: true; completedEarlier?: false } & EnrolmentStart)
  | {
      ok: true;
      completedEarlier: true;
      /** "Your earlier payment went through, and your plan is now active." */
      message: string;
    }
  | { ok: false; error: string; waiting?: true };

export type SubscribeConfirm =
  | { ok: true; plan: Plan; periodEnd: string; autopay: boolean }
  | {
      ok: false;
      error: string;
      /** The payment went through and the plan will switch on shortly. */
      waiting?: true;
    };

/**
 * Prices, read LIVE.
 *
 * ★ Never the cached readers — this number becomes a charge, and a cache an
 * operator's reprice has not reached would bill the old amount.
 */
async function priceFor(plan: Plan, period: BillingPeriod) {
  const [pricing, locationPrice] = await Promise.all([
    getPlanPricingLive(),
    getExtraLocationPricingLive(),
  ]);
  const row = pricing[plan];
  return {
    planPaise: Math.round(
      (period === "yearly" ? row.yearlyInr : row.monthlyInr) * 100,
    ),
    locationPaise: Math.round(
      (period === "yearly"
        ? locationPrice.yearlyInr
        : locationPrice.monthlyInr) * 100,
    ),
  };
}

function isPaidPlan(plan: unknown): plan is Plan {
  return plan === "basic" || plan === "pro";
}

/**
 * Begin subscribing: issue the first invoice and open a Razorpay order.
 *
 * The merchant's plan does NOT change here — `confirmSubscribe` does that, and
 * only against a verified payment.
 */
export async function startSubscribe(
  plan: unknown,
  period: unknown,
  /**
   * Which rail to authorise the mandate on — "card" or "upi".
   *
   * ★ Accepting this from the browser is safe in a way an amount would not be:
   * it selects a payment RAIL, every figure is still computed server-side, and
   * `normalizeMandateMethod` coerces anything unrecognised to "card". It has to
   * be a parameter because Razorpay fixes the rail on the ORDER, so Checkout
   * cannot offer the choice itself.
   */
  mandateMethod?: unknown,
): Promise<SubscribeStart> {
  // Paid enrolment begins only after the dashboard has resolved both the
  // signed-in manager and the store tenant from the store host.
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  return startSubscribeForStore(
    await getActingStoreId(),
    plan,
    period,
    mandateMethod,
  );
}

/**
 * ★ THE CORE, shared by the dashboard and by signup. The two differ only in
 * how the store is resolved; everything after that must stay in one place,
 * or a merchant is billed differently depending on which screen they
 * subscribed from.
 */
async function startSubscribeForStore(
  storeId: string,
  plan: unknown,
  period: unknown,
  mandateMethod?: unknown,
): Promise<SubscribeStart> {
  if (!isPaidPlan(plan) || !PLAN_IDS.includes(plan)) {
    return { ok: false, error: "Choose a paid plan." };
  }
  const billingPeriod: BillingPeriod =
    period === "yearly" ? "yearly" : "monthly";

  // Best-effort: an invoice can be issued without a billing profile, and
  // blocking a sale on optional identity fields would be the wrong trade.
  await ensureBillingAccount(storeId);

  const started = await startEnrolment({
    storeId,
    plan,
    period: billingPeriod,
    mandateMethod: normalizeMandateMethod(mandateMethod),
    priceFor,
  });
  if (!started.ok) {
    if (started.recovered === "completed") {
      // ★ The plan just moved: every plan gate reads the cached store row, and
      // the screen showing this answer should show the new plan too.
      updateTag(STORE_TAG);
      refresh();
      return { ok: true, completedEarlier: true, message: started.error };
    }
    return started.recovered === "waiting"
      ? { ok: false, error: started.error, waiting: true }
      : { ok: false, error: started.error };
  }
  return { ok: true, ...started.data };
}

/**
 * Finish subscribing after the merchant's payment.
 *
 * ★ The signature is verified server-side inside `confirmEnrolment`, against the
 * order WE created. Nothing the client sends is trusted on its own.
 */
export async function confirmSubscribe(
  invoiceId: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<SubscribeConfirm> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  return confirmSubscribeForStore(
    await getActingStoreId(),
    invoiceId,
    providerPaymentId,
    signature,
  );
}

/** ★ THE CORE, shared with signup — the payment result is verified before
 *  entitlement changes. */
async function confirmSubscribeForStore(
  storeId: string,
  invoiceId: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<SubscribeConfirm> {
  if (
    typeof invoiceId !== "string" ||
    typeof providerPaymentId !== "string" ||
    typeof signature !== "string" ||
    !invoiceId ||
    !providerPaymentId ||
    !signature
  ) {
    return { ok: false, error: "That payment couldn't be confirmed." };
  }

  const confirmed = await confirmEnrolment({
    storeId,
    invoiceId,
    providerPaymentId,
    signature,
  });
  if (!confirmed.ok) {
    return confirmed.error === ENROLMENT_PAID_NOT_SWITCHED_MESSAGE
      ? { ok: false, error: confirmed.error, waiting: true }
      : { ok: false, error: confirmed.error };
  }

  // ★ The audit row is written by the completion itself (RC-F1b), only by the
  // caller that actually moved the plan, so a late confirm after the hourly
  // check finished the purchase writes no second row.

  // Every plan gate reads the cached store row.
  revalidateTag(STORE_TAG, "max");

  return {
    ok: true,
    plan: confirmed.data.plan,
    periodEnd: confirmed.data.periodEnd,
    autopay: confirmed.data.mandateActivated,
  };
}

// ---------------------------------------------------------------------------
// Signup — a paid plan chosen on the signup wizard's Plan step (2026-10-10).
//
// The wizard runs on the PLATFORM host, where `getActingStoreId()` resolves
// the fallback store rather than the one created seconds earlier, so these
// cannot use the dashboard gate.
//
// ★★ THE STORE COMES FROM THE SIGNED-IN OWNER, NEVER FROM THE REQUEST. The
// version removed on 2026-08-17 took a store id from the browser and proved
// the caller was its superadmin, which made that proof the whole security
// boundary. A store owner has exactly one admins row (`admins.id` IS the auth
// uid), so the store is read from it and no id crosses the wire at all. Only
// a superadmin row counts — buying a plan is the owner's decision, the same
// rule the old gate applied — and an unreadable row refuses rather than
// authorises.
//
// ★ A SUSPENDED OWNER IS NOT A SIGNUP OWNER (review R3-10): suspension means
// no access everywhere (`getViewerContext`, §41), so these actions refuse it
// too, the same truthiness access.ts reads.
// ---------------------------------------------------------------------------

/** The signed-in owner's store and their uid, or null. */
async function signupOwner(): Promise<{
  storeId: string;
  userId: string;
} | null> {
  const user = await getServerUser();
  if (!user) return null;
  try {
    const rows = await withService((db) =>
      db
        .select({
          storeId: admins.storeId,
          role: admins.role,
          isSuspended: admins.isSuspended,
        })
        .from(admins)
        .where(eq(admins.id, user.id))
        .limit(1),
    );
    const row = rows[0];
    if (row?.role !== "superadmin" || row.isSuspended) return null;
    return { storeId: row.storeId, userId: user.id };
  } catch (err) {
    logError("billing.signup_owner_store", err, { uid: user.id });
    return null;
  }
}

/** Begin the first subscription from the signup wizard's Plan step. */
export async function startSignupSubscribe(
  plan: unknown,
  period: unknown,
  mandateMethod?: unknown,
): Promise<SubscribeStart> {
  const owner = await signupOwner();
  if (!owner)
    return { ok: false, error: "You don't have permission to do this." };
  return startSubscribeForStore(owner.storeId, plan, period, mandateMethod);
}

/** Settle it. */
export async function confirmSignupSubscribe(
  invoiceId: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<SubscribeConfirm> {
  const owner = await signupOwner();
  if (!owner)
    return { ok: false, error: "You don't have permission to do this." };
  const result = await confirmSubscribeForStore(
    owner.storeId,
    invoiceId,
    providerPaymentId,
    signature,
  );
  // The wizard sends the owner straight to their dashboard on another host,
  // so the new plan has to be visible on that very next request rather than
  // after a stale-while-revalidate round (createStore's reason for the same
  // read-your-own-writes call).
  if (result.ok) updateTag(STORE_TAG);
  return result;
}

// ---------------------------------------------------------------------------
// Manual payment — settling an invoice the merchant already owes.
//
// A first-class fallback for renewals above the AFA limit, revoked/missing
// mandates, and provider incidents. New enrolments no longer enter this path by
// silently accepting a one-time first payment: they must authorise autopay.
// ---------------------------------------------------------------------------

export type PayInvoiceStart =
  | ({ ok: true } & PaymentStart)
  | { ok: false; error: string };

export type PayInvoiceConfirm =
  | { ok: true; planRestored: boolean }
  | { ok: false; error: string };

/** What this store still owes, for a "pay now" surface. */
export async function getPayableInvoices(): Promise<PayableInvoice[]> {
  const userId = await getManagerUserId("ai");
  if (!userId) return [];
  const storeId = await getActingStoreId();
  return listPayableInvoices(storeId);
}

export async function startPayInvoice(
  invoiceId: unknown,
): Promise<PayInvoiceStart> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (typeof invoiceId !== "string" || !invoiceId) {
    return { ok: false, error: "We couldn't find that invoice." };
  }

  // ★ The store comes from the SESSION, never the caller. startInvoicePayment
  // then refuses any invoice that does not belong to it, so an invoice id from
  // another tenant finds nothing rather than becoming payable.
  const storeId = await getActingStoreId();
  const started = await startInvoicePayment({ storeId, invoiceId });
  if (!started.ok) return { ok: false, error: started.error };
  return { ok: true, ...started.data };
}

export async function confirmPayInvoice(
  invoiceId: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<PayInvoiceConfirm> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (
    typeof invoiceId !== "string" ||
    typeof providerPaymentId !== "string" ||
    typeof signature !== "string" ||
    !invoiceId ||
    !providerPaymentId ||
    !signature
  ) {
    return { ok: false, error: "That payment couldn't be confirmed." };
  }

  const storeId = await getActingStoreId();
  const done = await confirmInvoicePayment({
    storeId,
    invoiceId,
    providerPaymentId,
    signature,
  });
  if (!done.ok) return { ok: false, error: done.error };

  // A restored plan changes entitlement, so every gate must see it.
  if (done.data.planRestored) revalidateTag(STORE_TAG, "max");

  return { ok: true, planRestored: done.data.planRestored };
}

// ---------------------------------------------------------------------------
// Extra locations — metered, and billed WITH the subscription (§34, POS 7).
//
// ★ The old path did this with `rzpUpdateSubscription`, which Razorpay does not
// support for UPI or e-mandate mandates — so for most Indian merchants buying a
// location silently did not work. Here StoreMink prices it: the part period is a
// one-off payment on the verified checkout, and every future cycle is billed from
// `billed_locations` by the renewal worker.
// ---------------------------------------------------------------------------

/** Read-only, so gated on VIEW of the section the merchant is looking at. */
export async function getLocationBilling(): Promise<LocationBillingState | null> {
  const userId = await getManagerUserId("locations");
  if (!userId) return null;
  const [storeId, store, locationPrice] = await Promise.all([
    getActingStoreId(),
    getCurrentStore(),
    getExtraLocationPricingLive(),
  ]);
  return readLocationBillingState({ storeId, store, locationPrice });
}

export type LocationPurchaseResult =
  | {
      ok: true;
      completedEarlier?: false;
      invoiceId: string;
      providerOrderId: string;
      keyId: string;
      amountPaise: number;
      targetCount: number;
    }
  | {
      ok: true;
      /** An earlier, already paid purchase was finished instead (RC-F1b). */
      completedEarlier: true;
      message: string;
    }
  | { ok: false; error: string; waiting?: true };

/**
 * Begin buying extra locations.
 *
 * ★ Gated on `ai`, not `locations`: this spends money, so it is the billing gate
 * rather than the one that merely manages shops.
 */
export async function startBuyLocations(
  requested: unknown,
): Promise<LocationPurchaseResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (typeof requested !== "number" || !Number.isInteger(requested)) {
    return { ok: false, error: "Choose a whole number of extra locations." };
  }

  const [storeId, store, locationPrice] = await Promise.all([
    getActingStoreId(),
    getCurrentStore(),
    // LIVE — this number becomes a charge, so never the cached reader.
    getExtraLocationPricingLive(),
  ]);
  const started = await startLocationPurchase({
    storeId,
    store,
    requested,
    locationPrice,
  });
  if (!started.ok) {
    // An earlier, already paid purchase was finished instead (RC-F1b): the
    // allowance is a plan gate, so every reader must see the new number. The
    // library answers it on its error arm; here it becomes the success it is.
    if (started.error === LOCATIONS_RECOVERED_MESSAGE) {
      revalidateTag(STORE_TAG, "max");
      return { ok: true, completedEarlier: true, message: started.error };
    }
    return started.error === LOCATIONS_RECOVERY_WAITING_MESSAGE
      ? { ok: false, error: started.error, waiting: true }
      : { ok: false, error: started.error };
  }
  return { ok: true, ...started.data };
}

export type LocationConfirmResult =
  | { ok: true; billedLocations: number }
  | { ok: false; error: string };

export async function confirmBuyLocations(
  invoiceId: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<LocationConfirmResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (
    typeof invoiceId !== "string" ||
    typeof providerPaymentId !== "string" ||
    typeof signature !== "string" ||
    !invoiceId ||
    !providerPaymentId ||
    !signature
  ) {
    return { ok: false, error: "That payment couldn't be confirmed." };
  }

  const storeId = await getActingStoreId();
  const done = await confirmLocationPurchase({
    storeId,
    invoiceId,
    providerPaymentId,
    signature,
  });
  if (!done.ok) return { ok: false, error: done.error };

  // The allowance is a plan gate, so every reader must see the new number.
  revalidateTag(STORE_TAG, "max");
  return { ok: true, billedLocations: done.data.billedLocations };
}

export type ReleaseLocationsResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Book a reduction for the end of the current cycle.
 *
 * ★ No money moves, in either direction — they keep what they paid for until it
 * runs out, and nobody is refunded (§15b).
 */
export async function releaseExtraLocations(
  requested: unknown,
): Promise<ReleaseLocationsResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (typeof requested !== "number" || !Number.isInteger(requested)) {
    return { ok: false, error: "Choose a whole number of extra locations." };
  }

  const [storeId, store] = await Promise.all([
    getActingStoreId(),
    getCurrentStore(),
  ]);
  const done = await releaseLocations({ storeId, store, requested });
  if (!done.ok) return { ok: false, error: done.error };

  const when = done.data.effectiveAt
    ? new Date(done.data.effectiveAt).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    : null;
  return {
    ok: true,
    message: when
      ? `Booked. You keep the location until ${when}, then stop paying for it.`
      : "Booked. You keep the location until this cycle ends.",
  };
}

// ---------------------------------------------------------------------------
// Cancelling, resuming, and changing plan.
//
// ★ None of these calls the gateway to change a schedule — StoreMink owns the
// amount and the dates, so cancelling is a flag and a downgrade is a booked
// change. Only a DEARER change moves money, and it does so through the same
// one-off checkout as enrolment and location purchases.
// ---------------------------------------------------------------------------

/** The subscription card's data. Read-only, so gated on VIEW. */
export async function getMySubscription(): Promise<SubscriptionView> {
  const userId = await getManagerUserId("ai");
  const storeId = await getActingStoreId();
  // No permission still returns the neutral view rather than throwing — the page
  // renders other things, and `active: false` simply hides the controls.
  if (!userId) {
    return {
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
  }
  return getSubscriptionView(storeId);
}

export type CancelActionResult =
  | {
      ok: true;
      message: string;
      /** Keep my plan only: true when the cycle advanced at once, because the
       *  renewal had been paid while the cancellation stood. The plan is
       *  active on its new cycle now. */
      advanced?: boolean;
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// What the merchant is told after cancelling or keeping their plan
// (renewal-cancel design 8.2 and Table B).
//
// ★ EVERY SENTENCE MUST STAY TRUE. Cancelling never keeps money for a cycle
// the plan does not reach: an unpaid renewal invoice is closed when the plan
// ends, and a renewal payment that arrives is refunded. The refund timing is
// the billing emails' own (lib/email/billing-emails.ts, REFUND_TIMING): while
// automatic sending is off a refund may be sent by hand, so the sentence
// promises the usual time rather than the moment the plan ends.
// ---------------------------------------------------------------------------

const REFUND_TIMING = "after your plan ends, usually within 5 working days";

/** A date in India time: "30 Oct 2026", or "1 Nov 2026, 14:00 IST" with the
 *  time, the shape the billing emails print. */
function istDay(iso: string, opts: { time?: boolean } = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
  if (!opts.time) return day;
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Kolkata",
  });
  return `${day}, ${time} IST`;
}

/** "₹2,400", or to the paisa when there is one ("₹1,234.50"). */
function rupees(paise: number): string {
  const amount = paise / 100;
  const whole = Number.isInteger(amount);
  return `₹${amount.toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/** In grace the plan ends when grace ends, so that date carries its time. */
function inGrace(state: string | null): boolean {
  return state === "past_due" || state === "grace";
}

/**
 * What the next cycle's invoice means for the merchant, read the way the
 * cancellation email reads it so the toast and the email agree. A draft was
 * never issued to them and a closed invoice is owed by nobody: nothing is
 * said about either.
 */
function nextInvoiceCase(
  next: NextInvoiceView | null,
): "none" | "open" | "in_flight" | "paid" {
  if (!next) return "none";
  if (next.status === "paid") return "paid";
  if (next.inFlight || next.status === "processing") return "in_flight";
  if (next.status === "open") return "open";
  return "none";
}

/** The plan being cancelled, by its display name ("Pro"); null when it
 *  cannot be read, and the sentence then says "your plan". */
async function subscriptionPlanName(storeId: string): Promise<string | null> {
  try {
    const plan = await withService(async (db) => {
      const [row] = await db
        .select({ plan: billingSubscriptions.plan })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      return row?.plan ?? null;
    });
    const known = normalizePlan(plan);
    return known === "free" ? null : PLAN_META[known].name;
  } catch {
    return null;
  }
}

/** Design 8.2, with the grace case of a renewal already paid added. */
function cancelledMessage(d: {
  planName: string | null;
  state: string;
  accessUntil: string | null;
  graceEndsAt: string | null;
  nextInvoice: NextInvoiceView | null;
}): string {
  const grace = inGrace(d.state);
  const endsAt = grace ? d.graceEndsAt : d.accessUntil;
  // ★ Access runs to the end of a cycle only if there IS one: between
  // authorising and the first charge there isn't, and promising a plan they
  // were never charged for sets up the wrong expectation.
  if (!endsAt) return "Cancelled. No further payments will be taken.";
  const plan = d.planName ? `${d.planName} plan` : "plan";
  const next = nextInvoiceCase(d.nextInvoice);
  const amount = d.nextInvoice ? rupees(d.nextInvoice.totalPaise) : "";

  if (grace) {
    const head = `Cancelled. Your ${plan} ends on ${istDay(endsAt, { time: true })}, then your store moves to Free.`;
    if (next === "in_flight") {
      return `${head} A renewal payment of ${amount} is still going through. If it completes, we refund it.`;
    }
    if (next === "paid") {
      return `${head} We'll refund your renewal payment of ${amount} ${REFUND_TIMING}.`;
    }
    if (next === "open") return `${head} Your unpaid invoice won't be charged.`;
    return head;
  }

  const head = `Cancelled. You keep your ${plan} until ${istDay(endsAt)}, then move to Free.`;
  if (next === "open") return `${head} Your renewal invoice won't be charged.`;
  if (next === "in_flight") {
    return `${head} A renewal payment of ${amount} is still going through. If it completes, we refund it ${REFUND_TIMING}.`;
  }
  if (next === "paid") {
    return `${head} We'll refund your renewal payment of ${amount} ${REFUND_TIMING}.`;
  }
  return head;
}

/**
 * Design Table B. ★ `advanced` is the only thing that may say the plan
 * continues on a renewal paid in grace: false means the advance has not
 * happened (it ran too early, or failed), and the downgrade pass's safety net
 * applies it when grace ends, never sooner, so the sentence names that time.
 * ⚠ Autopay is NOT restored: the mandate was withdrawn on cancel and only the
 * merchant can authorise a new one. Saying otherwise has them expect a charge
 * that never comes, and be downgraded for it.
 */
function resumedMessage(d: {
  autopay: boolean;
  advanced: boolean;
  state: string;
  graceEndsAt: string | null;
  currentEnd: string | null;
  nextInvoice: NextInvoiceView | null;
}): string {
  if (d.advanced) {
    return "Resumed. Your renewal is already paid, so your plan continues.";
  }
  const grace = inGrace(d.state);
  const next = nextInvoiceCase(d.nextInvoice);
  const amount = d.nextInvoice ? rupees(d.nextInvoice.totalPaise) : null;

  if (next === "paid") {
    if (grace) {
      return d.graceEndsAt
        ? `Resumed. Your renewal is already paid, so your plan continues. We'll finish renewing it when grace ends on ${istDay(d.graceEndsAt, { time: true })}.`
        : "Resumed. Your renewal is already paid, so your plan continues. We'll finish renewing it when grace ends.";
    }
    return d.currentEnd
      ? `Resumed. Your renewal is already paid, so your plan continues after ${istDay(d.currentEnd)}.`
      : "Resumed. Your renewal is already paid, so your plan continues.";
  }
  if (next === "in_flight") {
    return `Resumed. Your renewal payment of ${amount} is still going through.`;
  }
  if (grace) {
    const invoice = amount ? `renewal invoice of ${amount}` : "renewal invoice";
    return d.graceEndsAt
      ? `Resumed. Pay your ${invoice} by ${istDay(d.graceEndsAt, { time: true })} to keep your plan.`
      : `Resumed. Pay your ${invoice} to keep your plan.`;
  }
  if (d.autopay) return "Resumed. Your plan will renew as normal.";
  if (next === "open") {
    return d.currentEnd
      ? `Resumed. Autopay is off, so pay your renewal invoice of ${amount} by ${istDay(d.currentEnd)} to keep your plan.`
      : `Resumed. Autopay is off, so pay your renewal invoice of ${amount} to keep your plan.`;
  }
  return "Resumed. Autopay is off, so we'll ask you to pay each renewal.";
}

/**
 * Cancel at the end of the cycle (or when grace ends, for a merchant who
 * cancels in grace). Never refused for timing (rule R1).
 *
 * ★ WHO ASKED is recorded with the claim as "merchant:<user id>", from the
 * SESSION: the console records "operator:<email>" for a cancellation an
 * operator makes at the merchant's request, and the banner tells the two
 * apart by kind only.
 */
export async function cancelMySubscription(): Promise<CancelActionResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();
  // The plan name is read beside the claim, not after it: cancelling never
  // changes which plan the subscription is on.
  const [done, planName] = await Promise.all([
    cancelAtPeriodEnd({ storeId, requestedBy: `merchant:${userId}` }),
    subscriptionPlanName(storeId),
  ]);
  if (!done.ok) return { ok: false, error: done.error };

  return {
    ok: true,
    message: cancelledMessage({
      planName,
      state: done.data.state,
      accessUntil: done.data.accessUntil,
      graceEndsAt: done.data.graceEndsAt,
      nextInvoice: done.data.nextInvoice,
    }),
  };
}

/**
 * Keep my plan: clear the cancellation before the plan ends, in grace too
 * (rule R2, decision D4). A renewal paid while the cancellation stood is
 * applied at once when the cycle has ended (`advanced`).
 */
export async function resumeMySubscription(): Promise<CancelActionResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();
  const done = await resumeSubscription({
    storeId,
    requestedBy: `merchant:${userId}`,
  });
  if (!done.ok) return { ok: false, error: done.error };

  // An advanced cycle changes entitlement (the plan is active on its new
  // cycle), so every plan gate must see it. Nothing else here does.
  if (done.data.advanced) revalidateTag(STORE_TAG, "max");

  return {
    ok: true,
    message: resumedMessage(done.data),
    advanced: done.data.advanced,
  };
}

export type PlanChangeActionResult =
  | {
      ok: true;
      /** Present when a payment is needed to apply it now. */
      payment?: {
        invoiceId: string;
        providerOrderId: string;
        keyId: string;
        amountPaise: number;
      };
      scheduled: boolean;
      message: string;
      /** An earlier, already paid change was finished instead (RC-F1b). */
      completedEarlier?: true;
    }
  | { ok: false; error: string; waiting?: true };

/**
 * Move to a different plan or billing period.
 *
 * ★ The DIRECTION decides the timing, and the server decides the direction —
 * there is no "apply now" option to pick, because on a downgrade that means a
 * refund (§15b).
 */
export async function changeMyPlan(
  plan: unknown,
  period: unknown,
): Promise<PlanChangeActionResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (!isPaidPlan(plan) || !PLAN_IDS.includes(plan)) {
    return { ok: false, error: "Choose a paid plan." };
  }
  const billingPeriod: BillingPeriod =
    period === "yearly" ? "yearly" : "monthly";

  const [storeId, locationPrice] = await Promise.all([
    getActingStoreId(),
    getExtraLocationPricingLive(),
  ]);
  const started = await startPlanChange({
    storeId,
    targetPlan: plan,
    targetPeriod: billingPeriod,
    priceFor,
    locationPrice,
  });
  if (!started.ok) {
    return started.error === PLAN_CHANGE_RECOVERY_WAITING_MESSAGE
      ? { ok: false, error: started.error, waiting: true }
      : { ok: false, error: started.error };
  }

  // ★ An EARLIER change whose payment was captured was finished instead of
  // opening a second payment (RC-F1b). It names the plan that payment bought,
  // which may not be the one just picked.
  if (started.data.recovered) {
    revalidateTag(STORE_TAG, "max");
    return {
      ok: true,
      scheduled: false,
      completedEarlier: true,
      message: `Your earlier payment went through, and you're now on ${PLAN_META[started.data.plan].name}.`,
    };
  }

  const name = PLAN_META[plan].name;
  if (started.data.payment) {
    return {
      ok: true,
      payment: started.data.payment,
      scheduled: false,
      message: `Moving to ${name}.`,
    };
  }
  // Applied free (a part period that rounded to nothing) or booked for later.
  if (started.data.scheduled) {
    const when = started.data.effectiveAt
      ? new Date(started.data.effectiveAt).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "Asia/Kolkata",
        })
      : null;
    return {
      ok: true,
      scheduled: true,
      message: when
        ? `Booked. You keep your current plan until ${when}, then move to ${name} billed ${billingPeriod}.`
        : `Booked. You'll move to ${name} at the end of this cycle.`,
    };
  }
  revalidateTag(STORE_TAG, "max");
  return { ok: true, scheduled: false, message: `You're on ${name}.` };
}

export async function confirmMyPlanChange(
  invoiceId: unknown,
  plan: unknown,
  period: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<{ ok: true; plan: Plan } | { ok: false; error: string }> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (
    typeof invoiceId !== "string" ||
    typeof providerPaymentId !== "string" ||
    typeof signature !== "string" ||
    !invoiceId ||
    !providerPaymentId ||
    !signature
  ) {
    return { ok: false, error: "That payment couldn't be confirmed." };
  }
  // ★ RE-VALIDATED, not trusted: the plan and period come from the client, and
  // the invoice carries only the location count.
  if (!isPaidPlan(plan) || !PLAN_IDS.includes(plan)) {
    return { ok: false, error: "That plan isn't valid." };
  }
  const billingPeriod: BillingPeriod =
    period === "yearly" ? "yearly" : "monthly";

  const storeId = await getActingStoreId();
  const done = await confirmPlanChange({
    storeId,
    invoiceId,
    targetPlan: plan,
    targetPeriod: billingPeriod,
    providerPaymentId,
    signature,
  });
  if (!done.ok) return { ok: false, error: done.error };

  revalidateTag(STORE_TAG, "max");
  return { ok: true, plan: done.data.plan };
}

// ---------------------------------------------------------------------------
// What a merchant is shown before they pay, and their Billing details (GST
// design 5.6, 5.7).
//
// ★ The quote runs the same reads and builders as the payment it describes
// (lib/billing/quote.ts), so the figure on the dialog is the figure charged.
// ★ The shapes are in lib/billing/quote-types.ts: every export of this file is
// a public endpoint, so it exports these actions and nothing else new.
// ---------------------------------------------------------------------------

const NO_PERMISSION = "You don't have permission to do this.";

// ★ THROTTLED PER STORE AND PERSON (review R3-07). The quote can reach
// StoreMink's own Razorpay account (an add-on order read) and two live price
// reads on every change in the checkout dialog, and the saves write the
// billing account, so a script on a merchant's session could otherwise spend
// the Razorpay allowance enrolment and the hourly reconcile share. The quote
// and the next-renewal read share one bucket; the two saves share a smaller
// one. The limiter fails open (lib/rate-limit.ts), as a throttle may.
const QUOTE_LIMIT = { max: 60, windowSeconds: 60 } as const;
const DETAILS_SAVE_LIMIT = { max: 10, windowSeconds: 60 } as const;
const QUOTE_RATE_LIMITED =
  "Too many price checks. Please wait a moment and try again.";
const SAVE_RATE_LIMITED =
  "Too many attempts. Please wait a moment and try again.";

/** Whether this store and person may ask again; logs a refusal. */
async function withinLimit(
  bucket: "billing-quote" | "billing-details",
  action: string,
  storeId: string,
  userId: string,
  limit: { max: number; windowSeconds: number },
): Promise<boolean> {
  const { allowed } = await rateLimit(`${bucket}:${storeId}:${userId}`, limit);
  if (!allowed) logWarn("billing.rate_limited", { action, storeId });
  return allowed;
}

/**
 * The checkout dialog's summary for a plan and period, and a Mink credit pack
 * bought with it (`packId`, or null for none).
 */
export async function quoteCheckout(
  plan: unknown,
  period: unknown,
  packId: unknown,
): Promise<CheckoutQuoteResult> {
  const userId = await getManagerUserId("ai");
  if (!userId) return { ok: false, error: NO_PERMISSION };
  if (!isPaidPlan(plan) || !PLAN_IDS.includes(plan)) {
    return { ok: false, error: "Choose a paid plan." };
  }
  const billingPeriod: BillingPeriod =
    period === "yearly" ? "yearly" : "monthly";
  const pack =
    typeof packId === "string" && packId.trim() ? packId.trim() : null;

  const storeId = await getActingStoreId();
  if (
    !(await withinLimit(
      "billing-quote",
      "quote_checkout",
      storeId,
      userId,
      QUOTE_LIMIT,
    ))
  ) {
    return { ok: false, error: QUOTE_RATE_LIMITED };
  }
  const locationPrice = await getExtraLocationPricingLive();
  return quoteCheckoutFor({
    storeId,
    plan,
    period: billingPeriod,
    packId: pack,
    priceFor,
    locationPrice,
  });
}

/**
 * The store's next renewal, as it will be invoiced; null when there is none,
 * when it cannot be read, and past the quote limit (the Plans page then shows
 * no renewal line, as it does on a failed read).
 */
export async function getMyNextRenewal(): Promise<RenewalQuote | null> {
  const userId = await getManagerUserId("ai");
  if (!userId) return null;
  const storeId = await getActingStoreId();
  if (
    !(await withinLimit(
      "billing-quote",
      "next_renewal",
      storeId,
      userId,
      QUOTE_LIMIT,
    ))
  ) {
    return null;
  }
  return quoteNextRenewal({ storeId, priceFor });
}

/** The Billing details form, prefilled while nothing is saved. */
export async function getMyBillingDetails(): Promise<BillingDetailsView | null> {
  const userId = await getManagerUserId("ai");
  if (!userId) return null;
  const storeId = await getActingStoreId();
  return getBillingDetails(storeId);
}

/** The text fields a Billing details save may carry; anything else is ignored. */
const DETAIL_FIELDS = [
  "country",
  "countryName",
  "legalName",
  "gstin",
  "stateCode",
  "addressLine1",
  "addressLine2",
  "city",
  "postalCode",
] as const satisfies ReadonlyArray<keyof BillingDetailsInput>;

function detailsInputOf(input: unknown): BillingDetailsInput {
  const picked: BillingDetailsInput = {};
  if (!input || typeof input !== "object") return picked;
  const raw = input as Record<string, unknown>;
  for (const key of DETAIL_FIELDS) {
    const value = raw[key];
    if (typeof value === "string") picked[key] = value;
  }
  return picked;
}

/** Save the store's Billing details from Plans & Billing. */
export async function saveMyBillingDetails(
  input: unknown,
): Promise<SaveBillingDetailsResult> {
  const userId = await getManagerUserId("ai");
  if (!userId) return { ok: false, error: NO_PERMISSION };
  const storeId = await getActingStoreId();
  if (
    !(await withinLimit(
      "billing-details",
      "save_billing_details",
      storeId,
      userId,
      DETAILS_SAVE_LIMIT,
    ))
  ) {
    return { ok: false, error: SAVE_RATE_LIMITED };
  }
  const result = await saveBillingDetails(storeId, detailsInputOf(input));
  if (result.ok) revalidatePath("/dashboard/plans");
  return result;
}

/**
 * Save the state (and a GSTIN) the signup Plan step asks for before a paid
 * plan. ★ The store is the signed-in owner's (`signupOwner`), never one
 * named in the request; only an Indian state and GSTIN are taken here.
 */
export async function saveSignupBillingDetails(
  input: unknown,
): Promise<SaveBillingDetailsResult> {
  const owner = await signupOwner();
  if (!owner) return { ok: false, error: NO_PERMISSION };
  const { storeId } = owner;
  if (
    !(await withinLimit(
      "billing-details",
      "save_signup_billing_details",
      storeId,
      owner.userId,
      DETAILS_SAVE_LIMIT,
    ))
  ) {
    return { ok: false, error: SAVE_RATE_LIMITED };
  }
  const raw =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const stateCode = typeof raw.stateCode === "string" ? raw.stateCode : "";
  const gstin = typeof raw.gstin === "string" ? raw.gstin : "";
  const result = await saveBillingDetails(storeId, {
    stateCode,
    gstin,
    country: "IN",
  });
  if (!result.ok && result.error === BILLING_DETAILS.errors.failed) {
    return { ok: false, error: SIGNUP_STATE.saveFailed, field: result.field };
  }
  return result;
}
