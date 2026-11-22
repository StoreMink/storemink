/* eslint-disable @typescript-eslint/no-explicit-any */
// Did an earlier automatic debit of this invoice take the money after all?
// (PR #303 review, 22 Nov 2026.) Razorpay does not treat a failed payment as
// final: a renewal debit reported failed can be authorised late by the bank
// and captured. The next automatic try then debited the same renewal again.
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
vi.mock("@/lib/payments/provider", () => ({
  getPlatformRazorpayCreds: vi.fn(() => ({ keyId: "rzp_1", keySecret: "s" })),
}));
const collect = vi.hoisted(() => ({
  fileClosedAttemptPayment: vi.fn(async () => true),
}));
vi.mock("./collect", () => collect);

import { earlierDebitsOf } from "./earlier-debits";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const CREDS = { keyId: "rzp_1", keySecret: "s" };
const attempt = (over: Record<string, unknown> = {}) => ({
  id: "att-1",
  providerOrderId: "order_1",
  amountPaise: 240_000,
  state: "failed",
  failureCode: "gateway_failed",
  ...over,
});
const seed = (rows: any[] | Error) =>
  (dbHolder.current = makeDbMock({ selectQueue: [rows] }));
const gateway = (byOrder: Record<string, any[] | "down">) =>
  vi.fn(async (_creds: unknown, orderId: string) => {
    const payments = byOrder[orderId];
    return payments === "down" || payments === undefined
      ? { ok: false as const, error: "timeout", outcome: "unknown" as const }
      : { ok: true as const, data: payments };
  });
const ask = (fetchOrderPayments: any, over: Record<string, unknown> = {}) =>
  earlierDebitsOf(
    {
      invoiceId: "inv-1",
      storeId: "store-1",
      source: "collect",
      now: NOW,
      ...over,
    } as any,
    { fetchOrderPayments, creds: CREDS },
  );

beforeEach(() => {
  vi.clearAllMocks();
  seed([]);
});

describe("earlierDebitsOf", () => {
  it("★ no earlier debit was sent: clear, and the gateway is never asked", async () => {
    const fetch = gateway({});
    expect(await ask(fetch)).toBe("clear");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("every payment on the earlier debit reads failed: clear", async () => {
    seed([attempt()]);
    const fetch = gateway({ order_1: [{ id: "pay_1", status: "failed" }] });
    expect(await ask(fetch)).toBe("clear");
    expect(fetch).toHaveBeenCalledWith(CREDS, "order_1");
    expect(collect.fileClosedAttemptPayment).not.toHaveBeenCalled();
  });

  it("★★ the earlier debit was CAPTURED after it was recorded as failed: paid, and filed for a person", async () => {
    seed([attempt()]);
    const fetch = gateway({
      order_1: [
        { id: "pay_0", status: "failed" },
        { id: "pay_1", status: "captured", amount: 240_000 },
      ],
    });
    expect(await ask(fetch)).toBe("paid");
    expect(collect.fileClosedAttemptPayment).toHaveBeenCalledWith({
      storeId: "store-1",
      invoiceId: "inv-1",
      attemptId: "att-1",
      providerPaymentId: "pay_1",
      providerOrderId: "order_1",
      expectedPaise: 240_000,
      observedPaise: 240_000,
      closedAs: "failed",
      closedCode: "gateway_failed",
      automatic: true,
      source: "collect",
      now: NOW,
    });
  });

  it("★★ a payment that is neither failed nor captured (authorised late) is UNSETTLED, never clear", async () => {
    seed([attempt()]);
    expect(
      await ask(gateway({ order_1: [{ id: "pay_1", status: "authorized" }] })),
    ).toBe("unsettled");
    seed([attempt()]);
    expect(
      await ask(gateway({ order_1: [{ id: "pay_1", status: "created" }] })),
    ).toBe("unsettled");
    expect(collect.fileClosedAttemptPayment).not.toHaveBeenCalled();
  });

  it("★★ FAILS CLOSED: a gateway or a record that cannot be read is UNKNOWN, never clear", async () => {
    seed([attempt()]);
    expect(await ask(gateway({ order_1: "down" }))).toBe("unknown");
    seed(new Error("db down"));
    expect(await ask(gateway({}))).toBe("unknown");
    // No gateway credentials: nothing can be asked, so nothing is.
    seed([attempt()]);
    const unasked = gateway({ order_1: [{ id: "pay_1", status: "failed" }] });
    expect(
      await earlierDebitsOf(
        { invoiceId: "inv-1", storeId: "store-1", source: "debit", now: NOW },
        { fetchOrderPayments: unasked as any, creds: null },
      ),
    ).toBe("unknown");
    expect(unasked).not.toHaveBeenCalled();
  });

  it("with several earlier debits the worst answer stands: paid over unsettled over unknown", async () => {
    const three = [
      attempt({ id: "a", providerOrderId: "order_a" }),
      attempt({ id: "b", providerOrderId: "order_b" }),
      attempt({ id: "c", providerOrderId: "order_c" }),
    ];
    seed(three);
    expect(
      await ask(
        gateway({
          order_a: "down",
          order_b: [{ id: "p", status: "authorized" }],
          order_c: [{ id: "q", status: "captured", amount: 240_000 }],
        }),
      ),
    ).toBe("paid");
    seed(three);
    expect(
      await ask(
        gateway({
          order_a: "down",
          order_b: [{ id: "p", status: "authorized" }],
          order_c: [{ id: "q", status: "failed" }],
        }),
      ),
    ).toBe("unsettled");
  });

  it("★ reads only this invoice's CLOSED automatic attempts whose debit was SENT, never the attempt about to be debited", async () => {
    await ask(gateway({}), { exceptAttemptId: "att-now" });
    const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[0]);
    expect(where.params).toEqual(
      expect.arrayContaining([
        "inv-1",
        "automatic",
        "failed",
        "cancelled",
        "att-now",
      ]),
    );
    expect(where.sql).toContain('"provider_order_id" is not null');
    expect(where.sql).toMatch(
      /"debit_sent_at" is not null or [^)]*"provider_payment_id" is not null/,
    );
    expect(where.sql).toContain('"id" <>');
  });
});
