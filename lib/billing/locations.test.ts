/* eslint-disable @typescript-eslint/no-explicit-any */
// Buying and releasing extra locations.
//
// Two things carry the weight here, and they pull in opposite directions:
//
//   • BUYING takes money, so the count must be absolute (never a delta), the
//     granted number must come from the INVOICE rather than the request, and the
//     mandate ceiling must be checked BEFORE the sale — selling a location that
//     makes the next renewal undebitable downgrades a paying merchant.
//   • RELEASING takes none, and must never take effect early: dropping the count
//     while the merchant is still paying for the shop refuses them a location
//     they own.
//
// The subtle one is the interaction: a release booked after the next invoice has
// been issued would be applied at the turn against an invoice priced at the OLD
// count — a full extra cycle charged for a shop that is gone.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";
import { logError, logWarn } from "@/lib/observability/logger";
import { resolveTaxSnapshot, type SnapshotRow } from "./tax-snapshot";
import { PAYMENT_REFUSAL } from "./tax-copy";
import { collectionStartsAt } from "./cycle";

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

const pricing = vi.hoisted(() => ({ getPlanPricingLive: vi.fn() }));
vi.mock("@/lib/plans/pricing", () => pricing);

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
  // Read after the settle: the count moves only once the invoice is paid.
  getInvoice: vi.fn(async () => ({ id: "inv-1", status: "paid" })),
}));
vi.mock("./invoice-store", () => store);

const collect = vi.hoisted(() => ({
  beginAttempt: vi.fn(),
  settleAttempt: vi.fn(),
  // RC-F1b: no earlier captured purchase unless a test says so.
  capturedDraftPurchases: vi.fn(async (): Promise<unknown[] | null> => []),
  fileRecoveredPurchase: vi.fn(async () => true),
  verifyRecoveredCapture: vi.fn(
    async (): Promise<unknown> => ({ status: "ok", paymentId: "pay_old" }),
  ),
  readAddonOrderTarget: vi.fn(
    async (): Promise<unknown> => ({ kind: "locations", count: 2 }),
  ),
}));
vi.mock("./collect", () => collect);

import {
  LOCATIONS_RECOVERED_MESSAGE,
  LOCATIONS_RECOVERY_WAITING_MESSAGE,
  completeLocationPurchase,
  confirmLocationPurchase,
  getLocationBillingState,
  releaseLocations,
  startLocationPurchase,
} from "./locations";

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
/** 15 days left of a 30-day cycle — exactly half. */
const PERIOD_END = "2026-09-16T00:00:00.000Z";
const PRO = {
  plan: "pro",
  plan_expires_at: null,
  comp_plan: null,
  comp_expires_at: null,
};
const PRICE = { monthlyInr: 1000, yearlyInr: 10000 };

function subRow(over: Record<string, unknown> = {}) {
  return {
    plan: "pro",
    period: "monthly",
    state: "active",
    billedLocations: 1,
    scheduledLocations: null,
    currentCycleSeq: 3,
    currentPeriodEnd: PERIOD_END,
    mandateId: null,
    ...over,
  };
}

/** sub row, then location count, then whatever the path reads next. */
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
  pricing.getPlanPricingLive.mockResolvedValue({
    free: {
      monthlyInr: 0,
      yearlyInr: 0,
      baseMonthlyInr: null,
      baseYearlyInr: null,
    },
    basic: {
      monthlyInr: 1500,
      yearlyInr: 15000,
      baseMonthlyInr: null,
      baseYearlyInr: null,
    },
    pro: {
      monthlyInr: 5000,
      yearlyInr: 50000,
      baseMonthlyInr: null,
      baseYearlyInr: null,
    },
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
  store.amountDueForInvoice.mockResolvedValue(50_000);
  collect.beginAttempt.mockResolvedValue({
    attemptId: "att-1",
    idempotencyKey: "key-1",
  });
  collect.settleAttempt.mockResolvedValue("captured");
});

describe("getLocationBillingState", () => {
  it("reports the allowance and what one more costs part-period", async () => {
    seed([[subRow()], [{ n: 2 }]]);
    const s = await getLocationBillingState({
      storeId: STORE,
      store: PRO,
      locationPrice: PRICE,
      now: NOW,
    });
    expect(s).toMatchObject({
      included: 2,
      billed: 1,
      existing: 2,
      allowance: 3,
      period: "monthly",
      canBuy: true,
    });
    // Half a 30-day cycle left of a ₹1,000 location.
    expect(s?.nextPurchaseInr).toBe(500);
  });

  it("★ explains WHY buying is unavailable rather than hiding the control", async () => {
    seed([[null], [{ n: 1 }]]);
    const s = await getLocationBillingState({
      storeId: STORE,
      store: PRO,
      locationPrice: PRICE,
      now: NOW,
    });
    expect(s?.canBuy).toBe(false);
    expect(s?.blockedReason).toMatch(/subscri/i);
  });

  it("★ a non-Pro plan is told it is a Pro feature", async () => {
    seed([[subRow()], [{ n: 1 }]]);
    const s = await getLocationBillingState({
      storeId: STORE,
      store: {
        plan: "basic",
        plan_expires_at: null,
        comp_plan: null,
        comp_expires_at: null,
      },
      locationPrice: PRICE,
      now: NOW,
    });
    expect(s?.canBuy).toBe(false);
    expect(s?.blockedReason).toMatch(/Pro/);
  });

  it("★ surfaces a booked release", async () => {
    seed([[subRow({ billedLocations: 2, scheduledLocations: 1 })], [{ n: 3 }]]);
    const s = await getLocationBillingState({
      storeId: STORE,
      store: PRO,
      locationPrice: PRICE,
      now: NOW,
    });
    expect(s?.scheduled).toBe(1);
  });

  it("★ returns NULL on a read failure, so the page can say nothing rather than lie", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const s = await getLocationBillingState({
      storeId: STORE,
      store: PRO,
      locationPrice: PRICE,
      now: NOW,
    });
    expect(s).toBeNull();
  });
});

// GST design 7.5: every amount the card shows comes from the invoice that
// would carry it. The renewal is the REAL `quoteLocationRenewal` (quote.ts is
// not mocked), which reads the subscription a third time: hence the third row.
describe("getLocationBillingState: the GST amounts (design 7.5)", () => {
  /** Four days before the cycle that starts at PERIOD_END: 12 Sep 2026. */
  const ISSUED_AT = collectionStartsAt(new Date(PERIOD_END)).toISOString();
  /** GST added on top at 18%, scheduled to start at `startsAt`. */
  function scheduledEx(startsAt: string): SnapshotRow {
    return {
      ...SNAPSHOT_ROW,
      nextTaxEnabled: true,
      nextTaxInclusive: false,
      nextTaxRateBps: 1800,
      nextTaxStartsAt: startsAt,
    };
  }
  const ON_EX: SnapshotRow = { ...SNAPSHOT_ROW, taxEnabled: true };
  const ON_IN: SnapshotRow = {
    ...SNAPSHOT_ROW,
    taxEnabled: true,
    taxInclusive: true,
  };

  async function read(over: { now?: Date } = {}) {
    return getLocationBillingState({
      storeId: STORE,
      store: PRO,
      locationPrice: PRICE,
      now: over.now ?? NOW,
    });
  }

  it("GST off: the list price, the part period and the renewal carry no GST", async () => {
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    const s = await read();
    expect(s?.perPeriod).toEqual({
      listedPaise: 100_000,
      taxablePaise: 100_000,
      taxPaise: 0,
      totalPaise: 100_000,
      rateBps: 0,
      inclusive: false,
    });
    // Half a 30-day cycle left of a ₹1,000 location, as the charge builds it.
    expect(s?.nextPurchase).toMatchObject({ totalPaise: 50_000, taxPaise: 0 });
    expect(s?.nextRenewal).toEqual({
      perLocation: expect.objectContaining({ totalPaise: 100_000 }),
      issuedAt: ISSUED_AT,
    });
    expect(s?.terms).toMatchObject({ active: false, upcoming: null });
    expect(s?.needsState).toBe(false);
    expect(s?.outsideIndia).toBe(false);
    // The fields an older bundle reads, unchanged.
    expect(s?.pricePerPeriodInr).toBe(1000);
    expect(s?.nextPurchaseInr).toBe(500);
    expect(s?.canBuy).toBe(true);
  });

  // ★★ The stage's mutation: the renewal is priced under the terms at ITS
  // invoice's issue, four days before the cycle, never today's. A start
  // after that issue leaves the renewal untaxed though the cycle begins
  // after the start.
  it.each([
    ["after the renewal is invoiced", "2026-09-14T00:00:00.000Z", 100_000, 0],
    [
      "before the renewal is invoiced",
      "2026-09-05T00:00:00.000Z",
      118_000,
      18_000,
    ],
  ])(
    "★★ GST scheduled to start %s (%s): the renewal is %d paise",
    async (_label, startsAt, renewalTotal, renewalTax) => {
      readingFor(scheduledEx(startsAt));
      seed([[subRow()], [{ n: 2 }], [subRow()]]);
      const s = await read();
      expect(s?.nextRenewal?.perLocation).toMatchObject({
        totalPaise: renewalTotal,
        taxPaise: renewalTax,
        listedPaise: 100_000,
      });
      expect(s?.nextRenewal?.issuedAt).toBe(ISSUED_AT);
      // Today's terms still charge no GST: the list price and the part period
      // are untaxed either way.
      expect(s?.perPeriod?.totalPaise).toBe(100_000);
      expect(s?.nextPurchase).toMatchObject({
        totalPaise: 50_000,
        taxPaise: 0,
      });
      expect(s?.terms).toMatchObject({
        active: false,
        upcoming: { enabled: true, inclusive: false, startsAt },
      });
    },
  );

  it("★ a renewal invoiced under GST needs the store's state when it has none", async () => {
    readingFor(scheduledEx("2026-09-05T00:00:00.000Z"));
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    expect((await read())?.needsState).toBe(true);

    // A start after the renewal's issue: nothing needs the state yet.
    readingFor(scheduledEx("2026-09-14T00:00:00.000Z"));
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    expect((await read())?.needsState).toBe(false);

    // A state on the billing account: the renewal has its place of supply.
    readingFor({
      ...scheduledEx("2026-09-05T00:00:00.000Z"),
      accountStateCode: "07",
    });
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    const s = await read();
    expect(s?.needsState).toBe(false);
    expect(s?.nextRenewal?.perLocation.totalPaise).toBe(118_000);
  });

  it("ON-EX now: 18% is added to the list price and the part period", async () => {
    readingFor({ ...ON_EX, accountStateCode: "07" });
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    const s = await read();
    expect(s?.perPeriod).toMatchObject({
      listedPaise: 100_000,
      taxablePaise: 100_000,
      taxPaise: 18_000,
      totalPaise: 118_000,
      rateBps: 1800,
      inclusive: false,
    });
    expect(s?.nextPurchase).toMatchObject({
      taxablePaise: 50_000,
      taxPaise: 9_000,
      totalPaise: 59_000,
    });
    expect(s?.nextRenewal?.perLocation.totalPaise).toBe(118_000);
    expect(s?.needsState).toBe(false);
    expect(s?.outsideIndia).toBe(false);
    expect(s?.canBuy).toBe(true);
  });

  it("ON-IN now: the GST is carved out of the list price, which is what is charged", async () => {
    readingFor({ ...ON_IN, accountStateCode: "07" });
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    const s = await read();
    expect(s?.perPeriod).toMatchObject({
      listedPaise: 100_000,
      totalPaise: 100_000,
      rateBps: 1800,
      inclusive: true,
    });
    expect(s?.perPeriod?.taxPaise).toBeGreaterThan(0);
    expect(s?.nextPurchase?.totalPaise).toBe(50_000);
    expect(s?.nextPurchase?.taxPaise).toBeGreaterThan(0);
  });

  it("★ GST charged now with only StoreMink's own state: the state is needed now", async () => {
    readingFor(ON_EX);
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    const s = await read();
    expect(s?.needsState).toBe(true);
    expect(s?.outsideIndia).toBe(false);
  });

  it("★ GST charged now for a business outside India: the payment would be refused", async () => {
    readingFor({ ...ON_EX, signupCountry: "OTHER" });
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    const s = await read();
    expect(s?.outsideIndia).toBe(true);
    expect(s?.needsState).toBe(false);

    // GST not charged: nothing is refused.
    readingFor({ ...SNAPSHOT_ROW, signupCountry: "OTHER" });
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    expect((await read())?.outsideIndia).toBe(false);
  });

  it("★ nothing due now (the part period rounds to nothing): no purchase amount, no refusal now", async () => {
    readingFor(ON_EX);
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    const s = await read({ now: new Date(PERIOD_END) });
    expect(s?.nextPurchase).toBeNull();
    expect(s?.nextPurchaseInr).toBe(0);
    // No payment now, so only the renewal could need the state, and under
    // GST charged now it does.
    expect(s?.nextRenewal?.perLocation.totalPaise).toBe(118_000);
    expect(s?.needsState).toBe(true);
    expect(s?.outsideIndia).toBe(false);
  });

  it("★ a store that cannot buy gets the list price only: no purchase, no renewal read", async () => {
    readingFor(ON_EX);
    seed([[null], [{ n: 1 }]]);
    const s = await read();
    expect(s?.canBuy).toBe(false);
    expect(s?.perPeriod?.totalPaise).toBe(118_000);
    expect(s?.nextPurchase).toBeNull();
    expect(s?.nextRenewal).toBeNull();
    expect(s?.needsState).toBe(false);
    expect(s?.outsideIndia).toBe(false);
    // The subscription and the count; the renewal quote never read it again.
    expect(dbHolder.current.calls.select).toHaveLength(2);
  });

  it("★ a renewal that cannot be quoted is null, never a guess", async () => {
    seed([[subRow()], [{ n: 2 }], [subRow({ cancelAtPeriodEnd: true })]]);
    const s = await read();
    expect(s?.nextRenewal).toBeNull();
    expect(s?.perPeriod?.totalPaise).toBe(100_000);
  });

  it("★ incomplete GST settings refuse the purchase with the payment's own sentence", async () => {
    readingFor({ ...ON_EX, supplierGstin: null });
    seed([[subRow()], [{ n: 2 }]]);
    const s = await read();
    expect(s?.canBuy).toBe(false);
    expect(s?.blockedReason).toBe(PAYMENT_REFUSAL.settingsIncomplete);
    expect(s?.perPeriod).toBeUndefined();
    expect(s?.nextRenewal).toBeUndefined();
    // The fields an older bundle reads are still there.
    expect(s?.nextPurchaseInr).toBe(500);
    expect(logWarn).toHaveBeenCalledWith(
      "billing.locations.state_tax_settings_incomplete",
      expect.objectContaining({
        storeId: STORE,
        reason: "settings_incomplete",
      }),
    );
  });

  it("★ incomplete settings keep an earlier reason for not buying", async () => {
    readingFor({ ...ON_EX, supplierGstin: null });
    seed([[null], [{ n: 1 }]]);
    const s = await read();
    expect(s?.canBuy).toBe(false);
    expect(s?.blockedReason).toMatch(/subscri/i);
  });

  it("★ a tax reading that fails is a read failure: NULL", async () => {
    store.loadTaxSnapshot.mockRejectedValueOnce(new Error("db down"));
    seed([[subRow()], [{ n: 2 }]]);
    expect(await read()).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "billing.locations.state_tax_snapshot",
      expect.any(Error),
      { storeId: STORE },
    );
  });

  it("reads the tax terms at `now`, once, before the renewal", async () => {
    seed([[subRow()], [{ n: 2 }], [subRow()]]);
    await read();
    // Ours, then the renewal quote's own reading, both at `now`.
    expect(store.loadTaxSnapshot).toHaveBeenCalledTimes(2);
    for (const call of store.loadTaxSnapshot.mock.calls) {
      expect(call).toEqual([STORE, NOW]);
    }
  });
});

describe("startLocationPurchase", () => {
  const args = {
    storeId: STORE,
    store: PRO,
    requested: 2,
    locationPrice: PRICE,
    now: NOW,
  };

  it("prices the part period and opens an order", async () => {
    seed([[subRow()], [{ n: 2 }]]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      providerOrderId: "order_1",
      targetCount: 2,
    });
    // ₹1,000 × 15/30 = ₹500 = 50,000 paise.
    expect(store.createAddonInvoice.mock.calls[0][0].built.totalPaise).toBe(
      50_000,
    );
  });

  it("★★ records the TARGET COUNT on the invoice, not in the request", async () => {
    // confirm is a public action; reading the count from the client would let a
    // caller be granted more locations than it paid for.
    seed([[subRow()], [{ n: 2 }]]);
    await startLocationPurchase(args);
    expect(store.createAddonInvoice.mock.calls[0][0].targetCount).toBe(2);
  });

  it("★★ does NOT finalize — an unpaid addon must not burn a GST number", async () => {
    seed([[subRow()], [{ n: 2 }]]);
    await startLocationPurchase(args);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★★ grants NOTHING before payment", async () => {
    seed([[subRow()], [{ n: 2 }]]);
    await startLocationPurchase(args);
    // No write to billing_subscriptions on the start path.
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★★ refuses a RELEASE routed through the buy flow, and WRITES NOTHING", async () => {
    // Charging for a reduction is the worst confusion of the two — but the real
    // hazard is quieter: a reduction prorates to ₹0, so without this guard it
    // falls into the zero-amount branch and is applied IMMEDIATELY, bypassing the
    // scheduling that stops a merchant losing a shop they are still paying for.
    // Asserting only "no order was created" does not catch that.
    seed([[subRow({ billedLocations: 3 })], [{ n: 2 }], []]);
    const res = await startLocationPurchase({ ...args, requested: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/release flow/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★ refuses when it is already that number — an absolute count is idempotent", async () => {
    seed([[subRow({ billedLocations: 2 })], [{ n: 2 }]]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ refuses a store with no live subscription", async () => {
    seed([[subRow({ state: "free" })], [{ n: 2 }]]);
    expect((await startLocationPurchase(args)).ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ FAILS CLOSED on a read error", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/couldn't check/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ a ZERO part period grants it instead of charging ₹0", async () => {
    // At the very end of a cycle the proration rounds to nothing, and Razorpay
    // refuses a ₹0 order. The merchant gains a few hours; the next renewal bills
    // it in full.
    seed([
      [subRow({ currentPeriodEnd: NOW.toISOString() })],
      [{ n: 2 }],
      [], // the write
    ]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/next renewal/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    // It WAS granted.
    expect(dbHolder.current.calls.set[0].billedLocations).toBe(2);
  });

  it("★★ refuses when the next renewal would exceed the authorised mandate", async () => {
    // Razorpay would accept this and fail the DEBIT weeks later, surfacing as a
    // halted subscription rather than "you can't buy this".
    seed([
      [subRow({ mandateId: "mand-1" })],
      [{ n: 2 }],
      [{ maxAmountPaise: 100_00 }], // ₹100 ceiling, target is ₹2,000
    ]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/autopay limit/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ includes the base plan in the mandate ceiling, not only locations", async () => {
    // Pro ₹5,000 + two locations ₹2,000 = ₹7,000. The old check compared only
    // ₹2,000 and incorrectly approved this ₹2,500 mandate.
    seed([
      [subRow({ mandateId: "mand-1" })],
      [{ n: 2 }],
      [{ maxAmountPaise: 250_000 }],
    ]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/autopay limit/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ includes exclusive GST in the mandate ceiling", async () => {
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true, accountStateCode: "27" });
    // Listed renewal is ₹7,000 but the actual debit is ₹8,260 with GST.
    seed([
      [subRow({ mandateId: "mand-1" })],
      [{ n: 2 }],
      [{ maxAmountPaise: 700_000 }],
    ]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/autopay limit/i);
  });

  it("★ a comfortable ceiling does not block the sale", async () => {
    seed([
      [subRow({ mandateId: "mand-1" })],
      [{ n: 2 }],
      [{ maxAmountPaise: 50_000_00 }],
    ]);
    expect((await startLocationPurchase(args)).ok).toBe(true);
  });

  it("★ NO mandate means manual renewal, which has no ceiling — silent, not refused", async () => {
    seed([[subRow({ mandateId: null })], [{ n: 2 }]]);
    expect((await startLocationPurchase(args)).ok).toBe(true);
  });

  it("★★ fails closed when an active mandate has no recorded ceiling", async () => {
    seed([[subRow({ mandateId: "mand-1" })], [{ n: 2 }], []]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/limit is unavailable/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ an UNKNOWN order outcome leaves the attempt in flight, not failed", async () => {
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    seed([[subRow()], [{ n: 2 }]]);
    await startLocationPurchase(args);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "unknown",
      expect.anything(),
    );
  });
});

describe("confirmLocationPurchase", () => {
  const args = {
    storeId: STORE,
    invoiceId: "inv-1",
    providerPaymentId: "pay_1",
    signature: "sig",
    now: NOW,
  };

  /** The confirm's reads, then the completion's facts, then the claim. */
  function seedConfirm(target: number | null = 2) {
    seedComplete({ target });
  }

  it("★★ R1-07: issues at the payment's own time, from the gateway's record", async () => {
    const CAPTURED_SECONDS = Math.floor(NOW.getTime() / 1000) - 600;
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: true,
      data: { id: "pay_1", created_at: CAPTURED_SECONDS },
    });
    seedConfirm();
    const res = await confirmLocationPurchase(args);
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
    const res = await confirmLocationPurchase(args);
    expect(res.ok).toBe(true);
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW, undefined);
    expect(logWarn).toHaveBeenCalledWith("billing.locations.payment_time", {
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
    await confirmLocationPurchase(args);
    expect(rzp.rzpFetchPayment).not.toHaveBeenCalled();
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW, undefined);
  });

  it("★★ FINALIZES BEFORE SETTLING — settling a DRAFT leaves a paid invoice unpaid", async () => {
    // Same regression as confirmEnrolment, same cause, same cost. See the note
    // in lib/billing/enrol.ts: `syncInvoiceStatus` can only claim the move to
    // paid from "open" or "processing", so settling while the invoice is still a
    // DRAFT captures the money and leaves an unpaid invoice behind it — silently.
    seedConfirm();
    await confirmLocationPurchase(args);
    expect(store.finalizeInvoice).toHaveBeenCalled();
    expect(collect.settleAttempt).toHaveBeenCalled();
    expect(store.finalizeInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      collect.settleAttempt.mock.invocationCallOrder[0],
    );
  });

  it("grants the count recorded on the invoice", async () => {
    seedConfirm(2);
    const res = await confirmLocationPurchase(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.billedLocations).toBe(2);
    expect(dbHolder.current.calls.set[0].billedLocations).toBe(2);
  });

  it("★★ REFUSES an unverified signature and grants nothing", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedConfirm();
    const res = await confirmLocationPurchase(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★ verifies against the order WE created", async () => {
    seedConfirm();
    await confirmLocationPurchase(args);
    expect(rzp.verifyCheckoutSignature).toHaveBeenCalledWith(
      "secret",
      "order_1",
      "pay_1",
      "sig",
    );
  });

  it("★ issues the document only once it has really been paid", async () => {
    seedConfirm();
    await confirmLocationPurchase(args);
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW, undefined);
  });

  it("★ refuses an invoice with no recorded target", async () => {
    seedConfirm(null);
    const res = await confirmLocationPurchase(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ refuses when there is no payment to confirm", async () => {
    seed([[{ target: 2 }], []]);
    expect((await confirmLocationPurchase(args)).ok).toBe(false);
  });

  it("★★ money IN but the grant failed is never a bare failure", async () => {
    seedConfirm(2);
    dbHolder.current.db.update = () => {
      throw new Error("db down");
    };
    const res = await confirmLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/don't pay again/i);
  });

  it("★ clears any booked release — buying means they want the shops", async () => {
    seedConfirm(2);
    await confirmLocationPurchase(args);
    expect(dbHolder.current.calls.set[0].scheduledLocations).toBeNull();
  });

  it("★★ the raise is a CLAIM: live, same cycle, still below the target", async () => {
    seedConfirm(2);
    await confirmLocationPurchase(args);
    const where = dbHolder.current.calls.where
      .map((w: unknown) => render(w))
      .find((w: { sql: string }) =>
        w.sql.includes('"billing_subscriptions"."billed_locations" <'),
      );
    expect(where).toBeDefined();
    if (!where) return;
    expect(where.sql).toContain(
      '"billing_subscriptions"."current_cycle_seq" =',
    );
    expect(where.params).toEqual(expect.arrayContaining([STORE, 3, 2]));
  });

  it("★★ a confirm after the purchase was finished changes nothing", async () => {
    seedComplete({
      target: 2,
      invoiceStatus: "paid",
      attemptState: "captured",
      claimed: false,
      after: subRow({ billedLocations: 2 }),
    });
    collect.settleAttempt.mockResolvedValue(null);
    const res = await confirmLocationPurchase(args);
    expect(res).toEqual({ ok: true, data: { billedLocations: 2 } });
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });
});

/** A Drizzle condition, as Postgres would receive it. */
function render(query: unknown) {
  const q = new PgDialect().sqlToQuery(query as any);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

/**
 * The completion's reads, by table: (unless `recovery`) the confirm's own
 * target and attempt reads, then invoice, attempt, store and subscription,
 * then the loser's re-read.
 */
function seedComplete(
  opts: {
    target?: number | null;
    recovery?: boolean;
    invoiceStatus?: string;
    attemptState?: string;
    sub?: Record<string, unknown>;
    claimed?: boolean;
    after?: Record<string, unknown>;
    invoiceCreatedAt?: string;
  } = {},
) {
  const target = opts.target === undefined ? 2 : opts.target;
  dbHolder.current = makeDbMock({
    selectByTable: {
      billing_invoices: [
        ...(opts.recovery ? [] : [[{ target }]]),
        [
          {
            storeId: STORE,
            kind: "addon",
            status: opts.invoiceStatus ?? "draft",
            addonTargetCount: target,
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
                  amountPaise: 50_000,
                },
              ],
            ]),
        [
          {
            id: "att-1",
            invoiceId: "inv-1",
            storeId: STORE,
            state: opts.attemptState ?? "processing",
            amountPaise: 50_000,
            currency: "INR",
            providerOrderId: "order_1",
            providerPaymentId: null,
          },
        ],
      ],
      stores: [[{ id: STORE }]],
      billing_subscriptions: [
        [
          {
            state: "active",
            plan: "pro",
            billedLocations: 1,
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

describe("completeLocationPurchase (recovery, RC-F1b)", () => {
  const recovery = {
    storeId: STORE,
    invoiceId: "inv-1",
    attemptId: "att-1",
    providerPaymentId: null,
    source: "recovery" as const,
    verifyCapture: true,
    now: NOW,
  };

  it("★★ finishes a closed-tab purchase: issues, settles, raises to the INVOICE's count", async () => {
    seedComplete({ recovery: true, attemptState: "captured" });
    const res = await completeLocationPurchase(recovery);
    expect(res).toEqual({ status: "completed", data: { billedLocations: 2 } });
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW, undefined);
    expect(dbHolder.current.calls.set[0].billedLocations).toBe(2);
  });

  it("★ issues the draft at the capture time it is given (GST paidAt)", async () => {
    seedComplete({ recovery: true, attemptState: "captured" });
    const paidAt = new Date(NOW.getTime() - 2 * 3_600_000);
    const res = await completeLocationPurchase({ ...recovery, paidAt });
    expect(res.status).toBe("completed");
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW, paidAt);
  });

  it("★★ a captured amount that differs is filed, never applied", async () => {
    seedComplete({ recovery: true, attemptState: "captured" });
    collect.verifyRecoveredCapture.mockResolvedValue({
      status: "mismatch",
      reason: "the captured amount or currency differs from the attempt",
      paymentId: "pay_old",
      observedPaise: 1_00,
    });
    const res = await completeLocationPurchase(recovery);
    expect(res.status).toBe("refused");
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "amount_mismatch",
        purchase: "locations",
        repairKey: "purchase_refused:att-1",
      }),
    );
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★ a plan that no longer includes locations is filed", async () => {
    seedComplete({
      recovery: true,
      attemptState: "captured",
      sub: { plan: "basic" },
    });
    const res = await completeLocationPurchase(recovery);
    expect(res.status).toBe("refused");
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.stringMatching(/no longer includes extra locations/),
      }),
    );
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★ a draft whose count was reached another way is filed", async () => {
    seedComplete({
      recovery: true,
      attemptState: "captured",
      sub: { billedLocations: 2 },
    });
    const res = await completeLocationPurchase(recovery);
    expect(res.status).toBe("refused");
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★ a purchase from an earlier cycle is filed", async () => {
    seedComplete({
      recovery: true,
      attemptState: "captured",
      invoiceCreatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect((await completeLocationPurchase(recovery)).status).toBe("refused");
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });
});

describe("startLocationPurchase finishes an earlier paid purchase (RC-F1b)", () => {
  const args = {
    storeId: STORE,
    store: PRO,
    requested: 3,
    locationPrice: PRICE,
    now: NOW,
  };
  const earlier = {
    attemptId: "att-1",
    invoiceId: "inv-1",
    storeId: STORE,
    kind: "addon",
    providerOrderId: "order_1",
    providerPaymentId: "pay_old",
    amountPaise: 50_000,
    currency: "INR",
    createdAt: NOW.toISOString(),
  };

  it("★★ completes it instead of opening a second order", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([earlier]);
    seedComplete({ recovery: true, attemptState: "captured" });
    const res = await startLocationPurchase(args);
    expect(res).toEqual({ ok: false, error: LOCATIONS_RECOVERED_MESSAGE });
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(store.createAddonInvoice).not.toHaveBeenCalled();
  });

  it("★★ when it cannot be finished, says the payment went through and opens nothing", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([earlier]);
    seedComplete({ recovery: true, attemptState: "captured" });
    collect.verifyRecoveredCapture.mockResolvedValue({ status: "unreadable" });
    const res = await startLocationPurchase(args);
    expect(res).toEqual({
      ok: false,
      error: LOCATIONS_RECOVERY_WAITING_MESSAGE,
    });
    expect(LOCATIONS_RECOVERY_WAITING_MESSAGE).toMatch(/don't pay again/);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ fails CLOSED when the earlier purchases can't be read", async () => {
    collect.capturedDraftPurchases.mockResolvedValue(null);
    const res = await startLocationPurchase(args);
    expect(res).toEqual({
      ok: false,
      error: "Couldn't check your subscription. Try again.",
    });
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ an earlier PLAN CHANGE is not this flow's to finish", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([earlier]);
    collect.readAddonOrderTarget.mockResolvedValue({
      kind: "plan_change",
      plan: "pro",
      period: "yearly",
    });
    seed([[subRow()], [{ n: 2 }]]);
    await startLocationPurchase(args);
    // It went on to the ordinary purchase path rather than finishing a plan
    // change through the location flow.
    expect(collect.fileRecoveredPurchase).not.toHaveBeenCalled();
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });
});

describe("releaseLocations", () => {
  const args = { storeId: STORE, store: PRO, requested: 0, now: NOW };

  /** sub, location count, then the next-invoice probe (empty = not issued). */
  function seedRelease(sub = subRow(), locations = 2) {
    seed([[sub], [{ n: locations }], [], []]);
  }

  it("★★ SCHEDULES it — never immediate, and never refunded", async () => {
    seedRelease(subRow({ billedLocations: 1 }), 2);
    const res = await releaseLocations(args);
    expect(res.ok).toBe(true);
    // The LIVE count is untouched; only the schedule moves.
    const set = dbHolder.current.calls.set[0];
    expect(set.scheduledLocations).toBe(0);
    expect(set.billedLocations).toBeUndefined();
  });

  it("★ reports when it takes effect", async () => {
    seedRelease(subRow({ billedLocations: 1 }), 2);
    const res = await releaseLocations(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.effectiveAt).toBe(PERIOD_END);
  });

  it("★ cancels a booked release when asked for the current count", async () => {
    seedRelease(subRow({ billedLocations: 2, scheduledLocations: 1 }), 2);
    const res = await releaseLocations({ ...args, requested: 2 });
    expect(res.ok).toBe(true);
    expect(dbHolder.current.calls.set[0].scheduledLocations).toBeNull();
  });

  it("★★ REFUSES inside the collection window, because that invoice is issued", async () => {
    // Applying it at the turn against an invoice priced at the OLD count charges
    // a full extra cycle for a shop that is gone.
    seed([
      [subRow({ billedLocations: 1 })],
      [{ n: 2 }],
      [{ id: "inv-next" }], // the next cycle's invoice already exists
    ]);
    const res = await releaseLocations(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already been issued/i);
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★★ FAILS TOWARD REFUSING when it cannot tell whether the invoice exists", async () => {
    seed([[subRow({ billedLocations: 1 })], [{ n: 2 }]]);
    let calls = 0;
    const realSelect = dbHolder.current.db.select;
    dbHolder.current.db.select = (...a: any[]) => {
      calls += 1;
      if (calls === 3) throw new Error("db down");
      return realSelect(...a);
    };
    const res = await releaseLocations(args);
    expect(res.ok).toBe(false);
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★ refuses releasing below what is IN USE", async () => {
    // Soft-on-downgrade: never delete a merchant's shop on their behalf.
    seedRelease(subRow({ billedLocations: 2 }), 4);
    const res = await releaseLocations(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/using/i);
  });

  it("★ refuses an increase routed through the release flow", async () => {
    seedRelease(subRow({ billedLocations: 1 }), 2);
    const res = await releaseLocations({ ...args, requested: 3 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/buy flow/i);
  });
});

describe("startLocationPurchase reads the tax once (GST Stage 7)", () => {
  const args = {
    storeId: STORE,
    store: PRO,
    requested: 2,
    locationPrice: PRICE,
    now: NOW,
  };

  function expectNothingWritten() {
    expect(store.createAddonInvoice).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
  }

  it("★ builds the part period with the reading's GST and stamps it", async () => {
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true, accountStateCode: "29" });
    seed([[subRow()], [{ n: 2 }]]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(true);
    const arg = store.createAddonInvoice.mock.calls[0][0];
    // ₹500 + 18% exclusive.
    expect(arg.built).toMatchObject({ taxPaise: 9_000, totalPaise: 59_000 });
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
    seed([[subRow()], [{ n: 2 }]]);
    expect(await startLocationPurchase(args)).toEqual({
      ok: false,
      error: PAYMENT_REFUSAL.invoiceFailed,
    });
    expectNothingWritten();
    expect(logError).toHaveBeenCalledWith(
      "billing.locations.tax_snapshot",
      expect.any(Error),
      { storeId: STORE },
    );
  });

  it("GST on without StoreMink's full tax identity", async () => {
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true, supplierStateCode: null });
    seed([[subRow()], [{ n: 2 }]]);
    expect(await startLocationPurchase(args)).toEqual({
      ok: false,
      error: PAYMENT_REFUSAL.settingsIncomplete,
    });
    expectNothingWritten();
  });

  it("★ GST on and no state of the merchant anywhere", async () => {
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true });
    seed([[subRow()], [{ n: 2 }]]);
    expect(await startLocationPurchase(args)).toEqual({
      ok: false,
      error: PAYMENT_REFUSAL.needsState,
    });
    expectNothingWritten();
  });

  it("★ GST on and a business outside India", async () => {
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true, accountCountry: "US" });
    seed([[subRow()], [{ n: 2 }]]);
    expect(await startLocationPurchase(args)).toEqual({
      ok: false,
      error: PAYMENT_REFUSAL.outsideIndia,
    });
    expectNothingWritten();
  });

  it("★ a ZERO part period is granted without a reading", async () => {
    readingFor({ ...SNAPSHOT_ROW, taxEnabled: true }); // would refuse
    seed([[subRow({ currentPeriodEnd: NOW.toISOString() })], [{ n: 2 }], []]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/next renewal/i);
    expect(store.loadTaxSnapshot).not.toHaveBeenCalled();
  });

  describe("★★ the ceiling prices the renewal under ITS terms", () => {
    // Pro monthly with 2 extra locations renews at ₹7,000 untaxed. GST off
    // today, an exclusive 18% start scheduled: if it starts before the renewal
    // is collected (from 12 Sep, four days before the cycle ends on 16 Sep),
    // the debit is ₹8,260 and a ₹7,500 mandate cannot take it.
    const scheduledFrom = (startsAt: string): SnapshotRow => ({
      ...SNAPSHOT_ROW,
      accountStateCode: "29",
      nextTaxEnabled: true,
      nextTaxInclusive: false,
      nextTaxRateBps: 1800,
      nextTaxStartsAt: startsAt,
    });
    const withMandate = () =>
      seed([
        [subRow({ mandateId: "mand-1" })],
        [{ n: 2 }],
        [{ maxAmountPaise: 750_000 }],
      ]);

    it("★★ a start before the renewal is collected is refused", async () => {
      readingFor(scheduledFrom("2026-09-10T00:00:00.000Z"));
      withMandate();
      const res = await startLocationPurchase(args);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/autopay limit/i);
      expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    });

    it("control: a start after the renewal is collected is allowed", async () => {
      readingFor(scheduledFrom("2026-09-14T00:00:00.000Z"));
      withMandate();
      const res = await startLocationPurchase(args);
      expect(res.ok).toBe(true);
      // The part period itself is charged under today's terms: no GST.
      expect(store.createAddonInvoice.mock.calls[0][0].built.totalPaise).toBe(
        50_000,
      );
    });
  });
});

describe("completeLocationPurchase: a failed issue (GST Stage 7)", () => {
  it("★ is logged, and nothing is settled or applied", async () => {
    seedComplete({ recovery: true, attemptState: "captured" });
    store.finalizeInvoice.mockResolvedValue(null);
    const res = await completeLocationPurchase({
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
      purchase: "locations",
      source: "recovery",
      storeId: STORE,
      invoiceId: "inv-1",
      attemptId: "att-1",
    });
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });
});
