import { describe, expect, it } from "vitest";
import { buildInsights, type InsightInput } from "./insights";

function base(overrides: Partial<InsightInput> = {}): InsightInput {
  return {
    rangeLabel: "1 Sept 2026 – 30 Sept 2026",
    comparisonLabel: "2 Aug 2026 – 31 Aug 2026",
    sales: {
      current: 100_000,
      previous: 95_000,
      orders: 40,
      previousOrders: 38,
      aov: 2_500,
      previousAov: 2_450,
      series: [],
    },
    monthPace: null,
    products: [],
    customers: {
      total: 30,
      returningRate: 40,
      previousTotal: 28,
      previousReturningRate: 38,
    },
    refunds: { current: 1_000, previous: 900, grossSales: 110_000 },
    discounts: {
      current: 5_000,
      previous: 4_800,
      grossSales: 110_000,
      previousGrossSales: 105_000,
    },
    traffic: null,
    ...overrides,
  };
}

describe("analytics insights", () => {
  it("says nothing when nothing moved", () => {
    expect(buildInsights(base())).toEqual([]);
  });

  it("calls out a real sales move, with the question for Mink", () => {
    const [insight] = buildInsights(
      base({ sales: { ...base().sales, current: 150_000 } }),
    );
    expect(insight).toMatchObject({
      id: "sales_change",
      tone: "good",
      title: "Sales are up 58% on the previous period",
    });
    expect(insight.askMink).toContain("go up 58%");
  });

  it("stays quiet on too few orders to mean anything", () => {
    expect(
      buildInsights(
        base({
          sales: {
            ...base().sales,
            current: 9_000,
            previous: 2_000,
            orders: 3,
            previousOrders: 1,
          },
        }),
      ),
    ).toEqual([]);
  });

  it("reports the month's pace once a few days are in", () => {
    const pace = {
      monthName: "October",
      current: 60_000,
      lastMonthSameDays: 48_000,
      projected: 155_000,
      dayOfMonth: 12,
    };
    expect(buildInsights(base({ monthPace: pace }))[0]).toMatchObject({
      id: "month_pace",
      title: "October is on track to beat last month",
    });
    expect(
      buildInsights(base({ monthPace: { ...pace, dayOfMonth: 3 } })),
    ).toEqual([]);
  });

  it("finds the fastest-rising product, ignoring tiny numbers", () => {
    const insights = buildInsights(
      base({
        products: [
          { name: "Mango Lassi", units: 40, previousUnits: 20 },
          { name: "Cold Coffee", units: 4, previousUnits: 1 },
        ],
      }),
    );
    expect(insights.map((i) => i.title)).toEqual([
      "Mango Lassi is selling faster",
    ]);
  });

  it("flags rising refunds and the best-converting source", () => {
    const insights = buildInsights(
      base({
        refunds: { current: 9_000, previous: 3_000, grossSales: 110_000 },
        traffic: {
          conversionRate: 3,
          previousConversionRate: 3,
          sources: [
            { label: "Social", sessions: 200, converted: 12 },
            { label: "Search", sessions: 150, converted: 3 },
          ],
        },
      }),
    );
    expect(insights.map((i) => i.id)).toEqual([
      "refunds_rising",
      "best_source",
    ]);
  });

  it("never shows more than five", () => {
    const insights = buildInsights(
      base({
        sales: {
          ...base().sales,
          current: 150_000,
          aov: 3_500,
        },
        monthPace: {
          monthName: "October",
          current: 60_000,
          lastMonthSameDays: 40_000,
          projected: 150_000,
          dayOfMonth: 12,
        },
        refunds: { current: 9_000, previous: 3_000, grossSales: 110_000 },
        products: [{ name: "Mango Lassi", units: 40, previousUnits: 20 }],
        customers: {
          total: 30,
          returningRate: 60,
          previousTotal: 28,
          previousReturningRate: 38,
        },
        traffic: {
          conversionRate: 4,
          previousConversionRate: 3,
          sources: [{ label: "Social", sessions: 200, converted: 16 }],
        },
      }),
    );
    expect(insights).toHaveLength(5);
  });
});
