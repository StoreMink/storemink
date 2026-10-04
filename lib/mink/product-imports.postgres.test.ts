// @vitest-environment node
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableColumns, getTableName, is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import type { Db } from "@/lib/db/client";
import type { MinkActorContext } from "./types";
import * as schema from "@/drizzle/schema";
const holder = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@/lib/db/client", () => ({
  withService: async (fn: (db: Db) => Promise<unknown>) =>
    holder.db!.transaction((tx) => fn(tx as Db)),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
import {
  uploadMinkCsv,
  queueMinkProductImport,
  correctMinkProductCsv,
  getMinkCsv,
  previewMinkCsv,
} from "./product-imports";
import {
  previewMinkProductAction,
  executeMinkProductAction,
  previewMinkProductActionRollback,
} from "./product-actions";
import { addProgress } from "@/lib/import-export/jobs";
const socket = process.env.MINK_CSV_TEST_SOCKET;
const suite = socket ? describe : describe.skip;
const store = "11111111-1111-4111-8111-111111111111";
const actor: MinkActorContext = {
  storeId: store,
  adminId: "owner",
  email: "owner@example.com",
  roleSlug: "owner",
  permissions: { products: ["manage"] },
  isSuperadmin: false,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  draftingEnabled: true,
  requestId: "test",
};
const id = "22222222-2222-4222-8222-222222222222";
const productId = "33333333-3333-4333-8333-333333333333";
const draftId = "44444444-4444-4444-8444-444444444444";
const oldPhoto = "https://old.example/old-photo.webp";
const newPhoto = "https://storage.googleapis.com/bucket/new-photo.webp";
suite("Product photo and CSV workflows on disposable PostgreSQL", () => {
  let pool: Pool;
  beforeAll(async () => {
    if (!socket || !/^\/private\/tmp\/mink-csv-pg\.[A-Za-z0-9]+$/.test(socket))
      throw new Error(
        "Use a disposable socket, never an application database.",
      );
    pool = new Pool({
      host: socket,
      port: 55495,
      database: "mink_csv_verify",
      user: process.env.USER,
      max: 5,
    });
    if (
      (
        await pool.query(
          "select count(*)::int n from pg_tables where schemaname='public'",
        )
      ).rows[0].n
    )
      throw new Error("Fixture database must be empty.");
    holder.db = drizzle(pool) as Db;
    await pool.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE app_service BYPASSRLS; END IF; END $$; CREATE TABLE stores(id uuid primary key); CREATE TABLE mink_store_access(store_id uuid,enabled boolean,drafting_enabled boolean,invited_by text);",
    );
    const dialect = new PgDialect();
    for (const table of [
      schema.products,
      schema.categories,
      schema.mediaAssets,
      schema.minkDrafts,
      schema.minkActionApprovals,
      schema.minkActionAudit,
      schema.minkActionToolAccess,
      schema.dataJobs,
      schema.dataJobPayloads,
      schema.dataJobIssues,
    ]) {
      const columns = Object.values(getTableColumns(table)).filter(
        (column) =>
          !(
            getTableName(table) === "data_jobs" &&
            column.name === "failed_lines"
          ),
      );
      const ddl = columns.map((column) => {
        let suffix = "";
        if (column.default !== undefined) {
          const value = column.default;
          const literal = is(value, SQL)
            ? dialect.sqlToQuery(value).sql.replaceAll("ARRAY[]", "'{}'")
            : typeof value === "string"
              ? "'" + value.replaceAll("'", "''") + "'"
              : Array.isArray(value) && column.getSQLType().endsWith("[]")
                ? "ARRAY[" +
                  value
                    .map(
                      (item) => "'" + String(item).replaceAll("'", "''") + "'",
                    )
                    .join(",") +
                  "]::" +
                  column.getSQLType()
                : typeof value === "object"
                  ? "'" + JSON.stringify(value) + "'"
                  : String(value);
          suffix = ` DEFAULT (${literal})::${column.getSQLType()}`;
        }
        return `"${column.name}" ${column.getSQLType()}${suffix}${column.name === "id" || (column.name === "job_id" && getTableName(table) === "data_job_payloads") ? " PRIMARY KEY" : ""}`;
      });
      await pool.query(
        `CREATE TABLE ${getTableName(table)} (${ddl.join(",")})`,
      );
    }
    await pool.query(
      "ALTER TABLE mink_action_tool_access ADD CONSTRAINT mink_action_tool_access_name_check CHECK(tool_name=ANY(ARRAY['apply_product_seo'::text])); ALTER TABLE mink_action_tool_access ADD UNIQUE(store_id,tool_name); ALTER TABLE mink_action_approvals ADD CONSTRAINT mink_action_approvals_tool_check CHECK(tool_name=ANY(ARRAY['apply_product_seo'::text])); ALTER TABLE mink_action_approvals ADD UNIQUE(store_id,admin_id,idempotency_key); ALTER TABLE mink_action_audit ADD CONSTRAINT mink_action_audit_tool_check CHECK(tool_name=ANY(ARRAY['apply_product_seo'::text])); ALTER TABLE mink_drafts ADD CONSTRAINT mink_drafts_kind_check CHECK(kind=ANY(ARRAY['product_seo'::text])); CREATE TABLE help_articles(slug text,status text,body text,updated_at timestamptz);",
    );
    await pool.query("INSERT INTO stores VALUES($1)", [store]);
    await pool.query(
      "INSERT INTO mink_store_access VALUES($1,true,true,'operator')",
      [store],
    );
    const migration = readFileSync(
      "drizzle/migrations/sql/20261004_0155_mink_product_photos_csv.sql",
      "utf8",
    );
    const priorHelp = [...migration.matchAll(/\$old\$([\s\S]*?)\$old\$/g)]
      .map((match) => match[1])
      .join("\n");
    await pool.query(
      "INSERT INTO help_articles VALUES('use-mink-ai-in-your-dashboard','published',$1,now())",
      [priorHelp],
    );
    await pool.query(migration);
    const manifest = JSON.parse(
      readFileSync("drizzle/migrations/manifest.json", "utf8"),
    );
    for (const check of manifest.migrations.at(-1).applyVerify.queries)
      expect(Object.values((await pool.query(check.sql)).rows[0])[0]).toBe(
        check.equals,
      );
    await pool.query(
      "CREATE FUNCTION fixture_content_version() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.content_updated_at = OLD.content_updated_at + interval '1 millisecond'; RETURN NEW; END$$; CREATE TRIGGER fixture_content_version BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION fixture_content_version();",
    );
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE mink_csv_files,data_job_payloads,data_job_issues,data_jobs,mink_action_approvals,mink_action_audit,mink_drafts,products,media_assets CASCADE",
    );
  });
  it("enforces private file ownership and role boundaries", async () => {
    await uploadMinkCsv(actor, id, "products.csv", "Handle,Title\na,Milk\n");
    await expect(
      getMinkCsv({ ...actor, adminId: "other" }, id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getMinkCsv({ ...actor, storeId: crypto.randomUUID() }, id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getMinkCsv({ ...actor, permissions: { products: ["view"] } }, id),
    ).rejects.toMatchObject({ status: 403 });
    await pool.query("SET ROLE authenticated");
    await expect(pool.query("SELECT * FROM mink_csv_files")).rejects.toThrow(
      /permission denied/,
    );
    await pool.query("RESET ROLE");
  });
  it("concurrent approvals commit exactly one job and one payload", async () => {
    await uploadMinkCsv(actor, id, "products.csv", "Handle,Title\na,Milk\n");
    const outcomes = await Promise.all([
      queueMinkProductImport(actor, id),
      queueMinkProductImport(actor, id),
    ]);
    expect(outcomes[0].jobId).toBe(outcomes[1].jobId);
    expect(outcomes.map((row) => row.repeated).sort()).toEqual([false, true]);
    expect(
      (
        await pool.query(
          "SELECT (SELECT count(*) FROM data_jobs)::int jobs,(SELECT count(*) FROM data_job_payloads)::int payloads",
        )
      ).rows[0],
    ).toEqual({ jobs: 1, payloads: 1 });
    expect((await getMinkCsv(actor, id)).job?.options).toMatchObject({
      create: true,
      update: false,
    });
  });
  it("blocks invalid CSVs before a job exists and allows a separate correction", async () => {
    await uploadMinkCsv(
      actor,
      id,
      "products.csv",
      "Handle,Title,Base Price\na,Milk,abc\n",
    );
    await expect(queueMinkProductImport(actor, id)).rejects.toMatchObject({
      code: "csv_errors",
    });
    const fixed = await correctMinkProductCsv(
      actor,
      id,
      [{ line: 2, column: "Base Price", value: "99" }],
      [],
    );
    expect(fixed.artifact.errorCount).toBe(0);
    expect(fixed.artifact.fileId).not.toBe(id);
    expect((await getMinkCsv(actor, id)).file.csv).toContain("abc");
    await queueMinkProductImport(actor, fixed.artifact.fileId);
  });
  it("keeps failed lines independent of issue caps and retries only those lines", async () => {
    await uploadMinkCsv(
      actor,
      id,
      "products.csv",
      'Handle,Title\na,"Milk\nBottle"\nb,Tea\nc,Coffee\n',
    );
    const { jobId } = await queueMinkProductImport(actor, id);
    await addProgress(jobId, store, {
      processed: 3,
      created: 2,
      failed: 1,
      failedLines: [4],
    });
    await pool.query(
      "UPDATE data_jobs SET status='partial',cursor=3,dropped_issues=999 WHERE id=$1",
      [jobId],
    );
    const fixed = await correctMinkProductCsv(
      actor,
      id,
      [{ line: 4, column: "Title", value: "Corrected Tea" }],
      [],
    );
    expect(fixed.artifact.rows).toBe(1);
    expect(fixed.rows[0].cells).toEqual(["b", "Corrected Tea"]);
  });
  it("refuses corrections while running and refuses expired file access", async () => {
    await uploadMinkCsv(actor, id, "products.csv", "Handle,Title\na,Milk\n");
    await queueMinkProductImport(actor, id);
    await expect(
      correctMinkProductCsv(actor, id, [], []),
    ).rejects.toMatchObject({ code: "csv_running" });
    await pool.query(
      "UPDATE mink_csv_files SET created_at=now()-interval '8 days'",
    );
    await expect(previewMinkCsv(actor, id)).rejects.toMatchObject({
      status: 404,
    });
  });
  async function photoFixture() {
    await pool.query(
      "INSERT INTO products(id,store_id,name,slug,image_url,images,content_updated_at) VALUES($1,$2,'Milk','milk',$3,ARRAY[$3],now())",
      [productId, store, oldPhoto],
    );
    await pool.query("INSERT INTO media_assets(store_id,url) VALUES($1,$2)", [
      store,
      newPhoto,
    ]);
    await pool.query(
      "INSERT INTO mink_drafts(id,store_id,admin_id,kind,status,destination_type,destination_id,content_json,current_version) VALUES($1,$2,$3,'product_images','draft','product',$4,$5,1)",
      [
        draftId,
        store,
        actor.adminId,
        productId,
        { image_url: newPhoto, images_json: JSON.stringify([newPhoto]) },
      ],
    );
  }
  it("applies image fields once and rolls back the exact legacy gallery", async () => {
    await photoFixture();
    const approval = await previewMinkProductAction({
      actor,
      draftId,
      expectedDraftVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(
      (
        await executeMinkProductAction({
          actor,
          draftId,
          approvalId: approval.id,
        })
      ).repeated,
    ).toBe(false);
    expect(
      (
        await executeMinkProductAction({
          actor,
          draftId,
          approvalId: approval.id,
        })
      ).repeated,
    ).toBe(true);
    expect(
      (await pool.query("SELECT image_url,images,name FROM products")).rows[0],
    ).toEqual({ image_url: newPhoto, images: [newPhoto], name: "Milk" });
    const restore = await previewMinkProductActionRollback({
      actor,
      draftId,
      sourceApprovalId: approval.id,
      idempotencyKey: crypto.randomUUID(),
    });
    await executeMinkProductAction({ actor, draftId, approvalId: restore.id });
    expect(
      (await pool.query("SELECT image_url,images FROM products")).rows[0],
    ).toEqual({ image_url: oldPhoto, images: [oldPhoto] });
  });
  it("refuses a stale product or deleted proposed Media without overwriting", async () => {
    await photoFixture();
    const approval = await previewMinkProductAction({
      actor,
      draftId,
      expectedDraftVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    await pool.query("UPDATE products SET name='Edited' WHERE id=$1", [
      productId,
    ]);
    await expect(
      executeMinkProductAction({ actor, draftId, approvalId: approval.id }),
    ).rejects.toMatchObject({ code: "mink_action_product_conflict" });
    const fresh = await previewMinkProductAction({
      actor,
      draftId,
      expectedDraftVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    await pool.query("DELETE FROM media_assets");
    await expect(
      executeMinkProductAction({ actor, draftId, approvalId: fresh.id }),
    ).rejects.toMatchObject({ code: "mink_image_missing" });
    expect(
      (await pool.query("SELECT image_url FROM products")).rows[0].image_url,
    ).toBe(oldPhoto);
  });
});
