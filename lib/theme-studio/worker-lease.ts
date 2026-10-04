/** A short, renewable lease bounds crash recovery without bounding paid work.
 * Renewal must use the owner's existing, unexpired fence; it cannot resurrect
 * a lease another worker acquired. No timer work survives the owning request. */
export const WORKER_LEASE_SECONDS = 180;
export const WORKER_LEASE_RENEW_MS = 30_000;

export function startWorkerLease(
  renew: () => Promise<boolean>,
  intervalMs = WORKER_LEASE_RENEW_MS,
  initialRemainingMs = WORKER_LEASE_SECONDS * 1000,
) {
  const controller = new AbortController();
  let stopped = false;
  let pending: Promise<void> | null = null;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const expireAfter = (remainingMs: number) => {
    clearTimeout(expiry);
    if (remainingMs <= 5_000) {
      controller.abort();
      return;
    }
    // An independent watchdog stops paid work even if a renewal is stuck.
    // Use request start, not response completion, to track successful renewals.
    expiry = setTimeout(
      () => controller.abort(),
      Math.max(0, remainingMs - 5_000),
    );
  };
  expireAfter(initialRemainingMs);
  const timer = setInterval(() => {
    if (stopped || pending || controller.signal.aborted) return;
    pending = (async () => {
      const started = Date.now();
      try {
        if (!(await renew())) controller.abort();
        else if (!stopped && !controller.signal.aborted)
          expireAfter(WORKER_LEASE_SECONDS * 1000 - (Date.now() - started));
      } catch {
        // Fail closed: do not keep buying provider work with an uncertain lease.
        controller.abort();
      }
    })().finally(() => {
      pending = null;
    });
  }, intervalMs);
  return {
    signal: controller.signal,
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(expiry);
      await pending;
    },
  };
}
