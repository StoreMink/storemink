import "server-only";

import {
  and,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  blogs,
  categories,
  enquiries,
  orderItems,
  orderPayments,
  orderRefunds,
  orderReturnItems,
  orderReturns,
  orders,
  products,
  stockMovements,
  storeLocations,
  users,
} from "@/drizzle/schema";
import type {
  AnalyticsLocationOption,
  AnalyticsLocationSelection,
} from "@/lib/analytics/location";
import {
  bucketGrain,
  bucketIsPartial,
  bucketKeys,
  bucketLabel,
  bucketTitle,
  type BucketGrain,
} from "@/lib/analytics/buckets";
import type { AnalyticsRange, AnalyticsWindow } from "@/lib/analytics/range";
import { withService } from "@/lib/db/client";
import type { LocationScope } from "@/lib/locations/scope";

export interface Stat {
  value: number;
  /** Null means there is no meaningful comparison (disabled or zero baseline). */
  trendPct: number | null;
  trendUp: boolean;
  spark: number[];
  /** The comparison window's buckets, aligned by position with `spark`. */
  previousSpark?: number[];
  /** The comparison window's total; null/absent when comparison is off. */
  previousValue?: number | null;
  /** First/last spark bucket only partly inside the range (drawn dashed). */
  sparkPartial?: { start: boolean; end: boolean };
}

export interface SalesPoint {
  key: string;
  /** Short axis label ("12 Aug"). */
  label: string;
  /** Full tooltip label ("Wed, 12 Aug 2026"). */
  title?: string;
  /** Raw store-currency units; never rounded to thousands. */
  sales: number;
  orders: number;
  units: number;
  /** Only part of this bucket is inside the range (an in-progress week). */
  partial?: boolean;
  /** The comparison bucket in the same position; null when there is none. */
  previousKey?: string | null;
  previousTitle?: string | null;
  previousSales?: number | null;
  previousOrders?: number | null;
  previousUnits?: number | null;
}

export interface SalesAnalytics {
  totalSales: Stat;
  orders: Stat;
  averageOrderValue: Stat;
  unitsSold: Stat;
  /** Every bucket in the range, zero-filled; quiet days are real zeros. */
  series: SalesPoint[];
  grain?: BucketGrain;
  rangeLabel: string;
  comparisonLabel: string | null;
}

export interface CatalogSnapshots {
  customers: Stat;
  products: Stat;
}

export interface TopCategory {
  name: string;
  amount: number;
  share: number;
}

export interface TopProduct {
  id: string;
  name: string;
  units: number;
  amount: number;
}

export interface CommerceBreakdown {
  key: string;
  name: string;
  amount: number;
  orders: number;
  share: number;
}

export interface CustomerMix {
  newCustomers: number;
  returningCustomers: number;
  totalCustomers: number;
}

export interface DiscountImpact {
  orderDiscounts: number;
  lineDiscounts: number;
  totalDiscounts: number;
  couponOrders: number;
}

export interface ReturnsAndRefunds {
  completedReturns: number;
  returnedUnits: number;
  returnedValue: number;
  completedRefunds: number;
}

export interface GrossMarginAnalytics {
  merchandiseSales: number;
  costedSales: number;
  costOfGoods: number;
  grossProfit: number;
  marginPercent: number;
  coveragePercent: number;
  costedUnits: number;
  totalUnits: number;
}

export function grossMarginFromTotals(input: {
  merchandiseSales: number;
  costedSales: number;
  costOfGoods: number;
  totalUnits: number;
  costedUnits: number;
}): GrossMarginAnalytics {
  const grossProfit = input.costedSales - input.costOfGoods;
  return {
    ...input,
    grossProfit,
    marginPercent:
      input.costedSales > 0 ? (grossProfit / input.costedSales) * 100 : 0,
    coveragePercent:
      input.merchandiseSales > 0
        ? (input.costedSales / input.merchandiseSales) * 100
        : input.totalUnits > 0
          ? (input.costedUnits / input.totalUnits) * 100
          : 100,
  };
}

export interface InventoryVelocityItem {
  id: string;
  name: string;
  units: number;
}

export interface RecentOrder {
  ref: string;
  name: string;
  total: number;
  status: string;
  createdAt: string;
}

export interface ActivityItem {
  kind: "order" | "enquiry" | "blog";
  who: string | null;
  detail: string;
  createdAt: string;
}

export const RECOGNIZED_PAYMENT_STATUSES = [
  "paid",
  "partially_refunded",
  "refunded",
] as const;
export const RECOGNIZED_POS_STATUSES = ["completed", "refunded"] as const;

export function locationCondition(
  selection: AnalyticsLocationSelection,
): SQL | undefined {
  if (selection.locationIds === null) return undefined;
  const physical =
    selection.locationIds.length > 0
      ? inArray(orders.locationId, selection.locationIds)
      : sql`false`;
  // Aggregate accessible views include online/unrouted orders. Selecting one
  // physical shop is intentionally exact and excludes those NULL rows.
  return selection.includeUnassigned
    ? or(isNull(orders.locationId), physical)
    : physical;
}

function inventoryLocationCondition(
  selection: AnalyticsLocationSelection,
): SQL | undefined {
  if (selection.locationIds === null) return undefined;
  const physical =
    selection.locationIds.length > 0
      ? inArray(stockMovements.locationId, selection.locationIds)
      : sql`false`;
  return selection.includeUnassigned
    ? or(isNull(stockMovements.locationId), physical)
    : physical;
}

export async function getAnalyticsLocationOptions(
  storeId: string,
  viewerScope: LocationScope,
): Promise<AnalyticsLocationOption[]> {
  const rows = await withService((db) =>
    db
      .select({ id: storeLocations.id, name: storeLocations.name })
      .from(storeLocations)
      .where(eq(storeLocations.storeId, storeId))
      .orderBy(storeLocations.sortOrder, storeLocations.name),
  );
  if (viewerScope === null) return rows;
  const allowed = new Set(viewerScope);
  return rows.filter((row) => allowed.has(row.id));
}

/** The single recognized-sale contract shared by all Phase 1 commerce cards. */
export function recognizedOrder(): SQL {
  return and(
    ne(orders.status, "cancelled"),
    // ★ An exchange's replacement order is written as a PAID order (the goods
    // that came back paid for it, app/actions/return-actions.ts). It is not a
    // sale: the original order already counted, so admitting it here counted
    // the same money and units twice.
    ne(orders.paymentMethod, "exchange"),
    or(
      eq(orders.paymentMethod, "cash_on_delivery"),
      inArray(orders.paymentStatus, [...RECOGNIZED_PAYMENT_STATUSES]),
      and(
        eq(orders.salesChannel, "pos"),
        inArray(orders.status, [...RECOGNIZED_POS_STATUSES]),
      ),
    ),
  ) as SQL;
}

export function orderWindow(window: AnalyticsWindow): SQL {
  return and(
    gte(orders.createdAt, window.from.toISOString()),
    lt(orders.createdAt, window.to.toISOString()),
  ) as SQL;
}

export function refundWindow(window: AnalyticsWindow): SQL {
  return and(
    gte(orderRefunds.createdAt, window.from.toISOString()),
    lt(orderRefunds.createdAt, window.to.toISOString()),
  ) as SQL;
}

export function comparisonTrend(
  current: number,
  previous: number | null,
): Pick<Stat, "trendPct" | "trendUp"> {
  if (previous === null || previous === 0) {
    return { trendPct: null, trendUp: current >= 0 };
  }
  return {
    trendPct:
      Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10,
    trendUp: current >= previous,
  };
}

export async function getSalesAnalytics(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
  channel: "all" | "online" | "pos" = "all",
): Promise<SalesAnalytics> {
  const scoped = locationCondition(location);
  const channelScope =
    channel === "all" ? undefined : eq(orders.salesChannel, channel);
  const grain = bucketGrain(range.current);

  return withService(async (db) => {
    type Bucket = { sales: number; orders: number; units: number };
    // One bucketed pass per window: orders, units and refunds, three
    // queries. Totals are the sum of the buckets (the same rows), so there is
    // no separate totals query (that halved this reader, 12 queries to 6).
    // Serial on purpose: the scoped client is a single connection, so
    // Promise.all here would only queue.
    //
    // ★ Orders and units stay SEPARATE queries. Folding units into the orders
    // query (a CTE of the window's order lines) measured faster at 90 days
    // but 40% slower at 12 months on 200k orders (2026-10-12), because the
    // IN-list of a large window's order ids costs more than the plain join.
    const bucketsFor = async (window: AnalyticsWindow) => {
      const bucket = sql`date_trunc(${grain}, ${orders.createdAt} at time zone ${range.timeZone})`;
      const scope = and(
        eq(orders.storeId, storeId),
        recognizedOrder(),
        orderWindow(window),
        ...(scoped ? [scoped] : []),
        ...(channelScope ? [channelScope] : []),
      );
      const orderRows = await db
        .select({
          key: sql<string>`to_char(${bucket}, 'YYYY-MM-DD')`,
          sales: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
          count: sql<number>`count(*)::int`,
        })
        .from(orders)
        .where(scope)
        // Reusing `bucket` here produces fresh bind placeholders in Drizzle, so
        // PostgreSQL no longer sees the GROUP BY expression as the selected one.
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      const unitRows = await db
        .select({
          key: sql<string>`to_char(${bucket}, 'YYYY-MM-DD')`,
          units: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
        })
        .from(orderItems)
        .innerJoin(orders, and(eq(orders.id, orderItems.orderId), scope))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      const refundBucket = sql`date_trunc(${grain}, ${orderRefunds.createdAt} at time zone ${range.timeZone})`;
      const refundRows = await db
        .select({
          key: sql<string>`to_char(${refundBucket}, 'YYYY-MM-DD')`,
          refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
        })
        .from(orderRefunds)
        .innerJoin(
          orders,
          and(
            eq(orders.id, orderRefunds.orderId),
            eq(orders.storeId, storeId),
            ...(scoped ? [scoped] : []),
            ...(channelScope ? [channelScope] : []),
          ),
        )
        .where(
          and(
            eq(orderRefunds.storeId, storeId),
            eq(orderRefunds.status, "completed"),
            refundWindow(window),
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      const points = new Map<string, Bucket>();
      const at = (key: string) => {
        const point = points.get(key) ?? { sales: 0, orders: 0, units: 0 };
        points.set(key, point);
        return point;
      };
      for (const row of orderRows) {
        const point = at(row.key);
        point.sales += Number(row.sales);
        point.orders = Number(row.count);
      }
      for (const row of unitRows) at(row.key).units = Number(row.units);
      for (const row of refundRows) at(row.key).sales -= Number(row.refunds);

      // ★ Zero-fill from the calendar, not from the rows: a day with no sales
      // is a real zero on the chart, not a gap the axis silently skips.
      const keys = bucketKeys(window, grain, range.timeZone);
      const known = new Set(keys);
      // A refund can only land inside the window, but keep any stray key
      // (e.g. a zone edge) rather than drop money from the series.
      for (const key of points.keys()) if (!known.has(key)) keys.push(key);
      keys.sort();
      return keys.map((key) => ({ key, ...(points.get(key) ?? at(key)) }));
    };
    const totalOf = (buckets: Array<Bucket>) =>
      buckets.reduce(
        (sum, bucket) => ({
          sales: sum.sales + bucket.sales,
          orders: sum.orders + bucket.orders,
          units: sum.units + bucket.units,
        }),
        { sales: 0, orders: 0, units: 0 },
      );

    const currentBuckets = await bucketsFor(range.current);
    const previousBuckets = range.compare
      ? await bucketsFor(range.compare)
      : null;
    const current = totalOf(currentBuckets);
    const previous = previousBuckets ? totalOf(previousBuckets) : null;

    // The comparison is lined up by POSITION (day 1 with day 1), which is how
    // a previous-period line reads on Shopify's charts. A custom comparison
    // shorter than the range simply ends early.
    const series: SalesPoint[] = currentBuckets.map((point, index) => {
      const prior = previousBuckets?.[index] ?? null;
      return {
        key: point.key,
        label: bucketLabel(point.key, grain),
        title: bucketTitle(point.key, grain),
        partial: bucketIsPartial(
          point.key,
          grain,
          range.current,
          range.timeZone,
        ),
        sales: point.sales,
        orders: point.orders,
        units: point.units,
        previousKey: prior?.key ?? null,
        previousTitle: prior ? bucketTitle(prior.key, grain) : null,
        previousSales: prior ? prior.sales : null,
        previousOrders: prior ? prior.orders : null,
        previousUnits: prior ? prior.units : null,
      };
    });
    const aov = (sales: number, count: number) =>
      count > 0 ? sales / count : 0;
    const sparkPartial = {
      start: series[0]?.partial ?? false,
      end: series.at(-1)?.partial ?? false,
    };
    const previousSpark = <T>(pick: (bucket: Bucket) => T): T[] | undefined =>
      previousBuckets ? previousBuckets.map(pick) : undefined;

    return {
      totalSales: {
        value: current.sales,
        ...comparisonTrend(current.sales, previous?.sales ?? null),
        spark: series.map((point) => point.sales),
        previousSpark: previousSpark((bucket) => bucket.sales),
        previousValue: previous?.sales ?? null,
        sparkPartial,
      },
      orders: {
        value: current.orders,
        ...comparisonTrend(current.orders, previous?.orders ?? null),
        spark: series.map((point) => point.orders),
        previousSpark: previousSpark((bucket) => bucket.orders),
        previousValue: previous?.orders ?? null,
        sparkPartial,
      },
      averageOrderValue: {
        value: aov(current.sales, current.orders),
        ...comparisonTrend(
          aov(current.sales, current.orders),
          previous && previous.orders > 0
            ? previous.sales / previous.orders
            : null,
        ),
        spark: series.map((point) => aov(point.sales, point.orders)),
        previousSpark: previousSpark((bucket) =>
          aov(bucket.sales, bucket.orders),
        ),
        previousValue: previous ? aov(previous.sales, previous.orders) : null,
        sparkPartial,
      },
      unitsSold: {
        value: current.units,
        ...comparisonTrend(current.units, previous?.units ?? null),
        spark: series.map((point) => point.units),
        previousSpark: previousSpark((bucket) => bucket.units),
        previousValue: previous?.units ?? null,
        sparkPartial,
      },
      series,
      grain,
      rangeLabel: range.label,
      comparisonLabel: range.comparisonLabel,
    };
  });
}

export interface SalesTotals {
  /** Recognized order totals less refunds settled in the window. */
  sales: number;
  orders: number;
}

/**
 * Just the totals, for callers that need one number per window (targets, the
 * month-pace insight). Two queries per window in ONE transaction, instead of
 * a full bucketed series each.
 */
export async function getSalesTotals(
  storeId: string,
  location: AnalyticsLocationSelection,
  windows: AnalyticsWindow[],
): Promise<SalesTotals[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const out: SalesTotals[] = [];
    for (const window of windows) {
      const [orderRow] = await db
        .select({
          sales: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
          count: sql<number>`count(*)::int`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.storeId, storeId),
            recognizedOrder(),
            orderWindow(window),
            ...(scoped ? [scoped] : []),
          ),
        );
      const [refundRow] = await db
        .select({
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
        );
      out.push({
        sales: Number(orderRow?.sales ?? 0) - Number(refundRow?.refunds ?? 0),
        orders: Number(orderRow?.count ?? 0),
      });
    }
    return out;
  });
}

/**
 * Gross margin over recognized merchandise lines, before returns/refunds.
 * Unknown costs are excluded from both the numerator and denominator rather
 * than being treated as free inventory. coveragePercent makes incompleteness
 * explicit to the merchant.
 */
export async function getGrossMarginAnalytics(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<GrossMarginAnalytics> {
  const scoped = locationCondition(location);
  const [row] = await withService((db) =>
    db
      .select({
        merchandiseSales: sql<number>`coalesce(sum(${orderItems.total}), 0)::float8`,
        costedSales: sql<number>`coalesce(sum(case when ${orderItems.unitCost} is not null then ${orderItems.total} else 0 end), 0)::float8`,
        costOfGoods: sql<number>`coalesce(sum(case when ${orderItems.unitCost} is not null then ${orderItems.unitCost} * ${orderItems.quantity} else 0 end), 0)::float8`,
        totalUnits: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
        costedUnits: sql<number>`coalesce(sum(case when ${orderItems.unitCost} is not null then ${orderItems.quantity} else 0 end), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          scoped,
        ),
      ),
  );
  const merchandiseSales = Number(row?.merchandiseSales ?? 0);
  const costedSales = Number(row?.costedSales ?? 0);
  const costOfGoods = Number(row?.costOfGoods ?? 0);
  const totalUnits = Number(row?.totalUnits ?? 0);
  const costedUnits = Number(row?.costedUnits ?? 0);
  return grossMarginFromTotals({
    merchandiseSales,
    costedSales,
    costOfGoods,
    costedUnits,
    totalUnits,
  });
}

export async function getCatalogSnapshots(
  storeId: string,
): Promise<CatalogSnapshots> {
  return withService(async (db) => {
    const [customers] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.storeId, storeId));
    const [published] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(
        and(eq(products.storeId, storeId), eq(products.status, "published")),
      );
    const snapshot = (value: number): Stat => ({
      value,
      trendPct: null,
      trendUp: true,
      spark: [],
    });
    return {
      customers: snapshot(Number(customers?.count ?? 0)),
      products: snapshot(Number(published?.count ?? 0)),
    };
  });
}

export async function getTopCategories(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<TopCategory[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const earnedRows = await db
      .select({
        name: sql<string>`coalesce(${categories.name}, 'Uncategorized')`,
        amount: sql<number>`coalesce(sum(${orderItems.total}), 0)::float8`,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderItems.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .leftJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .groupBy(sql`coalesce(${categories.name}, 'Uncategorized')`)
      .orderBy(desc(sql`coalesce(sum(${orderItems.total}), 0)`));
    const categoryRows = await db
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.storeId, storeId));
    const earned = new Map(
      earnedRows.map((row) => [row.name, Number(row.amount)]),
    );
    const total = earnedRows.reduce((sum, row) => sum + Number(row.amount), 0);
    const names = categoryRows
      .map((row) => row.name)
      .filter(Boolean) as string[];
    if ((earned.get("Uncategorized") ?? 0) > 0) names.push("Uncategorized");
    return names
      .map((name) => ({ name, amount: earned.get(name) ?? 0 }))
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
      .map((item) => ({
        ...item,
        share: total > 0 ? Math.round((item.amount / total) * 100) : 0,
      }));
  });
}

export async function getTopProducts(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
  limit = 10,
): Promise<TopProduct[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const rows = await db
      .select({
        id: orderItems.productId,
        name: sql<string>`max(${orderItems.name})`,
        units: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
        amount: sql<number>`coalesce(sum(${orderItems.total}), 0)::float8`,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderItems.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`coalesce(sum(${orderItems.quantity}), 0)`))
      .limit(Math.max(1, Math.min(limit, 10_000)));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      units: Number(row.units),
      amount: Number(row.amount),
    }));
  });
}

function channelName(key: string): string {
  if (key === "pos") return "Point of sale";
  if (key === "online") return "Online store";
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function finalizeBreakdown(
  earnedRows: Array<{
    key: string;
    name: string;
    amount: number;
    orders: number;
  }>,
  refundRows: Array<{ key: string; name?: string; refunds: number }>,
): CommerceBreakdown[] {
  const net = new Map(
    earnedRows.map((row) => [
      row.key,
      {
        key: row.key,
        name: row.name,
        amount: Number(row.amount),
        orders: Number(row.orders),
      },
    ]),
  );
  for (const refund of refundRows) {
    const row = net.get(refund.key) ?? {
      key: refund.key,
      name: refund.name ?? refund.key,
      amount: 0,
      orders: 0,
    };
    row.amount -= Number(refund.refunds);
    net.set(refund.key, row);
  }
  const rows = [...net.values()];
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return rows
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
    .map((row) => ({
      ...row,
      share:
        total > 0 ? Math.max(0, Math.round((row.amount / total) * 100)) : 0,
    }));
}

export async function getSalesByChannel(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<CommerceBreakdown[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const earnedRows = await db
      .select({
        key: orders.salesChannel,
        amount: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
        orders: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(orders.salesChannel);
    const refundRows = await db
      .select({
        key: orders.salesChannel,
        refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
      })
      .from(orderRefunds)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderRefunds.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          ...(scoped ? [scoped] : []),
        ),
      )
      .where(
        and(
          eq(orderRefunds.storeId, storeId),
          eq(orderRefunds.status, "completed"),
          refundWindow(range.current),
        ),
      )
      .groupBy(orders.salesChannel);
    return finalizeBreakdown(
      earnedRows.map((row) => ({ ...row, name: channelName(row.key) })),
      refundRows.map((row) => ({ ...row, name: channelName(row.key) })),
    );
  });
}

export async function getSalesByLocation(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<CommerceBreakdown[]> {
  const scoped = locationCondition(location);
  const key = sql<string>`coalesce(${orders.locationId}::text, 'online')`;
  const name = sql<string>`coalesce(${storeLocations.name}, 'Online / unassigned')`;
  return withService(async (db) => {
    const earnedRows = await db
      .select({
        key,
        name,
        amount: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
        orders: sql<number>`count(*)::int`,
      })
      .from(orders)
      .leftJoin(
        storeLocations,
        and(
          eq(storeLocations.id, orders.locationId),
          eq(storeLocations.storeId, storeId),
        ),
      )
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(key, name);
    const refundRows = await db
      .select({
        key,
        name,
        refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
      })
      .from(orderRefunds)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderRefunds.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          ...(scoped ? [scoped] : []),
        ),
      )
      .leftJoin(
        storeLocations,
        and(
          eq(storeLocations.id, orders.locationId),
          eq(storeLocations.storeId, storeId),
        ),
      )
      .where(
        and(
          eq(orderRefunds.storeId, storeId),
          eq(orderRefunds.status, "completed"),
          refundWindow(range.current),
        ),
      )
      .groupBy(key, name);
    return finalizeBreakdown(earnedRows, refundRows);
  });
}

export interface SalesBreakdown {
  /** Merchandise before discounts, with tax taken OUT of tax-inclusive prices. */
  grossSales: number;
  discounts: number;
  /** Completed refunds settled in the range (by settlement date). */
  returns: number;
  netSales: number;
  shipping: number;
  taxes: number;
  /** Anything the lines above don't explain (rounding, cashback, legacy). */
  adjustments: number;
  /** Equals the Total sales card: recognized order totals less refunds. */
  totalSales: number;
}

/**
 * Shopify's "Total sales breakdown". Every line reads `orders` (one row per
 * order, so nothing double-counts) for recognized orders in the range.
 *
 * ★ Gross sales is `subtotal` less tax on TAX-INCLUSIVE orders: an inclusive
 * price already contains its tax, and counting it in gross sales AND in the
 * Taxes line would add it twice. `total = gross - discount + tax + shipping`
 * then holds for both kinds of order; whatever does not reconcile is shown
 * as an adjustment rather than silently absorbed into a line.
 */
export async function getSalesBreakdown(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<SalesBreakdown> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const [row] = await db
      .select({
        gross: sql<number>`coalesce(sum(${orders.subtotal} - case when ${orders.taxInclusive} then ${orders.tax} else 0 end), 0)::float8`,
        discounts: sql<number>`coalesce(sum(${orders.discount}), 0)::float8`,
        shipping: sql<number>`coalesce(sum(${orders.shipping}), 0)::float8`,
        taxes: sql<number>`coalesce(sum(${orders.tax}), 0)::float8`,
        total: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      );
    const [refundRow] = await db
      .select({
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
          refundWindow(range.current),
        ),
      );
    return salesBreakdownFromTotals({
      grossSales: Number(row?.gross ?? 0),
      discounts: Number(row?.discounts ?? 0),
      shipping: Number(row?.shipping ?? 0),
      taxes: Number(row?.taxes ?? 0),
      orderTotal: Number(row?.total ?? 0),
      returns: Number(refundRow?.refunds ?? 0),
    });
  });
}

/** Pure reconciliation behind the breakdown (unit-tested). */
export function salesBreakdownFromTotals(input: {
  grossSales: number;
  discounts: number;
  shipping: number;
  taxes: number;
  orderTotal: number;
  returns: number;
}): SalesBreakdown {
  const { grossSales, discounts, shipping, taxes, orderTotal, returns } = input;
  const explained = grossSales - discounts + shipping + taxes;
  // Paise-level rounding is not an "adjustment" worth a line of its own.
  const adjustments =
    Math.abs(orderTotal - explained) >= 1 ? orderTotal - explained : 0;
  return {
    grossSales,
    discounts,
    returns,
    netSales: grossSales - discounts - returns,
    shipping,
    taxes,
    adjustments,
    totalSales: orderTotal - returns,
  };
}

export interface DiscountCodeSales {
  code: string;
  /** Recognized order totals that used the code (after the discount). */
  sales: number;
  orders: number;
  /** The whole markdown on those orders. */
  discount: number;
}

/** Sales from orders that used each discount code, most sales first. */
export async function getSalesByDiscountCode(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
  limit = 8,
): Promise<DiscountCodeSales[]> {
  const scoped = locationCondition(location);
  const code = sql<string>`upper(${orders.appliedCouponCode})`;
  return withService(async (db) => {
    const rows = await db
      .select({
        code,
        sales: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
        orders: sql<number>`count(*)::int`,
        discount: sql<number>`coalesce(sum(${orders.discount}), 0)::float8`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          isNotNull(orders.appliedCouponCode),
          ne(orders.appliedCouponCode, ""),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(desc(sql`2`))
      .limit(Math.max(1, Math.min(limit, 100)));
    return rows.map((row) => ({
      code: row.code,
      sales: Number(row.sales),
      orders: Number(row.orders),
      discount: Number(row.discount),
    }));
  });
}

/**
 * Online sales by where they were delivered: the state, or the country when
 * an address has no state. POS sales carry no delivery address and are not
 * part of this card. Net of refunds settled in the range, like every other
 * sales breakdown.
 */
export async function getSalesByRegion(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<CommerceBreakdown[]> {
  const scoped = locationCondition(location);
  // Literal JSON keys (not bound values), so GROUP BY sees the same text.
  const region = sql<string>`coalesce(nullif(initcap(trim(${orders.shippingAddress} ->> 'state')), ''), nullif(trim(${orders.shippingAddress} ->> 'country'), ''), 'Unknown')`;
  return withService(async (db) => {
    const earnedRows = await db
      .select({
        key: region,
        amount: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
        orders: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          isNotNull(orders.shippingAddress),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(sql`1`);
    const refundRows = await db
      .select({
        key: region,
        refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
      })
      .from(orderRefunds)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderRefunds.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          isNotNull(orders.shippingAddress),
          ...(scoped ? [scoped] : []),
        ),
      )
      .where(
        and(
          eq(orderRefunds.storeId, storeId),
          eq(orderRefunds.status, "completed"),
          refundWindow(range.current),
        ),
      )
      .groupBy(sql`1`);
    return finalizeBreakdown(
      earnedRows.map((row) => ({ ...row, name: row.key })),
      refundRows,
    );
  });
}

function paymentMethodName(key: string): string {
  const known: Record<string, string> = {
    cash: "Cash",
    card: "Card terminal",
    upi: "UPI",
    razorpay: "Razorpay",
    store_credit: "Store credit",
    gift_card: "Gift card",
    cash_on_delivery: "Cash on delivery",
    pay_at_store: "Pay at store",
    manual: "Manual refund",
  };
  return known[key] ?? channelName(key);
}

interface PaymentAmountRow {
  key: string;
  amount: number;
  orders: number;
}

export function buildPaymentBreakdown(input: {
  pos: PaymentAmountRow[];
  online: PaymentAmountRow[];
  storeCredit: { amount: number; orders: number } | null;
  refunds: Array<{ key: string; refunds: number }>;
}): CommerceBreakdown[] {
  const earned = new Map<
    string,
    { key: string; name: string; amount: number; orders: number }
  >();
  const add = (key: string, amount: number, orderCount: number) => {
    // `split` is only an order-level summary. Valid POS rows are itemized above
    // and valid online rows retain their actual gateway/COD method.
    if (key === "split") return;
    const row = earned.get(key) ?? {
      key,
      name: paymentMethodName(key),
      amount: 0,
      orders: 0,
    };
    row.amount += Number(amount);
    row.orders += Number(orderCount);
    earned.set(key, row);
  };
  for (const row of input.pos) add(row.key, row.amount, row.orders);
  if (Number(input.storeCredit?.amount ?? 0) > 0) {
    add(
      "store_credit",
      Number(input.storeCredit?.amount ?? 0),
      Number(input.storeCredit?.orders ?? 0),
    );
  }
  for (const row of input.online) add(row.key, row.amount, row.orders);
  return finalizeBreakdown(
    [...earned.values()],
    input.refunds.map((row) => ({
      ...row,
      name: paymentMethodName(row.key),
    })),
  );
}

export async function getSalesByPaymentMethod(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<CommerceBreakdown[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const posRows = await db
      .select({
        key: orderPayments.method,
        amount: sql<number>`coalesce(sum(${orderPayments.amount}), 0)::float8`,
        orders: sql<number>`count(distinct ${orderPayments.orderId})::int`,
      })
      .from(orderPayments)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderPayments.orderId),
          eq(orders.storeId, storeId),
          eq(orders.salesChannel, "pos"),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .where(eq(orderPayments.storeId, storeId))
      .groupBy(orderPayments.method);
    const [creditRow] = await db
      .select({
        amount: sql<number>`coalesce(sum(${orders.storeCreditUsed}), 0)::float8`,
        orders: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          ne(orders.salesChannel, "pos"),
          gt(orders.storeCreditUsed, 0),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      );
    const onlineRows = await db
      .select({
        key: orders.paymentMethod,
        amount: sql<number>`coalesce(sum(greatest(${orders.total} - ${orders.storeCreditUsed}, 0)), 0)::float8`,
        orders: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          ne(orders.salesChannel, "pos"),
          gt(sql`greatest(${orders.total} - ${orders.storeCreditUsed}, 0)`, 0),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(orders.paymentMethod);
    const refundRows = await db
      .select({
        key: orderRefunds.method,
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
          refundWindow(range.current),
        ),
      )
      .groupBy(orderRefunds.method);

    return buildPaymentBreakdown({
      pos: posRows,
      online: onlineRows,
      storeCredit: creditRow ?? null,
      refunds: refundRows,
    });
  });
}

export async function getCustomerMix(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<CustomerMix> {
  const scoped = locationCondition(location);
  const from = range.current.from.toISOString();
  const to = range.current.to.toISOString();
  return withService(async (db) => {
    // ★ Classified IN SQL. This used to return one row per customer who ever
    // ordered (20,000 for a busy store) for the app to count; the database
    // now returns the two counts. Same rule as classifyCustomerMix: only
    // customers with an order in the range, new when their first recognized
    // order is inside it.
    const perCustomer = db
      .select({
        firstOrderAt: sql<string>`min(${orders.createdAt})`.as(
          "first_order_at",
        ),
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          isNotNull(orders.customerId),
          recognizedOrder(),
          lt(orders.createdAt, to),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(orders.customerId)
      .having(
        sql`count(*) filter (where ${orders.createdAt} >= ${from} and ${orders.createdAt} < ${to}) > 0`,
      )
      .as("per_customer");
    const [row] = await db
      .select({
        newCustomers: sql<number>`count(*) filter (where ${perCustomer.firstOrderAt} >= ${from})::int`,
        returningCustomers: sql<number>`count(*) filter (where ${perCustomer.firstOrderAt} < ${from})::int`,
      })
      .from(perCustomer);
    const newCustomers = Number(row?.newCustomers ?? 0);
    const returningCustomers = Number(row?.returningCustomers ?? 0);
    return {
      newCustomers,
      returningCustomers,
      totalCustomers: newCustomers + returningCustomers,
    };
  });
}

export function classifyCustomerMix(
  rows: Array<{ firstOrderAt: string; currentOrders: number }>,
  currentFrom: Date,
): CustomerMix {
  let newCustomers = 0;
  let returningCustomers = 0;
  for (const row of rows) {
    if (Number(row.currentOrders) <= 0) continue;
    if (new Date(row.firstOrderAt) >= currentFrom) newCustomers += 1;
    else returningCustomers += 1;
  }
  return {
    newCustomers,
    returningCustomers,
    totalCustomers: newCustomers + returningCustomers,
  };
}

export async function getDiscountImpact(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<DiscountImpact> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const [orderRow] = await db
      .select({
        discounts: sql<number>`coalesce(sum(${orders.discount}), 0)::float8`,
        couponOrders: sql<number>`count(*) filter (where ${orders.appliedCouponCode} is not null)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      );
    const [lineRow] = await db
      .select({
        discounts: sql<number>`coalesce(sum(${orderItems.lineDiscount}), 0)::float8`,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderItems.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      );
    // ★ `orders.discount` is ALREADY the whole markdown: line markdowns +
    // offer discounts + the order-level discount (lib/pos/totals.ts; online
    // checkout has no line markdowns). Adding `line_discount` on top counted
    // every POS markdown twice. Lines are a SUBSET, shown for the split only.
    const totalDiscounts = Number(orderRow?.discounts ?? 0);
    const lineDiscounts = Number(lineRow?.discounts ?? 0);
    return {
      orderDiscounts: Math.max(0, totalDiscounts - lineDiscounts),
      lineDiscounts,
      totalDiscounts,
      couponOrders: Number(orderRow?.couponOrders ?? 0),
    };
  });
}

export async function getReturnsAndRefunds(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<ReturnsAndRefunds> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const [returnRow] = await db
      .select({
        count: sql<number>`count(*)::int`,
        value: sql<number>`coalesce(sum(${orderReturns.total}), 0)::float8`,
      })
      .from(orderReturns)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderReturns.orderId),
          eq(orders.storeId, storeId),
          ...(scoped ? [scoped] : []),
        ),
      )
      .where(
        and(
          eq(orderReturns.storeId, storeId),
          eq(orderReturns.status, "completed"),
          gte(orderReturns.createdAt, range.current.from.toISOString()),
          lt(orderReturns.createdAt, range.current.to.toISOString()),
        ),
      );
    const [itemRow] = await db
      .select({
        units: sql<number>`coalesce(sum(${orderReturnItems.quantity}), 0)::int`,
      })
      .from(orderReturnItems)
      .innerJoin(
        orderReturns,
        and(
          eq(orderReturns.id, orderReturnItems.returnId),
          eq(orderReturns.storeId, storeId),
          eq(orderReturns.status, "completed"),
          gte(orderReturns.createdAt, range.current.from.toISOString()),
          lt(orderReturns.createdAt, range.current.to.toISOString()),
        ),
      )
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderReturns.orderId),
          eq(orders.storeId, storeId),
          ...(scoped ? [scoped] : []),
        ),
      );
    const [refundRow] = await db
      .select({
        value: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
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
          refundWindow(range.current),
        ),
      );
    return {
      completedReturns: Number(returnRow?.count ?? 0),
      returnedUnits: Number(itemRow?.units ?? 0),
      returnedValue: Number(returnRow?.value ?? 0),
      completedRefunds: Number(refundRow?.value ?? 0),
    };
  });
}

export async function getInventoryVelocity(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<InventoryVelocityItem[]> {
  const scoped = inventoryLocationCondition(location);
  return withService(async (db) => {
    const rows = await db
      .select({
        id: stockMovements.productId,
        name: sql<string>`max(${products.name})`,
        units: sql<number>`coalesce(sum(abs(${stockMovements.delta})), 0)::int`,
      })
      .from(stockMovements)
      .innerJoin(
        products,
        and(
          eq(products.id, stockMovements.productId),
          eq(products.storeId, storeId),
        ),
      )
      .innerJoin(
        orders,
        and(
          eq(orders.id, stockMovements.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
        ),
      )
      .where(
        and(
          eq(stockMovements.storeId, storeId),
          eq(stockMovements.reason, "sale"),
          lt(stockMovements.delta, 0),
          gte(stockMovements.createdAt, range.current.from.toISOString()),
          lt(stockMovements.createdAt, range.current.to.toISOString()),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(stockMovements.productId)
      .orderBy(desc(sql`coalesce(sum(abs(${stockMovements.delta})), 0)`))
      .limit(10);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      units: Number(row.units),
    }));
  });
}

export async function getRecentOrders(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<RecentOrder[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const rows = await db
      .select({
        ref: orders.orderRef,
        total: orders.total,
        status: orders.status,
        createdAt: orders.createdAt,
        first: sql<string>`${orders.shippingAddress}->>'firstName'`,
        last: sql<string>`${orders.shippingAddress}->>'lastName'`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(5);
    return rows.map((row) => ({
      ref: row.ref,
      name: `${row.first ?? ""} ${row.last ?? ""}`.trim() || "Guest",
      total: Number(row.total),
      status: row.status,
      createdAt: row.createdAt,
    }));
  });
}

export async function getActivity(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
  visibility: { includeEnquiries: boolean; includeBlogs: boolean },
): Promise<ActivityItem[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const orderRows = await db
      .select({
        ref: orders.orderRef,
        createdAt: orders.createdAt,
        first: sql<string>`${orders.shippingAddress}->>'firstName'`,
        last: sql<string>`${orders.shippingAddress}->>'lastName'`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(5);
    const enquiryRows = visibility.includeEnquiries
      ? await db
          .select({
            name: enquiries.name,
            subject: enquiries.subject,
            createdAt: enquiries.createdAt,
          })
          .from(enquiries)
          .where(
            and(
              eq(enquiries.storeId, storeId),
              gte(enquiries.createdAt, range.current.from.toISOString()),
              lt(enquiries.createdAt, range.current.to.toISOString()),
            ),
          )
          .orderBy(desc(enquiries.createdAt))
          .limit(5)
      : [];
    const blogRows = visibility.includeBlogs
      ? await db
          .select({
            title: blogs.title,
            author: blogs.author,
            status: blogs.status,
            createdAt: blogs.createdAt,
          })
          .from(blogs)
          .where(
            and(
              eq(blogs.storeId, storeId),
              gte(blogs.createdAt, range.current.from.toISOString()),
              lt(blogs.createdAt, range.current.to.toISOString()),
            ),
          )
          .orderBy(desc(blogs.createdAt))
          .limit(5)
      : [];
    return [
      ...orderRows.map((row) => ({
        kind: "order" as const,
        who: `${row.first ?? ""} ${row.last ?? ""}`.trim() || "Guest",
        detail: `placed order ${row.ref}`,
        createdAt: row.createdAt,
      })),
      ...enquiryRows.map((row) => ({
        kind: "enquiry" as const,
        who: row.name,
        detail: row.subject ? `enquired: ${row.subject}` : "sent an enquiry",
        createdAt: row.createdAt,
      })),
      ...blogRows.map((row) => ({
        kind: "blog" as const,
        who: row.author,
        detail:
          row.status === "published"
            ? `published "${row.title}"`
            : `submitted "${row.title}"`,
        createdAt: row.createdAt,
      })),
    ]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 6);
  });
}
