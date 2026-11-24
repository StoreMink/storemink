import "server-only";

import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  notificationWhatsappQueue,
  storeWhatsappAccounts,
  whatsappInboundEvents,
  whatsappLogs,
} from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { recordEvent } from "@/lib/notifications/record";
import { isWhatsAppWebhook } from "./webhook-events";
import { handleCodReply } from "./cod-confirmation";
import { answerOptOut } from "./opt-out-reply";
import { answerAutomatically } from "./answer-automatically";
import { loadAutoReplyFlags } from "./auto-reply-store";
import { handleMenuReply } from "./menu-reply";
import { syncWhatsAppTemplates } from "./templates";
import { refreshWhatsAppAccount } from "./connect";
import { codButtonPayloads, codOrderFromPayloads } from "./cod-payload";
import { dropHeldSms, releaseHeldSms } from "./sms-fallback";
import { answerWithMink } from "./mink-answer";
import {
  applyStatusToMessage,
  handOverConversation,
  hasMedia,
  recordEchoMessage,
  recordInboundMessage,
  storeInboundMedia,
  type RecordInboundResult,
} from "./inbox";

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
// switch read); the DELIVERY STATUSES Meta posts against messages we sent,
// which advance `whatsapp_logs` and the thread; and — since slice 3 — inbound
// MESSAGES and Coexistence ECHOES, which become the inbox
// (lib/whatsapp/inbox.ts). The selector still names its fields and kinds, so
// a field this code has no handler for stays pending for the slice that adds
// one rather than being marked done and lost.
//
// ★ A MESSAGE IS RECORDED IN ITS OWN TRANSACTION AND ITS MEDIA FETCHED AFTER.
// The contact/conversation/message writes and the "processed" mark commit
// together, so a crash cannot file a message twice or lose one; the media
// download — a network call of up to twenty seconds — runs once that has
// committed, on no pooled connection, and the bell is rung after it too.
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

      if (field === "smb_message_echoes") {
        // Coexistence: what the merchant sent from the WhatsApp Business app.
        // One row per echo, keyed on the message id like an inbound one.
        const echoes = Array.isArray(value.message_echoes)
          ? value.message_echoes
          : [];
        for (const m of echoes) {
          if (!isRec(m)) continue;
          const id = str(m.id);
          if (!id) continue;
          rows.push({
            storeId,
            wabaId,
            phoneNumberId,
            field,
            eventId: `echo:${id}`,
            payload: { kind: "echo", message: m, metadata },
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

/**
 * Which stores one event row belongs to.
 *
 * ★★ A ROW THAT NAMES A NUMBER BELONGS TO THAT NUMBER'S STORE OR TO NOBODY.
 * Falling back to the WABA's store sent a message for a number no store
 * holds (a second or retired number on the same WABA, or a sibling store's
 * number) into another store's inbox, where a STOP changed that store's
 * contact and the auto-replies answered from the wrong number. Only a row
 * with NO number (template, quality and account changes) is routed by WABA,
 * and then to EVERY store holding it: their template rows and accounts are
 * their own, and each re-reads its own state from Meta (applyAccountEvent).
 */
export function routeInboundEvent(
  row: { phoneNumberId: string | null; wabaId: string | null },
  byPhone: ReadonlyMap<string, string>,
  byWaba: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  if (row.phoneNumberId) {
    const store = byPhone.get(row.phoneNumberId);
    return store ? [store] : [];
  }
  if (!row.wabaId) return [];
  return [...(byWaba.get(row.wabaId) ?? [])].sort();
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
  const byWaba = new Map<string, Set<string>>();

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
      const stores = byWaba.get(a.wabaId) ?? new Set<string>();
      stores.add(a.storeId);
      byWaba.set(a.wabaId, stores);
    }
  }

  // Exploded unrouted, then routed row by row: a WABA-level change shared by
  // two stores becomes one row for each of them (routeInboundEvent).
  const rows = explodeWebhook(body, () => null).flatMap((row) => {
    const stores = routeInboundEvent(row, byPhone, byWaba);
    if (stores.length === 0) return [row];
    return stores.map((storeId) => ({ ...row, storeId }));
  });
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
  "smb_message_echoes",
] as const;

/** Within `messages`, the payload kinds a handler exists for. */
export const HANDLED_MESSAGE_KINDS = ["status", "message"] as const;

export interface ProcessResult {
  claimed: number;
  processed: number;
  failed: number;
  /** Failed this time, and claimable again after a backoff. */
  retrying: number;
  /** Held SMS released because Meta reported the WhatsApp failed. */
  smsReleased: number;
}

/** Attempts before an event is given up on (marked processed with its error). */
export const MAX_INBOUND_ATTEMPTS = 5;

/** Minutes before attempt n+1, after attempt n failed. */
const INBOUND_BACKOFF_MINUTES = [1, 5, 15, 60];

/** How long a claim keeps a row from another run, if this one dies. */
const INBOUND_LEASE_MINUTES = 2;

/** Template changes: re-read from Meta, never applied from the payload. */
const TEMPLATE_FIELDS = new Set([
  "message_template_status_update",
  "message_template_quality_update",
  "template_category_update",
]);

/** Number changes: re-read from Meta, then the payload's own wording added. */
const NUMBER_FIELDS = new Set([
  "phone_number_quality_update",
  "phone_number_name_update",
]);

/** Account events whose truth is the account's state at Meta. */
const REFRESH_ACCOUNT_EVENTS = new Set([
  "PARTNER_REMOVED",
  "ACCOUNT_DELETED",
  "VERIFIED_ACCOUNT",
]);

interface ClaimedEvent {
  id: string;
  storeId: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  field: string;
  payload: unknown;
  attempts: number;
  receivedAt: string;
}

/**
 * Process one batch of pending events.
 *
 * ★★ CLAIMED WITH A LEASE, RETRIED WITH BACKOFF. A processing error used to
 * mark the event processed WITH the error, so a connection reset dropped the
 * customer's message, COD tap or STOP for good, and two overlapping runs (the
 * webhook's after() and the heartbeat) could both take one row. Now one
 * statement claims the batch (`FOR UPDATE SKIP LOCKED`, attempts + 1, a short
 * lease in next_attempt_at); success marks it processed; a failure puts it
 * back with a backoff, and only after MAX_INBOUND_ATTEMPTS is it given up on.
 * A run that dies mid-batch leaves its rows to come back when the lease ends.
 */
export async function processPendingInboundEvents(
  limit = 50,
): Promise<ProcessResult> {
  const result: ProcessResult = {
    claimed: 0,
    processed: 0,
    failed: 0,
    retrying: 0,
    smsReleased: 0,
  };

  const claimed = await withService(async (db) => {
    const res = await db.execute(sql`
      update public.whatsapp_inbound_events e
         set attempts = e.attempts + 1,
             next_attempt_at = now() + make_interval(mins => ${INBOUND_LEASE_MINUTES})
       where e.id in (
         select id from public.whatsapp_inbound_events
          where processed_at is null
            and (next_attempt_at is null or next_attempt_at <= now())
            and (field = any(${sql.param([...HANDLED_FIELDS])}::text[])
                 or (field = 'messages'
                     and payload->>'kind' = any(${sql.param([...HANDLED_MESSAGE_KINDS])}::text[])))
          order by received_at
          limit ${limit}
          for update skip locked
       )
      returning e.id, e.store_id, e.waba_id, e.phone_number_id, e.field,
                e.payload, e.attempts, e.received_at
    `);
    return asEventRows(res);
  });
  result.claimed = claimed.length;

  // One Meta re-read per store per batch, however many events asked for it.
  const templateSyncs = new Map<
    string,
    ReturnType<typeof syncWhatsAppTemplates>
  >();
  const accountRefreshes = new Map<
    string,
    ReturnType<typeof refreshWhatsAppAccount>
  >();
  const syncTemplatesOnce = (storeId: string) => {
    let run = templateSyncs.get(storeId);
    if (!run) {
      run = syncWhatsAppTemplates(storeId);
      templateSyncs.set(storeId, run);
    }
    return run;
  };
  const refreshAccountOnce = (storeId: string) => {
    let run = accountRefreshes.get(storeId);
    if (!run) {
      run = refreshWhatsAppAccount(storeId);
      accountRefreshes.set(storeId, run);
    }
    return run;
  };

  for (const ev of claimed) {
    let filed: RecordInboundResult | null = null;
    let marked = false;
    try {
      const value = isRec(ev.payload) ? ev.payload : {};
      const kind = str(value.kind);
      const event = str(value.event);

      // ★★ TEMPLATE AND ACCOUNT CHANGES ARE RE-READ FROM META, NOT APPLIED.
      // Meta redelivers for a week and in no particular order, and a change
      // that names no number has nothing to deduplicate on (the 0174 key is
      // NULL there, and NULLs are distinct), so applying the payload let a
      // late REJECTED overwrite a newer APPROVED and a redelivered
      // PARTNER_REMOVED flip a reconnected account to needs_reauth. A re-read
      // is right whatever order the deliveries come in. Network calls, so
      // they run here, outside any transaction.
      if (ev.storeId && TEMPLATE_FIELDS.has(ev.field)) {
        const synced = await syncTemplatesOnce(ev.storeId);
        if (!synced.ok)
          throw new Error(synced.error ?? "Template sync failed.");
      } else if (
        ev.storeId &&
        (NUMBER_FIELDS.has(ev.field) ||
          (ev.field === "account_update" &&
            event !== null &&
            REFRESH_ACCOUNT_EVENTS.has(event)))
      ) {
        const refreshed = await refreshAccountOnce(ev.storeId);
        const storeId = ev.storeId;
        if (refreshed.ok) {
          // The re-read is the truth; only words Meta's read does not carry
          // (a declined name's reason) are added from the payload.
          if (ev.field === "phone_number_name_update") {
            await withService((db) =>
              applyNameDecision(db, { storeId, value }),
            );
          }
        } else if (ev.field === "account_update") {
          // Meta would not confirm the account works: a removal stands, and
          // a verification is recorded as Meta posted it.
          await withService((db) =>
            applyAccountEvent(db, { storeId, field: ev.field, value }),
          );
        } else {
          throw new Error(refreshed.error);
        }
      } else {
        // ★ Read before the transaction: a failed settings read must never
        // be the reason a customer's message is not filed. Once per TEXT
        // message (an order question, a menu request, or anything Mink may
        // answer); a photo or a sticker never needs the row.
        const text =
          ev.storeId && ev.field === "messages" && kind === "message"
            ? textBodyOf(value)
            : null;
        const flags =
          ev.storeId && text !== null
            ? await loadAutoReplyFlags(ev.storeId)
            : null;
        filed = await withService(
          async (db): Promise<RecordInboundResult | null> => {
            let out: RecordInboundResult | null = null;
            if (ev.storeId && ev.field === "messages" && kind === "message") {
              out = await recordInboundMessage(db, {
                storeId: ev.storeId,
                value,
                answersOrderQuestions: flags?.orderStatus === true,
                hasMenu: flags?.menu === true,
                minkMode: flags?.minkMode ?? "off",
              });
            } else if (ev.storeId && ev.field === "smb_message_echoes") {
              out = await recordEchoMessage(db, {
                storeId: ev.storeId,
                value,
              });
            } else if (ev.storeId && ev.field === "messages") {
              const settled = await applyMessageStatus(db, {
                storeId: ev.storeId,
                value,
              });
              result.smsReleased += settled.smsReleased;
            } else if (ev.storeId) {
              await applyAccountEvent(db, {
                storeId: ev.storeId,
                field: ev.field,
                value,
              });
            }
            await markEventProcessed(db, ev.id);
            return out;
          },
        );
        marked = true;
      }
      if (!marked) {
        await withService((db) => markEventProcessed(db, ev.id));
      }
      result.processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const giveUp = ev.attempts >= MAX_INBOUND_ATTEMPTS;
      logError(
        giveUp
          ? "whatsapp inbound: processing failed, giving up"
          : "whatsapp inbound: processing failed, will retry",
        err,
        { field: ev.field, storeId: ev.storeId, attempts: ev.attempts },
      );
      if (giveUp) result.failed++;
      else result.retrying++;
      await withService((db) =>
        markEventFailed(db, ev.id, ev.attempts, message, giveUp),
      ).catch(() => undefined);
      continue;
    }
    // Answers, media and the bell, once the filing has committed. Never a
    // reason to process the event again: a retry would re-file nothing but
    // would ring the bell twice.
    if (filed && ev.storeId) {
      await afterFiled(ev.storeId, filed).catch((err) =>
        logError("whatsapp inbound: after-filing failed", err, {
          storeId: ev.storeId,
        }),
      );
    }
  }
  return result;
}

/**
 * Process until nothing is due, or the time budget runs out. The heartbeat's
 * drain: the webhook's after() handles the delivery that just arrived, and
 * this catches whatever that missed (an instance recycled after the response,
 * more than one batch pending, a row whose backoff has passed).
 */
export async function drainInboundEvents(
  budgetMs = 20_000,
): Promise<ProcessResult> {
  const total: ProcessResult = {
    claimed: 0,
    processed: 0,
    failed: 0,
    retrying: 0,
    smsReleased: 0,
  };
  const deadline = Date.now() + budgetMs;
  const batch = 50;
  for (;;) {
    const r = await processPendingInboundEvents(batch);
    total.claimed += r.claimed;
    total.processed += r.processed;
    total.failed += r.failed;
    total.retrying += r.retrying;
    total.smsReleased += r.smsReleased;
    if (r.claimed < batch || Date.now() >= deadline) return total;
  }
}

async function markEventProcessed(db: Db, id: string): Promise<void> {
  await db
    .update(whatsappInboundEvents)
    .set({
      processedAt: new Date().toISOString(),
      error: null,
      nextAttemptAt: null,
    })
    .where(eq(whatsappInboundEvents.id, id));
}

async function markEventFailed(
  db: Db,
  id: string,
  attempts: number,
  message: string,
  giveUp: boolean,
): Promise<void> {
  const minutes =
    INBOUND_BACKOFF_MINUTES[
      Math.min(Math.max(attempts, 1), INBOUND_BACKOFF_MINUTES.length) - 1
    ] ?? 60;
  await db.execute(sql`
    update public.whatsapp_inbound_events
       set error = ${message.slice(0, 500)},
           processed_at = ${giveUp ? sql`now()` : sql`null`},
           next_attempt_at = ${giveUp ? sql`null` : sql`now() + make_interval(mins => ${minutes})`}
     where id = ${id}::uuid
  `);
}

function asEventRows(result: unknown): ClaimedEvent[] {
  const rows = (result as { rows?: Rec[] })?.rows ?? [];
  return (
    rows
      .map((r) => ({
        id: String(r.id),
        storeId: str(r.store_id),
        wabaId: str(r.waba_id),
        phoneNumberId: str(r.phone_number_id),
        field: str(r.field) ?? "unknown",
        payload: r.payload,
        attempts: Number(r.attempts ?? 1),
        receivedAt: String(r.received_at ?? ""),
      }))
      // RETURNING keeps no order; a conversation's messages are filed in the
      // order Meta delivered them.
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
  );
}

/** The text of a `text` message, before it is filed. */
function textBodyOf(value: Rec): string | null {
  const message = isRec(value.message) ? value.message : null;
  if (!message || message.type !== "text") return null;
  const text = isRec(message.text) ? message.text : null;
  return str(text?.body);
}

/**
 * What happens once a message is safely on disk: the customer is answered
 * where the system can answer (a STOP or START, a COD tap, the store's
 * automatic replies), its file is copied into our bucket, and, when it needs a
 * person, the team is told. All best-effort: the message is already filed, and
 * none of these is worth retrying the whole event for (a retry would re-file
 * nothing, but would also ring the bell twice).
 *
 * ★ THE ANSWER GOES BEFORE THE FILE COPY. A download can take twenty seconds,
 * and a customer waiting for "thanks, we're closed" should not wait on it.
 */
async function afterFiled(
  storeId: string,
  filed: RecordInboundResult,
): Promise<void> {
  if (!filed.inserted || !filed.conversationId || !filed.messageId) return;
  const conversationId = filed.conversationId;

  // Whether the system could not finish the job and a person must: the
  // needs-reply and the bell that recordInboundMessage held back.
  let handOver = false;

  if (filed.optOut && filed.phone) {
    // A STOP or START that changed the customer's offers consent: tell them
    // it worked. Recorded already; this is only the answer, and never throws.
    await answerOptOut({
      storeId,
      conversationId,
      phone: filed.phone,
      intent: filed.optOut,
    }).catch((err) =>
      logError("whatsapp opt-out: reply failed", err, { storeId }),
    );
  } else if (filed.codReply && filed.phone) {
    // A COD Confirm / Cancel tap: act on it, answer it, and only when that
    // cannot be done (refused, too late, failed) hand it to a person.
    const handled = await handleCodReply({
      storeId,
      conversationId,
      phone: filed.phone,
      contactLabel: filed.contactLabel,
      reply: filed.codReply,
    }).catch((err) => {
      logError("whatsapp cod: handling failed", err, { storeId });
      return { outcome: "failed" as const, needsHuman: true };
    });
    handOver = handled.needsHuman;
  } else if (filed.menuReply && filed.menuReply !== "menu" && filed.phone) {
    // A tap on one of the store's menu buttons: do what the button says, and
    // hand over when it asks for a person or cannot be done (menu-reply.ts).
    const handled = await handleMenuReply({
      storeId,
      conversationId,
      phone: filed.phone,
      userId: filed.userId,
      buttonId: filed.menuReply,
    }).catch((err) => {
      logError("whatsapp menu: handling failed", err, { storeId });
      return { outcome: "failed" as const, needsHuman: true };
    });
    handOver = handled.needsHuman;
  } else if (filed.phone) {
    // The store's own automatic replies: the welcome, the away message, the
    // menu on request, the answer to "where is my order?"
    // (answer-automatically.ts).
    const menuRequest = filed.menuReply === "menu";
    const answered = await answerAutomatically({
      storeId,
      conversationId,
      phone: filed.phone,
      userId: filed.userId,
      kind: filed.kind,
      orderQuestion: filed.orderQuestion,
      welcomeEligible: filed.welcomeEligible,
      menuRequest,
    }).catch((err) => {
      logError("whatsapp auto-replies: failed", err, { storeId });
      return { handOver: filed.orderQuestion || menuRequest, sent: [] };
    });
    handOver = answered.handOver;

    // Customer-facing Mink (mink-answer.ts), after the welcome so a first
    // message reads "hi, thanks for messaging" and then the answer. `helps`
    // was filed as answered by the system, so whatever Mink could not
    // finish hands over here; `drafts` only leaves a draft for the person
    // who already has the message.
    if (filed.minkAnswer && filed.body) {
      const mink = await answerWithMink({
        storeId,
        conversationId,
        messageId: filed.messageId,
        phone: filed.phone,
        userId: filed.userId,
        mode: filed.minkAnswer,
        text: filed.body,
      }).catch((err) => {
        logError("whatsapp mink: failed", err, { storeId });
        return { outcome: "failed" as const, needsHuman: true };
      });
      if (filed.minkAnswer === "helps") handOver = handOver || mink.needsHuman;
    }
  }

  if (filed.media && hasMedia(filed.kind)) {
    await storeInboundMedia({
      storeId,
      conversationId,
      messageId: filed.messageId,
      media: filed.media,
    });
  }

  let ring = filed.needsNotify;
  if (handOver) {
    const moved = await withService(async (db) =>
      handOverConversation(db, storeId, conversationId),
    ).catch((err) => {
      logError("whatsapp inbox: hand-over failed", err, { storeId });
      // Unknown, so ring: a missed hand-over is worse than a second bell.
      return true;
    });
    ring = ring || moved;
  }
  if (!ring) return;
  await recordEvent({
    type: "whatsapp.message_received",
    storeId,
    actor: {
      type: "customer",
      id: filed.userId,
      label: filed.contactLabel,
    },
    subject: {
      type: "whatsapp_conversation",
      id: conversationId,
      label: filed.contactLabel,
    },
    payload: { preview: filed.preview },
  }).catch((err) =>
    logError("whatsapp inbox: notify failed", err, { storeId }),
  );
}

/**
 * Account-level facts Meta's own read does not carry, applied to the row the
 * card reads: a restriction's wording, and a removal or verification when the
 * re-read could not confirm the account's state.
 */
export async function applyAccountEvent(
  db: Db,
  ev: { storeId: string; field: string; value: Rec },
): Promise<void> {
  const v = ev.value;
  const now = new Date().toISOString();
  const event = str(v.event);

  switch (ev.field) {
    // Template and number changes never reach here: they are re-read from
    // Meta (processPendingInboundEvents), never applied from a payload.
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
 * A declined display name's reason, which Meta's number read does not carry,
 * added after the re-read. Only while the name is still not approved: a later
 * approval must not be overwritten by a stale rejection.
 */
async function applyNameDecision(
  db: Db,
  ev: { storeId: string; value: Rec },
): Promise<void> {
  if (str(ev.value.decision) !== "REJECTED") return;
  const requested = str(ev.value.requested_verified_name);
  const reason = str(ev.value.rejection_reason);
  await db
    .update(storeWhatsappAccounts)
    .set({
      lastError: `Display name "${requested ?? ""}" was declined by Meta${reason ? `: ${reason}` : "."}`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(storeWhatsappAccounts.storeId, ev.storeId),
        sql`coalesce(${storeWhatsappAccounts.nameStatus}, '') <> 'APPROVED'`,
      ),
    );
}

/**
 * What a delivery status means for the notification that sent the message
 * (0211): `failed` releases the SMS held behind it and, for a COD
 * confirmation, marks the order 'undelivered'; `delivered` or `read` drops
 * the held SMS. A message the queue never sent (an inbox reply) has no row.
 */
async function settleQueuedMessage(
  db: Db,
  ev: { storeId: string; providerMessageId: string; kind: string },
): Promise<{ smsReleased: number }> {
  const failed = ev.kind === "failed";
  if (!failed && ev.kind !== "delivered" && ev.kind !== "read") {
    return { smsReleased: 0 };
  }
  const rows = await db
    .select({
      id: notificationWhatsappQueue.id,
      buttonPayloads: notificationWhatsappQueue.buttonPayloads,
    })
    .from(notificationWhatsappQueue)
    .where(
      and(
        eq(notificationWhatsappQueue.storeId, ev.storeId),
        eq(notificationWhatsappQueue.providerMessageId, ev.providerMessageId),
      ),
    );
  let smsReleased = 0;
  for (const row of rows) {
    if (!failed) {
      await dropHeldSms(db, row.id);
      continue;
    }
    if (await releaseHeldSms(db, row.id)) smsReleased++;
    const orderId = codOrderFromPayloads(row.buttonPayloads);
    if (orderId) await markCodUndelivered(db, ev.storeId, orderId);
  }
  return { smsReleased };
}

/**
 * ★★ A COD CONFIRMATION META COULD NOT DELIVER WAS NEVER SEEN. `requested`
 * is stamped when Meta ACCEPTS the send; a later `failed` (131026, not a
 * WhatsApp number) used to leave it there, so the sweep reminded and, with
 * auto-cancel on, cancelled and restocked the order as "not confirmed" for a
 * customer who never got the buttons. 'undelivered' takes it out of the
 * sweep. Not when an earlier copy of the message (the first send, before a
 * reminder) did reach them: they saw the buttons then.
 */
async function markCodUndelivered(
  db: Db,
  storeId: string,
  orderId: string,
): Promise<void> {
  const [confirmPayload] = codButtonPayloads(orderId);
  await db.execute(sql`
    update public.orders o
       set cod_confirmation = 'undelivered',
           cod_confirmation_at = now()
     where o.id = ${orderId}::uuid
       and o.store_id = ${storeId}::uuid
       and o.cod_confirmation = 'requested'
       and not exists (
         select 1
           from public.notification_whatsapp_queue q
           join public.whatsapp_logs l
             on l.store_id = q.store_id
            and l.provider_message_id = q.provider_message_id
          where q.store_id = ${storeId}::uuid
            and q.button_payloads @> jsonb_build_array(${confirmPayload}::text)
            and l.status in ('delivered', 'read')
       )
  `);
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
): Promise<{ smsReleased: number }> {
  const none = { smsReleased: 0 };
  const status = isRec(ev.value.status) ? ev.value.status : null;
  if (!status) return none;
  const messageId = str(status.id);
  const kind = str(status.status)?.toLowerCase();
  if (!messageId || !kind) return none;

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
      return none;
  }

  // The thread's copy of the same message, when the inbox filed one.
  await applyStatusToMessage(db, {
    storeId: ev.storeId,
    providerMessageId: messageId,
    status: kind,
    error: set.error ?? null,
  });

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

  // After the log moved, so the COD check below sees this status.
  return settleQueuedMessage(db, {
    storeId: ev.storeId,
    providerMessageId: messageId,
    kind,
  });
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
