import "server-only";

/**
 * Invoicing an AI credit purchase (§16 × §34).
 *
 * ★★ CREDITS GET THEIR OWN INVOICE, NEVER A LINE ON A SUBSCRIPTION ONE (spec §1,
 * §14). They are a one-off purchase at an arbitrary moment; a subscription
 * invoice covers a period and is idempotent on its cycle. `kind = 'ai_credits'`
 * carries no `cycle_seq`, which is what keeps it outside
 * `billing_invoices_one_per_cycle` and lets a merchant buy twice in a month.
 *
 * ★ THE SAME OFFER/OBLIGATION RULE AS ENROLMENT: a DRAFT at purchase time,
 * FINALIZED when the money lands. A merchant who opens the Razorpay window and
 * closes it must not burn a number in the gapless GST series for a document
 * nobody received.
 *
 * ★ EVERY FUNCTION HERE returns rather than throws. Credits are granted by
 * `add_ai_credits`, and that must not fail because an invoice could not be
 * issued: a merchant who paid gets their credits, and an invoice that did not
 * issue is picked up by the repair pass (`issueCapturedDrafts`).
 *
 * ★★ BUT THE DRAFT IS NO LONGER OPTIONAL (GST, design 5.5). Once StoreMink
 * charges GST the document is a tax invoice, so `startCreditPurchase` refuses
 * the purchase when `draftCreditInvoice` returns null, before any payment
 * window opens. The draft is built by the caller from ONE tax reading, the
 * same one that priced the Razorpay order, so the invoice and the charge
 * cannot disagree.
 */

import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { aiCreditPurchases } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import type { BuiltInvoice } from "./invoice";
import {
  createAiCreditsInvoice,
  finalizePaidAiCreditsInvoice,
} from "./invoice-store";
import type { InvoiceTaxStamp } from "./tax-snapshot";

/**
 * Raise the draft invoice for a purchase and link it.
 *
 * `built` and `stamp` come from the caller's one tax reading
 * (`loadTaxSnapshot`), the reading the Razorpay order was priced from.
 *
 * Returns the invoice id, or null when anything went wrong. The caller refuses
 * the purchase on null (fail closed): no payment window opens without its
 * invoice.
 */
export async function draftCreditInvoice(input: {
  storeId: string;
  purchaseId: string;
  built: BuiltInvoice;
  stamp: InvoiceTaxStamp;
}): Promise<string | null> {
  try {
    const invoice = await createAiCreditsInvoice({
      storeId: input.storeId,
      built: input.built,
      stamp: input.stamp,
    });
    if (!invoice) return null;

    // ★ Linked on the PURCHASE. The unique index makes a retry a no-op rather
    // than a corruption.
    //
    // ⚠ A link that fails returns null, so the caller refuses the purchase,
    // and the draft just written stays an orphan: harmless (a draft carries no
    // number, the history filters it out, and no payment can ever land on
    // it), but untidy.
    await withService(async (db) => {
      await db
        .update(aiCreditPurchases)
        .set({ invoiceId: invoice.id })
        .where(eq(aiCreditPurchases.id, input.purchaseId));
    });
    return invoice.id;
  } catch (err) {
    logError("billing.draft_credit_invoice", err, {
      purchaseId: input.purchaseId,
    });
    return null;
  }
}

/**
 * Issue the document, now that the purchase is paid.
 *
 * ★ Called from `settlePurchase`, which is the ONE place a credit purchase
 * becomes paid — the confirm path AND the reconcile-on-read sweep both go
 * through it. Hooking only the confirm path would leave every purchase settled
 * by reconciliation without a document, which is precisely the case where the
 * merchant is already unsure what happened.
 *
 * ★ `finalizePaidAiCreditsInvoice` issues and marks the document paid in the
 * same idempotent transition. The checkout already captured this one-time
 * purchase; exposing it as an open subscription debt would invite a second
 * charge.
 *
 * `paidAt` is when the payment was captured, when the caller knows it: the
 * read-time reconcile passes the payment's own `created_at`, so a pack paid
 * before GST started but noticed on a later visit is issued with the terms of
 * its payment time. The on-session confirm passes nothing (seconds old).
 */
export async function issueCreditInvoice(
  purchaseId: string,
  now: Date = new Date(),
  paidAt?: Date,
): Promise<void> {
  try {
    const invoiceId = await withService(async (db) => {
      const [row] = await db
        .select({ invoiceId: aiCreditPurchases.invoiceId })
        .from(aiCreditPurchases)
        .where(eq(aiCreditPurchases.id, purchaseId))
        .limit(1);
      return row?.invoiceId ?? null;
    });
    // ⚠ Purchases made BEFORE this existed have no draft to finalize. They stay
    // without a document rather than getting one back-dated into the current
    // financial year's series — a number issued today for a sale months ago is
    // worse than no number.
    if (!invoiceId) return;

    await finalizePaidAiCreditsInvoice(invoiceId, now, paidAt);
  } catch (err) {
    logError("billing.issue_credit_invoice", err, { purchaseId });
  }
}
