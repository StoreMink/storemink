import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";

// `loadLiveOffers` takes its `db` from the caller, so the client module is
// never used here; mocked so importing the module opens nothing.
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({ getCurrentStore: vi.fn() }));

import { loadLiveOffers } from "./resolve";

const STORE = "a0000000-0000-4000-8000-000000000001";

function offerRow(id: string, giftProductId: string) {
  return {
    id,
    name: `Gift ${id}`,
    status: "active",
    delivery: "automatic",
    code: null,
    priority: 0,
    createdAt: "2026-10-01 00:00:00+00",
    validFrom: null,
    validUntil: null,
    channels: [],
    triggerType: "always",
    triggerConfig: {},
    conditions: [],
    rewardType: "free_item",
    rewardConfig: { giftProductId, giftQuantity: 1 },
    maxRedemptions: null,
    maxPerCustomer: null,
    budgetPaise: null,
    redemptionCount: 0,
    spentPaise: 0,
  };
}

/** The compiled WHERE of every read, in order. */
function wheres(calls: { where: unknown[] }) {
  return calls.where.map((w) =>
    new PgDialect().sqlToQuery(w as Parameters<PgDialect["sqlToQuery"]>[0]),
  );
}

describe("loadLiveOffers: a gift StoreMink has blocked", () => {
  let mock: ReturnType<typeof makeDbMock>;

  function seed(products: unknown[] | Error, levels: unknown[] | Error) {
    mock = makeDbMock({
      selectByTable: {
        offers: [
          [offerRow("o-blocked", "g-blocked"), offerRow("o-ok", "g-ok")],
        ],
        offer_products: [[]],
        offer_locations: [[]],
        offer_user_groups: [[]],
        products: [products as never],
        inventory_levels: [levels as never],
      },
    });
  }

  beforeEach(() => {
    seed(
      [
        { id: "g-blocked", blockedAt: "2026-10-14 06:00:00+00" },
        { id: "g-ok", blockedAt: null },
      ],
      [
        { productId: "g-blocked", variantId: null, onHand: 50, reserved: 0 },
        { productId: "g-ok", variantId: null, onHand: 50, reserved: 0 },
      ],
    );
  });

  it("★★ is unavailable whatever its stock; an unblocked gift with stock is available", async () => {
    const offers = await loadLiveOffers(mock.db, STORE, null);
    const byId = new Map(offers.map((o) => [o.id, o.giftAvailable]));
    expect(byId.get("o-blocked")).toBe(false);
    expect(byId.get("o-ok")).toBe(true);
  });

  it("★ reads the flags in ONE query, store-scoped, by the same ids as the stock read", async () => {
    await loadLiveOffers(mock.db, STORE, null);
    const all = wheres(mock.calls);
    const flag = all.filter((q) => q.sql.includes('"products"."id" in'));
    const stock = all.filter((q) =>
      q.sql.includes('"inventory_levels"."product_id" in'),
    );
    expect(flag).toHaveLength(1);
    expect(stock).toHaveLength(1);
    expect(flag[0].sql).toContain('"products"."store_id" = $1');
    expect(flag[0].params).toEqual(stock[0].params);
    expect(flag[0].params).toEqual([STORE, "g-blocked", "g-ok"]);
    // The flag is SELECTED, so the answer is the database's, not inferred.
    expect(
      mock.calls.select.some(
        (p: Record<string, unknown> | undefined) => !!p && "blockedAt" in p,
      ),
    ).toBe(true);
  });

  it("★★ still fails OPEN when the flag read fails: every gift is unchecked, never refused", async () => {
    seed(new Error("flag read failed"), []);
    const offers = await loadLiveOffers(mock.db, STORE, null);
    expect(offers.map((o) => o.giftAvailable)).toEqual([undefined, undefined]);
  });

  it("still fails open when the stock read fails", async () => {
    seed(
      [{ id: "g-blocked", blockedAt: "2026-10-14 06:00:00+00" }],
      new Error("x"),
    );
    const offers = await loadLiveOffers(mock.db, STORE, null);
    expect(offers.map((o) => o.giftAvailable)).toEqual([undefined, undefined]);
  });

  it("asked for the website's answer explicitly, gives the default's", async () => {
    const offers = await loadLiveOffers(mock.db, STORE, null, {
      blockedGiftsUnavailable: true,
    });
    const byId = new Map(offers.map((o) => [o.id, o.giftAvailable]));
    expect(byId.get("o-blocked")).toBe(false);
    expect(byId.get("o-ok")).toBe(true);
  });
});

// Decision D18: an item block leaves the POS selling the product, so the POS
// asks with `blockedGiftsUnavailable: false` (lib/offers/cart.ts).
describe("loadLiveOffers at the POS: a gift StoreMink has blocked", () => {
  let mock: ReturnType<typeof makeDbMock>;

  function seed(levels: unknown[] | Error) {
    mock = makeDbMock({
      selectByTable: {
        offers: [
          [offerRow("o-blocked", "g-blocked"), offerRow("o-ok", "g-ok")],
        ],
        offer_products: [[]],
        offer_locations: [[]],
        offer_user_groups: [[]],
        products: [
          [
            { id: "g-blocked", blockedAt: "2026-10-14 06:00:00+00" },
            { id: "g-ok", blockedAt: null },
          ],
        ],
        inventory_levels: [levels as never],
      },
    });
  }

  const POS = { blockedGiftsUnavailable: false } as const;

  it("★★ stays available while it has stock", async () => {
    seed([
      { productId: "g-blocked", variantId: null, onHand: 50, reserved: 0 },
      { productId: "g-ok", variantId: null, onHand: 50, reserved: 0 },
    ]);
    const offers = await loadLiveOffers(mock.db, STORE, null, POS);
    const byId = new Map(offers.map((o) => [o.id, o.giftAvailable]));
    expect(byId.get("o-blocked")).toBe(true);
    expect(byId.get("o-ok")).toBe(true);
  });

  it("★ reads no flag at all, and still reads the stock once by the same ids", async () => {
    seed([]);
    await loadLiveOffers(mock.db, STORE, null, POS);
    const all = wheres(mock.calls);
    expect(all.filter((q) => q.sql.includes('"products"."id" in'))).toEqual([]);
    const stock = all.filter((q) =>
      q.sql.includes('"inventory_levels"."product_id" in'),
    );
    expect(stock).toHaveLength(1);
    expect(stock[0].params).toEqual([STORE, "g-blocked", "g-ok"]);
    expect(
      mock.calls.select.some(
        (p: Record<string, unknown> | undefined) => !!p && "blockedAt" in p,
      ),
    ).toBe(false);
  });

  it("is still judged on its stock: a blocked gift with none is unavailable", async () => {
    seed([
      { productId: "g-blocked", variantId: null, onHand: 3, reserved: 3 },
      { productId: "g-ok", variantId: null, onHand: 50, reserved: 0 },
    ]);
    const offers = await loadLiveOffers(mock.db, STORE, null, POS);
    const byId = new Map(offers.map((o) => [o.id, o.giftAvailable]));
    expect(byId.get("o-blocked")).toBe(false);
    expect(byId.get("o-ok")).toBe(true);
  });

  it("still fails open when the stock read fails", async () => {
    seed(new Error("x"));
    const offers = await loadLiveOffers(mock.db, STORE, null, POS);
    expect(offers.map((o) => o.giftAvailable)).toEqual([undefined, undefined]);
  });
});
