import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orders, shipments, storeLocations } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { storedPhoneVariants } from "@/lib/phone";
import { customerStatusLabel, isPickup } from "@/lib/orders/customer-status";

// ---------------------------------------------------------------------------
// The answer to "where is my order?" on WhatsApp (docs/whatsapp-commerce-plan.md
// §4, Automation; stories WA-5.x).
//
// ★★ THE PHONE THAT ASKS IS WHO THE ANSWER IS ABOUT. WhatsApp proves the sender
// holds the number, and the orders reported are the ones that number owns: the
// account with that phone on this store, or the delivery phone on the order.
// The same rule the COD buttons follow (cod-confirmation.ts) and the inbox's
// customer panel reads by. Nothing is said about any other order.
//
// ★ IT SAYS ONLY WHAT THE ORDER PAGE SAYS. Order number, the day it was placed,
// the status in the storefront's own words (lib/orders/customer-status.ts),
// and the courier's tracking link. No items, no amounts, no address: a chat
// message is easily forwarded, and the order page is a sign-in away.
//
// ★ IT HANDS OVER WHEN IT CANNOT ANSWER. No order for the number, a lookup
// that failed, or a delivery in trouble (the courier could not deliver, it is
// on its way back, it was lost) all end with "someone will reply here" and the
// conversation waiting for a person, never with a guess.
// ---------------------------------------------------------------------------

export interface OrderShipmentForStatus {
  status: string;
  courierName: string | null;
  awb: string | null;
  trackingUrl: string | null;
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
}

export interface OrderForStatus {
  id: string;
  orderRef: string;
  createdAt: string;
  status: string;
  fulfilmentType: string | null;
  pickupStatus: string | null;
  pickupReadyAt: string | null;
  pickupExpiresAt: string | null;
  pickupLocationName: string | null;
  deliveredAt: string | null;
  shipment: OrderShipmentForStatus | null;
}

export type OrderLookup =
  | { ok: true; orders: OrderForStatus[] }
  | { ok: false };

/** Open orders listed by name; the rest are counted. */
export const MAX_ORDERS_IN_ANSWER = 3;
/** A finished order older than this is not "my order" any more. */
export const FINISHED_ORDER_DAYS = 60;
/** How many recent orders the lookup reads. */
const LOOKUP_LIMIT = 10;

function finished(order: OrderForStatus): boolean {
  if (["cancelled", "delivered", "completed"].includes(order.status)) {
    return true;
  }
  if (isPickup(asView(order))) {
    return (
      order.pickupStatus === "collected" || order.pickupStatus === "expired"
    );
  }
  return order.shipment?.status === "delivered";
}

function asView(order: OrderForStatus) {
  return {
    status: order.status,
    fulfilment_type: order.fulfilmentType,
    pickup_status: order.pickupStatus,
  };
}

/**
 * Which orders the answer is about. Pure. Every open order, newest first and
 * at most three by name; with none open, the latest order if it is recent.
 */
export function ordersToReport(
  all: OrderForStatus[],
  now: Date,
): { report: OrderForStatus[]; moreOpen: number; open: boolean } {
  const sorted = [...all].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const open = sorted.filter((o) => !finished(o));
  if (open.length > 0) {
    return {
      report: open.slice(0, MAX_ORDERS_IN_ANSWER),
      moreOpen: Math.max(0, open.length - MAX_ORDERS_IN_ANSWER),
      open: true,
    };
  }
  const latest = sorted[0];
  const recent =
    latest &&
    now.getTime() - Date.parse(latest.createdAt) <=
      FINISHED_ORDER_DAYS * 86_400_000;
  return { report: recent ? [latest] : [], moreOpen: 0, open: false };
}

function day(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleDateString("en-IN", {
      timeZone,
      day: "numeric",
      month: "short",
    });
  } catch {
    return date.toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
    });
  }
}

/** A tracking link we are willing to send: https only. */
function safeLink(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** "Order ORD10011027, placed 12 Oct: On the way with Delhivery." Pure. */
export function orderStatusLine(
  order: OrderForStatus,
  timeZone: string,
  now: Date,
): { text: string; trouble: boolean } {
  const placed = day(order.createdAt, timeZone);
  const head = `Order ${order.orderRef}${placed ? `, placed ${placed}` : ""}:`;

  if (isPickup(asView(order))) {
    return {
      text: `${head} ${pickupPhrase(order, timeZone, now)}`,
      trouble: false,
    };
  }

  if (order.status === "cancelled")
    return { text: `${head} Cancelled.`, trouble: false };

  const shipment =
    order.shipment && order.shipment.status !== "cancelled"
      ? order.shipment
      : null;
  // ★ The ORDER saying delivered wins over a parcel record that lags behind it.
  if (order.status === "delivered" || order.status === "completed") {
    const on = day(
      order.deliveredAt ?? shipment?.deliveredAt ?? null,
      timeZone,
    );
    return {
      text: `${head} Delivered${on ? ` on ${on}` : ""}.`,
      trouble: false,
    };
  }
  if (!shipment) {
    return {
      text: `${head} ${customerStatusLabel(asView(order))}.`,
      trouble: false,
    };
  }

  const courier = shipment.courierName?.trim() || null;
  const withCourier = courier ? ` with ${courier}` : "";
  let phrase: string;
  let trouble = false;
  switch (shipment.status) {
    case "delivered": {
      const on = day(shipment.deliveredAt ?? order.deliveredAt, timeZone);
      phrase = `Delivered${on ? ` on ${on}` : ""}.`;
      break;
    }
    case "out_for_delivery":
      phrase = `Out for delivery${withCourier}.`;
      break;
    case "picked_up":
    case "in_transit":
      phrase = `On the way${withCourier}.`;
      break;
    case "ready_to_ship":
    case "pickup_scheduled":
      phrase = `Packed and waiting for the courier${courier ? ` (${courier})` : ""}.`;
      break;
    case "ndr":
      phrase = "The courier couldn't deliver it.";
      trouble = true;
      break;
    case "rto_initiated":
    case "rto_in_transit":
      phrase = "The courier is returning it to us.";
      trouble = true;
      break;
    case "rto_delivered":
      phrase = "The courier returned it to us.";
      trouble = true;
      break;
    case "lost":
    case "damaged":
    case "error":
      phrase = "There is a problem with the delivery.";
      trouble = true;
      break;
    default:
      phrase = `${customerStatusLabel(asView(order))}.`;
  }

  const lines = [`${head} ${phrase}`];
  // A parcel still travelling gets its date and its link; a delivered one or a
  // troubled one does not (the link would only show the trouble again).
  if (shipment.status !== "delivered" && !trouble) {
    const expected = day(shipment.estimatedDeliveryAt, timeZone);
    if (expected) lines[0] += ` Expected by ${expected}.`;
    const link = safeLink(shipment.trackingUrl);
    if (link) lines.push(`Track it: ${link}`);
    else if (shipment.awb) lines.push(`Tracking number: ${shipment.awb}`);
  }
  return { text: lines.join("\n"), trouble };
}

function pickupPhrase(
  order: OrderForStatus,
  timeZone: string,
  now: Date,
): string {
  const at = order.pickupLocationName?.trim()
    ? ` at ${order.pickupLocationName.trim()}`
    : "";
  const label = customerStatusLabel(asView(order));
  if (label === "Ready to collect") {
    const until = day(order.pickupExpiresAt, timeZone);
    return `Ready to collect${at}.${until ? ` Held until ${until}.` : ""}`;
  }
  if (label === "Collected") return "Collected.";
  if (label === "Not collected") {
    return "It wasn't collected in time, so it was cancelled.";
  }
  if (label === "Cancelled") return "Cancelled.";
  const readyAt = order.pickupReadyAt ? new Date(order.pickupReadyAt) : null;
  const later =
    readyAt && !Number.isNaN(readyAt.getTime()) && readyAt > now
      ? ` Ready from ${day(order.pickupReadyAt, timeZone)}.`
      : "";
  return `Being prepared for collection${at}.${later}`;
}

export interface OrderStatusAnswer {
  body: string;
  /** True when a person must follow up: nothing found, or a delivery problem. */
  needsHuman: boolean;
  /** True when the answer named at least one order. */
  answered: boolean;
}

/** The whole message. Pure. */
export function orderStatusAnswer(input: {
  lookup: OrderLookup;
  storeName: string | null;
  timeZone: string;
  now: Date;
  /** The store's order page, when the store is open to the public. */
  ordersUrl: string | null;
}): OrderStatusAnswer {
  const shop = input.storeName?.trim() || "the shop";
  if (!input.lookup.ok) {
    return {
      body: `We couldn't look up your order just now. Someone from ${shop} will reply here.`,
      needsHuman: true,
      answered: false,
    };
  }
  const { report, moreOpen, open } = ordersToReport(
    input.lookup.orders,
    input.now,
  );
  if (report.length === 0) {
    return {
      body: `We couldn't find a recent order placed with this number. Someone from ${shop} will reply here.`,
      needsHuman: true,
      answered: false,
    };
  }

  const lines = report.map((o) =>
    orderStatusLine(o, input.timeZone, input.now),
  );
  const trouble = lines.some((l) => l.trouble);
  const intro = !open
    ? "Here's the latest on your last order:"
    : report.length + moreOpen === 1
      ? "Here's the latest on your order:"
      : `Here's the latest on your ${report.length + moreOpen} open orders:`;

  const parts = [intro, ...lines.map((l) => l.text)];
  if (moreOpen > 0) {
    parts.push(
      `You have ${moreOpen} more open ${moreOpen === 1 ? "order" : "orders"}.`,
    );
  }
  if (input.ordersUrl) parts.push(`See all your orders: ${input.ordersUrl}`);
  parts.push(
    trouble
      ? `Someone from ${shop} will look into this and reply here.`
      : "Reply here if you need anything else.",
  );
  return { body: parts.join("\n\n"), needsHuman: trouble, answered: true };
}

/**
 * The recent orders a phone owns on a store. Never throws: a failed read is
 * `{ ok: false }`, which the answer turns into a hand-over.
 */
export async function lookupOrdersForPhone(input: {
  storeId: string;
  phone: string;
  /** The account on this store whose phone matched, when there is one. */
  userId: string | null;
}): Promise<OrderLookup> {
  const variants = storedPhoneVariants(input.phone);
  if (variants.length === 0 && !input.userId) return { ok: true, orders: [] };
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: orders.id,
          orderRef: orders.orderRef,
          createdAt: orders.createdAt,
          status: orders.status,
          fulfilmentType: orders.fulfilmentType,
          pickupStatus: orders.pickupStatus,
          pickupReadyAt: orders.pickupReadyAt,
          pickupExpiresAt: orders.pickupExpiresAt,
          pickupLocationName: storeLocations.name,
          deliveredAt: orders.deliveredAt,
        })
        .from(orders)
        .leftJoin(
          storeLocations,
          and(
            eq(storeLocations.id, orders.pickupLocationId),
            eq(storeLocations.storeId, orders.storeId),
          ),
        )
        .where(
          and(
            // ★ The store the message arrived for; the tables are service-only,
            // so this predicate is the tenant boundary.
            eq(orders.storeId, input.storeId),
            sql`(${input.userId ? sql`${orders.customerId} = ${input.userId} or ` : sql``}${orders.shippingAddress}->>'phone' = any(${sql.param(variants)}::text[]))`,
            // A till sale is finished at the counter; there is nothing to track.
            sql`${orders.salesChannel} is distinct from 'pos'`,
            // An online payment never completed is not an order the customer
            // has; it was never announced (checkout-actions.ts).
            sql`not (${orders.paymentMethod} = 'razorpay' and ${orders.paymentStatus} in ('pending', 'failed'))`,
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(LOOKUP_LIMIT),
    );
    if (rows.length === 0) return { ok: true, orders: [] };

    const parcels = await withService((db) =>
      db
        .select({
          orderId: shipments.orderId,
          status: shipments.status,
          courierName: shipments.courierName,
          awb: shipments.awb,
          trackingUrl: shipments.trackingUrl,
          estimatedDeliveryAt: shipments.estimatedDeliveryAt,
          deliveredAt: shipments.deliveredAt,
        })
        .from(shipments)
        .where(
          and(
            eq(shipments.storeId, input.storeId),
            inArray(
              shipments.orderId,
              rows.map((r) => r.id),
            ),
          ),
        )
        .orderBy(desc(shipments.createdAt)),
    );
    // The newest live parcel per order; a cancelled one only when it is all
    // there is.
    const byOrder = new Map<string, OrderShipmentForStatus>();
    for (const p of parcels) {
      const current = byOrder.get(p.orderId);
      if (
        !current ||
        (current.status === "cancelled" && p.status !== "cancelled")
      ) {
        byOrder.set(p.orderId, {
          status: p.status,
          courierName: p.courierName,
          awb: p.awb,
          trackingUrl: p.trackingUrl,
          estimatedDeliveryAt: p.estimatedDeliveryAt,
          deliveredAt: p.deliveredAt,
        });
      }
    }

    return {
      ok: true,
      orders: rows.map((r) => ({
        id: r.id,
        orderRef: r.orderRef,
        createdAt: r.createdAt,
        status: r.status,
        fulfilmentType: r.fulfilmentType,
        pickupStatus: r.pickupStatus,
        pickupReadyAt: r.pickupReadyAt,
        pickupExpiresAt: r.pickupExpiresAt,
        pickupLocationName: r.pickupLocationName,
        deliveredAt: r.deliveredAt,
        shipment: byOrder.get(r.id) ?? null,
      })),
    };
  } catch (err) {
    logError("whatsapp order status: lookup failed", err, {
      storeId: input.storeId,
    });
    return { ok: false };
  }
}
