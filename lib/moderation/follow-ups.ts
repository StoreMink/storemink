import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { deliverBlockNotice } from "./block";
import { forgetBlockedObjects } from "./blocked-objects";
import {
  DEADLINE_LEAD_HOURS,
  SHORT_DEADLINE_HOURS,
  SHORT_DEADLINE_LEAD_MINUTES,
  alertKey,
  dueAlert,
  type DeadlineStage,
} from "./deadlines";
import { COMPLAINT_KINDS, complaintRef, isOneOf } from "./kinds";
import { notifyComplaintDue } from "./notify";
import { recordModerationEvent } from "./record";
import {
  filesStateFor,
  parsePendingArchiveFile,
  type ArchiveFileEntry,
  type PendingArchiveFile,
} from "./snapshot";
import {
  FETCH_TIMEOUT_MS,
  archiveBucketFile,
  archiveBundledFile,
  archiveFetchedFile,
  moderationStorage,
  parseArchivedFile,
  removeNonImage,
  replaceWithPlaceholder,
  restoreFromArchive,
  type ArchiveResult,
  type ArchivedFile,
  type ModerationStorage,
  type ReplaceOutcome,
  type RestoreOutcome,
  type StorageFailure,
} from "./storage";
import { isThisDatabaseAttachmentPath } from "./store-content";

/**
 * The every-minute follow-up (design 8.1): what a block or a complaint leaves
 * for later, done in five steps inside the `send-emails` heartbeat, which runs
 * every minute in production (dev and staging have no scheduler; there the
 * console's actions call this inline, T15).
 *
 * 1. **Complaint alerts**: claim open complaints whose next deadline alert is
 *    due (`dueAlert`, design 3.9), tell the operators
 *    (`platform.complaint_due`), log `moderation: complaint due`, record the
 *    stage in `alerts` and `complaint_alerted`.
 * 2. **Archive copies**: claim archives with files still `pending` and copy
 *    them (a bucket or this database's private file, an Unsplash download, a
 *    theme file), create-only, never deleting what this attempt did not make.
 * 3. **File replacements**: claim live `pending` file blocks whose archive
 *    holds the file (at least 35 seconds after the block), overwrite the
 *    public object with the placeholder (or delete a non-image) pinned to the
 *    archived generation, settle `replaced`.
 * 4. **Restores**: claim `restoring` blocks (a lift whose inline restore did
 *    not finish) and put the original back.
 * 5. **Notice emails**: a told, live block of the last 24 hours whose notice
 *    never went is sent again (`deliverBlockNotice`, which claims itself).
 *
 * ★ EVERY STEP CLAIMS BEFORE IT WORKS. The route can run twice at once, so a
 * claim is one UPDATE over a `for update skip locked` subquery that stamps the
 * claim time, and every settle is fenced on that time: a run whose claim has
 * lapsed (2 minutes, longer than any run lives) changes nothing. Work that is
 * claimed and not done is given back at once (its attempt not counted).
 *
 * ★ EACH STEP AND EACH ROW IS ISOLATED. A throwing step logs
 * `moderation: follow-up failed` at ERROR with its step and the steps after it
 * still run; a throwing row does the same for its row. Every run ends, in a
 * `finally`, with the INFO heartbeat `moderation: follow-ups ran` and its
 * counts (production step P4 alerts when it stops).
 *
 * ★ BOUNDED: 20 rows per step, 50 archive files per run, and 40 seconds in
 * all, or less when the caller's `deadline` is earlier (the route passes
 * `min(start + 40 s, routeStart + 52 s)`, A19). No step starts a storage call
 * with under 5 seconds left; the archive copies stop 10 seconds early so the
 * steps after them still run; an outside download starts only with its whole
 * 30-second timeout left.
 *
 * Never opens a database scope inside another, and never holds one across a
 * storage call, an email or another module's scope (`deliverBlockNotice` and
 * `notifyComplaintDue` open their own).
 */

export const FOLLOW_UP_LIMITS = {
  /** Rows one step claims in a run. */
  rowsPerStep: 20,
  /** Archive files one run copies, across every archive. */
  filesPerRun: 50,
  /** A run's own budget from its start. */
  budgetMs: 40_000,
  /** The least time left for a step, a storage call or an email to start. */
  minStartMs: 5_000,
  /** What the archive copies leave for the steps after them. */
  laterStepsReserveMs: 10_000,
  /** The longest wait between two tries of one archive or file. */
  maxBackoffMinutes: 60,
  /** After this much waiting a copy or a replacement is `failed`. */
  giveUpMinutes: 24 * 60,
  /** A notice is retried for this long after the block. */
  noticeWindowHours: 24,
} as const;

/** The step names, as `moderation: follow-up failed` reports them. */
export const FOLLOW_UP_STEPS = [
  "alerts",
  "archives",
  "replacements",
  "restores",
  "notices",
] as const;
export type FollowUpStep = (typeof FOLLOW_UP_STEPS)[number];

/** Why a file was not replaced, as the console shows it (`storage_error`). */
export const FOLLOW_UP_ERRORS = {
  changedBeforeCopy:
    "The file changed before StoreMink could copy it, so it was not replaced. Block it again to keep a copy of the new version.",
  changedAfterCopy:
    "The file changed after StoreMink copied it, so it was not replaced.",
  goneBeforeCopy:
    "The file was already gone from storage when StoreMink went to copy it, so there was nothing to replace.",
  placeholderBeforeCopy:
    "The file was already a StoreMink placeholder, so there was nothing to copy or replace.",
  copyNotConfirmed:
    "StoreMink could not confirm its copy of the file, so the file was not replaced.",
  changedDuringCopy:
    "The file changed while StoreMink was copying it. StoreMink tries again.",
  storageUnavailable: "Storage could not be reached. StoreMink tries again.",
} as const;

/** What one run did, as the heartbeat logs it. */
export interface FollowUpResult {
  /** Complaint alerts told and recorded. */
  alertsSent: number;
  /** Alerts claimed whose operator event could not be recorded (sent again). */
  alertsWaiting: number;
  /** Archives whose files are now all copied. */
  archivesCopied: number;
  /** Archives that gave up (or met a different archived file). */
  archivesFailed: number;
  /** Archive files settled (copied, missing, placeholder, changed, recorded). */
  filesSettled: number;
  /** Archive files tried that will be tried again. */
  filesRetrying: number;
  replaced: number;
  replaceFailed: number;
  replaceRetrying: number;
  restored: number;
  notRestored: number;
  restoreRetrying: number;
  noticesSent: number;
  noticesFailed: number;
  /** Steps that threw. */
  failedSteps: FollowUpStep[];
  /** True when the deadline left work for the next run. */
  outOfTime: boolean;
  /** How long the run took (wall clock). */
  ms: number;
}

export interface FollowUpOptions {
  /**
   * The latest moment the run may work to, in the clock's milliseconds
   * (`Date.now()` by default). The run's own 40-second budget applies too.
   */
  deadline?: number;
  /** Milliseconds since the epoch; injectable for tests. */
  clock?: () => number;
  /** The time deadlines are judged at; injectable for tests. */
  now?: () => Date;
  /** The storage adapter (`moderationStorage` by default). */
  storage?: ModerationStorage;
}

type Run = {
  clock: () => number;
  deadline: number;
  now: () => Date;
  storage: ModerationStorage;
  filesLeft: number;
  result: FollowUpResult;
};

function emptyResult(): FollowUpResult {
  return {
    alertsSent: 0,
    alertsWaiting: 0,
    archivesCopied: 0,
    archivesFailed: 0,
    filesSettled: 0,
    filesRetrying: 0,
    replaced: 0,
    replaceFailed: 0,
    replaceRetrying: 0,
    restored: 0,
    notRestored: 0,
    restoreRetrying: 0,
    noticesSent: 0,
    noticesFailed: 0,
    failedSteps: [],
    outOfTime: false,
    ms: 0,
  };
}

/** Whether `need` milliseconds are left before `until`; notes when not. */
function timeFor(
  run: Run,
  need: number = FOLLOW_UP_LIMITS.minStartMs,
  until: number = run.deadline,
): boolean {
  if (until - run.clock() >= need) return true;
  run.result.outOfTime = true;
  return false;
}

// ── Backoff ─────────────────────────────────────────────────────────────────

/** The wait after the `attempts`th failed try: 1, 2, 4, 8 ... minutes, at most 60. */
export function backoffMinutes(attempts: number): number {
  const n = Math.max(1, Math.trunc(Number(attempts)) || 1);
  return Math.min(FOLLOW_UP_LIMITS.maxBackoffMinutes, 2 ** Math.min(n - 1, 30));
}

/** The waits of the first `attempts` failed tries, added up, in minutes. */
export function minutesWaited(attempts: number): number {
  const n = Math.max(0, Math.trunc(Number(attempts)) || 0);
  // 1 + 2 + 4 + 8 + 16 + 32 = 63 over the first six, then 60 each.
  return n <= 6 ? 2 ** n - 1 : 63 + 60 * (n - 6);
}

/**
 * After the `attempts`th failed try: wait and try again, or give up once the
 * waits would reach 24 hours (the 29th try).
 */
export function nextTry(
  attempts: number,
): { giveUp: true } | { giveUp: false; waitSeconds: number } {
  if (minutesWaited(attempts) >= FOLLOW_UP_LIMITS.giveUpMinutes) {
    return { giveUp: true };
  }
  return { giveUp: false, waitSeconds: backoffMinutes(attempts) * 60 };
}

// ── Row readers ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function int(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function rowsOf(result: { rows: unknown[] }): Row[] {
  return result.rows.filter(
    (row): row is Row => typeof row === "object" && row !== null,
  );
}

function isImageContentType(contentType: string | null | undefined): boolean {
  return /^image\//i.test((contentType ?? "").trim());
}

/** Rows grouped by the claim time they carry (one claim statement, one time). */
function byClaim<T extends { id: string; claimedAt: string }>(
  rows: readonly T[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const ids = groups.get(row.claimedAt) ?? [];
    ids.push(row.id);
    groups.set(row.claimedAt, ids);
  }
  return groups;
}

function nextAttemptSql(seconds: number | null): SQL {
  return seconds === null
    ? sql`null`
    : sql`now() + make_interval(secs => ${seconds}::int)`;
}

// ── 1. Complaint alerts ─────────────────────────────────────────────────────

const STAGE_DUE: Record<DeadlineStage, SQL> = {
  acknowledge: sql`c.acknowledge_due_at`,
  act: sql`c.action_due_at`,
  resolve: sql`c.resolve_due_at`,
};

/**
 * Shown for the kind, not yet met, and not covered by an earlier open stage
 * falling at the same moment: `dueAlert`'s rules (deadlines.ts), in SQL, so a
 * claim never takes a complaint that has nothing to say.
 */
const STAGE_OPEN: Record<DeadlineStage, SQL> = {
  acknowledge: sql`c.acknowledged_at is null`,
  act: sql`(c.kind <> 'grievance' and c.actioned_at is null
            and not (c.acknowledged_at is null
                     and c.acknowledge_due_at = c.action_due_at))`,
  resolve: sql`(c.kind not in ('information_order', 'data_request')
                and not ((c.acknowledged_at is null
                          and c.acknowledge_due_at = c.resolve_due_at)
                         or (c.kind <> 'grievance' and c.actioned_at is null
                             and c.action_due_at = c.resolve_due_at)))`,
};

function stageDueSql(stage: DeadlineStage, nowIso: string): SQL {
  const now = sql`${nowIso}::timestamptz`;
  const due = STAGE_DUE[stage];
  const soon = alertKey(stage, "soon");
  const overdue = alertKey(stage, "overdue");
  const lead = sql`(case when ${due} - c.received_at
                          <= make_interval(hours => ${SHORT_DEADLINE_HOURS}::int)
                         then make_interval(mins => ${SHORT_DEADLINE_LEAD_MINUTES}::int)
                         else make_interval(hours => ${DEADLINE_LEAD_HOURS}::int) end)`;
  return sql`(${STAGE_OPEN[stage]}
    and ((${now} >= ${due} and c.alerts -> ${overdue}::text is null)
         or (${now} < ${due} and ${now} >= ${due} - ${lead}
             and c.alerts -> ${soon}::text is null
             and c.alerts -> ${overdue}::text is null)))`;
}

type ClaimedComplaint = {
  id: string;
  refNo: number;
  kind: string;
  storeId: string | null;
  storeLabel: string;
  receivedAt: string;
  acknowledgeDueAt: string;
  actionDueAt: string;
  resolveDueAt: string;
  acknowledgedAt: string | null;
  actionedAt: string | null;
  resolvedAt: string | null;
  alerts: Record<string, unknown>;
  claimedAt: string;
};

function readComplaint(row: Row): ClaimedComplaint | null {
  const id = str(row.id);
  const claimedAt = str(row.claimed_at);
  if (!id || !claimedAt) return null;
  const alerts =
    typeof row.alerts === "object" &&
    row.alerts !== null &&
    !Array.isArray(row.alerts)
      ? (row.alerts as Record<string, unknown>)
      : {};
  return {
    id,
    refNo: int(row.ref_no),
    kind: str(row.kind) ?? "",
    storeId: str(row.store_id),
    storeLabel: str(row.store_label) ?? "",
    receivedAt: str(row.received_at) ?? "",
    acknowledgeDueAt: str(row.acknowledge_due_at) ?? "",
    actionDueAt: str(row.action_due_at) ?? "",
    resolveDueAt: str(row.resolve_due_at) ?? "",
    acknowledgedAt: str(row.acknowledged_at),
    actionedAt: str(row.actioned_at),
    resolvedAt: str(row.resolved_at),
    alerts,
    claimedAt,
  };
}

async function claimComplaints(nowIso: string): Promise<ClaimedComplaint[]> {
  return withService(async (db) => {
    const result = await db.execute(sql`
      update public.grievance_complaints g
         set alert_claimed_at = now()
       where g.id in (
         select c.id from public.grievance_complaints c
          where c.resolved_at is null
            and c.erased_at is null
            and (c.alert_claimed_at is null
                 or c.alert_claimed_at < now() - interval '2 minutes')
            and (${stageDueSql("acknowledge", nowIso)}
                 or ${stageDueSql("act", nowIso)}
                 or ${stageDueSql("resolve", nowIso)})
          order by least(c.acknowledge_due_at, c.action_due_at, c.resolve_due_at), c.id
          limit ${FOLLOW_UP_LIMITS.rowsPerStep}
          for update skip locked)
      returning g.id::text as id, g.ref_no, g.kind,
                g.store_id::text as store_id, g.store_label,
                g.received_at::text as received_at,
                g.acknowledge_due_at::text as acknowledge_due_at,
                g.action_due_at::text as action_due_at,
                g.resolve_due_at::text as resolve_due_at,
                g.acknowledged_at::text as acknowledged_at,
                g.actioned_at::text as actioned_at,
                g.resolved_at::text as resolved_at,
                g.alerts,
                g.alert_claimed_at::text as claimed_at`);
    return rowsOf(result)
      .map(readComplaint)
      .filter((row): row is ClaimedComplaint => row !== null);
  });
}

async function releaseComplaints(
  rows: readonly ClaimedComplaint[],
): Promise<void> {
  if (rows.length === 0) return;
  await withService(async (db) => {
    for (const [claimedAt, ids] of byClaim(rows)) {
      await db.execute(sql`
        update public.grievance_complaints
           set alert_claimed_at = null
         where id = any(${sql.param(ids)}::uuid[])
           and alert_claimed_at = ${claimedAt}::timestamptz`);
    }
  });
}

async function alertOne(run: Run, row: ClaimedComplaint): Promise<boolean> {
  if (!isOneOf(COMPLAINT_KINDS, row.kind)) return false;
  const now = run.now();
  const alert = dueAlert(
    {
      kind: row.kind,
      receivedAt: row.receivedAt,
      acknowledgeDueAt: row.acknowledgeDueAt,
      actionDueAt: row.actionDueAt,
      resolveDueAt: row.resolveDueAt,
      acknowledgedAt: row.acknowledgedAt,
      actionedAt: row.actionedAt,
      resolvedAt: row.resolvedAt,
      alerts: row.alerts,
    },
    now,
  );
  if (!alert) return false;

  const eventId = await notifyComplaintDue(
    {
      id: row.id,
      refNo: row.refNo,
      kind: row.kind,
      storeId: row.storeId,
      storeName: row.storeLabel || null,
    },
    { stage: alert.stage, phase: alert.phase, dueAt: alert.dueAt },
    now,
  );
  logWarn("moderation: complaint due", {
    ref: complaintRef(row.refNo),
    kind: row.kind,
    stage: alert.stage,
    phase: alert.phase,
    dueAt: alert.dueAt.toISOString(),
  });
  if (!eventId) {
    // Not recorded: the claim lapses and the next run tells them again. An
    // alert may come twice, never not at all.
    run.result.alertsWaiting += 1;
    return true;
  }
  await withService(async (db) => {
    const settled = await db.execute(sql`
      update public.grievance_complaints
         set alerts = alerts || jsonb_build_object(${alert.key}::text, ${now.toISOString()}::text),
             alert_claimed_at = null
       where id = ${row.id}::uuid
         and alert_claimed_at = ${row.claimedAt}::timestamptz
      returning id`);
    if (settled.rows.length === 0) return;
    await recordModerationEvent(db, {
      actor: "system",
      action: "complaint_alerted",
      complaintId: row.id,
      storeId: row.storeId,
      detail: {
        stage: alert.stage,
        phase: alert.phase,
        key: alert.key,
        dueAt: alert.dueAt.toISOString(),
        eventId,
      },
    });
  });
  run.result.alertsSent += 1;
  return true;
}

async function stepAlerts(run: Run): Promise<void> {
  if (!timeFor(run)) return;
  const rows = await claimComplaints(run.now().toISOString());
  const release: ClaimedComplaint[] = [];
  for (const row of rows) {
    if (!timeFor(run)) {
      release.push(row);
      continue;
    }
    try {
      const handled = await alertOne(run, row);
      if (!handled) release.push(row);
    } catch (err) {
      logError("moderation: follow-up failed", loggableError(err), {
        step: "alerts",
        complaintId: row.id,
      });
    }
  }
  await releaseComplaints(release);
}

// ── 2. Archive copies ───────────────────────────────────────────────────────

type ClaimedArchive = {
  id: string;
  blockId: string;
  files: unknown[];
  attempts: number;
  claimedAt: string;
  itemKind: string;
  itemId: string | null;
  storeId: string | null;
  objectPath: string | null;
  objectMd5: string | null;
};

function readArchive(row: Row): ClaimedArchive | null {
  const id = str(row.id);
  const blockId = str(row.block_id);
  const claimedAt = str(row.claimed_at);
  if (!id || !blockId || !claimedAt) return null;
  return {
    id,
    blockId,
    files: Array.isArray(row.files) ? row.files : [],
    attempts: int(row.attempts),
    claimedAt,
    itemKind: str(row.item_kind) ?? "",
    itemId: str(row.item_id),
    storeId: str(row.store_id),
    objectPath: str(row.object_path),
    objectMd5: str(row.object_md5),
  };
}

async function claimArchives(): Promise<ClaimedArchive[]> {
  return withService(async (db) => {
    const result = await db.execute(sql`
      with claimed as (
        update public.content_block_archives a
           set files_claimed_at = now(), files_attempts = a.files_attempts + 1
         where a.id in (
           select x.id from public.content_block_archives x
            where x.files_state = 'pending'
              and (x.files_next_attempt_at is null
                   or x.files_next_attempt_at <= now())
              and (x.files_claimed_at is null
                   or x.files_claimed_at < now() - interval '2 minutes')
            order by x.files_next_attempt_at nulls first, x.id
            limit ${FOLLOW_UP_LIMITS.rowsPerStep}
            for update skip locked)
        returning a.id, a.block_id, a.files, a.files_attempts, a.files_claimed_at
      )
      select c.id::text as id, c.block_id::text as block_id, c.files,
             c.files_attempts as attempts,
             c.files_claimed_at::text as claimed_at,
             b.item_kind, b.item_id::text as item_id,
             b.store_id::text as store_id, b.object_path, b.object_md5
        from claimed c
        join public.content_blocks b on b.id = c.block_id`);
    return rowsOf(result)
      .map(readArchive)
      .filter((row): row is ClaimedArchive => row !== null);
  });
}

async function releaseArchives(rows: readonly ClaimedArchive[]): Promise<void> {
  if (rows.length === 0) return;
  await withService(async (db) => {
    for (const [claimedAt, ids] of byClaim(rows)) {
      await db.execute(sql`
        update public.content_block_archives
           set files_claimed_at = null,
               files_attempts = greatest(files_attempts - 1, 0)
         where id = any(${sql.param(ids)}::uuid[])
           and files_state = 'pending'
           and files_claimed_at = ${claimedAt}::timestamptz`);
    }
  });
}

/** An entry noted and not copied (an input this module may not copy). */
function recordedEntry(
  storage: ModerationStorage,
  entry: PendingArchiveFile,
): ArchivedFile {
  return {
    n: entry.n,
    source: entry.source,
    path: entry.path,
    state: "recorded",
    sourceBucket:
      entry.source === "bucket"
        ? storage.bucketName("public")
        : entry.source === "private"
          ? storage.bucketName("private")
          : null,
    sourceGeneration: null,
    archivePath: null,
    archiveGeneration: null,
    size: null,
    contentType: null,
    md5: null,
    crc32c: null,
    sha256: null,
    cacheControl: null,
    at: storage.now().toISOString(),
  };
}

type EntryOutcome =
  | { kind: "settled"; file: ArchivedFile }
  | { kind: "retry"; message: string }
  | { kind: "conflict"; message: string };

/** The store a private (chat attachment) file must belong to. */
function attachmentStore(row: ClaimedArchive): string | null {
  return row.storeId ?? (row.itemKind === "store" ? row.itemId : null);
}

async function archiveEntry(
  run: Run,
  row: ClaimedArchive,
  entry: PendingArchiveFile,
): Promise<EntryOutcome> {
  let result: ArchiveResult;
  try {
    switch (entry.source) {
      case "bucket":
        result = await archiveBucketFile(
          {
            blockId: row.blockId,
            n: entry.n,
            path: entry.path,
            kind: "public",
            expectedMd5: entry.expectedMd5,
          },
          run.storage,
        );
        break;
      case "private": {
        // Only this store's chat attachments in this database's folder; any
        // other private path is noted, never copied (store-content.ts).
        const storeId = attachmentStore(row);
        if (!storeId || !isThisDatabaseAttachmentPath(entry.path, storeId)) {
          return { kind: "settled", file: recordedEntry(run.storage, entry) };
        }
        result = await archiveBucketFile(
          {
            blockId: row.blockId,
            n: entry.n,
            path: entry.path,
            kind: "private",
            expectedMd5: entry.expectedMd5,
          },
          run.storage,
        );
        break;
      }
      case "external":
        result = await archiveFetchedFile(
          { blockId: row.blockId, n: entry.n, url: entry.path },
          run.storage,
        );
        break;
      case "bundled":
        result = await archiveBundledFile(
          { blockId: row.blockId, n: entry.n, publicPath: entry.path },
          run.storage,
        );
        break;
      default:
        return { kind: "settled", file: recordedEntry(run.storage, entry) };
    }
  } catch {
    return { kind: "retry", message: FOLLOW_UP_ERRORS.storageUnavailable };
  }
  if (!result.ok) {
    if (result.failure.code === "conflict") {
      return { kind: "conflict", message: result.failure.message };
    }
    if (result.failure.retryable) {
      return { kind: "retry", message: result.failure.message };
    }
    // Refused or too large: trying again changes nothing, so it is noted.
    return { kind: "settled", file: recordedEntry(run.storage, entry) };
  }
  // ★ A `changed` with the MD5 found against the one the block recorded is
  // final (it is not the blocked file); one without (the generation read a
  // moment ago was replaced before the copy, plan A3) is tried again, so
  // what is there now is copied.
  if (
    result.file.state === "changed" &&
    !(entry.expectedMd5 && result.file.md5)
  ) {
    return { kind: "retry", message: FOLLOW_UP_ERRORS.changedDuringCopy };
  }
  return { kind: "settled", file: result.file };
}

async function copyArchive(
  run: Run,
  row: ClaimedArchive,
  until: number,
): Promise<"released" | "settled"> {
  const entries: unknown[] = [];
  let attempted = 0;
  let settled = 0;
  let retrying = 0;
  let retryMessage: string | null = null;
  let conflict: string | null = null;
  const fresh: ArchivedFile[] = [];

  for (const raw of row.files) {
    const pending = parsePendingArchiveFile(raw);
    if (!pending || conflict) {
      entries.push(pending ?? raw);
      continue;
    }
    const ready =
      run.filesLeft > 0 &&
      (pending.source === "external"
        ? timeFor(run, FETCH_TIMEOUT_MS + FOLLOW_UP_LIMITS.minStartMs)
        : timeFor(run, FOLLOW_UP_LIMITS.minStartMs, until));
    if (!ready) {
      entries.push(pending);
      continue;
    }
    run.filesLeft -= 1;
    attempted += 1;
    const outcome = await archiveEntry(run, row, pending);
    if (outcome.kind === "settled") {
      entries.push(outcome.file);
      fresh.push(outcome.file);
      settled += 1;
    } else if (outcome.kind === "retry") {
      entries.push(pending);
      retrying += 1;
      retryMessage ??= outcome.message;
    } else {
      entries.push(pending);
      conflict = outcome.message;
    }
  }

  if (attempted === 0) return "released";

  const allCopied =
    filesStateFor(entries as ArchiveFileEntry[]) === "copied" && !conflict;
  let state: "pending" | "copied" | "failed";
  let attempts = row.attempts;
  let nextSeconds: number | null;
  let error: string;
  if (conflict) {
    state = "failed";
    nextSeconds = null;
    error = conflict;
  } else if (allCopied) {
    state = "copied";
    nextSeconds = null;
    error = "";
  } else if (settled > 0) {
    // Progress: the count starts again, and what is left is due at once
    // (or in a minute when something failed).
    state = "pending";
    attempts = 0;
    nextSeconds = retryMessage ? 60 : 0;
    error = retryMessage ?? "";
  } else {
    const next = nextTry(row.attempts);
    state = next.giveUp ? "failed" : "pending";
    nextSeconds = next.giveUp ? null : next.waitSeconds;
    error = retryMessage ?? FOLLOW_UP_ERRORS.storageUnavailable;
  }

  // The block's own file, copied now with its MD5: filled in once (the
  // guard's rule), so a re-upload of the same bytes is refused.
  const own =
    row.itemKind === "file" && row.objectPath && !row.objectMd5
      ? fresh.find(
          (file) =>
            file.source === "bucket" &&
            file.path === row.objectPath &&
            file.state === "copied" &&
            file.md5,
        )
      : undefined;

  const outcome = await withService(async (db) => {
    const updated = await db.execute(sql`
      update public.content_block_archives
         set files = ${JSON.stringify(entries)}::jsonb,
             files_state = ${state},
             files_attempts = ${attempts}::int,
             files_error = left(${error}, 1000),
             files_next_attempt_at = ${nextAttemptSql(nextSeconds)},
             files_claimed_at = null
       where id = ${row.id}::uuid
         and files_state = 'pending'
         and files_claimed_at = ${row.claimedAt}::timestamptz
      returning id`);
    if (updated.rows.length === 0) return { settled: false, filled: false };
    let filled = false;
    if (own?.md5) {
      const md5 = await db.execute(sql`
        update public.content_blocks
           set object_md5 = ${own.md5}
         where id = ${row.blockId}::uuid
           and object_md5 is null
           and object_path = ${own.path}
        returning id`);
      filled = md5.rows.length > 0;
    }
    if (state === "copied" || state === "failed") {
      const counts: Record<string, number> = {};
      for (const value of entries) {
        const file = parseArchivedFile(value);
        if (file) counts[file.state] = (counts[file.state] ?? 0) + 1;
      }
      await recordModerationEvent(db, {
        actor: "system",
        action:
          state === "copied" ? "archive_files_copied" : "archive_files_failed",
        blockId: row.blockId,
        storeId: row.storeId,
        detail:
          state === "copied"
            ? { files: counts }
            : { files: counts, reason: conflict ? "conflict" : "gave_up" },
      });
    }
    return { settled: true, filled };
  });

  if (outcome.filled) forgetBlockedObjects();
  if (outcome.settled) {
    run.result.filesSettled += settled;
    run.result.filesRetrying += retrying;
    if (state === "copied") run.result.archivesCopied += 1;
    if (state === "failed") run.result.archivesFailed += 1;
  } else {
    logWarn("moderation: archive copy settled late", { blockId: row.blockId });
  }
  return "settled";
}

async function stepArchives(run: Run): Promise<void> {
  if (!timeFor(run)) return;
  const until = run.deadline - FOLLOW_UP_LIMITS.laterStepsReserveMs;
  const rows = await claimArchives();
  const release: ClaimedArchive[] = [];
  for (const row of rows) {
    if (
      run.filesLeft <= 0 ||
      !timeFor(run, FOLLOW_UP_LIMITS.minStartMs, until)
    ) {
      release.push(row);
      continue;
    }
    try {
      const done = await copyArchive(run, row, until);
      if (done === "released") release.push(row);
    } catch (err) {
      logError("moderation: follow-up failed", loggableError(err), {
        step: "archives",
        blockId: row.blockId,
      });
    }
  }
  await releaseArchives(release);
}

// ── 3. File replacements and 4. restores ────────────────────────────────────

type ClaimedFile = {
  id: string;
  storeId: string | null;
  objectPath: string;
  attempts: number;
  claimedAt: string;
  files: unknown[];
};

function readClaimedFile(row: Row): ClaimedFile | null {
  const id = str(row.id);
  const claimedAt = str(row.claimed_at);
  const objectPath = str(row.object_path);
  if (!id || !claimedAt || !objectPath) return null;
  return {
    id,
    storeId: str(row.store_id),
    objectPath,
    attempts: int(row.attempts),
    claimedAt,
    files: Array.isArray(row.files) ? row.files : [],
  };
}

/** The block's own file in its archive (a bucket entry for its path), any state. */
function ownEntry(
  files: readonly unknown[],
  path: string,
): ArchivedFile | null {
  for (const value of files) {
    const entry = parseArchivedFile(value);
    if (entry && entry.source === "bucket" && entry.path === path) return entry;
  }
  return null;
}

async function claimReplacements(): Promise<ClaimedFile[]> {
  return withService(async (db) => {
    const result = await db.execute(sql`
      with claimed as (
        update public.content_blocks b
           set storage_claimed_at = now(), storage_attempts = b.storage_attempts + 1
         where b.id in (
           select x.id from public.content_blocks x
            where x.storage_state = 'pending'
              and x.lifted_at is null
              and x.storage_next_attempt_at <= now()
              and (x.storage_claimed_at is null
                   or x.storage_claimed_at < now() - interval '2 minutes')
              and exists (
                select 1 from public.content_block_archives a
                 cross join lateral jsonb_array_elements(a.files) as f(entry)
                 where a.block_id = x.id
                   and f.entry ->> 'source' = 'bucket'
                   and f.entry ->> 'path' = x.object_path
                   and f.entry ->> 'state' <> 'pending')
            order by x.storage_next_attempt_at, x.id
            limit ${FOLLOW_UP_LIMITS.rowsPerStep}
            for update skip locked)
        returning b.id, b.store_id, b.object_path, b.storage_attempts, b.storage_claimed_at
      )
      select c.id::text as id, c.store_id::text as store_id, c.object_path,
             c.storage_attempts as attempts,
             c.storage_claimed_at::text as claimed_at, a.files
        from claimed c
        left join public.content_block_archives a on a.block_id = c.id`);
    return rowsOf(result)
      .map(readClaimedFile)
      .filter((row): row is ClaimedFile => row !== null);
  });
}

async function claimRestores(): Promise<ClaimedFile[]> {
  return withService(async (db) => {
    const result = await db.execute(sql`
      with claimed as (
        update public.content_blocks b
           set storage_claimed_at = now(), storage_attempts = b.storage_attempts + 1
         where b.id in (
           select x.id from public.content_blocks x
            where x.storage_state = 'restoring'
              and x.lifted_at is not null
              and (x.storage_next_attempt_at is null
                   or x.storage_next_attempt_at <= now())
              and (x.storage_claimed_at is null
                   or x.storage_claimed_at < now() - interval '2 minutes')
            order by x.storage_next_attempt_at nulls first, x.id
            limit ${FOLLOW_UP_LIMITS.rowsPerStep}
            for update skip locked)
        returning b.id, b.store_id, b.object_path, b.storage_attempts, b.storage_claimed_at
      )
      select c.id::text as id, c.store_id::text as store_id, c.object_path,
             c.storage_attempts as attempts,
             c.storage_claimed_at::text as claimed_at, a.files
        from claimed c
        left join public.content_block_archives a on a.block_id = c.id`);
    return rowsOf(result)
      .map(readClaimedFile)
      .filter((row): row is ClaimedFile => row !== null);
  });
}

async function releaseFiles(
  rows: readonly ClaimedFile[],
  state: "pending" | "restoring",
): Promise<void> {
  if (rows.length === 0) return;
  await withService(async (db) => {
    for (const [claimedAt, ids] of byClaim(rows)) {
      await db.execute(sql`
        update public.content_blocks
           set storage_claimed_at = null,
               storage_attempts = greatest(storage_attempts - 1, 0)
         where id = any(${sql.param(ids)}::uuid[])
           and storage_state = ${state}
           and storage_claimed_at = ${claimedAt}::timestamptz`);
    }
  });
}

/** Settle a claimed file block; answers whether the claim was still ours. */
async function settleFile(
  row: ClaimedFile,
  from: "pending" | "restoring",
  to: { state: string; error: string; nextSeconds: number | null },
  event: {
    action:
      | "storage_replaced"
      | "storage_failed"
      | "storage_restored"
      | "storage_not_restored";
    detail: Record<string, unknown>;
  } | null,
): Promise<boolean> {
  return withService(async (db) => {
    const updated = await db.execute(sql`
      update public.content_blocks
         set storage_state = ${to.state},
             storage_claimed_at = null,
             storage_error = left(${to.error}, 1000),
             storage_next_attempt_at = ${nextAttemptSql(to.nextSeconds)},
             updated_at = now()
       where id = ${row.id}::uuid
         and storage_state = ${from}
         and storage_claimed_at = ${row.claimedAt}::timestamptz
      returning id`);
    if (updated.rows.length === 0) return false;
    if (event) {
      await recordModerationEvent(db, {
        actor: "system",
        action: event.action,
        blockId: row.id,
        storeId: row.storeId,
        detail: event.detail,
      });
    }
    return true;
  });
}

async function replaceFailed(
  run: Run,
  row: ClaimedFile,
  error: string,
  reason: string,
): Promise<void> {
  const settled = await settleFile(
    row,
    "pending",
    { state: "failed", error, nextSeconds: null },
    { action: "storage_failed", detail: { reason } },
  );
  if (settled) run.result.replaceFailed += 1;
}

async function replaceRetry(
  run: Run,
  row: ClaimedFile,
  failure: StorageFailure,
): Promise<void> {
  const next = nextTry(row.attempts);
  if (next.giveUp) {
    await replaceFailed(run, row, failure.message, "gave_up");
    return;
  }
  const settled = await settleFile(
    row,
    "pending",
    { state: "pending", error: failure.message, nextSeconds: next.waitSeconds },
    null,
  );
  if (settled) run.result.replaceRetrying += 1;
}

/** Whether the claim is still this run's and the block still live. */
async function stillPending(row: ClaimedFile): Promise<boolean> {
  return withService(async (db) => {
    const found = await db.execute(sql`
      select 1 from public.content_blocks
       where id = ${row.id}::uuid
         and storage_state = 'pending'
         and lifted_at is null
         and storage_claimed_at = ${row.claimedAt}::timestamptz`);
    return found.rows.length > 0;
  });
}

async function replaceOne(run: Run, row: ClaimedFile): Promise<void> {
  const entry = ownEntry(row.files, row.objectPath);
  if (!entry || entry.state === "recorded") {
    await replaceFailed(
      run,
      row,
      FOLLOW_UP_ERRORS.copyNotConfirmed,
      "not_archived",
    );
    return;
  }
  if (entry.state === "changed") {
    await replaceFailed(
      run,
      row,
      FOLLOW_UP_ERRORS.changedBeforeCopy,
      "changed_before_copy",
    );
    return;
  }
  if (entry.state === "missing") {
    await replaceFailed(
      run,
      row,
      FOLLOW_UP_ERRORS.goneBeforeCopy,
      "gone_before_copy",
    );
    return;
  }
  if (entry.state === "placeholder") {
    await replaceFailed(
      run,
      row,
      FOLLOW_UP_ERRORS.placeholderBeforeCopy,
      "placeholder_before_copy",
    );
    return;
  }
  // ★ Re-read the claim right before the write: a lift that came first left
  // the block cancelled, and its file must not be touched.
  if (!(await stillPending(row))) return;

  const input = { blockId: row.id, path: row.objectPath, archived: entry };
  let outcome: ReplaceOutcome;
  try {
    outcome = isImageContentType(entry.contentType)
      ? await replaceWithPlaceholder(input, run.storage)
      : await removeNonImage(input, run.storage);
  } catch (err) {
    outcome = {
      status: "failed",
      failure: {
        code: "unavailable",
        retryable: true,
        message: FOLLOW_UP_ERRORS.storageUnavailable,
        detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
      },
    };
  }

  switch (outcome.status) {
    case "replaced":
    case "removed":
    case "gone": {
      const detail: Record<string, unknown> =
        outcome.status === "replaced"
          ? {
              alreadyDone: outcome.alreadyDone,
              archivedGenerationDeleted: outcome.archivedGenerationDeleted,
              sharedThemeRelease: outcome.sharedThemeRelease,
              deleteFailed: outcome.deleteFailure?.code ?? null,
            }
          : outcome.status === "gone"
            ? {
                gone: true,
                archivedGenerationDeleted: outcome.archivedGenerationDeleted,
              }
            : { removed: true };
      if (outcome.status === "replaced" && outcome.deleteFailure) {
        logWarn("moderation: archived generation not deleted", {
          blockId: row.id,
          code: outcome.deleteFailure.code,
        });
      }
      const settled = await settleFile(
        row,
        "pending",
        { state: "replaced", error: "", nextSeconds: null },
        { action: "storage_replaced", detail },
      );
      if (settled) run.result.replaced += 1;
      else logWarn("moderation: replacement settled late", { blockId: row.id });
      return;
    }
    case "changed":
      await replaceFailed(
        run,
        row,
        FOLLOW_UP_ERRORS.changedAfterCopy,
        "changed_after_copy",
      );
      return;
    case "not_archived":
      await replaceFailed(
        run,
        row,
        FOLLOW_UP_ERRORS.copyNotConfirmed,
        "not_archived",
      );
      return;
    case "refused":
      await replaceFailed(run, row, outcome.reason, "refused");
      return;
    case "failed":
      if (outcome.failure.retryable)
        await replaceRetry(run, row, outcome.failure);
      else
        await replaceFailed(
          run,
          row,
          outcome.failure.message,
          outcome.failure.code,
        );
      return;
  }
}

async function stepReplacements(run: Run): Promise<void> {
  if (!timeFor(run)) return;
  const rows = await claimReplacements();
  const release: ClaimedFile[] = [];
  for (const row of rows) {
    if (!timeFor(run)) {
      release.push(row);
      continue;
    }
    try {
      await replaceOne(run, row);
    } catch (err) {
      logError("moderation: follow-up failed", loggableError(err), {
        step: "replacements",
        blockId: row.id,
      });
    }
  }
  await releaseFiles(release, "pending");
}

async function restoreOne(run: Run, row: ClaimedFile): Promise<void> {
  const entry = ownEntry(row.files, row.objectPath);
  let outcome: RestoreOutcome;
  if (!entry || entry.state !== "copied") {
    outcome = { status: "not_restored", reason: "not_archived" };
  } else {
    try {
      outcome = await restoreFromArchive(
        { blockId: row.id, path: row.objectPath, archived: entry },
        run.storage,
      );
    } catch (err) {
      outcome = {
        status: "failed",
        failure: {
          code: "unavailable",
          retryable: true,
          message: FOLLOW_UP_ERRORS.storageUnavailable,
          detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
        },
      };
    }
  }

  if (outcome.status === "restored") {
    const settled = await settleFile(
      row,
      "restoring",
      { state: "restored", error: "", nextSeconds: null },
      {
        action: "storage_restored",
        detail: { alreadyDone: outcome.alreadyDone },
      },
    );
    if (settled) run.result.restored += 1;
    return;
  }
  if (outcome.status === "not_restored") {
    const settled = await settleFile(
      row,
      "restoring",
      { state: "not_restored", error: "", nextSeconds: null },
      { action: "storage_not_restored", detail: { reason: outcome.reason } },
    );
    if (settled) run.result.notRestored += 1;
    return;
  }
  // A lifted block can never be `failed` (the CHECK): a storage outage is
  // tried again, every hour at most, for as long as it takes; anything else
  // is not restored.
  if (outcome.failure.retryable) {
    const settled = await settleFile(
      row,
      "restoring",
      {
        state: "restoring",
        error: outcome.failure.message,
        nextSeconds: backoffMinutes(row.attempts) * 60,
      },
      null,
    );
    if (settled) run.result.restoreRetrying += 1;
    return;
  }
  const settled = await settleFile(
    row,
    "restoring",
    {
      state: "not_restored",
      error: outcome.failure.message,
      nextSeconds: null,
    },
    {
      action: "storage_not_restored",
      detail: { reason: outcome.failure.code },
    },
  );
  if (settled) run.result.notRestored += 1;
}

async function stepRestores(run: Run): Promise<void> {
  if (!timeFor(run)) return;
  const rows = await claimRestores();
  const release: ClaimedFile[] = [];
  for (const row of rows) {
    if (!timeFor(run)) {
      release.push(row);
      continue;
    }
    try {
      await restoreOne(run, row);
    } catch (err) {
      logError("moderation: follow-up failed", loggableError(err), {
        step: "restores",
        blockId: row.id,
      });
    }
  }
  await releaseFiles(release, "restoring");
}

// ── 5. Notice emails ────────────────────────────────────────────────────────

type NoticeCandidate = { id: string; bellRang: boolean };

/**
 * Told, live blocks of the last 24 hours whose notice never went, each due
 * again 1, 2, 4 ... minutes (at most 60) after its last failed try. Not
 * claimed here: `deliverBlockNotice` claims each one itself.
 */
async function noticeCandidates(): Promise<NoticeCandidate[]> {
  return withService(async (db) => {
    const result = await db.execute(sql`
      select b.id::text as id, coalesce(f.bell_rang, false) as bell_rang
        from public.content_blocks b
        left join lateral (
          select count(*)::int as failures,
                 max(e.at) as last_failed_at,
                 bool_or((e.detail ->> 'bell') = 'true') as bell_rang
            from public.moderation_events e
           where e.block_id = b.id
             and e.action = 'merchant_notify_failed'
        ) f on true
       where b.tell_store
         and b.merchant_notified_at is null
         and b.lifted_at is null
         and b.store_id is not null
         and b.parent_block_id is null
         and b.blocked_at > now() - make_interval(hours => ${FOLLOW_UP_LIMITS.noticeWindowHours}::int)
         and (b.notice_claimed_at is null
              or b.notice_claimed_at < now() - interval '2 minutes')
         and (coalesce(f.failures, 0) = 0
              or f.last_failed_at <= now() - make_interval(
                   mins => least(${FOLLOW_UP_LIMITS.maxBackoffMinutes}::int,
                                 power(2, f.failures - 1))::int))
       order by b.blocked_at, b.id
       limit ${FOLLOW_UP_LIMITS.rowsPerStep}`);
    return rowsOf(result).flatMap((row) => {
      const id = str(row.id);
      return id ? [{ id, bellRang: row.bell_rang === true }] : [];
    });
  });
}

async function stepNotices(run: Run): Promise<void> {
  if (!timeFor(run)) return;
  const candidates = await noticeCandidates();
  for (const candidate of candidates) {
    if (!timeFor(run)) return;
    try {
      // ★ The bell already rang on an earlier try: this one sends the email only.
      const outcome = await deliverBlockNotice(candidate.id, "system", {
        bell: !candidate.bellRang,
      });
      if (outcome === "sent") run.result.noticesSent += 1;
      else if (outcome === "failed") run.result.noticesFailed += 1;
    } catch (err) {
      // deliverBlockNotice never throws by contract; one that does costs its
      // own row, never the rows after it.
      logError("moderation: follow-up failed", loggableError(err), {
        step: "notices",
        blockId: candidate.id,
      });
    }
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

const STEP_RUNNERS: Record<FollowUpStep, (run: Run) => Promise<void>> = {
  alerts: stepAlerts,
  archives: stepArchives,
  replacements: stepReplacements,
  restores: stepRestores,
  notices: stepNotices,
};

/**
 * One follow-up run (design 8.1). Each step is isolated; the heartbeat is
 * logged in a `finally`, whatever happened. Rejects only when something
 * outside the steps throws (an injected clock that throws); callers isolate
 * it with `.catch(() => null)`.
 */
export async function runModerationFollowUps(
  options: FollowUpOptions = {},
): Promise<FollowUpResult> {
  const startedAt = Date.now();
  const result = emptyResult();
  try {
    const clock = options.clock ?? Date.now;
    const start = clock();
    const deadline = Math.min(
      start + FOLLOW_UP_LIMITS.budgetMs,
      Number.isFinite(options.deadline) ? Number(options.deadline) : Infinity,
    );
    const run: Run = {
      clock,
      deadline,
      now: options.now ?? (() => new Date()),
      storage: options.storage ?? moderationStorage,
      filesLeft: FOLLOW_UP_LIMITS.filesPerRun,
      result,
    };
    for (const step of FOLLOW_UP_STEPS) {
      try {
        await STEP_RUNNERS[step](run);
      } catch (err) {
        result.failedSteps.push(step);
        logError("moderation: follow-up failed", loggableError(err), { step });
      }
    }
  } finally {
    result.ms = Date.now() - startedAt;
    logInfo("moderation: follow-ups ran", { ...result });
  }
  return result;
}
