import "server-only";

import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { whatsappLogs } from "@/drizzle/schema";
import {
  sendInteractiveMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendTextMessage,
  type InteractiveButton,
  type OutboundMediaKind,
} from "./graph";
import { renderWhatsAppBody, whatsAppParameterText } from "./template-catalog";

// ---------------------------------------------------------------------------
// ★★ THE CHOKE POINT. Every WhatsApp message this platform sends leaves
// through `sendWhatsAppTemplate`, `sendWhatsAppText`, `sendWhatsAppInteractive`
// or `sendWhatsAppMedia`, and every attempt lands in `whatsapp_logs` —
// sent, failed or skipped alike. `send-coverage.test.ts` fails on any other
// caller of the Graph send, for the reason lib/sms/send.ts and lib/email/send.ts
// give: a log with a hole in it is worse than no log, because a merchant who
// cannot find a message concludes it was never sent.
//
// ── ★ THE LOG ROW IS WRITTEN WITH THE PROVIDER MESSAGE ID ──────────────────
// Unlike SMS, WhatsApp reports what happened next: the status webhook posts
// sent / delivered / read / failed against that id, and lib/whatsapp/inbound.ts
// advances the row. So the row is the START of a timeline, not the whole
// record, and the id is what joins the two.
//
// ── ★ IT NEVER THROWS INTO ITS CALLER ──────────────────────────────────────
// The caller is a queue worker. A messaging failure must not fail the drain.
// ---------------------------------------------------------------------------

export interface SendWhatsAppInput {
  storeId: string;
  /** E.164 — the choke point strips the `+` for Meta. */
  to: string;
  token: string;
  phoneNumberId: string;
  template: {
    id: string;
    name: string;
    language: string;
    /** Meta's body text, for the log's rendered copy. */
    body: string;
  };
  /** Positional body values, already formatted. */
  values: string[];
  /** Payloads for the template's quick-reply buttons, in button order. */
  buttonPayloads?: string[];
  eventKey?: string | null;
  category?: string | null;
}

export type SendWhatsAppResult =
  | { sent: true; messageId: string; logId: string | null }
  | {
      sent: false;
      outcome: "rejected" | "unknown" | "skipped";
      error: string;
      code?: number;
    };

export async function sendWhatsAppTemplate(
  input: SendWhatsAppInput,
): Promise<SendWhatsAppResult> {
  const params = input.values.map(whatsAppParameterText);
  const body = renderWhatsAppBody(input.template.body, input.values);
  const to = input.to.replace(/\D/g, "");

  // Nothing to send is a `skipped` row, not silence.
  if (!to) {
    await writeLog(input, body, { status: "skipped" }, "No phone number.");
    return { sent: false, outcome: "skipped", error: "No phone number." };
  }
  if (!input.template.name) {
    await writeLog(input, body, { status: "skipped" }, "No template.");
    return { sent: false, outcome: "skipped", error: "No template." };
  }

  const result = await sendTemplateMessage(input.token, input.phoneNumberId, {
    to,
    name: input.template.name,
    language: input.template.language,
    bodyParams: params,
    ...(input.buttonPayloads && input.buttonPayloads.length > 0
      ? { quickReplyPayloads: input.buttonPayloads }
      : {}),
  });

  if (result.ok) {
    const messageId = result.data.messages?.[0]?.id ?? null;
    if (!messageId) {
      // Meta answered 200 with no message id. Treat as unknown: it may have
      // gone, and nothing will ever report back against an id we never got.
      await writeLog(
        input,
        body,
        { status: "failed" },
        "Meta accepted the message but returned no id.",
      );
      return {
        sent: false,
        outcome: "unknown",
        error: "Meta accepted the message but returned no id.",
      };
    }
    const logId = await writeLog(input, body, {
      status: "sent",
      messageId,
    });
    return { sent: true, messageId, logId };
  }

  // ★ AN UNKNOWN OUTCOME IS LOGGED AS FAILED BUT REPORTED AS UNKNOWN. The log
  // records that nothing was confirmed; the CALLER needs the distinction,
  // because retrying an `unknown` may message somebody twice.
  await writeLog(
    input,
    body,
    { status: "failed", code: result.code },
    result.error,
  );
  return {
    sent: false,
    outcome: result.outcome,
    error: result.error,
    code: result.code,
  };
}

export interface SendWhatsAppTextInput {
  storeId: string;
  /** E.164. */
  to: string;
  token: string;
  phoneNumberId: string;
  body: string;
  replyToProviderId?: string | null;
}

/**
 * One free-form reply from the inbox. The SAME choke point and the same log
 * row: a staff reply a customer says never arrived must be findable in
 * WhatsApp logs exactly as an order update is. ★ The caller has checked the
 * 24-hour window; Meta checks it again (131047), and that refusal is logged
 * as any other.
 */
export async function sendWhatsAppText(
  input: SendWhatsAppTextInput,
): Promise<SendWhatsAppResult> {
  const to = input.to.replace(/\D/g, "");
  const body = input.body.trim();
  const logInput: SendWhatsAppInput = {
    storeId: input.storeId,
    to: input.to,
    token: input.token,
    phoneNumberId: input.phoneNumberId,
    template: { id: "", name: "", language: "", body },
    values: [],
    eventKey: null,
    category: "SERVICE",
  };
  if (!to) {
    await writeLog(logInput, body, { status: "skipped" }, "No phone number.");
    return { sent: false, outcome: "skipped", error: "No phone number." };
  }
  if (!body) {
    await writeLog(logInput, body, { status: "skipped" }, "Empty message.");
    return { sent: false, outcome: "skipped", error: "Empty message." };
  }

  const result = await sendTextMessage(input.token, input.phoneNumberId, {
    to,
    body,
    replyToProviderId: input.replyToProviderId ?? null,
  });
  return settle(logInput, body, result);
}

export interface SendWhatsAppInteractiveInput {
  storeId: string;
  /** E.164. */
  to: string;
  token: string;
  phoneNumberId: string;
  /** At most 1,024 characters (the caller's job; Meta refuses more). */
  body: string;
  /** One to three reply buttons. */
  buttons: InteractiveButton[];
}

/**
 * One reply-button message: the store's menu, sent with the welcome or on
 * request (answer-automatically.ts). The SAME choke point and the same log
 * row shape as a free-text reply; the log keeps the body, and the buttons
 * ride in the thread's own record of the message (inbox.ts). Inside the
 * 24-hour window only, like free text.
 */
export async function sendWhatsAppInteractive(
  input: SendWhatsAppInteractiveInput,
): Promise<SendWhatsAppResult> {
  const to = input.to.replace(/\D/g, "");
  const body = input.body.trim();
  const logInput: SendWhatsAppInput = {
    storeId: input.storeId,
    to: input.to,
    token: input.token,
    phoneNumberId: input.phoneNumberId,
    template: { id: "", name: "", language: "", body },
    values: [],
    eventKey: null,
    category: "SERVICE",
  };
  if (!to) {
    await writeLog(logInput, body, { status: "skipped" }, "No phone number.");
    return { sent: false, outcome: "skipped", error: "No phone number." };
  }
  if (!body) {
    await writeLog(logInput, body, { status: "skipped" }, "Empty message.");
    return { sent: false, outcome: "skipped", error: "Empty message." };
  }
  if (input.buttons.length === 0) {
    await writeLog(logInput, body, { status: "skipped" }, "No buttons.");
    return { sent: false, outcome: "skipped", error: "No buttons." };
  }

  const result = await sendInteractiveMessage(
    input.token,
    input.phoneNumberId,
    { to, body, buttons: input.buttons },
  );
  return settle(logInput, body, result);
}

export interface SendWhatsAppMediaInput {
  storeId: string;
  /** E.164. */
  to: string;
  token: string;
  phoneNumberId: string;
  kind: OutboundMediaKind;
  /** The id Meta's media upload returned. */
  mediaId: string;
  caption?: string | null;
  /** For a document: what the customer sees it called. */
  filename?: string | null;
  replyToProviderId?: string | null;
}

/**
 * One photo or document from the inbox, by the media id the upload returned.
 * The SAME choke point and the same log row; the log's body is the caption,
 * or the file's name when there is none, so a "did it go?" question has an
 * answer in WhatsApp logs. Inside the 24-hour window only, like free text.
 */
export async function sendWhatsAppMedia(
  input: SendWhatsAppMediaInput,
): Promise<SendWhatsAppResult> {
  const to = input.to.replace(/\D/g, "");
  const caption = (input.caption ?? "").trim();
  const body =
    caption ||
    (input.kind === "image"
      ? "📷 Photo"
      : `📄 ${input.filename ?? "Document"}`);
  const logInput: SendWhatsAppInput = {
    storeId: input.storeId,
    to: input.to,
    token: input.token,
    phoneNumberId: input.phoneNumberId,
    template: { id: "", name: "", language: "", body },
    values: [],
    eventKey: null,
    category: "SERVICE",
  };
  if (!to) {
    await writeLog(logInput, body, { status: "skipped" }, "No phone number.");
    return { sent: false, outcome: "skipped", error: "No phone number." };
  }
  if (!input.mediaId) {
    await writeLog(logInput, body, { status: "skipped" }, "No file.");
    return { sent: false, outcome: "skipped", error: "No file." };
  }

  const result = await sendMediaMessage(input.token, input.phoneNumberId, {
    to,
    kind: input.kind,
    mediaId: input.mediaId,
    caption: caption || null,
    filename: input.filename ?? null,
    replyToProviderId: input.replyToProviderId ?? null,
  });
  return settle(logInput, body, result);
}

/** Log and report one send's outcome, the same way for every message type. */
async function settle(
  logInput: SendWhatsAppInput,
  body: string,
  result: Awaited<ReturnType<typeof sendTextMessage>>,
): Promise<SendWhatsAppResult> {
  if (result.ok) {
    const messageId = result.data.messages?.[0]?.id ?? null;
    if (!messageId) {
      await writeLog(
        logInput,
        body,
        { status: "failed" },
        "Meta accepted the message but returned no id.",
      );
      return {
        sent: false,
        outcome: "unknown",
        error: "Meta accepted the message but returned no id.",
      };
    }
    const logId = await writeLog(logInput, body, {
      status: "sent",
      messageId,
    });
    return { sent: true, messageId, logId };
  }

  await writeLog(
    logInput,
    body,
    { status: "failed", code: result.code },
    result.error,
  );
  return {
    sent: false,
    outcome: result.outcome,
    error: result.error,
    code: result.code,
  };
}

async function writeLog(
  input: SendWhatsAppInput,
  body: string,
  meta: { status: string; messageId?: string; code?: number },
  error?: string,
): Promise<string | null> {
  try {
    const now = new Date().toISOString();
    const rows = await withService((db) =>
      db
        .insert(whatsappLogs)
        .values({
          storeId: input.storeId,
          toPhone: input.to || "(none)",
          eventKey: input.eventKey ?? null,
          templateName: input.template.name || null,
          templateId: input.template.id || null,
          category: input.category ?? null,
          // ⚠ The body IS stored, as the SMS log stores its own: fixed
          // approved copy plus the order facts any member of staff can read
          // on the order itself. Nothing secret is in it.
          body: body || null,
          status: meta.status,
          error: error ?? null,
          errorCode: meta.code ?? null,
          providerMessageId: meta.messageId ?? null,
          sentAt: meta.status === "sent" ? now : null,
          failedAt: meta.status === "failed" ? now : null,
        })
        .returning({ id: whatsappLogs.id }),
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    // A log failure must not turn a delivered message into a reported failure.
    logError("whatsapp: log write failed", err, { storeId: input.storeId });
    return null;
  }
}
