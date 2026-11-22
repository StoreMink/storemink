/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const holder = vi.hoisted(() => ({ db: null as any, fail: false }));
vi.mock("@/lib/db/client", () => ({
  withAnon: vi.fn(async (fn: any) => {
    if (holder.fail) throw new Error("db down");
    return fn(holder.db);
  }),
}));
const getCurrentStoreOrNull = vi.fn();
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: () => getCurrentStoreOrNull(),
}));

import { getQuickAddProduct, getQuickViewProduct } from "./quick-add-actions";

const ID = "11111111-1111-4111-8111-111111111111";

describe("getQuickAddProduct", () => {
  beforeEach(() => {
    holder.fail = false;
    getCurrentStoreOrNull.mockResolvedValue({ id: "store-1" });
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            id: ID,
            slug: "shirt",
            name: "Shirt",
            image_url: null,
            category: null,
            options: [{ name: " Size ", values: ["S", "M"] }],
          },
        ],
        [{ id: "v1", name: "S", option_values: ["S"] }],
      ],
    }).db;
  });

  it("refuses a malformed id before touching the store or the database", async () => {
    expect(await getQuickAddProduct("not-a-uuid")).toBeNull();
    expect(getCurrentStoreOrNull).not.toHaveBeenCalled();
  });

  it("finds nothing on a host that is not a store", async () => {
    getCurrentStoreOrNull.mockResolvedValue(null);
    expect(await getQuickAddProduct(ID)).toBeNull();
  });

  it("returns normalised options with the variants", async () => {
    const product = await getQuickAddProduct(ID);
    expect(product?.options).toEqual([{ name: "Size", values: ["S", "M"] }]);
    expect(product?.variants).toHaveLength(1);
  });

  it("drops stored options it would refuse to render", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            id: ID,
            slug: "s",
            name: "S",
            image_url: null,
            category: null,
            options: [{ name: "Size", values: ["S", "s"] }],
          },
        ],
        [],
      ],
    }).db;
    expect((await getQuickAddProduct(ID))?.options).toEqual([]);
  });

  it("answers null rather than throwing when the read fails", async () => {
    holder.fail = true;
    expect(await getQuickAddProduct(ID)).toBeNull();
  });
});

describe("getQuickViewProduct", () => {
  const row = {
    id: ID,
    slug: "jug",
    name: "Stoneware jug",
    image_url: "/jug.webp",
    // The column's default is [""], and a theme-seeded product repeats its
    // primary photo first: neither may reach the gallery.
    images: ["", "/jug.webp", "/jug-side.webp"],
    description:
      "Thrown by hand.\n\nGlazed twice, " + "and fired slowly ".repeat(30),
    base_price: 1800,
    selling_price: 1500,
    track_inventory: true,
    stock: 3,
    low_stock_threshold: null,
    allow_backorder: false,
    category: "Ceramics",
    options: [],
  };
  beforeEach(() => {
    holder.fail = false;
    getCurrentStoreOrNull.mockResolvedValue({ id: "store-1" });
    holder.db = makeDbMock({ selectQueue: [[row], []] }).db;
  });

  it("refuses a malformed id and a host that is not a store", async () => {
    expect(await getQuickViewProduct("1 or 1=1")).toBeNull();
    expect(getCurrentStoreOrNull).not.toHaveBeenCalled();
    getCurrentStoreOrNull.mockResolvedValue(null);
    expect(await getQuickViewProduct(ID)).toBeNull();
  });

  it("returns the photographs once each, primary first", async () => {
    expect((await getQuickViewProduct(ID))?.gallery).toEqual([
      "/jug.webp",
      "/jug-side.webp",
    ]);
  });

  it("returns the first lines of the description, never the whole text", async () => {
    const product = await getQuickViewProduct(ID);
    expect(product?.excerpt?.startsWith("Thrown by hand. Glazed twice,")).toBe(
      true,
    );
    expect(product?.excerpt?.endsWith("…")).toBe(true);
    expect(product?.excerpt?.length).toBeLessThanOrEqual(281);
    expect(product).not.toHaveProperty("description");
    expect(product).not.toHaveProperty("images");
  });

  it("carries the product's own price and stock, for one sold without variants", async () => {
    expect(await getQuickViewProduct(ID)).toMatchObject({
      base_price: 1800,
      selling_price: 1500,
      track_inventory: true,
      stock: 3,
      allow_backorder: false,
      category: "Ceramics",
      variants: [],
    });
  });

  it("answers null rather than throwing when the read fails", async () => {
    holder.fail = true;
    expect(await getQuickViewProduct(ID)).toBeNull();
  });
});

describe("getQuickAddProduct stays the chooser's own shape", () => {
  it("sends none of what only the quick view shows", async () => {
    getCurrentStoreOrNull.mockResolvedValue({ id: "store-1" });
    holder.fail = false;
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            id: ID,
            slug: "jug",
            name: "Stoneware jug",
            image_url: "/jug.webp",
            images: ["/jug-side.webp"],
            description: "Thrown by hand.",
            base_price: 1800,
            selling_price: 1500,
            track_inventory: true,
            stock: 3,
            low_stock_threshold: null,
            allow_backorder: false,
            category: null,
            options: [],
          },
        ],
        [],
      ],
    }).db;
    expect(Object.keys((await getQuickAddProduct(ID))!).sort()).toEqual([
      "category",
      "id",
      "image_url",
      "name",
      "options",
      "slug",
      "variants",
    ]);
  });
});
