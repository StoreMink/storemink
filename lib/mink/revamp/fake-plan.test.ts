import { describe, expect, it } from "vitest";
import { EMPTY_CONFIG, SECTION_BLOCKS } from "@/lib/homepage/section-types";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  REVAMP_PRICES,
  type RevampRequest,
  type RevampSnapshot,
  type RevampSnapshotPage,
} from "./contract";
import {
  assembleRevampPlan,
  estimateRevampCredits,
  fitRevampPlanToBudget,
  REVAMP_BRAND_PERMISSION_NOTE,
  revampOpeningBinding,
} from "./assemble";
import {
  DESIGN_DIRECTION_IDS,
  DESIGN_DIRECTIONS,
} from "@/lib/theme-studio/design-directions";
import { readsAsLanguage, unsupportedClaimsIn } from "./copy-checks";
import { FAKE_PLAN_LIGHTS, fakeRevampSiteOutput } from "./fake-plan";
import {
  compileRevampSite,
  isLightColour,
  REVAMP_SECTION_TYPES,
  revampAnswerPromptVersion,
  revampCategoryShotId,
  revampPageFitsDirection,
  revampRefillSlots,
} from "./site-compiler";
import {
  REVAMP_SITE_PROMPT_VERSION,
  REVAMP_SITE_SCHEMA,
  revampIndustryGuess,
  revampPromptExample,
} from "./site-schema";

/** Stores the seeded choices are checked across (ids only: no store is read). */
const STORE_IDS = Array.from(
  { length: 24 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);

// ---------------------------------------------------------------------------
// Fixtures: three stores the fake plan must compile clean for.
// ---------------------------------------------------------------------------

function section(
  id: string,
  type: keyof typeof EMPTY_CONFIG,
  config: Record<string, unknown> = {},
): PageSectionItem {
  return {
    id,
    type,
    enabled: true,
    config: { ...EMPTY_CONFIG[type], ...config },
  } as unknown as PageSectionItem;
}

function page(
  slug: string,
  title: string,
  sections: PageSectionItem[],
  owners: Record<string, "theme" | "mink" | "merchant">,
  extra: Partial<RevampSnapshotPage> = {},
): RevampSnapshotPage {
  return {
    id: `page-${slug || "home"}`,
    slug,
    title,
    status: "published",
    version: "2026-10-01 10:00:00.123456+00",
    sectionsDigest: `digest-${slug}`,
    sections,
    owners,
    skipped: null,
    seoTitle: null,
    seoDescription: null,
    ...extra,
  };
}

const policyPage = page(
  "refund-policy",
  "Refund policy",
  [section("p1", "rich_text", { html: "<p>Refunds.</p>" })],
  { p1: "merchant" },
  { skipped: "policy" },
);

function snapshot(overrides: Partial<RevampSnapshot>): RevampSnapshot {
  return {
    storeId: "store-1",
    storeName: "Store",
    storeSlug: "store",
    launched: false,
    theme: {
      id: "basket",
      version: "1.0.0",
      name: "Basket",
      palette: {
        page: "#fbf7ef",
        surface: "#ffffff",
        ink: "#1d1d1b",
        accent: "#ef5a2a",
      },
      layout: {},
    },
    pages: [],
    chrome: {
      rowExists: false,
      version: null,
      digest: "chrome",
      value: {} as unknown as RevampSnapshot["chrome"]["value"],
    },
    brand: { tagline: null, blurb: null, digest: "brand" },
    categories: [],
    products: [],
    facts: {
      delivery: null,
      freeDeliveryAbove: null,
      returns: null,
      pickup: false,
      onlinePayments: false,
      cashOnDelivery: false,
      city: null,
      state: null,
    },
    photos: { replaceable: [], broken: [] },
    entitlements: { customCode: false },
    ...overrides,
  };
}

function request(overrides: Partial<RevampRequest>): RevampRequest {
  return {
    kind: "full",
    brief: {
      business: "A shop.",
      look: "",
      audience: "",
      facts: [],
      avoid: "",
      language: "English",
    },
    products: [],
    categories: [],
    pages: null,
    instruction: null,
    refineScope: null,
    ...overrides,
  };
}

const sampleCategory = (slug: string, name: string) => ({
  id: `cat-${slug}`,
  slug,
  name,
  description: null,
  imageUrl: `/themes/basket/${slug}.webp`,
  status: "active",
  updatedAt: "2026-10-01T00:00:00Z",
  sample: true,
  productCount: 2,
});

const sampleProduct = (slug: string, name: string) => ({
  id: `prod-${slug}`,
  name,
  slug,
  status: "draft",
  updatedAt: "2026-10-01T00:00:00Z",
  sample: true,
  imageUrl: `/themes/basket/${slug}.webp`,
  categoryId: null,
});

/** Merchant products and confirmed category changes (a spice shop). */
function spiceShop() {
  const home = page(
    "",
    "Home",
    [
      section("h1", "hero", { image_url: "/themes/basket/hero.webp" }),
      section("h2", "featured_products"),
    ],
    { h1: "theme", h2: "theme" },
  );
  const story = page(
    "our-story",
    "Our Story",
    [section("s1", "rich_text", { html: "<p>Fresh from the farm.</p>" })],
    { s1: "theme" },
  );
  const contact = page(
    "contact",
    "Contact",
    [section("c1", "rich_text", { html: "<p>Write to us.</p>" })],
    { c1: "theme" },
  );
  return {
    request: request({
      brief: {
        business:
          "Ground spices and spice blends from our family kitchen in Jaipur, packed for home cooks.",
        look: "Warm and earthy",
        audience: "Home cooks",
        facts: [
          "We grind every blend in small lots each week",
          "Every pack is sealed the day it is ground",
        ],
        avoid: "Loud colours",
        language: "English",
      },
      products: [
        {
          key: "p1",
          name: "Garam Masala",
          description: "A warming blend for curries and dals.",
          sizes: [
            { label: "100 g", price: 120, mrp: null },
            { label: "250 g", price: 260, mrp: 300 },
          ],
          photoUrl: null,
          categorySlug: "spice-blends",
        },
        {
          key: "p2",
          name: "Turmeric Powder",
          description: "Bright ground turmeric for everyday cooking.",
          sizes: [{ label: "200 g", price: 90, mrp: null }],
          photoUrl: null,
          categorySlug: "ground-spices",
        },
      ],
      categories: [
        { action: "hide", slug: "fruits" },
        { action: "hide", slug: "vegetables" },
        {
          action: "create",
          name: "Ground spices",
          slug: null,
          description: null,
          newPhoto: true,
        },
        {
          action: "create",
          name: "Spice blends",
          slug: null,
          description: null,
          newPhoto: true,
        },
      ],
    }),
    snapshot: snapshot({
      storeName: "Asha Masala Co",
      storeSlug: "asha",
      pages: [home, story, contact, policyPage],
      categories: [
        sampleCategory("fruits", "Fresh Fruits"),
        sampleCategory("vegetables", "Vegetables"),
      ],
      products: [sampleProduct("apples", "Apples (Sample)")],
      facts: {
        delivery: "Delivery across India in 3 to 5 days",
        freeDeliveryAbove: 499,
        returns: "Unopened packs can be returned within 7 days",
        pickup: false,
        onlinePayments: true,
        cashOnDelivery: true,
        city: "Jaipur",
        state: "Rajasthan",
      },
    }),
    previous: null,
  };
}

/** No products and no categories of the merchant's own (a linen shop). */
function linenShop() {
  const home = page(
    "",
    "Home",
    [section("h1", "hero"), section("h2", "shop_by_category")],
    { h1: "theme", h2: "theme" },
  );
  const about = page(
    "about",
    "About",
    [section("a1", "rich_text", { html: "<p>The best shop in town.</p>" })],
    { a1: "theme" },
  );
  return {
    request: request({
      brief: {
        business:
          "Cotton bedsheets and cushion covers woven on looms in Panipat.",
        look: "Calm and simple",
        audience: "",
        facts: [],
        avoid: "",
        language: "English",
      },
    }),
    snapshot: snapshot({
      storeName: "Leaf and Loom",
      storeSlug: "leaf",
      pages: [home, about],
      categories: [sampleCategory("shirts", "Shirts")],
      products: [
        { ...sampleProduct("tee", "Tee (Sample)"), status: "published" },
      ],
      facts: {
        delivery: null,
        freeDeliveryAbove: null,
        returns: null,
        pickup: false,
        onlinePayments: true,
        cashOnDelivery: false,
        city: null,
        state: null,
      },
    }),
    previous: null,
  };
}

/** A merchant section holding a theme photo, on a dark theme (a tea house). */
function teaHouse() {
  const home = page(
    "",
    "Home",
    [
      section("h1", "hero", { image_url: "/themes/noir/hero.webp" }),
      section("m1", "media_text", {
        heading: "Our garden",
        body: "Where our leaves come from.",
        image_url: "/themes/noir/story.webp",
      }),
      section("h3", "newsletter"),
    ],
    { h1: "theme", m1: "merchant", h3: "theme" },
  );
  const story = page(
    "our-story",
    "Our Story",
    [
      section("s1", "rich_text", { html: "<p>Started by two sisters.</p>" }),
      section("s2", "rich_text", { html: "<p>Theme words.</p>" }),
    ],
    { s1: "merchant", s2: "theme" },
  );
  return {
    request: request({
      brief: {
        business: "Loose leaf teas and tisanes blended in Darjeeling.",
        look: "Dark and quiet",
        audience: "Tea lovers",
        facts: ["Every tea is packed in a paper pouch"],
        avoid: "",
        language: "English",
      },
    }),
    snapshot: snapshot({
      storeName: "Bloom Tea House",
      storeSlug: "bloom",
      theme: {
        id: "noir",
        version: "1.0.0",
        name: "Noir",
        palette: {
          page: "#121212",
          surface: "#1c1c1c",
          ink: "#f2f2f2",
          accent: "#c9a227",
        },
        layout: {},
      },
      pages: [home, story],
      products: [
        {
          id: "prod-real",
          name: "Darjeeling First Flush",
          slug: "darjeeling-first-flush",
          status: "published",
          updatedAt: "2026-10-01T00:00:00Z",
          sample: false,
          imageUrl: null,
          categoryId: null,
        },
      ],
    }),
    previous: null,
  };
}

type Fixture = ReturnType<typeof spiceShop>;

/** Every photo a section config shows (its phone crops are the same photo). */
function imageValues(node: unknown, key = ""): string[] {
  if (typeof node === "string") {
    return key.endsWith("_url") &&
      key !== "video_url" &&
      key !== "mobile_image_url" &&
      node.trim()
      ? [node]
      : [];
  }
  if (Array.isArray(node)) return node.flatMap((n) => imageValues(n, key));
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => imageValues(v, k));
  }
  return [];
}

const FIXTURES: Array<[string, () => Fixture]> = [
  ["merchant products and category changes", spiceShop],
  ["no products", linenShop],
  ["a merchant section holding a theme photo", teaHouse],
];

// ---------------------------------------------------------------------------

describe("fakeRevampSiteOutput", () => {
  it.each(FIXTURES)("compiles with zero issues: %s", (_name, make) => {
    const input = make();
    const result = compileRevampSite(fakeRevampSiteOutput(input), input);
    expect(result.issues).toEqual([]);
    expect(result.plan).not.toBeNull();
  });

  it.each(FIXTURES)(
    "opens the homepage on a carousel of photographs and closes it with a newsletter: %s",
    (_name, make) => {
      const input = make();
      const plan = compileRevampSite(fakeRevampSiteOutput(input), input).plan!;
      const home = plan.pages.find((p) => p.slug === "")!;
      const first = home.sections[0];
      const config = first.config as unknown as {
        slides: Array<{ image_url: string }>;
      };
      expect(first.type).toBe("hero_carousel");
      expect(config.slides).toHaveLength(3);
      for (const slide of config.slides) {
        expect(slide.image_url).toMatch(/^revamp-slot:\/\//);
      }
      expect(new Set(config.slides.map((s) => s.image_url)).size).toBe(3);
      expect(first.style?.width).toBe("full");
      expect(home.sections[home.sections.length - 1].type).toBe("newsletter");
    },
  );

  it.each(FIXTURES)(
    "draws a storefront led by photographs (live-1): %s",
    (_name, make) => {
      const input = make();
      const plan = compileRevampSite(fakeRevampSiteOutput(input), input).plan!;
      const photosOn = (sections: PageSectionItem[]) =>
        new Set(
          sections
            .filter(
              (s) =>
                s.type !== "featured_products" &&
                s.type !== "product_spotlight",
            )
            .flatMap((s) => imageValues(s.config)),
        );
      const home = plan.pages.find((p) => p.slug === "")!;
      expect(photosOn(home.sections).size).toBeGreaterThanOrEqual(3);
      expect(plan.shots.length).toBeGreaterThanOrEqual(8);
      expect(plan.shots.length).toBeLessThanOrEqual(26);
      // A photo-led band besides the opening: a gallery of four.
      const gallery = home.sections.find((s) => s.type === "gallery");
      expect(
        (gallery?.config as unknown as { items: unknown[] } | undefined)?.items,
      ).toHaveLength(4);
      // Every page the redesign writes carries at least one photograph.
      for (const page of plan.pages) {
        expect(photosOn(page.sections).size).toBeGreaterThan(0);
      }
    },
  );

  it.each(FIXTURES)(
    "writes the summary to the merchant, homepage first (live-4): %s",
    (_name, make) => {
      const input = make();
      const plan = compileRevampSite(fakeRevampSiteOutput(input), input).plan!;
      expect(plan.summary).toMatch(/^Your homepage now opens on/);
      expect(plan.summary).not.toMatch(/\b(we|our|us)\b/i);
    },
  );

  it("is deterministic", () => {
    const input = spiceShop();
    expect(JSON.stringify(fakeRevampSiteOutput(input))).toBe(
      JSON.stringify(fakeRevampSiteOutput(spiceShop())),
    );
  });

  it("uses product and category sections only when they will be real", () => {
    const spice = spiceShop();
    const spiceHome = compileRevampSite(
      fakeRevampSiteOutput(spice),
      spice,
    ).plan!.pages.find((p) => p.slug === "")!;
    const spiceTypes = spiceHome.sections.map((s) => s.type);
    expect(spiceTypes).toContain("featured_products");
    expect(spiceTypes).toContain("shop_by_category");

    const linen = linenShop();
    const linenHome = compileRevampSite(
      fakeRevampSiteOutput(linen),
      linen,
    ).plan!.pages.find((p) => p.slug === "")!;
    const linenTypes = linenHome.sections.map((s) => s.type);
    expect(linenTypes).not.toContain("featured_products");
    expect(linenTypes).not.toContain("shop_by_category");
  });

  it("★★ shows the merchant's photographed products by key, or a scene with no products (B16)", () => {
    const input = spiceShop();
    const photo = (name: string) =>
      `https://storage.googleapis.com/sm-media/stores/store-1/uploads/${name}.webp`;
    input.request.products = input.request.products.map((p, i) => ({
      ...p,
      photoUrl: photo(`product-${i + 1}`),
    }));
    const result = compileRevampSite(fakeRevampSiteOutput(input), input);
    expect(result.issues).toEqual([]);
    const goods = Object.fromEntries(
      result.plan!.shots.map((s) => [s.id, [s.goods, s.productKeys]]),
    );
    expect(goods["home-hero"]).toEqual(["merchant", ["p1", "p2"]]);
    expect(goods["home-gallery-1"]).toEqual(["merchant", ["p1"]]);
    expect(goods["home-gallery-2"]).toEqual(["merchant", ["p2"]]);
    expect(goods["home-gallery-3"]).toEqual(["none", []]);
    expect(goods[revampCategoryShotId("spice-blends")]).toEqual([
      "merchant",
      ["p1"],
    ]);
    expect(goods[revampCategoryShotId("ground-spices")]).toEqual([
      "merchant",
      ["p2"],
    ]);
    // Both kinds, and every scene says it has no products in it.
    const kinds = new Set(result.plan!.shots.map((s) => s.goods));
    expect(kinds).toEqual(new Set(["merchant", "none"]));
    for (const shot of result.plan!.shots.filter((s) => s.goods === "none")) {
      expect(shot.subject).toMatch(/no products in the picture/);
    }
  });

  it("makes every shot a scene with no products when no product has a photo", () => {
    const input = spiceShop();
    const plan = compileRevampSite(fakeRevampSiteOutput(input), input).plan!;
    for (const shot of plan.shots) {
      expect(shot.goods).toBe("none");
      expect(shot.productKeys).toEqual([]);
      expect(shot.subject).toMatch(/no products in the picture/);
    }
  });

  it("describes a category shot for each confirmed category photo", () => {
    const input = spiceShop();
    const plan = compileRevampSite(fakeRevampSiteOutput(input), input).plan!;
    const ids = plan.shots.map((s) => s.id);
    expect(ids).toContain(revampCategoryShotId("ground-spices"));
    expect(ids).toContain(revampCategoryShotId("spice-blends"));
    const bound = plan.bindings
      .filter((b) => b.pageSlug === "@category")
      .map((b) => b.sectionId)
      .sort();
    expect(bound).toEqual(["ground-spices", "spice-blends"]);
  });

  it("keeps the merchant's sections by id and refills their theme photo", () => {
    const input = teaHouse();
    const refills = revampRefillSlots(input);
    expect(refills).toHaveLength(1);
    const plan = compileRevampSite(fakeRevampSiteOutput(input), input).plan!;
    const home = plan.pages.find((p) => p.slug === "")!;
    const kept = home.sections.find((s) => s.id === "m1")!;
    expect(kept).toBeDefined();
    const config = kept.config as unknown as Record<string, unknown>;
    expect(config.heading).toBe("Our garden");
    expect(config.image_url).toBe(`revamp-slot://${refills[0].shotId}`);
    expect(plan.shots.map((s) => s.id)).toContain(refills[0].shotId);
    const story = plan.pages.find((p) => p.slug === "our-story")!;
    expect(story.sections.map((s) => s.id)).toContain("s1");
    expect(story.sections.map((s) => s.id)).not.toContain("s2");
  });

  it("keeps a dark theme dark, whichever page it picks, and the theme's accent", () => {
    for (const storeId of STORE_IDS) {
      const input = teaHouse();
      input.snapshot.storeId = storeId;
      const raw = fakeRevampSiteOutput(input) as {
        design: { palette: Record<string, string> };
      };
      expect(isLightColour(raw.design.palette.cream), storeId).toBe(false);
      expect(raw.design.palette.accent).toBe("#c9a227");
    }
  });

  it("links only to targets that will exist", () => {
    const input = spiceShop();
    const raw = fakeRevampSiteOutput(input) as {
      menus: {
        header: Array<{ href: string; children: Array<{ href: string }> }>;
        footerGroups: Array<{ links: Array<{ href: string }> }>;
      };
    };
    const hrefs = [
      ...raw.menus.header.flatMap((l) => [
        l.href,
        ...l.children.map((c) => c.href),
      ]),
      ...raw.menus.footerGroups.flatMap((g) => g.links.map((l) => l.href)),
    ];
    expect(hrefs).toContain("/collections/ground-spices");
    expect(hrefs).toContain("/refund-policy");
    expect(hrefs).not.toContain("/collections/fruits");
    expect(raw.menus.header.length).toBeLessThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// A refinement, planned, compiled and fitted (money-1).
// ---------------------------------------------------------------------------

describe("a refinement through the fake planner (money-1)", () => {
  it("is charged for the one photo it redraws, never for the site it carries over", () => {
    const input = spiceShop();
    const parent = compileRevampSite(fakeRevampSiteOutput(input), input).plan!;
    const opening = revampOpeningBinding(parent)!.shotId;
    const refine: RevampRequest = {
      ...input.request,
      kind: "refine",
      instruction: "Redo the opening photo.",
      refineScope: {
        design: false,
        copy: false,
        layout: false,
        photos: [opening],
        pages: null,
        products: false,
      },
    };
    const childInput = {
      request: refine,
      snapshot: input.snapshot,
      previous: parent,
    };
    const result = compileRevampSite(
      fakeRevampSiteOutput(childInput),
      childInput,
    );
    expect(result.issues).toEqual([]);
    const child = result.plan!;
    const P = REVAMP_PRICES;
    expect(
      estimateRevampCredits(parent, {
        request: input.request,
        productPhotoKeys: [],
      }).total,
    ).toBeGreaterThan(P.photo);
    expect(
      estimateRevampCredits(child, { request: refine, productPhotoKeys: [] }),
    ).toEqual({
      pages: 0,
      photos: P.photo,
      design: 0,
      chrome: 0,
      categories: 0,
      productPhotos: 0,
      total: P.photo,
    });
    // A balance of one photograph keeps the whole site it carries over.
    const fitted = fitRevampPlanToBudget(child, {
      request: refine,
      budget: P.photo,
    }).plan;
    expect(fitted.pages.map((p) => p.slug)).toEqual(
      child.pages.map((p) => p.slug),
    );
    expect(fitted.shots.map((s) => s.id)).toEqual(child.shots.map((s) => s.id));
    expect(fitted.design).toEqual(child.design);
    expect(fitted.skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// L2-G: the card's notes are the code's own, never the model's.
// ---------------------------------------------------------------------------

describe("the card's notes (L2-G)", () => {
  it("★★ a planner answering every field it is asked for puts no note of its own on the card", () => {
    const input = spiceShop();
    // The second live run's kind of note: wrong (two of the three products
    // got studio photos, not the merchant's own), and checked by nothing.
    const wrong =
      "Product images are set to your owned photographs for the garam masala and turmeric powder.";
    const asked = Object.keys(
      (REVAMP_SITE_SCHEMA as { properties: Record<string, unknown> })
        .properties,
    );
    // ★ A model answers every field the schema asks for.
    const answer = {
      ...(fakeRevampSiteOutput(input) as Record<string, unknown>),
      ...(asked.includes("notes") ? { notes: [wrong] } : {}),
    };
    const plan = compileRevampSite(answer, input).plan!;
    expect(plan).not.toBeNull();
    const stored = assembleRevampPlan({
      revampId: "11111111-1111-4111-8111-111111111111",
      request: input.request,
      snapshot: input.snapshot,
      plan,
      images: [],
      outcomes: [],
      productFailures: [],
      free: true,
      canChangeBrand: false,
    });
    expect(stored.notes).not.toContain(wrong);
    // The notes the code writes still reach the card.
    expect(stored.notes).toContain(REVAMP_BRAND_PERMISSION_NOTE);
  });
});

// ---------------------------------------------------------------------------
// L2-A: a list whose items were all dropped is named in the repair sentence.
// ---------------------------------------------------------------------------

describe("the repair sentence for a list left empty (L2-A)", () => {
  type RawSection = { keep: string; type: string; configJson: string };
  type RawAnswer = { pages: Array<{ slug: string; sections: RawSection[] }> };
  /** The issue the compiler raises for one new section on the story page. */
  const issueFor = (type: string, config: Record<string, unknown>) => {
    const input = spiceShop();
    const raw = structuredClone(fakeRevampSiteOutput(input)) as RawAnswer;
    const story = raw.pages.find((p) => p.slug === "our-story")!;
    story.sections.push({
      keep: "",
      type,
      configJson: JSON.stringify(config),
    });
    const at = story.sections.length;
    const { issues } = compileRevampSite(raw, input);
    return issues.find((i) => i.includes(`section ${at} (${type}):`)) ?? "";
  };

  it("★★ names the list and its item fields for the second live run's accordion", () => {
    // kesar-ghani: rows written as {title, content}, every one dropped.
    const sentence = issueFor("accordion", {
      heading: "Available Packaging Sizes",
      subheading: "",
      items: [
        { title: "500 ml Bottle", content: "Cold pressed in the mill." },
        { title: "1 L Bottle", content: "For home kitchens." },
      ],
      open_first: true,
      allow_multiple: false,
    });
    expect(sentence).toMatch(/Add at least one row\./);
    expect(sentence).toContain(
      "Its list is config.items: 1 to 20 items, each with the fields type, heading, body, image_url, image_alt",
    );
    expect(sentence).toContain("revamp-slot://<shot id>");
  });

  const lists = REVAMP_SECTION_TYPES.filter(
    (type) => (SECTION_BLOCKS[type]?.min ?? 0) > 0,
  );

  it.each(lists)(
    "★ %s: names the list key and every field of the printed item",
    (type) => {
      const spec = SECTION_BLOCKS[type]!;
      const example = revampPromptExample(type);
      const item = (example[spec.key] as unknown[])[0];
      const sentence = issueFor(type, {
        ...example,
        [spec.key]: [{ name: "Something", text: "Words" }],
      });
      expect(sentence, type).toContain(`Its list is config.${spec.key}:`);
      if (item && typeof item === "object") {
        const fields = Object.keys(item as Record<string, unknown>);
        expect(sentence, type).toContain(
          `each with the fields ${fields.join(", ")}`,
        );
        if (fields.includes("image_url")) {
          expect(sentence, type).toContain("revamp-slot://<shot id>");
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Distinct by default (prompt v5): the fake plan's choices are picked for
// the store, the way a real plan's are, and still compile clean.
// ---------------------------------------------------------------------------

type RawAnswer = {
  promptVersion?: string;
  direction: string;
  design: {
    palette: Record<string, string>;
    fontPairing: string;
    radii: Record<string, number>;
  };
  appearance: Record<string, string>;
  pages: Array<{
    slug: string;
    sections: Array<{ keep: string; type: string; configJson: string }>;
  }>;
};

/** The fixture planned for one store (and, when given, one redesign). */
function plannedFor(
  make: () => Fixture,
  storeId: string,
  revampId?: string,
): { input: Fixture & { revampId?: string }; raw: RawAnswer } {
  const input = make() as Fixture & { revampId?: string };
  input.snapshot.storeId = storeId;
  if (revampId) input.revampId = revampId;
  return { input, raw: fakeRevampSiteOutput(input) as RawAnswer };
}

/** The homepage's new section types after its opening, in order. */
const homeOrder = (raw: RawAnswer) =>
  raw.pages
    .find((p) => p.slug === "home")!
    .sections.filter((s) => !s.keep)
    .map((s) => s.type)
    .slice(1);

describe("fakeRevampSiteOutput: distinct by default (prompt v5)", () => {
  it.each(FIXTURES)(
    "★★ compiles with zero issues for every store it is planned for: %s",
    (_name, make) => {
      for (const storeId of STORE_IDS) {
        for (const revampId of [undefined, "r-1", "r-2"]) {
          const { input, raw } = plannedFor(make, storeId, revampId);
          const result = compileRevampSite(raw, input);
          expect(result.issues, `${storeId} ${revampId}`).toEqual([]);
          expect(result.plan).not.toBeNull();
        }
      }
    },
  );

  it("writes its shoot's light in plain English, with no claim, number or long dash", () => {
    // The offline planner's own answer, as a model would write one: the
    // compiler's default art direction names no light (step 9 waits for the
    // owner).
    for (const light of FAKE_PLAN_LIGHTS) {
      expect(unsupportedClaimsIn(light, ""), light).toEqual([]);
      expect(readsAsLanguage(light, "English"), light).toBe(true);
      expect(light, light).not.toMatch(/\d|[\u2013\u2014]/);
    }
    expect(new Set(FAKE_PLAN_LIGHTS).size).toBe(FAKE_PLAN_LIGHTS.length);
  });

  it("names the prompt version it follows, so it compiles under v5's rules", () => {
    const { raw } = plannedFor(spiceShop, STORE_IDS[0]);
    expect(raw.promptVersion).toBe(REVAMP_SITE_PROMPT_VERSION);
    expect(revampAnswerPromptVersion(raw)).toBe(5);
  });

  it("★★ varies by store: direction, page, fonts, corners, header and structure", () => {
    const seen = {
      direction: new Set<string>(),
      page: new Set<string>(),
      fonts: new Set<string>(),
      corners: new Set<string>(),
      header: new Set<string>(),
      structure: new Set<string>(),
      whole: new Set<string>(),
    };
    for (const storeId of STORE_IDS) {
      const { raw } = plannedFor(linenShop, storeId);
      seen.direction.add(raw.direction);
      seen.page.add(raw.design.palette.cream);
      seen.fonts.add(raw.design.fontPairing);
      seen.corners.add(JSON.stringify(raw.design.radii));
      seen.header.add(raw.appearance.header);
      seen.structure.add(homeOrder(raw).join(">"));
      seen.whole.add(JSON.stringify(raw.design) + homeOrder(raw).join(">"));
    }
    // Every direction made for the shop's industry (a home shop: two).
    expect(seen.direction).toEqual(
      new Set(
        DESIGN_DIRECTION_IDS.filter((id) =>
          (DESIGN_DIRECTIONS[id].industries as readonly string[]).includes(
            revampIndustryGuess(linenShop().request),
          ),
        ),
      ),
    );
    expect(seen.page.size).toBeGreaterThanOrEqual(4);
    expect(seen.fonts.size).toBeGreaterThanOrEqual(3);
    expect(seen.corners.size).toBeGreaterThanOrEqual(3);
    expect(seen.header.size).toBeGreaterThanOrEqual(3);
    expect(seen.structure.size).toBe(3);
    // No two of the 24 stores get the same design and homepage.
    expect(seen.whole.size).toBeGreaterThanOrEqual(20);
  });

  it("varies a store's redo by its redesign id, and repeats nothing for the same one", () => {
    const first = plannedFor(spiceShop, STORE_IDS[0], "r-1").raw;
    const again = plannedFor(spiceShop, STORE_IDS[0], "r-1").raw;
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    const redos = new Set(
      ["r-2", "r-3", "r-4", "r-5", "r-6"].map((id) =>
        JSON.stringify(plannedFor(spiceShop, STORE_IDS[0], id).raw),
      ),
    );
    expect(redos.has(JSON.stringify(first))).toBe(false);
    expect(redos.size).toBe(5);
  });

  it("★★ paints the page its direction asks for (palette honesty), on either polarity", () => {
    for (const make of [spiceShop, linenShop, teaHouse]) {
      for (const storeId of STORE_IDS) {
        const { raw } = plannedFor(make, storeId);
        expect(
          revampPageFitsDirection(raw.direction, raw.design.palette.cream),
          `${storeId} ${raw.direction} ${raw.design.palette.cream}`,
        ).toBe(true);
      }
    }
  });

  it("follows one of the playbook's three structures after the opening", () => {
    const structures = new Set<string>();
    for (const storeId of STORE_IDS) {
      const { raw } = plannedFor(spiceShop, storeId);
      const order = homeOrder(raw);
      structures.add(order.slice(0, 5).join(">"));
      expect(order.slice(-2)).toEqual(["faq_accordion", "newsletter"]);
    }
    expect(structures).toEqual(
      new Set([
        "usp_bar>featured_products>shop_by_category>media_text>gallery",
        "shop_by_category>featured_products>gallery>usp_bar>media_text",
        "media_text>gallery>featured_products>usp_bar>shop_by_category",
      ]),
    );
  });

  it("writes the words colour a strip needs on its page, and bands in an order picked per store", () => {
    const strip = (raw: RawAnswer) =>
      JSON.parse(
        raw.pages
          .find((p) => p.slug === "home")!
          .sections.find((s) => s.type === "usp_bar")!.configJson,
      ).theme;
    expect(strip(plannedFor(spiceShop, STORE_IDS[0]).raw)).toBe("dark");
    expect(strip(plannedFor(teaHouse, STORE_IDS[0]).raw)).toBe("light");
    const bands = new Set(
      STORE_IDS.map((storeId) =>
        JSON.stringify(
          (
            plannedFor(spiceShop, storeId).raw.pages.find(
              (p) => p.slug === "home",
            )!.sections as Array<{ style?: { scheme: string | null } }>
          )
            .map((s) => s.style?.scheme)
            .filter(Boolean),
        ),
      ),
    );
    expect(bands.size).toBeGreaterThan(2);
  });

  it("writes every section choice as a value the compiler keeps, never a copied 'choose one'", () => {
    for (const storeId of STORE_IDS.slice(0, 6)) {
      const { raw } = plannedFor(spiceShop, storeId);
      for (const page of raw.pages) {
        for (const section of page.sections) {
          if (section.keep) continue;
          expect(section.configJson).not.toMatch(/choose one|write in/i);
        }
      }
    }
  });
});
