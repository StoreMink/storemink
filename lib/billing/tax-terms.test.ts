import { describe, expect, it } from "vitest";
import {
  LAW_SET_RATE_RISE_WITHOUT_NOTICE,
  noticeQualifies,
  payableFactorBps,
  raisesPayable,
  taxContextFor,
  termsAt,
  termsLater,
  type NoticeCandidate,
  type TaxTermsSource,
  type TaxValues,
} from "./tax-terms";

const OFF: TaxTermsSource = {
  taxEnabled: false,
  taxInclusive: false,
  taxRateBps: 1800,
  nextTaxEnabled: null,
  nextTaxInclusive: null,
  nextTaxRateBps: null,
  nextTaxStartsAt: null,
};

const ON_EXCLUSIVE: TaxTermsSource = {
  ...OFF,
  taxEnabled: true,
  taxInclusive: false,
  taxRateBps: 1800,
};

const STARTS_AT = "2026-12-01T00:00:00.000Z";
const STARTS_MS = Date.parse(STARTS_AT);

/** Off today, exclusive 18% from STARTS_AT. */
const SCHEDULED: TaxTermsSource = {
  ...OFF,
  nextTaxEnabled: true,
  nextTaxInclusive: false,
  nextTaxRateBps: 1800,
  nextTaxStartsAt: STARTS_AT,
};

describe("termsAt", () => {
  it("off: not active, rate 0, nothing upcoming", () => {
    expect(termsAt(OFF, new Date(STARTS_MS))).toEqual({
      active: false,
      inclusive: false,
      rateBps: 0,
      upcoming: null,
    });
  });

  it("keeps the price mode while GST is off (the mandate provision reads it)", () => {
    const terms = termsAt({ ...OFF, taxInclusive: true }, new Date(STARTS_MS));
    expect(terms.active).toBe(false);
    expect(terms.inclusive).toBe(true);
    expect(terms.rateBps).toBe(0);
  });

  it("on: active at the stored rate and mode", () => {
    expect(termsAt(ON_EXCLUSIVE, new Date(STARTS_MS))).toEqual({
      active: true,
      inclusive: false,
      rateBps: 1800,
      upcoming: null,
    });
    expect(
      termsAt({ ...ON_EXCLUSIVE, taxInclusive: true }, new Date(STARTS_MS)),
    ).toMatchObject({ active: true, inclusive: true, rateBps: 1800 });
  });

  it("scheduled, before its instant: the in-force terms with the change upcoming", () => {
    const terms = termsAt(SCHEDULED, new Date(STARTS_MS - 1));
    expect(terms.active).toBe(false);
    expect(terms.rateBps).toBe(0);
    expect(terms.upcoming).toEqual({
      enabled: true,
      inclusive: false,
      rateBps: 1800,
      startsAt: STARTS_AT,
    });
  });

  it("exactly at the instant: the scheduled terms apply", () => {
    expect(termsAt(SCHEDULED, new Date(STARTS_MS))).toEqual({
      active: true,
      inclusive: false,
      rateBps: 1800,
      upcoming: null,
    });
  });

  it("after the instant, before the hourly copy runs: still the scheduled terms", () => {
    expect(termsAt(SCHEDULED, new Date(STARTS_MS + 3_600_000))).toMatchObject({
      active: true,
      rateBps: 1800,
      upcoming: null,
    });
  });

  it("a scheduled switch-off gives rate 0 once it applies", () => {
    const off: TaxTermsSource = {
      ...ON_EXCLUSIVE,
      nextTaxEnabled: false,
      nextTaxInclusive: false,
      nextTaxRateBps: 1800,
      nextTaxStartsAt: STARTS_AT,
    };
    expect(termsAt(off, new Date(STARTS_MS - 1))).toMatchObject({
      active: true,
      rateBps: 1800,
    });
    expect(termsAt(off, new Date(STARTS_MS))).toMatchObject({
      active: false,
      rateBps: 0,
      upcoming: null,
    });
  });

  it("reads a half-scheduled change as no change, never as a switch-off", () => {
    const half: TaxTermsSource = {
      ...ON_EXCLUSIVE,
      nextTaxEnabled: false,
      nextTaxInclusive: null,
      nextTaxRateBps: null,
      nextTaxStartsAt: STARTS_AT,
    };
    expect(termsAt(half, new Date(STARTS_MS + 1))).toEqual({
      active: true,
      inclusive: false,
      rateBps: 1800,
      upcoming: null,
    });
  });

  it("reads an instant that does not parse as no change", () => {
    const bad: TaxTermsSource = { ...SCHEDULED, nextTaxStartsAt: "soon" };
    expect(termsAt(bad, new Date(STARTS_MS + 1))).toMatchObject({
      active: false,
      upcoming: null,
    });
  });

  it("a scheduled rate rise keeps today's rate until its instant", () => {
    const rise: TaxTermsSource = {
      ...ON_EXCLUSIVE,
      nextTaxEnabled: true,
      nextTaxInclusive: false,
      nextTaxRateBps: 2800,
      nextTaxStartsAt: STARTS_AT,
    };
    expect(termsAt(rise, new Date(STARTS_MS - 1)).rateBps).toBe(1800);
    expect(termsAt(rise, new Date(STARTS_MS)).rateBps).toBe(2800);
  });
});

describe("termsLater", () => {
  const before = termsAt(SCHEDULED, new Date(STARTS_MS - 86_400_000));

  it("applies the upcoming change at its instant", () => {
    expect(termsLater(before, new Date(STARTS_MS))).toEqual({
      active: true,
      inclusive: false,
      rateBps: 1800,
      upcoming: null,
    });
  });

  it("applies it after its instant", () => {
    expect(termsLater(before, new Date(STARTS_MS + 3_600_000)).active).toBe(
      true,
    );
  });

  it("keeps the terms as they are before the instant", () => {
    expect(termsLater(before, new Date(STARTS_MS - 1))).toBe(before);
  });

  it("returns terms with nothing upcoming unchanged", () => {
    const on = termsAt(ON_EXCLUSIVE, new Date(STARTS_MS));
    expect(termsLater(on, new Date(STARTS_MS + 86_400_000))).toBe(on);
  });
});

describe("payableFactorBps", () => {
  it("off 10000, inclusive 10000, exclusive 18% 11800", () => {
    expect(
      payableFactorBps({ enabled: false, inclusive: false, rateBps: 1800 }),
    ).toBe(10_000);
    expect(
      payableFactorBps({ enabled: true, inclusive: true, rateBps: 1800 }),
    ).toBe(10_000);
    expect(
      payableFactorBps({ enabled: true, inclusive: false, rateBps: 1800 }),
    ).toBe(11_800);
  });
});

describe("raisesPayable", () => {
  const off: TaxValues = { enabled: false, inclusive: false, rateBps: 1800 };
  const inclusive: TaxValues = {
    enabled: true,
    inclusive: true,
    rateBps: 1800,
  };
  const exclusive18: TaxValues = {
    enabled: true,
    inclusive: false,
    rateBps: 1800,
  };
  const exclusive28: TaxValues = { ...exclusive18, rateBps: 2800 };
  const exclusive12: TaxValues = { ...exclusive18, rateBps: 1200 };

  it("off to inclusive: null (merchants pay the same)", () => {
    expect(raisesPayable(off, inclusive)).toBeNull();
  });

  it("off to exclusive: choice", () => {
    expect(raisesPayable(off, exclusive18)).toBe("choice");
  });

  it("inclusive to exclusive: choice", () => {
    expect(raisesPayable(inclusive, exclusive18)).toBe("choice");
  });

  it("exclusive 18% to 28%: rate", () => {
    expect(raisesPayable(exclusive18, exclusive28)).toBe("rate");
  });

  it("exclusive to inclusive: null", () => {
    expect(raisesPayable(exclusive18, inclusive)).toBeNull();
  });

  it("on to off: null", () => {
    expect(raisesPayable(exclusive18, off)).toBeNull();
    expect(raisesPayable(inclusive, off)).toBeNull();
  });

  it("exclusive 18% to 12%: null", () => {
    expect(raisesPayable(exclusive18, exclusive12)).toBeNull();
  });

  it("no change: null", () => {
    expect(raisesPayable(exclusive18, exclusive18)).toBeNull();
    expect(raisesPayable(off, off)).toBeNull();
  });
});

describe("LAW_SET_RATE_RISE_WITHOUT_NOTICE", () => {
  it("is false until the published Terms say a law-set rate applies from its date", () => {
    expect(LAW_SET_RATE_RISE_WITHOUT_NOTICE).toBe(false);
  });
});

describe("taxContextFor", () => {
  it("builds the invoice builder's context from the terms", () => {
    const on = termsAt(ON_EXCLUSIVE, new Date(STARTS_MS));
    expect(taxContextFor(on, "03", "07")).toEqual({
      enabled: true,
      rateBps: 1800,
      inclusive: false,
      supplierStateCode: "03",
      placeOfSupply: "07",
    });
  });

  it("gives rate 0 while GST is off and keeps the price mode", () => {
    const off = termsAt({ ...OFF, taxInclusive: true }, new Date(STARTS_MS));
    expect(taxContextFor(off, null, null)).toEqual({
      enabled: false,
      rateBps: 0,
      inclusive: true,
      supplierStateCode: null,
      placeOfSupply: null,
    });
  });
});

describe("noticeQualifies", () => {
  /** An Operational email to every store owner that reached people. */
  const GOOD: NoticeCandidate = {
    category: "operational",
    status: "sent",
    sent: 120,
    sentAt: "2026-11-01T09:30:00.000Z",
    channels: { email: true, sms: false },
    audience: {
      include: ["owner"],
      plans: [],
      statuses: [],
      newerThanDays: 0,
      launchedOnly: false,
      includeDemo: false,
    },
  };

  const withAudience = (
    audience: Record<string, unknown>,
  ): NoticeCandidate => ({
    ...GOOD,
    audience: { ...(GOOD.audience as Record<string, unknown>), ...audience },
  });

  it("a sent email notice to all store owners qualifies", () => {
    expect(noticeQualifies(GOOD)).toEqual({ ok: true });
  });

  it("qualifies with demo stores excluded or included", () => {
    expect(noticeQualifies(withAudience({ includeDemo: false }))).toEqual({
      ok: true,
    });
    expect(noticeQualifies(withAudience({ includeDemo: true }))).toEqual({
      ok: true,
    });
  });

  it("qualifies when partly sent with deliveries", () => {
    expect(noticeQualifies({ ...GOOD, status: "partial", sent: 3 })).toEqual({
      ok: true,
    });
  });

  it("qualifies with statuses holding both active and suspended, and owners among staff", () => {
    expect(
      noticeQualifies(
        withAudience({
          include: ["owner", "admin"],
          statuses: ["active", "suspended"],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("reads a missing include as store owners, as the sender does", () => {
    expect(noticeQualifies(withAudience({ include: [] }))).toEqual({
      ok: true,
    });
  });

  it("category feature: not_operational", () => {
    expect(noticeQualifies({ ...GOOD, category: "feature" })).toEqual({
      ok: false,
      reason: "not_operational",
    });
  });

  it("status failed with sent_at set: not_sent", () => {
    expect(
      noticeQualifies({
        ...GOOD,
        status: "failed",
        sentAt: "2026-11-01T09:30:00.000Z",
      }),
    ).toEqual({ ok: false, reason: "not_sent" });
  });

  it("status sending: not_sent", () => {
    expect(noticeQualifies({ ...GOOD, status: "sending" })).toEqual({
      ok: false,
      reason: "not_sent",
    });
  });

  it("status draft: not_sent", () => {
    expect(noticeQualifies({ ...GOOD, status: "draft", sentAt: null })).toEqual(
      { ok: false, reason: "not_sent" },
    );
  });

  it("sent but no sent_at: not_sent", () => {
    expect(noticeQualifies({ ...GOOD, sentAt: null })).toEqual({
      ok: false,
      reason: "not_sent",
    });
  });

  it("sent 0: nothing_delivered", () => {
    expect(noticeQualifies({ ...GOOD, sent: 0 })).toEqual({
      ok: false,
      reason: "nothing_delivered",
    });
  });

  it("email off and SMS on: not_email", () => {
    expect(
      noticeQualifies({ ...GOOD, channels: { email: false, sms: true } }),
    ).toEqual({ ok: false, reason: "not_email" });
  });

  it("no channels recorded: not_email", () => {
    expect(noticeQualifies({ ...GOOD, channels: null })).toEqual({
      ok: false,
      reason: "not_email",
    });
  });

  it("include without owner: audience", () => {
    expect(noticeQualifies(withAudience({ include: ["admin"] }))).toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("one plan: audience", () => {
    expect(noticeQualifies(withAudience({ plans: ["pro"] }))).toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("statuses active only: audience", () => {
    expect(noticeQualifies(withAudience({ statuses: ["active"] }))).toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("newerThanDays 30: audience", () => {
    expect(noticeQualifies(withAudience({ newerThanDays: 30 }))).toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("launchedOnly: audience", () => {
    expect(noticeQualifies(withAudience({ launchedOnly: true }))).toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("names the first failure in the order checked", () => {
    expect(
      noticeQualifies({
        ...GOOD,
        category: "feature",
        status: "failed",
        channels: { email: false },
      }),
    ).toEqual({ ok: false, reason: "not_operational" });
    expect(
      noticeQualifies({
        ...GOOD,
        status: "failed",
        sent: 0,
        channels: { email: false },
      }),
    ).toEqual({ ok: false, reason: "not_sent" });
  });
});
