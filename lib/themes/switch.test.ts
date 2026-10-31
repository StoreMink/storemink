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
vi.mock("./apply", async (importOriginal) => {
  const real = await importOriginal<typeof import("./apply")>();
  return {
    ...real,
    seedMenus: vi.fn(async () => {}),
    revalidateThemeSeed: vi.fn(),
  };
});

import { getTableName } from "drizzle-orm";
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
import {
  loadThemeSwitchContext,
  switchStoreThemeTo,
  THEME_ALREADY_CHOSEN_MESSAGE,
} from "./switch";

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

function mockStore(opts: {
  settings?: Record<string, unknown>;
  /** The homepage row's sections; null for no homepage row. */
  homeSections?: unknown[] | null;
  chrome?: { draft: unknown; published: unknown } | null;
}): DbMock {
  const row = storeRow(opts.settings);
  const home = opts.homeSections === undefined ? [] : opts.homeSections;
  const pages = [...(home === null ? [] : [{ slug: "" }]), { slug: "faqs" }];
  return makeDbMock({
    returning: [{ updatedAt: "2026-10-10 12:00:00+00" }],
    selectByTable: {
      stores: [
        [row],
        [{ settings: row.settings }],
        [{ settings: row.settings }],
      ],
      store_pages: [
        pages,
        home === null ? [] : [{ sections: home, publishedSections: [] }],
      ],
      store_chrome: [opts.chrome ? [opts.chrome] : []],
    },
  });
}

/** The tables every select of `mock` reads from, in order. */
function recordTables(mock: DbMock): string[] {
  const read: string[] = [];
  const original = mock.db.select;
  mock.db.select = (...args: any[]) => {
    const step = original(...args);
    const from = step.from;
    step.from = (table: any) => {
      read.push(getTableName(table));
      return from(table);
    };
    return step;
  };
  return read;
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
  it("reads a store that already has its theme", async () => {
    const ctx = await loadThemeSwitchContext("store-1");
    expect(ctx?.facts).toEqual({
      firstTheme: false,
      launched: false,
      homepage: "missing",
      hasBuilderChrome: false,
      brandColorUnset: false,
      hasDesignOverrides: false,
    });
    expect(ctx?.plan).toBe("free");
    expect(ctx?.managedByOperators).toBe(false);
  });

  it("★ reads no products, categories or orders: an install never touches the catalogue", async () => {
    const mock = mockStore({});
    const read = recordTables(mock);
    dbHolder.current = mock;
    await loadThemeSwitchContext("store-1");
    expect(read.sort()).toEqual([
      "store_chrome",
      "store_pages",
      "store_pages",
      "stores",
    ]);
  });

  it("reads a homepage with sections, a Builder header and design choices", async () => {
    dbHolder.current = mockStore({
      homeSections: [{ id: "s1", type: "hero" }],
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
      brandColorUnset: false,
    });
  });

  it("demo and Theme Studio preview stores are managed by operators", async () => {
    dbHolder.current = mockStore({ settings: { demo: true } });
    expect((await loadThemeSwitchContext("store-1"))?.managedByOperators).toBe(
      true,
    );
  });
});

describe("switchStoreThemeTo on a store that already has a theme", () => {
  const input = {
    storeId: "store-1",
    theme: vitrine,
    replaceEditedHomepage: false,
    actorUserId: "owner-1",
  };

  // ★★ A theme is chosen once (owner, 31 Oct 2026): a store with a theme
  // keeps it, whatever the dialog or a direct call asks for.
  it("★★ refuses to switch, writing nothing", async () => {
    const mock = mockStore({});
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result).toEqual({ ok: false, error: THEME_ALREADY_CHOSEN_MESSAGE });
    expect(mock.calls.update).toEqual([]);
    expect(mock.calls.insert).toEqual([]);
    expect(mock.calls.delete).toEqual([]);
    expect(seedMenus).not.toHaveBeenCalled();
    expect(revalidateThemeSeed).not.toHaveBeenCalled();
  });

  it("refuses the theme already in use the same way", async () => {
    const mock = mockStore({});
    dbHolder.current = mock;
    expect(await switchStoreThemeTo({ ...input, theme: basket })).toEqual({
      ok: false,
      error: THEME_ALREADY_CHOSEN_MESSAGE,
    });
    expect(mock.calls.update).toEqual([]);
  });

  it("the refusal points at Customise storefront and the Website Builder", () => {
    expect(THEME_ALREADY_CHOSEN_MESSAGE).toContain("Customise storefront");
    expect(THEME_ALREADY_CHOSEN_MESSAGE).toContain("Website Builder");
    expect(THEME_ALREADY_CHOSEN_MESSAGE).not.toMatch(/[–—]/);
  });

  it("refuses a demo store", async () => {
    const mock = mockStore({ settings: { demo: true } });
    dbHolder.current = mock;
    const result = await switchStoreThemeTo(input);
    expect(result.ok).toBe(false);
    expect(mock.calls.update).toEqual([]);
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
].map((slug) => ({ slug }));

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
    pages?: { slug: string }[];
    home?: { sections: unknown; publishedSections: unknown } | null;
    chrome?: { draft: unknown; published: unknown } | null;
  } = {},
): DbMock {
  const settings = opts.settings ?? pendingSettings();
  const pages = [...(opts.home ? [{ slug: "" }] : []), ...(opts.pages ?? [])];
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
      hasBuilderChrome: false,
      brandColorUnset: true,
      hasDesignOverrides: false,
    });
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

  it("a brand colour the merchant set is not unset", async () => {
    dbHolder.current = mockPendingStore({
      settings: pendingSettings({
        brand: { name: "Acme Foods", primaryColor: "#123456" },
      }),
    });
    expect(
      (await loadThemeSwitchContext("store-1"))?.facts.brandColorUnset,
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
        homepage: "replace",
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
      pages: [...POLICY_PAGES, { slug: "our-edit" }],
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

  it("★ never reads or writes the catalogue, and still sets up menus", async () => {
    const mock = mockPendingStore();
    const read = recordTables(mock);
    dbHolder.current = mock;
    expect(await switchStoreThemeTo(input)).toMatchObject({
      ok: true,
      plan: { menus: "replace" },
    });
    for (const table of ["products", "categories", "orders"]) {
      expect(read).not.toContain(table);
    }
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
  });

  it("★ a Builder header and footer keeps the theme's menus out", async () => {
    const mock = mockPendingStore({ chrome: { draft: {}, published: null } });
    dbHolder.current = mock;
    expect(await switchStoreThemeTo(input)).toMatchObject({
      ok: true,
      plan: { menus: "keep" },
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
      plan: { homepage: "keep" },
    });
    // The theme's other pages still fill free slugs.
    const written = pageInserts(mock).map((v) => v.slug);
    expect(written).not.toContain("");
    expect(written.length).toBeGreaterThan(0);

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

  it("refuses a theme above the store's plan", async () => {
    const mock = mockPendingStore();
    dbHolder.current = mock;
    const result = await switchStoreThemeTo({ ...input, minPlan: "pro" });
    expect(result).toEqual({
      ok: false,
      error: `${vitrine.name} needs the Pro plan or above.`,
    });
    expect(mock.calls.update).toEqual([]);
  });

  it("★★ the theme's pages arrive with no button pointing at its samples", async () => {
    const mock = mockPendingStore();
    dbHolder.current = mock;
    expect((await switchStoreThemeTo(input)).ok).toBe(true);
    const addresses = sampleAddresses(vitrine);
    const hrefs = pageInserts(mock).flatMap((v) => sectionHrefs(v.sections));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((href) => isSampleLink(href, addresses))).toEqual([]);
  });

  it("★ a failed design write changes nothing else", async () => {
    const mock = mockPendingStore();
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
        "We couldn't set up your theme. Nothing was changed. Please try again.",
    });
    expect(mock.calls.delete).toEqual([]);
    expect(mock.calls.insert).toEqual([]);
    expect(seedMenus).not.toHaveBeenCalled();
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
