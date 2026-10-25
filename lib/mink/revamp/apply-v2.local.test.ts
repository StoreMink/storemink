/** A storefront revamp's Apply against the real local database: the real
 * personalisation actions over a store, a ready revamp job and its card's
 * draft, with every `withService` its own committed transaction.
 *
 * Run with MINK_REVAMP_LOCAL_TEST=1. The fixed loopback database keeps it
 * away from Cloud SQL, and every store it makes is deleted in `afterAll`.
 *
 * ★ REAL TRANSACTIONS, NOT ONE ROLLED BACK (e2e.local.test.ts's reason): a
 *   first header and footer draft saved by the Builder while Apply works is
 *   a race between two connections, and only the database's own READ
 *   COMMITTED behaviour can show what Apply then does to it.
 * ★ ONLY THE OUTSIDE WORLD IS FAKED: notifications, the search-engine hook
 *   and Next's cache and `after()`. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import type { StoreChrome } from "@/lib/chrome/types";
import type { PageSectionItem } from "@/lib/sections/registry";
import type { MinkActorContext } from "../types";
import type { RevampStoredPlan } from "./contract";
import type { RevampApplySnapshot } from "./lifecycle-types";

const harness = vi.hoisted(() => {
  // ★ Set before any module reads them: the real database client builds its
  //   pool from these on first use.
  if (process.env.MINK_REVAMP_LOCAL_TEST === "1") {
    process.env.DB_HOST = "127.0.0.1";
    process.env.DB_PORT = "5544";
    process.env.DB_NAME = "storemink_local";
    process.env.DB_USER = process.env.USER ?? "postgres";
    process.env.DB_POOL_MAX = "4";
    delete process.env.DB_PASSWORD;
  }
  return {
    /** Runs once, right after Apply has read the store's menus. */
    afterMenusRead: null as null | (() => Promise<void>),
  };
});

vi.mock("@/lib/notifications/record", () => ({
  emitEvent: vi.fn(),
  recordEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: vi.fn(async () => undefined),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: vi.fn(),
}));
vi.mock("../storefront-personalization-context", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../storefront-personalization-context")
    >();
  return {
    ...real,
    // ★ The seam a concurrent Builder save lands in: Apply has read the
    //   store's menus because it found no chrome row to lock.
    async readMenusAsChrome(
      ...args: Parameters<typeof real.readMenusAsChrome>
    ) {
      const chrome = await real.readMenusAsChrome(...args);
      const hook = harness.afterMenusRead;
      harness.afterMenusRead = null;
      if (hook) await hook();
      return chrome;
    },
  };
});

const OWNER = "revamp-apply-owner";

function section(id: string, text: string): PageSectionItem {
  return {
    id,
    type: "rich_text",
    enabled: true,
    config: { html: `<p>${text}</p>`, width: "contained" },
  } as PageSectionItem;
}

const enabled = process.env.MINK_REVAMP_LOCAL_TEST === "1";
describe.skipIf(!enabled)("storefront revamp Apply on local Postgres", () => {
  let client: Client;
  let closePool: () => Promise<void>;
  let actions: typeof import("../storefront-personalization-actions");
  let applyV2: typeof import("./apply-v2");
  let lifecycle: typeof import("./publish");
  let digests: typeof import("./digests");
  let chromeTypes: typeof import("@/lib/chrome/types");
  let codeContract: typeof import("../storefront-code-contract");
  let registry: typeof import("@/lib/sections/registry");
  const stores: string[] = [];

  async function rows<T>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await client.query(text, params)).rows as T[];
  }

  async function one<T>(text: string, params: unknown[] = []): Promise<T> {
    const [row] = await rows<T>(text, params);
    return row;
  }

  /**
   * A store with a ready revamp job and the card's draft holding `plan`.
   * `build` runs once the store exists, so it can seed rows the plan names.
   */
  async function fixture(
    build: (
      revampId: string,
      storeId: string,
    ) => RevampStoredPlan | Promise<RevampStoredPlan>,
  ): Promise<{ actor: MinkActorContext; revampId: string }> {
    const storeId = crypto.randomUUID();
    stores.push(storeId);
    await client.query(
      `insert into stores(id, slug, name, status, plan, settings)
       values ($1, $2, 'Shake Bar', 'active', 'pro', $3)`,
      [
        storeId,
        `revamp-apply-${storeId.slice(0, 8)}`,
        { launched: true, brand: { name: "Shake Bar" } },
      ],
    );
    const adminId = `${OWNER}-${storeId.slice(0, 8)}`;
    const conversationId = crypto.randomUUID();
    await client.query(
      `insert into mink_conversations(id, store_id, admin_id, title)
       values ($1, $2, $3, 'Customise my store')`,
      [conversationId, storeId, adminId],
    );
    const runId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    await client.query(
      `insert into mink_runs(id, store_id, conversation_id, requested_by, request_id, model)
       values ($1, $2, $3, $4, $5, 'fixture')`,
      [runId, storeId, conversationId, adminId, requestId],
    );
    const revampId = crypto.randomUUID();
    const plan = await build(revampId, storeId);
    // The card's draft: its id is the revamp's id, free, as card.ts writes it.
    await client.query(
      `insert into mink_drafts(id, store_id, admin_id, run_id, kind, destination_type,
         destination_label, destination_path, title, content_json,
         expected_credits, charged_credits, credit_source)
       values ($1, $2, $3, $4, 'storefront_personalization', 'storefront',
         'Whole storefront', '/dashboard/builder', 'Your store redesign', $5,
         0, 0, 'free')`,
      [
        revampId,
        storeId,
        adminId,
        runId,
        {
          plan_json: JSON.stringify(plan),
          plan_digest: codeContract.digestMinkStorefrontValue(plan),
          explanation: plan.explanation,
        },
      ],
    );
    await client.query(
      `insert into mink_revamps(id, store_id, admin_id, conversation_id, origin_run_id,
         kind, status, step, request, draft_id, free)
       values ($1, $2, $3, $4, $5, 'full', 'ready', 'card', '{}'::jsonb, $1, true)`,
      [revampId, storeId, adminId, conversationId, runId],
    );
    return {
      revampId,
      actor: {
        storeId,
        adminId,
        email: "owner@shake.example",
        roleSlug: "superadmin",
        permissions: {},
        isSuperadmin: true,
        effectivePlan: "pro",
        locationIds: null,
        analyticsTimeZone: "Asia/Kolkata",
        currency: "INR",
        defaultLowStockThreshold: 5,
        requestId,
        runId,
        draftingEnabled: true,
      },
    };
  }

  function plan(
    revampId: string,
    overrides: Partial<RevampStoredPlan> = {},
  ): RevampStoredPlan {
    return {
      schemaVersion: 2,
      revampId,
      kind: "full",
      summary: "A fresh look for a shake bar.",
      pages: [],
      chrome: null,
      brand: null,
      categories: [
        {
          action: "create",
          slug: "shakes",
          name: "Shakes",
          description: null,
          imageUrl: null,
        },
      ],
      products: {
        hide: [],
        create: [
          {
            key: "shake",
            name: "Almond shake",
            slug: "almond-shake",
            description: "Cold-pressed almonds and dates.",
            categorySlug: "shakes",
            imageUrl: null,
            sourceImageUrl: null,
            options: [{ name: "Size", values: ["250 ml", "500 ml"] }],
            variants: [
              {
                name: "250 ml",
                optionValues: ["250 ml"],
                price: 120,
                mrp: 150,
              },
              {
                name: "500 ml",
                optionValues: ["500 ml"],
                price: 200,
                mrp: null,
              },
            ],
            price: 120,
            mrp: 150,
          },
        ],
      },
      photos: [],
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

  async function preview(actor: MinkActorContext, revampId: string) {
    return actions.previewMinkStorefrontPersonalizationAction({
      actor,
      draftId: revampId,
      expectedDraftVersion: 0,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  async function job(revampId: string) {
    return one<{
      applied_at: string | null;
      undone_at: string | null;
      apply_snapshot: RevampApplySnapshot | null;
    }>(
      "select applied_at, undone_at, apply_snapshot from mink_revamps where id = $1",
      [revampId],
    );
  }

  beforeAll(async () => {
    const pg = await import("pg");
    const { postgresStringTimestampTypes } = await import("@/lib/db/pg-types");
    client = new pg.Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: process.env.USER,
      types: postgresStringTimestampTypes,
    });
    await client.connect();
    actions = await import("../storefront-personalization-actions");
    applyV2 = await import("./apply-v2");
    lifecycle = await import("./publish");
    digests = await import("./digests");
    chromeTypes = await import("@/lib/chrome/types");
    codeContract = await import("../storefront-code-contract");
    registry = await import("@/lib/sections/registry");
    ({ closePool } = await import("@/lib/db/client"));
  }, 60_000);

  afterAll(async () => {
    // ★ Whatever happened above: the store cascade takes every row a test
    //   wrote for it.
    if (client) {
      for (const storeId of stores) {
        try {
          await client.query("begin");
          await client.query("set constraints all deferred");
          await client.query("delete from stores where id = $1", [storeId]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        }
      }
    }
    await client?.end();
    await closePool?.();
  }, 60_000);

  it("★★ publishes the merchant's products featured, once, and never again after Undo", async () => {
    const { actor, revampId } = await fixture((id) => plan(id));
    const approval = await preview(actor, revampId);
    const result = await actions.executeMinkStorefrontPersonalizationAction({
      actor,
      draftId: revampId,
      approvalId: approval.id,
    });
    expect(result.repeated).toBe(false);

    // ★ Featured: the plan's featured_products bands read that flag, and the
    //   preview showed these products in them.
    const created = await rows<{
      slug: string;
      status: string;
      featured: boolean;
      category_id: string | null;
    }>(
      "select slug, status, featured, category_id from products where store_id = $1",
      [actor.storeId],
    );
    expect(created).toEqual([
      {
        slug: "almond-shake",
        status: "published",
        featured: true,
        category_id: expect.any(String),
      },
    ]);
    const applied = await job(revampId);
    expect(applied.applied_at).not.toBeNull();
    expect(applied.apply_snapshot?.products.created).toHaveLength(1);

    // ★★ The same card again, with a fresh key: refused before any approval.
    await expect(preview(actor, revampId)).rejects.toMatchObject({
      code: "mink_revamp_already_applied",
      message: "This redesign is already in your Website Builder draft.",
    });
    const approvals = await rows<{ status: string }>(
      "select status from mink_action_approvals where store_id = $1",
      [actor.storeId],
    );
    expect(approvals).toEqual([{ status: "executed" }]);

    // ★★ The record never replaces an earlier Apply's snapshot, which Undo
    //    restores from: a job found under the lock but already applied rolls
    //    the Apply back instead.
    const { withService } = await import("@/lib/db/client");
    const other = {
      ...applied.apply_snapshot!,
      appliedAt: new Date().toISOString(),
      pages: [],
    };
    await expect(
      withService((db) =>
        applyV2.recordRevampApplied(db, actor, {
          revampId,
          draftId: revampId,
          snapshot: other,
          job: { found: true },
        }),
      ),
    ).rejects.toMatchObject({ code: "mink_personalization_target_conflict" });
    expect(await job(revampId)).toEqual(applied);

    // ★★ After Undo the card is refused too: its changes would be ones no
    //    Publish or Undo could reach.
    await client.query(
      "update mink_revamps set undone_at = now() where id = $1",
      [revampId],
    );
    await expect(preview(actor, revampId)).rejects.toMatchObject({
      code: "mink_revamp_undone",
      message: "This redesign was undone. Ask Mink to make it again.",
    });
  }, 60_000);

  it("★★ files in the Media Library only the revamp photos the card puts on the store (ops-1)", async () => {
    const urls: Record<string, string> = {};
    const { actor, revampId } = await fixture(async (id, storeId) => {
      const folder = `stores/${storeId}/mink-generated/revamp/${id}`;
      const media = async (key: string, path: string) => {
        urls[key] = `https://storage.googleapis.com/b/${path}`;
        await client.query(
          `insert into media_assets(store_id, url, path, filename, source)
           values ($1, $2, $3, $4, 'mink_prepared')`,
          [storeId, urls[key], path, `${key}.webp`],
        );
      };
      await media("hero", `${folder}/slot-hero-1-aaaaaaaa.webp`);
      await media("phone", `${folder}/slot-hero-1-phone-bbbbbbbb.webp`);
      await media("unused", `${folder}/slot-story-1-cccccccc.webp`);
      await media("studio", `${folder}/product-shake-dddddddd.webp`);
      // The merchant's own photo, as Mink's chat prepared a copy of it.
      await media("own", `stores/${storeId}/media/mink-prepared/shake.webp`);
      const base = plan(id);
      return plan(id, {
        photos: [
          {
            url: urls.hero,
            path: `${folder}/slot-hero-1-aaaaaaaa.webp`,
            alt: "Shakes on a counter",
            where: "Home, opening photo",
          },
        ],
        products: {
          hide: [],
          create: base.products.create.map((product) => ({
            ...product,
            imageUrl: urls.studio,
            sourceImageUrl: urls.own,
          })),
        },
      });
    });
    const approval = await preview(actor, revampId);
    await actions.executeMinkStorefrontPersonalizationAction({
      actor,
      draftId: revampId,
      approvalId: approval.id,
    });
    const sources = Object.fromEntries(
      (
        await rows<{ url: string; source: string }>(
          "select url, source from media_assets where store_id = $1",
          [actor.storeId],
        )
      ).map((row) => [
        Object.keys(urls).find((key) => urls[key] === row.url),
        row.source,
      ]),
    );
    expect(sources).toEqual({
      hero: "mink_generated",
      studio: "mink_generated",
      // ★ Never shown by the card, so still not the merchant's to pick.
      unused: "mink_prepared",
      // A phone crop and the merchant's own prepared copy stay as they were.
      phone: "mink_prepared",
      own: "mink_prepared",
    });
  }, 60_000);

  it("★★ keeps a first header and footer draft the Builder saved while Apply worked", async () => {
    let menus: StoreChrome | null = null;
    const merchant = {
      ...chromeTypes.sanitizeChromeForSave(chromeTypes.normalizeChrome(null)),
    };
    merchant.header = {
      ...merchant.header,
      announcement: {
        enabled: true,
        text: "Merchant's own announcement",
        href: "",
      },
    };
    const { actor, revampId } = await fixture((id) => {
      // No store_chrome and no store_menus row: the store's header and
      // footer are the stock links, which is what Apply reads and digests.
      menus = chromeTypes.sanitizeChromeForSave(
        chromeTypes.normalizeChrome(null),
      );
      const next = structuredClone(menus);
      next.header.announcement = {
        enabled: true,
        text: "Shakes made fresh every morning",
        href: "",
      };
      return plan(id, {
        chrome: {
          expectedVersion: null,
          expectedDigest: digests.revampChromeDigest(menus),
          next,
        },
      });
    });
    expect(menus).not.toBeNull();
    const approval = await preview(actor, revampId);

    // ★ The Builder's autosave inserts the first chrome draft, on its own
    //   connection, after Apply found no row to lock.
    harness.afterMenusRead = async () => {
      await client.query(
        "insert into store_chrome(store_id, draft) values ($1, $2)",
        [actor.storeId, merchant],
      );
    };
    await expect(
      actions.executeMinkStorefrontPersonalizationAction({
        actor,
        draftId: revampId,
        approvalId: approval.id,
      }),
    ).rejects.toMatchObject({ code: "mink_personalization_target_conflict" });
    expect(harness.afterMenusRead).toBeNull();

    // The merchant's draft is exactly as they saved it, and Apply wrote
    // nothing at all: no product, no category, no record on the job.
    const chrome = await one<{ draft: StoreChrome }>(
      "select draft from store_chrome where store_id = $1",
      [actor.storeId],
    );
    expect(chrome.draft.header.announcement.text).toBe(
      "Merchant's own announcement",
    );
    expect(
      await rows("select id from products where store_id = $1", [
        actor.storeId,
      ]),
    ).toEqual([]);
    expect(
      await rows("select id from categories where store_id = $1", [
        actor.storeId,
      ]),
    ).toEqual([]);
    expect((await job(revampId)).applied_at).toBeNull();
    // The approval rolled back with the rest, so it is still pending.
    expect(
      await one<{ status: string }>(
        "select status from mink_action_approvals where id = $1",
        [approval.id],
      ),
    ).toEqual({ status: "pending" });
  }, 60_000);

  it("★★ puts the homepage draft back on an Undo before any Publish, though its title was edited since Apply", async () => {
    // ★ Apply never publishes, so it records what is live on the page and
    //   Undo compares the page with that: the page clock, which a title or
    //   search text edit moves too, is not what decides whether the draft is
    //   still the redesign's.
    const current = [section("theme", "Theme words")];
    const live = [section("live", "Fresh groceries, delivered")];
    const proposed = [section("hero", "Shakes made fresh every morning")];
    let pageId = "";
    const { actor, revampId } = await fixture(async (id, storeId) => {
      const page = await one<{ id: string; updated_at: string }>(
        `insert into store_pages(store_id, slug, title, status, sections,
           published_sections, published_at)
         values ($1, '', 'Home', 'published', $2, $3, now())
         returning id, updated_at`,
        [storeId, JSON.stringify(current), JSON.stringify(live)],
      );
      pageId = page.id;
      const validated = registry.validateSections(current, {
        mode: "draft",
      }) as { sections: PageSectionItem[] };
      return plan(id, {
        pages: [
          {
            pageId: page.id,
            slug: "",
            title: "Home",
            seoTitle: "Fresh shakes",
            seoDescription: "Shakes made fresh every morning.",
            create: false,
            expectedVersion: page.updated_at,
            expectedDigest: digests.revampSectionsDigest(validated.sections),
            sections: proposed,
            proposedDigest: digests.revampSectionsDigest(proposed),
            changes: { added: 1, removed: 1, kept: 0, photos: 0 },
          },
        ],
        categories: [],
        products: { hide: [], create: [] },
      });
    });
    const approval = await preview(actor, revampId);
    const applied = await actions.executeMinkStorefrontPersonalizationAction({
      actor,
      draftId: revampId,
      approvalId: approval.id,
    });
    expect(applied.repeated).toBe(false);
    const entry = (await job(revampId)).apply_snapshot!.pages[0];

    // The merchant renames the page in its settings, which saves the title
    // straight to the row (no draft layer) and moves the page's clock.
    await client.query(
      "update store_pages set title = 'Our shake bar', updated_by = $2 where id = $1",
      [pageId, actor.adminId],
    );
    expect(
      await one<{ moved: boolean }>(
        "select updated_at > $2::timestamptz as moved from store_pages where id = $1",
        [pageId, entry.afterUpdatedAt],
      ),
    ).toEqual({ moved: true });

    const result = await lifecycle.undoRevamp(actor, revampId);
    expect(result).toEqual({ restored: ["Homepage"], kept: [] });
    // The draft is back; the merchant's title and what shoppers see stay.
    expect(
      await one(
        "select title, sections, status, published_sections from store_pages where id = $1",
        [pageId],
      ),
    ).toEqual({
      title: "Our shake bar",
      sections: current,
      status: "published",
      published_sections: live,
    });
    // ★ What Apply recorded is the page as it found it under its lock.
    expect(entry.live).toEqual({
      status: "published",
      publishedDigest: digests.revampSectionsDigest(live),
    });
  }, 60_000);
});
