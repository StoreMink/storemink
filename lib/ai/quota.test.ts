/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";

// consumeAiQuota and refundAiQuota over a mocked database: what a take
// reports, and what a refund asks the database to give back. The SQL itself
// (one refund per take, never below 0, the ledger row) is proved against a
// real Postgres in quota.local.test.ts.

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/plans/allowances", () => ({
  getPlanAllowancesLive: vi.fn(async () => ({
    free: null,
    basic: null,
    pro: null,
  })),
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ chargeCredits: false })),
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ recordEvent: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));

import {
  AI_COPY_RATE_LIMITED_MESSAGE,
  AI_COPY_RATE_LIMITS,
  consumeAiQuota,
  refundAiQuota,
} from "./quota";
import { withService } from "@/lib/db/client";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { after } from "next/server";
import { recordEvent } from "@/lib/notifications/record";

const STORE = "a0000000-0000-4000-8000-000000000001";
const ADMIN = "admin-uid-1";
const ACTOR = { actorId: ADMIN };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A Basic store on its legacy 10-a-month allowance, no paid cycle anchor. */
function basicStore(executeQueue: any[][]) {
  dbHolder.current = makeDbMock({
    selectByTable: {
      stores: [
        [
          {
            plan: "basic",
            plan_expires_at: null,
            comp_plan: null,
            comp_expires_at: null,
          },
        ],
      ],
      billing_subscriptions: [[]],
    },
    executeQueue,
  });
}

describe("consumeAiQuota", () => {
  beforeEach(() => {
    vi.mocked(withService).mockImplementation((fn: any) =>
      Promise.resolve(fn(dbHolder.current.db)),
    );
  });

  it("reports a plan take with its own id and the period it was counted in", async () => {
    basicStore([[{ ok: true }]]);
    const result = await consumeAiQuota(STORE, ACTOR);
    expect(result.allowed).toBe(true);
    expect(result.taken).toMatchObject({ source: "plan" });
    const taken = result.taken as { takeId: string; period: string };
    expect(taken.takeId).toMatch(UUID);
    // No paid cycle anchor, so the calendar-month key.
    expect(taken.period).toMatch(/^\d{4}-\d{2}$/);
    // The period the take reports is the one try_ai_generation counted.
    const [call] = dbHolder.current.calls.execute;
    expect(sqlText(call)).toContain("try_ai_generation");
    expect(sqlParamValues(call)).toContain(taken.period);
  });

  it("reports a purchased-credit take once the allowance is spent", async () => {
    basicStore([[{ ok: false }], [{ ok: true }]]);
    const result = await consumeAiQuota(STORE, ACTOR);
    expect(result.allowed).toBe(true);
    expect(result.taken).toEqual({
      source: "credit",
      takeId: expect.stringMatching(UUID),
    });
    expect(sqlText(dbHolder.current.calls.execute[1])).toContain(
      "try_spend_ai_credit",
    );
  });

  it("gives every take its own id", async () => {
    basicStore([[{ ok: true }]]);
    const first = (await consumeAiQuota(STORE, ACTOR)).taken as {
      takeId: string;
    };
    basicStore([[{ ok: true }]]);
    const second = (await consumeAiQuota(STORE, ACTOR)).taken as {
      takeId: string;
    };
    expect(first.takeId).not.toBe(second.takeId);
  });

  it("reports nothing taken when it fails open", async () => {
    basicStore([]);
    dbHolder.current.db.execute.mockRejectedValueOnce(new Error("db down"));
    const result = await consumeAiQuota(STORE, ACTOR);
    expect(result).toEqual({ allowed: true, taken: { source: "none" } });
  });

  it("reports nothing taken when the plan read fails open", async () => {
    vi.mocked(withService).mockRejectedValueOnce(new Error("db down"));
    basicStore([]);
    const result = await consumeAiQuota(STORE, ACTOR);
    expect(result).toEqual({ allowed: true, taken: { source: "none" } });
  });

  it("blocks, taking nothing, when both the allowance and the credits are spent", async () => {
    basicStore([[{ ok: false }], [{ ok: false }]]);
    const result = await consumeAiQuota(STORE, ACTOR);
    expect(result.allowed).toBe(false);
    expect(result.taken).toBeUndefined();
    expect(result.error).toMatch(/Mink credits/);
  });
});

// ★★ A failed generation gives its credit back, so the rates are what bound a
// loop of failures (robustness review of B1): checked before anything is read
// or taken, per store and per admin, shared by every Generate with AI button.
describe("consumeAiQuota's rates", () => {
  beforeEach(() => {
    vi.mocked(withService).mockImplementation((fn: any) =>
      Promise.resolve(fn(dbHolder.current.db)),
    );
  });

  it("asks the store's minute and hour, and the admin's minute", async () => {
    basicStore([[{ ok: true }]]);
    await consumeAiQuota(STORE, ACTOR);
    expect(vi.mocked(rateLimit).mock.calls).toEqual([
      [
        `ai-copy:store:${STORE}`,
        { max: AI_COPY_RATE_LIMITS.storePerMinute, windowSeconds: 60 },
      ],
      [
        `ai-copy:store-hour:${STORE}`,
        { max: AI_COPY_RATE_LIMITS.storePerHour, windowSeconds: 3_600 },
      ],
      [
        `ai-copy:admin:${STORE}:${ADMIN}`,
        { max: AI_COPY_RATE_LIMITS.adminPerMinute, windowSeconds: 60 },
      ],
    ]);
  });

  it.each([0, 1, 2])(
    "refuses, reading and taking nothing, when rate %i is spent",
    async (spent) => {
      basicStore([[{ ok: true }]]);
      vi.mocked(rateLimit).mockImplementation(async () => ({ allowed: true }));
      for (let i = 0; i < 3; i += 1) {
        vi.mocked(rateLimit).mockImplementationOnce(async () => ({
          allowed: i !== spent,
        }));
      }
      const result = await consumeAiQuota(STORE, ACTOR);
      expect(result).toEqual({
        allowed: false,
        error: AI_COPY_RATE_LIMITED_MESSAGE,
      });
      expect(withService).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        "ai.quota: rate limited",
        expect.objectContaining({ storeId: STORE }),
      );
    },
  );

  it("says so without a number of credits or a long dash", () => {
    expect(AI_COPY_RATE_LIMITED_MESSAGE).not.toMatch(
      /\d|credit|\u2014|\u2013/i,
    );
  });
});

describe("refundAiQuota", () => {
  beforeEach(() => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ refunded: true }]] });
    vi.mocked(withService).mockImplementation((fn: any) =>
      Promise.resolve(fn(dbHolder.current.db)),
    );
  });

  it("gives back a plan take in the period it was counted in", async () => {
    const take = {
      source: "plan" as const,
      takeId: "11111111-1111-4111-8111-111111111111",
      period: "cycle:2026-10-15T06:30:00.000Z",
    };
    expect(await refundAiQuota(STORE, take)).toBe("refunded");
    const [call] = dbHolder.current.calls.execute;
    expect(sqlText(call)).toContain("refund_ai_quota");
    expect(sqlParamValues(call)).toEqual([
      take.takeId,
      STORE,
      "plan",
      take.period,
    ]);
  });

  it("gives back a purchased credit, with no period", async () => {
    const take = {
      source: "credit" as const,
      takeId: "22222222-2222-4222-8222-222222222222",
    };
    expect(await refundAiQuota(STORE, take)).toBe("refunded");
    expect(sqlParamValues(dbHolder.current.calls.execute[0])).toEqual([
      take.takeId,
      STORE,
      "credit",
      null,
    ]);
  });

  // ★ The database answers false for a take it has already refunded.
  it("reports a second refund of the same take as nothing given back", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ refunded: false }]] });
    expect(
      await refundAiQuota(STORE, {
        source: "credit",
        takeId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toBe("none");
  });

  it("asks nothing of the database when nothing was taken", async () => {
    expect(await refundAiQuota(STORE, { source: "none" })).toBe("none");
    expect(await refundAiQuota(STORE, undefined)).toBe("none");
    expect(withService).not.toHaveBeenCalled();
  });

  // ★ A write that throws (no connection free within the pool's wait, a
  //   dropped socket) is asked once more; the once-per-take rule makes that
  //   safe even when the first one landed.
  it("asks once more, after a short pause, when the write throws", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(withService).mockRejectedValueOnce(new Error("db busy"));
      const pending = refundAiQuota(STORE, {
        source: "plan",
        takeId: "55555555-5555-4555-8555-555555555555",
        period: "2026-10",
      });
      await vi.advanceTimersByTimeAsync(299);
      expect(withService).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(301);
      await expect(pending).resolves.toBe("refunded");
      expect(withService).toHaveBeenCalledTimes(2);
      expect(logError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws: a refund that could not be written twice is logged and reported", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(withService)
        .mockRejectedValueOnce(new Error("db down"))
        .mockRejectedValueOnce(new Error("db down"));
      const pending = refundAiQuota(STORE, {
        source: "plan",
        takeId: "44444444-4444-4444-8444-444444444444",
        period: "2026-10",
      });
      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toBe("failed");
      expect(withService).toHaveBeenCalledTimes(2);
      expect(logError).toHaveBeenCalledWith(
        "ai.quota: refund failed",
        expect.any(Error),
        { storeId: STORE, source: "plan", attempts: 2 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the low-balance notice after a take", () => {
  const basicRow = {
    plan: "basic",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
  };

  /**
   * A Basic store (10 a cycle) that has used 7 once this take lands, so the
   * deferred read finds exactly 3 left: the threshold that sends a notice.
   */
  function storeAtThreeLeft(executeQueue: any[][]) {
    dbHolder.current = makeDbMock({
      selectByTable: {
        // The take's plan read, then the notice's own.
        stores: [[basicRow], [basicRow]],
        billing_subscriptions: [[], []],
        ai_usage: [[{ used: 7 }]],
        ai_credit_balances: [[{ balance: 0 }]],
      },
      executeQueue,
    });
  }

  /** The callback consumeAiQuota deferred with after(). */
  function deferredReport(): () => Promise<void> {
    const call = vi.mocked(after).mock.calls.at(-1);
    expect(call).toBeDefined();
    return call![0] as () => Promise<void>;
  }

  beforeEach(() => {
    vi.mocked(withService).mockImplementation((fn: any) =>
      Promise.resolve(fn(dbHolder.current.db)),
    );
  });

  it("is sent for a take that was kept", async () => {
    storeAtThreeLeft([[{ ok: true }]]);
    await consumeAiQuota(STORE, ACTOR);
    await deferredReport()();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ai.credits_low",
        storeId: STORE,
        payload: expect.objectContaining({ remaining: 3 }),
      }),
    );
  });

  // ★ The read runs after the response, when a failed generation's credit is
  // already back: without the skip, every failure at 3 left said "3 left" again.
  it("is not sent, and reads nothing, for a take that was given back", async () => {
    storeAtThreeLeft([[{ ok: true }], [{ refunded: true }]]);
    const quota = await consumeAiQuota(STORE, ACTOR);
    const report = deferredReport();
    expect(await refundAiQuota(STORE, quota.taken)).toBe("refunded");
    const reads = vi.mocked(withService).mock.calls.length;
    await report();
    expect(vi.mocked(withService).mock.calls.length).toBe(reads);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  // ★ False from the database means this take was already given back (an
  //   earlier attempt whose answer was lost): no notice for it either.
  it("is not sent for a take the database had already given back", async () => {
    storeAtThreeLeft([[{ ok: true }], [{ refunded: false }]]);
    const quota = await consumeAiQuota(STORE, ACTOR);
    const report = deferredReport();
    expect(await refundAiQuota(STORE, quota.taken)).toBe("none");
    await report();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("is still sent when the refund could not be written", async () => {
    storeAtThreeLeft([[{ ok: true }]]);
    const quota = await consumeAiQuota(STORE, ACTOR);
    const report = deferredReport();
    vi.useFakeTimers();
    try {
      vi.mocked(withService)
        .mockRejectedValueOnce(new Error("db down"))
        .mockRejectedValueOnce(new Error("db down"));
      const refund = refundAiQuota(STORE, quota.taken);
      await vi.advanceTimersByTimeAsync(600);
      expect(await refund).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
    await report();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ai.credits_low" }),
    );
  });
});

// ★★ THE RULES THAT DECIDE WHETHER A REFUND CAN MINT CREDITS, pinned on the
// migration's own SQL. quota.local.test.ts proves them against a real
// Postgres, but it is opt-in and CI skips it, while 0237 is still pending on
// staging and production: an edit that dropped one would otherwise pass every
// check, and a refund called twice for one take would give twice.
describe("migration 0237: refund_ai_quota", () => {
  const sql = readFileSync(
    "drizzle/migrations/sql/20261023_0237_ai_credit_refund.sql",
    "utf8",
  ).replace(/\s+/g, " ");
  const body = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.refund_ai_quota"),
  );
  const at = (text: string) => {
    const index = body.indexOf(text);
    expect(index, text).toBeGreaterThan(-1);
    return index;
  };

  it("keeps one row per take, keyed on the take", () => {
    expect(sql).toContain("take_id uuid PRIMARY KEY");
  });

  it("records the take first and gives back only when that row is new", () => {
    const record = at(
      "INSERT INTO public.ai_quota_refunds (take_id, store_id, source, period)",
    );
    const once = at("ON CONFLICT (take_id) DO NOTHING;");
    const guard = at("IF NOT FOUND THEN RETURN false;");
    const plan = at("UPDATE public.ai_usage");
    const credit = at("INSERT INTO public.ai_credit_ledger");
    expect(record).toBeLessThan(once);
    expect(once).toBeLessThan(guard);
    expect(guard).toBeLessThan(plan);
    expect(guard).toBeLessThan(credit);
  });

  it("never lowers the plan count below 0", () => {
    at(
      "SET used = used - 1 WHERE store_id = p_store AND period = p_period AND used > 0;",
    );
  });

  it("gives a credit back as one ledger grant and one more on the balance", () => {
    at("VALUES ( p_store, 1, 'grant', 'refund:' || p_take::text,");
    at(
      "ON CONFLICT (store_id) DO UPDATE SET balance = public.ai_credit_balances.balance + 1,",
    );
  });

  it("runs as its owner on an empty search path, for the service role only", () => {
    at("SECURITY DEFINER SET search_path = ''");
    at(
      "REVOKE ALL ON FUNCTION public.refund_ai_quota(uuid, uuid, text, text) FROM PUBLIC, app_user;",
    );
    at(
      "GRANT EXECUTE ON FUNCTION public.refund_ai_quota(uuid, uuid, text, text) TO app_service;",
    );
  });
});
