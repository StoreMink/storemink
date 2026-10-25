// ---------------------------------------------------------------------------
// Mink storefront revamp: how far a redesign is from this store's earlier
// redesigns, and the bounded, deterministic changes that move it away
// (robustness audit of 23 Oct 2026, section 5 step 6, the pure part).
//
//   revampFingerprint      the plan applied over its theme, measured with
//                          Theme Studio's own `themeFingerprint`.
//   revampDistinctnessBar  ★ the bar two designs on the same theme must clear.
//   earlierDesignsSummary  the design choices of this store's earlier
//                          redesigns, for the planner's prompt.
//   makeDistinct           a plan closer than the bar to an earlier one gets
//                          the choices the merchant did not ask about changed,
//                          in a fixed order, until it clears the bar.
//
// ★ PURE: no database, no files, no clock, no environment, no model call. The
//   runner reads the store's own earlier plans and hands them in; this module
//   never sees another store's plan (step 7 of the audit is not approved).
// ★ DESIGN CHOICES ONLY. Nothing here reads or writes a word, a link, a
//   product, a shot or a photo: the summary prints closed vocabulary (section
//   types, schemes, variants, pairing keys, colour bands, numbers), and the
//   changes are section styles, image sides, the opening's height, the card
//   style and the font pairing. Never words, never products.
// ★ THEME STUDIO'S RULER, NOT A COPY OF IT. The weights, the colour bands and
//   the sequence distance are `lib/theme-studio/fingerprint.ts`'s; the shares
//   below are read from its own `fingerprintDistance`, so a change there moves
//   the calibration with it.
// ---------------------------------------------------------------------------

import {
  DESIGN_PALETTE_TOKENS,
  DESIGN_SHAPE_KEYS,
  hasDesignOverrides,
  validateStorefrontDesign,
  type StorefrontDesignOverrides,
} from "@/lib/chrome/design";
import {
  DEFAULT_CHROME,
  resolveStorefrontAppearance,
  type StorefrontAppearance,
} from "@/lib/chrome/types";
import {
  HERO_HEIGHTS,
  HERO_VARIANTS,
  HOMEPAGE_SECTION_TYPES,
  validateSectionStyle,
  type SectionStyle,
} from "@/lib/homepage/section-types";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  DESIGN_DIRECTION_IDS,
  DESIGN_DIRECTIONS,
  type DesignDirection,
  type PaletteFamily,
} from "@/lib/theme-studio/design-directions";
import {
  colourBand,
  DISTINCTNESS_THRESHOLD,
  fingerprintDistance,
  themeFingerprint,
  type ThemeFingerprint,
} from "@/lib/theme-studio/fingerprint";
import {
  LAYOUT_VARIANT_ENUMS,
  PRODUCT_DETAIL_ENUM,
} from "@/lib/theme-studio/schemas";
import {
  DESIGN_FONTS,
  FONT_PAIRING_KEYS,
  FONT_PAIRINGS,
  THEME_FONT_FACES,
  type FontPairingKey,
} from "@/lib/themes/fonts";
import {
  isSectionScheme,
  resolveScheme,
  SCHEMELESS_SECTION_TYPES,
  schemeContrastIssues,
  schemeDesignFor,
  SECTION_SCHEMES,
  withPaletteOverrides,
  type SchemeDesign,
  type SectionScheme,
} from "@/lib/themes/schemes";
import type {
  ThemeDefinition,
  ThemeDesign,
  ThemeLayout,
} from "@/lib/themes/types";
import type {
  RevampPlannedPage,
  RevampRequest,
  RevampSitePlan,
  RevampSnapshot,
} from "./contract";
import { revampDesignSeed, revampSeededPick } from "./site-compiler";

type Json = Record<string, unknown>;
type FingerprintField = keyof ThemeFingerprint;

const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The parts of a compiled plan the fingerprint and the summary read. */
export type RevampDesignPlan = Pick<
  RevampSitePlan,
  "direction" | "design" | "appearance" | "pages"
>;

/** At most this many earlier redesigns are summarised and compared. */
export const REVAMP_EARLIER_PLANS_MAX = 5;

const EPSILON = 1e-9;

/** Distances are reported to three places, as Theme Studio reports them. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 1. The plan applied over its theme.
// ---------------------------------------------------------------------------

const APPEARANCE_VALUES = {
  header: LAYOUT_VARIANT_ENUMS.header,
  card: LAYOUT_VARIANT_ENUMS.card,
  productDetail: PRODUCT_DETAIL_ENUM,
  footer: LAYOUT_VARIANT_ENUMS.footer,
} as const satisfies Partial<
  Record<keyof StorefrontAppearance, readonly string[]>
>;
const APPEARANCE_KEYS = Object.keys(APPEARANCE_VALUES) as Array<
  keyof typeof APPEARANCE_VALUES
>;

/** The plan's own colours, fonts and corners, cleaned as the chrome is. */
function ownDesign(plan: { design?: unknown }): StorefrontDesignOverrides {
  return validateStorefrontDesign(plan.design ?? null, null, "draft").design;
}

/**
 * The header, card, product-page and footer shoppers see, written as an
 * explicit layout. ★ The storefront's own resolver decides
 * (`resolveStorefrontAppearance`), so a card the plan chooses on Basket is
 * the card shoppers see. The theme's legacy `storefront: "grocery"`
 * shorthand is resolved into the four variants and then left out: kept, it
 * makes Theme Studio's fingerprint read every Basket card as "grocery" (the
 * audit's mapping did, which is where its 27% came from), although crumb's
 * plans chose quick add and shoppers saw classic cards with a quick-add
 * button.
 */
function appliedLayout(
  theme: ThemeDefinition,
  appearance: unknown,
): ThemeLayout {
  const layout = theme.preset.design.layout;
  const overrides: StorefrontAppearance = { ...DEFAULT_CHROME.appearance };
  const own = isRecord(appearance) ? appearance : {};
  for (const key of APPEARANCE_KEYS) {
    const value = own[key];
    if ((APPEARANCE_VALUES[key] as readonly unknown[]).includes(value)) {
      (overrides as unknown as Json)[key] = value;
    }
  }
  const resolved = resolveStorefrontAppearance(
    layout,
    overrides,
    theme.preset.templates,
  );
  const rest: ThemeLayout = { ...(layout ?? {}) };
  delete rest.storefront;
  return {
    ...rest,
    header: resolved.header,
    card:
      resolved.card === "classic" && resolved.cardQuickAdd
        ? "quick_add"
        : resolved.card,
    productDetail: resolved.productDetail,
    cart: resolved.cart,
    footer: resolved.footer,
  };
}

/**
 * The theme's design with the plan's colours, fonts, corners and layout
 * choices over it, as the storefront paints them: a colour or corner the plan
 * leaves out is the theme's, and the accent is the plan's, else the theme's
 * fixed accent, else its brand colour (`--brand-primary`).
 */
function appliedDesign(
  theme: ThemeDefinition,
  plan: { design?: unknown; appearance?: unknown },
): ThemeDesign {
  const base = theme.preset.design;
  const own = ownDesign(plan);
  const palette = {
    ...base.palette,
    accent: base.palette.accent ?? theme.preset.brand.primaryColor,
  };
  for (const token of DESIGN_PALETTE_TOKENS) {
    const value = own.palette[token];
    if (value) palette[token] = value;
  }
  const shape = { ...base.shape };
  for (const key of DESIGN_SHAPE_KEYS) {
    const value = own.shape[key];
    if (value !== undefined) shape[key] = `${value}px`;
  }
  return {
    ...base,
    palette,
    shape,
    fonts: {
      body: own.fonts.body ? DESIGN_FONTS[own.fonts.body] : base.fonts.body,
      display: own.fonts.display
        ? DESIGN_FONTS[own.fonts.display]
        : base.fonts.display,
    },
    layout: appliedLayout(theme, plan.appearance),
  };
}

/** The homepage a plan writes, or null when it leaves the homepage alone. */
function planHome(plan: { pages?: unknown }): PageSectionItem[] | null {
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  const home = pages.find(
    (page): page is RevampPlannedPage => isRecord(page) && page.slug === "",
  );
  return home && Array.isArray(home.sections)
    ? (home.sections.filter(isRecord) as unknown as PageSectionItem[])
    : null;
}

function themeHome(theme: ThemeDefinition): PageSectionItem[] {
  return theme.preset.pages.find((page) => !page.slug)?.sections ?? [];
}

/** What shoppers see: a section switched off is not drawn. */
function shown(sections: readonly PageSectionItem[]): PageSectionItem[] {
  return sections.filter((section) => section.enabled !== false);
}

function fingerprintWith(
  theme: ThemeDefinition,
  design: ThemeDesign,
  sections: readonly PageSectionItem[],
): ThemeFingerprint {
  return themeFingerprint({
    ...theme,
    preset: {
      ...theme.preset,
      design,
      pages: [{ slug: "", title: "Home", sections: shown(sections) }],
    },
  });
}

/**
 * The plan applied over its theme, measured with Theme Studio's own
 * fingerprint: the plan's colours, fonts, corners, header, card, product page
 * and footer over the theme's (as the storefront resolves them), and the
 * homepage the plan writes (the theme's own when it writes none). Buttons,
 * headings, page width, grid and motion are the theme's: a plan cannot set
 * them. Pure; a few microseconds.
 */
export function revampFingerprint(
  theme: ThemeDefinition,
  plan: Partial<RevampDesignPlan>,
): ThemeFingerprint {
  return fingerprintWith(
    theme,
    appliedDesign(theme, plan),
    planHome(plan) ?? themeHome(theme),
  );
}

/** The plan's distance to each earlier plan, all over the same theme. */
export function revampDistances(
  theme: ThemeDefinition,
  plan: Partial<RevampDesignPlan>,
  earlier: readonly Partial<RevampDesignPlan>[],
): number[] {
  const current = revampFingerprint(theme, plan);
  return earlier.map((other) =>
    fingerprintDistance(current, revampFingerprint(theme, other)),
  );
}

// ---------------------------------------------------------------------------
// 2. The bar for two designs on the same theme.
// ---------------------------------------------------------------------------

/**
 * Each fingerprint field's share of the whole, read from Theme Studio's own
 * `fingerprintDistance` (its weights are private): two fingerprints that
 * differ in that field alone are exactly its share apart.
 */
export function fingerprintFieldShares(
  sample: ThemeFingerprint,
): Record<FingerprintField, number> {
  const out = {} as Record<FingerprintField, number>;
  for (const field of Object.keys(sample) as FingerprintField[]) {
    const other = {
      ...sample,
      [field]: Array.isArray(sample[field]) ? ["\u0000"] : "\u0000",
    } as ThemeFingerprint;
    out[field] = fingerprintDistance(sample, other);
  }
  return out;
}

const probeSection = (
  type: string,
  config: Json,
  style?: SectionStyle,
): PageSectionItem =>
  ({
    id: `probe-${type}`,
    type,
    enabled: true,
    config,
    ...(style ? { style } : {}),
  }) as unknown as PageSectionItem;

const probePage = (sections: PageSectionItem[]): RevampPlannedPage => ({
  slug: "",
  title: "Home",
  seoTitle: "",
  seoDescription: "",
  create: false,
  pageId: null,
  sections,
});

/**
 * Two plans that move every choice a plan has to two different values: the
 * page and accent colours, both faces, the corners, the header, card, product
 * page and footer, the opening, the homepage's sections and bands, the
 * category display and the newsletter. A field neither moves on a theme is
 * one the theme fixes.
 */
const PROBE_PLANS: ReadonlyArray<Partial<RevampDesignPlan>> = [
  {
    design: {
      palette: { cream: "#111111", accent: "#ff0000" },
      fonts: { body: "inter", display: "fraunces" },
      shape: { card: 0 },
    },
    appearance: {
      header: "classic",
      card: "framed",
      productDetail: "classic",
      footer: "rich",
    },
    pages: [
      probePage([
        probeSection("hero", { variant: "fullbleed", height: "large" }),
        probeSection(
          "shop_by_category",
          { display: "cards", layout: "grid" },
          { scheme: "soft", padding_y: "md" },
        ),
        probeSection("newsletter", { theme: "light", alignment: "left" }),
      ]),
    ],
  },
  {
    design: {
      palette: { cream: "#ffffff", accent: "#0000ff" },
      fonts: { body: "manrope", display: "bebasNeue" },
      shape: { card: 24 },
    },
    appearance: {
      header: "utility",
      card: "wide",
      productDetail: "stacked",
      footer: "compact",
    },
    pages: [
      probePage([
        probeSection("hero_carousel", { height: "screen" }),
        probeSection(
          "gallery",
          { layout: "grid" },
          { scheme: "inverse", padding_y: "lg", width: "full" },
        ),
        probeSection("shop_by_category", { display: "list", layout: "scroll" }),
        probeSection(
          "newsletter",
          { theme: "dark", alignment: "center" },
          { scheme: "accent", padding_y: "md" },
        ),
      ]),
    ],
  },
];

interface ThemeCalibration {
  fixed: FingerprintField[];
  share: number;
}
const calibrations = new WeakMap<ThemeDefinition, ThemeCalibration>();

function calibrate(theme: ThemeDefinition): ThemeCalibration {
  const known = calibrations.get(theme);
  if (known) return known;
  const bare = revampFingerprint(theme, {});
  const probes = PROBE_PLANS.map((plan) => revampFingerprint(theme, plan));
  const shares = fingerprintFieldShares(bare);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const fixed = (Object.keys(bare) as FingerprintField[]).filter((field) =>
    probes.every((probe) => same(probe[field], bare[field])),
  );
  const share = fixed.reduce((sum, field) => sum + shares[field], 0);
  const out = { fixed, share };
  calibrations.set(theme, out);
  return out;
}

/** The fingerprint fields no plan can change on this theme. */
export function revampThemeFixedFields(
  theme: ThemeDefinition,
): readonly FingerprintField[] {
  return calibrate(theme).fixed;
}

/** The share of the fingerprint (0 to 1) this theme fixes for every plan. */
export function revampThemeFixedShare(theme: ThemeDefinition): number {
  return calibrate(theme).share;
}

/**
 * ★★ THE BAR FOR TWO DESIGNS ON THE SAME THEME (calibrated 24 Oct 2026; the
 * owner can move it here, and only here).
 *
 *   bar = DISTINCTNESS_THRESHOLD x (1 - the share of the fingerprint the
 *         theme fixes), to three places.
 *
 * Theme Studio's bar (0.35) is for two themes, which can differ in every
 * field. Two redesigns on the same theme can never differ in the fields the
 * theme fixes (buttons, headings, page width, grid and motion: a plan cannot
 * set them), so the most they can be apart is 1 minus that share. The bar
 * asks the same share of what is reachable that Theme Studio asks of two
 * themes.
 *
 * Evidence (robustness audit, 23 Oct, uniqueness-ref/fingerprints.json; the
 * calibration test re-measures every number):
 *   - share fixed, measured per bundled theme with the storefront's own
 *     appearance rules: Basket, Ritual, Studio and Vitrine 18 of 104 weight
 *     points each (buttons 5, heading 4, width 4, grid 4, motion 1), 17.3%.
 *     The audit's 27% on Basket counted the card as fixed too, because its
 *     mapping kept the theme's legacy grocery shorthand; the storefront shows
 *     the plan's card (crumb's quick add), so the card is the plan's to move.
 *   - so the bar is 0.35 x 0.827 = 0.289 on all four bundled themes (with
 *     the audit's 27% it would be 0.256: both readings separate the pairs).
 *   - the same bakery planned twice on Basket (crumb runs 2 and 3): 0.166,
 *     13 of 17 fields the same. Below the bar: a redo must change.
 *   - crumb run 3 (Basket) against neem run 3 (Ritual): 0.452. Above it.
 *   - for scale: the bare Basket and Ritual themes are 0.611 apart, and
 *     Theme Studio's 8 test themes have a median of 0.704.
 *   - reachable: from a plan identical to an earlier one, the changes
 *     makeDistinct may make alone are worth up to 0.375 (bands 0.058, opening
 *     0.096, card 0.096, fonts 0.125), above 0.289.
 */
export function revampDistinctnessBar(theme: ThemeDefinition): number {
  return round3(DISTINCTNESS_THRESHOLD * (1 - revampThemeFixedShare(theme)));
}

// ---------------------------------------------------------------------------
// Reading an earlier plan.
// ---------------------------------------------------------------------------

/**
 * A stored plan as the summary and the check read it: the compiled stage of
 * `mink_revamps.plan` (`{stage: "compiled", plan}`) or a bare compiled plan;
 * null for anything else (a plan still raw, a malformed row).
 */
export function revampEarlierPlan(value: unknown): RevampSitePlan | null {
  const raw =
    isRecord(value) && value.stage === "compiled" && isRecord(value.plan)
      ? value.plan
      : value;
  if (!isRecord(raw) || !Array.isArray(raw.pages)) return null;
  return raw as unknown as RevampSitePlan;
}

// ---------------------------------------------------------------------------
// 3. The summary of this store's earlier redesigns.
// ---------------------------------------------------------------------------

const FACE_LABELS: ReadonlyMap<string, string> = new Map(
  THEME_FONT_FACES.map((face) => [face.key as string, face.label as string]),
);

function pairingOf(
  fonts: StorefrontDesignOverrides["fonts"],
): FontPairingKey | null {
  return (
    FONT_PAIRING_KEYS.find(
      (key) =>
        FONT_PAIRINGS[key].body === fonts.body &&
        FONT_PAIRINGS[key].display === fonts.display,
    ) ?? null
  );
}

/** A pairing by its key (the prompt lists the keys), else the two faces. */
function fontsWords(design: StorefrontDesignOverrides): string {
  const { body, display } = design.fonts;
  if (!body && !display) return "the theme's";
  const pairing = pairingOf(design.fonts);
  if (pairing) return pairing;
  const label = (key: string | null) =>
    key ? (FACE_LABELS.get(key) ?? "the theme's") : "the theme's";
  return `${label(display)} headings, ${label(body)} body`;
}

/** The palette family a page colour belongs to (design-directions.ts). */
function paletteFamilyOf(band: string): PaletteFamily {
  if (band === "near-white") return "light";
  if (band === "near-black" || band.startsWith("dark:")) return "dark";
  if (band.startsWith("colour:")) return "colour-field";
  return "tinted-neutral";
}

function paletteWords(design: StorefrontDesignOverrides): string {
  const page = design.palette.cream;
  if (!page) return "the theme's page colour";
  const band = colourBand(page);
  return `${paletteFamilyOf(band)}, page ${band}`;
}

function cornerWords(design: StorefrontDesignOverrides): string {
  const parts = DESIGN_SHAPE_KEYS.filter(
    (key) => design.shape[key] !== undefined,
  ).map((key) => `${key} ${design.shape[key]}`);
  return parts.length ? `${parts.join(", ")} px` : "the theme's";
}

const sectionType = (section: PageSectionItem): string =>
  (HOMEPAGE_SECTION_TYPES as readonly string[]).includes(section.type)
    ? section.type
    : "other";

function skeletonWords(sections: readonly PageSectionItem[]): string {
  const list = shown(sections).map((section) => {
    const scheme = section.style?.scheme;
    return isSectionScheme(scheme)
      ? `${sectionType(section)} [${scheme}]`
      : sectionType(section);
  });
  return list.length ? list.join(" > ") : "empty";
}

const config = (section: PageSectionItem): Json =>
  isRecord(section.config) ? (section.config as unknown as Json) : {};

const side = (value: unknown): "left" | "right" =>
  value === "right" ? "right" : "left";

/** Every image-beside-text band's side, in page order, stories included. */
function imageSides(sections: readonly PageSectionItem[]): string[] {
  const out: string[] = [];
  for (const section of shown(sections)) {
    const c = config(section);
    if (section.type === "media_text") {
      out.push(side(c.media_position));
      for (const story of Array.isArray(c.stories) ? c.stories : []) {
        out.push(side(isRecord(story) ? story.media_position : undefined));
      }
    } else if (section.type === "product_spotlight") {
      out.push(side(c.media_position));
    }
  }
  return out;
}

function openingWords(sections: readonly PageSectionItem[]): string {
  const first = shown(sections)[0];
  if (!first) return "none";
  const c = config(first);
  const height = (HERO_HEIGHTS as readonly unknown[]).includes(c.height)
    ? (c.height as string)
    : "auto";
  if (first.type === "hero_carousel") return `photo carousel, ${height}`;
  if (first.type === "hero") {
    const variant = (HERO_VARIANTS as readonly unknown[]).includes(c.variant)
      ? (c.variant as string)
      : "banner";
    return `${variant} hero, ${height}`;
  }
  return sectionType(first);
}

function variantWords(
  appearance: unknown,
  key: keyof typeof APPEARANCE_VALUES,
): string {
  const value = isRecord(appearance) ? appearance[key] : undefined;
  return (APPEARANCE_VALUES[key] as readonly unknown[]).includes(value)
    ? (value as string)
    : "the theme's";
}

function designLine(plan: RevampSitePlan, index: number): string {
  const design = ownDesign(plan);
  const direction = (DESIGN_DIRECTION_IDS as readonly unknown[]).includes(
    plan.direction,
  )
    ? plan.direction
    : "not recorded";
  const home = planHome(plan);
  const sides = home ? imageSides(home) : [];
  return [
    `${index + 1}${index === 0 ? " (newest)" : ""}. direction ${direction}`,
    `fonts ${fontsWords(design)}`,
    `palette ${paletteWords(design)}`,
    `corners ${cornerWords(design)}`,
    `homepage ${home ? skeletonWords(home) : "not redesigned"}`,
    `image sides ${sides.length ? sides.join(", ") : "none"}`,
    `opening ${home ? openingWords(home) : "not redesigned"}`,
    `cards ${variantWords(plan.appearance, "card")}`,
    `header ${variantWords(plan.appearance, "header")}`,
    `footer ${variantWords(plan.appearance, "footer")}`,
  ].join("; ");
}

/**
 * The design choices of up to five earlier redesigns of this store, newest
 * first, one short line each: direction, font pairing, palette family and
 * page band, corners, homepage skeleton with its colour bands ([scheme]),
 * image sides, opening height, card, header and footer styles (the last two
 * set the composition, a tenth of the fingerprint, so the planner sees them
 * too).
 * ★ Design choices only:
 * every value is from a closed list (or a number), never the store's words,
 * product names, links or photos. "" when there is none. The prompt fences it
 * as data.
 */
export function earlierDesignsSummary(plans: readonly unknown[]): string {
  return plans
    .map(revampEarlierPlan)
    .filter((plan): plan is RevampSitePlan => plan !== null)
    .slice(0, REVAMP_EARLIER_PLANS_MAX)
    .map(designLine)
    .join("\n");
}

// ---------------------------------------------------------------------------
// 4. Moving a plan away from this store's earlier ones.
// ---------------------------------------------------------------------------

/** What makeDistinct may change, in the order it tries them. */
export const REVAMP_DISTINCT_CHOICES = [
  "bandRhythm",
  "imageSides",
  "openingHeight",
  "cardStyle",
  "fontPairing",
] as const;
export type RevampDistinctChoice = (typeof REVAMP_DISTINCT_CHOICES)[number];

/**
 * Words that mean the merchant asked about a choice. ★ Generous on purpose: a
 * false match only keeps the planner's choice; a missed one would change what
 * the merchant asked for.
 */
const FONT_NAMES = [
  ...THEME_FONT_FACES.map((face) => face.label as string).filter(
    // Ordinary words (and a shop-name word) that are also font names.
    (label) => !["Inter", "Outfit", "Newsreader", "Italiana"].includes(label),
  ),
  "Garamond",
  "Bodoni",
  "Playfair",
  "Montserrat",
  "Poppins",
  "Helvetica",
  "Arial",
  "Futura",
  "Baskerville",
  "Didot",
  "Lato",
  "Raleway",
  "Merriweather",
  "Open Sans",
  "Times New Roman",
  "Calibri",
  "Gill Sans",
  "Avenir",
  "Verdana",
  "Comic Sans",
];
const escapeWord = (word: string) =>
  word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[ -]?");

const REQUEST_WORDS: Record<RevampDistinctChoice, RegExp> = {
  bandRhythm:
    /\b(?:bands?|stripes?|backgrounds?|colou?r[ -]?blocks?|blocks? of colou?rs?|colou?red (?:sections?|strips?)|section colou?rs?|alternating colou?rs?|rhythm)\b/i,
  imageSides:
    /\b(?:zig[ -]?zag|(?:images?|photos?|pictures?|photographs?)\s+(?:on|to|at)\s+the\s+(?:left|right)|(?:left|right)[ -](?:side[ -])?(?:aligned[ -])?(?:images?|photos?|pictures?|photographs?)|alternat\w*\s+(?:sides?|images?|photos?|pictures?)|image sides?)\b/i,
  openingHeight:
    /\b(?:hero|banners?|opening|slide ?shows?|sliders?|carousels?|cover (?:photo|image|picture)s?|full[ -]?screen|first (?:photo|image|picture|section|slide|screen)s?|top (?:photo|image|picture|banner|section)s?|header (?:image|photo|picture)s?)\b/i,
  cardStyle:
    /\b(?:product (?:cards?|tiles?|grid|boxes)|quick[ -]?add|add[ -]to[ -](?:cart|bag|basket) buttons?|(?:classic|overlay|framed|grocery|cent(?:er|re)d|soft|wide|rounded|square|minimal|simple|plain|big|large|small|bordered|shadow(?:ed)?) (?:product )?cards?|cards? (?:style|look|design|layout))\b/i,
  fontPairing: new RegExp(
    `\\b(?:fonts?|typefaces?|typography|lettering|serifs?|sans[ -]?serifs?|handwrit\\w*|calligraph\\w*|script (?:font|type|lettering)|headings? (?:font|style|type)|${FONT_NAMES.map(escapeWord).join("|")})\\b`,
    "i",
  ),
};

/** What a whole design is called when a merchant asks to keep it. */
const DESIGN_NOUN =
  "(?:layouts?|designs?|look|structure|home[ -]?page|style|arrangement|template|everything else)";
/** An earlier or current design of the store, as a merchant names it. */
const EARLIER_DESIGN =
  "(?:last|previous|earlier|current|existing|old|first|original|present)\\s+(?:re-?design|design|layout|look|home[ -]?page|version|one|site|website|store|structure|style)";
/** A negation just before a word ("didn't like", "not happy with"). */
const NOT_BEFORE =
  "(?<!\\b(?:not|never|didn't|didnt|don't|dont|did not|do not)\\s+(?:really\\s+)?)";

/**
 * ★★ WORDS THAT ASK TO KEEP OR REUSE THE DESIGN (review fix, 25 Oct): "keep
 * the same layout as my last redesign, only change the colours", "same
 * homepage structure as before", "I liked the last design, keep it the
 * same", "don't change the layout". Such a merchant asked about every choice
 * makeDistinct could make, so it makes none. A new chat cannot refine an
 * older card, so a full redesign is how a merchant asks for the same layout
 * with new colours. ★ "Didn't like the last design" is not a keep, and an
 * earlier thing that is not a design ("like the old mill") is not one.
 */
const KEEP_DESIGN_WORDS: readonly RegExp[] = [
  // keep / retain / reuse / stick with ... the layout, design, look
  new RegExp(
    `\\b(?:keep(?:s|ing)?|retain(?:s|ing)?|preserv(?:e|es|ing)|re-?us(?:e|es|ing)|stick(?:s|ing)? with|stay(?:s|ing)? with)\\b(?:[\\s,]+[\\w'-]+){0,3}?[\\s,]+${DESIGN_NOUN}\\b`,
    "i",
  ),
  // keep it the same, keep the rest, leave the layout alone
  /\bkeep(?:s|ing)?\s+(?:it|this|that|things|everything|all)\s+(?:the same|as (?:it|they) (?:is|are|was|were)|as is|unchanged|like (?:that|before|now|last time))\b|\bkeep(?:s|ing)?\s+the rest(?:\s+(?:the same|as it is|as is|unchanged))?(?=\s*(?:[.,;!?]|$))/i,
  new RegExp(
    `\\bleav(?:e|es|ing)\\s+(?:the |my |our |this )?(?:${DESIGN_NOUN}|it|everything)\\s+(?:alone|as (?:it|they) (?:is|are)|as is|unchanged|the same|untouched)\\b`,
    "i",
  ),
  // the same / an identical layout, the same homepage structure
  new RegExp(
    `\\b(?:same|identical|unchanged)\\b(?:\\s+[\\w'-]+){0,2}?\\s+${DESIGN_NOUN}\\b`,
    "i",
  ),
  // the layout as before, the design unchanged
  new RegExp(
    `\\b${DESIGN_NOUN}(?:\\s+[\\w'-]+){0,2}?\\s+(?:the same|unchanged|as before|like before|as last time|like last time)\\b`,
    "i",
  ),
  // as before, like last time, same as now
  /\b(?:as|like)\s+(?:before|last time)\b|\bsame as\s+(?:before|last time|now)\b/i,
  // similar to / based on / as in the previous design
  new RegExp(
    `\\b(?:as in|as with|similar to|based on|same as|close to|matching)\\s+(?:the |my |our |this |that )?${EARLIER_DESIGN}\\b`,
    "i",
  ),
  // I liked the last design, a look like the previous one
  new RegExp(
    `${NOT_BEFORE}\\b(?:lik(?:e|ed|es)|lov(?:e|ed|es)|happy with|pleased with)\\s+(?:the |my |our |this |that )?${EARLIER_DESIGN}\\b`,
    "i",
  ),
  // don't change the layout, without changing the homepage, no changes to it
  new RegExp(
    `\\b(?:don't|dont|do not|never|without|no|avoid)\\s+(?:chang|alter|touch|rearrang|mov|redo)\\w*(?:\\s+[\\w'-]+){0,2}?\\s+${DESIGN_NOUN}\\b`,
    "i",
  ),
  // "Pehle jaisa" (as before) and "wahi design" (the same design), the
  // Hindi a merchant writes in Latin letters.
  /\b(?:pe?hle|pahle)\s+jais[aei]\b|\b(?:wahi|vahi|wohi)\s+(?:design|layout|look|style|home ?page)\b/i,
];

/**
 * A letter outside the Latin script (Devanagari, Tamil, Arabic and the
 * rest): the word lists here are English, so such words cannot be read.
 */
const NON_LATIN_LETTER = /(?=\p{L})\P{Script=Latin}/u;

/** The avoid field asks to keep what it names ("changing the layout"). */
const AVOID_CHANGE = new RegExp(
  `\\b(?:chang|alter|touch|rearrang|redo)\\w*(?:\\s+[\\w'-]+){0,2}?\\s+${DESIGN_NOUN}\\b`,
  "i",
);

/** Every piece of the merchant's own words in a request. */
function requestText(request: RevampRequest): string {
  const brief = isRecord(request.brief) ? request.brief : ({} as Json);
  const parts: unknown[] = [
    brief.business,
    brief.look,
    brief.audience,
    brief.avoid,
    ...(Array.isArray(brief.facts) ? brief.facts : []),
    request.instruction,
  ];
  return parts.filter((part) => typeof part === "string").join("\n");
}

/**
 * The choices the merchant's words name (the brief's business, look,
 * audience, facts and what to avoid, and a refinement's instruction): never
 * changed by makeDistinct, so a merchant who asked for their fonts or their
 * colours keeps them. The palette itself is never changed at all.
 * ★★ EVERY CHOICE when the words ask to keep or reuse the design
 *   (`KEEP_DESIGN_WORDS`, or the avoid field naming a change to it), and when
 *   they hold a letter outside the Latin script: the lists are English, and
 *   a false match only keeps the planner's choice.
 */
export function revampRequestedChoices(
  request: RevampRequest,
): ReadonlySet<RevampDistinctChoice> {
  const text = requestText(request);
  const brief = isRecord(request.brief) ? request.brief : ({} as Json);
  const avoid = typeof brief.avoid === "string" ? brief.avoid : "";
  if (
    NON_LATIN_LETTER.test(text) ||
    KEEP_DESIGN_WORDS.some((words) => words.test(text)) ||
    AVOID_CHANGE.test(avoid)
  ) {
    return new Set(REVAMP_DISTINCT_CHOICES);
  }
  return new Set(
    REVAMP_DISTINCT_CHOICES.filter((choice) =>
      REQUEST_WORDS[choice].test(text),
    ),
  );
}

/**
 * The sections a redesign keeps as the merchant has them (the snapshot's
 * merchant sections and custom code, the compiler's rule): never changed.
 */
export function revampKeptSectionIds(
  snapshot: Pick<RevampSnapshot, "pages">,
): Set<string> {
  const out = new Set<string>();
  for (const page of snapshot.pages ?? []) {
    for (const section of page.sections ?? []) {
      if (
        page.owners?.[section.id] === "merchant" ||
        section.type === "custom_code"
      ) {
        out.add(section.id);
      }
    }
  }
  return out;
}

export interface RevampDistinctContext {
  /** With the redesign's id, seeds every pick: same store, same answer. */
  storeId: string;
  revampId: string;
  /** Sections never changed: `revampKeptSectionIds(snapshot)`. */
  keptSectionIds: Iterable<string>;
}

export interface RevampDistinctChange {
  choice: RevampDistinctChoice;
  /** Closed words only (schemes, sides, heights, variants, pairing keys). */
  from: string;
  to: string;
}

/**
 * What the check did, content-free (numbers and closed words), for the job's
 * usage or result JSON and the log line.
 *   not-compared  no earlier redesign of this store to compare with
 *   refinement    a refinement keeps its parent's design: never changed
 *   distinct      already at least the bar from every earlier redesign
 *   changed       was too close; changed until it cleared the bar
 *   too-close     the choices it may change ran out first: the best plan
 *                 is kept and the redesign goes on (never failed)
 *   error         the check itself failed: the plan is kept as it was
 */
export interface RevampDistinctReport {
  status:
    | "not-compared"
    | "refinement"
    | "distinct"
    | "changed"
    | "too-close"
    | "error";
  passed: boolean;
  bar: number | null;
  /** The distance to each earlier redesign compared, in the order given. */
  before: number[];
  after: number[];
  changed: RevampDistinctChange[];
  /**
   * Choices never changed: the ones the merchant's words name, and the
   * store-wide card and fonts when the merchant named the pages to redo.
   */
  kept: RevampDistinctChoice[];
}

export interface RevampDistinctResult {
  plan: RevampSitePlan;
  report: RevampDistinctReport;
}

interface Score {
  distances: number[];
  /** How far short of the bar the plan is, summed over earlier plans. */
  shortfall: number;
}

interface Step {
  plan: RevampSitePlan;
  score: Score;
  from: string;
  to: string;
}

interface Candidate {
  plan: RevampSitePlan;
  to: string;
  preferred?: boolean;
}

interface Lever {
  theme: ThemeDefinition;
  plan: RevampSitePlan;
  score: Score;
  earlier: readonly RevampSitePlan[];
  bar: number;
  seed: string;
  kept: ReadonlySet<string>;
  measure: (plan: RevampSitePlan) => Score;
}

/**
 * The candidate that brings the plan closest to clearing the bar: the least
 * shortfall, then (when any) the ones the plan's direction suits, then a
 * seeded pick. Only a strict improvement is a step; none is null.
 */
function bestStep(
  lever: Lever,
  candidates: readonly Candidate[],
  from: string,
): Step | null {
  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: lever.measure(candidate.plan),
    }))
    .filter(
      (candidate) =>
        candidate.score.shortfall < lever.score.shortfall - EPSILON,
    );
  if (!scored.length) return null;
  const least = Math.min(...scored.map((c) => c.score.shortfall));
  let tier = scored.filter((c) => c.score.shortfall <= least + EPSILON);
  if (tier.some((c) => c.preferred)) tier = tier.filter((c) => c.preferred);
  const chosen = revampSeededPick(lever.seed, tier);
  return { plan: chosen.plan, score: chosen.score, from, to: chosen.to };
}

function homeIndex(plan: RevampSitePlan): number {
  return plan.pages.findIndex(
    (page) =>
      isRecord(page) && page.slug === "" && Array.isArray(page.sections),
  );
}

/** The plan with its homepage's sections replaced (nothing else copied). */
function withHome(
  plan: RevampSitePlan,
  index: number,
  sections: PageSectionItem[],
): RevampSitePlan {
  const pages = [...plan.pages];
  pages[index] = { ...pages[index], sections };
  return { ...plan, pages };
}

/** Indexes of the shown sections, in page order. */
function shownIndexes(sections: readonly PageSectionItem[]): number[] {
  const out: number[] = [];
  sections.forEach((section, i) => {
    if (section.enabled !== false) out.push(i);
  });
  return out;
}

/** Schemes whose text, muted text, cards and buttons read in this plan's
 * colours, both as the theme declares the band and as the colours derive
 * it (the compiler judges the derived soft and tint bands). */
function readableSchemes(lever: Lever): SectionScheme[] {
  const own = ownDesign(lever.plan);
  const brand = lever.theme.preset.brand.primaryColor;
  const rendered = withPaletteOverrides(
    schemeDesignFor(lever.theme.preset.design),
    own.palette,
  );
  const derived: SchemeDesign = { palette: rendered.palette };
  return SECTION_SCHEMES.filter((id) =>
    [rendered, derived].every(
      (design) =>
        schemeContrastIssues(id, resolveScheme(id, design, brand)).length === 0,
    ),
  );
}

function withScheme(
  section: PageSectionItem,
  scheme: SectionScheme | null,
): PageSectionItem {
  const style: SectionStyle = { ...(section.style ?? {}) };
  if (scheme) {
    style.scheme = scheme;
    if (!style.padding_y) style.padding_y = "md";
  } else {
    delete style.scheme;
  }
  const clean = validateSectionStyle(style, section.type);
  const next: PageSectionItem = { ...section };
  if (clean) next.style = clean;
  else delete next.style;
  return next;
}

function combinations(items: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, chosen: number[]) => {
    if (chosen.length === size) {
      out.push(chosen);
      return;
    }
    for (let i = start; i < items.length; i++)
      walk(i + 1, [...chosen, items[i]]);
  };
  walk(0, []);
  return out;
}

/** A quiet band (soft, tint) or a strong one (accent, inverse). */
const bandWeight = (scheme: SectionScheme) =>
  scheme === "soft" || scheme === "tint" ? "quiet" : "strong";

/**
 * The scheme sequences a rhythm may give the plan's own bands: from the
 * allowed schemes, with as many quiet and as many strong bands as the plan
 * chose, so the page never turns darker or louder than its look (the colours
 * the merchant asked for shaped that mix); with `exact`, the plan's own
 * schemes only trade places.
 */
function schemeSequences(
  allowed: readonly SectionScheme[],
  own: readonly SectionScheme[],
  exact: boolean,
): SectionScheme[][] {
  const mix = (list: readonly SectionScheme[]) =>
    list
      .map(exact ? (scheme) => scheme : bandWeight)
      .sort()
      .join(",");
  const target = mix(own);
  const out: SectionScheme[][] = [];
  const walk = (chosen: SectionScheme[]) => {
    if (chosen.length === own.length) {
      if (mix(chosen) === target) out.push(chosen);
      return;
    }
    for (const scheme of allowed) walk([...chosen, scheme]);
  };
  walk([]);
  return out;
}

/**
 * ★ BOUNDED, WHATEVER THE HOMEPAGE: the bands move among the first 12
 *   sections that may wear one (a band further down stays where it is), and
 *   at most 48 rhythms are measured, so the whole check stays a few
 *   milliseconds even on a 40-section page.
 */
export const REVAMP_RHYTHM_WINDOW = 12;
export const REVAMP_RHYTHM_CANDIDATES_MAX = 48;

/** Pairs of (position set, scheme sequence) to measure: every pair when
 * they are few, else an even walk over both lists (a fixed walk, the same
 * for every store; the seed only picks among the best). */
function rhythmPairs(sets: number, sequences: number): Array<[number, number]> {
  if (sets * sequences <= REVAMP_RHYTHM_CANDIDATES_MAX) {
    const all: Array<[number, number]> = [];
    for (let s = 0; s < sets; s++)
      for (let q = 0; q < sequences; q++) all.push([s, q]);
    return all;
  }
  const out = new Map<string, [number, number]>();
  for (let t = 0; t < REVAMP_RHYTHM_CANDIDATES_MAX; t++) {
    const pair: [number, number] = [
      t % sets,
      (t * 7 + Math.floor(t / sets)) % sequences,
    ];
    out.set(pair.join(":"), pair);
  }
  return [...out.values()];
}

/**
 * Band rhythm: the same number of colour bands as the plan's own, with as
 * many quiet and strong ones, on other sections or in other schemes. The
 * rules the compiler holds: never the opening, never a section that cannot
 * wear a scheme, never two neighbours in the same scheme, at most three bands
 * on the page with the kept ones counted first, a scheme band has padding;
 * only schemes that read in the plan's colours; the merchant's sections never
 * change.
 */
function bandRhythm(lever: Lever): Step | null {
  const index = homeIndex(lever.plan);
  if (index < 0) return null;
  const sections = lever.plan.pages[index].sections;
  const order = shownIndexes(sections);
  if (order.length < 3) return null;
  const eligible = order
    .slice(1)
    .filter(
      (i) =>
        !lever.kept.has(sections[i].id) &&
        !SCHEMELESS_SECTION_TYPES.includes(sections[i].type),
    )
    .slice(0, REVAMP_RHYTHM_WINDOW);
  const schemeOf = (i: number) => {
    const scheme = sections[i].style?.scheme;
    return isSectionScheme(scheme) ? scheme : null;
  };
  const size = eligible.filter((i) => schemeOf(i)).length;
  const fixedBands = order.filter(
    (i) => !eligible.includes(i) && schemeOf(i),
  ).length;
  if (size === 0 || size > eligible.length || fixedBands + size > 3)
    return null;
  const current = eligible.map(schemeOf);
  const own = current.filter((scheme): scheme is SectionScheme => !!scheme);
  // ★ A plan with no look of its own keeps the store's colours, which this
  //   module cannot see, so no band can be judged readable: its own bands
  //   only move and trade places, and no new scheme is brought in.
  const keepsLook = !hasDesignOverrides(ownDesign(lever.plan));
  const allowed = keepsLook ? SECTION_SCHEMES : readableSchemes(lever);
  if (!allowed.length) return null;
  const words = (assignment: Array<SectionScheme | null>) =>
    assignment.map((scheme) => scheme ?? "-").join(",");
  const position = new Map(order.map((i, at) => [i, at]));
  const spaced = (set: number[]) =>
    set.every(
      (i, at) => at === 0 || position.get(i)! - position.get(set[at - 1])! > 1,
    );
  const all = combinations(eligible, size);
  const apart = all.filter(spaced);
  const sets = apart.length ? apart : all;
  const sequences = schemeSequences(allowed, own, keepsLook);
  const candidates: Candidate[] = [];
  for (const [s, q] of rhythmPairs(sets.length, sequences.length)) {
    const assignment = eligible.map((i) => {
      const at = sets[s].indexOf(i);
      return at < 0 ? null : sequences[q][at];
    });
    if (words(assignment) === words(current)) continue;
    const scheme = (i: number) => {
      const at = eligible.indexOf(i);
      return at < 0 ? schemeOf(i) : assignment[at];
    };
    if (
      order.some(
        (i, at) => at > 0 && scheme(i) && scheme(i) === scheme(order[at - 1]),
      )
    )
      continue;
    const next = sections.map((section, i) => {
      const at = eligible.indexOf(i);
      return at < 0 || assignment[at] === current[at]
        ? section
        : withScheme(section, assignment[at]);
    });
    candidates.push({
      plan: withHome(lever.plan, index, next),
      to: words(assignment),
    });
  }
  return bestStep(lever, candidates, words(current));
}

const SIDE_PATTERNS = [
  "alternate-left",
  "alternate-right",
  "left",
  "right",
] as const;

function sidesFor(
  pattern: (typeof SIDE_PATTERNS)[number],
  count: number,
): Array<"left" | "right"> {
  return Array.from({ length: count }, (_, i) => {
    if (pattern === "left" || pattern === "right") return pattern;
    const first = pattern === "alternate-left" ? "left" : "right";
    const other = first === "left" ? "right" : "left";
    return i % 2 === 0 ? first : other;
  });
}

/**
 * Image sides: the plan's own image-beside-text bands (media and text
 * sections and their stories, product spotlights) laid out another way, from
 * a closed list of patterns. ★ Theme Studio's fingerprint cannot see a side,
 * so this step never moves the distance: it is taken only when the homepage
 * repeats the image sides of an earlier redesign it is too close to, which a
 * shopper does see.
 */
function imageSidesStep(lever: Lever): Step | null {
  const index = homeIndex(lever.plan);
  if (index < 0) return null;
  const sections = lever.plan.pages[index].sections;
  const slots: Array<{ section: number; story: number | null }> = [];
  for (const i of shownIndexes(sections)) {
    if (lever.kept.has(sections[i].id)) continue;
    const c = config(sections[i]);
    if (sections[i].type === "media_text") {
      slots.push({ section: i, story: null });
      (Array.isArray(c.stories) ? c.stories : []).forEach((_, story) =>
        slots.push({ section: i, story }),
      );
    } else if (sections[i].type === "product_spotlight") {
      slots.push({ section: i, story: null });
    }
  }
  if (!slots.length) return null;
  const pattern = (plan: RevampSitePlan) =>
    imageSides(planHome(plan) ?? []).join(",");
  const now = pattern(lever.plan);
  const close = lever.earlier.filter(
    (_, i) => lever.score.distances[i] < lever.bar - EPSILON,
  );
  if (!close.some((plan) => pattern(plan) === now)) return null;
  const used = new Set(lever.earlier.map(pattern));
  const candidates: Candidate[] = [];
  const seen = new Set<string>([now]);
  for (const name of SIDE_PATTERNS) {
    const sides = sidesFor(name, slots.length);
    const next = sections.map((section) => section);
    slots.forEach((slot, at) => {
      const section = next[slot.section];
      const c = { ...config(section) };
      if (slot.story === null) {
        c.media_position = sides[at];
      } else {
        const stories = [...(c.stories as unknown[])];
        stories[slot.story] = {
          ...(isRecord(stories[slot.story])
            ? (stories[slot.story] as Json)
            : {}),
          media_position: sides[at],
        };
        c.stories = stories;
      }
      next[slot.section] = {
        ...section,
        config: c as unknown as PageSectionItem["config"],
      };
    });
    const plan = withHome(lever.plan, index, next);
    const words = pattern(plan);
    if (seen.has(words)) continue;
    seen.add(words);
    candidates.push({ plan, to: words, preferred: !used.has(words) });
  }
  if (!candidates.length) return null;
  const preferred = candidates.filter((c) => c.preferred);
  const chosen = revampSeededPick(
    lever.seed,
    preferred.length ? preferred : candidates,
  );
  return {
    plan: chosen.plan,
    score: lever.measure(chosen.plan),
    from: now,
    to: chosen.to,
  };
}

/** The opening's heights a redesign uses (the compiler's rule). */
const OPENING_HEIGHTS = ["large", "screen"] as const;

/** Opening height: the plan's own photo opening, large or screen high. */
function openingHeight(lever: Lever): Step | null {
  const index = homeIndex(lever.plan);
  if (index < 0) return null;
  const sections = lever.plan.pages[index].sections;
  const first = shownIndexes(sections)[0];
  if (first === undefined) return null;
  const opening = sections[first];
  if (
    lever.kept.has(opening.id) ||
    (opening.type !== "hero" && opening.type !== "hero_carousel")
  )
    return null;
  const c = config(opening);
  const now = typeof c.height === "string" ? c.height : "auto";
  const candidates = OPENING_HEIGHTS.filter((height) => height !== now).map(
    (height) => {
      const next = [...sections];
      next[first] = {
        ...opening,
        config: { ...c, height } as unknown as PageSectionItem["config"],
      };
      return { plan: withHome(lever.plan, index, next), to: height };
    },
  );
  return bestStep(lever, candidates, now);
}

/** The direction's own words name a card style ("framed or overlay cards"). */
function directionSuitsCard(direction: unknown, card: string): boolean {
  if (!(DESIGN_DIRECTION_IDS as readonly unknown[]).includes(direction))
    return false;
  const styles = DESIGN_DIRECTIONS[direction as DesignDirection].styles;
  return new RegExp(`\\b${card}(?:\\s+or\\s+\\w+)?\\s+cards\\b`).test(styles);
}

/**
 * Card style: only a card the plan itself chose (a plan that keeps the
 * store's card may be keeping the merchant's own choice), never the grocery
 * card (a whole storefront treatment, not a card).
 */
function cardStyle(lever: Lever): Step | null {
  const appearance = isRecord(lever.plan.appearance)
    ? lever.plan.appearance
    : {};
  const now = appearance.card;
  if (!(LAYOUT_VARIANT_ENUMS.card as readonly unknown[]).includes(now))
    return null;
  const candidates = LAYOUT_VARIANT_ENUMS.card
    .filter((card) => card !== now && card !== "grocery")
    .map((card) => ({
      plan: {
        ...lever.plan,
        appearance: { ...lever.plan.appearance, card },
      },
      to: card,
      preferred: directionSuitsCard(lever.plan.direction, card),
    }));
  return bestStep(lever, candidates, now as string);
}

/**
 * Font pairing: another pairing from the library, the ones the plan's
 * direction suits first. ★ Only when the plan already has a look of its own:
 * a plan that keeps the store's look keeps its colours too, and a design of
 * fonts alone would replace the merchant's colours with the theme's.
 */
function fontPairing(lever: Lever): Step | null {
  const own = ownDesign(lever.plan);
  if (!hasDesignOverrides(own)) return null;
  const now = pairingOf(own.fonts);
  const candidates = FONT_PAIRING_KEYS.filter(
    (key) =>
      key !== now &&
      !(
        FONT_PAIRINGS[key].body === own.fonts.body &&
        FONT_PAIRINGS[key].display === own.fonts.display
      ),
  ).map((key) => ({
    plan: {
      ...lever.plan,
      design: {
        ...lever.plan.design,
        fonts: {
          body: FONT_PAIRINGS[key].body,
          display: FONT_PAIRINGS[key].display,
        },
      },
    },
    to: key,
    preferred: (FONT_PAIRINGS[key].directions as readonly string[]).includes(
      lever.plan.direction,
    ),
  }));
  return bestStep(lever, candidates, now ?? "the theme's");
}

const STEPS: Record<RevampDistinctChoice, (lever: Lever) => Step | null> = {
  bandRhythm,
  imageSides: imageSidesStep,
  openingHeight,
  cardStyle,
  fontPairing,
};

function distinct(
  theme: ThemeDefinition,
  plan: RevampSitePlan,
  earlierValues: readonly unknown[],
  request: RevampRequest,
  context: RevampDistinctContext,
): RevampDistinctResult {
  const bar = revampDistinctnessBar(theme);
  const asked = new Set(revampRequestedChoices(request));
  // ★ A redesign of the pages the merchant named keeps the store-wide look:
  //   the card and the fonts belong to every page, not to the named ones.
  if (Array.isArray(request.pages)) {
    asked.add("cardStyle");
    asked.add("fontPairing");
  }
  const kept = REVAMP_DISTINCT_CHOICES.filter((choice) => asked.has(choice));
  const earlier = earlierValues
    .map(revampEarlierPlan)
    .filter((value): value is RevampSitePlan => value !== null)
    .slice(0, REVAMP_EARLIER_PLANS_MAX);
  const report = (
    status: RevampDistinctReport["status"],
    before: Score,
    after: Score,
    changed: RevampDistinctChange[] = [],
  ): RevampDistinctReport => ({
    status,
    passed: after.shortfall <= EPSILON,
    bar,
    before: before.distances.map(round3),
    after: after.distances.map(round3),
    changed,
    kept,
  });
  const earlierPrints = earlier.map((other) => revampFingerprint(theme, other));
  // ★ One applied design per (design, appearance) pair: the band rhythm's
  //   candidates share both objects with the plan, so the check stays well
  //   under 10 ms (revampFingerprint is the same function, uncached).
  const designs = new WeakMap<object, WeakMap<object, ThemeDesign>>();
  const designOf = (candidate: RevampSitePlan): ThemeDesign => {
    const design: unknown = candidate.design;
    const appearance: unknown = candidate.appearance;
    if (!isRecord(design) || !isRecord(appearance)) {
      return appliedDesign(theme, candidate);
    }
    let byAppearance = designs.get(design);
    if (!byAppearance) {
      byAppearance = new WeakMap();
      designs.set(design, byAppearance);
    }
    let applied = byAppearance.get(appearance);
    if (!applied) {
      applied = appliedDesign(theme, candidate);
      byAppearance.set(appearance, applied);
    }
    return applied;
  };
  const measure = (candidate: RevampSitePlan): Score => {
    const print = fingerprintWith(
      theme,
      designOf(candidate),
      planHome(candidate) ?? themeHome(theme),
    );
    const distances = earlierPrints.map((other) =>
      fingerprintDistance(print, other),
    );
    return {
      distances,
      shortfall: distances.reduce(
        (sum, distance) => sum + Math.max(0, bar - distance),
        0,
      ),
    };
  };
  const start = measure(plan);
  if (!earlier.length) {
    return { plan, report: report("not-compared", start, start) };
  }
  if (request.kind === "refine") {
    return { plan, report: report("refinement", start, start) };
  }
  if (start.shortfall <= EPSILON) {
    return { plan, report: report("distinct", start, start) };
  }
  const keptIds = new Set(context.keptSectionIds);
  let current = plan;
  let score = start;
  const changed: RevampDistinctChange[] = [];
  // ★ BOUNDED: each choice is tried once, in this order. Past the bar no
  //   step can improve the plan (bestStep takes only a strict gain, and the
  //   image sides act only on a repeat of a plan still too close), so the
  //   break only saves the work.
  for (const choice of REVAMP_DISTINCT_CHOICES) {
    if (score.shortfall <= EPSILON) break;
    if (asked.has(choice)) continue;
    const step = STEPS[choice]({
      theme,
      plan: current,
      score,
      earlier,
      bar,
      // U1's picker, salted per choice: "<store>:<redesign>|distinct|<choice>".
      seed: `${revampDesignSeed(context.storeId, context.revampId)}|distinct|${choice}`,
      kept: keptIds,
      measure,
    });
    if (!step) continue;
    current = step.plan;
    score = step.score;
    changed.push({ choice, from: step.from, to: step.to });
  }
  return {
    plan: current,
    report: report(
      score.shortfall <= EPSILON ? "changed" : "too-close",
      start,
      score,
      changed,
    ),
  };
}

/**
 * Keep a new redesign at least the bar (`revampDistinctnessBar`) from each of
 * this store's earlier redesigns (up to five, all measured over the store's
 * current theme). When it is closer, change only what the merchant did not
 * ask about, in this order, each from its closed list with a pick seeded by
 * the store and the redesign: band rhythm, image sides, opening height, card
 * style, font pairing. Each is tried once and taken only when it brings the
 * plan nearer the bar, and the steps stop as soon as it clears it.
 * ★ NEVER FAILS A REDESIGN: a plan that cannot clear the bar is kept at its
 *   best ("too-close"), and a check that throws keeps the plan as it was
 *   ("error"). Never changes words, products, links, shots, the palette or
 *   the merchant's sections; never mutates its input. A refinement keeps its
 *   parent's design and is never changed.
 */
export function makeDistinct(
  theme: ThemeDefinition,
  plan: RevampSitePlan,
  earlier: readonly unknown[],
  request: RevampRequest,
  context: RevampDistinctContext,
): RevampDistinctResult {
  try {
    return distinct(theme, plan, earlier, request, context);
  } catch {
    return {
      plan,
      report: {
        status: "error",
        passed: false,
        bar: null,
        before: [],
        after: [],
        changed: [],
        kept: [],
      },
    };
  }
}

/** The statuses of a check that compared the plan with earlier redesigns. */
const COMPARED_STATUSES: ReadonlySet<string> = new Set([
  "distinct",
  "changed",
  "too-close",
]);

/** A check's report as the job keeps it (choice names read back as text). */
export interface RevampDistinctReportLike {
  status: string;
  before: readonly number[];
  changed: ReadonlyArray<{ choice: string; from: string; to: string }>;
  kept: readonly string[];
}

const isDistinctChoice = (value: string): value is RevampDistinctChoice =>
  (REVAMP_DISTINCT_CHOICES as readonly string[]).includes(value);

/**
 * ★★ THE PLAN SHOPPERS SEE IS THE PLAN MEASURED (review fix, 25 Oct). The
 * check runs on the compiled plan before the budget fit, so the uncut copy
 * kept for a later re-fit carries its changes; the fit can then drop what the
 * check counted on (a balance too small for the design drops the colours,
 * fonts and corners; a photograph left out can take its section), while the
 * earlier redesigns it is compared with are the plans their cards showed.
 * So the fitted plan is checked again against the same earlier redesigns:
 * what is still too close is changed by the same rules (a dropped design
 * leaves no font pairing to change, and nothing here costs a credit), and
 * the report's distances and verdict are the fitted plan's. `first` is the
 * report of the check before the fit; one that compared nothing (no earlier
 * redesign, a refinement, a skipped or failed check) is kept as it is (null).
 * Each choice is reported once, from the planner's value to the one shown.
 * Never fails: a second check that throws keeps the fitted plan and reports
 * "error".
 */
export function makeDistinctAfterFit(
  theme: ThemeDefinition,
  fitted: RevampSitePlan,
  earlier: readonly unknown[],
  request: RevampRequest,
  context: RevampDistinctContext,
  first: RevampDistinctReportLike,
): RevampDistinctResult | null {
  if (!COMPARED_STATUSES.has(first.status)) return null;
  const second = makeDistinct(theme, fitted, earlier, request, context);
  if (!COMPARED_STATUSES.has(second.report.status)) return second;
  const byChoice = new Map<RevampDistinctChoice, RevampDistinctChange>();
  for (const change of [...first.changed, ...second.report.changed]) {
    if (!isDistinctChoice(change.choice)) continue;
    const known = byChoice.get(change.choice);
    byChoice.set(change.choice, {
      choice: change.choice,
      from: known ? known.from : change.from,
      to: change.to,
    });
  }
  const changed = REVAMP_DISTINCT_CHOICES.flatMap((choice) => {
    const change = byChoice.get(choice);
    return change && change.from !== change.to ? [change] : [];
  });
  const kept = new Set<string>([...first.kept, ...second.report.kept]);
  const passed = second.report.passed;
  return {
    plan: second.plan,
    report: {
      status: passed ? (changed.length ? "changed" : "distinct") : "too-close",
      passed,
      bar: second.report.bar,
      before: [...first.before],
      after: second.report.after,
      changed,
      kept: REVAMP_DISTINCT_CHOICES.filter((choice) => kept.has(choice)),
    },
  };
}
