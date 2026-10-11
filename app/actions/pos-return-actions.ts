"use server";

// Returns at the till (roadmap Phase G / POS 5).
//
// The mirror of `placePosSale`, and the same trust boundary: the operator is
// resolved server-side, the sale is re-read from the DB, the refund is
// RECOMPUTED from the stored snapshot, and only then is anything written. The
// client says which lines and how many — never how much money.
//
// ── Scope ──────────────────────────────────────────────────────────────────
// Setting-controlled in-store returns for register sales, another branch's
// sales, and online orders (BORIS). Stock goes back to the location accepting
// the goods; money follows the original tender, including split and Razorpay
// payments, through the shared refund core.

import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage, isUniqueViolation } from "@/lib/db/errors";
import {
  orderItems,
  orderPayments,
  orderRefunds,
  orderReturnItems,
  orderReturns,
  orders,
  products,
  users,
} from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import {
  clearCustomerVerification,
  gateCustomerVerification,
} from "@/lib/pos/customer-verification";
import { posCan } from "@/lib/pos/permissions";
import { posAudit } from "@/lib/pos/audit";
import { currentShiftIdFor } from "./pos-shift-actions";
import {
  isReturnAttemptKey,
  refundBreakdown,
  remainingQty,
  type ReturnableLine,
} from "@/lib/pos/returns";
import { emitEvent } from "@/lib/notifications/record";
import { reportStockChanges } from "@/lib/inventory/alerts";
import { canTakeReturnHere, refundRouteFor } from "@/lib/returns/in-store";
import { issueRefund } from "@/lib/payments/issue-refund";
import { refundableAmount } from "@/lib/payments/refunds";
import { logError } from "@/lib/observability/logger";
import { OPEN_RETURN_STATUSES } from "@/lib/returns/lifecycle";
import { getCounterReturnPolicy } from "@/lib/returns/counter-policy";
import {
  RETURN_BLOCKED_COPY,
  returnEligibility,
} from "@/lib/returns/eligibility";
import {
  feesFor,
  isReturnReason,
  type ReturnReason,
} from "@/lib/returns/reasons";
import { getCreditBalance } from "@/lib/credit/store-credit";
import { getStoreSettings } from "@/lib/settings/resolve";

/** Tenders a shop can hand money back through at the counter. */
// What a counter can hand money back through, PLUS the gateway — which the
// operator never chooses (refundRouteFor decides it from the tender) but which
// processReturn must accept when that is where the money has to go.
//
// `none` is the one route that moves NO money here: the goods come back and the
// refund is completed from the dashboard (an exchange replacement with no
// customer to credit — see refundRouteFor). It is only ever accepted when the
// SERVER's route says so; a client cannot pick it to dodge a refund it owes.
const REFUND_METHODS = [
  "cash",
  "card",
  "upi",
  "razorpay",
  "store_credit",
  "original",
  "none",
] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/** A method a single refund leg can actually go through. */
type TenderMethod = Exclude<RefundMethod, "original" | "none">;

export interface CounterRefundTender {
  method: TenderMethod;
  amount: number;
  reference: string | null;
}

export interface CounterRefundRoute {
  method: RefundMethod;
  counterChoice: boolean;
  copy: string;
  affectsDrawer: boolean;
}

export type ReturnCondition = "sellable" | "damaged";

export interface ReturnableSaleLine {
  id: string;
  productId: string | null;
  variantId: string | null;
  name: string;
  variantName: string | null;
  quantity: number;
  returned: number;
  remaining: number;
  unitPrice: number;
  lineTotal: number;
  taxAmount: number;
  /** This line's own share of an offer, as allocated at sale time. Subtracted
   *  from the line, never spread — see `lib/pos/returns.ts`. */
  offerDiscount: number;
  eligible: boolean;
  blockedCopy: string | null;
  returnUntil: string | null;
}

export interface ReturnableSale {
  orderId: string;
  receiptNo: string;
  orderRef: string;
  createdAt: string;
  total: number;
  /** The order-level REMAINDER only — line markdowns are already inside each
   *  line's total, and each line's offer share rides on the line itself
   *  (see lib/pos/returns.ts). */
  orderDiscount: number;
  /** `orders.tax_inclusive`: each line's tax is INSIDE its total rather than
   *  on top of it. The preview must pass this to `refundBreakdown` exactly as
   *  `processReturn` does, or the screen quotes the tax twice. */
  taxInclusive: boolean;
  paymentMethod: string;
  lines: ReturnableSaleLine[];
  /** TRUE when this order was NOT rung at this counter — an online order, or
   *  one sold at another shop (BORIS, roadmap Step 5). */
  broughtIn: boolean;
  /** Where the money must go, and whether the counter gets a say. Computed
   *  server-side from the TENDER, never offered as a preference. */
  refundRoute: CounterRefundRoute;
  /** Original tender contributions. A split return is allocated over these by
   *  the server; the cashier never converts a card payment into cash. */
  refundTenders: CounterRefundTender[];
  allowExchanges: boolean;
  requireReason: boolean;
  restockingFeePercent: number;
}

export interface FoundOrder {
  orderId: string;
  label: string;
  createdAt: string | null;
  total: number;
  paymentMethod: string;
  /** Not rung at this counter — needs the BORIS gates. */
  broughtIn: boolean;
}

const REFUND_LABEL: Record<TenderMethod, string> = {
  cash: "cash",
  card: "the card terminal",
  upi: "UPI",
  razorpay: "Razorpay",
  store_credit: "store credit",
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function refundRouting(
  order: {
    payment_method: string | null;
    payment_status: string | null;
    total: number;
    /** `orders.store_credit_used` — the part of `total` settled with credit. */
    store_credit_used?: number | null;
    /** Whether a store-credit leg has somebody to credit. */
    customer_id?: string | null;
  },
  rows: Array<{
    method: string;
    amount: number;
    change_due: number | null;
    reference: string | null;
  }>,
): { route: CounterRefundRoute; tenders: CounterRefundTender[] } {
  const allowed = new Set<TenderMethod>([
    "cash",
    "card",
    "upi",
    "razorpay",
    "store_credit",
  ]);
  const hasCustomer = Boolean(order.customer_id);

  // ★★ AN EXCHANGE REPLACEMENT IS DECIDED FIRST, AND UNCONDITIONALLY.
  // `payment_method: 'exchange'` was paid for by goods that came back — often
  // goods bought on a card — so it must never reach a cash/card/UPI counter
  // refund, whatever else is recorded against it. It used to fall through to
  // refundRouteFor's counter-choice default, which offered CASH: swap a card
  // purchase for something, return that, walk out with clean cash.
  if (order.payment_method === "exchange") {
    const route = refundRouteFor({
      paymentMethod: order.payment_method,
      paymentStatus: order.payment_status,
      hasCustomer,
    });
    return {
      route,
      tenders:
        route.method === "store_credit"
          ? [
              {
                method: "store_credit",
                amount: round2(Math.max(0, Number(order.total) || 0)),
                reference: null,
              },
            ]
          : [],
    };
  }
  // ★★ CHANGE IS ONE FIGURE PER SALE, NOT ONE PER TENDER ROW. `placePosSale`
  // computes the sale's change once and stamps it on EVERY cash tender, so
  // subtracting it row by row deducts it once per row: a ₹500 sale settled
  // ₹200 + ₹400 cash carries change ₹100 on both rows, and the naive read
  // scores the cash contribution as ₹100 + ₹300 = ₹400 against the ₹500 that
  // actually stayed in the drawer. A later split return then allocates over a
  // total that is short, and every leg is off.
  //
  // `lib/pos/shifts.ts` already guards exactly this shape — `netCashFromSales`
  // groups by order and takes the MAX rather than summing. Same rule here,
  // within the one order: take the change ONCE and spend it across the cash
  // rows in order. With a single cash row (all but a rare split) this is
  // byte-for-byte what it did before.
  let changeLeft = rows.reduce(
    (most, row) =>
      row.method === "cash"
        ? Math.max(most, Number(row.change_due ?? 0) || 0)
        : most,
    0,
  );
  const tenders = rows.flatMap((row) => {
    if (!allowed.has(row.method as TenderMethod)) {
      return [];
    }
    // Cash handed over can exceed the sale; change was never payment and must
    // not increase the share that later comes out of the drawer.
    let contribution = Math.max(0, Number(row.amount) || 0);
    if (row.method === "cash" && changeLeft > 0) {
      const taken = Math.min(changeLeft, contribution);
      contribution = Math.round((contribution - taken) * 100) / 100;
      changeLeft = Math.round((changeLeft - taken) * 100) / 100;
    }
    if (contribution <= 0) return [];
    return [
      {
        method: row.method as TenderMethod,
        amount: contribution,
        reference: row.reference ?? null,
      },
    ];
  });

  if (tenders.length === 1) {
    const method = tenders[0]!.method;
    return {
      tenders,
      route: {
        method,
        counterChoice: false,
        copy: `Refund to ${REFUND_LABEL[method]}, matching the original payment.`,
        affectsDrawer: method === "cash",
      },
    };
  }
  if (tenders.length > 1) {
    return {
      tenders,
      route: {
        method: "original",
        counterChoice: false,
        copy: "Refunded across the original payment methods in the same proportions.",
        affectsDrawer: tenders.some((tender) => tender.method === "cash"),
      },
    };
  }

  // Online gateway orders predate order_payments, and some legacy POS sales
  // did not record tender rows. A named original method is still authoritative;
  // only an ambiguous legacy counter row falls back to a cashier choice.
  if (allowed.has(order.payment_method as TenderMethod)) {
    const method = order.payment_method as TenderMethod;
    const total = round2(Math.max(0, Number(order.total) || 0));

    // ★★ PART OF `total` MAY HAVE BEEN PAID WITH STORE CREDIT, AND NO
    // INSTRUMENT EVER SAW THAT PART (§29 — credit is a payment, not a
    // discount, so `total` stays the full goods value). One leg for the whole
    // total sent the credit share to the card: issueRefund caps a money refund
    // at `total − store_credit_used`, so a full return's gateway leg was
    // refused AFTER the return was saved and the stock restocked — goods back,
    // customer paid nothing — and a partial return quietly sent credit-funded
    // value to the card. So the fallback is split the way the order was paid:
    // the money method for what money paid, store credit for the rest, and
    // allocateRefund divides any refund between them proportionally.
    const creditUsed =
      method === "store_credit"
        ? 0
        : round2(
            Math.min(total, Math.max(0, Number(order.store_credit_used) || 0)),
          );
    if (creditUsed > 0) {
      const moneyPart = round2(total - creditUsed);
      const legs: CounterRefundTender[] = [];
      if (moneyPart > 0) {
        legs.push({ method, amount: moneyPart, reference: null });
      }
      // A balance belongs to somebody. With no customer there is nobody to
      // give the credit share back to, so only the money leg is offered — and
      // capped at what money paid, which processReturn's cap check enforces
      // before anything is written.
      if (hasCustomer) {
        legs.push({
          method: "store_credit",
          amount: creditUsed,
          reference: null,
        });
      }
      if (legs.length > 1) {
        return {
          tenders: legs,
          route: {
            method: "original",
            counterChoice: false,
            copy: `Refunded the way it was paid: part to ${REFUND_LABEL[method]}, part as store credit.`,
            affectsDrawer: method === "cash",
          },
        };
      }
      if (legs.length === 1) {
        const only = legs[0]!.method;
        return {
          tenders: legs,
          route: {
            method: only,
            counterChoice: false,
            copy: `Refund to ${REFUND_LABEL[only]}, matching the original payment.`,
            affectsDrawer: only === "cash",
          },
        };
      }
      // Paid entirely with credit, and no account to give it back to.
      return {
        tenders: [],
        route: {
          method: "none",
          counterChoice: false,
          copy: "This order was paid with store credit and has no customer account to give it back to, so no money is handed back here. Take the items back, then refund it from the order in the dashboard.",
          affectsDrawer: false,
        },
      };
    }

    return {
      tenders: [
        {
          method,
          amount: total,
          reference: null,
        },
      ],
      route: {
        method,
        counterChoice: false,
        copy: `Refund to ${REFUND_LABEL[method]}, matching the original payment.`,
        affectsDrawer: method === "cash",
      },
    };
  }

  const legacy = refundRouteFor({
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    hasCustomer,
  });
  return {
    tenders: [],
    route: {
      ...legacy,
      method: legacy.method,
    },
  };
}

function allocateRefund(
  amount: number,
  route: CounterRefundRoute,
  original: CounterRefundTender[],
): CounterRefundTender[] {
  // No money moves at this counter — the dashboard completes the refund.
  if (route.method === "none") return [];
  if (route.method !== "original") {
    const method = route.method;
    const source = original.find((tender) => tender.method === method);
    return [
      {
        method,
        amount,
        reference: source?.reference ?? null,
      },
    ];
  }

  const totalPaid = original.reduce((sum, tender) => sum + tender.amount, 0);
  if (totalPaid <= 0) return [];
  let assigned = 0;
  return original.map((tender, index) => {
    const share =
      index === original.length - 1
        ? Math.round((amount - assigned) * 100) / 100
        : Math.round(((amount * tender.amount) / totalPaid) * 100) / 100;
    assigned += share;
    return { ...tender, amount: Math.max(0, share) };
  });
}

/**
 * Find an order to take back, from whatever the customer walked in with.
 *
 * ★ STORE-scoped, deliberately NOT location-scoped. Someone returning an
 * online order has an order number or a phone, not a receipt from this shop,
 * and the whole point of BORIS is that they didn't buy it here. Whether this
 * counter may ACCEPT it is a separate question, answered by getReturnableSale
 * — showing them the order and then refusing is a better experience than
 * pretending it doesn't exist.
 */
export async function findOrderForReturn(
  query: string,
): Promise<{ results: FoundOrder[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { results: [], error: "Not signed in." };
  if (!posCan(op.role, "refund")) {
    return { results: [], error: "You don't have permission to take returns." };
  }

  const q = typeof query === "string" ? query.trim() : "";
  // Two characters matches half the shop. Order refs and phone numbers are
  // both long, so a real lookup always clears this.
  if (q.length < 4) return { results: [] };
  const like = `%${q}%`;

  try {
    const rows = await withService((db) =>
      db
        .select({
          id: orders.id,
          order_ref: orders.orderRef,
          receipt_no: orders.receiptNo,
          created_at: orders.createdAt,
          total: orders.total,
          payment_method: orders.paymentMethod,
          location_id: orders.locationId,
          sales_channel: orders.salesChannel,
        })
        .from(orders)
        .leftJoin(
          users,
          and(eq(users.id, orders.customerId), eq(users.storeId, op.storeId)),
        )
        .where(
          and(
            eq(orders.storeId, op.storeId),
            // Nothing already cancelled or fully refunded — there is nothing
            // left to hand back.
            inArray(orders.status, [
              "processing",
              "shipped",
              "delivered",
              "completed",
            ]),
            or(
              ilike(orders.orderRef, like),
              ilike(orders.receiptNo, like),
              // The shopper's phone, from the address they gave. Cast because
              // shipping_address is jsonb.
              sql`${orders.shippingAddress}->>'phone' ilike ${like}`,
              sql`${orders.shippingAddress}->>'email' ilike ${like}`,
              // POS customers live on the attached store user, not in an
              // address snapshot. Search that record too so the same mobile
              // entered at checkout can find the receipt at the return desk.
              ilike(users.phone, like),
              ilike(users.email, like),
              ilike(
                sql<string>`concat_ws(' ', ${users.firstName}, ${users.lastName})`,
                like,
              ),
            ),
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(20),
    );

    return {
      results: rows.map((r) => ({
        orderId: r.id,
        label: r.order_ref ?? r.receipt_no ?? r.id.slice(0, 8),
        createdAt: r.created_at,
        total: Number(r.total ?? 0),
        paymentMethod: r.payment_method ?? "",
        broughtIn: r.sales_channel !== "pos" || r.location_id !== op.locationId,
      })),
    };
  } catch (err) {
    logError("pos.return_search", err);
    return { results: [], error: "Couldn't search orders." };
  }
}

/** The sale, with how much of each line is still returnable. */
export async function getReturnableSale(
  orderId: string,
): Promise<{ sale?: ReturnableSale; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "refund")) {
    return { error: "You don't have permission to take returns." };
  }
  if (typeof orderId !== "string" || !orderId)
    return { error: "Invalid sale." };

  // ★ READ HERE, DECIDE BELOW. The master switch cannot be applied before the
  // order is loaded, because whether it applies AT ALL depends on where the
  // sale was rung — see the grandfather rule at the `broughtIn` check.
  const policy = await getCounterReturnPolicy(op.storeId, op.locationId);

  try {
    const data = await withService(async (db) => {
      const orderRows = await db
        .select({
          id: orders.id,
          receipt_no: orders.receiptNo,
          order_ref: orders.orderRef,
          created_at: orders.createdAt,
          total: orders.total,
          discount: orders.discount,
          tax_inclusive: orders.taxInclusive,
          store_credit_used: orders.storeCreditUsed,
          customer_id: orders.customerId,
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
          location_id: orders.locationId,
          sales_channel: orders.salesChannel,
          status: orders.status,
          delivered_at: orders.deliveredAt,
          collected_at: orders.collectedAt,
        })
        .from(orders)
        // ★ STORE-scoped, not location-scoped (roadmap Step 5). The old
        // `location_id = op.locationId` predicate could never find an ONLINE
        // order — its location is the FULFILMENT one, or null — so BORIS
        // found nothing at all. The location question doesn't disappear; it
        // splits in two, and `canTakeHere` below answers the permission half
        // while the stock half stays "the shop they walked into".
        .where(and(eq(orders.id, orderId), eq(orders.storeId, op.storeId)))
        .limit(1);
      const order = orderRows[0];
      if (!order) return null;

      const items = await db
        .select({
          id: orderItems.id,
          product_id: orderItems.productId,
          variant_id: orderItems.variantId,
          name: orderItems.name,
          variant_name: orderItems.variantName,
          quantity: orderItems.quantity,
          price: orderItems.price,
          total: orderItems.total,
          line_discount: orderItems.lineDiscount,
          offer_discount: orderItems.offerDiscount,
          tax_amount: orderItems.taxAmount,
          product_returnable: products.returnable,
          product_window: products.returnWindowDays,
        })
        .from(orderItems)
        .leftJoin(products, eq(products.id, orderItems.productId))
        .where(eq(orderItems.orderId, orderId));

      // Everything already returned on this sale, per line.
      const priorRows = items.length
        ? await db
            .select({
              order_item_id: orderReturnItems.orderItemId,
              qty: sql<number>`sum(${orderReturnItems.quantity})`,
            })
            .from(orderReturnItems)
            .innerJoin(
              orderReturns,
              eq(orderReturns.id, orderReturnItems.returnId),
            )
            .where(
              and(
                inArray(
                  orderReturnItems.orderItemId,
                  items.map((i) => i.id),
                ),
                inArray(orderReturns.status, OPEN_RETURN_STATUSES),
              ),
            )
            .groupBy(orderReturnItems.orderItemId)
        : [];

      const paymentRows = await db
        .select({
          method: orderPayments.method,
          amount: orderPayments.amount,
          change_due: orderPayments.changeDue,
          reference: orderPayments.reference,
        })
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));

      return { order, items, priorRows, paymentRows };
    });

    if (!data) return { error: "That sale isn't from this shop." };
    const { order, items, priorRows, paymentRows } = data;
    const prior = new Map(
      priorRows.map((p) => [p.order_item_id, Number(p.qty) || 0]),
    );

    // ★★ `orders.discount` HOLDS THREE THINGS: the line markdowns (already
    // inside each line's total), each line's `offer_discount`, and the
    // order-level remainder. Only the remainder may be re-allocated — an
    // offer's share belongs to the line that received it, so spreading it
    // refunds one line money it never paid and short-changes another.
    const lineDiscounts = items.reduce(
      (a, i) => a + (Number(i.line_discount) || 0),
      0,
    );
    const offerDiscounts = items.reduce(
      (a, i) => a + (Number(i.offer_discount) || 0),
      0,
    );
    const orderDiscount = Math.max(
      0,
      (Number(order.discount) || 0) - lineDiscounts - offerDiscounts,
    );

    // ── May this counter take it? ────────────────────────────────────────
    // An order bought online or at another branch is BORIS: it needs the store
    // switch plus this location's explicit `returns` capability.
    //
    // ★★ BUT A SALE RUNG HERE IS STILL ALWAYS RETURNABLE HERE (invariant 1).
    // `returns.enabled` DEFAULTS OFF, and the till has taken returns of its own
    // sales since pos_12 — so gating that on the master switch would silently
    // remove a working capability from every existing POS merchant the moment
    // this deploys, with no migration to turn it back on. A default that
    // changes what a live shop can do is a migration bug wearing a config hat.
    //
    // So the switch governs the NEW capability (returns of orders this counter
    // did not sell) and the POLICY layer (window, reason, fees, exchanges).
    // The pre-existing own-sale path is grandfathered and runs with the legacy
    // semantics it always had: no window, no required reason, no fee, no
    // exchange — see `policyApplies` below.
    const broughtIn =
      order.sales_channel !== "pos" || order.location_id !== op.locationId;
    if (broughtIn) {
      if (!policy.enabled) {
        return {
          error:
            "Returns are switched off for this store. An owner can enable them in Orders settings.",
        };
      }
      const verdict = canTakeReturnHere({
        soldHere: false,
        storeAllows: policy.allowInStore,
        locationAccepts: policy.locationAccepts,
      });
      if (!verdict.allowed) return { error: verdict.reason };
    }

    // Whether the merchant's configured return POLICY applies to this sale.
    // False only for the grandfathered own-sale path above, where every policy
    // value has to read as "unset" rather than as the registry default — a
    // 7-day `returns.windowDays` a merchant never chose must not start
    // refusing till returns it has always accepted.
    const policyApplies = policy.enabled;

    const routing = refundRouting(
      {
        payment_method: order.payment_method,
        payment_status: order.payment_status,
        total: Number(order.total) || 0,
        store_credit_used: Number(order.store_credit_used) || 0,
        customer_id: order.customer_id ?? null,
      },
      paymentRows,
    );
    const orderInfo = {
      status: order.collected_at ? "completed" : order.status,
      deliveredAt: order.delivered_at,
      collectedAt: order.collected_at,
      createdAt: order.created_at,
    };

    return {
      sale: {
        orderId: order.id,
        broughtIn,
        refundRoute: routing.route,
        refundTenders: routing.tenders,
        allowExchanges: policyApplies && policy.allowExchanges,
        requireReason: policyApplies && policy.requireReason,
        restockingFeePercent: policyApplies ? policy.restockingFeePercent : 0,
        receiptNo: order.receipt_no ?? "",
        orderRef: order.order_ref ?? "",
        createdAt: order.created_at,
        total: Number(order.total) || 0,
        orderDiscount,
        taxInclusive: order.tax_inclusive === true,
        paymentMethod: order.payment_method ?? "",
        lines: items.map((i) => {
          const returned = prior.get(i.id) ?? 0;
          // Grandfathered own-sale returns skip eligibility entirely rather
          // than passing `enabled: true` with a default window: `final_sale`
          // and the per-product window override are part of the same feature
          // the merchant has not switched on, and applying half of it would
          // block returns this till used to take.
          const eligibility = policyApplies
            ? returnEligibility(
                orderInfo,
                {
                  returnable: i.product_returnable,
                  returnWindowDays: i.product_window,
                },
                { enabled: true, windowDays: policy.windowDays },
              )
            : { eligible: true as const, reason: undefined, until: null };
          return {
            id: i.id,
            productId: i.product_id,
            variantId: i.variant_id,
            name: i.name,
            variantName: i.variant_name,
            quantity: Number(i.quantity) || 0,
            returned,
            remaining: remainingQty({
              id: i.id,
              quantity: Number(i.quantity) || 0,
              lineTotal: Number(i.total) || 0,
              taxAmount: Number(i.tax_amount) || 0,
              alreadyReturned: returned,
            }),
            unitPrice: Number(i.price) || 0,
            lineTotal: Number(i.total) || 0,
            taxAmount: Number(i.tax_amount) || 0,
            offerDiscount: Number(i.offer_discount) || 0,
            eligible: eligibility.eligible,
            blockedCopy: eligibility.reason
              ? RETURN_BLOCKED_COPY[eligibility.reason]
              : null,
            returnUntil: eligibility.until,
          };
        }),
      },
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't load that sale.") };
  }
}

export interface ReturnLineInput {
  orderItemId: string;
  quantity: number;
  condition?: ReturnCondition;
}

export interface ReturnResult {
  returnId?: string;
  /** Money that actually SETTLED. A leg still confirming at the bank, or one
   *  that failed, is not counted — it is described in `note` instead. */
  refunded?: number;
  /** The goods came back but the money needs a word — a gateway refund that
   *  failed or hasn't confirmed. NOT an error: the return stands. */
  note?: string;
  /** This exact return attempt (same retry key) was recorded by an earlier
   *  submission. Nothing new was taken back or refunded by THIS call; the
   *  return id and amount are the original's. */
  alreadyRecorded?: boolean;
  error?: string;
  verificationRequired?: boolean;
  /** The OTP cannot run on this order at all — see `override_verification`. */
  verificationUnavailable?: boolean;
  canOverrideVerification?: boolean;
}

export interface PosExchangeContext {
  returnId: string;
  originalLabel: string;
  returnedValue: number;
  customer: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    storeCredit: number;
  };
}

/** Resume the second half of an exchange on Sell with the original customer
 * attached. The return id in the URL is only a lookup key; store, location,
 * lifecycle, policy and customer ownership are all re-proved here. */
export async function getPosExchangeContext(
  returnId: string,
): Promise<{ context?: PosExchangeContext; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };
  if (typeof returnId !== "string" || !returnId) {
    return { error: "Invalid exchange." };
  }
  const policy = await getCounterReturnPolicy(op.storeId, op.locationId);
  if (!policy.enabled || !policy.allowExchanges) {
    return { error: "Exchanges are switched off for this store." };
  }

  try {
    const rows = await withService((db) =>
      db
        .select({
          return_id: orderReturns.id,
          returned_value: orderReturns.total,
          exchange_order_id: orderReturns.exchangeOrderId,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
          first_name: users.firstName,
          last_name: users.lastName,
          phone: users.phone,
          email: users.email,
        })
        .from(orderReturns)
        .innerJoin(orders, eq(orders.id, orderReturns.orderId))
        .innerJoin(
          users,
          and(eq(users.id, orders.customerId), eq(users.storeId, op.storeId)),
        )
        .where(
          and(
            eq(orderReturns.id, returnId),
            eq(orderReturns.storeId, op.storeId),
            eq(orderReturns.locationId, op.locationId),
            eq(orderReturns.status, "completed"),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row?.customer_id) return { error: "That exchange isn't available." };
    if (row.exchange_order_id) {
      return { error: "A replacement sale is already linked to this return." };
    }
    const storeCredit = await getCreditBalance(op.storeId, row.customer_id);
    const name = [row.first_name, row.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    return {
      context: {
        returnId: row.return_id,
        originalLabel: row.order_ref,
        returnedValue: Number(row.returned_value) || 0,
        customer: {
          id: row.customer_id,
          name: name || row.phone || "Customer",
          phone: row.phone ?? "",
          email: row.email ?? null,
          storeCredit,
        },
      },
    };
  } catch (error) {
    return { error: dbErrorMessage(error, "Couldn't open that exchange.") };
  }
}

/**
 * The answer to a retry of a return that already committed.
 *
 * Rebuilt from what was stored rather than replayed: the return id is the
 * original's, and `refunded` is what has SETTLED against it so far — the same
 * definition the original call reported. Nothing is taken back, restocked,
 * refunded, announced or audited a second time. Returns null when no return
 * carries the key (the caller then reports its own error).
 */
async function alreadyRecordedReturn(
  storeId: string,
  orderId: string,
  key: string,
): Promise<ReturnResult | null> {
  const found = await withService(async (db) => {
    const rows = await db
      .select({ id: orderReturns.id, order_id: orderReturns.orderId })
      .from(orderReturns)
      .where(
        and(
          eq(orderReturns.storeId, storeId),
          eq(orderReturns.idempotencyKey, key),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.order_id !== orderId) return { wrongOrder: true as const };
    const refunds = await db
      .select({ amount: orderRefunds.amount, status: orderRefunds.status })
      .from(orderRefunds)
      .where(
        and(
          eq(orderRefunds.storeId, storeId),
          eq(orderRefunds.returnId, row.id),
        ),
      );
    return { id: row.id, refunds };
  });
  if (!found) return null;
  if ("wrongOrder" in found) {
    // A key is minted per attempt on ONE order; reusing it on another is a
    // client bug, never a retry. Refuse rather than report someone else's
    // return as this one's.
    return {
      error:
        "This return couldn't be sent safely. Reload the page and try again.",
    };
  }
  const settled = round2(
    found.refunds
      .filter((r) => r.status === "completed")
      .reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
  );
  const stillConfirming = found.refunds.some((r) => r.status === "pending");
  return {
    returnId: found.id,
    refunded: settled,
    alreadyRecorded: true,
    note: stillConfirming
      ? "The bank refund for it is still confirming. Do not send it a second time."
      : undefined,
  };
}

/**
 * Take goods back and hand the money over.
 *
 * The amount is never taken from the client: it is recomputed with
 * `refundBreakdown` from the sale's stored snapshot, so a tampered request can
 * change WHAT comes back but not what it is worth.
 */
export async function processReturn(
  orderId: string,
  lines: ReturnLineInput[],
  method: RefundMethod,
  reason?: ReturnReason,
  opts: {
    /** A manager's attestation that the customer cannot be verified by code.
     *  Honoured only after the server confirms the order has no mobile. */
    acknowledgeUnverifiedCustomer?: boolean;
    /**
     * One key per return ATTEMPT, minted by the till (`crypto.randomUUID()`)
     * and kept until that attempt succeeds or the cashier changes what is
     * coming back. A second submission carrying it — a retry after a lost
     * response, a double tap — is answered with the FIRST return instead of
     * booking another one. Optional, so an older till keeps working exactly
     * as before.
     */
    idempotencyKey?: string;
  } = {},
): Promise<ReturnResult> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "refund")) {
    return { error: "You don't have permission to take returns." };
  }
  if (!REFUND_METHODS.includes(method)) {
    return { error: "Choose how the money goes back." };
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    return { error: "Choose what's coming back." };
  }
  // ★★ A PARTIAL RETURN USED TO BE REPEATABLE. The row lock below stops two
  // submissions taking the SAME units, but a partial return leaves units
  // behind, so a retry after a lost response re-priced what was left and
  // booked a second return and a second refund for goods handed over once.
  // The key is validated here, before anything is read, and looked up INSIDE
  // the locked transaction below. Absent = an older till: no lookup at all.
  const rawKey = opts.idempotencyKey;
  if (rawKey !== undefined && rawKey !== null && !isReturnAttemptKey(rawKey)) {
    return {
      error:
        "This return couldn't be sent safely. Reload the page and try again.",
    };
  }
  const idempotencyKey = isReturnAttemptKey(rawKey) ? rawKey : null;
  // The same dead end the hand-over counter had: an order carrying no textable
  // mobile could never be taken back at all. `refund` is already manager-and-
  // above, so the operator standing here is the one `override_verification`
  // names — but it is still a separate, recorded decision, and the server
  // re-derives that no mobile exists before the acknowledgement counts.
  const verified = await gateCustomerVerification({
    op,
    orderId,
    purpose: "return",
    acknowledged: opts.acknowledgeUnverifiedCustomer === true,
    mayOverride: posCan(op.role, "override_verification"),
    requiredCopy:
      "Verify the customer's mobile number before taking this return.",
  });
  if (!verified.ok) {
    return "verificationRequired" in verified
      ? { error: verified.error, verificationRequired: true }
      : {
          error: verified.error,
          verificationUnavailable: true,
          canOverrideVerification: verified.canOverride,
        };
  }

  // getReturnableSale re-runs the BORIS gates, so a counter that may not take
  // this order can't reach the write by calling processReturn directly.
  const { sale, error } = await getReturnableSale(orderId);
  if (error || !sale)
    return { error: error ?? "That sale isn't from this shop." };

  const reasonCode = isReturnReason(reason) ? reason : null;
  if (sale.requireReason && !reasonCode) {
    return { error: "Choose why the items are coming back." };
  }

  const selectedIds = new Set(lines.map((line) => line.orderItemId));
  const blocked = sale.lines.find(
    (line) => selectedIds.has(line.id) && !line.eligible,
  );
  if (blocked) {
    return {
      error: blocked.blockedCopy ?? `"${blocked.name}" can't be returned.`,
    };
  }

  // ★ THE TENDER DECIDES WHERE THE MONEY GOES — the till hides the wrong
  // options, and this is the server refusing them anyway. Handing cash back
  // for a card sale is the card-not-present laundering path.
  const route = sale.refundRoute;
  const allowedMethod = route.counterChoice
    ? method === "cash" || method === "card" || method === "upi"
    : method === route.method;
  if (!allowedMethod) {
    return {
      error: route.counterChoice
        ? "Choose how the money goes back."
        : "Refund this payment to its original source.",
    };
  }

  const conditionOf = new Map(
    lines.map((l) => [
      l.orderItemId,
      l.condition === "damaged" ? "damaged" : "sellable",
    ]),
  );
  const lineById = new Map(sale.lines.map((l) => [l.id, l]));
  const shiftId = await currentShiftIdFor(op.locationId);

  // Every refund — cash, terminal, UPI, credit, gateway, and each leg of a
  // split — goes through the shared money core. This gives counter tenders the
  // same row lock and cap as Razorpay and records the original source instead
  // of letting the cashier convert a card payment into cash.
  const effectiveRoute: CounterRefundRoute = route.counterChoice
    ? { ...route, method }
    : route;

  // ★★ CASH OUT OBEYS `pos.requireOpenShift` THE WAY CASH IN DOES. A sale is
  // refused without an open shift when the merchant asks for one
  // (placePosSale); a cash refund was not, so the drawer could pay out with no
  // shift to count it against — money leaving a till that, by the merchant's
  // own setting, should not have been open. Only a route that would actually
  // take cash out of the drawer is affected; card, UPI, credit and gateway
  // refunds never touch it. The setting is read the way the collection
  // counter reads it (pos-pickup-actions), failing OPEN on a read error so a
  // settings blip cannot strand a customer at the counter; the refusal itself
  // lands inside the transaction below, after the retry-key lookup (a retry of
  // a return that already committed must still be answered) and before any
  // write.
  const paysCashFromDrawer =
    effectiveRoute.method === "cash" ||
    (effectiveRoute.method === "original" &&
      sale.refundTenders.some((t) => t.method === "cash" && t.amount > 0));
  let shiftRequired = false;
  if (!shiftId && paysCashFromDrawer) {
    try {
      shiftRequired =
        (await getStoreSettings())["pos.requireOpenShift"] === true;
    } catch {
      shiftRequired = false;
    }
  }

  let returnId: string;
  let breakdown: ReturnType<typeof refundBreakdown>;
  let refundTotal = 0;
  try {
    const written = await withService(async (db) => {
      // ★ LOCK THE ORDER, THEN RE-READ WHAT IS LEFT.
      //
      // `getReturnableSale` above answered "what may come back" a moment ago,
      // outside any transaction. Two counters serving the same customer — or
      // one cashier double-tapping Confirm — both read that answer before
      // either wrote, and both then handed over the full value: proven on
      // staging as ₹158 refunded against a ₹79 sale. The gateway path was
      // safe because issueRefund takes this same lock; the CASH path wrote
      // its refund row directly and was not protected by anything.
      const locked = await db
        .select({
          id: orders.id,
          total: orders.total,
          discount: orders.discount,
          store_credit_used: orders.storeCreditUsed,
          tax_inclusive: orders.taxInclusive,
        })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.storeId, op.storeId)))
        .limit(1)
        .for("update");
      if (!locked.length) return { error: "That sale isn't from this shop." };

      // ★ THE RETRY KEY IS CHECKED UNDER THE LOCK, BEFORE PRICING. Before
      // pricing, because a retry of a FULL return would otherwise be told
      // "nothing is still returnable" — true, and useless to a cashier who
      // cannot tell whether their first tap went through. Under the lock,
      // because a second submission racing the first then waits for it to
      // commit and finds its row here.
      if (idempotencyKey) {
        const prior = await db
          .select({ id: orderReturns.id })
          .from(orderReturns)
          .where(
            and(
              eq(orderReturns.storeId, op.storeId),
              eq(orderReturns.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        if (prior.length) return { duplicateOf: prior[0]!.id };
      }

      if (shiftRequired) {
        return { error: "Open a shift before giving cash back." };
      }

      const items = await db
        .select({
          id: orderItems.id,
          quantity: orderItems.quantity,
          total: orderItems.total,
          line_discount: orderItems.lineDiscount,
          offer_discount: orderItems.offerDiscount,
          tax_amount: orderItems.taxAmount,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      // Only OPEN returns hold units. Without the status filter a REJECTED
      // online request would keep blocking the counter, so a customer turned
      // down online could not bring the goods in either.
      const prior = items.length
        ? await db
            .select({
              order_item_id: orderReturnItems.orderItemId,
              qty: sql<number>`sum(${orderReturnItems.quantity})::int`,
            })
            .from(orderReturnItems)
            .innerJoin(
              orderReturns,
              eq(orderReturns.id, orderReturnItems.returnId),
            )
            .where(
              and(
                inArray(
                  orderReturnItems.orderItemId,
                  items.map((i) => i.id),
                ),
                inArray(orderReturns.status, OPEN_RETURN_STATUSES),
              ),
            )
            .groupBy(orderReturnItems.orderItemId)
        : [];
      const returnedBy = new Map(
        prior.map((p) => [p.order_item_id, Number(p.qty) || 0]),
      );

      const lineDiscounts = items.reduce(
        (a, i) => a + (Number(i.line_discount) || 0),
        0,
      );
      // An offer's share is subtracted from its OWN line below, so it must
      // come out of the order-level remainder here or it is counted twice.
      const offerDiscounts = items.reduce(
        (a, i) => a + (Number(i.offer_discount) || 0),
        0,
      );
      const returnable: ReturnableLine[] = items.map((i) => ({
        id: i.id,
        quantity: Number(i.quantity) || 0,
        lineTotal: Number(i.total) || 0,
        taxAmount: Number(i.tax_amount) || 0,
        offerDiscount: Number(i.offer_discount) || 0,
        alreadyReturned: returnedBy.get(i.id) ?? 0,
      }));

      const priced = refundBreakdown({
        lines: returnable,
        orderDiscount: Math.max(
          0,
          (Number(locked[0]!.discount) || 0) - lineDiscounts - offerDiscounts,
        ),
        // ★★ Read under the lock with everything else that prices the
        // return: on a tax-inclusive order each line's tax is already inside
        // its total, and adding it again refunded the tax twice.
        taxInclusive: locked[0]!.tax_inclusive === true,
        request: lines.map((l) => ({
          id: l.orderItemId,
          quantity: l.quantity,
        })),
      });
      if (priced.lines.length === 0 || priced.total <= 0) {
        return { error: "Nothing on this sale is still returnable." };
      }

      // An in-store return has no return-postage deduction. The configured
      // restocking fee still applies to no-fault reasons, and is automatically
      // waived for damage/wrong-item/other merchant-fault reasons.
      const fees = feesFor(
        reasonCode,
        {
          restockingFeePercent: sale.restockingFeePercent,
          returnShippingFee: 0,
        },
        priced.amount,
      );
      const payable =
        Math.round(Math.max(0, priced.total - fees.totalDeduction) * 100) / 100;

      // ★ AND CAP IT AGAINST WHAT THE ORDER CAN STILL GIVE BACK. The quantity
      // clamp above bounds the GOODS; this bounds the MONEY, which is the
      // thing leaving the drawer. issueRefund applies the same caps per leg,
      // but only AFTER the return below is written and the stock restocked —
      // so a refusal there leaves goods back and nothing paid. This check
      // therefore covers EVERY route that moves money, the gateway included
      // (it used to skip Razorpay, which is how a Razorpay leg larger than
      // what money paid on a credit-funded order was refused only after the
      // fact). Only `none` — no money moves here — has nothing to cap (and
      // `method` can only be `none` when the route is, by the check above).
      if (route.method !== "none" && method !== "none") {
        const existing = await db
          .select({
            amount: orderRefunds.amount,
            status: orderRefunds.status,
            method: orderRefunds.method,
          })
          .from(orderRefunds)
          .where(eq(orderRefunds.orderId, orderId));
        const capInput = {
          orderTotal: Number(locked[0]!.total ?? 0),
          refunds: existing.map((r) => ({
            amount: Number(r.amount ?? 0),
            status: r.status,
            method: r.method,
          })),
          storeCreditUsed: Number(locked[0]!.store_credit_used ?? 0),
        };

        if (method === "original") {
          // ★★ A SPLIT HAS TWO CEILINGS, AND ONLY ONE OF THEM IS THE MONEY ONE.
          //
          // refundableAmount caps a MONEY method at what money actually paid,
          // because the store-credit share of the total was never received by
          // any instrument (§29). Passing a stand-in "cash" for the whole
          // split therefore measured the credit leg against the money ceiling:
          // a ₹500 sale settled ₹200 credit + ₹300 cash could never be fully
          // returned, because ₹500 > the ₹300 money cap — even though the
          // allocation sends exactly ₹200 back to credit and ₹300 to cash, and
          // each leg passes its own cap inside issueRefund.
          //
          // So check the two ceilings the allocation actually spends against:
          // the overall cap for the whole refund, and the money cap for only
          // the legs that move money. With no store credit on the order the
          // two are equal and this is byte-for-byte the old behaviour.
          const planned = allocateRefund(payable, route, sale.refundTenders);
          const moneyPart =
            Math.round(
              planned
                .filter((a) => a.method !== "store_credit")
                .reduce((sum, a) => sum + a.amount, 0) * 100,
            ) / 100;
          const overallCap = refundableAmount({ ...capInput, method: null });
          const moneyCap = refundableAmount({ ...capInput, method: "cash" });
          if (payable > overallCap) {
            return {
              error:
                overallCap > 0
                  ? `You can refund at most ₹${overallCap.toFixed(2)} on this sale.`
                  : "This sale has already been fully refunded.",
            };
          }
          if (moneyPart > moneyCap) {
            return {
              error: `Only ₹${moneyCap.toFixed(2)} of this sale was paid with money that can go back; the rest was settled with store credit.`,
            };
          }
        } else {
          const cap = refundableAmount({ ...capInput, method });
          if (payable > cap) {
            return {
              error:
                cap > 0
                  ? `You can refund at most ₹${cap.toFixed(2)} on this sale.`
                  : "This sale has already been fully refunded.",
            };
          }
        }
      }

      const inserted = await db
        .insert(orderReturns)
        .values({
          storeId: op.storeId,
          orderId,
          locationId: op.locationId,
          shiftId: shiftId ?? null,
          amount: priced.amount,
          tax: priced.tax,
          total: payable,
          restockingFee: fees.restockingFee,
          returnShippingFee: 0,
          reasonCode,
          reason: reasonCode,
          actor: op.staffId ?? op.name,
          // The unique (store_id, idempotency_key) index is the backstop for
          // a race the lookup above cannot see; null for an older till.
          idempotencyKey,
        })
        .returning({ id: orderReturns.id });
      const id = inserted[0]!.id;

      await db.insert(orderReturnItems).values(
        priced.lines.map((l) => ({
          returnId: id,
          orderItemId: l.id,
          quantity: l.quantity,
          amount: l.amount,
          tax: l.tax,
          total: l.total,
          condition: conditionOf.get(l.id) ?? "sellable",
          // Set truthfully below — the stock write can fail independently.
          restocked: false,
        })),
      );

      return { id, priced, payable };
    });
    if ("error" in written) return { error: written.error };
    if ("duplicateOf" in written) {
      // The first submission committed; this is its retry. Answer with it.
      const again = await alreadyRecordedReturn(
        op.storeId,
        orderId,
        idempotencyKey!,
      );
      await clearCustomerVerification();
      return (
        again ?? {
          returnId: written.duplicateOf,
          alreadyRecorded: true,
        }
      );
    }
    returnId = written.id;
    breakdown = written.priced;
    refundTotal = written.payable;
  } catch (err) {
    // ★ The lookup above runs under the order lock, so a same-key race on one
    // order serialises and finds the first row. The unique index catches what
    // that cannot — and a violation on it means the attempt IS recorded.
    if (idempotencyKey && isUniqueViolation(err)) {
      const again = await alreadyRecordedReturn(
        op.storeId,
        orderId,
        idempotencyKey,
      ).catch(() => null);
      if (again) {
        await clearCustomerVerification();
        return again;
      }
    }
    return { error: dbErrorMessage(err, "Couldn't record the return.") };
  }

  // Put the sellable units back. AFTER the records, deliberately: the money is
  // already across the counter by this point, so a stock write that fails must
  // not undo a refund that physically happened. A missed restock shows up in
  // the next count; an unrecorded refund never shows up at all.
  const restocked: string[] = [];
  for (const l of breakdown.lines) {
    if ((conditionOf.get(l.id) ?? "sellable") !== "sellable") continue;
    const src = lineById.get(l.id);
    if (!src?.productId) continue;
    try {
      await withService((db) =>
        db.execute(
          sql`select adjust_stock_at(p_store => ${op.storeId}, p_location => ${op.locationId}, p_product => ${src.productId}, p_variant => ${src.variantId || null}, p_delta => ${l.quantity}, p_reason => ${"return"}, p_note => ${`Return on ${sale.receiptNo || sale.orderRef}`}, p_actor => ${op.staffId ?? op.name}) as new_stock`,
        ),
      );
      restocked.push(l.id);
    } catch (err) {
      // ★ The money has ALREADY crossed the counter by this point, so this
      // can't be undone — the goods are back on the shelf and the count is
      // wrong until someone notices. Exactly the silent failure that belongs
      // in Error Reporting rather than a console line nobody reads.
      logError("pos.return_restock", err, { returnId, orderItemId: l.id });
    }
  }

  if (restocked.length > 0) {
    await withService((db) =>
      db
        .update(orderReturnItems)
        .set({ restocked: true })
        .where(
          and(
            eq(orderReturnItems.returnId, returnId),
            inArray(orderReturnItems.orderItemId, restocked),
          ),
        ),
    ).catch((err) => logError("pos.return_restock_flag", err, { returnId }));

    // Coming back on the shelf can cross a low-stock threshold in reverse —
    // the same reporting a sale does, with a positive delta.
    reportStockChanges(
      op.storeId,
      breakdown.lines
        .filter((l) => restocked.includes(l.id))
        .map((l) => ({
          productId: lineById.get(l.id)!.productId!,
          variantId: lineById.get(l.id)!.variantId,
          delta: l.quantity,
        })),
    );
  }

  const allocations = allocateRefund(
    refundTotal,
    effectiveRoute,
    sale.refundTenders,
  ).filter((allocation) => allocation.amount > 0);
  const notes: string[] = [];
  // ★★ ONLY MONEY THAT SETTLED IS ANNOUNCED. This summed every leg that came
  // back without an error — including a gateway leg still `pending` at the
  // bank and one Razorpay answered `failed` — so the customer's refund email
  // and the money audit claimed money that had not gone back, and a return
  // whose every leg was refused still announced "₹0 refunded". A leg counts
  // only once issueRefund reports it `completed`; anything else is described
  // to the cashier instead.
  let settled = 0;
  const settledMethods: TenderMethod[] = [];
  for (const allocation of allocations) {
    const res = await issueRefund({
      storeId: op.storeId,
      orderId,
      amount: allocation.amount,
      method: allocation.method,
      gatewayPaymentId:
        allocation.method === "razorpay" ? allocation.reference : null,
      actor: op.staffId ?? op.name,
      reason: reasonCode ?? "Returned in store",
      returnId,
      // Gateway refunds never touch the drawer. All recorded counter tenders
      // retain the location; only cash contributes to drawer arithmetic.
      locationId: allocation.method === "razorpay" ? null : op.locationId,
      shiftId: allocation.method === "cash" ? (shiftId ?? null) : null,
    });
    if (res.error) {
      notes.push(
        allocation.method === "razorpay" && res.code === "gateway_not_connected"
          ? "The card refund couldn't be sent; ask the owner to complete it from the dashboard."
          : `${REFUND_LABEL[allocation.method]} refund needs attention: ${res.error}`,
      );
      continue;
    }
    if (res.status === "completed") {
      settled += res.amount ?? allocation.amount;
      if (!settledMethods.includes(allocation.method)) {
        settledMethods.push(allocation.method);
      }
    } else if (res.pendingReconcile || res.status === "pending") {
      notes.push(
        "The bank refund is still confirming. Do not send it a second time.",
      );
    } else if (res.status === "failed") {
      notes.push(
        `The ${REFUND_LABEL[allocation.method]} refund didn't go through. Complete it from the order dashboard.`,
      );
    } else {
      notes.push(
        `${REFUND_LABEL[allocation.method]} refund needs attention. Check the order in the dashboard.`,
      );
    }
  }
  settled = round2(settled);
  if (refundTotal === 0) {
    notes.push(
      "The return was recorded; the policy deductions leave no refund.",
    );
  } else if (effectiveRoute.method === "none") {
    // Deliberate: this order's money is not handed back at a counter.
    notes.push(
      `The items were taken back, but no money was handed over here. Refund ₹${refundTotal.toFixed(2)} from the order in the dashboard.`,
    );
  } else if (allocations.length === 0) {
    notes.push(
      "The return was recorded, but its original payment details are missing. Complete the refund from the order dashboard.",
    );
  }

  const itemCount = breakdown.lines.reduce((a, l) => a + l.quantity, 0);
  if (settled > 0) {
    emitEvent({
      type: "order.refund_issued",
      storeId: op.storeId,
      locationId: op.locationId,
      actor: { type: "admin", id: op.staffId ?? null, label: op.name },
      subject: {
        type: "order",
        id: orderId,
        label: sale.receiptNo || sale.orderRef,
      },
      payload: {
        // `amount`, not `total` — see refund-actions.ts.
        amount: settled,
        currency: "INR",
        // Named after the legs that SETTLED, so the copy never says a card
        // was credited when only the store-credit half went through.
        paymentMethod:
          settledMethods.length > 1 ? "original split" : settledMethods[0]!,
        items: itemCount,
      },
    });

    // ── The money audit (Step 14) ───────────────────────────────────────────
    // A till refund is a discretionary act — someone decided to hand money
    // back — and `order_refunds` records the amount but not who stood at the
    // counter. ★ Only for money that actually settled, so a refused or
    // still-confirming refund logs nothing here (its `order_refunds` row is
    // the record of it).
    posAudit({
      storeId: op.storeId,
      event: "refund_issued",
      locationId: op.locationId,
      staffId: op.staffId,
      actor: op.name,
      amount: settled,
      orderId,
      detail: `${sale.receiptNo || sale.orderRef || orderId.slice(0, 8)} · ${method} · ${itemCount} item(s)`,
    });
  }

  // A SEPARATE row from `refund_issued` above, deliberately: that one answers
  // "who gave money back", this one answers "and nobody checked who they were".
  // Folding the second fact into the first's `detail` would hide it from the
  // only question it can ever be asked by — "show me the overrides".
  if (verified.overridden) {
    posAudit({
      storeId: op.storeId,
      event: "identity_override",
      locationId: op.locationId,
      staffId: op.staffId,
      actor: op.name,
      orderId,
      detail: `Return taken without customer verification - no mobile on the order`,
    });
  }

  revalidatePath("/pos/sales");
  await clearCustomerVerification();
  // Two legs still confirming would otherwise say so twice.
  const uniqueNotes = Array.from(new Set(notes));
  return {
    returnId,
    refunded: settled,
    note: uniqueNotes.length > 0 ? uniqueNotes.join(" ") : undefined,
  };
}
