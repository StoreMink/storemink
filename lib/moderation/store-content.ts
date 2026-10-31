import "server-only";

import { sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import {
  archiveDatabase,
  archiveStoreContentPath,
  STORE_CONTENT_FILE,
} from "./archive-paths";
import { referencedMediaKeys } from "./media-refs";
import type { MediaKey } from "./media-key";
import {
  pendingArchiveFile,
  type PendingArchiveFile,
  type SnapshotStoreContent,
} from "./snapshot";
import {
  moderationStorage,
  writeArchiveObject,
  type ArchivedFile,
  type ModerationStorage,
  type StorageFailure,
} from "./storage";

/**
 * A whole store's copy (takedown design 3.6, 5.3 step 2; plan A6): every row
 * of the store's content, its Mink AI chats and image records included,
 * written as one JSON Lines file (`store-content.jsonl`) to the block's
 * archive folder BEFORE the store is suspended, create-only.
 *
 * ★ ONE READ, ONE MOMENT. Every table is read in one transaction whose first
 * statement is `set transaction isolation level repeatable read, read only`,
 * so the file is one consistent picture of the store, not a page of products
 * from before an edit and its variants from after it.
 *
 * ★ BUILT IN MEMORY, NOT STREAMED (a deviation from the design's wording):
 * storage's `writeArchiveObject` takes the bytes and writes them create-only
 * with its MD5 confirmed, which a stream cannot give it. The file is bounded
 * (`STORE_CONTENT_MAX_BYTES`); a store larger than that is refused rather
 * than copied in part, because a suspension must not go ahead without its
 * whole record.
 *
 * ★ THE FILES THE ROWS NAME ARE LISTED, NOT COPIED, HERE. Every media address
 * in the rows (`referencedMediaKeys`: this environment's bucket, outside
 * addresses that are clearly media, `/themes/...`) and every chat attachment
 * of THIS database (`stores/<store>/mink-attachments/<database>/<name>`, the
 * private bucket, private to private) becomes a pending archive entry the
 * every-minute follow-up copies (T14a). An attachment path of another
 * database is counted and left out, never copied (design 9).
 *
 * Line format: `{"table":"<table>","row":<the row as to_jsonb gives it>}`.
 */

/** The tables a store's copy holds, in the order the file lists them. */
export const STORE_CONTENT_TABLES = [
  "stores",
  "store_chrome",
  "store_menus",
  "products",
  "product_variants",
  "categories",
  "store_pages",
  "blogs",
  "product_reviews",
  "blog_comments",
  "media_assets",
  "mink_conversations",
  "mink_messages",
  "mink_image_scenes",
  "mink_photo_edits",
  "mink_image_refinements",
  "mink_revamp_images",
  "mink_attachments",
] as const;

export type StoreContentTable = (typeof STORE_CONTENT_TABLES)[number];

/** Tables keyed by the store alone (one row, no `id`). */
const SINGLE_ROW_TABLES: ReadonlySet<StoreContentTable> = new Set([
  "stores",
  "store_chrome",
  "store_menus",
]);

/** Rows read per page (keyset by id). */
export const STORE_CONTENT_PAGE_SIZE = 500;

/** The largest store copy made in one go. */
export const STORE_CONTENT_MAX_BYTES = 256 * 1024 * 1024;

export const STORE_CONTENT_TYPE = "application/x-ndjson";

/** One line of the file. `rowJson` is the row as PostgreSQL wrote it. */
export function storeContentLine(table: string, rowJson: string): string {
  return `{"table":${JSON.stringify(table)},"row":${rowJson}}\n`;
}

/**
 * Whether a chat attachment's stored path is one this database's archive may
 * copy: `stores/<this store>/mink-attachments/<this database>/<name>`.
 */
export function isThisDatabaseAttachmentPath(
  path: unknown,
  storeId: string,
): path is string {
  if (typeof path !== "string") return false;
  const segments = path.split("/");
  return (
    segments.length === 5 &&
    segments[0] === "stores" &&
    segments[1] === storeId &&
    segments[2] === "mink-attachments" &&
    segments[3] === archiveDatabase() &&
    segments[4] !== "" &&
    segments[4] !== "." &&
    segments[4] !== ".."
  );
}

/** What the rows name: files to copy, and attachments left out. */
export interface StoreContentFiles {
  /** Media addresses in normal form, each once. */
  media: MediaKey[];
  /** This database's chat attachment paths, each once. */
  attachments: string[];
  /** Attachment rows naming another database's (or a malformed) path. */
  skippedAttachments: number;
}

/** Collects the files the copied rows name (pure; fed row by row). */
export class StoreContentFileCollector {
  private readonly seen = new Set<string>();
  readonly media: MediaKey[] = [];
  readonly attachments: string[] = [];
  skippedAttachments = 0;

  constructor(
    private readonly storeId: string,
    private readonly bucket: string | null,
  ) {}

  add(table: StoreContentTable, row: unknown): void {
    if (table === "mink_attachments") {
      const path =
        row && typeof row === "object"
          ? (row as Record<string, unknown>).path
          : undefined;
      if (isThisDatabaseAttachmentPath(path, this.storeId)) {
        const id = `private ${path}`;
        if (!this.seen.has(id)) {
          this.seen.add(id);
          this.attachments.push(path);
        }
      } else {
        this.skippedAttachments += 1;
      }
      return;
    }
    for (const key of referencedMediaKeys(row, { bucket: this.bucket })) {
      const id = `${key.source} ${key.key}`;
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      this.media.push(key);
    }
  }

  result(): StoreContentFiles {
    return {
      media: [...this.media],
      attachments: [...this.attachments],
      skippedAttachments: this.skippedAttachments,
    };
  }
}

/**
 * The pending entries for the files a store's rows name, numbered from 1
 * (entry 0 is the content file itself).
 */
export function storeContentPendingFiles(
  files: StoreContentFiles,
  at: string,
): PendingArchiveFile[] {
  const entries: PendingArchiveFile[] = [];
  let n = 1;
  for (const key of files.media) {
    entries.push(
      pendingArchiveFile({ n: n++, source: key.source, path: key.key, at }),
    );
  }
  for (const path of files.attachments) {
    entries.push(pendingArchiveFile({ n: n++, source: "private", path, at }));
  }
  return entries;
}

type RowPage = { id?: unknown; row?: unknown }[];

async function readPage(
  db: Db,
  table: StoreContentTable,
  storeId: string,
  after: string | null,
): Promise<RowPage> {
  // The table name comes from STORE_CONTENT_TABLES only.
  const relation = sql.raw(`public.${table}`);
  if (table === "stores") {
    const result = await db.execute(
      sql`select t.id::text as id, to_jsonb(t)::text as row
            from ${relation} t where t.id = ${storeId}`,
    );
    return result.rows as RowPage;
  }
  if (SINGLE_ROW_TABLES.has(table)) {
    const result = await db.execute(
      sql`select t.store_id::text as id, to_jsonb(t)::text as row
            from ${relation} t where t.store_id = ${storeId}`,
    );
    return result.rows as RowPage;
  }
  const result =
    after === null
      ? await db.execute(
          sql`select t.id::text as id, to_jsonb(t)::text as row
                from ${relation} t
               where t.store_id = ${storeId}
               order by t.id
               limit ${STORE_CONTENT_PAGE_SIZE}`,
        )
      : await db.execute(
          sql`select t.id::text as id, to_jsonb(t)::text as row
                from ${relation} t
               where t.store_id = ${storeId} and t.id > ${after}::uuid
               order by t.id
               limit ${STORE_CONTENT_PAGE_SIZE}`,
        );
  return result.rows as RowPage;
}

export type StoreContentRead =
  | {
      ok: true;
      bytes: Uint8Array;
      rows: Record<string, number>;
      files: StoreContentFiles;
    }
  | { ok: false; reason: "too_large" | "read_failed" };

class TooLarge extends Error {}

/**
 * Read the whole store in one REPEATABLE READ, read-only transaction and
 * build the file. `bucket` is this environment's public bucket, for the
 * media keys.
 */
export async function readStoreContent(
  storeId: string,
  bucket: string | null,
  maxBytes: number = STORE_CONTENT_MAX_BYTES,
): Promise<StoreContentRead> {
  const encoder = new TextEncoder();
  try {
    return await withService(async (db) => {
      await db.execute(
        sql`set transaction isolation level repeatable read, read only`,
      );
      const chunks: Uint8Array[] = [];
      let total = 0;
      const rows: Record<string, number> = {};
      const collector = new StoreContentFileCollector(storeId, bucket);
      for (const table of STORE_CONTENT_TABLES) {
        rows[table] = 0;
        let after: string | null = null;
        for (;;) {
          const page = await readPage(db, table, storeId, after);
          for (const entry of page) {
            const rowJson = typeof entry.row === "string" ? entry.row : null;
            if (rowJson === null) continue;
            const line = encoder.encode(storeContentLine(table, rowJson));
            total += line.byteLength;
            if (total > maxBytes) throw new TooLarge();
            chunks.push(line);
            rows[table] += 1;
            collector.add(table, JSON.parse(rowJson));
          }
          if (SINGLE_ROW_TABLES.has(table)) break;
          if (page.length < STORE_CONTENT_PAGE_SIZE) break;
          const last = page[page.length - 1]?.id;
          if (typeof last !== "string") break;
          after = last;
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { ok: true as const, bytes, rows, files: collector.result() };
    });
  } catch (err) {
    if (err instanceof TooLarge) return { ok: false, reason: "too_large" };
    logError("moderation: store copy read failed", loggableError(err), {
      storeId,
    });
    return { ok: false, reason: "read_failed" };
  }
}

export type StoreContentResult =
  | {
      ok: true;
      /** What the snapshot says about the file. */
      content: SnapshotStoreContent;
      /** Archive entry 0: the content file itself, copied. */
      entry: ArchivedFile;
      /** The files the rows name, for the follow-up. */
      pending: PendingArchiveFile[];
      /** This attempt made the object (so a failed block deletes it). */
      created: boolean;
    }
  | {
      ok: false;
      reason: "unavailable" | "too_large" | "read_failed";
      failure?: StorageFailure;
    };

/**
 * Make a store's copy for a store block (design 5.3 step 2): read, write the
 * file create-only under the block's folder, and list what it names. Refuses
 * (never writes part of a copy) when the private bucket is not set up, the
 * read fails, the store is too large or storage does not answer.
 */
export async function writeStoreContent(
  input: { storeId: string; blockId: string },
  storage: ModerationStorage = moderationStorage,
): Promise<StoreContentResult> {
  const privateBucket = storage.bucketName("private");
  if (!privateBucket) return { ok: false, reason: "unavailable" };
  let archivePath: string;
  try {
    archivePath = archiveStoreContentPath(input.blockId);
  } catch {
    return { ok: false, reason: "read_failed" };
  }
  const read = await readStoreContent(
    input.storeId,
    storage.bucketName("public"),
  );
  if (!read.ok) return read;
  const written = await writeArchiveObject(
    archivePath,
    read.bytes,
    STORE_CONTENT_TYPE,
    storage,
  );
  if (!written.ok) {
    return { ok: false, reason: "unavailable", failure: written.failure };
  }
  const at = storage.now().toISOString();
  const pending = storeContentPendingFiles(read.files, at);
  const entry: ArchivedFile = {
    n: 0,
    source: "private",
    path: STORE_CONTENT_FILE,
    state: "copied",
    sourceBucket: privateBucket,
    sourceGeneration: null,
    archivePath,
    archiveGeneration: written.generation,
    size: written.size,
    contentType: STORE_CONTENT_TYPE,
    md5: written.md5,
    crc32c: null,
    sha256: written.sha256,
    cacheControl: null,
    at,
  };
  return {
    ok: true,
    content: {
      file: STORE_CONTENT_FILE,
      archivePath,
      generation: written.generation,
      size: written.size,
      md5: written.md5,
      sha256: written.sha256,
      rows: read.rows,
      files: pending.length,
      skippedAttachments: read.files.skippedAttachments,
    },
    entry,
    pending,
    created: written.created,
  };
}
