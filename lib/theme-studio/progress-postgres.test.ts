// Opt-in local PostgreSQL regression for the TS-2 reads (progress.ts): the
// theme page's progress of a theme that is building, the list's filters and
// counts, a theme Ready to publish whose page and list say the same, the
// check screenshots paired with their pages and widths, the bytes route's
// refusals, and the build-time range. Real tables, constraints and the
// app_service role; every write rolls back. Reads only: no network, browser
// or model call. Run THEME_STUDIO_RECOVERY_DB_TEST=1 with Vitest.
import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import {
  GATE_LABELS,
  acceptanceAssetsDigest,
  gate,
  type GateId,
} from "./acceptance-gates";
import { operatorImagePackage, placeholderPackage, hex } from "./_test-helpers";

const { service } = vi.hoisted(() => ({ service: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./config", () => ({
  getThemeStudioConfig: () => ({
    provider: "fake",
    generationEnabled: true,
    captureEnabled: true,
    autoQaEnabled: true,
    performanceRequired: false,
    dailySpendMicroUsd: null,
    disabledModels: new Set(),
  }),
}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/observability/logger", async (original) => ({
  ...(await original<typeof import("@/lib/observability/logger")>()),
  logWarn: vi.fn(),
}));

import { assetRowsFor } from "./acceptance";
import {
  listThemeStudioCheckScreenshots,
  listThemeStudioProjectsForConsole,
  readThemeStudioBuildTimeRange,
  readThemeStudioCheckScreenshot,
  readThemeStudioProgress,
  resetThemeStudioProgressCaches,
} from "./progress";
import { digestThemeStudioJson } from "./repository";
import {
  studioListFilter,
  studioStatus,
} from "@/app/platform/dashboard/(console)/themes/studio/studio-status";

const BUILD = "progress-build-1";

it.skipIf(process.env.THEME_STUDIO_RECOVERY_DB_TEST !== "1")(
  "reads progress, the list, check screenshots and the build time from the real tables, never their bytes",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    vi.stubEnv("THEME_STUDIO_BUILD_ID", BUILD);
    resetThemeStudioProgressCaches();
    const pg = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      password: process.env.DB_ADMIN_PASSWORD,
      connectionTimeoutMillis: 5000,
    });
    await pg.connect();
    const statements: string[] = [];
    try {
      await pg.query("BEGIN");
      // One queue suite at a time (change-checks-postgres.test.ts says why);
      // taken before the lock timeout, released by the ROLLBACK.
      await pg.query(
        "SELECT pg_advisory_xact_lock(hashtext('theme_studio_queue_db_tests'))",
      );
      await pg.query("SET LOCAL lock_timeout = '5s'");
      const operator = randomUUID();
      const email = `${operator}@progress.test`;
      await pg.query(
        "INSERT INTO platform_admins(id,email,role) VALUES($1,$2,'superadmin')",
        [operator, email],
      );
      const db = drizzle(pg);
      const ago = (minutes: number) => `now() - interval '${minutes} minutes'`;

      /** A project with its brief message; returns its ids. */
      async function project(name: string, status: string, minutesAgo: number) {
        const projectId = randomUUID();
        const messageId = randomUUID();
        await pg.query(
          `INSERT INTO theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by,created_by_email,created_at,updated_at,archived_at)
           VALUES($1,$2,$3,$4,'{home}','{small}','gemini-3.8-flash','A calm ceramics shop',$5,$6,${ago(minutesAgo)},${ago(minutesAgo)},CASE WHEN $4='archived' THEN now() END)`,
          [
            projectId,
            `progress-${projectId.slice(0, 8)}`,
            name,
            status,
            operator,
            email,
          ],
        );
        await pg.query(
          `INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by,created_at)
           VALUES($1,$2,'brief','A calm ceramics shop',$3,${ago(minutesAgo)})`,
          [messageId, projectId, operator],
        );
        return {
          projectId,
          messageId,
          themeId: `progress-${projectId.slice(0, 8)}`,
        };
      }
      async function event(
        projectId: string,
        type: string,
        minutesAgo: number,
        detail: Record<string, unknown> = {},
        runId: string | null = null,
        operatorEvent = true,
      ) {
        await pg.query(
          `INSERT INTO theme_studio_events(project_id,run_id,actor_kind,actor_id,actor_email,event_type,detail,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,${ago(minutesAgo)})`,
          operatorEvent
            ? [
                projectId,
                runId,
                "operator",
                operator,
                email,
                type,
                JSON.stringify(detail),
              ]
            : [
                projectId,
                runId,
                "worker",
                null,
                null,
                type,
                JSON.stringify(detail),
              ],
        );
      }
      async function version(
        projectId: string,
        runId: string | null,
        number: number,
        pkg: unknown,
        visibility: "operator" | "internal",
        minutesAgo: number,
      ) {
        const versionId = randomUUID();
        const digest = digestThemeStudioJson(pkg);
        await pg.query(
          `INSERT INTO theme_studio_versions(id,project_id,run_id,version_number,intent_json,intent_digest,package_json,package_digest,visibility,qa_status,created_at)
           VALUES($1,$2,$3,$4,'{}',$5,$6,$7,$8,$9,${ago(minutesAgo)})`,
          [
            versionId,
            projectId,
            runId,
            number,
            "a".repeat(64),
            JSON.stringify(pkg),
            digest,
            visibility,
            visibility === "internal" ? "pending" : "passed",
          ],
        );
        return { versionId, digest };
      }

      // ── A: a first build, drawing its pictures ────────────────────────
      const a = await project("Building", "generating", 30);
      await event(a.projectId, "run_queued", 30);
      const generateId = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,created_at,started_at,finished_at,usage,outcome_detail,created_by)
         VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$4,'succeeded',${ago(30)},${ago(29)},${ago(25)},$5,'{"kind":"version"}',$6)`,
        [
          generateId,
          a.projectId,
          a.messageId,
          `progress_gen_${generateId}`,
          JSON.stringify({
            calls: [
              { stage: "intent", attempt: 1, usage: {}, durationMs: 50_000 },
              { stage: "draft", attempt: 1, usage: {}, durationMs: 190_000 },
            ],
          }),
          operator,
        ],
      );
      const hidden = await version(
        a.projectId,
        generateId,
        1,
        placeholderPackage(),
        "internal",
        25,
      );
      const layoutCaptureId = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_captures(id,project_id,version_id,package_digest,status,previous_status,idempotency_key,automatic,phase,result_version_id,created_at,started_at,finished_at,created_by)
         VALUES($1,$2,$3,$4,'succeeded','generating',$5,true,'layout',$3,${ago(24)},${ago(24)},${ago(23)},$6)`,
        [
          layoutCaptureId,
          a.projectId,
          hidden.versionId,
          hidden.digest,
          `auto_layout_${generateId}`,
          operator,
        ],
      );
      await pg.query(
        `INSERT INTO theme_studio_visual_qa_runs(id,project_id,version_id,package_digest,qa_iteration,status,browser_report,screenshot_asset_ids,vision_report,created_by,created_at,started_at,finished_at)
         VALUES($1,$2,$3,$4,0,'passed',$5,'{}','{}',$6,${ago(23)},${ago(23)},${ago(22)})`,
        [
          randomUUID(),
          a.projectId,
          hidden.versionId,
          hidden.digest,
          JSON.stringify({
            phase: "layout",
            buildId: BUILD,
            evidence: { userAgent: "x", samples: [] },
            gates: [],
          }),
          operator,
        ],
      );
      const imagesMessage = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by,created_at)
         VALUES($1,$2,'images','Automatically generate images for 5 slots.',$3,${ago(22)})`,
        [imagesMessage, a.projectId, operator],
      );
      const imagesId = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,base_version_id,base_package_digest,provider,model_key,provider_model,prompt_version,idempotency_key,status,lease_owner,lease_expires_at,automatic,created_at,started_at,created_by)
         VALUES($1,$2,$3,'images',$4,$5,'fake','gemini-3.8-flash','fake','theme-studio-image-fake-v1',$6,'running',$7,now()+interval '1 minute',true,${ago(22)},${ago(21)},$8)`,
        [
          imagesId,
          a.projectId,
          imagesMessage,
          hidden.versionId,
          hidden.digest,
          `auto_images_${randomUUID()}`,
          randomUUID(),
          operator,
        ],
      );
      await event(
        a.projectId,
        "images_requested",
        22,
        { versionId: hidden.versionId, slots: 5, automatic: true },
        imagesId,
        false,
      );
      for (const [i, minutesAgo] of [
        [1, 6],
        [2, 1],
      ] as const)
        await pg.query(
          `INSERT INTO theme_studio_image_checkpoints(run_id,request_digest,response_json,image_bytes,created_at)
           VALUES($1,$2,$3,$4,${ago(minutesAgo)})`,
          [
            imagesId,
            hex(`progress-draw-${i}-${imagesId}`),
            JSON.stringify({
              stage: "draw",
              call: {},
              response: { kind: "ok", mediaType: "image/webp", usage: {} },
            }),
            Buffer.from(`not a real picture ${i}`),
          ],
        );

      // ── B: Ready to publish on today's evidence, with screenshots ─────
      const b = await project("Ready", "ready", 120);
      const bRun = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,created_at,started_at,finished_at,created_by)
         VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$4,'succeeded',${ago(120)},${ago(119)},${ago(110)},$5)`,
        [bRun, b.projectId, b.messageId, `progress_gen_${bRun}`, operator],
      );
      const pkg = operatorImagePackage();
      const ready = await version(b.projectId, bRun, 1, pkg, "operator", 110);
      await pg.query(
        "UPDATE theme_studio_projects SET current_version_id=$2 WHERE id=$1",
        [b.projectId, ready.versionId],
      );
      const assetsDigest = acceptanceAssetsDigest(
        pkg,
        await assetRowsFor(db as never, b.projectId, pkg),
      );
      const gates = (Object.keys(GATE_LABELS) as GateId[]).map((id) =>
        gate(
          id,
          id === "browser.tap_targets"
            ? [
                {
                  code: "small_target",
                  message:
                    "20×18px interactive target (.chip); minimum is 24×24px.",
                  where: "phone390 · shop",
                },
              ]
            : [],
          { required: id !== "browser.performance" },
        ),
      );
      const checkRunId = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_acceptance_runs(id,project_id,version_id,package_digest,assets_digest,build_id,status,server_report,browser_report,evidence_digest,created_by,created_by_email,created_at,updated_at,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,'passed',$7,$8,$9,$10,$11,${ago(100)},${ago(100)},${ago(100)})`,
        [
          checkRunId,
          b.projectId,
          ready.versionId,
          ready.digest,
          assetsDigest,
          BUILD,
          JSON.stringify({
            version: 2,
            gates: gates.filter((g) => !g.id.startsWith("browser.")),
          }),
          JSON.stringify({
            version: 2,
            gates: gates.filter((g) => g.id.startsWith("browser.")),
          }),
          "e".repeat(64),
          operator,
          email,
        ],
      );
      const shots = [
        {
          width: 390,
          height: 2400,
          media: "image/webp",
          surface: "home",
          viewport: "phone390",
        },
        {
          width: 390,
          height: 1300,
          media: "image/webp",
          surface: "cart",
          viewport: "phone390",
        },
        {
          width: 1440,
          height: 20000,
          media: "image/png",
          surface: "home",
          viewport: "desktop1440",
        },
      ];
      const shotIds: string[] = [];
      for (const [i, shot] of shots.entries()) {
        const bytes = Buffer.from(`screenshot ${i} ${b.projectId}`);
        const { rows } = await pg.query(
          `INSERT INTO theme_studio_assets(project_id,purpose,media_type,bytes,byte_size,width,height,sha256,original_media_type,original_byte_size,created_by)
           VALUES($1,'qa_screenshot',$2,$3,$4,$5,$6,$7,'image/jpeg',$4,$8) RETURNING id`,
          [
            b.projectId,
            shot.media,
            bytes,
            bytes.byteLength,
            shot.width,
            shot.height,
            hex(`shot-${i}-${b.projectId}`),
            operator,
          ],
        );
        shotIds.push(rows[0].id);
      }
      const states = (measured: string[]) =>
        ["menu", "search", "cart", "account", "sign_in"].map((state) => ({
          state,
          measured: measured.includes(state),
          violations: [],
          clippedText: [],
          smallTapTargets: [],
          contrastUnresolved: [],
        }));
      await pg.query(
        `INSERT INTO theme_studio_visual_qa_runs(id,project_id,version_id,package_digest,qa_iteration,status,browser_report,screenshot_asset_ids,vision_report,created_by,created_at,started_at,finished_at)
         VALUES($1,$2,$3,$4,0,'passed',$5,$6,$7,$8,${ago(99)},${ago(99)},${ago(98)})`,
        [
          randomUUID(),
          b.projectId,
          ready.versionId,
          ready.digest,
          JSON.stringify({
            acceptanceRunId: checkRunId,
            buildId: BUILD,
            evidence: {
              userAgent: "x",
              samples: [
                {
                  surface: "home",
                  viewport: "phone390",
                  states: states(["menu", "cart", "account"]),
                },
                { surface: "cart", viewport: "phone390" },
                {
                  surface: "home",
                  viewport: "desktop1440",
                  states: states(["search", "account", "sign_in"]),
                },
              ],
            },
          }),
          shotIds,
          JSON.stringify({
            severityRules: "severity-v1",
            reviewSeverity: {
              outcome: "taste",
              serious: [],
              warnings: [{ code: "palette_only" }],
            },
          }),
          operator,
        ],
      );
      await pg.query(
        "UPDATE theme_studio_projects SET status='candidate',revision=revision+1,updated_at=now() WHERE id=$1",
        [b.projectId],
      );
      // A theme picture of B and a screenshot of A: the bytes route serves neither.
      const { rows: picture } = await pg.query(
        `INSERT INTO theme_studio_assets(project_id,purpose,media_type,bytes,byte_size,width,height,sha256,original_media_type,original_byte_size,created_by)
         VALUES($1,'image','image/webp',$2,4,800,600,$3,'image/webp',4,$4) RETURNING id`,
        [
          b.projectId,
          Buffer.from("webp"),
          hex(`picture-${b.projectId}`),
          operator,
        ],
      );
      const { rows: foreignShot } = await pg.query(
        `INSERT INTO theme_studio_assets(project_id,purpose,media_type,bytes,byte_size,width,height,sha256,original_media_type,original_byte_size,created_by)
         VALUES($1,'qa_screenshot','image/webp',$2,4,390,800,$3,'image/jpeg',4,$4) RETURNING id`,
        [
          a.projectId,
          Buffer.from("webp"),
          hex(`foreign-${a.projectId}`),
          operator,
        ],
      );

      // ── C, D, E: removed, not started, asked questions ────────────────
      const c = await project("Removed", "archived", 50);
      const d = await project("Not started", "draft", 45);
      const e = await project("Asked", "blocked", 40);
      const eRun = randomUUID();
      await event(e.projectId, "run_queued", 40);
      await pg.query(
        `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,created_at,started_at,finished_at,outcome_detail,created_by)
         VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$4,'succeeded',${ago(40)},${ago(39)},${ago(38)},$5,$6)`,
        [
          eRun,
          e.projectId,
          e.messageId,
          `progress_gen_${eRun}`,
          JSON.stringify({
            kind: "clarify",
            questions: ["Which prices?", "Which homepage?"],
          }),
          operator,
        ],
      );

      // ── F: Make current of a design that never passed: its capture
      // carries a re-check key, and both events share one timestamp.
      const f = await project("Made current", "generating", 20);
      const fRun = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,created_at,started_at,finished_at,created_by)
         VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$4,'succeeded',${ago(20)},${ago(20)},${ago(19)},$5)`,
        [fRun, f.projectId, f.messageId, `progress_gen_${fRun}`, operator],
      );
      const made = await version(
        f.projectId,
        fRun,
        1,
        placeholderPackage(),
        "operator",
        19,
      );
      await event(f.projectId, "version_restored", 5, { outcome: "checking" });
      await event(f.projectId, "capture_requested", 5, {
        recheck: "check_again",
      });
      await pg.query(
        `INSERT INTO theme_studio_captures(id,project_id,version_id,package_digest,status,previous_status,idempotency_key,automatic,phase,qa_iteration,created_at,created_by)
         VALUES($1,$2,$3,$4,'queued','generating',$5,true,'final',3,${ago(5)},$6)`,
        [
          randomUUID(),
          f.projectId,
          made.versionId,
          made.digest,
          `recheck_check_again_${randomUUID()}`,
          operator,
        ],
      );

      // ── G: a publish that did not finish; H: live, not offered ─────────
      /** A design and a check that ended without a verdict: enough for the
       * publication's own references. */
      async function published(name: string, status: string) {
        const made = await project(name, status, 15);
        const runId = randomUUID();
        await pg.query(
          `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,created_at,started_at,finished_at,created_by)
           VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$4,'succeeded',${ago(15)},${ago(15)},${ago(14)},$5)`,
          [
            runId,
            made.projectId,
            made.messageId,
            `progress_gen_${runId}`,
            operator,
          ],
        );
        const design = await version(
          made.projectId,
          runId,
          1,
          placeholderPackage(),
          "operator",
          14,
        );
        const checkId = randomUUID();
        await pg.query(
          `INSERT INTO theme_studio_acceptance_runs(id,project_id,version_id,package_digest,assets_digest,build_id,status,server_report,browser_report,created_by,created_by_email,completed_at)
           VALUES($1,$2,$3,$4,$5,$6,'error','{}','{}',$7,$8,now())`,
          [
            checkId,
            made.projectId,
            design.versionId,
            design.digest,
            "f".repeat(64),
            BUILD,
            operator,
            email,
          ],
        );
        return { ...made, design, checkId };
      }
      const g = await published("Publish stopped", "approved");
      await pg.query(
        `INSERT INTO theme_studio_publications(project_id,version_id,acceptance_run_id,theme_id,release_version,status,failure,created_by,created_by_email,created_at,updated_at,completed_at)
         VALUES($1,$2,$3,$4,'1.0.0','failed',$5,$6,$7,${ago(9)},${ago(8)},${ago(8)})`,
        [
          g.projectId,
          g.design.versionId,
          g.checkId,
          g.themeId,
          JSON.stringify([
            "The demo store's home page did not load.",
            "Second.",
          ]),
          operator,
          email,
        ],
      );
      const h = await published("Live", "published");
      const releaseId = randomUUID();
      await pg.query(
        `INSERT INTO theme_releases(id,theme_id,version,release_status,package_json,manifest_digest,source,created_by)
         VALUES($1,$2,'1.2.0','published','{}',$3,'theme-studio',$4)`,
        [releaseId, h.themeId, "c".repeat(64), operator],
      );
      await pg.query(
        "INSERT INTO theme_catalog_entries(theme_id,current_release_id,visibility,updated_by) VALUES($1,$2,'hidden',$3)",
        [h.themeId, releaseId, operator],
      );
      await pg.query(
        `INSERT INTO theme_studio_publications(project_id,version_id,acceptance_run_id,theme_id,release_version,release_id,manifest_digest,status,created_by,created_by_email,created_at,updated_at,completed_at)
         VALUES($1,$2,$3,$4,'1.2.0',$5,$6,'published',$7,$8,${ago(7)},${ago(6)},${ago(6)})`,
        [
          h.projectId,
          h.design.versionId,
          h.checkId,
          h.themeId,
          releaseId,
          "c".repeat(64),
          operator,
          email,
        ],
      );

      // Every read below as the app's own role, recording the SQL it sends.
      await pg.query("SET LOCAL ROLE app_service");
      const query = pg.query.bind(pg) as (...args: unknown[]) => unknown;
      (pg as unknown as { query: (...args: unknown[]) => unknown }).query = (
        ...args: unknown[]
      ) => {
        const first = args[0] as string | { text?: string };
        statements.push(
          typeof first === "string" ? first : (first?.text ?? ""),
        );
        return query(...args);
      };

      // A: the progress card of a build drawing its pictures.
      const building = (await readThemeStudioProgress(db as never, {
        projectId: a.projectId,
      }))!;
      expect(building.currentVersionId).toBeNull();
      expect(building.versionIds).toEqual([]);
      expect(
        building.steps.map((s) => [s.key, s.state, s.label, s.detail]),
      ).toEqual([
        ["brief", "done", "Read the brief", null],
        ["design", "done", "Designed the pages", null],
        ["layout_check", "done", "Layout check", null],
        ["pictures", "running", "Drawing pictures", "2 of 5"],
        ["final_check", "waiting", "Catalogue pictures and final checks", null],
        ["design_review", "waiting", "Design review", null],
      ]);
      const briefStep = building.steps[0];
      expect(
        Date.parse(briefStep.finishedAt!) - Date.parse(briefStep.startedAt!),
      ).toBe(50_000);
      expect(building.status.working).toMatchObject({
        kind: "building",
        step: "Drawing pictures",
      });
      // The newest picture drawn is the newest progress.
      expect(
        Date.now() - Date.parse(building.status.working!.lastProgressAt),
      ).toBeLessThan(3 * 60_000);
      expect(building.status.evidence).toBeNull();
      expect(studioStatus(building.status)).toMatchObject({ row: 5 });
      expect(studioStatus(building.status).words).toMatch(
        /^Building: drawing pictures \(3\d min\)$/,
      );

      // B: Ready to publish, the page and the list saying the same.
      const readyProgress = (await readThemeStudioProgress(db as never, {
        projectId: b.projectId,
      }))!;
      expect(readyProgress.versionIds).toEqual([ready.versionId]);
      expect(readyProgress.status.evidence).toEqual({
        ok: true,
        acceptanceRunId: checkRunId,
      });
      expect(readyProgress.status.checks).toMatchObject({
        checkRun: { id: checkRunId, state: "passed", todaysBuild: true },
        review: { outcome: "taste", boundToCheckRun: true },
        serious: 0,
        warnings: 2,
      });
      expect(studioStatus(readyProgress.status)).toMatchObject({
        row: 15,
        words: "Ready to publish, 2 warnings",
      });

      const list = await listThemeStudioProjectsForConsole(db as never, {
        filter: "all",
      });
      const rowOf = (projectId: string) =>
        list.rows.find((r) => r.projectId === projectId)!;
      expect(studioStatus(rowOf(b.projectId).status)).toMatchObject({
        row: 15,
        words: "Ready to publish, 2 warnings",
      });
      expect(studioListFilter(studioStatus(rowOf(a.projectId).status))).toBe(
        "building",
      );
      expect(rowOf(a.projectId).activeStep).toMatchObject({
        key: "pictures",
        detail: "2 of 5",
      });
      expect(studioStatus(rowOf(c.projectId).status).row).toBe(4);
      expect(studioStatus(rowOf(d.projectId).status).row).toBe(18);
      expect(studioStatus(rowOf(e.projectId).status)).toMatchObject({
        row: 7,
        words: "Needs your answer",
      });
      expect(rowOf(e.projectId).status.questions).toMatchObject({
        open: true,
        count: 2,
      });
      // A publish that did not finish, with its first reason; a live theme
      // that is no longer offered to new stores.
      expect(rowOf(g.projectId).status.publishAttempt).toMatchObject({
        state: "failed",
        reasons: ["The demo store's home page did not load.", "Second."],
      });
      expect(studioStatus(rowOf(g.projectId).status)).toMatchObject({
        row: 3,
        words: "Publish didn't finish: the demo store's home page did not load",
      });
      expect(rowOf(h.projectId).status.release).toMatchObject({
        version: "1.2.0",
        offered: false,
      });
      expect(studioStatus(rowOf(h.projectId).status)).toMatchObject({
        row: 1,
        words: "Not offered to new stores",
      });
      // The operator's own action names the work over the capture it queued.
      expect(rowOf(f.projectId).status.working?.kind).toBe("checking_change");
      expect(studioStatus(rowOf(f.projectId).status).words).toBe(
        "Checking your change",
      );
      // Every project is in "all" and exactly one other filter.
      const { all, ...filters } = list.counts;
      expect(Object.values(filters).reduce((sum, n) => sum + n, 0)).toBe(all);
      const archived = await listThemeStudioProjectsForConsole(db as never, {
        filter: "archived",
      });
      expect(archived.rows.map((r) => r.projectId)).toContain(c.projectId);
      expect(archived.rows.map((r) => r.projectId)).not.toContain(b.projectId);
      expect(archived.counts).toEqual(list.counts);

      // B: what the checks saw, paired with the pages and widths they show.
      const seen = (await listThemeStudioCheckScreenshots(db as never, {
        projectId: b.projectId,
        versionId: null,
      }))!;
      expect(seen).toMatchObject({
        versionId: ready.versionId,
        checkRunId,
        build: BUILD,
        coverage: {
          pages: ["home", "cart"],
          widths: [390, 1440],
          panels: ["menu", "search", "cart", "account", "sign_in"],
          cartWasEmpty: true,
        },
      });
      expect(seen.samples).toEqual(
        shots.map((shot, i) => ({
          assetId: shotIds[i],
          page: shot.surface,
          viewport: shot.viewport,
          width: shot.width,
          height: shot.height,
        })),
      );
      expect(
        await listThemeStudioCheckScreenshots(db as never, {
          projectId: b.projectId,
          versionId: hidden.versionId,
        }),
      ).toBeNull();
      expect(
        await listThemeStudioCheckScreenshots(db as never, {
          projectId: a.projectId,
          versionId: null,
        }),
      ).toMatchObject({ versionId: null, samples: [] });

      // The bytes: a check screenshot of that project only.
      const png = await readThemeStudioCheckScreenshot(db as never, {
        projectId: b.projectId,
        assetId: shotIds[2],
      });
      expect(png?.contentType).toBe("image/png");
      expect(png?.bytes.toString()).toBe(`screenshot 2 ${b.projectId}`);
      expect(
        await readThemeStudioCheckScreenshot(db as never, {
          projectId: b.projectId,
          assetId: picture[0].id,
        }),
      ).toBeNull();
      expect(
        await readThemeStudioCheckScreenshot(db as never, {
          projectId: b.projectId,
          assetId: foreignShot[0].id,
        }),
      ).toBeNull();
      expect(
        await readThemeStudioCheckScreenshot(db as never, {
          projectId: a.projectId,
          assetId: shotIds[0],
        }),
      ).toBeNull();

      // No read but the one screenshot ever selected a bytes column.
      const bytesReads = statements.filter((s) => /\bbytes\b/.test(s));
      expect(
        bytesReads.every(
          (s) =>
            s.includes("a.purpose = 'qa_screenshot'") &&
            s.includes("a.id = $1::uuid"),
        ),
      ).toBe(true);
      expect(bytesReads.length).toBe(4);
      expect(statements.some((s) => /\bimage_bytes\b/.test(s))).toBe(false);

      // The build time: the default until 10 real builds finished, then the
      // shortest and longest of the newest 10, rounded outward to 5.
      await pg.query("RESET ROLE");
      const before = await readThemeStudioBuildTimeRange(db as never);
      const measured = before.source === "default";
      for (const [i, minutes] of [
        33, 38, 41, 47, 52, 55, 58, 61, 64, 71, 12,
      ].entries()) {
        const built = await project(`Timed ${i}`, "candidate", 400 + i);
        const runId = randomUUID();
        const provider = i === 10 ? "fake" : "vertex-gemini";
        await pg.query(
          `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,created_at,finished_at,created_by)
           VALUES($1,$2,$3,'generate',$4,'gemini-3.8-flash','x','x',$5,'succeeded',${ago(200 + minutes)},${ago(200)},$6)`,
          [
            runId,
            built.projectId,
            built.messageId,
            provider,
            `progress_time_${runId}`,
            operator,
          ],
        );
        await event(
          built.projectId,
          "auto_qa_passed",
          200 - i * 0.01,
          {},
          null,
          false,
        );
      }
      const range = await readThemeStudioBuildTimeRange(db as never);
      if (measured)
        expect(range).toEqual({
          fromMinutes: 30,
          toMinutes: 75,
          basedOn: 10,
          source: "measured",
        });
      else expect(range.source).toBe("measured");
    } finally {
      (pg as unknown as { query: unknown }).query = Client.prototype.query;
      await pg.query("ROLLBACK").catch(() => {});
      await pg.end();
      vi.unstubAllEnvs();
    }
  },
  60_000,
);
