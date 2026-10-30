/* eslint-disable @typescript-eslint/no-explicit-any */
// StoreMink's own tax identity.
//
// Everything here writes a value that ends up printed on a GST tax invoice, and
// finalized invoices are IMMUTABLE — so a bad value cannot be corrected later,
// only stopped from being stored. That is what these tests are for.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

// The saves bust the cached public tax source (GST design 5.11).
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

import { revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { platformBillingSettings } from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  DEFAULT_TAX_SETTINGS,
  MAX_START_AHEAD_MS,
  MIN_START_LEAD_MS,
  PLATFORM_TAX_TAG,
  PROMOTED_BY,
  bustPlatformTax,
  cancelScheduledTaxChange,
  earliestStartAfterNotice,
  effectiveRise,
  getPlatformTaxSettings,
  getRefundSettings,
  getTaxTermsLive,
  promoteDueTaxChange,
  readTaxTermsSource,
  saveTaxIdentity,
  savePlatformAutoRefunds,
  scheduleTaxChange,
  type TaxChangeInput,
  type TaxIdentityInput,
} from "./platform-settings";
import {
  AUTO_REFUNDS_IDENTITY_INCOMPLETE,
  INVALID_GSTIN,
  TAX_SETTINGS_REFUSAL,
  noticeRefusal,
  tooSoonAfterNotice,
} from "./tax-copy";

/** A real-shaped Delhi GSTIN (state 07). */
const GSTIN_07 = "07AABCS1429B1ZX";
/** Same shape, Karnataka (state 29). */
const GSTIN_29 = "29AABCS1429B1ZX";

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock({ selectQueue: [] });
});

describe("getPlatformTaxSettings", () => {
  it("★★ falls back to tax-OFF when there is no row", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getPlatformTaxSettings()).toEqual(DEFAULT_TAX_SETTINGS);
  });

  it("★★ an unreadable row is null, never tax-OFF defaults (review R3-05)", async () => {
    // Defaults on the console read as "GST off, no GSTIN", which an operator
    // could save over the stored identity. Null lets the console say the
    // settings could not be read and disable every save.
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    expect(await getPlatformTaxSettings()).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "billing.platform_settings.read",
      expect.any(Error),
    );
  });

  it("returns the stored row", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            legalName: "StoreMink",
            gstin: GSTIN_07,
            address: { city: "New Delhi" },
            stateCode: "07",
            taxEnabled: true,
            taxRateBps: 1800,
            taxInclusive: true,
            invoicePrefix: "SM",
            updatedAt: "2026-08-13T00:00:00.000Z",
            updatedBy: "op@storemink.com",
          },
        ],
      ],
    });
    const s = await getPlatformTaxSettings();
    expect(s).toMatchObject({
      taxEnabled: true,
      taxInclusive: true,
      taxRateBps: 1800,
      stateCode: "07",
    });
  });
});

// ---------------------------------------------------------------------------
// Automatic refund sending (renewal-cancel, migration 0264; owner decision D2).
// The switch decides whether money leaves StoreMink with no person pressing
// Send, so it ships off, is read live, and is written only on its own.
// ---------------------------------------------------------------------------

describe("the automatic refunds switch in the tax settings", () => {
  it("★ is off by default, as migration 0264 ships it", () => {
    expect(DEFAULT_TAX_SETTINGS.autoRefunds).toBe(false);
  });

  it("is read from the stored row", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...storedRow(), autoRefunds: true }]],
    });
    expect((await getPlatformTaxSettings())!.autoRefunds).toBe(true);
  });

  it("★ reads anything but a real true as off", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...storedRow(), autoRefunds: null }]],
    });
    expect((await getPlatformTaxSettings())!.autoRefunds).toBe(false);
  });

  it("★★ is never written by a tax identity save", async () => {
    // Over a stored row (an update) and with none yet (an insert).
    for (const row of [identityRow(), null]) {
      withRows(row);
      await saveTaxIdentity(identityInput(), "op@storemink.com");
      const written =
        row === null
          ? dbHolder.current.calls.values[0]
          : dbHolder.current.calls.set[0];
      expect(written).toBeDefined();
      expect(written).not.toHaveProperty("autoRefunds");
      expect(written).not.toHaveProperty("automaticRefundsFrom");
    }
  });
});

describe("getRefundSettings", () => {
  it("returns the stored switch and the moment automatic refunds began", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            autoRefunds: true,
            automaticRefundsFrom: "2026-10-28 11:25:00+05:30",
          },
        ],
      ],
    });
    expect(await getRefundSettings()).toEqual({
      autoRefunds: true,
      automaticRefundsFrom: "2026-10-28 11:25:00+05:30",
    });
  });

  it("★★ reads no settings row as sending off and no moment at all ('infinity')", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await getRefundSettings()).toEqual({
      autoRefunds: false,
      automaticRefundsFrom: null,
    });
  });

  it("★ reads anything but a real true as sending off", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ autoRefunds: "true", automaticRefundsFrom: "2026-10-28" }],
      ],
    });
    expect((await getRefundSettings()).autoRefunds).toBe(false);
  });

  it("★★ throws on a read failure instead of guessing, unlike the tax settings", async () => {
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    await expect(getRefundSettings()).rejects.toThrow("db down");
  });

  it("★★ reads the row again on every call, never a cached answer", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ autoRefunds: true, automaticRefundsFrom: "2026-10-28" }],
        [{ autoRefunds: false, automaticRefundsFrom: "2026-10-28" }],
      ],
    });
    expect((await getRefundSettings()).autoRefunds).toBe(true);
    expect((await getRefundSettings()).autoRefunds).toBe(false);
    expect(dbHolder.current.calls.select).toHaveLength(2);
  });

  it("selects only the two refund columns, one row", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await getRefundSettings();
    expect(Object.keys(dbHolder.current.calls.select[0])).toEqual([
      "autoRefunds",
      "automaticRefundsFrom",
    ]);
    expect(dbHolder.current.calls.limit).toEqual([1]);
  });

  it("runs inside the caller's transaction when given one", async () => {
    const mock = makeDbMock({
      selectQueue: [
        [{ autoRefunds: true, automaticRefundsFrom: "2026-10-28" }],
      ],
    });
    expect((await getRefundSettings(mock.db)).autoRefunds).toBe(true);
    expect(withService).not.toHaveBeenCalled();
    expect(mock.calls.select).toHaveLength(1);
  });

  it("opens its own transaction otherwise", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await getRefundSettings();
    expect(withService).toHaveBeenCalledTimes(1);
  });
});

describe("savePlatformAutoRefunds", () => {
  it("★★ writes the switch and who changed it, and nothing else", async () => {
    const res = await savePlatformAutoRefunds(true, "owner@storemink.com");
    expect(res).toEqual({ ok: true });

    const values = dbHolder.current.calls.values[0];
    expect(Object.keys(values).sort()).toEqual([
      "autoRefunds",
      "id",
      "updatedAt",
      "updatedBy",
    ]);
    expect(values).toMatchObject({
      id: true,
      autoRefunds: true,
      updatedBy: "owner@storemink.com",
    });
    expect(typeof values.updatedAt).toBe("string");

    const set = dbHolder.current.calls.onConflict[0].set;
    expect(Object.keys(set).sort()).toEqual([
      "autoRefunds",
      "updatedAt",
      "updatedBy",
    ]);
    expect(set).toMatchObject({
      autoRefunds: true,
      updatedBy: "owner@storemink.com",
    });
  });

  it("switches sending off", async () => {
    expect(await savePlatformAutoRefunds(false, null)).toEqual({ ok: true });
    expect(dbHolder.current.calls.values[0].autoRefunds).toBe(false);
    expect(dbHolder.current.calls.onConflict[0].set.autoRefunds).toBe(false);
  });

  it("logs the change by value only", async () => {
    await savePlatformAutoRefunds(true, "owner@storemink.com");
    expect(logInfo).toHaveBeenCalledWith("billing.auto_refunds_changed", {
      autoRefunds: true,
    });
  });

  it.each(["true", 1, null, undefined])(
    "★ refuses %s, which is not a real on or off",
    async (value) => {
      const res = await savePlatformAutoRefunds(value as any, null);
      expect(res).toEqual({ ok: false, error: "Choose on or off." });
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    },
  );

  it("★ reports a write failure rather than claiming success", async () => {
    dbHolder.current.db.insert = () => {
      throw new Error("db down");
    };
    expect(await savePlatformAutoRefunds(true, null)).toEqual({
      ok: false,
      error: "Couldn't save that setting. Please try again.",
    });
    expect(logError).toHaveBeenCalledWith(
      "billing.auto_refunds.save",
      expect.any(Error),
    );
    expect(logInfo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GST Stage 4: the read side of the scheduled change, StoreMink's identity on
// an invoice, and the live terms (GST design 5.8, 5.11).
// ---------------------------------------------------------------------------

/** The four scheduled-change columns, all set. */
const SCHEDULED = {
  nextTaxEnabled: true,
  nextTaxInclusive: false,
  nextTaxRateBps: 1800,
  nextTaxStartsAt: "2026-11-30T18:30:00.000Z",
  nextTaxNoticeId: "notice-1",
};

describe("the GST columns in the tax settings", () => {
  it("★ the defaults schedule nothing and name no SAC, LLPIN or office", () => {
    expect(DEFAULT_TAX_SETTINGS).toMatchObject({
      nextTax: null,
      sacCode: null,
      llpin: null,
      registeredOffice: null,
    });
  });

  it("reads the scheduled change, the SAC code, LLPIN and registered office", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            ...storedRow(),
            ...SCHEDULED,
            sacCode: "998314",
            llpin: "ADC-5432",
            registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
            autoRefunds: true,
          },
        ],
      ],
    });
    const s = (await getPlatformTaxSettings())!;
    expect(s.nextTax).toEqual({
      enabled: true,
      inclusive: false,
      rateBps: 1800,
      startsAt: "2026-11-30T18:30:00.000Z",
      noticeId: "notice-1",
    });
    expect(s).toMatchObject({
      sacCode: "998314",
      llpin: "ADC-5432",
      registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
      // The refund switch is still read beside them.
      autoRefunds: true,
    });
  });

  it("★★ a half-scheduled change reads as no change, never a change to off", async () => {
    // termsAt reads the change only when all four are set; the console must
    // show the same answer.
    for (const missing of [
      "nextTaxEnabled",
      "nextTaxInclusive",
      "nextTaxRateBps",
      "nextTaxStartsAt",
    ]) {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ ...storedRow(), ...SCHEDULED, [missing]: null }]],
      });
      expect((await getPlatformTaxSettings())!.nextTax).toBeNull();
    }
  });

  it("a scheduled change without a notice keeps a null notice id", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...storedRow(), ...SCHEDULED, nextTaxNoticeId: null }]],
    });
    expect((await getPlatformTaxSettings())!.nextTax?.noticeId).toBeNull();
  });

  it("a row from before the GST columns reads as none of them", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[storedRow()]] });
    expect(await getPlatformTaxSettings()).toMatchObject({
      nextTax: null,
      sacCode: null,
      llpin: null,
      registeredOffice: null,
    });
  });
});

describe("readTaxTermsSource", () => {
  it("returns the seven columns the terms are read from", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            taxEnabled: true,
            taxInclusive: true,
            taxRateBps: 1800,
            nextTaxEnabled: false,
            nextTaxInclusive: false,
            nextTaxRateBps: 0,
            nextTaxStartsAt: "2027-04-01T00:00:00.000Z",
          },
        ],
      ],
    });
    expect(await readTaxTermsSource()).toEqual({
      taxEnabled: true,
      taxInclusive: true,
      taxRateBps: 1800,
      nextTaxEnabled: false,
      nextTaxInclusive: false,
      nextTaxRateBps: 0,
      nextTaxStartsAt: "2027-04-01T00:00:00.000Z",
    });
    expect(Object.keys(dbHolder.current.calls.select[0]).sort()).toEqual([
      "nextTaxEnabled",
      "nextTaxInclusive",
      "nextTaxRateBps",
      "nextTaxStartsAt",
      "taxEnabled",
      "taxInclusive",
      "taxRateBps",
    ]);
    expect(dbHolder.current.calls.limit).toEqual([1]);
  });

  it("★ no settings row reads as GST off with nothing scheduled", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await readTaxTermsSource()).toEqual({
      taxEnabled: false,
      taxInclusive: false,
      taxRateBps: 0,
      nextTaxEnabled: null,
      nextTaxInclusive: null,
      nextTaxRateBps: null,
      nextTaxStartsAt: null,
    });
  });

  it("★★ THROWS on a read failure: a guessed GST-off would quote the wrong amount", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
    await expect(readTaxTermsSource()).rejects.toThrow("db down");
    expect(logError).not.toHaveBeenCalled();
  });

  it("runs inside the caller's transaction when given one", async () => {
    const mine = makeDbMock({ selectQueue: [[]] });
    await readTaxTermsSource(mine.db);
    expect(withService).not.toHaveBeenCalled();
    expect(mine.calls.select).toHaveLength(1);
  });

  it("opens its own transaction otherwise", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await readTaxTermsSource();
    expect(withService).toHaveBeenCalledTimes(1);
  });
});

describe("getTaxTermsLive", () => {
  const CHANGE_AT_MIDNIGHT_IST = {
    taxEnabled: false,
    taxInclusive: false,
    taxRateBps: 1800,
    nextTaxEnabled: true,
    nextTaxInclusive: false,
    nextTaxRateBps: 1800,
    nextTaxStartsAt: "2026-11-30T18:30:00.000Z",
  };

  it("before a scheduled start: today's terms, with the change still to come", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[CHANGE_AT_MIDNIGHT_IST]] });
    const terms = await getTaxTermsLive(new Date("2026-11-30T17:30:00.000Z"));
    expect(terms).toMatchObject({ active: false, rateBps: 0 });
    expect(terms.upcoming).toMatchObject({
      enabled: true,
      rateBps: 1800,
      startsAt: "2026-11-30T18:30:00.000Z",
    });
  });

  it("★ at the scheduled start: the new terms, read live", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[CHANGE_AT_MIDNIGHT_IST]] });
    const terms = await getTaxTermsLive(new Date("2026-11-30T18:30:00.000Z"));
    expect(terms).toMatchObject({
      active: true,
      inclusive: false,
      rateBps: 1800,
      upcoming: null,
    });
  });

  it("★★ reads the row again on every call, never a cached answer", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ ...CHANGE_AT_MIDNIGHT_IST, nextTaxStartsAt: null }],
        [
          {
            ...CHANGE_AT_MIDNIGHT_IST,
            taxEnabled: true,
            nextTaxStartsAt: null,
          },
        ],
      ],
    });
    const at = new Date("2026-10-30T00:00:00.000Z");
    expect((await getTaxTermsLive(at)).active).toBe(false);
    expect((await getTaxTermsLive(at)).active).toBe(true);
  });

  it("throws on a read failure, like the source it reads", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [new Error("db down")] });
    await expect(getTaxTermsLive()).rejects.toThrow("db down");
  });
});

/** A stored settings row as Drizzle returns it, before migration 0264's columns. */
function storedRow() {
  return {
    legalName: "StoreMink",
    gstin: GSTIN_07,
    address: { city: "New Delhi" },
    stateCode: "07",
    taxEnabled: true,
    taxRateBps: 1800,
    taxInclusive: false,
    invoicePrefix: "SM",
    updatedAt: "2026-10-28T00:00:00.000Z",
    updatedBy: "op@storemink.com",
  };
}

// ---------------------------------------------------------------------------
// GST Stage 9: the write side (GST design 5.8, 5.11, plan A2).
// ---------------------------------------------------------------------------

/** A Punjab GSTIN (state 03), the LLP's own shape. */
const GSTIN_03 = "03ABCDE1234F1Z5";
const NOTICE_ID = "4a3c8a51-0b4e-4f63-9e2b-2f0f3f6c1a10";
const SAVE_FAILED = "Couldn't save those settings. Please try again.";

/** The settings row with the LLP's identity complete. */
function identityRow(over: Record<string, unknown> = {}) {
  return {
    id: true,
    legalName: "STOREMINK LLP",
    gstin: GSTIN_03,
    address: {
      line1: "Bala ji Colony",
      city: "Faridkot",
      postalCode: "151203",
    },
    stateCode: "03",
    taxEnabled: false,
    taxRateBps: 1800,
    taxInclusive: false,
    invoicePrefix: "SM",
    sacCode: "998314",
    llpin: "ADC-5432",
    registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
    nextTaxEnabled: null,
    nextTaxInclusive: null,
    nextTaxRateBps: null,
    nextTaxStartsAt: null,
    nextTaxNoticeId: null,
    autoRefunds: false,
    updatedAt: "2026-10-28T00:00:00.000Z",
    updatedBy: "op@storemink.com",
    ...over,
  };
}

function identityInput(over: Partial<TaxIdentityInput> = {}): TaxIdentityInput {
  return {
    legalName: "STOREMINK LLP",
    gstin: GSTIN_03,
    stateCode: "03",
    addressLine1: "Bala ji Colony",
    addressLine2: "",
    city: "Faridkot",
    postalCode: "151203",
    sacCode: "998314",
    llpin: "ADC-5432",
    registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
    invoicePrefix: "SM",
    ...over,
  };
}

function changeInput(over: Partial<TaxChangeInput> = {}): TaxChangeInput {
  return {
    enabled: true,
    inclusive: true,
    ratePercent: 18,
    when: "now",
    ...over,
  };
}

/** An announcement that counts as the notice: Operational, sent by email to
 *  every store owner. */
function noticeRow(over: Record<string, unknown> = {}) {
  return {
    category: "operational",
    status: "sent",
    sent: 12,
    sentAt: "2026-11-10T09:30:00.000Z",
    channels: { email: true, sms: false },
    audience: { include: ["owner"] },
    ...over,
  };
}

/** The settings row (and an announcement) the transaction reads. */
function withRows(row: unknown, notice?: unknown) {
  dbHolder.current = makeDbMock({
    selectByTable: {
      platform_billing_settings: row === null ? [[]] : [[row]],
      ...(notice === undefined
        ? {}
        : {
            platform_announcements: notice === null ? [[]] : [[notice]],
          }),
    },
  });
}

/** Nothing was inserted, upserted or updated. */
function expectNothingWritten() {
  expect(dbHolder.current.calls.insert).toHaveLength(0);
  expect(dbHolder.current.calls.update).toHaveLength(0);
}

describe("bustPlatformTax", () => {
  it("★ marks the tag `platform-tax` stale with Next 16's profile", () => {
    expect(PLATFORM_TAX_TAG).toBe("platform-tax");
    bustPlatformTax();
    expect(revalidateTag).toHaveBeenCalledWith("platform-tax", "max");
  });

  it("★ never throws: a failed bust must not fail a save that committed", () => {
    vi.mocked(revalidateTag).mockImplementation(() => {
      throw new Error("no request scope");
    });
    expect(() => bustPlatformTax()).not.toThrow();
    expect(logWarn).toHaveBeenCalledWith("billing.platform_tax.bust_failed", {
      error: "no request scope",
    });
  });
});

describe("promoteDueTaxChange (GST design 5.8 item 4)", () => {
  const AT = new Date("2026-12-01T00:00:00.000Z");

  it("★★ one statement: a locked read of a started change, copied into the in-force columns and cleared", async () => {
    await promoteDueTaxChange(AT);
    const calls = dbHolder.current.calls.execute;
    expect(calls).toHaveLength(1);
    const text = sqlText(calls[0]).replace(/\s+/g, " ");
    expect(text).toContain("next_tax_starts_at is not null");
    expect(text).toContain("and next_tax_starts_at <=");
    expect(text).toContain("for update");
    expect(text).toContain("set tax_enabled = d.next_tax_enabled");
    expect(text).toContain("tax_inclusive = d.next_tax_inclusive");
    expect(text).toContain("tax_rate_bps = d.next_tax_rate_bps");
    for (const column of [
      "next_tax_enabled",
      "next_tax_inclusive",
      "next_tax_rate_bps",
      "next_tax_starts_at",
      "next_tax_notice_id",
    ]) {
      expect(text).toContain(`${column} = null`);
    }
    expect(text).toContain("updated_at = now()");
    expect(text).toContain("where s.id");
    expect(sqlParamValues(calls[0])).toEqual([AT.toISOString(), PROMOTED_BY]);
    expect(PROMOTED_BY).toBe("system: scheduled GST change");
  });

  it("returns null when nothing has started", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[]] });
    expect(await promoteDueTaxChange(AT)).toBeNull();
  });

  it("returns the change it promoted", async () => {
    dbHolder.current = makeDbMock({
      executeQueue: [
        [
          {
            enabled: true,
            inclusive: false,
            rate_bps: "1800",
            starts_at: "2026-11-30T18:30:00.000Z",
            notice_id: NOTICE_ID,
          },
        ],
      ],
    });
    expect(await promoteDueTaxChange(AT)).toEqual({
      enabled: true,
      inclusive: false,
      rateBps: 1800,
      startsAt: "2026-11-30T18:30:00.000Z",
      noticeId: NOTICE_ID,
    });
  });

  it("★ busts nothing itself: the caller busts when it returned a change", async () => {
    dbHolder.current = makeDbMock({
      executeQueue: [
        [
          {
            enabled: false,
            inclusive: false,
            rate_bps: 1800,
            starts_at: "2026-11-30T18:30:00.000Z",
            notice_id: null,
          },
        ],
      ],
    });
    await promoteDueTaxChange(AT);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("runs inside the caller's transaction when given one, its own otherwise", async () => {
    const mine = makeDbMock();
    await promoteDueTaxChange(AT, mine.db);
    expect(withService).not.toHaveBeenCalled();
    expect(mine.calls.execute).toHaveLength(1);
    await promoteDueTaxChange(AT);
    expect(withService).toHaveBeenCalledTimes(1);
  });

  it("throws on a database error", async () => {
    dbHolder.current.db.execute = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(promoteDueTaxChange(AT)).rejects.toThrow("db down");
  });
});

describe("saveTaxIdentity (GST design 5.8 item 1)", () => {
  beforeEach(() => withRows(identityRow()));

  it("★★ writes who StoreMink is and never what it charges", async () => {
    const res = await saveTaxIdentity(identityInput(), "op@storemink.com");
    expect(res).toEqual({ ok: true });
    const values = dbHolder.current.calls.set[0];
    expect(Object.keys(values).sort()).toEqual([
      "address",
      "gstin",
      "invoicePrefix",
      "legalName",
      "llpin",
      "registeredOffice",
      "sacCode",
      "stateCode",
      "updatedAt",
      "updatedBy",
    ]);
    expect(values).toMatchObject({
      legalName: "STOREMINK LLP",
      gstin: GSTIN_03,
      stateCode: "03",
      sacCode: "998314",
      llpin: "ADC-5432",
      registeredOffice: "Bala ji Colony, Faridkot, Punjab, India",
      invoicePrefix: "SM",
      updatedBy: "op@storemink.com",
      address: {
        line1: "Bala ji Colony",
        line2: "",
        city: "Faridkot",
        postalCode: "151203",
      },
    });
  });

  it("normalises the case and the spaces it can", async () => {
    await saveTaxIdentity(
      identityInput({
        gstin: GSTIN_03.toLowerCase(),
        llpin: "adc-5432",
        sacCode: " 998 314 ",
        postalCode: "151 203",
        invoicePrefix: "sm",
      }),
      null,
    );
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      gstin: GSTIN_03,
      llpin: "ADC-5432",
      sacCode: "998314",
      invoicePrefix: "SM",
      address: { postalCode: "151203" },
    });
  });

  it("★★ updates the locked row, and inserts only when there is none, never INSERT ... ON CONFLICT (review R3-13)", async () => {
    // A stored row: one UPDATE of it, no insert at all. PostgreSQL checks a
    // proposed insert row against every CHECK before the conflict, and that
    // row would carry the defaults of every column this save does not write.
    expect(await saveTaxIdentity(identityInput(), null)).toEqual({ ok: true });
    expect(dbHolder.current.calls.update).toEqual([platformBillingSettings]);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(dbHolder.current.calls.onConflict).toHaveLength(0);

    // No row yet: one plain INSERT of the singleton, GST off by default.
    withRows(null);
    expect(await saveTaxIdentity(identityInput(), null)).toEqual({ ok: true });
    expect(dbHolder.current.calls.insert).toEqual([platformBillingSettings]);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      id: true,
      legalName: "STOREMINK LLP",
    });
    expect(dbHolder.current.calls.values[0]).not.toHaveProperty("taxEnabled");
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(dbHolder.current.calls.onConflict).toHaveLength(0);
  });

  it("★★ refuses when the locked row cannot be read, writing nothing (review R3-05)", async () => {
    // A save never writes over a row it could not judge.
    dbHolder.current = makeDbMock({
      selectByTable: { platform_billing_settings: [new Error("db down")] },
    });
    expect(await saveTaxIdentity(identityInput({ gstin: "" }), null)).toEqual({
      ok: false,
      error: SAVE_FAILED,
    });
    expectNothingWritten();
    expect(logError).toHaveBeenCalledWith(
      "billing.tax_identity.save",
      expect.any(Error),
    );
  });

  describe("★ an LLPIN needs the registered legal name beside it (review R2-08)", () => {
    it.each([
      ["GST off", identityRow()],
      ["no row yet", null],
    ])(
      "%s: an LLPIN with no legal name is refused, writing nothing",
      async (_l, row) => {
        for (const legalName of ["", "   "]) {
          withRows(row);
          expect(
            await saveTaxIdentity(identityInput({ legalName }), null),
          ).toEqual({
            ok: false,
            error: TAX_SETTINGS_REFUSAL.llpinWithoutLegalName,
          });
          expectNothingWritten();
        }
      },
    );

    it("GST on or scheduled on: the GST-on refusal comes first", async () => {
      for (const row of [
        identityRow({ taxEnabled: true }),
        identityRow({ nextTaxEnabled: true }),
      ]) {
        withRows(row);
        expect(
          await saveTaxIdentity(identityInput({ legalName: "" }), null),
        ).toEqual({
          ok: false,
          error: TAX_SETTINGS_REFUSAL.clearIdentityWhileOn,
        });
        expectNothingWritten();
      }
    });

    it("an LLPIN with the legal name saves, and so does neither", async () => {
      expect(await saveTaxIdentity(identityInput(), null)).toEqual({
        ok: true,
      });
      withRows(identityRow());
      expect(
        await saveTaxIdentity(
          identityInput({ legalName: "", llpin: "" }),
          null,
        ),
      ).toEqual({ ok: true });
      expect(dbHolder.current.calls.set[0]).toMatchObject({
        legalName: null,
        llpin: null,
      });
    });
  });

  it("★ promotes a started change first, then judges the row under a lock", async () => {
    await saveTaxIdentity(identityInput(), null);
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    expect(sqlText(dbHolder.current.calls.execute[0])).toContain(
      "next_tax_starts_at <=",
    );
    expect(dbHolder.current.calls.forUpdate).toEqual(["update"]);
    expect(
      dbHolder.current.db.execute.mock.invocationCallOrder[0],
    ).toBeLessThan(dbHolder.current.db.select.mock.invocationCallOrder[0]);
  });

  it("★ busts the public tax source after it commits", async () => {
    await saveTaxIdentity(identityInput(), null);
    expect(revalidateTag).toHaveBeenCalledWith("platform-tax", "max");
  });

  it.each([
    ["a malformed GSTIN", { gstin: "NOTAGSTIN" }, INVALID_GSTIN],
    [
      "a SAC code of 5 digits",
      { sacCode: "99831" },
      TAX_SETTINGS_REFUSAL.sacShape,
    ],
    [
      "a SAC code not starting with 99",
      { sacCode: "123456" },
      TAX_SETTINGS_REFUSAL.sacShape,
    ],
    [
      "an LLPIN without its hyphen",
      { llpin: "ADC5432" },
      TAX_SETTINGS_REFUSAL.llpinShape,
    ],
    [
      "a 3-character prefix",
      { invoicePrefix: "SMX" },
      TAX_SETTINGS_REFUSAL.prefix,
    ],
    ["an empty prefix", { invoicePrefix: "  " }, TAX_SETTINGS_REFUSAL.prefix],
    [
      "a prefix with a symbol",
      { invoicePrefix: "S-" },
      TAX_SETTINGS_REFUSAL.prefix,
    ],
  ])(
    "★ refuses %s with its sentence, writing nothing",
    async (_l, over, error) => {
      const res = await saveTaxIdentity(identityInput(over), null);
      expect(res).toEqual({ ok: false, error });
      expectNothingWritten();
      expect(withService).not.toHaveBeenCalled();
    },
  );

  it("★ refuses a GSTIN whose state digits contradict the state", async () => {
    const res = await saveTaxIdentity(
      identityInput({ gstin: GSTIN_29, stateCode: "03" }),
      null,
    );
    expect(res).toEqual({
      ok: false,
      error:
        "Your GSTIN starts with 29, which is a different state from the one selected (03). One of them is wrong - they decide CGST+SGST vs IGST on every invoice.",
    });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  describe("★★ while GST is on or scheduled on, no particular can be removed", () => {
    it.each([
      ["the GSTIN", { gstin: "" }],
      ["the state", { stateCode: "" }],
      ["the legal name", { legalName: "   " }],
      ["the SAC code", { sacCode: "" }],
      ["address line 1", { addressLine1: "" }],
      ["the PIN", { postalCode: "" }],
      ["a 6-digit PIN (a 5-digit one)", { postalCode: "15120" }],
      ["the LLPIN", { llpin: "" }],
      ["the registered office", { registeredOffice: " " }],
    ])("GST on: clearing %s is refused", async (_l, over) => {
      withRows(identityRow({ taxEnabled: true }));
      const res = await saveTaxIdentity(identityInput(over), null);
      expect(res).toEqual({
        ok: false,
        error: TAX_SETTINGS_REFUSAL.clearIdentityWhileOn,
      });
      expectNothingWritten();
    });

    it("GST scheduled on: clearing the SAC code is refused", async () => {
      withRows(
        identityRow({
          nextTaxEnabled: true,
          nextTaxInclusive: false,
          nextTaxRateBps: 1800,
          nextTaxStartsAt: "2026-12-01T00:00:00.000Z",
        }),
      );
      const res = await saveTaxIdentity(identityInput({ sacCode: "" }), null);
      expect(res).toEqual({
        ok: false,
        error: TAX_SETTINGS_REFUSAL.clearIdentityWhileOn,
      });
      expectNothingWritten();
    });

    it("★ GST off, or scheduled off: a partial identity saves", async () => {
      for (const row of [
        identityRow(),
        identityRow({
          nextTaxEnabled: false,
          nextTaxInclusive: false,
          nextTaxRateBps: 1800,
          nextTaxStartsAt: "2026-12-01T00:00:00.000Z",
        }),
        null,
      ]) {
        withRows(row);
        const res = await saveTaxIdentity(
          identityInput({ gstin: "", sacCode: "", llpin: "" }),
          null,
        );
        expect(res).toEqual({ ok: true });
        const written =
          row === null
            ? dbHolder.current.calls.values[0]
            : dbHolder.current.calls.set[0];
        expect(written).toMatchObject({
          gstin: null,
          sacCode: null,
          llpin: null,
        });
      }
    });

    it("GST on: a complete identity still saves", async () => {
      withRows(identityRow({ taxEnabled: true }));
      expect(
        await saveTaxIdentity(identityInput({ city: "Ludhiana" }), null),
      ).toEqual({ ok: true });
    });
  });

  it("★ reports a write failure rather than claiming success", async () => {
    dbHolder.current.db.update = () => {
      throw new Error("db down");
    };
    expect(await saveTaxIdentity(identityInput(), null)).toEqual({
      ok: false,
      error: SAVE_FAILED,
    });
    expect(logError).toHaveBeenCalledWith(
      "billing.tax_identity.save",
      expect.any(Error),
    );
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});

describe("scheduleTaxChange (GST design 5.8 item 2)", () => {
  // 10 Nov 2026, 15:30 IST.
  const NOW = new Date("2026-11-10T10:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    withRows(identityRow());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const inMinutes = (m: number) =>
    new Date(NOW.getTime() + m * 60_000).toISOString();

  describe("now", () => {
    it("★★ switching GST on with prices including it writes the in-force columns and clears any scheduled change", async () => {
      const res = await scheduleTaxChange(changeInput(), "op@storemink.com");
      expect(res).toEqual({ ok: true, applied: "now", startsAt: null });
      const values = dbHolder.current.calls.set[0];
      expect(values).toEqual({
        taxEnabled: true,
        taxInclusive: true,
        taxRateBps: 1800,
        nextTaxEnabled: null,
        nextTaxInclusive: null,
        nextTaxRateBps: null,
        nextTaxStartsAt: null,
        nextTaxNoticeId: null,
        updatedAt: NOW.toISOString(),
        updatedBy: "op@storemink.com",
      });
      expect(dbHolder.current.calls.update).toEqual([platformBillingSettings]);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
      // No notice is read for a change that does not raise bills.
      expect(dbHolder.current.calls.select).toHaveLength(1);
    });

    it("switching GST off is allowed, with no identity", async () => {
      withRows(identityRow({ taxEnabled: true, sacCode: null, llpin: null }));
      const res = await scheduleTaxChange(
        changeInput({ enabled: false, inclusive: false }),
        null,
      );
      expect(res).toMatchObject({ ok: true, applied: "now" });
      expect(dbHolder.current.calls.set[0].taxEnabled).toBe(false);
    });

    it("a rate cut is allowed now", async () => {
      withRows(identityRow({ taxEnabled: true }));
      const res = await scheduleTaxChange(
        changeInput({ inclusive: false, ratePercent: 12 }),
        null,
      );
      expect(res).toMatchObject({ ok: true, applied: "now" });
      expect(dbHolder.current.calls.set[0].taxRateBps).toBe(1200);
    });

    it.each([
      ["switching GST on with prices excluding it", identityRow(), {}],
      [
        "moving from prices including GST to prices excluding it",
        identityRow({ taxEnabled: true, taxInclusive: true }),
        {},
      ],
      [
        "★ a higher rate on prices excluding GST (a rate set by law needs the Terms first)",
        identityRow({ taxEnabled: true, taxRateBps: 1200 }),
        { rateSetByLaw: true },
      ],
    ])("★★ refuses %s: it raises what merchants pay", async (_l, row, over) => {
      withRows(row);
      const res = await scheduleTaxChange(
        changeInput({ inclusive: false, ...over }),
        null,
      );
      expect(res).toEqual({ ok: false, error: TAX_SETTINGS_REFUSAL.riseNow });
      expectNothingWritten();
    });
  });

  describe("★★ switching GST on needs the whole identity", () => {
    it.each([
      ["the GSTIN", { gstin: null }, TAX_SETTINGS_REFUSAL.enableWithoutGstin],
      [
        "the state",
        { stateCode: null },
        TAX_SETTINGS_REFUSAL.enableWithoutState,
      ],
      [
        "the legal name",
        { legalName: " " },
        TAX_SETTINGS_REFUSAL.enableWithoutLegalName,
      ],
      [
        "the SAC code",
        { sacCode: null },
        TAX_SETTINGS_REFUSAL.enableWithoutSac,
      ],
      [
        "address line 1",
        { address: { line1: "", postalCode: "151203" } },
        TAX_SETTINGS_REFUSAL.enableWithoutAddress,
      ],
      [
        "a 6-digit PIN",
        { address: { line1: "Bala ji Colony", postalCode: "051203" } },
        TAX_SETTINGS_REFUSAL.enableWithoutAddress,
      ],
      ["the LLPIN", { llpin: null }, TAX_SETTINGS_REFUSAL.enableWithoutLlp],
      [
        "the registered office",
        { registeredOffice: "" },
        TAX_SETTINGS_REFUSAL.enableWithoutLlp,
      ],
    ])("refuses without %s, now or scheduled", async (_l, gap, error) => {
      for (const when of ["now", "scheduled"] as const) {
        withRows(identityRow(gap));
        const res = await scheduleTaxChange(
          changeInput({ when, startsAt: inMinutes(60) }),
          null,
        );
        expect(res.ok).toBe(false);
        if (res.ok) return;
        if (typeof error === "string") expect(res.error).toBe(error);
        else expect(res.error).toMatch(error);
        expectNothingWritten();
      }
    });

    it("refuses with no settings row at all", async () => {
      withRows(null);
      const res = await scheduleTaxChange(changeInput(), null);
      expect(res.ok).toBe(false);
      expectNothingWritten();
    });
  });

  describe("scheduled", () => {
    it("★ refuses a start under 5 minutes away, or one that cannot be read", async () => {
      for (const startsAt of [
        inMinutes(4.99),
        inMinutes(-60),
        "not a date",
        undefined,
      ]) {
        const res = await scheduleTaxChange(
          changeInput({ when: "scheduled", startsAt }),
          null,
        );
        expect(res).toEqual({
          ok: false,
          error: TAX_SETTINGS_REFUSAL.startTooClose,
        });
      }
      expect(withService).not.toHaveBeenCalled();
    });

    it("★ refuses a start more than 400 days ahead, before any read (review R3-09)", async () => {
      expect(MAX_START_AHEAD_MS).toBe(400 * 24 * 60 * 60_000);
      const res = await scheduleTaxChange(
        changeInput({
          when: "scheduled",
          startsAt: new Date(
            NOW.getTime() + MAX_START_AHEAD_MS + 1,
          ).toISOString(),
        }),
        null,
      );
      expect(res).toEqual({
        ok: false,
        error: TAX_SETTINGS_REFUSAL.startTooFar,
      });
      expect(withService).not.toHaveBeenCalled();
    });

    it("★ exactly 400 days ahead is accepted", async () => {
      const startsAt = new Date(
        NOW.getTime() + MAX_START_AHEAD_MS,
      ).toISOString();
      const res = await scheduleTaxChange(
        changeInput({ when: "scheduled", startsAt }),
        null,
      );
      expect(res).toEqual({ ok: true, applied: "scheduled", startsAt });
    });

    it("★★ refuses when the locked row cannot be read, writing nothing (review R3-05)", async () => {
      dbHolder.current = makeDbMock({
        selectByTable: { platform_billing_settings: [new Error("db down")] },
      });
      const res = await scheduleTaxChange(
        changeInput({ when: "scheduled", startsAt: inMinutes(60) }),
        null,
      );
      expect(res).toEqual({ ok: false, error: SAVE_FAILED });
      expectNothingWritten();
    });

    it("★ exactly 5 minutes ahead is accepted", async () => {
      expect(MIN_START_LEAD_MS).toBe(300_000);
      const res = await scheduleTaxChange(
        changeInput({ when: "scheduled", startsAt: inMinutes(5) }),
        null,
      );
      expect(res).toEqual({
        ok: true,
        applied: "scheduled",
        startsAt: inMinutes(5),
      });
    });

    it("★★ writes only the scheduled change, never the in-force columns", async () => {
      const res = await scheduleTaxChange(
        changeInput({ when: "scheduled", startsAt: inMinutes(60) }),
        "op@storemink.com",
      );
      expect(res).toEqual({
        ok: true,
        applied: "scheduled",
        startsAt: inMinutes(60),
      });
      expect(dbHolder.current.calls.set[0]).toEqual({
        nextTaxEnabled: true,
        nextTaxInclusive: true,
        nextTaxRateBps: 1800,
        nextTaxStartsAt: inMinutes(60),
        nextTaxNoticeId: null,
        updatedAt: NOW.toISOString(),
        updatedBy: "op@storemink.com",
      });
    });

    it.each([
      ["no notice at all", undefined],
      ["a notice id that is not one", "notice-1"],
    ])("★★ a rise with %s is refused", async (_l, noticeId) => {
      const res = await scheduleTaxChange(
        changeInput({
          when: "scheduled",
          inclusive: false,
          startsAt: inMinutes(60 * 24 * 40),
          noticeId,
        }),
        null,
      );
      expect(res).toEqual({
        ok: false,
        error: TAX_SETTINGS_REFUSAL.riseWithoutNotice,
      });
      expectNothingWritten();
    });

    it("a notice that does not exist is no notice", async () => {
      withRows(identityRow(), null);
      const res = await scheduleTaxChange(
        changeInput({
          when: "scheduled",
          inclusive: false,
          startsAt: inMinutes(60 * 24 * 40),
          noticeId: NOTICE_ID,
        }),
        null,
      );
      expect(res).toEqual({
        ok: false,
        error: TAX_SETTINGS_REFUSAL.riseWithoutNotice,
      });
    });

    it.each([
      ["product news", { category: "feature" }, "not_operational"],
      [
        "a failed send (it has a sent_at, nothing delivered)",
        { status: "failed", sent: 0 },
        "not_sent",
      ],
      ["a draft", { status: "draft", sentAt: null }, "not_sent"],
      [
        "a partial send with nothing delivered",
        { status: "partial", sent: 0 },
        "nothing_delivered",
      ],
      [
        "an SMS-only notice",
        { channels: { email: false, sms: true } },
        "not_email",
      ],
      [
        "a notice to Pro stores only",
        { audience: { plans: ["pro"] } },
        "audience",
      ],
      [
        "a notice to launched stores only",
        { audience: { launchedOnly: true } },
        "audience",
      ],
    ])(
      "★★ the notice rule refuses %s with its sentence",
      async (_l, over, reason) => {
        withRows(identityRow(), noticeRow(over));
        const res = await scheduleTaxChange(
          changeInput({
            when: "scheduled",
            inclusive: false,
            startsAt: inMinutes(60 * 24 * 40),
            noticeId: NOTICE_ID,
          }),
          null,
        );
        expect(res).toEqual({
          ok: false,
          error: noticeRefusal(reason as Parameters<typeof noticeRefusal>[0]),
        });
        expectNothingWritten();
      },
    );

    it("★★ the notice is read from platform_announcements, by its id", async () => {
      withRows(identityRow(), noticeRow());
      await scheduleTaxChange(
        changeInput({
          when: "scheduled",
          inclusive: false,
          startsAt: "2026-12-10T09:30:00.000Z",
          noticeId: NOTICE_ID,
        }),
        null,
      );
      expect(Object.keys(dbHolder.current.calls.select[1]).sort()).toEqual([
        "audience",
        "category",
        "channels",
        "sent",
        "sentAt",
        "status",
      ]);
    });

    it("★★ exactly 1 calendar month after the notice, in IST, is accepted, and the notice is kept", async () => {
      // Sent 10 Nov 15:00 IST: 10 Dec 15:00 IST onwards.
      withRows(identityRow(), noticeRow());
      const res = await scheduleTaxChange(
        changeInput({
          when: "scheduled",
          inclusive: false,
          startsAt: "2026-12-10T09:30:00.000Z",
          noticeId: NOTICE_ID,
        }),
        null,
      );
      expect(res).toEqual({
        ok: true,
        applied: "scheduled",
        startsAt: "2026-12-10T09:30:00.000Z",
      });
      expect(dbHolder.current.calls.set[0]).toMatchObject({
        nextTaxEnabled: true,
        nextTaxInclusive: false,
        nextTaxRateBps: 1800,
        nextTaxNoticeId: NOTICE_ID,
      });
    });

    it("★★ a millisecond sooner is refused with the earliest start and the sent date", async () => {
      withRows(identityRow(), noticeRow());
      const res = await scheduleTaxChange(
        changeInput({
          when: "scheduled",
          inclusive: false,
          startsAt: "2026-12-10T09:29:59.999Z",
          noticeId: NOTICE_ID,
        }),
        null,
      );
      expect(res).toEqual({
        ok: false,
        error: tooSoonAfterNotice(
          "2026-12-10T09:30:00.000Z",
          "2026-11-10T09:30:00.000Z",
        ),
      });
      expectNothingWritten();
    });

    it("★ a higher rate on prices excluding GST needs the notice too (until the Terms cover a rate set by law)", async () => {
      withRows(identityRow({ taxEnabled: true, taxRateBps: 1200 }));
      const res = await scheduleTaxChange(
        changeInput({
          when: "scheduled",
          inclusive: false,
          startsAt: inMinutes(60),
          rateSetByLaw: true,
        }),
        null,
      );
      expect(res).toEqual({
        ok: false,
        error: TAX_SETTINGS_REFUSAL.riseWithoutNotice,
      });
    });

    it("a change that lowers bills needs no notice", async () => {
      withRows(identityRow({ taxEnabled: true }));
      const res = await scheduleTaxChange(
        changeInput({
          when: "scheduled",
          enabled: false,
          startsAt: inMinutes(60),
        }),
        null,
      );
      expect(res).toMatchObject({ ok: true, applied: "scheduled" });
      expect(dbHolder.current.calls.select).toHaveLength(1);
    });
  });

  it("★★ updates the locked row, never INSERT ... ON CONFLICT (the proposed insert row carries no GSTIN and every identity check refuses it)", async () => {
    for (const input of [
      changeInput(),
      changeInput({ when: "scheduled", startsAt: inMinutes(60) }),
    ]) {
      withRows(identityRow());
      expect((await scheduleTaxChange(input, null)).ok).toBe(true);
      expect(dbHolder.current.calls.update).toEqual([platformBillingSettings]);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
      expect(dbHolder.current.calls.onConflict).toHaveLength(0);
    }
  });

  it("with no settings row yet, switching GST off inserts the row", async () => {
    withRows(null);
    const res = await scheduleTaxChange(
      changeInput({ enabled: false, inclusive: false }),
      "op@storemink.com",
    );
    expect(res).toMatchObject({ ok: true, applied: "now" });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      id: true,
      taxEnabled: false,
      nextTaxStartsAt: null,
    });
    expect(dbHolder.current.calls.onConflict).toHaveLength(0);
  });

  it("★ promotes a started change first, then reads the row under a lock", async () => {
    await scheduleTaxChange(changeInput(), null);
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    expect(dbHolder.current.calls.forUpdate).toEqual(["update"]);
    expect(
      dbHolder.current.db.execute.mock.invocationCallOrder[0],
    ).toBeLessThan(dbHolder.current.db.select.mock.invocationCallOrder[0]);
  });

  it("★ judges the rise against the values in force, after promotion", async () => {
    // The scheduled change on the row is replaced, never compared against.
    withRows(
      identityRow({
        taxEnabled: false,
        nextTaxEnabled: true,
        nextTaxInclusive: false,
        nextTaxRateBps: 1800,
        nextTaxStartsAt: inMinutes(60 * 24 * 40),
      }),
    );
    const res = await scheduleTaxChange(
      changeInput({ when: "scheduled", startsAt: inMinutes(60) }),
      null,
    );
    expect(res).toMatchObject({ ok: true, applied: "scheduled" });
    expect(dbHolder.current.calls.set[0].nextTaxInclusive).toBe(true);
  });

  it("★ busts the public tax source after it commits", async () => {
    await scheduleTaxChange(changeInput(), null);
    expect(revalidateTag).toHaveBeenCalledWith("platform-tax", "max");
  });

  it("★★ never writes the refund switches", async () => {
    await scheduleTaxChange(changeInput(), null);
    await scheduleTaxChange(
      changeInput({ when: "scheduled", startsAt: inMinutes(60) }),
      null,
    );
    for (const written of dbHolder.current.calls.set) {
      expect(written).not.toHaveProperty("autoRefunds");
      expect(written).not.toHaveProperty("automaticRefundsFrom");
    }
  });

  it.each([-1, 101, Number.NaN])("refuses a rate of %s", async (rate) => {
    const res = await scheduleTaxChange(
      changeInput({ ratePercent: rate as number }),
      null,
    );
    expect(res).toEqual({
      ok: false,
      error: "Enter a tax rate between 0 and 100.",
    });
  });

  it("refuses a `when` it does not know", async () => {
    const res = await scheduleTaxChange(
      changeInput({ when: "tomorrow" as any }),
      null,
    );
    expect(res).toEqual({ ok: false, error: "Choose when the change starts." });
    expect(withService).not.toHaveBeenCalled();
  });

  it("★ reports a write failure rather than claiming success", async () => {
    dbHolder.current.db.update = () => {
      throw new Error("db down");
    };
    expect(await scheduleTaxChange(changeInput(), null)).toEqual({
      ok: false,
      error: SAVE_FAILED,
    });
    expect(logError).toHaveBeenCalledWith(
      "billing.tax_change.save",
      expect.any(Error),
    );
  });
});

describe("★ once the Terms cover a rate set by law (LAW_SET_RATE_RISE_WITHOUT_NOTICE true)", () => {
  const NOW = new Date("2026-11-10T10:00:00.000Z");

  async function loadWithLawSetRate() {
    vi.resetModules();
    vi.doMock("./tax-terms", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./tax-terms")>()),
      LAW_SET_RATE_RISE_WITHOUT_NOTICE: true,
    }));
    return import("./platform-settings");
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    withRows(identityRow({ taxEnabled: true, taxRateBps: 1200 }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("./tax-terms");
    vi.resetModules();
  });

  it("now: a higher rate set by law is applied when ticked", async () => {
    const mod = await loadWithLawSetRate();
    const res = await mod.scheduleTaxChange(
      changeInput({ inclusive: false, rateSetByLaw: true }),
      null,
    );
    expect(res).toEqual({ ok: true, applied: "now", startsAt: null });
    expect(dbHolder.current.calls.set[0].taxRateBps).toBe(1800);
  });

  it("now: refused with its sentence when not ticked", async () => {
    const mod = await loadWithLawSetRate();
    const res = await mod.scheduleTaxChange(
      changeInput({ inclusive: false }),
      null,
    );
    expect(res).toEqual({
      ok: false,
      error: TAX_SETTINGS_REFUSAL.rateRiseNotConfirmed,
    });
  });

  it("scheduled: refused when neither ticked nor given a notice", async () => {
    const mod = await loadWithLawSetRate();
    const res = await mod.scheduleTaxChange(
      changeInput({
        when: "scheduled",
        inclusive: false,
        startsAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      }),
      null,
    );
    expect(res).toEqual({
      ok: false,
      error: TAX_SETTINGS_REFUSAL.rateRiseNotConfirmed,
    });
  });

  it("scheduled: ticked, it needs no notice", async () => {
    const mod = await loadWithLawSetRate();
    const res = await mod.scheduleTaxChange(
      changeInput({
        when: "scheduled",
        inclusive: false,
        startsAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        rateSetByLaw: true,
      }),
      null,
    );
    expect(res).toMatchObject({ ok: true, applied: "scheduled" });
    expect(dbHolder.current.calls.set[0].nextTaxNoticeId).toBeNull();
  });
});

describe("cancelScheduledTaxChange (GST design 5.8 item 3)", () => {
  const AT = new Date("2026-12-01T00:00:00.000Z");

  it("★★ promotes a started change first, then clears only a change still ahead", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[], [{ id: true }]] });
    const res = await cancelScheduledTaxChange("op@storemink.com", AT);
    expect(res).toEqual({ ok: true });
    const [promote, cancel] = dbHolder.current.calls.execute;
    expect(sqlText(promote)).toContain("next_tax_starts_at <=");
    const text = sqlText(cancel).replace(/\s+/g, " ");
    expect(text).toContain("where id and next_tax_starts_at >");
    expect(text).not.toContain("next_tax_starts_at > now()");
    for (const column of [
      "next_tax_enabled",
      "next_tax_inclusive",
      "next_tax_rate_bps",
      "next_tax_starts_at",
      "next_tax_notice_id",
    ]) {
      expect(text).toContain(`${column} = null`);
    }
    expect(text).toContain("returning id");
    expect(sqlParamValues(cancel)).toEqual([
      "op@storemink.com",
      AT.toISOString(),
    ]);
    expect(text).not.toContain("tax_enabled = false");
  });

  it("★★ promotes and clears on ONE clock, so a change starting now is neither cancelled nor left behind (review R1-13)", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[], [{ id: true }]] });
    await cancelScheduledTaxChange(null, AT);
    const [promote, cancel] = dbHolder.current.calls.execute;
    // The promote judges "started" at AT and the clear judges "still ahead"
    // at AT: the same instant, never the database's own now(), which in a
    // long transaction is its start.
    expect(sqlParamValues(promote)).toEqual([AT.toISOString(), PROMOTED_BY]);
    expect(sqlParamValues(cancel)).toContain(AT.toISOString());
  });

  it("★★ refuses once the change has started (or when nothing is scheduled)", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[], []] });
    expect(await cancelScheduledTaxChange(null)).toEqual({
      ok: false,
      error: TAX_SETTINGS_REFUSAL.cancelAfterStart,
    });
  });

  it("★ busts the public tax source after it commits", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[], [{ id: true }]] });
    await cancelScheduledTaxChange(null);
    expect(revalidateTag).toHaveBeenCalledWith("platform-tax", "max");
  });

  it("★ reports a database failure rather than claiming success", async () => {
    dbHolder.current.db.execute = vi.fn(async () => {
      throw new Error("db down");
    });
    expect(await cancelScheduledTaxChange(null)).toEqual({
      ok: false,
      error: SAVE_FAILED,
    });
    expect(logError).toHaveBeenCalledWith(
      "billing.tax_change.cancel",
      expect.any(Error),
    );
  });
});

describe("earliestStartAfterNotice: 1 calendar month, in IST", () => {
  it.each([
    // 10 Nov 15:00 IST: 10 Dec 15:00 IST.
    ["2026-11-10T09:30:00.000Z", "2026-12-10T09:30:00.000Z"],
    // ★ 31 Jan 02:00 IST is 30 Jan in UTC: the month is counted in IST, so
    // 28 Feb 02:00 IST, not 1 Mar 02:00 IST.
    ["2027-01-30T20:30:00.000Z", "2027-02-27T20:30:00.000Z"],
    // A leap year keeps 29 Feb.
    ["2028-01-31T06:30:00.000Z", "2028-02-29T06:30:00.000Z"],
    // December runs into January of the next year.
    ["2026-12-31T12:00:00.000Z", "2027-01-31T12:00:00.000Z"],
  ])("%s allows %s onwards", (sentAt, earliest) => {
    expect(earliestStartAfterNotice(sentAt)).toBe(earliest);
  });

  it("an unreadable date gives null", () => {
    expect(earliestStartAfterNotice("not a date")).toBeNull();
  });
});

describe("effectiveRise", () => {
  const off = { enabled: false, inclusive: false, rateBps: 1800 };
  const onIn = { enabled: true, inclusive: true, rateBps: 1800 };
  const onEx = { enabled: true, inclusive: false, rateBps: 1800 };

  it("switching on with prices including GST raises nothing", () => {
    expect(effectiveRise(off, onIn)).toBeNull();
  });

  it("switching on excluding GST, or including to excluding, is a choice", () => {
    expect(effectiveRise(off, onEx)).toBe("choice");
    expect(effectiveRise(onIn, onEx)).toBe("choice");
  });

  it("★ a higher rate alone is a choice until the Terms cover a rate set by law", () => {
    const lower = { ...onEx, rateBps: 1200 };
    expect(effectiveRise(lower, onEx)).toBe("choice");
    expect(effectiveRise(lower, onEx, true)).toBe("rate");
  });

  it("switching off, or a lower rate, raises nothing", () => {
    expect(effectiveRise(onEx, off)).toBeNull();
    expect(effectiveRise(onEx, { ...onEx, rateBps: 1200 })).toBeNull();
  });
});

describe("savePlatformAutoRefunds with an incomplete tax identity (plan A2)", () => {
  /** A Drizzle-wrapped CHECK violation: the reason is on `cause`. */
  function checkViolation() {
    return Object.assign(new Error("Failed query: insert into ..."), {
      cause: Object.assign(
        new Error(
          'new row for relation "platform_billing_settings" violates check constraint',
        ),
        {
          code: "23514",
          constraint: "platform_billing_tax_needs_invoice_identity",
        },
      ),
    });
  }

  it("★★ maps a CHECK violation (23514) to the sentence that says what to do", async () => {
    dbHolder.current.db.insert = () => {
      throw checkViolation();
    };
    expect(await savePlatformAutoRefunds(true, "op@storemink.com")).toEqual({
      ok: false,
      error: AUTO_REFUNDS_IDENTITY_INCOMPLETE,
    });
    expect(AUTO_REFUNDS_IDENTITY_INCOMPLETE).toBe(
      "Couldn't save this switch: StoreMink's tax identity is incomplete. Save StoreMink's tax identity first, then try again.",
    );
    expect(logWarn).toHaveBeenCalledWith(
      "billing.auto_refunds.identity_incomplete",
      { constraint: "platform_billing_tax_needs_invoice_identity" },
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it("also when the code sits on the error itself", async () => {
    dbHolder.current.db.insert = () => {
      throw Object.assign(new Error("check"), { code: "23514" });
    };
    expect((await savePlatformAutoRefunds(false, null)).ok).toBe(false);
    expect(await savePlatformAutoRefunds(false, null)).toEqual({
      ok: false,
      error: AUTO_REFUNDS_IDENTITY_INCOMPLETE,
    });
  });

  it("any other failure keeps the plain message", async () => {
    dbHolder.current.db.insert = () => {
      throw Object.assign(new Error("dup"), { code: "23505" });
    };
    expect(await savePlatformAutoRefunds(true, null)).toEqual({
      ok: false,
      error: "Couldn't save that setting. Please try again.",
    });
  });

  it("★ still writes only the switch and who changed it", async () => {
    await savePlatformAutoRefunds(true, null);
    expect(Object.keys(dbHolder.current.calls.values[0]).sort()).toEqual([
      "autoRefunds",
      "id",
      "updatedAt",
      "updatedBy",
    ]);
  });
});
