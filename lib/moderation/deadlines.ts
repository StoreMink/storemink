/**
 * The complaint deadlines of takedown design 3.9: when each complaint must be
 * acknowledged, acted on and resolved, counted from the time it reached
 * StoreMink (not the time it was logged), and when the operators are alerted.
 *
 * PURE and client-safe: no server import, no database, and no clock of its
 * own (every function that needs "now" takes it). India time is UTC+5:30 all
 * year, so the working-day count needs no time-zone library.
 *
 * `grievance_complaints_due_check` in migration 0269 holds the same outer
 * limits, so nothing can record a later deadline; deadlines.test.ts reads the
 * migration as text and checks every deadline here against it.
 */

import type { ComplaintKind } from "./kinds";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1000;

/** India Standard Time is UTC+5:30, with no daylight saving. */
const IST_OFFSET_MS = (5 * 60 + 30) * MINUTE_MS;

/** Every complaint is acknowledged within 24 hours of reaching StoreMink. */
export const ACKNOWLEDGE_WITHIN_HOURS = 24;

/** A personal data request is answered within 10 working days. */
export const DATA_REQUEST_WORKING_DAYS = 10;

/**
 * The outer cap on a working-day deadline, in calendar days after receipt.
 * Ten working days never reach it (holidays are not known to the code, which
 * only makes the date earlier); it is the CHECK's own limit, kept here too.
 */
export const WORKING_DAYS_CAP_DAYS = 15;

/** How long after receipt a deadline falls: hours, or India working days. */
export type DeadlineSpan = { hours: number } | { workingDays: number };

/** The act and resolve deadlines of each complaint kind (design 3.9 table). */
export const COMPLAINT_DEADLINES: Record<
  ComplaintKind,
  { act: DeadlineSpan; resolve: DeadlineSpan }
> = {
  court_order: { act: { hours: 3 }, resolve: { hours: 3 } },
  government_order: { act: { hours: 3 }, resolve: { hours: 3 } },
  information_order: { act: { hours: 72 }, resolve: { hours: 72 } },
  intimate_or_impersonation: { act: { hours: 2 }, resolve: { hours: 36 } },
  listed_content: { act: { hours: 36 }, resolve: { hours: 36 } },
  other_removal: { act: { hours: 7 * 24 }, resolve: { hours: 7 * 24 } },
  grievance: { act: { hours: 7 * 24 }, resolve: { hours: 7 * 24 } },
  data_request: {
    act: { workingDays: DATA_REQUEST_WORKING_DAYS },
    resolve: { workingDays: DATA_REQUEST_WORKING_DAYS },
  },
};

/** A complaint's three deadlines. */
export type ComplaintDeadlines = {
  acknowledgeDueAt: Date;
  actionDueAt: Date;
  resolveDueAt: Date;
};

/** The same, as a database row may hold them (timestamptz as text). */
export type StoredDeadlines = {
  acknowledgeDueAt: Date | string;
  actionDueAt: Date | string;
  resolveDueAt: Date | string;
};

function toDate(value: Date | string, what: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`${what} is not a valid time.`);
  }
  return date;
}

function optionalDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The end (23:59:59 India time) of the `days`-th working day after the India
 * date `date` falls on: counting starts the day after receipt, and Saturdays
 * and Sundays are skipped. Public holidays are not known, which can only make
 * the date earlier than the promise, never later.
 */
export function endOfWorkingDaysIst(date: Date | string, days: number): Date {
  const received = toDate(date, "The received time");
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError("The number of working days must be 1 or more.");
  }
  // The India calendar date of receipt, as midnight UTC on that date.
  const local = new Date(received.getTime() + IST_OFFSET_MS);
  let cursor = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  let counted = 0;
  while (counted < days) {
    cursor += DAY_MS;
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6) counted += 1;
  }
  // 23:59:59 India time on that date, as an instant.
  const endOfDayLocal = cursor + DAY_MS - 1000;
  return new Date(endOfDayLocal - IST_OFFSET_MS);
}

function spanEnd(received: Date, span: DeadlineSpan): Date {
  if ("hours" in span) {
    return new Date(received.getTime() + span.hours * HOUR_MS);
  }
  const end = endOfWorkingDaysIst(received, span.workingDays);
  const cap = received.getTime() + WORKING_DAYS_CAP_DAYS * DAY_MS;
  return new Date(Math.min(end.getTime(), cap));
}

/** A complaint's three deadlines, from the time it reached StoreMink. */
export function computeDeadlines(
  kind: ComplaintKind,
  receivedAt: Date | string,
): ComplaintDeadlines {
  const received = toDate(receivedAt, "The received time");
  const rule = COMPLAINT_DEADLINES[kind];
  return {
    acknowledgeDueAt: new Date(
      received.getTime() + ACKNOWLEDGE_WITHIN_HOURS * HOUR_MS,
    ),
    actionDueAt: spanEnd(received, rule.act),
    resolveDueAt: spanEnd(received, rule.resolve),
  };
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * The deadlines after a complaint's kind changes (design 3.9 "Changing the
 * kind"): each is the earlier of the stored one and the new kind's, so a
 * stricter kind always takes effect and nothing ever moves later.
 */
export function tightenDeadlines(
  stored: StoredDeadlines,
  kind: ComplaintKind,
  receivedAt: Date | string,
): ComplaintDeadlines {
  const fresh = computeDeadlines(kind, receivedAt);
  return {
    acknowledgeDueAt: earlier(
      toDate(stored.acknowledgeDueAt, "The stored acknowledge deadline"),
      fresh.acknowledgeDueAt,
    ),
    actionDueAt: earlier(
      toDate(stored.actionDueAt, "The stored action deadline"),
      fresh.actionDueAt,
    ),
    resolveDueAt: earlier(
      toDate(stored.resolveDueAt, "The stored resolve deadline"),
      fresh.resolveDueAt,
    ),
  };
}

// ── Stages ──────────────────────────────────────────────────────────────────

export type DeadlineStage = "acknowledge" | "act" | "resolve";

const STAGE_ORDER: DeadlineStage[] = ["acknowledge", "act", "resolve"];

/**
 * The deadlines shown for a kind (design 6.4): an "Other complaint" has no
 * removal, so it shows Acknowledge and Resolve; an information order and a
 * personal data request show Acknowledge and Provide or Answer, which fall at
 * the same time as their resolution.
 */
export function deadlineStages(kind: ComplaintKind): DeadlineStage[] {
  switch (kind) {
    case "grievance":
      return ["acknowledge", "resolve"];
    case "information_order":
    case "data_request":
      return ["acknowledge", "act"];
    default:
      return ["acknowledge", "act", "resolve"];
  }
}

/**
 * The words before a deadline's date ("Remove or block by 26 Oct, 14:05"), as
 * the console and the operators' alerts write them (design 6.2 to 6.4, 7.5).
 * A stage a kind does not show takes the name of the one it falls with.
 */
export function deadlineLabel(
  kind: ComplaintKind,
  stage: DeadlineStage,
): string {
  if (stage === "acknowledge") return "Acknowledge by";
  if (kind === "information_order") return "Provide by";
  if (kind === "data_request") return "Answer by";
  if (kind === "grievance") return "Resolve by";
  return stage === "act" ? "Remove or block by" : "Resolve by";
}

/** What the deadline and alert reads need of a complaint row. */
export type ComplaintClock = {
  kind: ComplaintKind;
  receivedAt: Date | string;
  acknowledgeDueAt: Date | string;
  actionDueAt: Date | string;
  resolveDueAt: Date | string;
  acknowledgedAt?: Date | string | null;
  actionedAt?: Date | string | null;
  resolvedAt?: Date | string | null;
  /** The `alerts` jsonb: stage keys already sent (see `alertKey`). */
  alerts?: Record<string, unknown> | null;
};

type OpenStage = { stage: DeadlineStage; dueAt: Date };

/**
 * The shown stages not yet met, earliest first. A resolved complaint has none.
 * An information order or data request counts as met for its "act" stage once
 * it is actioned (the information was provided, or the request answered).
 */
function openStages(complaint: ComplaintClock): OpenStage[] {
  if (optionalDate(complaint.resolvedAt)) return [];
  const met: Record<DeadlineStage, boolean> = {
    acknowledge: optionalDate(complaint.acknowledgedAt) !== null,
    act: optionalDate(complaint.actionedAt) !== null,
    resolve: false,
  };
  const due: Record<DeadlineStage, Date> = {
    acknowledge: toDate(complaint.acknowledgeDueAt, "The acknowledge deadline"),
    act: toDate(complaint.actionDueAt, "The action deadline"),
    resolve: toDate(complaint.resolveDueAt, "The resolve deadline"),
  };
  return deadlineStages(complaint.kind)
    .filter((stage) => !met[stage])
    .map((stage) => ({ stage, dueAt: due[stage] }))
    .sort(
      (a, b) =>
        a.dueAt.getTime() - b.dueAt.getTime() ||
        STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
    );
}

/** The earliest deadline a complaint has not met, or null when none is open. */
export function nextDeadline(
  complaint: ComplaintClock,
  now: Date,
): { stage: DeadlineStage; dueAt: Date; overdue: boolean } | null {
  const first = openStages(complaint)[0];
  if (!first) return null;
  return {
    stage: first.stage,
    dueAt: first.dueAt,
    overdue: first.dueAt.getTime() <= now.getTime(),
  };
}

// ── Alerts ──────────────────────────────────────────────────────────────────

/** A deadline at most this long after receipt is a 2-hour or 3-hour deadline. */
export const SHORT_DEADLINE_HOURS = 3;

/** How early a 2-hour or 3-hour deadline alerts. */
export const SHORT_DEADLINE_LEAD_MINUTES = 30;

/** How early every other deadline alerts. */
export const DEADLINE_LEAD_HOURS = 2;

export type AlertPhase = "soon" | "overdue";

/** The key a sent alert stage is recorded under in `alerts`. */
export function alertKey(stage: DeadlineStage, phase: AlertPhase): string {
  return `${stage}_${phase}`;
}

/** How long before a deadline its first alert goes (design 3.9). */
export function alertLeadMs(
  receivedAt: Date | string,
  dueAt: Date | string,
): number {
  const span =
    toDate(dueAt, "The deadline").getTime() -
    toDate(receivedAt, "The received time").getTime();
  return span <= SHORT_DEADLINE_HOURS * HOUR_MS
    ? SHORT_DEADLINE_LEAD_MINUTES * MINUTE_MS
    : DEADLINE_LEAD_HOURS * HOUR_MS;
}

/**
 * The alert that is due and not yet sent, or null (design 3.9 and 8.1 step 1).
 * Each open stage alerts once ahead of its deadline (30 minutes before a
 * 2-hour or 3-hour deadline, 2 hours before any other) and once more when it
 * passes. A stage falling at the same moment as an earlier open stage is
 * covered by that stage's alert, so two deadlines at one time ring once.
 */
export function dueAlert(
  complaint: ComplaintClock,
  now: Date,
): {
  stage: DeadlineStage;
  phase: AlertPhase;
  key: string;
  dueAt: Date;
} | null {
  const sent = complaint.alerts ?? {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(sent, key);
  const nowMs = now.getTime();
  const seen = new Set<number>();
  for (const { stage, dueAt } of openStages(complaint)) {
    const dueMs = dueAt.getTime();
    if (seen.has(dueMs)) continue;
    seen.add(dueMs);
    const overdueKey = alertKey(stage, "overdue");
    if (nowMs >= dueMs) {
      if (!has(overdueKey)) {
        return { stage, phase: "overdue", key: overdueKey, dueAt };
      }
      continue;
    }
    const soonKey = alertKey(stage, "soon");
    const lead = alertLeadMs(complaint.receivedAt, dueAt);
    if (nowMs >= dueMs - lead && !has(soonKey) && !has(overdueKey)) {
      return { stage, phase: "soon", key: soonKey, dueAt };
    }
  }
  return null;
}
