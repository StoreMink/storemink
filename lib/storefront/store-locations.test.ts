// A store's shops as a shopper may see them (store-locations.ts): only
// shops, only active ones, and only what a shop sign would say.
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as unknown[], fail: false }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) => {
    if (db.fail) throw new Error("db down");
    const chain: Record<string, unknown> = {};
    for (const key of ["select", "from", "where", "orderBy"])
      chain[key] = () => chain;
    chain.limit = async () => db.rows;
    return fn(chain);
  }),
}));
// Outside a render the cache cannot run, which is the test's own situation.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

import { getPublicShopLocations, publicShopLocation } from "./store-locations";

const row = (over: Record<string, unknown> = {}) => ({
  id: "loc-1",
  name: "Indiranagar shop",
  type: "shop",
  active: true,
  address: {
    line1: "12 Radial Road",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560038",
  },
  ...over,
});

beforeEach(() => {
  db.rows = [];
  db.fail = false;
});

describe("★★ what a shopper is shown", () => {
  it("a shop's name, its address in lines, and a directions link", () => {
    expect(publicShopLocation(row())).toEqual({
      id: "loc-1",
      name: "Indiranagar shop",
      address: ["12 Radial Road", "Bengaluru, Karnataka, 560038"],
      mapsUrl:
        "https://www.google.com/maps/search/?api=1&query=Indiranagar%20shop%2C%2012%20Radial%20Road%2C%20Bengaluru%2C%20Karnataka%2C%20560038",
    });
  });

  it("★★ never a warehouse or a dark store, whatever it is called", () => {
    expect(publicShopLocation(row({ type: "warehouse" }))).toBeNull();
    expect(publicShopLocation(row({ type: "dark_store" }))).toBeNull();
    expect(publicShopLocation(row({ type: "Shop" }))).toBeNull();
  });

  it("never a closed shop, nor one with no address to send anyone to", () => {
    expect(publicShopLocation(row({ active: false }))).toBeNull();
    for (const address of [null, {}, [], "12 Radial Road", { city: " " }])
      expect(publicShopLocation(row({ address }))).toBeNull();
    expect(publicShopLocation(row({ name: "  " }))).toBeNull();
  });

  it("nothing else on the row leaves: no GSTIN, capabilities or stock", () => {
    const shop = publicShopLocation(
      row({
        gstin: "29ABCDE1234F1Z5",
        capabilities: { pos: true },
        receiptPrefix: "IND",
      } as never),
    )!;
    expect(Object.keys(shop).sort()).toEqual([
      "address",
      "id",
      "mapsUrl",
      "name",
    ]);
    expect(JSON.stringify(shop)).not.toContain("29ABCDE1234F1Z5");
  });
});

describe("the read", () => {
  it("returns the store's shops, leaving out rows that are not one", async () => {
    db.rows = [
      row(),
      row({ id: "loc-2", type: "warehouse" }),
      row({ id: "loc-3", address: null }),
    ];
    expect((await getPublicShopLocations("store-1")).map((s) => s.id)).toEqual([
      "loc-1",
    ]);
  });

  it("★ a failed read is no shops, never an error on a storefront page", async () => {
    db.fail = true;
    expect(await getPublicShopLocations("store-1")).toEqual([]);
  });
});
