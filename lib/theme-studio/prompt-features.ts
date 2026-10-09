/** Persisted versions keep their request shape. Future prompt revisions inherit
 * these introduced capabilities rather than silently reverting to legacy calls. */
export const THEME_STUDIO_PROMPT_VERSION = "theme-studio-v27";

export function themePromptFeatures(version: string) {
  const revision = Number(/^theme-studio-v(\d+)$/.exec(version)?.[1] ?? 0);
  return {
    targetedRepair: revision >= 19,
    nativeFraming: revision >= 19,
    nativeCommerce: revision >= 20,
    compactInitial: revision >= 20,
    variety: revision >= 21,
    stableAssetIds: revision >= 22,
    heroContrast: revision >= 23,
    /** Operator revisions are scoped: edit, revise or recreate. */
    changeScope: revision >= 24,
    /** A draft repeating the catalogue's dominant style answers is corrected. */
    convergence: revision >= 24,
    /** Stage B chooses a font pairing from lib/themes/fonts.ts (31 faces,
     * 26 pairings) instead of two faces from nine. */
    fontPairings: revision >= 25,
    /** The homepage opens with a photograph filling the whole band (a
     * hero_carousel or a fullbleed hero at full width), the way Shopify
     * themes do; checked in generation as a repair issue. */
    fullBleedOpening: revision >= 26,
    /** The opening is a slideshow: hero_carousel with two or three
     * photograph slides, previous/next arrows and dots (owner, 2026-10-09),
     * never a single hero. */
    carouselOpening: revision >= 27,
  };
}
