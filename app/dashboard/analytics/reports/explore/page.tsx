import Link from "next/link";
import { ArrowLeft, Lock } from "lucide-react";
import { and, eq } from "drizzle-orm";
import { AnalyticsCard } from "../../../components/analytics-card";
import { AnalyticsTrendChart } from "../../../components/analytics-charts-lazy";
import { formatAnalyticsValue } from "../../../components/analytics-format";
import { RankedBars } from "../../../components/analytics-lists";
import { TrendBadge, trendPct } from "../../../components/analytics-trend";
import { getActingStoreId, requireSectionAccess } from "../../../lib/access";
import { AnalyticsFilters } from "../../analytics-filters";
import { AnalyticsTabs } from "../../analytics-tabs";
import { getAnalyticsLocationOptions } from "../../data";
import { runExploration } from "../explore-data";
import { ExploreBuilder } from "../explore-builder";
import { analyticsSavedReports } from "@/drizzle/schema";
import {
  DEFAULT_EXPLORE_CONFIG,
  EXPLORE_DIMENSION_LABELS,
  REPORT_LIBRARY,
  exploreConfigFromSearch,
  isTimeDimension,
  normalizeExploreConfig,
} from "@/lib/analytics/explore";
import { analyticsFeatureAllowed } from "@/lib/analytics/features";
import { resolveAnalyticsLocation } from "@/lib/analytics/location";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import {
  parseAnalyticsRange,
  type AnalyticsSearchParams,
} from "@/lib/analytics/range";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { withService } from "@/lib/db/client";
import { getViewerLocations } from "@/lib/locations/scope";
import { getStorePlanContext } from "@/lib/plans/entitlements";

export const metadata = { title: "Report · Analytics" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANGE_KEYS = [
  "range",
  "compare",
  "from",
  "to",
  "compareFrom",
  "compareTo",
  "location",
] as const;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<AnalyticsSearchParams>;
}) {
  const access = await requireSectionAccess("analytics", "view");
  const canUpgrade = access.can("ai", "view");
  const [storeId, locationScope, params, features] = await Promise.all([
    getActingStoreId(),
    getViewerLocations(),
    searchParams,
    getPlatformAnalyticsFeatures(),
  ]);
  const [{ plan }, timeZone, locationOptions] = await Promise.all([
    getStorePlanContext(storeId),
    getStoreAnalyticsTimeZone(storeId),
    getAnalyticsLocationOptions(storeId, locationScope),
  ]);
  const canReports =
    features.coreDashboard &&
    analyticsFeatureAllowed(features, "drilldownReports", plan);
  const trafficAllowed = analyticsFeatureAllowed(
    features,
    "storefrontConversion",
    plan,
  );

  if (!canReports) {
    return (
      <div className="dash-analytics">
        <header className="dash-an-head">
          <h1>Analytics</h1>
        </header>
        <AnalyticsTabs active="reports" />
        <div className="dash-live-locked dash-explore-locked">
          <span className="dash-an-plan-badge is-basic">
            <Lock aria-hidden /> Basic
          </span>
          <h2>Build your own reports</h2>
          <p>
            Pick what to measure and how to group it: sales by channel, by
            discount code, by customer region, orders by month, and more. Save
            the reports you use and export any of them to CSV.
          </p>
          {canUpgrade ? (
            <Link href="/dashboard/plans" className="dash-an-upsell-cta">
              See Basic
            </Link>
          ) : (
            <span className="dash-an-upsell-note">
              Ask your store owner to upgrade to Basic.
            </span>
          )}
        </div>
      </div>
    );
  }

  // Which config: explicit URL params win, then a saved report, then a
  // library preset, then the default. Everything is normalized server-side.
  const reportId = one(params.report);
  const saved =
    reportId && UUID.test(reportId)
      ? await withService((db) =>
          db
            .select({
              id: analyticsSavedReports.id,
              name: analyticsSavedReports.name,
              config: analyticsSavedReports.config,
            })
            .from(analyticsSavedReports)
            .where(
              and(
                eq(analyticsSavedReports.id, reportId),
                eq(analyticsSavedReports.storeId, storeId),
              ),
            )
            .limit(1),
        ).then((rows) => rows[0] ?? null)
      : null;
  const presetId = one(params.preset);
  const preset = REPORT_LIBRARY.find(
    (entry) => entry.id === presetId && entry.config,
  );
  const hasExplicit = Boolean(
    one(params.ds) || one(params.m) || one(params.by),
  );
  const config = hasExplicit
    ? exploreConfigFromSearch(params, { trafficAllowed })
    : saved
      ? normalizeExploreConfig(saved.config as Record<string, unknown>, {
          trafficAllowed,
        })
      : normalizeExploreConfig(
          (preset?.config ?? DEFAULT_EXPLORE_CONFIG) as unknown as Record<
            string,
            unknown
          >,
          { trafficAllowed },
        );

  const range = parseAnalyticsRange(params, timeZone);
  const location = resolveAnalyticsLocation(
    params.location,
    locationScope,
    locationOptions,
  );
  const result = await runExploration({ storeId, location, range, config });

  const baseParams: Record<string, string> = {};
  for (const key of RANGE_KEYS) {
    const value = one(params[key]);
    if (value) baseParams[key] = value;
  }
  const preserve: Record<string, string> = {
    ds: config.dataset,
    m: config.metrics.join(","),
    by: config.dimension,
    chart: config.chart,
    ...(saved ? { report: saved.id } : {}),
  };
  const title = saved?.name ?? preset?.title ?? "New report";
  const dimensionLabel = EXPLORE_DIMENSION_LABELS[config.dimension];
  const first = result.columns[0];
  const time = isTimeDimension(config.dimension);

  const csvHeader = [
    dimensionLabel,
    ...result.columns.map((column) => column.label),
    ...(result.previousTotals
      ? result.columns.map((column) => `${column.label} (previous period)`)
      : []),
  ];
  const round = (value: number) => Math.round(value * 100) / 100;
  const csvRows = [
    [
      "Summary",
      ...result.totals.map(round),
      ...(result.previousTotals ? result.previousTotals.map(round) : []),
    ],
    ...result.exportRows.map((row) => [
      row.title ?? row.label,
      ...row.values.map(round),
      ...(result.previousTotals
        ? row.previous.map((value) => (value === null ? "" : round(value)))
        : []),
    ]),
  ];

  return (
    <div className="dash-analytics dash-explore">
      <header className="dash-an-head">
        <div className="dash-live-heading">
          <Link
            href="/dashboard/analytics/reports"
            className="dash-an-icon-btn"
            aria-label="Back to reports"
          >
            <ArrowLeft aria-hidden />
          </Link>
          <h1>{title}</h1>
        </div>
      </header>
      <AnalyticsTabs active="reports" />
      <div className="dash-an-toolbar">
        <AnalyticsFilters
          range={range}
          locations={config.dataset === "traffic" ? [] : locationOptions}
          selectedLocationId={location.selectedId}
          preserve={preserve}
        />
      </div>
      <ExploreBuilder
        config={config}
        trafficAllowed={trafficAllowed}
        baseParams={baseParams}
        report={saved ? { id: saved.id, name: saved.name } : null}
        canSave={access.can("analytics", "manage")}
        csv={{
          filename: `${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "report"}.csv`,
          header: csvHeader,
          rows: csvRows,
        }}
      />

      {config.chart !== "table" && first ? (
        <AnalyticsCard
          title={first.label}
          subtitle={`By ${dimensionLabel.toLowerCase()}`}
        >
          <div className="dash-an-headline">
            <strong>
              {formatAnalyticsValue(result.totals[0] ?? 0, first.format)}
            </strong>
            <TrendBadge
              pct={trendPct(result.totals[0] ?? 0, result.previousTotals?.[0])}
              goodWhen={first.lowerIsBetter ? "down" : "up"}
            />
          </div>
          {time && config.chart === "line" ? (
            <AnalyticsTrendChart
              data={result.rows.map((row) => ({
                key: row.key,
                label: row.label,
                title: row.title ?? row.label,
                value: row.values[0] ?? 0,
                previous: row.previous[0] ?? null,
                previousTitle: null,
                partial: row.partial ?? false,
              }))}
              format={first.format}
              currentLabel={range.label}
              previousLabel={range.comparisonLabel}
              emptyText="Nothing in this date range"
              goodWhen={first.lowerIsBetter ? "down" : "up"}
            />
          ) : (
            <RankedBars
              format={first.format}
              emptyText="Nothing in this date range"
              goodWhen={first.lowerIsBetter ? "down" : "up"}
              rows={result.rows.slice(0, 12).map((row) => ({
                key: row.key,
                label: row.label,
                value: row.values[0] ?? 0,
                previous: row.previous[0] ?? null,
              }))}
            />
          )}
        </AnalyticsCard>
      ) : null}

      <div className="dash-an-card dash-explore-table-card">
        <div className="dash-explore-table-wrap">
          <table className="dash-explore-table">
            <thead>
              <tr>
                <th scope="col">{dimensionLabel}</th>
                {result.columns.map((column) => (
                  <th key={column.metric} scope="col">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="is-summary">
                <th scope="row">Summary</th>
                {result.totals.map((value, index) => (
                  <td key={result.columns[index].metric}>
                    <span>
                      {formatAnalyticsValue(
                        value,
                        result.columns[index].format,
                      )}
                    </span>
                    <TrendBadge
                      pct={trendPct(value, result.previousTotals?.[index])}
                      goodWhen={
                        result.columns[index].lowerIsBetter ? "down" : "up"
                      }
                    />
                  </td>
                ))}
              </tr>
              {result.rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={result.columns.length + 1}
                    className="dash-explore-empty"
                  >
                    Nothing in this date range
                  </td>
                </tr>
              ) : (
                result.rows.map((row) => (
                  <tr
                    key={row.key}
                    className={row.partial ? "is-partial" : undefined}
                  >
                    <th scope="row" title={row.title ?? row.label}>
                      {time ? (row.title ?? row.label) : row.label}
                      {row.partial ? <em> (so far)</em> : null}
                    </th>
                    {row.values.map((value, index) => (
                      <td key={result.columns[index].metric}>
                        <span>
                          {formatAnalyticsValue(
                            value,
                            result.columns[index].format,
                          )}
                        </span>
                        <TrendBadge
                          pct={trendPct(value, row.previous[index])}
                          goodWhen={
                            result.columns[index].lowerIsBetter ? "down" : "up"
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {result.truncated ? (
          <p className="dash-explore-note">
            Showing the top 250 rows. The summary includes every row, and the
            CSV export includes up to 5,000.
          </p>
        ) : null}
      </div>
    </div>
  );
}
