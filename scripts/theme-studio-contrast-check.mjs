/** Replays the dark discount badge, faint compare price and market drawer
 * failures, Bubble's white-on-gold hero, and the three chrome-state defects
 * of 2026-10-09 (sign-in subtitle contrast, the search sheet's 18px submit
 * target, the account menu's bare button) using production CSS in offline
 * Chromium. Negative controls must reproduce the defects first.
 *
 * Since 2026-10-24 (Theme Studio TS-1G) it also renders every shared surface
 * the 4 Oct benchmark and the 10 Oct exemplar run found on every palette this
 * build ships, each beside the rule it replaced; the card skins, flags and
 * badges; the quick-add dialog; both product pages with the offer badge, the
 * sale option's badge and the PIN-code delivery card; light and dark phone
 * drawers, signed in and out, with the delivery panel open; and two Studio
 * palettes whose ink and on-accent are not opposites. It prints the lowest
 * ratio measured on each surface and the ratio each broken copy reproduced.
 * CI runs it in the renderer job. No network, credentials, database or
 * provider calls:
 *   node scripts/theme-studio-contrast-check.mjs */
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
// The TS-1G section below counts its own negative controls and keeps, per
// labelled surface, the lowest ratio measured and the ratio its broken copy
// reproduced.
let extraControls = 0;
const surfaces = {};
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

  // ════ TS-1G (2026-10-24): the shared surfaces on every palette we ship ════
  // Plan section 3, "StoreMink's shared storefront code". Every surface the
  // 4 Oct benchmark and the 10 Oct exemplar run found is rendered with the
  // stylesheets its page loads (storefront-theme.css holds the card skins) on
  // every bundled palette, beside the rule it replaced. Measured as the
  // capture job measures: reduced motion, animations settled. Text on a
  // labelled surface that axe cannot measure fails too, because "we could
  // not check it" is never a pass.
  const themeCss = readCss("../app/(storefront)/storefront-theme.css");
  const settledPage = await browser.newPage({ reducedMotion: "reduce" });
  await settledPage.route("**/*", (route) => route.abort());
  const SETTLED =
    "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}";
  const SR_ONLY =
    ".sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}";
  // A palette as "token=value" pairs; a bare word is a flag. Header and
  // card default to classic.
  const palette = (spec) =>
    Object.fromEntries([
      ["header", "classic"],
      ["card", "classic"],
      ...spec.split(" ").map((pair) => {
        const [token, value] = pair.split("=");
        return [token, value ?? true];
      }),
    ]);
  // Every theme release this build ships (lib/themes/definitions), the seven
  // exemplars (lib/themes/exemplars) and the un-themed default (globals.css),
  // copied 2026-10-24. A release is immutable (new colours are a new
  // version), so a store pinned to one keeps exactly these. `accent` is the
  // palette's fixed accent, else the preset's brand colour.
  const BUNDLED = {
    default: palette(
      "cream=#fdfcfb creamDeep=#f4f2ee surface=#ffffff sand=#f0ebe3 tile=#f4dfe0 butter=#f3ecc9 ink=#17130f inkSoft=#574f47 inkFaint=#9c958c onInk=#ffffff onAccent=#ffffff accent=#17130f border=#e8e2d9 shadowRgb=23,19,15 error=#c62828 highlight=#f7a600 accentWarm=#ce8662",
    ),
    "basket@1.0.0": palette(
      "cream=#ffffff creamDeep=#f2f5f2 surface=#ffffff sand=#f2f5f2 tile=#f6f8f6 butter=#fdf3d8 ink=#1e2b28 inkSoft=#5c6b66 inkFaint=#9aa8a2 onInk=#ffffff onAccent=#ffffff accent=#ef5a2a border=#e4e9e5 shadowRgb=16,43,36 error=#c0392b highlight=#ef5a2a accentWarm=#ef5a2a header=market headerBg=#0f3e38 headerFg=#ffffff card=grocery",
    ),
    "studio@0.1.0": palette(
      "cream=#f3f0e8 creamDeep=#e9e4d9 surface=#fffdf7 sand=#e6e0d4 tile=#ece7dc butter=#f1c66a ink=#171715 inkSoft=#666259 inkFaint=#716d65 onInk=#ffffff onAccent=#ffffff accent=#2542c7 border=#cec7bb shadowRgb=23,23,21 error=#a43e35 highlight=#ad4e3b accentWarm=#ad4e3b header=centered headerBg=#f3f0e8 headerFg=#171715 card=framed",
    ),
    "ritual@0.1.0": palette(
      "cream=#f3dfda creamDeep=#e9cbc5 surface=#fff8f3 sand=#ead1cb tile=#e7c8c2 butter=#dfe6a0 ink=#321421 inkSoft=#72515b inkFaint=#7c5862 onInk=#fff8f3 onAccent=#fff8f3 accent=#5b1735 border=#d8b8b2 shadowRgb=50,20,33 error=#a33f4f highlight=#dfe6a0 accentWarm=#bd6d4e header=minimal headerBg=#f3dfda headerFg=#321421 card=framed",
    ),
    "vitrine@0.1.0": palette(
      "cream=#fbfaf8 creamDeep=#f1eeea surface=#ffffff sand=#efebe6 tile=#efebe6 butter=#e8dcc8 ink=#2a211f inkSoft=#6e635e inkFaint=#9c928b onInk=#ffffff onAccent=#ffffff accent=#2a211f border=#ddd6cf shadowRgb=42,33,31 error=#b80f27 highlight=#b80f27 accentWarm=#8c6f63 header=minimal",
    ),
    "exemplar-luxury-minimal@0.1.0": palette(
      "cream=#fbfaf8 creamDeep=#f1eeea surface=#ffffff sand=#efebe6 tile=#efebe6 butter=#e8dcc8 ink=#1f1b19 inkSoft=#5c5450 inkFaint=#9c928b onInk=#ffffff onAccent=#ffffff accent=#1f1b19 border=#ddd6cf shadowRgb=31,27,25 error=#b80f27 highlight=#b80f27 accentWarm=#8c6f63 header=minimal card=framed",
    ),
    "exemplar-bold-and-loud@0.1.0": palette(
      "cream=#121212 creamDeep=#1b1b1b surface=#1a1a1a sand=#222222 tile=#1f1f1f butter=#2e2a1f ink=#f5f5f5 inkSoft=#c9c9c9 inkFaint=#8a8a8a onInk=#121212 onAccent=#121212 accent=#e8ff3a border=#343434 shadowRgb=0,0,0 error=#ff6b6b highlight=#e8ff3a accentWarm=#e8ff3a header=transparent card=overlay dark",
    ),
    "exemplar-magazine-editorial@0.1.0": palette(
      "cream=#f7f4ee creamDeep=#ece7dd surface=#fffdf9 sand=#efe9df tile=#efe9df butter=#f1e4c7 ink=#221f1c inkSoft=#5f5952 inkFaint=#9a9189 onInk=#f7f4ee onAccent=#ffffff accent=#2f4a3f border=#dcd4c8 shadowRgb=34,31,28 error=#a8321f highlight=#2f4a3f accentWarm=#b86f4a header=centered card=centered",
    ),
    "exemplar-dense-catalogue@0.1.0": palette(
      "cream=#ffffff creamDeep=#f2f5f2 surface=#ffffff sand=#eef3ee tile=#f6f8f6 butter=#fdf3d8 ink=#1e2b28 inkSoft=#4f5d59 inkFaint=#9aa8a2 onInk=#ffffff onAccent=#ffffff accent=#0f6a3c border=#dfe6e1 shadowRgb=16,43,36 error=#c0392b highlight=#ef5a2a accentWarm=#ef5a2a header=market headerBg=#0f3e38 headerFg=#ffffff",
    ),
    "exemplar-soft-and-natural@0.1.0": palette(
      "cream=#eef1ea creamDeep=#e1e6dc surface=#f7f9f4 sand=#e4e8df tile=#e4e8df butter=#ece6d2 ink=#243127 inkSoft=#4a5a4e inkFaint=#7f8c82 onInk=#f3f6ef onAccent=#ffffff accent=#4f6b55 border=#cfd6cb shadowRgb=36,49,39 error=#a8321f highlight=#4f6b55 accentWarm=#9a6b4f header=stacked card=soft",
    ),
    "exemplar-playful-and-colourful@0.1.0": palette(
      "cream=#fff3e6 creamDeep=#ffe3c8 surface=#fffaf3 sand=#ffe8d1 tile=#ffe3c8 butter=#fff0c2 ink=#2a1f3d inkSoft=#584a70 inkFaint=#8d7ea3 onInk=#fff3e6 onAccent=#ffffff accent=#c43913 border=#f3cfae shadowRgb=42,31,61 error=#c92a2a highlight=#c43913 accentWarm=#ff6b35 header=hamburger",
    ),
    "exemplar-classic-and-trusted@0.1.0": palette(
      "cream=#ffffff creamDeep=#f3f4f6 surface=#ffffff sand=#f3f4f6 tile=#f3f4f6 butter=#fef3c7 ink=#1f2937 inkSoft=#4b5563 inkFaint=#9ca3af onInk=#ffffff onAccent=#ffffff accent=#1d4ed8 border=#e5e7eb shadowRgb=31,41,55 error=#b91c1c highlight=#1d4ed8 accentWarm=#b45309 header=utility card=wide",
    ),
  };
  // Two palettes the design contract allows a Studio theme and the bundled
  // set lacks: a light page with a light accent (dark labels on it) and a
  // dark page with a dark accent (white labels). In both, ink and on-accent
  // are NOT opposites, which is what exposes a fill and a text colour taken
  // from two different pairs (the ink badge with on-accent text).
  const STUDIO = {
    "studio light page, light accent": palette(
      "cream=#faf8f5 creamDeep=#efece9 surface=#ffffff sand=#f1ede6 tile=#efece9 butter=#f6eccf ink=#211c25 inkSoft=#554d59 inkFaint=#9a9399 onInk=#ffffff onAccent=#121212 accent=#e8ff3a border=#cfc9c2 shadowRgb=33,28,37 error=#b3261e highlight=#e8ff3a accentWarm=#e8ff3a",
    ),
    "studio dark page, dark accent": palette(
      "cream=#141414 creamDeep=#1a1a1a surface=#1c1c1c sand=#242424 tile=#1f1f1f butter=#2a2618 ink=#eeeeee inkSoft=#bdbdbd inkFaint=#7a7a7a onInk=#111111 onAccent=#ffffff accent=#2542c7 border=#555555 shadowRgb=0,0,0 error=#ff8a80 highlight=#2542c7 accentWarm=#2542c7 dark",
    ),
  };
  const ALL = { ...BUNDLED, ...STUDIO };
  // designToCssVars (lib/themes/types.ts) for the tokens these surfaces read,
  // written inline on the root as the storefront layout writes them.
  const themeVars = (p) =>
    [
      `--brand-primary:${p.accent}`,
      `--sm-accent:${p.accent}`,
      `--sm-cream:${p.cream}`,
      `--sm-cream-deep:${p.creamDeep}`,
      `--sm-surface:${p.surface}`,
      `--sm-sand:${p.sand}`,
      `--sm-tile:${p.tile}`,
      `--sm-butter:${p.butter}`,
      `--sm-ink:${p.ink}`,
      `--sm-ink-soft:${p.inkSoft}`,
      `--sm-ink-faint:${p.inkFaint}`,
      `--sm-on-ink:${p.onInk}`,
      `--sm-on-accent:${p.onAccent}`,
      `--sm-border:${p.border}`,
      `--sm-shadow-rgb:${p.shadowRgb}`,
      `--sm-error:${p.error}`,
      `--sm-highlight:${p.highlight}`,
      `--sm-accent-warm:${p.accentWarm}`,
      ...(p.headerBg
        ? [`--sm-header-bg:${p.headerBg}`, `--sm-header-fg:${p.headerFg}`]
        : []),
      "--font-outfit:Arial",
      "--font-roboto:Arial",
      "--font-stick-no-bills:Arial",
      "--sm-radius-card:16px",
      "--sm-radius-control:12px",
      "--sm-radius-sm:8px",
      "--sm-radius-pill:999px",
    ].join(";");
  // A ratio below 1:1 is axe saying "unknown" (a gradient, a pseudo-element),
  // not a measurement, so it is never reported as one.
  const keep = (surface, key, ratio, where) => {
    if (typeof ratio !== "number" || ratio < 1) return;
    const entry = (surfaces[surface] ??= {});
    if (!entry[key] || ratio < entry[key].ratio) entry[key] = { ratio, where };
  };
  const audit = async (width, html, height = 900) => {
    await settledPage.setViewportSize({ width, height });
    await settledPage.setContent(html);
    await settledPage.addScriptTag({ content: axe });
    return settledPage.evaluate(async () => {
      const result = await window.axe.run(document, {
        runOnly: { type: "rule", values: ["color-contrast"] },
        elementRef: true,
      });
      const nodes = [];
      for (const [kind, list] of [
        ["fail", result.violations],
        ["pass", result.passes],
        ["unmeasured", result.incomplete],
      ])
        for (const rule of list)
          for (const node of rule.nodes) {
            const data =
              node.any.find((c) => c.id === "color-contrast")?.data ?? {};
            nodes.push({
              kind,
              surface:
                node.element?.closest("[data-s]")?.getAttribute("data-s") ??
                null,
              target: node.target.join(" "),
              ratio: data.contrastRatio ?? null,
              fg: data.fgColor ?? null,
              bg: data.bgColor ?? null,
              needs: data.expectedContrastRatio ?? null,
              ...(kind === "unmeasured"
                ? { why: data.messageKey ?? null }
                : {}),
            });
          }
      return nodes;
    });
  };
  // Every text node must read; a labelled one must also be measurable.
  const expectReadable = async (label, width, html, height) => {
    const nodes = await audit(width, html, height);
    cases++;
    for (const n of nodes)
      if (n.surface && n.kind !== "unmeasured")
        keep(n.surface, "lowest", n.ratio, label);
    const bad = nodes.filter(
      (n) => n.kind === "fail" || (n.kind === "unmeasured" && n.surface),
    );
    if (bad.length) failures.push({ label, width, violations: bad });
  };
  // The broken copy must make expectReadable fail on that surface, as
  // measured when it shipped. axe files text in its own background colour
  // (1:1) as unmeasured, not as a violation, so that counts too.
  const expectBroken = async (label, width, html, surface, matches) => {
    const nodes = await audit(width, html);
    extraControls++;
    const hits = nodes.filter(
      (n) =>
        n.kind !== "pass" && n.surface === surface && (!matches || matches(n)),
    );
    for (const n of hits) keep(surface, "broken", n.ratio, label);
    if (!hits.length)
      failures.push({
        negativeControl: `did not reproduce ${label}`,
        nodes: nodes.filter((n) => n.surface === surface),
      });
  };
  const near =
    (ratio, tolerance = 0.03) =>
    (n) =>
      Math.abs(n.ratio - ratio) <= tolerance;
  const storefront = ({ p, rootClass = "", body, broken = "" }) =>
    `<!doctype html><html lang="en"><head><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial}${SR_ONLY}${SETTLED}
${themeCss}\n${shop}\n${home}
${broken}</style></head><body><div class="storefront-root ${rootClass}" style="${themeVars(p)}">${body}</div></body></html>`;

  // ── Product cards, every skin, home carousel and shop grid ──────────────
  // The 4 Oct "% off" pill (.shop-card-off, 2.58:1 on the dark apparel
  // page) and the classic card's struck MRP (.shop-card-base, the Crave
  // finding), with the photo flags every skin can show and the ink badge.
  // A store's skin is a merchant setting, so every skin meets every palette.
  const SKINS = [
    "classic",
    "framed",
    "centered",
    "soft",
    "wide",
    "grocery",
    "overlay",
  ];
  const skinClass = (skin) =>
    `sm-card-${skin} sm-card-quickadd${skin === "grocery" ? " sm-storefront-grocery" : ""}`;
  const FLAGS = [
    ["save", "Save 20%"],
    ["offer", "Buy 2, get 1"],
    ["lowstock", "Only 3 left"],
    ["soldout", "Sold out"],
  ];
  const card = (flag) =>
    `<a href="#" class="shop-card" style="--card-bg:#f4f2ee"><div class="shop-card-img"><div class="shop-card-img-placeholder"></div>${
      flag
        ? `<span class="shop-card-flag shop-card-flag--${flag[0]}" data-s="card-flag-${flag[0]}">${flag[1]}</span>`
        : `<span class="shop-card-badge" data-s="card-badge">Bestseller</span>`
    }</div><div class="shop-card-body"><div class="shop-card-head"><span class="shop-card-cat">Ceramics</span><h3 class="shop-card-name">Stoneware jug</h3></div><div class="shop-card-price"><span class="shop-card-deal"><span class="shop-card-base" data-s="card-base"><span class="sr-only">Was </span>₹2,400</span></span><span class="shop-card-current"><span class="shop-card-sell shop-card-sell--sale"><span class="sr-only">Now </span>₹1,900</span></span><span class="shop-card-off" data-s="card-off">20% off</span><button type="button" class="shop-card-add">+ Add</button></div></div></a>`;
  // The carousel is laid out in rows here: a card scrolled out of view is
  // one axe calls obscured, and the colours do not depend on the scroll.
  const cardsBody = (withBadge) => {
    const cards = [...FLAGS.map(card), ...(withBadge ? [card(null)] : [])].join(
      "",
    );
    return `<div class="home-sections"><section class="home-section"><div class="home-product-carousel"><div class="home-product-scroll" style="flex-wrap:wrap;overflow:visible">${cards}</div></div></section></div><main class="shop-main shop-listing"><div class="shop-grid">${cards}</div></main>`;
  };
  // ⚠ Overlay draws its copy over the photograph, which axe can only report
  // as unmeasured, so overlay's copy is judged on the card's ink fill with
  // the scrim off, and the badge (inside the photograph, under the copy's
  // box) is left to the other skins.
  const overlayFill =
    ".sm-card-overlay.storefront-root .shop-card-img::after{content:none}";
  for (const [name, p] of Object.entries(ALL))
    for (const skin of SKINS)
      for (const width of [390, 1440])
        await expectReadable(
          `cards/${name}/${skin}`,
          width,
          storefront({
            p,
            rootClass: skinClass(skin),
            body: cardsBody(skin !== "overlay"),
            broken: skin === "overlay" ? overlayFill : "",
          }),
          2400,
        );
  // Before 2026-10-04 the classic struck MRP was ink-faint (the Crave
  // finding); Vitrine ships the classic card.
  await expectBroken(
    "the classic card's ink-faint struck price (Crave, 2026-10-04)",
    390,
    storefront({
      p: BUNDLED["vitrine@0.1.0"],
      rootClass: skinClass("classic"),
      body: cardsBody(true),
      broken:
        ".sm-card-classic.storefront-root .shop-card .shop-card-base{color:var(--sm-ink-faint)}",
    }),
    "card-base",
  );
  // The badge rules filled the badge with INK and wrote it in ON-ACCENT:
  // two different pairs, readable only while ink and on-accent are
  // opposites. Neither Studio palette above keeps them so.
  for (const name of Object.keys(STUDIO))
    await expectBroken(
      `the ink badge's on-accent text (${name})`,
      390,
      storefront({
        p: STUDIO[name],
        rootClass: skinClass("framed"),
        body: cardsBody(true),
        broken:
          ".home-product-carousel .shop-card-badge,.shop-listing .shop-card-badge{color:var(--sm-on-accent)}",
      }),
      "card-badge",
    );
  // The save flag wrote white on the sale colour. A dark palette's sale
  // colour must read on its dark surface (the low-stock flag), so white on
  // it cannot also read: 2.77:1 on bold-and-loud under a classic skin.
  await expectBroken(
    "the save flag's white on a dark palette's sale colour",
    390,
    storefront({
      p: BUNDLED["exemplar-bold-and-loud@0.1.0"],
      rootClass: skinClass("classic"),
      body: cardsBody(true),
      broken: ".shop-card-flag--save{color:#fff}",
    }),
    "card-flag-save",
    near(2.77),
  );

  // ── The quick-add dialog's struck price (quick_add cards) ───────────────
  const quickAddBody = `<div class="sm-quickadd"><div class="sm-quickadd-panel" role="dialog" aria-modal="true" aria-label="Choose options for Stoneware jug"><button type="button" class="sm-quickadd-close" aria-label="Close"></button><div class="sm-quickadd-head"><div class="sm-quickadd-img"></div><div><p class="sm-quickadd-name">Stoneware jug</p><p class="sm-quickadd-price" data-s="quickadd-price">₹1,900<span class="sm-quickadd-was" data-s="quickadd-was">₹2,400</span></p></div></div><a href="#" class="sm-quickadd-details">View full details</a></div></div>`;
  for (const [name, p] of Object.entries(ALL))
    for (const width of [390, 1024])
      await expectReadable(
        `quick-add/${name}`,
        width,
        storefront({ p, rootClass: skinClass(p.card), body: quickAddBody }),
      );
  await expectBroken(
    "the quick-add dialog's ink-faint struck price (Basket)",
    390,
    storefront({
      p: BUNDLED["basket@1.0.0"],
      rootClass: skinClass("grocery"),
      body: quickAddBody,
      broken: ".sm-quickadd-was{color:var(--sm-ink-faint)}",
    }),
    "quickadd-was",
    near(2.47),
  );

  // ── Product page: eyebrow, struck price, variant prices, photo counter ──
  // The PIN-code delivery card both product pages carry: before a check (its
  // hint), with a courier's answer, and with a refusal. Its Check button stays
  // disabled, as it is until a PIN is typed; enabled, its label is the
  // theme's accent pair, which the design contract governs, not shared CSS.
  const deliveryCards = `<section class="pdp-delivery" aria-label="Delivery details" data-s="pdp-delivery"><div class="pdp-delivery-heading"><svg width="19" height="19" aria-hidden="true"></svg><strong>Delivery details</strong></div><form class="pdp-delivery-form"><svg width="18" height="18" aria-hidden="true"></svg><input placeholder="Enter delivery PIN code" aria-label="Delivery PIN code"><button type="submit" disabled>Check</button></form><p class="pdp-delivery-hint">Check availability, shipping charge and estimated delivery time.</p></section><section class="pdp-delivery" aria-label="Delivery to 560001" data-s="pdp-delivery"><div class="pdp-delivery-result is-available"><svg width="18" height="18" aria-hidden="true"></svg><div><strong>Arrives by Tue, 28 Oct</strong><span>Free delivery · Delhivery</span></div></div></section><section class="pdp-delivery" aria-label="No delivery to 560001" data-s="pdp-delivery-error"><div class="pdp-delivery-result is-unavailable"><svg width="18" height="18" aria-hidden="true"></svg><div><strong>We do not deliver to 560001 yet.</strong></div></div></section>`;
  const pdpBody = `<main class="shop-main pdp-page"><div class="pdp-grid"><div class="pdp-gallery sm-gallery mode-carousel"><div class="sm-gallery-frame"><div class="sm-gallery-track is-multi">${[
    1, 2, 3,
  ]
    .map(
      (i) =>
        `<button class="pdp-main-img sm-gallery-slide" data-active="${i === 1}" aria-label="Zoom photo ${i} of 3" style="background:#ffffff"></button>`,
    )
    .join(
      "",
    )}</div><span class="sm-gallery-count" aria-live="polite" data-s="gallery-count">1 / 3</span></div></div><div class="pdp-info"><span class="pdp-category" data-s="pdp-category">Ceramics</span><div><span class="sm-offer-badge" data-s="offer-badge">Buy 2, get 1 free</span></div><h1 class="pdp-name">Stoneware jug</h1><div class="pdp-price"><span class="pdp-price-sell">₹1,800</span><span class="pdp-price-base" data-s="pdp-price-base">₹2,400</span><span class="pdp-price-off" data-s="pdp-price-off">25% OFF</span></div><div class="pdp-variants"><label class="pdp-variants-label">Options</label><div class="pdp-variant-options">${[
    ["active", "Small", "₹1,800", "₹2,400"],
    ["", "Large", "₹2,800", "₹3,200"],
    ["has-sale", "Pair", "₹3,000", "₹4,800"],
  ]
    .map(
      ([state, label, now, was]) =>
        `<button class="pdp-variant ${state}">${state === "has-sale" ? '<span class="pdp-variant-badge" data-s="pdp-variant-badge">Best value</span>' : ""}<span class="pdp-variant-name">${label}</span><span class="pdp-variant-price">${now}<span class="pdp-variant-was" data-s="pdp-variant-was">${was}</span></span></button>`,
    )
    .join("")}</div></div>${deliveryCards}</div></div></main>`;
  for (const [name, p] of Object.entries(ALL))
    for (const width of [390, 1440])
      await expectReadable(
        `pdp/${name}`,
        width,
        storefront({ p, rootClass: skinClass(p.card), body: pdpBody }),
        2400,
      );
  // The grocery product page, which a merchant can pick on any theme (the
  // Website Builder's product page setting), so it meets every palette. Its
  // purchase card is BUTTER, a colour the design contract pairs with ink-soft
  // only for a grocery storefront.
  const groceryPdpBody = `<main class="shop-main pdp-page"><div class="gpdp-grid"><div class="gpdp-info"><span class="gpdp-category" data-s="gpdp-category">Pantry</span><div><span class="sm-offer-badge" data-s="offer-badge">Buy 2, get 1 free</span></div><h1 class="gpdp-name">Stone-ground flour</h1><a href="#reviews" class="gpdp-rating" data-s="gpdp-rating"><span><strong>4.6</strong> · 12 reviews</span></a><div class="gpdp-buybox"><div class="gpdp-price"><span class="gpdp-price-sell">₹180</span><span class="gpdp-price-base" data-s="gpdp-price-base">₹240</span><span class="gpdp-price-off" data-s="gpdp-price-off">25% off</span></div><p class="gpdp-price-note" data-s="gpdp-price-note">Inclusive of all taxes</p><div class="gpdp-variants"><button class="gpdp-variant active">1 kg<span class="gpdp-variant-tag" data-s="gpdp-variant-tag">Deal</span></button><button class="gpdp-variant">5 kg<span class="gpdp-variant-tag" data-s="gpdp-variant-tag">Deal</span></button></div>${deliveryCards}<div class="gpdp-trust" data-s="gpdp-trust"><span><svg width="16" height="16" aria-hidden="true"></svg> PIN-code delivery</span><span><svg width="16" height="16" aria-hidden="true"></svg> Easy returns</span><span><svg width="16" height="16" aria-hidden="true"></svg> Farm sourced</span></div></div></div></div></main>`;
  for (const [name, p] of Object.entries(ALL))
    for (const width of [390, 1440])
      await expectReadable(
        `grocery-pdp/${name}`,
        width,
        storefront({
          p,
          rootClass: skinClass("grocery"),
          body: groceryPdpBody,
        }),
        2400,
      );
  // 4 Oct, the botanical beauty build: the struck price in ink-faint
  // #6f8273 on its sage page #cbd6bf, 2.71:1 (benchmark JSON).
  await expectBroken(
    "the product page's ink-faint struck price (beauty-a, 2026-10-04)",
    390,
    storefront({
      p: {
        ...BUNDLED.default,
        cream: "#cbd6bf",
        creamDeep: "#bfcbb2",
        surface: "#f4f6f1",
        ink: "#1f2a22",
        inkSoft: "#3c4a40",
        inkFaint: "#6f8273",
      },
      body: pdpBody,
      broken: ".pdp-price-base{color:var(--shop-text-faint)}",
    }),
    "pdp-price-base",
    (n) => n.fg === "#6f8273" && n.bg === "#cbd6bf" && near(2.71)(n),
  );
  // 10 Oct, the magazine exemplar: the variant list's ink-faint MRP, 2.9:1.
  await expectBroken(
    "the variant list's ink-faint struck price (magazine, 2026-10-10)",
    390,
    storefront({
      p: BUNDLED["exemplar-magazine-editorial@0.1.0"],
      body: pdpBody,
      broken: ".pdp-variant-was{color:var(--shop-text-faint)}",
    }),
    "pdp-variant-was",
  );
  // 10 Oct, the playful exemplar, whose accent was #d6451d until its own
  // button fix deepened it: the accent as a 12px eyebrow read 4.06:1.
  const playful10Oct = {
    ...BUNDLED["exemplar-playful-and-colourful@0.1.0"],
    accent: "#d6451d",
  };
  await expectBroken(
    "the product page's accent eyebrow (playful, 2026-10-10)",
    390,
    storefront({
      p: playful10Oct,
      body: pdpBody,
      broken: ".pdp-category{color:var(--shop-accent)}",
    }),
    "pdp-category",
    near(4.06),
  );
  // The photo counter's pill was tinted with the theme's shadow colour.
  // Its exact opacity is not recorded anywhere in the tree, so this copy
  // is illustrative: a theme-tinted wash under the white count, over a
  // white photo, on the sage palette where it was found.
  await expectBroken(
    "the photo counter's theme-tinted pill (sage, 2026-10-10)",
    390,
    storefront({
      p: BUNDLED["exemplar-soft-and-natural@0.1.0"],
      body: pdpBody,
      broken:
        ".sm-gallery.mode-carousel .sm-gallery-count,.sm-gallery-count{background:rgba(var(--sm-shadow-rgb),0.35)}",
    }),
    "gallery-count",
  );
  // The offer badge wrote on-accent on the WARM accent, two colours the
  // design contract never pairs: 2.91:1 on the default palette, which every
  // store without a theme wears.
  await expectBroken(
    "the offer badge's on-accent on the warm accent (default palette)",
    390,
    storefront({
      p: BUNDLED.default,
      body: pdpBody,
      broken:
        ".sm-offer-badge{background:var(--sm-accent-warm,#f3f4f6);color:var(--sm-on-accent,#111827)}",
    }),
    "offer-badge",
    near(2.91),
  );
  // The sale option's "Best value" badge wrote on-accent over a gradient of
  // the highlight, which axe can only report as unmeasured; at the
  // gradient's light end the pair read 1.16:1 on Ritual. Its shine, parked
  // off the pill under reduced motion, hid the text from axe as well.
  const bestValueGradient =
    ".pdp-variant-badge{color:var(--sm-on-accent);background:linear-gradient(135deg,color-mix(in srgb,var(--sm-highlight) 72%,#fff) 0%,var(--sm-highlight) 55%,color-mix(in srgb,var(--sm-highlight) 82%,#000) 100%)}";
  await expectBroken(
    "the Best value badge's on-accent over the highlight gradient (Ritual)",
    390,
    storefront({
      p: BUNDLED["ritual@0.1.0"],
      body: pdpBody,
      broken: bestValueGradient,
    }),
    "pdp-variant-badge",
    (n) => n.kind === "unmeasured" && n.why === "bgGradient",
  );
  await expectBroken(
    "the Best value badge's on-accent at the gradient's light end (Ritual)",
    390,
    storefront({
      p: BUNDLED["ritual@0.1.0"],
      body: pdpBody,
      broken:
        ".pdp-variant-badge{color:var(--sm-on-accent);background:color-mix(in srgb,var(--sm-highlight) 72%,#fff)}",
    }),
    "pdp-variant-badge",
    near(1.16),
  );
  await expectBroken(
    "the Best value badge's parked shine under reduced motion",
    390,
    storefront({
      p: BUNDLED["ritual@0.1.0"],
      body: pdpBody,
      broken: '.pdp-variant-badge::after{content:""}',
    }),
    "pdp-variant-badge",
    (n) => n.kind === "unmeasured" && n.why === "pseudoContent",
  );
  // The grocery purchase card's tax note and trust row were ink-soft on its
  // butter: 3.76:1 on Studio's.
  for (const [surface, what, rule] of [
    [
      "gpdp-price-note",
      "tax note",
      ".sm-storefront-grocery .gpdp-price-note{color:var(--sm-ink-soft)}",
    ],
    [
      "gpdp-trust",
      "trust row",
      ".sm-storefront-grocery .gpdp-trust span{color:var(--sm-ink-soft)}",
    ],
  ])
    await expectBroken(
      `the grocery purchase card's ink-soft ${what} (Studio's butter)`,
      390,
      storefront({
        p: BUNDLED["studio@0.1.0"],
        rootClass: skinClass("grocery"),
        body: groceryPdpBody,
        broken: rule,
      }),
      surface,
      near(3.76),
    );
  // The delivery card's refusal was a fixed #b42318, as the drawer panel's
  // error line was, and no capture types a PIN code to see it: 2.67:1 on
  // bold-and-loud's product page (2.53:1 in the grocery purchase card).
  await expectBroken(
    "the delivery card's fixed red refusal on a dark palette",
    390,
    storefront({
      p: BUNDLED["exemplar-bold-and-loud@0.1.0"],
      body: pdpBody,
      broken: ".pdp-delivery-result.is-unavailable{color:#b42318}",
    }),
    "pdp-delivery-error",
    near(2.67),
  );

  // ── Home hero badge, plain and offset (10 Oct: the accent, 4.0:1) ───────
  const heroBadgeBody = `<div class="home-sections"><section class="home-section"><div class="home-hero variant-split theme-dark"><div class="home-hero-copy"><span class="home-hero-badge" data-s="hero-badge">New season</span></div></div></section><section class="home-section"><div class="home-hero variant-offset theme-dark"><div class="home-hero-copy"><span class="home-hero-badge" data-s="hero-badge">New season</span></div></div></section></div>`;
  for (const [name, p] of Object.entries(ALL))
    for (const width of [390, 1440])
      await expectReadable(
        `hero-badge/${name}`,
        width,
        storefront({ p, body: heroBadgeBody }),
        1600,
      );
  await expectBroken(
    "the hero badge in the accent (playful, 2026-10-10)",
    390,
    storefront({
      p: playful10Oct,
      body: heroBadgeBody,
      broken: ".home-hero-badge{color:var(--sm-accent)}",
    }),
    "hero-badge",
  );

  // ── Shop promo tiles: the field follows the copy (10 Oct, 1.1:1) ────────
  const promoBody = (p) =>
    `<main class="shop-main shop-listing"><div class="shop-grid">${[
      ["dark", ""],
      ["light", ""],
      ["dark", ` style="background:${p.creamDeep}"`],
    ]
      .map(
        ([copy, field]) =>
          `<a href="#" class="shop-promo-tile theme-${copy}"${field} data-s="promo-tile"><div class="shop-promo-tile-copy"><h2>The summer edit</h2><p>Light layers for long evenings.</p><span class="shop-promo-tile-cta">Shop the edit</span></div></a>`,
      )
      .join("")}</div></main>`;
  for (const [name, p] of Object.entries(ALL))
    await expectReadable(
      `promo-tile/${name}`,
      1024,
      storefront({ p, body: promoBody(p) }),
      1600,
    );
  await expectBroken(
    "the promo tile's dark copy read as a dark field (magazine, 2026-10-10)",
    1024,
    storefront({
      p: BUNDLED["exemplar-magazine-editorial@0.1.0"],
      body: promoBody(BUNDLED["exemplar-magazine-editorial@0.1.0"]),
      broken: ".shop-promo-tile.theme-dark{color:var(--sm-on-ink)}",
    }),
    "promo-tile",
    (n) => n.ratio < 1.3,
  );

  // ── Account menu, signed out and signed in; the sign-in dialog ──────────
  // A gradient is unmeasurable, so each avatar is measured on both of its
  // gradient's ends (ink and ink-soft), the worst case for its initials.
  const accountDoc = (p, signedIn, broken = "") =>
    `<!doctype html><html lang="en"><head><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial}${SETTLED}
.storefront-root{background:var(--sm-cream);color:var(--sm-ink);min-height:640px}
${headerCss}
.menuHost{position:relative;height:600px}
${broken}</style></head><body><div class="storefront-root" style="${themeVars(p)}"><div class="menuHost"><div class="profileDropdown" id="profile-dropdown" role="menu">${
      signedIn
        ? `<div class="profileDropdownHeader"><span class="profileDropdownAvatar" style="background:var(--sm-ink)" data-s="account-avatar">AK</span><span class="profileDropdownAvatar" style="background:var(--sm-ink-soft)" data-s="account-avatar">AK</span><div class="profileDropdownInfo"><span class="profileDropdownName">Asha Kumar</span><span class="profileDropdownPhone" data-s="account-phone">+91 98765 43210</span></div></div>`
        : `<div class="profileDropdownLogin"><div class="profileDropdownLoginText"><span class="profileDropdownLoginSub" data-s="account-login-sub">Sign in to access your profile, orders, and more!</span></div><button class="profileDropdownLoginBtn" role="menuitem">Login/Sign Up</button></div>`
    }<div class="profileDropdownDivider"></div><a href="#" class="profileDropdownItem" role="menuitem" data-s="account-item">My Profile</a><a href="#" class="profileDropdownItem" role="menuitem" data-s="account-item">Track Order</a>${
      signedIn
        ? `<button class="profileDropdownItem" role="menuitem" data-s="account-item">Log out</button>`
        : ""
    }</div></div></div></body></html>`;
  for (const [name, p] of Object.entries(ALL))
    for (const signedIn of [false, true])
      await expectReadable(
        `account-menu/${name}/${signedIn ? "signed-in" : "signed-out"}`,
        390,
        accountDoc(p, signedIn),
      );
  // 10 Oct, item 9: the login line in ink-faint at 11.5px, 2.96:1 on white.
  await expectBroken(
    "the account menu's ink-faint login line (2026-10-10)",
    390,
    accountDoc(
      BUNDLED.default,
      false,
      ".profileDropdownLoginSub{color:var(--sm-ink-faint)}",
    ),
    "account-login-sub",
    near(2.96),
  );
  // The signed-in phone line, which no capture sees (a preview has no
  // signed-in shopper): ink-faint at 12px, 2.96:1 on the default palette.
  await expectBroken(
    "the signed-in account menu's ink-faint phone line",
    390,
    accountDoc(
      BUNDLED.default,
      true,
      ".profileDropdownPhone{color:var(--sm-ink-faint)}",
    ),
    "account-phone",
    near(2.96),
  );
  const signInDoc = (p) =>
    `<!doctype html><html lang="en"><head><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial}${SETTLED}
${authCss}
</style></head><body><div class="storefront-root" style="${themeVars(p)}"><div class="overlay overlayVisible"><div class="modal" data-s="sign-in"><p class="subtitle">Sign in with your mobile number to continue</p><p class="secondaryAction">Didn't get the code? <button class="backBtn">Resend</button></p><div class="divider"><span>or</span></div></div></div></div></body></html>`;
  for (const [name, p] of Object.entries(ALL))
    await expectReadable(`sign-in/${name}`, 390, signInDoc(p));

  // ── Phone drawers, light and dark ────────────────────────────────────────
  // The drawer is a PAGE surface whatever the bar does. Each palette opens
  // it under its own header, the classic one, the market bar (its own bar
  // colours, else the ink/on-ink fallback a merchant gets by switching) and
  // the transparent header over an opening that turns the bar's controls
  // on-ink; signed out and signed in; the delivery panel open with its
  // error line. The avatar is measured on both gradient ends.
  const drawerDoc = (p, variant, signedIn, broken = "") =>
    `<!doctype html><html lang="en"><head><style>
*{box-sizing:border-box}body{margin:0;font:16px Arial}${SETTLED}
.storefront-root{min-height:100vh;background:var(--sm-cream);color:var(--sm-ink)}
${headerCss}\n${delivery}
.hamburgerBtn{display:flex!important}.drawerRoot{display:block!important}
${broken}</style></head><body><div class="storefront-root sm-header-${variant}" style="${themeVars(p)}">
<header class="header">
 <div class="headerLeft"><a class="logo" href="#"><span class="brandNameText">Roastery</span></a></div>
 <div class="headerRight"><button class="hamburgerBtn" aria-label="Open Menu"></button></div>
 <div class="mobileDrawer drawerOpen" data-sm="menu-drawer">
  <div class="drawerHeader"><a class="logo" href="#"><span class="brandNameText" data-s="drawer-brand">Roastery</span></a><button class="closeBtn" aria-label="Close Menu"></button></div>
  <div class="root drawerRoot"><button type="button" class="trigger" aria-haspopup="dialog" aria-expanded="true" data-s="drawer-delivery"><svg width="18" height="18" aria-hidden="true"></svg><span class="triggerCopy"><small>Deliver to</small><strong>Select location</strong></span><svg width="15" height="15" aria-hidden="true"></svg></button><div class="panel" role="dialog" aria-label="Delivery location" data-s="delivery-panel"><strong class="title">Choose delivery location</strong><p class="help">Enter a PIN code to see availability, charges and delivery time.</p><form class="form"><input value="560001" aria-label="Delivery PIN code"><button type="submit">Apply</button></form><button type="button" class="locate" data-s="delivery-locate"><svg width="16" height="16" aria-hidden="true"></svg>Use my current location</button><p class="error" data-s="delivery-error">Location access is blocked. Enter a PIN code instead.</p></div></div>
  <nav class="drawerNav" aria-label="Menu" data-s="drawer-nav"><a href="#">Shop</a><button type="button" class="drawerNavParent" aria-haspopup="true"><span>Collections</span></button><div class="drawerLevelHead drawerLevelIn"><button type="button" class="drawerBack">Back</button><p class="drawerLevelTitle">Coffee</p><a href="#" class="drawerViewAll">View all Coffee</a></div><a href="#" class="drawerLevelIn">Single origin</a></nav>
  <div class="drawerAuth" data-s="drawer-auth">${
    signedIn
      ? `<div class="drawerAuthUser"><span class="drawerAuthAvatar" style="background:var(--sm-ink)">AK</span><span class="drawerAuthAvatar" style="background:var(--sm-ink-soft)">AK</span><span class="drawerAuthName">Asha Kumar</span></div><a href="#" class="drawerAuthBtn" style="margin-bottom:12px;display:block">Profile</a><button class="drawerAuthBtn">Log out</button>`
      : `<button class="drawerAuthBtn">Sign in</button>`
  }</div>
 </div>
 <div class="drawerOverlay overlayVisible"></div>
</header>${
      variant === "transparent"
        ? `<div class="home-sections"><section class="home-section"><div class="home-hero theme-light" style="height:420px;background:${p.dark ? "#f0f0f0" : "#1c1c1c"}"></div></section></div>`
        : ""
    }</div></body></html>`;
  for (const [name, p] of Object.entries(ALL))
    for (const variant of new Set([
      p.header,
      "classic",
      "market",
      "transparent",
    ]))
      for (const signedIn of [false, true])
        await expectReadable(
          `drawer/${name}/${variant}/${signedIn ? "signed-in" : "signed-out"}`,
          390,
          drawerDoc(p, variant, signedIn),
        );
  // 8 Oct: the market rule coloured the brand name wherever it rendered, so
  // a light bar over a dark palette put #1b1b1b on the #1c1c1c drawer, 1.01:1.
  // Then the 4 Oct inheritance in both directions: a light bar's dark text
  // in a dark drawer, and a dark bar's white text in a light drawer (Basket
  // is the roastery's shape: a light page under a dark market bar).
  await expectBroken(
    "the market bar's colour on the drawer's brand name (2026-10-08)",
    390,
    drawerDoc(
      {
        ...STUDIO["studio dark page, dark accent"],
        headerBg: "#f3efe8",
        headerFg: "#1b1b1b",
      },
      "market",
      false,
      ".sm-header-market .mobileDrawer .brandNameText{color:var(--sm-header-fg,var(--sm-on-ink))}",
    ),
    "drawer-brand",
    near(1.01),
  );
  await expectBroken(
    "a light market bar's dark text inherited by the dark drawer's delivery trigger",
    390,
    drawerDoc(
      {
        ...STUDIO["studio dark page, dark accent"],
        headerBg: "#f3efe8",
        headerFg: "#1b1b1b",
      },
      "market",
      false,
      drawerNegative,
    ),
    "drawer-delivery",
    (n) => n.fg === "#1b1b1b",
  );
  await expectBroken(
    "a dark market bar's white text inherited by a light drawer (Basket)",
    390,
    drawerDoc(BUNDLED["basket@1.0.0"], "market", false, drawerNegative),
    "drawer-delivery",
    (n) => n.fg === "#ffffff",
  );
  // The delivery panel opens from the drawer and from the bar, and no
  // capture opens it. Its "Use my current location" link was the ACCENT as
  // 13px text, which the contract holds to 3:1 only as a fill: 3.40:1 on
  // Basket. Its error line was a fixed #b42318: 2.64:1 on a dark surface.
  await expectBroken(
    "the delivery panel's accent link (Basket)",
    390,
    drawerDoc(
      BUNDLED["basket@1.0.0"],
      "market",
      false,
      ".locate{color:var(--sm-accent,var(--brand-primary))}",
    ),
    "delivery-locate",
    near(3.4),
  );
  await expectBroken(
    "the delivery panel's fixed red error line on a dark drawer",
    390,
    drawerDoc(
      BUNDLED["exemplar-bold-and-loud@0.1.0"],
      "classic",
      false,
      ".error{color:#b42318}",
    ),
    "delivery-error",
    near(2.64),
  );
} finally {
  await browser.close();
}
console.log(
  JSON.stringify(
    {
      cases,
      negativeControls: 9 + extraControls,
      failures,
      surfaces: Object.fromEntries(
        Object.entries(surfaces).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
