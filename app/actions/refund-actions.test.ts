/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
  isStoreSuperadmin: vi.fn(async () => true),
}));
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));
vi.mock("@/lib/payments/provider", () => ({ getStoreGateway: vi.fn() }));
vi.mock("@/lib/payments/razorpay", () => ({
  rzpRefund: vi.fn(),
  rzpFetchOrderPayments: vi.fn(),
  capturedPayment: vi.fn(() => null),
}));
vi.mock("@/lib/payments/refund-reconcile", () => ({
  reconcileOrderRefunds: vi.fn(async () => 0),
  syncOrderRefundState: vi.fn(async () => {}),
  loadOrderRefundFacts: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  getManagerIdentity,
  isStoreSuperadmin,
} from "@/app/dashboard/lib/access";
import { getStoreSettings } from "@/lib/settings/resolve";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { getStoreGateway } from "@/lib/payments/provider";
import { rzpRefund } from "@/lib/payments/razorpay";
import {
  loadOrderRefundFacts,
  syncOrderRefundState,
} from "@/lib/payments/refund-reconcile";
import { emitEvent } from "@/lib/notifications/record";
import { getOrderRefundState, refundOrder } from "./refund-actions";

const ADMIN = { uid: "admin-1", email: "owner@shop.test" };

function settings(overrides: Record<string, boolean | number> = {}) {
  return { ...resolveStoreSettings(null, "pro"), ...overrides } as any;
}

const PAID_ONLINE = {
  id: "o1",
  store_id: "store-1",
  order_ref: "ORD10011027",
  customer_id: "cust-1",
  total: 840,
  payment_method: "razorpay",
  payment_status: "paid",
  razorpay_payment_id: "pay_123",
  razorpay_order_id: "order_123",
};

const COD = {
  ...PAID_ONLINE,
  payment_method: "cash_on_delivery",
  payment_status: "paid",
  razorpay_payment_id: null,
  razorpay_order_id: null,
};

/** What refundOrder reads inside its transaction, by TABLE: the locked order
 *  row and the refunds already recorded against it. Gateway legs and
 *  reinstated credit read as empty. By table rather than by position, so a
 *  new read in the transaction cannot silently shift every row along. */
function seed(order: any, existingRefunds: any[] = []) {
  dbHolder.current = makeDbMock({
    selectByTable: { orders: [[order]], order_refunds: [existingRefunds] },
    returning: [{ id: "refund-1" }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getManagerIdentity as any).mockResolvedValue(ADMIN);
  (getStoreSettings as any).mockResolvedValue(settings());
  (isStoreSuperadmin as any).mockResolvedValue(true);
  (getStoreGateway as any).mockResolvedValue({
    creds: { keyId: "rzp_test", keySecret: "s" },
    enabled: true,
  });
  seed(PAID_ONLINE);
});

describe("refundOrder — gate and input", () => {
  it("refuses an unauthenticated caller", async () => {
    (getManagerIdentity as any).mockResolvedValue(null);
    expect(await refundOrder("o1", { method: "razorpay" })).toEqual({
      error: "Not authenticated",
    });
  });

  it("refuses an unknown method", async () => {
    const res = await refundOrder("o1", { method: "bitcoin" } as any);
    expect(res.error).toBeTruthy();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses a manual refund with no reference", async () => {
    // The reference is the only evidence a manual refund row will ever carry:
    // the money moved somewhere this system cannot see.
    const res = await refundOrder("o1", { method: "manual" });
    expect(res.error).toContain("reference");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses the gateway for an order that wasn't paid online", async () => {
    seed(COD);
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("wasn't paid online");
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("refuses a gateway refund on an unpaid order", async () => {
    seed({ ...PAID_ONLINE, payment_status: "pending" });
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("hasn't been paid yet");
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("★★ refuses store credit on an order nobody paid for", async () => {
    // Only the gateway used to check, so an undelivered cash-on-delivery
    // order showed its whole total as refundable and "store credit" turned
    // it into a real balance.
    seed({ ...COD, payment_status: "pending", status: "processing" });
    const res = await refundOrder("o1", { method: "store_credit" });
    expect(res.error).toContain("hasn't been paid yet");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });
});

describe("refundOrder — the amount is never the client's", () => {
  it("defaults to the whole order", async () => {
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    await refundOrder("o1", { method: "razorpay" });
    expect(dbHolder.current.calls.values[0].amount).toBe(840);
  });

  it("refuses more than remains after an earlier refund", async () => {
    seed(PAID_ONLINE, [{ amount: 600, status: "completed" }]);
    const res = await refundOrder("o1", { method: "razorpay", amount: 500 });
    expect(res.error).toContain("240.00");
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("★ counts a PENDING refund against the cap", async () => {
    // Otherwise a timed-out refund's money can be handed back a second time
    // while the first is still in flight.
    seed(PAID_ONLINE, [{ amount: 840, status: "pending" }]);
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("already been fully refunded");
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("★ locks the order row FOR UPDATE", async () => {
    // Two admins clicking Refund at the same moment must serialise here; both
    // would otherwise read the same refundable amount and both pass the cap.
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    await refundOrder("o1", { method: "razorpay" });
    expect(dbHolder.current.calls.forUpdate).toContain("update");
  });
});

describe("refundOrder — the row is written before the money moves", () => {
  it("★ inserts a PENDING row carrying an idempotency key, then calls the gateway with it", async () => {
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    await refundOrder("o1", { method: "razorpay" });

    const row = dbHolder.current.calls.values[0];
    expect(row.status).toBe("pending");
    expect(row.idempotencyKey).toEqual(expect.any(String));
    expect(row.idempotencyKey.length).toBeGreaterThan(10);

    // The SAME key reaches Razorpay — that is what makes a retry safe and
    // what reconcile later looks the refund up by.
    expect(rzpRefund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paymentId: "pay_123",
        amountPaise: 84000,
        idempotencyKey: row.idempotencyKey,
      }),
    );
  });

  it("marks the row completed and syncs the order when Razorpay processes it", async () => {
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    const res = await refundOrder("o1", { method: "razorpay" });

    expect(res.status).toBe("completed");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      status: "completed",
      gatewayRefundId: "rfnd_1",
    });
    expect(syncOrderRefundState).toHaveBeenCalledWith("o1");
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.refund_issued" }),
    );
    // ★ The payload must name the amount `amount` and carry the method.
    // `total` is not a declared variable for this event, so templateValues
    // drops it and the customer's refund email goes out with no figure; the
    // method is what stops the copy claiming their card was credited.
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          amount: expect.any(Number),
          paymentMethod: expect.anything(),
        }),
      }),
    );
    const emitted = vi.mocked(emitEvent).mock.calls.at(-1)![0] as {
      payload: Record<string, unknown>;
    };
    expect(emitted.payload).not.toHaveProperty("total");
  });

  it("stays pending when Razorpay accepts it but hasn't settled", async () => {
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "pending" },
    });
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.pendingReconcile).toBe(true);
    expect(syncOrderRefundState).not.toHaveBeenCalled();
  });
});

describe("refundOrder — a timeout is not a failure", () => {
  it("★ leaves the row PENDING and reports no error on an unknown outcome", async () => {
    // The single most important behaviour here. A 5xx or a network timeout may
    // mean the refund WAS created. Failing the row would free the amount and
    // invite a second refund of money already on its way to the customer.
    (rzpRefund as any).mockResolvedValue({
      ok: false,
      error: "socket hang up",
      outcome: "unknown",
    });
    const res = await refundOrder("o1", { method: "razorpay" });

    expect(res.error).toBeUndefined();
    expect(res.status).toBe("pending");
    expect(res.pendingReconcile).toBe(true);
    // Nothing was marked failed — reconcile will find out from the gateway.
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("★ marks the row FAILED on a rejection, so the amount is freed", async () => {
    // A 4xx IS a verdict: nothing happened, so the money must become
    // refundable again rather than being stranded in a pending row forever.
    (rzpRefund as any).mockResolvedValue({
      ok: false,
      error: "The amount is more than the refundable amount.",
      outcome: "rejected",
    });
    const res = await refundOrder("o1", { method: "razorpay" });

    expect(res.error).toContain("refundable");
    expect(dbHolder.current.calls.set[0]).toMatchObject({ status: "failed" });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("fails the row when the gateway was disconnected mid-flight", async () => {
    (getStoreGateway as any).mockResolvedValue(null);
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("Channels");
    expect(dbHolder.current.calls.set[0]).toMatchObject({ status: "failed" });
    expect(rzpRefund).not.toHaveBeenCalled();
  });
});

describe("refundOrder — manual (the COD answer)", () => {
  it("records a completed refund without calling any gateway", async () => {
    seed(COD);
    const res = await refundOrder("o1", {
      method: "manual",
      reference: "UPI-9931XX",
      reason: "Damaged on arrival",
    });

    expect(res.status).toBe("completed");
    expect(rzpRefund).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      method: "manual",
      status: "completed",
      reference: "UPI-9931XX",
      reason: "Damaged on arrival",
      amount: 840,
    });
    expect(syncOrderRefundState).toHaveBeenCalledWith("o1");
  });

  it("still enforces the cap", async () => {
    seed(COD, [{ amount: 840, status: "completed" }]);
    const res = await refundOrder("o1", {
      method: "manual",
      reference: "UPI-1",
    });
    expect(res.error).toContain("already been fully refunded");
  });

  it("is allowed on an ONLINE order too — the merchant may have paid by hand", async () => {
    const res = await refundOrder("o1", {
      method: "manual",
      reference: "NEFT-77",
    });
    expect(res.status).toBe("completed");
    expect(rzpRefund).not.toHaveBeenCalled();
  });
});

describe("refundOrder — who may give money back", () => {
  it("★ owner-only blocks a delegated orders manager", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.ownerOnlyRefunds": true }),
    );
    (isStoreSuperadmin as any).mockResolvedValue(false);

    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("owner");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("owner-only still lets the owner through", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.ownerOnlyRefunds": true }),
    );
    (isStoreSuperadmin as any).mockResolvedValue(true);
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    expect((await refundOrder("o1", { method: "razorpay" })).status).toBe(
      "completed",
    );
  });

  it("lets a manager refund UNDER the approval cap", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.maxRefundWithoutApproval": 500 }),
    );
    (isStoreSuperadmin as any).mockResolvedValue(false);
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    const res = await refundOrder("o1", { method: "razorpay", amount: 200 });
    expect(res.status).toBe("completed");
  });

  it("blocks a manager OVER the approval cap", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.maxRefundWithoutApproval": 500 }),
    );
    (isStoreSuperadmin as any).mockResolvedValue(false);
    const res = await refundOrder("o1", { method: "razorpay", amount: 600 });
    expect(res.error).toContain("owner");
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("★ the cap can't be dodged by leaving the amount blank", async () => {
    // Blank means "refund everything left" — ₹840 here, well over the cap.
    // Checking only `input.amount` would let anyone past by not typing a
    // number, which is why the cap is re-checked once the amount resolves.
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.maxRefundWithoutApproval": 500 }),
    );
    (isStoreSuperadmin as any).mockResolvedValue(false);
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("owner");
    expect(rzpRefund).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The panel's state
// ---------------------------------------------------------------------------

/** What getOrderRefundState reads, by table. */
function seedState(
  order: any,
  opts: { legs?: number; ret?: any; paidForReturn?: number } = {},
) {
  dbHolder.current = makeDbMock({
    selectByTable: {
      orders: [[order]],
      order_refunds: [[], [{ total: String(opts.paidForReturn ?? 0) }]],
      order_payments: [[{ n: String(opts.legs ?? 0) }]],
      order_returns: [opts.ret ? [opts.ret] : []],
      customer_credit_balances: [[{ balance: 0 }]],
    },
  });
}

function facts(over: Record<string, unknown> = {}) {
  return {
    storeId: "store-1",
    paymentStatus: "paid",
    paymentMethod: "razorpay",
    status: "delivered",
    total: 840,
    storeCreditUsed: 0,
    creditReinstated: 0,
    moneyTaken: true,
    refunds: [],
    ...over,
  };
}

describe("getOrderRefundState", () => {
  it("★★ still offers the online refund once part of the order has gone back", async () => {
    // It read `payment_status !== "paid"`, so after one partial refund the
    // online option vanished and the panel claimed the order "was never paid".
    seedState({ ...PAID_ONLINE, payment_status: "partially_refunded" });
    (loadOrderRefundFacts as any).mockResolvedValue(
      facts({
        paymentStatus: "partially_refunded",
        refunds: [{ amount: 300, status: "completed", method: "razorpay" }],
      }),
    );
    const { state } = await getOrderRefundState("o1");
    expect(state!.canRefundOnline).toBe(true);
    expect(state!.onlineBlockedReason).toBeNull();
    expect(state!.refundable).toBe(540);
    expect(state!.moneyRefundable).toBe(540);
  });

  it("explains a store-credit order in its own words, not as cash on delivery", async () => {
    seedState({ ...PAID_ONLINE, payment_method: "store_credit" });
    (loadOrderRefundFacts as any).mockResolvedValue(
      facts({ paymentMethod: "store_credit", storeCreditUsed: 840 }),
    );
    const { state } = await getOrderRefundState("o1");
    expect(state!.canRefundOnline).toBe(false);
    expect(state!.onlineBlockedReason).toContain("store credit");
    expect(state!.onlineBlockedReason).not.toContain("on delivery");
    // Paid with credit: nothing can go back as money.
    expect(state!.moneyRefundable).toBe(0);
    expect(state!.refundable).toBe(840);
  });

  it("★★ a cancelled credit-paid order owes nothing once its credit is reinstated", async () => {
    // The cancellation already gave the ₹840 back; reporting it as owed is
    // what led a merchant to refund it a second time.
    seedState({
      ...PAID_ONLINE,
      payment_method: "store_credit",
      status: "cancelled",
    });
    (loadOrderRefundFacts as any).mockResolvedValue(
      facts({
        paymentMethod: "store_credit",
        status: "cancelled",
        storeCreditUsed: 840,
        creditReinstated: 840,
      }),
    );
    const { state } = await getOrderRefundState("o1");
    expect(state!.refundable).toBe(0);
    expect(state!.refundOwed).toBe(false);
    expect(state!.canRefundToCredit).toBe(false);
  });

  it("a card + credit order can send only the card part back as money", async () => {
    seedState({ ...PAID_ONLINE, status: "cancelled" });
    (loadOrderRefundFacts as any).mockResolvedValue(
      facts({
        status: "cancelled",
        storeCreditUsed: 340,
        creditReinstated: 340,
      }),
    );
    const { state } = await getOrderRefundState("o1");
    expect(state!.refundable).toBe(500);
    expect(state!.moneyRefundable).toBe(500);
    expect(state!.refundOwed).toBe(true);
  });

  it("offers online refunds for a till sale paid through the gateway", async () => {
    seedState(
      { ...PAID_ONLINE, payment_method: "split", razorpay_payment_id: null },
      { legs: 1 },
    );
    (loadOrderRefundFacts as any).mockResolvedValue(
      facts({ paymentMethod: "split" }),
    );
    const { state } = await getOrderRefundState("o1");
    expect(state!.canRefundOnline).toBe(true);
  });

  it("opened for one return, reports what that return is still owed", async () => {
    seedState(PAID_ONLINE, {
      ret: { total: 300, status: "received" },
      paidForReturn: 100,
    });
    (loadOrderRefundFacts as any).mockResolvedValue(facts());
    const { state } = await getOrderRefundState("o1", "ret-1");
    expect(state!.returnRefund).toMatchObject({
      owed: 300,
      refunded: 100,
      remaining: 200,
    });
  });

  it("refuses a return that isn't part of the order", async () => {
    seedState(PAID_ONLINE);
    (loadOrderRefundFacts as any).mockResolvedValue(facts());
    const res = await getOrderRefundState("o1", "someone-elses-return");
    expect(res.error).toContain("isn't part of this order");
  });
});

// ---------------------------------------------------------------------------
// Refunding one return, and what is announced
// ---------------------------------------------------------------------------

describe("refundOrder — a return, and the announcement", () => {
  it("★★ a blank amount on a return means what the RETURN is owed, not the whole order", async () => {
    // Returning one item of an ₹840 order defaulted to refunding all ₹840.
    dbHolder.current = makeDbMock({
      selectByTable: {
        orders: [[PAID_ONLINE]],
        order_refunds: [[]],
        order_returns: [[{ total: 300, status: "received" }]],
      },
      returning: [{ id: "refund-1" }],
    });
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    const res = await refundOrder("o1", {
      method: "razorpay",
      returnId: "ret-1",
    });
    expect(res.error).toBeUndefined();
    const row = dbHolder.current.calls.values[0];
    expect(row.amount).toBe(300);
    expect(row.returnId).toBe("ret-1");
  });

  it("refuses to refund a return before its goods arrive", async () => {
    dbHolder.current = makeDbMock({
      selectByTable: {
        orders: [[PAID_ONLINE]],
        order_refunds: [[]],
        order_returns: [[{ total: 300, status: "approved" }]],
      },
    });
    const res = await refundOrder("o1", {
      method: "razorpay",
      returnId: "ret-1",
    });
    expect(res.error).toContain("received");
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("★ announces nothing while the gateway is still settling", async () => {
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "pending" },
    });
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.pendingReconcile).toBe(true);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("★★ reports a refund Razorpay answers as failed as a failure, and tells nobody it worked", async () => {
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "failed" },
    });
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("couldn't process this refund");
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
