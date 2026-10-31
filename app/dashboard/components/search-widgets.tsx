import { ResponsiveTable } from "@/app/dashboard/components/responsive-table";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type {
  SearchAnalytics,
  SearchAnalyticsState,
  SearchRankingRow,
} from "../analytics/search-data";
import { SearchTrendChart } from "./search-trend-chart-lazy";
import { MetricTitle } from "./analytics-card";
import { Sparkline, TrendBadge } from "./analytics-trend";
import { WIDGETS } from "../analytics/widgets";

type SearchMetric = "clicks" | "impressions" | "ctr" | "position";

const METRIC_META: Record<
  SearchMetric,
  { title: string; format: "count" | "percent" | "position" }
> = {
  clicks: { title: "Google Search clicks", format: "count" },
  impressions: { title: "Google Search impressions", format: "count" },
  ctr: { title: "Search click-through rate", format: "percent" },
  position: { title: "Average search position", format: "position" },
};

function formatLastUpdated(value: string | null): string {
  if (!value) return "Waiting for first update";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Waiting for first update";
  return `Updated ${new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)} UTC`;
}

function SearchSourceMeta({ data }: { data: SearchAnalytics }) {
  return (
    <>
      {data.warning ? (
        <div className="dash-search-warning" role="status">
          {data.warning}
        </div>
      ) : null}
      <div className="dash-search-meta">
        <span className="dash-search-source">Google Search</span>
        <span>{formatLastUpdated(data.lastUpdated)}</span>
        <span>Usually ~2 days behind · Pacific Time</span>
      </div>
    </>
  );
}

function SearchState({ state }: { state: SearchAnalyticsState }) {
  if (state === "ready") return null;
  const content = {
    not_launched: {
      title: "Search data starts after launch",
      text: "Publish your store to start collecting Google Search data.",
    },
    collecting: {
      title: "Collecting Search data",
      text: "The first complete Google Search day usually appears in about 2 days.",
    },
    no_visibility: {
      title: "No search visibility yet",
      text: "Google hasn’t shown your store in search yet. We’ll keep checking.",
    },
    error: {
      title: "Google Search needs attention",
      text: "Check your domain verification and Search Console access, then try again.",
    },
  }[state];
  return (
    <div className="dash-search-state">
      <strong>{content.title}</strong>
      <span>{content.text}</span>
      {state === "error" ? (
        <Link href="/dashboard/settings/domain">Open Domain settings</Link>
      ) : null}
    </div>
  );
}

function formatMetric(
  value: number,
  format: "count" | "percent" | "position",
): string {
  if (format === "count") return Math.round(value).toLocaleString("en-IN");
  if (format === "percent") return `${value.toFixed(1)}%`;
  return value.toFixed(1);
}

const SHORT_STATE: Record<Exclude<SearchAnalyticsState, "ready">, string> = {
  not_launched: "Starts after your store launches",
  collecting: "Collecting the first days of data",
  no_visibility: "No Google visibility yet",
  error: "Needs attention, see the chart below",
};

const DEFINITION: Record<SearchMetric, string> = {
  clicks: WIDGETS.search_clicks.description,
  impressions: WIDGETS.search_impressions.description,
  ctr: WIDGETS.search_ctr.description,
  position: WIDGETS.search_position.description,
};

/**
 * A compact Search tile, built like every other Analytics metric. The source
 * line and the full not-ready explanation live once on the performance chart
 * instead of being repeated on four tiles.
 */
export function SearchMetricCard({
  data,
  metric,
}: {
  data: SearchAnalytics;
  metric: SearchMetric;
}) {
  const meta = METRIC_META[metric];
  const stat = data[metric];
  const ready = data.state === "ready";
  // SearchMetricStat keeps magnitude and direction apart; the badge wants a
  // signed change, and a LOWER average position is the improvement.
  const signed =
    stat.trendPct === null
      ? null
      : stat.direction === "down"
        ? -Math.abs(stat.trendPct)
        : Math.abs(stat.trendPct);
  return (
    <div className="dash-metric">
      <div className="dash-metric-top">
        <MetricTitle title={meta.title} definition={DEFINITION[metric]} />
      </div>
      {ready ? (
        <>
          <div className="dash-metric-row">
            <span className="dash-metric-val">
              {formatMetric(stat.value, meta.format)}
            </span>
            <TrendBadge
              pct={signed}
              goodWhen={metric === "position" ? "down" : "up"}
            />
          </div>
          <Sparkline data={stat.spark} />
        </>
      ) : (
        <>
          <div className="dash-metric-row">
            <span className="dash-metric-val is-muted">-</span>
          </div>
          <p className="dash-metric-note">
            {SHORT_STATE[data.state as Exclude<SearchAnalyticsState, "ready">]}
          </p>
        </>
      )}
    </div>
  );
}

export function SearchTrendWidget({ data }: { data: SearchAnalytics }) {
  return (
    <div className="dash-card h-full">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">Google Search performance</div>
          <div className="dash-card-sub">{data.rangeLabel}</div>
        </div>
        <div className="dash-search-legend" aria-label="Chart legend">
          <span className="is-clicks">Clicks</span>
          <span className="is-impressions">Impressions</span>
        </div>
      </div>
      <div className="dash-card-body">
        {data.state === "ready" ? (
          <SearchTrendChart data={data.series} />
        ) : (
          <SearchState state={data.state} />
        )}
        <SearchSourceMeta data={data} />
      </div>
    </div>
  );
}

function readablePage(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function RankingTable({
  rows,
  kind,
}: {
  rows: SearchRankingRow[];
  kind: "query" | "page";
}) {
  if (rows.length === 0) {
    return (
      <div className="dash-search-ranking-empty">No data for this range.</div>
    );
  }
  return (
    <div className="dash-search-table-wrap">
      <ResponsiveTable className="dash-search-table">
        <thead>
          <tr>
            <th>{kind === "query" ? "Search term" : "Landing page"}</th>
            <th>Clicks</th>
            <th>Impr.</th>
            <th>CTR</th>
            <th>Position</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td title={row.key}>
                {kind === "page" ? readablePage(row.key) : row.key}
              </td>
              <td>{row.clicks.toLocaleString("en-IN")}</td>
              <td>{row.impressions.toLocaleString("en-IN")}</td>
              <td>{row.ctr.toFixed(1)}%</td>
              <td>{row.position.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </ResponsiveTable>
    </div>
  );
}

export function SearchRankingWidget({
  data,
  kind,
  reportHref,
}: {
  data: SearchAnalytics;
  kind: "query" | "page";
  reportHref?: string;
}) {
  const title =
    kind === "query" ? "Top Google searches" : "Top search landing pages";
  return (
    <div className="dash-card h-full">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">
            {reportHref ? (
              <Link
                href={reportHref}
                className="inline-flex items-center gap-1 hover:text-[var(--dash-accent)]"
              >
                {title}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            ) : (
              title
            )}
          </div>
          <div className="dash-card-sub">
            {data.rangeLabel} · ranked by clicks
          </div>
        </div>
      </div>
      <div className="dash-card-body">
        {data.state === "ready" ? (
          <RankingTable
            rows={kind === "query" ? data.queries : data.pages}
            kind={kind}
          />
        ) : (
          <SearchState state={data.state} />
        )}
        {data.state === "ready" ? (
          <p className="dash-search-note">
            Rows may not add up, as rare searches are omitted.
          </p>
        ) : null}
        {/* Source, freshness and any warning are shown once, on the
            performance chart, rather than on every Search card. */}
      </div>
    </div>
  );
}
