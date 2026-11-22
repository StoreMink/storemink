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
  CLOSED_CHECKOUT_PAID_KEY_PREFIX: "closed_checkout_paid:",
}));
vi.mock("./collect", () => collect);

import { earlierDebitsOf, renewalPaymentHeld } from "./earlier-debits";

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

// PR #303 fifth review, 22 Nov 2026: the store whose late-captured payment
// waits for a person must not be downgraded meanwhile. The statement itself
// runs on the real schema in scenario 27 of the hour-by-hour suite.
describe("renewalPaymentHeld", () => {
  const withRows = (rows: unknown[] | Error) => {
    const execute = vi.fn(async () => {
      if (rows instanceof Error) throw rows;
      return { rows };
    });
    dbHolder.current = { db: { execute } };
    return execute;
  };

  it("true when the query finds the unresolved payment, false when it finds none", async () => {
    withRows([{ "?column?": 1 }]);
    expect(await renewalPaymentHeld("store-1", 4)).toBe(true);
    withRows([]);
    expect(await renewalPaymentHeld("store-1", 4)).toBe(false);
  });

  it("★★ NULL when it could not be read, never 'nothing held'", async () => {
    withRows(new Error("db down"));
    expect(await renewalPaymentHeld("store-1", 4)).toBeNull();
  });

  it("★ asks about the invoice of the cycle being ENTERED, still open, an unresolved closed-attempt payment, for exactly what the invoice owes", async () => {
    const execute = withRows([]);
    await renewalPaymentHeld("store-1", 4);
    const q = new PgDialect().sqlToQuery((execute.mock.calls as any)[0][0]);
    const text = q.sql.replace(/\s+/g, " ");
    expect(q.params).toEqual(
      expect.arrayContaining(["store-1", 5, "closed_checkout_paid:%"]),
    );
    expect(text).toContain("i.kind = 'subscription'");
    expect(text).toContain("i.status = 'open'");
    expect(text).toContain("r.status in ('open', 'manual_review')");
    expect(text).toContain("r.detail ->> 'repair_key' like");
    // The payment's own amount when the gateway gave it, else the closed
    // attempt's; against the invoice total less the credits applied to it.
    expect(text).toContain("coalesce(r.observed_paise, r.expected_paise) =");
    expect(text).toContain("c.kind = 'applied'");
  });
});
