import "server-only";

/**
 * Money StoreMink returns to its merchants: the hourly refund pass and the
 * helpers the operator console shares with it (renewal-cancel, design 6.6;
 * owner decisions of 27 Oct 2026: option C, D2, D3, D7).
 *
 * ★★ A CAPTURED PAYMENT ON A CLOSED SUBSCRIPTION INVOICE IS MONEY FOR A CYCLE
 * THE PLAN DOES NOT REACH (rule R4). A plan end closes every invoice above the
 * last cycle it reached as `void` (close-cycle.ts), and a downgrade for
 * non-payment closes its invoice as `uncollectible`. Whatever lands on either
 * goes back, in full, to the payment it came from, through StoreMink's own
 * Razorpay account (never a store's BYO gateway). The one exception is
 * history: a payment recorded on an `uncollectible` invoice before this
 * release (`platform_billing_settings.automatic_refunds_from`) was kept by
 * older code, and a person decides it (D7).
 *
 * The pass (`processBillingRefunds`) runs inside the hourly billing cron, after
 * collect, reconcile, evaluate and downgrade, so a refund a plan end owes in
 * one run is written in that run. Its steps:
 *
 *   1. REPAIR (history and the rollout race): close an ended plan's unpaid
 *      leftover above its last cycle, or an unpaid invoice below a live plan's
 *      cycle (never a draft, never one with a payment in flight or captured,
 *      only one issued over an hour ago); file a paid renewal of an ended plan
 *      (`paid_unreached:`) and a payment kept before automatic refunds
 *      (`kept_before_refunds:`) as reconciliation items for a person.
 *   2. DETECT: one `owed` row per captured payment on a closed invoice, under
 *      the payment's row lock; a refusal is filed for a person
 *      (`refund_refused:`).
 *   3. SEND: `owed` to `pending` is CLAIMED before Razorpay is called, and only
 *      the claimer calls it, once, with the row's own key. System rows only
 *      while `auto_refunds` is on (D2 ships it off); operator rows always.
 *   4. RECONCILE: a `pending` row is matched in Razorpay's refund list by the
 *      key we planted in `notes.sm_refund_key`, never by amount.
 *   5. CREDIT NOTES: one for each completed refund (not a duplicate payment),
 *      and one cancelling each closed unpaid invoice that charged GST (D3).
 *   6. INVOICE STATUS: nothing. A refund never changes its invoice (rule R9).
 *   7. TELL THE MERCHANT: once per finished refund, through the `notified_at`
 *      claim, after the claim commits.
 *   8. WAITING CHECK: in the 09:00 IST run, `billing.refund_waiting` when
 *      anything has waited more than a day (the daily alert).
 *   9. The summary. A database error counts in `errors` (the cron answers 503
 *      and Cloud Scheduler retries); a refused or failed refund does not.
 *
 * ★★ THE ROW IS WRITTEN BEFORE THE MONEY MOVES, AND AN UNKNOWN OUTCOME IS NOT
 * A FAILURE (CODEBASE.md §26). A timeout or a 5xx leaves the row `pending`;
 * step 4 settles it. Nothing here ever sends the same refund twice, and a
 * refused one is never retried by the pass: a person retries it as a NEW row
 * (`retryRefund`), which the one-automatic-refund index allows.
 *
 * ★ EACH ROW IN ITS OWN TRANSACTION, WITH ITS OWN CATCH, so one bad row never
 * stops the rest. Every scope here is its own; a helper that needs the open
 * transaction is passed its `db` (lib/db/nested-scope-coverage.test.ts).
 *
 * ★ THE CONSOLE SHARES THESE HELPERS (`createOperatorRefund`, `sendRefundNow`,
 * `retryRefund`, `cancelOwedRefund`, `recordRefundMadeOutside`,
 * `refundableForInvoice`, `countRefundsNeedingAction`, `listRefunds`), so the
 * pass and the Refunds page cannot disagree about what is owed, what is sent
 * and who is told. They take ids and the operator's email and check nothing
 * about who is asking: the gate is the action's (a platform superadmin).
 *
 * Not a "use server" file: it takes ids as arguments, the shape that must never
 * be a public endpoint.
 */

import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { dbErrorMessage, pgErrorCode } from "@/lib/db/errors";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  RZP_REFUND_PAGE_SIZE,
  rzpFetchPaymentRefunds,
  rzpRefund,
  type RzpRefund,
  type RzpResult,
} from "@/lib/payments/razorpay";
import {
  mapGatewayRefundStatus,
  matchGatewayRefund,
} from "@/lib/payments/refunds";
import { creditNoteParticulars, issueCreditNote } from "./credit-note-store";
import { getRefundSettings, type RefundSettings } from "./platform-settings";
import { notifyRefundRecorded, notifyRefundSent } from "./receipts";

// ── Constants ───────────────────────────────────────────────────────────────

/** Rows per step per run (design 9): at most 50 refund creates and 50 refund
 *  list reads against Razorpay in one run. */
export const REFUND_BATCH = 50;

/** A sent refund is asked about only after this, so the create call's own
 *  answer has time to land first (the order-refund rule). */
export const SETTLE_AFTER_MS = 2 * 60_000;

/** No refund carrying our key this long after sending: it never reached
 *  Razorpay, so the row fails and a person decides (refund-reconcile.ts). */
export const NO_RECORD_AFTER_MS = 30 * 60_000;

/** The repair touches only an invoice issued, or paid, longer ago than this,
 *  so it can never race a checkout that is finishing. */
export const REPAIR_AFTER_MS = 60 * 60_000;

/** A finished refund whose credit note will not issue is announced anyway
 *  after this (logged), so the merchant is not kept waiting on a document. */
export const NOTE_GRACE_MS = 60 * 60_000;

/** "Waiting more than a day": the daily alert and the console's banner. */
export const WAITING_AFTER_MS = 24 * 3_600_000;

/** The hour (India time) whose run does the daily waiting check. */
export const WAITING_CHECK_IST_HOUR = 9;

/** Pages of a payment's refund list read before giving up for this run. */
const MAX_REFUND_PAGES = 10;

export const REFUND_REASONS = [
  "cycle_not_reached",
  "feature_removed",
  "suspended_by_mistake",
  "declined_terms",
  "duplicate_payment",
  "goodwill",
  "other",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export type RefundStatus =
  | "owed"
  | "pending"
  | "processed"
  | "failed"
  | "cancelled"
  | "recorded";

/** What the console shows when a refund changed under the operator. */
export const MOVED_ON_MESSAGE =
  "That refund has already moved on. Refresh the page.";
export const NOTE_REQUIRED_MESSAGE = "Say why, for the record.";
export const BELOW_MINIMUM_MESSAGE =
  "A refund through Razorpay must be at least ₹1.";
const SAVE_FAILED_MESSAGE = "Couldn't save that refund. Please try again.";
const NOT_FOUND_MESSAGE = "Couldn't find that payment on this invoice.";
const OTHER_STORE_MESSAGE = "That invoice belongs to another store.";
const NOT_ISSUED_MESSAGE =
  "That invoice hasn't been issued, so it can't be refunded.";
const NOT_CAPTURED_MESSAGE =
  "Only a payment that went through can be refunded.";
const NO_GATEWAY_PAYMENT_MESSAGE =
  "That payment has no Razorpay reference. Record a refund made outside StoreMink instead.";
const CYCLE_RULE_MESSAGE =
  "Plan ended before this cycle fits only an invoice for a cycle the plan did not reach.";
const REASON_REQUIRED_MESSAGE = "Choose a reason.";
const AMOUNT_REQUIRED_MESSAGE = "Enter the amount refunded.";
const REFERENCE_REQUIRED_MESSAGE =
  "Give the reference: the UTR or the Razorpay refund id.";
const ALREADY_RECORDED_MESSAGE = "That Razorpay refund is already recorded.";
const NO_GATEWAY_MESSAGE =
  "StoreMink's Razorpay account isn't set up here, so nothing can be sent right now.";

/** "That's more than is left to refund on this payment (₹1,200)." */
export function overCapMessage(leftPaise: number): string {
  return `That's more than is left to refund on this payment (${rupees(leftPaise)}).`;
}

/** "Razorpay refused the refund: {description}" */
export function refusedMessage(description: string): string {
  return `Razorpay refused the refund: ${description}`;
}

// ── The gateway seam ────────────────────────────────────────────────────────

/**
 * Create one refund at Razorpay, with StoreMink's own credentials already
 * bound. Injected so tests never call out; `rzpRefund` adds `sm_refund_key`
 * to the notes itself and sends the key as `X-Refund-Idempotency`.
 */
export type RefundFn = (input: {
  paymentId: string;
  amountPaise: number;
  idempotencyKey: string;
  notes: Record<string, string>;
}) => Promise<RzpResult<RzpRefund>>;

/** One page of a payment's refunds at Razorpay, credentials bound. */
export type FetchRefundsFn = (
  paymentId: string,
  page: { count: number; skip: number },
) => Promise<RzpResult<RzpRefund[]>>;

/**
 * Refunds through StoreMink's own Razorpay account, the account
 * `lib/billing/gateway.ts` charges through, or null when its credentials are
 * absent: then nothing is sent and nothing is asked (design 9).
 */
export function platformRefundFn(): RefundFn | null {
  const creds = getPlatformRazorpayCreds();
  if (!creds) return null;
  return (input) => rzpRefund(creds, input);
}

/** The refund list of StoreMink's own account, or null without credentials. */
export function platformFetchRefundsFn(): FetchRefundsFn | null {
  const creds = getPlatformRazorpayCreds();
  if (!creds) return null;
  return (paymentId, page) => rzpFetchPaymentRefunds(creds, paymentId, page);
}

// ── Small helpers ───────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

type Row = Record<string, unknown>;

function rowsOf(res: { rows?: unknown[] } | null | undefined): Row[] {
  return (res?.rows ?? []) as Row[];
}

/** A bigint or a count comes back from a raw query as TEXT. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function iso(at: Date): string {
  return at.toISOString();
}

function before(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

/** "₹2,400", or "₹1,234.50" when it is not whole rupees. */
function rupees(paise: number): string {
  const value = paise / 100;
  const whole = Number.isInteger(value);
  return `₹${value.toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/**
 * A fresh idempotency key. A UUID is 36 characters of `[0-9a-f-]`, which
 * passes both Razorpay's rule (`^[A-Za-z0-9_-]{10,}$`, enforced by `rzpRefund`)
 * and `billing_refunds_key_shape`.
 */
function newRefundKey(): string {
  return randomUUID();
}

/** The hour of the day in India (UTC+05:30, no daylight saving). */
export function istHour(at: Date): number {
  return new Date(at.getTime() + 330 * 60_000).getUTCHours();
}

/**
 * Did the database REFUSE this write (the guard's `raise`, a CHECK, a unique
 * index), as opposed to failing to run it? A refusal is a decision about this
 * refund and goes to a person; anything else is an outage and counts as an
 * error so the cron is retried.
 */
function isRefusal(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code === "P0001" || code === "23514" || code === "23505";
}

/** Why Razorpay said no, never blank (`billing_refunds_failure_says_why`). */
function gatewayReason(error: string | null | undefined, fallback: string) {
  const text = typeof error === "string" ? error.trim() : "";
  return (text || fallback).slice(0, 500);
}

// ── The pass ────────────────────────────────────────────────────────────────

export interface RefundPassSummary {
  /** Unpaid leftovers the repair closed as `void` (step 1a). */
  repairedInvoices: number;
  /** Reconciliation items filed for a person (steps 1b and 1c, and a
   *  detection the database refused in step 2). */
  flaggedForPerson: number;
  /** Owed refunds written for money on closed invoices (step 2). */
  detected: number;
  /** Refunds handed to Razorpay this run (step 3). */
  sent: number;
  /** Refunds Razorpay processed (steps 3 and 4). */
  processed: number;
  /** Refunds Razorpay refused, reported failed, or never received (3, 4). */
  failed: number;
  /** Sent refunds whose answer is still to come (steps 3 and 4). */
  stillPending: number;
  /** Credit notes issued (step 5). */
  creditNotes: number;
  /** Merchants told a refund reached them (step 7). */
  notified: number;
  /** Refunds waiting more than a day, counted in the 09:00 IST run (step 8). */
  waiting: number;
  /** Database errors: the cron answers 503 so Cloud Scheduler retries. */
  errors: number;
  /** A step filled its limit: there is more to do than one run holds. */
  more: boolean;
}

export interface RefundPassDeps {
  now?: Date;
  limit?: number;
  /** Default: `platformRefundFn()`. Null sends nothing. */
  refund?: RefundFn | null;
  /** Default: `platformFetchRefundsFn()`. Null asks nothing. */
  fetchRefunds?: FetchRefundsFn | null;
}

interface PassContext {
  now: Date;
  limit: number;
  settings: RefundSettings;
  refund: RefundFn | null;
  fetchRefunds: FetchRefundsFn | null;
  summary: RefundPassSummary;
}

function emptySummary(): RefundPassSummary {
  return {
    repairedInvoices: 0,
    flaggedForPerson: 0,
    detected: 0,
    sent: 0,
    processed: 0,
    failed: 0,
    stillPending: 0,
    creditNotes: 0,
    notified: 0,
    waiting: 0,
    errors: 0,
    more: false,
  };
}

/**
 * The hourly refund pass. Never throws: everything it could not do is in the
 * summary's `errors`.
 */
export async function processBillingRefunds(
  deps: RefundPassDeps = {},
): Promise<RefundPassSummary> {
  const summary = emptySummary();
  const now = deps.now ?? new Date();
  const limit =
    Number.isInteger(deps.limit) && (deps.limit as number) > 0
      ? (deps.limit as number)
      : REFUND_BATCH;

  // ★ READ ONCE, LIVE, AND FAIL CLOSED. Whether money moves without a person
  // (`auto_refunds`) and where history ends (`automatic_refunds_from`) decide
  // every step below; a run that cannot read them does nothing and is retried.
  let settings: RefundSettings;
  try {
    settings = await getRefundSettings();
  } catch (err) {
    logError("billing.refunds.settings", err);
    summary.errors += 1;
    return summary;
  }

  const ctx: PassContext = {
    now,
    limit,
    settings,
    refund: deps.refund === undefined ? platformRefundFn() : deps.refund,
    fetchRefunds:
      deps.fetchRefunds === undefined
        ? platformFetchRefundsFn()
        : deps.fetchRefunds,
    summary,
  };

  const steps: [string, (c: PassContext) => Promise<void>][] = [
    ["repair", repair],
    ["detect", detect],
    ["send", send],
    ["reconcile", reconcile],
    ["notes", creditNotes],
    // Step 6 is deliberately absent: a refund never writes its invoice (R9).
    ["notify", notify],
    ["waiting", waitingCheck],
  ];
  for (const [name, step] of steps) {
    try {
      await step(ctx);
    } catch (err) {
      // Each step catches per row; this is the belt for a step that threw
      // before reaching its rows. The next step still runs.
      logError(`billing.refunds.${name}`, err);
      summary.errors += 1;
    }
  }
  return summary;
}

// ── Step 1: repair ──────────────────────────────────────────────────────────

/** Attempt states that mean money may still land, or already has. */
const MONEY_ON_IT = sql`('created', 'processing', 'authorized', 'unknown', 'captured')`;

async function repair(ctx: PassContext): Promise<void> {
  const { now, limit, summary } = ctx;
  const hourAgo = before(now, REPAIR_AFTER_MS);

  // 1a. Close an unpaid leftover. ★ Never a draft (a returning merchant's
  // enrolment is a draft until it is paid; enrolment and deleteStore own
  // drafts), never an invoice with a payment in flight or captured, and only
  // one issued over an hour ago. An unpaid invoice above an ended plan's last
  // cycle is never chased again; one below a live plan's current cycle can
  // never be paid legitimately (the cycle moves only once the next is paid).
  try {
    const res = await withService((db) =>
      db.execute(sql`
        with closing as (
          select c.id
            from public.billing_invoices c
            join public.billing_subscriptions s on s.store_id = c.store_id
           where c.kind = 'subscription'
             and c.status = 'open'
             and c.finalized_at is not null
             and c.finalized_at < ${hourAgo}
             and ((s.state in ('cancelled', 'downgraded') and c.cycle_seq > s.current_cycle_seq)
               or (s.state in ('active', 'past_due', 'grace') and c.cycle_seq < s.current_cycle_seq))
             and not exists (
               select 1 from public.billing_payment_attempts a
                where a.invoice_id = c.id
                  and a.state in ${MONEY_ON_IT})
           order by c.finalized_at
           limit ${limit}
             for update of c skip locked
        )
        update public.billing_invoices i
           set status = 'void', updated_at = ${iso(now)}
          from closing
         where i.id = closing.id
        returning i.id, i.store_id, i.invoice_ref`),
    );
    const closed = rowsOf(res);
    summary.repairedInvoices += closed.length;
    if (closed.length >= limit) summary.more = true;
    if (closed.length) {
      logInfo("billing.refunds.repair_closed", {
        invoices: closed.map((r) => ({ id: r.id, invoiceRef: r.invoice_ref })),
      });
    }
  } catch (err) {
    logError("billing.refunds.repair_close", err);
    summary.errors += 1;
  }

  // 1b. A paid renewal of a plan that has ended, for a cycle it never reached:
  // money kept by older code, or an enrolment whose activation failed. Both
  // need a person, never an automatic refund (D7).
  await fileRepairItems(
    ctx,
    "paid_unreached",
    sql`
      insert into public.billing_reconciliation_items
        (store_id, kind, status, invoice_id, attempt_id, provider_payment_id,
         provider_order_id, expected_paise, detail, created_at, updated_at)
      select i.store_id, 'state_conflict', 'open', i.id, a.id, a.provider_payment_id,
             a.provider_order_id, i.total_paise,
             jsonb_build_object(
               'repair_key', 'paid_unreached:' || i.id,
               'note', 'renewal paid for a cycle the plan did not reach',
               'invoiceRef', i.invoice_ref),
             ${iso(now)}, ${iso(now)}
        from public.billing_invoices i
        join public.billing_subscriptions s on s.store_id = i.store_id
        left join lateral (
          select pa.id, pa.provider_payment_id, pa.provider_order_id
            from public.billing_payment_attempts pa
           where pa.invoice_id = i.id and pa.state = 'captured'
           order by pa.created_at desc
           limit 1) a on true
       where i.kind = 'subscription'
         and i.status = 'paid'
         and coalesce(i.paid_at, i.updated_at) < ${hourAgo}
         and s.state in ('cancelled', 'downgraded')
         and i.cycle_seq > s.current_cycle_seq
         and not exists (
           select 1 from public.billing_reconciliation_items x
            where x.detail ->> 'repair_key' = 'paid_unreached:' || i.id::text)
         and not exists (
           select 1 from public.billing_reconciliation_items y
            where y.kind = 'state_conflict' and y.status = 'open'
              and y.provider_payment_id = a.provider_payment_id)
       order by i.updated_at
       limit ${limit}
      on conflict do nothing
      returning id, invoice_id`,
  );

  // 1c. A payment older code kept on an invoice it marked uncollectible,
  // before automatic refunds existed (D7, review finding 15). ★ A missing
  // settings row means no line at all ("infinity"): every one is history.
  await fileRepairItems(
    ctx,
    "kept_before_refunds",
    sql`
      insert into public.billing_reconciliation_items
        (store_id, kind, status, invoice_id, attempt_id, provider_payment_id,
         provider_order_id, expected_paise, detail, created_at, updated_at)
      select i.store_id, 'state_conflict', 'open', i.id, a.id, a.provider_payment_id,
             a.provider_order_id, a.amount_paise,
             jsonb_build_object(
               'repair_key', 'kept_before_refunds:' || a.id,
               'note', 'payment kept after the plan ended, before automatic refunds',
               'invoiceRef', i.invoice_ref)
             || case when i.store_id is null
                     then jsonb_build_object('storeDeleted', true)
                     else '{}'::jsonb end,
             ${iso(now)}, ${iso(now)}
        from public.billing_payment_attempts a
        join public.billing_invoices i on i.id = a.invoice_id
       where a.state = 'captured'
         and i.kind = 'subscription'
         and i.status = 'uncollectible'
         and i.finalized_at is not null
         and coalesce(a.resolved_at, a.updated_at)
             < coalesce(${ctx.settings.automaticRefundsFrom}::timestamptz, 'infinity'::timestamptz)
         and not exists (
           select 1 from public.billing_refunds r where r.attempt_id = a.id)
         and not exists (
           select 1 from public.billing_reconciliation_items x
            where x.detail ->> 'repair_key' = 'kept_before_refunds:' || a.id::text)
         and not exists (
           select 1 from public.billing_reconciliation_items y
            where y.kind = 'state_conflict' and y.status = 'open'
              and y.provider_payment_id = a.provider_payment_id)
       order by i.updated_at
       limit ${limit}
      on conflict do nothing
      returning id, attempt_id`,
  );
}

/**
 * File repair items with one statement. ★ Each item carries a `repair_key`
 * that `billing_reconciliation_repair_once` holds unique in EVERY status, the
 * selection skips keys already filed, and the insert is ON CONFLICT DO
 * NOTHING: an item is filed once, ever, so one an operator resolved without
 * refunding (D7's alternative) never comes back. The selections also skip a
 * payment that already has an open `state_conflict` item, which
 * `billing_reconciliation_open_key` would make the insert drop silently;
 * without that the same row would be selected, and dropped, every hour.
 */
async function fileRepairItems(
  ctx: PassContext,
  kind: "paid_unreached" | "kept_before_refunds",
  statement: SQL,
): Promise<void> {
  try {
    const res = await withService((db) => db.execute(statement));
    const filed = rowsOf(res);
    ctx.summary.flaggedForPerson += filed.length;
    if (filed.length >= ctx.limit) ctx.summary.more = true;
    if (filed.length) {
      logInfo("billing.refunds.repair_filed", {
        kind,
        items: filed.map((r) => r.id),
      });
    }
  } catch (err) {
    logError(`billing.refunds.repair_${kind}`, err);
    ctx.summary.errors += 1;
  }
}

// ── Step 2: detect ──────────────────────────────────────────────────────────

/** A captured payment the pass found on a closed invoice. */
export interface OwedPaymentCandidate {
  attemptId: string;
  invoiceId: string;
  amountPaise: number;
  providerPaymentId: string | null;
  invoiceRef: string | null;
}

/**
 * Is this payment new money on a closed invoice, and still un-refunded? The
 * same predicate selects the candidates and re-checks one under its lock.
 *
 * ★ A `void` invoice needs no history line: nothing wrote `void` before this
 * release, so every one is this release's decision whatever the payment's
 * date. An `uncollectible` one is history before `automatic_refunds_from`.
 * ★ A payment with a system refund in ANY status, or any refund still live or
 * finished, is left alone: one automatic refund per payment, ever, and a
 * payment an operator is already refunding is theirs.
 */
function owedPredicate(from: string | null): SQL {
  return sql`a.state = 'captured'
     and i.kind = 'subscription'
     and i.finalized_at is not null
     and (i.status = 'void'
          or (i.status = 'uncollectible'
              and coalesce(a.resolved_at, a.updated_at)
                  >= coalesce(${from}::timestamptz, 'infinity'::timestamptz)))
     and not exists (
       select 1 from public.billing_refunds r
        where r.attempt_id = a.id
          and (r.requested_by = 'system' or r.status not in ('failed', 'cancelled')))
     and not exists (
       select 1 from public.billing_reconciliation_items x
        where x.detail ->> 'repair_key' = 'refund_refused:' || a.id::text)`;
}

async function detect(ctx: PassContext): Promise<void> {
  const { limit, summary } = ctx;
  let candidates: OwedPaymentCandidate[];
  try {
    const res = await withService((db) =>
      db.execute(sql`
        select a.id, a.invoice_id, a.amount_paise, a.provider_payment_id, i.invoice_ref
          from public.billing_payment_attempts a
          join public.billing_invoices i on i.id = a.invoice_id
         where ${owedPredicate(ctx.settings.automaticRefundsFrom)}
         order by i.updated_at
         limit ${limit}`),
    );
    candidates = rowsOf(res).map((r) => ({
      attemptId: String(r.id),
      invoiceId: String(r.invoice_id),
      amountPaise: num(r.amount_paise),
      providerPaymentId: textOrNull(r.provider_payment_id),
      invoiceRef: textOrNull(r.invoice_ref),
    }));
  } catch (err) {
    logError("billing.refunds.detect_scan", err);
    summary.errors += 1;
    return;
  }
  if (candidates.length >= limit) summary.more = true;

  for (const candidate of candidates) {
    const outcome = await detectOwedRefund(candidate, {
      now: ctx.now,
      automaticRefundsFrom: ctx.settings.automaticRefundsFrom,
    });
    if (outcome === "owed") summary.detected += 1;
    else if (outcome === "filed") summary.flaggedForPerson += 1;
    else if (outcome === "error") summary.errors += 1;
  }
}

/**
 * Write the one automatic refund a payment on a closed invoice is owed.
 *
 * ★★ LOCK, RE-CHECK, THEN INSERT, in its own transaction (review finding 7).
 * Two overlapping runs (a Scheduler retry, a run by hand) both select the
 * payment; the second waits on the attempt's row lock, and its re-check, a
 * NEW statement that reads what the first committed, finds the first's row
 * and skips. The re-check cannot be part of the locking statement: a READ
 * COMMITTED `select ... for update` that waited re-reads only the locked row,
 * and its subqueries keep the snapshot taken before the wait. ON CONFLICT
 * alone is not enough either: `billing_refunds_guard`'s cap check runs in the
 * BEFORE INSERT trigger, ahead of any arbiter, and raises.
 *
 * A refusal (the guard, a CHECK) is a no-op when a system refund for the
 * payment exists, and otherwise goes to a person (`refund_refused:`).
 *
 * Exported for the opt-in local test, which runs two detections of one
 * payment; the pass is the only production caller.
 */
export async function detectOwedRefund(
  candidate: OwedPaymentCandidate,
  opts: { now: Date; automaticRefundsFrom: string | null },
): Promise<"owed" | "skipped" | "filed" | "noop" | "error"> {
  const now = iso(opts.now);
  try {
    const owed = await withService(async (db) => {
      await db.execute(sql`
        select 1 from public.billing_payment_attempts
         where id = ${candidate.attemptId}
           for update`);
      const recheck = await db.execute(sql`
        select a.amount_paise, a.provider_payment_id
          from public.billing_payment_attempts a
          join public.billing_invoices i on i.id = a.invoice_id
         where a.id = ${candidate.attemptId}
           and ${owedPredicate(opts.automaticRefundsFrom)}`);
      const live = rowsOf(recheck)[0];
      if (!live) return null;
      const inserted = await db.execute(sql`
        insert into public.billing_refunds
          (invoice_id, attempt_id, reason, status, method, amount_paise,
           idempotency_key, provider_payment_id, requested_by, created_at, updated_at)
        values (${candidate.invoiceId}, ${candidate.attemptId}, 'cycle_not_reached',
                'owed', 'razorpay', ${num(live.amount_paise)}, ${newRefundKey()},
                ${textOrNull(live.provider_payment_id)}, 'system', ${now}, ${now})
        returning id`);
      return String(rowsOf(inserted)[0]?.id ?? "") || null;
    });
    if (!owed) return "skipped";
    logInfo("billing.refund_owed", {
      refundId: owed,
      attemptId: candidate.attemptId,
      invoiceId: candidate.invoiceId,
      invoiceRef: candidate.invoiceRef,
      amountPaise: candidate.amountPaise,
    });
    return "owed";
  } catch (err) {
    if (!isRefusal(err)) {
      logError("billing.refunds.detect_one", err, {
        attemptId: candidate.attemptId,
      });
      return "error";
    }
    return refusedDetection(candidate, now, dbErrorMessage(err, "refused"));
  }
}

async function refusedDetection(
  candidate: OwedPaymentCandidate,
  now: string,
  reason: string,
): Promise<"filed" | "noop" | "error"> {
  try {
    return await withService(async (db) => {
      const existing = await db.execute(sql`
        select 1 from public.billing_refunds
         where attempt_id = ${candidate.attemptId} and requested_by = 'system'
         limit 1`);
      // The other run's refund is already there: nothing to decide.
      if (rowsOf(existing).length) return "noop" as const;
      logError(
        "billing.refund_detect_refused",
        new Error("an automatic refund was refused"),
        {
          attemptId: candidate.attemptId,
          invoiceId: candidate.invoiceId,
          reason,
        },
      );
      await db.execute(sql`
        insert into public.billing_reconciliation_items
          (store_id, kind, status, invoice_id, attempt_id, provider_payment_id,
           expected_paise, detail, created_at, updated_at)
        select i.store_id, 'state_conflict', 'open', i.id, a.id, a.provider_payment_id,
               a.amount_paise,
               jsonb_build_object(
                 'repair_key', 'refund_refused:' || a.id,
                 'note', 'an automatic refund was refused',
                 'reason', ${reason.slice(0, 500)}::text,
                 'invoiceRef', i.invoice_ref)
               || case when i.store_id is null
                       then jsonb_build_object('storeDeleted', true)
                       else '{}'::jsonb end,
               ${now}, ${now}
          from public.billing_payment_attempts a
          join public.billing_invoices i on i.id = a.invoice_id
         where a.id = ${candidate.attemptId}
        on conflict do nothing`);
      return "filed" as const;
    });
  } catch (err) {
    logError("billing.refunds.detect_refusal", err, {
      attemptId: candidate.attemptId,
    });
    return "error";
  }
}

// ── Step 3: send ────────────────────────────────────────────────────────────

/** What one send did. */
export type SendOutcome =
  | { status: "processed"; providerRefundId: string }
  | { status: "pending" }
  | { status: "failed"; failureReason: string }
  /** Another sender claimed it first, or it is no longer owed. */
  | { status: "not_claimed" };

async function send(ctx: PassContext): Promise<void> {
  const { summary, limit, refund, settings } = ctx;
  // ★ No platform credentials: nothing is sent (the gateway.ts rule).
  if (!refund) return;

  // ★★ SYSTEM ROWS ONLY WHILE AUTOMATIC SENDING IS ON (D2 ships it off).
  // Operator rows always: the console sends at once, so one still owed here
  // means that call died. Filtered in the query, so held system rows never
  // take an operator row's place in the batch.
  const onlyOperators = settings.autoRefunds
    ? sql``
    : sql`and r.requested_by <> 'system'`;
  let ids: { id: string; requestedBy: string }[];
  try {
    const res = await withService((db) =>
      db.execute(sql`
        select r.id, r.requested_by
          from public.billing_refunds r
         where r.status = 'owed'
           ${onlyOperators}
         order by r.created_at
         limit ${limit}`),
    );
    ids = rowsOf(res).map((r) => ({
      id: String(r.id),
      requestedBy: String(r.requested_by),
    }));
  } catch (err) {
    logError("billing.refunds.send_scan", err);
    summary.errors += 1;
    return;
  }
  if (ids.length >= limit) summary.more = true;

  for (const row of ids) {
    // The belt to the query's braces: a held system row is never sent.
    if (!settings.autoRefunds && row.requestedBy === "system") continue;
    try {
      const outcome = await sendOwedRefund(row.id, {
        refund,
        now: ctx.now,
      });
      if (outcome.status === "not_claimed") continue;
      summary.sent += 1;
      if (outcome.status === "processed") summary.processed += 1;
      else if (outcome.status === "failed") summary.failed += 1;
      else summary.stillPending += 1;
    } catch (err) {
      logError("billing.refunds.send_one", err, { refundId: row.id });
      summary.errors += 1;
    }
  }
}

/**
 * Send one owed refund: CLAIM, call Razorpay once, settle.
 *
 * ★★ THE CLAIM COMES FIRST AND COMMITS ON ITS OWN (`owed` to `pending`,
 * `sent_at`), and only the claimer calls the gateway, with the row's own key.
 * Two senders (the pass and an operator's Send, or two runs) cannot both send:
 * the second claims nothing. A database error AFTER the call leaves the row
 * pending, which step 4 settles by its key; it is never sent again.
 *
 * Throws only when the claim itself cannot be written (nothing was sent).
 */
export async function sendOwedRefund(
  refundId: string,
  opts: { refund: RefundFn; now?: Date },
): Promise<SendOutcome> {
  const now = iso(opts.now ?? new Date());
  const claimed = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        update public.billing_refunds r
           set status = 'pending', sent_at = ${now}, updated_at = ${now}
          from public.billing_invoices i
         where r.id = ${refundId}
           and r.status = 'owed'
           and i.id = r.invoice_id
        returning r.id, r.idempotency_key, r.provider_payment_id, r.amount_paise,
                  r.reason, r.invoice_id, i.invoice_ref`),
    ),
  );
  const row = claimed[0];
  if (!row) return { status: "not_claimed" };

  const key = String(row.idempotency_key);
  let result: RzpResult<RzpRefund>;
  try {
    result = await opts.refund({
      paymentId: String(row.provider_payment_id ?? ""),
      amountPaise: num(row.amount_paise),
      idempotencyKey: key,
      notes: {
        sm_refund_key: key,
        sm_invoice: String(row.invoice_ref ?? row.invoice_id),
        sm_reason: String(row.reason),
      },
    });
  } catch (err) {
    // A throw is not a verdict: the refund may exist. Step 4 asks.
    result = {
      ok: false,
      error: err instanceof Error ? err.message : "Razorpay request failed",
      outcome: "unknown",
    };
  }
  logInfo("billing.refund_sent", {
    refundId,
    invoiceId: row.invoice_id,
    amountPaise: num(row.amount_paise),
    ok: result.ok,
  });
  return settleSendResult(refundId, result, opts.now ?? new Date());
}

async function settleSendResult(
  refundId: string,
  result: RzpResult<RzpRefund>,
  at: Date,
): Promise<SendOutcome> {
  if (!result.ok) {
    if (result.outcome === "unknown") {
      // ★ AN UNKNOWN OUTCOME IS NOT A FAILURE (§26): failing it here is how
      // a merchant gets paid twice. It stays pending with no refund id.
      logWarn("billing.refund_send_unknown", {
        refundId,
        error: result.error,
      });
      return { status: "pending" };
    }
    const failureReason = gatewayReason(
      result.error,
      "Razorpay refused the refund.",
    );
    await failPending(refundId, failureReason, null, at);
    return { status: "failed", failureReason };
  }
  return settleGatewayRefund(refundId, result.data, at);
}

/** Settle a pending row from what Razorpay says about its refund. */
async function settleGatewayRefund(
  refundId: string,
  gateway: RzpRefund,
  at: Date,
): Promise<SendOutcome> {
  const providerRefundId = textOrNull(gateway.id);
  const mapped = mapGatewayRefundStatus(String(gateway.status ?? ""));
  if (mapped === "completed" && providerRefundId) {
    const done = await withService(async (db) =>
      rowsOf(
        await db.execute(sql`
          update public.billing_refunds
             set status = 'processed',
                 provider_refund_id = coalesce(provider_refund_id, ${providerRefundId}),
                 resolved_at = ${iso(at)},
                 updated_at = ${iso(at)}
           where id = ${refundId} and status = 'pending'
          returning id`),
      ),
    );
    if (done.length) {
      logInfo("billing.refund_processed", { refundId, providerRefundId });
    }
    return { status: "processed", providerRefundId };
  }
  if (mapped === "failed") {
    const failureReason = "Razorpay reported the refund failed.";
    await failPending(refundId, failureReason, providerRefundId, at);
    return { status: "failed", failureReason };
  }
  // Still on its way (or an id we have not seen yet): keep it pending, and
  // keep the refund id the first time we learn it.
  if (providerRefundId) {
    await withService((db) =>
      db.execute(sql`
        update public.billing_refunds
           set provider_refund_id = ${providerRefundId}, updated_at = ${iso(at)}
         where id = ${refundId}
           and status = 'pending'
           and provider_refund_id is null`),
    );
  }
  return { status: "pending" };
}

/**
 * Fail a pending refund. ★ `billing.refund_failed` is the line the alert
 * "Billing: a refund to a merchant failed" matches (scripts/prod-monitoring.py):
 * the merchant was told a refund is coming, so a person must act.
 */
async function failPending(
  refundId: string,
  failureReason: string,
  providerRefundId: string | null,
  at: Date,
): Promise<void> {
  const failed = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        update public.billing_refunds
           set status = 'failed',
               failure_reason = ${failureReason},
               provider_refund_id = coalesce(provider_refund_id, ${providerRefundId}),
               resolved_at = ${iso(at)},
               updated_at = ${iso(at)}
         where id = ${refundId} and status = 'pending'
        returning id, invoice_id, attempt_id, amount_paise, requested_by`),
    ),
  );
  const row = failed[0];
  if (!row) return;
  logError("billing.refund_failed", new Error(failureReason), {
    refundId,
    invoiceId: row.invoice_id,
    attemptId: row.attempt_id,
    amountPaise: num(row.amount_paise),
    automatic: row.requested_by === "system",
  });
}

// ── Step 4: reconcile ───────────────────────────────────────────────────────

async function reconcile(ctx: PassContext): Promise<void> {
  const { summary, limit, now, fetchRefunds } = ctx;
  if (!fetchRefunds) return;

  let rows: Row[];
  try {
    const res = await withService((db) =>
      db.execute(sql`
        select r.id, r.idempotency_key, r.provider_payment_id,
               (r.sent_at < ${before(now, NO_RECORD_AFTER_MS)}) as overdue
          from public.billing_refunds r
         where r.status = 'pending'
           and r.sent_at < ${before(now, SETTLE_AFTER_MS)}
         order by r.sent_at
         limit ${limit}`),
    );
    rows = rowsOf(res);
  } catch (err) {
    logError("billing.refunds.reconcile_scan", err);
    summary.errors += 1;
    return;
  }
  if (rows.length >= limit) summary.more = true;

  for (const row of rows) {
    const refundId = String(row.id);
    try {
      const outcome = await settlePendingRefund(
        {
          refundId,
          idempotencyKey: String(row.idempotency_key),
          providerPaymentId: textOrNull(row.provider_payment_id),
          overdue: row.overdue === true,
        },
        fetchRefunds,
        now,
      );
      if (outcome === "processed") summary.processed += 1;
      else if (outcome === "failed") summary.failed += 1;
      else summary.stillPending += 1;
    } catch (err) {
      logError("billing.refunds.reconcile_one", err, { refundId });
      summary.errors += 1;
    }
  }
}

/**
 * Settle one pending refund against Razorpay's list for its payment.
 *
 * ★ MATCHED BY KEY (`notes.sm_refund_key`), NEVER BY AMOUNT: two refunds of
 * one payment can be the same amount. Not in the list: left alone for 30
 * minutes after sending, then failed ("Razorpay has no record of this
 * refund."), the order-refund rule. A list we could not read is not a verdict.
 */
async function settlePendingRefund(
  row: {
    refundId: string;
    idempotencyKey: string;
    providerPaymentId: string | null;
    overdue: boolean;
  },
  fetchRefunds: FetchRefundsFn,
  now: Date,
): Promise<"processed" | "failed" | "pending"> {
  if (!row.providerPaymentId) return "pending";
  let found: RzpRefund | null = null;
  let complete = false;
  for (let page = 0; page < MAX_REFUND_PAGES; page++) {
    const list = await fetchRefunds(row.providerPaymentId, {
      count: RZP_REFUND_PAGE_SIZE,
      skip: page * RZP_REFUND_PAGE_SIZE,
    });
    if (!list.ok) return "pending";
    found = matchGatewayRefund(list.data, row.idempotencyKey);
    if (found) break;
    if (list.data.length < RZP_REFUND_PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (found) {
    const settled = await settleGatewayRefund(row.refundId, found, now);
    return settled.status === "processed" || settled.status === "failed"
      ? settled.status
      : "pending";
  }
  // More refunds than we read cannot be ruled out: unknown, not absent.
  if (!complete || !row.overdue) return "pending";
  await failPending(
    row.refundId,
    "Razorpay has no record of this refund.",
    null,
    now,
  );
  return "failed";
}

// ── Step 5: credit notes ────────────────────────────────────────────────────

async function creditNotes(ctx: PassContext): Promise<void> {
  const { summary, limit } = ctx;

  // For each completed refund (not a duplicate payment) with no note, while
  // its invoice has anything left to credit. ★ "Left to credit" is in the
  // query, so a refund whose invoice is already fully credited (edge case 4)
  // is not selected again every hour.
  let refunds: string[] = [];
  try {
    const res = await withService((db) =>
      db.execute(sql`
        select r.id
          from public.billing_refunds r
          join public.billing_invoices i on i.id = r.invoice_id
         where r.status in ('processed', 'recorded')
           and r.reason <> 'duplicate_payment'
           and i.finalized_at is not null
           and not exists (
             select 1 from public.billing_credit_notes n where n.refund_id = r.id)
           and i.total_paise > coalesce((
             select sum(n.total_paise) from public.billing_credit_notes n
              where n.invoice_id = i.id), 0)
         order by r.resolved_at
         limit ${limit}`),
    );
    refunds = rowsOf(res).map((r) => String(r.id));
  } catch (err) {
    logError("billing.refunds.notes_scan", err);
    summary.errors += 1;
  }
  if (refunds.length >= limit) summary.more = true;
  for (const refundId of refunds) {
    try {
      const result = await issueCreditNote({
        kind: "refund",
        refundId,
        issuedBy: "system",
      });
      if (result.outcome === "issued") summary.creditNotes += 1;
    } catch (err) {
      logError("billing.refunds.note_one", err, { refundId });
      summary.errors += 1;
    }
  }

  // D3: a closed unpaid subscription invoice that charged GST is cancelled by
  // a note, once no payment on it is captured or still in flight.
  let invoices: string[] = [];
  try {
    const res = await withService((db) =>
      db.execute(sql`
        select i.id
          from public.billing_invoices i
         where i.kind = 'subscription'
           and i.status in ('void', 'uncollectible')
           and i.finalized_at is not null
           and i.tax_paise > 0
           and not exists (
             select 1 from public.billing_credit_notes n where n.invoice_id = i.id)
           and not exists (
             select 1 from public.billing_payment_attempts a
              where a.invoice_id = i.id
                and a.state in ('created', 'processing', 'authorized', 'unknown', 'captured', 'refunded'))
         order by i.updated_at
         limit ${limit}`),
    );
    invoices = rowsOf(res).map((r) => String(r.id));
  } catch (err) {
    logError("billing.refunds.cancel_notes_scan", err);
    summary.errors += 1;
  }
  if (invoices.length >= limit) summary.more = true;
  for (const invoiceId of invoices) {
    try {
      const result = await issueCreditNote({
        kind: "invoice_cancelled",
        invoiceId,
        issuedBy: "system",
      });
      if (result.outcome === "issued") summary.creditNotes += 1;
    } catch (err) {
      logError("billing.refunds.cancel_note_one", err, { invoiceId });
      summary.errors += 1;
    }
  }
}

// ── Step 7: tell the merchant ───────────────────────────────────────────────

async function notify(ctx: PassContext): Promise<void> {
  const { summary, limit, now } = ctx;
  let rows: Row[];
  try {
    // ★ Ready when its credit note exists, or needs none (a duplicate
    // payment, or nothing left on the invoice to credit), or failed to issue
    // for over an hour: the merchant is not kept waiting on a document.
    const res = await withService((db) =>
      db.execute(sql`
        select r.id, r.reason,
               exists (select 1 from public.billing_credit_notes n
                        where n.refund_id = r.id) as has_note,
               (i.total_paise <= coalesce((
                  select sum(n.total_paise) from public.billing_credit_notes n
                   where n.invoice_id = r.invoice_id), 0)) as fully_credited
          from public.billing_refunds r
          join public.billing_invoices i on i.id = r.invoice_id
         where r.status in ('processed', 'recorded')
           and r.notified_at is null
           and (r.reason = 'duplicate_payment'
                or exists (select 1 from public.billing_credit_notes n
                            where n.refund_id = r.id)
                or i.total_paise <= coalesce((
                     select sum(n.total_paise) from public.billing_credit_notes n
                      where n.invoice_id = r.invoice_id), 0)
                or r.resolved_at < ${before(now, NOTE_GRACE_MS)})
         order by r.resolved_at
         limit ${limit}`),
    );
    rows = rowsOf(res);
  } catch (err) {
    logError("billing.refunds.notify_scan", err);
    summary.errors += 1;
    return;
  }
  if (rows.length >= limit) summary.more = true;

  for (const row of rows) {
    const refundId = String(row.id);
    if (
      row.has_note !== true &&
      row.reason !== "duplicate_payment" &&
      row.fully_credited !== true
    ) {
      logWarn("billing.refund_notice_without_note", { refundId });
    }
    try {
      if (await tellMerchantRefund(refundId, now)) summary.notified += 1;
    } catch (err) {
      logError("billing.refunds.notify_one", err, { refundId });
      summary.errors += 1;
    }
  }
}

/**
 * Tell the merchant that one finished refund reached them, exactly once.
 *
 * ★★ THE `notified_at` CLAIM COMES FIRST, and the email only after it
 * commits: `update ... set notified_at where notified_at is null` returns the
 * row to one caller only, whether the pass, the console's Send or a recorded
 * refund finished it. The credit note's particulars are read in the same
 * transaction as the claim, so a failed read undoes the claim and the next
 * run tries again, rather than mailing a closed store "keep this email as your
 * credit note" without the note in it.
 *
 * Returns whether this call sent the notice. Throws on a database error
 * (nothing was claimed).
 */
export async function tellMerchantRefund(
  refundId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const claimed = await withService(async (db) => {
    const res = await db.execute(sql`
      update public.billing_refunds
         set notified_at = ${iso(now)}, updated_at = ${iso(now)}
       where id = ${refundId}
         and notified_at is null
         and status in ('processed', 'recorded')
      returning id, status`);
    const row = rowsOf(res)[0];
    if (!row) return null;
    const creditNote = await creditNoteParticulars({ refundId }, db);
    return { status: String(row.status), creditNote };
  });
  if (!claimed) return false;

  // Best-effort and never throws (receipts.ts), as every billing email is.
  if (claimed.status === "processed") {
    await notifyRefundSent(refundId, { creditNote: claimed.creditNote });
  } else {
    await notifyRefundRecorded(refundId, { creditNote: claimed.creditNote });
  }
  return true;
}

// ── Step 8: the waiting check ───────────────────────────────────────────────

/** What waits for a person, counted the same way for the alert and the page. */
export interface RefundsNeedingAction {
  /** Failed, with no later refund of the same payment. */
  failed: number;
  /** Owed for more than a day. */
  owed: number;
  /** Sent more than a day ago and still waiting for Razorpay. */
  pending: number;
  /** Owed automatic refunds held while automatic sending is off. */
  held: number;
  /** Rows matching any of the above (each counted once). */
  total: number;
  /** When the oldest of the failed, owed or pending ones was created. */
  oldestAt: string | null;
}

function needsActionFlags(now: Date, autoRefunds: boolean): SQL {
  const dayAgo = before(now, WAITING_AFTER_MS);
  return sql`
    (r.status = 'failed'
      and not exists (
        select 1 from public.billing_refunds l
         where l.attempt_id = r.attempt_id and l.created_at > r.created_at)) as failed_alone,
    (r.status = 'owed' and r.created_at < ${dayAgo}) as owed_late,
    (r.status = 'pending' and r.sent_at < ${dayAgo}) as pending_late,
    (r.status = 'owed' and r.requested_by = 'system' and ${!autoRefunds}::boolean) as held`;
}

/**
 * The refunds a person must look at (the console's banner, the "Needs a
 * person" tab and the daily alert all count with this): a failed refund
 * nothing was done about since, anything owed or sent more than a day ago,
 * and, while automatic sending is off, every owed automatic refund.
 */
export async function countRefundsNeedingAction(
  input: { now?: Date; autoRefunds?: boolean; db?: Db } = {},
): Promise<RefundsNeedingAction> {
  const now = input.now ?? new Date();
  const run = async (db: Db): Promise<RefundsNeedingAction> => {
    const autoRefunds =
      input.autoRefunds ?? (await getRefundSettings(db)).autoRefunds;
    const res = await db.execute(sql`
      with flagged as (
        select r.created_at, ${needsActionFlags(now, autoRefunds)}
          from public.billing_refunds r
         where r.status in ('owed', 'pending', 'failed'))
      select count(*) filter (where failed_alone) as failed,
             count(*) filter (where owed_late) as owed,
             count(*) filter (where pending_late) as pending,
             count(*) filter (where held) as held,
             count(*) filter (where failed_alone or owed_late or pending_late or held) as total,
             min(created_at) filter (where failed_alone or owed_late or pending_late) as oldest_at
        from flagged`);
    const row = rowsOf(res)[0] ?? {};
    return {
      failed: num(row.failed),
      owed: num(row.owed),
      pending: num(row.pending),
      held: num(row.held),
      total: num(row.total),
      oldestAt: textOrNull(row.oldest_at),
    };
  };
  return input.db ? run(input.db) : withService(run);
}

async function waitingCheck(ctx: PassContext): Promise<void> {
  // ★ Once a day: the billing cron runs every hour at :20, so exactly one run
  // falls in the 09:00 IST hour. The console's banner shows the same count
  // all day.
  if (istHour(ctx.now) !== WAITING_CHECK_IST_HOUR) return;
  let counts: RefundsNeedingAction;
  try {
    counts = await countRefundsNeedingAction({
      now: ctx.now,
      autoRefunds: ctx.settings.autoRefunds,
    });
  } catch (err) {
    logError("billing.refunds.waiting_scan", err);
    ctx.summary.errors += 1;
    return;
  }
  const waiting = counts.owed + counts.pending + counts.failed;
  ctx.summary.waiting = waiting;
  if (waiting === 0) return;
  // ★ The line the daily alert "Billing: refunds waiting more than a day"
  // matches. Counted in `waiting`, never in `errors`: it is a person's job.
  logWarn("billing.refund_waiting", {
    owed: counts.owed,
    pending: counts.pending,
    failed: counts.failed,
    oldestAt: counts.oldestAt,
  });
}

// ── The console's helpers ───────────────────────────────────────────────────

/** What a console write did. `refundId` names the row it wrote or moved. */
export type RefundActionResult =
  | { ok: true; refundId: string; status: RefundStatus }
  | { ok: false; error: string; refundId?: string };

/**
 * After a console path finished a refund (processed, or recorded): its credit
 * note, then the merchant's email, exactly as the pass's steps 5 and 7 would.
 * A note that will not issue now leaves the email to the pass, which sends it
 * once the note exists or an hour has passed. Never throws.
 */
export async function finishRefund(
  refundId: string,
  opts: { issuedBy: string; now?: Date },
): Promise<{ creditNoteRef: string | null; notified: boolean }> {
  let creditNoteRef: string | null = null;
  try {
    const note = await issueCreditNote({
      kind: "refund",
      refundId,
      issuedBy: opts.issuedBy,
    });
    if (note.outcome === "issued" || note.outcome === "exists") {
      creditNoteRef = note.note.creditNoteRef;
    } else if (note.outcome === "not_ready" || note.outcome === "not_found") {
      return { creditNoteRef: null, notified: false };
    }
  } catch (err) {
    logError("billing.refunds.finish_note", err, { refundId });
    return { creditNoteRef: null, notified: false };
  }
  try {
    const notified = await tellMerchantRefund(refundId, opts.now);
    return { creditNoteRef, notified };
  } catch (err) {
    logError("billing.refunds.finish_notify", err, { refundId });
    return { creditNoteRef, notified: false };
  }
}

/** Turn a send outcome into the console's answer, finishing it if done. */
async function sendForOperator(
  refundId: string,
  refund: RefundFn | null,
  opts: { issuedBy: string; now: Date },
): Promise<RefundActionResult> {
  // No gateway: the refund stays owed, on the Refunds page, until it can go.
  if (!refund) return { ok: true, refundId, status: "owed" };
  let outcome: SendOutcome;
  try {
    outcome = await sendOwedRefund(refundId, { refund, now: opts.now });
  } catch (err) {
    logError("billing.refunds.operator_send", err, { refundId });
    return { ok: false, error: SAVE_FAILED_MESSAGE, refundId };
  }
  if (outcome.status === "not_claimed") {
    return { ok: false, error: MOVED_ON_MESSAGE, refundId };
  }
  if (outcome.status === "failed") {
    return {
      ok: false,
      error: refusedMessage(outcome.failureReason),
      refundId,
    };
  }
  if (outcome.status === "processed") {
    await finishRefund(refundId, opts);
    return { ok: true, refundId, status: "processed" };
  }
  return { ok: true, refundId, status: "pending" };
}

function cleanNote(note: unknown): string {
  return typeof note === "string" ? note.trim().slice(0, 1000) : "";
}

function cleanOperator(operator: unknown): string {
  return typeof operator === "string" ? operator.trim() : "";
}

interface LockedPayment {
  attemptId: string;
  invoiceId: string;
  state: string;
  amountPaise: number;
  providerPaymentId: string | null;
  storeId: string | null;
  kind: string;
  invoiceStatus: string;
  issued: boolean;
  cycleSeq: number | null;
  subscriptionCycleSeq: number | null;
}

/**
 * Lock a payment of an invoice and read what the console's rules need. The
 * attempt row is the lock `billing_refunds_guard` takes too, so a refund
 * decided here and the pass's detection take turns.
 */
async function lockPayment(
  db: Db,
  invoiceId: string,
  attemptId: string,
): Promise<LockedPayment | null> {
  const res = await db.execute(sql`
    select a.id, a.invoice_id, a.state, a.amount_paise, a.provider_payment_id,
           i.store_id, i.kind, i.status, (i.finalized_at is not null) as issued,
           i.cycle_seq, s.current_cycle_seq
      from public.billing_payment_attempts a
      join public.billing_invoices i on i.id = a.invoice_id
      left join public.billing_subscriptions s on s.store_id = i.store_id
     where a.id = ${attemptId}
       and a.invoice_id = ${invoiceId}
       for update of a`);
  const row = rowsOf(res)[0];
  if (!row) return null;
  return {
    attemptId: String(row.id),
    invoiceId: String(row.invoice_id),
    state: String(row.state),
    amountPaise: num(row.amount_paise),
    providerPaymentId: textOrNull(row.provider_payment_id),
    storeId: textOrNull(row.store_id),
    kind: String(row.kind),
    invoiceStatus: String(row.status),
    issued: row.issued === true,
    cycleSeq: row.cycle_seq == null ? null : num(row.cycle_seq),
    subscriptionCycleSeq:
      row.current_cycle_seq == null ? null : num(row.current_cycle_seq),
  };
}

/** Live and finished refunds of a payment: the guard's own cap rule. */
async function usedOnPayment(db: Db, attemptId: string): Promise<number> {
  const res = await db.execute(sql`
    select coalesce(sum(amount_paise), 0) as used
      from public.billing_refunds
     where attempt_id = ${attemptId}
       and status not in ('failed', 'cancelled')`);
  return num(rowsOf(res)[0]?.used);
}

/** The console's rules for a payment, checked under its lock. */
function paymentRefusal(
  payment: LockedPayment | null,
  input: { storeId?: string | null; reason: string },
): string | null {
  if (!payment) return NOT_FOUND_MESSAGE;
  // `undefined` skips the store check; null means "a deleted store's invoice"
  // (the reconciliation queue's items), so the invoice must have no store.
  if (input.storeId !== undefined && payment.storeId !== input.storeId) {
    return OTHER_STORE_MESSAGE;
  }
  if (!payment.issued) return NOT_ISSUED_MESSAGE;
  if (payment.state !== "captured" && payment.state !== "refunded") {
    return NOT_CAPTURED_MESSAGE;
  }
  if (input.reason === "cycle_not_reached" && !cycleNotReached(payment)) {
    return CYCLE_RULE_MESSAGE;
  }
  return null;
}

/**
 * "Plan ended before this cycle" fits a closed invoice, a paid renewal above
 * the plan's last reached cycle, or a deleted store's (design 6.8; the
 * reconciliation queue's D7 items).
 */
function cycleNotReached(payment: LockedPayment): boolean {
  if (payment.kind !== "subscription") return false;
  if (["void", "uncollectible"].includes(payment.invoiceStatus)) return true;
  if (payment.invoiceStatus !== "paid") return false;
  if (payment.storeId === null) return true;
  return (payment.cycleSeq ?? 0) > (payment.subscriptionCycleSeq ?? 0);
}

/**
 * An operator's refund of (part of) one payment: written owed, then sent at
 * once (the design's "Issue a refund", and each line of "End the plan now").
 *
 * The amount is checked against what is left on the payment, under its lock;
 * a Razorpay refund is at least ₹1; "Plan ended before this cycle" only where
 * it fits; a duplicate payment gets no credit note (issueCreditNote's rule).
 */
export async function createOperatorRefund(input: {
  /** The store the operator is looking at; null for a deleted store's
   *  invoice; omitted to skip the check. */
  storeId?: string | null;
  invoiceId: string;
  attemptId: string;
  amountPaise: number;
  reason: RefundReason;
  note: string;
  operator: string;
  now?: Date;
  refund?: RefundFn | null;
}): Promise<RefundActionResult> {
  const now = input.now ?? new Date();
  const note = cleanNote(input.note);
  const operator = cleanOperator(input.operator);
  if (!note) return { ok: false, error: NOTE_REQUIRED_MESSAGE };
  if (!REFUND_REASONS.includes(input.reason)) {
    return { ok: false, error: REASON_REQUIRED_MESSAGE };
  }
  if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100) {
    return { ok: false, error: BELOW_MINIMUM_MESSAGE };
  }
  if (!operator || !isUuid(input.invoiceId) || !isUuid(input.attemptId)) {
    return { ok: false, error: NOT_FOUND_MESSAGE };
  }

  let written: { refundId: string } | { error: string };
  try {
    written = await withService(async (db) => {
      const payment = await lockPayment(db, input.invoiceId, input.attemptId);
      const refusal = paymentRefusal(payment, input);
      if (refusal || !payment) return { error: refusal ?? NOT_FOUND_MESSAGE };
      if (!payment.providerPaymentId) {
        return { error: NO_GATEWAY_PAYMENT_MESSAGE };
      }
      const left =
        payment.amountPaise - (await usedOnPayment(db, payment.attemptId));
      if (input.amountPaise > left) {
        return { error: overCapMessage(Math.max(0, left)) };
      }
      const res = await db.execute(sql`
        insert into public.billing_refunds
          (invoice_id, attempt_id, reason, status, method, amount_paise,
           idempotency_key, provider_payment_id, requested_by, note,
           created_at, updated_at)
        values (${payment.invoiceId}, ${payment.attemptId}, ${input.reason},
                'owed', 'razorpay', ${input.amountPaise}, ${newRefundKey()},
                ${payment.providerPaymentId}, ${operator}, ${note},
                ${iso(now)}, ${iso(now)})
        returning id`);
      return { refundId: String(rowsOf(res)[0]?.id) };
    });
  } catch (err) {
    // The database's own guard refused: something changed between our
    // checks and the write (another refund, the payment's state).
    if (pgErrorCode(err) === "P0001") {
      logWarn("billing.refunds.guard_refused", {
        error: dbErrorMessage(err, "refused"),
      });
      return { ok: false, error: MOVED_ON_MESSAGE };
    }
    logError("billing.refunds.create", err, {
      invoiceId: input.invoiceId,
      attemptId: input.attemptId,
    });
    return { ok: false, error: SAVE_FAILED_MESSAGE };
  }
  if ("error" in written) return { ok: false, error: written.error };

  logInfo("billing.refund_created", {
    refundId: written.refundId,
    invoiceId: input.invoiceId,
    reason: input.reason,
    amountPaise: input.amountPaise,
    by: operator,
  });
  const refund = input.refund === undefined ? platformRefundFn() : input.refund;
  return sendForOperator(written.refundId, refund, {
    issuedBy: operator,
    now,
  });
}

/**
 * Send an owed refund now: the console's Send (an automatic refund held while
 * automatic sending is off, or an operator's whose first call died).
 */
export async function sendRefundNow(input: {
  refundId: string;
  operator: string;
  now?: Date;
  refund?: RefundFn | null;
}): Promise<RefundActionResult> {
  if (!isUuid(input.refundId)) return { ok: false, error: MOVED_ON_MESSAGE };
  const refund = input.refund === undefined ? platformRefundFn() : input.refund;
  if (!refund) return { ok: false, error: NO_GATEWAY_MESSAGE };
  return sendForOperator(input.refundId, refund, {
    issuedBy: cleanOperator(input.operator) || "system",
    now: input.now ?? new Date(),
  });
}

/**
 * Send a failed refund again, as a NEW row (same invoice, payment, amount and
 * reason; requested by the operator, with their note). ★ Never the old row:
 * what a refund is never changes, and the one-automatic-refund index stops
 * the pass from retrying a refusal by itself while letting a person do it.
 */
export async function retryRefund(input: {
  refundId: string;
  note: string;
  operator: string;
  now?: Date;
  refund?: RefundFn | null;
}): Promise<RefundActionResult> {
  const now = input.now ?? new Date();
  const note = cleanNote(input.note);
  const operator = cleanOperator(input.operator);
  if (!note) return { ok: false, error: NOTE_REQUIRED_MESSAGE };
  if (!operator || !isUuid(input.refundId)) {
    return { ok: false, error: MOVED_ON_MESSAGE };
  }

  let written: { refundId: string } | { error: string };
  try {
    written = await withService(async (db) => {
      const old = rowsOf(
        await db.execute(sql`
          select id, invoice_id, attempt_id, amount_paise, reason, status,
                 provider_payment_id
            from public.billing_refunds
           where id = ${input.refundId}
             for update`),
      )[0];
      if (!old || old.status !== "failed") return { error: MOVED_ON_MESSAGE };
      const attemptId = String(old.attempt_id);
      const amount = num(old.amount_paise);
      const payment = await lockPayment(db, String(old.invoice_id), attemptId);
      if (!payment) return { error: NOT_FOUND_MESSAGE };
      const left = payment.amountPaise - (await usedOnPayment(db, attemptId));
      if (amount > left) return { error: overCapMessage(Math.max(0, left)) };
      const res = await db.execute(sql`
        insert into public.billing_refunds
          (invoice_id, attempt_id, reason, status, method, amount_paise,
           idempotency_key, provider_payment_id, requested_by, note,
           created_at, updated_at)
        values (${String(old.invoice_id)}, ${attemptId}, ${String(old.reason)},
                'owed', 'razorpay', ${amount}, ${newRefundKey()},
                ${textOrNull(old.provider_payment_id) ?? payment.providerPaymentId},
                ${operator}, ${note}, ${iso(now)}, ${iso(now)})
        returning id`);
      return { refundId: String(rowsOf(res)[0]?.id) };
    });
  } catch (err) {
    // The database's own guard refused: something changed between our
    // checks and the write (another refund, the payment's state).
    if (pgErrorCode(err) === "P0001") {
      logWarn("billing.refunds.guard_refused", {
        error: dbErrorMessage(err, "refused"),
      });
      return { ok: false, error: MOVED_ON_MESSAGE };
    }
    logError("billing.refunds.retry", err, { refundId: input.refundId });
    return { ok: false, error: SAVE_FAILED_MESSAGE };
  }
  if ("error" in written) return { ok: false, error: written.error };

  logInfo("billing.refund_retried", {
    refundId: written.refundId,
    retryOf: input.refundId,
    by: operator,
  });
  const refund = input.refund === undefined ? platformRefundFn() : input.refund;
  return sendForOperator(written.refundId, refund, {
    issuedBy: operator,
    now,
  });
}

/**
 * Decide an owed refund is not to be sent. Only from `owed`; the reason is
 * kept on the row. No email: the console tells the operator to write to the
 * merchant (design 7.2), who was told a refund is coming.
 */
export async function cancelOwedRefund(input: {
  refundId: string;
  note: string;
  operator: string;
  now?: Date;
}): Promise<RefundActionResult> {
  const now = input.now ?? new Date();
  const note = cleanNote(input.note);
  if (!note) return { ok: false, error: NOTE_REQUIRED_MESSAGE };
  if (!isUuid(input.refundId)) return { ok: false, error: MOVED_ON_MESSAGE };
  try {
    const res = await withService((db) =>
      db.execute(sql`
        update public.billing_refunds
           set status = 'cancelled', resolution_note = ${note},
               resolved_at = ${iso(now)}, updated_at = ${iso(now)}
         where id = ${input.refundId} and status = 'owed'
        returning id`),
    );
    if (!rowsOf(res).length) return { ok: false, error: MOVED_ON_MESSAGE };
  } catch (err) {
    logError("billing.refunds.cancel", err, { refundId: input.refundId });
    return { ok: false, error: SAVE_FAILED_MESSAGE };
  }
  logInfo("billing.refund_cancelled", {
    refundId: input.refundId,
    by: cleanOperator(input.operator) || null,
  });
  return { ok: true, refundId: input.refundId, status: "cancelled" };
}

/**
 * Record a refund made outside this tool: a bank transfer (its UTR), or one
 * made by hand in the Razorpay dashboard (its refund id). Inserted final
 * (`recorded`); then the credit note and the merchant's email.
 *
 * ★ When it settles an owed refund, that row is CANCELLED FIRST, in the same
 * transaction: both count against the payment's cap, so leaving it owed would
 * count the money twice (and the pass could still send it). A failed row
 * needs nothing: it no longer counts.
 */
export async function recordRefundMadeOutside(input: {
  /** The owed or failed refund this settles, if any. */
  refundId?: string | null;
  storeId?: string | null;
  invoiceId: string;
  attemptId: string;
  amountPaise: number;
  method: "bank_transfer" | "razorpay";
  reference: string;
  note: string;
  operator: string;
  /** Default: the settled refund's reason, else "Plan ended before this
   *  cycle" (the reconciliation queue's D7 items). */
  reason?: RefundReason;
  now?: Date;
}): Promise<RefundActionResult> {
  const now = input.now ?? new Date();
  const note = cleanNote(input.note);
  const operator = cleanOperator(input.operator);
  const reference =
    typeof input.reference === "string" ? input.reference.trim() : "";
  if (!note) return { ok: false, error: NOTE_REQUIRED_MESSAGE };
  if (!reference) return { ok: false, error: REFERENCE_REQUIRED_MESSAGE };
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    return { ok: false, error: AMOUNT_REQUIRED_MESSAGE };
  }
  if (input.method !== "bank_transfer" && input.method !== "razorpay") {
    return { ok: false, error: REFERENCE_REQUIRED_MESSAGE };
  }
  if (input.reason !== undefined && !REFUND_REASONS.includes(input.reason)) {
    return { ok: false, error: REASON_REQUIRED_MESSAGE };
  }
  if (
    !operator ||
    !isUuid(input.invoiceId) ||
    !isUuid(input.attemptId) ||
    (input.refundId != null && !isUuid(input.refundId))
  ) {
    return { ok: false, error: NOT_FOUND_MESSAGE };
  }

  let written: { refundId: string } | { error: string };
  try {
    written = await withService(async (db) => {
      const payment = await lockPayment(db, input.invoiceId, input.attemptId);
      let reason: string = input.reason ?? "cycle_not_reached";
      // The owed row this settles, if any: its amount stops counting against
      // the cap once it is cancelled below.
      let settlesOwed: { amountPaise: number } | null = null;
      if (input.refundId) {
        const settled = rowsOf(
          await db.execute(sql`
            select id, status, reason, attempt_id, amount_paise
              from public.billing_refunds
             where id = ${input.refundId}
               for update`),
        )[0];
        if (!settled || String(settled.attempt_id) !== input.attemptId) {
          return { error: NOT_FOUND_MESSAGE };
        }
        if (settled.status !== "owed" && settled.status !== "failed") {
          return { error: MOVED_ON_MESSAGE };
        }
        reason = input.reason ?? String(settled.reason);
        if (settled.status === "owed") {
          settlesOwed = { amountPaise: num(settled.amount_paise) };
        }
      }
      // ★ Every check runs BEFORE the first write: a refusal returns rather
      // than throws, so a write made earlier would commit with it.
      const refusal = paymentRefusal(payment, {
        storeId: input.storeId,
        reason,
      });
      if (refusal || !payment) return { error: refusal ?? NOT_FOUND_MESSAGE };
      const left =
        payment.amountPaise -
        (await usedOnPayment(db, payment.attemptId)) +
        (settlesOwed?.amountPaise ?? 0);
      if (input.amountPaise > left) {
        return { error: overCapMessage(Math.max(0, left)) };
      }
      if (settlesOwed) {
        await db.execute(sql`
          update public.billing_refunds
             set status = 'cancelled',
                 resolution_note = ${`Recorded as made outside StoreMink. ${note}`},
                 resolved_at = ${iso(now)}, updated_at = ${iso(now)}
           where id = ${input.refundId} and status = 'owed'`);
      }
      const byBank = input.method === "bank_transfer";
      const res = await db.execute(sql`
        insert into public.billing_refunds
          (invoice_id, attempt_id, reason, status, method, amount_paise,
           idempotency_key, provider_payment_id, provider_refund_id,
           external_reference, requested_by, note, resolved_at,
           created_at, updated_at)
        values (${payment.invoiceId}, ${payment.attemptId}, ${reason},
                'recorded', ${input.method}, ${input.amountPaise}, ${newRefundKey()},
                ${byBank ? null : payment.providerPaymentId},
                ${byBank ? null : reference}, ${byBank ? reference : null},
                ${operator}, ${note}, ${iso(now)}, ${iso(now)}, ${iso(now)})
        returning id`);
      return { refundId: String(rowsOf(res)[0]?.id) };
    });
  } catch (err) {
    // The database's own guard refused: something changed between our
    // checks and the write (another refund, the payment's state).
    if (pgErrorCode(err) === "P0001") {
      logWarn("billing.refunds.guard_refused", {
        error: dbErrorMessage(err, "refused"),
      });
      return { ok: false, error: MOVED_ON_MESSAGE };
    }
    if (pgErrorCode(err) === "23505") {
      return { ok: false, error: ALREADY_RECORDED_MESSAGE };
    }
    logError("billing.refunds.record", err, {
      invoiceId: input.invoiceId,
      attemptId: input.attemptId,
    });
    return { ok: false, error: SAVE_FAILED_MESSAGE };
  }
  if ("error" in written) return { ok: false, error: written.error };

  logInfo("billing.refund_recorded", {
    refundId: written.refundId,
    settles: input.refundId ?? null,
    method: input.method,
    amountPaise: input.amountPaise,
    by: operator,
  });
  await finishRefund(written.refundId, { issuedBy: operator, now });
  return { ok: true, refundId: written.refundId, status: "recorded" };
}

/** One captured payment of an invoice and what is left to refund on it. */
export interface RefundablePayment {
  attemptId: string;
  providerPaymentId: string | null;
  amountPaise: number;
  /** Processed and recorded refunds. */
  refundedPaise: number;
  /** Owed and pending refunds. */
  inProgressPaise: number;
  /** The amount less every live and finished refund (the guard's cap). */
  leftPaise: number;
}

/**
 * What is left to refund on each captured payment of an invoice: the amount
 * less its live and finished refunds, the cap `billing_refunds_guard`
 * enforces. The console pre-fills its amount from this.
 */
export async function refundableForInvoice(
  invoiceId: string,
  db?: Db,
): Promise<{ payments: RefundablePayment[]; leftPaise: number }> {
  if (!isUuid(invoiceId)) return { payments: [], leftPaise: 0 };
  const run = async (handle: Db) =>
    rowsOf(
      await handle.execute(sql`
        select a.id, a.provider_payment_id, a.amount_paise,
               coalesce(sum(r.amount_paise) filter (
                 where r.status in ('processed', 'recorded')), 0) as refunded,
               coalesce(sum(r.amount_paise) filter (
                 where r.status in ('owed', 'pending')), 0) as in_progress
          from public.billing_payment_attempts a
          left join public.billing_refunds r on r.attempt_id = a.id
         where a.invoice_id = ${invoiceId}
           and a.state in ('captured', 'refunded')
         group by a.id
         order by a.created_at`),
    );
  const rows = db ? await run(db) : await withService(run);
  const payments = rows.map((r) => {
    const amountPaise = num(r.amount_paise);
    const refundedPaise = num(r.refunded);
    const inProgressPaise = num(r.in_progress);
    return {
      attemptId: String(r.id),
      providerPaymentId: textOrNull(r.provider_payment_id),
      amountPaise,
      refundedPaise,
      inProgressPaise,
      leftPaise: Math.max(0, amountPaise - refundedPaise - inProgressPaise),
    };
  });
  return {
    payments,
    leftPaise: payments.reduce((sum, p) => sum + p.leftPaise, 0),
  };
}

/** One refund as the Refunds page and the store page list it. */
export interface RefundListRow {
  id: string;
  invoiceId: string;
  invoiceRef: string | null;
  /** Null once the store is deleted ("Deleted store"). */
  storeId: string | null;
  storeName: string | null;
  storeSlug: string | null;
  attemptId: string;
  providerPaymentId: string | null;
  reason: RefundReason;
  status: RefundStatus;
  method: "razorpay" | "bank_transfer";
  amountPaise: number;
  providerRefundId: string | null;
  externalReference: string | null;
  failureReason: string | null;
  /** "system", or the operator's email. */
  requestedBy: string;
  note: string | null;
  resolutionNote: string | null;
  createdAt: string;
  sentAt: string | null;
  resolvedAt: string | null;
  notifiedAt: string | null;
  /** On the "Needs a person" tab (countRefundsNeedingAction's rule). */
  needsPerson: boolean;
}

export type RefundTab = "needs_person" | "in_progress" | "done";

/**
 * The Refunds page's tabs, and a store's own refunds (`storeId`). "Needs a
 * person" uses `countRefundsNeedingAction`'s rule, so the banner's count and
 * the tab's rows are the same set.
 */
export async function listRefunds(
  input: {
    tab?: RefundTab;
    storeId?: string;
    limit?: number;
    now?: Date;
    autoRefunds?: boolean;
  } = {},
): Promise<RefundListRow[]> {
  const now = input.now ?? new Date();
  const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 100)));
  if (input.storeId !== undefined && !isUuid(input.storeId)) return [];
  try {
    return await withService(async (db) => {
      const autoRefunds =
        input.autoRefunds ?? (await getRefundSettings(db)).autoRefunds;
      const tab =
        input.tab === "needs_person"
          ? sql`and (f.failed_alone or f.owed_late or f.pending_late or f.held)`
          : input.tab === "in_progress"
            ? sql`and f.status in ('owed', 'pending')`
            : input.tab === "done"
              ? sql`and f.status in ('processed', 'recorded', 'cancelled')`
              : sql``;
      const store =
        input.storeId !== undefined
          ? sql`and i.store_id = ${input.storeId}`
          : sql``;
      const order =
        input.tab === "done"
          ? sql`order by f.resolved_at desc nulls last, f.created_at desc`
          : sql`order by f.created_at asc`;
      const res = await db.execute(sql`
        with f as (
          select r.*, ${needsActionFlags(now, autoRefunds)}
            from public.billing_refunds r)
        select f.id, f.invoice_id, i.invoice_ref, i.store_id, st.name as store_name,
               st.slug as store_slug, f.attempt_id, f.provider_payment_id, f.reason,
               f.status, f.method, f.amount_paise, f.provider_refund_id,
               f.external_reference, f.failure_reason, f.requested_by, f.note,
               f.resolution_note, f.created_at, f.sent_at, f.resolved_at,
               f.notified_at,
               (f.failed_alone or f.owed_late or f.pending_late or f.held) as needs_person
          from f
          join public.billing_invoices i on i.id = f.invoice_id
          left join public.stores st on st.id = i.store_id
         where true ${tab} ${store}
         ${order}
         limit ${limit}`);
      return rowsOf(res).map((r) => ({
        id: String(r.id),
        invoiceId: String(r.invoice_id),
        invoiceRef: textOrNull(r.invoice_ref),
        storeId: textOrNull(r.store_id),
        storeName: textOrNull(r.store_name),
        storeSlug: textOrNull(r.store_slug),
        attemptId: String(r.attempt_id),
        providerPaymentId: textOrNull(r.provider_payment_id),
        reason: String(r.reason) as RefundReason,
        status: String(r.status) as RefundStatus,
        method: (r.method === "bank_transfer"
          ? "bank_transfer"
          : "razorpay") as "razorpay" | "bank_transfer",
        amountPaise: num(r.amount_paise),
        providerRefundId: textOrNull(r.provider_refund_id),
        externalReference: textOrNull(r.external_reference),
        failureReason: textOrNull(r.failure_reason),
        requestedBy: String(r.requested_by),
        note: textOrNull(r.note),
        resolutionNote: textOrNull(r.resolution_note),
        createdAt: String(r.created_at),
        sentAt: textOrNull(r.sent_at),
        resolvedAt: textOrNull(r.resolved_at),
        notifiedAt: textOrNull(r.notified_at),
        needsPerson: r.needs_person === true,
      }));
    });
  } catch (err) {
    logError("billing.refunds.list", err, { tab: input.tab ?? null });
    return [];
  }
}

/** One credit note on the Refunds page's "Credit notes" tab. */
export interface ConsoleCreditNoteRow {
  id: string;
  creditNoteRef: string;
  issuedAt: string;
  reason: string;
  totalPaise: number;
  invoiceId: string;
  invoiceRef: string | null;
  storeId: string | null;
  storeName: string | null;
  storeSlug: string | null;
}

/** Every store's credit notes, newest first (the console's tab). */
export async function listConsoleCreditNotes(
  input: { limit?: number } = {},
): Promise<ConsoleCreditNoteRow[]> {
  const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 100)));
  try {
    const res = await withService((db) =>
      db.execute(sql`
        select n.id, n.credit_note_ref, n.issued_at, n.reason, n.total_paise,
               n.invoice_id, i.invoice_ref, i.store_id, st.name as store_name,
               st.slug as store_slug
          from public.billing_credit_notes n
          join public.billing_invoices i on i.id = n.invoice_id
          left join public.stores st on st.id = i.store_id
         order by n.issued_at desc, n.fy_label desc, n.credit_note_no desc
         limit ${limit}`),
    );
    return rowsOf(res).map((r) => ({
      id: String(r.id),
      creditNoteRef: String(r.credit_note_ref),
      issuedAt: String(r.issued_at),
      reason: String(r.reason),
      totalPaise: num(r.total_paise),
      invoiceId: String(r.invoice_id),
      invoiceRef: textOrNull(r.invoice_ref),
      storeId: textOrNull(r.store_id),
      storeName: textOrNull(r.store_name),
      storeSlug: textOrNull(r.store_slug),
    }));
  } catch (err) {
    logError("billing.refunds.list_credit_notes", err);
    return [];
  }
}
