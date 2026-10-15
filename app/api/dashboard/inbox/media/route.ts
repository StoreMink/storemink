// A photo or a PDF sent from the inbox (docs/whatsapp-commerce-plan.md §11).
//
// ★ A ROUTE HANDLER, NOT A SERVER ACTION, for the reason /api/upload is one:
// a server action's body is capped (6 MB) and a PDF may be 16 MB; and a
// 20-second upload must not sit in the one-at-a-time action queue in front
// of the next Send. It owns exactly one gate (/api bypasses proxy.ts), the
// SAME gate the reply action uses (lib/whatsapp/inbox-gate.ts), so who may
// send and how fast cannot differ between a text and a photo.

import { NextResponse, type NextRequest } from "next/server";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { serviceWindow } from "@/lib/whatsapp/inbox";
import { inboxSendGate, isUuid } from "@/lib/whatsapp/inbox-gate";
import {
  prepareOutboundMedia,
  sendInboxMedia,
} from "@/lib/whatsapp/inbox-media";
import { loadQuotableProviderId } from "@/lib/whatsapp/inbox-read";
import {
  INBOX_MEDIA_DOCUMENT_MAX_BYTES,
  type InboxSendResult,
} from "@/lib/whatsapp/inbox-types";
import { INBOX_CAPTION_MAX } from "@/lib/whatsapp/inbox-workspace";
import { logError } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function respond(result: InboxSendResult, status = 200) {
  return NextResponse.json(result, { status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  // A signed-out upload gets a 401 it can act on, not the login page's HTML.
  const ctx = await getViewerContext().catch(() => null);
  if (!ctx) {
    return NextResponse.json(
      { ok: false, error: "signed-out" },
      { status: 401, headers: NO_STORE },
    );
  }

  // The body is read before the gate only to learn WHICH conversation; the
  // gate still decides, and a refused request costs the caller the upload.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > INBOX_MEDIA_DOCUMENT_MAX_BYTES + 64 * 1024) {
    return respond({ ok: false, error: "A PDF can be at most 16 MB." }, 413);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return respond({ ok: false, error: "Couldn't read the upload." }, 400);
  }
  const conversationId = String(form.get("conversationId") ?? "");
  if (!isUuid(conversationId)) {
    return respond({ ok: false, error: "Not found." }, 404);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return respond({ ok: false, error: "Choose a file first." }, 400);
  }
  const caption = String(form.get("caption") ?? "").slice(
    0,
    INBOX_CAPTION_MAX + 1,
  );
  const replyTo = String(form.get("replyTo") ?? "");

  const s = await inboxSendGate(conversationId);
  if (!s.ok) {
    const status = s.result.error?.startsWith("You don't have permission")
      ? 403
      : s.result.error === "Not found."
        ? 404
        : s.result.code === "not_connected"
          ? 409
          : 429;
    return respond(s.result, status);
  }

  // A file is free-form: the 24-hour window applies exactly as to text.
  if (!serviceWindow(s.core.contact.lastInboundAt).open) {
    return respond(
      {
        ok: false,
        code: "window_closed",
        error:
          "More than 24 hours have passed since the customer last wrote, so WhatsApp only allows an approved template now.",
      },
      409,
    );
  }

  const prepared = await prepareOutboundMedia({
    bytes: new Uint8Array(await file.arrayBuffer()),
    mime: file.type,
    name: file.name,
  });
  if (!prepared.ok) return respond({ ok: false, error: prepared.error }, 400);

  const quotedProviderId =
    replyTo && isUuid(replyTo)
      ? await loadQuotableProviderId(s.storeId, s.core.id, replyTo).catch(
          () => null,
        )
      : null;

  try {
    const result = await sendInboxMedia({
      storeId: s.storeId,
      userId: s.userId,
      conversationId: s.core.id,
      to: s.core.contact.phone,
      token: s.sender.token,
      phoneNumberId: s.sender.phoneNumberId,
      media: prepared.media,
      caption,
      quotedProviderId,
    });
    return respond(result, result.ok ? 200 : 400);
  } catch (err) {
    logError("inbox: media send failed", err, { storeId: s.storeId });
    return respond({ ok: false, error: "Couldn't send the file." }, 503);
  }
}
