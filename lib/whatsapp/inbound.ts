import "server-only";

import crypto from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  storeWhatsappAccounts,
  whatsappInboundEvents,
  whatsappLogs,
  whatsappTemplates,
} from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { isWhatsAppWebhook } from "./webhook-events";

// ---------------------------------------------------------------------------
// Webhook deliveries: ACK FAST, WORK LATER (docs/whatsapp-commerce-plan.md §9).
//
// `recordWebhookDelivery` turns one signed POST into rows of
// whatsapp_inbound_events — one per message, one per status, one per other
// change — routed to a store by metadata.phone_number_id (or, for account and
// template changes that carry no number, by the WABA id in entry.id). It is
// the ONLY writer of that table, which is what lets its idempotency key be
// trusted: Meta redelivers for up to a week, and a redelivered row is a
// no-op at the UNIQUE (phone_number_id, field, event_id).
//
// `processPendingInboundEvents` drains the rows a handler exists for: template
// and number/account state (the facts the Channels card and the notification
// switch read), and — since slice 2 — the DELIVERY STATUSES Meta posts against
// messages we sent, which advance `whatsapp_logs`. Inbound MESSAGES are LEFT
// UNPROCESSED on purpose: slice 3 adds the inbox, and marking them done now
// would throw away the backlog it drains. The selector therefore names its
// fields, and within `messages` only the `status` kind.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

interface EventRow {
  storeId: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  field: string;
  eventId: string;
  payload: unknown;
}

function digest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Split a delivery into event rows. Pure apart from the store lookup, which
 * is injected so the route test needs no database.
 */
export function explodeWebhook(
  body: unknown,
  storeFor: (keys: {
    phoneNumberId: string | null;
    wabaId: string | null;
  }) => string | null,
): EventRow[] {
  const rows: EventRow[] = [];
  if (!isWhatsAppWebhook(body) || !Array.isArray(body.entry)) return rows;

  for (const entry of body.entry) {
    if (!isRec(entry) || !Array.isArray(entry.changes)) continue;
    const wabaId = str(entry.id);
    for (const change of entry.changes) {
      if (!isRec(change)) continue;
      const field = str(change.field) ?? "unknown";
      const value = isRec(change.value) ? change.value : {};
      const metadata = isRec(value.metadata) ? value.metadata : {};
      const phoneNumberId = str(metadata.phone_number_id);
      const storeId = storeFor({ phoneNumberId, wabaId });

      if (field === "messages") {
        // One row per message and per status, each carrying the metadata and
        // contacts it arrived with, so a handler sees a self-contained item.
        const common = { metadata, contacts: value.contacts ?? [] };
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const m of messages) {
          if (!isRec(m)) continue;
          const id = str(m.id);
          if (!id) continue;
          rows.push({
            storeId,
            wabaId,
            phoneNumberId,
            field: "messages",
            eventId: `msg:${id}`,
            payload: { kind: "message", message: m, ...common },
          });
        }
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const s of statuses) {
          if (!isRec(s)) continue;
          const id = str(s.id);
          const status = str(s.status);
          if (!id || !status) continue;
          rows.push({
            storeId,
            wabaId,
            phoneNumberId,
            field: "messages",
            eventId: `status:${id}:${status}`,
            payload: { kind: "status", status: s, ...common },
          });
        }
        const errors = Array.isArray(value.errors) ? value.errors : [];
        if (
          errors.length > 0 &&
          messages.length === 0 &&
          statuses.length === 0
        ) {
          rows.push({
            storeId,
            wabaId,
            phoneNumberId,
            field: "messages",
            eventId: `errors:${digest(errors)}`,
            payload: { kind: "errors", errors, ...common },
          });
        }
        continue;
      }

      rows.push({
        storeId,
        wabaId,
        phoneNumberId,
        field,
        eventId: digest(value),
        payload: value,
      });
    }
  }
  return rows;
}

/** Every phone number id and WABA id a delivery names, for one lookup. */
function keysOf(body: unknown): { phones: Set<string>; wabas: Set<string> } {
  const phones = new Set<string>();
  const wabas = new Set<string>();
  if (!isWhatsAppWebhook(body) || !Array.isArray(body.entry)) {
    return { phones, wabas };
  }
  for (const entry of body.entry) {
    if (!isRec(entry)) continue;
    const w = str(entry.id);
    if (w) wabas.add(w);
    if (!Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRec(change) || !isRec(change.value)) continue;
      const md = isRec(change.value.metadata) ? change.value.metadata : {};
      const p = str(md.phone_number_id);
      if (p) phones.add(p);
    }
  }
  return { phones, wabas };
}

export interface RecordResult {
  rows: number;
  inserted: number;
  /** Rows for a number or WABA no store holds — recorded, never routed. */
  unrouted: number;
}

/**
 * Persist one verified delivery. Never throws into the route: a database
 * blip must become a 503 (so Meta retries) rather than a 500 with a stack.
 */
export async function recordWebhookDelivery(
  body: unknown,
): Promise<RecordResult> {
  const { phones, wabas } = keysOf(body);
  const byPhone = new Map<string, string>();
  const byWaba = new Map<string, string>();

  if (phones.size > 0 || wabas.size > 0) {
    const accounts = await withService((db) =>
      db
        .select({
          storeId: storeWhatsappAccounts.storeId,
          phoneNumberId: storeWhatsappAccounts.phoneNumberId,
          wabaId: storeWhatsappAccounts.wabaId,
        })
        .from(storeWhatsappAccounts)
        .where(
          sql`${storeWhatsappAccounts.phoneNumberId} = any(${sql.param([...phones])}::text[]) or ${storeWhatsappAccounts.wabaId} = any(${sql.param([...wabas])}::text[])`,
        ),
    );
    for (const a of accounts) {
      byPhone.set(a.phoneNumberId, a.storeId);
      byWaba.set(a.wabaId, a.storeId);
    }
  }

  const rows = explodeWebhook(
    body,
    ({ phoneNumberId, wabaId }) =>
      (phoneNumberId && byPhone.get(phoneNumberId)) ||
      (wabaId && byWaba.get(wabaId)) ||
      null,
  );
  if (rows.length === 0) return { rows: 0, inserted: 0, unrouted: 0 };

  const inserted = await withService((db) =>
    db
      .insert(whatsappInboundEvents)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: whatsappInboundEvents.id }),
  );
  const unrouted = rows.filter((r) => r.storeId === null).length;
  if (unrouted > 0) {
    logWarn("whatsapp inbound: delivery for an unknown number", {
      phoneNumberIds: [...phones],
      wabaIds: [...wabas],
      unrouted,
    });
  }
  return { rows: rows.length, inserted: inserted.length, unrouted };
}

// ── Processing ──────────────────────────────────────────────────────────────

/** Fields this slice can act on. Anything else stays pending for its slice. */
export const HANDLED_FIELDS = [
  "message_template_status_update",
  "message_template_quality_update",
  "template_category_update",
  "phone_number_quality_update",
  "phone_number_name_update",
  "account_update",
  "business_capability_update",
] as const;

export interface ProcessResult {
  claimed: number;
  processed: number;
  failed: number;
}

export async function processPendingInboundEvents(
  limit = 50,
): Promise<ProcessResult> {
  const result: ProcessResult = { claimed: 0, processed: 0, failed: 0 };

  const claimed = await withService((db) =>
    db
      .select({
        id: whatsappInboundEvents.id,
        storeId: whatsappInboundEvents.storeId,
        wabaId: whatsappInboundEvents.wabaId,
        phoneNumberId: whatsappInboundEvents.phoneNumberId,
        field: whatsappInboundEvents.field,
        payload: whatsappInboundEvents.payload,
      })
      .from(whatsappInboundEvents)
      .where(
        and(
          isNull(whatsappInboundEvents.processedAt),
          sql`(${whatsappInboundEvents.field} = any(${sql.param([...HANDLED_FIELDS])}::text[]) or (${whatsappInboundEvents.field} = 'messages' and ${whatsappInboundEvents.payload}->>'kind' = 'status'))`,
        ),
      )
      .orderBy(whatsappInboundEvents.receivedAt)
      .limit(limit),
  );
  result.claimed = claimed.length;

  for (const ev of claimed) {
    try {
      await withService(async (db) => {
        if (ev.storeId && ev.field === "messages") {
          await applyMessageStatus(db, {
            storeId: ev.storeId,
            value: isRec(ev.payload) ? ev.payload : {},
          });
        } else if (ev.storeId) {
          await applyAccountEvent(db, {
            storeId: ev.storeId,
            field: ev.field,
            value: isRec(ev.payload) ? ev.payload : {},
          });
        }
        await db
          .update(whatsappInboundEvents)
          .set({ processedAt: new Date().toISOString(), error: null })
          .where(eq(whatsappInboundEvents.id, ev.id));
      });
      result.processed++;
    } catch (err) {
      result.failed++;
      const message = err instanceof Error ? err.message : String(err);
      logError("whatsapp inbound: processing failed", err, {
        field: ev.field,
        storeId: ev.storeId,
      });
      await withService((db) =>
        db
          .update(whatsappInboundEvents)
          .set({
            // Marked processed WITH the error so it is not retried forever;
            // the row keeps its payload for a human to read.
            processedAt: new Date().toISOString(),
            error: message.slice(0, 500),
          })
          .where(eq(whatsappInboundEvents.id, ev.id)),
      ).catch(() => undefined);
    }
  }
  return result;
}

/** Account- and template-level facts, applied to the rows the card reads. */
export async function applyAccountEvent(
  db: Db,
  ev: { storeId: string; field: string; value: Rec },
): Promise<void> {
  const v = ev.value;
  const now = new Date().toISOString();
  const event = str(v.event);

  switch (ev.field) {
    case "message_template_status_update": {
      // Meta identifies the template by id, name and language; a bootstrapped
      // template is matched on id first, and by (name, language) when the
      // id has not been recorded yet.
      const templateId = v.message_template_id;
      const name = str(v.message_template_name);
      const language = str(v.message_template_language);
      const status = event;
      if (!status) return;
      const reason = str(v.reason);
      const set = {
        status,
        rejectionReason: status === "REJECTED" ? reason : null,
        providerTemplateId:
          templateId !== undefined && templateId !== null
            ? String(templateId)
            : undefined,
        updatedAt: now,
      };
      if (templateId !== undefined && templateId !== null) {
        const updated = await db
          .update(whatsappTemplates)
          .set(set)
          .where(
            and(
              eq(whatsappTemplates.storeId, ev.storeId),
              eq(whatsappTemplates.providerTemplateId, String(templateId)),
            ),
          )
          .returning({ id: whatsappTemplates.id });
        if (updated.length > 0) return;
      }
      if (name && language) {
        await db
          .update(whatsappTemplates)
          .set(set)
          .where(
            and(
              eq(whatsappTemplates.storeId, ev.storeId),
              eq(whatsappTemplates.name, name),
              eq(whatsappTemplates.language, language),
            ),
          );
      }
      return;
    }
    case "message_template_quality_update": {
      const name = str(v.message_template_name);
      const language = str(v.message_template_language);
      const quality = str(v.new_quality_score);
      if (!name || !language || !quality) return;
      await db
        .update(whatsappTemplates)
        .set({ quality, updatedAt: now })
        .where(
          and(
            eq(whatsappTemplates.storeId, ev.storeId),
            eq(whatsappTemplates.name, name),
            eq(whatsappTemplates.language, language),
          ),
        );
      return;
    }
    case "template_category_update": {
      const name = str(v.message_template_name);
      const language = str(v.message_template_language);
      const category = str(v.new_category);
      if (!name || !language || !category) return;
      await db
        .update(whatsappTemplates)
        .set({ category, updatedAt: now })
        .where(
          and(
            eq(whatsappTemplates.storeId, ev.storeId),
            eq(whatsappTemplates.name, name),
            eq(whatsappTemplates.language, language),
          ),
        );
      return;
    }
    case "phone_number_quality_update": {
      // event: ONBOARDING | UPGRADE | DOWNGRADE | FLAGGED | UNFLAGGED;
      // current_limit: TIER_250 | TIER_1K | TIER_10K | TIER_100K | TIER_UNLIMITED
      const tier = str(v.current_limit);
      await db
        .update(storeWhatsappAccounts)
        .set({
          messagingTier: tier ?? undefined,
          qualityRating:
            event === "FLAGGED"
              ? "RED"
              : event === "UNFLAGGED"
                ? "GREEN"
                : undefined,
          updatedAt: now,
        })
        .where(eq(storeWhatsappAccounts.storeId, ev.storeId));
      return;
    }
    case "phone_number_name_update": {
      // decision: APPROVED | REJECTED; requested_verified_name
      const decision = str(v.decision);
      const requested = str(v.requested_verified_name);
      await db
        .update(storeWhatsappAccounts)
        .set({
          nameStatus:
            decision === "APPROVED"
              ? "APPROVED"
              : decision === "REJECTED"
                ? "DECLINED"
                : undefined,
          verifiedName:
            decision === "APPROVED" && requested ? requested : undefined,
          lastError:
            decision === "REJECTED"
              ? `Display name "${requested ?? ""}" was declined by Meta${str(v.rejection_reason) ? `: ${str(v.rejection_reason)}` : "."}`
              : undefined,
          updatedAt: now,
        })
        .where(eq(storeWhatsappAccounts.storeId, ev.storeId));
      return;
    }
    case "account_update": {
      // event: VERIFIED_ACCOUNT | DISABLED_UPDATE | ACCOUNT_RESTRICTION |
      // ACCOUNT_VIOLATION | ACCOUNT_DELETED | PARTNER_REMOVED | …
      if (event === "VERIFIED_ACCOUNT") {
        await db
          .update(storeWhatsappAccounts)
          .set({ wabaReviewStatus: "APPROVED", updatedAt: now })
          .where(eq(storeWhatsappAccounts.storeId, ev.storeId));
      } else if (event === "PARTNER_REMOVED" || event === "ACCOUNT_DELETED") {
        // The merchant removed us (or the WABA) at Meta: the token is dead.
        await db
          .update(storeWhatsappAccounts)
          .set({
            status: "needs_reauth",
            lastError:
              event === "ACCOUNT_DELETED"
                ? "The WhatsApp Business account was deleted at Meta."
                : "StoreMink was removed from this WhatsApp account at Meta. Reconnect to resume.",
            updatedAt: now,
          })
          .where(eq(storeWhatsappAccounts.storeId, ev.storeId));
      } else if (
        event === "ACCOUNT_RESTRICTION" ||
        event === "ACCOUNT_VIOLATION" ||
        event === "DISABLED_UPDATE"
      ) {
        const info = isRec(v.ban_info)
          ? v.ban_info
          : isRec(v.restriction_info)
            ? v.restriction_info
            : {};
        await db
          .update(storeWhatsappAccounts)
          .set({
            lastError: `Meta reported ${event.toLowerCase().replace(/_/g, " ")}${str(info.waba_ban_state) ? ` (${str(info.waba_ban_state)})` : ""}. Check WhatsApp Manager.`,
            updatedAt: now,
          })
          .where(eq(storeWhatsappAccounts.storeId, ev.storeId));
      }
      return;
    }
    case "business_capability_update": {
      // max_daily_conversation_per_phone, max_phone_numbers_per_business —
      // a capability, not a tier; recorded in the log only for now.
      logInfo("whatsapp: business capability update", {
        storeId: ev.storeId,
        maxDaily: v.max_daily_conversation_per_phone ?? null,
      });
      return;
    }
    default:
      return;
  }
}

/**
 * A delivery status against a message WE sent — sent / delivered / read /
 * failed — onto its `whatsapp_logs` row, found by the provider message id
 * (the UNIQUE partial index).
 *
 * ★ THE TIMELINE ONLY MOVES FORWARD. Meta can deliver `read` before
 * `delivered`, and redeliver either; each step stamps its own timestamp once
 * and the status column holds the furthest point reached. A `failed` is
 * terminal and carries Meta's code and title, which is what turns "failed"
 * into "131026: the number isn't on WhatsApp" in the log.
 *
 * A status for an id we never logged (sent from the merchant's phone under
 * Coexistence, or from another tool on the same number) is ignored — there is
 * no row to advance, and slice 3's inbox is where the merchant's own replies
 * are recorded.
 */
export async function applyMessageStatus(
  db: Db,
  ev: { storeId: string; value: Rec },
): Promise<void> {
  const status = isRec(ev.value.status) ? ev.value.status : null;
  if (!status) return;
  const messageId = str(status.id);
  const kind = str(status.status)?.toLowerCase();
  if (!messageId || !kind) return;

  const at = statusTime(status.timestamp);
  const conversation = isRec(status.conversation) ? status.conversation : {};
  const pricing = isRec(status.pricing) ? status.pricing : {};
  const errors = Array.isArray(status.errors) ? status.errors : [];
  const firstError = isRec(errors[0]) ? errors[0] : null;

  const set: Partial<typeof whatsappLogs.$inferInsert> = {};
  if (str(conversation.id)) set.conversationId = str(conversation.id);
  if (str(pricing.category)) set.pricingCategory = str(pricing.category);
  if (typeof pricing.billable === "boolean") set.billable = pricing.billable;

  switch (kind) {
    case "sent":
      set.sentAt = at;
      break;
    case "delivered":
      set.deliveredAt = at;
      break;
    case "read":
      set.readAt = at;
      break;
    case "failed": {
      set.failedAt = at;
      const code = firstError?.code;
      set.errorCode = typeof code === "number" ? code : null;
      const detail = isRec(firstError?.error_data)
        ? str(firstError.error_data.details)
        : null;
      set.error =
        [str(firstError?.title), detail].filter(Boolean).join(": ") ||
        "Meta reported the message as failed.";
      break;
    }
    default:
      return;
  }

  // Rank so a late `delivered` never demotes a `read`, and nothing moves a
  // row off `failed`. The comparison runs in SQL so two statuses landing at
  // once cannot read the same old row and both win.
  const incoming = STATUS_RANK[kind] ?? 0;
  await db
    .update(whatsappLogs)
    .set({
      ...set,
      status: sql`case when (case ${whatsappLogs.status} when 'skipped' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'failed' then 4 else 0 end) < ${incoming} then ${kind} else ${whatsappLogs.status} end`,
    })
    .where(
      and(
        eq(whatsappLogs.storeId, ev.storeId),
        eq(whatsappLogs.providerMessageId, messageId),
      ),
    );
}

/** How far along the timeline each status is; mirrored in the SQL above. */
export const STATUS_RANK: Record<string, number> = {
  skipped: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

/** Meta's `timestamp` is epoch seconds as a string. */
function statusTime(value: unknown): string {
  const n = Number(value);
  if (Number.isFinite(n) && n > 1_000_000_000) {
    return new Date(n * 1000).toISOString();
  }
  return new Date().toISOString();
}
