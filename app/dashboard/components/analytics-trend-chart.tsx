"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useId } from "react";
import { TrendBadge, trendPct } from "./analytics-trend";
import {
  formatAnalyticsValue,
  type AnalyticsValueFormat,
  type TrendPoint,
} from "./analytics-format";

export type { TrendPoint };

// Shopify-style over-time chart: this period as a solid line with a faint
// fill, the comparison period dotted in a lighter tint of the same hue, a
// crosshair tooltip that shows BOTH values with their own dates, and a legend
// naming the two ranges underneath.

function ChartTooltip({
  active,
  payload,
  format,
  goodWhen,
}: {
  active?: boolean;
  payload?: Array<{ payload?: PlotPoint }>;
  format: AnalyticsValueFormat;
  goodWhen: "up" | "down";
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="dash-an-chart-tip">
      <div className="dash-an-chart-tip-row">
        <span className="dash-an-swatch is-current" aria-hidden />
        <span className="dash-an-chart-tip-date">
          {point.title}
          {point.partial ? " (so far)" : ""}
        </span>
        <strong>{formatAnalyticsValue(point.value, format)}</strong>
        <TrendBadge
          pct={trendPct(point.value, point.previous)}
          goodWhen={goodWhen}
        />
      </div>
      {point.previous !== null && point.previousTitle ? (
        <div className="dash-an-chart-tip-row is-previous">
          <span className="dash-an-swatch is-previous" aria-hidden />
          <span className="dash-an-chart-tip-date">{point.previousTitle}</span>
          <strong>{formatAnalyticsValue(point.previous, format)}</strong>
        </div>
      ) : null}
    </div>
  );
}

interface PlotPoint extends TrendPoint {
  /** The value where the line is drawn solid (complete buckets). */
  solid: number | null;
  /** The value where the line is drawn dashed (partial edges + their joins). */
  dashed: number | null;
}

/**
 * Split the series into a solid run and dashed partial edges. Each dashed
 * stretch includes its neighbouring complete point so the two lines join.
 */
function plotPoints(data: TrendPoint[]): PlotPoint[] {
  return data.map((point, index) => {
    const touchesPartial =
      point.partial ||
      data[index - 1]?.partial === true ||
      data[index + 1]?.partial === true;
    return {
      ...point,
      solid: point.partial ? null : point.value,
      dashed: touchesPartial ? point.value : null,
    };
  });
}

export function AnalyticsTrendChart({
  data,
  format,
  currentLabel,
  previousLabel,
  emptyText = "No data in this date range",
  goodWhen = "up",
  height = 240,
}: {
  data: TrendPoint[];
  format: AnalyticsValueFormat;
  currentLabel: string;
  previousLabel: string | null;
  emptyText?: string;
  goodWhen?: "up" | "down";
  height?: number;
}) {
  const gradientId = useId().replace(/:/g, "");
  const hasPrevious = data.some((point) => point.previous !== null);
  const hasPartial = data.some((point) => point.partial);
  const hasNegative = data.some(
    (point) => point.value < 0 || (point.previous ?? 0) < 0,
  );
  const plotted = plotPoints(data);
  const hasData = data.some(
    (point) => point.value !== 0 || (point.previous ?? 0) !== 0,
  );

  return (
    <div className="dash-an-chart">
      <div className="dash-an-chart-plot" style={{ height }}>
        {!hasData ? (
          <div className="dash-an-chart-empty">{emptyText}</div>
        ) : null}
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={plotted}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="var(--dash-an-series)"
                  stopOpacity={0.16}
                />
                <stop
                  offset="100%"
                  stopColor="var(--dash-an-series)"
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              stroke="var(--dash-an-grid)"
              strokeDasharray="0"
            />
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              dy={8}
              interval="preserveStartEnd"
              minTickGap={28}
              tick={{ fontSize: 11, fill: "var(--dash-text-3)" }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              width={52}
              tickCount={5}
              // A store with no sales still gets a real, flat axis rather than
              // a collapsed one: the empty state reads as "nothing happened".
              // Anchored at zero so Recharts picks round ticks (₹0, ₹2.5K, ₹5K);
              // only a range with net-refund days needs to go below it.
              domain={
                !hasData
                  ? [0, 10]
                  : hasNegative
                    ? ["auto", "auto"]
                    : [0, "auto"]
              }
              allowDecimals={format === "percent"}
              tickFormatter={(value: number) =>
                formatAnalyticsValue(value, format, true)
              }
              tick={{ fontSize: 11, fill: "var(--dash-text-3)" }}
            />
            {hasData ? (
              <Tooltip
                content={<ChartTooltip format={format} goodWhen={goodWhen} />}
                cursor={{ stroke: "var(--dash-border-hover)", strokeWidth: 1 }}
                isAnimationActive={false}
              />
            ) : null}
            {hasPrevious ? (
              <Line
                type="monotone"
                dataKey="previous"
                stroke="var(--dash-an-series-prev)"
                strokeWidth={2}
                strokeDasharray="1 4"
                strokeLinecap="round"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                connectNulls
              />
            ) : null}
            <Area
              type="monotone"
              dataKey="value"
              stroke="none"
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{
                r: 4,
                fill: "var(--dash-an-series)",
                stroke: "var(--dash-surface)",
                strokeWidth: 2,
              }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="solid"
              stroke="var(--dash-an-series)"
              strokeWidth={2}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
            {hasPartial ? (
              <Line
                type="monotone"
                dataKey="dashed"
                stroke="var(--dash-an-series)"
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="dash-an-legend">
        <span>
          <span className="dash-an-legend-mark is-current" aria-hidden />
          {currentLabel}
        </span>
        {previousLabel ? (
          <span>
            <span className="dash-an-legend-mark is-previous" aria-hidden />
            {previousLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
