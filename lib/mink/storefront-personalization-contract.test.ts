import { describe, expect, it } from "vitest";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  MINK_PERSONALIZATION_MAX_PHOTOS,
  MINK_PERSONALIZATION_PRICES,
  PERSONALIZATION_SECTION_SPECS,
  applyPersonalizationToPage,
  buildPageInventory,
  categorySlugFromName,
  isThemePhotoUrl,
  newRefCounter,
  personalizationLiveChanges,
  planPersonalizationBudget,
  readPersonalizationRequest,
  type PersonalizationPhotoRef,
} from "./storefront-personalization-contract";
import { HOMEPAGE_SECTION_TYPES } from "@/lib/homepage/section-types";

const THEME_HERO = "/themes/basket/hero.webp";
const THEME_TILE = "/themes/basket/tile.webp";
const RELEASE_PHOTO =
  "https://storage.googleapis.com/storemink-media/theme-releases/luxe/1.0.0/hero-0123456789abcdef.webp";
const MERCHANT_UPLOAD =
  "https://storage.googleapis.com/storemink-media/stores/11111111-1111-4111-8111-111111111111/uploads/shop.webp";
const MINK_PHOTO =
  "https://storage.googleapis.com/storemink-media/stores/11111111-1111-4111-8111-111111111111/mink-generated/22222222-2222-4222-8222-222222222222.jpg";

function section(
  id: string,
  type: PageSectionItem["type"],
  config: Record<string, unknown>,
  enabled = true,
): PageSectionItem {
  return {
    id,
    type,
    enabled,
    config: config as unknown as PageSectionItem["config"],
  };
}

const homeSections = (): PageSectionItem[] => [
  section("hero", "hero", {
    variant: "banner",
    heading: "Fresh produce, delivered",
    subheading: "From farm to door",
    cta_label: "Shop now",
    cta_href: "/shop",
    image_url: THEME_HERO,
    mobile_image_url: "/themes/basket/hero-phone.webp",
    focal_x: 30,
  }),
  section("tiles", "tile_grid", {
    heading: "Shop the aisles",
    tiles: [
      { title: "Fruit", image_url: THEME_TILE, href: "/collections/fruit" },
      {
        title: "Bakery",
        image_url: MERCHANT_UPLOAD,
        href: "/collections/bakery",
      },
      { title: "Dairy", background: "#f5e1c8", href: "/collections/dairy" },
    ],
  }),
  section("quotes", "testimonials", {
    heading: "Loved by thousands",
    items: [{ quote: "Best grocer in town", name: "Asha" }],
  }),
  section("trust", "usp_bar", {
    items: [
      {
        icon: "truck",
        title: "Free delivery",
        subtitle: "On orders over Rs 499",
      },
    ],
  }),
  section("code", "custom_code", { html: "<div>mine</div>", css: "", js: "" }),
  section(
    "old",
    "hero",
    { heading: "Switched off", image_url: THEME_HERO },
    false,
  ),
];

describe("the section table", () => {
  it("★ decides every section type, so a new one cannot be written by accident", () => {
    for (const type of HOMEPAGE_SECTION_TYPES) {
      expect(PERSONALIZATION_SECTION_SPECS[type], type).toBeDefined();
    }
  });

  it("★★ hides sample claims instead of rewriting them, and never touches custom code", () => {
    for (const type of [
      "testimonials",
      "comparison",
      "image_hotspots",
      "before_after",
      "logo_strip",
      "countdown",
    ] as const) {
      expect(PERSONALIZATION_SECTION_SPECS[type].handling, type).toBe("hide");
    }
    expect(PERSONALIZATION_SECTION_SPECS.custom_code.handling).toBe("keep");
  });

  it("never offers a link, colour or layout field to the writer", () => {
    for (const spec of Object.values(PERSONALIZATION_SECTION_SPECS)) {
      const keys = [
        ...(spec.fields ?? []).map((field) => field.key),
        ...(spec.lists ?? []).flatMap((list) =>
          list.fields.map((field) => field.key),
        ),
      ];
      for (const key of keys) {
        expect(key).not.toMatch(
          /href|background|colou?r|variant|layout|source/,
        );
      }
    }
  });
});

describe("theme photos", () => {
  it.each([
    [THEME_HERO, true],
    [RELEASE_PHOTO, true],
    [MERCHANT_UPLOAD, false],
    [MINK_PHOTO, false],
    ["https://images.example.com/photo.jpg", false],
    ["http://storage.googleapis.com/b/theme-releases/x.webp", false],
    ["/themes/../uploads/x.webp", false],
    ["https://abc.supabase.co/storage/v1/object/public/media/hero.jpg", false],
    ["", false],
  ])("%s is a theme photo: %s", (url, expected) => {
    expect(isThemePhotoUrl(url)).toBe(expected);
  });
});

describe("the page inventory", () => {
  it("offers the visible theme text and theme photos, and hides the sample quotes", () => {
    const inventory = buildPageInventory(
      "home",
      "Home",
      homeSections(),
      newRefCounter(),
      "all",
    );
    expect(
      inventory.texts.map((text) => [text.sectionId, text.path.join(".")]),
    ).toEqual([
      ["hero", "heading"],
      ["hero", "subheading"],
      ["hero", "cta_label"],
      ["tiles", "heading"],
      ["tiles", "tiles.0.title"],
      ["tiles", "tiles.1.title"],
      ["tiles", "tiles.2.title"],
    ]);
    // ★★ The merchant's own upload and the colour tile are not candidates.
    expect(
      inventory.photos.map((photo) => [photo.sectionId, photo.path.join(".")]),
    ).toEqual([
      ["hero", "image_url"],
      ["tiles", "tiles.0.image_url"],
    ]);
    expect(inventory.photos[0].shape).toBe("wide");
    expect(inventory.photos[1].shape).toBe("square");
    expect(inventory.hidden).toEqual([
      expect.objectContaining({ sectionId: "quotes", type: "testimonials" }),
    ]);
    expect(inventory.lists).toEqual([
      expect.objectContaining({ sectionId: "trust", kind: "usp", maxItems: 6 }),
    ]);
  });

  it("★★ leaves the merchant's own sections' words alone and keeps their quotes on", () => {
    // Only the hero is still the theme's: the tiles and the testimonials are
    // the merchant's (real quotes they added), so nothing there is rewritten
    // or switched off. The theme photo inside their tiles is still offered,
    // since that picture was never theirs.
    const inventory = buildPageInventory(
      "home",
      "Home",
      homeSections(),
      newRefCounter(),
      new Set(["hero"]),
    );
    expect(new Set(inventory.texts.map((text) => text.sectionId))).toEqual(
      new Set(["hero"]),
    );
    expect(inventory.hidden).toEqual([]);
    expect(inventory.lists).toEqual([]);
    expect(
      inventory.photos.map((entry) => [entry.sectionId, entry.path.join(".")]),
    ).toEqual([
      ["hero", "image_url"],
      ["tiles", "tiles.0.image_url"],
    ]);
  });

  it("leaves switched-off sections and custom code out entirely", () => {
    const inventory = buildPageInventory(
      "home",
      "Home",
      homeSections(),
      newRefCounter(),
      "all",
    );
    const ids = new Set([
      ...inventory.texts.map((text) => text.sectionId),
      ...inventory.photos.map((photo) => photo.sectionId),
    ]);
    expect(ids.has("old")).toBe(false);
    expect(ids.has("code")).toBe(false);
  });

  it("numbers refs across pages with one shared counter", () => {
    const counter = newRefCounter();
    const home = buildPageInventory(
      "home",
      "Home",
      homeSections(),
      counter,
      "all",
    );
    const about = buildPageInventory(
      "about",
      "About",
      [
        section("story", "media_text", {
          heading: "Our story",
          image_url: THEME_HERO,
        }),
      ],
      counter,
      "all",
    );
    const refs = [...home.texts, ...about.texts].map((text) => text.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(about.photos[0].ref).toBe(`p${home.photos.length + 1}`);
  });

  it("asks for a portrait photo beside the copy of a split hero", () => {
    const inventory = buildPageInventory(
      "home",
      "Home",
      [
        section("hero", "hero", {
          variant: "split",
          heading: "Hi",
          image_url: THEME_HERO,
        }),
      ],
      newRefCounter(),
      "all",
    );
    expect(inventory.photos[0].shape).toBe("portrait");
  });
});

function photo(
  ref: string,
  pageSlug: string,
  rank: number,
  order: number,
): PersonalizationPhotoRef {
  return {
    ref,
    pageSlug,
    sectionId: `s-${ref}`,
    sectionType: "hero",
    path: ["image_url"],
    altPath: null,
    clears: [],
    label: ref,
    shape: "wide",
    current: THEME_HERO,
    rank,
    order,
  };
}

describe("the budget", () => {
  const photos = [
    photo("p1", "home", 0, 1),
    photo("p2", "home", 2, 2),
    photo("p3", "about", 1, 3),
  ];

  it("buys the homepage first, then the look, the header, the home photos and each other page with its photos", () => {
    const plan = planPersonalizationBudget({
      remaining: null,
      pages: ["home", "about"],
      design: true,
      chrome: true,
      categoryCount: 1,
      photos,
    });
    expect(
      plan.included.map((item) =>
        item.kind === "page"
          ? `page:${item.pageSlug}`
          : item.kind === "photo"
            ? `photo:${item.ref}`
            : item.kind,
      ),
    ).toEqual([
      "page:home",
      "design",
      "chrome",
      "category",
      "photo:p1",
      "photo:p2",
      "page:about",
      "photo:p3",
    ]);
    expect(plan.unaffordable).toEqual([]);
  });

  it("★★ draws a category's photo only when the category itself is bought, without taking a photo place", () => {
    // At today's prices a category (1 credit) always fits before a photo (3)
    // does, so the rule is tested directly: a photo whose category is not
    // bought is left out, and the photo places go to the next ones.
    const plan = planPersonalizationBudget({
      remaining: null,
      pages: ["home"],
      design: false,
      chrome: false,
      categoryCount: 0,
      categorySlugs: [],
      photos: [
        { ...photo("pc", "home", 2, 0), categorySlug: "candles" },
        photo("p1", "home", 0, 1),
        photo("p2", "home", 2, 2),
      ],
      maxPhotos: 2,
    });
    const refs = plan.included.flatMap((item) =>
      item.kind === "photo" ? [item.ref] : [],
    );
    expect(refs).toEqual(["p1", "p2"]);
    expect(plan.withoutCategory).toEqual(["pc"]);
    expect(plan.overPhotoLimit).toEqual([]);
  });

  it("draws the category's photo when the category is bought", () => {
    const plan = planPersonalizationBudget({
      remaining: null,
      pages: ["home"],
      design: false,
      chrome: false,
      categoryCount: 1,
      categorySlugs: ["candles"],
      photos: [{ ...photo("pc", "home", 2, 0), categorySlug: "candles" }],
    });
    expect(plan.included.map((item) => item.kind)).toEqual([
      "page",
      "category",
      "photo",
    ]);
    expect(plan.withoutCategory).toEqual([]);
  });

  it("★ skips what does not fit and keeps going, so cheaper items still land", () => {
    const plan = planPersonalizationBudget({
      remaining:
        MINK_PERSONALIZATION_PRICES.page + MINK_PERSONALIZATION_PRICES.design,
      pages: ["home"],
      design: true,
      chrome: false,
      categoryCount: 0,
      photos,
    });
    expect(plan.included.map((item) => item.kind)).toEqual(["page", "design"]);
    expect(plan.unaffordable.map((item) => item.kind)).toEqual([
      "photo",
      "photo",
    ]);
    expect(plan.credits).toBe(
      MINK_PERSONALIZATION_PRICES.page + MINK_PERSONALIZATION_PRICES.design,
    );
  });

  it("draws at most the photo limit, most visible first", () => {
    const many = Array.from(
      { length: MINK_PERSONALIZATION_MAX_PHOTOS + 3 },
      (_, index) => photo(`p${index + 1}`, "home", 0, index + 1),
    );
    const plan = planPersonalizationBudget({
      remaining: null,
      pages: ["home"],
      design: false,
      chrome: false,
      categoryCount: 0,
      photos: many,
    });
    expect(plan.included.filter((item) => item.kind === "photo")).toHaveLength(
      MINK_PERSONALIZATION_MAX_PHOTOS,
    );
    expect(plan.overPhotoLimit).toEqual(["p13", "p14", "p15"]);
  });

  it("★ a photos-only pass buys photos alone, across every page", () => {
    const plan = planPersonalizationBudget({
      remaining: null,
      pages: ["home", "about"],
      design: true,
      chrome: true,
      categoryCount: 2,
      photos,
      photosOnly: true,
    });
    expect(plan.included.map((item) => item.kind)).toEqual([
      "photo",
      "photo",
      "photo",
    ]);
    expect(plan.credits).toBe(3 * MINK_PERSONALIZATION_PRICES.photo);
  });
});

describe("applying the writer's answer", () => {
  function apply(
    texts: Record<string, string>,
    photos: Record<string, string> = {},
    lists = {},
  ) {
    const sections = homeSections();
    const inventory = buildPageInventory(
      "home",
      "Home",
      sections,
      newRefCounter(),
      "all",
    );
    const byPath = new Map(
      inventory.texts.map((text) => [
        `${text.sectionId}:${text.path.join(".")}`,
        text.ref,
      ]),
    );
    const photoRefs = new Map(
      inventory.photos.map((entry) => [
        `${entry.sectionId}:${entry.path.join(".")}`,
        entry.ref,
      ]),
    );
    const result = applyPersonalizationToPage({
      sections,
      inventory,
      texts: new Map(
        Object.entries(texts).map(([key, value]) => [byPath.get(key)!, value]),
      ),
      lists: new Map(Object.entries(lists)),
      photos: new Map(
        Object.entries(photos).map(([key, url]) => [
          photoRefs.get(key)!,
          { url, alt: "A candle" },
        ]),
      ),
      toHtml: (prose) => `<p>${prose}</p>`,
    });
    return { sections, inventory, result };
  }

  it("rewrites text, swaps a theme photo and clears the old photo's phone image and focal point", () => {
    const { result, sections } = apply(
      { "hero:heading": "Hand-poured candles from Pune" },
      { "hero:image_url": MINK_PHOTO },
    );
    const hero = result.sections.find((entry) => entry.id === "hero")!;
    const config = hero.config as unknown as Record<string, unknown>;
    expect(config.heading).toBe("Hand-poured candles from Pune");
    expect(config.image_url).toBe(MINK_PHOTO);
    expect(config.mobile_image_url).toBeUndefined();
    expect(config.focal_x).toBeUndefined();
    // ★ Links are untouched, and the input is never mutated.
    expect(config.cta_href).toBe("/shop");
    expect(
      (sections[0].config as unknown as Record<string, unknown>).heading,
    ).toBe("Fresh produce, delivered");
    expect(result.textChanges).toBe(1);
    expect(result.photoChanges).toBe(1);
  });

  it("★ says which section each change landed in, so a reverted one is not counted", () => {
    const { result } = apply(
      {
        "hero:heading": "Hand-poured candles from Pune",
        "tiles:heading": "Shop the candles",
        "tiles:tiles.0.title": "Pillars",
      },
      { "hero:image_url": MINK_PHOTO },
    );
    expect(result.textChangesBySection).toEqual({ hero: 1, tiles: 2 });
    expect(result.photosApplied).toEqual([
      { ref: expect.any(String), sectionId: "hero" },
    ]);
  });

  it("switches the sample quotes off and lists them as hidden", () => {
    const { result } = apply({});
    const quotes = result.sections.find((entry) => entry.id === "quotes")!;
    expect(quotes.enabled).toBe(false);
    expect(result.hiddenSectionIds).toContain("quotes");
  });

  it("★ an empty replacement list hides the section rather than emptying it", () => {
    const { result, inventory } = apply({}, {}, {});
    const trustRef = inventory.lists[0].ref;
    const again = applyPersonalizationToPage({
      sections: homeSections(),
      inventory,
      texts: new Map(),
      lists: new Map([[trustRef, []]]),
      photos: new Map(),
      toHtml: (prose) => prose,
    });
    expect(again.sections.find((entry) => entry.id === "trust")!.enabled).toBe(
      false,
    );
    expect(result.sections.find((entry) => entry.id === "trust")!.enabled).toBe(
      true,
    );
  });

  it("★★ never writes over text the merchant changed after the inventory was read", () => {
    const sections = homeSections();
    const inventory = buildPageInventory(
      "home",
      "Home",
      sections,
      newRefCounter(),
      "all",
    );
    (sections[0].config as unknown as Record<string, unknown>).heading =
      "My own words";
    const ref = inventory.texts.find(
      (text) => text.path.join(".") === "heading",
    )!.ref;
    const result = applyPersonalizationToPage({
      sections,
      inventory,
      texts: new Map([[ref, "Rewritten"]]),
      lists: new Map(),
      photos: new Map(),
      toHtml: (prose) => prose,
    });
    const hero = result.sections.find((entry) => entry.id === "hero")!;
    expect((hero.config as unknown as Record<string, unknown>).heading).toBe(
      "My own words",
    );
    expect(result.textChanges).toBe(0);
  });

  it("does not blank a required field", () => {
    const { result } = apply({ "tiles:tiles.0.title": "   " });
    const tiles = result.sections.find((entry) => entry.id === "tiles")!;
    const config = tiles.config as unknown as {
      tiles: Array<{ title: string }>;
    };
    expect(config.tiles[0].title).toBe("Fruit");
  });
});

const brief = {
  what_you_sell: "Hand-poured soy candles",
  look_and_feel: "Warm and calm",
};

describe("the tool's arguments", () => {
  it("accepts a complete request and defaults the language to English", () => {
    const parsed = readPersonalizationRequest({
      brief,
      unpublish_sample_products: true,
      explanation: "Makes the store about candles.",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.brief.language).toBe("English");
    expect(parsed.value.unpublishSampleProducts).toBe(true);
    expect(parsed.value.photosOnly).toBe(false);
  });

  it("names every missing answer at once", () => {
    const parsed = readPersonalizationRequest({
      brief: {},
      unpublish_sample_products: false,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join(" ")).toMatch(/what_you_sell/);
    expect(parsed.issues.join(" ")).toMatch(/look_and_feel/);
    expect(parsed.issues.join(" ")).toMatch(/explanation/);
  });

  it("★★ refuses a category change the merchant did not confirm", () => {
    const parsed = readPersonalizationRequest({
      brief,
      unpublish_sample_products: false,
      explanation: "Renames a category.",
      categories: [{ action: "update", slug: "fruit", name: "Candles" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]).toMatch(/ask the merchant/);
  });

  it("accepts confirmed category changes of each kind", () => {
    const parsed = readPersonalizationRequest({
      brief,
      unpublish_sample_products: false,
      explanation: "Categories.",
      categories: [
        {
          action: "update",
          slug: "fruit",
          name: "Candles",
          merchant_confirmed: true,
        },
        {
          action: "create",
          name: "Gift sets",
          new_photo: true,
          merchant_confirmed: true,
        },
        { action: "hide", slug: "dairy", merchant_confirmed: true },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.categories.map((change) => change.action)).toEqual([
      "update",
      "create",
      "hide",
    ]);
  });

  it("refuses a design without the context's digest", () => {
    const parsed = readPersonalizationRequest({
      brief,
      unpublish_sample_products: false,
      explanation: "A new look.",
      design: { palette: { accent: "#123456" } },
    });
    expect(parsed.ok).toBe(false);
  });

  it("★ a photos-only pass may change nothing else", () => {
    const ok = readPersonalizationRequest({
      brief,
      unpublish_sample_products: false,
      photos_only: true,
      explanation: "The remaining photos.",
    });
    expect(ok.ok && ok.value.photosOnly).toBe(true);
    const refused = readPersonalizationRequest({
      brief,
      unpublish_sample_products: true,
      photos_only: true,
      explanation: "The remaining photos.",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.issues.join(" ")).toMatch(/photos_only/);
  });
});

describe("helpers", () => {
  it("makes a category address the way the category editor does", () => {
    expect(categorySlugFromName("Crème Brûlée & Gifts")).toBe(
      "creme-brulee-and-gifts",
    );
    expect(categorySlugFromName("  Hand-made   Soaps!! ")).toBe(
      "hand-made-soaps",
    );
  });

  it("lists what goes live the moment the card is applied", () => {
    expect(
      personalizationLiveChanges({ categories: [], products: [], brand: null }),
    ).toEqual([]);
    expect(
      personalizationLiveChanges({
        categories: [
          {
            action: "hide",
            id: "c",
            slug: "dairy",
            expectedUpdatedAt: "x",
            name: "Dairy",
          },
        ] as never,
        products: [{ id: "p", name: "Milk (Sample)", expectedUpdatedAt: "x" }],
        brand: { expectedDigest: "d", tagline: "Candles", blurb: null },
      }),
    ).toHaveLength(3);
  });
});
