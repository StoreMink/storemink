/** Rollback-only check, against local Postgres, that the storefront readers
 * stage T8a masks keep a blocked item and a blocked file off the page
 * (takedown design 10, plan E2 row 2): after a block, the readers return
 * nothing blocked and every blocked file's address comes back as the
 * placeholder's; after the lift, everything is back exactly as it was. Run
 * with MODERATION_LOCAL_TEST=1 after `npm run db:migrate:local -- apply`; the
 * fixed loopback database keeps it away from Cloud SQL, and everything
 * happens inside one transaction that is rolled back.
 *
 * ★ The readers run as they do in production: `withAnon` on a savepoint
 *   under `SET ROLE app_user` with no identity (so RLS hides a blocked row),
 *   and the blocked set's reload through `withService` under
 *   `SET ROLE app_service`, both on this file's one connection and one at a
 *   time, so the reload sees this transaction's blocks.
 * ★ Fixtures, all inside the transaction, on the local store `echo`: three
 *   published products (one gets a bucket photo and an outside photo, one is
 *   blocked, one keeps its bundled theme photo, which is blocked as a file),
 *   two collections, two blog posts and two pages (one of each blocked), a
 *   menu and a header image, an invoice logo and a brand logo.
 * ★ Nothing reaches a network: `fetch` throws, and the bucket is a name only
 *   (no storage client is created).
 */
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";

const enabled = process.env.MODERATION_LOCAL_TEST === "1";

const BUCKET = "sm-t8a-local-media";

const scope = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  pending: Promise.resolve(),
}));
vi.mock("@/lib/db/client", () => {
  /** One scope at a time on the one connection, each on its own savepoint
   *  (two at once would interleave their savepoints). */
  async function run<T>(
    role: "app_user" | "app_service",
    fn: (db: Db) => Promise<T>,
  ): Promise<T> {
    const previous = scope.pending;
    let release!: () => void;
    scope.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `t8a_scope_${++scope.count}`;
    const client = scope.client!;
    await client.query(`SAVEPOINT ${name}`);
    try {
      if (role === "app_user") {
        await client.query(
          "select set_config('app.current_user_id', '', true), set_config('app.current_user_email', '', true)",
        );
      }
      await client.query(`SET ROLE ${role}`);
      const value = await fn(scope.db!);
      await client.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally {
      await client.query("RESET ROLE");
      release();
    }
  }
  return {
    withAnon: <T>(fn: (db: Db) => Promise<T>) => run("app_user", fn),
    withService: <T>(fn: (db: Db) => Promise<T>) => run("app_service", fn),
    withUser: () => {
      throw new Error("No reader under test signs anyone in.");
    },
  };
});
vi.mock("@/lib/storage/gcs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage/gcs")>()),
  GCS_BUCKET_NAME: "sm-t8a-local-media",
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(async () => null),
}));
vi.mock("@/lib/settings/resolve", () => ({
  getStoreSetting: vi.fn(async () => 5),
}));
vi.mock("@/lib/observability/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/logger")>()),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  getActiveCategories,
  getPublishedBlogCards,
  getPublishedPage,
  getPublishedPageSlugs,
  getPublishedProducts,
  getStoreBillingSettings,
  getStoreMenus,
} from "./queries";
import { getStoreChrome } from "@/lib/chrome/queries";
import {
  fetchSectionDatasets,
  resolveSectionData,
} from "@/lib/sections/resolve-data";
import { getStoreBrandById } from "@/lib/store/brand";
import { forgetBlockedObjects } from "@/lib/moderation/blocked-objects";
import { PLACEHOLDER_URL_PATH } from "@/lib/moderation/placeholder";
import { EMPTY_CONFIG } from "@/lib/homepage/section-types";
import type { RenderableSection } from "@/app/(storefront)/components/homepage/homepage-section-renderer";

type Row = Record<string, unknown>;

const OPERATOR = "op@storemink.com";
const CASE_MS = 30_000;
const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);

describe.skipIf(!enabled)(
  "the storefront readers mask (local database)",
  () => {
    let client: Client;
    let echoId = "";
    /** The three products: one with photos swapped, one blocked, one whose
     *  bundled theme photo is blocked. */
    let photoProduct = "";
    let blockedProduct = "";
    let bundledProduct = "";
    let bundledPhoto = "";
    let visibleCollection = "";
    let blockedCollection = "";
    let visiblePost = "";
    let blockedPost = "";
    let visiblePage = "";
    let blockedPage = "";
    const visibleSlug = `t8a-${tag}-visible`;
    const blockedSlug = `t8a-${tag}-blocked`;
    const blockIds: string[] = [];

    /** The three blocked files, one of each source. */
    const bucketPath = () => `stores/${echoId}/media/t8a-${tag}-photo.webp`;
    const bucketAddress = () =>
      `https://storage.googleapis.com/${BUCKET}/${bucketPath()}`;
    const outsideAddress = `https://cdn.example.com/t8a-${tag}-banner.jpg`;

    const rows = async (text: string, params: unknown[] = []) =>
      (await client.query(text, params)).rows as Row[];
    const one = async (text: string, params: unknown[] = []) =>
      (await rows(text, params))[0] ?? null;
    const idOf = (row: Row | null): string => {
      if (!row) throw new Error("The statement returned no row.");
      return String(row.id);
    };

    /** One content_blocks row as app_service, the role the blocking code takes. */
    async function block(fields: Row): Promise<string> {
      const all: Row = {
        store_id: echoId,
        store_label: "echo",
        item_label: "Probe item",
        reason_kind: "terms_breach",
        store_message: "We blocked this after a complaint.",
        blocked_by: OPERATOR,
        ...fields,
      };
      const keys = Object.keys(all);
      await client.query("SET ROLE app_service");
      try {
        return idOf(
          await one(
            `insert into public.content_blocks (${keys.join(", ")})
           values (${keys.map((_, i) => `$${i + 1}`).join(", ")})
           returning id`,
            keys.map((key) => all[key]),
          ),
        );
      } finally {
        await client.query("RESET ROLE");
      }
    }

    /** Every blocked address this file uses, for "appears nowhere" checks. */
    const blockedAddresses = () => [
      bucketAddress(),
      outsideAddress,
      bundledPhoto,
    ];

    async function readEverything() {
      const featured: RenderableSection[] = [
        {
          id: "t8a-featured",
          type: "featured_products",
          enabled: true,
          config: { ...EMPTY_CONFIG.featured_products },
        } as unknown as RenderableSection,
        {
          id: "t8a-categories",
          type: "shop_by_category",
          enabled: true,
          config: { ...EMPTY_CONFIG.shop_by_category },
        } as unknown as RenderableSection,
      ];
      return {
        products: await getPublishedProducts(echoId),
        categories: await getActiveCategories(echoId),
        posts: await getPublishedBlogCards(echoId),
        page: await getPublishedPage(echoId, visibleSlug),
        blockedPage: await getPublishedPage(echoId, blockedSlug),
        slugs: await getPublishedPageSlugs(echoId),
        menus: await getStoreMenus(echoId),
        chrome: await getStoreChrome(echoId),
        billing: await getStoreBillingSettings(echoId),
        brand: await getStoreBrandById(echoId),
        datasets: await fetchSectionDatasets([], echoId, { all: true }),
        resolved: await resolveSectionData(featured, echoId),
      };
    }
    type Read = Awaited<ReturnType<typeof readEverything>>;

    const product = (read: Read, id: string) =>
      read.products.find((p) => p.id === id);
    const collection = (read: Read, id: string) =>
      read.categories.find((c) => c.id === id);
    const post = (read: Read, id: string) =>
      read.posts.find((p) => p.id === id);

    /** What every reader returns while nothing is blocked (before and after). */
    function expectUnblocked(read: Read) {
      expect(product(read, photoProduct)?.image_url).toBe(bucketAddress());
      expect(product(read, photoProduct)?.images).toEqual([outsideAddress]);
      expect(product(read, blockedProduct)).toBeDefined();
      expect(product(read, bundledProduct)?.image_url).toBe(bundledPhoto);
      expect(collection(read, visibleCollection)?.image_url).toBe(
        outsideAddress,
      );
      expect(collection(read, blockedCollection)).toBeDefined();
      expect(post(read, visiblePost)?.cover_image_url).toBe(bucketAddress());
      expect(post(read, blockedPost)).toBeDefined();
      expect(JSON.stringify(read.page)).toContain(bucketAddress());
      expect(read.page?.id).toBe(visiblePage);
      expect(read.page?.published_sections).toHaveLength(2);
      expect(read.blockedPage?.id).toBe(blockedPage);
      expect(read.slugs.map((s) => s.slug)).toEqual(
        expect.arrayContaining([visibleSlug, blockedSlug]),
      );
      expect(read.menus.header[0]?.image_url).toBe(outsideAddress);
      expect(read.chrome.header.links[0]?.image_url).toBe(bucketAddress());
      expect(read.billing.logoUrl).toBe(bucketAddress());
      expect(read.brand.logoUrl).toBe(outsideAddress);
      const datasets = JSON.stringify(read.datasets);
      for (const address of blockedAddresses()) {
        expect(datasets).toContain(address);
      }
      expect(JSON.stringify(read.datasets)).not.toContain(PLACEHOLDER_URL_PATH);
      expect(JSON.stringify(read.resolved)).not.toContain(PLACEHOLDER_URL_PATH);
    }

    beforeAll(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("No network in this test.");
        }),
      );
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.MODERATION_LOCAL_TEST_USER || process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      scope.client = client;
      scope.db = drizzle(client, { schema: { ...schema, ...relations } });

      const ledger = await one(
        "select 1 as ok from public.schema_migrations where id = $1",
        ["20261030_0269_content_takedown"],
      );
      if (!ledger) {
        throw new Error(
          "0269 is not applied to storemink_local: run npm run db:migrate:local -- apply first.",
        );
      }
      const live = await one(
        "select count(*)::int as n from public.content_blocks where lifted_at is null",
      );
      if (Number(live?.n) !== 0) {
        throw new Error(
          "storemink_local already holds a live block; this file needs a database with none.",
        );
      }
      echoId = idOf(
        await one("select id from public.stores where slug = 'echo'"),
      );

      const products = await rows(
        `select id, image_url from public.products
        where store_id = $1 and status = 'published'
          and moderation_blocked_at is null and image_url like '/themes/%'
        order by sort_order, created_at, id limit 3`,
        [echoId],
      );
      if (products.length < 3) {
        throw new Error(
          "The local store echo needs three published products with a bundled theme photo.",
        );
      }
      [photoProduct, blockedProduct, bundledProduct] = products.map((p) =>
        String(p.id),
      );
      bundledPhoto = String(products[2].image_url);
      const sharing = await one(
        `select count(*)::int as n from public.products
        where store_id = $1 and status = 'published' and image_url = $2`,
        [echoId, bundledPhoto],
      );
      if (Number(sharing?.n) !== 1) {
        throw new Error(
          `${bundledPhoto} is used by more than one echo product.`,
        );
      }
      await client.query(
        "update public.products set image_url = $2, images = array[$3]::text[] where id = $1",
        [photoProduct, bucketAddress(), outsideAddress],
      );

      visibleCollection = idOf(
        await one(
          `insert into public.categories (store_id, name, slug, status, image_url)
         values ($1, 'T8a visible', $2, 'active', $3) returning id`,
          [echoId, `t8a-${tag}-visible`, outsideAddress],
        ),
      );
      blockedCollection = idOf(
        await one(
          `insert into public.categories (store_id, name, slug, status)
         values ($1, 'T8a blocked', $2, 'active') returning id`,
          [echoId, `t8a-${tag}-blocked`],
        ),
      );
      visiblePost = idOf(
        await one(
          `insert into public.blogs
           (store_id, title, slug, status, content, cover_image_url, published_at)
         values ($1, 'T8a visible post', $2, 'published', '<p>x</p>', $3, now())
         returning id`,
          [echoId, `t8a-${tag}-visible-post`, bucketAddress()],
        ),
      );
      blockedPost = idOf(
        await one(
          `insert into public.blogs
           (store_id, title, slug, status, content, published_at)
         values ($1, 'T8a blocked post', $2, 'published', '<p>x</p>', now())
         returning id`,
          [echoId, `t8a-${tag}-blocked-post`],
        ),
      );
      const sections = [
        {
          id: "t8a-media",
          type: "media_text",
          enabled: true,
          config: {
            ...EMPTY_CONFIG.media_text,
            image_url: bucketAddress(),
            image_alt: "Probe photo",
          },
        },
        {
          id: "t8a-text",
          type: "rich_text",
          enabled: true,
          config: {
            ...EMPTY_CONFIG.rich_text,
            html: `<p>Look <img src="${bucketAddress()}" alt="Probe photo"></p>`,
          },
        },
      ];
      visiblePage = idOf(
        await one(
          `insert into public.store_pages
           (store_id, slug, title, status, sections, published_sections, published_at)
         values ($1, $2, 'T8a visible page', 'published', $3::jsonb, $3::jsonb, now())
         returning id`,
          [echoId, visibleSlug, JSON.stringify(sections)],
        ),
      );
      blockedPage = idOf(
        await one(
          `insert into public.store_pages
           (store_id, slug, title, status, sections, published_sections, published_at)
         values ($1, $2, 'T8a blocked page', 'published', '[]'::jsonb, '[]'::jsonb, now())
         returning id`,
          [echoId, blockedSlug],
        ),
      );
      const navWithImage = (image: string) =>
        JSON.stringify([
          {
            label: "Shop",
            href: "/shop",
            image_url: image,
            children: [{ label: "Everything", href: "/shop" }],
          },
        ]);
      await client.query(
        `insert into public.store_menus (store_id, header) values ($1, $2::jsonb)
       on conflict (store_id) do update set header = excluded.header`,
        [echoId, navWithImage(outsideAddress)],
      );
      await client.query(
        `insert into public.store_chrome (store_id, published)
       values ($1, jsonb_build_object('header', jsonb_build_object('links', $2::jsonb)))
       on conflict (store_id) do update
         set published = coalesce(public.store_chrome.published, '{}'::jsonb)
           || jsonb_build_object('header',
                coalesce(public.store_chrome.published -> 'header', '{}'::jsonb)
                || jsonb_build_object('links', $2::jsonb))`,
        [echoId, navWithImage(bucketAddress())],
      );
      await client.query(
        `insert into public.store_billing_settings (store_id, logo_url) values ($1, $2)
       on conflict (store_id) do update set logo_url = excluded.logo_url`,
        [echoId, bucketAddress()],
      );
      await client.query(
        `update public.stores
          set settings = coalesce(settings, '{}'::jsonb)
                || jsonb_build_object('brand',
                     coalesce(settings->'brand', '{}'::jsonb)
                     || jsonb_build_object('logoUrl', $2::text))
        where id = $1`,
        [echoId, outsideAddress],
      );

      forgetBlockedObjects();
    }, CASE_MS);

    afterAll(async () => {
      vi.unstubAllGlobals();
      forgetBlockedObjects();
      if (!client) return;
      await client.query("ROLLBACK");
      await client.end();
    });

    it(
      "shows everything while nothing is blocked",
      async () => {
        expectUnblocked(await readEverything());
      },
      CASE_MS,
    );

    it(
      "after a block, returns nothing blocked and every blocked address swapped",
      async () => {
        blockIds.push(
          await block({
            item_kind: "file",
            object_path: bucketPath(),
            file_source: "bucket",
            item_label: "photo.webp",
            storage_state: "pending",
          }),
          await block({
            item_kind: "file",
            object_path: outsideAddress,
            file_source: "external",
            item_label: "banner.jpg",
            storage_state: "not_ours",
          }),
          await block({
            item_kind: "file",
            object_path: bundledPhoto,
            file_source: "bundled",
            item_label: "theme photo",
            storage_state: "manual",
          }),
          await block({
            item_kind: "product",
            item_id: blockedProduct,
            item_label: "A product",
          }),
          await block({
            item_kind: "collection",
            item_id: blockedCollection,
            item_label: "A collection",
          }),
          await block({
            item_kind: "blog_post",
            item_id: blockedPost,
            item_label: "A post",
          }),
          await block({
            item_kind: "page",
            item_id: blockedPage,
            item_label: "A page",
          }),
        );
        forgetBlockedObjects();
        const read = await readEverything();

        // Blocked items are gone (RLS).
        expect(product(read, blockedProduct)).toBeUndefined();
        expect(collection(read, blockedCollection)).toBeUndefined();
        expect(post(read, blockedPost)).toBeUndefined();
        expect(read.blockedPage).toBeNull();
        expect(read.slugs.map((s) => s.slug)).toContain(visibleSlug);
        expect(read.slugs.map((s) => s.slug)).not.toContain(blockedSlug);

        // Blocked files come back as the placeholder (the page swap).
        expect(product(read, photoProduct)?.image_url).toBe(
          PLACEHOLDER_URL_PATH,
        );
        expect(product(read, photoProduct)?.images).toEqual([
          PLACEHOLDER_URL_PATH,
        ]);
        expect(product(read, bundledProduct)?.image_url).toBe(
          PLACEHOLDER_URL_PATH,
        );
        expect(collection(read, visibleCollection)?.image_url).toBe(
          PLACEHOLDER_URL_PATH,
        );
        expect(post(read, visiblePost)?.cover_image_url).toBe(
          PLACEHOLDER_URL_PATH,
        );
        expect(read.page?.id).toBe(visiblePage);
        expect(read.page?.published_sections).toHaveLength(2);
        const [media, text] = read.page!.published_sections;
        expect((media.config as { image_url: string }).image_url).toBe(
          PLACEHOLDER_URL_PATH,
        );
        expect((text.config as { html: string }).html).toContain(
          `src="${PLACEHOLDER_URL_PATH}"`,
        );
        expect(read.menus.header[0]?.image_url).toBe(PLACEHOLDER_URL_PATH);
        expect(read.chrome.header.links[0]?.image_url).toBe(
          PLACEHOLDER_URL_PATH,
        );
        // A logo slot drops a blocked logo (its own no-logo state).
        expect(read.billing.logoUrl).toBeNull();
        expect(read.brand.logoUrl).toBeNull();
        expect(read.brand.name).toBeTruthy();

        // No reader lets a blocked address through anywhere.
        const everything = JSON.stringify(read);
        for (const address of blockedAddresses()) {
          expect(everything).not.toContain(address);
        }
        expect(JSON.stringify(read.datasets)).toContain(PLACEHOLDER_URL_PATH);
        expect(
          read.datasets.products.some(
            (p) => (p as { id?: string }).id === blockedProduct,
          ),
        ).toBe(false);
      },
      CASE_MS,
    );

    it(
      "after the lift, returns everything again",
      async () => {
        expect(blockIds).toHaveLength(7);
        await client.query("SET ROLE app_service");
        try {
          for (const id of blockIds) {
            await client.query(
              `update public.content_blocks
                set lifted_at = now(), lifted_by = $2,
                    storage_state = case when storage_state = 'pending'
                                         then 'cancelled' else storage_state end
              where id = $1`,
              [id, OPERATOR],
            );
          }
        } finally {
          await client.query("RESET ROLE");
        }
        forgetBlockedObjects();
        expectUnblocked(await readEverything());
      },
      CASE_MS,
    );
  },
);
