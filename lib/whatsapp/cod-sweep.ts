import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { notificationWhatsappQueue, orders } from "@/drizzle/schema";
import { approveCancellation } from "@/lib/orders/approve-cancellation";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";
import { logError, logInfo } from "@/lib/observability/logger";
import { codButtonPayloads } from "./cod-payload";

// ---------------------------------------------------------------------------
// Following up a cash-on-delivery confirmation nobody answered (plan §16
// Phase 2). Run by the hourly order sweep (/api/cron/expire-pending-payments).
//
//   24 h after the message: send it once more (whatsapp.codReminder, on by
//        default once confirmation is on). The SAME approved template with
//        the same buttons, copied from the queue row that went out, so it
//        needs no new Meta approval and the worker re-checks consent and the
//        template's approval at send time.
//   48 h after the message: cancel the order (whatsapp.codAutoCancel, OFF by
//        default), through the one cancellation, nothing refunded (nothing was
//        paid), and mark it 'expired' so the order list says "Not confirmed on
//        WhatsApp" rather than that the customer cancelled. The cancellation's
//        own claim writes 'expired', in the statement that cancels it.
//
// ★ ONLY ORDERS STILL PENDING. An order the shop has moved on is one the shop
// has decided to ship; reminding or cancelling it would overrule them.
//
// ★ ONLY ORDERS STILL AWAITING AN ANSWER: `requested`, never `undelivered`.
// Meta reporting the message failed means the customer never saw the
// buttons, so "not confirmed" says nothing about what they want.
//
// ★★ ONLY WHILE THE NUMBER IS CONNECTED AND SWITCHED ON. Both actions assume
// the customer's tap can reach us and be answered. After Disconnect (row
// deleted, our app unsubscribed from the WABA) a tap never arrives; with
// `needs_reauth` the token is dead and Meta may have stopped posting to us;
// while paused the merchant has switched WhatsApp off, a tap cannot be
// answered and the worker refuses the reminder (spending its one claim).
// Cancelling an order as "not confirmed" then cancels customers who had no
// fair chance to confirm, and Disconnect also hides the switch that would
// stop it. Skipped instead: an order kept can still be cancelled by hand,
// and resuming inside the window lets the sweep carry on.
//
// ★ EACH ACTION HAS A 24-HOUR WINDOW, not "everything older than". The sweep
// runs hourly, so 24 hours is plenty to be seen, and a store switching the
// setting on never has last week's orders reminded or cancelled at once.
//
// ★ EXACTLY ONCE, BY CLAIM. The reminder claims cod_reminded_at in the same
// transaction that queues the resend; the cancellation's claim is
// approveCancellation's own status claim, guarded by `onlyWhileCodAwaited`,
// so a customer who taps Confirm just before the sweep keeps the order.
// ---------------------------------------------------------------------------

export const COD_REMINDER_AFTER_HOURS = 24;
export const COD_AUTO_CANCEL_AFTER_HOURS = 48;
/** How long after its moment each action may still happen. */
export const COD_FOLLOWUP_WINDOW_HOURS = 24;
const BATCH = 50;

export interface CodSweepResult {
  reminded: number;
  cancelled: number;
  failed: number;
}

type Candidate = {
  id: string;
  store_id: string;
  customer_id: string | null;
};

/** Orders awaiting an answer whose message went `afterHours` to
 *  `afterHours + window` ago, in stores where `setting` is on and the
 *  WhatsApp number is connected and switched on. */
async function candidates(
  afterHours: number,
  setting: "whatsapp.codReminder" | "whatsapp.codAutoCancel",
  extra: "not_reminded" | null,
): Promise<Candidate[]> {
  // The setting is read straight off stores.settings so the whole selection is
  // one indexed query. `=` / `IS DISTINCT FROM` on jsonb rather than a cast:
  // a stored value of the wrong type is simply "not on", never an error that
  // stops every store's follow-up.
  const settingOn =
    setting === "whatsapp.codReminder"
      ? sql`(s.settings -> 'features' -> 'whatsapp.codReminder') is distinct from 'false'::jsonb`
      : sql`(s.settings -> 'features' -> 'whatsapp.codAutoCancel') = 'true'::jsonb`;
  // The account join is in the SQL, before the LIMIT: filtered afterwards, a
  // disconnected store's orders would fill every batch for a day.
  const rows = await withService((db) =>
    db.execute<Candidate>(sql`
      select o.id, o.store_id, o.customer_id
        from public.orders o
        join public.stores s on s.id = o.store_id
        join public.store_whatsapp_accounts a on a.store_id = o.store_id
       where o.cod_confirmation = 'requested'
         and o.status = 'pending'
         and a.status = 'connected'
         and a.enabled
         and o.cod_confirmation_at <= now() - make_interval(hours => ${afterHours})
         and o.cod_confirmation_at > now() - make_interval(hours => ${afterHours + COD_FOLLOWUP_WINDOW_HOURS})
         and (s.settings -> 'features' -> 'whatsapp.codConfirmation') = 'true'::jsonb
         and ${settingOn}
         ${extra === "not_reminded" ? sql`and o.cod_reminded_at is null` : sql``}
       order by o.cod_confirmation_at
       limit ${BATCH}
    `),
  );
  return rows.rows;
}

/** Claim the one reminder and queue a copy of the message that went out.
 *  True when a resend was queued. */
async function remind(order: Candidate): Promise<boolean> {
  const [confirmPayload] = codButtonPayloads(order.id);
  return withService(async (db) => {
    const claimed = await db
      .update(orders)
      .set({ codRemindedAt: sql`now()` })
      .where(
        and(
          eq(orders.id, order.id),
          eq(orders.storeId, order.store_id),
          isNull(orders.codRemindedAt),
          eq(orders.codConfirmation, "requested"),
          eq(orders.status, "pending"),
        ),
      )
      .returning({ id: orders.id });
    if (claimed.length === 0) return false;

    // The row that carried this order's buttons and was SENT: same phone,
    // template, values and payloads. Without one there is nothing to repeat;
    // the claim stands so the sweep does not look again every hour.
    const original = await db.execute<{
      event_id: string | null;
      recipient_id: string;
      recipient_type: string;
      phone: string;
      event_key: string;
      audience: string;
      template_id: string;
      values: unknown;
      button_payloads: unknown;
    }>(sql`
      select event_id, recipient_id, recipient_type, phone, event_key,
             audience, template_id, values, button_payloads
        from public.notification_whatsapp_queue
       where store_id = ${order.store_id}::uuid
         and status = 'sent'
         and button_payloads @> ${JSON.stringify([confirmPayload])}::jsonb
       order by created_at desc
       limit 1
    `);
    const row = original.rows[0];
    if (!row) {
      logInfo("whatsapp cod: no sent message to repeat", {
        storeId: order.store_id,
      });
      return false;
    }
    await db.insert(notificationWhatsappQueue).values({
      storeId: order.store_id,
      eventId: row.event_id,
      recipientId: row.recipient_id,
      recipientType: row.recipient_type,
      phone: row.phone,
      eventKey: row.event_key,
      audience: row.audience,
      templateId: row.template_id,
      values: row.values ?? [],
      buttonPayloads: row.button_payloads,
    });
    return true;
  });
}

/** Cancel an order nobody confirmed. True when cancelled.
 *  ★ No label write here: `onlyWhileCodAwaited` makes the cancellation's own
 *  claim set 'expired', so a Confirm tap handled while the rest of the
 *  cancellation runs already reads 'expired' and goes to a person. */
async function autoCancel(order: Candidate): Promise<boolean> {
  const res = await approveCancellation({
    storeId: order.store_id,
    orderId: order.id,
    actorId: null,
    actorLabel: "Not confirmed on WhatsApp",
    customerId: order.customer_id,
    // Cash on delivery: nothing was paid, so nothing moves.
    refundDestination: "later",
    reasonCode: "not_confirmed",
    restock: true,
    notify: true,
    bySystem: true,
    onlyWhileCodAwaited: true,
    // A cron: the customer's "your order was cancelled" must be recorded
    // before the response, not left to after().
    notifyInline: true,
  });
  return res.success === true;
}

/** One pass: reminders, then cancellations. Never throws. */
export async function sweepCodConfirmations(): Promise<CodSweepResult> {
  const result: CodSweepResult = { reminded: 0, cancelled: 0, failed: 0 };

  const toRemind = await candidates(
    COD_REMINDER_AFTER_HOURS,
    "whatsapp.codReminder",
    "not_reminded",
  ).catch((err) => {
    logError("whatsapp cod: reminder read failed", err);
    result.failed++;
    return [] as Candidate[];
  });
  for (const order of toRemind) {
    try {
      if (await remind(order)) result.reminded++;
    } catch (err) {
      result.failed++;
      logError("whatsapp cod: reminder failed", err, {
        storeId: order.store_id,
      });
    }
  }

  const toCancel = await candidates(
    COD_AUTO_CANCEL_AFTER_HOURS,
    "whatsapp.codAutoCancel",
    null,
  ).catch((err) => {
    logError("whatsapp cod: auto-cancel read failed", err);
    result.failed++;
    return [] as Candidate[];
  });
  for (const order of toCancel) {
    try {
      if (await autoCancel(order)) result.cancelled++;
    } catch (err) {
      result.failed++;
      logError("whatsapp cod: auto-cancel failed", err, {
        storeId: order.store_id,
      });
    }
  }

  // The resends wait in the WhatsApp queue; drain it now rather than at the
  // next heartbeat.
  if (result.reminded > 0) await triggerEmailWorker().catch(() => undefined);
  if (result.reminded + result.cancelled + result.failed > 0) {
    logInfo("whatsapp cod: follow-up swept", { ...result });
  }
  return result;
}
