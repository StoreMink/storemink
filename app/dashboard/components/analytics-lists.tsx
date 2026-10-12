import { TrendBadge, trendPct } from "./analytics-trend";
import {
  formatAnalyticsValue,
  type AnalyticsValueFormat,
} from "./analytics-format";

// The two list shapes Shopify's dashboard leans on:
//  - RankedBars: "Total sales by product" — label, value, change, and a bar
//    scaled to the leader with a paler comparison bar under it.
//  - MetricRows: "Total sales breakdown" — one soft row per metric, label on
//    the left, value and change on the right.

export interface RankedRow {
  key: string;
  label: string;
  value: number;
  previous: number | null;
  /** Small secondary text beside the label, e.g. "12 orders". */
  meta?: string;
}

export function RankedBars({
  rows,
  format,
  emptyText,
  goodWhen = "up",
}: {
  rows: RankedRow[];
  format: AnalyticsValueFormat;
  emptyText: string;
  goodWhen?: "up" | "down";
}) {
  if (rows.length === 0 || rows.every((row) => row.value === 0)) {
    return <div className="dash-an-empty">{emptyText}</div>;
  }
  const max = rows.reduce(
    (value, row) => Math.max(value, row.value, row.previous ?? 0),
    0,
  );
  const width = (value: number) =>
    `${max > 0 ? Math.max(0, (value / max) * 100) : 0}%`;
  return (
    <ol className="dash-an-ranked">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="dash-an-ranked-head">
            <span className="dash-an-ranked-label" title={row.label}>
              <span>{row.label}</span>
              {row.meta ? (
                <span className="dash-an-ranked-meta">{row.meta}</span>
              ) : null}
            </span>
            <span className="dash-an-ranked-value">
              {formatAnalyticsValue(row.value, format, true)}
            </span>
            <TrendBadge
              pct={trendPct(row.value, row.previous)}
              goodWhen={goodWhen}
            />
          </div>
          <div className="dash-an-ranked-bars" aria-hidden>
            <span className="is-current" style={{ width: width(row.value) }} />
            {row.previous !== null ? (
              <span
                className="is-previous"
                style={{ width: width(row.previous) }}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface MetricRow {
  label: string;
  value: number;
  previous?: number | null;
  format?: AnalyticsValueFormat;
  goodWhen?: "up" | "down";
  /** Render as a subtotal (bold, rule above), like "Net sales". */
  emphasis?: boolean;
  /** Shown as a negative amount ("-₹1,200") without flipping the trend. */
  negative?: boolean;
}

export function MetricRows({ rows }: { rows: MetricRow[] }) {
  return (
    <ul className="dash-an-rows">
      {rows.map((row) => {
        const format = row.format ?? "number";
        const shown = formatAnalyticsValue(Math.abs(row.value), format);
        return (
          <li
            key={row.label}
            className={row.emphasis ? "is-emphasis" : undefined}
          >
            <span className="dash-an-rows-label">{row.label}</span>
            <span className="dash-an-rows-value">
              {row.negative && row.value !== 0 ? `-${shown}` : shown}
            </span>
            <TrendBadge
              pct={trendPct(row.value, row.previous)}
              goodWhen={row.goodWhen}
            />
          </li>
        );
      })}
    </ul>
  );
}

export interface FunnelStep {
  label: string;
  value: number;
}

/** Ordered conversion steps with each step's share of the first. */
export function FunnelBars({
  steps,
  emptyText,
}: {
  steps: FunnelStep[];
  emptyText: string;
}) {
  const first = steps[0]?.value ?? 0;
  if (first <= 0) return <div className="dash-an-empty">{emptyText}</div>;
  return (
    <ol className="dash-an-funnel">
      {steps.map((step, index) => {
        const share = (step.value / first) * 100;
        const fromPrevious =
          index > 0 && steps[index - 1].value > 0
            ? (step.value / steps[index - 1].value) * 100
            : null;
        return (
          <li key={step.label}>
            <div className="dash-an-funnel-head">
              <span>{step.label}</span>
              <strong>{step.value.toLocaleString("en-IN")}</strong>
              <span className="dash-an-funnel-share">
                {share.toFixed(share < 10 ? 1 : 0)}%
              </span>
            </div>
            <div className="dash-an-funnel-track" aria-hidden>
              <span style={{ width: `${Math.max(share, 0.5)}%` }} />
            </div>
            {fromPrevious !== null ? (
              <div className="dash-an-funnel-step">
                {fromPrevious.toFixed(fromPrevious < 10 ? 1 : 0)}% from the step
                before
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
