// Opt-in local PostgreSQL regression (owner, 23 Nov 2026: "ai theme builder
// should be capable of understanding the follow ups the operator gives"):
// an automatic fix round finds the operator's change it follows by walking
// back through the versions automatic runs made. Everything rolls back; the
// theme is the offline fake provider's: no network, no model call.
// Run THEME_STUDIO_RECOVERY_DB_TEST=1 with Vitest.
import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/drizzle/schema";
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
import { createFakeModelClient } from "./fake-provider";
import { runThemeGeneration } from "./pipeline";
import { loadFollowUp } from "./worker";

const HEADER = "/definition/preset/design/layout/header";

it.skipIf(process.env.THEME_STUDIO_RECOVERY_DB_TEST !== "1")(
  "walks back from a fix to the operator's change, and finds nothing for a first build or a picture request",
  async () => {
    const brief = {
      name: "Muse",
      brief: "An airy, minimal shop.",
      industries: ["home" as const],
      catalogSizes: ["small" as const],
      requiredFeatures: [],
      referenceCount: 0,
    };
    const built = await runThemeGeneration(
      createFakeModelClient(brief),
      {
        facts: {
          name: brief.name,
          themeId: "muse",
          industries: ["home"],
          catalogSizes: ["small"],
          requiredFeatures: [],
          baseThemeName: null,
        },
        compile: {
          themeId: "muse",
          name: brief.name,
          industries: ["home"],
          catalogSizes: ["small"],
          requiredFeatures: [],
          baseEngine: null,
          versionNumber: 1,
          modelKey: "gemini-3.8-flash",
          modelLabel: "Gemini 3.8 Flash",
          referenceDigests: [],
        },
        providerModel: "fake",
        promptVersion: "theme-studio-v1",
        messages: [{ kind: "brief", body: brief.brief }],
        references: [],
      },
      new AbortController().signal,
    );
    if (built.kind !== "version") throw new Error("fixture failed");
    const withHeader = (header: "hamburger" | "centered", cart?: string) => {
      const pkg = structuredClone(built.package);
      pkg.definition.preset.design.layout = {
        ...pkg.definition.preset.design.layout,
        header,
        ...(cart ? { cart: cart as "compact" } : {}),
      };
      return pkg;
    };

    const pg = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      connectionTimeoutMillis: 5_000,
    });
    await pg.connect();
    try {
      await pg.query("BEGIN");
      await pg.query("SET LOCAL lock_timeout = '5s'");
      const project = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_projects (id, theme_id, name, status, industries, catalog_sizes, model_key, draft_brief, created_by_email)
         VALUES ($1,$2,'Muse','ready','{home}','{small}','gemini-3.8-flash','An airy, minimal shop.','test@example.com')`,
        [project, `follow-up-${project}`],
      );
      const message = async (kind: string, body: string) => {
        const id = randomUUID();
        await pg.query(
          "INSERT INTO theme_studio_messages (id, project_id, kind, body) VALUES ($1,$2,$3,$4)",
          [id, project, kind, body],
        );
        return id;
      };
      let number = 0;
      const digest = () => randomUUID().replaceAll("-", "").padEnd(64, "0");
      /** A finished run of `kind`, and the version it made. */
      const made = async (
        kind: "generate" | "revise" | "images",
        messageId: string,
        pkg: unknown,
        base: { id: string; digest: string } | null,
        automatic = false,
      ) => {
        const run = randomUUID();
        await pg.query(
          `INSERT INTO theme_studio_runs (id, project_id, message_id, kind, provider, model_key, provider_model, prompt_version, idempotency_key, status, finished_at, automatic, base_version_id, base_package_digest, context_message_ids)
           VALUES ($1,$2,$3,$4,'fake','gemini-3.8-flash','fake','test',$5,'succeeded',now(),$6,$7,$8,$9)`,
          [
            run,
            project,
            messageId,
            kind,
            `follow-up-${run}`,
            automatic,
            base?.id ?? null,
            base?.digest ?? null,
            kind === "revise" ? [messageId] : [],
          ],
        );
        const version = { id: randomUUID(), digest: digest() };
        await pg.query(
          `INSERT INTO theme_studio_versions (id, project_id, run_id, version_number, intent_json, intent_digest, package_json, package_digest)
           VALUES ($1,$2,$3,$4,'{}',$5,$6,$5)`,
          [version.id, project, run, ++number, version.digest, pkg],
        );
        return version;
      };

      // A first build (the menu behind the menu button), the operator's
      // change (the menu shown), then two automatic fixes on top of it.
      const v1 = await made(
        "generate",
        await message("brief", brief.brief),
        withHeader("hamburger"),
        null,
      );
      const request =
        "there is no navigation or shop button in the navbar. add that. rest is ok";
      const v2 = await made(
        "revise",
        await message("revision", request),
        withHeader("centered"),
        v1,
      );
      const fixes = await message(
        "revision",
        "Revise this theme to clear its automatic checks.",
      );
      const v3 = await made(
        "revise",
        fixes,
        withHeader("centered", "compact"),
        v2,
        true,
      );
      const v4 = await made(
        "images",
        fixes,
        withHeader("centered", "compact"),
        v3,
        true,
      );

      const db = drizzle(pg, { schema });
      for (const from of [v2, v3, v4]) {
        const followUp = await loadFollowUp(db as never, project, from.id);
        expect(followUp?.request).toBe(request);
        expect(followUp?.before).toEqual({ [HEADER]: "hamburger" });
      }
      // A chain that starts from the first build: nothing was asked yet.
      expect(await loadFollowUp(db as never, project, v1.id)).toBeNull();
      // A picture request the operator made moves no setting.
      const v5 = await made(
        "images",
        await message("revision", "Redraw the hero"),
        withHeader("centered", "compact"),
        v4,
      );
      expect(await loadFollowUp(db as never, project, v5.id)).toBeNull();
      // Another project's version is never read.
      expect(await loadFollowUp(db as never, randomUUID(), v3.id)).toBeNull();
    } finally {
      await pg.query("ROLLBACK");
      await pg.end();
    }
  },
  30_000,
);
