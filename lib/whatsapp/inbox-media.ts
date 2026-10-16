import "server-only";

import { randomUUID } from "node:crypto";
import {
  gcsPrivateConfigured,
  gcsPrivateUploadObject,
} from "@/lib/storage/gcs";
import { logError } from "@/lib/observability/logger";
import { withService } from "@/lib/db/client";
import { uploadMedia } from "./graph";
import { recordOutboundMessage } from "./inbox";
import { conversationMediaPrefix } from "./retention";
import { sendWhatsAppMedia } from "./send";
import { discardMinkDrafts } from "./mink-drafts";
import { INBOX_CAPTION_MAX } from "./inbox-workspace";
import {
  INBOX_MEDIA_DOCUMENT_MAX_BYTES,
  INBOX_MEDIA_IMAGE_MAX_BYTES,
  type InboxSendResult,
} from "./inbox-types";

// ---------------------------------------------------------------------------
// A photo or a PDF sent from the dashboard (plan §4 "media in/out", §11).
//
// ── ★ THE FILE IS PREPARED BEFORE ANYTHING IS SPENT ────────────────────────
// A photo is decoded, oriented, stripped of its metadata (a staff phone's
// photo carries GPS) and re-encoded as a JPEG no wider than 2,048px, which
// is what WhatsApp shows anyway; a PDF is checked to BE a PDF. Only a file
// that passed goes to Meta, then to our bucket, then out.
//
// ── ★ META FIRST, OUR COPY SECOND, THE SEND LAST ───────────────────────────
// Meta's upload returns the id the send needs; if it is refused, nothing has
// been stored and nothing is filed. Our copy is written before the send so
// the thread never shows a photo it cannot display (Meta's media URLs expire
// and need the token, so they are never stored: the inbound rule, applied
// outbound). A send that then fails is filed as a failed message WITH the
// copy, so staff can see what did not go.
// ---------------------------------------------------------------------------

export interface OutboundFile {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

export type PreparedMedia =
  | {
      kind: "image";
      bytes: Uint8Array;
      mime: "image/jpeg";
      ext: ".jpg";
      /** What the customer sees; a photo has no name on WhatsApp. */
      filename: null;
      /** The original name, kept on our row. */
      name: string;
    }
  | {
      kind: "document";
      bytes: Uint8Array;
      mime: "application/pdf";
      ext: ".pdf";
      filename: string;
      name: string;
    };

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_EDGE = 2048;

/**
 * Validate and normalise one uploaded file. The MIME the browser declared
 * is a hint; the bytes decide (sharp refuses a non-image, a PDF must start
 * with its magic). A file that fails is refused with a sentence staff can act
 * on, never silently sent as something else.
 */
export async function prepareOutboundMedia(
  file: OutboundFile,
): Promise<{ ok: true; media: PreparedMedia } | { ok: false; error: string }> {
  const mime = file.mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const name = file.name
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 120);
  if (file.bytes.byteLength === 0) {
    return { ok: false, error: "The file is empty." };
  }
  if (mime === "application/pdf") {
    if (file.bytes.byteLength > INBOX_MEDIA_DOCUMENT_MAX_BYTES) {
      return { ok: false, error: "A PDF can be at most 16 MB." };
    }
    const head = Buffer.from(file.bytes.subarray(0, 5)).toString("latin1");
    if (head !== "%PDF-") {
      return { ok: false, error: "That file is not a PDF." };
    }
    const filename = /\.pdf$/i.test(name) ? name : `${name || "document"}.pdf`;
    return {
      ok: true,
      media: {
        kind: "document",
        bytes: file.bytes,
        mime: "application/pdf",
        ext: ".pdf",
        filename,
        name: filename,
      },
    };
  }
  if (!IMAGE_MIMES.has(mime)) {
    return {
      ok: false,
      error:
        "Send a photo (JPEG, PNG or WebP) or a PDF. Other files, voice notes and videos can be sent from your phone.",
    };
  }
  if (file.bytes.byteLength > INBOX_MEDIA_IMAGE_MAX_BYTES) {
    return { ok: false, error: "A photo can be at most 5 MB." };
  }
  let out: Buffer;
  try {
    const sharp = (await import("sharp")).default;
    out = await sharp(Buffer.from(file.bytes), { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      // ★ JPEG has no alpha: without this a transparent PNG or WebP (a
      // product cutout, a logo with dark text) is composited onto BLACK.
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch {
    return { ok: false, error: "That file could not be read as a photo." };
  }
  if (out.byteLength > INBOX_MEDIA_IMAGE_MAX_BYTES) {
    return { ok: false, error: "A photo can be at most 5 MB." };
  }
  return {
    ok: true,
    media: {
      kind: "image",
      bytes: new Uint8Array(out),
      mime: "image/jpeg",
      ext: ".jpg",
      filename: null,
      name: name || "photo.jpg",
    },
  };
}

export interface SendInboxMediaInput {
  storeId: string;
  userId: string;
  conversationId: string;
  /** E.164. */
  to: string;
  token: string;
  phoneNumberId: string;
  media: PreparedMedia;
  caption: string;
  quotedProviderId: string | null;
}

/** The GCS path a sent file is kept at, in the conversation's own folder. */
export function outboundMediaPath(
  storeId: string,
  conversationId: string,
  ext: string,
): string {
  return `${conversationMediaPrefix(storeId, conversationId)}out-${randomUUID()}${ext}`;
}

export async function sendInboxMedia(
  input: SendInboxMediaInput,
): Promise<InboxSendResult> {
  const caption = input.caption.replace(/\r\n/g, "\n").trim();
  if (caption.length > INBOX_CAPTION_MAX) {
    return {
      ok: false,
      error: `A caption can be at most ${INBOX_CAPTION_MAX} characters.`,
    };
  }
  if (!gcsPrivateConfigured) {
    return { ok: false, error: "File storage is not set up on this server." };
  }

  const uploaded = await uploadMedia(input.token, input.phoneNumberId, {
    bytes: input.media.bytes,
    mime: input.media.mime,
    filename: input.media.filename ?? input.media.name,
  });
  if (!uploaded.ok) {
    return {
      ok: false,
      code: "refused",
      error:
        uploaded.outcome === "unknown"
          ? "Meta didn't accept the file. Try again."
          : `Meta refused the file: ${uploaded.error}`,
    };
  }

  const path = outboundMediaPath(
    input.storeId,
    input.conversationId,
    input.media.ext,
  );
  try {
    // ★ The private bucket, like an inbound file (inbox.ts storeInboundMedia).
    await gcsPrivateUploadObject(path, input.media.bytes, input.media.mime);
  } catch (err) {
    logError("inbox: media copy failed", err, { storeId: input.storeId });
    return { ok: false, error: "Couldn't store the file. Try again." };
  }

  const out = await sendWhatsAppMedia({
    storeId: input.storeId,
    to: input.to,
    token: input.token,
    phoneNumberId: input.phoneNumberId,
    kind: input.media.kind,
    mediaId: uploaded.data.id,
    caption: caption || null,
    filename: input.media.filename,
    replyToProviderId: input.quotedProviderId,
  });

  const messageId = await withService((db) =>
    recordOutboundMessage(db, {
      storeId: input.storeId,
      conversationId: input.conversationId,
      source: "dashboard",
      kind: input.media.kind,
      body: caption,
      providerMessageId: out.sent ? out.messageId : null,
      status: out.sent ? "sent" : "failed",
      error: out.sent ? null : out.error,
      sentByAdminId: input.userId,
      media: { path, mime: input.media.mime, name: input.media.name },
      quotedProviderId: input.quotedProviderId,
    }),
  ).catch((err) => {
    logError("inbox: record media failed", err, { storeId: input.storeId });
    return "";
  });

  if (!out.sent) {
    return {
      ok: false,
      code: "refused",
      messageId: messageId || undefined,
      error:
        out.outcome === "unknown"
          ? "Meta didn't confirm the message. Check WhatsApp logs before sending again."
          : `Meta refused the message: ${out.error}`,
    };
  }
  // A person sent something: a draft Mink left for an earlier message is moot.
  await withService((db) =>
    discardMinkDrafts(db, {
      storeId: input.storeId,
      conversationId: input.conversationId,
      reason: "a person replied",
    }),
  ).catch((err) =>
    logError("inbox: supersede drafts failed", err, { storeId: input.storeId }),
  );
  return { ok: true, messageId };
}
