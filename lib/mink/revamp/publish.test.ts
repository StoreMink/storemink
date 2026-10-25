import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSectionItem } from "@/lib/sections/registry";

const holder = vi.hoisted(() => ({
  read: vi.fn(),
  after: vi.fn((task: () => unknown) => void task()),
  emit: vi.fn(),
  notify: vi.fn(async () => undefined),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: holder.revalidatePath,
  revalidateTag: holder.revalidateTag,
}));
vi.mock("next/server", () => ({ after: holder.after }));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: holder.emit }));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: holder.notify,
}));
vi.mock("@/lib/site", () => ({
  getStoreOriginById: vi.fn(async () => "https://lumen.storemink.com"),
}));
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveInstalledThemeDefinitionWithDb: vi.fn(async () => null),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("./jobs", () => ({ readRevampForActor: holder.read }));

import { DEFAULT_CHROME, sanitizeChromeForSave } from "@/lib/chrome/types";
import type { StoreChrome } from "@/lib/chrome/types";
import { TAGS } from "@/lib/storefront/tags";
import type { MinkActorContext } from "../types";
import { revampChromeDigest, revampSectionsDigest } from "./digests";
import type { RevampApplySnapshot } from "./lifecycle-types";
import {
  publishRevamp,
  readApplySnapshot,
  undoRevamp,
  type LifecycleTx,
  type LockedRevamp,
  type RevampLifecycleDeps,
  type RevampPublishRecord,
} from "./publish";

const ACTOR = {
  storeId: "store-1",
  adminId: "owner-1",
  isSuperadmin: true,
  permissions: {},
} as unknown as MinkActorContext;
const REVAMP = "22222222-2222-4222-8222-222222222222";
const T0 = "2026-10-21T06:00:00.000Z";

function section(id: string, text: string): PageSectionItem {
  return {
    id,
    type: "rich_text",
    enabled: true,
    config: { html: `<p>${text}</p>`, width: "contained" },
  } as PageSectionItem;
}

function chromeWith(text: string): StoreChrome {
  const chrome = structuredClone(DEFAULT_CHROME);
  chrome.header.announcement = { enabled: true, text, href: "" };
  return chrome;
}

interface FakePage {
  id: string;
  slug: string;
  title: string;
  seoTitle: string;
  seoDescription: string;
  sections: unknown;
  publishedSections: unknown;
  status: string;
  publishedAt: string | null;
  updatedAt: string;
}
interface FakeProduct {
  name: string;
  status: string;
  /** The row's `updated_at`: every write moves it. */
  clock: string;
  ordered: boolean;
  categoryId: string | null;
  publishedAt?: string | null;
  usedBy?: "offer" | "review";
}
interface FakeCategory {
  name: string;
  description: string | null;
  imageUrl: string | null;
  status: string;
  updatedAt: string;
}

/** The store after Apply, as apply-v2 leaves it, plus the in-memory tx. */
function fixture() {
  let clock = 0;
  const tick = () =>
    `2026-10-21T07:00:${String(++clock).padStart(2, "0")}.000Z`;
  const beforeHome = [section("old", "Fresh groceries")];
  const afterHome = [section("hero", "Candles for slow evenings")];
  const afterAbout = [section("story", "Poured by hand in Pune")];
  const beforeChrome = chromeWith("Free delivery over Rs 499");
  const afterChrome = chromeWith("Free shipping over Rs 999");

  const pages = new Map<string, FakePage>([
    [
      "home",
      {
        id: "home",
        slug: "",
        title: "Home",
        // ★ Apply leaves an existing page's title and search text alone.
        seoTitle: "Fresh groceries",
        seoDescription: "Groceries",
        sections: afterHome,
        publishedSections: beforeHome,
        status: "published",
        publishedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: T0,
      },
    ],
    [
      "about",
      {
        id: "about",
        slug: "our-story",
        title: "Our story",
        seoTitle: "Our story",
        seoDescription: "",
        sections: afterAbout,
        publishedSections: [],
        status: "draft",
        publishedAt: null,
        updatedAt: T0,
      },
    ],
  ]);
  const state = {
    revamp: {
      appliedAt: T0,
      publishedAt: null,
      undoneAt: null,
      applySnapshot: null as unknown,
      publishSnapshot: null as unknown,
    } as LockedRevamp,
    pages,
    chrome: {
      draft: afterChrome as unknown,
      published: beforeChrome as unknown,
      publishedAt: "2026-10-01T00:00:00.000Z" as string | null,
    } as {
      draft: unknown;
      published: unknown;
      publishedAt: string | null;
    } | null,
    brand: {
      name: "Lumen",
      tagline: "Candles for slow evenings",
      blurb: "Hand-poured in Pune",
    } as Record<string, unknown> | null,
    products: new Map<string, FakeProduct>([
      [
        "candle",
        {
          name: "Amber candle",
          status: "published",
          clock: T0,
          ordered: false,
          categoryId: "pillar",
        },
      ],
      [
        "sold",
        {
          name: "Cedar candle",
          status: "published",
          clock: T0,
          ordered: true,
          categoryId: null,
        },
      ],
      [
        "sample",
        {
          name: "Apples (Sample)",
          status: "draft",
          clock: T0,
          ordered: false,
          categoryId: null,
          publishedAt: null,
        },
      ],
    ]),
    categories: new Map<string, FakeCategory>([
      [
        "pillar",
        {
          name: "Pillar candles",
          description: null,
          imageUrl: null,
          status: "active",
          updatedAt: T0,
        },
      ],
      [
        "fruit",
        {
          name: "Tea lights",
          description: "Small ones",
          imageUrl: null,
          status: "active",
          updatedAt: T0,
        },
      ],
      [
        "veg",
        {
          name: "Vegetables",
          description: null,
          imageUrl: null,
          status: "hidden",
          updatedAt: T0,
        },
      ],
    ]),
    refuseDelete: new Set<string>(),
    /** Categories an offer is scoped to (offer_products.category_id). */
    offerCategories: new Set<string>(),
    /** The redesign's newer versions (its refinements, every generation). */
    newer: [] as Array<{ appliedAt: string | null; undoneAt: string | null }>,
  };

  const apply: RevampApplySnapshot = {
    version: 1,
    appliedAt: T0,
    pages: [
      {
        pageId: "home",
        slug: "",
        created: false,
        before: {
          title: "Home",
          seoTitle: "Fresh groceries",
          seoDescription: "Groceries",
          sections: beforeHome,
        },
        afterUpdatedAt: T0,
        afterDigest: revampSectionsDigest(afterHome),
        proposed: {
          title: "Home",
          seoTitle: "Lumen candles",
          seoDescription: "Candles for slow evenings",
        },
      },
      {
        pageId: "about",
        slug: "our-story",
        created: true,
        before: null,
        afterUpdatedAt: T0,
        afterDigest: revampSectionsDigest(afterAbout),
        proposed: null,
      },
    ],
    chrome: {
      rowExisted: true,
      before: structuredClone(beforeChrome),
      afterDigest: revampChromeDigest(sanitizeChromeForSave(afterChrome)),
    },
    brand: {
      before: { tagline: "Fresh groceries", blurb: null },
      after: {
        tagline: "Candles for slow evenings",
        blurb: "Hand-poured in Pune",
      },
    },
    categories: [
      {
        action: "create",
        id: "pillar",
        slug: "pillar-candles",
        before: null,
        afterUpdatedAt: T0,
      },
      {
        action: "update",
        id: "fruit",
        slug: "fruit",
        before: {
          name: "Fruit",
          description: null,
          imageUrl: "/themes/basket/fruit.webp",
          status: "active",
        },
        afterUpdatedAt: T0,
      },
      {
        action: "hide",
        id: "veg",
        slug: "vegetables",
        before: {
          name: "Vegetables",
          description: null,
          imageUrl: null,
          status: "active",
        },
        afterUpdatedAt: T0,
      },
    ],
    products: {
      hidden: [
        {
          id: "sample",
          statusBefore: "published",
          afterUpdatedAt: T0,
          publishedAtBefore: "2026-09-30T00:00:00.000Z",
        },
      ],
      created: [
        { id: "candle", slug: "amber-candle", afterUpdatedAt: T0 },
        { id: "sold", slug: "cedar-candle", afterUpdatedAt: T0 },
      ],
    },
  };
  state.revamp.applySnapshot = apply;

  const stored = {
    pages: [
      { pageId: "home", slug: "", title: "Home", create: false },
      { pageId: null, slug: "our-story", title: "Our story", create: true },
    ],
    chrome: { next: afterChrome },
  };

  const tx: LifecycleTx = {
    async lockRevamp() {
      return state.revamp;
    },
    async newerVersions() {
      return state.newer.map((version) => ({ ...version }));
    },
    async storeFacts() {
      return { customCode: true, themeDesign: null };
    },
    async lockPage(pageId, expected) {
      const page = state.pages.get(pageId);
      return page
        ? {
            ...page,
            clockMatches: expected !== null && expected === page.updatedAt,
          }
        : null;
    },
    async publishPage(pageId, sections, now, meta) {
      const page = state.pages.get(pageId)!;
      Object.assign(page, meta ?? {}, {
        sections,
        publishedSections: sections,
        status: "published",
        publishedAt: now,
        updatedAt: tick(),
      });
      return page.updatedAt;
    },
    async lockChrome() {
      return state.chrome;
    },
    async publishChrome(published, now) {
      Object.assign(state.chrome!, { published, publishedAt: now });
    },
    async markPublished(record, now) {
      state.revamp.publishSnapshot = record;
      state.revamp.publishedAt = now;
    },
    async updatePage(pageId, patch) {
      Object.assign(state.pages.get(pageId)!, patch, { updatedAt: tick() });
    },
    async deletePage(pageId) {
      state.pages.delete(pageId);
    },
    async updateChrome(patch) {
      Object.assign(state.chrome!, patch);
    },
    async deleteChrome() {
      state.chrome = null;
    },
    async lockBrand() {
      return state.brand ? { ...state.brand } : null;
    },
    async writeBrand(brand) {
      state.brand = brand;
    },
    async lockProduct(productId, after) {
      const product = state.products.get(productId);
      return product
        ? {
            name: product.name,
            status: product.status,
            unchanged: product.clock <= after,
            ordered: product.ordered,
            usedBy: product.usedBy ?? null,
          }
        : null;
    },
    async deleteProduct(productId) {
      if (state.refuseDelete.has(productId)) return false;
      return state.products.delete(productId);
    },
    async setProductStatus(productId, status, publishedAt) {
      Object.assign(state.products.get(productId)!, {
        status,
        ...(publishedAt === undefined ? {} : { publishedAt }),
        clock: tick(),
      });
    },
    async lockCategory(categoryId, after) {
      const category = state.categories.get(categoryId);
      return category
        ? {
            name: category.name,
            unchanged: category.updatedAt === after,
            usedBy: [...state.products.values()].some(
              (product) => product.categoryId === categoryId,
            )
              ? ("products" as const)
              : state.offerCategories.has(categoryId)
                ? ("offer" as const)
                : null,
          }
        : null;
    },
    async deleteCategory(categoryId) {
      state.categories.delete(categoryId);
    },
    async updateCategory(categoryId, patch) {
      Object.assign(state.categories.get(categoryId)!, patch, {
        updatedAt: tick(),
      });
    },
    async markUndone(applySnapshot, now) {
      state.revamp.applySnapshot = applySnapshot;
      state.revamp.undoneAt = now;
    },
  };

  const transaction = vi.fn(
    async (_actor: unknown, _id: unknown, run: (tx: LifecycleTx) => unknown) =>
      run(tx),
  );
  const deps = { transaction } as unknown as RevampLifecycleDeps;
  holder.read.mockImplementation(async () => ({
    id: REVAMP,
    appliedAt: state.revamp.appliedAt,
    publishedAt: state.revamp.publishedAt,
    undoneAt: state.revamp.undoneAt,
    applySnapshot: state.revamp.applySnapshot,
    publishSnapshot: state.revamp.publishSnapshot,
    result: { stored },
  }));
  return {
    state,
    deps,
    transaction,
    tick,
    beforeHome,
    afterHome,
    beforeChrome,
    afterChrome,
  };
}

beforeEach(() => {
  holder.after.mockImplementation((task: () => unknown) => void task());
  holder.notify.mockImplementation(async () => undefined);
});

describe("publishRevamp", () => {
  it("★★ publishes every page and the header and footer, recording the live state before", async () => {
    const f = fixture();
    const result = await publishRevamp(ACTOR, REVAMP, f.deps);
    expect(result).toEqual({
      published: ["Homepage", "Our story page", "Header and footer"],
      skipped: [],
    });
    const home = f.state.pages.get("home")!;
    expect(home.status).toBe("published");
    expect(
      revampSectionsDigest(home.publishedSections as PageSectionItem[]),
    ).toBe(revampSectionsDigest(f.afterHome));
    expect(f.state.pages.get("about")!.status).toBe("published");
    // ★★ The redesign's title and search text go live now, not at Apply.
    expect(home).toMatchObject({
      title: "Home",
      seoTitle: "Lumen candles",
      seoDescription: "Candles for slow evenings",
    });
    expect(f.state.chrome!.published).toEqual(
      sanitizeChromeForSave(f.afterChrome),
    );

    const record = f.state.revamp.publishSnapshot as RevampPublishRecord;
    expect(f.state.revamp.publishedAt).not.toBeNull();
    expect(record.pages.find((page) => page.pageId === "home")!.before).toEqual(
      {
        status: "published",
        publishedSections: f.beforeHome,
        publishedAt: "2026-10-01T00:00:00.000Z",
      },
    );
    expect(record.pages.every((page) => page.draftWasApplied)).toBe(true);
    // The live values before and after, so Undo can put them back.
    expect(record.pages.find((page) => page.pageId === "home")!.meta).toEqual({
      before: {
        title: "Home",
        seoTitle: "Fresh groceries",
        seoDescription: "Groceries",
      },
      after: {
        title: "Home",
        seoTitle: "Lumen candles",
        seoDescription: "Candles for slow evenings",
      },
    });
    // A new page went in with its own title: nothing to record.
    expect(
      record.pages.find((page) => page.pageId === "about")!.meta,
    ).toBeNull();
    expect(record.chrome!.before).toEqual(f.beforeChrome);
    expect(record.answer).toEqual(result);

    // The same follow-up publishPage and publishChrome do.
    expect(holder.revalidateTag).toHaveBeenCalledWith(TAGS.pages, "max");
    expect(holder.revalidateTag).toHaveBeenCalledWith(TAGS.chrome, "max");
    expect(holder.revalidatePath).toHaveBeenCalledWith("/our-story");
    expect(holder.notify).toHaveBeenCalledWith({
      storeId: "store-1",
      paths: ["/", "/our-story"],
    });
    expect(holder.emit).toHaveBeenCalledTimes(3);
    expect(holder.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "page.published",
        payload: {
          page: "our-story",
          url: "https://lumen.storemink.com/our-story",
        },
      }),
    );
  });

  it("★★ keeps and names a title or search text the merchant changed after Apply", async () => {
    const f = fixture();
    // The merchant rewrote the search title in page settings after Apply.
    f.state.pages.get("home")!.seoTitle = "My own search title";
    const result = await publishRevamp(ACTOR, REVAMP, f.deps);
    expect(result.published).toContain("Homepage");
    expect(result.skipped).toEqual([
      {
        label: "Homepage search title",
        reason: "You changed it after the redesign, so your version was kept.",
      },
    ]);
    expect(f.state.pages.get("home")).toMatchObject({
      title: "Home",
      seoTitle: "My own search title",
      seoDescription: "Candles for slow evenings",
    });
    const record = f.state.revamp.publishSnapshot as RevampPublishRecord;
    expect(record.pages.find((page) => page.pageId === "home")!.meta).toEqual({
      before: {
        title: "Home",
        seoTitle: "My own search title",
        seoDescription: "Groceries",
      },
      after: {
        title: "Home",
        seoTitle: "My own search title",
        seoDescription: "Candles for slow evenings",
      },
    });
  });

  it("★ answers an already published revamp with the same answer and writes nothing", async () => {
    const f = fixture();
    const first = await publishRevamp(ACTOR, REVAMP, f.deps);
    holder.emit.mockClear();
    const second = await publishRevamp(ACTOR, REVAMP, f.deps);
    expect(second).toEqual(first);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(holder.emit).not.toHaveBeenCalled();
  });

  it("★ a publish that lost the lock to another tab returns that tab's answer", async () => {
    const f = fixture();
    await publishRevamp(ACTOR, REVAMP, f.deps);
    const answer = (f.state.revamp.publishSnapshot as RevampPublishRecord)
      .answer;
    // This call read the row before the other tab committed.
    holder.read.mockImplementationOnce(async () => ({
      appliedAt: T0,
      publishedAt: null,
      undoneAt: null,
      result: null,
    }));
    holder.emit.mockClear();
    expect(await publishRevamp(ACTOR, REVAMP, f.deps)).toEqual(answer);
    expect(holder.emit).not.toHaveBeenCalled();
  });

  it("refuses a revamp that was never applied, or was undone, or someone else's", async () => {
    const f = fixture();
    f.state.revamp.appliedAt = null;
    await expect(publishRevamp(ACTOR, REVAMP, f.deps)).rejects.toMatchObject({
      code: "mink_revamp_not_applied",
      status: 409,
    });
    f.state.revamp.appliedAt = T0;
    f.state.revamp.undoneAt = T0;
    await expect(publishRevamp(ACTOR, REVAMP, f.deps)).rejects.toMatchObject({
      code: "mink_revamp_undone",
    });
    holder.read.mockImplementationOnce(async () => null);
    await expect(publishRevamp(ACTOR, REVAMP, f.deps)).rejects.toMatchObject({
      status: 404,
    });
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("refuses a role without Website Builder manage before reading anything", async () => {
    const f = fixture();
    const viewer = {
      ...ACTOR,
      isSuperadmin: false,
      permissions: { builder: ["view"] },
    } as unknown as MinkActorContext;
    await expect(publishRevamp(viewer, REVAMP, f.deps)).rejects.toMatchObject({
      status: 403,
    });
    await expect(undoRevamp(viewer, REVAMP, f.deps)).rejects.toMatchObject({
      status: 403,
    });
    expect(holder.read).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Products manage",
      { builder: ["manage"], categories: ["manage"] },
      "Undoing this redesign removes or brings back products, which needs Products manage permission.",
    ],
    [
      "Categories manage",
      { builder: ["manage"], products: ["manage"] },
      "Undoing this redesign changes categories, which needs Categories manage permission.",
    ],
    [
      "Branding manage",
      { builder: ["manage"], products: ["manage"], categories: ["manage"] },
      "Undoing this redesign changes your store's tagline or footer description, which needs Branding manage permission.",
    ],
  ])(
    "★★ refuses Undo, writing nothing, to a role that has lost %s",
    async (_part, permissions, message) => {
      const f = fixture();
      const narrowed = {
        ...ACTOR,
        isSuperadmin: false,
        permissions,
      } as unknown as MinkActorContext;
      await expect(undoRevamp(narrowed, REVAMP, f.deps)).rejects.toMatchObject({
        code: "mink_revamp_access_denied",
        status: 403,
        message,
      });
      // Apply needed these permissions for the same rows; nothing moved.
      expect(f.state.pages.get("home")!.sections).toEqual(f.afterHome);
      expect(f.state.products.has("candle")).toBe(true);
      expect(f.state.categories.get("fruit")!.name).toBe("Tea lights");
      expect(f.state.brand).toEqual({
        name: "Lumen",
        tagline: "Candles for slow evenings",
        blurb: "Hand-poured in Pune",
      });
      expect(f.state.revamp.undoneAt).toBeNull();
    },
  );

  it.each([
    [
      "the tagline",
      {
        before: { tagline: "Fresh groceries", blurb: "Hand-poured in Pune" },
        after: {
          tagline: "Candles for slow evenings",
          blurb: "Hand-poured in Pune",
        },
      },
    ],
    [
      "the footer description",
      {
        before: { tagline: "Candles for slow evenings", blurb: null },
        after: {
          tagline: "Candles for slow evenings",
          blurb: "Hand-poured in Pune",
        },
      },
    ],
  ])(
    "★★ needs Branding manage when Apply changed only %s",
    async (_field, brand) => {
      const f = fixture();
      const apply = f.state.revamp.applySnapshot as RevampApplySnapshot;
      apply.brand = brand;
      const noBranding = {
        ...ACTOR,
        isSuperadmin: false,
        permissions: {
          builder: ["manage"],
          products: ["manage"],
          categories: ["manage"],
        },
      } as unknown as MinkActorContext;
      await expect(
        undoRevamp(noBranding, REVAMP, f.deps),
      ).rejects.toMatchObject({ code: "mink_revamp_access_denied" });
      expect(f.state.brand).toEqual({
        name: "Lumen",
        tagline: "Candles for slow evenings",
        blurb: "Hand-poured in Pune",
      });
      expect(f.state.revamp.undoneAt).toBeNull();
    },
  );

  it("★ lets a Builder-only role undo a redesign that touched no products, categories, tagline or footer description", async () => {
    const f = fixture();
    const apply = f.state.revamp.applySnapshot as RevampApplySnapshot;
    apply.categories = [];
    apply.products = { hidden: [], created: [] };
    apply.brand = null;
    const builderOnly = {
      ...ACTOR,
      isSuperadmin: false,
      permissions: { builder: ["manage"] },
    } as unknown as MinkActorContext;
    const result = await undoRevamp(builderOnly, REVAMP, f.deps);
    expect(result.restored).toContain("Homepage");
    expect(f.state.pages.get("home")!.sections).toEqual(f.beforeHome);
  });

  it("★ needs no Branding manage for a tagline and footer description Apply left as they were", async () => {
    const f = fixture();
    const apply = f.state.revamp.applySnapshot as RevampApplySnapshot;
    // Undo reads the text the way the brand digest does (trimmed, blank as
    // none), so these are the same values and Undo writes neither.
    apply.brand = {
      before: { tagline: "Candles for slow evenings ", blurb: "" },
      after: { tagline: "Candles for slow evenings", blurb: null },
    };
    const noBranding = {
      ...ACTOR,
      isSuperadmin: false,
      permissions: {
        builder: ["manage"],
        products: ["manage"],
        categories: ["manage"],
      },
    } as unknown as MinkActorContext;
    const result = await undoRevamp(noBranding, REVAMP, f.deps);
    expect(result.restored).toContain("Homepage");
    expect(result.restored).not.toContain("Store tagline");
    expect(result.restored).not.toContain("Footer description");
    expect(f.state.brand).toEqual({
      name: "Lumen",
      tagline: "Candles for slow evenings",
      blurb: "Hand-poured in Pune",
    });
    expect(f.state.revamp.undoneAt).not.toBeNull();
  });

  it("★ skips and names a page the merchant deleted, and one that fails the publish bar", async () => {
    const f = fixture();
    f.state.pages.delete("about");
    f.state.pages.get("home")!.sections = [
      { ...section("hero", ""), config: { html: " ", width: "contained" } },
    ];
    const result = await publishRevamp(ACTOR, REVAMP, f.deps);
    expect(result.published).toEqual(["Header and footer"]);
    expect(result.skipped).toEqual([
      {
        label: "Homepage",
        reason: "Section 1 (rich_text): Add some content first.",
      },
      {
        label: "Our story page",
        reason: "You deleted this page, so it was not published.",
      },
    ]);
    expect(f.state.pages.get("home")!.publishedSections).toEqual(f.beforeHome);
  });

  it("records nothing when nothing could go live, so Publish can be tried again", async () => {
    const f = fixture();
    f.state.pages.clear();
    f.state.chrome = null;
    const result = await publishRevamp(ACTOR, REVAMP, f.deps);
    expect(result.published).toEqual([]);
    expect(f.state.revamp.publishedAt).toBeNull();
  });
});

describe("undoRevamp", () => {
  it("★★ puts back everything the redesign changed, before any publish", async () => {
    const f = fixture();
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(result.restored).toEqual([
      "Homepage",
      "Removed the new Our story page",
      "Header and footer",
      "Store tagline",
      "Footer description",
      "Removed Amber candle",
      "Apples (Sample) is back on your shop",
      "Removed the new Pillar candles category",
      "Fruit category",
      "Vegetables category is shown again",
    ]);
    expect(result.kept).toEqual([
      {
        label: "Cedar candle",
        reason:
          "It already has orders, so it was taken off your shop instead of deleted.",
      },
    ]);
    const home = f.state.pages.get("home")!;
    expect(home.sections).toEqual(f.beforeHome);
    // Apply never wrote the title and search text, so they are as they were.
    expect(home).toMatchObject({
      seoTitle: "Fresh groceries",
      seoDescription: "Groceries",
    });
    // Never published by the redesign: the live page is not touched.
    expect(home.publishedSections).toEqual(f.beforeHome);
    expect(f.state.pages.has("about")).toBe(false);
    expect(f.state.chrome!.draft).toEqual(f.beforeChrome);
    expect(f.state.brand).toEqual({
      name: "Lumen",
      tagline: "Fresh groceries",
    });
    expect(f.state.products.has("candle")).toBe(false);
    expect(f.state.products.get("sold")!.status).toBe("draft");
    // ★ Back on the shop with the date it was first published.
    expect(f.state.products.get("sample")).toMatchObject({
      status: "published",
      publishedAt: "2026-09-30T00:00:00.000Z",
    });
    expect(f.state.categories.has("pillar")).toBe(false);
    expect(f.state.categories.get("fruit")).toMatchObject({
      name: "Fruit",
      imageUrl: "/themes/basket/fruit.webp",
    });
    expect(f.state.categories.get("veg")!.status).toBe("active");
    expect(f.state.revamp.undoneAt).not.toBeNull();
    expect((f.state.revamp.applySnapshot as { undo: unknown }).undo).toEqual(
      result,
    );
    expect(holder.revalidateTag).toHaveBeenCalledWith("stores", { expire: 0 });
    expect(holder.revalidateTag).toHaveBeenCalledWith(TAGS.categories, {
      expire: 0,
    });
  });

  it("★★ after a publish, puts the live pages and the live header back too", async () => {
    const f = fixture();
    await publishRevamp(ACTOR, REVAMP, f.deps);
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(result.kept).not.toContainEqual(
      expect.objectContaining({ label: "Homepage" }),
    );
    const home = f.state.pages.get("home")!;
    expect(home.sections).toEqual(f.beforeHome);
    expect(home.publishedSections).toEqual(f.beforeHome);
    expect(home.status).toBe("published");
    expect(home.publishedAt).toBe("2026-10-01T00:00:00.000Z");
    // ★★ And the title and search text Publish wrote.
    expect(home).toMatchObject({
      seoTitle: "Fresh groceries",
      seoDescription: "Groceries",
    });
    // The new page went live with the redesign and leaves with it.
    expect(f.state.pages.has("about")).toBe(false);
    expect(f.state.chrome).toMatchObject({
      draft: f.beforeChrome,
      published: f.beforeChrome,
      publishedAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("★★ a store that had no header row: after a publish, an edited header draft still takes the redesign's header off the live store", async () => {
    const f = fixture();
    const apply = f.state.revamp.applySnapshot as RevampApplySnapshot;
    // Apply created the row: nothing was live, and there was no draft.
    apply.chrome = { ...apply.chrome!, rowExisted: false, before: null };
    f.state.chrome = {
      draft: f.afterChrome,
      published: null,
      publishedAt: null,
    };
    await publishRevamp(ACTOR, REVAMP, f.deps);
    expect(f.state.chrome!.published).toEqual(
      sanitizeChromeForSave(f.afterChrome),
    );
    // The merchant then edits the announcement in the Builder (draft only).
    const mine = chromeWith("Diwali sale this week");
    f.state.chrome!.draft = mine;

    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    // ★ Nothing is live again, so the store's own menus show, as before.
    expect(f.state.chrome).toEqual({
      draft: mine,
      published: null,
      publishedAt: null,
    });
    expect(result.restored).toContain("Header and footer (live)");
    expect(result.kept).toContainEqual({
      label: "Header and footer",
      reason: "You changed it after the redesign, so your version was kept.",
    });
  });

  it("★ with a header row: an edited header draft keeps the draft and names only the live header as put back", async () => {
    const f = fixture();
    await publishRevamp(ACTOR, REVAMP, f.deps);
    const mine = chromeWith("Diwali sale this week");
    f.state.chrome!.draft = mine;
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(f.state.chrome).toMatchObject({
      draft: mine,
      published: f.beforeChrome,
      publishedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(result.restored).toContain("Header and footer (live)");
    expect(result.restored).not.toContain("Header and footer");
    expect(result.kept).toContainEqual({
      label: "Header and footer",
      reason: "You changed it after the redesign, so your version was kept.",
    });
  });

  it("★★ leaves a page the merchant unpublished after the redesign went live unpublished", async () => {
    const f = fixture();
    await publishRevamp(ACTOR, REVAMP, f.deps);
    // The Builder's Unpublish sets the status only: the redesign's sections
    // stay in published_sections.
    Object.assign(f.state.pages.get("home")!, {
      status: "draft",
      updatedAt: f.tick(),
    });
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    const home = f.state.pages.get("home")!;
    expect(home.status).toBe("draft");
    expect(result.kept).toContainEqual({
      label: "Homepage (live)",
      reason:
        "You unpublished it after the redesign, so it was left unpublished.",
    });
    expect(result.restored).not.toContain("Homepage (live)");
    // The draft was never touched, so it still goes back.
    expect(home.sections).toEqual(f.beforeHome);
    expect(result.restored).toContain("Homepage");
  });

  it("★ names only the search text as put back when the draft and the live page are both the merchant's", async () => {
    const f = fixture();
    await publishRevamp(ACTOR, REVAMP, f.deps);
    Object.assign(f.state.pages.get("home")!, {
      sections: [section("mine", "My own words")],
      status: "draft",
      updatedAt: f.tick(),
    });
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    const home = f.state.pages.get("home")!;
    expect(home.sections).toEqual([section("mine", "My own words")]);
    expect(home.status).toBe("draft");
    // The search text Publish wrote is still the redesign's, so it goes
    // back, and the answer says that is all that came back.
    expect(home).toMatchObject({
      seoTitle: "Fresh groceries",
      seoDescription: "Groceries",
    });
    expect(result.restored).toContain(
      "Homepage search title and search description",
    );
    expect(result.restored).not.toContain("Homepage");
    expect(result.restored).not.toContain("Homepage (live)");
  });

  it("★★ keeps and names everything the merchant changed since", async () => {
    const f = fixture();
    await publishRevamp(ACTOR, REVAMP, f.deps);
    // The merchant edits the homepage draft, republishes the new page,
    // rewrites the tagline and renames a category.
    Object.assign(f.state.pages.get("home")!, {
      sections: [section("mine", "My own words")],
      updatedAt: f.tick(),
    });
    Object.assign(f.state.pages.get("about")!, {
      publishedSections: [section("story", "Edited and published")],
      updatedAt: f.tick(),
    });
    f.state.brand!.tagline = "My tagline";
    Object.assign(f.state.categories.get("fruit")!, {
      name: "Votives",
      updatedAt: f.tick(),
    });

    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(result.kept).toEqual(
      expect.arrayContaining([
        {
          label: "Homepage",
          reason:
            "You changed it after the redesign, so your version was kept.",
        },
        {
          label: "Our story page",
          reason:
            "You changed this new page after the redesign, so it was kept.",
        },
        {
          label: "Store tagline",
          reason:
            "You changed it after the redesign, so your version was kept.",
        },
        {
          label: "Votives category",
          reason:
            "You changed it after the redesign, so your version was kept.",
        },
      ]),
    );
    // The live homepage is still the redesign's, so it goes back.
    expect(result.restored).toContain("Homepage (live)");
    const home = f.state.pages.get("home")!;
    expect(home.sections).toEqual([section("mine", "My own words")]);
    expect(home.publishedSections).toEqual(f.beforeHome);
    expect(f.state.pages.has("about")).toBe(true);
    expect(f.state.brand!.tagline).toBe("My tagline");
    expect(f.state.brand!.blurb).toBeUndefined();
    expect(f.state.categories.get("fruit")!.name).toBe("Votives");
  });

  it("★ after a publish, keeps a search text the merchant changed since and puts the rest back", async () => {
    const f = fixture();
    await publishRevamp(ACTOR, REVAMP, f.deps);
    f.state.pages.get("home")!.seoDescription = "Mine now";
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(result.kept).toContainEqual({
      label: "Homepage search description",
      reason: "You changed it after the redesign, so your version was kept.",
    });
    expect(f.state.pages.get("home")).toMatchObject({
      seoTitle: "Fresh groceries",
      seoDescription: "Mine now",
    });
  });

  it("★ an older snapshot, whose Apply wrote the title and search text, puts them back with the draft", async () => {
    const f = fixture();
    const apply = f.state.revamp.applySnapshot as RevampApplySnapshot;
    const { proposed: _proposed, ...oldHome } = apply.pages[0];
    void _proposed;
    f.state.revamp.applySnapshot = {
      ...apply,
      pages: [oldHome, apply.pages[1]],
    };
    Object.assign(f.state.pages.get("home")!, {
      seoTitle: "Lumen candles",
      seoDescription: "Candles for slow evenings",
    });
    await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(f.state.pages.get("home")).toMatchObject({
      sections: f.beforeHome,
      seoTitle: "Fresh groceries",
      seoDescription: "Groceries",
    });
  });

  it("★★ after a publish, a search title edit alone does not keep the redesign in the draft", async () => {
    const f = fixture();
    await publishRevamp(ACTOR, REVAMP, f.deps);
    // Page settings save the search title straight to the row, which moves
    // `updated_at`; the sections are untouched.
    Object.assign(f.state.pages.get("home")!, {
      seoTitle: "My own search title",
      updatedAt: f.tick(),
    });
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    const home = f.state.pages.get("home")!;
    expect(home.sections).toEqual(f.beforeHome);
    expect(home.publishedSections).toEqual(f.beforeHome);
    expect(home.seoTitle).toBe("My own search title");
    expect(result.restored).toContain("Homepage");
    expect(result.kept).toContainEqual({
      label: "Homepage search title",
      reason: "You changed it after the redesign, so your version was kept.",
    });
    expect(result.kept).not.toContainEqual(
      expect.objectContaining({ label: "Homepage" }),
    );
  });

  /** The live page as Apply found it, as Apply records it. */
  function withLiveFingerprint(f: ReturnType<typeof fixture>) {
    const apply = f.state.revamp.applySnapshot as RevampApplySnapshot;
    apply.pages[0] = {
      ...apply.pages[0],
      live: {
        status: "published",
        publishedDigest: revampSectionsDigest(f.beforeHome),
      },
    };
  }

  it("★★ before a publish, a title edit alone does not keep the redesign in the draft", async () => {
    const f = fixture();
    withLiveFingerprint(f);
    Object.assign(f.state.pages.get("home")!, {
      title: "Welcome",
      updatedAt: f.tick(),
    });
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    const home = f.state.pages.get("home")!;
    expect(home.sections).toEqual(f.beforeHome);
    expect(home.title).toBe("Welcome");
    expect(result.restored).toContain("Homepage");
    expect(result.kept).not.toContainEqual(
      expect.objectContaining({ label: "Homepage" }),
    );
  });

  it("★ before a publish, keeps the draft of a page the merchant published themselves", async () => {
    const f = fixture();
    withLiveFingerprint(f);
    // The Builder's Publish put the redesign's draft live, without our card.
    Object.assign(f.state.pages.get("home")!, {
      publishedSections: f.afterHome,
      publishedAt: "2026-10-21T08:00:00.000Z",
      updatedAt: f.tick(),
    });
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    const home = f.state.pages.get("home")!;
    expect(home.sections).toEqual(f.afterHome);
    expect(home.publishedSections).toEqual(f.afterHome);
    expect(result.kept).toContainEqual({
      label: "Homepage",
      reason: "You changed it after the redesign, so your version was kept.",
    });
  });

  it("★ a title edit between Apply and Publish still lets Undo restore the draft", async () => {
    const f = fixture();
    withLiveFingerprint(f);
    Object.assign(f.state.pages.get("home")!, {
      title: "Welcome",
      updatedAt: f.tick(),
    });
    await publishRevamp(ACTOR, REVAMP, f.deps);
    const record = f.state.revamp.publishSnapshot as RevampPublishRecord;
    expect(
      record.pages.find((page) => page.pageId === "home")!.draftWasApplied,
    ).toBe(true);
    await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(f.state.pages.get("home")!.sections).toEqual(f.beforeHome);
  });

  it("★★ an older snapshot, whose Apply wrote the title with the draft, never overwrites a title the merchant changed since", async () => {
    const f = fixture();
    const apply = f.state.revamp.applySnapshot as RevampApplySnapshot;
    const { proposed: _proposed, ...oldHome } = apply.pages[0];
    void _proposed;
    f.state.revamp.applySnapshot = {
      ...apply,
      pages: [oldHome, apply.pages[1]],
    };
    Object.assign(f.state.pages.get("home")!, {
      seoTitle: "Lumen candles",
      seoDescription: "Candles for slow evenings",
    });
    await publishRevamp(ACTOR, REVAMP, f.deps);
    Object.assign(f.state.pages.get("home")!, {
      seoTitle: "My own search title",
      updatedAt: f.tick(),
    });
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(f.state.pages.get("home")!.seoTitle).toBe("My own search title");
    expect(result.kept).toContainEqual({
      label: "Homepage",
      reason: "You changed it after the redesign, so your version was kept.",
    });
  });

  it("★ without Apply's live record, falls back to the page clock before a publish", async () => {
    const f = fixture();
    Object.assign(f.state.pages.get("home")!, {
      title: "Welcome",
      updatedAt: f.tick(),
    });
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(f.state.pages.get("home")!.sections).toEqual(f.afterHome);
    expect(result.kept).toContainEqual({
      label: "Homepage",
      reason: "You changed it after the redesign, so your version was kept.",
    });
  });

  it("★ keeps a new page whose title the merchant changed", async () => {
    const f = fixture();
    Object.assign(f.state.pages.get("about")!, {
      title: "About us",
      updatedAt: f.tick(),
    });
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(f.state.pages.has("about")).toBe(true);
    expect(result.kept).toContainEqual({
      label: "Our story page",
      reason: "You changed this new page after the redesign, so it was kept.",
    });
  });

  it("★ keeps the draft the merchant edited between Apply and Publish", async () => {
    const f = fixture();
    Object.assign(f.state.pages.get("home")!, {
      sections: [section("mine", "Edited before publishing")],
      updatedAt: f.tick(),
    });
    await publishRevamp(ACTOR, REVAMP, f.deps);
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(result.kept).toContainEqual({
      label: "Homepage",
      reason: "You changed it after the redesign, so your version was kept.",
    });
    expect(f.state.pages.get("home")!.sections).toEqual([
      section("mine", "Edited before publishing"),
    ]);
    expect(f.state.pages.get("home")!.publishedSections).toEqual(f.beforeHome);
  });

  it("★ a new category stays while a product the merchant kept is filed under it", async () => {
    const f = fixture();
    f.state.products.get("candle")!.clock = f.tick();
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(result.kept).toEqual(
      expect.arrayContaining([
        {
          label: "Amber candle",
          reason:
            "You changed it after the redesign, so your version was kept.",
        },
        {
          label: "Pillar candles category",
          reason: "Products are filed under it, so it was kept.",
        },
      ]),
    );
    expect(f.state.products.get("candle")!.status).toBe("published");
    expect(f.state.categories.has("pillar")).toBe(true);
  });

  it.each([
    [
      "offer",
      "An offer uses it, so it was taken off your shop instead of deleted.",
    ],
    [
      "review",
      "Customers have reviewed it, so it was taken off your shop instead of deleted.",
    ],
  ] as const)(
    "★★ takes a new product a(n) %s uses off the shop instead of deleting it",
    async (usedBy, reason) => {
      const f = fixture();
      f.state.products.get("candle")!.usedBy = usedBy;
      const result = await undoRevamp(ACTOR, REVAMP, f.deps);
      expect(result.restored).not.toContain("Removed Amber candle");
      expect(result.kept).toContainEqual({ label: "Amber candle", reason });
      expect(f.state.products.get("candle")!.status).toBe("draft");
      // Still filed under the new category, which therefore stays too.
      expect(f.state.categories.has("pillar")).toBe(true);
    },
  );

  it("★★ keeps a new category an offer is scoped to", async () => {
    const f = fixture();
    f.state.offerCategories.add("pillar");
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(result.restored).toContain("Removed Amber candle");
    expect(result.kept).toContainEqual({
      label: "Pillar candles category",
      reason: "An offer uses it, so it was kept.",
    });
    expect(f.state.categories.has("pillar")).toBe(true);
  });

  it("unpublishes a new product the database will not let go", async () => {
    const f = fixture();
    f.state.refuseDelete.add("candle");
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(result.kept).toContainEqual({
      label: "Amber candle",
      reason: "It could not be deleted, so it was taken off your shop instead.",
    });
    expect(f.state.products.get("candle")!.status).toBe("draft");
  });

  it("★ is idempotent: a second Undo returns the first answer and writes nothing", async () => {
    const f = fixture();
    const first = await undoRevamp(ACTOR, REVAMP, f.deps);
    const second = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(second).toEqual(first);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    await expect(publishRevamp(ACTOR, REVAMP, f.deps)).rejects.toMatchObject({
      code: "mink_revamp_undone",
    });
  });

  it("refuses a revamp that was never applied", async () => {
    const f = fixture();
    f.state.revamp.appliedAt = null;
    await expect(undoRevamp(ACTOR, REVAMP, f.deps)).rejects.toMatchObject({
      code: "mink_revamp_not_applied",
    });
  });

  // U-1: a refinement applied after this version builds on it (its pages show
  // the products and categories this one made), so undoing this one first
  // would take them off the shop under the newer version's pages.
  it("★★ refuses Undo, writing nothing, while a newer version of the redesign is applied", async () => {
    const f = fixture();
    f.state.newer = [
      { appliedAt: null, undoneAt: null },
      { appliedAt: T0, undoneAt: null },
    ];
    await expect(undoRevamp(ACTOR, REVAMP, f.deps)).rejects.toMatchObject({
      code: "mink_revamp_newer_version_applied",
      status: 409,
      message:
        "A newer version of this redesign is applied and builds on this one. Undo the newer version on its card first, then undo this one.",
    });
    expect(f.state.pages.get("home")!.sections).toEqual(f.afterHome);
    expect(f.state.pages.has("about")).toBe(true);
    expect(f.state.chrome!.draft).toEqual(f.afterChrome);
    expect(f.state.products.has("candle")).toBe(true);
    expect(f.state.categories.has("pillar")).toBe(true);
    expect(f.state.brand).toMatchObject({
      tagline: "Candles for slow evenings",
    });
    expect(f.state.revamp.undoneAt).toBeNull();
  });

  it("★ undoes as before when every newer version was undone or never applied", async () => {
    const f = fixture();
    f.state.newer = [
      { appliedAt: T0, undoneAt: "2026-10-21T08:00:00.000Z" },
      { appliedAt: null, undoneAt: null },
    ];
    const result = await undoRevamp(ACTOR, REVAMP, f.deps);
    expect(result.restored).toContain("Homepage");
    expect(f.state.products.has("candle")).toBe(false);
    expect(f.state.revamp.undoneAt).not.toBeNull();
  });

  it("★ a second Undo returns the first answer even once a newer version is applied", async () => {
    const f = fixture();
    const first = await undoRevamp(ACTOR, REVAMP, f.deps);
    f.state.newer = [{ appliedAt: T0, undoneAt: null }];
    expect(await undoRevamp(ACTOR, REVAMP, f.deps)).toEqual(first);
  });

  it("★ refuses rather than half-undo when the apply record is malformed", async () => {
    const f = fixture();
    const apply = f.state.revamp.applySnapshot as RevampApplySnapshot;
    f.state.revamp.applySnapshot = {
      ...apply,
      pages: [{ ...apply.pages[0], afterUpdatedAt: "yesterday" }],
    };
    await expect(undoRevamp(ACTOR, REVAMP, f.deps)).rejects.toMatchObject({
      code: "mink_revamp_record_unreadable",
    });
    expect(f.state.pages.get("home")!.sections).not.toEqual(f.beforeHome);
    expect(readApplySnapshot(apply)).toEqual(apply);
  });
});
