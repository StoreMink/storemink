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
import {
  composerCanSend,
  quickReplyPayloadsFor,
} from "@/lib/whatsapp/custom-template";
import {
  chargeMinkAnswer,
  claimMinkDraft,
  discardMinkDrafts,
  markMinkAnswerSent,
  minkChargeContext,
} from "@/lib/whatsapp/mink-drafts";
import { MINK_ANSWER_CREDITS } from "@/lib/whatsapp/auto-reply-settings";

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
  await supersedeMinkDrafts(s.storeId, s.core.id);
  return { ok: true, messageId };
}

/** A person replied by hand: a draft Mink left for an earlier message is
 *  moot, and would otherwise sit above the composer for ever. Best effort. */
async function supersedeMinkDrafts(
  storeId: string,
  conversationId: string,
): Promise<void> {
  await withService((db) =>
    discardMinkDrafts(db, {
      storeId,
      conversationId,
      reason: "a person replied",
    }),
  ).catch((err) =>
    logError("inbox: supersede drafts failed", err, { storeId }),
  );
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
        eventKey: whatsappTemplates.eventKey,
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
  // The picker never offers one (listReplyTemplates); this is the boundary.
  if (!composerCanSend(template)) {
    return {
      ok: false,
      error: "That template has buttons and can't be sent from the inbox.",
    };
  }
  // A merchant's quick replies carry their own label as the payload, so a
  // tap comes back as an ordinary message saying what was chosen.
  const buttonPayloads =
    template.eventKey === null
      ? quickReplyPayloadsFor(template.components)
      : [];
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
    ...(buttonPayloads.length > 0 ? { buttonPayloads } : {}),
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
  await supersedeMinkDrafts(s.storeId, s.core.id);
  return { ok: true, messageId };
}

// ── Mink drafts ───────────────────────────────────────────────────────────
//
// A reply customer-facing Mink wrote and did not send (lib/whatsapp/
// mink-answer.ts): in `drafts` mode every reply, in `helps` mode the ones it
// handed over. Staff read it above the composer, change what they like, and
// Send it (one Mink credit, the same charge an automatic send pays) or
// Discard it. Sending is a dashboard reply like any other, filed under the
// person who sent it with the draft's id in the payload.

export interface InboxMinkDraftResult {
  ok: boolean;
  messageId?: string;
  code?: "window_closed" | "not_connected" | "refused" | "no_credits" | "gone";
  error?: string;
}

/** Send a Mink draft, as edited, charging the credit unless it was already
 *  taken (an automatic send Meta refused). */
export async function sendMinkDraft(input: {
  conversationId: string;
  draftId: string;
  text: string;
}): Promise<InboxMinkDraftResult> {
  const text = (input.text ?? "").trim();
  if (!text) return { ok: false, error: "The draft is empty." };
  if (text.length > INBOX_REPLY_MAX_CHARS) {
    return {
      ok: false,
      error: `Messages can be at most ${INBOX_REPLY_MAX_CHARS} characters.`,
    };
  }
  if (!isUuid(input.draftId))
    return { ok: false, code: "gone", error: "Not found." };
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

  // ★ The charge and the claim share one transaction: the row is locked as a
  // pending draft, charged (idempotent on its id), and only then sent. Two
  // people pressing Send get one send and one charge.
  let charged: string;
  try {
    const ctx = await minkChargeContext(s.storeId);
    charged = await withService(async (db) => {
      const claim = await claimMinkDraft(db, {
        storeId: s.storeId,
        conversationId: s.core.id,
        draftId: input.draftId,
      });
      if (!claim) return "gone";
      return chargeMinkAnswer(db, {
        answerId: input.draftId,
        storeId: s.storeId,
        ctx,
      });
    });
  } catch (err) {
    logError("inbox: mink draft charge failed", err, { storeId: s.storeId });
    return { ok: false, error: "Couldn't send the draft. Try again." };
  }
  if (charged === "gone") {
    return {
      ok: false,
      code: "gone",
      error: "This draft was already sent or discarded.",
    };
  }
  if (charged === "insufficient") {
    return {
      ok: false,
      code: "no_credits",
      error: `Sending a Mink AI reply uses ${MINK_ANSWER_CREDITS} Mink credit, and this store has none left. Buy Mink credits or upgrade under Plans & Billing, or write the reply yourself.`,
    };
  }

  const out = await sendWhatsAppText({
    storeId: s.storeId,
    to: s.core.contact.phone,
    token: s.sender.token,
    phoneNumberId: s.sender.phoneNumberId,
    body: text,
  });

  const messageId = await withService(async (db) => {
    const id = await recordOutboundMessage(db, {
      storeId: s.storeId,
      conversationId: s.core.id,
      source: "dashboard",
      kind: "text",
      body: text,
      payload: { mink: true, answerId: input.draftId },
      providerMessageId: out.sent ? out.messageId : null,
      status: out.sent ? "sent" : "failed",
      error: out.sent ? null : out.error,
      sentByAdminId: s.userId,
    });
    if (out.sent) {
      await markMinkAnswerSent(db, {
        storeId: s.storeId,
        answerId: input.draftId,
        answer: text,
        sentMessageId: id || null,
        sentByAdminId: s.userId,
      });
    }
    return id;
  }).catch((err) => {
    logError("inbox: record mink draft failed", err, { storeId: s.storeId });
    return "";
  });

  if (!out.sent) {
    // Charged and not sent: the draft stays, marked charged, so the next
    // Send is free (the charge is idempotent on the draft's id).
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

/** Drop a Mink draft without sending it. Nothing is charged. */
export async function discardMinkDraft(input: {
  conversationId: string;
  draftId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const g = await gate("manage");
  if (!g.ok) return { ok: false, error: g.error };
  if (!isUuid(input.conversationId) || !isUuid(input.draftId)) {
    return { ok: false, error: "Not found." };
  }
  try {
    await withService((db) =>
      discardMinkDrafts(db, {
        storeId: g.storeId,
        conversationId: input.conversationId,
        draftId: input.draftId,
        reason: "discarded by a person",
      }),
    );
    return { ok: true };
  } catch (err) {
    logError("inbox: discard draft failed", err, { storeId: g.storeId });
    return { ok: false, error: "Couldn't discard the draft. Try again." };
  }
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    v ?? "",
  );
}
