// Opt-in local PostgreSQL regression (Theme Studio TS-3B): the worker's
// queue order, the fresh photo run's time floor, a refused style photo that
// a fill round draws again, and the notice that tells ONLY the operator who
// started the theme. Every fixture and write rolls back; the providers are
// offline stubs: no network, no model call, nothing paid.
// Run THEME_STUDIO_RECOVERY_DB_TEST=1 with Vitest.
import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import { createFakeModelClient } from "./fake-provider";
import { ZERO_USAGE, type StructuredRequest } from "./provider";
import type { ThemeImageRequest } from "./image-provider";

const { service, generate, draw, kick, logInfo } = vi.hoisted(() => ({
  service: vi.fn(),
  generate: vi.fn(),
  draw: vi.fn(),
  kick: vi.fn(async () => {}),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./gemini-vertex", () => ({
  getVertexConfig: () => ({}),
  createVertexModelClient: () => ({ provider: "vertex-gemini", generate }),
}));
vi.mock("./config", () => ({
  getThemeStudioConfig: () => ({
    generationEnabled: true,
    autoQaEnabled: false,
    disabledModels: new Set(),
  }),
}));
vi.mock("./visual-qa", () => ({ runThemeStudioVisualQaWorker: vi.fn() }));
vi.mock("./image-fake", async (original) => {
  const actual = await original<typeof import("./image-fake")>();
  return {
    ...actual,
    createFakeImageClient: () => ({ provider: "fake", generateImage: draw }),
  };
});
// The notice's email is queued for real; the kick of the mail worker is not.
vi.mock("@/lib/email/trigger-worker", () => ({ triggerEmailWorker: kick }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo,
  logWarn: vi.fn(),
}));

import { runThemeStudioWorker } from "./worker";

it.skipIf(process.env.THEME_STUDIO_RECOVERY_DB_TEST !== "1")(
  "repairs first, holds a fresh photo run for a fresh request, redraws a refused style photo in a fill round, and tells only the starting operator",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
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
      // Nothing else queued may be claimed by this test's worker.
      await pg.query(
        "UPDATE theme_studio_runs SET retry_not_before = now() + interval '1 hour' WHERE status='queued'",
      );
      const db = drizzle(pg);
      let serial: Promise<unknown> = Promise.resolve();
      service.mockImplementation((work: (db: unknown) => Promise<unknown>) => {
        const result = serial.then(async () => {
          await pg.query("SET LOCAL ROLE app_service");
          try {
            return await work(db);
          } finally {
            await pg.query("RESET ROLE");
          }
        });
        serial = result.catch(() => {});
        return result;
      });
      const starter = `starter-${randomUUID()}@storemink.test`;
      const colleague = `colleague-${randomUUID()}@storemink.test`;
      for (const email of [starter, colleague])
        await pg.query(
          "INSERT INTO platform_admins(id,email,role) VALUES($1,$2,'superadmin')",
          [randomUUID(), email],
        );
      const fake = createFakeModelClient({
        name: "Queue test",
        brief: "A calm ceramics shop",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        referenceCount: 0,
      });
      generate.mockImplementation(
        (request: StructuredRequest, signal: AbortSignal) =>
          fake.generate(request, signal),
      );
      // Two themes started by the same operator (one active run each, as
      // the database allows): A gets a photo run, B an automatic repair.
      const newProject = async (name: string) => {
        const id = randomUUID();
        const message = randomUUID();
        await pg.query(
          `INSERT INTO theme_studio_projects (id, theme_id, name, status, industries, catalog_sizes, model_key, draft_brief, created_by_email)
           VALUES ($1,$2,$3,'generating','{home}','{small}','gemini-3.8-flash','A calm ceramics shop',$4)`,
          [id, `queue-${id}`, name, starter.toUpperCase()],
        );
        await pg.query(
          "INSERT INTO theme_studio_messages (id, project_id, kind, body) VALUES ($1,$2,'brief','A calm ceramics shop')",
          [message, id],
        );
        return { id, message };
      };
      const insertRun = async (
        owner: { id: string; message: string },
        values: Record<string, unknown>,
      ): Promise<string> => {
        const id = randomUUID();
        const row = {
          id,
          project_id: owner.id,
          message_id: owner.message,
          provider: "vertex-gemini",
          model_key: "gemini-3.8-flash",
          provider_model: "fake",
          prompt_version: "test",
          idempotency_key: `ts3b_${id}`,
          ...values,
        };
        const keys = Object.keys(row);
        await pg.query(
          `INSERT INTO theme_studio_runs (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
          Object.values(row),
        );
        return id;
      };
      const options = {
        maxRuns: 1,
        providers: ["vertex-gemini" as const, "fake" as const],
        skipVisualQa: true,
      };
      const designed = async (owner: { id: string; message: string }) => {
        const design = await insertRun(owner, { kind: "generate" });
        expect(await runThemeStudioWorker(options)).toMatchObject({
          claimed: 1,
          succeeded: 1,
        });
        await pg.query(
          "UPDATE theme_studio_projects SET status='generating' WHERE id=$1",
          [owner.id],
        );
        return (
          await pg.query(
            "SELECT id, package_digest FROM theme_studio_versions WHERE run_id=$1",
            [design],
          )
        ).rows[0] as { id: string; package_digest: string };
      };

      // 1. Each design run makes a version 1 (every photo a placeholder).
      const a = await newProject("Queue test");
      const b = await newProject("Repair test");
      const v1 = await designed(a);
      const b1 = await designed(b);
      const project = a.id;

      // 2. An automatic repair queued AFTER a photo run is claimed first.
      const photos = await insertRun(a, {
        kind: "images",
        provider: "fake",
        base_version_id: v1.id,
        base_package_digest: v1.package_digest,
        max_attempts: 3,
        created_at: "1900-01-01",
      });
      const repairMessage = randomUUID();
      await pg.query(
        "INSERT INTO theme_studio_messages (id, project_id, kind, body) VALUES ($1,$2,'revision','Raise the button contrast')",
        [repairMessage, b.id],
      );
      const repair = await insertRun(b, {
        kind: "revise",
        message_id: repairMessage,
        context_message_ids: [repairMessage],
        base_version_id: b1.id,
        base_package_digest: b1.package_digest,
        automatic: true,
        qa_iteration: 1,
        created_at: "1950-01-01",
      });
      // Only the repair is offered; the claim must pick it over the older run.
      generate.mockImplementation(async () => ({
        kind: "error",
        code: "provider_auth",
        usage: ZERO_USAGE,
      }));
      expect(await runThemeStudioWorker(options)).toMatchObject({
        claimed: 1,
      });
      const attempts = async (id: string) =>
        (
          await pg.query(
            "SELECT status, attempt_count FROM theme_studio_runs WHERE id=$1",
            [id],
          )
        ).rows[0];
      expect(await attempts(repair)).toMatchObject({
        status: "failed",
        attempt_count: 1,
      });
      expect(await attempts(photos)).toMatchObject({
        status: "queued",
        attempt_count: 0,
      });
      // The repair stopped theme B: its starter, and only its starter, is
      // told, in the bell and by email (owner's decision 8).
      const told = (
        await pg.query(
          "SELECT recipient_type, recipient_id, type, title, url FROM notifications WHERE type='platform.theme_studio_needs_fix' AND url=$1",
          [`/dashboard/themes/studio/${b.id}`],
        )
      ).rows;
      expect(told).toEqual([
        {
          recipient_type: "operator",
          recipient_id: starter,
          type: "platform.theme_studio_needs_fix",
          title: "Needs a fix · Repair test",
          url: `/dashboard/themes/studio/${b.id}`,
        },
      ]);
      expect(
        (
          await pg.query(
            "SELECT email FROM notification_email_queue WHERE event_key='platform.theme_studio_needs_fix' AND url=$1",
            [`/dashboard/themes/studio/${b.id}`],
          )
        ).rows,
      ).toEqual([{ email: starter }]);
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM notifications WHERE recipient_id=$1",
            [colleague],
          )
        ).rows[0].n,
      ).toBe(0);

      // 3. A fresh photo run waits for a request with nine minutes left; a
      //    started one carries on with less.
      await pg.query(
        "UPDATE theme_studio_projects SET status='generating' WHERE id=$1",
        [project],
      );
      const late = { ...options, deadlineAt: Date.now() + 8 * 60_000 };
      expect(await runThemeStudioWorker(late)).toMatchObject({ claimed: 0 });
      expect(await attempts(photos)).toMatchObject({
        status: "queued",
        attempt_count: 0,
      });

      // 4. Its style photo is refused on every try: the run fails, but a
      //    fill round queues the same slots to draw it again, and the theme
      //    keeps building (no notice).
      draw.mockImplementation(async (request: ThemeImageRequest) =>
        request.purpose === "anchor"
          ? {
              kind: "refused",
              reason: "IMAGE_SAFETY",
              usage: { inputTokens: 0, outputTokens: 0 },
            }
          : {
              kind: "error",
              code: "provider_unavailable",
              usage: { inputTokens: 0, outputTokens: 0 },
            },
      );
      const noticesBefore = (
        await pg.query(
          "SELECT count(*)::int AS n FROM notifications WHERE type LIKE 'platform.theme_studio_%' AND url=$1",
          [`/dashboard/themes/studio/${project}`],
        )
      ).rows[0].n;
      expect(await runThemeStudioWorker(options)).toMatchObject({
        claimed: 1,
        failed: 1,
      });
      expect(
        (
          await pg.query(
            "SELECT status, error_code FROM theme_studio_runs WHERE id=$1",
            [photos],
          )
        ).rows[0],
      ).toEqual({ status: "failed", error_code: "images_anchor_refused" });
      const [fill] = (
        await pg.query(
          "SELECT idempotency_key, base_version_id, image_slot_ids, status FROM theme_studio_runs WHERE project_id=$1 AND idempotency_key LIKE 'images_fill_%'",
          [project],
        )
      ).rows;
      expect(fill).toMatchObject({
        idempotency_key: `images_fill_${photos}_1`,
        base_version_id: v1.id,
        status: "queued",
      });
      expect(fill.image_slot_ids.length).toBeGreaterThan(0);
      expect(
        (
          await pg.query(
            "SELECT status FROM theme_studio_projects WHERE id=$1",
            [project],
          )
        ).rows[0].status,
      ).toBe("generating");
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM notifications WHERE type LIKE 'platform.theme_studio_%' AND url=$1",
            [`/dashboard/themes/studio/${project}`],
          )
        ).rows[0].n,
      ).toBe(noticesBefore);
      expect(kick).toHaveBeenCalled();
      // ★ Its run settled line says the work goes on, so the alert for a
      // failed run (scripts/prod-monitoring.py, alert 16) leaves it out; a
      // failure that stopped a theme (step 2) never carries it.
      const settled = logInfo.mock.calls
        .filter(([message]) => message === "theme studio: run settled")
        .map(([, context]) => context as Record<string, unknown>);
      expect(settled.at(-1)).toMatchObject({
        runId: photos,
        outcome: "failed",
        errorCode: "images_anchor_refused",
        continues: true,
      });
      expect(settled.filter((line) => "continues" in line)).toHaveLength(1);
      expect(
        settled.filter((line) => line.outcome === "failed").length,
      ).toBeGreaterThan(1);
    } finally {
      await pg.query("ROLLBACK");
      await pg.end();
    }
  },
  60_000,
);
