import "server-only";

// Settling refunds whose outcome we never learned (roadmap Step 2,
// docs/returns-exchanges-plan.md §3.2 step 4).
//
// ── Why this exists ────────────────────────────────────────────────────────
// `refundOrder` writes its row BEFORE calling Razorpay, so a timeout leaves a
// `pending` row and no gateway id. That is the correct outcome — the
// alternative is deciding, with no information, whether a customer was paid —
// but it is only correct if something later finds out. This is that something.
//
// Two callers, one core:
//   • reconcile-on-read, when anyone opens the order (instant in practice), and
//   • the daily cron, for orders nobody looks at.
// This is the §18 decision unchanged: asking Razorpay when someone looks is
// cheaper than a webhook endpoint to secure.
//
// ── Never throws ───────────────────────────────────────────────────────────
// Every caller is doing something else that must not fail because a gateway
// was slow — rendering an order page, or sweeping pickups in the same cron.

import { and, asc, eq, lte, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { orderPayments, orderRefunds, orders } from "@/drizzle/schema";
import { getStoreGateway } from "@/lib/payments/provider";
import {
  RZP_REFUND_PAGE_SIZE,
  rzpFetchOrderPayments,
  rzpFetchPaymentRefunds,
  capturedPayment,
  type RazorpayCreds,
  type RzpRefund,
} from "@/lib/payments/razorpay";
import {
  mapGatewayRefundStatus,
  matchGatewayRefund,
  orderMoneyTaken,
  refundCaps,
  toPaise,
  wasPaid,
  type OrderRefundFacts,
} from "@/lib/payments/refunds";
import {
  creditReinstatedForOrder,
  syncOrderCashback,
} from "@/lib/credit/store-credit";
import { recordEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";

/** A refund is only chased once it has had a fair chance to settle. Razorpay
 *  usually answers in seconds; this is about calls we never heard back from. */
const SETTLE_GRACE_MS = 2 * 60_000;

/** Pages of a payment's refund list read before giving up for this pass. */
const MAX_REFUND_PAGES = 10;

interface PendingRow {
  id: string;
  store_id: string;
  order_id: string;
  amount: number;
  idempotency_key: string | null;
  created_at: string | null;
  razorpay_payment_id: string | null;
  razorpay_order_id: string | null;
  order_ref: string | null;
  customer_id: string | null;
}

async function loadPending(where: {
  orderId?: string;
  limit: number;
}): Promise<PendingRow[]> {
  const cutoff = new Date(Date.now() - SETTLE_GRACE_MS).toISOString();
  return withService((db) =>
    db
      .select({
        id: orderRefunds.id,
        store_id: orderRefunds.storeId,
        order_id: orderRefunds.orderId,
        amount: orderRefunds.amount,
        idempotency_key: orderRefunds.idempotencyKey,
        created_at: orderRefunds.createdAt,
        razorpay_payment_id: orders.razorpayPaymentId,
        razorpay_order_id: orders.razorpayOrderId,
        order_ref: orders.orderRef,
        customer_id: orders.customerId,
      })
      .from(orderRefunds)
      .innerJoin(orders, eq(orders.id, orderRefunds.orderId))
      .where(
        and(
          eq(orderRefunds.status, "pending"),
          eq(orderRefunds.method, "razorpay"),
          lte(orderRefunds.createdAt, cutoff),
          ...(where.orderId ? [eq(orderRefunds.orderId, where.orderId)] : []),
        ),
      )
      .orderBy(asc(orderRefunds.createdAt))
      .limit(where.limit),
  );
}

/**
 * Every Razorpay payment this order's refund could have been made against.
 *
 * ★★ A TILL SALE KEEPS ITS PAYMENT ID ON `order_payments`, NEVER ON THE
 * ORDER. Reading only `orders.razorpay_payment_id` found nothing for a card
 * or UPI payment taken at the counter, so a refund of one whose answer never
 * arrived stayed `pending` for ever: its amount counted as refunded, no
 * credit note was issued, and nothing could retry it. Every gateway leg is a
 * candidate; matching is by OUR key, so looking at the wrong payment simply
 * finds nothing.
 *
 * Returns null when a read failed, which must stay "we don't know".
 */
async function candidatePaymentIds(
  creds: RazorpayCreds,
  row: PendingRow,
): Promise<string[] | null> {
  const ids = new Set<string>();
  if (row.razorpay_payment_id) ids.add(row.razorpay_payment_id);

  const legs = await withService((db) =>
    db
      .select({ reference: orderPayments.reference })
      .from(orderPayments)
      .where(
        and(
          eq(orderPayments.orderId, row.order_id),
          eq(orderPayments.method, "razorpay"),
        ),
      ),
  );
  for (const leg of legs) if (leg.reference) ids.add(leg.reference);

  // The payment id is normally stamped at confirm time, but an order that was
  // reconciled rather than confirmed may not carry one yet.
  if (!ids.size && row.razorpay_order_id) {
    const payments = await rzpFetchOrderPayments(creds, row.razorpay_order_id);
    if (!payments.ok) return null;
    const captured = capturedPayment(payments.data);
    if (captured) ids.add(captured.id);
  }
  return [...ids];
}

/** Look for our refund across every page of one payment's refund list. */
async function findRefundOnPayment(
  creds: RazorpayCreds,
  paymentId: string,
  key: string,
): Promise<{ found: RzpRefund | null } | null> {
  for (let page = 0; page < MAX_REFUND_PAGES; page++) {
    const list = await rzpFetchPaymentRefunds(creds, paymentId, {
      count: RZP_REFUND_PAGE_SIZE,
      skip: page * RZP_REFUND_PAGE_SIZE,
    });
    if (!list.ok) return null;
    const mine = matchGatewayRefund(list.data, key);
    if (mine) return { found: mine };
    if (list.data.length < RZP_REFUND_PAGE_SIZE) return { found: null };
  }
  // A payment with more than a thousand refunds is not something we can rule
  // out by reading further; treat it as unknown rather than absent.
  return null;
}

/**
 * Settle one pending row against the gateway.
 *
 * Returns whether anything changed. A row we still can't resolve is LEFT
 * pending — that is the whole point; guessing is what this module exists to
 * avoid.
 */
async function settle(row: PendingRow): Promise<boolean> {
  const gateway = await getStoreGateway(row.store_id);
  if (!gateway) return false;

  const paymentIds = await candidatePaymentIds(gateway.creds, row);
  if (!paymentIds) return false;
  if (!paymentIds.length) {
    // No payment anywhere to look at. Nothing can be proved either way, so
    // the row stays pending, but somebody needs to know it is stuck.
    const age = Date.now() - new Date(row.created_at ?? Date.now()).getTime();
    if (age >= SETTLE_GRACE_MS * 15) {
      logError(
        "refund.reconcile_no_payment",
        new Error("A pending gateway refund has no payment to check against"),
        { orderId: row.order_id, refundId: row.id },
      );
    }
    return false;
  }

  let mine: RzpRefund | null = null;
  if (row.idempotency_key) {
    for (const paymentId of paymentIds) {
      const result = await findRefundOnPayment(
        gateway.creds,
        paymentId,
        row.idempotency_key,
      );
      if (!result) return false;
      if (result.found) {
        mine = result.found;
        break;
      }
    }
  }

  if (!mine) {
    // Razorpay has no refund carrying our key. Two readings, and only one is
    // safe to act on: either the create never landed, or it landed and their
    // list is lagging. We take the first ONLY after the grace window has
    // passed several times over — until then the row stays pending, because
    // failing it would free the amount for a second refund of money that may
    // already be on its way back to the customer.
    const age = Date.now() - new Date(row.created_at ?? Date.now()).getTime();
    if (age < SETTLE_GRACE_MS * 15) return false;

    const claimed = await withService((db) =>
      db
        .update(orderRefunds)
        .set({
          status: "failed",
          reason: sql`coalesce(${orderRefunds.reason}, 'Never reached the gateway')`,
        })
        .where(
          and(eq(orderRefunds.id, row.id), eq(orderRefunds.status, "pending")),
        )
        .returning({ id: orderRefunds.id }),
    );
    return claimed.length > 0;
  }

  const status = mapGatewayRefundStatus(mine.status);
  if (status === "pending") return false;

  // Claim the transition conditionally, like every other exactly-once path
  // here: a concurrent reconcile-on-read and cron run can't both settle it.
  const claimed = await withService((db) =>
    db
      .update(orderRefunds)
      .set({ status, gatewayRefundId: mine.id })
      .where(
        and(eq(orderRefunds.id, row.id), eq(orderRefunds.status, "pending")),
      )
      .returning({ id: orderRefunds.id }),
  );
  if (!claimed.length) return false;

  if (status === "completed") {
    await syncOrderRefundState(row.order_id);
    // ★ THE CUSTOMER IS TOLD NOW. The refund action announces only refunds
    // that settled while it waited, deliberately, so one that settled here
    // used to send no email at all. The claim above is exactly-once, so this
    // fires once.
    await recordEvent({
      type: "order.refund_issued",
      storeId: row.store_id,
      actor: { type: "system" },
      subject: { type: "order", id: row.order_id, label: row.order_ref },
      customerId: row.customer_id,
      payload: {
        orderRef: row.order_ref ?? "",
        amount: Number(row.amount ?? 0),
        currency: "INR",
        paymentMethod: "razorpay",
      },
    }).catch((err) =>
      logError("refund.reconcile_notify", err, { orderId: row.order_id }),
    );
  }
  return true;
}

/**
 * Everything the refund caps are computed from, for one order.
 *
 * ONE reader for the refund itself (inside its row lock, via `db`), the
 * refund panel and the "still owed" figure a cancellation reports, so the
 * three can never disagree about what a customer is owed.
 */
export async function loadOrderRefundFacts(
  orderId: string,
  db?: Db,
): Promise<
  | (OrderRefundFacts & {
      storeId: string;
      paymentStatus: string | null;
      paymentMethod: string | null;
      status: string | null;
    })
  | null
> {
  const run = async (handle: Db) => {
    const [order] = await handle
      .select({
        storeId: orders.storeId,
        total: orders.total,
        storeCreditUsed: orders.storeCreditUsed,
        paymentStatus: orders.paymentStatus,
        paymentMethod: orders.paymentMethod,
        status: orders.status,
        deliveredAt: orders.deliveredAt,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) return null;
    const refunds = await handle
      .select({
        amount: orderRefunds.amount,
        status: orderRefunds.status,
        method: orderRefunds.method,
      })
      .from(orderRefunds)
      .where(eq(orderRefunds.orderId, orderId));
    const creditReinstated = await creditReinstatedForOrder(
      order.storeId,
      orderId,
      handle,
    );
    return {
      storeId: order.storeId,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      status: order.status,
      total: Number(order.total ?? 0),
      storeCreditUsed: Number(order.storeCreditUsed ?? 0),
      creditReinstated,
      moneyTaken: orderMoneyTaken({
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        status: order.status,
        deliveredAt: order.deliveredAt,
      }),
      refunds: refunds.map((r) => ({
        amount: Number(r.amount ?? 0),
        status: r.status,
        method: r.method,
      })),
    };
  };
  return db ? run(db) : withService(run);
}

/**
 * Recompute `orders.payment_status` from what has actually gone back.
 *
 * Derived, never accumulated: a refund that later fails has to be able to move
 * the order back off "refunded", and a status incremented at each step can't
 * do that. Only `completed` rows count — this is the one place `pending`
 * deliberately does NOT, because here we are describing what has happened
 * rather than reserving headroom (see refundableAmount for the other side).
 *
 * ★ CREDIT A CANCELLATION RESTORED COUNTS AS GIVEN BACK. Otherwise a ₹500
 * order paid ₹300 card + ₹200 credit, cancelled (₹200 reinstated) and
 * refunded ₹300, read `partially_refunded` for ever, with "₹200 owed" beside
 * it inviting a second, store-credit refund of money already returned.
 *
 * ★ AN ORDER THAT TOOK NO MONEY KEEPS ITS PAYMENT STATUS. Flipping an unpaid
 * order to `refunded` would make it read as PAID (wasPaid), which is what the
 * money caps trust, and the next refund could then hand out money nobody paid.
 *
 * Also re-syncs the cashback the order earned, since that follows refunds.
 */
export async function syncOrderRefundState(orderId: string): Promise<void> {
  try {
    await withService(async (db) => {
      const facts = await loadOrderRefundFacts(orderId, db);
      if (!facts || !facts.moneyTaken) return;

      const refundedP = facts.refunds
        .filter((r) => r.status === "completed")
        .reduce((sum, r) => sum + Math.max(0, toPaise(r.amount)), 0);
      const reinstatedP = wasPaid(facts.paymentStatus)
        ? Math.max(0, toPaise(facts.creditReinstated))
        : 0;
      const returnedP = refundedP + reinstatedP;
      const valueP = Math.max(0, toPaise(facts.total));

      // Anything already given back is at least partial; only a full one is
      // "refunded". An order with nothing settled goes back to `paid` — that
      // is what makes a failed refund reversible in the UI.
      const current = facts.paymentStatus;
      const next =
        returnedP <= 0
          ? current === "refunded" || current === "partially_refunded"
            ? "paid"
            : current
          : returnedP >= valueP
            ? "refunded"
            : "partially_refunded";

      if (next && next !== current) {
        await db
          .update(orders)
          .set({ paymentStatus: next })
          .where(eq(orders.id, orderId));
      }
    });
  } catch (err) {
    logError("refund.sync_order_state", err, { orderId });
  }
  await syncOrderCashback(orderId);
}

/** Reconcile every pending refund on ONE order — the read path. */
export async function reconcileOrderRefunds(orderId: string): Promise<number> {
  try {
    const rows = await loadPending({ orderId, limit: 20 });
    let settled = 0;
    for (const row of rows) if (await settle(row)) settled++;
    return settled;
  } catch (err) {
    logError("refund.reconcile_order", err, { orderId });
    return 0;
  }
}

/** Reconcile pending refunds across all stores — the cron backstop. */
export async function sweepPendingRefunds(limit = 100): Promise<number> {
  try {
    const rows = await loadPending({ limit });
    let settled = 0;
    for (const row of rows) if (await settle(row)) settled++;
    return settled;
  } catch (err) {
    logError("refund.sweep", err);
    return 0;
  }
}

/**
 * Money this order still owes its customer — the number a cancellation has to
 * surface.
 *
 * Cancelling and expiring both leave a paid order with nothing shipped, and
 * the decision (returns-exchanges-plan §2.2) is that money NEVER leaves on a
 * schedule or without a human. So the obligation has to be visible instead:
 * this is what the order drawer escalates and what rides into the
 * `order.cancelled` / `order.pickup_expired` payloads, so a merchant learns
 * about it in the channel they already read.
 *
 * ★ It reads the order fresh, and nets off store credit a cancellation has
 * already reinstated: reporting that credit as still due is what led a
 * merchant to refund it a second time. The extra fields callers pass are
 * accepted and ignored; the database is the source.
 *
 * Zero for an order that took nothing, and zero on any error, because
 * inventing an obligation is worse than missing one.
 */
export async function refundDueForOrder(order: {
  id: string;
  total?: number | null;
  paymentStatus?: string | null;
}): Promise<number> {
  try {
    const facts = await loadOrderRefundFacts(order.id);
    if (!facts) return 0;
    return refundCaps(facts).overall;
  } catch (err) {
    logError("refund.due_for_order", err, { orderId: order.id });
    return 0;
  }
}
