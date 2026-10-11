// Buy Online, Return In Store (roadmap Step 5, docs/returns-exchanges-plan.md §5).
//
// PURE. Two questions that look like one and are not:
//
//   1. MAY this shop take this return?  → canTakeReturnHere
//   2. WHERE does the money go?         → refundRouteFor
//
// Keeping them apart is the whole point. The stock goes to the shop the
// customer walked into; the money goes wherever it came from. Conflating them
// is how a shop hands cash back for a card sale.

/** How a location is allowed to take this particular order back. */
export type InStoreReturnVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface InStoreReturnContext {
  /** Was this order rung at THIS location? */
  soldHere: boolean;
  /** `returns.allowInStore` — the store-wide switch. */
  storeAllows: boolean;
  /** `locationCan(caps, "returns", …)` for the operator's location. */
  locationAccepts: boolean;
}

/**
 * ★ A sale rung at THIS counter is ALWAYS returnable here, regardless of the
 * BORIS settings.
 *
 * That is not a loophole, it is invariant 1. The till has been taking its own
 * returns since pos_12; making that conditional on a setting introduced later
 * would break every shop that has been doing it for months, the moment they
 * upgrade. `returns.allowInStore` governs the NEW capability — accepting
 * orders this counter didn't sell — and nothing else.
 */
export function canTakeReturnHere(
  ctx: InStoreReturnContext,
): InStoreReturnVerdict {
  if (ctx.soldHere) return { allowed: true };

  if (!ctx.storeAllows) {
    return {
      allowed: false,
      reason:
        "This shop can only take back things it sold. Ask the customer to start the return from their order page.",
    };
  }
  if (!ctx.locationAccepts) {
    return {
      allowed: false,
      reason:
        "This location isn't set up to accept returns. Turn on 'Accept returns' for it under Locations.",
    };
  }
  return { allowed: true };
}

/** The tenders a counter can physically hand money back through. */
export type CounterTender = "cash" | "card" | "upi";
/**
 * Where a counter refund goes. `store_credit` is a balance on the customer's
 * account; `none` means NO money moves at this counter — the goods may still
 * come back, and the refund is completed from the dashboard instead.
 */
export type RefundRouteMethod =
  | CounterTender
  | "razorpay"
  | "store_credit"
  | "none";

export interface RefundRoute {
  /** What `processReturn` must use. Not a preference. */
  method: RefundRouteMethod;
  /** True when the counter chooses among cash/card/upi. */
  counterChoice: boolean;
  /** Shown to the cashier so they can tell the customer what happens. */
  copy: string;
  /** True when this refund reduces the cash in the drawer. */
  affectsDrawer: boolean;
}

/**
 * ★ THE TENDER THAT PAID DECIDES WHERE THE MONEY GOES.
 *
 * Not a preference, and not something a cashier may override. Refunding cash
 * for a card sale is the card-not-present laundering path: buy online with a
 * stolen card, return in store, walk out with clean cash. It is also, for card
 * payments, what the networks require.
 *
 * So an online order refunds to the gateway and the till shows NO cash option
 * at all — a control that always fails server-side, in front of a customer, is
 * worse than no control.
 *
 * A COD order is the one case where cash at the counter is right: they paid
 * cash to a courier, they get cash back.
 *
 * ★★ AN EXCHANGE REPLACEMENT IS NEVER CASHED OUT. `createExchangeOrder`
 * (return-actions.ts) writes the replacement as `payment_method: 'exchange'`,
 * `payment_status: 'paid'`, with no `order_payments` row — it was paid for by
 * the goods that came back, and those goods were often bought on a CARD. This
 * function used to fall through to the counter-choice branch below for it, so a
 * card payment could be swapped for something and then returned for cash: the
 * laundering path above, one step removed. So it goes back as store credit on
 * the customer's account, or — when the order has no customer to credit — no
 * money moves at the counter at all and the refund is left to the dashboard,
 * where a person decides it. The goods can still come back either way, the
 * same as an unpaid gateway order below.
 */
export function refundRouteFor(order: {
  paymentMethod: string | null;
  paymentStatus: string | null;
  /** Whether the order has a customer account a credit could go to. */
  hasCustomer?: boolean;
}): RefundRoute {
  const method = order.paymentMethod ?? "";

  if (method === "exchange") {
    if (order.hasCustomer) {
      return {
        method: "store_credit",
        counterChoice: false,
        copy: "This order was an exchange, so its value goes back as store credit on the customer's account, not as cash.",
        affectsDrawer: false,
      };
    }
    return {
      method: "none",
      counterChoice: false,
      copy: "This order was an exchange and has no customer account to credit, so no money is handed back here. Take the items back, then refund the customer from the order in the dashboard.",
      affectsDrawer: false,
    };
  }

  if (method === "razorpay") {
    if (order.paymentStatus !== "paid") {
      // Nothing was captured, so there is nothing to send back — but the goods
      // can still come back, so this is not a refusal to take the return.
      return {
        method: "razorpay",
        counterChoice: false,
        copy: "This order was never paid, so there's nothing to refund.",
        affectsDrawer: false,
      };
    }
    return {
      method: "razorpay",
      counterChoice: false,
      copy: "Refunded to the card or account they paid with. It usually lands in 5–7 working days.",
      affectsDrawer: false,
    };
  }

  // COD, or a sale rung at a counter. Cash by default; the operator picks if
  // the shop settled it on a terminal.
  return {
    method: "cash",
    counterChoice: true,
    copy: "Hand the money back at the counter.",
    affectsDrawer: true,
  };
}

/** Whether a counter tender the client asked for is allowed for this order.
 *  The server's answer, so a tampered request can't route a card sale to the
 *  drawer. */
export function isTenderAllowed(
  route: RefundRoute,
  requested: string,
): boolean {
  if (!route.counterChoice) return requested === route.method;
  return requested === "cash" || requested === "card" || requested === "upi";
}
