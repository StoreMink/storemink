"use server";

import { can } from "@/app/dashboard/lib/permissions";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import {
  discardUnsentMinkAttachment,
  MINK_ATTACHMENT_UPLOAD_FAILED,
  saveMinkAttachment,
} from "@/lib/mink/attachments";
import { MinkRequestError } from "@/lib/mink/errors";
import type { MinkActorContext } from "@/lib/mink/types";
import { logError } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { gcsPrivateConfigured } from "@/lib/storage/gcs";

// ---------------------------------------------------------------------------
// The Mink composer's attachment endpoints: upload a picture into the private
// bucket, and discard one that was never sent.
//
// ★★ EVERY EXPORT OF A "use server" FILE IS A PUBLIC ENDPOINT, so each one
// is its own gate: the actor (signed in, store access, dashboard view, Mink
// access: lib/mink/actor-context.ts), then, for an upload, Media manage, the
// private bucket and the upload route's own rate (60 a minute per admin).
// Nothing about the row comes from the browser but the bytes: the store and
// the admin are the actor's, the path and the id are made in
// lib/mink/attachments.ts.
//
// ★ A THROWN SAVE IS "Upload failed. Please try again." (the upload route's
// sentence), logged without content; a refusal the save itself answers (the
// waiting cap, a blocked image, the type and size rules) passes through as
// `{ error }` in its own words.
//
// ★ A DISCARD NEVER ANSWERS AN ERROR the composer would have to show: it runs
// when a picture is removed or a page is left, so it reports `{ discarded }`
// and nothing else. The page-exit discard stays a route handler
// (/api/mink/media/discard) because an action's id changes with every build.
// ---------------------------------------------------------------------------

/** What the composer puts in the message: the address and the file's name. */
export interface MinkAttachmentUpload {
  id: string;
  /** `/api/mink/attachments/{id}`. */
  url: string;
  filename: string;
}

export type UploadMinkAttachmentResult =
  | MinkAttachmentUpload
  | { error: string };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ROLE_REFUSAL = "Your role can't save images for Mink AI.";
const UNAVAILABLE_REFUSAL = "Image attachments aren't available right now.";
const RATE_REFUSAL =
  "Too many uploads. Please slow down and try again shortly.";
const NO_FILE_REFUSAL = "No file provided.";

/** The actor, or the sentence the caller is refused with. */
async function actorFor(
  requestId: string,
): Promise<MinkActorContext | { error: string }> {
  try {
    return await getMinkActorContext(requestId);
  } catch (error) {
    if (error instanceof MinkRequestError) return { error: error.message };
    logError("mink.attachments: actor unavailable", error, { requestId });
    return { error: MINK_ATTACHMENT_UPLOAD_FAILED };
  }
}

/**
 * Store one picture the merchant attached to the composer, privately, for the
 * chat it is about to be sent in. The form carries the picture as `file`.
 */
export async function uploadMinkAttachment(
  form: FormData,
): Promise<UploadMinkAttachmentResult> {
  const requestId = crypto.randomUUID();
  const actor = await actorFor(requestId);
  if ("error" in actor) return { error: actor.error };
  if (!can(actor.permissions, "media", "manage", actor.isSuperadmin)) {
    return { error: ROLE_REFUSAL };
  }
  if (!gcsPrivateConfigured) return { error: UNAVAILABLE_REFUSAL };
  const { allowed } = await rateLimit(`mink-attachment:${actor.adminId}`, {
    max: 60,
    windowSeconds: 60,
  });
  if (!allowed) return { error: RATE_REFUSAL };

  const file = form instanceof FormData ? form.get("file") : null;
  if (!(file instanceof File)) return { error: NO_FILE_REFUSAL };

  try {
    return await saveMinkAttachment({
      storeId: actor.storeId,
      adminId: actor.adminId,
      file,
    });
  } catch (error) {
    logError("mink.attachments: upload threw", error, {
      requestId,
      storeId: actor.storeId,
      adminId: actor.adminId,
    });
    return { error: MINK_ATTACHMENT_UPLOAD_FAILED };
  }
}

/**
 * Delete a picture the caller attached and never sent (its row and its
 * object). True when one was discarded; false for anything else, a picture
 * already sent, somebody else's or a refused caller included.
 */
export async function discardMinkAttachment(
  id: string,
): Promise<{ discarded: boolean }> {
  const requestId = crypto.randomUUID();
  const actor = await actorFor(requestId);
  if ("error" in actor) return { discarded: false };
  if (typeof id !== "string" || !UUID.test(id)) return { discarded: false };
  try {
    const discarded = await discardUnsentMinkAttachment({
      storeId: actor.storeId,
      adminId: actor.adminId,
      id: id.toLowerCase(),
    });
    return { discarded };
  } catch (error) {
    logError("mink.attachments: discard threw", error, {
      requestId,
      storeId: actor.storeId,
      adminId: actor.adminId,
      attachmentId: id.toLowerCase(),
    });
    return { discarded: false };
  }
}
