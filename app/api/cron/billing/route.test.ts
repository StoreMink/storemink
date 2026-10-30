// The billing cron.
//
// Two things here are security- or money-critical rather than cosmetic:
//
//   • the auth gate FAILS CLOSED on a missing secret — this endpoint charges
//     merchants and removes their plans, so an unset CRON_SECRET must not leave
//     it open;
//   • with no gateway configured, collection is SKIPPED rather than attempted,
//     because a stub that always failed would create payment attempts that can
//     never settle.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const worker = vi.hoisted(() => ({
  RENEWAL_BATCH: 50,
  collectDueRenewals: vi.fn(),
  evaluateCycleTurns: vi.fn(),
  downgradeExpired: vi.fn(),
}));
vi.mock("@/lib/billing/renewal-worker", () => worker);

const gateway = vi.hoisted(() => ({
  getRecurringCharge: vi.fn(),
  chargeUnavailableReason: vi.fn(),
}));
vi.mock("@/lib/billing/gateway", () => gateway);

const recon = vi.hoisted(() => ({
  reconcileStrandedAttempts: vi.fn(),
  issueCapturedDrafts: vi.fn(),
}));
vi.mock("@/lib/billing/reconcile", () => recon);

const taxSettings = vi.hoisted(() => ({ promoteDueTaxChange: vi.fn() }));
vi.mock("@/lib/billing/platform-settings", () => taxSettings);

const publicTax = vi.hoisted(() => ({ bustPlatformTax: vi.fn() }));
vi.mock("@/lib/billing/public-tax", () => publicTax);

const refundPass = vi.hoisted(() => ({ processBillingRefunds: vi.fn() }));
vi.mock("@/lib/billing/refunds", () => refundPass);

const pricing = vi.hoisted(() => ({
  getPlanPricingLive: vi.fn(),
  getExtraLocationPricingLive: vi.fn(),
}));
vi.mock("@/lib/plans/pricing", () => pricing);

import { GET, POST } from "./route";

const SECRET = "s3cret";

function req(auth?: string) {
  return new Request("https://storemink.com/api/cron/billing", {
    headers: auth ? { authorization: auth } : {},
  });
}

const EMPTY_COLLECT = {
  considered: 0,
  collected: 0,
  failed: 0,
  pendingReconcile: 0,
  manualRequired: 0,
  errors: 0,
};
const EMPTY_EVAL = {
  advanced: 0,
  graced: 0,
  waiting: 0,
  ended: 0,
  errors: 0,
};
const EMPTY_DOWN = {
  downgraded: 0,
  shiftsClosed: 0,
  ended: 0,
  advancedAfterGrace: 0,
  errors: 0,
};
const EMPTY_REPAIR = {
  considered: 0,
  issued: 0,
  completed: 0,
  filed: 0,
  deferred: 0,
  unissued: 0,
  errors: 0,
  more: false,
};
const PROMOTED = {
  enabled: true,
  inclusive: false,
  rateBps: 1800,
  startsAt: "2026-12-01T00:00:00.000+05:30",
  noticeId: "4a3c8a51-0b4e-4f63-9e2b-2f0f3f6c1a10",
};
const EMPTY_REFUNDS = {
  repairedInvoices: 0,
  flaggedForPerson: 0,
  detected: 0,
  sent: 0,
  processed: 0,
  failed: 0,
  stillPending: 0,
  creditNotes: 0,
  notified: 0,
  waiting: 0,
  errors: 0,
  more: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  worker.collectDueRenewals.mockResolvedValue({ ...EMPTY_COLLECT });
  worker.evaluateCycleTurns.mockResolvedValue({ ...EMPTY_EVAL });
  recon.reconcileStrandedAttempts.mockResolvedValue({
    considered: 0,
    recovered: 0,
    failed: 0,
    stillUnknown: 0,
    flagged: 0,
    errors: 0,
  });
  worker.downgradeExpired.mockResolvedValue({ ...EMPTY_DOWN });
  recon.issueCapturedDrafts.mockResolvedValue({ ...EMPTY_REPAIR });
  taxSettings.promoteDueTaxChange.mockResolvedValue(null);
  refundPass.processBillingRefunds.mockResolvedValue({ ...EMPTY_REFUNDS });
  gateway.getRecurringCharge.mockReturnValue(vi.fn());
  gateway.chargeUnavailableReason.mockReturnValue(null);
  pricing.getPlanPricingLive.mockResolvedValue({
    free: { monthlyInr: 0, yearlyInr: 0 },
    basic: { monthlyInr: 1500, yearlyInr: 15000 },
    pro: { monthlyInr: 5000, yearlyInr: 50000 },
  });
  pricing.getExtraLocationPricingLive.mockResolvedValue({
    monthlyInr: 1000,
    yearlyInr: 10000,
  });
});

describe("auth", () => {
  it("401s without a bearer token", async () => {
    expect((await GET(req())).status).toBe(401);
  });

  it("401s on a wrong token", async () => {
    expect((await GET(req("Bearer nope"))).status).toBe(401);
  });

  it("★★ FAILS CLOSED when CRON_SECRET is unset", async () => {
    // This endpoint charges merchants and removes their plans. An unset secret
    // must never make it public.
    delete process.env.CRON_SECRET;
    expect((await GET(req("Bearer anything"))).status).toBe(401);
    expect((await GET(req())).status).toBe(401);
    expect(worker.collectDueRenewals).not.toHaveBeenCalled();
  });

  it("runs nothing at all when unauthorised", async () => {
    await GET(req("Bearer nope"));
    expect(worker.collectDueRenewals).not.toHaveBeenCalled();
    expect(worker.evaluateCycleTurns).not.toHaveBeenCalled();
    expect(worker.downgradeExpired).not.toHaveBeenCalled();
  });

  it("accepts the correct token on GET and POST", async () => {
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(200);
    expect((await POST(req(`Bearer ${SECRET}`))).status).toBe(200);
  });
});

describe("the three passes", () => {
  it("runs collect, then evaluate, then downgrade — in that order", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const c = worker.collectDueRenewals.mock.invocationCallOrder[0];
    const e = worker.evaluateCycleTurns.mock.invocationCallOrder[0];
    const d = worker.downgradeExpired.mock.invocationCallOrder[0];
    expect(c).toBeLessThan(e);
    expect(e).toBeLessThan(d);
  });

  it("passes ONE `now` to every pass, so they agree on the instant", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const n1 = worker.collectDueRenewals.mock.calls[0][0].now;
    const n2 = worker.evaluateCycleTurns.mock.calls[0][0].now;
    const n3 = worker.downgradeExpired.mock.calls[0][0].now;
    expect(n1).toBe(n2);
    expect(n2).toBe(n3);
  });

  it("★ prices from the LIVE readers, never the cached ones", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const priceFor = worker.collectDueRenewals.mock.calls[0][0].priceFor;
    const p = await priceFor("basic", "yearly");
    expect(p).toEqual({
      planPaise: 15_000_00,
      locationPaise: 10_000_00,
      planLabel: "Basic",
    });
    expect(pricing.getPlanPricingLive).toHaveBeenCalled();
  });

  it("converts monthly prices to paise", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const priceFor = worker.collectDueRenewals.mock.calls[0][0].priceFor;
    expect(await priceFor("pro", "monthly")).toMatchObject({
      planPaise: 5_000_00,
      locationPaise: 1_000_00,
    });
  });
});

describe("★ collection with no gateway configured", () => {
  beforeEach(() => {
    gateway.getRecurringCharge.mockReturnValue(null);
    gateway.chargeUnavailableReason.mockReturnValue("endpoint not verified");
  });

  it("★★ STILL RUNS pass 1 — it ISSUES the invoice, charging is separate", async () => {
    // Skipping the pass wholesale meant no invoice was ever written: pass 2
    // waited forever, nobody was downgraded, every subscriber got free service
    // past their cycle end, and the manual payment surface had nothing to list.
    await GET(req(`Bearer ${SECRET}`));
    expect(worker.collectDueRenewals).toHaveBeenCalled();
  });

  it("★★ passes charge NULL, so the invoice is issued but never charged", async () => {
    // Deliberately not a stub that fails: an unreachable provider is an UNKNOWN
    // outcome, not a decline, so every attempt would sit in reconciliation
    // forever.
    await GET(req(`Bearer ${SECRET}`));
    expect(worker.collectDueRenewals.mock.calls[0][0].charge).toBeNull();
  });

  it("★ reports collectionSkipped so a green run can't be read as 'collecting'", async () => {
    const body = await (await GET(req(`Bearer ${SECRET}`))).json();
    expect(body.collectionSkipped).toBe("endpoint not verified");
    // The pass still reports its work — issuance happened.
    expect(body.collect).not.toBeNull();
  });

  it("★ still 200s — an unconfigured gateway is not an outage", async () => {
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(200);
  });

  it("★ still runs evaluate and downgrade", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(worker.evaluateCycleTurns).toHaveBeenCalled();
    expect(worker.downgradeExpired).toHaveBeenCalled();
  });
});

describe("status contract", () => {
  it("200s on a clean run", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("★ 503s when a pass reported errors, so Scheduler retries", async () => {
    worker.evaluateCycleTurns.mockResolvedValue({ ...EMPTY_EVAL, errors: 1 });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("503s on a collection error too", async () => {
    worker.collectDueRenewals.mockResolvedValue({
      ...EMPTY_COLLECT,
      errors: 2,
    });
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(503);
  });

  it("★★ a FAILED PAYMENT is not an error — that merchant simply has not paid", async () => {
    // Returning 5xx here would make Scheduler retry a decline, and a
    // permanently-red job is one nobody reads.
    worker.collectDueRenewals.mockResolvedValue({
      ...EMPTY_COLLECT,
      considered: 3,
      failed: 3,
    });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("★ a downgrade is not an error either", async () => {
    worker.downgradeExpired.mockResolvedValue({
      ...EMPTY_DOWN,
      downgraded: 2,
      shiftsClosed: 2,
    });
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(200);
  });

  it("★ reports `more` while a backlog drains, still at 200", async () => {
    worker.collectDueRenewals.mockResolvedValue({
      ...EMPTY_COLLECT,
      considered: 50,
    });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).more).toBe(true);
  });

  it("does not claim `more` on a short batch", async () => {
    worker.collectDueRenewals.mockResolvedValue({
      ...EMPTY_COLLECT,
      considered: 2,
    });
    expect((await (await GET(req(`Bearer ${SECRET}`))).json()).more).toBe(
      false,
    );
  });

  it("returns the full summary for observability", async () => {
    worker.collectDueRenewals.mockResolvedValue({
      ...EMPTY_COLLECT,
      considered: 4,
      collected: 3,
      manualRequired: 1,
    });
    const body = await (await GET(req(`Bearer ${SECRET}`))).json();
    expect(body.collect).toMatchObject({ collected: 3, manualRequired: 1 });
    expect(body.evaluate).toBeDefined();
    expect(body.downgrade).toBeDefined();
  });
});

describe("★★ reconciliation", () => {
  it("runs BEFORE evaluate", async () => {
    // A payment we never learned about is money already in, and pass 2 decides
    // grace and downgrade from whether the invoice is paid. Running it after
    // would downgrade a merchant whose payment this very request discovers.
    await GET(req(`Bearer ${SECRET}`));
    expect(
      recon.reconcileStrandedAttempts.mock.invocationCallOrder[0],
    ).toBeLessThan(worker.evaluateCycleTurns.mock.invocationCallOrder[0]);
  });

  it("runs even when the gateway charge is unavailable", async () => {
    // Reconciliation reads the VERIFIED order endpoint, not the recurring one —
    // so it works today, when nothing can be charged automatically.
    gateway.getRecurringCharge.mockReturnValue(null);
    gateway.chargeUnavailableReason.mockReturnValue("not verified");
    await GET(req(`Bearer ${SECRET}`));
    expect(recon.reconcileStrandedAttempts).toHaveBeenCalled();
  });

  it("reports what it did", async () => {
    recon.reconcileStrandedAttempts.mockResolvedValue({
      considered: 3,
      recovered: 1,
      failed: 1,
      stillUnknown: 1,
      flagged: 0,
      errors: 0,
    });
    const body = await (await GET(req(`Bearer ${SECRET}`))).json();
    expect(body.reconcile).toMatchObject({ recovered: 1, failed: 1 });
  });

  it("★ a reconciliation error 503s, so Scheduler retries", async () => {
    recon.reconcileStrandedAttempts.mockResolvedValue({
      considered: 1,
      recovered: 0,
      failed: 0,
      stillUnknown: 0,
      flagged: 0,
      errors: 1,
    });
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(503);
  });
});

describe("★★ the refund pass", () => {
  it("runs AFTER downgrade, so an invoice a plan end closed this run is refunded this run", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(worker.downgradeExpired.mock.invocationCallOrder[0]).toBeLessThan(
      refundPass.processBillingRefunds.mock.invocationCallOrder[0],
    );
  });

  it("gets the same `now` as every renewal pass", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const passNow = worker.downgradeExpired.mock.calls[0][0].now;
    expect(refundPass.processBillingRefunds.mock.calls[0][0].now).toBe(passNow);
  });

  it("does not run when unauthorised", async () => {
    await GET(req("Bearer nope"));
    expect(refundPass.processBillingRefunds).not.toHaveBeenCalled();
  });

  it("★ a database error in the pass 503s, so Scheduler retries", async () => {
    refundPass.processBillingRefunds.mockResolvedValue({
      ...EMPTY_REFUNDS,
      errors: 1,
    });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("★★ a FAILED or WAITING refund is not an error: it is a person's job", async () => {
    refundPass.processBillingRefunds.mockResolvedValue({
      ...EMPTY_REFUNDS,
      sent: 2,
      failed: 2,
      waiting: 3,
      flaggedForPerson: 1,
    });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("puts the pass's summary in the body", async () => {
    refundPass.processBillingRefunds.mockResolvedValue({
      ...EMPTY_REFUNDS,
      detected: 1,
      processed: 1,
      notified: 1,
    });
    const body = await (await GET(req(`Bearer ${SECRET}`))).json();
    expect(body.refunds).toMatchObject({
      detected: 1,
      processed: 1,
      notified: 1,
    });
  });

  it("★ reports `more` when the refund pass filled a batch", async () => {
    refundPass.processBillingRefunds.mockResolvedValue({
      ...EMPTY_REFUNDS,
      more: true,
    });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).more).toBe(true);
  });
});

describe("★ `more` counts every downgrade-pass outcome", () => {
  it("counts subscriptions the pass ENDED", async () => {
    worker.downgradeExpired.mockResolvedValue({ ...EMPTY_DOWN, ended: 50 });
    expect((await (await GET(req(`Bearer ${SECRET}`))).json()).more).toBe(true);
  });

  it("counts renewals it ADVANCED after grace", async () => {
    worker.downgradeExpired.mockResolvedValue({
      ...EMPTY_DOWN,
      advancedAfterGrace: 50,
    });
    expect((await (await GET(req(`Bearer ${SECRET}`))).json()).more).toBe(true);
  });

  it("adds the three together", async () => {
    worker.downgradeExpired.mockResolvedValue({
      ...EMPTY_DOWN,
      downgraded: 20,
      ended: 20,
      advancedAfterGrace: 10,
    });
    expect((await (await GET(req(`Bearer ${SECRET}`))).json()).more).toBe(true);
  });

  it("stays false below a batch", async () => {
    worker.downgradeExpired.mockResolvedValue({
      ...EMPTY_DOWN,
      downgraded: 10,
      ended: 10,
      advancedAfterGrace: 10,
    });
    expect((await (await GET(req(`Bearer ${SECRET}`))).json()).more).toBe(
      false,
    );
  });
});

describe("★★ promoting a scheduled GST change (GST design 5.12)", () => {
  it("runs once, before every renewal pass", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(taxSettings.promoteDueTaxChange).toHaveBeenCalledTimes(1);
    const p = taxSettings.promoteDueTaxChange.mock.invocationCallOrder[0];
    expect(p).toBeLessThan(
      worker.collectDueRenewals.mock.invocationCallOrder[0],
    );
    expect(p).toBeLessThan(
      recon.reconcileStrandedAttempts.mock.invocationCallOrder[0],
    );
    expect(p).toBeLessThan(
      recon.issueCapturedDrafts.mock.invocationCallOrder[0],
    );
  });

  it("gets the same `now` as every renewal pass", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(taxSettings.promoteDueTaxChange.mock.calls[0][0]).toBe(
      worker.collectDueRenewals.mock.calls[0][0].now,
    );
  });

  it("★ does not bust the public tax cache when nothing was promoted", async () => {
    taxSettings.promoteDueTaxChange.mockResolvedValue(null);
    await GET(req(`Bearer ${SECRET}`));
    expect(publicTax.bustPlatformTax).not.toHaveBeenCalled();
  });

  it("★ busts the public tax cache once when it promoted a change, and reports it", async () => {
    taxSettings.promoteDueTaxChange.mockResolvedValue({ ...PROMOTED });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(publicTax.bustPlatformTax).toHaveBeenCalledTimes(1);
    expect(
      taxSettings.promoteDueTaxChange.mock.invocationCallOrder[0],
    ).toBeLessThan(publicTax.bustPlatformTax.mock.invocationCallOrder[0]);
    expect(res.status).toBe(200);
    expect((await res.json()).promote).toEqual({
      promoted: PROMOTED,
      errors: 0,
    });
  });

  it("★ a failed promotion 503s, busts nothing, and the renewal passes still run", async () => {
    taxSettings.promoteDueTaxChange.mockRejectedValue(new Error("db down"));
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.promote).toEqual({ promoted: null, errors: 1 });
    expect(publicTax.bustPlatformTax).not.toHaveBeenCalled();
    expect(worker.collectDueRenewals).toHaveBeenCalled();
    expect(recon.issueCapturedDrafts).toHaveBeenCalled();
    expect(worker.evaluateCycleTurns).toHaveBeenCalled();
    expect(refundPass.processBillingRefunds).toHaveBeenCalled();
  });

  it("does not run when unauthorised", async () => {
    await GET(req("Bearer nope"));
    expect(taxSettings.promoteDueTaxChange).not.toHaveBeenCalled();
    expect(publicTax.bustPlatformTax).not.toHaveBeenCalled();
  });
});

describe("★★ the repair pass (GST design 5.4b)", () => {
  it("runs AFTER reconcile and BEFORE evaluate", async () => {
    // A payment repaired in this run must count as paid when the cycle turn
    // is evaluated in this run.
    await GET(req(`Bearer ${SECRET}`));
    const repair = recon.issueCapturedDrafts.mock.invocationCallOrder[0];
    expect(
      recon.reconcileStrandedAttempts.mock.invocationCallOrder[0],
    ).toBeLessThan(repair);
    expect(repair).toBeLessThan(
      worker.evaluateCycleTurns.mock.invocationCallOrder[0],
    );
  });

  it("runs over the whole database with the run's `now`, never one store", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(recon.issueCapturedDrafts).toHaveBeenCalledTimes(1);
    expect(recon.issueCapturedDrafts.mock.calls[0][0]).toEqual({
      now: worker.collectDueRenewals.mock.calls[0][0].now,
    });
  });

  it("★ its errors 503, so Scheduler retries", async () => {
    recon.issueCapturedDrafts.mockResolvedValue({ ...EMPTY_REPAIR, errors: 1 });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("★ its `more` joins the run's `more`", async () => {
    recon.issueCapturedDrafts.mockResolvedValue({
      ...EMPTY_REPAIR,
      more: true,
    });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).more).toBe(true);
  });

  it("puts its counts in the body; a draft left for the next run is not an error", async () => {
    recon.issueCapturedDrafts.mockResolvedValue({
      ...EMPTY_REPAIR,
      considered: 3,
      completed: 1,
      issued: 1,
      deferred: 1,
      unissued: 1,
    });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).repair).toMatchObject({
      considered: 3,
      completed: 1,
      issued: 1,
      deferred: 1,
      unissued: 1,
    });
  });

  it("does not run when unauthorised", async () => {
    await GET(req("Bearer nope"));
    expect(recon.issueCapturedDrafts).not.toHaveBeenCalled();
  });
});

describe("★★ the refund pass stays LAST", () => {
  it("runs after promote, collect, reconcile, repair, evaluate and downgrade", async () => {
    taxSettings.promoteDueTaxChange.mockResolvedValue({ ...PROMOTED });
    await GET(req(`Bearer ${SECRET}`));
    const refunds =
      refundPass.processBillingRefunds.mock.invocationCallOrder[0];
    for (const earlier of [
      taxSettings.promoteDueTaxChange,
      publicTax.bustPlatformTax,
      worker.collectDueRenewals,
      recon.reconcileStrandedAttempts,
      recon.issueCapturedDrafts,
      worker.evaluateCycleTurns,
      worker.downgradeExpired,
    ]) {
      expect(earlier.mock.invocationCallOrder[0]).toBeLessThan(refunds);
    }
  });
});
