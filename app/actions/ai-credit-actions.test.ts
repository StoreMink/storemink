/* eslint-disable @typescript-eslint/no-explicit-any */
// AI credit purchases: the invoicing and pricing half.
//
// ⚠ This file had NO tests at all before 2026-08-13, despite being a money path.
// It covers the invoice a purchase produces and, since GST (design 5.5), the
// amount it is charged. The plan gating and the add_ai_credits RPC are still
// covered only through these paths.
//
// ★★ THE PROPERTY THAT MATTERS: the document is issued by `settlePurchase`,
// which is the ONE place a purchase becomes paid, reached BOTH from
// `confirmCreditPurchase` and from the reconcile-on-read sweep. Moving the call
// up into `confirmCreditPurchase` would look identical here and would silently
// leave every reconciled purchase without an invoice.
//
// ★★ AND SINCE GST: one tax reading prices the Razorpay order AND writes the
// draft, so a Rs 59 pack at 18% exclusive is charged Rs 69.62 and its invoice
// says Rs 69.62. The reading is the REAL `resolveTaxSnapshot` over a row.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";
import { logError, logWarn } from "@/lib/observability/logger";
import { PAYMENT_REFUSAL } from "@/lib/billing/tax-copy";
import {
  resolveTaxSnapshot,
  type SnapshotRow,
} from "@/lib/billing/tax-snapshot";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const access = vi.hoisted(() => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(),
  getViewerAccess: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => access);

const provider = vi.hoisted(() => ({ getPlatformRazorpayCreds: vi.fn() }));
vi.mock("@/lib/payments/provider", () => provider);

// Every gateway call is a mock: nothing here may reach Razorpay.
const rzp = vi.hoisted(() => ({
  capturedPayment: vi.fn(),
  rzpCreateOrder: vi.fn(),
  rzpFetchOrderPayments: vi.fn(),
  rzpFetchPayment: vi.fn(),
  verifyCapturedCheckoutPayment: vi.fn(),
  verifyCheckoutSignature: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => rzp);

const invoice = vi.hoisted(() => ({
  draftCreditInvoice: vi.fn(),
  issueCreditInvoice: vi.fn(),
}));
vi.mock("@/lib/billing/credit-invoice", () => invoice);

const store = vi.hoisted(() => ({ loadTaxSnapshot: vi.fn() }));
vi.mock("@/lib/billing/invoice-store", () => store);

vi.mock("@/lib/notifications/record", () => ({
  emitEvent: vi.fn(),
  // The reconcile pass tells the merchant itself (lib/ai/credit-purchase.ts).
  recordEvent: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/quota", () => ({ getAiUsage: vi.fn() }));
vi.mock("@/lib/ai/credit-pricing", () => ({
  getMinkCreditPackLive: vi.fn(async (id: string) =>
    id === "small"
      ? { id: "small", name: "Small", credits: 25, priceInr: 59 }
      : null,
  ),
  getMinkCreditPacksLive: vi.fn(async () => []),
}));

import {
  confirmCreditPurchase,
  getAiUsagePageData,
  startCreditPurchase,
} from "./ai-credit-actions";
import { emitEvent } from "@/lib/notifications/record";

const STORE = "a0000000-0000-4000-8000-000000000001";

/** GST off, StoreMink's identity complete, a merchant with no records. */
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

/** GST charged at 18%, exclusive, for a merchant in Karnataka. */
const GST_ON_KARNATAKA: SnapshotRow = {
  ...SNAPSHOT_ROW,
  taxEnabled: true,
  accountStateCode: "29",
};

function readingFor(row: SnapshotRow) {
  store.loadTaxSnapshot.mockImplementation(async (_store: string, at: Date) =>
    resolveTaxSnapshot(row, at),
  );
}

function pendingPurchase(over: Record<string, unknown> = {}) {
  return {
    id: "pur-1",
    store_id: STORE,
    credits: 25,
    pack_id: "small",
    amount_inr: 59,
    amount_paise: 6_962,
    status: "pending",
    rzp_order_id: "order_1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  access.getManagerUserId.mockResolvedValue("admin-1");
  access.getActingStoreId.mockResolvedValue(STORE);
  access.getViewerAccess.mockResolvedValue({ can: () => true });
  // The payment the confirm verifies, read back for its time (R1-07). No
  // `created_at` by default: issued at the confirm, as before.
  rzp.rzpFetchPayment.mockResolvedValue({ ok: true, data: { id: "pay_1" } });
  provider.getPlatformRazorpayCreds.mockReturnValue({
    keyId: "rzp_1",
    keySecret: "secret",
  });
  rzp.verifyCheckoutSignature.mockReturnValue(true);
  rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
    ok: true,
    gatewayRead: true,
  });
  rzp.rzpCreateOrder.mockResolvedValue({ ok: true, data: { id: "order_1" } });
  rzp.rzpFetchOrderPayments.mockResolvedValue({ ok: false, error: "x" });
  rzp.capturedPayment.mockReturnValue(null);
  invoice.draftCreditInvoice.mockResolvedValue("inv-1");
  invoice.issueCreditInvoice.mockResolvedValue(undefined);
  readingFor(SNAPSHOT_ROW);
  dbHolder.current = makeDbMock({ selectQueue: [[pendingPurchase()]] });
});

describe("startCreditPurchase", () => {
  function seedStart() {
    dbHolder.current = makeDbMock({ returning: [{ id: "pur-1" }] });
  }

  /** The values the purchase row was inserted with. */
  function insertedPurchase() {
    return dbHolder.current.calls.values[0];
  }

  it("★ raises a DRAFT invoice for the purchase", async () => {
    seedStart();
    await startCreditPurchase("small");
    expect(invoice.draftCreditInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE, purchaseId: "pur-1" }),
    );
  });

  it("★★ raises it AFTER the gateway order — a purchase that died there leaves no document", async () => {
    seedStart();
    rzp.rzpCreateOrder.mockResolvedValue({ ok: false, error: "nope" });
    const res = await startCreditPurchase("small");
    expect("error" in res).toBe(true);
    expect(invoice.draftCreditInvoice).not.toHaveBeenCalled();
  });

  it("★ lets a Free store buy a one-time credit top-up", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pur-free" }] });
    const res = await startCreditPurchase("small");
    expect("success" in res).toBe(true);
    expect(invoice.draftCreditInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE, purchaseId: "pur-free" }),
    );
  });

  it("refuses an unknown pack", async () => {
    const res = await startCreditPurchase("not-a-pack");
    expect("error" in res).toBe(true);
  });

  it("GST off: the list price is the charge", async () => {
    seedStart();
    const res = await startCreditPurchase("small");
    expect(res).toMatchObject({ success: true, amountPaise: 5_900 });
    expect(rzp.rzpCreateOrder.mock.calls[0][1].amountPaise).toBe(5_900);
    expect(insertedPurchase()).toMatchObject({
      amountInr: 59,
      amountPaise: 5_900,
    });
  });

  describe("★★ GST charged, prices exclusive: a Rs 59 pack costs Rs 69.62", () => {
    beforeEach(() => {
      readingFor(GST_ON_KARNATAKA);
      seedStart();
    });

    it("orders the pack for the invoice total, never the bare list price", async () => {
      const res = await startCreditPurchase("small");
      expect(rzp.rzpCreateOrder.mock.calls[0][1].amountPaise).toBe(6_962);
      // The browser's payment window and its amount guard read this.
      expect(res).toMatchObject({ success: true, amountPaise: 6_962 });
    });

    it("records the list price in amount_inr and the charge in amount_paise", async () => {
      await startCreditPurchase("small");
      expect(insertedPurchase()).toMatchObject({
        storeId: STORE,
        packId: "small",
        credits: 25,
        amountInr: 59,
        amountPaise: 6_962,
        status: "pending",
      });
    });

    it("★★ drafts the invoice from the SAME reading that priced the order", async () => {
      await startCreditPurchase("small");
      const draft = invoice.draftCreditInvoice.mock.calls[0][0];
      expect(draft.built.totalPaise).toBe(6_962);
      expect(draft.built.taxPaise).toBe(1_062);
      expect(draft.built.lines[0].kind).toBe("ai_credits");
      expect(draft.stamp).toMatchObject({
        supplierGstin: "03ABCDE1234F1Z5",
        placeOfSupply: "29",
        sacCode: "998314",
      });
      // One reading, at one moment.
      expect(store.loadTaxSnapshot).toHaveBeenCalledTimes(1);
      expect(store.loadTaxSnapshot).toHaveBeenCalledWith(
        STORE,
        expect.any(Date),
      );
    });
  });

  it("★ GST charged, prices inclusive: the list price is the charge, GST inside it", async () => {
    readingFor({ ...GST_ON_KARNATAKA, taxInclusive: true });
    seedStart();
    const res = await startCreditPurchase("small");
    expect(res).toMatchObject({ success: true, amountPaise: 5_900 });
    expect(rzp.rzpCreateOrder.mock.calls[0][1].amountPaise).toBe(5_900);
    expect(insertedPurchase().amountPaise).toBe(5_900);
    const draft = invoice.draftCreditInvoice.mock.calls[0][0];
    expect(draft.built.totalPaise).toBe(5_900);
    expect(draft.built.taxPaise).toBeGreaterThan(0);
  });

  it("★★ FAILS CLOSED when the draft could not be written: purchase failed, no window", async () => {
    // A payment without its invoice is not acceptable once the invoice can be
    // a tax invoice. The order stays unused at Razorpay.
    seedStart();
    invoice.draftCreditInvoice.mockResolvedValue(null);
    const res = await startCreditPurchase("small");
    expect(res).toEqual({ error: PAYMENT_REFUSAL.invoiceFailed });
    expect(dbHolder.current.calls.set).toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
  });

  describe("the refusals, before anything is written", () => {
    function expectNothingWritten() {
      expect(dbHolder.current.calls.insert).toHaveLength(0);
      expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
      expect(invoice.draftCreditInvoice).not.toHaveBeenCalled();
    }

    beforeEach(() => {
      seedStart();
    });

    it("a reading that fails", async () => {
      store.loadTaxSnapshot.mockRejectedValue(new Error("connection reset"));
      const res = await startCreditPurchase("small");
      expect(res).toEqual({ error: PAYMENT_REFUSAL.invoiceFailed });
      expectNothingWritten();
      expect(logError).toHaveBeenCalledWith(
        "billing.credit_pack.tax_snapshot",
        expect.any(Error),
        { storeId: STORE },
      );
    });

    it("GST on without StoreMink's full tax identity", async () => {
      readingFor({ ...GST_ON_KARNATAKA, supplierGstin: null });
      const res = await startCreditPurchase("small");
      expect(res).toEqual({ error: PAYMENT_REFUSAL.settingsIncomplete });
      expectNothingWritten();
    });

    it("★ GST on and no state of the merchant anywhere", async () => {
      readingFor({ ...SNAPSHOT_ROW, taxEnabled: true });
      const res = await startCreditPurchase("small");
      expect(res).toEqual({ error: PAYMENT_REFUSAL.needsState });
      expectNothingWritten();
    });

    it("★★ GST on and a business outside India", async () => {
      readingFor({ ...GST_ON_KARNATAKA, accountCountry: "US" });
      const res = await startCreditPurchase("small");
      expect(res).toEqual({ error: PAYMENT_REFUSAL.outsideIndia });
      expectNothingWritten();
    });

    it("GST off: a business outside India may still buy credits", async () => {
      readingFor({ ...SNAPSHOT_ROW, accountCountry: "US" });
      const res = await startCreditPurchase("small");
      expect(res).toMatchObject({ success: true, amountPaise: 5_900 });
    });
  });
});

describe("confirmCreditPurchase", () => {
  // 21 Nov 2026: the webhook can settle a purchase a moment before this
  // confirm arrives, and it tells the merchant itself.
  describe("★★ only the settle that made it paid announces it", () => {
    it("announces when this confirm made the purchase paid", async () => {
      await confirmCreditPurchase("pur-1", "pay_1", "sig");
      expect(emitEvent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(emitEvent).mock.calls[0][0]).toMatchObject({
        type: "ai.credits_purchased",
        payload: { credits: pendingPurchase().credits },
      });
    });

    it("says nothing when the claim was already taken (the webhook got there first)", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[pendingPurchase()]],
        returning: [],
      });
      const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
      // Still a success for the merchant: the credits are theirs.
      expect("success" in res).toBe(true);
      expect(emitEvent).not.toHaveBeenCalled();
    });
  });

  it("★★ ISSUES the invoice once the payment verifies", async () => {
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("success" in res).toBe(true);
    // On session: the payment is seconds old, so no payment time is passed.
    expect(invoice.issueCreditInvoice).toHaveBeenCalledWith(
      "pur-1",
      undefined,
      undefined,
    );
  });

  it("★★ R1-07: issues at the payment's own time when the gateway records one", async () => {
    const CAPTURED_SECONDS = Date.parse("2026-08-31T17:30:00.000Z") / 1000;
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: true,
      data: { id: "pay_1", created_at: CAPTURED_SECONDS },
    });
    await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect(invoice.issueCreditInvoice).toHaveBeenCalledWith(
      "pur-1",
      undefined,
      new Date(CAPTURED_SECONDS * 1000),
    );
  });

  it("★ R1-07: a payment time that cannot be read never stops the credits", async () => {
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("success" in res).toBe(true);
    expect(invoice.issueCreditInvoice).toHaveBeenCalledWith(
      "pur-1",
      undefined,
      undefined,
    );
    expect(logWarn).toHaveBeenCalledWith("billing.credit_pack.payment_time", {
      paymentId: "pay_1",
      reason: "timeout",
    });
  });

  it("★★ verifies the captured payment against amount_paise, the charge", async () => {
    await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect(rzp.verifyCapturedCheckoutPayment).toHaveBeenCalledWith(
      { keyId: "rzp_1", keySecret: "secret" },
      { paymentId: "pay_1", orderId: "order_1", amountPaise: 6_962 },
    );
  });

  it("★ a purchase started before amount_paise existed verifies amount_inr * 100", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[pendingPurchase({ amount_paise: null })]],
    });
    await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect(rzp.verifyCapturedCheckoutPayment.mock.calls[0][1].amountPaise).toBe(
      5_900,
    );
  });

  it("★★ issues NOTHING when the signature fails", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("error" in res).toBe(true);
    expect(invoice.issueCreditInvoice).not.toHaveBeenCalled();
  });

  it("grants no credits when Razorpay reports a mismatched payment", async () => {
    rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
      ok: false,
      error: "The captured amount does not match the invoice.",
    });
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("error" in res).toBe(true);
    expect(invoice.issueCreditInvoice).not.toHaveBeenCalled();
  });

  it("★ retries the receipt for an ALREADY-paid purchase", async () => {
    // Idempotent: re-confirming cannot grant credits twice, but it does repair
    // a receipt whose best-effort write failed after the purchase committed.
    dbHolder.current = makeDbMock({
      selectQueue: [[pendingPurchase({ status: "paid" })]],
    });
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("success" in res).toBe(true);
    expect(invoice.issueCreditInvoice).toHaveBeenCalledWith("pur-1");
  });

  it("★ refuses a purchase belonging to another store", async () => {
    // The query is scoped by store, so a foreign id simply finds nothing.
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const res = await confirmCreditPurchase("pur-x", "pay_1", "sig");
    expect("error" in res).toBe(true);
    expect(invoice.issueCreditInvoice).not.toHaveBeenCalled();
  });

  it("refuses a malformed payload", async () => {
    const res = await confirmCreditPurchase("pur-1", "", "sig");
    expect("error" in res).toBe(true);
  });

  it("★ refuses without permission", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("error" in res).toBe(true);
    expect(invoice.issueCreditInvoice).not.toHaveBeenCalled();
  });
});

describe("reconcile-on-read (getAiUsagePageData)", () => {
  const STALE = {
    id: "pur-1",
    store_id: STORE,
    credits: 25,
    pack_id: "small",
    rzp_order_id: "order_1",
    // What the order was created for: the pack's ₹59 plus GST.
    amount_inr: 59,
    amount_paise: 6_962,
  };
  // 31 Aug 2026, 23:00 IST: before a GST start at midnight.
  const CAPTURED_AT_SECONDS = Date.parse("2026-08-31T17:30:00.000Z") / 1000;

  beforeEach(() => {
    dbHolder.current = makeDbMock({
      selectQueue: [[STALE], [], []],
      executeQueue: [[{ add_ai_credits: true }]],
    });
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [
        {
          id: "pay_1",
          order_id: "order_1",
          amount: 6_962,
          status: "captured",
          created_at: CAPTURED_AT_SECONDS,
        },
      ],
    });
    rzp.capturedPayment.mockImplementation(
      (payments: any[]) =>
        payments.find((p) => p.status === "captured") ?? null,
    );
  });

  it("★★ issues the invoice at the payment's own time, for the terms then", async () => {
    await getAiUsagePageData();
    expect(invoice.issueCreditInvoice).toHaveBeenCalledWith(
      "pur-1",
      undefined,
      new Date(CAPTURED_AT_SECONDS * 1000),
    );
  });

  it("a payment record with no time is issued at the time it is noticed", async () => {
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [
        { id: "pay_1", order_id: "order_1", amount: 6_962, status: "captured" },
      ],
    });
    await getAiUsagePageData();
    expect(invoice.issueCreditInvoice).toHaveBeenCalledWith(
      "pur-1",
      undefined,
      undefined,
    );
  });
});

describe("★★ R3-02: getAiUsagePageData is gated on viewing Plans & Billing", () => {
  it.each([
    ["a role without the ai section", { can: () => false }],
    ["a session with no store profile", null],
  ])("refuses %s, before any read or gateway call", async (_label, viewer) => {
    access.getViewerAccess.mockResolvedValue(viewer);
    await expect(getAiUsagePageData()).rejects.toThrow("Not allowed");
    expect(dbHolder.current.calls.select).toHaveLength(0);
    expect(rzp.rzpFetchOrderPayments).not.toHaveBeenCalled();
    expect(access.getActingStoreId).not.toHaveBeenCalled();
  });

  it("asks for VIEW of the ai section, the page's own gate", async () => {
    const can = vi.fn(() => true);
    access.getViewerAccess.mockResolvedValue({ can });
    dbHolder.current = makeDbMock({ selectQueue: [[], [], []] });
    await getAiUsagePageData();
    expect(can).toHaveBeenCalledWith("ai", "view");
  });
});

describe("★★ R3-01: getAiUsagePageData reads its pooled client one query at a time", () => {
  it("never has two queries in flight on the one client", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[], [{ plan: "basic" }], [{ id: "led-1", delta: 25 }]],
    });
    const db = dbHolder.current.db;
    const realSelect = db.select;
    let inFlight = 0;
    let most = 0;
    db.select = (...args: unknown[]) => {
      const step = realSelect(...args);
      inFlight += 1;
      most = Math.max(most, inFlight);
      const then = step.then;
      step.then = (resolve: any, reject: any) =>
        then((v: unknown) => {
          inFlight -= 1;
          return resolve(v);
        }, reject);
      return step;
    };
    const page = await getAiUsagePageData();
    expect(most).toBe(1);
    expect(page.ledger).toEqual([{ id: "led-1", delta: 25 }]);
  });

  it("★ a failed read logs the database's reason, never Drizzle's params, and the page still renders", async () => {
    const failed = Object.assign(
      new Error("Failed query: select ... params: " + STORE),
      { cause: new Error("canceling statement due to statement timeout") },
    );
    dbHolder.current = makeDbMock({ selectQueue: [[], failed] });
    const page = await getAiUsagePageData();
    expect(page.ledger).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "billing.ai_usage_page",
      "canceling statement due to statement timeout",
      { storeId: STORE },
    );
  });
});
