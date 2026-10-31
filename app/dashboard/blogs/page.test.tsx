// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Blogs page reads which posts StoreMink blocked and told the store about
// (takedown design 7.3) and hands them to the list, with whether this admin
// may open the notices. A block kept from the store never reaches it (D21),
// and a failed read marks nothing.

const H = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  canSettings: true,
}));

vi.mock("../lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({
    can: (section: string) => (section === "settings" ? H.canSettings : true),
  })),
  getActingStoreId: vi.fn(async () => "s1"),
}));
vi.mock("@/lib/db/client", () => {
  // One chain for every select the page makes: the rows end in offset(), the
  // status counts in groupBy(), and the two plain counts are awaited as is.
  function query() {
    let kind: "rows" | "groups" | "count" = "count";
    const q: any = {
      from: () => q,
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      offset: () => {
        kind = "rows";
        return q;
      },
      groupBy: () => {
        kind = "groups";
        return q;
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
        Promise.resolve(
          kind === "rows"
            ? H.rows
            : kind === "groups"
              ? [{ status: "published", n: H.rows.length }]
              : [{ n: H.rows.length }],
        ).then(resolve, reject),
    };
    return q;
  }
  return {
    withService: vi.fn(async (fn: (db: any) => Promise<any>) =>
      fn({ select: () => query() }),
    ),
  };
});
vi.mock("@/lib/blog-taxonomy", () => ({
  fetchBlogTaxonomy: vi.fn(async () => ({ categories: [], tags: [] })),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: false,
  gcsPublicUrl: () => "",
}));
vi.mock("@/lib/moderation/merchant", () => ({
  blockedItemIds: vi.fn(async () => new Map<string, string>()),
}));
vi.mock("../components/realtime-refresher", () => ({
  RealtimeRefresher: () => null,
}));
vi.mock("./blogs-management-view", () => ({
  BlogsManagementView: vi.fn(() => "blogs list"),
}));

import { blockedItemIds } from "@/lib/moderation/merchant";
import { BlogsManagementView } from "./blogs-management-view";
import BlogsPage from "./page";

function row(id: string): Record<string, unknown> {
  return {
    id,
    title: `Post ${id}`,
    slug: `post-${id}`,
    status: "published",
    tags: [],
    categories: [],
    featured: false,
    submitted_by: null,
    is_customer_submission: false,
  };
}

function viewProps(): Record<string, any> {
  const calls = vi.mocked(BlogsManagementView).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Record<string, any>;
}

async function renderPage() {
  render(await BlogsPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  H.rows = [row("a"), row("b")];
  H.canSettings = true;
});

describe("Blogs page and posts blocked by StoreMink", () => {
  it("reads the store's blocked posts once and hands them to the list", async () => {
    vi.mocked(blockedItemIds).mockResolvedValueOnce(new Map([["a", "b1"]]));
    await renderPage();

    expect(blockedItemIds).toHaveBeenCalledTimes(1);
    expect(blockedItemIds).toHaveBeenCalledWith("s1", "blog_post");
    // ★ Only the told block: post b is listed and not marked.
    expect(viewProps().blockedByStoreMink).toEqual({ a: "b1" });
    expect(viewProps().blogs.map((b: { id: string }) => b.id)).toEqual([
      "a",
      "b",
    ]);
    expect(viewProps().canSeeNotices).toBe(true);
  });

  it("a failed read marks nothing and the list still loads", async () => {
    vi.mocked(blockedItemIds).mockRejectedValueOnce(new Error("db down"));
    await renderPage();

    expect(viewProps().blockedByStoreMink).toEqual({});
    expect(viewProps().blogs).toHaveLength(2);
  });

  it("no See why for an admin who cannot open the notices", async () => {
    H.canSettings = false;
    await renderPage();

    expect(viewProps().canSeeNotices).toBe(false);
  });
});
