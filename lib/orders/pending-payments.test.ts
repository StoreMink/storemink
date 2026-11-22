/* eslint-disable @typescript-eslint/no-explicit-any */
// Online orders waiting for their payment (21 Nov 2026). The rules these
// cases defend:
//   • an order whose money may have been taken is never cancelled;
//   • cancelling an unpaid order gives back EVERYTHING it held, offers too;
//   • a store's Razorpay account is not disconnected or replaced while an
//     order is still waiting on it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/notifications/record", () => ({
  recordEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/payments/provider", () => ({
  lookupStoreGateway: vi.fn(),
}));
vi.mock("@/lib/payments/capture", () => ({
  settleOrderPayment: vi.fn(),
}));
vi.mock("@/lib/orders/mark-paid", () => ({
  markOrderPaid: vi.fn(async () => "paid"),
}));
vi.mock("@/lib/orders/cancel", () => ({
  releaseCancelledOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/offers/cart", () => ({
  releaseOrderOfferUses: vi.fn(async () => []),
}));
vi.mock("@/lib/payments/razorpay", () => ({
  rzpFetchOrder: vi.fn(),
}));
vi.mock("@/lib/billing/order-state", () => ({
  orderIsUntouched: vi.fn(),
}));

import {
  CONFIRM_AFTER_MINUTES,
  PAYMENT_GRACE_MINUTES,
  confirmYoungPendingOrders,
  expectedGatewayPaise,
  expireUnpaidOrder,
  minutesUntilLapse,
  orderAgeMinutes,
  orderHoldsCart,
  refusedReadReason,
  retireWaitingOrder,
  settleBeforeGatewayChange,
  settlePendingOrder,
  settleShopperPendingOrders,
  waitingOrderChanges,
  type PendingOnlineOrder,
} from "./pending-payments";
import { rzpFetchOrder } from "@/lib/payments/razorpay";
import { orderIsUntouched } from "@/lib/billing/order-state";
import { logError } from "@/lib/observability/logger";
import { recordEvent } from "@/lib/notifications/record";
import { lookupStoreGateway } from "@/lib/payments/provider";
import { settleOrderPayment } from "@/lib/payments/capture";
import { markOrderPaid } from "@/lib/orders/mark-paid";
import { releaseCancelledOrder } from "@/lib/orders/cancel";
import { releaseOrderOfferUses } from "@/lib/offers/cart";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const CREDS = { keyId: "rzp_live_old", keySecret: "s" };
const NEW_CREDS = { keyId: "rzp_live_new", keySecret: "n" };
const minutesAgo = (m: number) =>
  new Date(NOW.getTime() - m * 60_000).toISOString();

function order(over: Partial<PendingOnlineOrder> = {}): PendingOnlineOrder {
  return {
    id: "o1",
    store_id: "s1",
    razorpay_order_id: "order_1",
    applied_coupon_code: null,
    order_ref: "ORD1",
    customer_id: "c1",
    total: 500,
    store_credit_used: 0,
    created_at: minutesAgo(10),
    ...over,
  };
}

/** `claimed` is what the pending → failed claim returns. */
function db(opts: { rows?: any[][]; claimed?: any[] } = {}) {
  dbHolder.current = makeDbMock({
    selectByTable: { orders: opts.rows ?? [] },
    returning: opts.claimed ?? [{ id: "o1" }],
  });
}

const CAPTURED = { kind: "captured", paymentId: "pay_1", amountPaise: 50000 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(settleOrderPayment).mockResolvedValue({ kind: "none" });
  vi.mocked(markOrderPaid).mockResolvedValue("paid");
  vi.mocked(lookupStoreGateway).mockResolvedValue({
    status: "connected",
    gateway: { creds: CREDS, enabled: true },
  } as any);
  db();
});

describe("the arithmetic", () => {
  it("the gateway was asked for the total less store credit, in paise", () => {
    expect(expectedGatewayPaise({ total: 500, store_credit_used: 0 })).toBe(
      50000,
    );
    expect(
      expectedGatewayPaise({ total: "499.50", store_credit_used: "200" }),
    ).toBe(29950);
  });

  it("an order's age is in minutes, and 0 when it carries no readable time", () => {
    expect(orderAgeMinutes({ created_at: minutesAgo(46) }, NOW)).toBe(46);
    expect(orderAgeMinutes({ created_at: null }, NOW)).toBe(0);
    expect(orderAgeMinutes({ created_at: "nonsense" }, NOW)).toBe(0);
  });

  it("orders wait 45 minutes, and are asked about from 2 minutes old", () => {
    expect(PAYMENT_GRACE_MINUTES).toBe(45);
    expect(CONFIRM_AFTER_MINUTES).toBe(2);
  });
});

describe("expireUnpaidOrder: everything the order held goes back", () => {
  it("★★ claims pending → failed, then releases stock and credit, the coupon and the OFFERS", async () => {
    expect(
      await expireUnpaidOrder(order({ applied_coupon_code: " save10 " })),
    ).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({
      paymentStatus: "failed",
      status: "cancelled",
    });
    expect(releaseCancelledOrder).toHaveBeenCalledWith(
      "s1",
      "o1",
      expect.any(Function),
      "payment_expired",
    );
    // The coupon use, by its normalised code.
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    expect(releaseOrderOfferUses).toHaveBeenCalledWith("s1", "o1");
    expect(vi.mocked(recordEvent).mock.calls[0][0]).toMatchObject({
      type: "order.payment_failed",
      storeId: "s1",
    });
  });

  it("★★ releases NOTHING when a payment claimed the order first", async () => {
    db({ claimed: [] });
    expect(await expireUnpaidOrder(order())).toBe(false);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
    expect(releaseOrderOfferUses).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("an order with no coupon makes no coupon call; a failed notice still releases", async () => {
    vi.mocked(recordEvent).mockRejectedValueOnce(new Error("queue down"));
    expect(await expireUnpaidOrder(order())).toBe(true);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
    expect(releaseCancelledOrder).toHaveBeenCalledTimes(1);
    expect(releaseOrderOfferUses).toHaveBeenCalledTimes(1);
  });
});

describe("settlePendingOrder: the gateway decides", () => {
  it("★ a captured payment marks the order paid and cancels nothing", async () => {
    vi.mocked(settleOrderPayment).mockResolvedValue(CAPTURED as any);
    expect(
      await settlePendingOrder(order({ created_at: minutesAgo(90) }), CREDS, {
        expire: "after_grace",
        now: NOW,
      }),
    ).toBe("paid");
    expect(markOrderPaid).toHaveBeenCalledWith("o1", "pay_1", { strict: true });
    expect(dbHolder.current.calls.update).toHaveLength(0);
    // Asked for the amount the gateway was given, and allowed to capture a
    // hold of exactly that amount.
    expect(vi.mocked(settleOrderPayment).mock.calls[0].slice(1)).toEqual([
      "order_1",
      50000,
      { capture: true },
    ]);
  });

  it("no payment inside the grace period waits", async () => {
    expect(
      await settlePendingOrder(order({ created_at: minutesAgo(44) }), CREDS, {
        expire: "after_grace",
        now: NOW,
      }),
    ).toBe("waiting");
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("no payment past the grace period is cancelled", async () => {
    expect(
      await settlePendingOrder(order({ created_at: minutesAgo(45) }), CREDS, {
        expire: "after_grace",
        now: NOW,
      }),
    ).toBe("expired");
    expect(releaseCancelledOrder).toHaveBeenCalledTimes(1);
  });

  it("★★ a pass that only confirms NEVER cancels, however old the order", async () => {
    expect(
      await settlePendingOrder(order({ created_at: minutesAgo(600) }), CREDS, {
        expire: "never",
        now: NOW,
      }),
    ).toBe("waiting");
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★★ an unreadable gateway decides nothing; a refusal is told apart", async () => {
    vi.mocked(settleOrderPayment).mockResolvedValue({ kind: "unknown" });
    const old = order({ created_at: minutesAgo(600) });
    const opts = { expire: "after_grace" as const, now: NOW };
    expect(await settlePendingOrder(old, CREDS, opts)).toBe("unknown");
    vi.mocked(settleOrderPayment).mockResolvedValue({
      kind: "unknown",
      refused: true,
    });
    expect(await settlePendingOrder(old, CREDS, opts)).toBe("refused");
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });

  // ★★ PR #303 review, 22 Nov 2026. Captured at the gateway while the write
  // that marks the order paid throws used to return "unknown", the value for
  // "Razorpay could not be read", and the reaper cancels an order it has been
  // unable to ask about for a week: a paid order was cancelled.
  it("★★ captured at the gateway but not recorded is its OWN outcome, never 'unknown'", async () => {
    vi.mocked(settleOrderPayment).mockResolvedValue(CAPTURED as any);
    vi.mocked(markOrderPaid).mockRejectedValue(new Error("write failed"));
    const old = order({ created_at: minutesAgo(9 * 24 * 60) });
    expect(
      await settlePendingOrder(old, CREDS, { expire: "after_grace", now: NOW }),
    ).toBe("captured_unrecorded");
    // However old it is, nothing it held is given back.
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
    expect(releaseOrderOfferUses).not.toHaveBeenCalled();
    vi.mocked(markOrderPaid).mockResolvedValue("paid");
  });

  it("a payment someone else recorded first leaves the order alone", async () => {
    vi.mocked(settleOrderPayment).mockResolvedValue(CAPTURED as any);
    vi.mocked(markOrderPaid).mockResolvedValue("unchanged");
    expect(
      await settlePendingOrder(order({ created_at: minutesAgo(90) }), CREDS, {
        expire: "after_grace",
        now: NOW,
      }),
    ).toBe("waiting");
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });
});

describe("confirmYoungPendingOrders: the frequent pass", () => {
  it("★★ confirms a young order whose payment landed", async () => {
    db({ rows: [[order({ created_at: minutesAgo(5) })]] });
    vi.mocked(settleOrderPayment).mockResolvedValue(CAPTURED as any);
    expect(await confirmYoungPendingOrders(NOW)).toEqual({
      considered: 1,
      paid: 1,
      errors: 0,
    });
    expect(markOrderPaid).toHaveBeenCalledWith("o1", "pay_1", { strict: true });
  });

  it("★★ never cancels: an unpaid young order is left exactly as it is", async () => {
    db({ rows: [[order({ created_at: minutesAgo(40) })]] });
    expect((await confirmYoungPendingOrders(NOW)).paid).toBe(0);
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });

  it("one gateway lookup per store, and a store with no gateway is skipped unasked", async () => {
    db({
      rows: [
        [
          order({ id: "a", store_id: "s1" }),
          order({ id: "b", store_id: "s1" }),
          order({ id: "c", store_id: "s2" }),
        ],
      ],
    });
    vi.mocked(lookupStoreGateway).mockImplementation(async (storeId) =>
      storeId === "s1"
        ? ({
            status: "connected",
            gateway: { creds: CREDS, enabled: true },
          } as any)
        : { status: "none" },
    );
    expect((await confirmYoungPendingOrders(NOW)).considered).toBe(3);
    expect(lookupStoreGateway).toHaveBeenCalledTimes(2);
    expect(settleOrderPayment).toHaveBeenCalledTimes(2);
  });

  it("a paused gateway still confirms: the order was placed while it was on", async () => {
    db({ rows: [[order()]] });
    vi.mocked(lookupStoreGateway).mockResolvedValue({
      status: "connected",
      gateway: { creds: CREDS, enabled: false },
    } as any);
    vi.mocked(settleOrderPayment).mockResolvedValue(CAPTURED as any);
    expect((await confirmYoungPendingOrders(NOW)).paid).toBe(1);
  });

  it("never throws: a failed read is one error, one bad order does not stop the rest", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { orders: [new Error("db down")] },
    });
    expect(await confirmYoungPendingOrders(NOW)).toEqual({
      considered: 0,
      paid: 0,
      errors: 1,
    });

    db({ rows: [[order({ id: "a" }), order({ id: "b" })]] });
    vi.mocked(settleOrderPayment)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(CAPTURED as any);
    expect(await confirmYoungPendingOrders(NOW)).toEqual({
      considered: 2,
      paid: 1,
      errors: 1,
    });
  });
});

describe("settleBeforeGatewayChange: no waiting order is left behind", () => {
  const change = (replacement: typeof NEW_CREDS | null = null) =>
    settleBeforeGatewayChange("s1", CREDS, replacement, NOW);

  it("nothing waiting: the change goes ahead", async () => {
    db({ rows: [[]] });
    expect(await change()).toMatchObject({ ok: true, waiting: 0 });
    expect(settleOrderPayment).not.toHaveBeenCalled();
  });

  it("★★ a paid order is confirmed with the OLD keys before they go", async () => {
    db({ rows: [[order()]] });
    vi.mocked(settleOrderPayment).mockResolvedValue(CAPTURED as any);
    expect(await change()).toMatchObject({ ok: true, paid: 1, waiting: 0 });
    expect(vi.mocked(settleOrderPayment).mock.calls[0][0]).toBe(CREDS);
    expect(markOrderPaid).toHaveBeenCalledWith("o1", "pay_1", { strict: true });
  });

  it("an unpaid order past the grace period is cancelled, and the change goes ahead", async () => {
    db({ rows: [[order({ created_at: minutesAgo(50) })]] });
    expect(await change()).toMatchObject({ ok: true, expired: 1 });
  });

  it("★★ an order still inside its payment window BLOCKS the change, and says until when", async () => {
    db({
      rows: [
        [
          order({ id: "a", created_at: minutesAgo(30) }),
          order({ id: "b", created_at: minutesAgo(5) }),
        ],
      ],
    });
    expect(await change()).toEqual({
      ok: false,
      paid: 0,
      expired: 0,
      waiting: 2,
      unreadable: 0,
      // 45 minutes after the YOUNGEST waiting order was placed.
      clearBy: new Date(NOW.getTime() + 40 * 60_000).toISOString(),
    });
  });

  it("★★ new keys on the SAME Razorpay account can read the order, so rotating a key never waits", async () => {
    db({ rows: [[order()]] });
    // Old keys: no payment yet. New keys: the same answer, so the same account.
    vi.mocked(settleOrderPayment).mockResolvedValue({ kind: "none" });
    expect(await change(NEW_CREDS)).toMatchObject({ ok: true, waiting: 0 });
    const second = vi.mocked(settleOrderPayment).mock.calls[1];
    expect(second[0]).toBe(NEW_CREDS);
    // Read only: the check never captures with keys that are not saved yet.
    expect(second[3]).toEqual({ capture: false });
  });

  it("★★ keys on ANOTHER account cannot read it, so the change is blocked", async () => {
    db({ rows: [[order()]] });
    vi.mocked(settleOrderPayment).mockImplementation(async (creds) =>
      creds === CREDS ? { kind: "none" } : { kind: "unknown", refused: true },
    );
    expect(await change(NEW_CREDS)).toMatchObject({ ok: false, waiting: 1 });
  });

  it("★ keys Razorpay already refuses protect nothing, so they never block their own replacement", async () => {
    db({ rows: [[order()]] });
    vi.mocked(settleOrderPayment).mockResolvedValue({
      kind: "unknown",
      refused: true,
    });
    expect(await change()).toMatchObject({ ok: true, waiting: 0 });
    expect(await change(NEW_CREDS)).toMatchObject({ ok: true });
  });

  it("★★ FAILS CLOSED: Razorpay unreachable, or the list unreadable, blocks the change", async () => {
    db({ rows: [[order()]] });
    vi.mocked(settleOrderPayment).mockResolvedValue({ kind: "unknown" });
    expect(await change()).toMatchObject({ ok: false, unreadable: 1 });

    dbHolder.current = makeDbMock({
      selectByTable: { orders: [new Error("db down")] },
    });
    expect(await change()).toMatchObject({ ok: false, unreadable: 1 });
  });
});

describe("orderHoldsCart: is this order the cart on screen?", () => {
  const P1 = "11111111-1111-4111-8111-111111111111";
  const P2 = "22222222-2222-4222-8222-222222222222";
  const items = (rows: any[]) =>
    (dbHolder.current = makeDbMock({
      selectByTable: { order_items: [rows] },
    }));
  const line = (
    productId: string,
    quantity: number,
    variantId: any = null,
  ) => ({
    productId,
    variantId,
    quantity,
  });
  const row = (
    productId: string,
    quantity: number,
    price = 100,
    variantId: any = null,
  ) => ({
    productId,
    variantId,
    quantity,
    price,
  });

  it("the same lines and quantities match", async () => {
    items([row(P1, 2), row(P2, 1, 50, "v1")]);
    expect(await orderHoldsCart("o1", [line(P2, 1, "v1"), line(P1, 2)])).toBe(
      true,
    );
  });

  it("★ a free gift the order added itself is not expected in the cart", async () => {
    items([row(P1, 2), row(P2, 1, 0)]);
    expect(await orderHoldsCart("o1", [line(P1, 2)])).toBe(true);
  });

  it("★★ a changed cart does not match: quantity, an added line, a removed line, another variant", async () => {
    for (const cart of [
      [line(P1, 3)],
      [line(P1, 2), line(P2, 1)],
      [line(P2, 2)],
      [line(P1, 2, "v9")],
    ]) {
      items([row(P1, 2)]);
      expect(await orderHoldsCart("o1", cart)).toBe(false);
    }
    // A paid-for order line the cart no longer has.
    items([row(P1, 2), row(P2, 1)]);
    expect(await orderHoldsCart("o1", [line(P1, 2)])).toBe(false);
  });

  it("false when it cannot tell: an empty or malformed cart, or a failed read", async () => {
    items([row(P1, 2)]);
    expect(await orderHoldsCart("o1", [])).toBe(false);
    expect(
      await orderHoldsCart("o1", [
        { productId: "", variantId: null, quantity: 2 },
      ]),
    ).toBe(false);
    expect(await orderHoldsCart("o1", [line(P1, 0)])).toBe(false);
    expect(await orderHoldsCart("o1", "nope" as any)).toBe(false);
    dbHolder.current = makeDbMock({
      selectByTable: { order_items: [new Error("db down")] },
    });
    expect(await orderHoldsCart("o1", [line(P1, 2)])).toBe(false);
  });
});

describe("waitingOrderChanges: is the waiting order what the shopper wants now?", () => {
  const ADDRESS = {
    firstName: "Asha",
    lastName: "Rao",
    addressLine1: "12 MG Road",
    city: "Bengaluru",
    postalCode: "560001",
    phone: "+919876543210",
  };
  const stored = (over: Record<string, unknown> = {}) => ({
    shippingAddress: { ...ADDRESS },
    billingAddress: null,
    notes: null,
    appliedCouponCode: null,
    pickupLocationId: null,
    shippingOption: { id: "flat:standard", amount: 60 },
    shipping: "60.00",
    ...over,
  });
  const wanted = (over: Record<string, unknown> = {}) => ({
    shippingAddress: { ...ADDRESS },
    billingAddress: null,
    notes: null,
    couponCode: null,
    pickupLocationId: null,
    shippingRateId: "flat:standard",
    shippingAmount: 60,
    ...over,
  });

  it("the same choices: nothing differs", async () => {
    db({ rows: [[stored()]] });
    expect(await waitingOrderChanges("o1", wanted())).toEqual([]);
  });

  it("★★ a changed address or a switch to collection is reported", async () => {
    db({ rows: [[stored()]] });
    expect(
      await waitingOrderChanges(
        "o1",
        wanted({ shippingAddress: { ...ADDRESS, addressLine1: "21 MG Road" } }),
      ),
    ).toEqual(["address"]);
    db({ rows: [[stored()]] });
    expect(
      await waitingOrderChanges(
        "o1",
        wanted({
          pickupLocationId: "loc-1",
          shippingRateId: null,
          shippingAmount: null,
        }),
      ),
    ).toEqual(["fulfilment"]);
  });

  it("★★ NULL, never 'the same', when the order is missing or the read fails", async () => {
    db({ rows: [[]] });
    expect(await waitingOrderChanges("o1", wanted())).toBeNull();
    dbHolder.current = makeDbMock({
      selectByTable: { orders: [new Error("db down")] },
    });
    expect(await waitingOrderChanges("o1", wanted())).toBeNull();
    expect(vi.mocked(logError).mock.calls[0][0]).toBe(
      "checkout.waiting_order_details",
    );
  });
});

describe("retireWaitingOrder: cancel the old order only when nobody is paying it", () => {
  const GATEWAY_ORDER = { id: "order_1", status: "created" };

  it("★★ an order the gateway says is untouched is cancelled, and gives back what it held", async () => {
    vi.mocked(rzpFetchOrder).mockResolvedValue(GATEWAY_ORDER as any);
    vi.mocked(orderIsUntouched).mockResolvedValue(true);
    expect(await retireWaitingOrder(order(), CREDS)).toBe("retired");
    expect(vi.mocked(rzpFetchOrder)).toHaveBeenCalledWith(CREDS, "order_1");
    expect(vi.mocked(orderIsUntouched)).toHaveBeenCalledWith(
      CREDS,
      GATEWAY_ORDER,
    );
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      paymentStatus: "failed",
    });
    expect(releaseCancelledOrder).toHaveBeenCalledTimes(1);
    expect(releaseOrderOfferUses).toHaveBeenCalledTimes(1);
  });

  it("★★ a payment waiting for approval, or money on it, leaves the order exactly as it was", async () => {
    vi.mocked(rzpFetchOrder).mockResolvedValue({
      id: "order_1",
      status: "attempted",
    } as any);
    vi.mocked(orderIsUntouched).mockResolvedValue(false);
    expect(await retireWaitingOrder(order(), CREDS)).toBe("in_flight");
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });

  it("★★ FAILS CLOSED: an unreadable gateway, or an order with no gateway order, cancels nothing", async () => {
    vi.mocked(rzpFetchOrder).mockRejectedValue(new Error("timeout"));
    expect(await retireWaitingOrder(order(), CREDS)).toBe("in_flight");
    vi.mocked(rzpFetchOrder).mockResolvedValue(GATEWAY_ORDER as any);
    vi.mocked(orderIsUntouched).mockRejectedValue(new Error("timeout"));
    expect(await retireWaitingOrder(order(), CREDS)).toBe("in_flight");
    vi.mocked(rzpFetchOrder).mockClear();
    expect(
      await retireWaitingOrder(order({ razorpay_order_id: null }), CREDS),
    ).toBe("in_flight");
    expect(rzpFetchOrder).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });

  it("★ a payment recorded in the same instant wins the claim", async () => {
    vi.mocked(rzpFetchOrder).mockResolvedValue(GATEWAY_ORDER as any);
    vi.mocked(orderIsUntouched).mockResolvedValue(true);
    db({ claimed: [] });
    expect(await retireWaitingOrder(order(), CREDS)).toBe("in_flight");
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });
});

describe("minutesUntilLapse", () => {
  it("counts down the payment window, rounds up, and never says under a minute", () => {
    const at = (m: number) => ({ created_at: minutesAgo(m) });
    expect(minutesUntilLapse(at(10), NOW)).toBe(PAYMENT_GRACE_MINUTES - 10);
    expect(minutesUntilLapse(at(10.5), NOW)).toBe(PAYMENT_GRACE_MINUTES - 10);
    expect(minutesUntilLapse(at(PAYMENT_GRACE_MINUTES - 0.2), NOW)).toBe(1);
    expect(minutesUntilLapse(at(PAYMENT_GRACE_MINUTES + 30), NOW)).toBe(1);
  });
});

describe("settleShopperPendingOrders: the shopper's own waiting orders", () => {
  // PR #303 review, 22 Nov 2026. A read that failed used to drop the order
  // from the answer, so checkout saw nothing waiting and placed a second
  // order while a UPI approval on the first was still being processed.
  describe("★★ an order Razorpay could not be asked about is never 'nothing waiting'", () => {
    it("a timeout or a 5xx on an order inside its payment window: reported as UNCHECKED", async () => {
      db({ rows: [[order({ id: "a", created_at: minutesAgo(5) })]] });
      vi.mocked(settleOrderPayment).mockResolvedValue({ kind: "unknown" });
      const res = await settleShopperPendingOrders("s1", "c1", CREDS, NOW);
      expect(res.unchecked.map((o) => o.id)).toEqual(["a"]);
      expect(res.paid).toBeNull();
      expect(res.waiting).toBeNull();
    });

    it("keys Razorpay refuses are no proof of nothing either, while the order is inside its window", async () => {
      db({ rows: [[order({ id: "a", created_at: minutesAgo(5) })]] });
      vi.mocked(settleOrderPayment).mockResolvedValue({
        kind: "unknown",
        refused: true,
      });
      const res = await settleShopperPendingOrders("s1", "c1", CREDS, NOW);
      expect(res.unchecked.map((o) => o.id)).toEqual(["a"]);
    });

    it("★ past its payment window it is the reaper's, as before: not reported", async () => {
      db({
        rows: [
          [
            order({
              id: "old",
              created_at: minutesAgo(PAYMENT_GRACE_MINUTES + 1),
            }),
          ],
        ],
      });
      vi.mocked(settleOrderPayment).mockResolvedValue({ kind: "unknown" });
      const res = await settleShopperPendingOrders("s1", "c1", CREDS, NOW);
      expect(res.unchecked).toEqual([]);
    });

    it("every unread order is listed, newest first, beside one that could be read", async () => {
      db({
        rows: [
          [
            order({ id: "new", created_at: minutesAgo(2) }),
            order({ id: "mid", created_at: minutesAgo(8) }),
            order({ id: "old", created_at: minutesAgo(20) }),
          ],
        ],
      });
      vi.mocked(settleOrderPayment)
        .mockResolvedValueOnce({ kind: "unknown" })
        .mockResolvedValueOnce({ kind: "none" })
        .mockResolvedValueOnce({ kind: "unknown" });
      const res = await settleShopperPendingOrders("s1", "c1", CREDS, NOW);
      expect(res.unchecked.map((o) => o.id)).toEqual(["new", "old"]);
      expect(res.waiting?.id).toBe("mid");
    });

    it("nothing unread: an empty list, never missing", async () => {
      db({ rows: [[order()]] });
      const res = await settleShopperPendingOrders("s1", "c1", CREDS, NOW);
      expect(res.unchecked).toEqual([]);
    });
  });

  it("★★ reports the one that turned out to be paid", async () => {
    db({ rows: [[order({ id: "new" }), order({ id: "old" })]] });
    vi.mocked(settleOrderPayment)
      .mockResolvedValueOnce({ kind: "none" })
      .mockResolvedValueOnce(CAPTURED as any);
    const res = await settleShopperPendingOrders("s1", "c1", CREDS, NOW);
    expect(res.paid?.id).toBe("old");
    // The newer one is still inside its payment window.
    expect(res.waiting?.id).toBe("new");
    expect(markOrderPaid).toHaveBeenCalledWith("old", "pay_1", {
      strict: true,
    });
  });

  it("★★ a payment captured but not yet recorded still counts as paid for the shopper: they are not sent to pay again", async () => {
    db({ rows: [[order({ id: "held" })]] });
    vi.mocked(settleOrderPayment).mockResolvedValue(CAPTURED as any);
    vi.mocked(markOrderPaid).mockRejectedValue(new Error("write failed"));
    const res = await settleShopperPendingOrders("s1", "c1", CREDS, NOW);
    expect(res.paid?.id).toBe("held");
    expect(res.waiting).toBeNull();
    vi.mocked(markOrderPaid).mockResolvedValue("paid");
  });

  it("★ cancels their own abandoned attempt once it is past the payment window", async () => {
    db({ rows: [[order({ created_at: minutesAgo(60) })]] });
    const res = await settleShopperPendingOrders("s1", "c1", CREDS, NOW);
    expect(res).toEqual({ paid: null, waiting: null, unchecked: [] });
    // Its stock and offer uses are free for the order about to be placed.
    expect(releaseCancelledOrder).toHaveBeenCalledTimes(1);
    expect(releaseOrderOfferUses).toHaveBeenCalledWith("s1", "o1");
  });

  it("never throws: a failed read reports nothing waiting", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: { orders: [new Error("db down")] },
    });
    expect(await settleShopperPendingOrders("s1", "c1", CREDS, NOW)).toEqual({
      paid: null,
      waiting: null,
      unchecked: [],
    });
  });
});

describe("refusedReadReason: what the order's own record says about a refused read", () => {
  it("the keys connected now are not the ones that made the order", () => {
    expect(
      refusedReadReason({ razorpay_key_id: "rzp_live_old" }, "rzp_live_new"),
    ).toBe("keys_changed_since_order");
  });

  it("Razorpay is refusing the very keys that made it", () => {
    expect(
      refusedReadReason({ razorpay_key_id: "rzp_live_old" }, "rzp_live_old"),
    ).toBe("same_keys_refused");
  });

  it("an order placed before the key id was recorded says nothing", () => {
    expect(refusedReadReason({}, "rzp_live_new")).toBe("unrecorded");
    expect(refusedReadReason({ razorpay_key_id: null }, "rzp_live_new")).toBe(
      "unrecorded",
    );
  });
});
