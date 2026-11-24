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
const collect = vi.hoisted(() => ({
  settleAttempt: vi.fn(),
  fileClosedAttemptPayment: vi.fn(async () => true),
}));
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
    state: "processing",
    failureCode: null,
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

// PR #303 re-review, 22 Nov 2026. Pay now cancels a checkout whose amount
// changed, but its Razorpay order stays payable from a tab left open. The
// capture used to end here as "ignored", recorded nowhere.
describe("★★ a payment captured on an attempt that was already closed", () => {
  it("is filed for a person and never settled", async () => {
    seed([
      attempt({
        mode: "manual",
        state: "cancelled",
        failureCode: "amount_changed",
      }),
    ]);
    expect(await captured()).toBe("closed_attempt");
    expect(collect.fileClosedAttemptPayment).toHaveBeenCalledWith({
      storeId: STORE,
      invoiceId: "inv-1",
      attemptId: "att-1",
      providerPaymentId: "pay_1",
      providerOrderId: "order_1",
      expectedPaise: 240_000,
      observedPaise: 240_000,
      closedAs: "cancelled",
      closedCode: "amount_changed",
      automatic: false,
      source: "webhook",
      now: NOW,
    });
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("★ is filed BEFORE the draft-invoice and amount exits, which would leave it unrecorded", async () => {
    seed([
      attempt({
        state: "failed",
        failureCode: "tax_changed",
        invoiceFinalizedAt: null,
      }),
    ]);
    expect(await captured({ amountPaise: 999 })).toBe("closed_attempt");
    expect(collect.fileClosedAttemptPayment).toHaveBeenCalledTimes(1);
  });

  it("★ one closed between the read and the settle is filed too", async () => {
    collect.settleAttempt.mockResolvedValue("cancelled");
    expect(await captured()).toBe("closed_attempt");
    expect(collect.fileClosedAttemptPayment).toHaveBeenCalledWith(
      expect.objectContaining({ closedAs: "cancelled", source: "webhook" }),
    );
  });

  // The next review, same day: Razorpay does not treat a failed payment as
  // final. A renewal debit reported failed can be authorised late and
  // captured; it is filed as what it is.
  it("★★ a renewal debit recorded as failed and captured later is filed as an automatic one", async () => {
    seed([attempt({ state: "failed", failureCode: "gateway_failed" })]);
    expect(await captured()).toBe("closed_attempt");
    expect(collect.fileClosedAttemptPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        automatic: true,
        closedAs: "failed",
        closedCode: "gateway_failed",
      }),
    );
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("a FAILED payment on a closed attempt is nothing to record", async () => {
    seed([attempt({ mode: "manual", state: "cancelled" })]);
    expect(await failed()).toBe("ignored");
    expect(collect.fileClosedAttemptPayment).not.toHaveBeenCalled();
  });

  it("a replay of a recorded capture is still just a replay", async () => {
    seed([attempt({ state: "captured" })]);
    collect.settleAttempt.mockResolvedValue("captured");
    await captured();
    expect(collect.fileClosedAttemptPayment).not.toHaveBeenCalled();
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
