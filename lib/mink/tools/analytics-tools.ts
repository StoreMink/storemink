import "server-only";

import { runExploration } from "@/app/dashboard/analytics/reports/explore-data";
import {
  EXPLORE_DIMENSION_LABELS,
  EXPLORE_METRICS,
  dimensionsFor,
  exploreSearch,
  isTimeDimension,
  metricsFor,
  normalizeExploreConfig,
  type ExploreDimension,
  type ExploreMetric,
} from "@/lib/analytics/explore";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { storeHasAnalyticsFeature } from "@/lib/analytics/store-entitlement";
import { MinkToolInputError } from "../errors";
import type { MinkArtifact } from "../types";
import { resolveMinkLocation } from "./location-scope";
import type { MinkTool } from "./registry";

/**
 * `query_analytics`: one measure, grouped one way, over one bounded period.
 *
 * ★★ A WHITELIST, NOT A QUERY LANGUAGE, and it is the merchant's own. The
 * Reports builder (`lib/analytics/explore.ts`) already defines every
 * dataset, measure and grouping a merchant may pick on screen, and
 * `runExploration` is the one implementation behind it; this tool hands the
 * model that same closed vocabulary, so a figure Mink quotes is the figure
 * the matching report shows, and there is no second SQL to drift. Traffic
 * measures need the Pro storefront-conversion module, checked here the way
 * the Reports page checks it.
 *
 * ★ THE RESULT IS A CHART AS WELL AS NUMBERS. A time grouping draws a line
 * (the comparison period dashed beside it); a breakdown draws its top rows
 * as bars. The card links to the same configuration in Reports.
 */
const PERIODS = [
  "today",
  "yesterday",
  "7d",
  "30d",
  "90d",
  "mtd",
  "ytd",
  "12m",
] as const;
const COMPARISONS = ["previous", "year", "none"] as const;
const GROUPINGS = [
  ...new Set([...dimensionsFor("sales"), ...dimensionsFor("traffic")]),
] as ExploreDimension[];
const METRICS = Object.keys(EXPLORE_METRICS) as ExploreMetric[];
const MAX_CHART_POINTS = 120;
const MAX_BREAKDOWN_ROWS = 20;

function readEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  fallback: T[number],
): T[number] {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new MinkToolInputError(
      `${field} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T[number];
}

export const queryAnalytics: MinkTool = {
  declaration: {
    name: "query_analytics",
    description:
      "Run one bounded analytics query the way the merchant's Reports builder does: one measure (sales, orders, average order value, units, discounts, returns, shipping, taxes, or on Pro the storefront sessions, visitors, page views, converted sessions and conversion rate), grouped by a time grain (day, week, month) or a breakdown (product, category, channel, location, discount code, region, new versus returning customers; for traffic also device, source, referrer, landing page, campaign, country, city), over one period in the store timezone, with an optional comparison period. Returns the rows, totals and a chart card, and a link to the same report. Use get_sales_summary for a single headline figure; use this for a trend, a ranking or a breakdown. Never invent a figure the result does not contain.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: METRICS,
          description: "The one measure to report.",
        },
        group_by: {
          type: "string",
          enum: GROUPINGS,
          description:
            "A time grain for a trend, or a dimension for a breakdown. Defaults to day. A day grain over more than about four months is reported by week.",
          default: "day",
        },
        period: {
          type: "string",
          enum: [...PERIODS],
          description: "The period, in the store timezone. Defaults to 30d.",
          default: "30d",
        },
        comparison: {
          type: "string",
          enum: [...COMPARISONS],
          description:
            "Compare with the preceding equal period, the same period a year earlier, or nothing. Defaults to previous for a trend and none for a breakdown.",
        },
        location_name: {
          type: "string",
          description:
            "Optional accessible dashboard location name, such as Delhi warehouse. Never use or invent a location ID.",
          minLength: 1,
          maxLength: 100,
        },
        limit: {
          type: "integer",
          description:
            "For a breakdown, how many top rows to return (1 to 20).",
          minimum: 1,
          maximum: MAX_BREAKDOWN_ROWS,
          default: 10,
        },
      },
      required: ["metric"],
      additionalProperties: false,
    },
  },
  permission: { section: "analytics", action: "view" },
  timeoutMs: 12_000,
  artifact: chartArtifact,
  async execute(actor, args) {
    const metric = readEnum(args.metric, METRICS, "metric", "total_sales");
    const requestedGrouping = readEnum(
      args.group_by,
      GROUPINGS,
      "group_by",
      "day",
    );
    const period = readEnum(args.period, PERIODS, "period", "30d");
    const timeGrouping = isTimeDimension(requestedGrouping);
    const comparison = readEnum(
      args.comparison,
      COMPARISONS,
      "comparison",
      timeGrouping ? "previous" : "none",
    );
    const limit =
      args.limit === undefined
        ? 10
        : Number.isInteger(args.limit) &&
            Number(args.limit) >= 1 &&
            Number(args.limit) <= MAX_BREAKDOWN_ROWS
          ? Number(args.limit)
          : (() => {
              throw new MinkToolInputError(
                `limit must be an integer from 1 to ${MAX_BREAKDOWN_ROWS}.`,
              );
            })();

    const dataset = (
      [
        "sessions",
        "visitors",
        "page_views",
        "converted_sessions",
        "conversion_rate",
        "traffic_sales",
      ] as string[]
    ).includes(metric)
      ? "traffic"
      : "sales";
    const trafficAllowed =
      dataset === "traffic"
        ? await storeHasAnalyticsFeature(actor.storeId, "storefrontConversion")
        : false;
    if (dataset === "traffic" && !trafficAllowed) {
      return {
        error: {
          code: "traffic_unavailable",
          message:
            "Storefront traffic measures need the Pro plan with storefront analytics switched on. Offer a sales measure instead, or point the merchant to /dashboard/plans.",
        },
      };
    }
    if (!dimensionsFor(dataset).includes(requestedGrouping)) {
      throw new MinkToolInputError(
        `group_by ${requestedGrouping} is not available for ${metric}. Choose one of: ${dimensionsFor(dataset).join(", ")}.`,
      );
    }
    if (!metricsFor(dataset, requestedGrouping).includes(metric)) {
      throw new MinkToolInputError(
        `${metric} cannot be grouped by ${requestedGrouping}. Measures available for that grouping: ${metricsFor(dataset, requestedGrouping).join(", ")}.`,
      );
    }

    const location = await resolveMinkLocation(actor, args.location_name);
    const range = parseAnalyticsRange(
      { range: period, compare: comparison },
      actor.analyticsTimeZone,
    );
    // ★ A day grain across a long period would not fit the chart (and would
    // be unreadable); a week keeps the shape and says so in the result.
    const days =
      (range.current.to.getTime() - range.current.from.getTime()) / 86_400_000;
    const grouping: ExploreDimension =
      requestedGrouping === "day" && days > MAX_CHART_POINTS
        ? "week"
        : requestedGrouping;
    const config = normalizeExploreConfig(
      {
        dataset,
        metrics: [metric],
        dimension: grouping,
        chart: isTimeDimension(grouping) ? "line" : "bar",
      },
      { trafficAllowed },
    );
    const result = await runExploration({
      storeId: actor.storeId,
      location: {
        locationIds: location.locationIds,
        selectedId: location.selectedId,
        includeUnassigned: location.includeUnassigned,
      },
      range,
      config,
    });
    const meta = EXPLORE_METRICS[metric];
    const rows = (
      isTimeDimension(grouping) ? result.rows : result.rows.slice(0, limit)
    ).map((row) => ({
      label: row.label,
      ...(row.title ? { title: row.title } : {}),
      ...(row.partial ? { partial: true } : {}),
      value: round(row.values[0] ?? 0),
      previous: row.previous[0] === null ? null : round(row.previous[0] ?? 0),
    }));
    const total = round(result.totals[0] ?? 0);
    const previousTotal =
      result.previousTotals === null
        ? null
        : round(result.previousTotals[0] ?? 0);
    const search = new URLSearchParams({
      ...exploreSearch(config),
      range: period,
      compare: comparison,
      ...(location.selectedId ? { location: location.selectedId } : {}),
    });
    return {
      metric: { key: metric, label: meta.label, format: meta.format },
      groupBy: {
        key: grouping,
        label: EXPLORE_DIMENSION_LABELS[grouping],
        ...(grouping !== requestedGrouping
          ? { note: `Reported by ${grouping} because the period is long.` }
          : {}),
      },
      range: {
        preset: period,
        label: range.label,
        fromInclusive: range.current.from.toISOString(),
        toExclusive: range.current.to.toISOString(),
        timeZone: range.timeZone,
      },
      comparison: range.comparisonLabel
        ? { type: range.comparison, label: range.comparisonLabel }
        : null,
      locationScope: {
        label:
          location.includeUnassigned && !location.selectedId
            ? `${location.label} plus online or unassigned orders`
            : location.label,
      },
      currency: actor.currency,
      total,
      previousTotal,
      trendPercent:
        previousTotal === null || previousTotal === 0
          ? null
          : round(((total - previousTotal) / Math.abs(previousTotal)) * 100),
      rows,
      truncated:
        result.truncated ||
        (!isTimeDimension(grouping) && result.rows.length > rows.length),
      dashboardPath: `/dashboard/analytics/reports/explore?${search.toString()}`,
      dataAsOf: new Date().toISOString(),
      chart: {
        kind: isTimeDimension(grouping) ? "line" : "bar",
        series: [
          {
            label: meta.label,
            points: rows.map((row) => ({ label: row.label, value: row.value })),
          },
          ...(isTimeDimension(grouping) && range.comparisonLabel
            ? [
                {
                  label: range.comparisonLabel,
                  points: rows.map((row) => ({
                    label: row.label,
                    value: row.previous ?? 0,
                  })),
                },
              ]
            : []),
        ],
      },
    };
  },
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function chartArtifact(
  output: Record<string, unknown>,
): MinkArtifact | undefined {
  const metric = output.metric as
    | { label: string; format: "number" | "currency" | "percent" }
    | undefined;
  const chart = output.chart as
    | {
        kind: "line" | "bar";
        series: Array<{
          label: string;
          points: Array<{ label: string; value: number }>;
        }>;
      }
    | undefined;
  const range = output.range as { label: string } | undefined;
  const groupBy = output.groupBy as { label: string } | undefined;
  const scope = output.locationScope as { label: string } | undefined;
  if (
    !metric ||
    !chart ||
    !range ||
    !groupBy ||
    !chart.series[0]?.points.length
  ) {
    return undefined;
  }
  return {
    type: "chart",
    title: `${metric.label} by ${groupBy.label.toLowerCase()}`,
    kind: chart.kind,
    format: metric.format,
    currency: typeof output.currency === "string" ? output.currency : "INR",
    series: chart.series.slice(0, 3).map((series) => ({
      label: series.label.slice(0, 60),
      points: series.points.slice(0, MAX_CHART_POINTS).map((point) => ({
        label: point.label.slice(0, 60),
        value: Number.isFinite(point.value) ? point.value : 0,
      })),
    })),
    filters: [
      { label: "Period", value: range.label },
      ...(scope ? [{ label: "Location", value: scope.label }] : []),
    ],
    ...(typeof output.dataAsOf === "string"
      ? { dataAsOf: output.dataAsOf }
      : {}),
    ...(typeof output.dashboardPath === "string"
      ? { dashboardPath: output.dashboardPath }
      : {}),
  };
}
