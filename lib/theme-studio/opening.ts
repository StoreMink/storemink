import type {
  HeroCarouselConfig,
  HeroConfig,
} from "@/lib/homepage/section-types";
import type { ThemePackageV2 } from "./contracts";

// The homepage opens with a photograph filling the whole band, the way the
// Vitrine demo and Shopify's themes do (owner's rule, 2026-10-09). Under
// prompt v26 a Studio theme's first enabled homepage section is a
// hero_carousel whose slides each carry an image, or a hero with variant
// "fullbleed" and an image; from v27 (`carousel`) it is a hero_carousel of
// two or three slides, each with its own image, so the storefront renders
// previous/next arrows and dots and shoppers can move around it. Always at
// height large or screen and style width "full". Checked inside generation as a
// repair issue, beside the claims check, and never at acceptance: bundled
// themes and installed stores open however they were authored, and a
// revision keeps the opening its base already has. The width is mechanical
// (any opening that qualifies is meant to run edge to edge), so it is set
// rather than asked for, which saves a paid repair turn.

export const OPENING_HEIGHTS: readonly string[] = ["large", "screen"];
/** v27+: the opening is a slideshow with this many photograph slides, so the
 * storefront renders previous/next arrows and dots (one slide renders none). */
export const OPENING_SLIDES = { min: 2, max: 3 } as const;

export interface OpeningOptions {
  /** v27+: only a hero_carousel qualifies; a single hero does not. */
  carousel?: boolean;
}

type Section =
  ThemePackageV2["definition"]["preset"]["pages"][number]["sections"][number];

function opening(pkg: ThemePackageV2): {
  page: number;
  index: number;
  section: Section;
} | null {
  const page = pkg.definition.preset.pages.findIndex((p) => p.slug === "");
  if (page < 0) return null;
  const sections = pkg.definition.preset.pages[page].sections;
  const index = sections.findIndex((s) => s.enabled !== false);
  if (index < 0) return null;
  return { page, index, section: sections[index] };
}

/** Why the homepage does not open with a full-band photograph; empty when it
 * does (width aside, which `enforceHomepageOpening` sets). */
export function homepageOpeningIssues(
  pkg: ThemePackageV2,
  options: OpeningOptions = {},
): string[] {
  const first = opening(pkg);
  if (!first) return [];
  const { section } = first;
  const where = `The homepage's first enabled section (${section.type})`;
  const issues: string[] = [];
  const heightOf = (height: unknown) =>
    OPENING_HEIGHTS.includes(String(height))
      ? []
      : [`${where} must set height "large" or "screen".`];
  if (section.type === "hero_carousel") {
    const config = section.config as HeroCarouselConfig;
    const slides = Array.isArray(config.slides) ? config.slides : [];
    if (!slides.length || slides.some((slide) => !slide.image_url))
      issues.push(
        `${where} must give every slide an image from the asset briefs: the homepage opens with a photograph filling the band.`,
      );
    if (options.carousel) {
      if (
        slides.length < OPENING_SLIDES.min ||
        slides.length > OPENING_SLIDES.max
      )
        issues.push(
          `${where} must have ${OPENING_SLIDES.min} to ${OPENING_SLIDES.max} slides (it has ${slides.length}): the opening is a slideshow with previous/next arrows.`,
        );
      const images = slides.map((slide) => slide.image_url).filter(Boolean);
      if (new Set(images).size !== images.length)
        issues.push(
          `${where} must give each slide its own image brief: a different scene of the same shoot per slide, never the same brief twice.`,
        );
    }
    issues.push(...heightOf(config.height));
  } else if (options.carousel) {
    issues.push(
      `The homepage must open with a hero_carousel of ${OPENING_SLIDES.min} to ${OPENING_SLIDES.max} photograph slides (previous/next arrows and dots), not ${section.type}${section.type === "hero" ? ` — a single hero may open another page, never the homepage` : ""}.`,
    );
  } else if (section.type === "hero") {
    const config = section.config as HeroConfig;
    if (config.variant !== "fullbleed")
      issues.push(
        `${where} must use variant "fullbleed" (its image fills the band behind the copy) or be a hero_carousel; a banner, split or minimal hero may not open the homepage.`,
      );
    if (!config.image_url)
      issues.push(
        `${where} must carry an image from the asset briefs: the homepage opens with a photograph filling the band.`,
      );
    issues.push(...heightOf(config.height));
  } else {
    issues.push(
      `The homepage must open with a hero_carousel or a fullbleed hero carrying a photograph that fills the band, not ${section.type}.`,
    );
  }
  return issues;
}

/**
 * The package with its qualifying opening at full width, or the issues that
 * stop it qualifying. Only the opening section's style changes.
 */
export function enforceHomepageOpening(
  pkg: ThemePackageV2,
  options: OpeningOptions = {},
): {
  package: ThemePackageV2;
  issues: string[];
} {
  const issues = homepageOpeningIssues(pkg, options);
  if (issues.length) return { package: pkg, issues };
  const first = opening(pkg);
  if (!first || first.section.style?.width === "full")
    return { package: pkg, issues: [] };
  const next = structuredClone(pkg);
  const section =
    next.definition.preset.pages[first.page].sections[first.index];
  section.style = { ...(section.style ?? {}), width: "full" };
  return { package: next, issues: [] };
}

/**
 * Whether a repair-target path would move the opening away from a full-band
 * photograph: the opening section's variant, height or width. A variety
 * correction or an automatic QA repair must choose among the other settings.
 */
export function isOpeningSettingPath(
  pkg: ThemePackageV2,
  path: string,
): boolean {
  const first = opening(pkg);
  if (!first) return false;
  const root = `/definition/preset/pages/${first.page}/sections/${first.index}`;
  return (
    path === `${root}/config/variant` ||
    path === `${root}/config/height` ||
    path === `${root}/style/width`
  );
}
