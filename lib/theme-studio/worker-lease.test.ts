import { afterEach, expect, it, vi } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/logger", () => ({ logWarn }));

import { startWorkerLease, WORKER_LEASE_SECONDS } from "./worker-lease";
afterEach(() => {
  vi.useRealTimers();
  logWarn.mockReset();
});
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
it("stops paid work at once when the renewal says the lease is gone", async () => {
  vi.useFakeTimers();
  const renew = vi.fn().mockResolvedValue(false);
  const lease = startWorkerLease(renew);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(lease.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(renew).toHaveBeenCalledOnce();
  expect(lease.signal.aborted).toBe(true);
  // Nothing renews a lease it has given up.
  await vi.advanceTimersByTimeAsync(120_000);
  expect(renew).toHaveBeenCalledOnce();
  await lease.stop();
});
it("★ keeps paid work going when one renewal throws, and renews at the next tick", async () => {
  vi.useFakeTimers();
  // A 5-second pool wait running out under load: the lease is still ours.
  const renew = vi
    .fn()
    .mockRejectedValueOnce(new Error("timeout exceeded when trying to connect"))
    .mockResolvedValue(true);
  const lease = startWorkerLease(renew);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(renew).toHaveBeenCalledOnce();
  expect(lease.signal.aborted).toBe(false);
  expect(logWarn).toHaveBeenCalledWith("theme_studio.lease_renewal_retry", {
    error: "Error: timeout exceeded when trying to connect",
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(renew).toHaveBeenCalledTimes(2);
  // Well past the first lease's watchdog (175 s): the second renewal re-armed
  // it, so the work is still running.
  await vi.advanceTimersByTimeAsync(240_000);
  expect(lease.signal.aborted).toBe(false);
  expect(renew).toHaveBeenCalledTimes(10);
  await lease.stop();
});
it("lets the watchdog stop paid work when renewals keep throwing", async () => {
  vi.useFakeTimers();
  const renew = vi.fn().mockRejectedValue(new Error("database unavailable"));
  const lease = startWorkerLease(renew);
  // Every tick retries; none can extend the lease taken at the claim.
  await vi.advanceTimersByTimeAsync(174_999);
  expect(lease.signal.aborted).toBe(false);
  expect(renew).toHaveBeenCalledTimes(5);
  // 5 s before the claim's 180-second lease could lapse.
  await vi.advanceTimersByTimeAsync(1);
  expect(lease.signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(renew).toHaveBeenCalledTimes(5);
  await lease.stop();
});
it("arms the watchdog from the last renewal that succeeded, not from a later failure", async () => {
  vi.useFakeTimers();
  const renew = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockRejectedValue(new Error("statement timeout"));
  const lease = startWorkerLease(renew);
  // Renewed at 30 s, so the lease now runs to 210 s and the watchdog to 205 s.
  await vi.advanceTimersByTimeAsync(204_999);
  expect(lease.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(lease.signal.aborted).toBe(true);
  await lease.stop();
});
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
