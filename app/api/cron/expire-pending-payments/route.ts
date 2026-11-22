import { NextResponse } from "next/server";
import { and, asc, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orders } from "@/drizzle/schema";
import {
  lookupStoreGateway,
  type StoreGatewayLookup,
} from "@/lib/payments/provider";
import { sweepExpiredHolds } from "@/lib/inventory/reservations";
import {
  sweepExpiredPickups,
  sweepPickupReminders,
} from "@/lib/fulfilment/pickup";
import { settleOrderPayment } from "@/lib/payments/capture";
import { sweepPendingRefunds } from "@/lib/payments/refund-reconcile";
import { markOrderPaid } from "@/lib/orders/mark-paid";
import {
  confirmYoungPendingOrders,
  expectedGatewayPaise,
  expireUnpaidOrder,
  PAYMENT_GRACE_MINUTES,
  pendingOrderColumns,
  refusedReadReason,
  settlePendingOrder,
  type PendingOnlineOrder,
} from "@/lib/orders/pending-payments";
import { sweepCodConfirmations } from "@/lib/whatsapp/cod-sweep";

// Reaper for online-payment orders stuck in `payment_status: 'pending'` —
// v1 has no merchant webhooks (reconcile-on-read instead), so this scheduled
// job is the safety net for shoppers who paid but never triggered
// confirmOnlinePayment, and for orders whose payment simply never happened.
// Cloud Scheduler runs it hourly at :30 (docs/cron-jobs.md); it's only a
// backstop, since the success page reconciles a real payment instantly.
//
// First it confirms YOUNG orders whose money has landed
// (`confirmYoungPendingOrders`, also run every few minutes by the
// confirm-payments job). Then, for each razorpay order pending longer than the
// grace window:
//   1. Ask Razorpay first — a CAPTURED payment means the money was taken:
//      mark the order paid (never lose a paid order). An AUTHORIZED payment
//      of the exact amount is captured first, so a store whose Razorpay
//      account captures manually does not lose it.
//   2. Otherwise atomically claim the pending → failed transition, then run
//      the shared cancellation cleanup (stock back at the location that
//      reserved it, spent store credit reinstated, pickup holds released),
//      release the coupon use and the offer uses, and cancel the order
//      (`expireUnpaidOrder`, lib/orders/pending-payments.ts). An order whose
//      gateway cannot be READ is left alone rather than cancelled, for up to
//      a week.
//   3. Look again at orders it expired in the last three days: a payment that
//      landed after expiry is recorded so it can be refunded, never lost.
//
// It ALSO cancels pickups nobody collected (Phase F), follows up WhatsApp
// cash-on-delivery confirmations nobody answered, and sweeps expired stock
// holds (roadmap Phase E). Same job because it is
// the same shape of problem — units set aside for something that never
// completed — and a hold nobody ends would make stock unsellable forever.
// Independent of the payment work below: the sweep runs even when there are no
// pending orders, and a failure in one must not skip the other.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` (Cloud Scheduler sends it).

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// The grace period itself (45 minutes) is PAYMENT_GRACE_MINUTES in
// lib/orders/pending-payments.ts, shared with the checks that settle a
// store's waiting orders before its Razorpay account changes.
const BATCH_LIMIT = 200;

/** How long an order whose gateway cannot be READ is left alone before it is
 *  expired anyway. A read failure says nothing about whether the shopper
 *  paid, so the order waits; but a key that stays undecryptable for a week
 *  is a broken connection, and stock cannot be held hostage for ever. */
const UNREADABLE_GATEWAY_GRACE_MS = 7 * 24 * 60 * 60_000;

/** How far back to look for a payment that landed AFTER its order expired. */
const LATE_PAYMENT_WINDOW_MS = 3 * 24 * 60 * 60_000;
const LATE_PAYMENT_BATCH = 100;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ★ MONEY FIRST. Young orders whose payment has landed are confirmed before
  // anything is cancelled. The frequent confirm-payments job does this every
  // few minutes; running it here too means it still happens hourly on an
  // environment where that job was never scheduled.
  const confirmed = await confirmYoungPendingOrders();

  const cutoff = new Date(
    Date.now() - PAYMENT_GRACE_MINUTES * 60_000,
  ).toISOString();

  let pending: PendingOnlineOrder[];
  try {
    pending = await withService((db) =>
      db
        .select(pendingOrderColumns)
        .from(orders)
        .where(
          and(
            eq(orders.paymentMethod, "razorpay"),
            eq(orders.paymentStatus, "pending"),
            lte(orders.createdAt, cutoff),
          ),
        )
        .orderBy(asc(orders.createdAt))
        .limit(BATCH_LIMIT),
    );
  } catch (err) {
    console.error(
      "expire-pending-payments (read):",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "read failed" }, { status: 500 });
  }
  if (!pending.length) {
    // The standing sweeps run even with no pending payments: money going OUT,
    // uncollected pickups and unanswered COD confirmations are different
    // queues from money coming in, and a store can easily have one of them
    // and not one unpaid order.
    return NextResponse.json({
      ok: true,
      paid: confirmed.paid,
      expired: 0,
      ...(await standingSweeps()),
    });
  }

  // One gateway lookup (and decrypt) per store, not per order.
  const gateways = new Map<string, StoreGatewayLookup>();
  const gatewayFor = async (storeId: string) => {
    if (!gateways.has(storeId)) {
      gateways.set(storeId, await lookupStoreGateway(storeId));
    }
    return gateways.get(storeId)!;
  };

  let paid = 0;
  let expired = 0;
  // Captured at the gateway, not yet marked paid here: reported, never expired.
  let unrecorded = 0;

  for (const order of pending) {
    // 1. Razorpay is the source of truth: never cancel a paid order.
    if (order.razorpay_order_id) {
      const lookup = await gatewayFor(order.store_id);
      const ageMs =
        Date.now() - new Date(order.created_at ?? Date.now()).getTime();
      if (lookup.status === "error") {
        // ★★ COULD NOT READ IS NOT "NOT CONNECTED". This used to fall through
        // to expiry, so a database blip or a rotated decryption key cancelled
        // orders whose shoppers had paid. Leave the order alone unless the
        // connection has stayed unreadable for a week.
        if (ageMs < UNREADABLE_GATEWAY_GRACE_MS) continue;
        console.error(
          `expire-pending-payments (gateway unreadable for a week, order ${order.id})`,
        );
      } else if (lookup.status === "connected") {
        // ★ ONE IMPLEMENTATION (lib/orders/pending-payments.ts): a captured
        // payment marks the order paid through `markOrderPaid` (an AUTHORIZED
        // one of the exact amount is captured first, for accounts that
        // capture manually); with no payment the order is cancelled and
        // everything it held is given back.
        const outcome = await settlePendingOrder(order, lookup.gateway.creds, {
          expire: "after_grace",
        });
        if (outcome === "paid") paid++;
        if (outcome === "expired") expired++;
        if (outcome === "paid" || outcome === "expired") continue;
        // The claim lost to a payment recorded a moment ago: nothing to do.
        if (outcome === "waiting") continue;
        // ★★ RAZORPAY HOLDS THE MONEY AND THE ORDER COULD NOT BE MARKED PAID.
        // Never cancelled, however old it gets: the week's grace below is
        // for an order nobody could ask about, and this one was answered
        // (PR #303 review). The next run tries the write again; the error is
        // logged on every run until it lands, for a person to follow up.
        if (outcome === "captured_unrecorded") {
          unrecorded++;
          console.error(
            `expire-pending-payments (captured payment could not be recorded, order ${order.id}): left pending, never expired`,
          );
          continue;
        }
        // ★★ RAZORPAY COULD NOT BE ASKED ABOUT THIS ORDER (unreachable, or
        // these keys were refused: revoked, or another account's). Skip it
        // rather than risk cancelling a captured payment, but not for ever:
        // this used to have no limit, so an order on a revoked key stayed
        // pending and held its stock indefinitely, at the front of every
        // batch. After a week it is cancelled like an unreadable connection.
        if (ageMs < UNREADABLE_GATEWAY_GRACE_MS) {
          // For a refusal, the order's own record says whether the keys
          // changed since it was placed or Razorpay is refusing the keys that
          // made it (pending-payments.ts refusedReadReason).
          console.error(
            `expire-pending-payments (rzp fetch, order ${order.id}): ${
              outcome === "refused"
                ? `refused, ${refusedReadReason(order, lookup.gateway.creds.keyId)}`
                : "unreadable"
            }`,
          );
          continue;
        }
        console.error(
          `expire-pending-payments (gateway ${outcome === "refused" ? "refused the read" : "unreachable"} for a week, order ${order.id})`,
        );
      }
      // Gateway disconnected since the order was placed: nothing captured is
      // verifiable; fall through and expire it (stock shouldn't stay hostage).
      // Disconnecting settles every waiting order first, so this is an order
      // the old keys could not read either.
    }

    // 2. Cancel it and give back what it held: stock, store credit, pickup
    //    holds, the coupon use and the offer uses. The pending → failed claim
    //    inside is atomic, so a shopper's confirmOnlinePayment racing this loop
    //    flips pending → paid first and the order is left alone.
    if (await expireUnpaidOrder(order)) expired++;
  }

  return NextResponse.json({
    ok: true,
    paid: paid + confirmed.paid,
    expired,
    ...(unrecorded ? { capturedUnrecorded: unrecorded } : {}),
    ...(await standingSweeps()),
  });
}

/**
 * The sweeps that do not depend on any online payment being stuck. ★ They
 * used to run only on the path that found pending payments, so on the
 * ordinary hour with none, uncollected pickups never expired and their
 * reminders never went. One helper for both returns, so the two cannot drift.
 */
async function standingSweeps() {
  const latePayments = await sweepLatePayments();
  // Pickups first: cancelling an uncollected order releases its own holds, so
  // running the generic sweep afterwards finds a tidier table (and anything the
  // pickup pass failed to release still lapses here on TTL).
  const pickupsExpired = await sweepExpiredPickups();
  // Reminders AFTER the expiry sweep, never before: an order that just lapsed
  // is no longer awaiting collection, and telling someone to hurry and collect
  // something we have already cancelled is worse than saying nothing.
  const pickupsWarned = await sweepPickupReminders();
  // Cash-on-delivery orders nobody confirmed on WhatsApp: the one reminder,
  // then (where the store switched it on) the automatic cancellation. Before
  // the hold sweep, because a cancellation releases what the order held.
  const codFollowUp = await sweepCodConfirmations();
  return {
    latePayments,
    pickupsExpired,
    pickupsWarned,
    codFollowUp,
    // Refunds whose gateway call we never got an answer for. The order page
    // reconciles instantly when anyone looks; this is the backstop for the
    // ones nobody opens.
    refundsSettled: await sweepPendingRefunds(),
    holdsFreed: await sweepExpiredHolds(),
  };
}

export const GET = handle;
export const POST = handle;

/**
 * Payments that landed AFTER their order expired.
 *
 * ★★ A shopper whose Razorpay window stayed open past the grace period, or
 * whose UPI or netbanking approval arrived late, was charged for an order this
 * job had already cancelled, and nothing noticed: markOrderPaid only claimed
 * `pending` orders. The webhook and the shopper's own callback now record such
 * a payment, but neither is guaranteed to run (no webhook configured, a closed
 * tab), so this pass asks Razorpay about orders it expired in the last three
 * days. A captured payment is recorded on the still-cancelled order, which
 * then shows the money as owed back and tells the merchant.
 *
 * ★ READ ONLY: an authorized-but-uncaptured payment on a dead order is left
 * for Razorpay to release, which returns the shopper's money by itself.
 * Capturing it would take money for an order the shop has given up on.
 *
 * Never throws; one store's failure does not stop the rest.
 */
async function sweepLatePayments(): Promise<number> {
  const since = new Date(Date.now() - LATE_PAYMENT_WINDOW_MS).toISOString();
  let rows: {
    id: string;
    store_id: string;
    razorpay_order_id: string | null;
    total: number | null;
    store_credit_used: number | null;
  }[];
  try {
    rows = await withService((db) =>
      db
        .select({
          id: orders.id,
          store_id: orders.storeId,
          razorpay_order_id: orders.razorpayOrderId,
          total: orders.total,
          store_credit_used: orders.storeCreditUsed,
        })
        .from(orders)
        .where(
          and(
            eq(orders.paymentMethod, "razorpay"),
            eq(orders.paymentStatus, "failed"),
            eq(orders.status, "cancelled"),
            isNotNull(orders.razorpayOrderId),
            isNull(orders.razorpayPaymentId),
            gte(orders.createdAt, since),
          ),
        )
        .orderBy(asc(orders.createdAt))
        .limit(LATE_PAYMENT_BATCH),
    );
  } catch (err) {
    console.error(
      "expire-pending-payments (late payments read):",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }

  const gateways = new Map<string, StoreGatewayLookup>();
  let recorded = 0;
  for (const row of rows) {
    if (!row.razorpay_order_id) continue;
    if (!gateways.has(row.store_id)) {
      gateways.set(row.store_id, await lookupStoreGateway(row.store_id));
    }
    const lookup = gateways.get(row.store_id)!;
    if (lookup.status !== "connected") continue;
    try {
      const state = await settleOrderPayment(
        lookup.gateway.creds,
        row.razorpay_order_id,
        expectedGatewayPaise(row),
        { capture: false },
      );
      if (state.kind !== "captured") continue;
      if ((await markOrderPaid(row.id, state.paymentId)) === "late") {
        recorded++;
      }
    } catch (err) {
      console.error(
        `expire-pending-payments (late payment, order ${row.id}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return recorded;
}
