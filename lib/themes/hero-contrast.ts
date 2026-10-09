import type { HeroConfig } from "@/lib/homepage/section-types";
import {
  isHex,
  isSectionScheme,
  mixHex,
  resolveScheme,
  schemeContrast,
} from "./schemes";
import type { ThemeDefinition } from "./types";

// Mirrors HeroSection and homepage.css. Only opaque, known colour fields can
// be judged without a browser; photographs, videos and other CSS colours still
// require the existing browser/axe checks. Never infer a photo's contrast from
// its placeholder colour.
export const HERO_SUB_OPACITY = 85;

function opaqueHex(value: unknown): string | null {
  if (isHex(value)) return value;
  if (typeof value !== "string") return null;
  if (/^#[\da-f]{3}$/i.test(value))
    return "#" + [...value.slice(1)].map((c) => c + c).join("");
  if (/^#[\da-f]{6}ff$/i.test(value)) return value.slice(0, 7);
  return null;
}

export interface HeroContrastEvidence {
  page: string;
  sectionId: string;
  path: string;
  theme: "light" | "dark";
  background: string;
  text: string;
  headingRatio: number | null;
  subheadingRatio: number | null;
  alternatives: { theme: "light" | "dark"; text: string; passes: boolean }[];
  passes: boolean;
}

export function solidHeroContrast(
  theme: ThemeDefinition,
): HeroContrastEvidence[] {
  const evidence: HeroContrastEvidence[] = [];
  const { design, brand, pages } = theme.preset;
  pages.forEach((page, p) =>
    page.sections.forEach((section, s) => {
      if (section.enabled === false || section.type !== "hero") return;
      const config = section.config as HeroConfig;
      // Minimal and fullbleed heroes with media put their copy over the
      // photo, which only the browser and vision stages can judge.
      if (
        (config.variant === "minimal" || config.variant === "fullbleed") &&
        (config.image_url || config.video_url)
      )
        return;

      let ink = opaqueHex(design.palette.ink);
      let onInk = opaqueHex(design.palette.onInk);
      let field = opaqueHex(design.palette.creamDeep);
      // Banner cards reset to page tokens even inside a scheme. Split/text-only
      // minimal heroes inherit the band's ink and on-ink, with a 6% deep field.
      if (
        config.variant !== "banner" &&
        isSectionScheme(section.style?.scheme)
      ) {
        const palette = design.palette;
        if (
          ![
            palette.cream,
            palette.creamDeep,
            palette.surface,
            palette.ink,
            palette.onInk,
            palette.onAccent,
            palette.accent ?? brand.primaryColor,
          ].every(isHex)
        )
          return;
        const band = resolveScheme(
          section.style.scheme,
          design,
          brand.primaryColor,
        );
        ink = opaqueHex(band.text);
        onInk = opaqueHex(band.background);
        field = mixHex(band.text, band.background, 6);
      }
      const background = config.background
        ? opaqueHex(config.background)
        : field;
      if (!background || !ink || !onInk) return;
      const tone = config.theme === "light" ? "light" : "dark";
      // The scheme's card-reset selector also sets `color: var(--sm-ink)`
      // with higher specificity than either hero text-mode selector.
      const bannerReset =
        config.variant === "banner" && isSectionScheme(section.style?.scheme);
      const textFor = (choice: "light" | "dark") =>
        choice === "light" && !bannerReset ? onInk : ink;
      const measure = (text: string) => ({
        // Hero headings remain large text even at the smallest supported scale.
        headingRatio: config.heading ? schemeContrast(text, background) : null,
        subheadingRatio: config.subheading
          ? schemeContrast(
              mixHex(text, background, HERO_SUB_OPACITY),
              background,
            )
          : null,
      });
      const passes = (ratios: ReturnType<typeof measure>) =>
        (ratios.headingRatio === null || ratios.headingRatio >= 3) &&
        (ratios.subheadingRatio === null || ratios.subheadingRatio >= 4.5);
      const text = textFor(tone);
      const ratios = measure(text);
      evidence.push({
        page: page.slug ? `/${page.slug}` : "/",
        sectionId: section.id,
        path: `/definition/preset/pages/${p}/sections/${s}/config/theme`,
        theme: tone,
        background,
        text,
        ...ratios,
        alternatives: (["dark", "light"] as const).map((choice) => {
          const text = textFor(choice);
          return { theme: choice, text, passes: passes(measure(text)) };
        }),
        passes: passes(ratios),
      });
    }),
  );
  return evidence;
}

export function heroContrastIssues(theme: ThemeDefinition): string[] {
  return solidHeroContrast(theme)
    .filter((e) => !e.passes)
    .map((e) => {
      const ratios = [
        e.headingRatio !== null && e.headingRatio < 3
          ? `heading ${e.headingRatio.toFixed(2)}:1 (needs 3:1)`
          : null,
        e.subheadingRatio !== null && e.subheadingRatio < 4.5
          ? `subheading at 85% opacity ${e.subheadingRatio.toFixed(2)}:1 (needs 4.5:1)`
          : null,
      ]
        .filter(Boolean)
        .join("; ");
      const alternative = e.alternatives.find((a) => a.passes);
      return `Hero ${e.sectionId} on ${e.page}: ${e.text} text on ${e.background} fails contrast: ${ratios}. ${
        alternative
          ? `Set ${e.path} to "${alternative.theme}" for readable ${alternative.text} text.`
          : `Neither text mode is readable. Adjust this hero's background or its palette/scheme text colours.`
      }`;
    });
}
