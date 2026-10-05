/** Capture the reference screenshots for the screenshot-led Theme Studio
 * benchmark (evals/theme-studio/reference-benchmark.json) with local Chrome.
 *
 * Run: node scripts/theme-studio-benchmark-references.mjs [--out=<dir>] [--only=<case-id>]
 *
 * Writes <out>/<case-id>/NN-<shot>.jpg plus <out>/manifest.json. The default
 * folder, .theme-studio-references/, is git-ignored: these are screenshots of
 * third-party demo stores used as design references, and must not be
 * committed. No database, no model calls.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const requireJob = createRequire(
  new URL("../jobs/theme-studio-capture/package.json", import.meta.url),
);
const { chromium } = requireJob("playwright-core");
const option = (key) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
const out = option("out") ?? ".theme-studio-references";
const only = option("only");
const { cases } = JSON.parse(
  readFileSync(
    new URL("../evals/theme-studio/reference-benchmark.json", import.meta.url),
    "utf8",
  ),
);

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Close the newsletter / cookie / age popups demo stores open on arrival. */
async function settle(page) {
  await page
    .waitForLoadState("networkidle", { timeout: 30_000 })
    .catch(() => {});
  // Popups usually open 2–5 seconds after load.
  await page.waitForTimeout(6_000);
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await page
    .evaluate(() => {
      const closers = [
        ...document.querySelectorAll(
          'button[aria-label*="close" i], [class*="popup" i] button, [class*="modal" i] button[class*="close" i], #shopify-pc__banner__btn-accept, button[class*="accept" i]',
        ),
      ];
      for (const el of closers.slice(0, 6)) {
        try {
          el.click();
        } catch {}
      }
    })
    .catch(() => {});
  // Lazy images: scroll down and back so the first screens are painted.
  await page
    .evaluate(async () => {
      for (let y = 0; y < 4000; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    })
    .catch(() => {});
  await page.waitForTimeout(1_500);
  await clearOverlays(page);
}

/** Remove whatever overlay is open right now: dialogs, and any fixed or
 * absolutely positioned layer covering a large part of the screen (newsletter
 * and cookie popups appear on a timer, so this runs before every shot).
 * A sticky header is far smaller than the threshold and survives. */
async function clearOverlays(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .evaluate(() => {
      const area = window.innerWidth * window.innerHeight;
      for (const el of document.querySelectorAll(
        'dialog[open], [role="dialog"], [aria-modal="true"]',
      ))
        el.remove();
      for (const el of document.querySelectorAll("body *")) {
        const style = getComputedStyle(el);
        if (style.position !== "fixed") continue;
        const r = el.getBoundingClientRect();
        const visible =
          Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
          Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        // An overlay sits on a high layer or carries a signup form. A fixed
        // parallax hero background does neither and must survive.
        const z = Number.parseInt(style.zIndex, 10);
        const overlay =
          (Number.isFinite(z) && z >= 100) ||
          el.querySelector('input[type="email"]') !== null;
        if (overlay && visible / area >= 0.15) el.remove();
      }
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      document.body.classList.forEach((c) => {
        if (/(lock|no-scroll|overflow-hidden|modal)/i.test(c))
          document.body.classList.remove(c);
      });
    })
    .catch(() => {});
  await page.waitForTimeout(300);
}

async function firstLink(page, pattern) {
  return page
    .evaluate((source) => {
      const re = new RegExp(source);
      const link = [...document.querySelectorAll("a[href]")].find((a) =>
        re.test(new URL(a.href, location.href).pathname),
      );
      return link ? new URL(link.href, location.href).href : null;
    }, pattern)
    .catch(() => null);
}

const executablePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true });
const manifest = {
  version: 1,
  capturedAt: new Date().toISOString(),
  note: "Third-party demo-store screenshots used only as design references. Do not commit.",
  cases: {},
};
const manifestPath = join(out, "manifest.json");
if (existsSync(manifestPath))
  Object.assign(
    manifest.cases,
    JSON.parse(readFileSync(manifestPath, "utf8")).cases ?? {},
  );
let failed = 0;
try {
  for (const entry of cases.filter((c) => !only || c.id === only)) {
    const dir = join(out, entry.id);
    mkdirSync(dir, { recursive: true });
    const shots = [];
    /** A viewport screenshot after scrolling to `y`: what a person sees.
     * Full-page clips re-lay-out 100vh heroes and render them blank. */
    const shoot = async (page, name, y = 0) => {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(900);
      await clearOverlays(page);
      const file = `${String(shots.length + 1).padStart(2, "0")}-${name}.jpg`;
      await page.screenshot({
        path: join(dir, file),
        type: "jpeg",
        quality: 85,
      });
      shots.push({ file, page: name, url: page.url() });
    };
    try {
      const desktop = await browser.newContext({
        viewport: DESKTOP,
        deviceScaleFactor: 1,
      });
      const page = await desktop.newPage();
      await page.goto(entry.url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await settle(page);
      const height = await page.evaluate(
        () => document.documentElement.scrollHeight,
      );
      for (let screen = 0; screen < 3; screen++) {
        const y = screen * DESKTOP.height;
        if (y >= height - 200) break;
        await shoot(page, `desktop-home-${screen + 1}`, y);
      }
      const collection =
        (await firstLink(page, "^/collections/[^/]+/?$")) ??
        new URL("/collections/all", entry.url).href;
      await page.goto(collection, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await settle(page);
      await shoot(page, "desktop-collection");
      const product = await firstLink(page, "/products/[^/]+/?$");
      if (product) {
        await page.goto(product, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await settle(page);
        await shoot(page, "desktop-product");
      }
      await desktop.close();

      const phone = await browser.newContext({
        viewport: PHONE,
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      const mobile = await phone.newPage();
      await mobile.goto(entry.url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await settle(mobile);
      await shoot(mobile, "phone-home-1", 0);
      await shoot(mobile, "phone-home-2", PHONE.height);
      await phone.close();
      manifest.cases[entry.id] = {
        url: entry.url,
        shopifyTheme: entry.shopifyTheme,
        shots,
      };
      console.log(`${entry.id}: ${shots.length} screenshots`);
    } catch (error) {
      failed++;
      console.error(
        `${entry.id}: capture failed — ${error instanceof Error ? error.message : error}`,
      );
    }
  }
} finally {
  await browser.close();
  mkdirSync(out, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
console.log(`Saved ${manifestPath}`);
process.exit(failed ? 1 : 0);
