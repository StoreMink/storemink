// Rollback-only storage contract; no provider calls or durable local changes.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { loadEnvConfig } from "@next/env";
import sharp from "sharp";
import { expect, it } from "vitest";
import { prepareVisualScreenshot } from "./visual-evidence";

it.skipIf(process.env.THEME_STUDIO_RECOVERY_DB_TEST !== "1")(
  "stores tall readable QA evidence while rejecting PNG or oversized storefront artwork",
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
      await pg.query(
        await readFile(
          "drizzle/migrations/sql/20261004_0154_theme_studio_readable_screenshots.sql",
          "utf8",
        ),
      );
      const project = randomUUID();
      await pg.query(
        "INSERT INTO theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by_email) VALUES($1,$2,'Evidence fixture','generating','{home}','{small}','gemini-3.8-flash','Ceramics','test@example.com')",
        [project, `evidence-${project}`],
      );
      const stored = await prepareVisualScreenshot(
        await sharp({
          create: {
            width: 390,
            height: 17000,
            channels: 3,
            background: "white",
          },
        })
          .jpeg()
          .toBuffer(),
      );
      await pg.query("SET LOCAL ROLE app_service");
      const insert = (
        purpose: string,
        media: string,
        width: number,
        height: number,
      ) =>
        pg.query(
          "INSERT INTO theme_studio_assets(project_id,purpose,media_type,bytes,byte_size,width,height,sha256,original_media_type,original_byte_size) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'image/jpeg',$5) RETURNING id",
          [
            project,
            purpose,
            media,
            stored.bytes,
            stored.bytes.byteLength,
            width,
            height,
            stored.sha256,
          ],
        );
      expect(
        (
          await insert(
            "qa_screenshot",
            stored.mediaType,
            stored.width,
            stored.height,
          )
        ).rowCount,
      ).toBe(1);
      for (const args of [
        ["image", "image/png", 390, 1000],
        ["image", "image/webp", 390, 6000],
        ["qa_screenshot", "image/png", 1600, 17000],
        ["qa_screenshot", "image/png", 1440, 40000],
      ] as const) {
        await pg.query("SAVEPOINT invalid_asset");
        await expect(
          insert(args[0], args[1], args[2], args[3]),
        ).rejects.toMatchObject({ code: "23514" });
        await pg.query("ROLLBACK TO SAVEPOINT invalid_asset");
      }
      await pg.query("RESET ROLE");
      const manifest = JSON.parse(
        await readFile("drizzle/migrations/manifest.json", "utf8"),
      );
      const migration = manifest.migrations.find(
        (m: { id: string }) =>
          m.id === "20261004_0154_theme_studio_readable_screenshots",
      );
      for (const check of migration.verify.queries) {
        const result = await pg.query(check.sql);
        expect(Object.values(result.rows[0])[0]).toBe(check.equals);
      }
    } finally {
      await pg.query("ROLLBACK");
      await pg.end();
    }
  },
  30_000,
);
