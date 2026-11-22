import "server-only";

/**
 * Collection — the payment-attempt lifecycle around a gateway call.
 *
 * Design: docs/billing-architecture.md §5. This is
 * `lib/payments/issue-refund.ts` generalised: that module is the only path in
 * the codebase that already handles "we never learned the outcome" correctly,
 * and every element of it transfers.
 *
 * ★★ THE ORDER IS THE WHOLE DESIGN:
 *
 *   1. INSERT the attempt row FIRST, carrying an idempotency key WE generated.
 *   2. Call the gateway, passing that key.
 *   3. Claim the outcome onto the row.
 *
 * You cannot key on a provider id you do not have yet, and a timeout is
 * indistinguishable from a success you never read. If step 2 or 3 dies, the row
 * survives with the key planted at the gateway, so reconciliation can find the
 * payment and settle it. The reverse order — charge, then record — loses money
 * silently the first time a process is killed mid-flight.
 *
 * ⚠ THE GATEWAY CALL IS INJECTED, not imported. The exact Razorpay
 * subsequent-charge endpoint is still unverified (docs/billing-architecture.md
 * §10), so inventing a signature here would bake a guess into the money path.
 * The seam keeps this module fully testable and lets the real call slot in once
 * it has been confirmed against a test-mode account.
 */

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  billingInvoices,
  billingPaymentAttempts,
  billingReconciliationItems,
} from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { notifyInvoicePaid } from "./receipts";
import {
  capturedPayment,
  rzpFetchOrder,
  rzpFetchOrderPayments,
  type RazorpayCreds,
  type RzpResult,
} from "@/lib/payments/razorpay";
import { collectionRoute, type MandateStatus } from "./cycle";
import {
  invoiceStatusForAttempts,
  isTerminal,
  resolvePaymentState,
  type PaymentState,
} from "./payment-state";

/** What the gateway tells us about one charge. */
export interface ChargeResponse {
  providerPaymentId: string;
  /** The gateway's own status; mapped through `mapGatewayStatus`. */
  status: string;
}

/** Which rail a mandate was registered on: it decides the notice period. */
export type MandateRail = "card" | "upi" | "emandate" | "nach" | "unknown";

/** Can the mandate be debited right now, by the gateway's own word? */
export type MandateCheck =
  /** Confirmed at the gateway: it may be debited. */
  | { state: "chargeable" }
  /** The customer paused it. Not chargeable now; it may come back. */
  | { state: "paused"; detail: string }
  /** Cancelled, rejected or expired: it will never be chargeable again. */
  | { state: "ended"; detail: string }
  /** The gateway could not be asked. Decide nothing. */
  | { state: "unknown" };

/** Where the pre-debit notice of one notified order stands. */
export type NoticeCheck =
  /** The notice period has passed: the debit may be sent now. */
  | { state: "ready" }
  /** Not yet: the debit may be sent from `until`. */
  | { state: "wait"; until: Date }
  /** The gateway has not delivered the notice (yet). */
  | { state: "undelivered" }
  /** The gateway could not be asked. Decide nothing. */
  | { state: "unknown" };

/**
 * The seam: everything the billing passes ask of the payment gateway for an
 * AUTOMATIC renewal. `lib/billing/gateway.ts` is the one implementation.
 *
 * ★★ A RENEWAL IS TWO STEPS, A DAY OR MORE APART (21 Nov 2026). Razorpay
 * accepts a recurring debit only for an order created with a pre-debit
 * notification, and only once the notice period has passed since the customer
 * was sent it. So:
 *
 *   `notify`  creates the order WITH its notice. No money moves.
 *   `debit`   sends the debit for that order, once `readNotice` says ready.
 *
 * and `checkMandate` asks, before either, whether the mandate can still be
 * charged at all ("Only tokens in the confirmed state can be used").
 *
 * An implementation MUST put `idempotencyKey` in provider-visible metadata.
 * Razorpay's recurring reference promises no idempotency header, so the
 * durable attempt, its write-once provider order and the `debit_sent_at`
 * claim are the duplicate guards.
 */
export interface RecurringGateway {
  checkMandate(input: {
    providerCustomerId: string;
    providerTokenId: string;
  }): Promise<MandateCheck>;
  notify(input: {
    amountPaise: number;
    idempotencyKey: string;
    providerTokenId: string;
    rail: MandateRail;
    now: Date;
  }): Promise<RzpResult<{ providerOrderId: string; debitAfter: Date }>>;
  readNotice(input: {
    providerOrderId: string;
    rail: MandateRail;
    now: Date;
  }): Promise<NoticeCheck>;
  debit(input: {
    amountPaise: number;
    idempotencyKey: string;
    providerOrderId: string;
    providerTokenId: string;
    providerCustomerId: string;
    /** Which store is being billed: the implementation resolves its contact. */
    storeId: string;
    description: string;
  }): Promise<RzpResult<ChargeResponse>>;
}

export type CollectResult =
  | { status: "paid"; attemptId: string }
  | { status: "failed"; attemptId: string; code?: string; reason?: string }
  /**
   * The order and its pre-debit notice were created. No money has moved; the
   * debit pass sends the debit once the notice period has passed.
   */
  | { status: "notified"; attemptId: string; debitAfter: Date }
  /** Outcome unknown — money may have moved. NEVER retry (Rule 1). */
  | { status: "pending_reconcile"; attemptId: string }
  | { status: "not_collectable"; reason: string }
  | { status: "already_in_flight" }
  | { status: "error" };

/**
 * Map the gateway's vocabulary onto ours.
 *
 * ★ Anything unrecognised becomes `unknown`, never `failed`. A status we do not
 * understand is missing information, and treating it as a failure would start a
 * grace clock and could trigger a second charge (Rule 6).
 */
export function mapGatewayStatus(status: string): PaymentState {
  switch ((status || "").toLowerCase()) {
    case "captured":
      return "captured";
    case "authorized":
      return "authorized";
    case "created":
    case "pending":
      return "processing";
    case "failed":
      return "failed";
    case "refunded":
      return "refunded";
    default:
      return "unknown";
  }
}

/** Terminal states must carry `resolved_at`; in-flight ones must not
 *  (billing_payment_attempts_resolved_shape). */
function resolvedAtFor(state: PaymentState, now: Date): string | null {
  return isTerminal(state) ? now.toISOString() : null;
}

export interface BeginAttemptInput {
  invoiceId: string;
  storeId: string;
  amountPaise: number;
  mode: "automatic" | "manual";
  mandateId?: string | null;
  providerTokenId?: string | null;
  /** Exact ceiling offered during a mandate-authorisation checkout. */
  mandateMaxPaise?: number | null;
}

export interface BeganAttempt {
  attemptId: string;
  idempotencyKey: string;
}

/**
 * Open an attempt, before any money moves.
 *
 * ★ A UNIQUE VIOLATION HERE IS A CORRECT ANSWER, not an error to log and
 * retry: `billing_payment_attempts_one_in_flight` means something is already
 * being collected for this invoice. Three clicks on Pay, or an automatic retry
 * racing a manual payment, land here (spec §28, §36). Returning null tells the
 * caller to leave it alone rather than open a second charge.
 */
export async function beginAttempt(
  input: BeginAttemptInput,
): Promise<BeganAttempt | null> {
  const idempotencyKey = randomUUID();
  try {
    return await withService(async (db) => {
      const rows = await db
        .insert(billingPaymentAttempts)
        .values({
          invoiceId: input.invoiceId,
          storeId: input.storeId,
          idempotencyKey,
          mode: input.mode,
          state: "created",
          amountPaise: input.amountPaise,
          mandateId: input.mandateId ?? null,
          providerTokenId: input.providerTokenId ?? null,
          mandateMaxPaise: input.mandateMaxPaise ?? null,
        })
        // The partial unique index is on the IN-FLIGHT states, so a conflict
        // means "already collecting", not "duplicate row".
        .onConflictDoNothing()
        .returning({ id: billingPaymentAttempts.id });

      const id = rows[0]?.id;
      return id ? { attemptId: id, idempotencyKey } : null;
    });
  } catch (err) {
    logError("billing.begin_attempt", err, { invoiceId: input.invoiceId });
    return null;
  }
}

/**
 * Fold an observed outcome into an attempt.
 *
 * ★ MONOTONIC, and claimed against the state we read. `resolvePaymentState`
 * decides whether the move is legal — a late `failed` after a `captured` is
 * rejected by the machine, with no timestamps involved (spec §26) — and the
 * UPDATE then claims on that exact prior state, so a concurrent settle cannot
 * overwrite a newer one.
 *
 * Returns the state the attempt ended up in, which is NOT always `incoming`.
 *
 * ★ A `captured` attempt settled `captured` again writes nothing to the attempt
 * but re-runs the invoice sync (finding F1, below).
 *
 * `notify: false` makes the invoice paid WITHOUT the paid receipt (R1-04).
 * Only the reconcile repair pass passes it, for a purchase it issues by itself
 * because the purchase's own completion declined or a person already holds
 * the payment: the receipt says "your plan is active", which is untrue for
 * something that was not applied, and a person is already checking it.
 */
export async function settleAttempt(
  attemptId: string,
  incoming: PaymentState,
  extra: {
    providerPaymentId?: string | null;
    providerOrderId?: string | null;
    failureCode?: string | null;
    failureReason?: string | null;
    /** The earliest instant a notified order may be debited (step 1 of an
     *  automatic renewal). Written with the order it belongs to. */
    debitAfter?: Date | null;
    now?: Date;
    /** Send the paid receipt when this settle makes the invoice paid
     *  (default true). */
    notify?: boolean;
    /**
     * ★★ Move the attempt ONLY while its debit has not been sent
     * (`debit_sent_at` is null), in the same statement. For every write that
     * ends a notified attempt WITHOUT debiting it (the plan was cancelled, the
     * mandate is gone, the notice never arrived): a terminal state can never
     * be left, so writing one while another worker's debit was already on its
     * way would make the machine ignore that debit's capture, and the money
     * would sit behind a closed attempt. With this, exactly one of {the
     * debit's claim, the withdrawal} wins, and a lost withdrawal returns null.
     */
    onlyIfUnsent?: boolean;
  } = {},
): Promise<PaymentState | null> {
  const now = extra.now ?? new Date();
  try {
    const settled = await withService(async (db) => {
      const [current] = await db
        .select({
          id: billingPaymentAttempts.id,
          state: billingPaymentAttempts.state,
          invoiceId: billingPaymentAttempts.invoiceId,
          storeId: billingPaymentAttempts.storeId,
        })
        .from(billingPaymentAttempts)
        .where(eq(billingPaymentAttempts.id, attemptId))
        .limit(1);
      if (!current) return null;

      const from = current.state as PaymentState;
      const decision = resolvePaymentState(from, incoming);

      if (!decision.changed) {
        if (decision.ignored) {
          // Normal — a duplicate or out-of-order webhook. Worth a line: a flood
          // of these means something upstream is replaying.
          logWarn("billing.attempt_state_ignored", {
            attemptId,
            from,
            incoming,
          });
        }
        // ★★ A CAPTURE SEEN AGAIN STILL BRINGS ITS INVOICE IN LINE (finding
        // F1). Reconciliation can capture an enrolment, plan-change or
        // location attempt while its invoice is still a draft; the paid claim
        // admits only open and processing, so it matches nothing. The confirm
        // path then finalizes the draft to `open` and settles the same
        // attempt again, which changes nothing, and before this the invoice
        // stayed `open` behind captured money: a bill Plans & Billing offered
        // to pay a second time. Re-running the sync here lets that finalized
        // invoice become paid. The claim is the same one, so a draft never
        // becomes paid, a `void` or `uncollectible` invoice is never revived
        // (defect D9), and the receipt still goes out exactly once.
        if (from === "captured" && incoming === "captured") {
          const sync = await syncInvoiceStatus(db, current.invoiceId, now);
          return {
            state: decision.state,
            becamePaid: sync.becamePaid,
            storeId: sync.becamePaid ? current.storeId : null,
            invoiceId: current.invoiceId,
          };
        }
        return {
          state: decision.state,
          becamePaid: false,
          storeId: null,
          invoiceId: current.invoiceId,
        };
      }

      const claimed = await db
        .update(billingPaymentAttempts)
        .set({
          state: decision.state,
          resolvedAt: resolvedAtFor(decision.state, now),
          providerPaymentId: extra.providerPaymentId ?? undefined,
          providerOrderId: extra.providerOrderId ?? undefined,
          debitAfter: extra.debitAfter
            ? extra.debitAfter.toISOString()
            : undefined,
          failureCode: extra.failureCode ?? undefined,
          failureReason: extra.failureReason ?? undefined,
          updatedAt: now.toISOString(),
        })
        // ★ Claim on the state we based the decision on. Zero rows means a
        // concurrent settle moved it first, and ITS decision stands.
        .where(
          and(
            eq(billingPaymentAttempts.id, attemptId),
            eq(billingPaymentAttempts.state, from),
            extra.onlyIfUnsent
              ? isNull(billingPaymentAttempts.debitSentAt)
              : undefined,
          ),
        )
        .returning({ state: billingPaymentAttempts.state });

      if (claimed.length === 0) return null;

      const sync = await syncInvoiceStatus(db, current.invoiceId, now);
      return {
        state: decision.state,
        becamePaid: sync.becamePaid,
        storeId: sync.becamePaid ? current.storeId : null,
        invoiceId: current.invoiceId,
      };
    });

    if (!settled) return null;

    // ★★ THE RECEIPT, from the ONE place an invoice becomes paid — so enrolment,
    // manual payment, a plan change, a location purchase and reconciliation all
    // send exactly one, and none of them has to remember to.
    //
    // ⚠ AFTER the transaction, always: an email is a network call, and sending
    // it inside would hold a pooled connection open for an HTTP request and
    // announce a payment a rollback then undid. Best-effort — the money is
    // recorded either way.
    if (settled.becamePaid && settled.storeId && extra.notify !== false) {
      await notifyInvoicePaid(settled.storeId, settled.invoiceId);
    }
    return settled.state;
  } catch (err) {
    logError("billing.settle_attempt", err, { attemptId, incoming });
    return null;
  }
}

/**
 * The invoice statuses a capture can land on when a plan was closed under it:
 * an issued invoice in one of these is money the refund pass returns.
 */
const CLOSED_INVOICE_STATUSES: ReadonlySet<string> = new Set([
  "void",
  "uncollectible",
]);

/**
 * Derive the invoice's status from its attempts.
 *
 * ★ DERIVED, never a flag someone has to remember to clear — the same reasoning
 * §26 gives for `refundOwed`. Only ever applied to collectable invoices:
 * `void` and `uncollectible` are DECISIONS, so this leaves them alone rather
 * than reviving an invoice the downgrade path deliberately closed.
 */
/**
 * Bring the invoice's status in line with its attempts.
 *
 * ★★ RETURNS WHETHER THIS CALL MADE IT PAID, which is what lets a receipt be
 * sent exactly once from one place. The transition is CLAIMED — the WHERE
 * excludes `paid` when moving TO paid — so a second settle on an
 * already-paid invoice matches no row and reports false.
 *
 * ⚠ That claim also fixes a quieter bug: `paidAt` used to be rewritten on every
 * subsequent sync, so a second attempt settling later moved the timestamp on an
 * invoice that had been paid for days.
 *
 * ★★ A PAID INVOICE IS NEVER MOVED BACK by its attempts (defect D9): the WHERE
 * admits only `open` and `processing`, whichever status the attempts derive.
 */
async function syncInvoiceStatus(
  db: Db,
  invoiceId: string,
  now: Date,
): Promise<{ becamePaid: boolean }> {
  const attempts = await db
    .select({ state: billingPaymentAttempts.state })
    .from(billingPaymentAttempts)
    .where(eq(billingPaymentAttempts.invoiceId, invoiceId));

  const next = invoiceStatusForAttempts(
    attempts.map((a) => a.state as PaymentState),
  );

  const claimed = await db
    .update(billingInvoices)
    .set({
      status: next,
      paidAt: next === "paid" ? now.toISOString() : undefined,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(billingInvoices.id, invoiceId),
        // Only an open or processing invoice moves. A closed one (`void`,
        // `uncollectible`) is never revived; moving TO paid never re-claims
        // one that already is; and ★★ a paid invoice is never moved back to
        // open or processing by its attempts (defect D9: once `paid` was in
        // this list, an attempt set that derived `open` reopened a paid
        // invoice and offered it for payment again).
        inArray(billingInvoices.status, ["open", "processing"]),
      ),
    )
    .returning({ id: billingInvoices.id });

  // ★★ A ZERO-ROW CLAIM ON A PAID TRANSITION IS EITHER NOTHING OR A DISASTER,
  // AND THE SILENCE IS WHAT MADE THIS COST 20 DAYS.
  //
  // Claiming nothing normally means "another settle got there first", which is
  // correct and boring. But it ALSO happens when the invoice is in a status this
  // claim cannot reach — `draft`, in the incident that prompted this — and then
  // the money is captured while the invoice stays unpaid, dunning keeps chasing
  // it, and nothing anywhere reports a problem. There was no log, no error and
  // no failed request: the only trace was `paid_at` being null on a row whose
  // attempt said `captured`.
  //
  // So distinguish the two by re-reading the row. Already `paid` is the benign
  // race; anything else means money has been taken against an invoice that does
  // not know it, which is an operator-visible fault, not a warning.
  //
  // ★ ONE EXCEPTION IS EXPECTED, AND IT IS INFO: a capture on an ISSUED invoice
  // that was then closed (`void` when a plan ended before reaching its cycle,
  // `uncollectible` after a downgrade). The refund pass returns that money, so
  // nobody has to act. The row is left exactly as it is. ★★ An UNISSUED one (a
  // draft, or a draft closed by hand, `finalized_at` null) stays an error: the
  // refund guard refuses an unissued invoice, so only a person can return that
  // money.
  if (next === "paid" && claimed.length === 0) {
    const [row] = await db
      .select({
        status: billingInvoices.status,
        finalizedAt: billingInvoices.finalizedAt,
      })
      .from(billingInvoices)
      .where(eq(billingInvoices.id, invoiceId))
      .limit(1);
    if (row && row.status !== "paid") {
      const issued = row.finalizedAt !== null;
      if (issued && CLOSED_INVOICE_STATUSES.has(row.status)) {
        logInfo("billing.payment_on_closed_invoice", {
          invoiceId,
          invoiceStatus: row.status,
        });
      } else {
        logError(
          "billing.invoice_paid_claim_missed",
          new Error(
            `captured payment could not mark invoice paid (status ${row.status})`,
          ),
          { invoiceId, invoiceStatus: row.status, issued },
        );
      }
    }
  }

  return { becamePaid: next === "paid" && claimed.length > 0 };
}

export interface CollectInput {
  invoiceId: string;
  storeId: string;
  amountDuePaise: number;
  description: string;
  mandate: {
    id: string;
    status: MandateStatus | null;
    maxAmountPaise: number | null;
    providerTokenId: string | null;
    /** Razorpay attaches a mandate to a CUSTOMER; the charge needs both. */
    providerCustomerId?: string | null;
    /** The rail it was registered on; decides the notice period. */
    method?: MandateRail | null;
  } | null;
  charge: RecurringGateway;
  now?: Date;
}

/**
 * Start automatic collection of one invoice: STEP 1, the notified order.
 *
 * ★★ NO MONEY MOVES HERE (21 Nov 2026). Razorpay accepts a renewal debit only
 * for an order created with a pre-debit notification, and only once the
 * notice period has passed. This opens the attempt, creates that order and
 * records when the debit may be sent; the debit itself is sent by the debit
 * pass (`lib/billing/debit-pass.ts`) a day or more later. Before this, the
 * order was plain and the debit was sent in the same breath, which Razorpay
 * answers "The requested URL was not found on the server" every time.
 *
 * ★ ELIGIBILITY IS CHECKED BEFORE ANYTHING IS WRITTEN. `collectionRoute`
 * applies BOTH ceilings (what the mandate authorised and the AFA-exempt
 * limit), so an amount that would need the merchant to authenticate is routed
 * to the manual path, never attempted and failed. A failed attempt starts a
 * grace clock; "not collectable automatically" must not.
 *
 * ★ AN UNKNOWN OUTCOME IS NOT A FAILURE. An order creation that timed out
 * leaves the attempt `unknown` with no order; reconciliation closes it after
 * its stale window (no order id was recorded, so nothing can be debited).
 */
export async function collectInvoice(
  input: CollectInput,
): Promise<CollectResult> {
  const now = input.now ?? new Date();

  const route = collectionRoute({
    mandateStatus: input.mandate?.status ?? null,
    mandateMaxPaise: input.mandate?.maxAmountPaise ?? null,
    totalPaise: input.amountDuePaise,
  });
  if (!route.auto) return { status: "not_collectable", reason: route.reason };

  const tokenId = input.mandate?.providerTokenId;
  // A debit needs the customer the token belongs to. Without one nothing
  // could ever be sent, so do not put a notice in front of the merchant.
  if (!tokenId || !input.mandate?.providerCustomerId) {
    return { status: "not_collectable", reason: "no_mandate" };
  }

  // Nothing to collect — a fully credited invoice is settled without a charge.
  if (input.amountDuePaise <= 0) {
    return { status: "not_collectable", reason: "nothing_due" };
  }

  const begun = await beginAttempt({
    invoiceId: input.invoiceId,
    storeId: input.storeId,
    amountPaise: input.amountDuePaise,
    mode: "automatic",
    mandateId: input.mandate?.id ?? null,
    providerTokenId: tokenId,
  });
  if (!begun) return { status: "already_in_flight" };

  let res: Awaited<ReturnType<RecurringGateway["notify"]>>;
  try {
    res = await input.charge.notify({
      amountPaise: input.amountDuePaise,
      idempotencyKey: begun.idempotencyKey,
      providerTokenId: tokenId,
      rail: input.mandate?.method ?? "unknown",
      now,
    });
  } catch (err) {
    // ★ A THROW IS AN UNKNOWN, not a failure. The request may well have
    // reached the gateway. Leave the attempt in `unknown` for reconciliation.
    logError("billing.notify_threw", err, { invoiceId: input.invoiceId });
    await settleAttempt(begun.attemptId, "unknown", { now });
    return { status: "pending_reconcile", attemptId: begun.attemptId };
  }

  if (!res.ok) {
    if (res.outcome === "unknown") {
      await settleAttempt(begun.attemptId, "unknown", { now });
      return { status: "pending_reconcile", attemptId: begun.attemptId };
    }
    await settleAttempt(begun.attemptId, "failed", {
      failureCode: "gateway_rejected",
      failureReason: res.error,
      now,
    });
    return {
      status: "failed",
      attemptId: begun.attemptId,
      code: "gateway_rejected",
      reason: res.error,
    };
  }

  // ★★ THE ORDER AND ITS DEBIT TIME ARE RECORDED TOGETHER, in the one write
  // that moves the attempt to `processing`. The debit pass finds the attempt
  // by exactly these two columns, so an order we failed to record can never
  // be debited: the attempt stays `created` with no order and reconciliation
  // closes it. (The customer was sent a notice for a debit that never comes,
  // which costs nothing; a debit nobody recorded would cost money.)
  const recorded = await settleAttempt(begun.attemptId, "processing", {
    providerOrderId: res.data.providerOrderId,
    debitAfter: res.data.debitAfter,
    now,
  });
  if (recorded !== "processing") {
    logError(
      "billing.notified_order_unrecorded",
      new Error("the notified order could not be recorded on its attempt"),
      { invoiceId: input.invoiceId, attemptId: begun.attemptId },
    );
    return { status: "pending_reconcile", attemptId: begun.attemptId };
  }
  return {
    status: "notified",
    attemptId: begun.attemptId,
    debitAfter: res.data.debitAfter,
  };
}

/**
 * Withdraw an invoice's SCHEDULED automatic debits: notified attempts whose
 * debit has not been sent yet. Returns how many were withdrawn, or null when
 * they could not be read.
 *
 * ★ For the moment a merchant cancels their plan. The debit pass would
 * withdraw them anyway when their time came (it re-checks the plan, the
 * invoice and the mandate before every debit), but doing it at once means the
 * invoice reads as unpaid straight away, and what the merchant is told ("your
 * renewal invoice won't be charged") is true from that moment.
 *
 * ★ Each one is a guarded settle (`onlyIfUnsent`): an attempt whose debit was
 * sent a moment ago is left alone and stays in flight.
 */
export async function withdrawUnsentDebits(input: {
  invoiceId: string;
  code: string;
  reason: string;
  now?: Date;
}): Promise<number | null> {
  const now = input.now ?? new Date();
  let ids: string[];
  try {
    ids = await withService(async (db) => {
      const rows = await db
        .select({ id: billingPaymentAttempts.id })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, input.invoiceId),
            eq(billingPaymentAttempts.mode, "automatic"),
            eq(billingPaymentAttempts.state, "processing"),
            isNotNull(billingPaymentAttempts.debitAfter),
            isNull(billingPaymentAttempts.debitSentAt),
          ),
        );
      return rows.map((r) => r.id);
    });
  } catch (err) {
    logError("billing.withdraw_unsent_debits", err, {
      invoiceId: input.invoiceId,
    });
    return null;
  }
  let withdrawn = 0;
  for (const id of ids) {
    const settled = await settleAttempt(id, "cancelled", {
      failureCode: input.code,
      failureReason: input.reason,
      onlyIfUnsent: true,
      now,
    });
    if (settled === "cancelled") withdrawn += 1;
  }
  return withdrawn;
}

/**
 * An invoice's automatic attempts, as `autoCollectDecision` (cycle.ts) reads
 * them: `count`, the TRIES (a debit was sent, or a payment exists); `starts`,
 * every attempt not withdrawn before its debit; and when the newest attempt
 * of any kind was opened.
 *
 * ★★ WITHDRAWN IS NOT TRIED (PR #303 review, 22 Nov 2026). An attempt
 * cancelled before its debit was sent (the plan was cancelled, or the
 * merchant chose "Pay now instead") never asked anyone for money and counts
 * for nothing. One that ended before its debit for another reason (the
 * gateway refused the order, the notice never arrived, the start timed out)
 * is a start, not a try. Counting them all as tries used the three tries up
 * without a single debit.
 *
 * ★ NULL WHEN THE READ FAILED, never zero: "we could not count" must not read
 * as "never tried", or a database hiccup is one more debit.
 */
export async function automaticAttemptsOn(
  invoiceId: string,
): Promise<{ count: number; starts: number; lastAt: Date | null } | null> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          count: sql<number>`count(*) filter (where ${billingPaymentAttempts.debitSentAt} is not null or ${billingPaymentAttempts.providerPaymentId} is not null)::int`,
          starts: sql<number>`count(*) filter (where not (${billingPaymentAttempts.state} = 'cancelled' and ${billingPaymentAttempts.debitSentAt} is null and ${billingPaymentAttempts.providerPaymentId} is null))::int`,
          lastAt: sql<string | null>`max(${billingPaymentAttempts.createdAt})`,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, invoiceId),
            eq(billingPaymentAttempts.mode, "automatic"),
          ),
        );
      const lastAt = row?.lastAt ? new Date(row.lastAt) : null;
      return {
        count: Number(row?.count ?? 0),
        starts: Number(row?.starts ?? 0),
        lastAt: lastAt && Number.isFinite(lastAt.getTime()) ? lastAt : null,
      };
    });
  } catch (err) {
    logError("billing.automatic_attempts", err, { invoiceId });
    return null;
  }
}

/**
 * Is a payment on this invoice still waiting for its RESULT (state `unknown`)?
 *
 * ★★ THE ONE-IN-FLIGHT INDEX DOES NOT COVER `unknown`, so `beginAttempt`
 * succeeds beside one. An automatic debit whose answer never arrived may well
 * have taken the money; a merchant who then pressed Pay now paid the same
 * renewal a second time, and the duplicate had to be refunded. Callers that
 * open a NEW payment for an existing invoice ask this first.
 *
 * Reconciliation resolves an `unknown` attempt: captured or failed as soon as
 * the gateway says so, an automatic one with no payment on its order after a
 * few hours, and one that never got a gateway order after 15 minutes. So this
 * never blocks for long.
 *
 * ★ NULL WHEN THE READ FAILED: the caller must not read that as "no".
 */
export async function hasUnknownAttempt(
  invoiceId: string,
): Promise<boolean | null> {
  try {
    return await withService(async (db) => {
      const rows = await db
        .select({ id: billingPaymentAttempts.id })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, invoiceId),
            eq(billingPaymentAttempts.state, "unknown"),
          ),
        )
        .limit(1);
      return rows.length > 0;
    });
  } catch (err) {
    logError("billing.has_unknown_attempt", err, { invoiceId });
    return null;
  }
}

/** The most recent attempt for an invoice, for reconciliation and display. */
export async function latestAttempt(invoiceId: string) {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingPaymentAttempts.id,
          state: billingPaymentAttempts.state,
          amountPaise: billingPaymentAttempts.amountPaise,
          idempotencyKey: billingPaymentAttempts.idempotencyKey,
          providerPaymentId: billingPaymentAttempts.providerPaymentId,
          failureReason: billingPaymentAttempts.failureReason,
          createdAt: billingPaymentAttempts.createdAt,
        })
        .from(billingPaymentAttempts)
        .where(eq(billingPaymentAttempts.invoiceId, invoiceId))
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.latest_attempt", err, { invoiceId });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recovered purchases: a captured payment on an invoice still a draft (RC-F1b)
//
// A merchant pays in Razorpay Checkout and closes the tab before the confirm
// call. The hourly reconcile records the capture, but the invoice is still a
// draft (an enrolment, a plan change or a location purchase finalizes only on
// confirm), so nothing issued it, granted the plan or told the merchant. These
// helpers are what the three purchase kinds share to finish such a purchase:
// finding one, checking the money with the gateway again, telling which kind
// of add-on an order bought, and filing what only a person can decide.
// ---------------------------------------------------------------------------

/** A captured attempt standing on a draft invoice: a purchase never finished. */
export interface CapturedDraftPurchase {
  attemptId: string;
  invoiceId: string;
  storeId: string;
  kind: "subscription" | "addon";
  providerOrderId: string;
  providerPaymentId: string | null;
  amountPaise: number;
  currency: string;
  createdAt: string;
}

/**
 * Captured attempts on draft subscription or add-on invoices.
 *
 * ★ ONE STORE OR EVERY STORE. The purchase start paths ask about one store
 * before they open a new order; the hourly reconcile asks about every store,
 * only for attempts older than `createdBefore`, and skips an attempt a person
 * already holds (an open or in-review reconciliation item about it, or one of
 * the two items this release files once per attempt), so the queue it fills
 * is never filled twice.
 *
 * ★ Returns NULL on a read failure, never an empty list: the start paths fail
 * closed, because "we could not check" is not "nothing was paid".
 */
export async function capturedDraftPurchases(input: {
  storeId?: string;
  kind?: "subscription" | "addon";
  createdBefore?: string;
  excludeHeld?: boolean;
  limit?: number;
}): Promise<CapturedDraftPurchase[] | null> {
  try {
    return await withService(async (db) => {
      const conditions = [
        eq(billingPaymentAttempts.state, "captured"),
        eq(billingInvoices.status, "draft"),
        inArray(
          billingInvoices.kind,
          input.kind ? [input.kind] : ["subscription", "addon"],
        ),
        isNotNull(billingPaymentAttempts.storeId),
        isNotNull(billingPaymentAttempts.providerOrderId),
        // The attempt and the invoice name the same store, or it is not a
        // purchase this code may finish.
        eq(billingInvoices.storeId, billingPaymentAttempts.storeId),
      ];
      if (input.storeId) {
        conditions.push(eq(billingPaymentAttempts.storeId, input.storeId));
      }
      if (input.createdBefore) {
        conditions.push(
          lt(billingPaymentAttempts.createdAt, input.createdBefore),
        );
      }
      if (input.excludeHeld) {
        conditions.push(
          sql`not exists (
            select 1 from public.billing_reconciliation_items r
             where r.attempt_id = billing_payment_attempts.id
               and (r.status in ('open', 'manual_review')
                    or r.detail->>'repair_key' in (
                      'purchase_refused:' || billing_payment_attempts.id::text,
                      'purchase_unapplied:' || billing_payment_attempts.id::text)))`,
        );
      }
      const rows = await db
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
        })
        .from(billingPaymentAttempts)
        .innerJoin(
          billingInvoices,
          eq(billingInvoices.id, billingPaymentAttempts.invoiceId),
        )
        .where(and(...conditions))
        .orderBy(asc(billingPaymentAttempts.createdAt))
        .limit(input.limit ?? 50);
      return rows.map((row) => ({
        attemptId: row.attemptId,
        invoiceId: row.invoiceId,
        storeId: row.storeId as string,
        kind:
          row.kind === "addon" ? ("addon" as const) : ("subscription" as const),
        providerOrderId: row.providerOrderId as string,
        providerPaymentId: row.providerPaymentId,
        amountPaise: row.amountPaise,
        currency: row.currency,
        createdAt: row.createdAt,
      }));
    });
  } catch (err) {
    logError("billing.recovery.scan", err, { storeId: input.storeId ?? null });
    return null;
  }
}

/**
 * The captured attempt on one invoice, if there is one.
 *
 * `undefined` on a read failure, `null` when there is none: manual payment
 * fails closed on the first and opens a payment only on the second.
 */
export async function capturedAttemptForInvoice(
  invoiceId: string,
  storeId: string,
): Promise<
  { id: string; providerPaymentId: string | null } | null | undefined
> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingPaymentAttempts.id,
          providerPaymentId: billingPaymentAttempts.providerPaymentId,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, invoiceId),
            eq(billingPaymentAttempts.storeId, storeId),
            eq(billingPaymentAttempts.state, "captured"),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.recovery.invoice_attempt", err, { invoiceId });
    return undefined;
  }
}

export type RecoveredCaptureCheck =
  | { status: "ok"; paymentId: string }
  | { status: "unreadable" }
  | {
      status: "mismatch";
      reason: string;
      paymentId: string | null;
      observedPaise: number | null;
    };

/**
 * Ask the gateway again what was captured on this order, before a recovered
 * purchase is finished.
 *
 * ★★ THE AMOUNT AND THE CURRENCY MUST EQUAL THE ATTEMPT'S. A recovered
 * capture was recorded by the hourly reconcile, which records money even when
 * it differs from what we asked for (it flags that for a person). Finishing a
 * purchase on such a payment would grant a plan for an amount nobody priced,
 * so a mismatch is never applied: it goes to a person.
 *
 * ★ An unreadable gateway is not a verdict: the caller leaves the purchase as
 * it is and tries again on the next pass.
 */
export async function verifyRecoveredCapture(input: {
  creds: RazorpayCreds;
  providerOrderId: string;
  providerPaymentId: string | null;
  amountPaise: number;
  currency: string;
  fetchOrderPayments?: typeof rzpFetchOrderPayments;
}): Promise<RecoveredCaptureCheck> {
  const fetchPayments = input.fetchOrderPayments ?? rzpFetchOrderPayments;
  let res: Awaited<ReturnType<typeof rzpFetchOrderPayments>>;
  try {
    res = await fetchPayments(input.creds, input.providerOrderId);
  } catch (err) {
    logError("billing.recovery.gateway_read", err, {
      providerOrderId: input.providerOrderId,
    });
    return { status: "unreadable" };
  }
  if (!res.ok) return { status: "unreadable" };
  const paid = capturedPayment(res.data);
  if (!paid) {
    return {
      status: "mismatch",
      reason: "the gateway shows no captured payment on this order",
      paymentId: null,
      observedPaise: null,
    };
  }
  if (input.providerPaymentId && paid.id !== input.providerPaymentId) {
    return {
      status: "mismatch",
      reason: "the gateway's captured payment is not the one recorded",
      paymentId: paid.id,
      observedPaise: typeof paid.amount === "number" ? paid.amount : null,
    };
  }
  if (paid.amount !== input.amountPaise || paid.currency !== input.currency) {
    return {
      status: "mismatch",
      reason: "the captured amount or currency differs from the attempt",
      paymentId: paid.id,
      observedPaise: typeof paid.amount === "number" ? paid.amount : null,
    };
  }
  return { status: "ok", paymentId: paid.id };
}

/** What an add-on order was created to buy, read from the notes WE wrote. */
export type AddonOrderTarget =
  | { kind: "plan_change"; plan: string; period: string }
  | { kind: "locations"; count: number }
  | { kind: "unknown" };

/**
 * Which add-on purchase an order is, from the notes the server planted when
 * it created the order (a plan change writes `plan` and `period`, a location
 * purchase writes `locations`).
 *
 * ★ The order is the record the SERVER wrote, which is why a plan change takes
 * its plan and period from here and never from the browser.
 *
 * Null when the order cannot be read: the caller changes nothing and retries.
 */
export async function readAddonOrderTarget(
  creds: RazorpayCreds,
  providerOrderId: string,
): Promise<AddonOrderTarget | null> {
  let res: Awaited<ReturnType<typeof rzpFetchOrder>>;
  try {
    res = await rzpFetchOrder(creds, providerOrderId);
  } catch (err) {
    logError("billing.recovery.order_read", err, { providerOrderId });
    return null;
  }
  if (!res.ok) return null;
  // `notes` is not on RzpOrder's type, but Razorpay returns it on every order.
  const notes = (res.data as { notes?: unknown }).notes;
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
    return { kind: "unknown" };
  }
  const n = notes as Record<string, unknown>;
  if (typeof n.plan === "string" && typeof n.period === "string") {
    return { kind: "plan_change", plan: n.plan, period: n.period };
  }
  const count =
    typeof n.locations === "string" || typeof n.locations === "number"
      ? Number(n.locations)
      : Number.NaN;
  if (Number.isInteger(count) && count >= 0) {
    return { kind: "locations", count };
  }
  return { kind: "unknown" };
}

/**
 * File something about a recovered purchase that only a person can decide.
 *
 * ★ FILED ONCE PER ATTEMPT AND REASON: `detail.repair_key` is unique in any
 * status (`billing_reconciliation_repair_once`, 0264), and the open key
 * (kind, payment) dedupes too, so an hourly pass that meets the same purchase
 * again files nothing new. ★ Never refunds or applies anything: the note says
 * what the person has to decide. Best-effort, like reconcile's own flag.
 */
export async function fileRecoveredPurchase(input: {
  storeId: string | null;
  kind: "state_conflict" | "amount_mismatch";
  repairKey: string;
  note: string;
  invoiceId: string;
  attemptId: string;
  providerPaymentId?: string | null;
  providerOrderId?: string | null;
  expectedPaise?: number | null;
  observedPaise?: number | null;
  purchase: "enrolment" | "plan_change" | "locations" | "unknown";
  now: Date;
}): Promise<boolean> {
  try {
    const rows = await withService(async (db) =>
      db
        .insert(billingReconciliationItems)
        .values({
          storeId: input.storeId,
          kind: input.kind,
          status: "open",
          invoiceId: input.invoiceId,
          attemptId: input.attemptId,
          providerPaymentId: input.providerPaymentId ?? null,
          providerOrderId: input.providerOrderId ?? null,
          expectedPaise: input.expectedPaise ?? null,
          observedPaise: input.observedPaise ?? null,
          detail: {
            repair_key: input.repairKey,
            note: input.note,
            purchase: input.purchase,
          },
          createdAt: input.now.toISOString(),
          updatedAt: input.now.toISOString(),
        })
        .onConflictDoNothing()
        .returning({ id: billingReconciliationItems.id }),
    );
    const filed = rows.length > 0;
    if (filed) {
      logWarn("billing.recovery.filed", {
        storeId: input.storeId,
        invoiceId: input.invoiceId,
        attemptId: input.attemptId,
        repairKey: input.repairKey,
        purchase: input.purchase,
      });
    }
    return filed;
  } catch (err) {
    logError("billing.recovery.file", err, {
      attemptId: input.attemptId,
      repairKey: input.repairKey,
    });
    return false;
  }
}

/**
 * How finishing one purchase ended. Shared by the three purchase kinds so the
 * browser confirm, the hourly reconcile and a repeated start read it alike.
 *
 * - `completed`: THIS call applied the purchase and sent its notices.
 * - `already_complete`: it was applied before; this call changed nothing and
 *   sent nothing.
 * - `not_ready`: nothing was changed (a read failed, the gateway could not be
 *   asked); the next pass tries again.
 * - `refused`: a guard failed, or the money is recorded but the purchase could
 *   not be applied; it was filed for a person and nothing was applied.
 * - `not_captured`: the payment did not complete.
 */
export type PurchaseCompletion<T> =
  | { status: "completed"; data: T }
  | { status: "already_complete"; data: T }
  | { status: "not_ready"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "not_captured" };
