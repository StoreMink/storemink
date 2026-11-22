import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  value: { id: "store-1" } as { id: string } | null,
  gated: false,
  access: "open" as "open" | "locked",
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: vi.fn(async () => store.value),
}));
vi.mock("@/lib/store/launch-state", () => ({
  isStorefrontGated: vi.fn(() => store.gated),
}));
vi.mock("@/lib/store/storefront-access", () => ({
  storefrontAccess: vi.fn(async () => store.access),
}));
const catalogue = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/storefront/queries", () => ({
  getPublishedProducts: vi.fn(async () => catalogue.rows),
}));
const mask = vi.hoisted(() => ({
  fn: vi.fn(async (value: unknown) => value),
}));
vi.mock("@/lib/moderation/blocked-objects", () => ({
  maskBlockedMedia: mask.fn,
}));

import { getPublishedProducts } from "@/lib/storefront/queries";
import { POST, PRODUCT_CARDS_MAX } from "./route";

const product = (slug: string) => ({
  id: `id-${slug}`,
  name: slug,
  slug,
  base_price: 1500,
  selling_price: 1200,
  image_url: `/img/${slug}.webp`,
  variants: [],
});
const post = (body: unknown) =>
  POST(
    new Request("https://shop.example/api/storefront/products", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const get = (slugs: string) => post({ slugs: slugs.split(",") });
const cards = async (response: Response) =>
  ((await response.json()) as { products: { slug: string }[] }).products.map(
    (p) => p.slug,
  );

beforeEach(() => {
  vi.clearAllMocks();
  store.value = { id: "store-1" };
  store.gated = false;
  store.access = "open";
  catalogue.rows = ["bowl", "mug", "plate"].map(product);
});

describe("POST /api/storefront/products", () => {
  it("★★ returns the shop grid's own cards for the slugs asked for, in the order asked", async () => {
    const response = await get("plate,bowl");
    expect(await cards(response)).toEqual(["plate", "bowl"]);
    expect(getPublishedProducts).toHaveBeenCalledWith("store-1");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("★★ the list travels in the body, never in an address a log would keep", async () => {
    const response = await POST(
      new Request(
        "https://shop.example/api/storefront/products?slugs=bowl,mug",
        { method: "POST", body: "{}" },
      ),
    );
    // A list in the query string is not read at all.
    expect(await cards(response)).toEqual([]);
    const route = await import("./route");
    expect(Object.keys(route)).not.toContain("GET");
  });

  it("a body that is not a list of slugs reads nothing", async () => {
    for (const body of [
      "not json",
      "null",
      { slugs: "bowl" },
      { slugs: { 0: "bowl" } },
      { products: ["bowl"] },
      { slugs: ["x".repeat(20_000)] },
    ])
      expect(await cards(await post(body))).toEqual([]);
    expect(getPublishedProducts).not.toHaveBeenCalled();
  });

  it("★ a product that is no longer sold is simply left out", async () => {
    expect(await cards(await get("bowl,discontinued,mug"))).toEqual([
      "bowl",
      "mug",
    ]);
  });

  it("★★ the answer is masked before it leaves (takedown)", async () => {
    await get("bowl");
    expect(mask.fn).toHaveBeenCalledTimes(1);
    expect(mask.fn.mock.calls[0][0]).toEqual([product("bowl")]);
  });

  it("reads nothing for an empty or unusable list", async () => {
    for (const slugs of ["", ",,,", "Not A Slug,../x,<b>"]) {
      expect(await cards(await get(slugs))).toEqual([]);
    }
    expect(getPublishedProducts).not.toHaveBeenCalled();
  });

  it("is bounded: repeats count once and no more than a list's worth is read", async () => {
    const many = Array.from({ length: 300 }, (_, n) => `p-${n}`);
    catalogue.rows = many.map(product);
    const out = await cards(await get(["p-1", "p-1", ...many].join(",")));
    expect(out).toHaveLength(PRODUCT_CARDS_MAX);
    expect(new Set(out).size).toBe(out.length);
  });

  it("★★ an unknown host answers with nothing, and the store never comes from the request", async () => {
    store.value = null;
    const response = await post({
      slugs: ["bowl"],
      store: "store-2",
      storeId: "store-2",
    });
    expect(await cards(response)).toEqual([]);
    expect(getPublishedProducts).not.toHaveBeenCalled();
  });

  it("★★ a store that has not opened answers nothing without its password", async () => {
    store.gated = true;
    store.access = "locked";
    const response = await get("bowl");
    expect(await cards(response)).toEqual([]);
    expect(getPublishedProducts).not.toHaveBeenCalled();
    store.access = "open";
    expect(await cards(await get("bowl"))).toEqual(["bowl"]);
  });
});
