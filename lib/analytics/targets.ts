// Analytics targets (Basic and above): definitions and progress maths.
//
// Pure module (no server or React imports): the server action validates with
// it, the page computes progress with it, and the client editor reads its
// metric list and period presets.

export const TARGET_METRICS = [
  "total_sales",
  "orders",
  "average_order_value",
  "new_customers",
  "sessions",
  "conversion_rate",
] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];

export interface TargetMetricMeta {
  label: string;
  format: "currency" | "number" | "percent";
  /**
   * "sum" grows through the period, so progress is judged against the share
   * of the period that has passed (pace). "ratio" metrics (an average, a
   * rate) are judged against the target directly.
   */
  kind: "sum" | "ratio";
  /** Needs Pro storefront analytics. */
  traffic: boolean;
}

export const TARGET_METRIC_META: Record<TargetMetric, TargetMetricMeta> = {
  total_sales: {
    label: "Total sales",
    format: "currency",
    kind: "sum",
    traffic: false,
  },
  orders: { label: "Orders", format: "number", kind: "sum", traffic: false },
  average_order_value: {
    label: "Average order value",
    format: "currency",
    kind: "ratio",
    traffic: false,
  },
  new_customers: {
    label: "New customers",
    format: "number",
    kind: "sum",
    traffic: false,
  },
  sessions: {
    label: "Storefront sessions",
    format: "number",
    kind: "sum",
    traffic: true,
  },
  conversion_rate: {
    label: "Conversion rate",
    format: "percent",
    kind: "ratio",
    traffic: true,
  },
};

export const MAX_TARGETS_PER_STORE = 20;
const MAX_PERIOD_DAYS = 731;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isTargetMetric(value: unknown): value is TargetMetric {
  return (
    typeof value === "string" &&
    (TARGET_METRICS as readonly string[]).includes(value)
  );
}

function dayNumber(date: string): number {
  return (
    Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)),
    ) / 86_400_000
  );
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export interface TargetInput {
  metric: TargetMetric;
  periodStart: string;
  periodEnd: string;
  targetValue: number;
}

/** Validate untrusted editor input; returns a message for the first problem. */
export function validateTargetInput(
  raw: unknown,
  options: { trafficAllowed: boolean },
): { ok: true; value: TargetInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "That target isn't valid." };
  }
  const input = raw as Record<string, unknown>;
  if (!isTargetMetric(input.metric)) {
    return { ok: false, error: "Choose what the target measures." };
  }
  const meta = TARGET_METRIC_META[input.metric];
  if (meta.traffic && !options.trafficAllowed) {
    return {
      ok: false,
      error: "Storefront traffic targets need the Pro plan.",
    };
  }
  if (!validDate(input.periodStart) || !validDate(input.periodEnd)) {
    return { ok: false, error: "Choose a start and end date." };
  }
  const span = dayNumber(input.periodEnd) - dayNumber(input.periodStart);
  if (span < 0) {
    return { ok: false, error: "The end date must be on or after the start." };
  }
  if (span > MAX_PERIOD_DAYS) {
    return { ok: false, error: "A target can cover at most two years." };
  }
  const value = Number(input.targetValue);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: "Enter a target above zero." };
  }
  if (meta.format === "percent" && value > 100) {
    return { ok: false, error: "A rate target can't be above 100%." };
  }
  if (value > 1e12) {
    return { ok: false, error: "That target is too large." };
  }
  return {
    ok: true,
    value: {
      metric: input.metric,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      targetValue: value,
    },
  };
}

export type TargetStatus =
  | "upcoming"
  | "on_track"
  | "behind"
  | "achieved"
  | "missed";

export interface TargetProgress {
  /** current / target as a percentage (uncapped, so 120% is visible). */
  percent: number;
  /** Days left including today; 0 once the period has ended. */
  daysLeft: number;
  status: TargetStatus;
}

/**
 * Where a target stands on `today` (a store-local YYYY-MM-DD date).
 *
 * A sum metric is "on track" when it has reached at least the share of the
 * target that matches the share of the period gone by (a 30-day target is
 * expected at 50% on day 15). A ratio metric is on track when it is at or
 * above the target right now. A finished period is achieved or missed.
 */
export function targetProgress(input: {
  metric: TargetMetric;
  periodStart: string;
  periodEnd: string;
  targetValue: number;
  current: number;
  today: string;
}): TargetProgress {
  const percent =
    input.targetValue > 0 ? (input.current / input.targetValue) * 100 : 0;
  const start = dayNumber(input.periodStart);
  const end = dayNumber(input.periodEnd);
  const today = dayNumber(input.today);
  const totalDays = end - start + 1;
  if (today < start) {
    return { percent, daysLeft: totalDays, status: "upcoming" };
  }
  if (today > end) {
    return {
      percent,
      daysLeft: 0,
      status: percent >= 100 ? "achieved" : "missed",
    };
  }
  const daysLeft = end - today + 1;
  if (percent >= 100) return { percent, daysLeft, status: "achieved" };
  if (TARGET_METRIC_META[input.metric].kind === "ratio") {
    return { percent, daysLeft, status: "behind" };
  }
  // Today counts as half gone: judging at midnight would call every target
  // "behind" on its first morning.
  const elapsed = (today - start + 0.5) / totalDays;
  const expected = elapsed * 100;
  return {
    percent,
    daysLeft,
    status: percent >= expected * 0.98 ? "on_track" : "behind",
  };
}

export const TARGET_STATUS_LABEL: Record<TargetStatus, string> = {
  upcoming: "Not started",
  on_track: "On track",
  behind: "Behind",
  achieved: "Achieved",
  missed: "Missed",
};

/** Period presets for the editor, from a store-local `today`. */
export function targetPeriodPresets(today: string): Array<{
  id: "this_month" | "next_month" | "this_quarter" | "this_year";
  label: string;
  start: string;
  end: string;
}> {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  const iso = (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  const quarterStart = Math.floor(month / 3) * 3;
  return [
    {
      id: "this_month",
      label: "This month",
      start: iso(year, month, 1),
      end: iso(year, month + 1, 0),
    },
    {
      id: "next_month",
      label: "Next month",
      start: iso(year, month + 1, 1),
      end: iso(year, month + 2, 0),
    },
    {
      id: "this_quarter",
      label: "This quarter",
      start: iso(year, quarterStart, 1),
      end: iso(year, quarterStart + 3, 0),
    },
    {
      id: "this_year",
      label: "This year",
      start: iso(year, 0, 1),
      end: iso(year, 11, 31),
    },
  ];
}
