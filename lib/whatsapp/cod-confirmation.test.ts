/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/orders/approve-cancellation", () => ({
  approveCancellation: vi.fn(),
}));
vi.mock("./channel", () => ({ loadWhatsAppSender: vi.fn() }));
vi.mock("./send", () => ({ sendWhatsAppText: vi.fn() }));
vi.mock("./inbox", () => ({ recordOutboundMessage: vi.fn(async () => "m") }));

import {
  codReplyText,
  handleCodReply,
  markCodConfirmationRequested,
  tapperOwnsOrder,
} from "./cod-confirmation";
import { approveCancellation } from "@/lib/orders/approve-cancellation";
import { loadWhatsAppSender } from "./channel";
import { sendWhatsAppText } from "./send";
import { recordOutboundMessage } from "./inbox";
import { orders } from "@/drizzle/schema";

const STORE = "11111111-1111-4111-8111-111111111111";
const ORDER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PHONE = "+919876543210";

const ORDER_ROW = {
  id: ORDER,
  orderRef: "ORD10010004",
  status: "pending",
  // What placeOrder really stores for COD; `cod` is only the checkout choice.
  paymentMethod: "cash_on_delivery",
  codConfirmation: "requested",
  customerId: "cust-1",
  shippingAddress: { phone: "9876543210" },
  customerPhone: null,
  storeName: "Acme Juice",
};

function setup(
  orderRows: any[][] = [[ORDER_ROW]],
  returningQueue: any[][] = [[{ id: ORDER }]],
) {
  dbHolder.current = makeDbMock({ selectQueue: orderRows, returningQueue });
  return dbHolder.current;
}

const tap = (action: "confirm" | "cancel", phone = PHONE) =>
  handleCodReply({
    storeId: STORE,
    conversationId: "conv-1",
    phone,
    contactLabel: "Rohan",
    reply: { action, orderId: ORDER },
  });

beforeEach(() => {
  setup();
  vi.mocked(loadWhatsAppSender).mockResolvedValue({
    token: "tok",
    wabaId: "W",
    phoneNumberId: "P",
    displayPhone: "+91",
    precedence: "whatsapp_first",
    codConfirmation: true,
  });
  vi.mocked(sendWhatsAppText).mockResolvedValue({
    sent: true,
    messageId: "wamid.r",
    logId: null,
  });
  vi.mocked(approveCancellation).mockResolvedValue({
    success: true,
    refundDue: 0,
  });
});

describe("tapperOwnsOrder", () => {
  it("matches the delivery phone or the account phone, in any stored shape", () => {
    expect(
      tapperOwnsOrder(PHONE, {
        customerPhone: null,
        shippingAddress: { phone: "9876543210" },
      }),
    ).toBe(true);
    expect(
      tapperOwnsOrder(PHONE, {
        customerPhone: "+919876543210",
        shippingAddress: {},
      }),
    ).toBe(true);
  });

  it("★ refuses a stranger, and refuses when there is nothing to compare", () => {
    expect(
      tapperOwnsOrder("+919999999999", {
        customerPhone: "+919876543210",
        shippingAddress: { phone: "9876543210" },
      }),
    ).toBe(false);
    expect(
      tapperOwnsOrder(PHONE, { customerPhone: null, shippingAddress: null }),
    ).toBe(false);
    expect(
      tapperOwnsOrder("", { customerPhone: null, shippingAddress: null }),
    ).toBe(false);
  });
});

describe("codReplyText", () => {
  it("names the order and never uses a long dash", () => {
    for (const outcome of [
      "confirmed",
      "already_confirmed",
      "cancelled",
      "already_cancelled",
      "expired",
      "too_late",
      "failed",
    ] as const) {
      const t = codReplyText(outcome, "ORD1", "Acme");
      expect(t, outcome).toContain("ORD1");
      expect(t, outcome).not.toMatch(/[—–]/);
    }
    expect(codReplyText("too_late", "ORD1", "Acme")).toContain("Acme");
    expect(codReplyText("failed", "ORD1", null)).toContain("the shop");
  });

  it("★ says nothing about an order to a phone that does not own it", () => {
    expect(codReplyText("not_allowed", "ORD1", "Acme")).toBeNull();
  });
});

describe("handleCodReply", () => {
  it("confirm marks the order confirmed and tells the customer, in the thread", async () => {
    const mock = dbHolder.current;
    const r = await tap("confirm");
    expect(r).toEqual({ outcome: "confirmed", needsHuman: false });
    expect(mock.calls.update).toContain(orders);
    expect(mock.calls.set).toContainEqual(
      expect.objectContaining({ codConfirmation: "confirmed" }),
    );
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE,
        to: PHONE,
        body: expect.stringContaining("ORD10010004 is confirmed"),
      }),
    );
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: "conv-1",
        source: "automation",
        status: "sent",
      }),
    );
    expect(approveCancellation).not.toHaveBeenCalled();
  });

  it("★ a confirm that loses a race with a cancel reports the cancel", async () => {
    setup([[ORDER_ROW]], [[]]);
    const r = await tap("confirm");
    expect(r.outcome).toBe("already_cancelled");
  });

  it("★ a confirm after the store's automatic cancellation goes to a person", async () => {
    // The customer still wants the goods; only the shop can put them back.
    setup([
      [{ ...ORDER_ROW, status: "cancelled", codConfirmation: "expired" }],
    ]);
    const mock = dbHolder.current;
    const r = await tap("confirm");
    expect(r).toEqual({ outcome: "expired", needsHuman: true });
    expect(mock.calls.update).toHaveLength(0);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("not confirmed in time"),
      }),
    );
  });

  it("a confirm that loses a race with the automatic cancellation says so", async () => {
    setup(
      [
        [ORDER_ROW],
        [{ ...ORDER_ROW, status: "cancelled", codConfirmation: "expired" }],
      ],
      [[]],
    );
    expect((await tap("confirm")).outcome).toBe("expired");
  });

  it("a second confirm is answered, not re-written", async () => {
    setup([[{ ...ORDER_ROW, codConfirmation: "confirmed" }]]);
    const mock = dbHolder.current;
    const r = await tap("confirm");
    expect(r.outcome).toBe("already_confirmed");
    expect(mock.calls.update).toHaveLength(0);
    expect(sendWhatsAppText).toHaveBeenCalled();
  });

  it("★ cancel goes through the one cancellation, moving no money", async () => {
    const mock = dbHolder.current;
    const r = await tap("cancel");
    expect(r).toEqual({ outcome: "cancelled", needsHuman: false });
    expect(approveCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE,
        orderId: ORDER,
        refundDestination: "later",
        restock: true,
        notify: true,
        fromRequest: true,
        actorId: "cust-1",
        customerId: "cust-1",
      }),
    );
    expect(mock.calls.set).toContainEqual(
      expect.objectContaining({ codConfirmation: "cancelled" }),
    );
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("has been cancelled"),
      }),
    );
  });

  it("★ cancel after it has shipped is refused and handed to a person", async () => {
    setup([[{ ...ORDER_ROW, status: "shipped" }]]);
    const r = await tap("cancel");
    expect(r).toEqual({ outcome: "too_late", needsHuman: true });
    expect(approveCancellation).not.toHaveBeenCalled();
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Someone from Acme Juice"),
      }),
    );
  });

  it("a refused cancellation re-reads the order and tells the truth", async () => {
    vi.mocked(approveCancellation).mockResolvedValue({ error: "moved on" });
    setup([[ORDER_ROW], [{ ...ORDER_ROW, status: "shipped" }]]);
    const r = await tap("cancel");
    expect(r).toEqual({ outcome: "too_late", needsHuman: true });
  });

  it("a cancellation that throws goes to a person", async () => {
    vi.mocked(approveCancellation).mockRejectedValue(new Error("boom"));
    setup([[ORDER_ROW], [ORDER_ROW]]);
    const r = await tap("cancel");
    expect(r).toEqual({ outcome: "failed", needsHuman: true });
  });

  it("an already-cancelled order is said so, both ways", async () => {
    setup([[{ ...ORDER_ROW, status: "cancelled" }]]);
    expect((await tap("cancel")).outcome).toBe("already_cancelled");
    setup([[{ ...ORDER_ROW, status: "cancelled" }]]);
    expect((await tap("confirm")).outcome).toBe("already_cancelled");
    expect(approveCancellation).not.toHaveBeenCalled();
  });

  it("★★ a tap from a phone that is not the order's changes nothing and says nothing", async () => {
    const mock = dbHolder.current;
    const r = await tap("cancel", "+919999999999");
    expect(r).toEqual({ outcome: "not_allowed", needsHuman: true });
    expect(approveCancellation).not.toHaveBeenCalled();
    expect(mock.calls.update).toHaveLength(0);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("★★ acts on an order stored as cash_on_delivery, the value checkout writes", async () => {
    // The event payload says `cod` and the row says `cash_on_delivery`;
    // reading one for the other refused every real tap on dev.
    setup([[{ ...ORDER_ROW, paymentMethod: "cash_on_delivery" }]]);
    expect((await tap("confirm")).outcome).toBe("confirmed");
  });

  it("★ refuses an order that is not cash on delivery", async () => {
    setup([[{ ...ORDER_ROW, paymentMethod: "razorpay" }]]);
    const r = await tap("cancel");
    expect(r.outcome).toBe("not_allowed");
    expect(approveCancellation).not.toHaveBeenCalled();
  });

  it("★ refuses an order in no store the tap came for", async () => {
    setup([[]]);
    const r = await tap("confirm");
    expect(r.outcome).toBe("not_allowed");
  });

  it("a failed reply is filed as failed; the action still stands", async () => {
    vi.mocked(sendWhatsAppText).mockResolvedValue({
      sent: false,
      outcome: "rejected",
      error: "Outside window",
    });
    const r = await tap("confirm");
    expect(r.outcome).toBe("confirmed");
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "failed", error: "Outside window" }),
    );
  });

  it("a paused number cannot answer, but the action stands", async () => {
    vi.mocked(loadWhatsAppSender).mockResolvedValue(null);
    const r = await tap("confirm");
    expect(r.outcome).toBe("confirmed");
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });
});

describe("markCodConfirmationRequested", () => {
  it("writes 'requested' only over nothing, scoped to the store", async () => {
    const mock = setup();
    await markCodConfirmationRequested(STORE, ORDER);
    expect(mock.calls.update).toEqual([orders]);
    expect(mock.calls.set[0]).toMatchObject({ codConfirmation: "requested" });
  });

  it("never throws", async () => {
    dbHolder.current = makeDbMock({ failUpdateFor: [orders] });
    await expect(
      markCodConfirmationRequested(STORE, ORDER),
    ).resolves.toBeUndefined();
  });
});
