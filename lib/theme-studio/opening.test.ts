import { describe, expect, it } from "vitest";
import { THEME_DEFINITIONS } from "@/lib/themes";
import type {
  HeroCarouselConfig,
  HeroConfig,
} from "@/lib/homepage/section-types";
import type { ThemePackageV2 } from "./contracts";
import {
  enforceHomepageOpening,
  homepageOpeningIssues,
  isOpeningSettingPath,
} from "./opening";

// Only the definition is read; the rest of the package is irrelevant here.
function pkgWith(
  themeId: string,
  mutate: (def: ThemePackageV2["definition"]) => void = () => {},
) {
  const definition = structuredClone(
    THEME_DEFINITIONS.find((t) => t.id === themeId)!,
  );
  mutate(definition);
  return { definition } as unknown as ThemePackageV2;
}
const home = (def: ThemePackageV2["definition"]) =>
  def.preset.pages.find((p) => p.slug === "")!;
const carouselFirst = (def: ThemePackageV2["definition"]) => {
  const page = home(def);
  page.sections = page.sections.slice(
    page.sections.findIndex((s) => s.type === "hero_carousel"),
  );
};
const fullbleed = (def: ThemePackageV2["definition"]) => {
  const hero = home(def).sections[0];
  const config = hero.config as HeroConfig;
  config.variant = "fullbleed";
  config.height = "large";
  hero.style = { ...(hero.style ?? {}), width: "full" };
};

describe("homepage opening", () => {
  it("accepts Vitrine's carousel once it leads, tall and edge to edge", () => {
    // Vitrine's photo carousel (the look the rule asks for) sits behind a
    // ticker, at the default height and page width.
    expect(homepageOpeningIssues(pkgWith("vitrine"))).toEqual([
      expect.stringContaining("not ticker"),
    ]);
    const pkg = pkgWith("vitrine", carouselFirst);
    expect(homepageOpeningIssues(pkg)).toEqual([
      expect.stringContaining('height "large" or "screen"'),
    ]);
    const tall = pkgWith("vitrine", (def) => {
      carouselFirst(def);
      (home(def).sections[0].config as HeroCarouselConfig).height = "screen";
    });
    expect(homepageOpeningIssues(tall)).toEqual([]);
    const enforced = enforceHomepageOpening(tall);
    expect(enforced.issues).toEqual([]);
    expect(home(enforced.package.definition).sections[0].style?.width).toBe(
      "full",
    );
    // The input package is untouched and only the opening's style moved.
    expect(home(tall.definition).sections[0].style?.width).not.toBe("full");
    expect(enforced.package.definition.preset.pages.slice(1)).toEqual(
      tall.definition.preset.pages.slice(1),
    );
  });

  it("refuses a carousel slide without a picture", () => {
    const pkg = pkgWith("vitrine", (def) => {
      carouselFirst(def);
      const config = home(def).sections[0].config as HeroCarouselConfig;
      config.height = "large";
      config.slides[1].image_url = "";
    });
    expect(homepageOpeningIssues(pkg)).toEqual([
      expect.stringContaining("every slide an image"),
    ]);
  });

  it("refuses a banner, split or minimal hero as the opening and accepts fullbleed", () => {
    // Ritual opens with a banner hero beside its copy.
    const ritual = pkgWith("ritual");
    expect(homepageOpeningIssues(ritual)).toEqual([
      expect.stringContaining('variant "fullbleed"'),
      expect.stringContaining('height "large" or "screen"'),
    ]);
    for (const variant of ["split", "minimal"] as const) {
      const pkg = pkgWith("ritual", (def) => {
        (home(def).sections[0].config as HeroConfig).variant = variant;
      });
      expect(homepageOpeningIssues(pkg)[0]).toContain('variant "fullbleed"');
    }
    const ok = pkgWith("ritual", fullbleed);
    expect(homepageOpeningIssues(ok)).toEqual([]);
    expect(enforceHomepageOpening(ok).package).toBe(ok);
    const noImage = pkgWith("ritual", (def) => {
      fullbleed(def);
      (home(def).sections[0].config as HeroConfig).image_url = "";
    });
    expect(homepageOpeningIssues(noImage)).toEqual([
      expect.stringContaining("carry an image"),
    ]);
  });

  it("skips disabled sections and refuses any other opening type", () => {
    const pkg = pkgWith("ritual", (def) => {
      home(def).sections[0].enabled = false;
    });
    expect(homepageOpeningIssues(pkg)).toEqual([
      expect.stringMatching(
        /must open with a hero_carousel or a fullbleed hero/,
      ),
    ]);
    const disabledThenGood = pkgWith("ritual", (def) => {
      fullbleed(def);
      const hero = home(def).sections[0];
      home(def).sections.unshift({
        ...structuredClone(hero),
        id: "retired-hero",
        enabled: false,
      });
    });
    expect(homepageOpeningIssues(disabledThenGood)).toEqual([]);
    const enforced = enforceHomepageOpening(disabledThenGood);
    expect(enforced.issues).toEqual([]);
  });

  it("names the opening's variant, height and width as settings a correction may not touch", () => {
    const pkg = pkgWith("ritual", (def) => {
      home(def).sections.unshift({
        ...structuredClone(home(def).sections[0]),
        id: "retired-hero",
        enabled: false,
      });
    });
    const page = pkg.definition.preset.pages.findIndex((p) => p.slug === "");
    const root = `/definition/preset/pages/${page}/sections/1`;
    for (const path of [
      `${root}/config/variant`,
      `${root}/config/height`,
      `${root}/style/width`,
    ])
      expect(isOpeningSettingPath(pkg, path)).toBe(true);
    for (const path of [
      `${root}/config/theme`,
      `${root}/config/alignment`,
      `${root}/style/scheme`,
      `/definition/preset/pages/${page}/sections/0/config/variant`,
      `/definition/preset/pages/${page}/sections/2/config/variant`,
    ])
      expect(isOpeningSettingPath(pkg, path)).toBe(false);
  });
});
