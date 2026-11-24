/** Offline header clearance regression using production CSS and local Chrome.
 * No network, database or provider calls. The measured cases model the height
 * published by useHeaderFit; its observer/lifecycle is tested in Vitest. Eight
 * header variants: the four originals plus transparent, hamburger, stacked and
 * utility (2026-10-09); the last two are two rows tall on desktop. Every
 * photograph-led opening (hero, carousel, and both full width) is measured
 * with and without the announcement bar: under a transparent header it runs
 * under the bar, under every other header it starts below the whole header.
 * Run: node scripts/storefront-header-layout-check.mjs
 * --css-ref=<revision> diagnoses old CSS; --screenshots=<dir> saves fixtures,
 * not live storefront evidence.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const requireJob = createRequire(
  new URL("../jobs/theme-studio-capture/package.json", import.meta.url),
);
const { chromium } = requireJob("playwright-core");
const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const ref = option("css-ref");
const screenshots = option("screenshots");
if (screenshots) mkdirSync(screenshots, { recursive: true });
const read = (path) =>
  ref
    ? execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" })
    : readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sheets = [
  read("app/(storefront)/storefront-theme.css"),
  read("app/(storefront)/components/homepage/homepage.css"),
  read("app/(storefront)/components/header/Header.module.css"),
  read("app/(storefront)/components/delivery/delivery-location.module.css"),
].map((css) => css.replace(/:global\(([^()]*)\)/g, "$1"));
const publishesHeight = read(
  "app/(storefront)/components/header/use-header-fit.ts",
).includes("publishHeight();");
const icon =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></svg>';
const hero =
  '<div class="home-hero variant-minimal theme-dark"><div class="home-hero-copy"><h1 class="home-hero-heading">The new season</h1></div></div>';
const first = {
  ticker:
    '<section class="home-section home-pad-sm is-fullbleed" style="background:#2a211f"><div class="home-ticker theme-light speed-slow"><div class="home-ticker-track"><div class="home-ticker-seq"><span class="home-ticker-item">Complimentary delivery over ₹2,999</span><span class="home-ticker-item">Free 14-day exchanges</span></div></div></div></section>',
  text: '<section class="home-section"><div class="home-rich-text"><h1>Our story</h1><p>Thoughtfully made everyday essentials.</p></div></section>',
  hero: `<section class="home-section">${hero}</section>`,
  carousel:
    '<section class="home-section"><div class="home-carousel" style="height:300px">Photo carousel</div></section>',
  // The opening every new theme and every revamp leads with (Theme Studio
  // v26/v27): a photograph that fills the band, edge to edge.
  heroFull: `<section class="home-section is-fullbleed">${hero.replace("variant-minimal", "variant-fullbleed height-large")}</section>`,
  carouselFull:
    '<section class="home-section is-fullbleed"><div class="home-carousel has-arrows height-large" style="background:#2a211f">Photo carousel</div></section>',
  // ★ The same openings with the section's own vertical padding set (a
  // theme's or a merchant's `padding_y`): the photograph still starts where
  // the section does (22 Nov 2026: the Roast theme's "sm" left 28px of page
  // colour between the header and its slideshow).
  heroFullPadded: `<section class="home-section home-pad-lg is-fullbleed">${hero.replace("variant-minimal", "variant-fullbleed height-large")}</section>`,
  carouselFullPadded:
    '<section class="home-section home-pad-sm is-fullbleed"><div class="home-carousel has-arrows height-large" style="background:#2a211f">Photo carousel</div></section>',
  custom:
    '<section class="home-section home-custom-code"><div style="height:300px;background:#eee">Custom hero</div></section>',
};
// The openings a page can lead with that are photographs (plan Phase 2d):
// a transparent header floats over them (they start under the opaque
// announcement bar only); under every other header they start below the
// whole header, announcement bar included.
const HERO_LED = [
  "hero",
  "carousel",
  "heroFull",
  "carouselFull",
  "heroFullPadded",
  "carouselFullPadded",
];
// The openings that are a full-width photograph: nothing sits above the
// photograph inside its own section.
const FULL_PHOTO = [
  "heroFull",
  "carouselFull",
  "heroFullPadded",
  "carouselFullPadded",
];
// The section gap (homepage.css `.home-sections` padding), where a hero-led
// page used to start whatever the header measured.
const sectionGap = (width) => Math.min(72, Math.max(40, width * 0.06));
const announcement =
  '<div class="announcement" data-sm="announcement"><a class="announcementLink" href="/shop"><span class="announcementText">Free delivery on orders over ₹999, easy 14-day returns</span></a></div>';
function fixture(header, content, width, order, announce = false) {
  // Landscape/tablet fits fold the same three controls as useHeaderFit.
  const compact =
    width > 768 && width < 1200
      ? 'data-header-compact="nav delivery search"'
      : "";
  return `<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial}button,input{font:inherit}button{padding:0}svg{display:block}
    :root{--sm-ink:#2a211f;--sm-cream:#fbfaf8;--sm-surface:#fff;--sm-ink-soft:#6e635e;--sm-ink-faint:#766861;--sm-on-ink:#fff;--sm-shadow-rgb:42,33,31;--sm-border:#ddd6cf;--sm-header-bg:#fbfaf8;--sm-header-fg:#2a211f;--sm-accent-warm:#8c6f63;--sm-on-accent:#fff;--sm-sand:#efebe6}
    ${order === "forward" ? sheets.join("\n") : [...sheets].reverse().join("\n")}
    </style></head><body><div class="storefront-root sm-header-${header}${announce ? " sm-announce" : ""}">
    <header class="header" ${compact}>${announce ? announcement : ""}<div class="headerLeft"><a class="logo" href="/"><span class="brandNameText">Vitrine</span></a><nav class="navLinks"><a href="/shop">Shop</a><a href="/about">Our story</a></nav></div>
    <div class="headerRight"><div class="root" data-delivery-control><button class="trigger">${icon}<span class="triggerCopy"><small>Deliver to</small><strong>Check delivery</strong></span></button></div><div class="searchWrap"><form class="searchBar"><input class="searchInput" aria-label="Search" placeholder="Search products"></form></div><button class="phoneSearchBtn" aria-label="Search">${icon}</button><div class="iconGroup"><button class="userIcon" aria-label="Account">${icon}</button><button class="cartBtn" aria-label="Cart">${icon}</button></div><button class="hamburgerBtn" aria-label="Menu">${icon}</button></div></header>
    <main><div class="home-sections">${first[content]}<section class="home-section">${hero}</section></div></main></div></body></html>`;
}
const executablePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true });
const measurements = [],
  failures = [];
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  for (const [width, height] of [
    [360, 780],
    [390, 844],
    [430, 932],
    [768, 1024],
    [844, 390],
    [1440, 900],
  ])
    for (const header of [
      "classic",
      "centered",
      "minimal",
      "market",
      "transparent",
      "hamburger",
      "stacked",
      "utility",
    ])
      for (const content of Object.keys(first))
        for (const order of ["forward", "reverse"])
          for (const mode of ["server", "measured"])
            // The announcement bar (lib/themes/announcement.ts) rides in the
            // header's top border: one order per variant and width is enough
            // to prove it sits above the controls, spans the viewport and is
            // counted in the height the page reserves, for a leading ticker
            // AND for every photograph-led opening (★★ L2-J, 2026-10-22: the
            // revamped homepages put the logo and menu half over the photo
            // with the bar on, because a hero-led page reserved none of it),
            // and a custom-code opening, which the opaque bar must not cover.
            for (const announce of order === "forward" &&
            ["ticker", "custom", ...HERO_LED].includes(content)
              ? [false, true]
              : [false]) {
              await page.setViewportSize({ width, height });
              await page.setContent(
                fixture(header, content, width, order, announce),
              );
              if (mode === "measured" && publishesHeight)
                await page.evaluate(() => {
                  const header = document.querySelector("header");
                  header
                    .closest(".storefront-root")
                    .style.setProperty(
                      "--sm-header-h",
                      `${Math.ceil(header.getBoundingClientRect().height)}px`,
                    );
                });
              const result = await page.evaluate(() => {
                const header = document
                  .querySelector("header")
                  .getBoundingClientRect();
                const firstSection = document.querySelector(".home-section");
                const first = firstSection.getBoundingClientRect();
                const photo = firstSection.querySelector(
                  ":scope > .home-hero, :scope > .home-carousel",
                );
                const children = [
                  ...document.querySelectorAll(
                    "header .logo,header .phoneSearchBtn,header .userIcon,header .cartBtn,header .hamburgerBtn",
                  ),
                ]
                  .map((el) => el.getBoundingClientRect())
                  .filter((r) => r.width && r.height);
                const bar = document.querySelector(".announcement");
                const barRect = bar ? bar.getBoundingClientRect() : null;
                const logo = document.querySelector("header .logo");
                // What a shopper reads in the bar: the logo, the menu and
                // the icons. Where the opening starts above their bottom
                // edge, they sit half over the photograph (L2-J).
                const readable = [
                  ...document.querySelectorAll(
                    "header .logo,header .navLinks a,header .headerRight > *,header .iconGroup > *",
                  ),
                ]
                  .map((el) => el.getBoundingClientRect())
                  .filter((r) => r.width && r.height);
                return {
                  headerHeight: header.height,
                  headerBottom: header.bottom,
                  controlsBottom: Math.max(...readable.map((r) => r.bottom)),
                  contentTop: first.top,
                  // How far the photograph starts below its own section.
                  photoGap: photo
                    ? photo.getBoundingClientRect().top - first.top
                    : null,
                  gap: first.top - header.bottom,
                  controlsPadding: Math.min(
                    ...children.map((r) =>
                      Math.min(r.top - header.top, header.bottom - r.bottom),
                    ),
                  ),
                  overflow:
                    document.documentElement.scrollWidth > innerWidth + 1,
                  bar: barRect
                    ? {
                        top: barRect.top,
                        bottom: barRect.bottom,
                        width: barRect.width,
                        aboveLogo:
                          barRect.bottom <= logo.getBoundingClientRect().top,
                        oneLine: bar.scrollHeight <= barRect.height + 1,
                        linkHeight: bar
                          .querySelector("a")
                          .getBoundingClientRect().height,
                      }
                    : null,
                };
              });
              const label = `${width}x${height}/${header}/${content}/${order}/${mode}${announce ? "/announce" : ""}`;
              measurements.push({ label, ...result });
              const problems = [];
              if (announce) {
                const bar = result.bar;
                if (!bar) problems.push("announcement bar not rendered");
                else {
                  if (bar.top !== 0 || Math.abs(bar.bottom - 36) > 0.5)
                    problems.push("announcement bar is not the 36px top strip");
                  if (bar.width < width - 1)
                    problems.push(
                      "announcement bar does not span the viewport",
                    );
                  if (!bar.aboveLogo)
                    problems.push("announcement bar overlaps the controls");
                  if (!bar.oneLine) problems.push("announcement copy wraps");
                  if (bar.linkHeight < 24)
                    problems.push("announcement link is a small target");
                  if (result.headerHeight < 36 + 40)
                    problems.push("header height does not include the bar");
                }
              }
              if (["ticker", "text"].includes(content) && result.gap < 15.9)
                problems.push(
                  `leading content overlaps/crowds the header (${result.gap}px)`,
                );
              if (result.controlsPadding < 11.9)
                problems.push(
                  `controls have only ${result.controlsPadding}px vertical padding`,
                );
              if (width <= 768 && result.overflow)
                problems.push("phone viewport overflow");
              // A custom-code opening floats under every header but the market
              // bar, which reserves space once, including in landscape. ★ The
              // announcement bar is OPAQUE, so with it on the custom opening
              // starts under the bar, never behind it: the header row then
              // floats over the same top edge it floats over without a bar.
              if (
                content === "custom" &&
                Math.abs(
                  result.contentTop -
                    (header === "market"
                      ? result.headerHeight
                      : announce
                        ? 36
                        : 0),
                ) > (mode === "server" ? 16 : 1)
              )
                problems.push("custom hero clearance changed");
              if (FULL_PHOTO.includes(content) && result.photoGap > 0.5)
                problems.push(
                  `the opening photograph starts ${result.photoGap}px below its section: page colour shows under the header`,
                );
              if (HERO_LED.includes(content)) {
                if (header === "transparent") {
                  // ★ The transparent header floats over the opening
                  // photograph as designed, which starts at the top of the
                  // page, under the opaque bar when there is one.
                  if (Math.abs(result.contentTop - (announce ? 36 : 0)) > 1)
                    problems.push(
                      `the transparent header's opening moved (${result.contentTop}px)`,
                    );
                } else if (header === "market") {
                  // The market bar reserves its own height on the root. A
                  // full-width photograph starts right under it; any other
                  // hero keeps the breathing gap below the bar.
                  const expected =
                    result.headerHeight +
                    (FULL_PHOTO.includes(content)
                      ? 0
                      : Math.min(32, Math.max(16, width * 0.025)));
                  if (
                    Math.abs(result.contentTop - expected) >
                    (mode === "server" ? 16 : 1)
                  )
                    problems.push("native hero origin changed");
                } else {
                  // ★★ Every other header: the opening starts below the
                  // WHOLE header, bar included, before hydration (the
                  // server fallback) and after it (the measured height).
                  // Never above the controls' bottom edge, which is what put
                  // the logo and menu half over the photo (L2-J).
                  if (
                    result.contentTop < result.headerBottom - 0.5 ||
                    result.controlsBottom > result.contentTop + 0.5
                  )
                    problems.push(
                      `the opening starts under the header (top ${result.contentTop}px, header ${result.headerHeight}px, controls end ${result.controlsBottom}px)`,
                    );
                  // And no further down than the header, or the page's own
                  // section gap where that is larger: flush under the bar,
                  // the way a solid header meets a full-width photograph.
                  // ★ A full-width photograph meets the header exactly; a
                  // hero drawn as a card keeps the section gap as its floor.
                  const expected = FULL_PHOTO.includes(content)
                    ? result.headerHeight
                    : Math.max(sectionGap(width), result.headerHeight);
                  if (
                    mode === "measured"
                      ? Math.abs(result.contentTop - expected) > 1
                      : result.contentTop > expected + 16
                  )
                    problems.push(
                      `the opening is not flush under the header (top ${result.contentTop}px, expected ${expected}px)`,
                    );
                }
              }
              if (problems.length) failures.push({ label, problems });
              if (announce) continue;
              if (
                screenshots &&
                width === 390 &&
                header === "minimal" &&
                content === "ticker" &&
                order === "forward" &&
                mode === "measured"
              )
                await page.screenshot({
                  path: join(screenshots, "vitrine-header.png"),
                  clip: { x: 0, y: 0, width, height: 250 },
                });
            }
} finally {
  await browser.close();
}
console.log(
  JSON.stringify(
    {
      cases: measurements.length,
      failures,
      phone: measurements.filter(
        (m) => m.label === "390x844/minimal/ticker/forward/measured",
      ),
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
