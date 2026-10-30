// One WhatsApp chat file (a photo, voice note, video or PDF) for the inbox.
//
// ★★ THE ONLY WAY TO READ CHAT MEDIA. Files live in the PRIVATE bucket
// (GCS_PRIVATE_BUCKET), never the public media bucket. That bucket's allUsers
// objectViewer grant included listing, so anyone could enumerate and download
// every store's chat photos from it. Since the storage release (owner step
// P1) it grants roles/storage.legacyObjectReader (get, no list), but anyone
// holding a URL can still read the file, so chat media stays private. This
// route is the gate instead: a signed-in viewer with Inbox view, on the store
// the host names, asking for a message that belongs to that store. Anything
// else is a 404 that says nothing about whether the id exists elsewhere.
//
// ★ RANGES, because an <audio> element asks for them and Safari will not
// play a voice note without them. One range; several get the whole file.
//
// ★ A FILE IS NEVER SERVED AS SOMETHING THE BROWSER WOULD RUN. Only the
// types WhatsApp actually carries are served inline; anything else goes out
// as a download, with nosniff, so an HTML or SVG file a customer sent can
// never execute on the dashboard's origin.
//
// Files stored before the private bucket existed are still read from the
// public one (same path) until scripts/whatsapp-media-to-private.mjs moves them.

import type { NextRequest } from "next/server";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { parseByteRange } from "@/lib/http/byte-range";
import { logError } from "@/lib/observability/logger";
import {
  gcsConfigured,
  gcsObjectInfo,
  gcsObjectStream,
  gcsPrivateConfigured,
  type GcsBucketKind,
} from "@/lib/storage/gcs";
import { inboxGate, isUuid } from "@/lib/whatsapp/inbox-gate";
import { loadInboxMessageMedia } from "@/lib/whatsapp/inbox-read";

export const runtime = "nodejs";

/** What WhatsApp carries and a browser can show safely in place. */
const INLINE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "video/mp4",
  "video/3gpp",
  "application/pdf",
]);

function plain(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", ...extra },
  });
}

function baseType(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** `inline` or `attachment`, with the name in both RFC 6266 forms. */
function disposition(kind: "inline" | "attachment", name: string | null) {
  if (!name) return kind;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** A Node stream as a web stream, pulled so a slow reader slows the read. */
function toWebStream(stream: AsyncIterable<unknown> & { destroy(): void }) {
  const iterator = stream[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      if (value instanceof Uint8Array) controller.enqueue(value);
      else if (typeof value === "string") {
        controller.enqueue(new TextEncoder().encode(value));
      }
    },
    cancel() {
      stream.destroy();
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  // A signed-out request gets a 401, not the login page's HTML.
  const viewer = await getViewerContext().catch(() => null);
  if (!viewer) return plain(401);
  const gate = await inboxGate("view");
  if (!gate.ok) return plain(403);

  const { messageId } = await params;
  if (!isUuid(messageId)) return plain(404);

  try {
    const media = await loadInboxMessageMedia(gate.storeId, messageId);
    if (!media) return plain(404);

    // The private bucket first; the public one only for files stored before
    // the private bucket existed.
    let bucket: GcsBucketKind | null = null;
    let info: Awaited<ReturnType<typeof gcsObjectInfo>> = null;
    if (gcsPrivateConfigured) {
      info = await gcsObjectInfo("private", media.path);
      if (info) bucket = "private";
    }
    if (!bucket && gcsConfigured) {
      info = await gcsObjectInfo("public", media.path);
      if (info) bucket = "public";
    }
    if (!bucket || !info) return plain(404);

    const type = baseType(media.mime) || baseType(info.contentType);
    const inline = INLINE_TYPES.has(type);
    const range = parseByteRange(request.headers.get("range"), info.size);
    if (range === "unsatisfiable") {
      return plain(416, { "Content-Range": `bytes */${info.size}` });
    }

    const stream = await gcsObjectStream(
      bucket,
      media.path,
      range ?? undefined,
    );
    const length = range ? range.end - range.start + 1 : info.size;
    const headers: Record<string, string> = {
      "Content-Type": inline ? type : "application/octet-stream",
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      "Content-Disposition": disposition(
        inline ? "inline" : "attachment",
        media.name,
      ),
      // A message's file never changes; the cache is this browser's only.
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    };
    // A PDF viewer will not open inside a sandbox; every other inline type
    // is a picture, a sound or a video, which needs nothing the sandbox takes.
    if (type !== "application/pdf") {
      headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
    }
    if (range) {
      headers["Content-Range"] =
        `bytes ${range.start}-${range.end}/${info.size}`;
    }
    return new Response(toWebStream(stream), {
      status: range ? 206 : 200,
      headers,
    });
  } catch (err) {
    logError("inbox media: read failed", err, {
      storeId: gate.storeId,
      messageId,
    });
    return plain(502);
  }
}
