/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Categories page reads which collections StoreMink blocked and told the
// store about (takedown design 7.3) and hands them to the list, with whether
// this admin may open the notices. A block kept from the store never reaches
// it (D21), and a failed read marks nothing.

const H = vi.hoisted(() => ({
  cats: [] as Record<string, unknown>[],
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
  function query() {
    const q: any = {
      from: () => q,
      where: () => q,
      orderBy: () => q,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
        Promise.resolve(H.cats).then(resolve, reject),
    };
    return q;
  }
  return {
    withService: vi.fn(async (fn: (db: any) => Promise<any>) => {
      H.openScopes += 1;
      try {
        return await fn({
          select: () => query(),
          execute: async () => ({ rows: [] }),
        });
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
vi.mock("./categories-management-view", () => ({
  CategoriesManagementView: vi.fn(() => null),
}));

import { blockedItemIds } from "@/lib/moderation/merchant";
import CategoriesPage from "./page";

function cat(id: string): Record<string, unknown> {
  return {
    id,
    name: `Collection ${id}`,
    slug: `c-${id}`,
    description: null,
    image_url: null,
    sort_order: 0,
    status: "active",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

async function viewProps(): Promise<Record<string, any>> {
  const el = (await CategoriesPage()) as any;
  return el.props as Record<string, any>;
}

beforeEach(() => {
  H.cats = [cat("a"), cat("b")];
  H.canSettings = true;
  H.openScopes = 0;
  H.scopesAtRead = [];
});

describe("Categories page and collections blocked by StoreMink", () => {
  it("reads the store's blocked collections once, after the list's scope closed", async () => {
    vi.mocked(blockedItemIds).mockImplementationOnce(async () => {
      H.scopesAtRead.push(H.openScopes);
      return new Map([["a", "b1"]]);
    });
    const props = await viewProps();

    expect(blockedItemIds).toHaveBeenCalledTimes(1);
    expect(blockedItemIds).toHaveBeenCalledWith("s1", "collection");
    // Never inside another scope's callback.
    expect(H.scopesAtRead).toEqual([0]);
    // ★ Only the told block: collection b is listed and not marked.
    expect(props.blockedByStoreMink).toEqual({ a: "b1" });
    expect(props.categories.map((c: { id: string }) => c.id)).toEqual([
      "a",
      "b",
    ]);
    expect(props.canSeeNotices).toBe(true);
  });

  it("a failed read marks nothing and the list still loads", async () => {
    vi.mocked(blockedItemIds).mockRejectedValueOnce(new Error("db down"));
    const props = await viewProps();

    expect(props.blockedByStoreMink).toEqual({});
    expect(props.categories).toHaveLength(2);
  });

  it("an empty list asks nothing", async () => {
    H.cats = [];
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
