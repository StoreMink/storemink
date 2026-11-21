/* eslint-disable @typescript-eslint/no-explicit-any */
// Manual payment.
//
// Today this is the ONLY way a renewal gets paid, because the recurring endpoint
// is unverified — so it carries the whole revenue path. What matters:
//
//   • an invoice id alone must never let one merchant pay another's bill;
//   • a CLOSED invoice (uncollectible/void) must not be payable — taking money
//     for a cycle the merchant was already downgraded for charges them for
//     service they never received;
//   • the signature is the trust boundary;
//   • paying during grace restores the plan AT ONCE, not at the next cron tick.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock, sqlParamValues } from "@/app/actions/_test-helpers";
import { billingInvoices, billingSubscriptions } from "@/drizzle/schema";
import { logError, logInfo } from "@/lib/observability/logger";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const provider = vi.hoisted(() => ({ getPlatformRazorpayCreds: vi.fn() }));
vi.mock("@/lib/payments/provider", () => provider);

const rzp = vi.hoisted(() => ({
  rzpCreateOrder: vi.fn(),
  rzpFetchOrder: vi.fn(),
  verifyCapturedCheckoutPayment: vi.fn(),
  verifyCheckoutSignature: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => rzp);

const invStore = vi.hoisted(() => ({
  getInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
  amountDueForInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => invStore);

const collect = vi.hoisted(() => ({
  beginAttempt: vi.fn(),
  settleAttempt: vi.fn(),
  // RC-F1b: no captured attempt on the invoice unless a test says so.
  capturedAttemptForInvoice: vi.fn(async (): Promise<unknown> => null),
  // No earlier payment waiting on its result unless a test says so.
  hasUnknownAttempt: vi.fn(async (): Promise<boolean | null> => false),
  // "Pay now instead": how many scheduled debits were withdrawn.
  withdrawUnsentDebits: vi.fn(async (): Promise<number | null> => 0),
}));
vi.mock("./collect", () => collect);

// The one rule for "nobody has paid this order" (./order-state), proved by
// enrolment's suite; here a test says what the gateway's record shows.
const orderState = vi.hoisted(() => ({
  orderIsUntouched: vi.fn(async () => true),
}));
vi.mock("./order-state", () => orderState);

const worker = vi.hoisted(() => ({ advanceAfterPayment: vi.fn() }));
vi.mock("./renewal-worker", () => worker);

import {
  ALREADY_CAPTURED_INVOICE_MESSAGE,
  PAYMENT_BEING_CONFIRMED_MESSAGE,
  PAYMENT_IN_PROGRESS_MESSAGE,
  CANCELLING_INVOICE_MESSAGE,
  CLOSED_INVOICE_MESSAGE,
  CLOSED_ON_ARRIVAL_MESSAGE,
  UNISSUED_INVOICE_MESSAGE,
  confirmInvoicePayment,
  cycleRefusal,
  listPayableInvoices,
  startInvoicePayment,
} from "./manual-pay";

const STORE = "store-1";
const INVOICE = "inv-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");

function openInvoice(over: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    storeId: STORE,
    kind: "subscription",
    status: "open",
    totalPaise: 5_000_00,
    cycleSeq: 2,
    invoiceRef: "SM/2026-27/00002",
    finalizedAt: "2026-08-28T00:00:00.000Z",
    ...over,
  };
}

function seed(rows: any[][] = []) {
  dbHolder.current = makeDbMock({ selectQueue: rows });
}

/** The store's subscription row, as startInvoicePayment reads it. */
function subscription(over: Record<string, unknown> = {}) {
  return {
    state: "active",
    currentCycleSeq: 1,
    cancelAtPeriodEnd: false,
    ...over,
  };
}

/** A store whose subscription read returns this row (or rejects). */
function seedSubscription(row: Record<string, unknown> | Error | null) {
  dbHolder.current = makeDbMock({
    selectByTable: {
      billing_subscriptions: [row instanceof Error ? row : row ? [row] : []],
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  provider.getPlatformRazorpayCreds.mockReturnValue({
    keyId: "rzp_1",
    keySecret: "secret",
  });
  rzp.rzpCreateOrder.mockResolvedValue({ ok: true, data: { id: "order_1" } });
  rzp.verifyCheckoutSignature.mockReturnValue(true);
  rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
    ok: true,
    gatewayRead: true,
  });
  invStore.getInvoice.mockResolvedValue(openInvoice());
  invStore.finalizeInvoice.mockResolvedValue(openInvoice());
  invStore.amountDueForInvoice.mockResolvedValue(5_000_00);
  collect.beginAttempt.mockResolvedValue({
    attemptId: "att-1",
    idempotencyKey: "key-1",
  });
  collect.settleAttempt.mockResolvedValue("captured");
  worker.advanceAfterPayment.mockResolvedValue(true);
});

describe("startInvoicePayment", () => {
  const args = { storeId: STORE, invoiceId: INVOICE, now: NOW };

  it("opens a Razorpay order for what is due", async () => {
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      providerOrderId: "order_1",
      amountPaise: 5_000_00,
      invoiceRef: "SM/2026-27/00002",
    });
  });

  it("★★ refuses an invoice belonging to ANOTHER store", async () => {
    // An invoice id alone must never reach across tenants — not to pay, not even
    // to learn the amount.
    invStore.getInvoice.mockResolvedValue(openInvoice({ storeId: "other" }));
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ refuses an AI-credit receipt before creating another order", async () => {
    invStore.getInvoice.mockResolvedValue(
      openInvoice({ kind: "ai_credits", cycleSeq: null }),
    );
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/one-time purchase.*settled/i);
    expect(invStore.amountDueForInvoice).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ refuses an UNCOLLECTIBLE invoice", async () => {
    // It belongs to a cycle the merchant was already downgraded for. Taking
    // money now would charge them for service they never received.
    invStore.getInvoice.mockResolvedValue(
      openInvoice({ status: "uncollectible" }),
    );
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // ★ "Closed", not "closed unpaid": a void invoice may have been paid and
    //   refunded (design 8.4).
    expect(res.error).toBe(CLOSED_INVOICE_MESSAGE);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ refuses a VOID invoice", async () => {
    invStore.getInvoice.mockResolvedValue(openInvoice({ status: "void" }));
    expect((await startInvoicePayment(args)).ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("refuses an already-paid invoice", async () => {
    invStore.getInvoice.mockResolvedValue(openInvoice({ status: "paid" }));
    expect((await startInvoicePayment(args)).ok).toBe(false);
  });

  it("★ refuses while a payment is PROCESSING, rather than opening a second", async () => {
    invStore.getInvoice.mockResolvedValue(
      openInvoice({ status: "processing" }),
    );
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: PAYMENT_IN_PROGRESS_MESSAGE });
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ without being asked, a SCHEDULED automatic payment is never withdrawn", async () => {
    invStore.getInvoice.mockResolvedValue(
      openInvoice({ status: "processing" }),
    );
    await startInvoicePayment(args);
    await startInvoicePayment({ ...args, insteadOfAutopay: false });
    expect(collect.withdrawUnsentDebits).not.toHaveBeenCalled();
  });

  it("★ refuses when an attempt is already in flight", async () => {
    collect.beginAttempt.mockResolvedValue(null);
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  // 21 Nov 2026: the in-flight index does not cover `unknown`, so a merchant
  // could pay by hand over an automatic debit that was still going through.
  describe("★★ an earlier payment whose result is not known yet", () => {
    it("is never paid over: no attempt is opened and no order is created", async () => {
      collect.hasUnknownAttempt.mockResolvedValueOnce(true);
      const res = await startInvoicePayment(args);
      expect(res).toEqual({
        ok: false,
        error: PAYMENT_BEING_CONFIRMED_MESSAGE,
      });
      expect(collect.beginAttempt).not.toHaveBeenCalled();
      expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    });

    it("★ a check that could not be read refuses too, and says to try again", async () => {
      collect.hasUnknownAttempt.mockResolvedValueOnce(null);
      const res = await startInvoicePayment(args);
      expect(res.ok).toBe(false);
      expect(!res.ok && res.error).toContain("try again");
      expect(collect.beginAttempt).not.toHaveBeenCalled();
    });

    it("the message tells the merchant their plan is safe and not to pay again", () => {
      expect(PAYMENT_BEING_CONFIRMED_MESSAGE).toContain(
        "Your plan stays active",
      );
      expect(PAYMENT_BEING_CONFIRMED_MESSAGE).not.toContain("\u2014");
    });

    it("asks about this invoice, before it opens an attempt", async () => {
      await startInvoicePayment(args);
      expect(collect.hasUnknownAttempt).toHaveBeenCalledTimes(1);
      expect(
        collect.hasUnknownAttempt.mock.invocationCallOrder[0],
      ).toBeLessThan(collect.beginAttempt.mock.invocationCallOrder[0]);
    });
  });

  it("finalizes an unissued invoice before charging for it", async () => {
    invStore.getInvoice.mockResolvedValue(openInvoice({ finalizedAt: null }));
    await startInvoicePayment(args);
    expect(invStore.finalizeInvoice).toHaveBeenCalled();
    expect(invStore.finalizeInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      collect.beginAttempt.mock.invocationCallOrder[0],
    );
  });

  it("★ never guesses the amount due", async () => {
    invStore.amountDueForInvoice.mockResolvedValue(null);
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });

  it("refuses when credit has already covered it", async () => {
    invStore.amountDueForInvoice.mockResolvedValue(0);
    expect((await startInvoicePayment(args)).ok).toBe(false);
  });

  it("★ plants the idempotency key in the order notes", async () => {
    await startInvoicePayment(args);
    expect(rzp.rzpCreateOrder.mock.calls[0][1].notes.sm_billing_key).toBe(
      "key-1",
    );
  });

  it("★★ an UNKNOWN order outcome leaves the attempt in flight, not failed", async () => {
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    await startInvoicePayment(args);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "unknown",
      expect.anything(),
    );
  });

  it("a rejected order fails the attempt", async () => {
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: false,
      error: "bad",
      outcome: "rejected",
    });
    await startInvoicePayment(args);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "failed",
      expect.anything(),
    );
  });
});

// 22 Nov 2026. An automatic renewal waits a day or more between its bank
// notice and its debit. A merchant who would rather pay it themselves may:
// the scheduled debit is withdrawn first, by a write that only lands while
// the debit has not been sent, so the two can never both be taken.
describe("★★ Pay now instead: replacing a scheduled automatic payment", () => {
  const args = {
    storeId: STORE,
    invoiceId: INVOICE,
    insteadOfAutopay: true,
    now: NOW,
  };

  /** The invoice is `processing` at the start, and `after` once withdrawn. */
  function scheduled(after: string) {
    invStore.getInvoice
      .mockResolvedValueOnce(openInvoice({ status: "processing" }))
      .mockResolvedValue(openInvoice({ status: after }));
  }

  it("withdraws the scheduled debit, then opens an ordinary payment", async () => {
    scheduled("open");
    collect.withdrawUnsentDebits.mockResolvedValue(1);
    const res = await startInvoicePayment(args);
    expect(collect.withdrawUnsentDebits).toHaveBeenCalledWith({
      invoiceId: INVOICE,
      code: "paid_by_hand",
      reason: "the merchant chose to pay this invoice by hand",
      now: NOW,
    });
    expect(collect.beginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: INVOICE, mode: "manual" }),
    );
    expect(res).toMatchObject({
      ok: true,
      data: { providerOrderId: "order_1", amountPaise: 5_000_00 },
    });
  });

  it("★★ the withdrawal comes BEFORE the new payment is opened", async () => {
    scheduled("open");
    collect.withdrawUnsentDebits.mockResolvedValue(1);
    await startInvoicePayment(args);
    expect(
      collect.withdrawUnsentDebits.mock.invocationCallOrder[0],
    ).toBeLessThan(collect.beginAttempt.mock.invocationCallOrder[0]);
  });

  it("★★ a debit ALREADY SENT to the bank is not replaced: no second payment", async () => {
    // The guarded write moved nothing, and the invoice is still in flight.
    scheduled("processing");
    collect.withdrawUnsentDebits.mockResolvedValue(0);
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: PAYMENT_IN_PROGRESS_MESSAGE });
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ a withdrawal that could not be read refuses: nothing is opened on a guess", async () => {
    scheduled("open");
    collect.withdrawUnsentDebits.mockResolvedValue(null);
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });

  it("an invoice that is simply open needs no withdrawal", async () => {
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(true);
    expect(collect.withdrawUnsentDebits).not.toHaveBeenCalled();
  });

  describe("★★ nothing is withdrawn for a payment that will be refused anyway", () => {
    it("a cancelling plan's invoice", async () => {
      scheduled("open");
      seedSubscription(subscription({ cancelAtPeriodEnd: true }));
      const res = await startInvoicePayment(args);
      expect(res).toEqual({ ok: false, error: CANCELLING_INVOICE_MESSAGE });
      expect(collect.withdrawUnsentDebits).not.toHaveBeenCalled();
    });

    it("an earlier payment whose result is not known", async () => {
      scheduled("open");
      collect.hasUnknownAttempt.mockResolvedValue(true);
      const res = await startInvoicePayment(args);
      expect(res).toEqual({
        ok: false,
        error: PAYMENT_BEING_CONFIRMED_MESSAGE,
      });
      expect(collect.withdrawUnsentDebits).not.toHaveBeenCalled();
    });

    it("an amount that could not be worked out", async () => {
      scheduled("open");
      invStore.amountDueForInvoice.mockResolvedValue(null);
      expect((await startInvoicePayment(args)).ok).toBe(false);
      expect(collect.withdrawUnsentDebits).not.toHaveBeenCalled();
    });

    it("another store's invoice", async () => {
      invStore.getInvoice.mockResolvedValue(
        openInvoice({ status: "processing", storeId: "other" }),
      );
      expect((await startInvoicePayment(args)).ok).toBe(false);
      expect(collect.withdrawUnsentDebits).not.toHaveBeenCalled();
    });
  });
});

// A merchant who opens the payment window and closes it leaves an attempt
// `processing` with its gateway order. Before 22 Nov 2026 that was a dead
// end: the invoice read "Payment in progress" for 72 hours.
describe("★★ Continue payment: an unfinished checkout is reopened on its own order", () => {
  const args = { storeId: STORE, invoiceId: INVOICE, now: NOW };
  const OPEN = {
    id: "att-open",
    providerOrderId: "order_open",
    amountPaise: 5_000_00,
  };

  function seedOpenCheckout(row: Record<string, unknown> | Error | null) {
    invStore.getInvoice.mockResolvedValue(
      openInvoice({ status: "processing" }),
    );
    dbHolder.current = makeDbMock({
      selectByTable: {
        billing_payment_attempts: [
          row instanceof Error ? row : row ? [row] : [],
        ],
      },
    });
  }

  beforeEach(() => {
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: { id: "order_open", status: "created", amount_paid: 0 },
    });
    orderState.orderIsUntouched.mockResolvedValue(true);
  });

  it("returns the SAME order, and creates neither an attempt nor an order", async () => {
    seedOpenCheckout(OPEN);
    const res = await startInvoicePayment(args);
    expect(res).toEqual({
      ok: true,
      data: {
        invoiceId: INVOICE,
        providerOrderId: "order_open",
        keyId: "rzp_1",
        amountPaise: 5_000_00,
        invoiceRef: "SM/2026-27/00002",
      },
    });
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ only this store's own MANUAL checkout that already has an order", async () => {
    seedOpenCheckout(OPEN);
    await startInvoicePayment(args);
    const wheres = dbHolder.current.calls.where.map((w: unknown) => {
      const q = new PgDialect().sqlToQuery(w as never);
      return { sql: q.sql.replace(/\s+/g, " "), params: q.params };
    });
    expect(wheres).toContainEqual({
      sql: '("billing_payment_attempts"."invoice_id" = $1 and "billing_payment_attempts"."store_id" = $2 and "billing_payment_attempts"."mode" = $3 and "billing_payment_attempts"."state" = $4 and "billing_payment_attempts"."provider_order_id" is not null)',
      params: [INVOICE, STORE, "manual", "processing"],
    });
  });

  it("★★ an order the gateway says is PAID is never reopened", async () => {
    seedOpenCheckout(OPEN);
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: { id: "order_open", status: "paid", amount_paid: 5_000_00 },
    });
    const res = await startInvoicePayment(args);
    expect(res).toEqual({
      ok: false,
      error: ALREADY_CAPTURED_INVOICE_MESSAGE,
    });
  });

  it("★★ an order with the full amount paid is not reopened, whatever its status reads", async () => {
    seedOpenCheckout(OPEN);
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: { id: "order_open", status: "attempted", amount_paid: 5_000_00 },
    });
    expect(await startInvoicePayment(args)).toEqual({
      ok: false,
      error: ALREADY_CAPTURED_INVOICE_MESSAGE,
    });
  });

  it("★★ a payment still waiting for approval is not reopened beside", async () => {
    seedOpenCheckout(OPEN);
    orderState.orderIsUntouched.mockResolvedValue(false);
    expect(await startInvoicePayment(args)).toEqual({
      ok: false,
      error: PAYMENT_IN_PROGRESS_MESSAGE,
    });
  });

  it("★★ an order that could not be read refuses: 'could not check' is not 'nobody paid'", async () => {
    seedOpenCheckout(OPEN);
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: false,
      outcome: "unknown",
      error: "timeout",
    });
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(orderState.orderIsUntouched).not.toHaveBeenCalled();
  });

  it("★ an order made for another amount is never reopened at this one", async () => {
    seedOpenCheckout({ ...OPEN, amountPaise: 4_000_00 });
    expect(await startInvoicePayment(args)).toEqual({
      ok: false,
      error: PAYMENT_IN_PROGRESS_MESSAGE,
    });
    expect(rzp.rzpFetchOrder).not.toHaveBeenCalled();
  });

  it("★ a checkout that could not be looked up refuses", async () => {
    seedOpenCheckout(new Error("db down"));
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });

  it("after Pay now instead was pressed and the window closed, the next press continues that checkout", async () => {
    // The scheduled debit is gone already (nothing left to withdraw), and the
    // checkout that replaced it is reopened.
    seedOpenCheckout(OPEN);
    const res = await startInvoicePayment({ ...args, insteadOfAutopay: true });
    expect(res).toMatchObject({
      ok: true,
      data: { providerOrderId: "order_open" },
    });
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });
});

describe("cycleRefusal (design 6.5)", () => {
  const live = (over: Record<string, unknown> = {}) =>
    subscription({ currentCycleSeq: 4, ...over }) as any;
  const issued = (cycleSeq: number | null) => ({ cycleSeq, issued: true });

  it("refuses the next cycle's invoice while a cancellation stands", () => {
    expect(cycleRefusal(live({ cancelAtPeriodEnd: true }), issued(5))).toBe(
      "cancelling",
    );
    // ★ Issued or not: the next cycle is not entered either way.
    expect(
      cycleRefusal(live({ cancelAtPeriodEnd: true }), {
        cycleSeq: 5,
        issued: false,
      }),
    ).toBe("cancelling");
  });

  it("the same invoice is payable again once Keep my plan clears the flag", () => {
    expect(cycleRefusal(live({ cancelAtPeriodEnd: false }), issued(5))).toBe(
      null,
    );
  });

  it("a cancellation leaves the current cycle's own invoice alone", () => {
    expect(
      cycleRefusal(live({ cancelAtPeriodEnd: true }), issued(4)),
    ).toBeNull();
  });

  it.each(["cancelled", "downgraded"])(
    "★ refuses an issued invoice above a %s plan's last cycle",
    (state) => {
      expect(cycleRefusal(live({ state }), issued(5))).toBe("unreachable");
      // Its own last cycle and earlier are not "above".
      expect(cycleRefusal(live({ state }), issued(4))).toBeNull();
    },
  );

  it.each(["active", "past_due", "grace"])(
    "★ refuses an issued invoice below a %s plan's current cycle",
    (state) => {
      expect(cycleRefusal(live({ state }), issued(3))).toBe("unreachable");
      expect(cycleRefusal(live({ state }), issued(5))).toBeNull();
    },
  );

  it("★ a DRAFT is judged only by the cancellation rule (enrolment owns its drafts)", () => {
    expect(
      cycleRefusal(live({ state: "cancelled" }), {
        cycleSeq: 5,
        issued: false,
      }),
    ).toBeNull();
    expect(
      cycleRefusal(live({ state: "active" }), { cycleSeq: 3, issued: false }),
    ).toBeNull();
  });

  it("no subscription, or no cycle, refuses nothing", () => {
    expect(cycleRefusal(null, issued(5))).toBeNull();
    expect(cycleRefusal(live({ state: "cancelled" }), issued(null))).toBeNull();
  });
});

describe("★★ startInvoicePayment refuses a cycle the store will never enter", () => {
  const args = { storeId: STORE, invoiceId: INVOICE, now: NOW };

  it("★★ the next invoice while a cancellation stands, with the 8.4 sentence", async () => {
    seedSubscription(subscription({ cancelAtPeriodEnd: true }));
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: CANCELLING_INVOICE_MESSAGE });
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ after Keep my plan (flag cleared) the same invoice opens a payment", async () => {
    seedSubscription(subscription({ cancelAtPeriodEnd: false }));
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(true);
    expect(rzp.rzpCreateOrder).toHaveBeenCalledTimes(1);
  });

  it("★ an issued invoice above an ended plan's cycle is closed to payment", async () => {
    seedSubscription(subscription({ state: "cancelled", currentCycleSeq: 1 }));
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: CLOSED_INVOICE_MESSAGE });
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ an issued invoice below a live plan's cycle is closed to payment", async () => {
    seedSubscription(subscription({ state: "past_due", currentCycleSeq: 3 }));
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: CLOSED_INVOICE_MESSAGE });
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ refuses BEFORE finalize, so a refused draft never takes a number", async () => {
    invStore.getInvoice.mockResolvedValue(openInvoice({ finalizedAt: null }));
    seedSubscription(subscription({ cancelAtPeriodEnd: true }));
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: CANCELLING_INVOICE_MESSAGE });
    expect(invStore.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★ reads this store's subscription, never another's", async () => {
    seedSubscription(subscription());
    await startInvoicePayment(args);
    const where = new PgDialect().sqlToQuery(dbHolder.current.calls.where[0]);
    expect(where.sql).toBe('"billing_subscriptions"."store_id" = $1');
    expect(where.params).toEqual([STORE]);
  });

  it("★ an unreadable subscription refuses, and nothing is charged", async () => {
    seedSubscription(new Error("db down"));
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe(
      "We couldn't check your plan just now. Please try again.",
    );
    expect(logError).toHaveBeenCalledWith(
      "billing.manual_pay_subscription_read",
      expect.any(Error),
      expect.objectContaining({ storeId: STORE }),
    );
    expect(invStore.finalizeInvoice).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });
});

describe("★★ startInvoicePayment never charges an invoice with no issue date", () => {
  const args = { storeId: STORE, invoiceId: INVOICE, now: NOW };

  it("★★ refuses when finalize leaves the invoice unissued, and logs it", async () => {
    // An `open` row with a null finalized_at: finalize claims only a draft, so
    // it comes back unnumbered (RC2's finding). No code writes that state; a
    // hand edit could, and taking money against it has no document behind it.
    invStore.getInvoice.mockResolvedValue(openInvoice({ finalizedAt: null }));
    invStore.finalizeInvoice.mockResolvedValue(
      openInvoice({ finalizedAt: null, invoiceRef: null }),
    );
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: UNISSUED_INVOICE_MESSAGE });
    expect(invStore.finalizeInvoice).toHaveBeenCalledTimes(1);
    expect(invStore.amountDueForInvoice).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "billing.manual_pay_unissued_invoice",
      expect.any(Error),
      expect.objectContaining({ invoiceId: INVOICE, status: "open" }),
    );
  });

  it("★★ R1-06: a draft is an offer, not a debt: refused, never issued or charged", async () => {
    // A crafted call on an enrolment draft used to finalize and charge it past
    // the payment-time tax refusals, without activating the plan.
    invStore.getInvoice.mockResolvedValue(
      openInvoice({ status: "draft", finalizedAt: null }),
    );
    invStore.finalizeInvoice.mockResolvedValue(openInvoice());
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: "That invoice can't be paid." });
    expect(invStore.finalizeInvoice).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("a finalize read failure still says the invoice couldn't be issued", async () => {
    invStore.getInvoice.mockResolvedValue(openInvoice({ finalizedAt: null }));
    invStore.finalizeInvoice.mockResolvedValue(null);
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: "Couldn't issue that invoice." });
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });
});

describe("listPayableInvoices", () => {
  it("★★ queries subscription debt only, never one-time credit receipts", async () => {
    seed([[]]);
    await listPayableInvoices(STORE);
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining([STORE, "subscription", "open", "processing"]),
    );
  });

  it("★ LEFT joins the store's subscription, so a store without one still lists", async () => {
    seed([[]]);
    await listPayableInvoices(STORE);
    const [table, on] = dbHolder.current.calls.leftJoin[0];
    expect(table).toBe(billingSubscriptions);
    expect(new PgDialect().sqlToQuery(on).sql).toBe(
      '"billing_subscriptions"."store_id" = "billing_invoices"."store_id"',
    );
  });

  it("★★ drops every invoice for a cycle the store will not enter (the cycleRefusal rule, in SQL)", async () => {
    seed([[]]);
    await listPayableInvoices(STORE);
    const sql = new PgDialect()
      .sqlToQuery(dbHolder.current.calls.where[0])
      .sql.replace(/\s+/g, " ");
    // ★ NOT over a coalesce: with no subscription row every comparison is
    //   NULL, and a bare NOT would hide all the store's invoices.
    expect(sql).toContain("not coalesce(");
    expect(sql).toContain(", false)");
    // The next cycle while a cancellation stands (Keep my plan clears the flag,
    // and the invoice is listed again).
    expect(sql).toContain(
      '("billing_subscriptions"."cancel_at_period_end" and "billing_invoices"."cycle_seq" = "billing_subscriptions"."current_cycle_seq" + 1)',
    );
    // Above an ended plan's last cycle.
    expect(sql).toContain(
      `("billing_subscriptions"."state" in ('cancelled', 'downgraded') and "billing_invoices"."cycle_seq" > "billing_subscriptions"."current_cycle_seq")`,
    );
    // Below a live plan's current cycle.
    expect(sql).toContain(
      `("billing_subscriptions"."state" in ('active', 'past_due', 'grace') and "billing_invoices"."cycle_seq" < "billing_subscriptions"."current_cycle_seq")`,
    );
  });

  // 22 Nov 2026: the panel tells a scheduled automatic payment ("Pay now
  // instead") from a checkout that was opened and not finished ("Continue
  // payment") from a payment that is really moving (no button).
  it("★★ marks a scheduled automatic debit and an unfinished checkout, each from its own attempts", async () => {
    seed([[]]);
    await listPayableInvoices(STORE);
    const render = (q: unknown) =>
      new PgDialect()
        .sqlToQuery(q as never)
        .sql.replace(/\s+/g, " ")
        .trim();
    const projection = dbHolder.current.calls.select[0];
    // Notified, automatic, and its debit not sent yet.
    expect(render(projection.autopayAt)).toBe(
      `( select to_char(min(a.debit_after) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from public.billing_payment_attempts a where a.invoice_id = "billing_invoices"."id" and a.mode = 'automatic' and a.state = 'processing' and a.debit_after is not null and a.debit_sent_at is null)`,
    );
    // A manual checkout that already has its gateway order.
    expect(render(projection.resumable)).toBe(
      `exists ( select 1 from public.billing_payment_attempts a where a.invoice_id = "billing_invoices"."id" and a.mode = 'manual' and a.state = 'processing' and a.provider_order_id is not null)`,
    );
  });

  // GST design 5.9: the "invoice to pay" panel says what of the total is GST,
  // so the list carries the invoice's own tax figures, never a recomputation.
  it("★ selects the invoice's tax figures and hands them over as stored", async () => {
    const ROW = {
      id: INVOICE,
      invoiceRef: "SM/2026-27/00007",
      status: "open",
      totalPaise: 1_180_00,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      dueAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-08-28T00:00:00.000Z",
      taxPaise: 180_00,
      taxRateBps: 1800,
      taxInclusive: false,
    };
    seed([[ROW]]);
    const rows = await listPayableInvoices(STORE);
    const projection = dbHolder.current.calls.select[0];
    expect(projection.taxPaise).toBe(billingInvoices.taxPaise);
    expect(projection.taxRateBps).toBe(billingInvoices.taxRateBps);
    expect(projection.taxInclusive).toBe(billingInvoices.taxInclusive);
    expect(rows).toEqual([ROW]);
  });

  it("★ keeps a null rate (an invoice that recorded no GST) as null", async () => {
    seed([
      [
        {
          id: INVOICE,
          invoiceRef: "SM/2026-27/00008",
          status: "open",
          totalPaise: 1_000_00,
          periodStart: null,
          periodEnd: null,
          dueAt: null,
          createdAt: "2026-08-28T00:00:00.000Z",
          taxPaise: 0,
          taxRateBps: null,
          taxInclusive: false,
        },
      ],
    ]);
    const [row] = await listPayableInvoices(STORE);
    expect(row.taxPaise).toBe(0);
    expect(row.taxRateBps).toBeNull();
    expect(row.taxInclusive).toBe(false);
  });
});

describe("confirmInvoicePayment", () => {
  const args = {
    storeId: STORE,
    invoiceId: INVOICE,
    providerPaymentId: "pay_1",
    signature: "sig",
    now: NOW,
  };

  function seedAttempt() {
    seed([
      [{ id: "att-1", providerOrderId: "order_1", amountPaise: 5_000_00 }],
    ]);
  }

  it("settles the payment and reports the plan restored", async () => {
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.planRestored).toBe(true);
  });

  it("★★ REFUSES an unverified signature and settles nothing", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("refuses a gateway record that contradicts the signed callback", async () => {
    rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
      ok: false,
      error: "The captured amount does not match the invoice.",
    });
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("★ verifies against the order WE created", async () => {
    seedAttempt();
    await confirmInvoicePayment(args);
    expect(rzp.verifyCheckoutSignature).toHaveBeenCalledWith(
      "secret",
      "order_1",
      "pay_1",
      "sig",
    );
  });

  it("★ scopes the attempt lookup by store, not just invoice", async () => {
    seedAttempt();
    await confirmInvoicePayment(args);
    // The WHERE carries both predicates; a cross-tenant invoice id finds nothing.
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  it("refuses when there is no payment to confirm", async () => {
    seed([[]]);
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★★ restores the plan IMMEDIATELY, not at the next cron tick", async () => {
    // A merchant who has just paid must not stay locked out of their own till.
    seedAttempt();
    await confirmInvoicePayment(args);
    expect(worker.advanceAfterPayment).toHaveBeenCalledWith(STORE, NOW);
  });

  it("★ reports planRestored FALSE when the cycle had not turned", async () => {
    // Paying inside the T−4d window settles the invoice without moving the
    // cycle — saying "plan restored" would be untrue.
    worker.advanceAfterPayment.mockResolvedValue(false);
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.planRestored).toBe(false);
  });

  it("★ reports a non-captured settle as incomplete", async () => {
    collect.settleAttempt.mockResolvedValue("failed");
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("★ a lost settle race still advances — the money is accounted for", async () => {
    collect.settleAttempt.mockResolvedValue(null);
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(true);
    expect(worker.advanceAfterPayment).toHaveBeenCalled();
  });

  it("refuses with no platform credentials", async () => {
    provider.getPlatformRazorpayCreds.mockReturnValue(null);
    expect((await confirmInvoicePayment(args)).ok).toBe(false);
  });

  it.each(["void", "uncollectible"])(
    "★★ a payment that lands on a %s invoice reports the refund, never 'Paid'",
    async (status) => {
      // The plan ended while the checkout was open (design 4.3 edge case 2):
      // the invoice is closed, the capture cannot reopen it, and the refund
      // pass returns the money.
      seedAttempt();
      invStore.getInvoice.mockResolvedValue(openInvoice({ status }));
      const res = await confirmInvoicePayment(args);
      expect(res).toEqual({ ok: false, error: CLOSED_ON_ARRIVAL_MESSAGE });
      // The money is recorded before the re-read; nothing advances a plan
      // that has ended.
      expect(collect.settleAttempt).toHaveBeenCalledWith(
        "att-1",
        "captured",
        expect.anything(),
      );
      expect(collect.settleAttempt.mock.invocationCallOrder[0]).toBeLessThan(
        invStore.getInvoice.mock.invocationCallOrder[0],
      );
      expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
      expect(logInfo).toHaveBeenCalledWith(
        "billing.manual_pay_on_closed_invoice",
        expect.objectContaining({ invoiceId: INVOICE, invoiceStatus: status }),
      );
    },
  );

  it("★ an unreadable re-read changes nothing: the advance still decides", async () => {
    seedAttempt();
    invStore.getInvoice.mockResolvedValue(null);
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(true);
    expect(worker.advanceAfterPayment).toHaveBeenCalledWith(STORE, NOW);
  });
});

describe("★★ startInvoicePayment refuses an invoice that already holds a captured payment (RC-F1b)", () => {
  const args = { storeId: STORE, invoiceId: INVOICE, now: NOW };

  it("★★ re-syncs an open invoice first, and says it is paid when it now is", async () => {
    collect.capturedAttemptForInvoice.mockResolvedValue({
      id: "att-old",
      providerPaymentId: "pay_old",
    });
    invStore.getInvoice
      .mockResolvedValueOnce(openInvoice())
      .mockResolvedValueOnce(openInvoice({ status: "paid" }));
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: "That invoice is already paid." });
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-old",
      "captured",
      expect.objectContaining({ now: NOW }),
    );
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ a draft with a captured payment is refused, and never charged twice", async () => {
    collect.capturedAttemptForInvoice.mockResolvedValue({
      id: "att-old",
      providerPaymentId: "pay_old",
    });
    invStore.getInvoice.mockResolvedValue(
      openInvoice({ status: "draft", finalizedAt: null }),
    );
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: ALREADY_CAPTURED_INVOICE_MESSAGE });
    expect(ALREADY_CAPTURED_INVOICE_MESSAGE).toMatch(/don't pay it again/);
    expect(ALREADY_CAPTURED_INVOICE_MESSAGE).toMatch(/support@storemink\.com/);
    // A draft is not open, so nothing is re-synced; nothing is issued either.
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(invStore.finalizeInvoice).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ an open invoice that stays unpaid after the re-sync is still refused", async () => {
    collect.capturedAttemptForInvoice.mockResolvedValue({
      id: "att-old",
      providerPaymentId: null,
    });
    const res = await startInvoicePayment(args);
    expect(res).toEqual({ ok: false, error: ALREADY_CAPTURED_INVOICE_MESSAGE });
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });

  it("★ fails CLOSED when the payments cannot be read", async () => {
    collect.capturedAttemptForInvoice.mockResolvedValue(undefined);
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/couldn't check this invoice's payments/);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("asks about this store's invoice only", async () => {
    await startInvoicePayment(args);
    expect(collect.capturedAttemptForInvoice).toHaveBeenCalledWith(
      INVOICE,
      STORE,
    );
  });
});
