"use server";

// ---------------------------------------------------------------------------
// The WhatsApp inbox (docs/whatsapp-commerce-plan.md §11): what staff read and
// what they send. Every action resolves the store from the host and the
// caller from the session, re-checks the `inbox` permission, and puts the
// trusted store id in every query — a conversation id from the browser is a
// claim about which conversation, never about whose.
//
// ── ★ THE WINDOW IS CHECKED ON THE SERVER ──────────────────────────────────
// The composer greys itself out after 24 hours as a courtesy; this is the
// check. Meta would refuse the message anyway (131047), but a refusal here
// is a sentence the staff member can act on, and it costs no log row.
//
// ── ★ A REPLY IS RATE-LIMITED PER PERSON ───────────────────────────────────
// Sixty a minute is more than anyone types and less than a stuck key or a
// script produces; the store's own Meta tier is the real ceiling.
// ---------------------------------------------------------------------------

import { and, eq, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { getActingStoreId, getViewerAccess } from "@/app/dashboard/lib/access";
import { whatsappConversations, whatsappTemplates } from "@/drizzle/schema";
import { rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";
import { loadWhatsAppSender, bodyFromComponents } from "@/lib/whatsapp/channel";
import {
  needsReplyCount,
  recordOutboundMessage,
  serviceWindow,
} from "@/lib/whatsapp/inbox";
import {
  listConversations,
  listReplyTemplates,
  loadConversation,
  loadThread,
} from "@/lib/whatsapp/inbox-read";
import {
  INBOX_REPLY_MAX_CHARS,
  type InboxConversationStatus,
  type InboxFilter,
  type InboxListResult,
  type InboxTemplateOption,
  type InboxThread,
} from "@/lib/whatsapp/inbox-types";
import { sendWhatsAppTemplate, sendWhatsAppText } from "@/lib/whatsapp/send";
import { renderWhatsAppBody } from "@/lib/whatsapp/template-catalog";

type Gate =
  | { ok: true; storeId: string; userId: string }
  | { ok: false; error: string };

async function gate(action: "view" | "manage"): Promise<Gate> {
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
  return { ok: true, storeId: await getActingStoreId(), userId: access.userId };
}

export async function getInboxConversations(input: {
  filter?: InboxFilter;
  q?: string;
  page?: number;
}): Promise<InboxListResult & { error?: string }> {
  const g = await gate("view");
  const empty: InboxListResult = {
    rows: [],
    total: 0,
    counts: { needs_reply: 0, open: 0, closed: 0, all: 0 },
  };
  if (!g.ok) return { ...empty, error: g.error };
  const filter = input.filter ?? "all";
  try {
    return await listConversations(g.storeId, {
      filter:
        filter === "needs_reply" || filter === "open" || filter === "closed"
          ? filter
          : "all",
      q: input.q ?? "",
      page: input.page ?? 1,
    });
  } catch (err) {
    logError("inbox: list failed", err, { storeId: g.storeId });
    return { ...empty, error: "Couldn't load conversations. Try again." };
  }
}

export async function getInboxThread(
  conversationId: string,
): Promise<{ thread: InboxThread | null; error?: string }> {
  const g = await gate("view");
  if (!g.ok) return { thread: null, error: g.error };
  if (!isUuid(conversationId)) return { thread: null, error: "Not found." };
  try {
    const thread = await loadThread(g.storeId, conversationId);
    return thread ? { thread } : { thread: null, error: "Not found." };
  } catch (err) {
    logError("inbox: thread failed", err, { storeId: g.storeId });
    return { thread: null, error: "Couldn't load the conversation." };
  }
}

export async function getInboxNeedsReplyCount(): Promise<{
  count: number;
  error?: string;
}> {
  const g = await gate("view");
  if (!g.ok) return { count: 0, error: g.error };
  try {
    return { count: await needsReplyCount(g.storeId) };
  } catch {
    return { count: 0, error: "unavailable" };
  }
}

export async function getInboxTemplates(): Promise<{
  templates: InboxTemplateOption[];
  error?: string;
}> {
  const g = await gate("view");
  if (!g.ok) return { templates: [], error: g.error };
  try {
    return { templates: await listReplyTemplates(g.storeId) };
  } catch {
    return { templates: [], error: "Couldn't load templates." };
  }
}

/** Opening a conversation clears its unread count. Status is untouched:
 *  reading is not answering. */
export async function markInboxRead(
  conversationId: string,
): Promise<{ ok: boolean; error?: string }> {
  const g = await gate("view");
  if (!g.ok) return { ok: false, error: g.error };
  if (!isUuid(conversationId)) return { ok: false, error: "Not found." };
  try {
    await withService((db) =>
      db
        .update(whatsappConversations)
        .set({ unreadCount: 0, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(whatsappConversations.storeId, g.storeId),
            eq(whatsappConversations.id, conversationId),
          ),
        ),
    );
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't update the conversation." };
  }
}

/**
 * Close, or reopen. `needs_reply` is never SET by hand — it is what an
 * inbound message does — so the two choices here are open and closed.
 */
export async function setInboxConversationStatus(
  conversationId: string,
  status: "open" | "closed",
): Promise<{ ok: boolean; status?: InboxConversationStatus; error?: string }> {
  const g = await gate("manage");
  if (!g.ok) return { ok: false, error: g.error };
  if (!isUuid(conversationId)) return { ok: false, error: "Not found." };
  if (status !== "open" && status !== "closed") {
    return { ok: false, error: "Unknown status." };
  }
  try {
    const rows = await withService((db) =>
      db
        .update(whatsappConversations)
        .set({
          status,
          unreadCount: status === "closed" ? 0 : undefined,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(whatsappConversations.storeId, g.storeId),
            eq(whatsappConversations.id, conversationId),
          ),
        )
        .returning({ id: whatsappConversations.id }),
    );
    if (rows.length === 0) return { ok: false, error: "Not found." };
    return { ok: true, status };
  } catch {
    return { ok: false, error: "Couldn't update the conversation." };
  }
}

export interface InboxSendResult {
  ok: boolean;
  messageId?: string;
  /** `window_closed` tells the composer to switch to templates. */
  code?: "window_closed" | "not_connected" | "refused";
  error?: string;
}

async function sendGate(conversationId: string): Promise<
  | {
      ok: true;
      storeId: string;
      userId: string;
      core: NonNullable<Awaited<ReturnType<typeof loadConversation>>>;
      sender: NonNullable<Awaited<ReturnType<typeof loadWhatsAppSender>>>;
    }
  | { ok: false; result: InboxSendResult }
> {
  const g = await gate("manage");
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

/** A free-form reply — inside the 24-hour window only. */
export async function sendInboxReply(input: {
  conversationId: string;
  text: string;
}): Promise<InboxSendResult> {
  const text = (input.text ?? "").trim();
  if (!text) return { ok: false, error: "Type a message first." };
  if (text.length > INBOX_REPLY_MAX_CHARS) {
    return {
      ok: false,
      error: `Messages can be at most ${INBOX_REPLY_MAX_CHARS} characters.`,
    };
  }
  const s = await sendGate(input.conversationId);
  if (!s.ok) return s.result;

  const window = serviceWindow(s.core.contact.lastInboundAt);
  if (!window.open) {
    return {
      ok: false,
      code: "window_closed",
      error:
        "More than 24 hours have passed since the customer last wrote, so WhatsApp only allows an approved template now.",
    };
  }

  const out = await sendWhatsAppText({
    storeId: s.storeId,
    to: s.core.contact.phone,
    token: s.sender.token,
    phoneNumberId: s.sender.phoneNumberId,
    body: text,
  });

  const messageId = await withService((db) =>
    recordOutboundMessage(db, {
      storeId: s.storeId,
      conversationId: s.core.id,
      source: "dashboard",
      kind: "text",
      body: text,
      providerMessageId: out.sent ? out.messageId : null,
      status: out.sent ? "sent" : "failed",
      error: out.sent ? null : out.error,
      sentByAdminId: s.userId,
    }),
  ).catch((err) => {
    logError("inbox: record reply failed", err, { storeId: s.storeId });
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
  return { ok: true, messageId };
}

/** An approved template, for a conversation whose window has closed. */
export async function sendInboxTemplate(input: {
  conversationId: string;
  templateId: string;
  values: string[];
}): Promise<InboxSendResult> {
  const s = await sendGate(input.conversationId);
  if (!s.ok) return s.result;
  if (!isUuid(input.templateId)) {
    return { ok: false, error: "Choose a template." };
  }

  const rows = await withService((db) =>
    db
      .select({
        id: whatsappTemplates.id,
        name: whatsappTemplates.name,
        language: whatsappTemplates.language,
        variables: whatsappTemplates.variables,
        components: whatsappTemplates.components,
        audience: whatsappTemplates.audience,
        category: whatsappTemplates.category,
      })
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.storeId, s.storeId),
          eq(whatsappTemplates.id, input.templateId),
          eq(whatsappTemplates.status, "APPROVED"),
          eq(whatsappTemplates.enabled, true),
          sql`${whatsappTemplates.audience} is distinct from 'team'`,
        ),
      )
      .limit(1),
  );
  const template = rows[0];
  if (!template) {
    return {
      ok: false,
      error: "That template isn't approved for customers on this store.",
    };
  }
  const variables = Array.isArray(template.variables)
    ? (template.variables as string[])
    : [];
  const values = (Array.isArray(input.values) ? input.values : []).map((v) =>
    String(v ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 200),
  );
  if (values.length !== variables.length || values.some((v) => !v)) {
    return { ok: false, error: "Fill in every field of the template." };
  }

  const body = bodyFromComponents(template.components);
  const out = await sendWhatsAppTemplate({
    storeId: s.storeId,
    to: s.core.contact.phone,
    token: s.sender.token,
    phoneNumberId: s.sender.phoneNumberId,
    template: {
      id: template.id,
      name: template.name,
      language: template.language,
      body,
    },
    values,
    eventKey: null,
    category: template.category,
  });

  const messageId = await withService((db) =>
    recordOutboundMessage(db, {
      storeId: s.storeId,
      conversationId: s.core.id,
      source: "template",
      kind: "template",
      body: renderWhatsAppBody(body, values),
      providerMessageId: out.sent ? out.messageId : null,
      status: out.sent ? "sent" : "failed",
      error: out.sent ? null : out.error,
      sentByAdminId: s.userId,
      templateId: template.id,
    }),
  ).catch((err) => {
    logError("inbox: record template failed", err, { storeId: s.storeId });
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
  return { ok: true, messageId };
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    v ?? "",
  );
}
