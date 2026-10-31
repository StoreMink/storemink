import "server-only";

/**
 * GST at the moment of an on-session payment (GST design 5.2), in ONE place.
 *
 * ★★ ONE RULE FOR EVERY PAYMENT. Enrolment, a plan change, a location
 * purchase and a Mink credit pack each read the tax once before anything is
 * written, and refuse the same two cases while GST is charged: the merchant's
 * state is not on record (only StoreMink's own is known), or the business is
 * outside India. The checkout quote's flags ask the same function, so the
 * dialog cannot enable Pay for a payment the start refuses, or the reverse.
 * Four hand-written copies used to sit in `enrol.ts`, `plan-change.ts`,
 * `locations.ts` and `ai-credit-actions.ts`, and a fifth as booleans in
 * `quote.ts`: identical, until someone tightens one.
 *
 * ★ A leaf: the tax reading (`invoice-store`), the refusal sentences
 * (`tax-copy`), the logger, and one gateway read for the capture time. Every
 * caller's test mocks those already, so importing this adds no mocking
 * surface.
 *
 * Not a "use server" file: every export of one is a public endpoint.
 */

import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { rzpFetchPayment } from "@/lib/payments/razorpay";
import { loadTaxSnapshot } from "./invoice-store";
import { PAYMENT_REFUSAL } from "./tax-copy";
import type { TaxSnapshot } from "./tax-snapshot";

/** A tax reading that resolved (StoreMink's identity complete). */
export type OkTaxSnapshot = Extract<TaxSnapshot, { ok: true }>;

/** Why a payment made now would be refused. */
export type PaymentTaxRefusal = "needsState" | "outsideIndia";

/**
 * Would a payment made under this reading be refused, and for what?
 *
 * Only while GST is charged (`terms.active`): with GST off a payment needs no
 * place of supply. `supplier_state` means only StoreMink's own state is
 * known, which a tax invoice cannot use for a recipient; `outside_india` is
 * an export of services this build does not invoice (GST design 5.2).
 */
export function paymentTaxRefusal(
  snap: Pick<OkTaxSnapshot, "terms" | "placeOfSupply">,
): PaymentTaxRefusal | null {
  if (!snap.terms.active) return null;
  if (snap.placeOfSupply.basis === "supplier_state") return "needsState";
  if (snap.placeOfSupply.basis === "outside_india") return "outsideIndia";
  return null;
}

/** The tax reading for a payment, or the sentence the merchant reads. */
export type PaymentTaxReading =
  | { ok: true; snap: OkTaxSnapshot }
  | { ok: false; error: string };

/**
 * The tax reading for an on-session payment, or the refusal the merchant
 * reads (`PAYMENT_REFUSAL`). Nothing is written before it, so a refusal leaves
 * no trace to clean up.
 *
 * `logPrefix` keeps each payment's own log names (`billing.enrol`,
 * `billing.plan_change`, `billing.locations`, `billing.credit_pack`):
 * `<prefix>.tax_snapshot` for a reading that failed or is incomplete (error),
 * `<prefix>.payment_refused` with `reason` `no_state` or `outside_india`
 * (info).
 */
export async function readTaxForPayment(
  storeId: string,
  now: Date,
  logPrefix: string,
): Promise<PaymentTaxReading> {
  let snap: TaxSnapshot;
  try {
    snap = await loadTaxSnapshot(storeId, now);
  } catch (err) {
    logError(`${logPrefix}.tax_snapshot`, err, { storeId });
    return { ok: false, error: PAYMENT_REFUSAL.invoiceFailed };
  }
  if (!snap.ok) {
    logError(
      `${logPrefix}.tax_snapshot`,
      new Error("the GST settings are incomplete"),
      { storeId, reason: snap.reason },
    );
    return { ok: false, error: PAYMENT_REFUSAL.settingsIncomplete };
  }
  const refusal = paymentTaxRefusal(snap);
  if (refusal === "needsState") {
    logInfo(`${logPrefix}.payment_refused`, { storeId, reason: "no_state" });
    return { ok: false, error: PAYMENT_REFUSAL.needsState };
  }
  if (refusal === "outsideIndia") {
    logInfo(`${logPrefix}.payment_refused`, {
      storeId,
      reason: "outside_india",
    });
    return { ok: false, error: PAYMENT_REFUSAL.outsideIndia };
  }
  return { ok: true, snap };
}

/**
 * When the gateway says a payment was made: Razorpay's `created_at`, in
 * seconds since the epoch. Null when the record carries none.
 *
 * Read untyped because the payment types in `lib/payments/razorpay.ts` do not
 * declare the field. Shared by the hourly checks (`reconcile.ts`), the credit
 * pack's reconcile-on-read and the browser confirms below.
 */
export function gatewayCreatedAt(payment: unknown): Date | null {
  const raw = (payment as { created_at?: unknown } | null)?.created_at;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return new Date(raw * 1000);
}

/**
 * When a payment a browser confirm just verified was made, for the invoice's
 * time of supply (GST design 5.4: a frozen draft is issued under the terms in
 * force at the payment, not at the confirm).
 *
 * ★ BEST-EFFORT, NEVER IN THE WAY. A failed read, or a record with no time,
 * answers undefined and the invoice reads its terms at the confirm, as
 * before: the merchant has paid, and a missing time must not hold up their
 * plan. Logged as `<prefix>.payment_time` (warn).
 *
 * ⚠ One extra GET of the payment per confirm: `verifyCapturedCheckoutPayment`
 * reads the same record but returns no time.
 */
export async function paymentCapturedAt(
  creds: Parameters<typeof rzpFetchPayment>[0],
  paymentId: string,
  logPrefix: string,
): Promise<Date | undefined> {
  try {
    const res = await rzpFetchPayment(creds, paymentId);
    if (!res.ok) {
      logWarn(`${logPrefix}.payment_time`, { paymentId, reason: res.error });
      return undefined;
    }
    return gatewayCreatedAt(res.data) ?? undefined;
  } catch (err) {
    logWarn(`${logPrefix}.payment_time`, {
      paymentId,
      reason: err instanceof Error ? err.message : "unknown error",
    });
    return undefined;
  }
}
