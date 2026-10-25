import { expect, it, vi } from "vitest";
import {
  drainWorkerLanes,
  IDLE_LANE_WAIT_MS,
  idleLaneWaitMs,
} from "./worker-lanes";
const config = {
  lanes: 2,
  deadlineAt: Date.now() + 100_000,
  reserveMs: 10_000,
  maxClaims: 3,
};
it("starts the next queued job on a free lane before a slow peer finishes", async () => {
  let release!: () => void;
  const work = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ claimed: 1 });
        }),
    )
    .mockResolvedValue({ claimed: 1 });
  let complete = false;
  const pending = drainWorkerLanes({ ...config, work }).then((result) => {
    complete = true;
    return result;
  });
  await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(3));
  expect(complete).toBe(false);
  release();
  expect((await pending).flat().reduce((n, r) => n + r.claimed, 0)).toBe(3);
});
it("waits for in-flight paid work after another lane fails and starts no more", async () => {
  let release!: () => void;
  const work = vi
    .fn()
    .mockRejectedValueOnce(new Error("db down"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ claimed: 1 });
        }),
    );
  let complete = false;
  const pending = drainWorkerLanes({ ...config, work }).catch((error) => {
    complete = true;
    return error;
  });
  await Promise.resolve();
  expect(complete).toBe(false);
  expect(work).toHaveBeenCalledTimes(2);
  release();
  expect((await pending).message).toBe("db down");
  expect(work).toHaveBeenCalledTimes(2);
});
it("does not admit work without settlement time left", async () => {
  const work = vi.fn();
  expect(
    await drainWorkerLanes({ ...config, deadlineAt: Date.now() + 5000, work }),
  ).toEqual([[], []]);
  expect(work).not.toHaveBeenCalled();
});
it("exits when the queue is empty rather than keeping an idle paid invocation alive", async () => {
  const work = vi.fn().mockResolvedValue({ claimed: 0 });
  await drainWorkerLanes({ ...config, work, idleMs: 1 });
  expect(work.mock.calls.length).toBeLessThanOrEqual(3);
});

// ★ TS-3B: an idle lane beside a busy peer asks the database again after 5 to
// 10 s, never every second (two transactions a second for up to 19 minutes).
it("waits 5 to 10 seconds between idle asks while a peer still works", async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    const work = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ claimed: 1 });
          }),
      )
      .mockResolvedValue({ claimed: 0 });
    const pending = drainWorkerLanes({
      ...config,
      deadlineAt: Date.now() + 100_000,
      maxClaims: 8,
      work,
    });
    await vi.advanceTimersByTimeAsync(0);
    // The busy lane's call and the idle lane's first, empty, ask.
    expect(work).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(work).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(work).toHaveBeenCalledTimes(3);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  } finally {
    vi.useRealTimers();
  }
});

it("draws each idle wait between 5 and 10 seconds", () => {
  expect(idleLaneWaitMs(() => 0)).toBe(5_000);
  expect(idleLaneWaitMs(() => 1)).toBe(10_000);
  expect(idleLaneWaitMs(() => 0.5)).toBe(7_500);
  // Out-of-range randomness is clamped, never a tight loop or a long stall.
  expect(idleLaneWaitMs(() => -3)).toBe(5_000);
  expect(idleLaneWaitMs(() => 9)).toBe(10_000);
  expect(IDLE_LANE_WAIT_MS).toEqual({ min: 5_000, max: 10_000 });
});
