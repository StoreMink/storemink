import { describe, expect, it } from "vitest";
import {
  targetPeriodPresets,
  targetProgress,
  validateTargetInput,
} from "./targets";

const october = {
  metric: "total_sales" as const,
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  targetValue: 100_000,
};

describe("analytics targets", () => {
  it("judges a sum target against the share of the period gone by", () => {
    // Day 15 of 31: about 47% expected.
    expect(
      targetProgress({ ...october, current: 50_000, today: "2026-10-15" }),
    ).toMatchObject({ status: "on_track", daysLeft: 17 });
    expect(
      targetProgress({ ...october, current: 30_000, today: "2026-10-15" })
        .status,
    ).toBe("behind");
  });

  it("does not call a target behind on its first morning", () => {
    expect(
      targetProgress({ ...october, current: 1_700, today: "2026-10-01" })
        .status,
    ).toBe("on_track");
  });

  it("judges a ratio target against the target itself", () => {
    const aov = {
      ...october,
      metric: "average_order_value" as const,
      targetValue: 600,
    };
    expect(
      targetProgress({ ...aov, current: 580, today: "2026-10-02" }).status,
    ).toBe("behind");
    expect(
      targetProgress({ ...aov, current: 610, today: "2026-10-02" }).status,
    ).toBe("achieved");
  });

  it("settles finished and future periods", () => {
    expect(
      targetProgress({ ...october, current: 99_000, today: "2026-11-02" }),
    ).toMatchObject({ status: "missed", daysLeft: 0 });
    expect(
      targetProgress({ ...october, current: 0, today: "2026-09-20" }),
    ).toMatchObject({ status: "upcoming", daysLeft: 31 });
  });

  it("validates editor input and keeps traffic targets on Pro", () => {
    expect(validateTargetInput(october, { trafficAllowed: false }).ok).toBe(
      true,
    );
    expect(
      validateTargetInput(
        { ...october, metric: "sessions" },
        { trafficAllowed: false },
      ),
    ).toEqual({
      ok: false,
      error: "Storefront traffic targets need the Pro plan.",
    });
    expect(
      validateTargetInput(
        { ...october, periodEnd: "2026-09-30" },
        { trafficAllowed: true },
      ).ok,
    ).toBe(false);
    expect(
      validateTargetInput(
        { ...october, periodStart: "2026-02-30" },
        { trafficAllowed: true },
      ).ok,
    ).toBe(false);
    expect(
      validateTargetInput(
        { ...october, metric: "conversion_rate", targetValue: 140 },
        { trafficAllowed: true },
      ).ok,
    ).toBe(false);
  });

  it("offers calendar presets in the store's own dates", () => {
    const presets = targetPeriodPresets("2026-11-14");
    expect(presets.map((p) => [p.id, p.start, p.end])).toEqual([
      ["this_month", "2026-11-01", "2026-11-30"],
      ["next_month", "2026-12-01", "2026-12-31"],
      ["this_quarter", "2026-10-01", "2026-12-31"],
      ["this_year", "2026-01-01", "2026-12-31"],
    ]);
    expect(targetPeriodPresets("2026-12-05")[1]).toMatchObject({
      start: "2027-01-01",
      end: "2027-01-31",
    });
  });
});
