/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  REVAMP_LIMITS,
  REVAMP_SLOT_PREFIX,
  revampShotGoods,
  type RevampRefineScope,
  type RevampRequest,
  type RevampSitePlan,
  type RevampSnapshot,
} from "./contract";
import {
  contrastIssuesFor,
  contrastRatio,
  DESIGN_MIN_CONTRAST,
} from "@/lib/chrome/design";
import { mixHex, SCHEME_MIX } from "@/lib/themes/schemes";
import { EMPTY_CONFIG, validateConfig } from "@/lib/sections/registry";
import {
  DESIGN_DIRECTION_IDS,
  DESIGN_DIRECTIONS,
} from "@/lib/theme-studio/design-directions";
import { colourBand } from "@/lib/theme-studio/fingerprint";
import { VISIBLE_SECTION_CHOICES } from "@/lib/theme-studio/style-choices";
import { readsAsLanguage, unsupportedClaimsIn } from "./copy-checks";
import {
  checkRevampLink,
  clipText,
  compileRevampSite,
  fallbackSeoDescription,
  finalizeRevampSite,
  fitRevampPageToDirection,
  isHomeLabel,
  isLightColour,
  normalizeRevampHex,
  normalizeRevampPageSlug,
  REVAMP_COMPILER_SET_FIELDS,
  REVAMP_NEUTRAL_COPY,
  REVAMP_SECTION_CHOICES,
  REVAMP_SECTION_TYPES,
  REVAMP_STOREFRONT_ROUTES,
  revampDesignSeed,
  revampImageMood,
  revampNeutralLine,
  revampExampleInstructionPrefix,
  revampMerchantNamesPage,
  revampPageFitsDirection,
  revampSeededOrder,
  revampSeededPick,
  revampTextThemeFor,
  revampAlwaysServedLink,
  revampCategoryBandAllowed,
  revampCategoryPhotoNeeds,
  revampCategoryShotId,
  revampExistingProductKeys,
  revampFrameKeyFor,
  revampGoodsCatalogue,
  revampGoodsKeyForSlug,
  revampHasRealProducts,
  revampLinkTargets,
  revampNewProductSlugs,
  revampOwnedPhotoUrls,
  revampPageScope,
  revampProductSlug,
  revampRatioFor,
  repairRevampPalette,
  revampRefillShotId,
  revampRefillSlots,
  sanitizeShotId,
} from "./site-compiler";
import { RevampStepError } from "./step-error";

// ---------------------------------------------------------------------------
// Fixtures: a store on a theme, with theme, Mink and merchant sections.
// ---------------------------------------------------------------------------

type Raw = Record<string, any>;

const BUCKET = "https://storage.googleapis.com/sm-media/stores/store-1";
const THEME_PHOTO = "/themes/basket/hero.webp";
const OLD_MINK = `${BUCKET}/mink-generated/old.jpg`;
const PRODUCT_PHOTO = `${BUCKET}/uploads/groundnut.webp`;
const MUSTARD_PHOTO = `${BUCKET}/uploads/mustard.webp`;

const slot = (id: string) => `${REVAMP_SLOT_PREFIX}${id}`;
const cfg = (value: Raw) => JSON.stringify(value);
const REFILL_STORY = revampRefillShotId("", "m-story", ["image_url"]);
const REFILL_BANNER = revampRefillShotId("", "m-banner", ["image_url"]);

const WIDE = { width: 2520, height: 1080, aspect: 2520 / 1080 };
const PORTRAIT = { width: 1200, height: 1500, aspect: 0.8 };
const LANDSCAPE = { width: 1600, height: 1200, aspect: 4 / 3 };
const SQUARE = { width: 1200, height: 1200, aspect: 1 };

const PALETTE = {
  cream: "#fbf8f1",
  creamDeep: "#efe6d6",
  surface: "#ffffff",
  ink: "#1f1d1a",
  inkSoft: "#4a463f",
  inkFaint: "#8a8478",
  border: "#e2d9c8",
  accent: "#2f6b3a",
};
const ART = "Warm morning light, earthy browns, a 35mm lens.";

function sec(id: string, type: string, config: Raw): PageSectionItem {
  return { id, type, enabled: true, config } as unknown as PageSectionItem;
}

const STORY = sec("m-story", "media_text", {
  eyebrow: "",
  heading: "Our mill in Ludhiana",
  body: "We started pressing oil here.",
  cta_label: "",
  cta_href: "",
  image_url: THEME_PHOTO,
  image_alt: "The mill",
  media_position: "left",
  media_ratio: "portrait",
  alignment: "left",
});
const CODE = sec("m-code", "custom_code", {
  html: "<p>Hello</p>",
  css: "",
  js: "",
});
const BANNER = sec("m-banner", "hero", {
  variant: "minimal",
  heading: "Visit the mill",
  subheading: "",
  cta_label: "",
  cta_href: "",
  image_url: OLD_MINK,
  mobile_image_url: THEME_PHOTO,
  theme: "light",
  alignment: "left",
});

function page(
  id: string,
  slug: string,
  title: string,
  sections: PageSectionItem[],
  owners: Raw,
  skipped: "policy" | "invalid" | null = null,
): RevampSnapshot["pages"][number] {
  return {
    id,
    slug,
    title,
    status: "published",
    version: "v1",
    sectionsDigest: "d",
    sections,
    owners,
    skipped,
    seoTitle: null,
    seoDescription: null,
  };
}

function snapshot(): RevampSnapshot {
  return {
    storeId: "store-1",
    storeName: "Ghani Oils",
    storeSlug: "ghani",
    launched: false,
    theme: {
      id: "basket",
      version: "1.0.0",
      name: "Basket",
      palette: {
        page: "#fbf8f1",
        surface: "#ffffff",
        ink: "#1f1d1a",
        accent: "#2f6b3a",
      },
      layout: {},
    },
    pages: [
      page(
        "page-home",
        "",
        "Home",
        [
          sec("t-carousel", "hero_carousel", {
            slides: [
              {
                heading: "Fresh produce",
                image_url: THEME_PHOTO,
                theme: "light",
              },
            ],
          }),
          sec("k-faq", "faq_accordion", {
            heading: "Questions",
            items: [{ question: "Do you deliver?", answer: "Yes." }],
          }),
          STORY,
          CODE,
          BANNER,
        ],
        {
          "t-carousel": "theme",
          "k-faq": "mink",
          "m-story": "merchant",
          "m-code": "merchant",
          "m-banner": "merchant",
        },
      ),
      page(
        "page-about",
        "about",
        "About",
        [sec("t-about", "rich_text", { html: "<p>About the theme.</p>" })],
        { "t-about": "theme" },
      ),
      page("page-terms", "terms", "Terms", [], {}, "policy"),
    ],
    chrome: {
      rowExists: false,
      version: null,
      digest: "c",
      value: {} as RevampSnapshot["chrome"]["value"],
    },
    brand: { tagline: "Fresh produce, delivered", blurb: null, digest: "b" },
    categories: [
      {
        id: "c1",
        slug: "fruits",
        name: "Fruits",
        description: null,
        imageUrl: "/themes/basket/fruits.webp",
        status: "active",
        updatedAt: "t",
        sample: true,
        productCount: 3,
      },
      {
        id: "c2",
        slug: "oils",
        name: "Oils",
        description: null,
        imageUrl: null,
        status: "active",
        updatedAt: "t",
        sample: false,
        productCount: 1,
      },
      {
        id: "c3",
        slug: "ghee",
        name: "Ghee",
        description: null,
        imageUrl: null,
        status: "active",
        updatedAt: "t",
        sample: false,
        productCount: 0,
      },
    ],
    products: [
      {
        id: "x1",
        name: "Banana (Sample)",
        slug: "banana",
        status: "published",
        updatedAt: "t",
        sample: true,
        imageUrl: "/themes/basket/banana.webp",
        categoryId: "c1",
      },
      {
        id: "x2",
        name: "Groundnut Oil",
        slug: "groundnut-oil",
        status: "published",
        updatedAt: "t",
        sample: false,
        imageUrl: PRODUCT_PHOTO,
        categoryId: "c2",
      },
    ],
    facts: {
      delivery: "Delivered across Punjab in 2 to 4 days",
      freeDeliveryAbove: 999,
      returns: null,
      pickup: false,
      onlinePayments: true,
      cashOnDelivery: true,
      city: "Ludhiana",
      state: "Punjab",
    },
    photos: { replaceable: [THEME_PHOTO, OLD_MINK], broken: [] },
    entitlements: { customCode: true },
  };
}

function request(): RevampRequest {
  return {
    kind: "full",
    brief: {
      business:
        "Ghani Oils sells cold-pressed groundnut and mustard oil from our mill in Ludhiana.",
      look: "warm and earthy",
      audience: "home cooks",
      facts: ["Every oil is cold-pressed in a wooden ghani."],
      avoid: "",
      language: "English",
    },
    products: [
      {
        key: "p1",
        name: "Mustard Oil",
        description: "Cold-pressed mustard oil.",
        sizes: [
          { label: "1 L", price: 349, mrp: 399 },
          { label: "5 L", price: 1599, mrp: null },
        ],
        photoUrl: MUSTARD_PHOTO,
        categorySlug: "oils",
      },
      {
        key: "p2",
        name: "Desi Ghee",
        description: "Ghee made from cow milk.",
        sizes: [{ label: "500 ml", price: 699, mrp: null }],
        photoUrl: null,
        categorySlug: "ghee",
      },
    ],
    categories: [
      { action: "hide", slug: "fruits" },
      {
        action: "create",
        name: "Cold Pressed",
        slug: null,
        description: "Oils pressed slowly in a wooden ghani.",
        newPhoto: true,
      },
      {
        action: "update",
        slug: "oils",
        name: null,
        description: null,
        newPhoto: true,
      },
    ],
    pages: null,
    instruction: null,
    refineScope: null,
  };
}

function carousel(shots: string[]): Raw {
  return {
    type: "hero_carousel",
    configJson: cfg({
      slides: shots.map((id, i) => ({
        heading: i === 0 ? "Pressed in Ludhiana" : "Oil from our mill",
        subheading: "Groundnut and mustard oil from a wooden ghani.",
        cta_label: "Shop oils",
        cta_href: "/shop",
        image_url: slot(id),
        theme: "light",
      })),
      interval_seconds: 6,
      height: "large",
    }),
    style: { width: "full" },
  };
}

function media(image: string, extra: Raw = {}, style?: Raw): Raw {
  return {
    type: "media_text",
    configJson: cfg({
      eyebrow: "Our mill",
      heading: "How we press",
      body: "Seeds go into a wooden ghani and turn slowly.",
      cta_label: "",
      cta_href: "",
      image_url: image,
      image_alt: "Seeds in a wooden ghani",
      media_position: "left",
      media_ratio: "portrait",
      alignment: "left",
      ...extra,
    }),
    ...(style ? { style } : {}),
  };
}

const rich = (html: string): Raw => ({
  type: "rich_text",
  configJson: cfg({ html, width: "contained" }),
});

function gallery(shots: string[]): Raw {
  return {
    type: "gallery",
    configJson: cfg({
      heading: "At the mill",
      subheading: "",
      items: shots.map((id) => ({
        image_url: slot(id),
        image_alt: "Oil at the mill",
        caption: "",
        href: "",
      })),
      layout: "grid",
      columns: 3,
      image_ratio: "square",
    }),
  };
}

function newsletter(
  consent = "I agree to receive emails from Ghani Oils.",
): Raw {
  return {
    type: "newsletter",
    configJson: cfg({
      heading: "Stay in touch",
      subheading: "News from our mill.",
      button_label: "Subscribe",
      consent_text: consent,
      theme: "dark",
      alignment: "center",
    }),
    style: { scheme: "inverse" },
  };
}

const shot = (id: string, extra: Raw = {}): Raw => ({
  id,
  purpose: "content",
  subject: `Subject of ${id}`,
  artDirection: "",
  aspectRatio: "1:1",
  people: "none",
  category: null,
  ...extra,
});

/** A complete, clean answer: compiles with no issue. */
function goodRaw(): Raw {
  return {
    summary: "A warm, earthy storefront for Ghani Oils.",
    industry: "food-and-drink",
    direction: "soft-and-natural",
    design: {
      palette: { ...PALETTE },
      fontPairing: "editorial-fraunces",
      radii: { card: 12, control: 8, sm: 4, pill: 999 },
    },
    appearance: {
      header: "classic",
      card: "classic",
      productDetail: "classic",
      footer: "rich",
    },
    announcement: { text: "We deliver across Punjab.", href: "/shop" },
    brand: {
      tagline: "Cold-pressed oils from Ludhiana",
      blurb: "Ghani Oils presses groundnut and mustard oil in a wooden ghani.",
    },
    newsletter: {
      heading: "Stay in touch",
      subtext: "News from our mill by email.",
      buttonLabel: "Subscribe",
    },
    pages: [
      {
        slug: "home",
        title: "Ghani Oils",
        seoTitle: "Ghani Oils",
        seoDescription:
          "Cold-pressed oils from our mill in Ludhiana, delivered across Punjab.",
        sections: [
          carousel(["hero-mill", "hero-bottles"]),
          { keep: "m-story" },
          {
            type: "featured_products",
            configJson: cfg({
              heading: "Our oils",
              subheading: "",
              source: "manual",
              product_ids: ["x2"],
              category_id: null,
              limit: 8,
            }),
            style: { scheme: "soft", padding: "md" },
          },
          { keep: "m-code" },
          {
            type: "shop_by_category",
            configJson: cfg({
              heading: "Shop by category",
              subheading: "",
              source: "all",
              category_ids: [],
              layout: "grid",
              display: "cards",
            }),
            style: { scheme: "tint" },
          },
          media(slot("mill-floor")),
          { keep: "m-banner" },
          newsletter(),
        ],
      },
      {
        slug: "about",
        title: "About us",
        seoTitle: "About Ghani Oils",
        seoDescription:
          "How Ghani Oils presses groundnut and mustard oil in Ludhiana.",
        sections: [
          rich(
            '<h2>Our mill</h2><p>We press oil in Ludhiana. <a href="/shop">Shop</a></p>',
          ),
          gallery(["about-press", "about-jars"]),
        ],
      },
    ],
    menus: {
      header: [
        { label: "Shop", href: "/shop", children: [] },
        { label: "Oils", href: "/collections/oils", children: [] },
        { label: "About", href: "/about", children: [] },
      ],
      footerGroups: [
        { title: "Shop", links: [{ label: "All products", href: "/shop" }] },
      ],
    },
    shots: [
      shot("hero-mill", {
        purpose: "hero",
        subject: "The mill floor at dawn",
        artDirection: ART,
        aspectRatio: "21:9",
      }),
      shot("hero-bottles", { purpose: "hero", aspectRatio: "21:9" }),
      shot("mill-floor", { aspectRatio: "4:5", people: "adults" }),
      shot(REFILL_STORY, { aspectRatio: "4:5" }),
      shot(REFILL_BANNER, { aspectRatio: "21:9" }),
      shot("about-press"),
      shot("about-jars"),
      shot("cat-oils", { purpose: "category", category: "oils" }),
      shot("category-cold-pressed", {
        purpose: "category",
        category: "cold-pressed",
      }),
    ],
    productCopy: [
      {
        key: "p1",
        description: "Mustard oil pressed slowly in a wooden ghani.",
      },
    ],
    notes: ["The look follows your warm and earthy brief."],
  };
}

interface Over {
  request?: Partial<RevampRequest>;
  snapshot?: Partial<RevampSnapshot>;
  previous?: RevampSitePlan | null;
}

function input(over: Over = {}) {
  return {
    request: { ...request(), ...over.request },
    snapshot: { ...snapshot(), ...over.snapshot },
    previous: over.previous ?? null,
  };
}

function ids(): () => string {
  let n = 0;
  return () => `s${++n}`;
}

const strict = (raw: unknown, over: Over = {}) =>
  compileRevampSite(raw, input(over), { newId: ids() });
const lenient = (raw: unknown, over: Over = {}) =>
  finalizeRevampSite(raw, input(over), { newId: ids() });

/** The strict pass refuses and says `pattern`; the lenient plan comes back. */
function expectRule(raw: Raw, pattern: RegExp, over: Over = {}) {
  const result = strict(raw, over);
  expect(result.plan).toBeNull();
  expect(result.issues.join("\n")).toMatch(pattern);
  return lenient(raw, over);
}

const homeOf = (raw: Raw): Raw[] => raw.pages[0].sections;
const conf = (section: PageSectionItem): Raw =>
  section.config as unknown as Raw;
const section = (plan: RevampSitePlan, id: string): PageSectionItem =>
  plan.pages.flatMap((p) => p.sections).find((s) => s.id === id)!;
const scopeOf = (over: Partial<RevampRefineScope>): RevampRefineScope => ({
  design: true,
  copy: true,
  layout: true,
  photos: null,
  pages: null,
  products: true,
  ...over,
});

function editConfig(raw: Raw, change: (config: Raw) => void): Raw {
  const config = JSON.parse(raw.configJson);
  change(config);
  raw.configJson = JSON.stringify(config);
  return raw;
}

function imageLeaves(node: unknown, out: string[] = [], key = ""): string[] {
  if (typeof node === "string") {
    if (key.endsWith("_url") && key !== "video_url") out.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node) imageLeaves(item, out, key);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) imageLeaves(v, out, k);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The whole plan.
// ---------------------------------------------------------------------------

describe("compileRevampSite: a clean answer", () => {
  const result = strict(goodRaw());
  const plan = result.plan!;

  it("compiles with no issue, deterministically", () => {
    expect(result.issues).toEqual([]);
    expect(plan).not.toBeNull();
    expect(strict(goodRaw())).toEqual(result);
  });

  it("writes the homepage and the About page, by slug, with their page ids", () => {
    expect(
      plan.pages.map((p) => [p.slug, p.pageId, p.create, p.title]),
    ).toEqual([
      ["", "page-home", false, "Ghani Oils"],
      ["about", "page-about", false, "About us"],
    ]);
    expect(plan.pages[0].sections.map((s) => [s.id, s.type])).toEqual([
      ["s1", "hero_carousel"],
      ["m-story", "media_text"],
      ["s2", "featured_products"],
      ["m-code", "custom_code"],
      ["s3", "shop_by_category"],
      ["s4", "media_text"],
      ["m-banner", "hero"],
      ["s5", "newsletter"],
    ]);
    expect(plan.pages[1].sections.map((s) => [s.id, s.type])).toEqual([
      ["s6", "rich_text"],
      ["s7", "gallery"],
    ]);
    expect(conf(plan.pages[1].sections[0]).html).toBe(
      '<h2>Our mill</h2><p>We press oil in Ludhiana. <a href="/shop">Shop</a></p>',
    );
  });

  it("keeps the merchant's sections word for word, only their theme photos refilled", () => {
    expect(conf(section(plan, "m-story"))).toEqual({
      ...(STORY.config as unknown as Raw),
      image_url: slot(REFILL_STORY),
    });
    expect(section(plan, "m-code")).toEqual(CODE);
    expect(conf(section(plan, "m-banner"))).toEqual({
      ...(BANNER.config as unknown as Raw),
      image_url: slot(REFILL_BANNER),
      mobile_image_url: "",
    });
  });

  it("holds every image field to empty, an owned photo or a shot", () => {
    const owned = revampOwnedPhotoUrls(input());
    for (const value of imageLeaves(plan.pages)) {
      expect(
        value === "" ||
          value.startsWith(REVAMP_SLOT_PREFIX) ||
          owned.has(value),
      ).toBe(true);
    }
  });

  it("sets what only one answer is right for, and the band styles", () => {
    expect(conf(section(plan, "s2"))).toMatchObject({
      source: "featured",
      product_ids: [],
    });
    expect(plan.pages[0].sections.map((s) => s.style ?? null)).toEqual([
      { width: "full" },
      null,
      { scheme: "soft", padding_y: "md" },
      null,
      { scheme: "tint", padding_y: "md" },
      null,
      null,
      { scheme: "inverse", padding_y: "md" },
    ]);
  });

  it("binds every photo with its frame, phone crops on wide photos, and the category photos", () => {
    expect(plan.bindings).toEqual([
      {
        shotId: "hero-mill",
        pageSlug: "",
        sectionId: "s1",
        path: ["slides", 0, "image_url"],
        frame: WIDE,
        phonePath: ["slides", 0, "mobile_image_url"],
      },
      {
        shotId: "hero-bottles",
        pageSlug: "",
        sectionId: "s1",
        path: ["slides", 1, "image_url"],
        frame: WIDE,
        phonePath: ["slides", 1, "mobile_image_url"],
      },
      {
        shotId: REFILL_STORY,
        pageSlug: "",
        sectionId: "m-story",
        path: ["image_url"],
        frame: PORTRAIT,
        phonePath: null,
      },
      {
        shotId: "mill-floor",
        pageSlug: "",
        sectionId: "s4",
        path: ["image_url"],
        frame: PORTRAIT,
        phonePath: null,
      },
      {
        shotId: REFILL_BANNER,
        pageSlug: "",
        sectionId: "m-banner",
        path: ["image_url"],
        frame: WIDE,
        phonePath: ["mobile_image_url"],
      },
      {
        shotId: "about-press",
        pageSlug: "about",
        sectionId: "s7",
        path: ["items", 0, "image_url"],
        frame: SQUARE,
        phonePath: null,
      },
      {
        shotId: "about-jars",
        pageSlug: "about",
        sectionId: "s7",
        path: ["items", 1, "image_url"],
        frame: SQUARE,
        phonePath: null,
      },
      {
        shotId: "category-cold-pressed",
        pageSlug: "@category",
        sectionId: "cold-pressed",
        path: ["image_url"],
        frame: SQUARE,
        phonePath: null,
      },
      {
        shotId: "cat-oils",
        pageSlug: "@category",
        sectionId: "oils",
        path: ["image_url"],
        frame: SQUARE,
        phonePath: null,
      },
    ]);
    expect(
      plan.shots.map((s) => [s.id, s.purpose, s.aspectRatio, s.people]),
    ).toEqual([
      ["hero-mill", "hero", "21:9", "none"],
      ["hero-bottles", "hero", "21:9", "none"],
      [REFILL_STORY, "content", "4:5", "none"],
      // ★★ It shows no products (B16), so nobody wears or uses one.
      ["mill-floor", "content", "4:5", "none"],
      [REFILL_BANNER, "content", "21:9", "none"],
      ["about-press", "content", "1:1", "none"],
      ["about-jars", "content", "1:1", "none"],
      ["category-cold-pressed", "category", "1:1", "none"],
      ["cat-oils", "category", "1:1", "none"],
    ]);
    expect(new Set(plan.shots.map((s) => s.artDirection))).toEqual(
      new Set([ART]),
    );
  });

  it("compiles the design, the chrome, the product copy and the notes", () => {
    expect(plan.design).toEqual({
      palette: PALETTE,
      fonts: { body: "inter", display: "fraunces" },
      shape: { card: 12, control: 8, sm: 4, pill: 999 },
    });
    expect(plan.appearance).toEqual(goodRaw().appearance);
    expect(plan.direction).toBe("soft-and-natural");
    expect(plan.industry).toBe("food-and-drink");
    expect(plan.menus).toEqual({
      header: [
        { label: "Shop", href: "/shop" },
        { label: "Oils", href: "/collections/oils" },
        { label: "About", href: "/about" },
      ],
      footerGroups: [
        { title: "Shop", links: [{ label: "All products", href: "/shop" }] },
      ],
    });
    expect(plan.announcement).toEqual({
      text: "We deliver across Punjab.",
      href: "/shop",
    });
    expect(plan.productCopy).toEqual({
      p1: "Mustard oil pressed slowly in a wooden ghani.",
      p2: "Ghee made from cow milk.",
    });
    expect(plan.notes).toEqual([
      "The look follows your warm and earthy brief.",
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("finalize on an already-clean answer changes nothing", () => {
    expect(lenient(goodRaw())).toEqual(plan);
  });
});

// ---------------------------------------------------------------------------
// Sections.
// ---------------------------------------------------------------------------

describe("sections", () => {
  it("allows only the redesign's section types", () => {
    expect(REVAMP_SECTION_TYPES).not.toContain("custom_code");
    expect(REVAMP_SECTION_TYPES).not.toContain("testimonials");
    expect(REVAMP_SECTION_TYPES).toContain("hero");
    const raw = goodRaw();
    raw.pages[1].sections.push({ type: "testimonials", configJson: "{}" });
    const plan = expectRule(raw, /"testimonials" is not a section type/);
    expect(plan.pages[1].sections.map((s) => s.type)).toEqual([
      "rich_text",
      "gallery",
    ]);
    expect(plan.notes).toContain(
      "One section that could not be completed was left out.",
    );
  });

  it("needs configJson to be a JSON object", () => {
    const raw = goodRaw();
    raw.pages[1].sections.push({ type: "rich_text", configJson: "{oops" });
    const plan = expectRule(raw, /configJson must be a JSON object/);
    expect(plan.pages[1].sections).toHaveLength(2);
  });

  it("drops a section that fails publish validation", () => {
    const raw = goodRaw();
    raw.pages[1].sections.push({
      type: "faq_accordion",
      configJson: cfg({ heading: "Questions", items: [] }),
    });
    const plan = expectRule(raw, /faq_accordion\): Add at least one question/);
    expect(plan.pages[1].sections).toHaveLength(2);
  });

  it("shows products only when real products exist", () => {
    const snap = snapshot();
    const over: Over = {
      request: { products: [] },
      snapshot: { products: snap.products.filter((p) => p.sample) },
    };
    const plan = expectRule(goodRaw(), /no real products to show here/, over);
    expect(plan.pages[0].sections.map((s) => s.type)).not.toContain(
      "featured_products",
    );
    expect(plan.productCopy).toEqual({});
  });

  it("shows a category band only with real categories and no sample left", () => {
    const over: Over = {
      request: { categories: request().categories.slice(1) },
    };
    const plan = expectRule(
      goodRaw(),
      /a category band needs at least two real categories/,
      over,
    );
    expect(plan.pages[0].sections.map((s) => s.type)).not.toContain(
      "shop_by_category",
    );
  });

  it("checks links against what will exist and clears a button with nowhere to go", () => {
    const raw = goodRaw();
    editConfig(homeOf(raw)[0], (c) => {
      c.slides[0].cta_href = "https://example.com";
    });
    const plan = expectRule(
      raw,
      /is not a page, category or product that will exist after Apply/,
    );
    expect(conf(section(plan, "s1")).slides[0]).toMatchObject({
      cta_href: "",
      cta_label: "",
    });
    expect(plan.notes).toContain(
      "Links that pointed at pages or products that will not exist were removed.",
    );
  });

  it("rebuilds rich text from an allowlist and drops a link to nothing", () => {
    const raw = goodRaw();
    raw.pages[1].sections = [
      rich(
        '<p onclick="x()">We press oil. <a href="/shop/unknown">See it</a></p><script>alert(1)</script>',
      ),
    ];
    const plan = expectRule(
      raw,
      /links to "\/shop\/unknown", which will not exist/,
    );
    expect(conf(plan.pages[1].sections[0]).html).toBe(
      "<p>We press oil. See it</p>",
    );
  });
});

describe("the merchant's sections", () => {
  it("puts a forgotten merchant section back, before the closing newsletter", () => {
    const raw = goodRaw();
    homeOf(raw).splice(3, 1);
    const plan = expectRule(
      raw,
      /must keep the merchant's own section "m-code"/,
    );
    const order = plan.pages[0].sections.map((s) => s.id);
    expect(order.slice(-2)).toEqual(["m-code", "s5"]);
    expect(plan.notes).toContain("Your own sections were kept on every page.");
  });

  it("keeps only the merchant's own ids", () => {
    const raw = goodRaw();
    homeOf(raw)[3] = { keep: "t-carousel" };
    homeOf(raw).push({ keep: "nope" });
    const result = strict(raw);
    expect(result.issues.join("\n")).toMatch(
      /keeps "t-carousel", a section the theme or an earlier Mink run wrote/,
    );
    expect(result.issues.join("\n")).toMatch(
      /keeps "nope", which is not one of the merchant's own sections/,
    );
    const plan = lenient(raw);
    expect(plan.pages[0].sections.map((s) => s.id)).not.toContain("t-carousel");
    expect(plan.pages[0].sections.map((s) => s.id)).toContain("m-code");
  });

  it("gives every section on a page its own id", () => {
    const result = compileRevampSite(goodRaw(), input(), {
      newId: () => "m-code",
    });
    const order = result.plan!.pages[0].sections.map((s) => s.id);
    expect(new Set(order).size).toBe(order.length);
    expect(order.filter((id) => id === "m-code")).toEqual(["m-code"]);
    expect(order[3]).toBe("m-code");
  });
});

// ---------------------------------------------------------------------------
// Photos.
// ---------------------------------------------------------------------------

describe("photos", () => {
  it("never uses a theme photo in a new section: a new shot takes its place", () => {
    const raw = goodRaw();
    homeOf(raw)[5] = media(THEME_PHOTO);
    const plan = expectRule(raw, /is not a photo the store owns/);
    expect(conf(section(plan, "s4")).image_url).toBe(slot("home-media-text"));
    const made = plan.shots.find((s) => s.id === "home-media-text")!;
    expect(made.purpose).toBe("content");
    expect(made.subject).toContain("Seeds in a wooden ghani");
    // The model's shot is no longer bound anywhere: dropped.
    expect(plan.shots.map((s) => s.id)).not.toContain("mill-floor");
  });

  it("uses a photo the store owns as it is", () => {
    const raw = goodRaw();
    homeOf(raw)[5] = media(PRODUCT_PHOTO);
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    expect(conf(section(result.plan!, "s4")).image_url).toBe(PRODUCT_PHOTO);
    expect(result.plan!.bindings.map((b) => b.sectionId)).not.toContain("s4");
  });

  it("asks for a shot id as written and fixes it in the lenient pass", () => {
    const raw = goodRaw();
    homeOf(raw)[5] = media(`${REVAMP_SLOT_PREFIX}Mill Floor`);
    const plan = expectRule(
      raw,
      /names shot "Mill Floor"; write it as "mill-floor"/,
    );
    expect(conf(section(plan, "s4")).image_url).toBe(slot("mill-floor"));
    expect(plan.bindings.find((b) => b.sectionId === "s4")?.shotId).toBe(
      "mill-floor",
    );
  });

  it("refuses duplicate and unusable shot ids", () => {
    const raw = goodRaw();
    raw.shots.push(shot("hero-mill"), shot("!!!"));
    const issues = strict(raw).issues.join("\n");
    expect(issues).toMatch(/repeats the id "hero-mill"/);
    expect(issues).toMatch(/has no usable id/);
  });

  it("describes a shot nobody described from its slot", () => {
    const raw = goodRaw();
    raw.shots = raw.shots.filter((s: Raw) => s.id !== "mill-floor");
    const plan = expectRule(
      raw,
      /names revamp-slot:\/\/mill-floor, but no shot "mill-floor" is in shots/,
    );
    const made = plan.shots.find((s) => s.id === "mill-floor")!;
    expect(made.subject).toContain("Seeds in a wooden ghani");
    expect(made.artDirection).toBe(ART);
  });

  it("splits a shot used in two shapes, every use of the second shape sharing one id", () => {
    const raw = goodRaw();
    raw.pages[1].sections.push(
      media(slot("mill-floor"), { media_ratio: "landscape" }),
      media(slot("mill-floor"), { media_ratio: "landscape" }),
    );
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    const plan = result.plan!;
    const about = plan.bindings.filter((b) => b.pageSlug === "about");
    expect(about.map((b) => [b.shotId, b.frame])).toEqual([
      ["about-press", SQUARE],
      ["about-jars", SQUARE],
      ["mill-floor-2", LANDSCAPE],
      ["mill-floor-2", LANDSCAPE],
    ]);
    expect(conf(plan.pages[1].sections[2]).image_url).toBe(
      slot("mill-floor-2"),
    );
    const shapes = plan.shots
      .filter((s) => s.id.startsWith("mill-floor"))
      .map((s) => [s.id, s.aspectRatio]);
    expect(shapes).toEqual([
      ["mill-floor", "4:5"],
      ["mill-floor-2", "4:3"],
    ]);
  });

  it("photographs every confirmed category: the model's shot, its named id, or a new one", () => {
    const named = goodRaw();
    named.shots = named.shots.map((s: Raw) =>
      s.id === "category-cold-pressed" ? { ...s, category: null } : s,
    );
    expect(strict(named).issues).toEqual([]);

    const raw = goodRaw();
    raw.shots = raw.shots.filter((s: Raw) => s.purpose !== "category");
    const plan = expectRule(
      raw,
      /the category "Cold Pressed" \(cold-pressed\) gets a new photograph/,
    );
    const categories = plan.bindings.filter((b) => b.pageSlug === "@category");
    expect(categories.map((b) => [b.shotId, b.sectionId, b.frame])).toEqual([
      ["category-cold-pressed", "cold-pressed", SQUARE],
      ["category-oils", "oils", SQUARE],
    ]);
    expect(
      plan.shots
        .filter((s) => s.id.startsWith("category-"))
        .map((s) => [s.purpose, s.aspectRatio, s.people]),
    ).toEqual([
      ["category", "1:1", "none"],
      ["category", "1:1", "none"],
    ]);
  });

  it("keeps 40 sections, the photo limit and 10 pages at most", () => {
    const raw = goodRaw();
    homeOf(raw).splice(
      1,
      0,
      ...Array.from({ length: 45 }, (_, i) =>
        media(slot(`shot-${(i % 30) + 1}`)),
      ),
    );
    raw.shots.push(
      ...Array.from({ length: 30 }, (_, i) =>
        shot(`shot-${i + 1}`, { aspectRatio: "4:5" }),
      ),
    );
    for (let i = 0; i < 9; i++) {
      raw.pages.push({
        slug: `extra-${"abcdefghi"[i]}`,
        title: "Extra",
        seoTitle: "Extra",
        seoDescription: "A page about Ghani Oils and the mill in Ludhiana.",
        sections: [rich("<p>We press oil in Ludhiana.</p>")],
      });
    }
    const issues = strict(raw).issues.join("\n");
    expect(issues).toMatch(/a page holds at most 40/);
    expect(issues).toMatch(
      new RegExp(`a redesign draws at most ${REVAMP_LIMITS.maxShots}`),
    );
    expect(issues).toMatch(/"extra-i" is one page too many/);

    const plan = lenient(raw);
    expect(plan.pages).toHaveLength(REVAMP_LIMITS.maxPages);
    expect(plan.pages[0].sections.length).toBeLessThanOrEqual(40);
    expect(plan.pages[0].sections.map((s) => s.id)).toEqual(
      expect.arrayContaining(["m-story", "m-code", "m-banner"]),
    );
    expect(plan.shots.length).toBeLessThanOrEqual(REVAMP_LIMITS.maxShots);
    const live = new Set(plan.shots.map((s) => s.id));
    for (const binding of plan.bindings)
      expect(live.has(binding.shotId)).toBe(true);
    for (const value of imageLeaves(plan.pages)) {
      if (value.startsWith(REVAMP_SLOT_PREFIX)) {
        expect(live.has(value.slice(REVAMP_SLOT_PREFIX.length))).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Page rules.
// ---------------------------------------------------------------------------

describe("real goods or no goods (B16)", () => {
  const OTHER_STORE_PHOTO =
    "https://storage.googleapis.com/sm-media/stores/store-2/uploads/x.webp";
  const shotOf = (plan: RevampSitePlan, id: string) =>
    plan.shots.find((s) => s.id === id)!;
  const withShot = (raw: Raw, id: string, extra: Raw) => {
    raw.shots = raw.shots.map((s: Raw) =>
      s.id === id ? { ...s, ...extra } : s,
    );
    return raw;
  };

  it("lists the merchant's products with their own photo, by key", () => {
    const catalogue = revampGoodsCatalogue(input());
    expect([...catalogue.values()]).toEqual([
      {
        key: "p1",
        name: "Mustard Oil",
        photoUrl: MUSTARD_PHOTO,
        categorySlug: "oils",
      },
      {
        key: "shop:groundnut-oil",
        name: "Groundnut Oil",
        photoUrl: PRODUCT_PHOTO,
        categorySlug: "oils",
      },
    ]);
    // p2 has no photo, the banana is a theme sample: neither can be shown.
    expect(catalogue.has("p2")).toBe(false);
    expect(revampGoodsKeyForSlug("banana")).toBe("shop:banana");
    expect(catalogue.has("shop:banana")).toBe(false);
  });

  it("never lists a photo under another store's prefix or a theme file", () => {
    const req = request();
    req.products[0] = { ...req.products[0], photoUrl: OTHER_STORE_PHOTO };
    req.products[1] = { ...req.products[1], photoUrl: THEME_PHOTO };
    const catalogue = revampGoodsCatalogue(input({ request: req }));
    expect([...catalogue.keys()]).toEqual(["shop:groundnut-oil"]);
  });

  it("names a product the store already sells by its request key, once", () => {
    const req = request();
    req.products.push({
      key: "p3",
      name: "groundnut  OIL",
      description: "Groundnut oil.",
      sizes: [],
      photoUrl: null,
      categorySlug: null,
    });
    const catalogue = revampGoodsCatalogue(input({ request: req }));
    expect(catalogue.get("p3")).toEqual({
      key: "p3",
      name: "groundnut  OIL",
      photoUrl: PRODUCT_PHOTO,
      categorySlug: "oils",
    });
    expect(catalogue.has("shop:groundnut-oil")).toBe(false);
  });

  it("keeps the products a shot names, read leniently, at most two", () => {
    const raw = withShot(goodRaw(), "hero-mill", {
      goods: "merchant",
      productKeys: ["P1", "/shop/groundnut-oil", "p2", "x9"],
    });
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    expect(shotOf(result.plan!, "hero-mill")).toMatchObject({
      goods: "merchant",
      productKeys: ["p1", "shop:groundnut-oil"],
    });
    // A third photographed product named is one too many: the first two.
    const req = request();
    req.products[1] = {
      ...req.products[1],
      photoUrl: `${BUCKET}/uploads/ghee.webp`,
    };
    const three = withShot(goodRaw(), "hero-mill", {
      goods: "merchant",
      productKeys: ["p2", "p1", "shop:groundnut-oil"],
    });
    expect(
      shotOf(strict(three, { request: req }).plan!, "hero-mill").productKeys,
    ).toEqual(["p2", "p1"]);
    const byName = withShot(goodRaw(), "hero-mill", {
      goods: "merchant",
      productKeys: ["Mustard Oil", "groundnut-oil", "p1"],
    });
    expect(shotOf(strict(byName).plan!, "hero-mill").productKeys).toEqual([
      "p1",
      "shop:groundnut-oil",
    ]);
  });

  it("turns a shot of goods nobody photographed into a scene with no products, never invented goods", () => {
    const raw = withShot(goodRaw(), "mill-floor", {
      goods: "merchant",
      productKeys: ["p2"],
    });
    const plan = expectRule(
      raw,
      /shots "mill-floor" has goods "merchant" but no usable productKeys \("p2" is not a product with its own photo\)/,
    );
    expect(shotOf(plan, "mill-floor")).toMatchObject({
      goods: "none",
      productKeys: [],
    });
    const empty = withShot(goodRaw(), "mill-floor", {
      goods: "merchant",
      productKeys: [],
    });
    expect(strict(empty).issues.join("\n")).toMatch(
      /shots "mill-floor" has goods "merchant" but no usable productKeys\. Name one or two keys/,
    );
  });

  it("clears the keys of a scene and reads goods left out from the keys", () => {
    const raw = withShot(goodRaw(), "about-press", {
      goods: "none",
      productKeys: ["p1"],
    });
    withShot(raw, "about-jars", { goods: undefined, productKeys: ["p1"] });
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    expect(shotOf(result.plan!, "about-press")).toMatchObject({
      goods: "none",
      productKeys: [],
    });
    expect(shotOf(result.plan!, "about-jars")).toMatchObject({
      goods: "merchant",
      productKeys: ["p1"],
    });
  });

  it("keeps a category's photograph to that category's products", () => {
    const raw = withShot(goodRaw(), "cat-oils", {
      goods: "merchant",
      productKeys: ["p1"],
    });
    withShot(raw, "category-cold-pressed", {
      goods: "merchant",
      productKeys: ["p1"],
    });
    const plan = expectRule(
      raw,
      /shots "category-cold-pressed" has goods "merchant" but no usable productKeys \(its products are not in the category cold-pressed\)\. Name one or two keys from <products> marked photo=yes in the category cold-pressed/,
    );
    expect(shotOf(plan, "cat-oils")).toMatchObject({
      goods: "merchant",
      productKeys: ["p1"],
    });
    expect(shotOf(plan, "category-cold-pressed")).toMatchObject({
      goods: "none",
      productKeys: [],
    });
  });

  it("photographs a category the model forgot with its own products, or a scene without any", () => {
    const raw = goodRaw();
    raw.shots = raw.shots.filter((s: Raw) => s.purpose !== "category");
    const plan = lenient(raw);
    expect(shotOf(plan, "category-oils")).toMatchObject({
      goods: "merchant",
      productKeys: ["p1", "shop:groundnut-oil"],
      subject: "Oils at Ghani Oils: Mustard Oil and Groundnut Oil",
    });
    const cold = shotOf(plan, "category-cold-pressed");
    expect(cold).toMatchObject({ goods: "none", productKeys: [] });
    expect(cold.subject).toMatch(/with no products in the picture/);
  });

  it("describes a shot with no subject as a scene with no products, not as the business's goods", () => {
    const raw = goodRaw();
    homeOf(raw).splice(5, 1, media("revamp-slot://!!!"));
    const plan = expectRule(raw, /not a valid shot id/);
    const made = plan.shots.find((s) => s.id === "home-media-text")!;
    expect(made).toMatchObject({ goods: "none", productKeys: [] });
    expect(made.subject).toMatch(/with no products in the picture/);
  });

  it("gives every shot its goods, and a split shot keys of its own", () => {
    const raw = withShot(goodRaw(), "mill-floor", {
      goods: "merchant",
      productKeys: ["p1"],
    });
    raw.pages[1].sections.push(
      media(slot("mill-floor"), { media_ratio: "landscape" }),
    );
    const plan = strict(raw).plan!;
    for (const s of plan.shots) {
      expect(["merchant", "none"]).toContain(s.goods);
      expect(Array.isArray(s.productKeys)).toBe(true);
    }
    const first = shotOf(plan, "mill-floor");
    const second = shotOf(plan, "mill-floor-2");
    expect(second.productKeys).toEqual(first.productKeys);
    expect(second.productKeys).not.toBe(first.productKeys);
  });

  it("★★ never lists a product photo the photos step cannot read: an outside link, or one the snapshot does not list", () => {
    const CDN = "https://cdn.shopify.com/s/files/1/0001/groundnut.jpg";
    const products = snapshot().products.map((p) =>
      p.id === "x2" ? { ...p, imageUrl: CDN } : p,
    );
    // An outside link names no store folder: never photo=yes.
    const outside = revampGoodsCatalogue(input({ snapshot: { products } }));
    expect([...outside.keys()]).toEqual(["p1"]);
    // The snapshot's own list, read by the bucket's rule, decides when it is
    // there: a photo of this store's folder that it leaves off is not shown.
    const listed = revampGoodsCatalogue(
      input({
        snapshot: {
          photos: {
            replaceable: [THEME_PHOTO, OLD_MINK],
            broken: [],
            readable: [PRODUCT_PHOTO],
          },
        },
      }),
    );
    expect([...listed.keys()]).toEqual(["shop:groundnut-oil"]);
    // And a shot naming it shows no products, its words written again.
    const raw = withShot(goodRaw(), "mill-floor", {
      goods: "merchant",
      productKeys: ["shop:groundnut-oil"],
      subject: "Two bottles of Groundnut Oil on the mill floor at dawn",
    });
    const plan = expectRule(
      raw,
      /shots "mill-floor" has goods "merchant" but no usable productKeys/,
      { snapshot: { products } },
    );
    expect(shotOf(plan, "mill-floor").subject).not.toMatch(/Groundnut/);
  });

  it("★★ a shot that loses its products is described by what it shows, with nobody in it", () => {
    const raw = withShot(goodRaw(), "about-press", {
      goods: "merchant",
      productKeys: ["p2"],
      subject: "Three amber glass bottles of cold-pressed oil on a marble slab",
      people: "adults",
    });
    // The lenient finish (after the repairs) takes the plan as it is: the
    // compiler's own words for a scene, led by where the photo goes.
    expect(shotOf(lenient(raw), "about-press")).toMatchObject({
      goods: "none",
      productKeys: [],
      subject:
        "Oil at the mill: the setting behind Ghani Oils (Ghani Oils sells cold-pressed groundnut and mustard oil from our mill in Ludhiana.): its place, materials and light, with no products in the picture",
      people: "none",
    });
    // ★ A strict compile asks the model, and settles it the same way.
    const result = strict(raw);
    expect(result.plan).toBeNull();
    expect(result.issues.join("\n")).toMatch(
      /shots "about-press" has goods "merchant" but no usable productKeys/,
    );
  });

  it("★★ a shot that keeps only some of its products names only those; one that keeps all keeps its words", () => {
    const partial = withShot(goodRaw(), "hero-mill", {
      goods: "merchant",
      productKeys: ["p1", "p2"],
      subject: "Mustard Oil and a tin of Desi Ghee on the mill floor",
      people: "adults",
    });
    const result = strict(partial);
    expect(result.issues).toEqual([]);
    expect(shotOf(result.plan!, "hero-mill")).toMatchObject({
      goods: "merchant",
      productKeys: ["p1"],
      subject: "Pressed in Ludhiana: Mustard Oil, photographed for Ghani Oils",
      // A person may still wear or use the product it shows.
      people: "adults",
    });
    // Named twice, by key and by address: nothing lost, the words kept.
    const whole = withShot(goodRaw(), "hero-mill", {
      goods: "merchant",
      productKeys: ["p1", "/shop/groundnut-oil", "P1"],
      subject: "Mustard Oil and Groundnut Oil on the mill floor",
    });
    expect(shotOf(strict(whole).plan!, "hero-mill").subject).toBe(
      "Mustard Oil and Groundnut Oil on the mill floor",
    );
    // A third product is one too many: the first two, and words for them.
    const req = request();
    req.products[1] = {
      ...req.products[1],
      photoUrl: `${BUCKET}/uploads/ghee.webp`,
    };
    const three = withShot(goodRaw(), "hero-mill", {
      goods: "merchant",
      productKeys: ["p2", "p1", "shop:groundnut-oil"],
      subject: "Ghee, mustard oil and groundnut oil together",
    });
    expect(
      shotOf(strict(three, { request: req }).plan!, "hero-mill").subject,
    ).toBe(
      "Pressed in Ludhiana: Desi Ghee and Mustard Oil, photographed for Ghani Oils",
    );
  });

  it("★ keeps a carried photograph's words and people, though its product can no longer be named", () => {
    const first = withShot(goodRaw(), "hero-mill", {
      goods: "merchant",
      productKeys: ["p1"],
      subject: "Mustard Oil poured at the mill",
      people: "adults",
    });
    const previous = strict(first).plan!;
    expect(shotOf(previous, "hero-mill")).toMatchObject({
      goods: "merchant",
      subject: "Mustard Oil poured at the mill",
      people: "adults",
    });
    // The product's photo is gone: the carried picture is not drawn again,
    // so its words still describe it.
    const req = request();
    req.products[0] = { ...req.products[0], photoUrl: null };
    const plan = lenient(goodRaw(), {
      request: {
        ...req,
        kind: "refine",
        instruction: "Warmer colours, please.",
        refineScope: scopeOf({ photos: null }),
      },
      previous,
    });
    expect(shotOf(plan, "hero-mill")).toMatchObject({
      subject: "Mustard Oil poured at the mill",
      people: "adults",
    });
  });

  it("reads a shot from before prompt v5 as a scene with no products", () => {
    expect(revampShotGoods({})).toEqual({ goods: "none", productKeys: [] });
    expect(revampShotGoods({ goods: "merchant", productKeys: [] })).toEqual({
      goods: "none",
      productKeys: [],
    });
    expect(
      revampShotGoods({ goods: "merchant", productKeys: ["p1", "p2", "p3"] }),
    ).toEqual({ goods: "merchant", productKeys: ["p1", "p2"] });
    expect(revampShotGoods({ goods: "none", productKeys: ["p1"] })).toEqual({
      goods: "none",
      productKeys: [],
    });
  });
});

describe("the opening", () => {
  it("inserts a fullbleed hero bound to a hero shot when the homepage opens on something else", () => {
    const raw = goodRaw();
    homeOf(raw)[0] = rich("<p>We press oil in Ludhiana.</p>");
    const plan = expectRule(raw, /must open with a full-band photograph/);
    const first = plan.pages[0].sections[0];
    expect(first.type).toBe("hero");
    expect(first.style).toEqual({ width: "full" });
    expect(conf(first)).toMatchObject({
      variant: "fullbleed",
      height: "large",
      image_url: slot("home-hero"),
    });
    expect(conf(first).subheading).not.toMatch(/fresh/i);
    expect(plan.shots.find((s) => s.id === "home-hero")).toMatchObject({
      purpose: "hero",
      aspectRatio: "21:9",
    });
    expect(
      plan.bindings.find((b) => b.shotId === "home-hero")?.phonePath,
    ).toEqual(["mobile_image_url"]);
    expect(plan.notes).toContain(
      "The homepage now opens with a full-width photograph.",
    );
  });

  it("turns a one-photo carousel into a fullbleed hero, silently", () => {
    const raw = goodRaw();
    homeOf(raw)[0] = carousel(["hero-mill"]);
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    const first = result.plan!.pages[0].sections[0];
    expect(first.type).toBe("hero");
    expect(conf(first)).toMatchObject({
      variant: "fullbleed",
      image_url: slot("hero-mill"),
      heading: "Pressed in Ludhiana",
    });
    expect(result.plan!.shots.map((s) => s.id)).not.toContain("hero-bottles");
  });

  it("keeps three photographed slides at most, on the full layout", () => {
    const raw = goodRaw();
    homeOf(raw)[0] = carousel([
      "hero-mill",
      "hero-bottles",
      "slide-c",
      "slide-d",
    ]);
    editConfig(homeOf(raw)[0], (c) => {
      c.layout = "split";
      c.height = "small";
    });
    raw.shots.push(shot("slide-c"), shot("slide-d"));
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    const c = conf(result.plan!.pages[0].sections[0]);
    expect(c.slides).toHaveLength(3);
    expect(c.layout).toBeUndefined();
    expect(c.height).toBe("large");
    expect(result.plan!.shots.map((s) => s.id)).not.toContain("slide-d");
  });

  it("asks for the opening hero's photograph", () => {
    const raw = goodRaw();
    homeOf(raw)[0] = {
      type: "hero",
      configJson: cfg({
        variant: "banner",
        heading: "Ghani Oils",
        image_url: "",
      }),
    };
    const plan = expectRule(raw, /give the hero an image/);
    expect(conf(plan.pages[0].sections[0])).toMatchObject({
      variant: "fullbleed",
      image_url: slot("home-hero"),
    });
  });
});

describe("newsletters and colour bands", () => {
  it("closes the page with the newsletter", () => {
    const raw = goodRaw();
    homeOf(raw).splice(2, 0, homeOf(raw).pop()!);
    const plan = expectRule(
      raw,
      /a newsletter section may only be the last section/,
    );
    expect(plan.pages[0].sections.at(-1)?.type).toBe("newsletter");
    expect(plan.notes).toContain(
      "The newsletter sign-up was moved to the end of the page.",
    );
  });

  it("allows one newsletter a page", () => {
    const raw = goodRaw();
    homeOf(raw).push(newsletter());
    const plan = expectRule(raw, /a page has at most one newsletter section/);
    expect(
      plan.pages[0].sections.filter((s) => s.type === "newsletter"),
    ).toHaveLength(1);
  });

  it("never gives two neighbours the same scheme", () => {
    const raw = goodRaw();
    homeOf(raw)[5] = media(slot("mill-floor"), {}, { scheme: "tint" });
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    const plan = result.plan!;
    expect(section(plan, "s4").style?.scheme).toBeUndefined();
  });

  it("keeps two or three schemes a page", () => {
    const raw = goodRaw();
    homeOf(raw)[5] = media(slot("mill-floor"), {}, { scheme: "accent" });
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    const plan = result.plan!;
    expect(plan.pages[0].sections.filter((s) => s.style?.scheme)).toHaveLength(
      3,
    );

    const few = goodRaw();
    delete homeOf(few)[2].style;
    delete homeOf(few)[4].style;
    const fixed = strict(few);
    expect(fixed.issues).toEqual([]);
    const fewer = fixed.plan!;
    expect(fewer.pages[0].sections.filter((s) => s.style?.scheme)).toHaveLength(
      2,
    );
    expect(fewer.notes).toEqual([
      "The look follows your warm and earthy brief.",
    ]);
  });
});

describe("pages", () => {
  it("never writes a policy page", () => {
    const raw = goodRaw();
    raw.pages.push({
      slug: "terms",
      title: "Terms",
      seoTitle: "Terms",
      seoDescription: "The terms of Ghani Oils for every order.",
      sections: [rich("<p>Our terms.</p>")],
    });
    const plan = expectRule(raw, /"terms" is a policy page/);
    expect(plan.pages.map((p) => p.slug)).toEqual(["", "about"]);
  });

  it("creates a new page with a valid address and refuses a bad one", () => {
    const raw = goodRaw();
    raw.pages.push({
      slug: "our-story",
      title: "Our story",
      seoTitle: "Our story",
      seoDescription: "The story of the mill behind Ghani Oils.",
      sections: [rich("<p>We press oil in Ludhiana.</p>")],
    });
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    expect(result.plan!.pages[2]).toMatchObject({
      slug: "our-story",
      create: true,
      pageId: null,
    });

    raw.pages[2].slug = "Our Story!!";
    expectRule(raw, /"Our Story!!" cannot be a new page's address/);
  });

  it("writes only the pages the merchant named", () => {
    const plan = expectRule(goodRaw(), /Page "about" was not asked for/, {
      request: { pages: ["home"] },
    });
    expect(plan.pages.map((p) => p.slug)).toEqual([""]);
  });

  it("completes a page's title and search description", () => {
    const raw = goodRaw();
    raw.pages[1].title = "";
    raw.pages[1].seoDescription = "Short.";
    const plan = expectRule(
      raw,
      /Page "about" needs a title[\s\S]*seoDescription must be at least 20 characters/,
    );
    expect(plan.pages[1].title).toBe("About");
    expect(plan.pages[1].seoDescription).toBe(
      "About - Ghani Oils. Browse the shop and find out more.",
    );
    expect(plan.notes).toContain(
      "Page titles and search descriptions were completed.",
    );
  });
});

// ---------------------------------------------------------------------------
// Chrome, design and copy.
// ---------------------------------------------------------------------------

describe("menus and chrome", () => {
  it("keeps seven top-level header links, never a menu image", () => {
    const raw = goodRaw();
    raw.menus.header = "Shop Oils Ghee About Mill Story Visit Press Help"
      .split(" ")
      .map((label) => ({ label, href: "/shop", children: [] }));
    const plan = expectRule(
      raw,
      /menus.header has 9 top-level links; use at most 7/,
    );
    expect(plan.menus.header).toHaveLength(7);

    const images = goodRaw();
    images.menus.header[0] = {
      label: "Shop",
      href: "/shop",
      image_url: PRODUCT_PHOTO,
      children: [{ label: "Oils", href: "/collections/oils" }],
    };
    const result = strict(images);
    expect(result.issues).toEqual([]);
    expect(result.plan!.menus.header[0]).toEqual({
      label: "Shop",
      href: "/shop",
      children: [{ label: "Oils", href: "/collections/oils" }],
    });
  });

  it("sends a link labelled Home to the homepage, in any case, silently (B19)", () => {
    const raw = goodRaw();
    raw.menus.header = [
      { label: "Home", href: "/home", children: [] },
      {
        label: "Shop",
        href: "/shop",
        children: [{ label: "HOME PAGE", href: "", children: [] }],
      },
      { label: " homepage ", href: "/shop", children: [] },
    ];
    raw.menus.footerGroups = [
      {
        title: "Shop",
        links: [
          { label: "home", href: "/nowhere" },
          { label: "All products", href: "/shop" },
        ],
      },
    ];
    const result = strict(raw);
    // ★ No repair is asked for: only one address is right for Home.
    expect(result.issues).toEqual([]);
    expect(result.plan!.menus.header).toEqual([
      { label: "Home", href: "/" },
      {
        label: "Shop",
        href: "/shop",
        children: [{ label: "HOME PAGE", href: "/" }],
      },
      { label: "homepage", href: "/" },
    ]);
    expect(result.plan!.menus.footerGroups[0].links).toEqual([
      { label: "home", href: "/" },
      { label: "All products", href: "/shop" },
    ]);
  });

  it("sends Home to the homepage in menus a refinement copies too", () => {
    const previous = strict(goodRaw()).plan!;
    previous.menus.header = [
      { label: "Home", href: "/shop" },
      { label: "Shop", href: "/shop" },
    ];
    previous.menus.footerGroups = [
      { title: "Pages", links: [{ label: "Home Page", href: "/about" }] },
    ];
    const over: Over = {
      request: {
        kind: "refine",
        instruction: "Change the photos.",
        refineScope: scopeOf({ copy: false, layout: false, design: false }),
      },
      previous,
    };
    const plan = lenient(goodRaw(), over);
    expect(plan.menus.header).toEqual([
      { label: "Home", href: "/" },
      { label: "Shop", href: "/shop" },
    ]);
    expect(plan.menus.footerGroups[0].links).toEqual([
      { label: "Home Page", href: "/" },
    ]);
  });

  it("★★ keeps a link labelled Home that goes to the store's own category, product or page called Home", () => {
    const store = snapshot();
    store.categories = [
      ...store.categories,
      {
        id: "c4",
        slug: "home",
        name: "Home",
        description: null,
        imageUrl: null,
        status: "active",
        updatedAt: "t",
        sample: false,
        productCount: 3,
      },
      {
        // A theme's own sample is no link target: Home there goes home.
        id: "c5",
        slug: "home-samples",
        name: "Home",
        description: null,
        imageUrl: null,
        status: "active",
        updatedAt: "t",
        sample: true,
        productCount: 1,
      },
    ];
    const raw = goodRaw();
    raw.menus.header = [
      {
        label: "Shop",
        href: "/shop",
        children: [
          { label: "Oils", href: "/collections/oils", children: [] },
          { label: "Home", href: "/collections/home", children: [] },
          { label: "Home", href: "/collections/home-samples", children: [] },
        ],
      },
      { label: "Home", href: "/shop", children: [] },
    ];
    raw.menus.footerGroups = [
      {
        title: "Shop",
        links: [
          { label: "Home", href: "/collections/home" },
          { label: "Home", href: "/about" },
        ],
      },
    ];
    // Silently: no repair is asked for any of these links.
    expect(
      strict(raw, { snapshot: store }).issues.filter((i) => /menus/.test(i)),
    ).toEqual([]);
    const plan = lenient(raw, { snapshot: store });
    expect(plan.menus.header).toEqual([
      {
        label: "Shop",
        href: "/shop",
        children: [
          { label: "Oils", href: "/collections/oils" },
          { label: "Home", href: "/collections/home" },
          { label: "Home", href: "/" },
        ],
      },
      { label: "Home", href: "/" },
    ]);
    // "About us" is not called Home: that Home goes home.
    expect(plan.menus.footerGroups[0].links).toEqual([
      { label: "Home", href: "/collections/home" },
      { label: "Home", href: "/" },
    ]);

    // ★ A category renamed Home by a confirmed change, and a page the plan
    //   titles Home, keep theirs too; one renamed away from Home does not.
    const req = request();
    req.categories = [
      ...req.categories.filter(
        (change) => !(change.action === "update" && change.slug === "oils"),
      ),
      {
        action: "update",
        slug: "oils",
        name: "Home",
        description: null,
        newPhoto: false,
      },
    ];
    const renamed = goodRaw();
    renamed.pages[1].title = "Home";
    renamed.menus.header = [
      { label: "Home", href: "/collections/oils", children: [] },
      { label: "Home", href: "/about", children: [] },
      { label: "Home", href: "/collections/ghee", children: [] },
    ];
    expect(
      lenient(renamed, { request: req }).menus.header.map((l) => l.href),
    ).toEqual(["/collections/oils", "/about", "/"]);
  });

  it("keeps a link whose label only contains the word home to its own address", () => {
    expect(isHomeLabel("Home")).toBe(true);
    expect(isHomeLabel("home page")).toBe(true);
    expect(isHomeLabel("Homepage")).toBe(true);
    expect(isHomeLabel("Home decor")).toBe(false);
    expect(isHomeLabel("Back home")).toBe(false);
    const raw = goodRaw();
    raw.menus.header.push({
      label: "Home decor",
      href: "/collections/oils",
      children: [],
    });
    expect(strict(raw).plan!.menus.header.at(-1)).toEqual({
      label: "Home decor",
      href: "/collections/oils",
    });
  });

  it("gives an empty header a Shop link", () => {
    const raw = goodRaw();
    raw.menus.header = [];
    const plan = expectRule(raw, /menus.header is empty/);
    expect(plan.menus.header).toEqual([{ label: "Shop", href: "/shop" }]);
  });

  it("holds the announcement, brand and newsletter wording to their lengths", () => {
    const raw = goodRaw();
    raw.announcement.text = "We deliver across Punjab. ".repeat(12);
    raw.brand.tagline = "";
    const plan = expectRule(raw, /brand.tagline is empty/);
    expect(plan.announcement.text.length).toBeLessThanOrEqual(160);
    expect(plan.brand.tagline.length).toBeGreaterThan(0);
    expect(plan.brand.tagline.length).toBeLessThanOrEqual(80);
  });

  it("keeps the appearance variants a revamp may choose", () => {
    const raw = goodRaw();
    raw.appearance.header = "fancy";
    expect(strict(raw).plan!.appearance).toEqual({
      card: "classic",
      productDetail: "classic",
      footer: "rich",
    });
  });
});

/** A copy of `value` without `key`. */
function without<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([k]) => k !== String(key)),
  ) as Omit<T, K>;
}

describe("design", () => {
  const KEPT_NOTE =
    "The new colours did not pass the readability check, so your theme's colours were kept.";
  const reads = (fg: string, bg: string) =>
    contrastRatio(fg, bg) >= DESIGN_MIN_CONTRAST;

  it("mends a page, text or accent colour that is not a colour and keeps the other seven (B18)", () => {
    const raw = goodRaw();
    raw.design.palette.accent = "green";
    const plan = expectRule(raw, /design.palette accent must each be a colour/);
    // ★ The accent follows the theme's (left out); the rest is the new look.
    expect(plan.design.palette).toEqual(without(PALETTE, "accent"));
    expect(plan.notes).toContain(
      "A colour in the new design could not be used as written, so a matching colour was used in its place.",
    );
    expect(plan.notes).not.toContain(KEPT_NOTE);
  });

  it("works out a soft band or muted text that is not a colour from the new page and text colours", () => {
    const raw = goodRaw();
    raw.design.palette.inkSoft = "grey";
    const plan = expectRule(
      raw,
      /design.palette inkSoft must each be a colour/,
    );
    expect(plan.design.palette).toEqual({
      ...PALETTE,
      inkSoft: mixHex(PALETTE.ink, PALETTE.cream, SCHEME_MIX.textSoft),
    });
  });

  it("mends only the text colour that fails contrast, the least that reads everywhere it sits", () => {
    const pale = goodRaw();
    pale.design.palette.ink = "#f0f0f0";
    const plan = expectRule(pale, /hard to read/);
    const ink = plan.design.palette.ink;
    expect(without(plan.design.palette, "ink")).toEqual(
      without(PALETTE, "ink"),
    );
    expect(ink).toBe(mixHex("#000000", "#f0f0f0", 75));
    // ★ As strict as before: every pair the rules judge reads at 4.5:1,
    //   the soft band's muted text included (the plan uses a soft band).
    for (const bg of [PALETTE.cream, PALETTE.surface, PALETTE.creamDeep]) {
      expect(reads(ink!, bg)).toBe(true);
    }
    expect(
      reads(
        mixHex(ink!, PALETTE.creamDeep, SCHEME_MIX.textSoft),
        PALETTE.creamDeep,
      ),
    ).toBe(true);
    // ★ The least move: one step less does not read in the soft band.
    const lighter = mixHex("#000000", "#f0f0f0", 70);
    expect(
      reads(
        mixHex(lighter, PALETTE.creamDeep, SCHEME_MIX.textSoft),
        PALETTE.creamDeep,
      ),
    ).toBe(false);
    expect(plan.notes).toContain(
      "Some of the new colours were adjusted so all text stays easy to read.",
    );
    // The mended palette passes the storefront's own check too.
    expect(
      contrastIssuesFor(
        {
          palette: plan.design.palette,
          fonts: { body: null, display: null },
          shape: {},
        },
        {
          palette: {
            cream: "#fbf8f1",
            surface: "#ffffff",
            ink: "#1f1d1a",
            accent: "#2f6b3a",
          },
        },
      ),
    ).toEqual([]);
  });

  it("lightens a band background even black text cannot read on", () => {
    const raw = goodRaw();
    raw.design.palette.creamDeep = "#555555";
    const plan = expectRule(raw, /hard to read/);
    const p = plan.design.palette;
    expect(p.creamDeep).not.toBe("#555555");
    expect(isLightColour(p.creamDeep!)).toBe(true);
    expect(reads(p.ink!, p.creamDeep!)).toBe(true);
    expect(reads(p.inkSoft!, p.creamDeep!)).toBe(true);
    expect(
      reads(mixHex(p.ink!, p.creamDeep!, SCHEME_MIX.textSoft), p.creamDeep!),
    ).toBe(true);
    // The page, the cards and the accent are the new look, untouched.
    expect(p.cream).toBe(PALETTE.cream);
    expect(p.surface).toBe(PALETTE.surface);
    expect(p.accent).toBe(PALETTE.accent);
  });

  it("keeps the theme's page layer and the new accent when the page would turn dark", () => {
    const dark = goodRaw();
    dark.design.palette = {
      cream: "#121212",
      creamDeep: "#1e1e1e",
      surface: "#1a1a1a",
      ink: "#f2f2f2",
      inkSoft: "#d0d0d0",
      inkFaint: "#999999",
      border: "#333333",
      accent: "#7fbf7f",
    };
    const plan = expectRule(dark, /turns the theme from light to dark/);
    expect(plan.design.palette).toEqual({ accent: "#7fbf7f" });
    expect(plan.notes.join(" ")).toMatch(
      /theme's page and text colours were kept/,
    );
  });

  it("keeps the theme's colours when nothing of the new palette can be kept", () => {
    // ★ A page layer that would flip is the theme's, and with no usable
    //   accent left there is nothing new to keep: the old rule, unrelaxed.
    const none = goodRaw();
    none.design.palette = {
      cream: "#121212",
      creamDeep: "#1e1e1e",
      surface: "#1a1a1a",
      ink: "#f2f2f2",
      inkSoft: "#d0d0d0",
      inkFaint: "#999999",
      border: "#333333",
      accent: "green",
    };
    const kept = expectRule(
      none,
      /design.palette accent must each be a colour/,
    );
    expect(kept.design.palette).toEqual({});
    expect(kept.notes).toContain(KEPT_NOTE);
  });

  it("gives up an accent whose tinted band no text can read on, and keeps the rest", () => {
    const fallback = {
      cream: "#fbf8f1",
      surface: "#ffffff",
      ink: "#1f1d1a",
      accent: "#ffffff",
    };
    const proposed = {
      cream: "#7a7a7a",
      creamDeep: "#808080",
      surface: "#ffffff",
      ink: "#000000",
      inkSoft: "#000000",
      inkFaint: "#333333",
      border: "#666666",
      accent: "#000000",
    };
    const result = repairRevampPalette(proposed, fallback, new Set(["tint"]));
    expect(result.outcome).toBe("repaired");
    expect(result.palette).toEqual(without(proposed, "accent"));
    // Unmendable: the theme's accent cannot rescue it either.
    expect(
      repairRevampPalette(
        proposed,
        { ...fallback, accent: "#000000" },
        new Set(["tint"]),
      ),
    ).toEqual({ palette: {}, outcome: "theme" });
  });

  it("maps the font pairing to font keys and clamps the radii", () => {
    const raw = goodRaw();
    raw.design.fontPairing = "comic";
    const plan = expectRule(
      raw,
      /design.fontPairing "comic" is not one of the pairings/,
    );
    expect(plan.design.fonts).toEqual({ body: null, display: null });
    expect(plan.notes).toContain("Your theme's fonts were kept.");

    const radii = goodRaw();
    radii.design.radii = { card: 99, control: -3, sm: 4.6, pill: 5000 };
    expect(strict(radii).plan!.design.shape).toEqual({
      card: 48,
      control: 0,
      sm: 5,
      pill: 999,
    });
  });
});

describe("copy", () => {
  const withBody = (body: string, heading = "How we press") => {
    const raw = goodRaw();
    homeOf(raw)[5] = media(slot("mill-floor"), { body, heading });
    return raw;
  };

  it("removes a claim the merchant never made, sentence by sentence", () => {
    const plan = expectRule(
      withBody("The best oil in Punjab. Pressed slowly."),
      /claims "best" but the merchant never said so/,
    );
    expect(conf(section(plan, "s4")).body).toBe("Pressed slowly.");
    expect(plan.notes).toContain(
      "Wording that made claims you have not made was removed.",
    );
  });

  it("removes numbers the merchant never gave, and reads prices as numbers", () => {
    const plan = expectRule(
      withBody("Each bottle holds 750 ml. Turned slowly."),
      /states 750, which the merchant never gave/,
    );
    expect(conf(section(plan, "s4")).body).toBe("Turned slowly.");

    const req = request();
    req.products[0].sizes[0].price = 249.5;
    const priced = strict(withBody("From 249.50 a litre."), {
      request: { products: req.products },
    });
    expect(priced.issues).toEqual([]);
  });

  it("★★ never takes the brand voice as evidence for a claim (B17)", () => {
    const raw = goodRaw();
    raw.pages[1].sections[0] = rich(
      "<p>Organic oil from an award-winning mill.</p>",
    );
    // The planner reads the saved voice for tone; the compiler is handed the
    // same input and must still refuse what only the voice says.
    const voiced = {
      ...input(),
      brandVoice: "We are organic and award-winning, and we say so.",
    };
    const result = compileRevampSite(raw, voiced, { newId: ids() });
    expect(result.issues.join("\n")).toMatch(/claims "organic"/);
    expect(result.issues.join("\n")).toMatch(/award/);
  });

  it("accepts the merchant's own catalogue names as evidence", () => {
    const raw = goodRaw();
    raw.pages[1].sections[0] = rich("<p>Try our Organic Groundnut Oil.</p>");
    expect(strict(raw).issues.join("\n")).toMatch(/claims "organic"/);
    const products = snapshot().products.map((p) =>
      p.sample ? p : { ...p, name: "Organic Groundnut Oil" },
    );
    expect(strict(raw, { snapshot: { products } }).issues).toEqual([]);
  });

  it("checks the language the brief asks for", () => {
    const hindi = withBody("Seeds turn slowly.", "हमारा तेल");
    const plan = expectRule(hindi, /config.heading is not in English/);
    expect(conf(section(plan, "s4")).heading).toBe("");
    const brief = { ...request().brief, language: "Hindi" };
    expect(strict(hindi, { request: { brief } }).issues).toEqual([]);
  });

  it("drops a section left without its required copy", () => {
    const raw = goodRaw();
    homeOf(raw)[7] = newsletter("The best emails.");
    const plan = expectRule(raw, /Add consent text before publishing/);
    expect(plan.pages[0].sections.map((s) => s.type)).not.toContain(
      "newsletter",
    );
  });

  it("keeps at most five notes, the model's last, and none about credits", () => {
    const raw = goodRaw();
    raw.design.palette.accent = "green";
    raw.design.fontPairing = "comic";
    homeOf(raw).splice(3, 1);
    homeOf(raw).unshift(rich("<p>We press oil in Ludhiana.</p>"));
    raw.menus.header = [];
    raw.notes = ["Note A.", "This used 12 credits.", "Note B.", "Note C."];
    const plan = lenient(raw);
    expect(plan.notes).toHaveLength(5);
    expect(plan.notes.slice(-2)).toEqual(["Note A.", "Note B."]);
    expect(plan.notes.join(" ")).not.toMatch(/credit/i);
  });
});

// ---------------------------------------------------------------------------
// Refinement.
// ---------------------------------------------------------------------------

describe("refinement", () => {
  it("copies the previous design and the pages outside the scope, re-checking their links", () => {
    const previous = strict(goodRaw()).plan!;
    conf(previous.pages[1].sections[0]).html =
      '<p>Old words. <a href="/shop/gone">Gone</a></p>';
    const raw = goodRaw();
    raw.direction = "bold-and-loud";
    raw.design.palette.accent = "#aa3311";
    raw.pages = raw.pages.filter((p: Raw) => p.slug === "home");
    const over: Over = {
      request: {
        kind: "refine",
        instruction: "Make the homepage calmer.",
        refineScope: scopeOf({
          design: false,
          pages: ["home"],
          products: false,
        }),
      },
      previous,
    };
    const result = strict(raw, over);
    expect(result.issues).toEqual([]);
    const plan = result.plan!;
    expect(plan.design).toEqual(previous.design);
    expect(plan.direction).toBe("soft-and-natural");
    expect(plan.pages.map((p) => p.slug)).toEqual(["", "about"]);
    expect(plan.pages[1].sections).toEqual([
      {
        ...previous.pages[1].sections[0],
        config: {
          ...conf(previous.pages[1].sections[0]),
          html: "<p>Old words. Gone</p>",
        },
      },
      previous.pages[1].sections[1],
    ]);
    expect(plan.productCopy).toEqual(previous.productCopy);
    expect(plan.shots).toEqual(previous.shots);
  });

  it("fixes a copied page quietly, still putting the merchant's section back", () => {
    const previous = strict(goodRaw()).plan!;
    previous.pages[0].sections = previous.pages[0].sections.filter(
      (s) => s.id !== "m-code",
    );
    const raw = goodRaw();
    raw.pages = raw.pages.filter((p: Raw) => p.slug === "about");
    const over: Over = {
      request: {
        kind: "refine",
        instruction: "Rewrite the about page.",
        refineScope: scopeOf({ pages: ["about"] }),
      },
      previous,
    };
    const result = strict(raw, over);
    expect(result.issues).toEqual([]);
    expect(result.plan!.pages[0].sections.map((s) => s.id)).toContain("m-code");
    expect(lenient(raw, over).notes).toContain(
      "Your own sections were kept on every page.",
    );
  });
});

describe("entry points", () => {
  it("refuses an answer that is not an object, and throws only when nothing is usable", () => {
    expect(strict("nope").issues[0]).toMatch(/not a JSON object/);
    expect(() => lenient("nope")).toThrow(RevampStepError);
    try {
      lenient({ pages: [] });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RevampStepError);
      expect((error as RevampStepError).code).toBe("plan_invalid");
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers the prompt, the planner and the fake plan share.
// ---------------------------------------------------------------------------

describe("shared helpers", () => {
  it("scopes pages: default, named (policy first) and the page limit", () => {
    const base = revampPageScope({ request: request(), snapshot: snapshot() });
    expect(base.pages.map((p) => [p.slug, p.write])).toEqual([
      ["", true],
      ["about", true],
    ]);
    expect(base.skipped).toEqual([]);
    expect(base.newPagesAllowed).toBe(REVAMP_LIMITS.maxPages - 2);

    const named = revampPageScope({
      request: { ...request(), pages: ["home", "terms", "Bad Slug!", "about"] },
      snapshot: snapshot(),
    });
    expect(named.pages.map((p) => p.slug)).toEqual(["", "about"]);
    expect(named.skipped).toEqual([
      {
        label: 'The "Terms" page',
        reason: "Policy pages are never changed by a redesign.",
      },
      {
        label: 'The "bad slug!" page',
        reason: "That page address cannot be used for a page.",
      },
    ]);

    const many = revampPageScope({
      request: {
        ...request(),
        pages: Array.from(
          { length: 12 },
          (_, i) => `page-${"abcdefghijkl"[i]}`,
        ),
      },
      snapshot: snapshot(),
    });
    expect(many.pages).toHaveLength(REVAMP_LIMITS.maxPages);
    expect(many.skipped.map((s) => s.reason)).toEqual([
      "A redesign writes at most 10 pages at a time.",
      "A redesign writes at most 10 pages at a time.",
    ]);
  });

  it("finds the refill slots, the owned photos and the category needs", () => {
    expect(
      revampRefillSlots(input()).map((s) => [s.shotId, s.sectionId, s.ratio]),
    ).toEqual([
      [REFILL_STORY, "m-story", "4:5"],
      [REFILL_BANNER, "m-banner", "21:9"],
    ]);
    expect(revampOwnedPhotoUrls(input())).toEqual(
      new Set([MUSTARD_PHOTO, PRODUCT_PHOTO]),
    );
    const needs = revampCategoryPhotoNeeds({
      snapshot: snapshot(),
      request: {
        ...request(),
        categories: [
          {
            action: "create",
            name: "Cold Pressed",
            slug: null,
            description: null,
            newPhoto: false,
          },
          {
            action: "update",
            slug: "oils",
            name: null,
            description: null,
            newPhoto: false,
          },
        ],
      },
    });
    expect(needs).toEqual([
      { slug: "cold-pressed", name: "Cold Pressed", action: "create" },
    ]);
    expect(revampCategoryBandAllowed(input())).toBe(true);
    expect(revampHasRealProducts(input())).toBe(true);
  });

  it("names shots within the id rules", () => {
    expect(sanitizeShotId("Hero Mill!")).toBe("hero-mill");
    expect(sanitizeShotId("9 lives")).toBe("shot-9-lives");
    expect(sanitizeShotId("anchor")).toBe("anchor-shot");
    expect(sanitizeShotId("")).toBeNull();
    expect(revampCategoryShotId("oils")).toBe("category-oils");
    const a = revampCategoryShotId("a".repeat(45));
    const b = revampCategoryShotId(`${"a".repeat(44)}b`);
    expect(a).not.toBe(b);
    for (const id of [a, b]) {
      expect(id.length).toBeLessThanOrEqual(40);
      expect(id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    }
  });

  it("checks links against the pages, categories and products after Apply", () => {
    const targets = revampLinkTargets({
      request: request(),
      snapshot: snapshot(),
      plan: { pages: [] },
    });
    expect(checkRevampLink("", targets)).toBe("");
    expect(checkRevampLink("/", targets)).toBe("/");
    expect(checkRevampLink("/Shop/", targets)).toBe("/shop");
    expect(checkRevampLink("/collections/oils", targets)).toBe(
      "/collections/oils",
    );
    expect(checkRevampLink("/collections/cold-pressed", targets)).toBe(
      "/collections/cold-pressed",
    );
    expect(checkRevampLink("/collections/fruits", targets)).toBeNull();
    expect(checkRevampLink("/shop/groundnut-oil", targets)).toBe(
      "/shop/groundnut-oil",
    );
    expect(checkRevampLink("/shop/mustard-oil", targets)).toBe(
      "/shop/mustard-oil",
    );
    expect(checkRevampLink("/shop/banana", targets)).toBeNull();
    expect(checkRevampLink("/terms", targets)).toBe("/terms");
    expect(checkRevampLink("/about?x=1", targets)).toBeNull();
    expect(checkRevampLink("//evil.example", targets)).toBeNull();
    expect(checkRevampLink("https://evil.example", targets)).toBeNull();
    expect(revampNewProductSlugs(input())).toEqual(
      new Map([
        ["p1", "mustard-oil"],
        ["p2", "desi-ghee"],
      ]),
    );
    expect(revampProductSlug("Mustard Oil", new Set(["mustard-oil"]))).toBe(
      "mustard-oil-2",
    );
    expect(revampProductSlug("Café & Co", new Set())).toBe("cafe-and-co");
  });

  it("reads frames, ratios, slugs, colours and text limits", () => {
    expect(revampFrameKeyFor("hero", { variant: "split" }, ["image_url"])).toBe(
      "hero_side",
    );
    expect(
      revampFrameKeyFor("hero_carousel", { layout: "split" }, [
        "slides",
        0,
        "image_url",
      ]),
    ).toBe("hero_side");
    expect(
      revampFrameKeyFor("gallery", { layout: "grid", image_ratio: "square" }, [
        "items",
        0,
        "image_url",
      ]),
    ).toBe("square");
    expect(
      revampFrameKeyFor("video", { aspect_ratio: "portrait" }, ["poster_url"]),
    ).toBe("portrait");
    expect(revampFrameKeyFor("rich_text", {}, ["image_url"])).toBeNull();
    expect(revampRatioFor(2520 / 1080)).toBe("21:9");
    expect(revampRatioFor(0.8)).toBe("4:5");
    expect(revampRatioFor(4 / 3)).toBe("4:3");
    expect(normalizeRevampPageSlug("Home")).toBe("");
    expect(normalizeRevampPageSlug("/about/")).toBe("about");
    expect(normalizeRevampPageSlug("index")).toBe("");
    expect(normalizeRevampHex("#ABC")).toBe("#aabbcc");
    expect(normalizeRevampHex("red")).toBeNull();
    expect(isLightColour("#ffffff")).toBe(true);
    expect(isLightColour("#000000")).toBe(false);
    expect(clipText("one two three four", 9)).toBe("one two");
    expect(fallbackSeoDescription("Ghani Oils", "Ghani Oils")).toBe(
      "Ghani Oils. Browse the shop and find out more.",
    );
  });
});

describe("edge cases", () => {
  it("reports footer and announcement links, a page written twice, a missing page and an unknown direction", () => {
    const raw = goodRaw();
    raw.menus.footerGroups[0].links.push({ label: "Old", href: "/old-page" });
    raw.announcement.href = "/nowhere";
    raw.pages.push({ ...raw.pages[0] });
    raw.pages.splice(1, 1);
    raw.direction = "wild";
    const issues = strict(raw).issues.join("\n");
    expect(issues).toMatch(/links\[1\] "Old" links to "\/old-page"/);
    expect(issues).toMatch(/announcement.href "\/nowhere" will not exist/);
    expect(issues).toMatch(/the page "home" appears twice/);
    expect(issues).toMatch(/Page "about" is missing/);
    expect(issues).toMatch(
      /direction "wild" is not one of the design directions/,
    );
    const plan = lenient(raw);
    expect(plan.pages.map((p) => p.slug)).toEqual([""]);
    expect(plan.announcement).toEqual({
      text: "We deliver across Punjab.",
      href: "",
    });
    expect(plan.menus.footerGroups[0].links).toEqual([
      { label: "All products", href: "/shop" },
    ]);
    expect(plan.direction).toBe("classic-and-trusted");
  });

  it("keeps a merchant's own opening and newsletter, refusing a second newsletter", () => {
    const snap = snapshot();
    snap.pages[0] = page(
      "page-home",
      "",
      "Home",
      [
        {
          ...sec("m-hero", "hero", {
            variant: "fullbleed",
            height: "large",
            heading: "Ghani Oils",
            image_url: PRODUCT_PHOTO,
            theme: "light",
          }),
          style: { width: "full" },
        } as PageSectionItem,
        sec("m-news", "newsletter", {
          heading: "Letters",
          subheading: "",
          consent_text: "Yes, email me.",
        }),
      ],
      { "m-hero": "merchant", "m-news": "merchant" },
    );
    snap.pages.push(page("page-old", "old", "Old", [], {}, "invalid"));
    const raw = goodRaw();
    raw.pages[0].sections = [
      { keep: "m-hero" },
      newsletter(),
      { keep: "m-news" },
    ];
    const over: Over = { snapshot: { pages: snap.pages } };
    const issues = strict(raw, over).issues.join("\n");
    expect(issues).toMatch(
      /already keeps the merchant's own newsletter section/,
    );
    expect(issues).toMatch(
      /The homepage has 2 sections; give it at least four/,
    );
    expect(issues).not.toMatch(/must open with a full-band photograph/);
    const plan = lenient(raw, over);
    expect(plan.pages[0].sections.map((s) => s.id)).toEqual([
      "m-hero",
      "m-news",
    ]);
    expect(revampPageScope(input(over)).skipped).toEqual([
      {
        label: 'The "Old" page',
        reason: "It could not be read, so it was left as it is.",
      },
    ]);
  });

  it("refines photos: redraws on request, renames a shot whose shape changed, reuses a category photo, copies words and menus", () => {
    const previous = strict(goodRaw()).plan!;
    previous.shots = previous.shots.map((s) =>
      s.id === "hero-mill" ? { ...s, aspectRatio: "1:1" } : s,
    );
    conf(section(previous, "s4")).image_url = "https://elsewhere.example/x.jpg";
    const raw = goodRaw();
    raw.shots = raw.shots.filter((s: Raw) => s.purpose !== "category");
    raw.announcement.text = "Something else entirely.";
    raw.menus.header = [{ label: "Elsewhere", href: "/shop" }];
    const over: Over = {
      request: {
        kind: "refine",
        instruction: "New photos, please.",
        refineScope: scopeOf({ copy: false, layout: false, photos: "all" }),
      },
      previous,
    };
    const result = strict(raw, over);
    expect(result.issues).toEqual([]);
    const plan = result.plan!;
    expect(plan.announcement).toEqual(previous.announcement);
    expect(plan.brand).toEqual(previous.brand);
    expect(plan.menus).toEqual(previous.menus);
    const bound = plan.bindings.map((b) => b.shotId);
    expect(bound).toContain("hero-mill-new");
    expect(bound).not.toContain("hero-mill");
    expect(conf(section(plan, "s1")).slides[0].image_url).toBe(
      slot("hero-mill-new"),
    );
    expect(conf(section(plan, "s4")).image_url).toBe("");
    expect(
      plan.bindings
        .filter((b) => b.pageSlug === "@category")
        .map((b) => b.shotId),
    ).toEqual(["category-cold-pressed", "cat-oils"]);
  });

  it("asks for subjects, an art direction and valid shot ids, and clears photos no field can hold", () => {
    const raw = goodRaw();
    raw.shots = raw.shots.map((s: Raw) => ({
      ...s,
      artDirection: "",
      subject: s.id === "mill-floor" ? "" : s.subject,
    }));
    homeOf(raw)[5] = media(slot("mill-floor"), {
      extra_url: slot("hero-mill"),
      more_url: THEME_PHOTO,
    });
    raw.pages[1].sections.push(media(`${REVAMP_SLOT_PREFIX}!!!`));
    const issues = strict(raw).issues.join("\n");
    expect(issues).toMatch(/shots need an artDirection/);
    expect(issues).toMatch(/shots "mill-floor" has no subject/);
    expect(issues).toMatch(/config.extra_url cannot hold a new photograph/);
    expect(issues).toMatch(
      /config.more_url uses "\/themes\/basket\/hero.webp", which is not a photo the store owns/,
    );
    expect(issues).toMatch(
      /names "revamp-slot:\/\/!!!", which is not a valid shot id/,
    );
    const plan = lenient(raw);
    expect(new Set(plan.shots.map((s) => s.artDirection)).size).toBe(1);
    expect(plan.shots[0].artDirection).toMatch(
      /^One photo shoot for the whole store/,
    );
    expect(plan.shots.find((s) => s.id === "mill-floor")?.subject).toContain(
      "Seeds in a wooden ghani",
    );
    expect(conf(plan.pages[1].sections[2]).image_url).toBe(
      slot("about-media-text"),
    );
  });

  it("summarises past the issue limit", () => {
    const raw = goodRaw();
    raw.pages[1].sections = Array.from({ length: 90 }, () => ({
      type: "video",
      configJson: "{}",
    }));
    const issues = strict(raw).issues;
    expect(issues).toHaveLength(81);
    expect(issues.at(-1)).toMatch(/more problems of the same kinds/);
  });
});

// ---------------------------------------------------------------------------
// What a plan carries over, for the charge (money-1).
// ---------------------------------------------------------------------------

describe("what a plan is built from and carries over (money-1)", () => {
  it("records what a full revamp was built from, carrying nothing over", () => {
    expect(strict(goodRaw()).plan!.basis).toEqual({
      categories: 3,
      categoryChanges: ["hide:fruits", "create:cold-pressed", "update:oils"],
      productKeys: ["p1", "p2"],
      existingProductKeys: [],
      carried: null,
    });
  });

  it("counts as the parent's only the category changes the parent made", () => {
    const previous = strict(goodRaw()).plan!;
    // ★ An applied parent's changes are on the store, so the chat tool sends
    //   only the merchant's new one: it is this version's work, not carried.
    const added = {
      action: "create" as const,
      name: "Seed Oils",
      slug: null,
      description: null,
      newPhoto: false,
    };
    const raw = goodRaw();
    raw.pages = raw.pages.filter((p: Raw) => p.slug === "about");
    const refined = (categories: RevampRequest["categories"]) =>
      lenient(raw, {
        request: {
          categories,
          kind: "refine",
          instruction: "Add a seed oils category.",
          refineScope: scopeOf({ pages: ["about"] }),
        },
        previous,
      }).basis!;
    const applied = refined([added]);
    expect(applied.categoryChanges).toEqual(["create:seed-oils"]);
    expect(applied.carried!.categories).toBe(0);
    // An unapplied parent's changes come first, then the new one.
    const unapplied = refined([...request().categories, added]);
    expect(unapplied.carried!.categories).toBe(3);
  });

  it("records what a refinement carries over unchanged", () => {
    const previous = strict(goodRaw()).plan!;
    const result = strict(goodRaw(), {
      request: {
        kind: "refine",
        instruction: "Redo the opening photo.",
        refineScope: scopeOf({
          design: false,
          copy: false,
          layout: false,
          products: false,
          photos: ["hero-mill"],
        }),
      },
      previous,
    });
    expect(result.issues).toEqual([]);
    expect(result.plan!.basis!.carried).toEqual({
      pages: ["", "about"],
      shots: previous.shots.map((s) => s.id).filter((id) => id !== "hero-mill"),
      design: true,
      chrome: true,
      categories: 3,
      products: ["p1", "p2"],
    });
  });

  it("tells the refinement's own additions apart from what the parent had", () => {
    const previous = strict(goodRaw()).plan!;
    const req = request();
    req.products.push({
      key: "p3",
      name: "Sesame Oil",
      description: "Sesame oil from our mill.",
      sizes: [{ label: "1 L", price: 299, mrp: null }],
      photoUrl: null,
      categorySlug: null,
    });
    req.categories.push({
      action: "create",
      name: "Seed Oils",
      slug: null,
      description: null,
      newPhoto: false,
    });
    const raw = goodRaw();
    raw.pages = raw.pages.filter((p: Raw) => p.slug === "about");
    raw.shots.push(
      shot("category-seed-oils", {
        purpose: "category",
        category: "seed-oils",
      }),
    );
    // A new accent and a new menu link: the look and the chrome are new work.
    raw.design.palette.accent = "#2f5f3a";
    raw.menus.header.push({ label: "Ghee", href: "/collections/ghee" });
    const result = strict(raw, {
      request: {
        ...req,
        kind: "refine",
        instruction: "Rewrite the about page.",
        refineScope: scopeOf({ pages: ["about"] }),
      },
      previous,
    });
    expect(result.issues).toEqual([]);
    expect(result.plan!.basis).toMatchObject({
      categories: 4,
      productKeys: ["p1", "p2", "p3"],
      carried: {
        // ★ The homepage is copied as it was; the About page is rewritten.
        pages: [""],
        design: false,
        chrome: false,
        categories: 3,
        products: ["p1", "p2"],
      },
    });
  });

  it("carries the parent's products by their copy when the parent recorded no basis", () => {
    const previous = strict(goodRaw()).plan!;
    delete previous.basis;
    const raw = goodRaw();
    raw.pages = raw.pages.filter((p: Raw) => p.slug === "about");
    const plan = strict(raw, {
      request: {
        kind: "refine",
        instruction: "Rewrite the about page.",
        refineScope: scopeOf({ pages: ["about"] }),
      },
      previous,
    }).plan!;
    expect(plan.basis!.carried).toMatchObject({
      categories: 0,
      products: ["p1", "p2"],
    });
  });
});

// ---------------------------------------------------------------------------
// A product the store already has (known-1b).
// ---------------------------------------------------------------------------

describe("a product the store already has (known-1b)", () => {
  const already = (): Over => {
    const req = request();
    req.products[0] = { ...req.products[0], name: "  groundnut OIL " };
    return { request: { products: req.products } };
  };

  it("is never a new product: no new address, no link to a copy of it", () => {
    expect(revampExistingProductKeys(input(already()))).toEqual(
      new Set(["p1"]),
    );
    expect(revampNewProductSlugs(input(already()))).toEqual(
      new Map([["p2", "desi-ghee"]]),
    );
    const targets = revampLinkTargets({
      ...input(already()),
      plan: { pages: [] },
    });
    expect(checkRevampLink("/shop/groundnut-oil", targets)).toBe(
      "/shop/groundnut-oil",
    );
    expect(checkRevampLink("/shop/groundnut-oil-2", targets)).toBeNull();
    expect(
      strict(goodRaw(), already()).plan!.basis!.existingProductKeys,
    ).toEqual(["p1"]);
  });

  it("matches only the merchant's own products, never a theme sample", () => {
    const req = request();
    req.products[0] = { ...req.products[0], name: "Banana (Sample)" };
    expect(
      revampExistingProductKeys(input({ request: { products: req.products } })),
    ).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// A storefront led by photographs (live-1).
// ---------------------------------------------------------------------------

describe("photographs (live-1)", () => {
  const shortOf = (issues: string[]) =>
    issues.filter((i) => /short of photographs/.test(i));

  /** A homepage of theme sections only, so nothing is refilled on it. */
  const plainHome = (): Over => {
    const snap = snapshot();
    return {
      snapshot: {
        pages: [
          page(
            "page-home",
            "",
            "Home",
            [
              sec("t-hero", "hero", {
                heading: "Fresh",
                image_url: THEME_PHOTO,
              }),
            ],
            { "t-hero": "theme" },
          ),
          snap.pages[1],
          snap.pages[2],
        ],
      },
    };
  };

  /** Two photographs on the homepage: one opening hero and one band. */
  const thinHome = (): Raw => {
    const raw = goodRaw();
    const home = homeOf(raw);
    raw.pages[0].sections = [
      carousel(["hero-mill"]),
      home[2],
      home[4],
      media(slot("mill-floor")),
      newsletter(),
    ];
    return raw;
  };

  it("asks once for more when the homepage shows fewer than three photographs outside product sections", () => {
    const raw = thinHome();
    // Enough shots in all: the About page carries a gallery of four.
    raw.pages[1].sections[1] = gallery(["a1", "a2", "a3", "a4"]);
    raw.shots.push(shot("a1"), shot("a2"), shot("a3"), shot("a4"));
    const result = strict(raw, plainHome());
    expect(result.issues).toHaveLength(1);
    expect(shortOf(result.issues)).toHaveLength(1);
    expect(result.issues[0]).toMatch(
      /the homepage shows 2 photographs outside product sections/,
    );
    expect(result.issues[0]).not.toMatch(/shots in all/);
    // ★ Never more than the repair budget: the finaliser takes the plan.
    const plan = lenient(raw, plainHome());
    expect(plan.notes.join(" ")).not.toMatch(/photograph/i);
  });

  it("asks once for more when the whole plan has fewer than eight shots", () => {
    const raw = goodRaw();
    raw.pages[1].sections.pop();
    const result = strict(raw);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatch(/short of photographs/);
    expect(result.issues[0]).toMatch(/the plan has 7 shots in all/);
  });

  it("says both in one sentence when both are short", () => {
    const result = strict(thinHome(), plainHome());
    expect(shortOf(result.issues)).toHaveLength(1);
    expect(shortOf(result.issues)[0]).toMatch(
      /2 photographs outside product sections[\s\S]*shots in all/,
    );
  });

  it("holds only a full redesign to it: a refinement and a named page are left alone", () => {
    const previous = strict(goodRaw()).plan!;
    const refined = strict(thinHome(), {
      ...plainHome(),
      request: {
        kind: "refine",
        instruction: "Make the homepage simpler.",
        refineScope: scopeOf({ pages: ["home"] }),
      },
      previous,
    });
    expect(shortOf(refined.issues)).toEqual([]);

    const raw = goodRaw();
    raw.pages = raw.pages.filter((p: Raw) => p.slug === "about");
    raw.pages[0].sections.pop();
    const named = strict(raw, { request: { pages: ["about"] } });
    expect(shortOf(named.issues)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A list's items, named in the repair sentence (output-1).
// ---------------------------------------------------------------------------

describe("list items the model mis-names (output-1)", () => {
  const sentenceFor = (issues: string[], where: RegExp) =>
    issues.find((issue) => where.test(issue)) ?? "";

  it("names a gallery's list and its item fields when every item was dropped", () => {
    const raw = goodRaw();
    raw.pages[1].sections[1] = {
      type: "gallery",
      configJson: cfg({
        heading: "At the mill",
        subheading: "",
        items: [{ image: slot("about-press") }, { image: slot("about-jars") }],
        layout: "grid",
        columns: 3,
        image_ratio: "square",
      }),
    };
    const sentence = sentenceFor(
      strict(raw).issues,
      /Page "about" section 2 \(gallery\)/,
    );
    expect(sentence).toMatch(/Add at least two gallery images/);
    expect(sentence).toMatch(/config\.items/);
    expect(sentence).toMatch(/image_url, image_alt, caption, href/);
    expect(sentence).toContain(`${REVAMP_SLOT_PREFIX}<shot id>`);
  });

  it("says which key a tile grid's tiles go under when they were written as items", () => {
    const raw = goodRaw();
    raw.pages[1].sections.push({
      type: "tile_grid",
      configJson: cfg({
        heading: "Shop the range",
        subheading: "",
        items: [
          { title: "Oils", image_url: slot("about-press"), href: "/shop" },
        ],
        columns: 3,
        height: "md",
      }),
    });
    const { issues } = strict(raw);
    const sentence = sentenceFor(
      issues,
      /Page "about" section 3 \(tile_grid\): Add at least one tile/,
    );
    expect(sentence).toMatch(/config\.tiles \(not config\.items\)/);
    expect(sentence).toMatch(
      /title, subtitle, href, image_url, background, theme/,
    );
    // ★ Not the misleading "leave it empty" a photo under a wrong key got.
    expect(issues.join("\n")).not.toMatch(/cannot hold a new photograph/);
  });

  it("adds nothing to a section that holds no list", () => {
    const raw = goodRaw();
    raw.pages[1].sections.push({
      type: "promo_banner",
      configJson: cfg({ heading: "", image_url: "" }),
    });
    const sentence = sentenceFor(
      strict(raw).issues,
      /Page "about" section 3 \(promo_banner\)/,
    );
    expect(sentence).toMatch(/Add an image or a heading for the banner/);
    expect(sentence).not.toMatch(/Its list is/);
  });

  it("tells the photo floor that a shot counts only when an image field names it", () => {
    const raw = goodRaw();
    raw.pages[1].sections.pop();
    const [issue] = strict(raw).issues;
    expect(issue).toMatch(/short of photographs/);
    expect(issue).toMatch(
      /a tile_grid whose tiles, or a multicolumn whose items, each have a photo/,
    );
    expect(issue).toMatch(/a shot counts only when an image field names it/);
  });
});

describe("the product band's products (output-5)", () => {
  type Product = RevampSnapshot["products"][number] & { featured?: boolean };
  const product = (id: string, over: Partial<Product> = {}): Product => ({
    id,
    name: `Oil ${id}`,
    slug: `oil-${id}`,
    status: "published",
    updatedAt: "t",
    sample: false,
    imageUrl: null,
    categoryId: "c2",
    ...over,
  });
  /** The store's own catalogue, the theme's sample first (the read's order). */
  const catalogue = (over: Record<string, Partial<Product>> = {}) => [
    product("x1", {
      name: "Banana (Sample)",
      slug: "banana",
      sample: true,
      featured: true,
      ...over.x1,
    }),
    product("x2", { name: "Groundnut Oil", ...over.x2 }),
    product("x3", { name: "Old Oil", status: "draft", ...over.x3 }),
    product("x4", { name: "Sesame Oil", ...over.x4 }),
  ];
  /** The clean answer, with no product of the merchant's to write copy for. */
  const noNewProducts = (): Raw => ({ ...goodRaw(), productCopy: [] });
  const band = (raw: Raw, over: Over) => {
    const result = strict(raw, over);
    expect(result.issues).toEqual([]);
    return conf(section(result.plan!, "s2"));
  };

  it("★★ names the store's own published products when it creates none and none is featured", () => {
    const over: Over = {
      request: { products: [] },
      snapshot: { products: catalogue() },
    };
    expect(band(noNewProducts(), over)).toMatchObject({
      source: "manual",
      product_ids: ["x2", "x4"],
      category_id: null,
    });
  });

  it("names no more than the band's limit, in the catalogue's order", () => {
    const raw = noNewProducts();
    editConfig(homeOf(raw)[2], (c) => {
      c.limit = 1;
    });
    const over: Over = {
      request: { products: [] },
      snapshot: { products: catalogue() },
    };
    expect(band(raw, over)).toMatchObject({
      source: "manual",
      product_ids: ["x2"],
    });
  });

  it('keeps "featured" when one of the store\'s own products is featured', () => {
    const over: Over = {
      request: { products: [] },
      snapshot: { products: catalogue({ x4: { featured: true } }) },
    };
    expect(band(noNewProducts(), over)).toMatchObject({
      source: "featured",
      product_ids: [],
    });
  });

  it('keeps "featured" when the redesign creates products (Apply features them)', () => {
    expect(
      band(goodRaw(), { snapshot: { products: catalogue() } }),
    ).toMatchObject({ source: "featured", product_ids: [] });
  });
});

describe("the storefront's own pages as link targets (output-6)", () => {
  const targets = () =>
    revampLinkTargets({
      request: request(),
      snapshot: snapshot(),
      plan: { pages: [] },
    });

  it("★★ accepts the blog and the enquiry form, which every store serves", () => {
    expect(REVAMP_STOREFRONT_ROUTES).toEqual(["/blogs", "/enquiries"]);
    expect(checkRevampLink("/blogs", targets())).toBe("/blogs");
    expect(checkRevampLink("/Enquiries/", targets())).toBe("/enquiries");
  });

  it("never takes a post it cannot see, or a near miss", () => {
    expect(checkRevampLink("/blogs/first-harvest", targets())).toBeNull();
    expect(checkRevampLink("/blogsx", targets())).toBeNull();
    expect(checkRevampLink("/blogs?tag=oil", targets())).toBeNull();
  });

  it("keeps Blog and Enquiries in the menus the model writes, with no repair", () => {
    const raw = goodRaw();
    raw.menus.header.push({ label: "Blog", href: "/blogs", children: [] });
    raw.menus.footerGroups.push({
      title: "Help",
      links: [{ label: "Enquiries", href: "/enquiries" }],
    });
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    expect(result.plan!.menus.header.map((link: Raw) => link.href)).toContain(
      "/blogs",
    );
    expect(
      result
        .plan!.menus.footerGroups.flatMap((group: Raw) => group.links)
        .map((link: Raw) => link.href),
    ).toContain("/enquiries");
  });

  it("names them in the repair sentence for a link that goes nowhere", () => {
    const raw = goodRaw();
    raw.menus.header.push({ label: "Press", href: "/press", children: [] });
    const sentence = strict(raw).issues.find((s) => s.includes('"/press"'));
    expect(sentence).toMatch(/"\/blogs", "\/enquiries"/);
  });

  it("knows the routes the storefront always serves, for links the merchant already has", () => {
    for (const href of [
      "/blogs",
      "/blogs/first-harvest",
      "/enquiries",
      "/cart",
      "/orders",
      "/profile",
      "/notifications",
    ]) {
      expect(revampAlwaysServedLink(href)).toBe(true);
    }
    for (const href of [
      "/shop/banana",
      "/collections/fruits",
      "/about",
      "//blogs",
      "https://example.com/blogs",
      "",
    ]) {
      expect(revampAlwaysServedLink(href)).toBe(false);
    }
  });
});

describe("the scheme cap and the merchant's kept sections (output-7)", () => {
  const schemed = (id: string, scheme: string): PageSectionItem =>
    ({
      ...sec(id, "rich_text", { html: `<p>Words of ${id}.</p>` }),
      style: { scheme },
    }) as unknown as PageSectionItem;

  /** The homepage with the merchant's own sections, each in a scheme. */
  function storeWith(schemes: Record<string, string>): Over["snapshot"] {
    const snap = snapshot();
    const home = snap.pages[0];
    const extra = Object.entries(schemes).map(([id, scheme]) =>
      schemed(id, scheme),
    );
    return {
      pages: [
        {
          ...home,
          sections: [...home.sections, ...extra],
          owners: {
            ...home.owners,
            ...Object.fromEntries(extra.map((s) => [s.id, "merchant"])),
          },
        },
        ...snap.pages.slice(1),
      ],
    };
  }

  /** The clean answer keeping those sections, its own bands as `styles` say. */
  function answer(
    kept: string[],
    styles: { products?: Raw; categories?: Raw; newsletter?: Raw } = {},
  ): Raw {
    const raw = goodRaw();
    const home = homeOf(raw);
    const products = { ...home[2], style: styles.products };
    const categories = { ...home[4], style: styles.categories };
    const closing = { ...home[7], style: styles.newsletter };
    if (!styles.products) delete products.style;
    if (!styles.categories) delete categories.style;
    if (!styles.newsletter) delete closing.style;
    raw.pages[0].sections = [
      home[0],
      home[1],
      products,
      home[3],
      ...(kept[0] ? [{ keep: kept[0] }] : []),
      categories,
      ...(kept[1] ? [{ keep: kept[1] }] : []),
      home[5],
      ...(kept[2] ? [{ keep: kept[2] }] : []),
      home[6],
      ...(kept[3] ? [{ keep: kept[3] }] : []),
      closing,
    ];
    return raw;
  }

  const KEPT4 = {
    "m-a": "soft",
    "m-b": "tint",
    "m-c": "accent",
    "m-d": "inverse",
  };

  it("★★ asks for nothing when only the merchant's kept sections wear the schemes", () => {
    const over: Over = { snapshot: storeWith(KEPT4) };
    const result = strict(answer(Object.keys(KEPT4)), over);
    expect(result.issues.join("\n")).not.toMatch(/colour scheme/);
    expect(result.issues).toEqual([]);
    const plan = result.plan!;
    expect(
      plan.pages[0].sections.filter((s) => s.style?.scheme).map((s) => s.id),
    ).toEqual(["m-a", "m-b", "m-c", "m-d"]);
  });

  it("silently trims a new scheme past the room left by merchant sections", () => {
    const over: Over = { snapshot: storeWith(KEPT4) };
    const raw = answer(Object.keys(KEPT4), {
      products: { scheme: "soft", padding: "md" },
    });
    const result = strict(raw, over);
    expect(result.issues).toEqual([]);
    const plan = result.plan!;
    expect(section(plan, "s2").style?.scheme).toBeUndefined();
  });

  it("counts only the room the kept sections leave", () => {
    const over: Over = {
      snapshot: storeWith({ "m-a": "soft", "m-b": "accent" }),
    };
    const raw = answer(["m-a", "m-b"], {
      products: { scheme: "tint", padding: "md" },
      categories: { scheme: "inverse", padding: "md" },
    });
    const result = strict(raw, over);
    expect(result.issues).toEqual([]);
    const plan = result.plan!;
    const left = plan.pages[0].sections.filter((s) => s.style?.scheme);
    expect(left.map((s) => s.id)).toEqual(["s2", "m-a", "m-b"]);
  });
});

// ---------------------------------------------------------------------------
// ★★ Distinct by default (prompt v5; robustness audit, section 5, steps 1
//    and 3). Every rule below applies only to an answer that names prompt
//    v5; an answer planned under v4 names none and compiles as it always did.
// ---------------------------------------------------------------------------

const V5 = "mink-revamp-site-v5";
const asV5 = (raw: Raw): Raw => ({ ...raw, promptVersion: V5 });
/** Sixteen redesigns of the same store: the seed moves with the redesign id. */
const REDESIGNS = Array.from({ length: 16 }, (_, i) => `revamp-${i + 1}`);
const finalizeFor = (raw: Raw, revampId?: string, over: Over = {}) =>
  finalizeRevampSite(raw, { ...input(over), revampId }, { newId: ids() });
const valuesOver = <T>(make: (revampId: string) => T): Set<string> =>
  new Set(REDESIGNS.map((id) => JSON.stringify(make(id))));

/** An answer that leaves out every choice a compiler fallback fills. */
function sparseRaw(): Raw {
  const raw = goodRaw();
  raw.direction = "";
  raw.industry = "home";
  raw.newsletter = { heading: "", subtext: "", buttonLabel: "" };
  raw.menus.header = [];
  raw.pages[0].sections = homeOf(raw).filter(
    (s: Raw) => s.type !== "hero_carousel",
  );
  raw.pages[0].seoDescription = "";
  raw.shots = raw.shots.map((s: Raw) => ({ ...s, artDirection: "" }));
  return raw;
}

/** An About page whose sections leave out every setting they choose. */
function bareChoicesRaw(): Raw {
  const raw = goodRaw();
  raw.pages[1].sections = [
    {
      type: "media_text",
      configJson: cfg({
        heading: "How we press",
        body: "Seeds turn slowly in a wooden ghani.",
        image_url: slot("about-press"),
        image_alt: "The press",
        stories: [
          {
            heading: "The seeds",
            body: "Groundnut and mustard seeds.",
            image_url: slot("about-jars"),
            image_alt: "Seeds",
          },
          {
            heading: "The oil",
            body: "Poured into bottles.",
            image_url: slot("story-oil"),
            image_alt: "Oil",
          },
        ],
      }),
    },
    {
      type: "gallery",
      configJson: cfg({
        heading: "At the mill",
        items: [
          { image_url: slot("g1"), image_alt: "The mill" },
          { image_url: slot("g2"), image_alt: "The seeds" },
        ],
      }),
    },
    {
      type: "usp_bar",
      configJson: cfg({
        items: [
          { title: "Delivered across Punjab", subtitle: "" },
          { title: "Cash on delivery", subtitle: "" },
          { title: "Pressed in Ludhiana", subtitle: "" },
        ],
        theme: "light",
      }),
    },
    {
      type: "faq_accordion",
      configJson: cfg({
        heading: "Questions",
        items: [{ question: "Do you deliver?", answer: "Across Punjab." }],
      }),
    },
    {
      type: "accordion",
      configJson: cfg({
        heading: "Care",
        items: [
          {
            heading: "Storage",
            body: "Keep it cool.",
            image_url: slot("a1"),
            image_alt: "A jar",
          },
          { heading: "Use", body: "Use it within a year." },
        ],
      }),
    },
    {
      type: "multicolumn",
      configJson: cfg({
        heading: "The mill",
        items: [
          {
            heading: "Seeds",
            body: "Chosen with care.",
            image_url: slot("m1"),
            image_alt: "Seeds",
          },
        ],
      }),
    },
    {
      type: "image_marquee",
      configJson: cfg({
        items: [
          { image_url: slot("q1"), image_alt: "The press" },
          { image_url: slot("q2"), image_alt: "The bottles" },
        ],
      }),
    },
    {
      type: "rich_text",
      configJson: cfg({ html: "<p>We press oil in Ludhiana.</p>" }),
    },
  ];
  raw.shots = [
    ...raw.shots,
    ...["story-oil", "g1", "g2", "a1", "m1", "q1", "q2"].map((id) => shot(id)),
  ];
  return raw;
}

const aboutSection = (plan: RevampSitePlan, type: string): Raw =>
  conf(
    plan.pages
      .find((p) => p.slug === "about")!
      .sections.find((s) => s.type === type)!,
  );

describe("prompt v5: a v4 answer compiles exactly as before", () => {
  it("★★ keeps every global fallback for an answer that names no prompt version", () => {
    const plan = lenient(sparseRaw());
    expect(plan.direction).toBe("classic-and-trusted");
    expect(plan.newsletter).toEqual({
      heading: "Stay in touch",
      subtext: "News from Ghani Oils by email.",
      buttonLabel: "Subscribe",
    });
    expect(plan.menus.header).toEqual([{ label: "Shop", href: "/shop" }]);
    const opening = conf(plan.pages[0].sections[0]);
    expect(opening).toMatchObject({
      variant: "fullbleed",
      height: "large",
      cta_label: "Shop now",
      theme: "light",
      alignment: "left",
    });
    expect(plan.pages[0].seoDescription).toBe(
      "Ghani Oils. Browse the shop and find out more.",
    );
    for (const s of plan.shots) {
      expect(s.artDirection).toMatch(
        /^One photo shoot for the whole store: the same light/,
      );
    }
  });

  it("★★ keeps the validator's defaults for the settings a v4 answer left out, and its own words", () => {
    const raw = bareChoicesRaw();
    const plan = lenient(raw);
    expect(aboutSection(plan, "media_text")).toMatchObject({
      media_position: "left",
      media_ratio: "portrait",
      alignment: "left",
    });
    expect(
      aboutSection(plan, "media_text").stories.map(
        (s: Raw) => s.media_position,
      ),
    ).toEqual(["left", "left"]);
    expect(aboutSection(plan, "gallery")).toMatchObject({
      layout: "editorial",
      columns: 3,
      image_ratio: "portrait",
    });
    expect(aboutSection(plan, "usp_bar").theme).toBe("light");
    expect(aboutSection(plan, "usp_bar").items.map((i: Raw) => i.icon)).toEqual(
      ["star", "star", "star"],
    );
    expect(aboutSection(plan, "accordion")).toMatchObject({
      open_first: true,
      allow_multiple: false,
    });
    expect(aboutSection(plan, "rich_text").width).toBe("contained");
    // A v4 answer's soft-and-natural near-white page stays as it was.
    expect(lenient(goodRaw()).design.palette).toEqual(PALETTE);
  });

  it("keeps the words of a v4 answer that happen to read like an instruction", () => {
    const raw = goodRaw();
    homeOf(raw)[5] = media(slot("mill-floor"), {
      heading: "write in English: a heading in this store's own words",
    });
    const plan = strict(raw).plan!;
    expect(conf(section(plan, "s4")).heading).toBe(
      "write in English: a heading in this store's own words",
    );
  });
});

describe("prompt v5: a choice left out is picked for the store (step 1)", () => {
  it("★★ fills every fallback from its closed list, picked per redesign, never one value for all", () => {
    const plans = REDESIGNS.map((id) => finalizeFor(asV5(sparseRaw()), id));
    const N = REVAMP_NEUTRAL_COPY;
    for (const plan of plans) {
      // The direction fits the page the answer chose, and the store's trade.
      expect(["magazine-editorial", "classic-and-trusted"]).toContain(
        plan.direction,
      );
      expect(revampPageFitsDirection(plan.direction, PALETTE.cream)).toBe(true);
      expect(N.newsletterHeading).toContain(plan.newsletter.heading);
      expect(
        N.newsletterSubtext.map((l) => revampNeutralLine(l, "Ghani Oils")),
      ).toContain(plan.newsletter.subtext);
      expect(N.newsletterButton).toContain(plan.newsletter.buttonLabel);
      expect(N.shopLink).toContain(plan.menus.header[0].label);
      expect(plan.menus.header[0].href).toBe("/shop");
      const opening = conf(plan.pages[0].sections[0]);
      expect(N.openingCta).toContain(opening.cta_label);
      expect(["light", "dark"]).toContain(opening.theme);
      expect(["left", "center"]).toContain(opening.alignment);
      expect(["large", "screen"]).toContain(opening.height);
      expect(
        N.seoTail.some((tail) => plan.pages[0].seoDescription.endsWith(tail)),
      ).toBe(true);
      // ★★ No light picked for the store: a photo look varied across
      //   stores is step 9, which waits for the owner (review fix, 25 Oct).
      expect(plan.shots[0].artDirection).toMatch(
        /^One photo shoot for the whole store: the same light, palette and setting in every picture, in a /,
      );
    }
    const spread = (pickOut: (plan: RevampSitePlan) => unknown) =>
      new Set(plans.map((plan) => JSON.stringify(pickOut(plan)))).size;
    expect(spread((p) => p.direction)).toBe(2);
    expect(spread((p) => p.newsletter.heading)).toBeGreaterThan(2);
    expect(spread((p) => p.menus.header[0].label)).toBeGreaterThan(1);
    expect(
      spread((p) => conf(p.pages[0].sections[0]).cta_label),
    ).toBeGreaterThan(2);
    expect(spread((p) => conf(p.pages[0].sections[0]).height)).toBe(2);
    // The default art direction follows the direction alone, never a light
    // picked for the store.
    expect(spread((p) => p.shots[0].artDirection)).toBe(
      spread((p) => p.direction),
    );
    expect(spread((p) => p.pages[0].seoDescription)).toBeGreaterThan(2);
  });

  it("picks the opening's height for the store when the answer's cannot open a homepage", () => {
    // "medium" is a carousel's height elsewhere, never the opening's.
    const raw = asV5(goodRaw());
    homeOf(raw)[0] = editConfig(
      carousel(["hero-mill", "hero-bottles"]),
      (c) => {
        c.height = "medium";
      },
    );
    const heights = new Set(
      REDESIGNS.map(
        (id) => conf(finalizeFor(raw, id).pages[0].sections[0]).height,
      ),
    );
    expect(heights).toEqual(new Set(["large", "screen"]));
    // A v4 answer's opening is "large", as it always was.
    const v4 = goodRaw();
    homeOf(v4)[0] = editConfig(carousel(["hero-mill", "hero-bottles"]), (c) => {
      c.height = "medium";
    });
    expect(conf(lenient(v4).pages[0].sections[0]).height).toBe("large");
  });

  it("★ picks a left-out direction the page fits: a near-white food shop is never soft-and-natural", () => {
    const raw = asV5(sparseRaw());
    raw.industry = "food-and-drink";
    for (const id of REDESIGNS) {
      // Of the food directions only dense-catalogue paints a near-white page.
      expect(finalizeFor(raw, id).direction).toBe("dense-catalogue");
    }
  });

  it("★★ picks every section setting the answer left out from its closed list", () => {
    const plans = REDESIGNS.map((id) =>
      finalizeFor(asV5(bareChoicesRaw()), id),
    );
    const check = (type: string, keys: string[]) => {
      const choices = REVAMP_SECTION_CHOICES[type as never] as {
        fields: Record<string, { options: readonly unknown[] }>;
      };
      for (const key of keys) {
        const seen = new Set(
          plans.map((plan) => aboutSection(plan, type)[key]),
        );
        for (const value of seen) {
          expect(choices.fields[key].options, `${type}.${key}`).toContain(
            value,
          );
        }
        expect(seen.size, `${type}.${key}`).toBeGreaterThan(1);
      }
    };
    check("media_text", ["media_position", "media_ratio", "alignment"]);
    check("gallery", ["layout", "columns", "image_ratio"]);
    check("faq_accordion", ["show_filters"]);
    check("accordion", ["open_first", "allow_multiple"]);
    check("multicolumn", ["columns", "alignment", "image_ratio"]);
    check("image_marquee", ["speed", "size", "image_ratio"]);
    check("rich_text", ["width"]);
  });

  it("varies with the store as well as with the redesign, the same for the same pair", () => {
    const plan = (storeId: string, revampId?: string) =>
      finalizeRevampSite(
        asV5(bareChoicesRaw()),
        {
          ...input({ snapshot: { storeId } }),
          revampId,
        },
        { newId: ids() },
      );
    const gallery = (p: RevampSitePlan) =>
      JSON.stringify(aboutSection(p, "gallery"));
    expect(gallery(plan("store-9", "r-1"))).toBe(
      gallery(plan("store-9", "r-1")),
    );
    const stores = new Set(
      ["store-2", "store-3", "store-4", "store-5", "store-6"].map((id) =>
        gallery(plan(id)),
      ),
    );
    expect(stores.size).toBeGreaterThan(1);
  });

  it("alternates a story's side with its band, makes a row with a photo an image row, and gives a trust bar item the icon its words name", () => {
    for (const id of REDESIGNS.slice(0, 6)) {
      const plan = finalizeFor(asV5(bareChoicesRaw()), id);
      const story = aboutSection(plan, "media_text");
      const other = story.media_position === "left" ? "right" : "left";
      expect(story.stories.map((s: Raw) => s.media_position)).toEqual([
        other,
        story.media_position,
      ]);
      expect(
        aboutSection(plan, "accordion").items.map((i: Raw) => i.type),
      ).toEqual(["image", "text"]);
      const icons = aboutSection(plan, "usp_bar").items.map((i: Raw) => i.icon);
      expect(icons.slice(0, 2)).toEqual(["truck", "shield"]);
      expect(["star", "sparkles", "heart"]).toContain(icons[2]);
    }
  });

  it("keeps a choice the answer made, read as it was meant", () => {
    const raw = asV5(bareChoicesRaw());
    raw.pages[1].sections[1] = {
      type: "gallery",
      configJson: cfg({
        heading: "At the mill",
        items: [
          { image_url: slot("g1"), image_alt: "The mill" },
          { image_url: slot("g2"), image_alt: "The seeds" },
        ],
        layout: "Grid",
        columns: "2",
        image_ratio: "landscape",
      }),
    };
    raw.pages[1].sections.push({
      type: "hero_carousel",
      configJson: cfg({
        slides: [
          { heading: "One", image_url: slot("c1"), theme: "light" },
          { heading: "Two", image_url: slot("c2"), theme: "light" },
        ],
        autoplay: "false",
        interval_seconds: 3,
        height: "small",
      }),
    });
    raw.shots.push(shot("c1"), shot("c2"));
    for (const id of REDESIGNS.slice(0, 4)) {
      const plan = finalizeFor(raw, id);
      expect(aboutSection(plan, "gallery")).toMatchObject({
        layout: "grid",
        columns: 2,
        image_ratio: "landscape",
      });
      expect(aboutSection(plan, "hero_carousel")).toMatchObject({
        autoplay: false,
        interval_seconds: 3,
        height: "small",
      });
    }
  });

  it("reads a copied 'choose one: ...' as a choice left out", () => {
    const raw = asV5(bareChoicesRaw());
    raw.pages[1].sections[1] = {
      type: "gallery",
      configJson: cfg({
        heading: "At the mill",
        items: [
          { image_url: slot("g1"), image_alt: "The mill" },
          { image_url: slot("g2"), image_alt: "The seeds" },
        ],
        layout: "choose one: grid or editorial",
        columns: "choose one: 2, 3 or 4",
        image_ratio: "choose one: portrait, square or landscape",
      }),
    };
    const seen = new Set(
      REDESIGNS.map(
        (id) => aboutSection(finalizeFor(raw, id), "gallery").layout,
      ),
    );
    expect(seen).toEqual(new Set(["grid", "editorial"]));
  });

  it("picks a newsletter section's button and thank-you line when the answer left them out", () => {
    const raw = asV5(goodRaw());
    homeOf(raw)[7] = editConfig(newsletter(), (c) => {
      c.button_label = "";
      c.success_message = "";
    });
    const plans = REDESIGNS.map((id) => finalizeFor(raw, id));
    const letters = plans.map((plan) => conf(section(plan, "s5")));
    for (const letter of letters) {
      expect(REVAMP_NEUTRAL_COPY.newsletterButton).toContain(
        letter.button_label,
      );
      expect(REVAMP_NEUTRAL_COPY.newsletterThanks).toContain(
        letter.success_message,
      );
    }
    expect(new Set(letters.map((l) => l.button_label)).size).toBeGreaterThan(1);
    // A v4 answer keeps the validator's one line for every store.
    const v4 = goodRaw();
    homeOf(v4)[7] = editConfig(newsletter(), (c) => {
      c.button_label = "";
      c.success_message = "";
    });
    expect(conf(section(lenient(v4), "s5"))).toMatchObject({
      button_label: "Subscribe",
      success_message: "You're on the list - thank you.",
    });
  });
});

describe("prompt v5: words on a plain field follow the field", () => {
  const withSections = (sections: Raw[], over: Over = {}) => {
    const raw = asV5(goodRaw());
    raw.pages[1].sections = [rich("<p>About the mill.</p>"), ...sections];
    raw.shots.push(shot("t1"), shot("h1"), shot("b1"));
    return lenient(raw, over).pages.find((p) => p.slug === "about")!.sections;
  };
  const sections = [
    {
      type: "usp_bar",
      configJson: cfg({
        items: [{ icon: "truck", title: "Across Punjab", subtitle: "" }],
        theme: "light",
      }),
    },
    {
      type: "ticker",
      configJson: cfg({ messages: ["Pressed in Ludhiana"], theme: "light" }),
    },
    {
      type: "hero",
      configJson: cfg({
        variant: "split",
        heading: "The mill",
        image_url: slot("h1"),
        theme: "light",
        alignment: "left",
        height: "medium",
      }),
    },
    {
      type: "tile_grid",
      configJson: cfg({
        tiles: [
          { title: "Oils", href: "/shop", image_url: "", theme: "light" },
          {
            title: "Seeds",
            href: "/shop",
            image_url: slot("t1"),
            theme: "light",
          },
        ],
        columns: 2,
        height: "md",
      }),
    },
    {
      type: "promo_banner",
      configJson: cfg({ heading: "From our mill", theme: "light" }),
    },
  ];

  it("★★ holds strips, plain heroes, plain tiles and plain banners to the page", () => {
    const out = withSections(sections);
    const of = (type: string) => conf(out.find((s) => s.type === type)!);
    expect(of("usp_bar").theme).toBe("dark");
    expect(of("ticker").theme).toBe("dark");
    expect(of("hero").theme).toBe("dark");
    expect(of("tile_grid").tiles.map((t: Raw) => t.theme)).toEqual([
      "dark",
      "light",
    ]);
    expect(of("promo_banner").theme).toBe("dark");
  });

  it("holds a split carousel's slides and a hero on its own dark field to their fields", () => {
    const out = withSections([
      {
        type: "hero_carousel",
        configJson: cfg({
          slides: [
            { heading: "One", image_url: slot("t1"), theme: "light" },
            { heading: "Two", image_url: slot("h1"), theme: "light" },
          ],
          layout: "split",
          height: "medium",
        }),
      },
      {
        type: "hero",
        configJson: cfg({
          variant: "banner",
          heading: "The mill",
          image_url: slot("b1"),
          background: "#222222",
          theme: "dark",
          alignment: "left",
          height: "medium",
        }),
      },
    ]);
    const slides = conf(out.find((s) => s.type === "hero_carousel")!).slides;
    expect(slides.map((s: Raw) => s.theme)).toEqual(["dark", "dark"]);
    expect(conf(out.find((s) => s.type === "hero")!).theme).toBe("light");
  });

  it("keeps the colour chosen for words over a photograph", () => {
    const out = withSections([
      {
        type: "hero",
        configJson: cfg({
          variant: "fullbleed",
          heading: "The mill",
          image_url: slot("h1"),
          theme: "light",
          alignment: "left",
          height: "large",
        }),
      },
      {
        type: "promo_banner",
        configJson: cfg({
          heading: "From our mill",
          image_url: slot("b1"),
          theme: "light",
          alignment: "left",
        }),
      },
    ]);
    expect(conf(out.find((s) => s.type === "hero")!).theme).toBe("light");
    expect(conf(out.find((s) => s.type === "promo_banner")!).theme).toBe(
      "light",
    );
  });

  it("gives light words to a dark theme's page", () => {
    const dark = snapshot();
    dark.theme = {
      ...dark.theme,
      palette: {
        page: "#121212",
        surface: "#1c1c1c",
        ink: "#f2f2f2",
        accent: "#c9a227",
      },
    };
    const out = withSections(sections.slice(0, 1), { snapshot: dark });
    expect(conf(out.find((s) => s.type === "usp_bar")!).theme).toBe("light");
    expect(revampTextThemeFor("", "#121212")).toBe("light");
    expect(revampTextThemeFor("#f4e3a1", "#121212")).toBe("dark");
    expect(revampTextThemeFor(null, "not a colour")).toBe("dark");
  });
});

describe("prompt v5: a copied instruction is never the store's words", () => {
  const instructed = (): Raw => {
    const raw = asV5(goodRaw());
    homeOf(raw)[5] = media(slot("mill-floor"), {
      heading: "write in English: a heading in this store's own words",
    });
    raw.pages[1].sections[0] = rich(
      "<p>write in English: paragraphs in this store's own words</p><p>We press oil in Ludhiana.</p>",
    );
    return raw;
  };

  it("★★ asks for the store's own words in a strict compile, and never publishes the instruction", () => {
    const result = strict(instructed());
    expect(result.plan).toBeNull();
    expect(result.issues.join("\n")).toMatch(
      /config\.heading starts with an example's instruction \("write in English:"\)\. Write this store's own words in its place/,
    );
    const plan = lenient(instructed());
    expect(conf(section(plan, "s4")).heading).toBe("");
    expect(conf(plan.pages[1].sections[0]).html).toBe(
      "<p>We press oil in Ludhiana.</p>",
    );
    expect(JSON.stringify(plan)).not.toMatch(/write in English/);
  });
});

describe("prompt v5: a copied instruction's issue quotes no store words (review fix, 25 Oct)", () => {
  it("★★ names the field and the instruction, never what was written after it", () => {
    const raw = asV5(goodRaw());
    const words =
      "A crusty loaf with a soft, open crumb, fermented for 24 hours";
    raw.productCopy = [
      { key: "p1", description: `write in English: ${words}` },
    ];
    homeOf(raw)[5] = media(slot("mill-floor"), {
      heading: "Choose one: Ghani Oils presses mustard oil in Ludhiana",
    });
    const issues = strict(raw).issues;
    const copied = issues.filter((i) => /example's instruction/.test(i));
    expect(copied).toHaveLength(2);
    expect(copied).toContain(
      `productCopy[0] (p1) description starts with an example's instruction ("write in English:"). Write this store's own words in its place, from the merchant's facts.`,
    );
    expect(copied.some((i) => i.includes('("choose one:")'))).toBe(true);
    for (const issue of copied) {
      for (const word of [
        "crusty",
        "fermented",
        "Ghani",
        "Ludhiana",
        "mustard",
      ]) {
        expect(issue).not.toContain(word);
      }
    }
  });

  it("reads the instruction's own words, nothing else", () => {
    expect(revampExampleInstructionPrefix("  Write in English:  x")).toBe(
      "write in English:",
    );
    expect(
      revampExampleInstructionPrefix("write in the brief's language: y"),
    ).toBe("write in the brief's language:");
    expect(revampExampleInstructionPrefix("choose  one : z")).toBe(
      "choose one:",
    );
    expect(revampExampleInstructionPrefix("write: z")).toBe("write:");
    expect(revampExampleInstructionPrefix("Our own words")).toBe("");
  });
});

describe("prompt v5: palette honesty, the page fits the direction (step 3)", () => {
  const fitted = (direction: string, palette = PALETTE, over: Over = {}) => {
    const raw = asV5(goodRaw());
    raw.direction = direction;
    raw.design.palette = { ...palette };
    return lenient(raw, over).design.palette;
  };

  it("★★ moves a near-white page toward the store's accent until it is the field soft-and-natural names", () => {
    const palette = fitted("soft-and-natural");
    expect(colourBand(PALETTE.cream)).toBe("near-white");
    expect(colourBand(palette.cream!)).not.toBe("near-white");
    expect(revampPageFitsDirection("soft-and-natural", palette.cream!)).toBe(
      true,
    );
    // Only the page colour moved, and the least that fits.
    expect(without(palette, "cream")).toEqual(without(PALETTE, "cream"));
    let least = 0;
    for (let w = 5; w <= 60; w += 5) {
      if (
        revampPageFitsDirection(
          "soft-and-natural",
          mixHex(PALETTE.accent, PALETTE.cream, w),
        )
      ) {
        least = w;
        break;
      }
    }
    expect(palette.cream).toBe(mixHex(PALETTE.accent, PALETTE.cream, least));
    // The rules are not relaxed.
    expect(
      contrastIssuesFor(
        { palette, fonts: { body: null, display: null }, shape: {} },
        { palette: {} },
      ),
    ).toEqual([]);
    expect(isLightColour(palette.cream!)).toBe(true);
  });

  it("mends the muted text the move leaves unreadable, and keeps the moved page", () => {
    // Reads on the near-white page (5.4:1) and its soft band (4.6:1), not on
    // the sage page the direction asks for (4.4:1).
    const palette = fitted("soft-and-natural", {
      ...PALETTE,
      inkSoft: "#6c655c",
    });
    expect(revampPageFitsDirection("soft-and-natural", palette.cream!)).toBe(
      true,
    );
    expect(palette.inkSoft).not.toBe("#6c655c");
    expect(
      contrastRatio(palette.inkSoft!, palette.cream!),
    ).toBeGreaterThanOrEqual(DESIGN_MIN_CONTRAST);
    expect(without(without(palette, "cream"), "inkSoft")).toEqual(
      without(without(PALETTE, "cream"), "inkSoft"),
    );
  });

  it("colours the page itself for a colour-field direction", () => {
    const palette = fitted("playful-and-colourful");
    expect(colourBand(palette.cream!)).toMatch(/^(colour|tinted|dark):/);
    expect(
      revampPageFitsDirection("playful-and-colourful", palette.cream!),
    ).toBe(true);
  });

  it("leaves a page alone that its direction already fits", () => {
    expect(fitted("classic-and-trusted")).toEqual(PALETTE);
    expect(fitted("luxury-minimal")).toEqual(PALETTE);
    const sage = { ...PALETTE, cream: "#dfe5d6", creamDeep: "#d2dac6" };
    expect(fitted("soft-and-natural", sage)).toEqual(sage);
  });

  it("never turns a page from light to dark, and keeps the palette when nothing fits and reads", () => {
    const fallback = { cream: "#fbf8f1", surface: "#ffffff", ink: "#1f1d1a" };
    // An accent as pale as the page cannot tint it: nothing moves.
    const pale = { ...PALETTE, accent: "#fdfcf9" };
    expect(
      fitRevampPageToDirection(pale, fallback, "soft-and-natural", new Set())
        .outcome,
    ).toBe("kept");
    // A theme page the direction fits stands in for the page that fails.
    const themed = fitRevampPageToDirection(
      pale,
      { ...fallback, cream: "#dfe5d6" },
      "soft-and-natural",
      new Set(),
    );
    expect(themed.outcome).toBe("theme");
    expect(themed.palette.cream).toBeUndefined();
    expect(themed.palette.ink).toBe(pale.ink);
    // A black accent darkens but never colours the page: it stops before the
    // page would turn dark, and the palette is kept as it was.
    const black = { ...PALETTE, accent: "#000000" };
    const moved = fitRevampPageToDirection(
      black,
      fallback,
      "playful-and-colourful",
      new Set(),
    );
    expect(moved.outcome).toBe("kept");
    expect(moved.palette).toEqual(black);
    expect(isLightColour(moved.palette.cream!)).toBe(true);
  });

  it("does not move a page B18 kept as the theme's", () => {
    const raw = asV5(goodRaw());
    raw.direction = "soft-and-natural";
    // A dark page on a light theme: B18 keeps the theme's page and text.
    raw.design.palette = { ...PALETTE, cream: "#111111", surface: "#1a1a1a" };
    const palette = lenient(raw).design.palette;
    expect(palette.cream).toBeUndefined();
  });

  it("asks no repair for it: a v5 answer with a near-white soft-and-natural page compiles clean", () => {
    const result = strict(asV5(goodRaw()));
    expect(result.issues).toEqual([]);
    expect(colourBand(result.plan!.design.palette.cream!)).not.toBe(
      "near-white",
    );
  });

  // ★★ Review fix (25 Oct): only a page colour Mink chose is moved.
  const whitePage = { ...PALETTE, cream: "#ffffff" };
  const withLook = (look: string): Over => ({
    request: { brief: { ...request().brief, look } },
  });

  it.each([
    "Clean and simple on a pure white background, with soft natural touches.",
    "Keep the page plain white; colour only in the photos and buttons.",
    "Fresh and calm, leafy green and off-white, clean and simple.",
  ])("★★ never moves a page colour the merchant named: %s", (look) => {
    for (const direction of ["soft-and-natural", "playful-and-colourful"]) {
      const raw = asV5(goodRaw());
      raw.direction = direction;
      raw.design.palette = { ...whitePage };
      const result = strict(raw, withLook(look));
      expect(result.issues).toEqual([]);
      expect(result.plan!.design.palette).toEqual(whitePage);
      // The direction the answer chose stays: it read the merchant's words.
      expect(result.plan!.direction).toBe(direction);
      expect(lenient(raw, withLook(look)).design.palette).toEqual(whitePage);
    }
  });

  it("★★ still fits a page Mink chose when the merchant named none", () => {
    const raw = asV5(goodRaw());
    raw.direction = "soft-and-natural";
    raw.design.palette = { ...whitePage };
    const plan = strict(raw, withLook("Warm, earthy and friendly.")).plan!;
    expect(plan.design.palette.cream).not.toBe("#ffffff");
    expect(
      revampPageFitsDirection("soft-and-natural", plan.design.palette.cream!),
    ).toBe(true);
  });

  it.each([
    ["Make the page background pure white, keep everything else", true],
    ["Make it warmer", false],
  ])(
    "★★ never moves the page in a refinement (%s)",
    (instruction, namesPage) => {
      const previous = strict(asV5(goodRaw())).plan!;
      const raw = asV5(goodRaw());
      raw.direction = "soft-and-natural";
      raw.design.palette = { ...whitePage };
      const over: Over = {
        request: {
          kind: "refine",
          instruction,
          refineScope: scopeOf({ design: true }),
        },
        previous,
      };
      expect(revampMerchantNamesPage({ ...request(), ...over.request })).toBe(
        namesPage,
      );
      const result = strict(raw, over);
      expect(result.issues).toEqual([]);
      expect(result.plan!.design.palette).toEqual(whitePage);
      expect(lenient(raw, over).design.palette).toEqual(whitePage);
    },
  );

  it.each([
    ["look", "Clean, on a pure white background"],
    ["look", "Leafy green and off-white"],
    ["look", "Light and modern"],
    ["look", "Dark and quiet"],
    ["look", "Pink and cream with a little gold"],
    ["avoid", "No dark backgrounds"],
    ["facts", "We want the background in white"],
    ["business", "Page colour: ivory, please"],
    ["business", "A #f5f5f5 background"],
    ["instruction", "Make the pages a soft sage green"],
  ])("★ reads a page colour the merchant named (%s: %s)", (field, words) => {
    const base = request();
    const asked =
      field === "instruction"
        ? { ...base, instruction: words }
        : {
            ...base,
            brief: {
              ...base.brief,
              [field]: field === "facts" ? [words] : words,
            },
          };
    expect(revampMerchantNamesPage(asked)).toBe(true);
  });

  it("★ reads each field on its own: a page noun never pairs with the next field's colour", () => {
    const base = request();
    expect(
      revampMerchantNamesPage({
        ...base,
        brief: {
          ...base.brief,
          business: "We print notebooks with ruled pages",
          audience: "green-minded students",
          look: "",
        },
      }),
    ).toBe(false);
  });

  it.each([
    [
      "look",
      "Warm and earthy, mustard yellow and deep brown, like the old mill.",
    ],
    ["look", "Elegant and quiet, plenty of white space, deep indigo."],
    ["look", "Friendly and warm, flour-dusted and cosy, with a little colour."],
    ["facts", "We bake white bread and dark chocolate cookies"],
    ["business", "We sell white sneakers and black boots"],
    ["look", "Bright photos on every page of the shop"],
  ])("★ names no page colour (%s: %s)", (field, words) => {
    const base = request();
    expect(
      revampMerchantNamesPage({
        ...base,
        brief: {
          ...base.brief,
          [field]: field === "facts" ? [words] : words,
        },
      }),
    ).toBe(false);
  });
});

describe("the seeded picker (for U2 and U3)", () => {
  it("★★ picks the same option for the same seed, and spreads seeds over the whole list", () => {
    const options = [...DESIGN_DIRECTION_IDS];
    expect(revampSeededPick("s|direction", options)).toBe(
      revampSeededPick("s|direction", options),
    );
    const seen = new Set(
      Array.from({ length: 200 }, (_, i) =>
        revampSeededPick(`store-${i}|direction`, options),
      ),
    );
    expect(seen).toEqual(new Set(options));
    expect(() => revampSeededPick("s", [])).toThrow(RangeError);
    expect(revampSeededPick("s", ["only"])).toBe("only");
  });

  it("turns a list to start at a seeded place, keeping its order", () => {
    const options = ["a", "b", "c", "d"];
    const starts = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const order = revampSeededOrder(`seed-${i}`, options);
      expect([...order].sort()).toEqual(options);
      const at = options.indexOf(order[0]);
      expect(order).toEqual([...options.slice(at), ...options.slice(0, at)]);
      starts.add(order[0]);
    }
    expect(starts.size).toBe(4);
    expect(revampSeededOrder("s", [])).toEqual([]);
  });

  it("seeds a redesign by its store and, when known, its own id", () => {
    expect(revampDesignSeed("store-1")).toBe("store-1");
    expect(revampDesignSeed("store-1", null)).toBe("store-1");
    expect(revampDesignSeed("store-1", "r-9")).toBe("store-1:r-9");
  });
});

describe("the closed choices", () => {
  it("★★ offers only values the validator keeps as they are", () => {
    for (const [type, table] of Object.entries(REVAMP_SECTION_CHOICES)) {
      for (const [key, rule] of Object.entries(table.fields ?? {})) {
        for (const option of rule.options) {
          const config = {
            ...(EMPTY_CONFIG as unknown as Record<string, Raw>)[type],
            [key]: option,
          };
          const out = validateConfig(type as never, config, "draft");
          expect("config" in out, `${type}.${key}`).toBe(true);
          expect(
            (out as { config: Raw }).config[key],
            `${type}.${key}=${String(option)}`,
          ).toBe(option);
        }
      }
    }
  });

  it("★ stays inside Theme Studio's own visible choices, and leaves none of them as a lone default", () => {
    for (const type of REVAMP_SECTION_TYPES) {
      const studio = VISIBLE_SECTION_CHOICES[type] ?? {};
      const ours = REVAMP_SECTION_CHOICES[type]?.fields ?? {};
      for (const [key, options] of Object.entries(studio)) {
        if (ours[key]) {
          for (const option of ours[key].options) {
            expect(options, `${type}.${key}`).toContain(option);
          }
        } else {
          // Not a choice: the compiler sets it.
          expect(REVAMP_COMPILER_SET_FIELDS[type], `${type}.${key}`).toContain(
            key,
          );
        }
      }
    }
  });

  it("★★ every neutral line passes the claim checks with no evidence, in English, with no number or long dash", () => {
    const lines = [
      ...REVAMP_NEUTRAL_COPY.openingCta,
      ...REVAMP_NEUTRAL_COPY.shopLink,
      ...REVAMP_NEUTRAL_COPY.newsletterHeading,
      ...REVAMP_NEUTRAL_COPY.newsletterSubtext.map((l) =>
        revampNeutralLine(l, "Ghani Oils"),
      ),
      ...REVAMP_NEUTRAL_COPY.newsletterButton,
      ...REVAMP_NEUTRAL_COPY.newsletterThanks,
      ...REVAMP_NEUTRAL_COPY.seoTail,
    ];
    for (const line of lines) {
      expect(unsupportedClaimsIn(line, ""), line).toEqual([]);
      expect(readsAsLanguage(line, "English"), line).toBe(true);
      expect(line, line).not.toMatch(/\d|[–—]/);
    }
    for (const list of Object.values(REVAMP_NEUTRAL_COPY)) {
      expect(new Set(list).size).toBe(list.length);
      expect(list.length).toBeGreaterThan(3);
    }
  });

  it("★★ promises no frequency: how often a store emails is the merchant's to say (review fix, 25 Oct)", () => {
    const lines = Object.values(REVAMP_NEUTRAL_COPY).flat();
    for (const line of lines) {
      expect(line, line).not.toMatch(
        /\b(?:occasional(?:ly)?|now and then|from time to time|every (?:day|week|month)|daily|weekly|monthly|fortnightly|yearly|rarely|seldom|regularly|often|sometimes|frequent(?:ly)?|once an?|twice an?|no spam|never spam|only when)\b/i,
      );
    }
  });

  it("closes the search description with a line picked for the store, or the old one without a seed", () => {
    expect(fallbackSeoDescription("About", "Ghani Oils")).toBe(
      "About - Ghani Oils. Browse the shop and find out more.",
    );
    const tails = new Set(
      REDESIGNS.map((id) => fallbackSeoDescription("About", "Ghani Oils", id)),
    );
    expect(tails.size).toBeGreaterThan(2);
    for (const line of tails) {
      expect(
        REVAMP_NEUTRAL_COPY.seoTail.some((tail) =>
          line.startsWith(`About - Ghani Oils. ${tail}`),
        ),
      ).toBe(true);
    }
  });
});

describe("the shoot's mood and palette direction (held for the owner's step 9 decision, not wired)", () => {
  it("★★ names the direction and two of its moods picked for the store, and describes the real page and accent", () => {
    const moods = valuesOver(
      (id) =>
        revampImageMood({
          direction: "soft-and-natural",
          page: "#dfe5d6",
          accent: "#9a4f2c",
          seed: id,
        }).moodKeywords,
    );
    expect(moods.size).toBeGreaterThan(2);
    const mood = revampImageMood({
      direction: "soft-and-natural",
      page: "#dfe5d6",
      accent: "#9a4f2c",
      seed: "store-1",
    });
    expect(mood.moodKeywords[0]).toBe(
      DESIGN_DIRECTIONS["soft-and-natural"].label,
    );
    expect(mood.moodKeywords).toHaveLength(3);
    expect(mood.paletteDirection).toBe(
      "A soft, light neutral page field with warm red, orange and gold accents, kept in every photograph.",
    );
    expect(
      revampImageMood({
        direction: "playful-and-colourful",
        page: "#cfe2ee",
        accent: "#14291f",
        seed: "x",
      }).paletteDirection,
    ).toBe(
      "A pale teal and sky blue page field with deep green and mint accents, kept in every photograph.",
    );
  });

  it("asks for nothing it cannot name", () => {
    expect(
      revampImageMood({
        direction: "made-up",
        page: "red",
        accent: "",
        seed: "s",
      }),
    ).toEqual({ moodKeywords: [], paletteDirection: "" });
  });
});

describe("bounded v6 planning", () => {
  it("fits refills and category photos to eight shots without requesting a paid repair", () => {
    const raw = { ...goodRaw(), promptVersion: "mink-revamp-site-v6" };
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    expect(result.plan!.shots.length).toBeLessThanOrEqual(8);
    expect(result.plan!.shots.map((shot) => shot.id)).toContain(REFILL_STORY);
    expect(result.plan!.shots.map((shot) => shot.id)).toContain(REFILL_BANNER);
    for (const binding of result.plan!.bindings.filter(
      (binding) => binding.pageSlug === "@category",
    )) {
      expect(
        result.plan!.shots.find((shot) => shot.id === binding.shotId)?.purpose,
      ).toBe("category");
    }
  });
  it("removes unsupported optional claims without replanning", () => {
    const raw = goodRaw();
    const opening = homeOf(raw)[0];
    const config = JSON.parse(opening.configJson!);
    config.slides[0].image_alt = "Traditional oil from our mill.";
    config.slides[0].subheading = "Traditional oils.";
    opening.configJson = JSON.stringify(config);
    const result = strict(raw);
    expect(result.issues).toEqual([]);
    expect(JSON.stringify(result.plan)).not.toContain("Traditional");
  });
});

describe("server-owned photograph budget", () => {
  it("cannot be bypassed by an answer that omits its prompt version", () => {
    const result = compileRevampSite(
      goodRaw(),
      { ...input(), photoBudget: 8 },
      { newId: ids() },
    );
    expect(result.issues).toEqual([]);
    expect(result.plan!.shots.length).toBeLessThanOrEqual(8);
  });
});
