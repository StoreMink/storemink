/** Approved directions are guidance within the native renderer, never fixed
 * templates. The operator brief and reference design take precedence. */
export const PALETTE_FAMILIES = [
  "light",
  "dark",
  "colour-field",
  "tinted-neutral",
] as const;
export type PaletteFamily = (typeof PALETTE_FAMILIES)[number];
export const DESIGN_DIRECTIONS = {
  "luxury-minimal": {
    label: "Luxury minimal",
    palettes: ["light", "tinted-neutral"],
    type: "Instrument Serif or Fraunces headings; restrained sans body, wide tracking",
    styles:
      "airy, framed or overlay cards, outline primary controls with readable accent text, square corners, focused one-column mobile grid, no reveal motion; prefer collectionBanner false for a quiet category title followed directly by product photography",
    industries: ["jewelry-and-accessories", "beauty"],
  },
  "bold-and-loud": {
    label: "Bold and loud",
    palettes: ["dark", "colour-field"],
    type: "Stick No Bills condensed or Space Grotesk display; confident weight and case",
    styles:
      "split or colour-field hero, strong bands, tight product grid, restrained rise motion",
    industries: ["clothing", "shoes", "sports", "entertainment"],
  },
  "magazine-editorial": {
    label: "Magazine / editorial",
    palettes: ["light", "tinted-neutral"],
    type: "Instrument Serif or Fraunces display with readable Inter or Jost body",
    styles:
      "editorial galleries, alternating media stories, overlay cards, generous whitespace; prefer collectionBanner false when category cards and home stories already introduce the imagery, avoiding a repeated large banner on every collection",
    industries: ["clothing", "home", "art", "shoes"],
  },
  "dense-catalogue": {
    label: "Dense catalogue",
    palettes: ["light"],
    type: "Roboto or Inter, clear geometric hierarchy",
    styles:
      "market header, grocery or quick_add cards, 4–5 desktop columns, compact spacing and filters, horizontally scrolling categories, no reveal motion",
    industries: [
      "food-and-drink",
      "electronics",
      "hardware",
      "wholesale",
      "office",
    ],
  },
  "soft-and-natural": {
    label: "Soft and natural",
    palettes: ["tinted-neutral"],
    type: "Fraunces or soft Outfit headings; readable body",
    styles:
      "visibly sage, clay or mineral page fields (not a barely tinted white), rounded corners, circular categories, image/text stories, no reveal motion",
    industries: ["beauty", "wellness", "garden", "pets", "food-and-drink"],
  },
  "playful-and-colourful": {
    label: "Playful and colourful",
    palettes: ["colour-field"],
    type: "Outfit or Fraunces expressive display and friendly readable body",
    styles:
      "colourful page fields and tile grids, pill controls, circular scrolling categories, varied bands, restrained rise motion",
    industries: ["kids", "toys", "food-and-drink", "pets"],
  },
  "classic-and-trusted": {
    label: "Classic and trusted",
    palettes: ["light"],
    type: "Inter or Roboto, balanced scale and familiar hierarchy",
    styles:
      "balanced grid, clear USP bar, testimonials, conventional rhythm; collectionBanner true suits image-led category introductions",
    industries: ["general", "home", "automotive", "services", "office"],
  },
} as const;
export type DesignDirection = keyof typeof DESIGN_DIRECTIONS;
export const DESIGN_DIRECTION_IDS = Object.keys(
  DESIGN_DIRECTIONS,
) as DesignDirection[];

/**
 * Seven more directions, for Theme Studio from prompt v34 (plan Phase 4 item
 * 2; owner, 22 Nov 2026: themes must not look the same). With seven
 * directions every eighth theme repeated one; fourteen give the catalogue
 * twice the range before a hand repeats.
 *
 * ★ KEPT APART FROM `DESIGN_DIRECTIONS` ON PURPOSE. The storefront redesign
 *   (lib/mink/revamp) reads those seven, with a map of its own per direction
 *   and a plan schema that lists them; it keeps exactly what it had. Theme
 *   Studio reads `STUDIO_DESIGN_DIRECTIONS` (all fourteen) from v34, and the
 *   seven before it, so an earlier request replays byte for byte.
 */
export const EXTENDED_DESIGN_DIRECTIONS = {
  brutalist: {
    label: "Brutalist",
    palettes: ["light", "colour-field"],
    type: "Archivo, Space Grotesk or JetBrains Mono in heavy weights; raw sizes, no decoration",
    styles:
      "exposed grid, thick ink rules and frames, square corners, hard offset shadows, blunt uppercase labels, no gradients and no reveal motion",
    industries: ["clothing", "art", "entertainment", "electronics"],
  },
  "scandinavian-utility": {
    label: "Scandinavian utility",
    palettes: ["light", "tinted-neutral"],
    type: "Manrope, Figtree or DM Sans; calm weights and generous line height",
    styles:
      "pale wood-and-stone fields, generous whitespace, hairline dividers, soft small corners, quiet cards with plain names and prices, useful details first, no ornament",
    industries: ["home", "office", "kids", "garden", "hardware"],
  },
  "maximal-pattern": {
    label: "Maximal pattern",
    palettes: ["colour-field", "dark"],
    type: "Playfair Display, DM Serif Display or Bricolage Grotesque with expressive contrast",
    styles:
      "saturated bands in several schemes, collage tile grids, marquees, layered photographs, ornamental headings, rich section rhythm, rise motion",
    industries: ["clothing", "home", "art", "jewelry-and-accessories", "toys"],
  },
  "dark-luxury": {
    label: "Dark luxury",
    palettes: ["dark"],
    type: "Bodoni Moda, Cormorant Garamond or Italiana headings; fine tracked sans body",
    styles:
      "near-black page, light type, overlay or framed cards, thin metallic-toned rules, full-bleed photography, slow fades, restraint in every control",
    industries: ["jewelry-and-accessories", "beauty", "automotive", "clothing"],
  },
  "retro-catalogue": {
    label: "Retro catalogue",
    palettes: ["tinted-neutral", "colour-field"],
    type: "Marcellus, Lora or Oswald; printed-catalogue hierarchy with numbered or labelled items",
    styles:
      "warm paper field, ruled tables and comparison blocks, badges and stamps, product spotlights with captions, two-tone bands, no reveal motion",
    industries: ["food-and-drink", "hardware", "sports", "pets", "general"],
  },
  "tech-spec": {
    label: "Tech spec",
    palettes: ["dark", "light"],
    type: "Sora, Space Grotesk or JetBrains Mono headings with Inter body; precise and compact",
    styles:
      "specification-led product pages, comparison tables, hotspots on the product, accordions for details, sharp small corners, a single signal colour, fast fades",
    industries: ["electronics", "automotive", "hardware", "sports", "office"],
  },
  "artisan-craft": {
    label: "Artisan craft",
    palettes: ["tinted-neutral", "light"],
    type: "EB Garamond, Newsreader or Lora headings; warm readable body",
    styles:
      "maker's stories beside the products, before/after and process sections, textured earthy fields, hand-finished feel in soft irregular rhythm, gentle fades",
    industries: ["art", "home", "food-and-drink", "wellness", "garden"],
  },
} as const;

/** Every direction Theme Studio may choose from v34: the seven the redesign
 *  shares, then the seven above. */
export const STUDIO_DESIGN_DIRECTIONS = {
  ...DESIGN_DIRECTIONS,
  ...EXTENDED_DESIGN_DIRECTIONS,
} as const;
export type StudioDesignDirection = keyof typeof STUDIO_DESIGN_DIRECTIONS;
export const STUDIO_DESIGN_DIRECTION_IDS = Object.keys(
  STUDIO_DESIGN_DIRECTIONS,
) as StudioDesignDirection[];

/** The directions a prompt revision offers: fourteen from v34
 *  (prompt-features.ts `moreDirections`), the first seven before. */
export function studioDirectionIds(more: boolean): StudioDesignDirection[] {
  return more ? [...STUDIO_DESIGN_DIRECTION_IDS] : [...DESIGN_DIRECTION_IDS];
}

/** Their guidance as a prompt prints it. */
export function studioDirections(
  more: boolean,
): Partial<
  Record<
    StudioDesignDirection,
    (typeof STUDIO_DESIGN_DIRECTIONS)[StudioDesignDirection]
  >
> {
  return more ? STUDIO_DESIGN_DIRECTIONS : DESIGN_DIRECTIONS;
}

/**
 * Font pairings (lib/themes/fonts.ts keys) suited to each of the seven later
 * directions. ★ Not written into the pairing library's own `directions`:
 *   that list is printed in every font prompt since v25, and a persisted
 *   request must replay byte for byte.
 */
export const EXTENDED_DIRECTION_PAIRINGS: Readonly<
  Record<keyof typeof EXTENDED_DESIGN_DIRECTIONS, readonly string[]>
> = {
  brutalist: ["archivo-utility", "grotesk-modern", "mono-tech", "bebas-poster"],
  "scandinavian-utility": ["manrope-clean", "figtree-fresh", "jakarta-trusted"],
  "maximal-pattern": ["playfair-contrast", "dm-serif-pop", "bricolage-bold"],
  "dark-luxury": ["luxury-didone", "cormorant-luxe", "italiana-fashion"],
  "retro-catalogue": ["marcellus-heritage", "lora-warm", "oswald-condensed"],
  "tech-spec": ["sora-geometric", "grotesk-modern", "mono-tech"],
  "artisan-craft": ["garamond-classic", "newsreader-press", "lora-warm"],
};

export function recommendedDirection(
  industries: readonly string[],
  recent: readonly (StudioDesignDirection | null)[],
  /** v34+: choose among all fourteen. */
  more = false,
): StudioDesignDirection {
  return studioDirectionIds(more).sort((a, b) => {
    const rank = (id: StudioDesignDirection) =>
      ((STUDIO_DESIGN_DIRECTIONS[id].industries as readonly string[]).some(
        (i) => industries.includes(i),
      )
        ? 0
        : 3) + recent.filter((r) => r === id).length;
    return rank(a) - rank(b);
  })[0];
}
