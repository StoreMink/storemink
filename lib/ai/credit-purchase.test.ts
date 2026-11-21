/* eslint-disable @typescript-eslint/no-explicit-any */
// Settling a Mink credit pack from every place that can learn it was paid
// (21 Nov 2026). The rules these cases defend:
//   • no credits without a verified payment of the pack's exact amount;
//   • one grant and one notice, however many triggers race;
//   • a merchant who paid and closed the tab gets the credits without having
//     to open Plans & Billing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  makeDbMock,
  sqlText,
  sqlParamValues,
} from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
const provider = vi.hoisted(() => ({ getPlatformRazorpayCreds: vi.fn() }));
vi.mock("@/lib/payments/provider", () => provider);
const rzp = vi.hoisted(() => ({
  capturedPayment: vi.fn(),
  rzpFetchOrderPayments: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => rzp);
const invoice = vi.hoisted(() => ({ issueCreditInvoice: vi.fn() }));
vi.mock("@/lib/billing/credit-invoice", () => invoice);
const notif = vi.hoisted(() => ({ recordEvent: vi.fn() }));
vi.mock("@/lib/notifications/record", () => notif);

import {
  CREDIT_RECONCILE_AFTER_MS,
  CREDIT_RECONCILE_WINDOW_MS,
  creditPurchasePaise,
  reconcilePendingCreditPurchases,
  settleCreditPurchase,
  settleCreditPurchaseByOrder,
} from "./credit-purchase";
import { logError } from "@/lib/observability/logger";

const STORE = "a0000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-21T12:00:00.000Z");
const PURCHASE = {
  id: "pur-1",
  store_id: STORE,
  credits: 25,
  pack_id: "small",
};
/** A pending purchase as the reconcile and webhook reads return it. */
const PENDING = {
  ...PURCHASE,
  rzp_order_id: "order_1",
  amount_inr: 59,
  amount_paise: 6_962,
};
const CAPTURED = {
  id: "pay_1",
  order_id: "order_1",
  amount: 6_962,
  currency: "INR",
  status: "captured",
  created_at: 1_790_000_000,
};

/** `claimed`: what the pending → paid claim returns (a row, or none). */
function db(opts: { rows?: any[][]; claimed?: any[] } = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: opts.rows ?? [],
    returning: opts.claimed ?? [{ id: "pur-1" }],
    executeQueue: [[{ add_ai_credits: true }]],
  });
}
const creditGrants = () =>
  dbHolder.current.calls.execute.filter((q: unknown) =>
    sqlText(q).includes("add_ai_credits"),
  );

beforeEach(() => {
  vi.clearAllMocks();
  provider.getPlatformRazorpayCreds.mockReturnValue({
    keyId: "rzp_live_platform",
    keySecret: "s",
  });
  rzp.rzpFetchOrderPayments.mockResolvedValue({ ok: true, data: [CAPTURED] });
  rzp.capturedPayment.mockImplementation(
    (payments: any[]) => payments.find((p) => p.status === "captured") ?? null,
  );
  notif.recordEvent.mockResolvedValue(null);
  db();
});

describe("creditPurchasePaise", () => {
  it("is what the order was created for: amount_paise, or the list price before that column existed", () => {
    expect(creditPurchasePaise({ amount_inr: 59, amount_paise: 6_962 })).toBe(
      6_962,
    );
    expect(creditPurchasePaise({ amount_inr: 59, amount_paise: null })).toBe(
      5_900,
    );
  });
});

describe("settleCreditPurchase: one grant, whoever arrives", () => {
  it("★★ the settle that claims the purchase grants the credits, by the payment's id, and issues the receipt", async () => {
    const paidAt = new Date("2026-11-21T11:00:00.000Z");
    expect(await settleCreditPurchase(PURCHASE, "pay_1", paidAt)).toBe(true);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      status: "paid",
      rzpPaymentId: "pay_1",
    });
    expect(creditGrants()).toHaveLength(1);
    expect(sqlParamValues(creditGrants()[0])).toEqual(
      expect.arrayContaining([STORE, 25, "purchase", "pay_1"]),
    );
    expect(invoice.issueCreditInvoice).toHaveBeenCalledWith(
      "pur-1",
      undefined,
      paidAt,
    );
  });

  it("★★ a settle that LOST the claim grants nothing, and only re-issues the receipt", async () => {
    db({ claimed: [] });
    expect(await settleCreditPurchase(PURCHASE, "pay_1")).toBe(false);
    expect(creditGrants()).toHaveLength(0);
    expect(invoice.issueCreditInvoice).toHaveBeenCalledTimes(1);
  });

  it("never throws: a failed claim grants nothing", async () => {
    dbHolder.current = makeDbMock({
      failUpdateFor: [(await import("@/drizzle/schema")).aiCreditPurchases],
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await settleCreditPurchase(PURCHASE, "pay_1")).toBe(false);
    expect(creditGrants()).toHaveLength(0);
    spy.mockRestore();
  });
});

describe("settleCreditPurchaseByOrder: StoreMink's own Razorpay webhook", () => {
  const deliver = (over: Record<string, unknown> = {}) =>
    settleCreditPurchaseByOrder({
      providerOrderId: "order_1",
      providerPaymentId: "pay_1",
      amountPaise: 6_962,
      currency: "INR",
      paidAtSeconds: 1_790_000_000,
      ...over,
    });
  const pending = (over: Record<string, unknown> = {}) =>
    db({ rows: [[{ ...PENDING, status: "pending", ...over }]] });

  it("★★ a merchant who paid and closed the tab gets the credits at once, and is told", async () => {
    pending();
    expect(await deliver()).toBe("settled");
    expect(creditGrants()).toHaveLength(1);
    // The receipt carries the payment's own time.
    expect(invoice.issueCreditInvoice).toHaveBeenCalledWith(
      "pur-1",
      undefined,
      new Date(1_790_000_000 * 1000),
    );
    expect(notif.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ai.credits_purchased",
        storeId: STORE,
        actor: { type: "system" },
        payload: { credits: 25 },
      }),
    );
  });

  it("finds the purchase by the Razorpay order the payment was made on", async () => {
    pending();
    await deliver();
    const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[0]);
    expect(where.sql).toContain('"rzp_order_id" = $1');
    expect(where.params).toEqual(["order_1"]);
  });

  it("★★ a different amount or currency grants NOTHING, and says so loudly", async () => {
    pending();
    expect(await deliver({ amountPaise: 100 })).toBe("mismatch");
    pending();
    expect(await deliver({ currency: "USD" })).toBe("mismatch");
    expect(creditGrants()).toHaveLength(0);
    expect(notif.recordEvent).not.toHaveBeenCalled();
    expect(vi.mocked(logError).mock.calls[0][0]).toBe(
      "billing.credit_pack_amount_mismatch",
    );
  });

  it("a purchase made before amount_paise existed is checked against its list price", async () => {
    pending({ amount_paise: null });
    expect(await deliver({ amountPaise: 5_900 })).toBe("settled");
  });

  it("★★ a purchase the browser already confirmed is left alone: no second grant, no second notice", async () => {
    pending({ status: "paid" });
    expect(await deliver()).toBe("already");
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(creditGrants()).toHaveLength(0);
    expect(notif.recordEvent).not.toHaveBeenCalled();
  });

  it("★ a delivery that lost the claim to the browser's confirm announces nothing", async () => {
    db({ rows: [[{ ...PENDING, status: "pending" }]], claimed: [] });
    expect(await deliver()).toBe("already");
    expect(creditGrants()).toHaveLength(0);
    expect(notif.recordEvent).not.toHaveBeenCalled();
  });

  it("an order that is not a credit pack's is unmatched", async () => {
    db({ rows: [[]] });
    expect(await deliver()).toBe("unmatched");
    expect(await deliver({ providerOrderId: "" })).toBe("unmatched");
  });

  it("★★ never throws: a failed read is an error the scheduled pass makes good", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
    expect(await deliver()).toBe("error");
  });

  it("a notice that could not be recorded does not undo the grant", async () => {
    pending();
    notif.recordEvent.mockRejectedValue(new Error("queue down"));
    expect(await deliver()).toBe("settled");
    expect(creditGrants()).toHaveLength(1);
  });
});

describe("reconcilePendingCreditPurchases", () => {
  it("★★ the SCHEDULED pass settles a paid purchase for a merchant who never came back, and tells them", async () => {
    db({ rows: [[PENDING]] });
    expect(await reconcilePendingCreditPurchases({ now: NOW })).toEqual({
      considered: 1,
      settled: 1,
      errors: 0,
    });
    expect(creditGrants()).toHaveLength(1);
    expect(notif.recordEvent).toHaveBeenCalledTimes(1);
  });

  it("★ the scheduled pass looks at every store, between three minutes and three days old", async () => {
    db({ rows: [[]] });
    await reconcilePendingCreditPurchases({ now: NOW });
    const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[0]);
    expect(where.sql).not.toContain('"store_id" =');
    expect(where.params).toContain("pending");
    expect(where.params).toContain(
      new Date(NOW.getTime() - CREDIT_RECONCILE_AFTER_MS).toISOString(),
    );
    // Without this bound every abandoned purchase would cost a gateway call
    // an hour for ever.
    expect(where.params).toContain(
      new Date(NOW.getTime() - CREDIT_RECONCILE_WINDOW_MS).toISOString(),
    );
    expect(dbHolder.current.calls.limit[0]).toBe(100);
  });

  it("the page pass is this store's unfinished purchases of any age, ten at most", async () => {
    db({ rows: [[]] });
    await reconcilePendingCreditPurchases({ storeId: STORE, now: NOW });
    const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[0]);
    expect(where.sql).toContain('"store_id" =');
    expect(where.params).toContain(STORE);
    expect(where.params).not.toContain(
      new Date(NOW.getTime() - CREDIT_RECONCILE_WINDOW_MS).toISOString(),
    );
    expect(dbHolder.current.calls.limit[0]).toBe(10);
  });

  it("★ nothing captured, or Razorpay unreachable, leaves the purchase pending", async () => {
    db({ rows: [[PENDING]] });
    rzp.rzpFetchOrderPayments.mockResolvedValue({ ok: true, data: [] });
    expect((await reconcilePendingCreditPurchases({ now: NOW })).settled).toBe(
      0,
    );

    db({ rows: [[PENDING]] });
    rzp.rzpFetchOrderPayments.mockResolvedValue({ ok: false, error: "down" });
    expect(await reconcilePendingCreditPurchases({ now: NOW })).toEqual({
      considered: 1,
      settled: 0,
      errors: 0,
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★★ a captured payment of a different amount is never granted", async () => {
    db({ rows: [[PENDING]] });
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [{ ...CAPTURED, amount: 100 }],
    });
    expect((await reconcilePendingCreditPurchases({ now: NOW })).settled).toBe(
      0,
    );
    expect(creditGrants()).toHaveLength(0);
  });

  it("a purchase with no gateway order is not asked about", async () => {
    db({ rows: [[{ ...PENDING, rzp_order_id: null }]] });
    expect(await reconcilePendingCreditPurchases({ now: NOW })).toEqual({
      considered: 0,
      settled: 0,
      errors: 0,
    });
    expect(rzp.rzpFetchOrderPayments).not.toHaveBeenCalled();
  });

  it("does nothing without the platform's Razorpay account; a failed read is one error", async () => {
    provider.getPlatformRazorpayCreds.mockReturnValue(null);
    expect(await reconcilePendingCreditPurchases({ now: NOW })).toEqual({
      considered: 0,
      settled: 0,
      errors: 0,
    });

    provider.getPlatformRazorpayCreds.mockReturnValue({
      keyId: "k",
      keySecret: "s",
    });
    dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
    expect((await reconcilePendingCreditPurchases({ now: NOW })).errors).toBe(
      1,
    );
  });
});
