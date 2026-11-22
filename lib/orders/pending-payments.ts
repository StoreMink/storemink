import "server-only";

// Online orders that are waiting for their payment: confirming the ones whose
// money has arrived, and cancelling the ones whose money never did.
//
// ★★ ONE PLACE FOR BOTH (21 Nov 2026). The hourly reaper used to be the only
// thing that did either, with its own hand-written cancellation, so three gaps
// stayed open:
//
//   1. A shopper who paid and whose tab closed waited 45 to 105 minutes for
//      the order to be confirmed, came back to a full cart, and could pay for
//      a second order. Checkout now asks about the shopper's own waiting
//      orders, and a frequent pass confirms young ones.
//   2. Cancelling an unpaid order gave back the stock, the store credit and
//      the coupon use, but never the OFFER uses.
//   3. Disconnecting Razorpay, or connecting a different account, threw away
//      the only credentials that can say whether an order waiting on the old
//      account was paid. The merchant's change now settles every waiting
//      order first.
//
// Everything that marks an order paid still goes through `markOrderPaid`, and
// everything that cancels one goes through `expireUnpaidOrder`, so the four
// triggers (the shopper's callback, the webhook, checkout's own check, the
// scheduled passes) cannot disagree.

import { and, asc, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orderItems, orders } from "@/drizzle/schema";
import { recordEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";
import { releaseOrderOfferUses } from "@/lib/offers/cart";
import { releaseCancelledOrder } from "@/lib/orders/cancel";
import { markOrderPaid } from "@/lib/orders/mark-paid";
import { settleOrderPayment } from "@/lib/payments/capture";
import {
  lookupStoreGateway,
  type StoreGatewayLookup,
} from "@/lib/payments/provider";
import type { RazorpayCreds } from "@/lib/payments/razorpay";

/**
 * How long an online order waits for its payment before it is cancelled.
 * Long enough for a slow UPI approval and the shopper's retries; short enough
 * that reserved stock is not held for hours.
 */
export const PAYMENT_GRACE_MINUTES = 45;

/**
 * How old an order must be before a scheduled pass asks the gateway about it.
 * Younger than this the shopper is still on the payment screen and their own
 * callback is about to confirm it.
 */
export const CONFIRM_AFTER_MINUTES = 2;

/** Orders one confirming pass will ask the gateway about. */
export const CONFIRM_BATCH = 100;

export interface PendingOnlineOrder {
  id: string;
  store_id: string;
  razorpay_order_id: string | null;
  /** The public key id the order was created with; null on older orders. */
  razorpay_key_id?: string | null;
  applied_coupon_code: string | null;
  order_ref: string | null;
  customer_id: string | null;
  total: number | null;
  store_credit_used: number | null;
  created_at: string | null;
}

/** The columns every reader of a waiting order selects. */
export const pendingOrderColumns = {
  id: orders.id,
  store_id: orders.storeId,
  razorpay_order_id: orders.razorpayOrderId,
  razorpay_key_id: orders.razorpayKeyId,
  applied_coupon_code: orders.appliedCouponCode,
  order_ref: orders.orderRef,
  customer_id: orders.customerId,
  total: orders.total,
  store_credit_used: orders.storeCreditUsed,
  created_at: orders.createdAt,
};

/** What the gateway was asked for: the total less anything store credit
 *  settled (§29). */
export function expectedGatewayPaise(order: {
  total: number | string | null;
  store_credit_used: number | string | null;
}): number {
  return Math.round(
    (Number(order.total ?? 0) - Number(order.store_credit_used ?? 0)) * 100,
  );
}

/** Minutes since the order was placed; 0 when it carries no time. */
export function orderAgeMinutes(
  order: { created_at: string | null },
  now: Date = new Date(),
): number {
  if (!order.created_at) return 0;
  const placed = new Date(order.created_at).getTime();
  if (!Number.isFinite(placed)) return 0;
  return Math.max(0, (now.getTime() - placed) / 60_000);
}

// placeOrder stores the coupon code as typed; the usage counters key on the
// normalized form (mirror of checkout-actions normalizeCode).
function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * Cancel an online order whose payment never arrived, and give back
 * everything it was holding. Returns whether THIS call cancelled it.
 *
 * ★ THE CLAIM COMES FIRST. `pending → failed` is one conditional UPDATE, so a
 * shopper's payment racing this flips `pending → paid` first and the claim
 * then matches nothing: the order is left alone and nothing is released.
 *
 * What goes back, each exactly once: stock at the location that reserved it,
 * spent store credit and pickup holds (`releaseCancelledOrder`), the coupon
 * use, and (new) every offer use, read from the redemption ledger.
 *
 * ⚠ The caller decides WHETHER the order may be cancelled (it has asked the
 * gateway, or there is none to ask). This only does it.
 */
export async function expireUnpaidOrder(
  order: PendingOnlineOrder,
): Promise<boolean> {
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
  } catch (err) {
    logError("checkout.expire_unpaid_claim", err, { orderId: order.id });
    return false;
  }
  if (!claimed.length) return false;

  // The merchant needs to know an order died unpaid: it looked like a sale in
  // the dashboard until now. recordEvent (not emitEvent): the scheduled
  // callers have no request left for after() to run on.
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
  }).catch((err) =>
    logError("checkout.expire_unpaid_notify", err, { orderId: order.id }),
  );

  // ★★ THE SHARED CANCELLATION CLEANUP, not a hand-written subset of it: it
  // reinstates store credit exactly once, restocks at the location that
  // reserved the units and releases pickup holds.
  await releaseCancelledOrder(
    order.store_id,
    order.id,
    withService,
    "payment_expired",
  ).catch((err) =>
    logError("checkout.expire_unpaid_release", err, { orderId: order.id }),
  );

  // Give the coupon use back (best-effort, floors at 0).
  if (order.applied_coupon_code) {
    const code = normalizeCode(order.applied_coupon_code);
    await withService((db) =>
      db.execute(
        sql`select decrement_coupon_usage(p_code => ${code}, p_store_id => ${order.store_id})`,
      ),
    ).catch((err) =>
      logError("checkout.expire_unpaid_coupon", err, { orderId: order.id }),
    );
  }

  // ★ And the offer uses: the ledger rows this order wrote are what a
  // "one per customer" or "first 100 orders" limit counts.
  await releaseOrderOfferUses(order.store_id, order.id);
  return true;
}

export type PendingOrderOutcome =
  /** The gateway holds the money: the order is now paid. */
  | "paid"
  /** No payment, and past the grace period: the order was cancelled. */
  | "expired"
  /** No payment yet, and still inside the grace period. */
  | "waiting"
  /** The gateway could not be read, so nothing was decided. */
  | "unknown"
  /**
   * ★★ The gateway HOLDS THE MONEY and the order could not be marked paid
   * (the write failed). Never the same as `unknown`: an order nobody could
   * ask about may be cancelled after a week, and this one must never be,
   * because the shopper has paid for it. Every caller leaves it alone; the
   * next pass tries the write again.
   */
  | "captured_unrecorded"
  /** The gateway answered and refused the read with these credentials. */
  | "refused";

/**
 * Ask the gateway about one waiting order and act on the answer.
 *
 * ★ RAZORPAY IS THE SOURCE OF TRUTH. A captured payment marks the order paid
 * (an authorized one of the exact amount is captured first, so an account set
 * to capture manually loses nothing). With no payment the order is cancelled
 * only when `expire` allows it: `"after_grace"` once it is older than
 * `PAYMENT_GRACE_MINUTES`, `"never"` for a pass that only confirms.
 */
export async function settlePendingOrder(
  order: PendingOnlineOrder,
  creds: RazorpayCreds,
  opts: { expire: "after_grace" | "never"; now?: Date },
): Promise<PendingOrderOutcome> {
  if (!order.razorpay_order_id) return "unknown";
  const state = await settleOrderPayment(
    creds,
    order.razorpay_order_id,
    expectedGatewayPaise(order),
    { capture: true },
  );
  if (state.kind === "unknown") return state.refused ? "refused" : "unknown";
  if (state.kind === "captured") {
    try {
      // ★ `strict`: a write that failed throws and is reported as
      // `captured_unrecorded` below, never as "someone else recorded it".
      const outcome = await markOrderPaid(order.id, state.paymentId, {
        strict: true,
      });
      // "unchanged": someone else recorded it first. Either way this order is
      // not to be expired.
      return outcome === "paid" ? "paid" : "waiting";
    } catch (err) {
      // ★★ NOT `unknown` (PR #303 review, 22 Nov 2026). That is what "Razorpay
      // could not be read" returns, and the hourly reaper cancels an order
      // it has been unable to ask about for a week: a captured payment whose
      // write kept failing was then cancelled, its stock and credit given
      // back, with nobody asked to refund the shopper.
      logError("checkout.captured_payment_unrecorded", err, {
        orderId: order.id,
        storeId: order.store_id,
        paymentId: state.paymentId,
      });
      return "captured_unrecorded";
    }
  }
  if (
    opts.expire === "after_grace" &&
    orderAgeMinutes(order, opts.now) >= PAYMENT_GRACE_MINUTES
  ) {
    return (await expireUnpaidOrder(order)) ? "expired" : "waiting";
  }
  return "waiting";
}

/** A store's online orders still waiting for payment, oldest first. */
export async function listStorePendingOrders(
  storeId: string,
  limit = 200,
): Promise<PendingOnlineOrder[]> {
  return withService((db) =>
    db
      .select(pendingOrderColumns)
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          eq(orders.paymentMethod, "razorpay"),
          eq(orders.paymentStatus, "pending"),
          isNotNull(orders.razorpayOrderId),
        ),
      )
      .orderBy(asc(orders.createdAt))
      .limit(limit),
  );
}

/**
 * One shopper's own online orders still waiting for payment at this store,
 * newest first. Only recent ones: an older order has been cancelled already.
 */
export async function listShopperPendingOrders(
  storeId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<PendingOnlineOrder[]> {
  const since = new Date(now.getTime() - 3 * 60 * 60_000).toISOString();
  return withService((db) =>
    db
      .select(pendingOrderColumns)
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          eq(orders.customerId, customerId),
          eq(orders.paymentMethod, "razorpay"),
          eq(orders.paymentStatus, "pending"),
          isNotNull(orders.razorpayOrderId),
          gte(orders.createdAt, since),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(5),
  );
}

export interface ConfirmSummary {
  considered: number;
  paid: number;
  errors: number;
}

/**
 * The frequent pass: confirm young waiting orders whose money has arrived.
 *
 * ★★ IT NEVER CANCELS ANYTHING. Cancelling stays with the reaper and its
 * 45-minute rule; this only looks for money, which can only help the shopper.
 * It is what closes the gap between a payment landing and the hourly reaper
 * for a store that has not set up its Razorpay webhook: run every few
 * minutes, a shopper whose tab closed is confirmed in minutes, not in up to
 * 105.
 *
 * Orders between `CONFIRM_AFTER_MINUTES` and `PAYMENT_GRACE_MINUTES` old,
 * newest first (a fresh payment is the likeliest to have just landed), one
 * gateway lookup per store. Never throws.
 */
export async function confirmYoungPendingOrders(
  now: Date = new Date(),
): Promise<ConfirmSummary> {
  const summary: ConfirmSummary = { considered: 0, paid: 0, errors: 0 };
  const newest = new Date(
    now.getTime() - CONFIRM_AFTER_MINUTES * 60_000,
  ).toISOString();
  const oldest = new Date(
    now.getTime() - PAYMENT_GRACE_MINUTES * 60_000,
  ).toISOString();

  let young: PendingOnlineOrder[];
  try {
    young = await withService((db) =>
      db
        .select(pendingOrderColumns)
        .from(orders)
        .where(
          and(
            eq(orders.paymentMethod, "razorpay"),
            eq(orders.paymentStatus, "pending"),
            isNotNull(orders.razorpayOrderId),
            lte(orders.createdAt, newest),
            gte(orders.createdAt, oldest),
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(CONFIRM_BATCH),
    );
  } catch (err) {
    logError("checkout.confirm_young_read", err);
    summary.errors += 1;
    return summary;
  }

  const gateways = new Map<string, StoreGatewayLookup>();
  for (const order of young) {
    summary.considered += 1;
    try {
      if (!gateways.has(order.store_id)) {
        gateways.set(order.store_id, await lookupStoreGateway(order.store_id));
      }
      const lookup = gateways.get(order.store_id)!;
      if (lookup.status !== "connected") continue;
      const outcome = await settlePendingOrder(order, lookup.gateway.creds, {
        expire: "never",
        now,
      });
      if (outcome === "paid") summary.paid += 1;
    } catch (err) {
      logError("checkout.confirm_young_order", err, { orderId: order.id });
      summary.errors += 1;
    }
  }
  return summary;
}

export interface GatewayChangeCheck {
  /** May the merchant's change go ahead? */
  ok: boolean;
  /** Orders confirmed paid while checking. */
  paid: number;
  /** Orders cancelled because no payment arrived within the grace period. */
  expired: number;
  /** Orders still waiting on the account being replaced. */
  waiting: number;
  /** Orders the current credentials could not be asked about. */
  unreadable: number;
  /** When the youngest waiting order reaches the grace period. */
  clearBy: string | null;
}

/**
 * Settle every waiting order BEFORE a store's Razorpay account is
 * disconnected or replaced.
 *
 * ★★ THE CURRENT CREDENTIALS ARE THE ONLY ONES THAT CAN ANSWER. An order
 * waiting for payment was created on the connected account, and once those
 * keys are gone nothing can say whether its shopper paid: the reaper used to
 * cancel it unasked (a captured payment on a cancelled order), or, after a
 * switch to another account, fail every read and leave the order and its
 * stock held for ever.
 *
 * So each waiting order is asked about with the current keys first: paid ones
 * are confirmed, ones past the grace period with no payment are cancelled.
 * Whatever is still waiting blocks the change, because its Razorpay window
 * may still be open in a shopper's browser, unless `replacement` can read it
 * too: new keys on the SAME Razorpay account see the same orders, so rotating
 * a key never has to wait.
 *
 * ★ FAILS CLOSED: a list that cannot be read, or an order the gateway cannot
 * be asked about, blocks the change. The merchant can try again in a minute;
 * a lost payment cannot be put back.
 */
export async function settleBeforeGatewayChange(
  storeId: string,
  current: RazorpayCreds,
  replacement: RazorpayCreds | null,
  now: Date = new Date(),
): Promise<GatewayChangeCheck> {
  const check: GatewayChangeCheck = {
    ok: false,
    paid: 0,
    expired: 0,
    waiting: 0,
    unreadable: 0,
    clearBy: null,
  };

  let pending: PendingOnlineOrder[];
  try {
    pending = await listStorePendingOrders(storeId);
  } catch (err) {
    logError("payments.gateway_change_read", err, { storeId });
    check.unreadable = 1;
    return check;
  }

  let youngest = 0;
  for (const order of pending) {
    const outcome = await settlePendingOrder(order, current, {
      expire: "after_grace",
      now,
    });
    if (outcome === "paid") {
      check.paid += 1;
      continue;
    }
    if (outcome === "expired") {
      check.expired += 1;
      continue;
    }

    // ★ The keys being replaced cannot read this order either (revoked at
    // Razorpay, or the order was made on an account connected before them),
    // so keeping them protects nothing. Blocking here would also mean a
    // merchant whose key was revoked could never connect a working one.
    if (outcome === "refused") continue;

    // Still undecided on the current account. New keys that can read this
    // order belong to the same Razorpay account, so nothing is lost by the
    // change: the order stays readable afterwards.
    if (replacement && order.razorpay_order_id) {
      const again = await settleOrderPayment(
        replacement,
        order.razorpay_order_id,
        expectedGatewayPaise(order),
        { capture: false },
      );
      if (again.kind !== "unknown") continue;
    }

    if (outcome === "waiting") {
      check.waiting += 1;
      const placed = order.created_at
        ? new Date(order.created_at).getTime()
        : now.getTime();
      youngest = Math.max(youngest, Number.isFinite(placed) ? placed : 0);
    } else {
      check.unreadable += 1;
    }
  }

  if (check.waiting > 0) {
    check.clearBy = new Date(
      youngest + PAYMENT_GRACE_MINUTES * 60_000,
    ).toISOString();
  }
  check.ok = check.waiting === 0 && check.unreadable === 0;
  return check;
}

/** One cart line, as far as matching it to an order goes. */
export interface CartLineKey {
  productId: string;
  variantId: string | null;
  quantity: number;
}

const lineKey = (productId: string, variantId: string | null) =>
  `${productId}|${variantId ?? ""}`;

/**
 * Does this order hold exactly the cart the shopper is looking at?
 *
 * It decides two things at checkout: whether a cart may be emptied because
 * its order turned out to be paid, and whether "Retry payment" may reopen the
 * order's Razorpay window for it. Both are wrong for a cart that has since
 * changed, so the match is EXACT: every cart line is on the order with the
 * same quantity, and every paid-for order line is in the cart. A free line an
 * offer added (price 0) is the order's own and is not expected in the cart.
 *
 * False when it cannot tell (a failed read, a malformed cart).
 */
export async function orderHoldsCart(
  orderId: string,
  cart: readonly CartLineKey[],
): Promise<boolean> {
  if (!Array.isArray(cart) || cart.length === 0) return false;
  const wanted = new Map<string, number>();
  for (const line of cart) {
    if (
      !line ||
      typeof line.productId !== "string" ||
      !line.productId ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1
    ) {
      return false;
    }
    const key = lineKey(line.productId, line.variantId ?? null);
    wanted.set(key, (wanted.get(key) ?? 0) + line.quantity);
  }

  let rows: {
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number | null;
  }[];
  try {
    rows = await withService((db) =>
      db
        .select({
          productId: orderItems.productId,
          variantId: orderItems.variantId,
          quantity: orderItems.quantity,
          price: orderItems.price,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId)),
    );
  } catch (err) {
    logError("checkout.order_holds_cart", err, { orderId });
    return false;
  }

  const held = new Map<string, number>();
  for (const row of rows) {
    const key = lineKey(row.productId, row.variantId);
    // A free line the cart does not name is a gift the order added itself.
    if (Number(row.price ?? 0) <= 0 && !wanted.has(key)) continue;
    held.set(key, (held.get(key) ?? 0) + Number(row.quantity));
  }
  if (held.size !== wanted.size) return false;
  for (const [key, quantity] of wanted) {
    if (held.get(key) !== quantity) return false;
  }
  return true;
}

export interface ShopperPendingResult {
  /** An earlier order of this shopper's that turned out to be PAID. */
  paid: PendingOnlineOrder | null;
  /** The newest order still inside its payment window, if any. */
  waiting: PendingOnlineOrder | null;
}

/**
 * Settle a shopper's own waiting orders when they come back to checkout.
 *
 * ★★ THE DOUBLE PAYMENT THIS STOPS. The shopper paid, the tab closed before
 * the store's page confirmed it, and they came back to a full cart with no
 * confirmation: the natural next step was to pay again for a second order.
 * Asking Razorpay about their own waiting orders here means the first payment
 * is found and its order confirmed before a second can be started.
 *
 * Orders past the grace period with no payment are cancelled on the spot, so
 * the stock and offer uses the shopper's own abandoned attempt was holding
 * are free for the order they are about to place.
 *
 * Never throws: on any failure it reports nothing waiting, and checkout
 * carries on exactly as before.
 */
export async function settleShopperPendingOrders(
  storeId: string,
  customerId: string,
  creds: RazorpayCreds,
  now: Date = new Date(),
): Promise<ShopperPendingResult> {
  const result: ShopperPendingResult = { paid: null, waiting: null };
  try {
    const pending = await listShopperPendingOrders(storeId, customerId, now);
    for (const order of pending) {
      const outcome = await settlePendingOrder(order, creds, {
        expire: "after_grace",
        now,
      });
      // Captured at the gateway counts as paid here even when our write
      // failed: the shopper must not be sent to pay for it again.
      if (
        (outcome === "paid" || outcome === "captured_unrecorded") &&
        !result.paid
      )
        result.paid = order;
      // Newest first, so the first one still waiting is the newest.
      if (outcome === "waiting" && !result.waiting) result.waiting = order;
    }
  } catch (err) {
    logError("checkout.settle_shopper_pending", err, { storeId });
  }
  return result;
}

/**
 * Why a gateway read was refused, as far as the order's own record can say.
 *
 * An order remembers the public key id it was created with (0280). When the
 * keys connected NOW differ, the account or its key changed after the order
 * was placed; when they are the same, Razorpay is refusing the very keys that
 * made the order (revoked, or the account restricted). Older orders carry no
 * key id, so nothing can be said. For logs only: it decides nothing.
 */
export function refusedReadReason(
  order: { razorpay_key_id?: string | null },
  connectedKeyId: string,
): "keys_changed_since_order" | "same_keys_refused" | "unrecorded" {
  if (!order.razorpay_key_id) return "unrecorded";
  return order.razorpay_key_id === connectedKeyId
    ? "same_keys_refused"
    : "keys_changed_since_order";
}
