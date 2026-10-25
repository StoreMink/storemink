/** Rollback-only end-to-end checks of a revamp's Publish and Undo against
 * the real tables: a store as Apply leaves it, a mink_revamps row with the
 * stored plan and the apply snapshot apply-v2 writes, then the real
 * publishRevamp and undoRevamp. Run with MINK_REVAMP_LOCAL_TEST=1; the fixed
 * loopback database keeps it away from Cloud SQL, and everything happens
 * inside one transaction that is rolled back. */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { DEFAULT_CHROME, sanitizeChromeForSave } from "@/lib/chrome/types";
import type { StoreChrome } from "@/lib/chrome/types";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";
import type { PageSectionItem } from "@/lib/sections/registry";
import type { MinkActorContext } from "../types";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  pending: Promise.resolve(),
}));
vi.mock("@/lib/db/client", () => ({
  async withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const previous = service.pending;
    let release!: () => void;
    service.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `revamp_${++service.count}`;
    await service.client!.query(`SAVEPOINT ${name}`);
    try {
      const value = await fn(service.db!);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await service.client!.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally {
      release();
    }
  },
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: vi.fn(async () => undefined),
}));
vi.mock("@/lib/site", () => ({
  getStoreOriginById: vi.fn(async () => "https://lumen.storemink.com"),
}));
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveInstalledThemeDefinitionWithDb: vi.fn(async () => null),
}));

import { revampChromeDigest, revampSectionsDigest } from "./digests";
import type { RevampApplySnapshot } from "./lifecycle-types";
import { publishRevamp, undoRevamp } from "./publish";

/** ★ Inside one transaction now() never moves, so the fixture writes Apply's
 *  instant explicitly and every later write lands on a different one. */
const APPLIED = "2026-10-20 10:00:00.123456+00";
const LIVE_SINCE = "2026-10-01 00:00:00+00";

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

const BEFORE_HOME = [section("old", "Fresh groceries")];
const AFTER_HOME = [section("hero", "Candles for slow evenings")];
const AFTER_ABOUT = [section("story", "Poured by hand in Pune")];
const BEFORE_CHROME = chromeWith("Free delivery over Rs 499");
const AFTER_CHROME = chromeWith("Free shipping over Rs 999");

const enabled = process.env.MINK_REVAMP_LOCAL_TEST === "1";
describe.skipIf(!enabled)(
  "revamp publish and undo, end to end on local Postgres",
  () => {
    let client: Client;
    let actor: MinkActorContext;
    let revampId: string;
    let ids: {
      home: string;
      about: string;
      pillar: string;
      fruit: string;
      veg: string;
      candle: string;
      sold: string;
      sample: string;
    };

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
      service.client = client;
      service.db = drizzle(client, { schema: { ...schema, ...relations } });
      // ★ The migration this feature needs, applied inside the rolled-back
      //   transaction when the local database has not run it yet.
      const manifest = JSON.parse(
        readFileSync("drizzle/migrations/manifest.json", "utf8"),
      );
      const applied = new Set(
        (
          await client.query("select id from public.schema_migrations")
        ).rows.map((row) => row.id),
      );
      const migration = manifest.migrations.find(
        (entry: { id: string }) =>
          entry.id === "20261021_0234_mink_storefront_revamp",
      );
      if (!applied.has(migration.id)) {
        await client.query(
          readFileSync(`drizzle/migrations/${migration.file}`, "utf8"),
        );
      }
    }, 30_000);

    afterAll(async () => {
      if (client) {
        await client.query("ROLLBACK");
        await client.end();
      }
    });

    async function one<T>(text: string, params: unknown[] = []): Promise<T> {
      return (await client.query(text, params)).rows[0] as T;
    }

    async function insertId(text: string, params: unknown[]) {
      return (await one<{ id: string }>(text, params)).id;
    }

    beforeEach(async () => {
      await client.query("SAVEPOINT revamp_fixture");
      const storeId = crypto.randomUUID();
      actor = {
        storeId,
        adminId: "revamp-owner",
        email: null,
        roleSlug: "superadmin",
        permissions: {},
        isSuperadmin: true,
        effectivePlan: "pro",
        locationIds: null,
        analyticsTimeZone: "Asia/Kolkata",
        currency: "INR",
        defaultLowStockThreshold: 5,
        requestId: crypto.randomUUID(),
        draftingEnabled: true,
      };
      // The store as Apply leaves it: the redesign's words are in place.
      await client.query(
        "insert into stores(id,slug,name,status,plan,settings) values($1,$2,'Lumen','active','pro',$3)",
        [
          storeId,
          `revamp-${storeId}`,
          JSON.stringify({
            template: "basket",
            brand: {
              name: "Lumen",
              tagline: "Candles for slow evenings",
              blurb: "Hand-poured in Pune",
            },
          }),
        ],
      );
      const home = await insertId(
        `insert into store_pages(store_id,slug,title,status,sections,published_sections,published_at,updated_at)
         values($1,'','Home','published',$2,$3,$4,$5) returning id`,
        [
          storeId,
          JSON.stringify(AFTER_HOME),
          JSON.stringify(BEFORE_HOME),
          LIVE_SINCE,
          APPLIED,
        ],
      );
      const about = await insertId(
        `insert into store_pages(store_id,slug,title,status,sections,published_sections,updated_at)
         values($1,'our-story','Our story','draft',$2,'[]',$3) returning id`,
        [storeId, JSON.stringify(AFTER_ABOUT), APPLIED],
      );
      await client.query(
        "insert into store_chrome(store_id,draft,published,published_at,updated_at) values($1,$2,$3,$4,$5)",
        [
          storeId,
          JSON.stringify(AFTER_CHROME),
          JSON.stringify(BEFORE_CHROME),
          LIVE_SINCE,
          APPLIED,
        ],
      );
      const category = (name: string, slug: string, status: string) =>
        insertId(
          "insert into categories(store_id,name,slug,status,updated_at) values($1,$2,$3,$4,$5) returning id",
          [storeId, name, slug, status, APPLIED],
        );
      const pillar = await category(
        "Pillar candles",
        "pillar-candles",
        "active",
      );
      const fruit = await category("Tea lights", "fruit", "active");
      const veg = await category("Vegetables", "vegetables", "hidden");
      const product = (
        name: string,
        slug: string,
        status: string,
        categoryId: string | null,
      ) =>
        insertId(
          `insert into products(store_id,name,slug,status,category_id,updated_at,content_updated_at)
           values($1,$2,$3,$4,$5,$6,$6) returning id`,
          [storeId, name, slug, status, categoryId, APPLIED],
        );
      const candle = await product(
        "Amber candle",
        "amber-candle",
        "published",
        pillar,
      );
      const sold = await product(
        "Cedar candle",
        "cedar-candle",
        "published",
        null,
      );
      const sample = await product(
        "Apples (Sample)",
        "apples-sample",
        "draft",
        null,
      );
      // Someone bought the cedar candle after Apply.
      const orderId = await insertId(
        "insert into orders(store_id) values($1) returning id",
        [storeId],
      );
      await client.query(
        "insert into order_items(order_id,product_id,name) values($1,$2,'Cedar candle')",
        [orderId, sold],
      );
      // ★ A new product's seed trigger recomputes its stock, which moves
      //   `updated_at` to now(), and inside this one long transaction now() is
      //   later than APPLIED. In a real Apply the insert and that recompute
      //   share one transaction, so the row's `updated_at` IS the
      //   `afterUpdatedAt` Apply records. Put the fixture back to that, with
      //   the row triggers off for this one statement.
      await client.query("set local session_replication_role = replica");
      await client.query(
        "update products set updated_at = $2 where store_id = $1",
        [storeId, APPLIED],
      );
      await client.query("set local session_replication_role = origin");
      ids = { home, about, pillar, fruit, veg, candle, sold, sample };

      const apply: RevampApplySnapshot = {
        version: 1,
        appliedAt: APPLIED,
        pages: [
          {
            pageId: home,
            slug: "",
            created: false,
            before: {
              title: "Home",
              seoTitle: "Fresh groceries",
              seoDescription: "",
              sections: BEFORE_HOME,
            },
            afterUpdatedAt: APPLIED,
            afterDigest: revampSectionsDigest(AFTER_HOME),
          },
          {
            pageId: about,
            slug: "our-story",
            created: true,
            before: null,
            afterUpdatedAt: APPLIED,
            afterDigest: revampSectionsDigest(AFTER_ABOUT),
          },
        ],
        chrome: {
          rowExisted: true,
          before: BEFORE_CHROME,
          afterDigest: revampChromeDigest(sanitizeChromeForSave(AFTER_CHROME)),
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
            id: pillar,
            slug: "pillar-candles",
            before: null,
            afterUpdatedAt: APPLIED,
          },
          {
            action: "update",
            id: fruit,
            slug: "fruit",
            before: {
              name: "Fruit",
              description: null,
              imageUrl: null,
              status: "active",
            },
            afterUpdatedAt: APPLIED,
          },
          {
            action: "hide",
            id: veg,
            slug: "vegetables",
            before: {
              name: "Vegetables",
              description: null,
              imageUrl: null,
              status: "active",
            },
            afterUpdatedAt: APPLIED,
          },
        ],
        products: {
          hidden: [
            { id: sample, statusBefore: "published", afterUpdatedAt: APPLIED },
          ],
          created: [
            { id: candle, slug: "amber-candle", afterUpdatedAt: APPLIED },
            { id: sold, slug: "cedar-candle", afterUpdatedAt: APPLIED },
          ],
        },
      };
      revampId = crypto.randomUUID();
      const stored = {
        schemaVersion: 2,
        revampId,
        kind: "full",
        summary: "Makes the store about candles.",
        pages: [
          { pageId: home, slug: "", title: "Home", create: false },
          { pageId: null, slug: "our-story", title: "Our story", create: true },
        ],
        chrome: {
          expectedVersion: null,
          expectedDigest: "x",
          next: AFTER_CHROME,
        },
        brand: null,
        categories: [],
        products: { hide: [], create: [] },
        photos: [],
        checks: [],
        skipped: [],
        notes: [],
        explanation: "",
        credits: {},
        free: true,
      };
      // ★ A ready card needs a Mink draft row; Publish and Undo read only
      //   applied_at and the snapshots, so the fixture is an applied revamp
      //   a later one superseded, which keeps its Publish and Undo.
      await client.query(
        `insert into mink_revamps(id,store_id,admin_id,kind,status,step,request,result,applied_at,apply_snapshot)
         values($1,$2,$3,'full','superseded','card',$4,$5,$6,$7)`,
        [
          revampId,
          storeId,
          actor.adminId,
          JSON.stringify({ kind: "full" }),
          JSON.stringify({ stored }),
          APPLIED,
          JSON.stringify(apply),
        ],
      );
    });

    afterEach(async () => {
      await client.query("ROLLBACK TO SAVEPOINT revamp_fixture");
      await client.query("RELEASE SAVEPOINT revamp_fixture");
    });

    async function page(id: string) {
      return one<
        | {
            sections: PageSectionItem[];
            published_sections: PageSectionItem[];
            status: string;
            published_at: string | null;
            seo_title: string;
          }
        | undefined
      >(
        "select sections, published_sections, status, published_at, seo_title from store_pages where id=$1",
        [id],
      );
    }

    async function chromeRow() {
      return one<{ draft: StoreChrome; published: StoreChrome } | undefined>(
        "select draft, published from store_chrome where store_id=$1",
        [actor.storeId],
      );
    }

    it("★★ publishes every page and the header, then Undo puts the whole store back", async () => {
      const published = await publishRevamp(actor, revampId);
      expect(published).toEqual({
        published: ["Homepage", "Our story page", "Header and footer"],
        skipped: [],
      });
      const home = await page(ids.home);
      expect(home!.status).toBe("published");
      expect(revampSectionsDigest(home!.published_sections)).toBe(
        revampSectionsDigest(AFTER_HOME),
      );
      expect((await page(ids.about))!.status).toBe("published");
      expect((await chromeRow())!.published.header.announcement.text).toBe(
        "Free shipping over Rs 999",
      );
      const revamp = await one<{
        published_at: string | null;
        publish_snapshot: {
          pages: Array<{ before: { publishedAt: string | null } }>;
        };
      }>(
        "select published_at, publish_snapshot from mink_revamps where id=$1",
        [revampId],
      );
      expect(revamp.published_at).not.toBeNull();
      expect(revamp.publish_snapshot.pages).toHaveLength(2);
      // ★ A second click answers with the first result and writes nothing.
      expect(await publishRevamp(actor, revampId)).toEqual(published);

      const undone = await undoRevamp(actor, revampId);
      expect(undone.restored).toEqual(
        expect.arrayContaining([
          "Homepage",
          "Removed the new Our story page",
          "Header and footer",
          "Store tagline",
          "Footer description",
          "Apples (Sample) is back on your shop",
          "Removed the new Pillar candles category",
          "Fruit category",
          "Vegetables category is shown again",
        ]),
      );
      expect(undone.kept).toContainEqual({
        label: "Cedar candle",
        reason:
          "It already has orders, so it was taken off your shop instead of deleted.",
      });
      const restoredHome = await page(ids.home);
      expect(restoredHome!.sections).toEqual(BEFORE_HOME);
      expect(restoredHome!.published_sections).toEqual(BEFORE_HOME);
      expect(restoredHome!.seo_title).toBe("Fresh groceries");
      expect(
        Date.parse(
          restoredHome!.published_at!.replace(" ", "T").replace(/\+00$/, "Z"),
        ),
      ).toBe(Date.parse("2026-10-01T00:00:00Z"));
      expect(await page(ids.about)).toBeUndefined();
      const chrome = await chromeRow();
      expect(chrome!.draft.header.announcement.text).toBe(
        "Free delivery over Rs 499",
      );
      expect(chrome!.published.header.announcement.text).toBe(
        "Free delivery over Rs 499",
      );
      const store = await one<{ settings: { brand: Record<string, unknown> } }>(
        "select settings from stores where id=$1",
        [actor.storeId],
      );
      expect(store.settings.brand).toEqual({
        name: "Lumen",
        tagline: "Fresh groceries",
      });
      const productStatus = async (id: string) =>
        (
          await one<{ status: string } | undefined>(
            "select status from products where id=$1",
            [id],
          )
        )?.status;
      expect(await productStatus(ids.sold)).toBe("draft");
      expect(await productStatus(ids.sample)).toBe("published");
      // ★ Nothing but an order line refuses a product's delete (the rest
      //   cascades), so the unsold new product goes, and with it the new
      //   category it was filed under.
      expect(undone.restored).toContain("Removed Amber candle");
      expect(await productStatus(ids.candle)).toBeUndefined();
      const category = async (id: string) =>
        one<{ name: string; status: string } | undefined>(
          "select name, status from categories where id=$1",
          [id],
        );
      expect(await category(ids.pillar)).toBeUndefined();
      expect((await category(ids.fruit))!.name).toBe("Fruit");
      expect((await category(ids.veg))!.status).toBe("active");
      const after = await one<{ undone_at: string | null }>(
        "select undone_at from mink_revamps where id=$1",
        [revampId],
      );
      expect(after.undone_at).not.toBeNull();
      // ★ Idempotent, and Publish is closed once it is undone.
      expect(await undoRevamp(actor, revampId)).toEqual(undone);
      await expect(publishRevamp(actor, revampId)).rejects.toMatchObject({
        code: "mink_revamp_undone",
      });
    });

    it("★★ keeps and names what the merchant changed after Apply", async () => {
      await client.query("update store_pages set sections=$2 where id=$1", [
        ids.home,
        JSON.stringify([section("mine", "My own words")]),
      ]);
      await client.query("update categories set name='Votives' where id=$1", [
        ids.fruit,
      ]);
      await client.query(
        `update stores set settings = jsonb_set(settings, '{brand,tagline}', '"My tagline"') where id=$1`,
        [actor.storeId],
      );
      const undone = await undoRevamp(actor, revampId);
      const reason =
        "You changed it after the redesign, so your version was kept.";
      expect(undone.kept).toEqual(
        expect.arrayContaining([
          { label: "Homepage", reason },
          { label: "Votives category", reason },
          { label: "Store tagline", reason },
        ]),
      );
      expect((await page(ids.home))!.sections).toEqual([
        section("mine", "My own words"),
      ]);
      expect(
        (
          await one<{ name: string }>(
            "select name from categories where id=$1",
            [ids.fruit],
          )
        ).name,
      ).toBe("Votives");
      // The rest still goes back.
      expect(await page(ids.about)).toBeUndefined();
      expect((await chromeRow())!.draft.header.announcement.text).toBe(
        "Free delivery over Rs 499",
      );
    });

    /** A size the fixture adds stands for one Apply made: adding a size
     *  moves the product row (its SKU counter), so put the row's clock back
     *  to Apply's instant, as a size made inside Apply leaves it. */
    async function madeByApply(productId: string) {
      await client.query("set local session_replication_role = replica");
      await client.query("update products set updated_at = $2 where id = $1", [
        productId,
        APPLIED,
      ]);
      await client.query("set local session_replication_role = origin");
    }

    async function productStatus(id: string) {
      return (
        await one<{ status: string } | undefined>(
          "select status from products where id=$1",
          [id],
        )
      )?.status;
    }

    async function offerScopeRows(offerId: string) {
      return Number(
        (
          await one<{ n: string }>(
            "select count(*) as n from offer_products where offer_id=$1",
            [offerId],
          )
        ).n,
      );
    }

    async function insertOffer(
      name: string,
      rewardType: string,
      rewardConfig: Record<string, unknown>,
    ) {
      return insertId(
        `insert into offers(store_id,name,status,delivery,trigger_type,trigger_config,reward_type,reward_config,channels)
         values($1,$2,'active','automatic','always','{}',$3,$4,array['storefront','pos']) returning id`,
        [actor.storeId, name, rewardType, JSON.stringify(rewardConfig)],
      );
    }

    const OFFER_KEPT =
      "An offer uses it, so it was taken off your shop instead of deleted.";
    const REVIEW_KEPT =
      "Customers have reviewed it, so it was taken off your shop instead of deleted.";

    // ★★ offer_products, product_reviews and the rest cascade from a product,
    //    so a delete no foreign key refuses still takes them with it: an offer
    //    whose only scope row cascades away covers EVERY line (an empty scope
    //    is "everything"), and a shopper's review simply vanishes.
    it.each([
      {
        name: "an offer scoped to it",
        reason: OFFER_KEPT,
        setup: async () => {
          const offer = await insertOffer(
            "20% off Amber candle",
            "percent_off_items",
            { percent: 20 },
          );
          await client.query(
            "insert into offer_products(offer_id,store_id,product_id) values($1,$2,$3)",
            [offer, actor.storeId, ids.candle],
          );
          return { id: offer, scopeRows: 1 };
        },
      },
      {
        name: "an offer scoped to one of its sizes",
        reason: OFFER_KEPT,
        setup: async () => {
          const variant = await insertId(
            `insert into product_variants(product_id,store_id,name,selling_price,base_price,track_inventory)
             values($1,$2,'Large',499,499,false) returning id`,
            [ids.candle, actor.storeId],
          );
          await madeByApply(ids.candle);
          const offer = await insertOffer(
            "20% off the large candle",
            "percent_off_items",
            { percent: 20 },
          );
          await client.query(
            "insert into offer_products(offer_id,store_id,variant_id) values($1,$2,$3)",
            [offer, actor.storeId, variant],
          );
          return { id: offer, scopeRows: 1 };
        },
      },
      {
        name: "an offer that gives it away",
        reason: OFFER_KEPT,
        setup: async () => ({
          id: await insertOffer("A free candle", "free_item", {
            giftProductId: ids.candle,
            giftQuantity: 1,
          }),
          scopeRows: 0,
        }),
      },
      {
        name: "a shopper's review",
        reason: REVIEW_KEPT,
        setup: async () => {
          await client.query(
            "insert into users(id,phone,store_id) values('revamp-shopper','+919800000001',$1)",
            [actor.storeId],
          );
          await client.query(
            "insert into product_reviews(product_id,user_id,author_name,rating,store_id) values($1,'revamp-shopper','Asha',5,$2)",
            [ids.candle, actor.storeId],
          );
          return { id: null, scopeRows: 0 };
        },
      },
    ])(
      "★★ keeps a new product that $name uses, taking it off the shop instead",
      async ({ reason, setup }) => {
        const offer = await setup();
        const undone = await undoRevamp(actor, revampId);
        expect(undone.restored).not.toContain("Removed Amber candle");
        expect(undone.kept).toContainEqual({ label: "Amber candle", reason });
        expect(await productStatus(ids.candle)).toBe("draft");
        // An offer keeps its scope, so it does not widen to the whole store;
        // a review is still there.
        if (offer.id) {
          expect(await offerScopeRows(offer.id)).toBe(offer.scopeRows);
        } else {
          expect(
            await one<{ id: string } | undefined>(
              "select id from product_reviews where product_id=$1",
              [ids.candle],
            ),
          ).toBeDefined();
        }
        // The product stays, so the new category it is filed under stays.
        expect(undone.kept).toContainEqual({
          label: "Pillar candles category",
          reason: "Products are filed under it, so it was kept.",
        });
      },
    );

    it("★★ keeps a new category an offer is scoped to, so the offer does not widen to the whole store", async () => {
      const offer = await insertOffer(
        "10% off pillar candles",
        "percent_off_items",
        { percent: 10 },
      );
      await client.query(
        "insert into offer_products(offer_id,store_id,category_id) values($1,$2,$3)",
        [offer, actor.storeId, ids.pillar],
      );
      const undone = await undoRevamp(actor, revampId);
      // Nothing uses the product, so it still goes.
      expect(undone.restored).toContain("Removed Amber candle");
      expect(undone.restored).not.toContain(
        "Removed the new Pillar candles category",
      );
      expect(undone.kept).toContainEqual({
        label: "Pillar candles category",
        reason: "An offer uses it, so it was kept.",
      });
      expect(
        await one<{ id: string } | undefined>(
          "select id from categories where id=$1",
          [ids.pillar],
        ),
      ).toBeDefined();
      expect(await offerScopeRows(offer)).toBe(1);
    });

    // ★★ content_updated_at moves only for what a shopper sees (name, price,
    //    status, ...), so a product the merchant configured after Apply
    //    (tracking, stock, weight, cost, sizes) looked untouched and was
    //    deleted with its stock levels and ledger.
    it("★★ keeps a new product the merchant set up after Apply", async () => {
      await client.query(
        "update products set track_inventory = true, weight_grams = 250 where id=$1",
        [ids.candle],
      );
      const undone = await undoRevamp(actor, revampId);
      expect(undone.restored).not.toContain("Removed Amber candle");
      expect(undone.kept).toContainEqual({
        label: "Amber candle",
        reason: "You changed it after the redesign, so your version was kept.",
      });
      expect(await productStatus(ids.candle)).toBe("published");
    });

    it("★★ keeps a new product whose stock was counted after Apply, even at one size only", async () => {
      // A size's stock lives on the size: counting it moves the size's
      // total, never the product row, so only the stock ledger shows it.
      const variant = await insertId(
        `insert into product_variants(product_id,store_id,name,selling_price,base_price,track_inventory)
         values($1,$2,'Large',499,499,false) returning id`,
        [ids.candle, actor.storeId],
      );
      await madeByApply(ids.candle);
      const main = await insertId(
        "select id from store_locations where store_id=$1 and is_default",
        [actor.storeId],
      );
      await client.query(
        "select public.adjust_stock_at($1,$2,$3,$4,40,'count',null,'revamp-owner')",
        [actor.storeId, main, ids.candle, variant],
      );
      const undone = await undoRevamp(actor, revampId);
      expect(undone.restored).not.toContain("Removed Amber candle");
      expect(undone.kept).toContainEqual({
        label: "Amber candle",
        reason: "You changed it after the redesign, so your version was kept.",
      });
      expect(
        await one<{ on_hand: number } | undefined>(
          "select on_hand from inventory_levels where variant_id=$1",
          [variant],
        ),
      ).toMatchObject({ on_hand: 40 });
    });

    it("★ does not put back on the shop a hidden sample the merchant edited after Apply", async () => {
      await client.query("update products set weight_grams = 500 where id=$1", [
        ids.sample,
      ]);
      const undone = await undoRevamp(actor, revampId);
      expect(undone.restored).not.toContain(
        "Apples (Sample) is back on your shop",
      );
      expect(undone.kept).toContainEqual({
        label: "Apples (Sample)",
        reason: "You changed it after the redesign, so your version was kept.",
      });
      expect(await productStatus(ids.sample)).toBe("draft");
    });

    it("★★ a store that had no header row: an edited header draft still takes the redesign's header off the live store", async () => {
      // Apply made the row: nothing was live before, and no draft existed.
      await client.query(
        "update store_chrome set published = null, published_at = null where store_id=$1",
        [actor.storeId],
      );
      await client.query(
        `update mink_revamps
            set apply_snapshot = jsonb_set(apply_snapshot, '{chrome}', $2::jsonb)
          where id=$1`,
        [
          revampId,
          JSON.stringify({
            rowExisted: false,
            before: null,
            afterDigest: revampChromeDigest(
              sanitizeChromeForSave(AFTER_CHROME),
            ),
          }),
        ],
      );
      await publishRevamp(actor, revampId);
      const mine = chromeWith("Diwali sale this week");
      await client.query("update store_chrome set draft=$2 where store_id=$1", [
        actor.storeId,
        JSON.stringify(mine),
      ]);
      const undone = await undoRevamp(actor, revampId);
      expect(undone.restored).toContain("Header and footer (live)");
      const row = await one<{
        draft: StoreChrome;
        published_is_null: boolean;
        published_at: string | null;
      }>(
        "select draft, published is null as published_is_null, published_at from store_chrome where store_id=$1",
        [actor.storeId],
      );
      // ★ Nothing published again: the storefront shows the store's own menus.
      expect(row.published_is_null).toBe(true);
      expect(row.published_at).toBeNull();
      expect(row.draft.header.announcement.text).toBe("Diwali sale this week");
    });

    /** The homepage entry as today's Apply writes it: with `proposed`. */
    async function homeProposes(meta: Record<string, string>) {
      await client.query(
        `update mink_revamps
            set apply_snapshot = jsonb_set(apply_snapshot, '{pages,0,proposed}', $2::jsonb)
          where id=$1`,
        [revampId, JSON.stringify(meta)],
      );
    }

    /** ★ now() never moves inside this one transaction, so a write after
     *  Publish would land on Publish's own instant and no clock could see it.
     *  Move Publish's instant back, on the row and in its record alike, as a
     *  Publish that committed earlier leaves them. */
    async function publishedEarlier() {
      const earlier = "2026-10-20 11:00:00+00";
      await client.query("set local session_replication_role = replica");
      await client.query("update store_pages set updated_at=$2 where id=$1", [
        ids.home,
        earlier,
      ]);
      await client.query("set local session_replication_role = origin");
      await client.query(
        `update mink_revamps
            set publish_snapshot = jsonb_set(publish_snapshot, '{pages,0,afterUpdatedAt}', to_jsonb($2::text))
          where id=$1 and publish_snapshot #>> '{pages,0,pageId}' = $3`,
        [revampId, earlier, ids.home],
      );
    }

    it("★★ after a publish, a search title edit alone still lets Undo put the homepage draft back", async () => {
      await homeProposes({
        title: "Home",
        seoTitle: "Fresh groceries",
        seoDescription: "",
      });
      await publishRevamp(actor, revampId);
      await publishedEarlier();
      // Page settings write the row, which moves updated_at.
      await client.query(
        "update store_pages set seo_title='My own search title' where id=$1",
        [ids.home],
      );
      const undone = await undoRevamp(actor, revampId);
      expect(undone.restored).toContain("Homepage");
      const home = await page(ids.home);
      expect(home!.sections).toEqual(BEFORE_HOME);
      expect(home!.published_sections).toEqual(BEFORE_HOME);
      expect(home!.seo_title).toBe("My own search title");
    });

    it("★★ leaves a page the merchant unpublished after Publish unpublished", async () => {
      await homeProposes({
        title: "Home",
        seoTitle: "Fresh groceries",
        seoDescription: "",
      });
      await publishRevamp(actor, revampId);
      await client.query("update store_pages set status='draft' where id=$1", [
        ids.home,
      ]);
      const undone = await undoRevamp(actor, revampId);
      expect(undone.kept).toContainEqual({
        label: "Homepage (live)",
        reason:
          "You unpublished it after the redesign, so it was left unpublished.",
      });
      expect((await page(ids.home))!.status).toBe("draft");
    });

    it("answers 404 for another admin's revamp", async () => {
      await expect(
        undoRevamp({ ...actor, adminId: "someone-else" }, revampId),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        publishRevamp({ ...actor, adminId: "someone-else" }, revampId),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("★★ refuses Undo to a role without Branding manage, and nothing on the store moves", async () => {
      // The same admin, now on a role that keeps every other part Apply
      // needed but has lost Branding manage.
      const staff = {
        ...actor,
        roleSlug: "admin",
        isSuperadmin: false,
        permissions: {
          builder: ["manage"],
          products: ["manage"],
          categories: ["manage"],
        },
      } as unknown as MinkActorContext;
      await expect(undoRevamp(staff, revampId)).rejects.toMatchObject({
        code: "mink_revamp_access_denied",
        status: 403,
        message:
          "Undoing this redesign changes your store's tagline or footer description, which needs Branding manage permission.",
      });
      const store = await one<{ settings: { brand: Record<string, unknown> } }>(
        "select settings from stores where id=$1",
        [actor.storeId],
      );
      expect(store.settings.brand).toEqual({
        name: "Lumen",
        tagline: "Candles for slow evenings",
        blurb: "Hand-poured in Pune",
      });
      expect((await page(ids.home))!.sections).toEqual(AFTER_HOME);
      expect(
        (
          await one<{ name: string }>(
            "select name from categories where id=$1",
            [ids.fruit],
          )
        ).name,
      ).toBe("Tea lights");
      expect(
        (
          await one<{ undone_at: string | null }>(
            "select undone_at from mink_revamps where id=$1",
            [revampId],
          )
        ).undone_at,
      ).toBeNull();
      // Given Branding manage back, the same role undoes the whole store.
      const undone = await undoRevamp(
        {
          ...staff,
          permissions: { ...staff.permissions, branding: ["manage"] },
        } as unknown as MinkActorContext,
        revampId,
      );
      expect(undone.restored).toEqual(
        expect.arrayContaining(["Store tagline", "Footer description"]),
      );
    });

    it("★★ refuses Undo while a newer version is applied, two versions down, and undoes once that one is undone (U-1)", async () => {
      // A refinement nobody applied, and its own refinement, applied since:
      // that version's pages show the products and categories this one made.
      const refine = (parentId: string, appliedAt: string | null) =>
        insertId(
          `insert into mink_revamps(id,store_id,admin_id,parent_id,kind,status,step,request,applied_at)
           values($1,$2,$3,$4,'refine','superseded','card',$5,$6) returning id`,
          [
            crypto.randomUUID(),
            actor.storeId,
            actor.adminId,
            parentId,
            JSON.stringify({ kind: "refine" }),
            appliedAt,
          ],
        );
      const count = async (table: "products" | "categories", id: string) =>
        (
          await one<{ n: number }>(
            `select count(*)::int as n from ${table} where id=$1`,
            [id],
          )
        ).n;
      const child = await refine(revampId, null);
      const grandchild = await refine(child, "2026-10-21 10:00:00+00");
      await expect(undoRevamp(actor, revampId)).rejects.toMatchObject({
        code: "mink_revamp_newer_version_applied",
        status: 409,
      });
      expect((await page(ids.home))!.sections).toEqual(AFTER_HOME);
      expect(await count("products", ids.candle)).toBe(1);
      expect(await count("categories", ids.pillar)).toBe(1);
      expect(
        (
          await one<{ undone_at: string | null }>(
            "select undone_at from mink_revamps where id=$1",
            [revampId],
          )
        ).undone_at,
      ).toBeNull();
      // With the newest version undone, this one undoes as before.
      await client.query(
        "update mink_revamps set undone_at = '2026-10-21 11:00:00+00' where id=$1",
        [grandchild],
      );
      const undone = await undoRevamp(actor, revampId);
      expect(undone.restored).toContain("Homepage");
      expect(await count("products", ids.candle)).toBe(0);
    });
  },
);
