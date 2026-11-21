import "server-only";

/**
 * What StoreMink's own Razorpay webhook does with a payment result.
 *
 * ★★ WHY (21 Nov 2026). The webhook route verified, deduplicated and then
 * acted on nothing, so every renewal debit was settled only by the hourly
 * reconcile: a debit that cleared a minute after the run waited the best part
 * of an hour, and one that cleared just before the cycle turned could meet a
 * grace notice first. The webhook now carries the gateway's answer straight
 * into the same two functions reconcile uses.
 *
 * ★ IT ADDS NO NEW WAY TO SETTLE A PAYMENT. `settleAttempt` is the same
 * monotonic, conditional claim every other path uses: a replayed or
 * out-of-order delivery changes nothing, a late `failed` after a `captured`
 * is refused by the state machine, and the receipt still goes out once. The
 * hourly reconcile stays the source of truth; this only gets there sooner.
 *
 * What it deliberately leaves alone:
 *   • A payment on an UNISSUED invoice. That is a first payment, a plan
 *     change or a location purchase still inside its own checkout: the
 *     browser's confirm is about to issue the invoice and apply the purchase,
 *     and settling the attempt first would record money against a draft (an
 *     ERROR in the logs for an ordinary purchase). Reconcile finishes one
 *     whose tab closed, after its own 15 minutes.
 *   • A FAILED payment in a manual checkout. Its order stays payable, and a
 *     failed try in the Razorpay window is routinely followed by one that
 *     works.
 *   • An amount or currency that differs from the attempt's. Reconcile
 *     records that payment and files it for a person; nothing is decided here.
 *
 * Never throws. Anything it does not act on is settled by reconcile.
 */

import { desc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { billingInvoices, billingPaymentAttempts } from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { settleAttempt } from "./collect";
import { advanceAfterPayment, announceAutopayStopped } from "./renewal-worker";

export type BillingWebhookOutcome =
  /** The attempt was settled from this delivery. */
  | "settled"
  /** No billing payment attempt was made on that order. */
  | "unmatched"
  /** Recognised, and left for its own checkout or for reconcile. */
  | "deferred"
  /** The amount or currency differs from the attempt's: reconcile's to file. */
  | "mismatch"
  /** Nothing to change (a replay, or a failed try in a manual checkout). */
  | "ignored"
  /** It could not be read or written; reconcile settles it. */
  | "error";

export interface BillingPaymentEvent {
  result: "captured" | "failed";
  providerOrderId: string;
  providerPaymentId: string;
  /** The payment's amount, in paise, as the gateway reports it. */
  amountPaise: number | null;
  currency: string | null;
  /** Why it failed, for the attempt's record. */
  failureReason?: string | null;
  now?: Date;
}

export async function applyBillingPaymentEvent(
  event: BillingPaymentEvent,
): Promise<BillingWebhookOutcome> {
  const now = event.now ?? new Date();
  if (!event.providerOrderId || !event.providerPaymentId) return "ignored";

  let attempt:
    | {
        id: string;
        storeId: string | null;
        invoiceId: string;
        mode: string;
        amountPaise: number;
        invoiceFinalizedAt: string | null;
      }
    | undefined;
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: billingPaymentAttempts.id,
          storeId: billingPaymentAttempts.storeId,
          invoiceId: billingPaymentAttempts.invoiceId,
          mode: billingPaymentAttempts.mode,
          amountPaise: billingPaymentAttempts.amountPaise,
          invoiceFinalizedAt: billingInvoices.finalizedAt,
        })
        .from(billingPaymentAttempts)
        .innerJoin(
          billingInvoices,
          eq(billingInvoices.id, billingPaymentAttempts.invoiceId),
        )
        .where(
          eq(billingPaymentAttempts.providerOrderId, event.providerOrderId),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1),
    );
    attempt = rows[0];
  } catch (err) {
    logError("billing.webhook.load_attempt", err, {
      providerOrderId: event.providerOrderId,
    });
    return "error";
  }
  // A credit pack, a store's own order on another account, or a test event.
  if (!attempt) return "unmatched";

  try {
    if (event.result === "captured") {
      if (
        (typeof event.amountPaise === "number" &&
          event.amountPaise !== attempt.amountPaise) ||
        (event.currency && event.currency !== "INR")
      ) {
        logWarn("billing.webhook.amount_mismatch", {
          attemptId: attempt.id,
          expectedPaise: attempt.amountPaise,
          observedPaise: event.amountPaise,
          currency: event.currency,
        });
        return "mismatch";
      }
      if (!attempt.invoiceFinalizedAt) return "deferred";

      const settled = await settleAttempt(attempt.id, "captured", {
        providerPaymentId: event.providerPaymentId,
        now,
      });
      if (settled !== "captured") return "ignored";
      logInfo("billing.webhook.captured", {
        attemptId: attempt.id,
        storeId: attempt.storeId,
        invoiceId: attempt.invoiceId,
      });
      // ★ The plan follows the money, exactly as when reconcile finds it: a
      // renewal paid in grace moves the cycle on now, not at the next run.
      if (attempt.storeId) await advanceAfterPayment(attempt.storeId, now);
      return "settled";
    }

    // A failed payment. Only an automatic debit is over because of it.
    if (attempt.mode !== "automatic") return "ignored";
    const settled = await settleAttempt(attempt.id, "failed", {
      providerPaymentId: event.providerPaymentId,
      failureCode: "gateway_failed",
      failureReason:
        event.failureReason?.slice(0, 300) ||
        "the gateway reports the debit failed",
      now,
    });
    if (settled !== "failed") return "ignored";
    logInfo("billing.webhook.failed", {
      attemptId: attempt.id,
      storeId: attempt.storeId,
      invoiceId: attempt.invoiceId,
    });
    // When that was the last automatic try, ask the merchant to pay by hand.
    if (attempt.storeId) {
      await announceAutopayStopped({
        storeId: attempt.storeId,
        invoiceId: attempt.invoiceId,
        now,
      });
    }
    return "settled";
  } catch (err) {
    logError("billing.webhook.apply", err, { attemptId: attempt.id });
    return "error";
  }
}
