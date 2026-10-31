import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { isUniqueViolation, loggableError } from "@/lib/db/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import { pingIndexNow } from "@/lib/seo/search-engines";
import { forgetBlockedObjects } from "./blocked-objects";
import {
  actionComplaintForBlock,
  storeLabelFor,
  type ModerationOperator,
} from "./complaints";
import {
  NOTICE_REPLY,
  NOTICE_REPLY_MAX,
  defaultStoreMessage,
  storeReplyAuthor,
} from "./copy";
import {
  BLOCK_KINDS,
  BLOCK_REASONS,
  complaintRef,
  isOneOf,
  isOrderReason,
  type BlockKind,
  type BlockReason,
} from "./kinds";
import { isMediaKey, mediaKeyFromUrl, type MediaKey } from "./media-key";
import { referencedMediaKeys } from "./media-refs";
import {
  tellStoreOfBlock,
  tellStoreOfLift,
  tellStoreOfReply,
  type StoreTellResult,
} from "./notify";
import { recordModerationEvent } from "./record";
import {
  addressesFor,
  buildSnapshot,
  contentTypeFromName,
  fileLabelFor,
  filesStateFor,
  hashForStorage,
  isRowKind,
  itemLabelFor,
  itemPath,
  pendingArchiveFile,
  readFileUsages,
  readHistory,
  readItemRow,
  readMediaAsset,
  readRelated,
  readStoreContext,
  readStoreRow,
  readVariants,
  storeFactsFromRow,
  storeOrigins,
  type ArchiveFileEntry,
  type JsonRow,
  type RowKind,
  type SnapshotFile,
  type SnapshotStore,
  type SnapshotStoreContent,
  type StoreFacts,
} from "./snapshot";
import { writeStoreContent } from "./store-content";
import {
  archiveBucketFile,
  discardArchiveCopy,
  moderationStorage,
  parseArchivedFile,
  restoreFromArchive,
  type ArchivedFile,
  type ModerationStorage,
  type RestoreOutcome,
} from "./storage";

/**
 * Blocking and lifting (takedown design 3.4 to 3.6, 5.3, 5.4).
 *
 * `blockItem` follows design 5.3's five steps in that order, because the
 * evidence must exist before anything is hidden:
 *   1. validate (pure);
 *   2. ARCHIVE FIRST, under a new block id, before the block row exists: the
 *      item's bucket files copied to the private archive (at most
 *      `BLOCK_LIMITS.inlineCopies`, four at a time; anything else listed
 *      for the every-minute follow-up), and for a whole store its copy
 *      (`store-content.jsonl`), REFUSED when storage is unavailable, because a
 *      suspension must not go ahead without its record;
 *   3. ONE `withService` transaction: the item (or store) row locked
 *      `FOR UPDATE`, the snapshot built from the locked row, its hash taken
 *      over the jsonb read back (`hashForStorage`), the block inserted (its
 *      trigger hides the row or suspends the store), the archive, any image
 *      blocks, the complaint actioned, the events; a failure deletes the
 *      copies this attempt made and nothing is hidden;
 *   4. after commit, never inside the transaction: this instance's blocked
 *      set forgotten, the store told (claimed through `notice_claimed_at`, so
 *      the follow-up cannot send it twice), IndexNow pinged;
 *   5. the block id and any warnings returned.
 * No follow-up runs inline here (T15 runs it outside production).
 *
 * `liftBlock` follows design 3.5: one statement lifts the block (and its
 * image blocks), cancelling a replacement not yet made or starting the
 * restore of one that was; after commit, in this order, the originals are
 * written back, THEN the blocked set is forgotten (an optimizer must never
 * see the address unblocked while the placeholder is still at it, T7), THEN
 * the store is told, THEN IndexNow pinged.
 *
 * Every function takes the operator as the console resolved them and checks
 * the role of design 3.10 itself; the server action re-checks too.
 */

// ── Limits and sentences ────────────────────────────────────────────────────

export const BLOCK_LIMITS = {
  message: 2000,
  legalBasis: 1000,
  liftNote: 2000,
  reply: NOTICE_REPLY_MAX,
  /** Images blocked with an item in one go. */
  alsoBlockImages: 50,
  /** Bucket files copied inline per block action; the rest wait. */
  inlineCopies: 40,
  copyConcurrency: 4,
  /** A bucket file's replacement waits this long (design 3.3 step 5). */
  replaceDelaySeconds: 35,
  /** A claim lapses after this many minutes (design 8.1). */
  claimMinutes: 2,
  emailAuthor: 320,
} as const;

/** Every sentence the block actions answer with (design 6.5, 6.6). */
export const BLOCK_ERRORS = {
  notOperator: "Only a StoreMink operator can block content.",
  storeSuperadmin: "Only a superadmin can suspend a whole store.",
  untoldSuperadmin: "Only a superadmin can keep a block from the store.",
  untoldNeedsOrder:
    "To keep a block from the store, choose the court or government order and fill in its legal basis.",
  alreadyBlocked: "This is already blocked.",
  storageForStore:
    "StoreMink's storage is unavailable, so the store's copy can't be made yet. Try again in a few minutes, or block the items that cannot wait one by one.",
  storeTooLarge:
    "The store holds too much to copy in one go, so it can't be suspended from here. Block the items that cannot wait one by one.",
  failed: "Could not block it. Nothing was changed. Please try again.",
  changed: "It changed while you were blocking it. Find it again.",
  notStoreMinkFile: "That file is not one StoreMink serves.",
  fileOtherStore: "That file belongs to another store.",
  chooseKind: "Choose what to block.",
  chooseReason: "Choose a reason.",
  storeRequestKind: "A store can ask us to remove only a review or a comment.",
  messageMissing: "Write a message to the store.",
  messageTooLong: "Keep the message to the store under 2,000 characters.",
  legalBasisTooLong: "Keep the legal basis under 1,000 characters.",
  complaintNotFound: "That complaint was not found.",
  complaintOtherStore: "That complaint is about another store.",
  liftSuperadmin: "Only a superadmin can lift a block.",
  liftNoteMissing: "Write why you are lifting it.",
  liftNoteTooLong: "Keep it under 2,000 characters.",
  liftReplacing:
    "StoreMink is replacing this file right now. Try again in a minute.",
  liftFailed: "Could not lift it. Nothing was changed. Please try again.",
  blockNotFound: "That block was not found.",
  alreadyLifted: "This block was already lifted.",
  tellSuperadmin: "Only a superadmin can tell the store later.",
  alreadyTold: "The store has already been told.",
  notManual:
    "Only a file built into a StoreMink theme is marked as removed by hand.",
  removedNoteMissing: "Write how it was removed.",
  replyEmpty: NOTICE_REPLY.errors.empty,
  replyTooLong: "Keep it under 4,000 characters.",
  replyNotTold:
    "The store has not been told about this block, so there is no one to reply to yet.",
  emailInvalid: "Enter the email address the reply came from.",
  nothingToRetry: "Nothing is waiting to be retried.",
  retryLifted: "This block was lifted, so there is nothing to retry.",
  saveFailed: "Could not save that. Nothing was changed. Please try again.",
} as const;

/** Warnings a block or a lift returns (design 6.5, 6.6). */
export const BLOCK_WARNINGS = {
  archivePending:
    "The file could not be archived yet, so it is still at its storage address, although pages no longer show it. StoreMink retries every minute.",
  imagesAlreadyBlocked:
    "Some images were already blocked, so they keep their own blocks.",
  notRestored: "Not restored: the file was changed or removed",
  restoreRetrying:
    "The original file could not be put back yet. StoreMink retries every minute.",
} as const;

export type BlockFailure = { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ITEM_URL_MAX = 2048;
const OBJECT_PATH_MAX = 2048;

function fail(error: string): BlockFailure {
  return { ok: false, error };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function actorOf(operator: ModerationOperator | null | undefined): string {
  return (operator?.email ?? "").trim();
}

/** A refusal raised inside a transaction, so it rolls back. */
class BlockRefusal extends Error {
  readonly sentence: string;
  constructor(sentence: string) {
    super(sentence);
    this.sentence = sentence;
  }
}

/** The apply trigger's refusal (`content_blocks: no ...`): the row changed. */
function isRecordMismatch(err: unknown): boolean {
  const message = (e: unknown): string =>
    e && typeof e === "object" && typeof (e as Error).message === "string"
      ? (e as Error).message
      : "";
  const cause =
    err && typeof err === "object" ? (err as { cause?: unknown }).cause : null;
  return [message(cause), message(err)].some((text) =>
    text.includes("content_blocks: no "),
  );
}

function storeIdOfKey(key: MediaKey): string | null {
  if (key.source !== "bucket") return null;
  const segments = key.key.split("/");
  return segments[0] === "stores" && isUuid(segments[1])
    ? segments[1].toLowerCase()
    : null;
}

/** A bucket object's public address. */
function bucketAddress(bucket: string | null, key: string): string {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `https://storage.googleapis.com/${bucket ?? ""}/${path}`;
}

function clipUrl(value: string): string {
  return value.slice(0, ITEM_URL_MAX);
}

// ── 1. Validation ───────────────────────────────────────────────────────────

export interface BlockInput {
  kind: BlockKind;
  /** The store; for a file, derived from a `stores/<id>/` path when absent. */
  storeId?: string | null;
  /** The row (product, page, post, collection, review, comment). */
  itemId?: string | null;
  /** A file's address, in any spelling `mediaKeyFromUrl` reads. */
  fileAddress?: string | null;
  reason: BlockReason;
  legalBasis?: string | null;
  complaintId?: string | null;
  storeMessage: string;
  /** Tell the store (default). Only a superadmin may say no (design 3.4). */
  tellStore?: boolean;
  /** The item's images to block as their own file blocks (design 6.5). */
  alsoBlockImages?: readonly string[] | null;
}

interface FileTarget {
  key: MediaKey;
  /** The address as the operator gave it, trimmed. */
  address: string;
}

export interface ValidBlock {
  kind: BlockKind;
  reason: BlockReason;
  storeId: string | null;
  itemId: string | null;
  file: FileTarget | null;
  legalBasis: string;
  complaintId: string | null;
  storeMessage: string;
  tellStore: boolean;
  images: FileTarget[];
  actor: string;
}

const IMAGE_BLOCK_KINDS: ReadonlySet<BlockKind> = new Set([
  "product",
  "page",
  "blog_post",
  "collection",
]);

/**
 * Design 5.3 step 1, with nothing read: the role rules of design 3.10, the
 * table's CHECKs as sentences, the ids, and the file's normal form.
 */
export function validateBlockInput(
  input: BlockInput,
  operator: ModerationOperator,
  bucket: string | null,
): { ok: true; value: ValidBlock } | BlockFailure {
  const actor = actorOf(operator);
  if (!actor) return fail(BLOCK_ERRORS.notOperator);
  if (!isOneOf(BLOCK_KINDS, input?.kind)) return fail(BLOCK_ERRORS.chooseKind);
  if (!isOneOf(BLOCK_REASONS, input.reason)) {
    return fail(BLOCK_ERRORS.chooseReason);
  }
  const kind = input.kind;
  const reason = input.reason;
  if (
    reason === "store_request" &&
    kind !== "review" &&
    kind !== "blog_comment"
  ) {
    return fail(BLOCK_ERRORS.storeRequestKind);
  }
  if (kind === "store" && operator.role !== "superadmin") {
    return fail(BLOCK_ERRORS.storeSuperadmin);
  }
  const legalBasis = (input.legalBasis ?? "").trim();
  if (legalBasis.length > BLOCK_LIMITS.legalBasis) {
    return fail(BLOCK_ERRORS.legalBasisTooLong);
  }
  const tellStore = input.tellStore !== false;
  if (!tellStore) {
    if (operator.role !== "superadmin") {
      return fail(BLOCK_ERRORS.untoldSuperadmin);
    }
    if (!isOrderReason(reason) || !legalBasis) {
      return fail(BLOCK_ERRORS.untoldNeedsOrder);
    }
  }
  const storeMessage = (input.storeMessage ?? "").trim();
  if (!storeMessage) return fail(BLOCK_ERRORS.messageMissing);
  if (storeMessage.length > BLOCK_LIMITS.message) {
    return fail(BLOCK_ERRORS.messageTooLong);
  }
  let complaintId: string | null = null;
  if (input.complaintId !== null && input.complaintId !== undefined) {
    if (!isUuid(input.complaintId)) {
      return fail(BLOCK_ERRORS.complaintNotFound);
    }
    complaintId = input.complaintId.toLowerCase();
  }

  let storeId: string | null = null;
  if (
    input.storeId !== null &&
    input.storeId !== undefined &&
    input.storeId !== ""
  ) {
    if (!isUuid(input.storeId)) return fail(BLOCK_ERRORS.changed);
    storeId = input.storeId.toLowerCase();
  }

  let itemId: string | null = null;
  let file: FileTarget | null = null;
  if (kind === "file") {
    const address = (input.fileAddress ?? "").trim();
    const key = mediaKeyFromUrl(address, { bucket });
    if (!isMediaKey(key) || key.key.length > OBJECT_PATH_MAX) {
      return fail(BLOCK_ERRORS.notStoreMinkFile);
    }
    const owner = storeIdOfKey(key);
    if (owner && storeId && owner !== storeId) {
      return fail(BLOCK_ERRORS.fileOtherStore);
    }
    storeId = storeId ?? owner;
    file = { key, address };
  } else if (kind === "store") {
    const named = input.itemId ?? storeId;
    if (!isUuid(named)) return fail(BLOCK_ERRORS.chooseKind);
    if (storeId && named.toLowerCase() !== storeId) {
      return fail(BLOCK_ERRORS.changed);
    }
    storeId = named.toLowerCase();
    itemId = storeId;
  } else {
    if (!storeId || !isUuid(input.itemId)) {
      return fail(BLOCK_ERRORS.chooseKind);
    }
    itemId = input.itemId.toLowerCase();
  }

  const images: FileTarget[] = [];
  if (IMAGE_BLOCK_KINDS.has(kind) && input.alsoBlockImages) {
    const seen = new Set<string>();
    for (const raw of input.alsoBlockImages) {
      if (images.length >= BLOCK_LIMITS.alsoBlockImages) break;
      const address = typeof raw === "string" ? raw.trim() : "";
      const key = mediaKeyFromUrl(address, { bucket });
      if (!isMediaKey(key) || key.key.length > OBJECT_PATH_MAX) continue;
      const id = `${key.source} ${key.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      images.push({ key, address });
    }
  }

  return {
    ok: true,
    value: {
      kind,
      reason,
      storeId,
      itemId,
      file,
      legalBasis,
      complaintId,
      storeMessage,
      tellStore,
      images,
      actor,
    },
  };
}

// ── 2. The archive, before the block exists ─────────────────────────────────

interface CreatedCopy {
  path: string;
  generation: string | null;
}

/** The media an item's row (and a product's variants) use. */
export function itemFileKeys(
  kind: BlockKind,
  row: JsonRow | null,
  variants: readonly JsonRow[],
  bucket: string | null,
): MediaKey[] {
  if (!row) return [];
  const value = kind === "product" ? { row, variants } : row;
  return referencedMediaKeys(value, { bucket });
}

async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await work(items[index]);
      }
    },
  );
  await Promise.all(lanes);
}

/**
 * Archive `keys` for one block, numbered from `firstN`: a bucket file is
 * copied now while the inline budget lasts (design 5.3 step 2), anything
 * else, and a copy that did not finish, becomes a pending entry for the
 * follow-up. Never throws.
 */
async function archiveKeys(
  blockId: string,
  keys: readonly MediaKey[],
  storage: ModerationStorage,
  budget: { inline: number },
  at: string,
  firstN = 1,
): Promise<{ entries: ArchiveFileEntry[]; created: CreatedCopy[] }> {
  const entries: ArchiveFileEntry[] = [];
  const created: CreatedCopy[] = [];
  const copies: { n: number; key: MediaKey }[] = [];
  keys.forEach((key, index) => {
    const n = firstN + index;
    if (key.source === "bucket" && budget.inline > 0) {
      budget.inline -= 1;
      copies.push({ n, key });
    } else {
      entries.push(
        pendingArchiveFile({ n, source: key.source, path: key.key, at }),
      );
    }
  });
  await runPool(copies, BLOCK_LIMITS.copyConcurrency, async ({ n, key }) => {
    let entry: ArchiveFileEntry;
    try {
      const result = await archiveBucketFile(
        { blockId, n, path: key.key },
        storage,
      );
      if (result.ok && result.file.state !== "changed") {
        entry = result.file;
        if (result.created && result.file.archivePath) {
          created.push({
            path: result.file.archivePath,
            generation: result.file.archiveGeneration,
          });
        }
      } else {
        // Not copied, or the generation read moved before the copy (storage's
        // `changed`): the follow-up copies what is there then.
        entry = pendingArchiveFile({ n, source: "bucket", path: key.key, at });
      }
    } catch {
      entry = pendingArchiveFile({ n, source: "bucket", path: key.key, at });
    }
    entries.push(entry);
  });
  entries.sort((a, b) => a.n - b.n);
  return { entries, created };
}

/** Delete the copies an attempt made (design 5.3 step 3). Never throws. */
async function discardCopies(
  copies: readonly CreatedCopy[],
  storage: ModerationStorage,
): Promise<void> {
  for (const copy of copies) {
    try {
      const result = await discardArchiveCopy(copy, storage);
      if (!result.ok) {
        logWarn("moderation: archive copy not discarded", {
          path: copy.path,
          reason: result.failure.code,
        });
      }
    } catch (err) {
      logError("moderation: archive copy not discarded", loggableError(err), {
        path: copy.path,
      });
    }
  }
}

function entryKey(entry: ArchiveFileEntry): string {
  return `${entry.source} ${entry.path}`;
}

function copiedEntryFor(
  entries: readonly ArchiveFileEntry[],
  key: MediaKey,
): ArchivedFile | null {
  for (const entry of entries) {
    if (
      entry.state !== "pending" &&
      entry.source === key.source &&
      entry.path === key.key
    ) {
      return entry;
    }
  }
  return null;
}

// ── 3. The transaction ──────────────────────────────────────────────────────

interface ChildPlan {
  id: string;
  target: FileTarget;
  entries: ArchiveFileEntry[];
}

interface BlockPlan {
  blockId: string;
  valid: ValidBlock;
  bucket: string | null;
  entries: ArchiveFileEntry[];
  storeContent: SnapshotStoreContent | null;
  children: ChildPlan[];
  complaint: { id: string; refNo: number } | null;
  capturedAt: Date;
  at: string;
}

interface BlockRowValues {
  id: string;
  storeId: string | null;
  storeLabel: string;
  kind: BlockKind;
  itemId: string | null;
  objectPath: string | null;
  objectMd5: string | null;
  fileSource: string | null;
  authorUserId: string | null;
  parentItemId: string | null;
  storeStatusBefore: string | null;
  parentBlockId: string | null;
  itemLabel: string;
  itemUrl: string;
  complaintId: string | null;
  reason: BlockReason;
  legalBasis: string;
  storeMessage: string;
  tellStore: boolean;
  storageState: string;
  actor: string;
}

async function insertBlockRow(db: Db, row: BlockRowValues): Promise<string> {
  const result = await db.execute(sql`
    insert into public.content_blocks (
      id, store_id, store_label, item_kind, item_id, object_path, object_md5,
      file_source, author_user_id, parent_item_id, store_status_before,
      parent_block_id, item_label, item_url, complaint_id, reason_kind,
      legal_basis, store_message, tell_store, storage_state,
      storage_next_attempt_at, blocked_by)
    values (
      ${row.id}::uuid, ${row.storeId}::uuid, ${row.storeLabel}, ${row.kind},
      ${row.itemId}::uuid, ${row.objectPath}, ${row.objectMd5},
      ${row.fileSource}, ${row.authorUserId}, ${row.parentItemId}::uuid,
      ${row.storeStatusBefore}, ${row.parentBlockId}::uuid, ${row.itemLabel},
      ${row.itemUrl}, ${row.complaintId}::uuid, ${row.reason},
      ${row.legalBasis}, ${row.storeMessage}, ${row.tellStore},
      ${row.storageState},
      case when ${row.storageState} = 'pending'
           then now() + interval '35 seconds' else null end,
      ${row.actor})
    returning blocked_at::text as blocked_at`);
  const blockedAt = (result.rows[0] as { blocked_at?: unknown } | undefined)
    ?.blocked_at;
  return typeof blockedAt === "string" ? blockedAt : "";
}

async function insertArchiveRow(
  db: Db,
  input: {
    blockId: string;
    storeId: string | null;
    json: string;
    sha256: string;
    entries: readonly ArchiveFileEntry[];
  },
): Promise<"copied" | "pending"> {
  const filesState = filesStateFor(input.entries);
  await db.execute(sql`
    insert into public.content_block_archives (
      block_id, store_id, snapshot, snapshot_sha256, files, files_state,
      files_next_attempt_at, keep_until)
    values (
      ${input.blockId}::uuid, ${input.storeId}::uuid, ${input.json}::jsonb,
      ${input.sha256}, ${JSON.stringify(input.entries)}::jsonb, ${filesState},
      case when ${filesState} = 'pending' then now() else null end,
      now() + interval '180 days')`);
  return filesState;
}

/** The storage state a file block starts in, by source (CHECK). */
function startingStorageState(source: MediaKey["source"]): string {
  if (source === "bucket") return "pending";
  if (source === "external") return "not_ours";
  return "manual";
}

function snapshotStore(
  store: StoreFacts | null,
  row: JsonRow | null,
  context: {
    owners: string[];
    chrome: JsonRow | null;
    menus: JsonRow | null;
  } | null,
  origins: string[],
): SnapshotStore | null {
  if (!store || !row) return null;
  return {
    row,
    addresses: origins,
    owners: context?.owners ?? [],
    chrome: context?.chrome ?? null,
    menus: context?.menus ?? null,
  };
}

function fileAddressFor(
  target: FileTarget,
  bucket: string | null,
  origins: readonly string[],
): string {
  if (target.key.source === "bucket")
    return bucketAddress(bucket, target.key.key);
  if (target.key.source === "external") return target.key.key;
  return origins[0] ? `${origins[0]}${target.key.key}` : target.key.key;
}

interface Committed {
  blockedAt: string;
  addresses: string[];
  childIds: string[];
}

async function commitBlock(db: Db, plan: BlockPlan): Promise<Committed> {
  const { valid, blockId, bucket } = plan;
  const { kind } = valid;

  // Lock the item, or the store for a whole store (design 5.3 step 3).
  let storeRow: JsonRow | null = null;
  if (valid.storeId) {
    storeRow = await readStoreRow(db, valid.storeId, {
      lock: kind === "store",
    });
    if (!storeRow) throw new BlockRefusal(BLOCK_ERRORS.changed);
  }
  const store = storeRow ? storeFactsFromRow(storeRow) : null;
  if (
    kind === "store" &&
    !["active", "pending", "suspended"].includes(store?.status ?? "")
  ) {
    throw new BlockRefusal(BLOCK_ERRORS.changed);
  }

  const entries = [...plan.entries];
  let itemRow: JsonRow | null = null;
  let variants: JsonRow[] = [];
  if (isRowKind(kind)) {
    itemRow = await readItemRow(db, kind, valid.storeId!, valid.itemId!, {
      lock: true,
    });
    if (!itemRow) throw new BlockRefusal(BLOCK_ERRORS.changed);
    if (kind === "product") {
      variants = await readVariants(db, valid.storeId!, valid.itemId!);
    }
    // ★ The item changed after the copy (an image added): what it uses now
    // and the archive does not hold waits for the follow-up.
    const held = new Set(entries.map(entryKey));
    let n = entries.reduce((max, entry) => Math.max(max, entry.n), 0);
    for (const key of itemFileKeys(kind, itemRow, variants, bucket)) {
      if (held.has(`${key.source} ${key.key}`)) continue;
      n += 1;
      entries.push(
        pendingArchiveFile({
          n,
          source: key.source,
          path: key.key,
          at: plan.at,
        }),
      );
      held.add(`${key.source} ${key.key}`);
    }
  }

  const context = store ? await readStoreContext(db, store.id) : null;
  const origins = store ? storeOrigins(store, plan.capturedAt) : [];
  let related: Record<string, unknown> = {};
  let parentName: string | null = null;
  let parentPath: string | null = null;
  if (isRowKind(kind) && itemRow) {
    ({ related, parentName, parentPath } = await readRelated(
      db,
      kind as RowKind,
      valid.storeId!,
      itemRow,
    ));
  }
  const history =
    store && valid.itemId ? await readHistory(db, store.id, valid.itemId) : [];

  let fileInfo: SnapshotFile | null = null;
  let addresses: string[] = [];
  let itemLabel: string;
  if (kind === "file" && valid.file) {
    const target = valid.file;
    const address = fileAddressFor(target, bucket, origins);
    fileInfo = {
      source: target.key.source,
      key: target.key.key,
      address: target.address || address,
      metadata: copiedEntryFor(entries, target.key),
      mediaAsset: store
        ? await readMediaAsset(db, store.id, target.key.key)
        : null,
      usages: store ? await readFileUsages(db, store.id, [target.key.key]) : [],
    };
    addresses = [address];
    itemLabel = fileLabelFor(target.key.source, target.key.key);
  } else if (kind === "store") {
    addresses = addressesFor(origins, "/");
    itemLabel = itemLabelFor("store", storeRow);
  } else if (kind === "review" || kind === "blog_comment") {
    addresses = addressesFor(origins, parentPath);
    itemLabel = itemLabelFor(kind, itemRow, { parentName });
  } else {
    const slug = typeof itemRow?.slug === "string" ? itemRow.slug : null;
    addresses = addressesFor(origins, itemPath(kind, slug));
    itemLabel = itemLabelFor(kind, itemRow);
  }
  const storeLabel = store ? storeLabelFor(store) : "No store";
  const snapshotStoreValue = snapshotStore(store, storeRow, context, origins);

  const snapshot = buildSnapshot({
    capturedAt: plan.capturedAt,
    block: {
      id: blockId,
      kind,
      reason: valid.reason,
      complaint: plan.complaint
        ? { id: plan.complaint.id, ref: complaintRef(plan.complaint.refNo) }
        : null,
      legalBasis: valid.legalBasis,
      tellStore: valid.tellStore,
      blockedBy: valid.actor,
      parentBlockId: null,
    },
    store: snapshotStoreValue,
    item: { kind, row: itemRow, file: fileInfo },
    related,
    history,
    addresses,
    storeContent: plan.storeContent,
  });
  const hashed = await hashForStorage(db, snapshot);

  const copied = valid.file ? copiedEntryFor(entries, valid.file.key) : null;
  const blockedAt = await insertBlockRow(db, {
    id: blockId,
    storeId: valid.storeId,
    storeLabel,
    kind,
    itemId: valid.itemId,
    objectPath: valid.file?.key.key ?? null,
    objectMd5:
      copied && copied.state === "copied" && copied.md5 ? copied.md5 : null,
    fileSource: valid.file?.key.source ?? null,
    authorUserId:
      kind === "review" || kind === "blog_comment"
        ? stringOrNull(itemRow?.user_id)
        : null,
    parentItemId:
      kind === "review"
        ? stringOrNull(itemRow?.product_id)
        : kind === "blog_comment"
          ? stringOrNull(itemRow?.blog_id)
          : null,
    storeStatusBefore: kind === "store" ? (store?.status ?? null) : null,
    parentBlockId: null,
    itemLabel,
    itemUrl: clipUrl(addresses[0] ?? ""),
    complaintId: valid.complaintId,
    reason: valid.reason,
    legalBasis: valid.legalBasis,
    storeMessage: valid.storeMessage,
    tellStore: valid.tellStore,
    storageState: valid.file
      ? startingStorageState(valid.file.key.source)
      : "none",
    actor: valid.actor,
  });
  const filesState = await insertArchiveRow(db, {
    blockId,
    storeId: valid.storeId,
    json: hashed.json,
    sha256: hashed.sha256,
    entries,
  });
  await recordModerationEvent(db, {
    actor: valid.actor,
    action: "block_created",
    blockId,
    storeId: valid.storeId,
    complaintId: valid.complaintId,
    detail: {
      kind,
      reason: valid.reason,
      tellStore: valid.tellStore,
      images: plan.children.length,
    },
  });
  await recordModerationEvent(db, {
    actor: valid.actor,
    action: "archive_written",
    blockId,
    storeId: valid.storeId,
    detail: { files: entries.length, filesState, sha256: hashed.sha256 },
  });

  // The item's images, each its own file block with its own archive.
  const childIds: string[] = [];
  const usages =
    store && plan.children.length > 0
      ? await readFileUsages(
          db,
          store.id,
          plan.children.map((child) => child.target.key.key),
        )
      : [];
  for (const child of plan.children) {
    const target = child.target;
    const address = fileAddressFor(target, bucket, origins);
    const childCopied = copiedEntryFor(child.entries, target.key);
    const childLabel = fileLabelFor(target.key.source, target.key.key);
    const childSnapshot = buildSnapshot({
      capturedAt: plan.capturedAt,
      block: {
        id: child.id,
        kind: "file",
        reason: valid.reason,
        complaint: snapshot.block.complaint,
        legalBasis: valid.legalBasis,
        tellStore: valid.tellStore,
        blockedBy: valid.actor,
        parentBlockId: blockId,
      },
      store: snapshotStoreValue,
      item: {
        kind: "file",
        row: null,
        file: {
          source: target.key.source,
          key: target.key.key,
          address: target.address || address,
          metadata: childCopied,
          mediaAsset: store
            ? await readMediaAsset(db, store.id, target.key.key)
            : null,
          usages: usages.filter((usage) => usage.key === target.key.key),
        },
      },
      related: { parent: { blockId, kind, label: itemLabel } },
      history: [],
      addresses: [address],
    });
    const childHash = await hashForStorage(db, childSnapshot);
    const contentType =
      childCopied?.contentType ?? contentTypeFromName(target.key.key);
    await insertBlockRow(db, {
      id: child.id,
      storeId: valid.storeId,
      storeLabel,
      kind: "file",
      itemId: null,
      objectPath: target.key.key,
      objectMd5:
        childCopied && childCopied.state === "copied" && childCopied.md5
          ? childCopied.md5
          : null,
      fileSource: target.key.source,
      authorUserId: null,
      parentItemId: null,
      storeStatusBefore: null,
      parentBlockId: blockId,
      itemLabel: childLabel,
      itemUrl: clipUrl(address),
      complaintId: valid.complaintId,
      reason: valid.reason,
      legalBasis: valid.legalBasis,
      storeMessage:
        defaultStoreMessage(valid.reason, "file", contentType) ??
        valid.storeMessage,
      tellStore: valid.tellStore,
      storageState: startingStorageState(target.key.source),
      actor: valid.actor,
    });
    const childFilesState = await insertArchiveRow(db, {
      blockId: child.id,
      storeId: valid.storeId,
      json: childHash.json,
      sha256: childHash.sha256,
      entries: child.entries,
    });
    await recordModerationEvent(db, {
      actor: valid.actor,
      action: "block_created",
      blockId: child.id,
      storeId: valid.storeId,
      complaintId: valid.complaintId,
      detail: { kind: "file", reason: valid.reason, parentBlockId: blockId },
    });
    await recordModerationEvent(db, {
      actor: valid.actor,
      action: "archive_written",
      blockId: child.id,
      storeId: valid.storeId,
      detail: {
        files: child.entries.length,
        filesState: childFilesState,
        sha256: childHash.sha256,
      },
    });
    childIds.push(child.id);
  }

  if (plan.complaint) {
    await actionComplaintForBlock(db, {
      complaintId: plan.complaint.id,
      actor: valid.actor,
      blockId,
      storeId: valid.storeId,
    });
  }

  return { blockedAt, addresses, childIds };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

// ── Reads before the archive (no locks) ─────────────────────────────────────

interface PreRead {
  itemRow: JsonRow | null;
  variants: JsonRow[];
  complaint: { id: string; refNo: number } | null;
  liveImagePaths: Set<string>;
}

async function preRead(valid: ValidBlock): Promise<PreRead | BlockFailure> {
  try {
    return await withService(async (db): Promise<PreRead | BlockFailure> => {
      if (valid.storeId) {
        const storeRow = await readStoreRow(db, valid.storeId);
        if (!storeRow) return fail(BLOCK_ERRORS.changed);
      }
      const live = valid.file
        ? await db.execute(sql`
            select b.id from public.content_blocks b
             where b.object_path = ${valid.file.key.key} and b.lifted_at is null
             limit 1`)
        : await db.execute(sql`
            select b.id from public.content_blocks b
             where b.item_kind = ${valid.kind} and b.item_id = ${valid.itemId}::uuid
               and b.lifted_at is null
             limit 1`);
      if (live.rows.length > 0) return fail(BLOCK_ERRORS.alreadyBlocked);

      let itemRow: JsonRow | null = null;
      let variants: JsonRow[] = [];
      if (isRowKind(valid.kind)) {
        itemRow = await readItemRow(
          db,
          valid.kind,
          valid.storeId!,
          valid.itemId!,
        );
        if (!itemRow) return fail(BLOCK_ERRORS.changed);
        if (valid.kind === "product") {
          variants = await readVariants(db, valid.storeId!, valid.itemId!);
        }
      }

      let complaint: PreRead["complaint"] = null;
      if (valid.complaintId) {
        const found = await db.execute(sql`
          select c.id::text as id, c.ref_no, c.store_id::text as store_id
            from public.grievance_complaints c
           where c.id = ${valid.complaintId}::uuid`);
        const row = found.rows[0] as
          | { id?: unknown; ref_no?: unknown; store_id?: unknown }
          | undefined;
        if (!row || typeof row.id !== "string") {
          return fail(BLOCK_ERRORS.complaintNotFound);
        }
        // A complaint about one store never actions a block on another.
        if (
          typeof row.store_id === "string" &&
          valid.storeId &&
          row.store_id !== valid.storeId
        ) {
          return fail(BLOCK_ERRORS.complaintOtherStore);
        }
        complaint = { id: row.id, refNo: Number(row.ref_no) || 0 };
      }

      const liveImagePaths = new Set<string>();
      if (valid.images.length > 0) {
        const paths = valid.images.map((image) => image.key.key);
        const found = await db.execute(sql`
          select b.object_path from public.content_blocks b
           where b.lifted_at is null
             and b.object_path = any(${sql.param(paths)}::text[])`);
        for (const row of found.rows) {
          const path = (row as { object_path?: unknown }).object_path;
          if (typeof path === "string") liveImagePaths.add(path);
        }
      }
      return { itemRow, variants, complaint, liveImagePaths };
    });
  } catch (err) {
    logError("moderation: block read failed", loggableError(err), {
      kind: valid.kind,
      storeId: valid.storeId,
    });
    return fail(BLOCK_ERRORS.failed);
  }
}

// ── blockItem ───────────────────────────────────────────────────────────────

export type BlockItemResult =
  | { ok: true; blockId: string; childBlockIds: string[]; warnings: string[] }
  | BlockFailure;

export interface BlockOptions {
  storage?: ModerationStorage;
}

/** Block one item, one file or a whole store (design 5.3). */
export async function blockItem(
  input: BlockInput,
  operator: ModerationOperator,
  options: BlockOptions = {},
): Promise<BlockItemResult> {
  const storage = options.storage ?? moderationStorage;
  const bucket = storage.bucketName("public");

  // 1. Validate.
  const checked = validateBlockInput(input, operator, bucket);
  if (!checked.ok) return checked;
  const valid = checked.value;

  const pre = await preRead(valid);
  if ("ok" in pre) return pre;

  // 2. Archive before the block exists.
  const blockId = randomUUID();
  const capturedAt = storage.now();
  const at = capturedAt.toISOString();
  const budget = { inline: BLOCK_LIMITS.inlineCopies };
  const created: CreatedCopy[] = [];
  const warnings: string[] = [];
  let entries: ArchiveFileEntry[] = [];
  let storeContent: SnapshotStoreContent | null = null;

  if (valid.kind === "store") {
    const content = await writeStoreContent(
      { storeId: valid.storeId!, blockId },
      storage,
    );
    if (!content.ok) {
      return fail(
        content.reason === "too_large"
          ? BLOCK_ERRORS.storeTooLarge
          : BLOCK_ERRORS.storageForStore,
      );
    }
    if (content.created && content.entry.archivePath) {
      created.push({
        path: content.entry.archivePath,
        generation: content.entry.archiveGeneration,
      });
    }
    entries = [content.entry, ...content.pending];
    storeContent = content.content;
  } else if (valid.file) {
    const archived = await archiveKeys(
      blockId,
      [valid.file.key],
      storage,
      budget,
      at,
    );
    entries = archived.entries;
    created.push(...archived.created);
    if (valid.file.key.source === "bucket" && entries[0]?.state === "pending") {
      warnings.push(BLOCK_WARNINGS.archivePending);
    }
  } else {
    const archived = await archiveKeys(
      blockId,
      itemFileKeys(valid.kind, pre.itemRow, pre.variants, bucket),
      storage,
      budget,
      at,
    );
    entries = archived.entries;
    created.push(...archived.created);
  }

  const children: ChildPlan[] = [];
  let skippedImages = false;
  for (const target of valid.images) {
    if (pre.liveImagePaths.has(target.key.key)) {
      skippedImages = true;
      continue;
    }
    const id = randomUUID();
    const archived = await archiveKeys(id, [target.key], storage, budget, at);
    created.push(...archived.created);
    if (
      target.key.source === "bucket" &&
      archived.entries[0]?.state === "pending" &&
      !warnings.includes(BLOCK_WARNINGS.archivePending)
    ) {
      warnings.push(BLOCK_WARNINGS.archivePending);
    }
    children.push({ id, target, entries: archived.entries });
  }
  if (skippedImages) warnings.push(BLOCK_WARNINGS.imagesAlreadyBlocked);

  // 3. One transaction.
  let committed: Committed;
  try {
    committed = await withService((db) =>
      commitBlock(db, {
        blockId,
        valid,
        bucket,
        entries,
        storeContent,
        children,
        complaint: pre.complaint,
        capturedAt,
        at,
      }),
    );
  } catch (err) {
    await discardCopies(created, storage);
    if (err instanceof BlockRefusal) return fail(err.sentence);
    if (isUniqueViolation(err)) return fail(BLOCK_ERRORS.alreadyBlocked);
    if (isRecordMismatch(err)) return fail(BLOCK_ERRORS.changed);
    logError("moderation: block failed", loggableError(err), {
      kind: valid.kind,
      storeId: valid.storeId,
    });
    return fail(BLOCK_ERRORS.failed);
  }

  // 4. After commit.
  forgetBlockedObjects();
  if (valid.tellStore && valid.storeId) {
    await deliverBlockNotice(blockId, valid.actor);
  }
  if (valid.kind !== "file") await safePing(committed.addresses);

  // 5. The answer.
  return {
    ok: true,
    blockId,
    childBlockIds: committed.childIds,
    warnings,
  };
}

async function safePing(urls: readonly string[]): Promise<void> {
  if (urls.length === 0) return;
  try {
    await pingIndexNow([...urls]);
  } catch {
    // pingIndexNow never throws; a ping is best effort either way.
  }
}

// ── The notice (claimed, so the follow-up cannot send it twice) ─────────────

interface NoticeClaim {
  storeId: string;
  kind: BlockKind;
  itemLabel: string;
  objectPath: string | null;
  reason: BlockReason;
  complaintId: string | null;
  refNo: number | null;
  storeMessage: string;
  blockedAt: string;
  claimedAt: string;
}

function readNoticeClaim(row: unknown): NoticeClaim | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (
    typeof r.store_id !== "string" ||
    !isOneOf(BLOCK_KINDS, r.item_kind) ||
    !isOneOf(BLOCK_REASONS, r.reason_kind) ||
    typeof r.claimed_at !== "string"
  ) {
    return null;
  }
  return {
    storeId: r.store_id,
    kind: r.item_kind,
    itemLabel: typeof r.item_label === "string" ? r.item_label : "",
    objectPath: typeof r.object_path === "string" ? r.object_path : null,
    reason: r.reason_kind,
    complaintId: typeof r.complaint_id === "string" ? r.complaint_id : null,
    refNo:
      r.ref_no === null || r.ref_no === undefined ? null : Number(r.ref_no),
    storeMessage: typeof r.store_message === "string" ? r.store_message : "",
    blockedAt: typeof r.blocked_at === "string" ? r.blocked_at : "",
    claimedAt: r.claimed_at,
  };
}

export type NoticeOutcome = "sent" | "failed" | "skipped";

/**
 * Tell the store about one block (design 5.3 step 4, 3.4): claim
 * `notice_claimed_at` (only a told, live, not yet notified block of a store
 * that is not an image block of another; a claim lapses after 2 minutes),
 * send the bell and the email OUTSIDE any transaction, then settle on the
 * claim: `merchant_notified_at` (its image blocks too) and
 * `merchant_notified`, or the claim cleared and `merchant_notify_failed`
 * (whose `bell` says whether the bell rang, so a retry sends the email
 * only). Never throws.
 */
export async function deliverBlockNotice(
  blockId: string,
  actor: string,
  options: { bell?: boolean } = {},
): Promise<NoticeOutcome> {
  let claim: NoticeClaim | null;
  try {
    claim = await withService(async (db) => {
      const result = await db.execute(sql`
        update public.content_blocks b
           set notice_claimed_at = now()
         where b.id = ${blockId}::uuid
           and b.tell_store
           and b.lifted_at is null
           and b.merchant_notified_at is null
           and b.store_id is not null
           and b.parent_block_id is null
           and (b.notice_claimed_at is null
                or b.notice_claimed_at < now() - interval '2 minutes')
        returning b.store_id::text as store_id, b.item_kind, b.item_label,
                  b.object_path, b.reason_kind,
                  b.complaint_id::text as complaint_id, b.store_message,
                  b.blocked_at::text as blocked_at,
                  b.notice_claimed_at::text as claimed_at,
                  (select c.ref_no from public.grievance_complaints c
                    where c.id = b.complaint_id) as ref_no`);
      return readNoticeClaim(result.rows[0]);
    });
  } catch (err) {
    logError("moderation: notice claim failed", loggableError(err), {
      blockId,
    });
    return "failed";
  }
  if (!claim) return "skipped";

  let told: StoreTellResult | null = null;
  try {
    told = await tellStoreOfBlock(
      {
        blockId,
        storeId: claim.storeId,
        kind: claim.kind,
        contentType:
          claim.kind === "file" && claim.objectPath
            ? contentTypeFromName(claim.objectPath)
            : null,
        itemLabel: claim.kind === "store" ? "" : claim.itemLabel,
        reasonKind: claim.reason,
        complaintId: claim.complaintId,
        complaintRefNo: claim.refNo,
        storeMessage: claim.storeMessage,
        blockedAt: claim.blockedAt,
      },
      { bell: options.bell },
    );
  } catch (err) {
    logError("moderation: notice failed", loggableError(err), { blockId });
  }
  const sent = (told?.sent ?? 0) > 0;
  const settledClaim = claim;
  try {
    await withService(async (db) => {
      if (sent) {
        await db.execute(sql`
          update public.content_blocks
             set merchant_notified_at = now(), notice_claimed_at = null
           where id = ${blockId}::uuid
             and notice_claimed_at = ${settledClaim.claimedAt}::timestamptz`);
        await db.execute(sql`
          update public.content_blocks
             set merchant_notified_at = now()
           where parent_block_id = ${blockId}::uuid
             and tell_store and merchant_notified_at is null`);
        await recordModerationEvent(db, {
          actor,
          action: "merchant_notified",
          blockId,
          storeId: settledClaim.storeId,
          detail: {
            sent: told?.sent ?? 0,
            recipients: told?.recipients ?? 0,
            bell: (told?.bellEventId ?? null) !== null,
          },
        });
      } else {
        await db.execute(sql`
          update public.content_blocks
             set notice_claimed_at = null
           where id = ${blockId}::uuid
             and notice_claimed_at = ${settledClaim.claimedAt}::timestamptz`);
        await recordModerationEvent(db, {
          actor,
          action: "merchant_notify_failed",
          blockId,
          storeId: settledClaim.storeId,
          detail: {
            bell: (told?.bellEventId ?? null) !== null,
            storeFound: told?.storeFound ?? false,
            recipients: told?.recipients ?? 0,
            failed: told?.failed ?? 0,
          },
        });
      }
    });
  } catch (err) {
    logError("moderation: notice settle failed", loggableError(err), {
      blockId,
    });
  }
  return sent ? "sent" : "failed";
}

// ── liftBlock ───────────────────────────────────────────────────────────────

export interface LiftInput {
  blockId: string;
  /** Why it is lifted; the store sees it. */
  note: string;
  /** Email the store (when it was told). Default true. */
  notifyStore?: boolean;
  /** Lift the item's image blocks too. Default true. */
  alsoChildren?: boolean;
}

export type LiftResult =
  | { ok: true; liftedIds: string[]; warnings: string[] }
  | BlockFailure;

interface RestoringRow {
  id: string;
  path: string;
  claimedAt: string;
  files: unknown;
}

interface LiftedState {
  liftedIds: string[];
  storeId: string | null;
  kind: BlockKind;
  itemLabel: string;
  objectPath: string | null;
  tellStore: boolean;
  restoring: RestoringRow[];
  addresses: string[];
}

async function commitLift(
  db: Db,
  input: {
    blockId: string;
    note: string;
    actor: string;
    alsoChildren: boolean;
  },
): Promise<LiftedState> {
  const found = await db.execute(sql`
    select b.id::text as id, b.store_id::text as store_id, b.item_kind,
           b.item_label, b.item_url, b.object_path, b.tell_store,
           b.lifted_at::text as lifted_at
      from public.content_blocks b
     where b.id = ${input.blockId}::uuid
     for update`);
  const main = found.rows[0] as Record<string, unknown> | undefined;
  if (!main || !isOneOf(BLOCK_KINDS, main.item_kind)) {
    throw new BlockRefusal(BLOCK_ERRORS.blockNotFound);
  }
  if (main.lifted_at) throw new BlockRefusal(BLOCK_ERRORS.alreadyLifted);

  const ids = [input.blockId];
  if (input.alsoChildren) {
    const children = await db.execute(sql`
      select b.id::text as id from public.content_blocks b
       where b.parent_block_id = ${input.blockId}::uuid and b.lifted_at is null
       for update`);
    for (const row of children.rows) {
      const id = (row as { id?: unknown }).id;
      if (typeof id === "string") ids.push(id);
    }
  }

  const busy = await db.execute(sql`
    select 1 from public.content_blocks b
     where b.id = any(${sql.param(ids)}::uuid[])
       and b.storage_state = 'pending'
       and b.storage_claimed_at > now() - interval '2 minutes'
     limit 1`);
  if (busy.rows.length > 0) throw new BlockRefusal(BLOCK_ERRORS.liftReplacing);

  const updated = await db.execute(sql`
    with old as (
      select b.id, b.storage_state from public.content_blocks b
       where b.id = any(${sql.param(ids)}::uuid[]) and b.lifted_at is null)
    update public.content_blocks b
       set lifted_at = now(),
           lifted_by = ${input.actor},
           lift_note = ${input.note},
           storage_state = case old.storage_state
             when 'pending' then 'cancelled'
             when 'failed' then 'cancelled'
             when 'replaced' then 'restoring'
             else old.storage_state end,
           storage_claimed_at = case old.storage_state
             when 'replaced' then now()
             when 'pending' then null
             when 'failed' then null
             else b.storage_claimed_at end,
           storage_next_attempt_at = case old.storage_state
             when 'replaced' then now()
             when 'pending' then null
             when 'failed' then null
             else b.storage_next_attempt_at end,
           updated_at = now()
      from old
     where b.id = old.id
    returning b.id::text as id, old.storage_state as was,
              b.storage_state as state, b.object_path,
              b.storage_claimed_at::text as claimed_at`);

  const storeId = typeof main.store_id === "string" ? main.store_id : null;
  const liftedIds: string[] = [];
  const restoringIds: string[] = [];
  const restoring: Omit<RestoringRow, "files">[] = [];
  for (const raw of updated.rows) {
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string") continue;
    liftedIds.push(row.id);
    await recordModerationEvent(db, {
      actor: input.actor,
      action: "block_lifted",
      blockId: row.id,
      storeId,
      detail: {
        parentBlockId: row.id === input.blockId ? null : input.blockId,
      },
    });
    if (row.was === "pending" || row.was === "failed") {
      await recordModerationEvent(db, {
        actor: input.actor,
        action: "storage_cancelled",
        blockId: row.id,
        storeId,
        detail: { was: row.was },
      });
    }
    if (
      row.state === "restoring" &&
      typeof row.object_path === "string" &&
      typeof row.claimed_at === "string"
    ) {
      restoringIds.push(row.id);
      restoring.push({
        id: row.id,
        path: row.object_path,
        claimedAt: row.claimed_at,
      });
    }
  }
  if (!liftedIds.includes(input.blockId)) {
    throw new BlockRefusal(BLOCK_ERRORS.alreadyLifted);
  }

  const files = new Map<string, unknown>();
  if (restoringIds.length > 0) {
    const archives = await db.execute(sql`
      select a.block_id::text as block_id, a.files
        from public.content_block_archives a
       where a.block_id = any(${sql.param(restoringIds)}::uuid[])`);
    for (const raw of archives.rows) {
      const row = raw as { block_id?: unknown; files?: unknown };
      if (typeof row.block_id === "string") files.set(row.block_id, row.files);
    }
  }

  let addresses: string[] = [];
  if (main.item_kind !== "file") {
    const archive = await db.execute(sql`
      select a.snapshot -> 'addresses' as addresses
        from public.content_block_archives a
       where a.block_id = ${input.blockId}::uuid`);
    const stored = (archive.rows[0] as { addresses?: unknown } | undefined)
      ?.addresses;
    addresses = Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : [];
    if (
      addresses.length === 0 &&
      typeof main.item_url === "string" &&
      main.item_url
    ) {
      addresses = [main.item_url];
    }
  }

  return {
    liftedIds,
    storeId,
    kind: main.item_kind,
    itemLabel: typeof main.item_label === "string" ? main.item_label : "",
    objectPath: typeof main.object_path === "string" ? main.object_path : null,
    tellStore: main.tell_store === true,
    restoring: restoring.map((row) => ({ ...row, files: files.get(row.id) })),
    addresses,
  };
}

/** The archive entry a lift restores from: the copied bucket file itself. */
function restoreEntry(files: unknown, path: string): ArchivedFile | null {
  if (!Array.isArray(files)) return null;
  for (const value of files) {
    const entry = parseArchivedFile(value);
    if (
      entry &&
      entry.source === "bucket" &&
      entry.path === path &&
      entry.state === "copied"
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * Put one file back after a lift (design 3.5 step 2), outside any
 * transaction, then settle on the lift's claim: `restored`, `not_restored`,
 * or still `restoring` with the claim cleared and a retry a minute out (the
 * follow-up retries it). Never throws.
 */
async function restoreLifted(
  row: RestoringRow,
  actor: string,
  storeId: string | null,
  storage: ModerationStorage,
): Promise<RestoreOutcome["status"]> {
  const entry = restoreEntry(row.files, row.path);
  let outcome: RestoreOutcome;
  if (!entry) {
    outcome = { status: "not_restored", reason: "not_archived" };
  } else {
    try {
      outcome = await restoreFromArchive(
        { blockId: row.id, path: row.path, archived: entry },
        storage,
      );
    } catch (err) {
      outcome = {
        status: "failed",
        failure: {
          code: "unavailable",
          retryable: true,
          message: "Storage could not write the file back.",
          detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
        },
      };
    }
  }
  try {
    await withService(async (db) => {
      if (outcome.status === "failed") {
        await db.execute(sql`
          update public.content_blocks
             set storage_claimed_at = null,
                 storage_next_attempt_at = now() + interval '1 minute',
                 storage_error = left(${outcome.failure.message}, 1000),
                 updated_at = now()
           where id = ${row.id}::uuid and storage_state = 'restoring'
             and storage_claimed_at = ${row.claimedAt}::timestamptz`);
        return;
      }
      const state = outcome.status;
      const settled = await db.execute(sql`
        update public.content_blocks
           set storage_state = ${state}, storage_claimed_at = null,
               storage_error = '', updated_at = now()
         where id = ${row.id}::uuid and storage_state = 'restoring'
           and storage_claimed_at = ${row.claimedAt}::timestamptz
        returning id`);
      if (settled.rows.length === 0) return;
      await recordModerationEvent(db, {
        actor,
        action:
          outcome.status === "restored"
            ? "storage_restored"
            : "storage_not_restored",
        blockId: row.id,
        storeId,
        detail:
          outcome.status === "restored"
            ? { alreadyDone: outcome.alreadyDone }
            : { reason: outcome.reason },
      });
    });
  } catch (err) {
    logError("moderation: restore settle failed", loggableError(err), {
      blockId: row.id,
    });
  }
  return outcome.status;
}

/** Lift a block (design 3.5, 5.4). Superadmin only. */
export async function liftBlock(
  input: LiftInput,
  operator: ModerationOperator,
  options: BlockOptions = {},
): Promise<LiftResult> {
  const storage = options.storage ?? moderationStorage;
  const actor = actorOf(operator);
  if (!actor) return fail(BLOCK_ERRORS.notOperator);
  if (operator.role !== "superadmin") return fail(BLOCK_ERRORS.liftSuperadmin);
  if (!isUuid(input?.blockId)) return fail(BLOCK_ERRORS.blockNotFound);
  const note = (input.note ?? "").trim();
  if (!note) return fail(BLOCK_ERRORS.liftNoteMissing);
  if (note.length > BLOCK_LIMITS.liftNote) {
    return fail(BLOCK_ERRORS.liftNoteTooLong);
  }
  const blockId = input.blockId.toLowerCase();
  const notifyStore = input.notifyStore !== false;

  let lifted: LiftedState;
  try {
    lifted = await withService((db) =>
      commitLift(db, {
        blockId,
        note,
        actor,
        alsoChildren: input.alsoChildren !== false,
      }),
    );
  } catch (err) {
    if (err instanceof BlockRefusal) return fail(err.sentence);
    logError("moderation: lift failed", loggableError(err), { blockId });
    return fail(BLOCK_ERRORS.liftFailed);
  }

  const warnings: string[] = [];
  // 1. ★ Put the originals back BEFORE the blocked set is forgotten (T7).
  for (const row of lifted.restoring) {
    const status = await restoreLifted(row, actor, lifted.storeId, storage);
    if (
      status === "not_restored" &&
      !warnings.includes(BLOCK_WARNINGS.notRestored)
    ) {
      warnings.push(BLOCK_WARNINGS.notRestored);
    }
    if (
      status === "failed" &&
      !warnings.includes(BLOCK_WARNINGS.restoreRetrying)
    ) {
      warnings.push(BLOCK_WARNINGS.restoreRetrying);
    }
  }
  // 2. Pages and the optimizer.
  forgetBlockedObjects();
  // 3. The store, when it was told.
  if (lifted.tellStore && lifted.storeId) {
    await tellLift(blockId, lifted, note, notifyStore, actor);
  }
  // 4. Search engines.
  await safePing(lifted.addresses);
  return { ok: true, liftedIds: lifted.liftedIds, warnings };
}

async function tellLift(
  blockId: string,
  lifted: LiftedState,
  note: string,
  email: boolean,
  actor: string,
): Promise<void> {
  let told: StoreTellResult | null = null;
  try {
    told = await tellStoreOfLift(
      {
        blockId,
        storeId: lifted.storeId!,
        kind: lifted.kind,
        contentType:
          lifted.kind === "file" && lifted.objectPath
            ? contentTypeFromName(lifted.objectPath)
            : null,
        itemLabel: lifted.kind === "store" ? "" : lifted.itemLabel,
        liftNote: note,
      },
      { email },
    );
  } catch (err) {
    logError("moderation: lift notice failed", loggableError(err), {
      blockId,
    });
  }
  if (!email) return;
  await recordNotifyOutcome(blockId, lifted.storeId, actor, told, "lift");
}

async function recordNotifyOutcome(
  blockId: string,
  storeId: string | null,
  actor: string,
  told: StoreTellResult | null,
  about: "lift" | "reply",
): Promise<void> {
  try {
    await withService(async (db) => {
      await recordModerationEvent(db, {
        actor,
        action:
          (told?.sent ?? 0) > 0
            ? "merchant_notified"
            : "merchant_notify_failed",
        blockId,
        storeId,
        detail: {
          about,
          sent: told?.sent ?? 0,
          recipients: told?.recipients ?? 0,
          bell: (told?.bellEventId ?? null) !== null,
        },
      });
    });
  } catch (err) {
    logError("moderation: notice record failed", loggableError(err), {
      blockId,
    });
  }
}

// ── Telling a store later, by hand, replies, retries ───────────────────────

export type ActionResult<T extends object = object> =
  | ({ ok: true } & T)
  | BlockFailure;

/**
 * Tell the store about a block kept from it (design 3.4, 5.4): `tell_store`
 * from false to true for the block and its image blocks (the database
 * refuses the reverse), `store_told`, then the notices as if new.
 */
export async function tellStoreNow(
  blockId: string,
  operator: ModerationOperator,
): Promise<ActionResult<{ notified: boolean }>> {
  const actor = actorOf(operator);
  if (!actor) return fail(BLOCK_ERRORS.notOperator);
  if (operator.role !== "superadmin") return fail(BLOCK_ERRORS.tellSuperadmin);
  if (!isUuid(blockId)) return fail(BLOCK_ERRORS.blockNotFound);
  let root: string;
  try {
    root = await withService(async (db) => {
      const found = await db.execute(sql`
        select b.id::text as id, b.parent_block_id::text as parent_block_id,
               b.store_id::text as store_id, b.tell_store,
               b.lifted_at::text as lifted_at
          from public.content_blocks b
         where b.id = ${blockId}::uuid
         for update`);
      const row = found.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new BlockRefusal(BLOCK_ERRORS.blockNotFound);
      if (row.lifted_at) throw new BlockRefusal(BLOCK_ERRORS.alreadyLifted);
      if (row.tell_store === true)
        throw new BlockRefusal(BLOCK_ERRORS.alreadyTold);
      const top =
        typeof row.parent_block_id === "string" ? row.parent_block_id : blockId;
      await db.execute(sql`
        update public.content_blocks
           set tell_store = true, updated_at = now()
         where (id = ${top}::uuid or parent_block_id = ${top}::uuid)
           and not tell_store and lifted_at is null`);
      await recordModerationEvent(db, {
        actor,
        action: "store_told",
        blockId: top,
        storeId: typeof row.store_id === "string" ? row.store_id : null,
      });
      return top;
    });
  } catch (err) {
    if (err instanceof BlockRefusal) return fail(err.sentence);
    logError("moderation: tell store failed", loggableError(err), { blockId });
    return fail(BLOCK_ERRORS.saveFailed);
  }
  const outcome = await deliverBlockNotice(root, actor);
  return { ok: true, notified: outcome === "sent" };
}

/**
 * A theme file built into the app, deleted from the code by hand (design
 * 3.3, 5.4): `manual` to `removed_by_hand`, with the note recorded.
 */
export async function markRemovedByHand(
  blockId: string,
  note: string,
  operator: ModerationOperator,
): Promise<ActionResult> {
  const actor = actorOf(operator);
  if (!actor) return fail(BLOCK_ERRORS.notOperator);
  if (!isUuid(blockId)) return fail(BLOCK_ERRORS.blockNotFound);
  const text = (note ?? "").trim();
  if (!text) return fail(BLOCK_ERRORS.removedNoteMissing);
  if (text.length > BLOCK_LIMITS.liftNote) {
    return fail(BLOCK_ERRORS.liftNoteTooLong);
  }
  try {
    await withService(async (db) => {
      const found = await db.execute(sql`
        select b.store_id::text as store_id, b.storage_state,
               b.lifted_at::text as lifted_at
          from public.content_blocks b
         where b.id = ${blockId}::uuid
         for update`);
      const row = found.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new BlockRefusal(BLOCK_ERRORS.blockNotFound);
      if (row.lifted_at) throw new BlockRefusal(BLOCK_ERRORS.alreadyLifted);
      if (row.storage_state !== "manual") {
        throw new BlockRefusal(BLOCK_ERRORS.notManual);
      }
      await db.execute(sql`
        update public.content_blocks
           set storage_state = 'removed_by_hand', updated_at = now()
         where id = ${blockId}::uuid and storage_state = 'manual'
           and lifted_at is null`);
      await recordModerationEvent(db, {
        actor,
        action: "storage_removed_by_hand",
        blockId,
        storeId: typeof row.store_id === "string" ? row.store_id : null,
        detail: { note: text },
      });
    });
  } catch (err) {
    if (err instanceof BlockRefusal) return fail(err.sentence);
    logError("moderation: mark removed failed", loggableError(err), {
      blockId,
    });
    return fail(BLOCK_ERRORS.saveFailed);
  }
  return { ok: true };
}

function replyBody(body: string): string | BlockFailure {
  const text = (body ?? "").trim();
  if (!text) return fail(BLOCK_ERRORS.replyEmpty);
  if (text.length > BLOCK_LIMITS.reply) return fail(BLOCK_ERRORS.replyTooLong);
  return text;
}

/**
 * A reply a suspended store sent by email, copied into the block's
 * conversation by an operator (design 3.4, 6.6). Its heading reads
 * "<address>, by email" (`storeReplyAuthor`).
 */
export async function addStoreEmailedReply(
  input: { blockId: string; fromAddress: string; body: string },
  operator: ModerationOperator,
): Promise<ActionResult<{ messageId: string }>> {
  const actor = actorOf(operator);
  if (!actor) return fail(BLOCK_ERRORS.notOperator);
  if (!isUuid(input?.blockId)) return fail(BLOCK_ERRORS.blockNotFound);
  const address = (input.fromAddress ?? "").trim();
  const author = storeReplyAuthor(address, true);
  if (!EMAIL.test(address) || author.length > BLOCK_LIMITS.emailAuthor) {
    return fail(BLOCK_ERRORS.emailInvalid);
  }
  const body = replyBody(input.body);
  if (typeof body !== "string") return body;
  try {
    const messageId = await withService(async (db) => {
      const found = await db.execute(sql`
        select b.store_id::text as store_id from public.content_blocks b
         where b.id = ${input.blockId}::uuid`);
      const row = found.rows[0] as { store_id?: unknown } | undefined;
      if (!row) throw new BlockRefusal(BLOCK_ERRORS.blockNotFound);
      const inserted = await db.execute(sql`
        insert into public.content_block_messages (block_id, from_side, author, body)
        values (${input.blockId}::uuid, 'store', ${author}, ${body})
        returning id::text as id`);
      const id = String((inserted.rows[0] as { id?: unknown }).id ?? "");
      await recordModerationEvent(db, {
        actor,
        action: "store_replied",
        blockId: input.blockId,
        storeId: typeof row.store_id === "string" ? row.store_id : null,
        detail: { viaEmail: true, messageId: id },
      });
      return id;
    });
    return { ok: true, messageId };
  } catch (err) {
    if (err instanceof BlockRefusal) return fail(err.sentence);
    logError("moderation: emailed reply failed", loggableError(err), {
      blockId: input.blockId,
    });
    return fail(BLOCK_ERRORS.saveFailed);
  }
}

/**
 * StoreMink's reply to the store about a block (design 6.6): the message,
 * `storemink_replied`, then the bell and email to the owners. Refused for a
 * block the store has not been told about.
 */
export async function replyToStore(
  input: { blockId: string; body: string },
  operator: ModerationOperator,
): Promise<ActionResult<{ messageId: string; notified: boolean }>> {
  const actor = actorOf(operator);
  if (!actor) return fail(BLOCK_ERRORS.notOperator);
  if (!isUuid(input?.blockId)) return fail(BLOCK_ERRORS.blockNotFound);
  const body = replyBody(input.body);
  if (typeof body !== "string") return body;
  let saved: {
    messageId: string;
    storeId: string | null;
    kind: BlockKind;
    itemLabel: string;
    objectPath: string | null;
  };
  try {
    saved = await withService(async (db) => {
      const found = await db.execute(sql`
        select b.store_id::text as store_id, b.item_kind, b.item_label,
               b.object_path, b.tell_store
          from public.content_blocks b
         where b.id = ${input.blockId}::uuid`);
      const row = found.rows[0] as Record<string, unknown> | undefined;
      if (!row || !isOneOf(BLOCK_KINDS, row.item_kind)) {
        throw new BlockRefusal(BLOCK_ERRORS.blockNotFound);
      }
      if (row.tell_store !== true)
        throw new BlockRefusal(BLOCK_ERRORS.replyNotTold);
      const inserted = await db.execute(sql`
        insert into public.content_block_messages (block_id, from_side, author, body)
        values (${input.blockId}::uuid, 'storemink', ${actor}, ${body})
        returning id::text as id`);
      const id = String((inserted.rows[0] as { id?: unknown }).id ?? "");
      const storeId = typeof row.store_id === "string" ? row.store_id : null;
      await recordModerationEvent(db, {
        actor,
        action: "storemink_replied",
        blockId: input.blockId,
        storeId,
        detail: { messageId: id },
      });
      return {
        messageId: id,
        storeId,
        kind: row.item_kind,
        itemLabel: typeof row.item_label === "string" ? row.item_label : "",
        objectPath:
          typeof row.object_path === "string" ? row.object_path : null,
      };
    });
  } catch (err) {
    if (err instanceof BlockRefusal) return fail(err.sentence);
    logError("moderation: reply failed", loggableError(err), {
      blockId: input.blockId,
    });
    return fail(BLOCK_ERRORS.saveFailed);
  }
  let notified = false;
  if (saved.storeId) {
    let told: StoreTellResult | null = null;
    try {
      told = await tellStoreOfReply({
        blockId: input.blockId,
        storeId: saved.storeId,
        kind: saved.kind,
        contentType:
          saved.kind === "file" && saved.objectPath
            ? contentTypeFromName(saved.objectPath)
            : null,
        itemLabel: saved.kind === "store" ? "" : saved.itemLabel,
        reply: body,
      });
    } catch (err) {
      logError("moderation: reply notice failed", loggableError(err), {
        blockId: input.blockId,
      });
    }
    notified = (told?.sent ?? 0) > 0;
    await recordNotifyOutcome(
      input.blockId,
      saved.storeId,
      actor,
      told,
      "reply",
    );
  }
  return { ok: true, messageId: saved.messageId, notified };
}

/**
 * **Retry now** (design 5.4, 6.6): a failed replacement back to pending and
 * a failed archive copy back to pending, each due at once with its attempts
 * reset. Refused for a lifted block. Records no event (there is no retry
 * action in the record's vocabulary; the follow-up's own events follow).
 */
export async function retryStorage(
  blockId: string,
  operator: ModerationOperator,
): Promise<ActionResult<{ storage: boolean; files: boolean }>> {
  const actor = actorOf(operator);
  if (!actor) return fail(BLOCK_ERRORS.notOperator);
  if (!isUuid(blockId)) return fail(BLOCK_ERRORS.blockNotFound);
  try {
    const moved = await withService(async (db) => {
      const found = await db.execute(sql`
        select b.lifted_at::text as lifted_at from public.content_blocks b
         where b.id = ${blockId}::uuid
         for update`);
      const row = found.rows[0] as { lifted_at?: unknown } | undefined;
      if (!row) throw new BlockRefusal(BLOCK_ERRORS.blockNotFound);
      if (row.lifted_at) throw new BlockRefusal(BLOCK_ERRORS.retryLifted);
      const storage = await db.execute(sql`
        update public.content_blocks
           set storage_state = 'pending', storage_attempts = 0,
               storage_next_attempt_at = now(), storage_error = '',
               storage_claimed_at = null, updated_at = now()
         where id = ${blockId}::uuid and storage_state = 'failed'
           and lifted_at is null
        returning id`);
      const files = await db.execute(sql`
        update public.content_block_archives
           set files_state = 'pending', files_attempts = 0,
               files_next_attempt_at = now(), files_error = '',
               files_claimed_at = null
         where block_id = ${blockId}::uuid and files_state = 'failed'
        returning id`);
      return {
        storage: storage.rows.length > 0,
        files: files.rows.length > 0,
      };
    });
    if (!moved.storage && !moved.files)
      return fail(BLOCK_ERRORS.nothingToRetry);
    return { ok: true, ...moved };
  } catch (err) {
    if (err instanceof BlockRefusal) return fail(err.sentence);
    logError("moderation: retry failed", loggableError(err), { blockId });
    return fail(BLOCK_ERRORS.saveFailed);
  }
}
