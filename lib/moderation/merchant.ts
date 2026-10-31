import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { withService, type Db, type UserIdentity } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import {
  NOTICE,
  NOTICE_REPLY,
  NOTICE_REPLY_MAX,
  storeReplyAuthor,
  type ItemKind,
} from "./copy";
import {
  BLOCK_KINDS,
  BLOCK_REASONS,
  complaintRef,
  isOneOf,
  type BlockKind,
  type BlockReason,
} from "./kinds";
import { notifyTakedownReply } from "./notify";
import { recordModerationEvent } from "./record";
import { contentTypeFromName } from "./snapshot";

/**
 * The store's side of a takedown (design 3.4, 5.4 "Store side", 7.1): the
 * notices a merchant reads in Settings, Notices from StoreMink, their reply,
 * the "seen" mark, the home banner's count and the ids the item screens mark
 * "Blocked by StoreMink".
 *
 * ★★ EVERY READ HERE IS A SERVICE READ SCOPED TO ONE STORE, AND ONLY TO
 * BLOCKS THE STORE WAS TOLD ABOUT. The takedown tables are granted to
 * `app_service` alone (migration 0269), so RLS does not stand behind these
 * queries: `storeSees` is the boundary. A block kept from the store
 * (`tell_store` false, decision D21) is "not found" everywhere, exactly like
 * another store's block, and an erased block (3 years after its lift, its
 * words blanked) is not shown at all. The store id always comes from the
 * request host through the caller, never from the browser.
 *
 * An image blocked together with its product (`parent_block_id`) shares the
 * product's notice (T12): the list shows parents and names their images under
 * them; each image can still be opened by its own id.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The one filter every store read uses (D21). */
function storeSees(storeId: string): SQL {
  return sql`b.store_id = ${storeId}::uuid and b.tell_store and b.erased_at is null`;
}

/** A timestamp as ISO text, or null. */
function isoOf(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentTypeFor(kind: BlockKind, objectPath: unknown): string | null {
  return kind === "file" && typeof objectPath === "string"
    ? contentTypeFromName(objectPath)
    : null;
}

// ── The list ────────────────────────────────────────────────────────────────

/** An image blocked together with an item, shown under that item's notice. */
export interface StoreNoticeImage {
  blockId: string;
  label: string;
  lifted: boolean;
}

/** One row of Notices from StoreMink. */
export interface StoreNoticeRow {
  blockId: string;
  kind: BlockKind;
  /** For a file: what its name says it is ("image" or "file" wording). */
  contentType: string | null;
  itemLabel: string;
  reasonKind: BlockReason;
  blockedAt: string;
  liftedAt: string | null;
  /** Someone at the store has opened the notice. */
  seen: boolean;
  images: StoreNoticeImage[];
}

interface BlockRowFacts {
  id: string;
  parentBlockId: string | null;
  kind: BlockKind;
  contentType: string | null;
  itemLabel: string;
  reasonKind: BlockReason;
  blockedAt: string;
  liftedAt: string | null;
  seen: boolean;
}

function readBlockRow(raw: unknown): BlockRowFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (!isUuid(row.id)) return null;
  if (!isOneOf(BLOCK_KINDS, row.item_kind)) return null;
  if (!isOneOf(BLOCK_REASONS, row.reason_kind)) return null;
  const blockedAt = isoOf(row.blocked_at);
  if (!blockedAt) return null;
  return {
    id: row.id.toLowerCase(),
    parentBlockId: isUuid(row.parent_block_id)
      ? row.parent_block_id.toLowerCase()
      : null,
    kind: row.item_kind,
    contentType: contentTypeFor(row.item_kind, row.object_path),
    itemLabel: text(row.item_label),
    reasonKind: row.reason_kind,
    blockedAt,
    liftedAt: isoOf(row.lifted_at),
    seen: isoOf(row.merchant_seen_at) !== null,
  };
}

/**
 * Every block the store was told about, newest first, images under the item
 * they were blocked with. Throws on a database error (the page shows the
 * dashboard's error state rather than an empty list that reads as "nothing
 * was ever blocked").
 */
export async function listStoreNotices(
  storeId: string,
): Promise<StoreNoticeRow[]> {
  if (!isUuid(storeId)) return [];
  const rows = await withService(async (db) => {
    const result = await db.execute(sql`
      select b.id::text as id, b.parent_block_id::text as parent_block_id,
             b.item_kind, b.item_label, b.object_path, b.reason_kind,
             b.blocked_at::text as blocked_at, b.lifted_at::text as lifted_at,
             b.merchant_seen_at::text as merchant_seen_at
        from public.content_blocks b
       where ${storeSees(storeId)}
       order by b.blocked_at desc, b.id`);
    return result.rows;
  });
  const facts = rows
    .map(readBlockRow)
    .filter((row): row is BlockRowFacts => row !== null);
  const parents = new Map<string, StoreNoticeRow>();
  const notices: StoreNoticeRow[] = [];
  for (const row of facts) {
    if (row.parentBlockId) continue;
    const notice: StoreNoticeRow = {
      blockId: row.id,
      kind: row.kind,
      contentType: row.contentType,
      itemLabel: row.itemLabel,
      reasonKind: row.reasonKind,
      blockedAt: row.blockedAt,
      liftedAt: row.liftedAt,
      seen: row.seen,
      images: [],
    };
    parents.set(row.id, notice);
    notices.push(notice);
  }
  for (const row of facts) {
    if (!row.parentBlockId) continue;
    const parent = parents.get(row.parentBlockId);
    if (parent) {
      parent.images.push({
        blockId: row.id,
        label: row.itemLabel,
        lifted: row.liftedAt !== null,
      });
      continue;
    }
    // An image whose item is not shown (it cannot normally happen: an item
    // and its images are told together) is a notice of its own.
    notices.push({
      blockId: row.id,
      kind: row.kind,
      contentType: row.contentType,
      itemLabel: row.itemLabel,
      reasonKind: row.reasonKind,
      blockedAt: row.blockedAt,
      liftedAt: row.liftedAt,
      seen: row.seen,
      images: [],
    });
  }
  return notices;
}

// ── One notice ──────────────────────────────────────────────────────────────

/** One message of the conversation, as the store reads it. */
export interface StoreNoticeMessage {
  id: string;
  fromStoreMink: boolean;
  /** "StoreMink", or the store sender's address ("..., by email" when copied in). */
  author: string;
  body: string;
  /** The store ticked "Please review it again" (or "Please show it again"). */
  asksReview: boolean;
  createdAt: string;
}

/** Where the blocked item is edited in the dashboard, when it still exists. */
export interface StoreNoticeEditLink {
  href: string;
  /** The dashboard section a viewer needs to open it. */
  section: string;
}

export interface StoreNotice extends StoreNoticeRow {
  parentBlockId: string | null;
  complaintId: string | null;
  /** The complaint reference ("SM-000123"), when the block names one. */
  reference: string | null;
  storeMessage: string;
  liftNote: string;
  edit: StoreNoticeEditLink | null;
  messages: StoreNoticeMessage[];
}

function editLinkFor(
  kind: BlockKind,
  row: Record<string, unknown>,
): StoreNoticeEditLink | null {
  if (row.item_exists !== true) return null;
  const itemId = isUuid(row.item_id) ? row.item_id.toLowerCase() : null;
  switch (kind) {
    case "product":
      return itemId
        ? { href: `/dashboard/products/${itemId}`, section: "products" }
        : null;
    case "page":
      return { href: "/dashboard/builder", section: "builder" };
    case "blog_post":
      return { href: "/dashboard/blogs", section: "blogs" };
    case "collection":
      return { href: "/dashboard/categories", section: "categories" };
    case "review": {
      const author = text(row.author_user_id);
      return author
        ? {
            href: `/dashboard/users/${encodeURIComponent(author)}`,
            section: "users",
          }
        : null;
    }
    case "file":
      return { href: "/dashboard/media", section: "media" };
    default:
      return null;
  }
}

function readMessage(raw: unknown): StoreNoticeMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (!isUuid(row.id)) return null;
  const createdAt = isoOf(row.created_at);
  if (!createdAt) return null;
  const fromStoreMink = row.from_side === "storemink";
  if (!fromStoreMink && row.from_side !== "store") return null;
  return {
    id: row.id.toLowerCase(),
    fromStoreMink,
    // StoreMink's messages never carry the operator's address to the store.
    author: fromStoreMink
      ? NOTICE.storeMinkAuthor
      : text(row.author) || storeReplyAuthor(null, false),
    body: text(row.body),
    asksReview: row.asks_review === true,
    createdAt,
  };
}

/**
 * One notice with its conversation, or null when the block is not this
 * store's, was kept from it, was erased or does not exist ("not found",
 * D21). Throws on a database error.
 */
export async function getStoreNotice(
  storeId: string,
  blockId: string,
): Promise<StoreNotice | null> {
  if (!isUuid(storeId) || !isUuid(blockId)) return null;
  return withService(async (db) => {
    const found = await db.execute(sql`
      select b.id::text as id, b.parent_block_id::text as parent_block_id,
             b.item_kind, b.item_id::text as item_id, b.item_label,
             b.object_path, b.file_source, b.author_user_id, b.reason_kind,
             b.complaint_id::text as complaint_id,
             (select c.ref_no from public.grievance_complaints c
               where c.id = b.complaint_id) as ref_no,
             b.store_message, b.blocked_at::text as blocked_at,
             b.lifted_at::text as lifted_at, b.lift_note,
             b.merchant_seen_at::text as merchant_seen_at,
             case b.item_kind
               when 'product' then exists (select 1 from public.products x
                 where x.id = b.item_id and x.store_id = b.store_id)
               when 'page' then exists (select 1 from public.store_pages x
                 where x.id = b.item_id and x.store_id = b.store_id)
               when 'blog_post' then exists (select 1 from public.blogs x
                 where x.id = b.item_id and x.store_id = b.store_id)
               when 'collection' then exists (select 1 from public.categories x
                 where x.id = b.item_id and x.store_id = b.store_id)
               when 'review' then exists (select 1 from public.product_reviews x
                 where x.id = b.item_id and x.store_id = b.store_id)
                 and exists (select 1 from public.users u
                 where u.id = b.author_user_id and u.store_id = b.store_id)
               when 'file' then b.file_source = 'bucket'
               else false
             end as item_exists
        from public.content_blocks b
       where b.id = ${blockId}::uuid and ${storeSees(storeId)}`);
    const raw = found.rows[0] as Record<string, unknown> | undefined;
    const row = readBlockRow(raw);
    if (!raw || !row) return null;
    const messages = await db.execute(sql`
      select m.id::text as id, m.from_side, m.author, m.body, m.asks_review,
             m.created_at::text as created_at
        from public.content_block_messages m
       where m.block_id = ${row.id}::uuid
       order by m.created_at, m.id`);
    const images = row.parentBlockId
      ? []
      : (
          await db.execute(sql`
            select b.id::text as id, b.item_label,
                   b.lifted_at::text as lifted_at
              from public.content_blocks b
             where b.parent_block_id = ${row.id}::uuid and ${storeSees(storeId)}
             order by b.blocked_at, b.id`)
        ).rows
          .map((image): StoreNoticeImage | null => {
            const r = image as Record<string, unknown>;
            if (!isUuid(r.id)) return null;
            return {
              blockId: r.id.toLowerCase(),
              label: text(r.item_label),
              lifted: isoOf(r.lifted_at) !== null,
            };
          })
          .filter((image): image is StoreNoticeImage => image !== null);
    const refNo = Number(raw.ref_no);
    return {
      blockId: row.id,
      kind: row.kind,
      contentType: row.contentType,
      itemLabel: row.itemLabel,
      reasonKind: row.reasonKind,
      blockedAt: row.blockedAt,
      liftedAt: row.liftedAt,
      seen: row.seen,
      images,
      parentBlockId: row.parentBlockId,
      complaintId: isUuid(raw.complaint_id)
        ? raw.complaint_id.toLowerCase()
        : null,
      reference:
        raw.ref_no !== null &&
        raw.ref_no !== undefined &&
        Number.isFinite(refNo)
          ? complaintRef(refNo)
          : null,
      storeMessage: text(raw.store_message),
      liftNote: text(raw.lift_note),
      edit: editLinkFor(row.kind, raw),
      messages: messages.rows
        .map(readMessage)
        .filter((message): message is StoreNoticeMessage => message !== null),
    };
  });
}

// ── Seen ────────────────────────────────────────────────────────────────────

/** The notification types StoreMink's notices ring the store's bell with. */
const STORE_NOTICE_EVENTS = [
  "store.content_blocked",
  "store.content_block_lifted",
  "store.content_block_reply",
] as const;

function noticeBlocks(storeId: string, blockId: string): SQL {
  return sql`select b.id from public.content_blocks b
              where ${storeSees(storeId)}
                and (b.id = ${blockId}::uuid or b.parent_block_id = ${blockId}::uuid)`;
}

/**
 * Someone at the store opened a notice: the block (and the images told with
 * it) is marked seen, StoreMink's messages on it are marked read, and the
 * viewer's own bell notifications about it are marked read.
 *
 * ★ Only the store's own staff mark the notice seen. `merchant_seen_at` is
 * what the console shows as "the store opened the notice", so a StoreMink
 * operator looking at the store's dashboard (an implicit superadmin with no
 * staff row) must not stamp it; their own bell is still cleared.
 *
 * Returns false when the notice is not this store's or was kept from it
 * (D21). Throws on a database error.
 */
export async function markNoticeSeen(
  storeId: string,
  blockId: string,
  viewer: UserIdentity,
): Promise<boolean> {
  if (!isUuid(storeId) || !isUuid(blockId) || !viewer?.uid) return false;
  const uid = viewer.uid;
  return withService(async (db) => {
    const found = await db.execute(sql`
      select b.id::text as id from public.content_blocks b
       where b.id = ${blockId}::uuid and ${storeSees(storeId)}`);
    if (!found.rows[0]) return false;
    const isStaff = sql`exists (select 1 from public.admins a
                                 where a.id = ${uid}
                                   and a.store_id = ${storeId}::uuid
                                   and a.is_suspended is not true)`;
    await db.execute(sql`
      update public.content_blocks b
         set merchant_seen_at = now()
       where ${storeSees(storeId)}
         and (b.id = ${blockId}::uuid or b.parent_block_id = ${blockId}::uuid)
         and b.merchant_seen_at is null
         and ${isStaff}`);
    await db.execute(sql`
      update public.content_block_messages m
         set seen_at = now()
       where m.from_side = 'storemink'
         and m.seen_at is null
         and m.block_id in (${noticeBlocks(storeId, blockId)})
         and ${isStaff}`);
    await db.execute(sql`
      update public.notifications n
         set read_at = now()
       where n.store_id = ${storeId}::uuid
         and n.recipient_id = ${uid}
         and n.read_at is null
         and n.type = any(${sql.param([...STORE_NOTICE_EVENTS])}::text[])
         and n.event_id in (
           select e.id from public.activity_events e
            where e.store_id = ${storeId}::uuid
              and e.subject_type = 'content_block'
              and e.subject_id in (
                select b.id::text from public.content_blocks b
                 where ${storeSees(storeId)}
                   and (b.id = ${blockId}::uuid
                        or b.parent_block_id = ${blockId}::uuid)))`);
    return true;
  });
}

// ── The home banner ─────────────────────────────────────────────────────────

export interface StoreNoticeSummary {
  /** Blocked items the store was told about and nobody there has opened. */
  unopened: number;
  /** The notice to open when there is exactly one; else null (the list). */
  onlyBlockId: string | null;
}

const NO_NOTICES: StoreNoticeSummary = { unopened: 0, onlyBlockId: null };

/**
 * What the dashboard home's banner needs (design 7.3): how many live notices
 * nobody at the store has opened. Images told with an item count with it, as
 * one notice. Never throws: a failed read is "no banner".
 */
export async function storeNoticeSummary(
  storeId: string,
): Promise<StoreNoticeSummary> {
  if (!isUuid(storeId)) return NO_NOTICES;
  try {
    return await withService(async (db) => {
      const result = await db.execute(sql`
        select count(*)::int as unopened,
               (array_agg(b.id::text order by b.blocked_at desc, b.id))[1] as first_id
          from public.content_blocks b
         where ${storeSees(storeId)}
           and b.parent_block_id is null
           and b.lifted_at is null
           and b.merchant_seen_at is null`);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      const unopened = Math.max(0, Math.trunc(Number(row?.unopened) || 0));
      const firstId = isUuid(row?.first_id) ? row.first_id.toLowerCase() : null;
      return { unopened, onlyBlockId: unopened === 1 ? firstId : null };
    });
  } catch (err) {
    logError("moderation: notice summary failed", loggableError(err), {
      storeId,
    });
    return NO_NOTICES;
  }
}

// ── Item marks ──────────────────────────────────────────────────────────────

/**
 * The live blocks of one kind the store was told about, keyed by the item's
 * id (a file by its stored object path), each mapped to the block id its
 * "See why" link opens. Blocks kept from the store are not included (D21):
 * the item then shows nothing. Never throws: a failed read marks nothing.
 */
export async function blockedItemIds(
  storeId: string,
  kind: ItemKind,
): Promise<Map<string, string>> {
  const marks = new Map<string, string>();
  const asked: unknown = kind;
  if (!isUuid(storeId) || !isOneOf(BLOCK_KINDS, asked) || asked === "store") {
    return marks;
  }
  try {
    const rows = await withService(async (db) => {
      const result = await db.execute(sql`
        select coalesce(b.item_id::text, b.object_path) as item_key,
               b.id::text as id
          from public.content_blocks b
         where ${storeSees(storeId)}
           and b.lifted_at is null
           and b.item_kind = ${asked}
         order by b.blocked_at, b.id`);
      return result.rows;
    });
    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const key = text(row.item_key);
      if (key && isUuid(row.id)) marks.set(key, row.id.toLowerCase());
    }
  } catch (err) {
    logError("moderation: blocked item read failed", loggableError(err), {
      storeId,
      kind,
    });
  }
  return marks;
}

// ── The store's reply ───────────────────────────────────────────────────────

export type StoreReplyResult =
  | { ok: true; messageId: string; notified: boolean }
  | { ok: false; error: string };

class NoticeRefusal extends Error {
  readonly sentence: string;
  constructor(sentence: string) {
    super(sentence);
    this.sentence = sentence;
  }
}

function fail(error: string): StoreReplyResult {
  return { ok: false, error };
}

/** The reply's text, or the sentence that refuses it. */
export function storeReplyBody(body: unknown): string | { error: string } {
  const value = typeof body === "string" ? body.trim() : "";
  if (!value) return { error: NOTICE_REPLY.errors.empty };
  if (value.length > NOTICE_REPLY_MAX) {
    return { error: NOTICE_REPLY.errors.tooLong };
  }
  return value;
}

/**
 * The store's reply on a notice (design 3.4, 7.1): a message from the store
 * signed with the sender's address, the `store_replied` record, then the
 * operators' bell and email. Refused for a block that is not this store's or
 * was kept from it ("not found", D21) and for a lifted block. The caller has
 * checked the viewer may manage Settings.
 */
export async function replyToStoreNotice(
  storeId: string,
  input: { blockId: string; body: string; asksReview: boolean },
  viewer: UserIdentity,
): Promise<StoreReplyResult> {
  if (!isUuid(storeId) || !isUuid(input?.blockId)) {
    return fail(NOTICE.notFound);
  }
  const body = storeReplyBody(input.body);
  if (typeof body !== "string") return fail(body.error);
  const asksReview = input.asksReview === true;
  const email = (viewer?.email ?? "").trim().toLowerCase();
  const author = storeReplyAuthor(email, false).slice(0, 320);
  const actor = (email || viewer?.uid || "").slice(0, 320);
  if (!actor) return fail(NOTICE_REPLY.errors.noPermission);

  let saved: { messageId: string; itemLabel: string; storeLabel: string };
  try {
    saved = await withService(async (db: Db) => {
      const found = await db.execute(sql`
        select b.id::text as id, b.item_label, b.store_label,
               b.lifted_at::text as lifted_at
          from public.content_blocks b
         where b.id = ${input.blockId}::uuid and ${storeSees(storeId)}
         for share of b`);
      const row = found.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new NoticeRefusal(NOTICE.notFound);
      if (isoOf(row.lifted_at) !== null) {
        throw new NoticeRefusal(NOTICE_REPLY.errors.lifted);
      }
      const inserted = await db.execute(sql`
        insert into public.content_block_messages
               (block_id, from_side, author, body, asks_review)
        values (${input.blockId}::uuid, 'store', ${author}, ${body}, ${asksReview})
        returning id::text as id`);
      const messageId = String(
        (inserted.rows[0] as { id?: unknown } | undefined)?.id ?? "",
      );
      await recordModerationEvent(db, {
        actor,
        action: "store_replied",
        blockId: input.blockId,
        storeId,
        detail: { messageId, asksReview },
      });
      return {
        messageId,
        itemLabel: text(row.item_label),
        storeLabel: text(row.store_label),
      };
    });
  } catch (err) {
    if (err instanceof NoticeRefusal) return fail(err.sentence);
    logError("moderation: store reply failed", loggableError(err), {
      storeId,
      blockId: input.blockId,
    });
    return fail(NOTICE_REPLY.failed);
  }

  // After the commit, never inside it (notify.ts): the operators' bell and
  // email. A failure here loses the alert, never the reply.
  let notified = false;
  try {
    const eventId = await notifyTakedownReply({
      blockId: input.blockId,
      itemLabel: saved.itemLabel,
      storeName: saved.storeLabel,
      askedForReview: asksReview,
    });
    notified = eventId !== null;
  } catch (err) {
    logError("moderation: store reply notice failed", loggableError(err), {
      storeId,
      blockId: input.blockId,
    });
  }
  return { ok: true, messageId: saved.messageId, notified };
}
