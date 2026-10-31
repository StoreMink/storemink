/* eslint-disable @typescript-eslint/no-explicit-any */
// The numbers a merchant is shown before they pay (GST design 5.6).
//
// ── The risk this covers ───────────────────────────────────────────────────
//   A quote that differs from the charge. The dialog says one amount, the
//   payment window asks for another, and the merchant is right to stop
//   trusting both. So the main tests here run the REAL starts
//   (`startEnrolment`, `startPlanChange`) beside the quotes with the same
//   inputs and compare what each would take, in every GST state: off, on with
//   prices including it, on with prices excluding it, and a switch-on still
//   scheduled, before and after its instant.
//
//   The renewal is compared with what the renewal worker builds: the same
//   builder under the tax reading taken when its invoice is issued.
//
// ── The gateway is never reached ───────────────────────────────────────────
//   Every Razorpay call is mocked to THROW unless a test says otherwise, so a
//   quote that reached the gateway fails loudly instead of passing quietly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import { resolveTaxSnapshot, type SnapshotRow } from "./tax-snapshot";
import { PAYMENT_REFUSAL } from "./tax-copy";
import {
  buildAddonInvoice,
  buildAiCreditsInvoice,
  buildSubscriptionInvoice,
} from "./invoice";
import { collectionStartsAt, cycleFrom } from "./cycle";
import { PLAN_META, type Plan } from "@/lib/plans";
import { extraLocationPaise } from "@/lib/plans/location-billing";

const S = vi.hoisted(() => ({
  /** Rows per table name; a read returns them whatever its WHERE says. */
  tables: {} as Record<string, unknown[]>,
  /** Tables whose reads fail. */
  failTables: new Set<string>(),
  db: null as any,
  creds: { keyId: "rzp_test_1", keySecret: "secret" } as any,
  recurringVerified: true,
  /** Invoices by cycle number, for `getCycleInvoice`. */
  invoicesBySeq: {} as Record<number, any>,
  /** What the starts priced, in call order. */
  built: [] as any[],
  /** The invoice the enrolment's `ensureRenewalInvoice` hands back, if not fresh. */
  enrolmentInvoice: null as any,
}));

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(S.db)),
}));

const provider = vi.hoisted(() => ({
  getPlatformRazorpayCreds: vi.fn(),
}));
vi.mock("@/lib/payments/provider", () => provider);

/** Every gateway call throws unless a test resolves it on purpose. */
const rzp = vi.hoisted(() => {
  const refuse = (name: string) =>
    vi.fn<(...args: any[]) => Promise<any>>(async () => {
      throw new Error(`network: ${name} was called`);
    });
  return {
    rzpCreateOrder: refuse("rzpCreateOrder"),
    rzpCreateAuthorizationOrder: refuse("rzpCreateAuthorizationOrder"),
    rzpFetchOrder: refuse("rzpFetchOrder"),
    rzpFetchOrderPayments: refuse("rzpFetchOrderPayments"),
    rzpCreateCustomer: refuse("rzpCreateCustomer"),
    rzpFetchPayment: refuse("rzpFetchPayment"),
    verifyCapturedCheckoutPayment: refuse("verifyCapturedCheckoutPayment"),
    verifyCheckoutSignature: vi.fn<(...args: any[]) => boolean>(() => {
      throw new Error("network: verifyCheckoutSignature was called");
    }),
  };
});
vi.mock("@/lib/payments/razorpay", () => rzp);

const mail = vi.hoisted(() => ({ resolveBillingEmail: vi.fn() }));
vi.mock("@/lib/email/billing-emails", () => mail);

const store = vi.hoisted(() => ({
  loadTaxSnapshot: vi.fn(),
  getCycleInvoice: vi.fn(),
  ensureRenewalInvoice: vi.fn(),
  reshapeDraftSubscriptionInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
  amountDueForInvoice: vi.fn(),
  getInvoice: vi.fn(),
  createAddonInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => store);

const collect = vi.hoisted(() => ({
  beginAttempt: vi.fn(),
  settleAttempt: vi.fn(),
  capturedDraftPurchases: vi.fn(),
  capturedAttemptForInvoice: vi.fn(),
  fileRecoveredPurchase: vi.fn(),
  verifyRecoveredCapture: vi.fn(),
  // Reads an order's notes at the gateway: refused unless a test stubs it.
  readAddonOrderTarget: vi.fn<(...args: any[]) => Promise<any>>(async () => {
    throw new Error("network: readAddonOrderTarget was called");
  }),
}));
vi.mock("./collect", () => collect);

vi.mock("./gateway", () => ({
  get RECURRING_CHARGE_VERIFIED() {
    return S.recurringVerified;
  },
}));

vi.mock("./receipts", () => ({ notifyPlanActivated: vi.fn() }));

const packs = vi.hoisted(() => ({ getMinkCreditPackLive: vi.fn() }));
vi.mock("@/lib/ai/credit-pricing", () => packs);

import { startEnrolment } from "./enrol";
import { planChangeTerms, startPlanChange } from "./plan-change";
import {
  quoteCheckoutFor,
  quoteLocationRenewal,
  quoteNextRenewal,
  quoteOf,
  quotePlanChange,
  quoteSubscribe,
} from "./quote";

/** A database whose reads return each table's rows and whose writes succeed. */
function fakeDb() {
  const select = () => {
    let name = "";
    const s: any = {
      from(table: any) {
        name = getTableName(table);
        return s;
      },
      where: () => s,
      leftJoin: () => s,
      innerJoin: () => s,
      orderBy: () => s,
      groupBy: () => s,
      limit: () => s,
      for: () => s,
      then(resolve: any, reject: any) {
        if (S.failTables.has(name)) {
          return Promise.reject(new Error(`read of ${name} failed`)).then(
            resolve,
            reject,
          );
        }
        return Promise.resolve(S.tables[name] ?? []).then(resolve, reject);
      },
    };
    return s;
  };
  const write = (): any => {
    const w: any = {
      values: () => w,
      set: () => w,
      where: () => w,
      onConflictDoUpdate: () => w,
      onConflictDoNothing: () => w,
      returning: async () => [{ id: "row-1" }],
      then: (resolve: any, reject: any) =>
        Promise.resolve({ rowCount: 1 }).then(resolve, reject),
    };
    return w;
  };
  return {
    select,
    insert: write,
    update: write,
    delete: write,
    execute: async () => ({ rows: [] }),
  };
}

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
/** After a scheduled switch-on (GST_STARTS). */
const AFTER = new Date("2026-09-20T00:00:00.000Z");
const GST_STARTS = "2026-09-15T00:00:00.000Z";
/** Half of a plan change's 30-day cycle left at NOW. */
const PERIOD_END = "2026-09-16T00:00:00.000Z";

const PLAN_PAISE: Record<string, Record<string, number>> = {
  basic: { monthly: 1_500_00, yearly: 15_000_00 },
  pro: { monthly: 5_000_00, yearly: 50_000_00 },
};
const LOCATION_PRICE = { monthlyInr: 1000, yearlyInr: 10000 };
const priceFor = vi.fn(async (plan: Plan, period: "monthly" | "yearly") => ({
  planPaise: PLAN_PAISE[plan][period],
  locationPaise: extraLocationPaise(period, LOCATION_PRICE),
}));

/** StoreMink's identity complete; the merchant in Karnataka (29). */
const BASE: SnapshotRow = {
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
  accountStateCode: "29",
  accountCountry: null,
  taxIdGstin: null,
  storeTaxStateCode: null,
  locationGstin: null,
  locationStateCode: null,
  taxAddress: null,
  signupStateName: null,
  signupCountry: null,
};

const STATES: Record<string, SnapshotRow> = {
  OFF: BASE,
  "ON-IN": { ...BASE, taxEnabled: true, taxInclusive: true },
  "ON-EX": { ...BASE, taxEnabled: true },
  "SCHED-EX": {
    ...BASE,
    nextTaxEnabled: true,
    nextTaxInclusive: false,
    nextTaxRateBps: 1800,
    nextTaxStartsAt: GST_STARTS,
  },
};

/** The same records with no state anywhere. */
const NO_STATE = { accountStateCode: null };

let row: SnapshotRow = BASE;

function reading(r: SnapshotRow) {
  row = r;
}

/** A live subscription, as every subscription read sees it. */
function liveSub(over: Record<string, unknown> = {}) {
  return {
    state: "active",
    plan: "basic",
    period: "monthly",
    billedLocations: 0,
    scheduledPlan: null,
    scheduledPeriod: null,
    scheduledLocations: null,
    cancelAtPeriodEnd: false,
    cycleSeq: 3,
    currentPeriodEnd: PERIOD_END,
    mandateId: null,
    ...over,
  };
}

const ACTIVE_MANDATE = { status: "active", maxAmountPaise: 50_000_00 };

beforeEach(() => {
  S.tables = {};
  S.failTables = new Set();
  S.db = fakeDb();
  S.recurringVerified = true;
  S.invoicesBySeq = {};
  S.built = [];
  S.enrolmentInvoice = null;
  row = BASE;

  provider.getPlatformRazorpayCreds.mockImplementation(() => S.creds);
  mail.resolveBillingEmail.mockResolvedValue({
    email: "owner@acme.test",
    phone: "9876543210",
    storeName: "Acme",
    slug: "acme",
  });
  store.loadTaxSnapshot.mockImplementation(async (_s: string, at: Date) =>
    resolveTaxSnapshot(row, at),
  );
  store.getCycleInvoice.mockImplementation(
    async (_s: string, seq: number) => S.invoicesBySeq[seq] ?? null,
  );
  store.ensureRenewalInvoice.mockImplementation(async (args: any) => {
    S.built.push(args.built);
    return (
      S.enrolmentInvoice ?? {
        id: "inv-1",
        status: "draft",
        finalizedAt: null,
        invoiceRef: null,
        totalPaise: args.built.totalPaise,
        periodStart: args.periodStart.toISOString(),
        periodEnd: args.periodEnd.toISOString(),
      }
    );
  });
  store.reshapeDraftSubscriptionInvoice.mockResolvedValue(null);
  store.createAddonInvoice.mockImplementation(async (args: any) => {
    S.built.push(args.built);
    return { id: "inv-add", totalPaise: args.built.totalPaise };
  });
  // What is due is the invoice's own total: no account credit in these tests.
  store.amountDueForInvoice.mockImplementation(async (id: string) =>
    id === "inv-add"
      ? S.built[S.built.length - 1].totalPaise
      : (S.enrolmentInvoice?.totalPaise ??
        S.built[S.built.length - 1].totalPaise),
  );
  collect.capturedDraftPurchases.mockResolvedValue([]);
  collect.capturedAttemptForInvoice.mockResolvedValue(null);
  collect.beginAttempt.mockResolvedValue({
    attemptId: "att-1",
    idempotencyKey: "key-1",
  });
  collect.settleAttempt.mockResolvedValue("processing");
  packs.getMinkCreditPackLive.mockResolvedValue(null);
});

/** The gateway calls a START makes; a quote never needs them. */
function openGateway() {
  rzp.rzpCreateCustomer.mockResolvedValue({ ok: true, data: { id: "cust_1" } });
  rzp.rzpCreateAuthorizationOrder.mockResolvedValue({
    ok: true,
    data: { id: "order_auth" },
  });
  rzp.rzpCreateOrder.mockResolvedValue({ ok: true, data: { id: "order_1" } });
}

function noGatewayCalls() {
  for (const fn of Object.values(rzp)) expect(fn).not.toHaveBeenCalled();
}

/** A quote may READ an order (the start's own question, R1-03), but never
 *  creates anything at the gateway. */
function noGatewayWrites() {
  expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
  expect(rzp.rzpCreateCustomer).not.toHaveBeenCalled();
}

// ── quoteOf ────────────────────────────────────────────────────────────────

describe("quoteOf", () => {
  it("prices excluding GST: the list price is what GST is charged on", () => {
    const tax = resolveTaxSnapshot(STATES["ON-EX"], NOW);
    if (!tax.ok) throw new Error("reading");
    const built = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: tax.tax,
    });
    expect(quoteOf(built)).toEqual({
      listedPaise: 5_000_00,
      taxablePaise: 5_000_00,
      taxPaise: 900_00,
      totalPaise: 5_900_00,
      rateBps: 1800,
      inclusive: false,
    });
  });

  it("prices including GST: the GST is carved out of the list price", () => {
    const tax = resolveTaxSnapshot(STATES["ON-IN"], NOW);
    if (!tax.ok) throw new Error("reading");
    const built = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: tax.tax,
    });
    const q = quoteOf(built);
    expect(q.listedPaise).toBe(5_000_00);
    expect(q.totalPaise).toBe(5_000_00);
    expect(q.taxablePaise + q.taxPaise).toBe(5_000_00);
    expect(q.inclusive).toBe(true);
  });
});

// ── Subscribe ──────────────────────────────────────────────────────────────

describe("quoteSubscribe: the quote is the charge", () => {
  const combos: Array<[string, Date, "monthly" | "yearly"]> = [];
  for (const state of Object.keys(STATES)) {
    for (const now of [NOW, AFTER]) {
      for (const period of ["monthly", "yearly"] as const) {
        combos.push([state, now, period]);
      }
    }
  }

  it.each(combos)(
    "%s at %s, %s: pay-now and renewal match the start and the worker",
    async (state, now, period) => {
      reading(STATES[state]);
      const quoted = await quoteSubscribe({
        storeId: STORE,
        plan: "pro",
        period,
        priceFor,
        now,
      });
      noGatewayCalls();
      if (!quoted.ok) throw new Error(quoted.error);
      const q = quoted.quote;

      openGateway();
      const started = await startEnrolment({
        storeId: STORE,
        plan: "pro",
        period,
        priceFor,
        now,
      });
      if (!started.ok) throw new Error(started.error);

      // ★ What the payment window asks for.
      expect(q.payNow?.totalPaise).toBe(started.data.amountPaise);
      // ★ And the invoice behind it, line for line.
      expect(q.payNow).toEqual(quoteOf(S.built[0]));
      expect(q.resumed).toBe(false);
      expect(q.earlierPayment).toBe(false);

      // ★ The first renewal, as the worker builds it at its issue instant.
      const cycle = cycleFrom(now, period, 1);
      const issuedAt = collectionStartsAt(cycle.end);
      const worker = resolveTaxSnapshot(STATES[state], issuedAt);
      if (!worker.ok) throw new Error("reading");
      const renewal = buildSubscriptionInvoice({
        planLabel: PLAN_META.pro.name,
        period,
        planPaise: PLAN_PAISE.pro[period],
        tax: worker.tax,
      });
      expect(q.renewal?.amount).toEqual(quoteOf(renewal));
      expect(q.renewal?.issuedAt).toBe(issuedAt.toISOString());
      expect(q.renewal?.renewsOn).toBe(cycle.end.toISOString());
      expect(q.renewal?.autopay).toBe(started.data.autopay);

      const terms = resolveTaxSnapshot(STATES[state], now);
      if (!terms.ok) throw new Error("reading");
      expect(q.terms).toEqual(terms.terms);
      expect(q.needsState).toBe(false);
      expect(q.outsideIndia).toBe(false);
    },
  );

  it("★ a scheduled switch-on: nothing now, GST at the renewal", async () => {
    reading(STATES["SCHED-EX"]);
    const quoted = await quoteSubscribe({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    if (!quoted.ok) throw new Error(quoted.error);
    expect(quoted.quote.payNow?.taxPaise).toBe(0);
    expect(quoted.quote.renewal?.amount.taxPaise).toBe(900_00);
  });

  it("★★ resumes the order already open (and touched) on the cycle's draft, at its total", async () => {
    // GST started (exclusive) after an earlier Subscribe opened an order on
    // the draft at ₹5,000, and a payment is still in the merchant's app. The
    // start keeps that order and the issue carves the GST out of it, so
    // ₹5,000 is what is taken, not ₹5,900.
    reading(STATES["ON-EX"]);
    const cycle = cycleFrom(NOW, "monthly", 1);
    const draft = {
      id: "inv-old",
      storeId: STORE,
      kind: "subscription",
      status: "draft",
      totalPaise: 5_000_00,
      bodyTotalPaise: 5_000_00,
      taxPaise: 0,
      taxRateBps: 0,
      taxInclusive: false,
      cycleSeq: 1,
      invoiceRef: null,
      finalizedAt: null,
      periodStart: cycle.start.toISOString(),
      periodEnd: cycle.end.toISOString(),
    };
    S.invoicesBySeq[1] = draft;
    S.enrolmentInvoice = draft;
    S.tables.billing_payment_attempts = [
      {
        id: "att-live",
        providerOrderId: "order_old",
        amountPaise: 5_000_00,
        mandateMaxPaise: 9_000_00,
      },
    ];

    // The quote asks the gateway the start's own question (R1-03): is the
    // order one nobody touched? It reads, never writes.
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "upi",
        status: "attempted",
        attempts: 1,
      },
    });
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [{ id: "pay_1", status: "created" }],
    });
    const quoted = await quoteSubscribe({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    noGatewayWrites();
    if (!quoted.ok) throw new Error(quoted.error);

    openGateway();
    collect.beginAttempt.mockResolvedValue(null);
    const started = await startEnrolment({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    if (!started.ok) throw new Error(started.error);
    expect(started.data.amountPaise).toBe(5_000_00);
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();

    const q = quoted.quote;
    expect(q.resumed).toBe(true);
    expect(q.payNow?.totalPaise).toBe(started.data.amountPaise);
    // The GST the issue will carve out of the frozen ₹5,000.
    const snap = resolveTaxSnapshot(STATES["ON-EX"], NOW);
    if (!snap.ok) throw new Error("reading");
    const carved = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: { ...snap.tax, inclusive: true },
    });
    expect(q.payNow?.taxPaise).toBe(carved.taxPaise);
    expect(q.payNow?.inclusive).toBe(true);
  });

  it("★★ R1-03: an UNTOUCHED order on the draft is abandoned by the start, so the quote is the fresh total the start charges", async () => {
    reading(STATES["ON-EX"]);
    const cycle = cycleFrom(NOW, "monthly", 1);
    const draft = {
      id: "inv-old",
      storeId: STORE,
      kind: "subscription",
      status: "draft",
      totalPaise: 5_000_00,
      bodyTotalPaise: 5_000_00,
      taxPaise: 0,
      taxRateBps: 0,
      taxInclusive: false,
      cycleSeq: 1,
      invoiceRef: null,
      finalizedAt: null,
      periodStart: cycle.start.toISOString(),
      periodEnd: cycle.end.toISOString(),
    };
    S.invoicesBySeq[1] = draft;
    S.tables.billing_payment_attempts = [
      {
        id: "att-live",
        providerOrderId: "order_old",
        amountPaise: 5_000_00,
        mandateMaxPaise: 9_000_00,
      },
    ];
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "upi",
        status: "created",
        attempts: 0,
        amount_paid: 0,
      },
    });

    const quoted = await quoteSubscribe({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    noGatewayWrites();
    expect(collect.settleAttempt).not.toHaveBeenCalled(); // the quote frees nothing
    if (!quoted.ok) throw new Error(quoted.error);
    expect(quoted.quote.resumed).toBe(false);
    expect(quoted.quote.payNow?.totalPaise).toBe(5_900_00);

    openGateway();
    collect.settleAttempt.mockResolvedValue("failed");
    const started = await startEnrolment({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    if (!started.ok) throw new Error(started.error);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-live",
      "failed",
      expect.objectContaining({ failureCode: "tax_changed" }),
    );
    expect(store.reshapeDraftSubscriptionInvoice).toHaveBeenCalledTimes(1);
    expect(started.data.amountPaise).toBe(quoted.quote.payNow?.totalPaise);
  });

  it('★ R1-03: an order the gateway cannot read is never "untouched": the quote resumes it, as the start does', async () => {
    reading(STATES["ON-EX"]);
    const cycle = cycleFrom(NOW, "monthly", 1);
    S.invoicesBySeq[1] = {
      id: "inv-old",
      storeId: STORE,
      kind: "subscription",
      status: "draft",
      totalPaise: 5_000_00,
      bodyTotalPaise: 5_000_00,
      taxPaise: 0,
      taxRateBps: 0,
      taxInclusive: false,
      cycleSeq: 1,
      invoiceRef: null,
      finalizedAt: null,
      periodStart: cycle.start.toISOString(),
      periodEnd: cycle.end.toISOString(),
    };
    S.tables.billing_payment_attempts = [
      { id: "att-live", providerOrderId: "order_old", amountPaise: 5_000_00 },
    ];
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    const quoted = await quoteSubscribe({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    if (!quoted.ok) throw new Error(quoted.error);
    expect(quoted.quote.resumed).toBe(true);
    expect(quoted.quote.payNow?.totalPaise).toBe(5_000_00);
  });

  it("a draft with no open order is rebuilt: the fresh total is quoted", async () => {
    reading(STATES["ON-EX"]);
    const cycle = cycleFrom(NOW, "monthly", 1);
    S.invoicesBySeq[1] = {
      id: "inv-old",
      status: "draft",
      totalPaise: 5_000_00,
      bodyTotalPaise: 5_000_00,
      taxPaise: 0,
      taxRateBps: 0,
      taxInclusive: false,
      periodStart: cycle.start.toISOString(),
      periodEnd: cycle.end.toISOString(),
    };
    const quoted = await quoteSubscribe({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    if (!quoted.ok) throw new Error(quoted.error);
    expect(quoted.quote.resumed).toBe(false);
    expect(quoted.quote.payNow?.totalPaise).toBe(5_900_00);
  });

  it("★ an earlier captured payment: nothing to pay, nothing asked of the gateway", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([
      {
        attemptId: "att-old",
        invoiceId: "inv-old",
        providerOrderId: "order_old",
      },
    ]);
    const quoted = await quoteSubscribe({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    noGatewayCalls();
    if (!quoted.ok) throw new Error(quoted.error);
    expect(quoted.quote.earlierPayment).toBe(true);
    expect(quoted.quote.payNow).toBeNull();
    expect(quoted.quote.renewal).toBeNull();
    expect(collect.capturedDraftPurchases).toHaveBeenCalledWith({
      storeId: STORE,
      kind: "subscription",
      limit: 1,
    });
  });

  it("a captured payment on the changed draft: nothing to pay either", async () => {
    reading(STATES["ON-EX"]);
    const cycle = cycleFrom(NOW, "monthly", 1);
    S.invoicesBySeq[1] = {
      id: "inv-old",
      status: "draft",
      totalPaise: 5_000_00,
      bodyTotalPaise: 5_000_00,
      taxPaise: 0,
      taxRateBps: 0,
      taxInclusive: false,
      periodStart: cycle.start.toISOString(),
      periodEnd: cycle.end.toISOString(),
    };
    collect.capturedAttemptForInvoice.mockResolvedValue({
      id: "att-cap",
      providerPaymentId: "pay_1",
    });
    const quoted = await quoteSubscribe({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    if (!quoted.ok) throw new Error(quoted.error);
    expect(quoted.quote.earlierPayment).toBe(true);
    expect(quoted.quote.payNow).toBeNull();
  });

  it("an ended subscription enrols the cycle after the last one issued", async () => {
    S.tables.billing_subscriptions = [liveSub({ state: "cancelled" })];
    S.tables.billing_invoices = [{ seq: 4, status: "open" }];
    const quoted = await quoteSubscribe({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    if (!quoted.ok) throw new Error(quoted.error);
    expect(store.getCycleInvoice).toHaveBeenCalledWith(STORE, 5);
    expect(quoted.quote.renewal?.renewsOn).toBe(
      cycleFrom(NOW, "monthly", 5).end.toISOString(),
    );

    openGateway();
    await startEnrolment({
      storeId: STORE,
      plan: "pro",
      period: "monthly",
      priceFor,
      now: NOW,
    });
    expect(store.ensureRenewalInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ cycleSeq: 5 }),
    );
  });

  describe("refuses where the start refuses, in its words", () => {
    const args = {
      storeId: STORE,
      plan: "pro" as Plan,
      period: "monthly" as const,
      priceFor,
      now: NOW,
    };

    it("the Free plan", async () => {
      expect(await quoteSubscribe({ ...args, plan: "free" })).toEqual({
        ok: false,
        error: "The free plan needs no subscription.",
      });
    });

    it("no payment keys", async () => {
      provider.getPlatformRazorpayCreds.mockReturnValue(null);
      expect(await quoteSubscribe(args)).toEqual({
        ok: false,
        error: "Subscriptions aren't available right now.",
      });
    });

    it("an earlier purchase that cannot be read", async () => {
      collect.capturedDraftPurchases.mockResolvedValue(null);
      expect(await quoteSubscribe(args)).toEqual({
        ok: false,
        error: "Couldn't check your subscription. Try again.",
      });
    });

    it("a subscription that cannot be read", async () => {
      S.failTables.add("billing_subscriptions");
      expect(await quoteSubscribe(args)).toEqual({
        ok: false,
        error: "Couldn't check your subscription. Try again.",
      });
    });

    it("a live subscription", async () => {
      S.tables.billing_subscriptions = [liveSub()];
      expect(await quoteSubscribe(args)).toEqual({
        ok: false,
        error: "This store already has a subscription.",
      });
    });

    it("a tax reading that fails, and one that is incomplete", async () => {
      store.loadTaxSnapshot.mockRejectedValue(new Error("down"));
      expect(await quoteSubscribe(args)).toEqual({
        ok: false,
        error: PAYMENT_REFUSAL.invoiceFailed,
      });
      reading({ ...STATES["ON-EX"], supplierGstin: null });
      store.loadTaxSnapshot.mockImplementation(async (_s: string, at: Date) =>
        resolveTaxSnapshot(row, at),
      );
      expect(await quoteSubscribe(args)).toEqual({
        ok: false,
        error: PAYMENT_REFUSAL.settingsIncomplete,
      });
    });

    it("autopay not yet verified", async () => {
      S.recurringVerified = false;
      expect(await quoteSubscribe(args)).toEqual({
        ok: false,
        error: "Autopay is unavailable right now. No payment was taken.",
      });
    });

    it("a cycle already paid for", async () => {
      S.invoicesBySeq[1] = { id: "inv-paid", status: "paid" };
      expect(await quoteSubscribe(args)).toEqual({
        ok: false,
        error: "This subscription is already paid for.",
      });
    });
  });

  describe("the state flags", () => {
    const args = {
      storeId: STORE,
      plan: "pro" as Plan,
      period: "monthly" as const,
      priceFor,
      now: NOW,
    };

    it("★ GST charged and no state: needsState, and the start refuses for it", async () => {
      reading({ ...STATES["ON-EX"], ...NO_STATE });
      const quoted = await quoteSubscribe(args);
      if (!quoted.ok) throw new Error(quoted.error);
      expect(quoted.quote.needsState).toBe(true);
      expect(quoted.quote.outsideIndia).toBe(false);

      openGateway();
      expect(await startEnrolment(args)).toMatchObject({
        ok: false,
        error: PAYMENT_REFUSAL.needsState,
      });
    });

    it("★ a switch-on scheduled before the renewal and no state: needsState", async () => {
      reading({ ...STATES["SCHED-EX"], ...NO_STATE });
      const quoted = await quoteSubscribe(args);
      if (!quoted.ok) throw new Error(quoted.error);
      expect(quoted.quote.needsState).toBe(true);
      // ★ The renewal falls back to StoreMink's state, as the worker's will.
      const cycle = cycleFrom(NOW, "monthly", 1);
      const worker = resolveTaxSnapshot(
        { ...STATES["SCHED-EX"], ...NO_STATE },
        collectionStartsAt(cycle.end),
      );
      if (!worker.ok) throw new Error("reading");
      expect(worker.placeOfSupply.basis).toBe("supplier_state");
      const renewal = buildSubscriptionInvoice({
        planLabel: "Pro",
        period: "monthly",
        planPaise: 5_000_00,
        tax: worker.tax,
      });
      expect(quoted.quote.renewal?.amount).toEqual(quoteOf(renewal));
    });

    it("GST off for good and no state: nothing is needed", async () => {
      reading({ ...STATES.OFF, ...NO_STATE });
      const quoted = await quoteSubscribe(args);
      if (!quoted.ok) throw new Error(quoted.error);
      expect(quoted.quote.needsState).toBe(false);
    });

    it("GST charged and a business outside India: outsideIndia", async () => {
      reading({ ...STATES["ON-EX"], ...NO_STATE, accountCountry: "US" });
      const quoted = await quoteSubscribe(args);
      if (!quoted.ok) throw new Error(quoted.error);
      expect(quoted.quote.outsideIndia).toBe(true);
      expect(quoted.quote.needsState).toBe(false);
    });
  });
});

// ── Plan or period change ──────────────────────────────────────────────────

describe("quotePlanChange", () => {
  const args = {
    storeId: STORE,
    priceFor,
    locationPrice: LOCATION_PRICE,
    now: NOW,
  };

  it.each(Object.keys(STATES))(
    "★ %s: a dearer change charges what the start charges",
    async (state) => {
      reading(STATES[state]);
      S.tables.billing_subscriptions = [liveSub()];
      const quoted = await quotePlanChange({
        ...args,
        plan: "pro",
        period: "monthly",
      });
      noGatewayCalls();
      if (!quoted.ok) throw new Error(quoted.error);
      const q = quoted.quote;
      expect(q.timing).toBe("now");

      openGateway();
      const started = await startPlanChange({
        ...args,
        targetPlan: "pro",
        targetPeriod: "monthly",
      });
      if (!started.ok) throw new Error(started.error);
      expect(q.payNow?.totalPaise).toBe(
        (started.data as any).payment.amountPaise,
      );
      expect(q.payNow).toEqual(quoteOf(S.built[0]));

      // From the next renewal: Pro monthly under the terms at its issue.
      const worker = resolveTaxSnapshot(
        STATES[state],
        collectionStartsAt(new Date(PERIOD_END)),
      );
      if (!worker.ok) throw new Error("reading");
      const renewal = buildSubscriptionInvoice({
        planLabel: "Pro",
        period: "monthly",
        planPaise: 5_000_00,
        tax: worker.tax,
      });
      expect(q.renewal?.amount).toEqual(quoteOf(renewal));
      expect(q.renewal?.plan).toBe("pro");
      expect(q.renewal?.renewsOn).toBe(new Date(PERIOD_END).toISOString());
    },
  );

  it("★ a cheaper change is scheduled: nothing now, the new plan from the cycle end", async () => {
    reading(STATES["ON-EX"]);
    S.tables.billing_subscriptions = [liveSub({ plan: "pro" })];
    const quoted = await quotePlanChange({
      ...args,
      plan: "basic",
      period: "monthly",
    });
    if (!quoted.ok) throw new Error(quoted.error);
    const q = quoted.quote;
    expect(q.timing).toBe("scheduled");
    expect(q.payNow).toBeNull();
    expect(q.effectiveAt).toBe(PERIOD_END);
    const worker = resolveTaxSnapshot(
      STATES["ON-EX"],
      collectionStartsAt(new Date(PERIOD_END)),
    );
    if (!worker.ok) throw new Error("reading");
    expect(q.renewal?.amount).toEqual(
      quoteOf(
        buildSubscriptionInvoice({
          planLabel: "Basic",
          period: "monthly",
          planPaise: 1_500_00,
          tax: worker.tax,
        }),
      ),
    );

    // And the start schedules exactly that, taking nothing.
    const started = await startPlanChange({
      ...args,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(started).toMatchObject({
      ok: true,
      data: { scheduled: true, effectiveAt: PERIOD_END },
    });
    noGatewayCalls();
  });

  it("uses the same decision as the start (planChangeTerms)", async () => {
    S.tables.billing_subscriptions = [liveSub()];
    const terms = await planChangeTerms({
      storeId: STORE,
      targetPlan: "pro",
      targetPeriod: "yearly",
      priceFor,
      locationPrice: LOCATION_PRICE,
      now: NOW,
    });
    if (!terms.ok || terms.data.kind !== "immediate") throw new Error("terms");
    const quoted = await quotePlanChange({
      ...args,
      plan: "pro",
      period: "yearly",
    });
    if (!quoted.ok) throw new Error(quoted.error);
    expect(quoted.quote.payNow?.listedPaise).toBe(terms.data.prorationPaise);
  });

  it("★ a scheduled switch-on: the part period carries none, the renewal carries it", async () => {
    reading(STATES["SCHED-EX"]);
    S.tables.billing_subscriptions = [
      liveSub({ currentPeriodEnd: "2026-09-25T00:00:00.000Z" }),
    ];
    const quoted = await quotePlanChange({
      ...args,
      plan: "pro",
      period: "monthly",
    });
    if (!quoted.ok) throw new Error(quoted.error);
    expect(quoted.quote.payNow?.taxPaise).toBe(0);
    expect(quoted.quote.renewal?.amount.taxPaise).toBe(900_00);
  });

  it("refuses in planChangeTerms' words", async () => {
    S.tables.billing_subscriptions = [liveSub({ cancelAtPeriodEnd: true })];
    expect(
      await quotePlanChange({ ...args, plan: "pro", period: "monthly" }),
    ).toEqual({
      ok: false,
      error:
        "Your subscription is cancelling. Resume it first, then change your plan.",
    });
  });

  it("★ an earlier, already paid change: nothing to pay, its own plan named", async () => {
    S.tables.billing_subscriptions = [liveSub()];
    collect.capturedDraftPurchases.mockResolvedValue([
      { attemptId: "a", invoiceId: "i", providerOrderId: "order_old" },
    ]);
    collect.readAddonOrderTarget.mockResolvedValue({
      kind: "plan_change",
      plan: "pro",
      period: "yearly",
    });
    const quoted = await quotePlanChange({
      ...args,
      plan: "pro",
      period: "monthly",
    });
    if (!quoted.ok) throw new Error(quoted.error);
    expect(quoted.quote).toMatchObject({
      earlierPayment: true,
      plan: "pro",
      period: "yearly",
      payNow: null,
      renewal: null,
    });
  });

  it("an earlier location purchase is not a plan change: the change is quoted", async () => {
    S.tables.billing_subscriptions = [liveSub()];
    collect.capturedDraftPurchases.mockResolvedValue([
      { attemptId: "a", invoiceId: "i", providerOrderId: "order_old" },
    ]);
    collect.readAddonOrderTarget.mockResolvedValue({
      kind: "locations",
      count: 1,
    });
    const quoted = await quotePlanChange({
      ...args,
      plan: "pro",
      period: "monthly",
    });
    if (!quoted.ok) throw new Error(quoted.error);
    expect(quoted.quote.earlierPayment).toBe(false);
    expect(quoted.quote.payNow).not.toBeNull();
  });

  it("autopay at the renewal follows the store's mandate", async () => {
    S.tables.billing_subscriptions = [liveSub({ mandateId: "m-1" })];
    S.tables.billing_mandates = [ACTIVE_MANDATE];
    const withMandate = await quotePlanChange({
      ...args,
      plan: "pro",
      period: "monthly",
    });
    if (!withMandate.ok) throw new Error(withMandate.error);
    expect(withMandate.quote.renewal?.autopay).toBe(true);

    S.tables.billing_subscriptions = [liveSub()];
    const without = await quotePlanChange({
      ...args,
      plan: "pro",
      period: "monthly",
    });
    if (!without.ok) throw new Error(without.error);
    expect(without.quote.renewal?.autopay).toBe(false);
  });
});

// ── The next renewal ───────────────────────────────────────────────────────

describe("quoteNextRenewal", () => {
  const args = { storeId: STORE, priceFor, now: NOW };

  it.each(Object.keys(STATES))(
    "★ %s: the renewal as the worker will invoice it",
    async (state) => {
      reading(STATES[state]);
      S.tables.billing_subscriptions = [
        liveSub({ plan: "pro", billedLocations: 2 }),
      ];
      const q = await quoteNextRenewal(args);
      if (!q) throw new Error("no quote");
      const worker = resolveTaxSnapshot(
        STATES[state],
        collectionStartsAt(new Date(PERIOD_END)),
      );
      if (!worker.ok) throw new Error("reading");
      const built = buildSubscriptionInvoice({
        planLabel: "Pro",
        period: "monthly",
        planPaise: 5_000_00,
        locations: { count: 2, unitPaise: 1_000_00 },
        tax: worker.tax,
      });
      expect(q.amount).toEqual(quoteOf(built));
      expect(q.issued).toBe(false);
      expect(q.billedLocations).toBe(2);
      expect(q.renewsOn).toBe(new Date(PERIOD_END).toISOString());
      expect(q.terms).toEqual(worker.terms);
      noGatewayCalls();
    },
  );

  it("★ an invoice already issued for the next cycle is quoted as issued", async () => {
    S.tables.billing_subscriptions = [liveSub({ plan: "pro" })];
    S.invoicesBySeq[4] = {
      id: "inv-next",
      status: "open",
      finalizedAt: "2026-09-12T00:00:00.000Z",
      totalPaise: 4_800_00,
      bodyTotalPaise: 4_800_00,
      taxPaise: 0,
      taxRateBps: 0,
      taxInclusive: false,
    };
    const q = await quoteNextRenewal(args);
    expect(q).toMatchObject({
      issued: true,
      issuedAt: "2026-09-12T00:00:00.000Z",
      amount: { totalPaise: 4_800_00, listedPaise: 4_800_00 },
    });
  });

  it("a booked downgrade is what renews", async () => {
    S.tables.billing_subscriptions = [
      liveSub({ plan: "pro", scheduledPlan: "basic" }),
    ];
    const q = await quoteNextRenewal(args);
    expect(q?.plan).toBe("basic");
    expect(q?.amount.totalPaise).toBe(1_500_00);
  });

  it("the route: over the mandate's ceiling is collected by hand", async () => {
    S.tables.billing_subscriptions = [
      liveSub({ plan: "pro", mandateId: "m-1" }),
    ];
    S.tables.billing_mandates = [
      { status: "active", maxAmountPaise: 1_000_00 },
    ];
    const q = await quoteNextRenewal(args);
    expect(q).toMatchObject({
      autoCollect: false,
      reason: "over_mandate",
      mandateMaxPaise: 1_000_00,
    });

    S.tables.billing_mandates = [ACTIVE_MANDATE];
    expect(await quoteNextRenewal(args)).toMatchObject({
      autoCollect: true,
      reason: null,
    });

    S.recurringVerified = false;
    expect(await quoteNextRenewal(args)).toMatchObject({
      autoCollect: false,
      route: { auto: true },
    });
  });

  it("★ a switch-on before the renewal's issue: its GST and place of supply", async () => {
    // The renewal is issued four days before 25 Sep, after GST starts on the
    // 15th, so it carries GST and, with no state anywhere, StoreMink's.
    reading({ ...STATES["SCHED-EX"], ...NO_STATE });
    S.tables.billing_subscriptions = [
      liveSub({ plan: "pro", currentPeriodEnd: "2026-09-25T00:00:00.000Z" }),
    ];
    const q = await quoteNextRenewal(args);
    expect(q?.placeOfSupply).toEqual({ code: "03", basis: "supplier_state" });
    expect(q?.amount.taxPaise).toBe(900_00);

    // Issued before the 15th, the same renewal carries none.
    S.tables.billing_subscriptions = [liveSub({ plan: "pro" })];
    const early = await quoteNextRenewal(args);
    expect(early?.placeOfSupply).toEqual({ code: null, basis: "unknown" });
    expect(early?.amount.taxPaise).toBe(0);
  });

  it("nothing when there is no live, renewing subscription, or a read fails", async () => {
    expect(await quoteNextRenewal(args)).toBeNull();
    S.tables.billing_subscriptions = [liveSub({ cancelAtPeriodEnd: true })];
    expect(await quoteNextRenewal(args)).toBeNull();
    S.tables.billing_subscriptions = [liveSub({ state: "downgraded" })];
    expect(await quoteNextRenewal(args)).toBeNull();
    S.tables.billing_subscriptions = [liveSub()];
    S.failTables.add("billing_subscriptions");
    expect(await quoteNextRenewal(args)).toBeNull();
  });
});

// ── One more location at the renewal ──────────────────────────────────────

describe("quoteLocationRenewal", () => {
  const args = {
    storeId: STORE,
    locationPrice: LOCATION_PRICE,
    priceFor,
    now: NOW,
  };

  /** What the renewal worker would bill for the next cycle with `count`
   *  extra locations, under the terms at its issue. */
  function renewalWith(
    state: string,
    count: number,
    unitPaise: number,
  ): ReturnType<typeof quoteOf> {
    const issuedAt = collectionStartsAt(new Date(PERIOD_END));
    const worker = resolveTaxSnapshot(STATES[state], issuedAt);
    if (!worker.ok) throw new Error("reading");
    return quoteOf(
      buildSubscriptionInvoice({
        planLabel: "Pro",
        period: "monthly",
        planPaise: PLAN_PAISE.pro.monthly,
        locations: count > 0 ? { count, unitPaise } : undefined,
        tax: worker.tax,
      }),
    );
  }

  it.each(Object.keys(STATES))(
    "%s: one location is what it adds to the renewal, under the renewal's terms",
    async (state) => {
      reading(STATES[state]);
      S.tables.billing_subscriptions = [liveSub({ plan: "pro" })];
      const q = await quoteLocationRenewal(args);
      if (!q) throw new Error("no quote");
      const issuedAt = collectionStartsAt(new Date(PERIOD_END));
      const more = renewalWith(state, 1, 1_000_00);
      const base = renewalWith(state, 0, 1_000_00);
      expect(q.perLocation).toEqual({
        listedPaise: more.listedPaise - base.listedPaise,
        taxablePaise: more.taxablePaise - base.taxablePaise,
        taxPaise: more.taxPaise - base.taxPaise,
        totalPaise: more.totalPaise - base.totalPaise,
        rateBps: more.rateBps,
        inclusive: more.inclusive,
      });
      expect(q.issuedAt).toBe(issuedAt.toISOString());
      expect(q.period).toBe("monthly");
    },
  );

  it("★★ R1-02: the exact paisa the renewal invoice grows by, not a separately carved line", async () => {
    // GST included at 18%: ₹21 carved on its own is 320 paise of tax, but
    // added to a ₹5,000 renewal it grows the invoice's GST by 321, because the
    // invoice carves its whole total once. The card must quote what is billed.
    reading(STATES["ON-IN"]);
    S.tables.billing_subscriptions = [
      liveSub({ plan: "pro", billedLocations: 0 }),
    ];
    const price = { monthlyInr: 21, yearlyInr: 210 };
    const q = await quoteLocationRenewal({ ...args, locationPrice: price });
    if (!q) throw new Error("no quote");
    const alone = quoteOf(
      buildAddonInvoice({
        description: "Extra location",
        amountPaise: 21_00,
        tax: (() => {
          const r = resolveTaxSnapshot(
            STATES["ON-IN"],
            collectionStartsAt(new Date(PERIOD_END)),
          );
          if (!r.ok) throw new Error("reading");
          return r.tax;
        })(),
      }),
    );
    expect(alone.taxPaise).toBe(320); // the old quote, 1 paisa short
    expect(q.perLocation.totalPaise).toBe(21_00);
    expect(q.perLocation.taxPaise).toBe(321);
    expect(
      renewalWith("ON-IN", 1, 21_00).taxPaise -
        renewalWith("ON-IN", 0, 21_00).taxPaise,
    ).toBe(321);
  });

  it("★ prices the base plan once, for both renewals (no reprice can fall between them)", async () => {
    reading(STATES["ON-EX"]);
    S.tables.billing_subscriptions = [liveSub({ plan: "pro" })];
    priceFor.mockClear();
    await quoteLocationRenewal(args);
    expect(priceFor).toHaveBeenCalledTimes(1);
    expect(priceFor).toHaveBeenCalledWith("pro", "monthly");
  });

  it("nothing for a plan with no POS", async () => {
    S.tables.billing_subscriptions = [liveSub({ plan: "basic" })];
    expect(await quoteLocationRenewal(args)).toBeNull();
  });
});

// ── The checkout dialog ────────────────────────────────────────────────────

describe("quoteCheckoutFor", () => {
  const args = {
    storeId: STORE,
    priceFor,
    locationPrice: LOCATION_PRICE,
    now: NOW,
  };

  it("subscribes a store with no live plan", async () => {
    const res = await quoteCheckoutFor({
      ...args,
      plan: "pro",
      period: "monthly",
      packId: null,
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.plan.kind).toBe("subscribe");
    expect(res.pack).toBeNull();
  });

  it("changes the plan of a store on a live cycle", async () => {
    S.tables.billing_subscriptions = [liveSub()];
    const res = await quoteCheckoutFor({
      ...args,
      plan: "pro",
      period: "monthly",
      packId: null,
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.plan.kind).toBe("change");
  });

  it.each(Object.keys(STATES))(
    "★ %s: a credit pack is priced as its purchase prices it",
    async (state) => {
      reading(STATES[state]);
      packs.getMinkCreditPackLive.mockResolvedValue({
        id: "pack-60",
        name: "60 credits",
        credits: 60,
        priceInr: 299,
      });
      const res = await quoteCheckoutFor({
        ...args,
        plan: "pro",
        period: "monthly",
        packId: "pack-60",
      });
      if (!res.ok) throw new Error(res.error);
      const snap = resolveTaxSnapshot(STATES[state], NOW);
      if (!snap.ok) throw new Error("reading");
      expect(res.pack).toEqual(
        quoteOf(
          buildAiCreditsInvoice({
            packLabel: "60 credits",
            credits: 60,
            amountPaise: 299_00,
            tax: snap.tax,
          }),
        ),
      );
      expect(res.terms).toEqual(snap.terms);
    },
  );

  it.each([
    ["no state on record", NO_STATE, "needsState"],
    [
      "a business outside India",
      { ...NO_STATE, accountCountry: "US" },
      "outsideIndia",
    ],
  ] as const)(
    "★★ R1-05: a pack with a scheduled (cheaper) change is still a payment now: %s is flagged",
    async (_label, records, flag) => {
      // GST charged. The plan step is a downgrade booked for the cycle end, so
      // the plan quote pays nothing and raises no flag; the pack's start
      // refuses all the same, so the dialog must not enable Pay.
      reading({ ...STATES["ON-EX"], ...records });
      S.tables.billing_subscriptions = [liveSub({ plan: "pro" })];
      packs.getMinkCreditPackLive.mockResolvedValue({
        id: "pack-60",
        name: "60 credits",
        credits: 60,
        priceInr: 299,
      });
      const res = await quoteCheckoutFor({
        ...args,
        plan: "basic",
        period: "monthly",
        packId: "pack-60",
      });
      if (!res.ok) throw new Error(res.error);
      expect(res.plan.kind).toBe("change");
      expect(res[flag]).toBe(true);

      if (flag === "outsideIndia") {
        // Without the pack, the booked change alone pays nothing now and is
        // not refused (the case R1-05 found the dialog enabling Pay for).
        // (No state is flagged either way: the renewal needs one.)
        const alone = await quoteCheckoutFor({
          ...args,
          plan: "basic",
          period: "monthly",
          packId: null,
        });
        if (!alone.ok) throw new Error(alone.error);
        expect(alone.outsideIndia).toBe(false);
      }
    },
  );

  it("refuses an unknown pack and an unreadable subscription", async () => {
    expect(
      await quoteCheckoutFor({
        ...args,
        plan: "pro",
        period: "monthly",
        packId: "nope",
      }),
    ).toEqual({ ok: false, error: "Unknown credit pack." });
    S.failTables.add("billing_subscriptions");
    expect(
      await quoteCheckoutFor({
        ...args,
        plan: "pro",
        period: "monthly",
        packId: null,
      }),
    ).toEqual({
      ok: false,
      error: "Couldn't check your subscription. Try again.",
    });
  });

  it("an unexpected failure is a refusal, never a throw", async () => {
    priceFor.mockRejectedValueOnce(new Error("pricing down"));
    expect(
      await quoteCheckoutFor({
        ...args,
        plan: "pro",
        period: "monthly",
        packId: null,
      }),
    ).toEqual({
      ok: false,
      error: "Couldn't check your subscription. Try again.",
    });
  });
});
