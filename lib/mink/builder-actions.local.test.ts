/** Rollback-only integration checks. Run with MINK_BUILDER_LOCAL_TEST=1;
 * fixed loopback DB prevents accidentally running against Cloud SQL. */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
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
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import type { Db } from "@/lib/db/client";
import type { MinkActorContext } from "./types";
import { builderDigest, type BuilderOperation } from "./builder-contract";

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
    const name = `builder_action_${++service.count}`;
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
import {
  approveMinkBuilderProposal,
  createMinkBuilderProposal,
  readMinkBuilderContext,
  readMinkBuilderReview,
} from "./builder-actions";

import { saveMinkDraftVersion } from "./drafts";
const enabled = process.env.MINK_BUILDER_LOCAL_TEST === "1";
describe.skipIf(!enabled)("Website Builder local transactional actions", () => {
  let client: Client;
  let actor: MinkActorContext;
  let otherStore: string;
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
    service.db = drizzle(client, { schema }) as Db;
    const manifest = JSON.parse(
      readFileSync("drizzle/migrations/manifest.json", "utf8"),
    );
    for (const migration of manifest.migrations.slice(-6)) {
      await client.query(
        readFileSync(`drizzle/migrations/${migration.file}`, "utf8"),
      );
      for (const query of [
        ...(migration.verify?.queries ?? []),
        ...(migration.applyVerify?.queries ?? []),
      ]) {
        const rows = (await client.query(query.sql)).rows;
        expect(String(Object.values(rows[0])[0]), query.name).toBe(
          String(query.equals),
        );
      }
    }
  }, 30000);
  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
  beforeEach(async () => {
    await client.query("SAVEPOINT builder_fixture");
    const storeId = crypto.randomUUID();
    otherStore = crypto.randomUUID();
    actor = {
      storeId,
      adminId: "builder-test-owner",
      email: null,
      roleSlug: "owner",
      permissions: { builder: ["view", "manage"] },
      isSuperadmin: false,
      effectivePlan: "pro",
      locationIds: null,
      analyticsTimeZone: "Asia/Kolkata",
      currency: "INR",
      defaultLowStockThreshold: 5,
      requestId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      draftingEnabled: true,
    };
    for (const id of [storeId, otherStore])
      await client.query(
        "insert into stores(id,slug,name,status,plan,settings) values($1,$2,'Rollback test','active','pro',$3)",
        [
          id,
          `builder-${id}`,
          {
            features: { "pages.customCode": true, "inventory.track": false },
            brand: { name: "Keep my brand" },
          },
        ],
      );
    const conversationId = crypto.randomUUID();
    await client.query(
      "insert into mink_conversations(id,store_id,admin_id,title) values($1,$2,$3,'Builder test')",
      [conversationId, storeId, actor.adminId],
    );
    await client.query(
      "insert into mink_runs(id,store_id,conversation_id,requested_by,request_id,model) values($1,$2,$3,$4,$5,'fixture')",
      [actor.runId, storeId, conversationId, actor.adminId, actor.requestId],
    );
    await client.query(
      "insert into categories(store_id,name,slug,status) values($1,'Men','men','active'),($1,'Old shoes','mens-shoes','hidden')",
      [storeId],
    );
    const chrome = structuredClone(DEFAULT_CHROME);
    chrome.header.links = [{ label: "MEN", href: "/shop?category=mens-shoes" }];
    chrome.footer.groups = [];
    chrome.footer.legal = [];
    await client.query(
      "insert into store_chrome(store_id,draft,published) values($1,$2,$2)",
      [storeId, chrome],
    );
  });
  afterEach(async () => {
    await client.query("ROLLBACK TO SAVEPOINT builder_fixture");
    await client.query("RELEASE SAVEPOINT builder_fixture");
  });

  async function proposal(
    operation: BuilderOperation,
    changes: Record<string, unknown> = {},
    pageSlug = "home",
  ) {
    const context = await readMinkBuilderContext(actor, operation, pageSlug);
    const patch = {
      operation,
      pageSlug,
      expectedDigest: context.targetDigest,
      changes,
    };
    const id = crypto.randomUUID();
    await service.db!.insert(schema.minkDrafts).values({
      id,
      storeId: actor.storeId,
      adminId: actor.adminId,
      runId: actor.runId!,
      kind: "website_builder",
      destinationType: "website_builder",
      destinationLabel: operation,
      destinationPath: "/dashboard/builder",
      title: "Builder test",
      expectedCredits: 2,
      contentJson: {
        patch_digest: builderDigest(patch),
        patch_json: JSON.stringify(patch),
        explanation: "Requested Builder change.",
      },
    });
    return id;
  }
  async function approve(id: string) {
    return approveMinkBuilderProposal(actor, id, crypto.randomUUID(), {});
  }
  async function chrome() {
    return (
      await service
        .db!.select()
        .from(schema.storeChrome)
        .where(eq(schema.storeChrome.storeId, actor.storeId))
    )[0];
  }
  async function auditCount() {
    return (
      await client.query(
        "select count(*)::int as count from mink_action_audit where store_id=$1",
        [actor.storeId],
      )
    ).rows[0].count;
  }

  it("creates the immutable proposal with weighted credits and no Builder write", async () => {
    const context = await readMinkBuilderContext(actor, "chrome_update");
    const before = await chrome();
    const result = await createMinkBuilderProposal(
      actor,
      {
        operation: "chrome_update",
        pageSlug: "home",
        expectedDigest: context.targetDigest,
        changes: { fields: [{ path: "header.sticky", value: false }] },
      },
      "Disable the sticky header.",
    );
    expect(result).toMatchObject({
      type: "builder_proposal",
      expectedCredits: 2,
      live: false,
    });
    expect(await chrome()).toEqual(before);
    const [draft] = await service
      .db!.select()
      .from(schema.minkDrafts)
      .where(eq(schema.minkDrafts.id, result.draftId));
    expect(draft).toMatchObject({
      kind: "website_builder",
      currentVersion: 0,
      status: "proposed",
    });
    expect(
      (
        await client.query(
          "select expected_credits from mink_draft_credit_usage where draft_id=$1",
          [result.draftId],
        )
      ).rows[0].expected_credits,
    ).toBe(2);
    await expect(
      saveMinkDraftVersion({
        actor,
        draftId: result.draftId,
        expectedVersion: 0,
        content: draft.contentJson,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await approve(result.draftId);
  });
  it("rejects idempotency keys belonging to another approved change", async () => {
    const id = await proposal("chrome_update", {
      fields: [{ path: "header.sticky", value: false }],
    });
    const key = crypto.randomUUID();
    await approveMinkBuilderProposal(actor, id, key, {});
    const second = await proposal("chrome_update", {
      fields: [{ path: "header.showSearch", value: false }],
    });
    await expect(
      approveMinkBuilderProposal(actor, second, key, {}),
    ).rejects.toMatchObject({ status: 409 });
    expect((await chrome()).draft.header.showSearch).toBe(true);
    expect(await auditCount()).toBe(1);
  });

  it("reads legacy live menus and preserves them when creating the first chrome draft", async () => {
    await client.query("delete from store_chrome where store_id=$1", [
      actor.storeId,
    ]);
    await client.query(
      "insert into store_menus(store_id,header,footer_groups,footer_legal) values($1,$2,$3,$4)",
      [
        actor.storeId,
        JSON.stringify([
          { label: "MEN", href: "/shop?category=mens-shoes" },
          { label: "All", href: "/shop" },
        ]),
        JSON.stringify([
          { title: "Shop", links: [{ label: "All", href: "/shop" }] },
        ]),
        JSON.stringify([{ label: "Orders", href: "/orders" }]),
      ],
    );
    const context = await readMinkBuilderContext(actor, "chrome_update");
    expect(context.chrome?.header.links[0].label).toBe("MEN");
    expect(context.liveNavigationIssues).toEqual([
      expect.objectContaining({ suggestedHref: "/collections/men" }),
    ]);
    await approve(
      await proposal("chrome_update", {
        fields: [{ path: "header.links.0.href", value: "/collections/men" }],
      }),
    );
    const saved = await chrome();
    expect(saved.published).toBeNull();
    expect(saved.draft.footer).toEqual(context.chrome!.footer);
    expect(saved.draft.header.links[1]).toEqual(
      context.chrome!.header.links[1],
    );
    expect(saved.draft.header.links[0].href).toBe("/collections/men");
  });

  it("corrects the MEN draft, publishes separately and replays without a second audit/write", async () => {
    const id = await proposal("chrome_update", {
      fields: [{ path: "header.links.0.href", value: "/collections/men" }],
    });
    const review = await readMinkBuilderReview(actor, id);
    expect(review).toMatchObject({ executed: false, live: false });
    await approve(id);
    expect((await chrome()).draft.header.links[0].href).toBe(
      "/collections/men",
    );
    expect((await chrome()).published!.header.links[0].href).toBe(
      "/shop?category=mens-shoes",
    );
    const saved = await chrome();
    expect((await approve(id)).repeated).toBe(true);
    expect(await chrome()).toEqual(saved);
    expect(await auditCount()).toBe(1);
    await approve(await proposal("chrome_publish"));
    expect((await chrome()).published!.header.links[0].href).toBe(
      "/collections/men",
    );
    expect(await auditCount()).toBe(2);
    expect(await readMinkBuilderReview(actor, id)).toMatchObject({
      executed: true,
    });
  });
  it("refuses stale state, another tenant/owner and lost Manage permission", async () => {
    const id = await proposal("chrome_update", {
      fields: [{ path: "header.sticky", value: false }],
    });
    await expect(
      approveMinkBuilderProposal(
        { ...actor, storeId: otherStore },
        id,
        crypto.randomUUID(),
        {},
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      approveMinkBuilderProposal(
        { ...actor, adminId: "other-admin" },
        id,
        crypto.randomUUID(),
        {},
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      approveMinkBuilderProposal(
        { ...actor, permissions: { builder: ["view"] } },
        id,
        crypto.randomUUID(),
        {},
      ),
    ).rejects.toMatchObject({ status: 403 });
    await client.query(
      "update store_chrome set draft=jsonb_set(draft,'{header,showSearch}','false') where store_id=$1",
      [actor.storeId],
    );
    await expect(readMinkBuilderReview(actor, id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(approve(id)).rejects.toMatchObject({ status: 409 });
    expect(await auditCount()).toBe(0);
  });
  it("rechecks the action gate at execution", async () => {
    const id = await proposal("chrome_update", {
      fields: [{ path: "header.sticky", value: false }],
    });
    await client.query(
      "update mink_action_tool_access set enabled=false where store_id=$1 and tool_name='manage_website_builder'",
      [actor.storeId],
    );
    await expect(approve(id)).rejects.toMatchObject({ status: 403 });
    expect(await auditCount()).toBe(0);
  });
  it("changes only public brand appearance while keeping store identity", async () => {
    const context = await readMinkBuilderContext(actor, "brand_update");
    expect(context.brand).toEqual({ primaryColor: "#17130f", logoUrl: null });
    await approve(await proposal("brand_update", { primaryColor: "#3355AA" }));
    const [store] = await service
      .db!.select()
      .from(schema.stores)
      .where(eq(schema.stores.id, actor.storeId));
    expect(store.settings).toEqual({
      features: { "pages.customCode": true, "inventory.track": false },
      brand: { name: "Keep my brand", primaryColor: "#3355AA" },
    });
  });

  it("merges Website settings without deleting brand or unrelated features", async () => {
    await approve(
      await proposal("settings_update", { "pages.customCode": false }),
    );
    const row = (
      await service
        .db!.select()
        .from(schema.stores)
        .where(eq(schema.stores.id, actor.storeId))
    )[0];
    expect(row.settings).toEqual({
      features: { "pages.customCode": false, "inventory.track": false },
      brand: { name: "Keep my brand" },
    });
  });
  it("creates, edits, publishes, unpublishes, restores and deletes one page", async () => {
    const slug = "size-guide";
    await approve(await proposal("page_create", { title: "Size guide" }, slug));
    await approve(
      await proposal(
        "page_update",
        {
          seoTitle: "Find your size",
          sections: [
            {
              id: "size-copy",
              type: "rich_text",
              enabled: true,
              config: { html: "<p>Size guidance</p>" },
            },
          ],
        },
        slug,
      ),
    );
    await approve(await proposal("page_publish", {}, slug));
    const page = async () =>
      (
        await service
          .db!.select()
          .from(schema.storePages)
          .where(
            and(
              eq(schema.storePages.storeId, actor.storeId),
              eq(schema.storePages.slug, slug),
            ),
          )
      )[0];
    expect(await page()).toMatchObject({
      status: "published",
      seoTitle: "Find your size",
    });
    expect((await page()).publishedSections).toEqual((await page()).sections);
    await approve(
      await proposal(
        "page_update",
        { seoDescription: "Choose the fit you prefer." },
        slug,
      ),
    );
    await approve(await proposal("page_unpublish", {}, slug));
    expect((await page()).status).toBe("draft");
    await approve(await proposal("page_update", { sections: [] }, slug));
    await approve(await proposal("page_revert", {}, slug));
    expect((await page()).sections).toEqual((await page()).publishedSections);
    await approve(await proposal("page_delete", {}, slug));
    expect(await page()).toBeUndefined();
  });
  it("rolls back the business write and approval if the audit append fails", async () => {
    const id = await proposal("chrome_update", {
      fields: [{ path: "header.sticky", value: false }],
    });
    const original = await chrome();
    await client.query(
      "create function pg_temp.reject_builder_audit() returns trigger language plpgsql as $$ begin raise exception 'test audit failure'; end $$",
    );
    await client.query(
      "create trigger test_reject_builder_audit before insert on mink_action_audit for each row execute function pg_temp.reject_builder_audit()",
    );
    await expect(approve(id)).rejects.toMatchObject({
      cause: { message: "test audit failure" },
    });
    expect(await chrome()).toEqual(original);
    expect(
      (
        await client.query(
          "select count(*)::int as count from mink_action_approvals where draft_id=$1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("rejects code publication without exact fresh desktop/mobile evidence", async () => {
    const slug = "code-test";
    await approve(
      await proposal(
        "page_create",
        {
          title: "Code test",
          sections: [
            {
              id: "local-code",
              type: "custom_code",
              enabled: true,
              config: {
                html: "<p>Welcome</p>",
                css: "",
                js: "",
                height_mode: "auto",
                fixed_height: 200,
              },
            },
          ],
        },
        slug,
      ),
    );
    const id = await proposal("page_publish", {}, slug);
    await expect(approve(id)).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await client.query(
          "select status from store_pages where store_id=$1 and slug=$2",
          [actor.storeId, slug],
        )
      ).rows[0].status,
    ).toBe("draft");
  });
});
