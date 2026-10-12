import { describe, expect, it } from "vitest";
import { WIDGETS, type WidgetId } from "@/app/dashboard/analytics/widgets";
import {
  analyticsWidgetGridRows,
  availableWidgetSizes,
  defaultAnalyticsSections,
  layoutForViewer,
  sanitizeAnalyticsLayoutInput,
  sanitizeStoredAnalyticsLayout,
} from "./layout";

describe("analytics layout v2 contract", () => {
  const allowed = ["metric_revenue", "metric_orders"] as const;

  it("builds named defaults with semantic sizes", () => {
    expect(defaultAnalyticsSections(allowed)).toEqual([
      {
        id: "overview",
        title: "Overview",
        hidden: false,
        items: [
          { widgetId: "metric_revenue", size: "compact" },
          { widgetId: "metric_orders", size: "compact" },
        ],
      },
    ]);
    expect(availableWidgetSizes("revenue_chart")).toEqual(["half", "full"]);
  });

  it("gives every editor card a stable vertical grid footprint", () => {
    const all = Object.keys(WIDGETS) as WidgetId[];
    expect(all.every((widgetId) => analyticsWidgetGridRows(widgetId) > 0)).toBe(
      true,
    );
    expect(analyticsWidgetGridRows("metric_revenue")).toBe(2);
    expect(analyticsWidgetGridRows("blog_approvals")).toBe(6);
    expect(analyticsWidgetGridRows("revenue_chart")).toBe(7);
  });

  it("uses the seller-performance cards for untouched dashboards", () => {
    const all = Object.keys(WIDGETS) as WidgetId[];
    expect(
      defaultAnalyticsSections(all).map((section) => ({
        title: section.title,
        cards: section.items.map((item) => item.widgetId),
      })),
    ).toEqual([
      {
        title: "Overview",
        cards: [
          "metric_revenue",
          "metric_orders",
          "metric_aov",
          "metric_returning_rate",
        ],
      },
      {
        title: "Sales",
        cards: [
          "revenue_chart",
          "sales_breakdown",
          "top_products",
          "top_categories",
          "sales_by_discount",
          "sales_by_channel",
          "sales_by_location",
        ],
      },
      {
        title: "Orders",
        cards: ["orders_chart", "aov_chart"],
      },
      {
        title: "Customers",
        cards: ["customer_mix", "sales_by_region"],
      },
      {
        title: "Discounts and returns",
        cards: ["discount_impact", "returns_refunds"],
      },
      {
        title: "Profit",
        cards: ["gross_margin_overview"],
      },
      {
        title: "Google Search",
        cards: [
          "search_clicks",
          "search_impressions",
          "search_ctr",
          "search_position",
          "search_trend",
          "search_queries",
          "search_pages",
          "search_devices",
          "search_countries",
        ],
      },
      {
        title: "Storefront traffic",
        cards: [
          "traffic_visitors",
          "traffic_sessions",
          "traffic_page_views",
          "traffic_conversion",
          "traffic_sessions_chart",
          "traffic_funnel",
          "traffic_devices",
          "traffic_sources",
          "sales_by_source",
          "traffic_locations",
          "traffic_landing_pages",
        ],
      },
    ]);
  });

  it("strictly validates section titles, ids, unique cards, and minimum sizes", () => {
    const valid = {
      defaultRevision: 2,
      sections: [
        {
          id: "sales",
          title: "Sales",
          hidden: false,
          items: [{ widgetId: "revenue_chart", size: "half" }],
        },
      ],
    };
    expect(sanitizeAnalyticsLayoutInput(valid)).toEqual(valid);
    expect(
      sanitizeAnalyticsLayoutInput({
        ...valid,
        sections: [{ ...valid.sections[0], title: " " }],
      }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsLayoutInput({
        ...valid,
        sections: [
          {
            ...valid.sections[0],
            items: [{ widgetId: "revenue_chart", size: "compact" }],
          },
        ],
      }),
    ).toBeNull();
  });

  it("migrates a v1 flat order without changing its order", () => {
    expect(
      sanitizeStoredAnalyticsLayout({
        defaultRevision: 1,
        widgetIds: ["metric_orders", "metric_revenue"],
      }),
    ).toEqual({
      defaultRevision: 2,
      sections: [
        {
          id: "overview",
          title: "Overview",
          hidden: false,
          items: [
            { widgetId: "metric_orders", size: "compact" },
            { widgetId: "metric_revenue", size: "compact" },
          ],
        },
      ],
    });
  });

  it("ignores retired stored cards but rejects them on client writes", () => {
    const stored = {
      defaultRevision: 2,
      sections: [
        {
          id: "overview",
          title: "Overview",
          hidden: false,
          items: [
            { widgetId: "retired_widget", size: "compact" },
            { widgetId: "metric_orders", size: "compact" },
          ],
        },
      ],
    };
    expect(sanitizeStoredAnalyticsLayout(stored)?.sections[0].items).toEqual([
      { widgetId: "metric_orders", size: "compact" },
    ]);
    expect(sanitizeAnalyticsLayoutInput(stored)).toBeNull();
  });

  it("filters dormant cards without deleting their section metadata", () => {
    const result = layoutForViewer(
      {
        defaultRevision: 2,
        sections: [
          {
            id: "custom",
            title: "My section",
            hidden: true,
            items: [
              { widgetId: "metric_customers", size: "compact" },
              { widgetId: "metric_orders", size: "half" },
            ],
          },
        ],
      },
      allowed,
      true,
      "t1",
    );
    expect(result).toEqual({
      sections: [
        {
          id: "custom",
          title: "My section",
          hidden: true,
          items: [{ widgetId: "metric_orders", size: "half" }],
        },
      ],
      configured: true,
      updatedAt: "t1",
    });
  });
});

describe("plan sections in saved layouts", () => {
  const basic: WidgetId[] = ["metric_revenue", "search_clicks", "search_trend"];
  const pro: WidgetId[] = [
    ...basic,
    "metric_gross_profit",
    "gross_margin_overview",
  ];
  const savedOnBasic = {
    defaultRevision: 2,
    sections: [
      {
        id: "mine",
        title: "My cards",
        hidden: false,
        items: [
          { widgetId: "metric_revenue", size: "compact" },
          { widgetId: "search_clicks", size: "compact" },
        ],
      },
    ],
    acknowledged: ["google-search"],
  };

  it("adds a section the store just unlocked to a layout saved before it", () => {
    const view = layoutForViewer(savedOnBasic, pro, true, null);
    expect(view.sections.map((section) => section.id)).toEqual([
      "mine",
      "profit",
    ]);
    expect(view.sections[1].items.map((item) => item.widgetId)).toEqual([
      "gross_margin_overview",
    ]);
  });

  it("does not re-add a plan section the merchant already had and removed", () => {
    const view = layoutForViewer(
      { ...savedOnBasic, acknowledged: ["google-search", "profit"] },
      pro,
      true,
      null,
    );
    expect(view.sections.map((section) => section.id)).toEqual(["mine"]);
  });

  it("does not duplicate a plan section whose cards are already placed", () => {
    // google-search is not acknowledged here, but its cards are in "mine".
    const view = layoutForViewer(
      { ...savedOnBasic, acknowledged: undefined },
      basic,
      true,
      null,
    );
    expect(view.sections.map((section) => section.id)).toEqual(["mine"]);
  });

  it("never trusts acknowledged sections from client input", () => {
    const input = sanitizeAnalyticsLayoutInput(savedOnBasic);
    expect(input).not.toBeNull();
    expect(input).not.toHaveProperty("acknowledged");
    expect(sanitizeStoredAnalyticsLayout(savedOnBasic)?.acknowledged).toEqual([
      "google-search",
    ]);
  });
});
