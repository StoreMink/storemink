/**
 * ★ AN IDLE LANE ASKS AGAIN EVERY 5 TO 10 SECONDS, NOT EVERY SECOND. A lane
 * with nothing to claim keeps asking only while a peer still works, and a
 * peer's photo run can hold the request for up to 19 minutes: at one second
 * that was about two database transactions a second on the shopper web
 * service's small pool for the whole run (TS-3B). Work queued meanwhile still
 * starts within one wait, and the minute schedule stays the safety net. The
 * wait is jittered so two requests' idle lanes do not ask in step.
 */
export const IDLE_LANE_WAIT_MS = { min: 5_000, max: 10_000 } as const;

/** One idle wait: 5 to 10 s, jittered. */
export function idleLaneWaitMs(random: () => number = Math.random): number {
  const { min, max } = IDLE_LANE_WAIT_MS;
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(min + (max - min) * r);
}

/** Keep a free lane taking queued work while peers are busy. An invocation has
 * an absolute deadline, a claim ceiling and an admission reserve. Every call
 * remains awaited, including after a peer fails; paid work is never detached. */
export async function drainWorkerLanes<T extends { claimed: number }>(options: {
  lanes: number;
  deadlineAt: number;
  reserveMs: number;
  maxClaims: number;
  work: (deadlineAt: number) => Promise<T>;
  /** Test seam: a fixed idle wait instead of IDLE_LANE_WAIT_MS. */
  idleMs?: number;
}): Promise<T[][]> {
  let active = 0;
  let claims = 0;
  let failure: unknown;
  const lanes = Array.from({ length: options.lanes }, async () => {
    const results: T[] = [];
    while (
      !failure &&
      claims + active < options.maxClaims &&
      Date.now() + options.reserveMs < options.deadlineAt
    ) {
      active++;
      let result: T;
      try {
        result = await options.work(options.deadlineAt);
      } catch (error) {
        failure = error;
        break;
      } finally {
        active--;
      }
      results.push(result);
      claims += result.claimed;
      if (!result.claimed) {
        if (!active) break;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, options.idleMs ?? idleLaneWaitMs()),
        );
      }
    }
    return results;
  });
  const results = await Promise.all(lanes);
  if (failure) throw failure;
  return results;
}
