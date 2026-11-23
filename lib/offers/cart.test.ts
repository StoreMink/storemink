// ---------------------------------------------------------------------------
// The failure logs of the offers-on-a-cart boundary (robustness audit B22).
// Every read here fails open, so a log line is the only trace a failure
// leaves: it must say what failed and for which store, and never carry the
// query's parameters (an offer's name is merchant text).
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  withService: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ withService: h.withService }));
vi.mock("@/lib/observability/logger", () => ({
  logError: h.logError,
  logWarn: h.logWarn,
  logInfo: vi.fn(),
}));
vi.mock("./resolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resolve")>();
  return {
    loadCustomerGroupIds: vi.fn(async () => []),
    loadFirstOrderState: vi.fn(async () => null),
    // REAL: the blocked-gift tests below price through it over a db mock.
    // The failure-log tests never reach it (their `withService` throws).
    loadLiveOffers: vi.fn(actual.loadLiveOffers),
    loadOfferPolicy: vi.fn(async () => ({
      onSalePrice: "best",
      maxTotalDiscountPercent: 50,
      autoApply: true,
    })),
  };
});
vi.mock("@/lib/settings/resolve", () => ({
  getStoreSettings: vi.fn(async () => ({})),
}));
// The real resolve module imports it (the store timezone); never called here.
vi.mock("@/lib/store/resolve", () => ({ getCurrentStore: vi.fn() }));

import {
  loadOffersForRegister,
  loadOffersForStorefront,
  recordOfferRedemptions,
  releaseOfferUses,
  releaseOrderOfferUses,
  reserveOfferUses,
  resolveOffersForCart,
} from "./cart";
import type { AppliedOffer, OfferResult } from "./apply";
import { makeDbMock } from "@/app/actions/_test-helpers";

const STORE = "11111111-1111-4111-8111-111111111111";
const OFFER = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";

/** What Drizzle throws: its own message carries the query's parameters. */
const queryFailed = () =>
  Object.assign(
    new Error(
      'Failed query: select reserve_offer_use($1, $2)\nparams: "Diwali Secret Sale",22222222',
    ),
    { cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }) },
  );
const applied: AppliedOffer = {
  offerId: OFFER,
  offerName: "Diwali Secret Sale",
  code: null,
  rewardType: "percent_off",
  level: "line",
  amount: 50,
};
/** Every argument logError was given, as one string; an error is written out
 *  the way logError reports it, its message and its cause's. */
const logged = () =>
  JSON.stringify(h.logError.mock.calls, (_k, v) =>
    v instanceof Error
      ? {
          message: v.message,
          cause: v.cause instanceof Error ? v.cause.message : v.cause,
        }
      : v,
  );

beforeEach(() => {
  h.withService.mockImplementation(async () => {
    throw queryFailed();
  });
});

describe("★ the offers failure logs (B22)", () => {
  it("resolveOffersForCart logs the database's reason and the store", async () => {
    await expect(
      resolveOffersForCart({
        storeId: STORE,
        lines: [
          {
            lineId: "l1",
            productId: "p1",
            variantId: null,
            categoryId: null,
            quantity: 1,
            unitPrice: 100,
          },
        ] as never,
        channel: "storefront",
      }),
    ).resolves.toBeNull();
    expect(h.logError).toHaveBeenCalledWith(
      "resolveOffersForCart failed",
      "deadlock detected",
      { storeId: STORE },
    );
  });

  it("reserve_offer_use names the offer, and the sale still goes ahead", async () => {
    await expect(
      reserveOfferUses(STORE, [applied], null),
    ).resolves.toMatchObject({ ok: true });
    expect(h.logError).toHaveBeenCalledWith(
      "reserve_offer_use failed",
      "deadlock detected",
      { storeId: STORE, offerId: OFFER },
    );
  });

  it("release_offer_use names the offer", async () => {
    await releaseOfferUses(STORE, [{ offerId: OFFER, amountPaise: 5_000 }]);
    expect(h.logError).toHaveBeenCalledWith(
      "release_offer_use failed",
      "deadlock detected",
      { storeId: STORE, offerId: OFFER },
    );
  });

  it("recordOfferRedemptions names the order", async () => {
    await recordOfferRedemptions({
      storeId: STORE,
      orderId: ORDER,
      customerId: null,
      result: { allocations: [] } as unknown as OfferResult,
      redeemed: [applied],
      orderItemIdByLine: new Map(),
    });
    expect(h.logError).toHaveBeenCalledWith(
      "recordOfferRedemptions failed",
      "deadlock detected",
      { storeId: STORE, orderId: ORDER },
    );
  });

  it("loadOffersForRegister logs the store and falls back to no offers", async () => {
    await expect(loadOffersForRegister(STORE)).resolves.toMatchObject({
      offers: [],
    });
    expect(h.logError).toHaveBeenCalledWith(
      "loadOffersForRegister failed",
      "deadlock detected",
      { storeId: STORE },
    );
  });

  it("★ no failure log carries the query, its parameters or an offer's name", async () => {
    await reserveOfferUses(STORE, [applied], null);
    await releaseOfferUses(STORE, [{ offerId: OFFER, amountPaise: 5_000 }]);
    await loadOffersForRegister(STORE);
    expect(h.logError).toHaveBeenCalledTimes(3);
    expect(logged()).not.toMatch(/Failed query|params|Diwali Secret Sale/);
    expect(logged()).not.toContain("[object Object]");
  });

  it("★ any other error is logged as itself: its stack names the line, its name the cause", async () => {
    // A bug in the engine, or a pool with no connection to give: not a failed
    // query, so nothing to strip, and both must stay findable in the log.
    const bug = new TypeError("Cannot read properties of undefined");
    h.withService.mockImplementation(async () => {
      throw bug;
    });
    await loadOffersForRegister(STORE);
    expect(h.logError).toHaveBeenCalledWith(
      "loadOffersForRegister failed",
      bug,
      { storeId: STORE },
    );
    const busy = Object.assign(new Error("No database connection came free"), {
      name: "DatabaseBusyError",
    });
    h.withService.mockImplementation(async () => {
      throw busy;
    });
    await releaseOfferUses(STORE, [{ offerId: OFFER, amountPaise: 5_000 }]);
    expect(h.logError).toHaveBeenLastCalledWith(
      "release_offer_use failed",
      busy,
      { storeId: STORE, offerId: OFFER },
    );
  });

  it("a migration not yet applied is a warning, not an error", async () => {
    h.withService.mockImplementation(async () => {
      throw Object.assign(new Error("Failed query: select"), {
        cause: Object.assign(new Error('relation "offers" does not exist'), {
          code: "42P01",
        }),
      });
    });
    await loadOffersForRegister(STORE);
    expect(h.logError).not.toHaveBeenCalled();
    expect(h.logWarn).toHaveBeenCalled();
  });
});

// Decision D18: an item block leaves the POS selling the product, so a free
// gift StoreMink has blocked is withdrawn on the website and kept at the POS.
// `loadLiveOffers` is real here (see the mock above); only the database is
// faked.
describe("★★ a gift StoreMink has blocked, by channel (D18)", () => {
  const GIFT = "44444444-4444-4444-8444-444444444444";

  function giftOffer() {
    return {
      id: OFFER,
      name: "Free tumbler",
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
      rewardConfig: { giftProductId: GIFT, giftQuantity: 1 },
      maxRedemptions: null,
      maxPerCustomer: null,
      budgetPaise: null,
      redemptionCount: 0,
      spentPaise: 0,
    };
  }

  /** One store whose only offer gives GIFT, which StoreMink has blocked and
   *  which has 50 on the shelf. */
  function seedBlockedGift() {
    const mock = makeDbMock({
      selectByTable: {
        offers: [[giftOffer()]],
        offer_products: [[]],
        offer_locations: [[]],
        offer_user_groups: [[]],
        products: [[{ id: GIFT, blockedAt: "2026-10-14 06:00:00+00" }]],
        inventory_levels: [
          [{ productId: GIFT, variantId: null, onHand: 50, reserved: 0 }],
        ],
      },
    });
    h.withService.mockImplementation(async (fn: (db: unknown) => unknown) =>
      fn(mock.db),
    );
    return mock;
  }

  const line = {
    id: "l1",
    productId: "p1",
    variantId: null,
    categoryId: null,
    quantity: 1,
    unitPrice: 100,
  };

  it("is kept when a POS sale is priced", async () => {
    seedBlockedGift();
    const result = await resolveOffersForCart({
      storeId: STORE,
      lines: [line],
      channel: "pos",
    });
    expect(result?.gift).toMatchObject({ offerId: OFFER, productId: GIFT });
  });

  it("is withdrawn when a website order is priced", async () => {
    seedBlockedGift();
    const result = await resolveOffersForCart({
      storeId: STORE,
      lines: [line],
      channel: "storefront",
    });
    expect(result?.gift).toBeNull();
    expect(result?.skipped).toContainEqual({
      offerId: OFFER,
      reason: "gift_unavailable",
    });
  });

  it("is offered when the POS opens", async () => {
    seedBlockedGift();
    const { offers } = await loadOffersForRegister(STORE);
    expect(offers.map((o) => [o.id, o.giftAvailable])).toEqual([[OFFER, true]]);
  });

  it("is not offered to the storefront's own pricing", async () => {
    seedBlockedGift();
    const { offers } = await loadOffersForStorefront(STORE, null, []);
    expect(offers.map((o) => [o.id, o.giftAvailable])).toEqual([
      [OFFER, false],
    ]);
  });
});

// 21 Nov 2026: an online order that was never paid gives its offer uses back.
describe("releaseOrderOfferUses: an unpaid order's offers go back, from the ledger", () => {
  function ledger(rows: unknown[]) {
    const mock = makeDbMock({ returning: rows });
    h.withService.mockImplementation(async (fn: (db: unknown) => unknown) =>
      fn(mock.db),
    );
    return mock;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("★★ deletes the order's redemptions and gives each use and its amount back", async () => {
    const mock = ledger([
      { offerId: OFFER, amountPaise: 5_000 },
      { offerId: "44444444-4444-4444-8444-444444444444", amountPaise: "1200" },
    ]);
    const released = await releaseOrderOfferUses(STORE, ORDER);
    expect(released).toEqual([
      { offerId: OFFER, amountPaise: 5_000 },
      {
        offerId: "44444444-4444-4444-8444-444444444444",
        amountPaise: 1_200,
      },
    ]);
    // The DELETE is the claim: one statement, scoped to this store and order.
    expect(mock.calls.delete).toHaveLength(1);
    // One release_offer_use per redemption it claimed.
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("★ an order with no redemptions releases nothing", async () => {
    const mock = ledger([]);
    expect(await releaseOrderOfferUses(STORE, ORDER)).toEqual([]);
    expect(mock.calls.execute).toHaveLength(0);
  });

  it("★★ a second pass over the same order finds nothing left to give back", async () => {
    const first = ledger([{ offerId: OFFER, amountPaise: 5_000 }]);
    await releaseOrderOfferUses(STORE, ORDER);
    expect(first.calls.execute).toHaveLength(1);
    // The rows are gone, so the same order cannot return one use twice.
    const second = ledger([]);
    await releaseOrderOfferUses(STORE, ORDER);
    expect(second.calls.execute).toHaveLength(0);
  });

  it("never throws: a failed delete gives nothing back and is logged without the query", async () => {
    h.withService.mockRejectedValue(queryFailed());
    expect(await releaseOrderOfferUses(STORE, ORDER)).toEqual([]);
    expect(h.logError).toHaveBeenCalledWith(
      "release order offer uses failed",
      "deadlock detected",
      { storeId: STORE, orderId: ORDER },
    );
  });
});
