import "server-only";

/**
 * The numbers a merchant is shown before they pay (GST design 5.6).
 *
 * ★★ A QUOTE IS THE CHARGE, BY CONSTRUCTION. Every figure here comes from the
 * same inputs and the same functions the payment uses: the live prices the
 * caller passes in (the actions' own `priceFor`), `loadTaxSnapshot`,
 * `buildSubscriptionInvoice` / `buildAddonInvoice` / `buildAiCreditsInvoice`,
 * `termsLater` at the renewal's issue instant, `enrolmentDraftChange` and
 * `planChangeTerms`. So in every GST state (off, on with prices including it,
 * on with prices excluding it, a switch-on still scheduled), before and after
 * a scheduled instant, what the dialog says is what the payment window asks
 * for. Two things can still separate them, and the amount guard on the
 * screen handles both: time passing between the quote and the press (a
 * proration day boundary, a scheduled start, an operator reprice), and
 * account credit applied to the invoice.
 *
 * ★ READ ONLY. Nothing here writes a row, opens an order or calls the payment
 * gateway, with two READS mirrored from the starts, because each start makes
 * the same read before deciding what to charge: a captured payment on a draft
 * add-on invoice is told apart (a plan change or a location purchase) by
 * reading its order's notes (RC-F1b), and an order already open on a cycle
 * draft whose only change is GST is read back (`taxDraftOrder`, R1-03): the
 * start abandons one nobody has touched and rebuilds the draft at the GST in
 * force, and resumes any other at the draft's total.
 *
 * ⚠ What the starts check at the gateway is NOT mirrored, so a start may
 * still refuse where the quote showed figures: the earlier-plan-choice
 * refusal while an order for an old shape is in flight (`inspectResumable`),
 * the Razorpay customer (`ensureRzpCustomer`) and "a payment is already in
 * progress" (`beginAttempt`). Each refusal reaches the merchant in its own
 * words when they press the button.
 */

import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { billingMandates, billingSubscriptions } from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import { PLAN_META, limitsFor, normalizePlan, type Plan } from "@/lib/plans";
import {
  extraLocationPaise,
  type LocationPrice,
} from "@/lib/plans/location-billing";
import { getMinkCreditPackLive } from "@/lib/ai/credit-pricing";
import {
  collectionRoute,
  collectionStartsAt,
  cycleFrom,
  mandateFitsGateway,
  mandateSizePaise,
  type MandateStatus,
} from "./cycle";
import {
  enrolCycleSeqWith,
  enrolmentDraftChange,
  taxDraftOrder,
} from "./enrol";
import { RECURRING_CHARGE_VERIFIED } from "./gateway";
import {
  buildAddonInvoice,
  buildAiCreditsInvoice,
  buildSubscriptionInvoice,
  INVOICE_BODY_KINDS,
  rebuildForIssue,
  type BuiltInvoice,
  type TaxContext,
} from "./invoice";
import {
  getCycleInvoice,
  loadTaxSnapshot,
  type InvoiceRow,
} from "./invoice-store";
import { AFA_EXEMPT_PAISE, autopayRailFor } from "./mandate-types";
import { resolveNextCycle, type ScheduledFields } from "./next-cycle";
import { planChangeTerms } from "./plan-change";
import {
  capturedAttemptForInvoice,
  capturedDraftPurchases,
  readAddonOrderTarget,
} from "./collect";
import { paymentTaxRefusal } from "./payment-tax";
import { PAYMENT_REFUSAL } from "./tax-copy";
import type { TaxSnapshot } from "./tax-snapshot";
import { taxContextFor, termsLater, type TaxTerms } from "./tax-terms";
import type {
  AmountQuote,
  CheckoutQuoteResult,
  LocationRenewalQuote,
  PlanChangeQuote,
  QuoteOutcome,
  QuotePeriod,
  QuotePlaceOfSupply,
  QuotePriceFor,
  QuotedRenewal,
  RenewalQuote,
  SubscribeQuote,
} from "./quote-types";

type Snap = Extract<TaxSnapshot, { ok: true }>;

/** States in which the store is already ON a paid cycle (enrol.ts, plan-change.ts). */
const LIVE_STATES = ["active", "past_due", "grace"];

/** The sentence every start uses when a read fails: fail closed. */
const CHECK_FAILED = "Couldn't check your subscription. Try again.";

// ── Amounts ─────────────────────────────────────────────────────────────────

/** One built invoice's money, as the quote shows it. */
export function quoteOf(built: BuiltInvoice): AmountQuote {
  const listed = built.lines
    .filter((line) => INVOICE_BODY_KINDS.includes(line.kind))
    .reduce((sum, line) => sum + line.amountPaise, 0);
  return {
    listedPaise: listed,
    taxablePaise: built.subtotalPaise - built.discountPaise,
    taxPaise: built.taxPaise,
    totalPaise: built.totalPaise,
    rateBps: built.taxRateBps,
    inclusive: built.inclusive,
  };
}

/**
 * A stored invoice's money. `total = subtotal - discount + tax` holds in both
 * price modes (a CHECK constraint), so the taxable value is `total - tax`.
 */
function quoteOfInvoice(
  row: Pick<
    InvoiceRow,
    "bodyTotalPaise" | "totalPaise" | "taxPaise" | "taxRateBps" | "taxInclusive"
  >,
): AmountQuote {
  return {
    listedPaise: row.bodyTotalPaise,
    taxablePaise: row.totalPaise - row.taxPaise,
    taxPaise: row.taxPaise,
    totalPaise: row.totalPaise,
    rateBps: row.taxRateBps,
    inclusive: row.taxInclusive,
  };
}

/**
 * What an order already open on a cycle draft will settle, and the GST split
 * the issue will write for it (`issueInvoice`'s restamp, GST design 5.4).
 *
 * ★ The draft's TOTAL is frozen by the order, so it is what the merchant
 * pays. When the rate and price mode still match the reading the draft is
 * issued as built; otherwise `rebuildForIssue` re-prices it, carving the GST
 * out of the frozen total when GST started with prices excluding it, and a
 * draft no reading reproduces is issued with its own figures (`kept_draft`).
 *
 * The draft's body is carried as one line: `rebuildForIssue` only sums the
 * body lines, so one line of the same total gives the same figures.
 */
function resumedOrderAmount(draft: InvoiceRow, tax: TaxContext): AmountQuote {
  const rateBps = tax.enabled ? tax.rateBps : 0;
  const inclusive = tax.enabled && tax.inclusive;
  const moneyMoved =
    (draft.taxRateBps ?? 0) !== rateBps || draft.taxInclusive !== inclusive;
  if (!moneyMoved) return quoteOfInvoice(draft);
  const body = draft.bodyTotalPaise;
  // An enrolment draft carries no discount; derived rather than assumed so a
  // draft that ever does is still re-priced from what it says.
  const discountPaise = Math.max(
    0,
    draft.taxInclusive
      ? body - draft.totalPaise
      : body + draft.taxPaise - draft.totalPaise,
  );
  const rebuilt = rebuildForIssue({
    lines: [
      {
        kind: "base_plan",
        description: "",
        quantity: 1,
        unitAmountPaise: body,
        amountPaise: body,
      },
    ],
    discountPaise,
    tax,
    frozenTotalPaise: draft.totalPaise,
  });
  return rebuilt ? quoteOf(rebuilt) : quoteOfInvoice(draft);
}

// ── Reads ──────────────────────────────────────────────────────────────────

interface SubscriptionFacts {
  /** "" when the store has no subscription row. */
  state: string;
  plan: string;
  period: string;
  billedLocations: number;
  scheduledPlan: string | null;
  scheduledPeriod: string | null;
  scheduledLocations: number | null;
  cancelAtPeriodEnd: boolean;
  currentCycleSeq: number;
  currentPeriodEnd: string | null;
  /**
   * The cycle an enrolment bills, by `startEnrolment`'s own rule
   * (`currentSubscription` in enrol.ts): 1 unless the subscription ended, then
   * the cycle after the highest one ever issued, or a PAID one above the last
   * activated cycle, so a quote refuses it as the start does.
   */
  enrolCycleSeq: number;
  mandate: { status: MandateStatus; maxAmountPaise: number | null } | null;
}

/**
 * The store's subscription and its mandate, in one service scope.
 * `undefined` on a read failure: every caller fails closed.
 */
async function readSubscription(
  storeId: string,
): Promise<SubscriptionFacts | undefined> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          state: billingSubscriptions.state,
          plan: billingSubscriptions.plan,
          period: billingSubscriptions.period,
          billedLocations: billingSubscriptions.billedLocations,
          scheduledPlan: billingSubscriptions.scheduledPlan,
          scheduledPeriod: billingSubscriptions.scheduledPeriod,
          scheduledLocations: billingSubscriptions.scheduledLocations,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          cycleSeq: billingSubscriptions.currentCycleSeq,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          mandateId: billingSubscriptions.mandateId,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      const state = row?.state ?? "";
      const activated = row?.cycleSeq ?? 0;

      // `startEnrolment`'s own rule, on this scope (R1-01: one copy).
      const enrolCycleSeq = await enrolCycleSeqWith(db, storeId, {
        state,
        activated,
      });

      let mandate: SubscriptionFacts["mandate"] = null;
      if (row?.mandateId) {
        const [m] = await db
          .select({
            status: billingMandates.status,
            maxAmountPaise: billingMandates.maxAmountPaise,
          })
          .from(billingMandates)
          .where(eq(billingMandates.id, row.mandateId))
          .limit(1);
        mandate = m
          ? {
              status: m.status as MandateStatus,
              maxAmountPaise: m.maxAmountPaise ?? null,
            }
          : null;
      }

      return {
        state,
        plan: row?.plan ?? "free",
        period: row?.period ?? "monthly",
        billedLocations: row?.billedLocations ?? 0,
        scheduledPlan: row?.scheduledPlan ?? null,
        scheduledPeriod: row?.scheduledPeriod ?? null,
        scheduledLocations: row?.scheduledLocations ?? null,
        cancelAtPeriodEnd: row?.cancelAtPeriodEnd === true,
        currentCycleSeq: activated,
        currentPeriodEnd: row?.currentPeriodEnd ?? null,
        enrolCycleSeq,
        mandate,
      };
    });
  } catch (err) {
    logError("billing.quote.subscription_read", err, { storeId });
    return undefined;
  }
}

/** The tax reading, or the refusal the payment would give for it. */
async function readSnapshot(
  storeId: string,
  now: Date,
): Promise<{ ok: true; snap: Snap } | { ok: false; error: string }> {
  let snap: TaxSnapshot;
  try {
    snap = await loadTaxSnapshot(storeId, now);
  } catch (err) {
    logError("billing.quote.tax_snapshot", err, { storeId });
    return { ok: false, error: PAYMENT_REFUSAL.invoiceFailed };
  }
  if (!snap.ok) {
    logWarn("billing.quote.tax_settings_incomplete", {
      storeId,
      reason: snap.reason,
    });
    return { ok: false, error: PAYMENT_REFUSAL.settingsIncomplete };
  }
  return { ok: true, snap };
}

// ── The flags ──────────────────────────────────────────────────────────────

/**
 * Will this store's state be needed?
 *
 * Now: GST is charged and only StoreMink's own state is known, so the
 * payment would be refused (`PAYMENT_REFUSAL.needsState`). Later: GST is
 * charged when the renewal is issued and the merchant has no state anywhere,
 * so that invoice would fall back to StoreMink's state. While GST is off,
 * `placeOfSupplyFor` gives `unknown` rather than the supplier fallback, which
 * is why both bases count for the renewal.
 */
function needsStateFor(
  snap: Snap,
  renewalTerms: TaxTerms,
  paying: boolean,
): boolean {
  const basis = snap.placeOfSupply.basis;
  // Now: the payment's own refusal (`paymentTaxRefusal`, R1-01).
  const now = paying && paymentTaxRefusal(snap) === "needsState";
  const later =
    renewalTerms.active && (basis === "supplier_state" || basis === "unknown");
  return now || later;
}

/** GST is charged now and the business is outside India: a payment is refused. */
function outsideIndiaFor(snap: Snap, paying: boolean): boolean {
  return paying && paymentTaxRefusal(snap) === "outsideIndia";
}

/** The place of supply as the renewal's invoice would read it. */
function placeAtRenewal(
  snap: Snap,
  renewalTerms: TaxTerms,
): QuotePlaceOfSupply {
  const { code, basis } = snap.placeOfSupply;
  const supplier = snap.tax.supplierStateCode;
  if (renewalTerms.active && basis === "unknown" && supplier) {
    return { code: supplier, basis: "supplier_state" };
  }
  if (!renewalTerms.active && basis === "supplier_state") {
    return { code: null, basis: "unknown" };
  }
  return { code, basis };
}

/** Can a renewal be charged automatically at all (the worker's `charge`)? */
function chargeAvailable(): boolean {
  return RECURRING_CHARGE_VERIFIED && getPlatformRazorpayCreds() !== null;
}

function periodOf(value: string | null | undefined): QuotePeriod {
  return value === "yearly" ? "yearly" : "monthly";
}

/**
 * A renewal of `shape`, beginning at `cycleStart`, priced under the terms in
 * force when its invoice is issued (four days before), as the renewal worker
 * prices it (`collectOne`).
 */
async function renewalOf(input: {
  shape: { plan: string; period: QuotePeriod; billedLocations: number };
  cycleStart: Date;
  snap: Snap;
  priceFor: QuotePriceFor;
}): Promise<{ built: BuiltInvoice; terms: TaxTerms; issuedAt: Date }> {
  const plan = normalizePlan(input.shape.plan);
  const issuedAt = collectionStartsAt(input.cycleStart);
  const terms = termsLater(input.snap.terms, issuedAt);
  const place = placeAtRenewal(input.snap, terms);
  const price = await input.priceFor(plan, input.shape.period);
  const built = buildSubscriptionInvoice({
    planLabel: PLAN_META[plan].name,
    period: input.shape.period,
    planPaise: price.planPaise,
    locations:
      input.shape.billedLocations > 0
        ? { count: input.shape.billedLocations, unitPaise: price.locationPaise }
        : undefined,
    tax: taxContextFor(terms, input.snap.tax.supplierStateCode, place.code),
  });
  return { built, terms, issuedAt };
}

// ── Subscribe ──────────────────────────────────────────────────────────────

/**
 * What subscribing would charge now and at the first renewal: `startEnrolment`
 * read without writing (GST design 5.6).
 *
 * In `startEnrolment`'s order: the Free plan, the platform's payment keys, an
 * earlier captured purchase (RC-F1b: nothing to pay, it is finished instead),
 * a live subscription, the prices, the tax reading, the cycle, the cycle's
 * draft (the resumed-order rule), the renewal and its autopay checks.
 */
export async function quoteSubscribe(input: {
  storeId: string;
  plan: Plan;
  period: QuotePeriod;
  priceFor: QuotePriceFor;
  now?: Date;
}): Promise<QuoteOutcome<SubscribeQuote>> {
  try {
    return await subscribeQuote(input, null);
  } catch (err) {
    logError("billing.quote.subscribe", err, { storeId: input.storeId });
    return { ok: false, error: CHECK_FAILED };
  }
}

async function subscribeQuote(
  input: {
    storeId: string;
    plan: Plan;
    period: QuotePeriod;
    priceFor: QuotePriceFor;
    now?: Date;
  },
  known: SubscriptionFacts | null,
): Promise<QuoteOutcome<SubscribeQuote>> {
  const now = input.now ?? new Date();

  if (input.plan === "free") {
    return { ok: false, error: "The free plan needs no subscription." };
  }
  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return { ok: false, error: "Subscriptions aren't available right now." };
  }

  // ★ RC-F1b: a captured payment on a draft subscription invoice is the
  // purchase the next Subscribe FINISHES, so there is nothing to pay.
  const earlier = await capturedDraftPurchases({
    storeId: input.storeId,
    kind: "subscription",
    limit: 1,
  });
  if (earlier === null) return { ok: false, error: CHECK_FAILED };
  if (earlier.length > 0) {
    const reading = await readSnapshot(input.storeId, now);
    if (!reading.ok) return { ok: false, error: reading.error };
    return earlierSubscribePayment(input, reading.snap.terms);
  }

  const sub = known ?? (await readSubscription(input.storeId));
  if (!sub) return { ok: false, error: CHECK_FAILED };
  if (LIVE_STATES.includes(sub.state)) {
    return { ok: false, error: "This store already has a subscription." };
  }

  const price = await input.priceFor(input.plan, input.period);
  const reading = await readSnapshot(input.storeId, now);
  if (!reading.ok) return { ok: false, error: reading.error };
  const snap = reading.snap;

  const cycle = cycleFrom(now, input.period, sub.enrolCycleSeq);

  // The first renewal, exactly as `startEnrolment` prices it to choose the
  // mandate rail: the base plan under the terms at its issue instant.
  const renewalTerms = termsLater(snap.terms, collectionStartsAt(cycle.end));
  const renewalBuilt = buildSubscriptionInvoice({
    planLabel: PLAN_META[input.plan].name,
    period: input.period,
    planPaise: price.planPaise,
    tax: taxContextFor(
      renewalTerms,
      snap.tax.supplierStateCode,
      snap.tax.placeOfSupply,
    ),
  });
  const autopayRail = autopayRailFor(renewalBuilt.totalPaise);
  if (autopayRail !== null) {
    if (!RECURRING_CHARGE_VERIFIED) {
      return {
        ok: false,
        error: "Autopay is unavailable right now. No payment was taken.",
      };
    }
    const mandateMax = Math.min(
      mandateSizePaise({
        planPaise: price.planPaise,
        taxInclusive: snap.terms.inclusive,
      }),
      AFA_EXEMPT_PAISE,
    );
    if (!mandateFitsGateway(mandateMax)) {
      return {
        ok: false,
        error:
          "This billing option is above Razorpay's autopay limit. Choose a shorter billing period. No payment was taken.",
      };
    }
  }

  // Cycle 1, built under the terms in force NOW.
  const built = buildSubscriptionInvoice({
    planLabel: PLAN_META[input.plan].name,
    period: input.period,
    planPaise: price.planPaise,
    tax: snap.tax,
  });

  // ★★ THE RESUMED-ORDER RULE (GST design 5.3, 5.6). The cycle's draft may
  // already exist from an earlier Subscribe. When only its GST differs and an
  // order is open on it, the merchant RESUMES that order at the draft's total
  // and the issue carves the GST out of it: that is the amount to quote, not
  // the fresh build.
  let payNow = quoteOf(built);
  let resumed = false;
  const draft = await getCycleInvoice(input.storeId, cycle.seq);
  if (draft) {
    if (draft.status === "paid") {
      return { ok: false, error: "This subscription is already paid for." };
    }
    if (draft.status !== "draft") {
      // An issued invoice for this cycle is what the payment would settle.
      payNow = quoteOfInvoice(draft);
    } else {
      const change = enrolmentDraftChange(
        draft,
        built,
        cycle.end.getTime() - cycle.start.getTime(),
      );
      if (change) {
        // A draft holding a captured payment is never rewritten or charged
        // again: the start answers that the earlier payment is being finished.
        const captured = await capturedAttemptForInvoice(
          draft.id,
          input.storeId,
        );
        if (captured === undefined) return { ok: false, error: CHECK_FAILED };
        if (captured) return earlierSubscribePayment(input, snap.terms);
      }
      if (change === "tax") {
        // The start's own decision (R1-03): an order nobody touched is
        // abandoned and the draft rebuilt, so the fresh total is what is
        // charged; any other order is resumed at the draft's total.
        const order = await taxDraftOrder(creds, draft.id, input.storeId);
        if (order === undefined) return { ok: false, error: CHECK_FAILED };
        if (order.kind === "resume") {
          payNow = resumedOrderAmount(draft, snap.tax);
          resumed = true;
        }
      }
    }
  }

  return {
    ok: true,
    quote: {
      kind: "subscribe",
      plan: input.plan,
      period: input.period,
      earlierPayment: false,
      payNow,
      resumed,
      renewal: {
        plan: input.plan,
        period: input.period,
        amount: quoteOf(renewalBuilt),
        issuedAt: collectionStartsAt(cycle.end).toISOString(),
        renewsOn: cycle.end.toISOString(),
        autopay: autopayRail !== null,
      },
      terms: snap.terms,
      needsState: needsStateFor(snap, renewalTerms, true),
      outsideIndia: outsideIndiaFor(snap, true),
    },
  };
}

/** Nothing to pay: an earlier, captured payment is finished instead (RC-F1b). */
function earlierSubscribePayment(
  input: { plan: Plan; period: QuotePeriod },
  terms: TaxTerms,
): QuoteOutcome<SubscribeQuote> {
  return {
    ok: true,
    quote: {
      kind: "subscribe",
      plan: input.plan,
      period: input.period,
      earlierPayment: true,
      payNow: null,
      resumed: false,
      renewal: null,
      terms,
      needsState: false,
      outsideIndia: false,
    },
  };
}

// ── Plan or period change ──────────────────────────────────────────────────

/**
 * What a plan or period change would charge now and from the next renewal:
 * `startPlanChange` read without writing (GST design 5.6).
 *
 * In its order: an earlier, already paid change (RC-F1b: finished instead),
 * `planChangeTerms` (its refusals word for word), then a scheduled change
 * (nothing now, the target plan from the cycle end) or an immediate one (the
 * part period now, applied free when it rounds to nothing).
 */
export async function quotePlanChange(input: {
  storeId: string;
  plan: Plan;
  period: QuotePeriod;
  priceFor: QuotePriceFor;
  locationPrice: LocationPrice;
  now?: Date;
}): Promise<QuoteOutcome<PlanChangeQuote>> {
  try {
    return await planChangeQuote(input, null);
  } catch (err) {
    logError("billing.quote.plan_change", err, { storeId: input.storeId });
    return { ok: false, error: CHECK_FAILED };
  }
}

async function planChangeQuote(
  input: {
    storeId: string;
    plan: Plan;
    period: QuotePeriod;
    priceFor: QuotePriceFor;
    locationPrice: LocationPrice;
    now?: Date;
  },
  known: SubscriptionFacts | null,
): Promise<QuoteOutcome<PlanChangeQuote>> {
  const now = input.now ?? new Date();

  // ★ RC-F1b: a captured payment on a draft add-on invoice that bought a PLAN
  // CHANGE is finished by the next press, so nothing is charged. A location
  // purchase is not this, and the start goes on to charge for the change.
  const found = await capturedDraftPurchases({
    storeId: input.storeId,
    kind: "addon",
    limit: 10,
  });
  if (found === null) return { ok: false, error: CHECK_FAILED };
  if (found.length > 0) {
    const creds = getPlatformRazorpayCreds();
    if (!creds) return { ok: false, error: "Payments aren't available now." };
    for (const purchase of found) {
      const read = await readAddonOrderTarget(creds, purchase.providerOrderId);
      if (!read) return { ok: false, error: CHECK_FAILED };
      if (read.kind !== "plan_change") continue;
      const reading = await readSnapshot(input.storeId, now);
      if (!reading.ok) return { ok: false, error: reading.error };
      return {
        ok: true,
        quote: {
          kind: "change",
          plan: normalizePlan(read.plan),
          period: periodOf(read.period),
          earlierPayment: true,
          timing: "now",
          payNow: null,
          effectiveAt: null,
          renewal: null,
          terms: reading.snap.terms,
          needsState: false,
          outsideIndia: false,
        },
      };
    }
  }

  const decided = await planChangeTerms({
    storeId: input.storeId,
    targetPlan: input.plan,
    targetPeriod: input.period,
    priceFor: input.priceFor,
    locationPrice: input.locationPrice,
    now,
  });
  if (!decided.ok) return { ok: false, error: decided.error };
  const terms = decided.data;

  if (terms.kind === "immediate" && !getPlatformRazorpayCreds()) {
    return { ok: false, error: "Payments aren't available now." };
  }

  const sub = known ?? (await readSubscription(input.storeId));
  if (!sub?.currentPeriodEnd) return { ok: false, error: CHECK_FAILED };
  const cycleStart = new Date(sub.currentPeriodEnd);

  const reading = await readSnapshot(input.storeId, now);
  if (!reading.ok) return { ok: false, error: reading.error };
  const snap = reading.snap;

  // The renewal after the change, through the ONE resolver the worker prices
  // it with: a scheduled change keeps any pending location release; an
  // immediate one applies the target's location count and clears it.
  const fields: ScheduledFields =
    terms.kind === "scheduled"
      ? {
          plan: sub.plan,
          period: sub.period,
          billedLocations: sub.billedLocations,
          scheduledPlan: terms.plan,
          scheduledPeriod: terms.period,
          scheduledLocations: sub.scheduledLocations,
          cancelAtPeriodEnd: false,
        }
      : {
          plan: terms.plan,
          period: terms.period,
          billedLocations: terms.targetLocations,
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          cancelAtPeriodEnd: false,
        };
  const next = resolveNextCycle(fields);
  const renewal = await renewalOf({
    shape: next,
    cycleStart,
    snap,
    priceFor: input.priceFor,
  });
  const route = collectionRoute({
    mandateStatus: sub.mandate?.status ?? null,
    mandateMaxPaise: sub.mandate?.maxAmountPaise ?? null,
    totalPaise: renewal.built.totalPaise,
  });
  const quotedRenewal: QuotedRenewal = {
    plan: normalizePlan(next.plan),
    period: next.period,
    amount: quoteOf(renewal.built),
    issuedAt: renewal.issuedAt.toISOString(),
    renewsOn: cycleStart.toISOString(),
    autopay: route.auto && chargeAvailable(),
  };

  let payNow: AmountQuote | null = null;
  if (terms.kind === "immediate" && terms.prorationPaise > 0) {
    payNow = quoteOf(
      buildAddonInvoice({
        description: terms.description,
        amountPaise: terms.prorationPaise,
        tax: snap.tax,
      }),
    );
  }
  const paying = payNow !== null;

  return {
    ok: true,
    quote: {
      kind: "change",
      plan: terms.plan,
      period: terms.period,
      earlierPayment: false,
      timing: terms.kind === "scheduled" ? "scheduled" : "now",
      payNow,
      effectiveAt: terms.kind === "scheduled" ? terms.effectiveAt : null,
      renewal: quotedRenewal,
      terms: snap.terms,
      needsState: needsStateFor(snap, renewal.terms, paying),
      outsideIndia: outsideIndiaFor(snap, paying),
    },
  };
}

// ── The next renewal ───────────────────────────────────────────────────────

/**
 * The store's next renewal, as the renewal worker will invoice it (GST design
 * 5.6). Null when there is no live subscription, it ends at the period end,
 * or a read fails (logged): Plans & Billing then shows no renewal line rather
 * than a wrong one.
 *
 * ★ When the next cycle's invoice is already issued, its own figures; it is
 * immutable, so they are what is collected.
 */
export async function quoteNextRenewal(input: {
  storeId: string;
  priceFor: QuotePriceFor;
  now?: Date;
}): Promise<RenewalQuote | null> {
  try {
    return await nextRenewal(input);
  } catch (err) {
    logError("billing.quote.next_renewal", err, { storeId: input.storeId });
    return null;
  }
}

async function nextRenewal(input: {
  storeId: string;
  priceFor: QuotePriceFor;
  now?: Date;
}): Promise<RenewalQuote | null> {
  const now = input.now ?? new Date();
  const sub = await readSubscription(input.storeId);
  if (!sub || !LIVE_STATES.includes(sub.state) || !sub.currentPeriodEnd) {
    return null;
  }
  const next = resolveNextCycle(sub);
  if (next.ending) return null;

  const reading = await readSnapshot(input.storeId, now);
  if (!reading.ok) return null;
  const snap = reading.snap;
  const cycleStart = new Date(sub.currentPeriodEnd);

  let amount: AmountQuote;
  let issued = false;
  let issuedAt: Date = collectionStartsAt(cycleStart);
  let terms: TaxTerms;
  const existing = await getCycleInvoice(
    input.storeId,
    sub.currentCycleSeq + 1,
  );
  if (existing?.finalizedAt) {
    amount = quoteOfInvoice(existing);
    issued = true;
    issuedAt = new Date(existing.finalizedAt);
    terms = termsLater(snap.terms, collectionStartsAt(cycleStart));
  } else {
    const renewal = await renewalOf({
      shape: next,
      cycleStart,
      snap,
      priceFor: input.priceFor,
    });
    amount = quoteOf(renewal.built);
    terms = renewal.terms;
  }

  const route = collectionRoute({
    mandateStatus: sub.mandate?.status ?? null,
    mandateMaxPaise: sub.mandate?.maxAmountPaise ?? null,
    totalPaise: amount.totalPaise,
  });
  const autoCollect = route.auto && chargeAvailable();
  return {
    plan: normalizePlan(next.plan),
    period: next.period,
    billedLocations: next.billedLocations,
    amount,
    issued,
    issuedAt: issuedAt.toISOString(),
    renewsOn: cycleStart.toISOString(),
    route,
    autoCollect,
    reason: route.auto ? null : route.reason,
    mandateMaxPaise: sub.mandate?.maxAmountPaise ?? null,
    terms,
    placeOfSupply: placeAtRenewal(snap, terms),
  };
}

/**
 * What one extra location adds to the next renewal, under the terms that
 * renewal is invoiced with (GST design 5.6, 7.5). Null when there is no live
 * subscription, it ends at the period end, the next cycle's plan has no POS,
 * or a read fails (a price read included).
 *
 * ★★ THE DIFFERENCE OF TWO RENEWALS, NOT A STANDALONE LINE (R1-02). On the
 * renewal invoice a location is a line of the subscription invoice and GST is
 * rounded once on the whole, so pricing one location on its own could differ
 * from what it really adds by a paisa (inclusive GST at any rate, exclusive
 * GST at a fractional one). The figure is the renewal with one more location
 * less the renewal as it stands, both built by `renewalOf` exactly as the
 * worker builds them, so it is what adding one actually changes.
 */
export async function quoteLocationRenewal(input: {
  storeId: string;
  locationPrice: LocationPrice;
  /** The live prices, as the renewal worker reads them; the base plan's is
   *  needed because the line is a difference of two whole renewals. */
  priceFor: QuotePriceFor;
  now?: Date;
}): Promise<LocationRenewalQuote | null> {
  try {
    return await locationRenewal(input);
  } catch (err) {
    logError("billing.quote.location_renewal", err, {
      storeId: input.storeId,
    });
    return null;
  }
}

async function locationRenewal(input: {
  storeId: string;
  locationPrice: LocationPrice;
  priceFor: QuotePriceFor;
  now?: Date;
}): Promise<LocationRenewalQuote | null> {
  const now = input.now ?? new Date();
  const sub = await readSubscription(input.storeId);
  if (!sub || !LIVE_STATES.includes(sub.state) || !sub.currentPeriodEnd) {
    return null;
  }
  const next = resolveNextCycle(sub);
  if (next.ending) return null;
  if (limitsFor(normalizePlan(next.plan)).posLocationsIncluded <= 0) {
    return null;
  }
  const reading = await readSnapshot(input.storeId, now);
  if (!reading.ok) return null;
  const snap = reading.snap;
  const cycleStart = new Date(sub.currentPeriodEnd);

  // ★ One price read for both renewals, so they cannot straddle a reprice.
  // The location's price is the one this card shows (the caller's), as
  // before; the plan's comes from the live prices.
  const plan = normalizePlan(next.plan);
  const price = await input.priceFor(plan, next.period);
  const priced: QuotePriceFor = async () => ({
    planPaise: price.planPaise,
    locationPaise: extraLocationPaise(next.period, input.locationPrice),
  });
  const shape = {
    plan,
    period: next.period,
    billedLocations: next.billedLocations,
  };
  const without = await renewalOf({
    shape,
    cycleStart,
    snap,
    priceFor: priced,
  });
  const withOne = await renewalOf({
    shape: { ...shape, billedLocations: shape.billedLocations + 1 },
    cycleStart,
    snap,
    priceFor: priced,
  });
  return {
    perLocation: differenceOf(quoteOf(withOne.built), quoteOf(without.built)),
    issuedAt: withOne.issuedAt.toISOString(),
    renewsOn: cycleStart.toISOString(),
    period: next.period,
    terms: withOne.terms,
  };
}

/** What `more` adds to `base`: each sum's difference, `more`'s rate and mode. */
function differenceOf(more: AmountQuote, base: AmountQuote): AmountQuote {
  return {
    listedPaise: more.listedPaise - base.listedPaise,
    taxablePaise: more.taxablePaise - base.taxablePaise,
    taxPaise: more.taxPaise - base.taxPaise,
    totalPaise: more.totalPaise - base.totalPaise,
    rateBps: more.rateBps,
    inclusive: more.inclusive,
  };
}

// ── The checkout dialog ────────────────────────────────────────────────────

/**
 * The checkout dialog's summary (`quoteCheckout`).
 *
 * ★ SUBSCRIBE OR CHANGE, decided as the buttons decide it: a store on a live
 * paid cycle changes plan (`changeMyPlan` → `startPlanChange`), any other
 * subscribes (`startSubscribe` → `startEnrolment`).
 *
 * ★ A credit pack is its own payment, priced as `startCreditPurchase` prices
 * it: the live pack, `buildAiCreditsInvoice` under the terms in force now.
 * The tax context's states only decide the CGST/SGST or IGST split, which a
 * quote does not show, so the plan quote's terms are enough.
 */
export async function quoteCheckoutFor(input: {
  storeId: string;
  plan: Plan;
  period: QuotePeriod;
  /** A Mink credit pack bought with it, or null. */
  packId: string | null;
  priceFor: QuotePriceFor;
  locationPrice: LocationPrice;
  now?: Date;
}): Promise<CheckoutQuoteResult> {
  try {
    return await checkoutQuote(input);
  } catch (err) {
    logError("billing.quote.checkout", err, { storeId: input.storeId });
    return { ok: false, error: CHECK_FAILED };
  }
}

async function checkoutQuote(input: {
  storeId: string;
  plan: Plan;
  period: QuotePeriod;
  packId: string | null;
  priceFor: QuotePriceFor;
  locationPrice: LocationPrice;
  now?: Date;
}): Promise<CheckoutQuoteResult> {
  const now = input.now ?? new Date();
  const sub = await readSubscription(input.storeId);
  if (!sub) return { ok: false, error: CHECK_FAILED };

  const planQuote = LIVE_STATES.includes(sub.state)
    ? await planChangeQuote({ ...input, now }, sub)
    : await subscribeQuote({ ...input, now }, sub);
  if (!planQuote.ok) return { ok: false, error: planQuote.error };
  const quote = planQuote.quote;

  let pack: AmountQuote | null = null;
  // ★★ THE PACK IS A PAYMENT MADE NOW, WHATEVER THE PLAN STEP IS (R1-05). A
  // scheduled (cheaper) change pays nothing now, so the plan quote's flags are
  // false; the pack's start still refuses a store with no state on record, or
  // outside India, while GST is charged. Its own refusal is ORed in, from the
  // reading `startCreditPurchase` takes, so the dialog never enables Pay for
  // a pack the start then refuses.
  let packRefusal: ReturnType<typeof paymentTaxRefusal> = null;
  if (input.packId) {
    const found = await getMinkCreditPackLive(input.packId);
    if (!found) return { ok: false, error: "Unknown credit pack." };
    pack = quoteOf(
      buildAiCreditsInvoice({
        packLabel: found.name,
        credits: found.credits,
        amountPaise: found.priceInr * 100,
        tax: taxContextFor(quote.terms, null, null),
      }),
    );
    const reading = await readSnapshot(input.storeId, now);
    if (!reading.ok) return { ok: false, error: reading.error };
    packRefusal = paymentTaxRefusal(reading.snap);
  }

  return {
    ok: true,
    plan: quote,
    pack,
    terms: quote.terms,
    needsState: quote.needsState || packRefusal === "needsState",
    outsideIndia: quote.outsideIndia || packRefusal === "outsideIndia",
  };
}
