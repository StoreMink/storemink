/** Replays the dark discount badge, faint compare price and market drawer
 * failures using production CSS in offline Chromium. Negative controls must
 * reproduce all three defects before the corrected styles are accepted. */
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
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  const check = async (width, dark, broken) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(fixture(dark, broken));
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
} finally {
  await browser.close();
}
console.log(JSON.stringify({ cases, negativeControls: 3, failures }, null, 2));
if (failures.length) process.exitCode = 1;
