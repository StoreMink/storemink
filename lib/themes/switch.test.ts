/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, type DbMock } from "@/app/actions/_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("./runtime-registry", () => ({
  resolveInstalledThemeDefinition: vi.fn(async (selection: any) => {
    const { getThemeDefinition } = await import("./index");
    return selection ? getThemeDefinition(selection.id) : null;
  }),
}));
vi.mock("./apply", async (importOriginal) => {
  const real = await importOriginal<typeof import("./apply")>();
  return {
    ...real,
    seedSampleCatalogue: vi.fn(async () => {}),
    seedMenus: vi.fn(async () => {}),
    revalidateThemeSeed: vi.fn(),
  };
});

import {
  categories,
  products,
  storeMenus,
  storePages,
  stores,
} from "@/drizzle/schema";
import { getThemeDefinition } from "./index";
import { seedMenus, seedSampleCatalogue, revalidateThemeSeed } from "./apply";
import { loadThemeSwitchContext, switchStoreThemeTo } from "./switch";

const basket = getThemeDefinition("basket");
const vitrine = getThemeDefinition("vitrine");

/** A store on Basket, two days after signup. */
function storeRow(settings: Record<string, unknown> = {}) {
  return {
    settings: {
      template: "basket",
      theme: { presetId: "basket", presetVersion: basket.release.version },
      launched: false,
      brand: { primaryColor: basket.preset.brand.primaryColor },
      ...settings,
    },
    plan: "free",
    planExpiresAt: null,
    compPlan: null,
    compExpiresAt: null,
  };
}

const SEEDED_HOME = {
  slug: "",
  createdAt: "2026-10-08 09:00:00+00",
  updatedAt: "2026-10-08 09:00:00.400000+00",
};
const EDITED_HOME = { ...SEEDED_HOME, updatedAt: "2026-10-09 18:00:00+00" };

function mockStore(opts: {
  settings?: Record<string, unknown>;
  home?: typeof SEEDED_HOME | null;
  products?: { total: number; samples: number };
  categories?: { total: number; samples: number };
  ordered?: boolean;
  chrome?: { draft: unknown; published: unknown } | null;
  homepageWritten?: string;
}): DbMock {
  const row = storeRow(opts.settings);
  const pages =
    opts.home === null
      ? [{ slug: "faqs", createdAt: "x", updatedAt: "x" }]
      : [
          opts.home ?? SEEDED_HOME,
          { slug: "faqs", createdAt: "x", updatedAt: "x" },
        ];
  return makeDbMock({
    returning: [
      { updatedAt: opts.homepageWritten ?? "2026-10-10 12:00:00+00" },
    ],
    selectByTable: {
      // The context read, then the design write's locked read, then the
      // homepage record's locked read.
      stores: [
        [row],
        [{ settings: row.settings }],
        [{ settings: row.settings }],
      ],
      store_pages: [pages, opts.home === null ? [] : [{ sections: [] }]],
      products: [[opts.products ?? { total: 6, samples: 6 }]],
      categories: [[opts.categories ?? { total: 4, samples: 4 }]],
      orders: [opts.ordered ? [{ id: "o1" }] : []],
      store_chrome: [opts.chrome ? [opts.chrome] : []],
    },
  });
}

function settingsWrites(mock: DbMock): any[] {
  return mock.calls.update
    .map((table, i) => ({ table, set: mock.calls.set[i] }))
    .filter((entry) => entry.table === stores)
    .map((entry) => entry.set.settings);
}

beforeEach(() => {
  dbHolder.current = mockStore({});
});

describe("loadThemeSwitchContext", () => {
  it("reads a fresh store as all starting content", async () => {
    const ctx = await loadThemeSwitchContext("store-1");
    expect(ctx?.facts).toEqual({
      launched: false,
      homepage: "seeded",
      catalogueIsSampleOnly: true,
      hasBuilderChrome: false,
      brandColorIsTheme: true,
      hasDesignOverrides: false,
    });
    expect(ctx?.plan).toBe("free");
    expect(ctx?.managedByOperators).toBe(false);
  });

  it("★ one product of the merchant's makes the catalogue theirs", async () => {
    dbHolder.current = mockStore({ products: { total: 7, samples: 6 } });
    expect(
      (await loadThemeSwitchContext("store-1"))?.facts.catalogueIsSampleOnly,
    ).toBe(false);
  });

  it("★ a store that has taken an order keeps its catalogue", async () => {
    dbHolder.current = mockStore({ ordered: true });
    expect(
      (await loadThemeSwitchContext("store-1"))?.facts.catalogueIsSampleOnly,
    ).toBe(false);
  });

  it("an empty catalogue is not given new samples", async () => {
    dbHolder.current = mockStore({
      products: { total: 0, samples: 0 },
      categories: { total: 0, samples: 0 },
    });
    expect(
      (await loadThemeSwitchContext("store-1"))?.facts.catalogueIsSampleOnly,
    ).toBe(false);
  });

  it("reads an edited homepage, a Builder header and design choices", async () => {
    dbHolder.current = mockStore({
      home: EDITED_HOME,
      chrome: {
        draft: { design: { palette: { accent: "#123456" } } },
        published: null,
      },
      settings: { brand: { primaryColor: "#ff0000" }, launched: true },
    });
    const facts = (await loadThemeSwitchContext("store-1"))!.facts;
    expect(facts).toMatchObject({
      launched: true,
      homepage: "edited",
      hasBuilderChrome: true,
      hasDesignOverrides: true,
      brandColorIsTheme: false,
    });
  });

  it("demo and Theme Studio preview stores are managed by operators", async () => {
    dbHolder.current = mockStore({ settings: { demo: true } });
    expect((await loadThemeSwitchContext("store-1"))?.managedByOperators).toBe(
      true,
    );
  });
});

describe("switchStoreThemeTo", () => {
  const input = {
    storeId: "store-1",
    theme: vitrine,
    replaceEditedHomepage: false,
    actorUserId: "owner-1",
  };

  it("★ a fresh store takes the new design and its starting content", async () => {
    const mock = mockStore({});
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toEqual({
      ok: true,
      warnings: [],
      plan: {
        homepage: "replace",
        addMissingPages: true,
        catalogue: "swap-samples",
        menus: "replace",
        brandColor: "theme",
      },
    });

    // The design pin moved, with the theme's accent.
    const [design, record] = settingsWrites(mock);
    expect(design.template).toBe("vitrine");
    expect(design.theme).toMatchObject({
      presetId: "vitrine",
      presetVersion: vitrine.release.version,
    });
    expect(design.brand.primaryColor).toBe(vitrine.preset.brand.primaryColor);
    // ★ The homepage records its own seed moment, from the written row.
    expect(record.theme.homepageSeededAt).toBe("2026-10-10 12:00:00+00");

    // The old samples went before the new ones came.
    expect(mock.calls.delete).toEqual([products, categories]);
    expect(seedSampleCatalogue).toHaveBeenCalledWith(
      "store-1",
      vitrine,
      expect.objectContaining({ publishSampleProducts: false }),
    );
    expect(seedMenus).toHaveBeenCalledWith(
      "store-1",
      vitrine,
      "owner-1",
      expect.any(Function),
    );
    // Homepage written, published; missing pages added without overwriting.
    const homepage = mock.calls.values.find(
      (v: any) => v.slug === "" && v.storeId === "store-1",
    );
    expect(homepage).toMatchObject({ status: "published" });
    expect(homepage.sections.length).toBeGreaterThan(0);
    expect(revalidateThemeSeed).toHaveBeenCalled();
  });

  it("★ an edited homepage and the merchant's catalogue are left alone", async () => {
    const mock = mockStore({
      home: EDITED_HOME,
      products: { total: 9, samples: 6 },
      settings: { brand: { primaryColor: "#0a7d55" } },
    });
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toMatchObject({
      ok: true,
      plan: {
        homepage: "keep",
        catalogue: "keep",
        menus: "keep",
        brandColor: "keep",
      },
    });
    expect(mock.calls.delete).toEqual([]);
    expect(seedSampleCatalogue).not.toHaveBeenCalled();
    expect(seedMenus).not.toHaveBeenCalled();
    expect(mock.calls.insert).not.toContain(storePages);
    // Only the design write, with the merchant's colour untouched.
    const writes = settingsWrites(mock);
    expect(writes).toHaveLength(1);
    expect(writes[0].brand.primaryColor).toBe("#0a7d55");
    expect(writes[0].template).toBe("vitrine");
  });

  it("★ replacing an edited homepage keeps a draft copy first", async () => {
    const mock = mockStore({ home: EDITED_HOME });
    dbHolder.current = mock;
    await switchStoreThemeTo({ ...input, replaceEditedHomepage: true });
    const backup = mock.calls.values.find(
      (v: any) =>
        typeof v.slug === "string" &&
        v.slug.startsWith("homepage-before-vitrine-"),
    );
    expect(backup).toMatchObject({
      title: "Homepage before Vitrine",
      seoNoindex: true,
      sections: [],
    });
    // A draft: no status or published sections set.
    expect(backup.status).toBeUndefined();
    expect(backup.publishedSections).toBeUndefined();
  });

  it("a Builder-edited header keeps its menus even when the samples swap", async () => {
    const mock = mockStore({ chrome: { draft: {}, published: null } });
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toMatchObject({
      ok: true,
      plan: { catalogue: "swap-samples", menus: "keep" },
    });
    expect(seedMenus).not.toHaveBeenCalled();
    expect(mock.calls.insert).not.toContain(storeMenus);
  });

  it("refuses the theme already in use, without writing", async () => {
    const mock = mockStore({});
    dbHolder.current = mock;
    const result = await switchStoreThemeTo({ ...input, theme: basket });
    expect(result).toEqual({
      ok: false,
      error: `${basket.name} is already your theme.`,
    });
    expect(mock.calls.update).toEqual([]);
  });

  it("refuses a theme above the store's plan", async () => {
    const mock = mockStore({});
    dbHolder.current = mock;
    const result = await switchStoreThemeTo({ ...input, minPlan: "pro" });
    expect(result).toEqual({
      ok: false,
      error: `${vitrine.name} needs the Pro plan or above.`,
    });
    expect(mock.calls.update).toEqual([]);
  });

  it("refuses a demo store", async () => {
    const mock = mockStore({ settings: { demo: true } });
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result.ok).toBe(false);
    expect(mock.calls.update).toEqual([]);
  });

  it("★ a failed design write changes nothing else", async () => {
    const mock = mockStore({});
    // The design write's locked read fails.
    mock.db.select = (() => {
      const original = mock.db.select;
      let calls = 0;
      return (...args: any[]) => {
        const step = original(...args);
        const from = step.from;
        step.from = (table: any) => {
          if (table === stores && ++calls === 2) {
            throw new Error("connection reset");
          }
          return from(table);
        };
        return step;
      };
    })();
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toEqual({
      ok: false,
      error:
        "We couldn't switch your theme. Nothing was changed. Please try again.",
    });
    expect(mock.calls.delete).toEqual([]);
    expect(seedSampleCatalogue).not.toHaveBeenCalled();
  });
});
