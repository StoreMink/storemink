import { afterEach, expect, it, vi } from "vitest";
import { startWorkerLease, WORKER_LEASE_SECONDS } from "./worker-lease";
afterEach(() => vi.useRealTimers());
it("renews long paid work without keeping a twenty-minute crash lease", async () => {
  vi.useFakeTimers();
  const renew = vi.fn().mockResolvedValue(true);
  const lease = startWorkerLease(renew);
  expect(WORKER_LEASE_SECONDS).toBe(180);
  await vi.advanceTimersByTimeAsync(240_000);
  expect(renew).toHaveBeenCalledTimes(8);
  expect(lease.signal.aborted).toBe(false);
  await lease.stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(renew).toHaveBeenCalledTimes(8);
});
it.each([false, new Error("database unavailable")])(
  "aborts paid work when ownership cannot be renewed: %s",
  async (answer) => {
    vi.useFakeTimers();
    const lease = startWorkerLease(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lease.signal.aborted).toBe(true);
    await lease.stop();
  },
);
it("does not overlap renewals or leave one running after request settlement", async () => {
  vi.useFakeTimers();
  let release!: (held: boolean) => void;
  const renew = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const lease = startWorkerLease(renew);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(renew).toHaveBeenCalledOnce();
  let stopped = false;
  const stopping = lease.stop().then(() => {
    stopped = true;
  });
  expect(stopped).toBe(false);
  release(true);
  await stopping;
  await vi.advanceTimersByTimeAsync(90_000);
  expect(renew).toHaveBeenCalledOnce();
});
it("aborts before expiry if renewal hangs and cannot be revived by its late success", async () => {
  vi.useFakeTimers();
  let release!: (held: boolean) => void;
  const renew = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const lease = startWorkerLease(renew);
  await vi.advanceTimersByTimeAsync(175_000);
  expect(renew).toHaveBeenCalledOnce();
  expect(lease.signal.aborted).toBe(true);
  release(true);
  await lease.stop();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(renew).toHaveBeenCalledOnce();
});
