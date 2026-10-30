import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  value: { id: "store-1" } as { id: string } | null,
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: vi.fn(async () => store.value),
}));
const products = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/storefront/queries", () => ({
  getPublishedProducts: vi.fn(async () => products.rows),
  getActiveCategories: vi.fn(async () => [
    {
      id: "c1",
      name: "Shirts",
      slug: "shirts",
      image_url: null,
      sort_order: 0,
    },
  ]),
}));
// The page swap, real (the pure half) over a set this file chooses: outside
// addresses only, so no bucket configuration is involved.
const blocked = vi.hoisted(() => ({ addresses: [] as string[] }));
vi.mock("@/lib/moderation/blocked-objects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/blocked-objects")>();
  return {
    ...actual,
    maskBlockedMedia: vi.fn(async (value: unknown) =>
      actual.maskBlockedMediaWith(
        value,
        actual.buildBlockedMediaSet(
          blocked.addresses.map((objectPath, i) => ({
            id: `block-${i}`,
            objectPath,
            fileSource: "external",
            storeId: "store-1",
            objectMd5: null,
            tellStore: true,
          })),
          { bucket: null, loadedAt: Date.now() },
        ),
      ),
    ),
  };
});

import { getPublishedProducts } from "@/lib/storefront/queries";
import { maskBlockedMedia } from "@/lib/moderation/blocked-objects";
import { PLACEHOLDER_URL_PATH } from "@/lib/moderation/placeholder";
import { GET } from "./route";

const product = (over: Record<string, unknown>) => ({
  id: "p",
  name: "Linen shirt",
  slug: "linen-shirt",
  description: "Soft",
  category: "Shirts",
  base_price: 1500,
  selling_price: 1200,
  image_url: "",
  images: ["", "/img/shirt.webp"],
  variants: [],
  ...over,
});

const get = (q: string) =>
  GET(
    new Request(
      `https://shop.example/api/storefront/search?q=${encodeURIComponent(q)}`,
    ),
  );

describe("GET /api/storefront/search", () => {
  beforeEach(() => {
    blocked.addresses = [];
    store.value = { id: "store-1" };
    products.rows = [
      product({}),
      product({
        name: "Denim jacket",
        slug: "denim",
        category: "Jackets",
        description: "x",
        selling_price: 1500,
      }),
    ];
  });

  it("returns ranked suggestions for the host's store", async () => {
    const response = await get("shirt");
    const body = await response.json();
    expect(getPublishedProducts).toHaveBeenCalledWith("store-1");
    expect(body).toEqual({
      query: "shirt",
      total: 1,
      products: [
        {
          name: "Linen shirt",
          href: "/shop/linen-shirt",
          imageUrl: "/img/shirt.webp", // the gallery's first real photo
          price: 1200,
          compareAt: 1500,
          category: "Shirts",
        },
      ],
      categories: [{ name: "Shirts", href: "/collections/shirts" }],
    });
    expect(response.headers.get("cache-control")).toMatch(/^private/);
  });

  it("omits the struck price when nothing is on sale", async () => {
    const body = await (await get("denim")).json();
    expect(body.products[0].compareAt).toBeNull();
  });

  it("asks nothing for a one-letter query", async () => {
    const body = await (await get("s")).json();
    expect(body.products).toEqual([]);
    expect(getPublishedProducts).not.toHaveBeenCalled();
  });

  it("answers with nothing on a host that is no store", async () => {
    store.value = null;
    const body = await (await get("shirt")).json();
    expect(body.total).toBe(0);
    expect(getPublishedProducts).not.toHaveBeenCalled();
  });

  it("masks the answer: a blocked thumbnail becomes the placeholder", async () => {
    const photo = "https://cdn.example.com/linen-shirt.jpg";
    products.rows = [product({ image_url: photo, images: [photo] })];
    blocked.addresses = [photo];
    const body = await (await get("shirt")).json();
    expect(maskBlockedMedia).toHaveBeenCalledTimes(1);
    expect(body.products[0].imageUrl).toBe(PLACEHOLDER_URL_PATH);
    expect(JSON.stringify(body)).not.toContain(photo);
    // Everything else in the answer is untouched.
    expect(body.products[0]).toMatchObject({
      name: "Linen shirt",
      href: "/shop/linen-shirt",
      price: 1200,
    });
  });

  it("leaves a thumbnail nobody blocked as it is", async () => {
    const photo = "https://cdn.example.com/linen-shirt.jpg";
    products.rows = [product({ image_url: photo, images: [photo] })];
    blocked.addresses = ["https://cdn.example.com/someone-else.jpg"];
    const body = await (await get("shirt")).json();
    expect(body.products[0].imageUrl).toBe(photo);
  });
});
