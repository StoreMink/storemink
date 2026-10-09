/** Replays the dark discount badge, faint compare price and market drawer
 * failures, Bubble's white-on-gold hero, and the three chrome-state defects
 * of 2026-10-09 (sign-in subtitle contrast, the search sheet's 18px submit
 * target, the account menu's bare button) using production CSS in offline
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
const headerCss = readCss(
  "../app/(storefront)/components/header/Header.module.css",
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
const PALETTES = {
  light:
    "--sm-cream:#faf8f5;--sm-surface:#ffffff;--sm-sand:#f1ede6;--sm-cream-deep:#efece9;--sm-ink:#211c25;--sm-ink-soft:#554d59;--sm-ink-faint:#675c6b;--sm-border:#cfc9c2;--sm-on-ink:#ffffff;--sm-accent:#45243c;--sm-on-accent:#ffffff;--brand-primary:#45243c",
  dark: "--sm-cream:#141414;--sm-surface:#1c1c1c;--sm-sand:#242424;--sm-cream-deep:#1a1a1a;--sm-ink:#eeeeee;--sm-ink-soft:#bdbdbd;--sm-ink-faint:#a0a0a0;--sm-border:#555555;--sm-on-ink:#111111;--sm-accent:#f0e6d8;--sm-on-accent:#111111;--brand-primary:#f0e6d8",
};
const HEADER_BARS = {
  light: "--sm-header-bg:#f3efe8;--sm-header-fg:#1b1b1b",
  dark: "--sm-header-bg:#1f2a37;--sm-header-fg:#ffffff",
};
// The rule the 2026-10-04 fix replaced: the drawer trigger took the header's
// foreground over the page's cream.
const drawerNegative =
  ".sm-header-market .drawerRoot .trigger{color:var(--sm-header-fg)}.sm-header-market .drawerRoot .triggerCopy small{color:var(--sm-header-fg)}";
const deliveryTrigger =
  '<button class="trigger"><svg width="18" height="18" aria-hidden="true"></svg><span class="triggerCopy"><small>Deliver to</small><strong>Select location</strong></span><svg width="15" height="15" aria-hidden="true"></svg></button>';
// Markup follows Header.jsx / drawer-nav.tsx / delivery-location-control.tsx
// by class; icon-only controls are left empty, since axe judges text.
const headerFixture = (
  variant,
  palette,
  headerBar,
  drawerOpen,
  broken = "",
  opening = "",
) => `<!doctype html><html lang="en"><head><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial;background:var(--sm-cream);color:var(--sm-ink)}
:root{${PALETTES[palette]};${HEADER_BARS[headerBar]};--sm-shadow-rgb:0,0,0;--sm-radius-control:12px;--sm-radius-sm:8px;--sm-radius-pill:999px;--font-outfit:Arial}
${headerCss}\n${delivery}
.hamburgerBtn{display:flex!important}
${broken}</style></head><body><main class="storefront-root sm-header-${variant}">
<header class="header">
 <div class="headerLeft"><a class="logo" href="#"><span class="brandNameText">Roastery</span></a><nav class="navLinks"><a href="#">Shop</a><a href="#">About</a></nav></div>
 <div class="headerRight">
  <div class="root">${deliveryTrigger}</div>
  <div class="iconGroup"><button class="userIcon" aria-label="Sign in"></button><button class="cartBtn" aria-label="Open cart"></button></div>
  <button class="hamburgerBtn" aria-label="Open Menu"></button>
 </div>
 <div class="mobileDrawer ${drawerOpen ? "drawerOpen" : ""}">
  <div class="drawerHeader"><a class="logo" href="#"><span class="brandNameText">Roastery</span></a><button class="closeBtn" aria-label="Close Menu"></button></div>
  <div class="root drawerRoot">${deliveryTrigger}</div>
  <nav class="drawerNav"><a href="#">Shop</a><button class="drawerNavParent">Collections</button><a href="#" class="drawerViewAll">View all</a><div class="drawerLevelHead"><button class="drawerBack">Back</button><h2 class="drawerLevelTitle">Coffee</h2></div></nav>
  <div class="drawerAuth"><button class="drawerAuthBtn">Sign in</button></div>
 </div>
 <div class="drawerOverlay ${drawerOpen ? "overlayVisible" : ""}"></div>
</header>${opening}</main></body></html>`;
// A transparent header at the top of a page whose opening photograph reads
// with the ON-INK: MediaTone settles `theme-light` on the first hero when
// the palette's on-ink reads over its pixels (a dark photo on a light
// palette, a pale one on a dark palette), and the header's :has() rule
// paints the bar's controls on-ink. The fixture stands a field of that
// kind under the bar, since axe judges text on a photograph as incomplete.
// The drawer must stay on the page ink whatever the bar does.
const lightOpening = (palette) =>
  `<div class="home-sections"><section class="home-section"><div class="home-hero theme-light" style="height:420px;background:${palette === "dark" ? "#f0f0f0" : "#1c1c1c"}"></div></section></div>`;
// The rule as it stood before 2026-10-10: the bar's on-ink reached the
// drawer's brand name through the :has() rule's specificity.
const transparentNegative =
  ".sm-header-transparent .mobileDrawer .brandNameText{color:var(--sm-on-ink)}";
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
      // A fullbleed hero with no photo is a plain field like minimal.
      ["fullbleed", "dark", false, ""],
      ["fullbleed", "dark", true, ""],
      ["fullbleed", "light", false, "#111111"],
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
  // Header × drawer. The roastery's 1.37:1 (benchmark 2026-10-04) was the
  // market header's white text inherited by the light phone drawer; the
  // drawer is a PAGE surface whatever the header's colours. Each header
  // variant is rendered over a light and a dark page palette, the market
  // variant also under a light and a dark header bar, with the drawer closed
  // (the bar is measured) and open (the drawer is).
  const badDrawer = await checkHtml(
    390,
    headerFixture("market", "light", "dark", true, drawerNegative),
  );
  if (
    !badDrawer.some(
      (v) => /small|strong/.test(v.target) && v.data?.fgColor === "#ffffff",
    )
  )
    failures.push({
      negativeControl:
        "did not reproduce the drawer inheriting the header's white text",
      badDrawer,
    });
  for (const width of [390, 768, 1440]) {
    for (const variant of [
      "classic",
      "market",
      "centered",
      "minimal",
      "transparent",
      "hamburger",
      "stacked",
      "utility",
    ]) {
      for (const palette of ["light", "dark"]) {
        for (const header of variant === "market"
          ? ["light", "dark"]
          : ["light"]) {
          for (const drawerOpen of [false, true]) {
            const violations = await checkHtml(
              width,
              headerFixture(variant, palette, header, drawerOpen),
            );
            cases++;
            if (violations.length)
              failures.push({
                width,
                variant,
                palette,
                header,
                drawerOpen,
                violations,
              });
          }
        }
      }
    }
  }
  // The transparent header over a light-copy opening, drawer open, on both
  // palettes: on a dark palette on-ink is near-black, so the drawer's name
  // on the drawer's surface was 1.07:1 (the bold-and-loud exemplar).
  const badTransparent = await checkHtml(
    390,
    headerFixture(
      "transparent",
      "dark",
      "light",
      true,
      transparentNegative,
      lightOpening("dark"),
    ),
  );
  if (!badTransparent.some((v) => v.target.includes("brandNameText")))
    failures.push({
      negativeControl:
        "did not reproduce the transparent header's on-ink reaching the drawer",
      badTransparent,
    });
  for (const width of [390, 768, 1440])
    for (const palette of ["light", "dark"])
      for (const drawerOpen of [false, true]) {
        const violations = await checkHtml(
          width,
          headerFixture(
            "transparent",
            palette,
            "light",
            drawerOpen,
            "",
            lightOpening(palette),
          ),
        );
        cases++;
        if (violations.length)
          failures.push({
            width,
            variant: "transparent/light-opening",
            palette,
            drawerOpen,
            violations,
          });
      }
  // Chrome states (Phase 1 item 3 opens them): the sign-in dialog's copy on
  // the dialog surface, the search sheet's submit target, the account menu's
  // ARIA children. Each with the pre-2026-10-09 rule as a negative control.
  const authCss = readCss(
    "../app/(storefront)/components/auth/AuthModal.module.css",
  ).replace(/:global\(([^)]+)\)/g, "$1");
  const authFixture = (broken) => `<!doctype html><html lang="en"><head><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial;background:#f5d061}
:root{--sm-surface:#ffffff;--sm-cream:#f5d061;--sm-ink:#1b1b1b;--sm-ink-soft:#554d59;--sm-ink-faint:#9c958c;--sm-accent:#b5173f;--sm-on-accent:#fff;--sm-radius-card:20px}
${authCss}
${broken ? ".subtitle,.secondaryAction,.divider,.backBtn{color:var(--sm-ink-faint)}" : ""}
</style></head><body><div class="overlay overlayVisible"><div class="modal"><p class="subtitle">Sign in with your mobile number to continue</p><p class="secondaryAction">Didn't get the code? <button class="backBtn">Resend</button></p><div class="divider"><span>or</span></div></div></div></body></html>`;
  const badAuth = await checkHtml(390, authFixture(true));
  if (!badAuth.some((v) => v.target.includes("subtitle")))
    failures.push({
      negativeControl: "did not reproduce Bubble's sign-in subtitle failure",
      badAuth,
    });
  for (const width of [360, 390, 768]) {
    const violations = await checkHtml(width, authFixture(false));
    cases++;
    if (violations.length) failures.push({ width, authDialog: violations });
  }
  const sheetFixture = (broken) => `<!doctype html><html lang="en"><head><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial}
:root{--sm-surface:#fff;--sm-sand:#f4f1ec;--sm-border:#ddd;--sm-ink:#1b1b1b;--sm-ink-faint:#777;--sm-radius-control:10px;--sm-shadow-rgb:0,0,0}
${headerCss}
${broken ? ".searchIcon{width:auto;height:auto;margin:0}" : ""}
</style></head><body><div class="searchSheet" role="dialog"><form class="drawerSearchBar" role="search"><input class="searchInput" placeholder="Search products"><button type="submit" class="searchIcon" aria-label="Search"><svg width="18" height="18" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/></svg></button></form></div></body></html>`;
  const measureIcon = async (width, html) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(html);
    return page.evaluate(() => {
      const r = document.querySelector(".searchIcon").getBoundingClientRect();
      const bar = document
        .querySelector(".drawerSearchBar")
        .getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        inside: r.right <= bar.right + 0.5 && r.bottom <= bar.bottom + 0.5,
      };
    });
  };
  const badIcon = await measureIcon(390, sheetFixture(true));
  if (badIcon.width >= 24 && badIcon.height >= 24)
    failures.push({
      negativeControl: "did not reproduce the 18px search target",
      badIcon,
    });
  for (const width of [360, 390, 768]) {
    const icon = await measureIcon(width, sheetFixture(false));
    cases++;
    if (icon.width < 24 || icon.height < 24 || !icon.inside)
      failures.push({ width, searchSheetIcon: icon });
  }
  const menuFixture = (broken) => `<!doctype html><html lang="en"><head><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial}
:root{--sm-surface:#fff;--sm-sand:#f4f1ec;--sm-border:#ddd;--sm-ink:#1b1b1b;--sm-ink-soft:#555;--sm-ink-faint:#777;--sm-accent:#b5173f;--sm-on-accent:#fff;--sm-radius-card:16px;--sm-radius-control:10px;--sm-shadow-rgb:0,0,0}
${headerCss}
</style></head><body><div class="profileDropdown" id="profile-dropdown" role="menu"><div class="profileDropdownLogin"><div class="profileDropdownLoginText"><span class="profileDropdownLoginSub">Sign in to access your profile, orders, and more!</span></div><button class="profileDropdownLoginBtn"${broken ? "" : ' role="menuitem"'}>Login/Sign Up</button></div><div class="profileDropdownDivider"></div><a href="/profile" class="profileDropdownItem" role="menuitem">My Profile</a><a href="/track-order" class="profileDropdownItem" role="menuitem">Track Order</a></div></body></html>`;
  const menuChildren = async (html) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.setContent(html);
    await page.addScriptTag({ content: axe });
    return page.evaluate(async () =>
      (
        await window.axe.run(document, {
          runOnly: { type: "rule", values: ["aria-required-children"] },
        })
      ).violations.flatMap((v) => v.nodes.map((n) => n.target.join(" "))),
    );
  };
  const badMenu = await menuChildren(menuFixture(true));
  if (!badMenu.length)
    failures.push({
      negativeControl: "did not reproduce the account menu's disallowed button",
    });
  const menu = await menuChildren(menuFixture(false));
  cases++;
  if (menu.length) failures.push({ accountMenu: menu });
} finally {
  await browser.close();
}
console.log(JSON.stringify({ cases, negativeControls: 9, failures }, null, 2));
if (failures.length) process.exitCode = 1;
