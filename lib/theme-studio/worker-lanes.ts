/** Keep a free lane taking queued work while peers are busy. An invocation has
 * an absolute deadline, a claim ceiling and an admission reserve. Every call
 * remains awaited, including after a peer fails; paid work is never detached. */
export async function drainWorkerLanes<T extends { claimed: number }>(options: {
  lanes: number;
  deadlineAt: number;
  reserveMs: number;
  maxClaims: number;
  work: (deadlineAt: number) => Promise<T>;
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
          setTimeout(resolve, options.idleMs ?? 1_000),
        );
      }
    }
    return results;
  });
  const results = await Promise.all(lanes);
  if (failure) throw failure;
  return results;
}
