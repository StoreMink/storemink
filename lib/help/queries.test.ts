import { beforeEach, describe, expect, it, vi } from "vitest";

const { results, withAnon, logError } = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  withAnon: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ withAnon }));
vi.mock("@/lib/observability/logger", () => ({ logError }));
vi.mock("next/cache", () => ({
  // Model persistent success-only caching, not an identity function: a caught
  // failure returned as []/null would poison subsequent reads in these tests.
  unstable_cache:
    (read: (...args: unknown[]) => Promise<unknown>, keys: string[]) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify([keys, args]);
      if (results.has(key)) return results.get(key);
      const value = await read(...args);
      results.set(key, value);
      return value;
    },
}));

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  getHelpCategories,
  getHelpCategoryBySlug,
  getHelpCategoryCounts,
  getHelpNavTree,
  getHelpArticleCardsByCategory,
  getPublishedHelpArticle,
  getPopularHelpArticles,
  getRelatedHelpArticles,
  getPublishedHelpArticleParams,
  searchHelpArticles,
  withPosSynonym,
} from "./queries";

const category = {
  id: "cat-1",
  slug: "getting-started",
  title: "Getting started",
  description: "Start here",
  icon: "rocket",
  position: 0,
};
const article = {
  id: "article-1",
  categoryId: category.id,
  slug: "first-store",
  title: "Create your first store",
  excerpt: "Your first steps",
  body: "<p>Welcome</p>",
  status: "published",
  position: 0,
  viewCount: 10,
  updatedAt: null,
  publishedAt: null,
};
const failure = Object.assign(new Error("database read unavailable"), {
  code: "ECONNRESET",
});
const cases = [
  { name: "topics", read: () => getHelpCategories(), rows: [category] },
  {
    name: "counts",
    read: () => getHelpCategoryCounts(),
    rows: [{ categoryId: category.id, count: 8 }],
  },
  {
    name: "category cards",
    read: () => getHelpArticleCardsByCategory(category.id),
    rows: [article],
  },
  {
    name: "article body",
    read: () => getPublishedHelpArticle(article.slug),
    rows: [article],
  },
  {
    name: "popular articles",
    read: () => getPopularHelpArticles(),
    rows: [article],
  },
  {
    name: "related articles",
    read: () => getRelatedHelpArticles(category.id, "other"),
    rows: [article],
  },
  {
    name: "sitemap",
    read: () => getPublishedHelpArticleParams(),
    rows: [
      { categorySlug: category.slug, slug: article.slug, updatedAt: null },
    ],
  },
];

beforeEach(() => {
  results.clear();
  withAnon.mockReset();
  logError.mockReset();
});

describe("Help reads across cold starts and cache misses", () => {
  it.each(cases)(
    "recovers $name on the first request, then caches the result",
    async ({ read, rows }) => {
      withAnon.mockRejectedValueOnce(failure).mockResolvedValue(rows);
      const first = await read();
      expect(first).not.toEqual([]);
      expect(first).not.toEqual({});
      expect(first).not.toBeNull();
      expect(withAnon).toHaveBeenCalledTimes(2);
      expect(await read()).toEqual(first);
      expect(withAnon).toHaveBeenCalledTimes(2);
    },
  );

  it.each(cases)(
    "does not cache a persistent failure as empty $name",
    async ({ read, rows }) => {
      withAnon.mockRejectedValue(failure);
      await expect(read()).rejects.toBe(failure);
      expect(withAnon).toHaveBeenCalledTimes(2);
      expect(results.size).toBe(0);
      withAnon.mockResolvedValue(rows);
      const recovered = await read();
      expect(recovered).not.toBeNull();
      expect(recovered).not.toEqual([]);
      expect(recovered).not.toEqual({});
    },
  );

  it("does not invent an unknown category during a DB outage", async () => {
    withAnon.mockRejectedValue(failure);
    await expect(getHelpCategoryBySlug(category.slug)).rejects.toBe(failure);
    withAnon.mockResolvedValue([category]);
    expect(await getHelpCategoryBySlug(category.slug)).toEqual(category);
  });

  it("only returns article-not-found after a successful query, with separate slug cache keys", async () => {
    withAnon.mockResolvedValueOnce([]).mockResolvedValueOnce([article]);
    expect(await getPublishedHelpArticle("missing")).toBeNull();
    expect(await getPublishedHelpArticle(article.slug)).toMatchObject(article);
    expect(await getPublishedHelpArticle("missing")).toBeNull();
    expect(withAnon).toHaveBeenCalledTimes(2);
  });

  it("keeps genuine empty categories distinct from failures", async () => {
    withAnon.mockResolvedValue([]);
    expect(await getHelpCategories()).toEqual([]);
    expect(await getHelpCategoryBySlug("missing")).toBeNull();
    expect(withAnon).toHaveBeenCalledTimes(1);
  });

  it("does not cache a partially failed navigation tree", async () => {
    withAnon.mockRejectedValue(failure);
    await expect(getHelpNavTree()).rejects.toBe(failure);
    expect(results.size).toBe(0);
    withAnon.mockResolvedValueOnce([category]).mockResolvedValueOnce([article]);
    expect(await getHelpNavTree()).toEqual([
      {
        slug: category.slug,
        title: category.title,
        articles: [{ slug: article.slug, title: article.title }],
      },
    ]);
  });

  it("recognises wrapped Drizzle connection errors", async () => {
    withAnon
      .mockRejectedValueOnce(new Error("Failed query", { cause: failure }))
      .mockResolvedValue([category]);
    expect(await getHelpCategories()).toEqual([category]);
    expect(withAnon).toHaveBeenCalledTimes(2);
  });

  it.each(["42P01", "42501", "42601"])(
    "does not retry schema/permission/SQL errors (%s)",
    async (code) => {
      const error = Object.assign(new Error("not transient"), { code });
      withAnon.mockRejectedValue(error);
      await expect(getHelpCategories()).rejects.toBe(error);
      expect(withAnon).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(
        "Help Centre database read failed",
        undefined,
        { code },
      );
      expect(results.size).toBe(0);
    },
  );
});

// ★ THE GUIDES SAY POS, PEOPLE STILL TYPE "REGISTER" OR "TILL". Since the POS
// rename (26 Oct 2026) no guide uses either word for POS, so without this a
// search for "register" found the DLT, signup and newsletter guides and no POS
// guide at all.
describe("Help search reads register and till as POS", () => {
  it.each([
    ["register", "POS"],
    ["Register", "POS"],
    ["registers", "POS"],
    ["cash register", "POS"],
    ["till", "POS"],
    ["tills", "POS"],
    ["lock the register", "lock the POS"],
    ["register staff", "POS staff"],
    // The guides and the category said "Point of Sale" until the rename too.
    ["point of sale", "POS"],
    ["Point of Sale settings", "POS settings"],
    ["point-of-sale", "POS"],
  ])("reads %j as %j", (query, expected) => {
    expect(withPosSynonym(query)).toBe(expected);
  });

  it.each([
    "registered customers",
    "registration",
    "DLT registration",
    "GST registration",
    "POS",
    "sales point",
  ])("leaves %j alone", (query) => {
    expect(withPosSynonym(query)).toBeNull();
  });

  type FakeQuery = {
    select: () => FakeQuery;
    from: () => FakeQuery;
    innerJoin: () => FakeQuery;
    where: (condition: SQL) => FakeQuery;
    orderBy: () => FakeQuery;
    limit: () => Promise<unknown[]>;
  };

  async function searchParams(query: string): Promise<unknown[]> {
    const conditions: SQL[] = [];
    const db: FakeQuery = {
      select: () => db,
      from: () => db,
      innerJoin: () => db,
      where: (condition) => {
        conditions.push(condition);
        return db;
      },
      orderBy: () => db,
      limit: async () => [],
    };
    withAnon.mockImplementation(async (read: (fake: FakeQuery) => unknown) =>
      read(db),
    );
    await searchHelpArticles(query);
    expect(conditions).toHaveLength(1);
    return new PgDialect().sqlToQuery(conditions[0]).params;
  }

  it("searches the words typed AND the POS reading of them", async () => {
    const params = await searchParams("lock the register");
    expect(params).toContain("lock the register");
    expect(params).toContain("lock the POS");
  });

  it("adds nothing to a query without the old words", async () => {
    const params = await searchParams("GST registration");
    expect(params).toContain("GST registration");
    expect(params).not.toContain("POS");
  });

  // Without it, "point of sale" ranked one POS guide of 17, second, behind
  // the sales analytics guide (local Help, after 0253).
  it("searches the old name as POS too", async () => {
    const params = await searchParams("point of sale");
    expect(params).toContain("point of sale");
    expect(params).toContain("POS");
  });
});
