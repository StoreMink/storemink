"use client";

import { ChartNoAxesCombined, Table2 } from "lucide-react";
import { useId, useState } from "react";
import type { MinkArtifact } from "@/lib/mink/types";
import { MinkLink } from "./mink-link";

type ChartArtifact = Extract<MinkArtifact, { type: "chart" }>;

/**
 * Series colours, in fixed order, validated for colour-vision deficiency and
 * contrast with the dataviz palette validator (indigo, teal, amber: every
 * adjacent pair clears OKLab deltaE 8 under protan, deutan and tritan
 * simulation and 3:1 on white). A fourth series is never drawn; the tool
 * sends at most three, and the parser refuses more.
 */
export const MINK_CHART_SERIES_COLOURS = ["#5b3fd0", "#0d9488", "#d97706"];

const WIDTH = 320;
const HEIGHT = 150;
const PAD = { top: 10, right: 10, bottom: 24, left: 44 };

export function formatMinkChartValue(
  value: number,
  format: ChartArtifact["format"],
  currency = "INR",
): string {
  if (format === "currency") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
    }).format(value);
  }
  if (format === "percent") {
    return `${value.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
  }
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/** Three "nice" gridline values from zero to just above the maximum. */
export function minkChartTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const rough = max / 3;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((factor) => factor * magnitude)
      .find((candidate) => candidate >= rough) ?? magnitude;
  const ticks: number[] = [];
  for (
    let value = 0;
    value <= max + step * 0.001 || ticks.length < 2;
    value += step
  ) {
    ticks.push(Number(value.toFixed(6)));
    if (ticks.length > 6) break;
  }
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/**
 * An inline chart in a Mink answer: one axis, thin marks, muted grid, a
 * legend only when there is more than one series, a hover tooltip per x
 * position and a table view for anyone who prefers the numbers.
 */
export function MinkChartCard({ artifact }: { artifact: ChartArtifact }) {
  const [table, setTable] = useState(false);
  const titleId = useId();
  const labels = artifact.series[0]?.points.map((point) => point.label) ?? [];
  const count = labels.length;
  const max = Math.max(
    0,
    ...artifact.series.flatMap((series) =>
      series.points.map((point) => point.value),
    ),
  );
  const ticks = minkChartTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number) =>
    PAD.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number) =>
    PAD.top + plotHeight - (value / top) * plotHeight;
  const labelEvery = count <= 8 ? 1 : Math.ceil(count / 6);
  const format = (value: number) =>
    formatMinkChartValue(value, artifact.format, artifact.currency);

  return (
    <section className="overflow-hidden rounded-2xl border border-[#e5e2ec] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <header className="flex items-center justify-between border-b border-[#eeeeef] bg-[#fbfaff] px-3 py-2 text-xs font-semibold text-[#3e3262]">
        <span id={titleId} className="flex items-center gap-1.5">
          <ChartNoAxesCombined className="h-3.5 w-3.5" aria-hidden="true" />
          {artifact.title}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTable((value) => !value)}
            aria-pressed={table}
            className="rounded p-1 text-[#5c5f62] hover:bg-[#eee9ff]"
            aria-label={table ? "Show as chart" : "Show as table"}
            title={table ? "Show as chart" : "Show as table"}
          >
            <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {artifact.dashboardPath ? (
            <MinkLink
              href={artifact.dashboardPath}
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-[#5b3fd0] hover:bg-[#eee9ff]"
            >
              Open in Reports
            </MinkLink>
          ) : null}
        </span>
      </header>
      <div className="p-3">
        {artifact.filters.length ? (
          <p className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#74707d]">
            {artifact.filters.map((filter) => (
              <span key={`${filter.label}:${filter.value}`}>
                <span className="font-medium text-[#3e3262]">
                  {filter.label}:
                </span>{" "}
                {filter.value}
              </span>
            ))}
          </p>
        ) : null}
        {table ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-[11px]">
              <thead>
                <tr className="text-left text-[#74707d]">
                  <th className="py-1 pr-3 font-medium">Label</th>
                  {artifact.series.map((series) => (
                    <th
                      key={series.label}
                      className="py-1 pr-3 text-right font-medium"
                    >
                      {series.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {labels.map((label, index) => (
                  <tr
                    key={`${label}-${index}`}
                    className="border-t border-[#f1f0f5] text-[#29272d]"
                  >
                    <td className="py-1 pr-3">{label}</td>
                    {artifact.series.map((series) => (
                      <td
                        key={series.label}
                        className="py-1 pr-3 text-right tabular-nums"
                      >
                        {format(series.points[index]?.value ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-labelledby={titleId}
            className="h-auto w-full"
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  x2={WIDTH - PAD.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="#eeeeef"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 6}
                  y={y(tick) + 3}
                  textAnchor="end"
                  fontSize={8}
                  fill="#74707d"
                >
                  {compact(tick, artifact.format)}
                </text>
              </g>
            ))}
            {artifact.kind === "bar"
              ? artifact.series.map((series, seriesIndex) => {
                  const groups = Math.max(count, 1);
                  const slot = plotWidth / groups;
                  const barWidth = Math.max(
                    2,
                    (slot - 6) / artifact.series.length - 2,
                  );
                  return series.points.map((point, index) => {
                    const left =
                      PAD.left +
                      index * slot +
                      3 +
                      seriesIndex * (barWidth + 2);
                    const height = Math.max(
                      0,
                      PAD.top + plotHeight - y(point.value),
                    );
                    return (
                      <rect
                        key={`${series.label}-${index}`}
                        x={left}
                        y={PAD.top + plotHeight - height}
                        width={barWidth}
                        height={height}
                        rx={Math.min(4, barWidth / 2)}
                        fill={MINK_CHART_SERIES_COLOURS[seriesIndex]}
                      />
                    );
                  });
                })
              : artifact.series.map((series, seriesIndex) => (
                  <g key={series.label}>
                    <polyline
                      fill="none"
                      stroke={MINK_CHART_SERIES_COLOURS[seriesIndex]}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      strokeDasharray={seriesIndex === 0 ? undefined : "4 3"}
                      points={series.points
                        .map((point, index) => `${x(index)},${y(point.value)}`)
                        .join(" ")}
                    />
                    {count <= 12
                      ? series.points.map((point, index) => (
                          <circle
                            key={index}
                            cx={x(index)}
                            cy={y(point.value)}
                            r={3}
                            fill="#ffffff"
                            stroke={MINK_CHART_SERIES_COLOURS[seriesIndex]}
                            strokeWidth={2}
                          />
                        ))
                      : null}
                  </g>
                ))}
            {labels.map((label, index) =>
              index % labelEvery === 0 || index === count - 1 ? (
                <text
                  key={`${label}-${index}`}
                  x={
                    artifact.kind === "bar"
                      ? PAD.left +
                        (index + 0.5) * (plotWidth / Math.max(count, 1))
                      : x(index)
                  }
                  y={HEIGHT - 8}
                  textAnchor={
                    artifact.kind === "bar"
                      ? "middle"
                      : index === 0
                        ? "start"
                        : index === count - 1
                          ? "end"
                          : "middle"
                  }
                  fontSize={8}
                  fill="#74707d"
                >
                  {label.length > 10 ? `${label.slice(0, 9)}…` : label}
                </text>
              ) : null,
            )}
            {labels.map((label, index) => {
              const slot = plotWidth / Math.max(count, 1);
              return (
                <rect
                  key={`hit-${index}`}
                  x={PAD.left + index * slot}
                  y={PAD.top}
                  width={slot}
                  height={plotHeight}
                  fill="transparent"
                >
                  <title>
                    {[
                      label,
                      ...artifact.series.map(
                        (series) =>
                          `${series.label}: ${format(series.points[index]?.value ?? 0)}`,
                      ),
                    ].join("\n")}
                  </title>
                </rect>
              );
            })}
          </svg>
        )}
        {artifact.series.length > 1 ? (
          <ul
            className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#3e3262]"
            aria-label="Series"
          >
            {artifact.series.map((series, index) => (
              <li key={series.label} className="inline-flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: MINK_CHART_SERIES_COLOURS[index] }}
                />
                {series.label}
              </li>
            ))}
          </ul>
        ) : null}
        {artifact.dataAsOf ? (
          <p className="mt-1 text-[10px] text-[#8c8798]">
            Data as of{" "}
            {new Date(artifact.dataAsOf).toLocaleString("en-IN", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Axis labels: short numbers, one unit, never a long currency string. */
function compact(value: number, format: ChartArtifact["format"]): string {
  if (format === "percent") return `${value}%`;
  const abs = Math.abs(value);
  const prefix = format === "currency" ? "₹" : "";
  if (abs >= 1e7)
    return `${prefix}${(value / 1e7).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (abs >= 1e5)
    return `${prefix}${(value / 1e5).toFixed(1).replace(/\.0$/, "")}L`;
  if (abs >= 1e3)
    return `${prefix}${(value / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return `${prefix}${value}`;
}
