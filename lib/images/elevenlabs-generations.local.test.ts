/** The record of image jobs and submits (lib/images/elevenlabs-generations.ts)
 * against local Postgres: the real statements, as app_service, on the tables
 * of migrations 0284 and 0285.
 *
 * Run with IMAGE_PROVIDER_LOCAL_TEST=1 (as IMAGE_PROVIDER_LOCAL_TEST_USER,
 * else $USER, a superuser locally, so SET LOCAL ROLE app_service works). The
 * fixed loopback database keeps it away from Cloud SQL. 0284 and 0285 must be
 * applied there (npm run db:migrate:local apply); this file runs no DDL.
 *
 * ★ The store commits (each call is its own transaction, as in production),
 *   so every row here carries a scope that starts with "probe:" and a time in
 *   2031, where no real submit is out; afterAll deletes them. No call here
 *   reaches ElevenLabs.
 */
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";

const local = vi.hoisted(() => ({
  pool: null as import("pg").Pool | null,
}));

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
const logger = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => logger);

import {
  SUBMIT_CLOCK_SLACK_MS,
  SUBMIT_OUT_MS,
  postgresGenerationStore as store,
} from "./elevenlabs-generations";

const enabled = process.env.IMAGE_PROVIDER_LOCAL_TEST === "1";
const USER =
  process.env.IMAGE_PROVIDER_LOCAL_TEST_USER || process.env.USER || "";
const CONNECTION = {
  host: "127.0.0.1",
  port: 5544,
  database: "storemink_local",
  user: USER,
  types: postgresStringTimestampTypes,
};

describe.skipIf(!enabled)("the image job record on local Postgres", () => {
  let admin: Client;
  const run = crypto.randomUUID().slice(0, 8);
  let era = Date.parse("2031-01-01T00:00:00.000Z");
  /** Each test gets its own hour, so no test's submits are another's rivals. */
  const hour = () => (era += 3_600_000);
  const scope = (name: string) => `probe:${run}:${name}`;
  const digest = (letter: string) => letter.repeat(64);
  const submitRow = async (id: string) =>
    (
      await admin.query(
        "select state, generation_id, sent_at, lost_at from image_provider_submits where id = $1",
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    local.pool = new Pool({ ...CONNECTION, max: 4 });
    admin = new Client(CONNECTION);
    await admin.connect();
  });
  afterAll(async () => {
    await admin.query(
      "delete from image_provider_submits where scope like 'probe:%'",
    );
    await admin.query(
      "delete from image_provider_generations where scope like 'probe:%'",
    );
    await admin.end();
    await local.pool?.end();
  });

  it("★★ an answered submit records its job and closes itself in one statement set", async () => {
    const t = hour();
    const id = await store.openSubmit(scope("a"), digest("a"), new Date(t));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await submitRow(id!)).toMatchObject({ state: "sending" });
    await store.recordSubmitted(
      scope("a"),
      digest("a"),
      `job_${run}_a`,
      new Date(t + 900),
      id,
    );
    expect(await submitRow(id!)).toBeUndefined();
    const job = await admin.query(
      "select state, scope from image_provider_generations where generation_id = $1",
      [`job_${run}_a`],
    );
    expect(job.rows).toEqual([{ state: "submitted", scope: scope("a") }]);
    expect(logger.logWarn).not.toHaveBeenCalled();
  });

  it("a refused submit leaves nothing", async () => {
    const id = await store.openSubmit(
      scope("b"),
      digest("b"),
      new Date(hour()),
    );
    await store.dropSubmit(id!);
    expect(await submitRow(id!)).toBeUndefined();
  });

  it("★★ a submit with no answer is found again for its picture, with the window it was out for", async () => {
    const t = hour();
    const id = await store.openSubmit(scope("c"), digest("c"), new Date(t));
    await store.markSubmitLost(id!, new Date(t + 4_000));
    expect(
      await store.findLostSubmit(scope("c"), digest("c"), new Date(t + 60_000)),
    ).toEqual({ id, sentAt: t, lostAt: t + 4_000 });
    // Never for another picture, nor another scope.
    expect(
      await store.findLostSubmit(scope("c"), digest("d"), new Date(t + 60_000)),
    ).toBeNull();
    expect(
      await store.findLostSubmit(scope("x"), digest("c"), new Date(t + 60_000)),
    ).toBeNull();
  });

  it("★ a `sending` row a dead process left is a lost submit once it is old, out for one submit's clock", async () => {
    const t = hour();
    const id = await store.openSubmit(scope("d"), digest("d"), new Date(t));
    // Still in flight a moment later: not lost.
    expect(
      await store.findLostSubmit(scope("d"), digest("d"), new Date(t + 5_000)),
    ).toBeNull();
    expect(
      await store.findLostSubmit(
        scope("d"),
        digest("d"),
        new Date(t + 120_000),
      ),
    ).toEqual({ id, sentAt: t, lostAt: t + SUBMIT_OUT_MS });
  });

  it("★★ the window's view: the jobs the record holds, and the OTHER unanswered submits out at the same time", async () => {
    const t = hour();
    const mine = await store.openSubmit(scope("e"), digest("e"), new Date(t));
    await store.markSubmitLost(mine!, new Date(t + 4_000));
    const submit = { id: mine!, sentAt: t, lostAt: t + 4_000 };
    await store.recordSubmitted(
      scope("e2"),
      digest("f"),
      `job_${run}_held`,
      new Date(t + 1_000),
    );
    const ids = [`job_${run}_held`, `job_${run}_unheld`];
    // Alone: no rival, one id known.
    let view = await store.inspectWindow(submit, ids);
    expect(view?.rivals).toBe(0);
    expect([...view!.known]).toEqual([`job_${run}_held`]);

    // A rival still sending, one lost and one given up, all overlapping.
    const sending = await store.openSubmit(
      scope("e3"),
      digest("1"),
      new Date(t + 2_000),
    );
    const lost = await store.openSubmit(
      scope("e4"),
      digest("2"),
      new Date(t - 3_000),
    );
    await store.markSubmitLost(lost!, new Date(t - 1_000));
    const gaveUp = await store.openSubmit(
      scope("e5"),
      digest("3"),
      new Date(t + 4_000 + 2 * SUBMIT_CLOCK_SLACK_MS),
    );
    await store.giveUpSubmit(
      gaveUp!,
      new Date(t + 4_000 + 2 * SUBMIT_CLOCK_SLACK_MS + 500),
    );
    view = await store.inspectWindow(submit, ids);
    expect(view?.rivals).toBe(3);

    // Just outside the slack on either side: not rivals.
    const early = await store.openSubmit(
      scope("e6"),
      digest("4"),
      new Date(t - 60_000),
    );
    await store.markSubmitLost(
      early!,
      new Date(t - 2 * SUBMIT_CLOCK_SLACK_MS - 1),
    );
    await store.openSubmit(
      scope("e7"),
      digest("5"),
      new Date(t + 4_000 + 2 * SUBMIT_CLOCK_SLACK_MS + 1),
    );
    expect((await store.inspectWindow(submit, ids))?.rivals).toBe(3);

    // A rival whose job was found is no longer one: its job is in the record.
    expect(
      await store.adoptFound(
        { id: lost!, sentAt: t - 3_000, lostAt: t - 1_000 },
        scope("e4"),
        digest("2"),
        `job_${run}_rival`,
        new Date(t + 10_000),
      ),
    ).toBe(true);
    expect((await store.inspectWindow(submit, ids))?.rivals).toBe(2);
    expect(sending).toBeTruthy();
  });

  it("★★ a found job is taken once: the second try to take it is told no", async () => {
    const t = hour();
    const one = await store.openSubmit(scope("g"), digest("a"), new Date(t));
    await store.markSubmitLost(one!, new Date(t + 2_000));
    const submit = { id: one!, sentAt: t, lostAt: t + 2_000 };
    const jobId = `job_${run}_found`;
    expect(
      await store.adoptFound(
        submit,
        scope("g"),
        digest("a"),
        jobId,
        new Date(t + 5_000),
      ),
    ).toBe(true);
    expect(await submitRow(one!)).toMatchObject({
      state: "found",
      generation_id: jobId,
    });
    expect(
      await store.adoptFound(
        submit,
        scope("g2"),
        digest("b"),
        jobId,
        new Date(t + 6_000),
      ),
    ).toBe(false);
    // Found once, it is no longer a lost submit.
    expect(
      await store.findLostSubmit(scope("g"), digest("a"), new Date(t + 60_000)),
    ).toBeNull();
    // The job is held by the try that found it; released, it can be collected.
    expect(
      await store.claimUndelivered(
        scope("g"),
        digest("a"),
        new Date(t + 7_000),
      ),
    ).toBeNull();
    await store.release(jobId, new Date(t + 8_000));
    expect(
      await store.claimUndelivered(
        scope("g"),
        digest("a"),
        new Date(t + 9_000),
      ),
    ).toBe(jobId);
  });

  it("a submit given up is not looked for again", async () => {
    const t = hour();
    const id = await store.openSubmit(scope("h"), digest("a"), new Date(t));
    await store.markSubmitLost(id!, new Date(t + 2_000));
    await store.giveUpSubmit(id!, new Date(t + 20_000));
    expect(await submitRow(id!)).toMatchObject({ state: "given_up" });
    expect(
      await store.findLostSubmit(scope("h"), digest("a"), new Date(t + 60_000)),
    ).toBeNull();
  });

  it("★ the table refuses a found row with no job, a job on a row not found, and a lost row with no time", async () => {
    const probe = async (statement: string) => {
      await admin.query("BEGIN");
      try {
        await admin.query(statement);
        return "accepted";
      } catch (error) {
        return (error as { constraint?: string }).constraint ?? "refused";
      } finally {
        await admin.query("ROLLBACK");
      }
    };
    const insert = (columns: string, values: string) =>
      `insert into image_provider_submits (provider, scope, request_digest, sent_at, ${columns}) values ('elevenlabs', 'probe:check', '${digest("a")}', now(), ${values})`;
    expect(await probe(insert("state", "'sending'"))).toBe("accepted");
    expect(await probe(insert("state, lost_at", "'found', now()"))).toBe(
      "image_provider_submits_found_check",
    );
    expect(
      await probe(
        insert("state, lost_at, generation_id", "'lost', now(), 'x'"),
      ),
    ).toBe("image_provider_submits_found_check");
    expect(await probe(insert("state", "'lost'"))).toBe(
      "image_provider_submits_lost_check",
    );
    expect(await probe(insert("state, lost_at", "'other', now()"))).toBe(
      "image_provider_submits_state_check",
    );
  });

  it("merchants' role cannot read it", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE app_user");
      await expect(
        admin.query("select 1 from image_provider_submits limit 1"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await admin.query("ROLLBACK");
    }
  });
});
