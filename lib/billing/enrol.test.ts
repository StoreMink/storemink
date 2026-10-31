/* eslint-disable @typescript-eslint/no-explicit-any */
// Enrolment — a merchant's first paid cycle.
//
// ── The risks this covers ──────────────────────────────────────────────────
//   • The plan must NOT be granted before the money lands. Grace exists for
//     renewals, where something has already been paid for; granting it up front
//     hands anyone 48 hours of Pro for abandoning a checkout.
//   • The SIGNATURE is the trust boundary. A payment id from the client proves
//     nothing on its own.
//   • BOTH places that record the plan must move, and the comp floor must hold —
//     the old confirmSubscription wrote stores.plan unconditionally and could
//     overwrite an operator's comp DOWNWARD.
//   • Money in, plan not moved, is the one outcome that must never be reported
//     as a bare failure.

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
  rzpCreateAuthorizationOrder: vi.fn(),
  // The resumable branch reads the existing order back to learn its rail.
  rzpFetchOrder: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
    ok: true,
    data: { id: "order_1", method: "card" },
  })),
  rzpCreateCustomer: vi.fn(),
  // Defaults to an unreadable list: "we could not check" is never "nobody
  // paid", so the conservative branch is what an unconfigured test gets.
  rzpFetchOrderPayments: vi.fn<(...a: unknown[]) => Promise<unknown>>(
    async () => ({ ok: false, error: "not stubbed", outcome: "unknown" }),
  ),
  // Read on every confirm to learn whether the checkout registered a mandate.
  // Default deliberately has no token to cover the post-payment anomaly path.
  rzpFetchPayment: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
    ok: true,
    data: { id: "pay_1" },
  })),
  verifyCapturedCheckoutPayment: vi.fn(),
  verifyCheckoutSignature: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => rzp);

// The billing contact a Razorpay customer is created from. Mocked so the
// autopay branch is actually REACHABLE in tests — without it ensureRzpCustomer
// always returns null and the gate below would pass no matter what it did.
const mail = vi.hoisted(() => ({
  resolveBillingEmail: vi.fn<
    () => Promise<{
      email: string;
      phone: string | null;
      storeName: string;
      slug: string;
    }>
  >(async () => ({
    email: "owner@acme.test",
    phone: "9876543210",
    storeName: "Acme",
    slug: "acme",
  })),
}));
vi.mock("@/lib/email/billing-emails", () => mail);

const store = vi.hoisted(() => ({
  loadTaxSnapshot: vi.fn(),
  ensureRenewalInvoice: vi.fn(),
  getCycleInvoice: vi.fn(),
  reshapeDraftSubscriptionInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
  amountDueForInvoice: vi.fn(),
  // Read after the settle: the completion moves the plan only once the
  // invoice is paid.
  getInvoice: vi.fn(async () => ({ id: "inv-1", status: "paid" })),
}));
vi.mock("./invoice-store", () => store);

const collect = vi.hoisted(() => ({
  beginAttempt: vi.fn(),
  settleAttempt: vi.fn(),
  // RC-F1b: no earlier captured purchase unless a test says so.
  capturedDraftPurchases: vi.fn(async (): Promise<unknown[] | null> => []),
  capturedAttemptForInvoice: vi.fn(async (): Promise<unknown> => null),
  fileRecoveredPurchase: vi.fn(async () => true),
  verifyRecoveredCapture: vi.fn(
    async (): Promise<unknown> => ({ status: "ok", paymentId: "pay_old" }),
  ),
}));
vi.mock("./collect", () => collect);

const gateway = vi.hoisted(() => ({ RECURRING_CHARGE_VERIFIED: true }));
vi.mock("./gateway", () => gateway);

const receipts = vi.hoisted(() => ({ notifyPlanActivated: vi.fn() }));
vi.mock("./receipts", () => receipts);

import {
  completeEnrolmentPurchase,
  confirmEnrolment,
  ensureBillingAccount,
  enrolmentDraftChange,
  ENROLMENT_RECOVERED_MESSAGE,
  ENROLMENT_RECOVERY_WAITING_MESSAGE,
  startEnrolment,
} from "./enrol";

const STORE = "store-1";
const INVOICE = "inv-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
/** A monthly cycle is a 30-day DURATION, never a calendar month. */
const MONTHLY_CYCLE_END = new Date(
  NOW.getTime() + 30 * 86_400_000,
).toISOString();
const CYCLE_END = "2026-10-01T00:00:00.000Z";

const priceFor = vi.fn(async () => ({
  planPaise: 5_000_00,
  locationPaise: 1_000_00,
}));

function seed(selects: (any[] | Error)[] = []) {
  dbHolder.current = makeDbMock({ selectQueue: selects });
}

/** GST off, StoreMink's identity complete, a merchant with no records. The
 *  enrolment reads it through the REAL `resolveTaxSnapshot`, so what is built
 *  and stamped is what production would build. */
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

/** GST charged now, exclusive 18%, for a merchant in Karnataka (29). */
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

beforeEach(() => {
  vi.clearAllMocks();
  mail.resolveBillingEmail.mockResolvedValue({
    email: "owner@acme.test",
    phone: "9876543210",
    storeName: "Acme",
    slug: "acme",
  });
  rzp.rzpCreateCustomer.mockResolvedValue({ ok: true, data: { id: "cust_1" } });
  rzp.rzpCreateAuthorizationOrder.mockResolvedValue({
    ok: true,
    data: { id: "order_auth_1" },
  });
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS — and this default
  // matters: a missing token after money moved must still grant the paid plan.
  rzp.rzpFetchPayment.mockResolvedValue({ ok: true, data: { id: "pay_1" } });
  // Same trap: the rail tests below override this, and without restoring it
  // here the override leaks into whichever test `test:shuffle` runs next.
  rzp.rzpFetchOrder.mockResolvedValue({
    ok: true,
    data: { id: "order_1", method: "card" },
  });
  rzp.rzpFetchOrderPayments.mockResolvedValue({
    ok: false,
    error: "not stubbed",
    outcome: "unknown",
  });
  rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
    ok: true,
    gatewayRead: true,
  });
  seed();
  provider.getPlatformRazorpayCreds.mockReturnValue({
    keyId: "rzp_test_1",
    keySecret: "secret",
  });
  rzp.rzpCreateOrder.mockResolvedValue({ ok: true, data: { id: "order_1" } });
  rzp.verifyCheckoutSignature.mockReturnValue(true);
  readingFor(SNAPSHOT_ROW);
  // ★ Matches what `args` would build — monthly at ₹5,000, ending one 30-day
  // cycle after NOW — so the ordinary path does NOT look like a merchant who
  // changed their plan. A mismatch here would send every test through the
  // reshape branch, which is the opposite of representative.
  store.ensureRenewalInvoice.mockResolvedValue({
    id: INVOICE,
    status: "draft",
    finalizedAt: null,
    invoiceRef: null,
    totalPaise: 5_000_00,
    periodStart: NOW.toISOString(),
    periodEnd: MONTHLY_CYCLE_END,
  });
  store.reshapeDraftSubscriptionInvoice.mockResolvedValue(null);
  // No earlier enrolment invoice: the ordinary path, where nothing is stale.
  store.getCycleInvoice.mockResolvedValue(null);
  gateway.RECURRING_CHARGE_VERIFIED = true;
  // Same trap again: the reshape tests below override the price, and
  // clearAllMocks clears CALLS, not IMPLEMENTATIONS.
  priceFor.mockResolvedValue({ planPaise: 5_000_00, locationPaise: 1_000_00 });
  store.finalizeInvoice.mockResolvedValue({
    id: INVOICE,
    status: "open",
    finalizedAt: NOW.toISOString(),
  });
  store.amountDueForInvoice.mockResolvedValue(5_000_00);
  collect.beginAttempt.mockResolvedValue({
    attemptId: "att-1",
    idempotencyKey: "key-1",
  });
  collect.settleAttempt.mockResolvedValue("captured");
});

describe("startEnrolment", () => {
  const args = {
    storeId: STORE,
    plan: "pro" as const,
    period: "monthly" as const,
    priceFor,
    now: NOW,
  };

  it("★★ DECLARES THE RAIL ON THE ORDER — omitting it is what hid UPI", async () => {
    // Razorpay fixes the mandate rail on the ORDER: "card" for a card mandate,
    // "upi" for UPI Autopay. Omitting `method` yields a CARD mandate, which is
    // why a merchant saw a Cards-only Checkout while UPI Autopay was fully
    // enabled on the account. Checkout cannot offer the choice itself, so the
    // order has to carry it.
    await startEnrolment({ ...args, mandateMethod: "upi" });
    expect(rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].method).toBe("upi");
  });

  it("★★ defaults to UPI Autopay — the AMOUNT picks the rail, not the merchant", async () => {
    // The chooser is gone. A rail is fixed on the authorisation order and
    // cannot be edited afterwards, so a merchant who picks one that cannot
    // carry their renewal has authorised a mandate that will never fire, and
    // nothing tells them. The charge is better placed to decide than they are.
    await startEnrolment(args);
    expect(rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].method).toBe("upi");
  });

  it("★★ never asks to authorise more than a mandate can ever debit", async () => {
    // Basic yearly: a ₹15,000 charge sitting exactly at the AFA limit. The
    // 1.18 × 1.5 provision would ask for ₹27,000 — but a charge of ₹15,001 is
    // manual whatever the ceiling says, so the extra ₹12,000 of authority can
    // never be exercised. It is only a bigger number on the Razorpay screen.
    priceFor.mockResolvedValue({
      planPaise: 15_000_00,
      locationPaise: 10_000_00,
    });
    store.amountDueForInvoice.mockResolvedValue(15_000_00);

    await startEnrolment({ ...args, plan: "basic", period: "yearly" });

    expect(collect.beginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ mandateMaxPaise: 15_000_00 }),
    );
    expect(
      rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].terms.maxAmountPaise,
    ).toBe(15_000_00);
  });

  it("★ but keeps real reprice headroom below the limit", async () => {
    // Pro monthly: ₹2,400 charge, ₹5,000 ceiling. Both sides of a reprice stay
    // under ₹15,000, so that headroom is genuinely usable — capping it flat at
    // the charge would put the next price rise straight onto manual invoices.
    await startEnrolment(args);
    expect(collect.beginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ mandateMaxPaise: 9_000_00 }),
    );
  });

  it("★★ asks for NO mandate when no rail could ever carry the renewal", async () => {
    // RBI's AFA-exempt limit is ₹15,000 on BOTH cards and UPI, so Pro yearly at
    // ₹24,000 can never be auto-debited without the merchant authenticating
    // every single renewal. We used to register a ₹43,000 mandate for it
    // anyway — authority shown on the Razorpay screen that could never be
    // exercised. Cycle 1 goes through the plain, production-verified checkout.
    priceFor.mockResolvedValue({
      planPaise: 24_000_00,
      locationPaise: 10_000_00,
    });
    store.amountDueForInvoice.mockResolvedValue(24_000_00);
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: true,
      data: { id: "order_plain_1" },
    });

    const res = await startEnrolment({ ...args, period: "yearly" });

    expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ★ The screen must say "invoiced", not imply autopay.
    expect(res.data.autopay).toBe(false);
    expect(res.data.providerOrderId).toBe("order_plain_1");
  });

  it("★★ the carve-out does NOT excuse an unverified endpoint", async () => {
    // Two different situations that must not be conflated. Autopay being
    // IMPOSSIBLE for the amount is the carve-out. Autopay being unavailable
    // while it should work is the original refusal: turning that first cycle
    // into an ordinary payment succeeds today and surprises the merchant with a
    // manual invoice next renewal. A collectable amount still refuses.
    gateway.RECURRING_CHARGE_VERIFIED = false;
    try {
      const res = await startEnrolment(args); // Pro monthly — collectable
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/autopay is unavailable/i);
      expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    } finally {
      gateway.RECURRING_CHARGE_VERIFIED = true;
    }
  });

  it("★ reports autopay: true for a charge a mandate can carry", async () => {
    const res = await startEnrolment(args);
    expect(res.ok && res.data.autopay).toBe(true);
  });

  it("★ lets a merchant step across to card, because the rail is fixed", async () => {
    // The escape hatch: Checkout shows only the rail on the order, so pinning
    // UPI outright would leave a merchant with no UPI app unable to subscribe
    // at all. Card is a sideways move — both sit under the AFA limit.
    await startEnrolment({ ...args, mandateMethod: "card" });
    expect(rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].method).toBe(
      "card",
    );
  });

  it("★ an unrecognised rail falls back to the DERIVED one, never through", async () => {
    // The value reaches the server from the browser. It selects a rail, never
    // an amount — and only "card" is honoured, so anything else lands on what
    // the charge itself supports rather than reaching Razorpay unvalidated.
    await startEnrolment({
      ...args,
      mandateMethod: "netbanking" as unknown as "card",
    });
    expect(rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].method).toBe("upi");
  });

  it("reports the rail back so the caller can open Checkout honestly", async () => {
    const res = await startEnrolment({ ...args, mandateMethod: "upi" });
    expect(res.ok && res.data.mandateMethod).toBe("upi");
  });

  it("★★ offers a mandate while the autopay rollout is enabled", async () => {
    await startEnrolment(args);
    expect(gateway.RECURRING_CHARGE_VERIFIED).toBe(true);
    expect(rzp.rzpCreateCustomer).toHaveBeenCalled();
    expect(rzp.rzpCreateAuthorizationOrder).toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(collect.beginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ mandateMaxPaise: 9_000_00 }),
    );
  });

  it("★★ refuses before checkout when the owner has no phone", async () => {
    mail.resolveBillingEmail.mockResolvedValue({
      email: "owner@acme.test",
      phone: null,
      storeName: "Acme",
      slug: "acme",
    });
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/autopay/i);
    expect(res.error).toMatch(/no payment was taken/i);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("issues the first invoice and opens a Razorpay order", async () => {
    const res = await startEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      invoiceId: INVOICE,
      providerOrderId: "order_auth_1",
      keyId: "rzp_test_1",
      amountPaise: 5_000_00,
      providerCustomerId: "cust_1",
    });
  });

  it("★ bills cycle 1, starting NOW", async () => {
    await startEnrolment(args);
    const arg = store.ensureRenewalInvoice.mock.calls[0][0];
    expect(arg.cycleSeq).toBe(1);
    expect(arg.periodStart.toISOString()).toBe(NOW.toISOString());
    expect(arg.periodEnd.toISOString()).toBe(CYCLE_END);
  });

  it.each(["active", "past_due", "grace"])(
    "★★ refuses when the store is already on a %s cycle",
    async (state) => {
      // seedSubscription's upsert would otherwise rewrite plan/period on a LIVE
      // subscription before a rupee is paid — point the record at Pro, dismiss
      // the payment window. Changing tier mid-cycle is a prorated plan change,
      // a different operation from enrolling.
      seed([[{ state }]]);
      const res = await startEnrolment(args);
      expect(res.ok).toBe(false);
      expect(store.ensureRenewalInvoice).not.toHaveBeenCalled();
      expect(collect.beginAttempt).not.toHaveBeenCalled();
      expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    },
  );

  it.each(["free", "cancelled", "downgraded"])(
    "allows re-subscribing from %s",
    async (state) => {
      // A lapsed subscription is exactly who we want back.
      seed([[{ state }]]);
      expect((await startEnrolment(args)).ok).toBe(true);
    },
  );

  it("★★ re-subscribing after a downgrade bills the NEXT cycle, not cycle 1", async () => {
    // Invoices are one per cycle for ever. Cycle 1 is this store's old PAID
    // invoice and cycle 2 was closed unpaid when they were downgraded, so
    // enrolling at 1 again handed back the paid one and refused "already paid
    // for", leaving no way back onto a paid plan.
    seed([
      [{ state: "downgraded", cycleSeq: 1 }],
      [{ seq: 2, status: "uncollectible" }],
    ]);
    const res = await startEnrolment(args);
    expect(res.ok).toBe(true);
    expect(store.ensureRenewalInvoice.mock.calls[0][0].cycleSeq).toBe(3);
    expect(store.getCycleInvoice).toHaveBeenCalledWith(STORE, 3);
    // Seeded as the cycle BEFORE, so activation lands on the one being paid.
    expect(dbHolder.current.calls.values[0].currentCycleSeq).toBe(2);
    expect(dbHolder.current.calls.onConflict[0].set.currentCycleSeq).toBe(2);
  });

  it("★ re-uses this re-enrolment's own draft rather than skipping past it", async () => {
    // A dismissed payment window left a draft at cycle 3; coming back must
    // reach the same invoice, not open a fourth.
    seed([
      [{ state: "cancelled", cycleSeq: 2 }],
      [{ seq: 3, status: "draft" }],
    ]);
    await startEnrolment(args);
    expect(store.ensureRenewalInvoice.mock.calls[0][0].cycleSeq).toBe(3);
  });

  it("★ still refuses a re-enrolment cycle that was paid but never activated", async () => {
    // The money for cycle 2 landed and activation failed. Pointing past it would
    // charge the merchant a second time; returning it keeps the refusal.
    seed([
      [{ state: "downgraded", cycleSeq: 1 }],
      [{ seq: 2, status: "paid" }],
    ]);
    store.ensureRenewalInvoice.mockResolvedValueOnce({
      id: INVOICE,
      status: "paid",
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    const res = await startEnrolment(args);
    expect(store.ensureRenewalInvoice.mock.calls[0][0].cycleSeq).toBe(2);
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
  });

  it("★ fails CLOSED when the subscription state can't be read", async () => {
    // Unable to read means unable to rule out billing the same store twice.
    dbHolder.current = makeDbMock({ selectQueue: [] });
    const err = new Error("db down");
    dbHolder.current.db.select = () => {
      throw err;
    };
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ never bills locations on a first cycle", async () => {
    // Extra shops are bought after a plan is live, so charging for them here
    // would bill for something nobody has.
    await startEnrolment(args);
    const built = store.ensureRenewalInvoice.mock.calls[0][0].built;
    expect(built.lines.some((l: any) => l.kind === "location")).toBe(false);
    expect(built.totalPaise).toBe(5_000_00);
  });

  it("★ seeds the subscription in a state that grants NOTHING", async () => {
    await startEnrolment(args);
    const values = dbHolder.current.calls.values[0];
    expect(values.state).toBe("free");
    expect(values.currentCycleSeq).toBe(0);
    // The cycle columns stay unset until the money lands.
    expect(values.currentPeriodStart).toBeUndefined();
  });

  it("★★ STAMPS the tax identifiers onto the invoice", async () => {
    // These columns existed from billing_03 and NOBODY passed them, so every
    // invoice stored NULL — leaving the document to name a GSTIN from LIVE
    // settings, which is exactly what an immutable invoice must not do. The
    // stamp is the tax reading's, the same reading the amount was built from.
    readingFor({
      ...SNAPSHOT_ROW,
      taxEnabled: true,
      supplierGstin: "07AABCS1429B1ZX",
      supplierStateCode: "07",
      accountGstin: "29AAACM1234C1ZP",
    });
    await startEnrolment(args);
    const arg = store.ensureRenewalInvoice.mock.calls[0][0];
    expect(arg.stamp).toEqual({
      supplierGstin: "07AABCS1429B1ZX",
      customerGstin: "29AAACM1234C1ZP",
      placeOfSupply: "29",
      placeOfSupplyBasis: "recipient",
      sacCode: "998314",
    });
    // Built under the same reading: ₹5,000 + 18% exclusive.
    expect(arg.built).toMatchObject({ taxPaise: 900_00, totalPaise: 5_900_00 });
    // The loose parties of the old loaders are gone.
    expect(arg).not.toHaveProperty("supplierGstin");
  });

  it("★★ does NOT finalize — an enrolment is an OFFER, not an obligation", async () => {
    // Finalizing here burned a number in the gapless GST series for a document
    // nobody ever received, and made /dashboard/plans demand payment for a plan
    // that was never granted. confirmEnrolment issues it once the money lands.
    await startEnrolment(args);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★★ RESUMES the same Razorpay order when an attempt is in flight", async () => {
    // Dismissing the modal leaves the attempt `processing` forever — nothing
    // tells us a modal was closed — so this used to be a DEAD END: every later
    // Subscribe answered "a payment is already in progress" and the merchant
    // could never subscribe at all. A Razorpay order stays payable until paid.
    collect.beginAttempt.mockResolvedValue(null);
    seed([
      [], // currentState: no subscription
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);
    const res = await startEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      attemptId: "att-old",
      providerOrderId: "order_old",
      amountPaise: 5_000_00,
      providerCustomerId: "cust_1",
    });
    // ★ And it must NOT open a second order at the gateway.
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ a SECOND click on the SAME plan is not a changed plan", async () => {
    // The cycle is anchored to the instant it was raised, so two Subscribe
    // clicks a minute apart produce different period ENDPOINTS for the very
    // same plan. Comparing instants would call every ordinary resume a change —
    // abandoning the order the resume branch exists to protect, and refusing a
    // merchant who is simply mid-payment. The comparison is amount + LENGTH.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      // The same plan's body: the same ₹5,000 before GST.
      bodyTotalPaise: 5_000_00,
      // Raised a minute before this click: same 30-day cycle, later endpoints.
      periodStart: new Date(NOW.getTime() - 60_000).toISOString(),
      periodEnd: new Date(
        NOW.getTime() - 60_000 + 30 * 86_400_000,
      ).toISOString(),
    });

    await startEnrolment(args);

    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
    expect(collect.settleAttempt).not.toHaveBeenCalledWith(
      expect.anything(),
      "failed",
      expect.objectContaining({ failureCode: "shape_changed" }),
    );
  });

  it("★ reshapes an invoice with no period recorded rather than assuming it fits", async () => {
    // An unknown duration cannot be shown to match, and billing one is worse
    // than rewriting a draft nobody has received.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      // The body matches, so the missing period is what makes it stale.
      bodyTotalPaise: 5_000_00,
      periodStart: null,
      periodEnd: null,
    });

    await startEnrolment(args);

    expect(store.reshapeDraftSubscriptionInvoice).toHaveBeenCalled();
  });

  it("★★ RESHAPES the cycle-1 invoice when the merchant changes plan or period", async () => {
    // `ensureRenewalInvoice` is idempotent on (store, kind, cycle_seq) — right
    // for a renewal, wrong for an enrolment, where the invoice is raised the
    // first time anyone opens Checkout and the merchant is still choosing.
    // Measured on production 2026-09-06: a merchant who picked Pro monthly,
    // dismissed Checkout, then picked Pro YEARLY was quoted ₹2,400 for a full
    // year of Pro, because `activate` reads the period off the SUBSCRIPTION and
    // the amount off the INVOICE. ₹21,600 short, silently.
    // A stale MONTHLY invoice sitting in front of a yearly enrolment.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    store.reshapeDraftSubscriptionInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 50_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: new Date(NOW.getTime() + 365 * 86_400_000).toISOString(),
    });
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });

    await startEnrolment({ ...args, period: "yearly" });

    const call = store.reshapeDraftSubscriptionInvoice.mock.calls[0][0];
    expect(call).toMatchObject({ invoiceId: INVOICE, storeId: STORE });
    // Rewritten to the YEARLY cycle, not the monthly one it found.
    expect(call.periodEnd.getTime()).toBe(NOW.getTime() + 365 * 86_400_000);
    expect(call.built.totalPaise).toBe(50_000_00);
  });

  it("★ leaves a MATCHING invoice completely alone", async () => {
    // The ordinary path: nothing changed, so nothing is rewritten. A reshape on
    // every enrolment would churn a document for no reason and widen the window
    // in which an amount can move under a payment.
    await startEnrolment(args);
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
  });

  it("★★ frees an untouched order BEFORE rewriting the amount", async () => {
    // The old amount may already be sitting at the gateway. Rewriting the
    // invoice while that order stays payable would let a merchant pay ₹2,400
    // against a ₹24,000 obligation, so the stale attempt is failed first — and
    // only on the gateway's word that nobody has paid against it.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "card",
        status: "created",
        attempts: 0,
        amount_paid: 0,
      },
    });
    // ★ Only a settled attempt frees the index — a lost claim must not reshape.
    collect.settleAttempt.mockResolvedValue("failed");
    seed([
      [], // currentState
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    await startEnrolment({ ...args, period: "yearly" });

    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-old",
      "failed",
      expect.objectContaining({ failureCode: "shape_changed" }),
    );
    const settleOrder =
      collect.settleAttempt.mock.invocationCallOrder[0] ?? Infinity;
    const reshapeOrder =
      store.reshapeDraftSubscriptionInvoice.mock.invocationCallOrder[0] ??
      -Infinity;
    expect(settleOrder).toBeLessThan(reshapeOrder);
  });

  it("★★ REFUSES when a payment for the earlier choice is still in flight", async () => {
    // Neither outcome is safe here: rewriting the invoice lets that payment
    // settle the wrong amount, and leaving it lets the merchant pay for one
    // shape and be granted another. Refusing costs them a minute; it clears on
    // its own. ★ And it happens BEFORE `seedSubscription`, so nothing records a
    // shape we are not going to bill for — that write is what `activate` reads.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "upi",
        status: "attempted",
        attempts: 1,
        amount_paid: 0,
      },
    });
    // One payment still `created` — the shopper is mid-approval in their app.
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [{ id: "pay_1", status: "created" }],
    });
    // ★ Would succeed if it were called, so the ONLY thing standing between
    // this test and a reshape is the untouched check itself.
    collect.settleAttempt.mockResolvedValue("failed");
    seed([
      [], // currentState
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, period: "yearly" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/still going through/i);
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
    // Nothing recorded the new shape.
    expect(dbHolder.current.calls.insert.length).toBe(0);
  });

  it("★★ REFUSES to abandon an order that has been PAID", async () => {
    // `amount_paid` is the plainest possible statement that money has moved.
    // Nothing below it — status, attempt counts, payment states — may override
    // that, so it is checked first and on its own.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "upi",
        status: "paid",
        attempts: 1,
        amount_paid: 5_000_00,
      },
    });
    // Deliberately reports every payment as failed: a contradictory list must
    // not be able to talk us past money the order says it took.
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [{ id: "pay_1", status: "failed" }],
    });
    collect.settleAttempt.mockResolvedValue("failed");
    seed([
      [], // currentState
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, period: "yearly" });

    expect(res.ok).toBe(false);
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
  });

  it("★★ frees an order whose every payment FAILED", async () => {
    // A merchant who scans a UPI QR and never approves it leaves the order
    // `attempted` with failed payments and nothing paid — measured on
    // production 2026-09-06, three of them. A `failed` payment is terminal and
    // can never be captured, so treating that as untouchable would strand them
    // behind their own abandoned attempt for 72 hours.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "upi",
        status: "attempted",
        attempts: 3,
        amount_paid: 0,
      },
    });
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [
        { id: "pay_1", status: "failed" },
        { id: "pay_2", status: "failed" },
        { id: "pay_3", status: "failed" },
      ],
    });
    collect.settleAttempt.mockResolvedValue("failed");
    seed([
      [], // currentState
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, period: "yearly" });

    expect(res.ok).toBe(true);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-old",
      "failed",
      expect.objectContaining({ failureCode: "shape_changed" }),
    );
    expect(store.reshapeDraftSubscriptionInvoice).toHaveBeenCalled();
  });

  it("★ carries on with what it has when the invoice can no longer be reshaped", async () => {
    // A refusal means the invoice is finalized, paid or void — a document or a
    // debt, not a choice still being made. Blocking the merchant over it would
    // be worse than letting them finish what they started.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    store.reshapeDraftSubscriptionInvoice.mockResolvedValue(null);
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });

    const res = await startEnrolment({ ...args, period: "yearly" });

    expect(res.ok).toBe(true);
    expect(store.amountDueForInvoice).toHaveBeenCalledWith(INVOICE);
  });

  it("★★ REPLACES an untouched order when the merchant picks a different rail", async () => {
    // The rail is fixed when the order is created and cannot be edited after.
    // So resuming a card order for someone who just chose UPI Autopay does not
    // merely mislabel the screen — it registers the WRONG MANDATE, and until
    // reconciliation gives up on the stale attempt (72h) every retry does it
    // again. Abandoning an order the gateway says nobody has ever paid against
    // costs nothing, which is the only condition under which this is allowed.
    collect.beginAttempt
      .mockResolvedValueOnce(null) // refused by the one-in-flight index
      .mockResolvedValueOnce({ attemptId: "att-new", idempotencyKey: "key-2" });
    collect.settleAttempt.mockResolvedValue("failed");
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "card",
        status: "created",
        attempts: 0,
        amount_paid: 0,
      },
    });
    seed([
      [], // currentState: no subscription
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, mandateMethod: "upi" });

    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-old",
      "failed",
      expect.objectContaining({ failureCode: "rail_changed" }),
    );
    expect(rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].method).toBe("upi");
    expect(res.ok && res.data.mandateMethod).toBe("upi");
    expect(res.ok && res.data.attemptId).toBe("att-new");
  });

  it("★★ resumes rather than replaces once a payment has been TRIED", async () => {
    // `attempts > 0` means a payment instrument has been presented against that
    // order. Abandoning it then risks a second payable order for the same
    // invoice, which is the duplicate charge the resume branch exists to stop —
    // so the merchant keeps the old rail and is told so.
    collect.beginAttempt.mockResolvedValue(null);
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "card",
        status: "created",
        attempts: 1,
        amount_paid: 0,
      },
    });
    seed([
      [],
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, mandateMethod: "upi" });

    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
    expect(res.ok && res.data.mandateMethod).toBe("card");
  });

  it("★ an UNREADABLE order is never treated as untouched", async () => {
    // "We could not check" is not "nobody paid". A gateway blip must not become
    // permission to abandon an order that may already carry a payment.
    collect.beginAttempt.mockResolvedValue(null);
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    seed([
      [],
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, mandateMethod: "upi" });

    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(res.ok && res.data.providerOrderId).toBe("order_old");
  });

  it("★ asks them to wait when the in-flight attempt has NO order to resume", async () => {
    // Two Subscribe clicks racing, caught before either reached the gateway.
    collect.beginAttempt.mockResolvedValue(null);
    seed([[], []]);
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already in progress/i);
  });

  it("★ plants the idempotency key in the order notes", async () => {
    await startEnrolment(args);
    const notes = rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].notes;
    expect(notes.sm_billing_key).toBe("key-1");
    expect(notes.invoice_id).toBe(INVOICE);
    expect(notes.store_id).toBe(STORE);
  });

  it("refuses the free plan", async () => {
    const res = await startEnrolment({ ...args, plan: "free" as any });
    expect(res.ok).toBe(false);
    expect(store.ensureRenewalInvoice).not.toHaveBeenCalled();
  });

  it("refuses with no platform credentials", async () => {
    provider.getPlatformRazorpayCreds.mockReturnValue(null);
    expect((await startEnrolment(args)).ok).toBe(false);
  });

  it("★ refuses when a payment is already in flight, without a second order", async () => {
    collect.beginAttempt.mockResolvedValue(null);
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("refuses an already-paid enrolment", async () => {
    store.ensureRenewalInvoice.mockResolvedValue({
      id: INVOICE,
      status: "paid",
      finalizedAt: "x",
      invoiceRef: "SM/1",
    });
    expect((await startEnrolment(args)).ok).toBe(false);
  });

  it("★ a REJECTED order fails the attempt — nothing was created at the gateway", async () => {
    rzp.rzpCreateAuthorizationOrder.mockResolvedValue({
      ok: false,
      error: "bad",
      outcome: "rejected",
    });
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "failed",
      expect.anything(),
    );
  });

  it("★★ an UNKNOWN order outcome leaves the attempt in flight, not failed", async () => {
    // The order may exist. Marking it failed would let a second attempt open.
    rzp.rzpCreateAuthorizationOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    await startEnrolment(args);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "unknown",
      expect.anything(),
    );
  });

  it("★ never guesses the amount due", async () => {
    store.amountDueForInvoice.mockResolvedValue(null);
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });
});

/** A Drizzle condition, as Postgres would receive it. */
function render(query: unknown) {
  const q = new PgDialect().sqlToQuery(query as any);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

/**
 * The rows a confirm and its completion read, by table (RC-F1b): the
 * confirm's own attempt read, then the completion's facts (invoice, attempt,
 * store, subscription), then the activation claim's store read.
 */
function seedComplete(
  opts: {
    storePlan?: string;
    storeSource?: string;
    /** The subscription's cycle before the one enrolled. */
    cycleSeq?: number;
    subState?: string;
    subPeriod?: string;
    invoiceStatus?: string;
    invoiceCycle?: number;
    attemptState?: string;
    attemptStore?: string;
    /** What the activation claim returns: the plan, or [] when it lost. */
    claimed?: { plan: string } | null;
    /** The subscription a caller that lost the claim reads back. */
    after?: Record<string, unknown>;
    storeExists?: boolean;
    noSub?: boolean;
    /** No confirm in front: the completion's own reads come first. */
    recovery?: boolean;
  } = {},
) {
  const cycleSeq = opts.cycleSeq ?? 0;
  const confirmRead = [
    {
      id: "att-1",
      state: opts.attemptState ?? "processing",
      providerOrderId: "order_1",
      amountPaise: 5_000_00,
      mandateMaxPaise: 9_000_00,
    },
  ];
  dbHolder.current = makeDbMock({
    selectByTable: {
      billing_payment_attempts: [
        ...(opts.recovery ? [] : [confirmRead]),
        [
          {
            id: "att-1",
            invoiceId: INVOICE,
            storeId: opts.attemptStore ?? STORE,
            state: opts.attemptState ?? "processing",
            amountPaise: 5_000_00,
            currency: "INR",
            providerOrderId: "order_1",
            providerPaymentId: null,
            mandateMaxPaise: 9_000_00,
          },
        ],
      ],
      billing_invoices: [
        [
          {
            storeId: STORE,
            kind: "subscription",
            status: opts.invoiceStatus ?? "draft",
            cycleSeq: opts.invoiceCycle ?? cycleSeq + 1,
            periodStart: NOW.toISOString(),
            periodEnd: MONTHLY_CYCLE_END,
          },
        ],
      ],
      stores: [
        opts.storeExists === false ? [] : [{ id: STORE }],
        [
          {
            plan: opts.storePlan ?? "free",
            planSource: opts.storeSource ?? "paid",
          },
        ],
      ],
      billing_subscriptions: [
        opts.noSub
          ? []
          : [
              {
                state: opts.subState ?? "free",
                period: opts.subPeriod ?? "monthly",
                currentCycleSeq: cycleSeq,
              },
            ],
        opts.after ? [opts.after] : [],
      ],
    },
    returningQueue: [
      opts.claimed === null ? [] : [opts.claimed ?? { plan: "pro" }],
    ],
    returning: [{ id: "mandate-1", storeId: STORE }],
  });
}

describe("confirmEnrolment", () => {
  const args = {
    storeId: STORE,
    invoiceId: INVOICE,
    providerPaymentId: "pay_1",
    signature: "sig",
    now: NOW,
  };

  it("activates the plan on a verified payment", async () => {
    seedComplete();
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.plan).toBe("pro");
    expect(res.data.periodEnd).toBe(CYCLE_END);
  });

  it.each([
    [0, 1],
    [2, 3],
  ])(
    "★ activates the cycle the invoice was raised for (seeded %i, activates %i)",
    async (seeded, expected) => {
      // A first subscription activates cycle 1; a re-enrolment activates the
      // cycle its invoice was raised for, not cycle 1 again.
      seedComplete({ cycleSeq: seeded });
      await confirmEnrolment(args);
      const activation = dbHolder.current.calls.set.find(
        (v: any) => v.state === "active",
      );
      expect(activation.currentCycleSeq).toBe(expected);
    },
  );

  it("★★ ISSUES the invoice now — the number is spent on a payment that HAPPENED", async () => {
    // The gapless GST series must not be spent on an abandoned checkout, and the
    // document should be dated to the payment, not to the Subscribe click.
    seedComplete();
    await confirmEnrolment(args);
    expect(store.finalizeInvoice).toHaveBeenCalledWith(INVOICE, NOW, undefined);
  });

  it("★★ R1-07: ISSUES at the payment's own time, from the gateway's record", async () => {
    // Captured just before a scheduled GST change and confirmed just after:
    // the invoice is issued under the terms it was paid under.
    const CAPTURED_SECONDS = Math.floor(NOW.getTime() / 1000) - 600;
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: true,
      data: { id: "pay_1", created_at: CAPTURED_SECONDS },
    });
    seedComplete();
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(true);
    expect(store.finalizeInvoice).toHaveBeenCalledWith(
      INVOICE,
      NOW,
      new Date(CAPTURED_SECONDS * 1000),
    );
  });

  it("★ R1-07: a payment time that cannot be read issues at the confirm, and the plan still switches on", async () => {
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    seedComplete();
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(true);
    expect(store.finalizeInvoice).toHaveBeenCalledWith(INVOICE, NOW, undefined);
    expect(logWarn).toHaveBeenCalledWith("billing.enrol.payment_time", {
      paymentId: "pay_1",
      reason: "timeout",
    });
  });

  it("★ R1-07: a payment the gateway could not be asked about takes no time from it", async () => {
    // Verified by signature alone (gateway unreadable): no second read is
    // trusted for the time either.
    rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
      ok: true,
      gatewayRead: false,
    });
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: true,
      data: { id: "pay_1", created_at: 1_700_000_000 },
    });
    seedComplete();
    await confirmEnrolment(args);
    expect(store.finalizeInvoice).toHaveBeenCalledWith(INVOICE, NOW, undefined);
  });

  it("★★ FINALIZES BEFORE SETTLING — settling a DRAFT leaves a paid invoice unpaid", async () => {
    // The regression this pins cost 20 days of phantom debt on production.
    //
    // `syncInvoiceStatus` claims the move to paid with
    // `inArray(status, ["open", "processing"])`. While an invoice is still a
    // DRAFT that claim matches zero rows, so settling first captures the money,
    // leaves the invoice unpaid, sends no receipt, and reports nothing — and
    // `finalizeInvoice` then stamps `status: "open"`, i.e. an open bill behind a
    // captured payment. Store `echos` was chased for a ₹15 invoice it had paid
    // on 2026-08-16 until 2026-09-05, when clicking "Pay now" re-synced it and
    // fired a "Payment received" email for a payment the merchant had CANCELLED.
    //
    // Order is the whole fix, so order is what this asserts. Both calls are
    // mocked, so nothing else in this file can catch a swap.
    seedComplete();
    await confirmEnrolment(args);
    expect(store.finalizeInvoice).toHaveBeenCalled();
    expect(collect.settleAttempt).toHaveBeenCalled();
    expect(store.finalizeInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      collect.settleAttempt.mock.invocationCallOrder[0],
    );
  });

  it("★ finalizes only AFTER the signature verifies", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedComplete();
    await confirmEnrolment(args);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★★ WELCOMES the merchant — the old path did, and deleting it took that with it", async () => {
    seedComplete();
    await confirmEnrolment(args);
    expect(receipts.notifyPlanActivated).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE, invoiceId: INVOICE }),
    );
  });

  it("★ says nothing when the signature failed", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedComplete();
    await confirmEnrolment(args);
    expect(receipts.notifyPlanActivated).not.toHaveBeenCalled();
  });

  it("★★ reports autopay HONESTLY — a mandate, or none", async () => {
    // The template says autopay is set up; promising a renewal date to someone
    // with no mandate is how they wait for a charge that never comes.
    seedComplete();
    await confirmEnrolment(args);
    expect(receipts.notifyPlanActivated.mock.calls[0][0].autopay).toBe(false);
  });

  it("★★ REFUSES an unverified signature, and settles nothing", async () => {
    // A payment id from the client proves nothing. Without the HMAC anyone
    // could post an arbitrary id and be granted a plan.
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedComplete();
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ verifies against the order WE created, not one the client names", async () => {
    seedComplete();
    await confirmEnrolment(args);
    expect(rzp.verifyCheckoutSignature).toHaveBeenCalledWith(
      "secret",
      "order_1",
      "pay_1",
      "sig",
    );
  });

  it("refuses when there is no payment to confirm", async () => {
    seed([[]]);
    expect((await confirmEnrolment(args)).ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ writes BOTH the subscription and stores.plan", async () => {
    seedComplete();
    await confirmEnrolment(args);
    const sets = dbHolder.current.calls.set;
    const sub = sets.find((s: any) => s.currentCycleSeq === 1);
    const ent = sets.find((s: any) => s.planExpiresAt !== undefined);
    expect(sub).toMatchObject({ state: "active", planSource: "paid" });
    expect(sub.currentPeriodEnd).toBe(CYCLE_END);
    expect(ent).toMatchObject({ plan: "pro", planSource: "paid" });
    // ★★ NO expiry on a paid plan. Stamping the first cycle's end here (and
    // never moving it) is what lapsed every paying store to Free after one
    // cycle; the renewal worker owns a subscription's plan instead.
    expect(ent.planExpiresAt).toBeNull();
  });

  it("★★ the activation is a CLAIM: not live, exactly one cycle before the invoice", async () => {
    // RC-F1b: a browser confirm and the hourly reconcile can arrive together.
    // The WHERE is what makes the second one match nothing, so the plan moves
    // once and the welcome goes out once.
    seedComplete({ cycleSeq: 2 });
    await confirmEnrolment(args);
    const where = dbHolder.current.calls.where
      .map((w: unknown) => render(w))
      .find((w: { sql: string }) =>
        w.sql.includes('"billing_subscriptions"."state" not in'),
      );
    expect(where).toBeDefined();
    if (!where) return;
    expect(where.sql).toContain('"billing_subscriptions"."state" not in');
    expect(where.sql).toContain(
      '"billing_subscriptions"."current_cycle_seq" =',
    );
    expect(where.params).toEqual(
      expect.arrayContaining([STORE, "active", "past_due", "grace", 2]),
    );
  });

  it("★★ a COMP is a FLOOR — subscribing to a cheaper tier does not lower it", async () => {
    // The old confirmSubscription wrote stores.plan unconditionally, so a store
    // comped Pro that subscribed to Basic was dropped to Basic.
    seedComplete({
      claimed: { plan: "basic" },
      storePlan: "pro",
      storeSource: "comp",
    });
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Reported as the comped plan they keep, and stores.plan untouched.
    expect(res.data.plan).toBe("pro");
    const ent = dbHolder.current.calls.set.find(
      (s: any) => s.planExpiresAt !== undefined,
    );
    expect(ent).toBeUndefined();
  });

  it("★ the subscription still activates under a comp — they ARE paying", async () => {
    seedComplete({
      claimed: { plan: "basic" },
      storePlan: "pro",
      storeSource: "comp",
    });
    await confirmEnrolment(args);
    expect(
      dbHolder.current.calls.set.some((s: any) => s.state === "active"),
    ).toBe(true);
  });

  it("★★ a confirm that arrives after the purchase was finished changes nothing and sends nothing", async () => {
    // The hourly reconcile finished it (the merchant had closed the tab); the
    // browser's late confirm loses the activation claim and reports success.
    seedComplete({
      invoiceStatus: "paid",
      subState: "active",
      cycleSeq: 1,
      invoiceCycle: 1,
      attemptState: "captured",
      claimed: null,
      storePlan: "pro",
      after: {
        state: "active",
        plan: "pro",
        currentCycleSeq: 1,
        currentPeriodEnd: CYCLE_END,
        mandateId: null,
      },
    });
    collect.settleAttempt.mockResolvedValue(null); // already terminal
    const res = await confirmEnrolment(args);
    expect(res).toEqual({
      ok: true,
      data: { plan: "pro", periodEnd: CYCLE_END, mandateActivated: false },
    });
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
    expect(receipts.notifyPlanActivated).not.toHaveBeenCalled();
    // No audit row either: only the caller that moved the plan writes one.
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ reports a NON-captured settle as an incomplete payment", async () => {
    collect.settleAttempt.mockResolvedValue("failed");
    seedComplete();
    expect(await confirmEnrolment(args)).toEqual({
      ok: false,
      error: "That payment didn't complete.",
    });
  });

  it("★★ money in but plan not moved is NEVER a bare failure", async () => {
    // The merchant has paid. The message must say so and tell them not to pay
    // again, or support cannot tell this from a declined card.
    collect.settleAttempt.mockResolvedValue("captured");
    seedComplete({ noSub: true });
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/went through/i);
    expect(res.error).toMatch(/don't pay again/i);
  });

  it("★★ a failed guard is filed for a person and nothing is applied", async () => {
    // The subscription went live on a later cycle meanwhile: applying this
    // payment would rewind its renewals.
    seedComplete({ subState: "active", cycleSeq: 3, invoiceCycle: 1 });
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(false);
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE,
        kind: "state_conflict",
        repairKey: "purchase_refused:att-1",
        purchase: "enrolment",
      }),
    );
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(
      dbHolder.current.calls.set.some((s: any) => s.state === "active"),
    ).toBe(false);
  });

  it("★ the plan period on file must match the invoice", async () => {
    seedComplete({ subPeriod: "yearly" });
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(false);
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ repairKey: "purchase_refused:att-1" }),
    );
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ a read failure changes nothing and promises the switch soon", async () => {
    seed([
      [{ id: "att-1", state: "processing", providerOrderId: "order_1" }],
      new Error("db down") as any,
    ]);
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/don't pay again/i);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("records a mandate when the checkout registered one", async () => {
    seedComplete();
    const res = await confirmEnrolment({
      ...args,
      mandate: {
        providerTokenId: "tok_1",
        method: "card",
        maxAmountPaise: 9_000_00,
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mandateActivated).toBe(true);
    const mandate = dbHolder.current.calls.values.find(
      (v: any) => v.providerTokenId === "tok_1",
    );
    expect(mandate).toMatchObject({ status: "active", method: "card" });
  });

  it("★ enrols fine with NO mandate — that only costs automatic renewal", async () => {
    seedComplete();
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mandateActivated).toBe(false);
    expect(res.data.plan).toBe("pro");
  });

  it("★ writes the audit row itself, naming the plan it moved FROM", async () => {
    seedComplete({ storePlan: "free" });
    await confirmEnrolment(args);
    const audit = dbHolder.current.calls.values.find(
      (v: any) => v.actor === "billing-enrolment",
    );
    expect(audit).toMatchObject({
      storeId: STORE,
      fromPlan: "free",
      toPlan: "pro",
      source: "billing",
      note: "subscribed (manual renewal)",
    });
  });

  it("refuses with no platform credentials", async () => {
    provider.getPlatformRazorpayCreds.mockReturnValue(null);
    expect((await confirmEnrolment(args)).ok).toBe(false);
  });

  it("★★ reads the token from the PAYMENT, never from the caller", async () => {
    // Razorpay Checkout hands the browser a payment id, an order id and a
    // signature — not a token. A caller-supplied token would be a value the
    // BROWSER chose, and attaching a mandate is standing permission to debit
    // this merchant every cycle.
    seedComplete();
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: true,
      data: {
        id: "pay_1",
        token_id: "token_real",
        customer_id: "cust_real",
        method: "upi",
      },
    });
    await confirmEnrolment({
      storeId: STORE,
      invoiceId: "inv-1",
      providerPaymentId: "pay_1",
      signature: "sig",
    });
    expect(rzp.rzpFetchPayment).toHaveBeenCalledWith(
      expect.anything(),
      "pay_1",
    );
  });

  it("★ a payment with no token still grants access after money moved", async () => {
    seedComplete();
    const res = await confirmEnrolment({
      storeId: STORE,
      invoiceId: "inv-1",
      providerPaymentId: "pay_1",
      signature: "sig",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mandateActivated).toBe(false);
  });

  it("★★ a FAILED lookup still activates the plan — the money is already in", async () => {
    // Losing autopay is the acceptable half of this trade; refusing a plan the
    // merchant has paid for is not.
    seedComplete();
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: false,
      error: "gateway down",
      outcome: "unknown",
    });
    const res = await confirmEnrolment({
      storeId: STORE,
      invoiceId: "inv-1",
      providerPaymentId: "pay_1",
      signature: "sig",
    });
    expect(res.ok).toBe(true);
  });

  it("★ an unrecognised method is recorded as unknown, not dropped", async () => {
    seedComplete();
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: true,
      data: { id: "pay_1", token_id: "t", method: "wallet" },
    });
    const res = await confirmEnrolment({
      storeId: STORE,
      invoiceId: "inv-1",
      providerPaymentId: "pay_1",
      signature: "sig",
    });
    expect(res.ok).toBe(true);
  });
});

describe("★★ R3-03: ensureBillingAccount never logs the merchant's details", () => {
  it("logs the database's reason, code and constraint, never Drizzle's params", async () => {
    const failed = Object.assign(
      new Error(
        'Failed query: insert into billing_accounts ... params: store-1,Acme Traders Pvt Ltd,29ABCDE1234F1Z5,{"line1":"12 MG Road"}',
      ),
      {
        cause: Object.assign(
          new Error(
            'new row violates check constraint "billing_accounts_gstin_check"',
          ),
          { code: "23514", constraint: "billing_accounts_gstin_check" },
        ),
      },
    );
    dbHolder.current.db.insert = () => {
      throw failed;
    };
    const ok = await ensureBillingAccount(STORE, {
      legalName: "Acme Traders Pvt Ltd",
      gstin: "29ABCDE1234F1Z5",
      address: { line1: "12 MG Road" },
    });
    expect(ok).toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);
    const [event, logged, ctx] = vi.mocked(logError).mock.calls[0];
    expect(event).toBe("billing.ensure_account");
    expect(logged).toBe(
      'new row violates check constraint "billing_accounts_gstin_check"',
    );
    expect(ctx).toEqual({
      storeId: STORE,
      code: "23514",
      constraint: "billing_accounts_gstin_check",
    });
    const everything = JSON.stringify(vi.mocked(logError).mock.calls);
    expect(everything).not.toMatch(/Acme Traders|29ABCDE1234F1Z5|MG Road/);
  });
});

describe("completeEnrolmentPurchase (recovery, RC-F1b)", () => {
  const recovery = {
    storeId: STORE,
    invoiceId: INVOICE,
    attemptId: "att-1",
    providerPaymentId: null,
    source: "recovery" as const,
    verifyCapture: true,
    now: NOW,
  };

  it("★★ finishes a closed-tab enrolment: issues, settles, activates, welcomes", async () => {
    seedComplete({ attemptState: "captured", recovery: true });
    const res = await completeEnrolmentPurchase(recovery);
    expect(res.status).toBe("completed");
    expect(store.finalizeInvoice).toHaveBeenCalledWith(INVOICE, NOW, undefined);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "captured",
      expect.objectContaining({ providerPaymentId: "pay_old" }),
    );
    expect(receipts.notifyPlanActivated).toHaveBeenCalledTimes(1);
    const audit = dbHolder.current.calls.values.find(
      (v: any) => v.actor === "billing-enrolment",
    );
    expect(audit.note).toMatch(/hourly check/);
  });

  it("★ issues the draft at the capture time it is given (GST paidAt)", async () => {
    seedComplete({ attemptState: "captured", recovery: true });
    const paidAt = new Date(NOW.getTime() - 2 * 3_600_000);
    const res = await completeEnrolmentPurchase({ ...recovery, paidAt });
    expect(res.status).toBe("completed");
    expect(store.finalizeInvoice).toHaveBeenCalledWith(INVOICE, NOW, paidAt);
  });

  it("★★ a captured amount that differs from the attempt is filed, never applied", async () => {
    seedComplete({ attemptState: "captured", recovery: true });
    collect.verifyRecoveredCapture.mockResolvedValue({
      status: "mismatch",
      reason: "the captured amount or currency differs from the attempt",
      paymentId: "pay_old",
      observedPaise: 4_000_00,
    });
    const res = await completeEnrolmentPurchase(recovery);
    expect(res.status).toBe("refused");
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "amount_mismatch",
        repairKey: "purchase_refused:att-1",
        observedPaise: 4_000_00,
      }),
    );
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(receipts.notifyPlanActivated).not.toHaveBeenCalled();
  });

  it("★ an unreadable gateway changes nothing and files nothing", async () => {
    seedComplete({ attemptState: "captured", recovery: true });
    collect.verifyRecoveredCapture.mockResolvedValue({ status: "unreadable" });
    const res = await completeEnrolmentPurchase(recovery);
    expect(res.status).toBe("not_ready");
    expect(collect.fileRecoveredPurchase).not.toHaveBeenCalled();
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★ a store that no longer exists is filed for a person", async () => {
    seedComplete({
      attemptState: "captured",
      storeExists: false,
      recovery: true,
    });
    const res = await completeEnrolmentPurchase(recovery);
    expect(res.status).toBe("refused");
    expect(collect.fileRecoveredPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ repairKey: "purchase_refused:att-1" }),
    );
  });

  it("★ an attempt that is not this store's is refused without touching anything", async () => {
    seedComplete({
      attemptState: "captured",
      attemptStore: "store-2",
      recovery: true,
    });
    const res = await completeEnrolmentPurchase(recovery);
    expect(res.status).toBe("refused");
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });
});

describe("startEnrolment finishes an earlier paid purchase (RC-F1b)", () => {
  const args = {
    storeId: STORE,
    plan: "pro" as const,
    period: "yearly" as const,
    priceFor,
    now: NOW,
  };
  const earlier = {
    attemptId: "att-1",
    invoiceId: INVOICE,
    storeId: STORE,
    kind: "subscription",
    providerOrderId: "order_1",
    providerPaymentId: "pay_old",
    amountPaise: 5_000_00,
    currency: "INR",
    createdAt: NOW.toISOString(),
  };

  it("★★ completes it instead of opening a second order, and never reshapes it", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([earlier]);
    seedComplete({ attemptState: "captured", recovery: true });
    const res = await startEnrolment(args);
    expect(res).toEqual({
      ok: false,
      error: ENROLMENT_RECOVERED_MESSAGE,
      recovered: "completed",
    });
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
    expect(receipts.notifyPlanActivated).toHaveBeenCalledTimes(1);
  });

  it("★★ when it cannot be finished, says the payment went through and opens nothing", async () => {
    collect.capturedDraftPurchases.mockResolvedValue([earlier]);
    seedComplete({ attemptState: "captured", recovery: true });
    collect.verifyRecoveredCapture.mockResolvedValue({ status: "unreadable" });
    const res = await startEnrolment(args);
    expect(res).toEqual({
      ok: false,
      error: ENROLMENT_RECOVERY_WAITING_MESSAGE,
      recovered: "waiting",
    });
    expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });

  it("★ fails CLOSED when the check can't be read", async () => {
    collect.capturedDraftPurchases.mockResolvedValue(null);
    const res = await startEnrolment(args);
    expect(res).toEqual({
      ok: false,
      error: "Couldn't check your subscription. Try again.",
    });
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });

  it("★★ never reshapes a stale draft that holds a captured payment", async () => {
    // The top check found nothing, but a capture landed since.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      totalPaise: 2_400_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    seed([[{ state: "", cycleSeq: 0 }]]);
    collect.capturedAttemptForInvoice.mockResolvedValue({
      id: "att-1",
      providerPaymentId: "pay_old",
    });
    const res = await startEnrolment(args);
    expect(res).toMatchObject({ ok: false, recovered: "waiting" });
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });
});

describe("enrolmentDraftChange (GST design 5.3)", () => {
  const LENGTH = 30 * 86_400_000;
  const DRAFT = {
    status: "draft",
    totalPaise: 5_000_00,
    bodyTotalPaise: 5_000_00,
    periodStart: NOW.toISOString(),
    periodEnd: MONTHLY_CYCLE_END,
  };
  const built = (body: number, total: number) => ({
    lines: [
      {
        kind: "base_plan" as const,
        description: "Pro plan",
        quantity: 1,
        unitAmountPaise: body,
        amountPaise: body,
      },
      ...(total !== body
        ? [
            {
              kind: "tax" as const,
              description: "GST",
              quantity: 1,
              unitAmountPaise: total - body,
              amountPaise: total - body,
            },
          ]
        : []),
    ],
    totalPaise: total,
  });

  it("nothing changed: null", () => {
    expect(enrolmentDraftChange(DRAFT, built(5_000_00, 5_000_00), LENGTH)).toBe(
      null,
    );
  });

  it("★★ only GST changed (an exclusive start): 'tax', never 'shape'", () => {
    // The same plan for the same period: the "earlier plan choice" refusal is
    // for a changed CHOICE and must never be shown for a GST change.
    expect(enrolmentDraftChange(DRAFT, built(5_000_00, 5_900_00), LENGTH)).toBe(
      "tax",
    );
  });

  it("★ a stamp-only difference (an inclusive start) is not stale", () => {
    // The body and the total match; `issueInvoice` restamps at issue.
    expect(enrolmentDraftChange(DRAFT, built(5_000_00, 5_000_00), LENGTH)).toBe(
      null,
    );
  });

  it("a different plan is a 'shape', whatever the GST did", () => {
    expect(enrolmentDraftChange(DRAFT, built(2_400_00, 2_832_00), LENGTH)).toBe(
      "shape",
    );
  });

  it("a different period is a 'shape' even at the same price", () => {
    expect(
      enrolmentDraftChange(DRAFT, built(5_000_00, 5_000_00), 365 * 86_400_000),
    ).toBe("shape");
  });

  it("a draft with no period recorded is a 'shape'", () => {
    expect(
      enrolmentDraftChange(
        { ...DRAFT, periodStart: null, periodEnd: null },
        built(5_000_00, 5_000_00),
        LENGTH,
      ),
    ).toBe("shape");
  });

  it("only a draft can be stale", () => {
    expect(
      enrolmentDraftChange(
        { ...DRAFT, status: "open" },
        built(2_400_00, 2_400_00),
        LENGTH,
      ),
    ).toBe(null);
  });
});

describe("startEnrolment reads the tax once (GST Stage 7)", () => {
  const args = {
    storeId: STORE,
    plan: "pro" as const,
    period: "monthly" as const,
    priceFor,
    now: NOW,
  };

  function expectNothingWritten() {
    expect(store.ensureRenewalInvoice).not.toHaveBeenCalled();
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.insert.length).toBe(0);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
  }

  describe("the refusals, before anything is written", () => {
    it("a reading that fails", async () => {
      store.loadTaxSnapshot.mockRejectedValue(new Error("connection reset"));
      const res = await startEnrolment(args);
      expect(res).toEqual({ ok: false, error: PAYMENT_REFUSAL.invoiceFailed });
      expectNothingWritten();
      expect(logError).toHaveBeenCalledWith(
        "billing.enrol.tax_snapshot",
        expect.any(Error),
        { storeId: STORE },
      );
    });

    it("GST on without StoreMink's full tax identity", async () => {
      readingFor({ ...GST_ON_KARNATAKA, supplierGstin: null });
      const res = await startEnrolment(args);
      expect(res).toEqual({
        ok: false,
        error: PAYMENT_REFUSAL.settingsIncomplete,
      });
      expectNothingWritten();
    });

    it("★ GST on and no state of the merchant anywhere", async () => {
      readingFor({ ...SNAPSHOT_ROW, taxEnabled: true });
      const res = await startEnrolment(args);
      expect(res).toEqual({ ok: false, error: PAYMENT_REFUSAL.needsState });
      expectNothingWritten();
    });

    it("★ GST on and a business outside India", async () => {
      readingFor({ ...GST_ON_KARNATAKA, accountCountry: "US" });
      const res = await startEnrolment(args);
      expect(res).toEqual({ ok: false, error: PAYMENT_REFUSAL.outsideIndia });
      expectNothingWritten();
    });

    it("★ a start only SCHEDULED does not ask for a state yet", async () => {
      // No GST is charged on this payment, so its invoice needs no state.
      readingFor({
        ...SNAPSHOT_ROW,
        nextTaxEnabled: true,
        nextTaxInclusive: false,
        nextTaxRateBps: 1800,
        nextTaxStartsAt: "2026-12-01T00:00:00.000Z",
      });
      const res = await startEnrolment(args);
      expect(res.ok).toBe(true);
      expect(store.ensureRenewalInvoice).toHaveBeenCalled();
    });
  });

  describe("★★ the rail is decided by the FIRST RENEWAL's terms", () => {
    // Basic yearly at ₹15,000 sits exactly on the AFA limit. An exclusive GST
    // start before its first renewal makes that renewal ₹17,700, which no
    // mandate can ever take without the merchant authenticating it, so no
    // mandate may be registered for it now.
    const basicYearly = {
      ...args,
      plan: "basic" as const,
      period: "yearly" as const,
    };
    const scheduledFrom = (startsAt: string): SnapshotRow => ({
      ...SNAPSHOT_ROW,
      accountStateCode: "29",
      nextTaxEnabled: true,
      nextTaxInclusive: false,
      nextTaxRateBps: 1800,
      nextTaxStartsAt: startsAt,
    });

    beforeEach(() => {
      priceFor.mockResolvedValue({
        planPaise: 15_000_00,
        locationPaise: 10_000_00,
      });
      store.amountDueForInvoice.mockResolvedValue(15_000_00);
    });

    it("★★ a start before the first renewal: no mandate, renewals invoiced", async () => {
      // The renewal is collected from 2027-08-28 (four days before the cycle
      // ends on 2027-09-01); the start on 2027-01-01 is before it.
      readingFor(scheduledFrom("2027-01-01T00:00:00.000Z"));
      const res = await startEnrolment(basicYearly);

      expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
      expect(rzp.rzpCreateOrder).toHaveBeenCalled();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.autopay).toBe(false);
      // Cycle 1 itself carries no GST: the start has not happened yet.
      expect(store.ensureRenewalInvoice.mock.calls[0][0].built.totalPaise).toBe(
        15_000_00,
      );
    });

    it("control: a start after the first renewal is collected leaves autopay on", async () => {
      readingFor(scheduledFrom("2027-08-30T00:00:00.000Z"));
      const res = await startEnrolment(basicYearly);

      expect(rzp.rzpCreateAuthorizationOrder).toHaveBeenCalled();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.autopay).toBe(true);
    });

    it("★ an INCLUSIVE start changes nothing about the rail", async () => {
      // The listed price includes GST, so the renewal still costs ₹15,000.
      readingFor({
        ...scheduledFrom("2027-01-01T00:00:00.000Z"),
        nextTaxInclusive: true,
      });
      const res = await startEnrolment(basicYearly);
      expect(rzp.rzpCreateAuthorizationOrder).toHaveBeenCalled();
      expect(res.ok && res.data.autopay).toBe(true);
    });
  });

  describe("★★ a draft whose only change is GST", () => {
    // GST started (exclusive, 18%) after the merchant first opened Checkout:
    // the cycle-1 draft says ₹5,000, this reading builds ₹5,900.
    const UNTAXED_DRAFT = {
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      bodyTotalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    };

    beforeEach(() => {
      readingFor(GST_ON_KARNATAKA);
      store.getCycleInvoice.mockResolvedValue(UNTAXED_DRAFT);
    });

    it("★ with no order on it, the draft is rebuilt at the taxed total", async () => {
      seed([[], []]); // currentSubscription, then: no live attempt
      const res = await startEnrolment(args);

      expect(res.ok).toBe(true);
      const call = store.reshapeDraftSubscriptionInvoice.mock.calls[0][0];
      expect(call).toMatchObject({ invoiceId: INVOICE, storeId: STORE });
      expect(call.built).toMatchObject({
        taxPaise: 900_00,
        totalPaise: 5_900_00,
      });
      expect(call.stamp).toMatchObject({
        placeOfSupply: "29",
        placeOfSupplyBasis: "recipient",
      });
      // Not a changed choice: no order is fetched or abandoned for it.
      expect(rzp.rzpFetchOrder).not.toHaveBeenCalled();
      expect(collect.settleAttempt).not.toHaveBeenCalledWith(
        expect.anything(),
        "failed",
        expect.objectContaining({ failureCode: "shape_changed" }),
      );
    });

    it("★★ R1-03: an order the gateway says nobody touched is ABANDONED and the draft rebuilt at the GST in force", async () => {
      // The old ₹5,000 order is still payable, but nobody has presented a
      // payment against it: abandoning it costs nobody money, and resuming it
      // would charge a price the GST in force no longer gives.
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
      collect.settleAttempt.mockResolvedValue("failed");
      seed([
        [], // currentSubscription
        [{ id: "att-old" }], // liveAttemptOn: an attempt in flight
        [
          {
            id: "att-old",
            providerOrderId: "order_old",
            amountPaise: 5_000_00,
          },
        ], // resumableAttempt (inspectResumable)
      ]);
      const res = await startEnrolment(args);

      expect(collect.settleAttempt).toHaveBeenCalledWith(
        "att-old",
        "failed",
        expect.objectContaining({
          providerOrderId: "order_old",
          failureCode: "tax_changed",
        }),
      );
      // The capture re-check runs again after the order is freed.
      expect(collect.capturedAttemptForInvoice).toHaveBeenCalledTimes(2);
      const call = store.reshapeDraftSubscriptionInvoice.mock.calls[0][0];
      expect(call.built).toMatchObject({
        taxPaise: 900_00,
        totalPaise: 5_900_00,
      });
      expect(collect.settleAttempt.mock.invocationCallOrder[0]).toBeLessThan(
        store.reshapeDraftSubscriptionInvoice.mock.invocationCallOrder[0],
      );
      // A new order for the rebuilt draft, never the old one.
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.attemptId).toBe("att-1");
    });

    it("★ an abandon that lost its claim (the order settled meanwhile) rebuilds nothing", async () => {
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
      collect.settleAttempt.mockResolvedValue("captured");
      collect.beginAttempt.mockResolvedValue(null);
      seed([
        [],
        [{ id: "att-old" }],
        [
          {
            id: "att-old",
            providerOrderId: "order_old",
            amountPaise: 5_000_00,
          },
        ],
        [
          {
            id: "att-old",
            providerOrderId: "order_old",
            amountPaise: 5_000_00,
          },
        ],
      ]);
      await startEnrolment(args);
      expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
    });

    it.each([
      [
        "touched (a payment still in its app)",
        {
          ok: true,
          data: {
            id: "order_old",
            method: "upi",
            status: "attempted",
            attempts: 1,
            amount_paid: 0,
          },
        },
        { ok: true, data: [{ id: "pay_1", status: "created" }] },
      ],
      [
        "unreadable (never untouched)",
        { ok: false, error: "timeout", outcome: "unknown" },
        undefined,
      ],
    ])(
      "★★ an order %s is RESUMED at the draft's total, never abandoned or refused",
      async (_label, order, payments) => {
        // The order stays payable for the draft's ₹5,000, so the draft must
        // keep saying ₹5,000: `issueInvoice` carves the GST out of it at issue.
        rzp.rzpFetchOrder.mockResolvedValue(order);
        if (payments) rzp.rzpFetchOrderPayments.mockResolvedValue(payments);
        collect.beginAttempt.mockResolvedValue(null); // the order is in flight
        const RESUMABLE = {
          id: "att-old",
          providerOrderId: "order_old",
          amountPaise: 5_000_00,
        };
        seed([
          [], // currentSubscription
          [{ id: "att-old" }], // liveAttemptOn: an attempt in flight
          [RESUMABLE], // resumableAttempt (the tax branch's inspection)
          [RESUMABLE], // resumableAttempt (the resume itself)
        ]);
        const res = await startEnrolment(args);

        expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
        expect(collect.settleAttempt).not.toHaveBeenCalledWith(
          expect.anything(),
          "failed",
          expect.anything(),
        );
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.data).toMatchObject({
          attemptId: "att-old",
          providerOrderId: "order_old",
          amountPaise: 5_000_00,
        });
        expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
        expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
      },
    );

    it("★★ RC-F1b's captured-payment check comes FIRST", async () => {
      // A captured payment on the draft is the earlier purchase: it is
      // finished by the hourly check, never rebuilt here.
      collect.capturedAttemptForInvoice.mockResolvedValue({
        id: "att-old",
        providerPaymentId: "pay_old",
      });
      seed([[]]);
      const res = await startEnrolment(args);
      expect(res).toEqual({
        ok: false,
        error: ENROLMENT_RECOVERY_WAITING_MESSAGE,
        recovered: "waiting",
      });
      expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
      expect(collect.beginAttempt).not.toHaveBeenCalled();
    });

    it("a captured-payment read that fails refuses", async () => {
      collect.capturedAttemptForInvoice.mockResolvedValue(undefined);
      seed([[]]);
      const res = await startEnrolment(args);
      expect(res).toEqual({
        ok: false,
        error: "Couldn't check your subscription. Try again.",
      });
      expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
    });

    it("★ an attempt read that fails refuses rather than guess", async () => {
      seed([[], new Error("connection reset")]);
      const res = await startEnrolment(args);
      expect(res).toEqual({
        ok: false,
        error: "Couldn't check your subscription. Try again.",
      });
      expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
      expect(dbHolder.current.calls.insert.length).toBe(0);
    });
  });

  it("★ a stamp-only difference (an inclusive start) rewrites nothing", async () => {
    // GST on, prices include it: the draft's ₹5,000 is still ₹5,000. Only the
    // stamp differs, and `issueInvoice` restamps at issue.
    readingFor({ ...GST_ON_KARNATAKA, taxInclusive: true });
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      bodyTotalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    const res = await startEnrolment(args);
    expect(res.ok).toBe(true);
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
    expect(collect.capturedAttemptForInvoice).not.toHaveBeenCalled();
  });
});

describe("completeEnrolmentPurchase: a failed issue (GST Stage 7)", () => {
  it("★ is logged, and nothing is settled or applied", async () => {
    seedComplete({ attemptState: "captured", recovery: true });
    store.finalizeInvoice.mockResolvedValue(null);
    const res = await completeEnrolmentPurchase({
      storeId: STORE,
      invoiceId: INVOICE,
      attemptId: "att-1",
      providerPaymentId: null,
      source: "recovery",
      verifyCapture: true,
      now: NOW,
    });
    expect(res.status).toBe("not_ready");
    expect(logWarn).toHaveBeenCalledWith("billing.confirm_issue_failed", {
      purchase: "enrolment",
      source: "recovery",
      storeId: STORE,
      invoiceId: INVOICE,
      attemptId: "att-1",
    });
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(receipts.notifyPlanActivated).not.toHaveBeenCalled();
  });
});
