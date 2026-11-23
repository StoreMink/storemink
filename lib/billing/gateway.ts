import "server-only";

/**
 * Where the collection seam is wired to the real gateway.
 *
 * `lib/billing/collect.ts` and `lib/billing/debit-pass.ts` take a
 * `RecurringGateway`, never Razorpay itself, so everything above this file is
 * provable independently. This is the ONE provider-specific seam.
 *
 * ★★ A RENEWAL IS TWO CALLS, A DAY OR MORE APART (21 Nov 2026). This file used
 * to create a plain order and send `POST /payments/create/recurring` in the
 * same breath. The 21 Nov test-mode run (docs/autopay-verification.md) showed
 * Razorpay answers that "The requested URL was not found on the server" every
 * time. Its subsequent-payment reference describes what it does accept:
 *
 *   1. `notify`: an order with `payment_capture` and a `notification` object
 *      (`token_id`, `payment_after`). Razorpay sends the customer the
 *      pre-debit notice RBI requires. No money moves.
 *   2. `debit`: `POST /payments/create/recurring` on that order, allowed only
 *      once the notice period has passed since the notice was DELIVERED:
 *      "36 hours and 5 minutes" for a card, "a minimum of 24 hours" for UPI.
 *      Razorpay does not retry a failed debit of a notified order.
 *
 * ★★ THE DEBIT ITSELF HAS NOT BEEN SEEN TO SUCCEED (23 Nov 2026). The first
 * notified order to come due (UPI, test mode, notice delivered, 25 hours
 * passed, mandate confirmed, `readNotice` ready) was still answered HTTP 400
 * "The requested URL was not found on the server" (source `internal`), twice.
 * Razorpay counted an attempt on the order each time and created no payment.
 * So the notification is NECESSARY (it changes the answers before the period
 * ends) and is not shown to be SUFFICIENT. Whether that is the test account,
 * test mode or something Razorpay must switch on is theirs to say
 * (docs/autopay-verification.md). The debit pass records it as a refused try,
 * which is true and safe, and `debit` below logs it as an error, because the
 * answer is about the gateway account and not about one merchant's mandate.
 *
 * and, before either, `checkMandate`: "Only tokens in the confirmed state can
 * be used to execute subsequent payments."
 *
 * ★ `getRecurringGateway` returns null when platform credentials are absent.
 * NULL MUST NOT STOP ISSUANCE: the renewal worker still ISSUES each invoice
 * and the merchant pays it on /dashboard/plans, a complete billing path on its
 * own. (It did stop issuance until 2026-08-13: no invoice was ever written,
 * nobody was ever downgraded, and every subscriber got free service.)
 */

import { resolveBillingEmail } from "@/lib/email/billing-emails";
import { logError, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  rzpChargeMandate,
  rzpCreateOrder,
  rzpFetchOrder,
  rzpFetchToken,
} from "@/lib/payments/razorpay";
import type {
  MandateCheck,
  MandateRail,
  NoticeCheck,
  RecurringGateway,
} from "./collect";

/**
 * Has the provider flow been implemented against the published reference?
 *
 * Enabled 2026-08-16 at the owner's request. The two-step flow below was
 * exercised in Razorpay TEST mode on 21 Nov 2026 as far as the notice
 * period allows (docs/autopay-verification.md). Set this back to false if an
 * observed provider shape differs: invoices are still issued and paid by hand.
 */
export const RECURRING_CHARGE_VERIFIED = true;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * How long after its pre-debit notice is DELIVERED a debit may be sent, per
 * rail.
 *
 * ★ Card: "36 hours and 5 minutes after the notification is delivered"
 *   (Razorpay's reference, and what the API enforces).
 * ★★ UPI: 25 HOURS, NOT THE 24 THE REFERENCE STATES ("a minimum of 24 hours
 *   has passed since the PDN was sent"). Measured on a UPI Autopay mandate in
 *   test mode, 22 Nov 2026: an order asking for its debit 24 h 25 min ahead
 *   was refused with "Debit can be attempted 25 hours after sending the
 *   pre-debit notification"; exactly 25 h 00 min was refused too, 25 h 01 min
 *   was accepted, and an order that names no time is given 25 hours. With 24
 *   here, EVERY UPI renewal was refused at its first step, and UPI Autopay is
 *   the default rail. Five minutes are added, as the card's own rule has.
 * A rail this code does not know is given the longer period: waiting too long
 * costs hours, debiting too early is refused and costs one of three tries.
 */
export const NOTICE_PERIOD_MS: Record<MandateRail, number> = {
  card: 36 * HOUR_MS + 5 * MINUTE_MS,
  upi: 25 * HOUR_MS + 5 * MINUTE_MS,
  emandate: 36 * HOUR_MS + 5 * MINUTE_MS,
  nach: 36 * HOUR_MS + 5 * MINUTE_MS,
  unknown: 36 * HOUR_MS + 5 * MINUTE_MS,
};

/**
 * Slack added on top of the notice period.
 *
 * At `notify` it covers the time Razorpay takes to deliver the notice (about
 * a minute in test mode), because the period runs from DELIVERY and the
 * requested `payment_after` is counted from now. At `readNotice` a smaller
 * margin covers the two clocks disagreeing.
 */
export const NOTICE_REQUEST_MARGIN_MS = 25 * MINUTE_MS;
export const NOTICE_READY_MARGIN_MS = 5 * MINUTE_MS;

/** The gateway seam, or null when automatic collection cannot safely run. */
export function getRecurringGateway(): RecurringGateway | null {
  if (!RECURRING_CHARGE_VERIFIED) return null;
  if (!getPlatformRazorpayCreds()) return null;
  return razorpayRecurringGateway;
}

/** Why collection is unavailable, for the cron's response. */
export function chargeUnavailableReason(): string | null {
  if (!RECURRING_CHARGE_VERIFIED) {
    return "recurring charge flow not yet verified against a test-mode account";
  }
  if (!getPlatformRazorpayCreds()) {
    return "platform Razorpay credentials are not configured";
  }
  return null;
}

/**
 * Read a mandate token's state at the gateway.
 *
 * ★ ONLY `confirmed` IS CHARGEABLE (Razorpay's own rule). `paused` is the
 * customer's pause in their UPI app and can come back; `cancelled`,
 * `cancellation_initiated` and `rejected` cannot. `initiated` (not yet
 * approved) is read as paused: not chargeable now, not gone for good. A state
 * this code does not know, or a read that failed, decides NOTHING: a mandate
 * is never ended on a guess.
 *
 * ★★ THE TOKEN'S `expired_at` ENDS A UPI MANDATE ONLY. Measured in test mode
 * on 21 and 22 Nov 2026, on mandates registered for five years: a UPI token's
 * `expired_at` is that five-year date, but a CARD token's was the last second
 * of the CURRENT MONTH, while its status read `confirmed`. Had a card mandate
 * been ended on that date, every card mandate would have been marked expired
 * on the 1st of the next month, for good (an ended mandate is never asked
 * about again), and each merchant told autopay was no longer active. So for a
 * card the gateway's status is the only word taken; if a card token really
 * has lapsed, its debit is refused, which costs a try and ends nothing. A
 * card token past that date is logged, so the first real month end shows
 * what the date means.
 */
async function checkMandate(input: {
  providerCustomerId: string;
  providerTokenId: string;
}): Promise<MandateCheck> {
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { state: "unknown" };
  const res = await rzpFetchToken(
    creds,
    input.providerCustomerId,
    input.providerTokenId,
  );
  if (!res.ok) return { state: "unknown" };

  const status = (res.data.recurring_details?.status ?? "").toLowerCase();
  const reason = res.data.recurring_details?.failure_reason;
  const detail = reason ? `${status}: ${reason}` : status;
  switch (status) {
    case "confirmed": {
      const expiredAt = res.data.expired_at;
      const pastExpiry =
        typeof expiredAt === "number" && expiredAt * 1000 <= Date.now();
      if (pastExpiry && (res.data.method ?? "").toLowerCase() === "upi") {
        return { state: "ended", detail: "expired" };
      }
      if (pastExpiry) {
        logWarn("billing.mandate_token_past_expiry", {
          tokenId: input.providerTokenId,
          method: res.data.method ?? null,
          expiredAt: new Date((expiredAt as number) * 1000).toISOString(),
        });
      }
      return { state: "chargeable" };
    }
    case "paused":
    case "initiated":
      return { state: "paused", detail };
    case "cancelled":
    case "cancellation_initiated":
    case "rejected":
      return { state: "ended", detail };
    default:
      return { state: "unknown" };
  }
}

/**
 * STEP 1: the order, with its pre-debit notice. No money moves.
 *
 * ★ `payment_capture: true`, as the reference requires, so a captured renewal
 * never depends on the account's capture setting.
 * ★ `payment_after` is asked for at now + the rail's notice period + a margin
 * for delivery. The gateway's own answer (the order's
 * `notification.payment_after`) is what is kept, and never an instant earlier
 * than the one asked for.
 * ★ The attempt's idempotency key rides in `notes` and in `receipt`, so the
 * order can be tied back to its attempt at the gateway.
 */
async function notify(input: {
  amountPaise: number;
  idempotencyKey: string;
  providerTokenId: string;
  rail: MandateRail;
  now: Date;
}): ReturnType<RecurringGateway["notify"]> {
  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return {
      ok: false,
      error: "Platform Razorpay credentials are not configured.",
      outcome: "rejected",
    };
  }
  const requested = new Date(
    input.now.getTime() +
      NOTICE_PERIOD_MS[input.rail] +
      NOTICE_REQUEST_MARGIN_MS,
  );
  const order = await rzpCreateOrder(creds, {
    amountPaise: input.amountPaise,
    receipt: input.idempotencyKey.slice(0, 40),
    notes: { idempotency_key: input.idempotencyKey, kind: "subscription" },
    paymentCapture: true,
    notification: {
      tokenId: input.providerTokenId,
      paymentAfterUnix: Math.floor(requested.getTime() / 1000),
    },
  });
  if (!order.ok) return order;

  // ★ An order that came back WITHOUT its notification could never be
  // debited (that is the "URL not found" failure). Refuse it here, loudly,
  // not thirty-six hours later.
  if (!order.data.notification) {
    return {
      ok: false,
      error: "Razorpay created the order without a pre-debit notification.",
      outcome: "rejected",
    };
  }
  const theirs = order.data.notification.payment_after;
  const debitAfter =
    typeof theirs === "number" && theirs * 1000 > requested.getTime()
      ? new Date(theirs * 1000)
      : requested;
  return { ok: true, data: { providerOrderId: order.data.id, debitAfter } };
}

/**
 * May a notified order be debited yet? Asked of the ORDER, immediately before
 * the debit, so the answer is the gateway's and not our arithmetic.
 *
 * The period runs from DELIVERY, so an undelivered notice is "undelivered",
 * never "ready"; the debit pass gives it time and then fails the attempt.
 */
async function readNotice(input: {
  providerOrderId: string;
  rail: MandateRail;
  now: Date;
}): Promise<NoticeCheck> {
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { state: "unknown" };
  const res = await rzpFetchOrder(creds, input.providerOrderId);
  if (!res.ok) return { state: "unknown" };

  const notice = res.data.notification;
  if (!notice) return { state: "undelivered" };
  if (typeof notice.delivered_at !== "number" || notice.delivered_at <= 0) {
    return { state: "undelivered" };
  }
  const earliest =
    Math.max(
      notice.delivered_at * 1000 + NOTICE_PERIOD_MS[input.rail],
      typeof notice.payment_after === "number"
        ? notice.payment_after * 1000
        : 0,
    ) + NOTICE_READY_MARGIN_MS;
  if (input.now.getTime() < earliest) {
    return { state: "wait", until: new Date(earliest) };
  }
  return { state: "ready" };
}

/**
 * STEP 2: the debit of a notified order.
 *
 * ★ The caller has already taken the attempt's `debit_sent_at` claim, so this
 * is sent at most once per attempt. Every failure is mapped deliberately:
 * nothing sent is `rejected`; anything that may have reached the gateway and
 * was not answered is `unknown`, never `failed`.
 *
 * ⚠ Razorpay documents that for some banks the payment stays `created` (their
 * charging is file-based). `mapGatewayStatus` reads that as in flight, so
 * reconciliation settles it later and no grace window opens on it.
 */
async function debit(input: {
  amountPaise: number;
  idempotencyKey: string;
  providerOrderId: string;
  providerTokenId: string;
  providerCustomerId: string;
  storeId: string;
  description: string;
}): ReturnType<RecurringGateway["debit"]> {
  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return {
      ok: false,
      error: "Platform Razorpay credentials are not configured.",
      outcome: "rejected",
    };
  }
  const contact = await resolveBillingContact(input.storeId);
  if (!contact) {
    // Both are mandatory on the debit. Nothing was sent, so this is a known
    // non-charge, and a charge filed against a placeholder contact would be
    // worse than one that did not happen.
    return {
      ok: false,
      error: "No billing contact to charge against.",
      outcome: "rejected",
    };
  }

  const paid = await rzpChargeMandate(creds, {
    amountPaise: input.amountPaise,
    orderId: input.providerOrderId,
    customerId: input.providerCustomerId,
    tokenId: input.providerTokenId,
    email: contact.email,
    contact: contact.phone,
    description: input.description,
    notes: { idempotency_key: input.idempotencyKey },
  });
  if (!paid.ok) {
    if (paid.outcome === "rejected" && isDebitUnavailableAnswer(paid.error)) {
      // ★ Not this merchant's mandate, bank or balance: the gateway would not
      // run the debit at all, and it will answer every store the same. An
      // error, so an operator hears of it from the first one (23 Nov 2026).
      logError(
        "billing.gateway.debit_unavailable",
        new Error(paid.error.slice(0, 200)),
        {
          storeId: input.storeId,
          providerOrderId: input.providerOrderId,
        },
      );
    }
    return paid;
  }

  const paymentId = paid.data.razorpay_payment_id;
  if (!paymentId) {
    // ★ A 200 with no payment id is NOT a success we can record and NOT a
    // failure we can act on. Reconciliation asks Razorpay about the order.
    return {
      ok: false,
      error: "Razorpay accepted the debit without returning a payment id.",
      outcome: "unknown",
    };
  }
  return {
    ok: true,
    data: {
      providerPaymentId: paymentId,
      // The documented success body is the payment id alone: read as
      // `created`, which is in flight, never as captured.
      status: paid.data.status ?? "created",
    },
  };
}

/**
 * Is this refusal Razorpay's "I will not run a debit for this account", not a
 * verdict on one mandate?
 *
 * Seen on 21 Nov 2026 (an order with no notification) and again on 23 Nov on
 * a notified order whose period had passed: HTTP 400 `BAD_REQUEST_ERROR`,
 * "The requested URL was not found on the server.". A bank's or a mandate's
 * refusal names its reason (insufficient funds, mandate paused); this one
 * names none.
 */
export function isDebitUnavailableAnswer(error: string): boolean {
  return /requested URL was not found/i.test(error);
}

// ★ Exported so it can be tested directly. `getRecurringGateway` is the only
// production caller and it stays gated on RECURRING_CHARGE_VERIFIED.
export const razorpayRecurringGateway: RecurringGateway = {
  checkMandate,
  notify,
  readNotice,
  debit,
};

/**
 * The email and phone Razorpay requires on a recurring debit.
 *
 * Both are MANDATORY per the API reference. A store with neither cannot be
 * charged automatically, which the caller reports as a rejection.
 *
 * ★★ THE SAME RESOLVER ENROLMENT USES (`resolveBillingEmail`), on purpose
 * (PR #303 review, 22 Nov 2026). This used to read `admins.email` and
 * `admins.phone` alone, while enrolment falls back to the store's validated
 * invoice contact phone, because a store made by the signup wizard often has
 * no `admins.phone` (2 of 3 production superadmins on 6 Sep 2026). Such a
 * store could set autopay up and then had every renewal refused here, after
 * the debit was claimed, one of its three tries a day until it was moved to
 * the Free plan. One resolver means a store that can enrol can be debited.
 */
async function resolveBillingContact(
  storeId: string,
): Promise<{ email: string; phone: string } | null> {
  try {
    const to = await resolveBillingEmail(storeId);
    if (!to?.email || !to.phone) return null;
    return { email: to.email, phone: to.phone };
  } catch {
    return null;
  }
}
