/** The whole storefront revamp chain against the real local database: a
 * store with a theme installed, a merchant's request, the real job, the real
 * runner and every real step (on the offline fakes), the real Apply through
 * the personalisation actions, then Publish and Undo, each run twice.
 *
 * Run with MINK_REVAMP_LOCAL_TEST=1. The fixed loopback database keeps it
 * away from Cloud SQL.
 *
 * ★ REAL TRANSACTIONS, NOT ONE ROLLED BACK. The other local revamp tests run
 *   inside one transaction, where `now()` never moves and a lease never
 *   lapses; the chain here needs the database to behave as it does in
 *   production (every `withService` its own committed transaction, the
 *   runner's leases, the page and product triggers moving `updated_at`), so
 *   it uses the real `lib/db/client` and deletes the store it made in
 *   `afterAll`, whether or not a test failed. The store cascade removes every
 *   row the chain wrote for it.
 * ★ ONLY THE OUTSIDE WORLD IS FAKED: the media bucket (in memory), the
 *   runner's self-kick, notifications, the search-engine hook and Next's
 *   cache and `after()`. Models are the revamp's own offline fakes
 *   (MINK_REVAMP_PROVIDER=fake). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import type { PageSectionItem } from "@/lib/sections/registry";
import type { MinkActorContext } from "../types";
import type {
  RevampRequest,
  RevampStatusView,
  RevampStoredPlan,
} from "./contract";
import type {
  RevampApplySnapshot,
  RevampPublishSnapshot,
} from "./lifecycle-types";

const memory = vi.hoisted(() => {
  // ★ Set before any module reads them: the real database client builds its
  //   pool from these on first use, and the steps pick the fakes from the
  //   provider variable on every call.
  if (process.env.MINK_REVAMP_LOCAL_TEST === "1") {
    process.env.DB_HOST = "127.0.0.1";
    process.env.DB_PORT = "5544";
    process.env.DB_NAME = "storemink_local";
    process.env.DB_USER = process.env.USER ?? "postgres";
    process.env.DB_POOL_MAX = "4";
    delete process.env.DB_PASSWORD;
    process.env.MINK_REVAMP_PROVIDER = "fake";
  }
  return {
    bucket: "revamp-e2e-bucket",
    objects: new Map<string, { bytes: Uint8Array; contentType: string }>(),
    kick: vi.fn(async (_revampId: string) => undefined),
    emit: vi.fn((_event: unknown) => undefined),
    record: vi.fn(async (_event: unknown) => undefined),
    notify: vi.fn(
      async (_input: { storeId: string; paths: string[] }) => undefined,
    ),
    after: vi.fn((task: unknown) => {
      if (typeof task === "function") void (task as () => unknown)();
    }),
  };
});

vi.mock("@/lib/storage/gcs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage/gcs")>();
  const prefix = `/${memory.bucket}/`;
  const publicUrl = (path: string) =>
    `https://${real.GCS_PUBLIC_HOST}/${memory.bucket}/${path}`;
  return {
    ...real,
    GCS_BUCKET_NAME: memory.bucket,
    gcsConfigured: true,
    gcsPublicUrl: publicUrl,
    gcsPathFromUrl(url: string): string | null {
      try {
        const parsed = new URL(url);
        if (
          parsed.protocol !== "https:" ||
          parsed.hostname !== real.GCS_PUBLIC_HOST ||
          !parsed.pathname.startsWith(prefix)
        ) {
          return null;
        }
        const path = parsed.pathname.slice(prefix.length);
        return path && !path.split("/").includes("..") ? path : null;
      } catch {
        return null;
      }
    },
    async gcsUploadObject(
      path: string,
      bytes: Uint8Array,
      contentType: string,
    ) {
      memory.objects.set(path, { bytes: new Uint8Array(bytes), contentType });
      return publicUrl(path);
    },
    async gcsObjectInfo(_kind: string, path: string) {
      const object = memory.objects.get(path);
      return object
        ? { size: object.bytes.length, contentType: object.contentType }
        : null;
    },
    async gcsDownloadObject(path: string, maxBytes: number) {
      const object = memory.objects.get(path);
      if (!object) throw new Error("No such object.");
      if (object.bytes.length > maxBytes) throw new Error("Too large.");
      return new Uint8Array(object.bytes);
    },
    async gcsDeletePaths(paths: string[]) {
      for (const path of paths) memory.objects.delete(path);
      return [];
    },
    async gcsDeletePrefix(path: string) {
      for (const key of [...memory.objects.keys()]) {
        if (key.startsWith(path)) memory.objects.delete(key);
      }
    },
  };
});
vi.mock("./trigger", () => ({ kickRevampRunner: memory.kick }));
vi.mock("@/lib/notifications/record", () => ({
  emitEvent: memory.emit,
  recordEvent: memory.record,
}));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: memory.notify,
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: memory.after,
}));

const OWNER = "revamp-e2e-owner";

interface PageRow {
  id: string;
  slug: string;
  title: string;
  seo_title: string;
  seo_description: string;
  status: string;
  sections: PageSectionItem[];
  published_sections: PageSectionItem[];
  published_at: string | null;
}

interface StoreState {
  pages: PageRow[];
  chrome: {
    draft: unknown;
    published: unknown;
    published_at: string | null;
  } | null;
  brand: { tagline: string | null; blurb: string | null };
  categories: Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    image_url: string | null;
    status: string;
  }>;
  products: Array<{
    id: string;
    slug: string;
    name: string;
    status: string;
    published_at: string | null;
    category_id: string | null;
  }>;
}

const enabled = process.env.MINK_REVAMP_LOCAL_TEST === "1";
describe.skipIf(!enabled)(
  "storefront revamp, end to end on local Postgres",
  () => {
    let client: Client;
    let storeId: string;
    let actor: MinkActorContext;
    let revampId: string;
    let photos: string[];
    let before: StoreState;
    let plan: RevampStoredPlan;
    let approvalId: string;
    let closePool: () => Promise<void>;

    // The real modules, imported only when the suite runs.
    let jobs: typeof import("./jobs");
    let runner: typeof import("./runner");
    let deps: typeof import("./deps");
    let actions: typeof import("../storefront-personalization-actions");
    let lifecycle: typeof import("./publish");

    async function rows<T>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await client.query(text, params)).rows as T[];
    }

    async function one<T>(text: string, params: unknown[] = []): Promise<T> {
      const [row] = await rows<T>(text, params);
      return row;
    }

    async function storeState(): Promise<StoreState> {
      const settings = await one<{ settings: Record<string, unknown> }>(
        "select settings from stores where id = $1",
        [storeId],
      );
      const brand = (settings.settings.brand ?? {}) as Record<string, unknown>;
      const chrome = await rows<StoreState["chrome"] & object>(
        "select draft, published, published_at from store_chrome where store_id = $1",
        [storeId],
      );
      return {
        pages: await rows<PageRow>(
          `select id, slug, title, seo_title, seo_description, status, sections,
                published_sections, published_at
           from store_pages where store_id = $1 order by slug`,
          [storeId],
        ),
        chrome: chrome[0] ?? null,
        brand: {
          tagline: typeof brand.tagline === "string" ? brand.tagline : null,
          blurb: typeof brand.blurb === "string" ? brand.blurb : null,
        },
        categories: await rows(
          `select id, slug, name, description, image_url, status
           from categories where store_id = $1 order by slug`,
          [storeId],
        ),
        products: await rows(
          `select id, slug, name, status, published_at, category_id
           from products where store_id = $1 order by slug`,
          [storeId],
        ),
      };
    }

    async function revampRow() {
      return one<{
        status: string;
        draft_id: string | null;
        free: boolean;
        credits: number;
        error_code: string | null;
        error_detail: string | null;
        applied_at: string | null;
        published_at: string | null;
        undone_at: string | null;
        apply_snapshot: RevampApplySnapshot | null;
        publish_snapshot: RevampPublishSnapshot | null;
      }>("select * from mink_revamps where id = $1", [revampId]);
    }

    beforeAll(async () => {
      const pg = await import("pg");
      const { postgresStringTimestampTypes } =
        await import("@/lib/db/pg-types");
      client = new pg.Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      jobs = await import("./jobs");
      runner = await import("./runner");
      deps = await import("./deps");
      actions = await import("../storefront-personalization-actions");
      lifecycle = await import("./publish");
      ({ closePool } = await import("@/lib/db/client"));
      const { applyTheme } = await import("@/lib/themes/apply");
      const sharp = (await import("sharp")).default;

      storeId = crypto.randomUUID();
      await client.query(
        `insert into stores(id, slug, name, status, plan, settings)
       values ($1, $2, 'Sarson Ghar', 'active', 'pro', $3)`,
        [
          storeId,
          `revamp-e2e-${storeId.slice(0, 8)}`,
          {
            launched: true,
            brand: { name: "Sarson Ghar" },
            business: { city: "Bharatpur", state: "Rajasthan" },
          },
        ],
      );
      await client.query(
        `insert into admins(id, email, role, store_id, force_password_reset, first_name)
       values ($1, 'owner@sarson.example', 'superadmin', $2, false, 'Asha')`,
        [`${OWNER}-${storeId.slice(0, 8)}`, storeId],
      );
      // ★ Basket, because it is the bundled theme whose samples carry the
      //   "(Sample)" mark the revamp recognises (Vitrine, Studio and Ritual do
      //   not), so taking the samples off the shop is exercised. They are
      //   published here, as on a store set up before samples began seeding
      //   as drafts.
      const installed = await applyTheme(storeId, "basket", {
        publish: true,
        publishSampleProducts: true,
      });
      expect(installed.errors).toEqual([]);

      // The merchant's two phone photos, saved to Media as a chat attachment.
      photos = [];
      for (const [index, colour] of [
        { r: 196, g: 152, b: 42 },
        { r: 70, g: 46, b: 30 },
      ].entries()) {
        const path = `stores/${storeId}/media/${crypto.randomUUID()}.jpg`;
        const bytes = await sharp({
          create: { width: 900, height: 900, channels: 3, background: colour },
        })
          .jpeg()
          .toBuffer();
        memory.objects.set(path, {
          bytes: new Uint8Array(bytes),
          contentType: "image/jpeg",
        });
        const url = `https://storage.googleapis.com/${memory.bucket}/${path}`;
        await client.query(
          `insert into media_assets(store_id, url, path, filename, content_type, size_bytes, source)
         values ($1, $2, $3, $4, 'image/jpeg', $5, 'mink_attachment')`,
          [storeId, url, path, `product-${index + 1}.jpg`, bytes.length],
        );
        photos.push(url);
      }

      const conversationId = crypto.randomUUID();
      const adminId = `${OWNER}-${storeId.slice(0, 8)}`;
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
      actor = {
        storeId,
        adminId,
        email: "owner@sarson.example",
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
      };

      // The request exactly as start_storefront_revamp reads the model's call.
      const { readRevampRequest } = await import("./request");
      const read = readRevampRequest(
        {
          brief: {
            business:
              "Cold-pressed mustard oil from our own mill, for home cooks who cook with it every day",
            look: "Warm, earthy and honest, like a village kitchen",
            audience: "Home cooks across India",
            facts: ["Pressed in our own mill in Bharatpur", "Family run"],
            avoid: "",
            language: "English",
          },
          products: [
            {
              name: "Kachi Ghani Mustard Oil",
              description: "Cold-pressed from black mustard seed in our mill.",
              sizes: [
                { label: "500 ml", price: 180, mrp: 200 },
                { label: "1 litre", price: 340, mrp: 380 },
              ],
              photo_url: photos[0],
              category_slug: "mustard-oil",
            },
            {
              name: "Black Mustard Seed",
              description: "Whole black mustard seed for tadka.",
              sizes: [{ label: "", price: 90, mrp: null }],
              photo_url: photos[1],
              // ★ request.ts never checks this against the store: Apply must
              //   file the product without a category, not fail.
              category_slug: "whole-spices",
            },
          ],
          categories: [
            {
              action: "create",
              name: "Mustard oil",
              slug: "mustard-oil",
              description: "Oil pressed in our own mill.",
              new_photo: false,
              merchant_confirmed: true,
            },
            { action: "hide", slug: "household", merchant_confirmed: true },
          ],
          pages: null,
        },
        "full",
      );
      if (!read.ok) throw new Error(read.issues.join(" "));
      const request: RevampRequest = read.value;
      const created = await jobs.createRevampJob({
        actor,
        conversationId,
        kind: "full",
        request,
        parentId: null,
        budgetCredits: null,
      });
      if (!created.ok) throw new Error(`refused: ${created.reason}`);
      expect(created.job.free).toBe(true);
      revampId = created.job.id;
      before = await storeState();
    }, 180_000);

    afterAll(async () => {
      // ★ Whatever happened above: the store cascade takes every row the chain
      //   wrote for it; the rate-limit counters keyed by the store are not
      //   children of it, so they go by name.
      if (client && storeId) {
        try {
          await client.query("begin");
          await client.query("set constraints all deferred");
          await client.query("delete from stores where id = $1", [storeId]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          await client.query("delete from rate_limits where key like $1", [
            `%${storeId}%`,
          ]);
        }
      }
      await client?.end();
      await closePool?.();
    }, 60_000);

    it("★★ builds the whole redesign in the background and makes one free card", async () => {
      let outcome = "";
      for (let pass = 0; pass < 6 && outcome !== "ready"; pass += 1) {
        ({ outcome } = await runner.runRevampJob({
          revampId,
          deps: deps.defaultRevampDeps(),
        }));
        if (outcome === "failed" || outcome === "cancelled") break;
        if (outcome === "not_claimed") {
          const job = await revampRow();
          throw new Error(
            `runner could not claim the job (${job.status}): ${job.error_detail ?? ""}`,
          );
        }
      }
      const job = await revampRow();
      expect(
        { outcome, code: job.error_code, detail: job.error_detail },
        "the runner's verdict",
      ).toEqual({ outcome: "ready", code: null, detail: null });
      expect(job.status).toBe("ready");
      // ★ The card is a draft whose id is the revamp's own, and it is free.
      expect(job.draft_id).toBe(revampId);
      expect(job.free).toBe(true);
      expect(job.credits).toBe(0);
      const draft = await one<{
        id: string;
        kind: string;
        status: string;
        charged_credits: number;
        expected_credits: number;
        credit_source: string | null;
        content_json: { plan_json: string };
      }>("select * from mink_drafts where id = $1 and store_id = $2", [
        revampId,
        storeId,
      ]);
      expect(draft).toMatchObject({
        kind: "storefront_personalization",
        status: "proposed",
        charged_credits: 0,
        expected_credits: 0,
        credit_source: "free",
      });
      plan = JSON.parse(draft.content_json.plan_json) as RevampStoredPlan;
      expect(plan.schemaVersion).toBe(2);
      expect(plan.revampId).toBe(revampId);
      expect(plan.products.create.map((product) => product.name)).toEqual([
        "Kachi Ghani Mustard Oil",
        "Black Mustard Seed",
      ]);
      // Every published theme sample comes off the shop.
      expect(plan.products.hide.length).toBeGreaterThan(0);
      expect(plan.products.hide.length).toBe(
        before.products.filter(
          (product) =>
            product.name.includes("(Sample)") && product.status === "published",
        ).length,
      );
      expect(memory.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "mink.revamp_ready",
          restrictToAdminIds: [actor.adminId],
        }),
      );

      // ★ The review lists, before the button, exactly what goes live at once.
      const view = (await jobs.readRevampStatus(
        actor,
        revampId,
      )) as RevampStatusView;
      expect(view.status).toBe("ready");
      expect(view.review?.liveChanges).toEqual([
        "Your categories",
        "Your 2 products go on your shop",
        "The theme's sample products are taken off your shop",
        ...(plan.brand ? [expect.stringMatching(/^Your store's /)] : []),
      ]);
      // Nothing on the store moved while the job ran.
      expect(await storeState()).toEqual(before);
    }, 300_000);

    it("★★ applies through the real approval: drafts, live catalogue, snapshot", async () => {
      const approval = await actions.previewMinkStorefrontPersonalizationAction(
        {
          actor,
          draftId: revampId,
          expectedDraftVersion: 0,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      approvalId = approval.id;
      const result = await actions.executeMinkStorefrontPersonalizationAction({
        actor,
        draftId: revampId,
        approvalId,
      });
      expect(result.repeated).toBe(false);
      expect(result.approval.status).toBe("executed");

      const after = await storeState();
      const pageBySlug = new Map(after.pages.map((page) => [page.slug, page]));
      const startBySlug = new Map(
        before.pages.map((page) => [page.slug, page]),
      );
      // ★ The redesign really proposes new titles or search text for pages that
      //   exist, or the "they wait for Publish" checks below prove nothing.
      expect(
        plan.pages.filter((planned) => {
          const start = planned.create
            ? undefined
            : startBySlug.get(planned.slug);
          return (
            start &&
            (start.title !== planned.title ||
              start.seo_title !== planned.seoTitle ||
              start.seo_description !== planned.seoDescription)
          );
        }).length,
      ).toBeGreaterThan(0);
      for (const planned of plan.pages) {
        const page = pageBySlug.get(planned.slug);
        expect(page, `page /${planned.slug}`).toBeDefined();
        expect(page!.sections).toEqual(planned.sections);
        if (planned.create) {
          // A page the redesign adds is a draft, with its own title already.
          expect(page).toMatchObject({
            status: "draft",
            published_sections: [],
            title: planned.title,
            seo_title: planned.seoTitle,
            seo_description: planned.seoDescription,
          });
          continue;
        }
        // ★★ The live page is untouched: its sections wait in the draft, and
        //    its title and search text wait for Publish (no draft layer).
        const start = startBySlug.get(planned.slug)!;
        expect(page).toMatchObject({
          status: start.status,
          published_sections: start.published_sections,
          published_at: start.published_at,
          title: start.title,
          seo_title: start.seo_title,
          seo_description: start.seo_description,
        });
      }
      // Header and footer: a draft only, so the shop still shows its menus.
      expect(before.chrome).toBeNull();
      expect(after.chrome?.published).toBeNull();
      expect(after.chrome?.draft).toEqual(
        expect.objectContaining({ header: expect.any(Object) }),
      );
      if (plan.brand?.tagline)
        expect(after.brand.tagline).toBe(plan.brand.tagline);
      if (plan.brand?.blurb) expect(after.brand.blurb).toBe(plan.brand.blurb);

      // Categories: the new one live, the hidden one hidden.
      const categoryBySlug = new Map(
        after.categories.map((category) => [category.slug, category]),
      );
      expect(categoryBySlug.get("mustard-oil")).toMatchObject({
        name: "Mustard oil",
        status: "active",
      });
      expect(categoryBySlug.get("household")?.status).toBe("hidden");

      // The merchant's products: published, priced, with sizes and photos.
      const oil = after.products.find(
        (product) => product.name === "Kachi Ghani Mustard Oil",
      )!;
      const seed = after.products.find(
        (product) => product.name === "Black Mustard Seed",
      )!;
      expect(oil).toMatchObject({
        status: "published",
        category_id: categoryBySlug.get("mustard-oil")!.id,
      });
      // ★ A category nobody has: filed without one, not a conflict.
      expect(seed).toMatchObject({ status: "published", category_id: null });
      const oilRow = await one<{
        selling_price: string;
        base_price: string;
        images: string[];
        image_url: string;
        track_inventory: boolean;
      }>("select * from products where id = $1", [oil.id]);
      expect(Number(oilRow.selling_price)).toBe(180);
      expect(Number(oilRow.base_price)).toBe(200);
      expect(oilRow.track_inventory).toBe(false);
      expect(oilRow.images).toHaveLength(2);
      expect(oilRow.images[1]).toBe(photos[0]);
      expect(oilRow.image_url).toContain("/mink-generated/revamp/");
      const variants = await rows<{
        name: string;
        selling_price: string;
        base_price: string;
        option_values: string[];
      }>(
        "select name, selling_price, base_price, option_values from product_variants where product_id = $1 order by sort_order",
        [oil.id],
      );
      expect(
        variants.map((variant) => ({
          name: variant.name,
          price: Number(variant.selling_price),
          mrp: Number(variant.base_price),
          values: variant.option_values,
        })),
      ).toEqual([
        { name: "500 ml", price: 180, mrp: 200, values: ["500 ml"] },
        { name: "1 litre", price: 340, mrp: 380, values: ["1 litre"] },
      ]);
      expect(
        await rows("select id from product_variants where product_id = $1", [
          seed.id,
        ]),
      ).toEqual([]);

      // Every published sample is a draft now.
      for (const sample of plan.products.hide) {
        expect(
          after.products.find((product) => product.id === sample.id),
        ).toMatchObject({ status: "draft" });
      }

      // ★ The snapshot Undo and Publish need, on the job itself.
      const job = await revampRow();
      expect(job.applied_at).not.toBeNull();
      const snapshot = job.apply_snapshot!;
      expect(Date.parse(snapshot.appliedAt)).not.toBeNaN();
      for (const entry of snapshot.pages.filter((page) => !page.created)) {
        const planned = plan.pages.find(
          (page) => page.pageId === entry.pageId,
        )!;
        expect(entry.proposed).toEqual({
          title: planned.title,
          seoTitle: planned.seoTitle,
          seoDescription: planned.seoDescription,
        });
      }
      expect(snapshot.notes).toEqual([
        expect.stringContaining("Black Mustard Seed"),
      ]);
      expect(snapshot.products.created).toHaveLength(2);

      // ★ The new products are announced, and offered to search engines.
      expect(memory.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "product.created" }),
      );
      expect(memory.notify).toHaveBeenCalledWith({
        storeId,
        paths: expect.arrayContaining([
          `/shop/${oil.slug}`,
          `/shop/${seed.slug}`,
          "/shop",
        ]),
      });

      // The card reads the apply from the job, so it stops offering Apply.
      const appliedView = (await jobs.readRevampStatus(
        actor,
        revampId,
      )) as RevampStatusView;
      expect(appliedView.appliedAt).not.toBeNull();
      expect(appliedView.publishedAt).toBeNull();
      // ★ The product filed without its category is named on the card.
      expect(appliedView.review?.notes).toEqual(
        expect.arrayContaining([expect.stringContaining("Black Mustard Seed")]),
      );

      // ★ The same approval again changes nothing.
      const repeated = await actions.executeMinkStorefrontPersonalizationAction(
        {
          actor,
          draftId: revampId,
          approvalId,
        },
      );
      expect(repeated.repeated).toBe(true);
      expect(await storeState()).toEqual(after);
    }, 120_000);

    it("★★ publishes every page it wrote and the header and footer", async () => {
      const applied = await storeState();
      const result = await lifecycle.publishRevamp(actor, revampId);
      expect(result.skipped).toEqual([]);
      expect(result.published).toContain("Homepage");
      expect(result.published).toContain("Header and footer");

      const live = await storeState();
      for (const planned of plan.pages) {
        const page = live.pages.find((row) => row.slug === planned.slug)!;
        expect(page.status).toBe("published");
        expect(page.published_sections).toEqual(page.sections);
        // ★★ Publish is when the redesign's title and search text go live.
        expect(page).toMatchObject({
          title: planned.title,
          seo_title: planned.seoTitle,
          seo_description: planned.seoDescription,
        });
      }
      expect(live.chrome?.published).toEqual(live.chrome?.draft);
      expect(live.chrome?.published_at).not.toBeNull();

      const job = await revampRow();
      expect(job.published_at).not.toBeNull();
      const record = job.publish_snapshot!;
      expect(record.answer).toEqual(result);
      for (const entry of record.pages) {
        const start = applied.pages.find((page) => page.id === entry.pageId);
        expect(entry.before.publishedSections).toEqual(
          start?.published_sections ?? [],
        );
        if (start && entry.meta) {
          expect(entry.meta.before).toEqual({
            title: start.title,
            seoTitle: start.seo_title,
            seoDescription: start.seo_description,
          });
        }
      }

      expect(
        ((await jobs.readRevampStatus(actor, revampId)) as RevampStatusView)
          .publishedAt,
      ).not.toBeNull();

      // ★ A second Publish answers the same and writes nothing.
      expect(await lifecycle.publishRevamp(actor, revampId)).toEqual(result);
      expect(await storeState()).toEqual(live);
    }, 120_000);

    it("★★ undoes everything it wrote, back to the store it started from", async () => {
      const result = await lifecycle.undoRevamp(actor, revampId);
      expect(result.kept).toEqual([]);
      expect(result.restored.length).toBeGreaterThan(0);
      const undone = await storeState();
      expect(undone).toEqual(before);

      const job = await revampRow();
      expect(job.undone_at).not.toBeNull();
      expect((job.apply_snapshot as RevampApplySnapshot).undo).toEqual(result);

      expect(
        ((await jobs.readRevampStatus(actor, revampId)) as RevampStatusView)
          .undoneAt,
      ).not.toBeNull();

      // ★ A second Undo answers the same and writes nothing.
      expect(await lifecycle.undoRevamp(actor, revampId)).toEqual(result);
      expect(await storeState()).toEqual(before);
      await expect(
        lifecycle.publishRevamp(actor, revampId),
      ).rejects.toMatchObject({ code: "mink_revamp_undone" });
    }, 120_000);
  },
);
