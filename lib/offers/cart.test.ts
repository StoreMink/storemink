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
vi.mock("./resolve", () => ({
  loadCustomerGroupIds: vi.fn(async () => []),
  loadFirstOrderState: vi.fn(async () => null),
  loadLiveOffers: vi.fn(async () => []),
  loadOfferPolicy: vi.fn(async () => ({
    onSalePrice: "best",
    maxTotalDiscountPercent: 50,
    autoApply: true,
  })),
}));
vi.mock("@/lib/settings/resolve", () => ({
  getStoreSettings: vi.fn(async () => ({})),
}));

import {
  loadOffersForRegister,
  recordOfferRedemptions,
  releaseOfferUses,
  reserveOfferUses,
  resolveOffersForCart,
} from "./cart";
import type { AppliedOffer, OfferResult } from "./apply";

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
