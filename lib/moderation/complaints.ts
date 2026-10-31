import "server-only";

/**
 * The complaints log (takedown design 3.9 and 5.4): every complaint, order and
 * data request that reaches StoreMink, with the time it arrived, its deadlines
 * and the four steps it moves through (acknowledged, actioned, resolved,
 * erased).
 *
 * Every write runs in ONE `withService` transaction, re-reads the row under a
 * lock where it depends on its state, and records its `moderation_events` row
 * on the same connection, so the change and its record commit together. An
 * email is never sent inside a transaction: the caller's `deliver` hook runs
 * between a read and the write (CODEBASE section 5 item 2, and the reason
 * `withService` scopes are never nested).
 *
 * Who may call these is the action layer's question (design 3.10: every
 * operator may log, acknowledge, resolve and reopen); this module takes the
 * resolved operator and never reads a session.
 *
 * Deadlines (deadlines.ts) are computed from the time the complaint reached
 * StoreMink and stored. A change of kind keeps, for each deadline, the earlier
 * of the stored one and the new kind's (`tightenDeadlines`), so a deadline
 * never moves later; `grievance_complaints_due_check` (migration 0269) refuses
 * any later than the law allows, whatever the caller.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { grievanceComplaints, stores } from "@/drizzle/schema";
import { loggableError, pgConstraint } from "@/lib/db/errors";
import { logError, logInfo } from "@/lib/observability/logger";
import { ROOT_DOMAIN } from "@/lib/store/host";
import {
  COMPLAINT_CHANNELS,
  COMPLAINT_KINDS,
  COMPLAINT_OUTCOMES,
  isOneOf,
  isUrgentComplaintKind,
  type ComplaintChannel,
  type ComplaintKind,
  type ComplaintOutcome,
} from "./kinds";
import {
  alertKey,
  computeDeadlines,
  deadlineStages,
  tightenDeadlines,
  type ComplaintDeadlines,
  type DeadlineStage,
} from "./deadlines";
import { recordModerationEvent } from "./record";

// ── Who acts ────────────────────────────────────────────────────────────────

/**
 * A StoreMink operator as the console resolves one (the shape of
 * `PlatformViewer` in app/actions/platform.ts, kept here so lib code never
 * imports an action file). The email is what the record and the `*_by`
 * columns carry.
 */
export interface ModerationOperator {
  email: string;
  role: "superadmin" | "member";
}

function actorOf(operator: ModerationOperator): string {
  const email = (operator?.email ?? "").trim();
  if (!email) throw new Error("A moderation action needs an operator email.");
  return email;
}

// ── Limits and sentences ────────────────────────────────────────────────────

/** What a complaint may hold (the table's CHECKs, design 6.3). */
export const COMPLAINT_LIMITS = {
  name: 200,
  contact: 320,
  actingFor: 200,
  authorityRef: 500,
  storeLabel: 300,
  urls: 50,
  urlLength: 2000,
  summary: 4000,
  outcomeNote: 4000,
  note: 2000,
} as const;

/** Every sentence these functions answer with (design 6.3 and 6.4, and the added ones). */
export const COMPLAINT_ERRORS = {
  receivedMissing: "Enter when it reached us.",
  receivedFuture: "That time is in the future.",
  receivedTooOld: "That is more than a year ago. Check the date.",
  receivedAfterLogged:
    "That is after the complaint was logged. Check the time.",
  receivedLocked:
    "The time it reached us can't be changed after it is acknowledged.",
  channel: "Choose how it reached us.",
  kind: "Choose what kind of complaint this is.",
  nameLong: "Keep the name under 200 characters.",
  contactLong: "Keep it under 320 characters.",
  actingForLong: "Keep it under 200 characters.",
  authorityRefLong: "Keep it under 500 characters.",
  urlsTooMany: "Up to 50 addresses.",
  urlTooLong: "Keep each address under 2,000 characters.",
  summaryMissing: "Write what they ask for.",
  summaryLong: "Keep it under 4,000 characters.",
  storeNotFound: "We could not find that store.",
  logFailed: "Could not log the complaint. Please try again.",
  notFound: "We could not find that complaint.",
  erased:
    "The complainant's details were erased, so this complaint can't be changed.",
  noEmail: "There is no email address to send it to.",
  alreadyAcknowledged: "It is already acknowledged.",
  emailFailed:
    "The email could not be sent. If you replied from the mailbox, use Mark as acknowledged.",
  noteMissing: "Write a note first.",
  noteLong: "Keep it under 2,000 characters.",
  outcome: "Choose an outcome.",
  outcomeNoteMissing: "Write a note for this outcome.",
  outcomeNoteLong: "Keep it under 4,000 characters.",
  alreadyResolved: "This complaint is already resolved.",
  notResolved: "This complaint is not resolved.",
  alreadyActioned: "This complaint has already been acted on.",
  saveFailed: "Could not save the change. Please try again.",
} as const;

/** The outcomes that need a note (design 6.4: the complainant can appeal). */
export const OUTCOMES_NEEDING_NOTE: readonly ComplaintOutcome[] = [
  "not_removed",
  "partly_removed",
];

// ── Shapes ──────────────────────────────────────────────────────────────────

export type ComplaintRow = typeof grievanceComplaints.$inferSelect;

/** A field of the log form, for pointing an error at it. */
export type ComplaintField =
  | "receivedAt"
  | "channel"
  | "kind"
  | "complainantName"
  | "complainantContact"
  | "actingFor"
  | "authorityRef"
  | "storeId"
  | "urls"
  | "summary"
  | "note"
  | "outcome";

export type ComplaintFailure = {
  ok: false;
  error: string;
  field?: ComplaintField;
};

/** What the log form sends. Text fields may be absent (empty). */
export type ComplaintInput = {
  receivedAt: Date | string | null | undefined;
  channel: string;
  kind: string;
  complainantName?: string | null;
  complainantContact?: string | null;
  actingFor?: string | null;
  authorityRef?: string | null;
  /** The store concerned, or empty for a complaint about StoreMink itself. */
  storeId?: string | null;
  /** One address per entry, or the form's text with one per line. */
  urls?: readonly string[] | string | null;
  summary: string;
};

/** A complaint that passed every check, ready to store. */
export type ValidComplaint = {
  receivedAt: Date;
  channel: ComplaintChannel;
  kind: ComplaintKind;
  complainantName: string;
  complainantContact: string;
  actingFor: string;
  authorityRef: string;
  storeId: string | null;
  urls: string[];
  summary: string;
};

/** A change to a logged complaint; absent fields stay as they are. */
export type ComplaintPatch = Partial<
  Omit<ComplaintInput, "receivedAt" | "channel" | "kind" | "summary">
> & {
  receivedAt?: Date | string | null;
  channel?: string;
  kind?: string;
  summary?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function fail(error: string, field?: ComplaintField): ComplaintFailure {
  return field ? { ok: false, error, field } : { ok: false, error };
}

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function oneYearBefore(date: Date): Date {
  const back = new Date(date.getTime());
  back.setUTCFullYear(back.getUTCFullYear() - 1);
  return back;
}

/** Whether a contact is an email address the acknowledgement can go to. */
export function isEmailContact(contact: string | null | undefined): boolean {
  return EMAIL.test(text(contact));
}

/** The store as the complaints and holds record it: "Crumb & Co (crumb.storemink.com)". */
export function storeLabelFor(store: { name: string; slug: string }): string {
  const name = (store.name ?? "").trim() || store.slug;
  return `${name} (${store.slug}.${ROOT_DOMAIN})`.slice(
    0,
    COMPLAINT_LIMITS.storeLabel,
  );
}

function urlList(value: ComplaintInput["urls"]): string[] {
  const parts =
    typeof value === "string"
      ? value.split(/\r?\n/)
      : Array.isArray(value)
        ? value
        : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const url = typeof part === "string" ? part.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function checkReceivedNow(
  received: Date | null,
  now: Date,
): ComplaintFailure | null {
  if (!received) return fail(COMPLAINT_ERRORS.receivedMissing, "receivedAt");
  if (received.getTime() > now.getTime() + FIVE_MINUTES_MS) {
    return fail(COMPLAINT_ERRORS.receivedFuture, "receivedAt");
  }
  if (received.getTime() <= oneYearBefore(now).getTime()) {
    return fail(COMPLAINT_ERRORS.receivedTooOld, "receivedAt");
  }
  return null;
}

type TextChecks = {
  complainantName: string;
  complainantContact: string;
  actingFor: string;
  authorityRef: string;
};

function checkTexts(values: Partial<TextChecks>): ComplaintFailure | null {
  if (
    values.complainantName !== undefined &&
    values.complainantName.length > COMPLAINT_LIMITS.name
  ) {
    return fail(COMPLAINT_ERRORS.nameLong, "complainantName");
  }
  if (
    values.complainantContact !== undefined &&
    values.complainantContact.length > COMPLAINT_LIMITS.contact
  ) {
    return fail(COMPLAINT_ERRORS.contactLong, "complainantContact");
  }
  if (
    values.actingFor !== undefined &&
    values.actingFor.length > COMPLAINT_LIMITS.actingFor
  ) {
    return fail(COMPLAINT_ERRORS.actingForLong, "actingFor");
  }
  if (
    values.authorityRef !== undefined &&
    values.authorityRef.length > COMPLAINT_LIMITS.authorityRef
  ) {
    return fail(COMPLAINT_ERRORS.authorityRefLong, "authorityRef");
  }
  return null;
}

function checkUrls(urls: string[]): ComplaintFailure | null {
  if (urls.length > COMPLAINT_LIMITS.urls) {
    return fail(COMPLAINT_ERRORS.urlsTooMany, "urls");
  }
  if (urls.some((url) => url.length > COMPLAINT_LIMITS.urlLength)) {
    return fail(COMPLAINT_ERRORS.urlTooLong, "urls");
  }
  return null;
}

function checkSummary(summary: string): ComplaintFailure | null {
  if (!summary) return fail(COMPLAINT_ERRORS.summaryMissing, "summary");
  if (summary.length > COMPLAINT_LIMITS.summary) {
    return fail(COMPLAINT_ERRORS.summaryLong, "summary");
  }
  return null;
}

/**
 * The log form's checks, in the order the form shows its fields. PURE: `now`
 * is the caller's clock. The store is only checked for shape here; whether it
 * exists is read when the complaint is stored.
 */
export function validateComplaintInput(
  input: ComplaintInput,
  now: Date,
): { ok: true; value: ValidComplaint } | ComplaintFailure {
  const received = toDate(input.receivedAt);
  const receivedError = checkReceivedNow(received, now);
  if (receivedError) return receivedError;
  if (!isOneOf(COMPLAINT_CHANNELS, input.channel)) {
    return fail(COMPLAINT_ERRORS.channel, "channel");
  }
  if (!isOneOf(COMPLAINT_KINDS, input.kind)) {
    return fail(COMPLAINT_ERRORS.kind, "kind");
  }
  const texts: TextChecks = {
    complainantName: text(input.complainantName),
    complainantContact: text(input.complainantContact),
    actingFor: text(input.actingFor),
    authorityRef: text(input.authorityRef),
  };
  const textError = checkTexts(texts);
  if (textError) return textError;
  const storeId = text(input.storeId) || null;
  if (storeId && !UUID.test(storeId)) {
    return fail(COMPLAINT_ERRORS.storeNotFound, "storeId");
  }
  const urls = urlList(input.urls);
  const urlError = checkUrls(urls);
  if (urlError) return urlError;
  const summary = text(input.summary);
  const summaryError = checkSummary(summary);
  if (summaryError) return summaryError;
  return {
    ok: true,
    value: {
      receivedAt: received as Date,
      channel: input.channel as ComplaintChannel,
      kind: input.kind as ComplaintKind,
      ...texts,
      storeId,
      urls,
      summary,
    },
  };
}

async function readStoreLabel(db: Db, storeId: string): Promise<string | null> {
  const rows = await db
    .select({ name: stores.name, slug: stores.slug })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  return rows[0] ? storeLabelFor(rows[0]) : null;
}

function isoDeadlines(deadlines: ComplaintDeadlines) {
  return {
    acknowledgeDueAt: deadlines.acknowledgeDueAt.toISOString(),
    actionDueAt: deadlines.actionDueAt.toISOString(),
    resolveDueAt: deadlines.resolveDueAt.toISOString(),
  };
}

function receivedCheckError(
  err: unknown,
  received: Date,
  now: Date,
): ComplaintFailure | null {
  if (pgConstraint(err) !== "grievance_complaints_received_check") return null;
  return received.getTime() > now.getTime()
    ? fail(COMPLAINT_ERRORS.receivedFuture, "receivedAt")
    : fail(COMPLAINT_ERRORS.receivedTooOld, "receivedAt");
}

// ── Log ─────────────────────────────────────────────────────────────────────

export type LogComplaintResult =
  | {
      ok: true;
      complaint: ComplaintRow;
      /** A court, government, information or intimate-image complaint: every operator hears now (design 3.9). */
      urgent: boolean;
    }
  | ComplaintFailure;

/**
 * Log a complaint with the deadlines its kind gives from the time it reached
 * StoreMink, and record `complaint_logged`. The urgent alert of design 3.9 is
 * the caller's (`notifyComplaintUrgent` in notify.ts, after this commits).
 */
export async function logComplaint(
  input: ComplaintInput,
  operator: ModerationOperator,
  options: { now?: Date } = {},
): Promise<LogComplaintResult> {
  const now = options.now ?? new Date();
  const actor = actorOf(operator);
  const checked = validateComplaintInput(input, now);
  if (!checked.ok) return checked;
  const value = checked.value;
  const deadlines = computeDeadlines(value.kind, value.receivedAt);
  try {
    return await withService(async (db): Promise<LogComplaintResult> => {
      let storeLabel = "";
      if (value.storeId) {
        const label = await readStoreLabel(db, value.storeId);
        if (label === null) {
          return fail(COMPLAINT_ERRORS.storeNotFound, "storeId");
        }
        storeLabel = label;
      }
      const [row] = await db
        .insert(grievanceComplaints)
        .values({
          receivedAt: value.receivedAt.toISOString(),
          channel: value.channel,
          kind: value.kind,
          complainantName: value.complainantName,
          complainantContact: value.complainantContact,
          actingFor: value.actingFor,
          authorityRef: value.authorityRef,
          storeId: value.storeId,
          storeLabel,
          urls: value.urls,
          summary: value.summary,
          ...isoDeadlines(deadlines),
          createdBy: actor,
        })
        .returning();
      if (!row) throw new Error("logComplaint: the insert returned no row.");
      await recordModerationEvent(db, {
        actor,
        action: "complaint_logged",
        complaintId: row.id,
        storeId: row.storeId,
        detail: { kind: row.kind, channel: row.channel },
      });
      return {
        ok: true,
        complaint: row,
        urgent: isUrgentComplaintKind(value.kind),
      };
    });
  } catch (err) {
    const mapped = receivedCheckError(err, value.receivedAt, now);
    if (mapped) return mapped;
    logError("moderation.complaints: log failed", loggableError(err), {
      kind: value.kind,
    });
    return fail(COMPLAINT_ERRORS.logFailed);
  }
}

// ── Update ──────────────────────────────────────────────────────────────────

const STAGES: DeadlineStage[] = ["acknowledge", "act", "resolve"];

function deadlineOf(deadlines: ComplaintDeadlines, stage: DeadlineStage): Date {
  if (stage === "acknowledge") return deadlines.acknowledgeDueAt;
  return stage === "act" ? deadlines.actionDueAt : deadlines.resolveDueAt;
}

function storedDeadlines(row: ComplaintRow): ComplaintDeadlines {
  return {
    acknowledgeDueAt: new Date(row.acknowledgeDueAt),
    actionDueAt: new Date(row.actionDueAt),
    resolveDueAt: new Date(row.resolveDueAt),
  };
}

function shifted(deadlines: ComplaintDeadlines, byMs: number) {
  return {
    acknowledgeDueAt: new Date(deadlines.acknowledgeDueAt.getTime() + byMs),
    actionDueAt: new Date(deadlines.actionDueAt.getTime() + byMs),
    resolveDueAt: new Date(deadlines.resolveDueAt.getTime() + byMs),
  };
}

/**
 * The deadlines after a change of kind or received time (design 3.9). A
 * corrected received time moves every stored deadline by the same amount
 * (the clock started then); then each takes the earlier of that and the
 * (new) kind's own deadline from the received time. So a stricter kind
 * always takes effect, a looser kind never moves a deadline later, and a
 * tightening made earlier survives a correction of the received time.
 */
export function deadlinesAfterChange(input: {
  stored: ComplaintDeadlines;
  storedReceivedAt: Date | string;
  kind: ComplaintKind;
  receivedAt: Date | string;
}): ComplaintDeadlines {
  const before = new Date(input.storedReceivedAt).getTime();
  const after = new Date(input.receivedAt).getTime();
  const base =
    after === before ? input.stored : shifted(input.stored, after - before);
  return tightenDeadlines(base, input.kind, input.receivedAt);
}

/**
 * The `alerts` after a stage's deadline moved: its "soon" alert was about the
 * old time, so it may ring again; its "overdue" alert stays while the new
 * deadline has passed too, and is cleared only when it is in the future again.
 * The follow-up (T14a) then sends what is due on its next run, at once for a
 * deadline already past (design 3.9).
 */
export function alertsAfterChange(
  alerts: unknown,
  changed: { stage: DeadlineStage; dueAt: Date }[],
  now: Date,
): Record<string, unknown> {
  const next: Record<string, unknown> =
    alerts && typeof alerts === "object" && !Array.isArray(alerts)
      ? { ...(alerts as Record<string, unknown>) }
      : {};
  for (const { stage, dueAt } of changed) {
    delete next[alertKey(stage, "soon")];
    if (dueAt.getTime() > now.getTime())
      delete next[alertKey(stage, "overdue")];
  }
  return next;
}

function stageMet(row: ComplaintRow, stage: DeadlineStage): boolean {
  if (row.resolvedAt) return true;
  if (stage === "acknowledge") return row.acknowledgedAt !== null;
  if (stage === "act") return row.actionedAt !== null;
  return false;
}

export type UpdateComplaintResult =
  | {
      ok: true;
      complaint: ComplaintRow;
      /** The fields that changed (names only). */
      changed: string[];
      /** Open deadlines the change moved into the past ("act now"). */
      passed: DeadlineStage[];
    }
  | ComplaintFailure;

/**
 * Change a logged complaint (design 5.4): the kind at any time (deadlines
 * tighten, never loosen), the received time only before acknowledgement, and
 * the other details while they are not erased. Records `complaint_updated`
 * with the names of the changed fields and, when they changed, the old and
 * new kind, received time and deadlines.
 */
export async function updateComplaint(
  complaintId: string,
  patch: ComplaintPatch,
  operator: ModerationOperator,
  options: { now?: Date } = {},
): Promise<UpdateComplaintResult> {
  const now = options.now ?? new Date();
  const actor = actorOf(operator);
  if (!UUID.test(complaintId ?? "")) return fail(COMPLAINT_ERRORS.notFound);

  // The shape checks need no row.
  if (
    patch.channel !== undefined &&
    !isOneOf(COMPLAINT_CHANNELS, patch.channel)
  ) {
    return fail(COMPLAINT_ERRORS.channel, "channel");
  }
  if (patch.kind !== undefined && !isOneOf(COMPLAINT_KINDS, patch.kind)) {
    return fail(COMPLAINT_ERRORS.kind, "kind");
  }
  const texts: Partial<TextChecks> = {};
  if (patch.complainantName !== undefined)
    texts.complainantName = text(patch.complainantName);
  if (patch.complainantContact !== undefined)
    texts.complainantContact = text(patch.complainantContact);
  if (patch.actingFor !== undefined) texts.actingFor = text(patch.actingFor);
  if (patch.authorityRef !== undefined)
    texts.authorityRef = text(patch.authorityRef);
  const textError = checkTexts(texts);
  if (textError) return textError;
  const urls = patch.urls !== undefined ? urlList(patch.urls) : undefined;
  if (urls) {
    const urlError = checkUrls(urls);
    if (urlError) return urlError;
  }
  const summary = patch.summary !== undefined ? text(patch.summary) : undefined;
  if (summary !== undefined) {
    const summaryError = checkSummary(summary);
    if (summaryError) return summaryError;
  }
  const storeId =
    patch.storeId !== undefined ? text(patch.storeId) || null : undefined;
  if (storeId && !UUID.test(storeId)) {
    return fail(COMPLAINT_ERRORS.storeNotFound, "storeId");
  }
  let received: Date | undefined;
  if (patch.receivedAt !== undefined) {
    const parsed = toDate(patch.receivedAt);
    const receivedError = checkReceivedNow(parsed, now);
    if (receivedError) return receivedError;
    received = parsed as Date;
  }

  try {
    return await withService(async (db): Promise<UpdateComplaintResult> => {
      const [row] = await db
        .select()
        .from(grievanceComplaints)
        .where(eq(grievanceComplaints.id, complaintId))
        .limit(1)
        .for("update");
      if (!row) return fail(COMPLAINT_ERRORS.notFound);
      if (row.erasedAt) return fail(COMPLAINT_ERRORS.erased);

      const set: Partial<typeof grievanceComplaints.$inferInsert> = {};
      const changed: string[] = [];
      const detail: Record<string, unknown> = {};

      const storedReceived = new Date(row.receivedAt);
      let newReceived = storedReceived;
      if (received && received.getTime() !== storedReceived.getTime()) {
        if (row.acknowledgedAt) {
          return fail(COMPLAINT_ERRORS.receivedLocked, "receivedAt");
        }
        const logged = new Date(row.createdAt);
        if (received.getTime() > logged.getTime() + FIVE_MINUTES_MS) {
          return fail(COMPLAINT_ERRORS.receivedAfterLogged, "receivedAt");
        }
        if (received.getTime() <= oneYearBefore(logged).getTime()) {
          return fail(COMPLAINT_ERRORS.receivedTooOld, "receivedAt");
        }
        newReceived = received;
        set.receivedAt = received.toISOString();
        changed.push("receivedAt");
        detail.receivedAt = {
          from: storedReceived.toISOString(),
          to: received.toISOString(),
        };
      }

      const storedKind = row.kind as ComplaintKind;
      const newKind = (patch.kind as ComplaintKind | undefined) ?? storedKind;
      if (newKind !== storedKind) {
        set.kind = newKind;
        changed.push("kind");
        detail.kind = { from: storedKind, to: newKind };
      }

      if (patch.channel !== undefined && patch.channel !== row.channel) {
        set.channel = patch.channel;
        changed.push("channel");
      }
      for (const key of [
        "complainantName",
        "complainantContact",
        "actingFor",
        "authorityRef",
      ] as const) {
        const value = texts[key];
        if (value !== undefined && value !== row[key]) {
          set[key] = value;
          changed.push(key);
        }
      }
      if (summary !== undefined && summary !== row.summary) {
        set.summary = summary;
        changed.push("summary");
      }
      if (urls && JSON.stringify(urls) !== JSON.stringify(row.urls ?? [])) {
        set.urls = urls;
        changed.push("urls");
      }
      if (storeId !== undefined && storeId !== row.storeId) {
        if (storeId) {
          const label = await readStoreLabel(db, storeId);
          if (label === null) {
            return fail(COMPLAINT_ERRORS.storeNotFound, "storeId");
          }
          set.storeLabel = label;
        } else {
          set.storeLabel = "";
        }
        set.storeId = storeId;
        changed.push("storeId");
      }

      const passed: DeadlineStage[] = [];
      if (set.kind !== undefined || set.receivedAt !== undefined) {
        const stored = storedDeadlines(row);
        const next = deadlinesAfterChange({
          stored,
          storedReceivedAt: storedReceived,
          kind: newKind,
          receivedAt: newReceived,
        });
        const moved = STAGES.filter(
          (stage) =>
            deadlineOf(next, stage).getTime() !==
            deadlineOf(stored, stage).getTime(),
        ).map((stage) => ({ stage, dueAt: deadlineOf(next, stage) }));
        if (moved.length > 0) {
          Object.assign(set, isoDeadlines(next));
          set.alerts = alertsAfterChange(row.alerts, moved, now);
          changed.push("deadlines");
          detail.deadlines = {
            from: isoDeadlines(stored),
            to: isoDeadlines(next),
          };
          const shown = deadlineStages(newKind);
          for (const { stage, dueAt } of moved) {
            if (
              shown.includes(stage) &&
              !stageMet(row, stage) &&
              dueAt.getTime() <= now.getTime()
            ) {
              passed.push(stage);
            }
          }
        }
      }

      if (changed.length === 0) {
        return { ok: true, complaint: row, changed, passed };
      }
      const [updated] = await db
        .update(grievanceComplaints)
        .set({ ...set, updatedAt: sql`now()` })
        .where(eq(grievanceComplaints.id, row.id))
        .returning();
      if (!updated)
        throw new Error("updateComplaint: the update returned no row.");
      await recordModerationEvent(db, {
        actor,
        action: "complaint_updated",
        complaintId: row.id,
        storeId: updated.storeId,
        detail: { fields: changed, ...detail },
      });
      return { ok: true, complaint: updated, changed, passed };
    });
  } catch (err) {
    if (received) {
      const mapped = receivedCheckError(err, received, now);
      if (mapped) return mapped;
    }
    logError("moderation.complaints: update failed", loggableError(err), {
      complaintId,
    });
    return fail(COMPLAINT_ERRORS.saveFailed);
  }
}

// ── Acknowledge ─────────────────────────────────────────────────────────────

/**
 * Sends the acknowledgement (design 7.6; `acknowledgeComplainant` in
 * notify.ts). Called with no transaction open; answers whether it went.
 */
export type AcknowledgementSender = (args: {
  complaint: ComplaintRow;
  to: string;
}) => Promise<{ sent: boolean; error?: string }>;

export type AcknowledgeResult =
  | { ok: true; complaint: ComplaintRow; emailed: boolean }
  | ComplaintFailure;

async function readComplaint(
  complaintId: string,
): Promise<ComplaintRow | null> {
  const rows = await withService((db) =>
    db
      .select()
      .from(grievanceComplaints)
      .where(eq(grievanceComplaints.id, complaintId))
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Acknowledge a complaint (design 3.9 and 6.4). With `deliver` (Send
 * acknowledgement), the email goes first and the complaint is marked
 * acknowledged only when it was sent; without it (Mark as acknowledged, a
 * reply from the support mailbox), it is marked at once. Records
 * `complaint_acknowledged` with whether it was emailed.
 */
export async function acknowledgeComplaint(
  complaintId: string,
  operator: ModerationOperator,
  options: { deliver?: AcknowledgementSender } = {},
): Promise<AcknowledgeResult> {
  const actor = actorOf(operator);
  if (!UUID.test(complaintId ?? "")) return fail(COMPLAINT_ERRORS.notFound);
  const emailed = typeof options.deliver === "function";
  try {
    if (emailed) {
      const row = await readComplaint(complaintId);
      if (!row) return fail(COMPLAINT_ERRORS.notFound);
      if (row.erasedAt) return fail(COMPLAINT_ERRORS.erased);
      if (row.acknowledgedAt) return fail(COMPLAINT_ERRORS.alreadyAcknowledged);
      const to = text(row.complainantContact);
      if (!isEmailContact(to)) return fail(COMPLAINT_ERRORS.noEmail);
      let sent = false;
      try {
        sent = (await options.deliver!({ complaint: row, to })).sent === true;
      } catch (err) {
        logError(
          "moderation.complaints: acknowledgement email threw",
          loggableError(err),
          {
            complaintId,
          },
        );
      }
      if (!sent) return fail(COMPLAINT_ERRORS.emailFailed);
    }
    return await withService(async (db): Promise<AcknowledgeResult> => {
      const [updated] = await db
        .update(grievanceComplaints)
        .set({
          acknowledgedAt: sql`now()`,
          acknowledgedBy: actor,
          acknowledgementEmailed: emailed,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(grievanceComplaints.id, complaintId),
            isNull(grievanceComplaints.acknowledgedAt),
            isNull(grievanceComplaints.erasedAt),
          ),
        )
        .returning();
      if (!updated) {
        const [row] = await db
          .select({
            acknowledgedAt: grievanceComplaints.acknowledgedAt,
            erasedAt: grievanceComplaints.erasedAt,
          })
          .from(grievanceComplaints)
          .where(eq(grievanceComplaints.id, complaintId))
          .limit(1);
        if (!row) return fail(COMPLAINT_ERRORS.notFound);
        if (row.erasedAt) return fail(COMPLAINT_ERRORS.erased);
        return fail(COMPLAINT_ERRORS.alreadyAcknowledged);
      }
      await recordModerationEvent(db, {
        actor,
        action: "complaint_acknowledged",
        complaintId,
        storeId: updated.storeId,
        detail: { emailed },
      });
      return { ok: true, complaint: updated, emailed };
    });
  } catch (err) {
    logError("moderation.complaints: acknowledge failed", loggableError(err), {
      complaintId,
    });
    return fail(COMPLAINT_ERRORS.saveFailed);
  }
}

// ── Act ─────────────────────────────────────────────────────────────────────

function checkNote(
  note: string | null | undefined,
): ComplaintFailure | { ok: true; note: string } {
  const value = text(note);
  if (!value) return fail(COMPLAINT_ERRORS.noteMissing, "note");
  if (value.length > COMPLAINT_LIMITS.note) {
    return fail(COMPLAINT_ERRORS.noteLong, "note");
  }
  return { ok: true, note: value };
}

/** How a complaint was acted on without a block, by its kind (design 6.4). */
export function actionVia(
  kind: ComplaintKind,
): "information_provided" | "answered" | "no_removal" {
  if (kind === "information_order") return "information_provided";
  if (kind === "data_request") return "answered";
  return "no_removal";
}

export type ComplaintStepResult =
  | { ok: true; complaint: ComplaintRow }
  | ComplaintFailure;

/**
 * "No removal needed" or "Information provided" (design 6.4): sets actioned
 * with the operator, and records `complaint_actioned` with the operator's
 * note (its only home: the table has no column for it) and how it was met.
 */
export async function markActioned(
  complaintId: string,
  note: string,
  operator: ModerationOperator,
): Promise<ComplaintStepResult> {
  const actor = actorOf(operator);
  if (!UUID.test(complaintId ?? "")) return fail(COMPLAINT_ERRORS.notFound);
  const checked = checkNote(note);
  if (!checked.ok) return checked;
  try {
    return await withService(async (db): Promise<ComplaintStepResult> => {
      const [row] = await db
        .select()
        .from(grievanceComplaints)
        .where(eq(grievanceComplaints.id, complaintId))
        .limit(1)
        .for("update");
      if (!row) return fail(COMPLAINT_ERRORS.notFound);
      if (row.erasedAt) return fail(COMPLAINT_ERRORS.erased);
      if (row.resolvedAt) return fail(COMPLAINT_ERRORS.alreadyResolved);
      if (row.actionedAt) return fail(COMPLAINT_ERRORS.alreadyActioned);
      const [updated] = await db
        .update(grievanceComplaints)
        .set({
          actionedAt: sql`now()`,
          actionedBy: actor,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(grievanceComplaints.id, complaintId),
            isNull(grievanceComplaints.actionedAt),
          ),
        )
        .returning();
      if (!updated) return fail(COMPLAINT_ERRORS.alreadyActioned);
      await recordModerationEvent(db, {
        actor,
        action: "complaint_actioned",
        complaintId,
        storeId: updated.storeId,
        detail: {
          via: actionVia(updated.kind as ComplaintKind),
          note: checked.note,
        },
      });
      return { ok: true, complaint: updated };
    });
  } catch (err) {
    logError(
      "moderation.complaints: mark actioned failed",
      loggableError(err),
      {
        complaintId,
      },
    );
    return fail(COMPLAINT_ERRORS.saveFailed);
  }
}

/**
 * The first block linked to a complaint acts on it (design 3.9). Runs on the
 * caller's transaction (the block's own, T12), so the complaint and the block
 * commit together; sets actioned only when it was not, and records
 * `complaint_actioned` naming the block. Answers whether it set it.
 */
export async function actionComplaintForBlock(
  db: Db,
  input: {
    complaintId: string;
    actor: string;
    blockId: string;
    storeId?: string | null;
  },
): Promise<boolean> {
  const actor = (input.actor ?? "").trim();
  if (!actor) throw new Error("actionComplaintForBlock needs an actor.");
  const rows = await db
    .update(grievanceComplaints)
    .set({
      actionedAt: sql`now()`,
      actionedBy: actor,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(grievanceComplaints.id, input.complaintId),
        isNull(grievanceComplaints.actionedAt),
      ),
    )
    .returning({
      id: grievanceComplaints.id,
      storeId: grievanceComplaints.storeId,
    });
  const row = rows[0];
  if (!row) return false;
  await recordModerationEvent(db, {
    actor,
    action: "complaint_actioned",
    complaintId: row.id,
    blockId: input.blockId,
    storeId: input.storeId ?? row.storeId,
    detail: { via: "block" },
  });
  return true;
}

// ── Resolve and reopen ──────────────────────────────────────────────────────

/** Emails the outcome (design 7.6; `tellComplainantOutcome` in notify.ts). */
export type OutcomeSender = (args: {
  complaint: ComplaintRow;
  to: string;
  outcome: ComplaintOutcome;
  note: string;
}) => Promise<{ sent: boolean; error?: string }>;

export type ResolveResult =
  | { ok: true; complaint: ComplaintRow; emailed: boolean | null }
  | ComplaintFailure;

/**
 * Resolve a complaint with an outcome and a note (required for "Not removed"
 * and "Partly removed"), optionally emailing the outcome to the complainant
 * first. The email never blocks the resolution: `emailed` is false when it
 * failed and null when none was asked for. Records `complaint_resolved`.
 */
export async function resolveComplaint(
  complaintId: string,
  input: { outcome: string; note?: string | null; deliver?: OutcomeSender },
  operator: ModerationOperator,
): Promise<ResolveResult> {
  const actor = actorOf(operator);
  if (!UUID.test(complaintId ?? "")) return fail(COMPLAINT_ERRORS.notFound);
  if (!isOneOf(COMPLAINT_OUTCOMES, input.outcome)) {
    return fail(COMPLAINT_ERRORS.outcome, "outcome");
  }
  const outcome = input.outcome as ComplaintOutcome;
  const note = text(input.note);
  if (!note && OUTCOMES_NEEDING_NOTE.includes(outcome)) {
    return fail(COMPLAINT_ERRORS.outcomeNoteMissing, "note");
  }
  if (note.length > COMPLAINT_LIMITS.outcomeNote) {
    return fail(COMPLAINT_ERRORS.outcomeNoteLong, "note");
  }
  try {
    let emailed: boolean | null = null;
    if (typeof input.deliver === "function") {
      const row = await readComplaint(complaintId);
      if (!row) return fail(COMPLAINT_ERRORS.notFound);
      if (row.erasedAt) return fail(COMPLAINT_ERRORS.erased);
      if (row.resolvedAt) return fail(COMPLAINT_ERRORS.alreadyResolved);
      const to = text(row.complainantContact);
      if (!isEmailContact(to)) return fail(COMPLAINT_ERRORS.noEmail);
      emailed = false;
      try {
        emailed =
          (await input.deliver({ complaint: row, to, outcome, note })).sent ===
          true;
      } catch (err) {
        logError(
          "moderation.complaints: outcome email threw",
          loggableError(err),
          {
            complaintId,
          },
        );
      }
    }
    return await withService(async (db): Promise<ResolveResult> => {
      const [updated] = await db
        .update(grievanceComplaints)
        .set({
          resolvedAt: sql`now()`,
          resolvedBy: actor,
          outcome,
          outcomeNote: note,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(grievanceComplaints.id, complaintId),
            isNull(grievanceComplaints.resolvedAt),
            isNull(grievanceComplaints.erasedAt),
          ),
        )
        .returning();
      if (!updated) {
        const [row] = await db
          .select({ resolvedAt: grievanceComplaints.resolvedAt })
          .from(grievanceComplaints)
          .where(eq(grievanceComplaints.id, complaintId))
          .limit(1);
        return fail(
          row ? COMPLAINT_ERRORS.alreadyResolved : COMPLAINT_ERRORS.notFound,
        );
      }
      await recordModerationEvent(db, {
        actor,
        action: "complaint_resolved",
        complaintId,
        storeId: updated.storeId,
        detail: { outcome, emailed },
      });
      return { ok: true, complaint: updated, emailed };
    });
  } catch (err) {
    logError("moderation.complaints: resolve failed", loggableError(err), {
      complaintId,
    });
    return fail(COMPLAINT_ERRORS.saveFailed);
  }
}

/**
 * Reopen a resolved complaint (design 3.9: "Reopening clears resolved and
 * keeps the history"). The outcome note stays on the row as the last
 * outcome's words until the next resolution replaces it; the reopening note
 * and the previous outcome go in `complaint_reopened`.
 */
export async function reopenComplaint(
  complaintId: string,
  note: string,
  operator: ModerationOperator,
): Promise<ComplaintStepResult> {
  const actor = actorOf(operator);
  if (!UUID.test(complaintId ?? "")) return fail(COMPLAINT_ERRORS.notFound);
  const checked = checkNote(note);
  if (!checked.ok) return checked;
  try {
    return await withService(async (db): Promise<ComplaintStepResult> => {
      const [row] = await db
        .select()
        .from(grievanceComplaints)
        .where(eq(grievanceComplaints.id, complaintId))
        .limit(1)
        .for("update");
      if (!row) return fail(COMPLAINT_ERRORS.notFound);
      if (row.erasedAt) return fail(COMPLAINT_ERRORS.erased);
      if (!row.resolvedAt) return fail(COMPLAINT_ERRORS.notResolved);
      const [updated] = await db
        .update(grievanceComplaints)
        .set({
          resolvedAt: null,
          resolvedBy: null,
          outcome: null,
          updatedAt: sql`now()`,
        })
        .where(eq(grievanceComplaints.id, complaintId))
        .returning();
      if (!updated)
        throw new Error("reopenComplaint: the update returned no row.");
      await recordModerationEvent(db, {
        actor,
        action: "complaint_reopened",
        complaintId,
        storeId: updated.storeId,
        detail: { previousOutcome: row.outcome, note: checked.note },
      });
      return { ok: true, complaint: updated };
    });
  } catch (err) {
    logError("moderation.complaints: reopen failed", loggableError(err), {
      complaintId,
    });
    return fail(COMPLAINT_ERRORS.saveFailed);
  }
}

// ── Erase ───────────────────────────────────────────────────────────────────

/** How many complaints one erasure batch takes at most. */
export const ERASE_BATCH_MAX = 500;

/**
 * Erase the complainants' details of complaints resolved before `floor`
 * (design 3.9: 3 years after resolution; the sweep, T14a, passes the floor).
 * Each row is emptied in ONE statement (name, contact, acting-for, reference,
 * addresses, summary and outcome note, with `erased_at`), which
 * `grievance_complaints_erased_check` holds all or nothing; the dates, kind,
 * outcome and links stay. Skipped, like every other retention step of the
 * design (decision D3): a complaint whose store is on hold, a complaint a hold
 * names, and a complaint with a block whose archive is held. Records
 * `complaint_erased` for each, in the same transaction. Answers how many were
 * erased; refuses a floor less than a year old, which can only be a mistake.
 */
export async function eraseResolvedComplaints(
  floor: Date | string,
  limit: number,
  options: { actor?: string; now?: Date } = {},
): Promise<number> {
  const floorDate = toDate(floor);
  if (!floorDate)
    throw new RangeError("eraseResolvedComplaints: the floor is not a time.");
  const now = options.now ?? new Date();
  if (floorDate.getTime() > oneYearBefore(now).getTime()) {
    throw new RangeError(
      "eraseResolvedComplaints: the floor must be at least a year ago.",
    );
  }
  const batch = Math.max(0, Math.min(ERASE_BATCH_MAX, Math.trunc(limit)));
  if (batch === 0) return 0;
  const actor = (options.actor ?? "system").trim() || "system";
  const erased = await withService(async (db) => {
    const result = await db.execute<{
      id: string;
      store_id: string | null;
    }>(sql`
      with due as (
        select c.id
        from grievance_complaints c
        where c.erased_at is null
          and c.resolved_at is not null
          and c.resolved_at < ${floorDate.toISOString()}::timestamptz
          and not exists (
            select 1 from store_legal_holds h
            where h.released_at is null
              and (h.store_id = c.store_id or h.complaint_id = c.id)
          )
          and not exists (
            select 1
            from content_blocks b
            join content_block_archives a on a.block_id = b.id
            where b.complaint_id = c.id and a.legal_hold
          )
        order by c.resolved_at, c.id
        limit ${batch}
        for update of c skip locked
      )
      update grievance_complaints g
      set complainant_name = '',
          complainant_contact = '',
          acting_for = '',
          authority_ref = '',
          summary = '',
          urls = '{}'::text[],
          outcome_note = '',
          erased_at = now(),
          updated_at = now()
      from due
      where g.id = due.id
      returning g.id, g.store_id
    `);
    for (const row of result.rows) {
      await recordModerationEvent(db, {
        actor,
        action: "complaint_erased",
        complaintId: row.id,
        storeId: row.store_id,
      });
    }
    return result.rows.length;
  });
  if (erased > 0) {
    logInfo("moderation.complaints: erased", { erased });
  }
  return erased;
}
