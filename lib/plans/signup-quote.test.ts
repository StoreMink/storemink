import { describe, expect, it } from "vitest";
import {
  chargeFor,
  formatInr,
  parseSignupPlanQuote,
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

describe("parseSignupPlanQuote", () => {
  it("accepts a complete quote", () => {
    expect(parseSignupPlanQuote({ plans: PLANS, paidCheckout: true })).toEqual({
      plans: PLANS,
      paidCheckout: true,
    });
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

  it("formats rupees the Indian way", () => {
    expect(formatInr(150000)).toBe("₹1,50,000");
  });
});
