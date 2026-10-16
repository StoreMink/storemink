/* eslint-disable @typescript-eslint/no-explicit-any */
// The expired-pickup sweep. Its own file because pickup.test.ts fakes a db
// shaped for the location reads, and this needs an UPDATE … RETURNING.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
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

  // ★ The customer's WhatsApp read "was not collected from - by its deadline"
  // (and the email dropped its "Pickup location" row) because this was the
  // one pickup emitter that never said where.
  it("★ names the shop the order was waiting at", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ ...expiredRow, location_name: "Connaught Place" }],
    });
    await sweepExpiredPickups();
    expect(vi.mocked(recordEvent).mock.calls[0][0]).toMatchObject({
      type: "order.pickup_expired",
      payload: { orderRef: "ORD1", pickupLocation: "Connaught Place" },
    });
  });

  it("★ reads the name in the claim itself, with no read per order", async () => {
    await sweepExpiredPickups();
    const mock = dbHolder.current;
    expect(mock.calls.select).toHaveLength(0);
    // update → set → where → returning(projection)
    const setStep =
      mock.db.update.mock.results[0].value.set.mock.results[0].value;
    const whereStep = setStep.where.mock.results[0].value;
    const projection = whereStep.returning.mock.calls[0][0];
    const text = new PgDialect()
      .sqlToQuery(projection.location_name)
      .sql.replace(/\s+/g, " ");
    expect(text).toMatch(/select l\.name from "store_locations" l/);
    expect(text).toMatch(/where l\.id = "orders"\."pickup_location_id"/);
  });

  it("a shop with no name on record still sends the rest", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ ...expiredRow, location_name: null }],
    });
    expect(await sweepExpiredPickups()).toBe(1);
    expect(vi.mocked(recordEvent).mock.calls[0][0].payload).toMatchObject({
      pickupLocation: "",
    });
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
