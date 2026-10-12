import "server-only";

import { and, asc, eq, gte } from "drizzle-orm";
import { analyticsTargets } from "@/drizzle/schema";
import type { AnalyticsLocationSelection } from "@/lib/analytics/location";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import {
  TARGET_METRIC_META,
  isTargetMetric,
  targetProgress,
  type TargetMetric,
  type TargetProgress,
} from "@/lib/analytics/targets";
import { withService } from "@/lib/db/client";
import { getCustomerMix, getSalesTotals } from "./data";
import { getStorefrontAnalytics } from "./storefront-data";

export interface TargetCardData {
  id: string;
  metric: TargetMetric;
  periodStart: string;
  periodEnd: string;
  targetValue: number;
  /** null when the metric needs a plan the store no longer has. */
  current: number | null;
  progress: TargetProgress | null;
}

/** The store-local calendar date for an instant. */
export function storeToday(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function shiftDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Targets still worth showing (running, upcoming, or ended in the last 31
 * days) with their progress. Each reads the SAME definitions as the dashboard
 * cards, over the target's own period up to today, in the viewer's location
 * scope (a staff member restricted to one shop sees that shop's progress).
 */
export async function getTargetCards(input: {
  storeId: string;
  location: AnalyticsLocationSelection;
  timeZone: string;
  trafficAllowed: boolean;
}): Promise<TargetCardData[]> {
  const today = storeToday(input.timeZone);
  const rows = await withService((db) =>
    db
      .select({
        id: analyticsTargets.id,
        metric: analyticsTargets.metric,
        periodStart: analyticsTargets.periodStart,
        periodEnd: analyticsTargets.periodEnd,
        targetValue: analyticsTargets.targetValue,
      })
      .from(analyticsTargets)
      .where(
        and(
          eq(analyticsTargets.storeId, input.storeId),
          gte(analyticsTargets.periodEnd, shiftDays(today, -31)),
        ),
      )
      .orderBy(
        asc(analyticsTargets.periodStart),
        asc(analyticsTargets.createdAt),
      ),
  );

  return Promise.all(
    rows
      .filter((row) => isTargetMetric(row.metric))
      .map(async (row): Promise<TargetCardData> => {
        const metric = row.metric as TargetMetric;
        const targetValue = Number(row.targetValue);
        const base = {
          id: row.id,
          metric,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          targetValue,
        };
        if (TARGET_METRIC_META[metric].traffic && !input.trafficAllowed) {
          return { ...base, current: null, progress: null };
        }
        let current = 0;
        if (row.periodStart <= today) {
          const end = row.periodEnd < today ? row.periodEnd : today;
          const range = parseAnalyticsRange(
            {
              range: "custom",
              from: row.periodStart,
              to: end,
              compare: "none",
            },
            input.timeZone,
          );
          if (metric === "new_customers") {
            current = (
              await getCustomerMix(input.storeId, input.location, range)
            ).newCustomers;
          } else if (metric === "sessions" || metric === "conversion_rate") {
            const traffic = await getStorefrontAnalytics(input.storeId, range);
            current =
              metric === "sessions"
                ? traffic.sessions.value
                : traffic.conversionRate;
          } else {
            // Totals only: a target needs one number, not a series.
            const [totals] = await getSalesTotals(
              input.storeId,
              input.location,
              [range.current],
            );
            current =
              metric === "total_sales"
                ? totals.sales
                : metric === "orders"
                  ? totals.orders
                  : totals.orders > 0
                    ? totals.sales / totals.orders
                    : 0;
          }
        }
        return {
          ...base,
          current,
          progress: targetProgress({ ...base, current, today }),
        };
      }),
  );
}

/** The store's targets for the editor (no progress maths, so it is quick). */
export async function listAnalyticsTargets(storeId: string): Promise<
  Array<{
    id: string;
    metric: TargetMetric;
    periodStart: string;
    periodEnd: string;
    targetValue: number;
  }>
> {
  const rows = await withService((db) =>
    db
      .select({
        id: analyticsTargets.id,
        metric: analyticsTargets.metric,
        periodStart: analyticsTargets.periodStart,
        periodEnd: analyticsTargets.periodEnd,
        targetValue: analyticsTargets.targetValue,
      })
      .from(analyticsTargets)
      .where(eq(analyticsTargets.storeId, storeId))
      .orderBy(
        asc(analyticsTargets.periodStart),
        asc(analyticsTargets.createdAt),
      ),
  );
  return rows
    .filter((row) => isTargetMetric(row.metric))
    .map((row) => ({
      id: row.id,
      metric: row.metric as TargetMetric,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      targetValue: Number(row.targetValue),
    }));
}
