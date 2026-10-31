// One picture attached to a Mink chat, for the person who attached it.
//
// ★★ THE ONLY WAY TO READ A CHAT ATTACHMENT. Attached pictures live in the
// PRIVATE bucket (GCS_PRIVATE_BUCKET; lib/mink/attachments.ts), never the
// public media bucket (open to anyone who has an object's link). This route
// is the gate: a signed-in viewer with a profile on the store the host names,
// asking for a picture THEY attached (`a.admin_id` is bound to the viewer in
// the read), while it is not marked for deletion and its chat, if any, is
// active and within its 90 days. Anything else is a 404 that says nothing
// about other stores or other staff. Modelled on the inbox media route.
//
// ★ `Cache-Control: private, no-cache` with an ETag of the id: the browser
// keeps the bytes but asks every time, so a deleted chat, or another person
// signed in on the same browser, gets a 404 and not a cached picture. A
// matching If-None-Match is answered 304 after every check, with no storage
// read.
//
// ★ NEVER RUN AS A PAGE: nosniff, same-origin resource policy and a CSP
// sandbox, as the inbox route serves a photo. Only the five image types are
// ever stored, so there is no download branch and no byte range.

import type { NextRequest } from "next/server";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { readMinkAttachmentForViewer } from "@/lib/mink/attachments";
import { logError } from "@/lib/observability/logger";
import {
  gcsObjectInfo,
  gcsObjectStream,
  gcsPrivateConfigured,
} from "@/lib/storage/gcs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plain(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** `inline`, with the name in both RFC 6266 forms when there is one. */
function disposition(name: string): string {
  if (!name) return "inline";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Whether If-None-Match names this ETag (one of several, weak or not). */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const tag = part.trim().replace(/^W\//, "");
    return tag === etag || tag === "*";
  });
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
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  // A signed-out request (an <img> whose session lapsed) gets a 401, not the
  // login page's HTML; an access lookup that failed is an outage, never a
  // refusal; a viewer with no profile on this store gets 403 and no file.
  const viewer = await getViewerContext().catch(() => null);
  if (!viewer) return plain(401);
  if (viewer.dbError) return plain(503);
  if (!viewer.profile) return plain(403);
  // No private bucket in this environment: nothing could serve the picture.
  if (!gcsPrivateConfigured) return plain(503);

  const { attachmentId } = await params;
  if (!UUID.test(attachmentId)) return plain(404);
  const id = attachmentId.toLowerCase();

  try {
    // ★ The store from the host, the admin from the session: never a value
    //   from the request.
    const row = await readMinkAttachmentForViewer({
      storeId: viewer.storeId,
      adminId: viewer.userId,
      id,
    });
    if (!row) return plain(404);

    const etag = `"${id}"`;
    if (etagMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "private, no-cache" },
      });
    }

    const info = await gcsObjectInfo("private", row.path);
    if (!info) return plain(404);
    const stream = await gcsObjectStream("private", row.path);
    return new Response(toWebStream(stream), {
      status: 200,
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(info.size),
        ETag: etag,
        "Cache-Control": "private, no-cache",
        "Content-Disposition": disposition(row.filename),
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    logError("mink.attachments: read failed", err, {
      storeId: viewer.storeId,
      adminId: viewer.userId,
      attachmentId: id,
    });
    return plain(502);
  }
}
