import { EMPTY_CONFIG, HERO_HEIGHTS } from "@/lib/homepage/section-types";
import {
  SCHEMELESS_SECTION_TYPES,
  SECTION_SCHEMES,
} from "@/lib/themes/schemes";

/** Visible native settings must be authored, rather than copied from create-mode
 * presets. Ordinary registry validation still owns content and valid values. */
/** The hero variants prompts before v26 were written with; a persisted paid
 * request prints exactly these (prompt-features.ts). */
export const LEGACY_HERO_VARIANTS = ["banner", "split", "minimal"] as const;
/** v26 to v30: the full-bleed opening joined the three; v31 (plan Phase 2d)
 * adds stacked and offset. */
export const V26_HERO_VARIANTS = [
  ...LEGACY_HERO_VARIANTS,
  "fullbleed",
] as const;

export const VISIBLE_SECTION_CHOICES: Readonly<
  Record<string, Readonly<Record<string, readonly unknown[]>>>
> = {
  hero: {
    variant: [...V26_HERO_VARIANTS, "stacked", "offset"],
    height: HERO_HEIGHTS,
    theme: ["dark", "light"],
    alignment: ["left", "center"],
  },
  hero_carousel: {
    height: HERO_HEIGHTS,
    autoplay: [true, false],
    interval_seconds: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  },
  featured_products: {
    limit: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  },
  shop_by_category: {
    // "list" (plan Phase 2c's collection list, each category a row with its
    // description) prints from v32; the compiler accepts it at every version.
    display: ["circles", "cards", "list"],
    layout: ["scroll", "grid"],
  },
  promo_banner: {
    alignment: ["left", "center", "right"],
    theme: ["dark", "light"],
  },
  tile_grid: { columns: [2, 3, 4], height: ["sm", "md", "lg"] },
  media_text: {
    media_position: ["left", "right"],
    media_ratio: ["portrait", "square", "landscape"],
    alignment: ["left", "center"],
  },
  gallery: {
    layout: ["grid", "editorial"],
    columns: [2, 3, 4],
    image_ratio: ["portrait", "square", "landscape"],
  },
  testimonials: { layout: ["cards", "editorial"], columns: [2, 3] },
  newsletter: { theme: ["dark", "light"], alignment: ["left", "center"] },
  usp_bar: { theme: ["dark", "light"] },
  ticker: { speed: ["slow", "medium", "fast"], theme: ["dark", "light"] },
  faq_accordion: { show_filters: [true, false] },
  accordion: { open_first: [true, false], allow_multiple: [true, false] },
  comparison: { style: ["table", "cards"] },
  // ⚠ tile_grid.layout is deliberately NOT a required choice: a v29 draft
  // replayed from its paid checkpoint has no such key, and the compiler's
  // defaults make it "grid".
  multicolumn: { columns: [2, 3, 4], alignment: ["left", "center"] },
  image_marquee: {
    speed: ["slow", "medium", "fast"],
    size: ["sm", "md", "lg"],
    image_ratio: ["square", "landscape", "portrait"],
  },
  image_hotspots: { image_ratio: ["landscape", "square", "portrait"] },
  before_after: { image_ratio: ["landscape", "square", "portrait"] },
  product_spotlight: { media_position: ["left", "right"] },
  rich_text: { width: ["contained", "full"] },
};

/** The two category displays prompts before v32 were written with. */
export const LEGACY_CATEGORY_DISPLAYS = ["circles", "cards"] as const;

/** The choices a Stage B prompt prints. Pre-v26 requests keep the three hero
 * variants they were written with, byte for byte, and v26 to v30 requests the
 * four; pre-v32 requests keep the two category displays. The compiler
 * accepts the full lists at every version, since a stored answer never names
 * a value its prompt did not offer. */
export function visibleSectionChoices(
  fullBleedOpening: boolean,
  moreVariants = true,
  templates = true,
): typeof VISIBLE_SECTION_CHOICES {
  if (fullBleedOpening && moreVariants && templates)
    return VISIBLE_SECTION_CHOICES;
  return {
    ...VISIBLE_SECTION_CHOICES,
    hero: {
      ...VISIBLE_SECTION_CHOICES.hero,
      variant:
        fullBleedOpening && moreVariants
          ? VISIBLE_SECTION_CHOICES.hero.variant
          : fullBleedOpening
            ? V26_HERO_VARIANTS
            : LEGACY_HERO_VARIANTS,
    },
    shop_by_category: {
      ...VISIBLE_SECTION_CHOICES.shop_by_category,
      display: templates
        ? VISIBLE_SECTION_CHOICES.shop_by_category.display
        : LEGACY_CATEGORY_DISPLAYS,
    },
  };
}

export function sectionChoiceIssues(
  type: string,
  config: Record<string, unknown>,
  style: unknown,
): string[] {
  const issues: string[] = [];
  for (const [key, choices] of Object.entries(
    VISIBLE_SECTION_CHOICES[type] ?? {},
  )) {
    if (!Object.hasOwn(config, key) || !choices.includes(config[key]))
      issues.push(
        `Choose a supported visible style for ${type}.${key}: ${JSON.stringify(choices)}.`,
      );
  }
  const band = style as Record<string, unknown> | null;
  for (const key of [
    "padding",
    "width",
    ...(SCHEMELESS_SECTION_TYPES.includes(type) ? [] : ["scheme"]),
  ]) {
    // Null scheme explicitly chooses page colours; padding and width require a choice.
    if (
      !band ||
      !Object.hasOwn(band, key) ||
      (key !== "scheme" && band[key] === null)
    )
      issues.push(`Choose a visible section style for ${type}.style.${key}.`);
  }
  if (band && !["sm", "md", "lg"].includes(String(band.padding)))
    issues.push(`Choose sm, md or lg padding for ${type}.`);
  if (band && !["contained", "full"].includes(String(band.width)))
    issues.push(`Choose contained or full width for ${type}.`);
  if (
    band?.scheme !== null &&
    band?.scheme !== undefined &&
    !(SECTION_SCHEMES as readonly unknown[]).includes(band.scheme)
  )
    issues.push(`Choose a supported band scheme for ${type}.`);
  for (const item of Array.isArray(config.slides)
    ? config.slides
    : Array.isArray(config.tiles)
      ? config.tiles
      : []) {
    if (!item || !["dark", "light"].includes(item.theme))
      issues.push(
        `Choose dark or light text explicitly for each ${type} item.`,
      );
  }
  return issues;
}

export function nonVisualDefaults(
  type: keyof typeof EMPTY_CONFIG,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const visible = VISIBLE_SECTION_CHOICES[type] ?? {};
  return Object.fromEntries(
    Object.entries(defaults).filter(([key]) => !Object.hasOwn(visible, key)),
  );
}

export const REQUIRED_DESIGN_CHOICES = {
  layout: [
    "header",
    "card",
    "productDetail",
    "cart",
    "footer",
    "storefront",
    "gridColumnsMobile",
    "gridColumnsDesktop",
    "shopFilters",
    "stickyAddToCart",
    "cardHoverImage",
    "collectionBanner",
  ],
  typography: [
    "headingFont",
    "headingScale",
    "headingWeight",
    "headingCase",
    "headingTracking",
  ],
  buttons: [
    "shape",
    "primary",
    "secondary",
    "case",
    "weight",
    "tracking",
    "hover",
  ],
  page: ["width", "sectionGap", "gridGap"],
  motion: ["reveal"],
} as const;

export function explicitDraftStyleIssues(raw: unknown): string[] {
  const draft = raw as {
    design?: Record<string, Record<string, unknown>>;
    pages?: {
      sections?: { type: string; configJson: string; style: unknown }[];
    }[];
  } | null;
  const issues: string[] = [];
  for (const [group, keys] of Object.entries(REQUIRED_DESIGN_CHOICES))
    for (const key of keys) {
      if (
        draft?.design?.[group]?.[key] === undefined ||
        draft.design[group][key] === null
      )
        issues.push(
          `Choose a visible style for design.${group}.${key}; presets are not design decisions.`,
        );
    }
  for (const page of Array.isArray(draft?.pages) ? draft.pages : [])
    for (const section of Array.isArray(page?.sections) ? page.sections : []) {
      try {
        const config = JSON.parse(section.configJson);
        if (config && typeof config === "object" && !Array.isArray(config))
          issues.push(
            ...sectionChoiceIssues(section.type, config, section.style),
          );
      } catch {
        /* ordinary compiler owns malformed JSON */
      }
    }
  return issues;
}
