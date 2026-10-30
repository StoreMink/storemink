import "server-only";

/**
 * The archive after a block (takedown design 3.6, 5.4, 8.2, 9): who opens it,
 * how long it is kept, and the nightly purge.
 *
 * - `recordArchiveView` writes `archive_viewed` or `archive_downloaded` with
 *   the reason a superadmin typed, BEFORE anything of the copy is shown
 *   (decision D2). `getArchiveForViewing` (console-read.ts) reads the copy
 *   only against the receipt this returns, so nothing opens a copy unrecorded.
 * - `extendArchive` moves `keep_until` later, or sets a legal hold "until we
 *   release it", always with who asked; `releaseArchiveHold` ends the hold
 *   with a note. Superadmins only, each recorded. The database only ever lets
 *   `keep_until` grow (`content_block_archives_write_once`).
 * - `purgeDueArchives` is the retention sweep's entry (design 8.2, batch of
 *   at most 50): for each archive whose `keep_until` has passed, with no legal
 *   hold, no active store hold, its files copied and no restore running, it
 *   locks the row, empties it (snapshot and file list, `purged_at` set; the
 *   SHA-256 stays as proof of what was held), deletes its objects from the
 *   private bucket and commits only when every object is gone. Emptying the
 *   row first lets the database's own guard refuse a held or early purge
 *   before any object is touched; a failed delete rolls the row back for the
 *   next night. An archive whose objects name another database's folder
 *   (dev, staging and local share the private bucket) is never touched:
 *   `purgeArchiveFiles` (storage.ts) refuses the whole list, and the skip is
 *   recorded as `archive_purge_skipped`.
 *
 * Who may call these is the action layer's question (design 3.10); these
 * functions re-check the superadmin role themselves because an archived copy
 * is the most sensitive thing the console holds. Every write runs in ONE
 * `withService` transaction with its `moderation_events` row; scopes are
 * opened one after another, never one inside another.
 */

import { sql, type SQL } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { istShortDate } from "@/lib/billing/tax-copy";
import {
  ARCHIVE_ROOT,
  archivePathDatabase,
  archiveStoreContentPath,
  isThisDatabaseArchivePath,
} from "./archive-paths";
import {
  moderationStorage,
  parseArchivedFile,
  purgeArchiveFiles,
  type ArchiveObjectRef,
  type ArchivedFile,
  type ModerationStorage,
} from "./storage";
import { recordModerationEvent } from "./record";
import type { ModerationOperator } from "./complaints";

// ── Limits and sentences ────────────────────────────────────────────────────

/** What the archive dialogs may hold (design 6.6). */
export const ARCHIVE_LIMITS = {
  /** "Why are you opening it?" */
  reason: 500,
  /** "Who asked": the authority and its reference. */
  whoAsked: 500,
  /** The note that releases a hold. */
  note: 2000,
} as const;

/** The furthest "Keep longer" may set a date, so a mistyped year is caught. */
export const ARCHIVE_KEEP_MAX_YEARS = 20;

/**
 * How long a recorded opening lets `getArchiveForViewing` read the copy. The
 * console records and reads in one request; a later reading records again.
 */
export const ARCHIVE_VIEW_RECEIPT_MINUTES = 10;

/** The most archives one purge batch takes (design 8.2 asks for 20). */
export const ARCHIVE_PURGE_BATCH_MAX = 50;

/** No archive is started this close to the sweep's deadline. */
export const ARCHIVE_PURGE_RESERVE_MS = 5_000;

/** Every sentence the archive functions answer with (design 6.6, and the added ones). */
export const ARCHIVE_ERRORS = {
  viewSuperadminOnly: "Only a superadmin can open an archived copy.",
  keepSuperadminOnly: "Only a superadmin can keep a copy longer.",
  releaseSuperadminOnly: "Only a superadmin can release the hold on a copy.",
  reasonMissing: "Write why you are opening it.",
  reasonLong: "Keep it under 500 characters.",
  whoAskedMissing: "Write who asked.",
  whoAskedLong: "Keep it under 500 characters.",
  untilMissing: "Pick a date.",
  untilTooFar: "Pick a date within 20 years.",
  alreadyHeld: "This copy is already kept until released.",
  notHeld: "This copy is not on hold.",
  noteMissing: "Write a note first.",
  noteLong: "Keep the note under 2,000 characters.",
  notFound: "We could not find that copy.",
  purged: "The copy was already deleted.",
  fileNotFound: "We could not find that file in the copy.",
  saveFailed: "Could not save it. Please try again.",
} as const;

/** "Pick a date after 24 Apr 2027." (design 6.6), for a date that is not later. */
export function keepUntilTooEarly(keepUntil: Date | string): string {
  return `Pick a date after ${istShortDate(keepUntil)}.`;
}

export type ArchiveFailure = { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const YEAR_MS = 365.25 * DAY_MS;

function fail(error: string): ArchiveFailure {
  return { ok: false, error };
}

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function actorOf(operator: ModerationOperator): string {
  const email = (operator?.email ?? "").trim();
  if (!email) throw new Error("An archive action needs an operator email.");
  return email;
}

function isSuperadmin(operator: ModerationOperator | null | undefined) {
  return operator?.role === "superadmin";
}

/**
 * The time a "Keep longer" date means: a calendar date "YYYY-MM-DD" is kept
 * to the end of that day in India time (23:59:59 IST); a full ISO time or a
 * Date is taken as it is. Anything else is null.
 */
export function keepUntilFrom(
  value: Date | string | null | undefined,
): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = text(value);
  const match = DATE_ONLY.exec(raw);
  if (match) {
    const [, y, m, d] = match;
    const midnight = Date.UTC(Number(y), Number(m) - 1, Number(d));
    const check = new Date(midnight);
    if (
      check.getUTCFullYear() !== Number(y) ||
      check.getUTCMonth() !== Number(m) - 1 ||
      check.getUTCDate() !== Number(d)
    ) {
      return null;
    }
    return new Date(midnight - IST_OFFSET_MS + DAY_MS - 1000);
  }
  if (!ISO_TIME.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type Row = Record<string, unknown>;

function rowsOf(result: { rows: unknown[] }): Row[] {
  return result.rows as Row[];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ── Opening a copy ──────────────────────────────────────────────────────────

/** What is being opened: the whole copy on screen, the record, or one file by its number. */
export type ArchiveViewTarget = "copy" | "record" | { file: number };

export type RecordArchiveViewResult =
  | {
      ok: true;
      /** The receipt `getArchiveForViewing` asks for. */
      eventId: string;
      /** The file asked for, when one was (its `n`), read from the copy's list. */
      file: ArchivedFile | null;
      /**
       * Whether the file's archive object sits in this database's folder
       * (true when no file was asked for). Another environment's copy is
       * read-only evidence; purge and restore never touch it.
       */
      thisDatabase: boolean;
    }
  | ArchiveFailure;

/**
 * Record that a superadmin opens or downloads a block's archived copy, with
 * the reason they typed (design 3.6, 5.5; decision D2), and answer the
 * receipt the read needs. A file is named by its number in the copy (the
 * `<n>-` of its archive path) and must have been copied. Nothing of the copy
 * is returned here except, for a file, its entry (path, generation, type).
 */
export async function recordArchiveView(
  blockId: string,
  reason: string,
  operator: ModerationOperator,
  options: { download?: boolean; what?: ArchiveViewTarget } = {},
): Promise<RecordArchiveViewResult> {
  if (!isSuperadmin(operator)) return fail(ARCHIVE_ERRORS.viewSuperadminOnly);
  const actor = actorOf(operator);
  if (!UUID.test(blockId ?? "")) return fail(ARCHIVE_ERRORS.notFound);
  const why = text(reason);
  if (!why) return fail(ARCHIVE_ERRORS.reasonMissing);
  if (why.length > ARCHIVE_LIMITS.reason)
    return fail(ARCHIVE_ERRORS.reasonLong);
  const what = options.what ?? "copy";
  const fileNumber =
    typeof what === "object" && what !== null ? what.file : null;
  if (
    fileNumber !== null &&
    (!Number.isSafeInteger(fileNumber) || fileNumber < 0)
  ) {
    return fail(ARCHIVE_ERRORS.fileNotFound);
  }
  try {
    return await withService(async (db): Promise<RecordArchiveViewResult> => {
      const [archive] = rowsOf(
        await db.execute(sql`
          select a.id, a.purged_at, a.files,
                 coalesce(a.store_id, b.store_id) as store_id
            from public.content_block_archives a
            join public.content_blocks b on b.id = a.block_id
           where a.block_id = ${blockId}::uuid
           limit 1
        `),
      );
      if (!archive) return fail(ARCHIVE_ERRORS.notFound);
      if (archive.purged_at) return fail(ARCHIVE_ERRORS.purged);
      let file: ArchivedFile | null = null;
      if (fileNumber !== null) {
        const list = Array.isArray(archive.files) ? archive.files : [];
        file =
          list
            .map((entry) => parseArchivedFile(entry))
            .find(
              (entry): entry is ArchivedFile =>
                entry !== null &&
                entry.n === fileNumber &&
                entry.state === "copied" &&
                Boolean(entry.archivePath),
            ) ?? null;
        if (!file) return fail(ARCHIVE_ERRORS.fileNotFound);
      }
      const eventId = await recordModerationEvent(db, {
        actor,
        action: options.download ? "archive_downloaded" : "archive_viewed",
        blockId,
        storeId: str(archive.store_id),
        detail: {
          reason: why,
          what: fileNumber !== null ? "file" : what,
          ...(fileNumber !== null ? { file: fileNumber } : {}),
        },
      });
      return {
        ok: true,
        eventId,
        file,
        thisDatabase: file
          ? isThisDatabaseArchivePath(file.archivePath ?? "")
          : true,
      };
    });
  } catch (err) {
    logError("moderation.archive: view not recorded", loggableError(err), {
      blockId,
    });
    return fail(ARCHIVE_ERRORS.saveFailed);
  }
}

// ── Keeping a copy longer ───────────────────────────────────────────────────

/** "Until a date" or "Until we release it" (design 6.6 "Keep longer"). */
export type ArchiveKeepChange = { until: Date | string } | { hold: true };

export type ExtendArchiveResult =
  | { ok: true; keepUntil: string; legalHold: boolean }
  | ArchiveFailure;

/**
 * Keep a block's archived copy longer (design 3.6, 5.4; superadmin only):
 * to a later date, or under a legal hold until a superadmin releases it,
 * always with who asked. Records `archive_kept_longer` (with the old and new
 * dates) or `archive_hold_set`. The row is locked, so a purge running at the
 * same moment either finishes first (and this answers "already deleted") or
 * waits for this.
 */
export async function extendArchive(
  blockId: string,
  change: ArchiveKeepChange,
  whoAsked: string,
  operator: ModerationOperator,
  options: { now?: Date } = {},
): Promise<ExtendArchiveResult> {
  if (!isSuperadmin(operator)) return fail(ARCHIVE_ERRORS.keepSuperadminOnly);
  const actor = actorOf(operator);
  if (!UUID.test(blockId ?? "")) return fail(ARCHIVE_ERRORS.notFound);
  const asked = text(whoAsked);
  if (!asked) return fail(ARCHIVE_ERRORS.whoAskedMissing);
  if (asked.length > ARCHIVE_LIMITS.whoAsked) {
    return fail(ARCHIVE_ERRORS.whoAskedLong);
  }
  const hold = "hold" in (change ?? {}) && (change as { hold: true }).hold;
  let until: Date | null = null;
  if (!hold) {
    until = keepUntilFrom((change as { until?: Date | string })?.until);
    if (!until) return fail(ARCHIVE_ERRORS.untilMissing);
    const now = options.now ?? new Date();
    if (until.getTime() > now.getTime() + ARCHIVE_KEEP_MAX_YEARS * YEAR_MS) {
      return fail(ARCHIVE_ERRORS.untilTooFar);
    }
  }
  try {
    return await withService(async (db): Promise<ExtendArchiveResult> => {
      const [archive] = rowsOf(
        await db.execute(sql`
          select a.id, a.keep_until, a.legal_hold, a.purged_at,
                 coalesce(a.store_id, b.store_id) as store_id
            from public.content_block_archives a
            join public.content_blocks b on b.id = a.block_id
           where a.block_id = ${blockId}::uuid
           for update of a
        `),
      );
      if (!archive) return fail(ARCHIVE_ERRORS.notFound);
      if (archive.purged_at) return fail(ARCHIVE_ERRORS.purged);
      const storeId = str(archive.store_id);
      const from = String(archive.keep_until);
      if (hold) {
        if (archive.legal_hold === true)
          return fail(ARCHIVE_ERRORS.alreadyHeld);
        const [updated] = rowsOf(
          await db.execute(sql`
            update public.content_block_archives
               set legal_hold = true,
                   legal_hold_note = ${asked},
                   legal_hold_set_at = now(),
                   legal_hold_set_by = ${actor}
             where id = ${String(archive.id)}::uuid
             returning keep_until
          `),
        );
        await recordModerationEvent(db, {
          actor,
          action: "archive_hold_set",
          blockId,
          storeId,
          detail: { whoAsked: asked },
        });
        return {
          ok: true,
          keepUntil: String(updated?.keep_until ?? from),
          legalHold: true,
        };
      }
      // The database compares the dates (its own time text, never a parse of
      // it here): a date that is not later moves nothing and is named back.
      const target = (until as Date).toISOString();
      const [updated] = rowsOf(
        await db.execute(sql`
          update public.content_block_archives
             set keep_until = ${target}::timestamptz
           where id = ${String(archive.id)}::uuid
             and keep_until < ${target}::timestamptz
           returning keep_until, legal_hold
        `),
      );
      if (!updated) return fail(keepUntilTooEarly(from));
      await recordModerationEvent(db, {
        actor,
        action: "archive_kept_longer",
        blockId,
        storeId,
        detail: { from, until: target, whoAsked: asked },
      });
      return {
        ok: true,
        keepUntil: String(updated.keep_until ?? target),
        legalHold: updated.legal_hold === true,
      };
    });
  } catch (err) {
    logError("moderation.archive: keep longer failed", loggableError(err), {
      blockId,
    });
    return fail(ARCHIVE_ERRORS.saveFailed);
  }
}

export type ReleaseArchiveHoldResult =
  | { ok: true; keepUntil: string }
  | ArchiveFailure;

/**
 * Release a copy's legal hold (design 3.6, 6.6; superadmin only, with a
 * note). Records `archive_hold_released`; the next nightly purge then
 * deletes the copy if its date has passed. The hold's facts (who asked,
 * when, by whom) stay on the row as the last hold; `legal_hold` says whether
 * one is in force.
 */
export async function releaseArchiveHold(
  blockId: string,
  note: string,
  operator: ModerationOperator,
): Promise<ReleaseArchiveHoldResult> {
  if (!isSuperadmin(operator)) {
    return fail(ARCHIVE_ERRORS.releaseSuperadminOnly);
  }
  const actor = actorOf(operator);
  if (!UUID.test(blockId ?? "")) return fail(ARCHIVE_ERRORS.notFound);
  const releaseNote = text(note);
  if (!releaseNote) return fail(ARCHIVE_ERRORS.noteMissing);
  if (releaseNote.length > ARCHIVE_LIMITS.note) {
    return fail(ARCHIVE_ERRORS.noteLong);
  }
  try {
    return await withService(async (db): Promise<ReleaseArchiveHoldResult> => {
      const [archive] = rowsOf(
        await db.execute(sql`
          select a.id, a.keep_until, a.legal_hold, a.purged_at,
                 coalesce(a.store_id, b.store_id) as store_id
            from public.content_block_archives a
            join public.content_blocks b on b.id = a.block_id
           where a.block_id = ${blockId}::uuid
           for update of a
        `),
      );
      if (!archive) return fail(ARCHIVE_ERRORS.notFound);
      if (archive.purged_at) return fail(ARCHIVE_ERRORS.purged);
      if (archive.legal_hold !== true) return fail(ARCHIVE_ERRORS.notHeld);
      await db.execute(sql`
        update public.content_block_archives
           set legal_hold = false
         where id = ${String(archive.id)}::uuid
      `);
      await recordModerationEvent(db, {
        actor,
        action: "archive_hold_released",
        blockId,
        storeId: str(archive.store_id),
        detail: { note: releaseNote },
      });
      return { ok: true, keepUntil: String(archive.keep_until) };
    });
  } catch (err) {
    logError("moderation.archive: hold release failed", loggableError(err), {
      blockId,
    });
    return fail(ARCHIVE_ERRORS.saveFailed);
  }
}

// ── The nightly purge ───────────────────────────────────────────────────────

/**
 * Which archives the purge may take, over aliases `a` (the archive) and `b`
 * (its block). ONE fragment, used by the batch read and by the locked
 * re-read, so the two can never disagree:
 * - not purged, no legal hold, `keep_until` passed (the guard's own test);
 * - its files copied, or none to copy: a copy still running (`pending`) or
 *   waiting for Retry now (`failed`) is not finished evidence, and the
 *   follow-up may be writing into its folder;
 * - its block is not restoring a file from it right now;
 * - its store (as the archive or the block names it) has no active hold:
 *   a store kept for an investigation keeps its archives too, as its
 *   complaints and its record are kept (design 3.8; T10).
 */
export function archiveDueSql(): SQL {
  return sql`a.purged_at is null
    and not a.legal_hold
    and a.keep_until <= now()
    and a.files_state in ('none', 'copied')
    and b.storage_state <> 'restoring'
    and not exists (
      select 1 from public.store_legal_holds h
       where h.released_at is null
         and h.store_id in (a.store_id, b.store_id)
    )`;
}

/** The most strings of a snapshot `archiveObjectsOf` looks at. */
const SNAPSHOT_WALK_MAX = 200_000;

/**
 * The archive paths a value names that belong to this block's folder in ANY
 * database (`takedown-archive/<database>/<block id>/...`), found by walking
 * its strings. A path in another block's folder is never taken, so text
 * inside a snapshot can never point the purge at someone else's copy.
 */
export function archivePathsIn(value: unknown, blockId: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const block = blockId.toLowerCase();
  const stack: unknown[] = [value];
  const walked = new WeakSet<object>();
  let visited = 0;
  while (stack.length > 0 && visited < SNAPSHOT_WALK_MAX) {
    const next = stack.pop();
    visited += 1;
    if (typeof next === "string") {
      if (
        next.startsWith(ARCHIVE_ROOT) &&
        next.length <= 2048 &&
        archivePathDatabase(next) !== null
      ) {
        const segments = next.slice(ARCHIVE_ROOT.length).split("/");
        if (
          segments.length >= 3 &&
          segments[1].toLowerCase() === block &&
          !seen.has(next)
        ) {
          seen.add(next);
          found.push(next);
        }
      }
      continue;
    }
    if (next === null || typeof next !== "object") continue;
    if (walked.has(next)) continue;
    walked.add(next);
    for (const child of Array.isArray(next) ? next : Object.values(next)) {
      stack.push(child);
    }
  }
  return found;
}

/**
 * Every object of one archive, for the purge: each file entry's archive
 * object (pinned to its generation when known), any archive path of this
 * block the snapshot names (the whole-store `store-content.jsonl`, for one),
 * and, for a whole-store block, the content file's own path. Deduplicated by
 * path.
 */
export function archiveObjectsOf(row: {
  blockId: string;
  itemKind: string | null;
  files: unknown;
  snapshot: unknown;
}): ArchiveObjectRef[] {
  const byPath = new Map<string, ArchiveObjectRef>();
  const add = (path: string, generation: string | null) => {
    if (!path) return;
    const known = byPath.get(path);
    if (!known || (!known.generation && generation)) {
      byPath.set(path, { path, generation });
    }
  };
  for (const entry of Array.isArray(row.files) ? row.files : []) {
    const parsed = parseArchivedFile(entry);
    if (parsed) {
      if (parsed.archivePath) add(parsed.archivePath, parsed.archiveGeneration);
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const raw = entry as Record<string, unknown>;
      if (typeof raw.archivePath === "string") {
        add(
          raw.archivePath,
          typeof raw.archiveGeneration === "string"
            ? raw.archiveGeneration
            : null,
        );
      }
    }
  }
  for (const path of archivePathsIn(row.snapshot, row.blockId)) {
    add(path, null);
  }
  if (row.itemKind === "store") {
    add(archiveStoreContentPath(row.blockId), null);
  }
  return [...byPath.values()];
}

/** What became of one due archive. */
export type ArchivePurgeOutcome =
  | {
      archiveId: string;
      blockId: string;
      status: "purged";
      objects: number;
      deleted: number;
      missing: number;
    }
  | {
      archiveId: string;
      blockId: string;
      /** Its objects name another database's folder: nothing was touched. */
      status: "skipped";
      databases: (string | null)[];
    }
  | {
      archiveId: string;
      blockId: string;
      /** The row was left as it was, for the next night. */
      status: "failed";
      failedPaths: string[];
    }
  | {
      archiveId: string;
      blockId: string;
      /** Locked by another operation, or no longer due when locked. */
      status: "busy";
    };

/**
 * The sweep's run context (the shape of the retention sweep's batch: one
 * object for every batch of one run). `skip` holds archives this run set
 * aside (skipped, failed or busy), so the next batch does not take them
 * again; `outOfTime` is set when the batch stopped for the deadline.
 */
export interface ArchivePurgeRun {
  skip?: Set<string>;
  deadline?: number;
  clock?: () => number;
  outOfTime?: boolean;
}

class PurgeUndone extends Error {
  constructor(
    readonly outcome: ArchivePurgeOutcome,
    readonly storeId: string | null,
  ) {
    super(`archive purge undone: ${outcome.status}`);
    this.name = "PurgeUndone";
  }
}

async function purgeOne(
  candidate: { archiveId: string; blockId: string },
  storage: ModerationStorage,
  actor: string,
): Promise<ArchivePurgeOutcome> {
  const { archiveId, blockId } = candidate;
  let outcome: ArchivePurgeOutcome;
  let storeId: string | null = null;
  try {
    outcome = await withService(
      async (db: Db): Promise<ArchivePurgeOutcome> => {
        const [row] = rowsOf(
          await db.execute(sql`
            select a.id, a.block_id, a.files, a.snapshot, b.item_kind,
                   coalesce(a.store_id, b.store_id) as store_id
              from public.content_block_archives a
              join public.content_blocks b on b.id = a.block_id
             where a.id = ${archiveId}::uuid
               and ${archiveDueSql()}
             for update of a skip locked
          `),
        );
        if (!row) return { archiveId, blockId, status: "busy" };
        storeId = str(row.store_id);
        const objects = archiveObjectsOf({
          blockId,
          itemKind: str(row.item_kind),
          files: row.files,
          snapshot: row.snapshot,
        });
        // ★ The row is emptied FIRST, inside the transaction: the archive
        //   guard refuses a held or early purge before any object is
        //   deleted, and a failed delete below rolls this back.
        const emptied = rowsOf(
          await db.execute(sql`
            update public.content_block_archives
               set snapshot = null,
                   files = '[]'::jsonb,
                   purged_at = now()
             where id = ${archiveId}::uuid
               and purged_at is null
             returning id
          `),
        );
        if (emptied.length === 0) return { archiveId, blockId, status: "busy" };
        const deleted =
          objects.length > 0
            ? await purgeArchiveFiles(objects, storage)
            : { status: "purged" as const, deleted: 0, missing: 0 };
        if (deleted.status === "skipped") {
          throw new PurgeUndone(
            {
              archiveId,
              blockId,
              status: "skipped",
              databases: [...new Set(deleted.databases)],
            },
            storeId,
          );
        }
        if (deleted.status === "failed") {
          throw new PurgeUndone(
            {
              archiveId,
              blockId,
              status: "failed",
              failedPaths: deleted.failedPaths,
            },
            storeId,
          );
        }
        await recordModerationEvent(db, {
          actor,
          action: "archive_purged",
          blockId,
          storeId,
          detail: {
            objects: objects.length,
            deleted: deleted.deleted,
            missing: deleted.missing,
          },
        });
        return {
          archiveId,
          blockId,
          status: "purged",
          objects: objects.length,
          deleted: deleted.deleted,
          missing: deleted.missing,
        };
      },
    );
  } catch (err) {
    if (err instanceof PurgeUndone) {
      outcome = err.outcome;
      storeId = err.storeId;
    } else {
      logError("moderation.archive: purge failed", loggableError(err), {
        archiveId,
        blockId,
      });
      return { archiveId, blockId, status: "failed", failedPaths: [] };
    }
  }

  if (outcome.status === "skipped") {
    logWarn("moderation.archive: purge skipped, another database", {
      archiveId,
      blockId,
      databases: outcome.databases,
    });
    const databases = outcome.databases;
    try {
      await withService((db) =>
        recordModerationEvent(db, {
          actor,
          action: "archive_purge_skipped",
          blockId,
          storeId,
          detail: { reason: "other_database", databases },
        }),
      );
    } catch (err) {
      logError(
        "moderation.archive: purge skip not recorded",
        loggableError(err),
        { archiveId, blockId },
      );
    }
  } else if (outcome.status === "failed") {
    logError(
      "moderation.archive: purge left for the next night",
      new Error("archive objects could not be deleted"),
      { archiveId, blockId, failed: outcome.failedPaths.length },
    );
  }
  return outcome;
}

/**
 * One batch of the nightly purge (design 5.4, 8.2): the due archives, oldest
 * `keep_until` first, each in its own transaction. Answers what became of
 * each one it took.
 */
export async function purgeDueArchiveBatch(
  limit: number,
  options: {
    run?: ArchivePurgeRun;
    storage?: ModerationStorage;
    actor?: string;
  } = {},
): Promise<ArchivePurgeOutcome[]> {
  const size = Math.max(
    0,
    Math.min(ARCHIVE_PURGE_BATCH_MAX, Math.trunc(Number(limit) || 0)),
  );
  if (size === 0) return [];
  const run = options.run ?? {};
  const skip = run.skip ?? new Set<string>();
  const clock = run.clock ?? Date.now;
  const storage = options.storage ?? moderationStorage;
  const actor = (options.actor ?? "system").trim() || "system";
  const outOfTime = () =>
    run.deadline !== undefined &&
    clock() > run.deadline - ARCHIVE_PURGE_RESERVE_MS;
  if (outOfTime()) {
    run.outOfTime = true;
    return [];
  }

  const setAside =
    skip.size > 0
      ? sql`and not (a.id = any(${sql.param([...skip])}::uuid[]))`
      : sql``;
  const candidates = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        select a.id, a.block_id
          from public.content_block_archives a
          join public.content_blocks b on b.id = a.block_id
         where ${archiveDueSql()}
           ${setAside}
         order by a.keep_until, a.id
         limit ${size}
      `),
    ),
  );

  const outcomes: ArchivePurgeOutcome[] = [];
  for (const candidate of candidates) {
    if (outOfTime()) {
      run.outOfTime = true;
      break;
    }
    const outcome = await purgeOne(
      { archiveId: String(candidate.id), blockId: String(candidate.block_id) },
      storage,
      actor,
    );
    if (outcome.status !== "purged") skip.add(outcome.archiveId);
    outcomes.push(outcome);
  }
  if (outcomes.length > 0) {
    const count = (status: ArchivePurgeOutcome["status"]) =>
      outcomes.filter((outcome) => outcome.status === status).length;
    logInfo("moderation.archive: purge batch", {
      purged: count("purged"),
      skipped: count("skipped"),
      failed: count("failed"),
      busy: count("busy"),
    });
  }
  return outcomes;
}

/**
 * The retention sweep's deleter for `content_block_archives` (design 8.2):
 * `purgeDueArchives(limit, batch)` purges one batch and answers how many
 * archives it HANDLED (purged, skipped, failed or busy), so a batch with a
 * skip is still a full batch and the sweep asks for the next one, which no
 * longer contains it (`run.skip`). `keep_until` decides what is due, not the
 * sweep's floor.
 */
export async function purgeDueArchives(
  limit: number,
  run: ArchivePurgeRun = {},
  options: { storage?: ModerationStorage; actor?: string } = {},
): Promise<number> {
  const outcomes = await purgeDueArchiveBatch(limit, { ...options, run });
  return outcomes.length;
}
