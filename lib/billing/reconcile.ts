import "server-only";

/**
 * Settling payments whose outcome we never learned (§34).
 *
 * ★★ WHY THIS IS NOT OPTIONAL. `collect.ts` is deliberate that an UNKNOWN outcome
 * — a 5xx, a timeout, a throw — is never treated as a failure and is never
 * retried, because a retry might charge twice. That is right, and it leaves the
 * attempt sitting in `unknown` forever with nothing to resolve it. The same is
 * true of `processing`: nothing tells us a merchant closed the payment window, so
 * a dismissed checkout is indistinguishable from one still open. Until now
 * `billing_reconciliation_items` existed and NOTHING wrote or read it.
 *
 * ★ IT ASKS THE GATEWAY, IT DOES NOT GUESS. The only evidence that settles an
 * attempt as paid is a CAPTURED payment on the order we created. This uses
 * `rzpFetchOrderPayments` + `capturedPayment` — the same verified pair the §18
 * merchant-order reconciliation has used in production, not the unverified
 * recurring endpoint.
 *
 * ── The two directions, and why they are not symmetric ──
 *
 * FINDING MONEY is urgent and safe: a captured payment means the merchant paid,
 * and marking it so can only help them. It runs as soon as an attempt is stale.
 *
 * DECLARING FAILURE is neither. It frees the invoice for a fresh attempt, so
 * doing it to a payment still in flight invites a second charge. It therefore
 * waits far longer, and only when the gateway shows no captured payment at all.
 */

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  aiCreditPurchases,
  billingInvoices,
  billingPaymentAttempts,
  billingReconciliationItems,
  stores,
} from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  capturedPayment,
  rzpFetchOrderPayments,
  rzpFetchPayment,
} from "@/lib/payments/razorpay";
import type { ReconciliationItem } from "./invoice-types";
import {
  capturedDraftPurchases,
  fileRecoveredPurchase,
  readAddonOrderTarget,
  settleAttempt,
  type CapturedDraftPurchase,
} from "./collect";
import { completeEnrolmentPurchase } from "./enrol";
import { issueInvoice } from "./invoice-store";
import { completeLocationPurchase } from "./locations";
import { completePlanChangePurchase } from "./plan-change";
import { gatewayCreatedAt } from "./payment-tax";
import { advanceAfterPayment, announceAutopayStopped } from "./renewal-worker";
import { CAPTURED_DRAFT_REPAIR } from "./tax-copy";

export type { ReconciliationItem };

/**
 * How long an attempt may sit before we ask the gateway about it.
 *
 * ★ Long enough that an ordinary checkout is never interrupted. A Razorpay modal
 * can legitimately stay open for several minutes — a merchant reads the amount,
 * switches to their banking app, comes back — and asking about a live payment is
 * harmless but pointless.
 */
export const STALE_AFTER_MINUTES = 15;

/**
 * How long before an attempt with NO captured payment is declared failed.
 *
 * ★★ MUCH LONGER, and deliberately so. Failing an attempt releases the
 * one-in-flight index, so the merchant can start a new payment — which is exactly
 * what must not happen while the first might still land. UPI collect requests can
 * sit unanswered for a long time, and Razorpay's own X+3 window means a payment
 * can confirm days after it was initiated. A stranded attempt costs the merchant
 * a wait; a premature failure can cost them a double charge.
 */
export const FAIL_AFTER_HOURS = 72;

/**
 * How long an AUTOMATIC debit with no payment at all on its order waits before
 * it is declared failed.
 *
 * ★ The renewal pass records the order BEFORE it sends the debit, and nothing
 * but that one server call can pay a recurring order (it needs the customer's
 * mandate token). A debit call that timed out either created its payment,
 * which the gateway then lists on the order within moments, or it created
 * nothing. So an order still listing no payment hours later never will, and
 * holding the invoice the full 72 hours only keeps the merchant from paying it
 * by hand. A manual checkout keeps the long window: its order stays payable
 * from an open browser tab.
 */
export const AUTO_NO_PAYMENT_FAIL_AFTER_HOURS = 6;

/** States that are not over, and so can still be resolved. */
const IN_FLIGHT = ["created", "processing", "authorized", "unknown"];

/** Stranded attempts with no gateway order that one pass will close. */
const ORDERLESS_BATCH = 100;

export interface ReconcileSummary {
  considered: number;
  /** Found captured at the gateway — money we had not recorded. */
  recovered: number;
  /** Declared failed after the long window, freeing the invoice. */
  failed: number;
  /**
   * Attempts that never got a gateway order, closed as failed: nothing could
   * be paid on them, and they were holding their invoice in flight.
   */
  orderless: number;
  /** Asked, still no answer. Left alone. */
  stillUnknown: number;
  /** Flagged for a human. */
  flagged: number;
  /**
   * Purchases whose payment was captured while the invoice was still a draft
   * (the merchant closed the tab before the confirm), finished this pass:
   * invoice issued, receipt sent, plan or locations applied (RC-F1b).
   */
  completed: number;
  errors: number;
}

export interface ReconcileDeps {
  now?: Date;
  limit?: number;
  /**
   * Injected so tests need no gateway. Production passes the real reader; a
   * caller with no credentials passes null and the sweep does nothing rather
   * than guessing.
   */
  fetchOrderPayments?: typeof rzpFetchOrderPayments | null;
}

/**
 * Resolve stranded payment attempts.
 *
 * Safe to run repeatedly: every settle is a conditional claim, and every
 * reconciliation row is deduped by a partial unique index.
 */
export async function reconcileStrandedAttempts(
  deps: ReconcileDeps = {},
): Promise<ReconcileSummary> {
  const now = deps.now ?? new Date();
  const summary: ReconcileSummary = {
    considered: 0,
    recovered: 0,
    failed: 0,
    orderless: 0,
    stillUnknown: 0,
    flagged: 0,
    completed: 0,
    errors: 0,
  };

  const creds = getPlatformRazorpayCreds();
  const fetchPayments =
    deps.fetchOrderPayments === undefined
      ? rzpFetchOrderPayments
      : deps.fetchOrderPayments;
  // ★ No gateway, no reconciliation. Guessing from timestamps alone is how an
  // unpaid invoice gets marked paid.
  if (!creds || !fetchPayments) return summary;

  const staleBefore = new Date(
    now.getTime() - STALE_AFTER_MINUTES * 60_000,
  ).toISOString();

  let rows: {
    id: string;
    /** Null once the store is deleted: its attempts are kept (migration 0243). */
    storeId: string | null;
    invoiceId: string;
    providerOrderId: string | null;
    amountPaise: number;
    state: string;
    /** `automatic` for a debit the renewal pass sent; `manual` for a checkout. */
    mode: string;
    createdAt: string;
  }[];
  try {
    rows = await withService(async (db) =>
      db
        .select({
          id: billingPaymentAttempts.id,
          storeId: billingPaymentAttempts.storeId,
          invoiceId: billingPaymentAttempts.invoiceId,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
          state: billingPaymentAttempts.state,
          mode: billingPaymentAttempts.mode,
          createdAt: billingPaymentAttempts.createdAt,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            inArray(billingPaymentAttempts.state, IN_FLIGHT),
            lt(billingPaymentAttempts.createdAt, staleBefore),
            // ★ Without an order there is nothing to ask about. An attempt that
            // never reached the gateway is handled below, not here.
            isNotNull(billingPaymentAttempts.providerOrderId),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(deps.limit ?? 100),
    );
  } catch (err) {
    logError("billing.reconcile.scan", err);
    summary.errors += 1;
    return summary;
  }

  const failBefore = now.getTime() - FAIL_AFTER_HOURS * 3_600_000;
  const autoEmptyFailBefore =
    now.getTime() - AUTO_NO_PAYMENT_FAIL_AFTER_HOURS * 3_600_000;

  for (const row of rows) {
    summary.considered += 1;
    try {
      const res = await fetchPayments(creds, row.providerOrderId!);
      if (!res.ok) {
        // The gateway is unreachable. Not a verdict — try again next sweep.
        summary.stillUnknown += 1;
        continue;
      }

      const paid = capturedPayment(res.data);
      if (paid) {
        // ── Money we had not recorded ────────────────────────────────────
        const settled = await settleAttempt(row.id, "captured", {
          providerPaymentId: paid.id,
          now,
        });
        // null means a concurrent settle won; either way it is now recorded.
        if (settled === null || settled === "captured") {
          summary.recovered += 1;
          logInfo("billing.reconcile.recovered", {
            attemptId: row.id,
            storeId: row.storeId,
            invoiceId: row.invoiceId,
          });
          if (row.storeId) {
            // ★ The plan follows the money. Without this a merchant who really
            // did pay stays in grace — and is downgraded — because the only
            // thing that advances a cycle is a paid invoice being NOTICED.
            await advanceAfterPayment(row.storeId, now);
          } else if (await isClosedIssuedInvoice(row.invoiceId)) {
            // ★★ A CLOSED INVOICE OF A DELETED STORE IS THE REFUND PASS'S
            // (renewal-cancel, design 6.9). deleteStore closes a live plan's
            // unreached invoices before the store goes, and the refund pass
            // detects a captured payment on an issued void or uncollectible
            // invoice with no store at all. Filing it here as well would hand
            // one payment to two owners: a person and the automatic refund.
            logInfo("billing.reconcile.recovered_closed", {
              attemptId: row.id,
              invoiceId: row.invoiceId,
            });
          } else {
            // ★★ THE STORE WAS DELETED WHILE THIS PAYMENT WAS IN FLIGHT. Its
            // attempt and invoice are kept (migration 0243), so the money is
            // recorded, but there is no plan to advance and nobody to send a
            // receipt to. Money StoreMink holds for a store that no longer
            // exists is a human question: whether, and to whom, to refund it.
            await flag({
              storeId: null,
              kind: "orphan_payment",
              invoiceId: row.invoiceId,
              attemptId: row.id,
              providerPaymentId: paid.id,
              providerOrderId: row.providerOrderId,
              expectedPaise: row.amountPaise,
              observedPaise:
                typeof paid.amount === "number" ? paid.amount : null,
              // storeDeleted: the queue says "store deleted", not "needs
              // attributing" (deleteStore marks the items it detaches alike).
              detail: {
                note: "payment captured for a deleted store",
                storeDeleted: true,
              },
              now,
            });
            summary.flagged += 1;
          }

          // ★★ AMOUNT MISMATCH IS A HUMAN QUESTION, not something to auto-fix.
          // We recorded the payment either way — the merchant paid — but if the
          // captured amount differs from what we asked for, somebody has to
          // decide what happens to the difference.
          if (
            typeof paid.amount === "number" &&
            paid.amount !== row.amountPaise
          ) {
            await flag({
              storeId: row.storeId,
              kind: "amount_mismatch",
              invoiceId: row.invoiceId,
              attemptId: row.id,
              providerPaymentId: paid.id,
              providerOrderId: row.providerOrderId,
              expectedPaise: row.amountPaise,
              observedPaise: paid.amount,
              detail: {
                note: "captured amount differs from the attempt",
                ...(row.storeId ? {} : { storeDeleted: true }),
              },
              now,
            });
            summary.flagged += 1;
          }
        }
        continue;
      }

      // ── No captured payment at the gateway ──────────────────────────────
      // ★★ AN AUTOMATIC DEBIT THE GATEWAY ITSELF REPORTS FAILED IS FAILED NOW
      // (21 Nov 2026). The renewal pass creates exactly one payment on each
      // order it charges, and nothing else can pay that order, so when every
      // payment on it reads `failed` the bank has said no and nothing can
      // still land. This used to be read only as "not captured" and waited
      // the full 72 hours, which held the next try and the grace clock back
      // three days for every debit declined after the call returned.
      // ⚠ NEVER for a manual checkout: its order stays payable, and a failed
      // try in the Razorpay window is routinely followed by one that works.
      const declined =
        row.mode === "automatic" &&
        res.data.length > 0 &&
        res.data.every((payment) => payment.status === "failed");
      // ★ AND ONE WHOSE ORDER NEVER GOT A PAYMENT AT ALL is over after a few
      // hours, not three days (see AUTO_NO_PAYMENT_FAIL_AFTER_HOURS): until it
      // is, the merchant cannot pay the invoice by hand either.
      const neverSent =
        row.mode === "automatic" &&
        res.data.length === 0 &&
        new Date(row.createdAt).getTime() < autoEmptyFailBefore;
      if (
        declined ||
        neverSent ||
        new Date(row.createdAt).getTime() < failBefore
      ) {
        // Declined, or old enough that a payment landing now would be
        // extraordinary and the gateway has told us there is none. Free the
        // invoice.
        const settled = await settleAttempt(row.id, "failed", {
          failureCode: declined ? "gateway_failed" : "reconciled_no_payment",
          failureReason: declined
            ? "the gateway reports the debit failed"
            : neverSent
              ? `no payment on the order after ${AUTO_NO_PAYMENT_FAIL_AFTER_HOURS}h`
              : `no captured payment after ${FAIL_AFTER_HOURS}h`,
          now,
        });
        if (settled === null || settled === "failed") summary.failed += 1;
        // ★ When that was the last automatic try, ask the merchant to pay by
        // hand. Only on a failure THIS call recorded (never one a concurrent
        // settle won), so it is said once; the announcement re-checks the
        // invoice and the count itself.
        if (settled === "failed" && row.mode === "automatic" && row.storeId) {
          await announceAutopayStopped({
            storeId: row.storeId,
            invoiceId: row.invoiceId,
            now,
          });
        }
        continue;
      }

      // Still inside the window: it may yet land. Say nothing, change nothing.
      summary.stillUnknown += 1;
    } catch (err) {
      logError("billing.reconcile.one", err, { attemptId: row.id });
      summary.errors += 1;
    }
  }

  // ★★ THEN THE ATTEMPTS THAT NEVER GOT A GATEWAY ORDER (21 Nov 2026). The
  // scan above asks about an attempt by its order id, so one with no order
  // was never looked at again. That happens when starting a payment timed out
  // (the attempt is left `unknown`) or the request died between opening the
  // attempt and creating the order (`created`): the invoice then read
  // `processing` for ever, so the cycle turn waited on it indefinitely and the
  // store kept a plan nobody was paying for; a `created` one also answered
  // "a payment is already in progress" to every later Pay. No order id was
  // ever handed to a browser or recorded for a debit, so no money can move on
  // such an attempt: after the stale window it is simply over.
  await closeOrderlessAttempts({ staleBefore, now, summary });

  // ★★ THEN FINISH WHAT WAS PAID BUT NEVER CONFIRMED (RC-F1b). A capture found
  // above (or on an earlier pass) for an enrolment, a plan change or a
  // location purchase lands on a DRAFT invoice, because only the browser's
  // confirm used to issue it and apply the purchase. A merchant who closed the
  // tab was left on their old plan with their money recorded and nothing
  // sent. This runs in the same hourly request, before pass 2's grace and
  // downgrade decisions, as reconciliation always has.
  await completeRecoveredPurchases({
    creds,
    fetchPayments,
    now,
    staleBefore,
    summary,
  });

  return summary;
}

/**
 * Close stranded attempts that never got a gateway order.
 *
 * Each is settled `failed` through `settleAttempt`, the same conditional claim
 * every other settle uses, so an attempt that gains its order in the same
 * moment (it would no longer be `created` or `unknown` with a null order) is
 * left to the claim's own check. An AUTOMATIC one that was the invoice's last
 * try asks the merchant to pay by hand, like any other failed debit.
 */
async function closeOrderlessAttempts(input: {
  staleBefore: string;
  now: Date;
  summary: ReconcileSummary;
}): Promise<void> {
  let rows: {
    id: string;
    storeId: string | null;
    invoiceId: string;
    mode: string;
  }[];
  try {
    rows = await withService((db) =>
      db
        .select({
          id: billingPaymentAttempts.id,
          storeId: billingPaymentAttempts.storeId,
          invoiceId: billingPaymentAttempts.invoiceId,
          mode: billingPaymentAttempts.mode,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            inArray(billingPaymentAttempts.state, IN_FLIGHT),
            lt(billingPaymentAttempts.createdAt, input.staleBefore),
            isNull(billingPaymentAttempts.providerOrderId),
            // Never one a payment id was recorded on: that is money to look
            // for, not an attempt that went nowhere.
            isNull(billingPaymentAttempts.providerPaymentId),
          ),
        )
        .orderBy(asc(billingPaymentAttempts.createdAt))
        .limit(ORDERLESS_BATCH),
    );
  } catch (err) {
    logError("billing.reconcile.orderless_scan", err);
    input.summary.errors += 1;
    return;
  }

  for (const row of rows) {
    try {
      const settled = await settleAttempt(row.id, "failed", {
        failureCode: "no_gateway_order",
        failureReason: "the payment was never started at the gateway",
        now: input.now,
      });
      if (settled !== "failed") continue;
      input.summary.orderless += 1;
      logInfo("billing.reconcile.orderless_closed", {
        attemptId: row.id,
        storeId: row.storeId,
        invoiceId: row.invoiceId,
      });
      if (row.mode === "automatic" && row.storeId) {
        await announceAutopayStopped({
          storeId: row.storeId,
          invoiceId: row.invoiceId,
          now: input.now,
        });
      }
    } catch (err) {
      logError("billing.reconcile.orderless_one", err, { attemptId: row.id });
      input.summary.errors += 1;
    }
  }
}

/**
 * Finish every recovered purchase this pass can: a captured attempt older
 * than the stale window on a draft subscription or add-on invoice of a store
 * that exists, not already held by a person.
 *
 * ★ Each goes through the SAME completion its browser confirm uses, which
 * re-checks the capture with the gateway (amount and currency must equal the
 * attempt's) and every guard; a failed guard is filed for a person by the
 * completion itself, never applied and never refunded here.
 */
async function completeRecoveredPurchases(input: {
  creds: NonNullable<ReturnType<typeof getPlatformRazorpayCreds>>;
  fetchPayments: typeof rzpFetchOrderPayments;
  now: Date;
  staleBefore: string;
  summary: ReconcileSummary;
}): Promise<void> {
  const { summary } = input;
  const found = await capturedDraftPurchases({
    createdBefore: input.staleBefore,
    excludeHeld: true,
    limit: 50,
  });
  if (found === null) {
    summary.errors += 1;
    return;
  }
  for (const purchase of found) {
    try {
      const status = await completeOne(purchase, input);
      if (status === "completed" || status === "already_complete") {
        summary.completed += 1;
        logInfo("billing.reconcile.purchase_completed", {
          attemptId: purchase.attemptId,
          storeId: purchase.storeId,
          invoiceId: purchase.invoiceId,
          outcome: status,
        });
      } else if (status === "refused") {
        summary.flagged += 1;
      } else {
        // not_ready / not_captured: nothing changed; the next pass looks again.
        summary.stillUnknown += 1;
      }
    } catch (err) {
      logError("billing.reconcile.purchase_one", err, {
        attemptId: purchase.attemptId,
      });
      summary.errors += 1;
    }
  }
}

/** Dispatch one recovered purchase to its kind's completion. */
async function completeOne(
  purchase: CapturedDraftPurchase,
  input: {
    creds: NonNullable<ReturnType<typeof getPlatformRazorpayCreds>>;
    fetchPayments: typeof rzpFetchOrderPayments;
    now: Date;
  },
): Promise<string> {
  // ★ The capture's own time goes into the issue (GST: a draft issued late
  // reads its tax terms when the merchant paid, not when we noticed), read
  // from the same answer the completion checks the capture against.
  const order = await readOrderOnce(
    input.creds,
    purchase.providerOrderId,
    input.fetchPayments,
  );
  const common = {
    storeId: purchase.storeId,
    invoiceId: purchase.invoiceId,
    attemptId: purchase.attemptId,
    providerPaymentId: null,
    source: "recovery" as const,
    verifyCapture: true,
    fetchOrderPayments: order.fetchOrderPayments,
    paidAt: order.paidAt,
    now: input.now,
  };
  if (purchase.kind === "subscription") {
    return (await completeEnrolmentPurchase(common)).status;
  }
  // An add-on invoice is a plan change or a location purchase; the order the
  // server created says which.
  const target = await readAddonOrderTarget(
    input.creds,
    purchase.providerOrderId,
  );
  if (!target) return "not_ready";
  if (target.kind === "plan_change") {
    return (
      await completePlanChangePurchase({
        ...common,
        target: { plan: target.plan, period: target.period },
      })
    ).status;
  }
  if (target.kind === "locations") {
    return (await completeLocationPurchase(common)).status;
  }
  await fileRecoveredPurchase({
    storeId: purchase.storeId,
    kind: "state_conflict",
    repairKey: `purchase_refused:${purchase.attemptId}`,
    note: "Payment captured on an add-on order that names neither a plan change nor locations. Check what it bought, then apply it by hand or refund it.",
    invoiceId: purchase.invoiceId,
    attemptId: purchase.attemptId,
    providerPaymentId: purchase.providerPaymentId,
    providerOrderId: purchase.providerOrderId,
    expectedPaise: purchase.amountPaise,
    purchase: "unknown",
    now: input.now,
  });
  return "refused";
}

/**
 * Read an order's payments once for a completion.
 *
 * ★ ONE READ, SHARED. The completion re-checks the capture with the gateway;
 * reading the order here first gives the capture's time and hands the
 * completion the same answer, so the gateway is asked once, not twice. A read
 * that fails is not shared: the completion asks again itself and decides,
 * exactly as it did before (an unreadable gateway is `not_ready`).
 */
async function readOrderOnce(
  creds: NonNullable<ReturnType<typeof getPlatformRazorpayCreds>>,
  orderId: string,
  fetchPayments: typeof rzpFetchOrderPayments,
): Promise<{
  fetchOrderPayments: typeof rzpFetchOrderPayments;
  paidAt: Date | undefined;
}> {
  let answer: Awaited<ReturnType<typeof rzpFetchOrderPayments>>;
  try {
    answer = await fetchPayments(creds, orderId);
  } catch {
    return { fetchOrderPayments: fetchPayments, paidAt: undefined };
  }
  if (!answer.ok) {
    return { fetchOrderPayments: fetchPayments, paidAt: undefined };
  }
  const shared: typeof rzpFetchOrderPayments = async (c, id) =>
    id === orderId ? answer : fetchPayments(c, id);
  const paid = capturedPayment(answer.data);
  return {
    fetchOrderPayments: shared,
    paidAt: (paid && gatewayCreatedAt(paid)) || undefined,
  };
}

// ---------------------------------------------------------------------------
// The repair pass: a captured payment's invoice left as a draft (GST design
// 5.4b, rewritten around RC-F1 and RC-F1b).
// ---------------------------------------------------------------------------

/**
 * How long a captured payment's draft waits before the repair pass touches
 * it. ★ The browser's confirm and the completion above (every pass, from 15
 * minutes) get the first chance to issue it AND apply the purchase; the pass
 * is what is left when neither did.
 */
export const CAPTURED_DRAFT_WAIT_MINUTES = 60;

/**
 * How long a captured payment's draft may stay unissued before the pass logs
 * it as an ERROR (R1-14). Until then each hourly pass retries it and logs a
 * WARNING: the commonest causes (Razorpay unreadable for a while, a read that
 * failed) heal on their own, and an ERROR every pass pages for a blip. Past
 * this, about six retries have failed and a person should look.
 */
export const UNISSUED_ALERT_AFTER_HOURS = 6;

/**
 * WARNING while the capture is younger than `UNISSUED_ALERT_AFTER_HOURS`,
 * ERROR after it, and ERROR when the capture time is unknown (nothing to
 * measure a wait against). Exported for its test.
 */
export function unissuedSeverity(
  capturedAt: string | null,
  now: Date,
): { level: "warn" | "error"; waitedHours: number | null } {
  const at = capturedAt ? Date.parse(capturedAt) : Number.NaN;
  if (!Number.isFinite(at)) return { level: "error", waitedHours: null };
  const waitedHours = Math.floor(((now.getTime() - at) / 3_600_000) * 10) / 10;
  return {
    level: waitedHours >= UNISSUED_ALERT_AFTER_HOURS ? "error" : "warn",
    waitedHours,
  };
}

/** `billing.captured_draft_unissued`, at the level `unissuedSeverity` says. */
function logUnissued(
  reason: string,
  capturedAt: string | null,
  now: Date,
  fields: Record<string, string | number | null>,
): void {
  const { level, waitedHours } = unissuedSeverity(capturedAt, now);
  if (level === "warn") {
    logWarn("billing.captured_draft_unissued", {
      ...fields,
      reason,
      waitedHours,
    });
    return;
  }
  logError("billing.captured_draft_unissued", new Error(reason), {
    ...fields,
    waitedHours,
  });
}

/** At most this many of each kind a pass, oldest first. */
export const CAPTURED_DRAFT_BATCH = 100;

/** The reconciliation key prefix of an item this pass files (Stage 11's
 *  queue copy is `CAPTURED_DRAFT_REPAIR`). */
export const CAPTURED_DRAFT_KEY_PREFIX = "captured_draft:";

export interface CapturedDraftsSummary {
  /** Drafts the pass looked at. */
  considered: number;
  /** Drafts this pass issued itself: the completion declined, a person
   *  already holds the payment, a credit pack, or one store's repair. */
  issued: number;
  /** Finished by the purchase's own completion (RC-F1b): issued, paid and
   *  applied. */
  completed: number;
  /** `captured_draft:` items filed for a person. */
  filed: number;
  /** Left for the next pass because the completion was not ready (the
   *  gateway, a read); each is also counted in `unissued`. */
  deferred: number;
  /** Still a draft when the pass finished with it; each logged as
   *  `billing.captured_draft_unissued` (a warning for its first
   *  `UNISSUED_ALERT_AFTER_HOURS`, an error after). */
  unissued: number;
  errors: number;
  /** A batch came back full: more may be waiting. */
  more: boolean;
}

export interface CapturedDraftsDeps {
  now?: Date;
  /**
   * One store's drafts, with no wait, issued only and never completed
   * (deleteStore repairs a store's drafts before it removes the store).
   */
  storeId?: string;
  limit?: number;
  /** Injected so tests need no gateway. */
  fetchOrderPayments?: typeof rzpFetchOrderPayments;
  fetchPayment?: typeof rzpFetchPayment;
}

/** A subscription or add-on draft behind a captured attempt. */
interface PurchaseDraft {
  attemptId: string;
  invoiceId: string;
  storeId: string;
  kind: "subscription" | "addon";
  providerOrderId: string | null;
  providerPaymentId: string | null;
  amountPaise: number;
  currency: string;
  createdAt: string;
  resolvedAt: string | null;
  /** A person already holds this payment (the completion's own rule). */
  held: boolean;
}

/** A credit pack paid for whose receipt is still a draft. */
interface CreditDraft {
  purchaseId: string;
  invoiceId: string;
  storeId: string;
  rzpPaymentId: string | null;
  updatedAt: string;
}

/**
 * Issue every draft invoice behind money already taken (GST design 5.4b as
 * rewritten in the plan's A4).
 *
 * Selected: a draft (`status = 'draft'`, never issued) with a `captured`
 * attempt resolved more than `CAPTURED_DRAFT_WAIT_MINUTES` ago, or a credit
 * pack whose purchase is `paid`, oldest first, `CAPTURED_DRAFT_BATCH` of
 * each. With `storeId`, that store's only and with no wait.
 *
 * ★★ THE PURCHASE'S OWN COMPLETION FIRST. A subscription or add-on draft goes
 * to the completion reconcile uses (enrolment, plan change or locations),
 * which issues it, settles it and applies what was bought. Only when it
 * declines (its guards: it filed the case for a person), or a person already
 * holds the payment, does this pass issue the draft by itself
 * (`issueInvoice` at the capture's time, then `settleAttempt` with
 * `notify: false`, which makes it paid without a receipt, R1-04), never
 * applying a plan or a location, and
 * files one `captured_draft:` item unless the payment already has one open.
 * A completion that is not ready (the gateway or a read failed) changes
 * nothing and is asked again next pass: issuing the draft alone would take it
 * out of every completion's reach, since completions only finish drafts.
 *
 * ★ With `storeId` (a store about to be deleted) the draft is issued only,
 * never completed: there is no store left to apply a purchase to.
 *
 * ★ A credit pack's receipt is issued straight to paid (the credits were
 * granted when the purchase was paid).
 *
 * Never throws; a failed draft is counted and the rest go on.
 */
export async function issueCapturedDrafts(
  deps: CapturedDraftsDeps = {},
): Promise<CapturedDraftsSummary> {
  const now = deps.now ?? new Date();
  const limit = deps.limit ?? CAPTURED_DRAFT_BATCH;
  const summary: CapturedDraftsSummary = {
    considered: 0,
    issued: 0,
    completed: 0,
    filed: 0,
    deferred: 0,
    unissued: 0,
    errors: 0,
    more: false,
  };
  const ctx: DraftContext = {
    now,
    storeId: deps.storeId ?? null,
    creds: getPlatformRazorpayCreds(),
    fetchOrderPayments: deps.fetchOrderPayments ?? rzpFetchOrderPayments,
    fetchPayment: deps.fetchPayment ?? rzpFetchPayment,
    summary,
  };

  let found: { purchases: PurchaseDraft[]; credits: CreditDraft[] };
  try {
    found = await withService(async (db) => {
      const purchases = await db
        .select({
          attemptId: billingPaymentAttempts.id,
          invoiceId: billingPaymentAttempts.invoiceId,
          storeId: billingPaymentAttempts.storeId,
          kind: billingInvoices.kind,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          providerPaymentId: billingPaymentAttempts.providerPaymentId,
          amountPaise: billingPaymentAttempts.amountPaise,
          currency: billingPaymentAttempts.currency,
          createdAt: billingPaymentAttempts.createdAt,
          resolvedAt: billingPaymentAttempts.resolvedAt,
          // The completion's own rule (`capturedDraftPurchases`, held).
          held: sql<boolean>`exists (
            select 1 from public.billing_reconciliation_items r
             where r.attempt_id = ${billingPaymentAttempts.id}
               and (r.status in ('open', 'manual_review')
                    or r.detail->>'repair_key' in (
                      'purchase_refused:' || ${billingPaymentAttempts.id}::text,
                      'purchase_unapplied:' || ${billingPaymentAttempts.id}::text)))`,
        })
        .from(billingPaymentAttempts)
        .innerJoin(
          billingInvoices,
          eq(billingInvoices.id, billingPaymentAttempts.invoiceId),
        )
        .where(capturedDraftsWhere(ctx))
        .orderBy(asc(billingPaymentAttempts.resolvedAt))
        .limit(limit);
      const credits = await db
        .select({
          purchaseId: aiCreditPurchases.id,
          invoiceId: aiCreditPurchases.invoiceId,
          storeId: aiCreditPurchases.storeId,
          rzpPaymentId: aiCreditPurchases.rzpPaymentId,
          updatedAt: aiCreditPurchases.updatedAt,
        })
        .from(aiCreditPurchases)
        .innerJoin(
          billingInvoices,
          eq(billingInvoices.id, aiCreditPurchases.invoiceId),
        )
        .where(creditDraftsWhere(ctx))
        .orderBy(asc(aiCreditPurchases.updatedAt))
        .limit(limit);
      return {
        purchases: purchases.map((row) => ({
          ...row,
          storeId: row.storeId as string,
          kind:
            row.kind === "addon"
              ? ("addon" as const)
              : ("subscription" as const),
          held: row.held === true,
        })),
        credits: credits.map((row) => ({
          ...row,
          invoiceId: row.invoiceId as string,
        })),
      };
    });
  } catch (err) {
    logError("billing.captured_draft.scan", err, {
      storeId: ctx.storeId,
    });
    summary.errors += 1;
    return summary;
  }
  summary.more =
    found.purchases.length >= limit || found.credits.length >= limit;

  for (const draft of found.purchases) {
    summary.considered += 1;
    try {
      await repairPurchaseDraft(draft, ctx);
    } catch (err) {
      logError("billing.captured_draft.one", err, {
        invoiceId: draft.invoiceId,
        attemptId: draft.attemptId,
      });
      summary.errors += 1;
    }
  }
  for (const draft of found.credits) {
    summary.considered += 1;
    try {
      await repairCreditDraft(draft, ctx);
    } catch (err) {
      logError("billing.captured_draft.one", err, {
        invoiceId: draft.invoiceId,
        purchaseId: draft.purchaseId,
      });
      summary.errors += 1;
    }
  }
  return summary;
}

interface DraftContext {
  now: Date;
  storeId: string | null;
  creds: ReturnType<typeof getPlatformRazorpayCreds>;
  fetchOrderPayments: typeof rzpFetchOrderPayments;
  fetchPayment: typeof rzpFetchPayment;
  summary: CapturedDraftsSummary;
}

/** Older than this, a capture's draft is the pass's (absent with `storeId`). */
function waitCutoff(ctx: { now: Date; storeId: string | null }): string | null {
  return ctx.storeId
    ? null
    : new Date(
        ctx.now.getTime() - CAPTURED_DRAFT_WAIT_MINUTES * 60_000,
      ).toISOString();
}

/**
 * Which subscription and add-on drafts the pass takes: never issued, behind
 * a captured attempt of the same (existing) store, resolved before the wait,
 * or one store's with no wait. Exported for the test that reads the query.
 */
export function capturedDraftsWhere(ctx: {
  now: Date;
  storeId: string | null;
}) {
  const cutoff = waitCutoff(ctx);
  return and(
    eq(billingPaymentAttempts.state, "captured"),
    eq(billingInvoices.status, "draft"),
    isNull(billingInvoices.finalizedAt),
    inArray(billingInvoices.kind, ["subscription", "addon"]),
    isNotNull(billingPaymentAttempts.storeId),
    eq(billingInvoices.storeId, billingPaymentAttempts.storeId),
    ctx.storeId
      ? eq(billingPaymentAttempts.storeId, ctx.storeId)
      : lt(billingPaymentAttempts.resolvedAt, cutoff as string),
  );
}

/** Which credit-pack receipts the pass takes (exported for the same test). */
export function creditDraftsWhere(ctx: { now: Date; storeId: string | null }) {
  const cutoff = waitCutoff(ctx);
  return and(
    eq(aiCreditPurchases.status, "paid"),
    eq(billingInvoices.status, "draft"),
    isNull(billingInvoices.finalizedAt),
    eq(billingInvoices.kind, "ai_credits"),
    ctx.storeId
      ? eq(aiCreditPurchases.storeId, ctx.storeId)
      : lt(aiCreditPurchases.updatedAt, cutoff as string),
  );
}

/** One subscription or add-on draft: completion first, else issued alone. */
async function repairPurchaseDraft(
  draft: PurchaseDraft,
  ctx: DraftContext,
): Promise<void> {
  const tryCompletion =
    ctx.storeId === null && !draft.held && draft.providerOrderId !== null;
  if (tryCompletion) {
    if (!ctx.creds) {
      ctx.summary.deferred += 1;
      reportUnissued(draft, ctx, "no gateway credentials to finish it");
      return;
    }
    const status = await completeOne(
      {
        attemptId: draft.attemptId,
        invoiceId: draft.invoiceId,
        storeId: draft.storeId,
        kind: draft.kind,
        providerOrderId: draft.providerOrderId as string,
        providerPaymentId: draft.providerPaymentId,
        amountPaise: draft.amountPaise,
        currency: draft.currency,
        createdAt: draft.createdAt,
      },
      {
        creds: ctx.creds,
        fetchPayments: ctx.fetchOrderPayments,
        now: ctx.now,
      },
    );
    if (status === "completed" || status === "already_complete") {
      ctx.summary.completed += 1;
      logInfo("billing.captured_draft.completed", {
        invoiceId: draft.invoiceId,
        attemptId: draft.attemptId,
        storeId: draft.storeId,
        outcome: status,
      });
      return;
    }
    if (status === "not_ready") {
      // Nothing changed; the completion is asked again next pass.
      ctx.summary.deferred += 1;
      reportUnissued(draft, ctx, "its completion was not ready");
      return;
    }
    if (status === "not_captured") {
      // The settle says the payment did not complete: not a captured
      // payment's invoice any more, so nothing to issue here.
      logInfo("billing.captured_draft.not_captured", {
        invoiceId: draft.invoiceId,
        attemptId: draft.attemptId,
      });
      return;
    }
    // `refused`: its guards declined and it filed the case for a person.
  }
  await issueAlone(draft, ctx);
}

/**
 * Issue a declined (or held, or one store's) draft by itself, settle it, and
 * file it for a person. ★ Never applies a plan or a location.
 */
async function issueAlone(
  draft: PurchaseDraft,
  ctx: DraftContext,
): Promise<void> {
  const paidAt = await captureTime(
    ctx,
    draft.providerPaymentId,
    draft.resolvedAt,
  );
  const result = await issueInvoice({
    invoiceId: draft.invoiceId,
    now: ctx.now,
    paidAt,
  });
  if (!result.invoice?.finalizedAt) {
    reportUnissued(draft, ctx, "the invoice could not be issued");
    return;
  }
  if (result.claimed) ctx.summary.issued += 1;

  // ★ The capture is recorded already, so this changes nothing on the attempt
  // and re-runs the invoice sync (RC-F1): open becomes paid.
  //
  // ★★ WITH NO RECEIPT (R1-04). This pass issues a purchase alone exactly when
  // its own completion DECLINED it or a person already holds the payment, so
  // nothing was applied. The standard receipt says "Payment received. Your
  // plan is active", naming the current plan, which is untrue here; a person
  // is checking it and writes to the merchant.
  const settled = await settleAttempt(draft.attemptId, "captured", {
    now: ctx.now,
    notify: false,
  });
  if (settled === null) ctx.summary.errors += 1;

  // Someone else issued it (a confirm, or the completion on its way out):
  // their path owns the purchase and its record.
  if (!result.claimed) return;
  logInfo("billing.captured_draft.issued", {
    invoiceId: draft.invoiceId,
    attemptId: draft.attemptId,
    storeId: draft.storeId,
    restamp: result.restamp,
  });

  // ★ One item per payment: none when RC-F1b (or anyone) already holds it.
  if (await paymentAlreadyHeld(draft)) return;
  const filed = await fileRecoveredPurchase({
    storeId: draft.storeId,
    kind: "state_conflict",
    repairKey: `${CAPTURED_DRAFT_KEY_PREFIX}${draft.invoiceId}`,
    note: CAPTURED_DRAFT_REPAIR.detail,
    invoiceId: draft.invoiceId,
    attemptId: draft.attemptId,
    providerPaymentId: draft.providerPaymentId,
    providerOrderId: draft.providerOrderId,
    expectedPaise: draft.amountPaise,
    purchase: await purchaseKind(draft, ctx),
    now: ctx.now,
  });
  if (filed) ctx.summary.filed += 1;
}

/** A credit pack's receipt, issued straight to paid. */
async function repairCreditDraft(
  draft: CreditDraft,
  ctx: DraftContext,
): Promise<void> {
  const paidAt = await captureTime(ctx, draft.rzpPaymentId, draft.updatedAt);
  const result = await issueInvoice({
    invoiceId: draft.invoiceId,
    now: ctx.now,
    paid: true,
    paidAt,
  });
  if (!result.invoice?.finalizedAt) {
    ctx.summary.unissued += 1;
    logUnissued(
      "the credit pack's invoice could not be issued",
      draft.updatedAt,
      ctx.now,
      {
        invoiceId: draft.invoiceId,
        purchaseId: draft.purchaseId,
        storeId: draft.storeId,
      },
    );
    return;
  }
  if (result.claimed) {
    ctx.summary.issued += 1;
    logInfo("billing.captured_draft.issued", {
      invoiceId: draft.invoiceId,
      purchaseId: draft.purchaseId,
      storeId: draft.storeId,
      restamp: result.restamp,
    });
  }
}

/**
 * ★ A captured payment's invoice still a draft after the pass (A4.7). The
 * alert "Billing: a captured payment's invoice is still a draft" matches
 * this line AT ERROR: `billing.invoice_paid_claim_missed` also logs on a
 * closed-tab purchase that the completion then finishes, so it cannot be the
 * signal. ★ WARNING while it is retryable and young (R1-14): a gateway blip
 * defers it for a pass or two, and an ERROR every pass would page for it.
 */
function reportUnissued(
  draft: PurchaseDraft,
  ctx: DraftContext,
  reason: string,
): void {
  ctx.summary.unissued += 1;
  logUnissued(reason, draft.resolvedAt ?? draft.createdAt, ctx.now, {
    invoiceId: draft.invoiceId,
    attemptId: draft.attemptId,
    storeId: draft.storeId,
  });
}

/**
 * When the money was taken: the gateway payment's `created_at`, else our own
 * record of it (the attempt's `resolved_at`, the purchase's `updated_at`).
 */
async function captureTime(
  ctx: DraftContext,
  paymentId: string | null,
  fallback: string | null,
): Promise<Date | undefined> {
  if (ctx.creds && paymentId) {
    try {
      const res = await ctx.fetchPayment(ctx.creds, paymentId);
      const at = res.ok ? gatewayCreatedAt(res.data) : null;
      if (at) return at;
    } catch (err) {
      logError("billing.captured_draft.payment_read", err, { paymentId });
    }
  }
  if (!fallback) return undefined;
  const at = new Date(fallback);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * Does a person already have this payment (an open or in-review item about
 * the attempt or the payment)? ★ An unreadable answer is false: filing a
 * second item is a nuisance, a payment nobody is told about is not.
 */
async function paymentAlreadyHeld(draft: PurchaseDraft): Promise<boolean> {
  try {
    const rows = await withService(async (db) =>
      db
        .select({ id: billingReconciliationItems.id })
        .from(billingReconciliationItems)
        .where(
          and(
            inArray(billingReconciliationItems.status, [
              "open",
              "manual_review",
            ]),
            draft.providerPaymentId
              ? or(
                  eq(billingReconciliationItems.attemptId, draft.attemptId),
                  eq(
                    billingReconciliationItems.providerPaymentId,
                    draft.providerPaymentId,
                  ),
                )
              : eq(billingReconciliationItems.attemptId, draft.attemptId),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  } catch (err) {
    logError("billing.captured_draft.item_read", err, {
      attemptId: draft.attemptId,
    });
    return false;
  }
}

/** What the item says was bought: an add-on's order names it. */
async function purchaseKind(
  draft: PurchaseDraft,
  ctx: DraftContext,
): Promise<"enrolment" | "plan_change" | "locations" | "unknown"> {
  if (draft.kind === "subscription") return "enrolment";
  if (!ctx.creds || !draft.providerOrderId) return "unknown";
  const target = await readAddonOrderTarget(ctx.creds, draft.providerOrderId);
  if (target?.kind === "plan_change") return "plan_change";
  if (target?.kind === "locations") return "locations";
  return "unknown";
}

/**
 * Is this an ISSUED invoice that a plan end (or a downgrade) closed?
 *
 * ★ Issued as well as closed, the collect.ts rule: the refund guard refuses an
 * unissued invoice, so a capture on a draft (one deleteStore kept because its
 * payment was in flight) can only be returned by a person. ★ Read AFTER the
 * settle, so the answer describes the invoice the money landed on; an
 * unreadable invoice answers false, which files the item for a person.
 */
async function isClosedIssuedInvoice(invoiceId: string): Promise<boolean> {
  try {
    const [invoice] = await withService(async (db) =>
      db
        .select({
          status: billingInvoices.status,
          finalizedAt: billingInvoices.finalizedAt,
        })
        .from(billingInvoices)
        .where(eq(billingInvoices.id, invoiceId))
        .limit(1),
    );
    return (
      !!invoice?.finalizedAt &&
      (invoice.status === "void" || invoice.status === "uncollectible")
    );
  } catch (err) {
    logError("billing.reconcile.invoice_read", err, { invoiceId });
    return false;
  }
}

/**
 * Record something a human has to look at.
 *
 * ★ Deduped by `billing_reconciliation_one_open_per_payment` (partial unique on
 * kind + provider payment, where status = 'open'), so a sweep that re-runs every
 * hour cannot bury the queue it exists to surface. A conflict is the NORMAL case
 * on the second pass, not an error.
 */
async function flag(input: {
  storeId: string | null;
  kind:
    | "unknown_payment"
    | "orphan_payment"
    | "amount_mismatch"
    | "missing_webhook"
    | "state_conflict"
    | "wrong_association"
    | "credit_grant_failed";
  invoiceId?: string | null;
  attemptId?: string | null;
  providerPaymentId?: string | null;
  providerOrderId?: string | null;
  expectedPaise?: number | null;
  observedPaise?: number | null;
  detail?: Record<string, unknown>;
  now: Date;
}): Promise<void> {
  try {
    await withService(async (db) => {
      await db
        .insert(billingReconciliationItems)
        .values({
          storeId: input.storeId,
          kind: input.kind,
          status: "open",
          invoiceId: input.invoiceId ?? null,
          attemptId: input.attemptId ?? null,
          providerPaymentId: input.providerPaymentId ?? null,
          providerOrderId: input.providerOrderId ?? null,
          expectedPaise: input.expectedPaise ?? null,
          observedPaise: input.observedPaise ?? null,
          detail: input.detail ?? {},
          createdAt: input.now.toISOString(),
          updatedAt: input.now.toISOString(),
        })
        .onConflictDoNothing();
    });
  } catch (err) {
    // Best-effort: failing to FLAG something must never undo the settlement that
    // prompted it. The money is already recorded correctly.
    logError("billing.reconcile.flag", err, { kind: input.kind });
  }
}

/**
 * The operator queue.
 *
 * ★ Joins the store's name, because an item is useless without knowing WHOSE
 * money it is and a uuid is not that. A null `store_id` is legitimate — an
 * orphan gateway payment that maps to no store yet is exactly the kind of thing
 * that needs a human.
 */
export async function listReconciliationItems(
  input: {
    status?: "open" | "resolved" | "manual_review" | "ignored";
    limit?: number;
  } = {},
): Promise<ReconciliationItem[]> {
  const status = input.status ?? "open";
  try {
    return await withService(async (db) =>
      db
        .select({
          id: billingReconciliationItems.id,
          storeId: billingReconciliationItems.storeId,
          storeName: stores.name,
          storeSlug: stores.slug,
          kind: billingReconciliationItems.kind,
          status: billingReconciliationItems.status,
          invoiceId: billingReconciliationItems.invoiceId,
          attemptId: billingReconciliationItems.attemptId,
          providerPaymentId: billingReconciliationItems.providerPaymentId,
          providerOrderId: billingReconciliationItems.providerOrderId,
          expectedPaise: billingReconciliationItems.expectedPaise,
          observedPaise: billingReconciliationItems.observedPaise,
          detail: billingReconciliationItems.detail,
          resolvedBy: billingReconciliationItems.resolvedBy,
          resolvedAt: billingReconciliationItems.resolvedAt,
          resolutionNote: billingReconciliationItems.resolutionNote,
          createdAt: billingReconciliationItems.createdAt,
        })
        .from(billingReconciliationItems)
        .leftJoin(stores, eq(stores.id, billingReconciliationItems.storeId))
        .where(eq(billingReconciliationItems.status, status))
        .orderBy(desc(billingReconciliationItems.createdAt))
        .limit(input.limit ?? 100),
    );
  } catch (err) {
    logError("billing.reconcile.list", err);
    return [];
  }
}

/** How many need a human right now — for a nav badge. */
export async function countOpenReconciliationItems(): Promise<number> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({ n: count() })
        .from(billingReconciliationItems)
        .where(eq(billingReconciliationItems.status, "open"));
      return row?.n ?? 0;
    });
  } catch (err) {
    // ★ Fails to ZERO. A badge is a courtesy; a blip must cost the number, not
    // the page it sits on (the §22 pickup-count rule).
    logError("billing.reconcile.count", err);
    return 0;
  }
}

/**
 * Close an item.
 *
 * ★★ THIS MOVES NO MONEY, AND THAT IS THE WHOLE POINT. It records that a human
 * looked and what they decided — nothing else. An amount mismatch is closed by
 * refunding the difference, or issuing a credit, or deciding it does not matter;
 * all of those happen elsewhere, deliberately, by someone who chose them. A
 * button here that "fixed" a discrepancy would be a money movement nobody
 * reviewed.
 *
 * ★ A CONDITIONAL CLAIM on `open`, so two operators working the queue cannot
 * both close the same item and overwrite each other's note.
 */
export async function resolveReconciliationItem(input: {
  id: string;
  status: "resolved" | "manual_review" | "ignored";
  note: string;
  actor: string | null;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = input.now ?? new Date();
  const note = input.note.trim().slice(0, 1000);
  // ★ A reason is REQUIRED. "Resolved" with no note is indistinguishable from
  // someone clearing a queue they did not read, and this is the audit trail for
  // a money discrepancy.
  if (!note) {
    return {
      ok: false,
      error: "Say what you found - this is the audit trail.",
    };
  }
  try {
    const claimed = await withService(async (db) =>
      db
        .update(billingReconciliationItems)
        .set({
          status: input.status,
          resolvedBy: input.actor,
          // ★★ ONLY A RESOLVED ITEM HAS A RESOLVED_AT. The CHECK
          // billing_reconciliation_resolved_shape requires (status =
          // 'resolved') = (resolved_at is not null), so stamping it on "Needs
          // chasing" or "Doesn't matter" failed every such close with
          // "Couldn't save that". Who is resolved_by; when is updated_at.
          resolvedAt: input.status === "resolved" ? now.toISOString() : null,
          resolutionNote: note,
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(billingReconciliationItems.id, input.id),
            // ⚠ TEST GAP: the db mock does not evaluate WHERE clauses, so
            // removing this predicate fails no test. What IS covered is the
            // behaviour that depends on it — a claim returning zero rows is
            // reported as "someone else already closed that one" rather than as
            // success.
            eq(billingReconciliationItems.status, "open"),
          ),
        )
        .returning({ id: billingReconciliationItems.id }),
    );
    if (claimed.length === 0) {
      return { ok: false, error: "Someone else already closed that one." };
    }
    logInfo("billing.reconcile.resolved", {
      id: input.id,
      status: input.status,
      by: input.actor,
    });
    return { ok: true };
  } catch (err) {
    logError("billing.reconcile.resolve", err, { id: input.id });
    return { ok: false, error: "Couldn't save that. Please try again." };
  }
}
