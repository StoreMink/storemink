/* eslint-disable @typescript-eslint/no-explicit-any */
// The expired-pickup sweep. Its own file because pickup.test.ts fakes a db
// shaped for the location reads, and this needs an UPDATE … RETURNING.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));
vi.mock("@/lib/notifications/record", () => ({ recordEvent: vi.fn() }));
vi.mock("@/lib/payments/refund-reconcile", () => ({
  refundDueForOrder: vi.fn(async () => 0),
}));
vi.mock("@/lib/orders/cancel", () => ({
  releaseCancelledOrder: vi.fn(async () => {}),
}));
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({ getCurrentStore: vi.fn() }));

import { sweepExpiredPickups } from "./pickup";
import { recordEvent } from "@/lib/notifications/record";
import { refundDueForOrder } from "@/lib/payments/refund-reconcile";
import { releaseCancelledOrder } from "@/lib/orders/cancel";

const expiredRow = {
  id: "o1",
  store_id: "s1",
  order_ref: "ORD1",
  customer_id: "c1",
  pickup_location_id: "loc1",
  total: 500,
  payment_status: "paid",
};

beforeEach(() => {
  dbHolder.current = makeDbMock({ returning: [expiredRow] });
});

describe("sweepExpiredPickups", () => {
  it("★★ runs the SHARED cancellation cleanup for every expired pickup", async () => {
    // It used to release the holds and nothing else, so store credit a
    // collection was paid with stayed spent after the order died.
    expect(await sweepExpiredPickups()).toBe(1);
    expect(releaseCancelledOrder).toHaveBeenCalledWith(
      "s1",
      "o1",
      expect.any(Function),
      "pickup_expired",
    );
  });

  it("tells the merchant what they now owe back", async () => {
    vi.mocked(refundDueForOrder).mockResolvedValue(500);
    await sweepExpiredPickups();
    expect(vi.mocked(recordEvent).mock.calls[0][0]).toMatchObject({
      type: "order.pickup_expired",
      payload: { orderRef: "ORD1", refund_due: 500 },
    });
  });

  it("omits the refund line when nothing is owed", async () => {
    await sweepExpiredPickups();
    const payload = vi.mocked(recordEvent).mock.calls[0][0].payload as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("refund_due");
  });

  it("a cleanup failure does not stop the merchant being told", async () => {
    vi.mocked(releaseCancelledOrder).mockRejectedValue(new Error("boom"));
    expect(await sweepExpiredPickups()).toBe(1);
    expect(recordEvent).toHaveBeenCalled();
  });

  it("does nothing when the claim fails", async () => {
    dbHolder.current = {
      db: {
        update: () => {
          throw new Error("down");
        },
      },
    };
    expect(await sweepExpiredPickups()).toBe(0);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });
});
