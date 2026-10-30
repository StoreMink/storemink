import "server-only";

/**
 * The re-upload guard (takedown design 5.7, 7.4; plan A4): before StoreMink
 * writes a file for a store, the file's bytes are checked against the
 * blocked-object set, and bytes StoreMink has blocked are refused with the
 * sentence of design 7.4 (decision D21) and one `reupload_refused` event.
 *
 * `assertUploadAllowed` is the check every store writer passes through
 * (`writeStoreObject` in lib/storage/store-objects.ts calls it); it throws
 * `BlockedUploadError`, whose message is already the sentence for the person
 * uploading: named when the store was told of the block, nameless when the
 * block is kept from it (a court or government order) or is not this store's
 * own.
 *
 * It reads the in-memory set (no query per upload, except the set's own
 * reload) and writes the event in its own `withService` scope, so it must
 * never be called inside another scope's callback (CODEBASE §5 item 2).
 */

import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import { isBlockedUploadBytes } from "./blocked-objects";
import { uploadRefusal } from "./copy";
import { recordModerationEvent } from "./record";

/** What a refused upload throws. */
export class BlockedUploadError extends Error {
  readonly told: boolean;
  readonly kindWord: string;
  readonly blockId: string;

  constructor(refusal: { told: boolean; kindWord: string; blockId: string }) {
    super(uploadRefusal({ told: refusal.told, kindWord: refusal.kindWord }));
    this.name = "BlockedUploadError";
    this.told = refusal.told;
    this.kindWord = refusal.kindWord;
    this.blockId = refusal.blockId;
  }
}

/**
 * Whether a caught value is a refused upload. Also true for one that crossed
 * a module copy (a second server chunk), where `instanceof` fails.
 */
export function isBlockedUploadError(err: unknown): err is BlockedUploadError {
  if (err instanceof BlockedUploadError) return true;
  return (
    err instanceof Error &&
    err.name === "BlockedUploadError" &&
    typeof (err as { told?: unknown }).told === "boolean"
  );
}

export type UploadCheck = {
  /** The store the file is written for; null for a theme release. */
  storeId: string | null;
  /** The bytes' MD5, base64 (Google's `md5Hash` form). */
  md5Base64: string;
  /** Where the file is written (`stores/...` or `theme-releases/...`). */
  path: string;
  /** Which tool is writing it, for the record (`upload_route`, ...). */
  via: string;
  /** The file's content type, for the refusal's word ("image" or "file"). */
  contentType?: string | null;
  /** Who is uploading (an admin's id or email); "system" when not given. */
  actor?: string | null;
};

/**
 * Refuse bytes StoreMink has blocked: throws `BlockedUploadError` after
 * recording one `reupload_refused` event; returns nothing when the bytes may
 * be written. A failure to record is logged and the refusal still stands.
 */
export async function assertUploadAllowed(check: UploadCheck): Promise<void> {
  const match = await isBlockedUploadBytes(check.storeId, check.md5Base64, {
    path: check.path,
    contentType: check.contentType,
  });
  if (!match) return;

  const actor = check.actor?.trim() ? check.actor.trim() : "system";
  try {
    await withService((db) =>
      recordModerationEvent(db, {
        actor,
        action: "reupload_refused",
        blockId: match.blockId,
        storeId: check.storeId,
        detail: {
          via: check.via,
          path: check.path,
          md5: check.md5Base64,
          told: match.told,
        },
      }),
    );
  } catch (err) {
    logError(
      "moderation.upload_guard: refused upload not recorded",
      loggableError(err),
      { blockId: match.blockId, storeId: check.storeId, via: check.via },
    );
  }
  logWarn("moderation.upload_guard: upload refused", {
    blockId: match.blockId,
    storeId: check.storeId,
    via: check.via,
    told: match.told,
  });
  throw new BlockedUploadError(match);
}
