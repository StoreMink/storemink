import "server-only";

import { withService } from "@/lib/db/client";
import { getActingStoreId, getViewerAccess } from "@/app/dashboard/lib/access";
import { rateLimit } from "@/lib/rate-limit";
import { loadWhatsAppSender, type WhatsAppSender } from "./channel";
import { loadConversation, type ConversationCore } from "./inbox-read";
import type { InboxSendResult } from "./inbox-types";

// ---------------------------------------------------------------------------
// The inbox's two gates, shared by the server actions and the media route so
// the two cannot disagree about who may read, who may send, and how fast.
// Every caller resolves the store from the host and the person from the
// session; a conversation id from the browser is a claim about WHICH
// conversation, never about whose.
// ---------------------------------------------------------------------------

export type InboxGate =
  | { ok: true; storeId: string; userId: string; isSuperadmin: boolean }
  | { ok: false; error: string };

export async function inboxGate(action: "view" | "manage"): Promise<InboxGate> {
  const access = await getViewerAccess();
  if (!access || !access.can("inbox", action)) {
    return {
      ok: false,
      error:
        action === "manage"
          ? "You don't have permission to reply in the inbox."
          : "You don't have permission to view the inbox.",
    };
  }
  return {
    ok: true,
    storeId: await getActingStoreId(),
    userId: access.userId,
    isSuperadmin: access.isSuperadmin,
  };
}

export interface InboxSendContext {
  storeId: string;
  userId: string;
  core: ConversationCore;
  sender: WhatsAppSender;
}

/**
 * Everything a send needs, or the refusal to hand back: Inbox manage, a
 * well-formed id, the per-person rate limit (sixty a minute: more than
 * anyone types, less than a stuck key), the conversation on THIS store, and
 * a number that can send.
 */
export async function inboxSendGate(
  conversationId: string,
): Promise<
  ({ ok: true } & InboxSendContext) | { ok: false; result: InboxSendResult }
> {
  const g = await inboxGate("manage");
  if (!g.ok) return { ok: false, result: { ok: false, error: g.error } };
  if (!isUuid(conversationId)) {
    return { ok: false, result: { ok: false, error: "Not found." } };
  }
  const allowed = await rateLimit(`inbox-send:${g.storeId}:${g.userId}`, {
    max: 60,
    windowSeconds: 60,
  });
  if (!allowed.allowed) {
    return {
      ok: false,
      result: { ok: false, error: "Slow down - too many messages at once." },
    };
  }
  const core = await loadConversation(g.storeId, conversationId);
  if (!core) return { ok: false, result: { ok: false, error: "Not found." } };
  const sender = await withService((db) => loadWhatsAppSender(db, g.storeId));
  if (!sender) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "not_connected",
        error:
          "WhatsApp is paused, not connected, or not included in your plan. Check Settings → Channels.",
      },
    };
  }
  return { ok: true, storeId: g.storeId, userId: g.userId, core, sender };
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    v ?? "",
  );
}
