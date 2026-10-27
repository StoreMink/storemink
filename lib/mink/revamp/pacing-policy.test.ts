import { describe, expect, it } from "vitest";
import {
  REVAMP_WORK_BUDGET,
  revampFinishBy,
  revampRecovers,
  revampPaidAdmissionEndsAt,
} from "./pacing-policy";

describe("redesign work deadline", () => {
  it("accepts only a persisted integer timestamp", () => {
    for (const value of [undefined, null, "1000", -1, NaN, Infinity, 1.5])
      expect(revampFinishBy(value)).toBeNull();
    expect(revampFinishBy(1_800_000_000_000)).toBe(1_800_000_000_000);
  });
  it("reserves the full image timeout and final checks", () => {
    const finishBy = 12 * 60_000;
    expect(revampPaidAdmissionEndsAt(finishBy, 180_000)).toBe(
      finishBy - 180_000 - REVAMP_WORK_BUDGET.finalChecksMs - 5_000,
    );
    expect(revampPaidAdmissionEndsAt(finishBy, 360_000)).toBeLessThan(
      revampPaidAdmissionEndsAt(finishBy, 180_000),
    );
  });
});

it("uses an explicit recovery version, never the performance target as expiry", () => {
  expect(revampRecovers({ recoveryVersion: 2 })).toBe(true);
  for (const value of [
    undefined,
    null,
    {},
    { recoveryVersion: "2" },
    { recoveryVersion: 1 },
  ])
    expect(revampRecovers(value)).toBe(false);
  expect(REVAMP_WORK_BUDGET.targetMs).toBe(12 * 60_000);
});
