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
  type ExploreDataset,
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
 * `query_analytics`: one measure (or two), grouped one way, over one bounded
 * period.
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
 * as bars. The card leads with the period's total and its trend against the
 * comparison period, and links to the same configuration in Reports.
 *
 * ★ A SECOND MEASURE RIDES THE SAME QUERY. `second_metric` adds one more
 * measure to the one `runExploration` call (the builder already takes up to
 * four), and the card draws it as a small multiple beside the first. It
 * travels INSIDE the one chart artifact as `panels`: a tool output yields one
 * artifact, and widening that contract would touch the registry, the
 * orchestrator's collection cap, the SSE route and the history parser for
 * what is one card on screen.
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
const TRAFFIC_METRICS = new Set<string>([
  "sessions",
  "visitors",
  "page_views",
  "converted_sessions",
  "conversion_rate",
  "traffic_sales",
]);
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

function datasetOf(metric: ExploreMetric): ExploreDataset {
  return TRAFFIC_METRICS.has(metric) ? "traffic" : "sales";
}

export const queryAnalytics: MinkTool = {
  declaration: {
    name: "query_analytics",
    description:
      "Run one bounded analytics query the way the merchant's Reports builder does: one measure (sales, orders, average order value, units, discounts, returns, shipping, taxes, or on Pro the storefront sessions, visitors, page views, converted sessions and conversion rate), grouped by a time grain (day, week, month) or a breakdown (product, category, channel, location, discount code, region, new versus returning customers; for traffic also device, source, referrer, landing page, campaign, country, city), over one period in the store timezone, with an optional comparison period and an optional second measure drawn beside the first. Returns the rows, totals, the trend against the comparison period and a chart card, and a link to the same report. Use get_sales_summary for a single headline figure; use this for a trend, a ranking or a breakdown. Never invent a figure the result does not contain.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: METRICS,
          description: "The one measure to report.",
        },
        second_metric: {
          type: "string",
          enum: METRICS,
          description:
            "An optional second measure drawn beside the first over the same grouping and period, such as orders next to total sales. It must differ from metric and be available for the same dataset and grouping.",
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
    const secondMetric =
      args.second_metric === undefined || args.second_metric === null
        ? undefined
        : readEnum(args.second_metric, METRICS, "second_metric", metric);
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

    const dataset = datasetOf(metric);
    if (secondMetric !== undefined) {
      if (secondMetric === metric) {
        throw new MinkToolInputError("second_metric must differ from metric.");
      }
      if (datasetOf(secondMetric) !== dataset) {
        throw new MinkToolInputError(
          `second_metric ${secondMetric} is a ${datasetOf(secondMetric)} measure and cannot be drawn beside ${metric}, a ${dataset} measure. Choose two measures of the same kind.`,
        );
      }
    }
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
    const allowedMetrics = metricsFor(dataset, requestedGrouping);
    if (!allowedMetrics.includes(metric)) {
      throw new MinkToolInputError(
        `${metric} cannot be grouped by ${requestedGrouping}. Measures available for that grouping: ${allowedMetrics.join(", ")}.`,
      );
    }
    if (secondMetric !== undefined && !allowedMetrics.includes(secondMetric)) {
      throw new MinkToolInputError(
        `second_metric ${secondMetric} cannot be grouped by ${requestedGrouping}. Measures available for that grouping: ${allowedMetrics.join(", ")}.`,
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
        metrics: [metric, ...(secondMetric ? [secondMetric] : [])],
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
    const secondMeta = secondMetric ? EXPLORE_METRICS[secondMetric] : null;
    const firstIndex = Math.max(0, config.metrics.indexOf(metric));
    const secondIndex = secondMetric
      ? config.metrics.indexOf(secondMetric)
      : -1;
    const baseRows = isTimeDimension(grouping)
      ? result.rows
      : result.rows.slice(0, limit);
    const measure = (index: number) => ({
      rows: baseRows.map((row) => ({
        value: round(row.values[index] ?? 0),
        previous:
          row.previous[index] === null || row.previous[index] === undefined
            ? null
            : round(row.previous[index] ?? 0),
      })),
      total: round(result.totals[index] ?? 0),
      previousTotal:
        result.previousTotals === null
          ? null
          : round(result.previousTotals[index] ?? 0),
    });
    const first = measure(firstIndex);
    const second = secondIndex >= 0 ? measure(secondIndex) : null;
    const rows = baseRows.map((row, index) => ({
      label: row.label,
      ...(row.title ? { title: row.title } : {}),
      ...(row.partial ? { partial: true } : {}),
      value: first.rows[index].value,
      previous: first.rows[index].previous,
      ...(second
        ? {
            secondValue: second.rows[index].value,
            secondPrevious: second.rows[index].previous,
          }
        : {}),
    }));
    // ★ THE COMPARISON IS NAMED FOR WHAT IT IS, in two registers: the badge
    // reads "+12% vs previous 30 days", the legend "Previous period" against
    // "This period". A year comparison says so in both.
    const comparisonPhrase = range.compare
      ? range.comparison === "year"
        ? "same period last year"
        : `previous ${days <= 1 ? "day" : `${Math.round(days)} days`}`
      : null;
    const comparisonSeriesLabel =
      range.comparison === "year" ? "Same period last year" : "Previous period";
    const groupLabel = EXPLORE_DIMENSION_LABELS[grouping].toLowerCase();
    const chartKind = isTimeDimension(grouping) ? "line" : "bar";
    const chartFor = (
      label: string,
      format: (typeof meta)["format"],
      lowerIsBetter: boolean,
      figures: ReturnType<typeof measure>,
    ) => ({
      title: `${label} by ${groupLabel}`,
      kind: chartKind,
      format,
      series: [
        {
          label:
            isTimeDimension(grouping) && range.compare ? "This period" : label,
          points: figures.rows.map((row, index) => ({
            label: rows[index].label,
            value: row.value,
          })),
        },
        ...(isTimeDimension(grouping) && range.compare
          ? [
              {
                label: comparisonSeriesLabel,
                points: figures.rows.map((row, index) => ({
                  label: rows[index].label,
                  value: row.previous ?? 0,
                })),
              },
            ]
          : []),
      ],
      summary: {
        total: figures.total,
        ...(figures.previousTotal === null
          ? {}
          : { previousTotal: figures.previousTotal }),
        trendPercent: trend(figures.total, figures.previousTotal),
        ...(comparisonPhrase ? { comparisonLabel: comparisonPhrase } : {}),
        goodWhen: lowerIsBetter ? "down" : "up",
      },
    });
    const search = new URLSearchParams({
      ...exploreSearch(config),
      range: period,
      compare: comparison,
      ...(location.selectedId ? { location: location.selectedId } : {}),
    });
    const primary = chartFor(
      meta.label,
      meta.format,
      meta.lowerIsBetter === true,
      first,
    );
    return {
      metric: { key: metric, label: meta.label, format: meta.format },
      ...(secondMeta && second && secondMetric
        ? {
            secondMetric: {
              key: secondMetric,
              label: secondMeta.label,
              format: secondMeta.format,
              total: second.total,
              previousTotal: second.previousTotal,
              trendPercent: trend(second.total, second.previousTotal),
            },
          }
        : {}),
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
        ? {
            type: range.comparison,
            label: range.comparisonLabel,
            ...(comparisonPhrase ? { shortLabel: comparisonPhrase } : {}),
          }
        : null,
      locationScope: {
        label:
          location.includeUnassigned && !location.selectedId
            ? `${location.label} plus online or unassigned orders`
            : location.label,
      },
      currency: actor.currency,
      total: first.total,
      previousTotal: first.previousTotal,
      trendPercent: trend(first.total, first.previousTotal),
      rows,
      truncated:
        result.truncated ||
        (!isTimeDimension(grouping) && result.rows.length > rows.length),
      dashboardPath: `/dashboard/analytics/reports/explore?${search.toString()}`,
      dataAsOf: new Date().toISOString(),
      chart: {
        ...primary,
        ...(secondMeta && second
          ? {
              panels: [
                chartFor(
                  secondMeta.label,
                  secondMeta.format,
                  secondMeta.lowerIsBetter === true,
                  second,
                ),
              ],
            }
          : {}),
      },
    };
  },
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Percent change, two decimals; null without a baseline (the dashboard's rule). */
function trend(total: number, previousTotal: number | null): number | null {
  return previousTotal === null || previousTotal === 0
    ? null
    : round(((total - previousTotal) / Math.abs(previousTotal)) * 100);
}

type ChartFormat = "number" | "currency" | "percent";
type ChartSeries = Array<{
  label: string;
  points: Array<{ label: string; value: number }>;
}>;
type ChartSummary = {
  total: number;
  previousTotal?: number;
  trendPercent?: number | null;
  comparisonLabel?: string;
  goodWhen?: "up" | "down";
};
type ChartPanelOutput = {
  title: string;
  kind: "line" | "bar";
  format: ChartFormat;
  series: ChartSeries;
  summary?: ChartSummary;
};

function boundedSeries(series: ChartSeries): ChartSeries {
  return series.slice(0, 3).map((entry) => ({
    label: entry.label.slice(0, 60),
    points: entry.points.slice(0, MAX_CHART_POINTS).map((point) => ({
      label: point.label.slice(0, 60),
      value: Number.isFinite(point.value) ? point.value : 0,
    })),
  }));
}

function boundedSummary(summary: ChartSummary | undefined) {
  if (!summary || !Number.isFinite(summary.total)) return {};
  return {
    summary: {
      total: summary.total,
      ...(summary.previousTotal !== undefined &&
      Number.isFinite(summary.previousTotal)
        ? { previousTotal: summary.previousTotal }
        : {}),
      ...(summary.trendPercent === null ||
      (summary.trendPercent !== undefined &&
        Number.isFinite(summary.trendPercent))
        ? { trendPercent: summary.trendPercent }
        : {}),
      ...(summary.comparisonLabel
        ? { comparisonLabel: summary.comparisonLabel.slice(0, 80) }
        : {}),
      ...(summary.goodWhen === "up" || summary.goodWhen === "down"
        ? { goodWhen: summary.goodWhen }
        : {}),
    },
  };
}

function chartArtifact(
  output: Record<string, unknown>,
): MinkArtifact | undefined {
  const chart = output.chart as
    | (ChartPanelOutput & { panels?: ChartPanelOutput[] })
    | undefined;
  const range = output.range as { label: string } | undefined;
  const scope = output.locationScope as { label: string } | undefined;
  if (!chart || !range || !chart.series?.[0]?.points.length) {
    return undefined;
  }
  const currency =
    typeof output.currency === "string" ? output.currency : "INR";
  const panels = (chart.panels ?? [])
    .filter((panel) => panel.series?.[0]?.points.length)
    .slice(0, 3)
    .map((panel) => ({
      title: panel.title.slice(0, 120),
      kind: panel.kind,
      format: panel.format,
      currency,
      series: boundedSeries(panel.series),
      ...boundedSummary(panel.summary),
    }));
  return {
    type: "chart",
    title: chart.title.slice(0, 120),
    kind: chart.kind,
    format: chart.format,
    currency,
    series: boundedSeries(chart.series),
    ...boundedSummary(chart.summary),
    ...(panels.length ? { panels } : {}),
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
