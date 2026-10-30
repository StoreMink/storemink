/** Rollback-only check, against local Postgres, that the service-scope reads
 * that serve shoppers (takedown design 3.2, 5.7, 10; review findings F5, F6
 * and F26; plan stage T9) keep what StoreMink has blocked away from a
 * shopper: with a real product, a variant's product, a collection and a
 * policy page blocked, `readCartProducts`, `readGiftProduct`,
 * `loadLiveOffers` (the gift's availability), `estimateProductDelivery`,
 * `getLivePolicies` and `readMinkShopperOffers` neither return nor name any of
 * them; after the lift they do again. Run with MODERATION_LOCAL_TEST=1 after
 * `npm run db:migrate:local -- apply`; the fixed loopback database keeps it
 * away from Cloud SQL, and everything happens inside one transaction that is
 * rolled back.
 *
 * ★ These reads run under `withService` (the read policies that hide a
 *   blocked row never run), so each carries the flag itself, and
 *   `makeDbMock` returns its queued rows whatever the WHERE clause says: only
 *   a real database can show the filters work. Each filter is in the plan's
 *   mutation list (E3 rows 11 to 14) against this file.
 * ★ Every read runs as production runs it: `withService` on a savepoint under
 *   `SET ROLE app_service`, on this file's one connection, one at a time, so
 *   it sees this transaction's fixtures and blocks.
 * ★ Fixtures, all inside the transaction, on the local store `echo`: three of
 *   its published products (G, the cart product and free gift that gets
 *   blocked, with 50 in stock; K, the control; V, a product with variants
 *   that gets blocked), a new collection C (blocked), two policy pages (the
 *   refund policy blocked, the terms the control), and five published code
 *   offers (scoped to G, to a variant of V, to C, a free G, and one scoped to
 *   K). The offers' deferred checks would run only at commit, which never
 *   comes.
 * ★ Nothing reaches a network: `fetch` throws, and the carrier quote and
 *   fulfilment routing are stubbed (the store's delivery policy is the
 *   default free one).
 */
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";

const enabled = process.env.MODERATION_LOCAL_TEST === "1";

const scope = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  pending: Promise.resolve(),
}));
vi.mock("@/lib/db/client", () => {
  /** One scope at a time on the one connection, each on its own savepoint
   *  (two at once would interleave their savepoints). */
  async function run<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const previous = scope.pending;
    let release!: () => void;
    scope.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `t9_scope_${++scope.count}`;
    const client = scope.client!;
    await client.query(`SAVEPOINT ${name}`);
    try {
      await client.query("SET ROLE app_service");
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
    withService: <T>(fn: (db: Db) => Promise<T>) => run(fn),
    withAnon: () => {
      throw new Error("No read under test is anonymous.");
    },
    withUser: () => {
      throw new Error("No read under test signs anyone in.");
    },
  };
});
vi.mock("@/lib/shipping/quote", async () => {
  const { DEFAULT_SHIPPING_SETTINGS } = await import("@/lib/shipping/types");
  return {
    readShippingSettings: vi.fn(async () => DEFAULT_SHIPPING_SETTINGS),
    quoteShippingForOrder: vi.fn(async () => {
      throw new Error("No carrier calls in this test.");
    }),
  };
});
vi.mock("@/lib/fulfilment/resolve", () => ({
  resolveFulfilmentLocation: vi.fn(async () => null),
}));
// Imported by the offer loader's module for other functions; never used here.
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({ getCurrentStore: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/observability/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/logger")>()),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import {
  readCartProducts,
  readGiftProduct,
} from "@/lib/checkout/product-reads";
import { loadLiveOffers } from "@/lib/offers/resolve";
import { estimateProductDelivery } from "@/lib/shipping/product-delivery";
import { getLivePolicies } from "@/lib/legal/store-consent";
import { readMinkShopperOffers } from "@/lib/mink/offers-read";
import { forgetBlockedObjects } from "@/lib/moderation/blocked-objects";

type Row = Record<string, unknown>;

const OPERATOR = "op@storemink.com";
const CASE_MS = 30_000;
const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();

describe.skipIf(!enabled)(
  "the service-scope reads that serve shoppers (local database)",
  () => {
    let client: Client;
    let echoId = "";
    let giftId = ""; // G
    let giftName = "";
    let controlId = ""; // K
    let controlName = "";
    let variantProductId = ""; // V
    let variantProductName = "";
    let variantId = "";
    let collectionId = ""; // C
    const collectionName = `T9 blocked collection ${tag}`;
    let refundPageId = "";
    const offerIds: Record<string, string> = {};
    const offerNames = {
      onG: `T9 on G ${tag}`,
      onV: `T9 on V ${tag}`,
      onC: `T9 on C ${tag}`,
      giftG: `T9 gift G ${tag}`,
      onK: `T9 on K ${tag}`,
    };
    const blockIds: string[] = [];

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

    async function offer(
      name: string,
      code: string,
      rewardType: string,
      rewardConfig: Row,
      scopeTarget: Row | null,
    ): Promise<string> {
      const id = idOf(
        await one(
          `insert into public.offers
           (store_id, name, status, delivery, code, show_on_storefront,
            trigger_type, reward_type, reward_config)
         values ($1, $2, 'active', 'code', $3, true, 'always', $4, $5::jsonb)
         returning id`,
          [echoId, name, code, rewardType, JSON.stringify(rewardConfig)],
        ),
      );
      if (scopeTarget) {
        const keys = Object.keys(scopeTarget);
        await client.query(
          `insert into public.offer_products (offer_id, store_id, ${keys.join(", ")})
         values ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(", ")})`,
          [id, echoId, ...keys.map((key) => scopeTarget[key])],
        );
      }
      return id;
    }

    async function readEverything() {
      const cart = await withService((db) =>
        readCartProducts(db, echoId, [giftId, variantProductId, controlId]),
      );
      const gift = await withService((db) =>
        readGiftProduct(db, echoId, giftId),
      );
      const live = await withService((db) => loadLiveOffers(db, echoId, null));
      const delivery = await estimateProductDelivery(echoId, {
        productId: giftId,
        variantId: null,
        quantity: 1,
        postalCode: "560001",
      });
      const policies = await getLivePolicies(echoId);
      const mink = await readMinkShopperOffers(
        { storeId: echoId, effectivePlan: "pro" },
        { limit: 20 },
      );
      return { cart, gift, live, delivery, policies, mink };
    }
    type Read = Awaited<ReturnType<typeof readEverything>>;

    const giftAvailable = (read: Read) =>
      read.live.find((o) => o.id === offerIds.giftG)?.giftAvailable;
    const minkNames = (read: Read) => read.mink.offers.map((o) => o.name);

    function expectEverythingVisible(read: Read) {
      expect(read.cart.map((p) => p.id).sort()).toEqual(
        [giftId, variantProductId, controlId].sort(),
      );
      expect(read.gift?.id).toBe(giftId);
      expect(giftAvailable(read)).toBe(true);
      expect(read.delivery.available).toBe(true);
      expect(read.policies.map((p) => p.slug)).toEqual([
        "terms",
        "refund-policy",
      ]);
      expect(minkNames(read).sort()).toEqual(Object.values(offerNames).sort());
      const told = JSON.stringify(read.mink);
      expect(told).toContain(giftName);
      expect(told).toContain(variantProductName);
      expect(told).toContain(collectionName);
      expect(told).toContain(controlName);
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

      const simple = await rows(
        `select p.id, p.name from public.products p
        where p.store_id = $1 and p.status = 'published'
          and p.moderation_blocked_at is null
          and not exists (select 1 from public.product_variants v
                          where v.product_id = p.id)
        order by p.sort_order, p.created_at, p.id limit 2`,
        [echoId],
      );
      if (simple.length < 2) {
        throw new Error(
          "The local store echo needs two published products without variants.",
        );
      }
      [giftId, controlId] = simple.map((p) => String(p.id));
      [giftName, controlName] = simple.map((p) => String(p.name));
      const withVariants = await one(
        `select p.id, p.name, v.id as variant_id from public.products p
          join public.product_variants v on v.product_id = p.id
        where p.store_id = $1 and p.status = 'published'
          and p.moderation_blocked_at is null
        order by p.sort_order, p.created_at, p.id, v.sort_order, v.id limit 1`,
        [echoId],
      );
      if (!withVariants) {
        throw new Error(
          "The local store echo needs a published product with variants.",
        );
      }
      variantProductId = String(withVariants.id);
      variantProductName = String(withVariants.name);
      variantId = String(withVariants.variant_id);

      // G has stock to give, so only the block can make its gift unavailable.
      const stocked = await client.query(
        `update public.inventory_levels set on_hand = 50, reserved = 0
        where store_id = $1 and product_id = $2 and variant_id is null`,
        [echoId, giftId],
      );
      if (stocked.rowCount === 0) {
        await client.query(
          `insert into public.inventory_levels
             (store_id, location_id, product_id, variant_id, on_hand, reserved)
           select $1, l.id, $2, null, 50, 0 from public.store_locations l
            where l.store_id = $1 order by l.is_default desc, l.sort_order limit 1`,
          [echoId, giftId],
        );
      }

      collectionId = idOf(
        await one(
          `insert into public.categories (store_id, name, slug, status)
         values ($1, $2, $3, 'active') returning id`,
          [echoId, collectionName, `t9-${tag.toLowerCase()}-blocked`],
        ),
      );

      const policyPage = (slug: string, title: string) =>
        one(
          `insert into public.store_pages
           (store_id, slug, title, status, sections, published_sections, published_at)
         values ($1, $2, $3, 'published', $4::jsonb, $4::jsonb, now())
         on conflict (store_id, slug) do update
           set status = 'published', title = excluded.title,
               sections = excluded.sections,
               published_sections = excluded.published_sections,
               published_at = now()
         returning id`,
          [
            echoId,
            slug,
            title,
            JSON.stringify([
              {
                id: "policy-body",
                type: "rich_text",
                enabled: true,
                config: { html: `<p>The ${title} for T9 ${tag}.</p>` },
              },
            ]),
          ],
        );
      idOf(await policyPage("terms", "Terms & Conditions"));
      refundPageId = idOf(
        await policyPage("refund-policy", "Refund & Cancellation Policy"),
      );

      offerIds.onG = await offer(
        offerNames.onG,
        `T9${tag}G`,
        "percent_off_items",
        { percent: 10 },
        { product_id: giftId },
      );
      offerIds.onV = await offer(
        offerNames.onV,
        `T9${tag}V`,
        "percent_off_items",
        { percent: 10 },
        { variant_id: variantId },
      );
      offerIds.onC = await offer(
        offerNames.onC,
        `T9${tag}C`,
        "percent_off_items",
        { percent: 10 },
        { category_id: collectionId },
      );
      offerIds.giftG = await offer(
        offerNames.giftG,
        `T9${tag}F`,
        "free_item",
        { giftProductId: giftId, giftQuantity: 1 },
        null,
      );
      offerIds.onK = await offer(
        offerNames.onK,
        `T9${tag}K`,
        "percent_off_items",
        { percent: 10 },
        { product_id: controlId },
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
        expectEverythingVisible(await readEverything());
      },
      CASE_MS,
    );

    it(
      "after a block, none of the reads returns or names a blocked item",
      async () => {
        blockIds.push(
          await block({
            item_kind: "product",
            item_id: giftId,
            item_label: "A gift product",
          }),
          await block({
            item_kind: "product",
            item_id: variantProductId,
            item_label: "A product with variants",
          }),
          await block({
            item_kind: "collection",
            item_id: collectionId,
            item_label: "A collection",
          }),
          await block({
            item_kind: "page",
            item_id: refundPageId,
            item_label: "The refund policy",
          }),
        );
        forgetBlockedObjects();
        const read = await readEverything();

        // E3 row 11: the cart and the gift reads.
        expect(read.cart.map((p) => p.id)).toEqual([controlId]);
        expect(read.gift).toBeNull();
        // E3 row 12: the offer engine never offers a blocked gift, stock or
        // not.
        expect(giftAvailable(read)).toBe(false);
        // E3 row 13: the delivery estimate and the store's policies.
        expect(read.delivery).toEqual({
          available: false,
          postalCode: "560001",
          kind: "physical",
          error: "This product is no longer available.",
        });
        expect(read.policies.map((p) => p.slug)).toEqual(["terms"]);
        // E3 row 14: Mink AI tells only the control offer, and names nothing
        // blocked.
        expect(minkNames(read)).toEqual([offerNames.onK]);
        const told = JSON.stringify(read.mink);
        expect(told).not.toContain(giftName);
        expect(told).not.toContain(variantProductName);
        expect(told).not.toContain(collectionName);
        expect(told).toContain(controlName);
      },
      CASE_MS,
    );

    it(
      "after the lift, every read returns everything again",
      async () => {
        expect(blockIds).toHaveLength(4);
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
        expectEverythingVisible(await readEverything());
      },
      CASE_MS,
    );
  },
);
