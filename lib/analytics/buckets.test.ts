import { describe, expect, it } from "vitest";
import {
  bucketGrain,
  bucketIsPartial,
  bucketKeys,
  bucketLabel,
  bucketTitle,
} from "./buckets";
import { parseAnalyticsRange } from "./range";

const NOW = new Date("2026-08-18T10:30:00.000Z"); // Tue 18 Aug, 16:00 IST

describe("analytics buckets", () => {
  it("lists every day in the window, including quiet ones", () => {
    const range = parseAnalyticsRange(
      { range: "7d", compare: "none" },
      "Asia/Kolkata",
      NOW,
    );
    const keys = bucketKeys(range.current, "day", range.timeZone);
    expect(keys).toEqual([
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
      "2026-08-17",
      "2026-08-18",
    ]);
  });

  it("uses the store's calendar, not UTC, for the day boundary", () => {
    // 20:00 UTC on the 17th is already 01:30 on the 18th in Kolkata.
    const window = {
      from: new Date("2026-08-17T20:00:00.000Z"),
      to: new Date("2026-08-17T21:00:00.000Z"),
    };
    expect(bucketKeys(window, "day", "Asia/Kolkata")).toEqual(["2026-08-18"]);
    expect(bucketKeys(window, "day", "UTC")).toEqual(["2026-08-17"]);
  });

  it("starts weeks on Monday like Postgres date_trunc", () => {
    const window = {
      from: new Date("2026-08-05T00:00:00.000Z"), // Wednesday
      to: new Date("2026-08-19T00:00:00.000Z"),
    };
    expect(bucketKeys(window, "week", "UTC")).toEqual([
      "2026-08-03",
      "2026-08-10",
      "2026-08-17",
    ]);
  });

  it("steps months across a year boundary", () => {
    const window = {
      from: new Date("2025-11-15T00:00:00.000Z"),
      to: new Date("2026-02-02T00:00:00.000Z"),
    };
    expect(bucketKeys(window, "month", "UTC")).toEqual([
      "2025-11-01",
      "2025-12-01",
      "2026-01-01",
      "2026-02-01",
    ]);
  });

  it("returns nothing for an empty or inverted window", () => {
    const at = new Date("2026-08-18T00:00:00.000Z");
    expect(bucketKeys({ from: at, to: at }, "day", "UTC")).toEqual([]);
  });

  it("picks a grain from the window length", () => {
    const day = (n: number) => ({
      from: new Date(0),
      to: new Date(n * 86_400_000),
    });
    expect(bucketGrain(day(30))).toBe("day");
    expect(bucketGrain(day(90))).toBe("week");
    expect(bucketGrain(day(365))).toBe("month");
  });

  it("labels axis ticks briefly and tooltips in full", () => {
    expect(bucketLabel("2026-08-12", "day")).toBe("12 Aug");
    expect(bucketTitle("2026-08-12", "day")).toBe("Wed, 12 Aug 2026");
    expect(bucketTitle("2026-08-10", "week")).toBe("Week of 10 Aug 2026");
    expect(bucketTitle("2026-08-01", "month")).toBe("Aug 2026");
  });
});

describe("partial buckets", () => {
  it("marks the in-progress day and week, not the complete ones", () => {
    const range = parseAnalyticsRange(
      { range: "7d", compare: "none" },
      "Asia/Kolkata",
      NOW,
    );
    const keys = bucketKeys(range.current, "day", range.timeZone);
    const partial = keys.map((key) =>
      bucketIsPartial(key, "day", range.current, range.timeZone),
    );
    // Today (18 Aug) is still in progress; the six days before are complete.
    expect(partial).toEqual([false, false, false, false, false, false, true]);
  });

  it("marks a week the range only starts part-way through", () => {
    const window = {
      from: new Date("2026-08-05T00:00:00.000Z"), // Wednesday
      to: new Date("2026-08-24T00:00:00.000Z"), // the following Monday
    };
    expect(
      bucketKeys(window, "week", "UTC").map((key) =>
        bucketIsPartial(key, "week", window, "UTC"),
      ),
    ).toEqual([true, false, false]);
  });
});
