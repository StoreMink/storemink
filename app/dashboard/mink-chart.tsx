"use client";

import { ChartNoAxesCombined, Check, Copy, Table2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { MinkArtifact } from "@/lib/mink/types";
import { trendPct } from "./components/analytics-trend";
import { MinkLink } from "./mink-link";

type ChartArtifact = Extract<MinkArtifact, { type: "chart" }>;
export type MinkChartPanel = NonNullable<ChartArtifact["panels"]>[number];
type ChartSummary = NonNullable<ChartArtifact["summary"]>;

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
const PAD = { top: 12, right: 10, bottom: 24, left: 44 };
/** The comparison series is drawn lighter than the current one. */
const COMPARISON_OPACITY = 0.55;
/** At most this many x-axis labels, however many points there are. */
const MAX_AXIS_LABELS = 8;
const LABEL_CHARS = 10;

/**
 * A value as the card prints it: Indian grouping, the artifact's currency.
 * `compact` is the axis form (₹1.2L, ₹3.4Cr, 1.2K): one unit, never a long
 * currency string squeezed into a 44px gutter.
 */
export function formatMinkChartValue(
  value: number,
  format: ChartArtifact["format"],
  currency = "INR",
  options: { compact?: boolean } = {},
): string {
  if (!Number.isFinite(value)) return "-";
  if (options.compact) return compactValue(value, format, currency);
  if (format === "currency") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
    }).format(value);
  }
  if (format === "percent") {
    return `${value.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
  }
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function compactValue(
  value: number,
  format: ChartArtifact["format"],
  currency: string,
): string {
  if (format === "percent") return `${trimZero(value)}%`;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const prefix = format === "currency" ? currencySymbol(currency) : "";
  const unit: [string, number] | null =
    abs >= 1e7
      ? ["Cr", 1e7]
      : abs >= 1e5
        ? ["L", 1e5]
        : abs >= 1e3
          ? ["K", 1e3]
          : null;
  if (!unit) return `${sign}${prefix}${trimZero(abs)}`;
  return `${sign}${prefix}${trimZero(abs / unit[1])}${unit[0]}`;
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function currencySymbol(currency: string): string {
  try {
    return (
      new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
      })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? ""
    );
  } catch {
    return "";
  }
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
 * Which x labels to draw: evenly spaced, the first and the last always, at
 * most eight, and fewer when the labels are long enough to collide at the
 * card's width. Labels are cut to ten characters before they are measured.
 */
export function minkChartAxisIndices(
  labels: string[],
  plotWidth = WIDTH - PAD.left - PAD.right,
): number[] {
  const count = labels.length;
  if (count === 0) return [];
  const longest = Math.max(
    1,
    ...labels.map((label) => Math.min(label.length, LABEL_CHARS)),
  );
  const fit = Math.floor(plotWidth / (longest * 5.2 + 10));
  const max = Math.max(2, Math.min(MAX_AXIS_LABELS, fit));
  if (count <= max) return labels.map((_, index) => index);
  const indices = new Set<number>();
  for (let slot = 0; slot < max; slot += 1) {
    indices.add(Math.round((slot * (count - 1)) / (max - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

/** The one point worth a direct label: the highest, when it is above zero. */
export function minkChartPeakIndex(
  points: Array<{ value: number }>,
): number | null {
  if (points.length === 0) return null;
  let best = 0;
  points.forEach((point, index) => {
    if (point.value > points[best].value) best = index;
  });
  return points[best].value > 0 ? best : null;
}

/** The primary chart as a panel, followed by any small multiples. */
export function minkChartPanels(artifact: ChartArtifact): MinkChartPanel[] {
  return [
    {
      title: artifact.title,
      kind: artifact.kind,
      format: artifact.format,
      ...(artifact.currency ? { currency: artifact.currency } : {}),
      series: artifact.series,
      ...(artifact.summary ? { summary: artifact.summary } : {}),
    },
    ...(artifact.panels ?? []),
  ];
}

/**
 * The table as tab-separated text: one row per x label, one column per
 * series of every panel, plain numbers with the unit in the header so a
 * spreadsheet reads them as numbers.
 */
export function minkChartTsv(artifact: ChartArtifact): string {
  const panels = minkChartPanels(artifact);
  const labels = panels[0]?.series[0]?.points.map((point) => point.label) ?? [];
  const columns = panels.flatMap((panel) =>
    panel.series.map((series) => ({ panel, series })),
  );
  const unit = (panel: MinkChartPanel) =>
    panel.format === "currency"
      ? ` (${panel.currency ?? "INR"})`
      : panel.format === "percent"
        ? " (%)"
        : "";
  const header = [
    "Label",
    ...columns.map(({ panel, series }) => {
      const name =
        panels.length > 1 && panel.series.length > 1
          ? `${panel.title}: ${series.label}`
          : panels.length > 1
            ? panel.title
            : series.label;
      return `${cell(name)}${unit(panel)}`;
    }),
  ];
  const rows = labels.map((label, index) => [
    cell(label),
    ...columns.map(({ series }) => String(series.points[index]?.value ?? 0)),
  ]);
  return [header, ...rows].map((row) => row.join("\t")).join("\n");
}

function cell(text: string): string {
  return text.replace(/[\t\n\r]+/g, " ");
}

/**
 * An inline chart in a Mink answer: the period's figure and its trend first,
 * then one axis, thin marks, a muted grid, the comparison dashed and lighter,
 * one direct label on the highest point, a legend only when there is more
 * than one series, a hover tooltip per x position, a table view for anyone
 * who prefers the numbers, and a second measure as a small multiple.
 */
export function MinkChartCard({ artifact }: { artifact: ChartArtifact }) {
  const [table, setTable] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const titleId = useId();
  const panels = minkChartPanels(artifact);
  const multiple = panels.length > 1;
  const title = multiple
    ? panels.map((panel) => panel.title).join(" · ")
    : artifact.title;

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
    },
    [],
  );

  const copy = async () => {
    const clipboard =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") return;
    try {
      await clipboard.writeText(minkChartTsv(artifact));
      setCopied(true);
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access refused (an insecure host, a denied permission).
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-[#e5e2ec] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <header className="flex items-center justify-between gap-2 border-b border-[#eeeeef] bg-[#fbfaff] px-3 py-2 text-xs font-semibold text-[#3e3262]">
        <span id={titleId} className="flex min-w-0 items-center gap-1.5">
          <ChartNoAxesCombined
            className="h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="truncate">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={copy}
            className="rounded p-1 text-[#5c5f62] hover:bg-[#eee9ff]"
            aria-label={copied ? "Copied" : "Copy table"}
            title={copied ? "Copied" : "Copy table"}
          >
            {copied ? (
              <Check
                className="h-3.5 w-3.5 text-[#15803d]"
                aria-hidden="true"
              />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
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
        <div
          style={
            multiple
              ? {
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 16,
                }
              : undefined
          }
        >
          {panels.map((panel, index) => (
            <ChartPanel
              key={`${panel.title}-${index}`}
              panel={panel}
              table={table}
              titleId={index === 0 ? titleId : undefined}
              subtitle={multiple ? panel.title : null}
            />
          ))}
        </div>
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

function ChartPanel({
  panel,
  table,
  titleId,
  subtitle,
}: {
  panel: MinkChartPanel;
  table: boolean;
  titleId?: string;
  subtitle: string | null;
}) {
  const labels = panel.series[0]?.points.map((point) => point.label) ?? [];
  const count = labels.length;
  const max = Math.max(
    0,
    ...panel.series.flatMap((series) =>
      series.points.map((point) => point.value),
    ),
  );
  const ticks = minkChartTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const slot = plotWidth / Math.max(count, 1);
  const x = (index: number) =>
    PAD.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const barCentre = (index: number) => PAD.left + (index + 0.5) * slot;
  const y = (value: number) =>
    PAD.top + plotHeight - (Math.max(0, value) / top) * plotHeight;
  const axisIndices = new Set(minkChartAxisIndices(labels, plotWidth));
  const dense = count > axisIndices.size;
  const format = (value: number) =>
    formatMinkChartValue(value, panel.format, panel.currency);
  const compact = (value: number) =>
    formatMinkChartValue(value, panel.format, panel.currency, {
      compact: true,
    });
  const peak = minkChartPeakIndex(panel.series[0]?.points ?? []);
  const seriesCount = panel.series.length;
  const barWidth = Math.max(
    2,
    (Math.max(2, slot - 6) - 2 * (seriesCount - 1)) / seriesCount,
  );
  const groupWidth = barWidth * seriesCount + 2 * (seriesCount - 1);
  const barLeft = (index: number, seriesIndex: number) =>
    PAD.left +
    index * slot +
    (slot - groupWidth) / 2 +
    seriesIndex * (barWidth + 2);
  const anchor = (index: number): "start" | "middle" | "end" =>
    index === 0 ? "start" : index === count - 1 ? "end" : "middle";

  return (
    <div className="min-w-0">
      {subtitle ? (
        <p className="mb-1 text-[11px] font-semibold text-[#3e3262]">
          {subtitle}
        </p>
      ) : null}
      {panel.summary ? (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-lg font-semibold tabular-nums text-[#29272d]">
            {format(panel.summary.total)}
          </span>
          <TrendNote summary={panel.summary} format={format} />
        </div>
      ) : null}
      {table ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-[11px]">
            <thead>
              <tr className="text-left text-[#74707d]">
                <th className="py-1 pr-3 font-medium">Label</th>
                {panel.series.map((series) => (
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
                  {panel.series.map((series) => (
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
          {...(titleId
            ? { "aria-labelledby": titleId }
            : { "aria-label": panel.title })}
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
                {compact(tick)}
              </text>
            </g>
          ))}
          {panel.kind === "bar"
            ? panel.series.map((series, seriesIndex) =>
                series.points.map((point, index) => {
                  const height = Math.max(
                    0,
                    PAD.top + plotHeight - y(point.value),
                  );
                  return (
                    <rect
                      key={`${series.label}-${index}`}
                      x={barLeft(index, seriesIndex)}
                      y={PAD.top + plotHeight - height}
                      width={barWidth}
                      height={height}
                      rx={Math.min(4, barWidth / 2)}
                      fill={MINK_CHART_SERIES_COLOURS[seriesIndex]}
                      fillOpacity={seriesIndex === 0 ? 1 : COMPARISON_OPACITY}
                    />
                  );
                }),
              )
            : panel.series.map((series, seriesIndex) => (
                <g key={series.label}>
                  <polyline
                    fill="none"
                    stroke={MINK_CHART_SERIES_COLOURS[seriesIndex]}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={seriesIndex === 0 ? undefined : "4 3"}
                    strokeOpacity={
                      seriesIndex === 0 ? undefined : COMPARISON_OPACITY
                    }
                    points={series.points
                      .map((point, index) => `${x(index)},${y(point.value)}`)
                      .join(" ")}
                  />
                  {seriesIndex === 0 && count <= 12
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
          {peak !== null && panel.series[0] ? (
            <text
              x={
                panel.kind === "bar" ? barLeft(peak, 0) + barWidth / 2 : x(peak)
              }
              y={y(panel.series[0].points[peak].value) - 6}
              textAnchor={
                panel.kind === "bar" && !dense ? "middle" : anchor(peak)
              }
              fontSize={8}
              fontWeight={600}
              fill={MINK_CHART_SERIES_COLOURS[0]}
              data-peak-label
            >
              {compact(panel.series[0].points[peak].value)}
            </text>
          ) : null}
          {labels.map((label, index) =>
            axisIndices.has(index) ? (
              <text
                key={`${label}-${index}`}
                x={panel.kind === "bar" ? barCentre(index) : x(index)}
                y={HEIGHT - 8}
                textAnchor={
                  panel.kind === "bar" && !dense ? "middle" : anchor(index)
                }
                fontSize={8}
                fill="#74707d"
              >
                {label.length > LABEL_CHARS
                  ? `${label.slice(0, LABEL_CHARS - 1)}…`
                  : label}
              </text>
            ) : null,
          )}
          {labels.map((label, index) => (
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
                  ...panel.series.map(
                    (series) =>
                      `${series.label}: ${format(series.points[index]?.value ?? 0)}`,
                  ),
                ].join("\n")}
              </title>
            </rect>
          ))}
        </svg>
      )}
      {panel.series.length > 1 ? (
        <ul
          className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#3e3262]"
          aria-label="Series"
        >
          {panel.series.map((series, index) => (
            <li key={series.label} className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-sm"
                style={{
                  background: MINK_CHART_SERIES_COLOURS[index],
                  opacity: index === 0 ? 1 : COMPARISON_OPACITY,
                }}
              />
              {series.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * "+12% vs previous 30 days": green when the move is good, red when it is
 * bad, where `goodWhen: "down"` flips the reading for a measure such as
 * discounts or returns. The dashboard's trend badge applies the same rule.
 */
function TrendNote({
  summary,
  format,
}: {
  summary: ChartSummary;
  format: (value: number) => string;
}) {
  const pct =
    summary.trendPercent === undefined
      ? summary.previousTotal === undefined
        ? null
        : trendPct(summary.total, summary.previousTotal)
      : summary.trendPercent;
  const vs = summary.comparisonLabel ? ` vs ${summary.comparisonLabel}` : "";
  if (pct === null || !Number.isFinite(pct)) {
    if (summary.previousTotal === undefined) return null;
    return (
      <span className="text-[11px] text-[#74707d]">
        {format(summary.previousTotal)}
        {summary.comparisonLabel ? ` ${summary.comparisonLabel}` : " before"}
      </span>
    );
  }
  const value = Math.abs(pct).toLocaleString("en-IN", {
    maximumFractionDigits: 1,
  });
  if (pct === 0) {
    return (
      <span
        className="rounded-full bg-[#f3f2f7] px-1.5 py-0.5 text-[11px] font-medium text-[#74707d]"
        aria-label={`No change${vs}`}
      >
        No change{vs}
      </span>
    );
  }
  const up = pct > 0;
  const good = (summary.goodWhen ?? "up") === "up" ? up : !up;
  const tone = good
    ? "bg-[#dcfce7] text-[#15803d]"
    : "bg-[#fee2e2] text-[#b91c1c]";
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${tone}`}
      aria-label={`${up ? "Up" : "Down"} ${value}%${vs}`}
    >
      {up ? "+" : "-"}
      {value}%{vs}
    </span>
  );
}
