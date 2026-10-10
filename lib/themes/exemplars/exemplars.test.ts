import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { THEME_META } from "../meta";
import { THEME_DEFINITIONS } from "../index";
import {
  collectThemeImageUrls,
  validateStudioDesign,
  validateThemeCopy,
  validateThemeDefinition,
} from "../validation";
import { templateIssues } from "../templates";
import { announcementIssues } from "../announcement";
import {
  themeDefinitionToPackageV2,
  validateThemePackageV2,
} from "@/lib/theme-studio/contracts";
import { homepageOpeningIssues } from "@/lib/theme-studio/opening";
import { DESIGN_DIRECTION_IDS } from "@/lib/theme-studio/design-directions";
import { VISIBLE_SECTION_CHOICES } from "@/lib/theme-studio/style-choices";
import { THEME_STUDIO_SECTION_TYPES } from "@/lib/theme-studio/schemas";
import { RENDERER_ENGINE_VERSIONS } from "../runtime-registry";
import { EXEMPLAR_DIRECTION, EXEMPLAR_THEMES } from "./index";
import type { ProductBlock } from "../templates";

// ---------------------------------------------------------------------------
// The Phase 2 exit evidence (docs/theme-studio-shopify-grade-plan.md): one
// hand-authored exemplar per design direction, written with the whole
// renderer vocabulary and held to every offline gate a Studio candidate is.
// scripts/theme-studio-exemplar-check.ts runs the package gates with a real
// asset manifest and, against a local server, the route and browser stages.
// ---------------------------------------------------------------------------

/** What PostgreSQL hands back for a jsonb value: object keys re-ordered by
 * length, then bytes. A contract that only holds in the key order a value
 * was written in is one that stops holding the moment it is stored. */
function jsonbRoundTrip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbRoundTrip);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) =>
      a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0,
    );
  return Object.fromEntries(
    entries.map(([key, nested]) => [key, jsonbRoundTrip(nested)]),
  );
}

describe("the seven exemplar themes", () => {
  it("cover every design direction exactly once, outside the bundled catalogue", () => {
    const directions = EXEMPLAR_THEMES.map((t) => EXEMPLAR_DIRECTION[t.id]);
    expect([...directions].sort()).toEqual([...DESIGN_DIRECTION_IDS].sort());
    expect(new Set(EXEMPLAR_THEMES.map((t) => t.id)).size).toBe(7);
    for (const theme of EXEMPLAR_THEMES) {
      expect(theme.id.startsWith("exemplar-")).toBe(true);
      expect(THEME_META.some((m) => m.id === theme.id)).toBe(false);
      expect(THEME_DEFINITIONS.some((d) => d.id === theme.id)).toBe(false);
      expect(theme.catalog.visibility).toBe("hidden");
      expect(theme.release.status).toBe("draft");
      // The renderer this build ships can render it.
      expect(RENDERER_ENGINE_VERSIONS[theme.engine.id]).toBeGreaterThanOrEqual(
        theme.engine.version,
      );
    }
  });

  for (const theme of EXEMPLAR_THEMES) {
    describe(theme.id, () => {
      it("passes the content floors, the Studio copy floors and the contract", () => {
        expect(
          validateThemeDefinition(theme, { bundledAssets: false }).map(
            (f) => `${f.area}/${f.code}: ${f.message}`,
          ),
        ).toEqual([]);
        expect(
          validateThemeCopy(theme).map((f) => `${f.code}: ${f.message}`),
        ).toEqual([]);
        // The Studio's stricter floor: button labels at 4.5:1.
        expect(
          validateStudioDesign(theme).map((f) => `${f.code}: ${f.message}`),
        ).toEqual([]);
        expect(theme.preset.templates).toBeDefined();
        expect(templateIssues(theme.preset.templates)).toEqual([]);
        expect(theme.preset.announcement).toBeDefined();
        expect(announcementIssues(theme.preset.announcement)).toEqual([]);
        const pkg = themeDefinitionToPackageV2(theme);
        const parsed = validateThemePackageV2(pkg);
        expect(parsed.ok ? [] : parsed.issues).toEqual([]);
        // And as the registry reads it back: jsonb re-orders every key, and
        // an exemplar carries the whole Phase 2 vocabulary, so this is the
        // one place a key-order-sensitive check anywhere in the contract
        // shows up before a stored theme renders un-themed.
        const stored = validateThemePackageV2(jsonbRoundTrip(pkg));
        expect(stored.ok ? [] : stored.issues).toEqual([]);
        // The v27 opening rule: a slideshow of two or three photographs.
        expect(homepageOpeningIssues(pkg, { carousel: true })).toEqual([]);
      });

      it("renders only pictures that exist, from its own (linked) folder", () => {
        const urls = [...collectThemeImageUrls(theme)];
        expect(urls.length).toBeGreaterThan(8);
        for (const url of urls) {
          expect(url.startsWith(`/themes/${theme.id}/`), url).toBe(true);
          expect(existsSync(join(process.cwd(), "public", url)), url).toBe(
            true,
          );
        }
      });

      it("uses the Studio vocabulary with every visible choice made explicitly", () => {
        for (const page of theme.preset.pages) {
          for (const section of page.sections) {
            expect(
              THEME_STUDIO_SECTION_TYPES.includes(
                section.type as (typeof THEME_STUDIO_SECTION_TYPES)[number],
              ),
              `${page.slug || "home"}/${section.id}: ${section.type}`,
            ).toBe(true);
            const config = section.config as unknown as Record<string, unknown>;
            for (const [key, values] of Object.entries(
              VISIBLE_SECTION_CHOICES[section.type] ?? {},
            )) {
              expect(
                values.includes(config[key]),
                `${page.slug || "home"}/${section.id}.${key} = ${JSON.stringify(config[key])}`,
              ).toBe(true);
            }
            // Every section states its band: padding and width, and a scheme
            // or the page's own colours.
            expect(
              section.style?.padding_y,
              `${section.id} padding`,
            ).toBeDefined();
            expect(section.style?.width, `${section.id} width`).toBeDefined();
          }
        }
      });
    });
  }

  it("between them exercise the whole Phase 2 vocabulary", () => {
    const sections = EXEMPLAR_THEMES.flatMap((t) =>
      t.preset.pages.flatMap((p) => p.sections),
    );
    const types = new Set(sections.map((s) => s.type));
    for (const type of [
      "hero_carousel",
      "hero",
      "featured_products",
      "shop_by_category",
      "tile_grid",
      "media_text",
      "gallery",
      "testimonials",
      "newsletter",
      "usp_bar",
      "ticker",
      "faq_accordion",
      "accordion",
      "comparison",
      "multicolumn",
      "image_marquee",
      "image_hotspots",
      "before_after",
      "product_spotlight",
      "rich_text",
    ])
      expect(types.has(type as never), type).toBe(true);
    const configs = (type: string) =>
      sections
        .filter((s) => s.type === type)
        .map((s) => s.config as unknown as Record<string, unknown>);
    // 2b: stories, typed accordion rows, both comparison styles.
    expect(
      configs("media_text").some(
        (c) => Array.isArray(c.stories) && c.stories.length >= 2,
      ),
    ).toBe(true);
    expect(
      configs("accordion").some((c) =>
        (c.items as { type: string }[]).some((i) => i.type === "image"),
      ),
    ).toBe(true);
    expect(new Set(configs("comparison").map((c) => c.style))).toEqual(
      new Set(["table", "cards"]),
    );
    // 2c: the collage, the collection list.
    expect(configs("tile_grid").some((c) => c.layout === "collage")).toBe(true);
    expect(new Set(configs("shop_by_category").map((c) => c.display))).toEqual(
      new Set(["circles", "cards", "list"]),
    );
    // 2d: the new hero shapes on inner pages, the split carousel, every
    // header, card and footer variant the slice added.
    expect(new Set(configs("hero").map((c) => c.variant))).toEqual(
      new Set(["offset", "stacked", "banner"]),
    );
    expect(configs("hero_carousel").some((c) => c.layout === "split")).toBe(
      true,
    );
    const layouts = EXEMPLAR_THEMES.map((t) => t.preset.design.layout!);
    expect(new Set(layouts.map((l) => l.header))).toEqual(
      new Set([
        "minimal",
        "transparent",
        "centered",
        "market",
        "stacked",
        "hamburger",
        "utility",
      ]),
    );
    expect(new Set(layouts.map((l) => l.card))).toEqual(
      new Set(["framed", "overlay", "centered", "quick_add", "soft", "wide"]),
    );
    expect(new Set(layouts.map((l) => l.footer))).toEqual(
      new Set(["minimal", "compact", "editorial", "rich", "centered"]),
    );
    expect(new Set(layouts.map((l) => l.productDetail))).toEqual(
      new Set(["editorial", "classic", "stacked"]),
    );
    // 2e: every gallery shape, filter placement and paging; the size guide;
    // every blog and account layout; a scheme on the account pages.
    const templates = EXEMPLAR_THEMES.map((t) => t.preset.templates!);
    expect(new Set(templates.map((t) => t.product.gallery))).toEqual(
      new Set(["stacked", "grid", "thumbs-bottom", "thumbs-left", "carousel"]),
    );
    expect(new Set(templates.map((t) => t.collection.filters))).toEqual(
      new Set(["drawer", "top-bar", "sidebar"]),
    );
    expect(new Set(templates.map((t) => t.collection.pagination))).toEqual(
      new Set(["paged", "infinite", "load-more"]),
    );
    const blocks = templates.flatMap((t) => t.product.blocks);
    const blockTypes = new Set(blocks.map((b: ProductBlock) => b.type));
    for (const type of [
      "size_guide",
      "trust_row",
      "accordion",
      "rich_text",
      "delivery_estimate",
      "share",
      "sticky_bar",
    ])
      expect(blockTypes.has(type as never), type).toBe(true);
    expect(new Set(templates.map((t) => t.blog.index))).toEqual(
      new Set(["list", "grid", "featured"]),
    );
    expect(new Set(templates.map((t) => t.blog.article))).toEqual(
      new Set(["narrow", "wide", "sidebar"]),
    );
    expect(new Set(templates.map((t) => t.account.layout))).toEqual(
      new Set(["plain", "tabs", "sidebar"]),
    );
    expect(templates.some((t) => t.account.scheme === "soft")).toBe(true);
    // The announcement bar, linked and not.
    expect(EXEMPLAR_THEMES.some((t) => t.preset.announcement?.href)).toBe(true);
    expect(EXEMPLAR_THEMES.some((t) => !t.preset.announcement?.href)).toBe(
      true,
    );
    // 2a: seven distinct pairings across the directions, and a declared
    // scheme, typography, buttons, page and motion on every one.
    expect(
      new Set(
        EXEMPLAR_THEMES.map(
          (t) =>
            `${t.preset.design.fonts.display}/${t.preset.design.fonts.body}`,
        ),
      ).size,
    ).toBe(7);
    for (const theme of EXEMPLAR_THEMES) {
      const design = theme.preset.design;
      expect(design.typography, theme.id).toBeDefined();
      expect(design.buttons, theme.id).toBeDefined();
      expect(design.page, theme.id).toBeDefined();
      expect(design.motion, theme.id).toBeDefined();
    }
  });
});
