"use server";

// AI-credit purchases + the AI-usage page's data. Credits revenue is
// STOREMINK's, so purchases run on the PLATFORM's Razorpay account (env
// RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) — a store does NOT need its own
// Channels gateway to buy credits.
//
// Lifecycle: startCreditPurchase (pending row + platform Razorpay order) →
// client pays in the Razorpay modal → confirmCreditPurchase (HMAC verify →
// paid → add_ai_credits). The add_ai_credits RPC is idempotent per payment id
// (unique partial index), so double-confirmation / reconcile races can never
// double-credit. Dropped callbacks are reconciled on AI-page load (the same
// reconcile-on-read pattern as order payments — no webhook in v1).

import { and, desc, eq, lte, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { emitEvent } from "@/lib/notifications/record";
import { loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import {
  draftCreditInvoice,
  issueCreditInvoice,
} from "@/lib/billing/credit-invoice";
import { buildAiCreditsInvoice } from "@/lib/billing/invoice";
import {
  gatewayCreatedAt,
  paymentCapturedAt,
  readTaxForPayment,
} from "@/lib/billing/payment-tax";
import { PAYMENT_REFUSAL } from "@/lib/billing/tax-copy";
import { aiCreditLedger, aiCreditPurchases, stores } from "@/drizzle/schema";
import {
  getManagerUserId,
  getActingStoreId,
  getViewerAccess,
} from "@/app/dashboard/lib/access";
import { effectivePlan, NO_COMP } from "@/lib/plans";
import {
  getMinkCreditPackLive,
  getMinkCreditPacksLive,
} from "@/lib/ai/credit-pricing";
import { getAiUsage, type AiUsageSummary } from "@/lib/ai/quota";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  capturedPayment,
  rzpCreateOrder,
  rzpFetchOrderPayments,
  verifyCapturedCheckoutPayment,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";

// A purchase left `pending` this long is presumed dropped and gets reconciled
// against Razorpay on the next AI-page load.
const RECONCILE_AFTER_MS = 3 * 60_000;

export interface AiLedgerEntry {
  id: string;
  delta: number;
  kind: "purchase" | "grant" | "spend";
  note: string | null;
  created_at: string;
}

export interface AiUsagePageData {
  usage: AiUsageSummary;
  /** The store's EFFECTIVE plan (an expired timed plan resolves to free). */
  plan: string;
  /** ISO expiry of a timed plan (null = indefinite). */
  planExpiresAt: string | null;
  /** How the plan was granted: comp / paid / trial (or null). */
  planSource: string | null;
  /**
   * A comped plan the operator has offered but the merchant has NOT accepted.
   * Null once accepted — the window is what makes it `compActive` instead.
   */
  compOffer: { plan: string; durationDays: number } | null;
  /** A comped plan currently running (docs/comped-plans-spec.md). */
  compActive: { plan: string; expiresAt: string } | null;
  /**
   * The plan UNDERNEATH any comp — what they pay for and fall back to.
   *
   * ★ `plan` above is the EFFECTIVE plan, which during a comp IS the comped
   * one. The offer copy promises "your Basic plan continues", so it needs the
   * paid entitlement specifically; deriving it in the component would mean a
   * second copy of the resolution rule.
   */
  paidPlan: string;
  /** Whether this store's plan may buy credits (basic+). */
  canBuyCredits: boolean;
  /** Whether the platform's payment account is configured at all. */
  purchasesAvailable: boolean;
  ledger: AiLedgerEntry[];
}

// Mark a paid purchase + grant its credits, idempotently. Shared by the
// client confirm path and the reconcile pass.
//
// `paidAt` is when Razorpay captured the payment, when the caller knows it:
// the reconcile pass and the confirm path both pass the payment's own
// `created_at`, so a pack paid before a scheduled GST change but confirmed or
// noticed after it is issued with the terms of its payment time (GST design
// 5.4 step 4, R1-07). Absent, the invoice reads its terms at issue.
async function settlePurchase(
  purchase: { id: string; store_id: string; credits: number; pack_id: string },
  rzpPaymentId: string,
  paidAt?: Date,
): Promise<void> {
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
      return;
    }
  } catch (err) {
    console.error(
      "settlePurchase (status):",
      err instanceof Error ? err.message : err,
    );
    return;
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
  // paid — the confirm path AND the reconcile-on-read sweep both arrive here.
  // Hooking only `confirmCreditPurchase` would leave every purchase settled by
  // reconciliation without an invoice, which is exactly the case where the
  // merchant is already unsure what happened.
  //
  // ★ AFTER the credits, and best-effort: a merchant who paid gets what they
  // bought even if the document fails to issue. One that did not issue is
  // picked up by the hourly repair pass (`issueCapturedDrafts`).
  await issueCreditInvoice(purchase.id, undefined, paidAt);
}

// Reconcile-on-read: any stale pending purchase for this store is checked
// against Razorpay; captured ⇒ settle, nothing captured ⇒ leave pending (the
// shopper may still be mid-payment — there is no reaper for credit purchases,
// an old pending row is harmless).
async function reconcilePendingPurchases(storeId: string): Promise<void> {
  const creds = getPlatformRazorpayCreds();
  if (!creds) return;
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MS).toISOString();
  let stale: {
    id: string;
    store_id: string;
    credits: number;
    pack_id: string;
    rzp_order_id: string | null;
  }[];
  try {
    stale = await withService((db) =>
      db
        .select({
          id: aiCreditPurchases.id,
          store_id: aiCreditPurchases.storeId,
          credits: aiCreditPurchases.credits,
          pack_id: aiCreditPurchases.packId,
          rzp_order_id: aiCreditPurchases.rzpOrderId,
        })
        .from(aiCreditPurchases)
        .where(
          and(
            eq(aiCreditPurchases.storeId, storeId),
            eq(aiCreditPurchases.status, "pending"),
            lte(aiCreditPurchases.createdAt, cutoff),
          ),
        )
        .limit(10),
    );
  } catch (err) {
    console.error("reconcilePendingPurchases:", err);
    return;
  }
  for (const p of stale) {
    if (!p.rzp_order_id) continue;
    const res = await rzpFetchOrderPayments(creds, p.rzp_order_id);
    if (!res.ok) continue;
    const captured = capturedPayment(res.data);
    if (captured) {
      // When Razorpay captured it (`created_at`, `gatewayCreatedAt`); with
      // none, the invoice is issued at the time it is noticed, as before.
      await settlePurchase(
        p,
        captured.id,
        gatewayCreatedAt(captured) ?? undefined,
      );
    }
  }
}

/** Everything the /dashboard/plans (Plans & Billing) page renders. Also runs
 *  the pending-purchase reconcile pass so a dropped payment callback self-heals
 *  on next visit.
 *
 *  ★★ GATED HERE, NOT ONLY ON THE PAGE (R3-02). An export of a "use server"
 *  file is a public endpoint, and this one returns the plan, the comp and the
 *  credit ledger, and asks Razorpay about pending purchases. VIEW of the `ai`
 *  section, the page's own gate (`requireSectionAccess("ai", "view")`), so a
 *  view-only role keeps the page; `getViewerContext` is request-cached, so
 *  this costs nothing after the page's check. */
export async function getAiUsagePageData(): Promise<AiUsagePageData> {
  const access = await getViewerAccess();
  if (!access?.can("ai", "view")) throw new Error("Not allowed");

  const storeId = await getActingStoreId();

  await reconcilePendingPurchases(storeId);

  const [dbResult, usage] = await Promise.all([
    // ★ The two reads run ONE AFTER THE OTHER (R3-01): a `withService` scope
    // holds one pooled client in one transaction, so starting both together
    // only queued the second inside pg (a deprecation warning today, a throw
    // on pg 9) and let one failed read abort the other.
    withService(async (db) => {
      const storeRows = await db
        .select({
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
          comp_plan: stores.compPlan,
          comp_expires_at: stores.compExpiresAt,
          comp_duration_days: stores.compDurationDays,
          comp_starts_at: stores.compStartsAt,
          plan_source: stores.planSource,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      const ledgerRows = await db
        .select({
          id: aiCreditLedger.id,
          delta: aiCreditLedger.delta,
          kind: aiCreditLedger.kind,
          note: aiCreditLedger.note,
          created_at: aiCreditLedger.createdAt,
        })
        .from(aiCreditLedger)
        .where(eq(aiCreditLedger.storeId, storeId))
        .orderBy(desc(aiCreditLedger.createdAt))
        .limit(20);
      return { storeRows, ledgerRows };
    }).catch((err) => {
      logError("billing.ai_usage_page", loggableError(err), { storeId });
      return { storeRows: [], ledgerRows: [] };
    }),
    // Its own scope, so a separate client: these two do run together.
    getAiUsage(storeId),
  ]);
  const store = dbResult.storeRows[0];
  const ledger = dbResult.ledgerRows as AiLedgerEntry[];

  const plan = effectivePlan(store ?? {});
  // The same resolver with the overlay switched off — never a separate rule.
  const paidPlan = effectivePlan({ ...(store ?? {}), ...NO_COMP });
  return {
    usage,
    plan,
    paidPlan,
    planExpiresAt: store?.plan_expires_at ?? null,
    planSource: store?.plan_source ?? null,
    // ★ An offer and a running comp are mutually exclusive by construction:
    // accepting is the write that fills the window, and `offerCompPlan` refuses
    // while one is open. Splitting them here keeps that out of the component.
    compOffer:
      store?.comp_plan && store.comp_duration_days && !store.comp_starts_at
        ? { plan: store.comp_plan, durationDays: store.comp_duration_days }
        : null,
    compActive:
      store?.comp_plan && store.comp_starts_at && store.comp_expires_at
        ? { plan: store.comp_plan, expiresAt: store.comp_expires_at }
        : null,
    canBuyCredits: true,
    purchasesAvailable: getPlatformRazorpayCreds() !== null,
    ledger,
  };
}

export type StartPurchaseResult =
  | {
      success: true;
      purchaseId: string;
      rzpOrderId: string;
      keyId: string;
      amountPaise: number;
      packName: string;
    }
  | { error: string };

export async function startCreditPurchase(
  packId: string,
): Promise<StartPurchaseResult> {
  const userId = await getManagerUserId("ai");
  if (!userId) return { error: "You don't have permission to do this." };

  // Live, uncached: the number inserted into the purchase and sent to Razorpay
  // must be the same operator-controlled price the merchant just saw.
  const pack = await getMinkCreditPackLive(packId);
  if (!pack) return { error: "Unknown credit pack." };

  const storeId = await getActingStoreId();

  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return { error: "Credit purchases aren't available right now." };
  }

  // ★★ ONE TAX READING PRICES THE ORDER AND WRITES THE INVOICE (GST design
  // 5.5). Read before anything is written, so a refusal leaves no purchase
  // row and no Razorpay order behind.
  const reading = await readTaxForPayment(
    storeId,
    new Date(),
    "billing.credit_pack",
  );
  if (!reading.ok) return { error: reading.error };
  const built = buildAiCreditsInvoice({
    packLabel: pack.name,
    credits: pack.credits,
    amountPaise: pack.priceInr * 100,
    tax: reading.snap.tax,
  });
  // What the merchant is charged: the list price, plus GST when the price
  // excludes it (a Rs 59 pack is charged Rs 69.62 at 18% exclusive).
  const amountPaise = built.totalPaise;

  let purchaseId: string;
  try {
    const [inserted] = await withService((db) =>
      db
        .insert(aiCreditPurchases)
        .values({
          storeId,
          packId: pack.id,
          credits: pack.credits,
          // The list price, unchanged in meaning; `amountPaise` is the charge.
          amountInr: pack.priceInr,
          amountPaise,
          status: "pending",
        })
        .returning({ id: aiCreditPurchases.id }),
    );
    purchaseId = inserted.id;
  } catch (err) {
    console.error(
      "startCreditPurchase (insert):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Couldn't start the purchase. Please try again." };
  }

  const rzpRes = await rzpCreateOrder(creds, {
    amountPaise,
    receipt: `aicr_${purchaseId.slice(0, 30)}`,
    notes: { store_id: storeId, purchase_id: purchaseId },
  });
  if (!rzpRes.ok) {
    console.error("startCreditPurchase (rzp):", rzpRes.error);
    await withService((db) =>
      db
        .update(aiCreditPurchases)
        .set({ status: "failed", updatedAt: new Date().toISOString() })
        .where(eq(aiCreditPurchases.id, purchaseId)),
    ).catch(() => {});
    return { error: "Couldn't start the payment. Please try again." };
  }

  try {
    await withService((db) =>
      db
        .update(aiCreditPurchases)
        .set({
          rzpOrderId: rzpRes.data.id,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(aiCreditPurchases.id, purchaseId)),
    );
  } catch (err) {
    console.error(
      "startCreditPurchase (pin):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Couldn't start the payment. Please try again." };
  }

  // ★ A DRAFT invoice, raised only once the order exists, so a purchase that
  // died at the gateway leaves no document behind at all. It carries no number
  // yet; `settlePurchase` finalizes it when the money lands, which is what keeps
  // an abandoned checkout from burning one in the gapless GST series.
  //
  // ★★ FAIL CLOSED (GST design 5.5): once the document can be a tax invoice, a
  // payment without one is not acceptable. The order stays unused at Razorpay;
  // nobody opens it, because the payment window is never returned.
  const invoiceId = await draftCreditInvoice({
    storeId,
    purchaseId,
    built,
    stamp: reading.snap.stamp,
  });
  if (!invoiceId) {
    await withService((db) =>
      db
        .update(aiCreditPurchases)
        .set({ status: "failed", updatedAt: new Date().toISOString() })
        .where(eq(aiCreditPurchases.id, purchaseId)),
    ).catch(() => {});
    return { error: PAYMENT_REFUSAL.invoiceFailed };
  }

  return {
    success: true,
    purchaseId,
    rzpOrderId: rzpRes.data.id,
    keyId: creds.keyId,
    amountPaise,
    packName: pack.name,
  };
}

export interface ConfirmPurchaseResult {
  success?: boolean;
  creditsAdded?: number;
  error?: string;
}

export async function confirmCreditPurchase(
  purchaseId: string,
  rzpPaymentId: string,
  rzpSignature: string,
): Promise<ConfirmPurchaseResult> {
  const userId = await getManagerUserId("ai");
  if (!userId) return { error: "You don't have permission to do this." };
  if (
    typeof purchaseId !== "string" ||
    !purchaseId ||
    typeof rzpPaymentId !== "string" ||
    !rzpPaymentId ||
    typeof rzpSignature !== "string" ||
    !rzpSignature
  ) {
    return { error: "Invalid payment confirmation." };
  }

  const storeId = await getActingStoreId();

  const purchaseRows = await withService((db) =>
    db
      .select({
        id: aiCreditPurchases.id,
        store_id: aiCreditPurchases.storeId,
        credits: aiCreditPurchases.credits,
        pack_id: aiCreditPurchases.packId,
        amount_inr: aiCreditPurchases.amountInr,
        amount_paise: aiCreditPurchases.amountPaise,
        status: aiCreditPurchases.status,
        rzp_order_id: aiCreditPurchases.rzpOrderId,
      })
      .from(aiCreditPurchases)
      .where(
        and(
          eq(aiCreditPurchases.id, purchaseId),
          eq(aiCreditPurchases.storeId, storeId),
        ),
      )
      .limit(1),
  ).catch(() => []);
  const purchase = purchaseRows[0];
  if (!purchase) return { error: "Purchase not found." };
  if (purchase.status === "paid") {
    // A dropped response can make the browser repeat confirmation after the
    // purchase committed. Re-issue idempotently so a transient document write
    // self-heals; the credits ledger itself remains untouched.
    await issueCreditInvoice(purchase.id);
    return { success: true, creditsAdded: purchase.credits };
  }
  if (purchase.status !== "pending" || !purchase.rzp_order_id) {
    return { error: "This purchase can no longer be completed." };
  }

  const creds = getPlatformRazorpayCreds();
  if (!creds) return { error: "Payment verification is unavailable." };

  const valid = verifyCheckoutSignature(
    creds.keySecret,
    purchase.rzp_order_id,
    rzpPaymentId,
    rzpSignature,
  );
  if (!valid) {
    console.error("confirmCreditPurchase: bad signature for", purchaseId);
    return { error: "Payment verification failed." };
  }

  // ★ What the order was created for: `amount_paise` (GST included when the
  // price excludes it). A purchase started before the column existed has
  // none, and its order was for the list price.
  const observedPayment = await verifyCapturedCheckoutPayment(creds, {
    paymentId: rzpPaymentId,
    orderId: purchase.rzp_order_id,
    amountPaise: purchase.amount_paise ?? purchase.amount_inr * 100,
  });
  if (!observedPayment.ok) {
    console.error(
      "confirmCreditPurchase: gateway mismatch for",
      purchaseId,
      observedPayment.error,
    );
    return { error: observedPayment.error };
  }

  // ★ The receipt's time of supply is the payment's, not the confirm's
  // (R1-07). Best-effort: a time that cannot be read leaves it at issue.
  const paidAt = observedPayment.gatewayRead
    ? await paymentCapturedAt(creds, rzpPaymentId, "billing.credit_pack")
    : undefined;

  await settlePurchase(
    {
      id: purchase.id,
      store_id: purchase.store_id,
      credits: purchase.credits,
      pack_id: purchase.pack_id,
    },
    rzpPaymentId,
    paidAt,
  );
  emitEvent({
    type: "ai.credits_purchased",
    storeId: purchase.store_id,
    actor: { type: "admin", id: userId },
    subject: { type: "credits", id: purchase.id, label: purchase.pack_id },
    payload: { credits: purchase.credits },
  });

  return { success: true, creditsAdded: purchase.credits };
}

/** The pack catalog for the buy panel (server → client serializable). */
export async function getCreditPacks() {
  return getMinkCreditPacksLive();
}
