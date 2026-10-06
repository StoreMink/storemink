import { describe, expect, it } from "vitest";
import { buildShopFacets, facetValueLabel } from "./shop-facets";
import { DEFAULT_SHOP_QUERY, type ShopQuery } from "./shop-filters";
import { shopFactsFor, type FacetableProduct } from "./shop-product-facts";

const stock = {
  track_inventory: true,
  low_stock_threshold: null,
  allow_backorder: false,
};

function variant(values: string[], price: number, inStock = true) {
  return {
    ...stock,
    base_price: price,
    selling_price: price,
    special_price: null,
    stock: inStock ? 5 : 0,
    option_values: values,
  };
}

const tee: FacetableProduct = {
  name: "Tee",
  category_id: "c-men",
  base_price: 999,
  selling_price: 699,
  ...stock,
  stock: 10,
  options: [
    { name: "Size", values: ["L", "S", "M", "XL"] },
    {
      name: "Colour",
      values: ["Black", "White"],
      swatches: { Black: "#111111", White: "#ffffff" },
    },
  ],
  variants: [
    variant(["S", "Black"], 699),
    variant(["M", "Black"], 699, false),
    variant(["L", "White"], 799),
  ],
};

const jeans: FacetableProduct = {
  name: "Jeans",
  category_id: "c-men",
  base_price: 1999,
  selling_price: 1499,
  ...stock,
  stock: 10,
  options: [{ name: "Size", values: ["30", "32", "M"] }],
  variants: [variant(["32"], 1499), variant(["M"], 1499)],
};

const bag: FacetableProduct = {
  name: "Bag",
  category_id: "c-acc",
  base_price: 2999,
  selling_price: 2499,
  ...stock,
  stock: 3,
  options: [],
  variants: [],
};

const slugs = new Map([
  ["c-men", "men"],
  ["c-acc", "accessories"],
]);
const facts = (p: FacetableProduct) => shopFactsFor(p, slugs);
const categories = [
  { slug: "men", name: "Men" },
  { slug: "women", name: "Women" },
  { slug: "accessories", name: "Accessories" },
];
const q = (patch: Partial<ShopQuery> = {}): ShopQuery => ({
  ...DEFAULT_SHOP_QUERY,
  ...patch,
});

describe("buildShopFacets", () => {
  it("lists categories present in scope, in store order", () => {
    const view = buildShopFacets([tee, jeans, bag], q(), facts, categories);
    const category = view.facets.find((f) => f.key === "category")!;
    expect(category.values.map((v) => [v.label, v.count])).toEqual([
      ["Men", 2],
      ["Accessories", 1],
    ]);
  });

  it("hides the category filter on a collection page", () => {
    const view = buildShopFacets([tee, jeans], q(), facts, null);
    expect(view.facets.some((f) => f.key === "category")).toBe(false);
  });

  it("merges an option across products and orders sizes by wear", () => {
    const view = buildShopFacets([tee, jeans], q(), facts, null);
    const size = view.facets.find((f) => f.key === "size")!;
    expect(size.kind).toBe("size");
    expect(size.values.map((v) => v.label)).toEqual([
      "S",
      "M",
      "L",
      "XL",
      "30",
      "32",
    ]);
    // M exists on both products; XL is declared but has no variant.
    expect(size.values.find((v) => v.key === "m")!.count).toBe(2);
    expect(size.values.find((v) => v.key === "xl")!.count).toBe(0);
  });

  it("is a colour filter with swatches", () => {
    const view = buildShopFacets([tee], q(), facts, null);
    const color = view.facets.find((f) => f.key === "color")!;
    expect(color.kind).toBe("color");
    expect(color.label).toBe("Colour");
    expect(color.values[0]).toMatchObject({
      label: "Black",
      swatch: "#111111",
    });
  });

  it("counts each list against the OTHER filters, not its own", () => {
    const view = buildShopFacets(
      [tee, jeans],
      q({ options: { size: ["s"] } }),
      facts,
      null,
    );
    const size = view.facets.find((f) => f.key === "size")!;
    // Adding M would show both products, even though S is ticked.
    expect(size.values.find((v) => v.key === "m")!.count).toBe(2);
    // Colour lists only what an S variant offers.
    const color = view.facets.find((f) => f.key === "color")!;
    expect(color.values.map((v) => [v.key, v.count])).toEqual([
      ["black", 1],
      ["white", 0],
    ]);
    expect(view.total).toBe(1);
  });

  it("counts in-stock against the variant that matches", () => {
    // Only the tee has an M in black, and it is sold out.
    const view = buildShopFacets(
      [tee],
      q({ options: { size: ["m"] } }),
      facts,
      null,
    );
    expect(view.inStockCount).toBe(0);
  });

  it("spans the prices still reachable through the other filters", () => {
    const view = buildShopFacets(
      [tee, jeans, bag],
      q({ categories: ["men"], min: 1000 }),
      facts,
      categories,
    );
    expect(view.span).toEqual({ min: 699, max: 1499 });
  });

  it("keeps a ticked value listed when it no longer exists in scope", () => {
    const view = buildShopFacets(
      [bag],
      q({ options: { size: ["xl"] } }),
      facts,
      null,
    );
    const size = view.facets.find((f) => f.key === "size")!;
    expect(size.values).toEqual([
      { key: "xl", label: "xl", count: 0, selected: true },
    ]);
    expect(facetValueLabel(view, "size", "xl")).toBe("xl");
  });

  it("drops a filter that offers only one value", () => {
    const view = buildShopFacets([bag], q(), facts, categories);
    expect(view.facets).toEqual([]);
  });
});

describe("size order", () => {
  it("sorts sizes by the number inside them", () => {
    const shoe = (values: string[]): FacetableProduct => ({
      ...bag,
      options: [{ name: "Size", values }],
      variants: values.map((v) => variant([v], 999)),
    });
    const view = buildShopFacets(
      [shoe(["UK 10", "UK 6", "UK 8"]), shoe(["105cm", "85cm"])],
      q(),
      facts,
      null,
    );
    expect(view.facets[0].values.map((v) => v.label)).toEqual([
      "UK 6",
      "UK 8",
      "UK 10",
      "85cm",
      "105cm",
    ]);
  });
});

describe("shopFactsFor", () => {
  it("ignores option values that do not line up with the axes", () => {
    const legacy = {
      ...tee,
      variants: [{ ...variant(["Large"], 699) }],
    };
    expect(facts(legacy).variants![0].values).toEqual({});
  });

  it("prices each variant at what checkout charges", () => {
    const onSale = {
      ...tee,
      variants: [{ ...variant(["S", "Black"], 699), special_price: 499 }],
    };
    expect(facts(onSale).variants![0].price).toBe(499);
  });
});
