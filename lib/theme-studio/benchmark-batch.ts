/** Bounded real-pipeline batch admission. Creation stays sequential and goes
 * through ordinary operator capacity gates; unfinished jobs occupy their slot
 * until collection proves they are terminal. No new paid work after timeout. */
export async function runThemeBenchmarkBatch<T>(options: {
  cases: readonly T[];
  concurrency: 1 | 2;
  deadlineAt: number;
  createAndQueue: (entry: T) => Promise<string>;
  collect: () => Promise<{ projectId: unknown; terminal: boolean }[]>;
  sleep: () => Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const active = new Set<string>();
  let next = 0;
  while (next < options.cases.length || active.size) {
    while (
      next < options.cases.length &&
      active.size < options.concurrency &&
      now() < options.deadlineAt
    ) {
      active.add(await options.createAndQueue(options.cases[next]));
      next++;
    }
    if (!active.size) break;
    for (const row of await options.collect())
      if (row.terminal && typeof row.projectId === "string")
        active.delete(row.projectId);
    if (now() >= options.deadlineAt)
      return {
        queued: next,
        timedOut: active.size > 0 || next < options.cases.length,
      };
    if (
      active.size &&
      (active.size >= options.concurrency || next === options.cases.length)
    )
      await options.sleep();
  }
  return { queued: next, timedOut: next < options.cases.length };
}
