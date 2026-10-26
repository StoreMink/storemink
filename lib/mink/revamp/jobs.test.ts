/* eslint-disable @typescript-eslint/no-explicit-any */
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
  type DbMock,
} from "@/app/actions/_test-helpers";

const holder = vi.hoisted(() => ({
  db: null as DbMock | null,
  enabled: true,
  kick: vi.fn(async () => undefined),
  release: vi.fn(async (storeId: string, count: number) => {
    void storeId;
    void count;
  }),
  recordEvent: vi.fn(async (event: unknown) => {
    void event;
    return "event-id" as string | null;
  }),
  // A failed redesign's start given back (B5).
  releaseStart: vi.fn(
    async (limits: unknown, options?: { claimedAt?: string }) => {
      void limits;
      void options;
    },
  ),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(holder.db!.db))),
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: holder.enabled })),
}));
vi.mock("./trigger", () => ({ kickRevampRunner: holder.kick }));
vi.mock("./image-store", () => ({ releaseRevampPhotos: holder.release }));
vi.mock("@/lib/notifications/record", () => ({
  recordEvent: holder.recordEvent,
}));
vi.mock("../spend-limits", () => ({
  releaseSpendLimits: holder.releaseStart,
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { MinkRequestError, MinkToolInputError } from "../errors";
import type { MinkActorContext } from "../types";
import {
  REVAMP_ERROR_MESSAGES,
  REVAMP_LIMITS,
  initialRevampProgress,
  type RevampRequest,
  type RevampStoredPlan,
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
  readRevampForActor,
  readRevampJob,
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
import { ZERO_REVAMP_USAGE } from "./ports";
import { revampReadyEvent } from "./ready-notice";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const REVAMP_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
const DRAFT_ID = "66666666-6666-4666-8666-666666666666";
const TOKEN = "77777777-7777-4777-8777-777777777777";
const PARKED = "00000000-0000-4000-8000-000000000000";

const actor: MinkActorContext = {
  storeId: STORE_ID,
  adminId: "owner-1",
  email: " Owner@Example.com ",
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  runId: RUN_ID,
  draftingEnabled: true,
  requestId: "request-1",
};

function request(overrides: Partial<RevampRequest> = {}): RevampRequest {
  return {
    kind: "full",
    brief: {
      business: "Cold-pressed mustard oil from our own press",
      look: "Warm and earthy",
      audience: "Home cooks",
      facts: ["Pressed in Jaipur since 1998"],
      avoid: "",
      language: "English",
    },
    products: [
      {
        key: "p1",
        name: "Mustard oil",
        description: "Pressed weekly",
        sizes: [{ label: "1 l", price: 349, mrp: 399 }],
        photoUrl: null,
        categorySlug: null,
      },
    ],
    categories: [
      {
        action: "create",
        name: "Oils",
        slug: null,
        description: null,
        newPhoto: true,
      },
    ],
    pages: null,
    instruction: null,
    refineScope: null,
    ...overrides,
  };
}

function storedPlan(): RevampStoredPlan {
  return {
    schemaVersion: 2,
    revampId: REVAMP_ID,
    kind: "full",
    summary: "A warm store for cold-pressed oil.",
    pages: [],
    chrome: null,
    brand: null,
    categories: [],
    products: { hide: [], create: [] },
    photos: [],
    checks: [],
    skipped: [],
    notes: [],
    explanation: "",
    credits: {
      pages: 0,
      photos: 0,
      design: 0,
      chrome: 0,
      categories: 0,
      productPhotos: 0,
      total: 0,
    },
    free: true,
  };
}

/** A mink_revamps row as Drizzle returns it (camelCase, string timestamps). */
function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVAMP_ID,
    storeId: STORE_ID,
    adminId: "owner-1",
    requesterEmail: "owner@example.com",
    conversationId: CONVERSATION_ID,
    originRunId: RUN_ID,
    parentId: null,
    supersededBy: null,
    kind: "full",
    status: "queued",
    step: "snapshot",
    progress: initialRevampProgress(),
    request: request(),
    snapshot: null,
    plan: null,
    result: null,
    draftId: null,
    free: true,
    budgetCredits: null,
    credits: 0,
    leaseToken: null,
    leaseUntil: null,
    attempts: 0,
    maxAttempts: 4,
    lastKickAt: null,
    cancelRequestedAt: null,
    errorCode: null,
    errorDetail: null,
    appliedAt: null,
    publishedAt: null,
    undoneAt: null,
    applySnapshot: null,
    publishSnapshot: null,
    usage: {},
    createdAt: "2026-10-21 05:00:00.123456+00",
    updatedAt: "2026-10-21 05:00:00.123456+00",
    finishedAt: null,
    ...overrides,
  };
}

function uniqueViolation(constraint = "mink_revamps_one_active_idx") {
  return Object.assign(new Error("duplicate key value"), {
    code: "23505",
    constraint,
  });
}

function rejectingInsert(error: unknown) {
  holder.db!.db.insert = vi.fn(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(() => Promise.reject(error)),
    })),
  }));
}

beforeEach(() => {
  holder.enabled = true;
  holder.db = makeDbMock();
});

// ---------------------------------------------------------------------------

describe("createRevampJob", () => {
  it("★ refuses while the store already has a revamp building, writing nothing", async () => {
    holder.db = makeDbMock({ selectQueue: [[{ id: OTHER_ID }]] });
    const result = await createRevampJob({
      actor,
      conversationId: null,
      kind: "full",
      request: request(),
      parentId: null,
      budgetCredits: null,
    });
    expect(result).toEqual({
      ok: false,
      reason: "active_exists",
      activeId: OTHER_ID,
    });
    expect(holder.db.calls.insert).toHaveLength(0);
    // ★ The store lock is taken before the check, in the same transaction.
    expect(sqlText(holder.db.calls.execute[0])).toContain(
      "pg_advisory_xact_lock",
    );
  });

  it("★ makes the store's first full revamp free, with no budget", async () => {
    holder.db = makeDbMock({
      selectQueue: [[], []],
      returningQueue: [[rawRow()]],
    });
    const result = await createRevampJob({
      actor,
      conversationId: null,
      kind: "full",
      request: request(),
      parentId: null,
      budgetCredits: 80,
    });
    expect(result.ok).toBe(true);
    const values = holder.db.calls.values[0];
    expect(values).toMatchObject({
      storeId: STORE_ID,
      adminId: "owner-1",
      requesterEmail: "owner@example.com",
      originRunId: RUN_ID,
      kind: "full",
      status: "queued",
      step: "snapshot",
      free: true,
      budgetCredits: null,
      maxAttempts: REVAMP_LIMITS.maxAttempts,
      progress: initialRevampProgress(),
      usage: ZERO_REVAMP_USAGE,
    });
  });

  it("charges a second full revamp once a free one holds it, keeping the budget", async () => {
    holder.db = makeDbMock({
      selectQueue: [[], [{ id: OTHER_ID }]],
      returningQueue: [[rawRow({ free: false, budgetCredits: 80 })]],
    });
    const result = await createRevampJob({
      actor,
      conversationId: null,
      kind: "full",
      request: request(),
      parentId: null,
      budgetCredits: 80.7,
    });
    expect(result.ok && result.job.free).toBe(false);
    expect(holder.db.calls.values[0]).toMatchObject({
      free: false,
      budgetCredits: 80,
    });
  });

  it("★ never makes a refinement free, and never asks whether the free one is used", async () => {
    holder.db = makeDbMock({
      // active check, parent check: then straight to the insert.
      selectQueue: [[], [{ id: OTHER_ID }]],
      returningQueue: [
        [
          rawRow({
            kind: "refine",
            parentId: OTHER_ID,
            free: false,
            request: request({ kind: "refine", instruction: "Warmer" }),
          }),
        ],
      ],
    });
    const result = await createRevampJob({
      actor,
      conversationId: null,
      kind: "refine",
      request: request({ kind: "refine", instruction: "Warmer" }),
      parentId: OTHER_ID,
      budgetCredits: 30,
    });
    expect(result.ok).toBe(true);
    expect(holder.db.calls.select).toHaveLength(2);
    expect(holder.db.calls.values[0]).toMatchObject({
      kind: "refine",
      parentId: OTHER_ID,
      free: false,
      budgetCredits: 30,
    });
  });

  it("★ refuses a parent that is not the requester's own revamp of this store", async () => {
    holder.db = makeDbMock({ selectQueue: [[], []] });
    await expect(
      createRevampJob({
        actor,
        conversationId: null,
        kind: "refine",
        request: request({ kind: "refine" }),
        parentId: OTHER_ID,
        budgetCredits: null,
      }),
    ).rejects.toMatchObject({
      code: "mink_revamp_parent_unavailable",
      status: 404,
    });
    expect(holder.db.calls.insert).toHaveLength(0);
  });

  it("refuses a conversation that is not the requester's in this store", async () => {
    holder.db = makeDbMock({ selectQueue: [[], []] });
    await expect(
      createRevampJob({
        actor,
        conversationId: CONVERSATION_ID,
        kind: "full",
        request: request(),
        parentId: null,
        budgetCredits: null,
      }),
    ).rejects.toMatchObject({ code: "mink_revamp_conversation_unavailable" });
  });

  it("★ maps the active index violation to the same refusal", async () => {
    holder.db = makeDbMock({
      // the transaction's active check and free check, then the lookup that
      // follows the violation.
      selectQueue: [[], [], [{ id: OTHER_ID }]],
    });
    rejectingInsert(uniqueViolation());
    const result = await createRevampJob({
      actor,
      conversationId: null,
      kind: "full",
      request: request(),
      parentId: null,
      budgetCredits: null,
    });
    expect(result).toEqual({
      ok: false,
      reason: "active_exists",
      activeId: OTHER_ID,
    });
  });

  it("tries once more when the active job vanished before the lookup, then gives a plain refusal", async () => {
    holder.db = makeDbMock({ selectQueue: [[], [], [], [], [], []] });
    rejectingInsert(uniqueViolation());
    await expect(
      createRevampJob({
        actor,
        conversationId: null,
        kind: "full",
        request: request(),
        parentId: null,
        budgetCredits: null,
      }),
    ).rejects.toMatchObject({ code: "mink_revamp_busy", status: 409 });
    expect(holder.db.db.insert).toHaveBeenCalledTimes(2);
  });

  it("rethrows any other database error", async () => {
    holder.db = makeDbMock({ selectQueue: [[], []] });
    rejectingInsert(uniqueViolation("mink_revamps_pkey"));
    await expect(
      createRevampJob({
        actor,
        conversationId: null,
        kind: "full",
        request: request(),
        parentId: null,
        budgetCredits: null,
      }),
    ).rejects.toThrow("duplicate key value");
  });

  it("★ requires Website Builder manage, drafting and a run", async () => {
    const base = {
      conversationId: null,
      kind: "full" as const,
      request: request(),
      parentId: null,
      budgetCredits: null,
    };
    await expect(
      createRevampJob({
        ...base,
        actor: { ...actor, isSuperadmin: false, permissions: {} },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createRevampJob({ ...base, actor: { ...actor, draftingEnabled: false } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createRevampJob({ ...base, actor: { ...actor, runId: undefined } }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    expect(holder.db!.calls.execute).toHaveLength(0);
  });

  it("refuses a request it could not read back, before anything is written", async () => {
    await expect(
      createRevampJob({
        actor,
        conversationId: null,
        kind: "full",
        request: { ...request(), brief: { business: 7 } } as never,
        parentId: null,
        budgetCredits: null,
      }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(
      createRevampJob({
        actor,
        conversationId: null,
        kind: "refine",
        request: request(),
        parentId: OTHER_ID,
        budgetCredits: null,
      }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    expect(holder.db!.calls.execute).toHaveLength(0);
  });

  it("refuses a full revamp that names a parent, a refinement without one, and a bad budget", async () => {
    const base = {
      actor,
      conversationId: null,
      request: request(),
      budgetCredits: null,
    };
    await expect(
      createRevampJob({ ...base, kind: "full", parentId: OTHER_ID }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(
      createRevampJob({
        ...base,
        kind: "refine",
        request: request({ kind: "refine" }),
        parentId: null,
      }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(
      createRevampJob({
        ...base,
        kind: "full",
        parentId: null,
        budgetCredits: -1,
      }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
  });
});

// ---------------------------------------------------------------------------

describe("the lease", () => {
  it("★★ claims under a new token, running, and counts nothing (B8)", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [
          rawRow({
            status: "running",
            attempts: 2,
            result: { firstClaimedAt: 1_760_000_000_000, interruptions: 3 },
          }),
        ],
      ],
    });
    const claimed = await claimRevampJob(REVAMP_ID);
    expect(claimed?.job.status).toBe("running");
    // The step's failures so far, which the claim does not add to.
    expect(claimed?.job.attempts).toBe(2);
    expect(claimed?.job.result).toEqual({
      firstClaimedAt: 1_760_000_000_000,
      interruptions: 3,
    });
    const set = holder.db.calls.set[0];
    expect(set.status).toBe("running");
    expect(set.leaseToken).toBe(claimed?.leaseToken);
    // ★ A claim whose process dies costs the job nothing.
    expect(set).not.toHaveProperty("attempts");
    // ★ It starts the ceiling's clock once, and counts an interrupted claim
    //   (a held token still on the row) for the logs.
    const result = sqlText(set.result);
    expect(result).toContain("'firstClaimedAt'");
    expect(result).toContain("ELSE to_jsonb(");
    expect(result).toContain("'interruptions'");
    expect(result).toContain("IS NOT NULL AND");
    expect(sqlParamValues(set.result)).toContain(
      "00000000-0000-4000-8000-000000000000",
    );
    // ★ And refuses a job past its ceiling, with failures still under the
    //   limit.
    const where = sqlText(holder.db.calls.where[0]);
    expect(where).toContain("NOT (CASE WHEN jsonb_typeof(");
    expect(where).toContain(" < ");
    expect(sqlParamValues(holder.db.calls.where[0])).toContain(
      REVAMP_RUN_CEILING_MS,
    );
    expect(claimed?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns null when the job is not claimable (live lease, cancelled, done, out of attempts)", async () => {
    holder.db = makeDbMock({ returningQueue: [[]] });
    await expect(claimRevampJob(REVAMP_ID)).resolves.toBeNull();
    expect(holder.db.calls.set).toHaveLength(1);
  });

  it("★ fails a claimed job whose request cannot be read, and hands it to no runner", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [rawRow({ status: "running", request: { kind: "full", brief: 3 } })],
        // No card was made, so the job is not finished as ready.
        [],
        [
          {
            id: REVAMP_ID,
            storeId: STORE_ID,
            createdAt: "2026-10-21 05:00:00.123456+00",
            cancelRequestedAt: null,
          },
        ],
      ],
    });
    await expect(claimRevampJob(REVAMP_ID)).resolves.toBeNull();
    expect(sqlText(holder.db.calls.where[1])).toContain("mink_drafts");
    expect(holder.db.calls.set[2]).toMatchObject({
      status: "failed",
      errorCode: "internal",
      errorDetail: "unreadable_request",
      leaseToken: null,
      leaseUntil: null,
    });
    // ★★ The failed redesign gives its day's start back (B5).
    expect(holder.releaseStart).toHaveBeenCalledTimes(1);
    expect(holder.releaseStart).toHaveBeenCalledWith(
      [revampStartLimit(STORE_ID)],
      { claimedAt: "2026-10-21 05:00:00.123456+00" },
    );
  });

  it("★★ finishes a claimed job whose card was already made as ready, even with an unreadable request", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [
          rawRow({
            status: "running",
            step: "card",
            request: { kind: "full", brief: 3 },
          }),
        ],
        [rawRow({ status: "ready", step: "card", draftId: REVAMP_ID })],
      ],
    });
    await expect(claimRevampJob(REVAMP_ID)).resolves.toBeNull();
    expect(holder.db.calls.set[1]).toMatchObject({
      status: "ready",
      leaseToken: null,
      errorCode: null,
    });
    expect(
      holder.db.calls.set.some((set: any) => set.status === "failed"),
    ).toBe(false);
  });

  it("never queries for a malformed id", async () => {
    await expect(claimRevampJob("nope")).resolves.toBeNull();
    expect(holder.db!.calls.update).toHaveLength(0);
  });

  it("renews a held lease and reports a stop request", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [{ cancelRequestedAt: null }],
        [{ cancelRequestedAt: "2026-10-21 05:01:00+00" }],
        [],
      ],
    });
    await expect(renewRevampLease(REVAMP_ID, TOKEN)).resolves.toEqual({
      ok: true,
      cancelRequested: false,
    });
    await expect(renewRevampLease(REVAMP_ID, TOKEN)).resolves.toEqual({
      ok: true,
      cancelRequested: true,
    });
    // ★ A lost lease: nothing matched, so the runner must stop.
    await expect(renewRevampLease(REVAMP_ID, TOKEN)).resolves.toEqual({
      ok: false,
      cancelRequested: false,
    });
  });

  it("★ refuses the parked token everywhere a runner could use it", async () => {
    await expect(renewRevampLease(REVAMP_ID, PARKED)).resolves.toEqual({
      ok: false,
      cancelRequested: false,
    });
    await expect(
      saveRevampStep({
        revampId: REVAMP_ID,
        leaseToken: PARKED,
        step: "plan",
        progress: [],
        patch: {},
      }),
    ).resolves.toBe(false);
    await releaseRevampLease(REVAMP_ID, PARKED);
    await markRevampCancelled(REVAMP_ID, PARKED);
    await failRevampJob({
      revampId: REVAMP_ID,
      leaseToken: PARKED,
      code: "internal",
      detail: "x",
    });
    expect(holder.db!.calls.update).toHaveLength(0);
  });

  it("★ parks a transient failure behind the retry wait, and frees a hand-over at once", async () => {
    await releaseRevampLease(REVAMP_ID, TOKEN, { retryAfterMs: 60_000 });
    const parked = holder.db!.calls.set[0];
    expect(parked.leaseToken).toBe(PARKED);
    expect(sqlText(parked.leaseUntil)).toContain("interval '1 millisecond'");
    await releaseRevampLease(REVAMP_ID, TOKEN);
    expect(holder.db!.calls.set[1]).toMatchObject({
      leaseToken: null,
      leaseUntil: null,
    });
  });

  it("★★ a hand-over that stored photos gives the step its crash budget back, in the one fenced statement (jobs-5)", async () => {
    await releaseRevampLease(REVAMP_ID, TOKEN, { progressed: true });
    expect(holder.db!.calls.update).toHaveLength(1);
    expect(holder.db!.calls.set[0]).toMatchObject({
      leaseToken: null,
      leaseUntil: null,
      attempts: 0,
    });
    // ★ Fenced on the lease: a runner that lost it resets nothing.
    expect(sqlParamValues(holder.db!.calls.where[0])).toEqual(
      expect.arrayContaining([REVAMP_ID, TOKEN, "running"]),
    );
    // ★ A hand-over that stored nothing counts nothing either (B8): the
    //   deadline is not a failure, and the claim no longer counts one.
    await releaseRevampLease(REVAMP_ID, TOKEN);
    expect(holder.db!.calls.set[1]).not.toHaveProperty("attempts");
  });

  it("★★ a release carries what the runner spent since its last save, in the one fenced statement (L2-F)", async () => {
    const spent = {
      ...ZERO_REVAMP_USAGE,
      images: 6,
      reviews: 4,
      estimatedCostMicroUsd: 812_000,
    };
    await releaseRevampLease(REVAMP_ID, TOKEN, { usage: spent });
    await releaseRevampLease(REVAMP_ID, TOKEN, {
      retryAfterMs: 60_000,
      usage: { ...spent, images: -3, reviews: Number.NaN } as never,
    });
    await releaseRevampLease(REVAMP_ID, TOKEN, {
      progressed: true,
      usage: spent,
    });
    expect(holder.db!.calls.update).toHaveLength(3);
    expect(holder.db!.calls.set[0]).toMatchObject({
      leaseToken: null,
      usage: spent,
    });
    // ★ Read like every usage write: nothing negative or unreadable lands.
    expect(holder.db!.calls.set[1]).toMatchObject({
      leaseToken: PARKED,
      usage: { ...spent, images: 0, reviews: 0 },
    });
    expect(holder.db!.calls.set[2]).toMatchObject({
      attempts: 0,
      usage: spent,
    });
    for (const where of holder.db!.calls.where) {
      expect(sqlParamValues(where)).toEqual(
        expect.arrayContaining([REVAMP_ID, TOKEN, "running"]),
      );
    }
    // A release with nothing unsaved leaves the column alone.
    await releaseRevampLease(REVAMP_ID, TOKEN);
    expect(holder.db!.calls.set[3]).not.toHaveProperty("usage");
  });

  it("★ a parked release never gives the budget back, progress or not", async () => {
    await releaseRevampLease(REVAMP_ID, TOKEN, {
      retryAfterMs: 60_000,
      progressed: true,
    });
    expect(holder.db!.calls.set[0].leaseToken).toBe(PARKED);
    // It counts the failure it follows, and never resets the count.
    expect(sqlText(holder.db!.calls.set[0].attempts)).toContain("+ 1");
  });

  it("★★ only a real failure counts, in the one fenced statement (B8)", async () => {
    // A parked release follows a failure: it counts by default.
    await releaseRevampLease(REVAMP_ID, TOKEN, { retryAfterMs: 60_000 });
    expect(sqlText(holder.db!.calls.set[0].attempts)).toContain("+ 1");
    // ★ A wait on Google is parked, not counted.
    await releaseRevampLease(REVAMP_ID, TOKEN, {
      retryAfterMs: 60_000,
      counted: false,
    });
    expect(holder.db!.calls.set[1].leaseToken).toBe(PARKED);
    expect(holder.db!.calls.set[1]).not.toHaveProperty("attempts");
    // ★ A stuck step caught by the deadline is handed over AND counted.
    await releaseRevampLease(REVAMP_ID, TOKEN, { counted: true });
    expect(holder.db!.calls.set[2]).toMatchObject({
      leaseToken: null,
      leaseUntil: null,
    });
    expect(sqlText(holder.db!.calls.set[2].attempts)).toContain("+ 1");
    // ★ Progress wins over a count: stored photos are not a failure.
    await releaseRevampLease(REVAMP_ID, TOKEN, {
      counted: true,
      progressed: true,
    });
    expect(holder.db!.calls.set[3].attempts).toBe(0);
    for (const where of holder.db!.calls.where) {
      expect(sqlParamValues(where)).toEqual(
        expect.arrayContaining([REVAMP_ID, TOKEN, "running"]),
      );
    }
  });

  it("a release that fails is logged, never thrown", async () => {
    holder.db!.db.update = vi.fn(() => {
      throw new Error("connection terminated");
    });
    await expect(
      releaseRevampLease(REVAMP_ID, TOKEN, { retryAfterMs: 1 }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("saveRevampStep", () => {
  it("writes the step, the progress and only the patched columns", async () => {
    holder.db = makeDbMock({ returningQueue: [[{ id: REVAMP_ID }]] });
    const saved = await saveRevampStep({
      revampId: REVAMP_ID,
      leaseToken: TOKEN,
      step: "compile",
      progress: [
        { step: "snapshot", state: "done", detail: null },
        { step: "plan", state: "done", detail: null },
        { step: "compile", state: "running", detail: "Repair 1 of 2" },
      ],
      patch: {
        plan: { stage: "raw", raw: { pages: [] }, repairs: 0, issues: [] },
      },
    });
    expect(saved).toBe(true);
    const set = holder.db.calls.set[0];
    expect(set.step).toBe("compile");
    expect(set.plan).toEqual({
      stage: "raw",
      raw: { pages: [] },
      repairs: 0,
      issues: [],
    });
    expect("snapshot" in set).toBe(false);
    expect("result" in set).toBe(false);
    expect(set.progress).toHaveLength(8);
    expect(set.progress[2]).toEqual({
      step: "compile",
      state: "running",
      detail: "Repair 1 of 2",
    });
    // ★ The failure count restarts when the step moves on (B8): a claim
    //   counts nothing, so a new step starts with none.
    expect(sqlText(set.attempts)).toContain("CASE WHEN");
    expect(sqlText(set.attempts)).toContain("THEN 0 ELSE");
    expect(sqlParamValues(set.attempts)).toContain("compile");
  });

  it("★★ a step's result never moves the claim's own fields (B8)", async () => {
    holder.db = makeDbMock({ returningQueue: [[{ id: REVAMP_ID }]] });
    await saveRevampStep({
      revampId: REVAMP_ID,
      leaseToken: TOKEN,
      step: "photos",
      progress: initialRevampProgress(),
      // A result that carries an older clock, as a step's copy might.
      patch: { result: { firstClaimedAt: 5, interruptions: 9 } },
    });
    const result = holder.db.calls.set[0].result;
    const text = sqlText(result);
    // The step's result is written over the column ...
    expect(sqlParamValues(result)).toContain(
      JSON.stringify({ firstClaimedAt: 5, interruptions: 9 }),
    );
    // ... and the stored clock and count laid back on top of it.
    expect(text).toContain("jsonb_strip_nulls(jsonb_build_object(");
    expect(text).toContain("'firstClaimedAt', CASE WHEN jsonb_typeof(");
    expect(text).toContain("'interruptions', CASE WHEN jsonb_typeof(");
  });

  it("★ returns false when the lease is gone, and writes nothing else", async () => {
    holder.db = makeDbMock({ returningQueue: [[]] });
    await expect(
      saveRevampStep({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        step: "plan",
        progress: initialRevampProgress(),
        patch: { usage: ZERO_REVAMP_USAGE },
      }),
    ).resolves.toBe(false);
    // One fenced UPDATE: no read, no second write, no insert.
    expect(holder.db.calls.update).toHaveLength(1);
    expect(holder.db.calls.select).toHaveLength(0);
    expect(holder.db.calls.insert).toHaveLength(0);
  });

  it("refuses a step outside the vocabulary", async () => {
    await expect(
      saveRevampStep({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        step: "publish" as never,
        progress: [],
        patch: {},
      }),
    ).rejects.toThrow("invalid_revamp_step");
  });

  it("bounds a progress detail and drops unreadable entries", async () => {
    await reportRevampProgress(REVAMP_ID, TOKEN, [
      { step: "photos", state: "running", detail: "x".repeat(500) },
      { step: "nope", state: "running", detail: null } as never,
      { step: "photos", state: "done", detail: null },
    ]);
    const progress = holder.db!.calls.set[0].progress;
    expect(progress).toHaveLength(1);
    expect(progress[0].detail).toHaveLength(120);
  });

  it("a progress report that fails is logged, never thrown", async () => {
    holder.db!.db.update = vi.fn(() => {
      throw new Error("connection terminated");
    });
    await expect(
      reportRevampProgress(REVAMP_ID, TOKEN, []),
    ).resolves.toBeUndefined();
  });
});

describe("★★ the photo claim on the job row (jobs-3)", () => {
  const units = ["anchor:anchor", "slot:hero-1", "product:p1"];

  it("records a claim into the result column alone, fenced on the lease", async () => {
    holder.db = makeDbMock({ returningQueue: [[{ id: REVAMP_ID }]] });
    await expect(
      holdRevampPhotos({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        hold: { units },
      }),
    ).resolves.toBe(true);
    const set = holder.db.calls.set[0];
    // ★ Only the claim moves: the steps' outcomes in the column are kept.
    expect(Object.keys(set).sort()).toEqual(["result", "updatedAt"]);
    expect(sqlText(set.result)).toContain("jsonb_build_object('photoHold'");
    expect(sqlParamValues(set.result)).toContain(JSON.stringify({ units }));
    expect(sqlParamValues(holder.db.calls.where[0])).toEqual(
      expect.arrayContaining([REVAMP_ID, TOKEN, "running"]),
    );
  });

  it("clears the claim without touching the rest of the column", async () => {
    holder.db = makeDbMock({ returningQueue: [[{ id: REVAMP_ID }]] });
    await holdRevampPhotos({
      revampId: REVAMP_ID,
      leaseToken: TOKEN,
      hold: null,
    });
    expect(sqlText(holder.db.calls.set[0].result)).toContain("- 'photoHold'");
  });

  it("★ returns false when the lease is gone, writing nothing else", async () => {
    holder.db = makeDbMock({ returningQueue: [[]] });
    await expect(
      holdRevampPhotos({ revampId: REVAMP_ID, leaseToken: TOKEN, hold: null }),
    ).resolves.toBe(false);
    expect(holder.db.calls.update).toHaveLength(1);
    await expect(
      holdRevampPhotos({ revampId: REVAMP_ID, leaseToken: PARKED, hold: null }),
    ).resolves.toBe(false);
    expect(holder.db.calls.update).toHaveLength(1);
  });

  it("refuses a claim it could not read back, instead of writing it", async () => {
    await expect(
      holdRevampPhotos({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        hold: { units: ["slot:hero-1", "bogus"] },
      }),
    ).rejects.toThrow("invalid_photo_hold");
    expect(holder.db!.calls.update).toHaveLength(0);
  });

  it("reads a claim back off the row at the next claim, dropping what it cannot read", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [
          rawRow({
            status: "running",
            step: "photos",
            attempts: 2,
            result: {
              photos: { outcomes: [] },
              photoHold: { units: ["slot:hero-1", "nope", 7, "product:p2"] },
            },
          }),
        ],
      ],
    });
    const claimed = await claimRevampJob(REVAMP_ID);
    expect(claimed?.job.result?.photoHold).toEqual({
      units: ["slot:hero-1", "product:p2"],
    });
    expect(claimed?.job.result?.photos).toEqual({ outcomes: [] });
  });
});

describe("★★ the photo checks' record on the job row (P0)", () => {
  const reviews = {
    shots: {
      "hero-1": {
        sha256: "a".repeat(64),
        firstAskedAt: 1_760_000_000_000,
        tries: 3,
        lastTriedAt: 1_760_000_120_000,
        verdict: "expired" as const,
      },
      "story-1": {
        tries: 1,
        verdict: { problems: [] },
        redraws: [{ attempt: 1, problems: ["poor_crop"] }],
      },
      "@anchor": {
        tries: 0,
        redraws: [{ attempt: 1, problems: ["off_style", "refused"] }],
      },
    },
  };
  const written = () => {
    const param = sqlParamValues(holder.db!.calls.set[0].result).find(
      (value) => typeof value === "string" && value.startsWith('{"shots"'),
    );
    return JSON.parse(param as string);
  };

  it("records the whole record into the result column alone, fenced on the lease", async () => {
    holder.db = makeDbMock({ returningQueue: [[{ id: REVAMP_ID }]] });
    await expect(
      recordRevampPhotoReviews({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        reviews,
      }),
    ).resolves.toBe(true);
    const set = holder.db.calls.set[0];
    // ★ Only the record moves: the steps' outcomes and the claim are kept.
    expect(Object.keys(set).sort()).toEqual(["result", "updatedAt"]);
    // ★ Merged into the column as it is, never written over it.
    expect(sqlText(set.result)).toContain(
      "ELSE '{}'::jsonb END || jsonb_build_object('photoReviews'",
    );
    expect(written()).toEqual(reviews);
    expect(sqlParamValues(holder.db.calls.where[0])).toEqual(
      expect.arrayContaining([REVAMP_ID, TOKEN, "running"]),
    );
  });

  it("★ returns false when the lease is gone, writing nothing else", async () => {
    holder.db = makeDbMock({ returningQueue: [[]] });
    await expect(
      recordRevampPhotoReviews({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        reviews,
      }),
    ).resolves.toBe(false);
    expect(holder.db.calls.update).toHaveLength(1);
    // A parked token or a malformed id never reaches the database.
    await expect(
      recordRevampPhotoReviews({
        revampId: REVAMP_ID,
        leaseToken: PARKED,
        reviews,
      }),
    ).resolves.toBe(false);
    await expect(
      recordRevampPhotoReviews({
        revampId: "nope",
        leaseToken: TOKEN,
        reviews,
      }),
    ).resolves.toBe(false);
    expect(holder.db.calls.update).toHaveLength(1);
  });

  it.each([
    ["a digest that is not one", { "hero-1": { tries: 1, sha256: "nope" } }],
    ["more tries than any run makes", { "hero-1": { tries: 101 } }],
    ["a negative try count", { "hero-1": { tries: -1 } }],
    ["a time that is not one", { "hero-1": { tries: 1, firstAskedAt: 0 } }],
    [
      "a problem past its length",
      { "hero-1": { tries: 1, verdict: { problems: ["x".repeat(41)] } } },
    ],
    [
      "a verdict that is neither a list nor expired",
      { "hero-1": { tries: 1, verdict: "passed" } },
    ],
    [
      "a redraw before the first attempt",
      { "hero-1": { tries: 1, redraws: [{ attempt: 0, problems: [] }] } },
    ],
    [
      "more redraws than a shoot allows",
      {
        "hero-1": {
          tries: 1,
          redraws: Array.from({ length: 13 }, (_, i) => ({
            attempt: i + 1,
            problems: ["person"],
          })),
        },
      },
    ],
    ["a shot id with spaces round it", { " hero-1": { tries: 1 } }],
    [
      "more shots than a plan has",
      Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`shot-${i}`, { tries: 1 }]),
      ),
    ],
  ])(
    "refuses a record it could not read back (%s), instead of writing it",
    async (_label, shots) => {
      await expect(
        recordRevampPhotoReviews({
          revampId: REVAMP_ID,
          leaseToken: TOKEN,
          reviews: { shots } as never,
        }),
      ).rejects.toThrow("invalid_photo_reviews");
      expect(holder.db!.calls.update).toHaveLength(0);
    },
  );

  it("reads the record back at the next claim, keeping the entries it can read", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [
          rawRow({
            status: "running",
            step: "photos",
            attempts: 2,
            result: {
              photoHold: { units: ["slot:hero-1"] },
              photoReviews: {
                shots: {
                  "hero-1": reviews.shots["hero-1"],
                  "story-1": { tries: "three" },
                  "about-1": { tries: 2, sha256: "b".repeat(64) },
                },
              },
            },
          }),
        ],
      ],
    });
    const claimed = await claimRevampJob(REVAMP_ID);
    expect(claimed?.job.result?.photoReviews).toEqual({
      shots: {
        "hero-1": reviews.shots["hero-1"],
        "about-1": { tries: 2, sha256: "b".repeat(64) },
      },
    });
    expect(claimed?.job.result?.photoHold).toEqual({ units: ["slot:hero-1"] });
  });

  it("★ reads why each photo and product was drawn again, and each model's tries that got no answer", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [
          rawRow({
            status: "running",
            step: "assemble",
            attempts: 1,
            usage: {
              images: 3,
              calls: {
                "gemini-3-pro-image": { rateLimited: 2, timeouts: 0 },
                "gemini-3.8-flash": { rateLimited: 0, timeouts: 1 },
                "nothing-counted": { rateLimited: 0, timeouts: 0 },
                "not-a-count": "busy",
              },
            },
            result: {
              photos: {
                outcomes: [
                  {
                    shotId: "hero-1",
                    status: "generated",
                    reason: null,
                    redraws: [{ attempt: 1, problems: ["person"] }],
                  },
                  {
                    shotId: "story-1",
                    status: "failed",
                    reason: "Mink AI could not check this photograph in time.",
                    redraws: [{ attempt: "one", problems: [] }],
                  },
                ],
              },
              products: {
                failed: [],
                redraws: {
                  p1: [{ attempt: 1, problems: ["poor_crop"] }],
                  p2: "junk",
                },
              },
            },
          }),
        ],
      ],
    });
    const claimed = await claimRevampJob(REVAMP_ID);
    expect(claimed?.job.usage).toEqual({
      ...ZERO_REVAMP_USAGE,
      images: 3,
      calls: {
        "gemini-3-pro-image": { rateLimited: 2, timeouts: 0 },
        "gemini-3.8-flash": { rateLimited: 0, timeouts: 1 },
      },
    });
    expect(claimed?.job.result?.photos?.outcomes).toEqual([
      {
        shotId: "hero-1",
        status: "generated",
        reason: null,
        redraws: [{ attempt: 1, problems: ["person"] }],
      },
      // An outcome whose redraws cannot be read keeps everything else.
      {
        shotId: "story-1",
        status: "failed",
        reason: "Mink AI could not check this photograph in time.",
      },
    ]);
    expect(claimed?.job.result?.products).toEqual({
      failed: [],
      redraws: { p1: [{ attempt: 1, problems: ["poor_crop"] }] },
    });
  });
});

describe("★★ a finished job's photo claim is given back once (jobs-3)", () => {
  const settledRow = (units: string[]) => ({
    id: REVAMP_ID,
    store_id: STORE_ID,
    hold: { units },
  });

  it("clears the record, then gives back the units no stored image covers", async () => {
    holder.db = makeDbMock({
      executeQueue: [
        [settledRow(["anchor:anchor", "slot:hero-1", "slot:story-1"])],
      ],
      selectQueue: [[{ role: "anchor", slotId: "anchor" }]],
    });
    await expect(settleFinishedPhotoHolds()).resolves.toBe(2);
    expect(holder.release).toHaveBeenCalledWith(STORE_ID, 2);
    const statement = sqlText(holder.db.calls.execute[0]);
    // ★ Only finished jobs: a queued or running one belongs to its runner.
    expect(statement).toContain(
      "status IN ('failed', 'cancelled', 'ready', 'superseded')",
    );
    expect(statement).not.toContain("'running'");
    expect(statement).toContain("- 'photoHold'");
    expect(statement).toContain("FOR UPDATE SKIP LOCKED");
    // The images are read for the job's own store.
    expect(sqlParamValues(holder.db.calls.where[0])).toEqual(
      expect.arrayContaining([REVAMP_ID, STORE_ID]),
    );
  });

  it("scopes a status read's settle to that revamp and its store", async () => {
    holder.db = makeDbMock({ executeQueue: [[]] });
    await settleFinishedPhotoHolds({ revampId: REVAMP_ID, storeId: STORE_ID });
    expect(sqlParamValues(holder.db.calls.execute[0])).toEqual(
      expect.arrayContaining([REVAMP_ID, STORE_ID]),
    );
    expect(holder.release).not.toHaveBeenCalled();
  });

  it("★★ counts a photo parked for its review as its shot's, so it is not given back", async () => {
    holder.db = makeDbMock({
      executeQueue: [
        [settledRow(["anchor:anchor", "slot:hero-1", "slot:story-1"])],
      ],
      selectQueue: [
        [
          { role: "anchor", slotId: "anchor" },
          // Drawn and paid for, waiting on its review when the runner died.
          { role: "slot", slotId: "hero-1~review" },
        ],
      ],
    });
    await expect(settleFinishedPhotoHolds()).resolves.toBe(1);
    expect(holder.release).toHaveBeenCalledWith(STORE_ID, 1);
  });

  it("gives back nothing when every unit was drawn, and never throws", async () => {
    holder.db = makeDbMock({
      executeQueue: [[settledRow(["slot:hero-1"])]],
      selectQueue: [[{ role: "slot", slotId: "hero-1" }]],
    });
    await expect(settleFinishedPhotoHolds()).resolves.toBe(0);
    expect(holder.release).not.toHaveBeenCalled();
    holder.db!.db.execute = vi.fn(async () => {
      throw new Error("connection terminated");
    });
    await expect(settleFinishedPhotoHolds()).resolves.toBe(0);
  });

  it("★ the sweep settles the claims finished jobs still hold", async () => {
    holder.db = makeDbMock({
      executeQueue: [[], [], [], [settledRow(["product:p1", "product:p2"])]],
      selectQueue: [[], [{ role: "product", slotId: "p1" }]],
    });
    await sweepStalledRevamps(5);
    expect(holder.release).toHaveBeenCalledWith(STORE_ID, 1);
  });

  it("★ a status read of a finished job that still holds a claim settles it", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            ...rawRow({
              status: "cancelled",
              errorCode: "cancelled",
              result: { photoHold: { units: ["slot:hero-1", "slot:story-1"] } },
            }),
            noLiveHolder: true,
          },
        ],
        [],
      ],
      executeQueue: [[settledRow(["slot:hero-1", "slot:story-1"])]],
    });
    await readRevampStatus(actor, REVAMP_ID);
    expect(holder.release).toHaveBeenCalledWith(STORE_ID, 2);
  });
});

// ---------------------------------------------------------------------------

describe("finishRevampReady", () => {
  const finish = (credits = 12) =>
    finishRevampReady({
      revampId: REVAMP_ID,
      leaseToken: TOKEN,
      draftId: DRAFT_ID,
      credits,
      result: { stored: storedPlan(), checked: true },
      usage: { ...ZERO_REVAMP_USAGE, inputTokens: 900 },
    });

  it("★ returns false when the lease is gone and supersedes nothing", async () => {
    holder.db = makeDbMock({ returningQueue: [[]] });
    await expect(finish()).resolves.toBe(false);
    expect(holder.db.calls.update).toHaveLength(1);
  });

  it("★ marks the job ready and, in the same transaction, supersedes the parent and the conversation's other ready unapplied cards", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [
          {
            id: REVAMP_ID,
            storeId: STORE_ID,
            parentId: OTHER_ID,
            conversationId: CONVERSATION_ID,
          },
        ],
        [{ id: OTHER_ID }],
        [{ id: "older-card" }],
      ],
    });
    await expect(finish()).resolves.toBe(true);
    const [ready, parent, others] = holder.db.calls.set;
    expect(ready).toMatchObject({
      status: "ready",
      step: "card",
      draftId: DRAFT_ID,
      leaseToken: null,
      leaseUntil: null,
      result: { stored: storedPlan(), checked: true },
    });
    expect(sqlText(ready.credits)).toContain("CASE WHEN");
    expect(parent).toMatchObject({
      status: "superseded",
      supersededBy: REVAMP_ID,
    });
    expect(others).toMatchObject({
      status: "superseded",
      supersededBy: REVAMP_ID,
    });
  });

  it("skips the supersede writes when there is no parent and no conversation", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [
          {
            id: REVAMP_ID,
            storeId: STORE_ID,
            parentId: null,
            conversationId: null,
          },
        ],
      ],
    });
    await expect(finish()).resolves.toBe(true);
    expect(holder.db.calls.update).toHaveLength(1);
  });

  it("bounds the credits to the card ceiling", async () => {
    holder.db = makeDbMock({ returningQueue: [[]] });
    await finish(999);
    expect(sqlParamValues(holder.db.calls.set[0].credits)).toContain(200);
  });

  it("refuses a draft id that is not a UUID", async () => {
    await expect(
      finishRevampReady({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        draftId: "draft",
        credits: 0,
        result: {},
        usage: ZERO_REVAMP_USAGE,
      }),
    ).rejects.toThrow("invalid_revamp_draft");
  });
});

// ---------------------------------------------------------------------------

describe("failing and cancelling", () => {
  it("stores a closed code and a bounded detail; an unknown code becomes internal", async () => {
    // The made card is looked for first (none here), then the job fails.
    holder.db = makeDbMock({
      returningQueue: [[], [{ id: REVAMP_ID, storeId: STORE_ID }]],
    });
    expect(
      await failRevampJob({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        code: "made_up" as never,
        detail: `${"y".repeat(5_000)}`,
      }),
    ).toBe("failed");
    expect(sqlText(holder.db.calls.where[0])).toContain("mink_drafts");
    const set = holder.db.calls.set[1];
    expect(set.status).toBe("failed");
    expect(set.errorCode).toBe("internal");
    expect(set.errorDetail).toHaveLength(2_000);
    expect(set.leaseToken).toBeNull();
  });

  it("★ with no token, fails only a job nobody holds a live lease on", async () => {
    holder.db = makeDbMock({ returningQueue: [[], []] });
    expect(
      await failRevampJob({
        revampId: REVAMP_ID,
        leaseToken: null,
        code: "not_allowed",
        detail: "",
      }),
    ).toBeNull();
    expect(holder.db.calls.set[1].errorCode).toBe("not_allowed");
    expect(holder.db.calls.set[1].errorDetail).toBe("no_detail");
    // ★ Both writes carry the no-live-holder test (the parked token counts as
    //   nobody), never a lease token of their own.
    for (const where of holder.db.calls.where) {
      expect(sqlParamValues(where)).toContain(PARKED);
    }
  });

  it("marks a running job cancelled under its lease", async () => {
    // The made card is looked for first (none here), then the job stops.
    holder.db = makeDbMock({ returningQueue: [[], [{ id: REVAMP_ID }]] });
    expect(await markRevampCancelled(REVAMP_ID, TOKEN)).toBe("cancelled");
    expect(sqlText(holder.db.calls.where[0])).toContain("mink_drafts");
    expect(holder.db.calls.set[1]).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
      leaseToken: null,
    });
    expect(holder.db.calls.set[1]).not.toHaveProperty("usage");
  });

  it("★ a failure and a stop record what the runner spent since its last save (L2-F)", async () => {
    const spent = { ...ZERO_REVAMP_USAGE, images: 2, estimatedCostMicroUsd: 9 };
    holder.db = makeDbMock({
      returningQueue: [
        [],
        [{ id: REVAMP_ID, storeId: STORE_ID }],
        [],
        [{ id: REVAMP_ID }],
      ],
    });
    expect(
      await failRevampJob({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        code: "limit_reached",
        detail: "the store's day is full",
        usage: spent,
      }),
    ).toBe("failed");
    expect(holder.db.calls.set[1]).toMatchObject({
      status: "failed",
      usage: spent,
    });
    expect(await markRevampCancelled(REVAMP_ID, TOKEN, spent)).toBe(
      "cancelled",
    );
    expect(holder.db.calls.set[3]).toMatchObject({
      status: "cancelled",
      usage: spent,
    });
  });

  it("★★ finishes a job whose card was already made as ready, under the same lease", async () => {
    holder.db = makeDbMock({
      returningQueue: [[rawRow({ status: "ready", draftId: REVAMP_ID })]],
    });
    expect(await markRevampCancelled(REVAMP_ID, TOKEN)).toBe("ready");
    expect(holder.db.calls.set[0]).toMatchObject({
      status: "ready",
      leaseToken: null,
      errorCode: null,
    });
    // ★ Under the runner's own fence: this job, its lease token, still running.
    expect(sqlParamValues(holder.db.calls.where[0])).toEqual(
      expect.arrayContaining([REVAMP_ID, TOKEN, "running"]),
    );
    const where = sqlText(holder.db.calls.where[0]);
    expect(where).toContain("'card'");
    expect(where).toContain("mink_drafts");
    expect(
      holder.db.calls.set.some((set: any) => set.status === "cancelled"),
    ).toBe(false);
  });

  it("writes nothing and says so when the lease is gone", async () => {
    holder.db = makeDbMock({ returningQueue: [[], []] });
    expect(await markRevampCancelled(REVAMP_ID, TOKEN)).toBeNull();
  });

  it("★★ a failure finishes a job whose card was already made as ready, under the same lease", async () => {
    holder.db = makeDbMock({
      returningQueue: [[rawRow({ status: "ready", draftId: REVAMP_ID })]],
    });
    expect(
      await failRevampJob({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        code: "not_allowed",
        detail: "requester may not draft Website Builder changes",
      }),
    ).toBe("ready");
    expect(holder.db.calls.set[0]).toMatchObject({
      status: "ready",
      leaseToken: null,
      errorCode: null,
    });
    // ★ Under the runner's own fence: this job, its lease token, still running.
    expect(sqlParamValues(holder.db.calls.where[0])).toEqual(
      expect.arrayContaining([REVAMP_ID, TOKEN, "running"]),
    );
    const where = sqlText(holder.db.calls.where[0]);
    expect(where).toContain("'card'");
    expect(where).toContain("mink_drafts");
    expect(
      holder.db.calls.set.some((set: any) => set.status === "failed"),
    ).toBe(false);
  });

  it("★ cancels a queued revamp at once and says so", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        // No card was made, so the job is not finished as ready.
        [],
        [
          rawRow({
            status: "cancelled",
            errorCode: "cancelled",
            finishedAt: "2026-10-21 05:02:00+00",
          }),
        ],
      ],
    });
    const view = await cancelRevamp(actor, REVAMP_ID);
    expect(view).toMatchObject({
      status: "cancelled",
      error: REVAMP_ERROR_MESSAGES.cancelled,
      finishedAt: "2026-10-21 05:02:00+00",
    });
    expect(holder.db.calls.update).toHaveLength(2);
  });

  it("★ asks a running revamp to stop when a runner holds its lease", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [],
        [],
        [
          rawRow({
            status: "running",
            leaseToken: TOKEN,
            cancelRequestedAt: "2026-10-21 05:02:00+00",
          }),
        ],
      ],
    });
    const view = await cancelRevamp(actor, REVAMP_ID);
    expect(view?.status).toBe("running");
    expect(holder.db.calls.set[2]).not.toHaveProperty("status");
    expect(sqlText(holder.db.calls.set[2].cancelRequestedAt)).toContain(
      "coalesce",
    );
  });

  it("returns a finished revamp unchanged, and null for someone else's", async () => {
    holder.db = makeDbMock({
      returningQueue: [[], [], []],
      selectQueue: [[rawRow({ status: "ready", draftId: DRAFT_ID })]],
    });
    expect((await cancelRevamp(actor, REVAMP_ID))?.status).toBe("ready");
    holder.db = makeDbMock({
      returningQueue: [[], [], []],
      selectQueue: [[]],
    });
    await expect(cancelRevamp(actor, REVAMP_ID)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("★★ a failed redesign gives its day's start back (B5)", () => {
  const CREATED = "2026-10-21 05:00:00.123456+00";
  const failedRow = (overrides: Record<string, unknown> = {}) => ({
    id: REVAMP_ID,
    storeId: STORE_ID,
    createdAt: CREATED,
    cancelRequestedAt: null,
    ...overrides,
  });

  it("names the store's day of starts, defined once beside the job", () => {
    expect(revampStartLimit(STORE_ID)).toEqual({
      key: `mink-revamp-starts:${STORE_ID}`,
      max: REVAMP_LIMITS.startsPerStorePerDay,
      windowSeconds: 86_400,
    });
  });

  it("★★ a failure gives the start back once, to the window that counted it", async () => {
    holder.db = makeDbMock({ returningQueue: [[], [failedRow()]] });
    await expect(
      failRevampJob({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        code: "photos_unavailable",
        detail: "x",
      }),
    ).resolves.toBe("failed");
    expect(holder.releaseStart).toHaveBeenCalledTimes(1);
    expect(holder.releaseStart).toHaveBeenCalledWith(
      [revampStartLimit(STORE_ID)],
      { claimedAt: CREATED },
    );
  });

  it.each(["photos_unavailable", "photos_failed"] as const)(
    "★★ a shoot that ends for good as %s is stored as itself and gives its start back alike",
    async (code) => {
      holder.db = makeDbMock({ returningQueue: [[], [failedRow()]] });
      await expect(
        failRevampJob({
          revampId: REVAMP_ID,
          leaseToken: TOKEN,
          code,
          detail: "1 of 1 photographs could not be drawn or cropped.",
        }),
      ).resolves.toBe("failed");
      // ★ A closed code, so never read back as `internal`.
      expect(holder.db.calls.set[1]).toMatchObject({
        status: "failed",
        errorCode: code,
      });
      expect(holder.releaseStart).toHaveBeenCalledTimes(1);
      expect(holder.releaseStart).toHaveBeenCalledWith(
        [revampStartLimit(STORE_ID)],
        { claimedAt: CREATED },
      );
    },
  );

  it("★ a job the merchant asked to stop keeps its start, as a cancelled one does", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [],
        [failedRow({ cancelRequestedAt: "2026-10-21 05:01:00+00" })],
      ],
    });
    await failRevampJob({
      revampId: REVAMP_ID,
      leaseToken: TOKEN,
      code: "internal",
      detail: "x",
    });
    holder.db = makeDbMock({ returningQueue: [[], [{ id: REVAMP_ID }]] });
    await expect(markRevampCancelled(REVAMP_ID, TOKEN)).resolves.toBe(
      "cancelled",
    );
    expect(holder.releaseStart).not.toHaveBeenCalled();
  });

  it("★ gives nothing back when the failure did not land, or a made card ended ready", async () => {
    // The lease is gone: nothing was failed.
    holder.db = makeDbMock({ returningQueue: [[], []] });
    await failRevampJob({
      revampId: REVAMP_ID,
      leaseToken: TOKEN,
      code: "internal",
      detail: "x",
    });
    // The card was made: the job ends ready, never failed.
    holder.db = makeDbMock({
      returningQueue: [
        [rawRow({ status: "ready", step: "card", draftId: REVAMP_ID })],
      ],
    });
    await expect(
      failRevampJob({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        code: "internal",
        detail: "x",
      }),
    ).resolves.toBe("ready");
    expect(holder.releaseStart).not.toHaveBeenCalled();
  });

  it("★ a row it cannot read is not given back, and nothing throws", async () => {
    holder.db = makeDbMock({
      returningQueue: [[], [failedRow({ createdAt: null })]],
    });
    await expect(
      failRevampJob({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        code: "internal",
        detail: "x",
      }),
    ).resolves.toBe("failed");
    expect(holder.releaseStart).not.toHaveBeenCalled();
  });

  it("★ a failure that rolls back gives nothing back", async () => {
    holder.db = makeDbMock({ returningQueue: [[]] });
    holder.db.db.update = vi.fn(() => {
      throw new Error("connection terminated");
    });
    await expect(
      failRevampJob({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        code: "internal",
        detail: "x",
      }),
    ).rejects.toThrow("connection terminated");
    expect(holder.releaseStart).not.toHaveBeenCalled();
  });

  it("★ the status poll and the sweep give back what they fail", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            ...rawRow({ status: "running", attempts: 4 }),
            noLiveHolder: true,
            pastCeiling: false,
          },
        ],
      ],
      returningQueue: [
        [],
        [
          rawRow({
            status: "failed",
            errorCode: "out_of_attempts",
            attempts: 4,
          }),
        ],
      ],
    });
    await readRevampStatus(actor, REVAMP_ID);
    expect(holder.releaseStart).toHaveBeenCalledTimes(1);
    expect(holder.releaseStart).toHaveBeenLastCalledWith(
      [revampStartLimit(STORE_ID)],
      { claimedAt: CREATED },
    );
    holder.db = makeDbMock({
      selectQueue: [[]],
      executeQueue: [
        [
          { id: OTHER_ID, store_id: STORE_ID, created_at: CREATED },
          { id: "not-a-job", store_id: STORE_ID, created_at: CREATED },
        ],
        [],
        [],
      ],
    });
    await expect(sweepStalledRevamps(5)).resolves.toEqual({
      kicked: 0,
      failed: 2,
    });
    // One back for the readable row; the unreadable one is logged, not guessed.
    expect(holder.releaseStart).toHaveBeenCalledTimes(2);
    const exhausted = sqlText(holder.db.calls.execute[0]);
    expect(exhausted).toContain(
      "RETURNING r.id, r.store_id, r.created_at::text",
    );
  });
});

// ---------------------------------------------------------------------------

describe("readRevampStatus", () => {
  const owned = (overrides: Record<string, unknown>, noLiveHolder = false) => ({
    ...rawRow(overrides),
    noLiveHolder,
  });

  it("maps a failed job's closed code to its sentence, never the detail", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          owned({
            status: "failed",
            errorCode: "photos_unavailable",
            errorDetail: "vertex said: secret internals",
          }),
        ],
      ],
    });
    const view = await readRevampStatus(actor, REVAMP_ID);
    expect(view?.error).toBe(REVAMP_ERROR_MESSAGES.photos_unavailable);
    expect(JSON.stringify(view)).not.toContain("secret internals");
  });

  it("★★ says a shoot whose photographs failed their checks stopped for that, never that the service was busy", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          owned({
            status: "failed",
            errorCode: "photos_failed",
            errorDetail:
              "1 of 1 photographs could not be drawn or cropped from the shoot.",
          }),
        ],
      ],
    });
    const view = await readRevampStatus(actor, REVAMP_ID);
    expect(view?.status).toBe("failed");
    expect(view?.error).toBe(REVAMP_ERROR_MESSAGES.photos_failed);
    expect(view?.error).not.toBe(REVAMP_ERROR_MESSAGES.photos_unavailable);
    expect(JSON.stringify(view)).not.toContain("could not be drawn");
  });

  it("★ reads an unknown code as internal", async () => {
    holder.db = makeDbMock({
      selectQueue: [[owned({ status: "failed", errorCode: "brand_new_code" })]],
    });
    expect((await readRevampStatus(actor, REVAMP_ID))?.error).toBe(
      REVAMP_ERROR_MESSAGES.internal,
    );
  });

  it("builds the review for a ready job, and for a superseded one the merchant applied", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          owned({
            status: "ready",
            draftId: DRAFT_ID,
            result: { stored: storedPlan(), checked: true },
          }),
        ],
        [
          owned({
            status: "superseded",
            supersededBy: OTHER_ID,
            appliedAt: "2026-10-21 06:00:00+00",
            result: { stored: storedPlan() },
          }),
        ],
        [
          owned({
            status: "superseded",
            supersededBy: OTHER_ID,
            result: { stored: storedPlan() },
          }),
        ],
      ],
    });
    const ready = await readRevampStatus(actor, REVAMP_ID);
    expect(ready?.review?.summary).toBe("A warm store for cold-pressed oil.");
    expect(ready?.draftId).toBe(DRAFT_ID);
    const applied = await readRevampStatus(actor, REVAMP_ID);
    expect(applied?.supersededBy).toBe(OTHER_ID);
    expect(applied?.review).not.toBeNull();
    const replaced = await readRevampStatus(actor, REVAMP_ID);
    expect(replaced?.review).toBeNull();
  });

  it("★ adds what Apply did differently from the plan to the card's notes", async () => {
    const note =
      'Seeds went on your shop without a category, because your store has no "spices" category.';
    holder.db = makeDbMock({
      selectQueue: [
        [
          owned({
            status: "ready",
            draftId: DRAFT_ID,
            appliedAt: "2026-10-21 06:00:00+00",
            applySnapshot: { version: 1, notes: [note, "", 7] },
            result: { stored: storedPlan() },
          }),
        ],
        [
          owned({
            status: "ready",
            draftId: DRAFT_ID,
            result: { stored: storedPlan() },
          }),
        ],
      ],
    });
    const applied = await readRevampStatus(actor, REVAMP_ID);
    expect(applied?.review?.notes.at(-1)).toBe(note);
    expect(
      applied?.review?.notes.filter((entry) => entry === note),
    ).toHaveLength(1);
    const unapplied = await readRevampStatus(actor, REVAMP_ID);
    expect(unapplied?.review?.notes).not.toContain(note);
  });

  it("★ fails an active job whose attempts ran out with nobody working on it", async () => {
    holder.db = makeDbMock({
      selectQueue: [[owned({ status: "running", attempts: 4 }, true)]],
      returningQueue: [
        // No card was made, so the job is not finished as ready.
        [],
        [
          rawRow({
            status: "failed",
            errorCode: "out_of_attempts",
            attempts: 4,
          }),
        ],
      ],
    });
    const view = await readRevampStatus(actor, REVAMP_ID);
    expect(view?.status).toBe("failed");
    expect(view?.error).toBe(REVAMP_ERROR_MESSAGES.out_of_attempts);
    expect(holder.db.calls.set[1]).toMatchObject({
      status: "failed",
      errorCode: "out_of_attempts",
    });
    // ★ Which limit ended it is recorded for the logs (B8).
    const detail = sqlText(holder.db.calls.set[1].errorDetail);
    expect(detail).toContain("'attempts_exhausted'");
    expect(detail).toContain("'run_ceiling'");
  });

  it("★★ fails a job past its wall-clock ceiling though its failures are under the limit (B8)", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            ...owned({ status: "running", attempts: 1 }, true),
            pastCeiling: true,
          },
        ],
      ],
      returningQueue: [
        [],
        [rawRow({ status: "failed", errorCode: "out_of_attempts" })],
      ],
    });
    const view = await readRevampStatus(actor, REVAMP_ID);
    expect(view?.status).toBe("failed");
    expect(view?.error).toBe(REVAMP_ERROR_MESSAGES.out_of_attempts);
    // ★ The settling write holds the same test, so a runner that claimed the
    //   job in between is never failed under it.
    const settle = sqlText(holder.db.calls.where[2]);
    expect(settle).toContain(">=");
    expect(settle).toContain("'firstClaimedAt'");
    expect(sqlParamValues(holder.db.calls.where[2])).toContain(
      REVAMP_RUN_CEILING_MS,
    );
    // The select reads the ceiling beside the row.
    expect(sqlParamValues(holder.db.calls.select[0].pastCeiling)).toContain(
      REVAMP_RUN_CEILING_MS,
    );
  });

  it("★ leaves a job inside its ceiling and its failures alone", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            ...owned({ status: "running", attempts: 3 }, true),
            pastCeiling: false,
          },
        ],
      ],
    });
    expect((await readRevampStatus(actor, REVAMP_ID))?.status).toBe("running");
    expect(holder.db.calls.update).toHaveLength(0);
  });

  it("★ cancels a stop request no runner will ever see", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          owned(
            { status: "running", cancelRequestedAt: "2026-10-21 05:00:30+00" },
            true,
          ),
        ],
      ],
      returningQueue: [
        [],
        [rawRow({ status: "cancelled", errorCode: "cancelled" })],
      ],
    });
    expect((await readRevampStatus(actor, REVAMP_ID))?.status).toBe(
      "cancelled",
    );
  });

  it("★ says when a stop is recorded and a live runner has yet to see it", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          owned({
            status: "running",
            leaseToken: TOKEN,
            cancelRequestedAt: "2026-10-21 05:00:30+00",
          }),
        ],
        [owned({ status: "running", leaseToken: TOKEN })],
      ],
    });
    expect((await readRevampStatus(actor, REVAMP_ID))?.cancelRequested).toBe(
      true,
    );
    expect((await readRevampStatus(actor, REVAMP_ID))?.cancelRequested).toBe(
      false,
    );
  });

  it("★★ carries Undo's own answer once the redesign was undone, and only then", async () => {
    const undo = {
      restored: ["Home", "Header and footer"],
      kept: [{ label: "About", reason: "You changed it after Apply." }],
    };
    holder.db = makeDbMock({
      selectQueue: [
        [
          owned({
            status: "ready",
            draftId: DRAFT_ID,
            appliedAt: "2026-10-21 06:00:00+00",
            undoneAt: "2026-10-21 07:00:00+00",
            applySnapshot: { version: 1, undo },
          }),
        ],
        // Applied, not undone: whatever the snapshot holds is not an answer.
        [
          owned({
            status: "ready",
            draftId: DRAFT_ID,
            appliedAt: "2026-10-21 06:00:00+00",
            applySnapshot: { version: 1, undo },
          }),
        ],
        // Undone, but the stored answer cannot be read.
        [
          owned({
            status: "ready",
            draftId: DRAFT_ID,
            undoneAt: "2026-10-21 07:00:00+00",
            applySnapshot: { undo: { restored: "Home", kept: [{ label: 3 }] } },
          }),
        ],
      ],
    });
    expect((await readRevampStatus(actor, REVAMP_ID))?.undo).toEqual(undo);
    expect((await readRevampStatus(actor, REVAMP_ID))?.undo).toBeNull();
    // ★ An answer this revision cannot read is no answer, never an empty one
    //   the card would show as "nothing was put back".
    expect((await readRevampStatus(actor, REVAMP_ID))?.undo).toBeNull();
  });

  it("★ keeps only the readable lines of Undo's answer", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          owned({
            status: "ready",
            draftId: DRAFT_ID,
            undoneAt: "2026-10-21 07:00:00+00",
            applySnapshot: {
              undo: {
                restored: ["Home", 7, "  "],
                kept: [{ label: "About", reason: "Yours now." }, { label: 3 }],
              },
            },
          }),
        ],
      ],
    });
    expect((await readRevampStatus(actor, REVAMP_ID))?.undo).toEqual({
      restored: ["Home"],
      kept: [{ label: "About", reason: "Yours now." }],
    });
  });

  it("leaves a job with a live lease alone", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [owned({ status: "running", attempts: 4, leaseToken: TOKEN })],
      ],
    });
    expect((await readRevampStatus(actor, REVAMP_ID))?.status).toBe("running");
    expect(holder.db.calls.update).toHaveLength(0);
  });

  it("★ rebuilds an unreadable progress list from the step instead of throwing", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [owned({ status: "running", step: "photos", progress: "garbage" })],
      ],
    });
    const view = await readRevampStatus(actor, REVAMP_ID);
    expect(view?.progress.map((item) => item.state)).toEqual([
      "done",
      "done",
      "done",
      "running",
      "waiting",
      "waiting",
      "waiting",
      "waiting",
    ]);
  });

  it("★ renders a row whose request and result cannot be read", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          owned({
            status: "ready",
            draftId: DRAFT_ID,
            request: "not an object",
            result: { stored: { schemaVersion: 1 } },
          }),
        ],
      ],
    });
    const view = await readRevampStatus(actor, REVAMP_ID);
    expect(view?.status).toBe("ready");
    expect(view?.review).toBeNull();
  });

  it("★ refuses a requester who lost the Website Builder", async () => {
    await expect(
      readRevampStatus(
        { ...actor, isSuperadmin: false, permissions: { dashboard: ["view"] } },
        REVAMP_ID,
      ),
    ).rejects.toBeInstanceOf(MinkRequestError);
  });

  it("returns null for someone else's revamp or a malformed id", async () => {
    holder.db = makeDbMock({ selectQueue: [[]] });
    await expect(readRevampStatus(actor, REVAMP_ID)).resolves.toBeNull();
    await expect(readRevampStatus(actor, "x")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("reads", () => {
  it("parses every column defensively", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          rawRow({
            status: "running",
            step: "photos",
            request: { kind: "full", brief: "broken" },
            snapshot: { storeId: "another-store", pages: [] },
            plan: {
              stage: "compiled",
              plan: { pages: [], shots: [], bindings: [] },
              productPhotoKeys: ["p1", 2],
            },
            result: {
              photos: {
                outcomes: [
                  { shotId: "hero", status: "generated", reason: null },
                  { shotId: "x", status: "weird" },
                ],
              },
              products: { failed: [{ key: "p1", reason: "Blurry" }, "x"] },
              checked: "yes",
            },
            usage: { inputTokens: 12, outputTokens: "lots" },
            leaseUntil: new Date("2026-10-21T05:05:00.000Z"),
          }),
        ],
      ],
    });
    const job = await readRevampJob(REVAMP_ID);
    expect(job).not.toBeNull();
    // An unreadable request stands in as an empty one; nothing throws.
    expect(job!.request.brief.business).toBe("");
    expect(job!.request.products).toEqual([]);
    // A snapshot for another store is never handed on.
    expect(job!.snapshot).toBeNull();
    expect(job!.plan).toMatchObject({
      stage: "compiled",
      productPhotoKeys: ["p1"],
    });
    expect(job!.result).toEqual({
      photos: {
        outcomes: [{ shotId: "hero", status: "generated", reason: null }],
      },
      products: { failed: [{ key: "p1", reason: "Blurry" }] },
    });
    expect(job!.usage).toEqual({ ...ZERO_REVAMP_USAGE, inputTokens: 12 });
    expect(job!.leaseUntil).toBe("2026-10-21T05:05:00.000Z");
  });

  it("★ reads the claim's clock and count, dropping values it cannot trust (B8)", async () => {
    for (const [stored, read] of [
      [
        { firstClaimedAt: 1_760_000_000_000, interruptions: 2 },
        { firstClaimedAt: 1_760_000_000_000, interruptions: 2 },
      ],
      [{ firstClaimedAt: "soon", interruptions: 1.5 }, {}],
      [{ firstClaimedAt: -5, interruptions: 0 }, {}],
    ] as const) {
      holder.db = makeDbMock({
        selectQueue: [[rawRow({ status: "running", result: stored })]],
      });
      const job = await readRevampJob(REVAMP_ID);
      expect(job!.result ?? {}).toEqual(read);
    }
  });

  it("★ keeps a paid plan's copy from before its budget cut, and drops one it cannot read (f-4)", async () => {
    const cut = { pages: [], shots: [], bindings: [] };
    const whole = { pages: [{ slug: "" }], shots: [], bindings: [] };
    holder.db = makeDbMock({
      selectQueue: [
        [
          rawRow({
            plan: {
              stage: "compiled",
              plan: cut,
              productPhotoKeys: [],
              unfitted: whole,
            },
          }),
        ],
        [
          rawRow({
            plan: {
              stage: "compiled",
              plan: cut,
              productPhotoKeys: [],
              unfitted: { pages: "broken" },
            },
          }),
        ],
      ],
    });
    expect((await readRevampJob(REVAMP_ID))?.plan).toEqual({
      stage: "compiled",
      plan: cut,
      productPhotoKeys: [],
      unfitted: whole,
    });
    // ★ The cut plan is what every later step works from: a broken copy
    //   loses only itself.
    expect((await readRevampJob(REVAMP_ID))?.plan).toEqual({
      stage: "compiled",
      plan: cut,
      productPhotoKeys: [],
    });
  });

  it("reads a raw plan column and a readable request", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          rawRow({
            plan: { stage: "raw", raw: { x: 1 }, repairs: 2, issues: ["a", 3] },
          }),
        ],
      ],
    });
    const job = await readRevampForActor(actor, REVAMP_ID);
    expect(job?.plan).toEqual({
      stage: "raw",
      raw: { x: 1 },
      repairs: 2,
      issues: ["a"],
    });
    expect(job?.request).toEqual(request());
  });

  it("★★ keeps a failed repair's mark on a raw plan, and only a true one (L2-B)", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          rawRow({
            plan: {
              stage: "raw",
              raw: { x: 1 },
              repairs: 1,
              issues: [],
              repairFailed: true,
            },
          }),
        ],
        [
          rawRow({
            plan: {
              stage: "raw",
              raw: { x: 1 },
              repairs: 1,
              issues: [],
              repairFailed: "yes",
            },
          }),
        ],
      ],
    });
    expect((await readRevampJob(REVAMP_ID))?.plan).toEqual({
      stage: "raw",
      raw: { x: 1 },
      repairs: 1,
      issues: [],
      repairFailed: true,
    });
    expect((await readRevampJob(REVAMP_ID))?.plan).toEqual({
      stage: "raw",
      raw: { x: 1 },
      repairs: 1,
      issues: [],
    });
  });

  it("returns null when nothing matches", async () => {
    holder.db = makeDbMock({ selectQueue: [[], []] });
    await expect(readRevampJob(REVAMP_ID)).resolves.toBeNull();
    await expect(readRevampForActor(actor, REVAMP_ID)).resolves.toBeNull();
  });

  it("finds the ready job behind a draft, in the store", async () => {
    holder.db = makeDbMock({
      selectQueue: [[rawRow({ status: "ready", draftId: DRAFT_ID })], []],
    });
    expect((await findReadyRevampByDraft(STORE_ID, DRAFT_ID))?.draftId).toBe(
      DRAFT_ID,
    );
    await expect(
      findReadyRevampByDraft(STORE_ID, DRAFT_ID),
    ).resolves.toBeNull();
    await expect(findReadyRevampByDraft("store", DRAFT_ID)).resolves.toBeNull();
  });

  it("lists a conversation's revamps newest first, at most five, with a short summary", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            id: REVAMP_ID,
            kind: "refine",
            status: "ready",
            draftId: DRAFT_ID,
            appliedAt: null,
            publishedAt: null,
            undoneAt: null,
            createdAt: "2026-10-21 06:00:00+00",
            summary: `  Warmer\n colours ${"z".repeat(400)}`,
            cancelRequested: false,
          },
          {
            id: OTHER_ID,
            kind: "full",
            status: "made_up",
            draftId: null,
            appliedAt: null,
            publishedAt: null,
            undoneAt: null,
            createdAt: "2026-10-21 05:00:00+00",
            summary: null,
            cancelRequested: false,
          },
        ],
      ],
    });
    const entries = await listConversationRevamps({
      storeId: STORE_ID,
      adminId: "owner-1",
      conversationId: CONVERSATION_ID,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: REVAMP_ID,
      kind: "refine",
      status: "ready",
      draftId: DRAFT_ID,
      cancelRequested: false,
    });
    expect(entries[0].summary?.startsWith("Warmer colours")).toBe(true);
    expect(entries[0].summary?.length).toBe(280);
    expect(holder.db.calls.limit).toEqual([5]);
  });

  it("★ says whether a conversation's revamp was asked to stop, read with the list", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            id: REVAMP_ID,
            kind: "full",
            status: "running",
            draftId: null,
            appliedAt: null,
            publishedAt: null,
            undoneAt: null,
            createdAt: "2026-10-25 10:30:25+00",
            summary: null,
            cancelRequested: true,
          },
          {
            id: OTHER_ID,
            kind: "full",
            status: "queued",
            draftId: null,
            appliedAt: null,
            publishedAt: null,
            undoneAt: null,
            createdAt: "2026-10-25 10:00:00+00",
            summary: null,
            // A driver that answers anything but true is not a stop.
            cancelRequested: "t",
          },
        ],
      ],
    });
    const entries = await listConversationRevamps({
      storeId: STORE_ID,
      adminId: "owner-1",
      conversationId: CONVERSATION_ID,
    });
    expect(entries.map((entry) => entry.cancelRequested)).toEqual([
      true,
      false,
    ]);
    // One read: the flag is computed in SQL beside the row, never a second query.
    // (Rendered as Postgres receives it: `sqlText` drops column references.)
    expect(holder.db.calls.select).toHaveLength(1);
    const flag = new PgDialect().sqlToQuery(
      holder.db.calls.select[0].cancelRequested,
    ).sql;
    expect(flag).toBe('"mink_revamps"."cancel_requested_at" is not null');
  });

  it("returns no entries for malformed ids without querying", async () => {
    await expect(
      listConversationRevamps({
        storeId: STORE_ID,
        adminId: "",
        conversationId: CONVERSATION_ID,
      }),
    ).resolves.toEqual([]);
    expect(holder.db!.calls.select).toHaveLength(0);
  });

  it("counts the refinements of the whole tree", async () => {
    holder.db = makeDbMock({ executeQueue: [[{ count: 3 }], [{}]] });
    await expect(countRefinements(REVAMP_ID)).resolves.toBe(3);
    const text = sqlText(holder.db.calls.execute[0]);
    expect(text).toContain("WITH RECURSIVE");
    expect(text).toContain("NOT IN ('failed', 'cancelled')");
    await expect(countRefinements(REVAMP_ID)).resolves.toBe(0);
    await expect(countRefinements("x")).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("keeping a job moving", () => {
  it("★ kicks once the cooldown is claimed", async () => {
    holder.db = makeDbMock({ returningQueue: [[{ id: REVAMP_ID }]] });
    await expect(kickRevampIfStalled(REVAMP_ID)).resolves.toBe(true);
    expect(holder.kick).toHaveBeenCalledWith(REVAMP_ID);
    expect(sqlText(holder.db.calls.set[0].lastKickAt)).toBe("now()");
    const where = sqlText(holder.db.calls.where[0]);
    expect(where).toContain("coalesce(");
    expect(where).toContain("interval '1 millisecond'");
    // ★ A job past its ceiling is settled, never kicked (B8).
    expect(where).toContain("NOT (CASE WHEN jsonb_typeof(");
    expect(sqlParamValues(holder.db.calls.where[0])).toContain(
      REVAMP_RUN_CEILING_MS,
    );
  });

  it("★ does not kick inside the cooldown, or for a job somebody is working on", async () => {
    holder.db = makeDbMock({ returningQueue: [[]] });
    await expect(kickRevampIfStalled(REVAMP_ID)).resolves.toBe(false);
    expect(holder.kick).not.toHaveBeenCalled();
  });

  it("a stall check that fails costs the kick, never the poll", async () => {
    holder.db!.db.update = vi.fn(() => {
      throw new Error("connection terminated");
    });
    await expect(kickRevampIfStalled(REVAMP_ID)).resolves.toBe(false);
    expect(holder.kick).not.toHaveBeenCalled();
  });

  it("★ sweeps: fails exhausted jobs, settles unseen stops, kicks stalled ones", async () => {
    holder.db = makeDbMock({
      executeQueue: [
        [{ id: "exhausted-1" }],
        [{ id: "stopped-1" }],
        [{ id: REVAMP_ID }, { id: OTHER_ID }],
      ],
    });
    await expect(sweepStalledRevamps(5)).resolves.toEqual({
      kicked: 2,
      failed: 1,
    });
    expect(holder.kick).toHaveBeenCalledTimes(2);
    const [exhausted, stopped, stalled] = holder.db.calls.execute.map(sqlText);
    expect(exhausted).toContain("'out_of_attempts'");
    expect(exhausted).toContain("FOR UPDATE SKIP LOCKED");
    expect(stopped).toContain("'cancelled'");
    expect(stalled).toContain("last_kick_at = now()");
    // ★★ The ceiling ends a job in the sweep and keeps it from being kicked
    //   (B8), and says which limit it was.
    expect(exhausted).toContain(
      "attempts >= max_attempts OR (CASE WHEN jsonb_typeof(result -> 'firstClaimedAt')",
    );
    expect(exhausted).toContain("'run_ceiling'");
    expect(stalled).toContain(
      "AND NOT (CASE WHEN jsonb_typeof(result -> 'firstClaimedAt')",
    );
    expect(sqlParamValues(holder.db.calls.execute[0])).toContain(
      REVAMP_RUN_CEILING_MS,
    );
    // A made card is finished whichever limit ended its job.
    expect(sqlText(holder.db.calls.where[0])).toContain("'firstClaimedAt'");
  });

  it("bounds the kicks it asks for", async () => {
    holder.db = makeDbMock({ executeQueue: [[], [], []] });
    await sweepStalledRevamps(500);
    expect(sqlParamValues(holder.db.calls.execute[2])).toContain(25);
  });

  it("★★ hands a freed process slot to the oldest waiting revamp, never the one that just ran (jobs-1)", async () => {
    holder.db = makeDbMock({ executeQueue: [[{ id: OTHER_ID }]] });
    await expect(kickWaitingRevamp(REVAMP_ID)).resolves.toBe(1);
    expect(holder.kick).toHaveBeenCalledTimes(1);
    expect(holder.kick).toHaveBeenCalledWith(OTHER_ID);
    const statement = sqlText(holder.db.calls.execute[0]);
    expect(statement).toContain("last_kick_at = now()");
    expect(statement).toContain("FOR UPDATE SKIP LOCKED");
    expect(statement).toContain("attempts < max_attempts");
    expect(statement).toContain(
      "AND NOT (CASE WHEN jsonb_typeof(result -> 'firstClaimedAt')",
    );
    expect(statement).toContain("cancel_requested_at IS NULL");
    // ★ Not held to the poll's cooldown: the kick that was turned away a
    //   moment ago is exactly the one this hands the slot to.
    expect(statement).not.toContain("coalesce(last_kick_at");
    expect(statement).toContain("LIMIT 1");
    expect(sqlParamValues(holder.db.calls.execute[0])).toContain(REVAMP_ID);
  });

  it("hands nothing on when nothing waits, while Mink AI is off, or when the read fails", async () => {
    holder.db = makeDbMock({ executeQueue: [[]] });
    await expect(kickWaitingRevamp(REVAMP_ID)).resolves.toBe(0);
    holder.enabled = false;
    await expect(kickWaitingRevamp(REVAMP_ID)).resolves.toBe(0);
    holder.enabled = true;
    holder.db = makeDbMock();
    holder.db.db.execute = vi.fn(() => {
      throw new Error("connection terminated");
    });
    await expect(kickWaitingRevamp(REVAMP_ID)).resolves.toBe(0);
    expect(holder.kick).not.toHaveBeenCalled();
  });

  it("does nothing while Mink AI is switched off", async () => {
    holder.enabled = false;
    await expect(sweepStalledRevamps()).resolves.toEqual({
      kicked: 0,
      failed: 0,
    });
    expect(holder.db!.calls.execute).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("★★ a card a settlement finishes tells its requester, as the card step does (ops-4)", () => {
  // ★★ The notice opens the chat that holds the card (B20).
  const notice = revampReadyEvent({
    id: REVAMP_ID,
    storeId: STORE_ID,
    adminId: "owner-1",
    conversationId: CONVERSATION_ID,
  });
  const madeCard = (overrides: Record<string, unknown> = {}) =>
    rawRow({ status: "ready", step: "card", draftId: REVAMP_ID, ...overrides });
  const unheld = (overrides: Record<string, unknown>) => ({
    ...rawRow(overrides),
    noLiveHolder: true,
  });

  it("★ the claim that finds the card made", async () => {
    holder.db = makeDbMock({
      returningQueue: [
        [
          rawRow({
            status: "running",
            step: "card",
            request: { kind: "full", brief: 3 },
          }),
        ],
        [madeCard()],
      ],
    });
    await expect(claimRevampJob(REVAMP_ID)).resolves.toBeNull();
    expect(holder.recordEvent).toHaveBeenCalledTimes(1);
    expect(holder.recordEvent).toHaveBeenCalledWith(notice);
    expect(notice.payload).toEqual({
      url: `/dashboard?chat=${CONVERSATION_ID}`,
    });
  });

  it("★ a failure, and the runner's own Stop", async () => {
    holder.db = makeDbMock({ returningQueue: [[madeCard()]] });
    await expect(
      failRevampJob({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        code: "not_allowed",
        detail: "requester may not draft Website Builder changes",
      }),
    ).resolves.toBe("ready");
    holder.db = makeDbMock({ returningQueue: [[madeCard()]] });
    await expect(markRevampCancelled(REVAMP_ID, TOKEN)).resolves.toBe("ready");
    expect(holder.recordEvent).toHaveBeenCalledTimes(2);
    expect(holder.recordEvent).toHaveBeenNthCalledWith(1, notice);
    expect(holder.recordEvent).toHaveBeenNthCalledWith(2, notice);
  });

  it("★ the requester's Stop", async () => {
    holder.db = makeDbMock({ returningQueue: [[madeCard()]] });
    expect((await cancelRevamp(actor, REVAMP_ID))?.status).toBe("ready");
    expect(holder.recordEvent).toHaveBeenCalledWith(notice);
  });

  it("★ the status poll, for an unseen stop and for spent attempts", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          unheld({
            status: "running",
            step: "card",
            cancelRequestedAt: "2026-10-21 05:00:30+00",
          }),
        ],
      ],
      returningQueue: [[madeCard()]],
    });
    expect((await readRevampStatus(actor, REVAMP_ID))?.status).toBe("ready");
    holder.db = makeDbMock({
      selectQueue: [[unheld({ status: "running", step: "card", attempts: 4 })]],
      returningQueue: [[madeCard()]],
    });
    expect((await readRevampStatus(actor, REVAMP_ID))?.status).toBe("ready");
    expect(holder.recordEvent).toHaveBeenCalledTimes(2);
    expect(holder.recordEvent).toHaveBeenNthCalledWith(2, notice);
  });

  it("★ the sweep, once for each card it finished, each to its own requester", async () => {
    holder.db = makeDbMock({
      selectQueue: [[{ id: REVAMP_ID }, { id: OTHER_ID }]],
      // Each finished card, then its conversation's other ready cards.
      returningQueue: [
        [madeCard()],
        [],
        [madeCard({ id: OTHER_ID, draftId: OTHER_ID, adminId: "staff-2" })],
        [],
      ],
      executeQueue: [[], [], []],
    });
    await sweepStalledRevamps(5);
    expect(holder.recordEvent).toHaveBeenCalledTimes(2);
    expect(holder.recordEvent).toHaveBeenNthCalledWith(1, notice);
    expect(holder.recordEvent).toHaveBeenNthCalledWith(
      2,
      revampReadyEvent({
        id: OTHER_ID,
        storeId: STORE_ID,
        adminId: "staff-2",
        conversationId: CONVERSATION_ID,
      }),
    );
  });

  it("★ a settlement that rolls back announces nothing", async () => {
    holder.db = makeDbMock({
      selectQueue: [[{ id: REVAMP_ID }]],
      returningQueue: [[madeCard()], []],
    });
    // The card was finished inside the transaction, which then failed.
    holder.db.db.execute = vi.fn(async () => {
      throw new Error("connection terminated");
    });
    await expect(sweepStalledRevamps(5)).rejects.toThrow(
      "connection terminated",
    );
    expect(holder.recordEvent).not.toHaveBeenCalled();
  });

  it("says nothing when no card was made", async () => {
    holder.db = makeDbMock({
      returningQueue: [[], [rawRow({ status: "failed" })]],
    });
    await expect(
      failRevampJob({
        revampId: REVAMP_ID,
        leaseToken: TOKEN,
        code: "internal",
        detail: "x",
      }),
    ).resolves.toBe("failed");
    expect(holder.recordEvent).not.toHaveBeenCalled();
  });

  it("★ a notice that fails never fails the settlement", async () => {
    holder.recordEvent.mockRejectedValueOnce(new Error("notifications down"));
    holder.db = makeDbMock({ returningQueue: [[madeCard()]] });
    await expect(markRevampCancelled(REVAMP_ID, TOKEN)).resolves.toBe("ready");
    expect(holder.recordEvent).toHaveBeenCalledTimes(1);
  });
});

describe("★★ the redo memory on the job (robustness audit section 5, step 6)", () => {
  const OTHER_STORE = "88888888-8888-4888-8888-888888888888";
  /** The SELECT a read ran, as Postgres receives it. */
  const query = (db: DbMock) => {
    const where = new PgDialect().sqlToQuery(db.calls.where[0]);
    const select = new PgDialect().sqlToQuery(db.calls.select[0].plan);
    return { where, select };
  };
  const plan = (summary: string) => ({
    summary,
    pages: [],
    shots: [],
    bindings: [],
  });

  it("★★ reads only this store's own earlier plans a merchant saw, never this job, newest first, at most the limit", async () => {
    holder.db = makeDbMock({ selectQueue: [[{ plan: plan("newest") }]] });
    const plans = await readEarlierRevampPlans({
      storeId: STORE_ID,
      revampId: REVAMP_ID,
      limit: 5,
    });
    expect(plans).toEqual([plan("newest")]);
    const { where, select } = query(holder.db);
    // ★ The store in the predicate: another store's plan cannot match.
    expect(where.sql).toContain('"mink_revamps"."store_id" = $1');
    expect(where.sql).toContain('"mink_revamps"."id" <> $2');
    expect(where.sql).toContain('"mink_revamps"."status" in ($3, $4)');
    expect(where.sql).toContain(
      `"mink_revamps"."plan" ->> 'stage' = 'compiled'`,
    );
    expect(where.params).toEqual([STORE_ID, REVAMP_ID, "ready", "superseded"]);
    expect(where.params).not.toContain(OTHER_STORE);
    // ★ Narrow: only the plan the card showed, nothing else of the row.
    expect(Object.keys(holder.db.calls.select[0])).toEqual(["plan"]);
    expect(select.sql).toBe(`"mink_revamps"."plan" -> 'plan'`);
    expect(holder.db.calls.limit).toEqual([5]);
  });

  it("skips what is not a plan, and asks for nothing with a bad id or no room", async () => {
    holder.db = makeDbMock({
      selectQueue: [[{ plan: null }, { plan: "x" }, { plan: plan("a") }]],
    });
    await expect(
      readEarlierRevampPlans({
        storeId: STORE_ID,
        revampId: REVAMP_ID,
        limit: 5,
      }),
    ).resolves.toEqual([plan("a")]);
    holder.db = makeDbMock();
    for (const input of [
      { storeId: "nope", revampId: REVAMP_ID, limit: 5 },
      { storeId: STORE_ID, revampId: "nope", limit: 5 },
      { storeId: STORE_ID, revampId: REVAMP_ID, limit: 0 },
      { storeId: STORE_ID, revampId: REVAMP_ID, limit: Number.NaN },
      { storeId: STORE_ID, revampId: REVAMP_ID, limit: -3 },
    ]) {
      await expect(readEarlierRevampPlans(input)).resolves.toEqual([]);
    }
    expect(holder.db.calls.select).toHaveLength(0);
  });

  it("never reads more than ten, whatever it is asked", async () => {
    holder.db = makeDbMock({ selectQueue: [[]] });
    await readEarlierRevampPlans({
      storeId: STORE_ID,
      revampId: REVAMP_ID,
      limit: 500,
    });
    expect(holder.db.calls.limit).toEqual([10]);
  });

  it("a read that fails throws to the runner, which skips the memory", async () => {
    holder.db = makeDbMock({ selectQueue: [new Error("connection refused")] });
    await expect(
      readEarlierRevampPlans({
        storeId: STORE_ID,
        revampId: REVAMP_ID,
        limit: 5,
      }),
    ).rejects.toThrow("connection refused");
  });

  const RECORD = {
    status: "changed",
    passed: true,
    bar: 0.289,
    before: [0.166, 0.452],
    after: [0.301, 0.47],
    changed: [
      { choice: "bandRhythm", from: "soft,-,inverse", to: "-,tint,-" },
      { choice: "fontPairing", from: "the theme's", to: "lora-warm" },
    ],
    kept: ["cardStyle"],
  };

  it("★★ reads the check's record back, so every later save carries it", async () => {
    for (const stored of [
      RECORD,
      {
        status: "skipped",
        reason: "theme_unavailable",
        passed: false,
        bar: null,
        before: [],
        after: [],
        changed: [],
        kept: [],
      },
    ]) {
      holder.db = makeDbMock({
        selectQueue: [
          [rawRow({ status: "running", result: { distinctness: stored } })],
        ],
      });
      expect((await readRevampJob(REVAMP_ID))!.result).toEqual({
        distinctness: stored,
      });
    }
  });

  it.each([
    ["an unknown status", { status: "great" }],
    ["no verdict", { passed: "yes" }],
    ["a distance outside 0 to 1", { after: [1.5] }],
    ["a distance that is not a number", { before: ["0.1"] }],
    ["no bar at all", { bar: undefined }],
    ["a bar outside 0 to 1", { bar: 2 }],
    [
      "free text in a change",
      {
        changed: [{ choice: "bandRhythm", from: "a", to: "<b>Rukmini's</b>" }],
      },
    ],
    ["a change with no choice", { changed: [{ from: "a", to: "b" }] }],
    ["a kept choice that is not a name", { kept: ["card style!"] }],
    ["an unknown reason", { reason: "because" }],
    ["too many distances", { before: Array(17).fill(0.1) }],
  ])("drops a record with %s, never half of one", async (_what, change) => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          rawRow({
            status: "running",
            result: { checked: true, distinctness: { ...RECORD, ...change } },
          }),
        ],
      ],
    });
    expect((await readRevampJob(REVAMP_ID))!.result).toEqual({
      checked: true,
    });
  });

  it("writes the record with the compile step's result, fenced like the rest", async () => {
    holder.db = makeDbMock({ returningQueue: [[{ id: REVAMP_ID }]] });
    await saveRevampStep({
      revampId: REVAMP_ID,
      leaseToken: TOKEN,
      step: "photos",
      progress: initialRevampProgress(),
      patch: { result: { distinctness: RECORD as any } },
    });
    expect(sqlParamValues(holder.db.calls.set[0].result)).toContain(
      JSON.stringify({ distinctness: RECORD }),
    );
  });
});
