// Work and quality budgets are independent of the time a provider takes.
export const REVAMP_RECOVERY_VERSION = 2 as const;
export const REVAMP_WORK_BUDGET = {
  photos: 8,
  imageCalls: 11,
  targetMs: 12 * 60_000,
  stopPollMs: 10_000,
  capacityRetryMs: 60_000,
} as const;

/**
 * ★★ THE ONE CLOCK A RECOVERABLE REDESIGN STILL HAS: six hours from its first
 *   claim. Capacity waits, reviewer outages and database blips park a
 *   recoverable job without counting against it, so a fault that never
 *   clears (a storage permission, a reviewer switched off, a provider that
 *   refuses for the rest of the day) would otherwise keep the job "waiting to
 *   continue" for ever, and the store can only have one active redesign
 *   (`mink_revamps_one_active_idx`). Past this the claim refuses the job and
 *   the sweep or the status poll fails it (`run_ceiling`), giving the store's
 *   day's start back. ★ Why six hours: the legacy ceiling (four hours, about
 *   three times the slowest redesign measured) plus two hours of uncounted
 *   waits, which is longer than any provider incident seen so far.
 */
export const REVAMP_RECOVERY_CEILING_MS = 6 * 60 * 60_000;

export function revampRecovers(
  value: { recoveryVersion?: unknown } | null | undefined,
): boolean {
  return value?.recoveryVersion === REVAMP_RECOVERY_VERSION;
}

/** A stored epoch-millisecond timestamp (`targetReadyAt`), or null. */
export function revampEpochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
