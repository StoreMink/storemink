import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import {
  loadWhatsAppSender,
  loadWhatsAppTemplateById,
  whatsAppConsentFor,
} from "./channel";
import { sendWhatsAppTemplate } from "./send";
import { codOrderFromPayloads } from "./cod-payload";
import { markCodConfirmationRequested } from "./cod-confirmation";
import { fileTemplateInThread } from "./inbox";
import { renderWhatsAppBody } from "./template-catalog";
import { markNeedsReauth } from "./templates";
import { releaseHeldSms } from "./sms-fallback";
import { textablePhone } from "@/lib/phone";

// ---------------------------------------------------------------------------
// Draining notification_whatsapp_queue — lib/sms/worker.ts's shape, with the
// same rule at its centre:
//
// ── ★★ AN UNKNOWN OUTCOME IS NOT RETRIED ───────────────────────────────────
// `rejected` is Meta's verdict — not a WhatsApp number, a template that is no
// longer approved, a parameter it refuses — and retrying most of those just
// repeats the refusal. `unknown` is a timeout or a 5xx, where the message MAY
// HAVE GONE, and retrying it sends somebody the same update twice. A phone
// buzzing twice is worse than once (§26, §37).
//
// ★ ONLY A THROTTLE IS RETRIED. Meta's rate-limit codes mean "not now", and
// provably nothing went; every other rejection is terminal, because a number
// that is not on WhatsApp is still not on WhatsApp in five minutes.
//
// ★ OUR OWN READ FAILING IS NOT A VERDICT. A database blip while loading the
// sender, the template or the consent says nothing about the message, so the
// row is requeued with the same backoff instead of being settled as "not
// connected" or "not opted in" (which, under whatsapp_first, used to cost the
// customer their SMS as well).
//
// ★ EVERY DEFINITE FAILURE RELEASES THE HELD SMS (0211, sms-fallback.ts); an
// unknown outcome keeps it held, because the WhatsApp may have arrived.
// ---------------------------------------------------------------------------

/** Meta's "the access token is no longer valid" (expired, revoked, removed). */
export const TOKEN_INVALID_CODE = 190;

/** 5 / 15 / 45 minutes, matching the email and SMS workers' backoff. */
const BACKOFF_MINUTES = [5, 15, 45];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length;
const BATCH = 50;

/** Meta error codes that mean "try later" rather than "no". */
export const RETRYABLE_META_CODES = new Set([
  4, // API too many calls
  80007, // rate limit
  130429, // cloud API rate limit
  131048, // spam rate limit
  131056, // pair rate limit
  131000, // generic "something went wrong" — Meta's own docs say retry
]);

export interface WhatsAppWorkerResult {
  claimed: number;
  sent: number;
  failed: number;
  /** Sends whose outcome Meta never confirmed. Never retried. */
  unknown: number;
  skipped: number;
  /** Held SMS released because the WhatsApp could not be sent. */
  smsReleased: number;
  /** Rows put back because one of our own reads failed. */
  requeued: number;
}

export async function runWhatsAppWorker(): Promise<WhatsAppWorkerResult> {
  const result: WhatsAppWorkerResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    smsReleased: 0,
    requeued: 0,
  };

  // ★ FOR UPDATE SKIP LOCKED: two overlapping runs take different rows rather
  // than both sending the same message.
  const claimed = await withService(async (db) => {
    const rows = await db.execute(sql`
      update public.notification_whatsapp_queue q
         set status = 'sending', attempts = attempts + 1
       where q.id in (
         select id from public.notification_whatsapp_queue
          where status = 'pending'
            and next_attempt_at <= now()
          order by created_at
          limit ${BATCH}
          for update skip locked
       )
      returning q.id, q.store_id, q.recipient_id, q.recipient_type, q.phone,
                q.event_key, q.audience, q.template_id, q.values,
                q.button_payloads, q.attempts
    `);
    return asRows(rows) as QueueRow[];
  }).catch((err) => {
    logError("whatsapp worker: claim failed", err);
    return [] as QueueRow[];
  });

  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  // Sender and templates are per STORE, resolved once per store per batch.
  const senders = new Map<
    string,
    Awaited<ReturnType<typeof loadWhatsAppSender>>
  >();
  const templatesById = new Map<
    string,
    Awaited<ReturnType<typeof loadWhatsAppTemplateById>>
  >();

  // A definite failure: settle the row and let its held SMS go instead.
  const fail = async (row: QueueRow, error: string) => {
    await settle(row.id, "failed", error);
    if (await release(row.id)) result.smsReleased++;
  };

  for (const row of claimed) {
    const storeId = row.store_id;
    let sender: Awaited<ReturnType<typeof loadWhatsAppSender>>;
    let template: Awaited<ReturnType<typeof loadWhatsAppTemplateById>>;
    let consented = true;
    try {
      if (!senders.has(storeId)) {
        senders.set(
          storeId,
          await withService((db) =>
            loadWhatsAppSender(db, storeId, { strict: true }),
          ),
        );
      }
      sender = senders.get(storeId) ?? null;

      // ★ CONSENT IS RE-CHECKED AT SEND, NOT ONLY AT ENQUEUE. A customer can
      // opt out between an order being placed and the queue draining, and the
      // message that arrives after they opted out is the one that gets
      // reported as spam. Staff need no opt-in (plan §8).
      const to = textablePhone(row.phone);
      if (sender && to && row.audience === "customer") {
        const consent = await withService((db) =>
          whatsAppConsentFor(db, storeId, [to], { strict: true }),
        );
        consented = consent.get(to)?.updates === true;
      }

      // ★ RE-READ BY ID, so a template Meta paused or rejected since enqueue
      // is not sent, and what goes out is exactly the template that was
      // queued: an event can carry two wordings (COD confirmation beside
      // order-placed), so re-reading by event and audience could swap one
      // for the other.
      const tKey = `${storeId}:${row.template_id}`;
      if (sender && !templatesById.has(tKey)) {
        templatesById.set(
          tKey,
          await withService((db) =>
            loadWhatsAppTemplateById(db, storeId, row.template_id, {
              strict: true,
            }),
          ),
        );
      }
      template = templatesById.get(tKey) ?? null;
    } catch (err) {
      logError("whatsapp worker: a read failed; row requeued", err, {
        storeId,
        id: row.id,
      });
      if (row.attempts < MAX_ATTEMPTS) {
        await requeue(row.id, row.attempts, "A database read failed.");
        result.requeued++;
      } else {
        await fail(row, "A database read kept failing.");
        result.failed++;
      }
      continue;
    }

    if (!sender) {
      // Disconnected, paused or lapsed since this was queued. Not retryable:
      // the merchant made that choice, and it will not resolve itself.
      await fail(row, "WhatsApp is not connected for this store.");
      result.failed++;
      continue;
    }

    const to = textablePhone(row.phone);
    if (!to) {
      await fail(row, "No textable phone number.");
      result.skipped++;
      continue;
    }
    if (!consented) {
      await fail(row, "The customer has not opted in to WhatsApp updates.");
      result.skipped++;
      continue;
    }
    if (!template) {
      await fail(
        row,
        "The WhatsApp template for this notification is no longer approved.",
      );
      result.failed++;
      continue;
    }

    const out = await sendWhatsAppTemplate({
      storeId,
      to,
      token: sender.token,
      phoneNumberId: sender.phoneNumberId,
      template: {
        id: template.id,
        name: template.name,
        language: template.language,
        body: template.body,
      },
      values: Array.isArray(row.values) ? row.values.map(String) : [],
      ...(Array.isArray(row.button_payloads)
        ? { buttonPayloads: row.button_payloads.map(String) }
        : {}),
      eventKey: row.event_key,
      category: "UTILITY",
    });

    if (out.sent) {
      // Meta's id on the row, so a later `failed` or `delivered` status can
      // release or drop the SMS held behind it (inbound.ts).
      await settle(row.id, "sent", undefined, out.messageId);
      result.sent++;
      // The order now shows "awaiting confirmation" — only once the message
      // with the buttons has really gone, never merely because it was queued.
      const codOrderId = codOrderFromPayloads(row.button_payloads);
      if (codOrderId) await markCodConfirmationRequested(storeId, codOrderId);
      // ★ FILED IN THE CUSTOMER'S THREAD, quietly (slice 6): staff see the
      // update the customer replies to, and the welcome no longer greets that
      // reply as a first message. Customers only: a team alert is addressed
      // to staff, who have no conversation. Best effort, after the send.
      if (row.audience === "customer") {
        const values = Array.isArray(row.values) ? row.values.map(String) : [];
        await withService((db) =>
          fileTemplateInThread(db, {
            storeId,
            phone: to,
            templateId: template.id,
            body: renderWhatsAppBody(template.body, values),
            providerMessageId: out.messageId,
          }),
        ).catch((err) =>
          logError("whatsapp worker: thread filing failed", err, {
            storeId,
            id: row.id,
          }),
        );
      }
      continue;
    }

    if (out.outcome === "unknown") {
      // ★ TERMINAL, deliberately. The message may have gone.
      await settle(row.id, "failed", `Unconfirmed: ${out.error}`);
      result.unknown++;
      continue;
    }

    if (out.outcome === "skipped") {
      await fail(row, out.error);
      result.skipped++;
      continue;
    }

    // ★★ A DEAD TOKEN IS NOT ONE MESSAGE'S PROBLEM. Without a
    // PARTNER_REMOVED webhook nothing else notices, so the account stayed
    // "connected", every notification kept choosing WhatsApp and failing, and
    // the card said all was well. Flip it, and stop using it for this batch.
    if (out.code === TOKEN_INVALID_CODE) {
      await markNeedsReauth(
        storeId,
        "Meta no longer accepts this connection. Reconnect WhatsApp in Channels.",
      );
      senders.set(storeId, null);
    }

    // A rejection provably did not send. Only a throttle is worth asking again.
    if (
      out.code !== undefined &&
      RETRYABLE_META_CODES.has(out.code) &&
      row.attempts < MAX_ATTEMPTS
    ) {
      await requeue(row.id, row.attempts, out.error);
    } else {
      await fail(row, out.error);
    }
    result.failed++;
  }

  logInfo("whatsapp worker ran", { ...result });
  return result;
}

async function settle(
  id: string,
  status: "sent" | "failed",
  error?: string,
  providerMessageId?: string | null,
): Promise<void> {
  try {
    await withService((db) =>
      db.execute(sql`
        update public.notification_whatsapp_queue
           set status = ${status},
               error = ${error ?? null},
               sent_at = ${status === "sent" ? sql`now()` : sql`null`},
               provider_message_id = ${providerMessageId ?? null}
         where id = ${id}::uuid
      `),
    );
  } catch (err) {
    // The message went; only the bookkeeping failed. Logged rather than
    // retried, because a retry here would re-SEND it.
    logError("whatsapp worker: settle failed", err, { id, status });
  }
}

/** Release the row's held SMS, if any. Never throws into the batch. */
async function release(id: string): Promise<boolean> {
  try {
    return await withService((db) => releaseHeldSms(db, id));
  } catch (err) {
    logError("whatsapp worker: releasing the held SMS failed", err, { id });
    return false;
  }
}

async function requeue(
  id: string,
  attempts: number,
  error: string,
): Promise<void> {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, MAX_ATTEMPTS) - 1] ?? 45;
  try {
    await withService((db) =>
      db.execute(sql`
        update public.notification_whatsapp_queue
           set status = 'pending',
               error = ${error},
               next_attempt_at = now() + (${minutes} || ' minutes')::interval
         where id = ${id}::uuid
      `),
    );
  } catch (err) {
    logError("whatsapp worker: requeue failed", err, { id });
  }
}

interface QueueRow {
  id: string;
  store_id: string;
  recipient_id: string;
  recipient_type: string;
  phone: string;
  event_key: string;
  audience: string;
  template_id: string;
  values: unknown;
  button_payloads: unknown;
  attempts: number;
}

function asRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return ((result as { rows?: unknown[] })?.rows ?? []) as unknown[];
}
