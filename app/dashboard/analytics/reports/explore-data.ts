import "server-only";

import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  categories,
  orderItems,
  orderRefunds,
  orders,
  products,
  storeLocations,
  storefrontDaily,
  storefrontDailyDimensions,
} from "@/drizzle/schema";
import {
  bucketIsPartial,
  bucketKeys,
  bucketLabel,
  bucketTitle,
} from "@/lib/analytics/buckets";
import {
  EXPLORE_METRICS,
  isTimeDimension,
  type ExploreConfig,
  type ExploreMetric,
  type TimeDimension,
} from "@/lib/analytics/explore";
import type { AnalyticsLocationSelection } from "@/lib/analytics/location";
import type { AnalyticsRange, AnalyticsWindow } from "@/lib/analytics/range";
import { withService } from "@/lib/db/client";
import type { AnalyticsValueFormat } from "../../components/analytics-format";
import {
  locationCondition,
  orderWindow,
  recognizedOrder,
  refundWindow,
} from "../data";
import { trafficKeyLabel, type TrafficDimension } from "../storefront-data";

// Executes a custom report. Every grouping is a fixed, tenant-scoped query;
// every measure is derived from the same base totals, so a "Total sales" here
// equals the dashboard's Total sales card for the same filters.

export interface ExploreRow {
  key: string;
  label: string;
  /** Full date for time groupings (tooltips, CSV). */
  title?: string;
  partial?: boolean;
  values: number[];
  previous: Array<number | null>;
}

export interface ExploreResult {
  columns: Array<{
    metric: ExploreMetric;
    label: string;
    format: AnalyticsValueFormat;
    lowerIsBetter: boolean;
  }>;
  rows: ExploreRow[];
  /** Every row for the CSV export (capped at 5,000), shown or not. */
  exportRows: ExploreRow[];
  totals: number[];
  previousTotals: number[] | null;
  /** More groups exist than are shown (the totals still include them). */
  truncated: boolean;
}

const MAX_ROWS = 250;
const MAX_EXPORT_ROWS = 5_000;

type Db = Parameters<Parameters<typeof withService>[0]>[0];

interface SalesBase {
  gross: number;
  discounts: number;
  shipping: number;
  taxes: number;
  total: number;
  orders: number;
  units: number;
  refunds: number;
}

interface TrafficBase {
  sessions: number;
  visitors: number;
  pageViews: number;
  converted: number;
  sales: number;
}

const zeroSales = (): SalesBase => ({
  gross: 0,
  discounts: 0,
  shipping: 0,
  taxes: 0,
  total: 0,
  orders: 0,
  units: 0,
  refunds: 0,
});

function addSales(into: SalesBase, from: Partial<SalesBase>) {
  for (const key of Object.keys(from) as Array<keyof SalesBase>) {
    into[key] += Number(from[key] ?? 0);
  }
}

function salesValue(metric: ExploreMetric, base: SalesBase): number {
  switch (metric) {
    case "gross_sales":
      return base.gross;
    case "discounts":
      return base.discounts;
    case "returns":
      return base.refunds;
    case "net_sales":
      return base.gross - base.discounts - base.refunds;
    case "shipping":
      return base.shipping;
    case "taxes":
      return base.taxes;
    case "orders":
      return base.orders;
    case "units":
      return base.units;
    case "average_order_value":
      return base.orders > 0 ? (base.total - base.refunds) / base.orders : 0;
    case "total_sales":
    default:
      return base.total - base.refunds;
  }
}

function trafficValue(metric: ExploreMetric, base: TrafficBase): number {
  switch (metric) {
    case "visitors":
      return base.visitors;
    case "page_views":
      return base.pageViews;
    case "converted_sessions":
      return base.converted;
    case "conversion_rate":
      return base.sessions > 0 ? (base.converted / base.sessions) * 100 : 0;
    case "traffic_sales":
      return base.sales;
    case "sessions":
    default:
      return base.sessions;
  }
}

/** Gross sales with the tax already inside tax-inclusive prices taken out. */
const GROSS_SQL = sql<number>`coalesce(sum(${orders.subtotal} - case when ${orders.taxInclusive} then ${orders.tax} else 0 end), 0)::float8`;

function orderAggregates() {
  return {
    gross: GROSS_SQL,
    discounts: sql<number>`coalesce(sum(${orders.discount}), 0)::float8`,
    shipping: sql<number>`coalesce(sum(${orders.shipping}), 0)::float8`,
    taxes: sql<number>`coalesce(sum(${orders.tax}), 0)::float8`,
    total: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
    orders: sql<number>`count(*)::int`,
  };
}

/**
 * The grouping key for order-attribute dimensions. Literal SQL only (no bound
 * values) so GROUP BY 1 sees the same text as the select.
 */
/**
 * Each customer's first recognized order, computed ONCE per query as a joined
 * derived table. A correlated subquery per order measured 4.9 s for a
 * 12-month report on 200k orders (2026-10-12); this is one grouped pass.
 */
function firstOrders(db: Db, storeId: string) {
  return db
    .select({
      customerId: orders.customerId,
      firstAt: sql<string>`min(${orders.createdAt})`.as("first_at"),
    })
    .from(orders)
    .where(
      and(
        eq(orders.storeId, storeId),
        sql`${orders.customerId} is not null`,
        recognizedOrder(),
      ),
    )
    .groupBy(orders.customerId)
    .as("first_orders");
}

function orderKey(
  dimension: string,
  window: AnalyticsWindow,
  firsts: ReturnType<typeof firstOrders> | null,
): { key: SQL<string>; joinLocations: boolean; where?: SQL } {
  switch (dimension) {
    case "channel":
      return { key: sql<string>`${orders.salesChannel}`, joinLocations: false };
    case "location":
      return {
        key: sql<string>`coalesce(${storeLocations.name}, 'Online / unassigned')`,
        joinLocations: true,
      };
    case "discount_code":
      return {
        key: sql<string>`upper(${orders.appliedCouponCode})`,
        joinLocations: false,
        where: sql`${orders.appliedCouponCode} is not null and ${orders.appliedCouponCode} <> ''`,
      };
    case "region":
      return {
        key: sql<string>`coalesce(nullif(initcap(trim(${orders.shippingAddress} ->> 'state')), ''), nullif(trim(${orders.shippingAddress} ->> 'country'), ''), 'Unknown')`,
        joinLocations: false,
        where: sql`${orders.shippingAddress} is not null`,
      };
    case "customer_type":
    default: {
      // New = this customer's first recognized order falls inside the range
      // (the same rule as the New vs returning card); guests are their own row.
      const from = window.from.toISOString();
      return {
        key: sql<string>`case
          when ${orders.customerId} is null then 'Guest'
          when ${firsts?.firstAt} >= ${from}::timestamptz then 'New'
          else 'Returning' end`,
        joinLocations: false,
      };
    }
  }
}

async function salesByOrderKey(
  db: Db,
  storeId: string,
  location: AnalyticsLocationSelection,
  window: AnalyticsWindow,
  dimension: string,
): Promise<Map<string, SalesBase>> {
  const scoped = locationCondition(location);
  const firsts =
    dimension === "customer_type" ? firstOrders(db, storeId) : null;
  const { key, joinLocations, where } = orderKey(dimension, window, firsts);
  const firstJoin = firsts
    ? eq(firsts.customerId, orders.customerId)
    : undefined;
  const locationJoin = and(
    eq(storeLocations.id, orders.locationId),
    eq(storeLocations.storeId, storeId),
  );
  const base = and(
    eq(orders.storeId, storeId),
    recognizedOrder(),
    orderWindow(window),
    ...(scoped ? [scoped] : []),
    ...(where ? [where] : []),
  );

  let orderQuery = db
    .select({ key, ...orderAggregates() })
    .from(orders)
    .$dynamic();
  if (joinLocations)
    orderQuery = orderQuery.leftJoin(storeLocations, locationJoin);
  if (firsts && firstJoin) orderQuery = orderQuery.leftJoin(firsts, firstJoin);
  const orderRows = await orderQuery.where(base).groupBy(sql`1`);

  let unitQuery = db
    .select({
      key,
      units: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .$dynamic();
  if (joinLocations)
    unitQuery = unitQuery.leftJoin(storeLocations, locationJoin);
  if (firsts && firstJoin) unitQuery = unitQuery.leftJoin(firsts, firstJoin);
  const unitRows = await unitQuery.where(base).groupBy(sql`1`);

  let refundQuery = db
    .select({
      key,
      refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
    })
    .from(orderRefunds)
    .innerJoin(
      orders,
      and(eq(orders.id, orderRefunds.orderId), eq(orders.storeId, storeId)),
    )
    .$dynamic();
  if (joinLocations)
    refundQuery = refundQuery.leftJoin(storeLocations, locationJoin);
  if (firsts && firstJoin)
    refundQuery = refundQuery.leftJoin(firsts, firstJoin);
  const refundRows = await refundQuery
    .where(
      and(
        eq(orderRefunds.storeId, storeId),
        eq(orderRefunds.status, "completed"),
        refundWindow(window),
        recognizedOrder(),
        ...(scoped ? [scoped] : []),
        ...(where ? [where] : []),
      ),
    )
    .groupBy(sql`1`);

  const out = new Map<string, SalesBase>();
  const at = (k: string) => {
    const value = out.get(k) ?? zeroSales();
    out.set(k, value);
    return value;
  };
  for (const row of orderRows) addSales(at(String(row.key)), row);
  for (const row of unitRows) at(String(row.key)).units += Number(row.units);
  for (const row of refundRows)
    at(String(row.key)).refunds += Number(row.refunds);
  return out;
}

async function salesByItemKey(
  db: Db,
  storeId: string,
  location: AnalyticsLocationSelection,
  window: AnalyticsWindow,
  dimension: "product" | "category",
): Promise<Map<string, SalesBase>> {
  const scoped = locationCondition(location);
  const key =
    dimension === "product"
      ? sql<string>`coalesce(${products.name}, max(${orderItems.name}))`
      : sql<string>`coalesce(${categories.name}, 'Uncategorized')`;
  const rows = await db
    .select({
      key,
      gross: sql<number>`coalesce(sum(${orderItems.price} * ${orderItems.quantity}), 0)::float8`,
      units: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
      orders: sql<number>`count(distinct ${orderItems.orderId})::int`,
    })
    .from(orderItems)
    .innerJoin(
      orders,
      and(
        eq(orders.id, orderItems.orderId),
        eq(orders.storeId, storeId),
        recognizedOrder(),
        orderWindow(window),
        ...(scoped ? [scoped] : []),
      ),
    )
    .leftJoin(products, eq(products.id, orderItems.productId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .groupBy(
      dimension === "product"
        ? sql`${orderItems.productId}, ${products.name}`
        : sql`1`,
    );
  const out = new Map<string, SalesBase>();
  for (const row of rows) {
    const value = out.get(String(row.key)) ?? zeroSales();
    value.gross += Number(row.gross);
    value.units += Number(row.units);
    value.orders += Number(row.orders);
    out.set(String(row.key), value);
  }
  return out;
}

async function salesByTime(
  db: Db,
  storeId: string,
  location: AnalyticsLocationSelection,
  window: AnalyticsWindow,
  grain: TimeDimension,
  timeZone: string,
): Promise<Map<string, SalesBase>> {
  const scoped = locationCondition(location);
  const bucket = sql`to_char(date_trunc(${grain}, ${orders.createdAt} at time zone ${timeZone}), 'YYYY-MM-DD')`;
  const refundBucket = sql`to_char(date_trunc(${grain}, ${orderRefunds.createdAt} at time zone ${timeZone}), 'YYYY-MM-DD')`;
  const base = and(
    eq(orders.storeId, storeId),
    recognizedOrder(),
    orderWindow(window),
    ...(scoped ? [scoped] : []),
  );
  const orderRows = await db
    .select({ key: sql<string>`${bucket}`, ...orderAggregates() })
    .from(orders)
    .where(base)
    .groupBy(sql`1`);
  const unitRows = await db
    .select({
      key: sql<string>`${bucket}`,
      units: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(base)
    .groupBy(sql`1`);
  const refundRows = await db
    .select({
      key: sql<string>`${refundBucket}`,
      refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
    })
    .from(orderRefunds)
    .innerJoin(
      orders,
      and(
        eq(orders.id, orderRefunds.orderId),
        eq(orders.storeId, storeId),
        ...(scoped ? [scoped] : []),
      ),
    )
    .where(
      and(
        eq(orderRefunds.storeId, storeId),
        eq(orderRefunds.status, "completed"),
        refundWindow(window),
      ),
    )
    .groupBy(sql`1`);
  const out = new Map<string, SalesBase>();
  const at = (k: string) => {
    const value = out.get(k) ?? zeroSales();
    out.set(k, value);
    return value;
  };
  for (const row of orderRows) addSales(at(String(row.key)), row);
  for (const row of unitRows) at(String(row.key)).units += Number(row.units);
  for (const row of refundRows)
    at(String(row.key)).refunds += Number(row.refunds);
  return out;
}

function dateKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

async function trafficByKey(
  db: Db,
  storeId: string,
  window: AnalyticsWindow,
  dimension: string,
  timeZone: string,
): Promise<Map<string, TrafficBase>> {
  const from = dateKey(window.from, timeZone);
  const to = dateKey(new Date(window.to.getTime() - 1), timeZone);
  const out = new Map<string, TrafficBase>();
  if (isTimeDimension(dimension as never)) {
    const rows = await db
      .select({
        key: sql<string>`to_char(date_trunc(${dimension}, ${storefrontDaily.date}::timestamp), 'YYYY-MM-DD')`,
        sessions: sql<number>`coalesce(sum(${storefrontDaily.sessions}), 0)::int`,
        visitors: sql<number>`coalesce(sum(${storefrontDaily.visitors}), 0)::int`,
        pageViews: sql<number>`coalesce(sum(${storefrontDaily.pageViews}), 0)::int`,
        converted: sql<number>`coalesce(sum(${storefrontDaily.convertedSessions}), 0)::int`,
      })
      .from(storefrontDaily)
      .where(
        and(
          eq(storefrontDaily.storeId, storeId),
          gte(storefrontDaily.date, from),
          lte(storefrontDaily.date, to),
        ),
      )
      .groupBy(sql`1`);
    for (const row of rows) {
      out.set(String(row.key), {
        sessions: Number(row.sessions),
        visitors: Number(row.visitors),
        pageViews: Number(row.pageViews),
        converted: Number(row.converted),
        sales: 0,
      });
    }
    return out;
  }
  const rows = await db
    .select({
      key: storefrontDailyDimensions.key,
      sessions: sql<number>`coalesce(sum(${storefrontDailyDimensions.sessions}), 0)::int`,
      visitors: sql<number>`coalesce(sum(${storefrontDailyDimensions.visitors}), 0)::int`,
      pageViews: sql<number>`coalesce(sum(${storefrontDailyDimensions.pageViews}), 0)::int`,
      converted: sql<number>`coalesce(sum(${storefrontDailyDimensions.convertedSessions}), 0)::int`,
      sales: sql<number>`coalesce(sum(${storefrontDailyDimensions.sales}), 0)::float8`,
    })
    .from(storefrontDailyDimensions)
    .where(
      and(
        eq(storefrontDailyDimensions.storeId, storeId),
        eq(storefrontDailyDimensions.dimension, dimension),
        gte(storefrontDailyDimensions.date, from),
        lte(storefrontDailyDimensions.date, to),
      ),
    )
    .groupBy(storefrontDailyDimensions.key);
  for (const row of rows) {
    out.set(row.key, {
      sessions: Number(row.sessions),
      visitors: Number(row.visitors),
      pageViews: Number(row.pageViews),
      converted: Number(row.converted),
      sales: Number(row.sales),
    });
  }
  return out;
}

const CHANNEL_LABELS: Record<string, string> = {
  online: "Online store",
  pos: "Point of sale",
};

export async function runExploration(input: {
  storeId: string;
  location: AnalyticsLocationSelection;
  range: AnalyticsRange;
  config: ExploreConfig;
}): Promise<ExploreResult> {
  const { storeId, location, range, config } = input;
  const columns = config.metrics.map((metric) => ({
    metric,
    label: EXPLORE_METRICS[metric].label,
    format: EXPLORE_METRICS[metric].format,
    lowerIsBetter: Boolean(EXPLORE_METRICS[metric].lowerIsBetter),
  }));

  const fetchWindow = (db: Db, window: AnalyticsWindow) => {
    if (config.dataset === "traffic") {
      return trafficByKey(
        db,
        storeId,
        window,
        config.dimension,
        range.timeZone,
      );
    }
    if (isTimeDimension(config.dimension)) {
      return salesByTime(
        db,
        storeId,
        location,
        window,
        config.dimension,
        range.timeZone,
      );
    }
    if (config.dimension === "product" || config.dimension === "category") {
      return salesByItemKey(db, storeId, location, window, config.dimension);
    }
    return salesByOrderKey(db, storeId, location, window, config.dimension);
  };

  const [current, previous] = await withService(async (db) => {
    const now = await fetchWindow(db, range.current);
    const before = range.compare ? await fetchWindow(db, range.compare) : null;
    return [now, before] as const;
  });

  const valueOf = (metric: ExploreMetric, base: unknown) =>
    config.dataset === "traffic"
      ? trafficValue(metric, base as TrafficBase)
      : salesValue(metric, base as SalesBase);
  const emptyBase = (): SalesBase | TrafficBase =>
    config.dataset === "traffic"
      ? { sessions: 0, visitors: 0, pageViews: 0, converted: 0, sales: 0 }
      : zeroSales();
  const sum = (bases: Array<SalesBase | TrafficBase>) => {
    const total = emptyBase() as unknown as Record<string, number>;
    for (const base of bases) {
      for (const [k, v] of Object.entries(base)) total[k] += Number(v);
    }
    return total as unknown as SalesBase | TrafficBase;
  };

  let rows: ExploreRow[];
  let exportRows: ExploreRow[];
  let truncated = false;
  if (isTimeDimension(config.dimension)) {
    const grain = config.dimension;
    const keys = bucketKeys(range.current, grain, range.timeZone);
    const previousKeys = range.compare
      ? bucketKeys(range.compare, grain, range.timeZone)
      : [];
    rows = keys.map((key, index) => {
      const base = current.get(key) ?? emptyBase();
      const priorKey = previousKeys[index];
      const prior =
        previous && priorKey ? (previous.get(priorKey) ?? emptyBase()) : null;
      return {
        key,
        label: bucketLabel(key, grain),
        title: bucketTitle(key, grain),
        partial: bucketIsPartial(key, grain, range.current, range.timeZone),
        values: config.metrics.map((metric) => valueOf(metric, base)),
        previous: config.metrics.map((metric) =>
          prior ? valueOf(metric, prior) : null,
        ),
      };
    });
    exportRows = rows;
  } else {
    const label = (key: string) => {
      if (config.dataset === "traffic") {
        return trafficKeyLabel(config.dimension as TrafficDimension, key);
      }
      if (config.dimension === "channel") return CHANNEL_LABELS[key] ?? key;
      return key;
    };
    const all = [...current.entries()].map(([key, base]) => {
      const prior = previous ? (previous.get(key) ?? emptyBase()) : null;
      return {
        key,
        label: label(key),
        values: config.metrics.map((metric) => valueOf(metric, base)),
        previous: config.metrics.map((metric) =>
          prior ? valueOf(metric, prior) : null,
        ),
      };
    });
    all.sort(
      (a, b) =>
        (b.values[0] ?? 0) - (a.values[0] ?? 0) ||
        a.label.localeCompare(b.label),
    );
    truncated = all.length > MAX_ROWS;
    rows = all.slice(0, MAX_ROWS);
    exportRows = all.slice(0, MAX_EXPORT_ROWS);
  }

  const totalsBase = sum([...current.values()]);
  const previousTotalsBase = previous ? sum([...previous.values()]) : null;
  return {
    columns,
    rows,
    exportRows,
    totals: config.metrics.map((metric) => valueOf(metric, totalsBase)),
    previousTotals: previousTotalsBase
      ? config.metrics.map((metric) => valueOf(metric, previousTotalsBase))
      : null,
    truncated,
  };
}
