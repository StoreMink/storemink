import { describe, expect, it } from "vitest";
import {
  REVAMP_RECOVERY_CEILING_MS,
  REVAMP_WORK_BUDGET,
  revampEpochMs,
  revampRecovers,
} from "./pacing-policy";

describe("recovery policy", () => {
  it("accepts only a persisted integer timestamp", () => {
    for (const value of [undefined, null, "1000", -1, NaN, Infinity, 1.5])
      expect(revampEpochMs(value)).toBeNull();
    expect(revampEpochMs(1_800_000_000_000)).toBe(1_800_000_000_000);
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

  it("★ still ends a recoverable job that never finishes, hours past its target", () => {
    expect(REVAMP_RECOVERY_CEILING_MS).toBe(6 * 60 * 60_000);
    expect(REVAMP_RECOVERY_CEILING_MS).toBeGreaterThan(
      REVAMP_WORK_BUDGET.targetMs * 10,
    );
  });
});
