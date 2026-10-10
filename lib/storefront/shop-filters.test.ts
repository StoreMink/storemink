import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  applyShopQuery,
  clearedShopQuery,
  facetKey,
  matchesShopQuery,
  toggleCategory,
  toggleOptionValue,
  valueKey,
  DEFAULT_SHOP_QUERY,
  parseShopQuery,
  priceSpan,
  shopQueryEntries,
  withShopQuery,
  type ShopFacts,
  pageNumbers,
} from "./shop-filters";

type Row = { id: string } & ShopFacts;

const rows: Row[] = [
  {
    id: "a",
    name: "Mango",
    price: 300,
    soldOut: false,
    createdAt: "2026-01-01",
  },
  {
    id: "b",
    name: "apple",
    price: 100,
    soldOut: true,
    createdAt: "2026-03-01",
  },
  {
    id: "c",
    name: "Banana",
    price: 200,
    soldOut: false,
    createdAt: "2026-02-01",
  },
  { id: "d", name: "Cherry", price: 200, soldOut: false, createdAt: null },
];
const ids = (list: Row[]) => list.map((r) => r.id);
const apply = (params: Record<string, string>) =>
  ids(applyShopQuery(rows, parseShopQuery(params), (r) => r));

describe("parseShopQuery", () => {
  it("returns the defaults for an empty or junk query", () => {
    expect(parseShopQuery({})).toEqual(DEFAULT_SHOP_QUERY);
    expect(
      parseShopQuery({ sort: "cheapest", stock: "yes", min: "abc", page: "0" }),
    ).toEqual(DEFAULT_SHOP_QUERY);
  });

  it("reads every key, from a record or URLSearchParams", () => {
    const expected = {
      sort: "price-desc",
      options: {},
      categories: [],
      inStock: true,
      min: 50,
      max: 500,
      pages: 3,
    };
    expect(
      parseShopQuery({
        sort: "price-desc",
        stock: "in",
        min: "50",
        max: "500",
        page: "3",
      }),
    ).toEqual(expected);
    expect(
      parseShopQuery(
        new URLSearchParams("sort=price-desc&stock=in&min=50&max=500&page=3"),
      ),
    ).toEqual(expected);
  });

  it("swaps a backwards range and drops a negative or absurd bound", () => {
    expect(parseShopQuery({ min: "500", max: "50" })).toMatchObject({
      min: 50,
      max: 500,
    });
    expect(parseShopQuery({ min: "-5", max: "99999999999" })).toMatchObject({
      min: null,
      max: null,
    });
  });

  it("caps the page count so a crafted link cannot draw everything twice", () => {
    expect(parseShopQuery({ page: "100000" }).pages).toBe(200);
    expect(parseShopQuery({ page: "2.5" }).pages).toBe(1);
  });

  it("takes the first value of a repeated key", () => {
    expect(parseShopQuery({ sort: ["newest", "name"] }).sort).toBe("newest");
  });
});

describe("shopQueryEntries / withShopQuery", () => {
  it("omits every default, so an untouched shop has a clean address", () => {
    expect(shopQueryEntries(DEFAULT_SHOP_QUERY)).toEqual([]);
  });

  it("round-trips a view through the query string", () => {
    const view = {
      sort: "newest" as const,
      options: { color: ["black", "navy blue"], size: ["m"] },
      categories: ["men"],
      inStock: true,
      min: 10,
      max: 90,
      pages: 2,
    };
    const params = withShopQuery(new URLSearchParams(), view);
    expect(parseShopQuery(params)).toEqual(view);
  });

  it("keeps the search term and drops stale shop keys", () => {
    const next = withShopQuery(new URLSearchParams("q=tea&sort=name&page=4"), {
      ...DEFAULT_SHOP_QUERY,
      inStock: true,
    });
    expect(next.toString()).toBe("q=tea&stock=in");
  });
});

describe("applyShopQuery", () => {
  it("keeps the store's own order for Featured", () => {
    expect(apply({})).toEqual(["a", "b", "c", "d"]);
  });

  it("sorts by price, breaking ties by the featured order", () => {
    expect(apply({ sort: "price-asc" })).toEqual(["b", "c", "d", "a"]);
    expect(apply({ sort: "price-desc" })).toEqual(["a", "c", "d", "b"]);
  });

  it("puts the newest first and an undated product last", () => {
    expect(apply({ sort: "newest" })).toEqual(["b", "c", "a", "d"]);
  });

  it("sorts names without caring about case", () => {
    expect(apply({ sort: "name" })).toEqual(["b", "c", "d", "a"]);
  });

  it("hides sold-out products when asked", () => {
    expect(apply({ stock: "in" })).toEqual(["a", "c", "d"]);
  });

  it("filters an inclusive price range", () => {
    expect(apply({ min: "200", max: "200" })).toEqual(["c", "d"]);
    expect(apply({ min: "250" })).toEqual(["a"]);
    expect(apply({ max: "150" })).toEqual(["b"]);
  });

  it("does not mutate its input", () => {
    const copy = [...rows];
    applyShopQuery(rows, parseShopQuery({ sort: "price-asc" }), (r) => r);
    expect(rows).toEqual(copy);
  });
});

describe("activeFilterCount", () => {
  it("counts availability and price, never sort", () => {
    expect(activeFilterCount(DEFAULT_SHOP_QUERY)).toBe(0);
    expect(
      activeFilterCount({ ...DEFAULT_SHOP_QUERY, sort: "name", inStock: true }),
    ).toBe(1);
    expect(
      activeFilterCount({ ...DEFAULT_SHOP_QUERY, inStock: true, max: 10 }),
    ).toBe(2);
  });
});

describe("priceSpan", () => {
  it("spans whole rupees and ignores invalid prices", () => {
    expect(priceSpan([120.5, 99.2, NaN, -1])).toEqual({ min: 99, max: 121 });
    expect(priceSpan([])).toBeNull();
  });
});

describe("option and category filters", () => {
  const tee: ShopFacts = {
    name: "Tee",
    price: 699,
    soldOut: false,
    createdAt: null,
    categoryKey: "men",
    variants: [
      { values: { size: "m", color: "black" }, price: 699, available: false },
      { values: { size: "l", color: "black" }, price: 699, available: true },
      { values: { size: "m", color: "white" }, price: 1299, available: true },
    ],
  };
  const simple: ShopFacts = {
    name: "Cap",
    price: 399,
    soldOut: false,
    createdAt: null,
    categoryKey: "accessories",
  };
  const q = (patch: Partial<typeof DEFAULT_SHOP_QUERY>) => ({
    ...DEFAULT_SHOP_QUERY,
    ...patch,
  });

  it("reads Shopify-style params, repeated values and aliases", () => {
    const query = parseShopQuery(
      new URLSearchParams(
        "filter.v.option.Size=M&filter.v.option.size=L&filter.v.option.Colour=Navy%20Blue" +
          "&filter.p.category=Men&filter.v.availability=1&filter.v.price.gte=100",
      ),
    );
    expect(query.options).toEqual({ size: ["m", "l"], color: ["navy blue"] });
    expect(query.categories).toEqual(["men"]);
    expect(query.inStock).toBe(true);
    expect(query.min).toBe(100);
    expect(activeFilterCount(query)).toBe(6);
  });

  it("ORs values within a filter and ANDs across filters", () => {
    expect(matchesShopQuery(tee, q({ options: { size: ["m", "xl"] } }))).toBe(
      true,
    );
    expect(matchesShopQuery(tee, q({ options: { size: ["xl"] } }))).toBe(false);
    expect(
      matchesShopQuery(
        tee,
        q({ options: { size: ["l"] }, categories: ["women"] }),
      ),
    ).toBe(false);
  });

  it("checks one VARIANT against every filter, not the product", () => {
    // M exists (black, sold out) and something is in stock (L) — but no
    // in-stock M black exists.
    expect(
      matchesShopQuery(
        tee,
        q({ options: { size: ["m"], color: ["black"] }, inStock: true }),
      ),
    ).toBe(false);
    // M white is in stock but costs 1299, over the ceiling.
    expect(
      matchesShopQuery(
        tee,
        q({ options: { size: ["m"] }, inStock: true, max: 1000 }),
      ),
    ).toBe(false);
    expect(
      matchesShopQuery(tee, q({ options: { size: ["m"] }, inStock: true })),
    ).toBe(true);
  });

  it("a product without the option never matches it", () => {
    expect(matchesShopQuery(simple, q({ options: { size: ["m"] } }))).toBe(
      false,
    );
    expect(matchesShopQuery(simple, q({ max: 500 }))).toBe(true);
  });

  it("skip leaves exactly one filter out", () => {
    const query = q({ options: { size: ["xl"] }, categories: ["men"] });
    expect(matchesShopQuery(tee, query)).toBe(false);
    expect(matchesShopQuery(tee, query, "option:size")).toBe(true);
  });

  it("toggles values and clears everything but the sort", () => {
    let query = toggleOptionValue(q({ sort: "name" }), "size", "m");
    query = toggleCategory(query, "men");
    expect(query.options).toEqual({ size: ["m"] });
    query = toggleOptionValue(query, "size", "m");
    expect(query.options).toEqual({});
    const cleared = clearedShopQuery({ ...query, inStock: true, min: 5 });
    expect(cleared).toMatchObject({
      sort: "name",
      categories: [],
      inStock: false,
      min: null,
    });
  });

  it("drops filter keys it does not own when rewriting the URL", () => {
    const next = withShopQuery(
      new URLSearchParams("q=tee&filter.v.option.size=s&filter.p.vendor=x"),
      q({ options: { size: ["m", "l"] } }),
    );
    expect(next.getAll("filter.v.option.size")).toEqual(["m", "l"]);
    expect(next.get("filter.p.vendor")).toBeNull();
    expect(next.get("q")).toBe("tee");
  });

  it("treats Colour and Color as one filter", () => {
    expect(facetKey("Colour")).toBe("color");
    expect(facetKey(" Fit Type ")).toBe("fit-type");
    expect(valueKey("  Navy   Blue ")).toBe("navy blue");
  });
});

// Plan Phase 2e: the numbered-pages control.
describe("pageNumbers", () => {
  it("lists every page up to seven and windows beyond that", () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageNumbers(1, 20)).toEqual([1, 2, 3, 4, null, 20]);
    expect(pageNumbers(10, 20)).toEqual([1, null, 9, 10, 11, null, 20]);
    expect(pageNumbers(20, 20)).toEqual([1, null, 17, 18, 19, 20]);
    // Out-of-range pages clamp rather than listing nothing.
    expect(pageNumbers(99, 20)).toEqual([1, null, 17, 18, 19, 20]);
    expect(pageNumbers(1, 0)).toEqual([]);
  });
});
