// ---------------------------------------------------------------------------
// How a SHOPPER reads an order's status. Pure.
//
// The dashboard's ORDER_STATUSES is the authority on what a status can BE
// (app/actions/order-actions.ts); this is how a shopper reads it. Kept apart on
// purpose: "pending" means "awaiting your action" to a merchant and "we've got
// it" to a customer, and those two audiences should never share one string.
//
// ★ ONE VOCABULARY FOR EVERY SHOPPER SURFACE. The order pages
// (app/(storefront)/(pages)/orders/order-status.tsx re-exports these) and the
// WhatsApp "where is my order" answer (lib/whatsapp/order-status-reply.ts)
// both read from here, so a customer is never told "On the way" in a chat and
// "Being prepared" on the page.
// ---------------------------------------------------------------------------

export const CUSTOMER_STATUS_LABEL: Record<string, string> = {
  pending: "Order placed",
  processing: "Being prepared",
  shipped: "On the way",
  delivered: "Delivered",
  // The till writes this when a collection is handed over. It was missing, so
  // the pill rendered the raw enum "completed" in the not-started colour.
  completed: "Completed",
  cancelled: "Cancelled",
};

/** The fields any of these helpers need. Both pages pass their own row shape. */
export interface OrderStatusView {
  status: string;
  fulfilment_type?: string | null;
  pickup_status?: string | null;
  sales_channel?: string | null;
}

export function isPickup(order: OrderStatusView): boolean {
  return order.fulfilment_type === "pickup";
}

/**
 * What the shopper's badge says.
 *
 * For a collection order the ORDER status can't answer this on its own: the
 * shop marking a parcel ready writes `pickup_status`, and handing it over
 * writes `status: "completed"` — which is not in ORDER_FLOW at all.
 */
export function customerStatusLabel(order: OrderStatusView): string {
  if (isPickup(order)) {
    // Checked before `cancelled`, which the expiry sweep also sets: "Not
    // collected" says why, and "Cancelled" alone reads like the shop pulled it.
    if (order.pickup_status === "expired") return "Not collected";
    if (order.pickup_status === "collected") return "Collected";
    if (order.status === "cancelled") return "Cancelled";
    if (order.pickup_status === "ready") return "Ready to collect";
    return order.status === "processing" ? "Being prepared" : "Order placed";
  }
  return CUSTOMER_STATUS_LABEL[order.status] ?? order.status;
}
