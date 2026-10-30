import "server-only";

// ---------------------------------------------------------------------------
// Mink AI chat attachments: a picture a merchant attaches in the chat is kept
// PRIVATELY with the chat and deleted with it (migration 20261028_0262,
// next-release/storage.md). This module is the server side of that: the save,
// the discard of a picture never sent, the read the attachment route serves,
// the link at send, the purge, the promotion to a Media Library copy when a
// tool puts the picture on the store, and the inline read for image
// generation (design 5.3 items 5 and 6). The legacy move (item 8) is
// lib/mink/attachments-legacy.ts.
//
// ★★ ONE ROW PER PICTURE, WRITTEN BEFORE ITS OBJECT. `mink_attachments` gets
// the row first and the private bucket the object second, so every object
// has a row and the purge never lists the bucket. A row whose upload threw is
// DISCARDED, never deleted outright (review R3): the bytes may have landed
// with the answer lost, so the row is marked, the object deleted (a missing
// one is fine), then the row; if that fails the purge finishes it from the
// row. An object with no row would be nobody's for ever.
//
// ★★ ONLY THE ATTACHER OPENS IT. The viewer read binds the row's admin_id, so
// one staff member's screenshots never serve another's, and only while the
// picture is unsent or its chat is active and within its 90 days (the rule
// every other chat reader follows, history design 4.4). ★ A picture whose
// chat row was deleted without the retire's mark (`conversation_id` null,
// `linked_at` set: the foreign key's SET NULL) is DEAD everywhere (review R4):
// it is not served, counted as waiting, linked again, used by a tool, and the
// never-sent mark purges it without the 2-day wait.
//
// ★★ THE PATH NAMES THE DATABASE, `stores/{store}/mink-attachments/{DB_NAME}/`,
// the Refine stages' rule (lib/mink/refine-stages.ts): local development
// shares the dev and staging bucket, and storemink_local holds staging's rows
// with the same ids, so the purge deletes an object only under its own
// database's segment and removes the row either way (design 5.8).
//
// ★★ ONLY THE PICTURE-PLACING TOOLS GET A PUBLIC COPY, AND ONLY IN A PICTURE
// FIELD. An attachment reaches the store only through the tools that put
// pictures on it, only in their picture arguments (the registry's
// `attachmentArgs`), and inside those only in a picture field: a key ending
// in `_url` or `Url`, an item of one ending in `_urls` or `Urls`, or the
// `value` of a `{path, value}` pair whose path ends in one (review S2). Just
// before such a tool runs, `promoteMinkAttachmentRefs` copies the private
// picture into the Media Library as an ordinary upload, at a path with a
// random part (review S1), and hands the tool the copy's public URL. Image
// generation reads the bytes privately instead
// (`readMinkAttachmentReferences`): no public copy is ever made for it. Both
// read only a picture that is unsent or in the run's own chat (review S5).
//
// ★ Every withService scope is separate, never nested, and none holds a
//   connection across a storage call (lib/db/nested-scope-coverage.test.ts).
// ★ Bytes StoreMink has blocked never come back through a chat picture
//   (takedown design 5.7, storage design 14.1 point 1): the save, the Library
//   copy and the inline read each ask the re-upload guard, which records one
//   `reupload_refused` and refuses with the attachment sentence (named when
//   the store was told of the block, nameless when it was not). The copy is
//   written through `writeStoreObject`, and an earlier copy blocked since is
//   never reused. A store under a legal hold keeps its pictures: the purge's
//   candidates leave it out (storage decision D10).
// ---------------------------------------------------------------------------

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { can } from "@/app/dashboard/lib/permissions";
import { mediaAssets, minkAttachments } from "@/drizzle/schema";
import { type Db, withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { isBlockedMediaUrl } from "@/lib/moderation/blocked-objects";
import { attachmentRefusal } from "@/lib/moderation/copy";
import {
  assertUploadAllowed,
  isBlockedUploadError,
} from "@/lib/moderation/upload-guard";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  gcsDeletePaths,
  gcsDownloadObject,
  gcsPrivateUploadObject,
  gcsPublicUrl,
} from "@/lib/storage/gcs";
import {
  MAX_IMAGE_BYTES,
  processImageUpload,
} from "@/lib/storage/process-image";
import { writeStoreObject } from "@/lib/storage/store-objects";
import {
  MINK_ATTACHMENT_ONLY_AS_A_PICTURE,
  minkAttachmentIdOf,
  minkAttachmentIdsInValue,
  minkAttachmentUrl,
} from "./attachment-ref";
import { MinkToolInputError } from "./errors";
import type { MinkActorContext } from "./types";

/** The folder under a store's prefix in the private bucket. */
export const MINK_ATTACHMENT_FOLDER = "mink-attachments";

/** A picture attached but never sent is purged this many days after upload. */
export const MINK_ATTACHMENT_UNSENT_DAYS = 2;

/** At most this many pictures may wait to be sent, per admin and store. */
export const MINK_ATTACHMENT_WAITING_LIMIT = 50;

/** Vertex's per-file inline limit; what image generation may read inline. */
export const MINK_ATTACHMENT_INLINE_MAX_BYTES = 7 * 1024 * 1024;

/** An object the purge could not delete is tried again after this long. */
export const MINK_ATTACHMENT_RETRY_FAILED_AFTER_DAYS = 7;

/** `mink_attachments_filename_check`. */
export const MINK_ATTACHMENT_FILENAME_MAX = 160;

/** The batch a store's purge takes after the merchant's delete. */
export const MINK_ATTACHMENT_STORE_PURGE_LIMIT = 20;

/** A store's purge runs at most this many full batches (review R10)... */
export const MINK_ATTACHMENT_STORE_PURGE_ROUNDS = 5;

/** ...and starts none after this long. */
export const MINK_ATTACHMENT_STORE_PURGE_BUDGET_MS = 10_000;

/**
 * A purge's claim keeps its rows from every other purge this long (review
 * R12): a run that dies after claiming leaves them for 15 minutes, not 7 days.
 */
export const MINK_ATTACHMENT_PURGE_CLAIM_MINUTES = 15;

/** The Media Library's own sentence (app/actions/media-actions.ts). */
export const MINK_ATTACHMENT_UPLOAD_FAILED = "Upload failed. Please try again.";

export const MINK_ATTACHMENT_WAITING_REFUSAL =
  "You have too many images waiting to be sent. Send or remove some, then try again.";

/** The five types processImageUpload can produce, and the extension each is stored under. */
export const MINK_ATTACHMENT_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** At most this many attachments are copied for one tool call (design 5.3 item 5). */
export const MINK_ATTACHMENT_PROMOTE_LIMIT = 20;

/** The Library copy's object name, under the store's ordinary media folder. */
export const MINK_ATTACHMENT_COPY_PREFIX = "mink-attachment-";

/** The types the image generator takes as a reference (media-reference-images.ts). */
export const MINK_ATTACHMENT_REFERENCE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type MinkAttachmentReferenceType =
  (typeof MINK_ATTACHMENT_REFERENCE_TYPES)[number];

/**
 * The registry's refusal (design 5.7): an address outside a picture field, in
 * a tool with none, or in a form the scan cannot vouch for. Defined in the
 * client-safe lib/mink/attachment-ref.ts (the scan throws it) and re-exported
 * here under the same name.
 */
export { MINK_ATTACHMENT_ONLY_AS_A_PICTURE };

/** More attachment addresses in one call than the promotion copies (review R7). */
export const MINK_ATTACHMENT_TOO_MANY = `At most ${MINK_ATTACHMENT_PROMOTE_LIMIT} attached images can be used in one change.`;

export const MINK_ATTACHMENT_NO_MEDIA_PERMISSION =
  "This role can't add images to the Media Library, so Mink AI can't use an attached image in your store.";

export const MINK_ATTACHMENT_NO_LONGER_AVAILABLE =
  "That attached image is no longer available. Attach it again to use it.";

/** The existing refusal of media-reference-images.ts, word for word. */
export const MINK_ATTACHMENT_REFERENCE_TYPE_REFUSAL =
  "A selected reference image is not a supported StoreMink PNG, JPEG, or WebP object. Choose another current-store image.";

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;
const DAY_MS = 86_400_000;

/**
 * The database this process writes attachments for: `DB_NAME` when it is a
 * plain name, else "default". Read on every call. The rule of
 * `refineStageDatabase` (lib/mink/refine-stages.ts), defined here so this
 * module does not pull in the Refine stop code.
 */
export function attachmentDatabase(): string {
  const name = process.env.DB_NAME ?? "";
  return DATABASE_NAME_PATTERN.test(name) ? name : "default";
}

/**
 * `stores/{store}/mink-attachments/{database}/`, with the trailing slash, so
 * `storemink` never claims `storemink_staging`'s objects.
 */
export function minkAttachmentPrefix(storeId: string): string {
  return `stores/${storeId}/${MINK_ATTACHMENT_FOLDER}/${attachmentDatabase()}/`;
}

/** One attachment's private path: the store, this database, the row's own id. */
export function minkAttachmentPath(
  storeId: string,
  id: string,
  ext: string,
): string {
  return `${minkAttachmentPrefix(storeId)}${id}.${ext}`;
}

/**
 * The base64 MD5 of some bytes: the form Google reports as `md5Hash` and the
 * takedown archive records, so a blocked image is matched by the same digest
 * everywhere.
 */
export function md5Base64(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

/** A path under THIS database's segment of the row's store (design 5.8). */
function ownsObject(storeId: string, path: string): boolean {
  return path.startsWith(minkAttachmentPrefix(storeId));
}

function cutFilename(name: string): string {
  return Array.from(name).slice(0, MINK_ATTACHMENT_FILENAME_MAX).join("");
}

/** `and <alias>.store_id = $s` for a store-scoped statement, nothing otherwise. */
function storeClause(alias: string, storeId: string | null | undefined): SQL {
  return storeId ? sql` and ${sql.raw(alias)}.store_id = ${storeId}` : sql``;
}

// ---------------------------------------------------------------------------
// 1. Save
// ---------------------------------------------------------------------------

export interface SavedMinkAttachment {
  id: string;
  /** `/api/mink/attachments/{id}`: what the composer puts in the message. */
  url: string;
  filename: string;
}

/**
 * Store one attached picture: processed like a Media Library upload (type
 * list, 5 MB, WebP, EXIF stripped, SVG rasterised) but STRICTLY (review S3:
 * the bytes must match the declared type, a picture sharp cannot decode is
 * refused rather than stored as sent, and a GIF or AVIF is re-encoded so its
 * metadata goes too), one row in `mink_attachments`, then the object in the
 * private bucket. Answers the address the chat carries, or a merchant-facing
 * refusal.
 */
export async function saveMinkAttachment(input: {
  storeId: string;
  adminId: string;
  file: File;
}): Promise<SavedMinkAttachment | { error: string }> {
  const { storeId, adminId, file } = input;
  const processed = await processImageUpload(file, { strict: true });
  if (!processed.ok) return { error: processed.error };
  const { bytes, contentType } = processed.data;
  const ext = MINK_ATTACHMENT_EXTENSIONS[contentType];
  // A guard: processing can only produce the five types, within 5 MB.
  if (!ext || bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) {
    return { error: MINK_ATTACHMENT_UPLOAD_FAILED };
  }

  const digest = md5Base64(bytes);
  const id = randomUUID();
  const path = minkAttachmentPath(storeId, id, ext);
  // ★ Blocked bytes are refused before anything is stored or counted (design
  //   14.1 point 1): the guard records one `reupload_refused` in its own scope
  //   (never inside another scope's callback) and the merchant reads the
  //   attachment sentence, nameless when the block is kept from the store.
  try {
    await assertUploadAllowed({
      storeId,
      md5Base64: digest,
      path,
      via: "mink_attachment_save",
      contentType,
      actor: adminId,
    });
  } catch (error) {
    if (isBlockedUploadError(error)) {
      return { error: attachmentRefusal(error.told) };
    }
    throw error;
  }

  const waiting = await withService(async (db) => {
    const result = await db.execute(sql`
      select count(*)::int as waiting
        from public.mink_attachments
       where store_id = ${storeId} and admin_id = ${adminId}
         and conversation_id is null and linked_at is null
         and discard_requested_at is null
         and created_at > now() - make_interval(days => ${sql.raw(String(MINK_ATTACHMENT_UNSENT_DAYS))})
    `);
    return Number(
      (result.rows[0] as { waiting?: unknown } | undefined)?.waiting ?? 0,
    );
  });
  if (waiting >= MINK_ATTACHMENT_WAITING_LIMIT) {
    return { error: MINK_ATTACHMENT_WAITING_REFUSAL };
  }

  const filename = cutFilename(file.name || "");

  // ★ The row first (the header's rule).
  try {
    await withService((db) =>
      db.insert(minkAttachments).values({
        id,
        storeId,
        adminId,
        path,
        filename,
        contentType,
        sizeBytes: bytes.length,
      }),
    );
  } catch (error) {
    logError("mink.attachments: row not written", loggableError(error), {
      storeId,
      adminId,
    });
    return { error: MINK_ATTACHMENT_UPLOAD_FAILED };
  }

  try {
    await gcsPrivateUploadObject(path, bytes, contentType);
  } catch (error) {
    logError("mink.attachments: upload failed", loggableError(error), {
      storeId,
      adminId,
      attachmentId: id,
    });
    // ★ The upload may have landed with its answer lost (review R3), so the
    //   row is discarded the ordinary way: marked, the object deleted (a
    //   missing one is fine), then the row. A failure leaves the row marked
    //   (the purge finishes it) or unmarked (the never-sent mark takes it in
    //   2 days, object first); either way the object is found again.
    try {
      await discardUnsentMinkAttachment({ storeId, adminId, id });
    } catch (cleanupError) {
      logError(
        "mink.attachments: row of a failed upload kept for the purge",
        loggableError(cleanupError),
        { storeId, adminId, attachmentId: id },
      );
    }
    return { error: MINK_ATTACHMENT_UPLOAD_FAILED };
  }

  // Content-free: ids, the size and the digest the takedown archive records.
  logInfo("mink.attachments: saved", {
    storeId,
    adminId,
    attachmentId: id,
    contentType,
    sizeBytes: bytes.length,
    md5: digest,
  });
  return { id, url: minkAttachmentUrl(id), filename };
}

// ---------------------------------------------------------------------------
// 2. Discard a picture never sent
// ---------------------------------------------------------------------------

/**
 * Remove a picture the composer let go of before it was sent: only a row of
 * this store and admin, not linked, not marked. The row is marked first (so
 * a send racing this finds it marked and does not link it, the purge's own
 * rule), then the object is deleted, then the row. A sent picture is never
 * discarded alone: it goes with its chat. True when the picture was taken
 * out of use; false when no such row exists.
 */
export async function discardUnsentMinkAttachment(input: {
  storeId: string;
  adminId: string;
  id: string;
}): Promise<boolean> {
  const { storeId, adminId, id } = input;
  const claimed = await withService(async (db) => {
    const result = await db.execute(sql`
      update public.mink_attachments a
         set discard_requested_at = now()
       where a.id = ${id} and a.store_id = ${storeId} and a.admin_id = ${adminId}
         and a.conversation_id is null and a.discard_requested_at is null
      returning a.path
    `);
    return result.rows[0] as { path?: unknown } | undefined;
  });
  if (!claimed) return false;
  const path = String(claimed.path ?? "");

  // ★ The object before the row: a row without its object is purged; an
  //   object without its row is never found again. Another database's object
  //   is left where it is (design 5.8).
  if (ownsObject(storeId, path)) {
    const failed = await gcsDeletePaths([path], "private");
    if (failed.length > 0) {
      // Left marked: the nightly purge deletes it, or records purge_failed_at.
      logWarn("mink.attachments: discard left for the purge", {
        storeId,
        adminId,
        attachmentId: id,
      });
      return true;
    }
  }

  await withService((db) =>
    db.execute(sql`
      delete from public.mink_attachments
       where id = ${id} and store_id = ${storeId}
         and discard_requested_at is not null
    `),
  );
  return true;
}

// ---------------------------------------------------------------------------
// 3. The viewer read (the attachment route)
// ---------------------------------------------------------------------------

export interface MinkAttachmentForViewer {
  path: string;
  contentType: string;
  sizeBytes: number;
  filename: string;
}

/**
 * ★★ `a.admin_id = $a` IS WHAT KEEPS ONE STAFF MEMBER'S SCREENSHOTS FROM EVERY
 * OTHER STAFF MEMBER (design 5.3 item 3; mutation check 1). The row serves
 * only while it is not marked and either unsent (`linked_at` null: a row whose
 * chat was deleted without the mark is dead, review R4) or in a chat that is
 * active and within its 90 days.
 */
export function minkAttachmentForViewerSql(input: {
  storeId: string;
  adminId: string;
  id: string;
}): SQL {
  return sql`
    select a.path, a.content_type, a.size_bytes, a.filename
      from public.mink_attachments a
      left join public.mink_conversations c
        on c.id = a.conversation_id and c.store_id = a.store_id
     where a.id = ${input.id} and a.store_id = ${input.storeId} and a.admin_id = ${input.adminId}
       and a.discard_requested_at is null
       and ((a.conversation_id is null and a.linked_at is null)
            or (c.status = 'active' and c.expires_at > now()))
  `;
}

/** The attachment route's read; null is a 404 whatever the reason. */
export async function readMinkAttachmentForViewer(input: {
  storeId: string;
  adminId: string;
  id: string;
}): Promise<MinkAttachmentForViewer | null> {
  const row = await withService(async (db) => {
    const result = await db.execute(minkAttachmentForViewerSql(input));
    return result.rows[0] as Record<string, unknown> | undefined;
  });
  if (!row) return null;
  return {
    path: String(row.path),
    contentType: String(row.content_type),
    sizeBytes: Number(row.size_bytes),
    filename: String(row.filename ?? ""),
  };
}

// ---------------------------------------------------------------------------
// 4. The link at send (run inside startMinkRun's transaction)
// ---------------------------------------------------------------------------

/**
 * Link the pictures a message carries to its chat: only this admin's own
 * rows of this store, never linked before and not marked. A marked row (a
 * discard or the purge got there first), a dead row (its chat deleted without
 * the mark, review R4) and another admin's row are left alone, so a pasted
 * address links nothing that is not the sender's unsent picture. Null for no
 * ids.
 */
export function linkMinkAttachmentsSql(input: {
  storeId: string;
  adminId: string;
  conversationId: string;
  ids: readonly string[];
}): SQL | null {
  if (input.ids.length === 0) return null;
  return sql`
    update public.mink_attachments a
       set conversation_id = ${input.conversationId}, linked_at = now()
     where a.store_id = ${input.storeId} and a.admin_id = ${input.adminId}
       and a.id = any(${sql.param([...input.ids])}::uuid[])
       and a.conversation_id is null and a.linked_at is null
       and a.discard_requested_at is null
    returning a.id
  `;
}

// ---------------------------------------------------------------------------
// 7. The purge (the retention entry, and the batch after a merchant's delete)
// ---------------------------------------------------------------------------

/**
 * Mark pictures never sent and older than the floor (now minus 2 days), and
 * dead ones at once: a picture whose chat row was deleted without the
 * retire's mark (`conversation_id` null, `linked_at` set, review R4) needs no
 * 2-day wait. A send racing this either linked first (the row is no longer a
 * candidate when the lock re-checks it) or finds the row marked and does not
 * link it.
 */
export function markUnsentMinkAttachmentsSql(input: {
  floorIso: string;
  limit: number;
  storeId?: string | null;
}): SQL {
  return sql`
    update public.mink_attachments a
       set discard_requested_at = now()
     where a.id in (
       select u.id from public.mink_attachments u
        where u.conversation_id is null and u.discard_requested_at is null
          and (u.created_at < ${input.floorIso}::timestamptz
               or u.linked_at is not null)${storeClause("u", input.storeId)}
        order by u.created_at, u.id
        limit ${input.limit}
          for update skip locked
     )
       and a.conversation_id is null and a.discard_requested_at is null
    returning a.id
  `;
}

/**
 * Mark the pictures of chats that are no longer active but were never marked
 * (a chat reduced by the previous revision during a deploy, or by any path
 * that forgets the mark). Chats that are not active are few; the join reads
 * mink_attachments_conversation_idx.
 */
export function markRetiredMinkAttachmentsSql(input: {
  limit: number;
  storeId?: string | null;
}): SQL {
  return sql`
    update public.mink_attachments a
       set discard_requested_at = now()
     where a.id in (
       select a2.id
         from public.mink_conversations c
         join public.mink_attachments a2
           on a2.conversation_id = c.id and a2.store_id = c.store_id
        where c.status <> 'active' and a2.discard_requested_at is null${storeClause("c", input.storeId)}
        limit ${input.limit}
          for update of a2 skip locked
     )
       and a.discard_requested_at is null
    returning a.id
  `;
}

/**
 * CLAIM the marked pictures to delete, oldest mark first (review R12): never
 * one whose delete failed within the last 7 days, so one stuck object never
 * fills the batch (the WhatsApp retention shape, lib/whatsapp/retention.ts),
 * and never one another purge has claimed in the last 15 minutes, so two
 * purges at once (the nightly one and a store's, or a retried sweep) never
 * handle the same rows.
 *
 * ★ The claim is written to `purge_failed_at`, the column the candidates
 *   already wait on, as "now minus 7 days plus 15 minutes": the row is out of
 *   every candidate list for exactly 15 minutes, and no column is added. A
 *   delete that then fails stamps `purge_failed_at = now()` (the 7-day wait,
 *   as before); a delete that works removes the row. A run that dies after
 *   claiming leaves its rows for the next purge 15 minutes later.
 */
export function purgeCandidatesSql(input: {
  limit: number;
  storeId?: string | null;
}): SQL {
  const retryDays = sql.raw(String(MINK_ATTACHMENT_RETRY_FAILED_AFTER_DAYS));
  const claimMinutes = sql.raw(String(MINK_ATTACHMENT_PURGE_CLAIM_MINUTES));
  // ★ A store under a legal hold keeps its pictures (design 14.1 point 3,
  //   storage decision D10, takedown plan A6): its rows stay marked
  //   (unreadable in the app) and are claimed the first night after the hold
  //   is released. Both purges read this one statement.
  return sql`
    update public.mink_attachments a
       set purge_failed_at = now() - make_interval(days => ${retryDays})
                                   + make_interval(mins => ${claimMinutes})
     where a.id in (
       select p.id from public.mink_attachments p
        where p.discard_requested_at is not null
          and (p.purge_failed_at is null
               or p.purge_failed_at < now() - make_interval(days => ${retryDays}))
          and not exists (select 1 from public.store_legal_holds h
                           where h.store_id = p.store_id and h.released_at is null)${storeClause("p", input.storeId)}
        order by p.discard_requested_at, p.id
        limit ${input.limit}
          for update skip locked
     )
       and a.discard_requested_at is not null
       and (a.purge_failed_at is null
            or a.purge_failed_at < now() - make_interval(days => ${retryDays}))
    returning a.id, a.store_id, a.path
  `;
}

interface PurgeCandidate {
  id: string;
  store_id: string;
  path: string;
}

/**
 * One purge batch: the two marks, the claimed candidates, the objects (this
 * database's only), then the rows. Returns the rows CLAIMED (review R12): a
 * row another purge took is not claimed here, so a short count means nothing
 * is left, and a batch that met a stuck object is still a full batch (the
 * stuck rows wait 7 days).
 */
async function purgeBatch(input: {
  floorIso: string;
  limit: number;
  storeId?: string | null;
}): Promise<number> {
  // ★ Scopes one after the other, never one inside another, and the storage
  //   call between the candidates and the row writes holds no connection.
  const markedUnsent = await withService(async (db) => {
    const result = await db.execute(markUnsentMinkAttachmentsSql(input));
    return result.rows.length;
  });
  const markedRetired = await withService(async (db) => {
    const result = await db.execute(markRetiredMinkAttachmentsSql(input));
    return result.rows.length;
  });
  const candidates = await withService(async (db) => {
    const result = await db.execute(purgeCandidatesSql(input));
    return (result.rows as unknown as PurgeCandidate[]).map((row) => ({
      id: String(row.id),
      store_id: String(row.store_id),
      path: String(row.path),
    }));
  });

  const own: PurgeCandidate[] = [];
  const foreign: PurgeCandidate[] = [];
  for (const candidate of candidates) {
    (ownsObject(candidate.store_id, candidate.path) ? own : foreign).push(
      candidate,
    );
  }

  // ★ The objects before the rows (ignores not found). A path of another
  //   database: the row is removed, the object kept for the database that
  //   wrote it.
  const failedPaths = new Set(
    own.length > 0
      ? await gcsDeletePaths(
          own.map((candidate) => candidate.path),
          "private",
        )
      : [],
  );
  const failedIds = own
    .filter((candidate) => failedPaths.has(candidate.path))
    .map((candidate) => candidate.id);
  const removableIds = [
    ...own.filter((candidate) => !failedPaths.has(candidate.path)),
    ...foreign,
  ].map((candidate) => candidate.id);

  let deleted = 0;
  if (removableIds.length > 0) {
    deleted = await withService(async (db) => {
      const result = await db.execute(sql`
        delete from public.mink_attachments
         where id = any(${sql.param(removableIds)}::uuid[])
           and discard_requested_at is not null
        returning id
      `);
      return result.rows.length;
    });
  }
  let failed = 0;
  if (failedIds.length > 0) {
    failed = await withService(async (db) => {
      const result = await db.execute(sql`
        update public.mink_attachments
           set purge_failed_at = now()
         where id = any(${sql.param(failedIds)}::uuid[])
           and discard_requested_at is not null
        returning id
      `);
      return result.rows.length;
    });
  }

  // One content-free line per batch.
  logInfo("mink.attachments: purge batch", {
    marked: markedUnsent + markedRetired,
    claimed: candidates.length,
    deleted,
    failed,
    foreign: foreign.length,
    ...(input.storeId ? { storeId: input.storeId } : {}),
  });
  return candidates.length;
}

/**
 * The nightly retention entry (`RETENTION_POLICIES`, `mink_attachments`):
 * `floorIso` is now minus 2 days, as `sweepPolicy` passes it.
 */
export async function purgeMinkAttachments(
  floorIso: string,
  limit: number,
): Promise<number> {
  return purgeBatch({ floorIso, limit });
}

/**
 * One store's purge, scheduled with `after()` right after the merchant's
 * delete answered, so a deleted chat's pictures usually go within minutes.
 * ★ It runs full batches until one comes back short, at most 5 of them and
 *   none started after 10 seconds (review R10): after the delete the chat's
 *   rows carry no conversation id, so a batch cannot be aimed at them, and a
 *   chat with more pictures than one batch, or a store with older marks
 *   waiting, would otherwise leave them for the night. Returns the rows
 *   claimed. Never throws: nothing waits on it, and the nightly purge is the
 *   backstop.
 */
export async function purgeStoreMinkAttachments(
  storeId: string,
  limit = MINK_ATTACHMENT_STORE_PURGE_LIMIT,
): Promise<number> {
  const floorIso = new Date(
    Date.now() - MINK_ATTACHMENT_UNSENT_DAYS * DAY_MS,
  ).toISOString();
  const until = Date.now() + MINK_ATTACHMENT_STORE_PURGE_BUDGET_MS;
  let total = 0;
  try {
    for (
      let round = 0;
      round < MINK_ATTACHMENT_STORE_PURGE_ROUNDS;
      round += 1
    ) {
      if (round > 0 && Date.now() >= until) break;
      const claimed = await purgeBatch({ floorIso, limit, storeId });
      total += claimed;
      if (claimed < limit) break;
    }
    return total;
  } catch (error) {
    logError("mink.attachments: store purge failed", loggableError(error), {
      storeId,
    });
    return total;
  }
}

// ---------------------------------------------------------------------------
// 5. Promotion: the Media Library copy a picture-placing tool receives
// ---------------------------------------------------------------------------

/**
 * `stores/{store}/media/mink-attachment-{database}-{id}-`: what every public
 * copy of one attachment's path starts with. ★ The database segment keeps
 * storemink_local and staging, which share the media bucket and the same
 * attachment ids, from ever writing or deleting each other's copy (design
 * 5.8); the trailing dash keeps one id from claiming a longer one.
 */
export function minkAttachmentCopyPathPrefix(
  storeId: string,
  id: string,
): string {
  return `stores/${storeId}/media/${MINK_ATTACHMENT_COPY_PREFIX}${attachmentDatabase()}-${id}-`;
}

/**
 * `stores/{store}/media/mink-attachment-{database}-{id}-{16 hex}.{ext}`: the
 * public copy of an attachment, under the store's ordinary media folder.
 * ★★ THE RANDOM PART IS WHAT KEEPS THE COPY UNGUESSABLE (review S1): the
 * attachment id appears in chat history and logs, and a path built from the
 * store, the database and the id alone could be fetched by anyone who learnt
 * it. The copy is found again by its row (`minkAttachmentCopyPathPrefix`),
 * never by rebuilding the path.
 */
export function minkAttachmentCopyPath(
  storeId: string,
  id: string,
  ext: string,
  randomPart: string = randomBytes(8).toString("hex"),
): string {
  return `${minkAttachmentCopyPathPrefix(storeId, id)}${randomPart}.${ext}`;
}

interface MinkAttachmentRow {
  id: string;
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No run has this id: an unreadable run id matches no chat, never every chat. */
const NO_RUN_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The rows a tool may use: only this store's, only this admin's own, not
 * marked. ★ `a.admin_id` is bound to the actor, as the viewer read binds it,
 * so a pasted address never promotes or reads another staff member's picture.
 * ★★ AND ONLY WHAT THE VIEWER READ WOULD SHOW, IN THE RUN'S OWN CHAT (review
 * S5): a picture never sent, or one in a chat that is active and within its
 * 90 days; with a run, that chat must be the run's own (its `mink_runs` row,
 * of this store and requested by this admin), so text in one chat cannot
 * point a tool at a picture of another chat, an expired one, or one whose
 * chat was deleted (review R4). Without a run (a caller outside a chat) only
 * the chat-state condition applies.
 */
export function minkAttachmentsForUseSql(input: {
  storeId: string;
  adminId: string;
  ids: readonly string[];
  runId?: string | null;
}): SQL {
  const sameChat =
    input.runId === undefined || input.runId === null
      ? sql``
      : sql`
                and a.conversation_id = (
                  select r.conversation_id from public.mink_runs r
                   where r.id = ${RUN_ID_PATTERN.test(input.runId) ? input.runId : NO_RUN_ID}::uuid
                     and r.store_id = a.store_id
                     and r.requested_by = a.admin_id)`;
  return sql`
    select a.id, a.path, a.filename, a.content_type, a.size_bytes
      from public.mink_attachments a
      left join public.mink_conversations c
        on c.id = a.conversation_id and c.store_id = a.store_id
     where a.store_id = ${input.storeId} and a.admin_id = ${input.adminId}
       and a.id = any(${sql.param([...input.ids])}::uuid[])
       and a.discard_requested_at is null
       and ((a.conversation_id is null and a.linked_at is null)
            or (c.status = 'active' and c.expires_at > now()${sameChat}))
  `;
}

/** Every id's row, or the "no longer available" refusal for any id without one. */
async function readAttachmentRows(
  actor: Pick<MinkActorContext, "storeId" | "adminId" | "runId">,
  ids: readonly string[],
): Promise<Map<string, MinkAttachmentRow>> {
  const rows = await withService(async (db) => {
    const result = await db.execute(
      minkAttachmentsForUseSql({
        storeId: actor.storeId,
        adminId: actor.adminId,
        ids,
        runId: actor.runId ?? null,
      }),
    );
    return result.rows as Record<string, unknown>[];
  });
  const byId = new Map<string, MinkAttachmentRow>();
  for (const row of rows) {
    byId.set(String(row.id).toLowerCase(), {
      id: String(row.id).toLowerCase(),
      path: String(row.path),
      filename: String(row.filename ?? ""),
      contentType: String(row.content_type),
      sizeBytes: Number(row.size_bytes),
    });
  }
  for (const id of ids) {
    if (!byId.has(id)) {
      throw new MinkToolInputError(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
    }
  }
  return byId;
}

/** The storage SDK's not-found: the row is there, its object is gone. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === 404
  );
}

function extensionOf(row: MinkAttachmentRow): string {
  const known = MINK_ATTACHMENT_EXTENSIONS[row.contentType];
  if (known) return known;
  const dot = row.path.lastIndexOf(".");
  return dot > 0 ? row.path.slice(dot + 1) : "webp";
}

/** Best effort: outside a request (an eval, a test) the page refreshes on its next load. */
function revalidateMediaLibrary(): void {
  try {
    revalidatePath("/dashboard/media");
  } catch {
    // Not in a request scope; nothing to refresh.
  }
}

/**
 * The Media row of an attachment's earlier copy, if there is one: found by
 * the copy's path prefix (the path itself has a random part, review S1),
 * `starts_with` rather than LIKE because a database name may hold `_`.
 */
function existingCopyQuery(db: Db, storeId: string, id: string) {
  return db
    .select({ url: mediaAssets.url })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.storeId, storeId),
        sql`starts_with(${mediaAssets.path}, ${minkAttachmentCopyPathPrefix(storeId, id)})`,
      ),
    )
    .orderBy(mediaAssets.createdAt, mediaAssets.id)
    .limit(1);
}

/**
 * The one Media row for a copy, claimed under the copy's own advisory lock:
 * `media_assets` has no unique index on (store_id, path), so a plain
 * check-then-insert would let two runs write two rows for one attachment, and
 * deleting either would leave the other pointing at a file nobody manages
 * (the exactly-once pattern of lib/mink/media-preparation.ts). The lock is
 * the attachment's, so two copies at different random paths still meet here.
 * ★ The upload stays OUTSIDE it: a pooled connection is never held across a
 * storage call.
 */
function recordLibraryCopy(
  actor: Pick<MinkActorContext, "storeId" | "adminId">,
  input: {
    id: string;
    path: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  },
): Promise<{ url: string; created: boolean }> {
  return withService(async (db) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`mink-attachment-copy:${input.id}`}, 0))`,
    );
    const existing = await existingCopyQuery(db, actor.storeId, input.id);
    if (existing[0]?.url) return { url: existing[0].url, created: false };
    const [inserted] = await db
      .insert(mediaAssets)
      .values({
        storeId: actor.storeId,
        url: gcsPublicUrl(input.path),
        path: input.path,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        createdBy: actor.adminId,
        // ★ An ordinary, visible upload (owner's decision): the merchant's own
        //   picture, managed like any other and kept even if the proposal it
        //   was copied for is refused (risk 5).
        source: "upload",
      })
      .returning({ url: mediaAssets.url });
    return { url: inserted.url, created: true };
  });
}

/**
 * The sentence for an earlier copy blocked by its address. The address alone
 * does not say whether the store was told of the block, so the private bytes
 * (the copy is byte for byte the same) are asked of the re-upload guard: a
 * match records one `reupload_refused` and gives the named or nameless
 * sentence. When the bytes do not match (a block with no MD5) or cannot be
 * read, the nameless sentence (decision D21: a block kept from the store must
 * name nothing). Bytes this run already read are passed in, not read twice.
 */
async function blockedCopyRefusal(
  actor: Pick<MinkActorContext, "storeId" | "adminId">,
  row: MinkAttachmentRow,
  read?: Uint8Array,
): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes =
      read ?? (await gcsDownloadObject(row.path, MAX_IMAGE_BYTES, "private"));
  } catch {
    return attachmentRefusal(false);
  }
  try {
    await assertUploadAllowed({
      storeId: actor.storeId,
      md5Base64: md5Base64(bytes),
      path: row.path,
      via: "mink_attachment_copy",
      contentType: row.contentType,
      actor: actor.adminId,
    });
  } catch (error) {
    if (isBlockedUploadError(error)) return attachmentRefusal(error.told);
    throw error;
  }
  return attachmentRefusal(false);
}

/**
 * One attachment's Library copy: an existing copy's row is reused (no second
 * upload); otherwise the private bytes are read, written to a new public path
 * with a random part (review S1), and the row claimed under the lock.
 */
async function copyToLibrary(
  actor: Pick<MinkActorContext, "storeId" | "adminId">,
  row: MinkAttachmentRow,
): Promise<{ url: string; created: boolean }> {
  const ext = extensionOf(row);
  const publicPath = minkAttachmentCopyPath(actor.storeId, row.id, ext);
  const existing = await withService(async (db) => {
    const rows = await existingCopyQuery(db, actor.storeId, row.id);
    return rows[0]?.url ?? null;
  });
  // ★ An earlier copy StoreMink has blocked since is never handed to a
  //   proposal again (design 14.1 point 1). The check is on that copy's own
  //   address: `publicPath` has a fresh random part (review S1), so no block
  //   could ever name it. The refusal is worded by `blockedCopyRefusal`.
  if (existing) {
    if (await isBlockedMediaUrl(existing)) {
      throw new MinkToolInputError(await blockedCopyRefusal(actor, row));
    }
    return { url: existing, created: false };
  }

  let bytes: Uint8Array;
  try {
    bytes = await gcsDownloadObject(row.path, MAX_IMAGE_BYTES, "private");
  } catch (error) {
    if (isNotFound(error)) {
      throw new MinkToolInputError(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
    }
    throw error;
  }
  const digest = md5Base64(bytes);
  // ★ The one public write, through `writeStoreObject` (takedown plan A4,
  //   A8): it asks the re-upload guard first, so blocked bytes are refused
  //   (one `reupload_refused`) before anything is written, with the
  //   attachment sentence here.
  try {
    await writeStoreObject(publicPath, bytes, row.contentType, {
      storeId: actor.storeId,
      via: "mink_attachment_copy",
      actor: actor.adminId,
    });
  } catch (error) {
    if (isBlockedUploadError(error)) {
      throw new MinkToolInputError(attachmentRefusal(error.told));
    }
    throw error;
  }
  const copy = await recordLibraryCopy(actor, {
    id: row.id,
    path: publicPath,
    filename: row.filename || `${MINK_ATTACHMENT_COPY_PREFIX}${row.id}.${ext}`,
    contentType: row.contentType,
    sizeBytes: bytes.length,
  });
  if (!copy.created) {
    // ★ A racing promotion recorded its copy first: this run's object, at its
    //   own random path, has no row, so it goes (best effort; a failure only
    //   leaves an unlisted object no row names).
    await gcsDeletePaths([publicPath], "public");
    // ★ The copy found under the lock gets the first lookup's check: a block
    //   that landed on it between the two runs means it is never reused.
    if (await isBlockedMediaUrl(copy.url)) {
      throw new MinkToolInputError(await blockedCopyRefusal(actor, row, bytes));
    }
  }
  // Content-free: ids, the size and the digest the takedown archive records.
  logInfo("mink.attachments: copied to the Media Library", {
    storeId: actor.storeId,
    adminId: actor.adminId,
    attachmentId: row.id,
    contentType: row.contentType,
    sizeBytes: bytes.length,
    md5: digest,
    created: copy.created,
  });
  return copy;
}

// ---------------------------------------------------------------------------
// The picture fields of a tool's arguments (review S2)
// ---------------------------------------------------------------------------

/** A field holding one picture, or a list of pictures; null for any other field. */
type PictureSlot = "one" | "many" | null;

/**
 * The picture fields every attachment tool uses: `image_url`,
 * `cover_image_url`, `mobile_image_url`, `photo_url`, a section's `*_url`
 * media fields, the builder brand's `logoUrl`, and lists such as
 * `image_urls`. A link (`*_href`), a heading, a body, a label, a name or a
 * description is never one.
 */
function pictureSlot(key: string): PictureSlot {
  if (/(?:_urls|Urls)$/.test(key)) return "many";
  if (/(?:_url|Url)$/.test(key)) return "one";
  return null;
}

/** The last segment of a builder field path ("header.links.0.image_url"). */
function lastPathSegment(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1] ?? "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

interface Placement {
  /** Null: check only. A map: replace each attachment with its copy's URL. */
  urlFor: Map<string, string> | null;
  /** Set when a picture field was rewritten. */
  changed: boolean;
}

function refuseMisplaced(): never {
  throw new MinkToolInputError(MINK_ATTACHMENT_ONLY_AS_A_PICTURE);
}

/**
 * Walk one argument and handle every attachment address in it: ★★ IN A
 * PICTURE FIELD the whole value must be the address (any host; nothing else
 * around it) and it becomes the copy's URL; ANYWHERE ELSE it refuses the whole
 * call. A builder field change `{path, value}` counts as the field its path
 * ends in, so `header.links.0.image_url` takes a picture and `...href` never
 * does. Returns a new value; the input is never changed.
 */
function placePictures(
  node: unknown,
  slot: PictureSlot,
  placement: Placement,
): unknown {
  if (typeof node === "string") {
    if (slot) {
      const id = minkAttachmentIdOf(node);
      if (id) {
        const url = placement.urlFor?.get(id);
        if (url === undefined) return node;
        placement.changed = true;
        return url;
      }
    }
    // Not a picture field, or a picture field holding more than an address:
    // any address in it (the scan reads JSON inside a string too) refuses.
    if (minkAttachmentIdsInValue(node, 1).length > 0) refuseMisplaced();
    return node;
  }
  if (Array.isArray(node)) {
    const itemSlot: PictureSlot = slot === "many" ? "one" : null;
    return node.map((item) => placePictures(item, itemSlot, placement));
  }
  if (isPlainRecord(node)) {
    const path = typeof node.path === "string" ? node.path : null;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(node)) {
      const childSlot =
        key === "value" && path !== null
          ? pictureSlot(lastPathSegment(path))
          : pictureSlot(key);
      next[key] = placePictures(node[key], childSlot, placement);
    }
    return next;
  }
  return node;
}

/**
 * One named argument: by its own name (`image_urls`, `cover_image_url`),
 * through its picture fields (`sections`, `products`), or, for a JSON string
 * (`changes_json`), parsed, placed and written back as JSON only when a
 * picture was rewritten. An unreadable JSON string holding an address refuses.
 */
function placeArgument(
  name: string,
  value: unknown,
  placement: Placement,
): unknown {
  if (/_json$/.test(name) && typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      if (minkAttachmentIdsInValue(value, 1).length > 0) refuseMisplaced();
      return value;
    }
    const inner: Placement = { urlFor: placement.urlFor, changed: false };
    const placed = placePictures(parsed, null, inner);
    if (!inner.changed) return value;
    placement.changed = true;
    return JSON.stringify(placed);
  }
  return placePictures(value, pictureSlot(name), placement);
}

/**
 * The registry's step before a picture-placing tool runs (design 5.3 item 5,
 * 5.7): every attachment address inside the named arguments' picture fields
 * becomes a Media Library copy, and a NEW arguments object carries the
 * copies' public URLs in those fields only. The model's own arguments are
 * never mutated: the orchestrator's memo and the run log keep them.
 *
 * ★★ AN ADDRESS ANYWHERE ELSE REFUSES THE WHOLE CALL before anything is read
 *    or copied: in an argument that is not named, and inside a named one in
 *    any field that is not a picture (a heading, a body, a link, a name; review
 *    S2): a customer message, a coupon email, a social post or a published
 *    page must never print a private screenshot's public link. The registry
 *    refuses the first kind before a write tool's claim; this repeats it so no
 *    caller can promote around it.
 * ★★ IT FAILS CLOSED (review R7): more than 20 attachments in one call, or an
 *    address the scan cannot vouch for (disguised, a key, past the walk's
 *    limits; lib/mink/attachment-ref.ts), refuses rather than leaving an
 *    address in the arguments unrewritten.
 * ★ Media manage is required (the copy is the merchant's own upload, under
 *   the same gate as the Media page), the rows must be the attacher's own,
 *   unmarked and unsent or in the run's own live chat (review S5), and the
 *   registry's signal is checked before every copy.
 * ★ It runs before the tool checks its own arguments, so a proposal the tool
 *   then refuses can leave a Library copy: the merchant's own picture, visible
 *   and deletable, reused by the next attempt (risk 5, accepted by the owner).
 */
export async function promoteMinkAttachmentRefs(
  actor: MinkActorContext,
  args: Record<string, unknown>,
  attachmentArgs: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  const allowed = new Set(attachmentArgs);
  for (const [name, value] of Object.entries(args)) {
    if (allowed.has(name)) continue;
    if (minkAttachmentIdsInValue(value, 1).length > 0) refuseMisplaced();
  }

  // ★ One past the limit, so more than the limit is seen (and refused).
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const name of attachmentArgs) {
    if (!(name in args)) continue;
    for (const id of minkAttachmentIdsInValue(
      args[name],
      MINK_ATTACHMENT_PROMOTE_LIMIT + 1,
    )) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  // Nothing attached: the model's own arguments, untouched.
  if (ids.length === 0) return args;
  if (ids.length > MINK_ATTACHMENT_PROMOTE_LIMIT) {
    throw new MinkToolInputError(MINK_ATTACHMENT_TOO_MANY);
  }

  // ★ Every address must sit in a picture field: checked before any read,
  //   permission answer or copy, so a misplaced one costs nothing.
  for (const name of attachmentArgs) {
    if (!(name in args)) continue;
    placeArgument(name, args[name], { urlFor: null, changed: false });
  }

  if (!can(actor.permissions, "media", "manage", actor.isSuperadmin)) {
    throw new MinkToolInputError(MINK_ATTACHMENT_NO_MEDIA_PERMISSION);
  }
  const signal = options.signal;
  signal?.throwIfAborted();
  const rows = await readAttachmentRows(actor, ids);

  const urlFor = new Map<string, string>();
  let copied = 0;
  for (const id of ids) {
    // ★ The registry's own stop or timeout, before each copy: its reason is
    //   what the registry reports (run_stopped or tool_timeout).
    signal?.throwIfAborted();
    const copy = await copyToLibrary(actor, rows.get(id)!);
    urlFor.set(id, copy.url);
    if (copy.created) copied += 1;
  }
  if (copied > 0) revalidateMediaLibrary();
  logInfo("mink.attachments: promoted", {
    storeId: actor.storeId,
    adminId: actor.adminId,
    attachments: ids.length,
    copied,
    reused: ids.length - copied,
  });

  // ★ A new object: only the named arguments' picture fields are rewritten,
  //   everything else is carried as it was.
  const promoted: Record<string, unknown> = { ...args };
  for (const name of attachmentArgs) {
    if (!(name in promoted)) continue;
    promoted[name] = placeArgument(name, promoted[name], {
      urlFor,
      changed: false,
    });
    // ★ Nothing private may be left behind in what the tool receives.
    if (minkAttachmentIdsInValue(promoted[name], 1).length > 0)
      refuseMisplaced();
  }
  return promoted;
}

// ---------------------------------------------------------------------------
// 6. The inline read for image generation (never a public copy)
// ---------------------------------------------------------------------------

export interface MinkAttachmentReference {
  /** The attachment address as it was given. */
  url: string;
  mimeType: MinkAttachmentReferenceType;
  /** Vertex's inline part: the private bytes, base64 (never a public URL). */
  inlineData: { mimeType: MinkAttachmentReferenceType; data: string };
}

function referenceType(
  contentType: string,
): MinkAttachmentReferenceType | null {
  return (MINK_ATTACHMENT_REFERENCE_TYPES as readonly string[]).includes(
    contentType,
  )
    ? (contentType as MinkAttachmentReferenceType)
    : null;
}

/**
 * The private bytes of attached pictures, for `generate_storefront_image`
 * (design 5.3 item 6; the caller is lib/mink/media-reference-images.ts, which
 * sends them to Vertex as `inlineData`). Only the attacher's own, unmarked
 * rows are read, only jpeg, png and webp are accepted (the existing reference
 * rule), and each read is bounded at Vertex's per-file inline limit. One
 * entry per address given, in the caller's order; a repeated address is read
 * once. Anything that is not an attachment address of this admin's, unsent or
 * in the run's own live chat (review S5), is refused as no longer available.
 */
export async function readMinkAttachmentReferences(
  actor: Pick<MinkActorContext, "storeId" | "adminId" | "runId">,
  urls: readonly string[],
): Promise<MinkAttachmentReference[]> {
  if (urls.length === 0) return [];
  const idOf = new Map<string, string>();
  for (const url of urls) {
    const id = minkAttachmentIdOf(url);
    if (!id) throw new MinkToolInputError(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
    idOf.set(url, id);
  }
  const ids = [...new Set(idOf.values())];
  const rows = await readAttachmentRows(actor, ids);
  // The type refusal before any bytes are read.
  const types = new Map<string, MinkAttachmentReferenceType>();
  for (const id of ids) {
    const mimeType = referenceType(rows.get(id)!.contentType);
    if (!mimeType) {
      throw new MinkToolInputError(MINK_ATTACHMENT_REFERENCE_TYPE_REFUSAL);
    }
    types.set(id, mimeType);
  }

  const data = new Map<string, string>();
  for (const id of ids) {
    const row = rows.get(id)!;
    let bytes: Uint8Array;
    try {
      bytes = await gcsDownloadObject(
        row.path,
        MINK_ATTACHMENT_INLINE_MAX_BYTES,
        "private",
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new MinkToolInputError(MINK_ATTACHMENT_NO_LONGER_AVAILABLE);
      }
      throw error;
    }
    const digest = md5Base64(bytes);
    // ★ Blocked bytes are never sent to the image model as a reference
    //   (design 14.1 point 1): one `reupload_refused`, then the attachment
    //   sentence, nameless when the block is kept from the store.
    try {
      await assertUploadAllowed({
        storeId: actor.storeId,
        md5Base64: digest,
        path: row.path,
        via: "mink_attachment_reference",
        contentType: row.contentType,
        actor: actor.adminId,
      });
    } catch (error) {
      if (isBlockedUploadError(error)) {
        throw new MinkToolInputError(attachmentRefusal(error.told));
      }
      throw error;
    }
    logInfo("mink.attachments: read inline", {
      storeId: actor.storeId,
      adminId: actor.adminId,
      attachmentId: id,
      contentType: row.contentType,
      sizeBytes: bytes.length,
      md5: digest,
    });
    data.set(id, Buffer.from(bytes).toString("base64"));
  }

  return urls.map((url) => {
    const id = idOf.get(url)!;
    const mimeType = types.get(id)!;
    return { url, mimeType, inlineData: { mimeType, data: data.get(id)! } };
  });
}
