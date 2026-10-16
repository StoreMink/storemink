import "server-only";

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// The SMS held behind a WhatsApp message (migration 0211).
//
// Under `whatsapp.updatePrecedence = whatsapp_first` a customer reachable on
// both channels gets the WhatsApp message. The SMS they would otherwise have
// had is not thrown away: the fan-out (lib/notifications/record.ts) stores it
// on the WhatsApp queue row as `held`, and its fate follows the WhatsApp's:
//
//   • the send fails (any terminal refusal in the worker) or Meta later posts
//     `failed` for it      → RELEASED into notification_sms_queue, once;
//   • Meta posts `delivered` or `read` → DROPPED.
//
// ★ AN UNKNOWN OUTCOME KEEPS IT HELD. A timeout or a 5xx may have delivered
// the WhatsApp, and a customer getting the same update twice is the thing the
// precedence setting exists to prevent (§26's rule for retries, reused).
//
// ★ EXACTLY ONCE, BY A CONDITIONAL CLAIM. Release is one statement: the state
// moves held → released and the SMS row is inserted from the same RETURNING,
// so a worker and a status webhook racing on one row release it once, and a
// release and a drop racing leave whichever claimed first.
// ---------------------------------------------------------------------------

/** What the fan-out holds: exactly the SMS queue row it would have queued. */
export interface HeldSms {
  recipientId: string;
  recipientType: string;
  phone: string;
  eventKey: string;
  values: string[];
}

/** The held copy of an SMS queue row the fan-out built. */
export function heldSmsFrom(row: {
  recipientId: string;
  recipientType: string;
  phone: string;
  eventKey: string;
  values?: unknown;
}): HeldSms {
  return {
    recipientId: row.recipientId,
    recipientType: row.recipientType,
    phone: row.phone,
    eventKey: row.eventKey,
    values: Array.isArray(row.values) ? row.values.map(String) : [],
  };
}

/**
 * Release a WhatsApp row's held SMS into the SMS queue. True when this call
 * released it (false: nothing held, or already released or dropped).
 */
export async function releaseHeldSms(
  db: Db,
  queueId: string,
): Promise<boolean> {
  const res = await db.execute(sql`
    with claimed as (
      update public.notification_whatsapp_queue
         set fallback_state = 'released',
             fallback_settled_at = now()
       where id = ${queueId}::uuid
         and fallback_state = 'held'
       returning store_id, event_id, fallback_sms
    )
    insert into public.notification_sms_queue
      (store_id, event_id, recipient_id, recipient_type, phone, event_key, values)
    select store_id, event_id,
           fallback_sms->>'recipientId',
           fallback_sms->>'recipientType',
           fallback_sms->>'phone',
           fallback_sms->>'eventKey',
           coalesce(fallback_sms->'values', '[]'::jsonb)
      from claimed
     where coalesce(fallback_sms->>'phone', '') <> ''
       and coalesce(fallback_sms->>'recipientId', '') <> ''
       and coalesce(fallback_sms->>'recipientType', '') <> ''
       and coalesce(fallback_sms->>'eventKey', '') <> ''
    returning id
  `);
  return rowCount(res) > 0;
}

/** Drop a WhatsApp row's held SMS: the WhatsApp reached the customer. */
export async function dropHeldSms(db: Db, queueId: string): Promise<boolean> {
  const res = await db.execute(sql`
    update public.notification_whatsapp_queue
       set fallback_state = 'dropped',
           fallback_settled_at = now()
     where id = ${queueId}::uuid
       and fallback_state = 'held'
    returning id
  `);
  return rowCount(res) > 0;
}

function rowCount(result: unknown): number {
  const rows = (result as { rows?: unknown[] })?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}
