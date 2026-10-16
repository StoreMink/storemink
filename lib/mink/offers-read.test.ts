import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { MinkActorContext } from "./types";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  scopeRows: [] as Array<Record<string, unknown>>,
  giftRows: [] as Array<Record<string, unknown>>,
  settings: {} as Record<string, unknown>,
  /** Every WHERE a read built, with the fields it selected. */
  wheres: [] as Array<{ fields: string[]; where: SQL }>,
  /** Every LEFT JOIN's ON clause. */
  joins: [] as SQL[],
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (work: (db: unknown) => unknown) =>
    work({
      select(fields: Record<string, unknown>) {
        const value = Object.hasOwn(fields, "offerId")
          ? mocks.scopeRows
          : Object.hasOwn(fields, "productName")
            ? mocks.giftRows
            : Object.hasOwn(fields, "id")
              ? mocks.rows
              : [{ settings: mocks.settings }];
        const record = (where: SQL) =>
          mocks.wheres.push({ fields: Object.keys(fields), where });
        // Awaitable as it stands (a read with no LIMIT) or through .limit().
        const terminal = {
          limit: vi.fn(async (limit: number) => value.slice(0, limit)),
          then: (resolve: (rows: unknown) => unknown) =>
            Promise.resolve(value).then(resolve),
        };
        const join = (_table: unknown, on: SQL) => {
          mocks.joins.push(on);
          return joined();
        };
        const joined = (): Record<string, unknown> => ({
          ...terminal,
          where: vi.fn((where: SQL) => {
            record(where);
            return terminal;
          }),
          leftJoin: vi.fn(join),
        });
        return {
          from: vi.fn(() => ({
            where: vi.fn((where: SQL) => {
              record(where);
              return { ...terminal, orderBy: vi.fn(() => terminal) };
            }),
            leftJoin: vi.fn(join),
          })),
        };
      },
    }),
  ),
}));
vi.mock("@/lib/settings/registry", () => ({
  resolveStoreSettings: vi.fn((settings: Record<string, unknown>) => settings),
}));

import {
  describeShopperConditions,
  readMinkCurrentOffers,
  readMinkShopperOffers,
} from "./offers-read";

beforeEach(() => {
  mocks.rows = [];
  mocks.scopeRows = [];
  mocks.giftRows = [];
  mocks.settings = {};
  mocks.wheres = [];
  mocks.joins = [];
});

/** The WHERE of the read that selected `field`, as Postgres receives it. */
function whereOf(field: string) {
  const found = mocks.wheres.find((w) => w.fields.includes(field));
  if (!found) throw new Error(`no read selected ${field}`);
  const q = new PgDialect().sqlToQuery(found.where);
  return { sql: q.sql.replace(/\s+/g, " "), params: q.params };
}

const ACTOR = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "staff",
  permissions: { promotions: ["view"] },
  isSuperadmin: false,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
} satisfies MinkActorContext;

function offer(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    name: "Offer",
    status: "active",
    delivery: "automatic",
    code: null,
    priority: 0,
    triggerType: "always",
    triggerConfig: {},
    rewardType: "percent_off",
    rewardConfig: { percent: 10 },
    channels: [],
    validFrom: null,
    validUntil: null,
    maxRedemptions: null,
    redemptionCount: 0,
    budgetPaise: null,
    spentPaise: 0,
    ...overrides,
  };
}

describe("Mink current-offers read", () => {
  it("explains operational blockers instead of calling every active row running", async () => {
    mocks.settings = { "offers.autoApply": false };
    mocks.scopeRows = [];
    mocks.rows = [
      offer({ name: "Automatic", delivery: "automatic" }),
      offer({ name: "Code", delivery: "code", code: "SAVE10" }),
      offer({
        name: "Later",
        delivery: "code",
        validFrom: "2026-10-01T00:00:00.000Z",
      }),
      offer({
        name: "Expired",
        delivery: "code",
        validUntil: "2026-09-01T00:00:00.000Z",
      }),
      offer({
        name: "Used",
        delivery: "code",
        maxRedemptions: 2,
        redemptionCount: 2,
      }),
      offer({
        name: "Budget",
        delivery: "code",
        budgetPaise: 5000,
        spentPaise: 5000,
      }),
      offer({ name: "Disabled", status: "disabled" }),
    ];

    const result = await readMinkCurrentOffers(ACTOR, {
      limit: 20,
      now: new Date("2026-09-13T10:30:00.000Z"),
    });

    expect(result.runningCount).toBe(1);
    expect(result.offers.map((row) => [row.name, row.availability])).toEqual([
      ["Automatic", "automatic_offers_disabled"],
      ["Code", "running"],
      ["Later", "scheduled"],
      ["Expired", "ended"],
      ["Used", "redemption_limit_reached"],
      ["Budget", "budget_exhausted"],
      ["Disabled", "disabled"],
    ]);
    expect(result.offers[1]).toMatchObject({
      code: "SAVE10",
      reward: "10% off the order",
      trigger: "on any order",
      channels: ["storefront", "pos"],
    });
  });

  it("bounds rows and marks truncation", async () => {
    mocks.settings = { "offers.autoApply": true };
    mocks.scopeRows = [];
    mocks.rows = [offer({ name: "One" }), offer({ name: "Two" })];

    const result = await readMinkCurrentOffers(ACTOR, {
      limit: 1,
      now: new Date("2026-09-13T10:30:00.000Z"),
    });

    expect(result.offers).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("keeps reward scope separate from an order-level trigger", async () => {
    mocks.settings = { "offers.autoApply": true };
    const scoped = offer({
      id: "offer-launch",
      name: "Launch",
      rewardType: "buy_x_get_y",
      rewardConfig: { buyQuantity: 1, getQuantity: 1 },
    });
    mocks.rows = [scoped];
    mocks.scopeRows = [
      {
        offerId: "offer-launch",
        productId: "product-almond",
        productName: "Almond shake",
        variantId: null,
        variantName: null,
        variantSku: null,
        categoryId: null,
        categoryName: null,
      },
      {
        offerId: "offer-launch",
        productId: null,
        productName: null,
        variantId: null,
        variantName: null,
        variantSku: null,
        categoryId: "category-beverages",
        categoryName: "Beverages",
      },
    ];

    const result = await readMinkCurrentOffers(ACTOR, {
      limit: 20,
      now: new Date("2026-09-13T10:30:00.000Z"),
    });

    expect(result.offers[0]).toMatchObject({
      reward: "Buy 1, get 1 free (2 selected)",
      trigger: "on any order",
      appliesTo: {
        allProducts: false,
        products: ["Almond shake"],
        variants: [],
        categories: ["Beverages"],
        summary: "Almond shake; all products in Beverages",
        truncated: false,
      },
    });
  });
});

describe("the merchant's own list stays whole", () => {
  it("★ reads every offer of the store, published code or not: no shopper filter", async () => {
    mocks.settings = { "offers.autoApply": true };
    mocks.rows = [offer({ name: "Staff", delivery: "code", code: "STAFF50" })];
    const result = await readMinkCurrentOffers(ACTOR, {
      limit: 20,
      now: new Date("2026-09-13T10:30:00.000Z"),
    });
    expect(result.offers[0]).toMatchObject({ code: "STAFF50" });
    const where = whereOf("priority");
    expect(where.sql).toBe('"offers"."store_id" = $1');
    expect(where.sql).not.toContain("show_on_storefront");
  });
});

describe("readMinkShopperOffers: what a stranger on WhatsApp may be told", () => {
  const NOW = new Date("2026-10-14T06:30:00.000Z");
  const read = (limit = 5) => readMinkShopperOffers(ACTOR, { limit, now: NOW });

  function shopperRow(overrides: Record<string, unknown>) {
    return {
      id: crypto.randomUUID(),
      name: "Offer",
      delivery: "automatic",
      code: null,
      triggerType: "always",
      triggerConfig: {},
      rewardType: "percent_off",
      rewardConfig: { percent: 10 },
      conditions: [],
      channels: [],
      validUntil: null,
      maxPerCustomer: null,
      ...overrides,
    };
  }

  it("★★ the query keeps only running, online, ungrouped offers, and a code only when published", async () => {
    mocks.settings = { "offers.autoApply": true };
    await read();
    const where = whereOf("conditions");
    // Running now: every blocker the merchant's list names, in SQL.
    expect(where.sql).toContain('"offers"."status" = $2');
    expect(where.sql).toContain(
      '("offers"."valid_from" is null or "offers"."valid_from" <= $3)',
    );
    expect(where.sql).toContain(
      '("offers"."valid_until" is null or "offers"."valid_until" >= $4)',
    );
    expect(where.sql).toContain(
      '("offers"."max_redemptions" is null or "offers"."redemption_count" < "offers"."max_redemptions")',
    );
    expect(where.sql).toContain(
      '("offers"."budget_paise" is null or "offers"."spent_paise" < "offers"."budget_paise")',
    );
    // Online.
    expect(where.sql).toContain(
      `(cardinality("offers"."channels") = 0 or "offers"."channels" @> array['storefront']::text[])`,
    );
    // ★ A code only when the merchant published it on the storefront.
    expect(where.sql).toContain(
      ' and ("offers"."delivery" = $5 or "offers"."show_on_storefront" = $6) and ',
    );
    // No customer group, no single shop.
    expect(where.sql).toContain(
      ' and not exists (select 1 from public.offer_user_groups g where g.offer_id = "offers"."id" and g.store_id = "offers"."store_id") and ',
    );
    expect(where.sql).toContain(
      ' and not exists (select 1 from public.offer_locations l where l.offer_id = "offers"."id" and l.store_id = "offers"."store_id"))',
    );
    expect(where.params).toEqual([
      ACTOR.storeId,
      "active",
      NOW.toISOString(),
      NOW.toISOString(),
      "automatic",
      true,
    ]);
  });

  it("★ with automatic offers switched off, only published codes are told", async () => {
    mocks.settings = { "offers.autoApply": false };
    await read();
    const where = whereOf("conditions");
    expect(where.sql).toContain(
      '("offers"."delivery" <> $5 and "offers"."show_on_storefront" = $6)',
    );
    expect(where.params.slice(4)).toEqual(["automatic", true]);
  });

  it("★★ describes each offer with its rules, what it is on and what the basket must include", async () => {
    mocks.settings = { "offers.autoApply": true };
    mocks.rows = [
      shopperRow({
        id: "o-code",
        name: "Diwali 10",
        delivery: "code",
        code: "DIWALI10",
        triggerType: "min_subtotal",
        triggerConfig: { minSubtotal: 500 },
        maxPerCustomer: 1,
        validUntil: "2026-10-31T18:29:59.000Z",
      }),
      shopperRow({
        id: "o-items",
        name: "Shake week",
        rewardType: "percent_off_items",
        rewardConfig: { percent: 20 },
        conditions: [
          { type: "first_order" },
          { type: "payment_method", methods: ["razorpay"] },
        ],
        channels: ["storefront"],
      }),
      shopperRow({
        id: "o-combo",
        name: "Combo",
        triggerType: "contains_category",
        rewardType: "amount_off",
        rewardConfig: { amount: 50 },
        conditions: [
          {
            type: "time_window",
            days: [1, 2, 3, 4, 5],
            startMinute: 17 * 60,
            endMinute: 19 * 60,
          },
        ],
      }),
      shopperRow({
        id: "o-gift",
        name: "Tumbler",
        triggerType: "min_subtotal",
        triggerConfig: { minSubtotal: 999 },
        rewardType: "free_item",
        rewardConfig: { giftProductId: "g1", giftQuantity: 1 },
      }),
    ];
    mocks.scopeRows = [
      { offerId: "o-items", productName: "Almond Shake" },
      {
        offerId: "o-items",
        productName: null,
        variantName: "500 ml",
        variantProductName: "Oat Milk",
      },
      { offerId: "o-items", productName: null, categoryName: "Snacks" },
      { offerId: "o-combo", productName: null, categoryName: "Shakes" },
    ];
    mocks.giftRows = [{ productId: "g1", productName: "Steel Tumbler" }];

    const result = await read();
    expect(result.offers).toEqual([
      {
        name: "Diwali 10",
        code: "DIWALI10",
        reward: "10% off the order",
        on: null,
        when: "on orders over ₹500",
        conditions: ["once per customer"],
        validUntil: "2026-10-31T18:29:59.000Z",
      },
      {
        name: "Shake week",
        code: null,
        reward: "20% off chosen items",
        on: "Almond Shake, Oat Milk (500 ml) and everything in Snacks",
        when: "on any order",
        conditions: [
          "first order only",
          "only when paying online",
          "online orders only",
        ],
        validUntil: null,
      },
      {
        name: "Combo",
        code: null,
        reward: "₹50 off the order",
        on: null,
        when: "when the basket includes anything from Shakes",
        conditions: [
          "only on Mon, Tue, Wed, Thu, Fri from 17:00 to 19:00 shop time",
        ],
        validUntil: null,
      },
      {
        name: "Tumbler",
        code: null,
        reward: "Free Steel Tumbler",
        on: null,
        when: "on orders over ₹999",
        conditions: [],
        validUntil: null,
      },
    ]);
    expect(result.truncated).toBe(false);
    // A gift is named only when the storefront shows it.
    expect(whereOf("productId").params).toEqual(
      expect.arrayContaining([ACTOR.storeId, "published", "g1"]),
    );
    // ★ Names are joined only from what the storefront shows: a published
    // product (for a variant, its product) and an active category.
    const ons = mocks.joins.map((on) => {
      const q = new PgDialect().sqlToQuery(on);
      return { sql: q.sql, params: q.params };
    });
    expect(ons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining('"products"."status" = $2'),
          params: expect.arrayContaining(["published"]),
        }),
        expect.objectContaining({
          sql: expect.stringContaining('"variant_product"."status" = $2'),
          params: expect.arrayContaining(["published"]),
        }),
        expect.objectContaining({
          sql: expect.stringContaining('"categories"."status" = $2'),
          params: expect.arrayContaining(["active"]),
        }),
      ]),
    );
  });

  it("★ leaves out an offer it cannot describe truthfully, without leaving a gap", async () => {
    mocks.settings = { "offers.autoApply": true };
    mocks.rows = [
      // Conditions the engine cannot read: the engine refuses it, so do we.
      shopperRow({
        id: "o-bad",
        name: "Bad",
        conditions: [{ type: "mystery" }],
      }),
      // Scoped only to a product the storefront does not show.
      shopperRow({
        id: "o-hidden",
        name: "Hidden",
        rewardType: "percent_off_items",
        rewardConfig: { percent: 30 },
      }),
      // A code offer with no code has nothing to tell.
      shopperRow({ id: "o-nocode", name: "No code", delivery: "code" }),
      shopperRow({ id: "o-ok", name: "Fine" }),
    ];
    mocks.scopeRows = [{ offerId: "o-hidden", productName: null }];
    const result = await read(2);
    expect(result.offers.map((o) => o.name)).toEqual(["Fine"]);
    expect(result.truncated).toBe(false);
  });

  it("names a short list of hidden-free items and counts the rest", async () => {
    mocks.settings = { "offers.autoApply": true };
    mocks.rows = [
      shopperRow({
        id: "o-many",
        name: "Many",
        triggerType: "contains_product",
        rewardType: "amount_off",
        rewardConfig: { amount: 25 },
      }),
    ];
    mocks.scopeRows = ["A", "B", "C", "D", "E", "F"].map((name) => ({
      offerId: "o-many",
      productName: name,
    }));
    const [only] = (await read()).offers;
    expect(only.when).toBe(
      "when the basket includes A, B, C, D or 2 other items",
    );
  });

  it("says every rule in a shopper's words", () => {
    expect(
      describeShopperConditions([
        { type: "fulfilment_type", fulfilment: ["pickup"] },
        { type: "payment_method", methods: ["cod", "pay_at_store"] },
        {
          type: "time_window",
          days: [0, 1, 2, 3, 4, 5, 6],
          startMinute: 22 * 60,
          endMinute: 2 * 60,
        },
      ]),
    ).toEqual([
      "only for store pickup orders",
      "only when paying by cash on delivery or at the store",
      "only every day from 22:00 to 02:00 shop time",
    ]);
  });
});
