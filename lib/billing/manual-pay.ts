import "server-only";

/**
 * Manual payment — paying an open invoice on session.
 *
 * Design: docs/billing-architecture.md §7. Spec §18: manual payment is a
 * FIRST-CLASS path, not a fallback bolted on. It is how an invoice is settled
 * whenever automatic collection cannot or must not run.
 *
 * It is needed in five situations the spec names, and one it does not:
 *   • no mandate, or a revoked or expired one
 *   • the amount is over the ₹15,000 AFA-exempt limit (every yearly plan)
 *   • automatic collection failed and the merchant wants to fix it now
 *   • during the 48-hour grace window
 *   • ★ while automatic collection is unavailable during an incident
 *
 * ★★ PAYING DURING GRACE RESTORES THE PLAN IMMEDIATELY. Settling the invoice and
 * leaving the cycle to the hourly worker would keep a merchant who has just paid
 * locked out of their own POS for up to an hour, at the moment they are watching
 * the screen. So the advance runs here too — through the SAME function the worker
 * uses, never a second copy of the rule.
 *
 * ★★ A CYCLE THE STORE WILL NEVER ENTER IS NOT PAYABLE (renewal-cancel, design
 * 6.5). While a cancellation stands, the next cycle's invoice cannot be paid:
 * the plan ends at the cycle end and the payment would only have to be refunded.
 * An invoice above an ended plan's last cycle, or below a live plan's current
 * one, is refused for the same reason. `cycleRefusal` is the rule for one
 * invoice; `listPayableInvoices` applies the same three conditions in SQL.
 */

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  billingInvoices,
  billingPaymentAttempts,
  billingSubscriptions,
} from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  rzpCreateOrder,
  rzpFetchOrder,
  verifyCapturedCheckoutPayment,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";
import {
  beginAttempt,
  capturedAttemptForInvoice,
  fileClosedAttemptPayment,
  hasUnknownAttempt,
  recordGatewayOrder,
  settleAttempt,
  withdrawUnsentDebits,
} from "./collect";
import { earlierDebitsOf } from "./earlier-debits";
import type { PayableInvoice } from "./invoice-types";
import { orderIsUntouched } from "./order-state";
import {
  amountDueForInvoice,
  finalizeInvoice,
  getInvoice,
} from "./invoice-store";
import { advanceAfterPayment } from "./renewal-worker";

export interface PaymentStart {
  invoiceId: string;
  providerOrderId: string;
  keyId: string;
  amountPaise: number;
  invoiceRef: string | null;
}

export type PayResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Invoice states a merchant may still pay.
 *
 * ★ NOT A DRAFT (R1-06). A draft is an offer, not a debt: enrolment, a plan
 * change and a location purchase each take their payment through their own
 * start, which reads the tax and refuses what GST forbids (no state on record,
 * a business outside India) before anything is written. This action is a
 * public server action, so accepting a draft here let a crafted call issue
 * and charge an enrolment draft past those refusals, and without activating
 * the plan. The screen never offered one (`listPayableInvoices` lists open and
 * processing only), so nothing a merchant can see changes.
 */
const PAYABLE = ["open"] as const;

/** Subscription states that still have a current cycle. */
const LIVE_STATES = ["active", "past_due", "grace"];
/** Subscription states whose plan has ended. */
const ENDED_STATES = ["cancelled", "downgraded"];

/** Refused: the next cycle's invoice while a cancellation stands (design 8.4). */
export const CANCELLING_INVOICE_MESSAGE =
  "You've cancelled your plan, so this invoice won't be charged. To keep your plan, choose Keep my plan first.";

/** Refused: a closed invoice, or one for a cycle the store will never enter. */
export const CLOSED_INVOICE_MESSAGE =
  "That invoice is closed and can't be paid. Subscribe again to start a new cycle.";

/** A payment that settled after the plan ended and its invoice closed. */
export const CLOSED_ON_ARRIVAL_MESSAGE =
  "Your plan ended before this payment arrived, so we're refunding it to the account you paid from, usually within 5 working days.";

/**
 * A payment made on a checkout that had already been closed (the amount due
 * changed, and a newer checkout replaced it). It is not applied; a person
 * settles it.
 */
export const PAID_ON_CLOSED_CHECKOUT_MESSAGE =
  "This payment was made on an earlier checkout that was replaced when the amount due changed, so it has not been applied to this invoice. Our team has been told and will refund it. To settle the invoice, pay the amount now due. Questions: support@storemink.com.";

/**
 * Refused: a payment for this invoice is already captured (RC-F1b). Never a
 * second order: the earlier payment is recorded and finished by the hourly
 * check, or by a person.
 */
export const ALREADY_CAPTURED_INVOICE_MESSAGE =
  "A payment for this invoice has already gone through, so please don't pay it again. It will show as paid shortly. If it still shows as unpaid after a day, write to support@storemink.com.";

/**
 * An earlier payment for this invoice has no known result yet (an automatic
 * debit whose answer never arrived). Paying again now could pay it twice.
 */
export const PAYMENT_BEING_CONFIRMED_MESSAGE =
  "We're still confirming an earlier payment for this invoice with the bank, so it can't be paid again just yet. Your plan stays active meanwhile. Please check back in a few hours.";

/**
 * Refused: a payment on this invoice is under way and is not one this press
 * may reopen or replace (an automatic debit already sent to the bank, or a
 * checkout payment waiting for approval in the payer's app).
 */
export const PAYMENT_IN_PROGRESS_MESSAGE =
  "A payment is already being processed. Give it a moment.";

/** Refused: an invoice with no issue date after the finalize step. */
export const UNISSUED_INVOICE_MESSAGE =
  "That invoice hasn't been issued, so it can't be paid. Please try again, or write to support@storemink.com if this keeps happening.";

/** The subscription facts that decide whether an invoice's cycle is payable. */
export interface SubscriptionCycleFacts {
  state: string;
  currentCycleSeq: number;
  cancelAtPeriodEnd: boolean;
}

/**
 * Why an invoice's cycle cannot be paid, or null when it can.
 *
 * - `cancelling`: the next cycle's invoice while a cancellation stands. Keep my
 *   plan clears the flag, and the invoice is payable again.
 * - `unreachable`: an issued invoice above an ended plan's last cycle, or below
 *   a live plan's current cycle. The store will never enter that cycle.
 *
 * ★ `listPayableInvoices` applies the same three conditions in SQL; a change
 * here belongs there too.
 */
export function cycleRefusal(
  sub: SubscriptionCycleFacts | null,
  invoice: { cycleSeq: number | null; issued: boolean },
): "cancelling" | "unreachable" | null {
  if (!sub || invoice.cycleSeq === null) return null;
  const seq = invoice.cycleSeq;
  if (sub.cancelAtPeriodEnd && seq === sub.currentCycleSeq + 1) {
    return "cancelling";
  }
  if (!invoice.issued) return null;
  if (ENDED_STATES.includes(sub.state) && seq > sub.currentCycleSeq) {
    return "unreachable";
  }
  if (LIVE_STATES.includes(sub.state) && seq < sub.currentCycleSeq) {
    return "unreachable";
  }
  return null;
}

/**
 * Open a payment for an invoice the merchant already owes.
 *
 * ★ SCOPED BY STORE as well as invoice id. An invoice id alone must never let
 * one merchant pay — or even see the amount of — another's bill.
 */
export async function startInvoicePayment(input: {
  storeId: string;
  invoiceId: string;
  /**
   * "Pay now instead": the merchant chose to pay an invoice whose automatic
   * debit is SCHEDULED (its bank notice out, its debit not yet sent). The
   * scheduled debit is withdrawn first, by the same guarded write a
   * cancellation uses, so the two can never both be taken. Without this flag
   * a scheduled debit is left exactly as it is and the start is refused.
   */
  insteadOfAutopay?: boolean;
  now?: Date;
}): Promise<PayResult<PaymentStart>> {
  const now = input.now ?? new Date();
  const creds = getPlatformRazorpayCreds();
  if (!creds)
    return { ok: false, error: "Payments aren't available right now." };

  const invoice = await getInvoice(input.invoiceId);
  if (!invoice || invoice.storeId !== input.storeId) {
    return { ok: false, error: "We couldn't find that invoice." };
  }

  // ★★ AI credits were paid in their own one-time Razorpay checkout. They have
  // an invoice for accounting, not an outstanding obligation. Even if a future
  // UI/query regression displays one here, never create another order for it.
  if (invoice.kind !== "subscription") {
    return {
      ok: false,
      error: "That one-time purchase is already settled.",
    };
  }

  if (invoice.status === "paid") {
    return { ok: false, error: "That invoice is already paid." };
  }
  // ★ `uncollectible` and `void` are DECISIONS, not states to pay out of. An
  // uncollectible invoice belongs to a cycle the merchant was already downgraded
  // for; taking money for it would charge them for a service period they never
  // received (§7). They re-subscribe instead. ("Closed", not "closed unpaid":
  // a void invoice may have been paid and refunded.)
  if (invoice.status === "uncollectible" || invoice.status === "void") {
    return { ok: false, error: CLOSED_INVOICE_MESSAGE };
  }

  // ★★ DEFENCE IN DEPTH (RC-F1b): AN INVOICE WITH A CAPTURED ATTEMPT IS NEVER
  // OFFERED A SECOND PAYMENT. Finding F1's fix already makes such an invoice
  // paid when the capture is seen again, but an open invoice an older confirm
  // left behind captured money, or a draft whose purchase the merchant closed
  // the tab on, must not open a second order here. An open or processing one
  // is re-synced first, so the merchant sees it paid; a draft is never
  // finalized here, because the hourly check finishes that purchase. A failed
  // read refuses: "we could not check" is not "nothing was paid".
  const captured = await capturedAttemptForInvoice(invoice.id, input.storeId);
  if (captured === undefined) {
    return {
      ok: false,
      error:
        "We couldn't check this invoice's payments just now. Please try again.",
    };
  }
  if (captured) {
    if (invoice.status === "open" || invoice.status === "processing") {
      await settleAttempt(captured.id, "captured", { now });
      const after = await getInvoice(invoice.id);
      if (after?.status === "paid") {
        return { ok: false, error: "That invoice is already paid." };
      }
    }
    logWarn("billing.manual_pay_captured_attempt", {
      storeId: input.storeId,
      invoiceId: invoice.id,
      attemptId: captured.id,
      invoiceStatus: invoice.status,
    });
    return { ok: false, error: ALREADY_CAPTURED_INVOICE_MESSAGE };
  }

  // ★★ NOR ONE WHOSE EARLIER AUTOMATIC DEBIT TOOK THE MONEY AFTER ALL (PR
  // #303 review, 22 Nov 2026; lib/billing/earlier-debits.ts). A renewal debit
  // Razorpay reported failed can be authorised late by the bank and
  // captured. That payment sits on a closed attempt, so the check above does
  // not see it, and the invoice still reads open: paying it by hand would be
  // a second payment for one renewal. Read only when a debit was sent for
  // this invoice before, so an ordinary Pay now costs no extra call.
  const earlier = await earlierDebitsOf({
    invoiceId: invoice.id,
    storeId: input.storeId,
    source: "manual",
    now,
  });
  if (earlier === "paid") {
    return { ok: false, error: ALREADY_CAPTURED_INVOICE_MESSAGE };
  }
  if (earlier === "unsettled") {
    return { ok: false, error: PAYMENT_BEING_CONFIRMED_MESSAGE };
  }
  if (earlier === "unknown") {
    return {
      ok: false,
      error:
        "We couldn't check this invoice's payments just now. Please try again.",
    };
  }

  // ★★ A `processing` INVOICE IS NOT ALWAYS A PAYMENT THAT IS MOVING
  // (22 Nov 2026). It also covers two states the merchant can act on, both
  // decided further down, after every refusal that applies to any invoice:
  //   • an automatic debit that is only SCHEDULED, which "Pay now instead"
  //     may replace;
  //   • a checkout this merchant opened and closed without paying, which is
  //     reopened on the SAME gateway order. Before this it was a dead end:
  //     the invoice read "Payment in progress" for 72 hours.
  const inFlight = invoice.status === "processing";
  if (
    !inFlight &&
    !PAYABLE.includes(invoice.status as (typeof PAYABLE)[number])
  ) {
    return { ok: false, error: "That invoice can't be paid." };
  }

  // ★★ A CYCLE THE STORE WILL NEVER ENTER IS NOT PAYABLE (design 6.5). Read
  // before finalize, so a refused draft never takes a number in the gapless
  // series. ★ An unreadable subscription refuses: no money has moved, while
  // taking it for a cycle the store will not enter would have to be refunded.
  let sub: SubscriptionCycleFacts | null;
  try {
    sub = await withService(async (db) => {
      const [row] = await db
        .select({
          state: billingSubscriptions.state,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, input.storeId))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.manual_pay_subscription_read", err, {
      storeId: input.storeId,
      invoiceId: invoice.id,
    });
    return {
      ok: false,
      error: "We couldn't check your plan just now. Please try again.",
    };
  }
  const refusal = cycleRefusal(sub, {
    cycleSeq: invoice.cycleSeq,
    issued: !!invoice.finalizedAt,
  });
  if (refusal === "cancelling") {
    return { ok: false, error: CANCELLING_INVOICE_MESSAGE };
  }
  if (refusal === "unreachable") {
    return { ok: false, error: CLOSED_INVOICE_MESSAGE };
  }

  // An invoice must be issued before it is paid — the merchant is paying against
  // a document number.
  let issued = invoice;
  if (!invoice.finalizedAt) {
    const finalized = await finalizeInvoice(invoice.id, now);
    if (!finalized) return { ok: false, error: "Couldn't issue that invoice." };
    issued = finalized;
  }
  // ★★ AND IT MUST HAVE BEEN ISSUED. Finalize claims only a draft, so an
  // invoice that is not a draft but carries no `finalized_at` comes back
  // unnumbered (no code writes that state; a hand edit could). Taking money
  // against it would be a payment with no document behind it.
  if (!issued.finalizedAt) {
    logError(
      "billing.manual_pay_unissued_invoice",
      new Error("invoice has no finalized_at after the finalize step"),
      { storeId: input.storeId, invoiceId: invoice.id, status: issued.status },
    );
    return { ok: false, error: UNISSUED_INVOICE_MESSAGE };
  }

  const amountDue = await amountDueForInvoice(invoice.id);
  // Never guess (Rule 10). A null here means we could not read applied credit,
  // and quoting the full total might double-charge.
  if (amountDue === null) {
    return {
      ok: false,
      error: "Couldn't work out what's due. Please try again.",
    };
  }
  if (amountDue <= 0) {
    return { ok: false, error: "Nothing is due on that invoice." };
  }

  // ★★ NEVER PAY OVER A PAYMENT WHOSE RESULT IS NOT KNOWN YET (21 Nov 2026).
  // An automatic debit that timed out is left `unknown`, which the in-flight
  // index below does not cover: the merchant could press Pay now and pay the
  // same renewal a second time while the first debit was still going through.
  // Reconciliation settles it within the hour when the gateway knows the
  // answer, and within a few hours when the debit never reached it, and the
  // plan is safe meanwhile (an unresolved payment starts no grace clock).
  const unresolved = await hasUnknownAttempt(invoice.id);
  if (unresolved === null) {
    return {
      ok: false,
      error: "We couldn't check this invoice just now. Please try again.",
    };
  }
  if (unresolved) {
    return { ok: false, error: PAYMENT_BEING_CONFIRMED_MESSAGE };
  }

  if (inFlight) {
    // ── "Pay now instead": withdraw the scheduled automatic debit ───────────
    // ★ Only when asked, and only a debit that has NOT been sent: each
    // withdrawal is one conditional write on `debit_sent_at` being null, the
    // same one the debit pass's claim is, so exactly one of them wins. A debit
    // already on its way to the bank is left alone and this start is refused
    // below.
    if (input.insteadOfAutopay) {
      const withdrawn = await withdrawUnsentDebits({
        invoiceId: invoice.id,
        code: "paid_by_hand",
        reason: "the merchant chose to pay this invoice by hand",
        now,
      });
      if (withdrawn === null) {
        return {
          ok: false,
          error: "We couldn't check this invoice just now. Please try again.",
        };
      }
      if (withdrawn > 0) {
        logInfo("billing.manual_pay_replaced_autopay", {
          storeId: input.storeId,
          invoiceId: invoice.id,
          withdrawn,
        });
      }
    }

    // ── A checkout opened earlier and never finished: the SAME order ────────
    const open = await openManualCheckout(invoice.id, input.storeId);
    if (open === undefined) {
      return {
        ok: false,
        error: "We couldn't check this invoice just now. Please try again.",
      };
    }
    if (open && open.amountPaise === amountDue) {
      return resumeCheckout(creds, {
        storeId: input.storeId,
        invoiceId: invoice.id,
        invoiceRef: invoice.invoiceRef,
        amountDue,
        open,
      });
    }
    // ★★ THE AMOUNT DUE CHANGED SINCE THAT CHECKOUT WAS OPENED (PR #303
    // review, 22 Nov 2026). Its order is for the old amount, so it is never
    // reopened. It used to be refused and left in flight, where the
    // one-in-flight index then blocked a fresh payment too, until
    // reconciliation gave the old attempt up 72 hours later: the merchant
    // could not pay their invoice either way. When the gateway says nobody
    // paid the old order, it is closed here and a new one starts below.
    if (open) {
      const retired = await retireStaleCheckout(creds, {
        storeId: input.storeId,
        invoiceId: invoice.id,
        open,
        now,
      });
      if (!retired.ok) return retired;
    }

    // Nothing to reopen. The invoice is payable only if it is `open` now
    // (the withdrawal above re-derived it); anything else is a payment that
    // is really moving.
    const after = await getInvoice(invoice.id);
    if (!after || after.status !== "open") {
      return { ok: false, error: PAYMENT_IN_PROGRESS_MESSAGE };
    }
  }

  const attempt = await beginAttempt({
    invoiceId: invoice.id,
    storeId: input.storeId,
    amountPaise: amountDue,
    mode: "manual",
  });
  // ★ The partial unique index refused it: something is already collecting.
  // Three clicks on Pay, or the renewal worker charging this very invoice.
  if (!attempt) {
    return {
      ok: false,
      error: "A payment is already in progress. Give it a moment.",
    };
  }

  const order = await rzpCreateOrder(creds, {
    amountPaise: amountDue,
    receipt: invoice.invoiceRef ?? invoice.id.slice(0, 30),
    notes: {
      store_id: input.storeId,
      invoice_id: invoice.id,
      sm_billing_key: attempt.idempotencyKey,
    },
  });
  if (!order.ok) {
    await settleAttempt(
      attempt.attemptId,
      // An UNKNOWN leaves it in flight — the order may exist, and failing it
      // would let a second attempt open against the same money.
      order.outcome === "unknown" ? "unknown" : "failed",
      { failureCode: "order_create", failureReason: order.error, now },
    );
    return {
      ok: false,
      error: "Couldn't start the payment. Please try again.",
    };
  }

  // ★ The order id leaves the server only once the attempt holds it
  // (`recordGatewayOrder`): an order the attempt does not know about must
  // never be payable.
  const recorded = await recordGatewayOrder({
    attemptId: attempt.attemptId,
    providerOrderId: order.data.id,
    invoiceId: invoice.id,
    storeId: input.storeId,
    now,
  });
  if (!recorded) {
    return {
      ok: false,
      error: "Couldn't start the payment. Please try again.",
    };
  }

  return {
    ok: true,
    data: {
      invoiceId: invoice.id,
      providerOrderId: order.data.id,
      keyId: creds.keyId,
      amountPaise: amountDue,
      invoiceRef: invoice.invoiceRef,
    },
  };
}

/** A checkout this store opened for an invoice and has not finished. */
interface OpenCheckout {
  attemptId: string;
  providerOrderId: string;
  amountPaise: number;
}

/**
 * The invoice's unfinished MANUAL checkout, if it has one: an attempt still
 * `processing` that already holds a gateway order. Null when there is none;
 * ★ undefined when the read failed, which the caller must not read as "none".
 *
 * Scoped by store as well as invoice: an invoice id alone must never reopen
 * another merchant's payment. Never an automatic attempt: its order belongs to
 * a mandate debit, not to a checkout.
 */
async function openManualCheckout(
  invoiceId: string,
  storeId: string,
): Promise<OpenCheckout | null | undefined> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingPaymentAttempts.id,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, invoiceId),
            eq(billingPaymentAttempts.storeId, storeId),
            eq(billingPaymentAttempts.mode, "manual"),
            eq(billingPaymentAttempts.state, "processing"),
            isNotNull(billingPaymentAttempts.providerOrderId),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      if (!row?.providerOrderId) return null;
      return {
        attemptId: row.id,
        providerOrderId: row.providerOrderId,
        amountPaise: Number(row.amountPaise),
      };
    });
  } catch (err) {
    logError("billing.manual_pay_open_checkout", err, { invoiceId, storeId });
    return undefined;
  }
}

/**
 * Reopen an unfinished checkout on the order it already has.
 *
 * ★★ THE SAME ORDER, NEVER A NEW ONE. One gateway order takes one payment, so
 * reopening it cannot charge the merchant twice, where a second order beside
 * it could. And the gateway is asked first, because our own record may be
 * behind it:
 *   • already paid (a tab closed after paying): never reopened; the webhook
 *     or the hourly check records it within the hour;
 *   • a payment still waiting for approval in the payer's app: not reopened
 *     until it resolves;
 *   • nobody has paid it, or every try on it failed: reopened.
 * A read that fails refuses: "we could not check" is not "nobody paid".
 */
async function resumeCheckout(
  creds: NonNullable<ReturnType<typeof getPlatformRazorpayCreds>>,
  input: {
    storeId: string;
    invoiceId: string;
    invoiceRef: string | null;
    amountDue: number;
    open: OpenCheckout;
  },
): Promise<PayResult<PaymentStart>> {
  // An order made for another amount is never reopened at this one (the
  // caller retires it instead: `retireStaleCheckout`).
  if (input.open.amountPaise !== input.amountDue) {
    return { ok: false, error: PAYMENT_IN_PROGRESS_MESSAGE };
  }
  const order = await rzpFetchOrder(creds, input.open.providerOrderId);
  if (!order.ok) {
    return {
      ok: false,
      error:
        "We couldn't check this invoice's payments just now. Please try again.",
    };
  }
  if (
    order.data.status === "paid" ||
    (order.data.amount_paid ?? 0) >= input.amountDue
  ) {
    logWarn("billing.manual_pay_resume_already_paid", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
      attemptId: input.open.attemptId,
    });
    return { ok: false, error: ALREADY_CAPTURED_INVOICE_MESSAGE };
  }
  if (!(await orderIsUntouched(creds, order))) {
    return { ok: false, error: PAYMENT_IN_PROGRESS_MESSAGE };
  }
  return {
    ok: true,
    data: {
      invoiceId: input.invoiceId,
      providerOrderId: input.open.providerOrderId,
      keyId: creds.keyId,
      amountPaise: input.amountDue,
      invoiceRef: input.invoiceRef,
    },
  };
}

/**
 * Close an unfinished checkout whose order is for an amount the invoice no
 * longer owes, so a new one can be started.
 *
 * ★ ONLY WHEN THE GATEWAY SAYS NOBODY PAID IT, by the same rule enrolment
 * uses (`orderIsUntouched`): an order nobody opened, or one whose every
 * payment failed. Money on it, a payment still waiting for approval, or a
 * read that failed all refuse, and the attempt is left exactly as it was.
 * The close itself is the state machine's own guarded write: an attempt that
 * moved meanwhile is not closed.
 *
 * ⚠ "Nobody paid it" is not "nobody can" (PR #303 re-review, 22 Nov 2026):
 * the closed order stays payable at Razorpay, and its Checkout window may
 * still be open in another tab. A payment made there afterwards is never
 * dropped: the webhook, that tab's own confirm and the hourly reconcile each
 * file it for a person (`fileClosedAttemptPayment`, collect.ts), and the
 * merchant is told it was not applied.
 */
async function retireStaleCheckout(
  creds: NonNullable<ReturnType<typeof getPlatformRazorpayCreds>>,
  input: { storeId: string; invoiceId: string; open: OpenCheckout; now: Date },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const order = await rzpFetchOrder(creds, input.open.providerOrderId);
  if (!order.ok) {
    return {
      ok: false,
      error:
        "We couldn't check this invoice's payments just now. Please try again.",
    };
  }
  if (order.data.status === "paid" || (order.data.amount_paid ?? 0) > 0) {
    logWarn("billing.manual_pay_stale_checkout_paid", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
      attemptId: input.open.attemptId,
    });
    return { ok: false, error: ALREADY_CAPTURED_INVOICE_MESSAGE };
  }
  if (!(await orderIsUntouched(creds, order))) {
    return { ok: false, error: PAYMENT_IN_PROGRESS_MESSAGE };
  }
  const settled = await settleAttempt(input.open.attemptId, "cancelled", {
    failureCode: "amount_changed",
    failureReason: "the amount due changed before this checkout was paid",
    now: input.now,
  });
  if (settled !== "cancelled") {
    return { ok: false, error: PAYMENT_IN_PROGRESS_MESSAGE };
  }
  logInfo("billing.manual_pay_stale_checkout_retired", {
    storeId: input.storeId,
    invoiceId: input.invoiceId,
    attemptId: input.open.attemptId,
  });
  return { ok: true };
}

export interface PaymentConfirmed {
  invoiceId: string;
  /** True when this payment ended a grace window and restored the plan. */
  planRestored: boolean;
}

/**
 * Settle a manual payment.
 *
 * ★ The HMAC is the trust boundary, verified against the order WE created. A
 * payment id from the browser proves nothing.
 */
export async function confirmInvoicePayment(input: {
  storeId: string;
  invoiceId: string;
  providerPaymentId: string;
  signature: string;
  now?: Date;
}): Promise<PayResult<PaymentConfirmed>> {
  const now = input.now ?? new Date();
  const creds = getPlatformRazorpayCreds();
  if (!creds)
    return { ok: false, error: "Payments aren't available right now." };

  let attempt: {
    id: string;
    providerOrderId: string | null;
    amountPaise: number;
  } | null = null;
  try {
    attempt = await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingPaymentAttempts.id,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, input.invoiceId),
            eq(billingPaymentAttempts.storeId, input.storeId),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.manual_confirm_load", err, {
      invoiceId: input.invoiceId,
    });
    return { ok: false, error: "Couldn't confirm that payment." };
  }

  // ★★ THE PAYMENT MAY BELONG TO AN EARLIER, CLOSED CHECKOUT OF THIS INVOICE
  // (PR #303 re-review, 22 Nov 2026). Pay now closes a checkout whose amount
  // changed and starts another, but the first tab may still be open and its
  // Razorpay order is still payable. That tab's payment arrives here signed
  // for the OLD order, so it fails the check against the newest attempt, and
  // "We couldn't verify that payment." sent the merchant to pay again with
  // their money already taken. The signature is checked against the invoice's
  // closed attempts too: one it verifies for is that payment, proved by the
  // same HMAC. It is filed for a person and never applied here (the amount is
  // not the one now due, and the invoice may since have been paid).
  const signedForLatest =
    !!attempt?.providerOrderId &&
    verifyCheckoutSignature(
      creds.keySecret,
      attempt.providerOrderId,
      input.providerPaymentId,
      input.signature,
    );
  if (!signedForLatest) {
    const closed = await closedCheckoutSignedFor(creds.keySecret, input);
    if (closed) {
      await fileClosedAttemptPayment({
        storeId: input.storeId,
        invoiceId: input.invoiceId,
        attemptId: closed.id,
        providerPaymentId: input.providerPaymentId,
        providerOrderId: closed.providerOrderId,
        expectedPaise: closed.amountPaise,
        closedAs: closed.state,
        closedCode: closed.failureCode,
        source: "confirm",
        now,
      });
      return { ok: false, error: PAID_ON_CLOSED_CHECKOUT_MESSAGE };
    }
  }

  if (!attempt?.providerOrderId) {
    return { ok: false, error: "No payment to confirm." };
  }

  if (!signedForLatest) {
    logWarn("billing.manual_bad_signature", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
    });
    return { ok: false, error: "We couldn't verify that payment." };
  }

  const observedPayment = await verifyCapturedCheckoutPayment(creds, {
    paymentId: input.providerPaymentId,
    orderId: attempt.providerOrderId,
    amountPaise: attempt.amountPaise,
  });
  if (!observedPayment.ok) {
    logWarn("billing.manual_gateway_mismatch", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
      reason: observedPayment.error,
    });
    return { ok: false, error: observedPayment.error };
  }

  const settled = await settleAttempt(attempt.id, "captured", {
    providerPaymentId: input.providerPaymentId,
    now,
  });
  // null means a concurrent settle won — the money is still accounted for.
  if (settled && settled !== "captured") {
    return { ok: false, error: "That payment didn't complete." };
  }

  // ★★ THE PLAN MAY HAVE ENDED WHILE THE CHECKOUT WAS OPEN (design 4.3 edge
  // case 2). The plan end closes the invoice, the capture cannot reopen it
  // (`syncInvoiceStatus` claims only open and processing), and the refund pass
  // returns the money. Saying "Paid" here would be untrue, so the merchant is
  // told the refund instead. A failed re-read changes nothing: the advance
  // below decides from the database either way.
  const after = await getInvoice(input.invoiceId);
  if (
    after &&
    after.storeId === input.storeId &&
    (after.status === "void" || after.status === "uncollectible")
  ) {
    logInfo("billing.manual_pay_on_closed_invoice", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
      invoiceStatus: after.status,
    });
    return { ok: false, error: CLOSED_ON_ARRIVAL_MESSAGE };
  }

  // ★★ Restore the plan NOW rather than at the next cron tick, using the SAME
  // advance the worker uses. A merchant who has just paid must not stay locked
  // out of their own till for an hour.
  const planRestored = await advanceAfterPayment(input.storeId, now);

  return { ok: true, data: { invoiceId: input.invoiceId, planRestored } };
}

/** How many of an invoice's closed checkouts a confirm is checked against. */
const CLOSED_CHECKOUTS_CHECKED = 10;

/**
 * The CLOSED attempt of this store's invoice whose order this payment is
 * signed for, if any. Null when there is none, and when the read fails: the
 * caller then answers as it always did, and the webhook and the hourly pass
 * still find the payment.
 */
async function closedCheckoutSignedFor(
  keySecret: string,
  input: {
    storeId: string;
    invoiceId: string;
    providerPaymentId: string;
    signature: string;
  },
): Promise<{
  id: string;
  providerOrderId: string;
  amountPaise: number;
  state: string;
  failureCode: string | null;
} | null> {
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: billingPaymentAttempts.id,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
          state: billingPaymentAttempts.state,
          failureCode: billingPaymentAttempts.failureCode,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, input.invoiceId),
            eq(billingPaymentAttempts.storeId, input.storeId),
            inArray(billingPaymentAttempts.state, ["failed", "cancelled"]),
            isNotNull(billingPaymentAttempts.providerOrderId),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(CLOSED_CHECKOUTS_CHECKED),
    );
    for (const row of rows) {
      if (
        row.providerOrderId &&
        verifyCheckoutSignature(
          keySecret,
          row.providerOrderId,
          input.providerPaymentId,
          input.signature,
        )
      ) {
        return { ...row, providerOrderId: row.providerOrderId };
      }
    }
    return null;
  } catch (err) {
    logError("billing.manual_confirm_closed_checkouts", err, {
      invoiceId: input.invoiceId,
    });
    return null;
  }
}

/**
 * Subscription invoices this store still owes, newest first — what a "pay now"
 * surface lists. One-time AI-credit invoices are receipts, never plan debt.
 *
 * Excludes `uncollectible` and `void`: both are closed decisions, and offering
 * to pay one would take money for a period the merchant never received.
 *
 * ★★ AND EVERY INVOICE FOR A CYCLE THE STORE WILL NOT ENTER (design 6.5): the
 * next cycle's while a cancellation stands, any above an ended plan's last
 * cycle, any below a live plan's current cycle. The `cycleRefusal` rule, in
 * SQL. ★ The subscription is a LEFT join wrapped in coalesce: a store with no
 * subscription row lists its invoices as before, where a bare NOT over a NULL
 * comparison would silently hide every one.
 *
 * ★ `autopayAt` marks an invoice whose automatic debit is scheduled (its bank
 * notice sent, its debit not yet): the panel says so instead of asking for a
 * payment, and offers "Pay now instead". `resumable` marks one whose checkout
 * was opened and not finished: the panel offers "Continue payment".
 */
export async function listPayableInvoices(
  storeId: string,
): Promise<PayableInvoice[]> {
  try {
    return await withService(async (db) =>
      db
        .select({
          id: billingInvoices.id,
          invoiceRef: billingInvoices.invoiceRef,
          status: billingInvoices.status,
          totalPaise: billingInvoices.totalPaise,
          periodStart: billingInvoices.periodStart,
          periodEnd: billingInvoices.periodEnd,
          dueAt: billingInvoices.dueAt,
          createdAt: billingInvoices.createdAt,
          // GST design 5.9: the "invoice to pay" panel says what of the
          // total is GST, from the invoice's own figures.
          taxPaise: billingInvoices.taxPaise,
          taxRateBps: billingInvoices.taxRateBps,
          taxInclusive: billingInvoices.taxInclusive,
          // ★ A scheduled automatic debit: notified, not sent yet. Formatted
          // in SQL so it is the same ISO string whatever the driver returns
          // for a timestamp. ⚠ The outer table is named by hand, for the
          // reason `readNextInvoice` (cancel.ts) gives.
          autopayAt: sql<string | null>`(
            select to_char(min(a.debit_after) at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              from public.billing_payment_attempts a
             where a.invoice_id = "billing_invoices"."id"
               and a.mode = 'automatic'
               and a.state = 'processing'
               and a.debit_after is not null
               and a.debit_sent_at is null)`,
          // ★ A checkout the merchant opened and did not finish: the panel
          // offers "Continue payment", which reopens the same gateway order.
          resumable: sql<boolean>`exists (
            select 1 from public.billing_payment_attempts a
             where a.invoice_id = "billing_invoices"."id"
               and a.mode = 'manual'
               and a.state = 'processing'
               and a.provider_order_id is not null)`,
        })
        .from(billingInvoices)
        .leftJoin(
          billingSubscriptions,
          eq(billingSubscriptions.storeId, billingInvoices.storeId),
        )
        .where(
          and(
            eq(billingInvoices.storeId, storeId),
            eq(billingInvoices.kind, "subscription"),
            inArray(billingInvoices.status, ["open", "processing"]),
            sql`not coalesce(
              (${billingSubscriptions.cancelAtPeriodEnd}
                and ${billingInvoices.cycleSeq} = ${billingSubscriptions.currentCycleSeq} + 1)
              or (${billingSubscriptions.state} in ('cancelled', 'downgraded')
                and ${billingInvoices.cycleSeq} > ${billingSubscriptions.currentCycleSeq})
              or (${billingSubscriptions.state} in ('active', 'past_due', 'grace')
                and ${billingInvoices.cycleSeq} < ${billingSubscriptions.currentCycleSeq}),
              false)`,
          ),
        )
        .orderBy(desc(billingInvoices.createdAt))
        .limit(20),
    );
  } catch (err) {
    logError("billing.list_payable", err, { storeId });
    return [];
  }
}
