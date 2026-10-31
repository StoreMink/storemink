import "server-only";

/**
 * Telling the merchant that something GOOD happened (§34).
 *
 * ★★ SEPARATE FROM `dunning.ts` ON PURPOSE. Dunning means debt collection: the
 * invoice issued, the 48-hour warning, the downgrade. These three are
 * acknowledgements: your plan is on, we got your money, your cancellation is
 * recorded. Same machinery, opposite job, and a module that holds both ends up
 * called "billing-emails-2" within a year.
 *
 * ★★ ALL THREE ARE REGRESSIONS BEING REPAIRED, not new features. The old
 * Razorpay-Subscriptions path sent every one of them (`planActivatedTemplate`
 * from `confirmSubscription`, `paymentReceiptTemplate` and
 * `subscriptionCancelledTemplate` from the webhook), and deleting that path on
 * 2026-08-13 took them with it. For a few days a merchant could subscribe, pay
 * ₹50,000 and hear nothing at all, which is worse than the old system.
 *
 * ★ BEST-EFFORT, ALWAYS. These are called after money has moved and state has
 * been committed. A mail provider having a bad afternoon must never fail a
 * payment, a cancellation, or an activation.
 *
 * ★ AND THE REFUND NOTICES (`notifyRefundSent`, `notifyRefundRecorded`): money
 * StoreMink returned reached the merchant. They read the refund and its
 * invoice themselves, so a refund of a deleted store's invoice still reaches
 * the billing email recorded on that invoice.
 */

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  billingInvoiceItems,
  billingInvoices,
  billingRefunds,
  billingSubscriptions,
} from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import { PLAN_META, normalizePlan } from "@/lib/plans";
import {
  emailTaxFromInvoice,
  invoicesUrl,
  manageUrl,
  paymentReceiptTemplate,
  planActivatedTemplate,
  refundTemplate,
  resolveBillingEmail,
  sendBillingEmail,
  subscriptionCancelledTemplate,
  type CancelledNextInvoice,
  type RefundCreditNote,
} from "@/lib/email/billing-emails";
import { parseInvoiceParties } from "./invoice-history";
import { getTaxTermsLive } from "./platform-settings";
import type { TaxTerms } from "./tax-terms";

function planName(plan: string): string {
  return PLAN_META[normalizePlan(plan)].name;
}

/** States in which a subscription still runs (and so can be cancelling). */
const LIVE_STATES = ["active", "past_due", "grace"];

/** A subscription in these states has an unpaid renewal: cancelling it ends
 *  the plan when grace ends, not at the paid period's end. */
const GRACE_STATES = ["past_due", "grace"];

/**
 * Whether a store's dashboard is open. A suspended store's is closed (the
 * resolver serves only active stores), so an email to it must not send the
 * merchant there. An unknown status reads as open: the email then carries a
 * link, which is the old behaviour, rather than hiding a working dashboard.
 */
function storeIsOpen(status: string | null | undefined): boolean {
  return status == null || status === "active" || status === "pending";
}

/** Who asked for a cancellation: `cancel_requested_by` is
 *  "merchant:<user id>" or "operator:<email>". */
function cancellationRequestedBy(
  requestedBy: string | null | undefined,
): "merchant" | "operator" {
  return typeof requestedBy === "string" && requestedBy.startsWith("operator")
    ? "operator"
    : "merchant";
}

/**
 * An invoice has just been paid.
 *
 * ★★ CALLED FROM `settleAttempt`, the ONE place an invoice transitions to paid,
 * so enrolment, manual payment, a plan change, a location purchase AND
 * reconciliation each produce exactly one receipt, and none of them has to
 * remember to. The transition is claimed, so a second settle sends nothing.
 */
export async function notifyInvoicePaid(
  storeId: string,
  invoiceId: string,
): Promise<void> {
  try {
    const [to, invoice] = await Promise.all([
      resolveBillingEmail(storeId),
      loadInvoice(storeId, invoiceId),
    ]);
    if (!to || !invoice) return;

    // ★ A credit purchase is not a subscription payment, and a receipt saying
    // "your Pro plan is active" for a ₹59 credit pack is wrong. Those have their
    // own confirmation (`ai.credits_purchased`), so this stays quiet.
    if (invoice.kind === "ai_credits") return;

    const sub = await loadSubscription(storeId);
    const cancelling = cancelledCyclePayment(invoice, sub);
    await sendBillingEmail(
      to.email,
      paymentReceiptTemplate({
        storeName: to.storeName,
        planName: planName(sub?.plan ?? "basic"),
        // Paise and GST as the invoice charged them (GST Stage 6).
        amountPaise: invoice.totalPaise,
        tax: emailTaxFromInvoice(invoice),
        period: sub?.period === "yearly" ? "yearly" : "monthly",
        // The date the merchant cares about is when it runs to, not when we
        // wrote the row. ⚠ None for a cycle the cancelled plan will not reach:
        // naming one would promise a renewal that is not going to happen.
        renewsOn: cancelling
          ? null
          : (invoice.periodEnd ?? sub?.currentPeriodEnd ?? null),
        manageUrl: manageUrl(to.slug),
        cancelling,
      }),
      storeId,
    );
  } catch (err) {
    logError("billing.notify_invoice_paid", err, { storeId, invoiceId });
  }
}

/**
 * A merchant has just subscribed.
 *
 * ★ `autopay` decides what the email PROMISES. Saying "it renews automatically"
 * to someone with no mandate is how a merchant does nothing and is downgraded:
 * the same rule the invoice-issued notice follows.
 */
export async function notifyPlanActivated(input: {
  storeId: string;
  /** What they just paid: the amount comes from the document, not the caller. */
  invoiceId: string;
  autopay: boolean;
}): Promise<void> {
  try {
    const [to, invoice, sub] = await Promise.all([
      resolveBillingEmail(input.storeId),
      loadInvoice(input.storeId, input.invoiceId),
      loadSubscription(input.storeId),
    ]);
    if (!to || !sub) return;
    // Read after the three reads above, never beside them: this is a
    // background notice and needs no fourth pooled connection at once.
    const taxTerms = await loadTaxTerms(input.storeId);
    await sendBillingEmail(
      to.email,
      planActivatedTemplate({
        storeName: to.storeName,
        planName: planName(sub.plan),
        // Paise and GST as the invoice charged them (GST Stage 6).
        amountPaise: invoice?.totalPaise ?? 0,
        tax: invoice ? emailTaxFromInvoice(invoice) : null,
        // Today's GST terms, for design 7.7's SCHED-EX paragraph.
        taxTerms,
        period: sub.period === "yearly" ? "yearly" : "monthly",
        // ⚠ The template's copy says autopay is set up. With no mandate that is
        // untrue, so the renewal date is withheld rather than promised; the
        // merchant is told when to expect an invoice by the dunning notice
        // instead.
        renewsOn: input.autopay ? sub.currentPeriodEnd : null,
        manageUrl: manageUrl(to.slug),
      }),
      input.storeId,
    );
  } catch (err) {
    logError("billing.notify_plan_activated", err, { storeId: input.storeId });
  }
}

/**
 * When the payment just received is for the NEXT cycle of a plan the merchant
 * has cancelled, the moment that plan ends; otherwise null.
 *
 * ★ That cycle never happens (cancelling never keeps money for a cycle the
 * plan does not reach), so the receipt says the payment comes back. A plan
 * cancelled during grace ends when grace ends.
 */
function cancelledCyclePayment(
  invoice: { kind: string; cycleSeq: number | null },
  sub: {
    state: string;
    cancelAtPeriodEnd: boolean;
    currentCycleSeq: number;
    currentPeriodEnd: string | null;
    graceEndsAt: string | null;
  } | null,
): { endsAt: string; inGrace: boolean } | null {
  if (!sub || !sub.cancelAtPeriodEnd) return null;
  if (!LIVE_STATES.includes(sub.state)) return null;
  if (invoice.kind !== "subscription") return null;
  if (invoice.cycleSeq == null || invoice.cycleSeq !== sub.currentCycleSeq + 1)
    return null;
  if (GRACE_STATES.includes(sub.state) && sub.graceEndsAt) {
    return { endsAt: sub.graceEndsAt, inGrace: true };
  }
  return sub.currentPeriodEnd
    ? { endsAt: sub.currentPeriodEnd, inGrace: false }
    : null;
}

/**
 * A subscription has been cancelled: confirmed, with what they keep, until
 * when, and what happens to a renewal payment already made or under way.
 *
 * ★ THE FACTS COME FROM THE CANCELLATION, read under its claim: the state the
 * subscription was in, the grace deadline, the next cycle's invoice and who
 * asked. Every field past `accessUntil` is optional only so an older caller
 * still compiles; absent, the email reads as an ordinary cancellation by the
 * merchant with nothing on the way.
 *
 * ★ The store's status decides the variant: a suspended store's dashboard is
 * closed, so its email names the support address instead of linking there.
 */
export async function notifySubscriptionCancelled(input: {
  storeId: string;
  plan: string;
  /** End of the paid period. Null when no cycle was ever paid for. */
  accessUntil: string | null;
  /** The subscription's state when it was cancelled. */
  state?: string | null;
  /** When grace ends, for a subscription cancelled in grace. */
  graceEndsAt?: string | null;
  /** The next cycle's invoice at that moment, if one was issued. */
  nextInvoice?: CancelledNextInvoice | null;
  /** `cancel_requested_by`: "merchant:<user id>" or "operator:<email>". */
  requestedBy?: string | null;
}): Promise<void> {
  try {
    const to = await resolveBillingEmail(input.storeId);
    if (!to) return;
    const inGrace = GRACE_STATES.includes(input.state ?? "");
    await sendBillingEmail(
      to.email,
      subscriptionCancelledTemplate({
        storeName: to.storeName,
        planName: planName(input.plan),
        // A plan cancelled in grace ends when grace ends: the paid period is
        // already behind it, so its end is not a date they keep the plan to.
        endsAt: inGrace ? (input.graceEndsAt ?? null) : input.accessUntil,
        inGrace,
        nextInvoice: input.nextInvoice ?? null,
        requestedBy: cancellationRequestedBy(input.requestedBy),
        storeSuspended: !storeIsOpen(to.storeStatus),
        manageUrl: manageUrl(to.slug),
      }),
      input.storeId,
    );
  } catch (err) {
    logError("billing.notify_cancelled", err, { storeId: input.storeId });
  }
}

/** What the caller knows that this module does not read itself. */
export interface RefundNoticeOptions {
  /**
   * The refund's credit note, from the credit note store, or null when it has
   * none (a duplicate payment, or nothing left on the invoice to credit). A
   * suspended or deleted store gets its particulars printed in the email.
   */
  creditNote?: RefundCreditNote | null;
}

/**
 * A refund StoreMink sent through Razorpay has been processed: tell the
 * merchant. Best-effort and never throws.
 *
 * ★ EXACTLY ONCE is the CALLER's claim (`billing_refunds.notified_at`, set
 * before this is called), not this function's: it reads and sends.
 */
export async function notifyRefundSent(
  refundId: string,
  options: RefundNoticeOptions = {},
): Promise<void> {
  await notifyRefund("sent", refundId, options);
}

/**
 * A refund made outside the tool (a bank transfer, or one made by hand in
 * Razorpay) has been recorded: tell the merchant. Best-effort, never throws.
 */
export async function notifyRefundRecorded(
  refundId: string,
  options: RefundNoticeOptions = {},
): Promise<void> {
  await notifyRefund("recorded", refundId, options);
}

/**
 * The address a refund notice goes to.
 *
 * ★ THE STORE BEHIND THE INVOICE DECIDES. A store that exists gets its billing
 * contact (`resolveBillingEmail`): with its dashboard link while it is open,
 * without one while it is suspended. A deleted store (the invoice's store_id
 * is NULL since 0243) has no billing account left, so the notice goes to the
 * billing email recorded on the invoice when it was issued. No address means
 * nobody can be told: the caller logs it, and nothing is sent.
 */
async function refundRecipient(facts: {
  storeId: string | null;
  parties: unknown;
}): Promise<{
  email: string;
  storeName: string;
  slug: string | null;
  storeState: "active" | "suspended" | "deleted";
} | null> {
  if (facts.storeId) {
    const to = await resolveBillingEmail(facts.storeId);
    if (!to) return null;
    return {
      email: to.email,
      storeName: to.storeName,
      slug: to.slug || null,
      storeState: storeIsOpen(to.storeStatus) ? "active" : "suspended",
    };
  }
  const parties = parseInvoiceParties(facts.parties);
  const email = parties?.customer.email?.trim() ?? "";
  if (!email.includes("@")) return null;
  return {
    email,
    storeName: parties?.customer.name?.trim() || "Your store",
    slug: null,
    storeState: "deleted",
  };
}

async function notifyRefund(
  kind: "sent" | "recorded",
  refundId: string,
  options: RefundNoticeOptions,
): Promise<void> {
  try {
    const facts = await loadRefund(refundId);
    if (!facts) {
      logWarn("billing.refund_notice_missing", { refundId, kind });
      return;
    }
    // ★ Only a refund that reached the merchant is announced, and as what it
    // is: "we've refunded" must never go out while it is still on its way.
    const expected = kind === "sent" ? "processed" : "recorded";
    if (facts.status !== expected) {
      logWarn("billing.refund_notice_wrong_status", {
        refundId,
        kind,
        status: facts.status,
      });
      return;
    }

    const to = await refundRecipient(facts);
    if (!to) {
      logWarn("billing.refund_notice_no_address", {
        refundId,
        invoiceId: facts.invoiceId,
        storeDeleted: facts.storeId == null,
      });
      return;
    }

    const subscriptionPlan =
      facts.planName == null && facts.storeId
        ? ((await loadSubscription(facts.storeId))?.plan ?? null)
        : null;
    const byBank = facts.method === "bank_transfer";

    await sendBillingEmail(
      to.email,
      refundTemplate({
        kind,
        storeName: to.storeName,
        planName:
          facts.planName ??
          (subscriptionPlan ? planName(subscriptionPlan) : null),
        amountPaise: facts.amountPaise,
        invoiceRef: facts.invoiceRef,
        method: byBank ? "bank_transfer" : "razorpay",
        reason: facts.reason,
        // A bank transfer's reference is its UTR; a Razorpay refund's is the
        // refund id (or, for one recorded by hand, what the operator typed).
        refundReference: byBank
          ? (facts.externalReference ?? facts.providerRefundId)
          : (facts.providerRefundId ?? facts.externalReference),
        creditNote: options.creditNote ?? null,
        storeState: to.storeState,
        invoicesUrl: to.slug ? invoicesUrl(to.slug) : null,
      }),
      facts.storeId,
    );
  } catch (err) {
    logError("billing.notify_refund", err, { refundId, kind });
  }
}

/**
 * The plan an invoice was for, read from its own base plan line
 * ("Pro plan · 1 month"), so a deleted store's refund can still name it.
 */
function planFromLine(description: string | null | undefined): string | null {
  const match = /^(.+?) plan · /.exec(description ?? "");
  return match ? match[1].trim() || null : null;
}

/** One refund with what its notice prints from the invoice it reverses. */
async function loadRefund(refundId: string) {
  return withService(async (db) => {
    const [row] = await db
      .select({
        status: billingRefunds.status,
        method: billingRefunds.method,
        reason: billingRefunds.reason,
        amountPaise: billingRefunds.amountPaise,
        providerRefundId: billingRefunds.providerRefundId,
        externalReference: billingRefunds.externalReference,
        invoiceId: billingRefunds.invoiceId,
        storeId: billingInvoices.storeId,
        invoiceRef: billingInvoices.invoiceRef,
        parties: billingInvoices.parties,
      })
      .from(billingRefunds)
      .innerJoin(
        billingInvoices,
        eq(billingInvoices.id, billingRefunds.invoiceId),
      )
      .where(eq(billingRefunds.id, refundId))
      .limit(1);
    if (!row) return null;
    const [line] = await db
      .select({ description: billingInvoiceItems.description })
      .from(billingInvoiceItems)
      .where(
        and(
          eq(billingInvoiceItems.invoiceId, row.invoiceId),
          eq(billingInvoiceItems.kind, "base_plan"),
        ),
      )
      .limit(1);
    return { ...row, planName: planFromLine(line?.description) };
  });
}

async function loadInvoice(storeId: string, invoiceId: string) {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          kind: billingInvoices.kind,
          totalPaise: billingInvoices.totalPaise,
          taxPaise: billingInvoices.taxPaise,
          taxRateBps: billingInvoices.taxRateBps,
          taxInclusive: billingInvoices.taxInclusive,
          periodEnd: billingInvoices.periodEnd,
          cycleSeq: billingInvoices.cycleSeq,
        })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.id, invoiceId),
            // Scoped, like every other invoice read.
            eq(billingInvoices.storeId, storeId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  } catch {
    return null;
  }
}

/**
 * Today's GST terms, read live, for the plan-activated email's SCHED-EX
 * paragraph. ★ Best-effort: a failed read sends the welcome without that
 * paragraph (logged), never no welcome at all.
 */
async function loadTaxTerms(storeId: string): Promise<TaxTerms | null> {
  try {
    return await getTaxTermsLive();
  } catch (err) {
    logWarn("billing.notify_plan_activated_tax_terms", {
      storeId,
      // The database's own reason only, never a failed query's parameters.
      error: dbErrorMessage(err, "tax terms unreadable"),
    });
    return null;
  }
}

async function loadSubscription(storeId: string) {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          plan: billingSubscriptions.plan,
          period: billingSubscriptions.period,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          state: billingSubscriptions.state,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          graceEndsAt: billingSubscriptions.graceEndsAt,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      return row ?? null;
    });
  } catch {
    return null;
  }
}
