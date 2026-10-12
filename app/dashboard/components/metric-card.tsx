import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { Stat } from "../analytics/data";
import { MetricTitle } from "./analytics-card";
import { Sparkline, TrendBadge } from "./analytics-trend";
import {
  formatAnalyticsValue,
  type AnalyticsValueFormat,
} from "./analytics-format";

// A compact analytics metric (Shopify's KPI card): the title explains itself
// on hover, the value carries its change beside it, and a sparkline shows this
// period against the comparison (dotted). Colour is reserved for the trend.

export interface MetricCardProps {
  label: string;
  stat: Stat;
  /** Rupee-format the value (revenue) vs plain count. */
  currency?: boolean;
  format?: AnalyticsValueFormat;
  definition?: string;
  /** Optional detailed report while preserving the dashboard's active filters. */
  reportHref?: string;
  goodWhen?: "up" | "down";
}

export function MetricCard({
  label,
  stat,
  currency = false,
  format,
  definition,
  reportHref,
  goodWhen = "up",
}: MetricCardProps) {
  const shownFormat: AnalyticsValueFormat =
    format ?? (currency ? "currency" : "number");
  return (
    <div className="dash-metric">
      <div className="dash-metric-top">
        <MetricTitle title={label} definition={definition} href={reportHref} />
        {reportHref ? (
          <Link
            href={reportHref}
            className="dash-an-icon-btn is-quiet"
            aria-label={`View ${label} report`}
            title="View report"
          >
            <ArrowUpRight aria-hidden />
          </Link>
        ) : null}
      </div>
      <div className="dash-metric-row">
        <span className="dash-metric-val">
          {formatAnalyticsValue(stat.value, shownFormat)}
        </span>
        <TrendBadge pct={stat.trendPct} goodWhen={goodWhen} />
      </div>
      <Sparkline
        data={stat.spark}
        previous={stat.previousSpark}
        partial={stat.sparkPartial}
      />
    </div>
  );
}
