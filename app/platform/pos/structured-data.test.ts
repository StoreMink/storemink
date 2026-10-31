import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaxTermsSource } from "@/lib/billing/tax-terms";
import { termsAt } from "@/lib/billing/tax-terms";
import { valueAddedTaxIncluded } from "@/lib/billing/tax-copy";
import { buildPosStructuredData } from "./structured-data";

// The POS page's two reads: the prices are fixed, the GST source is whatever
// a test sets (null = a failed read).
const reads = vi.hoisted(() => ({
  tax: null as TaxTermsSource | null,
}));

vi.mock("@/lib/billing/public-tax", () => ({
  getPublicTaxSource: vi.fn(async () => reads.tax),
}));
vi.mock("@/lib/plans/pricing", () => ({
  getPlanPricing: vi.fn(async () => ({
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
  })),
  inr: (n: number) => `₹${n.toLocaleString("en-IN")}`,
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const BASE: TaxTermsSource = {
  taxEnabled: false,
  taxInclusive: true,
  taxRateBps: 1800,
  nextTaxEnabled: null,
  nextTaxInclusive: null,
  nextTaxRateBps: null,
  nextTaxStartsAt: null,
};
const SOURCES = {
  off: BASE,
  schedEx: {
    ...BASE,
    nextTaxEnabled: true,
    nextTaxInclusive: false,
    nextTaxRateBps: 1800,
    // Far ahead, so it is still scheduled whenever the test runs.
    nextTaxStartsAt: "2099-11-30T18:30:00.000Z",
  },
  onIn: { ...BASE, taxEnabled: true, taxInclusive: true },
  onEx: { ...BASE, taxEnabled: true, taxInclusive: false },
} satisfies Record<string, TaxTermsSource>;

type Spec = Record<string, unknown>;

function specOf(schema: Record<string, unknown>): Spec {
  const graph = schema["@graph"] as Record<string, unknown>[];
  const software = graph.find(
    (node) => node["@id"] === "https://pos.storemink.com/#software",
  ) as { offers: { priceSpecification: Spec } };
  return software.offers.priceSpecification;
}

function flagFor(src: TaxTermsSource): boolean | undefined {
  return valueAddedTaxIncluded(termsAt(src, new Date()));
}

describe("buildPosStructuredData: the GST flag (R2-05)", () => {
  it("GST added on top: valueAddedTaxIncluded false", () => {
    const spec = specOf(
      buildPosStructuredData({
        proMonthlyEquivalentInr: 2000,
        vatIncluded: flagFor(SOURCES.onEx),
      }),
    );
    expect(spec.valueAddedTaxIncluded).toBe(false);
  });

  it("GST included: valueAddedTaxIncluded true", () => {
    const spec = specOf(
      buildPosStructuredData({
        proMonthlyEquivalentInr: 2000,
        vatIncluded: flagFor(SOURCES.onIn),
      }),
    );
    expect(spec.valueAddedTaxIncluded).toBe(true);
  });

  it("GST off or only scheduled: no claim at all", () => {
    for (const src of [SOURCES.off, SOURCES.schedEx]) {
      const spec = specOf(
        buildPosStructuredData({
          proMonthlyEquivalentInr: 2000,
          vatIncluded: flagFor(src),
        }),
      );
      expect("valueAddedTaxIncluded" in spec).toBe(false);
    }
  });

  it("a caller that passes nothing makes no claim", () => {
    const spec = specOf(
      buildPosStructuredData({ proMonthlyEquivalentInr: 2000 }),
    );
    expect("valueAddedTaxIncluded" in spec).toBe(false);
    expect(spec.price).toBe(2000);
  });
});

describe("the POS page passes the flag its price box states", () => {
  async function renderedSpec(): Promise<Spec> {
    const { default: Page } = await import("./page");
    const html = renderToStaticMarkup(await Page());
    const match =
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    if (!match) throw new Error("no JSON-LD on the page");
    return specOf(JSON.parse(match[1]) as Record<string, unknown>);
  }

  it("follows the terms: false on top, true included, absent otherwise", async () => {
    reads.tax = SOURCES.onEx;
    expect((await renderedSpec()).valueAddedTaxIncluded).toBe(false);
    reads.tax = SOURCES.onIn;
    expect((await renderedSpec()).valueAddedTaxIncluded).toBe(true);
    reads.tax = SOURCES.off;
    expect("valueAddedTaxIncluded" in (await renderedSpec())).toBe(false);
    reads.tax = SOURCES.schedEx;
    expect("valueAddedTaxIncluded" in (await renderedSpec())).toBe(false);
    // A failed read: no GST words in the price box, so no claim here either.
    reads.tax = null;
    expect("valueAddedTaxIncluded" in (await renderedSpec())).toBe(false);
  });
});
