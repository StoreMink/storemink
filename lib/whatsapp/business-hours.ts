// ---------------------------------------------------------------------------
// A store's weekly opening hours, for the WhatsApp away message.
//
// Pure and client-safe: the settings form renders and checks the same shape
// the inbound path reads, so the two cannot disagree about whether a store is
// open.
//
// ── ★ ONE SPAN PER DAY, AND A SPAN THAT ENDS AFTER MIDNIGHT BELONGS TO THE DAY
// IT BEGINS ON. "Friday 22:00 to 02:00" is one evening: 01:00 on SATURDAY is
// inside it, 01:00 on Friday is not. The offers engine's time window follows
// the same rule (lib/offers/apply.ts withinTimeWindow), so "Friday night"
// means one thing across the product.
//
// ── ★ TIMES ARE THE STORE'S, in the zone Settings → Business time zone sets
// (India - Kolkata by default), never the server's: Cloud Run runs in UTC,
// which would open an Indian shop 5½ hours late.
//
// ── ★ "HAS THE SHOP OPENED SINCE?" IS ASKED IN LOCAL WALL-CLOCK TIME. The away
// message goes once per closed spell; whether a new spell has begun is whether
// an opening time fell between the last away message and now. Comparing local
// (day, minute) pairs needs only the instant→local conversion Intl gives
// directly. In a zone with daylight saving, the hour that repeats in autumn
// can be read a minute either way, which costs at most one away message.
// ---------------------------------------------------------------------------

/** Display order: the week as a shop thinks of it. */
export const WEEK_DAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

export const WEEK_DAY_LABELS: Record<WeekDay, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** "HH:MM", 24-hour. `close` may be "24:00" only for a day open all day. */
export interface DayHours {
  open: string;
  close: string;
}

/** A day with no hours is closed all day. */
export type BusinessHours = Record<WeekDay, DayHours | null>;

export const ALL_DAY: DayHours = { open: "00:00", close: "24:00" };

/** What a store that has never set its hours starts from. */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  mon: { open: "10:00", close: "19:00" },
  tue: { open: "10:00", close: "19:00" },
  wed: { open: "10:00", close: "19:00" },
  thu: { open: "10:00", close: "19:00" },
  fri: { open: "10:00", close: "19:00" },
  sat: { open: "10:00", close: "19:00" },
  sun: null,
};

/** Intl's weekday order (0 = Sunday) mapped onto our keys. */
const BY_WEEKDAY: readonly WeekDay[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 86_400_000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight, or null when the string is not a time. */
export function timeToMinutes(value: unknown): number | null {
  if (value === "24:00") return MINUTES_PER_DAY;
  if (typeof value !== "string") return null;
  const m = TIME.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isAllDay(day: DayHours): boolean {
  return day.open === "00:00" && day.close === "24:00";
}

/** The span in minutes; `close <= open` means it ends the next day. */
function span(day: DayHours): { open: number; close: number } | null {
  const open = timeToMinutes(day.open);
  const close = timeToMinutes(day.close);
  if (open === null || close === null || open === MINUTES_PER_DAY) return null;
  return { open, close };
}

/** True when the span runs past midnight into the next day. */
export function endsNextDay(day: DayHours): boolean {
  const s = span(day);
  return s !== null && s.close < s.open && s.close > 0;
}

export type HoursCheck =
  | { ok: true; hours: BusinessHours }
  | { ok: false; error: string };

/**
 * The strict check a save runs. A day the input leaves out is closed; a day
 * whose times are malformed, or whose opening and closing times are the same,
 * is an error named after the day.
 */
export function validateBusinessHours(input: unknown): HoursCheck {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Business hours are missing." };
  }
  const raw = input as Record<string, unknown>;
  const hours = {} as BusinessHours;
  for (const day of WEEK_DAYS) {
    const value = raw[day];
    if (value === null || value === undefined) {
      hours[day] = null;
      continue;
    }
    const label = WEEK_DAY_LABELS[day];
    if (typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: `${label}: choose opening hours or Closed.` };
    }
    const { open, close } = value as Record<string, unknown>;
    const o = timeToMinutes(open);
    const c = timeToMinutes(close);
    if (o === null || c === null || o === MINUTES_PER_DAY) {
      return { ok: false, error: `${label}: enter times like 09:30.` };
    }
    if (c === MINUTES_PER_DAY && o !== 0) {
      return { ok: false, error: `${label}: enter a closing time like 23:30.` };
    }
    if (o === c) {
      return {
        ok: false,
        error: `${label}: the opening and closing times are the same. Choose "Open all day" for 24 hours.`,
      };
    }
    hours[day] = { open: open as string, close: close as string };
  }
  return { ok: true, hours };
}

/**
 * The lenient read of a stored value: anything that is not a valid day is
 * closed. Only the save path writes this column, through the strict check, so
 * this exists for rows written by an older shape rather than for bad input.
 */
export function normalizeBusinessHours(value: unknown): BusinessHours {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const hours = {} as BusinessHours;
  for (const day of WEEK_DAYS) {
    const one = validateBusinessHours({ [day]: raw[day] });
    hours[day] = one.ok ? one.hours[day] : null;
  }
  return hours;
}

export function hasAnyHours(hours: BusinessHours): boolean {
  return WEEK_DAYS.some((day) => hours[day] !== null);
}

/** A moment on the store's own calendar. */
interface LocalMoment {
  /** Days since 1970-01-01 of the LOCAL date. */
  dayNumber: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes after local midnight. */
  minute: number;
}

function weekdayOf(dayNumber: number): number {
  // 1970-01-01 was a Thursday.
  return (((dayNumber + 4) % 7) + 7) % 7;
}

function localMoment(instant: Date, timeZone: string): LocalMoment | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((p) => p.type === type)?.value);
    const year = read("year");
    const month = read("month");
    const day = read("day");
    const hour = read("hour") % 24;
    const minute = read("minute");
    if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
    const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
    return {
      dayNumber,
      weekday: weekdayOf(dayNumber),
      minute: hour * 60 + minute,
    };
  } catch {
    // An unknown zone throws a RangeError.
    return null;
  }
}

function openAtLocal(
  hours: BusinessHours,
  weekday: number,
  minute: number,
): boolean {
  const today = hours[BY_WEEKDAY[weekday]];
  const t = today ? span(today) : null;
  if (t) {
    if (t.close > t.open) {
      if (minute >= t.open && minute < t.close) return true;
    } else if (minute >= t.open) {
      return true;
    }
  }
  // The part of YESTERDAY's span that runs past midnight.
  const yesterday = hours[BY_WEEKDAY[(weekday + 6) % 7]];
  const y = yesterday ? span(yesterday) : null;
  return y !== null && y.close < y.open && minute < y.close;
}

/**
 * Is the store open at this instant? ★ An unreadable zone answers OPEN, so the
 * away message stays silent: telling a customer "we're closed" when we cannot
 * tell is worse than not saying it.
 */
export function isOpenAt(
  hours: BusinessHours,
  timeZone: string,
  instant: Date,
): boolean {
  const at = localMoment(instant, timeZone);
  if (!at) return true;
  return openAtLocal(hours, at.weekday, at.minute);
}

/**
 * Did an opening time fall after `from` and no later than `to`? This is what
 * "a new closed spell has begun since the last away message" means. ★ An
 * unreadable zone answers YES, so a customer is not left without an answer
 * for ever on a bad setting.
 */
export function openedBetween(
  hours: BusinessHours,
  timeZone: string,
  from: Date,
  to: Date,
): boolean {
  if (!(to.getTime() > from.getTime())) return false;
  const a = localMoment(from, timeZone);
  const b = localMoment(to, timeZone);
  if (!a || !b) return true;
  // A whole week in between holds every opening the schedule has.
  if (b.dayNumber - a.dayNumber > 7) return hasAnyHours(hours);
  const after = a.dayNumber * MINUTES_PER_DAY + a.minute;
  const upTo = b.dayNumber * MINUTES_PER_DAY + b.minute;
  for (let day = a.dayNumber; day <= b.dayNumber; day++) {
    const today = hours[BY_WEEKDAY[weekdayOf(day)]];
    const s = today ? span(today) : null;
    if (!s) continue;
    const opening = day * MINUTES_PER_DAY + s.open;
    if (opening > after && opening <= upTo) return true;
  }
  return false;
}
