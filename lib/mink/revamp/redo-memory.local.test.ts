/** The redo memory on the real chain (robustness audit section 5, step 6):
 * the real job, runner, snapshot, offline planner and compiler, the real
 * earlier-plans read and the real theme registry, against the local
 * database. A store's second full redesign is planned with a summary of its
 * first and measured against it before any photograph; another store's
 * identical design is never read.
 *
 * Run with MINK_REVAMP_LOCAL_TEST=1. The fixed loopback database keeps it
 * away from Cloud SQL.
 *
 * ★ REAL TRANSACTIONS, as in e2e.local: every `withService` commits, and the
 *   two stores it makes are deleted in `afterAll` whether or not a test
 *   failed (the store cascade takes every row the chain wrote).
 * ★ EACH REDESIGN STOPS AT ITS PHOTOGRAPHS: the photos step fails it for
 *   good, after the compile step saved the plan and the check's record, so
 *   nothing is drawn, charged or published. The first one is then marked
 *   superseded by hand: a card the merchant saw. Models are the offline fakes
 *   (MINK_REVAMP_PROVIDER=fake). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import type { MinkActorContext } from "../types";
import type { RevampRequest, RevampSitePlan } from "./contract";
import type { RevampDistinctnessRecord } from "./jobs";
import type { RevampDeps } from "./ports";

const env = vi.hoisted(() => {
  // ★ Set before any module reads them, as e2e.local does.
  if (process.env.MINK_REVAMP_LOCAL_TEST === "1") {
    process.env.DB_HOST = "127.0.0.1";
    process.env.DB_PORT = "5544";
    process.env.DB_NAME = "storemink_local";
    process.env.DB_USER = process.env.USER ?? "postgres";
    process.env.DB_POOL_MAX = "4";
    delete process.env.DB_PASSWORD;
    process.env.MINK_REVAMP_PROVIDER = "fake";
  }
  return {
    log: vi.fn((event: string, fields?: unknown) => {
      void event;
      void fields;
    }),
  };
});

vi.mock("./trigger", () => ({ kickRevampRunner: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications/record", () => ({
  emitEvent: vi.fn(),
  recordEvent: vi.fn(async () => undefined),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: vi.fn(),
}));
vi.mock("@/lib/observability/logger", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  logInfo: env.log,
  logWarn: vi.fn(),
}));

const OWNER = "redo-memory-owner";

const enabled = process.env.MINK_REVAMP_LOCAL_TEST === "1";
describe.skipIf(!enabled)("the redo memory, on local Postgres", () => {
  let client: Client;
  let closePool: () => Promise<void>;
  const storeIds: string[] = [];
  let jobs: typeof import("./jobs");
  let runner: typeof import("./runner");
  let deps: typeof import("./deps");
  let distinctness: typeof import("./distinctness");
  let registry: typeof import("@/lib/themes/runtime-registry");

  /** A store on Basket with an owner, a chat and a run, as a merchant has. */
  async function makeStore(name: string): Promise<{
    actor: MinkActorContext;
    conversationId: string;
  }> {
    const storeId = crypto.randomUUID();
    storeIds.push(storeId);
    await client.query(
      `insert into stores(id, slug, name, status, plan, settings)
       values ($1, $2, $3, 'active', 'pro', $4)`,
      [
        storeId,
        `redo-memory-${storeId.slice(0, 8)}`,
        name,
        { launched: true, brand: { name } },
      ],
    );
    const adminId = `${OWNER}-${storeId.slice(0, 8)}`;
    await client.query(
      `insert into admins(id, email, role, store_id, force_password_reset, first_name)
       values ($1, $2, 'superadmin', $3, false, 'Rukmini')`,
      [adminId, `owner-${storeId.slice(0, 8)}@example.com`, storeId],
    );
    const { applyTheme } = await import("@/lib/themes/apply");
    const installed = await applyTheme(storeId, "basket", { publish: true });
    expect(installed.errors).toEqual([]);
    const conversationId = crypto.randomUUID();
    await client.query(
      `insert into mink_conversations(id, store_id, admin_id, title)
       values ($1, $2, $3, 'Customise my store')`,
      [conversationId, storeId, adminId],
    );
    const runId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    await client.query(
      `insert into mink_runs(id, store_id, conversation_id, requested_by, request_id, model)
       values ($1, $2, $3, $4, $5, 'fixture')`,
      [runId, storeId, conversationId, adminId, requestId],
    );
    return {
      conversationId,
      actor: {
        storeId,
        adminId,
        email: `owner-${storeId.slice(0, 8)}@example.com`,
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

  const REQUEST: RevampRequest = {
    kind: "full",
    brief: {
      business: "Rukmini's corner bakery in Kothrud, baking sourdough daily",
      look: "warm and homely",
      audience: "families nearby",
      facts: ["We bake every morning from 5 am"],
      avoid: "",
      language: "English",
    },
    products: [],
    categories: [],
    pages: null,
    instruction: null,
    refineScope: null,
  };

  /** The production steps, stopped for good at the photographs. */
  function stoppingDeps(over: Partial<RevampDeps> = {}): RevampDeps {
    return {
      ...deps.defaultRevampDeps(),
      photos: async () => {
        const { RevampStepError } = await import("./step-error");
        throw new RevampStepError(
          "photos_failed",
          "stopped by the test",
          false,
        );
      },
      ...over,
    };
  }

  /** Creates a full redesign and runs it until it settles. */
  async function redesign(
    store: { actor: MinkActorContext; conversationId: string },
    over: Partial<RevampDeps> = {},
  ): Promise<string> {
    const created = await jobs.createRevampJob({
      actor: store.actor,
      conversationId: store.conversationId,
      kind: "full",
      request: REQUEST,
      parentId: null,
      budgetCredits: null,
    });
    if (!created.ok) throw new Error(`refused: ${created.reason}`);
    let outcome = "";
    for (let pass = 0; pass < 4 && outcome !== "failed"; pass += 1) {
      ({ outcome } = await runner.runRevampJob({
        revampId: created.job.id,
        deps: stoppingDeps(over),
      }));
    }
    expect(outcome).toBe("failed");
    return created.job.id;
  }

  async function row(revampId: string) {
    return (
      await client.query(
        "select status, error_code, plan, result from mink_revamps where id = $1",
        [revampId],
      )
    ).rows[0] as {
      status: string;
      error_code: string | null;
      plan: { stage: string; plan: RevampSitePlan };
      result: { distinctness?: RevampDistinctnessRecord } | null;
    };
  }

  /** A failed redesign turned into a card the merchant saw and retired. */
  async function seen(revampId: string) {
    await client.query(
      `update mink_revamps set status = 'superseded', error_code = null, error_detail = null
       where id = $1`,
      [revampId],
    );
  }

  beforeAll(async () => {
    const pg = await import("pg");
    const { postgresStringTimestampTypes } = await import("@/lib/db/pg-types");
    client = new pg.Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: process.env.USER,
      types: postgresStringTimestampTypes,
    });
    await client.connect();
    jobs = await import("./jobs");
    runner = await import("./runner");
    deps = await import("./deps");
    distinctness = await import("./distinctness");
    registry = await import("@/lib/themes/runtime-registry");
    ({ closePool } = await import("@/lib/db/client"));
  }, 60_000);

  afterAll(async () => {
    if (client) {
      for (const storeId of storeIds) {
        try {
          await client.query("begin");
          await client.query("set constraints all deferred");
          await client.query("delete from stores where id = $1", [storeId]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          await client.query("delete from rate_limits where key like $1", [
            `%${storeId}%`,
          ]);
        }
      }
    }
    await client?.end();
    await closePool?.();
  }, 60_000);

  it("★★ plans a store's redo with its own first redesign in mind, and moves a twin of it away before any photograph", async () => {
    const store = await makeStore("Crumb Corner");
    const other = await makeStore("Elsewhere Bakes");

    // The store's first redesign: nothing earlier to compare with.
    const first = await redesign(store);
    const firstRow = await row(first);
    expect(firstRow.plan.stage).toBe("compiled");
    const theme = await registry.resolveInstalledThemeDefinition({
      id: "basket",
    });
    expect(theme).not.toBeNull();
    const bar = distinctness.revampDistinctnessBar(theme!);
    expect(firstRow.result?.distinctness).toEqual({
      status: "not-compared",
      passed: true,
      bar,
      before: [],
      after: [],
      changed: [],
      kept: [],
    });
    await seen(first);
    const earlier = firstRow.plan.plan;

    // ★★ Another store holds the very same design: never read for this one.
    const elsewhere = await redesign(other);
    await client.query(
      "update mink_revamps set plan = jsonb_set(plan, '{plan}', $2) where id = $1",
      [elsewhere, earlier],
    );
    await seen(elsewhere);

    // The redo: the planner sees the first, and its compile comes back as a
    // twin of it (the audit's same-design-twice case).
    const planned: Array<Parameters<RevampDeps["plan"]>[1]> = [];
    const production = deps.defaultRevampDeps();
    const second = await redesign(store, {
      plan: (ctx, input) => {
        planned.push(input);
        return production.plan(ctx, input);
      },
      compile: () => ({ plan: structuredClone(earlier), issues: [] }),
    });
    expect(planned).toHaveLength(1);
    const input = planned[0] as (typeof planned)[0] & {
      revampId?: string;
      earlierDesigns?: string;
    };
    expect(input.revampId).toBe(second);
    expect(input.earlierDesigns).toBe(
      distinctness.earlierDesignsSummary([earlier]),
    );
    expect(input.earlierDesigns).toMatch(/^1 \(newest\)\. direction /);
    expect(input.earlierDesigns).not.toContain("\n2 ");
    for (const word of ["Rukmini", "Kothrud", "Crumb", "sourdough"]) {
      expect(input.earlierDesigns).not.toContain(word);
    }

    const secondRow = await row(second);
    const record = secondRow.result?.distinctness;
    // ★ One earlier design compared: its own, not the other store's twin.
    expect(record).toMatchObject({ status: "changed", passed: true, bar });
    expect(record?.before).toEqual([0]);
    expect(record!.after[0]).toBeGreaterThanOrEqual(bar);
    expect(record!.changed.length).toBeGreaterThan(0);
    // The saved plan is the moved one, measured as the record says.
    const saved = secondRow.plan.plan;
    expect(
      distinctness.revampDistances(theme!, saved, [earlier])[0],
    ).toBeCloseTo(record!.after[0], 3);
    expect(saved.summary).toBe(earlier.summary);
    expect(saved.shots).toEqual(earlier.shots);
    // And it stopped at the photographs, as the test asked: nothing drawn.
    expect(secondRow.status).toBe("failed");
    expect(secondRow.error_code).toBe("photos_failed");
    const images = await client.query(
      "select count(*)::int as n from mink_revamp_images where revamp_id = $1",
      [second],
    );
    expect(images.rows[0].n).toBe(0);

    // ★ One content-free line per check.
    const lines = env.log.mock.calls.filter(
      ([event]) => event === "mink.revamp.distinctness",
    );
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const last = lines.find(
      ([, fields]) => (fields as { revampId?: string }).revampId === second,
    );
    expect(last?.[1]).toEqual({
      revampId: second,
      status: "changed",
      passed: true,
      bar,
      before: [0],
      after: record!.after,
      changes: record!.changed.length,
    });
    expect(JSON.stringify(last)).not.toContain("Rukmini");
  }, 300_000);
});
