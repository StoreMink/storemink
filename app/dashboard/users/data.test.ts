/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  blogs,
  customerCreditBalances,
  orders,
  productReviews,
  users,
} from "@/drizzle/schema";

// A customer's reviews that StoreMink removed and told the store about read
// "Removed by StoreMink" on the customer detail page (takedown design 7.3).
// The read happens after the customer's own scope has closed, only when there
// is a review to mark, and a failed read marks nothing.

const H = vi.hoisted(() => ({
  customer: [] as Record<string, unknown>[],
  reviews: [] as Record<string, unknown>[],
  orders: [] as Record<string, unknown>[],
  credit: [] as Record<string, unknown>[],
  failCounts: false,
  open: 0,
  maxOpen: 0,
  fail: false,
}));

vi.mock("@/app/dashboard/lib/access", () => ({
  getActingStoreId: vi.fn(async () => "s1"),
}));
vi.mock("@/lib/db/client", () => {
  function query() {
    let table: unknown = null;
    const q: any = {
      from: (t: unknown) => {
        table = t;
        return q;
      },
      leftJoin: () => q,
      where: () => q,
      orderBy: () => q,
      groupBy: () => q,
      limit: () => q,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
        (table === H_TABLES.orders && H.failCounts
          ? Promise.reject(new Error("counts down"))
          : Promise.resolve(
              table === H_TABLES.orders
                ? H.orders
                : table === H_TABLES.credit
                  ? H.credit
                  : table === H_TABLES.users
                    ? H.customer
                    : table === H_TABLES.productReviews
                      ? H.reviews
                      : table === H_TABLES.blogs
                        ? []
                        : [],
            )
        ).then(resolve, reject),
    };
    return q;
  }
  return {
    withService: vi.fn(async (fn: (db: any) => Promise<any>) => {
      if (H.fail) throw new Error("db down");
      H.open += 1;
      H.maxOpen = Math.max(H.maxOpen, H.open);
      try {
        return await fn({ select: () => query() });
      } finally {
        H.open -= 1;
      }
    }),
  };
});
vi.mock("@/lib/observability/logger", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/moderation/merchant", () => ({
  blockedItemIds: vi.fn(async () => new Map<string, string>()),
}));

// The mock factory runs before this module's imports are bound, so the table
// objects it compares against are handed over here.
const H_TABLES = vi.hoisted(() => ({
  users: null as unknown,
  productReviews: null as unknown,
  blogs: null as unknown,
  orders: null as unknown,
  credit: null as unknown,
}));
H_TABLES.users = users;
H_TABLES.productReviews = productReviews;
H_TABLES.blogs = blogs;
H_TABLES.orders = orders;
H_TABLES.credit = customerCreditBalances;

import { blockedItemIds } from "@/lib/moderation/merchant";
import { getCustomer } from "./data";

function review(id: string): Record<string, unknown> {
  return {
    id,
    rating: 4,
    comment: "Lovely",
    created_at: "2026-10-01T00:00:00Z",
    product_id: "p1",
    product_name: "Almond shake",
  };
}

beforeEach(() => {
  H.customer = [
    {
      id: "u1",
      phone: "+919876543210",
      email: "a@example.com",
      first_name: "Asha",
      last_name: null,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    },
  ];
  H.reviews = [review("r1"), review("r2")];
  H.orders = [];
  H.credit = [];
  H.failCounts = false;
  H.open = 0;
  H.maxOpen = 0;
  H.fail = false;
});

describe("getCustomer and reviews removed by StoreMink", () => {
  it("marks only the reviews the store was told about", async () => {
    let openDuringRead = -1;
    vi.mocked(blockedItemIds).mockImplementationOnce(async () => {
      openDuringRead = H.open;
      return new Map([["r1", "b1"]]);
    });

    const customer = await getCustomer("u1");

    expect(blockedItemIds).toHaveBeenCalledTimes(1);
    expect(blockedItemIds).toHaveBeenCalledWith("s1", "review");
    // ★ Read after the customer's scope closed, never inside it.
    expect(openDuringRead).toBe(0);
    expect(customer?.reviews).toEqual([
      { ...review("r1"), storemink_block_id: "b1" },
      { ...review("r2"), storemink_block_id: null },
    ]);
    expect(customer?.review_count).toBe(2);
  });

  it("★ marks nothing when the read has no told block (D21)", async () => {
    const customer = await getCustomer("u1");
    expect(customer?.reviews.map((r) => r.storemink_block_id)).toEqual([
      null,
      null,
    ]);
  });

  it("a failed read marks nothing and the customer still loads", async () => {
    vi.mocked(blockedItemIds).mockRejectedValueOnce(new Error("db down"));
    const customer = await getCustomer("u1");
    expect(customer?.first_name).toBe("Asha");
    expect(customer?.reviews.map((r) => r.storemink_block_id)).toEqual([
      null,
      null,
    ]);
  });

  it("reads nothing when the customer has no reviews", async () => {
    H.reviews = [];
    const customer = await getCustomer("u1");
    expect(blockedItemIds).not.toHaveBeenCalled();
    expect(customer?.reviews).toEqual([]);
  });

  it("reads nothing for a customer not in this store", async () => {
    H.customer = [];
    expect(await getCustomer("u1")).toBeNull();
    expect(blockedItemIds).not.toHaveBeenCalled();
  });

  it("reads nothing when the customer's own read fails", async () => {
    H.fail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getCustomer("u1")).toBeNull();
    expect(blockedItemIds).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// The order counts and store credit behind the delete guard. Shown on the
// customer's page; the server still decides any delete.
describe("getCustomer order counts and store credit", () => {
  it("adds this store's order count and whether any order exists", async () => {
    H.orders = [{ customerId: "u1", here: 2, total: 3 }];
    H.credit = [{ balance: "120.50" }];
    const customer = await getCustomer("u1");
    expect(customer?.order_count).toBe(2);
    expect(customer?.has_orders).toBe(true);
    expect(customer?.store_credit).toBe(120.5);
    // Scopes of their own after the customer read closed: at most the two
    // side reads at once, never three (one nested inside the customer read).
    expect(H.maxOpen).toBeLessThanOrEqual(2);
  });

  it("reads zero orders and no credit as zero", async () => {
    const customer = await getCustomer("u1");
    expect(customer?.order_count).toBe(0);
    expect(customer?.has_orders).toBe(false);
    expect(customer?.store_credit).toBe(0);
  });

  it("a failed count reads as unknown and the customer still loads", async () => {
    H.failCounts = true;
    const customer = await getCustomer("u1");
    expect(customer?.first_name).toBe("Asha");
    expect(customer?.order_count).toBeNull();
    expect(customer?.has_orders).toBeNull();
  });
});
