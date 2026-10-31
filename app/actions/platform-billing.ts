"use server";

/**
 * The operator console's billing tools (renewal-cancel, design 6.8; owner
 * decisions D5, D7, D9 and D12 of 27 Oct 2026): the Refunds page, the
 * "Send refunds automatically" switch, and the store page's four tools
 * (Cancel at the end of the cycle, Undo cancellation, End the plan now,
 * Issue a refund).
 *
 * ★★ EVERY WRITE IS A PLATFORM SUPERADMIN'S, checked here on the server
 * (`getPlatformViewer`, role `superadmin`, the `TAX_WRITE_GATE` rule of the
 * three tax actions in app/actions/platform.ts): each one moves money or ends
 * a plan, and a server action is a public POST endpoint whatever the page
 * shows. A member may read (the queue, the count, a store's billing) and sees
 * no buttons.
 *
 * ★★ THE MONEY RULES ARE NOT HERE. Every refund goes through the helpers the
 * hourly refund pass uses (`lib/billing/refunds.ts`): the cap, the ₹1 minimum
 * through Razorpay, "Plan ended before this cycle" only where it fits, the
 * owed row written before Razorpay is called, the credit note and the
 * merchant's email. So the pass and the console cannot disagree, and the
 * helpers' messages reach the operator exactly as written. This file gates,
 * converts the form's rupees to paise (`Math.round(x * 100)`), and passes the
 * operator's email as who asked.
 *
 * ★ A PLAN IS CANCELLED AND RESUMED THROUGH THE MERCHANT'S OWN PATHS
 * (`cancelAtPeriodEnd`, `resumeSubscription`), with `requestedBy` set to
 * "operator:<email>", so the cancellation email opens with the operator's
 * wording and the store page can say who asked.
 *
 * ★★ "END THE PLAN NOW" ENDS IT THE WAY THE WORKER DOES (`endSubscription`),
 * after setting the cancel flag under the subscription's row lock, because
 * the end's claim requires the flag. Every invoice above the cycle is closed
 * in that transaction, and the refund pass refunds any payment on them by
 * itself (reason "Plan ended before this cycle"). This file refunds only the
 * unused part of the cycle that was running, with the operator's reason; a
 * refund that fails is reported and never undoes the end.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { withService, type Db } from "@/lib/db/client";
import {
  billingMandates,
  billingSubscriptions,
  planEvents,
} from "@/drizzle/schema";
import { logError, logInfo } from "@/lib/observability/logger";
import { emitEvent } from "@/lib/notifications/record";
import { STORE_TAG } from "@/lib/store/resolve";
import { getPlatformViewer } from "./platform";
import * as refunds from "@/lib/billing/refunds";
import type {
  ConsoleCreditNoteRow,
  RefundActionResult,
  RefundListRow,
  RefundReason,
  RefundStatus,
  RefundsNeedingAction,
  RefundablePayment,
} from "@/lib/billing/refunds";
import { cancelAtPeriodEnd, resumeSubscription } from "@/lib/billing/cancel";
import { endSubscription, type PlanChange } from "@/lib/billing/renewal-worker";
import { notifyDowngraded } from "@/lib/billing/dunning";
import { unusedPartOfCycle } from "@/lib/billing/credit-notes";
import { listCreditNotes } from "@/lib/billing/credit-note-store";
import { savePlatformAutoRefunds } from "@/lib/billing/platform-settings";
import type { CreditNoteSummary } from "@/lib/billing/invoice-types";
import { istDate } from "@/lib/email/billing-emails";

// ── Shapes ──────────────────────────────────────────────────────────────────

/** A plain write: done, or the sentence to show. */
export type BillingActionResult = { success: true } | { error: string };

/** A refund write: the row it wrote or moved, and where that row now is. */
export type RefundWriteResult =
  | { success: true; refundId: string; status: RefundStatus }
  | { error: string; refundId?: string };

/** The Refunds page's tabs. */
export type RefundQueueTab =
  | "needs_person"
  | "in_progress"
  | "done"
  | "credit_notes";

export interface RefundQueue {
  tab: RefundQueueTab;
  /** Empty on the "Credit notes" tab. */
  refunds: RefundListRow[];
  /** Filled only on the "Credit notes" tab. */
  creditNotes: ConsoleCreditNoteRow[];
}

/** Why "End the plan now" was used (design 7.3). */
export type EndPlanReason = "declined_terms" | "feature_removed" | "other";

export interface EndPlanNowInput {
  storeId: string;
  reason: EndPlanReason;
  /** Refund the unused part of the cycle that was running. */
  refundUnused: boolean;
  /**
   * Where the unused part is counted from: a day in India time
   * ("2026-10-29") or an ISO timestamp. Required for `feature_removed` (the
   * day the feature was removed or reduced); otherwise it defaults to now,
   * and today's date also means now. It must not be in the future or before
   * the cycle began.
   */
  refundFrom?: string | null;
  note: string;
}

/** One refund "End the plan now" tried, as the dialog lists it afterwards. */
export interface EndPlanRefund {
  invoiceRef: string | null;
  amountPaise: number;
  /** Where the refund now is; null when nothing was written or sent. */
  status: RefundStatus | null;
  /** The sentence to show when it did not go through, as returned. */
  error: string | null;
}

/** A paid invoice of the cycle that got no refund, and why. */
export interface EndPlanSkipped {
  invoiceRef: string | null;
  why: string;
}

export type EndPlanNowResult =
  | { success: true; refunds: EndPlanRefund[]; skipped: EndPlanSkipped[] }
  | { error: string };

/** One paid invoice covering the running cycle, and its unused part. */
export interface EndNowLine {
  invoiceId: string;
  invoiceRef: string | null;
  kind: string;
  /** What would be refunded on it; 0 when it is skipped. */
  amountPaise: number;
  daysLeft: number;
  daysTotal: number;
  /** "{ref}: less than ₹1 is left, so nothing is refunded." when skipped. */
  skippedWhy: string | null;
}

/** "Refund the unused part of this cycle: {amount} ({days} of {total} days)". */
export interface EndNowPreview {
  /** The moment counted from (ISO); null when `error` is set. */
  from: string | null;
  lines: EndNowLine[];
  /** The sum of the lines that would be refunded. */
  totalPaise: number;
  /** Why the chosen date cannot be used, as `endPlanNow` would refuse it. */
  error: string | null;
}

/** One issued invoice with a payment on it, for "Issue a refund". */
export interface StoreBillingInvoice {
  id: string;
  invoiceRef: string | null;
  kind: string;
  status: string;
  cycleSeq: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  totalPaise: number;
  issuedAt: string | null;
  /** Processed and recorded refunds. */
  refundedPaise: number;
  /** Owed and pending refunds. */
  inProgressPaise: number;
  /** What is left to refund across its payments (the database's cap). */
  leftPaise: number;
  /** Its captured payments, the one with the most left first. */
  payments: RefundablePayment[];
  /**
   * Whether "Plan ended before this cycle" may be offered for it: a closed
   * invoice, or a paid renewal above the plan's last reached cycle. Only a
   * hint for the dialog; the refund helper decides.
   */
  cycleNotReachedFits: boolean;
}

export interface StoreBillingSubscription {
  plan: string;
  period: string;
  state: string;
  /** active, past_due or grace: there is a plan to cancel or end. */
  live: boolean;
  currentCycleSeq: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  cancelRequestedAt: string | null;
  /** Who asked for the cancellation that stands: "the merchant" is shown for
   *  a merchant (never their id), the operator's email for an operator. */
  cancelRequestedBy:
    | { kind: "merchant" }
    | { kind: "operator"; email: string | null }
    | null;
}

/** Everything the store page's billing block shows (design 7.3). */
export interface StoreBilling {
  storeId: string;
  storeName: string;
  storeSlug: string;
  storeStatus: string;
  subscription: StoreBillingSubscription | null;
  invoices: StoreBillingInvoice[];
  /** The "End the plan now" preview; null when no plan is running. */
  endNow: EndNowPreview | null;
  refunds: RefundListRow[];
  creditNotes: CreditNoteSummary[];
}

// ── Sentences ───────────────────────────────────────────────────────────────

const REFUND_GATE_MESSAGE = "Only a platform superadmin can send refunds.";
const PLAN_GATE_MESSAGE = "Only a platform superadmin can change store plans.";
const SETTINGS_GATE_MESSAGE =
  "Only a platform superadmin can change refund settings.";
const STORE_NOT_FOUND_MESSAGE = "Store not found.";
const REASON_MESSAGE = "Choose a reason.";
const NOTHING_TO_END_MESSAGE =
  "This store has no paid plan running, so there is nothing to end.";
const END_FAILED_MESSAGE = "Couldn't end the plan. Please try again.";
const END_MOVED_MESSAGE =
  "That plan changed while you were looking. Refresh the page.";
const REFUND_THREW_MESSAGE = "Couldn't save that refund. Please try again.";
const DATE_REQUIRED_MESSAGE =
  "Give the date the feature was removed or reduced.";
const DATE_UNREADABLE_MESSAGE = "That date couldn't be read.";
const DATE_FUTURE_MESSAGE = "The date can't be in the future.";

function dateBeforeCycleMessage(periodStart: string): string {
  return `The date must fall in the current cycle, which began on ${istDate(periodStart)}.`;
}

/** "{ref}: less than ₹1 is left, so nothing is refunded." (design 6.8) */
function lessThanRupeeMessage(invoiceRef: string | null): string {
  return `${invoiceRef ?? "An invoice"}: less than ₹1 is left, so nothing is refunded.`;
}

/** A split's last part under ₹1 cannot go through Razorpay on its own. */
function partUnderRupeeMessage(invoiceRef: string | null): string {
  return `${invoiceRef ?? "An invoice"}: part of it is less than ₹1 on one payment, so that part is not refunded.`;
}

const END_REASONS: readonly EndPlanReason[] = [
  "declined_terms",
  "feature_removed",
  "other",
];

/** The design's reason labels (7.2), for the audit note. */
const END_REASON_LABELS: Record<EndPlanReason, string> = {
  declined_terms: "Declined new Terms",
  feature_removed: "Main feature removed",
  other: "Other",
};

/** Subscription states with a paid cycle running. */
const LIVE_STATES = ["active", "past_due", "grace"];

const REFUND_PATHS = ["/dashboard/billing", "/dashboard/billing/refunds"];

// ── Small helpers ───────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** What a form sent as text; anything else is blank. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A note as stored: trimmed, at most 1,000 characters (the helpers' rule). */
function cleanNote(value: unknown): string {
  return text(value).trim().slice(0, 1000);
}

/**
 * Rupees from a form, in paise: `Math.round(x * 100)`, because 19.99 * 100 is
 * 1998.9999999999998 in floating point. "₹1,200.50" and "1200.5" both read.
 * Anything unreadable is NaN, which every refund helper refuses with its own
 * sentence.
 */
function rupeesToPaise(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.replace(/[₹,\s]/g, ""))
        : Number.NaN;
  return Math.round(n * 100);
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

/** A timestamp from a raw query or a Drizzle string column, as ISO text. */
function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return textOrNull(value);
}

/** The signed-in platform superadmin, or null for anyone else. */
async function superadmin(): Promise<{ email: string } | null> {
  const viewer = await getPlatformViewer();
  return viewer?.role === "superadmin" ? { email: viewer.email } : null;
}

function fromHelper(res: RefundActionResult): RefundWriteResult {
  if (res.ok) {
    return { success: true, refundId: res.refundId, status: res.status };
  }
  return res.refundId
    ? { error: res.error, refundId: res.refundId }
    : { error: res.error };
}

function refreshRefundPages(): void {
  for (const path of REFUND_PATHS) revalidatePath(path);
}

// ── India-time days, for "Refund the unused part from" ──────────────────────

const IST_OFFSET_MS = 330 * 60_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-10-29": the calendar day a moment falls on in India. */
function istDay(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 00:00 IST of a calendar day, or null for a day that does not exist. */
function istDayStart(day: string): Date | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d
  ) {
    return null;
  }
  return new Date(utc - IST_OFFSET_MS);
}

/**
 * The moment the unused part is counted from (design 6.8 step 1): required
 * for a removed feature, now otherwise; never in the future, never before
 * the cycle began. A day means 00:00 IST of that day, except today, which
 * means now (the dialog is prefilled with today).
 */
function resolveRefundFrom(
  raw: unknown,
  input: { required: boolean; now: Date; periodStart: string | null },
): { ok: true; from: Date } | { ok: false; error: string } {
  const value = text(raw).trim();
  if (!value) {
    return input.required
      ? { ok: false, error: DATE_REQUIRED_MESSAGE }
      : { ok: true, from: input.now };
  }
  const startIso = input.periodStart;
  const parsedStart = startIso ? new Date(startIso) : null;
  const start =
    parsedStart && Number.isFinite(parsedStart.getTime()) ? parsedStart : null;
  const beforeCycle = () =>
    ({
      ok: false,
      error: dateBeforeCycleMessage(startIso ?? ""),
    }) as const;

  if (DAY_RE.test(value)) {
    const dayStart = istDayStart(value);
    if (!dayStart) return { ok: false, error: DATE_UNREADABLE_MESSAGE };
    const today = istDay(input.now);
    if (value > today) return { ok: false, error: DATE_FUTURE_MESSAGE };
    if (start && value < istDay(start)) return beforeCycle();
    if (value === today) return { ok: true, from: input.now };
    return {
      ok: true,
      from: start && dayStart.getTime() < start.getTime() ? start : dayStart,
    };
  }

  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) {
    return { ok: false, error: DATE_UNREADABLE_MESSAGE };
  }
  if (at.getTime() > input.now.getTime()) {
    return { ok: false, error: DATE_FUTURE_MESSAGE };
  }
  if (start && at.getTime() < start.getTime()) return beforeCycle();
  return { ok: true, from: at };
}

// ── The unused part of the running cycle ────────────────────────────────────

interface CycleFacts {
  storeId: string;
  currentCycleSeq: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

interface UnusedLine extends EndNowLine {
  payments: RefundablePayment[];
}

/**
 * The paid invoices covering the running cycle (design 6.8 step 3): the
 * subscription invoice of that cycle, and addon invoices issued since it
 * began (an addon's period is its issue time to the cycle's end), each with
 * the smaller of its unused part and what is left to refund on it.
 *
 * `db` is the caller's open scope: `refundableForInvoice` runs on it.
 */
async function unusedRefundLines(
  db: Db,
  cycle: CycleFacts,
  from: Date,
): Promise<UnusedLine[]> {
  if (!cycle.currentPeriodStart || !cycle.currentPeriodEnd) return [];
  const res = await db.execute(sql`
    select i.id, i.invoice_ref, i.kind, i.total_paise, i.finalized_at
      from public.billing_invoices i
     where i.store_id = ${cycle.storeId}
       and i.status = 'paid'
       and i.finalized_at is not null
       and ((i.kind = 'subscription' and i.cycle_seq = ${cycle.currentCycleSeq})
         or (i.kind = 'addon' and i.finalized_at >= ${cycle.currentPeriodStart}))
     order by (i.kind = 'subscription') desc, i.finalized_at asc`);

  const lines: UnusedLine[] = [];
  for (const row of rowsOf(res)) {
    const invoiceId = String(row.id);
    const invoiceRef = textOrNull(row.invoice_ref);
    const kind = String(row.kind);
    const periodStart =
      kind === "subscription"
        ? cycle.currentPeriodStart
        : (isoOrNull(row.finalized_at) ?? cycle.currentPeriodEnd);
    const unused = unusedPartOfCycle({
      paidPaise: num(row.total_paise),
      periodStart: new Date(periodStart),
      periodEnd: new Date(cycle.currentPeriodEnd),
      from,
    });
    const left = await refunds.refundableForInvoice(invoiceId, db);
    const payments = [...left.payments].sort(
      (a, b) => b.leftPaise - a.leftPaise,
    );
    const amountPaise = Math.min(unused.paise, left.leftPaise);
    // ★ Under ₹1 nothing is written, and 0 is never written at all.
    const skipped = amountPaise < 100;
    lines.push({
      invoiceId,
      invoiceRef,
      kind,
      amountPaise: skipped ? 0 : amountPaise,
      daysLeft: unused.daysLeft,
      daysTotal: unused.daysTotal,
      skippedWhy: skipped ? lessThanRupeeMessage(invoiceRef) : null,
      payments,
    });
  }
  return lines;
}

function previewOf(from: Date, lines: UnusedLine[]): EndNowPreview {
  return {
    from: from.toISOString(),
    lines: lines.map(
      (l): EndNowLine => ({
        invoiceId: l.invoiceId,
        invoiceRef: l.invoiceRef,
        kind: l.kind,
        amountPaise: l.amountPaise,
        daysLeft: l.daysLeft,
        daysTotal: l.daysTotal,
        skippedWhy: l.skippedWhy,
      }),
    ),
    totalPaise: lines.reduce((sum, l) => sum + l.amountPaise, 0),
    error: null,
  };
}

// ── Reads (any operator) ────────────────────────────────────────────────────

/** The Refunds page's rows for one tab. Members may read. */
export async function getRefundQueue(tab: unknown): Promise<RefundQueue> {
  const which: RefundQueueTab =
    tab === "in_progress" || tab === "done" || tab === "credit_notes"
      ? tab
      : "needs_person";
  const empty: RefundQueue = { tab: which, refunds: [], creditNotes: [] };
  if (!(await getPlatformViewer())) return empty;
  if (which === "credit_notes") {
    return { ...empty, creditNotes: await refunds.listConsoleCreditNotes() };
  }
  return { ...empty, refunds: await refunds.listRefunds({ tab: which }) };
}

/**
 * What the Billing & tax banner counts ("{n} refunds need a look."): failed
 * refunds nobody followed up, anything owed or sent more than a day ago, and
 * owed automatic refunds while sending is off. Null for a non-operator or a
 * failed read, so the page shows its quiet link instead of a wrong zero.
 */
export async function countRefundsNeedingAction(): Promise<RefundsNeedingAction | null> {
  if (!(await getPlatformViewer())) return null;
  try {
    return await refunds.countRefundsNeedingAction();
  } catch (err) {
    logError("billing.console.refunds_count", err);
    return null;
  }
}

/**
 * A store's subscription, issued invoices with payments on them, refunds and
 * credit notes, for the store page's billing block. `refundFrom` and
 * `reason` shape the "End the plan now" preview exactly as `endPlanNow`
 * would count it. Members may read. Null for a non-operator or an unknown
 * store.
 */
export async function listStoreBilling(
  storeId: unknown,
  opts: { refundFrom?: string | null; reason?: unknown } = {},
): Promise<StoreBilling | null> {
  if (!isUuid(storeId)) return null;
  if (!(await getPlatformViewer())) return null;
  const now = new Date();

  let base: Omit<StoreBilling, "refunds" | "creditNotes"> | null;
  try {
    base = await withService(async (db) => {
      const head = rowsOf(
        await db.execute(sql`
          select s.id, s.name, s.slug, s.status,
                 bs.plan, bs.period, bs.state, bs.current_cycle_seq,
                 bs.current_period_start, bs.current_period_end,
                 bs.grace_ends_at, bs.cancel_at_period_end,
                 bs.cancel_requested_at, bs.cancel_requested_by
            from public.stores s
            left join public.billing_subscriptions bs on bs.store_id = s.id
           where s.id = ${storeId}
           limit 1`),
      )[0];
      if (!head) return null;

      const subscription: StoreBillingSubscription | null = head.state
        ? {
            plan: String(head.plan ?? "free"),
            period: String(head.period ?? "monthly"),
            state: String(head.state),
            live: LIVE_STATES.includes(String(head.state)),
            currentCycleSeq: num(head.current_cycle_seq),
            currentPeriodStart: isoOrNull(head.current_period_start),
            currentPeriodEnd: isoOrNull(head.current_period_end),
            graceEndsAt: isoOrNull(head.grace_ends_at),
            cancelAtPeriodEnd: head.cancel_at_period_end === true,
            cancelRequestedAt: isoOrNull(head.cancel_requested_at),
            cancelRequestedBy: requester(head.cancel_requested_by),
          }
        : null;

      const invoiceRows = rowsOf(
        await db.execute(sql`
          select i.id, i.invoice_ref, i.kind, i.status, i.cycle_seq,
                 i.period_start, i.period_end, i.total_paise, i.finalized_at
            from public.billing_invoices i
           where i.store_id = ${storeId}
             and i.finalized_at is not null
             and exists (
               select 1 from public.billing_payment_attempts a
                where a.invoice_id = i.id
                  and a.state in ('captured', 'refunded'))
           order by i.finalized_at desc
           limit 50`),
      );
      const invoices: StoreBillingInvoice[] = [];
      for (const row of invoiceRows) {
        const left = await refunds.refundableForInvoice(String(row.id), db);
        const kind = String(row.kind);
        const status = String(row.status);
        const cycleSeq = row.cycle_seq == null ? null : num(row.cycle_seq);
        invoices.push({
          id: String(row.id),
          invoiceRef: textOrNull(row.invoice_ref),
          kind,
          status,
          cycleSeq,
          periodStart: isoOrNull(row.period_start),
          periodEnd: isoOrNull(row.period_end),
          totalPaise: num(row.total_paise),
          issuedAt: isoOrNull(row.finalized_at),
          refundedPaise: left.payments.reduce((s, p) => s + p.refundedPaise, 0),
          inProgressPaise: left.payments.reduce(
            (s, p) => s + p.inProgressPaise,
            0,
          ),
          leftPaise: left.leftPaise,
          payments: [...left.payments].sort(
            (a, b) => b.leftPaise - a.leftPaise,
          ),
          // The helper's own rule (refunds.ts `cycleNotReached`), as a hint.
          cycleNotReachedFits:
            kind === "subscription" &&
            (status === "void" ||
              status === "uncollectible" ||
              (status === "paid" &&
                (cycleSeq ?? 0) > (subscription?.currentCycleSeq ?? 0))),
        });
      }

      let endNow: EndNowPreview | null = null;
      if (subscription?.live) {
        const resolved = resolveRefundFrom(opts.refundFrom, {
          required: false,
          now,
          periodStart: subscription.currentPeriodStart,
        });
        if (!resolved.ok) {
          endNow = {
            from: null,
            lines: [],
            totalPaise: 0,
            error: resolved.error,
          };
        } else {
          const lines = await unusedRefundLines(
            db,
            {
              storeId,
              currentCycleSeq: subscription.currentCycleSeq,
              currentPeriodStart: subscription.currentPeriodStart,
              currentPeriodEnd: subscription.currentPeriodEnd,
            },
            resolved.from,
          );
          endNow = previewOf(resolved.from, lines);
          if (opts.reason === "feature_removed" && !text(opts.refundFrom)) {
            endNow.error = DATE_REQUIRED_MESSAGE;
          }
        }
      }

      return {
        storeId,
        storeName: String(head.name ?? ""),
        storeSlug: String(head.slug ?? ""),
        storeStatus: String(head.status ?? "active"),
        subscription,
        invoices,
        endNow,
      };
    });
  } catch (err) {
    logError("billing.console.store_billing", err, { storeId });
    return null;
  }
  if (!base) return null;

  // Separate scopes, after the one above has closed.
  const [refundRows, creditNotes] = await Promise.all([
    refunds.listRefunds({ storeId }),
    listCreditNotes(storeId),
  ]);
  return { ...base, refunds: refundRows, creditNotes };
}

/** `cancel_requested_by` for the console: the merchant by kind, an operator
 *  by email ("operator:<email>"). */
function requester(
  value: unknown,
): StoreBillingSubscription["cancelRequestedBy"] {
  const raw = text(value).trim();
  if (!raw) return null;
  if (!raw.startsWith("operator")) return { kind: "merchant" };
  const email = raw.startsWith("operator:") ? raw.slice(9).trim() : "";
  return { kind: "operator", email: email || null };
}

// ── Refund writes (superadmin) ──────────────────────────────────────────────

/**
 * "Send refunds automatically" (Billing & tax). When on, the hourly pass
 * sends the refunds StoreMink owes by itself; when off, they wait on the
 * Refunds page. Refunds an operator issues are always sent at once.
 */
export async function setAutoRefunds(
  on: unknown,
): Promise<BillingActionResult> {
  const viewer = await superadmin();
  if (!viewer) return { error: SETTINGS_GATE_MESSAGE };
  const saved = await savePlatformAutoRefunds(on as boolean, viewer.email);
  if (!saved.ok) return { error: saved.error };
  logInfo("billing.console.auto_refunds", { on, by: viewer.email });
  refreshRefundPages();
  return { success: true };
}

/** Send an owed refund now (the Refunds page's Send, no dialog). */
export async function sendRefund(
  refundId: unknown,
): Promise<RefundWriteResult> {
  const viewer = await superadmin();
  if (!viewer) return { error: REFUND_GATE_MESSAGE };
  const res = await refunds.sendRefundNow({
    refundId: text(refundId),
    operator: viewer.email,
  });
  refreshRefundPages();
  return fromHelper(res);
}

/** Send a failed refund again, as a new refund (the "Try again" dialog). */
export async function retryRefund(
  refundId: unknown,
  note: unknown,
): Promise<RefundWriteResult> {
  const viewer = await superadmin();
  if (!viewer) return { error: REFUND_GATE_MESSAGE };
  const res = await refunds.retryRefund({
    refundId: text(refundId),
    note: text(note),
    operator: viewer.email,
  });
  refreshRefundPages();
  return fromHelper(res);
}

/**
 * Decide an owed refund is not to be sent (the "Cancel" dialog). No email
 * goes to the merchant; the dialog tells the operator to write to them.
 */
export async function cancelRefund(
  refundId: unknown,
  note: unknown,
): Promise<RefundWriteResult> {
  const viewer = await superadmin();
  if (!viewer) return { error: REFUND_GATE_MESSAGE };
  const res = await refunds.cancelOwedRefund({
    refundId: text(refundId),
    note: text(note),
    operator: viewer.email,
  });
  refreshRefundPages();
  return fromHelper(res);
}

export interface RecordRefundInput {
  /** The owed or failed refund this settles, if any. */
  refundId?: string | null;
  /** The store being viewed; null for a deleted store's invoice; omitted
   *  from the Refunds page, which lists every store. */
  storeId?: string | null;
  invoiceId: string;
  attemptId: string;
  amountInr: number | string;
  method: "bank_transfer" | "razorpay";
  /** The UTR, or the refund id made in the Razorpay dashboard. */
  reference: string;
  note: string;
  reason?: RefundReason;
}

/**
 * Record a refund made outside StoreMink: a bank transfer, or one made by
 * hand in the Razorpay dashboard. The credit note is issued and the merchant
 * emailed when it saves.
 */
export async function recordRefundMadeOutside(
  input: RecordRefundInput,
): Promise<RefundWriteResult> {
  const viewer = await superadmin();
  if (!viewer) return { error: REFUND_GATE_MESSAGE };
  const res = await refunds.recordRefundMadeOutside({
    refundId: input?.refundId ? text(input.refundId) : null,
    ...(input?.storeId !== undefined
      ? { storeId: input.storeId === null ? null : text(input.storeId) }
      : {}),
    invoiceId: text(input?.invoiceId),
    attemptId: text(input?.attemptId),
    amountPaise: rupeesToPaise(input?.amountInr),
    method: input?.method,
    reference: text(input?.reference),
    note: text(input?.note),
    operator: viewer.email,
    ...(input?.reason !== undefined ? { reason: input.reason } : {}),
  });
  refreshRefundPages();
  return fromHelper(res);
}

export interface IssueRefundInput {
  /** The store whose page this is; null for a deleted store's invoice (the
   *  reconciliation queue's items). The helper checks the invoice is its. */
  storeId: string | null;
  invoiceId: string;
  /** The payment to refund. Omitted: the invoice's payment with the most
   *  left to refund. */
  attemptId?: string | null;
  amountInr: number | string;
  reason: RefundReason;
  note: string;
}

/**
 * "Issue a refund" (store page, and the reconciliation queue's items): one
 * refund of one payment, written owed and sent at once. Reason "Plan ended
 * before this cycle" (decision D7) is accepted only for a closed invoice or
 * a paid renewal above the plan's last reached cycle; "Paid twice" gets no
 * credit note and leaves the invoice paid.
 */
export async function issueRefund(
  input: IssueRefundInput,
): Promise<RefundWriteResult> {
  const viewer = await superadmin();
  if (!viewer) return { error: REFUND_GATE_MESSAGE };
  const invoiceId = text(input?.invoiceId);
  let attemptId = text(input?.attemptId);
  if (!attemptId && isUuid(invoiceId)) {
    // The payment with the most left; with none, the helper refuses an
    // unknown payment in its own words.
    try {
      const left = await refunds.refundableForInvoice(invoiceId);
      attemptId =
        [...left.payments].sort((a, b) => b.leftPaise - a.leftPaise)[0]
          ?.attemptId ?? "";
    } catch (err) {
      logError("billing.console.refundable_read", err, { invoiceId });
      return { error: REFUND_THREW_MESSAGE };
    }
  }
  const res = await refunds.createOperatorRefund({
    storeId: input?.storeId === null ? null : text(input?.storeId),
    invoiceId,
    attemptId,
    amountPaise: rupeesToPaise(input?.amountInr),
    reason: input?.reason,
    note: text(input?.note),
    operator: viewer.email,
  });
  refreshRefundPages();
  return fromHelper(res);
}

// ── Plan writes (superadmin) ────────────────────────────────────────────────

/**
 * "Cancel at the end of the cycle", on the merchant's written request: the
 * same cancellation as theirs (autopay stops at once, the plan runs to the
 * cycle's end, a renewal already paid is refunded when it ends), recorded as
 * the operator's. The note says where the merchant asked.
 */
export async function cancelPlanAtCycleEnd(
  storeId: unknown,
  note: unknown,
): Promise<
  | { success: true; accessUntil: string | null; mandateRevoked: boolean }
  | { error: string }
> {
  const viewer = await superadmin();
  if (!viewer) return { error: PLAN_GATE_MESSAGE };
  const why = cleanNote(note);
  if (!why) return { error: refunds.NOTE_REQUIRED_MESSAGE };
  if (!isUuid(storeId)) return { error: STORE_NOT_FOUND_MESSAGE };

  const res = await cancelAtPeriodEnd({
    storeId,
    requestedBy: `operator:${viewer.email}`,
  });
  if (!res.ok) return { error: res.error };

  emitEvent({
    type: "platform.plan_changed",
    storeId: null,
    actor: { type: "operator", label: viewer.email },
    subject: { type: "store", id: storeId },
    payload: { plan: "Cancelling at the end of the cycle", note: why },
  });
  revalidatePath(`/dashboard/stores/${storeId}`);
  return {
    success: true,
    accessUntil: res.data.accessUntil,
    mandateRevoked: res.data.mandateRevoked,
  };
}

/**
 * "Undo cancellation", on the merchant's request: Keep my plan, as they
 * would press it (autopay stays off; a renewal already paid advances the
 * cycle at once).
 */
export async function undoPlanCancellation(
  storeId: unknown,
  note: unknown,
): Promise<
  { success: true; advanced: boolean; autopay: boolean } | { error: string }
> {
  const viewer = await superadmin();
  if (!viewer) return { error: PLAN_GATE_MESSAGE };
  const why = cleanNote(note);
  if (!why) return { error: refunds.NOTE_REQUIRED_MESSAGE };
  if (!isUuid(storeId)) return { error: STORE_NOT_FOUND_MESSAGE };

  const res = await resumeSubscription({
    storeId,
    requestedBy: `operator:${viewer.email}`,
  });
  if (!res.ok) return { error: res.error };

  emitEvent({
    type: "platform.plan_changed",
    storeId: null,
    actor: { type: "operator", label: viewer.email },
    subject: { type: "store", id: storeId },
    payload: { plan: "Cancellation undone", note: why },
  });
  revalidatePath(`/dashboard/stores/${storeId}`);
  return {
    success: true,
    advanced: res.data.advanced,
    autopay: res.data.autopay,
  };
}

/** Thrown inside the end's transaction to roll back the flag it set. */
class EndClaimLost extends Error {}

/**
 * "End the plan now" (design 6.8, review finding 14): the store moves to
 * Free at once, any open POS shift is closed, every invoice above the cycle
 * is closed, and, when asked, the unused part of the running cycle is
 * refunded from `refundFrom`.
 *
 * Order, each step after the one before:
 *   1. one transaction: lock the subscription row, set the cancel flag (who
 *      asked: the operator), withdraw autopay, then `endSubscription`, whose
 *      claim needs that flag;
 *   2. after it commits: the plan change in `plan_events`, the merchant's
 *      "plan ended" email (`notifyDowngraded`), `revalidateTag(STORE_TAG)`;
 *   3. the refunds, each its own write and send through the shared helper,
 *      with the operator's reason (never "Plan ended before this cycle": this
 *      cycle was reached). A failed one is reported; the plan stays ended.
 */
export async function endPlanNow(
  input: EndPlanNowInput,
): Promise<EndPlanNowResult> {
  const viewer = await superadmin();
  if (!viewer) return { error: PLAN_GATE_MESSAGE };
  const storeId = input?.storeId;
  const reason = input?.reason;
  if (!END_REASONS.includes(reason)) return { error: REASON_MESSAGE };
  const note = cleanNote(input?.note);
  if (!note) return { error: refunds.NOTE_REQUIRED_MESSAGE };
  if (!isUuid(storeId)) return { error: STORE_NOT_FOUND_MESSAGE };
  const refundUnused = input?.refundUnused === true;
  const now = new Date();
  const audit: PlanChange[] = [];

  let ended:
    | { cycle: CycleFacts; plan: string; from: Date }
    | { error: string };
  try {
    ended = await withService(async (db) => {
      // 1a. The row lock: the order evaluate and the downgrade claim keep
      // (subscription first, invoices second), so this waits for, or is
      // skipped by, an hourly run touching the same store.
      const [sub] = await db
        .select({
          plan: billingSubscriptions.plan,
          state: billingSubscriptions.state,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          currentPeriodStart: billingSubscriptions.currentPeriodStart,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          mandateId: billingSubscriptions.mandateId,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1)
        .for("update");
      if (!sub || !LIVE_STATES.includes(sub.state)) {
        return { error: NOTHING_TO_END_MESSAGE };
      }
      const resolved = resolveRefundFrom(input?.refundFrom, {
        required: reason === "feature_removed",
        now,
        periodStart: sub.currentPeriodStart,
      });
      if (!resolved.ok) return { error: resolved.error };

      // 1b. The flag `endSubscription`'s claim requires, with who asked.
      const flagged = await db
        .update(billingSubscriptions)
        .set({
          cancelAtPeriodEnd: true,
          cancelRequestedAt: now.toISOString(),
          cancelRequestedBy: `operator:${viewer.email}`,
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(billingSubscriptions.storeId, storeId),
            inArray(billingSubscriptions.state, LIVE_STATES),
          ),
        )
        .returning({ currentCycleSeq: billingSubscriptions.currentCycleSeq });
      const cycleSeq = flagged[0]?.currentCycleSeq;
      if (cycleSeq == null) throw new EndClaimLost();

      // 1c. Autopay stops with the plan, as at a cancellation (cancel.ts):
      // the standing permission to debit is withdrawn, not left lying idle.
      if (sub.mandateId) {
        await db
          .update(billingMandates)
          .set({
            status: "revoked",
            revokedAt: now.toISOString(),
            updatedAt: now.toISOString(),
          })
          .where(
            and(
              eq(billingMandates.id, sub.mandateId),
              eq(billingMandates.status, "active"),
            ),
          );
      }

      // 1d. The worker's own end: state cancelled, the plan dropped, an
      // open POS shift closed, every invoice above the cycle closed.
      const done = await endSubscription(db, {
        storeId,
        fromCycleSeq: cycleSeq,
        now,
        audit,
      });
      if (!done) throw new EndClaimLost();
      return {
        cycle: {
          storeId,
          currentCycleSeq: cycleSeq,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
        },
        plan: sub.plan,
        from: resolved.from,
      };
    });
  } catch (err) {
    if (err instanceof EndClaimLost) return { error: END_MOVED_MESSAGE };
    logError("billing.console.end_plan_now", err, { storeId });
    return { error: END_FAILED_MESSAGE };
  }
  if ("error" in ended) return { error: ended.error };

  logInfo("billing.console.plan_ended_now", {
    storeId,
    reason,
    refundUnused,
    by: viewer.email,
  });

  // 2. After the commit: the audit, the merchant's notice, the caches. An
  // audit failure never undoes the end (the `auditPlanChanges` rule).
  const fromDay =
    reason === "feature_removed"
      ? ` from ${istDate(ended.from.toISOString())}`
      : "";
  const auditNote = `Ended now by StoreMink (${END_REASON_LABELS[reason]}${fromDay}). ${note}`;
  if (audit.length > 0) {
    try {
      await withService((db) =>
        db.insert(planEvents).values(
          audit.map((c) => ({
            storeId: c.storeId,
            fromPlan: c.fromPlan,
            toPlan: c.toPlan,
            source: "operator",
            actor: viewer.email,
            note: auditNote,
          })),
        ),
      );
    } catch (err) {
      logError("billing.console.end_plan_audit", err, { storeId });
    }
  }
  await notifyDowngraded({ storeId, fromPlan: ended.plan });
  revalidateTag(STORE_TAG, "max");
  emitEvent({
    type: "platform.plan_changed",
    storeId: null,
    actor: { type: "operator", label: viewer.email },
    subject: { type: "store", id: storeId },
    payload: { plan: "free", note: auditNote },
  });
  revalidatePath(`/dashboard/stores/${storeId}`);

  // 3. The unused part of the cycle that was running.
  const result: { refunds: EndPlanRefund[]; skipped: EndPlanSkipped[] } = {
    refunds: [],
    skipped: [],
  };
  if (!refundUnused) return { success: true, ...result };

  let lines: UnusedLine[];
  try {
    lines = await withService((db) =>
      unusedRefundLines(db, ended.cycle, ended.from),
    );
  } catch (err) {
    logError("billing.console.end_plan_lines", err, { storeId });
    return {
      success: true,
      refunds: [
        {
          invoiceRef: null,
          amountPaise: 0,
          status: null,
          error: REFUND_THREW_MESSAGE,
        },
      ],
      skipped: [],
    };
  }

  for (const line of lines) {
    if (line.skippedWhy) {
      result.skipped.push({
        invoiceRef: line.invoiceRef,
        why: line.skippedWhy,
      });
      continue;
    }
    // Against the payment with the most left, split across payments when one
    // is not enough. A part under ₹1 cannot go through Razorpay alone.
    let remaining = line.amountPaise;
    for (const payment of line.payments) {
      if (remaining <= 0) break;
      const part = Math.min(payment.leftPaise, remaining);
      if (part <= 0) continue;
      remaining -= part;
      if (part < 100) {
        result.skipped.push({
          invoiceRef: line.invoiceRef,
          why: partUnderRupeeMessage(line.invoiceRef),
        });
        continue;
      }
      let res: RefundActionResult;
      try {
        res = await refunds.createOperatorRefund({
          storeId,
          invoiceId: line.invoiceId,
          attemptId: payment.attemptId,
          amountPaise: part,
          reason,
          note,
          operator: viewer.email,
        });
      } catch (err) {
        logError("billing.console.end_plan_refund", err, {
          storeId,
          invoiceId: line.invoiceId,
        });
        res = { ok: false, error: REFUND_THREW_MESSAGE };
      }
      result.refunds.push(
        res.ok
          ? {
              invoiceRef: line.invoiceRef,
              amountPaise: part,
              status: res.status,
              error: null,
            }
          : {
              invoiceRef: line.invoiceRef,
              amountPaise: part,
              status: null,
              error: res.error,
            },
      );
    }
  }
  if (result.refunds.length > 0) refreshRefundPages();
  return { success: true, ...result };
}
