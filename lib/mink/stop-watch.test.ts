import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logError, logWarn } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// ★ The watcher shared by a Mink run (run-stop.ts) and a Refine with Mink AI
// request (refine-stop.ts). Its cadence, jitter, never-stacking ticks and
// close() stay pinned by run-stop.test.ts through watchMinkRunStop; these pin
// the two calls a refine adds: settled() (no read holds a pooled connection
// once the charge starts) and checkNow() (the pre-send check, never beside a
// tick's read), plus the registry kept per symbol name.
// ---------------------------------------------------------------------------

vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { createLiveStopRegistry, watchForStop } from "./stop-watch";

const SKIPPED = { message: "test: watch read skipped", fields: { id: "w1" } };
const FAILED = { message: "test: watch stop failed", fields: { id: "w1" } };

/** A read the test settles by hand, counting how many run at once. */
function controlledReads() {
  const pending: Array<{
    resolve: (stopped: boolean) => void;
    reject: (error: Error) => void;
  }> = [];
  let running = 0;
  let mostAtOnce = 0;
  const read = vi.fn(
    () =>
      new Promise<boolean>((resolve, reject) => {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        pending.push({
          resolve: (stopped) => {
            running -= 1;
            resolve(stopped);
          },
          reject: (error) => {
            running -= 1;
            reject(error);
          },
        });
      }),
  );
  return {
    read,
    pending,
    get mostAtOnce() {
      return mostAtOnce;
    },
  };
}

describe("★★ watchForStop: settled() and checkNow()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("★★ settled() resolves at once when no read is in flight", async () => {
    const reads = controlledReads();
    const watch = watchForStop({
      read: reads.read,
      onStop: vi.fn(),
      skippedLog: SKIPPED,
      failedLog: FAILED,
    });
    watch.close();
    let settled = false;
    void watch.settled().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(reads.read).not.toHaveBeenCalled();
  });

  it("★★ settled() resolves only after the read in flight settles, and never rejects", async () => {
    const reads = controlledReads();
    const watch = watchForStop({
      read: reads.read,
      onStop: vi.fn(),
      skippedLog: SKIPPED,
      failedLog: FAILED,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(reads.read).toHaveBeenCalledOnce();
    // ★ The refine's order: close, then wait, then open the charge.
    watch.close();
    let settled = false;
    void watch.settled().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    reads.pending[0].reject(new Error("connection dropped"));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    // No read starts after close().
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads.read).toHaveBeenCalledOnce();
  });

  it("★★ checkNow() waits for a tick's read in flight and never runs two at once", async () => {
    const reads = controlledReads();
    const onStop = vi.fn();
    const watch = watchForStop({
      read: reads.read,
      onStop,
      skippedLog: SKIPPED,
      failedLog: FAILED,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(reads.read).toHaveBeenCalledOnce();
    let answer: boolean | undefined;
    void watch.checkNow().then((value) => {
      answer = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    // ★ Its own read waits for the tick's.
    expect(reads.read).toHaveBeenCalledOnce();
    reads.pending[0].resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.read).toHaveBeenCalledTimes(2);
    reads.pending[1].resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBe(false);
    expect(reads.mostAtOnce).toBe(1);
    // ★ Still watching, with ONE timer: a second second brings one read.
    await vi.advanceTimersByTimeAsync(1_200);
    expect(reads.read).toHaveBeenCalledTimes(3);
    expect(reads.mostAtOnce).toBe(1);
    expect(onStop).not.toHaveBeenCalled();
    watch.close();
  });

  it("★★ checkNow() reads at once, and a stop it sees calls onStop once", async () => {
    const reads = controlledReads();
    const onStop = vi.fn();
    const watch = watchForStop({
      read: reads.read,
      onStop,
      skippedLog: SKIPPED,
      failedLog: FAILED,
    });
    const answer = watch.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.read).toHaveBeenCalledOnce();
    reads.pending[0].resolve(true);
    await expect(answer).resolves.toBe(true);
    expect(onStop).toHaveBeenCalledOnce();
    // Seen once: no more reads, and asking again answers from memory.
    await expect(watch.checkNow()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads.read).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("★ a failed checkNow() answers false, logs under the caller's label once, and keeps watching", async () => {
    const reads = controlledReads();
    const watch = watchForStop({
      read: reads.read,
      onStop: vi.fn(),
      skippedLog: SKIPPED,
      failedLog: FAILED,
    });
    const first = watch.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    reads.pending[0].reject(new TypeError("pool busy"));
    await expect(first).resolves.toBe(false);
    const second = watch.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    reads.pending[1].reject(new Error("pool busy"));
    await expect(second).resolves.toBe(false);
    expect(logWarn).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledWith("test: watch read skipped", {
      id: "w1",
      reason: "TypeError",
    });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(reads.read).toHaveBeenCalledTimes(3);
    watch.close();
  });

  it("★ a read waiting behind one in flight does not start once the watch is closed", async () => {
    const reads = controlledReads();
    const watch = watchForStop({
      read: reads.read,
      onStop: vi.fn(),
      skippedLog: SKIPPED,
      failedLog: FAILED,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    const answer = watch.checkNow();
    watch.close();
    reads.pending[0].resolve(false);
    await expect(answer).resolves.toBe(false);
    await watch.settled();
    expect(reads.read).toHaveBeenCalledOnce();
    // Closed: checkNow starts nothing.
    await expect(watch.checkNow()).resolves.toBe(false);
    expect(reads.read).toHaveBeenCalledOnce();
  });

  it("logs an onStop that throws under the caller's label", async () => {
    const reads = controlledReads();
    const watch = watchForStop({
      read: reads.read,
      onStop: () => {
        throw new Error("listener failed");
      },
      skippedLog: SKIPPED,
      failedLog: FAILED,
    });
    const answer = watch.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    reads.pending[0].resolve(true);
    await expect(answer).resolves.toBe(true);
    expect(logError).toHaveBeenCalledWith(
      "test: watch stop failed",
      expect.any(Error),
      { id: "w1" },
    );
  });
});

describe("★ createLiveStopRegistry", () => {
  it("★ keeps two symbol names apart, and stop reaches only its key", () => {
    const runs = createLiveStopRegistry("storemink.test.liveA", "a failed");
    const refines = createLiveStopRegistry("storemink.test.liveB", "b failed");
    const run = vi.fn();
    const refine = vi.fn();
    const other = vi.fn();
    const unregisterRun = runs.register("same-key", run);
    const unregisterRefine = refines.register("same-key", refine);
    const unregisterOther = refines.register("other-key", other);
    refines.stop("same-key", {});
    expect(refine).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    unregisterRun();
    unregisterRefine();
    unregisterOther();
    refines.stop("same-key", {});
    expect(refine).toHaveBeenCalledOnce();
  });

  it("★ two registries with one symbol name share their entries (a Next build has several module copies)", () => {
    const first = createLiveStopRegistry("storemink.test.liveC", "c failed");
    const second = createLiveStopRegistry("storemink.test.liveC", "c failed");
    const onStop = vi.fn();
    const unregister = first.register("key", onStop);
    second.stop("key", {});
    expect(onStop).toHaveBeenCalledOnce();
    unregister();
  });

  it("logs a stop callback that throws with the fields it is given", () => {
    const registry = createLiveStopRegistry(
      "storemink.test.liveD",
      "d: live stop failed",
    );
    const unregister = registry.register("key", () => {
      throw new Error("listener failed");
    });
    expect(() => registry.stop("key", { storeId: "s1" })).not.toThrow();
    expect(logError).toHaveBeenCalledWith(
      "d: live stop failed",
      expect.any(Error),
      { storeId: "s1" },
    );
    unregister();
  });
});
