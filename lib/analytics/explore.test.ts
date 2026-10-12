import { describe, expect, it } from "vitest";
import {
  cleanReportName,
  exploreConfigFromSearch,
  metricsFor,
  normalizeExploreConfig,
} from "./explore";

describe("custom report configs", () => {
  it("keeps product and category to order-line measures", () => {
    expect(metricsFor("sales", "product")).toEqual([
      "gross_sales",
      "orders",
      "units",
    ]);
    expect(metricsFor("sales", "channel")).toContain("shipping");
  });

  it("drops measures that do not fit the grouping, never leaving none", () => {
    expect(
      normalizeExploreConfig(
        {
          dataset: "sales",
          dimension: "product",
          metrics: ["shipping", "units"],
        },
        { trafficAllowed: false },
      ),
    ).toMatchObject({ metrics: ["units"], chart: "bar" });
    expect(
      normalizeExploreConfig(
        { dataset: "sales", dimension: "product", metrics: ["shipping"] },
        { trafficAllowed: false },
      ).metrics,
    ).toEqual(["gross_sales"]);
  });

  it("keeps the traffic dataset on Pro", () => {
    expect(
      normalizeExploreConfig(
        { dataset: "traffic", dimension: "device", metrics: ["sessions"] },
        { trafficAllowed: false },
      ).dataset,
    ).toBe("sales");
    expect(
      normalizeExploreConfig(
        { dataset: "traffic", dimension: "day", metrics: ["traffic_sales"] },
        { trafficAllowed: true },
      ).metrics,
    ).toEqual(["sessions"]);
  });

  it("reads URL params, ignoring junk and capping at four measures", () => {
    expect(
      exploreConfigFromSearch(
        {
          ds: "sales",
          by: "nonsense",
          m: "orders,orders,units,taxes,shipping,discounts,; DROP TABLE",
        },
        { trafficAllowed: true },
      ),
    ).toEqual({
      dataset: "sales",
      dimension: "day",
      metrics: ["orders", "units", "taxes", "shipping"],
      chart: "line",
    });
  });

  it("validates report names", () => {
    expect(cleanReportName("  Diwali sales \u0000")).toBe("Diwali sales");
    expect(cleanReportName("")).toBeNull();
    expect(cleanReportName("x".repeat(81))).toBeNull();
  });
});
