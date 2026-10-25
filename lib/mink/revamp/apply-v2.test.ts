/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  normalizeChrome,
  sanitizeChromeForSave,
  type StoreChrome,
} from "@/lib/chrome/types";
import {
  EMPTY_CONFIG,
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { digestMinkStorefrontValue } from "../storefront-code-contract";
import type { MinkActorContext } from "../types";
import { EMPTY_DESIGN_OVERRIDES } from "@/lib/chrome/design";
import { digestMinkStorefrontDesign } from "../storefront-design-contract";
import { chromeTextDigest } from "../storefront-personalization-context";
import type { PersonalizationStoredPlan } from "../storefront-personalization-contract";
import type { RevampStoredPlan } from "./contract";
import {
  revampBrandDigest,
  revampChromeDigest,
  revampSectionsDigest,
} from "./digests";
import type { RevampApplySnapshot } from "./lifecycle-types";
import { sqlParamValues } from "@/app/actions/_test-helpers";

const state = vi.hoisted(() => ({
  pages: new Map<string, any>(),
  pageSlugs: new Set<string>(),
  chromeRow: null as null | { draft: unknown },
  settings: null as Record<string, unknown> | null,
  categories: new Map<string, any>(),
  products: new Map<string, any>(),
  productSlugs: new Set<string>(),
  capacity: { allowed: 10, error: "" },
  owned: new Set<string>(),
  draftRow: null as any,
  approvalRow: null as any,
  auditRow: null as any,
  approvalConflict: false,
  revampRows: 1,
  /** The revamp's job rows Apply finds (and locks) before the store's. */
  revampJobs: [] as Array<{
    id: string;
    applied_at: string | null;
    undone_at: string | null;
    parent_id?: string | null;
    request?: unknown;
  }>,
  /** Refinements of the job still being made (chat-1). */
  revampChildren: [] as Array<{ id: string }>,
  /** Earlier versions of the job, by id (chat-1). */
  revampAncestors: new Map<string, any>(),
  /** A first chrome draft saved by someone else after Apply's lock read. */
  chromeInsertRace: false,
  inserts: [] as Array<{ table: string; values: any }>,
  updates: [] as Array<{ table: string; values: any }>,
  /** lock:<table> and write:<table>, in the order they happened. */
  events: [] as string[],
  ids: 0,
  emit: null as any,
  notify: null as any,
  after: null as any,
}));

const NOW = "2026-10-21 10:00:00.5+00";

function queryText(query: any): string {
  return ((query?.queryChunks ?? []) as any[])
    .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join(" ") : ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** The values a query was given, in order. */
function queryParams(query: any): unknown[] {
  return ((query?.queryChunks ?? []) as any[]).filter(
    (chunk) => typeof chunk === "string" || typeof chunk === "number",
  );
}

function chain(table: string, mode: "select" | "insert" | "update") {
  let name = table;
  let values: any = null;
  let entry: { table: string; values: any; where?: unknown } | null = null;
  const proxy: any = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: any) => void) => resolve(answer());
        }
        return (...args: any[]) => {
          if (property === "from" && args[0]) name = getTableName(args[0]);
          if (property === "values" || property === "set") {
            values = args[0];
            state.events.push(`write:${name}`);
            entry = { table: name, values };
            (mode === "insert" ? state.inserts : state.updates).push(entry);
          }
          // The condition an update was given, for the tests that read it.
          if (property === "where" && entry) entry.where = args[0];
          return proxy;
        };
      },
    },
  );
  function answer(): any[] {
    if (mode === "select") return selectRows(name);
    if (mode === "insert") return insertRows(name, values);
    return updateRows(name);
  }
  return proxy;
}

function selectRows(table: string): any[] {
  if (table === "mink_drafts") return state.draftRow ? [state.draftRow] : [];
  if (table === "mink_action_approvals") {
    return state.approvalRow ? [state.approvalRow] : [];
  }
  if (table === "mink_action_tool_access") return [{ enabled: true }];
  if (table === "mink_action_audit")
    return state.auditRow ? [state.auditRow] : [];
  if (table === "categories") {
    return [...state.categories.values()].map((row) => ({
      id: row.id,
      slug: row.slug,
    }));
  }
  if (table === "products") {
    return [...state.productSlugs].map((slug) => ({ slug }));
  }
  return [];
}

function insertRows(table: string, values: any): any[] {
  if (table === "mink_action_approvals") {
    if (state.approvalConflict) return [];
    return [
      {
        status: "pending",
        resultId: null,
        resultVersion: null,
        approvedAt: null,
        executedAt: null,
        ...values,
      },
    ];
  }
  if (["store_pages", "categories", "products"].includes(table)) {
    state.ids += 1;
    return [{ id: `new-${table}-${state.ids}`, updatedAt: NOW }];
  }
  // A first chrome draft that raced in makes ON CONFLICT DO NOTHING return
  // nothing; otherwise the row Apply inserted comes back.
  if (table === "store_chrome") {
    return state.chromeInsertRace ? [] : [{ storeId: STORE_ID }];
  }
  return [];
}

function updateRows(table: string): any[] {
  if (table === "store_pages") return [{ id: PAGE_ID, updatedAt: NOW }];
  if (table === "categories") return [{ updatedAt: NOW }];
  if (table === "products") {
    return [...state.products.values()].map((row) => ({
      id: row.id,
      updatedAt: NOW,
    }));
  }
  if (table === "mink_revamps") {
    return state.revampRows ? [{ id: REVAMP_ID }] : [];
  }
  if (table === "mink_action_approvals") return [{ id: "approval" }];
  return [];
}

const db = {
  execute: async (query: any) => {
    const text = queryText(query);
    const table = /from\s+public\.([a-z_]+)/i.exec(text)?.[1] ?? "";
    if (/for update/i.test(text)) state.events.push(`lock:${table}`);
    if (/pg_advisory_xact_lock/i.test(text)) {
      state.events.push("lock:advisory");
      return { rows: [] };
    }
    if (table === "store_pages") {
      return /for update/i.test(text)
        ? {
            rows: [...state.pages.entries()].map(([id, row]) => ({
              id,
              ...row,
            })),
          }
        : { rows: [...state.pageSlugs].map((slug) => ({ slug })) };
    }
    if (table === "store_chrome") {
      return { rows: state.chromeRow ? [state.chromeRow] : [] };
    }
    if (table === "store_menus") return { rows: [] };
    if (table === "mink_revamps") {
      if (/draft_id/i.test(text)) return { rows: state.revampJobs };
      if (/parent_id\s*=/i.test(text)) return { rows: state.revampChildren };
      const id = queryParams(query).at(-1);
      const row = state.revampAncestors.get(String(id));
      return { rows: row ? [row] : [] };
    }
    if (table === "stores") {
      return { rows: state.settings ? [{ settings: state.settings }] : [] };
    }
    if (table === "categories") {
      if (/coalesce\(max/i.test(text)) return { rows: [{ sort: 4 }] };
      return { rows: [...state.categories.values()] };
    }
    if (table === "products") return { rows: [...state.products.values()] };
    if (table === "mink_action_tool_access")
      return { rows: [{ enabled: true }] };
    return { rows: [] };
  },
  select: () => chain("", "select"),
  insert: (table: any) => chain(getTableName(table), "insert"),
  update: (table: any) => chain(getTableName(table), "update"),
};

vi.mock("@/lib/db/client", () => ({ withService: (fn: any) => fn(db) }));
vi.mock("@/lib/plans/entitlements", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProductCreateCapacity: async () => state.capacity,
}));
vi.mock("@/lib/mink/storefront-media-read", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selectOwnedStorefrontImageUrls: async (
    _db: unknown,
    _storeId: string,
    urls: readonly string[],
  ) => new Set(urls.filter((url) => state.owned.has(url))),
}));
vi.mock("@/lib/notifications/record", () => ({
  emitEvent: (...args: unknown[]) => state.emit?.(...args),
}));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: (...args: unknown[]) => state.notify?.(...args),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: (task: unknown) => state.after?.(task),
}));

import {
  executeMinkStorefrontPersonalizationAction,
  previewMinkStorefrontPersonalizationAction,
} from "../storefront-personalization-actions";
import { MinkRequestError } from "../errors";
import { REVAMP_CONFLICT_MESSAGE, readRevampStoredPlan } from "./apply-v2";
import { readApplySnapshot } from "./publish";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const REVAMP_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const CAT_UPDATE_ID = "44444444-4444-4444-8444-444444444444";
const CAT_HIDE_ID = "55555555-5555-4555-8555-555555555555";
const SAMPLE_ID = "66666666-6666-4666-8666-666666666666";
const KEY = "77777777-7777-4777-8777-777777777777";
const PAGE_VERSION = "2026-10-20 09:00:00.123456+00";
const CAT_VERSION = "2026-10-20 08:00:00.654321+00";
const PRODUCT_VERSION = "2026-10-19 07:00:00.111111+00";
const SAMPLE_PUBLISHED = "2026-10-18 06:00:00.222222+00";
const STUDIO_URL =
  "https://storage.googleapis.com/b/stores/s/mink-generated/product-photos/shake.webp";
const MERCHANT_URL =
  "https://storage.googleapis.com/b/stores/s/media/shake.jpg";

const actor = {
  storeId: STORE_ID,
  adminId: "admin-1",
  email: "owner@example.com",
  permissions: {},
  isSuperadmin: true,
  draftingEnabled: true,
} as unknown as MinkActorContext;

const section = (id: string, html: string): PageSectionItem =>
  ({
    id,
    type: "rich_text",
    enabled: true,
    config: { ...EMPTY_CONFIG.rich_text, html },
  }) as PageSectionItem;

const CURRENT = [section("a", "<p>Theme words</p>")];
const PROPOSED = [section("b", "<p>Shakes made fresh every morning</p>")];
const ABOUT = [section("c", "<p>Our story starts in a small kitchen</p>")];
const validatedCurrent = (
  validateSections(CURRENT, { mode: "draft" }) as {
    sections: PageSectionItem[];
  }
).sections;
/**
 * What shoppers see on the homepage: an older publish, stored as the Builder
 * saved it then (no `enabled` key), which the section validator fills in.
 */
const LIVE = [
  {
    id: "live",
    type: "rich_text",
    config: { ...EMPTY_CONFIG.rich_text, html: "<p>Live words</p>" },
  },
] as unknown as PageSectionItem[];

const BASE_CHROME: StoreChrome = sanitizeChromeForSave(normalizeChrome(null));
const NEXT_CHROME: StoreChrome = {
  ...BASE_CHROME,
  footer: {
    ...BASE_CHROME.footer,
    newsletter: {
      ...BASE_CHROME.footer.newsletter,
      heading: "Join the shake club",
    },
  },
};
const SETTINGS = {
  brand: { tagline: "Old tagline", blurb: "Old blurb" },
  launched: true,
};

function makePlan(overrides: Partial<RevampStoredPlan> = {}): RevampStoredPlan {
  return {
    schemaVersion: 2,
    revampId: REVAMP_ID,
    kind: "full",
    summary: "A fresh look for a shake bar.",
    pages: [
      {
        pageId: PAGE_ID,
        slug: "",
        title: "Home",
        seoTitle: "Fresh shakes",
        seoDescription: "Shakes made fresh every morning.",
        create: false,
        expectedVersion: PAGE_VERSION,
        expectedDigest: revampSectionsDigest(validatedCurrent),
        sections: PROPOSED,
        proposedDigest: revampSectionsDigest(PROPOSED),
        changes: { added: 1, removed: 1, kept: 0, photos: 0 },
      },
      {
        pageId: null,
        slug: "about",
        title: "About us",
        seoTitle: "About us",
        seoDescription: "How the shake bar began.",
        create: true,
        expectedVersion: null,
        expectedDigest: null,
        sections: ABOUT,
        proposedDigest: revampSectionsDigest(ABOUT),
        changes: { added: 1, removed: 0, kept: 0, photos: 0 },
      },
    ],
    chrome: {
      expectedVersion: null,
      expectedDigest: revampChromeDigest(BASE_CHROME),
      next: NEXT_CHROME,
    },
    brand: {
      expectedDigest: revampBrandDigest(SETTINGS),
      tagline: "Fresh shakes, every morning",
      blurb: null,
    },
    categories: [
      {
        action: "update",
        id: CAT_UPDATE_ID,
        slug: "drinks",
        expectedUpdatedAt: CAT_VERSION,
        before: { name: "Drinks", description: null, imageUrl: null },
        name: "Cold drinks",
        description: "Pressed daily",
        imageUrl: null,
      },
      {
        action: "create",
        slug: "shakes",
        name: "Shakes",
        description: null,
        imageUrl: null,
      },
      {
        action: "hide",
        id: CAT_HIDE_ID,
        slug: "sample-tees",
        expectedUpdatedAt: CAT_VERSION,
        name: "Sample tees",
      },
    ],
    products: {
      hide: [
        {
          id: SAMPLE_ID,
          name: "Tee (Sample)",
          expectedUpdatedAt: PRODUCT_VERSION,
        },
      ],
      create: [
        {
          key: "shake",
          name: "Almond shake",
          slug: "almond-shake",
          description: "Cold-pressed almonds and dates.",
          categorySlug: "shakes",
          imageUrl: STUDIO_URL,
          sourceImageUrl: MERCHANT_URL,
          options: [{ name: "Size", values: ["250 ml", "500 ml"] }],
          variants: [
            { name: "250 ml", optionValues: ["250 ml"], price: 120, mrp: 150 },
            // An MRP below the price is no saving: Apply strikes nothing through.
            { name: "500 ml", optionValues: ["500 ml"], price: 200, mrp: 180 },
          ],
          price: 120,
          mrp: 150,
        },
      ],
    },
    photos: [
      {
        url: STUDIO_URL,
        path: "stores/s/shake.webp",
        alt: "Almond shake",
        where: "Almond shake",
      },
    ],
    checks: [],
    skipped: [],
    notes: [],
    explanation: "Mink AI redesigned your storefront.",
    credits: {
      pages: 0,
      photos: 0,
      design: 0,
      chrome: 0,
      categories: 0,
      productPhotos: 0,
      total: 0,
    },
    free: true,
    ...overrides,
  };
}

function useDraft(plan: RevampStoredPlan) {
  state.draftRow = {
    id: REVAMP_ID,
    kind: "storefront_personalization",
    status: "proposed",
    currentVersion: 0,
    content: {
      plan_json: JSON.stringify(plan),
      plan_digest: digestMinkStorefrontValue(plan),
      explanation: plan.explanation,
    },
  };
}

beforeEach(() => {
  state.pages = new Map([
    [
      PAGE_ID,
      {
        slug: "",
        title: "Home",
        seo_title: "",
        seo_description: "",
        updated_at: PAGE_VERSION,
        sections: CURRENT,
        status: "published",
        published_sections: LIVE,
      },
    ],
  ]);
  state.pageSlugs = new Set(["", "contact"]);
  state.chromeRow = { draft: BASE_CHROME };
  state.settings = structuredClone(SETTINGS);
  state.categories = new Map([
    [
      CAT_UPDATE_ID,
      {
        id: CAT_UPDATE_ID,
        slug: "drinks",
        updated_at: CAT_VERSION,
        status: "active",
        name: "Drinks",
        description: null,
        image_url: null,
      },
    ],
    [
      CAT_HIDE_ID,
      {
        id: CAT_HIDE_ID,
        slug: "sample-tees",
        updated_at: CAT_VERSION,
        status: "active",
        name: "Sample tees",
        description: null,
        image_url: null,
      },
    ],
  ]);
  state.products = new Map([
    [
      SAMPLE_ID,
      {
        id: SAMPLE_ID,
        updated_at: PRODUCT_VERSION,
        status: "published",
        name: "Tee (Sample)",
        published_at: SAMPLE_PUBLISHED,
      },
    ],
  ]);
  state.productSlugs = new Set(["tee-sample"]);
  state.capacity = { allowed: 10, error: "" };
  state.owned = new Set([STUDIO_URL, MERCHANT_URL]);
  state.approvalRow = null;
  state.auditRow = null;
  state.approvalConflict = false;
  state.revampRows = 1;
  state.revampJobs = [{ id: REVAMP_ID, applied_at: null, undone_at: null }];
  state.revampChildren = [];
  state.revampAncestors = new Map();
  state.chromeInsertRace = false;
  state.inserts = [];
  state.updates = [];
  state.events = [];
  state.ids = 0;
  state.emit = vi.fn();
  state.notify = vi.fn(async () => undefined);
  state.after = vi.fn((task: () => unknown) => void task());
  useDraft(makePlan());
});

async function preview() {
  return previewMinkStorefrontPersonalizationAction({
    actor,
    draftId: REVAMP_ID,
    expectedDraftVersion: 0,
    idempotencyKey: KEY,
  });
}

/** Preview, then make the stored approval what execute will read. */
async function approve() {
  const approval = await preview();
  const inserted = state.inserts.find(
    (entry) => entry.table === "mink_action_approvals",
  );
  state.approvalRow = {
    status: "pending",
    resultId: null,
    resultVersion: null,
    approvedAt: null,
    executedAt: null,
    ...inserted?.values,
  };
  state.inserts = [];
  state.updates = [];
  state.events = [];
  return approval;
}

function execute(approvalId: string) {
  return executeMinkStorefrontPersonalizationAction({
    actor,
    draftId: REVAMP_ID,
    approvalId,
  });
}

const storeWrites = () =>
  [...state.inserts, ...state.updates].filter(
    (entry) =>
      !["mink_action_approvals", "mink_action_audit"].includes(entry.table),
  );
const inserted = (table: string) =>
  state.inserts.filter((entry) => entry.table === table).map((e) => e.values);
const updated = (table: string) =>
  state.updates.filter((entry) => entry.table === table).map((e) => e.values);

async function expectRefusal(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MinkRequestError);
  expect((error as MinkRequestError).code).toBe(code);
  return error as MinkRequestError;
}

describe("storefront revamp apply (plan version 2)", () => {
  it("previews against the store as it is and binds the approval to the plan", async () => {
    const approval = await preview();
    expect(approval.status).toBe("pending");
    expect(approval.pages).toEqual([
      { id: PAGE_ID, slug: "", title: "Home" },
      { id: "", slug: "about", title: "About us" },
    ]);
    expect(approval.chromeChanged).toBe(true);
    expect(approval.before.plan_digest).toBe(
      digestMinkStorefrontValue(makePlan()),
    );
    expect(approval.before.page_count).toBe("2");
    // The preview writes nothing to the store.
    expect(storeWrites()).toEqual([]);
  });

  it("★★ locks every target first, then writes every part and records the snapshot", async () => {
    const approval = await approve();
    const result = await execute(approval.id);
    expect(result.repeated).toBe(false);
    expect(result.approval.status).toBe("executed");

    // Every lock before the first store write.
    const firstWrite = state.events.findIndex(
      (event) => event.startsWith("write:") && !event.includes("mink_"),
    );
    const lastLock = state.events.reduce(
      (last, event, index) =>
        event.startsWith("lock:") && !/mink_action|mink_drafts/.test(event)
          ? index
          : last,
      -1,
    );
    expect(firstWrite).toBeGreaterThan(lastLock);
    for (const table of [
      "store_pages",
      "store_chrome",
      "stores",
      "categories",
      "products",
    ]) {
      expect(state.events).toContain(`lock:${table}`);
    }

    // ★★ Pages: only the existing page's Builder draft. Its title and search
    //    text are live the moment they are written, so they wait for Publish.
    expect(updated("store_pages")[0]).toEqual({
      sections: PROPOSED,
      updatedBy: "admin-1",
    });
    expect(inserted("store_pages")[0]).toMatchObject({
      slug: "about",
      status: "draft",
      sections: ABOUT,
      publishedSections: [],
    });
    // Chrome: the whole next draft.
    expect(inserted("store_chrome")[0].draft).toEqual(
      sanitizeChromeForSave(NEXT_CHROME),
    );
    // Brand: the new tagline, the old blurb kept, the rest of settings kept.
    expect(updated("stores")[0].settings).toEqual({
      launched: true,
      brand: { tagline: "Fresh shakes, every morning", blurb: "Old blurb" },
    });
    // Categories: renamed, created and hidden.
    expect(updated("categories")).toEqual([
      expect.objectContaining({
        name: "Cold drinks",
        description: "Pressed daily",
      }),
      expect.objectContaining({ status: "hidden" }),
    ]);
    expect(inserted("categories")[0]).toMatchObject({
      slug: "shakes",
      status: "active",
      sortOrder: 5,
    });
    // Sample product unpublished; the merchant's product published.
    expect(updated("products")[0]).toMatchObject({ status: "draft" });
    const product = inserted("products")[0];
    expect(product).toMatchObject({
      name: "Almond shake",
      slug: "almond-shake",
      status: "published",
      categoryId: "new-categories-2",
      imageUrl: STUDIO_URL,
      images: [STUDIO_URL, MERCHANT_URL],
      basePrice: 150,
      sellingPrice: 120,
      trackInventory: false,
    });
    expect(product.options).toEqual([
      { name: "Size", values: ["250 ml", "500 ml"] },
    ]);
    expect(product).not.toHaveProperty("sku");
    expect(inserted("product_variants")[0]).toEqual([
      expect.objectContaining({
        name: "250 ml",
        optionValues: ["250 ml"],
        sellingPrice: 120,
        basePrice: 150,
        trackInventory: false,
      }),
      expect.objectContaining({
        name: "500 ml",
        sellingPrice: 200,
        basePrice: 200,
        trackInventory: false,
      }),
    ]);

    // The snapshot Undo needs, on the revamp's own job.
    const job = updated("mink_revamps")[0];
    const snapshot = job.applySnapshot as RevampApplySnapshot;
    expect(job.appliedAt).toBe(snapshot.appliedAt);
    expect(snapshot.version).toBe(1);
    expect(snapshot.pages).toEqual([
      {
        pageId: PAGE_ID,
        slug: "",
        created: false,
        before: {
          title: "Home",
          seoTitle: "",
          seoDescription: "",
          sections: CURRENT,
        },
        afterUpdatedAt: NOW,
        afterDigest: revampSectionsDigest(PROPOSED),
        proposed: {
          title: "Home",
          seoTitle: "Fresh shakes",
          seoDescription: "Shakes made fresh every morning.",
        },
        live: {
          status: "published",
          publishedDigest: revampSectionsDigest(LIVE),
        },
      },
      expect.objectContaining({
        slug: "about",
        created: true,
        before: null,
        proposed: null,
      }),
    ]);
    expect(snapshot.pages[1]).not.toHaveProperty("live");
    // A new page is a draft page: it is inserted with its own title.
    expect(inserted("store_pages")[0]).toMatchObject({
      title: "About us",
      seoTitle: "About us",
      seoDescription: "How the shake bar began.",
    });
    expect(snapshot.chrome).toEqual({
      rowExisted: true,
      before: BASE_CHROME,
      afterDigest: revampChromeDigest(sanitizeChromeForSave(NEXT_CHROME)),
    });
    expect(snapshot.brand).toEqual({
      before: { tagline: "Old tagline", blurb: "Old blurb" },
      after: { tagline: "Fresh shakes, every morning", blurb: "Old blurb" },
    });
    expect(snapshot.categories.map((entry) => entry.action)).toEqual([
      "update",
      "create",
      "hide",
    ]);
    expect(snapshot.categories[0].before).toEqual({
      name: "Drinks",
      description: null,
      imageUrl: null,
      status: "active",
    });
    expect(snapshot.products).toEqual({
      hidden: [
        {
          id: SAMPLE_ID,
          statusBefore: "published",
          afterUpdatedAt: NOW,
          publishedAtBefore: SAMPLE_PUBLISHED,
        },
      ],
      created: [
        { id: "new-products-3", slug: "almond-shake", afterUpdatedAt: NOW },
      ],
    });

    // One approval finalised, one audit row, one event per new product.
    expect(updated("mink_action_approvals")[0]).toMatchObject({
      status: "executed",
    });
    const audit = inserted("mink_action_audit")[0];
    expect(audit).toMatchObject({ outcome: "executed" });
    expect(audit.detail).toContain("storefront redesign applied");
    expect(audit.detail).not.toMatch(/—/);
    expect(state.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "product.created",
        subject: expect.objectContaining({ label: "Almond shake" }),
      }),
    );
    // ★ And offered to search engines once committed, as the product editor
    //   offers a product it publishes.
    expect(state.notify).toHaveBeenCalledWith({
      storeId: STORE_ID,
      paths: ["/shop/almond-shake", "/shop", "/"],
    });
    expect(snapshot.notes).toBeUndefined();
  });

  it("★★ records what is live on each page it changes, exactly as Undo and Publish read it", async () => {
    // Apply never publishes, so what it reads under the lock is what is live
    // after it. Undo before any Publish compares the page with this rather
    // than with the page clock, which a title or search text edit moves too.
    const approval = await approve();
    await execute(approval.id);
    const written = updated("mink_revamps")[0]
      .applySnapshot as RevampApplySnapshot;
    const [home, about] = written.pages;
    expect(home.live).toEqual({
      status: "published",
      publishedDigest: revampSectionsDigest(LIVE),
    });
    // ★ Over the stored list as it is: the validated copy (which gains
    //   `enabled`) differs from the row Undo digests.
    const validatedLive = (
      validateSections(LIVE, { mode: "draft" }) as {
        sections: PageSectionItem[];
      }
    ).sections;
    expect(revampSectionsDigest(validatedLive)).not.toBe(
      home.live?.publishedDigest,
    );
    // A page the redesign creates has no live version to record.
    expect(about).not.toHaveProperty("live");
    // ★★ The strict reader Undo and Publish use takes it as written: a `live`
    //    it could not read would refuse the whole Undo.
    const read = readApplySnapshot(JSON.parse(JSON.stringify(written)));
    expect(read?.pages[0].live).toEqual(home.live);
    expect(read?.pages[1]).not.toHaveProperty("live");
  });

  it("★ records an empty live list when the stored one is not a list, as Undo reads it", async () => {
    state.pages.get(PAGE_ID).status = "draft";
    state.pages.get(PAGE_ID).published_sections = {};
    const approval = await approve();
    await execute(approval.id);
    const written = updated("mink_revamps")[0]
      .applySnapshot as RevampApplySnapshot;
    expect(written.pages[0].live).toEqual({
      status: "draft",
      publishedDigest: revampSectionsDigest([]),
    });
  });

  it("★★ marks the merchant's products featured, so the plan's featured band shows them", async () => {
    // The compiler gives every featured_products section source "featured",
    // and the preview's After frame shows these products there; an
    // unfeatured insert leaves that band empty (or showing other products)
    // once the page is published.
    const approval = await approve();
    await execute(approval.id);
    expect(inserted("products")).toEqual([
      expect.objectContaining({ slug: "almond-shake", featured: true }),
    ]);
  });

  it("★ files a new product without a category the store does not have, and says so", async () => {
    const plan = makePlan();
    plan.products.create[0].categorySlug = "whole-spices";
    useDraft(plan);
    const approval = await approve();
    const result = await execute(approval.id);
    expect(result.approval.status).toBe("executed");
    expect(inserted("products")[0]).toMatchObject({
      slug: "almond-shake",
      status: "published",
      categoryId: null,
    });
    const snapshot = updated("mink_revamps")[0]
      .applySnapshot as RevampApplySnapshot;
    expect(snapshot.notes).toEqual([
      'Almond shake went on your shop without a category, because your store has no "whole-spices" category.',
    ]);
    expect(snapshot.notes!.join(" ")).not.toMatch(/[\u2013\u2014]/);
  });

  it("★★ writes the header and footer over the store's own menus when it has no chrome row", async () => {
    state.chromeRow = null;
    const approval = await approve();
    await execute(approval.id);
    expect(state.events).toContain("lock:store_chrome");
    expect(inserted("store_chrome")[0].draft).toEqual(
      sanitizeChromeForSave(NEXT_CHROME),
    );
    const snapshot = updated("mink_revamps")[0]
      .applySnapshot as RevampApplySnapshot;
    expect(snapshot.chrome).toMatchObject({ rowExisted: false, before: null });
  });

  it("★★ rolls back when a first header and footer draft was saved after its lock read", async () => {
    // With no chrome row there is nothing to lock (READ COMMITTED has no
    // predicate lock), so the Builder's autosave can insert the store's first
    // draft while Apply works. Overwriting it would lose an edit the snapshot
    // never saw, and Undo would delete the row.
    state.chromeRow = null;
    state.chromeInsertRace = true;
    const approval = await approve();
    const error = await expectRefusal(
      execute(approval.id),
      "mink_personalization_target_conflict",
    );
    expect(error.message).toBe(REVAMP_CONFLICT_MESSAGE);
    // Nothing was finalised: the transaction rolls back as a whole.
    expect(updated("mink_action_approvals")).toEqual([]);
    expect(updated("mink_revamps")).toEqual([]);
    expect(state.emit).not.toHaveBeenCalled();
  });

  it("applies even when the revamp's job is gone, and only costs Undo", async () => {
    state.revampJobs = [];
    state.revampRows = 0;
    const approval = await approve();
    const result = await execute(approval.id);
    expect(result.approval.status).toBe("executed");
    expect(updated("mink_revamps")).toHaveLength(1);
  });

  it("★★ locks the revamp's job before any store row, the order Publish and Undo take", async () => {
    // Publish and Undo lock the job first and then the pages; Apply taking
    // the pages first could leave two of them waiting on each other.
    const approval = await approve();
    await execute(approval.id);
    const job = state.events.indexOf("lock:mink_revamps");
    expect(job).toBeGreaterThanOrEqual(0);
    expect(job).toBeLessThan(state.events.indexOf("lock:store_pages"));
  });

  it("★★ refuses a redesign that is already in the Builder draft, at preview and at execute", async () => {
    state.revampJobs = [{ id: REVAMP_ID, applied_at: NOW, undone_at: null }];
    const early = await expectRefusal(preview(), "mink_revamp_already_applied");
    expect(early.message).toBe(
      "This redesign is already in your Website Builder draft.",
    );
    expect(inserted("mink_action_approvals")).toEqual([]);

    // An approval made before the first Apply landed (a second tab, or a
    // replayed request with a new key) is refused too, writing nothing.
    state.revampJobs = [{ id: REVAMP_ID, applied_at: null, undone_at: null }];
    const approval = await approve();
    state.revampJobs = [{ id: REVAMP_ID, applied_at: NOW, undone_at: null }];
    const late = await expectRefusal(
      execute(approval.id),
      "mink_revamp_already_applied",
    );
    expect(late.message).toBe(early.message);
    expect(storeWrites()).toEqual([]);
    expect(updated("mink_revamps")).toEqual([]);
    expect(updated("mink_action_approvals")[0]).toMatchObject({
      status: "conflicted",
    });
    expect(inserted("mink_action_audit")[0]).toMatchObject({
      outcome: "conflicted",
    });
    expect(state.emit).not.toHaveBeenCalled();
  });

  it("★★ refuses a redesign that was undone, at preview and at execute", async () => {
    state.revampJobs = [{ id: REVAMP_ID, applied_at: NOW, undone_at: NOW }];
    const early = await expectRefusal(preview(), "mink_revamp_undone");
    expect(early.message).toBe(
      "This redesign was undone. Ask Mink to make it again.",
    );
    expect(inserted("mink_action_approvals")).toEqual([]);

    state.revampJobs = [{ id: REVAMP_ID, applied_at: null, undone_at: null }];
    const approval = await approve();
    state.revampJobs = [{ id: REVAMP_ID, applied_at: NOW, undone_at: NOW }];
    await expectRefusal(execute(approval.id), "mink_revamp_undone");
    expect(storeWrites()).toEqual([]);
    expect(updated("mink_revamps")).toEqual([]);
  });

  describe("★★ a redesign with more than one version (chat-1)", () => {
    const PARENT_ID = "77777777-7777-4777-8777-777777777777";
    const CHILD_ID = "88888888-8888-4888-8888-888888888888";
    const shake = { key: "p1", name: "Almond shake" };
    const shakes = {
      action: "create",
      name: "Shakes",
      slug: "shakes",
      description: null,
      newPhoto: false,
    };
    /** This card is a refinement; its own request carries `carried`. */
    const refinement = (carried: boolean) => {
      state.revampJobs = [
        {
          id: REVAMP_ID,
          applied_at: null,
          undone_at: null,
          parent_id: PARENT_ID,
          request: {
            kind: "refine",
            products: carried ? [shake] : [],
            categories: carried ? [shakes] : [],
          },
        },
      ];
    };
    /** The version it builds on: the full redesign, asking for the shake. */
    const parent = (appliedAt: string | null, undoneAt: string | null) => {
      state.revampAncestors.set(PARENT_ID, {
        id: PARENT_ID,
        parent_id: null,
        applied_at: appliedAt,
        undone_at: undoneAt,
        request: { kind: "full", products: [shake], categories: [shakes] },
      });
    };

    it("★★ refuses while a newer version of this redesign is being made, at preview and at execute", async () => {
      // Applying this card would put its products on the store while the
      // refinement being made carries them too: its Apply would then refuse.
      state.revampChildren = [{ id: CHILD_ID }];
      const early = await expectRefusal(
        preview(),
        "mink_revamp_refinement_building",
      );
      expect(early.message).toBe(
        "A newer version of this redesign is being made. Apply it when its card is ready, or stop it on its card first.",
      );
      expect(inserted("mink_action_approvals")).toEqual([]);

      state.revampChildren = [];
      const approval = await approve();
      state.revampChildren = [{ id: CHILD_ID }];
      await expectRefusal(
        execute(approval.id),
        "mink_revamp_refinement_building",
      );
      expect(storeWrites()).toEqual([]);
      expect(updated("mink_revamps")).toEqual([]);
    });

    it("★★ refuses a refinement whose earlier version was applied after it was asked for", async () => {
      // It carries the shake and the category because the earlier version was
      // not applied then; applied since, both are on the store already.
      refinement(true);
      parent(NOW, null);
      const early = await expectRefusal(
        preview(),
        "mink_revamp_parent_applied",
      );
      expect(early.message).toBe(
        "An earlier version of this redesign was applied after you asked for these changes. Ask Mink to make them again.",
      );
      expect(inserted("mink_action_approvals")).toEqual([]);

      parent(null, null);
      const approval = await approve();
      parent(NOW, null);
      await expectRefusal(execute(approval.id), "mink_revamp_parent_applied");
      expect(storeWrites()).toEqual([]);
      expect(updated("mink_action_approvals")[0]).toMatchObject({
        status: "conflicted",
      });
    });

    it("★★ refuses a refinement whose earlier version was undone after it was asked for", async () => {
      // It carries nothing of the earlier version's, which was on the store
      // then; undone since, the shake and its category are gone, and this
      // card would leave them gone while its pages still point at them.
      refinement(false);
      parent(NOW, NOW);
      const error = await expectRefusal(preview(), "mink_revamp_parent_undone");
      expect(error.message).toBe(
        "An earlier version of this redesign was undone after you asked for these changes. Ask Mink to make them again.",
      );
    });

    it("applies a refinement that still fits its earlier versions, locking them after its own job", async () => {
      refinement(false);
      parent(NOW, null);
      const approval = await approve();
      const result = await execute(approval.id);
      expect(result.approval.status).toBe("executed");
      const locks = state.events.filter(
        (event) => event === "lock:mink_revamps",
      );
      expect(locks).toHaveLength(2);
      expect(state.events.lastIndexOf("lock:mink_revamps")).toBeLessThan(
        state.events.indexOf("lock:store_pages"),
      );

      refinement(true);
      parent(null, null);
      expect((await preview()).status).toBe("pending");
    });
  });

  it("★ never finishes an Apply whose locked job it cannot record on", async () => {
    // The job was found and locked, yet the record matched nothing: the
    // write must roll back rather than leave a store change Undo cannot see.
    state.revampRows = 0;
    const approval = await approve();
    await expectRefusal(
      execute(approval.id),
      "mink_personalization_target_conflict",
    );
    expect(updated("mink_action_approvals")).toEqual([]);
    expect(inserted("mink_action_audit")).toEqual([]);
    expect(state.emit).not.toHaveBeenCalled();
  });

  const moves: Array<[string, () => void, string]> = [
    [
      "a page's version",
      () => {
        state.pages.get(PAGE_ID).updated_at = "2026-10-21 09:00:00.1+00";
      },
      "pages",
    ],
    [
      "a page's sections",
      () => {
        state.pages.get(PAGE_ID).sections = [section("z", "<p>Edited</p>")];
      },
      "pages",
    ],
    [
      "a new page's address",
      () => {
        state.pageSlugs.add("about");
      },
      "pages",
    ],
    [
      "the header and footer",
      () => {
        state.chromeRow = {
          draft: {
            ...BASE_CHROME,
            footer: {
              ...BASE_CHROME.footer,
              newsletter: { ...BASE_CHROME.footer.newsletter, heading: "Mine" },
            },
          },
        };
      },
      "header and footer",
    ],
    [
      "the store's tagline",
      () => {
        state.settings = {
          ...SETTINGS,
          brand: { tagline: "Edited", blurb: "Old blurb" },
        };
      },
      "store description",
    ],
    [
      "a category",
      () => {
        state.categories.get(CAT_UPDATE_ID).name = "Juices";
      },
      "categories",
    ],
    [
      "a new category's address",
      () => {
        state.categories.set("x", {
          id: "x",
          slug: "shakes",
          updated_at: NOW,
          status: "active",
          name: "Shakes",
        });
      },
      "categories",
    ],
    [
      "a sample product",
      () => {
        state.products.get(SAMPLE_ID).status = "draft";
      },
      "products",
    ],
    [
      "a new product's address",
      () => {
        state.productSlugs.add("almond-shake");
      },
      "products",
    ],
  ];

  it.each(moves)(
    "★★ refuses the whole plan when %s moved after the preview, writing nothing",
    async (_label, move, part) => {
      const approval = await approve();
      move();
      const error = await expectRefusal(
        execute(approval.id),
        "mink_personalization_target_conflict",
      );
      expect(error.message).toBe(REVAMP_CONFLICT_MESSAGE);
      expect(storeWrites()).toEqual([]);
      expect(updated("mink_action_approvals")[0]).toMatchObject({
        status: "conflicted",
      });
      const audit = inserted("mink_action_audit")[0];
      expect(audit).toMatchObject({ outcome: "conflicted" });
      expect(audit.detail).toContain(part);
      expect(state.emit).not.toHaveBeenCalled();
      expect(state.notify).not.toHaveBeenCalled();
    },
  );

  it("refuses a preview once the store already moved, before any approval exists", async () => {
    state.pages.get(PAGE_ID).updated_at = "2026-10-21 09:00:00.1+00";
    const error = await expectRefusal(
      preview(),
      "mink_personalization_target_conflict",
    );
    expect(error.message).toBe(REVAMP_CONFLICT_MESSAGE);
    expect(inserted("mink_action_approvals")).toEqual([]);
  });

  it("refuses when a new photo is no longer one the store owns", async () => {
    const approval = await approve();
    state.owned = new Set([MERCHANT_URL]);
    await expectRefusal(
      execute(approval.id),
      "mink_personalization_target_conflict",
    );
    expect(storeWrites()).toEqual([]);
    expect(inserted("mink_action_audit")[0].detail).toContain("product photo");
  });

  it("★ refuses new products past the plan's product cap, at preview and at execute", async () => {
    const capError =
      "Free includes up to 5 products. Upgrade to add another product; your existing products remain safe.";
    state.capacity = { allowed: 0, error: capError };
    const early = await expectRefusal(preview(), "mink_revamp_product_cap");
    expect(early.message).toBe(capError);
    expect(inserted("mink_action_approvals")).toEqual([]);

    state.capacity = { allowed: 10, error: capError };
    const approval = await approve();
    state.capacity = { allowed: 0, error: capError };
    const late = await expectRefusal(
      execute(approval.id),
      "mink_revamp_product_cap",
    );
    expect(late.message).toBe(capError);
    expect(storeWrites()).toEqual([]);
    expect(updated("mink_action_approvals")[0]).toMatchObject({
      status: "conflicted",
    });
  });

  it("replays an executed approval without writing again", async () => {
    const approval = await approve();
    const first = await execute(approval.id);
    state.approvalRow = {
      ...state.approvalRow,
      status: "executed",
      approvedAt: first.approval.executedAt,
      executedAt: first.approval.executedAt,
      resultId: STORE_ID,
      resultVersion: first.approval.executedAt,
    };
    state.auditRow = { id: "audit-1" };
    // ★ The job is applied now; the replay still answers, it is not refused.
    state.revampJobs = [
      { id: REVAMP_ID, applied_at: first.approval.executedAt, undone_at: null },
    ];
    state.inserts = [];
    state.updates = [];
    state.emit = vi.fn();
    state.notify = vi.fn(async () => undefined);
    const again = await execute(approval.id);
    expect(again.repeated).toBe(true);
    expect(again.auditId).toBe("audit-1");
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(state.emit).not.toHaveBeenCalled();
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("returns the same approval for a repeated preview key", async () => {
    const first = await approve();
    state.approvalConflict = true;
    const again = await preview();
    expect(again.id).toBe(first.id);
  });

  it("needs Categories and Products manage for the parts outside the Builder", async () => {
    const limited = {
      ...actor,
      isSuperadmin: false,
      permissions: { builder: ["manage"], categories: ["manage"] },
    } as unknown as MinkActorContext;
    const run = () =>
      previewMinkStorefrontPersonalizationAction({
        actor: limited,
        draftId: REVAMP_ID,
        expectedDraftVersion: 0,
        idempotencyKey: KEY,
      });
    const error = await expectRefusal(
      run(),
      "mink_personalization_access_denied",
    );
    expect(error.message).toContain("Products manage");
    (limited.permissions as Record<string, string[]>).categories = [];
    (limited.permissions as Record<string, string[]>).products = ["manage"];
    const other = await expectRefusal(
      run(),
      "mink_personalization_access_denied",
    );
    expect(other.message).toContain("Categories manage");
  });

  it("★★ needs Branding manage to change the store's tagline or footer description", async () => {
    // Everywhere else those two fields are saved only by saveStoreBranding,
    // behind Branding manage; Apply writes them to the live store at once.
    const noBranding = {
      ...actor,
      isSuperadmin: false,
      permissions: {
        builder: ["manage"],
        categories: ["manage"],
        products: ["manage"],
      },
    } as unknown as MinkActorContext;
    const previewAs = (who: MinkActorContext) =>
      previewMinkStorefrontPersonalizationAction({
        actor: who,
        draftId: REVAMP_ID,
        expectedDraftVersion: 0,
        idempotencyKey: KEY,
      });
    const early = await expectRefusal(
      previewAs(noBranding),
      "mink_personalization_access_denied",
    );
    expect(early.message).toContain("Branding manage");
    expect(early.message).not.toMatch(/[\u2013\u2014]/);
    expect(inserted("mink_action_approvals")).toEqual([]);

    // An approval made by someone who could, executed after the grant went.
    const approval = await approve();
    const late = await expectRefusal(
      executeMinkStorefrontPersonalizationAction({
        actor: noBranding,
        draftId: REVAMP_ID,
        approvalId: approval.id,
      }),
      "mink_personalization_access_denied",
    );
    expect(late.message).toContain("Branding manage");
    expect(storeWrites()).toEqual([]);

    // A redesign that leaves the tagline and description alone needs none.
    useDraft(makePlan({ brand: null }));
    state.approvalRow = null;
    state.inserts = [];
    await expect(previewAs(noBranding)).resolves.toMatchObject({
      status: "pending",
    });
  });
});

describe("★★ the photos a card puts on the store join the Media Library at Apply (ops-1)", () => {
  const folder = `stores/${STORE_ID}/mink-generated/revamp`;
  const SLOT_URL = `https://storage.googleapis.com/b/${folder}/${REVAMP_ID}/slot-hero-1-aaaaaaaa.webp`;
  const CATEGORY_URL = `https://storage.googleapis.com/b/${folder}/${REVAMP_ID}/slot-category-shakes-bbbbbbbb.webp`;

  it("reveals exactly this store's hidden revamp photos the card shows", async () => {
    const base = makePlan();
    useDraft(
      makePlan({
        photos: [
          {
            url: SLOT_URL,
            path: `${folder}/${REVAMP_ID}/slot-hero-1-aaaaaaaa.webp`,
            alt: "Shakes on a counter",
            where: "Home, opening photo",
          },
        ],
        categories: base.categories.map((change) =>
          change.action === "create"
            ? { ...change, imageUrl: CATEGORY_URL }
            : change,
        ),
      }),
    );
    state.owned.add(CATEGORY_URL);
    const approval = await approve();
    await execute(approval.id);
    const reveal = state.updates.filter((u) => u.table === "media_assets");
    expect(reveal).toHaveLength(1);
    expect(reveal[0].values).toEqual({ source: "mink_generated" });
    const params = sqlParamValues((reveal[0] as { where?: unknown }).where);
    // ★ Only rows still hidden, only this store's revamp objects.
    expect(params).toEqual(
      expect.arrayContaining([
        STORE_ID,
        "mink_prepared",
        `${folder}/%`,
        SLOT_URL,
        CATEGORY_URL,
        STUDIO_URL,
      ]),
    );
    // The merchant's own photo is theirs already, never touched here.
    expect(params).not.toContain(MERCHANT_URL);
  });

  it("writes nothing to the Media Library for a card with no new photo", async () => {
    const base = makePlan();
    useDraft(
      makePlan({
        photos: [],
        products: {
          hide: base.products.hide,
          create: base.products.create.map((product) => ({
            ...product,
            imageUrl: null,
          })),
        },
      }),
    );
    const approval = await approve();
    await execute(approval.id);
    expect(updated("media_assets")).toEqual([]);
  });
});

describe("reading a stored revamp plan", () => {
  const raw = (plan: unknown) => JSON.stringify(plan);

  it("accepts a whole plan", () => {
    expect(readRevampStoredPlan(raw(makePlan())).revampId).toBe(REVAMP_ID);
  });

  it("refuses a page that no longer matches its digest", () => {
    const plan = makePlan();
    plan.pages[0].proposedDigest = "0".repeat(64);
    expect(() => readRevampStoredPlan(raw(plan))).toThrow(/digest/);
  });

  it("refuses a new page with an address the store cannot use", () => {
    const plan = makePlan();
    plan.pages[1].slug = "Not A Slug!";
    expect(() => readRevampStoredPlan(raw(plan))).toThrow(/address/);
  });

  it("refuses sizes that do not resolve into variants", () => {
    const plan = makePlan();
    plan.products.create[0].variants[1].optionValues = ["250 ml"];
    expect(() => readRevampStoredPlan(raw(plan))).toThrow(/sizes/);
  });

  it("refuses a price that is not a real amount", () => {
    const plan = makePlan();
    plan.products.create[0].price = 0;
    expect(() => readRevampStoredPlan(raw(plan))).toThrow(/not readable/);
    const other = makePlan();
    other.products.create[0].variants[0].price = -5;
    expect(() => readRevampStoredPlan(raw(other))).toThrow(/not readable/);
  });

  it("refuses a version 1 plan", () => {
    expect(() =>
      readRevampStoredPlan(raw({ ...makePlan(), schemaVersion: 1 })),
    ).toThrow(/not readable/);
  });
});

describe("the version 1 personalisation on the same Apply", () => {
  function useV1Draft(parts: Partial<PersonalizationStoredPlan>) {
    const plan: PersonalizationStoredPlan = {
      schemaVersion: 1,
      pages: [],
      chrome: null,
      brand: null,
      categories: [],
      products: [],
      photos: [],
      skipped: [],
      explanation: "Mink AI personalised your storefront.",
      credits: {
        pages: 0,
        photos: 0,
        design: 0,
        chrome: 0,
        categories: 0,
        total: 0,
      },
      ...parts,
    };
    state.draftRow = {
      id: REVAMP_ID,
      kind: "storefront_personalization",
      status: "proposed",
      currentVersion: 0,
      content: {
        plan_json: JSON.stringify(plan),
        plan_digest: digestMinkStorefrontValue(plan),
        explanation: plan.explanation,
      },
    };
  }

  it("★★ needs Branding manage to change the tagline or footer description too", async () => {
    const builderOnly = {
      ...actor,
      isSuperadmin: false,
      permissions: { builder: ["manage"] },
    } as unknown as MinkActorContext;
    const previewAs = () =>
      previewMinkStorefrontPersonalizationAction({
        actor: builderOnly,
        draftId: REVAMP_ID,
        expectedDraftVersion: 0,
        idempotencyKey: KEY,
      });
    useV1Draft({
      brand: {
        expectedDigest: revampBrandDigest(SETTINGS),
        tagline: "Fresh shakes, every morning",
        blurb: null,
      },
    });
    const error = await expectRefusal(
      previewAs(),
      "mink_personalization_access_denied",
    );
    expect(error.message).toContain("Branding manage");
    expect(inserted("mink_action_approvals")).toEqual([]);

    useV1Draft({ brand: null });
    await expect(previewAs()).resolves.toMatchObject({ status: "pending" });
  });

  it("★★ rolls back when a first header and footer draft was saved after its lock read", async () => {
    // The same gap as version 2: with no chrome row nothing is locked, and
    // updating the row the Builder inserted meanwhile would lose that edit.
    state.chromeRow = null;
    state.chromeInsertRace = true;
    useV1Draft({
      chrome: {
        expectedTextDigest: chromeTextDigest(BASE_CHROME),
        expectedDesignDigest: digestMinkStorefrontDesign(
          BASE_CHROME.design ?? EMPTY_DESIGN_OVERRIDES,
        ),
        design: null,
        announcementText: "Fresh shakes every morning",
        newsletter: null,
      },
    });
    const approval = await approve();
    await expectRefusal(
      execute(approval.id),
      "mink_personalization_target_conflict",
    );
    expect(updated("mink_action_approvals")).toEqual([]);

    // Without the race the first draft is written as before.
    state.chromeInsertRace = false;
    state.approvalRow = null;
    const fresh = await approve();
    await expect(execute(fresh.id)).resolves.toMatchObject({
      repeated: false,
    });
    expect(inserted("store_chrome")[0].draft.header.announcement.text).toBe(
      "Fresh shakes every morning",
    );
  });
});
