import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  reads: vi.fn(),
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
import { getActiveCategories } from "./queries";
beforeEach(() => {
  h.reads.mockReset();
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
