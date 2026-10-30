/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

const registry = vi.hoisted(() => ({ definition: null as any }));
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveInstalledThemeDefinitionWithDb: vi.fn(async () => registry.definition),
  resolveThemeDefinition: vi.fn(async () => registry.definition),
}));

const gcs = vi.hoisted(() => ({ bucket: "sm-media" }));
vi.mock("@/lib/storage/gcs", () => ({
  gcsObjectInfo: vi.fn(async () => null),
  gcsPathFromUrl: (url: string) => {
    try {
      const parsed = new URL(url);
      const prefix = `/${gcs.bucket}/`;
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "storage.googleapis.com" ||
        !parsed.pathname.startsWith(prefix)
      ) {
        return null;
      }
      return parsed.pathname.slice(prefix.length) || null;
    } catch {
      return null;
    }
  },
}));

const ownershipMock = vi.hoisted(() => ({
  digests: vi.fn(),
  broken: vi.fn(),
}));
vi.mock("./ownership", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ownership")>();
  return {
    ...actual,
    readMinkWrittenSectionDigests: (...args: unknown[]) =>
      ownershipMock.digests(...args),
    findBrokenImages: (...args: unknown[]) => ownershipMock.broken(...args),
  };
});

// ★ The takedown's blocked-file list, read once per snapshot.
const blocks = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("@/lib/moderation/blocked-objects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/blocked-objects")>();
  return {
    ...actual,
    blockedMedia: vi.fn(async () =>
      actual.buildBlockedMediaSet(
        blocks.paths.map((path, i) => ({
          id: `00000000-0000-4000-8000-00000000000${i}`,
          objectPath: path,
          fileSource: "bucket",
          storeId: STORE,
          objectMd5: null,
          tellStore: i % 2 === 0,
        })),
        { bucket: gcs.bucket, loadedAt: 1 },
      ),
    ),
  };
});

import { PgDialect } from "drizzle-orm/pg-core";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";
import { withService } from "@/lib/db/client";
import { blockedMedia } from "@/lib/moderation/blocked-objects";
import { sanitizeChromeForSave } from "@/lib/chrome/types";
import {
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { THEME_DEFINITIONS } from "@/lib/themes";
import { prepareSections } from "@/lib/themes/apply";
import { MinkToolInputError } from "../errors";
import { sectionContentDigest } from "../storefront-personalization-context";
import type { MinkActorContext } from "../types";
import { REVAMP_ERROR_MESSAGES, type RevampRequest } from "./contract";
import {
  revampBrandDigest,
  revampChromeDigest,
  revampSectionsDigest,
} from "./digests";
import { collectRevampImageUrls, isReplaceablePhotoUrl } from "./ownership";
import { RevampStepError, type RevampStepContext } from "./ports";
import { revampExistingProducts } from "./site-compiler";
import {
  readRevampContextForActor,
  readRevampSnapshot,
  REVAMP_CONTEXT_MAX_CHARS,
} from "./snapshot";

const STORE = "11111111-1111-4111-8111-111111111111";
const REVAMP = "99999999-9999-4999-8999-999999999999";
const BUCKET = `https://storage.googleapis.com/${gcs.bucket}`;
const BASKET = THEME_DEFINITIONS[0];
const CREDIT_WORDS = /credit|remaining|planCap|headroom/i;

const MILL = `${BUCKET}/stores/${STORE}/uploads/mill.webp`;
const BROKEN = `${BUCKET}/stores/${STORE}/uploads/broken.webp`;
const MENU = `${BUCKET}/stores/${STORE}/uploads/menu.webp`;
const OILS = `${BUCKET}/stores/${STORE}/uploads/oils.webp`;
const MINK_PHOTO = `${BUCKET}/stores/${STORE}/mink-generated/abc.webp`;

function section(
  id: string,
  type: string,
  config: Record<string, unknown>,
): PageSectionItem {
  return {
    id,
    type: type as PageSectionItem["type"],
    enabled: true,
    config: config as never,
  };
}

/** A page as the theme installs it, round-tripped through storage. */
function themePage(slug: string): PageSectionItem[] {
  const prepared = prepareSections(BASKET, slug);
  if ("error" in prepared) throw new Error(prepared.error);
  return JSON.parse(JSON.stringify(prepared.sections));
}

/** The draft-validated form the snapshot reads sections in. */
function drafted(raw: unknown): PageSectionItem[] {
  const result = validateSections(raw, { mode: "draft" });
  if ("error" in result) throw new Error(result.error);
  return result.sections;
}

const ownText = section("own-text", "rich_text", {
  html: "<p>Our grandmother's recipe.</p>",
});
const ownCode = section("own-code", "custom_code", {
  html: "<div>Hello</div>",
  css: "",
  js: "",
  height_mode: "auto",
  fixed_height: 320,
});
const ownMedia = section("own-media", "media_text", {
  heading: "Our mill",
  body: "We press every batch ourselves.",
  image_url: MILL,
  image_alt: "The mill",
});
const minkHero = section("hero-mink", "hero", {
  heading: "Cold pressed in our own mill",
  image_url: MINK_PHOTO,
});
const storyMedia = section("story-media", "media_text", {
  heading: "Where it started",
  body: "A small press in Jaipur.",
  image_url: BROKEN,
  image_alt: "The first press",
});

const homeTheme = themePage("");
const storyTheme = themePage("our-story");
const homeRaw = [...homeTheme, ownText, ownCode, minkHero, ownMedia];
const storyRaw = [...storyTheme, storyMedia];

function settings(extra: Record<string, unknown> = {}) {
  return {
    theme: { presetId: "basket", presetVersion: "1.0.0" },
    launched: false,
    brand: {
      tagline: "Pressed in Jaipur",
      blurb: "Small batch mustard oil",
      primaryColor: "#2542c7",
    },
    business: { city: "Jaipur", state: "Rajasthan" },
    ...extra,
  };
}

function storeRow(extra: Record<string, unknown> = {}) {
  return {
    id: STORE,
    name: "Lumen Oils",
    slug: "lumen",
    settings: settings(extra),
  };
}

function pageRows() {
  return [
    {
      id: "page-story",
      slug: "our-story",
      title: "Our story",
      status: "published",
      sections: storyRaw,
      seoTitle: "",
      seoDescription: "How we press our oil",
      updatedAt: "2026-10-02 09:00:00.654321+00",
    },
    {
      id: "page-home",
      slug: "",
      title: "",
      status: "published",
      sections: homeRaw,
      seoTitle: "Lumen Oils",
      seoDescription: "",
      updatedAt: "2026-10-03 10:11:12.123456+00",
    },
    {
      id: "page-terms",
      slug: "terms",
      title: "Terms",
      status: "published",
      sections: [section("terms-text", "rich_text", { html: "<p>Terms</p>" })],
      seoTitle: "",
      seoDescription: "",
      updatedAt: "2026-10-01 08:00:00.000001+00",
    },
    {
      id: "page-broken",
      slug: "broken",
      title: "Broken",
      status: "draft",
      sections: [
        { id: "dup", type: "rich_text", config: {} },
        { id: "dup", type: "rich_text", config: {} },
      ],
      seoTitle: "",
      seoDescription: "",
      updatedAt: "2026-10-01 08:30:00+00",
    },
  ];
}

const chromeDraft = {
  header: {
    links: [
      {
        label: "Shop",
        href: "/shop",
        image_url: MENU,
        children: [{ label: "Oils", href: "/collections/oils" }],
      },
    ],
  },
};

function categoryRows() {
  return [
    {
      id: "cat-staples",
      name: "Staples",
      slug: "staples",
      description: null,
      imageUrl: "/themes/basket/staples.webp",
      status: "active",
      createdAt: "2026-09-01 10:00:00+00",
      updatedAt: "2026-09-01 10:00:00+00",
      productCount: 3,
    },
    {
      id: "cat-oils",
      name: "Oils",
      slug: "oils",
      description: "Our oils",
      imageUrl: OILS,
      status: "active",
      createdAt: "2026-09-01 10:00:00+00",
      updatedAt: "2026-10-01 10:00:00+00",
      productCount: 1,
    },
  ];
}

function productRows() {
  return [
    {
      id: "prod-sample",
      name: "Basmati Rice (Sample)",
      slug: "basmati-rice-sample",
      status: "published",
      updatedAt: "2026-09-01 10:00:00+00",
      imageUrl: "/themes/basket/rice.webp",
      images: [""],
      categoryId: "cat-staples",
      featured: true,
    },
    {
      id: "prod-oil",
      name: "Mustard oil",
      slug: "mustard-oil",
      status: "published",
      updatedAt: "2026-10-05 10:00:00.5+00",
      imageUrl: "",
      images: ["", `${BUCKET}/stores/${STORE}/products/oil.webp`],
      categoryId: "cat-oils",
      featured: false,
    },
  ];
}

const shippingRow = { mode: "manual", freeAbove: 999, minDays: 2, maxDays: 5 };

function fullDb(
  options: {
    chrome?: boolean;
    store?: Record<string, unknown> | null;
    billing?: any[];
    /** What the lookup of the request's own product names returns. */
    named?: any[];
    /** The store's pages, when a test needs other rows. */
    pages?: any[];
  } = {},
) {
  const chromeRow = {
    draft: chromeDraft,
    updatedAt: "2026-10-04 01:02:03.456789+00",
  };
  const menus = [
    {
      header: [{ label: "Shop all", href: "/shop" }],
      footer_groups: [
        { title: "Help", links: [{ label: "Contact", href: "/contact" }] },
      ],
      footer_legal: [],
    },
  ];
  return makeDbMock({
    selectByTable: {
      stores: [options.store === null ? [] : [storeRow(options.store ?? {})]],
      store_pages: [options.pages ?? pageRows()],
      store_chrome: [options.chrome === false ? [] : [chromeRow]],
      categories: [categoryRows()],
      products: [productRows(), ...(options.named ? [options.named] : [])],
      store_shipping_settings: [[shippingRow]],
      store_billing_settings: [options.billing ?? []],
    },
    executeQueue:
      options.chrome === false
        ? [menus, [{ online: true }]]
        : [[{ online: true }]],
  });
}

function actor(overrides: Partial<MinkActorContext> = {}): MinkActorContext {
  return {
    storeId: STORE,
    adminId: "admin-1",
    email: "owner@example.com",
    roleSlug: "superadmin",
    permissions: {},
    isSuperadmin: true,
    effectivePlan: "pro",
    locationIds: null,
    analyticsTimeZone: "Asia/Kolkata",
    currency: "INR",
    defaultLowStockThreshold: 5,
    draftingEnabled: true,
    requestId: "req-1",
    ...overrides,
  };
}

function context(
  overrides: Partial<RevampStepContext> = {},
): RevampStepContext {
  return {
    revampId: REVAMP,
    actor: actor(),
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    report: vi.fn(async () => {}),
    ...overrides,
  };
}

const request: RevampRequest = {
  kind: "full",
  brief: {
    business: "Cold pressed mustard oil",
    look: "",
    audience: "",
    facts: [],
    avoid: "",
    language: "English",
  },
  products: [],
  categories: [],
  pages: null,
  instruction: null,
  refineScope: null,
};

/** Array parameters, which `sqlParamValues` takes for literal SQL text. */
function arrayParams(sqlObj: any): unknown[][] {
  const out: unknown[][] = [];
  const walk = (chunk: any): void => {
    if (!chunk || typeof chunk !== "object") return;
    if (Array.isArray(chunk)) return chunk.forEach(walk);
    if (chunk.queryChunks) return walk(chunk.queryChunks);
    if ("encoder" in chunk && Array.isArray(chunk.value)) out.push(chunk.value);
  };
  walk(sqlObj?.queryChunks);
  return out;
}

/** A Builder role without the owner's blanket access. */
function staff(permissions: Record<string, string[]>): MinkActorContext {
  return actor({
    roleSlug: "member",
    isSuperadmin: false,
    permissions: permissions as never,
  });
}

beforeEach(() => {
  blocks.paths = [];
  registry.definition = BASKET;
  dbHolder.current = fullDb();
  ownershipMock.digests.mockResolvedValue(
    new Set([sectionContentDigest(drafted([minkHero])[0])]),
  );
  ownershipMock.broken.mockImplementation(async (urls: string[]) => {
    return new Set(urls.filter((url) => url.endsWith("broken.webp")));
  });
});

// ---------------------------------------------------------------------------
// readRevampSnapshot
// ---------------------------------------------------------------------------

describe("readRevampSnapshot", () => {
  it("★★ reads every page's Builder draft, the homepage first, with its version and digest", async () => {
    const snapshot = await readRevampSnapshot(context(), request);
    expect(snapshot.storeId).toBe(STORE);
    expect(snapshot.storeName).toBe("Lumen Oils");
    expect(snapshot.storeSlug).toBe("lumen");
    expect(snapshot.launched).toBe(false);

    expect(snapshot.pages.map((page) => page.slug)).toEqual([
      "",
      "our-story",
      "terms",
      "broken",
    ]);
    const [home, story] = snapshot.pages;
    expect(home.id).toBe("page-home");
    // ★ The raw column text, full precision, never a reparsed date.
    expect(home.version).toBe("2026-10-03 10:11:12.123456+00");
    expect(home.title).toBe("Home");
    expect(home.status).toBe("published");
    expect(home.sections).toEqual(drafted(homeRaw));
    expect(home.sectionsDigest).toBe(revampSectionsDigest(drafted(homeRaw)));
    expect(home.skipped).toBeNull();
    expect(home.seoTitle).toBe("Lumen Oils");
    // A blank SEO field reads as absent.
    expect(home.seoDescription).toBeNull();
    expect(story.seoTitle).toBeNull();
    expect(story.seoDescription).toBe("How we press our oil");
  });

  it("★★ classifies every section: the theme's, an earlier Mink write, and the merchant's own", async () => {
    const snapshot = await readRevampSnapshot(context(), request);
    const [home, story] = snapshot.pages;
    for (const themeSection of homeTheme) {
      expect(home.owners[themeSection.id]).toBe("theme");
    }
    expect(home.owners["hero-mink"]).toBe("mink");
    expect(home.owners["own-text"]).toBe("merchant");
    expect(home.owners["own-media"]).toBe("merchant");
    // ★ Custom code is always the merchant's.
    expect(home.owners["own-code"]).toBe("merchant");
    expect(Object.keys(home.owners)).toHaveLength(homeRaw.length);
    for (const themeSection of storyTheme) {
      expect(story.owners[themeSection.id]).toBe("theme");
    }
    expect(story.owners["story-media"]).toBe("merchant");
    expect(ownershipMock.digests).toHaveBeenCalledTimes(1);
    expect(ownershipMock.digests.mock.calls[0][1]).toBe(STORE);
  });

  it("★ a policy page and a page whose draft does not validate are never written", async () => {
    const snapshot = await readRevampSnapshot(context(), request);
    const terms = snapshot.pages.find((page) => page.slug === "terms")!;
    const broken = snapshot.pages.find((page) => page.slug === "broken")!;
    expect(terms.skipped).toBe("policy");
    expect(broken.skipped).toBe("invalid");
    // ★ Its sections are left out rather than half-read.
    expect(broken.sections).toEqual([]);
    expect(broken.sectionsDigest).toBe(revampSectionsDigest([]));
    expect(broken.owners).toEqual({});
  });

  it("reads the chrome draft sanitised, with the whole-draft digest the apply path locks", async () => {
    const snapshot = await readRevampSnapshot(context(), request);
    const value = sanitizeChromeForSave(chromeDraft);
    expect(snapshot.chrome.rowExists).toBe(true);
    expect(snapshot.chrome.version).toBe("2026-10-04 01:02:03.456789+00");
    expect(snapshot.chrome.value).toEqual(value);
    expect(snapshot.chrome.digest).toBe(revampChromeDigest(value));
  });

  it("★★ a store with no chrome row starts from the menus its storefront really shows", async () => {
    dbHolder.current = fullDb({ chrome: false });
    const snapshot = await readRevampSnapshot(context(), request);
    expect(snapshot.chrome.rowExists).toBe(false);
    expect(snapshot.chrome.version).toBeNull();
    expect(snapshot.chrome.value.header.links[0]?.label).toBe("Shop all");
    expect(snapshot.chrome.value.footer.groups[0]?.title).toBe("Help");
    expect(snapshot.chrome.digest).toBe(
      revampChromeDigest(snapshot.chrome.value),
    );
    const menusQuery = dbHolder.current.calls.execute.find((query: any) =>
      sqlText(query).includes("store_menus"),
    );
    expect(menusQuery).toBeDefined();
  });

  it("reads the brand text and its digest exactly as v1 does", async () => {
    const snapshot = await readRevampSnapshot(context(), request);
    expect(snapshot.brand).toEqual({
      tagline: "Pressed in Jaipur",
      blurb: "Small batch mustard oil",
      digest: revampBrandDigest(settings()),
    });
  });

  it("reads categories and products, samples marked, the card's own first photo", async () => {
    const snapshot = await readRevampSnapshot(context(), request);
    expect(snapshot.categories.map((c) => [c.slug, c.sample])).toEqual([
      ["staples", true],
      ["oils", false],
    ]);
    expect(snapshot.categories[1]).toMatchObject({
      id: "cat-oils",
      name: "Oils",
      description: "Our oils",
      imageUrl: OILS,
      status: "active",
      updatedAt: "2026-10-01 10:00:00+00",
      productCount: 1,
    });
    expect(snapshot.products).toEqual([
      {
        id: "prod-sample",
        name: "Basmati Rice (Sample)",
        slug: "basmati-rice-sample",
        status: "published",
        updatedAt: "2026-09-01 10:00:00+00",
        sample: true,
        imageUrl: "/themes/basket/rice.webp",
        categoryId: "cat-staples",
        featured: true,
      },
      {
        id: "prod-oil",
        name: "Mustard oil",
        slug: "mustard-oil",
        status: "published",
        updatedAt: "2026-10-05 10:00:00.5+00",
        sample: false,
        // The empty primary falls through to the first real gallery photo.
        imageUrl: `${BUCKET}/stores/${STORE}/products/oil.webp`,
        categoryId: "cat-oils",
        featured: false,
      },
    ]);
  });

  it('★★ reads products.featured, which a featured_products band set to "featured" shows (output-5)', async () => {
    await readRevampSnapshot(context(), request);
    const projections = dbHolder.current.calls.select as Array<
      Record<string, unknown> | undefined
    >;
    const productRead = projections.find(
      (projection) =>
        !!projection && "categoryId" in projection && "images" in projection,
    );
    expect(productRead).toBeDefined();
    expect(Object.keys(productRead!)).toContain("featured");
  });

  describe("★★ a product the store already has, past the cap (f-10)", () => {
    const groundnut = {
      key: "p1",
      name: "  Groundnut   OIL ",
      description: "",
      sizes: [{ label: "", price: 199, mrp: null }],
      photoUrl: null,
      categorySlug: null,
    };
    const named: RevampRequest = { ...request, products: [groundnut] };
    /** An older product of the same name, which the capped read left out. */
    const older = {
      id: "prod-groundnut",
      name: "Groundnut Oil",
      slug: "groundnut-oil",
      status: "published",
      updatedAt: "2024-01-01 10:00:00+00",
      imageUrl: "",
      images: [""],
      categoryId: null,
    };

    it("★★ looks the request's product names up store-wide, so the compiler never creates one again", async () => {
      // The capped read's own row comes back from the lookup too: kept once.
      dbHolder.current = fullDb({ named: [older, productRows()[1]] });
      const snapshot = await readRevampSnapshot(context(), named);
      expect(snapshot.products.map((product) => product.id)).toEqual([
        "prod-sample",
        "prod-oil",
        "prod-groundnut",
      ]);
      expect(
        revampExistingProducts({ request: named, snapshot }).get("p1")?.id,
      ).toBe("prod-groundnut");
      // One bounded, store-scoped query by the compiler's name rule, with the
      // theme's samples left out.
      const lookup = dbHolder.current.calls.where.find((where: any) =>
        sqlText(where).includes("normalize("),
      );
      expect(lookup).toBeDefined();
      const values = sqlParamValues(lookup);
      expect(values).toContain(STORE);
      expect(values).toContain("%(Sample)%");
      // ★ The names go as ONE array parameter (sql.param), never as a list.
      expect(arrayParams(lookup)).toEqual([["groundnut oil"]]);
      expect(dbHolder.current.calls.limit).toContain(100);
    });

    it("never adds a sample, and looks nothing up without products to find or the right to see them", async () => {
      dbHolder.current = fullDb({
        named: [{ ...older, id: "prod-rice", name: "Groundnut Oil (sample)" }],
      });
      const snapshot = await readRevampSnapshot(context(), named);
      expect(snapshot.products.map((product) => product.id)).toEqual([
        "prod-sample",
        "prod-oil",
      ]);

      for (const [who, req] of [
        [actor(), request],
        [staff({ builder: ["manage"] }), named],
      ] as const) {
        dbHolder.current = fullDb({ named: [older] });
        await readRevampSnapshot(context({ actor: who }), req);
        expect(
          dbHolder.current.calls.where.some((where: any) =>
            sqlText(where).includes("normalize("),
          ),
        ).toBe(false);
      }
    });
  });

  it("reads the store's facts, its city and its state", async () => {
    const snapshot = await readRevampSnapshot(context(), request);
    expect(snapshot.facts).toMatchObject({
      delivery: "Delivery in 2 to 5 days",
      freeDeliveryAbove: 999,
      onlinePayments: true,
      cashOnDelivery: true,
      city: "Jaipur",
      state: "Rajasthan",
    });
  });

  it("★ falls back to the GST state code when the address has no state, and never names a bare code", async () => {
    dbHolder.current = fullDb({
      store: { business: { city: "Jaipur" } },
      billing: [{ stateCode: "08" }],
    });
    expect((await readRevampSnapshot(context(), request)).facts.state).toBe(
      "Rajasthan",
    );

    dbHolder.current = fullDb({
      store: { business: {} },
      billing: [{ stateCode: "99" }],
    });
    const unknown = await readRevampSnapshot(context(), request);
    expect(unknown.facts.state).toBeNull();
    expect(unknown.facts.city).toBeNull();

    dbHolder.current = fullDb({ store: { business: {} }, billing: [] });
    expect(
      (await readRevampSnapshot(context(), request)).facts.state,
    ).toBeNull();
  });

  it("reads the custom-code entitlement for the store's plan", async () => {
    expect(
      (await readRevampSnapshot(context(), request)).entitlements.customCode,
    ).toBe(true);
    dbHolder.current = fullDb();
    const free = await readRevampSnapshot(
      context({ actor: actor({ effectivePlan: "free" }) }),
      request,
    );
    expect(free.entitlements.customCode).toBe(false);
  });

  it("★ the theme's own colours as #rrggbb and its own layout choices", async () => {
    const snapshot = await readRevampSnapshot(context(), request);
    expect(snapshot.theme).toEqual({
      id: "basket",
      version: "1.0.0",
      name: "Basket",
      palette: {
        page: "#ffffff",
        surface: "#ffffff",
        ink: "#1e2b28",
        // ★ Basket has no fixed accent: the store's brand colour drives it.
        accent: "#2542c7",
      },
      layout: {
        header: "market",
        card: "quick_add",
        productDetail: "grocery",
        cart: "grocery",
        footer: "rich",
      },
      // Basket ships no announcement line.
      announcement: null,
    });

    dbHolder.current = fullDb({ store: { brand: {} } });
    const seeded = await readRevampSnapshot(context(), request);
    // Without a brand colour of the store's own, the theme's seeded colour.
    expect(seeded.theme.palette.accent).toBe("#ef5a2a");
  });

  it("★★ carries the theme's own announcement line, which an empty bar shows (output-2)", async () => {
    registry.definition = {
      ...BASKET,
      preset: {
        ...BASKET.preset,
        announcement: {
          text: "  Free delivery on orders over 1,499  ",
          href: "/delivery",
        },
      },
    };
    const snapshot = await readRevampSnapshot(context(), request);
    expect(snapshot.theme.announcement).toEqual({
      text: "Free delivery on orders over 1,499",
      href: "/delivery",
    });
  });

  it("★★ checks only the photos that would otherwise be kept, and lists what may be replaced", async () => {
    const snapshot = await readRevampSnapshot(context(), request);
    expect(ownershipMock.broken).toHaveBeenCalledTimes(1);
    const [checked, options] = ownershipMock.broken.mock.calls[0];
    // The merchant's own photos, homepage first, then menu and categories.
    expect(checked).toEqual([MILL, BROKEN, MENU, OILS]);
    expect(options.signal).toBeInstanceOf(AbortSignal);

    expect(snapshot.photos.broken).toEqual([BROKEN]);
    const replaceable = new Set(snapshot.photos.replaceable);
    expect(replaceable.has(MINK_PHOTO)).toBe(true);
    expect(replaceable.has(BROKEN)).toBe(true);
    expect(replaceable.has("/themes/basket/staples.webp")).toBe(true);
    const themePhotos = collectRevampImageUrls(homeTheme);
    expect(themePhotos.length).toBeGreaterThan(0);
    for (const url of themePhotos) expect(replaceable.has(url)).toBe(true);
    // ★ A working merchant photo is never replaceable.
    expect(replaceable.has(MILL)).toBe(false);
    expect(replaceable.has(OILS)).toBe(false);
    expect(replaceable.has(MENU)).toBe(false);
    // De-duplicated.
    expect(snapshot.photos.replaceable).toHaveLength(replaceable.size);
  });

  it("★★ lists the product photos a shot of the merchant's goods can be drawn from, by the bucket's own rule (B16)", async () => {
    const outside = "https://cdn.shopify.com/s/files/1/0001/oil.jpg";
    const otherStore = `${BUCKET}/stores/22222222-2222-4222-8222-222222222222/uploads/x.webp`;
    const legacy = `${BUCKET}/blog-covers/old.webp`;
    const attached = `${BUCKET}/stores/${STORE}/media/chat-oil.jpg`;
    const withPhotos: RevampRequest = {
      ...request,
      products: [outside, otherStore, legacy, attached, null].map(
        (photoUrl, index) => ({
          key: `p${index + 1}`,
          name: `Oil ${index + 1}`,
          description: "",
          sizes: [{ label: "", price: 100, mrp: null }],
          photoUrl,
          categorySlug: null,
        }),
      ),
    };
    const snapshot = await readRevampSnapshot(context(), withPhotos);
    // ★ Only objects under this store's own prefix in our bucket, which is
    //   all the photos step can read: the merchant's attachment and the
    //   store's own product photo, never the theme sample's file.
    expect(snapshot.photos.readable).toEqual([
      attached,
      `${BUCKET}/stores/${STORE}/products/oil.webp`,
    ]);
  });

  it("★ the pages the merchant named are checked first", async () => {
    await readRevampSnapshot(context(), { ...request, pages: ["our-story"] });
    expect(ownershipMock.broken.mock.calls[0][0]).toEqual([
      BROKEN,
      MILL,
      MENU,
      OILS,
    ]);
  });

  it("★★ a store still choosing its theme refuses with theme_missing before reading its pages", async () => {
    dbHolder.current = fullDb({ store: { themePending: true } });
    const error = await readRevampSnapshot(context(), request).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RevampStepError);
    expect((error as RevampStepError).code).toBe("theme_missing");
    expect((error as RevampStepError).transient).toBe(false);
    expect(dbHolder.current.calls.select).toHaveLength(1);
    expect(ownershipMock.broken).not.toHaveBeenCalled();
  });

  it("★ a theme that cannot be read refuses with theme_missing too", async () => {
    registry.definition = null;
    await expect(readRevampSnapshot(context(), request)).rejects.toMatchObject({
      name: "RevampStepError",
      code: "theme_missing",
    });
  });

  it("★ a requester who can no longer change the Builder is refused before anything is read", async () => {
    for (const who of [
      staff({ builder: ["view"], products: ["manage"] }),
      actor({ draftingEnabled: false }),
    ]) {
      vi.mocked(withService).mockClear();
      await expect(
        readRevampSnapshot(context({ actor: who }), request),
      ).rejects.toMatchObject({ code: "not_allowed", transient: false });
      expect(withService).not.toHaveBeenCalled();
    }
  });

  it("a store that cannot be read fails as an internal problem", async () => {
    dbHolder.current = fullDb({ store: null });
    await expect(readRevampSnapshot(context(), request)).rejects.toMatchObject({
      code: "internal",
    });
  });

  it("★★ an abort before the read rejects with its reason and reads nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    controller.abort(reason);
    vi.mocked(withService).mockClear();
    await expect(
      readRevampSnapshot(context({ signal: controller.signal }), request),
    ).rejects.toBe(reason);
    expect(withService).not.toHaveBeenCalled();
  });

  it("★★ an abort during the photo checks propagates, never swallowed", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    ownershipMock.broken.mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      readRevampSnapshot(context({ signal: controller.signal }), request),
    ).rejects.toBe(reason);
  });

  it("★★ a role without Products or Categories view reads neither", async () => {
    const snapshot = await readRevampSnapshot(
      context({ actor: staff({ builder: ["manage"] }) }),
      request,
    );
    expect(snapshot.categories).toEqual([]);
    expect(snapshot.products).toEqual([]);
    // stores, store_pages, store_chrome, store_shipping_settings: nothing else.
    expect(dbHolder.current.calls.select).toHaveLength(4);
  });

  it("★★ the theme's samples need Products manage: a viewer's snapshot leaves them out", async () => {
    const snapshot = await readRevampSnapshot(
      context({
        actor: staff({
          builder: ["manage"],
          products: ["view"],
          categories: ["view"],
        }),
      }),
      request,
    );
    expect(snapshot.products.map((p) => p.id)).toEqual(["prod-oil"]);
    expect(snapshot.categories).toHaveLength(2);
    const productFilter = dbHolder.current.calls.where.find((where: any) =>
      sqlText(where).includes("not like"),
    );
    expect(productFilter).toBeDefined();
    expect(sqlParamValues(productFilter)).toContain("%(Sample)%");
  });

  describe("★★ a theme whose samples carry no '(Sample)' mark (vitrine, studio, ritual)", () => {
    const VITRINE = THEME_DEFINITIONS.find((theme) => theme.id === "vitrine")!;
    const [seedA, seedB] = VITRINE.preset.sampleData!.products;

    function vitrineDb() {
      return makeDbMock({
        selectByTable: {
          stores: [
            [
              storeRow({
                theme: {
                  presetId: "vitrine",
                  presetVersion: VITRINE.release.version,
                },
              }),
            ],
          ],
          store_pages: [pageRows()],
          store_chrome: [[]],
          categories: [[]],
          products: [
            [
              {
                id: "prod-seed",
                name: seedA.name,
                slug: seedA.slug,
                status: "published",
                updatedAt: "2026-09-01 10:00:00+00",
                imageUrl: seedA.image_url,
                images: [""],
                categoryId: null,
              },
              {
                // The seed's address, but the merchant renamed it: theirs.
                id: "prod-renamed",
                name: "Our own loafer",
                slug: seedB.slug,
                status: "published",
                updatedAt: "2026-10-01 10:00:00+00",
                imageUrl: seedB.image_url,
                images: [""],
                categoryId: null,
              },
              {
                id: "prod-own",
                name: "Kolhapuri chappal",
                slug: "kolhapuri-chappal",
                status: "published",
                updatedAt: "2026-10-02 10:00:00+00",
                imageUrl: "",
                images: [""],
                categoryId: null,
              },
            ],
          ],
          store_shipping_settings: [[shippingRow]],
          store_billing_settings: [[]],
        },
        executeQueue: [
          [
            {
              header: [{ label: "Shop all", href: "/shop" }],
              footer_groups: [],
              footer_legal: [],
            },
          ],
          [{ online: true }],
        ],
      });
    }

    /** Every `.orderBy(...)` argument list, which the shared mock drops. */
    let orderBys: any[][] = [];

    beforeEach(() => {
      registry.definition = VITRINE;
      const mock = vitrineDb();
      orderBys = [];
      const select = mock.db.select;
      mock.db.select = vi.fn((projection?: any) => {
        const step = select(projection);
        const orderBy = step.orderBy;
        step.orderBy = vi.fn((...args: any[]) => {
          orderBys.push(args);
          return orderBy(...args);
        });
        return step;
      });
      dbHolder.current = mock;
    });

    it("★★ a product still named and addressed as the theme seeded it is a sample", async () => {
      const snapshot = await readRevampSnapshot(context(), request);
      expect(
        snapshot.products.map((product) => [product.id, product.sample]),
      ).toEqual([
        ["prod-seed", true],
        ["prod-renamed", false],
        ["prod-own", false],
      ]);
      // ★ Samples are read first, so a large catalogue cannot push them past
      //   the cap: the products ordering names the theme's own seeds.
      const values = orderBys
        .flat()
        .flatMap((part: any) => sqlParamValues(part));
      expect(values).toContain("%(Sample)%");
      expect(values).toContain(seedA.slug);
      expect(values).toContain(seedA.name);
    });

    it("★★ a viewer's snapshot leaves the unmarked seed out too, in the query and after it", async () => {
      const snapshot = await readRevampSnapshot(
        context({
          actor: staff({
            builder: ["manage"],
            products: ["view"],
            categories: ["view"],
          }),
        }),
        request,
      );
      expect(snapshot.products.map((p) => p.id)).toEqual([
        "prod-renamed",
        "prod-own",
      ]);
      const productFilter = dbHolder.current.calls.where.find((where: any) =>
        sqlText(where).includes("not like"),
      );
      expect(productFilter).toBeDefined();
      const values = sqlParamValues(productFilter);
      expect(values).toContain("%(Sample)%");
      expect(values).toContain(seedA.slug);
      expect(values).toContain(seedA.name);
    });

    it("★ the interview summary counts the unmarked samples as the theme's", async () => {
      const summary = await readRevampContextForActor(actor());
      expect(summary.products?.samples.live).toBe(1);
      expect(summary.products?.yours.live).toBe(2);
    });
  });

  it("★★ every query carries the store id", async () => {
    dbHolder.current = fullDb({ chrome: false, store: { business: {} } });
    await readRevampSnapshot(context(), request);
    const { where, execute } = dbHolder.current.calls;
    expect(where.length).toBeGreaterThanOrEqual(7);
    for (const condition of where) {
      expect(sqlParamValues(condition)).toContain(STORE);
    }
    expect(execute.length).toBe(2);
    for (const query of execute) {
      expect(sqlParamValues(query)).toContain(STORE);
    }
  });
});

// ---------------------------------------------------------------------------
// readRevampContextForActor
// ---------------------------------------------------------------------------

describe("readRevampContextForActor", () => {
  it("★ needs Website Builder access, and reads nothing without it", async () => {
    vi.mocked(withService).mockClear();
    await expect(
      readRevampContextForActor(staff({ products: ["manage"] })),
    ).rejects.toBeInstanceOf(MinkToolInputError);
    expect(withService).not.toHaveBeenCalled();
  });

  it("★★ a store still choosing its theme answers with a blocker, not an error", async () => {
    dbHolder.current = fullDb({ store: { themePending: true } });
    const summary = await readRevampContextForActor(actor());
    expect(summary.blocker).toBe(REVAMP_ERROR_MESSAGES.theme_missing);
    expect(summary.store).toEqual({
      name: "Lumen Oils",
      live: false,
      theme: null,
    });
    expect(summary.pages).toEqual([]);
    expect(summary.categories).toBeNull();
    expect(summary.products).toBeNull();
    expect(dbHolder.current.calls.select).toHaveLength(1);
  });

  it("★★ tells the model what each page keeps and rebuilds, with home as the homepage", async () => {
    const summary = await readRevampContextForActor(actor());
    expect(summary.blocker).toBeNull();
    expect(summary.store).toEqual({
      name: "Lumen Oils",
      live: false,
      theme: "Basket",
    });
    expect(summary.pages.map((page) => page.slug)).toEqual([
      "home",
      "our-story",
    ]);
    const homePhotos = new Set(
      collectRevampImageUrls(drafted(homeRaw)).filter((url) =>
        isReplaceablePhotoUrl(url, { storeId: STORE, broken: new Set() }),
      ),
    );
    expect(summary.pages[0]).toEqual({
      slug: "home",
      title: "Home",
      live: true,
      keptSections: 3,
      rebuiltSections: homeTheme.length + 1,
      photosToReplace: homePhotos.size,
    });
    expect(summary.pages[0].photosToReplace).toBeGreaterThan(1);
    expect(summary.pages[1]).toMatchObject({
      slug: "our-story",
      keptSections: 1,
      rebuiltSections: storyTheme.length,
    });
    expect(summary.morePages).toBe(0);
    expect(summary.neverChanged.map((page) => page.slug)).toEqual([
      "terms",
      "broken",
    ]);
    expect(summary.neverChanged[0].reason).toMatch(/policy/i);
    // ★ No network: photos are counted, never checked.
    expect(ownershipMock.broken).not.toHaveBeenCalled();
  });

  it("reports the brand, header, footer, look, categories, products and facts", async () => {
    const summary = await readRevampContextForActor(actor());
    expect(summary.brand).toEqual({
      tagline: "Pressed in Jaipur",
      taglineFromTheme: false,
      blurb: "Small batch mustard oil",
      blurbFromTheme: false,
    });
    expect(summary.header?.links).toEqual(["Shop"]);
    expect(summary.look).toEqual({
      theme: "Basket",
      colours: {
        page: "#ffffff",
        surface: "#ffffff",
        ink: "#1e2b28",
        accent: "#2542c7",
      },
      header: "market",
      card: "quick_add",
      footer: "rich",
      ownDesign: false,
    });
    expect(summary.categories).toEqual([
      {
        slug: "staples",
        name: "Staples",
        visible: true,
        fromTheme: true,
        products: 3,
        hasPhoto: true,
      },
      {
        slug: "oils",
        name: "Oils",
        visible: true,
        fromTheme: false,
        products: 1,
        hasPhoto: true,
      },
    ]);
    expect(summary.products).toEqual({
      yours: { live: 1, drafts: 0, names: ["Mustard oil"] },
      samples: { live: 1, drafts: 0, takenOff: true },
    });
    expect(summary.storeFacts).toMatchObject({
      delivery: "Delivery in 2 to 5 days",
      city: "Jaipur",
      state: "Rajasthan",
    });
    expect(summary.limits).toEqual({
      products: 20,
      sizesPerProduct: 8,
      pages: 10,
      categoryChanges: 12,
    });
  });

  it("★ says when the tagline and footer text are still the theme's own words", async () => {
    dbHolder.current = fullDb({
      store: {
        brand: {
          tagline: BASKET.preset.brand.tagline,
          blurb: `  ${BASKET.preset.brand.blurb}  `,
        },
      },
    });
    const summary = await readRevampContextForActor(actor());
    expect(summary.brand?.taglineFromTheme).toBe(true);
    expect(summary.brand?.blurbFromTheme).toBe(true);
  });

  it("★★ categories and products only for a role that may see them", async () => {
    const summary = await readRevampContextForActor(
      staff({ builder: ["manage"] }),
    );
    expect(summary.categories).toBeNull();
    expect(summary.products).toBeNull();
    expect(summary.blocker).toBeNull();
    expect(dbHolder.current.calls.select).toHaveLength(4);

    dbHolder.current = fullDb();
    const viewer = await readRevampContextForActor(
      staff({ builder: ["manage"], products: ["view"] }),
    );
    // A viewer sees the samples but cannot take them off the shop.
    expect(viewer.products?.samples).toEqual({
      live: 1,
      drafts: 0,
      takenOff: false,
    });
  });

  it("★ a role that can only look at the Builder gets the context and a blocker", async () => {
    const summary = await readRevampContextForActor(
      staff({ builder: ["view"] }),
    );
    expect(summary.blocker).toMatch(/cannot change the Website Builder/);
    expect(summary.pages.length).toBeGreaterThan(0);

    dbHolder.current = fullDb();
    const noDrafting = await readRevampContextForActor(
      actor({ draftingEnabled: false }),
    );
    expect(noDrafting.blocker).toMatch(/drafting/);
  });

  it("★★ never names a credit figure", async () => {
    const summary = await readRevampContextForActor(actor());
    expect(JSON.stringify(summary)).not.toMatch(CREDIT_WORDS);
  });

  it("★★ stays under 6,000 characters for a very large store", async () => {
    const long = (n: number, label: string) =>
      `${label}-${"x".repeat(80)}`.slice(0, 60) + `-${n}`;
    const pages = [
      {
        id: "page-home",
        slug: "",
        title:
          "A homepage with a title far longer than any page should ever need",
        status: "published",
        sections: homeRaw,
        seoTitle: "",
        seoDescription: "",
        updatedAt: "2026-10-03 10:11:12.123456+00",
      },
      ...Array.from({ length: 99 }, (_, i) => ({
        id: `page-${i}`,
        slug: `${"a-very-long-page-address-for-testing-limits".slice(0, 55)}-${i}`,
        title: long(i, "A very long page title written by the merchant"),
        status: "published",
        sections: [
          section(`text-${i}`, "rich_text", { html: "<p>Our page.</p>" }),
        ],
        seoTitle: "",
        seoDescription: "",
        updatedAt: "2026-10-03 10:11:12+00",
      })),
    ];
    const categories = Array.from({ length: 60 }, (_, i) => ({
      id: `cat-${i}`,
      name: long(i, "A category name the merchant made very long indeed"),
      slug: `${"a-long-category-address".repeat(3).slice(0, 50)}-${i}`,
      description: "x".repeat(400),
      imageUrl: OILS,
      status: "active",
      createdAt: "2026-09-01 10:00:00+00",
      updatedAt: "2026-10-01 10:00:00+00",
      productCount: 12,
    }));
    const products = Array.from({ length: 1000 }, (_, i) => ({
      id: `prod-${i}`,
      name: long(i, "A product name that goes on and on and on"),
      slug: `product-${i}`,
      status: i % 3 ? "published" : "draft",
      updatedAt: "2026-10-05 10:00:00+00",
      imageUrl: OILS,
      images: [""],
      categoryId: null,
    }));
    const chromeRow = {
      draft: {
        header: {
          links: Array.from({ length: 12 }, (_, i) => ({
            label: long(i, "A menu link label"),
            href: "/shop",
          })),
          announcement: {
            enabled: true,
            text: "Free delivery ".repeat(20),
            href: "",
          },
        },
      },
      updatedAt: "2026-10-04 01:02:03+00",
    };
    dbHolder.current = makeDbMock({
      selectByTable: {
        stores: [
          [
            storeRow({
              brand: {
                tagline: "A tagline ".repeat(40),
                blurb: "A long footer description ".repeat(40),
              },
            }),
          ],
        ],
        store_pages: [pages],
        store_chrome: [[chromeRow]],
        categories: [categories],
        products: [products],
        store_shipping_settings: [[shippingRow]],
        store_billing_settings: [[]],
      },
      executeQueue: [[{ online: true }]],
    });
    const summary = await readRevampContextForActor(actor());
    const json = JSON.stringify(summary);
    expect(json.length).toBeLessThan(REVAMP_CONTEXT_MAX_CHARS);
    expect(json).not.toMatch(CREDIT_WORDS);
    expect(summary.pages[0].slug).toBe("home");
    expect(summary.pages.length).toBeGreaterThan(0);
    expect(summary.pages.length + summary.morePages).toBe(100);
    expect(summary.categories?.length ?? 0).toBeLessThanOrEqual(15);
    expect((summary.categories?.length ?? 0) + summary.moreCategories).toBe(60);
    expect(summary.products?.yours.live).toBe(666);
    expect(summary.products?.yours.drafts).toBe(334);
  });
});

// ---------------------------------------------------------------------------
// The takedown: nothing StoreMink blocked reaches a redesign
// ---------------------------------------------------------------------------

describe("takedown: what StoreMink blocked stays out of a redesign", () => {
  const compile = (where: unknown) =>
    new PgDialect().sqlToQuery(where as never).sql;
  const BLOCKED_PRODUCT = '"products"."moderation_blocked_at" is null';

  it("★★ a product StoreMink blocked is never read, in either product query", async () => {
    dbHolder.current = fullDb({ named: [] });
    await readRevampSnapshot(context(), {
      ...request,
      products: [
        {
          key: "p1",
          name: "Mustard oil",
          description: "",
          sizes: [{ label: "", price: 100, mrp: null }],
          photoUrl: null,
          categorySlug: null,
        },
      ],
    });
    const wheres = (dbHolder.current.calls.where as unknown[]).map(compile);
    // The main read and the lookup of the request's own product names.
    const productReads = wheres.filter((text) =>
      text.includes(BLOCKED_PRODUCT),
    );
    expect(productReads).toHaveLength(2);
    expect(productReads[1]).toContain("regexp_replace");
    // ★ A blocked collection is not read either (the shared reader).
    expect(
      wheres.some((text) =>
        text.includes('"categories"."moderation_blocked_at" is null'),
      ),
    ).toBe(true);
  });

  it("★★ a page StoreMink blocked stays in the list unread and never written, and out of the summary", async () => {
    const pages = pageRows().map((row) =>
      row.id === "page-story"
        ? { ...row, blockedAt: "2026-10-20 09:00:00+00" }
        : { ...row, blockedAt: null },
    );
    dbHolder.current = fullDb({ pages });
    const snapshot = await readRevampSnapshot(context(), request);
    const story = snapshot.pages.find((page) => page.slug === "our-story")!;
    expect(story).toMatchObject({
      id: "page-story",
      version: "2026-10-02 09:00:00.654321+00",
      sections: [],
      owners: {},
      skipped: "policy",
      sectionsDigest: revampSectionsDigest([]),
      seoTitle: null,
      seoDescription: null,
    });
    // Its picture is never checked or counted: the page is not read.
    expect(ownershipMock.broken.mock.calls[0][0]).not.toContain(BROKEN);
    expect(snapshot.photos.broken).toEqual([]);
    // The page read asks for the block, and the other pages are untouched.
    const projections = dbHolder.current.calls.select as Array<
      Record<string, unknown> | undefined
    >;
    expect(projections.some((p) => p && "blockedAt" in p)).toBe(true);
    expect(snapshot.pages.find((page) => page.slug === "")!.skipped).toBe(null);

    dbHolder.current = fullDb({ pages });
    const summary = await readRevampContextForActor(actor());
    expect(summary.pages.map((page) => page.slug)).toEqual(["home"]);
    // ★ Left out altogether: never named, not even as never changed.
    expect(summary.neverChanged.map((page) => page.slug)).toEqual([
      "terms",
      "broken",
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/our story|our-story/i);
  });

  it("★★ a picture StoreMink blocked is a broken one: never checked, replaced, never a product photo", async () => {
    blocks.paths = [
      `stores/${STORE}/uploads/mill.webp`,
      `stores/${STORE}/products/oil.webp`,
    ];
    const snapshot = await readRevampSnapshot(context(), request);
    // ★ Read once the transaction has committed, never inside it.
    expect(vi.mocked(blockedMedia)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(blockedMedia).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(withService).mock.invocationCallOrder[0],
    );
    // Not fetched to check it: it is broken for shoppers already.
    expect(ownershipMock.broken.mock.calls[0][0]).toEqual([BROKEN, MENU, OILS]);
    expect(snapshot.photos.broken).toEqual([MILL, BROKEN]);
    expect(snapshot.photos.replaceable).toContain(MILL);
    // ★ The product keeps its row but not the photo, which is never read.
    const oil = snapshot.products.find((product) => product.id === "prod-oil");
    expect(oil?.imageUrl).toBeNull();
    expect(snapshot.photos.readable).not.toContain(
      `${BUCKET}/stores/${STORE}/products/oil.webp`,
    );
  });

  it("★ a blocked picture the merchant attached is never a product photo the shoot reads", async () => {
    const attached = `${BUCKET}/stores/${STORE}/media/chat-oil.jpg`;
    blocks.paths = [`stores/${STORE}/media/chat-oil.jpg`];
    const snapshot = await readRevampSnapshot(context(), {
      ...request,
      products: [
        {
          key: "p1",
          name: "Oil 1",
          description: "",
          sizes: [{ label: "", price: 100, mrp: null }],
          photoUrl: attached,
          categorySlug: null,
        },
      ],
    });
    expect(snapshot.photos.readable).toEqual([
      `${BUCKET}/stores/${STORE}/products/oil.webp`,
    ]);
  });
});
