// ---------------------------------------------------------------------------
// The room the centred-logo header leaves for its menu, as a number.
//
// WHY. The centred header (≥1025px) is a three-column grid: the menu in the
// left column, the logo in the middle, the controls on the right, the two
// side columns always equal. A menu wider than its column runs into the logo,
// and the header then moves it to a row of its own (header-fit.ts "stack").
// Theme Studio plans a theme's menu to fit beside the logo instead (owner,
// 23 Nov 2026), so it needs the column's width before anything is rendered.
//
// ★ EVERY NUMBER HERE IS A RULE IN Header.module.css, and
//   `header-menu-room.test.ts` reads that file and fails when one changes:
//   the header's 24px side padding (or the page width's padding on a theme
//   that sets one), the grid's 24px column gap, the menu's
//   clamp(18px, 2.4vw, 36px) link gap, the link and store-name type, and the
//   4px + 15px chevron of a link that opens a submenu.
// ★ MEASURED WHERE IT IS TIGHTEST: 1025px, the narrowest screen that gets the
//   centred layout, less a 15px scrollbar (a fixed header is as wide as the
//   page beside the scrollbar, while the media query and `vw` count the
//   whole window). A menu that fits there fits on every wider screen.
// ★ THE LOGO IS AT LEAST 160px (the logo image's own maximum): a theme's
//   preview shows its short name, a store shows its own, usually longer.
// Pure: the fit itself (header-fit.ts) still measures the real page.
// ---------------------------------------------------------------------------

import { MIN_ITEM_GAP } from "./header-fit";
import { PAGE_WIDTH_VALUE, type PageWidth } from "@/lib/themes/page";

/** The narrowest window the centred layout is drawn at. */
export const CENTRED_MIN_WIDTH = 1025;
/** A classic scrollbar beside the page (macOS overlay scrollbars take 0). */
export const SCROLLBAR_ALLOWANCE = 15;
/** The header's side padding with no page width set. */
export const HEADER_PADDING_X = 24;
/** The centred grid's gap between its three columns. */
export const CENTRED_COLUMN_GAP = 24;
/** The least room planned for the logo. */
export const LOGO_ALLOWANCE = 160;
/** A submenu link's chevron: its 4px gap and 15px icon. */
export const CHEVRON_WIDTH = 4 + 15;

/** The menu link's own type (`.navLinks a`, `.navTrigger`). */
export const NAV_LINK_TYPE = {
  weight: 600,
  sizePx: 15,
  letterSpacingEm: 0,
} as const;
/** The store name in the header (`.brandNameText`). */
export const BRAND_TYPE = {
  weight: 800,
  sizePx: 24,
  letterSpacingEm: -0.02,
} as const;

const clamp = (min: number, value: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** The gap between two menu links in the centred header at `windowWidth`. */
export function centredLinkGap(windowWidth: number): number {
  return clamp(18, 0.024 * windowWidth, 36);
}

/** The header's side padding at `windowWidth` (desktop rules). */
export function headerPaddingX(
  windowWidth: number,
  pageWidth: PageWidth | undefined,
): number {
  if (!pageWidth) return HEADER_PADDING_X;
  const header = windowWidth - SCROLLBAR_ALLOWANCE;
  const value = PAGE_WIDTH_VALUE[pageWidth];
  const contained = value.endsWith("px")
    ? (header - Number.parseFloat(value)) / 2
    : 0; // "full": 100% of the header, so no margin of its own
  return Math.max(clamp(20, 0.05 * windowWidth, 64), contained);
}

/**
 * The widest the menu may be beside the centred logo at `windowWidth`
 * before it runs into it (the left column, plus the column gap less the
 * fit's own 12px of clear space).
 */
export function centredMenuRoom(options: {
  windowWidth?: number;
  pageWidth?: PageWidth;
  logoWidth: number;
}): number {
  const windowWidth = options.windowWidth ?? CENTRED_MIN_WIDTH;
  const header = windowWidth - SCROLLBAR_ALLOWANCE;
  const content = header - 2 * headerPaddingX(windowWidth, options.pageWidth);
  const logo = Math.max(options.logoWidth, LOGO_ALLOWANCE);
  const column = (content - 2 * CENTRED_COLUMN_GAP - logo) / 2;
  return Math.floor(column + CENTRED_COLUMN_GAP - MIN_ITEM_GAP);
}

/** How wide a menu of these link widths is, gaps and chevrons included. */
export function menuWidth(
  links: readonly { width: number; submenu: boolean }[],
  windowWidth: number = CENTRED_MIN_WIDTH,
): number {
  if (!links.length) return 0;
  const text = links.reduce(
    (sum, link) => sum + link.width + (link.submenu ? CHEVRON_WIDTH : 0),
    0,
  );
  return text + (links.length - 1) * centredLinkGap(windowWidth);
}
