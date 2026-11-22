/* eslint-disable @typescript-eslint/no-explicit-any */
// Moving between plans and billing periods.
//
// The rule under test is one sentence with a lot resting on it: DEARER APPLIES
// NOW AND IS PAID FOR NOW; CHEAPER OR EQUAL WAITS FOR THE CYCLE END. Its purpose
// is that nobody is ever refunded, so the failure to guard against is an
// immediate downgrade — which looks generous and creates a refund.
//
// Two things it must get right that rank alone cannot:
//   • monthly → yearly is an UPGRADE (same tier, ten times the money);
//   • a tier downgrade can be a price RISE for a grandfathered subscriber.
// Both fall out of comparing AMOUNTS, which is why decidePlanChange takes them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";
import { logError, logWarn } from "@/lib/observability/logger";
import { resolveTaxSnapshot, type SnapshotRow } from "./tax-snapshot";
import { PAYMENT_REFUSAL } from "./tax-copy";

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
  // The verified payment, read back for its time (R1-07).
  rzpFetchPayment: vi.fn(),
  verifyCapturedCheckoutPayment: vi.fn(),
  verifyCheckoutSignature: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => rzp);

const store = vi.hoisted(() => ({
  loadTaxSnapshot: vi.fn(),
  createAddonInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
  amountDueForInvoice: vi.fn(),
  // Read after the settle: the plan moves only once the invoice is paid.
  getInvoice: vi.fn(async () => ({ id: "inv-1", status: "paid" })),
}));
vi.mock("./invoice-store", () => store);

const collect = vi.hoisted(() => ({
  beginAttempt: vi.fn(),
  settleAttempt: vi.fn(),
  // The new order is recorded on its attempt unless a test says it was not.
  recordGatewayOrder: vi.fn(),
  // RC-F1b: no earlier captured purchase unless a test says so.
  capturedDraftPurchases: vi.fn(async (): Promise<unknown[] | null> => []),
  fileRecoveredPurchase: vi.fn(async () => true),
  verifyRecoveredCapture: vi.fn(
    async (): Promise<unknown> => ({ status: "ok", paymentId: "pay_old" }),
  ),
  // The plan and period the ORDER was created for.
  readAddonOrderTarget: vi.fn(
    async (): Promise<unknown> => ({
      kind: "plan_change",
      plan: "pro",
      period: "monthly",
    }),
  ),
}));
vi.mock("./collect", () => collect);

import {
  PLAN_CHANGE_RECOVERY_WAITING_MESSAGE,
  completePlanChangePurchase,
  confirmPlanChange,
  planChangeTerms,
  startPlanChange,
} from "./plan-change";

/** A Drizzle condition, as Postgres would receive it. */
function render(query: unknown) {
  const q = new PgDialect().sqlToQuery(query as any);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
/** Half of a 30-day cycle remaining. */
const PERIOD_END = "2026-09-16T00:00:00.000Z";
const PRICE = { monthlyInr: 1000, yearlyInr: 10000 };

const PLAN_PAISE: Record<string, Record<string, number>> = {
  basic: { monthly: 1_500_00, yearly: 15_000_00 },
  pro: { monthly: 5_000_00, yearly: 50_000_00 },
};
const priceFor = vi.fn(async (plan: string, period: string) => ({
  planPaise: PLAN_PAISE[plan][period],
}));

function subRow(over: Record<string, unknown> = {}) {
  return {
    plan: "basic",
    period: "monthly",
    state: "active",
    billedLocations: 0,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    mandateId: null,
    ...over,
  };
}

/** sub row, then the next-invoice probe (empty = not issued), then writes. */
function seed(rows: any[][]) {
  dbHolder.current = makeDbMock({ selectQueue: rows });
}

/** GST off, StoreMink's identity complete, a merchant with no records; read
 *  through the REAL `resolveTaxSnapshot`. */
const SNAPSHOT_ROW: SnapshotRow = {
  taxEnabled: false,
  taxInclusive: false,
  taxRateBps: 1800,
  nextTaxEnabled: null,
  nextTaxInclusive: null,
  nextTaxRateBps: null,
  nextTaxStartsAt: null,
  supplierGstin: "03ABCDE1234F1Z5",
  supplierStateCode: "03",
  sacCode: "998314",
  accountGstin: null,
  accountStateCode: null,
  accountCountry: null,
  taxIdGstin: null,
  storeTaxStateCode: null,
  locationGstin: null,
  locationStateCode: null,
  taxAddress: null,
  signupStateName: null,
  signupCountry: null,
};

function readingFor(row: SnapshotRow) {
  store.loadTaxSnapshot.mockImplementation(async (_store: string, at: Date) =>
    resolveTaxSnapshot(row, at),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
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
  rzp.rzpFetchPayment.mockResolvedValue({ ok: true, data: { id: "pay_1" } });
  readingFor(SNAPSHOT_ROW);
  store.createAddonInvoice.mockResolvedValue({
    id: "inv-1",
    status: "draft",
    finalizedAt: null,
    invoiceRef: null,
  });
  store.finalizeInvoice.mockResolvedValue({
    id: "inv-1",
    status: "open",
    finalizedAt: NOW.toISOString(),
  });
  store.amountDueForInvoice.mockResolvedValue(175_000);
  collect.beginAttempt.mockResolvedValue({
    attemptId: "att-1",
    idempotencyKey: "key-1",
  });
  collect.settleAttempt.mockResolvedValue("captured");
  collect.recordGatewayOrder.mockResolvedValue(true);
});

const base = {
  storeId: STORE,
  priceFor,
  locationPrice: PRICE,
  now: NOW,
};

describe("startPlanChange — dearer applies NOW", () => {
  it("★★ charges the part period for an UPGRADE", async () => {
    // basic→pro monthly: (5,000 − 1,500) × 15/30 = ₹1,750.
    seed([[subRow()], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.payment?.providerOrderId).toBe("order_1");
    expect(store.createAddonInvoice.mock.calls[0][0].built.totalPaise).toBe(
      175_000,
    );
  });

  it("★★ monthly → yearly is an UPGRADE, though the TIER is unchanged", async () => {
    // Rank would call this "no change" while the charge is ten times bigger.
    seed([[subRow()], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "yearly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.payment).toBeDefined();
  });

  it("★★ grants NOTHING before the payment", async () => {
    seed([[subRow()], []]);
    await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★ does not finalize the invoice up front", async () => {
    seed([[subRow()], []]);
    await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★★ a ZERO part period applies it FREE rather than refusing the upgrade", async () => {
    // At the very end of a cycle the proration rounds to nothing and Razorpay
    // refuses a ₹0 order. The merchant gains a few hours.
    seed([[subRow({ currentPeriodEnd: NOW.toISOString() })], [], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.payment).toBeUndefined();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.set[0].plan).toBe("pro");
  });

  // PR #303 re-review, 22 Nov 2026. The write that records the new order on
  // its attempt can fail (a pool wait running out). The order id used to be
  // returned anyway, so the merchant could pay an order nothing knew about.
  it("★★ an order the attempt could not record is NEVER handed to the browser", async () => {
    collect.recordGatewayOrder.mockResolvedValue(false);
    seed([[subRow()], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res).toEqual({
      ok: false,
      error: "Couldn't start the payment. Try again.",
    });
    expect(collect.recordGatewayOrder).toHaveBeenCalledWith(
      expect.objectContaining({ providerOrderId: "order_1" }),
    );
  });

  it("★ an UNKNOWN order outcome leaves the attempt in flight", async () => {
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    seed([[subRow()], []]);
    await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "unknown",
      expect.anything(),
    );
  });
});

describe("startPlanChange — cheaper or equal WAITS", () => {
  it("★★ SCHEDULES a downgrade and moves no money", async () => {
    seed([[subRow({ plan: "pro" })], [], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.scheduled).toBe(true);
    expect(res.data.effectiveAt).toBe(PERIOD_END);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    const set = dbHolder.current.calls.set[0];
    expect(set.scheduledPlan).toBe("basic");
    // ★ The LIVE plan is untouched — they keep what they paid for.
    expect(set.plan).toBeUndefined();
  });

  it("★ yearly → monthly is a DOWNGRADE and waits", async () => {
    seed([[subRow({ period: "yearly" })], [], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.scheduled).toBe(true);
    expect(dbHolder.current.calls.set[0].scheduledPeriod).toBe("monthly");
  });

  it("★★ REFUSES inside the collection window — that invoice is already issued", async () => {
    // Applying it at the turn against an invoice priced at the OLD plan bills the
    // wrong amount for a whole cycle.
    seed([[subRow({ plan: "pro" })], [{ id: "inv-next" }]]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already been issued/i);
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★★ FAILS TOWARD REFUSING when it cannot tell whether the invoice exists", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[subRow({ plan: "pro" })]] });
    let n = 0;
    const real = dbHolder.current.db.select;
    dbHolder.current.db.select = (...a: any[]) => {
      n += 1;
      if (n === 2) throw new Error("db down");
      return real(...a);
    };
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    expect(dbHolder.current.calls.update.length).toBe(0);
  });
});

describe("startPlanChange — refusals", () => {
  it("refuses a no-op", async () => {
    seed([[subRow()], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
  });

  it("★ refuses FREE — that is a cancellation, not a change", async () => {
    seed([[subRow()], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "free" as any,
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Cancel your subscription/i);
  });

  it("★★ refuses while the subscription is CANCELLING", async () => {
    // A cancelling subscription has no next cycle to schedule into, and applying
    // a change now would contradict the cancellation.
    seed([[subRow({ cancelAtPeriodEnd: true })], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Resume it first/i);
  });

  it("refuses with no live subscription", async () => {
    seed([[subRow({ state: "free" })], []]);
    expect(
      (
        await startPlanChange({
          ...base,
          targetPlan: "pro",
          targetPeriod: "monthly",
        })
      ).ok,
    ).toBe(false);
  });

  it("★★ FAILS CLOSED on a read error", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/couldn't check/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ drops billable locations when the TARGET plan has no POS", async () => {
    // Charging for shops a plan cannot use is indefensible, and resolveNextCycle
    // applies the same rule at the turn — so quote and outcome agree.
    seed([[subRow({ plan: "pro", billedLocations: 3 })], [], []]);
    await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    // Scheduled, so the location count moves at the turn via resolveNextCycle;
    // what matters here is that the decision was priced without them.
    expect(dbHolder.current.calls.set[0].scheduledPlan).toBe("basic");
  });
});

describe("confirmPlanChange", () => {
  const args = {
    storeId: STORE,
    invoiceId: "inv-1",
    targetPlan: "pro" as const,
    targetPeriod: "monthly" as const,
    providerPaymentId: "pay_1",
    signature: "sig",
    now: NOW,
  };

  /**
   * The confirm's own reads (invoice count, attempt), then the completion's
   * facts (invoice, attempt, store, subscription), then the claim's store read.
   */
  function seedConfirm(over: Record<string, unknown> = {}) {
    seedComplete({ storeRow: { plan: "basic", planSource: "paid", ...over } });
  }

  it("★★ R1-07: issues at the payment's own time, from the gateway's record", async () => {
    const CAPTURED_SECONDS = Math.floor(NOW.getTime() / 1000) - 600;
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: true,
      data: { id: "pay_1", created_at: CAPTURED_SECONDS },
    });
    seedConfirm();
    const res = await confirmPlanChange(args);
    expect(res.ok).toBe(true);
    expect(rzp.rzpFetchPayment).toHaveBeenCalledWith(
      expect.anything(),
      "pay_1",
    );
    expect(store.finalizeInvoice).toHaveBeenCalledWith(
      "inv-1",
      NOW,
      new Date(CAPTURED_SECONDS * 1000),
    );
  });

  it("★ R1-07: an unreadable payment time issues at the confirm, and the purchase still applies", async () => {
    rzp.rzpFetchPayment.mockRejectedValue(new Error("socket hang up"));
    seedConfirm();
    const res = await confirmPlanChange(args);
    expect(res.ok).toBe(true);
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW, undefined);
    expect(logWarn).toHaveBeenCalledWith("billing.plan_change.payment_time", {
      paymentId: "pay_1",
      reason: "socket hang up",
    });
  });

  it("★ R1-07: verified by signature alone (gateway unreadable), no time is taken from the gateway", async () => {
    rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
      ok: true,
      gatewayRead: false,
    });
    seedConfirm();
    await confirmPlanChange(args);
    expect(rzp.rzpFetchPayment).not.toHaveBeenCalled();
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW, undefined);
  });

  it("★★ FINALIZES BEFORE SETTLING — settling a DRAFT leaves a paid invoice unpaid", async () => {
    // Same regression as confirmEnrolment, same cause, same cost. See the note
    // in lib/billing/enrol.ts: `syncInvoiceStatus` can only claim the move to
    // paid from "open" or "processing", so settling while the invoice is still a
    // DRAFT captures the money and leaves an unpaid invoice behind it — silently.
    seedConfirm();
    await confirmPlanChange(args);
    expect(store.finalizeInvoice).toHaveBeenCalled();
    expect(collect.settleAttempt).toHaveBeenCalled();
    expect(store.finalizeInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      collect.settleAttempt.mock.invocationCallOrder[0],
    );
  });

  it("applies the plan on a verified payment", async () => {
    seedConfirm();
    const res = await confirmPlanChange(args);
    expect(res.ok).toBe(true);
    const set = dbHolder.current.calls.set[0];
    expect(set.plan).toBe("pro");
    expect(set.period).toBe("monthly");
  });

  it("★★ applies what the ORDER bought, never what the browser names", async () => {
    // The request says Pro yearly; the order the server created says Pro
    // monthly. Monthly is applied, and the mismatch is logged.
    seedConfirm();
    const res = await confirmPlanChange({ ...args, targetPeriod: "yearly" });
    expect(res).toEqual({ ok: true, data: { plan: "pro", period: "monthly" } });
    expect(dbHolder.current.calls.set[0].period).toBe("monthly");
    expect(logWarn).toHaveBeenCalledWith(
      "billing.plan_change.client_target_ignored",
      expect.anything(),
    );
  });

  it("★★ the apply is a CLAIM: live, same cycle, not already on the target", async () => {
    seedConfirm();
    await confirmPlanChange(args);
    const where = dbHolder.current.calls.where
      .map((w: unknown) => render(w))
      .find((w: { sql: string }) =>
        w.sql.includes('"billing_subscriptions"."current_cycle_seq" ='),
      );
    expect(where).toBeDefined();
    if (!where) return;
    expect(where.sql).toContain('"billing_subscriptions"."state" in');
    expect(where.sql).toContain("not (");
    expect(where.params).toEqual(expect.arrayContaining([STORE, 3, "pro"]));
  });

  it("★★ a confirm after the purchase was finished changes nothing", async () => {
    seedComplete({
      invoiceStatus: "paid",
      attemptState: "captured",
      claimed: false,
      after: subRow({ plan: "pro" }),
    });
    collect.settleAttempt.mockResolvedValue(null);
    const res = await confirmPlanChange(args);
    expect(res).toEqual({ ok: true, data: { plan: "pro", period: "monthly" } });
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
    // Only the refused claim was attempted; stores.plan was never written.
    expect(
      dbHolder.current.calls.set.some((s: any) => s.planSource === "paid"),
    ).toBe(false);
  });

  it("★★ REFUSES an unverified signature and applies nothing", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedConfirm();
    const res = await confirmPlanChange(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★ issues the document once it is really paid", async () => {
    seedConfirm();
    await confirmPlanChange(args);
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW, undefined);
  });

  it("★★ THE COMP FLOOR HOLDS — billing never lowers an operator grant", async () => {
    // The defect that cost a real merchant their Pro plan (§15): only
    // billing_subscriptions moves, and stores.plan keeps the better grant.
    collect.readAddonOrderTarget.mockResolvedValue({
      kind: "plan_change",
      plan: "basic",
      period: "monthly",
    });
    seedComplete({
      sub: { plan: "pro" },
      storeRow: { plan: "pro", planSource: "comp" },
    });
    const res = await confirmPlanChange({ ...args, targetPlan: "basic" });
    expect(res.ok).toBe(true);
    // Two updates would mean stores.plan was written; only the subscription one
    // is expected here.
    const wroteStorePlan = dbHolder.current.calls.set.some(
      (s: any) => s.planSource === "paid",
    );
    expect(wroteStorePlan).toBe(false);
  });

  it("★ writes stores.plan when the floor allows it", async () => {
    seedConfirm({ plan: "basic", planSource: "paid" });
    await confirmPlanChange(args);
    expect(
      dbHolder.current.calls.set.some((s: any) => s.planSource === "paid"),
    ).toBe(true);
  });

  // An operator's timed grant left in plan_expires_at would lapse the plan the
  // merchant just paid for once its date passed.
  it("★ clears a leftover grant expiry when it writes the paid plan", async () => {
    seedConfirm({ plan: "basic", planSource: "comp" });
    await confirmPlanChange(args);
    const write = dbHolder.current.calls.set.find(
      (s: any) => s.planSource === "paid",
    );
    expect(write).toMatchObject({ planExpiresAt: null });
  });

  it("★★ refuses an invoice with no recorded count", async () => {
    // ⚠ The attempt MUST be present, or this passes because there is no payment
    // to confirm rather than because the guard held — which is how a mutation
    // removing the guard survived.
    seed([
      [{ locations: null }],
      [{ id: "att-1", providerOrderId: "order_1" }],
      [{ plan: "basic", planSource: "paid" }],
    ]);
    const res = await confirmPlanChange(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("refuses when there is no payment to confirm", async () => {
    seed([[{ locations: 0 }], []]);
    expect((await confirmPlanChange(args)).ok).toBe(false);
  });

  it("★★ money IN but the plan not moved is never a bare failure", async () => {
    seedConfirm();
    dbHolder.current.db.update = () => {
      throw new Error("db down");
    };
    const res = await confirmPlanChange(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/don't pay again/i);
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ repairKey: "purchase_unapplied:att-1" }),
    );
  });
});

/**
 * The completion's reads, by table: (unless `recovery`) the confirm's own
 * invoice-count and attempt reads, then invoice, attempt, store and
 * subscription, then the claim's store read and the loser's re-read.
 */
function seedComplete(
  opts: {
    recovery?: boolean;
    invoiceStatus?: string;
    attemptState?: string;
    sub?: Record<string, unknown>;
    storeRow?: Record<string, unknown>;
    claimed?: boolean;
    after?: Record<string, unknown>;
    invoiceCreatedAt?: string;
    storeExists?: boolean;
  } = {},
) {
  const attempt = {
    id: "att-1",
    invoiceId: "inv-1",
    storeId: STORE,
    state: opts.attemptState ?? "processing",
    amountPaise: 175_000,
    currency: "INR",
    providerOrderId: "order_1",
    providerPaymentId: null,
  };
  dbHolder.current = makeDbMock({
    selectByTable: {
      billing_invoices: [
        ...(opts.recovery ? [] : [[{ locations: 0 }]]),
        [
          {
            storeId: STORE,
            kind: "addon",
            status: opts.invoiceStatus ?? "draft",
            addonTargetCount: 0,
            createdAt: opts.invoiceCreatedAt ?? "2026-08-31T00:00:00.000Z",
          },
        ],
      ],
      billing_payment_attempts: [
        ...(opts.recovery
          ? []
          : [
              [
                {
                  id: "att-1",
                  providerOrderId: "order_1",
                  amountPaise: 175_000,
                },
              ],
            ]),
        [attempt],
      ],
      stores: [
        opts.storeExists === false ? [] : [{ id: STORE }],
        [opts.storeRow ?? { plan: "basic", planSource: "paid" }],
      ],
      billing_subscriptions: [
        [
          {
            state: "active",
            plan: "basic",
            period: "monthly",
            currentCycleSeq: 3,
            currentPeriodStart: "2026-08-17T00:00:00.000Z",
            ...opts.sub,
          },
        ],
        opts.after ? [opts.after] : [],
      ],
    },
    returningQueue: [opts.claimed === false ? [] : [{ storeId: STORE }]],
  });
}

describe("completePlanChangePurchase (recovery, RC-F1b)", () => {
  const recovery = {
    storeId: STORE,
    invoiceId: "inv-1",
    attemptId: "att-1",
    providerPaymentId: null,
    source: "recovery" as const,
    verifyCapture: true,
    now: NOW,
  };

  it("★★ finishes a closed-tab upgrade: issues, settles, applies the order's plan", async () => {
    seedComplete({ recovery: true, attemptState: "captured" });
    const res = await completePlanChangePurchase(recovery);
    expect(res).toEqual({
      status: "completed",
      data: { plan: "pro", period: "monthly" },
    });
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW, undefined);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "captured",
      expect.objectContaining({ providerPaymentId: "pay_old" }),
    );
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      plan: "pro",
      period: "monthly",
    });
  });

  it("★ issues the draft at the capture time it is given (GST paidAt)", async () => {
    seedComplete({ recovery: true, attemptState: "captured" });
    const paidAt = new Date(NOW.getTime() - 2 * 3_600_000);
    const res = await completePlanChangePurchase({ ...recovery, paidAt });
    expect(res.status).toBe("completed");
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW, paidAt);
  });

  it("★★ an unreadable order changes nothing", async () => {
    seedComplete({ recovery: true, attemptState: "captured" });
    collect.readAddonOrderTarget.mockResolvedValue(null);
    const res = await completePlanChangePurchase(recovery);
    expect(res.status).toBe("not_ready");
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
    expect(collect.fileRecoveredPurchase).not.toHaveBeenCalled();
  });

  it("★★ a captured amount that differs is filed, never applied", async () => {
    seedComplete({ recovery: true, attemptState: "captured" });
    collect.verifyRecoveredCapture.mockResolvedValue({
      status: "mismatch",
      reason: "the captured amount or currency differs from the attempt",
      paymentId: "pay_old",
      observedPaise: 1_00,
    });
    const res = await completePlanChangePurchase(recovery);
    expect(res.status).toBe("refused");
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "amount_mismatch",
        repairKey: "purchase_refused:att-1",
        purchase: "plan_change",
      }),
    );
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★★ a change bought in an earlier cycle is filed, not applied", async () => {
    seedComplete({
      recovery: true,
      attemptState: "captured",
      invoiceCreatedAt: "2026-08-01T00:00:00.000Z",
    });
    const res = await completePlanChangePurchase(recovery);
    expect(res.status).toBe("refused");
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.stringMatching(/cycle that has since ended/),
      }),
    );
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★ a draft whose subscription already reached the target is filed", async () => {
    seedComplete({
      recovery: true,
      attemptState: "captured",
      sub: { plan: "pro", period: "monthly" },
    });
    const res = await completePlanChangePurchase(recovery);
    expect(res.status).toBe("refused");
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.stringMatching(/already on Pro/),
      }),
    );
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★ a subscription that is no longer live is filed", async () => {
    seedComplete({
      recovery: true,
      attemptState: "captured",
      sub: { state: "free" },
    });
    expect((await completePlanChangePurchase(recovery)).status).toBe("refused");
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });
});

describe("startPlanChange finishes an earlier paid change (RC-F1b)", () => {
  const earlier = {
    attemptId: "att-1",
    invoiceId: "inv-1",
    storeId: STORE,
    kind: "addon",
    providerOrderId: "order_1",
    providerPaymentId: "pay_old",
    amountPaise: 175_000,
    currency: "INR",
    createdAt: NOW.toISOString(),
  };

  it("★★ completes it instead of opening a second order", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([earlier]);
    seedComplete({ recovery: true, attemptState: "captured" });
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res).toEqual({
      ok: true,
      data: {
        scheduled: false,
        effectiveAt: null,
        plan: "pro",
        period: "monthly",
        recovered: true,
      },
    });
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(store.createAddonInvoice).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });

  it("★★ when it cannot be finished, says the payment went through and opens nothing", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([earlier]);
    seedComplete({ recovery: true, attemptState: "captured" });
    collect.verifyRecoveredCapture.mockResolvedValue({ status: "unreadable" });
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res).toEqual({
      ok: false,
      error: PLAN_CHANGE_RECOVERY_WAITING_MESSAGE,
    });
    expect(PLAN_CHANGE_RECOVERY_WAITING_MESSAGE).toMatch(/don't pay again/);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ fails CLOSED when the earlier purchases can't be read", async () => {
    collect.capturedDraftPurchases.mockResolvedValue(null);
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res).toEqual({
      ok: false,
      error: "Couldn't check your subscription. Try again.",
    });
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ fails CLOSED when the earlier order can't be read", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([earlier]);
    collect.readAddonOrderTarget.mockResolvedValue(null);
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ an earlier LOCATION purchase is not this flow's to finish", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([earlier]);
    collect.readAddonOrderTarget.mockResolvedValue({
      kind: "locations",
      count: 3,
    });
    seed([[subRow()], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.payment?.providerOrderId).toBe("order_1");
  });
});

describe("planChangeTerms: one decision for the quote and the payment", () => {
  it("★ decides a dearer change without writing anything", async () => {
    seed([[subRow()]]);
    const res = await planChangeTerms({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res).toEqual({
      ok: true,
      data: {
        kind: "immediate",
        plan: "pro",
        period: "monthly",
        // (5,000 − 1,500) × 15/30, before GST.
        prorationPaise: 175_000,
        targetLocations: 0,
        description: expect.stringMatching(/^Pro plan · part period to /),
        currentPeriodEnd: PERIOD_END,
      },
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    // The decision needs no tax reading: GST is the payment's business.
    expect(store.loadTaxSnapshot).not.toHaveBeenCalled();
  });

  it("decides a cheaper change is scheduled for the cycle end", async () => {
    seed([[subRow({ plan: "pro" })], []]);
    const res = await planChangeTerms({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res).toEqual({
      ok: true,
      data: {
        kind: "scheduled",
        plan: "basic",
        period: "monthly",
        effectiveAt: PERIOD_END,
      },
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("refuses what the payment refuses, in the same words", async () => {
    seed([[subRow({ plan: "pro" })], [{ id: "inv-next" }]]);
    const res = await planChangeTerms({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already been issued/i);
  });

  it("keeps billed locations only for a plan with POS", async () => {
    seed([[subRow({ plan: "pro", billedLocations: 2 })]]);
    const res = await planChangeTerms({
      ...base,
      targetPlan: "pro",
      targetPeriod: "yearly",
    });
    expect(
      res.ok && res.data.kind === "immediate" && res.data.targetLocations,
    ).toBe(2);
  });
});

describe("startPlanChange reads the tax once (GST Stage 7)", () => {
  const upgrade = {
    ...base,
    targetPlan: "pro" as const,
    targetPeriod: "monthly" as const,
  };

  function expectNothingWritten() {
    expect(store.createAddonInvoice).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
  }

  it("★ builds the part period with the reading's GST and stamps it", async () => {
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true, accountStateCode: "29" });
    seed([[subRow()], []]);
    const res = await startPlanChange(upgrade);
    expect(res.ok).toBe(true);
    const arg = store.createAddonInvoice.mock.calls[0][0];
    // ₹1,750 + 18% exclusive.
    expect(arg.built).toMatchObject({ taxPaise: 31_500, totalPaise: 206_500 });
    expect(arg.stamp).toEqual({
      supplierGstin: "03ABCDE1234F1Z5",
      customerGstin: null,
      placeOfSupply: "29",
      placeOfSupplyBasis: "recipient",
      sacCode: "998314",
    });
    expect(arg).not.toHaveProperty("supplierGstin");
    expect(store.loadTaxSnapshot).toHaveBeenCalledWith(STORE, NOW);
  });

  it("a reading that fails", async () => {
    store.loadTaxSnapshot.mockRejectedValue(new Error("connection reset"));
    seed([[subRow()], []]);
    const res = await startPlanChange(upgrade);
    expect(res).toEqual({ ok: false, error: PAYMENT_REFUSAL.invoiceFailed });
    expectNothingWritten();
    expect(logError).toHaveBeenCalledWith(
      "billing.plan_change.tax_snapshot",
      expect.any(Error),
      { storeId: STORE },
    );
  });

  it("GST on without StoreMink's full tax identity", async () => {
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true, sacCode: null });
    seed([[subRow()], []]);
    expect(await startPlanChange(upgrade)).toEqual({
      ok: false,
      error: PAYMENT_REFUSAL.settingsIncomplete,
    });
    expectNothingWritten();
  });

  it("★ GST on and no state of the merchant anywhere", async () => {
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true });
    seed([[subRow()], []]);
    expect(await startPlanChange(upgrade)).toEqual({
      ok: false,
      error: PAYMENT_REFUSAL.needsState,
    });
    expectNothingWritten();
  });

  it("★ GST on and a business outside India", async () => {
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true, accountCountry: "US" });
    seed([[subRow()], []]);
    expect(await startPlanChange(upgrade)).toEqual({
      ok: false,
      error: PAYMENT_REFUSAL.outsideIndia,
    });
    expectNothingWritten();
  });

  it("★ a change that moves no money needs no reading", async () => {
    // A downgrade is booked for the cycle end and a ₹0 part period is applied
    // free: neither has an invoice, so neither may be refused for its GST.
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true }); // would refuse
    seed([[subRow({ plan: "pro" })], [], []]);
    const booked = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(booked.ok && booked.data.scheduled).toBe(true);

    seed([[subRow({ currentPeriodEnd: NOW.toISOString() })], [], []]);
    const free = await startPlanChange(upgrade);
    expect(free.ok).toBe(true);
    expect(store.loadTaxSnapshot).not.toHaveBeenCalled();
  });
});

describe("completePlanChangePurchase: a failed issue (GST Stage 7)", () => {
  it("★ is logged, and nothing is settled or applied", async () => {
    seedComplete({ recovery: true, attemptState: "captured" });
    store.finalizeInvoice.mockResolvedValue(null);
    const res = await completePlanChangePurchase({
      storeId: STORE,
      invoiceId: "inv-1",
      attemptId: "att-1",
      providerPaymentId: null,
      source: "recovery",
      verifyCapture: true,
      now: NOW,
    });
    expect(res.status).toBe("not_ready");
    expect(logWarn).toHaveBeenCalledWith("billing.confirm_issue_failed", {
      purchase: "plan_change",
      source: "recovery",
      storeId: STORE,
      invoiceId: "inv-1",
      attemptId: "att-1",
    });
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });
});
