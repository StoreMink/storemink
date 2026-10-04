import { expect, it, vi } from "vitest";
import { drainWorkerLanes } from "./worker-lanes";
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
