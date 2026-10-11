/* eslint-disable @typescript-eslint/no-explicit-any */
// The pending-payment reaper. The one rule every case below defends: an order
// whose money may have been taken is never cancelled and restocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));
vi.mock("@/lib/notifications/record", () => ({
  recordEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/payments/provider", () => ({
  lookupStoreGateway: vi.fn(),
}));
vi.mock("@/lib/inventory/reservations", () => ({
  sweepExpiredHolds: vi.fn(async () => 0),
}));
vi.mock("@/lib/fulfilment/pickup", () => ({
  sweepExpiredPickups: vi.fn(async () => 0),
  sweepPickupReminders: vi.fn(async () => 0),
}));
vi.mock("@/lib/payments/capture", () => ({
  settleOrderPayment: vi.fn(),
}));
vi.mock("@/lib/payments/refund-reconcile", () => ({
  sweepPendingRefunds: vi.fn(async () => 0),
}));
vi.mock("@/lib/orders/mark-paid", () => ({
  markOrderPaid: vi.fn(async () => "paid"),
}));
vi.mock("@/lib/orders/cancel", () => ({
  releaseCancelledOrder: vi.fn(async () => {}),
}));

import { GET } from "./route";
import { recordEvent } from "@/lib/notifications/record";
import { lookupStoreGateway } from "@/lib/payments/provider";
import { settleOrderPayment } from "@/lib/payments/capture";
import { markOrderPaid } from "@/lib/orders/mark-paid";
import { releaseCancelledOrder } from "@/lib/orders/cancel";

const CREDS = { keyId: "rzp_live_x", keySecret: "s" };
const HOUR = 60 * 60_000;

function pending(over: Record<string, unknown> = {}) {
  return {
    id: "o1",
    store_id: "s1",
    razorpay_order_id: "order_1",
    applied_coupon_code: null,
    order_ref: "ORD1",
    customer_id: "c1",
    total: 500,
    store_credit_used: 0,
    created_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    ...over,
  };
}

/** `pendingRows` feeds the main read, `lateRows` the late-payment sweep. */
function seed(pendingRows: any[], lateRows: any[] = []) {
  dbHolder.current = makeDbMock({
    selectByTable: { orders: [pendingRows, lateRows] },
    returning: [{ id: "o1" }],
  });
}

const run = () =>
  GET(
    new Request("https://storemink.com/api/cron/expire-pending-payments", {
      headers: { authorization: "Bearer secret" },
    }),
  );

beforeEach(() => {
  process.env.CRON_SECRET = "secret";
  vi.mocked(lookupStoreGateway).mockResolvedValue({
    status: "connected",
    gateway: { creds: CREDS, enabled: true },
  } as any);
  vi.mocked(settleOrderPayment).mockResolvedValue({ kind: "none" });
  vi.mocked(markOrderPaid).mockResolvedValue("paid");
  seed([]);
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("expire-pending-payments", () => {
  it("refuses without the cron secret", async () => {
    const res = await GET(new Request("https://storemink.com/x"));
    expect(res.status).toBe(401);
  });

  it("★ marks a captured payment paid and never cancels it", async () => {
    seed([pending()]);
    vi.mocked(settleOrderPayment).mockResolvedValue({
      kind: "captured",
      paymentId: "pay_1",
      amountPaise: 50000,
    });
    const body = await (await run()).json();
    expect(markOrderPaid).toHaveBeenCalledWith("o1", "pay_1");
    expect(body.paid).toBe(1);
    expect(body.expired).toBe(0);
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });

  it("★★ captures with the amount the gateway was asked for (total less store credit)", async () => {
    seed([pending({ total: 500, store_credit_used: 200 })]);
    await run();
    expect(vi.mocked(settleOrderPayment).mock.calls[0]).toEqual([
      CREDS,
      "order_1",
      30000,
      { capture: true },
    ]);
  });

  it("★ skips an order whose gateway answer is unknown", async () => {
    seed([pending()]);
    vi.mocked(settleOrderPayment).mockResolvedValue({ kind: "unknown" });
    const body = await (await run()).json();
    expect(body.expired).toBe(0);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★★ leaves an order alone when the store's gateway can't be READ", async () => {
    // A database blip or a rotated key used to fall through to expiry and
    // cancel orders whose shoppers had paid.
    seed([pending()]);
    vi.mocked(lookupStoreGateway).mockResolvedValue({ status: "error" });
    const body = await (await run()).json();
    expect(body.expired).toBe(0);
    expect(settleOrderPayment).not.toHaveBeenCalled();
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });

  it("expires it once the gateway has been unreadable for over a week", async () => {
    seed([
      pending({
        created_at: new Date(Date.now() - 8 * 24 * HOUR).toISOString(),
      }),
    ]);
    vi.mocked(lookupStoreGateway).mockResolvedValue({ status: "error" });
    const body = await (await run()).json();
    expect(body.expired).toBe(1);
  });

  it("★★ expires an unpaid order through the SHARED cancellation cleanup", async () => {
    // The hand-written restock never gave back the store credit the order
    // had spent at checkout.
    seed([pending({ applied_coupon_code: " save10 " })]);
    const body = await (await run()).json();
    expect(body.expired).toBe(1);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      paymentStatus: "failed",
      status: "cancelled",
    });
    expect(releaseCancelledOrder).toHaveBeenCalledWith(
      "s1",
      "o1",
      expect.any(Function),
      "payment_expired",
    );
    expect(vi.mocked(recordEvent).mock.calls[0][0]).toMatchObject({
      type: "order.payment_failed",
    });
    // The coupon use is given back.
    expect(dbHolder.current.calls.execute).toHaveLength(1);
  });

  it("a disconnected gateway expires the order (nothing to verify against)", async () => {
    seed([pending()]);
    vi.mocked(lookupStoreGateway).mockResolvedValue({ status: "none" });
    const body = await (await run()).json();
    expect(body.expired).toBe(1);
    expect(settleOrderPayment).not.toHaveBeenCalled();
  });

  describe("★★ payments that land after the order expired", () => {
    const expired = {
      id: "o9",
      store_id: "s1",
      razorpay_order_id: "order_9",
      total: 400,
      store_credit_used: 0,
    };

    it("records a captured late payment so it can be refunded", async () => {
      seed([], [expired]);
      vi.mocked(settleOrderPayment).mockResolvedValue({
        kind: "captured",
        paymentId: "pay_9",
        amountPaise: 40000,
      });
      vi.mocked(markOrderPaid).mockResolvedValue("late");
      const body = await (await run()).json();
      expect(body.latePayments).toBe(1);
      expect(markOrderPaid).toHaveBeenCalledWith("o9", "pay_9");
    });

    it("★ never CAPTURES a hold on a dead order", async () => {
      // Razorpay voiding an uncaptured hold returns the shopper's money by
      // itself; capturing it would take money for a cancelled order.
      seed([], [expired]);
      await run();
      expect(vi.mocked(settleOrderPayment).mock.calls[0][3]).toEqual({
        capture: false,
      });
    });

    it("does nothing when no money arrived", async () => {
      seed([], [expired]);
      const body = await (await run()).json();
      expect(body.latePayments).toBe(0);
      expect(markOrderPaid).not.toHaveBeenCalled();
    });

    it("skips a store whose gateway is not connected", async () => {
      seed([], [expired]);
      vi.mocked(lookupStoreGateway).mockResolvedValue({ status: "error" });
      const body = await (await run()).json();
      expect(body.latePayments).toBe(0);
      expect(settleOrderPayment).not.toHaveBeenCalled();
    });
  });
});
