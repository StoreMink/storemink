import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";
import { minkMessages, minkRuns, minkUsageLedger } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError, logWarn } from "@/lib/observability/logger";
import { MinkRunStoppedError } from "./errors";
import type { MinkActorContext, MinkRunResult } from "./types";

// ---------------------------------------------------------------------------
// ★★ The stop handshake (25 Oct 2026): a stop the merchant asks for wins only
// while the run has not acted, and the run's first side effect wins only
// while no stop was asked for. Both are conditional writes of the run's own
// row; these pin, without a database, the predicates that make exactly one
// of them win. The race itself, under real row locks, is proven against
// Postgres in run-stop.local.test.ts.
// ---------------------------------------------------------------------------

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
// The real completeMinkRun; only the failure record is watched.
vi.mock("./persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./persistence")>()),
  failMinkRun: vi.fn(),
}));

import { completeMinkRun, failMinkRun } from "./persistence";
import {
  MINK_STOPPED_RUN_SWEEP_LIMIT,
  STOP_WATCH_FAST_FOR_MS,
  claimMinkRunAct,
  closeStoppedMinkRuns,
  isMinkRunStopRequested,
  registerLiveMinkRun,
  requestMinkRunStop,
  stopLiveMinkRun,
  watchMinkRunStop,
} from "./run-stop";

const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADMIN = "owner";
const STOP = { runId: RUN, storeId: STORE, adminId: ADMIN };

let mock: ReturnType<typeof makeDbMock>;

function database(options: Parameters<typeof makeDbMock>[0] = {}) {
  mock = makeDbMock(options);
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
}

/** The SQL and parameters a fragment compiles to: the db mock parses none. */
const compiled = (fragment: unknown) =>
  new PgDialect().sqlToQuery(fragment as SQL);

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "running",
    actedAt: null,
    stopRequestedAt: null,
    ...overrides,
  };
}

describe("★★ requestMinkRunStop: the stop wins only before the run acts", () => {
  it("★★ records a stop on a running run that has not acted", async () => {
    database({
      selectByTable: { mink_runs: [[runRow()]] },
      returningQueue: [[{ id: RUN }]],
    });
    await expect(requestMinkRunStop(STOP)).resolves.toEqual({
      outcome: "stopped",
    });
    // ★ Under the run row's lock, so a claim waits for this decision.
    expect(mock.calls.forUpdate).toEqual(["update"]);
    expect(mock.calls.update).toEqual([minkRuns]);
    expect(mock.calls.set[0]).toHaveProperty("stopRequestedAt");
    // ★★ Every predicate again in the write, though the row is locked: a
    //   caller that drops the lock still cannot record a stop beside a claim.
    const write = compiled(mock.calls.where[1]);
    expect(write.sql).toContain('"mink_runs"."acted_at" is null');
    expect(write.sql).toContain('"mink_runs"."stop_requested_at" is null');
    expect(write.sql).toContain('"mink_runs"."status" = $');
    expect(write.params).toEqual(
      expect.arrayContaining([RUN, STORE, "running"]),
    );
  });

  it("★★ reads only this admin's own run in this store", async () => {
    database({ selectByTable: { mink_runs: [[runRow()]] } });
    await requestMinkRunStop(STOP);
    const read = compiled(mock.calls.where[0]);
    expect(read.sql).toContain('"mink_runs"."id" = $');
    expect(read.sql).toContain('"mink_runs"."store_id" = $');
    expect(read.sql).toContain('"mink_runs"."requested_by" = $');
    expect(read.params).toEqual([RUN, STORE, ADMIN]);
  });

  it("★★ answers acted, and records nothing, once the run has acted", async () => {
    database({
      selectByTable: {
        mink_runs: [[runRow({ actedAt: "2026-10-25T10:30:25Z" })]],
      },
    });
    await expect(requestMinkRunStop(STOP)).resolves.toEqual({
      outcome: "acted",
    });
    expect(mock.calls.update).toEqual([]);
  });

  it("answers finished, with its status, for a run that has ended", async () => {
    for (const status of ["succeeded", "failed", "cancelled"]) {
      database({ selectByTable: { mink_runs: [[runRow({ status })]] } });
      await expect(requestMinkRunStop(STOP)).resolves.toEqual({
        outcome: "finished",
        status,
      });
      expect(mock.calls.update).toEqual([]);
    }
  });

  it("★ is idempotent: a second stop answers stopped, also once the run closed", async () => {
    for (const status of ["running", "cancelled"]) {
      database({
        selectByTable: {
          mink_runs: [
            [runRow({ status, stopRequestedAt: "2026-10-25T10:30:24Z" })],
          ],
        },
      });
      await expect(requestMinkRunStop(STOP)).resolves.toEqual({
        outcome: "stopped",
      });
      expect(mock.calls.update).toEqual([]);
    }
  });

  it("★ answers not_found for a run that is not this admin's, or none", async () => {
    database({ selectByTable: { mink_runs: [[]] } });
    await expect(requestMinkRunStop(STOP)).resolves.toEqual({
      outcome: "not_found",
    });
    expect(mock.calls.update).toEqual([]);
  });

  it("never claims a stop the write did not record", async () => {
    database({
      selectByTable: { mink_runs: [[runRow()]] },
      returningQueue: [[]],
    });
    await expect(requestMinkRunStop(STOP)).resolves.toEqual({
      outcome: "unknown",
    });
  });
});

describe("★★ claimMinkRunAct: the run's first side effect", () => {
  it("★★ claims only a running run nobody asked to stop", async () => {
    database({ returningQueue: [[{ id: RUN }]] });
    await expect(
      claimMinkRunAct({ runId: RUN, storeId: STORE }),
    ).resolves.toBeUndefined();
    expect(mock.calls.update).toEqual([minkRuns]);
    const where = compiled(mock.calls.where[0]);
    expect(where.sql).toContain('"mink_runs"."stop_requested_at" is null');
    expect(where.sql).toContain('"mink_runs"."status" = $');
    expect(where.params).toEqual([RUN, STORE, "running"]);
    // ★ Repeating it keeps the first claim's time.
    expect(compiled(mock.calls.set[0].actedAt).sql).toBe(
      'coalesce("mink_runs"."acted_at", now())',
    );
  });

  it("★★ throws MinkRunStoppedError when a stop won (or the run ended)", async () => {
    database({ returningQueue: [[]] });
    await expect(
      claimMinkRunAct({ runId: RUN, storeId: STORE }),
    ).rejects.toBeInstanceOf(MinkRunStoppedError);
  });
});

describe("isMinkRunStopRequested", () => {
  it("reads whether a stop was recorded for this store's run", async () => {
    database({
      selectByTable: {
        mink_runs: [[{ stopRequestedAt: "2026-10-25T10:30:24Z" }], [{}], []],
      },
    });
    const input = { runId: RUN, storeId: STORE };
    await expect(isMinkRunStopRequested(input)).resolves.toBe(true);
    await expect(isMinkRunStopRequested(input)).resolves.toBe(false);
    await expect(isMinkRunStopRequested(input)).resolves.toBe(false);
    expect(compiled(mock.calls.where[0]).params).toEqual([RUN, STORE]);
  });
});

describe("★★ watchMinkRunStop: a stop asked for on another instance", () => {
  let reads: Array<boolean | Error>;

  beforeEach(() => {
    vi.useFakeTimers();
    reads = [];
    // Each read answers the next entry; an Error fails that read.
    vi.mocked(withService).mockImplementation(async () => {
      const next = reads.shift() ?? false;
      if (next instanceof Error) throw next;
      return [{ stopRequestedAt: next ? "2026-10-25T10:30:24Z" : null }];
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("★★ calls onStop once when a stop is seen, and reads no more", async () => {
    // ★ No jitter: three jittered waits can add up to 3,450 ms, past the
    //   3,200 ms this test waits, which failed about one run in ten.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    reads = [false, false, true];
    const onStop = vi.fn();
    watchMinkRunStop({ runId: RUN, storeId: STORE, onStop });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onStop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(onStop).toHaveBeenCalledOnce();
    const seen = vi.mocked(withService).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(withService).mock.calls.length).toBe(seen);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("★ reads about every second at first, then about every two", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
    watchMinkRunStop({ runId: RUN, storeId: STORE, onStop: vi.fn() });
    await vi.advanceTimersByTimeAsync(STOP_WATCH_FAST_FOR_MS);
    expect(vi.mocked(withService)).toHaveBeenCalledTimes(15);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(withService)).toHaveBeenCalledTimes(20);
  });

  it("★ jitters each wait by at most 15%", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // the shortest wait
    watchMinkRunStop({ runId: RUN, storeId: STORE, onStop: vi.fn() });
    await vi.advanceTimersByTimeAsync(849);
    expect(vi.mocked(withService)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(withService)).toHaveBeenCalledOnce();
  });

  it("★ never stacks reads: the next waits for a slow one to settle", async () => {
    let release!: () => void;
    vi.mocked(withService).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ stopRequestedAt: null }]);
        }),
    );
    watchMinkRunStop({ runId: RUN, storeId: STORE, onStop: vi.fn() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(withService)).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(vi.mocked(withService)).toHaveBeenCalledTimes(2);
  });

  it("★ skips a failed read, logs it once per run, and keeps watching", async () => {
    reads = [new Error("pool busy"), new Error("pool busy"), true];
    const onStop = vi.fn();
    watchMinkRunStop({ runId: RUN, storeId: STORE, onStop });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onStop).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledWith("mink.stop: watch read skipped", {
      runId: RUN,
      storeId: STORE,
      reason: "Error",
    });
  });

  it("★ close() ends it, even with a read in flight that finds the stop", async () => {
    let release!: () => void;
    vi.mocked(withService).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve([{ stopRequestedAt: "2026-10-25T10:30:24Z" }]);
        }),
    );
    const onStop = vi.fn();
    const watch = watchMinkRunStop({ runId: RUN, storeId: STORE, onStop });
    await vi.advanceTimersByTimeAsync(1_200);
    watch.close();
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onStop).not.toHaveBeenCalled();
    expect(vi.mocked(withService)).toHaveBeenCalledOnce();
  });

  it("logs an onStop that throws instead of leaving it unhandled", async () => {
    reads = [true];
    watchMinkRunStop({
      runId: RUN,
      storeId: STORE,
      onStop: () => {
        throw new Error("listener failed");
      },
    });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(logError).toHaveBeenCalledWith(
      "mink.stop: watch stop failed",
      expect.any(Error),
      { runId: RUN },
    );
  });
});

describe("★★ the same-instance fast path", () => {
  it("stops a run this process is answering, and nothing else", () => {
    const onStop = vi.fn();
    const unregister = registerLiveMinkRun(RUN, onStop);
    stopLiveMinkRun("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(onStop).not.toHaveBeenCalled();
    stopLiveMinkRun(RUN);
    expect(onStop).toHaveBeenCalledOnce();
    unregister();
    stopLiveMinkRun(RUN);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("an earlier registration's unregister leaves a later one in place", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerLiveMinkRun(RUN, first);
    const unregisterSecond = registerLiveMinkRun(RUN, second);
    unregisterFirst();
    stopLiveMinkRun(RUN);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    unregisterSecond();
  });

  it("★★ is shared by every copy of the module (a Next build has several)", async () => {
    const onStop = vi.fn();
    const unregister = registerLiveMinkRun(RUN, onStop);
    vi.resetModules();
    const otherCopy = await import("./run-stop");
    otherCopy.stopLiveMinkRun(RUN);
    expect(onStop).toHaveBeenCalledOnce();
    unregister();
  });

  it("logs a stop callback that throws, and does not throw itself", () => {
    const unregister = registerLiveMinkRun(RUN, () => {
      throw new Error("listener failed");
    });
    expect(() => stopLiveMinkRun(RUN)).not.toThrow();
    expect(logError).toHaveBeenCalledWith(
      "mink.stop: live stop failed",
      expect.any(Error),
      { runId: RUN },
    );
    unregister();
  });
});

describe("★★ completeMinkRun stores no answer for a stopped run", () => {
  const actor = { storeId: STORE, adminId: ADMIN } as MinkActorContext;
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
  const complete = () =>
    completeMinkRun({
      actor,
      started: { conversationId: CONVERSATION, runId: RUN, history: [] },
      result,
      latencyMs: 10,
      pricingLocation: "global",
    });

  it("★★ asks that no stop was recorded, in the write that stores the answer", async () => {
    database({ returningQueue: [[{ id: RUN }]] });
    await complete().catch(() => undefined);
    const where = compiled(mock.calls.where[0]);
    expect(where.sql).toContain('"mink_runs"."stop_requested_at" is null');
  });

  it("★★ throws MinkRunStoppedError and writes nothing when a stop came first", async () => {
    database({
      returningQueue: [[]],
      selectByTable: {
        mink_runs: [[{ stopRequestedAt: "2026-10-25T10:30:24Z" }]],
      },
    });
    await expect(complete()).rejects.toBeInstanceOf(MinkRunStoppedError);
    expect(mock.calls.insert).not.toContain(minkMessages);
    expect(mock.calls.insert).not.toContain(minkUsageLedger);
  });

  it("keeps the old error for a run that is simply not running", async () => {
    database({ returningQueue: [[]], selectByTable: { mink_runs: [[{}]] } });
    await expect(complete()).rejects.toThrow(
      "Mink run was not in a completable state",
    );
    expect(mock.calls.insert).not.toContain(minkMessages);
  });
});

describe("★ closeStoppedMinkRuns: a stopped run whose instance went away", () => {
  const stoppedRun = (id: string) => ({
    id,
    storeId: STORE,
    conversationId: CONVERSATION,
    requestedBy: ADMIN,
    model: "fixture",
    ageMs: 200_000,
    toolCalls: 2,
  });

  beforeEach(() => {
    vi.mocked(failMinkRun).mockResolvedValue({ closed: true, card: null });
  });

  it("★ closes each as the stream route would have: cancelled, code stopped", async () => {
    database({
      selectByTable: {
        mink_runs: [[stoppedRun(RUN), stoppedRun(CONVERSATION)]],
      },
    });
    await expect(closeStoppedMinkRuns()).resolves.toEqual({
      closed: 2,
      failed: 0,
    });
    expect(failMinkRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { storeId: STORE, adminId: ADMIN },
        started: { conversationId: CONVERSATION, runId: RUN },
        status: "cancelled",
        errorCode: "stopped",
        latencyMs: 200_000,
        usageStatus: "unavailable",
        progress: expect.objectContaining({ toolCalls: 2 }),
      }),
    );
  });

  it("★ reads only running runs whose stop is older than three minutes", async () => {
    database({ selectByTable: { mink_runs: [[]] } });
    await closeStoppedMinkRuns();
    const where = compiled(mock.calls.where[0]);
    expect(where.sql).toContain('"mink_runs"."status" = $');
    expect(where.sql).toContain('"mink_runs"."stop_requested_at" is not null');
    expect(where.sql).toContain(
      '"mink_runs"."stop_requested_at" < now() - make_interval(secs => $',
    );
    expect(where.params).toEqual(expect.arrayContaining(["running", 180]));
    expect(mock.calls.limit).toEqual([MINK_STOPPED_RUN_SWEEP_LIMIT]);
  });

  it("bounds a pass, whatever it is asked", async () => {
    database({ selectByTable: { mink_runs: [[], []] } });
    await closeStoppedMinkRuns({ limit: 500 });
    await closeStoppedMinkRuns({ limit: 0 });
    expect(mock.calls.limit).toEqual([MINK_STOPPED_RUN_SWEEP_LIMIT, 1]);
  });

  it("counts one it could not close and carries on; one already closed is not counted", async () => {
    database({
      selectByTable: {
        mink_runs: [
          [
            stoppedRun(RUN),
            stoppedRun(CONVERSATION),
            stoppedRun("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
          ],
        ],
      },
    });
    vi.mocked(failMinkRun)
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockResolvedValueOnce({ closed: false, card: null });
    await expect(closeStoppedMinkRuns()).resolves.toEqual({
      closed: 1,
      failed: 1,
    });
    expect(failMinkRun).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledWith(
      "mink.run: stopped run not closed",
      expect.anything(),
      { storeId: STORE, runId: RUN },
    );
  });
});
