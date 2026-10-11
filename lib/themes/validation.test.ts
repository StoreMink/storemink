import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { THEME_DEFINITIONS } from "./index";
import type { ThemeDefinition } from "./types";
import {
  STOREFRONT_CODE_ROUTES,
  collectThemeHrefs,
  collectThemeImageUrls,
  validateThemeCatalogMeta,
  validateThemeCopy,
  validateThemeDefinition,
  validateThemeDesign,
  validateThemeHomepage,
  validateThemeImage,
  validateThemeLinks,
  validateThemePages,
  validateThemeSampleData,
  validateStudioDesign,
} from "./validation";

// The bundled themes are the positive cases (themes.test.ts asserts each
// returns no findings). Every test here breaks ONE rule on a clone and
// asserts that rule — and only a finding from it — is reported, so deleting a
// check makes a test fail rather than leaving the suite green.

function clone(): ThemeDefinition {
  return structuredClone(THEME_DEFINITIONS[0]);
}

function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((f) => f.code);
}

describe("theme validation", () => {
  it("a bundled theme is clean", () => {
    expect(validateThemeDefinition(clone(), { bundledAssets: true })).toEqual(
      [],
    );
  });

  it("catalog: placeholder copy, short description and bad demo slug", () => {
    const theme = clone();
    theme.name = "Theme 1";
    theme.description = "Too short";
    theme.demo.slug = "demo-other";
    expect(
      codes(validateThemeCatalogMeta(theme, { bundledAssets: false })),
    ).toEqual(
      expect.arrayContaining(["name_placeholder", "description", "demo_slug"]),
    );
  });

  it("catalog: a public release must be published with a healthy demo", () => {
    const theme = clone();
    theme.catalog.visibility = "public";
    theme.release.status = "draft";
    theme.demo.status = "unavailable";
    expect(
      codes(validateThemeCatalogMeta(theme, { bundledAssets: true })),
    ).toEqual(expect.arrayContaining(["public_unpublished", "public_demo"]));
  });

  it("catalog: bundled paths are enforced only for bundled themes", () => {
    const theme = clone();
    theme.catalog.previewImage = "theme-asset://preview";
    expect(
      codes(validateThemeCatalogMeta(theme, { bundledAssets: true })),
    ).toContain("preview_path");
    expect(
      codes(validateThemeCatalogMeta(theme, { bundledAssets: false })),
    ).not.toContain("preview_path");
  });

  it("pages: a second homepage, a duplicate slug and custom code", () => {
    const theme = clone();
    const home = theme.preset.pages.find((p) => p.slug === "")!;
    theme.preset.pages.push({ ...structuredClone(home) });
    const content = theme.preset.pages.find((p) => p.slug !== "")!;
    content.sections.push({
      ...content.sections[0],
      id: "code-1",
      type: "custom_code",
    } as never);
    const found = codes(validateThemePages(theme));
    expect(found).toEqual(
      expect.arrayContaining([
        "homepage_count",
        "slug_duplicate",
        "custom_code",
      ]),
    );
  });

  it("pages: an id-based product source is refused", () => {
    const theme = clone();
    const section = theme.preset.pages
      .flatMap((p) => p.sections)
      .find((s) => s.type === "featured_products");
    expect(section).toBeDefined();
    (section!.config as unknown as Record<string, unknown>).source = "manual";
    expect(codes(validateThemePages(theme))).toContain("id_source");
  });

  it("homepage: fewer than five sections is below the floor", () => {
    const theme = clone();
    const home = theme.preset.pages.find((p) => p.slug === "")!;
    home.sections = home.sections.slice(0, 2);
    expect(codes(validateThemeHomepage(theme))).toEqual(
      expect.arrayContaining(["sections", "variety"]),
    );
  });

  it("sample: thin catalogue, dangling category and inverted price", () => {
    const theme = clone();
    const sample = theme.preset.sampleData!;
    sample.categories = sample.categories.slice(0, 2);
    sample.products = sample.products
      .slice(0, 3)
      .map((p) => ({ ...p, featured: false }));
    sample.products[0].category_slug = "nowhere";
    sample.products[1].selling_price = sample.products[1].base_price + 1;
    expect(codes(validateThemeSampleData(theme))).toEqual(
      expect.arrayContaining([
        "categories",
        "products",
        "category_ref",
        "product_price",
        "featured",
      ]),
    );
  });

  it("sample: two products sharing one photograph are reported, once per repeat", () => {
    const theme = clone();
    const products = theme.preset.sampleData!.products;
    expect(codes(validateThemeSampleData(theme))).not.toContain(
      "product_image",
    );
    products[2].image_url = products[0].image_url;
    products[3].image_url = products[0].image_url;
    const found = validateThemeSampleData(theme).filter(
      (f) => f.code === "product_image",
    );
    expect(found.map((f) => f.message)).toEqual([
      `${products[2].slug}: shares its image with ${products[0].slug}; give every product its own photograph.`,
      `${products[3].slug}: shares its image with ${products[0].slug}; give every product its own photograph.`,
    ]);
  });

  it("links: a menu link to an unseeded product is reported", () => {
    const theme = clone();
    theme.preset.menus.header.push({
      label: "Ghost",
      href: "/shop/ghost",
    } as never);
    expect(collectThemeHrefs(theme)).toContain("/shop/ghost");
    expect(codes(validateThemeLinks(theme))).toEqual(["product"]);
  });

  it("links: the announcement bar's link is checked like a menu link", () => {
    const theme = clone();
    theme.preset.announcement = { text: "Sale on now", href: "/shop/ghost" };
    expect(collectThemeHrefs(theme)).toContain("/shop/ghost");
    expect(codes(validateThemeLinks(theme))).toEqual(["product"]);
    theme.preset.announcement = { text: "Sale on now" };
    expect(codes(validateThemeLinks(theme))).toEqual([]);
  });

  it("links: a nested header link is checked, a heading without one is not", () => {
    const theme = clone();
    theme.preset.menus.header.push({
      label: "More",
      href: "",
      image_url: "/themes/basket/menu.webp",
      children: [
        {
          label: "Ghosts",
          href: "",
          children: [{ label: "Ghost", href: "/shop/ghost" }],
        },
      ],
    });
    expect(collectThemeHrefs(theme)).toContain("/shop/ghost");
    expect(collectThemeHrefs(theme)).not.toContain("");
    expect(codes(validateThemeLinks(theme))).toEqual(["product"]);
    // A mega-menu tile is an image the theme renders, so it must exist too.
    expect(collectThemeImageUrls(theme)).toContain("/themes/basket/menu.webp");
  });

  it("links: a collection link must name a seeded category", () => {
    const theme = clone();
    const seeded = theme.preset.sampleData!.categories[0].slug;
    theme.preset.menus.header.push(
      { label: "Seeded", href: `/collections/${seeded}` } as never,
      { label: "Old form", href: `/shop?category=${seeded}` } as never,
      { label: "Ghost", href: "/collections/ghost" } as never,
      { label: "Bare", href: "/collections" } as never,
    );
    expect(validateThemeLinks(theme).map((f) => f.message)).toEqual([
      "/collections/ghost names no seeded category.",
      "/collections names no category; link /collections/<category slug>.",
    ]);
  });

  it("links: a page link must reach a seeded page or a storefront route", () => {
    const theme = clone();
    theme.preset.menus.header.push(
      { label: "Lookbook", href: "/lookbook" } as never,
      { label: "Shop", href: "/shop" } as never,
      { label: "Cart", href: "/cart" } as never,
    );
    expect(validateThemeLinks(theme).map((f) => f.message)).toEqual([
      "/lookbook links to a page the theme does not seed.",
    ]);
  });

  it("links: the default footer an empty legal row falls back to is read, and policy pages are the merchant's", () => {
    const theme = clone();
    theme.preset.menus.footerLegal = [];
    theme.preset.menus.header = [];
    theme.preset.menus.footerGroups = [];
    // The storefront renders DEFAULT_MENUS here: its policy links are exempt,
    // but its other links must still resolve against the seeded pages.
    const found = validateThemeLinks(theme);
    expect(found.every((f) => !/privacy|terms|refund/.test(f.message))).toBe(
      true,
    );
  });

  it("the storefront code routes match app/(storefront)/(pages)", () => {
    const dirs = readdirSync(join(process.cwd(), "app/(storefront)/(pages)"), {
      withFileTypes: true,
    })
      .filter((d) => d.isDirectory() && !d.name.startsWith("["))
      .map((d) => d.name)
      .sort();
    expect([...STOREFRONT_CODE_ROUTES].sort()).toEqual(dirs);
  });

  it("design: bad palette value, unloaded font and illegible body text", () => {
    const theme = clone();
    theme.preset.design.palette.surface = "red";
    theme.preset.design.fonts.body = "Comic Sans";
    theme.preset.design.palette.ink = "#eeeeee";
    theme.preset.design.palette.cream = "#ffffff";
    const found = validateThemeDesign(theme);
    expect(codes(found)).toEqual(
      expect.arrayContaining(["palette", "fonts", "contrast"]),
    );
    expect(found.find((f) => f.code === "contrast")!.message).toMatch(
      /Body text on the page background/,
    );
  });

  it("design: button labels need 3:1 on the accent", () => {
    const theme = clone();
    theme.preset.design.palette.accent = "#ffffff";
    theme.preset.design.palette.onAccent = "#fafafa";
    expect(
      validateThemeDesign(theme).some((f) => /Button labels/.test(f.message)),
    ).toBe(true);
  });

  it("checks secondary text on card surfaces even when it reads on the page", () => {
    const theme = clone();
    theme.preset.design.palette.cream = "#ffffff";
    theme.preset.design.palette.surface = "#cccccc";
    theme.preset.design.palette.inkSoft = "#666666";
    const messages = validateThemeDesign(theme).map((f) => f.message);
    expect(messages).toContainEqual(
      expect.stringMatching(/Muted text on cards/),
    );
    expect(messages).not.toContainEqual(
      expect.stringMatching(/Muted text on the page background/),
    );
  });

  it("checks the actual butter background of grocery cards", () => {
    const theme = clone();
    theme.preset.design.layout = {
      ...theme.preset.design.layout,
      storefront: "grocery",
    };
    theme.preset.design.palette.butter = theme.preset.design.palette.ink;
    expect(validateThemeDesign(theme).map((f) => f.message)).toContainEqual(
      expect.stringMatching(/Grocery product text on butter cards/),
    );
    theme.preset.design.layout.storefront = "classic";
    expect(validateThemeDesign(theme).map((f) => f.message)).not.toContainEqual(
      expect.stringMatching(/Grocery product text on butter cards/),
    );
  });

  it("checks headings and muted links on the alternate/footer background", () => {
    const theme = clone();
    theme.preset.design.palette.creamDeep = theme.preset.design.palette.ink;
    const messages = validateThemeDesign(theme).map((f) => f.message);
    expect(messages).toContainEqual(
      expect.stringMatching(/including footer headings/),
    );
    expect(messages).toContainEqual(
      expect.stringMatching(/including footer links/),
    );
  });

  it("design: an unregistered layout variant is refused", () => {
    const theme = clone();
    theme.preset.design.layout = { header: "floating" as never };
    expect(codes(validateThemeDesign(theme))).toContain("layout_variant");
  });

  it("brand: placeholder tagline", () => {
    const theme = clone();
    theme.preset.brand.tagline = "Coming soon to you";
    expect(codes(validateThemeDesign(theme))).toContain("tagline_placeholder");
  });

  describe("images", () => {
    it("accepts a production-sized WebP", () => {
      expect(
        validateThemeImage(
          "x",
          { format: "webp", width: 1200, height: 900, bytes: 120_000 },
          { preview: true },
        ),
      ).toEqual([]);
    });

    it("refuses format, width, size and preview aspect problems", () => {
      const issues = validateThemeImage(
        "x",
        { format: "png", width: 400, height: 400, bytes: 600 * 1024 },
        { preview: true },
      );
      expect(issues.join(" ")).toMatch(/WebP or AVIF/);
      expect(issues.join(" ")).toMatch(/800px wide/);
      expect(issues.join(" ")).toMatch(/500 KiB/);
      expect(issues.join(" ")).toMatch(/4:3/);
    });
  });
});

// Copy floors are a Studio rule, not part of validateThemeDefinition, so they
// get their own positive case: every bundled theme must be clean under them.
describe("theme copy floors", () => {
  function homepage(theme: ThemeDefinition) {
    return theme.preset.pages.find((p) => p.slug === "")!;
  }

  it("every bundled theme is clean", () => {
    for (const theme of THEME_DEFINITIONS) {
      expect(validateThemeCopy(theme)).toEqual([]);
    }
  });

  it("unfinished copy in a section, a page title or a product is reported", () => {
    const theme = clone();
    const home = homepage(theme);
    const first = home.sections.find((s) => s.enabled)!;
    (first.config as unknown as Record<string, unknown>).heading =
      "Lorem ipsum dolor";
    home.seo_title = "[Brand] — {{tagline}}";
    theme.preset.sampleData!.products[0].description = "TODO write this";
    expect(codes(validateThemeCopy(theme))).toEqual([
      "placeholder",
      "placeholder",
      "placeholder",
    ]);
  });

  it("lower-case 'todo' is a word, not an authoring note", () => {
    const theme = clone();
    theme.preset.sampleData!.products[0].description = "Un poco de todo.";
    expect(validateThemeCopy(theme)).toEqual([]);
  });

  it("the same module twice with identical content is reported once", () => {
    const theme = clone();
    const home = homepage(theme);
    const usp = home.sections.find((s) => s.enabled && s.type === "usp_bar");
    const source = usp ?? home.sections.find((s) => s.enabled)!;
    home.sections.splice(1, 0, { ...structuredClone(source), id: "dup" });
    expect(codes(validateThemeCopy(theme))).toEqual(["duplicate_section"]);
  });

  it("a closing newsletter is the house convention; two of them is reported", () => {
    const theme = clone();
    const home = homepage(theme);
    const newsletter = {
      id: "nl-end",
      type: "newsletter" as const,
      enabled: true,
      config: {
        heading: "Join us",
        subheading: "",
        button_label: "Join",
        consent_text: "",
        theme: "light",
        alignment: "center",
      },
    } as unknown as (typeof home.sections)[number];
    home.sections = home.sections
      .filter((s) => s.type !== "newsletter")
      .concat(newsletter);
    expect(validateThemeCopy(theme)).toEqual([]);
    home.sections.splice(1, 0, {
      ...structuredClone(newsletter),
      id: "nl-mid",
      config: { ...newsletter.config, heading: "Different" },
    });
    expect(codes(validateThemeCopy(theme))).toEqual(["duplicate_newsletter"]);
  });

  it("a content image without alt text is reported per item", () => {
    const theme = clone();
    const home = homepage(theme);
    home.sections.splice(1, 0, {
      id: "gal",
      type: "gallery",
      enabled: true,
      config: {
        heading: "Lookbook",
        subheading: "",
        items: [
          {
            image_url: "/themes/x/a.webp",
            image_alt: "",
            caption: "",
            href: "",
          },
          {
            image_url: "/themes/x/b.webp",
            image_alt: "Linen",
            caption: "",
            href: "",
          },
          { image_url: "", image_alt: "", caption: "", href: "" },
        ],
        layout: "grid",
        columns: 3,
        image_ratio: "square",
      },
    } as unknown as (typeof home.sections)[number]);
    const found = validateThemeCopy(theme);
    expect(codes(found)).toEqual(["image_alt"]);
    expect(found[0].message).toContain("item 1");
  });

  // Nested blocks: a media_text story and an accordion "image" row render
  // their pictures as content too, so the same rule reaches them.
  it("reaches a media_text story's image and an accordion image row", () => {
    const theme = clone();
    const home = homepage(theme);
    home.sections.splice(
      1,
      0,
      {
        id: "story",
        type: "media_text",
        enabled: true,
        config: {
          eyebrow: "",
          heading: "Made slowly",
          body: "",
          cta_label: "",
          cta_href: "",
          image_url: "",
          image_alt: "",
          media_position: "left",
          media_ratio: "portrait",
          alignment: "left",
          stories: [
            {
              eyebrow: "",
              heading: "Sourced",
              body: "",
              cta_label: "",
              cta_href: "",
              image_url: "/themes/x/valley.webp",
              image_alt: "",
              media_position: "right",
            },
          ],
        },
      } as unknown as (typeof home.sections)[number],
      {
        id: "rows",
        type: "accordion",
        enabled: true,
        config: {
          heading: "Good to know",
          subheading: "",
          items: [
            {
              type: "image",
              heading: "Care",
              body: "Wipe clean.",
              image_url: "/themes/x/care.webp",
              image_alt: "",
            },
            {
              type: "text",
              heading: "Shipping",
              body: "A few days.",
              image_url: "",
              image_alt: "",
            },
          ],
          open_first: true,
          allow_multiple: false,
        },
      } as unknown as (typeof home.sections)[number],
    );
    const found = validateThemeCopy(theme);
    expect(codes(found)).toEqual(["image_alt", "image_alt"]);
    expect(found[0].message).toContain("(media_text) item 1");
    expect(found[1].message).toContain("(accordion) item 1");
  });

  it("reaches both sides of a before/after and a hotspot scene", () => {
    const theme = clone();
    const home = homepage(theme);
    home.sections.splice(
      1,
      0,
      {
        id: "ba",
        type: "before_after",
        enabled: true,
        config: {
          eyebrow: "",
          heading: "",
          subheading: "",
          before: {
            image_url: "/themes/x/b.webp",
            image_alt: "",
            label: "Before",
          },
          after: {
            image_url: "/themes/x/a.webp",
            image_alt: "After",
            label: "After",
          },
          image_ratio: "landscape",
          start: 50,
        },
      } as unknown as (typeof home.sections)[number],
      {
        id: "hs",
        type: "image_hotspots",
        enabled: true,
        config: {
          eyebrow: "",
          heading: "Shop the look",
          subheading: "",
          image_url: "/themes/x/scene.webp",
          image_alt: "",
          image_ratio: "landscape",
          hotspots: [
            { x: 10, y: 10, title: "Jug", body: "", href: "", cta_label: "" },
          ],
        },
      } as unknown as (typeof home.sections)[number],
    );
    const found = validateThemeCopy(theme);
    expect(codes(found)).toEqual(["image_alt", "image_alt"]);
    expect(found[0].message).toContain("(before_after)");
    expect(found[1].message).toContain("(image_hotspots)");
  });
});

// The Studio's stricter design floor (2026-10-10): a button label is small
// text, so on-accent must read on the accent at 4.5:1, where the shared
// contract (and the bundled themes) stop at the 3:1 fill floor.
describe("validateStudioDesign", () => {
  const codes = (theme: ThemeDefinition) =>
    validateStudioDesign(theme).map((f) => `${f.code}: ${f.message}`);
  it("refuses a brand colour whose label reads at 3:1 and accepts a deeper one", () => {
    const theme = structuredClone(THEME_DEFINITIONS[0]);
    expect(validateThemeDesign(theme)).toEqual([]);
    const issues = codes(theme);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("button_label_contrast");
    expect(issues[0]).toContain("brand.primaryColor #ef5a2a read at 3.41:1");
    theme.preset.brand.primaryColor = "#c2410c";
    expect(codes(theme)).toEqual([]);
  });
  it("judges a declared scheme's own accent pair the same way", () => {
    const theme = structuredClone(THEME_DEFINITIONS[0]);
    theme.preset.brand.primaryColor = "#c2410c";
    theme.preset.design.schemes = {
      accent: {
        background: "#1f2937",
        text: "#ffffff",
        accent: "#ef5a2a",
        onAccent: "#ffffff",
      },
    };
    const issues = codes(theme);
    expect(
      issues.some((i) => i.includes("schemes.accent: button labels")),
    ).toBe(true);
  });
});
