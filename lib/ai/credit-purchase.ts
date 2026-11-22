import "server-only";

// Settling a Mink credit pack purchase: marking it paid, granting its credits
// and issuing its receipt, from every place that can learn the payment went
// through.
//
// ★★ WHY THIS IS ITS OWN MODULE (21 Nov 2026). The settle used to be private
// to the dashboard's actions file, so only two things could run it: the
// browser's confirm, and a reconcile pass that ran when somebody opened Plans
// & Billing. A merchant who paid and whose tab closed before the confirm had
// the money taken and no credits until they happened to open that page.
// Moved here, the same settle is also reached by
//   • StoreMink's own Razorpay webhook (`settleCreditPurchaseByOrder`), the
//     moment the payment is captured, and
//   • the hourly billing job (`reconcilePendingCreditPurchases` with no
//     store), which asks Razorpay about recent unfinished purchases.
//
// ★ ONE CLAIM, MANY TRIGGERS. `pending → paid` is a single conditional
// UPDATE, and `add_ai_credits` is idempotent per payment id (a unique partial
// index on the ledger), so the confirm, the webhook and both reconcile passes
// can race freely: exactly one grants the credits, and only that one tells the
// merchant.
//
// Credits revenue is STOREMINK's: every call here uses the platform's own
// Razorpay account, never a store's.

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { aiCreditPurchases } from "@/drizzle/schema";
import { issueCreditInvoice } from "@/lib/billing/credit-invoice";
import { gatewayCreatedAt } from "@/lib/billing/payment-tax";
import { recordEvent } from "@/lib/notifications/record";
import { logError, logInfo } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  capturedPayment,
  rzpFetchOrderPayments,
} from "@/lib/payments/razorpay";

/** A purchase left `pending` this long is presumed dropped and is asked about. */
export const CREDIT_RECONCILE_AFTER_MS = 3 * 60_000;

/**
 * How far back the SCHEDULED pass looks. A purchase nobody finished in three
 * days is abandoned; without a bound every abandoned purchase would cost one
 * gateway call an hour for ever. The pass that runs when the merchant opens
 * Plans & Billing has no such bound, so an older one is still found there.
 */
export const CREDIT_RECONCILE_WINDOW_MS = 72 * 60 * 60_000;

/** Purchases one scheduled pass will ask the gateway about. */
export const CREDIT_RECONCILE_BATCH = 100;

export interface CreditPurchaseRow {
  id: string;
  store_id: string;
  credits: number;
  pack_id: string;
}

interface PendingPurchase extends CreditPurchaseRow {
  rzp_order_id: string | null;
  amount_inr: number;
  amount_paise: number | null;
}

const pendingColumns = {
  id: aiCreditPurchases.id,
  store_id: aiCreditPurchases.storeId,
  credits: aiCreditPurchases.credits,
  pack_id: aiCreditPurchases.packId,
  rzp_order_id: aiCreditPurchases.rzpOrderId,
  amount_inr: aiCreditPurchases.amountInr,
  amount_paise: aiCreditPurchases.amountPaise,
};

/**
 * What the purchase's Razorpay order was created for, in paise: `amount_paise`
 * (GST included when the price excludes it), or the list price for a purchase
 * started before that column existed.
 */
export function creditPurchasePaise(purchase: {
  amount_inr: number;
  amount_paise: number | null;
}): number {
  return purchase.amount_paise ?? purchase.amount_inr * 100;
}

/**
 * Mark a paid purchase and grant its credits, idempotently. Returns whether
 * THIS call made it paid (and so granted the credits).
 *
 * `paidAt` is when Razorpay captured the payment, when the caller knows it, so
 * a pack paid before a scheduled GST change but noticed after it is issued
 * with the terms of its payment time (GST design 5.4 step 4, R1-07). Absent,
 * the receipt reads its terms at issue.
 *
 * Never throws.
 */
export async function settleCreditPurchase(
  purchase: CreditPurchaseRow,
  rzpPaymentId: string,
  paidAt?: Date,
): Promise<boolean> {
  try {
    const claimed = await withService((db) =>
      db
        .update(aiCreditPurchases)
        .set({
          status: "paid",
          rzpPaymentId,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(aiCreditPurchases.id, purchase.id),
            eq(aiCreditPurchases.status, "pending"),
          ),
        )
        .returning({ id: aiCreditPurchases.id }),
    );
    // The status update lost the race (already paid). A concurrent winner may
    // still be between granting credits and issuing the receipt, or a previous
    // best-effort invoice write may have failed. Retrying the paid-finalization
    // is idempotent and repairs that document without granting credits twice.
    if (claimed.length === 0) {
      await issueCreditInvoice(purchase.id, undefined, paidAt);
      return false;
    }
  } catch (err) {
    console.error(
      "settlePurchase (status):",
      err instanceof Error ? err.message : err,
    );
    return false;
  }

  // Credits keyed on the payment id — a repeat call is a no-op (returns false).
  try {
    await withService((db) =>
      db.execute(
        sql`select add_ai_credits(p_store => ${purchase.store_id}, p_delta => ${purchase.credits}, p_kind => ${"purchase"}, p_ref => ${rzpPaymentId}, p_note => ${`pack ${purchase.pack_id}`})`,
      ),
    );
  } catch (err) {
    console.error(
      "settlePurchase (credits):",
      err instanceof Error ? err.message : err,
    );
  }

  // ★★ ISSUE THE DOCUMENT HERE, because this is the ONE place a purchase becomes
  // paid: the confirm path, the webhook and both reconcile passes all arrive
  // here. Hooking only the confirm would leave every purchase settled another
  // way without an invoice, which is exactly the case where the merchant is
  // already unsure what happened.
  //
  // ★ AFTER the credits, and best-effort: a merchant who paid gets what they
  // bought even if the document fails to issue. One that did not issue is
  // picked up by the hourly repair pass (`issueCapturedDrafts`).
  await issueCreditInvoice(purchase.id, undefined, paidAt);
  return true;
}

/**
 * Tell the merchant a pack they paid for has been added, when nobody was on
 * the page to see it happen. Best-effort; `recordEvent`, not `emitEvent`,
 * because a webhook or a scheduled run has no request left for `after()`.
 */
async function announceSettled(purchase: CreditPurchaseRow): Promise<void> {
  try {
    await recordEvent({
      type: "ai.credits_purchased",
      storeId: purchase.store_id,
      actor: { type: "system" },
      subject: { type: "credits", id: purchase.id, label: purchase.pack_id },
      payload: { credits: purchase.credits },
    });
  } catch (err) {
    logError("billing.credit_pack_announce", err, { purchaseId: purchase.id });
  }
}

/**
 * Settle one pending purchase from a captured payment the GATEWAY reported.
 *
 * ★★ NEVER FOR AN AMOUNT THAT DIFFERS (rule 3: no credits without a verified
 * payment). The order was created for an exact amount and partial payment is
 * never switched on, so a different figure cannot happen today; that is
 * exactly why it is refused and logged loudly rather than quietly granted.
 */
async function settleFromGateway(
  purchase: PendingPurchase,
  payment: { id: string; amount?: number | null; currency?: string | null },
  paidAt: Date | undefined,
  source: "webhook" | "scheduled" | "page",
): Promise<"settled" | "already" | "mismatch"> {
  const expected = creditPurchasePaise(purchase);
  if (
    (typeof payment.amount === "number" && payment.amount !== expected) ||
    (payment.currency && payment.currency !== "INR")
  ) {
    logError(
      "billing.credit_pack_amount_mismatch",
      new Error("a captured payment differs from the credit pack's amount"),
      {
        purchaseId: purchase.id,
        storeId: purchase.store_id,
        expectedPaise: expected,
        observedPaise: payment.amount ?? null,
        currency: payment.currency ?? null,
        paymentId: payment.id,
      },
    );
    return "mismatch";
  }
  const claimed = await settleCreditPurchase(purchase, payment.id, paidAt);
  if (!claimed) return "already";
  logInfo("billing.credit_pack_settled", {
    purchaseId: purchase.id,
    storeId: purchase.store_id,
    source,
  });
  await announceSettled(purchase);
  return "settled";
}

export interface CreditReconcileSummary {
  considered: number;
  settled: number;
  errors: number;
}

/**
 * Ask Razorpay about pending purchases and settle the ones that were paid.
 *
 * With a `storeId` it is the pass that runs when that store's Plans & Billing
 * page loads (its unfinished purchases of any age, ten at most). Without one
 * it is the SCHEDULED pass over every store: purchases between three minutes
 * and three days old, newest first.
 *
 * Captured means settle; nothing captured leaves the purchase pending (the
 * merchant may still be paying; there is no reaper for credit purchases, and
 * an old pending row is harmless). Never throws.
 */
export async function reconcilePendingCreditPurchases(
  input: { storeId?: string | null; now?: Date; limit?: number } = {},
): Promise<CreditReconcileSummary> {
  const summary: CreditReconcileSummary = {
    considered: 0,
    settled: 0,
    errors: 0,
  };
  const creds = getPlatformRazorpayCreds();
  if (!creds) return summary;

  const now = input.now ?? new Date();
  const storeId = input.storeId ?? null;
  const cutoff = new Date(
    now.getTime() - CREDIT_RECONCILE_AFTER_MS,
  ).toISOString();
  const since = new Date(
    now.getTime() - CREDIT_RECONCILE_WINDOW_MS,
  ).toISOString();

  let stale: PendingPurchase[];
  try {
    stale = await withService((db) =>
      db
        .select(pendingColumns)
        .from(aiCreditPurchases)
        .where(
          and(
            storeId ? eq(aiCreditPurchases.storeId, storeId) : undefined,
            eq(aiCreditPurchases.status, "pending"),
            lte(aiCreditPurchases.createdAt, cutoff),
            storeId ? undefined : gte(aiCreditPurchases.createdAt, since),
          ),
        )
        .orderBy(desc(aiCreditPurchases.createdAt))
        .limit(input.limit ?? (storeId ? 10 : CREDIT_RECONCILE_BATCH)),
    );
  } catch (err) {
    logError("billing.credit_pack_reconcile_scan", err, { storeId });
    summary.errors += 1;
    return summary;
  }

  for (const purchase of stale) {
    if (!purchase.rzp_order_id) continue;
    summary.considered += 1;
    try {
      const res = await rzpFetchOrderPayments(creds, purchase.rzp_order_id);
      // Unreachable is not a verdict: ask again on the next pass.
      if (!res.ok) continue;
      const captured = capturedPayment(res.data);
      if (!captured) continue;
      const outcome = await settleFromGateway(
        purchase,
        captured,
        // When Razorpay captured it; with none, the receipt is issued at the
        // time it is noticed, as before.
        gatewayCreatedAt(captured) ?? undefined,
        storeId ? "page" : "scheduled",
      );
      if (outcome === "settled") summary.settled += 1;
    } catch (err) {
      logError("billing.credit_pack_reconcile_one", err, {
        purchaseId: purchase.id,
      });
      summary.errors += 1;
    }
  }
  return summary;
}

export type CreditWebhookOutcome =
  /** The purchase was marked paid and its credits granted by this delivery. */
  | "settled"
  /** It was already paid (the browser's confirm, or an earlier delivery). */
  | "already"
  /** No pending credit purchase was made on that order. */
  | "unmatched"
  /** The amount or currency differs from the purchase's: nothing is granted. */
  | "mismatch"
  /**
   * A captured payment arrived on a purchase that was closed as FAILED:
   * nothing is granted, and it is logged as an error for a person to follow
   * up (see `settleCreditPurchaseByOrder`).
   */
  | "captured_on_failed"
  /** It could not be read; the reconcile passes settle it. */
  | "error";

/**
 * Settle the credit purchase a captured payment belongs to, from StoreMink's
 * own Razorpay webhook.
 *
 * The delivery's signature was verified by the route, so the payment is the
 * gateway's own word; the order id finds the purchase and the amount is
 * checked against what that order was created for. Never throws.
 */
export async function settleCreditPurchaseByOrder(input: {
  providerOrderId: string;
  providerPaymentId: string;
  amountPaise: number | null;
  currency: string | null;
  /** The payment's own time (`created_at`, seconds), when the event has it. */
  paidAtSeconds?: number | null;
}): Promise<CreditWebhookOutcome> {
  if (!input.providerOrderId || !input.providerPaymentId) return "unmatched";
  let row: (PendingPurchase & { status: string }) | undefined;
  try {
    const rows = await withService((db) =>
      db
        .select({ ...pendingColumns, status: aiCreditPurchases.status })
        .from(aiCreditPurchases)
        .where(eq(aiCreditPurchases.rzpOrderId, input.providerOrderId))
        .limit(1),
    );
    row = rows[0];
  } catch (err) {
    logError("billing.credit_pack_webhook_load", err, {
      providerOrderId: input.providerOrderId,
    });
    return "error";
  }
  if (!row) return "unmatched";
  // ★★ A CAPTURED PAYMENT ON A FAILED PURCHASE IS NEVER REPORTED AS "ALREADY"
  // (PR #303 review, 22 Nov 2026). A purchase is closed as failed in exactly
  // two places, both in `startCreditPurchase`: the Razorpay order could not
  // be created (no order id, so this lookup cannot find it), or its draft
  // invoice could not be written, in which case the payment window is never
  // returned to the browser and the order should stay unpaid. Closing the
  // window does NOT fail a purchase: it stays pending and is settled above.
  // So money on a failed purchase should be impossible; if it ever arrives
  // it is a paid order with no invoice behind it. Granting credits here would
  // break the rule that a payment has its tax invoice (GST design 5.5), and
  // saying "already" would bury it. It is logged as an error, with what a
  // person needs to refund it or issue the pack by hand.
  if (row.status === "failed") {
    logError(
      "billing.credit_pack_captured_on_failed",
      new Error("a captured payment arrived on a failed credit purchase"),
      {
        purchaseId: row.id,
        storeId: row.store_id,
        providerOrderId: input.providerOrderId,
        paymentId: input.providerPaymentId,
        amountPaise: input.amountPaise,
      },
    );
    return "captured_on_failed";
  }
  // Paid already: there is nothing for a delivery to change. It re-issues
  // its receipt inside the settle only on a real claim race, so it is simply
  // reported here.
  if (row.status !== "pending") return "already";

  try {
    return await settleFromGateway(
      row,
      {
        id: input.providerPaymentId,
        amount: input.amountPaise,
        currency: input.currency,
      },
      gatewayCreatedAt({ created_at: input.paidAtSeconds }) ?? undefined,
      "webhook",
    );
  } catch (err) {
    logError("billing.credit_pack_webhook_settle", err, {
      purchaseId: row.id,
    });
    return "error";
  }
}
