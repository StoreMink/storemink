import { describe, expect, it } from "vitest";
import {
  chargeFor,
  firstRenewalPaise,
  formatInr,
  listPricePaise,
  parseSignupPlanQuote,
  signupAmount,
  yearlySavingLabel,
} from "./signup-quote";

const price = (monthlyInr: number, yearlyInr: number) => ({
  monthlyInr,
  yearlyInr,
  baseMonthlyInr: null,
  baseYearlyInr: null,
});
const PLANS = {
  free: price(0, 0),
  basic: price(1500, 15000),
  pro: price(5000, 50000),
};

const NO_GST = { active: false, inclusive: false, rateBps: 0, upcoming: null };
const GST_INCLUDED = {
  active: true,
  inclusive: true,
  rateBps: 1800,
  upcoming: null,
};
const GST_ADDED = {
  active: true,
  inclusive: false,
  rateBps: 1800,
  upcoming: null,
};
/** GST off now; GST at 18% added on top from 1 Dec 2026, 00:00 IST. */
const GST_SCHEDULED = {
  active: false,
  inclusive: false,
  rateBps: 0,
  upcoming: {
    enabled: true,
    inclusive: false,
    rateBps: 1800,
    startsAt: "2026-11-30T18:30:00.000Z",
  },
};

describe("parseSignupPlanQuote", () => {
  it("accepts a complete quote", () => {
    expect(
      parseSignupPlanQuote({
        plans: PLANS,
        paidCheckout: true,
        tax: GST_ADDED,
      }),
    ).toEqual({
      plans: PLANS,
      paidCheckout: true,
      tax: GST_ADDED,
    });
  });

  it("★ an answer with no tax (an older API) still parses, with no terms", () => {
    expect(parseSignupPlanQuote({ plans: PLANS, paidCheckout: true })).toEqual({
      plans: PLANS,
      paidCheckout: true,
      tax: null,
    });
    expect(
      parseSignupPlanQuote({ plans: PLANS, paidCheckout: true, tax: null })
        ?.tax,
    ).toBeNull();
  });

  it("keeps a scheduled change", () => {
    expect(
      parseSignupPlanQuote({
        plans: PLANS,
        paidCheckout: true,
        tax: GST_SCHEDULED,
      })?.tax,
    ).toEqual(GST_SCHEDULED);
  });

  it("★ GST terms that are not whole make the quote unavailable, never a guessed 'no GST'", () => {
    for (const tax of [
      "on",
      { active: "yes", inclusive: false, rateBps: 1800, upcoming: null },
      { active: true, inclusive: false, rateBps: -1, upcoming: null },
      { active: true, inclusive: false, rateBps: 18.5, upcoming: null },
      { active: true, inclusive: false, upcoming: null },
      {
        ...GST_SCHEDULED,
        upcoming: { ...GST_SCHEDULED.upcoming, startsAt: "soon" },
      },
      { ...GST_SCHEDULED, upcoming: { enabled: true, inclusive: false } },
      { ...GST_SCHEDULED, upcoming: "tomorrow" },
    ]) {
      expect(
        parseSignupPlanQuote({ plans: PLANS, paidCheckout: true, tax }),
      ).toBeNull();
    }
  });

  it("★ treats anything incomplete as unavailable, never as a guess", () => {
    for (const bad of [
      null,
      "nope",
      { plans: { ...PLANS, pro: undefined }, paidCheckout: true },
      { plans: { ...PLANS, basic: price(-1, 15000) }, paidCheckout: true },
      { plans: { ...PLANS, basic: { monthlyInr: "1500" } } },
      { error: "Current plan pricing is temporarily unavailable." },
    ]) {
      expect(parseSignupPlanQuote(bad)).toBeNull();
    }
  });

  it("only a literal true enables paid checkout", () => {
    expect(
      parseSignupPlanQuote({ plans: PLANS, paidCheckout: "yes" })?.paidCheckout,
    ).toBe(false);
  });
});

describe("plan step arithmetic", () => {
  it("charges the yearly TOTAL for yearly", () => {
    expect(chargeFor(PLANS.pro, "monthly")).toBe(5000);
    expect(chargeFor(PLANS.pro, "yearly")).toBe(50000);
  });

  it("derives the yearly label from the live prices", () => {
    expect(yearlySavingLabel(PLANS)).toBe("2 months free");
    expect(yearlySavingLabel({ ...PLANS, pro: price(5000, 48000) })).toBe(
      "Save with yearly",
    );
    expect(
      yearlySavingLabel({
        free: price(0, 0),
        basic: price(1500, 18000),
        pro: price(5000, 60000),
      }),
    ).toBeNull();
  });

  it("gives the list price in paise", () => {
    expect(listPricePaise(PLANS.basic, "monthly")).toBe(150000);
    expect(listPricePaise(PLANS.basic, "yearly")).toBe(1500000);
  });

  it("formats rupees the Indian way", () => {
    expect(formatInr(150000)).toBe("₹1,50,000");
  });
});

describe("signupAmount (design 7.2: the invoice builder's own totals)", () => {
  it("OFF, SCHEDULED and an older API: the list price, no GST", () => {
    for (const terms of [NO_GST, GST_SCHEDULED, null]) {
      expect(signupAmount(PLANS.basic, "monthly", terms)).toEqual({
        totalPaise: 150000,
        taxPaise: 0,
        rateBps: 0,
        inclusive: false,
      });
    }
  });

  it("ON-IN: the list price, with the GST inside it", () => {
    expect(signupAmount(PLANS.basic, "monthly", GST_INCLUDED)).toEqual({
      totalPaise: 150000,
      taxPaise: 22881,
      rateBps: 1800,
      inclusive: true,
    });
  });

  it("ON-EX: the list price plus GST", () => {
    expect(signupAmount(PLANS.basic, "monthly", GST_ADDED)).toEqual({
      totalPaise: 177000,
      taxPaise: 27000,
      rateBps: 1800,
      inclusive: false,
    });
    expect(signupAmount(PLANS.basic, "yearly", GST_ADDED).totalPaise).toBe(
      1770000,
    );
  });

  it("Free costs nothing in every state", () => {
    expect(signupAmount(PLANS.free, "monthly", GST_ADDED).totalPaise).toBe(0);
  });
});

describe("firstRenewalPaise (the autopay estimate)", () => {
  it("★ includes GST that starts before the first renewal is collected", () => {
    // Quoted on 10 Nov: the monthly renewal is collected from 6 Dec, after
    // the 1 Dec start.
    expect(
      firstRenewalPaise(
        PLANS.basic,
        "monthly",
        GST_SCHEDULED,
        new Date("2026-11-10T06:00:00.000Z"),
      ),
    ).toBe(177000);
  });

  it("leaves it out when the renewal is collected before the start", () => {
    // Quoted on 10 Oct: the monthly renewal is collected from 5 Nov.
    expect(
      firstRenewalPaise(
        PLANS.basic,
        "monthly",
        GST_SCHEDULED,
        new Date("2026-10-10T06:00:00.000Z"),
      ),
    ).toBe(150000);
  });

  it("is the list price with an older API answer", () => {
    expect(
      firstRenewalPaise(PLANS.pro, "yearly", null, new Date("2026-10-10")),
    ).toBe(5000000);
  });
});
