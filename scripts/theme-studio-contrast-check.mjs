/** Replays the dark discount badge, faint compare price and market drawer
 * failures and Bubble's white-on-gold hero using production CSS in offline
 * Chromium. Negative controls must reproduce the defects first. */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const requireJob = createRequire(
  new URL("../jobs/theme-studio-capture/package.json", import.meta.url),
);
const { chromium } = requireJob("playwright-core");
const axe = readFileSync(requireJob.resolve("axe-core/axe.min.js"), "utf8");
const readCss = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const shop = readCss("../app/(storefront)/(pages)/shop/shop.css");
const home = readCss("../app/(storefront)/components/homepage/homepage.css");
// Resolve CSS Modules' global escape; class names intentionally match the
// component's local names in this isolated fixture.
const delivery = readCss(
  "../app/(storefront)/components/delivery/delivery-location.module.css",
).replace(/:global\(([^)]+)\)/g, "$1");
const macChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE_PATH ||
    (existsSync(macChrome) ? macChrome : chromium.executablePath()),
  headless: true,
});
const failures = [];
let cases = 0;
const negative = `.home-product-carousel .shop-card-off,.shop-listing .shop-card-off{background:rgba(255,255,255,.55)}.home-product-carousel .shop-card-base,.shop-listing .shop-card-base{color:var(--sm-ink-soft)}.sm-header-market .drawerRoot .trigger,.sm-header-market .drawerRoot .trigger:hover{color:var(--sm-header-fg);background:#f8f5f0}.sm-header-market .drawerRoot .triggerCopy small{color:var(--sm-header-fg)}`;
const fixture = (dark, broken) => `<!doctype html><html lang="en"><head><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial;background:${dark ? "#141414" : "#faf8f5"};color:${dark ? "#eeeeee" : "#222"}}
:root{--sm-cream:${dark ? "#141414" : "#faf8f5"};--sm-surface:var(--sm-cream);--sm-sand:var(--sm-cream);--sm-cream-deep:var(--sm-cream);--sm-ink:${dark ? "#eeeeee" : "#222"};--sm-ink-soft:${dark ? "#999" : "#aaa"};--sm-ink-faint:#aaa;--sm-border:#888;--sm-accent:#222;--sm-on-accent:#fff;--sm-shadow-rgb:0,0,0;--sm-header-fg:#fff;--sm-radius-control:12px}
${shop}\n${home}\n${delivery}
.drawerRoot{display:block!important}.fixture{padding:20px}.shop-card-price{font-size:16px!important;font-weight:400!important}.shop-card-base{font-size:14px!important;font-weight:400!important}.shop-card-off{font-size:14px!important;font-weight:400!important}
${broken ? negative : ""}</style></head><body><main class="storefront-root fixture">
<section class="home-product-carousel"><div class="shop-card-price"><span class="shop-card-base">₹1,900</span><span class="shop-card-off">20% off</span></div></section>
<section class="shop-listing"><div class="shop-card-price"><span class="shop-card-base">₹1,900</span><span class="shop-card-off">20% off</span></div></section>
<section><span class="pdp-price-base">₹1,900</span></section>
<section class="sm-header-market"><div class="root drawerRoot"><button class="trigger"><span class="triggerCopy"><small>DELIVER TO</small><strong>Select location</strong></span></button></div></section>
</main></body></html>`;
const heroFixture = (
  variant,
  mode,
  scheme = false,
  field = "",
) => `<!doctype html><html lang="en"><head><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial;background:#fff}
:root{--sm-cream:#fff;--sm-cream-deep:#f5d061;--sm-ink:#111111;--sm-on-ink:#fff;--sm-page-cream-deep:#f5d061;--sm-page-ink:#111111;--sm-page-on-ink:#fff;--sm-scheme-inverse-bg:#111111;--sm-scheme-inverse-fg:#fff;--sm-scheme-inverse-surface:#222;--sm-scheme-inverse-accent:#fff;--sm-scheme-inverse-on-accent:#111111}
${home}</style></head><body><main class="storefront-root"><section class="home-section ${scheme ? "sm-scheme sm-scheme-inverse" : ""}"><div class="home-hero variant-${variant} theme-${mode}" ${field ? `style="background:${field}"` : ""}><div class="home-hero-copy"><h1 class="home-hero-heading">Living bubbles</h1><p class="home-hero-sub">Slow brewed botanical drinks</p></div></div></section></main></body></html>`;
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  const checkHtml = async (width, html) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(html);
    await page.addScriptTag({ content: axe });
    return page.evaluate(async () =>
      (
        await window.axe.run(document, {
          runOnly: { type: "rule", values: ["color-contrast"] },
        })
      ).violations.flatMap((v) =>
        v.nodes.map((n) => ({
          target: n.target.join(" "),
          data: n.any.find((c) => c.id === "color-contrast")?.data,
        })),
      ),
    );
  };
  const check = (width, dark, broken) =>
    checkHtml(width, fixture(dark, broken));
  const badDark = await check(390, true, true);
  const badLight = await check(390, false, true);
  if (
    !badDark.some((v) => v.target.includes("shop-card-off")) ||
    !badLight.some((v) => v.target.includes("shop-card-base")) ||
    !badLight.some((v) => v.target === "small" && v.data?.bgColor === "#f8f5f0")
  )
    failures.push({
      negativeControl:
        "did not reproduce badge, compare price and market drawer failures",
      badDark,
      badLight,
    });
  for (const width of [360, 390, 768, 1024, 1440]) {
    for (const dark of [false, true]) {
      const violations = await check(width, dark, false);
      cases++;
      if (violations.length) failures.push({ width, dark, violations });
    }
  }
  const badHero = await checkHtml(390, heroFixture("split", "light"));
  if (
    !badHero.some(
      (v) =>
        v.target === "h1" &&
        v.data?.bgColor === "#f5d061" &&
        Math.abs(v.data?.contrastRatio - 1.49) < 0.02,
    ) ||
    !badHero.some(
      (v) =>
        v.target === "p" &&
        v.data?.fgColor === "#fef8e7" &&
        Math.abs(v.data?.contrastRatio - 1.4) < 0.02,
    )
  )
    failures.push({
      negativeControl: "did not reproduce Bubble's heading/subheading failures",
      badHero,
    });
  for (const width of [360, 390, 768, 1024, 1440]) {
    for (const [variant, mode, scheme, field] of [
      ["banner", "dark", false, ""],
      ["split", "dark", false, ""],
      ["minimal", "dark", false, ""],
      ["banner", "light", true, ""], // card reset forces page ink
      ["split", "dark", true, ""], // band text on its derived deep field
      ["minimal", "light", false, "#111111"],
    ]) {
      const violations = await checkHtml(
        width,
        heroFixture(variant, mode, scheme, field),
      );
      cases++;
      if (violations.length)
        failures.push({ width, variant, mode, scheme, field, violations });
    }
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ cases, negativeControls: 5, failures }, null, 2));
if (failures.length) process.exitCode = 1;
