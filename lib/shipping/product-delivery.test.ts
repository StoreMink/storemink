import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({
  current: null as ReturnType<
    typeof import("@/app/actions/_test-helpers").makeDbMock
  > | null,
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) =>
    fn(dbHolder.current!.db),
  ),
}));
// The policy is the store's own and needs no read here; the carrier quote is
// a network call and must never run in a test.
vi.mock("./quote", async () => {
  const { DEFAULT_SHIPPING_SETTINGS } = await import("./types");
  return {
    readShippingSettings: vi.fn(async () => DEFAULT_SHIPPING_SETTINGS),
    quoteShippingForOrder: vi.fn(async () => {
      throw new Error("no carrier calls in tests");
    }),
  };
});
vi.mock("@/lib/fulfilment/resolve", () => ({
  resolveFulfilmentLocation: vi.fn(async () => null),
}));

import { estimateProductDelivery } from "./product-delivery";

const STORE = "a0000000-0000-4000-8000-000000000001";
const input = {
  productId: "p1",
  variantId: null,
  quantity: 1,
  postalCode: "560001",
};

describe("estimateProductDelivery: a product StoreMink has blocked", () => {
  beforeEach(() => {
    dbHolder.current = makeDbMock({ selectByTable: { products: [[]] } });
  });

  it("★★ reads the product with the takedown flag in its WHERE", async () => {
    await estimateProductDelivery(STORE, input);
    const where = new PgDialect().sqlToQuery(dbHolder.current!.calls.where[0]);
    expect(where.sql).toContain('"products"."status" = $3');
    expect(where.sql).toContain('"products"."moderation_blocked_at" is null');
    expect(where.params).toEqual([STORE, "p1", "published"]);
  });

  it("★ answers as for a deleted product when the read leaves it out", async () => {
    // A blocked product is not returned (checked against a real row in
    // lib/moderation/shopper-reads.local.test.ts), so the shopper reads the
    // same sentence a deleted product gives.
    await expect(estimateProductDelivery(STORE, input)).resolves.toEqual({
      available: false,
      postalCode: "560001",
      kind: "physical",
      error: "This product is no longer available.",
    });
  });
});
