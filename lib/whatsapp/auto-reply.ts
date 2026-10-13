import "server-only";

import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import { loadWhatsAppSender } from "./channel";
import { sendWhatsAppText, type SendWhatsAppResult } from "./send";
import { recordOutboundMessage } from "./inbox";

// ---------------------------------------------------------------------------
// One automatic answer in a customer's chat: a COD Confirm/Cancel reply, a
// STOP or START acknowledgement.
//
// ★ THROUGH THE CHOKE POINT AND INTO THE THREAD. The text goes out by
// sendWhatsAppText (so it is in WhatsApp logs like any send) and is filed as
// an `automation` message, so staff reading Inbox see exactly what the
// customer was told. Only ever called right after the customer wrote, so the
// 24-hour window is open and free text is allowed.
//
// ★ BEST EFFORT, NEVER THROWS. The answer never decides the action it
// describes: a paused number or a failed send leaves an opt-out or a
// confirmation standing. A failed send is filed as failed, with Meta's reason.
// ---------------------------------------------------------------------------

export interface AutoReplyInput {
  storeId: string;
  conversationId: string;
  /** The customer's phone, E.164. */
  to: string;
  body: string;
  /** For the logs only: which automation answered. */
  reason: string;
}

export async function replyInChat(input: AutoReplyInput): Promise<void> {
  const { storeId, reason } = input;

  const sender = await withService((db) =>
    loadWhatsAppSender(db, storeId),
  ).catch(() => null);
  if (!sender) {
    // Paused, disconnected or a lapsed plan: there is no number to answer from.
    logInfo("whatsapp auto-reply: not sent, no sender", { storeId, reason });
    return;
  }

  let sent: SendWhatsAppResult;
  try {
    sent = await sendWhatsAppText({
      storeId,
      to: input.to,
      token: sender.token,
      phoneNumberId: sender.phoneNumberId,
      body: input.body,
    });
  } catch (err) {
    logError("whatsapp auto-reply: send threw", err, { storeId, reason });
    sent = {
      sent: false,
      outcome: "unknown",
      error: "The reply could not be sent.",
    };
  }

  await withService((db) =>
    recordOutboundMessage(db, {
      storeId,
      conversationId: input.conversationId,
      source: "automation",
      kind: "text",
      body: input.body,
      providerMessageId: sent.sent ? sent.messageId : null,
      status: sent.sent ? "sent" : "failed",
      error: sent.sent ? null : sent.error,
    }),
  ).catch((err) =>
    logError("whatsapp auto-reply: filing failed", err, { storeId, reason }),
  );
}
