import "server-only";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  aiCreditBalances,
  aiUsage,
  billingSubscriptions,
  stores,
} from "@/drizzle/schema";
import {
  aiAllowanceFor,
  effectivePlan,
  type PlanAllowanceOverrides,
  planAllows,
  PLAN_META,
  NO_COMP,
} from "@/lib/plans";
import { getPlanAllowancesLive } from "@/lib/plans/allowances";
import { getMinkConfig } from "@/lib/mink/config";
import { recordEvent } from "@/lib/notifications/record";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

// Per-store Mink credit quota — the first real enforcement of a plan limit.
// Every supported task consumes credits; the included cap comes from the
// store's plan (null = unlimited → no metering at all). Once the cycle's
// allowance is spent, purchased/granted top-up credits
// (ai_credit_balances / ai_credit_ledger, never expire) are consumed as the fallback —
// the expiring resource burns before the permanent one.
//
// Counting is atomic via the try_ai_generation / try_spend_ai_credit functions
// (single conditional UPDATE, the increment_coupon_usage pattern) so
// concurrent clicks can never overshoot the cap. A transient error fails
// OPEN — the quota is a cost guard rail, not a security boundary, and must
// never break a merchant's save flow.

/**
 * The month's allowance for this plan, in credits.
 *
 * ★★ IT DEPENDS ON WHETHER MINK CHARGES, because there is ONE pool. The legacy
 * caps (3/10/50) are sized for ~₹0.90 product descriptions; once a Mink
 * conversation spends from the same balance the allowance has to be the larger
 * one, or a Free store gets a single question a month. Read here rather than at
 * each call site so the quota gate, the dashboard's "X of Y used", the Mink
 * affordability check and settlement can never quote different numbers.
 */
function allowanceFor(
  plan: Parameters<typeof aiAllowanceFor>[0],
  allowances: PlanAllowanceOverrides,
) {
  return aiAllowanceFor(plan, getMinkConfig().chargeCredits, allowances);
}

/**
 * UTC calendar bucket. Used only when a store has no date of its own to count
 * from: its row could not be read, or neither date below is usable.
 */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export interface MinkCreditCycle {
  /** Ledger key: `cycle:<window start>`, or YYYY-MM for the calendar bucket. */
  period: string;
  /** Exact instant at which the included allowance refreshes. */
  resetsAt: string;
}

const MINK_CREDIT_CYCLE_MS = 30 * 24 * 60 * 60 * 1000;

/** A stored instant the window can be counted from: readable, and not after `now`. */
function usableAnchor(
  value: string | null | undefined,
  now: Date,
): Date | null {
  if (!value) return null;
  const anchor = new Date(value);
  const time = anchor.getTime();
  return Number.isFinite(time) && time <= now.getTime() ? anchor : null;
}

/**
 * One 30-day allowance window, counted from the store's OWN date (owner,
 * 21 Nov 2026: credits must never refresh on the 1st of the month for
 * everyone).
 *
 *   1. `planStartedAt`: the start of the current paid plan cycle. This matches
 *      StoreMink billing's deliberate 30-day month. Yearly subscriptions use
 *      consecutive 30-day credit windows inside their paid year.
 *   2. `storeCreatedAt`: a store with no paid cycle (Free, or a plan StoreMink
 *      granted) counts from the day it was created.
 *
 * The UTC calendar month is left only for a store with neither date readable.
 * Both anchored keys share the `cycle:` shape the draft credit ledger's CHECK
 * accepts (migration 0117, pinned by quota-cycle.test.ts).
 */
export function minkCreditCycleAt(
  now: Date = new Date(),
  planStartedAt?: string | null,
  storeCreatedAt?: string | null,
): MinkCreditCycle {
  const anchor =
    usableAnchor(planStartedAt, now) ?? usableAnchor(storeCreatedAt, now);
  if (!anchor) {
    const fallbackReset = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    return {
      period: currentPeriod(now),
      resetsAt: fallbackReset.toISOString(),
    };
  }

  const offset = Math.floor(
    (now.getTime() - anchor.getTime()) / MINK_CREDIT_CYCLE_MS,
  );
  const start = new Date(anchor.getTime() + offset * MINK_CREDIT_CYCLE_MS);
  const reset = new Date(start.getTime() + MINK_CREDIT_CYCLE_MS);
  return {
    period: `cycle:${start.toISOString()}`,
    resetsAt: reset.toISOString(),
  };
}

export async function getMinkCreditCycle(
  storeId: string,
  now: Date = new Date(),
): Promise<MinkCreditCycle> {
  try {
    // One read from the store outwards: a Free store has no subscription row,
    // and its own creation date is what its window is counted from.
    const [row] = await withService((db) =>
      db
        .select({
          startedAt: billingSubscriptions.currentPeriodStart,
          createdAt: stores.createdAt,
        })
        .from(stores)
        .leftJoin(
          billingSubscriptions,
          eq(billingSubscriptions.storeId, stores.id),
        )
        .where(eq(stores.id, storeId))
        .limit(1),
    );
    return minkCreditCycleAt(now, row?.startedAt, row?.createdAt);
  } catch (error) {
    console.error(
      "getMinkCreditCycle (using calendar fallback):",
      error instanceof Error ? error.message : error,
    );
    return minkCreditCycleAt(now);
  }
}

/**
 * Exactly what one consumeAiQuota call took, so refundAiQuota can give back
 * that and nothing else: one unit of the plan cycle's included allowance (with
 * the period it was counted in), one purchased or granted credit, or nothing
 * at all (an unlimited plan, or a read that failed open).
 *
 * ★ EVERY TAKE HAS ITS OWN ID, minted here. It is what makes a refund
 * idempotent: refund_ai_quota records the id before it gives anything back,
 * so a second refund of the same take finds it and gives back nothing.
 */
export type AiQuotaTake =
  | { source: "plan"; takeId: string; period: string }
  | { source: "credit"; takeId: string }
  | { source: "none" };

const NOTHING_TAKEN: AiQuotaTake = { source: "none" };

// ★ Takes given back in this process. The low-balance notice reads the
// balance AFTER the response, by which time a failed generation's credit is
// back, so a store sitting at exactly LOW_REMAINING was told "3 left" again on
// every failure. A refunded take reports nothing. Weak, so a take is forgotten
// with the request that held it.
const refundedTakes = new WeakSet<AiQuotaTake>();

export interface QuotaResult {
  allowed: boolean;
  /** Present whenever `allowed`: what was taken, for refundAiQuota. */
  taken?: AiQuotaTake;
  /** Friendly, plan-aware message when blocked. */
  error?: string;
}

/**
 * How often one store, and one admin in it, may ask Generate with AI to
 * write. ★★ THE ONE BOUND ON A LOOP OF FAILURES (robustness review of B1):
 * every way out that does not deliver gives its credit back, a reply cut short
 * at its token limit included, and Google bills those tokens all the same.
 * Before the refunds a failing request still cost the store a credit, which
 * was the only thing that stopped a script asking for copy that always
 * fails. Generous for a person (a click every few seconds, all day), and
 * shared by every Generate with AI button, since each costs the same.
 */
export const AI_COPY_RATE_LIMITS = {
  storePerMinute: 20,
  storePerHour: 200,
  adminPerMinute: 10,
} as const;

/** What a store over its Generate with AI rate is told. */
export const AI_COPY_RATE_LIMITED_MESSAGE =
  "Your store has asked AI to write a lot in a short time. Try again a little later.";

/** Whether one more Generate with AI request is within the rates. Fails open. */
async function withinAiCopyRates(
  storeId: string,
  actorId: string,
): Promise<boolean> {
  const limits = AI_COPY_RATE_LIMITS;
  const [storeMinute, storeHour, adminMinute] = await Promise.all([
    rateLimit(`ai-copy:store:${storeId}`, {
      max: limits.storePerMinute,
      windowSeconds: 60,
    }),
    rateLimit(`ai-copy:store-hour:${storeId}`, {
      max: limits.storePerHour,
      windowSeconds: 3_600,
    }),
    rateLimit(`ai-copy:admin:${storeId}:${actorId}`, {
      max: limits.adminPerMinute,
      windowSeconds: 60,
    }),
  ]);
  if (storeMinute.allowed && storeHour.allowed && adminMinute.allowed) {
    return true;
  }
  // Content-free: which rate, never what was asked.
  logWarn("ai.quota: rate limited", {
    storeId,
    storeMinute: storeMinute.allowed,
    storeHour: storeHour.allowed,
    adminMinute: adminMinute.allowed,
  });
  return false;
}

/**
 * Reserve one Mink credit for the store: the plan's included allowance first,
 * then one purchased/granted credit once the cycle is spent.
 * Call BEFORE the Gemini request in every AI action, and hand the result's
 * `taken` to refundAiQuota on every way out that does not deliver the copy
 * (lib/ai/credited-copy.ts does both).
 *
 * ★ THE RATES COME FIRST (`AI_COPY_RATE_LIMITS`, per store and per admin
 *   `actorId`), so a request over them reads nothing and takes nothing. The
 *   limiter fails open: a database hiccup must not stop the merchant writing.
 */
export async function consumeAiQuota(
  storeId: string,
  { actorId }: { actorId: string },
): Promise<QuotaResult> {
  if (!(await withinAiCopyRates(storeId, actorId))) {
    return { allowed: false, error: AI_COPY_RATE_LIMITED_MESSAGE };
  }
  let storeRow:
    | {
        plan: string;
        plan_expires_at: string | null;
        comp_plan: string | null;
        comp_expires_at: string | null;
      }
    | undefined;
  let cycle: MinkCreditCycle;
  // Read alongside the plan row and the cycle rather than after them: an
  // operator override decides whether this store is BLOCKED, so it has to be
  // live, and in the same Promise.all it costs no extra wall-clock.
  let allowances: PlanAllowanceOverrides;
  try {
    [[storeRow], cycle, allowances] = await Promise.all([
      withService((db) =>
        db
          .select({
            plan: stores.plan,
            plan_expires_at: stores.planExpiresAt,
            comp_plan: stores.compPlan,
            comp_expires_at: stores.compExpiresAt,
          })
          .from(stores)
          .where(eq(stores.id, storeId))
          .limit(1),
      ),
      getMinkCreditCycle(storeId),
      getPlanAllowancesLive(),
    ]);
  } catch (err) {
    console.error(
      "consumeAiQuota (plan read, failing open):",
      err instanceof Error ? err.message : err,
    );
    return { allowed: true, taken: NOTHING_TAKEN };
  }

  const plan = effectivePlan(storeRow ?? NO_COMP);
  const cap = allowanceFor(plan, allowances);
  if (cap === null) return { allowed: true, taken: NOTHING_TAKEN }; // unlimited

  let ok: boolean;
  try {
    const res = await withService((db) =>
      db.execute(
        sql`select try_ai_generation(p_store => ${storeId}, p_period => ${cycle.period}, p_cap => ${cap}) as ok`,
      ),
    );
    ok = (res.rows[0] as { ok: boolean } | undefined)?.ok === true;
  } catch (err) {
    console.error(
      "consumeAiQuota (RPC, failing open):",
      err instanceof Error ? err.message : err,
    );
    return { allowed: true, taken: NOTHING_TAKEN };
  }
  if (ok) {
    const taken: AiQuotaTake = {
      source: "plan",
      takeId: randomUUID(),
      period: cycle.period,
    };
    reportAiBalance(storeId, taken);
    return { allowed: true, taken };
  }

  // Monthly allowance spent — fall back to the purchased-credit balance.
  let spent: boolean;
  try {
    const res = await withService((db) =>
      db.execute(sql`select try_spend_ai_credit(p_store => ${storeId}) as ok`),
    );
    spent = (res.rows[0] as { ok: boolean } | undefined)?.ok === true;
  } catch (err) {
    console.error(
      "consumeAiQuota (credits, failing open):",
      err instanceof Error ? err.message : err,
    );
    return { allowed: true, taken: NOTHING_TAKEN };
  }
  if (spent) {
    const taken: AiQuotaTake = { source: "credit", takeId: randomUUID() };
    reportAiBalance(storeId, taken);
    return { allowed: true, taken };
  }

  return {
    allowed: false,
    error: planAllows(plan, "basic")
      ? `You've used all ${cap} Mink credits included in the ${PLAN_META[plan].name} plan for this cycle and have no top-up credits left. Buy Mink credits (Dashboard → Plans & Billing) or upgrade your plan.`
      : `You've used all ${cap} Mink credits included in the ${PLAN_META[plan].name} plan for this cycle. Upgrade your plan for more.`,
  };
}

/**
 * What refundAiQuota did: gave the take back; had nothing to give back (no
 * take, an unlimited plan, a read that failed open, or a take already given
 * back); or could not write the refund, so the credit stays spent.
 */
export type AiRefundOutcome = "refunded" | "none" | "failed";

/** Attempts at writing one refund: the first, and one more after a pause. */
export const AI_REFUND_ATTEMPTS = 2;
/** The pause before the second attempt: a random 300 to 600 ms. */
export const AI_REFUND_RETRY_DELAY_MS = { min: 300, max: 600 } as const;

/**
 * Give back what consumeAiQuota took when the work it paid for did not
 * happen: the model call failed, its reply was unusable, or something threw
 * before the copy reached the merchant (robustness audit B1: the credit used
 * to be taken before the model was asked and never returned). A plan take
 * lowers that period's `ai_usage.used` by one, never below 0; a credit take
 * puts one credit back on the balance with a ledger row (refund_ai_quota,
 * migration 20261023_0237_ai_credit_refund).
 *
 * ★ ONCE PER TAKE: a second call with the same take gives back nothing, so a
 * retried request or a double-wired caller cannot mint credits.
 *
 * ★ ASKED TWICE: a write that throws (the pool had no connection free within
 * its 5 s wait, a dropped socket) is tried once more after a short pause,
 * which the once-per-take rule makes safe even when the first did land.
 *
 * ★ FAILS SOFT: logs and answers "failed", never throws. A refund that could
 * not be written is a credit the store is owed, which an operator can grant
 * back from the log; the caller must then stop telling the merchant nothing
 * was charged (`withoutNothingChargedClaim`).
 */
export async function refundAiQuota(
  storeId: string,
  taken: AiQuotaTake | undefined,
): Promise<AiRefundOutcome> {
  if (!taken || taken.source === "none") return "none";
  const { source, takeId } = taken;
  const period = taken.source === "plan" ? taken.period : null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await withService((db) =>
        db.execute(
          sql`select refund_ai_quota(p_take => ${takeId}::uuid, p_store => ${storeId}::uuid, p_source => ${source}, p_period => ${period}::text) as refunded`,
        ),
      );
      const refunded =
        (res.rows[0] as { refunded?: unknown } | undefined)?.refunded === true;
      // ★ Given back either way: false means this take already was (by an
      //   earlier attempt whose answer was lost, say), so no notice follows.
      refundedTakes.add(taken);
      logInfo("ai.quota: refund", { storeId, source, refunded, attempt });
      return refunded ? "refunded" : "none";
    } catch (err) {
      if (attempt < AI_REFUND_ATTEMPTS) {
        await pause(
          AI_REFUND_RETRY_DELAY_MS.min +
            Math.random() *
              (AI_REFUND_RETRY_DELAY_MS.max - AI_REFUND_RETRY_DELAY_MS.min),
        );
        continue;
      }
      logError("ai.quota: refund failed", err, {
        storeId,
        source,
        attempts: attempt,
      });
      return "failed";
    }
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Remaining generations at which the merchant gets a heads-up. */
export const LOW_REMAINING = 3;

/**
 * Should a store with `remaining` generations left be warned right now? PURE,
 * so the once-only rule can be tested without a database.
 *
 * EXACT equality, not "≤ 3 left": a consume moves the count by exactly one, so
 * matching a point instead of a band is what keeps this to ONE notification
 * rather than one per generation for the rest of the month (the same rule the
 * stock alerts use). Buying credits raises the count and re-arms it.
 *
 * TWO points, not one. The FREE plan's cap IS 3, so its remaining count goes
 * 3 → 2 on the very first generation and would never equal LOW_REMAINING —
 * the entire free tier would silently never be warned. Zero catches that case
 * and is the more useful signal anyway ("your allowance is gone"), while a
 * bigger plan still gets the earlier heads-up.
 */
export function aiWarnAt(remaining: number): boolean {
  return remaining === LOW_REMAINING || remaining === 0;
}

/**
 * Warn once when a store's AI allowance runs low (see aiWarnAt).
 *
 * Deferred and fully swallowed: a quota warning must never affect the
 * generation that triggered it. A take that was refunded reports nothing
 * (see refundedTakes).
 */
function reportAiBalance(storeId: string, taken: AiQuotaTake): void {
  try {
    after(async () => {
      if (refundedTakes.has(taken)) return;
      try {
        const usage = await getAiUsage(storeId);
        if (usage.cap === null) return; // unlimited plan — nothing to warn about
        const remaining =
          Math.max(0, usage.cap - usage.used) + usage.creditBalance;
        if (!aiWarnAt(remaining)) return;

        await recordEvent({
          type: "ai.credits_low",
          storeId,
          actor: { type: "system" },
          payload: {
            remaining,
            used: usage.used,
            cap: usage.cap,
            credits: usage.creditBalance,
          },
        });
      } catch (err) {
        console.error(
          "reportAiBalance:",
          err instanceof Error ? err.message : err,
        );
      }
    });
  } catch {
    // No request scope (a script or a test) — nothing to defer onto.
  }
}

export interface AiUsageSummary {
  used: number;
  /** null = unlimited on this plan. */
  cap: number | null;
  /** Purchased/granted credits remaining (never expire). */
  creditBalance: number;
  /** Exact monthly refresh instant for the included Mink allowance. */
  resetsAt: string;
  /**
   * False when the read FAILED and these numbers are a safe placeholder rather
   * than the store's real balance. ★ A failed read reports `cap: null`, which
   * is byte-identical to an unmetered plan — so a caller that renders the
   * summary (rather than merely failing open on it) must check this first, or
   * it tells a store with nothing left that it has unlimited credits at exactly
   * the moment the database is unreachable.
   */
  available: boolean;
}

/** Current plan-cycle usage for the dashboard. */
export async function getAiUsage(storeId: string): Promise<AiUsageSummary> {
  try {
    const [cycle, allowances] = await Promise.all([
      getMinkCreditCycle(storeId),
      getPlanAllowancesLive(),
    ]);
    return await withService(async (db) => {
      const storeRows = await db
        .select({
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
          comp_plan: stores.compPlan,
          comp_expires_at: stores.compExpiresAt,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      const usageRows = await db
        .select({ used: aiUsage.used })
        .from(aiUsage)
        .where(
          and(eq(aiUsage.storeId, storeId), eq(aiUsage.period, cycle.period)),
        )
        .limit(1);
      const creditRows = await db
        .select({ balance: aiCreditBalances.balance })
        .from(aiCreditBalances)
        .where(eq(aiCreditBalances.storeId, storeId))
        .limit(1);
      return {
        used: usageRows[0]?.used ?? 0,
        cap: allowanceFor(effectivePlan(storeRows[0] ?? {}), allowances),
        creditBalance: creditRows[0]?.balance ?? 0,
        resetsAt: cycle.resetsAt,
        available: true,
      };
    });
  } catch (err) {
    console.error("getAiUsage:", err instanceof Error ? err.message : err);
    return {
      used: 0,
      cap: null,
      creditBalance: 0,
      resetsAt: minkCreditCycleAt().resetsAt,
      available: false,
    };
  }
}
