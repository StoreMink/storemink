import type { AnalyticsWindow } from "./range";

// Calendar buckets for over-time charts.
//
// ★ The SQL side buckets with `date_trunc(grain, created_at at time zone tz)`
// and keys each row `YYYY-MM-DD`. Only buckets that HAD a row come back, so a
// chart drawn straight from the rows skipped every quiet day and the x-axis
// jumped (12 Aug, 15 Aug, 21 Aug drawn evenly spaced). These helpers produce
// the full key list for a window with the same truncation rules Postgres uses
// (ISO weeks start on Monday) so the caller can fill the gaps with zeros, and
// so a comparison window can be lined up bucket-for-bucket.

export type BucketGrain = "day" | "week" | "month";

const DAY_MS = 86_400_000;

/** Day buckets up to ~6 weeks, weeks up to ~7 months, then months. */
export function bucketGrain(window: AnalyticsWindow): BucketGrain {
  const days = (window.to.getTime() - window.from.getTime()) / DAY_MS;
  if (days <= 45) return "day";
  if (days <= 210) return "week";
  return "month";
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function localDate(instant: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: read("year"), month: read("month"), day: read("day") };
}

/** Calendar arithmetic only: a UTC midnight never meets a DST boundary. */
function asUtc(date: CalendarDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

function truncate(date: Date, grain: BucketGrain): Date {
  if (grain === "month") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }
  if (grain === "week") {
    // getUTCDay: Sunday = 0. ISO weeks (and Postgres) start on Monday.
    const sinceMonday = (date.getUTCDay() + 6) % 7;
    return new Date(date.getTime() - sinceMonday * DAY_MS);
  }
  return date;
}

function step(date: Date, grain: BucketGrain): Date {
  if (grain === "month") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }
  return new Date(date.getTime() + (grain === "week" ? 7 : 1) * DAY_MS);
}

function keyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every bucket key (`YYYY-MM-DD`, the bucket's first day) the window touches. */
export function bucketKeys(
  window: AnalyticsWindow,
  grain: BucketGrain,
  timeZone: string,
): string[] {
  if (window.to.getTime() <= window.from.getTime()) return [];
  const first = truncate(asUtc(localDate(window.from, timeZone)), grain);
  // `to` is exclusive, so the last bucket is the one holding the instant before.
  const last = truncate(
    asUtc(localDate(new Date(window.to.getTime() - 1), timeZone)),
    grain,
  );
  const keys: string[] = [];
  // A 12-month range in day grain would be ~366 keys; the guard only stops a
  // malformed window from looping, it never trims a real one.
  for (
    let cursor = first;
    cursor.getTime() <= last.getTime() && keys.length < 1_000;
    cursor = step(cursor, grain)
  ) {
    keys.push(keyOf(cursor));
  }
  return keys;
}

interface LocalDateTime extends CalendarDate {
  midnight: boolean;
}

function localDateTime(instant: Date, timeZone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    midnight:
      read("hour") === 0 &&
      read("minute") === 0 &&
      read("second") === 0 &&
      instant.getUTCMilliseconds() === 0,
  };
}

/**
 * Whether the window covers only PART of a bucket: the week that is still in
 * progress, today, or a range that starts mid-week. Charts draw those edges
 * dashed (Shopify's "in progress" convention) so a half-finished week does
 * not read as a collapse in sales.
 */
export function bucketIsPartial(
  key: string,
  grain: BucketGrain,
  window: AnalyticsWindow,
  timeZone: string,
): boolean {
  const start = parseKey(key);
  if (!start) return false;
  const end = step(start, grain);
  const from = localDateTime(window.from, timeZone);
  const to = localDate(window.to, timeZone);
  const fromDay = asUtc(from).getTime();
  const toDay = asUtc(to).getTime();
  // Starts late: the window opens after this bucket's first midnight.
  const startsLate =
    fromDay > start.getTime() ||
    (fromDay === start.getTime() && !from.midnight);
  // Ends early: the (exclusive) end falls before this bucket's closing
  // midnight. Any instant on or after that calendar day covers the bucket.
  const endsEarly = toDay < end.getTime();
  return startsLate || endsEarly;
}

function parseKey(key: string): Date | null {
  const date = new Date(`${key}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Short axis label: "12 Aug" for days and weeks, "Aug 26" for months. */
export function bucketLabel(key: string, grain: BucketGrain): string {
  const date = parseKey(key);
  if (!date) return key;
  return new Intl.DateTimeFormat("en-IN", {
    day: grain === "month" ? undefined : "numeric",
    month: "short",
    year: grain === "month" ? "2-digit" : undefined,
    timeZone: "UTC",
  }).format(date);
}

/** Full tooltip label: "Tue, 12 Aug 2026", "Week of 11 Aug 2026", "Aug 2026". */
export function bucketTitle(key: string, grain: BucketGrain): string {
  const date = parseKey(key);
  if (!date) return key;
  if (grain === "month") {
    return new Intl.DateTimeFormat("en-IN", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }
  // Assembled from parts: ICU's en-IN pattern puts a comma before the year
  // when a weekday is present ("Wed, 12 Aug, 2026") and that varies by runtime.
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-IN", { ...options, timeZone: "UTC" }).format(
      date,
    );
  const dayMonthYear = `${part({ day: "numeric" })} ${part({ month: "short" })} ${part({ year: "numeric" })}`;
  return grain === "week"
    ? `Week of ${dayMonthYear}`
    : `${part({ weekday: "short" })}, ${dayMonthYear}`;
}
