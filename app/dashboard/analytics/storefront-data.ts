import "server-only";

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { storefrontDaily, storefrontDailyDimensions } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { storeHasAnalyticsFeature } from "@/lib/analytics/store-entitlement";
import type { AnalyticsRange, AnalyticsWindow } from "@/lib/analytics/range";
import {
  bucketGrain,
  bucketIsPartial,
  bucketKeys,
  bucketLabel,
  bucketTitle,
} from "@/lib/analytics/buckets";
import {
  DEVICE_LABELS,
  TRAFFIC_SOURCE_LABELS,
  countryDisplayName,
  regionDisplayName,
  type DeviceType,
  type TrafficSource,
} from "@/lib/analytics/traffic";
import type { Stat } from "./data";

export interface StorefrontAnalytics {
  visitors: Stat;
  sessions: Stat;
  pageViews: Stat;
  productSessions: number;
  cartSessions: number;
  checkoutSessions: number;
  convertedSessions: number;
  purchases: number;
  conversionRate: number;
}

function dateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function stat(value: number, spark: number[]): Stat {
  return { value, spark, trendPct: null, trendUp: true };
}

export async function storeHasProAnalytics(storeId: string): Promise<boolean> {
  return storeHasAnalyticsFeature(storeId, "storefrontConversion");
}

export async function getStorefrontAnalytics(
  storeId: string,
  range: AnalyticsRange,
): Promise<StorefrontAnalytics> {
  const from = dateKey(range.current.from, range.timeZone);
  const to = dateKey(new Date(range.current.to.getTime() - 1), range.timeZone);
  const rows = await withService((db) =>
    db
      .select({
        date: storefrontDaily.date,
        visitors: storefrontDaily.visitors,
        sessions: storefrontDaily.sessions,
        pageViews: storefrontDaily.pageViews,
        productSessions: storefrontDaily.productSessions,
        cartSessions: storefrontDaily.cartSessions,
        checkoutSessions: storefrontDaily.checkoutSessions,
        convertedSessions: storefrontDaily.convertedSessions,
        purchases: storefrontDaily.purchases,
      })
      .from(storefrontDaily)
      .where(
        and(
          eq(storefrontDaily.storeId, storeId),
          gte(storefrontDaily.date, from),
          lte(storefrontDaily.date, to),
        ),
      )
      .orderBy(storefrontDaily.date),
  );
  const sum = (key: keyof (typeof rows)[number]) =>
    rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const sessions = sum("sessions");
  const convertedSessions = sum("convertedSessions");
  return {
    visitors: stat(
      sum("visitors"),
      rows.map((row) => row.visitors),
    ),
    sessions: stat(
      sessions,
      rows.map((row) => row.sessions),
    ),
    pageViews: stat(
      sum("pageViews"),
      rows.map((row) => row.pageViews),
    ),
    productSessions: sum("productSessions"),
    cartSessions: sum("cartSessions"),
    checkoutSessions: sum("checkoutSessions"),
    convertedSessions,
    purchases: sum("purchases"),
    conversionRate: sessions > 0 ? (convertedSessions / sessions) * 100 : 0,
  };
}

export type TrafficDimension =
  | "device"
  | "source"
  | "referrer"
  | "landing_page"
  | "campaign"
  | "country"
  | "region"
  | "city";

export interface TrafficBreakdownRow {
  key: string;
  label: string;
  sessions: number;
  visitors: number;
  convertedSessions: number;
  sales: number;
  previousSessions: number | null;
}

/** A dimension key as a merchant reads it ("IN|MH|Mumbai" -> "Mumbai, Maharashtra"). */
export function trafficKeyLabel(
  dimension: TrafficDimension,
  key: string,
): string {
  if (dimension === "device") {
    return DEVICE_LABELS[key as DeviceType] ?? key;
  }
  if (dimension === "source") {
    return TRAFFIC_SOURCE_LABELS[key as TrafficSource] ?? key;
  }
  if (dimension === "country") return countryDisplayName(key);
  if (dimension === "region") {
    const [country, region] = key.split("|");
    return country && region ? regionDisplayName(country, region) : key;
  }
  if (dimension === "city") {
    const [country, region, city] = key.split("|");
    if (!country || !city) return key;
    const where =
      country === "IN" && region
        ? regionDisplayName(country, region)
        : countryDisplayName(country);
    // "Delhi, Delhi" reads as a typo; a city that names its own state stands alone.
    return where === city ? city : `${city}, ${where}`;
  }
  return key;
}

function windowDates(window: AnalyticsWindow, timeZone: string) {
  return {
    from: dateKey(window.from, timeZone),
    to: dateKey(new Date(window.to.getTime() - 1), timeZone),
  };
}

/**
 * Sessions by one traffic dimension over the range, with the comparison
 * window's sessions for each key. Reads the daily rollup (migration 0187),
 * which keeps the top 50 keys per day, so long-tail keys may be missing from
 * long ranges; the cards show the top few.
 */
export async function getTrafficBreakdown(
  storeId: string,
  range: AnalyticsRange,
  dimension: TrafficDimension,
  limit = 10,
): Promise<TrafficBreakdownRow[]> {
  const current = windowDates(range.current, range.timeZone);
  const previous = range.compare
    ? windowDates(range.compare, range.timeZone)
    : null;
  const totals = (
    db: Parameters<Parameters<typeof withService>[0]>[0],
    window: { from: string; to: string },
    cap: number,
  ) =>
    db
      .select({
        key: storefrontDailyDimensions.key,
        sessions: sql<number>`coalesce(sum(${storefrontDailyDimensions.sessions}), 0)::int`,
        visitors: sql<number>`coalesce(sum(${storefrontDailyDimensions.visitors}), 0)::int`,
        converted: sql<number>`coalesce(sum(${storefrontDailyDimensions.convertedSessions}), 0)::int`,
        sales: sql<number>`coalesce(sum(${storefrontDailyDimensions.sales}), 0)::float8`,
      })
      .from(storefrontDailyDimensions)
      .where(
        and(
          eq(storefrontDailyDimensions.storeId, storeId),
          eq(storefrontDailyDimensions.dimension, dimension),
          gte(storefrontDailyDimensions.date, window.from),
          lte(storefrontDailyDimensions.date, window.to),
        ),
      )
      .groupBy(storefrontDailyDimensions.key)
      .orderBy(desc(sql`2`), storefrontDailyDimensions.key)
      .limit(cap);
  const [now, before] = await withService(async (db) => {
    const rows = await totals(db, current, Math.max(1, Math.min(limit, 50)));
    const prior = previous ? await totals(db, previous, 200) : null;
    return [rows, prior] as const;
  });
  const prior = new Map(before?.map((row) => [row.key, Number(row.sessions)]));
  return now.map((row) => ({
    key: row.key,
    label: trafficKeyLabel(dimension, row.key),
    sessions: Number(row.sessions),
    visitors: Number(row.visitors),
    convertedSessions: Number(row.converted),
    sales: Number(row.sales),
    previousSessions: before ? (prior.get(row.key) ?? 0) : null,
  }));
}

export interface SessionsSeries {
  points: Array<{
    key: string;
    label: string;
    title: string;
    value: number;
    previous: number | null;
    previousTitle: string | null;
    partial: boolean;
  }>;
  total: number;
  previousTotal: number | null;
}

/** Sessions per day, week or month, zero-filled, comparison aligned by position. */
export async function getSessionsSeries(
  storeId: string,
  range: AnalyticsRange,
): Promise<SessionsSeries> {
  const grain = bucketGrain(range.current);
  const bucketed = (
    db: Parameters<Parameters<typeof withService>[0]>[0],
    window: AnalyticsWindow,
  ) => {
    const { from, to } = windowDates(window, range.timeZone);
    return db
      .select({
        key: sql<string>`to_char(date_trunc(${grain}, ${storefrontDaily.date}::timestamp), 'YYYY-MM-DD')`,
        sessions: sql<number>`coalesce(sum(${storefrontDaily.sessions}), 0)::int`,
      })
      .from(storefrontDaily)
      .where(
        and(
          eq(storefrontDaily.storeId, storeId),
          gte(storefrontDaily.date, from),
          lte(storefrontDaily.date, to),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);
  };
  const [currentRows, previousRows] = await withService(async (db) => {
    const rows = await bucketed(db, range.current);
    const prior = range.compare ? await bucketed(db, range.compare) : null;
    return [rows, prior] as const;
  });
  const fill = (
    window: AnalyticsWindow,
    rows: ReadonlyArray<{ key: string; sessions: number }>,
  ) => {
    const byKey = new Map(rows.map((row) => [row.key, Number(row.sessions)]));
    return bucketKeys(window, grain, range.timeZone).map((key) => ({
      key,
      value: byKey.get(key) ?? 0,
    }));
  };
  const current = fill(range.current, currentRows);
  const previous =
    range.compare && previousRows ? fill(range.compare, previousRows) : null;
  return {
    points: current.map((point, index) => {
      const prior = previous?.[index] ?? null;
      return {
        key: point.key,
        label: bucketLabel(point.key, grain),
        title: bucketTitle(point.key, grain),
        value: point.value,
        previous: prior ? prior.value : null,
        previousTitle: prior ? bucketTitle(prior.key, grain) : null,
        partial: bucketIsPartial(
          point.key,
          grain,
          range.current,
          range.timeZone,
        ),
      };
    }),
    total: current.reduce((sum, point) => sum + point.value, 0),
    previousTotal: previous
      ? previous.reduce((sum, point) => sum + point.value, 0)
      : null,
  };
}
