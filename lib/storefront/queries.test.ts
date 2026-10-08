import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  reads: vi.fn(),
  logWarn: vi.fn(),
  nextCache: new Map<string, unknown>(),
}));
vi.mock("@/lib/db/client", () => ({
  withAnon: async (fn: (db: unknown) => unknown) => {
    const query = {
      select: () => query,
      from: () => query,
      where: () => query,
      leftJoin: () => query,
      orderBy: () => h.reads(),
      limit: () => h.reads(),
    };
    return fn(query);
  },
}));
// Model the persistent cache that formerly returned old rows on later requests.
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>, keys: string[]) =>
    async (...args: unknown[]) => {
      const key = JSON.stringify([keys, args]);
      if (!h.nextCache.has(key)) h.nextCache.set(key, await fn(...args));
      return h.nextCache.get(key);
    },
}));
vi.mock("@/lib/observability/logger", () => ({ logWarn: h.logWarn }));
import { getActiveCategories, getPublishedPage } from "./queries";
beforeEach(() => {
  h.reads.mockReset();
  h.logWarn.mockReset();
  h.nextCache.clear();
});
it("reads a saved category name and photo on the next request", async () => {
  h.reads
    .mockResolvedValueOnce([{ id: "c1", name: "Old", image_url: "/old.webp" }])
    .mockResolvedValueOnce([{ id: "c1", name: "New", image_url: "/new.webp" }]);
  expect(await getActiveCategories("store-1")).toMatchObject([{ name: "Old" }]);
  expect(await getActiveCategories("store-1")).toMatchObject([
    { name: "New", image_url: "/new.webp" },
  ]);
  expect(h.reads).toHaveBeenCalledTimes(2);
});

it("serves the sections that still validate and logs each one it drops", async () => {
  h.reads.mockResolvedValueOnce([
    {
      id: "p1",
      slug: "",
      title: "Home",
      seo_title: "",
      seo_description: "",
      seo_noindex: false,
      published_sections: [
        { id: "hero", type: "hero", enabled: true, config: { heading: "Hi" } },
        { id: "gone", type: "carousel_v9", enabled: true, config: {} },
        { id: "hero", type: "usp_bar", enabled: true, config: { items: [] } },
        {
          type: "ticker",
          enabled: true,
          config: { messages: ["Free delivery"] },
        },
      ],
    },
  ]);
  const page = await getPublishedPage("store-1", "");
  expect(page?.published_sections.map((s) => [s.id, s.type])).toEqual([
    ["hero", "hero"],
  ]);
  expect(
    h.logWarn.mock.calls.map(([event, context]) => [event, context]),
  ).toEqual([
    [
      "storefront.page_section_dropped",
      expect.objectContaining({
        storeId: "store-1",
        slug: "",
        index: 1,
        sectionId: "gone",
        sectionType: "carousel_v9",
        reason: "unknown section type.",
      }),
    ],
    [
      "storefront.page_section_dropped",
      expect.objectContaining({
        index: 2,
        sectionId: "hero",
        reason: "duplicate id.",
      }),
    ],
    [
      "storefront.page_section_dropped",
      expect.objectContaining({
        index: 3,
        sectionId: null,
        sectionType: "ticker",
        reason: "missing id.",
      }),
    ],
  ]);
});

it("a page whose stored sections are not a list serves no sections, not a 404", async () => {
  h.reads.mockResolvedValueOnce([
    {
      id: "p1",
      slug: "about",
      title: "About",
      seo_title: "",
      seo_description: "",
      seo_noindex: false,
      published_sections: { legacy: true },
    },
  ]);
  const page = await getPublishedPage("store-1", "about");
  expect(page).toMatchObject({ slug: "about", published_sections: [] });
  expect(h.logWarn).toHaveBeenCalledWith(
    "storefront.page_section_dropped",
    expect.objectContaining({ reason: "Sections must be a list." }),
  );
});
