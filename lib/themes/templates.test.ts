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
      blog: {},
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("blog is not a template"),
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
