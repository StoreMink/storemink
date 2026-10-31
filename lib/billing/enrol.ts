import "server-only";

// ★ The mandate rail lives in a client-safe module: this file is `server-only`,
// so a client component importing even the TYPE from here fails the build.
import {
  AFA_EXEMPT_PAISE,
  autopayRailFor,
  type MandateMethod,
} from "./mandate-types";
export { MANDATE_METHODS, normalizeMandateMethod } from "./mandate-types";
export type { MandateMethod } from "./mandate-types";

/**
 * Enrolment — a merchant's first paid cycle, and the mandate for later ones.
 *
 * Design: docs/billing-architecture.md §7.
 *
 * ★★ THE FIRST CYCLE IS ALWAYS ON SESSION, with the merchant watching. When the
 * same verified payment also registers the mandate used by later automatic
 * renewal. A new subscription now fails before Checkout when that mandate
 * cannot be prepared; silently accepting a one-time first cycle misrepresents
 * an autopay subscription and guarantees a surprise manual renewal.
 *
 * ★★ THE PLAN IS NOT GRANTED UNTIL THE PAYMENT IS CAPTURED. There is no grace on
 * the first cycle — grace exists for RENEWALS, where the merchant has already
 * paid for something. Granting it up front would hand anyone 48 hours of Pro for
 * starting a checkout they never finish.
 *
 * ⚠ TWO PLACES RECORD THE PLAN, and both must move. `stores.plan` is the
 * ENTITLEMENT — `effectivePlan` and every gate in the product read it —
 * while `billing_subscriptions` is this system's own state. Writing one without
 * the other gives a merchant either a bill with no features or features with no
 * bill.
 */

import { and, desc, eq, gt, isNull, notInArray } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { loggableError, pgConstraint, pgErrorCode } from "@/lib/db/errors";
import {
  billingAccounts,
  billingInvoices,
  billingMandates,
  billingPaymentAttempts,
  billingSubscriptions,
  planEvents,
  stores,
} from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  rzpCreateAuthorizationOrder,
  rzpCreateOrder,
  rzpFetchOrder,
  rzpFetchOrderPayments,
  rzpCreateCustomer,
  rzpFetchPayment,
  verifyCapturedCheckoutPayment,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";
import { billingMayApplyPlan } from "@/lib/payments/plan-change";
import { PLAN_META, limitsFor, type Plan } from "@/lib/plans";
import {
  collectionStartsAt,
  cycleFrom,
  mandateFitsGateway,
  mandateSizePaise,
} from "./cycle";

/**
 * How long a mandate stays authorised.
 *
 * ★ Deliberately longer than one cycle. Razorpay wants an absolute expiry, and
 * a mandate that lapses with the cycle would need re-authorising every renewal
 * — which is the friction autopay exists to remove. Five years is inside their
 * accepted range and well past any plan we sell.
 */
const MANDATE_YEARS = 5;
import { RECURRING_CHARGE_VERIFIED } from "./gateway";
import { resolveBillingEmail } from "@/lib/email/billing-emails";
import {
  buildSubscriptionInvoice,
  INVOICE_BODY_KINDS,
  type BuiltInvoice,
} from "./invoice";
import {
  amountDueForInvoice,
  ensureRenewalInvoice,
  finalizeInvoice,
  getInvoice,
  getCycleInvoice,
  reshapeDraftSubscriptionInvoice,
  type InvoiceRow,
} from "./invoice-store";
import { paymentCapturedAt, readTaxForPayment } from "./payment-tax";
import { taxContextFor, termsLater } from "./tax-terms";
import {
  beginAttempt,
  capturedAttemptForInvoice,
  capturedDraftPurchases,
  fileRecoveredPurchase,
  settleAttempt,
  verifyRecoveredCapture,
  type PurchaseCompletion,
} from "./collect";
import { notifyPlanActivated } from "./receipts";

type BillingPeriod = "monthly" | "yearly";

/** The first cycle a subscription ever has. */
const FIRST_CYCLE = 1;

/** States in which the store is already ON a paid cycle we are billing for. */
const LIVE_STATES = ["active", "past_due", "grace"] as const;

/** States a subscription is left in once it has ended. */
const ENDED_STATES = ["downgraded", "cancelled"] as const;

export interface EnrolmentStart {
  invoiceId: string;
  attemptId: string;
  providerOrderId: string;
  keyId: string;
  amountPaise: number;
  /** What the merchant will be asked to authorise for future cycles. */
  suggestedMandateMaxPaise: number;
  /** The Razorpay customer Checkout must bind to the recurring authorisation. */
  providerCustomerId: string;
  /** The rail the order was created for; Checkout must be opened to match. */
  mandateMethod: MandateMethod;
  /**
   * Will future cycles be collected automatically?
   *
   * ★ False means no mandate was requested at all, because the recurring charge
   * is above RBI's AFA-exempt limit and no supported rail can carry it. The
   * merchant pays cycle 1 now and is INVOICED for renewals — the screen must
   * say so rather than implying autopay.
   */
  autopay: boolean;
}

export type EnrolmentResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      /**
       * Set when starting found an EARLIER purchase whose payment was already
       * captured (the merchant closed the tab before the confirm) and finished
       * it instead of opening a second payment: `completed` when the plan is
       * now active, `waiting` when it is left for a person or the next pass.
       * The error text says which, in the merchant's words.
       */
      recovered?: "completed" | "waiting";
    };

/** A repeated Subscribe that finished the earlier, already paid purchase. */
export const ENROLMENT_RECOVERED_MESSAGE =
  "Your earlier payment went through, and your plan is now active.";

/** A repeated Subscribe whose earlier, already paid purchase could not be finished yet. */
export const ENROLMENT_RECOVERY_WAITING_MESSAGE =
  "Your earlier payment went through, and we'll switch your plan on shortly. Please don't pay again. If it hasn't changed within a day, write to support@storemink.com.";

/** A confirm whose payment is in but whose plan could not be switched yet. */
export const ENROLMENT_PAID_NOT_SWITCHED_MESSAGE =
  "Your payment went through, and we'll switch your plan on shortly. Please don't pay again. If it hasn't changed within a day, write to support@storemink.com.";

/**
 * Create or update the party the invoice is addressed to.
 *
 * Idempotent per store, and separate from the subscription because it outlives
 * one: a merchant who cancels and re-subscribes keeps their billing identity.
 */
export async function ensureBillingAccount(
  storeId: string,
  details: {
    billingEmail?: string | null;
    legalName?: string | null;
    gstin?: string | null;
    /** NUMERIC GST state code ("07", "29") — the DB CHECK refuses anything else. */
    stateCode?: string | null;
    address?: Record<string, unknown>;
  } = {},
): Promise<boolean> {
  try {
    await withService(async (db) => {
      await db
        .insert(billingAccounts)
        .values({
          storeId,
          billingEmail: details.billingEmail ?? null,
          legalName: details.legalName ?? null,
          gstin: details.gstin ?? null,
          stateCode: details.stateCode ?? null,
          address: details.address ?? {},
        })
        .onConflictDoUpdate({
          target: billingAccounts.storeId,
          set: {
            // Only overwrite what was actually supplied — a partial edit must
            // not blank a field the caller did not mention.
            ...(details.billingEmail !== undefined
              ? { billingEmail: details.billingEmail }
              : {}),
            ...(details.legalName !== undefined
              ? { legalName: details.legalName }
              : {}),
            ...(details.gstin !== undefined ? { gstin: details.gstin } : {}),
            ...(details.stateCode !== undefined
              ? { stateCode: details.stateCode }
              : {}),
            ...(details.address !== undefined
              ? { address: details.address }
              : {}),
            updatedAt: new Date().toISOString(),
          },
        });
    });
    return true;
  } catch (err) {
    // ★ NEVER THE RAW ERROR (R3-03). A failed insert's message is Drizzle's
    // "Failed query: ... params: ...", and the params here are the merchant's
    // legal name, GSTIN and address: personal data that must not reach Cloud
    // Logging. The database's own reason, its code and the constraint are
    // enough to act on.
    logError("billing.ensure_account", loggableError(err), {
      storeId,
      code: pgErrorCode(err),
      constraint: pgConstraint(err),
    });
    return false;
  }
}

/**
 * Begin enrolment: issue the first invoice and open a payment for it.
 *
 * Returns what the client needs to open Razorpay Checkout. Nothing about the
 * merchant's plan changes here — see `confirmEnrolment`.
 */
export async function startEnrolment(input: {
  storeId: string;
  plan: Plan;
  period: BillingPeriod;
  /** Card unless the merchant chose UPI Autopay on the review step. */
  mandateMethod?: MandateMethod;
  priceFor: (
    plan: Plan,
    period: BillingPeriod,
  ) => Promise<{ planPaise: number; locationPaise: number }>;
  now?: Date;
}): Promise<EnrolmentResult<EnrolmentStart>> {
  const now = input.now ?? new Date();

  if (input.plan === "free") {
    return { ok: false, error: "The free plan needs no subscription." };
  }
  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return { ok: false, error: "Subscriptions aren't available right now." };
  }

  // ★★ AN EARLIER PURCHASE WHOSE PAYMENT WAS CAPTURED IS FINISHED, NOT SOLD
  // AGAIN (RC-F1b). A merchant who paid and closed the tab before the confirm
  // has a captured payment on a draft invoice. Going on from here would reuse
  // that draft with a NEW order (a second charge), or reshape it for another
  // period despite the money on it. Finish the purchase they already paid for
  // and tell them; a failed read refuses, because "we could not check" is not
  // "nothing was paid".
  const earlier = await finishEarlierEnrolment(input.storeId, now);
  if (earlier) return earlier;

  // ★★ REFUSE IF THIS STORE IS ALREADY ON A PAID CYCLE. Without this,
  // `seedSubscription`'s upsert rewrites `plan`/`period` on a LIVE subscription
  // before anything is paid — a merchant on Basic could point their record at
  // Pro and dismiss the payment window. The flow would then fail confusingly
  // ("already paid for") because cycle 1's invoice is long settled, leaving the
  // record changed and the money not taken. Changing tier mid-cycle is a
  // PRORATED plan change, a different operation from enrolling.
  const existing = await currentSubscription(input.storeId);
  if (existing === null) {
    // Fails closed: unable to read means unable to rule out double-billing.
    return { ok: false, error: "Couldn't check your subscription. Try again." };
  }
  if (LIVE_STATES.includes(existing.state as (typeof LIVE_STATES)[number])) {
    return {
      ok: false,
      error: "This store already has a subscription.",
    };
  }

  const price = await input.priceFor(input.plan, input.period);

  // ★★ ONE TAX READING FOR THIS PAYMENT (GST design 5.2): the terms in force
  // now, the merchant's place of supply and the particulars stamped on the
  // invoice, read together. It refuses, in the merchant's words, a payment the
  // invoice could not describe correctly; nothing has been written yet.
  const reading = await readTaxForPayment(input.storeId, now, "billing.enrol");
  if (!reading.ok) return { ok: false, error: reading.error };
  const snap = reading.snap;
  // ★★ CAPPED AT THE AFA LIMIT, because authority above it can never be
  // exercised on card or UPI. The 1.18 × 1.5 provision exists so a REPRICE does
  // not lock a subscriber out of their own renewal — real headroom while both
  // the old and new charge stay under ₹15,000 (Pro monthly: ₹2,400 charge,
  // ₹5,000 ceiling, a reprice to ₹4,000 still auto-collects). Above the limit
  // it buys nothing: a charge of ₹15,001 is manual whatever the ceiling says,
  // so Basic yearly was asking a merchant to authorise ₹27,000 against a
  // ₹15,000 charge that is already at the maximum a mandate can carry.
  // ⚠ Phase 2's eNACH rail has no AFA limit (₹1 crore), so this cap moves under
  // the rail decision when that lands.
  const mandateMax = Math.min(
    mandateSizePaise({
      planPaise: price.planPaise,
      taxInclusive: snap.terms.inclusive,
    }),
    AFA_EXEMPT_PAISE,
  );

  // The cycle comes first now: the rail is decided by the FIRST RENEWAL's
  // charge, and that renewal is collected from four days before this cycle
  // ends.
  const cycle = cycleFrom(now, input.period, existing.enrolCycleSeq);

  // ★★ CAN THIS PLAN BE COLLECTED AUTOMATICALLY AT ALL? Decided from the
  // RECURRING charge, not cycle 1's amount: the mandate exists to carry future
  // renewals, and cycle 1 is taken on-session either way.
  //
  // RBI's AFA-exempt limit is ₹15,000 on BOTH cards and UPI, so Pro yearly at
  // ₹24,000 can never be auto-debited without the merchant authenticating every
  // single renewal. We used to register a ₹43,000 mandate for it anyway —
  // authority we ask for on the Razorpay screen and can never exercise.
  //
  // ★★ PRICED UNDER THE TERMS IN FORCE WHEN THAT RENEWAL IS COLLECTED. A
  // merchant subscribing during the notice period for an exclusive GST start
  // pays cycle 1 without GST, but their first renewal carries it: Basic yearly
  // is then ₹17,700, above the AFA limit, so no mandate could ever take it.
  // Deciding the rail from today's terms would set one up anyway.
  const renewalTerms = termsLater(snap.terms, collectionStartsAt(cycle.end));
  const recurringPaise = buildSubscriptionInvoice({
    planLabel: PLAN_META[input.plan].name,
    period: input.period,
    planPaise: price.planPaise,
    tax: taxContextFor(
      renewalTerms,
      snap.tax.supplierStateCode,
      snap.tax.placeOfSupply,
    ),
  }).totalPaise;
  const autopayRail = autopayRailFor(recurringPaise);

  // ★ THE AMOUNT PICKS THE RAIL; the merchant may only step ACROSS to card,
  // never up to something the amount cannot carry. UPI Autopay is the default
  // because it needs no card on file; the card escape exists because the rail
  // is fixed on the order, so a merchant with no UPI app would otherwise be
  // unable to subscribe at all.
  const chosenRail: MandateMethod | null =
    autopayRail === null
      ? null
      : input.mandateMethod === "card"
        ? "card"
        : autopayRail;

  // ★★ THE CARVE-OUT, and it is deliberately NARROW. The refusal below exists
  // because turning a first cycle into an ordinary payment SILENTLY surprises
  // the merchant with a manual invoice next renewal — that is autopay failing
  // when it should have worked. This branch is the other case: autopay is
  // structurally impossible for this amount, so there is nothing to fail. We
  // take cycle 1 on the verified one-time checkout and SAY renewals are
  // invoiced. Not silent, and the alternative is refusing to sell a yearly plan
  // at all.
  const autopayImpossible = autopayRail === null;

  if (!autopayImpossible) {
    // A paid subscription is an autopay product. Never silently turn its first
    // cycle into an ordinary payment: that succeeds today and surprises the
    // merchant with a manual invoice next renewal.
    if (!RECURRING_CHARGE_VERIFIED) {
      return {
        ok: false,
        error: "Autopay is unavailable right now. No payment was taken.",
      };
    }
    if (!mandateFitsGateway(mandateMax)) {
      return {
        ok: false,
        error:
          "This billing option is above Razorpay's autopay limit. Choose a shorter billing period. No payment was taken.",
      };
    }
  }
  const customer = await ensureRzpCustomer(creds, input.storeId);
  if (!customer.ok) {
    // ★ TWO CAUSES, TWO SENTENCES. "Missing contact" is fixable by the merchant
    // in a minute; a gateway error is not, and telling them to go and edit a
    // phone number that is already correct wastes their time and ours.
    return {
      ok: false,
      error:
        customer.reason === "missing-contact"
          ? "We couldn't prepare autopay: this store has no billing email and mobile number on file. Add both under Settings \u2192 Taxes & invoices, then try again. No payment was taken."
          : "We couldn't prepare autopay right now. Please try again in a moment. No payment was taken.",
    };
  }
  const customerId = customer.id;

  // ★ No locations on a first cycle. Extra shops are bought AFTER a plan is
  // live, so billing for them here would charge for something nobody has.
  // Cycle 1 is built under the terms in force NOW.
  const built = buildSubscriptionInvoice({
    planLabel: PLAN_META[input.plan].name,
    period: input.period,
    planPaise: price.planPaise,
    tax: snap.tax,
  });

  // ★★ CYCLE 1's INVOICE IS RAISED BEFORE THE MERCHANT HAS FINISHED CHOOSING.
  // `ensureRenewalInvoice` is idempotent on (store, kind, cycle_seq) — right for
  // a RENEWAL, wrong here, because the invoice appears the first time anyone
  // opens the payment window and they may still change plan or period. Reused
  // blindly it charges the FIRST shape they ever picked while
  // `billing_subscriptions` records the latest, and `activate` reads the
  // SUBSCRIPTION: measured on production 2026-09-06, a merchant who chose Pro
  // monthly, dismissed Checkout, then chose Pro yearly was quoted ₹2,400 for a
  // full year of Pro — ₹21,600 short. Reversed, they overpay by the same.
  //
  // ★★ THIS RUNS BEFORE `seedSubscription`, and the ordering is the point: that
  // write is what `activate` later reads, so recording a shape we then fail to
  // bill for is exactly how the two halves came apart. Nothing records the new
  // choice until we know the invoice can carry it.
  const stale = await staleEnrolmentInvoice(input.storeId, built, cycle);
  if (stale?.cause === "tax") {
    // ★★ ONLY GST CHANGED (it started, or its rate moved): the merchant is
    // buying the same plan for the same period. The "earlier plan choice"
    // refusal below is for a CHANGED CHOICE and is never shown for this.
    //
    // RC-F1b's rule first: a draft holding a captured payment is the earlier
    // purchase, finished at the top or waiting for the hourly check, and is
    // never rewritten.
    const captured = await capturedAttemptForInvoice(stale.id, input.storeId);
    if (captured === undefined) {
      return {
        ok: false,
        error: "Couldn't check your subscription. Try again.",
      };
    }
    if (captured) {
      return {
        ok: false,
        error: ENROLMENT_RECOVERY_WAITING_MESSAGE,
        recovered: "waiting",
      };
    }
    // ★★ AN ORDER NOBODY TOUCHED IS ABANDONED, ANY OTHER IS RESUMED (R1-03).
    // A touched order may still be paid, so it is resumed at the draft's
    // total and `issueInvoice` carves the GST out of what is paid (or, when
    // no reading reproduces that total, files it for a person). An order the
    // gateway says nobody has touched is freed first, on the shape branch's
    // own proof (`inspectResumable`), and the draft is rebuilt at the GST in
    // force: otherwise a merchant who closed Checkout before a rate cut or a
    // switch-off is still asked for the old, higher amount. An unreadable
    // order is never untouched. With no order on it at all, the draft is
    // simply rebuilt.
    const order = await taxDraftOrder(creds, stale.id, input.storeId);
    if (order === undefined) {
      return {
        ok: false,
        error: "Couldn't check your subscription. Try again.",
      };
    }
    let rebuild = order.kind === "none";
    if (order.kind === "abandon") {
      const dropped = await settleAttempt(order.attemptId, "failed", {
        providerOrderId: order.providerOrderId,
        failureCode: "tax_changed",
        failureReason:
          "Abandoned an unpaid order whose GST no longer applies; the draft is rebuilt at the GST in force.",
        now,
      });
      // Only a settled attempt frees the order. A claim that lost a race
      // leaves it as it is, and the resume below hands it back unchanged.
      if (dropped === "failed") {
        // The shape branch's re-check: the hourly reconcile may have recorded
        // a capture since the check at the top.
        const again = await capturedAttemptForInvoice(stale.id, input.storeId);
        if (again === undefined) {
          return {
            ok: false,
            error: "Couldn't check your subscription. Try again.",
          };
        }
        if (again) {
          return {
            ok: false,
            error: ENROLMENT_RECOVERY_WAITING_MESSAGE,
            recovered: "waiting",
          };
        }
        rebuild = true;
      }
    }
    if (rebuild) {
      await reshapeDraftSubscriptionInvoice({
        invoiceId: stale.id,
        storeId: input.storeId,
        periodStart: cycle.start,
        periodEnd: cycle.end,
        dueAt: now,
        built,
        stamp: snap.stamp,
      });
    }
  } else if (stale) {
    const inFlight = await inspectResumable(creds, stale.id, input.storeId);
    // The old amount may already be at the gateway. Free it FIRST, on the same
    // untouched-order proof the rail replacement uses — rewriting the invoice
    // while an old order stays payable would let ₹2,400 settle ₹24,000.
    const freed =
      !inFlight ||
      (inFlight.untouched &&
        (await settleAttempt(inFlight.resumable.id, "failed", {
          providerOrderId: inFlight.resumable.providerOrderId,
          failureCode: "shape_changed",
          failureReason:
            "Abandoned an unpaid order for a plan or period the merchant then changed.",
          now,
        })) === "failed");

    if (!freed) {
      // ★ A payment for the EARLIER choice is genuinely still in flight. Neither
      // outcome is safe: rewriting the invoice lets that payment settle the
      // wrong amount, and leaving it lets them pay for one shape and be granted
      // another. Say so — it clears on its own within minutes.
      return {
        ok: false,
        error:
          "A payment for your earlier plan choice is still going through. Finish it, or give it a minute and try again.",
      };
    }

    // ★★ NEVER RESHAPE A DRAFT THAT HOLDS A CAPTURED PAYMENT (RC-F1b). The
    // check at the top found none, but the hourly reconcile may have recorded
    // one since; rewriting the invoice would let money paid for one shape
    // settle another.
    const captured = await capturedAttemptForInvoice(stale.id, input.storeId);
    if (captured === undefined) {
      return {
        ok: false,
        error: "Couldn't check your subscription. Try again.",
      };
    }
    if (captured) {
      return {
        ok: false,
        error: ENROLMENT_RECOVERY_WAITING_MESSAGE,
        recovered: "waiting",
      };
    }

    // ★ A refusal here is not a failure: it means the invoice is no longer a
    // plain draft, so it is a document or a debt and the merchant finishes what
    // they started rather than being blocked.
    await reshapeDraftSubscriptionInvoice({
      invoiceId: stale.id,
      storeId: input.storeId,
      periodStart: cycle.start,
      periodEnd: cycle.end,
      dueAt: now,
      built,
      stamp: snap.stamp,
    });
  }

  // ★ Ensure the subscription row FIRST, in a non-entitling state. It is what
  // makes enrolment resumable: a merchant who closes the tab and comes back
  // finds the same cycle_seq, so `ensureRenewalInvoice` returns the same invoice
  // instead of issuing a second one.
  const seeded = await seedSubscription({
    storeId: input.storeId,
    plan: input.plan,
    period: input.period,
    cycle,
  });
  if (!seeded) return { ok: false, error: "Couldn't start the subscription." };

  // ★ Stamp the reading's particulars. An existing draft keeps its own;
  // `issueInvoice` restamps whatever it issues, so a GSTIN saved since is
  // printed without rewriting the draft here.
  const invoice = await ensureRenewalInvoice({
    storeId: input.storeId,
    cycleSeq: cycle.seq,
    periodStart: cycle.start,
    periodEnd: cycle.end,
    dueAt: now,
    built,
    stamp: snap.stamp,
  });
  if (!invoice) return { ok: false, error: "Couldn't prepare your invoice." };

  if (invoice.status === "paid") {
    return { ok: false, error: "This subscription is already paid for." };
  }

  // ★★ DELIBERATELY NOT FINALIZED HERE. A RENEWAL is an obligation — the
  // merchant already has the plan, so the worker issues a real document at T−4d
  // and they pay against its number. An ENROLMENT is an OFFER: nothing is owed
  // until they pay, and most abandoned checkouts never will. Finalizing up front
  // did three bad things at once:
  //
  //   • burned a number in the gapless GST series for a document nobody ever
  //     received — the exact waste that allocating ON finalize exists to prevent
  //     (billing_03, and the §28 credit-note reasoning);
  //   • made the invoice `open`, so `listPayableInvoices` showed "you have an
  //     invoice to pay" on /dashboard/plans for a plan that was never granted;
  //   • dated the document to the day they clicked Subscribe rather than the day
  //     they paid.
  //
  // `confirmEnrolment` finalizes once the payment verifies. The draft carries no
  // number and appears nowhere.

  const amountDue = await amountDueForInvoice(invoice.id);
  if (amountDue === null || amountDue <= 0) {
    return { ok: false, error: "Couldn't work out what's due." };
  }

  const attemptInput = {
    invoiceId: invoice.id,
    storeId: input.storeId,
    amountPaise: amountDue,
    mode: "manual" as const,
    // Durable before checkout. Confirmation copies this exact value into the
    // mandate rather than trusting the browser or recomputing after a reprice.
    mandateMaxPaise: mandateMax,
  };
  const mandateMethod: MandateMethod = chosenRail ?? "card";
  let attempt = await beginAttempt(attemptInput);

  // ★★ REFUSED BY `billing_payment_attempts_one_in_flight` — and this used to be
  // a DEAD END. Dismissing the Razorpay modal leaves the attempt `processing`
  // forever (nothing tells us a modal was closed), so every later Subscribe was
  // answered with "a payment is already in progress" and the merchant could
  // never subscribe at all. Reproducible in two clicks.
  //
  // The fix is the one §18 checkout already uses: a Razorpay ORDER stays payable
  // until it is paid, so hand the SAME order back rather than opening a second
  // one. No staleness guess, no duplicate charge, and a resumed tab simply works.
  if (!attempt) {
    // ★ THE RAIL IS FIXED ON THE EXISTING ORDER, so resuming normally hands
    // back whatever rail that order was created with — the order is what stays
    // payable, and minting a second one is the duplicate charge this branch
    // exists to prevent. Read it back rather than echoing the request.
    const found = await inspectResumable(creds, invoice.id, input.storeId);
    if (!found) {
      // In flight but with no order to resume — a race between two Subscribe
      // clicks, caught before either reached the gateway. Waiting IS the answer.
      return {
        ok: false,
        error: "A payment is already in progress. Give it a moment.",
      };
    }
    const { resumable } = found;
    const resumedMethod: MandateMethod = found.method;

    // ★★ BUT AN ORDER NOBODY EVER PAID AGAINST IS NOT WORTH PINNING A RAIL TO.
    // Dismissing Checkout leaves the attempt `processing` with nothing to say a
    // modal was closed, so without this a merchant who once opened a card
    // authorisation is served cards for the next 72 hours — however many times
    // they pick UPI Autopay — until reconciliation gives up on that attempt.
    // The rail is chosen once and cannot be edited afterwards, so serving the
    // wrong one is not a cosmetic mismatch: it is the wrong mandate.
    //
    // Replacement is allowed ONLY on the gateway's own word that the order is
    // untouched — `created`, zero attempts, nothing paid. That is proof no
    // payment instrument has ever been presented against it, which is exactly
    // the condition under which abandoning it cannot cost anyone money. An
    // unreadable order is NOT untouched: we resume and report the truth.
    if (
      chosenRail !== null &&
      resumedMethod !== mandateMethod &&
      found.untouched
    ) {
      const dropped = await settleAttempt(resumable.id, "failed", {
        providerOrderId: resumable.providerOrderId,
        failureCode: "rail_changed",
        failureReason: `Abandoned an unpaid ${resumedMethod} authorisation; the merchant chose ${mandateMethod}.`,
        now,
      });
      // Only a settled attempt frees the one-in-flight index. If the claim lost
      // a race the merchant simply resumes, which is the safe outcome.
      if (dropped === "failed") attempt = await beginAttempt(attemptInput);
    }

    if (!attempt) {
      return {
        ok: true,
        data: {
          mandateMethod: resumedMethod,
          invoiceId: invoice.id,
          attemptId: resumable.id,
          providerOrderId: resumable.providerOrderId,
          keyId: creds.keyId,
          amountPaise: resumable.amountPaise,
          suggestedMandateMaxPaise: resumable.mandateMaxPaise ?? mandateMax,
          // Checkout requires the same customer binding on every open. The
          // order carrying customer_id is not enough by itself.
          providerCustomerId: customerId,
          autopay: chosenRail !== null,
        },
      };
    }
  }

  const notes = {
    store_id: input.storeId,
    invoice_id: invoice.id,
    // The idempotency key travels with the payment, so reconciliation can
    // match it even if we never see the response.
    sm_billing_key: attempt.idempotencyKey,
  };
  // ★★ NO MANDATE WHEN NONE COULD EVER FIRE. A plain one-time order takes
  // cycle 1 on the checkout that IS verified in production, and the merchant is
  // told renewals are invoiced. Creating an authorisation order here would ask
  // them to authorise a ceiling above the AFA limit — permission we could never
  // exercise, on a screen that reads like autopay.
  const order =
    chosenRail === null
      ? await rzpCreateOrder(creds, {
          amountPaise: amountDue,
          receipt: invoice.invoiceRef ?? invoice.id.slice(0, 30),
          notes,
        })
      : await rzpCreateAuthorizationOrder(creds, {
          amountPaise: amountDue,
          customerId,
          // ★ Declared on the ORDER, not left to Checkout — omitting it is what made
          // every enrolment a card mandate regardless of what the merchant wanted.
          method: chosenRail,
          terms: {
            maxAmountPaise: mandateMax,
            // The mandate outlives the cycle it was authorised in; Razorpay wants
            // Unix SECONDS, not milliseconds.
            expireAtUnix: Math.floor(
              new Date(
                now.getTime() + MANDATE_YEARS * 365 * 86_400_000,
              ).getTime() / 1000,
            ),
            frequency: input.period === "yearly" ? "yearly" : "monthly",
          },
          receipt: invoice.invoiceRef ?? invoice.id.slice(0, 30),
          description: "StoreMink subscription",
          notes,
        });
  if (!order.ok) {
    // A rejected order means nothing was created at the gateway, so the attempt
    // is genuinely dead. An UNKNOWN is left in flight for reconciliation.
    await settleAttempt(
      attempt.attemptId,
      order.outcome === "unknown" ? "unknown" : "failed",
      { failureCode: "order_create", failureReason: order.error, now },
    );
    return {
      ok: false,
      error: "Couldn't start the payment. Please try again.",
    };
  }

  await settleAttempt(attempt.attemptId, "processing", {
    providerOrderId: order.data.id,
    now,
  });

  return {
    ok: true,
    data: {
      mandateMethod,
      invoiceId: invoice.id,
      attemptId: attempt.attemptId,
      providerOrderId: order.data.id,
      keyId: creds.keyId,
      amountPaise: amountDue,
      suggestedMandateMaxPaise: mandateMax,
      providerCustomerId: customerId,
      autopay: chosenRail !== null,
    },
  };
}

/**
 * The in-flight attempt for this invoice, if it has an order we can re-open.
 *
 * ★ `billing_payment_attempts_one_in_flight` covers THREE states —
 * `created`, `processing`, `authorized` — and only ONE of them is resumable:
 *
 *   created     no gateway order exists yet, so there is nothing to re-open.
 *               (Also caught by the providerOrderId check below.)
 *   processing  the order exists and was never paid. RESUMABLE.
 *   authorized  the money is already authorized. Re-opening checkout here would
 *               invite a second authorization on the same invoice.
 *
 * So the filter is deliberate, not incidental — widen it and `authorized`
 * becomes a double-charge invitation.
 *
 * ⚠ TEST GAP: the db mock does not evaluate WHERE clauses, so the `authorized`
 * exclusion is argued here rather than pinned by a test. The `created` case IS
 * covered, via the providerOrderId check.
 */
const RESUMABLE_STATE = "processing";

/**
 * The enrolled cycle's existing invoice, but ONLY when it no longer matches
 * what is being bought and can still be rewritten.
 *
 * ★★ THE COMPARISON IS AMOUNT + CYCLE **LENGTH**, NEVER THE ENDPOINTS. A cycle
 * is anchored to the instant it was raised (`cycleFrom(now, …)`), so two
 * Subscribe clicks a minute apart legitimately produce different period
 * endpoints for the very same plan. Comparing instants would call every
 * ordinary resume a changed plan — abandoning the order the resume branch
 * exists to protect, and refusing a merchant who is simply mid-payment.
 *
 * ★ The length is what separates a 30-day first cycle from a 365-day one, which
 * is the case the amount alone can miss if an operator ever prices two shapes
 * the same.
 *
 * Returns null for the ordinary case, so a normal enrolment does no extra work
 * beyond one indexed read.
 */
async function staleEnrolmentInvoice(
  storeId: string,
  built: Pick<BuiltInvoice, "lines" | "totalPaise">,
  cycle: { start: Date; end: Date; seq: number },
): Promise<{ id: string; cause: EnrolmentDraftChange } | null> {
  const existing = await getCycleInvoice(storeId, cycle.seq);
  if (!existing) return null;
  const cause = enrolmentDraftChange(
    existing,
    built,
    cycle.end.getTime() - cycle.start.getTime(),
  );
  return cause ? { id: existing.id, cause } : null;
}

/** Why an enrolment's existing draft no longer matches what is being bought. */
export type EnrolmentDraftChange = "shape" | "tax";

/**
 * Has the merchant's choice changed since the cycle's draft was built, or only
 * the GST on it? (GST design 5.3; PURE.)
 *
 * - `"shape"`: the draft's body (the sum of its `INVOICE_BODY_KINDS` lines,
 *   before discount and GST) or its cycle length differs: a plan or period
 *   change. Today's path, including the "earlier plan choice" refusal while
 *   an order for the old shape is genuinely in flight.
 * - `"tax"`: the body and length match and only the total differs: GST
 *   started, stopped or changed its rate.
 * - `null`: nothing to rewrite. A difference in the stamp alone (an inclusive
 *   start, a GSTIN saved since) is not stale: `issueInvoice` restamps at
 *   issue.
 *
 * Only a plain draft can be stale; anything else is a document or a debt and
 * is left alone. Exported because the subscribe quote (Stage 12) must apply
 * the same rule from the same facts, so it shows the order the merchant will
 * really resume.
 */
export function enrolmentDraftChange(
  draft: Pick<
    InvoiceRow,
    "status" | "totalPaise" | "bodyTotalPaise" | "periodStart" | "periodEnd"
  >,
  built: Pick<BuiltInvoice, "lines" | "totalPaise">,
  lengthMs: number,
): EnrolmentDraftChange | null {
  if (draft.status !== "draft") return null;
  const builtBody = built.lines
    .filter((line) => INVOICE_BODY_KINDS.includes(line.kind))
    .reduce((sum, line) => sum + line.amountPaise, 0);
  if (draft.bodyTotalPaise !== builtBody || !sameLength(draft, lengthMs)) {
    return "shape";
  }
  return draft.totalPaise === built.totalPaise ? null : "tax";
}

/**
 * Does this invoice have a payment attempt that is not failed or cancelled?
 * Undefined when it cannot be read: the caller refuses rather than guess.
 *
 * ★ The same set `issueInvoice` treats as frozen (any attempt not `failed` or
 * `cancelled`), so an enrolment that keeps a draft for its order and the
 * issue that later carves GST out of that order agree on which drafts those
 * are. Scoped by store as well as invoice, like every attempt read here.
 */
async function liveAttemptOn(
  invoiceId: string,
  storeId: string,
): Promise<boolean | undefined> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({ id: billingPaymentAttempts.id })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, invoiceId),
            eq(billingPaymentAttempts.storeId, storeId),
            notInArray(billingPaymentAttempts.state, ["failed", "cancelled"]),
          ),
        )
        .limit(1);
      return !!row;
    });
  } catch (err) {
    logError("billing.enrol.live_attempt", err, { invoiceId });
    return undefined;
  }
}

/**
 * What a cycle draft whose only change is GST does with an order on it.
 *
 * - `none`: no attempt is in flight on it; the draft is rebuilt.
 * - `abandon`: the in-flight order is one the gateway says nobody has touched
 *   (`inspectResumable`); it may be freed and the draft rebuilt.
 * - `resume`: an order somebody touched, or one we could not read, or an
 *   attempt with no order to read yet: the draft is kept as it is and the
 *   order resumed at its total.
 *
 * Undefined when the attempts cannot be read: the caller refuses rather than
 * guess. READ ONLY (the start does the freeing), so the subscribe quote asks
 * the same question and quotes what the start will charge.
 */
export type TaxDraftOrder =
  | { kind: "none" }
  | { kind: "abandon"; attemptId: string; providerOrderId: string }
  | { kind: "resume" };

export async function taxDraftOrder(
  creds: Parameters<typeof rzpFetchOrder>[0],
  invoiceId: string,
  storeId: string,
): Promise<TaxDraftOrder | undefined> {
  const live = await liveAttemptOn(invoiceId, storeId);
  if (live === undefined) return undefined;
  if (!live) return { kind: "none" };
  const found = await inspectResumable(creds, invoiceId, storeId);
  if (!found?.untouched) return { kind: "resume" };
  return {
    kind: "abandon",
    attemptId: found.resumable.id,
    providerOrderId: found.resumable.providerOrderId,
  };
}

/**
 * Does a stored invoice cover a cycle of this many milliseconds?
 *
 * An invoice with no period recorded cannot be shown to match, so it is
 * reshaped — the safe direction, since the alternative is billing an unknown
 * duration.
 */
function sameLength(
  invoice: { periodStart: string | null; periodEnd: string | null },
  lengthMs: number,
): boolean {
  if (!invoice.periodStart || !invoice.periodEnd) return false;
  const start = Date.parse(invoice.periodStart);
  const end = Date.parse(invoice.periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  // Postgres keeps microseconds and JavaScript truncates to milliseconds, so
  // allow one millisecond of slack rather than demanding an exact match.
  return Math.abs(end - start - lengthMs) <= 1;
}

/**
 * The in-flight attempt for this invoice, and whether its order is still
 * untouched at the gateway.
 *
 * ★★ "Untouched" is the ONE condition under which an order may be abandoned:
 * status `created`, zero attempts, nothing paid. That is proof no payment
 * instrument has ever been presented against it, so replacing it cannot cost
 * anyone money. Both callers — a changed plan/period and a changed rail — need
 * exactly this, and a second hand-written copy of it is how one of them ends up
 * abandoning an order somebody has already paid.
 *
 * ★ An UNREADABLE order is NOT untouched. "We could not check" is not "nobody
 * paid", so a gateway blip is never permission to abandon.
 */
async function inspectResumable(
  creds: Parameters<typeof rzpFetchOrder>[0],
  invoiceId: string,
  storeId: string,
): Promise<{
  resumable: NonNullable<Awaited<ReturnType<typeof resumableAttempt>>>;
  method: MandateMethod;
  untouched: boolean;
} | null> {
  const resumable = await resumableAttempt(invoiceId, storeId);
  if (!resumable) return null;
  const existing = await rzpFetchOrder(creds, resumable.providerOrderId);
  return {
    resumable,
    // A failed read is a label problem, not a correctness one — every order
    // created before the rail was declared omitted `method`, which Razorpay
    // treats as card, so that is the honest fallback.
    method: existing.ok && existing.data.method === "upi" ? "upi" : "card",
    untouched: await orderIsUntouched(creds, existing),
  };
}

/**
 * Has any payment ever succeeded, or could one still, against this order?
 *
 * ★ The cheap proof is `created` with zero attempts: nothing has been presented
 * at all, so no extra call is needed and the ordinary path pays nothing.
 *
 * ★★ BUT A TRIED ORDER IS NOT NECESSARILY A PAID ONE. A merchant who scans a
 * UPI QR and never approves it leaves the order `attempted` with three FAILED
 * payments and `amount_paid: 0` — measured on production 2026-09-06. Treating
 * that as untouchable strands them behind their own abandoned attempt until
 * reconciliation gives up 72 hours later. A `failed` payment is terminal and
 * can never be captured, so an order whose payments have ALL failed is as safe
 * to abandon as one nobody ever opened.
 *
 * ★ Anything else is refused: money already paid, a payment still `created` or
 * `authorized` (the shopper is mid-approval in their UPI app), or a read we
 * could not make. "We could not check" is never "nobody paid".
 */
async function orderIsUntouched(
  creds: Parameters<typeof rzpFetchOrder>[0],
  order: Awaited<ReturnType<typeof rzpFetchOrder>>,
): Promise<boolean> {
  if (!order.ok) return false;
  if (order.data.amount_paid) return false;
  if (order.data.status === "created" && (order.data.attempts ?? 0) === 0) {
    return true;
  }
  const payments = await rzpFetchOrderPayments(creds, order.data.id);
  if (!payments.ok) return false;
  return payments.data.every((payment) => payment.status === "failed");
}

async function resumableAttempt(
  invoiceId: string,
  storeId: string,
): Promise<{
  id: string;
  providerOrderId: string;
  amountPaise: number;
  mandateMaxPaise: number | null;
} | null> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingPaymentAttempts.id,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
          mandateMaxPaise: billingPaymentAttempts.mandateMaxPaise,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, invoiceId),
            // Scoped by store as well: an invoice id alone must never re-open
            // another merchant's payment.
            eq(billingPaymentAttempts.storeId, storeId),
            eq(billingPaymentAttempts.state, RESUMABLE_STATE),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      if (!row?.providerOrderId) return null;
      return {
        id: row.id,
        providerOrderId: row.providerOrderId,
        amountPaise: row.amountPaise,
        mandateMaxPaise: row.mandateMaxPaise,
      };
    });
  } catch (err) {
    logError("billing.resumable_attempt", err, { invoiceId });
    return null;
  }
}

/**
 * This store's subscription state ("" when it has none), and the cycle number
 * an enrolment bills.
 *
 * Returns NULL on a read failure — distinct from "no subscription", because the
 * caller must fail closed rather than treat a database blip as a free pass.
 *
 * ★★ AN ENDED SUBSCRIPTION DOES NOT START AGAIN AT CYCLE 1. Invoices are one
 * per (store, cycle_seq) for ever, so after a downgrade or a cancellation
 * cycle 1 is the store's old PAID invoice and the next may be closed unpaid:
 * re-enrolling at 1 handed that back and refused with "already paid for",
 * leaving no way back onto a paid plan. An ended subscription continues after
 * the highest cycle ever issued. A draft above it is this enrolment's own
 * offer and is reused; a PAID one above the last activated cycle is a payment
 * whose activation failed, and is returned so it is refused rather than
 * charged twice. A store that never had a cycle starts at 1, as before.
 */
async function currentSubscription(
  storeId: string,
): Promise<{ state: string; enrolCycleSeq: number } | null> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          state: billingSubscriptions.state,
          cycleSeq: billingSubscriptions.currentCycleSeq,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      const state = row?.state ?? "";
      const enrolCycleSeq = await enrolCycleSeqWith(db, storeId, {
        state,
        activated: row?.cycleSeq ?? 0,
      });
      return { state, enrolCycleSeq };
    });
  } catch (err) {
    logError("billing.current_state", err, { storeId });
    return null;
  }
}

/**
 * The cycle an enrolment bills, from the subscription row already read
 * (`currentSubscription`'s rule above), on the caller's own scope.
 *
 * ★ ONE COPY (R1-01). The subscribe quote reads the subscription and its
 * mandate in one scope and asks this with the same `db`, so the quote and the
 * start cannot disagree about which cycle (and so which draft) a Subscribe
 * reaches. Throws on a read failure; both callers turn that into a refusal.
 */
export async function enrolCycleSeqWith(
  db: Db,
  storeId: string,
  row: { state: string; activated: number },
): Promise<number> {
  if (!ENDED_STATES.includes(row.state as (typeof ENDED_STATES)[number])) {
    return FIRST_CYCLE;
  }
  const later = await db
    .select({
      seq: billingInvoices.cycleSeq,
      status: billingInvoices.status,
    })
    .from(billingInvoices)
    .where(
      and(
        eq(billingInvoices.storeId, storeId),
        eq(billingInvoices.kind, "subscription"),
        gt(billingInvoices.cycleSeq, row.activated),
      ),
    );
  const paid = later.find((i) => i.status === "paid" && i.seq !== null);
  if (paid?.seq) return paid.seq;
  const issued = later
    .filter((i) => i.status !== "draft" && i.seq !== null)
    .map((i) => i.seq as number);
  return Math.max(row.activated, ...issued) + 1;
}

/** Create the subscription row in a state that grants NOTHING. */
async function seedSubscription(input: {
  storeId: string;
  plan: Plan;
  period: BillingPeriod;
  cycle: { start: Date; end: Date; seq: number };
}): Promise<boolean> {
  try {
    await withService(async (db) => {
      await db
        .insert(billingSubscriptions)
        .values({
          storeId: input.storeId,
          plan: input.plan,
          period: input.period,
          // ★ `free` until the money lands. The cycle columns stay NULL, which
          // the billing_subscriptions_cycle_present CHECK requires for any
          // non-paid state — and which keeps the renewal worker away from a
          // subscription nobody has paid for.
          state: "free",
          // The cycle BEFORE the one being enrolled: 0 for a first
          // subscription, and past every old cycle for one that ended, so
          // activation (seq + 1) lands on the invoice being paid.
          currentCycleSeq: input.cycle.seq - 1,
          planSource: "paid",
        })
        .onConflictDoUpdate({
          target: billingSubscriptions.storeId,
          set: {
            plan: input.plan,
            period: input.period,
            currentCycleSeq: input.cycle.seq - 1,
            updatedAt: new Date().toISOString(),
          },
          // A subscription that went live since the check above is left
          // alone: rewriting its cycle number would rewind its renewals.
          setWhere: notInArray(billingSubscriptions.state, [...LIVE_STATES]),
        });
    });
    return true;
  } catch (err) {
    logError("billing.seed_subscription", err, { storeId: input.storeId });
    return false;
  }
}

export interface ConfirmedEnrolment {
  plan: Plan;
  periodEnd: string;
  mandateActivated: boolean;
}

/**
 * Complete enrolment after the merchant's payment.
 *
 * ★ THE SIGNATURE IS THE TRUST BOUNDARY. The client hands us a payment id and a
 * signature; only the HMAC proves the payment belongs to the order WE created.
 * Without that check anyone could post an arbitrary id and be granted a plan.
 *
 * ★ IDEMPOTENT. The attempt claim settles once, so a double-submitted callback
 * grants the plan once. Re-confirming an already-paid enrolment reports success
 * rather than an error — from the merchant's point of view it worked.
 */
export async function confirmEnrolment(input: {
  storeId: string;
  invoiceId: string;
  providerPaymentId: string;
  signature: string;
  /** Present when the checkout also registered a mandate for future cycles. */
  mandate?: {
    providerTokenId: string;
    providerCustomerId?: string | null;
    method: "card" | "upi" | "emandate" | "nach" | "unknown";
    maxAmountPaise?: number | null;
  };
  now?: Date;
}): Promise<EnrolmentResult<ConfirmedEnrolment>> {
  const now = input.now ?? new Date();
  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return { ok: false, error: "Subscriptions aren't available right now." };
  }

  let attempt: {
    id: string;
    state: string;
    providerOrderId: string | null;
    amountPaise: number;
    mandateMaxPaise: number | null;
  } | null = null;
  try {
    attempt = await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingPaymentAttempts.id,
          state: billingPaymentAttempts.state,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
          mandateMaxPaise: billingPaymentAttempts.mandateMaxPaise,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, input.invoiceId),
            // Scoped by store as well as invoice: an invoice id alone must
            // never let one merchant settle another's payment.
            eq(billingPaymentAttempts.storeId, input.storeId),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.confirm_load_attempt", err, {
      invoiceId: input.invoiceId,
    });
    return { ok: false, error: "Couldn't confirm the payment." };
  }

  if (!attempt?.providerOrderId) {
    return { ok: false, error: "No payment to confirm." };
  }

  if (
    !verifyCheckoutSignature(
      creds.keySecret,
      attempt.providerOrderId,
      input.providerPaymentId,
      input.signature,
    )
  ) {
    logWarn("billing.confirm_bad_signature", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
    });
    return { ok: false, error: "We couldn't verify that payment." };
  }

  const observedPayment = await verifyCapturedCheckoutPayment(creds, {
    paymentId: input.providerPaymentId,
    orderId: attempt.providerOrderId,
    amountPaise: attempt.amountPaise,
  });
  if (!observedPayment.ok) {
    logWarn("billing.confirm_gateway_mismatch", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
      reason: observedPayment.error,
    });
    return { ok: false, error: observedPayment.error };
  }

  // ★ The invoice's time of supply is the payment's, not the confirm's
  // (R1-07): a payment made just before a scheduled GST change and confirmed
  // just after is issued under the terms it was paid under, as the hourly
  // checks already do. Best-effort: a time that cannot be read leaves it at
  // now, and the plan is switched on either way.
  const paidAt = observedPayment.gatewayRead
    ? await paymentCapturedAt(creds, input.providerPaymentId, "billing.enrol")
    : undefined;

  // ★★ ONE COMPLETION, WHOEVER ARRIVES (RC-F1b). The browser confirm, the
  // hourly reconcile (a merchant who closed the tab) and a repeated Subscribe
  // all finish a paid enrolment through `completeEnrolmentPurchase`, so the
  // invoice is issued once, the receipt and the welcome go out once, and the
  // plan moves once, whichever of them gets there first.
  const outcome = await completeEnrolmentPurchase({
    storeId: input.storeId,
    invoiceId: input.invoiceId,
    attemptId: attempt.id,
    providerPaymentId: input.providerPaymentId,
    source: "confirm",
    // Checked above, against the payment the browser named.
    verifyCapture: false,
    mandate: input.mandate,
    paidAt,
    now,
  });
  switch (outcome.status) {
    case "completed":
    case "already_complete":
      return { ok: true, data: outcome.data };
    case "not_captured":
      return { ok: false, error: "That payment didn't complete." };
    case "not_ready":
      // Nothing changed yet; the hourly check records the capture and
      // finishes it, so the honest answer is "soon", not "failed".
      return { ok: false, error: ENROLMENT_PAID_NOT_SWITCHED_MESSAGE };
    case "refused":
      // ★ The money is IN. Never report a bare failure here: say what
      // happened, because the merchant has paid and support needs to know the
      // plan is the part that did not move (the §15 rule). It is filed for a
      // person already.
      return {
        ok: false,
        error:
          "Your payment went through but we couldn't switch your plan over. Contact support, and please don't pay again.",
      };
  }
}

type MandateInput = {
  providerTokenId: string;
  providerCustomerId?: string | null;
  method: "card" | "upi" | "emandate" | "nach" | "unknown";
  maxAmountPaise?: number | null;
};

/**
 * Finish a paid enrolment: issue the invoice, record the payment, move the
 * merchant onto the plan, then the welcome and the audit row.
 *
 * ★★ THE SAME CODE FOR EVERY CALLER (RC-F1b). The browser confirm used to be
 * the only thing that did this, so a merchant who paid and closed the tab
 * before it ran was left with a captured payment on a draft invoice: no
 * document, no plan, no email, and a second charge offered next time they
 * pressed Subscribe. The hourly reconcile and a repeated Subscribe now call
 * this too.
 *
 * ★★ WHOEVER ARRIVES SECOND CHANGES NOTHING AND SENDS NOTHING. Every step is a
 * claim: finalize claims only a draft, the paid move claims only an open or
 * processing invoice (and only its winner sends the receipt), and the
 * activation below claims a subscription that is not live and sits exactly one
 * cycle before the invoice. Only that claim's winner records the mandate,
 * sends the welcome and writes the audit row.
 *
 * ★ THE GUARDS RUN FIRST, before anything is written: the attempt is this
 * store's and this invoice's, the store still exists, the invoice is this
 * store's next subscription cycle, the plan period on file matches the
 * invoice, and (when `verifyCapture`) the gateway's captured amount and
 * currency equal the attempt's. A failed guard files the purchase for a
 * person with a note, and nothing is applied or refunded automatically.
 */
export async function completeEnrolmentPurchase(input: {
  storeId: string;
  invoiceId: string;
  attemptId: string;
  /** The payment named by the browser, or null to use the recorded one. */
  providerPaymentId: string | null;
  source: "confirm" | "recovery" | "start";
  /** Ask the gateway again what was captured (recovery and a repeated start). */
  verifyCapture: boolean;
  /** Tests only: the mandate the checkout registered. */
  mandate?: MandateInput;
  /** Injected by reconcile so a test needs no gateway. */
  fetchOrderPayments?: typeof rzpFetchOrderPayments;
  /**
   * When the gateway captured the payment (its `created_at`), if a caller
   * read it. A draft issued here reads its tax terms at this instant
   * (`issueInvoice`); absent, they are read now.
   */
  paidAt?: Date;
  now: Date;
}): Promise<PurchaseCompletion<ConfirmedEnrolment>> {
  const now = input.now;
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { status: "not_ready", reason: "no gateway credentials" };

  let facts: Awaited<ReturnType<typeof readEnrolmentFacts>>;
  try {
    facts = await readEnrolmentFacts(input);
  } catch (err) {
    logError("billing.enrol.complete_read", err, {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
    });
    return { status: "not_ready", reason: "the purchase could not be read" };
  }
  const { invoice, attempt, storeExists, sub } = facts;

  // ── Guards: nothing has been written yet ─────────────────────────────────
  if (
    !attempt ||
    attempt.invoiceId !== input.invoiceId ||
    attempt.storeId !== input.storeId
  ) {
    logWarn("billing.enrol.complete_mismatch", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
      attemptId: input.attemptId,
    });
    return {
      status: "refused",
      reason: "the payment does not belong to this store and invoice",
    };
  }

  const file = async (
    reason: string,
    note: string,
    extra: {
      unapplied?: boolean;
      kind?: "state_conflict" | "amount_mismatch";
      observedPaise?: number | null;
      paymentId?: string | null;
    } = {},
  ): Promise<PurchaseCompletion<ConfirmedEnrolment>> => {
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
      purchase: "enrolment",
      now,
    });
    return { status: "refused", reason };
  };

  if (
    !invoice ||
    invoice.storeId !== input.storeId ||
    invoice.kind !== "subscription" ||
    invoice.cycleSeq === null
  ) {
    return file(
      "the invoice is not this store's subscription invoice",
      "Subscription payment captured, but its invoice is not this store's subscription invoice. Check the payment and refund it or attach it by hand.",
    );
  }
  if (!storeExists) {
    return file(
      "the store no longer exists",
      "Subscription payment captured for a store that no longer exists. Decide whether to refund it.",
    );
  }
  if (attempt.state !== "captured" && input.source !== "confirm") {
    // A recovered purchase is found BY its capture; anything else changed
    // under us. Nothing written: look again next pass.
    return { status: "not_ready", reason: "the payment is not captured" };
  }

  let paymentId = input.providerPaymentId ?? attempt.providerPaymentId;
  if (input.verifyCapture) {
    if (!attempt.providerOrderId) {
      return file(
        "the payment has no order",
        "Subscription payment marked captured with no Razorpay order. Check it by hand.",
      );
    }
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
        `Subscription payment captured, but ${checked.reason}. The plan was not switched on. Decide whether to refund the payment or switch the plan on by hand.`,
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
      `Subscription payment captured on an invoice that is ${invoice.status}. The plan was not switched on. Decide whether to refund the payment.`,
    );
  }

  const live =
    !!sub && LIVE_STATES.includes(sub.state as (typeof LIVE_STATES)[number]);
  if (!sub) {
    return file(
      "there is no subscription on file",
      "Subscription payment captured, but the store has no subscription on file. Switch the plan on by hand or refund the payment.",
    );
  }
  if (live && sub.currentCycleSeq > invoice.cycleSeq) {
    return file(
      "the subscription is already live on a later cycle",
      `Subscription payment captured for cycle ${invoice.cycleSeq}, but the subscription is already live on cycle ${sub.currentCycleSeq}. Decide whether to refund the payment.`,
    );
  }
  if (live && sub.currentCycleSeq < invoice.cycleSeq) {
    return file(
      "the subscription is live on an earlier cycle",
      `Subscription payment captured for cycle ${invoice.cycleSeq} while the subscription is live on cycle ${sub.currentCycleSeq}. Check which cycle the payment covers.`,
    );
  }
  if (!live && sub.currentCycleSeq !== invoice.cycleSeq - 1) {
    return file(
      "the invoice is not the next cycle's",
      `Subscription payment captured for cycle ${invoice.cycleSeq}, but the next cycle on file is ${sub.currentCycleSeq + 1}. Decide whether to switch the plan on by hand or refund the payment.`,
    );
  }
  const period: BillingPeriod = sub.period === "yearly" ? "yearly" : "monthly";
  if (!live) {
    const probe = cycleFrom(now, period, invoice.cycleSeq);
    if (!sameLength(invoice, probe.end.getTime() - probe.start.getTime())) {
      return file(
        "the plan period on file does not match the invoice",
        `Subscription payment captured, but the ${period} period on file does not match the invoice's period. Decide which plan the payment bought.`,
      );
    }
  }

  // ── Issue the invoice, then record the payment ───────────────────────────
  // ★★ FINALIZE BEFORE SETTLING. `settleAttempt` claims the move to paid only
  // from `open` or `processing`, so settling a draft claims nothing and leaves
  // an invoice unpaid behind captured money (measured on production,
  // 2026-09-06: store `echos`, paid_at 20 days late). Finalizing first is safe:
  // the payment is proven captured before this line runs.
  if (invoice.status === "draft") {
    const issued = await finalizeInvoice(input.invoiceId, now, input.paidAt);
    if (!issued) {
      // ★ The money is captured and the invoice is still a draft. Nothing is
      // settled or applied: the browser is told it is not ready, and the
      // hourly check (or the repair pass beside it) tries again. Logged so a
      // run of these is visible: `issueInvoice` already logged WHY.
      logWarn("billing.confirm_issue_failed", {
        purchase: "enrolment",
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
        "Subscription payment captured, but its draft invoice was closed before it could be issued. Decide whether to refund the payment.",
      );
    }
  }

  // ★ A capture reconcile already recorded settles again here: that changes
  // nothing on the attempt and re-runs the invoice sync (finding F1), so the
  // invoice becomes paid and the receipt goes out once.
  const settled = await settleAttempt(attempt.id, "captured", {
    providerPaymentId: paymentId,
    now,
  });
  if (settled && settled !== "captured") return { status: "not_captured" };

  const paidNow = await getInvoice(input.invoiceId);
  if (paidNow?.status !== "paid") {
    return file(
      "the invoice did not become paid",
      "Subscription payment captured and its invoice issued, but the invoice did not become paid. Check the invoice, then switch the plan on by hand.",
      { unapplied: true },
    );
  }

  // ── Move the plan: a claim, so it happens once ───────────────────────────
  const activated = await claimEnrolmentActivation({
    storeId: input.storeId,
    cycleSeq: invoice.cycleSeq,
    period,
    now,
  });
  if (activated === "error" || activated === null) {
    const current = await readSubscriptionState(input.storeId);
    if (
      current &&
      LIVE_STATES.includes(current.state as (typeof LIVE_STATES)[number]) &&
      current.currentCycleSeq >= invoice.cycleSeq &&
      current.currentPeriodEnd
    ) {
      // ★ Another caller got here first (or an older confirm already did):
      // nothing to change, nothing to send.
      return {
        status: "already_complete",
        data: {
          plan: current.storePlan ?? (current.plan as Plan),
          periodEnd: current.currentPeriodEnd,
          mandateActivated: current.mandateId !== null,
        },
      };
    }
    return file(
      "the plan could not be switched on",
      "Subscription payment captured and its invoice paid, but the plan could not be switched on. Switch it on by hand; the merchant was told not to pay again.",
      { unapplied: true },
    );
  }

  // ── Only the claim's winner: the mandate, the welcome, the audit row ─────
  // ★★ THE MANDATE IS READ FROM THE PAYMENT, NEVER FROM THE CALLER. Checkout
  // hands the browser a payment id and a signature, not a token, so a
  // caller-supplied token would be a value the browser chose. `input.mandate`
  // is still honoured because the tests drive it; nothing in the product
  // supplies it. The ceiling is the one stored on the attempt before checkout,
  // never recomputed after a reprice.
  const observedFromGateway =
    input.mandate ??
    (paymentId ? await readMandateFromPayment(creds, paymentId) : null);
  const observed =
    observedFromGateway && attempt.mandateMaxPaise
      ? { ...observedFromGateway, maxAmountPaise: attempt.mandateMaxPaise }
      : null;
  const mandateId = observed
    ? await activateMandate({ storeId: input.storeId, ...observed, now })
    : null;
  const attached = mandateId
    ? await attachMandate({
        storeId: input.storeId,
        cycleSeq: invoice.cycleSeq,
        mandateId,
        now,
      })
    : false;

  // ★ AFTER the plan has actually moved, and best-effort: a merchant who has
  // paid must not have their activation fail over an email.
  await notifyPlanActivated({
    storeId: input.storeId,
    invoiceId: input.invoiceId,
    autopay: attached,
  });
  await auditEnrolment({
    storeId: input.storeId,
    fromPlan: activated.fromPlan,
    toPlan: activated.plan,
    note: `subscribed (${attached ? "autopay" : "manual renewal"})${
      input.source === "recovery"
        ? ", finished by the hourly check after the payment window closed"
        : input.source === "start"
          ? ", finished when the merchant tried to subscribe again"
          : ""
    }`,
  });
  logInfo("billing.purchase_completed", {
    purchase: "enrolment",
    source: input.source,
    storeId: input.storeId,
    invoiceId: input.invoiceId,
    attemptId: attempt.id,
  });

  return {
    status: "completed",
    data: {
      plan: activated.plan,
      periodEnd: activated.periodEnd,
      mandateActivated: attached,
    },
  };
}

/** Everything the completion's guards read, in one scope. */
async function readEnrolmentFacts(input: {
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
        cycleSeq: billingInvoices.cycleSeq,
        periodStart: billingInvoices.periodStart,
        periodEnd: billingInvoices.periodEnd,
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
        mandateMaxPaise: billingPaymentAttempts.mandateMaxPaise,
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
        period: billingSubscriptions.period,
        currentCycleSeq: billingSubscriptions.currentCycleSeq,
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

/** The subscription as it stands, for a caller that lost the activation claim. */
async function readSubscriptionState(storeId: string): Promise<{
  state: string;
  plan: string;
  currentCycleSeq: number;
  currentPeriodEnd: string | null;
  mandateId: string | null;
  storePlan: Plan | null;
} | null> {
  try {
    return await withService(async (db) => {
      const [sub] = await db
        .select({
          state: billingSubscriptions.state,
          plan: billingSubscriptions.plan,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          mandateId: billingSubscriptions.mandateId,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      if (!sub) return null;
      const [store] = await db
        .select({ plan: stores.plan })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      return { ...sub, storePlan: (store?.plan as Plan | undefined) ?? null };
    });
  } catch (err) {
    logError("billing.enrol.read_state", err, { storeId });
    return null;
  }
}

/**
 * Move the merchant onto the plan they paid for, in BOTH places, as a claim.
 *
 * ★★ A CLAIM, so it happens once. The UPDATE admits only a subscription that is
 * not live and sits exactly one cycle before the invoice, so a browser confirm
 * and the hourly reconcile arriving together cannot both activate it: the
 * second waits for the first's row lock, re-reads the row and matches nothing.
 * Null means another caller won; "error" means the write failed and nothing
 * changed.
 *
 * ★ `billingMayApplyPlan` is honoured: an operator comp is a floor, so
 * subscribing to a cheaper tier never lowers `stores.plan`.
 *
 * ★★ NO `plan_expires_at`. A paid plan is kept and taken away by the renewal
 * worker; that column is an operator grant's end.
 */
async function claimEnrolmentActivation(input: {
  storeId: string;
  cycleSeq: number;
  period: BillingPeriod;
  now: Date;
}): Promise<
  { plan: Plan; periodEnd: string; fromPlan: string | null } | null | "error"
> {
  const cycle = cycleFrom(input.now, input.period, input.cycleSeq);
  try {
    return await withService(async (db) => {
      const claimed = await db
        .update(billingSubscriptions)
        .set({
          state: "active",
          currentCycleSeq: cycle.seq,
          currentPeriodStart: cycle.start.toISOString(),
          currentPeriodEnd: cycle.end.toISOString(),
          planSource: "paid",
          mandateId: null,
          graceStartedAt: null,
          graceEndsAt: null,
          downgradedAt: null,
          updatedAt: input.now.toISOString(),
        })
        .where(
          and(
            eq(billingSubscriptions.storeId, input.storeId),
            notInArray(billingSubscriptions.state, [...LIVE_STATES]),
            eq(billingSubscriptions.currentCycleSeq, input.cycleSeq - 1),
          ),
        )
        .returning({ plan: billingSubscriptions.plan });
      if (claimed.length === 0) return null;
      const paidPlan = claimed[0].plan as Plan;

      // ── The entitlement half ──
      const [store] = await db
        .select({ plan: stores.plan, planSource: stores.planSource })
        .from(stores)
        .where(eq(stores.id, input.storeId))
        .limit(1);
      // Throwing rolls the claim back: a subscription made live for a store
      // that vanished would bill nobody for nothing.
      if (!store) throw new Error("store vanished during activation");

      if (!billingMayApplyPlan(store.plan, store.planSource, paidPlan)) {
        // An operator gave them something at least as good. Leave it, and
        // leave the subscription active: they are paying, and the comp is the
        // floor.
        logWarn("billing.enrol_comp_floor", {
          storeId: input.storeId,
          compPlan: store.plan,
          paidPlan,
        });
        return {
          plan: store.plan as Plan,
          periodEnd: cycle.end.toISOString(),
          fromPlan: store.plan,
        };
      }

      await db
        .update(stores)
        .set({ plan: paidPlan, planSource: "paid", planExpiresAt: null })
        .where(eq(stores.id, input.storeId));
      return {
        plan: paidPlan,
        periodEnd: cycle.end.toISOString(),
        fromPlan: store.plan,
      };
    });
  } catch (err) {
    logError("billing.activate_subscription", err, { storeId: input.storeId });
    return "error";
  }
}

/**
 * Attach the mandate to the subscription the claim just activated.
 *
 * ★ Its own write, best-effort: a mandate is for FUTURE cycles, so failing to
 * attach one costs automatic renewal, never the plan the merchant paid for.
 */
async function attachMandate(input: {
  storeId: string;
  cycleSeq: number;
  mandateId: string;
  now: Date;
}): Promise<boolean> {
  try {
    const rows = await withService(async (db) =>
      db
        .update(billingSubscriptions)
        .set({ mandateId: input.mandateId, updatedAt: input.now.toISOString() })
        .where(
          and(
            eq(billingSubscriptions.storeId, input.storeId),
            eq(billingSubscriptions.currentCycleSeq, input.cycleSeq),
            isNull(billingSubscriptions.mandateId),
          ),
        )
        .returning({ id: billingSubscriptions.storeId }),
    );
    return rows.length > 0;
  } catch (err) {
    logError("billing.enrol.attach_mandate", err, { storeId: input.storeId });
    return false;
  }
}

/**
 * Finish an earlier enrolment whose payment was captured, before opening a new
 * one (RC-F1b). Null when there is none; otherwise the answer for the screen.
 */
async function finishEarlierEnrolment(
  storeId: string,
  now: Date,
): Promise<EnrolmentResult<EnrolmentStart> | null> {
  const found = await capturedDraftPurchases({
    storeId,
    kind: "subscription",
    limit: 1,
  });
  if (found === null) {
    return { ok: false, error: "Couldn't check your subscription. Try again." };
  }
  const purchase = found[0];
  if (!purchase) return null;
  const outcome = await completeEnrolmentPurchase({
    storeId,
    invoiceId: purchase.invoiceId,
    attemptId: purchase.attemptId,
    providerPaymentId: null,
    source: "start",
    verifyCapture: true,
    now,
  });
  if (outcome.status === "completed" || outcome.status === "already_complete") {
    return {
      ok: false,
      error: ENROLMENT_RECOVERED_MESSAGE,
      recovered: "completed",
    };
  }
  logWarn("billing.enrol.earlier_purchase_waiting", {
    storeId,
    invoiceId: purchase.invoiceId,
    attemptId: purchase.attemptId,
    outcome: outcome.status,
  });
  return {
    ok: false,
    error: ENROLMENT_RECOVERY_WAITING_MESSAGE,
    recovered: "waiting",
  };
}

/**
 * Record the mandate the checkout registered.
 *
 * ★ Its OWN transaction, and best-effort. A mandate is for FUTURE cycles, so
 * failing to record one must never fail an enrolment whose money has already
 * landed — the merchant is on the plan they paid for either way, and the worst
 * case is that next cycle needs a manual payment.
 */
/**
 * The Razorpay customer a mandate hangs off.
 *
 * Required before a new subscription checkout. A failure returns null and the
 * caller stops before Razorpay opens; it must never silently sell an autopay
 * subscription as a one-time payment.
 */
type RzpCustomerResult =
  | { ok: true; id: string }
  | { ok: false; reason: "missing-contact" | "gateway" };

/**
 * The Razorpay customer a mandate hangs off.
 *
 * ★★ THE CONTACT IS THE COMMON FAILURE, AND IT WAS UNIVERSAL. The subsequent
 * recurring endpoint requires BOTH an email and a phone, so a store with only
 * one cannot be enrolled — and `resolveBillingEmail` read the phone from
 * `admins.phone`, which the signup wizard never populated. Every merchant
 * created by the wizard therefore hit this and could not subscribe at all. Both
 * halves are fixed (the wizard now writes it, and the resolver falls back to the
 * invoice contact phone); the refusal stays, because offering a mandate with an
 * email alone would tell the merchant autopay is set up and then fail every
 * renewal locally, before Razorpay is even called.
 */
async function ensureRzpCustomer(
  creds: { keyId: string; keySecret: string },
  storeId: string,
): Promise<RzpCustomerResult> {
  const to = await resolveBillingEmail(storeId).catch(() => null);
  if (!to?.email || !to.phone) {
    logWarn("billing.enrol.customer_contact_missing", {
      storeId,
      hasEmail: Boolean(to?.email),
      hasPhone: Boolean(to?.phone),
    });
    return { ok: false, reason: "missing-contact" };
  }
  const res = await rzpCreateCustomer(creds, {
    name: to.storeName,
    email: to.email,
    contact: to.phone,
  });
  if (!res.ok) {
    logError("billing.enrol.customer", new Error(res.error), { storeId });
    return { ok: false, reason: "gateway" };
  }
  const id = res.data.id;
  return id ? { ok: true, id } : { ok: false, reason: "gateway" };
}

/**
 * What mandate, if any, did this payment register?
 *
 * ★ A missing token is anomalous for enrolment, but a failed lookup is still
 * null: the money is already captured by this point and the plan must be
 * granted regardless, so losing autopay is the acceptable half of that trade.
 */
async function readMandateFromPayment(
  creds: { keyId: string; keySecret: string },
  paymentId: string,
): Promise<{
  providerTokenId: string;
  providerCustomerId?: string | null;
  method: "card" | "upi" | "emandate" | "nach" | "unknown";
  maxAmountPaise?: number | null;
} | null> {
  const res = await rzpFetchPayment(creds, paymentId);
  if (!res.ok) {
    logError("billing.enrol.read_mandate", new Error(res.error), { paymentId });
    return null;
  }
  const tokenId = res.data.token_id;
  if (!tokenId) return null;
  const method = res.data.method;
  return {
    providerTokenId: tokenId,
    providerCustomerId: res.data.customer_id ?? null,
    method:
      method === "card" ||
      method === "upi" ||
      method === "emandate" ||
      method === "nach"
        ? method
        : "unknown",
  };
}

async function activateMandate(input: {
  storeId: string;
  providerTokenId: string;
  providerCustomerId?: string | null;
  method: "card" | "upi" | "emandate" | "nach" | "unknown";
  maxAmountPaise?: number | null;
  now: Date;
}): Promise<string | null> {
  try {
    return await withService(async (db) => {
      // One ACTIVE mandate per store (partial unique index). Retire any previous
      // one first, or the insert below is refused.
      await db
        .update(billingMandates)
        .set({ status: "revoked", revokedAt: input.now.toISOString() })
        .where(
          and(
            eq(billingMandates.storeId, input.storeId),
            eq(billingMandates.status, "active"),
          ),
        );

      const rows = await db
        .insert(billingMandates)
        .values({
          storeId: input.storeId,
          providerTokenId: input.providerTokenId,
          providerCustomerId: input.providerCustomerId ?? null,
          method: input.method,
          status: "active",
          maxAmountPaise: input.maxAmountPaise ?? null,
          authenticatedAt: input.now.toISOString(),
        })
        .onConflictDoNothing()
        .returning({ id: billingMandates.id });
      return rows[0]?.id ?? null;
    });
  } catch (err) {
    logError("billing.activate_mandate", err, { storeId: input.storeId });
    return null;
  }
}

/**
 * Audit the plan change.
 *
 * ★★ `source: "billing"`, NEVER `"paid"`. `plan_events.source` is
 * CHECK-constrained to operator|billing|system while `stores.plan_source` allows
 * comp|paid|trial, and all three previous billing writers reached for the wrong
 * one — rejected by Postgres every time, and because the insert shared a
 * transaction with the plan update, the rejection ROLLED BACK the plan the
 * merchant had just been charged for. It surfaced as "payment succeeded but
 * activating the plan failed", and it hid for months because the symptom is an
 * empty audit log.
 *
 * ★ Its OWN transaction, so an audit failure can never undo an activation.
 */
export async function auditEnrolment(input: {
  storeId: string;
  fromPlan: string | null;
  toPlan: string;
  note: string;
}): Promise<void> {
  try {
    await withService((db) =>
      db.insert(planEvents).values({
        storeId: input.storeId,
        fromPlan: input.fromPlan,
        toPlan: input.toPlan,
        source: "billing",
        actor: "billing-enrolment",
        note: input.note,
      }),
    );
  } catch (err) {
    logError("billing.audit_enrolment", err, { storeId: input.storeId });
  }
}

/** Is this plan one a merchant can subscribe to? */
export function isSubscribablePlan(plan: unknown): plan is Plan {
  return (
    (plan === "basic" || plan === "pro") &&
    limitsFor(plan as Plan).posLocationsIncluded >= 0
  );
}
