"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { TrendBadge, trendPct } from "./analytics-trend";
import {
  formatAnalyticsValue,
  type AnalyticsValueFormat,
} from "./analytics-format";

// A share-of-total donut (Shopify uses one for "Sales by channel" and
// "Sessions by device"): the total and its change in the hole, a legend on
// the right carrying each slice's value and change.

export interface DonutSlice {
  key: string;
  name: string;
  value: number;
  previous: number | null;
}

const MAX_SLICES = 5;

export function AnalyticsDonut({
  slices,
  format,
  emptyText,
}: {
  slices: DonutSlice[];
  format: AnalyticsValueFormat;
  emptyText: string;
}) {
  const positive = slices.filter((slice) => slice.value > 0);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const previousTotal = slices.some((slice) => slice.previous !== null)
    ? slices.reduce((sum, slice) => sum + (slice.previous ?? 0), 0)
    : null;

  if (positive.length === 0) {
    return <div className="dash-an-empty">{emptyText}</div>;
  }

  const shown = positive.slice(0, MAX_SLICES);
  const rest = positive.slice(MAX_SLICES);
  const legend = slices.slice(0, MAX_SLICES);

  return (
    <div className="dash-an-donut">
      <div className="dash-an-donut-plot">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={[
                ...shown,
                ...(rest.length
                  ? [
                      {
                        key: "other",
                        name: "Other",
                        value: rest.reduce((s, r) => s + r.value, 0),
                      },
                    ]
                  : []),
              ]}
              dataKey="value"
              nameKey="name"
              innerRadius="68%"
              outerRadius="100%"
              paddingAngle={shown.length > 1 ? 2 : 0}
              stroke="none"
              isAnimationActive={false}
            >
              {[...shown, ...(rest.length ? [null] : [])].map((_, index) => (
                <Cell
                  key={index}
                  fill={`var(--dash-an-cat-${(index % 6) + 1})`}
                />
              ))}
            </Pie>
            <Tooltip
              isAnimationActive={false}
              content={({ active, payload }) => {
                const item = payload?.[0];
                if (!active || !item) return null;
                return (
                  <div className="dash-an-chart-tip">
                    <div className="dash-an-chart-tip-row">
                      <span className="dash-an-chart-tip-date">
                        {String(item.name)}
                      </span>
                      <strong>
                        {formatAnalyticsValue(Number(item.value), format)}
                      </strong>
                    </div>
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="dash-an-donut-center">
          <strong>{formatAnalyticsValue(total, format, true)}</strong>
          <TrendBadge pct={trendPct(total, previousTotal)} />
        </div>
      </div>
      <ul className="dash-an-donut-legend">
        {legend.map((slice, index) => (
          <li key={slice.key}>
            <span
              className="dash-an-legend-dot"
              style={{ background: `var(--dash-an-cat-${(index % 6) + 1})` }}
              aria-hidden
            />
            <span className="dash-an-donut-name">{slice.name}</span>
            <span className="dash-an-donut-value">
              {formatAnalyticsValue(slice.value, format, true)}
            </span>
            <TrendBadge pct={trendPct(slice.value, slice.previous)} />
          </li>
        ))}
        {slices.length > MAX_SLICES ? (
          <li className="dash-an-donut-more">
            +{slices.length - MAX_SLICES} more
          </li>
        ) : null}
      </ul>
    </div>
  );
}
