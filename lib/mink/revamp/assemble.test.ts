import { describe, expect, it } from "vitest";
import { sanitizeChromeForSave } from "@/lib/chrome/types";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  assembleRevampPlan,
  estimateRevampCredits,
  fitRevampPlanToBudget,
  REVAMP_PHONE_CROP_SUFFIX,
  revampCarriedProductPhotoKeys,
  revampFixedCreditCeiling,
  revampProductPhotoKeys,
  revampSectionLabel,
} from "./assemble";
import {
  REVAMP_LIMITS,
  REVAMP_PRICES,
  REVAMP_SLOT_PREFIX,
  type RevampRequest,
  type RevampSitePlan,
  type RevampSlotBinding,
  type RevampSnapshot,
  type RevampStoredImage,
} from "./contract";
import { revampSectionsDigest } from "./digests";
import { REVAMP_PHONE_SUFFIX } from "./image-store";
import {
  REVAMP_CATEGORY_FRAME,
  revampCategoryChangeKey,
} from "./site-compiler";

const B =
  "https://storage.googleapis.com/sm-bucket/stores/s1/mink-generated/revamp/";
const P1_PHOTO =
  "https://storage.googleapis.com/sm-bucket/stores/s1/media/mustard.webp";
const P3_PHOTO =
  "https://storage.googleapis.com/sm-bucket/stores/s1/media/sesame.webp";
const slot = (id: string) => `${REVAMP_SLOT_PREFIX}${id}`;
const P = REVAMP_PRICES;

function sec(
  id: string,
  type: string,
  config: Record<string, unknown>,
): PageSectionItem {
  return { id, type, enabled: true, config } as unknown as PageSectionItem;
}

const STORY = sec("m-story", "media_text", {
  heading: "Our story",
  body: "We started pressing oil in 1990.",
});

function snapshot(): RevampSnapshot {
  return {
    storeId: "s1",
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
      {
        id: "page-home",
        slug: "",
        title: "Home",
        status: "published",
        version: "v-home",
        sectionsDigest: "d-home",
        sections: [sec("t-hero", "hero", { heading: "Fresh produce" }), STORY],
        owners: { "t-hero": "theme", "m-story": "merchant" },
        skipped: null,
        seoTitle: null,
        seoDescription: null,
      },
      {
        id: "page-about",
        slug: "about",
        title: "About",
        status: "published",
        version: "v-about",
        sectionsDigest: "d-about",
        sections: [
          sec("t-about", "rich_text", { html: "<p>About the theme.</p>" }),
        ],
        owners: { "t-about": "theme" },
        skipped: null,
        seoTitle: null,
        seoDescription: null,
      },
    ],
    chrome: {
      rowExists: false,
      version: null,
      digest: "chrome-d",
      value: sanitizeChromeForSave({}),
    },
    brand: { tagline: null, blurb: null, digest: "brand-d" },
    categories: [
      {
        id: "c1",
        slug: "fruits",
        name: "Fruits",
        description: null,
        imageUrl: "/themes/basket/fruits.webp",
        status: "active",
        updatedAt: "t1",
        sample: true,
        productCount: 3,
      },
      {
        id: "c2",
        slug: "oils",
        name: "Oils",
        description: "All oils",
        imageUrl: null,
        status: "active",
        updatedAt: "t2",
        sample: false,
        productCount: 1,
      },
    ],
    products: [
      {
        id: "x1",
        name: "Banana (Sample)",
        slug: "banana",
        status: "published",
        updatedAt: "u1",
        sample: true,
        imageUrl: null,
        categoryId: "c1",
      },
      {
        id: "x2",
        name: "Groundnut Oil",
        slug: "groundnut-oil",
        status: "published",
        updatedAt: "u2",
        sample: false,
        imageUrl: null,
        categoryId: "c2",
      },
      {
        id: "x3",
        name: "Apple (Sample)",
        slug: "apple",
        status: "draft",
        updatedAt: "u3",
        sample: true,
        imageUrl: null,
        categoryId: "c1",
      },
    ],
    facts: {} as RevampSnapshot["facts"],
    photos: { replaceable: [], broken: [] },
    entitlements: { customCode: true },
  };
}

function request(): RevampRequest {
  return {
    kind: "full",
    brief: {
      business: "Ghani Oils sells cold-pressed oil.",
      look: "warm",
      audience: "home cooks",
      facts: [],
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
        photoUrl: P1_PHOTO,
        categorySlug: "oils",
      },
      {
        key: "p2",
        name: "Desi Ghee",
        description: "Ghee from cow milk.",
        sizes: [{ label: "500 ml", price: 699, mrp: null }],
        photoUrl: null,
        categorySlug: null,
      },
      {
        key: "p3",
        name: "Sesame Oil",
        description: "Sesame oil.",
        sizes: [{ label: "1 L", price: 299, mrp: null }],
        photoUrl: P3_PHOTO,
        categorySlug: "oils",
      },
    ],
    categories: [
      { action: "hide", slug: "fruits" },
      {
        action: "create",
        name: "Cold Pressed",
        slug: null,
        description: "Pressed slowly.",
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

const WIDE = { width: 2520, height: 1080, aspect: 2520 / 1080 };
const SQUARE = { width: 1200, height: 1200, aspect: 1 };

function bind(
  shotId: string,
  pageSlug: string,
  sectionId: string,
  path: Array<string | number>,
  frame = SQUARE,
  phonePath: RevampSlotBinding["phonePath"] = null,
): RevampSlotBinding {
  return { shotId, pageSlug, sectionId, path, frame, phonePath };
}

function shot(
  id: string,
  subject: string,
  purpose: "hero" | "content" | "category" = "content",
) {
  return {
    id,
    purpose,
    subject,
    artDirection: "",
    aspectRatio: "1:1",
    people: "none" as const,
  };
}

function plan(): RevampSitePlan {
  return {
    summary: "A warm, earthy store for Ghani Oils.",
    industry: "food" as RevampSitePlan["industry"],
    direction: "",
    design: {
      palette: { accent: "#2f6b3a" },
      fonts: { body: null, display: null },
      shape: {},
    },
    appearance: { header: "centered" },
    announcement: { text: "Free delivery over 999", href: "/shop" },
    brand: { tagline: "Pressed in Ludhiana", blurb: "" },
    newsletter: {
      heading: "Join the mill",
      subtext: "Pressing days and new oils.",
      buttonLabel: "Join",
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seoTitle: "Ghani Oils",
        seoDescription: "Cold-pressed oils from Ludhiana.",
        create: false,
        pageId: "page-home",
        sections: [
          sec("n-hero", "hero", {
            variant: "fullbleed",
            heading: "Pressed slow",
            image_url: slot("hero"),
            mobile_image_url: slot("hero"),
            image_alt: "Oil being pressed",
          }),
          sec("n-gallery", "gallery", {
            heading: "From the mill",
            items: [
              { image_url: slot("g1"), image_alt: "Jars" },
              { image_url: slot("g2") },
            ],
          }),
          STORY,
        ],
      },
      {
        slug: "about",
        title: "About",
        seoTitle: "About",
        seoDescription: "How Ghani Oils presses its oil.",
        create: false,
        pageId: "page-about",
        sections: [
          sec("n-about", "media_text", {
            heading: "Our mill",
            body: "A wooden ghani.",
            image_url: slot("about-1"),
          }),
        ],
      },
      {
        slug: "faq",
        title: "FAQ",
        seoTitle: "FAQ",
        seoDescription: "Questions about our oils.",
        create: true,
        pageId: null,
        sections: [sec("n-faq", "rich_text", { html: "<p>Questions</p>" })],
      },
    ],
    menus: {
      header: [
        { label: "Shop", href: "/shop" },
        { label: "About", href: "/about" },
      ],
      footerGroups: [
        { title: "Help", links: [{ label: "FAQ", href: "/faq" }] },
      ],
    },
    shots: [
      shot("hero", "A ghani at dawn", "hero"),
      shot("g1", "Jars"),
      shot("g2", "Seeds"),
      shot("about-1", "The mill at dawn"),
      shot("cat-cold", "Cold pressed oils", "category"),
    ],
    bindings: [
      bind("hero", "", "n-hero", ["image_url"], WIDE, ["mobile_image_url"]),
      bind("g1", "", "n-gallery", ["items", 0, "image_url"]),
      bind("g2", "", "n-gallery", ["items", 1, "image_url"]),
      bind("about-1", "about", "n-about", ["image_url"], {
        width: 1200,
        height: 1500,
        aspect: 0.8,
      }),
      bind(
        "cat-cold",
        "@category",
        "cold-pressed",
        ["image_url"],
        REVAMP_CATEGORY_FRAME,
      ),
      bind(
        "cat-oils",
        "@category",
        "oils",
        ["image_url"],
        REVAMP_CATEGORY_FRAME,
      ),
    ],
    productCopy: { p1: "Slow pressed mustard oil." },
    notes: ["Note A"],
    skipped: [{ label: "Blog", reason: "Not part of this revamp." }],
  };
}

function img(
  role: RevampStoredImage["role"],
  slotId: string,
): RevampStoredImage {
  return {
    role,
    slotId,
    url: `${B}${slotId}.webp`,
    path: `stores/s1/r/${slotId}.webp`,
    sha256: "x",
    width: 100,
    height: 100,
    review: "passed",
  };
}

describe("estimateRevampCredits", () => {
  it("prices pages, shots, design, chrome, categories and product photos", () => {
    const credits = estimateRevampCredits(plan(), {
      request: request(),
      productPhotoKeys: ["p1", "p3"],
    });
    expect(credits).toEqual({
      pages: 3 * P.page,
      photos: 5 * P.photo,
      design: P.design,
      chrome: P.chrome,
      categories: 3 * P.category,
      productPhotos: 2 * P.productPhoto,
      total:
        3 * P.page +
        5 * P.photo +
        P.design +
        P.chrome +
        3 * P.category +
        2 * P.productPhoto,
    });
  });

  it("charges no design when the plan keeps the theme's look", () => {
    const p = {
      ...plan(),
      design: { palette: {}, fonts: { body: null, display: null }, shape: {} },
    };
    expect(
      estimateRevampCredits(p, { request: request(), productPhotoKeys: [] })
        .design,
    ).toBe(0);
  });
});

describe("assembleRevampPlan", () => {
  const assembled = () =>
    assembleRevampPlan({
      revampId: "rv1",
      request: request(),
      snapshot: snapshot(),
      plan: plan(),
      images: [
        img("slot", "hero"),
        img("slot", `hero${REVAMP_PHONE_CROP_SUFFIX}`),
        img("slot", "g1"),
        img("slot", "about-1"),
        img("slot", "cat-cold"),
        img("product", "p1"),
      ],
      outcomes: [
        { shotId: "hero", status: "generated", reason: null },
        {
          shotId: "about-1",
          status: "failed",
          reason: "A crop of another photograph is used here.",
        },
      ],
      productFailures: [
        {
          key: "p3",
          reason: "The studio photo could not be made; your own photo is used.",
        },
      ],
      free: true,
      canChangeBrand: true,
    });

  it("keeps the phone suffix equal to the image store's", () => {
    expect(REVAMP_PHONE_CROP_SUFFIX).toBe(REVAMP_PHONE_SUFFIX);
  });

  it("resolves every slot, phone crops included, and drops a section whose photo is missing", () => {
    const stored = assembled();
    const [home, about, faq] = stored.pages;
    const hero = home.sections.find((s) => s.id === "n-hero")!
      .config as unknown as Record<string, unknown>;
    expect(hero.image_url).toBe(`${B}hero.webp`);
    expect(hero.mobile_image_url).toBe(`${B}hero~phone.webp`);
    expect(home.sections.map((s) => s.id)).toEqual(["n-hero", "m-story"]);
    expect(stored.notes[0]).toBe("Note A");
    expect(stored.notes.some((n) => n.includes("left out"))).toBe(true);
    expect(
      (about.sections[0].config as unknown as Record<string, unknown>)
        .image_url,
    ).toBe(`${B}about-1.webp`);
    expect(JSON.stringify(stored)).not.toContain(REVAMP_SLOT_PREFIX);

    expect(home).toMatchObject({
      pageId: "page-home",
      expectedVersion: "v-home",
      expectedDigest: "d-home",
      changes: { added: 1, removed: 1, kept: 1, photos: 1 },
    });
    expect(home.proposedDigest).toBe(revampSectionsDigest(home.sections));
    expect(about.changes).toEqual({ added: 1, removed: 1, kept: 0, photos: 1 });
    expect(faq).toMatchObject({
      create: true,
      pageId: null,
      expectedVersion: null,
      expectedDigest: null,
      changes: { added: 1, removed: 0, kept: 0, photos: 0 },
    });
  });

  it("builds categories in version 1's shapes, with the category photograph", () => {
    expect(assembled().categories).toEqual([
      {
        action: "hide",
        id: "c1",
        slug: "fruits",
        expectedUpdatedAt: "t1",
        name: "Fruits",
      },
      {
        action: "create",
        slug: "cold-pressed",
        name: "Cold Pressed",
        description: "Pressed slowly.",
        imageUrl: `${B}cat-cold.webp`,
      },
      {
        action: "update",
        id: "c2",
        slug: "oils",
        expectedUpdatedAt: "t2",
        before: { name: "Oils", description: "All oils", imageUrl: null },
        name: "Oils",
        description: "All oils",
        imageUrl: null,
      },
    ]);
  });

  it("creates the merchant's products with sizes, and hides only published samples", () => {
    const { products } = assembled();
    expect(products.hide).toEqual([
      { id: "x1", name: "Banana (Sample)", expectedUpdatedAt: "u1" },
    ]);
    const [p1, p2, p3] = products.create;
    expect(p1).toMatchObject({
      key: "p1",
      slug: "mustard-oil",
      description: "Slow pressed mustard oil.",
      categorySlug: "oils",
      imageUrl: `${B}p1.webp`,
      sourceImageUrl: P1_PHOTO,
      options: [{ name: "Size", values: ["1 L", "5 L"] }],
      price: 349,
      mrp: 399,
    });
    expect(p1.variants).toEqual([
      { name: "1 L", optionValues: ["1 L"], price: 349, mrp: 399 },
      { name: "5 L", optionValues: ["5 L"], price: 1599, mrp: null },
    ]);
    expect(p2).toMatchObject({
      slug: "desi-ghee",
      description: "Ghee from cow milk.",
      imageUrl: null,
      options: [],
      variants: [],
      price: 699,
    });
    expect(p3).toMatchObject({ imageUrl: P3_PHOTO, sourceImageUrl: P3_PHOTO });
  });

  it("merges the plan into the store's chrome and copies the locks", () => {
    const { chrome, brand } = assembled();
    expect(chrome).toMatchObject({
      expectedVersion: null,
      expectedDigest: "chrome-d",
    });
    expect(chrome!.next.header.links.map((l) => l.href)).toEqual([
      "/shop",
      "/about",
    ]);
    expect(chrome!.next.footer.groups[0].title).toBe("Help");
    expect(chrome!.next.header.announcement).toMatchObject({
      enabled: true,
      text: "Free delivery over 999",
    });
    expect(chrome!.next.footer.newsletter).toMatchObject({
      heading: "Join the mill",
      buttonLabel: "Join",
    });
    expect(chrome!.next.design.palette.accent).toBe("#2f6b3a");
    expect(chrome!.next.appearance.header).toBe("centered");
    expect(brand).toEqual({
      expectedDigest: "brand-d",
      tagline: "Pressed in Ludhiana",
      blurb: null,
    });
  });

  it("lists photos, skipped lines, credits and the envelope", () => {
    const stored = assembled();
    const label = revampSectionLabel(sec("x", "media_text", {}));
    expect(stored.photos).toEqual([
      {
        url: `${B}hero.webp`,
        path: "stores/s1/r/hero.webp",
        alt: "Oil being pressed",
        where: "Home page, opening photo",
      },
      {
        url: `${B}about-1.webp`,
        path: "stores/s1/r/about-1.webp",
        alt: "The mill at dawn",
        where: `About page, ${label}`,
      },
      {
        url: `${B}cat-cold.webp`,
        path: "stores/s1/r/cat-cold.webp",
        alt: "Cold pressed oils",
        where: "Cold Pressed category",
      },
    ]);
    expect(stored.skipped).toEqual([
      { label: "Blog", reason: "Not part of this revamp." },
      {
        label: `About page, ${label}`,
        reason: "A crop of another photograph is used here.",
      },
      {
        label: "Studio photo of Sesame Oil",
        reason: "The studio photo could not be made; your own photo is used.",
      },
    ]);
    // ★ One photo: only "hero" was drawn by this revamp and is still shown
    //   ("about-1" is a crop, "g1" lost its gallery, "cat-cold" has no
    //   outcome saying it was drawn).
    expect(stored.credits).toEqual({
      pages: 3 * P.page,
      photos: P.photo,
      design: P.design,
      chrome: P.chrome,
      categories: 3 * P.category,
      productPhotos: P.productPhoto,
      total:
        3 * P.page +
        P.photo +
        P.design +
        P.chrome +
        3 * P.category +
        P.productPhoto,
    });
    expect(stored.charges).toEqual({
      pages: ["", "about", "faq"],
      photoUrls: [`${B}hero.webp`],
      design: true,
      chrome: true,
      categories: 3,
      productPhotoKeys: ["p1"],
    });
    expect(stored).toMatchObject({
      schemaVersion: 2,
      revampId: "rv1",
      kind: "full",
      checks: [],
      free: true,
      explanation: "A warm, earthy store for Ghani Oils.",
    });
  });

  it("charges a photo only for a shot this revamp drew and still shows (money-2)", () => {
    const stored = assembleRevampPlan({
      revampId: "rv1",
      request: request(),
      snapshot: snapshot(),
      plan: plan(),
      images: [
        img("slot", "hero"),
        img("slot", "g1"),
        img("slot", "g2"),
        img("slot", "about-1"),
        img("slot", "cat-cold"),
      ],
      outcomes: [
        { shotId: "hero", status: "generated", reason: null },
        { shotId: "g1", status: "generated", reason: null },
        {
          shotId: "g2",
          status: "failed",
          reason:
            "The limit for new photographs was reached, so a crop of another photograph from the same shoot is used here.",
        },
        {
          shotId: "about-1",
          status: "failed",
          reason:
            "The photo service could not finish this picture, so a crop of another photograph from the same shoot is used here.",
        },
        { shotId: "cat-cold", status: "generated", reason: null },
      ],
      productFailures: [],
      free: false,
      canChangeBrand: true,
    });
    // The crops are shown, and listed under "Not done this time"...
    expect(stored.photos.map((p) => p.url)).toContain(`${B}g2.webp`);
    expect(stored.skipped.map((s) => s.label)).toEqual(
      expect.arrayContaining([
        `Home page, ${revampSectionLabel(sec("x", "gallery", {}))}`,
        `About page, ${revampSectionLabel(sec("x", "media_text", {}))}`,
      ]),
    );
    // ...but only the three photographs this revamp drew are charged.
    expect(stored.credits.photos).toBe(3 * P.photo);
    expect(stored.charges?.photoUrls).toEqual([
      `${B}hero.webp`,
      `${B}g1.webp`,
      `${B}cat-cold.webp`,
    ]);
  });

  it("never creates a product the store already has, and says so (known-1b)", () => {
    const req = request();
    req.products[0] = { ...req.products[0], name: "  groundnut OIL " };
    const stored = assembleRevampPlan({
      revampId: "rv1",
      request: req,
      snapshot: snapshot(),
      plan: plan(),
      images: [img("product", "p1"), img("product", "p3")],
      outcomes: [],
      productFailures: [
        { key: "p1", reason: "The studio photo could not be made." },
      ],
      free: false,
      canChangeBrand: true,
    });
    expect(stored.products.create.map((p) => p.key)).toEqual(["p2", "p3"]);
    // A product that is not created has no studio photo to miss.
    expect(stored.skipped.map((s) => s.label)).not.toContain(
      "Studio photo of   groundnut OIL ",
    );
    expect(stored.skipped.some((s) => /groundnut/i.test(s.label))).toBe(false);
    expect(stored.products.create.map((p) => p.slug)).toEqual([
      "desi-ghee",
      "sesame-oil",
    ]);
    expect(stored.notes).toContain(
      "groundnut OIL is already on your shop, so it was not added again.",
    );
    // ★ Its studio photo is shown nowhere, so it is not charged either.
    expect(stored.credits.productPhotos).toBe(P.productPhoto);
    expect(stored.charges?.productPhotoKeys).toEqual(["p3"]);
  });

  it("clips the explanation to 1,000 characters", () => {
    const long = { ...plan(), summary: "word ".repeat(400) };
    const stored = assembleRevampPlan({
      revampId: "rv1",
      request: request(),
      snapshot: snapshot(),
      plan: long,
      images: [],
      outcomes: [],
      productFailures: [],
      free: false,
      canChangeBrand: true,
    });
    expect(stored.explanation.length).toBeLessThanOrEqual(1000);
  });

  describe("★★ the tagline and footer description need Branding manage (f-3)", () => {
    const BRAND_NOTE =
      "Your store tagline and footer description were left as they are, because changing them needs Branding manage permission.";
    const assembleWith = (canChangeBrand: boolean, p = plan()) =>
      assembleRevampPlan({
        revampId: "rv1",
        request: request(),
        snapshot: snapshot(),
        plan: p,
        images: [],
        outcomes: [],
        productFailures: [],
        free: false,
        canChangeBrand,
      });

    it("leaves the brand out, and says why, for a requester who may not change it", () => {
      // ★ Apply refuses a whole card whose plan writes the tagline for a
      //   requester without Branding manage, so the card never carries one.
      const stored = assembleWith(false);
      expect(stored.brand).toBeNull();
      expect(stored.notes).toContain(BRAND_NOTE);
      // The rest of the redesign is untouched.
      expect(stored.pages).toHaveLength(3);
      expect(stored.chrome?.next.header.links.length).toBeGreaterThan(0);
      expect(stored.notes[0]).toBe("Note A");
    });

    it("keeps the brand for a requester who may change it, with no note", () => {
      const stored = assembleWith(true);
      expect(stored.brand).toEqual({
        expectedDigest: "brand-d",
        tagline: "Pressed in Ludhiana",
        blurb: null,
      });
      expect(stored.notes).not.toContain(BRAND_NOTE);
    });

    it("says nothing when the plan would not change the brand anyway", () => {
      const quiet = { ...plan(), brand: { tagline: " ", blurb: "" } };
      const stored = assembleWith(false, quiet);
      expect(stored.brand).toBeNull();
      expect(stored.notes).not.toContain(BRAND_NOTE);
    });
  });
});

// ---------------------------------------------------------------------------
// Budget fitting.
// ---------------------------------------------------------------------------

function budgetPlan(): RevampSitePlan {
  return {
    ...plan(),
    pages: [
      {
        slug: "",
        title: "Home",
        seoTitle: "Home",
        seoDescription: "Cold-pressed oils from Ludhiana.",
        create: false,
        pageId: "page-home",
        sections: [
          sec("n-hero", "hero", {
            variant: "fullbleed",
            heading: "Pressed slow",
            image_url: slot("hero"),
          }),
          sec("n-band", "media_text", { image_url: slot("h2") }),
          sec("n-gal", "gallery", {
            items: [{ image_url: slot("h3") }, { image_url: slot("h4") }],
          }),
        ],
      },
      {
        slug: "about",
        title: "About",
        seoTitle: "About",
        seoDescription: "How we press oil here.",
        create: false,
        pageId: "page-about",
        sections: [
          sec("n-about", "media_text", {
            heading: "Mill",
            image_url: slot("a1"),
          }),
        ],
      },
      {
        slug: "contact",
        title: "Contact",
        seoTitle: "Contact",
        seoDescription: "Write to Ghani Oils here.",
        create: true,
        pageId: null,
        sections: [sec("n-contact", "rich_text", { html: "<p>Hi</p>" })],
      },
    ],
    shots: [
      shot("hero", "Hero", "hero"),
      shot("h2", "Band"),
      shot("h3", "A"),
      shot("h4", "B"),
      shot("a1", "Mill"),
      shot("c1", "Cold", "category"),
      shot("unused", "Nothing"),
    ],
    bindings: [
      bind("hero", "", "n-hero", ["image_url"], WIDE),
      bind("h2", "", "n-band", ["image_url"], {
        width: 2350,
        height: 1000,
        aspect: 2.35,
      }),
      bind("h3", "", "n-gal", ["items", 0, "image_url"]),
      bind("h4", "", "n-gal", ["items", 1, "image_url"]),
      bind("a1", "about", "n-about", ["image_url"]),
      bind(
        "c1",
        "@category",
        "cold-pressed",
        ["image_url"],
        REVAMP_CATEGORY_FRAME,
      ),
    ],
    skipped: [],
  };
}

const MANDATORY = P.page + P.chrome + 3 * P.category;

describe("fitRevampPlanToBudget", () => {
  it("spends in order: homepage, design, chrome, categories, homepage photos, pages, product photos", () => {
    const budget =
      MANDATORY +
      P.design +
      P.photo /* category */ +
      P.photo /* opening */ +
      P.photo; /* h2 */
    const { plan: fitted, productPhotoKeys } = fitRevampPlanToBudget(
      budgetPlan(),
      { request: request(), budget },
    );
    expect(fitted.design.palette.accent).toBe("#2f6b3a");
    expect(fitted.shots.map((s) => s.id).sort()).toEqual(["c1", "h2", "hero"]);
    expect(fitted.pages.map((p) => p.slug)).toEqual([""]);
    expect(fitted.pages[0].sections.map((s) => s.id)).toEqual([
      "n-hero",
      "n-band",
    ]);
    expect(productPhotoKeys).toEqual([]);
    expect(fitted.skipped).toEqual([
      {
        label: "2 new photographs on your homepage",
        reason: "Not enough Mink credits left this time.",
      },
      {
        label: "Your About page",
        reason: "Not enough Mink credits left this time.",
      },
      {
        label: "Your Contact page",
        reason: "Not enough Mink credits left this time.",
      },
      {
        label: "Studio photos of 2 products",
        reason:
          "Not enough Mink credits left this time; your own photos are used.",
      },
    ]);
    expect(
      estimateRevampCredits(fitted, { request: request(), productPhotoKeys })
        .total,
    ).toBe(budget);
  });

  it("points a dropped homepage photo at the opening one when the frames match", () => {
    const budget = MANDATORY + P.design + 2 * P.photo;
    const { plan: fitted } = fitRevampPlanToBudget(budgetPlan(), {
      request: request(),
      budget,
    });
    const band = fitted.pages[0].sections.find((s) => s.id === "n-band")!;
    expect((band.config as unknown as Record<string, unknown>).image_url).toBe(
      slot("hero"),
    );
    expect(fitted.bindings.find((b) => b.sectionId === "n-band")!.shotId).toBe(
      "hero",
    );
    expect(fitted.shots.map((s) => s.id).sort()).toEqual(["c1", "hero"]);
    expect(fitted.skipped[0].label).toBe("3 new photographs on your homepage");
  });

  it("drops the design and category photos first when even those do not fit", () => {
    const { plan: fitted } = fitRevampPlanToBudget(budgetPlan(), {
      request: request(),
      budget: MANDATORY,
    });
    expect(fitted.design.palette).toEqual({});
    expect(fitted.bindings.some((b) => b.pageSlug === "@category")).toBe(false);
    expect(fitted.skipped.map((s) => s.label)).toEqual(
      expect.arrayContaining([
        "Your new colours and fonts",
        "A new photo for 1 category",
      ]),
    );
    // ★ The opening photograph is never dropped.
    expect(fitted.shots.map((s) => s.id)).toContain("hero");
  });

  it("buys everything a big budget covers, and product photos in request order", () => {
    const { plan: fitted, productPhotoKeys } = fitRevampPlanToBudget(
      budgetPlan(),
      { request: request(), budget: 200 },
    );
    expect(fitted.pages).toHaveLength(3);
    expect(fitted.skipped).toEqual([]);
    expect(productPhotoKeys).toEqual(["p1", "p3"]);
    expect(fitted.shots.map((s) => s.id)).not.toContain("unused");
  });

  it("never spends past the 200-credit ceiling, whatever the budget", () => {
    const many = request();
    many.products = Array.from({ length: 50 }, (_, i) => ({
      key: `k${i}`,
      name: `Oil ${i}`,
      description: "",
      sizes: [{ label: "1 L", price: 100, mrp: null }],
      photoUrl: P1_PHOTO,
      categorySlug: null,
    }));
    const { plan: fitted, productPhotoKeys } = fitRevampPlanToBudget(
      budgetPlan(),
      { request: many, budget: 10_000 },
    );
    const total = estimateRevampCredits(fitted, {
      request: many,
      productPhotoKeys,
    }).total;
    expect(total).toBeLessThanOrEqual(REVAMP_LIMITS.maxCredits);
    expect(productPhotoKeys.length).toBeLessThan(50);
    expect(fitted.skipped.at(-1)!.label).toMatch(
      /^Studio photos of \d+ products$/,
    );
  });
});

// ---------------------------------------------------------------------------
// A refinement is charged only for what it makes (money-1).
// ---------------------------------------------------------------------------

/** The full revamp above, refined to "redo the opening photo". */
function refinePlan(): RevampSitePlan {
  return {
    ...plan(),
    // Every binding has its shot, as a compiled plan's always does.
    bindings: plan().bindings.filter((b) => b.shotId !== "cat-oils"),
    basis: {
      categories: 3,
      productKeys: ["p1", "p2", "p3"],
      existingProductKeys: [],
      carried: {
        pages: ["", "about", "faq"],
        shots: ["g1", "g2", "about-1", "cat-cold"],
        design: true,
        chrome: true,
        categories: 3,
        products: ["p1", "p2", "p3"],
      },
    },
  };
}

function refineRequest(
  scope: Partial<NonNullable<RevampRequest["refineScope"]>> = {},
): RevampRequest {
  return {
    ...request(),
    kind: "refine",
    instruction: "Redo the opening photo.",
    refineScope: {
      design: false,
      copy: false,
      layout: false,
      photos: ["hero"],
      pages: null,
      products: false,
      ...scope,
    },
  };
}

describe("a refinement (money-1)", () => {
  it("estimates only the photograph it redraws", () => {
    expect(
      estimateRevampCredits(refinePlan(), {
        request: refineRequest(),
        productPhotoKeys: ["p1", "p3"],
      }),
    ).toEqual({
      pages: 0,
      photos: P.photo,
      design: 0,
      chrome: 0,
      categories: 0,
      productPhotos: 0,
      total: P.photo,
    });
  });

  it("charges the card for the one redrawn photo, never the carried site", () => {
    const stored = assembleRevampPlan({
      revampId: "rv2",
      request: refineRequest(),
      snapshot: snapshot(),
      plan: refinePlan(),
      images: [
        img("slot", "hero"),
        img("slot", "g1"),
        img("slot", "g2"),
        img("slot", "about-1"),
        img("slot", "cat-cold"),
        img("product", "p1"),
        img("product", "p3"),
      ],
      outcomes: [
        { shotId: "hero", status: "generated", reason: null },
        // Carried over from the parent (photos.ts reports an adopted shot so).
        { shotId: "g1", status: "skipped", reason: null },
        { shotId: "g2", status: "skipped", reason: null },
        { shotId: "about-1", status: "skipped", reason: null },
        { shotId: "cat-cold", status: "skipped", reason: null },
      ],
      productFailures: [],
      free: false,
      canChangeBrand: true,
    });
    expect(stored.credits).toEqual({
      pages: 0,
      photos: P.photo,
      design: 0,
      chrome: 0,
      categories: 0,
      productPhotos: 0,
      total: P.photo,
    });
  });

  it("charges a carried photograph the photos step had to draw again as nothing", () => {
    const stored = assembleRevampPlan({
      revampId: "rv2",
      request: refineRequest(),
      snapshot: snapshot(),
      plan: refinePlan(),
      images: [img("slot", "hero"), img("slot", "about-1")],
      outcomes: [
        { shotId: "hero", status: "generated", reason: null },
        // ★ Could not be carried over, so it was drawn again: our failure.
        { shotId: "about-1", status: "generated", reason: null },
      ],
      productFailures: [],
      free: false,
      canChangeBrand: true,
    });
    expect(stored.credits.photos).toBe(P.photo);
  });

  it("charges the parent's products' studio photos only when the products are in scope", () => {
    const inScope = assembleRevampPlan({
      revampId: "rv2",
      request: refineRequest({ products: true }),
      snapshot: snapshot(),
      plan: refinePlan(),
      images: [img("product", "p1"), img("product", "p3")],
      outcomes: [],
      productFailures: [],
      free: false,
      canChangeBrand: true,
    });
    expect(inScope.credits.productPhotos).toBe(2 * P.productPhoto);
  });

  it("charges the changes it adds: a new page, a new category, a new design", () => {
    const p = refinePlan();
    p.basis!.carried = {
      ...p.basis!.carried!,
      pages: ["", "about"],
      design: false,
      categories: 2,
    };
    expect(
      estimateRevampCredits(p, {
        request: refineRequest({ design: true }),
        productPhotoKeys: [],
      }),
    ).toMatchObject({
      pages: P.page,
      design: P.design,
      chrome: 0,
      categories: P.category,
    });
  });

  it("never drops or lists carried work when the balance is small", () => {
    const { plan: fitted, productPhotoKeys } = fitRevampPlanToBudget(
      refinePlan(),
      { request: refineRequest(), budget: P.photo },
    );
    expect(fitted.pages.map((p) => p.slug)).toEqual(["", "about", "faq"]);
    expect(fitted.design).toEqual(plan().design);
    expect(fitted.shots.map((s) => s.id).sort()).toEqual(
      ["about-1", "cat-cold", "g1", "g2", "hero"].sort(),
    );
    // ★ The parent's products keep a studio photo, taken again at no charge:
    //   the products Apply creates from this version have no other one.
    expect(productPhotoKeys).toEqual(["p1", "p3"]);
    expect(fitted.skipped).toEqual(plan().skipped);
    expect(
      estimateRevampCredits(fitted, {
        request: refineRequest(),
        productPhotoKeys,
      }).total,
    ).toBe(P.photo);
  });

  it("still takes studio photos of the products a refinement adds", () => {
    const p = refinePlan();
    p.basis!.carried = { ...p.basis!.carried!, products: ["p1", "p2"] };
    const { productPhotoKeys } = fitRevampPlanToBudget(p, {
      request: refineRequest(),
      budget: 200,
    });
    expect(productPhotoKeys).toEqual(["p1", "p3"]);
    // Only the added product's photo is bought.
    expect(
      estimateRevampCredits(p, { request: refineRequest(), productPhotoKeys })
        .productPhotos,
    ).toBe(P.productPhoto);
  });

  it("lists only the added product's photo when the balance runs out, never the parent's", () => {
    const p = refinePlan();
    p.basis!.carried = { ...p.basis!.carried!, products: ["p1", "p2"] };
    const { plan: fitted, productPhotoKeys } = fitRevampPlanToBudget(p, {
      request: refineRequest(),
      budget: P.photo,
    });
    expect(productPhotoKeys).toEqual(["p1"]);
    expect(fitted.skipped.map((s) => s.label)).toEqual([
      ...plan().skipped.map((s) => s.label),
      "A studio photo of 1 product",
    ]);
  });
});

describe("revampProductPhotoKeys", () => {
  it("names the studio photos a revamp with no budget takes", () => {
    // A full revamp: every product with a photo, except one on the store.
    const full = plan();
    full.basis = {
      categories: 3,
      productKeys: ["p1", "p2", "p3"],
      existingProductKeys: ["p1"],
      carried: null,
    };
    expect(revampProductPhotoKeys(full, request())).toEqual(["p3"]);
    // A refinement: the parent's products too (no charge), unless on the store.
    expect(revampProductPhotoKeys(refinePlan(), refineRequest())).toEqual([
      "p1",
      "p3",
    ]);
    // A plan compiled before the basis existed: every product with a photo.
    expect(revampProductPhotoKeys(plan(), request())).toEqual(["p1", "p3"]);
  });
});

describe("revampFixedCreditCeiling (f-6)", () => {
  /** The parent as the runner hands it to the compiler: its compiled plan. */
  const parent = (): RevampSitePlan => ({
    ...plan(),
    basis: {
      categories: 3,
      categoryChanges: request().categories.map(revampCategoryChangeKey),
      productKeys: ["p1", "p2", "p3"],
      existingProductKeys: [],
      carried: null,
    },
  });
  const FULL_FLOOR = (categories: number) =>
    P.page + P.chrome + P.photo + categories * P.category;

  it("keeps a full revamp's floor: the homepage, the chrome, the opening photo and every category change", () => {
    expect(revampFixedCreditCeiling(request(), null)).toBe(FULL_FLOOR(3));
    // A parent never matters to a full revamp.
    expect(revampFixedCreditCeiling(request(), parent())).toBe(FULL_FLOOR(3));
    // A refinement whose parent plan cannot be read is held to the full floor.
    expect(revampFixedCreditCeiling(refineRequest(), null)).toBe(FULL_FLOOR(3));
  });

  it("★★ charges a look-only refinement just the header and footer it rewrites", () => {
    // "Make it warmer": no page is written, no photograph redrawn, and the
    // parent's category changes are carried by key.
    expect(
      revampFixedCreditCeiling(
        refineRequest({ design: true, photos: null }),
        parent(),
      ),
    ).toBe(P.chrome);
  });

  it("counts the opening photograph only when it is redrawn or the homepage is rewritten", () => {
    // "Redo the opening photo": the opening is the hero.
    expect(revampFixedCreditCeiling(refineRequest(), parent())).toBe(P.photo);
    expect(
      revampFixedCreditCeiling(refineRequest({ photos: ["Hero"] }), parent()),
    ).toBe(P.photo);
    expect(
      revampFixedCreditCeiling(refineRequest({ photos: "all" }), parent()),
    ).toBe(P.photo);
    expect(
      revampFixedCreditCeiling(refineRequest({ photos: ["g1"] }), parent()),
    ).toBe(0);
    // New words on the homepage: its words, its chrome and its opening.
    expect(
      revampFixedCreditCeiling(
        refineRequest({ copy: true, photos: null }),
        parent(),
      ),
    ).toBe(P.page + P.chrome + P.photo);
    // New words on another page only: the homepage is carried as it was.
    expect(
      revampFixedCreditCeiling(
        refineRequest({ copy: true, photos: null, pages: ["about"] }),
        parent(),
      ),
    ).toBe(P.chrome);
  });

  it("counts only the category changes the parent did not make", () => {
    const req = refineRequest({ photos: null });
    req.categories = [
      ...req.categories,
      {
        action: "create",
        name: "Gift Sets",
        slug: null,
        description: null,
        newPhoto: false,
      },
    ];
    expect(revampFixedCreditCeiling(req, parent())).toBe(P.category);
    // A parent that recorded no keys made none this can prove.
    const older = parent();
    delete older.basis!.categoryChanges;
    expect(revampFixedCreditCeiling(req, older)).toBe(4 * P.category);
  });

  it("★ a budget of exactly the ceiling always pays what the fit reserves", () => {
    // refinePlan() is refineRequest()'s compiled plan: every page carried,
    // the hero redrawn, the parent's three category changes carried.
    const ceiling = revampFixedCreditCeiling(refineRequest(), parent());
    const { plan: fitted, productPhotoKeys } = fitRevampPlanToBudget(
      refinePlan(),
      { request: refineRequest(), budget: ceiling },
    );
    expect(
      estimateRevampCredits(fitted, {
        request: refineRequest(),
        productPhotoKeys,
      }).total,
    ).toBeLessThanOrEqual(ceiling);
  });
});

describe("revampCarriedProductPhotoKeys (f-5)", () => {
  it("★★ carries over exactly the studio photos the card charges nothing for", () => {
    // A product the refinement adds (p3 is not the parent's) is drawn.
    const p = refinePlan();
    p.basis!.carried = { ...p.basis!.carried!, products: ["p1", "p2"] };
    const carried = revampCarriedProductPhotoKeys(p, refineRequest());
    expect(carried).toEqual(["p1"]);
    expect(
      estimateRevampCredits(p, {
        request: refineRequest(),
        productPhotoKeys: carried,
      }).productPhotos,
    ).toBe(0);
    // ★ About the products: nothing is carried, every photo is charged.
    expect(
      revampCarriedProductPhotoKeys(p, refineRequest({ products: true })),
    ).toEqual([]);
    // A product the store already has is not created, so nothing is taken.
    p.basis!.existingProductKeys = ["p1"];
    expect(revampCarriedProductPhotoKeys(p, refineRequest())).toEqual([]);
    // A full revamp carries nothing.
    expect(revampCarriedProductPhotoKeys(plan(), request())).toEqual([]);
  });
});

describe("products the store already has (known-1b)", () => {
  it("takes no studio photo of a product that will not be created", () => {
    const p = plan();
    p.basis = {
      categories: 3,
      productKeys: ["p1", "p2", "p3"],
      existingProductKeys: ["p1"],
      carried: null,
    };
    const { productPhotoKeys, plan: fitted } = fitRevampPlanToBudget(p, {
      request: request(),
      budget: 200,
    });
    expect(productPhotoKeys).toEqual(["p3"]);
    expect(fitted.skipped.map((s) => s.label)).not.toContain(
      "A studio photo of 1 product",
    );
  });
});

// ---------------------------------------------------------------------------
// A blank announcement over the theme's sample line (output-2).
// ---------------------------------------------------------------------------

describe("a blank announcement over the theme's sample line (output-2)", () => {
  const THEME_LINE = {
    text: "White-glove delivery across Bengaluru, assembled in your room",
    href: "/delivery",
  };

  /** The next chrome's bar for a plan with no announcement of its own. */
  const nextBar = (
    bar: { enabled: boolean; text: string; href: string },
    themeLine: { text: string; href: string } | null | undefined,
  ) => {
    const snap = snapshot();
    snap.theme = { ...snap.theme, announcement: themeLine };
    if (themeLine === undefined) delete snap.theme.announcement;
    snap.chrome = {
      ...snap.chrome,
      value: sanitizeChromeForSave({ header: { announcement: bar } }),
    };
    const p = plan();
    p.announcement = { text: "", href: "" };
    const stored = assembleRevampPlan({
      revampId: "rv1",
      request: request(),
      snapshot: snap,
      plan: p,
      images: [],
      outcomes: [],
      productFailures: [],
      free: true,
      canChangeBrand: true,
    });
    return {
      bar: stored.chrome!.next.header.announcement,
      notes: stored.notes,
    };
  };

  it("★★ switches off a bar that would show the theme's sample line", () => {
    const { bar, notes } = nextBar(
      { enabled: true, text: "", href: "" },
      THEME_LINE,
    );
    expect(bar.enabled).toBe(false);
    expect(notes.join(" ")).toMatch(/announcement bar/i);
  });

  it("switches off a bar holding exactly the theme's words", () => {
    const { bar } = nextBar(
      { enabled: true, text: THEME_LINE.text, href: "/delivery" },
      THEME_LINE,
    );
    expect(bar.enabled).toBe(false);
  });

  it("★ switches off an empty bar when the snapshot never read the theme's line", () => {
    expect(
      nextBar({ enabled: true, text: "", href: "" }, undefined).bar,
    ).toMatchObject({ enabled: false });
  });

  it("keeps the merchant's own line, a bar they switched off, and a bar no theme line fills", () => {
    const own = nextBar(
      { enabled: true, text: "Fresh oil every Monday", href: "" },
      THEME_LINE,
    );
    expect(own.bar).toMatchObject({
      enabled: true,
      text: "Fresh oil every Monday",
    });
    expect(own.notes.join(" ")).not.toMatch(/announcement bar/i);
    expect(
      nextBar({ enabled: false, text: "", href: "" }, THEME_LINE).bar.enabled,
    ).toBe(false);
    const none = nextBar({ enabled: true, text: "", href: "" }, null);
    expect(none.bar).toMatchObject({ enabled: true, text: "" });
    expect(none.notes.join(" ")).not.toMatch(/announcement bar/i);
  });

  it("writes the plan's own line over the theme's whatever the bar held", () => {
    const snap = snapshot();
    snap.theme = { ...snap.theme, announcement: THEME_LINE };
    const stored = assembleRevampPlan({
      revampId: "rv1",
      request: request(),
      snapshot: snap,
      plan: plan(),
      images: [],
      outcomes: [],
      productFailures: [],
      free: true,
      canChangeBrand: true,
    });
    expect(stored.chrome!.next.header.announcement).toMatchObject({
      enabled: true,
      text: "Free delivery over 999",
    });
  });
});
