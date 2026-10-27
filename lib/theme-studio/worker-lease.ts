import { logWarn } from "@/lib/observability/logger";

/** A short, renewable lease bounds crash recovery without bounding paid work.
 * Renewal must use the owner's existing, unexpired fence; it cannot resurrect
 * a lease another worker acquired. No timer work survives the owning request.
 *
 * ★ ONLY A LOST LEASE STOPS PAID WORK, NOT A FAILED RENEWAL (P2, 2026-10-24).
 * Two answers can come back. `false` means the row is no longer ours (another
 * worker reclaimed it, an operator stopped it, or it lapsed): paid work stops
 * at once. A renewal that THROWS says nothing about ownership. Every pool now
 * waits at most 5 s for a connection (lib/db/client.ts), so on a busy web
 * server a renewal can time out while the lease is still ours with minutes
 * left; aborting then threw away paid photo and model calls. A throw is now
 * retried at the next tick, and the watchdog, armed from the start of the
 * last renewal that succeeded, still stops paid work 5 s before that lease
 * could lapse. */
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
    // An independent watchdog stops paid work even if a renewal is stuck or
    // keeps failing. Use request start, not response completion, to track
    // successful renewals.
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
        // Ownership is really gone: stop buying provider work now.
        if (!(await renew())) controller.abort();
        else if (!stopped && !controller.signal.aborted)
          expireAfter(WORKER_LEASE_SECONDS * 1000 - (Date.now() - started));
      } catch (error) {
        // Uncertain, not lost: keep the current watchdog and try again at the
        // next tick. Content-free: the renewal is one fenced UPDATE.
        logWarn("theme_studio.lease_renewal_retry", {
          error:
            error instanceof Error
              ? `${error.name}: ${error.message}`.slice(0, 160)
              : "unknown",
        });
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
