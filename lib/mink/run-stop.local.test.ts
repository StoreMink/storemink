/** The stop handshake (lib/mink/run-stop.ts) against local Postgres: of a
 * stop the merchant asks for and the run's first side effect, exactly one
 * wins, under real row locks and real concurrency; migration 0244's CHECKs
 * refuse a contradictory row; and a stopped run stores no answer.
 *
 * Run with MINK_RUN_STOP_LOCAL_TEST=1. The fixed loopback database keeps it
 * away from Cloud SQL.
 *
 * ★ TWO KINDS OF TRANSACTION, ON PURPOSE.
 *   - The CHECKs are probed inside one transaction that is rolled back, on
 *     rows created inside it.
 *   - The race cannot be: two connections race only on a row both can see,
 *     and Postgres shows one connection's row to another only once it is
 *     committed (and a racer rolled back would let the other "win" over
 *     nothing). So one throwaway store, its chat and its runs are committed,
 *     raced on by the real functions through the real pool (every scope its
 *     own transaction, as app_service), and deleted in afterAll: the store's
 *     cascade takes every row this file wrote.
 * ★ The stopped-run sweep reads every store, so it runs only while the rows
 *   it would close are this file's own. */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // ★ Set before any module reads them: the real database client builds its
  //   pool from these on first use.
  if (process.env.MINK_RUN_STOP_LOCAL_TEST === "1") {
    process.env.DB_HOST = "127.0.0.1";
    process.env.DB_PORT = "5544";
    process.env.DB_NAME = "storemink_local";
    process.env.DB_USER = process.env.USER ?? "postgres";
    process.env.DB_POOL_MAX = "24";
    delete process.env.DB_PASSWORD;
  }
});

vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ enabled: true, chargeCredits: true }),
}));
vi.mock("./revamp/trigger", () => ({
  kickRevampRunner: vi.fn(async () => undefined),
}));

import { closePool } from "@/lib/db/client";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import { MinkRunStoppedError } from "./errors";
import { completeMinkRun } from "./persistence";
import {
  MINK_STOPPED_RUN_GRACE_MS,
  claimMinkRunAct,
  closeStoppedMinkRuns,
  requestMinkRunStop,
} from "./run-stop";
import type { MinkActorContext, MinkRunResult } from "./types";

/**
 * Stop-versus-claim pairs: half queued behind a held lock, half let loose.
 * MINK_RUN_STOP_LOCAL_PAIRS (an even number) runs fewer while debugging.
 */
const PAIRS = Number(process.env.MINK_RUN_STOP_LOCAL_PAIRS ?? 200);
const GATED = Math.floor(PAIRS / 2);
const LOOSE_WAVE = 10;

const enabled = process.env.MINK_RUN_STOP_LOCAL_TEST === "1";
describe.skipIf(!enabled)("the Mink stop handshake on local Postgres", () => {
  let client: Client;
  let storeId: string;
  let conversationId: string;
  const adminId = `run-stop-owner-${crypto.randomUUID().slice(0, 8)}`;

  /** Committed runs of the throwaway store, `running` and untouched. */
  async function freshRuns(count: number): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      `insert into mink_runs(id, store_id, conversation_id, requested_by, request_id, model)
       select gen_random_uuid(), $1, $2, $3, gen_random_uuid(), 'fixture'
         from generate_series(1, $4)
       returning id`,
      [storeId, conversationId, adminId, count],
    );
    return rows.map((row) => row.id);
  }

  async function runState(runId: string) {
    const { rows } = await client.query<{
      status: string;
      stopped: boolean;
      acted: boolean;
      error_code: string | null;
    }>(
      `select status, stop_requested_at is not null as stopped,
              acted_at is not null as acted, error_code
         from mink_runs where id = $1`,
      [runId],
    );
    return rows[0];
  }

  const stop = (runId: string) =>
    requestMinkRunStop({ runId, storeId, adminId });
  /** True when the claim was made, false when a stop had won. */
  const claim = (runId: string) =>
    claimMinkRunAct({ runId, storeId }).then(
      () => true,
      (error: unknown) => {
        if (error instanceof MinkRunStoppedError) return false;
        throw error;
      },
    );

  beforeAll(async () => {
    client = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: process.env.USER,
      types: postgresStringTimestampTypes,
    });
    await client.connect();
    storeId = crypto.randomUUID();
    conversationId = crypto.randomUUID();
    await client.query(
      `insert into stores(id, slug, name, status, plan, settings)
       values ($1, $2, 'Stop test', 'active', 'pro', '{}'::jsonb)`,
      [storeId, `run-stop-${storeId.slice(0, 8)}`],
    );
    await client.query(
      `insert into mink_conversations(id, store_id, admin_id, title)
       values ($1, $2, $3, 'Stop test')`,
      [conversationId, storeId, adminId],
    );
  }, 30_000);

  afterAll(async () => {
    // ★ Whatever happened above: the store's cascade takes every row.
    if (client && storeId) {
      try {
        await client.query("begin");
        await client.query("set constraints all deferred");
        await client.query("delete from stores where id = $1", [storeId]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    }
    await client?.end();
    await closePool();
  }, 30_000);

  it("★★ the CHECKs refuse a run both stopped and acted, and a stopped run that succeeded", async () => {
    await client.query("begin");
    try {
      const runId = crypto.randomUUID();
      await client.query(
        `insert into mink_runs(id, store_id, conversation_id, requested_by, request_id, model)
         values ($1, $2, $3, $4, gen_random_uuid(), 'fixture')`,
        [runId, storeId, conversationId, adminId],
      );
      async function refused(statement: string): Promise<string | null> {
        await client.query("savepoint probe");
        try {
          await client.query(statement, [runId]);
          return null;
        } catch (error) {
          return (error as { constraint?: string }).constraint ?? "other";
        } finally {
          await client.query("rollback to savepoint probe");
        }
      }
      expect(
        await refused(
          "update mink_runs set stop_requested_at = now(), acted_at = now() where id = $1",
        ),
      ).toBe("mink_runs_stop_or_act_check");
      expect(
        await refused(
          "update mink_runs set stop_requested_at = now(), status = 'succeeded', completed_at = now() where id = $1",
        ),
      ).toBe("mink_runs_stopped_never_succeeds_check");
      // The rows the handshake does write are accepted.
      expect(
        await refused(
          "update mink_runs set stop_requested_at = now() where id = $1",
        ),
      ).toBeNull();
      expect(
        await refused("update mink_runs set acted_at = now() where id = $1"),
      ).toBeNull();
      expect(
        await refused(
          "update mink_runs set stop_requested_at = now(), status = 'cancelled', error_code = 'stopped', completed_at = now() where id = $1",
        ),
      ).toBeNull();
      expect(
        await refused(
          "update mink_runs set acted_at = now(), status = 'succeeded', completed_at = now() where id = $1",
        ),
      ).toBeNull();
    } finally {
      await client.query("rollback");
    }
  });

  it("★ answers in order: a stop before any act, acted after one, idempotent", async () => {
    const [first, second] = await freshRuns(2);
    // A stop on a run that has not acted wins, and every claim then fails.
    await expect(stop(first)).resolves.toEqual({ outcome: "stopped" });
    await expect(stop(first)).resolves.toEqual({ outcome: "stopped" });
    await expect(claim(first)).resolves.toBe(false);
    expect(await runState(first)).toMatchObject({
      stopped: true,
      acted: false,
    });
    // A run that acted cannot be stopped; a repeated claim keeps its time.
    await expect(claim(second)).resolves.toBe(true);
    const actedAt = (
      await client.query("select acted_at from mink_runs where id = $1", [
        second,
      ])
    ).rows[0].acted_at;
    await expect(claim(second)).resolves.toBe(true);
    await expect(stop(second)).resolves.toEqual({ outcome: "acted" });
    expect(
      (
        await client.query("select acted_at from mink_runs where id = $1", [
          second,
        ])
      ).rows[0].acted_at,
    ).toBe(actedAt);
    expect(await runState(second)).toMatchObject({
      stopped: false,
      acted: true,
    });
    // ★ Another admin, another store, or no such run: one answer.
    await expect(
      requestMinkRunStop({ runId: second, storeId, adminId: "someone-else" }),
    ).resolves.toEqual({ outcome: "not_found" });
    await expect(
      requestMinkRunStop({
        runId: second,
        storeId: crypto.randomUUID(),
        adminId,
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    await expect(
      requestMinkRunStop({ runId: crypto.randomUUID(), storeId, adminId }),
    ).resolves.toEqual({ outcome: "not_found" });
  });

  it(`★★ exactly one of the stop and the claim wins, ${PAIRS} times`, async () => {
    const runs = await freshRuns(PAIRS);
    const outcomes: Array<{
      runId: string;
      stopped: boolean;
      claimed: boolean;
    }> = [];
    let queuedTogether = 0;

    // Half held behind one row lock, so the two queue for it and the second
    // decides only after the first commits: the case the predicates exist for.
    const gate = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: process.env.USER,
    });
    await gate.connect();
    try {
      for (const [index, runId] of runs.slice(0, GATED).entries()) {
        await gate.query("begin");
        await gate.query("select id from mink_runs where id = $1 for update", [
          runId,
        ]);
        // Alternate who asks first, so both orders are exercised.
        let stopping: ReturnType<typeof stop>;
        let claiming: Promise<boolean>;
        if (index % 2 === 0) {
          stopping = stop(runId);
          claiming = claim(runId);
        } else {
          claiming = claim(runId);
          stopping = stop(runId);
        }
        // Wait until both are queued behind the gate's lock. ★ Asked on the
        // fixture connection, never inside the gate's transaction: Postgres
        // snapshots pg_stat_activity once per transaction, so a poll there
        // would see the moment before the racers arrived for ever.
        for (let tries = 0; tries < 400; tries += 1) {
          const { rows } = await client.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and query ilike '%mink_runs%'`,
          );
          if (rows[0].waiting >= 2) {
            queuedTogether += 1;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // The gate changed nothing: rolling it back releases the queue.
        await gate.query("rollback");
        const [stopped, claimed] = await Promise.all([stopping, claiming]);
        outcomes.push({
          runId,
          stopped: stopped.outcome === "stopped",
          claimed,
        });
        expect(["stopped", "acted"]).toContain(stopped.outcome);
      }
    } finally {
      await gate.query("rollback").catch(() => undefined);
      await gate.end();
    }

    // The other half let loose together, a wave at a time.
    const loose = runs.slice(GATED);
    for (let start = 0; start < loose.length; start += LOOSE_WAVE) {
      const wave = loose.slice(start, start + LOOSE_WAVE);
      const results = await Promise.all(
        wave.map(async (runId, index) => {
          const [stopped, claimed] =
            index % 2 === 0
              ? await Promise.all([stop(runId), claim(runId)])
              : await Promise.all([claim(runId), stop(runId)]).then(
                  ([c, s]) => [s, c] as const,
                );
          return { runId, stopped: stopped.outcome === "stopped", claimed };
        }),
      );
      outcomes.push(...results);
    }

    expect(outcomes).toHaveLength(PAIRS);
    // ★★ Exactly one winner, every time, as each side saw it.
    for (const outcome of outcomes) {
      expect(outcome.stopped !== outcome.claimed, outcome.runId).toBe(true);
    }
    // ★★ And as the database holds it: never both, never neither.
    const { rows } = await client.query<{
      id: string;
      stopped: boolean;
      acted: boolean;
    }>(
      `select id, stop_requested_at is not null as stopped,
              acted_at is not null as acted
         from mink_runs where id = any($1::uuid[])`,
      [runs],
    );
    expect(rows).toHaveLength(PAIRS);
    const held = new Map(rows.map((row) => [row.id, row]));
    for (const outcome of outcomes) {
      const row = held.get(outcome.runId)!;
      expect(row.stopped, outcome.runId).toBe(outcome.stopped);
      expect(row.acted, outcome.runId).toBe(outcome.claimed);
    }
    // The gated half really queued, and both orders really happened.
    expect(queuedTogether).toBe(GATED);
    const gated = outcomes.slice(0, GATED);
    expect(gated.some((outcome) => outcome.stopped)).toBe(true);
    expect(gated.some((outcome) => outcome.claimed)).toBe(true);
  }, 120_000);

  it("★★ a stopped run stores no answer; the same run unstopped would", async () => {
    const [stopped, untouched] = await freshRuns(2);
    const actor = { storeId, adminId } as MinkActorContext;
    const result: MinkRunResult = {
      text: "Your sales are up.",
      model: "fixture",
      steps: 1,
      toolCalls: 0,
      retryCount: 0,
      usage: {
        promptTokens: 1,
        outputTokens: 1,
        thoughtTokens: 0,
        totalTokens: 2,
        cachedTokens: 0,
        basePromptTokens: 1,
      },
      artifacts: [],
    };
    const complete = (runId: string) =>
      completeMinkRun({
        actor,
        started: { conversationId, runId, history: [] },
        result,
        latencyMs: 10,
        pricingLocation: "global",
      });
    const answers = async (runId: string) =>
      Number(
        (
          await client.query(
            "select count(*) from mink_messages where run_id = $1 and role = 'assistant'",
            [runId],
          )
        ).rows[0].count,
      );

    await expect(stop(stopped)).resolves.toEqual({ outcome: "stopped" });
    await expect(complete(stopped)).rejects.toBeInstanceOf(MinkRunStoppedError);
    expect(await answers(stopped)).toBe(0);
    expect(await runState(stopped)).toMatchObject({
      status: "running",
      stopped: true,
    });

    await expect(complete(untouched)).resolves.toBeDefined();
    expect(await answers(untouched)).toBe(1);
    expect((await runState(untouched)).status).toBe("succeeded");
    // Too late to stop: it says so.
    await expect(stop(untouched)).resolves.toEqual({
      outcome: "finished",
      status: "succeeded",
    });
  });

  it("★ closes a stopped run whose instance went away, as stopped", async () => {
    const [runId] = await freshRuns(1);
    await expect(stop(runId)).resolves.toEqual({ outcome: "stopped" });
    // Its stop is older than the grace now.
    await client.query(
      "update mink_runs set stop_requested_at = now() - make_interval(secs => $2) where id = $1",
      [runId, MINK_STOPPED_RUN_GRACE_MS / 1_000 + 60],
    );
    // ★ The sweep reads every store: run it only while it can find nothing
    //   but this file's own rows.
    const foreign = Number(
      (
        await client.query(
          `select count(*) from mink_runs
            where status = 'running' and stop_requested_at is not null
              and stop_requested_at < now() - make_interval(secs => $2)
              and store_id <> $1`,
          [storeId, MINK_STOPPED_RUN_GRACE_MS / 1_000],
        )
      ).rows[0].count,
    );
    if (foreign > 0) {
      console.warn(
        `run-stop.local.test: ${foreign} stopped runs of other stores; sweep not run`,
      );
      return;
    }
    const swept = await closeStoppedMinkRuns({ limit: 20 });
    expect(swept.closed).toBeGreaterThanOrEqual(1);
    expect(await runState(runId)).toMatchObject({
      status: "cancelled",
      error_code: "stopped",
      stopped: true,
      acted: false,
    });
  });
});
