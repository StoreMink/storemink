/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";
import {
  lookupOrdersForPhone,
  orderStatusAnswer,
  orderStatusLine,
  ordersToReport,
  type OrderForStatus,
} from "./order-status-reply";

const IST = "Asia/Kolkata";
const NOW = new Date("2026-10-14T10:00:00+05:30");

function order(over: Partial<OrderForStatus> = {}): OrderForStatus {
  return {
    id: "o1",
    orderRef: "ORD10011027",
    createdAt: "2026-10-12T09:00:00+05:30",
    status: "processing",
    fulfilmentType: "delivery",
    pickupStatus: null,
    pickupReadyAt: null,
    pickupExpiresAt: null,
    pickupLocationName: null,
    deliveredAt: null,
    shipment: null,
    ...over,
  };
}

const parcel = (over: Record<string, unknown> = {}) => ({
  status: "in_transit",
  courierName: "Delhivery",
  awb: "AWB123",
  trackingUrl: "https://shiprocket.co/tracking/AWB123",
  estimatedDeliveryAt: "2026-10-15T18:00:00+05:30",
  deliveredAt: null,
  ...over,
});

describe("orderStatusLine", () => {
  it("names the order, the day it was placed and where it is, in the order page's words", () => {
    expect(orderStatusLine(order(), IST, NOW)).toEqual({
      text: "Order ORD10011027, placed 12 Oct: Being prepared.",
      trouble: false,
    });
    expect(orderStatusLine(order({ status: "pending" }), IST, NOW).text).toBe(
      "Order ORD10011027, placed 12 Oct: Order placed.",
    );
  });

  it("a parcel on its way gets the courier, the date and the tracking link", () => {
    expect(
      orderStatusLine(
        order({ status: "shipped", shipment: parcel() }),
        IST,
        NOW,
      ).text,
    ).toBe(
      "Order ORD10011027, placed 12 Oct: On the way with Delhivery. Expected by 15 Oct.\nTrack it: https://shiprocket.co/tracking/AWB123",
    );
    expect(
      orderStatusLine(
        order({
          status: "shipped",
          shipment: parcel({
            status: "out_for_delivery",
            trackingUrl: null,
            estimatedDeliveryAt: null,
          }),
        }),
        IST,
        NOW,
      ).text,
    ).toBe(
      "Order ORD10011027, placed 12 Oct: Out for delivery with Delhivery.\nTracking number: AWB123",
    );
  });

  it("★ only an https tracking link is sent", () => {
    const line = orderStatusLine(
      order({
        status: "shipped",
        shipment: parcel({ trackingUrl: "javascript:alert(1)" }),
      }),
      IST,
      NOW,
    );
    expect(line.text).not.toContain("javascript");
    expect(line.text).toContain("Tracking number: AWB123");
  });

  it("★ a delivery in trouble says so, without a link, and asks for a person", () => {
    const line = orderStatusLine(
      order({ status: "shipped", shipment: parcel({ status: "ndr" }) }),
      IST,
      NOW,
    );
    expect(line).toEqual({
      text: "Order ORD10011027, placed 12 Oct: The courier couldn't deliver it.",
      trouble: true,
    });
  });

  it("delivered and cancelled orders say so, and the order outranks a lagging parcel", () => {
    expect(
      orderStatusLine(
        order({
          status: "delivered",
          deliveredAt: "2026-10-13T15:00:00+05:30",
          shipment: parcel({ status: "in_transit" }),
        }),
        IST,
        NOW,
      ).text,
    ).toBe("Order ORD10011027, placed 12 Oct: Delivered on 13 Oct.");
    expect(orderStatusLine(order({ status: "cancelled" }), IST, NOW).text).toBe(
      "Order ORD10011027, placed 12 Oct: Cancelled.",
    );
  });

  it("a collection names the shop and how long it is held", () => {
    expect(
      orderStatusLine(
        order({
          fulfilmentType: "pickup",
          pickupStatus: "ready",
          pickupLocationName: "MG Road",
          pickupExpiresAt: "2026-10-20T20:00:00+05:30",
        }),
        IST,
        NOW,
      ).text,
    ).toBe(
      "Order ORD10011027, placed 12 Oct: Ready to collect at MG Road. Held until 20 Oct.",
    );
    expect(
      orderStatusLine(
        order({
          fulfilmentType: "pickup",
          pickupStatus: "awaiting",
          pickupLocationName: "MG Road",
          pickupReadyAt: "2026-10-16T10:00:00+05:30",
        }),
        IST,
        NOW,
      ).text,
    ).toBe(
      "Order ORD10011027, placed 12 Oct: Being prepared for collection at MG Road. Ready from 16 Oct.",
    );
  });
});

describe("ordersToReport", () => {
  it("lists open orders newest first, at most three, and counts the rest", () => {
    const all = [1, 2, 3, 4, 5].map((n) =>
      order({
        id: `o${n}`,
        orderRef: `ORD${n}`,
        createdAt: `2026-10-0${n}T10:00:00Z`,
      }),
    );
    const r = ordersToReport(all, NOW);
    expect(r.report.map((o) => o.orderRef)).toEqual(["ORD5", "ORD4", "ORD3"]);
    expect(r.moreOpen).toBe(2);
    expect(r.open).toBe(true);
  });

  it("with nothing open, the latest order only while it is recent", () => {
    const delivered = order({ status: "delivered" });
    expect(ordersToReport([delivered], NOW).report).toEqual([delivered]);
    expect(
      ordersToReport(
        [order({ status: "delivered", createdAt: "2026-06-01T10:00:00Z" })],
        NOW,
      ).report,
    ).toEqual([]);
  });
});

describe("orderStatusAnswer", () => {
  const base = {
    storeName: "Echoss",
    timeZone: IST,
    now: NOW,
    ordersUrl: "https://echoss.storemink.com/orders",
  };

  it("answers one open order and leaves the conversation with the system", () => {
    const a = orderStatusAnswer({
      ...base,
      lookup: { ok: true, orders: [order()] },
    });
    expect(a).toEqual({
      body: [
        "Here's the latest on your order:",
        "Order ORD10011027, placed 12 Oct: Being prepared.",
        "See all your orders: https://echoss.storemink.com/orders",
        "Reply here if you need anything else.",
      ].join("\n\n"),
      needsHuman: false,
      answered: true,
    });
  });

  it("★ nothing found, or a failed lookup, hands the chat to a person", () => {
    expect(
      orderStatusAnswer({ ...base, lookup: { ok: true, orders: [] } }),
    ).toEqual({
      body: "We couldn't find a recent order placed with this number. Someone from Echoss will reply here.",
      needsHuman: true,
      answered: false,
    });
    expect(orderStatusAnswer({ ...base, lookup: { ok: false } })).toMatchObject(
      { needsHuman: true, answered: false },
    );
  });

  it("★ a delivery in trouble is answered AND handed to a person", () => {
    const a = orderStatusAnswer({
      ...base,
      lookup: {
        ok: true,
        orders: [
          order({
            status: "shipped",
            shipment: parcel({ status: "rto_initiated" }),
          }),
        ],
      },
    });
    expect(a.needsHuman).toBe(true);
    expect(a.answered).toBe(true);
    expect(a.body).toContain("Someone from Echoss will look into this");
  });

  it("no link while the store is not open to the public", () => {
    const a = orderStatusAnswer({
      ...base,
      ordersUrl: null,
      lookup: { ok: true, orders: [order()] },
    });
    expect(a.body).not.toContain("See all your orders");
  });

  it("never uses a long dash", () => {
    const a = orderStatusAnswer({
      ...base,
      lookup: {
        ok: true,
        orders: [
          order(),
          order({ id: "o2", status: "shipped", shipment: parcel() }),
        ],
      },
    });
    expect(a.body).not.toMatch(/[–—]/);
  });
});

describe("lookupOrdersForPhone", () => {
  it("★ reads only this store's orders owned by the phone or its account", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const r = await lookupOrdersForPhone({
      storeId: "s1",
      phone: "+919876543210",
      userId: "u1",
    });
    expect(r).toEqual({ ok: true, orders: [] });
    const where = dbHolder.current.calls.where[0];
    const text = sqlText(where);
    expect(text).toContain("->>'phone' = any(");
    expect(text).toContain("is distinct from 'pos'");
    expect(sqlParamValues(where)).toEqual(expect.arrayContaining(["s1", "u1"]));
  });

  it("joins the newest live parcel to each order", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o1",
            orderRef: "ORD1",
            createdAt: "2026-10-12T00:00:00Z",
            status: "shipped",
            fulfilmentType: "delivery",
            pickupStatus: null,
            pickupReadyAt: null,
            pickupExpiresAt: null,
            pickupLocationName: null,
            deliveredAt: null,
          },
        ],
        [
          { orderId: "o1", ...parcel({ status: "cancelled", awb: "OLD" }) },
          { orderId: "o1", ...parcel({ awb: "NEW" }) },
        ],
      ],
    });
    const r = await lookupOrdersForPhone({
      storeId: "s1",
      phone: "+919876543210",
      userId: null,
    });
    expect(r.ok && r.orders[0].shipment?.awb).toBe("NEW");
  });

  it("a failed read is reported, never thrown", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("down")] });
    await expect(
      lookupOrdersForPhone({
        storeId: "s1",
        phone: "+919876543210",
        userId: null,
      }),
    ).resolves.toEqual({ ok: false });
  });
});
