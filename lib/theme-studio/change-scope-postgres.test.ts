// Opt-in local PostgreSQL regression for scoped operator revisions. All
// fixtures and worker writes roll back; no provider calls (the offline model
// stands in for Gemini). Run THEME_STUDIO_CHANGE_SCOPE_DB_TEST=1 with Vitest.
import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import { createFakeModelClient } from "./fake-provider";
import type { StructuredRequest } from "./provider";
import { THEME_STUDIO_PROMPT_VERSION } from "./prompt-features";

const { service, generate, config } = vi.hoisted(() => ({
  service: vi.fn(),
  generate: vi.fn(),
  config: { autoQaEnabled: false },
}));
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./gemini-vertex", () => ({
  getVertexConfig: () => ({}),
  createVertexModelClient: () => ({ provider: "vertex-gemini", generate }),
}));
vi.mock("./config", () => ({
  getThemeStudioConfig: () => ({
    generationEnabled: true,
    autoQaEnabled: config.autoQaEnabled,
    disabledModels: new Set(),
  }),
}));
vi.mock("./visual-qa", () => ({ runThemeStudioVisualQaWorker: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
import { runThemeStudioWorker } from "./worker";

it.skipIf(process.env.THEME_STUDIO_CHANGE_SCOPE_DB_TEST !== "1")(
  "recreates from the original brief and redraws only the pictures an edit names",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    process.env.THEME_STUDIO_GCP_PROJECT_ID ||= "change-scope-test";
    const pg = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      password: process.env.DB_ADMIN_PASSWORD,
      connectionTimeoutMillis: 5_000,
    });
    await pg.connect();
    try {
      await pg.query("BEGIN");
      await pg.query("SET LOCAL lock_timeout = '5s'");
      if (
        !(
          await pg.query(
            "SELECT to_regclass('public.theme_studio_generation_responses') AS name",
          )
        ).rows[0].name
      )
        await pg.query(
          await readFile(
            "drizzle/migrations/sql/20261002_0146_theme_studio_rate_limit_recovery.sql",
            "utf8",
          ),
        );
      // Nothing queued elsewhere in this database may be claimed by the test.
      await pg.query(
        "UPDATE theme_studio_runs SET retry_not_before = now() + interval '1 hour' WHERE status='queued'",
      );
      const db = drizzle(pg);
      let transactions: Promise<unknown> = Promise.resolve();
      service.mockImplementation((work) => {
        const result = transactions.then(async () => {
          await pg.query("SET LOCAL ROLE app_service");
          try {
            return await work(db);
          } finally {
            await pg.query("RESET ROLE");
          }
        });
        transactions = result.catch(() => {});
        return result;
      });
      const fake = createFakeModelClient({
        name: "Scope test",
        brief: "A ceramics shop [[fake:edit-image]]",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        referenceCount: 0,
      });
      const requests: StructuredRequest[] = [];
      generate.mockImplementation(
        async (request: StructuredRequest, signal: AbortSignal) => {
          requests.push(request);
          return fake.generate(request, signal);
        },
      );

      const project = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_projects (id, theme_id, name, status, industries, catalog_sizes, model_key, draft_brief, created_by_email)
        VALUES ($1, $2, 'Scope test', 'generating', '{home}', '{small}', 'gemini-3.8-flash', 'A ceramics shop', 'test@example.com')`,
        [project, `scope-${project.slice(0, 8)}`],
      );
      const queue = async (
        kind: "generate" | "revise",
        messageKind: "brief" | "revision",
        body: string,
      ) => {
        const message = randomUUID();
        const run = randomUUID();
        await pg.query(
          "UPDATE theme_studio_projects SET status='generating' WHERE id=$1",
          [project],
        );
        await pg.query(
          "INSERT INTO theme_studio_messages (id, project_id, kind, body) VALUES ($1, $2, $3, $4)",
          [message, project, messageKind, body],
        );
        const base =
          kind === "revise"
            ? (
                await pg.query(
                  "SELECT id, package_digest FROM theme_studio_versions WHERE project_id=$1 ORDER BY version_number DESC LIMIT 1",
                  [project],
                )
              ).rows[0]
            : null;
        await pg.query(
          `INSERT INTO theme_studio_runs (id, project_id, message_id, kind, provider, model_key, provider_model, prompt_version, idempotency_key, base_version_id, base_package_digest, context_message_ids, created_at)
          VALUES ($1,$2,$3,$4,'vertex-gemini','gemini-3.8-flash','fake',$5,$6,$7,$8,$9,'1900-01-01')`,
          [
            run,
            project,
            message,
            kind,
            THEME_STUDIO_PROMPT_VERSION,
            `scope_${run}`,
            base?.id ?? null,
            base?.package_digest ?? null,
            kind === "revise" ? [message] : [],
          ],
        );
        return { run, base };
      };
      const options = {
        maxRuns: 1,
        providers: ["vertex-gemini" as const],
        skipVisualQa: true,
      };
      const detail = async (run: string) =>
        (
          await pg.query(
            "SELECT status, error_code, outcome_detail FROM theme_studio_runs WHERE id=$1",
            [run],
          )
        ).rows[0];

      await queue("generate", "brief", "A ceramics shop");
      expect(await runThemeStudioWorker(options)).toMatchObject({
        succeeded: 1,
      });

      // 1. An explicit "start over": a fresh build from the ORIGINAL brief.
      requests.length = 0;
      const recreate = await queue(
        "revise",
        "revision",
        "Start over from scratch with a bolder look.",
      );
      expect(await runThemeStudioWorker(options)).toMatchObject({
        succeeded: 1,
      });
      expect(await detail(recreate.run)).toMatchObject({
        status: "succeeded",
        outcome_detail: { kind: "change", scope: "recreate", explicit: true },
      });
      const sent = requests
        .flatMap((r) => r.content)
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      expect(sent).toContain("A ceramics shop");
      expect(sent).toContain("bolder look");
      expect(sent).not.toContain("This is a REVISION");
      const [recreated] = (
        await pg.query(
          "SELECT parent_version_id FROM theme_studio_versions WHERE run_id=$1",
          [recreate.run],
        )
      ).rows;
      expect(recreated.parent_version_id).toBe(recreate.base!.id);

      // 2. An image-only edit with automatic QA: the version keeps every
      // asset and exactly the named picture is handed to an image run.
      config.autoQaEnabled = true;
      const edit = await queue(
        "revise",
        "revision",
        "Make the hero picture brighter.",
      );
      expect(await runThemeStudioWorker(options)).toMatchObject({
        succeeded: 1,
      });
      const editDetail = await detail(edit.run);
      expect(editDetail.outcome_detail).toMatchObject({
        kind: "change",
        scope: "edit",
        changed: [],
      });
      const [slot] = editDetail.outcome_detail.redraws as string[];
      const [edited] = (
        await pg.query(
          "SELECT id, visibility, qa_status, package_json FROM theme_studio_versions WHERE run_id=$1",
          [edit.run],
        )
      ).rows;
      const [baseVersion] = (
        await pg.query(
          "SELECT package_json FROM theme_studio_versions WHERE id=$1",
          [edit.base!.id],
        )
      ).rows;
      expect(edited).toMatchObject({
        visibility: "internal",
        qa_status: "pending",
      });
      expect(edited.package_json.assets).toEqual(
        baseVersion.package_json.assets,
      );
      const images = (
        await pg.query(
          `SELECT r.kind, r.automatic, r.image_slot_ids, r.base_version_id, m.body
           FROM theme_studio_runs r JOIN theme_studio_messages m ON m.id=r.message_id
           WHERE r.project_id=$1 AND r.kind='images'`,
          [project],
        )
      ).rows;
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({
        automatic: true,
        image_slot_ids: [slot],
        base_version_id: edited.id,
      });
      expect(JSON.parse(images[0].body).qaImageCorrections[slot]).toContain(
        "brighter morning version",
      );
      // No layout capture is queued: the redraw goes straight to final QA.
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM theme_studio_captures WHERE version_id=$1",
            [edited.id],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await pg.query("ROLLBACK").catch(() => {});
      await pg.end();
    }
  },
  60_000,
);
