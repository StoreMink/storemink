import "server-only";

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { canonicalJson } from "@/lib/themes/canonical-json";
import { PLAN_LIMITS, effectivePlan } from "@/lib/plans";
import { subdomainOrigin } from "@/lib/store/host";
import { collectionPath } from "@/lib/storefront/collection-links";
import { archiveDatabase } from "./archive-paths";
import type { BlockKind, BlockReason, FileSource } from "./kinds";
import type { ArchivedFile, ArchivedFileSource } from "./storage";

/**
 * The record a block keeps of what it removed (takedown design 3.6, 5.3 step
 * 3): the block, the store with its header, footer, menus and owners, the
 * item's row exactly as stored (every column, `to_jsonb`), its related rows,
 * its history, the public addresses it had, and for a file its metadata, its
 * media library row and where the store uses it.
 *
 * ★ THE HASH IS OVER THE JSONB READ BACK, NEVER OVER THE OBJECT THAT WAS
 * BUILT. jsonb reorders keys and turns a Date into its ISO text, so a digest
 * of the JavaScript object is a digest of something the database never held.
 * `hashForStorage` sends the JSON text to PostgreSQL, reads the jsonb value
 * back and hashes `canonicalJson` of that; the archive insert then stores the
 * same text, so `sha256(canonicalJson(snapshot read back))` is what any later
 * check recomputes (`snapshotSha256`).
 *
 * The readers here run on the CALLER's transaction (the block's own, which
 * holds the row locks); none opens a scope of its own.
 *
 * Also here: the archive's "pending" file entry, the shape the every-minute
 * follow-up (T14a) reads to know which files still need copying. Storage's
 * `parseArchivedFile` reads only finished entries, so a pending one is its
 * own small format (`pendingArchiveFile`, `parsePendingArchiveFile`).
 */

export const SNAPSHOT_FORMAT = "storemink-takedown-snapshot";
export const SNAPSHOT_VERSION = 1;

/** The item's history: the store's activity rows about it, newest first. */
export const SNAPSHOT_HISTORY_LIMIT = 200;

/** Where a store uses a file: at most this many places. */
export const SNAPSHOT_USAGE_LIMIT = 200;

/** Excerpts in item labels (a review's or comment's text). */
const EXCERPT_MAX = 80;

/** content_blocks.item_label and store_label: 1 to 300 characters. */
export const LABEL_MAX = 300;

export type JsonRow = Record<string, unknown>;

/** The tables a row kind lives in (design 3.1). */
export const ITEM_TABLES = {
  product: "products",
  page: "store_pages",
  blog_post: "blogs",
  collection: "categories",
  review: "product_reviews",
  blog_comment: "blog_comments",
} as const satisfies Partial<Record<BlockKind, string>>;

export type RowKind = keyof typeof ITEM_TABLES;

export function isRowKind(kind: BlockKind): kind is RowKind {
  return Object.prototype.hasOwnProperty.call(ITEM_TABLES, kind);
}

// ── The store ───────────────────────────────────────────────────────────────

/** The store columns this module reads (a `stores` row as `to_jsonb` gives it). */
export interface StoreFacts {
  id: string;
  slug: string;
  name: string;
  status: string;
  custom_domain: string | null;
  settings: Record<string, unknown> | null;
  plan: unknown;
  plan_expires_at: string | null;
  comp_plan: unknown;
  comp_expires_at: string | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A `stores` row read as jsonb, narrowed to what blocking needs. */
export function storeFactsFromRow(row: JsonRow): StoreFacts {
  const settings = row.settings;
  return {
    id: text(row.id),
    slug: text(row.slug),
    name: text(row.name),
    status: text(row.status),
    custom_domain: nullableText(row.custom_domain),
    settings:
      settings && typeof settings === "object" && !Array.isArray(settings)
        ? (settings as Record<string, unknown>)
        : null,
    plan: row.plan ?? null,
    plan_expires_at: nullableText(row.plan_expires_at),
    comp_plan: row.comp_plan ?? null,
    comp_expires_at: nullableText(row.comp_expires_at),
  };
}

/**
 * The store's public origins at this moment: its StoreMink address, and its
 * custom domain when that is verified and the plan still serves it (the
 * rule `storeOrigin` applies, written here without the store resolver).
 */
export function storeOrigins(
  store: StoreFacts,
  now: Date = new Date(),
): string[] {
  const origins = [subdomainOrigin(store.slug)];
  const verified = store.settings?.custom_domain_verified === true;
  const domain = (store.custom_domain ?? "").trim().toLowerCase();
  if (verified && domain) {
    const entitled = PLAN_LIMITS[effectivePlan(store, now)].customDomain;
    if (entitled) origins.push(`https://${domain}`);
  }
  return origins;
}

// ── The item ────────────────────────────────────────────────────────────────

/**
 * The path a shopper opens an item at, or null when it has none of its own
 * (a review and a comment use their product's or post's path).
 */
export function itemPath(kind: BlockKind, slug: string | null): string | null {
  if (slug === null) return null;
  switch (kind) {
    case "product":
      return `/shop/${encodeURIComponent(slug)}`;
    case "page":
      return slug === "" ? "/" : `/${encodeURIComponent(slug)}`;
    case "blog_post":
      return `/blogs/${encodeURIComponent(slug)}`;
    case "collection":
      return collectionPath(slug);
    default:
      return null;
  }
}

/** Every origin with the path appended. */
export function addressesFor(origins: string[], path: string | null): string[] {
  if (path === null) return [];
  return origins.map((origin) => `${origin}${path}`);
}

function excerpt(value: unknown): string {
  const words = text(value).replace(/\s+/g, " ").trim();
  return words.length > EXCERPT_MAX
    ? `${words.slice(0, EXCERPT_MAX - 3).trimEnd()}...`
    : words;
}

function clip(value: string, max = LABEL_MAX): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * The item's name as the block records it (content_blocks.item_label, 1 to
 * 300 characters): a product's or collection's name, a page's or post's
 * title (the homepage is "Homepage"), a review or comment as "{product or
 * post}: {first words}", a store's name.
 */
export function itemLabelFor(
  kind: BlockKind,
  row: JsonRow | null,
  related: { parentName?: string | null } = {},
): string {
  const fallback = "Untitled";
  switch (kind) {
    case "product":
    case "collection":
      return clip(text(row?.name)) || fallback;
    case "page": {
      const slug = text(row?.slug);
      return (
        clip(text(row?.title)) || (slug === "" ? "Homepage" : slug) || fallback
      );
    }
    case "blog_post":
      return clip(text(row?.title)) || fallback;
    case "review":
    case "blog_comment": {
      const words = excerpt(kind === "review" ? row?.comment : row?.body);
      const parent = (related.parentName ?? "").trim();
      const label = parent && words ? `${parent}: ${words}` : parent || words;
      return clip(label) || fallback;
    }
    case "store":
      return clip(text(row?.name)) || clip(text(row?.slug)) || fallback;
    case "file":
      return fallback;
  }
}

/** A file's name as a block records it: the last part of its address. */
export function fileLabelFor(source: FileSource, key: string): string {
  let last = key;
  if (source === "external") {
    try {
      const url = new URL(key);
      last = url.pathname.split("/").filter(Boolean).pop() ?? url.host;
      if (!last) last = url.host;
    } catch {
      last = key;
    }
  } else {
    last = key.split("/").filter(Boolean).pop() ?? key;
  }
  return clip(last) || "File";
}

/** A content type guessed from a file name, for wording ("image" or "file"). */
export function contentTypeFromName(name: string): string | null {
  const extension = (name.split(".").pop() ?? "").toLowerCase();
  const images: Record<string, string> = {
    webp: "image/webp",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    avif: "image/avif",
    svg: "image/svg+xml",
  };
  return images[extension] ?? null;
}

// ── The snapshot ────────────────────────────────────────────────────────────

export interface SnapshotBlock {
  id: string;
  kind: BlockKind;
  reason: BlockReason;
  complaint: { id: string; ref: string | null } | null;
  legalBasis: string;
  tellStore: boolean;
  blockedBy: string;
  parentBlockId: string | null;
}

export interface SnapshotStore {
  /** The `stores` row, every column. */
  row: JsonRow;
  /** Its public origins at the time. */
  addresses: string[];
  /** Its owners' email addresses. */
  owners: string[];
  /** `store_chrome` (header, footer, announcement; draft and published), or null. */
  chrome: JsonRow | null;
  /** `store_menus`, or null. */
  menus: JsonRow | null;
}

export interface FileUsage {
  table: string;
  id: string;
  column: string;
  key: string;
}

export interface SnapshotFile {
  source: FileSource;
  /** The normalised key (`mediaKeyFromUrl`). */
  key: string;
  /** The address the operator gave, or the key's public address. */
  address: string;
  /** The archive entry when the copy was made at block time, else null. */
  metadata: ArchivedFile | null;
  mediaAsset: JsonRow | null;
  usages: FileUsage[];
}

/** The whole-store content file, as the snapshot names it (design 3.6). */
export interface SnapshotStoreContent {
  file: string;
  archivePath: string;
  generation: string | null;
  size: number;
  md5: string;
  sha256: string;
  rows: Record<string, number>;
  /** Files the follow-up copies. */
  files: number;
  /** Chat attachments of another database, left out. */
  skippedAttachments: number;
}

export interface BlockSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  /** A Date when built; ISO text once stored (jsonb). */
  capturedAt: Date | string;
  database: string;
  block: SnapshotBlock;
  store: SnapshotStore | null;
  item: { kind: BlockKind; row: JsonRow | null; file: SnapshotFile | null };
  related: Record<string, unknown>;
  history: JsonRow[];
  addresses: string[];
  storeContent: SnapshotStoreContent | null;
}

/** Assemble a snapshot (pure). */
export function buildSnapshot(parts: {
  capturedAt: Date;
  block: SnapshotBlock;
  store: SnapshotStore | null;
  item: { kind: BlockKind; row: JsonRow | null; file?: SnapshotFile | null };
  related?: Record<string, unknown>;
  history?: JsonRow[];
  addresses?: string[];
  storeContent?: SnapshotStoreContent | null;
}): BlockSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    capturedAt: parts.capturedAt,
    database: archiveDatabase(),
    block: parts.block,
    store: parts.store,
    item: {
      kind: parts.item.kind,
      row: parts.item.row,
      file: parts.item.file ?? null,
    },
    related: parts.related ?? {},
    history: parts.history ?? [],
    addresses: parts.addresses ?? [],
    storeContent: parts.storeContent ?? null,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The fingerprint of a stored snapshot: SHA-256 of `canonicalJson` of the
 * value read back from jsonb (design 3.6 "Integrity"). Pure, so a later
 * check (the console, an investigator) recomputes it the same way.
 */
export function snapshotSha256(storedValue: unknown): string {
  return sha256Hex(canonicalJson(storedValue));
}

/**
 * The text to store and its fingerprint: the JSON goes to PostgreSQL as
 * jsonb and comes back, and the hash is taken over what came back, so the
 * stored row and its hash always agree (keys reordered, Dates as text).
 */
export async function hashForStorage(
  db: Db,
  snapshot: BlockSnapshot,
): Promise<{ json: string; sha256: string }> {
  const json = JSON.stringify(snapshot);
  const result = await db.execute(sql`select ${json}::jsonb as v`);
  const readBack = (result.rows[0] as { v?: unknown } | undefined)?.v;
  if (readBack === undefined) {
    throw new Error("The snapshot could not be read back for its hash.");
  }
  return { json, sha256: snapshotSha256(readBack) };
}

// ── Readers (on the caller's transaction) ──────────────────────────────────

type RowResult = { row?: unknown };

function firstRow(result: { rows: unknown[] }): JsonRow | null {
  const row = (result.rows[0] as RowResult | undefined)?.row;
  return row && typeof row === "object" && !Array.isArray(row)
    ? (row as JsonRow)
    : null;
}

function allRows(result: { rows: unknown[] }): JsonRow[] {
  return result.rows
    .map((entry) => (entry as RowResult).row)
    .filter(
      (row): row is JsonRow =>
        !!row && typeof row === "object" && !Array.isArray(row),
    );
}

/** The `stores` row as jsonb, optionally locked (`FOR UPDATE`). */
export async function readStoreRow(
  db: Db,
  storeId: string,
  options: { lock?: boolean } = {},
): Promise<JsonRow | null> {
  const result = options.lock
    ? await db.execute(
        sql`select to_jsonb(s) as row from public.stores s where s.id = ${storeId} for update`,
      )
    : await db.execute(
        sql`select to_jsonb(s) as row from public.stores s where s.id = ${storeId}`,
      );
  return firstRow(result);
}

/**
 * The store-wide content a block keeps as it is (design 3.1, 3.6): the
 * owners' addresses, the header, footer and announcement (`store_chrome`,
 * draft and published) and the menus (`store_menus`).
 */
export async function readStoreContext(
  db: Db,
  storeId: string,
): Promise<{
  owners: string[];
  chrome: JsonRow | null;
  menus: JsonRow | null;
}> {
  // One after another: these share the transaction's one client.
  const owners = await db.execute(
    sql`select a.email from public.admins a
         where a.store_id = ${storeId} and a.role = 'superadmin'
         order by a.created_at, a.id`,
  );
  const chrome = await db.execute(
    sql`select to_jsonb(c) as row from public.store_chrome c where c.store_id = ${storeId}`,
  );
  const menus = await db.execute(
    sql`select to_jsonb(m) as row from public.store_menus m where m.store_id = ${storeId}`,
  );
  const emails = owners.rows
    .map((row) => text((row as { email?: unknown }).email).trim())
    .filter(Boolean);
  return {
    owners: [...new Set(emails)],
    chrome: firstRow(chrome),
    menus: firstRow(menus),
  };
}

/** An item's row as jsonb, in its store, optionally locked (`FOR UPDATE`). */
export async function readItemRow(
  db: Db,
  kind: RowKind,
  storeId: string,
  itemId: string,
  options: { lock?: boolean } = {},
): Promise<JsonRow | null> {
  const table = sql.raw(`public.${ITEM_TABLES[kind]}`);
  const result = options.lock
    ? await db.execute(
        sql`select to_jsonb(t) as row from ${table} t
             where t.id = ${itemId} and t.store_id = ${storeId} for update`,
      )
    : await db.execute(
        sql`select to_jsonb(t) as row from ${table} t
             where t.id = ${itemId} and t.store_id = ${storeId}`,
      );
  return firstRow(result);
}

/** A product's variants as jsonb (they carry its option images). */
export async function readVariants(
  db: Db,
  storeId: string,
  productId: string,
): Promise<JsonRow[]> {
  const result = await db.execute(
    sql`select to_jsonb(v) as row from public.product_variants v
         where v.product_id = ${productId} and v.store_id = ${storeId}
         order by v.sort_order nulls last, v.id`,
  );
  return allRows(result);
}

async function readAuthor(db: Db, userId: string): Promise<JsonRow | null> {
  const result = await db.execute(
    sql`select jsonb_build_object(
               'id', u.id, 'first_name', u.first_name, 'last_name', u.last_name,
               'phone', u.phone, 'email', u.email, 'created_at', u.created_at) as row
          from public.users u where u.id = ${userId}`,
  );
  return firstRow(result);
}

/**
 * Related rows (design 3.6): a product's variants and category; a review's
 * product and author; a comment's post and author; a shopper's post's
 * author. `parentPath` is the path a review or comment shows at.
 */
export async function readRelated(
  db: Db,
  kind: RowKind,
  storeId: string,
  row: JsonRow,
): Promise<{
  related: Record<string, unknown>;
  parentName: string | null;
  parentPath: string | null;
}> {
  switch (kind) {
    case "product": {
      const variants = await readVariants(db, storeId, text(row.id));
      const categoryId = nullableText(row.category_id);
      let category: JsonRow | null = null;
      if (categoryId) {
        category = firstRow(
          await db.execute(
            sql`select to_jsonb(c) as row from public.categories c
                 where c.id = ${categoryId} and c.store_id = ${storeId}`,
          ),
        );
      }
      return {
        related: { variants, category },
        parentName: null,
        parentPath: null,
      };
    }
    case "review": {
      const product = firstRow(
        await db.execute(
          sql`select jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug) as row
                from public.products p
               where p.id = ${text(row.product_id)} and p.store_id = ${storeId}`,
        ),
      );
      const author = await readAuthor(db, text(row.user_id));
      const path = product ? itemPath("product", text(product.slug)) : null;
      return {
        related: { product: product ? { ...product, path } : null, author },
        parentName: product ? text(product.name) : null,
        parentPath: path,
      };
    }
    case "blog_comment": {
      const post = firstRow(
        await db.execute(
          sql`select jsonb_build_object('id', b.id, 'title', b.title, 'slug', b.slug) as row
                from public.blogs b
               where b.id = ${text(row.blog_id)} and b.store_id = ${storeId}`,
        ),
      );
      const author = await readAuthor(db, text(row.user_id));
      const path = post ? itemPath("blog_post", text(post.slug)) : null;
      return {
        related: { post: post ? { ...post, path } : null, author },
        parentName: post ? text(post.title) : null,
        parentPath: path,
      };
    }
    case "blog_post": {
      const submittedBy = nullableText(row.submitted_by);
      const author =
        row.is_customer_submission === true && submittedBy
          ? await readAuthor(db, submittedBy)
          : null;
      return {
        related: author ? { author } : {},
        parentName: null,
        parentPath: null,
      };
    }
    default:
      return { related: {}, parentName: null, parentPath: null };
  }
}

/** The store's activity rows about an item, newest first (design 3.6). */
export async function readHistory(
  db: Db,
  storeId: string,
  itemId: string,
): Promise<JsonRow[]> {
  const result = await db.execute(
    sql`select to_jsonb(e) as row from public.activity_events e
         where e.store_id = ${storeId} and e.subject_id = ${itemId}
         order by e.created_at desc, e.id desc
         limit ${SNAPSHOT_HISTORY_LIMIT}`,
  );
  return allRows(result);
}

/** A file's media library row in the store, if any. */
export async function readMediaAsset(
  db: Db,
  storeId: string,
  key: string,
): Promise<JsonRow | null> {
  const result = await db.execute(
    sql`select to_jsonb(m) as row from public.media_assets m
         where m.store_id = ${storeId} and (m.path = ${key} or strpos(m.url, ${key}) > 0)
         order by m.created_at, m.id limit 1`,
  );
  return firstRow(result);
}

/**
 * Where a store uses any of these file keys (design 3.6: table, row,
 * column), in one statement over the store's content tables. Bounded; a
 * key may also appear percent-encoded, which this search does not see.
 */
export async function readFileUsages(
  db: Db,
  storeId: string,
  keys: string[],
): Promise<FileUsage[]> {
  const wanted = [...new Set(keys.filter(Boolean))];
  if (wanted.length === 0) return [];
  const result = await db.execute(sql`
    with k(key) as (select unnest(${sql.param(wanted)}::text[]))
    select u.tbl, u.row_id, u.col, u.key from (
      select 'products' as tbl, t.id::text as row_id, kv.key as col, k.key
        from public.products t cross join lateral jsonb_each(to_jsonb(t)) kv
        join k on strpos(kv.value::text, k.key) > 0
       where t.store_id = ${storeId}
      union all
      select 'product_variants', t.id::text, kv.key, k.key
        from public.product_variants t cross join lateral jsonb_each(to_jsonb(t)) kv
        join k on strpos(kv.value::text, k.key) > 0
       where t.store_id = ${storeId}
      union all
      select 'store_pages', t.id::text, kv.key, k.key
        from public.store_pages t cross join lateral jsonb_each(to_jsonb(t)) kv
        join k on strpos(kv.value::text, k.key) > 0
       where t.store_id = ${storeId}
      union all
      select 'blogs', t.id::text, kv.key, k.key
        from public.blogs t cross join lateral jsonb_each(to_jsonb(t)) kv
        join k on strpos(kv.value::text, k.key) > 0
       where t.store_id = ${storeId}
      union all
      select 'categories', t.id::text, kv.key, k.key
        from public.categories t cross join lateral jsonb_each(to_jsonb(t)) kv
        join k on strpos(kv.value::text, k.key) > 0
       where t.store_id = ${storeId}
      union all
      select 'store_chrome', t.store_id::text, kv.key, k.key
        from public.store_chrome t cross join lateral jsonb_each(to_jsonb(t)) kv
        join k on strpos(kv.value::text, k.key) > 0
       where t.store_id = ${storeId}
      union all
      select 'store_menus', t.store_id::text, kv.key, k.key
        from public.store_menus t cross join lateral jsonb_each(to_jsonb(t)) kv
        join k on strpos(kv.value::text, k.key) > 0
       where t.store_id = ${storeId}
    ) u
    order by u.tbl, u.row_id, u.col
    limit ${SNAPSHOT_USAGE_LIMIT}`);
  return result.rows.map((row) => {
    const r = row as {
      tbl?: unknown;
      row_id?: unknown;
      col?: unknown;
      key?: unknown;
    };
    return {
      table: text(r.tbl),
      id: text(r.row_id),
      column: text(r.col),
      key: text(r.key),
    };
  });
}

// ── Pending archive entries ─────────────────────────────────────────────────

/**
 * A file the archive still has to copy (design 5.3 step 2, 8.1 step 2): the
 * follow-up copies it (a bucket or this database's private file), downloads
 * it (an outside address) or reads the app's copy (a theme file), and
 * replaces the entry with storage's `ArchivedFile` under the same `n`.
 */
export interface PendingArchiveFile {
  n: number;
  source: ArchivedFileSource;
  /** The bucket path, the https address or the `/themes/...` path. */
  path: string;
  state: "pending";
  /** When the entry was written (ISO 8601). */
  at: string;
  /** The base64 MD5 the copy must still have, when the block recorded one. */
  expectedMd5: string | null;
}

export type ArchiveFileEntry = ArchivedFile | PendingArchiveFile;

const PENDING_SOURCES: readonly ArchivedFileSource[] = [
  "bucket",
  "private",
  "external",
  "bundled",
];

export function pendingArchiveFile(input: {
  n: number;
  source: ArchivedFileSource;
  path: string;
  at: string;
  expectedMd5?: string | null;
}): PendingArchiveFile {
  return {
    n: input.n,
    source: input.source,
    path: input.path,
    state: "pending",
    at: input.at,
    expectedMd5: input.expectedMd5 ?? null,
  };
}

/** A pending entry read back from `content_block_archives.files`, or null. */
export function parsePendingArchiveFile(
  value: unknown,
): PendingArchiveFile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const md5 = row.expectedMd5;
  if (
    row.state !== "pending" ||
    typeof row.n !== "number" ||
    !Number.isSafeInteger(row.n) ||
    row.n < 0 ||
    !PENDING_SOURCES.includes(row.source as ArchivedFileSource) ||
    typeof row.path !== "string" ||
    !row.path ||
    typeof row.at !== "string" ||
    !(md5 === null || md5 === undefined || typeof md5 === "string")
  ) {
    return null;
  }
  return {
    n: row.n,
    source: row.source as ArchivedFileSource,
    path: row.path,
    state: "pending",
    at: row.at,
    expectedMd5: typeof md5 === "string" ? md5 : null,
  };
}

/**
 * The archive's `files_state` for its entries: `copied` once nothing is
 * pending (an empty list included), else `pending`.
 */
export function filesStateFor(
  entries: readonly ArchiveFileEntry[],
): "copied" | "pending" {
  return entries.some((entry) => entry.state === "pending")
    ? "pending"
    : "copied";
}
