/**
 * The exemplars' own style rules in a real browser, offline (plan Phase 3).
 *
 *   npm run theme-studio:stylesheets
 *
 * For each of the seven exemplar themes (lib/themes/exemplars/), a page is
 * built from the storefront's PRODUCTION stylesheets, the theme's own palette
 * and its compiled stylesheet (lib/themes/stylesheet.ts), over markup that
 * carries the storefront's public classes. In local Chrome, at a phone and a
 * desktop width, it then checks:
 *
 *   1. EVERY RULE IS IN EFFECT. For each compiled rule that is not a hover,
 *      focus or active rule, every element it selects must render the value
 *      the rule declares: the storefront's own CSS must not be winning over
 *      it. (Measured by writing the same declaration inline, which always
 *      wins, and seeing that nothing changes.)
 *   2. TEXT STILL READS. axe's colour-contrast rule over the whole page, the
 *      dark section band included.
 *   3. NOTHING SPILLS. The page does not scroll sideways.
 *
 *   --shots=<dir>  also save a screenshot of each page (for a human to look
 *                  at; nothing is compared).
 *
 * No network, database, credentials or provider calls. ⚠ The markup here is
 * a fixture, not the storefront's components: that every hook names a class
 * or data attribute the real components emit is held by
 * lib/themes/stylesheet-hooks.test.ts. `--tsconfig tsconfig.scripts.json` is
 * required. Exit 1 on any failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EXEMPLAR_THEMES } from "@/lib/themes/exemplars";
import {
  STYLESHEET_ROOT_CLASS,
  themeStylesheetCss,
} from "@/lib/themes/stylesheet";
import { designToCssVars } from "@/lib/themes/types";

const root = process.cwd();
const requireJob = createRequire(
  join(root, "jobs/theme-studio-capture/package.json"),
);
const { chromium } = requireJob("playwright-core");
const axe = readFileSync(requireJob.resolve("axe-core/axe.min.js"), "utf8");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const productionCss = [
  "app/(storefront)/storefront-theme.css",
  "app/(storefront)/components/homepage/homepage.css",
  "app/(storefront)/(pages)/shop/shop.css",
].map(read);

const macChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync(macChrome) ? macChrome : chromium.executablePath());

function picture(width: number, height: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#b9b1a8"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
const fill = (className: string) =>
  `<img class="${className}" alt="Stoneware bowl" src="${picture(1200, 1500)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">`;

const card = (name: string) =>
  `<a class="shop-card" href="/shop"><div class="shop-card-img"><span role="button" tabindex="0" class="shop-card-wish" aria-pressed="false" aria-label="Save ${name} for later"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg></span><span role="button" tabindex="0" class="shop-card-view" aria-haspopup="dialog" aria-label="Quick view: ${name}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></span>${fill("shop-card-img-el")}<span class="shop-card-flag shop-card-flag--offer">Offer</span></div><div class="shop-card-body"><div class="shop-card-head"><span class="shop-card-cat">Tableware</span><h3 class="shop-card-name">${name}</h3></div><div class="shop-card-price"><span class="shop-card-current"><span class="shop-card-sell">Rs. 1,450</span></span></div></div></a>`;
const head = `<div class="home-section-head"><p class="home-section-eyebrow">New this season</p><h2 class="home-section-title">Thoughtfully made for every day</h2><p class="home-section-sub">Durable pieces with considered details and natural materials.</p></div>`;
const cards = `<div class="shop-listing"><div class="shop-grid">${["Speckled bowl", "Ash serving board", "Linen runner", "Stoneware mug"].map(card).join("")}</div></div>`;

/** Markup with the storefront's public classes for every hook area. */
function fixture(heroVariant: string): string {
  return [
    `<section class="home-section"><div class="home-hero variant-${heroVariant} theme-dark align-left"><div class="home-hero-copy"><span class="home-hero-badge">Since 2012</span><h1 class="home-hero-heading">A quieter table</h1><p class="home-hero-sub">Handmade in small batches.</p><a class="home-hero-cta sm-btn-primary" href="/shop">Shop the range</a></div><div class="home-hero-media"><div style="position:relative;aspect-ratio:4/3">${fill("home-hero-img")}</div></div></div></section>`,
    `<section class="home-section">${head}${cards}</section>`,
    `<section class="home-section">${head}<div class="home-cat-grid">${["Bowls", "Boards", "Linen"].map((name) => `<a class="home-cat-tile" href="/shop"><span class="home-cat-img" style="position:relative;display:block;aspect-ratio:1">${fill("home-cat-img-el")}</span><span class="home-cat-name">${name}</span></a>`).join("")}</div></section>`,
    // A dark band: the tokens are re-pointed inside it.
    `<section class="home-section sm-scheme sm-scheme-inverse">${head}${cards}<p><a class="home-hero-cta sm-btn-primary" href="/shop">See everything</a></p><div class="shop-more"><button type="button" class="shop-more-btn sm-btn-secondary">Load more</button></div></section>`,
    `<section class="home-section sm-scheme sm-scheme-soft">${head}<div class="home-testimonials layout-grid cols-2">${["Ananya", "Rohan"].map((name) => `<figure class="home-testimonial"><blockquote class="home-testimonial-quote">Everything arrived carefully packed and is in daily use.</blockquote><figcaption class="home-testimonial-attribution">${name}</figcaption></figure>`).join("")}</div></section>`,
    `<section class="home-section sm-scheme sm-scheme-tint">${head}<div class="home-multicolumn cols-3">${["Made slowly", "Sent quickly", "Kept for years"].map((title) => `<div class="home-multicolumn-item"><h3 class="home-multicolumn-heading">${title}</h3><p class="home-multicolumn-body">A sentence about how it is made.</p></div>`).join("")}</div><div class="home-accordion"><details class="home-accordion-item" open><summary class="home-accordion-q">How long does delivery take?</summary><div class="home-accordion-panel">Three to five days.</div></details></div></section>`,
    `<section class="home-section"><div class="home-media-text media-left align-left"><div class="home-media-text-media ratio-square">${fill("home-media-text-image")}</div><div class="home-media-text-copy"><h2 class="home-media-text-heading">From the studio</h2><p class="home-media-text-body">Each piece is thrown, trimmed and glazed by hand.</p></div></div></section>`,
    `<section class="home-section"><div class="shop-listing"><h1 class="shop-title">Tableware</h1><p class="shop-collection-desc">Bowls, plates and boards for every day.</p><div class="shop-toolbar"><span class="shop-toolbar-count">24 products</span></div></div><div class="sm-gallery-frame" style="position:relative;aspect-ratio:4/5;max-width:420px">${fill("pdp-main-img-el")}</div><div class="pdp-info"><p class="pdp-category">Tableware</p><h1 class="pdp-name">Speckled stoneware bowl</h1><p class="pdp-price"><span class="pdp-price-sell">Rs. 1,450</span></p><div class="pdp-actions"><button type="button" class="pdp-btn pdp-btn-cart sm-btn-secondary">Add to cart</button><button type="button" class="pdp-btn pdp-btn-buy sm-btn-primary">Buy now</button><button type="button" class="pdp-btn pdp-btn-buy sm-btn-primary" disabled>Sold out</button></div><div class="pdp-accordion"><div class="pdp-accordion-row">Care and materials</div></div></div></section>`,
  ].join("");
}

interface PageReport {
  rules: number;
  checked: number;
  overridden: string[];
  contrast: string[];
  overflow: number;
}

/** `--shots=<dir>`: also save a screenshot of each page there. */
const shots = process.argv
  .find((arg) => arg.startsWith("--shots="))
  ?.slice("--shots=".length);

async function main() {
  const browser = await chromium.launch({ executablePath, headless: true });
  const failures: string[] = [];
  try {
    for (const theme of EXEMPLAR_THEMES) {
      const design = theme.preset.design;
      const vars = designToCssVars(design, theme.preset.brand.primaryColor);
      const style = Object.entries(vars)
        .map(([key, value]) => `${key}:${value}`)
        .join(";");
      const layout = design.layout ?? {};
      const rootClass = [
        "storefront-root",
        STYLESHEET_ROOT_CLASS,
        // The wishlist heart is on for every store unless switched off.
        "sm-wishlist",
        // So is the quick view eye, under it.
        "sm-quickview",
        `sm-card-${layout.card ?? "classic"}`,
        `sm-header-${layout.header ?? "classic"}`,
        `sm-pdp-${layout.productDetail ?? "classic"}`,
        `sm-footer-${layout.footer ?? "rich"}`,
      ].join(" ");
      const themeCss = themeStylesheetCss(theme.preset.stylesheet);
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${theme.name}</title><style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial, sans-serif}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
${productionCss.join("\n")}
</style><style id="theme-styles">${themeCss}</style></head><body><main class="${rootClass}" style="${style};--sm-accent:var(--brand-primary);background:var(--sm-cream);color:var(--sm-ink)"><div class="home-sections">${fixture(layout.card === "overlay" ? "split" : "split")}</div></main></body></html>`;

      for (const width of [390, 1440]) {
        const context = await browser.newContext({
          viewport: { width, height: 1200 },
          reducedMotion: "no-preference",
        });
        // Offline: nothing leaves the page.
        await context.route("**/*", (route: { abort(): Promise<void> }) =>
          route.abort(),
        );
        const page = await context.newPage();
        await page.setContent(html);
        await page.addScriptTag({ content: axe });
        // tsx names the functions it compiles with a helper the page lacks.
        await page.evaluate("globalThis.__name = (fn) => fn");
        const report: PageReport = await page.evaluate(async () => {
          const sheet = (
            document.getElementById("theme-styles") as HTMLStyleElement
          ).sheet!;
          const overridden: string[] = [];
          let rules = 0;
          let checked = 0;
          const stateful = /:(hover|focus-within|focus-visible|active)\b/;
          const walk = (list: CSSRuleList) => {
            for (const rule of Array.from(list)) {
              if (rule instanceof CSSMediaRule) {
                if (window.matchMedia(rule.conditionText).matches)
                  walk(rule.cssRules);
                continue;
              }
              if (!(rule instanceof CSSStyleRule)) continue;
              rules += 1;
              const selectors = rule.selectorText
                .split(",")
                .map((s) => s.trim())
                .filter((s) => !stateful.test(s));
              if (!selectors.length) continue;
              for (const el of Array.from(
                document.querySelectorAll<HTMLElement>(selectors.join(",")),
              )) {
                for (const property of Array.from(rule.style)) {
                  const value = rule.style.getPropertyValue(property);
                  const before =
                    getComputedStyle(el).getPropertyValue(property);
                  const inline = el.style.getPropertyValue(property);
                  el.style.setProperty(property, value);
                  const after = getComputedStyle(el).getPropertyValue(property);
                  if (inline) el.style.setProperty(property, inline);
                  else el.style.removeProperty(property);
                  checked += 1;
                  if (before !== after)
                    overridden.push(
                      `${rule.selectorText.split(",")[0].replace(/^\S+ /, "")} { ${property}: ${value} } renders ${before}`,
                    );
                }
              }
            }
          };
          walk(sheet.cssRules);
          const result = await (
            window as unknown as {
              axe: {
                run(
                  node: Document,
                  options: object,
                ): Promise<{
                  violations: {
                    nodes: { target: string[]; failureSummary?: string }[];
                  }[];
                }>;
              };
            }
          ).axe.run(document, {
            runOnly: { type: "rule", values: ["color-contrast"] },
          });
          return {
            rules,
            checked,
            overridden: [...new Set(overridden)],
            contrast: result.violations.flatMap((v) =>
              v.nodes.map(
                (n) =>
                  `${n.target.join(" ")}: ${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 160)}`,
              ),
            ),
            overflow:
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          };
        });
        if (shots)
          await page.screenshot({
            path: join(shots, `${theme.id}-${width}.png`),
            clip: { x: 0, y: 0, width, height: width > 1000 ? 1500 : 2200 },
          });
        await context.close();
        const label = `${theme.id} @${width}`;
        const problems = [
          ...report.overridden.map((line) => `not in effect: ${line}`),
          ...report.contrast.map((line) => `contrast: ${line}`),
          ...(report.overflow > 1
            ? [`the page scrolls sideways by ${report.overflow}px`]
            : []),
        ];
        console.log(
          `${problems.length ? "FAIL" : "pass"}  ${label}: ${report.rules} rules, ${report.checked} declarations checked on the page`,
        );
        for (const problem of problems.slice(0, 25))
          console.log(`      ${problem}`);
        if (problems.length > 25)
          console.log(`      ... and ${problems.length - 25} more`);
        failures.push(...problems.map((problem) => `${label}: ${problem}`));
        if (report.checked === 0)
          failures.push(`${label}: no declaration was checked`);
      }
    }
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.log(`\n${failures.length} failure(s).`);
    process.exit(1);
  }
  console.log("\nEvery exemplar's style rules are in effect, read and fit.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
