/* eslint-disable @typescript-eslint/no-explicit-any */
// "This order is now paid" — the single choke point, and the confirmation.
//
// It carries the customer confirmation for gateway orders, which used to be
// sent at checkout while the Razorpay modal was still open and unpaid. The
// tests worth having are about exactly-once (three paths reach here) and about
// never letting a notification failure touch a recorded payment.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/payments/refund-reconcile", () => ({
  syncOrderRefundState: vi.fn(async () => undefined),
  refundDueForOrder: vi.fn(async () => 120),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { markOrderPaid, MarkPaidWriteError } from "./mark-paid";
import { orders } from "@/drizzle/schema";
import { emitEvent } from "@/lib/notifications/record";
import { syncOrderRefundState } from "@/lib/payments/refund-reconcile";

const CLAIMED = {
  storeId: "store-1",
  orderRef: "ORD1001",
  customerId: "cust-1",
  total: 39,
  currency: "INR",
};

const ORDER_ROW = {
  storeId: "store-1",
  customerId: "cust-1",
  orderRef: "ORD1001",
  locationId: null,
  total: 39,
  currency: "INR",
  subtotal: 39,
  discount: 0,
  tax: 0,
  shipping: 0,
  paymentMethod: "razorpay",
  shippingAddress: { firstName: "Ada", city: "Delhi" },
  fulfilmentType: "delivery",
  pickupLocationId: null,
  pickupCode: null,
};

/** returning() → the claim; then the order row, then its items. */
function seed(claim: any[] = [CLAIMED]) {
  dbHolder.current = makeDbMock({
    returning: claim,
    selectQueue: [
      [ORDER_ROW],
      [{ name: "Tin", variantName: null, quantity: 1, total: 39 }],
    ],
  });
}

const eventsOfType = (t: string) =>
  vi.mocked(emitEvent).mock.calls.filter((c: any[]) => c[0]?.type === t);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("markOrderPaid", () => {
  it("★★ sends the confirmation the checkout no longer sends", async () => {
    seed();
    await markOrderPaid("order-1", "pay_abc");
    expect(eventsOfType("order.placed")).toHaveLength(1);
  });

  it("★ and the team's ledger line, which is in-app only", async () => {
    seed();
    await markOrderPaid("order-1", "pay_abc");
    expect(eventsOfType("order.payment_received")).toHaveLength(1);
  });

  it("★★ a LOST claim announces nothing — exactly-once across three paths", async () => {
    // The client callback, reconcile-on-read and the cron reaper can all reach
    // here for one payment. The UPDATE is conditional on `pending`, so only one
    // gets rows back; without this the shopper is thanked three times.
    seed([]);
    await markOrderPaid("order-1", "pay_abc");
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("★ the confirmation carries the ORDER's own figures, not the caller's", async () => {
    seed();
    await markOrderPaid("order-1", "pay_abc");
    const ev = eventsOfType("order.placed")[0][0] as any;
    expect(ev.payload.total).toBe(39);
    expect(ev.subject.label).toBe("ORD1001");
    expect(ev.customerId).toBe("cust-1");
    // The email table is built from the items, so the receipt matches the sale.
    expect(ev.email.items).toHaveLength(1);
  });

  it("★ names where a delivery is going", async () => {
    seed();
    await markOrderPaid("order-1", "pay_abc");
    const ev = eventsOfType("order.placed")[0][0] as any;
    expect(ev.payload.fulfilment).toBe("delivery");
  });

  it("★★ a failed confirmation NEVER loses the payment", async () => {
    // The money is already claimed by the time this runs. A notification is not
    // worth unwinding it for, so the read is allowed to blow up.
    dbHolder.current = makeDbMock({ returning: [CLAIMED], selectQueue: [] });
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("db down");
    });
    await expect(markOrderPaid("order-1", "pay_abc")).resolves.toBe("paid");
    // The team still gets the ledger line — it needs no extra read.
    expect(eventsOfType("order.payment_received")).toHaveLength(1);
  });
});

describe("markOrderPaid — a payment after the order expired", () => {
  it("★★ records it on the still-cancelled order and tells the merchant what is owed", async () => {
    // The pending claim matches nothing (the reaper cancelled the order); the
    // late claim matches. The money must be recorded, never dropped.
    dbHolder.current = makeDbMock({ returningQueue: [[], [CLAIMED]] });
    await expect(markOrderPaid("order-1", "pay_late")).resolves.toBe("late");

    const lateSet = dbHolder.current.calls.set[1];
    expect(lateSet).toMatchObject({
      paymentStatus: "paid",
      razorpayPaymentId: "pay_late",
    });
    // The order stays cancelled: nothing sets its status back.
    expect(lateSet).not.toHaveProperty("status");
    expect(syncOrderRefundState).toHaveBeenCalledWith("order-1");

    const [ev] = eventsOfType("order.payment_received")[0] as any[];
    expect(ev.payload).toMatchObject({ late: true, refund_due: 120 });
    // No order confirmation for an order that was never placed.
    expect(eventsOfType("order.placed")).toHaveLength(0);
  });

  it("changes nothing when neither claim matches (a replay)", async () => {
    dbHolder.current = makeDbMock({ returningQueue: [[], []] });
    await expect(markOrderPaid("order-1", "pay_abc")).resolves.toBe(
      "unchanged",
    );
    expect(emitEvent).not.toHaveBeenCalled();
    expect(syncOrderRefundState).not.toHaveBeenCalled();
  });
});

// 21 Nov 2026: "unchanged" used to mean both "this order is not waiting on
// this payment" and "the database could not be written", so the store's
// webhook acknowledged a delivery it had failed to record.
describe("markOrderPaid: a write that FAILED is not a replay", () => {
  const failingWrite = () =>
    (dbHolder.current = makeDbMock({ failUpdateFor: [orders] }));

  it("by default it still answers unchanged, for callers that run again anyway", async () => {
    failingWrite();
    await expect(markOrderPaid("order-1", "pay_abc")).resolves.toBe(
      "unchanged",
    );
  });

  it("★★ with `strict` it throws, so the caller can ask again", async () => {
    failingWrite();
    await expect(
      markOrderPaid("order-1", "pay_abc", { strict: true }),
    ).rejects.toBeInstanceOf(MarkPaidWriteError);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("★ `strict` changes nothing for a real replay: no row to claim is still unchanged", async () => {
    dbHolder.current = makeDbMock({ returningQueue: [[], []] });
    await expect(
      markOrderPaid("order-1", "pay_abc", { strict: true }),
    ).resolves.toBe("unchanged");
  });

  it("and a claim that lands is paid, as before", async () => {
    seed();
    await expect(
      markOrderPaid("order-1", "pay_abc", { strict: true }),
    ).resolves.toBe("paid");
  });
});
