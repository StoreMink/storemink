import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// Minimal Razorpay REST client — plain fetch + basic auth, no SDK (the SDK
// pulls a dependency tree for what is three endpoints). Used both for a
// store's BYO gateway (order payments, creds from store_payment_providers)
// and the PLATFORM's own account (AI-credit purchases, creds from env).
//
// Docs: https://razorpay.com/docs/api/orders/ + /payments/

const RZP_BASE = "https://api.razorpay.com/v1";

export interface RazorpayCreds {
  keyId: string;
  keySecret: string;
}

function authHeader(creds: RazorpayCreds): string {
  return `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64")}`;
}

export interface RzpOrder {
  id: string;
  amount: number; // paise
  currency: string;
  receipt: string | null;
  status: string;
  /** Set on a recurring authorisation order: the rail the mandate is bound to. */
  method?: string | null;
  /** How many times a payment has been tried against this order. 0 = untouched. */
  attempts?: number | null;
  amount_paid?: number | null;
  /**
   * The pre-debit notification of a recurring (subsequent) payment's order.
   * Present only when the order was created with one.
   */
  notification?: RzpOrderNotification | null;
}

/**
 * The pre-debit notice Razorpay sends the customer for one recurring debit.
 *
 * ★ Read back from the ORDER (`GET /orders/:id`), observed in test mode on
 * 21 Nov 2026: `status` is `created` when the order is made and `delivered`
 * about a minute later, with `delivered_at` set. The debit is allowed only
 * once the notice period has passed since delivery.
 */
export interface RzpOrderNotification {
  id?: string;
  token_id?: string;
  /** Unix SECONDS: the earliest instant the debit may be attempted. */
  payment_after?: number | null;
  /** `created` until Razorpay has sent it, then `delivered`. */
  status?: string | null;
  /** Unix SECONDS: when the customer was sent the notice. */
  delivered_at?: number | null;
}

export interface RzpPayment {
  id: string;
  order_id: string;
  amount: number; // paise
  currency?: string;
  status: string; // created | authorized | captured | refunded | failed
}

/**
 * `outcome` separates "Razorpay said no" from "we never found out".
 *
 * It matters for exactly one caller — refunds. A 4xx is a verdict: the request
 * was rejected and nothing happened, so the refund row can be failed and its
 * amount freed. A 5xx or a network throw is NOT a verdict: the refund may well
 * have been created, and treating it as a failure is how a customer gets paid
 * twice. Every other caller can ignore this field.
 */
export type RzpResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; outcome: "rejected" | "unknown" };

/** Statuses that say "ask again later", never anything about the request. */
const TEMPORARY_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * Whether a failed response is a verdict (`rejected`) or tells us nothing
 * (`unknown`).
 *
 * A 5xx means their side broke partway; a write may still have landed. A 4xx
 * is a decision, with one exception:
 *
 * ★★ A "TOO MANY REQUESTS" (429) OR A TIMEOUT STATUS (408, 425) ON A READ IS
 * NOT A REFUSAL (PR #303 re-review, 22 Nov 2026). Callers read a rejected
 * READ as "these keys cannot read this object": the key was revoked, or the
 * order belongs to another Razorpay account. `settleBeforeGatewayChange`
 * skips such an order and lets the store disconnect, and the reaper waits a
 * week and then cancels it. A 429 says none of that, only that Razorpay was
 * busy, and a paid order read during a busy minute was skipped, the
 * connection removed, and the order cancelled with its stock and credit given
 * back. So on a read these are `unknown`: nothing was learned, ask again.
 * ★ On a WRITE they stay `rejected`, which is true there: Razorpay turned the
 * request away before doing anything, so no order or refund was created.
 */
export function failureOutcome(
  status: number,
  method: string | undefined,
): "rejected" | "unknown" {
  if (status >= 500) return "unknown";
  const isRead = !method || method.toUpperCase() === "GET";
  if (isRead && TEMPORARY_STATUSES.has(status)) return "unknown";
  return "rejected";
}

async function rzpFetch<T>(
  creds: RazorpayCreds,
  path: string,
  init?: RequestInit,
): Promise<RzpResult<T>> {
  try {
    const res = await fetch(`${RZP_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json",
        ...init?.headers,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      // Razorpay error bodies: { error: { code, description } }
      let description = `Razorpay request failed (${res.status})`;
      try {
        const body = (await res.json()) as {
          error?: { description?: string };
        };
        if (body?.error?.description) description = body.error.description;
      } catch {
        // non-JSON error body — keep the status message
      }
      return {
        ok: false,
        error: description,
        outcome: failureOutcome(res.status, init?.method),
      };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Razorpay request failed",
      // A timeout is indistinguishable from a success we never read.
      outcome: "unknown",
    };
  }
}

/** Create a Razorpay Order for the given (server-computed!) amount. */
export async function rzpCreateOrder(
  creds: RazorpayCreds,
  params: {
    amountPaise: number;
    receipt?: string;
    notes?: Record<string, string>;
    /**
     * Capture the payment automatically. Sent ONLY when given: an ordinary
     * checkout order leaves capture to the account's own setting, as before.
     * Razorpay's reference marks it mandatory on the order of a subsequent
     * (recurring) payment.
     */
    paymentCapture?: boolean;
    /**
     * The pre-debit notification of a subsequent (recurring) payment: which
     * mandate token will be debited, and the earliest instant of the debit in
     * Unix SECONDS. Razorpay sends the customer the notice when the order is
     * created. ★ Without this object the debit call is answered "The requested
     * URL was not found on the server" (docs/autopay-verification.md).
     */
    notification?: { tokenId: string; paymentAfterUnix: number };
  },
): Promise<RzpResult<RzpOrder>> {
  if (!Number.isInteger(params.amountPaise) || params.amountPaise < 100) {
    // Razorpay's own minimum is ₹1 (100 paise).
    return {
      ok: false,
      error: "Amount too small for an online payment.",
      outcome: "rejected",
    };
  }
  return rzpFetch<RzpOrder>(creds, "/orders", {
    method: "POST",
    body: JSON.stringify({
      amount: params.amountPaise,
      currency: "INR",
      receipt: params.receipt,
      notes: params.notes,
      ...(params.paymentCapture === undefined
        ? {}
        : { payment_capture: params.paymentCapture }),
      ...(params.notification
        ? {
            notification: {
              token_id: params.notification.tokenId,
              payment_after: params.notification.paymentAfterUnix,
            },
          }
        : {}),
    }),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Recurring (autopay). Verified against Razorpay's published API reference on
// 2026-08-14 — the endpoint paths and field names below are quoted from it, not
// inferred. What is NOT verified is the live behaviour: see
// docs/autopay-verification.md for the test-mode run that flips the flag in
// lib/billing/gateway.ts.
// ───────────────────────────────────────────────────────────────────────────

export interface RzpCustomer {
  id: string;
  name?: string;
  email?: string;
  contact?: string;
}

/**
 * A recurring mandate is attached to a CUSTOMER, not to an order, so one has to
 * exist before the authorisation order is created.
 *
 * ★ `fail_existing: "0"` makes this IDEMPOTENT — Razorpay returns the existing
 * customer instead of erroring when the email or contact already exists. That
 * matters because a merchant who abandons checkout and comes back must not be
 * blocked by their own half-finished first attempt.
 */
export async function rzpCreateCustomer(
  creds: RazorpayCreds,
  params: { name?: string; email?: string; contact?: string },
): Promise<RzpResult<RzpCustomer>> {
  if (!params.email && !params.contact) {
    return {
      ok: false,
      error: "A customer needs an email or a phone number.",
      outcome: "rejected",
    };
  }
  return rzpFetch<RzpCustomer>(creds, "/customers", {
    method: "POST",
    body: JSON.stringify({
      name: params.name,
      email: params.email,
      contact: params.contact,
      fail_existing: "0",
    }),
  });
}

/** How often we may debit, and the ceiling per debit. */
export interface RzpMandateTerms {
  /**
   * The most Razorpay will EVER let us debit under this mandate.
   *
   * ★★ CAPPED AT ₹99,999 BY RAZORPAY for UPI mandates — their documented
   * maximum for `token.max_amount`. `lib/billing/cycle.ts` sizes the mandate and
   * clamps to it; an amount above the ceiling routes to manual collection
   * instead of failing at the gateway. Do not raise this without re-reading
   * their docs.
   */
  maxAmountPaise: number;
  /** Unix SECONDS. Razorpay wants a timestamp, not an ISO string. */
  expireAtUnix: number;
  frequency: "daily" | "weekly" | "monthly" | "yearly" | "as_presented";
}

/**
 * The FIRST payment — the one that registers the mandate.
 *
 * It is an ordinary order plus `customer_id` and a `token` block; the customer
 * approves both the payment and the standing authorisation in one checkout.
 */
export async function rzpCreateAuthorizationOrder(
  creds: RazorpayCreds,
  params: {
    amountPaise: number;
    customerId: string;
    terms: RzpMandateTerms;
    /**
     * ★★ REQUIRED FOR A RECURRING AUTHORISATION ORDER, and the rail cannot be
     * left to the customer at Checkout.
     *
     * This used to read "omit to let the customer pick at checkout", which is
     * simply not how Razorpay works: its recurring docs declare the rail on the
     * ORDER — `"method": "card"` for a card mandate, `"method": "upi"` for UPI
     * Autopay — and omitting it yields a CARD mandate. That is why the merchant
     * saw a Cards-only Checkout with UPI Autopay fully enabled on the account
     * (`recurring.upi_autopay → collect, intent` in Checkout's own preferences).
     *
     * So the rail has to be chosen BEFORE the order exists, which is why it is
     * a step in the review dialog rather than a Checkout affordance.
     */
    method: "upi" | "card" | "emandate" | "nach";
    receipt?: string;
    description?: string;
    notes?: Record<string, string>;
  },
): Promise<RzpResult<RzpOrder>> {
  if (!Number.isInteger(params.amountPaise) || params.amountPaise < 100) {
    return {
      ok: false,
      error: "Amount too small for an online payment.",
      outcome: "rejected",
    };
  }
  return rzpFetch<RzpOrder>(creds, "/orders", {
    method: "POST",
    body: JSON.stringify({
      amount: params.amountPaise,
      currency: "INR",
      customer_id: params.customerId,
      method: params.method,
      token: {
        max_amount: params.terms.maxAmountPaise,
        expire_at: params.terms.expireAtUnix,
        frequency: params.terms.frequency,
      },
      receipt: params.receipt,
      description: params.description,
      notes: params.notes,
    }),
  });
}

export interface RzpRecurringPayment {
  razorpay_payment_id?: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
  /** Present on some responses; absent ones are resolved by reconciliation. */
  status?: string;
}

/**
 * Charge an existing mandate — the SUBSEQUENT payment.
 *
 * ★★ IT NEEDS AN ORDER FIRST, AND THE ORDER NEEDS ITS PRE-DEBIT NOTICE.
 * `POST /payments/create/recurring` takes an `order_id`, and Razorpay accepts
 * the debit only for an order created with a `notification` object, and only
 * once the notice period has passed since that notice was delivered (36 hours
 * 5 minutes for a card, 25 hours for UPI). So a renewal is TWO calls a day or
 * more apart: `rzpCreateOrder` with `notification`, then this. The caller
 * (lib/billing/gateway.ts) owns both steps.
 *
 * ⚠ NOT YET SEEN TO SUCCEED (23 Nov 2026): the first notified test order to
 * come due, a UPI one, was still answered HTTP 400 "The requested URL was not
 * found on the server" after its period had passed
 * (docs/autopay-verification.md). The request below is Razorpay's documented
 * one, field for field.
 *
 * ★ `email` and `contact` are MANDATORY per the API reference, which is why the
 * mandate stores the customer id and the caller resolves the billing contact.
 *
 * ⚠ Razorpay documents that for some banks the payment stays `created` rather
 * than reaching `captured` immediately (file-based charging). That is NOT a
 * failure — `mapGatewayStatus` already resolves `created` to a non-terminal
 * state, and reconciliation settles it later.
 */
export async function rzpChargeMandate(
  creds: RazorpayCreds,
  params: {
    amountPaise: number;
    orderId: string;
    customerId: string;
    tokenId: string;
    email: string;
    contact: string;
    description?: string;
    notes?: Record<string, string>;
  },
): Promise<RzpResult<RzpRecurringPayment>> {
  return rzpFetch<RzpRecurringPayment>(creds, "/payments/create/recurring", {
    method: "POST",
    body: JSON.stringify({
      email: params.email,
      contact: params.contact,
      amount: params.amountPaise,
      currency: "INR",
      order_id: params.orderId,
      customer_id: params.customerId,
      token: params.tokenId,
      recurring: true,
      description: params.description,
      notes: params.notes,
    }),
  });
}

/** A registered mandate, as `GET /customers/:id/tokens/:token_id` returns it. */
export interface RzpToken {
  id: string;
  method?: string | null;
  recurring?: boolean | null;
  /**
   * The mandate's own state. Razorpay's reference: `initiated`, `confirmed`,
   * `rejected`, `cancelled`, `paused` (UPI also shows `cancellation_initiated`
   * while NPCI confirms a closure), and "Only tokens in the confirmed state
   * can be used to execute subsequent payments."
   */
  recurring_details?: {
    status?: string | null;
    failure_reason?: string | null;
  } | null;
  /** The mandate's ceiling, in paise. */
  max_amount?: number | null;
  /** Unix SECONDS: "The token expiry date timestamp." */
  expired_at?: number | null;
}

/** One mandate token of a customer, with its current state at the gateway. */
export async function rzpFetchToken(
  creds: RazorpayCreds,
  customerId: string,
  tokenId: string,
): Promise<RzpResult<RzpToken>> {
  return rzpFetch<RzpToken>(
    creds,
    `/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}`,
    { method: "GET" },
  );
}

export interface RzpPaymentDetail {
  id: string;
  order_id?: string | null;
  amount?: number;
  currency?: string;
  status?: string;
  method?: string;
  /** Present once an authorisation payment has registered a mandate. */
  token_id?: string | null;
  customer_id?: string | null;
}

export type CapturedCheckoutVerification =
  | { ok: true; gatewayRead: true }
  | { ok: true; gatewayRead: false }
  | { ok: false; error: string };

/**
 * Verify the browser callback against Razorpay's own payment record.
 *
 * The checkout HMAC remains mandatory at every caller. This is the second
 * boundary: a valid callback must also name a CAPTURED INR payment for the
 * exact order and amount StoreMink created. A temporary Razorpay read outage
 * falls back to the HMAC (and is reconciled later); a contradictory gateway
 * record fails closed and never grants an entitlement.
 */
export async function verifyCapturedCheckoutPayment(
  creds: RazorpayCreds,
  input: {
    paymentId: string;
    orderId: string;
    amountPaise: number;
  },
): Promise<CapturedCheckoutVerification> {
  const fetched = await rzpFetchPayment(creds, input.paymentId);
  if (!fetched.ok) {
    // The HMAC still proves association. Refusing to finish after a transient
    // read outage strands a captured payment and can make the merchant retry.
    return { ok: true, gatewayRead: false };
  }
  const payment = fetched.data;
  if (payment.id !== input.paymentId || payment.order_id !== input.orderId) {
    return { ok: false, error: "The payment belongs to a different order." };
  }
  if (payment.amount !== input.amountPaise || payment.currency !== "INR") {
    return {
      ok: false,
      error: "The captured amount does not match the invoice.",
    };
  }
  if (payment.status !== "captured") {
    return {
      ok: false,
      error:
        "The payment is still being confirmed. Don't pay again; check back shortly.",
    };
  }
  return { ok: true, gatewayRead: true };
}

/**
 * One payment, by id — and the ONLY honest way to learn a mandate's token.
 *
 * ★★ THE TOKEN IS READ HERE, NEVER TAKEN FROM THE CLIENT. Razorpay Checkout's
 * success handler hands the browser a payment id, an order id and a signature —
 * not a token — so any client-supplied `token_id` would be a value the browser
 * chose. Attaching a mandate the merchant did not authorise is a standing
 * permission to debit them; reading it from the payment we have just verified
 * removes the question entirely. Same rule as every price in this codebase.
 */
/**
 * Read one order back.
 *
 * ★ Needed because a recurring authorisation order's RAIL is fixed when the
 * order is created and we do not persist it. A resumed enrolment hands the
 * merchant the SAME order (see startEnrolment), so the only way to tell them
 * truthfully which rail they are about to authorise on is to ask.
 */
export async function rzpFetchOrder(
  creds: RazorpayCreds,
  orderId: string,
): Promise<RzpResult<RzpOrder>> {
  return rzpFetch<RzpOrder>(creds, `/orders/${encodeURIComponent(orderId)}`, {
    method: "GET",
  });
}

export async function rzpFetchPayment(
  creds: RazorpayCreds,
  paymentId: string,
): Promise<RzpResult<RzpPaymentDetail>> {
  return rzpFetch<RzpPaymentDetail>(
    creds,
    `/payments/${encodeURIComponent(paymentId)}`,
  );
}

/** All payment attempts against a Razorpay order — the reconciliation source
 *  of truth (a `captured` payment here means the money was taken). */
export async function rzpFetchOrderPayments(
  creds: RazorpayCreds,
  rzpOrderId: string,
): Promise<RzpResult<RzpPayment[]>> {
  const res = await rzpFetch<{ items: RzpPayment[] }>(
    creds,
    `/orders/${encodeURIComponent(rzpOrderId)}/payments`,
  );
  if (!res.ok) return res;
  return { ok: true, data: res.data.items ?? [] };
}

/** The captured payment on an order, if any. */
export function capturedPayment(payments: RzpPayment[]): RzpPayment | null {
  return payments.find((p) => p.status === "captured") ?? null;
}

/**
 * Capture a payment the shopper AUTHORIZED but nobody captured yet.
 *
 * ★★ WHY IT EXISTS. Capture is an account SETTING at Razorpay, not something
 * the order fixes, so on an account set to manual capture the checkout
 * callback fires on authorization: the money is only held, Razorpay voids it
 * after its capture window, and a refund of it fails because there is
 * nothing captured to refund. Capturing the exact amount we created the
 * order for, before marking the order paid, makes the store's own capture
 * setting irrelevant.
 *
 * Capturing is idempotent at Razorpay in effect: a second capture of a
 * captured payment is refused with a 4xx, and callers re-read the payment
 * rather than trusting either answer.
 */
export async function rzpCapturePayment(
  creds: RazorpayCreds,
  paymentId: string,
  amountPaise: number,
): Promise<RzpResult<RzpPaymentDetail>> {
  if (!paymentId) {
    return { ok: false, error: "No payment to capture.", outcome: "rejected" };
  }
  if (!Number.isInteger(amountPaise) || amountPaise < 100) {
    return {
      ok: false,
      error: "Amount too small to capture.",
      outcome: "rejected",
    };
  }
  return rzpFetch<RzpPaymentDetail>(
    creds,
    `/payments/${encodeURIComponent(paymentId)}/capture`,
    {
      method: "POST",
      body: JSON.stringify({ amount: amountPaise, currency: "INR" }),
    },
  );
}

// ───────────────────────────────── Refunds ─────────────────────────────────
// Money going back out (roadmap Step 2, docs/returns-exchanges-plan.md §3.2).
//
// Refunds are the one call here where a retry is DANGEROUS: a timeout is
// indistinguishable from a failure, and retrying blind pays the customer
// twice. So every create carries an idempotency key the CALLER generated and
// persisted first — see refundOrder in app/actions/refund-actions.ts.

export interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number; // paise
  /** pending | processed | failed */
  status: string;
  notes?: Record<string, string> | null;
  speed_processed?: string | null;
}

/**
 * Refund (part of) a captured payment.
 *
 * `idempotencyKey` is sent BOTH as Razorpay's idempotency header — so a repeat
 * with the same key returns the original refund instead of making a second one
 * — and inside `notes`, so the reconcile sweep can match a refund back to the
 * row that asked for it EXACTLY, rather than guessing from the amount (two
 * legitimate ₹500 refunds on one order are indistinguishable by amount).
 *
 * The notes copy is the load-bearing half: it is the one that still works if
 * the header is ever unsupported, renamed, or silently ignored.
 */
export async function rzpRefund(
  creds: RazorpayCreds,
  params: {
    paymentId: string;
    amountPaise: number;
    idempotencyKey: string;
    notes?: Record<string, string>;
  },
): Promise<RzpResult<RzpRefund>> {
  // Both are our own preconditions, so nothing was sent and nothing happened —
  // "rejected", which lets the caller free the amount rather than leaving a
  // refund pending against a call that was never made.
  if (!params.paymentId) {
    return {
      ok: false,
      error: "No payment to refund.",
      outcome: "rejected",
    };
  }
  if (!Number.isInteger(params.amountPaise) || params.amountPaise < 100) {
    // Razorpay's floor is ₹1, same as a payment.
    return {
      ok: false,
      error: "Amount too small to refund online.",
      outcome: "rejected",
    };
  }
  if (!/^[A-Za-z0-9_-]{10,}$/.test(params.idempotencyKey)) {
    // Razorpay rejects shorter keys and any punctuation outside `_` / `-`.
    // Rejecting before the request keeps this a known non-event instead of
    // relying on a provider 400 for a safety property we can prove locally.
    return {
      ok: false,
      error: "Invalid refund idempotency key.",
      outcome: "rejected",
    };
  }
  return rzpFetch<RzpRefund>(
    creds,
    `/payments/${encodeURIComponent(params.paymentId)}/refund`,
    {
      method: "POST",
      // Razorpay's refund API has its own idempotency header. This is NOT the
      // generic-looking `X-Razorpay-Idempotency-Key`: using that unrecognised
      // name silently removes the provider-side duplicate guard.
      headers: { "X-Refund-Idempotency": params.idempotencyKey },
      body: JSON.stringify({
        amount: params.amountPaise,
        notes: { ...params.notes, sm_refund_key: params.idempotencyKey },
      }),
    },
  );
}

/** Most refunds Razorpay returns in one page of the list endpoint. */
export const RZP_REFUND_PAGE_SIZE = 100;

/** Refunds recorded against a payment, one page at a time — the
 *  reconciliation source of truth when a create call's outcome was never
 *  learned.
 *
 *  ★ PAGED, because the list defaults to the newest 10. A payment with more
 *  refunds than one page holds (a long run of partial returns) would hide an
 *  older one, and reconcile reads "not in the list" as "never reached the
 *  gateway" after its grace period, which fails a refund that really
 *  happened and frees its amount to be refunded a second time. */
export async function rzpFetchPaymentRefunds(
  creds: RazorpayCreds,
  paymentId: string,
  page: { count?: number; skip?: number } = {},
): Promise<RzpResult<RzpRefund[]>> {
  const count = Math.min(
    RZP_REFUND_PAGE_SIZE,
    Math.max(1, Math.trunc(page.count ?? RZP_REFUND_PAGE_SIZE)),
  );
  const skip = Math.max(0, Math.trunc(page.skip ?? 0));
  const res = await rzpFetch<{ items: RzpRefund[] }>(
    creds,
    `/payments/${encodeURIComponent(paymentId)}/refunds?count=${count}&skip=${skip}`,
  );
  if (!res.ok) return res;
  return { ok: true, data: res.data.items ?? [] };
}

/** Cheap authenticated call to prove a key pair works ("Verify & save"). */
export async function validateCredentials(
  creds: RazorpayCreds,
): Promise<RzpResult<true>> {
  const res = await rzpFetch<unknown>(creds, "/orders?count=1");
  if (!res.ok) return res;
  return { ok: true, data: true };
}

/**
 * Razorpay Standard Checkout success signature:
 *   HMAC-SHA256(key_secret, `${order_id}|${payment_id}`) === signature.
 * Pure (no I/O) — unit-tested with a known vector. Constant-time compare.
 */
export function verifyCheckoutSignature(
  keySecret: string,
  rzpOrderId: string,
  rzpPaymentId: string,
  signature: string,
): boolean {
  if (!keySecret || !rzpOrderId || !rzpPaymentId || !signature) return false;
  const expected = createHmac("sha256", keySecret)
    .update(`${rzpOrderId}|${rzpPaymentId}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─────────────────────────── Subscriptions (autopay) ───────────────────────
/**
 * Razorpay WEBHOOK signature (Phase 2): HMAC-SHA256 of the RAW request body
 * with the webhook secret, compared to the X-Razorpay-Signature header. Pure.
 */
export function verifyWebhookSignature(
  webhookSecret: string,
  rawBody: string,
  signature: string,
): boolean {
  if (!webhookSecret || !rawBody || !signature) return false;
  const expected = createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
