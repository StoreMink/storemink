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
import { getArchiveForViewing } from "@/lib/moderation/console-read";
import { logError } from "@/lib/observability/logger";

// The record of a block's archived copy as one JSON file, for a superadmin
// (takedown design 3.6, 5.5; decision D2): the snapshot, its SHA-256 and the
// file list, to hand to an authority.
//
//   GET /api/platform/takedowns/<blockId>/record?receipt=<event id>
//
// ★ `/api` bypasses proxy.ts, so this route is its own gate: anyone but a
// superadmin gets the same plain 404, and nothing is read or recorded.
//
// ★ NEVER READ UNRECORDED. The receipt is the operator's own view or
// download of this block, less than ten minutes old (`openArchiveAction`
// answers it). This route records the download (`archive_downloaded`, what
// "record") with that receipt's reason, then reads the copy on the NEW
// event, so the file handed out is always the one just recorded.
//
// ★ The same locked-down headers as the file route: `private, no-store`,
// nosniff, same-origin only, a CSP sandbox, noindex, and an attachment.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const unavailable = () => plain(503, "Could not open it. Please try again.");

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

/** A refusal from the archive, as a status. */
function refusal(error: string): Response {
  if (error === ARCHIVE_ERRORS.purged) return plain(410, error);
  if (error === ARCHIVE_ERRORS.notFound) return notFound();
  if (error === ARCHIVE_ERRORS.reasonMissing) return plain(403, error);
  return unavailable();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ blockId: string }> },
) {
  const operator = await superadmin();
  if (!operator) return notFound();
  const { blockId } = await params;
  if (!UUID.test(blockId)) return notFound();
  const id = blockId.toLowerCase();
  const receipt = (
    new URL(request.url).searchParams.get("receipt") ?? ""
  ).trim();
  if (!UUID.test(receipt)) return plain(403, ARCHIVE_ERRORS.reasonMissing);

  let reason: string | null;
  try {
    reason = await receiptReason(id, receipt.toLowerCase(), operator.email);
  } catch (err) {
    logError("moderation: archive receipt not read", loggableError(err), {
      blockId: id,
    });
    return unavailable();
  }
  if (!reason) return plain(403, ARCHIVE_ERRORS.reasonMissing);

  // Recorded before anything of the copy is read.
  const recorded = await recordArchiveView(id, reason, operator, {
    download: true,
    what: "record",
  });
  if (!recorded.ok) return refusal(recorded.error);

  const read = await getArchiveForViewing(
    id,
    { eventId: recorded.eventId },
    operator,
  ).catch((err: unknown) => {
    logError("moderation: archive record not read", loggableError(err), {
      blockId: id,
    });
    return null;
  });
  if (!read) return unavailable();
  if (!read.ok) return refusal(read.error);

  const { archive } = read;
  const body = JSON.stringify(
    {
      blockId: archive.blockId,
      storeId: archive.storeId,
      archivedAt: archive.createdAt,
      keepUntil: archive.keepUntil,
      legalHold: archive.legalHold,
      filesState: archive.filesState,
      sha256: archive.sha256,
      sha256Of: "the snapshot, as canonical JSON (keys sorted)",
      hashMatches: archive.hashMatches,
      downloadedAt: new Date().toISOString(),
      downloadedBy: operator.email,
      snapshot: archive.snapshot,
      files: archive.files.map((file) => file.raw),
    },
    null,
    2,
  );
  return new Response(body, {
    status: 200,
    headers: {
      ...LOCKED_DOWN,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="takedown-record-${id}.json"`,
    },
  });
}
