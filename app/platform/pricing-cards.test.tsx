// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  termsAt,
  type TaxTerms,
  type TaxTermsSource,
} from "@/lib/billing/tax-terms";
import type { IncludedMinkCredits } from "@/lib/plans";
import { PricingCards } from "./pricing-cards";
import { pricingCards, pricingFaqs } from "./pricing-content";

// ---------------------------------------------------------------------------
// The price cards and the FAQ on storemink.com, by GST state (GST design 7.1).
//
// The words are tax-copy.ts's (tested there for every state); what this file
// pins is that the cards and the FAQ pick the right ones for each plan and
// period, show the period the switch is on, keep "plus GST" off the free card,
// and, when the GST settings could not be read (terms null), say nothing about
// GST at all rather than anything that reads as "GST is off".
// ---------------------------------------------------------------------------

/** 00:00 IST on 1 December 2026 is 18:30 UTC on 30 November. */
const START = "2026-11-30T18:30:00.000Z";
const NOW = new Date("2026-10-29T06:30:00.000Z");

function source(over: Partial<TaxTermsSource> = {}): TaxTermsSource {
  return {
    taxEnabled: false,
    taxInclusive: false,
    taxRateBps: 0,
    nextTaxEnabled: null,
    nextTaxInclusive: null,
    nextTaxRateBps: null,
    nextTaxStartsAt: null,
    ...over,
  };
}

const scheduled = (inclusive: boolean) => ({
  nextTaxEnabled: true,
  nextTaxInclusive: inclusive,
  nextTaxRateBps: 1800,
  nextTaxStartsAt: START,
});

const TERMS = {
  off: termsAt(source(), NOW),
  schedIn: termsAt(source(scheduled(true)), NOW),
  schedEx: termsAt(source(scheduled(false)), NOW),
  onIn: termsAt(
    source({ taxEnabled: true, taxInclusive: true, taxRateBps: 1800 }),
    NOW,
  ),
  onEx: termsAt(
    source({ taxEnabled: true, taxInclusive: false, taxRateBps: 1800 }),
    NOW,
  ),
  onInThenEx: termsAt(
    source({
      taxEnabled: true,
      taxInclusive: true,
      taxRateBps: 1800,
      ...scheduled(false),
    }),
    NOW,
  ),
} satisfies Record<string, TaxTerms>;

const PRICES = {
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
    monthlyInr: 2400,
    yearlyInr: 24000,
    baseMonthlyInr: null,
    baseYearlyInr: null,
  },
};
const INCLUDED: IncludedMinkCredits = { free: 25, basic: 150, pro: null };

const cardsFor = (terms: TaxTerms | null) =>
  pricingCards(PRICES, INCLUDED, terms);
const card = (terms: TaxTerms | null, id: string) => {
  const found = cardsFor(terms).find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} card`);
  return found;
};

// ★ Cloud Run sets no TZ, so the server formats in UTC. A date that is only
// right on a laptop in India would fail here.
const machineTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (machineTz === undefined) delete process.env.TZ;
  else process.env.TZ = machineTz;
});
afterEach(cleanup);

describe("pricingCards: the notes and the suffix by GST state", () => {
  it("OFF: the amount and the period, nothing about GST", () => {
    expect(card(TERMS.off, "basic").notes).toEqual({
      monthly: "₹1,500 billed every month",
      yearly: "₹15,000 billed once a year",
    });
    expect(card(TERMS.off, "basic").priceSuffix).toBeNull();
  });

  it("a scheduled switch-on to prices that include GST reads as OFF", () => {
    expect(card(TERMS.schedIn, "basic").notes).toEqual(
      card(TERMS.off, "basic").notes,
    );
    expect(card(TERMS.schedIn, "pro").priceSuffix).toBeNull();
  });

  it("SCHED-EX: plus GST from the start, dated in India", () => {
    expect(card(TERMS.schedEx, "basic").notes).toEqual({
      monthly: "₹1,500 billed every month, plus GST from 1 Dec 2026",
      yearly: "₹15,000 billed once a year, plus GST from 1 Dec 2026",
    });
    expect(card(TERMS.schedEx, "basic").priceSuffix).toBeNull();
  });

  it("ON-IN: GST included in the same amount", () => {
    expect(card(TERMS.onIn, "basic").notes).toEqual({
      monthly: "₹1,500 billed every month, GST included",
      yearly: "₹15,000 billed once a year, GST included",
    });
    expect(card(TERMS.onIn, "basic").priceSuffix).toBeNull();
    // A move to prices that exclude GST, still ahead, does not change today's note.
    expect(card(TERMS.onInThenEx, "basic").notes).toEqual(
      card(TERMS.onIn, "basic").notes,
    );
  });

  it("ON-EX: the total with GST under the price, and plus GST after /mo", () => {
    expect(card(TERMS.onEx, "basic").notes).toEqual({
      monthly: "₹1,770 billed every month, including GST",
      yearly: "₹17,700 billed once a year, including GST",
    });
    expect(card(TERMS.onEx, "pro").notes).toEqual({
      monthly: "₹2,832 billed every month, including GST",
      yearly: "₹28,320 billed once a year, including GST",
    });
    expect(card(TERMS.onEx, "basic").priceSuffix).toBe("plus GST");
    expect(card(TERMS.onEx, "pro").priceSuffix).toBe("plus GST");
  });

  it("the free card needs no card and never says plus GST", () => {
    for (const terms of Object.values(TERMS)) {
      expect(card(terms, "free").notes).toEqual({
        monthly: "No card needed",
        yearly: "No card needed",
      });
      expect(card(terms, "free").priceSuffix).toBeNull();
    }
  });

  it("★ a failed GST read (null terms): no notes and no suffix, so no GST words", () => {
    for (const c of cardsFor(null)) {
      expect(c.notes).toBeNull();
      expect(c.priceSuffix).toBeNull();
    }
  });

  it("keeps the plan copy, the prices and the allowance line", () => {
    const basic = card(TERMS.onEx, "basic");
    expect(basic).toMatchObject({
      name: "Basic",
      monthlyInr: 1500,
      yearlyInr: 15000,
      baseMonthlyInr: null,
      popular: true,
    });
    expect(basic.features.at(-1)).toBe("150 Mink credits a month");
    expect(card(TERMS.onEx, "pro").features.at(-1)).toBe(
      "Unlimited Mink credits a month",
    );
  });
});

describe("PricingCards: what a visitor sees", () => {
  const noteOf = (name: string) =>
    screen
      .getByRole("heading", { name })
      .closest(".stq-price-card")
      ?.querySelector(".stq-card-note")?.textContent;
  const priceOf = (name: string) =>
    screen
      .getByRole("heading", { name })
      .closest(".stq-price-card")
      ?.querySelector(".stq-price")?.textContent;
  const toMonthly = () => fireEvent.click(screen.getByRole("switch"));

  it("ON-EX: yearly first, then monthly, each with its own note", () => {
    render(<PricingCards plans={cardsFor(TERMS.onEx)} />);
    expect(noteOf("Basic")).toBe("₹17,700 billed once a year, including GST");
    expect(priceOf("Basic")).toBe("₹1,250/mo plus GST");
    expect(priceOf("Free")).toBe("₹0/mo");
    toMonthly();
    expect(noteOf("Basic")).toBe("₹1,770 billed every month, including GST");
    expect(priceOf("Basic")).toBe("₹1,500/mo plus GST");
    expect(noteOf("Pro")).toBe("₹2,832 billed every month, including GST");
    expect(noteOf("Free")).toBe("No card needed");
  });

  it("SCHED-EX: the list price, with the start of GST under it", () => {
    render(<PricingCards plans={cardsFor(TERMS.schedEx)} />);
    expect(noteOf("Pro")).toBe(
      "₹24,000 billed once a year, plus GST from 1 Dec 2026",
    );
    expect(priceOf("Pro")).toBe("₹2,000/mo");
    toMonthly();
    expect(noteOf("Pro")).toBe(
      "₹2,400 billed every month, plus GST from 1 Dec 2026",
    );
  });

  it("★ a failed GST read: the amounts alone, with no GST words anywhere on a card", () => {
    const { container } = render(<PricingCards plans={cardsFor(null)} />);
    expect(noteOf("Basic")).toBe("₹15,000 billed once a year");
    expect(noteOf("Free")).toBe("No card needed");
    toMonthly();
    expect(noteOf("Basic")).toBe("₹1,500 billed every month");
    expect(priceOf("Basic")).toBe("₹1,500/mo");
    for (const el of container.querySelectorAll(".stq-card-note, .stq-price")) {
      expect(el.textContent).not.toMatch(/GST/);
    }
  });
});

describe("pricingFaqs: the GST question", () => {
  const FEE_Q = "Does StoreMink charge a transaction fee?";
  const GST_Q = "Do your prices include GST?";
  const questions = (terms: TaxTerms | null) =>
    pricingFaqs(terms).map((faq) => faq.q);
  const gstAnswer = (terms: TaxTerms | null) =>
    pricingFaqs(terms).find((faq) => faq.q === GST_Q)?.a;

  it("is not asked with GST off, or before a switch-on that changes no price", () => {
    expect(questions(TERMS.off)).not.toContain(GST_Q);
    expect(questions(TERMS.schedIn)).not.toContain(GST_Q);
    expect(questions(TERMS.off)).toContain(FEE_Q);
  });

  it("★ is not asked when the GST read failed: nothing is claimed either way", () => {
    expect(pricingFaqs(null)).toEqual(pricingFaqs(TERMS.off));
    expect(questions(null)).not.toContain(GST_Q);
  });

  it("follows the transaction-fee question while GST is charged or added from a date", () => {
    for (const terms of [TERMS.schedEx, TERMS.onIn, TERMS.onEx]) {
      const qs = questions(terms);
      const at = qs.indexOf(GST_Q);
      expect(at).toBeGreaterThan(0);
      expect(qs[at - 1]).toBe(FEE_Q);
      expect(qs.filter((q) => q !== GST_Q)).toEqual(questions(TERMS.off));
    }
  });

  it("answers by state, naming Plans & Billing", () => {
    expect(gstAnswer(TERMS.onIn)).toBe(
      "Yes. Every price on this page includes GST at 18%. Your invoice shows the GST in it, and if you add your GSTIN in Plans & Billing you can claim it as input tax credit.",
    );
    expect(gstAnswer(TERMS.onEx)).toBe(
      "No. GST at 18% is added to every plan, extra location and Mink credit pack when you pay, and you see the total with GST before you pay. Your invoice shows the GST charged, and if you add your GSTIN in Plans & Billing you can claim it as input tax credit.",
    );
    expect(gstAnswer(TERMS.schedEx)).toBe(
      "Today no GST is charged. From 1 December 2026, GST at 18% is added to every plan, extra location and Mink credit pack when you pay, and you see the total with GST before you pay. Your invoice shows the GST charged, and if you add your GSTIN in Plans & Billing you can claim it as input tax credit.",
    );
  });

  it("returns a fresh list, so a page can never change the shared one", () => {
    const first = pricingFaqs(TERMS.off);
    first.length = 0;
    expect(pricingFaqs(TERMS.off).length).toBeGreaterThan(0);
  });
});
