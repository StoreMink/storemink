import { describe, expect, it } from "vitest";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import type { RevampStoredPlan } from "./contract";
import { toRevampReview } from "./review";

function plan(overrides: Partial<RevampStoredPlan> = {}): RevampStoredPlan {
  return {
    schemaVersion: 2,
    revampId: "11111111-1111-4111-8111-111111111111",
    kind: "full",
    summary: "A warm, bright store for cold-pressed oils.",
    pages: [
      {
        pageId: "22222222-2222-4222-8222-222222222222",
        slug: "",
        title: "Home",
        seoTitle: "Home",
        seoDescription: "Cold-pressed oils from our own press.",
        create: false,
        expectedVersion: "2026-10-21 10:00:00.123456+00",
        expectedDigest: "digest-home",
        sections: [
          {
            id: "hero-1",
            type: "hero",
            enabled: true,
            config: { heading: "Pressed this week" },
          } as never,
        ],
        proposedDigest: "proposed-home",
        changes: { added: 3, removed: 2, kept: 1, photos: 4 },
      },
      {
        pageId: null,
        slug: "our-process",
        title: "Our process",
        seoTitle: "Our process",
        seoDescription: "How we press mustard seed in our own facility.",
        create: true,
        expectedVersion: null,
        expectedDigest: null,
        sections: [],
        proposedDigest: "proposed-process",
        changes: { added: 2, removed: 0, kept: 0, photos: 1 },
      },
    ],
    chrome: {
      expectedVersion: null,
      expectedDigest: "chrome-digest",
      next: DEFAULT_CHROME,
    },
    brand: { expectedDigest: "brand", tagline: "Pressed fresh", blurb: null },
    categories: [
      {
        action: "create",
        slug: "oils",
        name: "Oils",
        description: "Every oil we press",
        imageUrl: "https://storage.googleapis.com/b/stores/s/oils.webp",
      },
      {
        action: "update",
        id: "33333333-3333-4333-8333-333333333333",
        slug: "fruit",
        expectedUpdatedAt: "2026-10-21 10:00:00+00",
        before: { name: "Fruit", description: null, imageUrl: null },
        name: "Seeds",
        description: null,
        imageUrl: null,
      },
      {
        action: "hide",
        id: "44444444-4444-4444-8444-444444444444",
        slug: "dairy",
        expectedUpdatedAt: "2026-10-21 10:00:00+00",
        name: "Dairy",
      },
    ],
    products: {
      hide: [
        { id: "p-sample-1", name: "Apples (Sample)", expectedUpdatedAt: "x" },
        { id: "p-sample-2", name: "Milk (Sample)", expectedUpdatedAt: "x" },
      ],
      create: [
        {
          key: "p1",
          name: "Mustard oil",
          slug: "mustard-oil",
          description: "Cold pressed.",
          categorySlug: "oils",
          imageUrl: "https://storage.googleapis.com/b/stores/s/p1.webp",
          sourceImageUrl:
            "https://storage.googleapis.com/b/stores/s/p1-src.jpg",
          options: [{ name: "Size", values: ["500 ml", "1 l"] }],
          variants: [
            { name: "1 l", optionValues: ["1 l"], price: 349, mrp: 399 },
            { name: "500 ml", optionValues: ["500 ml"], price: 199, mrp: null },
          ],
          price: 199,
          mrp: null,
        },
        {
          key: "p2",
          name: "Sesame oil",
          slug: "sesame-oil",
          description: "",
          categorySlug: null,
          imageUrl: null,
          sourceImageUrl:
            "https://storage.googleapis.com/b/stores/s/p2-src.jpg",
          options: [],
          variants: [],
          price: 250,
          mrp: 300,
        },
      ],
    },
    photos: [
      {
        url: "https://storage.googleapis.com/b/stores/s/hero.webp",
        path: "stores/s/hero.webp",
        alt: "Mustard seed in the press",
        where: "Home, opening photograph",
      },
    ],
    checks: [
      { id: "links", label: "Every link works", passed: true, note: null },
      {
        id: "english",
        label: "English copy",
        passed: false,
        note: "One heading was rewritten.",
      },
    ],
    skipped: [{ label: "About page photos", reason: "Not covered this time" }],
    notes: ["The hero uses your own press photo."],
    explanation: "Rebuilt for a cold-press oil brand.",
    credits: {
      pages: 0,
      photos: 0,
      design: 0,
      chrome: 0,
      categories: 0,
      productPhotos: 0,
      total: 0,
    },
    free: true,
    ...overrides,
  };
}

describe("toRevampReview", () => {
  it("maps every page with its sections and change counts", () => {
    const review = toRevampReview(plan());
    expect(review.summary).toBe("A warm, bright store for cold-pressed oils.");
    expect(review.pages).toEqual([
      {
        slug: "",
        title: "Home",
        create: false,
        sections: [expect.objectContaining({ id: "hero-1", type: "hero" })],
        changes: { added: 3, removed: 2, kept: 1, photos: 4 },
      },
      expect.objectContaining({
        slug: "our-process",
        create: true,
        changes: { added: 2, removed: 0, kept: 0, photos: 1 },
      }),
    ]);
  });

  it("hands the card the proposed chrome draft", () => {
    expect(toRevampReview(plan()).chrome).toEqual(DEFAULT_CHROME);
    expect(toRevampReview(plan({ chrome: null })).chrome).toBeNull();
  });

  it("lists products at their cheapest size, with every size named", () => {
    const [oil, sesame] = toRevampReview(plan()).products;
    expect(oil).toEqual({
      key: "p1",
      name: "Mustard oil",
      imageUrl: "https://storage.googleapis.com/b/stores/s/p1.webp",
      price: 199,
      mrp: null,
      categorySlug: "oils",
      sizes: ["1 l", "500 ml"],
      sizePrices: [
        { label: "1 l", price: 349, mrp: 399 },
        { label: "500 ml", price: 199, mrp: null },
      ],
    });
    // One size: the product's own price, and the merchant's photo until a
    // studio photo exists.
    expect(sesame).toEqual({
      key: "p2",
      name: "Sesame oil",
      imageUrl: "https://storage.googleapis.com/b/stores/s/p2-src.jpg",
      price: 250,
      mrp: 300,
      categorySlug: null,
      sizes: [],
      sizePrices: [],
    });
  });

  it("★ carries every size with its own price and MRP, in the merchant's order", () => {
    const [oil, sesame] = toRevampReview(plan()).products;
    // Each size goes live at Apply at its own price, so each one is reviewed.
    expect(oil.sizePrices).toEqual([
      { label: "1 l", price: 349, mrp: 399 },
      { label: "500 ml", price: 199, mrp: null },
    ]);
    // One size: the product's own price is the whole story.
    expect(sesame.sizePrices).toEqual([]);
  });

  it("names sizes from the options when the plan wrote no variant rows", () => {
    const base = plan();
    const review = toRevampReview(
      plan({
        products: {
          hide: [],
          create: [
            {
              ...base.products.create[0],
              variants: [],
            },
          ],
        },
      }),
    );
    expect(review.products[0].sizes).toEqual(["500 ml", "1 l"]);
    expect(review.products[0].price).toBe(199);
  });

  it("words each category change in plain English", () => {
    expect(toRevampReview(plan()).categories).toEqual([
      {
        action: "New category",
        name: "Oils",
        imageUrl: "https://storage.googleapis.com/b/stores/s/oils.webp",
      },
      { action: "Renamed from Fruit", name: "Seeds", imageUrl: null },
      { action: "Hidden from your shop", name: "Dairy", imageUrl: null },
    ]);
  });

  it("says what an update without a rename changes", () => {
    const update = (patch: Record<string, unknown>) =>
      toRevampReview(
        plan({
          categories: [
            {
              action: "update",
              id: "c1",
              slug: "seeds",
              expectedUpdatedAt: "x",
              before: { name: "Seeds", description: "Old", imageUrl: null },
              name: "Seeds",
              description: "Old",
              imageUrl: null,
              ...patch,
            } as never,
          ],
        }),
      ).categories[0].action;
    expect(update({ imageUrl: "https://x/new.webp" })).toBe("New photo");
    expect(update({ description: "New words" })).toBe("New description");
    expect(
      update({ imageUrl: "https://x/new.webp", description: "New words" }),
    ).toBe("New photo and description");
    expect(update({})).toBe("Updated");
  });

  it("★ hands the preview canvas the categories as Apply leaves them and the samples it takes off", () => {
    expect(toRevampReview(plan()).canvas).toEqual({
      categories: [
        {
          // A new category has no id yet: the canvas gets a stable stand-in.
          id: "revamp-category-oils",
          slug: "oils",
          name: "Oils",
          imageUrl: "https://storage.googleapis.com/b/stores/s/oils.webp",
          description: "Every oil we press",
          hidden: false,
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          slug: "fruit",
          name: "Seeds",
          imageUrl: null,
          description: null,
          hidden: false,
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          slug: "dairy",
          name: "Dairy",
          imageUrl: null,
          description: null,
          hidden: true,
        },
      ],
      hiddenProductIds: ["p-sample-1", "p-sample-2"],
      // The plan rewrites the tagline and leaves the footer description.
      brand: { tagline: "Pressed fresh", blurb: null },
    });
  });

  it("★ hands the canvas the tagline and footer description Apply writes, null for a half it leaves", () => {
    const canvasBrand = (tagline: string | null, blurb: string | null) =>
      toRevampReview(
        plan({ brand: { expectedDigest: "brand", tagline, blurb } }),
      ).canvas?.brand;
    expect(canvasBrand(null, "Family run since 1998")).toEqual({
      tagline: null,
      blurb: "Family run since 1998",
    });
    expect(canvasBrand("Pressed fresh", "Family run")).toEqual({
      tagline: "Pressed fresh",
      blurb: "Family run",
    });
    // Nothing to say when the plan changes neither, or has no brand at all.
    expect(canvasBrand(null, null)).toBeUndefined();
    expect(toRevampReview(plan({ brand: null })).canvas).not.toHaveProperty(
      "brand",
    );
  });

  it("counts the hidden sample products and states what goes live at once", () => {
    const review = toRevampReview(plan());
    expect(review.hiddenSampleProducts).toBe(2);
    expect(review.liveChanges).toEqual([
      "Your categories",
      "Your 2 products go on your shop",
      "The theme's sample products are taken off your shop",
      // ★ The plan rewrites the tagline only, so only the tagline is named.
      "Your store's tagline",
    ]);
  });

  it("names exactly the half of the store description the plan rewrites", () => {
    const brand = (tagline: string | null, blurb: string | null) =>
      toRevampReview(
        plan({
          categories: [],
          products: { hide: [], create: [] },
          brand: { expectedDigest: "brand", tagline, blurb },
        }),
      ).liveChanges;
    expect(brand("Pressed fresh", "Family run")).toEqual([
      "Your store's tagline and footer description",
    ]);
    expect(brand(null, "Family run")).toEqual([
      "Your store's footer description",
    ]);
    expect(brand(null, null)).toEqual([]);
  });

  it("states nothing live when nothing without a draft changes", () => {
    const review = toRevampReview(
      plan({ categories: [], products: { hide: [], create: [] }, brand: null }),
    );
    expect(review.liveChanges).toEqual([]);
    expect(review.hiddenSampleProducts).toBe(0);
  });

  it("copies photos, checks, the skipped list and notes", () => {
    const review = toRevampReview(plan());
    expect(review.photos).toHaveLength(1);
    expect(review.checks.map((check) => check.id)).toEqual([
      "links",
      "english",
    ]);
    expect(review.skipped).toEqual([
      { label: "About page photos", reason: "Not covered this time" },
    ]);
    expect(review.notes).toEqual(["The hero uses your own press photo."]);
  });

  it("★ leaves out a malformed entry instead of throwing at the card", () => {
    const broken = {
      ...plan(),
      summary: 42,
      pages: [null, { slug: "x" }, plan().pages[0]],
      categories: ["junk", { action: "rename", name: "x" }],
      products: { hide: "nope", create: [{ key: 1 }] },
      photos: [{ url: "https://x" }],
      checks: [{ id: "a", label: "b", passed: "yes" }],
      skipped: [{ label: "only" }],
      notes: ["", 7, "kept"],
      chrome: { next: "not a chrome" },
    } as unknown as RevampStoredPlan;
    const review = toRevampReview(broken);
    expect(review).toEqual({
      summary: "",
      pages: [expect.objectContaining({ slug: "" })],
      chrome: null,
      photos: [],
      products: [],
      categories: [],
      hiddenSampleProducts: 0,
      // The brand entry was still readable, so its live change still shows.
      liveChanges: ["Your store's tagline"],
      checks: [],
      skipped: [],
      notes: ["kept"],
      canvas: {
        categories: [],
        hiddenProductIds: [],
        // Readable, so the "after" footer gets it like the live change above.
        brand: { tagline: "Pressed fresh", blurb: null },
      },
    });
  });

  it("survives a plan with every list missing", () => {
    const review = toRevampReview({
      schemaVersion: 2,
    } as unknown as RevampStoredPlan);
    expect(review.pages).toEqual([]);
    expect(review.products).toEqual([]);
    expect(review.liveChanges).toEqual([]);
  });

  it("never carries a long dash in its own words", () => {
    const words = JSON.stringify(toRevampReview(plan()).categories);
    expect(words).not.toMatch(/[–—]/);
  });
});
