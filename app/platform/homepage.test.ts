import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKETING_PAGES, PRODUCT_PAGES } from "./marketing-routes";

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
