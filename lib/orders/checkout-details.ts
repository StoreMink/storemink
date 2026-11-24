// ---------------------------------------------------------------------------
// Is a waiting order the one the shopper is asking for NOW?
//
// WHY (PR #303 follow-up review, 22 Nov 2026). `placeOrder` resumes an earlier
// order that is still inside its payment window instead of placing a second
// one beside a pending approval. The first version resumed whenever the
// products and quantities matched, and so threw away whatever the shopper had
// changed on the form since: the address, delivery or collection, the shop,
// the delivery option, the coupon. The commonest reason to come back after a
// payment that did not finish is to correct exactly one of those. They then
// paid the old total and the parcel went to the old address.
//
// So an order is resumed only when everything the shopper CHOSE is the same.
// This module is that comparison.
//
// ★ CHOICES, NEVER THE RECOMPUTED TOTAL. Pricing the cart again cannot answer
//   "is it the same order": the waiting order already holds the shopper's
//   store credit, its coupon use and its stock, so a second pricing differs
//   for reasons that are not the shopper's doing (their credit balance is now
//   lower by what that order spent). What is compared is every input they
//   control, and the delivery price they were shown, which the order records.
// ★ Store credit is applied by StoreMink from the balance, not chosen, so it
//   is not an input.
// ★ FAILS TOWARD "CHANGED": anything missing or unreadable on either side is
//   a difference. The caller then never resumes on a guess.
// Pure: no database, no imports.
// ---------------------------------------------------------------------------

/** What the shopper is asking for now, normalised the way an order stores it. */
export interface WantedCheckout {
  /** The delivery address as `placeOrder` would store it (trimmed, capped,
   * the phone formatted). */
  shippingAddress: Readonly<Record<string, string | null>>;
  /** A separate billing address, or null for "same as delivery". */
  billingAddress: Readonly<Record<string, string>> | null;
  notes: string | null;
  /** The coupon code, normalised (upper case, no spaces), or null. */
  couponCode: string | null;
  /** The shop to collect from, or null for a delivery. */
  pickupLocationId: string | null;
  /** The delivery option picked from the quote; null for a collection. */
  shippingRateId: string | null;
  /** The delivery price shown beside it, when the page sent one. */
  shippingAmount: number | null;
}

/** The columns of a waiting order this reads (`orders`). */
export interface WaitingOrderDetails {
  shippingAddress: unknown;
  billingAddress: unknown;
  notes: string | null;
  appliedCouponCode: string | null;
  pickupLocationId: string | null;
  /** The stored delivery option (`{ id, amount, ... }`). */
  shippingOption: unknown;
  /** The delivery charge the order was priced with. */
  shipping: number | string | null;
}

export type CheckoutChange =
  | "address"
  | "phone"
  | "billing_address"
  | "notes"
  | "coupon"
  | "fulfilment"
  | "pickup_shop"
  | "delivery_option"
  | "delivery_price";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** A coupon code as it is stored and compared: upper case, no whitespace. */
export function comparableCode(code: unknown): string {
  return typeof code === "string" ? code.replace(/\s+/g, "").toUpperCase() : "";
}

/** Whether two address records hold the same text under the same keys. A key
 * missing on one side is the same as an empty one. */
function sameFields(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
  skip: readonly string[] = [],
): boolean {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (skip.includes(key)) continue;
    if (text(a[key]) !== text(b[key])) return false;
  }
  return true;
}

/**
 * Everything that differs between the waiting order and what the shopper
 * wants now. Empty means it is the same order and may be resumed.
 */
export function checkoutChanges(
  order: WaitingOrderDetails,
  wanted: WantedCheckout,
): CheckoutChange[] {
  const changes: CheckoutChange[] = [];

  const stored = record(order.shippingAddress);
  const asked = record(wanted.shippingAddress);
  if (!sameFields(stored, asked, ["phone"])) changes.push("address");
  if (!stored || !asked || text(stored.phone) !== text(asked.phone)) {
    changes.push("phone");
  }

  const storedBilling = record(order.billingAddress);
  const askedBilling = record(wanted.billingAddress);
  if (
    Boolean(storedBilling) !== Boolean(askedBilling) ||
    (storedBilling && !sameFields(storedBilling, askedBilling))
  ) {
    changes.push("billing_address");
  }

  if (text(order.notes) !== text(wanted.notes)) changes.push("notes");

  if (
    comparableCode(order.appliedCouponCode) !==
    comparableCode(wanted.couponCode)
  ) {
    changes.push("coupon");
  }

  const storedPickup = text(order.pickupLocationId);
  const askedPickup = text(wanted.pickupLocationId);
  if (Boolean(storedPickup) !== Boolean(askedPickup)) {
    changes.push("fulfilment");
  } else if (storedPickup !== askedPickup) {
    changes.push("pickup_shop");
  }

  // A collection has no delivery option to compare: the order's own is the
  // fixed "pickup" one and the page sends none.
  if (!storedPickup && !askedPickup) {
    const option = record(order.shippingOption);
    if (text(option?.id) !== text(wanted.shippingRateId)) {
      changes.push("delivery_option");
    }
    if (typeof wanted.shippingAmount === "number") {
      const charged = Number(order.shipping);
      if (
        !Number.isFinite(charged) ||
        Math.abs(charged - wanted.shippingAmount) >= 0.005
      ) {
        changes.push("delivery_price");
      }
    }
  }

  return changes;
}
