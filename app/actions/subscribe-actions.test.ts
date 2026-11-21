/* eslint-disable @typescript-eslint/no-explicit-any */
// Subscribing on the new billing system.
//
// Every export of a "use server" file is a publicly reachable endpoint, and
// these take money and change entitlement — so the gate on each one, and the
// guard against being billed by BOTH systems at once, are what these tests are
// for. The enrolment logic itself is proved by lib/billing/enrol.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
// The action imports STORE_TAG from resolve.ts, which builds an unstable_cache
// at module scope. Stub the module rather than widening the next/cache mock —
// the constant is all this file needs.
vi.mock("@/lib/store/resolve", () => ({
  STORE_TAG: "stores",
  getCurrentStore: vi.fn(async () => ({ id: "store-1", plan: "pro" })),
}));

const access = vi.hoisted(() => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => access);

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const enrol = vi.hoisted(() => ({
  ENROLMENT_PAID_NOT_SWITCHED_MESSAGE:
    "Your payment went through, and we'll switch your plan on shortly. Please don't pay again. If it hasn't changed within a day, write to support@storemink.com.",
  startEnrolment: vi.fn(),
  confirmEnrolment: vi.fn(),
  ensureBillingAccount: vi.fn(),
  auditEnrolment: vi.fn(),
}));
vi.mock("@/lib/billing/enrol", () => enrol);

// Proved by lib/billing/plan-change.test.ts and locations.test.ts; here only
// what the actions do with a recovered purchase (RC-F1b).
const planChange = vi.hoisted(() => ({
  PLAN_CHANGE_RECOVERY_WAITING_MESSAGE:
    "Your earlier payment went through, and we'll switch your plan shortly. Please don't pay again. If it hasn't changed within a day, write to support@storemink.com.",
  startPlanChange: vi.fn(),
  confirmPlanChange: vi.fn(),
}));
vi.mock("@/lib/billing/plan-change", () => planChange);
const locationBilling = vi.hoisted(() => ({
  LOCATIONS_RECOVERED_MESSAGE:
    "Your earlier payment went through, and your extra locations are now added.",
  LOCATIONS_RECOVERY_WAITING_MESSAGE:
    "Your earlier payment went through, and we'll add your locations shortly. Please don't pay again. If they haven't been added within a day, write to support@storemink.com.",
  startLocationPurchase: vi.fn(),
  confirmLocationPurchase: vi.fn(),
  getLocationBillingState: vi.fn(),
  releaseLocations: vi.fn(),
}));
vi.mock("@/lib/billing/locations", () => locationBilling);

const pricing = vi.hoisted(() => ({
  getPlanPricingLive: vi.fn(),
  getExtraLocationPricingLive: vi.fn(),
}));
vi.mock("@/lib/plans/pricing", () => pricing);

const manual = vi.hoisted(() => ({
  startInvoicePayment: vi.fn(),
  confirmInvoicePayment: vi.fn(),
  listPayableInvoices: vi.fn(),
}));
vi.mock("@/lib/billing/manual-pay", () => manual);

// Cancelling and resuming are proved by lib/billing/cancel.test.ts; here the
// subject is the gate, who is recorded as asking, and what the merchant reads.
const cancel = vi.hoisted(() => ({
  cancelAtPeriodEnd: vi.fn(),
  resumeSubscription: vi.fn(),
  getSubscriptionView: vi.fn(),
}));
vi.mock("@/lib/billing/cancel", () => cancel);

// The quotes and Billing details are proved by lib/billing/quote.test.ts and
// billing-details.test.ts; here the subject is the gate and whose store.
const quote = vi.hoisted(() => ({
  quoteCheckoutFor: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
    ok: true,
  })),
  quoteNextRenewal: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
}));
vi.mock("@/lib/billing/quote", () => quote);
const details = vi.hoisted(() => ({
  getBillingDetails: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
  saveBillingDetails: vi.fn<(...args: any[]) => Promise<any>>(async () => ({
    ok: true,
  })),
}));
vi.mock("@/lib/billing/billing-details", () => details);

// The quote and the Billing details saves are throttled per store and person
// (review R3-07). Allowed unless a test says otherwise.
const limits = vi.hoisted(() => ({
  rateLimit: vi.fn<(...args: any[]) => Promise<{ allowed: boolean }>>(
    async () => ({ allowed: true }),
  ),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: limits.rateLimit }));

import {
  cancelMySubscription,
  changeMyPlan,
  confirmPayInvoice,
  confirmSignupSubscribe,
  confirmSubscribe,
  getMyBillingDetails,
  getMyNextRenewal,
  getMySubscription,
  getPayableInvoices,
  quoteCheckout,
  resumeMySubscription,
  saveMyBillingDetails,
  saveSignupBillingDetails,
  startBuyLocations,
  startPayInvoice,
  startSignupSubscribe,
  startSubscribe,
} from "./subscribe-actions";
import { getServerUser } from "@/lib/auth/server-user";
import { refresh, revalidatePath, revalidateTag, updateTag } from "next/cache";
import { BILLING_DETAILS, SIGNUP_STATE } from "@/lib/billing/tax-copy";
import { logWarn } from "@/lib/observability/logger";

const STORE = "store-1";

/** No legacy subscription by default. */
function seed(rows: any[][] = [[]]) {
  dbHolder.current = makeDbMock({ selectQueue: rows });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  access.getManagerUserId.mockResolvedValue("admin-1");
  access.getActingStoreId.mockResolvedValue(STORE);
  enrol.ensureBillingAccount.mockResolvedValue(true);
  enrol.startEnrolment.mockResolvedValue({
    ok: true,
    data: {
      invoiceId: "inv-1",
      attemptId: "att-1",
      providerOrderId: "order_1",
      keyId: "rzp_1",
      amountPaise: 5_000_00,
      suggestedMandateMaxPaise: 9_000_00,
      providerCustomerId: "cust_1",
    },
  });
  enrol.confirmEnrolment.mockResolvedValue({
    ok: true,
    data: {
      plan: "pro",
      periodEnd: "2026-10-01T00:00:00.000Z",
      mandateActivated: true,
    },
  });
  pricing.getPlanPricingLive.mockResolvedValue({
    free: { monthlyInr: 0, yearlyInr: 0 },
    basic: { monthlyInr: 1500, yearlyInr: 15000 },
    pro: { monthlyInr: 5000, yearlyInr: 50000 },
  });
  pricing.getExtraLocationPricingLive.mockResolvedValue({
    monthlyInr: 1000,
    yearlyInr: 10000,
  });
  manual.startInvoicePayment.mockResolvedValue({
    ok: true,
    data: {
      invoiceId: "inv-9",
      providerOrderId: "order_9",
      keyId: "rzp_1",
      amountPaise: 5_000_00,
      invoiceRef: "SM/2026-27/00009",
    },
  });
  manual.confirmInvoicePayment.mockResolvedValue({
    ok: true,
    data: { invoiceId: "inv-9", planRestored: true },
  });
  manual.listPayableInvoices.mockResolvedValue([{ id: "inv-9" }]);
});

describe("signup subscription (the Plan step on the platform host)", () => {
  beforeEach(() => {
    vi.mocked(getServerUser).mockResolvedValue({ id: "owner-1" } as any);
    // The owner's own admins row: superadmin of their one store.
    seed([[{ storeId: "own-store", role: "superadmin" }], []]);
  });

  it("★★ bills the SIGNED-IN OWNER's store and takes no store id at all", async () => {
    const res = await startSignupSubscribe("pro", "monthly", "upi");
    expect(res.ok).toBe(true);
    expect(enrol.startEnrolment).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "own-store",
        plan: "pro",
        period: "monthly",
        mandateMethod: "upi",
      }),
    );
    // Never the host's store: on the platform host that is the fallback.
    expect(access.getActingStoreId).not.toHaveBeenCalled();
  });

  it("★ refuses anyone who is not a store owner", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    expect((await startSignupSubscribe("pro", "monthly")).ok).toBe(false);

    vi.mocked(getServerUser).mockResolvedValue({ id: "staff-1" } as any);
    seed([[{ storeId: "own-store", role: "manager" }]]);
    expect((await startSignupSubscribe("pro", "monthly")).ok).toBe(false);
    expect((await confirmSignupSubscribe("inv-1", "pay_1", "sig")).ok).toBe(
      false,
    );

    // A failed read refuses rather than authorises.
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("db down");
    });
    expect((await startSignupSubscribe("pro", "monthly")).ok).toBe(false);
    expect(enrol.startEnrolment).not.toHaveBeenCalled();
    expect(enrol.confirmEnrolment).not.toHaveBeenCalled();
  });

  it("★★ a suspended owner is not a signup owner (review R3-10)", async () => {
    seed([[{ storeId: "own-store", role: "superadmin", isSuspended: true }]]);
    expect((await startSignupSubscribe("pro", "monthly")).ok).toBe(false);
    seed([[{ storeId: "own-store", role: "superadmin", isSuspended: true }]]);
    expect((await confirmSignupSubscribe("inv-1", "pay_1", "sig")).ok).toBe(
      false,
    );
    expect(enrol.startEnrolment).not.toHaveBeenCalled();
    expect(enrol.confirmEnrolment).not.toHaveBeenCalled();
  });

  it("an owner who is not suspended passes (null and false alike)", async () => {
    for (const isSuspended of [null, false]) {
      seed([[{ storeId: "own-store", role: "superadmin", isSuspended }], []]);
      expect((await startSignupSubscribe("pro", "monthly")).ok).toBe(true);
    }
  });

  it("confirms against the owner's store and makes the plan visible on the next request", async () => {
    const res = await confirmSignupSubscribe("inv-1", "pay_1", "sig");
    expect(res).toMatchObject({ ok: true, plan: "pro" });
    expect(enrol.confirmEnrolment).toHaveBeenCalledWith({
      storeId: "own-store",
      invoiceId: "inv-1",
      providerPaymentId: "pay_1",
      signature: "sig",
    });
    expect(updateTag).toHaveBeenCalledWith("stores");
  });

  it("does not refresh the store when the payment did not confirm", async () => {
    enrol.confirmEnrolment.mockResolvedValue({ ok: false, error: "bad sig" });
    expect(await confirmSignupSubscribe("inv-1", "pay_1", "sig")).toEqual({
      ok: false,
      error: "bad sig",
    });
    expect(updateTag).not.toHaveBeenCalled();
  });
});

describe("manual payment actions", () => {
  it("★ every one is gated, and does nothing unauthorised", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    expect((await startPayInvoice("inv-9")).ok).toBe(false);
    expect((await confirmPayInvoice("inv-9", "pay_1", "sig")).ok).toBe(false);
    expect(await getPayableInvoices()).toEqual([]);
    expect(manual.startInvoicePayment).not.toHaveBeenCalled();
    expect(manual.confirmInvoicePayment).not.toHaveBeenCalled();
    expect(manual.listPayableInvoices).not.toHaveBeenCalled();
  });

  it("★★ takes the store from the SESSION, never the caller", async () => {
    // An invoice id is the only thing the client supplies; the tenant is ours.
    await startPayInvoice("inv-9");
    expect(manual.startInvoicePayment).toHaveBeenCalledWith({
      storeId: STORE,
      invoiceId: "inv-9",
      insteadOfAutopay: false,
    });
  });

  // "Pay now instead" withdraws a scheduled automatic payment, so the flag
  // that asks for it is taken only as the literal `true`.
  it("★★ Pay now instead is asked for by `true` and by nothing else", async () => {
    await startPayInvoice("inv-9", true);
    expect(manual.startInvoicePayment).toHaveBeenLastCalledWith({
      storeId: STORE,
      invoiceId: "inv-9",
      insteadOfAutopay: true,
    });
    for (const other of ["true", 1, {}, [], null, undefined, false]) {
      await startPayInvoice("inv-9", other);
      expect(manual.startInvoicePayment).toHaveBeenLastCalledWith(
        expect.objectContaining({ insteadOfAutopay: false }),
      );
    }
  });

  it("returns what the modal needs", async () => {
    const res = await startPayInvoice("inv-9");
    expect(res).toMatchObject({
      ok: true,
      providerOrderId: "order_9",
      amountPaise: 5_000_00,
    });
  });

  it("rejects a malformed invoice id without calling through", async () => {
    for (const bad of [null, "", 42, {}]) {
      expect((await startPayInvoice(bad)).ok).toBe(false);
    }
    expect(manual.startInvoicePayment).not.toHaveBeenCalled();
  });

  it("rejects malformed confirm input", async () => {
    const bad: [unknown, unknown, unknown][] = [
      [null, "pay_1", "sig"],
      ["inv-9", "", "sig"],
      ["inv-9", "pay_1", 42],
    ];
    for (const [a, b, c] of bad) {
      expect((await confirmPayInvoice(a, b, c)).ok).toBe(false);
    }
    expect(manual.confirmInvoicePayment).not.toHaveBeenCalled();
  });

  it("★ busts the store cache when a plan was restored", async () => {
    const { revalidateTag } = await import("next/cache");
    await confirmPayInvoice("inv-9", "pay_1", "sig");
    expect(revalidateTag).toHaveBeenCalled();
  });

  it("★ does NOT bust the cache when nothing changed", async () => {
    // Paying inside the T−4d window settles the invoice without moving the
    // cycle — no entitlement changed, so no reason to invalidate every store read.
    manual.confirmInvoicePayment.mockResolvedValue({
      ok: true,
      data: { invoiceId: "inv-9", planRestored: false },
    });
    const { revalidateTag } = await import("next/cache");
    const res = await confirmPayInvoice("inv-9", "pay_1", "sig");
    expect(res).toEqual({ ok: true, planRestored: false });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("passes a failure through", async () => {
    manual.confirmInvoicePayment.mockResolvedValue({
      ok: false,
      error: "bad sig",
    });
    expect(await confirmPayInvoice("inv-9", "pay_1", "sig")).toEqual({
      ok: false,
      error: "bad sig",
    });
  });
});

describe("startSubscribe — the gate", () => {
  it("★ refuses without permission, and starts nothing", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    const res = await startSubscribe("pro", "monthly");
    expect(res.ok).toBe(false);
    expect(enrol.startEnrolment).not.toHaveBeenCalled();
  });

  it("refuses the free plan", async () => {
    expect((await startSubscribe("free", "monthly")).ok).toBe(false);
    expect(enrol.startEnrolment).not.toHaveBeenCalled();
  });

  it("★ refuses an unknown plan rather than coercing it", async () => {
    for (const p of ["enterprise", "", null, 42, {}]) {
      expect((await startSubscribe(p, "monthly")).ok).toBe(false);
    }
    expect(enrol.startEnrolment).not.toHaveBeenCalled();
  });

  it("coerces an unrecognised period to monthly rather than failing", async () => {
    await startSubscribe("pro", "weekly");
    expect(enrol.startEnrolment.mock.calls[0][0].period).toBe("monthly");
  });

  it("accepts yearly", async () => {
    await startSubscribe("pro", "yearly");
    expect(enrol.startEnrolment.mock.calls[0][0].period).toBe("yearly");
  });
});

// ⚠ The "never billed by both systems" block was DELETED with the old path
// (2026-08-13). `hasLegacySubscription` existed to stop a store being enrolled on
// the new system while `store_subscriptions` held a live Razorpay mandate — and
// with `subscription-actions.ts` gone, nothing can create one. The table remains
// as an audit trail that nothing reads.
//
// ★ If a legacy row is ever found in a live database, the fix is to cancel the
// GATEWAY subscription, not to reinstate this guard: our code no longer bills
// from that row, so the only thing that could still take money is Razorpay's own
// timer, which a guard here cannot reach.

describe("startSubscribe — pricing", () => {
  it("★ prices from the LIVE readers", async () => {
    await startSubscribe("basic", "yearly");
    const priceFor = enrol.startEnrolment.mock.calls[0][0].priceFor;
    expect(await priceFor("basic", "yearly")).toEqual({
      planPaise: 15_000_00,
      locationPaise: 10_000_00,
    });
    expect(pricing.getPlanPricingLive).toHaveBeenCalled();
  });

  it("returns what the client needs for the modal", async () => {
    const res = await startSubscribe("pro", "monthly");
    expect(res).toMatchObject({
      ok: true,
      providerOrderId: "order_1",
      keyId: "rzp_1",
      amountPaise: 5_000_00,
    });
  });

  it("passes an enrolment failure through", async () => {
    enrol.startEnrolment.mockResolvedValue({ ok: false, error: "nope" });
    const res = await startSubscribe("pro", "monthly");
    expect(res).toEqual({ ok: false, error: "nope" });
  });
});

describe("startSubscribe: an earlier payment finished instead (RC-F1b, RC-F1c)", () => {
  it("★★ a finished earlier payment is a SUCCESS: it refreshes every plan gate and carries the message", async () => {
    enrol.startEnrolment.mockResolvedValue({
      ok: false,
      error: "Your earlier payment went through, and your plan is now active.",
      recovered: "completed",
    });
    const res = await startSubscribe("pro", "monthly");
    expect(res).toEqual({
      ok: true,
      completedEarlier: true,
      message:
        "Your earlier payment went through, and your plan is now active.",
    });
    expect(updateTag).toHaveBeenCalledWith("stores");
    expect(refresh).toHaveBeenCalled();
  });

  it("★ the signup path answers the same success for the owner's store", async () => {
    vi.mocked(getServerUser).mockResolvedValue({ id: "owner-1" } as any);
    seed([[{ storeId: "own-store", role: "superadmin" }], []]);
    enrol.startEnrolment.mockResolvedValue({
      ok: false,
      error: "Your earlier payment went through, and your plan is now active.",
      recovered: "completed",
    });
    const res = await startSignupSubscribe("pro", "monthly");
    expect(res).toEqual({
      ok: true,
      completedEarlier: true,
      message:
        "Your earlier payment went through, and your plan is now active.",
    });
    expect(updateTag).toHaveBeenCalledWith("stores");
  });

  it("★ a payment still waiting to be finished is a notice: no cache change, flagged waiting", async () => {
    enrol.startEnrolment.mockResolvedValue({
      ok: false,
      error: "waiting",
      recovered: "waiting",
    });
    const res = await startSubscribe("pro", "monthly");
    expect(res).toEqual({ ok: false, error: "waiting", waiting: true });
    expect(updateTag).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("an ordinary refusal carries neither flag", async () => {
    enrol.startEnrolment.mockResolvedValue({ ok: false, error: "nope" });
    expect(await startSubscribe("pro", "monthly")).toEqual({
      ok: false,
      error: "nope",
    });
  });
});

describe("startBuyLocations and changeMyPlan: an earlier payment finished instead (RC-F1b, RC-F1c)", () => {
  it("★★ a finished location purchase is a SUCCESS that refreshes the allowance", async () => {
    locationBilling.startLocationPurchase.mockResolvedValue({
      ok: false,
      error: locationBilling.LOCATIONS_RECOVERED_MESSAGE,
    });
    const res = await startBuyLocations(3);
    expect(res).toEqual({
      ok: true,
      completedEarlier: true,
      message: locationBilling.LOCATIONS_RECOVERED_MESSAGE,
    });
    expect(revalidateTag).toHaveBeenCalledWith("stores", "max");
  });

  it("★ a location purchase still waiting is flagged waiting and changes no cache", async () => {
    locationBilling.startLocationPurchase.mockResolvedValue({
      ok: false,
      error: locationBilling.LOCATIONS_RECOVERY_WAITING_MESSAGE,
    });
    expect(await startBuyLocations(3)).toEqual({
      ok: false,
      error: locationBilling.LOCATIONS_RECOVERY_WAITING_MESSAGE,
      waiting: true,
    });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("★ any other location refusal changes no cache and carries neither flag", async () => {
    locationBilling.startLocationPurchase.mockResolvedValue({
      ok: false,
      error: "nope",
    });
    expect(await startBuyLocations(3)).toEqual({ ok: false, error: "nope" });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("★★ a finished earlier plan change names the plan that payment bought", async () => {
    planChange.startPlanChange.mockResolvedValue({
      ok: true,
      data: {
        scheduled: false,
        effectiveAt: null,
        plan: "pro",
        period: "monthly",
        recovered: true,
      },
    });
    const res = await changeMyPlan("basic", "yearly");
    expect(res).toEqual({
      ok: true,
      scheduled: false,
      completedEarlier: true,
      message: "Your earlier payment went through, and you're now on Pro.",
    });
    expect(revalidateTag).toHaveBeenCalledWith("stores", "max");
  });

  it("★ an earlier plan change still waiting is flagged waiting and changes no cache", async () => {
    planChange.startPlanChange.mockResolvedValue({
      ok: false,
      error: planChange.PLAN_CHANGE_RECOVERY_WAITING_MESSAGE,
    });
    expect(await changeMyPlan("pro", "monthly")).toEqual({
      ok: false,
      error: planChange.PLAN_CHANGE_RECOVERY_WAITING_MESSAGE,
      waiting: true,
    });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("any other plan-change refusal carries no flag", async () => {
    planChange.startPlanChange.mockResolvedValue({ ok: false, error: "nope" });
    expect(await changeMyPlan("pro", "monthly")).toEqual({
      ok: false,
      error: "nope",
    });
  });
});

describe("confirmSubscribe", () => {
  const ok = ["inv-1", "pay_1", "sig"] as const;

  it("★ refuses without permission, and confirms nothing", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    const res = await confirmSubscribe(...ok);
    expect(res.ok).toBe(false);
    expect(enrol.confirmEnrolment).not.toHaveBeenCalled();
  });

  it("★ rejects malformed input without touching the gateway", async () => {
    const bad: [unknown, unknown, unknown][] = [
      [null, "pay_1", "sig"],
      ["inv-1", "", "sig"],
      ["inv-1", "pay_1", 42],
      [{}, {}, {}],
    ];
    for (const [a, b, c] of bad) {
      expect((await confirmSubscribe(a, b, c)).ok).toBe(false);
    }
    expect(enrol.confirmEnrolment).not.toHaveBeenCalled();
  });

  it("activates and reports the plan and cycle end", async () => {
    seed([[{ plan: "free" }]]);
    const res = await confirmSubscribe(...ok);
    expect(res).toEqual({
      ok: true,
      plan: "pro",
      periodEnd: "2026-10-01T00:00:00.000Z",
      autopay: true,
    });
  });

  it("★★ writes NO audit row of its own: the completion that moved the plan does (RC-F1b)", async () => {
    // A late confirm after the hourly check finished the purchase moves
    // nothing, so it must not record a second "subscribed" row.
    const res = await confirmSubscribe(...ok);
    expect(res.ok).toBe(true);
    expect(enrol.auditEnrolment).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("★ reports manual renewal when no mandate was registered", async () => {
    enrol.confirmEnrolment.mockResolvedValue({
      ok: true,
      data: {
        plan: "basic",
        periodEnd: "2026-10-01T00:00:00.000Z",
        mandateActivated: false,
      },
    });
    const res = await confirmSubscribe(...ok);
    expect(res).toMatchObject({ ok: true, autopay: false });
  });

  it("★ does NOT audit when activation failed", async () => {
    enrol.confirmEnrolment.mockResolvedValue({ ok: false, error: "bad sig" });
    const res = await confirmSubscribe(...ok);
    expect(res).toEqual({ ok: false, error: "bad sig" });
    expect(enrol.auditEnrolment).not.toHaveBeenCalled();
  });

  it("★ money in, plan switching shortly: flagged waiting, never a bare failure (RC-F1c)", async () => {
    enrol.confirmEnrolment.mockResolvedValue({
      ok: false,
      error: enrol.ENROLMENT_PAID_NOT_SWITCHED_MESSAGE,
    });
    expect(await confirmSubscribe(...ok)).toEqual({
      ok: false,
      error: enrol.ENROLMENT_PAID_NOT_SWITCHED_MESSAGE,
      waiting: true,
    });
  });

  it("busts the store cache so every plan gate sees the new plan", async () => {
    const { revalidateTag } = await import("next/cache");
    seed([[{ plan: "free" }]]);
    await confirmSubscribe(...ok);
    expect(revalidateTag).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cancelling and Keep my plan (renewal-cancel design 8.2 and Table B).
// ---------------------------------------------------------------------------

/** 30 Oct 2026, 12:00 in India. */
const PERIOD_END = "2026-10-30T06:30:00.000Z";
/** 1 Nov 2026, 14:00 in India. */
const GRACE_END = "2026-11-01T08:30:00.000Z";
const REFUND_TIMING = "after your plan ends, usually within 5 working days";

function nextInvoice(over: Record<string, unknown> = {}) {
  return {
    id: "inv-next",
    status: "open",
    totalPaise: 2_400_00,
    invoiceRef: "SM/2026-27/00042",
    inFlight: false,
    ...over,
  };
}
const OPEN = nextInvoice();
const IN_FLIGHT = nextInvoice({ status: "processing", inFlight: true });
const PAID = nextInvoice({ status: "paid" });

/** The plan the subscription is on, as the action reads it for the toast. */
function seedPlan(plan: string | Error = "pro") {
  dbHolder.current = makeDbMock({
    selectByTable: {
      billing_subscriptions: [plan instanceof Error ? plan : [{ plan }]],
    },
  });
}

function cancelled(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      accessUntil: PERIOD_END,
      mandateRevoked: true,
      state: "active",
      graceEndsAt: null,
      nextInvoice: null,
      ...over,
    },
  };
}

function resumed(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      autopay: false,
      advanced: false,
      state: "active",
      graceEndsAt: null,
      currentEnd: PERIOD_END,
      nextInvoice: null,
      ...over,
    },
  };
}

async function cancelMessage(over: Record<string, unknown>) {
  cancel.cancelAtPeriodEnd.mockResolvedValue(cancelled(over));
  const res = await cancelMySubscription();
  if (!res.ok) throw new Error(res.error);
  return res.message;
}

async function resumeMessage(over: Record<string, unknown>) {
  cancel.resumeSubscription.mockResolvedValue(resumed(over));
  const res = await resumeMySubscription();
  if (!res.ok) throw new Error(res.error);
  return res.message;
}

describe("cancelMySubscription", () => {
  beforeEach(() => seedPlan());

  it("★ refuses without permission, and cancels nothing", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    expect(await cancelMySubscription()).toEqual({
      ok: false,
      error: "You don't have permission to do this.",
    });
    expect(cancel.cancelAtPeriodEnd).not.toHaveBeenCalled();
  });

  it("★★ records WHO asked: the merchant, from the session", async () => {
    cancel.cancelAtPeriodEnd.mockResolvedValue(cancelled());
    await cancelMySubscription();
    expect(cancel.cancelAtPeriodEnd).toHaveBeenCalledWith({
      storeId: STORE,
      requestedBy: "merchant:admin-1",
    });
  });

  it("passes a refusal through, word for word", async () => {
    cancel.cancelAtPeriodEnd.mockResolvedValue({
      ok: false,
      error: "Your subscription is already cancelling.",
    });
    expect(await cancelMySubscription()).toEqual({
      ok: false,
      error: "Your subscription is already cancelling.",
    });
  });

  it("8.2 case 1: no paid cycle promises nothing kept", async () => {
    expect(await cancelMessage({ accessUntil: null })).toBe(
      "Cancelled. No further payments will be taken.",
    );
  });

  it("8.2 case 2: active, no next invoice", async () => {
    expect(await cancelMessage({})).toBe(
      "Cancelled. You keep your Pro plan until 30 Oct 2026, then move to Free.",
    );
  });

  it("8.2 case 3: the renewal invoice is open", async () => {
    expect(await cancelMessage({ nextInvoice: OPEN })).toBe(
      "Cancelled. You keep your Pro plan until 30 Oct 2026, then move to Free. Your renewal invoice won't be charged.",
    );
  });

  it("8.2 case 4: a renewal payment is in flight", async () => {
    expect(await cancelMessage({ nextInvoice: IN_FLIGHT })).toBe(
      `Cancelled. You keep your Pro plan until 30 Oct 2026, then move to Free. A renewal payment of ₹2,400 is still going through. If it completes, we refund it ${REFUND_TIMING}.`,
    );
    // An open invoice with an attempt under way is in flight too.
    expect(
      await cancelMessage({ nextInvoice: nextInvoice({ inFlight: true }) }),
    ).toContain("is still going through");
  });

  it("8.2 case 5: the renewal is already paid", async () => {
    expect(await cancelMessage({ nextInvoice: PAID })).toBe(
      `Cancelled. You keep your Pro plan until 30 Oct 2026, then move to Free. We'll refund your renewal payment of ₹2,400 ${REFUND_TIMING}.`,
    );
  });

  it("8.2 case 6: cancelled in grace, the plan ends when grace ends", async () => {
    expect(
      await cancelMessage({
        state: "past_due",
        graceEndsAt: GRACE_END,
        nextInvoice: OPEN,
      }),
    ).toBe(
      "Cancelled. Your Pro plan ends on 1 Nov 2026, 14:00 IST, then your store moves to Free. Your unpaid invoice won't be charged.",
    );
  });

  it("8.2 case 7: in grace with a renewal payment in flight", async () => {
    expect(
      await cancelMessage({
        state: "grace",
        graceEndsAt: GRACE_END,
        nextInvoice: IN_FLIGHT,
      }),
    ).toBe(
      "Cancelled. Your Pro plan ends on 1 Nov 2026, 14:00 IST, then your store moves to Free. A renewal payment of ₹2,400 is still going through. If it completes, we refund it.",
    );
  });

  it("in grace with the renewal already paid, the refund is promised as the email promises it", async () => {
    expect(
      await cancelMessage({
        state: "grace",
        graceEndsAt: GRACE_END,
        nextInvoice: PAID,
      }),
    ).toBe(
      `Cancelled. Your Pro plan ends on 1 Nov 2026, 14:00 IST, then your store moves to Free. We'll refund your renewal payment of ₹2,400 ${REFUND_TIMING}.`,
    );
  });

  it("★ the end in grace is GRACE's end, never the old period end", async () => {
    const message = await cancelMessage({
      state: "past_due",
      accessUntil: PERIOD_END,
      graceEndsAt: GRACE_END,
      nextInvoice: OPEN,
    });
    expect(message).toContain("1 Nov 2026, 14:00 IST");
    expect(message).not.toContain("30 Oct 2026");
  });

  it("names no invoice and promises no refund for a draft or a closed invoice", async () => {
    for (const status of ["draft", "void", "uncollectible"]) {
      seedPlan();
      expect(
        await cancelMessage({ nextInvoice: nextInvoice({ status }) }),
      ).toBe(
        "Cancelled. You keep your Pro plan until 30 Oct 2026, then move to Free.",
      );
    }
  });

  it("prints an amount to the paisa when it has paise", async () => {
    expect(
      await cancelMessage({
        nextInvoice: nextInvoice({ status: "paid", totalPaise: 1_234_50 }),
      }),
    ).toContain("₹1,234.50");
  });

  it("says 'your plan' when the plan cannot be read, and still cancels", async () => {
    seedPlan(new Error("db down"));
    expect(await cancelMessage({})).toBe(
      "Cancelled. You keep your plan until 30 Oct 2026, then move to Free.",
    );
    expect(cancel.cancelAtPeriodEnd).toHaveBeenCalled();
  });

  it("names the Basic plan by its display name", async () => {
    seedPlan("basic");
    expect(await cancelMessage({})).toContain("your Basic plan");
  });
});

describe("resumeMySubscription (Keep my plan)", () => {
  it("★ refuses without permission, and resumes nothing", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    expect(await resumeMySubscription()).toEqual({
      ok: false,
      error: "You don't have permission to do this.",
    });
    expect(cancel.resumeSubscription).not.toHaveBeenCalled();
  });

  it("★ records WHO asked, from the session", async () => {
    cancel.resumeSubscription.mockResolvedValue(resumed());
    await resumeMySubscription();
    expect(cancel.resumeSubscription).toHaveBeenCalledWith({
      storeId: STORE,
      requestedBy: "merchant:admin-1",
    });
  });

  it("passes a refusal through, word for word", async () => {
    cancel.resumeSubscription.mockResolvedValue({
      ok: false,
      error:
        "That subscription can't be resumed. Subscribe again to start a new cycle.",
    });
    expect(await resumeMySubscription()).toEqual({
      ok: false,
      error:
        "That subscription can't be resumed. Subscribe again to start a new cycle.",
    });
  });

  it("★★ an ADVANCED cycle says the plan continues, reports it, and refreshes every plan gate", async () => {
    cancel.resumeSubscription.mockResolvedValue(
      resumed({
        advanced: true,
        state: "grace",
        graceEndsAt: GRACE_END,
        nextInvoice: PAID,
      }),
    );
    expect(await resumeMySubscription()).toEqual({
      ok: true,
      message: "Resumed. Your renewal is already paid, so your plan continues.",
      advanced: true,
    });
    expect(revalidateTag).toHaveBeenCalledWith("stores", "max");
  });

  it("★★ a paid renewal NOT yet advanced in grace never claims it is applied now", async () => {
    cancel.resumeSubscription.mockResolvedValue(
      resumed({ state: "grace", graceEndsAt: GRACE_END, nextInvoice: PAID }),
    );
    const res = await resumeMySubscription();
    expect(res).toEqual({
      ok: true,
      message:
        "Resumed. Your renewal is already paid, so your plan continues. We'll finish renewing it when grace ends on 1 Nov 2026, 14:00 IST.",
      advanced: false,
    });
    if (res.ok) expect(res.message).not.toMatch(/within the hour/i);
    // Nothing about the entitlement changed yet.
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("Table B: active, renewal already paid, the plan continues after the cycle end", async () => {
    expect(await resumeMessage({ nextInvoice: PAID })).toBe(
      "Resumed. Your renewal is already paid, so your plan continues after 30 Oct 2026.",
    );
  });

  it("Table B: a renewal payment still in flight", async () => {
    expect(await resumeMessage({ nextInvoice: IN_FLIGHT })).toBe(
      "Resumed. Your renewal payment of ₹2,400 is still going through.",
    );
  });

  it("Table B: in grace and unpaid, pay before grace ends", async () => {
    expect(
      await resumeMessage({
        state: "past_due",
        graceEndsAt: GRACE_END,
        nextInvoice: OPEN,
      }),
    ).toBe(
      "Resumed. Pay your renewal invoice of ₹2,400 by 1 Nov 2026, 14:00 IST to keep your plan.",
    );
  });

  it("Table B: active with an open invoice and autopay off, pay it by the cycle end", async () => {
    expect(await resumeMessage({ nextInvoice: OPEN })).toBe(
      "Resumed. Autopay is off, so pay your renewal invoice of ₹2,400 by 30 Oct 2026 to keep your plan.",
    );
  });

  it("Table B: nothing issued yet, autopay off", async () => {
    expect(await resumeMessage({})).toBe(
      "Resumed. Autopay is off, so we'll ask you to pay each renewal.",
    );
  });

  it("with autopay still on, it renews as normal", async () => {
    expect(await resumeMessage({ autopay: true })).toBe(
      "Resumed. Your plan will renew as normal.",
    );
  });
});

describe("getMySubscription", () => {
  it("★ without permission returns the neutral view, every field present", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    expect(await getMySubscription()).toEqual({
      plan: null,
      period: null,
      status: null,
      currentEnd: null,
      cancelAtPeriodEnd: false,
      scheduledPlan: null,
      scheduledPeriod: null,
      scheduledLocations: null,
      autopay: false,
      active: false,
      nextInvoice: null,
      graceEndsAt: null,
      cancelRequestedBy: null,
      cancelRequestedAt: null,
    });
    expect(cancel.getSubscriptionView).not.toHaveBeenCalled();
  });

  it("reads the acting store's view", async () => {
    cancel.getSubscriptionView.mockResolvedValue({ plan: "pro" });
    expect(await getMySubscription()).toEqual({ plan: "pro" });
    expect(cancel.getSubscriptionView).toHaveBeenCalledWith(STORE);
  });
});

// ── Quotes and Billing details (GST design 5.6, 5.7) ──────────────────────

describe("quoteCheckout", () => {
  it("★ is gated, and quotes nothing for anyone else", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    expect(await quoteCheckout("pro", "monthly", null)).toEqual({
      ok: false,
      error: "You don't have permission to do this.",
    });
    expect(access.getManagerUserId).toHaveBeenCalledWith("ai");
    expect(quote.quoteCheckoutFor).not.toHaveBeenCalled();
  });

  it("refuses anything but a paid plan", async () => {
    expect(await quoteCheckout("free", "monthly", null)).toEqual({
      ok: false,
      error: "Choose a paid plan.",
    });
    expect(await quoteCheckout("enterprise", "monthly", null)).toEqual({
      ok: false,
      error: "Choose a paid plan.",
    });
    expect(quote.quoteCheckoutFor).not.toHaveBeenCalled();
  });

  it("★ quotes the ACTING store with the live prices the payment uses", async () => {
    await quoteCheckout("pro", "yearly", " pack-60 ");
    expect(quote.quoteCheckoutFor).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE,
        plan: "pro",
        period: "yearly",
        packId: "pack-60",
        locationPrice: { monthlyInr: 1000, yearlyInr: 10000 },
      }),
    );
    const { priceFor } = quote.quoteCheckoutFor.mock.calls[0][0] as any;
    expect(await priceFor("pro", "yearly")).toEqual({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });
  });

  it("a period it does not know is monthly; a blank pack is none", async () => {
    await quoteCheckout("basic", "weekly", "  ");
    expect(quote.quoteCheckoutFor).toHaveBeenCalledWith(
      expect.objectContaining({ period: "monthly", packId: null }),
    );
  });

  describe("★★ is limited per store and person (review R3-07)", () => {
    it("asks the shared quote bucket, 60 a minute", async () => {
      await quoteCheckout("pro", "monthly", null);
      expect(limits.rateLimit).toHaveBeenCalledWith(
        `billing-quote:${STORE}:admin-1`,
        { max: 60, windowSeconds: 60 },
      );
    });

    it("★ over the limit refuses in plain words and reads no price", async () => {
      limits.rateLimit.mockResolvedValueOnce({ allowed: false });
      expect(await quoteCheckout("pro", "monthly", null)).toEqual({
        ok: false,
        error: "Too many price checks. Please wait a moment and try again.",
      });
      expect(quote.quoteCheckoutFor).not.toHaveBeenCalled();
      expect(pricing.getExtraLocationPricingLive).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith("billing.rate_limited", {
        action: "quote_checkout",
        storeId: STORE,
      });
    });

    it("spends nothing on a caller it refuses for other reasons", async () => {
      access.getManagerUserId.mockResolvedValue(null);
      await quoteCheckout("pro", "monthly", null);
      access.getManagerUserId.mockResolvedValue("admin-1");
      await quoteCheckout("free", "monthly", null);
      expect(limits.rateLimit).not.toHaveBeenCalled();
    });
  });
});

describe("getMyNextRenewal and getMyBillingDetails", () => {
  it("★ are gated", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    expect(await getMyNextRenewal()).toBeNull();
    expect(await getMyBillingDetails()).toBeNull();
    expect(quote.quoteNextRenewal).not.toHaveBeenCalled();
    expect(details.getBillingDetails).not.toHaveBeenCalled();
  });

  it("read the acting store", async () => {
    await getMyNextRenewal();
    expect(quote.quoteNextRenewal).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE }),
    );
    await getMyBillingDetails();
    expect(details.getBillingDetails).toHaveBeenCalledWith(STORE);
  });

  it("★ the next renewal shares the quote bucket, and past it is no renewal line (review R3-07)", async () => {
    limits.rateLimit.mockResolvedValueOnce({ allowed: false });
    expect(await getMyNextRenewal()).toBeNull();
    expect(limits.rateLimit).toHaveBeenCalledWith(
      `billing-quote:${STORE}:admin-1`,
      { max: 60, windowSeconds: 60 },
    );
    expect(quote.quoteNextRenewal).not.toHaveBeenCalled();
  });
});

describe("saveMyBillingDetails", () => {
  it("★ is gated", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    expect(await saveMyBillingDetails({ stateCode: "29" })).toEqual({
      ok: false,
      error: "You don't have permission to do this.",
    });
    expect(access.getManagerUserId).toHaveBeenCalledWith("ai");
    expect(details.saveBillingDetails).not.toHaveBeenCalled();
  });

  it("★ saves only the form's text fields for the acting store", async () => {
    await saveMyBillingDetails({
      country: "IN",
      stateCode: "29",
      gstin: "29ABCDE1234F1Z5",
      legalName: "Acme",
      city: 42,
      billingEmail: "attacker@example.com",
      storeId: "someone-else",
    });
    expect(details.saveBillingDetails).toHaveBeenCalledWith(STORE, {
      country: "IN",
      stateCode: "29",
      gstin: "29ABCDE1234F1Z5",
      legalName: "Acme",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/plans");
  });

  it("★ is limited per store and person, 10 a minute (review R3-07)", async () => {
    await saveMyBillingDetails({ stateCode: "29" });
    expect(limits.rateLimit).toHaveBeenCalledWith(
      `billing-details:${STORE}:admin-1`,
      { max: 10, windowSeconds: 60 },
    );
    limits.rateLimit.mockResolvedValueOnce({ allowed: false });
    vi.mocked(details.saveBillingDetails).mockClear();
    expect(await saveMyBillingDetails({ stateCode: "29" })).toEqual({
      ok: false,
      error: "Too many attempts. Please wait a moment and try again.",
    });
    expect(details.saveBillingDetails).not.toHaveBeenCalled();
  });

  it("a refusal is passed on and refreshes nothing", async () => {
    details.saveBillingDetails.mockResolvedValue({
      ok: false,
      error: BILLING_DETAILS.errors.state,
      field: "stateCode",
    });
    expect(await saveMyBillingDetails("not an object")).toEqual({
      ok: false,
      error: BILLING_DETAILS.errors.state,
      field: "stateCode",
    });
    expect(details.saveBillingDetails).toHaveBeenCalledWith(STORE, {});
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("saveSignupBillingDetails (the signup Plan step)", () => {
  beforeEach(() => {
    vi.mocked(getServerUser).mockResolvedValue({ id: "owner-1" } as any);
    seed([[{ storeId: "own-store", role: "superadmin" }]]);
  });

  it("★★ saves to the SIGNED-IN OWNER's store, whatever the request names", async () => {
    const res = await saveSignupBillingDetails({
      stateCode: "29",
      gstin: "",
      storeId: "someone-else",
      country: "US",
      legalName: "Not taken here",
    });
    expect(res).toEqual({ ok: true });
    expect(details.saveBillingDetails).toHaveBeenCalledWith("own-store", {
      stateCode: "29",
      gstin: "",
      country: "IN",
    });
    expect(access.getActingStoreId).not.toHaveBeenCalled();
  });

  it("★ refuses anyone who is not a store owner", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    expect((await saveSignupBillingDetails({ stateCode: "29" })).ok).toBe(
      false,
    );
    vi.mocked(getServerUser).mockResolvedValue({ id: "staff-1" } as any);
    seed([[{ storeId: "own-store", role: "manager" }]]);
    expect((await saveSignupBillingDetails({ stateCode: "29" })).ok).toBe(
      false,
    );
    expect(details.saveBillingDetails).not.toHaveBeenCalled();
  });

  it("★ a suspended owner is refused, and nothing is saved (review R3-10)", async () => {
    seed([[{ storeId: "own-store", role: "superadmin", isSuspended: true }]]);
    expect(await saveSignupBillingDetails({ stateCode: "29" })).toEqual({
      ok: false,
      error: "You don't have permission to do this.",
    });
    expect(details.saveBillingDetails).not.toHaveBeenCalled();
  });

  it("★ is limited per store and owner, 10 a minute (review R3-07)", async () => {
    limits.rateLimit.mockResolvedValueOnce({ allowed: false });
    expect(await saveSignupBillingDetails({ stateCode: "29" })).toEqual({
      ok: false,
      error: "Too many attempts. Please wait a moment and try again.",
    });
    expect(limits.rateLimit).toHaveBeenCalledWith(
      "billing-details:own-store:owner-1",
      { max: 10, windowSeconds: 60 },
    );
    expect(details.saveBillingDetails).not.toHaveBeenCalled();
  });

  it("a failed save says so in the signup step's words", async () => {
    details.saveBillingDetails.mockResolvedValue({
      ok: false,
      error: BILLING_DETAILS.errors.failed,
    });
    expect(await saveSignupBillingDetails({ stateCode: "29" })).toEqual({
      ok: false,
      error: SIGNUP_STATE.saveFailed,
      field: undefined,
    });
  });
});
