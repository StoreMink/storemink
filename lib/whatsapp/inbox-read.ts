import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  admins,
  customerCreditBalances,
  orders,
  whatsappContacts,
  whatsappConversations,
  whatsappMessages,
  whatsappTemplates,
} from "@/drizzle/schema";
import { gcsPublicUrl } from "@/lib/storage/gcs";
import { formatStoredPhone, storedPhoneVariants } from "@/lib/phone";
import { bodyFromComponents, consented, templateHasButtons } from "./channel";
import { serviceWindow } from "./inbox";
import type {
  InboxConversationRow,
  InboxConversationStatus,
  InboxCounts,
  InboxCustomerPanel,
  InboxFilter,
  InboxListResult,
  InboxMessageRow,
  InboxTemplateOption,
  InboxThread,
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

export async function listConversations(
  storeId: string,
  input: { filter: InboxFilter; q: string; page: number },
): Promise<InboxListResult> {
  const page = Math.max(1, input.page);
  const offset = (page - 1) * INBOX_PAGE_SIZE;
  const q = input.q.trim().slice(0, 80);
  const qDigits = q.replace(/\D/g, "");

  const where = sql`
    c.store_id = ${storeId}::uuid
    ${input.filter === "all" ? sql`` : sql`and c.status = ${input.filter}`}
    ${
      q
        ? sql`and (k.profile_name ilike ${"%" + q + "%"}
                   ${qDigits.length >= 3 ? sql`or k.phone like ${"%" + qDigits + "%"}` : sql``})`
        : sql``
    }
  `;

  return withService(async (db) => {
    const rows = asRows<{
      id: string;
      status: string;
      unread_count: number;
      last_message_at: string | null;
      last_inbound_at: string | null;
      last_preview: string | null;
      contact_id: string;
      phone: string;
      profile_name: string | null;
      user_id: string | null;
      contact_last_inbound_at: string | null;
      total: number;
    }>(
      await db.execute(sql`
        select c.id, c.status, c.unread_count, c.last_message_at, c.last_inbound_at,
               c.last_preview, c.contact_id, k.phone, k.profile_name, k.user_id,
               k.last_inbound_at as contact_last_inbound_at,
               count(*) over()::int as total
          from public.whatsapp_conversations c
          join public.whatsapp_contacts k on k.id = c.contact_id
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
  };
}

export async function loadThread(
  storeId: string,
  conversationId: string,
): Promise<InboxThread | null> {
  const core = await loadConversation(storeId, conversationId);
  if (!core) return null;

  const [messages, customer] = await Promise.all([
    loadMessages(storeId, conversationId),
    loadCustomerPanel(storeId, core),
  ]);

  return {
    conversation: toRow(core),
    messages,
    window: serviceWindow(core.contact.lastInboundAt),
    customer,
  };
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
  const adminIds = [
    ...new Set(rows.map((r) => r.sentByAdminId).filter(Boolean)),
  ] as string[];
  const names = new Map<string, string>();
  if (adminIds.length > 0) {
    const people = await withService((db) =>
      db
        .select({
          id: admins.id,
          firstName: admins.firstName,
          lastName: admins.lastName,
          email: admins.email,
        })
        .from(admins)
        .where(and(eq(admins.storeId, storeId), inArray(admins.id, adminIds))),
    ).catch(() => []);
    for (const p of people) {
      const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
      names.set(p.id, name || p.email);
    }
  }

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
    .filter((r) => r.audience !== "team" && !templateHasButtons(r.components))
    .map((r) => ({
      id: r.id,
      name: r.name,
      language: r.language,
      body: bodyFromComponents(r.components),
      variables: Array.isArray(r.variables) ? (r.variables as string[]) : [],
    }));
}
