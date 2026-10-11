import { NextResponse } from "next/server";
import { and, asc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { recordEvent } from "@/lib/notifications/record";
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
import { releaseCancelledOrder } from "@/lib/orders/cancel";

// Reaper for online-payment orders stuck in `payment_status: 'pending'` —
// v1 has no merchant webhooks (reconcile-on-read instead), so this scheduled
// job is the safety net for shoppers who paid but never triggered
// confirmOnlinePayment, and for orders whose payment simply never happened.
// It runs DAILY on the Vercel Hobby plan (which caps crons at once/day); it's
// only a backstop, since the success page reconciles a real payment instantly.
// On Vercel Pro, bump the vercel.json schedule back to hourly.
//
// For each razorpay order pending longer than the grace window:
//   1. Ask Razorpay first — a CAPTURED payment means the money was taken:
//      mark the order paid (never lose a paid order). An AUTHORIZED payment
//      of the exact amount is captured first, so a store whose Razorpay
//      account captures manually does not lose it.
//   2. Otherwise atomically claim the pending → failed transition, then run
//      the shared cancellation cleanup (stock back at the location that
//      reserved it, spent store credit reinstated, pickup holds released),
//      release the coupon use, and cancel the order. An order whose gateway
//      cannot be READ is left alone rather than cancelled.
//   3. Look again at orders it expired in the last three days: a payment that
//      landed after expiry is recorded so it can be refunded, never lost.
//
// It ALSO cancels pickups nobody collected (Phase F) and sweeps expired stock
// holds (roadmap Phase E). Same job because it is
// the same shape of problem — units set aside for something that never
// completed — and a hold nobody ends would make stock unsellable forever.
// Independent of the payment work below: the sweep runs even when there are no
// pending orders, and a failure in one must not skip the other.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it).

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Long enough for a slow UPI approve + the shopper's retry attempts; short
// enough that reserved stock isn't hostage for hours.
const GRACE_MINUTES = 45;
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

// placeOrder stores the coupon code as typed; the usage counters key on the
// normalized form (mirror of checkout-actions normalizeCode).
function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

interface PendingOrder {
  id: string;
  store_id: string;
  razorpay_order_id: string | null;
  applied_coupon_code: string | null;
  order_ref: string | null;
  customer_id: string | null;
  total: number | null;
  store_credit_used: number | null;
  created_at: string | null;
}

/** What the gateway was asked for: the total less anything store credit
 *  settled (§29). */
function expectedPaise(order: {
  total: number | null;
  store_credit_used: number | null;
}): number {
  return Math.round(
    (Number(order.total ?? 0) - Number(order.store_credit_used ?? 0)) * 100,
  );
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60_000).toISOString();

  let pending: PendingOrder[];
  try {
    pending = await withService((db) =>
      db
        .select({
          id: orders.id,
          store_id: orders.storeId,
          razorpay_order_id: orders.razorpayOrderId,
          applied_coupon_code: orders.appliedCouponCode,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
          total: orders.total,
          store_credit_used: orders.storeCreditUsed,
          created_at: orders.createdAt,
        })
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
    // The refund sweep runs even with no pending payments — money going OUT
    // is a different queue from money coming in, and a store can easily have
    // a refund in limbo and not one unpaid order.
    return NextResponse.json({
      ok: true,
      paid: 0,
      expired: 0,
      latePayments: await sweepLatePayments(),
      refundsSettled: await sweepPendingRefunds(),
      holdsFreed: await sweepExpiredHolds(),
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

  for (const order of pending) {
    // 1. Razorpay is the source of truth — never cancel a paid order.
    if (order.razorpay_order_id) {
      const lookup = await gatewayFor(order.store_id);
      if (lookup.status === "error") {
        // ★★ COULD NOT READ IS NOT "NOT CONNECTED". This used to fall through
        // to expiry, so a database blip or a rotated decryption key cancelled
        // orders whose shoppers had paid. Leave the order alone unless the
        // connection has stayed unreadable for a week.
        const age =
          Date.now() - new Date(order.created_at ?? Date.now()).getTime();
        if (age < UNREADABLE_GATEWAY_GRACE_MS) continue;
        console.error(
          `expire-pending-payments (gateway unreadable for a week, order ${order.id})`,
        );
      } else if (lookup.status === "connected") {
        // ★ Captures an AUTHORIZED payment of the exact amount too: on a
        // Razorpay account set to capture manually, that is how a real
        // payment looks until somebody captures it, and expiring the order
        // would let Razorpay hand the money back.
        const state = await settleOrderPayment(
          lookup.gateway.creds,
          order.razorpay_order_id,
          expectedPaise(order),
          { capture: true },
        );
        if (state.kind === "unknown") {
          // Can't reach Razorpay for this order — skip it this run rather
          // than risk cancelling a captured payment.
          console.error(
            `expire-pending-payments (rzp fetch, order ${order.id}): unreadable`,
          );
          continue;
        }
        if (state.kind === "captured") {
          try {
            // ★★ THROUGH `markOrderPaid`, NOT A LOCAL UPDATE. This branch used
            // to write pending → paid itself, so a payment the reaper RESCUED
            // notified nobody at all: no confirmation to the shopper, no "New
            // order" to the merchant, no `order.payment_received`. Sharing the
            // choke point also means the claim, the confirmation and the
            // ledger line stay in one place for all three paths.
            if ((await markOrderPaid(order.id, state.paymentId)) === "paid") {
              paid++;
            }
          } catch (err) {
            console.error(
              `expire-pending-payments (mark paid, order ${order.id}):`,
              err instanceof Error ? err.message : err,
            );
          }
          continue;
        }
      }
      // Gateway disconnected since the order was placed → nothing captured is
      // verifiable; fall through and expire it (stock shouldn't stay hostage).
    }

    // 2. Claim the pending → failed transition atomically. A shopper's
    //    confirmOnlinePayment racing this loop flips pending → paid first and
    //    this claim then matches nothing — the order is left alone.
    let claimed: { id: string }[];
    try {
      claimed = await withService((db) =>
        db
          .update(orders)
          .set({ paymentStatus: "failed", status: "cancelled" })
          .where(
            and(eq(orders.id, order.id), eq(orders.paymentStatus, "pending")),
          )
          .returning({ id: orders.id }),
      );
    } catch (claimErr) {
      console.error(
        `expire-pending-payments (claim, order ${order.id}):`,
        claimErr instanceof Error ? claimErr.message : claimErr,
      );
      continue;
    }
    if (!claimed.length) continue;
    expired++;

    // The merchant needs to know an order died unpaid — it looked like a sale
    // in the dashboard until this ran. recordEvent (not emitEvent): a cron
    // response ends the moment we return, so after() has nothing to run on.
    await recordEvent({
      type: "order.payment_failed",
      storeId: order.store_id,
      actor: { type: "system" },
      subject: { type: "order", id: order.id, label: order.order_ref },
      customerId: order.customer_id,
      payload: {
        orderRef: order.order_ref ?? "",
        total: Number(order.total ?? 0),
        currency: "INR",
        reason: "Payment not completed",
      },
    });

    // 3. ★★ THE SHARED CANCELLATION CLEANUP, not a hand-written subset of it.
    // This used to restock by hand and stop there, so the STORE CREDIT the
    // order spent at checkout was never given back: a shopper who applied
    // ₹200 of credit, closed the payment window and was told to try cash on
    // delivery lost the ₹200. releaseCancelledOrder reinstates it exactly
    // once, restocks at the location that reserved the units (the hand-written
    // copy always used the default one), and releases pickup holds.
    await releaseCancelledOrder(
      order.store_id,
      order.id,
      withService,
      "payment_expired",
    ).catch((err) =>
      console.error(
        `expire-pending-payments (release, order ${order.id}):`,
        err instanceof Error ? err.message : err,
      ),
    );

    // 4. Give the coupon use back (best-effort, floors at 0).
    if (order.applied_coupon_code) {
      await withService((db) =>
        db.execute(
          sql`select decrement_coupon_usage(p_code => ${normalizeCode(order.applied_coupon_code!)}, p_store_id => ${order.store_id})`,
        ),
      ).catch((err) =>
        console.error(
          `expire-pending-payments (decrement_coupon, order ${order.id}):`,
          err instanceof Error ? err.message : err,
        ),
      );
    }
  }

  // Pickups first: cancelling an uncollected order releases its own holds, so
  // running the generic sweep afterwards finds a tidier table (and anything the
  // pickup pass failed to release still lapses here on TTL).
  const pickupsExpired = await sweepExpiredPickups();
  // Reminders AFTER the expiry sweep, never before: an order that just lapsed
  // is no longer awaiting collection, and telling someone to hurry and collect
  // something we have already cancelled is worse than saying nothing.
  const pickupsWarned = await sweepPickupReminders();

  return NextResponse.json({
    ok: true,
    paid,
    expired,
    latePayments: await sweepLatePayments(),
    pickupsExpired,
    pickupsWarned,
    // Refunds whose gateway call we never got an answer for. The order page
    // reconciles instantly when anyone looks; this is the backstop for the
    // ones nobody opens.
    refundsSettled: await sweepPendingRefunds(),
    holdsFreed: await sweepExpiredHolds(),
  });
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
        expectedPaise(row),
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
