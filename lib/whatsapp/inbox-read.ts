import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  admins,
  customerCreditBalances,
  orders,
  platformRoles,
  whatsappContacts,
  whatsappConversations,
  whatsappMessages,
  whatsappTemplates,
} from "@/drizzle/schema";
import { gcsPublicUrl } from "@/lib/storage/gcs";
import { formatStoredPhone, storedPhoneVariants } from "@/lib/phone";
import { bodyFromComponents, consented } from "./channel";
import {
  composerCanSend,
  templateButtonsOf,
  templateFooterText,
  templateHeaderText,
} from "./custom-template";
import { serviceWindow } from "./inbox";
import { loadMinkDraft } from "./mink-drafts";
import { inboxSearchQuery } from "./inbox-workspace";
import {
  INBOX_NOTE_SOURCE,
  type InboxAssignee,
  type InboxCannedReply,
  type InboxConversationRow,
  type InboxConversationStatus,
  type InboxCounts,
  type InboxCustomerPanel,
  type InboxLabel,
  type InboxListQuery,
  type InboxListResult,
  type InboxMessageRow,
  type InboxTemplateOption,
  type InboxThread,
} from "./inbox-types";

// ---------------------------------------------------------------------------
// The inbox's read side. Every function takes the TRUSTED store id — resolved
// by the action from the host and the session, never from the browser — and
// puts it in every query; the tables are service-only, so this predicate is
// the tenant boundary.
// ---------------------------------------------------------------------------

export const INBOX_PAGE_SIZE = 30;
/** The latest N messages of a thread. Older history is Phase 2's problem. */
export const THREAD_LIMIT = 200;

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

function asStatus(s: string): InboxConversationStatus {
  return s === "open" || s === "closed" ? s : "needs_reply";
}

/** A Postgres array as pg returns it, or as text when it comes back unparsed. */
function asIdList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.startsWith("{")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((v) => v.replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  return [];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The label ids a conversation carries, as a subquery on its alias. */
const LABEL_IDS = sql`
  coalesce((select array_agg(cl.label_id::text order by cl.created_at)
              from public.whatsapp_conversation_labels cl
             where cl.conversation_id = c.id), '{}'::text[])`;

export async function listConversations(
  storeId: string,
  input: InboxListQuery & {
    /** Who is asking, for the "me" assignee filter. */
    viewerId?: string;
  },
): Promise<InboxListResult> {
  const page = Math.max(1, input.page);
  const offset = (page - 1) * INBOX_PAGE_SIZE;
  const q = input.q.trim().slice(0, 80);
  const qDigits = q.replace(/\D/g, "");
  // ★ The search box finds a conversation by WHO (name, number) or by WHAT
  // was said: a prefix text-search over every message body, so "stoc" finds
  // the chat where somebody asked about stock. The hit's line comes back with
  // the row so the list can show why it matched.
  const tsq = q ? inboxSearchQuery(q) : null;
  const assignee = (input.assignee ?? "").slice(0, 128);
  const label = input.label && UUID_RE.test(input.label) ? input.label : "";

  const where = sql`
    c.store_id = ${storeId}::uuid
    ${input.filter === "all" ? sql`` : sql`and c.status = ${input.filter}`}
    ${
      assignee === "me" && input.viewerId
        ? sql`and c.assigned_admin_id = ${input.viewerId}`
        : assignee === "unassigned"
          ? sql`and c.assigned_admin_id is null`
          : assignee && assignee !== "me"
            ? sql`and c.assigned_admin_id = ${assignee}`
            : sql``
    }
    ${
      label
        ? sql`and exists (select 1 from public.whatsapp_conversation_labels cl
                           where cl.conversation_id = c.id and cl.label_id = ${label}::uuid)`
        : sql``
    }
    ${
      q
        ? sql`and (k.profile_name ilike ${"%" + q + "%"}
                   ${qDigits.length >= 3 ? sql`or k.phone like ${"%" + qDigits + "%"}` : sql``}
                   ${tsq ? sql`or mm.id is not null` : sql``})`
        : sql``
    }
  `;
  // The newest message in the conversation that matches, with its line.
  const matchJoin = tsq
    ? sql`left join lateral (
          select m.id,
                 ts_headline('simple', coalesce(m.body, ''), to_tsquery('simple', ${tsq}),
                             'MaxFragments=1, MaxWords=14, MinWords=6, StartSel=«, StopSel=», FragmentDelimiter=…') as snippet
            from public.whatsapp_messages m
           where m.conversation_id = c.id
             and m.store_id = c.store_id
             and to_tsvector('simple', coalesce(m.body, '')) @@ to_tsquery('simple', ${tsq})
           order by m.sent_at desc
           limit 1
        ) mm on true`
    : sql``;

  return withService(async (db) => {
    const rows = asRows<{
      id: string;
      status: string;
      unread_count: number;
      last_message_at: string | null;
      last_inbound_at: string | null;
      last_preview: string | null;
      assigned_admin_id: string | null;
      label_ids: unknown;
      contact_id: string;
      phone: string;
      profile_name: string | null;
      user_id: string | null;
      contact_last_inbound_at: string | null;
      match_id: string | null;
      match_snippet: string | null;
      total: number;
    }>(
      await db.execute(sql`
        select c.id, c.status, c.unread_count, c.last_message_at, c.last_inbound_at,
               c.last_preview, c.assigned_admin_id, c.contact_id,
               ${LABEL_IDS} as label_ids,
               k.phone, k.profile_name, k.user_id,
               k.last_inbound_at as contact_last_inbound_at,
               ${tsq ? sql`mm.id as match_id, mm.snippet as match_snippet,` : sql`null as match_id, null as match_snippet,`}
               count(*) over()::int as total
          from public.whatsapp_conversations c
          join public.whatsapp_contacts k on k.id = c.contact_id
          ${matchJoin}
         where ${where}
         order by c.last_message_at desc nulls last, c.created_at desc
         limit ${INBOX_PAGE_SIZE} offset ${offset}
      `),
    );
    const countRows = asRows<{ status: string; n: number }>(
      await db.execute(sql`
        select status, count(*)::int as n
          from public.whatsapp_conversations
         where store_id = ${storeId}::uuid
         group by status
      `),
    );
    const counts: InboxCounts = { needs_reply: 0, open: 0, closed: 0, all: 0 };
    for (const r of countRows) {
      const s = asStatus(r.status);
      counts[s] += Number(r.n);
      counts.all += Number(r.n);
    }
    return {
      rows: rows.map((r) => ({
        id: r.id,
        status: asStatus(r.status),
        unreadCount: Number(r.unread_count),
        lastMessageAt: r.last_message_at,
        lastInboundAt: r.last_inbound_at,
        lastPreview: r.last_preview,
        contact: {
          id: r.contact_id,
          phone: r.phone,
          phoneLabel: formatStoredPhone(r.phone),
          name: r.profile_name,
          userId: r.user_id,
        },
        windowOpen: serviceWindow(r.contact_last_inbound_at).open,
        assignedAdminId: r.assigned_admin_id,
        labelIds: asIdList(r.label_ids),
        match:
          r.match_id && r.match_snippet
            ? { messageId: r.match_id, snippet: r.match_snippet }
            : null,
      })),
      total: Number(rows[0]?.total ?? 0),
      counts,
    };
  });
}

export interface ConversationCore {
  id: string;
  status: InboxConversationStatus;
  unreadCount: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastPreview: string | null;
  assignedAdminId: string | null;
  labelIds: string[];
  contact: {
    id: string;
    phone: string;
    name: string | null;
    userId: string | null;
    lastInboundAt: string | null;
    updatesOptInAt: string | null;
    updatesOptOutAt: string | null;
    marketingOptInAt: string | null;
    marketingOptOutAt: string | null;
  };
}

/** One conversation with its contact, store-scoped; null when not ours. */
export async function loadConversation(
  storeId: string,
  conversationId: string,
): Promise<ConversationCore | null> {
  const rows = await withService((db) =>
    db
      .select({
        id: whatsappConversations.id,
        status: whatsappConversations.status,
        unreadCount: whatsappConversations.unreadCount,
        lastMessageAt: whatsappConversations.lastMessageAt,
        lastInboundAt: whatsappConversations.lastInboundAt,
        lastPreview: whatsappConversations.lastPreview,
        assignedAdminId: whatsappConversations.assignedAdminId,
        labelIds: sql<unknown>`coalesce((select array_agg(cl.label_id::text order by cl.created_at)
              from public.whatsapp_conversation_labels cl
             where cl.conversation_id = ${whatsappConversations.id}), '{}'::text[])`,
        contactId: whatsappContacts.id,
        phone: whatsappContacts.phone,
        name: whatsappContacts.profileName,
        userId: whatsappContacts.userId,
        contactLastInboundAt: whatsappContacts.lastInboundAt,
        updatesOptInAt: whatsappContacts.updatesOptInAt,
        updatesOptOutAt: whatsappContacts.updatesOptOutAt,
        marketingOptInAt: whatsappContacts.marketingOptInAt,
        marketingOptOutAt: whatsappContacts.marketingOptOutAt,
      })
      .from(whatsappConversations)
      .innerJoin(
        whatsappContacts,
        eq(whatsappContacts.id, whatsappConversations.contactId),
      )
      .where(
        and(
          eq(whatsappConversations.storeId, storeId),
          eq(whatsappConversations.id, conversationId),
        ),
      )
      .limit(1),
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: asStatus(r.status),
    unreadCount: r.unreadCount,
    lastMessageAt: r.lastMessageAt,
    lastInboundAt: r.lastInboundAt,
    lastPreview: r.lastPreview,
    assignedAdminId: r.assignedAdminId,
    labelIds: asIdList(r.labelIds),
    contact: {
      id: r.contactId,
      phone: r.phone,
      name: r.name,
      userId: r.userId,
      lastInboundAt: r.contactLastInboundAt,
      updatesOptInAt: r.updatesOptInAt,
      updatesOptOutAt: r.updatesOptOutAt,
      marketingOptInAt: r.marketingOptInAt,
      marketingOptOutAt: r.marketingOptOutAt,
    },
  };
}

function toRow(core: ConversationCore): InboxConversationRow {
  return {
    id: core.id,
    status: core.status,
    unreadCount: core.unreadCount,
    lastMessageAt: core.lastMessageAt,
    lastInboundAt: core.lastInboundAt,
    lastPreview: core.lastPreview,
    contact: {
      id: core.contact.id,
      phone: core.contact.phone,
      phoneLabel: formatStoredPhone(core.contact.phone),
      name: core.contact.name,
      userId: core.contact.userId,
    },
    windowOpen: serviceWindow(core.contact.lastInboundAt).open,
    assignedAdminId: core.assignedAdminId,
    labelIds: core.labelIds,
  };
}

export async function loadThread(
  storeId: string,
  conversationId: string,
): Promise<InboxThread | null> {
  const core = await loadConversation(storeId, conversationId);
  if (!core) return null;

  const [messages, notes, customer, minkDraft] = await Promise.all([
    loadMessages(storeId, conversationId),
    // Notes that cannot be read are notes not shown, never a thread that
    // fails to open; the same for a draft.
    loadNotes(storeId, conversationId).catch(() => []),
    loadCustomerPanel(storeId, core),
    loadMinkDraft(storeId, conversationId).catch(() => null),
  ]);

  // ★ A note rides in the thread IN TIME ORDER, as a row with its own source
  // and kind: it is read beside the messages it was written between, which
  // is where it means something. It is never a whatsapp_messages row.
  const merged = notes.length === 0 ? messages : mergeByTime(messages, notes);

  return {
    conversation: toRow(core),
    messages: merged,
    window: serviceWindow(core.contact.lastInboundAt),
    customer,
    minkDraft,
  };
}

function mergeByTime(
  a: InboxMessageRow[],
  b: InboxMessageRow[],
): InboxMessageRow[] {
  const out: InboxMessageRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (!y || (x && Date.parse(x.sentAt) <= Date.parse(y.sentAt))) {
      out.push(x as InboxMessageRow);
      i++;
    } else {
      out.push(y);
      j++;
    }
  }
  return out;
}

/** People by name, for a thread's senders and note authors. One bounded
 *  read; a person no longer on the store is shown as nobody. */
async function adminNames(
  storeId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const distinct = [...new Set(ids.filter(Boolean))];
  if (distinct.length === 0) return names;
  const people = await withService((db) =>
    db
      .select({
        id: admins.id,
        firstName: admins.firstName,
        lastName: admins.lastName,
        email: admins.email,
      })
      .from(admins)
      .where(and(eq(admins.storeId, storeId), inArray(admins.id, distinct))),
  ).catch(() => []);
  for (const p of people) {
    const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
    names.set(p.id, name || p.email);
  }
  return names;
}

async function loadMessages(
  storeId: string,
  conversationId: string,
): Promise<InboxMessageRow[]> {
  const rows = await withService((db) =>
    db
      .select({
        id: whatsappMessages.id,
        direction: whatsappMessages.direction,
        source: whatsappMessages.source,
        kind: whatsappMessages.kind,
        body: whatsappMessages.body,
        mediaPath: whatsappMessages.mediaPath,
        mediaMime: whatsappMessages.mediaMime,
        mediaName: whatsappMessages.mediaName,
        payload: whatsappMessages.payload,
        status: whatsappMessages.status,
        error: whatsappMessages.error,
        sentAt: whatsappMessages.sentAt,
        sentByAdminId: whatsappMessages.sentByAdminId,
        providerMessageId: whatsappMessages.providerMessageId,
        quotedProviderId: whatsappMessages.quotedProviderId,
      })
      .from(whatsappMessages)
      .where(
        and(
          eq(whatsappMessages.storeId, storeId),
          eq(whatsappMessages.conversationId, conversationId),
        ),
      )
      .orderBy(desc(whatsappMessages.sentAt), desc(whatsappMessages.createdAt))
      .limit(THREAD_LIMIT),
  );
  rows.reverse();

  // Who replied, by name. One bounded read for the distinct ids in view.
  const names = await adminNames(
    storeId,
    rows.map((r) => r.sentByAdminId).filter(Boolean) as string[],
  );

  return rows.map((r) => ({
    id: r.id,
    direction: r.direction === "out" ? "out" : "in",
    source: r.source,
    kind: r.kind,
    body: r.body,
    mediaUrl: r.mediaPath ? gcsPublicUrl(r.mediaPath) : null,
    mediaMime: r.mediaMime,
    mediaName: r.mediaName,
    payload:
      r.payload && typeof r.payload === "object" && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : null,
    status: r.status,
    error: r.error,
    sentAt: r.sentAt,
    sentBy: r.sentByAdminId ? (names.get(r.sentByAdminId) ?? null) : null,
    providerMessageId: r.providerMessageId,
    quotedProviderId: r.quotedProviderId,
  }));
}

/** A conversation's private notes, as thread rows. */
async function loadNotes(
  storeId: string,
  conversationId: string,
): Promise<InboxMessageRow[]> {
  const rows = asRows<{
    id: string;
    admin_id: string;
    body: string;
    created_at: string;
  }>(
    await withService((db) =>
      db.execute(sql`
        select id, admin_id, body, created_at
          from public.whatsapp_conversation_notes
         where store_id = ${storeId}::uuid
           and conversation_id = ${conversationId}::uuid
         order by created_at desc
         limit ${THREAD_LIMIT}
      `),
    ),
  );
  rows.reverse();
  const names = await adminNames(
    storeId,
    rows.map((r) => r.admin_id),
  );
  return rows.map((r) => ({
    id: r.id,
    direction: "out" as const,
    source: INBOX_NOTE_SOURCE,
    kind: INBOX_NOTE_SOURCE,
    body: r.body,
    mediaUrl: null,
    mediaMime: null,
    mediaName: null,
    payload: { adminId: r.admin_id },
    status: INBOX_NOTE_SOURCE,
    error: null,
    sentAt: r.created_at,
    sentBy: names.get(r.admin_id) ?? null,
    providerMessageId: null,
    quotedProviderId: null,
  }));
}

/**
 * Meta's id of one message in a conversation, for a reply that quotes it.
 * Store- and conversation-scoped, so a message id from the browser can name
 * only a message in the thread it was clicked in.
 */
export async function loadQuotableProviderId(
  storeId: string,
  conversationId: string,
  messageId: string,
): Promise<string | null> {
  const rows = await withService((db) =>
    db
      .select({ providerMessageId: whatsappMessages.providerMessageId })
      .from(whatsappMessages)
      .where(
        and(
          eq(whatsappMessages.storeId, storeId),
          eq(whatsappMessages.conversationId, conversationId),
          eq(whatsappMessages.id, messageId),
        ),
      )
      .limit(1),
  );
  return rows[0]?.providerMessageId ?? null;
}

// ── The team's vocabulary ────────────────────────────────────────────────

export async function listInboxLabels(storeId: string): Promise<InboxLabel[]> {
  const rows = asRows<{ id: string; name: string; color: string }>(
    await withService((db) =>
      db.execute(sql`
        select id, name, color from public.whatsapp_labels
         where store_id = ${storeId}::uuid
         order by position, lower(name)
      `),
    ),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color }));
}

/**
 * Who a conversation can be assigned to: the store's dashboard admins whose
 * role includes the Inbox, plus every owner (an owner's role may bypass the
 * permission map), never a suspended one. Names as the thread shows them.
 */
export async function listInboxAssignees(
  storeId: string,
): Promise<InboxAssignee[]> {
  const rows = await withService((db) =>
    db
      .select({
        id: admins.id,
        firstName: admins.firstName,
        lastName: admins.lastName,
        email: admins.email,
        role: admins.role,
        permissions: platformRoles.permissions,
      })
      .from(admins)
      .leftJoin(platformRoles, eq(platformRoles.slug, admins.role))
      .where(
        and(
          eq(admins.storeId, storeId),
          sql`coalesce(${admins.isSuspended}, false) = false`,
          sql`(${admins.role} = 'superadmin' or coalesce(${platformRoles.permissions}, '{}'::jsonb) ? 'inbox')`,
        ),
      )
      .orderBy(admins.firstName, admins.lastName, admins.email),
  );
  return rows.map((p) => {
    const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
    return { id: p.id, name: name || p.email };
  });
}

export async function listCannedReplies(
  storeId: string,
): Promise<InboxCannedReply[]> {
  const rows = asRows<{
    id: string;
    shortcut: string;
    title: string;
    body: string;
  }>(
    await withService((db) =>
      db.execute(sql`
        select id, shortcut, title, body from public.whatsapp_canned_replies
         where store_id = ${storeId}::uuid
         order by position, shortcut
      `),
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    shortcut: r.shortcut,
    title: r.title,
    body: r.body,
  }));
}

/**
 * What staff see beside the thread: this person's recent orders on this
 * store, their store credit, and what they have agreed to. Orders are found
 * by the matched account when there is one AND by the delivery phone,
 * because a guest checkout has the second and not the first.
 */
async function loadCustomerPanel(
  storeId: string,
  core: ConversationCore,
): Promise<InboxCustomerPanel> {
  const variants = storedPhoneVariants(core.contact.phone);
  const userId = core.contact.userId;

  const [orderRows, creditRows] = await Promise.all([
    withService((db) =>
      db
        .select({
          id: orders.id,
          orderRef: orders.orderRef,
          status: orders.status,
          paymentStatus: orders.paymentStatus,
          total: orders.total,
          createdAt: orders.createdAt,
          channel: orders.salesChannel,
        })
        .from(orders)
        .where(
          and(
            eq(orders.storeId, storeId),
            sql`(${userId ? sql`${orders.customerId} = ${userId} or ` : sql``}${orders.shippingAddress}->>'phone' = any(${sql.param(variants)}::text[]))`,
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(5),
    ).catch(() => []),
    userId
      ? withService((db) =>
          db
            .select({ balance: customerCreditBalances.balance })
            .from(customerCreditBalances)
            .where(
              and(
                eq(customerCreditBalances.storeId, storeId),
                eq(customerCreditBalances.customerId, userId),
              ),
            )
            .limit(1),
        ).catch(() => [])
      : Promise.resolve([]),
  ]);

  return {
    consent: {
      updates: consented(
        core.contact.updatesOptInAt,
        core.contact.updatesOptOutAt,
      ),
      marketing: consented(
        core.contact.marketingOptInAt,
        core.contact.marketingOptOutAt,
      ),
    },
    orders: orderRows.map((o) => ({
      id: o.id,
      orderRef: o.orderRef,
      status: o.status,
      paymentStatus: o.paymentStatus,
      total: Number(o.total ?? 0),
      createdAt: o.createdAt,
      channel: o.channel,
    })),
    credit: userId ? Number(creditRows[0]?.balance ?? 0) : null,
  };
}

/**
 * The approved CUSTOMER templates staff may send once the window has closed.
 * Team templates are not offered: they are addressed to staff.
 */
export async function listReplyTemplates(
  storeId: string,
): Promise<InboxTemplateOption[]> {
  const rows = await withService((db) =>
    db
      .select({
        id: whatsappTemplates.id,
        name: whatsappTemplates.name,
        language: whatsappTemplates.language,
        variables: whatsappTemplates.variables,
        components: whatsappTemplates.components,
        audience: whatsappTemplates.audience,
        eventKey: whatsappTemplates.eventKey,
      })
      .from(whatsappTemplates)
      .where(
        and(
          eq(whatsappTemplates.storeId, storeId),
          eq(whatsappTemplates.status, "APPROVED"),
          eq(whatsappTemplates.enabled, true),
        ),
      )
      .orderBy(whatsappTemplates.name),
  );
  return rows
    .filter((r) => r.audience !== "team" && composerCanSend(r))
    .map((r) => ({
      id: r.id,
      name: r.name,
      language: r.language,
      body: bodyFromComponents(r.components),
      variables: Array.isArray(r.variables) ? (r.variables as string[]) : [],
      headerText: templateHeaderText(r.components),
      footerText: templateFooterText(r.components),
      buttons: templateButtonsOf(r.components).map((b) => ({
        type: b.type,
        text: b.text,
      })),
    }));
}
