import { describe, expect, it } from "vitest";
import {
  defaultTemplates,
  hasProductBlock,
  normalizeProductBlocks,
  normalizeTemplates,
  splitProductBlocks,
  templateHref,
  templateIssues,
  themeTemplates,
} from "./templates";

// Plan Phase 2e: the product and collection pages composed from data.

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
describe("default templates", () => {
  it("are today's pages exactly, with the sticky bar following the layout", () => {
    const plain = defaultTemplates(undefined);
    expect(plain.product.gallery).toBe("thumbs-bottom");
    expect(plain.product.blocks.map((b) => b.type)).toEqual([
      "price",
      "share",
      "variant_picker",
      "delivery_estimate",
      "buy_box",
      "description",
      "reviews",
      "recommendations",
    ]);
    expect(plain.collection).toEqual({
      filters: "sidebar",
      pagination: "load-more",
      promoTiles: [],
    });
    expect(
      hasProductBlock(
        defaultTemplates({ stickyAddToCart: true }).product,
        "sticky_bar",
      ),
    ).toBe(true);
    // A theme without the field renders its layout's composition.
    expect(
      themeTemplates({ design: { layout: { stickyAddToCart: true } } }),
    ).toEqual(defaultTemplates({ stickyAddToCart: true }));
  });
});

describe("normalising", () => {
  it("keeps order, drops unknown and empty blocks, dedupes and appends the commerce blocks", () => {
    const blocks = normalizeProductBlocks(
      [
        { type: "description" },
        {
          type: "trust_row",
          items: [{ icon: "truck", label: "Free delivery" }],
        },
        { type: "trust_row", items: [{ icon: "star", label: "Again" }] },
        { type: "accordion", rows: [] },
        { type: "rich_text", html: "  " },
        { type: "mystery" },
        { type: "sticky_bar" },
      ],
      [],
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "description",
      "trust_row",
      "sticky_bar",
      "price",
      "buy_box",
    ]);
    expect(blocks[1]).toEqual({
      type: "trust_row",
      items: [{ icon: "truck", label: "Free delivery" }],
    });
    // An unknown icon falls back to the catalogue's first.
    expect(
      normalizeProductBlocks(
        [{ type: "trust_row", items: [{ icon: "nope", label: "x" }] }],
        [],
      )[0],
    ).toEqual({ type: "trust_row", items: [{ icon: "star", label: "x" }] });
  });

  it("completes a partial value against the fallback and bounds promo tiles", () => {
    const fallback = defaultTemplates({ stickyAddToCart: true });
    const out = normalizeTemplates(
      {
        product: { gallery: "grid" },
        collection: {
          filters: "top-bar",
          pagination: "nope",
          promoTiles: [
            { afterIndex: 0, heading: "Sale", href: "javascript:alert(1)" },
            {
              afterIndex: 99,
              image_url: "/x.webp",
              background: "#fff",
              theme: "light",
            },
            { body: "no heading, no image" },
            { afterIndex: "3", heading: "A" },
            { afterIndex: 4, heading: "B" },
            { afterIndex: 5, heading: "C" },
          ],
        },
      },
      fallback,
    );
    expect(out.product.gallery).toBe("grid");
    expect(out.product.blocks).toEqual(fallback.product.blocks);
    expect(out.collection.filters).toBe("top-bar");
    expect(out.collection.pagination).toBe("load-more");
    expect(out.collection.promoTiles).toHaveLength(4);
    expect(out.collection.promoTiles[0]).toMatchObject({
      afterIndex: 1,
      heading: "Sale",
      href: "",
    });
    expect(out.collection.promoTiles[1]).toMatchObject({
      afterIndex: 48,
      background: "#fff",
      theme: "light",
    });
    expect(templateHref("//evil")).toBe("");
    expect(templateHref("/collections/sale")).toBe("/collections/sale");
  });

  it("splits blocks by where they render", () => {
    const split = splitProductBlocks(
      defaultTemplates({ stickyAddToCart: true }).product.blocks,
    );
    expect(split.info.map((b) => b.type)).toEqual([
      "price",
      "share",
      "variant_picker",
      "delivery_estimate",
      "buy_box",
      "description",
    ]);
    expect(split.page.map((b) => b.type)).toEqual([
      "reviews",
      "recommendations",
    ]);
    expect(split.sticky).toBe(true);
  });
});

describe("the contract's report", () => {
  it("is empty for a value the renderer shows as written", () => {
    expect(templateIssues(defaultTemplates(undefined))).toEqual([]);
    expect(
      templateIssues({
        product: {
          gallery: "stacked",
          blocks: [
            { type: "price" },
            { type: "buy_box" },
            { type: "rich_text", html: "<p>Hello</p>" },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("holds for a stored value whose keys jsonb has re-ordered", () => {
    // Found by the exemplar seed (2026-10-09): the block and tile checks
    // compared JSON.stringify output, so every package carrying templates
    // was refused by the registry's parse on the way back out of
    // theme_releases, and the store rendered un-themed.
    const authored = {
      product: {
        gallery: "grid",
        blocks: [
          { type: "price" },
          { type: "variant_picker" },
          { type: "buy_box" },
          {
            type: "accordion",
            rows: [{ heading: "Care", body: "Wipe clean." }],
          },
          {
            type: "trust_row",
            items: [{ icon: "truck", label: "Free delivery" }],
          },
          { type: "sticky_bar" },
        ],
      },
      collection: {
        filters: "top-bar",
        pagination: "paged",
        promoTiles: [
          {
            afterIndex: 4,
            heading: "New season",
            body: "Fresh arrivals.",
            cta_label: "Shop",
            href: "/shop",
            image_url: "",
            image_alt: "",
            theme: "dark",
            background: "#112233",
          },
        ],
      },
    };
    expect(templateIssues(authored)).toEqual([]);
    const stored = jsonbRoundTrip(authored);
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(authored));
    expect(templateIssues(stored)).toEqual([]);
    const fallback = defaultTemplates(undefined);
    expect(normalizeTemplates(stored, fallback)).toEqual(
      normalizeTemplates(authored, fallback),
    );
  });

  it("names what normalising would silently change", () => {
    const issues = templateIssues({
      product: {
        gallery: "mosaic",
        blocks: [
          { type: "buy_box" },
          { type: "buy_box" },
          { type: "accordion", rows: [] },
          {
            type: "trust_row",
            items: [{ icon: "truck", label: "x", extra: 1 }],
          },
          { type: "nope" },
        ],
      },
      collection: {
        filters: "left",
        pagination: "paged",
        promoTiles: [
          { body: "only" },
          { afterIndex: 2, heading: "Ok", href: "data:x" },
        ],
        other: true,
      },
      wishlist: {},
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("wishlist is not a template"),
        expect.stringContaining("product.gallery must be one of"),
        expect.stringContaining("blocks[1] repeats buy_box"),
        expect.stringContaining("blocks[2] (accordion) is empty"),
        expect.stringContaining("blocks[3] (trust_row) has extra"),
        expect.stringContaining("blocks[4] must be one of"),
        expect.stringContaining("product.blocks must include price"),
        expect.stringContaining("collection.other is not"),
        expect.stringContaining("collection.filters must be one of"),
        expect.stringContaining("promoTiles[0] needs a heading"),
        expect.stringContaining("promoTiles[1] has extra"),
      ]),
    );
  });
});

// Plan Phase 2e, second slice: the size guide block, and the blog and
// account templates.
describe("the size guide, blog and account templates", () => {
  it("defaults to today's pages: a grid of posts, a reading column, plain account pages", () => {
    const plain = defaultTemplates(undefined);
    expect(plain.blog).toEqual({ index: "grid", article: "narrow" });
    expect(plain.account).toEqual({ layout: "plain", scheme: "" });
  });

  it("normalises a size guide to one cell per column and drops an empty one", () => {
    const [guide] = normalizeProductBlocks(
      [
        {
          type: "size_guide",
          columns: ["Chest", " Waist ", "", "Hip"],
          sizes: [
            { label: "S", values: ["86", "70"] },
            { label: "M", values: ["90", "74", "96", "extra"] },
            { label: "", values: ["1"] },
          ],
        },
      ],
      [],
    );
    expect(guide).toEqual({
      type: "size_guide",
      columns: ["Chest", "Waist", "Hip"],
      sizes: [
        { label: "S", values: ["86", "70", ""] },
        { label: "M", values: ["90", "74", "96"] },
      ],
    });
    expect(
      normalizeProductBlocks(
        [
          {
            type: "size_guide",
            columns: [],
            sizes: [{ label: "S", values: [] }],
          },
        ],
        [],
      ).map((b) => b.type),
    ).toEqual(["price", "buy_box"]);
  });

  it("coerces the blog and account templates, reading a null scheme as the page's colours", () => {
    const fallback = defaultTemplates(undefined);
    const out = normalizeTemplates(
      {
        blog: { index: "featured", article: "nope" },
        account: { layout: "sidebar", scheme: null },
      },
      fallback,
    );
    expect(out.blog).toEqual({ index: "featured", article: "narrow" });
    expect(out.account).toEqual({ layout: "sidebar", scheme: "" });
    expect(
      normalizeTemplates({ account: { scheme: "inverse" } }, fallback).account,
    ).toEqual({ layout: "plain", scheme: "inverse" });
    expect(normalizeTemplates({}, fallback)).toEqual(fallback);
  });

  it("the contract names an empty size guide, a bad layout and a bad scheme", () => {
    expect(
      templateIssues({
        product: {
          gallery: "grid",
          blocks: [
            { type: "price" },
            { type: "buy_box" },
            {
              type: "size_guide",
              columns: ["Chest"],
              sizes: [{ label: "S", values: ["86"] }],
            },
          ],
        },
        blog: { index: "list", article: "sidebar" },
        account: { layout: "tabs", scheme: "tint" },
      }),
    ).toEqual([]);
    expect(
      templateIssues({
        product: {
          gallery: "grid",
          blocks: [
            { type: "price" },
            { type: "buy_box" },
            { type: "size_guide", columns: [], sizes: [] },
          ],
        },
        blog: { index: "masonry", article: "narrow", foo: 1 },
        account: { layout: "plain", scheme: "neon" },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("blocks[2] (size_guide) is empty"),
        expect.stringContaining("blog.index must be one of"),
        expect.stringContaining("blog.foo is not"),
        expect.stringContaining('account.scheme must be "" or one of'),
      ]),
    );
  });
});
