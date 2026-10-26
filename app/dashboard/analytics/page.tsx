import { Suspense, type ReactNode } from "react";
import { cookies } from "next/headers";
import { ActivityFeed } from "../components/activity-feed";
import { AnalyticsCard, type ReportLock } from "../components/analytics-card";
import {
  AnalyticsDonut,
  AnalyticsTrendChart,
} from "../components/analytics-charts-lazy";
import { formatAnalyticsValue } from "../components/analytics-format";
import {
  FunnelBars,
  MetricRows,
  RankedBars,
  type RankedRow,
} from "../components/analytics-lists";
import { TrendBadge, trendPct } from "../components/analytics-trend";
import type { TrendPoint } from "../components/analytics-format";
import { BlogApprovals } from "../components/blog-approvals";
import { EnquiriesOverview } from "../components/enquiries-overview";
import { MetricCard } from "../components/metric-card";
import { RealtimeRefresher } from "../components/realtime-refresher";
import { RecentOrdersTable } from "../components/recent-orders-table";
import {
  SearchMetricCard,
  SearchRankingWidget,
  SearchTrendWidget,
} from "../components/search-widgets";
import { getActingStoreId, requireSectionAccess } from "../lib/access";
import { AnalyticsFilters } from "./analytics-filters";
import { DashboardCanvas } from "./dashboard-canvas";
import { PlanPreviewSection } from "./plan-preview";
import { cachedReaders, minuteNow } from "./cached";
import { AnalyticsTabs } from "./analytics-tabs";
import { TargetsManager } from "./targets-manager";
import {
  getTargetCards,
  listAnalyticsTargets,
  storeToday,
} from "./targets-data";
import { TargetCard } from "../components/analytics-target-card";
import { InsightsPanel } from "../components/analytics-insights";
import { buildInsights } from "@/lib/analytics/insights";
import { getMinkConfig } from "@/lib/mink/config";
import { isMinkStoreInvited } from "@/lib/mink/access";
import {
  TARGET_METRICS,
  TARGET_METRIC_META,
  targetPeriodPresets,
} from "@/lib/analytics/targets";
import {
  comparisonTrend,
  getActivity,
  getAnalyticsLocationOptions,
  getCustomerMix,
  getDiscountImpact,
  getInventoryVelocity,
  getRecentOrders,
  getReturnsAndRefunds,
  getSalesAnalytics,
  getSalesBreakdown,
  getSalesByChannel,
  getSalesByDiscountCode,
  getSalesByLocation,
  getSalesByRegion,
  getTopCategories,
  getTopProducts,
} from "./data";
import type {
  CatalogSnapshots,
  CommerceBreakdown,
  GrossMarginAnalytics,
  SalesAnalytics,
  Stat,
} from "./data";
import {
  getSearchDimensionBreakdown,
  type SearchAnalytics,
} from "./search-data";
import {
  searchCountryName,
  searchDeviceName,
} from "@/lib/analytics/search-dimensions";
import { WIDGETS, isWidgetId, type WidgetId } from "./widgets";
import {
  parseAnalyticsRange,
  type AnalyticsRange,
  type AnalyticsSearchParams,
} from "@/lib/analytics/range";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { getAnalyticsDashboardLayout } from "@/lib/analytics/layout-store";
import {
  PLAN_GATED_SECTION_IDS,
  type PlanGatedSectionId,
} from "@/lib/analytics/layout";
import {
  lockedPreviewIds,
  planPreviewData,
  previewHiddenCookie,
  rangePhrase,
} from "@/lib/analytics/plan-previews";
import { resolveAnalyticsLocation } from "@/lib/analytics/location";
import { analyticsReportHref } from "@/lib/analytics/reports";
import { getViewerLocations } from "@/lib/locations/scope";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import {
  ANALYTICS_FEATURES,
  analyticsFeatureAllowed,
  type AnalyticsFeatureId,
} from "@/lib/analytics/features";
import { getStorePlanContext } from "@/lib/plans/entitlements";
import { limitsFor, planAllows } from "@/lib/plans";
import {
  getTrafficBreakdown,
  type SessionsSeries,
  type StorefrontAnalytics,
  type TrafficBreakdownRow,
} from "./storefront-data";

const definition = (id: WidgetId) => WIDGETS[id].description;

function WidgetSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`dash-widget-skeleton${compact ? " is-compact" : ""}`}
      aria-label="Loading analytics"
    />
  );
}

/** Resolve a comparison promise that may not exist (comparison turned off). */
async function maybe<T>(value: Promise<T> | null): Promise<T | null> {
  return value ? await value : null;
}

/** Attach a comparison to a snapshot-style Stat that was computed without one. */
function withComparison(current: Stat, previous: Stat | null): Stat {
  if (!previous) return current;
  return {
    ...current,
    ...comparisonTrend(current.value, previous.value),
    previousSpark: previous.spark,
    previousValue: previous.value,
  };
}

async function SalesMetric({
  data,
  metric,
  reportHref,
}: {
  data: Promise<SalesAnalytics>;
  metric: "sales" | "orders" | "aov" | "units";
  reportHref?: string;
}) {
  const result = await data;
  if (metric === "sales")
    return (
      <MetricCard
        label="Total sales"
        definition={definition("metric_revenue")}
        stat={result.totalSales}
        currency
        reportHref={reportHref}
      />
    );
  if (metric === "orders")
    return (
      <MetricCard
        label="Orders"
        definition={definition("metric_orders")}
        stat={result.orders}
      />
    );
  if (metric === "aov")
    return (
      <MetricCard
        label="Average order value"
        definition={definition("metric_aov")}
        stat={result.averageOrderValue}
        currency
      />
    );
  return (
    <MetricCard
      label="Units sold"
      definition={definition("metric_units")}
      stat={result.unitsSold}
    />
  );
}

async function SnapshotMetric({
  data,
  metric,
}: {
  data: Promise<CatalogSnapshots>;
  metric: "customers" | "products";
}) {
  const result = await data;
  return metric === "customers" ? (
    <MetricCard
      label="Total customers"
      definition={definition("metric_customers")}
      stat={result.customers}
    />
  ) : (
    <MetricCard
      label="Products listed"
      definition={definition("metric_products")}
      stat={result.products}
    />
  );
}

async function SalesChart({
  data,
  reportHref,
  reportLock,
}: {
  data: Promise<SalesAnalytics>;
  reportHref?: string;
  reportLock?: ReportLock;
}) {
  const result = await data;
  const points: TrendPoint[] = result.series.map((point) => ({
    key: point.key,
    label: point.label,
    title: point.title ?? point.label,
    value: point.sales,
    previous: point.previousSales ?? null,
    previousTitle: point.previousTitle ?? null,
    partial: point.partial ?? false,
  }));
  return (
    <AnalyticsCard
      title="Total sales over time"
      definition={definition("revenue_chart")}
      reportHref={reportHref}
      reportLock={reportLock}
    >
      <div className="dash-an-headline">
        <strong>
          {formatAnalyticsValue(result.totalSales.value, "currency")}
        </strong>
        <TrendBadge pct={result.totalSales.trendPct} />
      </div>
      <AnalyticsTrendChart
        data={points}
        format="currency"
        currentLabel={result.rangeLabel}
        previousLabel={result.comparisonLabel}
        emptyText="No sales in this date range"
      />
    </AnalyticsCard>
  );
}

/** Orders or AOV per bucket, with the comparison bucket beside it. */
async function SalesSeriesChart({
  data,
  metric,
}: {
  data: Promise<SalesAnalytics>;
  metric: "orders" | "aov";
}) {
  const result = await data;
  const aov = (sales: number, count: number) => (count > 0 ? sales / count : 0);
  const points: TrendPoint[] = result.series.map((point) => ({
    key: point.key,
    label: point.label,
    title: point.title ?? point.label,
    value: metric === "orders" ? point.orders : aov(point.sales, point.orders),
    previous:
      point.previousOrders === null || point.previousOrders === undefined
        ? null
        : metric === "orders"
          ? point.previousOrders
          : aov(point.previousSales ?? 0, point.previousOrders),
    previousTitle: point.previousTitle ?? null,
    partial: point.partial ?? false,
  }));
  const stat = metric === "orders" ? result.orders : result.averageOrderValue;
  const id = metric === "orders" ? "orders_chart" : "aov_chart";
  const format = metric === "orders" ? "number" : "currency";
  return (
    <AnalyticsCard title={WIDGETS[id].title} definition={definition(id)}>
      <div className="dash-an-headline">
        <strong>{formatAnalyticsValue(stat.value, format)}</strong>
        <TrendBadge pct={stat.trendPct} />
      </div>
      <AnalyticsTrendChart
        data={points}
        format={format}
        currentLabel={result.rangeLabel}
        previousLabel={result.comparisonLabel}
        emptyText="No orders in this date range"
        height={200}
      />
    </AnalyticsCard>
  );
}

async function SalesBreakdownWidget({
  data,
  previous,
}: {
  data: ReturnType<typeof getSalesBreakdown>;
  previous: ReturnType<typeof getSalesBreakdown> | null;
}) {
  const [result, before] = await Promise.all([data, maybe(previous)]);
  return (
    <AnalyticsCard
      title="Total sales breakdown"
      definition={definition("sales_breakdown")}
      footer="Returns are refunds settled in this range. Gross sales leave out the tax already inside tax-inclusive prices."
    >
      <MetricRows
        rows={[
          {
            label: "Gross sales",
            value: result.grossSales,
            previous: before?.grossSales ?? null,
            format: "currency",
          },
          {
            label: "Discounts",
            value: result.discounts,
            previous: before?.discounts ?? null,
            format: "currency",
            goodWhen: "down",
            negative: true,
          },
          {
            label: "Returns",
            value: result.returns,
            previous: before?.returns ?? null,
            format: "currency",
            goodWhen: "down",
            negative: true,
          },
          {
            label: "Net sales",
            value: result.netSales,
            previous: before?.netSales ?? null,
            format: "currency",
            emphasis: true,
          },
          {
            label: "Shipping charges",
            value: result.shipping,
            previous: before?.shipping ?? null,
            format: "currency",
          },
          {
            label: "Taxes",
            value: result.taxes,
            previous: before?.taxes ?? null,
            format: "currency",
          },
          ...(result.adjustments !== 0
            ? [
                {
                  label: "Other adjustments",
                  value: result.adjustments,
                  format: "currency" as const,
                },
              ]
            : []),
          {
            label: "Total sales",
            value: result.totalSales,
            previous: before?.totalSales ?? null,
            format: "currency",
            emphasis: true,
          },
        ]}
      />
    </AnalyticsCard>
  );
}

async function DiscountCodeWidget({
  data,
  previous,
}: {
  data: ReturnType<typeof getSalesByDiscountCode>;
  previous: ReturnType<typeof getSalesByDiscountCode> | null;
}) {
  const [rows, before] = await Promise.all([data, maybe(previous)]);
  const prior = new Map(before?.map((row) => [row.code, row.sales]));
  return (
    <AnalyticsCard
      title="Sales by discount code"
      definition={definition("sales_by_discount")}
    >
      <RankedBars
        format="currency"
        emptyText="No discount codes were used in this date range"
        rows={rows.slice(0, 5).map((row) => ({
          key: row.code,
          label: row.code,
          value: row.sales,
          previous: before ? (prior.get(row.code) ?? 0) : null,
          meta: `${row.orders.toLocaleString("en-IN")} ${row.orders === 1 ? "order" : "orders"} · ${formatAnalyticsValue(row.discount, "currency")} off`,
        }))}
      />
    </AnalyticsCard>
  );
}

async function RegionWidget({
  data,
  previous,
}: {
  data: ReturnType<typeof getSalesByRegion>;
  previous: ReturnType<typeof getSalesByRegion> | null;
}) {
  const [rows, before] = await Promise.all([data, maybe(previous)]);
  return (
    <AnalyticsCard
      title="Sales by customer region"
      definition={definition("sales_by_region")}
      footer="Online orders with a delivery address. POS orders are not included."
    >
      <RankedBars
        format="currency"
        emptyText="No delivered online orders in this date range"
        rows={breakdownRows(rows.slice(0, 5), before)}
      />
    </AnalyticsCard>
  );
}

async function ReturningRateMetric({
  data,
  previous,
}: {
  data: ReturnType<typeof getCustomerMix>;
  previous: ReturnType<typeof getCustomerMix> | null;
}) {
  const [result, before] = await Promise.all([data, maybe(previous)]);
  const rate = (mix: { returningCustomers: number; totalCustomers: number }) =>
    mix.totalCustomers > 0
      ? (mix.returningCustomers / mix.totalCustomers) * 100
      : 0;
  return (
    <MetricCard
      label="Returning customer rate"
      definition={definition("metric_returning_rate")}
      format="percent"
      stat={{
        value: rate(result),
        ...comparisonTrend(rate(result), before ? rate(before) : null),
        spark: [],
      }}
    />
  );
}

const SEARCH_NOT_READY: Record<
  Exclude<SearchAnalytics["state"], "ready">,
  string
> = {
  not_launched: "Search data starts after your store launches",
  collecting: "Collecting the first days of Google Search data",
  no_visibility: "Google hasn't shown your store in search yet",
  error: "Google Search needs attention, see the performance chart",
};

async function SearchDimensionWidget({
  search,
  data,
  dimension,
}: {
  search: Promise<SearchAnalytics>;
  data: ReturnType<typeof getSearchDimensionBreakdown>;
  dimension: "device" | "country";
}) {
  const [state, rows] = await Promise.all([search, data]);
  const id = dimension === "device" ? "search_devices" : "search_countries";
  const notReady =
    state.state === "ready"
      ? null
      : SEARCH_NOT_READY[
          state.state as Exclude<SearchAnalytics["state"], "ready">
        ];
  return (
    <AnalyticsCard
      title={WIDGETS[id].title}
      definition={definition(id)}
      subtitle="Clicks, in whole weeks"
    >
      {notReady ? (
        <div className="dash-an-empty">{notReady}</div>
      ) : dimension === "device" ? (
        <AnalyticsDonut
          format="number"
          emptyText="No Google Search clicks in this date range"
          slices={rows.map((row) => ({
            key: row.key,
            name: searchDeviceName(row.key),
            value: row.clicks,
            previous: row.previousClicks,
          }))}
        />
      ) : (
        <RankedBars
          format="number"
          emptyText="No Google Search clicks in this date range"
          rows={rows.slice(0, 5).map((row) => ({
            key: row.key,
            label: searchCountryName(row.key),
            value: row.clicks,
            previous: row.previousClicks,
            meta: `${row.impressions.toLocaleString("en-IN")} impressions`,
          }))}
        />
      )}
    </AnalyticsCard>
  );
}

async function CategoryWidget({
  data,
  previous,
}: {
  data: ReturnType<typeof getTopCategories>;
  previous: ReturnType<typeof getTopCategories> | null;
}) {
  const [rows, before] = await Promise.all([data, maybe(previous)]);
  const prior = new Map(before?.map((row) => [row.name, row.amount]));
  return (
    <AnalyticsCard
      title="Sales by category"
      definition={definition("top_categories")}
    >
      <RankedBars
        format="currency"
        emptyText="No category sales in this date range"
        rows={rows.slice(0, 5).map((row) => ({
          key: row.name,
          label: row.name,
          value: row.amount,
          previous: before ? (prior.get(row.name) ?? 0) : null,
          meta: `${row.share}%`,
        }))}
      />
    </AnalyticsCard>
  );
}

async function TopProductsWidget({
  data,
  previous,
  reportHref,
  reportLock,
}: {
  data: ReturnType<typeof getTopProducts>;
  previous: ReturnType<typeof getTopProducts> | null;
  reportHref?: string;
  reportLock?: ReportLock;
}) {
  const [rows, before] = await Promise.all([data, maybe(previous)]);
  const prior = new Map(before?.map((row) => [row.id, row.units]));
  return (
    <AnalyticsCard
      title="Top products"
      subtitle="Ranked by units sold"
      definition={definition("top_products")}
      reportHref={reportHref}
      reportLock={reportLock}
    >
      <RankedBars
        format="number"
        emptyText="No products sold in this date range"
        rows={rows.slice(0, 5).map((row) => ({
          key: row.id,
          label: row.name,
          value: row.units,
          previous: before ? (prior.get(row.id) ?? 0) : null,
          meta: formatAnalyticsValue(row.amount, "currency"),
        }))}
      />
    </AnalyticsCard>
  );
}

function breakdownRows(
  rows: CommerceBreakdown[],
  before: CommerceBreakdown[] | null,
): RankedRow[] {
  const prior = new Map(before?.map((row) => [row.key, row.amount]));
  return rows.map((row) => ({
    key: row.key,
    label: row.name,
    value: row.amount,
    previous: before ? (prior.get(row.key) ?? 0) : null,
    meta: `${row.orders.toLocaleString("en-IN")} ${row.orders === 1 ? "order" : "orders"} · ${row.share}%`,
  }));
}

async function ChannelWidget({
  data,
  previous,
}: {
  data: ReturnType<typeof getSalesByChannel>;
  previous: ReturnType<typeof getSalesByChannel> | null;
}) {
  const [rows, before] = await Promise.all([data, maybe(previous)]);
  const prior = new Map(before?.map((row) => [row.key, row.amount]));
  return (
    <AnalyticsCard
      title="Sales by channel"
      definition={definition("sales_by_channel")}
    >
      <AnalyticsDonut
        format="currency"
        emptyText="No sales in this date range"
        slices={rows.map((row) => ({
          key: row.key,
          name: row.name,
          value: row.amount,
          previous: before ? (prior.get(row.key) ?? 0) : null,
        }))}
      />
    </AnalyticsCard>
  );
}

async function BreakdownWidget({
  id,
  title,
  data,
  previous,
}: {
  id: WidgetId;
  title: string;
  data: ReturnType<typeof getSalesByLocation>;
  previous: ReturnType<typeof getSalesByLocation> | null;
}) {
  const [rows, before] = await Promise.all([data, maybe(previous)]);
  return (
    <AnalyticsCard title={title} definition={definition(id)}>
      <RankedBars
        format="currency"
        emptyText="No sales in this date range"
        rows={breakdownRows(rows, before)}
      />
    </AnalyticsCard>
  );
}

async function CustomerMixWidget({
  data,
  previous,
}: {
  data: ReturnType<typeof getCustomerMix>;
  previous: ReturnType<typeof getCustomerMix> | null;
}) {
  const [result, before] = await Promise.all([data, maybe(previous)]);
  const share = (mix: { newCustomers: number; totalCustomers: number }) =>
    mix.totalCustomers > 0 ? (mix.newCustomers / mix.totalCustomers) * 100 : 0;
  const returningRate = (mix: {
    returningCustomers: number;
    totalCustomers: number;
  }) =>
    mix.totalCustomers > 0
      ? (mix.returningCustomers / mix.totalCustomers) * 100
      : 0;
  return (
    <AnalyticsCard
      title="New vs returning customers"
      definition={definition("customer_mix")}
      footer="Guest orders without a customer account are not included."
    >
      <MetricRows
        rows={[
          {
            label: "Customers who ordered",
            value: result.totalCustomers,
            previous: before?.totalCustomers ?? null,
            emphasis: true,
          },
          {
            label: "New customers",
            value: result.newCustomers,
            previous: before?.newCustomers ?? null,
          },
          {
            label: "Returning customers",
            value: result.returningCustomers,
            previous: before?.returningCustomers ?? null,
          },
          {
            label: "Returning customer rate",
            value: returningRate(result),
            previous: before ? returningRate(before) : null,
            format: "percent",
          },
          {
            label: "New customer share",
            value: share(result),
            previous: before ? share(before) : null,
            format: "percent",
          },
        ]}
      />
    </AnalyticsCard>
  );
}

async function DiscountWidget({
  data,
  previous,
}: {
  data: ReturnType<typeof getDiscountImpact>;
  previous: ReturnType<typeof getDiscountImpact> | null;
}) {
  const [result, before] = await Promise.all([data, maybe(previous)]);
  return (
    <AnalyticsCard
      title="Discount impact"
      definition={definition("discount_impact")}
    >
      <MetricRows
        rows={[
          {
            label: "Total discounts",
            value: result.totalDiscounts,
            previous: before?.totalDiscounts ?? null,
            format: "currency",
            goodWhen: "down",
            emphasis: true,
          },
          {
            label: "Offer and order discounts",
            value: result.orderDiscounts,
            previous: before?.orderDiscounts ?? null,
            format: "currency",
            goodWhen: "down",
          },
          {
            label: "Line markdowns",
            value: result.lineDiscounts,
            previous: before?.lineDiscounts ?? null,
            format: "currency",
            goodWhen: "down",
          },
          {
            label: "Orders with a coupon",
            value: result.couponOrders,
            previous: before?.couponOrders ?? null,
          },
        ]}
      />
    </AnalyticsCard>
  );
}

async function ReturnsWidget({
  data,
  previous,
  sales,
}: {
  data: ReturnType<typeof getReturnsAndRefunds>;
  previous: ReturnType<typeof getReturnsAndRefunds> | null;
  sales: Promise<SalesAnalytics>;
}) {
  const [result, before, salesResult] = await Promise.all([
    data,
    maybe(previous),
    sales,
  ]);
  const beforeRefunds = salesResult.totalSales.value + result.completedRefunds;
  const refundShare =
    beforeRefunds > 0 ? (result.completedRefunds / beforeRefunds) * 100 : 0;
  return (
    <AnalyticsCard
      title="Returns and refunds"
      definition={definition("returns_refunds")}
      footer="Returns count on the day they complete and refunds on the day they settle, so the two are never added together."
    >
      <MetricRows
        rows={[
          {
            label: "Refunds settled",
            value: result.completedRefunds,
            previous: before?.completedRefunds ?? null,
            format: "currency",
            goodWhen: "down",
            emphasis: true,
          },
          {
            label: "Refund share of sales",
            value: refundShare,
            format: "percent",
            goodWhen: "down",
          },
          {
            label: "Returns completed",
            value: result.completedReturns,
            previous: before?.completedReturns ?? null,
            goodWhen: "down",
          },
          {
            label: "Units returned",
            value: result.returnedUnits,
            previous: before?.returnedUnits ?? null,
            goodWhen: "down",
          },
          {
            label: "Value of returns",
            value: result.returnedValue,
            previous: before?.returnedValue ?? null,
            format: "currency",
            goodWhen: "down",
          },
        ]}
      />
    </AnalyticsCard>
  );
}

async function InventoryVelocityWidget({
  data,
  previous,
}: {
  data: ReturnType<typeof getInventoryVelocity>;
  previous: ReturnType<typeof getInventoryVelocity> | null;
}) {
  const [rows, before] = await Promise.all([data, maybe(previous)]);
  const prior = new Map(before?.map((row) => [row.id, row.units]));
  return (
    <AnalyticsCard
      title="Inventory velocity"
      definition={definition("inventory_velocity")}
    >
      <RankedBars
        format="number"
        emptyText="No tracked stock sold in this date range"
        rows={rows.slice(0, 5).map((row) => ({
          key: row.id,
          label: row.name,
          value: row.units,
          previous: before ? (prior.get(row.id) ?? 0) : null,
        }))}
      />
    </AnalyticsCard>
  );
}

async function RecentOrdersWidget({
  data,
}: {
  data: ReturnType<typeof getRecentOrders>;
}) {
  return <RecentOrdersTable orders={await data} />;
}

async function ActivityWidget({
  data,
}: {
  data: ReturnType<typeof getActivity>;
}) {
  return <ActivityFeed items={await data} />;
}

async function SearchMetricWidget({
  data,
  metric,
}: {
  data: Promise<SearchAnalytics>;
  metric: "clicks" | "impressions" | "ctr" | "position";
}) {
  return <SearchMetricCard data={await data} metric={metric} />;
}

async function SearchTrend({ data }: { data: Promise<SearchAnalytics> }) {
  return <SearchTrendWidget data={await data} />;
}

async function SearchRanking({
  data,
  kind,
  reportHref,
}: {
  data: Promise<SearchAnalytics>;
  kind: "query" | "page";
  reportHref?: string;
}) {
  return (
    <SearchRankingWidget
      data={await data}
      kind={kind}
      reportHref={reportHref}
    />
  );
}

async function StorefrontMetric({
  data,
  previous,
  metric,
}: {
  data: Promise<StorefrontAnalytics>;
  previous: Promise<StorefrontAnalytics> | null;
  metric: "visitors" | "sessions" | "pageViews";
}) {
  const [result, before] = await Promise.all([data, maybe(previous)]);
  const meta = {
    visitors: ["Storefront visitors", "traffic_visitors"],
    sessions: ["Storefront sessions", "traffic_sessions"],
    pageViews: ["Storefront page views", "traffic_page_views"],
  } as const;
  const [label, id] = meta[metric];
  return (
    <MetricCard
      label={label}
      definition={definition(id)}
      stat={withComparison(result[metric], before?.[metric] ?? null)}
    />
  );
}

async function SessionsChart({
  data,
  currentLabel,
  previousLabel,
}: {
  data: Promise<SessionsSeries>;
  currentLabel: string;
  previousLabel: string | null;
}) {
  const result = await data;
  return (
    <AnalyticsCard
      title="Sessions over time"
      definition={definition("traffic_sessions_chart")}
    >
      <div className="dash-an-headline">
        <strong>{formatAnalyticsValue(result.total, "number")}</strong>
        <TrendBadge pct={trendPct(result.total, result.previousTotal)} />
      </div>
      <AnalyticsTrendChart
        data={result.points}
        format="number"
        currentLabel={currentLabel}
        previousLabel={previousLabel}
        emptyText="No storefront sessions in this date range"
      />
    </AnalyticsCard>
  );
}

function percentOf(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0%";
}

async function TrafficDimensionWidget({
  id,
  data,
  view,
  metric = "sessions",
  emptyText,
}: {
  id: WidgetId;
  data: Promise<TrafficBreakdownRow[]>;
  view: "donut" | "bars";
  metric?: "sessions" | "sales";
  emptyText: string;
}) {
  const rows = await data;
  // Rows arrive ranked by sessions; a sales card ranks by sales instead.
  const shown = (
    metric === "sales"
      ? rows.filter((row) => row.sales > 0).sort((a, b) => b.sales - a.sales)
      : rows
  ).slice(0, 5);
  return (
    <AnalyticsCard title={WIDGETS[id].title} definition={definition(id)}>
      {view === "donut" ? (
        <AnalyticsDonut
          format="number"
          emptyText={emptyText}
          slices={rows.map((row) => ({
            key: row.key,
            name: row.label,
            value: row.sessions,
            previous: row.previousSessions,
          }))}
        />
      ) : (
        <RankedBars
          format={metric === "sales" ? "currency" : "number"}
          emptyText={emptyText}
          rows={shown.map((row) => ({
            key: row.key,
            label: row.label,
            value: metric === "sales" ? row.sales : row.sessions,
            previous: metric === "sales" ? null : row.previousSessions,
            meta:
              metric === "sales"
                ? `${row.convertedSessions.toLocaleString("en-IN")} ${row.convertedSessions === 1 ? "order" : "orders"}`
                : `${percentOf(row.convertedSessions, row.sessions)} converted`,
          }))}
        />
      )}
    </AnalyticsCard>
  );
}

async function StorefrontConversion({
  data,
  previous,
}: {
  data: Promise<StorefrontAnalytics>;
  previous: Promise<StorefrontAnalytics> | null;
}) {
  const [result, before] = await Promise.all([data, maybe(previous)]);
  return (
    <MetricCard
      label="Conversion rate"
      definition={definition("traffic_conversion")}
      format="percent"
      stat={{
        value: result.conversionRate,
        ...comparisonTrend(
          result.conversionRate,
          before ? before.conversionRate : null,
        ),
        spark: [],
      }}
    />
  );
}

async function StorefrontFunnel({
  data,
}: {
  data: Promise<StorefrontAnalytics>;
}) {
  const result = await data;
  return (
    <AnalyticsCard
      title="Storefront conversion funnel"
      definition={definition("traffic_funnel")}
      footer="Visitors who decline analytics and automated traffic are not counted. Updated every hour."
    >
      <FunnelBars
        emptyText="No storefront sessions in this date range"
        steps={[
          { label: "Sessions", value: result.sessions.value },
          { label: "Viewed a product", value: result.productSessions },
          { label: "Added to cart", value: result.cartSessions },
          { label: "Reached checkout", value: result.checkoutSessions },
          { label: "Purchased", value: result.convertedSessions },
        ]}
      />
    </AnalyticsCard>
  );
}

async function GrossProfitMetric({
  data,
  previous,
}: {
  data: Promise<GrossMarginAnalytics>;
  previous: Promise<GrossMarginAnalytics> | null;
}) {
  const [result, before] = await Promise.all([data, maybe(previous)]);
  return (
    <MetricCard
      label="Gross profit"
      definition={definition("metric_gross_profit")}
      stat={{
        value: result.grossProfit,
        ...comparisonTrend(result.grossProfit, before?.grossProfit ?? null),
        spark: [],
      }}
      currency
    />
  );
}

async function GrossMarginWidget({
  data,
  previous,
}: {
  data: Promise<GrossMarginAnalytics>;
  previous: Promise<GrossMarginAnalytics> | null;
}) {
  const [result, before] = await Promise.all([data, maybe(previous)]);
  return (
    <AnalyticsCard
      title="Gross margin"
      definition={definition("gross_margin_overview")}
      footer="Before returns and refunds. Products without a cost are left out rather than counted as free. Add costs in Products to raise coverage."
    >
      <MetricRows
        rows={[
          {
            label: "Sales with a known cost",
            value: result.costedSales,
            previous: before?.costedSales ?? null,
            format: "currency",
          },
          {
            label: "Cost of goods",
            value: result.costOfGoods,
            previous: before?.costOfGoods ?? null,
            format: "currency",
            goodWhen: "down",
            negative: true,
          },
          {
            label: "Gross profit",
            value: result.grossProfit,
            previous: before?.grossProfit ?? null,
            format: "currency",
            emphasis: true,
          },
          {
            label: "Gross margin",
            value: result.marginPercent,
            previous: before?.marginPercent ?? null,
            format: "percent",
          },
          {
            label: "Cost coverage",
            value: result.coveragePercent,
            format: "percent",
          },
        ]}
      />
    </AnalyticsCard>
  );
}

/** Gather the figures the dashboard already loads and say what changed. */
async function InsightsLoader({
  canAskMink,
  rangeLabel,
  comparisonLabel,
  sales,
  monthPace,
  products,
  previousProducts,
  customers,
  previousCustomers,
  breakdown,
  previousBreakdown,
  storefront,
  previousStorefront,
  sources,
}: {
  canAskMink: boolean;
  rangeLabel: string;
  comparisonLabel: string | null;
  sales: Promise<SalesAnalytics>;
  monthPace: Promise<{
    monthName: string;
    current: number;
    lastMonthSameDays: number;
    projected: number;
    dayOfMonth: number;
  } | null>;
  products: ReturnType<typeof getTopProducts>;
  previousProducts: ReturnType<typeof getTopProducts> | null;
  customers: ReturnType<typeof getCustomerMix>;
  previousCustomers: ReturnType<typeof getCustomerMix> | null;
  breakdown: ReturnType<typeof getSalesBreakdown>;
  previousBreakdown: ReturnType<typeof getSalesBreakdown> | null;
  storefront: Promise<StorefrontAnalytics> | null;
  previousStorefront: Promise<StorefrontAnalytics> | null;
  sources: Promise<TrafficBreakdownRow[]> | null;
}) {
  const [
    salesResult,
    pace,
    productRows,
    productBefore,
    mix,
    mixBefore,
    totals,
    totalsBefore,
    traffic,
    trafficBefore,
    sourceRows,
  ] = await Promise.all([
    sales,
    monthPace,
    products,
    maybe(previousProducts),
    customers,
    maybe(previousCustomers),
    breakdown,
    maybe(previousBreakdown),
    maybe(storefront),
    maybe(previousStorefront),
    maybe(sources),
  ]);
  const rate = (value: {
    returningCustomers: number;
    totalCustomers: number;
  }) =>
    value.totalCustomers > 0
      ? (value.returningCustomers / value.totalCustomers) * 100
      : 0;
  const priorUnits = new Map(productBefore?.map((row) => [row.id, row.units]));
  const insights = buildInsights({
    rangeLabel,
    comparisonLabel,
    sales: {
      current: salesResult.totalSales.value,
      previous: salesResult.totalSales.previousValue ?? null,
      orders: salesResult.orders.value,
      previousOrders: salesResult.orders.previousValue ?? null,
      aov: salesResult.averageOrderValue.value,
      previousAov: salesResult.averageOrderValue.previousValue ?? null,
      series: salesResult.series.map((point) => ({
        key: point.key,
        label: point.label,
        title: point.title ?? point.label,
        value: point.sales,
        previous: point.previousSales ?? null,
        previousTitle: point.previousTitle ?? null,
        partial: point.partial ?? false,
      })),
    },
    monthPace: pace,
    products: productRows.map((row) => ({
      name: row.name,
      units: row.units,
      previousUnits: productBefore ? (priorUnits.get(row.id) ?? 0) : null,
    })),
    customers: {
      total: mix.totalCustomers,
      returningRate: rate(mix),
      previousTotal: mixBefore?.totalCustomers ?? null,
      previousReturningRate: mixBefore ? rate(mixBefore) : null,
    },
    refunds: {
      current: totals.returns,
      previous: totalsBefore?.returns ?? null,
      grossSales: totals.grossSales,
    },
    discounts: {
      current: totals.discounts,
      previous: totalsBefore?.discounts ?? null,
      grossSales: totals.grossSales,
      previousGrossSales: totalsBefore?.grossSales ?? null,
    },
    traffic: traffic
      ? {
          conversionRate: traffic.conversionRate,
          previousConversionRate: trafficBefore?.conversionRate ?? null,
          sources: (sourceRows ?? []).map((row) => ({
            label: row.label,
            sessions: row.sessions,
            converted: row.convertedSessions,
          })),
        }
      : null,
  });
  return <InsightsPanel insights={insights} canAskMink={canAskMink} />;
}

/** Month to date against the same days of last month (from day 5 on). */
async function monthPaceFor(
  storeId: string,
  location: Parameters<typeof getSalesAnalytics>[1],
  timeZone: string,
) {
  const today = storeToday(timeZone);
  const day = Number(today.slice(8, 10));
  if (day < 5) return null;
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  const iso = (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  const lastMonthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const range = parseAnalyticsRange(
    {
      range: "custom",
      from: iso(year, month, 1),
      to: today,
      compare: "custom",
      compareFrom: iso(year, month - 1, 1),
      compareTo: iso(year, month - 1, Math.min(day, lastMonthDays)),
    },
    timeZone,
  );
  const [thisMonth, lastMonth] = await cachedReaders.salesTotals(
    storeId,
    location,
    [range.current, range.compare ?? range.current],
  );
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // Today counts as half done so the projection is not inflated at breakfast.
  const elapsed = Math.max(day - 0.5, 1);
  return {
    monthName: new Intl.DateTimeFormat("en-IN", {
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${today}T00:00:00.000Z`)),
    current: thisMonth.sales,
    lastMonthSameDays: lastMonth.sales,
    projected: (thisMonth.sales / elapsed) * daysInMonth,
    dayOfMonth: day,
  };
}

async function TargetsSection({
  data,
}: {
  data: ReturnType<typeof getTargetCards>;
}) {
  const cards = await data;
  if (cards.length === 0) return null;
  return (
    <section className="dash-section dash-targets">
      <h2>Targets</h2>
      <div className="dash-target-grid">
        {cards.map((card) => (
          <TargetCard key={card.id} {...card} />
        ))}
      </div>
    </section>
  );
}

/** A locked section's preview, headed by the store's own numbers. */
async function PlanPreviewLoader({
  id,
  canUpgrade,
  phrase,
  search,
  sales,
}: {
  id: PlanGatedSectionId;
  canUpgrade: boolean;
  phrase: string;
  search: Promise<SearchAnalytics> | null;
  sales: Promise<SalesAnalytics> | null;
}) {
  const [searchResult, salesResult] = await Promise.all([
    maybe(search),
    maybe(sales),
  ]);
  return (
    <PlanPreviewSection
      preview={planPreviewData(id, {
        canUpgrade,
        phrase,
        search:
          searchResult?.state === "ready"
            ? {
                impressions: searchResult.impressions.value,
                clicks: searchResult.clicks.value,
              }
            : null,
        sales: salesResult?.totalSales.value ?? null,
      })}
    />
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<AnalyticsSearchParams>;
}) {
  const access = await requireSectionAccess("analytics", "view");
  const showBlogApprovals = access.can("blogs", "view");
  const showEnquiries = access.can("enquiries", "view");
  // "Plan & billing" keeps the legacy `ai` key (app/dashboard/lib/permissions.ts).
  const canUpgrade = access.can("ai", "view");
  const [storeId, locationScope, params, platformFeatures] = await Promise.all([
    getActingStoreId(),
    getViewerLocations(),
    searchParams,
    getPlatformAnalyticsFeatures(),
  ]);
  if (!platformFeatures.coreDashboard) {
    return (
      <div className="dash-analytics">
        <header className="dash-an-head">
          <h1>Analytics</h1>
        </header>
        <div className="dash-card p-8 text-center">
          <h2 className="text-base font-semibold">Analytics is unavailable</h2>
          <p className="mt-2 text-sm text-[var(--dash-text-3)]">
            StoreMink has temporarily disabled the Analytics dashboard. Your
            store data is unchanged.
          </p>
        </div>
      </div>
    );
  }
  // Resolve the store plan once for this render. Calling the per-feature DAL
  // for every card repeated the same stores read five times.
  const [{ plan }, timeZone, locationOptions] = await Promise.all([
    getStorePlanContext(storeId),
    getStoreAnalyticsTimeZone(storeId),
    getAnalyticsLocationOptions(storeId, locationScope),
  ]);
  const canUse = (feature: AnalyticsFeatureId) =>
    analyticsFeatureAllowed(platformFeatures, feature, plan);
  /** Locked by PLAN only: a feature StoreMink has switched off is never sold. */
  const lockFor = (feature: AnalyticsFeatureId): ReportLock | undefined => {
    const minPlan = ANALYTICS_FEATURES[feature].minPlan;
    if (!platformFeatures[feature] || !minPlan || planAllows(plan, minPlan)) {
      return undefined;
    }
    return { plan: minPlan === "pro" ? "pro" : "basic", canUpgrade };
  };
  const canCustomize = canUse("dashboardCustomization");
  const canUseReports = canUse("drilldownReports");
  const canUseSearch = canUse("googleSearchConsole");
  const reportLock = lockFor("drilldownReports");
  // Minute-rounded "now": the Overview's results are cached for a minute
  // (cached.ts), so a preset range keeps one cache key within the minute.
  const range: AnalyticsRange = parseAnalyticsRange(
    params,
    timeZone,
    minuteNow(),
  );
  // The comparison window run through the SAME queries. Every card except the
  // sales series reads only `range.current`, so this is how each card gets a
  // "vs previous period" figure without a second implementation per card.
  const previousRange: AnalyticsRange | null = range.compare
    ? { ...range, current: range.compare, compare: null }
    : null;
  const location = resolveAnalyticsLocation(
    params.location,
    locationScope,
    locationOptions,
  );
  const both = <T,>(
    load: (r: AnalyticsRange) => Promise<T>,
  ): [Promise<T>, Promise<T> | null] => [
    load(range),
    previousRange ? load(previousRange) : null,
  ];

  // Start every independent data source together. Each slot awaits only its own
  // promise under Suspense, so a slow activity query cannot hold sales cards.
  const sales = cachedReaders.sales(storeId, location, range);
  const catalog = cachedReaders.catalog(storeId);
  const [categories, previousCategories] = both((r) =>
    cachedReaders.categories(storeId, location, r),
  );
  const [topProducts, previousTopProducts] = both((r) =>
    cachedReaders.topProducts(storeId, location, r),
  );
  // A channel split is only meaningful with point of sale: without it the
  // card is a single 100% "Online store" slice (Shopify hides it too). A store
  // that has locations has had POS, so its history still splits by channel.
  const hasPointOfSale =
    limitsFor(plan).posEnabled || locationOptions.length > 0;
  const [channelSales, previousChannelSales] = hasPointOfSale
    ? both((r) => cachedReaders.channel(storeId, location, r))
    : [null, null];
  const [paymentSales, previousPaymentSales] = both((r) =>
    cachedReaders.payment(storeId, location, r),
  );
  const [locationSales, previousLocationSales]: [
    Promise<CommerceBreakdown[]>,
    Promise<CommerceBreakdown[]> | null,
  ] =
    locationOptions.length > 0
      ? both((r) => cachedReaders.location(storeId, location, r))
      : [Promise.resolve([]), null];
  const [salesBreakdown, previousSalesBreakdown] = both((r) =>
    cachedReaders.breakdown(storeId, location, r),
  );
  const [discountCodes, previousDiscountCodes] = both((r) =>
    cachedReaders.discountCodes(storeId, location, r),
  );
  const [regions, previousRegions] = both((r) =>
    cachedReaders.regions(storeId, location, r),
  );
  const recentOrders = cachedReaders.recentOrders(storeId, location, range);
  const activity = cachedReaders.activity(storeId, location, range, {
    includeEnquiries: showEnquiries,
    includeBlogs: showBlogApprovals,
  });
  const [customerMix, previousCustomerMix] = both((r) =>
    cachedReaders.customerMix(storeId, location, r),
  );
  const [discounts, previousDiscounts] = both((r) =>
    cachedReaders.discounts(storeId, location, r),
  );
  const [returns, previousReturns] = both((r) =>
    cachedReaders.returns(storeId, location, r),
  );
  const [velocity, previousVelocity] = both((r) =>
    cachedReaders.velocity(storeId, location, r),
  );
  const search = canUseSearch ? cachedReaders.search(storeId, range) : null;
  const searchDevices = canUseSearch
    ? cachedReaders.searchDimension(storeId, range, "device")
    : null;
  const searchCountries = canUseSearch
    ? cachedReaders.searchDimension(storeId, range, "country")
    : null;
  const canUseTraffic = canUse("storefrontConversion");
  const [storefront, previousStorefront] = canUseTraffic
    ? both((r) => cachedReaders.storefront(storeId, r))
    : [null, null];
  const trafficBy = (dimension: Parameters<typeof getTrafficBreakdown>[2]) =>
    canUseTraffic ? cachedReaders.traffic(storeId, range, dimension) : null;
  const sessionsSeries = canUseTraffic
    ? cachedReaders.sessionsSeries(storeId, range)
    : null;
  const traffic = {
    device: trafficBy("device"),
    source: trafficBy("source"),
    city: trafficBy("city"),
    landing: trafficBy("landing_page"),
    referrer: trafficBy("referrer"),
    campaign: trafficBy("campaign"),
  };
  const [margin, previousMargin] = canUse("grossMargin")
    ? both((r) => cachedReaders.margin(storeId, location, r))
    : [null, null];
  const totalSalesReport = canUseReports
    ? analyticsReportHref("total-sales", params)
    : undefined;
  const salesOverTimeReport = canUseReports
    ? analyticsReportHref("sales-over-time", params)
    : undefined;
  const topProductsReport = canUseReports
    ? analyticsReportHref("top-products", params)
    : undefined;
  const searchQueriesReport =
    canUseReports && canUseSearch
      ? analyticsReportHref("search-queries", params)
      : undefined;

  const slots: Partial<Record<WidgetId, ReactNode>> = {
    metric_revenue: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SalesMetric
          data={sales}
          metric="sales"
          reportHref={totalSalesReport}
        />
      </Suspense>
    ),
    metric_orders: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SalesMetric data={sales} metric="orders" />
      </Suspense>
    ),
    metric_aov: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SalesMetric data={sales} metric="aov" />
      </Suspense>
    ),
    metric_units: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SalesMetric data={sales} metric="units" />
      </Suspense>
    ),
    metric_returning_rate: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <ReturningRateMetric
          data={customerMix}
          previous={previousCustomerMix}
        />
      </Suspense>
    ),
    sales_breakdown: (
      <Suspense fallback={<WidgetSkeleton />}>
        <SalesBreakdownWidget
          data={salesBreakdown}
          previous={previousSalesBreakdown}
        />
      </Suspense>
    ),
    orders_chart: (
      <Suspense fallback={<WidgetSkeleton />}>
        <SalesSeriesChart data={sales} metric="orders" />
      </Suspense>
    ),
    aov_chart: (
      <Suspense fallback={<WidgetSkeleton />}>
        <SalesSeriesChart data={sales} metric="aov" />
      </Suspense>
    ),
    sales_by_discount: (
      <Suspense fallback={<WidgetSkeleton />}>
        <DiscountCodeWidget
          data={discountCodes}
          previous={previousDiscountCodes}
        />
      </Suspense>
    ),
    sales_by_region: (
      <Suspense fallback={<WidgetSkeleton />}>
        <RegionWidget data={regions} previous={previousRegions} />
      </Suspense>
    ),
    metric_products: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SnapshotMetric data={catalog} metric="products" />
      </Suspense>
    ),
    revenue_chart: (
      <Suspense fallback={<WidgetSkeleton />}>
        <SalesChart
          data={sales}
          reportHref={salesOverTimeReport}
          reportLock={reportLock}
        />
      </Suspense>
    ),
    top_categories: (
      <Suspense fallback={<WidgetSkeleton />}>
        <CategoryWidget data={categories} previous={previousCategories} />
      </Suspense>
    ),
    top_products: (
      <Suspense fallback={<WidgetSkeleton />}>
        <TopProductsWidget
          data={topProducts}
          previous={previousTopProducts}
          reportHref={topProductsReport}
          reportLock={reportLock}
        />
      </Suspense>
    ),
    sales_by_payment: (
      <Suspense fallback={<WidgetSkeleton />}>
        <BreakdownWidget
          id="sales_by_payment"
          title="Sales by payment method"
          data={paymentSales}
          previous={previousPaymentSales}
        />
      </Suspense>
    ),
    customer_mix: (
      <Suspense fallback={<WidgetSkeleton />}>
        <CustomerMixWidget data={customerMix} previous={previousCustomerMix} />
      </Suspense>
    ),
    discount_impact: (
      <Suspense fallback={<WidgetSkeleton />}>
        <DiscountWidget data={discounts} previous={previousDiscounts} />
      </Suspense>
    ),
    returns_refunds: (
      <Suspense fallback={<WidgetSkeleton />}>
        <ReturnsWidget
          data={returns}
          previous={previousReturns}
          sales={sales}
        />
      </Suspense>
    ),
    inventory_velocity: (
      <Suspense fallback={<WidgetSkeleton />}>
        <InventoryVelocityWidget data={velocity} previous={previousVelocity} />
      </Suspense>
    ),
    recent_orders: (
      <Suspense fallback={<WidgetSkeleton />}>
        <RecentOrdersWidget data={recentOrders} />
      </Suspense>
    ),
    activity: (
      <Suspense fallback={<WidgetSkeleton />}>
        <ActivityWidget data={activity} />
      </Suspense>
    ),
  };
  if (search) {
    slots.search_clicks = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SearchMetricWidget data={search} metric="clicks" />
      </Suspense>
    );
    slots.search_impressions = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SearchMetricWidget data={search} metric="impressions" />
      </Suspense>
    );
    slots.search_ctr = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SearchMetricWidget data={search} metric="ctr" />
      </Suspense>
    );
    slots.search_position = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SearchMetricWidget data={search} metric="position" />
      </Suspense>
    );
    slots.search_trend = (
      <Suspense fallback={<WidgetSkeleton />}>
        <SearchTrend data={search} />
      </Suspense>
    );
    slots.search_queries = (
      <Suspense fallback={<WidgetSkeleton />}>
        <SearchRanking
          data={search}
          kind="query"
          reportHref={searchQueriesReport}
        />
      </Suspense>
    );
    slots.search_pages = (
      <Suspense fallback={<WidgetSkeleton />}>
        <SearchRanking data={search} kind="page" />
      </Suspense>
    );
    if (searchDevices && searchCountries) {
      slots.search_devices = (
        <Suspense fallback={<WidgetSkeleton />}>
          <SearchDimensionWidget
            search={search}
            data={searchDevices}
            dimension="device"
          />
        </Suspense>
      );
      slots.search_countries = (
        <Suspense fallback={<WidgetSkeleton />}>
          <SearchDimensionWidget
            search={search}
            data={searchCountries}
            dimension="country"
          />
        </Suspense>
      );
    }
  }
  if (storefront) {
    slots.traffic_visitors = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <StorefrontMetric
          data={storefront}
          previous={previousStorefront}
          metric="visitors"
        />
      </Suspense>
    );
    slots.traffic_sessions = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <StorefrontMetric
          data={storefront}
          previous={previousStorefront}
          metric="sessions"
        />
      </Suspense>
    );
    slots.traffic_page_views = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <StorefrontMetric
          data={storefront}
          previous={previousStorefront}
          metric="pageViews"
        />
      </Suspense>
    );
    slots.traffic_conversion = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <StorefrontConversion data={storefront} previous={previousStorefront} />
      </Suspense>
    );
    if (sessionsSeries) {
      slots.traffic_sessions_chart = (
        <Suspense fallback={<WidgetSkeleton />}>
          <SessionsChart
            data={sessionsSeries}
            currentLabel={range.label}
            previousLabel={range.comparisonLabel}
          />
        </Suspense>
      );
    }
    const trafficCards: Array<{
      id: WidgetId;
      data: Promise<TrafficBreakdownRow[]> | null;
      view: "donut" | "bars";
      metric?: "sessions" | "sales";
      emptyText: string;
    }> = [
      {
        id: "traffic_devices",
        data: traffic.device,
        view: "donut",
        emptyText: "No storefront sessions in this date range",
      },
      {
        id: "traffic_sources",
        data: traffic.source,
        view: "bars",
        emptyText: "No storefront sessions in this date range",
      },
      {
        id: "sales_by_source",
        data: traffic.source,
        view: "bars",
        metric: "sales",
        emptyText: "No sales from storefront sessions in this date range",
      },
      {
        id: "traffic_locations",
        data: traffic.city,
        view: "bars",
        emptyText: "No visitor locations in this date range",
      },
      {
        id: "traffic_landing_pages",
        data: traffic.landing,
        view: "bars",
        emptyText: "No storefront sessions in this date range",
      },
      {
        id: "traffic_referrers",
        data: traffic.referrer,
        view: "bars",
        emptyText: "No visits from other websites in this date range",
      },
      {
        id: "traffic_campaigns",
        data: traffic.campaign,
        view: "bars",
        emptyText: "No visits from links tagged with utm_campaign",
      },
    ];
    for (const card of trafficCards) {
      if (!card.data) continue;
      slots[card.id] = (
        <Suspense fallback={<WidgetSkeleton />}>
          <TrafficDimensionWidget
            id={card.id}
            data={card.data}
            view={card.view}
            metric={card.metric}
            emptyText={card.emptyText}
          />
        </Suspense>
      );
    }
    slots.traffic_funnel = (
      <Suspense fallback={<WidgetSkeleton />}>
        <StorefrontFunnel data={storefront} />
      </Suspense>
    );
  }
  if (margin) {
    slots.metric_gross_profit = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <GrossProfitMetric data={margin} previous={previousMargin} />
      </Suspense>
    );
    slots.gross_margin_overview = (
      <Suspense fallback={<WidgetSkeleton />}>
        <GrossMarginWidget data={margin} previous={previousMargin} />
      </Suspense>
    );
  }
  if (channelSales) {
    slots.sales_by_channel = (
      <Suspense fallback={<WidgetSkeleton />}>
        <ChannelWidget data={channelSales} previous={previousChannelSales} />
      </Suspense>
    );
  }
  if (locationOptions.length > 0) {
    slots.sales_by_location = (
      <Suspense fallback={<WidgetSkeleton />}>
        <BreakdownWidget
          id="sales_by_location"
          title="Sales by location"
          data={locationSales}
          previous={previousLocationSales}
        />
      </Suspense>
    );
  }
  if (locationScope === null) {
    slots.metric_customers = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SnapshotMetric data={catalog} metric="customers" />
      </Suspense>
    );
  }
  if (showBlogApprovals) {
    slots.blog_approvals = (
      <Suspense fallback={<WidgetSkeleton />}>
        <BlogApprovals />
      </Suspense>
    );
  }
  if (showEnquiries) {
    slots.enquiries = (
      <Suspense fallback={<WidgetSkeleton />}>
        <EnquiriesOverview />
      </Suspense>
    );
  }

  // Locked plan sections, previewed in place (hidden ones stay away 30 days).
  const cookieStore = await cookies();
  const previewIds = lockedPreviewIds({
    plan,
    platform: platformFeatures,
    hidden: new Set(
      PLAN_GATED_SECTION_IDS.filter((id) =>
        cookieStore.has(previewHiddenCookie(id)),
      ),
    ),
  });
  // Search Console data is collected for every active store, so a store below
  // Basic is shown its OWN headline numbers; the detail stays locked.
  const previewSearch = previewIds.includes("google-search")
    ? cachedReaders.search(storeId, range)
    : null;
  const phrase = rangePhrase(range.preset, range.label);
  const previews = previewIds.map((id) => ({
    id,
    node: (
      <Suspense fallback={null}>
        <PlanPreviewLoader
          id={id}
          canUpgrade={canUpgrade}
          phrase={phrase}
          search={id === "google-search" ? previewSearch : null}
          sales={id === "profit" ? sales : null}
        />
      </Suspense>
    ),
  }));

  // Targets (Basic and above, with the dashboard customisation entitlement).
  const canUseTargets = canUse("dashboardCustomization");
  const targetList = canUseTargets ? await listAnalyticsTargets(storeId) : [];
  const targetCards = canUseTargets
    ? getTargetCards({
        storeId,
        location,
        timeZone,
        trafficAllowed: canUseTraffic,
      })
    : null;
  const targetMetrics = TARGET_METRICS.filter(
    (metric) => canUseTraffic || !TARGET_METRIC_META[metric].traffic,
  );

  // Insights (every plan). Mink is offered only where the dashboard offers it.
  const minkConfig = getMinkConfig();
  const canAskMink =
    minkConfig.enabled &&
    (!minkConfig.betaRequireInvite || (await isMinkStoreInvited(storeId)));
  const insightsNode = (
    <Suspense fallback={null}>
      <InsightsLoader
        canAskMink={canAskMink}
        rangeLabel={range.label}
        comparisonLabel={range.comparisonLabel}
        sales={sales}
        monthPace={monthPaceFor(storeId, location, timeZone)}
        products={topProducts}
        previousProducts={previousTopProducts}
        customers={customerMix}
        previousCustomers={previousCustomerMix}
        breakdown={salesBreakdown}
        previousBreakdown={previousSalesBreakdown}
        storefront={storefront}
        previousStorefront={previousStorefront}
        sources={traffic.source}
      />
    </Suspense>
  );

  const allowedWidgetIds = Object.keys(slots).filter(isWidgetId);
  const initialLayout = await getAnalyticsDashboardLayout(
    storeId,
    access.userId,
    allowedWidgetIds,
  );

  return (
    <div className="dash-analytics">
      {showBlogApprovals ? <RealtimeRefresher tables={["blogs"]} /> : null}
      <DashboardCanvas
        storeId={storeId}
        slots={slots}
        filters={
          <AnalyticsFilters
            range={range}
            locations={locationOptions}
            selectedLocationId={location.selectedId}
          />
        }
        settingsHref="/dashboard/settings/analytics"
        tabs={<AnalyticsTabs active="overview" />}
        headerControls={
          <TargetsManager
            targets={targetList}
            metrics={targetMetrics}
            presets={targetPeriodPresets(storeToday(timeZone))}
            canManage={access.can("analytics", "manage")}
            lock={canUseTargets ? undefined : lockFor("dashboardCustomization")}
          />
        }
        beforeSections={
          <>
            {insightsNode}
            {targetCards ? (
              <Suspense fallback={null}>
                <TargetsSection data={targetCards} />
              </Suspense>
            ) : null}
          </>
        }
        initialLayout={initialLayout}
        canCustomize={canCustomize}
        customizeLock={lockFor("dashboardCustomization")}
        previews={previews}
      />
    </div>
  );
}
