import "server-only";

import { eq, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  storeWhatsappAccounts,
  whatsappContacts,
  whatsappMessages,
} from "@/drizzle/schema";
import { decryptSecret } from "@/lib/payments/crypto";
import { logError, logWarn } from "@/lib/observability/logger";
import { gcsConfigured, gcsUploadObject } from "@/lib/storage/gcs";
import { formatStoredPhone, storedPhoneVariants } from "@/lib/phone";
import { downloadMedia, getMediaInfo } from "./graph";
import { classifyWhatsAppInbound } from "./inbox-intent";
import {
  MEDIA_KINDS,
  parseEchoMessage,
  parseInboundMessage,
  previewOf,
  type InboxMessageKind,
  type ParsedMedia,
} from "./inbox-parse";
import { WHATSAPP_MARKETING_CONSENT_REPLY } from "./consent-copy";
import { parseCodPayload, type CodPayload } from "./cod-payload";

// ---------------------------------------------------------------------------
// The inbox's write side: what a webhook delivery does to contacts,
// conversations and messages (docs/whatsapp-commerce-plan.md §10, §11).
//
// ── ★ ONE CONVERSATION PER CONTACT, FOUND BY UPSERT ────────────────────────
// An inbound message upserts its contact on (store, phone), upserts the
// conversation on (store, contact), then inserts the message on (store,
// provider id) with DO NOTHING. Only a message that was actually INSERTED
// bumps the unread count and reopens the conversation, so a redelivered
// event — Meta retries for a week — changes nothing a second time.
//
// ── ★ THE WINDOW CLOCK IS THE CONTACT'S `last_inbound_at` ──────────────────
// Written by every inbound message, never by a send or an echo (plan §10): a
// template we sent does not open the window, and neither does the merchant
// typing on their phone. The reply action reads it; the list shows it.
//
// ── ★ STOP IS A MARKETING OPT-OUT, NOT A SILENCE ───────────────────────────
// "stop" in the inbox vocabulary (inbox-intent.ts) sets marketing_opt_out_at.
// Order updates continue — they are about that customer's own orders, and a
// customer who wrote "stop" to a shipping notice has not asked to be kept in
// the dark about their parcel. The account page is where updates are turned
// off, deliberately rather than by one ambiguous word.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

/** WhatsApp's customer-service window. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Meta caps inbound image at 5 MB, video/audio at 16 MB, documents at 100
 *  MB. We keep what a merchant will actually open in an inbox and refuse the
 *  rest rather than fill the bucket with files nobody views. */
export const MAX_INBOUND_MEDIA_BYTES = 25 * 1024 * 1024;

export function serviceWindow(
  lastInboundAt: string | null | undefined,
  now = Date.now(),
): { open: boolean; closesAt: string | null } {
  if (!lastInboundAt) return { open: false, closesAt: null };
  const at = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(at)) return { open: false, closesAt: null };
  const closes = at + SERVICE_WINDOW_MS;
  return {
    open: closes > now,
    closesAt: new Date(closes).toISOString(),
  };
}

function asRows<T = Rec>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

export interface RecordInboundResult {
  inserted: boolean;
  contactId: string | null;
  conversationId: string | null;
  messageId: string | null;
  /** True when this message moved the conversation INTO needs_reply — the
   *  bell rings once per unanswered run, not once per message. */
  needsNotify: boolean;
  /** Media to copy into our bucket, after the transaction commits. */
  media: ParsedMedia | null;
  kind: InboxMessageKind | null;
  preview: string | null;
  /** Who, for the bell: the WhatsApp name or the number. */
  contactLabel: string | null;
  userId: string | null;
  /** A tap on a COD Confirm / Cancel button, to act on after commit. */
  codReply: CodPayload | null;
  /** The sender, as stored on the contact (E.164). */
  phone: string | null;
}

const NOTHING: RecordInboundResult = {
  inserted: false,
  contactId: null,
  conversationId: null,
  messageId: null,
  needsNotify: false,
  media: null,
  kind: null,
  preview: null,
  contactLabel: null,
  userId: null,
  codReply: null,
  phone: null,
};

/**
 * Upsert the contact a message is from (or, for an echo, to). `inbound`
 * decides whether the window clock moves.
 */
async function upsertContact(
  db: Db,
  input: {
    storeId: string;
    phone: string;
    waId: string;
    profileName: string | null;
    referral: Rec | null;
    inboundAt: string | null;
  },
): Promise<{
  id: string;
  userId: string | null;
  marketingOptInAt: string | null;
  marketingOptOutAt: string | null;
}> {
  const variants = storedPhoneVariants(input.phone);
  const rows = asRows<{
    id: string;
    user_id: string | null;
    marketing_opt_in_at: string | null;
    marketing_opt_out_at: string | null;
  }>(
    await db.execute(sql`
      insert into public.whatsapp_contacts
        (store_id, phone, wa_id, profile_name, user_id, last_inbound_at, referral)
      values
        (${input.storeId}::uuid, ${input.phone}, ${input.waId}, ${input.profileName},
         -- A real account wins over a till-created pos_ row (§36's rule), and
         -- both shapes of the stored number are matched.
         (select u.id from public.users u
           where u.store_id = ${input.storeId}::uuid
             and u.phone = any(${sql.param(variants)}::text[])
           order by (u.id like 'pos\\_%') limit 1),
         ${input.inboundAt}::timestamptz,
         ${input.referral ? JSON.stringify(input.referral) : null}::jsonb)
      on conflict (store_id, phone) do update set
        wa_id = excluded.wa_id,
        profile_name = coalesce(excluded.profile_name, public.whatsapp_contacts.profile_name),
        user_id = coalesce(public.whatsapp_contacts.user_id, excluded.user_id),
        last_inbound_at = case
          when excluded.last_inbound_at is null then public.whatsapp_contacts.last_inbound_at
          else greatest(coalesce(public.whatsapp_contacts.last_inbound_at, '-infinity'::timestamptz), excluded.last_inbound_at) end,
        referral = coalesce(excluded.referral, public.whatsapp_contacts.referral),
        updated_at = now()
      returning id, user_id, marketing_opt_in_at, marketing_opt_out_at
    `),
  );
  const row = rows[0];
  if (!row) throw new Error("whatsapp inbox: contact upsert returned no row");
  return {
    id: row.id,
    userId: row.user_id,
    marketingOptInAt: row.marketing_opt_in_at,
    marketingOptOutAt: row.marketing_opt_out_at,
  };
}

/** Ensure the one conversation for a contact exists; report its status. */
async function ensureConversation(
  db: Db,
  storeId: string,
  contactId: string,
): Promise<{ id: string; status: string }> {
  const rows = asRows<{ id: string; status: string }>(
    await db.execute(sql`
      insert into public.whatsapp_conversations (store_id, contact_id)
      values (${storeId}::uuid, ${contactId}::uuid)
      on conflict (store_id, contact_id) do update set updated_at = now()
      returning id, status
    `),
  );
  const row = rows[0];
  if (!row)
    throw new Error("whatsapp inbox: conversation upsert returned no row");
  return row;
}

/**
 * File one inbound message. Throws on an item that cannot be a message, so
 * the caller marks the event processed WITH the error; never throws for a
 * duplicate, which is the ordinary case Meta's retries produce.
 */
export async function recordInboundMessage(
  db: Db,
  ev: { storeId: string; value: Rec },
): Promise<RecordInboundResult> {
  const parsed = parseInboundMessage(ev.value.message, ev.value.contacts);
  if (!parsed) throw new Error("inbound message has no id or sender");

  const contact = await upsertContact(db, {
    storeId: ev.storeId,
    phone: parsed.phone,
    waId: parsed.waId,
    profileName: parsed.profileName,
    referral: parsed.referral,
    inboundAt: parsed.sentAt,
  });
  const conversation = await ensureConversation(db, ev.storeId, contact.id);

  const inserted = await db
    .insert(whatsappMessages)
    .values({
      storeId: ev.storeId,
      conversationId: conversation.id,
      direction: "in",
      source: "customer",
      kind: parsed.kind,
      body: parsed.body,
      mediaMime: parsed.media?.mime ?? null,
      mediaName: parsed.media?.filename ?? null,
      payload: parsed.payload,
      quotedProviderId: parsed.quotedProviderId,
      providerMessageId: parsed.providerId,
      status: "received",
      sentAt: parsed.sentAt,
    })
    .onConflictDoNothing()
    .returning({ id: whatsappMessages.id });
  const messageId = inserted[0]?.id ?? null;
  const contactLabel = parsed.profileName ?? formatStoredPhone(parsed.phone);
  if (!messageId) {
    return {
      ...NOTHING,
      contactId: contact.id,
      conversationId: conversation.id,
      contactLabel,
      userId: contact.userId,
    };
  }

  const preview = previewOf(parsed.body, parsed.kind);
  // ★ A COD BUTTON TAP IS ANSWERED BY THE SYSTEM, not left for staff: it is
  // filed in the thread like any message and opens the 24-hour window (the
  // reply is free text), but it neither asks for a reply nor rings the bell.
  // cod-confirmation.ts acts on it after this commits, and hands it to a
  // person only when it cannot.
  const codReply =
    parsed.kind === "button"
      ? parseCodPayload(
          (parsed.payload as Record<string, unknown> | null)?.buttonPayload,
        )
      : null;
  const automated = codReply !== null;
  await db.execute(sql`
    update public.whatsapp_conversations set
      status = case when ${automated}::boolean then status else 'needs_reply' end,
      unread_count = unread_count + case when ${automated}::boolean then 0 else 1 end,
      last_message_at = greatest(coalesce(last_message_at, '-infinity'::timestamptz), ${parsed.sentAt}::timestamptz),
      last_inbound_at = greatest(coalesce(last_inbound_at, '-infinity'::timestamptz), ${parsed.sentAt}::timestamptz),
      last_preview = ${preview},
      updated_at = now()
    where id = ${conversation.id}::uuid
  `);

  // STOP / START (plan §10). Recorded on the contact; the message keeps the
  // intent in its payload so the thread can say "opted out of offers".
  if (parsed.kind === "text" && parsed.body) {
    const intent = classifyWhatsAppInbound(parsed.body);
    if (intent === "stop") {
      await db
        .update(whatsappContacts)
        .set({
          marketingOptOutAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(whatsappContacts.id, contact.id));
      await db
        .update(whatsappMessages)
        .set({ payload: { intent: "stop" } })
        .where(eq(whatsappMessages.id, messageId));
    } else if (intent === "start" && contact.marketingOptInAt) {
      // Only somebody who HAD opted in can re-opt in by reply: "start" from a
      // customer who never agreed to offers is not consent to receive them.
      const now = new Date().toISOString();
      await db
        .update(whatsappContacts)
        .set({
          marketingOptInAt: now,
          marketingConsentText: WHATSAPP_MARKETING_CONSENT_REPLY,
          marketingOptOutAt: null,
          updatedAt: now,
        })
        .where(eq(whatsappContacts.id, contact.id));
      await db
        .update(whatsappMessages)
        .set({ payload: { intent: "start" } })
        .where(eq(whatsappMessages.id, messageId));
    }
  }

  return {
    inserted: true,
    contactId: contact.id,
    conversationId: conversation.id,
    messageId,
    needsNotify: !automated && conversation.status !== "needs_reply",
    media: parsed.media,
    kind: parsed.kind,
    preview,
    contactLabel,
    userId: contact.userId,
    codReply,
    phone: parsed.phone,
  };
}

/**
 * A message the merchant sent from the WhatsApp Business app (Coexistence),
 * filed as an outbound message from the phone. It answers the conversation —
 * the merchant replied — so needs_reply becomes open; it never moves the
 * window clock, and it never counts as unread.
 */
export async function recordEchoMessage(
  db: Db,
  ev: { storeId: string; value: Rec },
): Promise<RecordInboundResult> {
  const parsed = parseEchoMessage(ev.value.message);
  if (!parsed) throw new Error("echo has no id or recipient");

  const contact = await upsertContact(db, {
    storeId: ev.storeId,
    phone: parsed.phone,
    waId: parsed.waId,
    profileName: null,
    referral: null,
    inboundAt: null,
  });
  const conversation = await ensureConversation(db, ev.storeId, contact.id);

  const inserted = await db
    .insert(whatsappMessages)
    .values({
      storeId: ev.storeId,
      conversationId: conversation.id,
      direction: "out",
      source: "phone_app",
      kind: parsed.kind,
      body: parsed.body,
      mediaMime: parsed.media?.mime ?? null,
      mediaName: parsed.media?.filename ?? null,
      providerMessageId: parsed.providerId,
      status: "sent",
      sentAt: parsed.sentAt,
    })
    .onConflictDoNothing()
    .returning({ id: whatsappMessages.id });
  const messageId = inserted[0]?.id ?? null;
  if (!messageId) {
    return {
      ...NOTHING,
      contactId: contact.id,
      conversationId: conversation.id,
      userId: contact.userId,
    };
  }

  const preview = previewOf(parsed.body, parsed.kind);
  await db.execute(sql`
    update public.whatsapp_conversations set
      status = 'open',
      last_message_at = greatest(coalesce(last_message_at, '-infinity'::timestamptz), ${parsed.sentAt}::timestamptz),
      last_outbound_at = greatest(coalesce(last_outbound_at, '-infinity'::timestamptz), ${parsed.sentAt}::timestamptz),
      last_preview = ${preview},
      updated_at = now()
    where id = ${conversation.id}::uuid
  `);

  return {
    inserted: true,
    contactId: contact.id,
    conversationId: conversation.id,
    messageId,
    needsNotify: false,
    media: parsed.media,
    kind: parsed.kind,
    preview,
    contactLabel: null,
    userId: contact.userId,
    codReply: null,
    phone: null,
  };
}

/**
 * Record a message STAFF sent from the dashboard (or the template spine sent
 * on their behalf), after the choke point has reported the outcome. The
 * conversation becomes `open`: somebody answered.
 */
export async function recordOutboundMessage(
  db: Db,
  input: {
    storeId: string;
    conversationId: string;
    source: "dashboard" | "template" | "automation";
    kind: "text" | "template";
    body: string;
    providerMessageId: string | null;
    status: "sent" | "failed";
    error?: string | null;
    sentByAdminId?: string | null;
    templateId?: string | null;
  },
): Promise<string> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(whatsappMessages)
    .values({
      storeId: input.storeId,
      conversationId: input.conversationId,
      direction: "out",
      source: input.source,
      kind: input.kind,
      body: input.body,
      providerMessageId: input.providerMessageId,
      status: input.status,
      error: input.error ?? null,
      sentByAdminId: input.sentByAdminId ?? null,
      templateId: input.templateId ?? null,
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: whatsappMessages.id });
  const id = rows[0]?.id ?? "";
  if (input.status === "sent") {
    await db.execute(sql`
      update public.whatsapp_conversations set
        status = case when status = 'closed' then 'closed' else 'open' end,
        unread_count = 0,
        last_message_at = ${now}::timestamptz,
        last_outbound_at = ${now}::timestamptz,
        last_preview = ${previewOf(input.body, input.kind)},
        updated_at = now()
      where id = ${input.conversationId}::uuid
        and store_id = ${input.storeId}::uuid
    `);
  }
  return id;
}

/** How far along a delivery is; mirrored in the SQL below. */
const MESSAGE_STATUS_RANK: Record<string, number> = {
  received: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

/**
 * A delivery status against an outbound message in a thread — the same
 * forward-only rule `whatsapp_logs` follows. An id we never filed (an order
 * update sent before the inbox existed) matches nothing, which is fine: the
 * log still has it.
 */
export async function applyStatusToMessage(
  db: Db,
  input: {
    storeId: string;
    providerMessageId: string;
    status: string;
    error?: string | null;
  },
): Promise<void> {
  const incoming = MESSAGE_STATUS_RANK[input.status];
  if (incoming === undefined || incoming === 0) return;
  await db.execute(sql`
    update public.whatsapp_messages set
      status = case
        when (case status when 'received' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'failed' then 4 else 0 end) < ${incoming}
        then ${input.status} else status end,
      error = case when ${input.status} = 'failed' then ${input.error ?? null} else error end
    where store_id = ${input.storeId}::uuid
      and provider_message_id = ${input.providerMessageId}
      and direction = 'out'
  `);
}

// ── Media ───────────────────────────────────────────────────────────────────

const EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/amr": ".amr",
  "application/pdf": ".pdf",
};

function extensionFor(mime: string | null): string {
  if (!mime) return "";
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION[base] ?? "";
}

/** The GCS path an inbound file is kept at — under the store's own prefix. */
export function inboundMediaPath(
  storeId: string,
  conversationId: string,
  messageId: string,
  mime: string | null,
): string {
  return `stores/${storeId}/whatsapp/${conversationId}/${messageId}${extensionFor(mime)}`;
}

async function loadInboxToken(storeId: string): Promise<string | null> {
  const rows = await withService((db) =>
    db
      .select({
        tokenEnc: storeWhatsappAccounts.businessTokenEnc,
        status: storeWhatsappAccounts.status,
      })
      .from(storeWhatsappAccounts)
      .where(eq(storeWhatsappAccounts.storeId, storeId))
      .limit(1),
  );
  const row = rows[0];
  // A PAUSED number still receives: `enabled` is the merchant's send switch,
  // not a reason to drop what a customer sent. Only a dead token stops this.
  if (!row || row.status !== "connected") return null;
  return decryptSecret(row.tokenEnc);
}

/**
 * Copy one inbound media object into our bucket and point the message at it.
 * Runs AFTER the recording transaction commits: a download is a 20-second
 * network call, and holding a pooled connection across it would make a busy
 * inbox starve every other query. Failure leaves the message with its
 * caption and an error; the row is never lost.
 */
export async function storeInboundMedia(input: {
  storeId: string;
  conversationId: string;
  messageId: string;
  media: ParsedMedia;
}): Promise<void> {
  const fail = async (reason: string) => {
    await withService((db) =>
      db
        .update(whatsappMessages)
        .set({ error: reason.slice(0, 300) })
        .where(eq(whatsappMessages.id, input.messageId)),
    ).catch(() => undefined);
  };
  try {
    if (!gcsConfigured) {
      await fail("Media storage is not configured.");
      return;
    }
    const token = await loadInboxToken(input.storeId);
    if (!token) {
      await fail("WhatsApp is not connected; the file could not be fetched.");
      return;
    }
    const info = await getMediaInfo(token, input.media.id);
    if (!info.ok) {
      await fail(`Couldn't fetch the file from Meta: ${info.error}`);
      return;
    }
    if (
      typeof info.data.file_size === "number" &&
      info.data.file_size > MAX_INBOUND_MEDIA_BYTES
    ) {
      await fail("The file is too large to keep (over 25 MB).");
      return;
    }
    const bytes = await downloadMedia(
      token,
      info.data.url,
      MAX_INBOUND_MEDIA_BYTES,
    );
    if (!bytes.ok) {
      await fail(`Couldn't download the file: ${bytes.error}`);
      return;
    }
    const mime =
      info.data.mime_type ?? bytes.data.contentType ?? input.media.mime;
    const path = inboundMediaPath(
      input.storeId,
      input.conversationId,
      input.messageId,
      mime,
    );
    await gcsUploadObject(
      path,
      bytes.data.bytes,
      mime ?? "application/octet-stream",
      "private, max-age=0",
    );
    await withService((db) =>
      db
        .update(whatsappMessages)
        .set({ mediaPath: path, mediaMime: mime ?? null, error: null })
        .where(eq(whatsappMessages.id, input.messageId)),
    );
  } catch (err) {
    logError("whatsapp inbox: media store failed", err, {
      storeId: input.storeId,
    });
    await fail("The file could not be saved.");
  }
}

/** Does this kind carry a file worth fetching? */
export function hasMedia(kind: InboxMessageKind | null): boolean {
  return kind !== null && MEDIA_KINDS.has(kind);
}

// ── Counts ──────────────────────────────────────────────────────────────────

/**
 * What the sidebar needs, in ONE round trip: is a number connected at all
 * (which decides whether Inbox is shown), and how many conversations are
 * waiting (its badge). Fails to "nothing" rather than throwing: a sidebar
 * must never be the reason a dashboard page fails to render.
 */
export async function inboxSidebarSummary(
  storeId: string,
): Promise<{ connected: boolean; needsReply: number }> {
  try {
    const rows = asRows<{ connected: boolean; needs_reply: number }>(
      await withService((db) =>
        db.execute(sql`
          select
            exists(select 1 from public.store_whatsapp_accounts a
                    where a.store_id = ${storeId}::uuid) as connected,
            (select count(*)::int from public.whatsapp_conversations c
              where c.store_id = ${storeId}::uuid and c.status = 'needs_reply') as needs_reply
        `),
      ),
    );
    const row = rows[0];
    return {
      connected: Boolean(row?.connected),
      needsReply: Number(row?.needs_reply ?? 0),
    };
  } catch (err) {
    logWarn("whatsapp inbox: sidebar summary failed", {
      storeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { connected: false, needsReply: 0 };
  }
}

/** The badge alone, for the poll. Throws, so the route can answer 503. */
export async function needsReplyCount(storeId: string): Promise<number> {
  const rows = asRows<{ n: number }>(
    await withService((db) =>
      db.execute(sql`
        select count(*)::int as n from public.whatsapp_conversations
         where store_id = ${storeId}::uuid and status = 'needs_reply'
      `),
    ),
  );
  return Number(rows[0]?.n ?? 0);
}
