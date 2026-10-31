/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The product editor's read carries StoreMink's block on the product (takedown
// design 7.3): set only for a block the store was told about (D21), read in its
// own scope once the editor's scope has closed, and a failed read marks
// nothing.

const H = vi.hoisted(() => ({
  productRow: null as Record<string, unknown> | null,
  canSettings: true,
  openScopes: 0,
  scopesAtRead: [] as number[],
}));

vi.mock("@/app/dashboard/lib/access", () => ({
  getActingStoreId: vi.fn(async () => "s1"),
  getViewerAccess: vi.fn(async () => ({
    can: (section: string) => (section === "settings" ? H.canSettings : true),
  })),
}));
vi.mock("@/lib/analytics/store-entitlement", () => ({
  storeHasAnalyticsFeature: vi.fn(async () => false),
}));
vi.mock("@/lib/db/client", () => {
  // The editor's selects, in order: the product, its variants, the category
  // options, the tax classes.
  function query(result: () => unknown) {
    const q: any = {
      from: () => q,
      leftJoin: () => q,
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return q;
  }
  return {
    withService: vi.fn(async (fn: (db: any) => Promise<any>) => {
      const results: (() => unknown)[] = [
        () => (H.productRow ? [H.productRow] : []),
        () => [],
        () => [],
        () => [],
      ];
      let i = 0;
      H.openScopes += 1;
      try {
        return await fn({ select: () => query(results[i++] ?? (() => [])) });
      } finally {
        H.openScopes -= 1;
      }
    }),
  };
});
vi.mock("@/lib/moderation/merchant", () => ({
  blockedItemIds: vi.fn(async () => {
    H.scopesAtRead.push(H.openScopes);
    return new Map<string, string>();
  }),
}));

import { getViewerAccess } from "@/app/dashboard/lib/access";
import { blockedItemIds } from "@/lib/moderation/merchant";
import { getProductEditData } from "./data";

beforeEach(() => {
  H.productRow = {
    id: "p1",
    name: "Shoe",
    slug: "shoe",
    status: "published",
    cat_id: null,
    cat_name: null,
    cat_slug: null,
  };
  H.canSettings = true;
  H.openScopes = 0;
  H.scopesAtRead = [];
});

describe("getProductEditData and StoreMink's block", () => {
  it("carries a told block with its notice, read once after the scope closed", async () => {
    vi.mocked(blockedItemIds).mockImplementationOnce(async () => {
      H.scopesAtRead.push(H.openScopes);
      return new Map([["p1", "blk-1"]]);
    });
    const data = await getProductEditData("p1");

    expect(blockedItemIds).toHaveBeenCalledTimes(1);
    expect(blockedItemIds).toHaveBeenCalledWith("s1", "product");
    expect(H.scopesAtRead).toEqual([0]);
    expect(data?.product.blockedByStoreMink).toEqual({
      blockId: "blk-1",
      canSeeNotices: true,
    });
  });

  it("no See why for an admin who cannot open the notices", async () => {
    H.canSettings = false;
    vi.mocked(blockedItemIds).mockResolvedValueOnce(new Map([["p1", "blk-1"]]));
    const data = await getProductEditData("p1");

    expect(data?.product.blockedByStoreMink).toEqual({
      blockId: "blk-1",
      canSeeNotices: false,
    });
  });

  it("a product with no told block carries nothing (D21)", async () => {
    vi.mocked(blockedItemIds).mockResolvedValueOnce(
      new Map([["another-product", "blk-2"]]),
    );
    const data = await getProductEditData("p1");

    expect(data?.product.id).toBe("p1");
    expect(data?.product.blockedByStoreMink).toBeUndefined();
    expect(getViewerAccess).not.toHaveBeenCalled();
  });

  it("a failed read marks nothing and the editor still loads", async () => {
    vi.mocked(blockedItemIds).mockRejectedValueOnce(new Error("db down"));
    const data = await getProductEditData("p1");

    expect(data?.product.id).toBe("p1");
    expect(data?.product.blockedByStoreMink).toBeUndefined();
  });

  it("a product that is not found asks nothing", async () => {
    H.productRow = null;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const data = await getProductEditData("missing");

    expect(data).toBeNull();
    expect(blockedItemIds).not.toHaveBeenCalled();
  });
});
