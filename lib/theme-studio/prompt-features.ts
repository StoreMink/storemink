/** Persisted versions keep their request shape. Future prompt revisions inherit
 * these introduced capabilities rather than silently reverting to legacy calls. */
export const THEME_STUDIO_PROMPT_VERSION = "theme-studio-v34";

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
    /** Stage A may put adults in a brief where the picture is about how the
     * product is worn or used (owner, 2026-10-09); the image model then
     * allows adults for that image only. Most briefs stay people-free. */
    peopleInImagery: revision >= 28,
    /** Sections carry nested blocks (plan Phase 2b): media_text stories, and
     * the accordion and comparison sections with typed rows. The vocabulary
     * a prompt prints and a schema admits grows with it; earlier requests
     * keep the shorter list byte for byte. */
    nestedBlocks: revision >= 29,
    /** Five more sections a theme may use (plan Phase 2c, first slice):
     * multicolumn, image_marquee, image_hotspots, before_after and
     * product_spotlight, plus the tile grid's collage layout. */
    moreSections: revision >= 30,
    /** More layout variants (plan Phase 2d, first slice): hero stacked and
     * offset, header transparent and hamburger, cards centered, soft and
     * wide, footers centered and compact. The prompts print them and the
     * Stage B layout enums admit them from v31; earlier requests keep the
     * shorter lists byte for byte. */
    moreVariants: revision >= 31,
    /** Templates (plan Phase 2e): Stage B writes the product and collection
     * page compositions (gallery shape and ordered blocks; filters, paging
     * and promotional tiles) as a top-level `templates` object the compiler
     * normalises into preset.templates, and design.layout.productDetail may
     * be "stacked". Earlier requests keep the shorter schema byte for byte. */
    templates: revision >= 32,
    /** v32's templates object pushed the two revision schemas over Vertex's
     * structured-output size limit: every operator change that reached
     * Stage B was refused with 400 INVALID_ARGUMENT (25 Oct 2026). The draft
     * schema was 16,733 bytes and the variety draft 15,893, where the
     * largest one Vertex accepted was 14,240. So from v33 Stage B writes the
     * same templates as one JSON string, `templatesJson`, which the compiler
     * parses and checks; earlier requests keep their schema byte for byte. */
    templatesJson: revision >= 33,
    /** The theme's own style rules (plan Phase 3, owner 22 Nov 2026): Stage
     * B writes `stylesheetJson`, a JSON string holding rules from the closed
     * vocabulary in lib/themes/stylesheet.ts, which the compiler parses and
     * checks into preset.stylesheet. Two themes with the same layout picks
     * then still differ. Earlier requests keep their schema and prompt byte
     * for byte. */
    stylesheet: revision >= 34,
    /** Fourteen design directions in place of seven (plan Phase 4 item 2;
     * design-directions.ts STUDIO_DESIGN_DIRECTIONS): Stage A's schema and
     * prompt offer the seven later ones too. Earlier requests keep the
     * first seven byte for byte. */
    moreDirections: revision >= 34,
    /** Layout commitments (plan Phase 4 item 1; commitments.ts): a new
     * theme is given the header, card, product page, footer, page width and
     * grid its catalogue uses least, and asked to keep them. */
    commitments: revision >= 34,
    /** The design plan (owner 22 Nov 2026; design-plan.ts): Stage A decides
     * a new theme's colours, fonts, buttons, styling and (from screenshots)
     * layout and writes them as `designPlanJson`; the plan is checked
     * against every published theme, Stage B is held to it and also sees the
     * screenshots, the screenshots' colours are measured from their pixels,
     * and a built theme under the publish floor is corrected or stopped
     * BEFORE any photograph is drawn. */
    designPlan: revision >= 34,
  };
}
