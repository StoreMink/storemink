// Shared status vocabulary for the shopper-facing order pages.
//
// The labels themselves live in lib/orders/customer-status.ts, shared with the
// WhatsApp "where is my order" answer so the two can never disagree; they are
// re-exported here so every page keeps importing from one place.

import { Store } from "lucide-react";
import {
  CUSTOMER_STATUS_LABEL,
  customerStatusLabel,
  isPickup,
  type OrderStatusView,
} from "@/lib/orders/customer-status";
import styles from "./orders.module.css";

export {
  CUSTOMER_STATUS_LABEL,
  customerStatusLabel,
  isPickup,
  type OrderStatusView,
};

export const ORDER_FLOW = [
  "pending",
  "processing",
  "shipped",
  "delivered",
] as const;

/**
 * ★ A COLLECTION IS NOT A DELIVERY WITH A DIFFERENT ADDRESS.
 *
 * "On the way" and "Delivered" describe a van. A shopper who chose to walk in
 * is waiting for one thing only — the shop to finish packing — and then it's
 * their own trip. Showing them a courier's journey is both wrong and useless:
 * it never advances past "Being prepared", because nothing ships.
 *
 * So pickup gets its own four steps. Same shape, so the tracker component
 * doesn't branch; different words, because they describe a different thing.
 */
export const PICKUP_FLOW_LABELS = [
  "Order placed",
  "Being prepared",
  "Ready to collect",
  "Collected",
] as const;

const DELIVERY_FLOW_LABELS = ORDER_FLOW.map(
  (s) => CUSTOMER_STATUS_LABEL[s],
) as readonly string[];

export function isPosSale(order: OrderStatusView): boolean {
  return order.sales_channel === "pos";
}

/**
 * How far along the tracker is, and what its steps are called.
 *
 * `reached` is the index of the furthest step reached, -1 for none.
 */
export function orderProgress(order: OrderStatusView): {
  steps: readonly string[];
  reached: number;
} {
  if (isPickup(order)) {
    let reached = 0; // the order exists, so "Order placed" is always done
    if (order.status === "processing" || order.status === "shipped")
      reached = 1;
    if (order.pickup_status === "ready") reached = 2;
    if (order.pickup_status === "collected" || order.status === "completed") {
      reached = 3;
    }
    return { steps: PICKUP_FLOW_LABELS, reached };
  }

  // "completed" is not in ORDER_FLOW, so indexOf returned -1 and a finished
  // order rendered as a completely un-started track.
  const reached =
    order.status === "completed"
      ? DELIVERY_FLOW_LABELS.length - 1
      : ORDER_FLOW.indexOf(order.status as (typeof ORDER_FLOW)[number]);
  return { steps: DELIVERY_FLOW_LABELS, reached };
}

const PILL_CLASS: Record<string, string> = {
  "Order placed": styles.pillPending,
  "Being prepared": styles.pillProcessing,
  "On the way": styles.pillShipped,
  "Ready to collect": styles.pillReady,
  Delivered: styles.pillDelivered,
  Collected: styles.pillDelivered,
  Completed: styles.pillDelivered,
  Cancelled: styles.pillCancelled,
  "Not collected": styles.pillCancelled,
};

export function StatusPill({ order }: { order: OrderStatusView }) {
  const label = customerStatusLabel(order);
  return (
    <span
      className={`${styles.pill} ${PILL_CLASS[label] ?? styles.pillPending}`}
    >
      {label}
    </span>
  );
}

/**
 * "Pickup" — said plainly, on the order itself.
 *
 * The status badge alone can't carry it: "Order placed" looks identical
 * whether a van is coming or the shopper has to drive over, and that is
 * exactly the thing they need to remember a week later.
 */
export function FulfilmentBadge({ order }: { order: OrderStatusView }) {
  if (!isPickup(order) && !isPosSale(order)) return null;
  return (
    <span className={styles.fulfilBadge}>
      <Store size={12} aria-hidden />
      {isPosSale(order) ? "In store" : "Pickup"}
    </span>
  );
}

/**
 * What a collection order says about when to come, and until when.
 *
 * ★ It quotes the date the shop PROMISED AT CHECKOUT (`pickup_ready_at`), not
 * just whether a human has pressed "ready" yet. Reading only `pickup_status`
 * meant a store set to same-day collection told the shopper "we'll let you
 * know as soon as it's ready" — flatly contradicting the "Available today"
 * they had accepted one screen earlier. The promise and the packing signal are
 * two different facts, and the shopper wants both.
 */
export function pickupNote(
  order: {
    pickup_status?: string | null;
    pickup_ready_at?: string | null;
    pickup_expires_at?: string | null;
  },
  now: Date = new Date(),
): string {
  if (order.pickup_status === "collected") return "Handed over - thank you.";
  if (order.pickup_status === "expired") {
    return "This order wasn't collected in time and was cancelled.";
  }

  let note: string;
  if (order.pickup_status === "ready") {
    note = "Packed and waiting for you.";
  } else {
    const readyAt = order.pickup_ready_at
      ? new Date(order.pickup_ready_at)
      : null;
    const known = readyAt && !Number.isNaN(readyAt.getTime());
    // Compared as INSTANTS, so this is timezone-independent — only the
    // rendered date below needs a zone.
    note =
      !known || readyAt.getTime() <= now.getTime()
        ? "Ready for collection today."
        : `Ready for collection from ${pickupDate(readyAt)}.`;
    note += " We'll let you know the moment it's packed.";
  }

  if (order.pickup_expires_at) {
    const expires = new Date(order.pickup_expires_at);
    if (!Number.isNaN(expires.getTime())) {
      note += ` Held until ${pickupDate(expires)}.`;
    }
  }
  return note;
}

/**
 * "10 August". The timezone is PINNED for the same reason the notification
 * formatter pins it: these pages render on the server, where the zone is UTC
 * on Cloud Run — so a hold lapsing at 00:30 IST would be quoted as the day
 * before. Asia/Kolkata is the India-first default used across the dashboard.
 */
function pickupDate(date: Date): string {
  return date.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "long",
  });
}

export const PAYMENT_LABEL: Record<string, string> = {
  cash_on_delivery: "Cash on delivery",
  cod: "Cash on delivery",
  // Was missing, so a collection order's header read "Placed 5 Aug · pay_at_store".
  pay_at_store: "Pay at store",
  razorpay: "Paid online",
  store_credit: "Paid with store credit",
  exchange: "Exchange",
  cash: "Cash",
  card: "Card",
  upi: "UPI",
};

/** ₹1,240.00 */
export function money(value: number, currency = "INR"): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${value}`;
  }
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
