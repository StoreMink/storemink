import "server-only";

/**
 * What a gateway order's own record says about whether it can still be paid.
 *
 * One rule, in one place, for every path that wants to free or reopen an
 * unfinished checkout: enrolment and plan changes (`enrol.ts`) and a renewal
 * invoice paid by hand (`manual-pay.ts`). A second hand-written copy of
 * "nobody has paid this" is how one of them ends up abandoning, or reopening,
 * an order somebody has already paid.
 */

import {
  rzpFetchOrderPayments,
  type RazorpayCreds,
  type RzpOrder,
  type RzpResult,
} from "@/lib/payments/razorpay";

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
export async function orderIsUntouched(
  creds: RazorpayCreds,
  order: RzpResult<RzpOrder>,
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
