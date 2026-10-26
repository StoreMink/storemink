// Custom reports ("explorations"): what a merchant can measure and how they
// can group it. Pure module, shared by the builder UI, the server executor
// and the save action.
//
// ★ A WHITELIST, NOT A QUERY LANGUAGE. Shopify exposes ShopifyQL; we expose a
// fixed menu of measures and groupings, each mapped to SQL on the server, so
// a saved report can never reach outside the store or its viewer's location
// scope, and every number matches the dashboard card it shares a name with.

import type { AnalyticsValueFormat } from "@/app/dashboard/components/analytics-format";

export const EXPLORE_DATASETS = ["sales", "traffic"] as const;
export type ExploreDataset = (typeof EXPLORE_DATASETS)[number];

export const TIME_DIMENSIONS = ["day", "week", "month"] as const;
export type TimeDimension = (typeof TIME_DIMENSIONS)[number];

export type SalesDimension =
  | TimeDimension
  | "product"
  | "category"
  | "channel"
  | "location"
  | "discount_code"
  | "region"
  | "customer_type";

export type TrafficExploreDimension =
  | TimeDimension
  | "device"
  | "source"
  | "referrer"
  | "landing_page"
  | "campaign"
  | "country"
  | "region"
  | "city";

export type ExploreDimension = SalesDimension | TrafficExploreDimension;

export type SalesMetric =
  | "total_sales"
  | "gross_sales"
  | "discounts"
  | "returns"
  | "net_sales"
  | "shipping"
  | "taxes"
  | "orders"
  | "units"
  | "average_order_value";

export type TrafficMetric =
  | "sessions"
  | "visitors"
  | "page_views"
  | "converted_sessions"
  | "conversion_rate"
  | "traffic_sales";

export type ExploreMetric = SalesMetric | TrafficMetric;

export interface MetricMeta {
  label: string;
  format: AnalyticsValueFormat;
  /** Lower is better (refunds, discounts): trends colour the other way. */
  lowerIsBetter?: boolean;
}

export const EXPLORE_METRICS: Record<ExploreMetric, MetricMeta> = {
  total_sales: { label: "Total sales", format: "currency" },
  gross_sales: { label: "Gross sales", format: "currency" },
  discounts: { label: "Discounts", format: "currency", lowerIsBetter: true },
  returns: { label: "Returns", format: "currency", lowerIsBetter: true },
  net_sales: { label: "Net sales", format: "currency" },
  shipping: { label: "Shipping charges", format: "currency" },
  taxes: { label: "Taxes", format: "currency" },
  orders: { label: "Orders", format: "number" },
  units: { label: "Units sold", format: "number" },
  average_order_value: { label: "Average order value", format: "currency" },
  sessions: { label: "Sessions", format: "number" },
  visitors: { label: "Visitors", format: "number" },
  page_views: { label: "Page views", format: "number" },
  converted_sessions: { label: "Converted sessions", format: "number" },
  conversion_rate: { label: "Conversion rate", format: "percent" },
  traffic_sales: { label: "Sales from sessions", format: "currency" },
};

export const EXPLORE_DIMENSION_LABELS: Record<ExploreDimension, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  product: "Product",
  category: "Product category",
  channel: "Sales channel",
  location: "Location",
  discount_code: "Discount code",
  region: "Region",
  customer_type: "New or returning customer",
  device: "Device type",
  source: "Traffic source",
  referrer: "Referring site",
  landing_page: "Landing page",
  campaign: "Campaign",
  country: "Country",
  city: "City",
};

const SALES_DIMENSIONS: readonly SalesDimension[] = [
  "day",
  "week",
  "month",
  "product",
  "category",
  "channel",
  "location",
  "discount_code",
  "region",
  "customer_type",
];
const TRAFFIC_DIMENSIONS: readonly TrafficExploreDimension[] = [
  "day",
  "week",
  "month",
  "source",
  "device",
  "landing_page",
  "referrer",
  "campaign",
  "country",
  "region",
  "city",
];

const SALES_METRICS: readonly SalesMetric[] = [
  "total_sales",
  "gross_sales",
  "discounts",
  "returns",
  "net_sales",
  "shipping",
  "taxes",
  "orders",
  "units",
  "average_order_value",
];
const TRAFFIC_METRICS: readonly TrafficMetric[] = [
  "sessions",
  "visitors",
  "page_views",
  "converted_sessions",
  "conversion_rate",
  "traffic_sales",
];

/**
 * Product and category split ORDER LINES, so only line measures make sense:
 * an order's shipping or order-level discount does not belong to one product.
 */
const ITEM_DIMENSIONS = new Set<ExploreDimension>(["product", "category"]);
const ITEM_METRICS = new Set<ExploreMetric>(["gross_sales", "units", "orders"]);

export function dimensionsFor(dataset: ExploreDataset): ExploreDimension[] {
  return [...(dataset === "sales" ? SALES_DIMENSIONS : TRAFFIC_DIMENSIONS)];
}

export function metricsFor(
  dataset: ExploreDataset,
  dimension: ExploreDimension,
): ExploreMetric[] {
  if (dataset === "traffic") {
    // Daily totals carry no sales figure; the per-dimension rollup does.
    return TRAFFIC_METRICS.filter(
      (metric) =>
        metric !== "traffic_sales" ||
        !(TIME_DIMENSIONS as readonly string[]).includes(dimension),
    );
  }
  return ITEM_DIMENSIONS.has(dimension)
    ? SALES_METRICS.filter((metric) => ITEM_METRICS.has(metric))
    : [...SALES_METRICS];
}

export function isTimeDimension(
  dimension: ExploreDimension,
): dimension is TimeDimension {
  return (TIME_DIMENSIONS as readonly string[]).includes(dimension);
}

export type ExploreChart = "line" | "bar" | "table";

export interface ExploreConfig {
  dataset: ExploreDataset;
  metrics: ExploreMetric[];
  dimension: ExploreDimension;
  chart: ExploreChart;
}

export const MAX_EXPLORE_METRICS = 4;
export const MAX_SAVED_REPORTS = 50;

export const DEFAULT_EXPLORE_CONFIG: ExploreConfig = {
  dataset: "sales",
  metrics: ["total_sales", "orders"],
  dimension: "day",
  chart: "line",
};

/**
 * Coerce untrusted input (URL params, a saved row) to a valid config:
 * unknown values fall back, incompatible measures are dropped, at least one
 * measure always remains. `trafficAllowed` keeps the traffic dataset on Pro.
 */
export function normalizeExploreConfig(
  raw: Partial<Record<keyof ExploreConfig, unknown>>,
  options: { trafficAllowed: boolean },
): ExploreConfig {
  const dataset: ExploreDataset =
    raw.dataset === "traffic" && options.trafficAllowed ? "traffic" : "sales";
  const dimensions = dimensionsFor(dataset);
  const dimension = dimensions.includes(raw.dimension as ExploreDimension)
    ? (raw.dimension as ExploreDimension)
    : "day";
  const allowed = metricsFor(dataset, dimension);
  const requested = Array.isArray(raw.metrics)
    ? raw.metrics
    : typeof raw.metrics === "string"
      ? raw.metrics.split(",")
      : [];
  const metrics = [
    ...new Set(
      requested.filter((metric): metric is ExploreMetric =>
        allowed.includes(metric as ExploreMetric),
      ),
    ),
  ].slice(0, MAX_EXPLORE_METRICS);
  const chart: ExploreChart =
    raw.chart === "bar" || raw.chart === "table" || raw.chart === "line"
      ? raw.chart
      : isTimeDimension(dimension)
        ? "line"
        : "bar";
  return {
    dataset,
    dimension,
    metrics: metrics.length
      ? metrics
      : [
          dataset === "sales"
            ? allowed.includes("total_sales")
              ? "total_sales"
              : "gross_sales"
            : "sessions",
        ],
    chart,
  };
}

/** The config as URL params (the builder's state lives in the URL). */
export function exploreSearch(config: ExploreConfig): Record<string, string> {
  return {
    ds: config.dataset,
    m: config.metrics.join(","),
    by: config.dimension,
    chart: config.chart,
  };
}

export function exploreConfigFromSearch(
  params: Record<string, string | string[] | undefined>,
  options: { trafficAllowed: boolean },
): ExploreConfig {
  const one = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  return normalizeExploreConfig(
    {
      dataset: one(params.ds),
      metrics: one(params.m),
      dimension: one(params.by),
      chart: one(params.chart),
    },
    options,
  );
}

/** Validate a saved report name. */
export function cleanReportName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name && name.length <= 80 ? name : null;
}

// ---------------------------------------------------------------------------
// The report library: ready-made reports grouped like Shopify's categories.
// Most open the builder with a preset config, so the library grows without a
// bespoke page per report; a few are the fixed drill-down reports.
// ---------------------------------------------------------------------------

export type ReportCategory =
  | "Sales"
  | "Orders"
  | "Customers"
  | "Products"
  | "Traffic"
  | "Search";

export interface LibraryReport {
  id: string;
  title: string;
  description: string;
  category: ReportCategory;
  /** A preset for the builder, or a fixed drill-down report id. */
  config?: ExploreConfig;
  fixed?: "total-sales" | "sales-over-time" | "top-products" | "search-queries";
  /** Needs Pro storefront analytics. */
  traffic?: boolean;
  /** Needs Google Search (Basic and above). */
  search?: boolean;
}

const preset = (
  dataset: ExploreDataset,
  dimension: ExploreDimension,
  metrics: ExploreMetric[],
  chart: ExploreChart,
): ExploreConfig => ({ dataset, dimension, metrics, chart });

export const REPORT_LIBRARY: LibraryReport[] = [
  {
    id: "total-sales",
    title: "Total sales",
    description: "Every sale and settled refund that makes up net sales.",
    category: "Sales",
    fixed: "total-sales",
  },
  {
    id: "sales-over-time",
    title: "Sales over time",
    description: "Net sales, orders and units by day, week or month.",
    category: "Sales",
    fixed: "sales-over-time",
  },
  {
    id: "sales-breakdown-by-month",
    title: "Total sales breakdown by month",
    description: "Gross sales, discounts, returns and net sales each month.",
    category: "Sales",
    config: preset(
      "sales",
      "month",
      ["gross_sales", "discounts", "returns", "net_sales"],
      "table",
    ),
  },
  {
    id: "sales-by-channel",
    title: "Sales by channel",
    description: "Online store against POS.",
    category: "Sales",
    config: preset(
      "sales",
      "channel",
      ["total_sales", "orders", "average_order_value"],
      "bar",
    ),
  },
  {
    id: "sales-by-location",
    title: "Sales by location",
    description: "Sales at each of your shops and online.",
    category: "Sales",
    config: preset("sales", "location", ["total_sales", "orders"], "bar"),
  },
  {
    id: "sales-by-discount",
    title: "Sales by discount code",
    description: "Sales and markdowns for each discount code.",
    category: "Sales",
    config: preset(
      "sales",
      "discount_code",
      ["total_sales", "orders", "discounts"],
      "bar",
    ),
  },
  {
    id: "sales-by-region",
    title: "Sales by customer region",
    description: "Online sales by the state or country delivered to.",
    category: "Customers",
    config: preset("sales", "region", ["total_sales", "orders"], "bar"),
  },
  {
    id: "new-vs-returning",
    title: "Sales by new and returning customers",
    description: "How much comes from first-time buyers against regulars.",
    category: "Customers",
    config: preset(
      "sales",
      "customer_type",
      ["total_sales", "orders", "average_order_value"],
      "bar",
    ),
  },
  {
    id: "orders-over-time",
    title: "Orders over time",
    description: "Orders and average order value by day, week or month.",
    category: "Orders",
    config: preset("sales", "day", ["orders", "average_order_value"], "line"),
  },
  {
    id: "shipping-and-taxes",
    title: "Shipping and taxes by month",
    description: "Shipping charges and taxes collected each month.",
    category: "Orders",
    config: preset("sales", "month", ["shipping", "taxes", "orders"], "table"),
  },
  {
    id: "top-products",
    title: "Product sales",
    description: "Products ranked by units sold and merchandise value.",
    category: "Products",
    fixed: "top-products",
  },
  {
    id: "sales-by-category",
    title: "Sales by product category",
    description: "Units and gross sales for each category.",
    category: "Products",
    config: preset(
      "sales",
      "category",
      ["gross_sales", "units", "orders"],
      "bar",
    ),
  },
  {
    id: "sessions-over-time",
    title: "Sessions over time",
    description: "Sessions, visitors and conversion rate each day.",
    category: "Traffic",
    config: preset(
      "traffic",
      "day",
      ["sessions", "visitors", "conversion_rate"],
      "line",
    ),
    traffic: true,
  },
  {
    id: "sessions-by-source",
    title: "Sessions by traffic source",
    description: "Sessions, conversion and sales by how visits started.",
    category: "Traffic",
    config: preset(
      "traffic",
      "source",
      ["sessions", "conversion_rate", "traffic_sales"],
      "bar",
    ),
    traffic: true,
  },
  {
    id: "sessions-by-device",
    title: "Sessions by device type",
    description: "Mobile, desktop and tablet sessions and conversion.",
    category: "Traffic",
    config: preset("traffic", "device", ["sessions", "conversion_rate"], "bar"),
    traffic: true,
  },
  {
    id: "sessions-by-landing-page",
    title: "Sessions by landing page",
    description: "Which first pages convert best.",
    category: "Traffic",
    config: preset(
      "traffic",
      "landing_page",
      ["sessions", "converted_sessions", "conversion_rate"],
      "table",
    ),
    traffic: true,
  },
  {
    id: "sessions-by-city",
    title: "Sessions by city",
    description: "Where your visitors are, and how they convert.",
    category: "Traffic",
    config: preset(
      "traffic",
      "city",
      ["sessions", "conversion_rate", "traffic_sales"],
      "bar",
    ),
    traffic: true,
  },
  {
    id: "sessions-by-campaign",
    title: "Sessions by campaign",
    description: "Visits and sales from links tagged with utm_campaign.",
    category: "Traffic",
    config: preset(
      "traffic",
      "campaign",
      ["sessions", "converted_sessions", "traffic_sales"],
      "table",
    ),
    traffic: true,
  },
  {
    id: "search-queries",
    title: "Google Search queries",
    description:
      "Search terms ranked by clicks, with impressions, CTR and position.",
    category: "Search",
    fixed: "search-queries",
    search: true,
  },
];

export const REPORT_CATEGORIES: ReportCategory[] = [
  "Sales",
  "Orders",
  "Customers",
  "Products",
  "Traffic",
  "Search",
];
