import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { TaxTermsSource } from "@/lib/billing/tax-terms";
import { MARKETING_PAGES, PRODUCT_PAGES } from "./marketing-routes";

// The GST reads every public page makes (GST design 7.1). The prices and the
// allowance are fixed; the tax source is whatever a test sets, or a failure.
const reads = vi.hoisted(() => ({
  tax: null as TaxTermsSource | null,
  taxError: null as Error | null,
}));

vi.mock("@/lib/billing/public-tax", () => ({
  getPublicTaxSource: vi.fn(async () => {
    if (reads.taxError) throw reads.taxError;
    return reads.tax;
  }),
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
vi.mock("@/lib/plans/allowances", () => ({
  getPlanAllowances: vi.fn(async () => ({
    free: null,
    basic: null,
    pro: null,
  })),
}));
vi.mock("@/lib/themes/runtime-registry", () => ({
  getThemeCatalog: vi.fn(async () => []),
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ chargeCredits: true }),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const page = read("app/platform/page.tsx");
const css = read("app/platform/homepage.css");
const marketingCss = read("app/platform/(marketing)/marketing.css");
const header = read("app/platform/site-header.tsx");
const footer = read("app/platform/site-footer.tsx");
const mobileNav = read("app/platform/homepage-mobile-nav.tsx");
const legalLayout = read("app/platform/legal/layout.tsx");
const marketingLayout = read("app/platform/(marketing)/layout.tsx");
const pricingContent = read("app/platform/pricing-content.tsx");
const sitemap = read("app/sitemap.ts");

describe("StoreMink public homepage", () => {
  it("presents the business operating-system story and its conversion paths", () => {
    expect(page).toContain('id="platform"');
    expect(page).toContain('id="pricing"');
    expect(page).toContain('id="faq"');
    expect(page).toContain("Build <em>What&apos;s Yours.</em>");
    expect(page).toContain(
      "AI-Powered</span> Commerce, Made Simple with Mink AI.",
    );
    expect(page).toContain("One business operating system");
    expect(page).toContain("operations and intelligence together");
    expect(page).toContain("StoreMink Point of Sale");
    expect(page).toContain('href="/signup"');
    expect(page).toContain('type="application/ld+json"');
    // The plan copy and FAQ are shared with /pricing, so they live in one
    // module rather than being typed twice.
    expect(pricingContent).toContain('q: "What can Mink AI do?"');
    expect(page).toContain('from "./pricing-content"');
  });

  // ★ ONE HEADER, and the policy and marketing pages must keep using it.
  // /legal and /legal/{slug} rendered with NO header at all — no mark, no
  // navigation, no way back — which is how they shipped while the markup lived
  // inline in page.tsx. A second hand-written copy for those routes is the
  // drift this guards against.
  it("shares one header and one footer between the apex, the marketing pages and the policy pages", () => {
    expect(page).toContain("<SiteHeader");
    expect(page).toContain("<SiteFooter");
    // No second copy of either chrome left behind in the homepage.
    expect(page).not.toContain('className="smh-header"');
    expect(page).not.toContain('className="smh-footer"');
    for (const layout of [legalLayout, marketingLayout]) {
      expect(layout).toContain("<SiteHeader />");
      expect(layout).toContain("<SiteFooter />");
      expect(layout).toContain('className="smh"');
    }
    expect(header).toContain('className="smh-header"');
    expect(header).toContain("<HomepageMobileNav");
    expect(footer).toContain('className="smh-footer"');
    expect(footer).toContain("LEGAL_DOCS.map");
    for (const chrome of [header, footer]) {
      expect(chrome).toContain("<BrandMark");
      expect(chrome).toContain("Store<em>Mink</em>");
      expect(chrome).toContain('href="/pricing"');
      expect(chrome).toContain('href="/why-storemink"');
    }
  });

  // ★ The multidevice product picture shows "Register" on its screens and the
  // product says POS (owner, 26 Oct 2026), so the homepage card and the header
  // tile show the drawn POS until a new picture exists.
  it("shows the drawn POS, not the picture that says Register", () => {
    for (const source of [page, header]) {
      expect(source).not.toContain("storemink-pos-multidevice.png");
      expect(source).toContain("<RegisterArt compact />");
    }
  });

  it("keeps the redesign isolated, responsive and motion-safe", () => {
    expect(css).toContain(".smh {");
    expect(css).toMatch(/@media \(max-width: 940px\)/);
    expect(css).toMatch(/@media \(max-width: 680px\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)/);
    expect(css).not.toMatch(/^\.(?:stq|posx)-/m);
    expect(marketingCss).toMatch(/@media \(max-width: 940px\)/);
    expect(marketingCss).toMatch(/@media \(max-width: 680px\)/);
    expect(marketingCss).not.toMatch(/^\.(?:stq|posx|smh)-/m);
  });
});

// ★ THE MARKETING PAGES ARE A REGISTRY. A page that exists but is not in it
// is unreachable from the header, the footer and the sitemap; a registry
// entry with no page is a 404 in the navigation. Both directions fail here.
describe("StoreMink marketing pages", () => {
  const routeFiles = (dir: string): string[] =>
    readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap(
      (entry) => {
        if (entry.isDirectory()) return routeFiles(`${dir}/${entry.name}`);
        return entry.name === "page.tsx" ? [dir] : [];
      },
    );
  const pagePaths = routeFiles("app/platform/(marketing)").map((dir) =>
    dir.replace("app/platform/(marketing)", ""),
  );

  it("has a page for every registered route and a route for every page", () => {
    const registered = MARKETING_PAGES.map((p) => p.path).sort();
    expect(pagePaths.sort()).toEqual(registered);
  });

  it("links every product page from the header, footer and mobile menu", () => {
    expect(header).toContain("PRODUCT_PAGES");
    expect(footer).toContain("PRODUCT_PAGES");
    expect(mobileNav).toContain("MARKETING_PAGES");
    expect(PRODUCT_PAGES.every((p) => p.path.startsWith("/products/"))).toBe(
      true,
    );
  });

  it("lists the marketing pages in the apex sitemap", () => {
    expect(sitemap).toContain("MARKETING_PAGES.map");
  });

  it("gives every page canonical metadata and the shared closing CTA", () => {
    for (const path of pagePaths) {
      const source = read(`app/platform/(marketing)${path}/page.tsx`);
      expect(source).toContain(`path: "${path}"`);
      expect(source).toContain("marketingMetadata(");
      expect(source).toContain("<CtaBand");
    }
  });
});

// ★ GST ON THE PUBLIC PAGES (GST design 7.1, 8). Every page reads the cached
// public source and works the terms out for the render it is in, so these
// render the real pages with the read mocked. The words are tax-copy.ts's;
// what is pinned here is that each page puts them in the right place, and
// that a failed read leaves every GST word out instead of claiming anything.
describe("GST on the public pages", () => {
  /** 00:00 IST on 1 December 2026 is 18:30 UTC on 30 November. */
  const START = "2026-11-30T18:30:00.000Z";
  const BEFORE = new Date("2026-10-29T06:30:00.000Z");
  const AFTER = new Date("2026-12-01T06:30:00.000Z");

  const source = (over: Partial<TaxTermsSource> = {}): TaxTermsSource => ({
    taxEnabled: false,
    taxInclusive: false,
    taxRateBps: 0,
    nextTaxEnabled: null,
    nextTaxInclusive: null,
    nextTaxRateBps: null,
    nextTaxStartsAt: null,
    ...over,
  });
  const SOURCES = {
    off: source(),
    schedEx: source({
      nextTaxEnabled: true,
      nextTaxInclusive: false,
      nextTaxRateBps: 1800,
      nextTaxStartsAt: START,
    }),
    onIn: source({ taxEnabled: true, taxInclusive: true, taxRateBps: 1800 }),
    onEx: source({ taxEnabled: true, taxInclusive: false, taxRateBps: 1800 }),
  };

  // Rendered text with the tags gone and React's entities read back.
  const textOf = (html: string) =>
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ");
  const jsonLdOf = (html: string) => {
    const match =
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    if (!match) throw new Error("no JSON-LD on the page");
    return JSON.parse(match[1]) as {
      "@graph": Array<{
        offers?: {
          offers?: Array<{ priceSpecification: Record<string, unknown> }>;
        };
      }>;
    };
  };
  const priceSpecs = (html: string) =>
    jsonLdOf(html)["@graph"].flatMap((node) =>
      (node.offers?.offers ?? []).map((offer) => offer.priceSpecification),
    );
  const cardNotes = (html: string) =>
    [...html.matchAll(/<p class="stq-card-note">([\s\S]*?)<\/p>/g)].map((m) =>
      textOf(m[1]).trim(),
    );
  const footnotes = (html: string) =>
    [...html.matchAll(/<p class="smh-pricing-foot">([\s\S]*?)<\/p>/g)].map(
      (m) => textOf(m[1]).trim(),
    );

  async function renderHome() {
    const { default: Page } = await import("./page");
    return renderToStaticMarkup(await Page());
  }
  async function renderPricing() {
    const { default: Page } = await import("./(marketing)/pricing/page");
    return renderToStaticMarkup(await Page());
  }
  async function renderPos() {
    const { default: Page } = await import("./pos/page");
    return renderToStaticMarkup(await Page());
  }
  async function metadataDescription() {
    const { generateMetadata } = await import("./layout");
    return String((await generateMetadata()).description);
  }

  // ★ Cloud Run sets no TZ, so the server formats in UTC: the dates below are
  // India's only because the copy pins the zone, which is what this proves.
  const machineTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    if (machineTz === undefined) delete process.env.TZ;
    else process.env.TZ = machineTz;
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE);
    reads.tax = null;
    reads.taxError = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const GST_QUESTION = "Do your prices include GST?";

  it("GST off: the prices as before, with nothing said about GST", async () => {
    reads.tax = SOURCES.off;
    const html = await renderHome();
    const text = textOf(html);
    expect(text).toContain("Paid plans start at ₹1,500 per month.");
    expect(cardNotes(html)).toContain("₹15,000 billed once a year");
    expect(html).toContain("<sub>/mo</sub>");
    expect(html).not.toContain("plus GST");
    expect(footnotes(html)).toHaveLength(1);
    expect(text).not.toContain(GST_QUESTION);
    for (const spec of priceSpecs(html)) {
      expect(spec).not.toHaveProperty("valueAddedTaxIncluded");
    }
  });

  it("GST added on top: totals under the price, plus GST after /mo, the footnote, the FAQ and VAT false", async () => {
    reads.tax = SOURCES.onEx;
    const html = await renderHome();
    const text = textOf(html);
    expect(text).toContain("Paid plans start at ₹1,500 per month plus GST.");
    expect(cardNotes(html)).toEqual(
      expect.arrayContaining([
        "No card needed",
        "₹17,700 billed once a year, including GST",
        "₹28,320 billed once a year, including GST",
      ]),
    );
    expect(html).toContain("<sub>/mo plus GST</sub>");
    expect(footnotes(html)).toContain(
      "Prices exclude GST. GST at 18% is added when you pay, and you see the total before you pay.",
    );
    expect(text).toContain(GST_QUESTION);
    expect(text).toContain("if you add your GSTIN in Plans & Billing");
    const specs = priceSpecs(html);
    expect(specs).toHaveLength(3);
    for (const spec of specs) expect(spec.valueAddedTaxIncluded).toBe(false);
  });

  it("GST included: the same amounts, GST included, VAT true", async () => {
    reads.tax = SOURCES.onIn;
    const html = await renderHome();
    expect(textOf(html)).toContain(
      "Paid plans start at ₹1,500 per month including GST.",
    );
    expect(cardNotes(html)).toContain(
      "₹15,000 billed once a year, GST included",
    );
    expect(html).not.toContain("plus GST");
    expect(footnotes(html)).toContain("Prices include GST at 18%.");
    for (const spec of priceSpecs(html)) {
      expect(spec.valueAddedTaxIncluded).toBe(true);
    }
  });

  it("GST scheduled on top: dated in India, no VAT claim yet", async () => {
    reads.tax = SOURCES.schedEx;
    const html = await renderHome();
    const text = textOf(html);
    expect(text).toContain("Paid plans start at ₹1,500 per month.");
    expect(cardNotes(html)).toContain(
      "₹15,000 billed once a year, plus GST from 1 Dec 2026",
    );
    expect(footnotes(html)).toContain(
      "Prices exclude GST. From 1 December 2026, GST at 18% is added when you pay.",
    );
    expect(text).toContain(
      "Today no GST is charged. From 1 December 2026, GST at 18% is added",
    );
    for (const spec of priceSpecs(html)) {
      expect(spec).not.toHaveProperty("valueAddedTaxIncluded");
    }
  });

  it("★ the terms are worked out at render: once the start has passed, the scheduled GST is in force", async () => {
    vi.setSystemTime(AFTER);
    reads.tax = SOURCES.schedEx;
    const html = await renderHome();
    expect(textOf(html)).toContain(
      "Paid plans start at ₹1,500 per month plus GST.",
    );
    expect(cardNotes(html)).toContain(
      "₹17,700 billed once a year, including GST",
    );
    for (const spec of priceSpecs(html)) {
      expect(spec.valueAddedTaxIncluded).toBe(false);
    }
  });

  it("★ a failed GST read: the prices still show, with no GST words and no VAT claim, and the failure is logged", async () => {
    reads.taxError = new Error("connection reset");
    const html = await renderHome();
    const text = textOf(html);
    expect(text).toContain("Paid plans start at ₹1,500 per month.");
    expect(cardNotes(html)).toContain("₹15,000 billed once a year");
    for (const note of cardNotes(html)) expect(note).not.toMatch(/GST/);
    expect(html).not.toContain("plus GST");
    expect(footnotes(html)).toHaveLength(1);
    expect(text).not.toContain(GST_QUESTION);
    for (const spec of priceSpecs(html)) {
      expect(spec).not.toHaveProperty("valueAddedTaxIncluded");
    }
    const { logError } = await import("@/lib/observability/logger");
    expect(logError).toHaveBeenCalledWith(
      "billing.public_tax.read_failed",
      reads.taxError,
      { page: "/" },
    );
  });

  it("/pricing: the hero lead, the cards, the footnote and the FAQ follow the same terms", async () => {
    reads.tax = SOURCES.onIn;
    let html = await renderPricing();
    let text = textOf(html);
    expect(text).toContain(
      "Paid plans start at ₹1,500 per month including GST, with two months free when billed yearly.",
    );
    expect(cardNotes(html)).toContain(
      "₹24,000 billed once a year, GST included",
    );
    expect(footnotes(html)).toContain("Prices include GST at 18%.");
    expect(text).toContain(GST_QUESTION);

    reads.tax = null;
    reads.taxError = new Error("timeout");
    html = await renderPricing();
    text = textOf(html);
    expect(text).toContain(
      "Paid plans start at ₹1,500 per month, with two months free when billed yearly.",
    );
    expect(footnotes(html)).toHaveLength(1);
    expect(text).not.toContain(GST_QUESTION);
    for (const note of cardNotes(html)) expect(note).not.toMatch(/GST/);
  });

  it("the POS page's price box says billed yearly with the GST words of the state", async () => {
    const box = (html: string) =>
      /<div class="posx-price-box">[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(html)?.[1];
    reads.tax = SOURCES.off;
    expect(box(await renderPos())).toBe("billed yearly");
    reads.tax = SOURCES.schedEx;
    expect(box(await renderPos())).toBe("billed yearly");
    reads.tax = SOURCES.onIn;
    expect(box(await renderPos())).toBe("billed yearly, GST included");
    reads.tax = SOURCES.onEx;
    expect(box(await renderPos())).toBe("billed yearly, plus GST");
    reads.tax = null;
    reads.taxError = new Error("timeout");
    expect(box(await renderPos())).toBe("billed yearly");
  });

  it("the metadata description carries the GST words only while GST is charged", async () => {
    reads.tax = SOURCES.off;
    expect(await metadataDescription()).toContain(
      "Paid plans start at ₹1,500/month with 0% StoreMink transaction fees.",
    );
    reads.tax = SOURCES.onIn;
    expect(await metadataDescription()).toContain(
      "Paid plans start at ₹1,500/month including GST with 0% StoreMink transaction fees.",
    );
    reads.tax = SOURCES.onEx;
    expect(await metadataDescription()).toContain(
      "Paid plans start at ₹1,500/month plus GST with 0% StoreMink transaction fees.",
    );
    reads.tax = null;
    reads.taxError = new Error("timeout");
    expect(await metadataDescription()).toContain(
      "Paid plans start at ₹1,500/month with 0% StoreMink transaction fees.",
    );
  });

  it("every public page reads the cached source, never the live one, and keeps the 300 s window", () => {
    for (const path of [
      "app/platform/page.tsx",
      "app/platform/(marketing)/pricing/page.tsx",
      "app/platform/pos/page.tsx",
      "app/platform/layout.tsx",
    ]) {
      const source = read(path);
      expect(source).toContain("getPublicTaxSource()");
      expect(source).toContain("termsAt(taxSource, new Date())");
      expect(source).not.toContain("getTaxTermsLive");
      // A page's own revalidate longer than 300 s would hold a scheduled
      // start back; none of these sets one, so the cached reads' 300 s rule.
      expect(source).not.toMatch(/export const revalidate/);
    }
  });
});
