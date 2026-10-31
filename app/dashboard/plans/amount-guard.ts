/**
 * The amount guard (GST design 7.4, drip pricing item (ii)).
 *
 * Every button that opens a payment window asks this first: the window may
 * open only when the amount the server is about to charge is exactly the
 * amount the screen showed. When they differ (a price changed, GST started,
 * a proration day turned), the button shows "The amount to pay is now ..."
 * (`amountChanged` in lib/billing/tax-copy.ts), shows the new figure, and
 * waits for another press.
 *
 * PURE and client-safe. Amounts are paise, whole numbers.
 *
 * ★ A start that carries no payment (RC-F1b's finished earlier purchase,
 * `completedEarlier`, or a plan change applied without one) never reaches
 * this: the callers treat it as a success before they look at an amount, so
 * it can never read as a mismatch.
 */

function isPaise(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * May the payment window open? True only when the screen showed an amount
 * and the start asks for exactly it. An amount the screen never showed
 * (null, not a whole number of paise) is never a match.
 */
export function shouldOpenPayment(
  shownPaise: number | null | undefined,
  startPaise: number,
): boolean {
  if (!isPaise(shownPaise) || !isPaise(startPaise)) return false;
  return shownPaise === startPaise;
}
