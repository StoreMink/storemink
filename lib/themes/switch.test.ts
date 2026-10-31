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
    seedMenus: vi.fn(async () => {}),
    revalidateThemeSeed: vi.fn(),
  };
});

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  categories,
  products,
  storeMenus,
  storePages,
  stores,
} from "@/drizzle/schema";
import { getThemeDefinition } from "./index";
import { seedMenus, revalidateThemeSeed } from "./apply";
import { isSampleLink, sampleAddresses } from "./sample-links";
import { resolveInstalledThemeDefinition } from "./runtime-registry";
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

/** Every WHERE the mock saw, rendered as SQL text with its parameters. */
function whereTexts(mock: DbMock): { sql: string; params: unknown[] }[] {
  const dialect = new PgDialect();
  return mock.calls.where
    .filter((c: unknown) => c && typeof c === "object")
    .map((c: unknown) => dialect.sqlToQuery(c as SQL));
}

/** Every href / *_href value in a list of sections. */
function sectionHrefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(sectionHrefs);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) =>
    (key === "href" || key.endsWith("_href")) && typeof nested === "string"
      ? [nested]
      : sectionHrefs(nested),
  );
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
      firstTheme: false,
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

  it("an empty catalogue has no samples to remove", async () => {
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

  it("★ refuses a first-install dialog once the store already has a theme", async () => {
    const mock = mockStore({});
    dbHolder.current = mock;
    const result = await switchStoreThemeTo({
      ...input,
      expectFirstTheme: true,
    });
    expect(result).toEqual({
      ok: false,
      error:
        "A theme was just chosen for your store. Reload the page to see it.",
    });
    expect(mock.calls.update).toEqual([]);
    expect(mock.calls.insert).toEqual([]);
  });

  it("★ a fresh store takes the new design and pages, and loses the old samples", async () => {
    const mock = mockStore({});
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toEqual({
      ok: true,
      warnings: [],
      plan: {
        firstTheme: false,
        homepage: "replace",
        addMissingPages: true,
        catalogue: "remove-samples",
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

    // ★ The old samples went, and nothing new was seeded.
    expect(mock.calls.delete).toEqual([products, categories]);
    expect(mock.calls.insert).not.toContain(products);
    expect(mock.calls.insert).not.toContain(categories);
    // ★ Menus without their links to samples the store doesn't have.
    expect(seedMenus).toHaveBeenCalledWith(
      "store-1",
      vitrine,
      "owner-1",
      expect.any(Function),
      { withoutSampleLinks: true },
    );
    // Homepage written, published; missing pages added without overwriting.
    const homepage = mock.calls.values.find(
      (v: any) => v.slug === "" && v.storeId === "store-1",
    );
    expect(homepage).toMatchObject({ status: "published" });
    expect(homepage.sections.length).toBeGreaterThan(0);
    expect(revalidateThemeSeed).toHaveBeenCalled();
  });

  it("★★ the old samples are recognised by their seeded address AND name, still a draft and untouched", async () => {
    // Vitrine names its samples like real goods, so the old "(Sample)" mark
    // never matched them. The pair does.
    const mock = mockStore({
      settings: {
        template: "vitrine",
        theme: { presetId: "vitrine", presetVersion: vitrine.release.version },
        brand: { primaryColor: vitrine.preset.brand.primaryColor },
      },
    });
    dbHolder.current = mock;
    expect((await switchStoreThemeTo({ ...input, theme: basket })).ok).toBe(
      true,
    );
    const removal = whereTexts(mock).find((w) =>
      w.sql.includes('("products"."slug", "products"."name") in'),
    );
    expect(removal).toBeDefined();
    expect(removal!.sql).toContain(`"products"."status" = 'draft'`);
    const seed = vitrine.preset.sampleData!.products[0]!;
    expect(removal!.params).toEqual(
      expect.arrayContaining([seed.slug, seed.name]),
    );
    // A category a product still sits in is never deleted.
    expect(
      whereTexts(mock).some((w) =>
        w.sql.includes("not exists (select 1 from products p"),
      ),
    ).toBe(true);
  });

  it("★★ the theme's pages arrive with no button pointing at its samples", async () => {
    const mock = mockStore({});
    dbHolder.current = mock;
    expect((await switchStoreThemeTo(input)).ok).toBe(true);
    const addresses = sampleAddresses(vitrine);
    const hrefs = pageInserts(mock).flatMap((v) => sectionHrefs(v.sections));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((href) => isSampleLink(href, addresses))).toEqual([]);
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

  it("a Builder-edited header keeps its menus even when the samples go", async () => {
    const mock = mockStore({ chrome: { draft: {}, published: null } });
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toMatchObject({
      ok: true,
      plan: { catalogue: "remove-samples", menus: "keep" },
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
    expect(seedMenus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A store created after 2026-10-11 has no theme until its owner picks one.
// ---------------------------------------------------------------------------

const POLICY_PAGES = [
  "terms",
  "refund-policy",
  "shipping-policy",
  "privacy-policy",
].map((slug) => ({ slug, createdAt: "x", updatedAt: "x" }));

/** A fresh signup: themePending, nothing seeded, the name it was given. */
function pendingSettings(extra: Record<string, unknown> = {}) {
  return {
    brand: { name: "Acme Foods" },
    launched: false,
    themePending: true,
    business: { country: "IN" },
    ...extra,
  };
}

function withoutPending(settings: Record<string, unknown>) {
  const rest = { ...settings };
  delete rest.themePending;
  return rest;
}

function mockPendingStore(
  opts: {
    settings?: Record<string, unknown>;
    /** What the design write's locked read sees, when it differs. */
    lockedSettings?: Record<string, unknown>;
    pages?: { slug: string; createdAt: string; updatedAt: string }[];
    home?: { sections: unknown; publishedSections: unknown } | null;
    products?: { total: number; samples: number };
    categories?: { total: number; samples: number };
    ordered?: boolean;
    chrome?: { draft: unknown; published: unknown } | null;
  } = {},
): DbMock {
  const settings = opts.settings ?? pendingSettings();
  const pages = [
    ...(opts.home ? [{ slug: "", createdAt: "x", updatedAt: "x" }] : []),
    ...(opts.pages ?? []),
  ];
  return makeDbMock({
    returning: [{ updatedAt: "2026-10-11 12:00:00+00" }],
    selectByTable: {
      stores: [
        [
          {
            settings,
            plan: "free",
            planExpiresAt: null,
            compPlan: null,
            compExpiresAt: null,
          },
        ],
        [{ settings: opts.lockedSettings ?? settings }],
        // The homepage record's locked read, after the pin landed.
        [{ settings: withoutPending(settings) }],
      ],
      store_pages: [pages, opts.home ? [opts.home] : []],
      products: [[opts.products ?? { total: 0, samples: 0 }]],
      categories: [[opts.categories ?? { total: 0, samples: 0 }]],
      orders: [opts.ordered ? [{ id: "o1" }] : []],
      store_chrome: [opts.chrome ? [opts.chrome] : []],
    },
  });
}

/** Every store_pages insert's values, in order. */
function pageInserts(mock: DbMock): any[] {
  return mock.calls.insert
    .map((table, i) => ({ table, values: mock.calls.values[i] }))
    .filter((entry) => entry.table === storePages)
    .map((entry) => entry.values);
}

describe("loadThemeSwitchContext on a store with no theme yet", () => {
  it("★ reads a fresh signup as a first install of an empty store", async () => {
    dbHolder.current = mockPendingStore();
    const ctx = await loadThemeSwitchContext("store-1");
    expect(ctx?.facts).toEqual({
      firstTheme: true,
      launched: false,
      homepage: "missing",
      catalogueIsSampleOnly: false,
      hasBuilderChrome: false,
      brandColorIsTheme: true,
      hasDesignOverrides: false,
    });
    expect(ctx?.currentTheme).toBeNull();
    // No theme to resolve, even if a stray key names one.
    expect(resolveInstalledThemeDefinition).not.toHaveBeenCalled();
  });

  it("★ the blank homepage the Website Builder creates counts as missing; one with sections is the merchant's", async () => {
    dbHolder.current = mockPendingStore({
      home: { sections: [], publishedSections: [] },
    });
    expect((await loadThemeSwitchContext("store-1"))?.facts.homepage).toBe(
      "missing",
    );
    dbHolder.current = mockPendingStore({
      home: { sections: [{ id: "s1", type: "hero" }], publishedSections: null },
    });
    expect((await loadThemeSwitchContext("store-1"))?.facts.homepage).toBe(
      "edited",
    );
  });

  it.each([
    ["a product", { products: { total: 1, samples: 0 } }],
    ["a category", { categories: { total: 1, samples: 0 } }],
    ["an order", { ordered: true }],
  ])("★ %s is never read as samples to remove", async (_label, opts) => {
    dbHolder.current = mockPendingStore(opts);
    expect(
      (await loadThemeSwitchContext("store-1"))?.facts.catalogueIsSampleOnly,
    ).toBe(false);
  });

  it("a brand colour the merchant set is not the theme's", async () => {
    dbHolder.current = mockPendingStore({
      settings: pendingSettings({
        brand: { name: "Acme Foods", primaryColor: "#123456" },
      }),
    });
    expect(
      (await loadThemeSwitchContext("store-1"))?.facts.brandColorIsTheme,
    ).toBe(false);
  });

  it("a store without the key is not a first install", async () => {
    // Every store created before the flag existed, and the fallback store.
    dbHolder.current = mockStore({});
    expect((await loadThemeSwitchContext("store-1"))?.facts.firstTheme).toBe(
      false,
    );
  });
});

describe("switchStoreThemeTo on a first install", () => {
  const input = {
    storeId: "store-1",
    theme: vitrine,
    replaceEditedHomepage: false,
    actorUserId: "owner-1",
  };

  it("★ installs the theme, with no samples, and clears themePending with the pin", async () => {
    const mock = mockPendingStore();
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toEqual({
      ok: true,
      warnings: [],
      plan: {
        firstTheme: true,
        homepage: "replace",
        addMissingPages: true,
        catalogue: "keep",
        menus: "replace",
        brandColor: "theme",
      },
    });

    // ★ ONE write pins the theme AND ends "store in progress".
    const [design, record] = settingsWrites(mock);
    expect(design).not.toHaveProperty("themePending");
    expect(design.template).toBe("vitrine");
    expect(design.theme).toMatchObject({
      presetId: "vitrine",
      presetVersion: vitrine.release.version,
    });
    expect(design.theme).not.toHaveProperty("homepageSeededAt");
    // The name the seller typed stays; colour, tagline and blurb arrive.
    expect(design.brand).toEqual({
      name: "Acme Foods",
      primaryColor: vitrine.preset.brand.primaryColor,
      tagline: vitrine.preset.brand.tagline,
      blurb: vitrine.preset.brand.blurb,
    });
    expect(design.launched).toBe(false);
    expect(design.business).toEqual({ country: "IN" });
    // The homepage then records its own seed moment.
    expect(record.theme.homepageSeededAt).toBe("2026-10-11 12:00:00+00");

    // ★★ No samples: nothing deleted, no product or category written.
    expect(mock.calls.delete).toEqual([]);
    expect(mock.calls.insert).not.toContain(products);
    expect(mock.calls.insert).not.toContain(categories);
    expect(seedMenus).toHaveBeenCalledWith(
      "store-1",
      vitrine,
      "owner-1",
      expect.any(Function),
      { withoutSampleLinks: true },
    );
    // The homepage and every one of the theme's pages.
    expect(pageInserts(mock).map((v) => v.slug)).toEqual([
      "",
      ...vitrine.preset.pages.map((p) => p.slug).filter((slug) => slug),
    ]);
    expect(revalidateThemeSeed).toHaveBeenCalled();
  });

  it("★★ policy pages written before the first install survive untouched", async () => {
    const mock = mockPendingStore({
      // Settings → Policies, plus a page of the seller's at a theme slug.
      pages: [
        ...POLICY_PAGES,
        { slug: "our-edit", createdAt: "x", updatedAt: "x" },
      ],
    });
    dbHolder.current = mock;
    expect((await switchStoreThemeTo(input)).ok).toBe(true);

    const written = pageInserts(mock).map((v) => v.slug);
    for (const slug of [...POLICY_PAGES.map((p) => p.slug), "our-edit"]) {
      expect(written).not.toContain(slug);
    }
    expect(written).toEqual(["", "size-guide", "shipping-and-returns"]);
    // No page row is ever updated, and only the homepage upsert may set.
    expect(mock.calls.update).not.toContain(storePages);
    expect(mock.calls.onConflict.filter((c: any) => c.set)).toHaveLength(1);
  });

  it.each([
    ["the store has products", { products: { total: 2, samples: 0 } }],
    ["the store has categories", { categories: { total: 1, samples: 0 } }],
    ["the store has taken an order", { ordered: true }],
  ])(
    "★ touches nothing of the catalogue and still sets up menus when %s",
    async (_label, opts) => {
      const mock = mockPendingStore(opts);
      dbHolder.current = mock;
      const result = await switchStoreThemeTo(input);
      expect(result).toMatchObject({
        ok: true,
        plan: { firstTheme: true, catalogue: "keep", menus: "replace" },
      });
      expect(mock.calls.delete).toEqual([]);
      expect(mock.calls.insert).not.toContain(products);
      expect(mock.calls.insert).not.toContain(categories);
      expect(seedMenus).toHaveBeenCalledWith(
        "store-1",
        vitrine,
        "owner-1",
        expect.any(Function),
        { withoutSampleLinks: true },
      );
    },
  );

  it("★ a Builder header and footer keeps the theme's menus out", async () => {
    const mock = mockPendingStore({ chrome: { draft: {}, published: null } });
    dbHolder.current = mock;
    expect(await switchStoreThemeTo(input)).toMatchObject({
      ok: true,
      plan: { firstTheme: true, catalogue: "keep", menus: "keep" },
    });
    expect(seedMenus).not.toHaveBeenCalled();
    expect(mock.calls.insert).not.toContain(storeMenus);
  });

  it("★ keeps a brand colour, tagline and blurb the seller already set", async () => {
    const brand = {
      name: "Acme Foods",
      primaryColor: "#0a7d55",
      tagline: "Our own words",
      blurb: "Written by us",
    };
    const mock = mockPendingStore({
      settings: pendingSettings({ brand }),
    });
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toMatchObject({ ok: true, plan: { brandColor: "keep" } });
    expect(settingsWrites(mock)[0].brand).toEqual(brand);
  });

  it("★ a homepage the seller built is kept unless they ask, and then saved first", async () => {
    const built = {
      sections: [{ id: "s1", type: "hero" }],
      publishedSections: [],
    };
    let mock = mockPendingStore({ home: built });
    dbHolder.current = mock;
    expect(await switchStoreThemeTo(input)).toMatchObject({
      ok: true,
      plan: { homepage: "keep", addMissingPages: true },
    });
    expect(pageInserts(mock).map((v) => v.slug)).not.toContain("");

    mock = mockPendingStore({ home: built });
    dbHolder.current = mock;
    await switchStoreThemeTo({ ...input, replaceEditedHomepage: true });
    const backup = pageInserts(mock).find((v) =>
      String(v.slug).startsWith("homepage-before-vitrine-"),
    );
    expect(backup).toMatchObject({
      title: "Homepage before Vitrine",
      sections: built.sections,
    });
  });

  it("★ the already-your-theme refusal never fires for a store with no theme", async () => {
    // A stray key from somewhere else must not block the first install.
    const mock = mockPendingStore({
      settings: pendingSettings({ template: "vitrine" }),
    });
    dbHolder.current = mock;
    expect((await switchStoreThemeTo(input)).ok).toBe(true);
  });

  it("refuses a demo or preview store even before its first theme", async () => {
    const mock = mockPendingStore({
      settings: pendingSettings({ demo: true }),
    });
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toEqual({
      ok: false,
      error:
        "This store's theme is managed by StoreMink and can't be changed here.",
    });
    expect(mock.calls.update).toEqual([]);
  });

  // ★ The dialog's lines come from facts loaded with the page. A tab opened
  // while the store had no theme must not get an ordinary switch after it
  // described a first install, or the other way round.
  it("★ refuses when the dialog described a switch but the store has no theme", async () => {
    const mock = mockPendingStore();
    dbHolder.current = mock;
    const result = await switchStoreThemeTo({
      ...input,
      expectFirstTheme: false,
    });
    expect(result).toEqual({
      ok: false,
      error:
        "Your store changed since this page loaded. Reload the page and try again.",
    });
    expect(mock.calls.update).toEqual([]);
    expect(mock.calls.insert).toEqual([]);
  });

  it("proceeds when the dialog described the first install it is about to do", async () => {
    dbHolder.current = mockPendingStore();
    const result = await switchStoreThemeTo({
      ...input,
      expectFirstTheme: true,
    });
    expect(result).toMatchObject({ ok: true, plan: { firstTheme: true } });
  });

  it("★ stops before writing when another tab chose a theme first", async () => {
    const mock = mockPendingStore({
      lockedSettings: {
        brand: { name: "Acme Foods" },
        launched: false,
        template: "basket",
        theme: { presetId: "basket" },
      },
    });
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toEqual({
      ok: false,
      error:
        "A theme was just chosen for your store. Reload the page to see it.",
    });
    expect(mock.calls.update).toEqual([]);
    expect(mock.calls.insert).toEqual([]);
    expect(seedMenus).not.toHaveBeenCalled();
  });
});
