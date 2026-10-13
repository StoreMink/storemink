import "server-only";

import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import { loadWhatsAppSender, type WhatsAppSender } from "./channel";
import {
  sendWhatsAppInteractive,
  sendWhatsAppText,
  type SendWhatsAppResult,
} from "./send";
import { recordOutboundMessage } from "./inbox";
import type { InteractiveButton } from "./graph";

// ---------------------------------------------------------------------------
// One automatic answer in a customer's chat: a COD Confirm/Cancel reply, a
// STOP or START acknowledgement, a welcome or away message, the answer to
// "where is my order?".
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
//
// ★ FILED WITHOUT ANSWERING THE CONVERSATION. An automatic message is not a
// person replying: a customer whose question is waiting in Needs reply is still
// waiting after a welcome or a COD confirmation (recordOutboundMessage).
// ---------------------------------------------------------------------------

export interface AutoReplyInput {
  storeId: string;
  conversationId: string;
  /** The customer's phone, E.164. */
  to: string;
  body: string;
  /** For the logs only: which automation answered. */
  reason: string;
  /** The store's sender, when the caller has already loaded it. */
  sender?: WhatsAppSender | null;
  /** Reply buttons under the text (the store's menu): one to three, and the
   *  body then has to fit WhatsApp's 1,024 characters for a button message. */
  buttons?: InteractiveButton[];
  /** Filed on the message row beside the buttons: `{ mink: true, answerId }`
   *  marks an answer customer-facing Mink wrote, which the thread labels. */
  extraPayload?: Record<string, unknown>;
}

/** Send one automatic answer and file it. True when Meta accepted it. */
export async function replyInChat(input: AutoReplyInput): Promise<boolean> {
  const { storeId, reason } = input;

  const sender =
    input.sender ??
    (await withService((db) => loadWhatsAppSender(db, storeId)).catch(
      () => null,
    ));
  if (!sender) {
    // Paused, disconnected or a lapsed plan: there is no number to answer from.
    logInfo("whatsapp auto-reply: not sent, no sender", { storeId, reason });
    return false;
  }

  const buttons =
    input.buttons && input.buttons.length > 0 ? input.buttons : null;
  let sent: SendWhatsAppResult;
  try {
    sent = buttons
      ? await sendWhatsAppInteractive({
          storeId,
          to: input.to,
          token: sender.token,
          phoneNumberId: sender.phoneNumberId,
          body: input.body,
          buttons,
        })
      : await sendWhatsAppText({
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
      kind: buttons ? "interactive" : "text",
      body: input.body,
      payload:
        buttons || input.extraPayload
          ? { ...(buttons ? { buttons } : {}), ...(input.extraPayload ?? {}) }
          : null,
      providerMessageId: sent.sent ? sent.messageId : null,
      status: sent.sent ? "sent" : "failed",
      error: sent.sent ? null : sent.error,
    }),
  ).catch((err) =>
    logError("whatsapp auto-reply: filing failed", err, { storeId, reason }),
  );
  return sent.sent;
}
