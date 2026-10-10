import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { THEME_DEFINITIONS } from "./index";
import { EMPTY_CONFIG, type HeroConfig } from "@/lib/homepage/section-types";
import {
  heroContrastIssues,
  promoTileContrastIssues,
  solidHeroContrast,
  HERO_SUB_OPACITY,
} from "./hero-contrast";
import { validateThemeDesign } from "./validation";
import { defaultTemplates, type PromoTile } from "./templates";

function bubble() {
  const theme = structuredClone(THEME_DEFINITIONS[0]);
  Object.assign(theme.preset.design.palette, {
    creamDeep: "#f5d061",
    ink: "#111111",
    onInk: "#ffffff",
  });
  const hero = (
    id: string,
    mode: HeroConfig["theme"],
    variant: HeroConfig["variant"],
  ) => ({
    id,
    type: "hero" as const,
    enabled: true,
    config: {
      ...EMPTY_CONFIG.hero,
      heading: "Living bubbles",
      subheading: "Slow brewed botanical drinks",
      theme: mode,
      variant,
      image_url: "/image.webp",
    },
  });
  theme.preset.pages = [
    {
      slug: "",
      title: "Home",
      sections: [hero("home-hero", "dark", "banner")],
    },
    {
      slug: "about",
      title: "About",
      sections: [hero("about-hero", "light", "split")],
    },
  ];
  return theme;
}

describe("solid hero contrast against the rendered field", () => {
  it("identifies Bubble's About hero and keeps its passing homepage distinct", () => {
    const theme = bubble();
    const evidence = solidHeroContrast(theme);
    expect(evidence[0].passes).toBe(true);
    expect(evidence[1]).toMatchObject({
      page: "/about",
      sectionId: "about-hero",
      passes: false,
      background: "#f5d061",
    });
    expect(evidence[1].headingRatio).toBeCloseTo(1.49, 2);
    expect(Math.abs(evidence[1].subheadingRatio! - 1.4)).toBeLessThan(0.01);
    expect(heroContrastIssues(theme)).toEqual([
      expect.stringContaining(
        "/definition/preset/pages/1/sections/0/config/theme",
      ),
    ]);
    expect(
      validateThemeDesign(theme).filter((f) => f.code === "hero_contrast"),
    ).toHaveLength(1);
    (theme.preset.pages[1].sections[0].config as HeroConfig).theme = "dark";
    expect(heroContrastIssues(theme)).toEqual([]);
  });
  it("rejects the ineffective repair that changes only the previously passing homepage", () => {
    const theme = bubble();
    (theme.preset.pages[0].sections[0].config as HeroConfig).theme = "light";
    expect(heroContrastIssues(theme)).toHaveLength(2);
  });
  it("measures muted copy, even when the full-colour text would pass", () => {
    const theme = bubble();
    theme.preset.design.palette.creamDeep = "#ffffff";
    theme.preset.design.palette.ink = "#767676";
    const evidence = solidHeroContrast(theme)[0];
    expect(evidence.headingRatio).toBeGreaterThan(4.5);
    expect(evidence.subheadingRatio).toBeLessThan(4.5);
    expect(evidence.passes).toBe(false);
  });
  it("tracks explicit fields and scheme inheritance, including banner specificity", () => {
    const theme = bubble();
    const hero = theme.preset.pages[0].sections[0];
    hero.style = { scheme: "inverse" };
    (hero.config as HeroConfig).theme = "light";
    expect(solidHeroContrast(theme)[0]).toMatchObject({
      text: "#111111",
      background: "#f5d061",
      passes: true,
    });
    (hero.config as HeroConfig).variant = "split";
    expect(solidHeroContrast(theme)[0]).toMatchObject({
      text: "#111111",
      passes: false,
    });
    (hero.config as HeroConfig).theme = "dark";
    expect(solidHeroContrast(theme)[0]).toMatchObject({
      text: "#ffffff",
      passes: true,
    });
    (hero.config as HeroConfig).background = "#fff";
    expect(solidHeroContrast(theme)[0]).toMatchObject({
      background: "#ffffff",
      passes: false,
    });
  });
  it("leaves photographic and unknown/translucent fields to browser QA", () => {
    const theme = bubble();
    const hero = theme.preset.pages[1].sections[0];
    (hero.config as HeroConfig).variant = "minimal";
    expect(solidHeroContrast(theme)).toHaveLength(1);
    // A fullbleed hero's copy sits over its photo too.
    (hero.config as HeroConfig).variant = "fullbleed";
    expect(solidHeroContrast(theme)).toHaveLength(1);
    // An offset hero's copy sits in its own surface card, photo or not: the
    // design contract's ink-on-surface pair, never this check. A stacked
    // hero's copy sits on the band field like a split one.
    (hero.config as HeroConfig).variant = "offset";
    expect(solidHeroContrast(theme)).toHaveLength(1);
    (hero.config as HeroConfig).variant = "stacked";
    expect(solidHeroContrast(theme)).toHaveLength(2);
    (hero.config as HeroConfig).variant = "fullbleed";
    (hero.config as HeroConfig).image_url = "";
    expect(solidHeroContrast(theme)).toHaveLength(2);
    (hero.config as HeroConfig).variant = "offset";
    expect(solidHeroContrast(theme)).toHaveLength(1);
    (hero.config as HeroConfig).variant = "minimal";
    expect(solidHeroContrast(theme)).toHaveLength(2);
    for (const background of [
      "rgba(20, 20, 20, 0.5)",
      "#11111180",
      "hsl(0 0% 20%)",
    ]) {
      (hero.config as HeroConfig).background = background;
      expect(solidHeroContrast(theme)).toHaveLength(1);
    }
    hero.enabled = false;
    expect(solidHeroContrast(theme)).toHaveLength(1);
  });
  it("keeps the muted-copy calculation bound to production CSS", () => {
    const css = readFileSync(
      "app/(storefront)/components/homepage/homepage.css",
      "utf8",
    );
    expect(css.match(/\.home-hero-sub\s*\{([^}]+)\}/)?.[1]).toContain(
      `opacity: ${HERO_SUB_OPACITY / 100}`,
    );
  });
});

// The collection page's promotional tiles (plan Phase 2e): `theme` is the
// copy's colour, the field follows it or is the tile's own hex.
describe("promotional tile contrast", () => {
  const withTile = (tile: Partial<PromoTile>) => {
    const theme = bubble();
    const base = defaultTemplates(theme.preset.design.layout);
    theme.preset.templates = {
      ...base,
      collection: {
        ...base.collection,
        promoTiles: [
          {
            afterIndex: 3,
            heading: "From the journal",
            body: "The lamp-maker of Pondicherry.",
            cta_label: "Read issue 12",
            href: "/the-journal",
            image_url: "",
            image_alt: "",
            theme: "dark",
            background: "",
            ...tile,
          },
        ],
      },
    };
    return theme;
  };

  it("reads dark copy on a pale field and light copy on the ink field", () => {
    expect(
      promoTileContrastIssues(
        withTile({ theme: "dark", background: "#f5d061" }),
      ),
    ).toEqual([]);
    expect(promoTileContrastIssues(withTile({ theme: "dark" }))).toEqual([]);
    expect(promoTileContrastIssues(withTile({ theme: "light" }))).toEqual([]);
  });

  it("names light copy on a pale field and the theme value that reads", () => {
    const theme = withTile({ theme: "light", background: "#f5d061" });
    const issues = promoTileContrastIssues(theme);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Promotional tile 1 on the collection page");
    expect(issues[0]).toContain("light copy (#ffffff) on #f5d061");
    expect(issues[0]).toContain(
      'promoTiles[0].theme to "dark" for readable #111111 copy',
    );
    expect(
      validateThemeDesign(theme).map((f) => `${f.area}/${f.code}`),
    ).toContain("design/promo_tile_contrast");
  });

  it("leaves a tile over a photograph to the browser stage", () => {
    expect(
      promoTileContrastIssues(
        withTile({
          theme: "light",
          background: "#f5d061",
          image_url: "/themes/basket/hero.webp",
          image_alt: "A market stall",
        }),
      ),
    ).toEqual([]);
  });
});
