import { ArrowDownRight, ArrowUpRight } from "lucide-react";

// The "↗ 12.4%" beside every analytics number. Shopify's convention: no pill,
// colour only when the change means something, and a dash rather than "+0%"
// so an empty store isn't a wall of meaningless green.

export interface TrendBadgeProps {
  /** Percentage change; null hides the badge (no comparison or zero baseline). */
  pct: number | null | undefined;
  /**
   * Which direction is good news. Sales going up is good; refunds or discounts
   * going up is not, so those cards pass "down" and a rise reads as a warning.
   */
  goodWhen?: "up" | "down";
  className?: string;
}

export function trendPct(
  current: number,
  previous: number | null | undefined,
): number | null {
  if (previous === null || previous === undefined || previous === 0) {
    return null;
  }
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

export function TrendBadge({
  pct,
  goodWhen = "up",
  className = "",
}: TrendBadgeProps) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  if (pct === 0) {
    return (
      <span className={`dash-an-trend is-flat ${className}`} title="No change">
        -
      </span>
    );
  }
  const up = pct > 0;
  const good = goodWhen === "up" ? up : !up;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  const value = Math.abs(pct);
  return (
    <span
      className={`dash-an-trend ${good ? "is-good" : "is-bad"} ${className}`}
      aria-label={`${up ? "Up" : "Down"} ${value}% from the comparison period`}
    >
      <Arrow aria-hidden />
      {value >= 1000 ? Math.round(value).toLocaleString("en-IN") : value}%
    </span>
  );
}

/** A hairline sparkline: this period solid, the comparison dotted beneath. */
export function Sparkline({
  data,
  previous,
  partial,
  className = "",
}: {
  data: number[];
  previous?: number[];
  /** First/last bucket only partly in range: drawn dashed, not as a drop. */
  partial?: { start: boolean; end: boolean };
  className?: string;
}) {
  const w = 96;
  const h = 28;
  const series = [data, ...(previous && previous.length > 1 ? [previous] : [])];
  if (data.length < 2) return null;
  const all = series.flat();
  const max = Math.max(...all);
  const min = Math.min(...all, 0);
  const range = max - min || 1;
  const stepX = w / Math.max(1, data.length - 1);
  const xy = (value: number, index: number) =>
    `${(index * stepX).toFixed(1)},${(h - ((value - min) / range) * (h - 4) - 2).toFixed(1)}`;
  const points = (values: number[], from = 0, to = data.length - 1) =>
    values
      .slice(0, data.length)
      .map((value, index) => ({ value, index }))
      .filter(({ index }) => index >= from && index <= to)
      .map(({ value, index }) => xy(value, index))
      .join(" ");
  const first = partial?.start && data.length > 2 ? 1 : 0;
  const last =
    partial?.end && data.length > 2 ? data.length - 2 : data.length - 1;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={`dash-an-spark ${className}`}
      aria-hidden
    >
      {previous && previous.length > 1 ? (
        <polyline
          points={points(previous)}
          className="is-previous"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <polyline
        points={points(data, first, last)}
        className="is-current"
        vectorEffect="non-scaling-stroke"
      />
      {first > 0 ? (
        <polyline
          points={points(data, 0, first)}
          className="is-current is-partial"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {last < data.length - 1 ? (
        <polyline
          points={points(data, last, data.length - 1)}
          className="is-current is-partial"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
