import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import {
  loadWhatsAppSender,
  loadWhatsAppTemplates,
  whatsAppConsentFor,
} from "./channel";
import { sendWhatsAppTemplate } from "./send";
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
// ---------------------------------------------------------------------------

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
}

export async function runWhatsAppWorker(): Promise<WhatsAppWorkerResult> {
  const result: WhatsAppWorkerResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
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
                q.event_key, q.audience, q.template_id, q.values, q.attempts
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
  const templateSets = new Map<
    string,
    Awaited<ReturnType<typeof loadWhatsAppTemplates>>
  >();

  for (const row of claimed) {
    const storeId = row.store_id;
    if (!senders.has(storeId)) {
      senders.set(
        storeId,
        await withService((db) => loadWhatsAppSender(db, storeId)),
      );
    }
    const sender = senders.get(storeId);
    if (!sender) {
      // Disconnected, paused or lapsed since this was queued. Not retryable:
      // the merchant made that choice, and it will not resolve itself.
      await settle(
        row.id,
        "failed",
        "WhatsApp is not connected for this store.",
      );
      result.failed++;
      continue;
    }

    const to = textablePhone(row.phone);
    if (!to) {
      await settle(row.id, "failed", "No textable phone number.");
      result.skipped++;
      continue;
    }

    // ★ CONSENT IS RE-CHECKED AT SEND, NOT ONLY AT ENQUEUE. A customer can opt
    // out between an order being placed and the queue draining, and the
    // message that arrives after they opted out is the one that gets reported
    // as spam. Staff need no opt-in (plan §8).
    if (row.audience === "customer") {
      const consent = await withService((db) =>
        whatsAppConsentFor(db, storeId, [to]),
      );
      if (!consent.get(to)?.updates) {
        await settle(
          row.id,
          "failed",
          "The customer has not opted in to WhatsApp updates.",
        );
        result.skipped++;
        continue;
      }
    }

    const tKey = `${storeId}:${row.event_key}`;
    if (!templateSets.has(tKey)) {
      templateSets.set(
        tKey,
        await withService((db) =>
          loadWhatsAppTemplates(db, storeId, row.event_key),
        ),
      );
    }
    const template = templateSets.get(tKey)?.get(row.audience);
    // Re-read, so a template Meta paused or rejected since enqueue is not
    // sent — and so the id queued matches the one still approved.
    if (!template || template.id !== row.template_id) {
      await settle(
        row.id,
        "failed",
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
      eventKey: row.event_key,
      category: "UTILITY",
    });

    if (out.sent) {
      await settle(row.id, "sent");
      result.sent++;
      continue;
    }

    if (out.outcome === "unknown") {
      // ★ TERMINAL, deliberately. The message may have gone.
      await settle(row.id, "failed", `Unconfirmed: ${out.error}`);
      result.unknown++;
      continue;
    }

    if (out.outcome === "skipped") {
      await settle(row.id, "failed", out.error);
      result.skipped++;
      continue;
    }

    // A rejection provably did not send. Only a throttle is worth asking again.
    if (
      out.code !== undefined &&
      RETRYABLE_META_CODES.has(out.code) &&
      row.attempts < MAX_ATTEMPTS
    ) {
      await requeue(row.id, row.attempts, out.error);
    } else {
      await settle(row.id, "failed", out.error);
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
): Promise<void> {
  try {
    await withService((db) =>
      db.execute(sql`
        update public.notification_whatsapp_queue
           set status = ${status},
               error = ${error ?? null},
               sent_at = ${status === "sent" ? sql`now()` : sql`null`}
         where id = ${id}::uuid
      `),
    );
  } catch (err) {
    // The message went; only the bookkeeping failed. Logged rather than
    // retried, because a retry here would re-SEND it.
    logError("whatsapp worker: settle failed", err, { id, status });
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
  attempts: number;
}

function asRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return ((result as { rows?: unknown[] })?.rows ?? []) as unknown[];
}
