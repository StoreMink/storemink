/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Products page reads which products StoreMink blocked and told the store
// about (takedown design 7.3) and hands them to the list, with whether this
// admin may open the notices. A block kept from the store never reaches it
// (D21), and a failed read marks nothing.

const H = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  canSettings: true,
  openScopes: 0,
  scopesAtRead: [] as number[],
}));

vi.mock("../lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({
    can: (section: string) => (section === "settings" ? H.canSettings : true),
  })),
  getActingStoreId: vi.fn(async () => "s1"),
}));
vi.mock("@/lib/db/client", () => {
  // The page's selects, in order: the page of rows, the total, the status
  // counts, the featured count, the category options, then the variants.
  function query(result: () => unknown) {
    const q: any = {
      from: () => q,
      leftJoin: () => q,
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      offset: () => q,
      groupBy: () => q,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return q;
  }
  return {
    withService: vi.fn(async (fn: (db: any) => Promise<any>) => {
      const results: (() => unknown)[] = [
        () => H.rows,
        () => [{ n: H.rows.length }],
        () => [{ status: "published", n: H.rows.length }],
        () => [{ n: 0 }],
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
vi.mock("@/lib/analytics/store-entitlement", () => ({
  storeHasAnalyticsFeature: vi.fn(async () => false),
}));
vi.mock("@/lib/plans/entitlements", () => ({
  getStorePlanContext: vi.fn(async () => ({ limits: { maxProducts: null } })),
}));
vi.mock("@/lib/moderation/merchant", () => ({
  blockedItemIds: vi.fn(async () => {
    H.scopesAtRead.push(H.openScopes);
    return new Map<string, string>();
  }),
}));
vi.mock("../components/realtime-refresher", () => ({
  RealtimeRefresher: () => null,
}));
vi.mock("./products-management-view", () => ({
  ProductsManagementView: vi.fn(() => null),
}));

import { blockedItemIds } from "@/lib/moderation/merchant";
import { ProductsManagementView } from "./products-management-view";
import ProductsPage from "./page";

function row(id: string): Record<string, unknown> {
  return {
    id,
    name: `Product ${id}`,
    slug: `product-${id}`,
    status: "published",
    cat_id: null,
    cat_name: null,
    cat_slug: null,
  };
}

async function viewProps(): Promise<Record<string, any>> {
  const el = (await ProductsPage({ searchParams: Promise.resolve({}) })) as any;
  const children = [el.props.children].flat() as any[];
  const view = children.find((c) => c?.type === ProductsManagementView);
  if (!view) throw new Error("the list was not rendered");
  return view.props as Record<string, any>;
}

beforeEach(() => {
  H.rows = [row("a"), row("b")];
  H.canSettings = true;
  H.openScopes = 0;
  H.scopesAtRead = [];
});

describe("Products page and products blocked by StoreMink", () => {
  it("reads the store's blocked products once, after the list's scope closed", async () => {
    vi.mocked(blockedItemIds).mockImplementationOnce(async () => {
      H.scopesAtRead.push(H.openScopes);
      return new Map([["a", "b1"]]);
    });
    const props = await viewProps();

    expect(blockedItemIds).toHaveBeenCalledTimes(1);
    expect(blockedItemIds).toHaveBeenCalledWith("s1", "product");
    // Never inside another scope's callback.
    expect(H.scopesAtRead).toEqual([0]);
    // ★ Only the told block: product b is listed and not marked.
    expect(props.blockedByStoreMink).toEqual({ a: "b1" });
    expect(props.products.map((p: { id: string }) => p.id)).toEqual(["a", "b"]);
    expect(props.canSeeNotices).toBe(true);
  });

  it("a failed read marks nothing and the list still loads", async () => {
    vi.mocked(blockedItemIds).mockRejectedValueOnce(new Error("db down"));
    const props = await viewProps();

    expect(props.blockedByStoreMink).toEqual({});
    expect(props.products).toHaveLength(2);
  });

  it("an empty page asks nothing", async () => {
    H.rows = [];
    const props = await viewProps();

    expect(blockedItemIds).not.toHaveBeenCalled();
    expect(props.blockedByStoreMink).toEqual({});
  });

  it("no See why for an admin who cannot open the notices", async () => {
    H.canSettings = false;
    const props = await viewProps();

    expect(props.canSeeNotices).toBe(false);
  });
});
