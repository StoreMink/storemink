import { sql } from "drizzle-orm";
import { getPlatformViewer } from "@/app/actions/platform";
import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import {
  ARCHIVE_ERRORS,
  ARCHIVE_VIEW_RECEIPT_MINUTES,
  recordArchiveView,
} from "@/lib/moderation/archive";
import type { ModerationOperator } from "@/lib/moderation/complaints";
import { logError } from "@/lib/observability/logger";
import {
  gcsObjectInfo,
  gcsObjectStream,
  gcsPrivateConfigured,
} from "@/lib/storage/gcs";

// One file of a block's archived copy, for a superadmin (takedown design 3.6,
// 5.5; decision D2).
//
//   GET /api/platform/takedowns/<blockId>/files/<n>?receipt=<event id>
//   GET /api/platform/takedowns/<blockId>/files/<n>?receipt=<event id>&download=1
//
// ★ `/api` bypasses proxy.ts, so this route is its own gate: anyone but a
// superadmin (a signed-out caller, a merchant, an operator who is a member)
// gets the same plain 404, and nothing is read or recorded for them.
//
// ★ NEVER READ UNRECORDED. Opening the copy records why
// (`openArchiveAction`, `archive_viewed`) and answers a receipt. A GET cannot
// carry the reason the operator typed, so this route asks for that receipt:
// the operator's own view or download of this block, less than ten minutes
// old (the window `getArchiveForViewing` reads by). It then records THIS
// view or download, with the same reason and the file's number, before a
// single byte is read. A missing or stale receipt is a 403 asking for the
// reason; a link pasted from someone else's session, or replayed later,
// reads nothing.
//
// ★ NEVER RUN AS A PAGE: the archive holds whatever was blocked, so every
// answer is `private, no-store`, nosniff, same-origin only, a CSP sandbox and
// noindex (the Theme Studio reference route's headers). Only plain pictures,
// text and media are shown inline; anything else, and every `download=1`, is
// an attachment.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NUMBER = /^\d{1,6}$/;

/** The types a browser shows inline without running anything. */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "text/plain",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

const LOCKED_DOWN = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Robots-Tag": "noindex",
} as const;

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { ...LOCKED_DOWN, "Content-Type": "text/plain; charset=utf-8" },
  });
}

const notFound = () => plain(404, "Not found");

/** The superadmin asking, from the session; null for anyone else. */
async function superadmin(): Promise<ModerationOperator | null> {
  const viewer = await getPlatformViewer().catch(() => null);
  const email = viewer?.email?.trim() ?? "";
  if (!viewer || viewer.role !== "superadmin" || !email) return null;
  return { email, role: "superadmin" };
}

/**
 * The reason on the operator's own receipt for this block, or null when
 * there is none (wrong block, someone else's, older than ten minutes).
 * Throws when the database cannot be read.
 */
async function receiptReason(
  blockId: string,
  receipt: string,
  actor: string,
): Promise<string | null> {
  const result = await withService((db) =>
    db.execute(sql`
      select e.detail ->> 'reason' as reason
        from public.moderation_events e
       where e.id = ${receipt}::uuid
         and e.block_id = ${blockId}::uuid
         and e.actor = ${actor}
         and e.action in ('archive_viewed', 'archive_downloaded')
         and e.at > now() - make_interval(mins => ${ARCHIVE_VIEW_RECEIPT_MINUTES})
       limit 1
    `),
  );
  const row = (result.rows as { reason?: unknown }[])[0];
  const reason = typeof row?.reason === "string" ? row.reason.trim() : "";
  return reason || null;
}

/** The disposition, with the name in both RFC 6266 forms. */
function disposition(kind: "inline" | "attachment", name: string): string {
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
  request: Request,
  { params }: { params: Promise<{ blockId: string; index: string }> },
) {
  const operator = await superadmin();
  if (!operator) return notFound();
  const { blockId, index } = await params;
  if (!UUID.test(blockId) || !FILE_NUMBER.test(index)) return notFound();
  const id = blockId.toLowerCase();
  const fileNumber = Number(index);
  const query = new URL(request.url).searchParams;
  const receipt = (query.get("receipt") ?? "").trim();
  const download = query.get("download") === "1";
  if (!UUID.test(receipt)) return plain(403, ARCHIVE_ERRORS.reasonMissing);
  if (!gcsPrivateConfigured) {
    return plain(503, "The archive is not available here.");
  }

  let reason: string | null;
  try {
    reason = await receiptReason(id, receipt.toLowerCase(), operator.email);
  } catch (err) {
    logError("moderation: archive receipt not read", loggableError(err), {
      blockId: id,
    });
    return plain(503, "Could not open it. Please try again.");
  }
  if (!reason) return plain(403, ARCHIVE_ERRORS.reasonMissing);

  // Recorded before a byte is read.
  const recorded = await recordArchiveView(id, reason, operator, {
    download,
    what: { file: fileNumber },
  });
  if (!recorded.ok) {
    if (recorded.error === ARCHIVE_ERRORS.purged) {
      return plain(410, ARCHIVE_ERRORS.purged);
    }
    if (
      recorded.error === ARCHIVE_ERRORS.notFound ||
      recorded.error === ARCHIVE_ERRORS.fileNotFound
    ) {
      return notFound();
    }
    return plain(503, "Could not open it. Please try again.");
  }
  const path = recorded.file?.archivePath ?? "";
  if (!path) return notFound();

  try {
    const info = await gcsObjectInfo("private", path);
    if (!info) return notFound();
    const declared = (recorded.file?.contentType ?? info.contentType ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const inline = !download && INLINE_TYPES.has(declared);
    const stream = await gcsObjectStream("private", path);
    return new Response(toWebStream(stream), {
      status: 200,
      headers: {
        ...LOCKED_DOWN,
        "Content-Type": inline ? declared : "application/octet-stream",
        "Content-Length": String(info.size),
        "Content-Disposition": disposition(
          inline ? "inline" : "attachment",
          path.slice(path.lastIndexOf("/") + 1),
        ),
      },
    });
  } catch (err) {
    logError("moderation: archive file not read", loggableError(err), {
      blockId: id,
      file: fileNumber,
    });
    return plain(502, "Could not read the file. Please try again.");
  }
}
