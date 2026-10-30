// The one rule every on-session payment follows for GST (R1-01), and the
// payment time a browser confirm issues its invoice at (R1-07).
//
// ★ The refusal is asked of REAL readings (`resolveTaxSnapshot` over a row),
// so "no state on record" and "outside India" mean what the tax reading
// means by them, not what a hand-built object says.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { PAYMENT_REFUSAL } from "./tax-copy";
import { resolveTaxSnapshot, type SnapshotRow } from "./tax-snapshot";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const rzp = vi.hoisted(() => ({ rzpFetchPayment: vi.fn() }));
vi.mock("@/lib/payments/razorpay", () => rzp);

const store = vi.hoisted(() => ({ loadTaxSnapshot: vi.fn() }));
vi.mock("./invoice-store", () => store);

import {
  gatewayCreatedAt,
  paymentCapturedAt,
  paymentTaxRefusal,
  readTaxForPayment,
  type OkTaxSnapshot,
} from "./payment-tax";

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const CREDS = { keyId: "rzp_test_1", keySecret: "secret" };

/** GST off, StoreMink's identity complete, a merchant in Karnataka (29). */
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
const ON: SnapshotRow = { ...BASE, taxEnabled: true };
const NO_STATE = { accountStateCode: null };
const ABROAD = { accountStateCode: null, accountCountry: "US" };

function snapOf(row: SnapshotRow): OkTaxSnapshot {
  const snap = resolveTaxSnapshot(row, NOW);
  if (!snap.ok) throw new Error("reading");
  return snap;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("★★ paymentTaxRefusal: one rule for every payment", () => {
  it("GST charged and the merchant's state on record: no refusal", () => {
    expect(paymentTaxRefusal(snapOf(ON))).toBeNull();
  });

  it("★ GST charged and only StoreMink's state known: needsState", () => {
    expect(paymentTaxRefusal(snapOf({ ...ON, ...NO_STATE }))).toBe(
      "needsState",
    );
  });

  it("★ GST charged and a business outside India: outsideIndia", () => {
    expect(paymentTaxRefusal(snapOf({ ...ON, ...ABROAD }))).toBe(
      "outsideIndia",
    );
  });

  it.each([
    ["no state", NO_STATE],
    ["outside India", ABROAD],
  ])(
    "★ GST off: %s refuses nothing (a payment needs no place of supply)",
    (_l, rec) => {
      expect(paymentTaxRefusal(snapOf({ ...BASE, ...rec }))).toBeNull();
    },
  );
});

describe("★★ readTaxForPayment: the reading, or the sentence the merchant reads", () => {
  function reading(row: SnapshotRow) {
    store.loadTaxSnapshot.mockImplementation(async (_s: string, at: Date) =>
      resolveTaxSnapshot(row, at),
    );
  }

  it("returns the reading taken at `now`, for this store", async () => {
    reading(ON);
    const res = await readTaxForPayment(STORE, NOW, "billing.enrol");
    expect(res.ok).toBe(true);
    expect(store.loadTaxSnapshot).toHaveBeenCalledWith(STORE, NOW);
  });

  it("a reading that throws: the invoice refusal, logged under the caller's name", async () => {
    store.loadTaxSnapshot.mockRejectedValue(new Error("db down"));
    const res = await readTaxForPayment(STORE, NOW, "billing.plan_change");
    expect(res).toEqual({ ok: false, error: PAYMENT_REFUSAL.invoiceFailed });
    expect(logError).toHaveBeenCalledWith(
      "billing.plan_change.tax_snapshot",
      expect.any(Error),
      { storeId: STORE },
    );
  });

  it("StoreMink's identity incomplete while GST is on: settingsIncomplete, with the reason", async () => {
    reading({ ...ON, sacCode: null });
    const res = await readTaxForPayment(STORE, NOW, "billing.locations");
    expect(res).toEqual({
      ok: false,
      error: PAYMENT_REFUSAL.settingsIncomplete,
    });
    expect(logError).toHaveBeenCalledWith(
      "billing.locations.tax_snapshot",
      expect.objectContaining({ message: "the GST settings are incomplete" }),
      expect.objectContaining({ storeId: STORE, reason: expect.any(String) }),
    );
  });

  it.each([
    ["needsState", NO_STATE, "no_state"],
    ["outsideIndia", ABROAD, "outside_india"],
  ] as const)(
    "★ %s: refused with its sentence, logged at info as a decision",
    async (refusal, rec, reason) => {
      reading({ ...ON, ...rec });
      const res = await readTaxForPayment(STORE, NOW, "billing.credit_pack");
      expect(res).toEqual({ ok: false, error: PAYMENT_REFUSAL[refusal] });
      expect(logInfo).toHaveBeenCalledWith(
        "billing.credit_pack.payment_refused",
        { storeId: STORE, reason },
      );
    },
  );
});

describe("gatewayCreatedAt", () => {
  it("reads Razorpay's created_at, in seconds", () => {
    expect(gatewayCreatedAt({ created_at: 1_700_000_000 })).toEqual(
      new Date(1_700_000_000_000),
    );
  });

  it.each([
    [{}],
    [{ created_at: 0 }],
    [{ created_at: -5 }],
    [{ created_at: "1700000000" }],
    [{ created_at: Number.NaN }],
    [null],
    [undefined],
  ])("no usable time is null, never the epoch: %j", (payment) => {
    expect(gatewayCreatedAt(payment)).toBeNull();
  });
});

describe("★★ R1-07: paymentCapturedAt, best-effort and never in the way", () => {
  it("the payment's own time when the gateway records one", async () => {
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: true,
      data: { id: "pay_1", created_at: 1_700_000_000 },
    });
    await expect(
      paymentCapturedAt(CREDS, "pay_1", "billing.enrol"),
    ).resolves.toEqual(new Date(1_700_000_000_000));
    expect(rzp.rzpFetchPayment).toHaveBeenCalledWith(CREDS, "pay_1");
  });

  it("a record with no time: undefined (issued at the confirm), nothing logged", async () => {
    rzp.rzpFetchPayment.mockResolvedValue({ ok: true, data: { id: "pay_1" } });
    await expect(
      paymentCapturedAt(CREDS, "pay_1", "billing.enrol"),
    ).resolves.toBeUndefined();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("a refused read: undefined, with a warning under the caller's name", async () => {
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: false,
      error: "not found",
      outcome: "rejected",
    });
    await expect(
      paymentCapturedAt(CREDS, "pay_1", "billing.locations"),
    ).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith("billing.locations.payment_time", {
      paymentId: "pay_1",
      reason: "not found",
    });
  });

  it("★ a read that throws never throws into the confirm", async () => {
    rzp.rzpFetchPayment.mockRejectedValue(new Error("socket hang up"));
    await expect(
      paymentCapturedAt(CREDS, "pay_1", "billing.plan_change"),
    ).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith("billing.plan_change.payment_time", {
      paymentId: "pay_1",
      reason: "socket hang up",
    });

    rzp.rzpFetchPayment.mockRejectedValue("boom");
    await paymentCapturedAt(CREDS, "pay_1", "billing.plan_change");
    expect(logWarn).toHaveBeenLastCalledWith(
      "billing.plan_change.payment_time",
      { paymentId: "pay_1", reason: "unknown error" },
    );
  });
});

describe("★★ R1-01: no payment path keeps its own copy of the rule", () => {
  // Four hand-written copies used to sit in these files, and a fifth as quote
  // booleans: identical until someone tightened one. Each now asks
  // `readTaxForPayment` (or `paymentTaxRefusal`) under its own log prefix.
  const root = process.cwd();
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");

  it.each([
    ["lib/billing/enrol.ts", "billing.enrol"],
    ["lib/billing/plan-change.ts", "billing.plan_change"],
    ["lib/billing/locations.ts", "billing.locations"],
    ["app/actions/ai-credit-actions.ts", "billing.credit_pack"],
  ])("%s reads the tax through readTaxForPayment", (file, prefix) => {
    const src = read(file);
    expect(src).toMatch(/from "(?:\.\/|@\/lib\/billing\/)payment-tax"/);
    expect(src).toContain(`"${prefix}"`);
    expect(src).not.toMatch(/function readTaxFor/);
    expect(src).not.toMatch(/PAYMENT_REFUSAL\.(needsState|outsideIndia)/);
  });

  it("the quote's flags ask paymentTaxRefusal, and keep no copy of the enrol helpers", () => {
    const src = read("lib/billing/quote.ts");
    expect(src).toContain("paymentTaxRefusal(");
    expect(src).toMatch(/enrolCycleSeqWith/);
    expect(src).toMatch(/taxDraftOrder/);
    expect(src).not.toMatch(/async function liveAttemptOn/);
    expect(src).not.toMatch(/const ENDED_STATES/);
  });
});
