import "server-only";

/**
 * The operator console's reads (takedown design 5.2, 6.1 to 6.7; plan A12).
 *
 * Every function here runs under `withService` (RLS bypassed), so the console
 * page that calls it must have checked the operator first (`requireOperator`,
 * docs/operator-console.md). These are reads in lib, not "use server" files,
 * because they take ids and return data across every store.
 *
 * - `listComplaints`, `getComplaint`: the complaints log. A list never carries
 *   a complainant's name or contact; the page of one complaint does.
 * - `listBlocks`, `getBlock`: the blocks, their file and archive state, the
 *   conversation with the store and the record. A block's page shows that an
 *   archived copy exists, its size and its dates, never its contents.
 * - `getArchiveForViewing`: the snapshot and file list, for a superadmin,
 *   only against the receipt `recordArchiveView` (archive.ts) wrote first.
 * - `storeModerationSummary`: the store page's card (design 6.7).
 * - `resolveTarget`: what an address, or a store and a search, names, for
 *   "Block an item" (design 6.5). The host is resolved with `withService`, so
 *   a suspended store's address still resolves (the storefront's own lookup
 *   reads through `withAnon`, which sees active stores only), and a Theme
 *   Studio preview store is refused (A12).
 *
 * Each function opens its own scopes one after another, never one inside
 * another's callback (lib/db/nested-scope-coverage.test.ts).
 */

import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { isSchemaNotReady, loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import { canonicalJson } from "@/lib/themes/canonical-json";
import { GCS_BUCKET_NAME, gcsPublicUrl } from "@/lib/storage/gcs";
import { isThemeReleaseObjectPath } from "@/lib/storage/paths";
import { RESERVED_PAGE_SLUGS } from "@/lib/sections/registry";
import { parseHost, subdomainOrigin } from "@/lib/store/host";
import { ARCHIVE_ROOT } from "./archive-paths";
import { ARCHIVE_ERRORS, ARCHIVE_VIEW_RECEIPT_MINUTES } from "./archive";
import { storeLabelFor, type ModerationOperator } from "./complaints";
import { nextDeadline, type DeadlineStage } from "./deadlines";
import { STORE_DELETE_REFUSALS } from "./holds";
import {
  BLOCK_KINDS,
  COMPLAINT_KINDS,
  complaintRef,
  isOneOf,
  parseComplaintRef,
  type BlockKind,
  type ComplaintKind,
  type FileSource,
} from "./kinds";
import {
  isInvalidMediaAddress,
  isMediaKey,
  mediaKeyFromUrl,
  type MediaKey,
} from "./media-key";
import { referencedMediaKeys } from "./media-refs";
import { parseArchivedFile, type ArchivedFile } from "./storage";

// ── Shared helpers ──────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;

function rowsOf(result: { rows: unknown[] }): Row[] {
  return result.rows as Row[];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function int(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function bounded(value: unknown, fallback: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function offsetOf(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100_000) : 0;
}

function nowParam(now: Date | undefined): SQL {
  return sql`${(now ?? new Date()).toISOString()}::timestamptz`;
}

/** A LIKE pattern matching `text` anywhere, with `%`, `_` and `\` taken literally. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** The media key config of this environment. */
function mediaConfig(bucket?: string | null) {
  return { bucket: bucket === undefined ? GCS_BUCKET_NAME : bucket };
}

const LIST_LIMIT = 50;
const LIST_MAX = 200;
const EVENTS_MAX = 500;
const MESSAGES_MAX = 500;
const PICKS_MAX = 50;
const MATCHES_MAX = 20;
const IMAGES_MAX = 50;
const EXCERPT_MAX = 80;

// ── SQL shared with the Overview (design 6.1) ───────────────────────────────

/**
 * The earliest deadline a complaint has not met, over alias `c`, exactly as
 * `nextDeadline` (deadlines.ts) decides it: none once resolved; acknowledge
 * until acknowledged; act until actioned, except for a grievance (it has no
 * removal); resolve until resolved, except for an information order or a
 * personal data request (their "act" is their answer). `least` skips nulls.
 */
export function complaintNextDueSql(): SQL {
  return sql`(case when c.resolved_at is null then least(
      case when c.acknowledged_at is null then c.acknowledge_due_at end,
      case when c.actioned_at is null and c.kind <> 'grievance'
           then c.action_due_at end,
      case when c.kind not in ('information_order', 'data_request')
           then c.resolve_due_at end
    ) end)`;
}

/** How far ahead "Due soon" looks (design 6.1, 6.2). */
export const DUE_SOON_HOURS = 6;

/**
 * A live block whose conversation's newest message is from the store, over
 * alias `b`: the store is waiting for an answer (design 6.1 "Store replies").
 */
function waitingForAnswerSql(): SQL {
  return sql`(b.lifted_at is null and b.erased_at is null and (
      select m.from_side from public.content_block_messages m
       where m.block_id = b.id
       order by m.created_at desc, m.id desc
       limit 1
    ) = 'store')`;
}

/**
 * A live block with a file still to finish, over aliases `b` and `a` (its
 * archive, left joined): a replacement not done or failed, a theme file to
 * remove in the code, or an archive copy still running or failed (design 6.1
 * "Files to finish").
 */
function fileToFinishSql(): SQL {
  return sql`(b.lifted_at is null and (
      b.storage_state in ('pending', 'failed', 'manual')
      or a.files_state in ('pending', 'failed')
    ))`;
}

/**
 * The Overview's four takedown queues (design 6.1), as scalar subqueries the
 * Overview's one statement can carry (`lib/platform/overview.ts`). Each counts
 * exactly what the matching Complaints tab lists.
 */
export function moderationQueueSql(now?: Date): {
  complaintsDue: SQL;
  storeReplies: SQL;
  filesToFinish: SQL;
  holdsToReview: SQL;
} {
  const at = nowParam(now);
  return {
    complaintsDue: sql`(select count(*)::int from public.grievance_complaints c
       where ${complaintNextDueSql()} <= ${at} + make_interval(hours => ${DUE_SOON_HOURS}))`,
    storeReplies: sql`(select count(*)::int from public.content_blocks b
       where ${waitingForAnswerSql()})`,
    filesToFinish: sql`(select count(*)::int from public.content_blocks b
       left join public.content_block_archives a on a.block_id = b.id
       where ${fileToFinishSql()})`,
    holdsToReview: sql`(select count(*)::int from public.store_legal_holds h
       where h.released_at is null and h.review_on is not null
         and h.review_on <= (${at} at time zone 'Asia/Kolkata')::date)`,
  };
}

// ── Complaints ──────────────────────────────────────────────────────────────

export const COMPLAINT_VIEWS = [
  "open",
  "due",
  "overdue",
  "resolved",
  "all",
] as const;
export type ComplaintView = (typeof COMPLAINT_VIEWS)[number];

/**
 * Where a complaint stands: `resolved` (with its outcome), `actioned` (content
 * blocked, or the information provided), `acknowledged`, `not_acknowledged`.
 */
export type ComplaintStatus =
  | "not_acknowledged"
  | "acknowledged"
  | "actioned"
  | "resolved";

export type ComplaintDue = {
  stage: DeadlineStage;
  dueAt: string;
  overdue: boolean;
};

/** One row of the complaints list: no complainant's name or contact. */
export type ComplaintListRow = {
  id: string;
  ref: string;
  receivedAt: string;
  channel: string;
  kind: ComplaintKind;
  storeId: string | null;
  storeLabel: string;
  status: ComplaintStatus;
  outcome: string | null;
  acknowledgedAt: string | null;
  actionedAt: string | null;
  resolvedAt: string | null;
  nextDue: ComplaintDue | null;
  blockCount: number;
  erased: boolean;
};

function complaintStatus(row: Row): ComplaintStatus {
  if (row.resolved_at) return "resolved";
  if (row.actioned_at) return "actioned";
  if (row.acknowledged_at) return "acknowledged";
  return "not_acknowledged";
}

function complaintKindOf(value: unknown): ComplaintKind {
  return isOneOf(COMPLAINT_KINDS, value) ? value : "grievance";
}

function complaintDue(row: Row, now: Date): ComplaintDue | null {
  const due = nextDeadline(
    {
      kind: complaintKindOf(row.kind),
      receivedAt: String(row.received_at),
      acknowledgeDueAt: String(row.acknowledge_due_at),
      actionDueAt: String(row.action_due_at),
      resolveDueAt: String(row.resolve_due_at),
      acknowledgedAt: str(row.acknowledged_at),
      actionedAt: str(row.actioned_at),
      resolvedAt: str(row.resolved_at),
    },
    now,
  );
  return due
    ? { stage: due.stage, dueAt: due.dueAt.toISOString(), overdue: due.overdue }
    : null;
}

function complaintListRow(row: Row, now: Date): ComplaintListRow {
  return {
    id: String(row.id),
    ref: complaintRef(int(row.ref_no)),
    receivedAt: String(row.received_at),
    channel: String(row.channel),
    kind: complaintKindOf(row.kind),
    storeId: str(row.store_id),
    storeLabel: str(row.store_label) ?? "",
    status: complaintStatus(row),
    outcome: str(row.outcome),
    acknowledgedAt: str(row.acknowledged_at),
    actionedAt: str(row.actioned_at),
    resolvedAt: str(row.resolved_at),
    nextDue: complaintDue(row, now),
    blockCount: int(row.block_count),
    erased: Boolean(row.erased_at),
  };
}

function complaintViewSql(view: ComplaintView, at: SQL): SQL {
  switch (view) {
    case "open":
      return sql`c.resolved_at is null`;
    case "due":
      return sql`${complaintNextDueSql()} <= ${at} + make_interval(hours => ${DUE_SOON_HOURS})`;
    case "overdue":
      return sql`${complaintNextDueSql()} <= ${at}`;
    case "resolved":
      return sql`c.resolved_at is not null`;
    default:
      return sql`true`;
  }
}

function complaintOrderSql(view: ComplaintView): SQL {
  if (view === "resolved") return sql`c.resolved_at desc, c.ref_no desc`;
  if (view === "all") return sql`c.received_at desc, c.ref_no desc`;
  return sql`${complaintNextDueSql()} asc nulls last, c.received_at desc, c.ref_no desc`;
}

/**
 * The complaints list (design 6.2), one tab at a time: "open" (not resolved),
 * "due" (next deadline within 6 hours or passed), "overdue", "resolved",
 * "all". Narrowed to one store when asked (the store page's link).
 */
export async function listComplaints(
  filter: {
    view?: ComplaintView;
    storeId?: string | null;
    limit?: number;
    offset?: number;
    now?: Date;
  } = {},
): Promise<{ rows: ComplaintListRow[]; total: number }> {
  const view: ComplaintView = isOneOf(COMPLAINT_VIEWS, filter.view)
    ? filter.view
    : "open";
  const now = filter.now ?? new Date();
  const at = nowParam(now);
  const limit = bounded(filter.limit, LIST_LIMIT, LIST_MAX);
  const offset = offsetOf(filter.offset);
  const storeFilter =
    filter.storeId == null
      ? sql``
      : isUuid(filter.storeId)
        ? sql`and c.store_id = ${filter.storeId}::uuid`
        : sql`and false`;
  const rows = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        select c.id, c.ref_no, c.received_at, c.channel, c.kind, c.store_id,
               c.store_label, c.outcome, c.acknowledged_at, c.actioned_at,
               c.resolved_at, c.acknowledge_due_at, c.action_due_at,
               c.resolve_due_at, c.erased_at,
               (select count(*)::int from public.content_blocks b
                 where b.complaint_id = c.id) as block_count,
               count(*) over ()::int as total
          from public.grievance_complaints c
         where ${complaintViewSql(view, at)} ${storeFilter}
         order by ${complaintOrderSql(view)}
         limit ${limit} offset ${offset}
      `),
    ),
  );
  return {
    rows: rows.map((row) => complaintListRow(row, now)),
    total: rows.length > 0 ? int(rows[0].total) : 0,
  };
}

/** One complaint, every field, for its page (design 6.4). */
export type ComplaintDetail = ComplaintListRow & {
  complainantName: string;
  complainantContact: string;
  actingFor: string;
  authorityRef: string;
  urls: string[];
  summary: string;
  acknowledgeDueAt: string;
  actionDueAt: string;
  resolveDueAt: string;
  acknowledgedBy: string | null;
  acknowledgementEmailed: boolean;
  actionedBy: string | null;
  resolvedBy: string | null;
  outcomeNote: string;
  erasedAt: string | null;
  createdBy: string;
  createdAt: string;
  store: {
    id: string;
    name: string;
    slug: string;
    status: string;
  } | null;
};

/** One line of a record (design 6.4 "History"). */
export type ModerationEventRow = {
  id: string;
  at: string;
  actor: string;
  action: string;
  complaintId: string | null;
  blockId: string | null;
  holdId: string | null;
  storeId: string | null;
  detail: Record<string, unknown>;
  /** The block the event is about, when it is about one. */
  block: { kind: BlockKind; label: string } | null;
};

function eventRow(row: Row): ModerationEventRow {
  const detail =
    row.detail && typeof row.detail === "object" && !Array.isArray(row.detail)
      ? (row.detail as Record<string, unknown>)
      : {};
  return {
    id: String(row.id),
    at: String(row.at),
    actor: String(row.actor),
    action: String(row.action),
    complaintId: str(row.complaint_id),
    blockId: str(row.block_id),
    holdId: str(row.hold_id),
    storeId: str(row.store_id),
    detail,
    block:
      row.block_kind && isOneOf(BLOCK_KINDS, row.block_kind)
        ? { kind: row.block_kind, label: str(row.block_label) ?? "" }
        : null,
  };
}

export type ComplaintPage = {
  complaint: ComplaintDetail;
  blocks: BlockListRow[];
  events: ModerationEventRow[];
};

/**
 * One complaint by its reference ("SM-000123") or id, with its blocks and
 * the record of the complaint and of those blocks, oldest first (design 6.4).
 * Null when there is none.
 */
export async function getComplaint(
  refOrId: string,
  options: { now?: Date } = {},
): Promise<ComplaintPage | null> {
  const input = typeof refOrId === "string" ? refOrId.trim() : "";
  const refNo = parseComplaintRef(input);
  if (refNo === null && !isUuid(input)) return null;
  const now = options.now ?? new Date();
  const where =
    refNo !== null ? sql`c.ref_no = ${refNo}` : sql`c.id = ${input}::uuid`;
  const found = await withService(async (db) => {
    const [row] = rowsOf(
      await db.execute(sql`
        select c.*,
               (select count(*)::int from public.content_blocks b
                 where b.complaint_id = c.id) as block_count,
               s.name as s_name, s.slug as s_slug, s.status as s_status
          from public.grievance_complaints c
          left join public.stores s on s.id = c.store_id
         where ${where}
         limit 1
      `),
    );
    if (!row) return null;
    const id = String(row.id);
    const blocks = rowsOf(
      await db.execute(sql`
        ${blockSelectSql()}
         where b.complaint_id = ${id}::uuid
         order by b.blocked_at desc, b.id
         limit ${LIST_MAX}
      `),
    );
    const events = rowsOf(
      await db.execute(sql`
        select e.id, e.at, e.actor, e.action, e.complaint_id, e.block_id,
               e.hold_id, e.store_id, e.detail,
               b.item_kind as block_kind, b.item_label as block_label
          from public.moderation_events e
          left join public.content_blocks b on b.id = e.block_id
         where e.complaint_id = ${id}::uuid
            or e.block_id in (select x.id from public.content_blocks x
                               where x.complaint_id = ${id}::uuid)
         order by e.at asc, e.id asc
         limit ${EVENTS_MAX}
      `),
    );
    return { row, blocks, events };
  });
  if (!found) return null;
  const { row } = found;
  const complaint: ComplaintDetail = {
    ...complaintListRow(row, now),
    complainantName: str(row.complainant_name) ?? "",
    complainantContact: str(row.complainant_contact) ?? "",
    actingFor: str(row.acting_for) ?? "",
    authorityRef: str(row.authority_ref) ?? "",
    urls: Array.isArray(row.urls) ? row.urls.map(String) : [],
    summary: str(row.summary) ?? "",
    acknowledgeDueAt: String(row.acknowledge_due_at),
    actionDueAt: String(row.action_due_at),
    resolveDueAt: String(row.resolve_due_at),
    acknowledgedBy: str(row.acknowledged_by),
    acknowledgementEmailed: row.acknowledgement_emailed === true,
    actionedBy: str(row.actioned_by),
    resolvedBy: str(row.resolved_by),
    outcomeNote: str(row.outcome_note) ?? "",
    erasedAt: str(row.erased_at),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    store:
      row.store_id && row.s_slug
        ? {
            id: String(row.store_id),
            name: str(row.s_name) ?? "",
            slug: String(row.s_slug),
            status: str(row.s_status) ?? "",
          }
        : null,
  };
  return {
    complaint,
    blocks: found.blocks.map(blockListRow),
    events: found.events.map(eventRow),
  };
}

// ── Blocks ──────────────────────────────────────────────────────────────────

export const BLOCK_VIEWS = [
  "all",
  "live",
  "lifted",
  "replies",
  "files",
] as const;
export type BlockView = (typeof BLOCK_VIEWS)[number];

/**
 * A block's state (design 6.2 "State"): `blocked`, `blocked_untold` (kept
 * from the store under an order), `store_suspended` (a whole-store block),
 * `lifted`.
 */
export type BlockStatus =
  | "blocked"
  | "blocked_untold"
  | "store_suspended"
  | "lifted";

/**
 * Where a blocked file stands (design 6.2 "Files" and 6.6 "File"):
 * `copying` (the archive copy is running), `copy_failed` (the archive copy
 * stopped after 24 hours: Retry), `archived` (copied, the placeholder comes
 * next), `replace_failed` (the replacement failed: Retry, or the file
 * changed), `replaced`, `remove_by_hand` (built into a theme), `removed_by_hand`,
 * `not_ours` (an outside file, only no longer shown), `restoring`, `restored`,
 * `not_restored`, `cancelled` (the lift came before the replacement), `none`.
 * A whole store's copy is `store_copy` while it runs or failed.
 */
export type FileStage =
  | "copying"
  | "copy_failed"
  | "archived"
  | "replace_failed"
  | "replaced"
  | "remove_by_hand"
  | "removed_by_hand"
  | "not_ours"
  | "restoring"
  | "restored"
  | "not_restored"
  | "cancelled"
  | "store_copy"
  | "none";

export type ArchiveProgress = {
  filesState: string;
  /** Entries in the archive's file list. */
  total: number;
  copied: number;
  missing: number;
  /** Entries whose original changed before it could be copied. */
  changed: number;
};

export type BlockListRow = {
  id: string;
  kind: BlockKind;
  label: string;
  url: string;
  storeId: string | null;
  storeLabel: string;
  complaintId: string | null;
  complaintRef: string | null;
  reasonKind: string;
  tellStore: boolean;
  blockedAt: string;
  blockedBy: string;
  liftedAt: string | null;
  liftedBy: string | null;
  status: BlockStatus;
  fileSource: FileSource | null;
  objectPath: string | null;
  storageState: string;
  storageError: string;
  fileStage: FileStage | null;
  archive: ArchiveProgress | null;
  parentBlockId: string | null;
  merchantNotifiedAt: string | null;
  merchantSeenAt: string | null;
  lastMessage: {
    fromSide: "store" | "storemink";
    author: string;
    at: string;
    asksReview: boolean;
  } | null;
  erased: boolean;
};

function blockSelectSql(): SQL {
  return sql`
    select b.id, b.item_kind, b.item_label, b.item_url, b.store_id,
           b.store_label, b.complaint_id, b.reason_kind, b.tell_store,
           b.blocked_at, b.blocked_by, b.lifted_at, b.lifted_by,
           b.file_source, b.object_path, b.storage_state, b.storage_error,
           b.parent_block_id, b.merchant_notified_at, b.merchant_seen_at,
           b.erased_at,
           c.ref_no as complaint_ref_no,
           a.id as archive_id, a.files_state,
           fc.total as files_total, fc.copied as files_copied,
           fc.missing as files_missing, fc.changed as files_changed,
           lm.from_side as last_from_side, lm.author as last_author,
           lm.created_at as last_at, lm.asks_review as last_asks_review
      from public.content_blocks b
      left join public.grievance_complaints c on c.id = b.complaint_id
      left join public.content_block_archives a on a.block_id = b.id
      left join lateral (
        select count(*)::int as total,
               (count(*) filter (where f.entry->>'state' = 'copied'))::int as copied,
               (count(*) filter (where f.entry->>'state' = 'missing'))::int as missing,
               (count(*) filter (where f.entry->>'state' = 'changed'))::int as changed
          from jsonb_array_elements(coalesce(a.files, '[]'::jsonb)) as f(entry)
      ) fc on true
      left join lateral (
        select m.from_side, m.author, m.created_at, m.asks_review
          from public.content_block_messages m
         where m.block_id = b.id
         order by m.created_at desc, m.id desc
         limit 1
      ) lm on true`;
}

/** A block's state from its row (exported for the console's tests). */
export function blockStatusOf(row: {
  itemKind: string;
  tellStore: boolean;
  liftedAt: string | null;
}): BlockStatus {
  if (row.liftedAt) return "lifted";
  if (row.itemKind === "store") return "store_suspended";
  return row.tellStore ? "blocked" : "blocked_untold";
}

/** Where a block's file stands (see `FileStage`); null for an item block. */
export function fileStageOf(row: {
  itemKind: string;
  storageState: string;
  filesState: string | null;
}): FileStage | null {
  if (row.itemKind === "store") {
    return row.filesState === "pending" || row.filesState === "failed"
      ? "store_copy"
      : null;
  }
  if (row.itemKind !== "file") return null;
  switch (row.storageState) {
    case "pending":
      if (row.filesState === "failed") return "copy_failed";
      return row.filesState === "copied" ? "archived" : "copying";
    case "failed":
      return "replace_failed";
    case "replaced":
      return "replaced";
    case "manual":
      return "remove_by_hand";
    case "removed_by_hand":
      return "removed_by_hand";
    case "not_ours":
      return "not_ours";
    case "restoring":
      return "restoring";
    case "restored":
      return "restored";
    case "not_restored":
      return "not_restored";
    case "cancelled":
      return "cancelled";
    default:
      return "none";
  }
}

function blockKindOf(value: unknown): BlockKind {
  return isOneOf(BLOCK_KINDS, value) ? value : "file";
}

function fileSourceOf(value: unknown): FileSource | null {
  return value === "bucket" || value === "external" || value === "bundled"
    ? value
    : null;
}

function blockListRow(row: Row): BlockListRow {
  const kind = blockKindOf(row.item_kind);
  const storageState = str(row.storage_state) ?? "none";
  const filesState = row.archive_id ? (str(row.files_state) ?? "none") : null;
  const liftedAt = str(row.lifted_at);
  const tellStore = row.tell_store !== false;
  const lastSide = str(row.last_from_side);
  return {
    id: String(row.id),
    kind,
    label: str(row.item_label) ?? "",
    url: str(row.item_url) ?? "",
    storeId: str(row.store_id),
    storeLabel: str(row.store_label) ?? "",
    complaintId: str(row.complaint_id),
    complaintRef:
      row.complaint_ref_no != null
        ? complaintRef(int(row.complaint_ref_no))
        : null,
    reasonKind: String(row.reason_kind),
    tellStore,
    blockedAt: String(row.blocked_at),
    blockedBy: String(row.blocked_by),
    liftedAt,
    liftedBy: str(row.lifted_by),
    status: blockStatusOf({ itemKind: kind, tellStore, liftedAt }),
    fileSource: fileSourceOf(row.file_source),
    objectPath: str(row.object_path),
    storageState,
    storageError: str(row.storage_error) ?? "",
    fileStage: fileStageOf({ itemKind: kind, storageState, filesState }),
    archive:
      filesState === null
        ? null
        : {
            filesState,
            total: int(row.files_total),
            copied: int(row.files_copied),
            missing: int(row.files_missing),
            changed: int(row.files_changed),
          },
    parentBlockId: str(row.parent_block_id),
    merchantNotifiedAt: str(row.merchant_notified_at),
    merchantSeenAt: str(row.merchant_seen_at),
    lastMessage:
      lastSide === "store" || lastSide === "storemink"
        ? {
            fromSide: lastSide,
            author: str(row.last_author) ?? "",
            at: String(row.last_at),
            asksReview: row.last_asks_review === true,
          }
        : null,
    erased: Boolean(row.erased_at),
  };
}

function blockViewSql(view: BlockView): SQL {
  switch (view) {
    case "live":
      return sql`b.lifted_at is null`;
    case "lifted":
      return sql`b.lifted_at is not null`;
    case "replies":
      return waitingForAnswerSql();
    case "files":
      return fileToFinishSql();
    default:
      return sql`true`;
  }
}

/**
 * The blocks (design 6.2 "Blocks", "Files", "Store replies"), newest first,
 * narrowed by store, complaint or kind when asked.
 */
export async function listBlocks(
  filter: {
    view?: BlockView;
    storeId?: string | null;
    complaintId?: string | null;
    kind?: BlockKind | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: BlockListRow[]; total: number }> {
  const view: BlockView = isOneOf(BLOCK_VIEWS, filter.view)
    ? filter.view
    : "all";
  const limit = bounded(filter.limit, LIST_LIMIT, LIST_MAX);
  const offset = offsetOf(filter.offset);
  const narrow: SQL[] = [];
  if (filter.storeId != null) {
    narrow.push(
      isUuid(filter.storeId)
        ? sql`and b.store_id = ${filter.storeId}::uuid`
        : sql`and false`,
    );
  }
  if (filter.complaintId != null) {
    narrow.push(
      isUuid(filter.complaintId)
        ? sql`and b.complaint_id = ${filter.complaintId}::uuid`
        : sql`and false`,
    );
  }
  if (filter.kind != null) {
    narrow.push(
      isOneOf(BLOCK_KINDS, filter.kind)
        ? sql`and b.item_kind = ${filter.kind}`
        : sql`and false`,
    );
  }
  // The store waiting longest is answered first; everything else newest first.
  const order =
    view === "replies"
      ? sql`x.last_at asc nulls last, x.id`
      : sql`x.blocked_at desc, x.id`;
  const rows = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        select x.*, count(*) over ()::int as total
          from (
            ${blockSelectSql()}
             where ${blockViewSql(view)} ${sql.join(narrow, sql` `)}
          ) x
         order by ${order}
         limit ${limit} offset ${offset}
      `),
    ),
  );
  return {
    rows: rows.map(blockListRow),
    total: rows.length > 0 ? int(rows[0].total) : 0,
  };
}

/** A message of the conversation with the store. */
export type BlockMessage = {
  id: string;
  fromSide: "store" | "storemink";
  author: string;
  body: string;
  asksReview: boolean;
  at: string;
  seenAt: string | null;
};

/**
 * What a block's page says about its archived copy (design 6.6): that it
 * exists, its size and its dates, never its contents.
 */
export type ArchiveSummary = {
  id: string;
  createdAt: string;
  keepUntil: string;
  legalHold: boolean;
  legalHoldNote: string;
  legalHoldSetAt: string | null;
  legalHoldSetBy: string | null;
  purgedAt: string | null;
  sha256: string;
  /** Bytes of the snapshot as stored (0 once purged). */
  snapshotBytes: number;
  filesState: string;
  filesError: string;
  files: ArchiveProgress;
};

export type BlockDetail = BlockListRow & {
  itemId: string | null;
  objectMd5: string | null;
  authorUserId: string | null;
  parentItemId: string | null;
  storeStatusBefore: string | null;
  legalBasis: string;
  storeMessage: string;
  liftNote: string;
  storageAttempts: number;
  /** The follow-up holds this file right now: a lift waits (design 5.4). */
  replacingNow: boolean;
  /** The last notice email failed and none has gone since. */
  noticeEmailFailed: boolean;
  store: {
    id: string;
    name: string;
    slug: string;
    status: string;
  } | null;
};

export type BlockPage = {
  block: BlockDetail;
  parent: BlockListRow | null;
  children: BlockListRow[];
  messages: BlockMessage[];
  events: ModerationEventRow[];
  archive: ArchiveSummary | null;
};

/** How long a replacement's claim holds the file (design 5.4, 8.1). */
const REPLACE_CLAIM_MINUTES = 2;

/**
 * One block with its store, complaint, parent and child blocks, the
 * conversation, the record and the archive's summary (design 6.6). Never the
 * snapshot. Null when there is none.
 */
export async function getBlock(blockId: string): Promise<BlockPage | null> {
  if (!isUuid(blockId)) return null;
  const found = await withService(async (db) => {
    const [row] = rowsOf(
      await db.execute(sql`
        select x.*, b2.item_id, b2.object_md5, b2.author_user_id,
               b2.parent_item_id, b2.store_status_before, b2.legal_basis,
               b2.store_message, b2.lift_note, b2.storage_attempts,
               (b2.storage_claimed_at is not null
                and b2.storage_claimed_at > now()
                    - make_interval(mins => ${REPLACE_CLAIM_MINUTES})) as replacing_now,
               s.name as s_name, s.slug as s_slug, s.status as s_status,
               (select e.action from public.moderation_events e
                 where e.block_id = b2.id
                   and e.action in ('merchant_notified', 'merchant_notify_failed')
                 order by e.at desc, e.id desc limit 1) as last_notice_event
          from (${blockSelectSql()} where b.id = ${blockId}::uuid) x
          join public.content_blocks b2 on b2.id = x.id
          left join public.stores s on s.id = b2.store_id
      `),
    );
    if (!row) return null;
    const parentId = str(row.parent_block_id);
    const parent = parentId
      ? rowsOf(
          await db.execute(sql`
            ${blockSelectSql()} where b.id = ${parentId}::uuid
          `),
        )
      : [];
    const children = rowsOf(
      await db.execute(sql`
        ${blockSelectSql()}
         where b.parent_block_id = ${blockId}::uuid
         order by b.blocked_at, b.id
         limit ${LIST_MAX}
      `),
    );
    const messages = rowsOf(
      await db.execute(sql`
        select m.id, m.from_side, m.author, m.body, m.asks_review,
               m.created_at, m.seen_at
          from public.content_block_messages m
         where m.block_id = ${blockId}::uuid
         order by m.created_at asc, m.id asc
         limit ${MESSAGES_MAX}
      `),
    );
    const events = rowsOf(
      await db.execute(sql`
        select e.id, e.at, e.actor, e.action, e.complaint_id, e.block_id,
               e.hold_id, e.store_id, e.detail,
               b.item_kind as block_kind, b.item_label as block_label
          from public.moderation_events e
          left join public.content_blocks b on b.id = e.block_id
         where e.block_id = ${blockId}::uuid
         order by e.at asc, e.id asc
         limit ${EVENTS_MAX}
      `),
    );
    const [archive] = rowsOf(
      await db.execute(sql`
        select a.id, a.created_at, a.keep_until, a.legal_hold,
               a.legal_hold_note, a.legal_hold_set_at, a.legal_hold_set_by,
               a.purged_at, a.snapshot_sha256, a.files_state, a.files_error,
               coalesce(octet_length(a.snapshot::text), 0)::int as snapshot_bytes,
               fc.total, fc.copied, fc.missing, fc.changed
          from public.content_block_archives a
          left join lateral (
            select count(*)::int as total,
                   (count(*) filter (where f.entry->>'state' = 'copied'))::int as copied,
                   (count(*) filter (where f.entry->>'state' = 'missing'))::int as missing,
                   (count(*) filter (where f.entry->>'state' = 'changed'))::int as changed
              from jsonb_array_elements(a.files) as f(entry)
          ) fc on true
         where a.block_id = ${blockId}::uuid
      `),
    );
    return { row, parent, children, messages, events, archive };
  });
  if (!found) return null;
  const { row } = found;
  const listed = blockListRow(row);
  const block: BlockDetail = {
    ...listed,
    itemId: str(row.item_id),
    objectMd5: str(row.object_md5),
    authorUserId: str(row.author_user_id),
    parentItemId: str(row.parent_item_id),
    storeStatusBefore: str(row.store_status_before),
    legalBasis: str(row.legal_basis) ?? "",
    storeMessage: str(row.store_message) ?? "",
    liftNote: str(row.lift_note) ?? "",
    storageAttempts: int(row.storage_attempts),
    replacingNow: row.replacing_now === true,
    noticeEmailFailed:
      listed.tellStore &&
      !listed.merchantNotifiedAt &&
      row.last_notice_event === "merchant_notify_failed",
    store:
      row.store_id && row.s_slug
        ? {
            id: String(row.store_id),
            name: str(row.s_name) ?? "",
            slug: String(row.s_slug),
            status: str(row.s_status) ?? "",
          }
        : null,
  };
  const archive = found.archive;
  return {
    block,
    parent: found.parent[0] ? blockListRow(found.parent[0]) : null,
    children: found.children.map(blockListRow),
    messages: found.messages.map((message) => ({
      id: String(message.id),
      fromSide: message.from_side === "store" ? "store" : "storemink",
      author: String(message.author),
      body: String(message.body),
      asksReview: message.asks_review === true,
      at: String(message.created_at),
      seenAt: str(message.seen_at),
    })),
    events: found.events.map(eventRow),
    archive: archive
      ? {
          id: String(archive.id),
          createdAt: String(archive.created_at),
          keepUntil: String(archive.keep_until),
          legalHold: archive.legal_hold === true,
          legalHoldNote: str(archive.legal_hold_note) ?? "",
          legalHoldSetAt: str(archive.legal_hold_set_at),
          legalHoldSetBy: str(archive.legal_hold_set_by),
          purgedAt: str(archive.purged_at),
          sha256: String(archive.snapshot_sha256),
          snapshotBytes: int(archive.snapshot_bytes),
          filesState: str(archive.files_state) ?? "none",
          filesError: str(archive.files_error) ?? "",
          files: {
            filesState: str(archive.files_state) ?? "none",
            total: int(archive.total),
            copied: int(archive.copied),
            missing: int(archive.missing),
            changed: int(archive.changed),
          },
        }
      : null,
  };
}

// ── Holds ───────────────────────────────────────────────────────────────────

export const HOLD_VIEWS = ["active", "review", "released", "all"] as const;
export type HoldView = (typeof HOLD_VIEWS)[number];

export type HoldListRow = {
  id: string;
  storeId: string | null;
  storeLabel: string;
  reason: string;
  authorityRef: string;
  complaintId: string | null;
  complaintRef: string | null;
  setAt: string;
  setBy: string;
  /** "YYYY-MM-DD", India date. */
  reviewOn: string | null;
  releasedAt: string | null;
  releasedBy: string | null;
  releaseNote: string;
};

function holdRow(row: Row): HoldListRow {
  return {
    id: String(row.id),
    storeId: str(row.store_id),
    storeLabel: str(row.store_label) ?? "",
    reason: str(row.reason) ?? "",
    authorityRef: str(row.authority_ref) ?? "",
    complaintId: str(row.complaint_id),
    complaintRef:
      row.complaint_ref_no != null
        ? complaintRef(int(row.complaint_ref_no))
        : null,
    setAt: String(row.set_at),
    setBy: String(row.set_by),
    reviewOn: str(row.review_on),
    releasedAt: str(row.released_at),
    releasedBy: str(row.released_by),
    releaseNote: str(row.release_note) ?? "",
  };
}

/**
 * The store holds (design 6.2 "Holds", 6.1 "Holds to review"): `active`,
 * `review` (active, review date reached in India time), `released`, `all`.
 */
export async function listHolds(
  filter: {
    view?: HoldView;
    storeId?: string | null;
    limit?: number;
    now?: Date;
  } = {},
): Promise<HoldListRow[]> {
  const view: HoldView = isOneOf(HOLD_VIEWS, filter.view)
    ? filter.view
    : "active";
  const at = nowParam(filter.now);
  const limit = bounded(filter.limit, LIST_LIMIT, LIST_MAX);
  const where =
    view === "active"
      ? sql`h.released_at is null`
      : view === "review"
        ? sql`h.released_at is null and h.review_on is not null
              and h.review_on <= (${at} at time zone 'Asia/Kolkata')::date`
        : view === "released"
          ? sql`h.released_at is not null`
          : sql`true`;
  const store =
    filter.storeId == null
      ? sql``
      : isUuid(filter.storeId)
        ? sql`and h.store_id = ${filter.storeId}::uuid`
        : sql`and false`;
  const rows = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        select h.id, h.store_id, h.store_label, h.reason, h.authority_ref,
               h.complaint_id, h.set_at, h.set_by, h.review_on::text as review_on,
               h.released_at, h.released_by, h.release_note,
               c.ref_no as complaint_ref_no
          from public.store_legal_holds h
          left join public.grievance_complaints c on c.id = h.complaint_id
         where ${where} ${store}
         order by h.set_at desc, h.id
         limit ${limit}
      `),
    ),
  );
  return rows.map(holdRow);
}

// ── Tab counts ──────────────────────────────────────────────────────────────

export type ConsoleCounts = {
  open: number;
  due: number;
  overdue: number;
  replies: number;
  blocks: number;
  files: number;
  holds: number;
  resolved: number;
};

/**
 * The count beside each Complaints tab (design 6.2), in one statement: open,
 * due soon, overdue and resolved complaints, stores waiting for an answer,
 * live blocks, files to finish and active holds.
 */
export async function consoleCounts(now?: Date): Promise<ConsoleCounts> {
  const at = nowParam(now);
  const queues = moderationQueueSql(now);
  const [row] = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        select
          (select count(*)::int from public.grievance_complaints c
            where c.resolved_at is null) as open,
          ${queues.complaintsDue} as due,
          (select count(*)::int from public.grievance_complaints c
            where ${complaintNextDueSql()} <= ${at}) as overdue,
          ${queues.storeReplies} as replies,
          (select count(*)::int from public.content_blocks b
            where b.lifted_at is null) as blocks,
          ${queues.filesToFinish} as files,
          (select count(*)::int from public.store_legal_holds h
            where h.released_at is null) as holds,
          (select count(*)::int from public.grievance_complaints c
            where c.resolved_at is not null) as resolved
      `),
    ),
  );
  return {
    open: int(row?.open),
    due: int(row?.due),
    overdue: int(row?.overdue),
    replies: int(row?.replies),
    blocks: int(row?.blocks),
    files: int(row?.files),
    holds: int(row?.holds),
    resolved: int(row?.resolved),
  };
}

// ── The store page's card ───────────────────────────────────────────────────

export type StoreModerationSummary = {
  /** Live item and file blocks on the store (a whole-store block apart). */
  activeBlocks: number;
  openComplaints: number;
  /** Archives of this store whose files are still being copied, or failed. */
  unfinishedArchives: number;
  /** The live whole-store block, when the store is suspended by one. */
  storeBlock: { id: string; blockedAt: string } | null;
  hold: {
    id: string;
    reason: string;
    authorityRef: string;
    setAt: string;
    setBy: string;
    reviewOn: string | null;
    complaintId: string | null;
  } | null;
  /** Why Delete is unavailable (design 6.7), with the sentence it shows. */
  deleteRefusal: { reason: "hold" | "archive"; message: string } | null;
};

const EMPTY_SUMMARY: StoreModerationSummary = {
  activeBlocks: 0,
  openComplaints: 0,
  unfinishedArchives: 0,
  storeBlock: null,
  hold: null,
  deleteRefusal: null,
};

/**
 * The store page's "Complaints and holds" card (design 6.7) in one
 * statement. Before migration 0269 it answers an empty card; any other
 * failure throws, because a Delete button is decided by it.
 */
export async function storeModerationSummary(
  storeId: string,
): Promise<StoreModerationSummary> {
  if (!isUuid(storeId)) return { ...EMPTY_SUMMARY };
  let row: Row | undefined;
  try {
    [row] = await withService(async (db) =>
      rowsOf(
        await db.execute(sql`
          select
            (select count(*)::int from public.content_blocks b
              where b.store_id = ${storeId}::uuid and b.lifted_at is null
                and b.item_kind <> 'store') as active_blocks,
            (select count(*)::int from public.grievance_complaints c
              where c.store_id = ${storeId}::uuid and c.resolved_at is null)
              as open_complaints,
            (select count(*)::int from public.content_block_archives a
              join public.content_blocks b on b.id = a.block_id
              where (a.store_id = ${storeId}::uuid or b.store_id = ${storeId}::uuid)
                and a.files_state in ('pending', 'failed')) as unfinished_archives,
            (select jsonb_build_object('id', b.id, 'blockedAt', b.blocked_at)
               from public.content_blocks b
              where b.store_id = ${storeId}::uuid and b.item_kind = 'store'
                and b.lifted_at is null
              order by b.blocked_at desc limit 1) as store_block,
            (select jsonb_build_object(
                      'id', h.id, 'reason', h.reason,
                      'authorityRef', h.authority_ref, 'setAt', h.set_at,
                      'setBy', h.set_by, 'reviewOn', h.review_on::text,
                      'complaintId', h.complaint_id)
               from public.store_legal_holds h
              where h.store_id = ${storeId}::uuid and h.released_at is null
              order by h.set_at desc limit 1) as hold
        `),
      ),
    );
  } catch (err) {
    if (isSchemaNotReady(err)) return { ...EMPTY_SUMMARY };
    logError("moderation.console: store summary failed", loggableError(err), {
      storeId,
    });
    throw err;
  }
  const blockJson = row?.store_block as Record<string, unknown> | null;
  const holdJson = row?.hold as Record<string, unknown> | null;
  const unfinished = int(row?.unfinished_archives);
  const hold = holdJson
    ? {
        id: String(holdJson.id),
        reason: str(holdJson.reason) ?? "",
        authorityRef: str(holdJson.authorityRef) ?? "",
        setAt: String(holdJson.setAt),
        setBy: String(holdJson.setBy),
        reviewOn: str(holdJson.reviewOn),
        complaintId: str(holdJson.complaintId),
      }
    : null;
  return {
    activeBlocks: int(row?.active_blocks),
    openComplaints: int(row?.open_complaints),
    unfinishedArchives: unfinished,
    storeBlock: blockJson
      ? { id: String(blockJson.id), blockedAt: String(blockJson.blockedAt) }
      : null,
    hold,
    deleteRefusal: hold
      ? { reason: "hold", message: STORE_DELETE_REFUSALS.hold }
      : unfinished > 0
        ? { reason: "archive", message: STORE_DELETE_REFUSALS.archive }
        : null,
  };
}

// ── Reading an archived copy ────────────────────────────────────────────────

export type ArchiveForViewing = {
  blockId: string;
  storeId: string | null;
  createdAt: string;
  keepUntil: string;
  legalHold: boolean;
  snapshot: unknown;
  sha256: string;
  /** Whether the snapshot still hashes to its stored SHA-256. */
  hashMatches: boolean;
  filesState: string;
  /** Each entry as written; `entry` is null for one this build cannot read. */
  files: { entry: ArchivedFile | null; raw: unknown }[];
};

export type ArchiveViewResult =
  | { ok: true; archive: ArchiveForViewing }
  | { ok: false; error: string };

/**
 * The archived copy of a block (design 3.6, 5.2): the snapshot, its hash and
 * the file list, for a superadmin who has just recorded why they open it
 * (`recordArchiveView`, archive.ts). The receipt must be that operator's own
 * `archive_viewed` or `archive_downloaded` event for this block, less than
 * ten minutes old; without one the answer asks for the reason, so a copy is
 * never read unrecorded.
 */
export async function getArchiveForViewing(
  blockId: string,
  receipt: { eventId: string },
  operator: ModerationOperator,
): Promise<ArchiveViewResult> {
  if (operator?.role !== "superadmin") {
    return { ok: false, error: ARCHIVE_ERRORS.viewSuperadminOnly };
  }
  const actor = (operator.email ?? "").trim();
  if (!isUuid(blockId)) return { ok: false, error: ARCHIVE_ERRORS.notFound };
  if (!actor || !isUuid(receipt?.eventId)) {
    return { ok: false, error: ARCHIVE_ERRORS.reasonMissing };
  }
  const [row] = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        select a.block_id, coalesce(a.store_id, b.store_id) as store_id,
               a.created_at, a.keep_until, a.legal_hold, a.purged_at,
               a.snapshot, a.snapshot_sha256, a.files, a.files_state,
               exists (
                 select 1 from public.moderation_events e
                  where e.id = ${receipt.eventId}::uuid
                    and e.block_id = a.block_id
                    and e.actor = ${actor}
                    and e.action in ('archive_viewed', 'archive_downloaded')
                    and e.at > now() - make_interval(mins => ${ARCHIVE_VIEW_RECEIPT_MINUTES})
               ) as has_receipt
          from public.content_block_archives a
          join public.content_blocks b on b.id = a.block_id
         where a.block_id = ${blockId}::uuid
      `),
    ),
  );
  if (!row) return { ok: false, error: ARCHIVE_ERRORS.notFound };
  if (row.has_receipt !== true) {
    return { ok: false, error: ARCHIVE_ERRORS.reasonMissing };
  }
  if (row.purged_at) return { ok: false, error: ARCHIVE_ERRORS.purged };
  const sha256 = String(row.snapshot_sha256);
  const hash = createHash("sha256")
    .update(canonicalJson(row.snapshot))
    .digest("hex");
  const files = Array.isArray(row.files) ? row.files : [];
  return {
    ok: true,
    archive: {
      blockId: String(row.block_id),
      storeId: str(row.store_id),
      createdAt: String(row.created_at),
      keepUntil: String(row.keep_until),
      legalHold: row.legal_hold === true,
      snapshot: row.snapshot,
      sha256,
      hashMatches: hash === sha256,
      filesState: str(row.files_state) ?? "none",
      files: files.map((raw) => ({ entry: parseArchivedFile(raw), raw })),
    },
  };
}

// ── Finding what to block ───────────────────────────────────────────────────

/** Every sentence `resolveTarget` answers with (design 6.5; A12). */
export const TARGET_ERRORS = {
  fullAddress: "Paste a full address, starting with https://",
  notStore: "That address is not a StoreMink store.",
  notFound:
    "We could not find a product, page, blog post or collection at that address. Check it, or search the store.",
  fileNotServed: "That file is not one StoreMink serves.",
  preview: "That address is a Theme Studio preview, not a merchant's store.",
  storeNotFound: "We could not find that store.",
  itemNotFound: "We could not find it. It may have been deleted.",
  searchKind: "Choose what to search for.",
  readFailed: "Could not look it up. Please try again.",
} as const;

/** Where a blocked item appears today (design 6.5 "Appears on"), by kind. */
export const APPEARS_ON: Record<BlockKind, string> = {
  product:
    "its product page, the shop, search, collections, the sitemap, homepage sections and Mink AI's answers on WhatsApp",
  page: "its own address, the menus and footer links that point to it, and the sitemap",
  blog_post: "its post page, the blog, homepage blog sections and the sitemap",
  collection:
    "its collection page, the shop's filters, homepage category sections, menus and the sitemap",
  review: "the product page's reviews and the product's rating",
  blog_comment: "the comments under its post",
  file: "every page that shows it, wherever the same address is used",
  store: "every address of the store, its dashboard and its POS",
};

/**
 * Why the console should say more before blocking (design 6.5): `homepage`,
 * `theme_release` (a theme's image, shared by every store using it),
 * `bundled` (built into the app), `external` (StoreMink does not store it),
 * `already_blocked`.
 */
export type TargetWarning =
  | "homepage"
  | "theme_release"
  | "bundled"
  | "external"
  | "already_blocked";

export type TargetStore = {
  id: string;
  name: string;
  slug: string;
  status: string;
  /** "Crumb & Co (crumb.storemink.com)". */
  label: string;
  /** The store's own StoreMink address. */
  address: string;
  /** Its verified custom domain, if any. */
  customDomain: string | null;
  isDemo: boolean;
};

export type TargetFile = {
  source: FileSource;
  /** The media key the block records (object path, `/themes/...` or address). */
  key: string;
  /** Where the console can show it. */
  url: string;
  themeRelease: boolean;
  mediaAsset: {
    id: string;
    filename: string;
    contentType: string | null;
    sizeBytes: number | null;
  } | null;
};

/** A review or comment of the item, to pick from (design 5.2). */
export type TargetPick = {
  kind: "review" | "blog_comment";
  id: string;
  /** First name and initial ("Asha K."). */
  author: string;
  at: string;
  excerpt: string;
  authorUserId: string | null;
  parentId: string;
  blocked: boolean;
};

export type TargetImage = {
  source: FileSource;
  key: string;
  url: string;
  blocked: boolean;
};

export type ResolvedTarget = {
  kind: BlockKind;
  store: TargetStore | null;
  /** The row a product, page, post, collection, review or comment block names. */
  itemId: string | null;
  label: string;
  /** Its public address. */
  url: string;
  /** Its stored status ("published", "draft", "active", "suspended"), when it has one. */
  state: string | null;
  /** Hidden from shoppers by a block already. */
  blocked: boolean;
  appearsOn: string;
  homepage: boolean;
  alreadyBlocked: { blockId: string; blockedAt: string } | null;
  warnings: TargetWarning[];
  file: TargetFile | null;
  /** The product or post a review or comment is on. */
  parent: {
    kind: "product" | "blog_post";
    id: string;
    label: string;
    url: string;
  } | null;
  authorUserId: string | null;
  picks: TargetPick[];
  images: TargetImage[];
};

export type TargetMatch = {
  itemId: string;
  label: string;
  url: string;
  state: string | null;
  blocked: boolean;
};

export type SearchableKind =
  | "product"
  | "page"
  | "blog_post"
  | "collection"
  | "file";

export type TargetInput =
  | { address: string; storeId?: string | null }
  | { storeId: string; kind: "store" }
  | { storeId: string; kind: SearchableKind; search: string }
  | {
      storeId: string;
      kind: Exclude<BlockKind, "store" | "file">;
      itemId: string;
    };

export type ResolveTargetResult =
  | { ok: true; found: "target"; target: ResolvedTarget }
  | {
      ok: true;
      found: "matches";
      store: TargetStore;
      kind: SearchableKind;
      matches: TargetMatch[];
    }
  | { ok: false; error: string };

const SEARCH_KINDS: readonly SearchableKind[] = [
  "product",
  "page",
  "blog_post",
  "collection",
  "file",
];
const ITEM_KINDS = [
  "product",
  "page",
  "blog_post",
  "collection",
  "review",
  "blog_comment",
] as const;
type ItemKind = (typeof ITEM_KINDS)[number];

const WRAPPER_PATHS = new Set(["/_next/image", "/api/og-image"]);
const STORE_PATH_PREFIX = /^stores\/([0-9a-f-]{36})\//i;

type StoreRow = TargetStore & { preview: boolean };

const STORE_COLUMNS = sql`s.id, s.name, s.slug, s.status, s.custom_domain,
  (s.settings->>'custom_domain_verified') = 'true' as domain_verified,
  (s.settings ? 'studioPreview') as preview,
  (s.settings->>'demo') = 'true' as demo`;

function storeRowOf(row: Row): StoreRow {
  const name = str(row.name) ?? "";
  const slug = String(row.slug);
  return {
    id: String(row.id),
    name,
    slug,
    status: str(row.status) ?? "",
    label: storeLabelFor({ name, slug }),
    address: subdomainOrigin(slug),
    customDomain:
      row.domain_verified === true ? (str(row.custom_domain) ?? null) : null,
    isDemo: row.demo === true,
    preview: row.preview === true,
  };
}

function publicStore(store: StoreRow): TargetStore {
  const { preview: _preview, ...rest } = store;
  void _preview;
  return rest;
}

/**
 * The store a host names, whatever its status (design 5.2): its own
 * StoreMink subdomain, or a verified custom domain. Read with `withService`,
 * on purpose: the storefront's `withAnon` read sees active stores only, so a
 * suspended store's address would not resolve.
 */
async function storeForHost(
  host:
    | { type: "store-subdomain"; slug: string }
    | {
        type: "custom-domain";
        domain: string;
      },
): Promise<StoreRow | null> {
  const where =
    host.type === "store-subdomain"
      ? sql`s.slug = ${host.slug}`
      : sql`lower(s.custom_domain) = ${host.domain}
            and (s.settings->>'custom_domain_verified') = 'true'`;
  const [row] = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        select ${STORE_COLUMNS} from public.stores s where ${where} limit 1
      `),
    ),
  );
  return row ? storeRowOf(row) : null;
}

async function storeById(storeId: string): Promise<StoreRow | null> {
  const [row] = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        select ${STORE_COLUMNS} from public.stores s
         where s.id = ${storeId}::uuid limit 1
      `),
    ),
  );
  return row ? storeRowOf(row) : null;
}

function baseTarget(kind: BlockKind, store: StoreRow | null): ResolvedTarget {
  return {
    kind,
    store: store ? publicStore(store) : null,
    itemId: null,
    label: "",
    url: "",
    state: null,
    blocked: false,
    appearsOn: APPEARS_ON[kind],
    homepage: false,
    alreadyBlocked: null,
    warnings: [],
    file: null,
    parent: null,
    authorUserId: null,
    picks: [],
    images: [],
  };
}

function itemPath(kind: ItemKind | "store", slug: string): string {
  const part = encodeURIComponent(slug);
  switch (kind) {
    case "product":
      return `/shop/${part}`;
    case "blog_post":
      return `/blogs/${part}`;
    case "collection":
      return `/collections/${part}`;
    case "page":
      return slug ? `/${part}` : "/";
    default:
      return "/";
  }
}

function excerptOf(text: unknown): string {
  const plain = String(text ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > EXCERPT_MAX
    ? `${plain.slice(0, EXCERPT_MAX - 1).trimEnd()}…`
    : plain;
}

/** "Asha K." from "Asha Kumar"; the first word alone when there is one. */
function shortName(name: unknown): string {
  const words = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  const last = Array.from(words[words.length - 1])[0] ?? "";
  return `${words[0]} ${last.toUpperCase()}.`;
}

function fileUrl(key: MediaKey): string {
  return key.source === "bucket" ? gcsPublicUrl(key.key) : key.key;
}

/**
 * What one address names (design 5.2, 6.5). A store page gives its item, a
 * media address gives a file with its source, and anything else an error
 * sentence. A Theme Studio preview store is refused (A12).
 */
async function resolveAddress(
  address: string,
  storeId: string | null,
  bucket: string | null,
): Promise<ResolveTargetResult> {
  const text = address.trim();
  if (!/^https?:\/\//i.test(text)) {
    return { ok: false, error: TARGET_ERRORS.fullAddress };
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: TARGET_ERRORS.fullAddress };
  }
  const config = mediaConfig(bucket);
  const media = mediaKeyFromUrl(text, config);
  if (isInvalidMediaAddress(media)) {
    return { ok: false, error: TARGET_ERRORS.fileNotServed };
  }
  const wrapped = WRAPPER_PATHS.has(parsed.pathname);
  if (isMediaKey(media) && (media.source === "bucket" || wrapped)) {
    return fileTarget(media, storeId, null);
  }
  if (wrapped) return { ok: false, error: TARGET_ERRORS.fileNotServed };

  const host = parseHost(parsed.host);
  if (host.type === "platform") {
    if (parsed.pathname.startsWith("/themes/")) {
      const bundled = mediaKeyFromUrl(parsed.pathname, config);
      if (isMediaKey(bundled)) return fileTarget(bundled, storeId, null);
      return { ok: false, error: TARGET_ERRORS.fileNotServed };
    }
    return { ok: false, error: TARGET_ERRORS.notStore };
  }

  const store = await storeForHost(host);
  if (!store) {
    // Not a store of ours: an outside picture can still be blocked.
    if (
      isMediaKey(media) &&
      media.source === "external" &&
      referencedMediaKeys(text, config).length > 0
    ) {
      return fileTarget(media, storeId, null);
    }
    return { ok: false, error: TARGET_ERRORS.notStore };
  }
  if (store.preview) return { ok: false, error: TARGET_ERRORS.preview };

  if (parsed.pathname.startsWith("/themes/")) {
    const bundled = mediaKeyFromUrl(parsed.pathname, config);
    if (isMediaKey(bundled)) return fileTarget(bundled, null, store);
    return { ok: false, error: TARGET_ERRORS.fileNotServed };
  }
  return itemAtPath(store, parsed.pathname, config);
}

/** The item a store's path shows (design 5.2), or "not found". */
async function itemAtPath(
  store: StoreRow,
  pathname: string,
  config: { bucket: string | null },
): Promise<ResolveTargetResult> {
  const segments: string[] = [];
  for (const raw of pathname.split("/")) {
    if (!raw) continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return { ok: false, error: TARGET_ERRORS.notFound };
    }
  }
  let kind: ItemKind;
  let slug: string;
  if (segments.length === 0) {
    kind = "page";
    slug = "";
  } else if (segments.length === 2 && segments[0] === "shop") {
    kind = "product";
    slug = segments[1];
  } else if (
    segments.length === 2 &&
    segments[0] === "blogs" &&
    segments[1] !== "write" &&
    segments[1] !== "my-submissions"
  ) {
    kind = "blog_post";
    slug = segments[1];
  } else if (segments.length === 2 && segments[0] === "collections") {
    kind = "collection";
    slug = segments[1];
  } else if (
    segments.length === 1 &&
    (!RESERVED_PAGE_SLUGS.has(segments[0]) || segments[0] === "collections")
  ) {
    kind = "page";
    slug = segments[0];
  } else {
    return { ok: false, error: TARGET_ERRORS.notFound };
  }
  const target = await readItem(store, kind, { slug }, config);
  return target
    ? { ok: true, found: "target", target }
    : { ok: false, error: TARGET_ERRORS.notFound };
}

/** A file target: the store from its path, else the one given. */
async function fileTarget(
  media: MediaKey,
  storeId: string | null,
  knownStore: StoreRow | null,
): Promise<ResolveTargetResult> {
  if (media.source === "bucket" && media.key.startsWith(ARCHIVE_ROOT)) {
    return { ok: false, error: TARGET_ERRORS.fileNotServed };
  }
  let store = knownStore;
  if (!store && media.source === "bucket") {
    const owner = STORE_PATH_PREFIX.exec(media.key)?.[1] ?? null;
    if (owner && isUuid(owner)) store = await storeById(owner);
  }
  if (!store && storeId && isUuid(storeId)) store = await storeById(storeId);
  if (store?.preview) return { ok: false, error: TARGET_ERRORS.preview };

  const themeRelease =
    media.source === "bucket" && isThemeReleaseObjectPath(media.key);
  const read = await withService(async (db) => {
    const [block] = rowsOf(
      await db.execute(sql`
        select b.id, b.blocked_at from public.content_blocks b
         where b.item_kind = 'file' and b.object_path = ${media.key}
           and b.lifted_at is null
         order by b.blocked_at desc limit 1
      `),
    );
    const [asset] =
      media.source === "bucket" && store
        ? rowsOf(
            await db.execute(sql`
              select m.id, m.filename, m.content_type, m.size_bytes
                from public.media_assets m
               where m.store_id = ${store.id}::uuid and m.path = ${media.key}
               order by m.created_at desc limit 1
            `),
          )
        : [];
    return { block, asset };
  });
  const target = baseTarget("file", store);
  const name = media.key.split("/").filter(Boolean).pop() ?? media.key;
  target.label = str(read.asset?.filename) ?? name;
  target.url = fileUrl(media);
  target.state = null;
  target.alreadyBlocked = read.block
    ? {
        blockId: String(read.block.id),
        blockedAt: String(read.block.blocked_at),
      }
    : null;
  target.blocked = Boolean(read.block);
  target.file = {
    source: media.source,
    key: media.key,
    url: target.url,
    themeRelease,
    mediaAsset: read.asset
      ? {
          id: String(read.asset.id),
          filename: String(read.asset.filename),
          contentType: str(read.asset.content_type),
          sizeBytes:
            read.asset.size_bytes == null ? null : int(read.asset.size_bytes),
        }
      : null,
  };
  if (themeRelease) target.warnings.push("theme_release");
  if (media.source === "bundled") target.warnings.push("bundled");
  if (media.source === "external") target.warnings.push("external");
  if (target.alreadyBlocked) target.warnings.push("already_blocked");
  return { ok: true, found: "target", target };
}

type ItemRef = { slug: string } | { id: string };

/** The SQL that reads one item of a store, with what the console shows of it. */
function itemQuery(storeId: string, kind: ItemKind, ref: ItemRef): SQL {
  const byRef = (alias: string, slugColumn = "slug") =>
    "id" in ref
      ? sql`${sql.raw(alias)}.id = ${ref.id}::uuid`
      : sql`lower(${sql.raw(`${alias}.${slugColumn}`)}) = lower(${ref.slug})`;
  switch (kind) {
    case "product":
      return sql`
        select p.id, p.name as label, p.slug, p.status, p.moderation_blocked_at,
               to_jsonb(p) as row,
               coalesce((select jsonb_agg(to_jsonb(v))
                           from public.product_variants v
                          where v.product_id = p.id), '[]'::jsonb) as related
          from public.products p
         where p.store_id = ${storeId}::uuid and ${byRef("p")}
         limit 1`;
    case "page":
      return sql`
        select g.id, g.title as label, g.slug, g.status, g.moderation_blocked_at,
               to_jsonb(g) as row, null::jsonb as related
          from public.store_pages g
         where g.store_id = ${storeId}::uuid and ${
           "id" in ref ? sql`g.id = ${ref.id}::uuid` : sql`g.slug = ${ref.slug}`
         }
         limit 1`;
    case "blog_post":
      return sql`
        select g.id, g.title as label, g.slug, g.status, g.moderation_blocked_at,
               to_jsonb(g) as row, null::jsonb as related
          from public.blogs g
         where g.store_id = ${storeId}::uuid and ${byRef("g")}
         limit 1`;
    case "collection":
      return sql`
        select g.id, g.name as label, g.slug, g.status, g.moderation_blocked_at,
               to_jsonb(g) as row, null::jsonb as related
          from public.categories g
         where g.store_id = ${storeId}::uuid and ${byRef("g")}
         limit 1`;
    case "review":
      return sql`
        select r.id, r.comment as label, null::text as slug, null::text as status,
               r.moderation_blocked_at, null::jsonb as row, null::jsonb as related,
               r.user_id as author_user_id, r.author_name,
               p.id as parent_id, p.name as parent_label, p.slug as parent_slug
          from public.product_reviews r
          join public.products p on p.id = r.product_id
         where r.store_id = ${storeId}::uuid and r.id = ${"id" in ref ? ref.id : null}::uuid
         limit 1`;
    case "blog_comment":
      return sql`
        select c.id, c.body as label, null::text as slug, null::text as status,
               c.moderation_blocked_at, null::jsonb as row, null::jsonb as related,
               c.user_id as author_user_id, c.author_name,
               g.id as parent_id, g.title as parent_label, g.slug as parent_slug
          from public.blog_comments c
          join public.blogs g on g.id = c.blog_id
         where c.store_id = ${storeId}::uuid and c.id = ${"id" in ref ? ref.id : null}::uuid
         limit 1`;
  }
}

/**
 * One item of a store with its state, its live block, the reviews or
 * comments to pick from (a product or a post) and the images it uses.
 */
async function readItem(
  store: StoreRow,
  kind: ItemKind,
  ref: ItemRef,
  config: { bucket: string | null },
): Promise<ResolvedTarget | null> {
  const found = await withService(async (db) => {
    const [row] = rowsOf(await db.execute(itemQuery(store.id, kind, ref)));
    if (!row) return null;
    const itemId = String(row.id);
    const [block] = rowsOf(
      await db.execute(sql`
        select b.id, b.blocked_at from public.content_blocks b
         where b.item_kind = ${kind} and b.item_id = ${itemId}::uuid
           and b.lifted_at is null
         order by b.blocked_at desc limit 1
      `),
    );
    const picks =
      kind === "product"
        ? rowsOf(
            await db.execute(sql`
              select r.id, r.author_name, r.created_at, r.comment as body,
                     r.user_id, r.product_id as parent_id,
                     (r.moderation_blocked_at is not null or exists (
                        select 1 from public.content_blocks b
                         where b.item_kind = 'review' and b.item_id = r.id
                           and b.lifted_at is null)) as blocked
                from public.product_reviews r
               where r.store_id = ${store.id}::uuid and r.product_id = ${itemId}::uuid
               order by r.created_at desc, r.id
               limit ${PICKS_MAX}
            `),
          )
        : kind === "blog_post"
          ? rowsOf(
              await db.execute(sql`
                select c.id, c.author_name, c.created_at, c.body, c.user_id,
                       c.blog_id as parent_id,
                       (c.moderation_blocked_at is not null or exists (
                          select 1 from public.content_blocks b
                           where b.item_kind = 'blog_comment' and b.item_id = c.id
                             and b.lifted_at is null)) as blocked
                  from public.blog_comments c
                 where c.store_id = ${store.id}::uuid and c.blog_id = ${itemId}::uuid
                 order by c.created_at desc, c.id
                 limit ${PICKS_MAX}
              `),
            )
          : [];
    const keys = row.row
      ? referencedMediaKeys([row.row, row.related], config).slice(0, IMAGES_MAX)
      : [];
    const blockedKeys = keys.length
      ? rowsOf(
          await db.execute(sql`
            select distinct b.object_path from public.content_blocks b
             where b.item_kind = 'file' and b.lifted_at is null
               and b.object_path = any(${sql.param(keys.map((key) => key.key))}::text[])
          `),
        ).map((blocked) => String(blocked.object_path))
      : [];
    return { row, block, picks, keys, blockedKeys };
  });
  if (!found) return null;
  const { row } = found;
  const target = baseTarget(kind, store);
  target.itemId = String(row.id);
  target.state = str(row.status);
  target.blocked = Boolean(row.moderation_blocked_at);
  target.alreadyBlocked = found.block
    ? {
        blockId: String(found.block.id),
        blockedAt: String(found.block.blocked_at),
      }
    : null;
  if (kind === "review" || kind === "blog_comment") {
    const parentKind = kind === "review" ? "product" : "blog_post";
    const parentUrl = `${store.address}${itemPath(parentKind, String(row.parent_slug ?? ""))}`;
    target.label = excerptOf(row.label);
    target.url = parentUrl;
    target.authorUserId = str(row.author_user_id);
    target.parent = {
      kind: parentKind,
      id: String(row.parent_id),
      label: str(row.parent_label) ?? "",
      url: parentUrl,
    };
  } else {
    const slug = str(row.slug) ?? "";
    target.label = str(row.label) ?? slug;
    target.url = `${store.address}${itemPath(kind, slug)}`;
    target.homepage = kind === "page" && slug === "";
  }
  const pickKind = kind === "product" ? "review" : "blog_comment";
  target.picks = found.picks.map((pick) => ({
    kind: pickKind,
    id: String(pick.id),
    author: shortName(pick.author_name),
    at: String(pick.created_at),
    excerpt: excerptOf(pick.body),
    authorUserId: str(pick.user_id),
    parentId: String(pick.parent_id),
    blocked: pick.blocked === true,
  }));
  const blocked = new Set(found.blockedKeys);
  target.images = found.keys.map((key) => ({
    source: key.source,
    key: key.key,
    url: fileUrl(key),
    blocked: blocked.has(key.key),
  }));
  if (target.homepage) target.warnings.push("homepage");
  if (target.alreadyBlocked) target.warnings.push("already_blocked");
  return target;
}

/** The matches of a search in one store (design 6.5 "choose a store and search it"). */
async function searchStore(
  store: StoreRow,
  kind: SearchableKind,
  search: string,
): Promise<TargetMatch[]> {
  const pattern = containsPattern(search.trim().slice(0, 200));
  const query = (() => {
    switch (kind) {
      case "product":
        return sql`
          select p.id, p.name as label, p.slug, p.status,
                 (p.moderation_blocked_at is not null) as blocked
            from public.products p
           where p.store_id = ${store.id}::uuid
             and (p.name ilike ${pattern} or p.slug ilike ${pattern})
           order by p.name, p.id limit ${MATCHES_MAX}`;
      case "page":
        return sql`
          select g.id, g.title as label, g.slug, g.status,
                 (g.moderation_blocked_at is not null) as blocked
            from public.store_pages g
           where g.store_id = ${store.id}::uuid
             and (g.title ilike ${pattern} or g.slug ilike ${pattern})
           order by g.title, g.id limit ${MATCHES_MAX}`;
      case "blog_post":
        return sql`
          select g.id, g.title as label, g.slug, g.status,
                 (g.moderation_blocked_at is not null) as blocked
            from public.blogs g
           where g.store_id = ${store.id}::uuid
             and (g.title ilike ${pattern} or g.slug ilike ${pattern})
           order by g.title, g.id limit ${MATCHES_MAX}`;
      case "collection":
        return sql`
          select g.id, g.name as label, g.slug, g.status,
                 (g.moderation_blocked_at is not null) as blocked
            from public.categories g
           where g.store_id = ${store.id}::uuid
             and (g.name ilike ${pattern} or g.slug ilike ${pattern})
           order by g.name, g.id limit ${MATCHES_MAX}`;
      case "file":
        return sql`
          select m.id, m.filename as label, m.path as slug, null::text as status,
                 exists (select 1 from public.content_blocks b
                          where b.item_kind = 'file' and b.object_path = m.path
                            and b.lifted_at is null) as blocked
            from public.media_assets m
           where m.store_id = ${store.id}::uuid and m.filename ilike ${pattern}
           order by m.created_at desc, m.id limit ${MATCHES_MAX}`;
    }
  })();
  const rows = await withService(async (db) => rowsOf(await db.execute(query)));
  return rows.map((row) => {
    const slug = str(row.slug) ?? "";
    return {
      itemId: String(row.id),
      label: str(row.label) ?? slug,
      url:
        kind === "file"
          ? gcsPublicUrl(slug)
          : `${store.address}${itemPath(kind, slug)}`,
      state: str(row.status),
      blocked: row.blocked === true,
    };
  });
}

/** A whole store as a target (design 6.5 "Whole store"). */
async function storeTarget(store: StoreRow): Promise<ResolvedTarget> {
  const [block] = await withService(async (db) =>
    rowsOf(
      await db.execute(sql`
        select b.id, b.blocked_at from public.content_blocks b
         where b.item_kind = 'store' and b.store_id = ${store.id}::uuid
           and b.lifted_at is null
         order by b.blocked_at desc limit 1
      `),
    ),
  );
  const target = baseTarget("store", store);
  target.label = store.name || store.slug;
  target.url = store.address;
  target.state = store.status;
  target.blocked = Boolean(block);
  target.alreadyBlocked = block
    ? { blockId: String(block.id), blockedAt: String(block.blocked_at) }
    : null;
  if (target.alreadyBlocked) target.warnings.push("already_blocked");
  return target;
}

/**
 * What to block (design 5.2, 6.5): an address; a store and the kind "store";
 * a store, a kind and a search (the matches); or a store, a kind and an item
 * id (a match chosen, or a review or comment picked). Errors are the
 * console's sentences (`TARGET_ERRORS`).
 */
export async function resolveTarget(
  input: TargetInput,
  options: { bucket?: string | null } = {},
): Promise<ResolveTargetResult> {
  const bucket =
    options.bucket === undefined ? GCS_BUCKET_NAME : options.bucket;
  try {
    if ("address" in input) {
      if (typeof input.address !== "string" || !input.address.trim()) {
        return { ok: false, error: TARGET_ERRORS.fullAddress };
      }
      return await resolveAddress(input.address, input.storeId ?? null, bucket);
    }
    if (!isUuid(input.storeId)) {
      return { ok: false, error: TARGET_ERRORS.storeNotFound };
    }
    const store = await storeById(input.storeId);
    if (!store) return { ok: false, error: TARGET_ERRORS.storeNotFound };
    if (store.preview) return { ok: false, error: TARGET_ERRORS.preview };
    if (input.kind === "store") {
      return { ok: true, found: "target", target: await storeTarget(store) };
    }
    if ("search" in input) {
      if (!SEARCH_KINDS.includes(input.kind)) {
        return { ok: false, error: TARGET_ERRORS.searchKind };
      }
      return {
        ok: true,
        found: "matches",
        store: publicStore(store),
        kind: input.kind,
        matches: await searchStore(store, input.kind, String(input.search)),
      };
    }
    if (!isOneOf(ITEM_KINDS, input.kind) || !isUuid(input.itemId)) {
      return { ok: false, error: TARGET_ERRORS.itemNotFound };
    }
    const target = await readItem(
      store,
      input.kind,
      { id: input.itemId },
      mediaConfig(bucket),
    );
    return target
      ? { ok: true, found: "target", target }
      : { ok: false, error: TARGET_ERRORS.itemNotFound };
  } catch (err) {
    logError("moderation.console: target lookup failed", loggableError(err));
    return { ok: false, error: TARGET_ERRORS.readFailed };
  }
}
