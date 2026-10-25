// Opt-in local PostgreSQL integration. All DDL, fixtures and worker writes roll
// back. Preview provisioning is stubbed; no network or model provider calls.
import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import {
  THEME_STUDIO_QA_VIEWPORTS,
  type BrowserSample,
} from "./acceptance-gates";

const { service, openPreview } = vi.hoisted(() => ({
  service: vi.fn(),
  openPreview: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./config", () => ({
  getThemeStudioConfig: () => ({
    provider: "fake",
    generationEnabled: true,
    captureEnabled: true,
    autoQaEnabled: true,
    disabledModels: new Set(),
  }),
}));
vi.mock("./preview", async (original) => ({
  ...(await original<typeof import("./preview")>()),
  openThemeStudioPreview: openPreview,
}));
// TS-3A: a stop tells its operator once the settlement commits (builder
// 3B's notify.ts); here no notification or email worker runs.
vi.mock("./notify", () => ({ sendThemeStudioNotice: vi.fn(async () => {}) }));
import { runThemeStudioWorker } from "./worker";
import { runThemeStudioVisualQaWorker } from "./visual-qa";
import { claimThemeStudioCapture, finishThemeStudioCapture } from "./capture";
import { previewPagesFor } from "./preview";
import { currentAcceptanceBuildId } from "./acceptance";
import type { ThemePackageV2 } from "./contracts";
import { CHROME_STATES } from "./chrome-states";

it.skipIf(process.env.THEME_STUDIO_RECOVERY_DB_TEST !== "1")(
  "checks layouts before artwork, keeps publication fail-closed and stops repeated settings failures using real ancestry",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    vi.stubEnv(
      "THEME_STUDIO_PREVIEW_SECRET",
      "local-preflight-regression-only",
    );
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
      // One queue suite at a time (change-checks-postgres.test.ts says why);
      // taken before the lock timeout, released by the ROLLBACK.
      await pg.query(
        "SELECT pg_advisory_xact_lock(hashtext('theme_studio_queue_db_tests'))",
      );
      await pg.query("SET LOCAL lock_timeout = '5s'");
      if (
        !(
          await pg.query(
            "SELECT 1 FROM information_schema.columns WHERE table_name='theme_studio_captures' AND column_name='phase'",
          )
        ).rowCount
      )
        await pg.query(
          await readFile(
            "drizzle/migrations/sql/20261002_0148_theme_studio_layout_preflight.sql",
            "utf8",
          ),
        );
      // Isolate the local queues inside this rolled-back transaction.
      await pg.query(
        "UPDATE theme_studio_runs SET retry_not_before=now()+interval '1 hour' WHERE status='queued'",
      );
      await pg.query(
        "UPDATE theme_studio_captures SET status='failed',error_code='test_isolation',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE status IN ('queued','running')",
      );
      await pg.query(
        "UPDATE theme_studio_visual_qa_runs SET status='failed',error_code='test_isolation',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE status IN ('queued','running')",
      );
      const operator = randomUUID();
      await pg.query(
        "INSERT INTO platform_admins(id,email,role) VALUES($1,$2,'superadmin')",
        [operator, `${operator}@preflight.test`],
      );
      const db = drizzle(pg);
      let serial: Promise<unknown> = Promise.resolve();
      service.mockImplementation((work) => {
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
      async function draft() {
        const projectId = randomUUID(),
          messageId = randomUUID(),
          runId = randomUUID();
        await pg.query(
          `INSERT INTO theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by,created_by_email)
          VALUES($1,$2,'Preflight test','generating','{home}','{small}','gemini-3.8-flash','A calm ceramics shop',$3,'test@example.com')`,
          [projectId, `preflight-${projectId}`, operator],
        );
        await pg.query(
          "INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by) VALUES($1,$2,'brief','A calm ceramics shop',$3)",
          [messageId, projectId, operator],
        );
        await pg.query(
          `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,created_by,created_at)
          VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$4,$5,'1900-01-01')`,
          [runId, projectId, messageId, `preflight_${runId}`, operator],
        );
        expect(
          await runThemeStudioWorker({
            maxRuns: 1,
            providers: ["fake"],
            skipVisualQa: true,
          }),
        ).toMatchObject({ succeeded: 1 });
        const [version] = (
          await pg.query(
            "SELECT * FROM theme_studio_versions WHERE project_id=$1",
            [projectId],
          )
        ).rows;
        expect(version).toMatchObject({
          visibility: "internal",
          qa_status: "pending",
        });
        expect(
          (
            await pg.query(
              "SELECT phase,status FROM theme_studio_captures WHERE project_id=$1",
              [projectId],
            )
          ).rows,
        ).toEqual([{ phase: "layout", status: "queued" }]);
        expect(
          (
            await pg.query(
              "SELECT count(*)::int AS n FROM theme_studio_runs WHERE project_id=$1 AND kind='images'",
              [projectId],
            )
          ).rows[0].n,
        ).toBe(0);
        return { projectId, version };
      }
      async function measure(
        version: { id: string; package_json: ThemePackageV2 },
        fail = false,
        /** A small tap target on the phone home page: a warning only. */
        warn = false,
      ) {
        const pages = previewPagesFor(version.package_json);
        openPreview.mockResolvedValue({
          origin: "https://preview.example.test",
          storeId: randomUUID(),
          pages,
        });
        const claim = await claimThemeStudioCapture();
        expect(claim?.qa?.phase).toBe("layout");
        expect(claim?.shots).toEqual([]);
        const samples: BrowserSample[] = Object.entries(
          THEME_STUDIO_QA_VIEWPORTS,
        ).flatMap(([viewport, size]) =>
          pages.map((page) => ({
            viewport: viewport as BrowserSample["viewport"],
            surface: page.surface,
            path: page.path,
            ...size,
            overflowPx: 0,
            overflowOffenders: [],
            clippedText: [],
            smallTapTargets:
              warn && viewport === "phone360" && page.surface === "home"
                ? [{ target: "a.tiny", width: 18, height: 18 }]
                : [],
            imageCropIssues: [],
            brokenImages: 0,
            lcpMs: 900,
            cls: 0.01,
            // The home page's menu, search, cart, account and sign-in states,
            // opened and clean: the coverage gate requires them there.
            ...(page.surface === "home"
              ? {
                  states: CHROME_STATES.map((state) => ({
                    state,
                    measured: true,
                    violations: [],
                    clippedText: [],
                    smallTapTargets: [],
                    contrastUnresolved: [],
                  })),
                }
              : {}),
            violations:
              fail && viewport === "phone360" && page.surface === "home"
                ? [
                    {
                      id: "color-contrast",
                      impact: "serious",
                      nodes: 1,
                      help: "Elements must meet minimum color contrast",
                      target: ".shop-card-price",
                    },
                  ]
                : [],
          })),
        );
        // ★ TS-3A: the layout check needs no model call, so the capture's
        // own finish settles it; no review is left waiting for the route.
        expect(
          await finishThemeStudioCapture({
            captureId: claim!.captureId,
            leaseToken: claim!.leaseToken,
            images: [],
            qa: {
              buildId: currentAcceptanceBuildId(),
              evidence: { userAgent: "local integration", samples },
              screenshots: [],
            },
          }),
        ).toEqual({ status: "succeeded", versionId: version.id });
      }
      async function rejected(sql: string, args: unknown[]) {
        await pg.query("SAVEPOINT invalid_write");
        await expect(pg.query(sql, args)).rejects.toThrow();
        await pg.query("ROLLBACK TO SAVEPOINT invalid_write");
      }
      const first = await draft();
      await rejected(
        "UPDATE theme_studio_captures SET phase='final' WHERE project_id=$1",
        [first.projectId],
      );
      await rejected(
        "INSERT INTO theme_studio_visual_qa_runs(project_id,version_id,package_digest,qa_iteration,browser_report,screenshot_asset_ids) VALUES($1,$2,$3,0,'{}','{}')",
        [first.projectId, first.version.id, first.version.package_digest],
      );
      await measure(first.version, false, true);
      // The finish records only the checks that stop the run: a check that
      // holds only a warning (the small tap target) is not one.
      expect(
        (
          await pg.query(
            "SELECT detail->'failedGates' AS failed FROM theme_studio_events WHERE project_id=$1 AND event_type='auto_qa_browser_finished'",
            [first.projectId],
          )
        ).rows,
      ).toEqual([{ failed: [] }]);
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM theme_studio_acceptance_runs WHERE project_id=$1",
            [first.projectId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM theme_studio_versions WHERE project_id=$1",
            [first.projectId],
          )
        ).rows[0].n,
      ).toBe(1);
      // Settled in the finish: passed, with the photo run already queued,
      // and nothing left for the review worker.
      expect(
        (
          await pg.query(
            "SELECT status FROM theme_studio_visual_qa_runs WHERE project_id=$1",
            [first.projectId],
          )
        ).rows,
      ).toEqual([{ status: "passed" }]);
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 0, layoutPassed: 0, passed: 0 });
      expect(
        (
          await pg.query(
            "SELECT kind,status,automatic FROM theme_studio_runs WHERE project_id=$1 AND kind='images'",
            [first.projectId],
          )
        ).rows,
      ).toEqual([{ kind: "images", status: "queued", automatic: true }]);
      expect(
        (
          await pg.query(
            "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
            [first.projectId],
          )
        ).rows[0],
      ).toEqual({ status: "generating", current_version_id: null });
      // No preflight can stand in for final acceptance, even through SQL.
      await pg.query("SAVEPOINT candidate_attempt");
      await pg.query(
        "UPDATE theme_studio_projects SET status='ready',current_version_id=$2 WHERE id=$1",
        [first.projectId, first.version.id],
      );
      await expect(
        pg.query(
          "UPDATE theme_studio_projects SET status='candidate' WHERE id=$1",
          [first.projectId],
        ),
      ).rejects.toThrow();
      await pg.query("ROLLBACK TO SAVEPOINT candidate_attempt");
      const second = await draft();
      await measure(second.version, true);
      // The failed layout check queued its settings repair in the finish.
      expect(
        (
          await pg.query(
            "SELECT status FROM theme_studio_visual_qa_runs WHERE project_id=$1",
            [second.projectId],
          )
        ).rows,
      ).toEqual([{ status: "revision_queued" }]);
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 0 });
      const [repair] = (
        await pg.query(
          "SELECT id FROM theme_studio_runs WHERE project_id=$1 AND automatic AND kind='revise'",
          [second.projectId],
        )
      ).rows;
      const child = randomUUID();
      // Simulate a valid settings revision that failed to improve contrast.
      await pg.query(
        `INSERT INTO theme_studio_versions(id,project_id,run_id,parent_version_id,version_number,intent_json,intent_digest,package_json,package_digest,visibility,qa_status,qa_iteration)
        SELECT $1,project_id,$2,id,2,intent_json,intent_digest,package_json,package_digest,'internal','pending',1 FROM theme_studio_versions WHERE id=$3`,
        [child, repair.id, second.version.id],
      );
      await pg.query(
        `INSERT INTO theme_studio_visual_qa_runs(project_id,version_id,package_digest,qa_iteration,browser_report,screenshot_asset_ids,created_by)
        SELECT project_id,$2,package_digest,1,browser_report,'{}',created_by FROM theme_studio_visual_qa_runs WHERE project_id=$1 AND status='revision_queued'`,
        [second.projectId, child],
      );
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ failed: 1, revisionQueued: 0 });
      expect(
        (
          await pg.query(
            "SELECT error_code,vision_report FROM theme_studio_visual_qa_runs WHERE version_id=$1",
            [child],
          )
        ).rows[0],
      ).toMatchObject({
        error_code: "qa_no_progress",
        vision_report: {
          diagnosis: expect.stringContaining("did not improve"),
        },
      });
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM theme_studio_runs WHERE project_id=$1 AND kind='revise'",
            [second.projectId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await pg.query(
            "SELECT has_table_privilege('app_user','theme_studio_visual_qa_runs','SELECT') AS allowed",
          )
        ).rows[0].allowed,
      ).toBe(false);
    } finally {
      await pg.query("ROLLBACK");
      await pg.end();
      vi.unstubAllEnvs();
    }
  },
  30_000,
);
