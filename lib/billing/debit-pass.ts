import "server-only";

/**
 * STEP 2 of an automatic renewal: send the debit of each notified order whose
 * notice period has passed.
 *
 * ★★ WHY THIS IS ITS OWN PASS (21 Nov 2026). Razorpay accepts a renewal debit
 * only for an order created with a pre-debit notification, and only once the
 * notice period has passed since the customer was sent it (36 hours 5 minutes
 * for a card, 25 hours for UPI). The collect pass creates that order
 * (`collectInvoice`, step 1) and records `debit_after` on the attempt; this
 * pass, run by the same hourly job, comes back for it.
 *
 * ★★ ONE ATTEMPT, AT MOST ONE DEBIT. The debit call is preceded by a
 * conditional UPDATE that sets `debit_sent_at` only while it is null. Two
 * workers, a retried cron request or a crash and restart cannot both win it,
 * so the debit is sent once or not at all. A worker that dies between the
 * claim and the call leaves an attempt marked sent with no payment on its
 * order: reconciliation sees that and fails it after a few hours, and the
 * retry rule opens a fresh attempt with a fresh notice.
 *
 * Before each debit, in this order, and each one can stop it:
 *   1. the invoice is still owed (a plan that ended closes it), and its cycle
 *      is one the store will enter (a plan being cancelled will not);
 *   2. StoreMink's record of the mandate is still `active` (the merchant may
 *      have cancelled since the notice went out);
 *   3. the gateway says the mandate is still chargeable (`verifyMandate`);
 *   4. the gateway says the notice was delivered and its period has passed
 *      (`readNotice`).
 * A check the gateway could not answer stops THIS run only: nothing is
 * decided, nothing is written, and the next run asks again.
 *
 * ★★ ENDING AN ATTEMPT WITHOUT DEBITING IT IS A GUARDED WRITE TOO. Checks 1
 * to 4 can each close the attempt (`cancelled`, `failed`), and a closed
 * attempt never reopens: a capture that arrived afterwards would be ignored.
 * Two runs overlap (a retried cron request), and the one that read the row
 * later may see a cancelled plan where the first saw a live one. So every
 * such write moves the attempt only while `debit_sent_at` is still null
 * (`settleAttempt`'s `onlyIfUnsent`): once another run has claimed the debit,
 * this one changes nothing and the outcome is read from the gateway.
 */

import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  billingInvoices,
  billingMandates,
  billingPaymentAttempts,
  billingSubscriptions,
} from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  mapGatewayStatus,
  settleAttempt,
  type MandateRail,
  type RecurringGateway,
} from "./collect";
import type { MandateStatus } from "./cycle";
import { earlierDebitsOf } from "./earlier-debits";
import { cycleRefusal } from "./manual-pay";
import { verifyMandate } from "./mandate-check";
import { advanceAfterPayment, announceAutopayStopped } from "./renewal-worker";

/** Attempts one pass will look at. */
export const DEBIT_BATCH = 50;

/**
 * How long past its debit time an attempt waits for a notice the gateway
 * still has not delivered, before it is given up as failed. In test mode
 * delivery took about a minute; a notice still undelivered half a day after
 * the debit was due is not coming.
 */
export const NOTICE_DELIVERY_DEADLINE_HOURS = 12;

/**
 * How long past its debit time an attempt waits on a gateway that will not
 * say whether the mandate stands or the notice period has passed, before the
 * try is given up as failed.
 *
 * ★★ WAITING MUST END. A notified attempt keeps its invoice `processing`, and
 * no grace opens on an invoice with a payment in flight, so an attempt that
 * waited for ever would keep the store on its plan for nothing. And "could
 * not be asked" can be permanent: Razorpay answers a deleted mandate with
 * "the id provided does not exist", which this code does not act on as a
 * verdict (see `collectOne`). After a day the try fails, the invoice reads as
 * unpaid again, and the ordinary path takes over: another try if one is left,
 * else the merchant is asked to pay by hand.
 */
export const GATEWAY_SILENCE_DEADLINE_HOURS = 24;

export interface DebitSummary {
  considered: number;
  /** Debits sent to the gateway this pass. */
  sent: number;
  /** Not yet: a notice period still running, or a gateway that did not answer. */
  waiting: number;
  /** Tries that ended here: refused by the gateway, or a mandate that is gone. */
  failed: number;
  /** Attempts withdrawn because their invoice or mandate no longer stands. */
  cancelled: number;
  errors: number;
}

interface DueDebit {
  id: string;
  storeId: string | null;
  invoiceId: string;
  amountPaise: number;
  idempotencyKey: string;
  providerOrderId: string | null;
  debitAfter: string | null;
  invoiceStatus: string;
  invoiceRef: string | null;
  invoiceCycleSeq: number | null;
  subState: string | null;
  subCycleSeq: number | null;
  subCancelling: boolean | null;
  mandateId: string | null;
  mandateStatus: string | null;
  mandateMaxPaise: number | null;
  providerTokenId: string | null;
  providerCustomerId: string | null;
  method: string | null;
}

/** An invoice a debit may still be sent for. */
const OWED = new Set(["open", "processing"]);

export async function sendDueDebits(input: {
  gateway: RecurringGateway;
  now?: Date;
  limit?: number;
}): Promise<DebitSummary> {
  const now = input.now ?? new Date();
  const summary: DebitSummary = {
    considered: 0,
    sent: 0,
    waiting: 0,
    failed: 0,
    cancelled: 0,
    errors: 0,
  };

  let due: DueDebit[];
  try {
    due = await withService((db) =>
      db
        .select({
          id: billingPaymentAttempts.id,
          storeId: billingPaymentAttempts.storeId,
          invoiceId: billingPaymentAttempts.invoiceId,
          amountPaise: billingPaymentAttempts.amountPaise,
          idempotencyKey: billingPaymentAttempts.idempotencyKey,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          debitAfter: billingPaymentAttempts.debitAfter,
          invoiceStatus: billingInvoices.status,
          invoiceRef: billingInvoices.invoiceRef,
          invoiceCycleSeq: billingInvoices.cycleSeq,
          subState: billingSubscriptions.state,
          subCycleSeq: billingSubscriptions.currentCycleSeq,
          subCancelling: billingSubscriptions.cancelAtPeriodEnd,
          mandateId: billingMandates.id,
          mandateStatus: billingMandates.status,
          mandateMaxPaise: billingMandates.maxAmountPaise,
          providerTokenId: billingMandates.providerTokenId,
          providerCustomerId: billingMandates.providerCustomerId,
          method: billingMandates.method,
        })
        .from(billingPaymentAttempts)
        .innerJoin(
          billingInvoices,
          eq(billingInvoices.id, billingPaymentAttempts.invoiceId),
        )
        .leftJoin(
          billingMandates,
          eq(billingMandates.id, billingPaymentAttempts.mandateId),
        )
        .leftJoin(
          billingSubscriptions,
          eq(billingSubscriptions.storeId, billingInvoices.storeId),
        )
        .where(
          and(
            eq(billingPaymentAttempts.mode, "automatic"),
            eq(billingPaymentAttempts.state, "processing"),
            isNotNull(billingPaymentAttempts.providerOrderId),
            isNotNull(billingPaymentAttempts.debitAfter),
            isNull(billingPaymentAttempts.debitSentAt),
            lte(billingPaymentAttempts.debitAfter, now.toISOString()),
          ),
        )
        // Longest due first, so nothing is left behind a full page.
        .orderBy(asc(billingPaymentAttempts.debitAfter))
        .limit(input.limit ?? DEBIT_BATCH),
    );
  } catch (err) {
    logError("billing.debit_pass.scan", err);
    summary.errors += 1;
    return summary;
  }

  for (const row of due) {
    summary.considered += 1;
    try {
      const outcome = await debitOne(row, input.gateway, now);
      summary[outcome] += 1;
    } catch (err) {
      logError("billing.debit_pass.one", err, { attemptId: row.id });
      summary.errors += 1;
    }
  }
  return summary;
}

type DebitOutcome = "sent" | "waiting" | "failed" | "cancelled";

async function debitOne(
  row: DueDebit,
  gateway: RecurringGateway,
  now: Date,
): Promise<DebitOutcome> {
  // ── 1. Is the invoice still owed? ─────────────────────────────────────────
  // A plan that ended since the notice went out closed its invoice (`void`,
  // `uncollectible`); debiting it would take money for a cycle not reached.
  if (!OWED.has(row.invoiceStatus) || !row.storeId) {
    return withdraw(
      row,
      "invoice_closed",
      "the invoice is no longer owed",
      now,
    );
  }
  // ★★ AND IS ITS CYCLE ONE THE STORE WILL ENTER? The same rule that refuses a
  // payment by hand (`cycleRefusal`): the next cycle's invoice while a
  // cancellation stands, or one above an ended plan's last cycle. Cancelling
  // revokes the mandate, which check 2 would catch, but that revoke is
  // best-effort; the cancellation itself is what must stop the debit.
  if (row.subState !== null && row.subCycleSeq !== null) {
    const refusal = cycleRefusal(
      {
        state: row.subState,
        currentCycleSeq: row.subCycleSeq,
        cancelAtPeriodEnd: row.subCancelling === true,
      },
      { cycleSeq: row.invoiceCycleSeq, issued: true },
    );
    if (refusal) {
      return withdraw(
        row,
        refusal === "cancelling" ? "plan_cancelled" : "cycle_unreachable",
        refusal === "cancelling"
          ? "the plan was cancelled before the debit"
          : "the store will not enter this invoice's cycle",
        now,
      );
    }
  }

  // ── 2. Does StoreMink still hold a live mandate for it? ───────────────────
  // Cancelling a plan revokes the mandate; a newer mandate retires this one.
  if (
    row.mandateStatus !== "active" ||
    !row.mandateId ||
    !row.providerTokenId ||
    !row.providerCustomerId ||
    !row.providerOrderId
  ) {
    return withdraw(
      row,
      "mandate_withdrawn",
      "the mandate was withdrawn before the debit",
      now,
    );
  }
  const rail = (row.method ?? "unknown") as MandateRail;

  // ── 3. Is the mandate still chargeable at the gateway? ────────────────────
  const verdict = await verifyMandate(
    {
      id: row.mandateId,
      status: row.mandateStatus as MandateStatus,
      maxAmountPaise: row.mandateMaxPaise,
      providerTokenId: row.providerTokenId,
      providerCustomerId: row.providerCustomerId,
      method: rail,
    },
    gateway,
    now,
  );
  if (verdict.result === "unknown") {
    return silentTooLong(row, now)
      ? failTry(
          row,
          "gateway_unreachable",
          "the gateway would not say whether the mandate still stands",
          now,
          { unsent: true },
        )
      : "waiting";
  }
  if (verdict.result === "unusable") {
    // The customer cancelled or paused it after the notice went out. This try
    // is over, and no later one can succeed: ask the merchant to pay by hand.
    const settled = await settleAttempt(row.id, "failed", {
      failureCode: "mandate_unusable",
      failureReason: `the mandate is ${verdict.reason} at the gateway`,
      onlyIfUnsent: true,
      now,
    });
    // Not ours to end: another run sent the debit, or the attempt moved on.
    if (settled !== "failed") return "waiting";
    // ★ SAID ONCE, BY THE CALL THAT RECORDED THE MANDATE AS UNUSABLE
    // (`verdict.changed`), as `announceAutopayStopped` documents and the
    // collect pass already does. This used to send whenever this attempt was
    // the one failed, so each invoice that met the same revoked mandate sent
    // the "autopay is no longer active" email again (PR #303 review).
    if (verdict.changed) {
      await announceAutopayStopped({
        storeId: row.storeId,
        invoiceId: row.invoiceId,
        cause: "mandate",
        now,
      });
    }
    return "failed";
  }

  // ── 4. Has the notice period passed, by the gateway's own record? ─────────
  const notice = await gateway.readNotice({
    providerOrderId: row.providerOrderId,
    rail,
    now,
  });
  if (notice.state === "unknown") {
    return silentTooLong(row, now)
      ? failTry(
          row,
          "gateway_unreachable",
          "the gateway would not say whether the notice period has passed",
          now,
          { unsent: true },
        )
      : "waiting";
  }
  if (notice.state === "wait") {
    // Remember the real time, so the scan leaves this attempt alone till then.
    await postpone(row.id, notice.until, now);
    return "waiting";
  }
  if (notice.state === "undelivered") {
    if (!overdueBy(row, NOTICE_DELIVERY_DEADLINE_HOURS, now)) return "waiting";
    logWarn("billing.debit_pass.notice_undelivered", {
      attemptId: row.id,
      storeId: row.storeId,
    });
    return failTry(
      row,
      "notice_undelivered",
      "the pre-debit notice was never delivered",
      now,
      { unsent: true },
    );
  }

  // ── 4b. Did an EARLIER debit of this invoice take the money after all? ────
  // ★★ PR #303 review, 22 Nov 2026 (lib/billing/earlier-debits.ts). A debit
  // Razorpay reported failed can be authorised late by the bank and captured.
  // This try was started a day or more ago, so the answer the collect pass
  // got then proves nothing now: asked again here, last, before the claim.
  // Read only when an earlier debit was sent for this invoice, so a first
  // try costs no call.
  const earlier = await earlierDebitsOf({
    invoiceId: row.invoiceId,
    storeId: row.storeId,
    exceptAttemptId: row.id,
    source: "debit",
    now,
  });
  if (earlier === "paid") {
    // The money for this invoice is already held (and filed for a person).
    return withdraw(
      row,
      "earlier_debit_paid",
      "an earlier debit for this invoice was captured after it had been recorded as failed",
      now,
    );
  }
  if (earlier !== "clear") {
    // Not settled yet, or the gateway would not say. Never a debit on a
    // guess; and not for ever either, like every other wait in this pass.
    return silentTooLong(row, now)
      ? failTry(
          row,
          earlier === "unsettled"
            ? "earlier_debit_unsettled"
            : "gateway_unreachable",
          earlier === "unsettled"
            ? "an earlier debit for this invoice still has a payment that is neither failed nor captured"
            : "the gateway would not say what became of an earlier debit for this invoice",
          now,
          { unsent: true },
        )
      : "waiting";
  }

  // ── 5. The claim, then the debit ─────────────────────────────────────────
  if (!(await claimDebit(row.id, now))) {
    // Another worker took it, or the attempt moved on. Not ours to send.
    return "waiting";
  }

  let res: Awaited<ReturnType<RecurringGateway["debit"]>>;
  try {
    res = await gateway.debit({
      amountPaise: row.amountPaise,
      idempotencyKey: row.idempotencyKey,
      providerOrderId: row.providerOrderId,
      providerTokenId: row.providerTokenId,
      providerCustomerId: row.providerCustomerId,
      storeId: row.storeId,
      description: row.invoiceRef
        ? `StoreMink renewal ${row.invoiceRef}`
        : "StoreMink renewal",
    });
  } catch (err) {
    // ★ A THROW IS AN UNKNOWN, not a failure: the request may have reached
    // the gateway. Reconciliation asks about the order.
    logError("billing.debit_threw", err, { attemptId: row.id });
    await settleAttempt(row.id, "unknown", { now });
    return "sent";
  }

  if (!res.ok) {
    if (res.outcome === "unknown") {
      await settleAttempt(row.id, "unknown", { now });
      return "sent";
    }
    // A 4xx is a verdict: the debit was refused and nothing moved.
    return failTry(row, "gateway_rejected", res.error, now);
  }

  const state = mapGatewayStatus(res.data.status);
  const settled = await settleAttempt(row.id, state, {
    providerPaymentId: res.data.providerPaymentId,
    now,
  });
  logInfo("billing.debit_pass.sent", {
    attemptId: row.id,
    storeId: row.storeId,
    invoiceId: row.invoiceId,
    state: settled,
  });
  // ★ The plan follows the money. A debit that lands after the cycle turned
  // (a third try) moves the cycle on now, not at the next evaluation.
  if (settled === "captured") await advanceAfterPayment(row.storeId, now);
  return "sent";
}

/** Is `now` at least `hours` past this attempt's debit time? */
function overdueBy(row: DueDebit, hours: number, now: Date): boolean {
  const dueAt = row.debitAfter ? Date.parse(row.debitAfter) : NaN;
  // A debit time that cannot be read never ends the wait by itself.
  if (!Number.isFinite(dueAt)) return false;
  return now.getTime() >= dueAt + hours * 3_600_000;
}

/** Has the gateway been silent on this attempt for too long to keep waiting? */
function silentTooLong(row: DueDebit, now: Date): boolean {
  return overdueBy(row, GATEWAY_SILENCE_DEADLINE_HOURS, now);
}

/**
 * End this try as failed, and ask the merchant to pay if it was the last.
 * `unsent` is for a try ended BEFORE its debit was claimed: the write then
 * happens only while the debit is still unsent (see the header).
 */
async function failTry(
  row: DueDebit,
  code: string,
  reason: string,
  now: Date,
  opts: { unsent?: boolean } = {},
): Promise<DebitOutcome> {
  const settled = await settleAttempt(row.id, "failed", {
    failureCode: code,
    failureReason: reason.slice(0, 300),
    onlyIfUnsent: opts.unsent === true,
    now,
  });
  if (settled !== "failed") {
    // A guarded write that moved nothing: another run holds this attempt.
    if (opts.unsent) return "waiting";
    // Our own debit's refusal could not be recorded. The attempt is marked
    // sent with no payment on its order, so reconciliation fails it later.
    logError(
      "billing.debit_pass.failure_unrecorded",
      new Error("a refused debit could not be recorded as failed"),
      { attemptId: row.id, code },
    );
    return "failed";
  }
  if (row.storeId) {
    await announceAutopayStopped({
      storeId: row.storeId,
      invoiceId: row.invoiceId,
      now,
    });
  }
  return "failed";
}

/**
 * Withdraw an attempt whose debit must not be sent. `cancelled` is terminal,
 * so the order it holds is never debited, and nobody is told: the invoice or
 * the mandate went away by the merchant's own doing.
 */
async function withdraw(
  row: DueDebit,
  code: string,
  reason: string,
  now: Date,
): Promise<DebitOutcome> {
  const settled = await settleAttempt(row.id, "cancelled", {
    failureCode: code,
    failureReason: reason,
    onlyIfUnsent: true,
    now,
  });
  // Another run sent the debit first, or the write failed: nothing was
  // withdrawn, and the next run reads the attempt again.
  if (settled !== "cancelled") return "waiting";
  logInfo("billing.debit_pass.withdrawn", {
    attemptId: row.id,
    storeId: row.storeId,
    invoiceId: row.invoiceId,
    code,
  });
  return "cancelled";
}

/**
 * ★★ THE CLAIM. `debit_sent_at` is set only while it is null and the attempt
 * is still a notified `processing` one, in one statement. Exactly one caller
 * gets a row back; that caller, and only that caller, sends the debit.
 */
async function claimDebit(attemptId: string, now: Date): Promise<boolean> {
  const rows = await withService((db) =>
    db
      .update(billingPaymentAttempts)
      .set({ debitSentAt: now.toISOString(), updatedAt: now.toISOString() })
      .where(
        and(
          eq(billingPaymentAttempts.id, attemptId),
          eq(billingPaymentAttempts.state, "processing"),
          isNotNull(billingPaymentAttempts.debitAfter),
          isNull(billingPaymentAttempts.debitSentAt),
        ),
      )
      .returning({ id: billingPaymentAttempts.id }),
  );
  return rows.length > 0;
}

/** Move an unsent attempt's debit time to the instant the gateway allows. */
async function postpone(
  attemptId: string,
  until: Date,
  now: Date,
): Promise<void> {
  await withService((db) =>
    db
      .update(billingPaymentAttempts)
      .set({ debitAfter: until.toISOString(), updatedAt: now.toISOString() })
      .where(
        and(
          eq(billingPaymentAttempts.id, attemptId),
          eq(billingPaymentAttempts.state, "processing"),
          isNull(billingPaymentAttempts.debitSentAt),
        ),
      ),
  );
}
