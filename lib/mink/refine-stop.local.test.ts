/** The Refine stop handshake (lib/mink/refine-stop.ts) against local Postgres:
 * of a stop the browser sends and the refine's charge claim, exactly one wins
 * under real row locks; the begin and the stop meet on one row whichever
 * inserts first; the stage arbiter (abandonRefineStage) waits for a charge
 * still in flight, and a claim waits for an abandon; migration 0247's CHECKs
 * and grants refuse what they must.
 *
 * Run with MINK_REFINE_STOP_LOCAL_TEST=1 (as MINK_REFINE_STOP_LOCAL_TEST_USER,
 * else $USER, a superuser locally, so SET LOCAL ROLE app_service works). The
 * fixed loopback database keeps it away from Cloud SQL. 0247 must be applied
 * there (npm run db:migrate:local apply); this file runs no DDL.
 *
 * ★ TWO KINDS OF TRANSACTION, ON PURPOSE (the run-stop.local.test.ts rule).
 *   - The CHECKs, the grants and the cascade are probed inside transactions
 *     that are rolled back, on rows created inside them.
 *   - A race cannot be: two connections race only on a row both can see, and
 *     Postgres shows one connection's row to another only once it is
 *     committed. So one throwaway store is committed, raced on by the module's
 *     own functions through a real pool (every scope its own transaction, as
 *     app_service, like production) and by held transactions running the
 *     module's own statements, and deleted in afterAll: its cascade takes
 *     every request and ledger row this file wrote.
 */
import { Client, Pool } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";

const local = vi.hoisted(() => ({
  pool: null as import("pg").Pool | null,
}));

// ★ Each scope is its own transaction on a pooled connection, as app_service,
//   committed or rolled back, exactly as lib/db/client.ts runs it.
vi.mock("@/lib/db/client", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  return {
    async withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      const client = await local.pool!.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE app_service");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        const value = await fn(drizzle(client) as unknown as Db);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
});
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  abandonRefineStage,
  beginRefineRequest,
  claimRefineCharge,
  refineStopStatements,
  requestRefineStop,
  type RefineStopKey,
} from "./refine-stop";
import { withService } from "@/lib/db/client";

const enabled = process.env.MINK_REFINE_STOP_LOCAL_TEST === "1";
const USER =
  process.env.MINK_REFINE_STOP_LOCAL_TEST_USER || process.env.USER || "";
const SLUG_PREFIX = "refine-stop-probe-";
const CONNECTION = {
  host: "127.0.0.1",
  port: 5544,
  database: "storemink_local",
  user: USER,
  types: postgresStringTimestampTypes,
};

const dialect = new PgDialect();
const toQuery = (statement: SQL) => dialect.sqlToQuery(statement);

describe.skipIf(!enabled)("the Refine stop handshake on local Postgres", () => {
  let fixture: Client;
  let storeId: string;
  const adminId = `refine-stop-owner-${crypto.randomUUID().slice(0, 8)}`;

  const freshKey = (admin = adminId): RefineStopKey => ({
    storeId,
    adminId: admin,
    stopToken: crypto.randomUUID(),
  });
  /** True when the claim was made, false when a stop had won. */
  const claim = (key: RefineStopKey, refinementId: string) =>
    withService((db) => claimRefineCharge(db, key, refinementId));

  /** A held transaction on its own connection, as app_service. */
  async function holder(): Promise<Client> {
    const client = new Client(CONNECTION);
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_service");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    return client;
  }
  async function run(client: Client, statement: SQL) {
    const { sql, params } = toQuery(statement);
    return client.query(sql, params);
  }
  async function finish(client: Client, how: "COMMIT" | "ROLLBACK") {
    try {
      await client.query(how);
    } finally {
      await client.end();
    }
  }
  /** A minimal charged ledger row, as the charge transaction writes it. */
  async function ledgerRow(client: Client, refinementId: string) {
    const path = `stores/${storeId}/refined/${refinementId}.webp`;
    const url = `https://storage.googleapis.com/local-test/${path}`;
    await client.query(
      `insert into public.mink_image_refinements
         (id, store_id, admin_id, destination, width, height, source_url,
          period, charged_credits, plan_credits, balance_credits,
          credit_source, result_url, result_path)
       values ($1, $2, $3, 'product', 1200, 1600, 'https://example.test/a.jpg',
               '2026-10', 2, 2, 0, 'plan', $4, $5)`,
      [refinementId, storeId, adminId, url, path],
    );
    return { url, path };
  }
  /**
   * ★ Waits until `promise` is queued behind a row lock on the refine table,
   * then asserts it is still pending 300 ms later: the case the predicates
   * exist for. Asked on the fixture connection, never inside a held
   * transaction (pg_stat_activity is snapshotted once per transaction).
   */
  async function expectBlocked(promise: Promise<unknown>) {
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    let queued = false;
    for (let tries = 0; tries < 200 && !queued; tries += 1) {
      const { rows } = await fixture.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query ilike '%mink_refine_requests%'`,
      );
      queued = rows[0].waiting >= 1;
      if (!queued) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(queued, "the statement queued behind the held lock").toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled, "still waiting after 300 ms").toBe(false);
  }
  async function requestRow(key: RefineStopKey) {
    const { rows } = await fixture.query<{
      refinement_id: string | null;
      stopped: boolean;
      claimed: boolean;
    }>(
      `select refinement_id, stop_requested_at is not null as stopped,
              charge_claimed_at is not null as claimed
         from public.mink_refine_requests
        where store_id = $1 and admin_id = $2 and stop_token = $3`,
      [key.storeId, key.adminId, key.stopToken],
    );
    return rows[0];
  }

  beforeAll(async () => {
    fixture = new Client(CONNECTION);
    await fixture.connect();
    const { rows } = await fixture.query<{ present: boolean }>(
      "select to_regclass('public.mink_refine_requests') is not null as present",
    );
    if (!rows[0].present) {
      throw new Error("Apply 0247 first: npm run db:migrate:local apply");
    }
    local.pool = new Pool({ ...CONNECTION, max: 4 });
    // Leftovers of an earlier run that died before its afterAll.
    await fixture.query("begin");
    await fixture.query("set constraints all deferred");
    await fixture.query("delete from stores where slug like $1", [
      `${SLUG_PREFIX}%`,
    ]);
    await fixture.query("commit");
    storeId = crypto.randomUUID();
    await fixture.query(
      `insert into stores(id, slug, name, status, plan, settings)
       values ($1, $2, 'Refine stop test', 'active', 'pro', '{}'::jsonb)`,
      [storeId, `${SLUG_PREFIX}${storeId.slice(0, 8)}`],
    );
  }, 30_000);

  afterAll(async () => {
    // ★ Whatever happened above: the store's cascade takes every row.
    if (fixture && storeId) {
      try {
        await fixture.query("begin");
        await fixture.query("set constraints all deferred");
        await fixture.query("delete from stores where id = $1", [storeId]);
        await fixture.query("commit");
      } catch (error) {
        await fixture.query("rollback").catch(() => undefined);
        throw error;
      }
    }
    await fixture?.end();
    await local.pool?.end();
  }, 30_000);

  it("L1 ★ answers in order: begin then stop, stop then begin, repeats, another admin", async () => {
    // Begin, then stop: the begun refine can no longer be charged.
    const begun = freshKey();
    const refinement = crypto.randomUUID();
    await expect(beginRefineRequest(begun, refinement)).resolves.toBe("fresh");
    await expect(beginRefineRequest(begun, crypto.randomUUID())).resolves.toBe(
      "duplicate",
    );
    await expect(requestRefineStop(begun)).resolves.toEqual({
      outcome: "stopped",
    });
    await expect(requestRefineStop(begun)).resolves.toEqual({
      outcome: "stopped",
    });
    await expect(claim(begun, refinement)).resolves.toBe(false);
    expect(await requestRow(begun)).toEqual({
      refinement_id: refinement,
      stopped: true,
      claimed: false,
    });

    // A stop that overtook its refine: recorded (twice), and the refine then
    // refuses to start.
    const early = freshKey();
    await expect(requestRefineStop(early)).resolves.toEqual({
      outcome: "recorded",
    });
    await expect(requestRefineStop(early)).resolves.toEqual({
      outcome: "recorded",
    });
    await expect(beginRefineRequest(early, crypto.randomUUID())).resolves.toBe(
      "stopped",
    );

    // ★ Another admin sending the same token gets its own row: it can
    //   neither stop this refine nor read its photo.
    const charged = freshKey();
    const chargedRefinement = crypto.randomUUID();
    await expect(beginRefineRequest(charged, chargedRefinement)).resolves.toBe(
      "fresh",
    );
    const held = await holder();
    await run(held, refineStopStatements.claim(charged, chargedRefinement));
    const { url } = await ledgerRow(held, chargedRefinement);
    await finish(held, "COMMIT");
    await expect(requestRefineStop(charged)).resolves.toEqual({
      outcome: "too_late",
      url,
    });
    await expect(
      requestRefineStop({ ...charged, adminId: `${adminId}-other` }),
    ).resolves.toEqual({ outcome: "recorded" });
    expect(await requestRow(charged)).toMatchObject({
      stopped: false,
      claimed: true,
    });
  });

  it("L2 ★★ a stop waiting on a held claim that commits answers too_late, with the URL", async () => {
    const key = freshKey();
    const refinement = crypto.randomUUID();
    await expect(beginRefineRequest(key, refinement)).resolves.toBe("fresh");
    const held = await holder();
    try {
      const claimed = await run(
        held,
        refineStopStatements.claim(key, refinement),
      );
      expect(claimed.rowCount).toBe(1);
      const { url } = await ledgerRow(held, refinement);
      const stopping = requestRefineStop(key);
      await expectBlocked(stopping);
      await finish(held, "COMMIT");
      await expect(stopping).resolves.toEqual({ outcome: "too_late", url });
    } finally {
      await held.end().catch(() => undefined);
    }
    expect(await requestRow(key)).toMatchObject({
      stopped: false,
      claimed: true,
    });
  });

  it("L3 ★★ a stop waiting on a held claim that rolls back wins, and a later claim is refused", async () => {
    const key = freshKey();
    const refinement = crypto.randomUUID();
    await expect(beginRefineRequest(key, refinement)).resolves.toBe("fresh");
    const held = await holder();
    try {
      await run(held, refineStopStatements.claim(key, refinement));
      const stopping = requestRefineStop(key);
      await expectBlocked(stopping);
      // As `insufficient` does: the claim goes with the transaction.
      await finish(held, "ROLLBACK");
      await expect(stopping).resolves.toEqual({ outcome: "stopped" });
    } finally {
      await held.end().catch(() => undefined);
    }
    await expect(claim(key, refinement)).resolves.toBe(false);
    expect(await requestRow(key)).toMatchObject({
      stopped: true,
      claimed: false,
    });
  });

  it("L4 ★★ a claim waiting on a held stop is refused once the stop commits", async () => {
    const key = freshKey();
    const refinement = crypto.randomUUID();
    await expect(beginRefineRequest(key, refinement)).resolves.toBe("fresh");
    const held = await holder();
    try {
      const stopped = await run(held, refineStopStatements.stop(key));
      expect(stopped.rows[0]).toEqual({ refinement_id: refinement });
      const claiming = claim(key, refinement);
      await expectBlocked(claiming);
      await finish(held, "COMMIT");
      await expect(claiming).resolves.toBe(false);
    } finally {
      await held.end().catch(() => undefined);
    }
    expect(await requestRow(key)).toMatchObject({
      stopped: true,
      claimed: false,
    });
  });

  it("L5 ★★ the begin and the stop meet on one row, whichever inserts first", async () => {
    // The begin inserts first and commits: the stop takes the conflict arm.
    {
      const key = freshKey();
      const refinement = crypto.randomUUID();
      const held = await holder();
      try {
        await run(held, refineStopStatements.begin(key, refinement));
        const stopping = requestRefineStop(key);
        await expectBlocked(stopping);
        await finish(held, "COMMIT");
        await expect(stopping).resolves.toEqual({ outcome: "stopped" });
      } finally {
        await held.end().catch(() => undefined);
      }
    }
    // The stop inserts first and commits: the begin refuses to start.
    {
      const key = freshKey();
      const held = await holder();
      try {
        await run(held, refineStopStatements.stop(key));
        const beginning = beginRefineRequest(key, crypto.randomUUID());
        await expectBlocked(beginning);
        await finish(held, "COMMIT");
        await expect(beginning).resolves.toBe("stopped");
      } finally {
        await held.end().catch(() => undefined);
      }
    }
    // The first inserter rolls back: the second simply inserts.
    {
      const key = freshKey();
      const held = await holder();
      try {
        await run(held, refineStopStatements.begin(key, crypto.randomUUID()));
        const stopping = requestRefineStop(key);
        await expectBlocked(stopping);
        await finish(held, "ROLLBACK");
        await expect(stopping).resolves.toEqual({ outcome: "recorded" });
      } finally {
        await held.end().catch(() => undefined);
      }
    }
    {
      const key = freshKey();
      const held = await holder();
      try {
        await run(held, refineStopStatements.stop(key));
        const beginning = beginRefineRequest(key, crypto.randomUUID());
        await expectBlocked(beginning);
        await finish(held, "ROLLBACK");
        await expect(beginning).resolves.toBe("fresh");
      } finally {
        await held.end().catch(() => undefined);
      }
    }
  });

  it("L6 ★★ the abandon waits for a held claim: publish when it commits, discard when it rolls back", async () => {
    {
      const key = freshKey();
      const refinement = crypto.randomUUID();
      await expect(beginRefineRequest(key, refinement)).resolves.toBe("fresh");
      const held = await holder();
      try {
        await run(held, refineStopStatements.claim(key, refinement));
        const { path } = await ledgerRow(held, refinement);
        const deciding = abandonRefineStage(storeId, refinement);
        await expectBlocked(deciding);
        await finish(held, "COMMIT");
        await expect(deciding).resolves.toEqual({ publish: path });
      } finally {
        await held.end().catch(() => undefined);
      }
      expect(await requestRow(key)).toMatchObject({
        stopped: false,
        claimed: true,
      });
    }
    {
      const key = freshKey();
      const refinement = crypto.randomUUID();
      await expect(beginRefineRequest(key, refinement)).resolves.toBe("fresh");
      const held = await holder();
      try {
        await run(held, refineStopStatements.claim(key, refinement));
        await ledgerRow(held, refinement);
        const deciding = abandonRefineStage(storeId, refinement);
        await expectBlocked(deciding);
        await finish(held, "ROLLBACK");
        await expect(deciding).resolves.toBe("discard");
      } finally {
        await held.end().catch(() => undefined);
      }
      // ★ The abandon set the stop: no later claim can ever charge it.
      await expect(claim(key, refinement)).resolves.toBe(false);
      expect(await requestRow(key)).toMatchObject({
        stopped: true,
        claimed: false,
      });
    }
    // No request row and no ledger row in this database: discard.
    await expect(
      abandonRefineStage(storeId, crypto.randomUUID()),
    ).resolves.toBe("discard");
  });

  it("L10 ★★ a claim waiting on a held abandon is refused once it commits, and made once it rolls back", async () => {
    {
      const key = freshKey();
      const refinement = crypto.randomUUID();
      await expect(beginRefineRequest(key, refinement)).resolves.toBe("fresh");
      const held = await holder();
      try {
        const abandoned = await run(
          held,
          refineStopStatements.abandon(storeId, refinement),
        );
        expect(abandoned.rowCount).toBe(1);
        const claiming = claim(key, refinement);
        await expectBlocked(claiming);
        await finish(held, "COMMIT");
        await expect(claiming).resolves.toBe(false);
      } finally {
        await held.end().catch(() => undefined);
      }
      expect(await requestRow(key)).toMatchObject({
        stopped: true,
        claimed: false,
      });
    }
    {
      const key = freshKey();
      const refinement = crypto.randomUUID();
      await expect(beginRefineRequest(key, refinement)).resolves.toBe("fresh");
      const held = await holder();
      try {
        await run(held, refineStopStatements.abandon(storeId, refinement));
        const claiming = claim(key, refinement);
        await expectBlocked(claiming);
        await finish(held, "ROLLBACK");
        await expect(claiming).resolves.toBe(true);
      } finally {
        await held.end().catch(() => undefined);
      }
      expect(await requestRow(key)).toMatchObject({
        stopped: false,
        claimed: true,
      });
    }
  });

  it("L7 ★★ the CHECKs refuse a contradictory row (23514)", async () => {
    const client = await holder();
    try {
      async function refused(statement: string, params: unknown[]) {
        await client.query("savepoint probe");
        try {
          await client.query(statement, params);
          return null;
        } catch (error) {
          const e = error as { code?: string; constraint?: string };
          return `${e.code}:${e.constraint ?? ""}`;
        } finally {
          await client.query("rollback to savepoint probe");
        }
      }
      const insert = `insert into public.mink_refine_requests
        (store_id, admin_id, stop_token, refinement_id, stop_requested_at, charge_claimed_at)
        values ($1, $2, $3, $4, $5, $6)`;
      const now = new Date().toISOString();
      expect(
        await refused(insert, [
          storeId,
          adminId,
          crypto.randomUUID(),
          crypto.randomUUID(),
          now,
          now,
        ]),
      ).toBe("23514:mink_refine_requests_stop_or_charge_check");
      expect(
        await refused(insert, [
          storeId,
          adminId,
          crypto.randomUUID(),
          null,
          null,
          null,
        ]),
      ).toBe("23514:mink_refine_requests_started_or_stopped_check");
      // A stop-first row (no refine) can never be claimed.
      const key = freshKey();
      await run(client, refineStopStatements.stop(key));
      expect(
        await refused(
          `update public.mink_refine_requests set stop_requested_at = null, charge_claimed_at = now()
            where store_id = $1 and admin_id = $2 and stop_token = $3`,
          [key.storeId, key.adminId, key.stopToken],
        ),
      ).toBe("23514:mink_refine_requests_charge_has_refinement_check");
      // The rows the handshake does write are accepted.
      expect(
        await refused(insert, [
          storeId,
          adminId,
          crypto.randomUUID(),
          crypto.randomUUID(),
          null,
          now,
        ]),
      ).toBeNull();
    } finally {
      await finish(client, "ROLLBACK");
    }
  });

  it("L8 ★ app_user cannot read the table (42501)", async () => {
    const client = new Client(CONNECTION);
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");
      await expect(
        client.query("select count(*) from public.mink_refine_requests"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await finish(client, "ROLLBACK");
    }
  });

  it("L9 ★ deleting a store removes its refine requests (rolled back)", async () => {
    const client = new Client(CONNECTION);
    await client.connect();
    try {
      await client.query("BEGIN");
      const other = crypto.randomUUID();
      await client.query(
        `insert into stores(id, slug, name, status, plan, settings)
         values ($1, $2, 'Refine stop cascade', 'active', 'pro', '{}'::jsonb)`,
        [other, `${SLUG_PREFIX}${other.slice(0, 8)}`],
      );
      const key = { storeId: other, adminId, stopToken: crypto.randomUUID() };
      await run(client, refineStopStatements.begin(key, crypto.randomUUID()));
      await run(
        client,
        refineStopStatements.stop({ ...key, stopToken: crypto.randomUUID() }),
      );
      const count = async () =>
        Number(
          (
            await client.query(
              "select count(*) from public.mink_refine_requests where store_id = $1",
              [other],
            )
          ).rows[0].count,
        );
      expect(await count()).toBe(2);
      await client.query("set constraints all deferred");
      await client.query("delete from stores where id = $1", [other]);
      expect(await count()).toBe(0);
    } finally {
      await finish(client, "ROLLBACK");
    }
  });
});
