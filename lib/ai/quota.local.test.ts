/** Rollback-only checks of the Generate with AI refund against the local
 * database: consumeAiQuota takes a plan unit or a purchased credit, and
 * refundAiQuota (refund_ai_quota, migration 20261023_0237_ai_credit_refund)
 * gives back exactly that, once. Run with AI_QUOTA_LOCAL_TEST=1; the fixed
 * loopback address keeps it off Cloud SQL, and everything it writes is
 * rolled back. */
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  queue: Promise.resolve() as Promise<unknown>,
}));
// ★ Serialised: consumeAiQuota runs three reads at once, and savepoints on one
// connection only nest correctly one call at a time.
vi.mock("@/lib/db/client", () => ({
  withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const run = service.queue.then(async () => {
      const name = `ai_quota_${++service.count}`;
      await service.client!.query(`SAVEPOINT ${name}`);
      try {
        const value = await fn(service.db!);
        await service.client!.query(`RELEASE SAVEPOINT ${name}`);
        return value;
      } catch (error) {
        await service.client!.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      }
    });
    service.queue = run.catch(() => undefined);
    return run;
  },
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  consumeAiQuota,
  currentPeriod,
  getMinkCreditCycle,
  minkCreditCycleAt,
  refundAiQuota,
} from "./quota";
import { logError } from "@/lib/observability/logger";

const enabled = process.env.AI_QUOTA_LOCAL_TEST === "1";

const PLAN_STORE = crypto.randomUUID();
const CREDIT_STORE = crypto.randomUUID();
const PAID_STORE = crypto.randomUUID();

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
/** ★ The dummy stores were created in PREVIOUS MONTHS, on a whole millisecond
 *  so the window key the database's timestamp gives is the one computed here.
 *  A store's included credits are counted in 30-day windows from its own date
 *  (owner, 21 Nov 2026), never from the 1st of the month. */
const PLAN_STORE_CREATED = daysAgo(75);
const CREDIT_STORE_CREATED = daysAgo(40);
const PAID_STORE_CREATED = daysAgo(100);
/** The paid store's current plan cycle began 26 days ago. */
const PAID_CYCLE_START = daysAgo(26);
const periodOf = (createdAt: Date) =>
  minkCreditCycleAt(new Date(), null, createdAt.toISOString()).period;

describe.skipIf(!enabled)(
  "Generate with AI refunds on the local database",
  () => {
    let client: Client;
    /** The window each dummy store is in today, counted from its own date. */
    const period = periodOf(PLAN_STORE_CREATED);
    const creditPeriod = periodOf(CREDIT_STORE_CREATED);
    const periods: Record<string, string> = {
      [PLAN_STORE]: period,
      [CREDIT_STORE]: creditPeriod,
    };

    const used = async (store: string) =>
      (
        await client.query(
          "select used from public.ai_usage where store_id = $1 and period = $2",
          [store, periods[store]],
        )
      ).rows[0]?.used as number | undefined;
    const balance = async (store: string) =>
      (
        await client.query(
          "select balance from public.ai_credit_balances where store_id = $1",
          [store],
        )
      ).rows[0]?.balance as number | undefined;
    const ledger = async (store: string) =>
      (
        await client.query(
          "select kind, delta, ref, note from public.ai_credit_ledger where store_id = $1 order by created_at, kind",
          [store],
        )
      ).rows;

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.AI_QUOTA_LOCAL_TEST_USER || process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
      service.client = client;
      service.db = drizzle(client, { schema: { ...schema, ...relations } });

      for (const [id, slug, createdAt] of [
        [
          PLAN_STORE,
          `ai-refund-plan-${PLAN_STORE.slice(0, 8)}`,
          PLAN_STORE_CREATED,
        ],
        [
          CREDIT_STORE,
          `ai-refund-credit-${CREDIT_STORE.slice(0, 8)}`,
          CREDIT_STORE_CREATED,
        ],
        [
          PAID_STORE,
          `ai-window-paid-${PAID_STORE.slice(0, 8)}`,
          PAID_STORE_CREATED,
        ],
      ] as const) {
        await client.query(
          "insert into public.stores (id, name, slug, plan, created_at) values ($1, 'Refund probe', $2, 'basic', $3)",
          [id, slug, createdAt.toISOString()],
        );
      }
      await client.query(
        `insert into public.billing_subscriptions
           (store_id, plan, period, state, current_cycle_seq,
            current_period_start, current_period_end, plan_source)
         values ($1, 'basic', 'monthly', 'active', 3, $2, $3, 'paid')`,
        [
          PAID_STORE,
          PAID_CYCLE_START.toISOString(),
          new Date(PAID_CYCLE_START.getTime() + 30 * DAY).toISOString(),
        ],
      );
      // The credit store has spent its allowance and holds one top-up credit.
      await client.query(
        "insert into public.ai_usage (store_id, period, used) values ($1, $2, 1000000)",
        [CREDIT_STORE, creditPeriod],
      );
      await client.query(
        "insert into public.ai_credit_balances (store_id, balance) values ($1, 1)",
        [CREDIT_STORE],
      );
    });

    afterAll(async () => {
      if (!client) return;
      await client.query("ROLLBACK");
      await client.end();
    });

    // The owner's rule, on stores that began in previous months.
    describe("★★ included credits are counted from the store's own date, never the 1st of the month", () => {
      it("a store with no paid plan, created 75 days ago, is 15 days into its THIRD 30-day window", async () => {
        const cycle = await getMinkCreditCycle(PLAN_STORE, NOW);
        const windowStart = new Date(PLAN_STORE_CREATED.getTime() + 60 * DAY);
        expect(cycle.period).toBe(`cycle:${windowStart.toISOString()}`);
        expect(cycle.resetsAt).toBe(
          new Date(PLAN_STORE_CREATED.getTime() + 90 * DAY).toISOString(),
        );
        // Not the calendar month, and not a refresh on the 1st.
        expect(cycle.period).not.toBe(currentPeriod(NOW));
        expect(period).toBe(cycle.period);
      });

      it("a store on a paid plan counts from its current plan cycle, whenever the store was created", async () => {
        const cycle = await getMinkCreditCycle(PAID_STORE, NOW);
        expect(cycle.period).toBe(`cycle:${PAID_CYCLE_START.toISOString()}`);
        expect(cycle.resetsAt).toBe(
          new Date(PAID_CYCLE_START.getTime() + 30 * DAY).toISOString(),
        );
      });

      it("the day a window ends, the next one begins, with its own key", async () => {
        const boundary = new Date(PLAN_STORE_CREATED.getTime() + 90 * DAY);
        const before = await getMinkCreditCycle(
          PLAN_STORE,
          new Date(boundary.getTime() - 1),
        );
        const after = await getMinkCreditCycle(PLAN_STORE, boundary);
        expect(before.period).toBe(period);
        expect(after.period).toBe(`cycle:${boundary.toISOString()}`);
        expect(after.resetsAt).toBe(
          new Date(boundary.getTime() + 30 * DAY).toISOString(),
        );
      });

      it("★ what was used in an EARLIER window, or in the calendar month, does not count against this one", async () => {
        const earlier = `cycle:${new Date(
          PLAN_STORE_CREATED.getTime() + 30 * DAY,
        ).toISOString()}`;
        await client.query(
          "insert into public.ai_usage (store_id, period, used) values ($1, $2, 1000000), ($1, $3, 1000000)",
          [PLAN_STORE, earlier, currentPeriod(NOW)],
        );
        const quota = await consumeAiQuota(PLAN_STORE, {
          actorId: "local-probe",
        });
        // Taken from this window's allowance, which is untouched.
        expect(quota.taken).toMatchObject({ source: "plan", period });
        expect(await refundAiQuota(PLAN_STORE, quota.taken)).toBe("refunded");
        await client.query(
          "delete from public.ai_quota_refunds where store_id = $1",
          [PLAN_STORE],
        );
        expect(await used(PLAN_STORE)).toBe(0);
      });
    });

    it("gives a plan unit back once, in the period it was taken", async () => {
      const quota = await consumeAiQuota(PLAN_STORE, {
        actorId: "local-probe",
      });
      expect(quota.taken).toMatchObject({ source: "plan", period });
      expect(await used(PLAN_STORE)).toBe(1);

      expect(await refundAiQuota(PLAN_STORE, quota.taken)).toBe("refunded");
      expect(await used(PLAN_STORE)).toBe(0);

      // ★ The same take again gives back nothing.
      expect(await refundAiQuota(PLAN_STORE, quota.taken)).toBe("none");
      expect(await used(PLAN_STORE)).toBe(0);
      expect(await ledger(PLAN_STORE)).toEqual([]);

      // ★ And the counter never goes below 0, whatever is refunded.
      expect(
        await refundAiQuota(PLAN_STORE, {
          source: "plan",
          takeId: crypto.randomUUID(),
          period,
        }),
      ).toBe("refunded");
      expect(await used(PLAN_STORE)).toBe(0);
    });

    it("gives a purchased credit back once, as a ledger grant", async () => {
      const quota = await consumeAiQuota(CREDIT_STORE, {
        actorId: "local-probe",
      });
      expect(quota.taken).toMatchObject({ source: "credit" });
      expect(await balance(CREDIT_STORE)).toBe(0);
      const takeId = (quota.taken as { takeId: string }).takeId;

      expect(await refundAiQuota(CREDIT_STORE, quota.taken)).toBe("refunded");
      expect(await balance(CREDIT_STORE)).toBe(1);
      // The plan counter is untouched: the credit, not the allowance, came back.
      expect(await used(CREDIT_STORE)).toBe(1000000);

      // ★ A second refund of the same take mints nothing.
      expect(await refundAiQuota(CREDIT_STORE, quota.taken)).toBe("none");
      expect(await balance(CREDIT_STORE)).toBe(1);
      expect(await ledger(CREDIT_STORE)).toEqual([
        {
          kind: "grant",
          delta: 1,
          ref: `refund:${takeId}`,
          note: "Refund: an AI request failed",
        },
        { kind: "spend", delta: -1, ref: "ai-generation", note: null },
      ]);
    });

    it("records one refund row per take, and none for a take of nothing", async () => {
      expect(await refundAiQuota(PLAN_STORE, { source: "none" })).toBe("none");
      const rows = (
        await client.query(
          "select store_id, source, period from public.ai_quota_refunds where store_id = any($1::uuid[]) order by source",
          [[PLAN_STORE, CREDIT_STORE]],
        )
      ).rows;
      expect(rows).toEqual([
        { store_id: CREDIT_STORE, source: "credit", period: null },
        { store_id: PLAN_STORE, source: "plan", period },
        { store_id: PLAN_STORE, source: "plan", period },
      ]);
    });

    it("refuses a malformed refund without throwing", async () => {
      expect(
        await refundAiQuota(PLAN_STORE, {
          source: "plan",
          takeId: crypto.randomUUID(),
          period: null as unknown as string,
        }),
      ).toBe("failed");
      // Asked twice (the database refused both), then logged for an operator.
      expect(logError).toHaveBeenCalledWith(
        "ai.quota: refund failed",
        expect.anything(),
        { storeId: PLAN_STORE, source: "plan", attempts: 2 },
      );
    });

    it("keeps the refund function and its ledger away from app_user", async () => {
      const { rows } = await client.query(
        `select has_function_privilege('app_user', 'public.refund_ai_quota(uuid,uuid,text,text)', 'EXECUTE') as user_exec,
              has_table_privilege('app_user', 'public.ai_quota_refunds', 'SELECT') as user_select,
              has_function_privilege('app_service', 'public.refund_ai_quota(uuid,uuid,text,text)', 'EXECUTE') as service_exec`,
      );
      expect(rows[0]).toEqual({
        user_exec: false,
        user_select: false,
        service_exec: true,
      });
    });
  },
);
