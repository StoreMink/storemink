// ---------------------------------------------------------------------------
// Layout commitments (plan Phase 4 item 1; owner, 22 Nov 2026: "all the
// themes should not look same").
//
// WHY. Left to choose, the model converges: in the 4 Oct 2026 live batch all
// eight themes chose the same page width and the same card hover setting,
// and most shared a header and a card. Telling it what the catalogue already
// has (variety-context) steers it; it does not stop it.
//
// So a NEW theme is given its layout before Stage B writes anything: the
// header, product card, product page, footer, page width, grid columns and
// hover setting that suit its design direction AND that the catalogue uses
// least. Two themes built one after the other are then handed different
// skeletons by construction.
//
// ★ A commitment is a strong default, not a cage. Stage B is asked to keep
//   them; a first draft that departs is sent back once with the list; a
//   second draft that still departs is accepted (the brief may truly need
//   another layout, and a theme is worth more than a rule).
// ★ Never for a revision (the operator did not ask for a new layout) and
//   never for a theme built from reference screenshots (the reference is the
//   layout).
// ★ DETERMINISTIC: the same direction, theme id and catalogue give the same
//   commitments, so a run recovered after a restart asks for what it asked
//   for the first time.
// Pure: no database, no provider.
// ---------------------------------------------------------------------------

import { PAGE_WIDTHS } from "@/lib/themes/page";
import type { ThemeDesign } from "@/lib/themes/types";
import type { ThemePackageV2 } from "./contracts";
import {
  STUDIO_DESIGN_DIRECTIONS,
  type StudioDesignDirection,
} from "./design-directions";
import {
  fingerprintChoiceValues,
  type ExistingThemeFingerprint,
} from "./fingerprint";

type Layout = NonNullable<ThemeDesign["layout"]>;
type Header = NonNullable<Layout["header"]>;
/** The grocery card and product page switch the whole storefront to another
 *  renderer, which is the brief's call, never a commitment's. */
type Card = Exclude<NonNullable<Layout["card"]>, "grocery">;
type ProductDetail = Exclude<NonNullable<Layout["productDetail"]>, "grocery">;
type Footer = NonNullable<Layout["footer"]>;
type Width = (typeof PAGE_WIDTHS)[number];
type Columns = NonNullable<Layout["gridColumnsDesktop"]>;

export interface LayoutCommitments {
  header: Header;
  card: Card;
  productDetail: ProductDetail;
  footer: Footer;
  pageWidth: Width;
  gridColumnsDesktop: Columns;
  cardHoverImage: boolean;
}

interface Signature {
  headers: readonly Header[];
  cards: readonly Card[];
  productDetails: readonly ProductDetail[];
  footers: readonly Footer[];
  widths: readonly Width[];
  columns: readonly Columns[];
}

/**
 * Each direction's structural signature: the layouts that are that
 * direction. Every list is ordered most characteristic first, and no two
 * directions share all five lists, so even with an empty catalogue two
 * directions start from different skeletons.
 */
export const DIRECTION_SIGNATURES: Readonly<
  Record<StudioDesignDirection, Signature>
> = {
  "luxury-minimal": {
    headers: ["centered", "minimal", "transparent", "stacked"],
    cards: ["framed", "overlay", "centered", "classic"],
    productDetails: ["editorial", "stacked", "classic"],
    footers: ["minimal", "centered", "editorial"],
    widths: ["narrow", "standard", "wide"],
    columns: [3, 4],
  },
  "bold-and-loud": {
    headers: ["hamburger", "classic", "transparent", "utility"],
    cards: ["overlay", "wide", "classic", "quick_add"],
    productDetails: ["stacked", "classic"],
    footers: ["compact", "rich", "centered"],
    widths: ["full", "wide", "standard"],
    columns: [3, 4, 5],
  },
  "magazine-editorial": {
    headers: ["stacked", "centered", "minimal", "transparent"],
    cards: ["wide", "overlay", "centered", "classic"],
    productDetails: ["editorial", "stacked"],
    footers: ["editorial", "minimal", "centered"],
    widths: ["narrow", "standard", "wide"],
    columns: [3, 4],
  },
  "dense-catalogue": {
    headers: ["market", "utility", "classic"],
    cards: ["quick_add", "classic", "soft", "wide"],
    productDetails: ["classic", "stacked"],
    footers: ["rich", "compact"],
    widths: ["wide", "full", "standard"],
    columns: [5, 4],
  },
  "soft-and-natural": {
    headers: ["centered", "classic", "stacked", "minimal"],
    cards: ["soft", "centered", "classic", "framed"],
    productDetails: ["classic", "editorial", "stacked"],
    footers: ["centered", "rich", "minimal"],
    widths: ["standard", "narrow", "wide"],
    columns: [3, 4],
  },
  "playful-and-colourful": {
    headers: ["classic", "centered", "hamburger", "utility"],
    cards: ["soft", "quick_add", "wide", "classic"],
    productDetails: ["classic", "stacked"],
    footers: ["rich", "centered", "compact"],
    widths: ["standard", "wide", "full"],
    columns: [3, 4, 5],
  },
  "classic-and-trusted": {
    headers: ["classic", "utility", "centered", "market"],
    cards: ["classic", "quick_add", "framed", "centered"],
    productDetails: ["classic", "stacked"],
    footers: ["rich", "compact", "centered"],
    widths: ["standard", "wide"],
    columns: [4, 5],
  },
  brutalist: {
    headers: ["hamburger", "utility", "classic", "stacked"],
    cards: ["wide", "classic", "framed", "overlay"],
    productDetails: ["stacked", "classic"],
    footers: ["compact", "minimal", "rich"],
    widths: ["full", "wide", "standard"],
    columns: [4, 5, 3],
  },
  "scandinavian-utility": {
    headers: ["minimal", "classic", "centered", "utility"],
    cards: ["classic", "soft", "centered", "quick_add"],
    productDetails: ["classic", "stacked", "editorial"],
    footers: ["minimal", "compact", "rich"],
    widths: ["standard", "narrow", "wide"],
    columns: [3, 4],
  },
  "maximal-pattern": {
    headers: ["stacked", "transparent", "centered", "hamburger"],
    cards: ["overlay", "soft", "wide", "framed"],
    productDetails: ["editorial", "stacked", "classic"],
    footers: ["editorial", "rich", "centered"],
    widths: ["wide", "full", "standard"],
    columns: [3, 4],
  },
  "dark-luxury": {
    headers: ["transparent", "minimal", "centered", "stacked"],
    cards: ["overlay", "framed", "centered"],
    productDetails: ["editorial", "stacked"],
    footers: ["minimal", "editorial", "centered"],
    widths: ["narrow", "standard", "wide"],
    columns: [3, 4],
  },
  "retro-catalogue": {
    headers: ["utility", "market", "stacked", "classic"],
    cards: ["framed", "classic", "centered", "quick_add"],
    productDetails: ["classic", "stacked"],
    footers: ["rich", "centered", "compact"],
    widths: ["standard", "wide"],
    columns: [4, 5],
  },
  "tech-spec": {
    headers: ["utility", "minimal", "classic", "hamburger"],
    cards: ["classic", "wide", "quick_add", "framed"],
    productDetails: ["stacked", "classic"],
    footers: ["compact", "rich", "minimal"],
    widths: ["wide", "standard", "full"],
    columns: [4, 5],
  },
  "artisan-craft": {
    headers: ["centered", "stacked", "classic", "minimal"],
    cards: ["centered", "soft", "framed", "classic"],
    productDetails: ["editorial", "classic", "stacked"],
    footers: ["editorial", "centered", "rich"],
    widths: ["narrow", "standard"],
    columns: [3, 4],
  },
};

/** A small stable hash, so a tie is broken the same way every time for one
 *  theme and differently for the next. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** How often each value of each committed setting appears in the catalogue. */
function catalogueCounts(
  existing: readonly ExistingThemeFingerprint[],
): Record<keyof LayoutCommitments, Map<string, number>> {
  const counts = {
    header: new Map<string, number>(),
    card: new Map<string, number>(),
    productDetail: new Map<string, number>(),
    footer: new Map<string, number>(),
    pageWidth: new Map<string, number>(),
    gridColumnsDesktop: new Map<string, number>(),
    cardHoverImage: new Map<string, number>(),
  };
  const add = (map: Map<string, number>, value: string | undefined) => {
    if (value) map.set(value, (map.get(value) ?? 0) + 1);
  };
  for (const theme of existing) {
    // composition is "header/productDetail/cart/footer" (fingerprint.ts).
    const [header, productDetail, , footer] =
      theme.fingerprint.composition.split("/");
    const choices = fingerprintChoiceValues(theme.fingerprint);
    add(counts.header, header);
    add(counts.productDetail, productDetail);
    add(counts.footer, footer);
    add(counts.card, choices.card);
    add(counts.pageWidth, choices.pageWidth);
    add(counts.gridColumnsDesktop, choices.gridColumnsDesktop);
    add(counts.cardHoverImage, choices.cardHoverImage);
  }
  return counts;
}

/**
 * The layout a new theme of this direction is committed to: per setting, the
 * value its direction allows that the catalogue uses least. A tie goes to a
 * value picked by the theme's own id, so two themes built against the same
 * catalogue still part ways, and an empty catalogue does not hand every
 * theme its direction's first choice.
 */
export function layoutCommitments(
  direction: string | null | undefined,
  themeId: string,
  existing: readonly ExistingThemeFingerprint[],
): LayoutCommitments | null {
  if (!direction || !Object.hasOwn(DIRECTION_SIGNATURES, direction))
    return null;
  const signature = DIRECTION_SIGNATURES[direction as StudioDesignDirection];
  const counts = catalogueCounts(existing);
  const choose = <T extends string | number | boolean>(
    setting: keyof LayoutCommitments,
    allowed: readonly T[],
  ): T => {
    const used = (value: T) => counts[setting].get(String(value)) ?? 0;
    const least = Math.min(...allowed.map(used));
    const tied = allowed.filter((value) => used(value) === least);
    return tied[hash(`${themeId}|${setting}`) % tied.length];
  };
  return {
    header: choose("header", signature.headers),
    card: choose("card", signature.cards),
    productDetail: choose("productDetail", signature.productDetails),
    footer: choose("footer", signature.footers),
    pageWidth: choose("pageWidth", signature.widths),
    gridColumnsDesktop: choose("gridColumnsDesktop", signature.columns),
    cardHoverImage: choose("cardHoverImage", [true, false] as const),
  };
}

/** Where each commitment lives in the draft, as Stage B writes it. */
const PATHS: Record<keyof LayoutCommitments, string> = {
  header: "design.layout.header",
  card: "design.layout.card",
  productDetail: "design.layout.productDetail",
  footer: "design.layout.footer",
  pageWidth: "design.page.width",
  gridColumnsDesktop: "design.layout.gridColumnsDesktop",
  cardHoverImage: "design.layout.cardHoverImage",
};

/** The commitments section of the Stage B system prompt (v34+). */
export function commitmentsPrompt(
  commitments: LayoutCommitments,
  direction: string,
): string {
  const label = Object.hasOwn(STUDIO_DESIGN_DIRECTIONS, direction)
    ? STUDIO_DESIGN_DIRECTIONS[direction as StudioDesignDirection].label
    : direction;
  const lines = (Object.keys(PATHS) as (keyof LayoutCommitments)[])
    .map((key) => `${PATHS[key]} = ${JSON.stringify(commitments[key])}`)
    .join("; ");
  return `

Layout commitments: so that the catalogue's themes do not share one skeleton, this theme's layout is decided before you write it. For ${label}, from the layouts the catalogue uses least: ${lines}. Write exactly these values, and design the homepage, the page templates and the stylesheet around them (a transparent header needs the full-band opening it floats over; a market header needs headerBackground and headerForeground). Depart from one only where the brief plainly requires a different layout, such as a grocery store that needs the grocery storefront; a preference of your own is not a reason.`;
}

/** What a compiled package's layout says for each committed setting. */
function layoutOf(
  pkg: ThemePackageV2,
): Record<keyof LayoutCommitments, unknown> {
  const design = pkg.definition.preset.design;
  const layout = design.layout ?? {};
  return {
    header: layout.header ?? "classic",
    card: layout.card ?? "classic",
    productDetail: layout.productDetail ?? "classic",
    footer: layout.footer ?? "rich",
    pageWidth: design.page?.width ?? "standard",
    gridColumnsDesktop: layout.gridColumnsDesktop ?? 4,
    cardHoverImage: layout.cardHoverImage === true,
  };
}

/**
 * Where a draft departs from its commitments, as repair issues. Empty for a
 * grocery storefront (another renderer, chosen for the brief), whose card
 * and product page are its own.
 */
export function commitmentIssues(
  pkg: ThemePackageV2,
  commitments: LayoutCommitments,
): string[] {
  const grocery = pkg.definition.preset.design.layout?.storefront === "grocery";
  const actual = layoutOf(pkg);
  return (Object.keys(PATHS) as (keyof LayoutCommitments)[])
    .filter((key) => !(grocery && (key === "card" || key === "productDetail")))
    .filter((key) => actual[key] !== commitments[key])
    .map(
      (key) =>
        `Layout commitment: ${PATHS[key]} is ${JSON.stringify(actual[key])}, but this theme is committed to ${JSON.stringify(commitments[key])} so it does not share a skeleton with the catalogue. Use the committed value, unless the brief plainly requires another layout.`,
    );
}
