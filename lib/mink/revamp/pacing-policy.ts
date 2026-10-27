// Work and quality budgets are independent of the time a provider takes.
export const REVAMP_RECOVERY_VERSION = 2 as const;
export const REVAMP_WORK_BUDGET = {
  photos: 8,
  imageCalls: 11,
  targetMs: 12 * 60_000,
  finalChecksMs: 60_000,
  stopPollMs: 10_000,
  capacityRetryMs: 60_000,
} as const;

export function revampRecovers(
  value: { recoveryVersion?: unknown } | null | undefined,
): boolean {
  return value?.recoveryVersion === REVAMP_RECOVERY_VERSION;
}

/** No invocation may reset or extend the deadline stored at creation. */
export function revampFinishBy(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/** A complete paid attempt and final checks must fit before the job ends. */
export function revampPaidAdmissionEndsAt(
  finishBy: number,
  callMs: number,
): number {
  return finishBy - REVAMP_WORK_BUDGET.finalChecksMs - callMs - 5_000;
}
