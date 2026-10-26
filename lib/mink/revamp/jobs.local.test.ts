/** Rollback-only checks of the storefront revamp job repository against local
 * Postgres: the free decision, one active revamp per store, the claim and its
 * lease, fenced writes, cancelling and superseding, the stall kick and the
 * sweep. Run with MINK_REVAMP_LOCAL_TEST=1; the fixed loopback database keeps
 * it away from Cloud SQL, and everything happens inside one transaction that
 * is rolled back.
 *
 * ★ Inside one transaction `now()` is frozen at its start, so a lease never
 *   expires and nothing ever ages by waiting: the tests move timestamps by
 *   hand (a lease into the past, a job's creation a minute back).
 * ★ True cross-connection concurrency cannot be shown here (a second
 *   connection cannot see this transaction's rows); two concurrent creates go
 *   through the same serialised `withService` a single instance uses, and the
 *   unique index is probed directly for the cross-instance case. */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";
import type { MinkActorContext } from "../types";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  pending: Promise.resolve(),
  kick: vi.fn<(revampId: string) => Promise<undefined>>(async () => undefined),
  release: vi.fn<(storeId: string, count: number) => Promise<void>>(
    async () => undefined,
  ),
}));
vi.mock("@/lib/db/client", () => ({
  async withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const previous = service.pending;
    let release!: () => void;
    service.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `revamp_${++service.count}`;
    await service.client!.query(`SAVEPOINT ${name}`);
    try {
      const value = await fn(service.db!);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await service.client!.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally {
      release();
    }
  },
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ enabled: true }),
}));
vi.mock("./trigger", () => ({ kickRevampRunner: service.kick }));
vi.mock("./image-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./image-store")>()),
  releaseRevampPhotos: service.release,
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { minkRevamps } from "@/drizzle/schema";
import { isUniqueViolation, pgConstraint } from "@/lib/db/errors";
import {
  REVAMP_ERROR_MESSAGES,
  REVAMP_LIMITS,
  type RevampKind,
  type RevampRequest,
} from "./contract";
import {
  REVAMP_RUN_CEILING_MS,
  cancelRevamp,
  claimRevampJob,
  countRefinements,
  createRevampJob,
  failRevampJob,
  findReadyRevampByDraft,
  finishRevampReady,
  holdRevampPhotos,
  kickRevampIfStalled,
  kickWaitingRevamp,
  listConversationRevamps,
  markRevampCancelled,
  readEarlierRevampPlans,
  readRevampStatus,
  recordRevampPhotoReviews,
  releaseRevampLease,
  renewRevampLease,
  reportRevampProgress,
  revampStartLimit,
  saveRevampStep,
  settleFinishedPhotoHolds,
  sweepStalledRevamps,
} from "./jobs";
import { ZERO_REVAMP_USAGE, type RevampPhotoReviews } from "./ports";
import { claimSpendLimits } from "../spend-limits";

const ADMIN = "revamp-owner";
const PARKED = "00000000-0000-4000-8000-000000000000";

interface Fixture {
  actor: MinkActorContext;
  conversationId: string;
}

function request(kind: RevampKind): RevampRequest {
  return {
    kind,
    brief: {
      business: "Hand-poured soy candles",
      look: "Warm and calm",
      audience: "Gift buyers",
      facts: ["Poured in Pune"],
      avoid: "",
      language: "English",
    },
    products: [],
    categories: [],
    pages: null,
    instruction: kind === "refine" ? "Warmer colours" : null,
    refineScope: null,
  };
}

const enabled = process.env.MINK_REVAMP_LOCAL_TEST === "1";
describe.skipIf(!enabled)("revamp jobs, on local Postgres", () => {
  let client: Client;
  let store: Fixture;

  beforeAll(async () => {
    client = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: process.env.USER,
      types: postgresStringTimestampTypes,
    });
    await client.connect();
    await client.query("BEGIN");
    service.client = client;
    service.db = drizzle(client, { schema: { ...schema, ...relations } });
    // ★ The migration this module needs, applied inside the rolled-back
    //   transaction when the local database has not run it yet.
    const manifest = JSON.parse(
      readFileSync("drizzle/migrations/manifest.json", "utf8"),
    );
    const applied = new Set(
      (await client.query("select id from public.schema_migrations")).rows.map(
        (row) => row.id,
      ),
    );
    const migration = manifest.migrations.find(
      (entry: { id: string }) =>
        entry.id === "20261021_0234_mink_storefront_revamp",
    );
    if (!applied.has(migration.id)) {
      await client.query(
        readFileSync(`drizzle/migrations/${migration.file}`, "utf8"),
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  beforeEach(async () => {
    await client.query("SAVEPOINT revamp_fixture");
    store = await makeStore("Lumen");
  });

  afterEach(async () => {
    await client.query("ROLLBACK TO SAVEPOINT revamp_fixture");
    await client.query("RELEASE SAVEPOINT revamp_fixture");
  });

  async function makeStore(name: string): Promise<Fixture> {
    const storeId = crypto.randomUUID();
    await client.query(
      "insert into stores(id,slug,name,status,plan,settings) values($1,$2,$3,'active','pro',$4)",
      [storeId, `revamp-${storeId}`, name, { brand: { name } }],
    );
    const conversationId = crypto.randomUUID();
    await client.query(
      "insert into mink_conversations(id,store_id,admin_id,title) values($1,$2,$3,'Customise my store')",
      [conversationId, storeId, ADMIN],
    );
    const runId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    await client.query(
      "insert into mink_runs(id,store_id,conversation_id,requested_by,request_id,model) values($1,$2,$3,$4,$5,'fixture')",
      [runId, storeId, conversationId, ADMIN, requestId],
    );
    return {
      conversationId,
      actor: {
        storeId,
        adminId: ADMIN,
        email: "Owner@Example.com",
        roleSlug: "superadmin",
        permissions: {},
        isSuperadmin: true,
        effectivePlan: "pro",
        locationIds: null,
        analyticsTimeZone: "Asia/Kolkata",
        currency: "INR",
        defaultLowStockThreshold: 5,
        requestId,
        runId,
        draftingEnabled: true,
      },
    };
  }

  async function makeDraft(fixture: Fixture = store): Promise<string> {
    return (
      await client.query(
        `insert into mink_drafts(store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits)
         values($1,$2,$3,'storefront_personalization','storefront','Whole storefront','/dashboard/builder','Store redesign',$4,1)
         returning id`,
        [
          fixture.actor.storeId,
          ADMIN,
          fixture.actor.runId,
          { plan_json: "{}", plan_digest: "digest", explanation: "Redesign" },
        ],
      )
    ).rows[0].id;
  }

  async function create(
    kind: RevampKind,
    options: {
      fixture?: Fixture;
      parentId?: string | null;
      conversationId?: string | null;
      budgetCredits?: number | null;
    } = {},
  ) {
    const fixture = options.fixture ?? store;
    return createRevampJob({
      actor: fixture.actor,
      conversationId:
        options.conversationId === undefined
          ? fixture.conversationId
          : options.conversationId,
      kind,
      request: request(kind),
      parentId: options.parentId ?? null,
      budgetCredits: options.budgetCredits ?? null,
    });
  }

  async function createOk(
    kind: RevampKind,
    options: Parameters<typeof create>[1] = {},
  ) {
    const result = await create(kind, options);
    if (!result.ok)
      throw new Error(`expected a new revamp, got ${result.reason}`);
    return result.job;
  }

  async function finish(
    revampId: string,
    options: { fixture?: Fixture; credits?: number } = {},
  ): Promise<string> {
    const claimed = await claimRevampJob(revampId);
    if (!claimed) throw new Error("expected a claim");
    const draftId = await makeDraft(options.fixture);
    const ok = await finishRevampReady({
      revampId,
      leaseToken: claimed.leaseToken,
      draftId,
      credits: options.credits ?? 0,
      result: { checked: true },
      usage: { ...ZERO_REVAMP_USAGE, inputTokens: 100 },
    });
    expect(ok).toBe(true);
    return draftId;
  }

  async function row(revampId: string) {
    return (
      await client.query("select * from mink_revamps where id = $1", [revampId])
    ).rows[0];
  }

  /** The result column without the claim's own clock and count (B8). */
  function stepsResult(result: Record<string, unknown> | null) {
    if (!result) return result;
    const { firstClaimedAt, interruptions, ...rest } = result;
    void firstClaimedAt;
    void interruptions;
    return rest;
  }

  /** The store's day of starts as the rate limiter holds it (B5). */
  async function startsCounted(storeId: string): Promise<number | null> {
    const found = await client.query(
      "select count from rate_limits where key = $1",
      [revampStartLimit(storeId).key],
    );
    return found.rows[0]?.count ?? null;
  }

  /** Moves a job's first claim back by `ms` (B8). */
  async function claimedAgo(revampId: string, ms: number) {
    await client.query(
      "update mink_revamps set result = jsonb_set(result, '{firstClaimedAt}', to_jsonb(floor(extract(epoch from now()) * 1000) - $2::bigint)) where id = $1",
      [revampId, ms],
    );
  }

  async function expireLease(revampId: string) {
    await client.query(
      "update mink_revamps set lease_until = now() - interval '1 second' where id = $1",
      [revampId],
    );
  }

  async function probe<T>(fn: () => Promise<T>): Promise<unknown> {
    await client.query("SAVEPOINT revamp_probe");
    try {
      await fn();
      return null;
    } catch (error) {
      return error;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT revamp_probe");
      await client.query("RELEASE SAVEPOINT revamp_probe");
    }
  }

  // -------------------------------------------------------------------------

  describe("the free decision", () => {
    it("★ makes the first full revamp free with no budget, and the next one paid", async () => {
      const first = await createOk("full", { budgetCredits: 80 });
      expect(first).toMatchObject({
        free: true,
        budgetCredits: null,
        status: "queued",
        step: "snapshot",
        attempts: 0,
        maxAttempts: REVAMP_LIMITS.maxAttempts,
        requesterEmail: "owner@example.com",
        originRunId: store.actor.runId,
        conversationId: store.conversationId,
      });
      await finish(first.id);

      const second = await createOk("full", { budgetCredits: 80.9 });
      expect(second.free).toBe(false);
      expect(second.budgetCredits).toBe(80);
      expect((await row(second.id)).free).toBe(false);
    });

    it("★ a failed or cancelled free revamp does not use the free one up", async () => {
      const cancelled = await createOk("full");
      expect(cancelled.free).toBe(true);
      await cancelRevamp(store.actor, cancelled.id);

      const failed = await createOk("full");
      expect(failed.free).toBe(true);
      const claimed = await claimRevampJob(failed.id);
      await failRevampJob({
        revampId: failed.id,
        leaseToken: claimed!.leaseToken,
        code: "model_unavailable",
        detail: "fixture",
      });
      expect((await row(failed.id)).status).toBe("failed");

      const third = await createOk("full");
      expect(third.free).toBe(true);
    });

    it("★ a superseded free revamp still holds the free one", async () => {
      const first = await createOk("full");
      await finish(first.id);
      const refine = await createOk("refine", { parentId: first.id });
      await finish(refine.id);
      expect((await row(first.id)).status).toBe("superseded");
      expect((await createOk("full")).free).toBe(false);
    });

    it("★ never makes a refinement free, even while the free one is unused", async () => {
      const cancelled = await createOk("full");
      await cancelRevamp(store.actor, cancelled.id);
      const refine = await createOk("refine", {
        parentId: cancelled.id,
        budgetCredits: 30,
      });
      expect(refine).toMatchObject({
        kind: "refine",
        free: false,
        budgetCredits: 30,
        parentId: cancelled.id,
      });
      await cancelRevamp(store.actor, refine.id);
      // The free one is still there for the next full revamp.
      expect((await createOk("full")).free).toBe(true);
      // And the database refuses a free refinement outright.
      const error = await probe(() =>
        client.query(
          "insert into mink_revamps(id,store_id,admin_id,kind,status,request,free,parent_id) values($1,$2,$3,'refine','cancelled','{}',true,$4)",
          [crypto.randomUUID(), store.actor.storeId, ADMIN, cancelled.id],
        ),
      );
      expect(error).toMatchObject({
        code: "23514",
        constraint: "mink_revamps_free_check",
      });
    });

    it("refuses a parent from another store and a conversation that is not the requester's", async () => {
      const other = await makeStore("Elsewhere");
      const foreign = await createOk("full", { fixture: other });
      await expect(
        create("refine", { parentId: foreign.id }),
      ).rejects.toMatchObject({ code: "mink_revamp_parent_unavailable" });
      await expect(
        create("full", { conversationId: other.conversationId }),
      ).rejects.toMatchObject({ code: "mink_revamp_conversation_unavailable" });
      expect(
        (
          await client.query(
            "select count(*)::int as n from mink_revamps where store_id = $1",
            [store.actor.storeId],
          )
        ).rows[0].n,
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe("one active revamp per store", () => {
    it("★ two concurrent creates make one revamp; the other is told which", async () => {
      const [a, b] = await Promise.all([create("full"), create("full")]);
      const made = [a, b].filter((result) => result.ok);
      const refused = [a, b].filter((result) => !result.ok);
      expect(made).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const job = made[0].ok ? made[0].job : null;
      expect(refused[0]).toEqual({
        ok: false,
        reason: "active_exists",
        activeId: job!.id,
      });
      expect(
        (
          await client.query(
            "select count(*)::int as n from mink_revamps where store_id = $1",
            [store.actor.storeId],
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it("★ the partial unique index is the backstop, and its error is recognised", async () => {
      const job = await createOk("full");
      const raw = await probe(() =>
        client.query(
          "insert into mink_revamps(id,store_id,admin_id,kind,status,request) values($1,$2,$3,'full','queued','{}')",
          [crypto.randomUUID(), store.actor.storeId, ADMIN],
        ),
      );
      expect(raw).toMatchObject({
        code: "23505",
        constraint: "mink_revamps_one_active_idx",
      });
      // The same violation as Drizzle raises it: the helpers createRevampJob
      // maps it with must see through Drizzle's wrapper.
      const wrapped = await probe(() =>
        service.db!.insert(minkRevamps).values({
          id: crypto.randomUUID(),
          storeId: store.actor.storeId,
          adminId: ADMIN,
          kind: "full",
          status: "running",
          request: {},
          leaseToken: crypto.randomUUID(),
          leaseUntil: "2099-01-01T00:00:00Z",
        }),
      );
      expect(isUniqueViolation(wrapped)).toBe(true);
      expect(pgConstraint(wrapped)).toBe("mink_revamps_one_active_idx");
      // A finished job frees the store for the next one.
      await cancelRevamp(store.actor, job.id);
      expect((await create("full")).ok).toBe(true);
    });

    it("other stores are unaffected", async () => {
      await createOk("full");
      const other = await makeStore("Elsewhere");
      expect((await create("full", { fixture: other })).ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------

  describe("the claim and its lease", () => {
    it("★ claims once, refuses while the lease is live, and reclaims after it expires", async () => {
      const job = await createOk("full");
      const first = await claimRevampJob(job.id);
      expect(first).not.toBeNull();
      // ★ A claim counts nothing (B8); it starts the ceiling's clock.
      expect(first!.job).toMatchObject({ status: "running", attempts: 0 });
      const stored = await row(job.id);
      expect(stored.lease_token).toBe(first!.leaseToken);
      expect(typeof stored.result.firstClaimedAt).toBe("number");
      expect(stored.result.interruptions).toBe(0);
      expect(
        (
          await client.query(
            "select lease_until > now() as live from mink_revamps where id = $1",
            [job.id],
          )
        ).rows[0].live,
      ).toBe(true);

      expect(await claimRevampJob(job.id)).toBeNull();
      expect(await renewRevampLease(job.id, first!.leaseToken)).toEqual({
        ok: true,
        cancelRequested: false,
      });

      await expireLease(job.id);
      const second = await claimRevampJob(job.id);
      expect(second).not.toBeNull();
      expect(second!.leaseToken).not.toBe(first!.leaseToken);
      // ★★ A lease that ran out with nothing recorded is an interruption,
      //   never a failure, and the clock does not move.
      expect(second!.job.attempts).toBe(0);
      expect(second!.job.result).toMatchObject({
        firstClaimedAt: stored.result.firstClaimedAt,
        interruptions: 1,
      });
      // ★ The lost runner can no longer renew: a claim minted a new token.
      expect(await renewRevampLease(job.id, first!.leaseToken)).toEqual({
        ok: false,
        cancelRequested: false,
      });
      expect((await renewRevampLease(job.id, second!.leaseToken)).ok).toBe(
        true,
      );
    });

    it("★ parks a lease behind a retry wait, then frees it", async () => {
      const job = await createOk("full");
      const first = await claimRevampJob(job.id);
      await releaseRevampLease(job.id, first!.leaseToken, {
        retryAfterMs: 60_000,
      });
      const parked = await row(job.id);
      expect(parked.lease_token).toBe(PARKED);
      expect(parked.status).toBe("running");
      expect(await claimRevampJob(job.id)).toBeNull();
      // Nobody holds a parked lease: nothing renews or saves under it.
      expect((await renewRevampLease(job.id, PARKED)).ok).toBe(false);

      await expireLease(job.id);
      const second = await claimRevampJob(job.id);
      // ★ The parked release followed a failure and counted it; the parked
      //   token is nobody's, so the claim found no interruption.
      expect(second!.job.attempts).toBe(1);
      expect(second!.job.result?.interruptions).toBeUndefined();
      await releaseRevampLease(job.id, second!.leaseToken);
      const freed = await row(job.id);
      expect(freed.lease_token).toBeNull();
      expect(freed.lease_until).toBeNull();
      // A hand-over counts nothing.
      expect((await claimRevampJob(job.id))!.job.attempts).toBe(1);
    });

    it("★★ four real failures of a step in a row still fail the job, and the card says so (B8)", async () => {
      const job = await createOk("full");
      for (
        let attempt = 1;
        attempt <= REVAMP_LIMITS.maxAttempts;
        attempt += 1
      ) {
        const claimed = await claimRevampJob(job.id);
        expect(claimed!.job.attempts).toBe(attempt - 1);
        // The same real error each time: parked, and counted.
        await releaseRevampLease(job.id, claimed!.leaseToken, {
          retryAfterMs: 60_000,
        });
        await expireLease(job.id);
      }
      expect((await row(job.id)).attempts).toBe(REVAMP_LIMITS.maxAttempts);
      expect(await claimRevampJob(job.id)).toBeNull();
      const view = await readRevampStatus(store.actor, job.id);
      expect(view).toMatchObject({
        status: "failed",
        error: REVAMP_ERROR_MESSAGES.out_of_attempts,
      });
      expect(await row(job.id)).toMatchObject({
        error_code: "out_of_attempts",
        error_detail: "attempts_exhausted",
      });
    });

    it("★★ a hand-over that stored photos gives the step its claims back, and only a live runner's does (jobs-5)", async () => {
      const job = await createOk("full");
      // More deadline hand-overs than the budget, each storing photos: the
      // live run's photos step, which reached its last claim after three.
      for (let turn = 1; turn <= REVAMP_LIMITS.maxAttempts + 2; turn += 1) {
        const claimed = await claimRevampJob(job.id);
        expect(claimed!.job.attempts).toBe(0);
        await releaseRevampLease(job.id, claimed!.leaseToken, {
          progressed: true,
        });
      }
      expect((await row(job.id)).attempts).toBe(0);

      // One real failure on the books.
      const failing = await claimRevampJob(job.id);
      await releaseRevampLease(job.id, failing!.leaseToken, {
        retryAfterMs: 60_000,
      });
      await expireLease(job.id);
      expect((await row(job.id)).attempts).toBe(1);

      // ★ Fenced: a runner whose lease was taken over resets nothing.
      const lost = await claimRevampJob(job.id);
      await expireLease(job.id);
      const next = await claimRevampJob(job.id);
      expect(next!.job.attempts).toBe(1);
      await releaseRevampLease(job.id, lost!.leaseToken, { progressed: true });
      expect((await row(job.id)).attempts).toBe(1);
      // ★ A parked release follows a failure: it counts it and never gives
      //   one back, progress or not.
      await releaseRevampLease(job.id, next!.leaseToken, {
        retryAfterMs: 60_000,
        progressed: true,
      });
      expect((await row(job.id)).attempts).toBe(2);

      // Real failures that store nothing still run the budget out.
      await expireLease(job.id);
      for (
        let attempt = 3;
        attempt <= REVAMP_LIMITS.maxAttempts;
        attempt += 1
      ) {
        const claimed = await claimRevampJob(job.id);
        expect(claimed!.job.attempts).toBe(attempt - 1);
        await releaseRevampLease(job.id, claimed!.leaseToken, {
          retryAfterMs: 60_000,
        });
        await expireLease(job.id);
      }
      expect(await claimRevampJob(job.id)).toBeNull();
    });

    it("never claims a job with a stop request", async () => {
      const job = await createOk("full");
      const claimed = await claimRevampJob(job.id);
      await cancelRevamp(store.actor, job.id);
      await releaseRevampLease(job.id, claimed!.leaseToken);
      expect(await claimRevampJob(job.id)).toBeNull();
    });

    it("★ L2-F: a release, a failure and a stop keep the usage the runner had not saved yet", async () => {
      const spent = (inputTokens: number) => ({
        ...ZERO_REVAMP_USAGE,
        inputTokens,
        estimatedCostMicroUsd: inputTokens * 2,
      });
      const job = await createOk("full");
      const first = await claimRevampJob(job.id);
      await releaseRevampLease(job.id, first!.leaseToken, {
        retryAfterMs: 60_000,
        usage: spent(10),
      });
      expect((await row(job.id)).usage).toMatchObject({
        inputTokens: 10,
        estimatedCostMicroUsd: 20,
      });

      await expireLease(job.id);
      const second = await claimRevampJob(job.id);
      await releaseRevampLease(job.id, second!.leaseToken, {
        progressed: true,
        usage: spent(20),
      });
      expect((await row(job.id)).usage).toMatchObject({ inputTokens: 20 });

      // ★ Fenced: a runner that lost its lease writes no usage either.
      const third = await claimRevampJob(job.id);
      await releaseRevampLease(job.id, first!.leaseToken, {
        usage: spent(999),
      });
      expect((await row(job.id)).usage).toMatchObject({ inputTokens: 20 });

      await failRevampJob({
        revampId: job.id,
        leaseToken: third!.leaseToken,
        code: "model_unavailable",
        detail: "fixture",
        usage: spent(30),
      });
      const failed = await row(job.id);
      expect(failed.status).toBe("failed");
      expect(failed.usage).toMatchObject({ inputTokens: 30 });

      const stopping = await createOk("full");
      const claimed = await claimRevampJob(stopping.id);
      await cancelRevamp(store.actor, stopping.id);
      await markRevampCancelled(stopping.id, claimed!.leaseToken, spent(40));
      const stopped = await row(stopping.id);
      expect(stopped.status).toBe("cancelled");
      expect(stopped.usage).toMatchObject({ inputTokens: 40 });
    });
  });

  // -------------------------------------------------------------------------

  describe("★★ a claim is not an attempt (B8)", () => {
    it("★★ eight hand-overs that only waited on Google never fail the job", async () => {
      const job = await createOk("full");
      for (let turn = 1; turn <= 8; turn += 1) {
        const claimed = await claimRevampJob(job.id);
        expect(claimed).not.toBeNull();
        expect(claimed!.job.attempts).toBe(0);
        // The runner's answer to a 429, a held check or a paced start.
        await releaseRevampLease(job.id, claimed!.leaseToken, {
          retryAfterMs: 60_000,
          counted: false,
        });
        expect((await row(job.id)).lease_token).toBe(PARKED);
        await expireLease(job.id);
      }
      expect(await row(job.id)).toMatchObject({
        status: "running",
        attempts: 0,
      });
      expect((await readRevampStatus(store.actor, job.id))?.status).toBe(
        "running",
      );
      // ★ And it can still be claimed and carried on.
      expect(await claimRevampJob(job.id)).not.toBeNull();
    });

    it("★★ six claims that ended by their lease with no error never fail it; the sweep resumes it at its saved step", async () => {
      const job = await createOk("full");
      const first = await claimRevampJob(job.id);
      expect(
        await saveRevampStep({
          revampId: job.id,
          leaseToken: first!.leaseToken,
          step: "compile",
          progress: [],
          patch: {
            plan: { stage: "raw", raw: { pages: [] }, repairs: 0, issues: [] },
          },
        }),
      ).toBe(true);
      const clock = (await row(job.id)).result.firstClaimedAt;
      // Six invocations die without a word: no release, no failure.
      await expireLease(job.id);
      for (let turn = 1; turn <= 6; turn += 1) {
        const claimed = await claimRevampJob(job.id);
        expect(claimed!.job).toMatchObject({ step: "compile", attempts: 0 });
        await expireLease(job.id);
      }
      expect(await row(job.id)).toMatchObject({
        status: "running",
        step: "compile",
        attempts: 0,
        result: { firstClaimedAt: clock, interruptions: 6 },
      });
      expect((await readRevampStatus(store.actor, job.id))?.status).toBe(
        "running",
      );

      // ★★ The per-minute sweep kicks it on, never fails it.
      await client.query(
        "update mink_revamps set created_at = now() - interval '1 hour' where id = $1",
        [job.id],
      );
      await sweepStalledRevamps(25);
      expect(service.kick).toHaveBeenCalledWith(job.id);
      expect((await row(job.id)).status).toBe("running");
      // ... and the next runner resumes from the step it persisted.
      const resumed = await claimRevampJob(job.id);
      expect(resumed!.job.step).toBe("compile");
      expect(resumed!.job.plan).toMatchObject({ stage: "raw" });
      expect(resumed!.job.result?.interruptions).toBe(7);
    });

    it("★★ the wall-clock ceiling ends a job whatever its failures, and nothing kicks it on", async () => {
      const job = await createOk("full");
      const claimed = await claimRevampJob(job.id);
      await releaseRevampLease(job.id, claimed!.leaseToken);
      // Inside the ceiling: claimable.
      await claimedAgo(job.id, REVAMP_RUN_CEILING_MS - 60_000);
      const inside = await claimRevampJob(job.id);
      expect(inside).not.toBeNull();
      await releaseRevampLease(job.id, inside!.leaseToken);
      // Past it: refused, never kicked, and settled by the next status read.
      await claimedAgo(job.id, REVAMP_RUN_CEILING_MS + 1_000);
      await client.query(
        "update mink_revamps set created_at = now() - interval '5 hours' where id = $1",
        [job.id],
      );
      expect(await claimRevampJob(job.id)).toBeNull();
      expect(await kickRevampIfStalled(job.id)).toBe(false);
      expect(
        await kickWaitingRevamp(crypto.randomUUID()),
      ).toBeGreaterThanOrEqual(0);
      expect(service.kick).not.toHaveBeenCalledWith(job.id);
      expect((await row(job.id)).attempts).toBe(0);
      const view = await readRevampStatus(store.actor, job.id);
      expect(view).toMatchObject({
        status: "failed",
        error: REVAMP_ERROR_MESSAGES.out_of_attempts,
      });
      expect(await row(job.id)).toMatchObject({
        error_code: "out_of_attempts",
        error_detail: "run_ceiling",
      });

      // The sweep settles one nobody reads.
      const sweptStore = await makeStore("Swept");
      const swept = await createOk("full", { fixture: sweptStore });
      const sweptClaim = await claimRevampJob(swept.id);
      await releaseRevampLease(swept.id, sweptClaim!.leaseToken);
      await claimedAgo(swept.id, REVAMP_RUN_CEILING_MS + 1_000);
      await sweepStalledRevamps(25);
      expect(await row(swept.id)).toMatchObject({
        status: "failed",
        error_code: "out_of_attempts",
        error_detail: "run_ceiling",
      });
      expect(service.kick).not.toHaveBeenCalledWith(swept.id);
    });

    it("★ the clock is the claim's: a step's save never moves it", async () => {
      const job = await createOk("full");
      const claimed = await claimRevampJob(job.id);
      const clock = (await row(job.id)).result.firstClaimedAt;
      expect(
        await saveRevampStep({
          revampId: job.id,
          leaseToken: claimed!.leaseToken,
          step: "plan",
          progress: [],
          patch: { result: { checked: true, firstClaimedAt: 1 } },
        }),
      ).toBe(true);
      expect((await row(job.id)).result).toEqual({
        checked: true,
        firstClaimedAt: clock,
        interruptions: 0,
      });
    });
  });

  // -------------------------------------------------------------------------

  describe("★★ a failed redesign gives its day's start back (B5)", () => {
    async function startedJob(fixture: Fixture = store) {
      expect(
        (await claimSpendLimits([revampStartLimit(fixture.actor.storeId)])).ok,
      ).toBe(true);
      return createOk("full", { fixture });
    }

    it("★★ a failure gives it back once, and a stop keeps it", async () => {
      const failing = await startedJob();
      await startedJob(await makeStore("Elsewhere"));
      const stopping = await startedJob(await makeStore("Third"));
      // Two of this store's starts counted, one by another store.
      await claimSpendLimits([revampStartLimit(store.actor.storeId)]);
      expect(await startsCounted(store.actor.storeId)).toBe(2);

      const claimed = await claimRevampJob(failing.id);
      expect(
        await failRevampJob({
          revampId: failing.id,
          leaseToken: claimed!.leaseToken,
          code: "plan_invalid",
          detail: "fixture",
        }),
      ).toBe("failed");
      expect(await startsCounted(store.actor.storeId)).toBe(1);
      // ★ Settling it again gives nothing more back.
      expect(
        await failRevampJob({
          revampId: failing.id,
          leaseToken: null,
          code: "internal",
          detail: "again",
        }),
      ).toBeNull();
      await readRevampStatus(store.actor, failing.id);
      expect(await startsCounted(store.actor.storeId)).toBe(1);

      // ★ A stopped redesign keeps its start, as it always has.
      const stoppingStore = (await row(stopping.id)).store_id as string;
      const stoppingActor = { ...store.actor, storeId: stoppingStore };
      expect((await cancelRevamp(stoppingActor, stopping.id))?.status).toBe(
        "cancelled",
      );
      expect(await startsCounted(stoppingStore)).toBe(1);
    });

    it("★★ the status poll and the sweep give back what they fail, once", async () => {
      const polled = await startedJob();
      const pollClaim = await claimRevampJob(polled.id);
      await client.query(
        "update mink_revamps set attempts = max_attempts where id = $1",
        [polled.id],
      );
      await expireLease(polled.id);
      void pollClaim;
      expect((await readRevampStatus(store.actor, polled.id))?.status).toBe(
        "failed",
      );
      expect(await startsCounted(store.actor.storeId)).toBe(0);

      const sweptStore = await makeStore("Swept");
      const swept = await startedJob(sweptStore);
      const sweptClaim = await claimRevampJob(swept.id);
      await releaseRevampLease(swept.id, sweptClaim!.leaseToken);
      await claimedAgo(swept.id, REVAMP_RUN_CEILING_MS + 1_000);
      expect(await startsCounted(sweptStore.actor.storeId)).toBe(1);
      await sweepStalledRevamps(25);
      expect((await row(swept.id)).status).toBe("failed");
      expect(await startsCounted(sweptStore.actor.storeId)).toBe(0);
      await sweepStalledRevamps(25);
      await readRevampStatus(sweptStore.actor, swept.id);
      expect(await startsCounted(sweptStore.actor.storeId)).toBe(0);
    });

    it("★ only to the window that counted it", async () => {
      const job = await startedJob();
      await claimSpendLimits([revampStartLimit(store.actor.storeId)]);
      // The day turned after the job was created: a new window began, which
      // never counted this redesign's start.
      await client.query(
        "update rate_limits set window_start = now() + interval '1 minute' where key = $1",
        [revampStartLimit(store.actor.storeId).key],
      );
      const claimed = await claimRevampJob(job.id);
      await failRevampJob({
        revampId: job.id,
        leaseToken: claimed!.leaseToken,
        code: "internal",
        detail: "fixture",
      });
      expect((await row(job.id)).status).toBe("failed");
      expect(await startsCounted(store.actor.storeId)).toBe(2);
    });
  });

  // -------------------------------------------------------------------------

  describe("fenced writes", () => {
    it("★ a runner that lost its lease writes nothing at all", async () => {
      const job = await createOk("full");
      const first = await claimRevampJob(job.id);
      expect(
        await saveRevampStep({
          revampId: job.id,
          leaseToken: first!.leaseToken,
          step: "plan",
          progress: [{ step: "snapshot", state: "done", detail: null }],
          patch: {
            plan: { stage: "raw", raw: { pages: [] }, repairs: 0, issues: [] },
          },
        }),
      ).toBe(true);
      const saved = await row(job.id);
      expect(saved.step).toBe("plan");
      expect(saved.attempts).toBe(0);
      expect(saved.plan).toMatchObject({ stage: "raw" });

      await expireLease(job.id);
      const second = await claimRevampJob(job.id);
      // Two real failures of this step on the books, for the saves below.
      await client.query("update mink_revamps set attempts = 2 where id = $1", [
        job.id,
      ]);
      const before = await row(job.id);
      expect(before.attempts).toBe(2);

      const stale = first!.leaseToken;
      expect(
        await saveRevampStep({
          revampId: job.id,
          leaseToken: stale,
          step: "compile",
          progress: [],
          patch: { result: { checked: true } },
        }),
      ).toBe(false);
      await reportRevampProgress(job.id, stale, [
        { step: "plan", state: "running", detail: "stale" },
      ]);
      await failRevampJob({
        revampId: job.id,
        leaseToken: stale,
        code: "internal",
        detail: "stale",
      });
      await markRevampCancelled(job.id, stale);
      const draftId = await makeDraft();
      expect(
        await finishRevampReady({
          revampId: job.id,
          leaseToken: stale,
          draftId,
          credits: 0,
          result: { checked: true },
          usage: ZERO_REVAMP_USAGE,
        }),
      ).toBe(false);
      const after = await row(job.id);
      expect(after).toEqual(before);

      // The live runner saves; the same step keeps its attempt count, a new
      // step starts its own.
      expect(
        await saveRevampStep({
          revampId: job.id,
          leaseToken: second!.leaseToken,
          step: "plan",
          progress: [],
          patch: {},
        }),
      ).toBe(true);
      expect((await row(job.id)).attempts).toBe(2);
      expect(
        await saveRevampStep({
          revampId: job.id,
          leaseToken: second!.leaseToken,
          step: "compile",
          progress: [],
          patch: {},
        }),
      ).toBe(true);
      const moved = await row(job.id);
      expect(moved.step).toBe("compile");
      // ★ A new step starts with no failures (B8).
      expect(moved.attempts).toBe(0);
      expect(
        moved.progress.map((item: { state: string }) => item.state),
      ).toEqual([
        "done",
        "done",
        "running",
        "waiting",
        "waiting",
        "waiting",
        "waiting",
        "waiting",
      ]);
    });

    it("★★ records a photo claim beside the steps' outcomes, clears it, and refuses a stale runner (jobs-3)", async () => {
      const job = await createOk("full");
      const first = await claimRevampJob(job.id);
      const token = first!.leaseToken;
      // A null column takes the claim as a plain object.
      expect(
        await holdRevampPhotos({
          revampId: job.id,
          leaseToken: token,
          hold: { units: ["anchor:anchor", "slot:hero-1"] },
        }),
      ).toBe(true);
      expect(stepsResult((await row(job.id)).result)).toEqual({
        photoHold: { units: ["anchor:anchor", "slot:hero-1"] },
      });
      expect(
        await saveRevampStep({
          revampId: job.id,
          leaseToken: token,
          step: "photos",
          progress: [],
          patch: { result: { photos: { outcomes: [] } } },
        }),
      ).toBe(true);
      // ★ Only the claim moves; the steps' outcomes stay.
      expect(
        await holdRevampPhotos({
          revampId: job.id,
          leaseToken: token,
          hold: { units: ["product:p1"] },
        }),
      ).toBe(true);
      expect(stepsResult((await row(job.id)).result)).toEqual({
        photos: { outcomes: [] },
        photoHold: { units: ["product:p1"] },
      });
      // The next claim reads it back for the step to settle.
      await expireLease(job.id);
      const second = await claimRevampJob(job.id);
      expect(second!.job.result?.photoHold).toEqual({ units: ["product:p1"] });
      // The dead runner can neither clear nor replace it.
      expect(
        await holdRevampPhotos({
          revampId: job.id,
          leaseToken: token,
          hold: null,
        }),
      ).toBe(false);
      expect((await row(job.id)).result.photoHold).toEqual({
        units: ["product:p1"],
      });
      expect(
        await holdRevampPhotos({
          revampId: job.id,
          leaseToken: second!.leaseToken,
          hold: null,
        }),
      ).toBe(true);
      expect(stepsResult((await row(job.id)).result)).toEqual({
        photos: { outcomes: [] },
      });
    });

    it("★★ records the photo checks beside the steps' outcomes and the photo claim, reads them back at the next claim, and refuses a stale runner (P0)", async () => {
      const job = await createOk("full");
      const first = await claimRevampJob(job.id);
      const token = first!.leaseToken;
      const parked: RevampPhotoReviews = {
        shots: {
          "hero-1": {
            sha256: "b".repeat(64),
            firstAskedAt: 1_761_200_000_000,
            tries: 1,
            lastTriedAt: 1_761_200_020_000,
          },
        },
      };
      // A null column takes the record as a plain object.
      expect(
        await recordRevampPhotoReviews({
          revampId: job.id,
          leaseToken: token,
          reviews: parked,
        }),
      ).toBe(true);
      expect(stepsResult((await row(job.id)).result)).toEqual({
        photoReviews: parked,
      });
      expect(
        await saveRevampStep({
          revampId: job.id,
          leaseToken: token,
          step: "photos",
          progress: [],
          patch: { result: { photos: { outcomes: [] }, photoReviews: parked } },
        }),
      ).toBe(true);
      await holdRevampPhotos({
        revampId: job.id,
        leaseToken: token,
        hold: { units: ["slot:hero-1"] },
      });
      // ★ The whole record is replaced; the outcomes and the claim stay.
      const moved: RevampPhotoReviews = {
        shots: {
          "hero-1": { ...parked.shots["hero-1"], tries: 3, verdict: "expired" },
          "story-1": {
            tries: 1,
            verdict: { problems: ["text_or_logo"] },
            redraws: [{ attempt: 1, problems: ["person"] }],
          },
        },
      };
      expect(
        await recordRevampPhotoReviews({
          revampId: job.id,
          leaseToken: token,
          reviews: moved,
        }),
      ).toBe(true);
      expect(stepsResult((await row(job.id)).result)).toEqual({
        photos: { outcomes: [] },
        photoHold: { units: ["slot:hero-1"] },
        photoReviews: moved,
      });
      // ★ The next runner carries on from it: the tries and the clock do not
      //   start over at a hand-over.
      await expireLease(job.id);
      const second = await claimRevampJob(job.id);
      expect(second!.job.result?.photoReviews).toEqual(moved);
      // The dead runner can no longer write it.
      expect(
        await recordRevampPhotoReviews({
          revampId: job.id,
          leaseToken: token,
          reviews: parked,
        }),
      ).toBe(false);
      expect((await row(job.id)).result.photoReviews).toEqual(moved);
      // A record that cannot be read is refused whole, before any write.
      await expect(
        recordRevampPhotoReviews({
          revampId: job.id,
          leaseToken: second!.leaseToken,
          reviews: { shots: { "hero-1": { tries: -1 } } },
        }),
      ).rejects.toThrow("invalid_photo_reviews");
      expect((await row(job.id)).result.photoReviews).toEqual(moved);
    });

    it("★★ a Stop after the runner died with a photo claim gives back what it never drew, once (jobs-3)", async () => {
      const job = await createOk("full");
      const claimed = await claimRevampJob(job.id);
      expect(
        await holdRevampPhotos({
          revampId: job.id,
          leaseToken: claimed!.leaseToken,
          hold: { units: ["anchor:anchor", "slot:hero-1", "slot:story-1"] },
        }),
      ).toBe(true);
      // It drew the anchor and died; the merchant then pressed Stop.
      await client.query(
        `insert into mink_revamp_images(id,revamp_id,store_id,role,slot_id,url,path,sha256,width,height)
         values($1,$2,$3,'anchor','anchor','https://example.test/a.webp','stores/x/a.webp',$4,1600,1200)`,
        [crypto.randomUUID(), job.id, store.actor.storeId, "a".repeat(64)],
      );
      await expireLease(job.id);
      expect(await cancelRevamp(store.actor, job.id)).toMatchObject({
        status: "cancelled",
      });
      service.release.mockClear();
      // Another store's finished claim is not this read's to settle.
      expect(
        await settleFinishedPhotoHolds({
          revampId: job.id,
          storeId: crypto.randomUUID(),
        }),
      ).toBe(0);
      expect(await readRevampStatus(store.actor, job.id)).not.toBeNull();
      expect(service.release).toHaveBeenCalledTimes(1);
      expect(service.release).toHaveBeenCalledWith(store.actor.storeId, 2);
      expect((await row(job.id)).result?.photoHold).toBeUndefined();
      // ★ Once: the record went with the give-back.
      expect(await settleFinishedPhotoHolds()).toBe(0);
      await readRevampStatus(store.actor, job.id);
      expect(service.release).toHaveBeenCalledTimes(1);
    });

    it("★ never settles the claim of a job a runner may still own", async () => {
      const job = await createOk("full");
      const claimed = await claimRevampJob(job.id);
      await holdRevampPhotos({
        revampId: job.id,
        leaseToken: claimed!.leaseToken,
        hold: { units: ["slot:hero-1"] },
      });
      service.release.mockClear();
      expect(await settleFinishedPhotoHolds()).toBe(0);
      expect(service.release).not.toHaveBeenCalled();
      expect((await row(job.id)).result.photoHold).toEqual({
        units: ["slot:hero-1"],
      });
    });

    it("a failure with no token waits for a live runner to let go", async () => {
      const job = await createOk("full");
      const claimed = await claimRevampJob(job.id);
      await failRevampJob({
        revampId: job.id,
        leaseToken: null,
        code: "internal",
        detail: "sweep",
      });
      expect((await row(job.id)).status).toBe("running");
      await expireLease(job.id);
      await failRevampJob({
        revampId: job.id,
        leaseToken: null,
        code: "internal",
        detail: "x".repeat(5_000),
      });
      const failed = await row(job.id);
      expect(failed.status).toBe("failed");
      expect(failed.error_detail).toHaveLength(2_000);
      expect(failed.lease_token).toBeNull();
      expect(claimed).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  describe("cancelling", () => {
    it("★ cancels a queued revamp at once", async () => {
      const job = await createOk("full");
      const view = await cancelRevamp(store.actor, job.id);
      expect(view).toMatchObject({
        status: "cancelled",
        error: REVAMP_ERROR_MESSAGES.cancelled,
      });
      const stored = await row(job.id);
      expect(stored.status).toBe("cancelled");
      expect(stored.error_code).toBe("cancelled");
      expect(stored.cancel_requested_at).not.toBeNull();
      expect(stored.finished_at).not.toBeNull();
    });

    it("★ asks a live runner to stop, which it sees at its renewal", async () => {
      const job = await createOk("full");
      const claimed = await claimRevampJob(job.id);
      await saveRevampStep({
        revampId: job.id,
        leaseToken: claimed!.leaseToken,
        step: "plan",
        progress: [],
        patch: {},
      });
      const asked = await cancelRevamp(store.actor, job.id);
      expect(asked?.status).toBe("running");
      expect((await row(job.id)).cancel_requested_at).not.toBeNull();
      expect(await renewRevampLease(job.id, claimed!.leaseToken)).toEqual({
        ok: true,
        cancelRequested: true,
      });
      await markRevampCancelled(job.id, claimed!.leaseToken);
      const stopped = await row(job.id);
      expect(stopped.status).toBe("cancelled");
      expect(stopped.lease_token).toBeNull();
      // ★ No step is left turning on a stopped job.
      expect(
        stopped.progress.some(
          (item: { state: string }) => item.state === "running",
        ),
      ).toBe(false);
    });

    it("★ settles a stop request no runner will ever see", async () => {
      const job = await createOk("full");
      await claimRevampJob(job.id);
      await cancelRevamp(store.actor, job.id);
      await expireLease(job.id);
      const view = await readRevampStatus(store.actor, job.id);
      expect(view?.status).toBe("cancelled");
      expect((await row(job.id)).status).toBe("cancelled");
    });

    it("cancels a running job nobody holds, and leaves another admin's and a finished one alone", async () => {
      const job = await createOk("full");
      const claimed = await claimRevampJob(job.id);
      await releaseRevampLease(job.id, claimed!.leaseToken, {
        retryAfterMs: 60_000,
      });
      expect(
        await cancelRevamp({ ...store.actor, adminId: "someone-else" }, job.id),
      ).toBeNull();
      expect((await row(job.id)).status).toBe("running");
      expect((await cancelRevamp(store.actor, job.id))?.status).toBe(
        "cancelled",
      );

      const ready = await createOk("full");
      await finish(ready.id);
      expect((await cancelRevamp(store.actor, ready.id))?.status).toBe("ready");
      expect((await row(ready.id)).status).toBe("ready");
    });
  });

  // -------------------------------------------------------------------------

  describe("★★ a card that was made and paid for is never cancelled or failed", () => {
    /**
     * A job whose card step made the draft and its charge (one transaction in
     * drafts.ts, keyed by the revamp's id) and then could not attach it: the
     * finish write failed, so the runner gave the lease back parked.
     */
    async function madeCard(
      options: {
        fixture?: Fixture;
        paid?: boolean;
        draft?: boolean;
        kind?: RevampKind;
        parentId?: string | null;
        park?: boolean;
      } = {},
    ) {
      const fixture = options.fixture ?? store;
      const job = await createOk(options.kind ?? "full", {
        fixture,
        parentId: options.parentId ?? null,
      });
      if (options.paid !== false && job.free) {
        await client.query(
          "update mink_revamps set free = false where id = $1",
          [job.id],
        );
      }
      const claimed = await claimRevampJob(job.id);
      if (!claimed) throw new Error("expected a claim");
      expect(
        await saveRevampStep({
          revampId: job.id,
          leaseToken: claimed.leaseToken,
          step: "card",
          progress: [],
          patch: { result: { checked: true } },
        }),
      ).toBe(true);
      if (options.draft !== false) {
        const paid = options.paid !== false;
        await client.query(
          `insert into mink_drafts(id,store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits,charged_credits,credit_source)
           values($1,$2,$3,$4,'storefront_personalization','storefront','Whole storefront','/dashboard/builder','Store redesign',$5,$6,$6,$7)`,
          [
            job.id,
            fixture.actor.storeId,
            ADMIN,
            fixture.actor.runId,
            { plan_json: "{}", plan_digest: "digest", explanation: "Redesign" },
            paid ? 60 : 0,
            paid ? "plan" : "free",
          ],
        );
      }
      if (options.park !== false) {
        await releaseRevampLease(job.id, claimed.leaseToken, {
          retryAfterMs: 60_000,
        });
      }
      return { job, leaseToken: claimed.leaseToken };
    }

    function expectFinishedWithCard(
      stored: Record<string, unknown>,
      id: string,
    ) {
      expect(stored).toMatchObject({
        status: "ready",
        step: "card",
        draft_id: id,
        error_code: null,
        lease_token: null,
        lease_until: null,
      });
      expect(stored.finished_at).not.toBeNull();
      expect(
        (stored.progress as Array<{ state: string }>).some(
          (item) => item.state === "running",
        ),
      ).toBe(false);
    }

    it("★★ Stop while the paid card waits to be attached finishes it as ready, keeping its charge", async () => {
      const { job } = await madeCard();
      const view = await cancelRevamp(store.actor, job.id);
      expect(view).toMatchObject({ status: "ready", draftId: job.id });
      expect(view?.error).toBeNull();
      const stored = await row(job.id);
      expectFinishedWithCard(stored, job.id);
      expect(stored.credits).toBe(60);
    });

    it("★★ the settlement that finishes it tells the requester it is ready, and nobody else (ops-4)", async () => {
      await client.query(
        "insert into admins(id,email,role,store_id,first_name) values($1,'owner@example.com','superadmin',$2,'Owner'),('revamp-staff','staff@example.com','admin',$2,'Staff')",
        [ADMIN, store.actor.storeId],
      );
      const { job } = await madeCard();
      expect((await cancelRevamp(store.actor, job.id))?.status).toBe("ready");
      const events = await client.query(
        "select id, type, store_id from activity_events where subject_id = $1",
        [job.id],
      );
      expect(events.rows).toEqual([
        expect.objectContaining({
          type: "mink.revamp_ready",
          store_id: store.actor.storeId,
        }),
      ]);
      const notices = await client.query(
        "select recipient_type, recipient_id, url from notifications where event_id = $1",
        [events.rows[0].id],
      );
      // ★★ It opens the chat the card is in (B20).
      expect(notices.rows).toEqual([
        {
          recipient_type: "admin",
          recipient_id: ADMIN,
          url: `/dashboard?chat=${store.conversationId}`,
        },
      ]);
    });

    it("★ a free card is finished the same way, and charges nothing", async () => {
      const { job } = await madeCard({ paid: false });
      expect((await cancelRevamp(store.actor, job.id))?.status).toBe("ready");
      const stored = await row(job.id);
      expectFinishedWithCard(stored, job.id);
      expect(stored.credits).toBe(0);
    });

    it("★★ a stop the card's runner will never see is settled as ready, not cancelled", async () => {
      const { job } = await madeCard({ park: false });
      // A live runner holds it, so the stop is only recorded...
      expect((await cancelRevamp(store.actor, job.id))?.status).toBe("running");
      // ...and then the runner dies before it attaches the card.
      await expireLease(job.id);
      const view = await readRevampStatus(store.actor, job.id);
      expect(view).toMatchObject({ status: "ready", draftId: job.id });
      expectFinishedWithCard(await row(job.id), job.id);
    });

    it("★★ attempts that ran out after the card was made finish it as ready, not out_of_attempts", async () => {
      const { job } = await madeCard();
      await client.query(
        "update mink_revamps set attempts = max_attempts where id = $1",
        [job.id],
      );
      await expireLease(job.id);
      const view = await readRevampStatus(store.actor, job.id);
      expect(view).toMatchObject({ status: "ready", draftId: job.id });
      const stored = await row(job.id);
      expectFinishedWithCard(stored, job.id);
      expect(stored.credits).toBe(60);
    });

    it("★★ a made card past the ceiling is finished as ready, never failed (B8)", async () => {
      const { job } = await madeCard();
      await claimedAgo(job.id, REVAMP_RUN_CEILING_MS + 1_000);
      await expireLease(job.id);
      const view = await readRevampStatus(store.actor, job.id);
      expect(view).toMatchObject({ status: "ready", draftId: job.id });
      expectFinishedWithCard(await row(job.id), job.id);
    });

    it("★★ the sweep finishes made cards and still fails and cancels the rest", async () => {
      const exhausted = await madeCard();
      await client.query(
        "update mink_revamps set attempts = max_attempts where id = $1",
        [exhausted.job.id],
      );
      await expireLease(exhausted.job.id);

      const stopStore = await makeStore("Stopped card");
      const stopped = await madeCard({ fixture: stopStore, park: false });
      await cancelRevamp(stopStore.actor, stopped.job.id);
      await expireLease(stopped.job.id);

      // No card was made here, so it fails as before.
      const bareStore = await makeStore("No card");
      const bare = await madeCard({ fixture: bareStore, draft: false });
      await client.query(
        "update mink_revamps set attempts = max_attempts where id = $1",
        [bare.job.id],
      );
      await expireLease(bare.job.id);

      await sweepStalledRevamps(25);
      expectFinishedWithCard(await row(exhausted.job.id), exhausted.job.id);
      expectFinishedWithCard(await row(stopped.job.id), stopped.job.id);
      expect(await row(bare.job.id)).toMatchObject({
        status: "failed",
        error_code: "out_of_attempts",
        draft_id: null,
      });
      expect(service.kick).not.toHaveBeenCalledWith(exhausted.job.id);
    });

    it("★★ the runner's own cancel, at the card step, finishes a made card as ready", async () => {
      const { job, leaseToken } = await madeCard({ park: false });
      expect(await markRevampCancelled(job.id, leaseToken)).toBe("ready");
      expectFinishedWithCard(await row(job.id), job.id);

      const bareStore = await makeStore("Bare");
      const bare = await madeCard({
        fixture: bareStore,
        draft: false,
        park: false,
      });
      expect(await markRevampCancelled(bare.job.id, bare.leaseToken)).toBe(
        "cancelled",
      );
      expect((await row(bare.job.id)).status).toBe("cancelled");
    });

    it("★★ the runner's own failure, at the card step, finishes a made card as ready", async () => {
      // The requester lost the Website Builder while the paid card waited to
      // be attached: the next invocation fails the job before any step runs,
      // under its own lease.
      const { job, leaseToken } = await madeCard({ park: false });
      const settled = await failRevampJob({
        revampId: job.id,
        leaseToken,
        code: "not_allowed",
        detail: "requester may not draft Website Builder changes",
      });
      const stored = await row(job.id);
      expectFinishedWithCard(stored, job.id);
      expect(stored.credits).toBe(60);
      expect(settled).toBe("ready");

      // With no card made, it fails exactly as before.
      const bareStore = await makeStore("Bare failure");
      const bare = await madeCard({
        fixture: bareStore,
        draft: false,
        park: false,
      });
      expect(
        await failRevampJob({
          revampId: bare.job.id,
          leaseToken: bare.leaseToken,
          code: "not_allowed",
          detail: "requester may not draft Website Builder changes",
        }),
      ).toBe("failed");
      expect(await row(bare.job.id)).toMatchObject({
        status: "failed",
        error_code: "not_allowed",
        draft_id: null,
      });
    });

    it("★ a claim that cannot read the request finishes a made card as ready, never failed", async () => {
      // A revision that cannot read what a newer one wrote (a rollout's
      // overlap) claims a job whose paid card waits to be attached.
      const { job } = await madeCard();
      await client.query(
        `update mink_revamps set request = jsonb_set(request, '{brief}', '3'::jsonb) where id = $1`,
        [job.id],
      );
      await expireLease(job.id);
      expect(await claimRevampJob(job.id)).toBeNull();
      const stored = await row(job.id);
      expectFinishedWithCard(stored, job.id);
      expect(stored.credits).toBe(60);

      // With no card made, it fails at the claim exactly as before.
      const bareStore = await makeStore("Unreadable, no card");
      const bare = await madeCard({ fixture: bareStore, draft: false });
      await client.query(
        `update mink_revamps set request = jsonb_set(request, '{brief}', '3'::jsonb) where id = $1`,
        [bare.job.id],
      );
      await expireLease(bare.job.id);
      expect(await claimRevampJob(bare.job.id)).toBeNull();
      expect(await row(bare.job.id)).toMatchObject({
        status: "failed",
        error_code: "internal",
        error_detail: "unreadable_request",
      });
    });

    it("★ a failure with no token finishes a made card nobody holds as ready too", async () => {
      const { job } = await madeCard();
      await expireLease(job.id);
      expect(
        await failRevampJob({
          revampId: job.id,
          leaseToken: null,
          code: "internal",
          detail: "fixture",
        }),
      ).toBe("ready");
      expectFinishedWithCard(await row(job.id), job.id);
    });

    it("★ a refinement finished this way retires its parent, as the card step would", async () => {
      const parent = await createOk("full");
      await finish(parent.id);
      const { job } = await madeCard({ kind: "refine", parentId: parent.id });
      expect((await cancelRevamp(store.actor, job.id))?.status).toBe("ready");
      expect(await row(parent.id)).toMatchObject({
        status: "superseded",
        superseded_by: job.id,
      });
    });

    it("★ without a card, a Stop still cancels at once", async () => {
      const { job } = await madeCard({ draft: false });
      expect((await cancelRevamp(store.actor, job.id))?.status).toBe(
        "cancelled",
      );
    });
  });

  // -------------------------------------------------------------------------

  describe("finishing", () => {
    it("★ supersedes the parent and the conversation's other unapplied cards, never an applied one", async () => {
      const applied = await createOk("full");
      await finish(applied.id);
      await client.query(
        "update mink_revamps set applied_at = now() where id = $1",
        [applied.id],
      );
      const unapplied = await createOk("full");
      await finish(unapplied.id);
      // The applied card survived the second card's finish.
      expect((await row(applied.id)).status).toBe("ready");

      const elsewhere = await makeStore("Elsewhere");
      const otherConversation = crypto.randomUUID();
      await client.query(
        "insert into mink_conversations(id,store_id,admin_id,title) values($1,$2,$3,'Another chat')",
        [otherConversation, store.actor.storeId, ADMIN],
      );
      const otherChat = await createOk("full", {
        conversationId: otherConversation,
      });
      await finish(otherChat.id);
      const otherStore = await createOk("full", { fixture: elsewhere });
      await finish(otherStore.id, { fixture: elsewhere });

      // A refinement of the applied card: its parent retires whether or not it
      // was applied, and the unapplied card of the same chat retires with it.
      const refine = await createOk("refine", { parentId: applied.id });
      const draftId = await finish(refine.id, { credits: 999 });

      expect(await row(applied.id)).toMatchObject({
        status: "superseded",
        superseded_by: refine.id,
      });
      expect(await row(unapplied.id)).toMatchObject({
        status: "superseded",
        superseded_by: refine.id,
      });
      expect((await row(otherChat.id)).status).toBe("ready");
      expect((await row(otherStore.id)).status).toBe("ready");

      const done = await row(refine.id);
      expect(done).toMatchObject({
        status: "ready",
        step: "card",
        draft_id: draftId,
        credits: REVAMP_LIMITS.maxCredits,
        lease_token: null,
        lease_until: null,
      });
      expect(done.finished_at).not.toBeNull();
      expect(
        done.progress.every((item: { state: string }) => item.state === "done"),
      ).toBe(true);
      expect(done.usage).toMatchObject({ inputTokens: 100 });

      // E finds the card's job by its draft, and only while it is ready.
      expect(
        (await findReadyRevampByDraft(store.actor.storeId, draftId))?.id,
      ).toBe(refine.id);
      expect(
        await findReadyRevampByDraft(elsewhere.actor.storeId, draftId),
      ).toBeNull();

      // An applied card that was superseded keeps showing what was applied.
      const view = await readRevampStatus(store.actor, applied.id);
      expect(view?.supersededBy).toBe(refine.id);
    });

    it("★ a free revamp charges nothing whatever the runner says", async () => {
      const job = await createOk("full");
      expect(job.free).toBe(true);
      await finish(job.id, { credits: 50 });
      expect((await row(job.id)).credits).toBe(0);
    });

    it("lists the conversation's revamps newest first", async () => {
      const first = await createOk("full");
      await finish(first.id);
      await client.query(
        "update mink_revamps set created_at = now() - interval '1 hour', result = $2 where id = $1",
        [first.id, { stored: { summary: "A warm store for candles." } }],
      );
      const second = await createOk("full");
      const entries = await listConversationRevamps({
        storeId: store.actor.storeId,
        adminId: ADMIN,
        conversationId: store.conversationId,
      });
      expect(entries.map((entry) => entry.id)).toEqual([second.id, first.id]);
      expect(entries[1]).toMatchObject({
        status: "ready",
        summary: "A warm store for candles.",
      });
      // ★ Whether a stop was asked, read in the same query as a real boolean
      //   (the chat tools compare it with `=== true`): a claimed job keeps
      //   running after Stop until its runner notices.
      expect(entries.map((entry) => entry.cancelRequested)).toEqual([
        false,
        false,
      ]);
      await claimRevampJob(second.id);
      await cancelRevamp(store.actor, second.id);
      const stopping = await listConversationRevamps({
        storeId: store.actor.storeId,
        adminId: ADMIN,
        conversationId: store.conversationId,
      });
      expect(stopping[0]).toMatchObject({
        id: second.id,
        status: "running",
        cancelRequested: true,
      });
      expect(stopping[1].cancelRequested).toBe(false);
      expect(
        await listConversationRevamps({
          storeId: store.actor.storeId,
          adminId: "someone-else",
          conversationId: store.conversationId,
        }),
      ).toEqual([]);
    });

    it("★ counts a tree's refinements, never the failed or cancelled ones", async () => {
      const root = await createOk("full");
      await finish(root.id);
      const one = await createOk("refine", { parentId: root.id });
      await finish(one.id);
      const two = await createOk("refine", { parentId: one.id });
      await finish(two.id);
      const dropped = await createOk("refine", { parentId: root.id });
      await cancelRevamp(store.actor, dropped.id);
      const broken = await createOk("refine", { parentId: two.id });
      const claimed = await claimRevampJob(broken.id);
      await failRevampJob({
        revampId: broken.id,
        leaseToken: claimed!.leaseToken,
        code: "internal",
        detail: "fixture",
      });
      expect(await countRefinements(root.id)).toBe(2);
      expect(await countRefinements(two.id)).toBe(2);
      expect(await countRefinements(one.id)).toBe(2);
    });
  });

  // -------------------------------------------------------------------------

  describe("keeping a job moving", () => {
    it("★ kicks a stalled job once per cooldown", async () => {
      const job = await createOk("full");
      // Too new: the cooldown counts from the job's creation.
      expect(await kickRevampIfStalled(job.id)).toBe(false);
      await client.query(
        "update mink_revamps set created_at = now() - interval '1 minute' where id = $1",
        [job.id],
      );
      expect(await kickRevampIfStalled(job.id)).toBe(true);
      expect(service.kick).toHaveBeenCalledWith(job.id);
      expect(await kickRevampIfStalled(job.id)).toBe(false);
      expect(service.kick).toHaveBeenCalledTimes(1);

      // A job somebody is working on is never kicked.
      await client.query(
        "update mink_revamps set last_kick_at = now() - interval '1 minute' where id = $1",
        [job.id],
      );
      await claimRevampJob(job.id);
      expect(await kickRevampIfStalled(job.id)).toBe(false);
    });

    it("★ sweeps: fails what ran out, cancels unseen stops, kicks the stalled, and leaves live work alone", async () => {
      const stalled = await createOk("full");
      await client.query(
        "update mink_revamps set created_at = '2000-01-01T00:00:00Z' where id = $1",
        [stalled.id],
      );

      const spentStore = await makeStore("Spent");
      const spent = await createOk("full", { fixture: spentStore });
      const spentClaim = await claimRevampJob(spent.id);
      await client.query(
        "update mink_revamps set attempts = max_attempts where id = $1",
        [spent.id],
      );
      await expireLease(spent.id);
      expect(spentClaim).not.toBeNull();

      const stopStore = await makeStore("Stopped");
      const stopping = await createOk("full", { fixture: stopStore });
      await claimRevampJob(stopping.id);
      await cancelRevamp(stopStore.actor, stopping.id);
      await expireLease(stopping.id);

      const liveStore = await makeStore("Live");
      const live = await createOk("full", { fixture: liveStore });
      await client.query(
        "update mink_revamps set created_at = '2000-01-01T00:00:00Z' where id = $1",
        [live.id],
      );
      const liveClaim = await claimRevampJob(live.id);

      const result = await sweepStalledRevamps(25);
      expect(result.failed).toBeGreaterThanOrEqual(1);
      const kicked = service.kick.mock.calls.map((call) => call[0]);
      expect(kicked).toContain(stalled.id);
      expect(kicked).not.toContain(live.id);
      expect(kicked).not.toContain(spent.id);
      expect(kicked).not.toContain(stopping.id);

      expect(await row(spent.id)).toMatchObject({
        status: "failed",
        error_code: "out_of_attempts",
        lease_token: null,
      });
      expect(await row(stopping.id)).toMatchObject({
        status: "cancelled",
        error_code: "cancelled",
      });
      expect(await row(live.id)).toMatchObject({
        status: "running",
        lease_token: liveClaim!.leaseToken,
      });
      expect((await row(stalled.id)).last_kick_at).not.toBeNull();
    });

    it("★★ hands a freed process slot to the oldest waiting revamp, past the poll's cooldown, never the one that ran (jobs-1)", async () => {
      const ran = await createOk("full");
      const waitingStore = await makeStore("Waiting");
      const waiting = await createOk("full", { fixture: waitingStore });
      // Older than anything else in the local database, the one that ran
      // the oldest; the waiting one was kicked (and turned away) just now.
      await client.query(
        "update mink_revamps set created_at = '1999-01-01T00:00:00Z' where id = $1",
        [ran.id],
      );
      await client.query(
        "update mink_revamps set created_at = '1999-01-02T00:00:00Z', last_kick_at = now() where id = $1",
        [waiting.id],
      );
      expect(await kickWaitingRevamp(ran.id)).toBe(1);
      expect(service.kick).toHaveBeenCalledTimes(1);
      expect(service.kick).toHaveBeenCalledWith(waiting.id);
      expect((await row(waiting.id)).last_kick_at).not.toBeNull();

      // A waiting job somebody now holds is never the one kicked.
      await claimRevampJob(waiting.id);
      service.kick.mockClear();
      await kickWaitingRevamp(ran.id);
      expect(service.kick).not.toHaveBeenCalledWith(waiting.id);
      expect(service.kick).not.toHaveBeenCalledWith(ran.id);
    });
  });
  describe("★★ the redo memory's read (robustness audit section 5, step 6)", () => {
    const compiled = (summary: string) => ({
      stage: "compiled",
      plan: { summary, pages: [], shots: [], bindings: [] },
      productPhotoKeys: [],
      unfitted: {
        summary: `${summary} (uncut)`,
        pages: [],
        shots: [],
        bindings: [],
      },
    });

    /** One revamp row of `fixture`, written as a finished job would leave it. */
    async function revamp(
      fixture: Fixture,
      options: {
        status: string;
        kind?: RevampKind;
        plan: unknown;
        minutesAgo: number;
        parentId?: string;
      },
    ): Promise<string> {
      const id = crypto.randomUUID();
      const kind = options.kind ?? "full";
      const draftId =
        options.status === "ready" ? await makeDraft(fixture) : null;
      await client.query(
        `insert into mink_revamps(id, store_id, admin_id, kind, status, request, plan, free, parent_id, draft_id, error_code, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, now() - ($11::int * interval '1 minute'))`,
        [
          id,
          fixture.actor.storeId,
          ADMIN,
          kind,
          options.status,
          request(kind),
          options.plan,
          options.parentId ?? null,
          draftId,
          options.status === "failed" ? "internal" : null,
          options.minutesAgo,
        ],
      );
      return id;
    }

    it("★★ reads only this store's redesigns a merchant saw, compiled, newest first, never this job and never another store's", async () => {
      const other = await makeStore("Elsewhere");
      const first = await revamp(store, {
        status: "superseded",
        plan: compiled("first"),
        minutesAgo: 60,
      });
      await revamp(store, {
        status: "ready",
        kind: "refine",
        parentId: first,
        plan: compiled("refined"),
        minutesAgo: 50,
      });
      // Designs nobody saw, and one never compiled.
      await revamp(store, {
        status: "failed",
        plan: compiled("failed"),
        minutesAgo: 40,
      });
      await revamp(store, {
        status: "cancelled",
        plan: compiled("stopped"),
        minutesAgo: 35,
      });
      await revamp(store, {
        status: "superseded",
        plan: { stage: "raw", raw: {}, repairs: 0, issues: [] },
        minutesAgo: 30,
      });
      // ★ Another store's design, newer than all of them.
      await revamp(other, {
        status: "ready",
        plan: compiled("another store"),
        minutesAgo: 1,
      });
      // The job asking: this store's, running, its own plan compiled.
      const current = await createOk("full");
      await client.query("update mink_revamps set plan = $2 where id = $1", [
        current.id,
        compiled("current"),
      ]);

      const read = await readEarlierRevampPlans({
        storeId: store.actor.storeId,
        revampId: current.id,
        limit: 5,
      });
      // ★ The plan the card showed, never the copy from before a budget cut.
      expect(read).toEqual([compiled("refined").plan, compiled("first").plan]);
      expect(
        await readEarlierRevampPlans({
          storeId: store.actor.storeId,
          revampId: current.id,
          limit: 1,
        }),
      ).toEqual([compiled("refined").plan]);
      // ★★ And the other store sees only its own.
      expect(
        await readEarlierRevampPlans({
          storeId: other.actor.storeId,
          revampId: current.id,
          limit: 5,
        }),
      ).toEqual([compiled("another store").plan]);
    });

    it("leaves out the job asking even when it is ready itself", async () => {
      const id = await revamp(store, {
        status: "ready",
        plan: compiled("mine"),
        minutesAgo: 5,
      });
      expect(
        await readEarlierRevampPlans({
          storeId: store.actor.storeId,
          revampId: id,
          limit: 5,
        }),
      ).toEqual([]);
    });
  });
});
