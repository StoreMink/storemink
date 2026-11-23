// ---------------------------------------------------------------------------
// A centred-logo theme's menu, planned to fit beside the logo (owner, 23 Nov
// 2026: "in the planning it should judge, if the logo is in the center, how
// much space is to the left, and according to that design the number of
// buttons, so that we do not have to go a line below").
//
// WHY. The centred header gives its menu the column left of the logo. Muse's
// seven links in capitals did not fit it, so the menu folded behind the menu
// button (now it moves to a row of its own, header-fit.ts). A model cannot
// count pixels, and the links of a new theme are StoreMink's own: Shop and
// the theme's pages (initial-draft.ts). So StoreMink does the arithmetic:
//
//   * PLAN (v35+): a new theme whose plan has the centred header is told the
//     room in px and what it holds in the planned fonts, before Stage B
//     writes its pages (`menuRoomPrompt`).
//   * BUILD: StoreMink keeps in the header Shop and, in the theme's page
//     order, the pages that fit, measured in the theme's own menu type (its
//     body or display font, size, weight, capitals and letter-spacing from
//     its `header.nav-link` style rules). The rest stay in the footer, which
//     lists every page (`fitHeaderMenuToRoom`). Deterministic: no model call.
//   * CHANGE: a change that leaves the menu too wide (an operator asking for
//     more links, capitals, another font) is sent back once with the numbers
//     and the ways to make it fit (`headerMenuFitIssues`); what comes back is
//     accepted, and the storefront's second row is the fallback.
//
// ★ MEASURED, NOT GUESSED: lib/themes/text-width.ts (Chrome's own advances
//   for every catalogue font) and lib/storefront/header-menu-room.ts (the
//   header's CSS, pinned by its test). Measured at 1025px, the narrowest
//   screen with the centred layout, so it fits at every wider one.
// ★ Only the centred header: the other layouts put the menu after the logo
//   with the whole row to share, or on a row of its own already.
// Pure: no database, no provider.
// ---------------------------------------------------------------------------

import type { NavLink } from "@/lib/chrome/nav";
import {
  BRAND_TYPE,
  CENTRED_MIN_WIDTH,
  NAV_LINK_TYPE,
  centredLinkGap,
  centredMenuRoom,
  menuWidth,
} from "@/lib/storefront/header-menu-room";
import { pairingFonts } from "@/lib/themes/fonts";
import type { PageWidth } from "@/lib/themes/page";
import {
  STYLE_FONT_SIZES,
  resolveStyleHook,
  type ThemeStyleRule,
} from "@/lib/themes/stylesheet";
import {
  textWidth,
  type TextStyle,
  type TextTransform,
} from "@/lib/themes/text-width";
import type { ThemeFonts } from "@/lib/themes/types";
import type { ThemePackageV2 } from "./contracts";
import type { DesignPlan } from "./design-plan";

/** The header layout whose menu is planned here. */
export const MENU_FIT_HEADER = "centered";

const ROOT_PX = 16;
const TRANSFORMS: readonly TextTransform[] = [
  "none",
  "uppercase",
  "lowercase",
  "capitalize",
];

/** A style scale value in px at `windowWidth` ("0.875rem", or the
 *  "clamp(a rem, b rem + c vw, d rem)" of the larger steps). */
export function styleLengthPx(value: string, windowWidth: number): number {
  const rem = /^([\d.]+)rem$/.exec(value);
  if (rem) return Number(rem[1]) * ROOT_PX;
  const clamp =
    /^clamp\(([\d.]+)rem, ([\d.]+)rem \+ ([\d.]+)vw, ([\d.]+)rem\)$/.exec(
      value,
    );
  if (!clamp) throw new Error(`Unknown style length: ${value}`);
  const [min, base, vw, max] = clamp.slice(1).map(Number);
  const preferred = base * ROOT_PX + (vw / 100) * windowWidth;
  return Math.min(max * ROOT_PX, Math.max(min * ROOT_PX, preferred));
}

/**
 * How a header part is set at desktop width: its own CSS defaults, then the
 * theme's style rules for `part` ("nav-link", "brand"), the plain hook's
 * rules first and the header-variant's after (they are more specific), each
 * in written order. Hover, focus and phone or tablet rules do not change the
 * resting desktop width.
 */
export function headerPartStyle(
  part: "nav-link" | "brand",
  fonts: ThemeFonts,
  stylesheet: readonly ThemeStyleRule[] | undefined,
  header: string,
  windowWidth: number = CENTRED_MIN_WIDTH,
): TextStyle {
  const type = part === "brand" ? BRAND_TYPE : NAV_LINK_TYPE;
  const style: TextStyle = {
    font: fonts.body,
    weight: type.weight,
    sizePx: type.sizePx,
    letterSpacingEm: type.letterSpacingEm,
    transform: "none",
  };
  const rules = (stylesheet ?? []).filter((rule) => {
    if (rule.state) return false;
    if (rule.viewport && rule.viewport !== "desktop") return false;
    const hook = resolveStyleHook(rule.hook);
    return (
      !!hook &&
      hook.base === "header" &&
      hook.part === part &&
      (hook.variant === null || hook.variant === header)
    );
  });
  const ordered = [
    ...rules.filter((rule) => !rule.hook.includes("[variant=")),
    ...rules.filter((rule) => rule.hook.includes("[variant=")),
  ];
  for (const { declarations: d } of ordered) {
    if (d.fontFamily === "display") style.font = fonts.display;
    if (d.fontFamily === "body") style.font = fonts.body;
    if (
      typeof d.fontSize === "string" &&
      Object.hasOwn(STYLE_FONT_SIZES, d.fontSize)
    )
      style.sizePx = styleLengthPx(
        STYLE_FONT_SIZES[d.fontSize as keyof typeof STYLE_FONT_SIZES],
        windowWidth,
      );
    if (typeof d.fontWeight === "number") style.weight = d.fontWeight;
    if (typeof d.letterSpacing === "string")
      style.letterSpacingEm = Number.parseFloat(d.letterSpacing) || 0;
    if (TRANSFORMS.includes(d.textTransform as TextTransform))
      style.transform = d.textTransform as TextTransform;
  }
  return style;
}

export interface MenuLinkWidth {
  label: string;
  width: number;
  submenu: boolean;
}

export interface MenuFit {
  /** px the menu may take beside the logo at 1025px. */
  room: number;
  /** px the menu takes. */
  width: number;
  fits: boolean;
  links: MenuLinkWidth[];
  linkStyle: TextStyle;
}

interface FitInput {
  header: string | undefined;
  fonts: ThemeFonts;
  stylesheet?: readonly ThemeStyleRule[];
  pageWidth?: PageWidth;
  brandName: string;
  links: readonly Pick<NavLink, "label" | "children">[];
}

function measure(input: FitInput): MenuFit | null {
  if (input.header !== MENU_FIT_HEADER) return null;
  const linkStyle = headerPartStyle(
    "nav-link",
    input.fonts,
    input.stylesheet,
    input.header,
  );
  const brand = textWidth(
    input.brandName,
    headerPartStyle("brand", input.fonts, input.stylesheet, input.header),
  );
  const links: MenuLinkWidth[] = [];
  for (const link of input.links) {
    const width = textWidth(link.label, linkStyle);
    if (width === null) return null; // a font with no measured widths
    links.push({
      label: link.label,
      width,
      submenu: !!link.children?.length,
    });
  }
  const room = centredMenuRoom({
    pageWidth: input.pageWidth,
    logoWidth: brand ?? 0,
  });
  const width = Math.ceil(menuWidth(links));
  return { room, width, fits: width <= room, links, linkStyle };
}

function packageInput(pkg: ThemePackageV2, brandName: string): FitInput {
  const preset = pkg.definition.preset;
  return {
    header: preset.design.layout?.header,
    fonts: preset.design.fonts,
    stylesheet: preset.stylesheet,
    pageWidth: preset.design.page?.width,
    brandName,
    links: preset.menus.header,
  };
}

/** How a package's header menu sits beside its centred logo; null for any
 *  other header, or a font with no measured widths. */
export function headerMenuFit(
  pkg: ThemePackageV2,
  brandName: string,
): MenuFit | null {
  return measure(packageInput(pkg, brandName));
}

/**
 * A NEW theme's header menu, cut to what fits beside its centred logo: the
 * first link (Shop) always, then each link in order while the menu still
 * fits; the first that does not, and every link after it, leave the header.
 * Every page stays linked from the footer. A package whose menu fits, or
 * whose header is not centred, comes back as it was.
 */
export function fitHeaderMenuToRoom(
  pkg: ThemePackageV2,
  brandName: string,
): { package: ThemePackageV2; dropped: string[] } {
  const fit = headerMenuFit(pkg, brandName);
  if (!fit || fit.fits) return { package: pkg, dropped: [] };
  const header = pkg.definition.preset.menus.header;
  let keep = 1;
  while (
    keep < header.length &&
    Math.ceil(menuWidth(fit.links.slice(0, keep + 1))) <= fit.room
  )
    keep++;
  if (keep >= header.length) return { package: pkg, dropped: [] };
  const next = structuredClone(pkg);
  next.definition.preset.menus.header = header.slice(0, keep);
  return {
    package: next,
    dropped: header.slice(keep).map((link) => link.label),
  };
}

const describeStyle = (style: TextStyle) =>
  [
    style.transform === "uppercase" ? "capitals" : null,
    style.letterSpacingEm ? `${style.letterSpacingEm}em letter-spacing` : null,
  ]
    .filter(Boolean)
    .join(" and ");

/**
 * A change that leaves the centred header's menu too wide, as a repair issue
 * for the stage that wrote it. Only when the change made it so: a base whose
 * menu already did not fit, changed in nothing that sets the menu, is not
 * this change's to mend.
 */
export function headerMenuFitIssues(
  pkg: ThemePackageV2,
  base: ThemePackageV2 | null,
  brandName: string,
): string[] {
  const fit = headerMenuFit(pkg, brandName);
  if (!fit || fit.fits) return [];
  if (base) {
    const before = headerMenuFit(base, brandName);
    const same =
      before &&
      !before.fits &&
      JSON.stringify(before.links) === JSON.stringify(fit.links) &&
      before.room === fit.room;
    if (same) return [];
  }
  const typeWords = describeStyle(fit.linkStyle);
  return [
    `Header menu: the centred header sets the menu in the space left of the logo, about ${fit.room}px on the narrowest computer screen (${CENTRED_MIN_WIDTH}px). menus.header (${fit.links
      .map((link) => `"${link.label}" ${Math.round(link.width)}px`)
      .join(
        ", ",
      )}, with ${Math.round(centredLinkGap(CENTRED_MIN_WIDTH))}px between links) measures about ${fit.width}px${typeWords ? ` in ${typeWords}` : ""}, so shoppers would see it pushed to a second row under the logo. Make it fit beside the logo: shorter labels (the short name a shopper taps), fewer links in menus.header (keep the others in menus.footerGroups), or plainer menu type (no capitals or wide letter-spacing on header.nav-link). If the operator asked for this many links, set design.layout.header to "stacked" instead, which gives the menu a row of its own under the logo.`,
  ];
}

/**
 * The plan's centred-header menu room, appended to a new theme's Stage B
 * system prompt (v35+). Empty for any other header.
 */
export function menuRoomPrompt(plan: DesignPlan, brandName: string): string {
  if (plan.layout?.header !== MENU_FIT_HEADER) return "";
  const fonts = pairingFonts(plan.fontPairing);
  const room = centredMenuRoom({
    pageWidth: plan.layout.pageWidth,
    logoWidth:
      textWidth(brandName, headerPartStyle("brand", fonts, [], "centered")) ??
      0,
  });
  const plain = headerPartStyle("nav-link", fonts, [], "centered");
  const capitals: TextStyle = {
    ...plain,
    sizePx: 14,
    letterSpacingEm: 0.08,
    transform: "uppercase",
  };
  const gap = centredLinkGap(CENTRED_MIN_WIDTH);
  // Characters of link text the room holds across four links.
  const chars = (style: TextStyle) => {
    const sample = "abcdefghijklmnopqrstuvwxyz";
    const each = (textWidth(sample, style) ?? 0) / sample.length;
    return each ? Math.floor((room - 3 * gap) / each) : 0;
  };
  return `

Header menu: the planned header is centred, so the menu sits in the space left of the logo: about ${room}px on the narrowest computer screen (${CENTRED_MIN_WIDTH}px). StoreMink measures the menu in this theme's own menu type and keeps in the header Shop and, in your page order, the pages that fit there; every other page is linked from the footer. In the planned body font at the menu's usual 15px that is about ${chars(plain)} characters of link text in all, Shop included; set in capitals at 14px with 0.08em letter-spacing (header.nav-link) it is about ${chars(capitals)}. So put the pages that matter most first and give each the short title a shopper taps, one or two words.`;
}
