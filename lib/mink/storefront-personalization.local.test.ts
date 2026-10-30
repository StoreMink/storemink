/** Rollback-only end-to-end checks of a storefront personalisation: the real
 * proposal path (only the copywriter, the image model and the bucket are
 * faked), then the real preview and the real write, against local Postgres.
 * Run with MINK_PERSONALIZATION_LOCAL_TEST=1; the fixed loopback database
 * keeps it away from Cloud SQL. */
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
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import type { Db } from "@/lib/db/client";
import type { MinkActorContext } from "./types";
import type { PersonalizationWriterInput } from "./storefront-personalization-writer";

const BUCKET = "https://storage.googleapis.com/storemink-media";

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
    const name = `personalization_${++service.count}`;
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
// ★ Photos go through the store's one writer (takedown design 5.7).
vi.mock("@/lib/storage/store-objects", () => ({
  writeStoreObject: vi.fn(async (path: string) => `${BUCKET}/${path}`),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsDeletePaths: vi.fn(async () => []),
  gcsPublicUrl: (path: string) => `${BUCKET}/${path}`,
  gcsPathFromUrl: (url: string) =>
    url.startsWith(`${BUCKET}/`) ? url.slice(BUCKET.length + 1) : null,
}));
vi.mock("./media-generation", async (importOriginal) => ({
  // The real `isUnbilledImageFailure`, which a failed photo is checked with.
  ...(await importOriginal<typeof import("./media-generation")>()),
  generateMinkMediaImage: vi.fn(async () => ({
    bytes: Buffer.from("jpeg"),
    mimeType: "image/jpeg",
  })),
}));
vi.mock("./storefront-personalization-writer", () => ({
  writePersonalizationCopy: vi.fn(
    async (input: PersonalizationWriterInput) => ({
      texts: new Map(
        input.pages.flatMap((page) =>
          page.texts.map((text) => [
            text.ref,
            `Candles: ${text.label.toLowerCase()}`,
          ]),
        ),
      ),
      lists: new Map(),
      photos: new Map(
        input.photos.map((photo) => [
          photo.ref,
          {
            scene: "Amber soy candles on linen in soft light",
            alt: "Amber candles",
          },
        ]),
      ),
      chrome: {
        announcement: "Free shipping over Rs 999",
        tagline: "Candles for slow evenings",
      },
      categoryDescriptions: new Map(),
      model: "fake",
      attempts: 1,
    }),
  ),
}));

// ★ A personalisation rewrites only the theme's own sections, found by
//   comparing a page with what the store's theme installs. The fixture store
//   is pinned to a theme whose homepage is exactly these two sections, and its
//   homepage row is that install, as a real store's is.
const FIXTURE_HOME = [
  {
    type: "hero",
    enabled: true,
    config: {
      variant: "banner",
      heading: "Fresh produce, delivered",
      subheading: "From farm to door",
      cta_label: "Shop now",
      cta_href: "/shop",
      image_url: "/themes/basket/hero.webp",
      height: "large",
    },
  },
  {
    type: "testimonials",
    enabled: true,
    config: {
      heading: "Loved by thousands",
      items: [{ quote: "Best grocer in town", name: "Asha", role: "" }],
    },
  },
];
const theme = vi.hoisted(() => ({ definition: null as unknown }));
vi.mock("@/lib/themes/runtime-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/themes/runtime-registry")>()),
  resolveInstalledThemeDefinitionWithDb: vi.fn(async () => theme.definition),
}));

import { THEME_DEFINITIONS } from "@/lib/themes";
import { prepareSections } from "@/lib/themes/apply";
import type { ThemeDefinition } from "@/lib/themes/types";
import { createMinkStorefrontPersonalizationProposal } from "./storefront-personalization-proposals";
import { writePersonalizationCopy } from "./storefront-personalization-writer";
import {
  executeMinkStorefrontPersonalizationAction,
  getLatestMinkStorefrontPersonalizationAction,
  previewMinkStorefrontPersonalizationAction,
} from "./storefront-personalization-actions";

const enabled = process.env.MINK_PERSONALIZATION_LOCAL_TEST === "1";
describe.skipIf(!enabled)(
  "storefront personalisation, end to end on local Postgres",
  () => {
    let client: Client;
    let actor: MinkActorContext;
    let homeId: string;
    let categoryId: string;
    let productId: string;

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.USER,
        types: postgresStringTimestampTypes,
      });
      const basket = THEME_DEFINITIONS.find((entry) => entry.id === "basket")!;
      theme.definition = {
        ...basket,
        preset: {
          ...basket.preset,
          pages: basket.preset.pages.map((page) =>
            page.slug === ""
              ? { ...page, sections: FIXTURE_HOME as never }
              : page,
          ),
        },
      } satisfies ThemeDefinition;
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
          entry.id === "20261020_0232_mink_storefront_personalization",
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

    beforeEach(async () => {
      await client.query("SAVEPOINT personalization_fixture");
      const storeId = crypto.randomUUID();
      actor = {
        storeId,
        adminId: "personalization-owner",
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
        runId: crypto.randomUUID(),
        draftingEnabled: true,
      };
      // The store trigger provisions Mink access and every action tool.
      await client.query(
        "insert into stores(id,slug,name,status,plan,settings) values($1,$2,'Lumen','active','pro',$3)",
        [
          storeId,
          `personalize-${storeId}`,
          {
            template: "basket",
            brand: { name: "Lumen", tagline: "Fresh groceries" },
          },
        ],
      );
      const conversationId = crypto.randomUUID();
      await client.query(
        "insert into mink_conversations(id,store_id,admin_id,title) values($1,$2,$3,'Personalise')",
        [conversationId, storeId, actor.adminId],
      );
      await client.query(
        "insert into mink_runs(id,store_id,conversation_id,requested_by,request_id,model) values($1,$2,$3,$4,$5,'fixture')",
        [actor.runId, storeId, conversationId, actor.adminId, actor.requestId],
      );
      homeId = crypto.randomUUID();
      const installed = prepareSections(
        theme.definition as ThemeDefinition,
        "",
      );
      if ("error" in installed) throw new Error(installed.error);
      await client.query(
        "insert into store_pages(id,store_id,slug,title,status,sections,published_sections) values($1,$2,'','Home','published',$3,$3)",
        [
          homeId,
          storeId,
          JSON.stringify(
            installed.sections.map((section, index) => ({
              ...section,
              id: ["hero", "quotes"][index],
            })),
          ),
        ],
      );
      const chrome = structuredClone(DEFAULT_CHROME);
      chrome.header.announcement = {
        enabled: true,
        text: "Free delivery over Rs 499",
        href: "",
      };
      await client.query(
        "insert into store_chrome(store_id,draft,published) values($1,$2,$2)",
        [storeId, chrome],
      );
      categoryId = (
        await client.query(
          "insert into categories(store_id,name,slug,status) values($1,'Fruit','fruit','active') returning id",
          [storeId],
        )
      ).rows[0].id;
      productId = (
        await client.query(
          "insert into products(store_id,name,slug,status,published_at) values($1,'Apples (Sample)','apples-sample','published',now()) returning id",
          [storeId],
        )
      ).rows[0].id;
    });

    afterEach(async () => {
      await client.query("ROLLBACK TO SAVEPOINT personalization_fixture");
      await client.query("RELEASE SAVEPOINT personalization_fixture");
    });

    async function propose(extra: Record<string, unknown> = {}) {
      return createMinkStorefrontPersonalizationProposal({
        actor,
        args: {
          brief: {
            what_you_sell: "Hand-poured soy candles",
            look_and_feel: "Warm and calm",
          },
          unpublish_sample_products: true,
          explanation: "Makes the store about candles.",
          categories: [
            {
              action: "update",
              slug: "fruit",
              name: "Pillar candles",
              merchant_confirmed: true,
            },
          ],
          ...extra,
        },
      });
    }

    async function row<T>(sqlText: string, params: unknown[]): Promise<T> {
      return (await client.query(sqlText, params)).rows[0] as T;
    }

    it("★★ proposes, charges once, then applies every part under one approval and one audit row", async () => {
      const proposal = await propose();
      expect(proposal.photos).toHaveLength(1);
      // Charged for what it made: the homepage (3), one photo (3), the header
      // and store description (2) and one category (category_update's price).
      const draft = await row<{
        expected_credits: number;
        charged_credits: number;
        kind: string;
      }>(
        "select expected_credits, charged_credits, kind from mink_drafts where id=$1",
        [proposal.draftId],
      );
      expect(draft.kind).toBe("storefront_personalization");
      expect(draft.charged_credits).toBe(draft.expected_credits);
      expect(draft.expected_credits).toBeGreaterThanOrEqual(9);

      // Nothing has changed on the store yet.
      const before = await row<{
        sections: Array<{ config: { heading: string } }>;
      }>("select sections from store_pages where id=$1", [homeId]);
      expect(before.sections[0].config.heading).toBe(
        "Fresh produce, delivered",
      );

      const approval = await previewMinkStorefrontPersonalizationAction({
        actor,
        draftId: proposal.draftId,
        expectedDraftVersion: 0,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(approval).toMatchObject({
        status: "pending",
        toolName: "apply_storefront_personalization",
        resource: { type: "storefront", id: actor.storeId },
        chromeChanged: true,
      });
      const result = await executeMinkStorefrontPersonalizationAction({
        actor,
        draftId: proposal.draftId,
        approvalId: approval.id,
      });
      expect(result.repeated).toBe(false);
      expect(result.approval.status).toBe("executed");

      const page = await row<{
        sections: Array<{
          id: string;
          enabled: boolean;
          config: Record<string, unknown>;
        }>;
        published_sections: Array<{ config: Record<string, unknown> }>;
      }>("select sections, published_sections from store_pages where id=$1", [
        homeId,
      ]);
      const hero = page.sections.find((entry) => entry.id === "hero")!;
      expect(hero.config.heading).toBe("Candles: heading");
      expect(hero.config.image_url).toMatch(/\/mink-generated\/.+\.jpg$/);
      expect(hero.config.cta_href).toBe("/shop");
      expect(
        page.sections.find((entry) => entry.id === "quotes")!.enabled,
      ).toBe(false);
      // ★ The draft changed; the live page did not.
      expect(page.published_sections[0].config.heading).toBe(
        "Fresh produce, delivered",
      );

      const chrome = await row<{
        draft: { header: { announcement: { text: string } } };
        published: { header: { announcement: { text: string } } };
      }>("select draft, published from store_chrome where store_id=$1", [
        actor.storeId,
      ]);
      expect(chrome.draft.header.announcement.text).toBe(
        "Free shipping over Rs 999",
      );
      expect(chrome.published.header.announcement.text).toBe(
        "Free delivery over Rs 499",
      );

      const store = await row<{ settings: { brand: Record<string, string> } }>(
        "select settings from stores where id=$1",
        [actor.storeId],
      );
      expect(store.settings.brand).toMatchObject({
        name: "Lumen",
        tagline: "Candles for slow evenings",
      });
      expect(
        (
          await row<{ name: string }>(
            "select name from categories where id=$1",
            [categoryId],
          )
        ).name,
      ).toBe("Pillar candles");
      expect(
        (
          await row<{ status: string }>(
            "select status from products where id=$1",
            [productId],
          )
        ).status,
      ).toBe("draft");
      expect(
        (
          await row<{ count: number }>(
            "select count(*)::int as count from mink_action_audit where approval_id=$1 and outcome='executed'",
            [approval.id],
          )
        ).count,
      ).toBe(1);

      // ★ A second press replays the result, writing nothing twice.
      const again = await executeMinkStorefrontPersonalizationAction({
        actor,
        draftId: proposal.draftId,
        approvalId: approval.id,
      });
      expect(again.repeated).toBe(true);
      const latest = await getLatestMinkStorefrontPersonalizationAction(
        actor,
        proposal.draftId,
      );
      expect(latest?.auditId).toBe(result.auditId);
    }, 60_000);

    it("★★ writes the footer over the store's own menus when it has no header and footer row yet", async () => {
      // A store whose links still live in store_menus shows those links, so
      // the first header and footer draft starts from them: never from the
      // platform's stock links, which would replace the merchant's menu.
      await client.query("delete from store_chrome where store_id=$1", [
        actor.storeId,
      ]);
      await client.query(
        "insert into store_menus(store_id,header,footer_groups,footer_legal) values($1,$2,$3,$4)",
        [
          actor.storeId,
          JSON.stringify([{ label: "Candles", href: "/collections/fruit" }]),
          JSON.stringify([
            {
              title: "Help",
              links: [{ label: "Contact us", href: "/enquiries" }],
            },
          ]),
          JSON.stringify([{ label: "Privacy", href: "/privacy-policy" }]),
        ],
      );
      const writer = vi.mocked(writePersonalizationCopy);
      const base = writer.getMockImplementation()!;
      writer.mockImplementationOnce(async (input) => {
        const copy = await base(input);
        return {
          ...copy,
          chrome: { ...copy.chrome, newsletterHeading: "Candle notes" },
        };
      });

      const proposal = await propose();
      const approval = await previewMinkStorefrontPersonalizationAction({
        actor,
        draftId: proposal.draftId,
        expectedDraftVersion: 0,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(approval.chromeChanged).toBe(true);
      const result = await executeMinkStorefrontPersonalizationAction({
        actor,
        draftId: proposal.draftId,
        approvalId: approval.id,
      });
      expect(result.approval.status).toBe("executed");

      const chrome = await row<{
        draft: {
          header: { links: Array<{ label: string; href: string }> };
          footer: {
            groups: Array<{ title: string }>;
            newsletter: { heading: string };
          };
        };
      }>("select draft from store_chrome where store_id=$1", [actor.storeId]);
      expect(chrome.draft.header.links).toEqual([
        expect.objectContaining({
          label: "Candles",
          href: "/collections/fruit",
        }),
      ]);
      expect(chrome.draft.footer.groups.map((group) => group.title)).toEqual([
        "Help",
      ]);
      expect(chrome.draft.footer.newsletter.heading).toBe("Candle notes");
    }, 60_000);

    it("★★ refuses the whole plan and records a conflict when one part moved after the preview", async () => {
      const proposal = await propose();
      const approval = await previewMinkStorefrontPersonalizationAction({
        actor,
        draftId: proposal.draftId,
        expectedDraftVersion: 0,
        idempotencyKey: crypto.randomUUID(),
      });
      // The merchant renames the category in another tab.
      await client.query(
        "update categories set name='Seasonal fruit', updated_at=now() + interval '1 second' where id=$1",
        [categoryId],
      );
      await expect(
        executeMinkStorefrontPersonalizationAction({
          actor,
          draftId: proposal.draftId,
          approvalId: approval.id,
        }),
      ).rejects.toMatchObject({ status: 409 });
      // Nothing else was written either.
      const page = await row<{
        sections: Array<{ config: { heading: string } }>;
      }>("select sections from store_pages where id=$1", [homeId]);
      expect(page.sections[0].config.heading).toBe("Fresh produce, delivered");
      expect(
        (
          await row<{ status: string }>(
            "select status from products where id=$1",
            [productId],
          )
        ).status,
      ).toBe("published");
      expect(
        (
          await row<{ outcome: string }>(
            "select outcome from mink_action_audit where approval_id=$1",
            [approval.id],
          )
        ).outcome,
      ).toBe("conflicted");
    }, 60_000);

    it("refuses a preview once the store already moved", async () => {
      const proposal = await propose();
      await client.query(
        "update store_pages set sections = jsonb_set(sections, '{0,config,heading}', '\"My own words\"'), updated_at = now() + interval '1 second' where id=$1",
        [homeId],
      );
      await expect(
        previewMinkStorefrontPersonalizationAction({
          actor,
          draftId: proposal.draftId,
          expectedDraftVersion: 0,
          idempotencyKey: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 409 });
    }, 60_000);

    it("refuses an approval for another store's admin", async () => {
      const proposal = await propose();
      const stranger = { ...actor, adminId: "someone-else" };
      await expect(
        previewMinkStorefrontPersonalizationAction({
          actor: stranger,
          draftId: proposal.draftId,
          expectedDraftVersion: 0,
          idempotencyKey: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: "mink_personalization_draft_unavailable",
      });
    }, 60_000);
  },
);
