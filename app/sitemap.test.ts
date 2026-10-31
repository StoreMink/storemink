import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The behavioural half (takedown T8b): the real sitemap() over mocked reads.
// The host is a store host, indexing is on, and the readers return what this
// file sets. The blocked set is built by the real pure builder, from outside
// addresses only, so no bucket configuration is involved.
const state = vi.hoisted(() => ({
  products: [] as Record<string, unknown>[],
  categories: [] as Record<string, unknown>[],
  blogs: [] as Record<string, unknown>[],
  blocked: [] as string[],
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: "shop.example.com" })),
}));
vi.mock("@/lib/store/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store/host")>()),
  SEARCH_INDEXABLE: true,
}));
vi.mock("@/lib/store/launch", () => ({
  isStoreSearchIndexable: vi.fn(() => true),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: vi.fn(async () => ({ id: "store-1" })),
}));
vi.mock("@/lib/site", () => ({
  HELP_URL: "https://help.example.com",
  PLATFORM_URL: "https://platform.example.com",
  POS_URL: "https://pos.example.com",
  THEMES_URL: "https://themes.example.com",
  storeOrigin: vi.fn(() => "https://shop.example.com"),
}));
vi.mock("@/lib/help/queries", () => ({
  getPublishedHelpArticleParams: vi.fn(async () => []),
}));
vi.mock("@/lib/storefront/queries", () => ({
  getPublishedProducts: vi.fn(async () => state.products),
  getPublishedBlogCards: vi.fn(async () => state.blogs),
  getPublishedPageSlugs: vi.fn(async () => []),
  getActiveCategories: vi.fn(async () => state.categories),
}));
vi.mock("@/lib/moderation/blocked-objects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/blocked-objects")>();
  return {
    ...actual,
    blockedMedia: vi.fn(async () =>
      actual.buildBlockedMediaSet(
        state.blocked.map((objectPath, i) => ({
          id: `block-${i}`,
          objectPath,
          fileSource: "external",
          storeId: "store-1",
          objectMd5: null,
          tellStore: true,
        })),
        { bucket: null, loadedAt: Date.now() },
      ),
    ),
  };
});

import sitemap from "./sitemap";
import { PLACEHOLDER_URL_PATH } from "@/lib/moderation/placeholder";

const RAW = readFileSync(join(process.cwd(), "app/sitemap.ts"), "utf8");

// Strip comments before matching. The file DISCUSSES `new Date()` and
// `export const revalidate` at length — explaining why neither belongs here is
// the point — so a naive scan of the raw text flags the very documentation
// that keeps the invariant from being undone.
const SOURCE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/**
 * A source-level guard, in the style of the RESERVED_PAGE_SLUGS drift test and
 * lib/email/send-coverage.test.ts.
 *
 * Testing the real sitemap() would mean standing up headers() and the whole DB
 * read path for what is really a one-line invariant: NO URL may carry a lastmod
 * derived from the current time. The bug this prevents is invisible in any
 * single response — you only see it by fetching twice and diffing, which is
 * exactly what nobody does. It cost this site its lastmod credibility site-wide:
 * every static path, every product, the help hub and every help category
 * shipped `new Date()`, so two fetches four seconds apart disagreed, and
 * Google's documented response to unreliable lastmod is to disregard it for the
 * whole site — discarding the blog and help-article dates that were accurate.
 */
describe("sitemap lastmod honesty", () => {
  it("never constructs a current-time Date", () => {
    // `new Date()` with no argument is the only way to get "now" here.
    // `new Date(someTimestamp)` is fine and is how every real lastmod is built.
    const bare = SOURCE.match(/new Date\(\s*\)/g) ?? [];
    expect(
      bare,
      "app/sitemap.ts must derive every lastModified from a real content " +
        "timestamp, or omit it — never from the request time",
    ).toEqual([]);
  });

  it("does not export a revalidate value", () => {
    // The route awaits headers(), which forces it dynamic — any `revalidate`
    // here is dead config that reads as a freshness guarantee it cannot make.
    expect(/export\s+const\s+revalidate/.test(SOURCE)).toBe(false);
  });

  it("resolves the store origin through storeOrigin(), not custom_domain", () => {
    // Guards the fix in lib/site.ts: building the origin inline from
    // `custom_domain ?? subdomain` skips the verified check and canonicalises
    // the whole store onto a domain we may not serve.
    expect(SOURCE).toContain("storeOrigin(store)");
    expect(SOURCE).not.toMatch(/custom_domain\s*\?\?/);
  });
});

describe("sitemap image entries leave taken-down images out", () => {
  const SITE = "https://shop.example.com";

  beforeEach(() => {
    state.blocked = [];
    state.products = [];
    state.categories = [];
    state.blogs = [];
  });

  function entry(entries: Awaited<ReturnType<typeof sitemap>>, url: string) {
    const found = entries.find((e) => e.url === url);
    expect(found, `no sitemap entry for ${url}`).toBeTruthy();
    return found!;
  }

  it("lists no image for the placeholder a reader swapped in", async () => {
    state.products = [
      {
        slug: "linen-shirt",
        image_url: PLACEHOLDER_URL_PATH,
        content_updated_at: null,
        category_id: "c1",
      },
    ];
    state.categories = [
      { id: "c1", slug: "shirts", image_url: PLACEHOLDER_URL_PATH },
    ];
    state.blogs = [
      {
        slug: "summer-edit",
        published_at: null,
        cover_image_url: PLACEHOLDER_URL_PATH,
      },
    ];

    const entries = await sitemap();

    // The pages stay listed; only their image goes.
    expect(entry(entries, `${SITE}/shop/linen-shirt`).images).toBeUndefined();
    expect(entry(entries, `${SITE}/collections/shirts`).images).toBeUndefined();
    expect(entry(entries, `${SITE}/blogs/summer-edit`).images).toBeUndefined();
    // And the placeholder is never listed under any page.
    expect(JSON.stringify(entries)).not.toContain(PLACEHOLDER_URL_PATH);
  });

  it("lists no image for a blocked address a reader did not swap", async () => {
    const blockedPhoto = "https://cdn.example.com/blocked-shirt.jpg";
    state.blocked = [blockedPhoto];
    state.products = [
      {
        slug: "linen-shirt",
        image_url: blockedPhoto,
        content_updated_at: null,
        category_id: null,
      },
    ];

    const entries = await sitemap();

    expect(entry(entries, `${SITE}/shop/linen-shirt`).images).toBeUndefined();
    expect(JSON.stringify(entries)).not.toContain(blockedPhoto);
  });

  it("still lists an image nobody blocked", async () => {
    state.blocked = ["https://cdn.example.com/someone-else.jpg"];
    state.products = [
      {
        slug: "linen-shirt",
        image_url: "https://cdn.example.com/linen-shirt.jpg",
        content_updated_at: null,
        category_id: null,
      },
      {
        slug: "basket",
        image_url: "/themes/basket/hero.webp",
        content_updated_at: null,
        category_id: null,
      },
    ];

    const entries = await sitemap();

    expect(entry(entries, `${SITE}/shop/linen-shirt`).images).toEqual([
      "https://cdn.example.com/linen-shirt.jpg",
    ]);
    expect(entry(entries, `${SITE}/shop/basket`).images).toEqual([
      `${SITE}/themes/basket/hero.webp`,
    ]);
  });
});
