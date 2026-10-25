import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { themeStudioProjects, themeStudioRuns } from "@/drizzle/schema";
import { ZERO_USAGE } from "./provider";

const { service, pipeline, event, variety, logs, notify } = vi.hoisted(() => {
  class VarietyLeaseLostError extends Error {}
  return {
    service: vi.fn(),
    pipeline: vi.fn(),
    event: vi.fn(),
    variety: { load: vi.fn(), VarietyLeaseLostError },
    logs: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    notify: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./repository", () => ({
  recordThemeStudioEvent: event,
  digestThemeStudioJson: vi.fn(),
}));
vi.mock("./pipeline", () => ({ runThemeGeneration: pipeline }));
const { vertexClient, capacity } = vi.hoisted(() => ({
  vertexClient: vi.fn<(...args: unknown[]) => unknown>(() => ({
    provider: "vertex-gemini",
    generate: vi.fn(),
  })),
  capacity: vi.fn<(...args: unknown[]) => unknown>(() => ({})),
}));
vi.mock("./gemini-vertex", () => ({
  getVertexConfig: () => ({ projectId: "studio-project", region: "global" }),
  createVertexModelClient: vertexClient,
}));
vi.mock("./provider-capacity-store", () => ({
  sharedProviderCapacity: capacity,
}));
vi.mock("./config", () => ({
  getThemeStudioConfig: () => ({
    generationEnabled: true,
    disabledModels: new Set(),
  }),
}));
vi.mock("./visual-qa", () => ({ runThemeStudioVisualQaWorker: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: logs.error,
  logInfo: logs.info,
  logWarn: logs.warn,
}));
vi.mock("./notify", () => ({ sendThemeStudioNotice: notify }));
vi.mock("./variety-context", () => ({
  loadVarietyContext: variety.load,
  VarietyLeaseLostError: variety.VarietyLeaseLostError,
}));
import { runThemeStudioWorker } from "./worker";

function fixture({
  deferrals = 0,
  cancelled = false,
  lostLease = false,
  promptVersion = "version",
  /** run_queued events already recorded for the failure being waited out. */
  waits = 0,
  /** Whether a failure's settle moved the project out of `generating`. */
  projectSettles = true,
  /** Runs the reaper finds with dead leases, before the claim. */
  reaped = [] as Record<string, unknown>[],
} = {}) {
  const run = {
    id: "run",
    projectId: "project",
    messageId: "message",
    kind: "generate",
    provider: "vertex-gemini",
    modelKey: "gemini-3.8-flash",
    providerModel: "gemini-3.8-flash",
    promptVersion,
    attemptCount: 3,
    maxAttempts: 3,
    automatic: false,
    rateLimitDeferrals: deferrals,
    cancelRequestedAt: cancelled ? "now" : null,
    usage: {
      totals: { ...ZERO_USAGE, inputTokens: 100 },
      estimatedCostMicroUsd: 50,
    },
  };
  const project = {
    name: "Crave",
    themeId: "crave",
    status: "generating",
    baseThemeId: null,
    modelKey: run.modelKey,
    industries: ["food"],
    catalogSizes: ["small"],
    requiredFeatures: [],
  };
  const reads: unknown[][] = [
    [project],
    [{ createdAt: "now", referenceAssetIds: [] }],
    [{ kind: "brief", body: "brief" }],
    [{ latest: 14 }],
    lostLease ? [] : [run],
    ...(!lostLease ? [[project]] : []),
  ];
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const executes = [reaped, [run]];
  const queries: string[] = [];
  const waitCounts: string[] = [];
  const db = {
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const text = new PgDialect().sqlToQuery(query).sql;
      // How many waits this run already had (its run_queued events).
      if (text.includes("FROM theme_studio_events")) {
        waitCounts.push(text);
        return { rows: [{ n: waits }] };
      }
      queries.push(text);
      return { rows: executes.shift() ?? [] };
    },
    select: () => {
      const result = reads.shift();
      if (!result) throw new Error("Unexpected database read");
      const query = {
        from: () => query,
        where: () => query,
        for: () => query,
        limit: () => query,
        orderBy: () => query,
        then: (resolve: (result: unknown) => unknown) =>
          Promise.resolve(result).then(resolve),
      };
      return query;
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return {
          where: () => {
            const done = Promise.resolve([]);
            return Object.assign(done, {
              // The project settle reports whether it moved the project.
              returning: async () =>
                table === themeStudioProjects && projectSettles
                  ? [{ id: "project" }]
                  : [],
            });
          },
        };
      },
    }),
  };
  service.mockImplementation(async (work) => work(db));
  return { writes, queries, waitCounts };
}

beforeEach(() => {
  pipeline.mockResolvedValue({
    kind: "failed",
    errorCode: "rate_limited",
    detail: { stage: "draft" },
    telemetry: {
      calls: [],
      totals: ZERO_USAGE,
      estimatedCostMicroUsd: 0,
      repairs: { intent: 0, draft: 0 },
    },
  });
});
const work = () =>
  runThemeStudioWorker({ providers: ["vertex-gemini"], skipVisualQa: true });

describe("rate-limited worker settlement", () => {
  it("queues a delayed recovery even at the crash-attempt limit, preserving the project/version", async () => {
    const { writes, queries } = fixture();
    const before = Date.now();
    expect(await work()).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });
    const update = writes.find(
      (write) => write.table === themeStudioRuns,
    )!.values;
    expect(update).toMatchObject({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      rateLimitDeferrals: 1,
    });
    expect(Date.parse(update.retryNotBefore as string)).toBeGreaterThanOrEqual(
      before + 225_000,
    );
    expect(Date.parse(update.retryNotBefore as string)).toBeLessThanOrEqual(
      Date.now() + 300_000,
    );
    expect(update.finishedAt).toBeUndefined();
    expect(writes.some((write) => write.table === themeStudioProjects)).toBe(
      false,
    );
    expect(event).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "run_queued",
        detail: expect.objectContaining({
          reason: "rate_limited",
          recovery: 1,
        }),
      }),
    );
    // Claims skip cooldown rows and don't consume the crash budget on a due recovery.
    expect(queries[1]).toContain("retry_not_before <= now()");
    expect(queries[1]).toContain(
      "CASE WHEN r.retry_not_before IS NULL THEN 1 ELSE 0 END",
    );
    expect(queries).toHaveLength(2); // No immediate retry loop.
  });

  it("ends with a clear failure after four delayed recoveries", async () => {
    const { writes } = fixture({ deferrals: 4 });
    expect(await work()).toMatchObject({ failed: 1, requeued: 0 });
    expect(
      writes.find((write) => write.table === themeStudioRuns)!.values,
    ).toMatchObject({ status: "failed", errorCode: "rate_limited" });
  });

  it("honors cancellation before deciding to recover", async () => {
    const { writes } = fixture({ cancelled: true });
    expect(await work()).toMatchObject({ cancelled: 1, requeued: 0 });
    expect(
      writes.find((write) => write.table === themeStudioRuns)!.values,
    ).toMatchObject({ status: "cancelled" });
  });

  it("cannot recover or finish after losing its lease", async () => {
    const { writes } = fixture({ lostLease: true });
    expect(await work()).toMatchObject({ failed: 0, requeued: 0 });
    expect(writes).toHaveLength(0);
    expect(event).not.toHaveBeenCalled();
  });

  it("treats losing the lease while freezing variety context as expected, not an error", async () => {
    variety.load.mockRejectedValue(new variety.VarietyLeaseLostError());
    const { writes } = fixture({
      lostLease: true,
      promptVersion: "theme-studio-v21",
    });
    expect(await work()).toMatchObject({ failed: 0, requeued: 0 });
    expect(pipeline).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(logs.warn).toHaveBeenCalledWith(
      "theme studio: run lease lost before start",
      { runId: "run" },
    );
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("does not turn authentication failures into capacity retries", async () => {
    const { writes } = fixture();
    pipeline.mockResolvedValue({
      kind: "failed",
      errorCode: "provider_auth",
      detail: {},
      telemetry: {},
    });
    expect(await work()).toMatchObject({ failed: 1, requeued: 0 });
    expect(
      writes.find((write) => write.table === themeStudioRuns)!.values,
    ).toMatchObject({ status: "failed", errorCode: "provider_auth" });
  });

  it("keeps already-recorded spend when recovery stops before reconstructing telemetry", async () => {
    const { writes } = fixture();
    pipeline.mockRejectedValue(new Error("checkpoint read failed"));
    expect(await work()).toMatchObject({ failed: 1 });
    expect(
      writes.find((write) => write.table === themeStudioRuns)!.values.usage,
    ).toMatchObject({
      totals: { inputTokens: 100 },
      estimatedCostMicroUsd: 50,
    });
  });
});

// ★ TS-3B: a text call Google could not serve is waited out (unavailable
// twice, a timed-out call once), each wait counted from the run's own
// run_queued events; saved answers replay, so nothing is paid twice.
describe("waiting out a provider failure", () => {
  const failWith = (errorCode: string) =>
    pipeline.mockResolvedValue({
      kind: "failed",
      errorCode,
      detail: { stage: "draft" },
      telemetry: {
        calls: [],
        totals: ZERO_USAGE,
        estimatedCostMicroUsd: 0,
        repairs: { intent: 0, draft: 0 },
      },
    });

  it("requeues an unavailable model on a short delayed recovery, spending no crash attempt", async () => {
    failWith("provider_unavailable");
    const { writes, waitCounts } = fixture();
    const before = Date.now();
    expect(await work()).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });
    const update = writes.find((w) => w.table === themeStudioRuns)!.values;
    expect(update).toMatchObject({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      outcomeDetail: {
        kind: "provider_wait",
        reason: "provider_unavailable",
        stage: "draft",
      },
    });
    // Not a 429: the rate-limit budget is untouched.
    expect(update.rateLimitDeferrals).toBeUndefined();
    expect(update.finishedAt).toBeUndefined();
    const due = Date.parse(update.retryNotBefore as string);
    expect(due).toBeGreaterThanOrEqual(before + 90_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(event).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "run_queued",
        detail: expect.objectContaining({
          reason: "provider_unavailable",
          recovery: 1,
        }),
      }),
    );
    // The count came from this run's own run_queued events for that code.
    expect(waitCounts).toHaveLength(1);
    expect(waitCounts[0]).toContain("event_type = 'run_queued'");
    expect(waitCounts[0]).toContain("detail->>'reason' = $3");
    expect(notify).not.toHaveBeenCalled();
  });

  it("fails an unavailable model after its two waits, and tells the operator", async () => {
    failWith("provider_unavailable");
    const { writes } = fixture({ waits: 2 });
    expect(await work()).toMatchObject({ failed: 1, requeued: 0 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)!.values,
    ).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      projectId: "project",
      kind: "needs_fix",
    });
  });

  it("waits out a timed-out call once, then fails it", async () => {
    failWith("provider_timeout");
    let { writes } = fixture({ waits: 0 });
    expect(await work()).toMatchObject({ requeued: 1 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)!.values,
    ).toMatchObject({
      status: "queued",
      outcomeDetail: { kind: "provider_wait", reason: "provider_timeout" },
    });
    ({ writes } = fixture({ waits: 1 }));
    expect(await work()).toMatchObject({ failed: 1, requeued: 0 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)!.values,
    ).toMatchObject({ status: "failed", errorCode: "provider_timeout" });
  });

  it("does not wait out a rejected request", async () => {
    failWith("provider_rejected");
    const { writes, waitCounts } = fixture();
    expect(await work()).toMatchObject({ failed: 1, requeued: 0 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)!.values,
    ).toMatchObject({ status: "failed", errorCode: "provider_rejected" });
    expect(waitCounts).toHaveLength(0);
  });
});

describe("the run settled line and the operator's notice (TS-3B)", () => {
  const settledLine = () =>
    logs.info.mock.calls.find(([m]) => m === "theme studio: run settled")?.[1];

  it("carries the failed run's error code", async () => {
    pipeline.mockResolvedValue({
      kind: "failed",
      errorCode: "provider_auth",
      detail: {},
      telemetry: {},
    });
    fixture();
    await work();
    expect(settledLine()).toMatchObject({
      runId: "run",
      outcome: "failed",
      errorCode: "provider_auth",
    });
  });

  it("carries why a requeued run waits", async () => {
    fixture();
    await work();
    expect(settledLine()).toMatchObject({
      outcome: "requeued",
      errorCode: "rate_limited",
    });
  });

  it("carries no error code for a cancelled run, and tells nobody", async () => {
    fixture({ cancelled: true });
    await work();
    expect(settledLine()).toMatchObject({ outcome: "cancelled" });
    expect(settledLine()).not.toHaveProperty("errorCode");
    expect(notify).not.toHaveBeenCalled();
  });

  it("tells nobody when the failure did not stop the theme", async () => {
    pipeline.mockResolvedValue({
      kind: "failed",
      errorCode: "provider_auth",
      detail: {},
      telemetry: {},
    });
    fixture({ projectSettles: false });
    expect(await work()).toMatchObject({ failed: 1 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("sends the notice only after the settling transaction", async () => {
    pipeline.mockResolvedValue({
      kind: "failed",
      errorCode: "provider_auth",
      detail: {},
      telemetry: {},
    });
    fixture();
    const order: string[] = [];
    const settle = service.getMockImplementation()!;
    service.mockImplementation(async (job) => {
      const result = await settle(job);
      order.push("transaction");
      return result;
    });
    notify.mockImplementation(async () => {
      order.push("notice");
    });
    await work();
    // reap, claim, input, settle: four transactions done, then the notice
    // (which opens its own, never inside the settle), then the next claim.
    expect(order.slice(0, 6)).toEqual([
      "transaction",
      "transaction",
      "transaction",
      "transaction",
      "notice",
      "transaction",
    ]);
    expect(order.filter((o) => o === "notice")).toHaveLength(1);
  });

  it("asks the operator when the AI has questions about the brief", async () => {
    pipeline.mockResolvedValue({
      kind: "clarify",
      questions: ["Which city?", "Any colours?"],
      telemetry: {
        calls: [],
        totals: ZERO_USAGE,
        estimatedCostMicroUsd: 0,
        repairs: { intent: 0, draft: 0 },
      },
    });
    const { writes } = fixture();
    expect(await work()).toMatchObject({ succeeded: 1 });
    expect(
      writes.find((w) => w.table === themeStudioProjects)!.values,
    ).toMatchObject({ status: "blocked" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      projectId: "project",
      kind: "questions",
    });
    expect(settledLine()).toMatchObject({ outcome: "succeeded" });
    expect(settledLine()).not.toHaveProperty("errorCode");
  });
});

describe("the claim (TS-3B)", () => {
  it("puts automatic repairs first and holds a fresh photo run for nine minutes of request", async () => {
    const { queries } = fixture();
    await work();
    const claim = queries[1];
    expect(claim).toContain(
      "ORDER BY (kind = 'revise' AND automatic) DESC, created_at",
    );
    expect(claim).toMatch(
      /kind='images' AND \(started_at IS NOT NULL OR \$\d+::int >= \$\d+::int\)/,
    );
    expect(claim).toContain("(kind='revise' AND automatic)");
  });
});

describe("the text calls' own capacity lane (TS-3B, optimisation 8)", () => {
  it("queues design calls on Theme Studio's own scope, never the shared row", async () => {
    fixture();
    await work();
    expect(vertexClient).toHaveBeenCalled();
    const options = vertexClient.mock.calls[0][1] as {
      capacity: (model: string) => unknown;
    };
    options.capacity("gemini-3.8-flash");
    expect(capacity).toHaveBeenCalledWith(
      "studio-project",
      "global",
      "gemini-3.8-flash",
      { scope: "theme-studio-text" },
    );
  });
});

describe("a reaped run (TS-3B)", () => {
  it("tells the starter when a run out of attempts stopped the theme, never for a cancel", async () => {
    fixture({
      reaped: [
        {
          id: "dead",
          projectId: "stuck",
          status: "failed",
          automatic: false,
          baseVersionId: null,
        },
        {
          id: "stopped",
          projectId: "cancelled",
          status: "cancelled",
          automatic: false,
          baseVersionId: null,
        },
      ],
    });
    expect(await work()).toMatchObject({ reaped: 2 });
    expect(notify).toHaveBeenCalledWith({
      projectId: "stuck",
      kind: "needs_fix",
    });
    expect(notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "cancelled" }),
    );
  });
});
