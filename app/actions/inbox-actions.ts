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
// script produces; the store's own Meta tier is the real ceiling. The gate
// itself lives in lib/whatsapp/inbox-gate.ts, shared with the media route.
// ---------------------------------------------------------------------------

import { and, eq, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { whatsappConversations, whatsappTemplates } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { emitEvent } from "@/lib/notifications/record";
import { bodyFromComponents } from "@/lib/whatsapp/channel";
import {
  needsReplyCount,
  recordOutboundMessage,
  serviceWindow,
} from "@/lib/whatsapp/inbox";
import {
  inboxGate as gate,
  inboxSendGate as sendGate,
  isUuid,
} from "@/lib/whatsapp/inbox-gate";
import {
  listCannedReplies,
  listConversations,
  listInboxAssignees,
  listInboxLabels,
  listReplyTemplates,
  loadConversation,
  loadQuotableProviderId,
  loadThread,
} from "@/lib/whatsapp/inbox-read";
import {
  addNote,
  assignConversation,
  deleteCannedReply as deleteCannedReplyRow,
  deleteLabel as deleteLabelRow,
  deleteNote,
  saveCannedReply as saveCannedReplyRow,
  saveLabel as saveLabelRow,
  setConversationLabels,
} from "@/lib/whatsapp/inbox-team";
import {
  INBOX_REPLY_MAX_CHARS,
  type InboxConversationStatus,
  type InboxFilter,
  type InboxListQuery,
  type InboxListResult,
  type InboxSendResult,
  type InboxTemplateOption,
  type InboxThread,
  type InboxWorkspace,
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

export async function getInboxConversations(input: {
  filter?: InboxFilter;
  q?: string;
  page?: number;
  /** "" anyone · "me" · "unassigned" · an admin id. */
  assignee?: string;
  /** A label id. */
  label?: string;
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
    const query: InboxListQuery = {
      filter:
        filter === "needs_reply" || filter === "open" || filter === "closed"
          ? filter
          : "all",
      q: typeof input.q === "string" ? input.q : "",
      page: Number(input.page ?? 1) || 1,
      assignee: typeof input.assignee === "string" ? input.assignee : "",
      label: typeof input.label === "string" ? input.label : "",
    };
    return await listConversations(g.storeId, {
      ...query,
      viewerId: g.userId,
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

/**
 * Who works this inbox, its labels and its saved replies, in one read for
 * the screen. Each list fails to empty on its own, never the whole screen.
 */
export async function getInboxWorkspace(): Promise<{
  workspace: InboxWorkspace;
  error?: string;
}> {
  const g = await gate("view");
  const empty: InboxWorkspace = {
    me: { id: "", name: "" },
    assignees: [],
    labels: [],
    cannedReplies: [],
  };
  if (!g.ok) return { workspace: empty, error: g.error };
  const [assignees, labels, cannedReplies] = await Promise.all([
    listInboxAssignees(g.storeId).catch((err) => {
      logError("inbox: assignees failed", err, { storeId: g.storeId });
      return [];
    }),
    listInboxLabels(g.storeId).catch((err) => {
      logError("inbox: labels failed", err, { storeId: g.storeId });
      return [];
    }),
    listCannedReplies(g.storeId).catch((err) => {
      logError("inbox: saved replies failed", err, { storeId: g.storeId });
      return [];
    }),
  ]);
  const me = assignees.find((a) => a.id === g.userId) ?? {
    id: g.userId,
    name: "You",
  };
  return { workspace: { me, assignees, labels, cannedReplies } };
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

/** A free-form reply — inside the 24-hour window only. `replyToMessageId`
 *  quotes one message of the same conversation, WhatsApp's reply-to. */
export async function sendInboxReply(input: {
  conversationId: string;
  text: string;
  replyToMessageId?: string | null;
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

  // ★ The quoted message must be one of THIS conversation's: the id from
  // the browser is looked up under the store and the conversation, and a
  // message that is not there (or one Meta never gave an id) quotes nothing
  // rather than failing the reply.
  const quotedProviderId =
    input.replyToMessageId && isUuid(input.replyToMessageId)
      ? await loadQuotableProviderId(
          s.storeId,
          s.core.id,
          input.replyToMessageId,
        ).catch(() => null)
      : null;

  const out = await sendWhatsAppText({
    storeId: s.storeId,
    to: s.core.contact.phone,
    token: s.sender.token,
    phoneNumberId: s.sender.phoneNumberId,
    body: text,
    replyToProviderId: quotedProviderId,
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
      quotedProviderId,
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

// ── Working as a team ─────────────────────────────────────────────────────
//
// Assignment, labels, notes and saved replies (slice 6). All with Inbox
// manage; every write goes through lib/whatsapp/inbox-team.ts under the
// trusted store id, and the browser's ids are claims checked there.

export interface InboxTeamResult {
  ok: boolean;
  error?: string;
}

/** Put a person on a conversation (null = nobody). The person is told,
 *  in-app, unless they assigned it to themselves. */
export async function assignInboxConversation(input: {
  conversationId: string;
  adminId: string | null;
}): Promise<InboxTeamResult & { assignedAdminId?: string | null }> {
  const g = await gate("manage");
  if (!g.ok) return { ok: false, error: g.error };
  if (!isUuid(input.conversationId)) return { ok: false, error: "Not found." };
  const adminId =
    typeof input.adminId === "string" && input.adminId.trim()
      ? input.adminId.trim().slice(0, 128)
      : null;
  try {
    const r = await withService((db) =>
      assignConversation(db, {
        storeId: g.storeId,
        conversationId: input.conversationId,
        adminId,
      }),
    );
    if (!r.ok) return { ok: false, error: r.error };
    if (r.value.changed && adminId && adminId !== g.userId) {
      const [assignee, core] = await Promise.all([
        listInboxAssignees(g.storeId)
          .then((all) => all.find((a) => a.id === g.userId) ?? null)
          .catch(() => null),
        loadConversation(g.storeId, input.conversationId).catch(() => null),
      ]);
      const label = core
        ? (core.contact.name ?? core.contact.phone)
        : "A conversation";
      emitEvent({
        type: "whatsapp.conversation_assigned",
        storeId: g.storeId,
        actor: { type: "admin", id: g.userId, label: assignee?.name ?? null },
        subject: {
          type: "whatsapp_conversation",
          id: input.conversationId,
          label,
        },
        payload: { assignedBy: assignee?.name ?? "" },
        // ★ Only the person it was given to, never the whole team.
        restrictToAdminIds: [adminId],
      });
    }
    return { ok: true, assignedAdminId: adminId };
  } catch (err) {
    logError("inbox: assign failed", err, { storeId: g.storeId });
    return { ok: false, error: "Couldn't assign the conversation." };
  }
}

/** Replace a conversation's labels with exactly this set. */
export async function setInboxConversationLabels(input: {
  conversationId: string;
  labelIds: string[];
}): Promise<InboxTeamResult & { labelIds?: string[] }> {
  const g = await gate("manage");
  if (!g.ok) return { ok: false, error: g.error };
  if (!isUuid(input.conversationId)) return { ok: false, error: "Not found." };
  const labelIds = [
    ...new Set(
      (Array.isArray(input.labelIds) ? input.labelIds : []).filter(
        (id): id is string => typeof id === "string" && isUuid(id),
      ),
    ),
  ].slice(0, 50);
  try {
    const r = await withService((db) =>
      setConversationLabels(db, {
        storeId: g.storeId,
        conversationId: input.conversationId,
        labelIds,
      }),
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, labelIds: r.value.labelIds };
  } catch (err) {
    logError("inbox: labels failed", err, { storeId: g.storeId });
    return { ok: false, error: "Couldn't update the labels." };
  }
}

export async function saveInboxLabel(input: {
  id?: string | null;
  name: string;
  color: string;
}): Promise<InboxTeamResult & { id?: string }> {
  const g = await gate("manage");
  if (!g.ok) return { ok: false, error: g.error };
  const id = input.id && isUuid(input.id) ? input.id : null;
  if (input.id && !id) return { ok: false, error: "Not found." };
  try {
    const r = await withService((db) =>
      saveLabelRow(db, {
        storeId: g.storeId,
        id,
        name: input.name,
        color: input.color,
      }),
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, id: r.value.id };
  } catch (err) {
    // The unique index: two labels that differ only in case are one label.
    if (String((err as { code?: string })?.code) === "23505") {
      return { ok: false, error: "A label with that name already exists." };
    }
    logError("inbox: save label failed", err, { storeId: g.storeId });
    return { ok: false, error: "Couldn't save the label." };
  }
}

export async function deleteInboxLabel(id: string): Promise<InboxTeamResult> {
  const g = await gate("manage");
  if (!g.ok) return { ok: false, error: g.error };
  if (!isUuid(id)) return { ok: false, error: "Not found." };
  try {
    const r = await withService((db) =>
      deleteLabelRow(db, { storeId: g.storeId, id }),
    );
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (err) {
    logError("inbox: delete label failed", err, { storeId: g.storeId });
    return { ok: false, error: "Couldn't delete the label." };
  }
}

/** A private note on a conversation. Never sent. */
export async function addInboxNote(input: {
  conversationId: string;
  body: string;
}): Promise<InboxTeamResult & { id?: string }> {
  const g = await gate("manage");
  if (!g.ok) return { ok: false, error: g.error };
  if (!isUuid(input.conversationId)) return { ok: false, error: "Not found." };
  try {
    const r = await withService((db) =>
      addNote(db, {
        storeId: g.storeId,
        conversationId: input.conversationId,
        adminId: g.userId,
        body: input.body,
      }),
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, id: r.value.id };
  } catch (err) {
    logError("inbox: add note failed", err, { storeId: g.storeId });
    return { ok: false, error: "Couldn't save the note." };
  }
}

export async function deleteInboxNote(id: string): Promise<InboxTeamResult> {
  const g = await gate("manage");
  if (!g.ok) return { ok: false, error: g.error };
  if (!isUuid(id)) return { ok: false, error: "Not found." };
  try {
    const r = await withService((db) =>
      deleteNote(db, { storeId: g.storeId, id }),
    );
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (err) {
    logError("inbox: delete note failed", err, { storeId: g.storeId });
    return { ok: false, error: "Couldn't delete the note." };
  }
}

export async function saveInboxCannedReply(input: {
  id?: string | null;
  shortcut: string;
  title: string;
  body: string;
}): Promise<InboxTeamResult & { id?: string }> {
  const g = await gate("manage");
  if (!g.ok) return { ok: false, error: g.error };
  const id = input.id && isUuid(input.id) ? input.id : null;
  if (input.id && !id) return { ok: false, error: "Not found." };
  try {
    const r = await withService((db) =>
      saveCannedReplyRow(db, {
        storeId: g.storeId,
        id,
        adminId: g.userId,
        shortcut: input.shortcut,
        title: input.title,
        body: input.body,
      }),
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, id: r.value.id };
  } catch (err) {
    if (String((err as { code?: string })?.code) === "23505") {
      return { ok: false, error: "That shortcut is already in use." };
    }
    logError("inbox: save reply failed", err, { storeId: g.storeId });
    return { ok: false, error: "Couldn't save the reply." };
  }
}

export async function deleteInboxCannedReply(
  id: string,
): Promise<InboxTeamResult> {
  const g = await gate("manage");
  if (!g.ok) return { ok: false, error: g.error };
  if (!isUuid(id)) return { ok: false, error: "Not found." };
  try {
    const r = await withService((db) =>
      deleteCannedReplyRow(db, { storeId: g.storeId, id }),
    );
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (err) {
    logError("inbox: delete reply failed", err, { storeId: g.storeId });
    return { ok: false, error: "Couldn't delete the reply." };
  }
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
