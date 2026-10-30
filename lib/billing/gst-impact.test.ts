/* eslint-disable @typescript-eslint/no-explicit-any */
// The GST change impact preview (GST design 5.8).
//
// What carries the weight:
//   • each renewal is priced twice with the renewal worker's own arithmetic
//     (next-cycle shape, live prices, `buildSubscriptionInvoice`), under the
//     values in force and under the proposal, and routed with `collectionRoute`
//     against its own mandate;
//   • the state counts follow `placeOfSupplyFor` under the proposal, and say
//     nothing when the proposal charges no GST;
//   • it reads in batches of 200 by store id and keeps at most 200 rows, those
//     needing a person first;
//   • it only reads, one statement after another, and a failed read is never
//     a partial answer.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sqlParamValues, sqlText } from "@/app/actions/_test-helpers";
import { logError } from "@/lib/observability/logger";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const prices = vi.hoisted(() => ({
  plans: {
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
  },
  location: { monthlyInr: 1000, yearlyInr: 10000 },
}));
vi.mock("@/lib/plans/pricing", () => ({
  getPlanPricingLive: vi.fn(async () => prices.plans),
  getExtraLocationPricingLive: vi.fn(async () => prices.location),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current)),
}));

import { withService } from "@/lib/db/client";
import {
  getExtraLocationPricingLive,
  getPlanPricingLive,
} from "@/lib/plans/pricing";
import { impactLines } from "./tax-copy";
import {
  getGstChangeImpact,
  IMPACT_BATCH,
  IMPACT_ROWS,
  type GstImpactRow,
} from "./gst-impact";

const NOW = new Date("2026-11-20T06:30:00Z");
const NIL = "00000000-0000-0000-0000-000000000000";
const EXCLUSIVE_18 = { enabled: true, inclusive: false, rateBps: 1800 };
const INCLUSIVE_18 = { enabled: true, inclusive: true, rateBps: 1800 };
const OFF = { enabled: false, inclusive: false, rateBps: 0 };

const sid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** StoreMink's settings row: GST off, StoreMink in Punjab. */
function settings(over: Record<string, unknown> = {}) {
  return {
    tax_enabled: false,
    tax_inclusive: false,
    tax_rate_bps: 0,
    next_tax_enabled: null,
    next_tax_inclusive: null,
    next_tax_rate_bps: null,
    next_tax_starts_at: null,
    state_code: "03",
    ...over,
  };
}

/** A renewing subscription as the batch read returns it (bigints as text). */
function sub(n: number, over: Record<string, unknown> = {}) {
  return {
    store_id: sid(n),
    plan: "basic",
    period: "monthly",
    current_period_end: "2026-12-05 00:00:00+00",
    billed_locations: 0,
    scheduled_plan: null,
    scheduled_period: null,
    scheduled_locations: null,
    cancel_at_period_end: false,
    store_name: `Store ${n}`,
    store_slug: `store-${n}`,
    mandate_status: "active",
    mandate_max_paise: "500000",
    // A GSTIN on Billing details: the merchant's own state, no concern.
    account_gstin: "03AAACR5055K1Z7",
    account_state_code: null,
    account_country: "IN",
    tax_id: null,
    business_state_code: null,
    business_address: null,
    location_gstin: null,
    location_state_code: null,
    signup_state_name: null,
    signup_country: "IN",
    ...over,
  };
}

/** A statement-recording db that answers each execute from a queue. */
function makeDb(queue: any[][]) {
  const statements: any[] = [];
  let inFlight = 0;
  let most = 0;
  const db = {
    execute: vi.fn(async (q: any) => {
      statements.push(q);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return { rows: queue.length ? queue.shift()! : [] };
    }),
  };
  dbHolder.current = db;
  return {
    db,
    statements,
    get most() {
      return most;
    },
  };
}

async function impactOf(proposed: any, queue: any[][]) {
  const db = makeDb(queue);
  const result = await getGstChangeImpact(proposed, { now: NOW });
  if (!result.ok) throw new Error("expected ok");
  return { impact: result.impact, db };
}

const byStore = (rows: GstImpactRow[], n: number) =>
  rows.find((r) => r.storeId === sid(n))!;

beforeEach(() => {
  dbHolder.current = makeDb([]).db;
});

describe("getGstChangeImpact: what the proposal does to each renewal", () => {
  it("switching on GST excluded from prices raises every renewal and moves two to paying by hand", async () => {
    const { impact } = await impactOf(EXCLUSIVE_18, [
      [settings()],
      [
        // Basic yearly at the AFA limit today, over it after.
        sub(1, {
          period: "yearly",
          mandate_max_paise: "2700000",
          current_period_end: "2026-12-20 00:00:00+00",
        }),
        // Pro monthly with 2 extra locations: under its mandate today, over it after.
        sub(2, {
          plan: "pro",
          billed_locations: 2,
          mandate_max_paise: "800000",
          current_period_end: "2026-12-10 00:00:00+00",
        }),
        // Basic monthly: rises, still automatic.
        sub(3, { current_period_end: "2026-12-01 00:00:00+00" }),
        // No mandate: paid by hand both ways, so not "moves to by hand".
        sub(4, {
          mandate_status: null,
          mandate_max_paise: null,
          current_period_end: "2026-12-02 00:00:00+00",
        }),
      ],
    ]);

    expect(impact.before).toEqual({
      enabled: false,
      inclusive: false,
      rateBps: 0,
    });
    expect(impact.after).toEqual(EXCLUSIVE_18);
    expect(impact.renewals).toBe(4);
    expect(impact.truncated).toBe(false);
    expect(impact.counts).toEqual({
      rise: 4,
      byHand: 2,
      aboveMandate: 1,
      aboveAfaLimit: 1,
      noState: 0,
      fromAddress: 0,
      outsideIndia: 0,
      supplierStateCode: "03",
    });

    expect(byStore(impact.rows, 1)).toMatchObject({
      plan: "basic",
      period: "yearly",
      todayPaise: 1_500_000,
      afterPaise: 1_770_000,
      routeToday: { auto: true },
      routeAfter: { auto: false, reason: "over_afa_limit" },
      placeOfSupply: { code: "03", basis: "gstin" },
      renewsOn: "2026-12-20T00:00:00.000Z",
      storeName: "Store 1",
      storeSlug: "store-1",
    });
    expect(byStore(impact.rows, 2)).toMatchObject({
      plan: "pro",
      period: "monthly",
      billedLocations: 2,
      todayPaise: 700_000,
      afterPaise: 826_000,
      routeToday: { auto: true },
      routeAfter: { auto: false, reason: "over_mandate" },
    });
    expect(byStore(impact.rows, 3)).toMatchObject({
      todayPaise: 150_000,
      afterPaise: 177_000,
      routeToday: { auto: true },
      routeAfter: { auto: true },
    });
    expect(byStore(impact.rows, 4)).toMatchObject({
      routeToday: { auto: false, reason: "no_mandate" },
      routeAfter: { auto: false, reason: "no_mandate" },
    });

    // Those moving to paying by hand first, soonest renewal first; then the rest.
    expect(impact.rows.map((r) => r.storeId)).toEqual([
      sid(2),
      sid(1),
      sid(3),
      sid(4),
    ]);
    // The panel's own lines read these counts.
    expect(impactLines(impact.counts)[0]).toBe("4 renewals will cost more.");
  });

  it("switching on GST included in prices raises nothing", async () => {
    const { impact } = await impactOf(INCLUSIVE_18, [
      [settings()],
      [
        sub(1, { period: "yearly", mandate_max_paise: "2700000" }),
        sub(2, {
          plan: "pro",
          billed_locations: 2,
          mandate_max_paise: "800000",
        }),
      ],
    ]);
    expect(impact.counts.rise).toBe(0);
    expect(impact.counts.byHand).toBe(0);
    for (const row of impact.rows) {
      expect(row.afterPaise).toBe(row.todayPaise);
      expect(row.routeAfter).toEqual(row.routeToday);
    }
  });

  it("applies a scheduled plan the way the renewal will", async () => {
    const { impact } = await impactOf(EXCLUSIVE_18, [
      [settings()],
      [sub(1, { scheduled_plan: "pro", scheduled_period: "yearly" })],
    ]);
    expect(impact.rows[0]).toMatchObject({
      plan: "pro",
      period: "yearly",
      todayPaise: 5_000_000,
      afterPaise: 5_900_000,
    });
  });

  it("skips a subscription that ends at its period end", async () => {
    const { impact } = await impactOf(EXCLUSIVE_18, [
      [settings()],
      [sub(1, { cancel_at_period_end: true }), sub(2)],
    ]);
    expect(impact.renewals).toBe(1);
    expect(impact.rows.map((r) => r.storeId)).toEqual([sid(2)]);
  });

  it("a change that has already started is in force; one still pending is not", async () => {
    const started = await impactOf(EXCLUSIVE_18, [
      [
        settings({
          next_tax_enabled: true,
          next_tax_inclusive: false,
          next_tax_rate_bps: 1800,
          next_tax_starts_at: "2026-11-01 00:00:00+00",
        }),
      ],
      [sub(1)],
    ]);
    expect(started.impact.before).toEqual(EXCLUSIVE_18);
    expect(started.impact.counts.rise).toBe(0);
    expect(started.impact.rows[0].todayPaise).toBe(177_000);

    const pending = await impactOf(EXCLUSIVE_18, [
      [
        settings({
          next_tax_enabled: true,
          next_tax_inclusive: true,
          next_tax_rate_bps: 1800,
          next_tax_starts_at: "2026-12-25 00:00:00+00",
        }),
      ],
      [sub(1)],
    ]);
    expect(pending.impact.before.enabled).toBe(false);
    expect(pending.impact.counts.rise).toBe(1);
  });

  it("no settings row means GST is off today", async () => {
    const { impact } = await impactOf(EXCLUSIVE_18, [[], [sub(1)]]);
    expect(impact.before.enabled).toBe(false);
    expect(impact.counts.supplierStateCode).toBeNull();
    expect(impact.rows[0].todayPaise).toBe(150_000);
  });
});

describe("getGstChangeImpact: the state each store's invoices would name", () => {
  const stores = () => [
    // No record of the store's own: StoreMink's state would be used.
    sub(1, { account_gstin: null }),
    // A state read from the address it typed.
    sub(2, {
      account_gstin: null,
      business_address: "14 Barakhamba Road, Connaught Place, New Delhi 110001",
    }),
    // Outside India, named.
    sub(3, { account_gstin: null, account_country: "US" }),
    // Outside India, signup's "Other": no country named.
    sub(4, { account_gstin: null, signup_country: "OTHER" }),
    // A GSTIN: nothing to say.
    sub(5),
  ];

  it("counts stores with no state, a typed address, or outside India once GST is charged", async () => {
    const { impact } = await impactOf(EXCLUSIVE_18, [[settings()], stores()]);
    expect(impact.counts).toMatchObject({
      noState: 1,
      fromAddress: 1,
      outsideIndia: 2,
      supplierStateCode: "03",
    });
    expect(byStore(impact.rows, 1).placeOfSupply).toEqual({
      code: "03",
      basis: "supplier_state",
    });
    expect(byStore(impact.rows, 2).placeOfSupply).toEqual({
      code: "07",
      basis: "store_address",
    });
    expect(byStore(impact.rows, 3)).toMatchObject({
      placeOfSupply: { code: "96", basis: "outside_india" },
      countryName: "United States",
    });
    expect(byStore(impact.rows, 4)).toMatchObject({
      placeOfSupply: { code: "96", basis: "outside_india" },
      countryName: null,
    });
    expect(byStore(impact.rows, 5).countryName).toBeNull();
  });

  it("a store with no state and no StoreMink state still counts as no state", async () => {
    const { impact } = await impactOf(EXCLUSIVE_18, [
      [settings({ state_code: null })],
      [sub(1, { account_gstin: null })],
    ]);
    expect(impact.rows[0].placeOfSupply).toEqual({
      code: null,
      basis: "unknown",
    });
    expect(impact.counts.noState).toBe(1);
  });

  it("says nothing about states when the proposal charges no GST", async () => {
    const { impact } = await impactOf(OFF, [
      [settings({ tax_enabled: true, tax_rate_bps: 1800 })],
      stores(),
    ]);
    expect(impact.counts).toMatchObject({
      noState: 0,
      fromAddress: 0,
      outsideIndia: 0,
      rise: 0,
    });
    expect(byStore(impact.rows, 1).placeOfSupply.basis).toBe("unknown");
  });

  it("puts stores without a state of their own before rises only", async () => {
    const { impact } = await impactOf(EXCLUSIVE_18, [
      [settings()],
      [
        sub(1, { current_period_end: "2026-12-01 00:00:00+00" }),
        sub(2, {
          account_gstin: null,
          business_address: "14 Barakhamba Road, New Delhi 110001",
          current_period_end: "2026-12-30 00:00:00+00",
        }),
        sub(3, {
          account_gstin: null,
          current_period_end: "2026-12-31 00:00:00+00",
        }),
      ],
    ]);
    // No state first, then a typed address, then a rise only.
    expect(impact.rows.map((r) => r.storeId)).toEqual([sid(3), sid(2), sid(1)]);
  });
});

describe("getGstChangeImpact: batches, rows and reads", () => {
  it("reads 200 at a time by store id and keeps at most 200 rows, those needing a person first", async () => {
    const first = Array.from({ length: IMPACT_BATCH }, (_, i) => sub(i + 1));
    const second = Array.from({ length: 49 }, (_, i) =>
      sub(IMPACT_BATCH + i + 1),
    );
    // The last store renews soonest of all and moves to paying by hand.
    second.push(
      sub(250, {
        period: "yearly",
        mandate_max_paise: "2700000",
        current_period_end: "2026-12-31 00:00:00+00",
      }),
    );
    const { impact, db } = await impactOf(EXCLUSIVE_18, [
      [settings()],
      first,
      second,
    ]);

    expect(IMPACT_BATCH).toBe(200);
    expect(IMPACT_ROWS).toBe(200);
    expect(impact.renewals).toBe(250);
    expect(impact.counts.rise).toBe(250);
    expect(impact.counts.byHand).toBe(1);
    expect(impact.rows).toHaveLength(200);
    expect(impact.truncated).toBe(true);
    expect(impact.rows[0].storeId).toBe(sid(250));

    // Settings, then two batches; the short second batch ends the read.
    expect(db.statements).toHaveLength(3);
    expect(sqlParamValues(db.statements[1])).toEqual([NIL, IMPACT_BATCH]);
    expect(sqlParamValues(db.statements[2])).toEqual([sid(200), IMPACT_BATCH]);
    const text = sqlText(db.statements[1]).replace(/\s+/g, " ");
    expect(text).toContain("s.state in ('active', 'past_due', 'grace')");
    expect(text).toContain("s.cancel_at_period_end = false");
    expect(text).toContain("s.current_period_end is not null");
    expect(text).toContain("order by s.store_id");
  });

  it("stops when a full batch does not move the cursor", async () => {
    const full = Array.from({ length: IMPACT_BATCH }, () => sub(7));
    const { impact, db } = await impactOf(EXCLUSIVE_18, [
      [settings()],
      full,
      full,
      full,
    ]);
    expect(db.statements).toHaveLength(3);
    expect(impact.renewals).toBe(2 * IMPACT_BATCH);
  });

  it("only reads, in one scope, one statement after another", async () => {
    const { db } = await impactOf(EXCLUSIVE_18, [
      [settings()],
      Array.from({ length: IMPACT_BATCH }, (_, i) => sub(i + 1)),
      [sub(500)],
    ]);
    expect(withService).toHaveBeenCalledTimes(1);
    expect(db.most).toBe(1);
    for (const q of db.statements) {
      const s = sqlText(q).trim().toLowerCase();
      expect(s.startsWith("select")).toBe(true);
      expect(s).not.toMatch(/\b(insert|update|delete)\b/);
      expect(s).not.toMatch(/for (update|share)/);
    }
  });

  it("reads the live prices before opening its own scope, never inside it", async () => {
    await impactOf(EXCLUSIVE_18, [[settings()], [sub(1)]]);
    const planOrder = vi.mocked(getPlanPricingLive).mock.invocationCallOrder[0];
    const locOrder = vi.mocked(getExtraLocationPricingLive).mock
      .invocationCallOrder[0];
    const scopeOrder = vi.mocked(withService).mock.invocationCallOrder[0];
    expect(planOrder).toBeLessThan(scopeOrder);
    expect(locOrder).toBeLessThan(scopeOrder);
  });

  it("compiles with bound parameters only, no array", async () => {
    const { db } = await impactOf(EXCLUSIVE_18, [[settings()], [sub(1)]]);
    const dialect = new PgDialect();
    const settingsQuery = dialect.sqlToQuery(db.statements[0]);
    expect(settingsQuery.params).toEqual([]);
    const batch = dialect.sqlToQuery(db.statements[1]);
    expect(batch.params).toEqual([NIL, IMPACT_BATCH]);
    expect(batch.sql).toMatch(/s\.store_id > \$1::uuid/);
    expect(batch.sql).toMatch(/limit \$2/);
    for (const p of batch.params) expect(Array.isArray(p)).toBe(false);
  });

  it("a failed read is read_failed and logged, never a partial answer", async () => {
    const db = makeDb([[settings()]]);
    db.db.execute.mockImplementationOnce(async () => ({ rows: [settings()] }));
    db.db.execute.mockImplementationOnce(async () => {
      throw new Error("statement timeout");
    });
    const result = await getGstChangeImpact(EXCLUSIVE_18, { now: NOW });
    expect(result).toEqual({ ok: false, reason: "read_failed" });
    expect(logError).toHaveBeenCalledWith(
      "billing.gst_impact",
      expect.any(Error),
      { proposed: EXCLUSIVE_18 },
    );
  });

  it("a failed price read is read_failed and opens no scope", async () => {
    vi.mocked(getPlanPricingLive).mockRejectedValueOnce(new Error("no prices"));
    const result = await getGstChangeImpact(EXCLUSIVE_18, { now: NOW });
    expect(result).toEqual({ ok: false, reason: "read_failed" });
    expect(withService).not.toHaveBeenCalled();
  });
});
