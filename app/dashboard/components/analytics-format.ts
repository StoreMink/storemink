// Number formatting for Analytics. A plain module on purpose: server cards and
// client charts both call it, and a function exported from a "use client" file
// cannot be CALLED on the server (it becomes a client reference).

export type AnalyticsValueFormat = "currency" | "number" | "percent";

/** One bucket of an over-time chart, with its comparison bucket beside it. */
export interface TrendPoint {
  key: string;
  /** Short axis label. */
  label: string;
  /** Full date for the tooltip. */
  title: string;
  value: number;
  previous: number | null;
  previousTitle: string | null;
  /** Only part of the bucket is in range (in progress): drawn dashed. */
  partial?: boolean;
}

export function formatAnalyticsValue(
  value: number,
  format: AnalyticsValueFormat,
  compact = false,
): string {
  if (!Number.isFinite(value)) return "-";
  if (format === "percent") {
    return `${value.toFixed(Math.abs(value) > 0 && Math.abs(value) < 1 ? 2 : 1)}%`;
  }
  if (compact && Math.abs(value) >= 1000) {
    return new Intl.NumberFormat("en-IN", {
      style: format === "currency" ? "currency" : "decimal",
      currency: "INR",
      currencyDisplay: "narrowSymbol",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  if (format === "currency") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: Math.abs(value) < 100 && value % 1 !== 0 ? 2 : 0,
    }).format(value);
  }
  return Math.round(value).toLocaleString("en-IN");
}
