// Rollback-only lease/fence regression. No provider or network calls.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import { expect, it } from "vitest";
import { renewStudioLease } from "./worker-lease-store";
import { operatorImagePackage } from "./_test-helpers";

it.skipIf(process.env.THEME_STUDIO_RECOVERY_DB_TEST !== "1")(
  "renews generation and QA only for a current unexpired owner, without consuming attempts",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    const pg = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      password: process.env.DB_ADMIN_PASSWORD,
      connectionTimeoutMillis: 5000,
    });
    await pg.connect();
    try {
      await pg.query("BEGIN");
      await pg.query("SET LOCAL lock_timeout='5s'");
      const project = randomUUID(),
        message = randomUUID(),
        run = randomUUID(),
        version = randomUUID(),
        qa = randomUUID(),
        owner = randomUUID();
      await pg.query(
        "INSERT INTO theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by_email) VALUES($1,$2,'Lease fixture','generating','{home}','{small}','gemini-3.8-flash','Ceramics','lease@test.invalid')",
        [project, `lease-${project}`],
      );
      await pg.query(
        "INSERT INTO theme_studio_messages(id,project_id,kind,body) VALUES($1,$2,'brief','Ceramics')",
        [message, project],
      );
      await pg.query(
        "INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,lease_owner,lease_expires_at,attempt_count) VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','test',$5,'running',$4,now()+interval '60 seconds',1)",
        [run, project, message, owner, `lease-${run}`],
      );
      await pg.query(
        "INSERT INTO theme_studio_versions(id,project_id,version_number,intent_json,intent_digest,package_json,package_digest,run_id) VALUES($1,$2,1,'{}',$3,$4,$3,$5)",
        [
          version,
          project,
          "a".repeat(64),
          JSON.stringify(operatorImagePackage()),
          run,
        ],
      );
      await pg.query(
        "INSERT INTO theme_studio_visual_qa_runs(id,project_id,version_id,package_digest,qa_iteration,browser_report,screenshot_asset_ids,status,lease_owner,lease_expires_at,attempt_count) VALUES($1,$2,$3,$4,0,'{}',ARRAY[$6::uuid],'running',$5,now()+interval '60 seconds',1)",
        [qa, project, version, "a".repeat(64), owner, randomUUID()],
      );
      const db = drizzle(pg);
      for (const [queue, id, table] of [
        ["generation", run, "theme_studio_runs"],
        ["qa", qa, "theme_studio_visual_qa_runs"],
      ] as const) {
        await pg.query("SET LOCAL ROLE app_service");
        expect(await renewStudioLease(db, queue, id, owner)).toBe(true);
        await pg.query("RESET ROLE");
        const row = (
          await pg.query(
            `SELECT attempt_count,extract(epoch FROM lease_expires_at-clock_timestamp()) AS remaining FROM ${table} WHERE id=$1`,
            [id],
          )
        ).rows[0];
        expect(row.attempt_count).toBe(1);
        expect(Number(row.remaining)).toBeGreaterThan(175);
        expect(Number(row.remaining)).toBeLessThanOrEqual(180);
        expect(await renewStudioLease(db, queue, id, randomUUID())).toBe(false);
        await pg.query(
          `UPDATE ${table} SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
          [id],
        );
        expect(await renewStudioLease(db, queue, id, owner)).toBe(false);
        const replacement = randomUUID();
        await pg.query(
          `UPDATE ${table} SET lease_owner=$2,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1`,
          [id, replacement],
        );
        expect(await renewStudioLease(db, queue, id, owner)).toBe(false);
        expect(await renewStudioLease(db, queue, id, replacement)).toBe(true);
        await pg.query(
          `UPDATE ${table} SET status='failed',error_code='fixture',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,
          [id],
        );
        expect(await renewStudioLease(db, queue, id, replacement)).toBe(false);
      }
    } finally {
      await pg.query("ROLLBACK");
      await pg.end();
    }
  },
);
