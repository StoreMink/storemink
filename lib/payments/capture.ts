import "server-only";

// Is a storefront order's Razorpay payment really captured, and if it is
// only authorized, capture it.
//
// ★★ WHY THIS EXISTS. Capture is a SETTING on the merchant's Razorpay
// account, not something the order fixes. On an account set to capture
// manually, Checkout's success callback fires on AUTHORIZATION: the money is
// only held. The callback path used to check the signature and nothing else,
// so the order was marked paid and shipped, Razorpay voided the hold after its
// capture window, and the refund that followed failed because nothing had
// been captured. Reconcile and the reaper, meanwhile, accepted only
// `captured`, so the same payment read as unpaid there.
//
// Capturing here, for exactly the amount we created the order for, makes the
// merchant's capture setting irrelevant, and gives every path one answer.

import {
  capturedPayment,
  rzpCapturePayment,
  rzpFetchOrderPayments,
  rzpFetchPayment,
  type RazorpayCreds,
} from "./razorpay";
import { logError } from "@/lib/observability/logger";

export type OrderPaymentState =
  /** Money was taken: mark the order paid with this payment. */
  | { kind: "captured"; paymentId: string; amountPaise: number | null }
  /** Nothing captured (or capturable) yet. */
  | { kind: "none" }
  /** We could not read the gateway; decide nothing. */
  | { kind: "unknown" };

/**
 * The captured payment on a Razorpay order, capturing an authorized one of
 * the exact expected amount when `capture` is set.
 *
 * ★ `capture: false` for an order that is already dead (cancelled because
 * payment never arrived): a hold on a dead order is left for Razorpay to void,
 * which returns the customer's money automatically. Capturing it would take
 * money for an order the shop has already given up on.
 */
export async function settleOrderPayment(
  creds: RazorpayCreds,
  rzpOrderId: string,
  expectedPaise: number,
  opts: { capture: boolean },
): Promise<OrderPaymentState> {
  const res = await rzpFetchOrderPayments(creds, rzpOrderId);
  if (!res.ok) return { kind: "unknown" };

  const captured = capturedPayment(res.data);
  if (captured) {
    return {
      kind: "captured",
      paymentId: captured.id,
      amountPaise: typeof captured.amount === "number" ? captured.amount : null,
    };
  }
  if (!opts.capture) return { kind: "none" };

  const authorized = res.data.find(
    (p) =>
      p.status === "authorized" &&
      p.amount === expectedPaise &&
      (p.currency ?? "INR") === "INR",
  );
  if (!authorized) return { kind: "none" };

  return (await captureAndConfirm(creds, authorized.id, expectedPaise))
    ? { kind: "captured", paymentId: authorized.id, amountPaise: expectedPaise }
    : { kind: "unknown" };
}

export type CallbackVerification =
  /** Safe to mark paid. `verified` false means the gateway could not be read
   *  and the checkout signature alone vouches for the payment. */
  { ok: true; verified: boolean } | { ok: false; error: string };

/**
 * The second check behind a Checkout callback's signature.
 *
 * The signature proves the callback is genuine; this proves the money: the
 * payment belongs to this order, is for the amount we asked, and is captured
 * (capturing it here when it was only authorized). A Razorpay read outage
 * falls back to the signature, as platform billing's check does — refusing
 * after a transient blip strands a real payment and invites the shopper to
 * pay twice; reconcile settles it later either way.
 */
export async function verifyCallbackPayment(
  creds: RazorpayCreds,
  input: { paymentId: string; rzpOrderId: string; expectedPaise: number },
): Promise<CallbackVerification> {
  const fetched = await rzpFetchPayment(creds, input.paymentId);
  if (!fetched.ok) return { ok: true, verified: false };

  const p = fetched.data;
  if (p.id !== input.paymentId || p.order_id !== input.rzpOrderId) {
    return { ok: false, error: "The payment belongs to a different order." };
  }
  if (
    typeof p.amount === "number" &&
    input.expectedPaise > 0 &&
    p.amount !== input.expectedPaise
  ) {
    return {
      ok: false,
      error: "The payment amount doesn't match this order.",
    };
  }
  if (p.currency && p.currency !== "INR") {
    return { ok: false, error: "The payment currency doesn't match." };
  }
  if (p.status === "captured") return { ok: true, verified: true };
  if (p.status === "authorized") {
    if (await captureAndConfirm(creds, input.paymentId, input.expectedPaise)) {
      return { ok: true, verified: true };
    }
    return {
      ok: false,
      error:
        "Your payment is still being confirmed. Don't pay again; this order updates as soon as it's through.",
    };
  }
  if (p.status === "failed") {
    return { ok: false, error: "This payment didn't go through." };
  }
  return {
    ok: false,
    error:
      "Your payment is still being confirmed. Don't pay again; this order updates as soon as it's through.",
  };
}

/** Capture, then re-read: a capture whose answer we never saw, or one made
 *  by a concurrent caller, shows up as `captured` on the re-read. */
async function captureAndConfirm(
  creds: RazorpayCreds,
  paymentId: string,
  amountPaise: number,
): Promise<boolean> {
  const cap = await rzpCapturePayment(creds, paymentId, amountPaise);
  if (cap.ok && cap.data.status === "captured") return true;
  const again = await rzpFetchPayment(creds, paymentId);
  if (again.ok && again.data.status === "captured") return true;
  if (!cap.ok) {
    logError("payments.capture_failed", cap.error, { paymentId });
  }
  return false;
}
