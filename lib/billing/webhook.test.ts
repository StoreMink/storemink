/* eslint-disable @typescript-eslint/no-explicit-any */
// What StoreMink's own Razorpay webhook does with a payment result
// (21 Nov 2026). The rule: it only gets a result recorded SOONER, through the
// same conditional settle reconcile uses, and never decides anything reconcile
// would not.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
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
const collect = vi.hoisted(() => ({ settleAttempt: vi.fn() }));
vi.mock("./collect", () => collect);
const worker = vi.hoisted(() => ({
  advanceAfterPayment: vi.fn(),
  announceAutopayStopped: vi.fn(),
}));
vi.mock("./renewal-worker", () => worker);

import { applyBillingPaymentEvent } from "./webhook";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const STORE = "store-1";

function attempt(over: Record<string, unknown> = {}) {
  return {
    id: "att-1",
    storeId: STORE,
    invoiceId: "inv-1",
    mode: "automatic",
    amountPaise: 240_000,
    invoiceFinalizedAt: "2026-11-17T00:00:00.000Z",
    ...over,
  };
}
const seed = (rows: any[] | Error) =>
  (dbHolder.current = makeDbMock({ selectQueue: [rows] }));

const captured = (over: Record<string, unknown> = {}) =>
  applyBillingPaymentEvent({
    result: "captured",
    providerOrderId: "order_1",
    providerPaymentId: "pay_1",
    amountPaise: 240_000,
    currency: "INR",
    now: NOW,
    ...over,
  });
const failed = (over: Record<string, unknown> = {}) =>
  applyBillingPaymentEvent({
    result: "failed",
    providerOrderId: "order_1",
    providerPaymentId: "pay_1",
    amountPaise: 240_000,
    currency: "INR",
    failureReason: "Insufficient balance",
    now: NOW,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  collect.settleAttempt.mockResolvedValue("captured");
  seed([attempt()]);
});

describe("a captured payment", () => {
  it("★★ settles the attempt and moves the plan on, at once", async () => {
    expect(await captured()).toBe("settled");
    expect(collect.settleAttempt).toHaveBeenCalledWith("att-1", "captured", {
      providerPaymentId: "pay_1",
      now: NOW,
    });
    expect(worker.advanceAfterPayment).toHaveBeenCalledWith(STORE, NOW);
  });

  it("finds the attempt by the gateway order the payment was made on", async () => {
    await captured();
    const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[0]);
    expect(where.sql).toContain('"provider_order_id" = $1');
    expect(where.params).toEqual(["order_1"]);
  });

  it("★★ a payment on an UNISSUED invoice is left to its own checkout", async () => {
    // A first payment, plan change or location purchase: the browser's
    // confirm is about to issue the invoice and apply the purchase.
    seed([attempt({ mode: "manual", invoiceFinalizedAt: null })]);
    expect(await captured()).toBe("deferred");
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("★★ a different amount or currency decides nothing: reconcile files it for a person", async () => {
    expect(await captured({ amountPaise: 100 })).toBe("mismatch");
    seed([attempt()]);
    expect(await captured({ currency: "USD" })).toBe("mismatch");
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("a manual payment of an issued invoice is settled too", async () => {
    seed([attempt({ mode: "manual" })]);
    expect(await captured()).toBe("settled");
  });

  it("★ a replay changes nothing and announces nothing", async () => {
    // The settle is a conditional claim: a second delivery moves no row.
    collect.settleAttempt.mockResolvedValue(null);
    expect(await captured()).toBe("ignored");
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("a deleted store's payment is recorded, with no plan to move", async () => {
    seed([attempt({ storeId: null })]);
    expect(await captured()).toBe("settled");
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });
});

describe("a failed payment", () => {
  beforeEach(() => collect.settleAttempt.mockResolvedValue("failed"));

  it("★★ an automatic debit is failed now, and the last try asks the merchant to pay", async () => {
    expect(await failed()).toBe("settled");
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "failed",
      expect.objectContaining({
        failureCode: "gateway_failed",
        failureReason: "Insufficient balance",
      }),
    );
    expect(worker.announceAutopayStopped).toHaveBeenCalledWith({
      storeId: STORE,
      invoiceId: "inv-1",
      now: NOW,
    });
  });

  it("★★ a failed try in a MANUAL checkout is ignored: its order is still payable", async () => {
    seed([attempt({ mode: "manual" })]);
    expect(await failed()).toBe("ignored");
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ a late `failed` after a capture is refused by the settle and announces nothing", async () => {
    collect.settleAttempt.mockResolvedValue("captured");
    expect(await failed()).toBe("ignored");
    expect(worker.announceAutopayStopped).not.toHaveBeenCalled();
  });
});

describe("what it leaves alone", () => {
  it("an order no billing attempt was made on (a credit pack, a test event)", async () => {
    seed([]);
    expect(await captured()).toBe("unmatched");
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("an event with no order or payment id", async () => {
    expect(await captured({ providerOrderId: "" })).toBe("ignored");
    expect(await captured({ providerPaymentId: "" })).toBe("ignored");
  });

  it("★★ never throws: a failed read or write is reported and left to reconcile", async () => {
    seed(new Error("db down"));
    expect(await captured()).toBe("error");

    seed([attempt()]);
    collect.settleAttempt.mockRejectedValue(new Error("boom"));
    expect(await captured()).toBe("error");
  });
});
