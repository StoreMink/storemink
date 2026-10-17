import { describe, expect, it, vi } from "vitest";
import type { MinkActorContext } from "../types";

const holder = vi.hoisted(() => {
  const from = new Date("2026-09-17T18:30:00.000Z");
  const to = new Date("2026-10-17T18:30:00.000Z");
  type ExploreRows = Array<{
    label: string;
    title: string;
    values: number[];
    previous: Array<number | null>;
  }>;
  type ExploreResult = {
    rows: ExploreRows;
    totals: number[];
    previousTotals: number[] | null;
    truncated: boolean;
  };
  const range = (comparison: "previous" | "year" | "none") => ({
    preset: "30d",
    comparison,
    current: { from, to },
    compare:
      comparison === "none"
        ? null
        : { from: new Date("2026-08-18T18:30:00.000Z"), to: from },
    timeZone: "Asia/Kolkata",
    label: "18 Sep 2026 to 17 Oct 2026",
    comparisonLabel:
      comparison === "none" ? null : "19 Aug 2026 to 17 Sep 2026",
    customFrom: "",
    customTo: "",
    compareFrom: "",
    compareTo: "",
  });
  const rows: ExploreRows = [
    {
      label: "1 Oct",
      title: "1 Oct 2026",
      values: [100, 4],
      previous: [80, 5],
    },
    {
      label: "2 Oct",
      title: "2 Oct 2026",
      values: [250, 6],
      previous: [100, 3],
    },
  ];
  return {
    range,
    rows,
    runExploration: vi.fn<(input: unknown) => Promise<ExploreResult>>(
      async () => ({
        rows,
        totals: [350, 10],
        previousTotals: [180, 8],
        truncated: false,
      }),
    ),
    storeHasAnalyticsFeature: vi.fn(async () => false),
    resolveMinkLocation: vi.fn(async () => ({
      locationIds: null,
      selectedId: null,
      label: "All locations",
      includeUnassigned: true,
      availableLocations: [],
    })),
    parseAnalyticsRange: vi.fn((input: { compare?: string }) =>
      range((input.compare ?? "previous") as "previous" | "year" | "none"),
    ),
  };
});

vi.mock("@/app/dashboard/analytics/reports/explore-data", () => ({
  runExploration: holder.runExploration,
}));
vi.mock("@/lib/analytics/store-entitlement", () => ({
  storeHasAnalyticsFeature: holder.storeHasAnalyticsFeature,
}));
vi.mock("@/lib/analytics/range", () => ({
  parseAnalyticsRange: holder.parseAnalyticsRange,
}));
vi.mock("./location-scope", () => ({
  resolveMinkLocation: holder.resolveMinkLocation,
}));

import { MinkToolInputError } from "../errors";
import { queryAnalytics } from "./analytics-tools";

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
};

const SUMMARY = {
  total: 350,
  previousTotal: 180,
  trendPercent: 94.44,
  comparisonLabel: "previous 30 days",
  goodWhen: "up",
};

describe("query_analytics", () => {
  it("leads the chart with the period total, its trend and period-named series", async () => {
    const output = await queryAnalytics.execute(ACTOR, {
      metric: "total_sales",
    });
    expect(holder.runExploration).toHaveBeenCalledTimes(1);
    expect(holder.runExploration.mock.calls[0][0]).toMatchObject({
      storeId: "store-1",
      config: { metrics: ["total_sales"], dimension: "day", chart: "line" },
    });
    expect(output).toMatchObject({
      total: 350,
      previousTotal: 180,
      trendPercent: 94.44,
      comparison: { type: "previous", shortLabel: "previous 30 days" },
      chart: { kind: "line", summary: SUMMARY },
    });
    expect(output.secondMetric).toBeUndefined();

    const artifact = queryAnalytics.artifact?.(output);
    expect(artifact).toMatchObject({
      type: "chart",
      title: "Total sales by day",
      format: "currency",
      currency: "INR",
      summary: SUMMARY,
      filters: [
        { label: "Period", value: "18 Sep 2026 to 17 Oct 2026" },
        {
          label: "Location",
          value: "All locations plus online or unassigned orders",
        },
      ],
    });
    const chart = artifact as Extract<
      NonNullable<typeof artifact>,
      { type: "chart" }
    >;
    expect(chart.series.map((series) => series.label)).toEqual([
      "This period",
      "Previous period",
    ]);
    expect(chart.series[1].points).toEqual([
      { label: "1 Oct", value: 80 },
      { label: "2 Oct", value: 100 },
    ]);
    expect(chart.panels).toBeUndefined();
  });

  it("draws a second measure from the same query as a small multiple", async () => {
    const output = await queryAnalytics.execute(ACTOR, {
      metric: "total_sales",
      second_metric: "orders",
    });
    expect(holder.runExploration).toHaveBeenCalledTimes(1);
    expect(holder.runExploration.mock.calls[0][0]).toMatchObject({
      config: { metrics: ["total_sales", "orders"] },
    });
    expect(output).toMatchObject({
      secondMetric: {
        key: "orders",
        label: "Orders",
        format: "number",
        total: 10,
        previousTotal: 8,
        trendPercent: 25,
      },
      rows: [
        {
          label: "1 Oct",
          value: 100,
          previous: 80,
          secondValue: 4,
          secondPrevious: 5,
        },
        {
          label: "2 Oct",
          value: 250,
          previous: 100,
          secondValue: 6,
          secondPrevious: 3,
        },
      ],
    });
    expect(String(output.dashboardPath)).toContain("total_sales");
    expect(String(output.dashboardPath)).toContain("orders");

    const artifact = queryAnalytics.artifact?.(output);
    expect(artifact).toMatchObject({
      type: "chart",
      title: "Total sales by day",
      summary: SUMMARY,
      panels: [
        {
          title: "Orders by day",
          kind: "line",
          format: "number",
          currency: "INR",
          series: [
            {
              label: "This period",
              points: [
                { label: "1 Oct", value: 4 },
                { label: "2 Oct", value: 6 },
              ],
            },
            { label: "Previous period" },
          ],
          summary: {
            total: 10,
            previousTotal: 8,
            trendPercent: 25,
            comparisonLabel: "previous 30 days",
            goodWhen: "up",
          },
        },
      ],
    });
  });

  it("names a year comparison in the badge and the legend", async () => {
    const output = await queryAnalytics.execute(ACTOR, {
      metric: "total_sales",
      comparison: "year",
    });
    expect(output).toMatchObject({
      chart: { summary: { comparisonLabel: "same period last year" } },
    });
    const artifact = queryAnalytics.artifact?.(output) as {
      series: Array<{ label: string }>;
    };
    expect(artifact.series.map((series) => series.label)).toEqual([
      "This period",
      "Same period last year",
    ]);
  });

  it("sends no comparison figures when none was asked for", async () => {
    holder.runExploration.mockResolvedValueOnce({
      rows: holder.rows.map((row) => ({ ...row, previous: [null, null] })),
      totals: [350, 10],
      previousTotals: null,
      truncated: false,
    });
    const output = await queryAnalytics.execute(ACTOR, {
      metric: "total_sales",
      comparison: "none",
    });
    expect(output.comparison).toBeNull();
    expect(output).toMatchObject({
      chart: { summary: { total: 350, trendPercent: null, goodWhen: "up" } },
    });
    const chart = output.chart as { summary: Record<string, unknown> };
    expect(chart.summary.previousTotal).toBeUndefined();
    expect(chart.summary.comparisonLabel).toBeUndefined();
    const artifact = queryAnalytics.artifact?.(output) as {
      series: Array<{ label: string }>;
    };
    expect(artifact.series.map((series) => series.label)).toEqual([
      "Total sales",
    ]);
  });

  it("marks discounts and returns as good when down", async () => {
    const discounts = await queryAnalytics.execute(ACTOR, {
      metric: "discounts",
    });
    expect(discounts).toMatchObject({
      chart: { summary: { goodWhen: "down" } },
    });
    const returns = await queryAnalytics.execute(ACTOR, {
      metric: "orders",
      second_metric: "returns",
    });
    expect(returns).toMatchObject({
      chart: {
        summary: { goodWhen: "up" },
        panels: [{ summary: { goodWhen: "down" } }],
      },
    });
  });

  it("draws a breakdown as bars named after the measure, bounded by the limit", async () => {
    const output = await queryAnalytics.execute(ACTOR, {
      metric: "gross_sales",
      group_by: "product",
      limit: 1,
    });
    expect(holder.runExploration.mock.calls[0][0]).toMatchObject({
      config: { dimension: "product", chart: "bar" },
    });
    expect(output).toMatchObject({ truncated: true });
    expect((output.rows as unknown[]).length).toBe(1);
    const artifact = queryAnalytics.artifact?.(output) as {
      kind: string;
      series: Array<{ label: string }>;
    };
    expect(artifact.kind).toBe("bar");
    expect(artifact.series.map((series) => series.label)).toEqual([
      "Gross sales",
    ]);
  });

  it("refuses a second measure that repeats, crosses datasets or does not fit the grouping", async () => {
    await expect(
      queryAnalytics.execute(ACTOR, {
        metric: "total_sales",
        second_metric: "total_sales",
      }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(
      queryAnalytics.execute(ACTOR, {
        metric: "total_sales",
        second_metric: "sessions",
      }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(
      queryAnalytics.execute(ACTOR, {
        metric: "gross_sales",
        group_by: "product",
        second_metric: "average_order_value",
      }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    await expect(
      queryAnalytics.execute(ACTOR, {
        metric: "total_sales",
        second_metric: "bogus",
      }),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    expect(holder.runExploration).not.toHaveBeenCalled();
  });

  it("declares second_metric on the same closed whitelist as metric", () => {
    const properties = queryAnalytics.declaration.parametersJsonSchema
      .properties as Record<string, { enum?: string[] }>;
    expect(properties.second_metric.enum).toEqual(properties.metric.enum);
  });
});
