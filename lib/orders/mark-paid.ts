import "server-only";

/**
 * "This order is now paid" — the single choke point, and the confirmation.
 *
 * ★★ IT LIVES IN `lib/`, NOT IN `app/actions/`, AND THAT IS A SECURITY
 * DECISION. Every export of a `"use server"` file is a publicly reachable
 * endpoint, so exporting `markOrderPaid` from checkout-actions so the cron
 * could import it would let any caller mark any order paid with a made-up
 * payment id. Same rule, same reason as `lib/domains/reconcile.ts` and
 * `lib/retention/prune.ts`: the core goes in lib, the action is the gate.
 *
 * ★★ AND IT IS WHERE THE CUSTOMER CONFIRMATION IS SENT. An unpaid gateway
 * order is a checkout attempt, not an order — see the note in placeOrder. The
 * pending → paid UPDATE is a conditional CLAIM, so of the three paths that
 * reach here (client callback, reconcile-on-read, cron reaper) exactly one wins
 * for a given payment, and the confirmation can never be sent twice.
 */

import { and, eq, isNull } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orderItems, orders, storeLocations } from "@/drizzle/schema";
import { emitEvent } from "@/lib/notifications/record";
import { summariseItems } from "@/lib/notifications/format";
import { formatAddressLine } from "@/lib/locations/address";
import { formatCollectionCode } from "@/lib/fulfilment/collection-code";
import { logError } from "@/lib/observability/logger";
import { recordStorefrontPurchase } from "@/lib/analytics/storefront-purchase";
import {
  refundDueForOrder,
  syncOrderRefundState,
} from "@/lib/payments/refund-reconcile";

/**
 * The `order.placed` event, typed off `emitEvent` itself so the two builders
 * below cannot drift from what the fan-out accepts.
 */
export type OrderPlacedEvent = Parameters<typeof emitEvent>[0];

/**
 * Rebuild and emit `order.placed` for an order that has just been PAID.
 *
 * ★ Reads from the database rather than taking a payload, because the three
 * callers of `markOrderPaid` have nothing in memory: the client callback, the
 * reconcile-on-read pass, and the cron reaper may each run hours after checkout
 * and in a different process. The order row and its items are the only thing
 * all three share.
 *
 * ★ Best-effort. The money is already recorded by the time this runs, so a
 * failure here must cost a notification and never a payment.
 */
async function emitOrderPlacedForPaidOrder(orderId: string): Promise<void> {
  try {
    const [row] = await withService((db) =>
      db
        .select({
          storeId: orders.storeId,
          customerId: orders.customerId,
          orderRef: orders.orderRef,
          locationId: orders.locationId,
          total: orders.total,
          currency: orders.currency,
          subtotal: orders.subtotal,
          discount: orders.discount,
          tax: orders.tax,
          shipping: orders.shipping,
          paymentMethod: orders.paymentMethod,
          shippingAddress: orders.shippingAddress,
          fulfilmentType: orders.fulfilmentType,
          pickupLocationId: orders.pickupLocationId,
          pickupCode: orders.pickupCode,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1),
    );
    if (!row) return;

    const items = await withService((db) =>
      db
        .select({
          name: orderItems.name,
          variantName: orderItems.variantName,
          quantity: orderItems.quantity,
          total: orderItems.total,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId)),
    );

    const isPickup = row.fulfilmentType === "pickup";
    let pickupShop: { name: string; address: string } | null = null;
    if (isPickup && row.pickupLocationId) {
      const [loc] = await withService((db) =>
        db
          .select({
            name: storeLocations.name,
            address: storeLocations.address,
          })
          .from(storeLocations)
          .where(eq(storeLocations.id, row.pickupLocationId!))
          .limit(1),
      );
      if (loc) {
        pickupShop = {
          name: loc.name,
          address: formatAddressLine(loc.address as never),
        };
      }
    }

    const addr = (row.shippingAddress ?? {}) as Record<string, string>;
    const num = (v: unknown) => Number(v ?? 0);

    emitEvent({
      type: "order.placed",
      storeId: row.storeId,
      locationId: row.locationId ?? null,
      actor: {
        type: "customer",
        id: row.customerId,
        label:
          [addr.firstName, addr.lastName].filter(Boolean).join(" ") || null,
      },
      subject: { type: "order", id: orderId, label: row.orderRef ?? "" },
      customerId: row.customerId,
      payload: {
        total: num(row.total),
        currency: row.currency ?? "INR",
        items: summariseItems(
          items.map((i) => ({
            name: i.name,
            variantName: i.variantName,
            quantity: i.quantity,
          })) as never,
        ),
        paymentMethod: row.paymentMethod,
        ...(isPickup
          ? {
              fulfilment: "pickup",
              pickupLocation: pickupShop?.name ?? "",
              pickupAddress: pickupShop?.address ?? "",
              ...(row.pickupCode
                ? { collectionCode: formatCollectionCode(row.pickupCode) }
                : {}),
            }
          : {
              fulfilment: "delivery",
              deliveryAddress: [
                addr.addressLine1,
                addr.addressLine2,
                addr.city,
                addr.state,
                addr.postalCode,
              ]
                .filter(Boolean)
                .join(", "),
            }),
      },
      email: {
        currency: row.currency ?? "INR",
        items: items.map((i) => ({
          name: i.name,
          variant: i.variantName,
          quantity: i.quantity,
          total: num(i.total),
        })),
        subtotal: num(row.subtotal),
        discount: num(row.discount),
        tax: num(row.tax),
        shipping: num(row.shipping),
        total: num(row.total),
      },
    } as OrderPlacedEvent);
  } catch (err) {
    logError("checkout.order_placed_emit_failed", err, { orderId });
  }
}

/**
 * What a payment did to its order: claimed it as `paid`, recorded it LATE on
 * an order that had already been cancelled for want of one, or nothing (a
 * replay, or an order that is no longer waiting on this payment).
 */
export type MarkPaidOutcome = "paid" | "late" | "unchanged";

/**
 * The write that records a payment FAILED (the database, not the order's
 * state). Thrown only for a caller that asked with `strict`.
 */
export class MarkPaidWriteError extends Error {
  constructor(
    readonly orderId: string,
    cause: unknown,
  ) {
    super("The payment could not be recorded on its order", { cause });
    this.name = "MarkPaidWriteError";
  }
}

export interface MarkPaidOptions {
  /**
   * Throw `MarkPaidWriteError` when the write itself fails, instead of
   * answering `unchanged`.
   *
   * ★★ WHY (21 Nov 2026). `unchanged` means two different things: "this order
   * is no longer waiting on this payment" (a replay, already paid), and "the
   * database could not be written". A caller that can ASK AGAIN must tell
   * them apart: the store's webhook acknowledged a delivery it had failed to
   * record, so Razorpay never retried it, and the shopper's callback said
   * "paid" for an order still pending. Callers with nothing to retry (they
   * run again on a schedule anyway) keep the old answer.
   */
  strict?: boolean;
}

export async function markOrderPaid(
  orderId: string,
  rzpPaymentId: string,
  opts: MarkPaidOptions = {},
): Promise<MarkPaidOutcome> {
  // The single choke point for "this order is now paid" — reached from the
  // client callback, reconcile-on-read, and the cron reaper alike. The UPDATE
  // is a conditional pending → paid CLAIM, so `claimed` is non-empty for
  // exactly one caller and the notification can't fire twice for one payment.
  const claimed = await withService((db) =>
    db
      .update(orders)
      .set({ paymentStatus: "paid", razorpayPaymentId: rzpPaymentId })
      // ⚠ TEST GAP: the db mock does not evaluate WHERE clauses, so removing
      // the `pending` predicate fails no test. What IS covered is the behaviour
      // that depends on it — a claim returning zero rows announces nothing.
      .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, "pending")))
      .returning({
        storeId: orders.storeId,
        orderRef: orders.orderRef,
        customerId: orders.customerId,
        total: orders.total,
        currency: orders.currency,
      }),
  ).catch((err) => {
    logError("checkout.mark_order_paid", err, { orderId });
    if (opts.strict) throw new MarkPaidWriteError(orderId, err);
    return [] as {
      storeId: string;
      orderRef: string;
      customerId: string;
      total: number;
      currency: string;
    }[];
  });

  const row = claimed[0];
  if (!row) return recordLatePayment(orderId, rzpPaymentId, opts);

  await recordStorefrontPurchase(orderId);

  // ★★ THE CONFIRMATION LIVES HERE FOR A GATEWAY ORDER, not at checkout — see
  // the long note at the `order.placed` emit in placeOrder. The claim above is
  // conditional, so exactly one caller reaches this line for one payment and
  // the confirmation cannot be sent twice.
  await emitOrderPlacedForPaidOrder(orderId);

  emitEvent({
    type: "order.payment_received",
    storeId: row.storeId,
    actor: { type: "customer", id: row.customerId },
    subject: { type: "order", id: orderId, label: row.orderRef },
    payload: { total: row.total, currency: row.currency },
  });
  return "paid";
}

/**
 * A payment captured AFTER its order was cancelled for want of one.
 *
 * ★★ IT USED TO BE DROPPED. The pending-payment reaper cancels an order 45
 * minutes after checkout if no payment has been captured, and a shopper who
 * leaves the Razorpay window open past that, or whose UPI or netbanking
 * approval arrives late, is then charged for an order that no longer exists.
 * Every path refused it: this claim only matched `pending`, the webhook
 * answered 200, the callback said "can no longer be paid", and reconcile did
 * not ask. The customer was out of pocket and nobody was told.
 *
 * ★ THE ORDER STAYS CANCELLED. Its stock was released and its credit given
 * back when it expired, and the goods may have sold since, so reviving it is
 * not ours to decide. What changes is that the money is RECORDED: the order
 * reads paid, so the refund panel says what is owed back and can send it to
 * the card, and the merchant is told. Money still never leaves without a
 * person pressing the button (returns-exchanges-plan §2.2).
 *
 * ★ ONLY AN ORDER CANCELLED UNPAID. `payment_status = 'failed'` is what the
 * reaper writes, and an existing payment id means this order already has a
 * payment on record, which must not be overwritten.
 */
async function recordLatePayment(
  orderId: string,
  rzpPaymentId: string,
  opts: MarkPaidOptions = {},
): Promise<MarkPaidOutcome> {
  const late = await withService((db) =>
    db
      .update(orders)
      .set({ paymentStatus: "paid", razorpayPaymentId: rzpPaymentId })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.paymentMethod, "razorpay"),
          eq(orders.paymentStatus, "failed"),
          eq(orders.status, "cancelled"),
          isNull(orders.razorpayPaymentId),
        ),
      )
      .returning({
        storeId: orders.storeId,
        orderRef: orders.orderRef,
        customerId: orders.customerId,
        total: orders.total,
        currency: orders.currency,
      }),
  ).catch((err) => {
    logError("checkout.late_payment_claim", err, { orderId });
    if (opts.strict) throw new MarkPaidWriteError(orderId, err);
    return [] as {
      storeId: string;
      orderRef: string;
      customerId: string | null;
      total: number;
      currency: string;
    }[];
  });

  const row = late[0];
  if (!row) return "unchanged";

  // Credit the expiry reinstated counts as already given back.
  await syncOrderRefundState(orderId);
  const refundDue = await refundDueForOrder({ id: orderId });

  logError(
    "checkout.payment_after_expiry",
    new Error("A payment was captured for an order already cancelled"),
    { orderId, storeId: row.storeId, refundDue },
  );
  emitEvent({
    type: "order.payment_received",
    storeId: row.storeId,
    actor: { type: "customer", id: row.customerId },
    subject: { type: "order", id: orderId, label: row.orderRef },
    payload: {
      total: row.total,
      currency: row.currency,
      late: true,
      ...(refundDue > 0 ? { refund_due: refundDue } : {}),
    },
  });
  return "late";
}
