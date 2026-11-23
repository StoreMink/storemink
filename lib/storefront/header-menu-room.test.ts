import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_TYPE,
  CENTRED_COLUMN_GAP,
  CENTRED_MIN_WIDTH,
  CHEVRON_WIDTH,
  HEADER_PADDING_X,
  LOGO_ALLOWANCE,
  NAV_LINK_TYPE,
  SCROLLBAR_ALLOWANCE,
  centredLinkGap,
  centredMenuRoom,
  headerPaddingX,
  menuWidth,
} from "./header-menu-room";

const css = readFileSync(
  "app/(storefront)/components/header/Header.module.css",
  "utf8",
);
const nav = readFileSync(
  "app/(storefront)/components/header/desktop-nav.tsx",
  "utf8",
);
const header = readFileSync(
  "app/(storefront)/components/header/Header.jsx",
  "utf8",
);
/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string, within = css): string {
  const at = within.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return within.slice(at, within.indexOf("}", at));
}
const centredBlock = css.slice(
  css.indexOf(":global(.sm-header-centered) .header {"),
  css.indexOf(":global(.sm-header-minimal) .header {"),
);

describe("★ every number is the header stylesheet's own (Header.module.css)", () => {
  // Theme Studio plans a centred theme's menu with these numbers before
  // anything is rendered; a change to the CSS that is not made here would
  // plan menus for a header that no longer exists.
  it("the header's padding, and the page width's padding", () => {
    expect(rule(".header")).toContain(`padding: 12px ${HEADER_PADDING_X}px;`);
    expect(css).toMatch(
      /:global\(\.sm-page-width\) \.header \{\s*padding-inline: max\(\s*clamp\(20px, 5vw, 64px\),\s*calc\(\(100% - var\(--sm-page-width\)\) \/ 2\)\s*\);/,
    );
    expect(headerPaddingX(1025, undefined)).toBe(24);
    expect(headerPaddingX(1025, "standard")).toBeCloseTo(51.25, 6);
    expect(headerPaddingX(1440, "narrow")).toBeCloseTo((1425 - 1080) / 2, 6);
    expect(headerPaddingX(2000, "full")).toBe(64);
  });

  it("the centred grid: from 1025px, equal side columns 24px from the logo, links clamp(18px, 2.4vw, 36px) apart", () => {
    expect(css).toMatch(
      /@media \(min-width: 1025px\) \{\s*:global\(\.sm-header-centered\) \.header \{/,
    );
    expect(CENTRED_MIN_WIDTH).toBe(1025);
    expect(centredBlock).toContain(
      "grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);",
    );
    expect(centredBlock).toContain(`gap: ${CENTRED_COLUMN_GAP}px;`);
    expect(
      rule(":global(.sm-header-centered) .navLinks", centredBlock),
    ).toContain("gap: clamp(18px, 2.4vw, 36px);");
    expect(centredLinkGap(1025)).toBeCloseTo(24.6, 6);
    expect(centredLinkGap(500)).toBe(18);
    expect(centredLinkGap(2000)).toBe(36);
  });

  it("the link's type, the store name's type and a submenu's chevron", () => {
    const link = rule(".navLinks a");
    expect(link).toContain(`font-weight: ${NAV_LINK_TYPE.weight};`);
    expect(link).toContain(`font-size: ${NAV_LINK_TYPE.sizePx}px;`);
    expect(link).not.toContain("letter-spacing");
    expect(link).not.toContain("text-transform");
    const trigger = rule(".navTrigger");
    expect(trigger).toContain(`font-weight: ${NAV_LINK_TYPE.weight};`);
    expect(trigger).toContain(`font-size: ${NAV_LINK_TYPE.sizePx}px;`);
    expect(trigger).toContain("gap: 4px;");
    expect(nav).toMatch(/<ChevronDown\s+size=\{15\}/);
    expect(CHEVRON_WIDTH).toBe(19);
    const brand = rule(".brandNameText");
    expect(brand).toContain(`font-weight: ${BRAND_TYPE.weight};`);
    expect(brand).toContain(`font-size: ${BRAND_TYPE.sizePx}px;`);
    expect(brand).toContain(`letter-spacing: ${BRAND_TYPE.letterSpacingEm}em;`);
    // Both read the theme's body font.
    expect(link).toContain("font-family: var(--font-outfit)");
    expect(brand).toContain("font-family: var(--font-outfit)");
    // The logo image is at most 160px wide.
    expect(header).toContain(`maxWidth: "${LOGO_ALLOWANCE}px"`);
  });
});

describe("centredMenuRoom", () => {
  it("is the left column, plus the column gap less the fit's 12px of clear space, at 1025px beside a scrollbar", () => {
    // 1025 - 15 = 1010 wide; 24px padding; 160px logo; two 24px gaps.
    const column = (1010 - 48 - 48 - 160) / 2;
    expect(centredMenuRoom({ logoWidth: 100 })).toBe(
      Math.floor(column + 24 - 12),
    );
    expect(SCROLLBAR_ALLOWANCE).toBe(15);
  });

  it("gives a longer store name and a page width's padding less room, and a wider screen more", () => {
    const base = centredMenuRoom({ logoWidth: 0 });
    expect(centredMenuRoom({ logoWidth: 260 })).toBe(base - 50);
    expect(centredMenuRoom({ logoWidth: 0, pageWidth: "standard" })).toBe(
      Math.floor(base - (51.25 - 24)),
    );
    // 1440: the content is the standard 1240px page.
    expect(
      centredMenuRoom({
        logoWidth: 0,
        windowWidth: 1440,
        pageWidth: "standard",
      }),
    ).toBe(Math.floor((1240 - 48 - 160) / 2 + 12));
  });
});

describe("menuWidth", () => {
  it("adds the links, a chevron for each submenu and the gaps between them", () => {
    const gap = centredLinkGap(1025);
    expect(
      menuWidth([
        { width: 40, submenu: true },
        { width: 70, submenu: false },
        { width: 60, submenu: false },
      ]),
    ).toBeCloseTo(40 + 19 + 70 + 60 + 2 * gap, 6);
    expect(menuWidth([])).toBe(0);
  });
});
