// Rollback-only local integration: real FKs, immutability and role boundaries.
import { expect, it, vi } from "vitest";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
import { withService } from "@/lib/db/client";
import { createThemeStudioProject, validateProjectInput } from "./repository";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

it.skipIf(process.env.THEME_STUDIO_DELETE_DB_TEST !== "1")(
  "permanently deletes complete themes while protecting users, active work and immutable history",
  async () => {
    const db = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      connectionTimeoutMillis: 5000,
    });
    await db.connect();
    try {
      await db.query("begin");
      await db.query("set local lock_timeout='5s'");
      // ★ The ledger applies 0161 to every local database, so this suite tests
      // the function it installed. Replaying the file onto a database that
      // has it stops at its first CREATE TABLE ("already exists") before any
      // assertion runs; only a database restored from before 0161 needs it,
      // and the replay is rolled back with the rest of this transaction.
      // Same guard as change-scope-postgres and worker-recovery-postgres.
      if (
        !(
          await db.query(
            "select to_regclass('public.theme_studio_deletion_audit') as name",
          )
        ).rows[0].name
      )
        await db.query(
          await readFile(
            "drizzle/migrations/sql/20261005_0161_theme_permanent_deletion.sql",
            "utf8",
          ),
        );
      const actor = randomUUID();
      await db.query(
        "insert into platform_admins(id,email,role) values($1,$2,'superadmin')",
        [actor, `${actor}@example.com`],
      );
      const digest = "b".repeat(64);
      async function fixture(status = "ready") {
        const p = randomUUID(),
          theme = `delete-${p}`,
          m = randomUUID(),
          r = randomUUID(),
          v = randomUUID();
        await db.query(
          "insert into theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by_email) values($1,$2,'Delete test',$3,'{home}','{small}','gemini-3.8-flash','Ceramics','test@example.com')",
          [p, theme, status],
        );
        await db.query(
          "insert into theme_studio_messages(id,project_id,kind,body) values($1,$2,'brief','Test')",
          [m, p],
        );
        await db.query(
          "insert into theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,finished_at) values($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','test',$4,'succeeded',now())",
          [r, p, m, `delete-${r}`],
        );
        await db.query(
          "insert into theme_studio_versions(id,project_id,run_id,version_number,intent_json,intent_digest,package_json,package_digest) values($1,$2,$3,1,'{}',$4,'{}',$4)",
          [v, p, r, digest],
        );
        await db.query(
          "update theme_studio_projects set current_version_id=$2 where id=$1",
          [p, v],
        );
        await db.query(
          "insert into theme_studio_events(project_id,actor_kind,event_type) values($1,'worker','project_created')",
          [p],
        );
        await db.query(
          "insert into theme_studio_assets(project_id,purpose,media_type,bytes,byte_size,width,height,sha256,original_media_type,original_byte_size) values($1,'reference','image/webp',$2,3,1,1,$3,'image/png',3)",
          [p, Buffer.from([1, 2, 3]), digest],
        );
        return { p, theme, m, r, v };
      }
      const remove = async (
        f: Awaited<ReturnType<typeof fixture>>,
        revision = 0,
        confirmation = f.theme,
      ) => {
        await db.query("set local role app_service");
        try {
          const res = await db.query(
            "select theme_studio_delete_project($1,$2,$3,$4) as result",
            [f.p, revision, confirmation, actor],
          );
          return res.rows[0].result;
        } finally {
          await db.query("reset role");
        }
      };
      const refused = async (sql: string, params: unknown[] = []) => {
        await db.query("savepoint refusal");
        try {
          await expect(db.query(sql, params)).rejects.toThrow();
        } finally {
          await db.query("rollback to refusal");
        }
      };
      const f = await fixture();
      expect((await remove(f, 0, "wrong")).ok).toBe(false);
      expect((await remove(f, 1)).ok).toBe(false);
      await db.query("set local role app_user");
      await refused("select theme_studio_delete_project($1,0,$2,$3)", [
        f.p,
        f.theme,
        actor,
      ]);
      await db.query("reset role");
      // Spoofing transaction markers cannot bypass protection as app_service.
      await db.query("set local role app_service");
      await db.query("select set_config('app.theme_delete_project',$1,true)", [
        f.p,
      ]);
      await refused("delete from theme_studio_versions where id=$1", [f.v]);
      await db.query("reset role");
      await db.query("select set_config('app.theme_delete_project','',true)");
      const active = await fixture("generating");
      expect((await remove(active)).error).toMatch(/active work/);
      const awaiting = await fixture();
      await db.query(
        "insert into theme_studio_acceptance_runs(project_id,version_id,package_digest,assets_digest,build_id,created_by_email,status,browser_nonce_hash,browser_expires_at) values($1,$2,$3,$3,'test','test@example.com','awaiting_browser',$3,now()+interval '5 minutes')",
        [awaiting.p, awaiting.v, digest],
      );
      expect((await remove(awaiting)).ok).toBe(false);
      const captured = await fixture();
      await db.query(
        "insert into theme_studio_captures(project_id,version_id,package_digest,previous_status,idempotency_key) values($1,$2,$3,'ready',$4)",
        [captured.p, captured.v, digest, randomUUID()],
      );
      expect((await remove(captured)).ok).toBe(false);
      await db.query(
        "update theme_studio_captures set status='failed',finished_at=now(),error_code='fixture_failed' where project_id=$1",
        [captured.p],
      );
      const qa = await fixture();
      await db.query(
        "insert into theme_studio_visual_qa_runs(project_id,version_id,package_digest,qa_iteration,browser_report,screenshot_asset_ids) values($1,$2,$3,0,'{}',$4)",
        [qa.p, qa.v, digest, [randomUUID()]],
      );
      expect((await remove(qa)).ok).toBe(false);
      await db.query(
        "update theme_studio_visual_qa_runs set status='failed',finished_at=now(),error_code='fixture_failed' where project_id=$1",
        [qa.p],
      );
      expect((await remove(captured)).ok).toBe(true);
      expect((await remove(qa)).ok).toBe(true);
      const archived = await fixture();
      const previewStore = randomUUID();
      await db.query(
        "insert into stores(id,name,slug,settings) values($1,'Preview',$2,$3)",
        [
          previewStore,
          `studio-preview-${previewStore}`,
          {
            demo: true,
            studioPreview: { projectId: archived.p },
            template: archived.theme,
          },
        ],
      );
      await db.query(
        "insert into theme_studio_previews(project_id,version_id,store_id,status,expires_at) values($1,$2,$3,'ready',now()+interval '1 hour')",
        [archived.p, archived.v, previewStore],
      );
      await db.query(
        "update theme_studio_projects set status='archived',archived_at=now() where id=$1",
        [archived.p],
      );
      expect((await remove(archived)).ok).toBe(true);
      expect(
        (
          await db.query("select count(*) from stores where id=$1", [
            previewStore,
          ])
        ).rows[0].count,
      ).toBe("0");
      // A theme no store uses: every release goes with it (0161).
      const unused = await fixture();
      const unusedRelease = randomUUID(),
        unusedEvidence = randomUUID();
      await db.query(
        "insert into theme_studio_acceptance_runs(id,project_id,version_id,package_digest,assets_digest,build_id,created_by_email,status,evidence_digest,completed_at) values($1,$2,$3,$4,$4,'test','test@example.com','passed',$4,now())",
        [unusedEvidence, unused.p, unused.v, digest],
      );
      await db.query(
        "insert into theme_releases(id,theme_id,version,release_status,package_json,manifest_digest) values($1,$2,'1.0.0','published','{}',$3)",
        [unusedRelease, unused.theme, digest],
      );
      await db.query(
        "insert into theme_studio_publications(project_id,version_id,acceptance_run_id,theme_id,release_version,release_id,manifest_digest,status,created_by_email,completed_at) values($1,$2,$3,$4,'1.0.0',$5,$6,'published','test@example.com',now())",
        [
          unused.p,
          unused.v,
          unusedEvidence,
          unused.theme,
          unusedRelease,
          digest,
        ],
      );
      await db.query(
        "insert into theme_catalog_entries(theme_id,current_release_id,visibility) values($1,$2,'public')",
        [unused.theme, unusedRelease],
      );
      expect(await remove(unused)).toEqual({
        ok: true,
        themeId: unused.theme,
        storesKept: 0,
      });
      await db.query("set constraints all immediate");
      expect(
        (
          await db.query(
            "select count(*) from theme_releases where theme_id=$1",
            [unused.theme],
          )
        ).rows[0].count,
      ).toBe("0");

      // ★ A theme stores use (owner, 23 Nov 2026): it is deleted, and each
      //   store keeps the release it pinned.
      const released = await fixture();
      const release = randomUUID(),
        newer = randomUUID(),
        evidence = randomUUID(),
        demo = randomUUID(),
        store = randomUUID(),
        legacy = randomUUID(),
        other = randomUUID();
      await db.query(
        "insert into theme_studio_acceptance_runs(id,project_id,version_id,package_digest,assets_digest,build_id,created_by_email,status,evidence_digest,completed_at) values($1,$2,$3,$4,$4,'test','test@example.com','passed',$4,now())",
        [evidence, released.p, released.v, digest],
      );
      await db.query(
        "insert into theme_releases(id,theme_id,version,release_status,package_json,manifest_digest) values($1,$2,'1.0.0','published','{}',$3),($4,$2,'1.1.0','published','{}',$3)",
        [release, released.theme, digest, newer],
      );
      await db.query(
        "insert into theme_studio_publications(project_id,version_id,acceptance_run_id,theme_id,release_version,release_id,manifest_digest,status,created_by_email,completed_at) values($1,$2,$3,$4,'1.0.0',$5,$6,'published','test@example.com',now())",
        [released.p, released.v, evidence, released.theme, release, digest],
      );
      // New stores get 1.1.0; the merchant below installed 1.0.0.
      await db.query(
        "insert into theme_catalog_entries(theme_id,current_release_id,visibility) values($1,$2,'public')",
        [released.theme, newer],
      );
      await db.query(
        "insert into theme_catalog_audit(theme_id,action,release_id,visibility,project_id,created_by_email) values($1,'publish',$2,'public',$3,'test@example.com')",
        [released.theme, release, released.p],
      );
      await db.query(
        "insert into stores(id,name,slug,settings) values($1,'Demo',$2,$3)",
        [
          demo,
          `demo-${released.theme}`,
          { demo: true, template: released.theme },
        ],
      );
      const merchantSettings = {
        theme: { presetId: released.theme, presetVersion: "1.0.0" },
        brand: { name: "Merchant" },
      };
      await db.query(
        "insert into stores(id,name,slug,settings) values($1,'Merchant',$2,$3)",
        [store, `test-${store}`, merchantSettings],
      );
      await db.query(
        "insert into stores(id,name,slug,settings) values($1,'Other',$2,'{}')",
        [other, `test-${other}`],
      );
      // A store with no pinned release renders the catalogue's current one,
      // which the deletion removes: refused, and nothing is deleted.
      await db.query(
        "insert into stores(id,name,slug,settings) values($1,'Legacy',$2,$3)",
        [legacy, `test-${legacy}`, { template: released.theme }],
      );
      expect((await remove(released)).error).toMatch(/without a fixed release/);
      expect(
        (
          await db.query(
            "select (select count(*) from theme_releases where theme_id=$1) || '/' || (select count(*) from theme_catalog_entries where theme_id=$1) || '/' || (select count(*) from theme_studio_projects where id=$2) || '/' || (select count(*) from stores where id=$3) as state",
            [released.theme, released.p, demo],
          )
        ).rows[0].state,
      ).toBe("2/1/1/1");
      await db.query(
        "update stores set settings=$2 where id=$1 and settings ? 'template'",
        [legacy, { theme: { presetId: released.theme, presetVersion: "x" } }],
      );
      expect((await remove(released)).error).toMatch(/without a fixed release/);
      await db.query("delete from stores where id=$1", [legacy]);

      expect(await remove(released)).toEqual({
        ok: true,
        themeId: released.theme,
        storesKept: 1,
      });
      // Force deferred constraints to check the entire deletion, not just statements.
      await db.query("set constraints all immediate");
      // The merchant's pinned release stays; the one only new stores got goes.
      expect(
        (
          await db.query(
            "select version from theme_releases where theme_id=$1 order by version",
            [released.theme],
          )
        ).rows,
      ).toEqual([{ version: "1.0.0" }]);
      expect(
        (
          await db.query(
            "select count(*) from theme_catalog_entries where theme_id=$1",
            [released.theme],
          )
        ).rows[0].count,
      ).toBe("0");
      expect(
        (await db.query("select count(*) from stores where id=$1", [demo]))
          .rows[0].count,
      ).toBe("0");
      // The store itself is exactly as it was, and keeps working: a settings
      // write that keeps its theme is allowed.
      expect(
        (await db.query("select settings from stores where id=$1", [store]))
          .rows[0].settings,
      ).toEqual(merchantSettings);
      await db.query(
        "update stores set settings = settings || '{\"note\":1}' where id=$1",
        [store],
      );
      // ★ No store may take the deleted theme up, although a release remains.
      await refused("update stores set settings=$2 where id=$1", [
        other,
        { theme: { presetId: released.theme, presetVersion: "1.0.0" } },
      ]);
      await refused("update stores set settings=$2 where id=$1", [
        other,
        { template: released.theme },
      ]);
      await refused(
        "insert into stores(id,name,slug,settings) values($1,'New',$2,$3)",
        [
          randomUUID(),
          `test-new-${other}`,
          { theme: { presetId: released.theme, presetVersion: "1.0.0" } },
        ],
      );
      // Deleting it again (a second click) answers the same.
      expect(await remove(released)).toEqual({
        ok: true,
        themeId: released.theme,
        storesKept: 1,
      });
      expect((await remove(f)).ok).toBe(true);
      await db.query("set constraints all immediate");
      for (const table of [
        "theme_studio_projects",
        "theme_studio_versions",
        "theme_studio_runs",
        "theme_studio_messages",
        "theme_studio_assets",
        "theme_studio_events",
      ]) {
        const key = table === "theme_studio_projects" ? "id" : "project_id";
        expect(
          (
            await db.query(`select count(*) from ${table} where ${key}=$1`, [
              f.p,
            ])
          ).rows[0].count,
        ).toBe("0");
      }
      expect(
        (
          await db.query(
            "select actor_id from theme_studio_deletion_audit where project_id=$1",
            [f.p],
          )
        ).rows[0].actor_id,
      ).toBe(actor);
      await refused(
        "delete from theme_studio_deletion_audit where project_id=$1",
        [f.p],
      );
      await refused(
        "insert into theme_studio_projects(theme_id,name,industries,catalog_sizes,model_key,draft_brief,created_by_email) values($1,'Reused','{home}','{small}','gemini-3.8-flash','Test','test@example.com')",
        [released.theme],
      );
      // Exercise the production creation path against the actual deletion
      // receipt and guards, within this same rollback-only local transaction.
      vi.mocked(withService).mockImplementation(async (fn) =>
        fn(drizzle(db, { schema: { ...schema, ...relations } })),
      );
      const input = validateProjectInput({
        name: "Bubble",
        themeId: released.theme,
        brief: "A playful new theme.",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        baseThemeId: null,
        modelKey: "gemini-3.8-flash",
      });
      await db.query("set local role app_service");
      const first = await createThemeStudioProject(
        { id: actor, email: `${actor}@example.com` },
        input,
      );
      await db.query(
        "insert into theme_releases(theme_id,version,release_status,package_json,manifest_digest) values($1,'1.0.0','published','{}',$2)",
        [`${released.theme}-3`, digest],
      );
      const second = await createThemeStudioProject(
        { id: actor, email: `${actor}@example.com` },
        input,
      );
      const projects = await db.query(
        "select theme_id,name from theme_studio_projects where id=any($1::uuid[]) order by theme_id",
        [[first.id, second.id]],
      );
      expect(projects.rows).toEqual([
        { theme_id: `${released.theme}-2`, name: "Bubble" },
        { theme_id: `${released.theme}-4`, name: "Bubble" },
      ]);
      const event = await db.query(
        "select detail from theme_studio_events where project_id=$1 and event_type='project_created'",
        [first.id],
      );
      expect(event.rows[0].detail).toMatchObject({
        themeId: `${released.theme}-2`,
        requestedThemeId: released.theme,
      });
      await db.query("savepoint active_conflict");
      await expect(
        createThemeStudioProject(
          { id: actor, email: `${actor}@example.com` },
          { ...input, themeId: `${released.theme}-2` },
        ),
      ).rejects.toThrow("Another active project already uses that id.");
      await db.query("rollback to active_conflict");
      await db.query("reset role");
      // Private previews can use the fresh ID while the deleted one stays blocked.
      await db.query("update stores set settings=$2 where id=$1", [
        other,
        { template: `${released.theme}-2` },
      ]);
      await refused("update stores set settings=$2 where id=$1", [
        other,
        { template: released.theme },
      ]);
      // The deletion exception must not grant ordinary updates to surviving history.
      await refused(
        "update theme_studio_versions set intent_json='{}' where id=$1",
        [awaiting.v],
      );
    } finally {
      await db.query("rollback");
      await db.end();
    }
  },
  30000,
);
