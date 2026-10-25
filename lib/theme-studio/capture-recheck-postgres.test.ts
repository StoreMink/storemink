// Opt-in local PostgreSQL integration (TS-1E): the capture half of the
// re-check contract, Stop, stale captures and the preview eviction guard,
// against the real triggers (0143, 0144, 0151) and the live capture CHECK.
// Everything runs in one transaction that is rolled back. The preview store
// is stubbed for captures; no network, browser or model provider calls.
// Run THEME_STUDIO_RECOVERY_DB_TEST=1 with Vitest.
import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import sharp from "sharp";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import { THEME_STUDIO_QA_VIEWPORTS } from "./acceptance-gates";
import { operatorImagePackage } from "./_test-helpers";

const { service, openPreview, logWarn } = vi.hoisted(() => ({
  service: vi.fn(),
  openPreview: vi.fn(),
  logWarn: vi.fn(),
}));
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
// TS-3A: a stop tells its operator once the settlement commits (builder
// 3B's notify.ts); here no notification or email worker runs.
vi.mock("./notify", () => ({ sendThemeStudioNotice: vi.fn(async () => {}) }));
vi.mock("./preview", async (original) => ({
  ...(await original<typeof import("./preview")>()),
  openThemeStudioPreview: openPreview,
}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/observability/logger", async (original) => ({
  ...(await original<typeof import("@/lib/observability/logger")>()),
  logWarn,
}));

import {
  claimThemeStudioCapture,
  finishThemeStudioCapture,
  queueThemeStudioCapture,
  queueThemeStudioRecheck,
  sweepStaleThemeStudioCaptures,
  type ClaimedCapture,
} from "./capture";
import { captureShots, recheckReasonOf } from "./capture-core";
import { previewPagesFor, sweepThemeStudioPreviews } from "./preview";
import { stopThemeStudioChecks } from "./stop";
import {
  archiveThemeStudioProject,
  digestThemeStudioJson,
  listThemeStudioProjects,
  restoreThemeStudioVersion,
} from "./repository";
import { deleteThemeStudioProject } from "./deletion";
import type { ThemePackageV2 } from "./contracts";

it.skipIf(process.env.THEME_STUDIO_RECOVERY_DB_TEST !== "1")(
  "re-checks in place without writing the version, stops stuck work, fails captures nobody took and never evicts a measured preview",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "local-recheck-regression-only");
    vi.stubEnv("THEME_STUDIO_BUILD_ID", "recheck-build-1");
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
      // Isolate the local queues and previews inside this transaction.
      await pg.query(
        "UPDATE theme_studio_runs SET retry_not_before=now()+interval '1 hour' WHERE status='queued'",
      );
      await pg.query(
        "UPDATE theme_studio_captures SET status='failed',error_code='test_isolation',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE status IN ('queued','running')",
      );
      await pg.query(
        "UPDATE theme_studio_visual_qa_runs SET status='failed',error_code='test_isolation',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE status IN ('queued','running')",
      );
      await pg.query(
        "UPDATE theme_studio_previews SET expires_at=now()+interval '1 day'",
      );
      const operator = randomUUID();
      const email = `${operator}@recheck.test`;
      await pg.query(
        "INSERT INTO platform_admins(id,email,role) VALUES($1,$2,'superadmin')",
        [operator, email],
      );
      const actor = { id: operator, email };
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

      const pkg = operatorImagePackage();
      const digest = digestThemeStudioJson(pkg);
      const pages = previewPagesFor(pkg);
      openPreview.mockImplementation(async () => ({
        previewId: randomUUID(),
        storeId: randomUUID(),
        origin: "https://preview.example.test",
        enterToken: "unused",
        pages,
        expiresAt: "2099-01-01 00:00:00+00",
      }));
      const one = async <T>(sql: string, args: unknown[] = []) =>
        (await pg.query(sql, args)).rows[0] as T;
      const revisionOf = async (projectId: string) =>
        (
          await one<{ revision: number }>(
            "SELECT revision FROM theme_studio_projects WHERE id=$1",
            [projectId],
          )
        ).revision;

      /** A project with one generated version in the given QA state. */
      async function project(
        state: {
          status?: string;
          visibility?: string;
          qaStatus?: string;
          candidate?: boolean;
        } = {},
      ) {
        const projectId = randomUUID(),
          messageId = randomUUID(),
          runId = randomUUID(),
          versionId = randomUUID();
        await pg.query(
          `INSERT INTO theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by,created_by_email)
           VALUES($1,$2,'Recheck test',$3,'{home}','{small}','gemini-3.8-flash','A calm ceramics shop',$4,$5)`,
          [
            projectId,
            `recheck-${projectId}`,
            state.status ?? "ready",
            operator,
            email,
          ],
        );
        await pg.query(
          "INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by) VALUES($1,$2,'brief','A calm ceramics shop',$3)",
          [messageId, projectId, operator],
        );
        await pg.query(
          `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,finished_at,created_by)
           VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$4,'succeeded',now(),$5)`,
          [runId, projectId, messageId, `recheck_fixture_${runId}`, operator],
        );
        await pg.query(
          `INSERT INTO theme_studio_versions(id,project_id,run_id,version_number,intent_json,intent_digest,package_json,package_digest,visibility,qa_status)
           VALUES($1,$2,$3,1,'{}',$4,$5,$6,$7,$8)`,
          [
            versionId,
            projectId,
            runId,
            "a".repeat(64),
            JSON.stringify(pkg),
            digest,
            state.visibility ?? "operator",
            state.qaStatus ?? "passed",
          ],
        );
        if (state.visibility !== "internal") {
          await pg.query(
            "UPDATE theme_studio_projects SET current_version_id=$2 WHERE id=$1",
            [projectId, versionId],
          );
        }
        if (state.candidate) {
          await pg.query(
            `INSERT INTO theme_studio_acceptance_runs(project_id,version_id,package_digest,assets_digest,build_id,status,evidence_digest,created_by,created_by_email,completed_at)
             VALUES($1,$2,$3,$4,'old-build','passed',$5,$6,$7,now())`,
            [
              projectId,
              versionId,
              digest,
              "b".repeat(64),
              "c".repeat(64),
              operator,
              email,
            ],
          );
          await pg.query(
            "UPDATE theme_studio_projects SET status='candidate' WHERE id=$1",
            [projectId],
          );
        }
        return { projectId, versionId, themeId: `recheck-${projectId}` };
      }

      const versionRow = (versionId: string) =>
        one<Record<string, unknown>>(
          "SELECT * FROM theme_studio_versions WHERE id=$1",
          [versionId],
        );
      const versionCount = async (projectId: string) =>
        (
          await one<{ n: number }>(
            "SELECT count(*)::int AS n FROM theme_studio_versions WHERE project_id=$1",
            [projectId],
          )
        ).n;

      /** The capture job's answer: every page at every width, a picture per
       * sample, the HTML it read, and a picture per catalogue shot asked. */
      async function answer(claim: ClaimedCapture) {
        const samples = Object.entries(THEME_STUDIO_QA_VIEWPORTS).flatMap(
          ([viewport, size]) =>
            pages.map((page) => ({
              viewport,
              surface: page.surface,
              path: page.path,
              ...size,
              overflowPx: 0,
              overflowOffenders: [],
              clippedText: [],
              smallTapTargets: [],
              imageCropIssues: [],
              brokenImages: 0,
              lcpMs: 900,
              cls: 0.01,
              violations: [],
            })),
        );
        const screenshots = await Promise.all(
          samples.map(async (sample, index) => ({
            key: `${sample.viewport}:${sample.surface}`,
            viewport: sample.viewport,
            surface: sample.surface,
            path: sample.path,
            bytes: new Uint8Array(
              await sharp({
                create: {
                  width: 48,
                  height: 96,
                  channels: 3,
                  background: { r: index * 7, g: 120, b: 255 - index * 7 },
                },
              })
                .png()
                .toBuffer(),
            ),
          })),
        );
        const images = await Promise.all(
          claim.shots.map(async (shot) => ({
            slotId: shot.slotId,
            bytes: new Uint8Array(
              await sharp({
                create: {
                  width: shot.viewport.width * shot.deviceScaleFactor,
                  height: shot.viewport.height * shot.deviceScaleFactor,
                  channels: 3,
                  background: { r: 30, g: 90, b: 60 },
                },
              })
                .png()
                .toBuffer(),
            ),
          })),
        );
        return finishThemeStudioCapture({
          captureId: claim.captureId,
          leaseToken: claim.leaseToken,
          images,
          qa: {
            buildId: claim.qa!.buildId,
            packageDigest: claim.qa!.packageDigest,
            // Read in the same claim, so the finish fetches nothing.
            routes: pages.map((page) => ({
              path: page.path,
              surface: page.surface,
              status: page.surface === "not_found" ? 404 : 200,
              html: '<html lang="en"><head><meta name="robots" content="noindex"></head><body>Theme</body></html>',
              robots: "noindex",
            })),
            evidence: { userAgent: "local integration", samples },
            screenshots,
          },
        });
      }

      // ── A. A candidate re-checked in place, then a deploy re-capture ────
      const a = await project({ candidate: true });
      const before = await versionRow(a.versionId);
      const queued = await queueThemeStudioRecheck(actor, {
        projectId: a.projectId,
        versionId: a.versionId,
        expectedRevision: await revisionOf(a.projectId),
        reason: "publish_recheck",
      });
      expect(queued.inPlace).toBe(true);
      expect(
        await one("SELECT status FROM theme_studio_projects WHERE id=$1", [
          a.projectId,
        ]),
      ).toEqual({ status: "generating" });
      const recheckRow = await one<Record<string, unknown>>(
        "SELECT * FROM theme_studio_captures WHERE id=$1",
        [queued.captureId],
      );
      expect(recheckRow).toMatchObject({
        status: "queued",
        phase: "final",
        automatic: true,
        previous_status: "generating",
        qa_iteration: 3,
        max_attempts: 5,
        version_id: a.versionId,
        package_digest: digest,
      });
      expect(recheckReasonOf(recheckRow.idempotency_key as string)).toBe(
        "publish_recheck",
      );
      // A second press cannot queue a second capture.
      await expect(
        queueThemeStudioRecheck(actor, {
          projectId: a.projectId,
          versionId: a.versionId,
          expectedRevision: (await revisionOf(a.projectId)) - 1,
          reason: "publish_recheck",
        }),
      ).rejects.toMatchObject({ code: "stale" });
      await expect(
        queueThemeStudioRecheck(actor, {
          projectId: a.projectId,
          versionId: a.versionId,
          expectedRevision: await revisionOf(a.projectId),
          reason: "check_again",
        }),
      ).rejects.toMatchObject({ code: "illegal_state" });

      const claimA = await claimThemeStudioCapture();
      expect(claimA?.captureId).toBe(queued.captureId);
      expect(claimA?.shots).toEqual([]);
      expect(claimA?.qa).toMatchObject({
        phase: "final",
        buildId: "recheck-build-1",
        packageDigest: digest,
      });
      // An automatic capture leaves its design review queued: the job
      // wakes the review route for it (TS-3A).
      expect(await answer(claimA!)).toEqual({
        status: "succeeded",
        versionId: a.versionId,
        designReview: "waiting",
      });
      expect(await versionCount(a.projectId)).toBe(1);
      expect(await versionRow(a.versionId)).toEqual(before);
      const runA = await one<{ id: string; build_id: string }>(
        "SELECT id,build_id FROM theme_studio_acceptance_runs WHERE version_id=$1 AND build_id=$2",
        [a.versionId, "recheck-build-1"],
      );
      expect(runA).toBeDefined();
      const reviewA = await one<Record<string, unknown>>(
        "SELECT id,status,qa_iteration,version_id,browser_report->>'acceptanceRunId' AS bound,browser_report->>'buildId' AS build FROM theme_studio_visual_qa_runs WHERE project_id=$1",
        [a.projectId],
      );
      // A design review bound to the exact check run, at the repair ceiling.
      expect(reviewA).toMatchObject({
        status: "queued",
        qa_iteration: 3,
        version_id: a.versionId,
        bound: runA.id,
        build: "recheck-build-1",
      });

      // A deploy while the review waits: visual QA re-captures the same
      // version (its `auto_recapture_` key), and the settle measures in place.
      await pg.query(
        "UPDATE theme_studio_visual_qa_runs SET status='failed',error_code='acceptance_build_changed',finished_at=now() WHERE id=$1",
        [reviewA.id],
      );
      await pg.query(
        `INSERT INTO theme_studio_captures(project_id,version_id,package_digest,previous_status,automatic,phase,qa_iteration,max_attempts,idempotency_key,created_by)
         VALUES($1,$2,$3,'generating',true,'final',3,5,$4,$5)`,
        [
          a.projectId,
          a.versionId,
          digest,
          `auto_recapture_${reviewA.id}`,
          operator,
        ],
      );
      vi.stubEnv("THEME_STUDIO_BUILD_ID", "recheck-build-2");
      const claimDeploy = await claimThemeStudioCapture();
      expect(claimDeploy?.shots).toEqual([]);
      expect(await answer(claimDeploy!)).toEqual({
        status: "succeeded",
        versionId: a.versionId,
        designReview: "waiting",
      });
      expect(await versionCount(a.projectId)).toBe(1);
      expect(await versionRow(a.versionId)).toEqual(before);

      // While it works, Archive and Make current point at Stop, the way out.
      await expect(
        archiveThemeStudioProject(actor, {
          projectId: a.projectId,
          expectedRevision: await revisionOf(a.projectId),
        }),
      ).rejects.toThrow(/press Stop at the top of the page/);
      await expect(
        restoreThemeStudioVersion(actor, {
          projectId: a.projectId,
          versionId: a.versionId,
          expectedRevision: await revisionOf(a.projectId),
        }),
      ).rejects.toThrow(/press Stop at the top of the page/);
      // Stop ends the review the re-capture queued; the version stays as it was.
      expect(
        await stopThemeStudioChecks(actor, {
          projectId: a.projectId,
          expectedRevision: await revisionOf(a.projectId),
        }),
      ).toEqual({
        status: "ready",
        stopped: { captures: 0, reviews: 1, runs: 0, browserChecks: 0 },
        cancelling: false,
      });
      expect(
        await one(
          "SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS active, count(*) FILTER (WHERE error_code='cancelled')::int AS stopped FROM theme_studio_visual_qa_runs WHERE project_id=$1",
          [a.projectId],
        ),
      ).toEqual({ active: 0, stopped: 1 });
      expect(
        await one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [a.projectId],
        ),
      ).toEqual({ status: "ready", current_version_id: a.versionId });
      expect(await versionRow(a.versionId)).toEqual(before);
      // And Archive works after Stop.
      await archiveThemeStudioProject(actor, {
        projectId: a.projectId,
        expectedRevision: await revisionOf(a.projectId),
      });
      expect(
        await one("SELECT status FROM theme_studio_projects WHERE id=$1", [
          a.projectId,
        ]),
      ).toEqual({ status: "archived" });

      // ── B. A version that never passed, then Retry automatic QA ─────────
      vi.stubEnv("THEME_STUDIO_BUILD_ID", "recheck-build-1");
      const b = await project({ qaStatus: "failed" });
      const recheckB = await queueThemeStudioRecheck(actor, {
        projectId: b.projectId,
        versionId: b.versionId,
        expectedRevision: await revisionOf(b.projectId),
        reason: "check_again",
      });
      expect(recheckB.inPlace).toBe(false);
      const claimB = await claimThemeStudioCapture();
      expect(claimB?.shots.map((shot) => shot.slotId)).toEqual(
        captureShots(pkg as ThemePackageV2).map((shot) => shot.slotId),
      );
      const settledB = await answer(claimB!);
      expect(settledB.status).toBe("succeeded");
      const hiddenB = (settledB as { versionId: string }).versionId;
      expect(hiddenB).not.toBe(b.versionId);
      expect(await versionRow(hiddenB)).toMatchObject({
        origin: "asset_edit",
        parent_version_id: b.versionId,
        visibility: "internal",
        qa_status: "pending",
        qa_iteration: 3,
        edit_detail: expect.objectContaining({ kind: "capture" }),
      });
      expect(
        await one(
          "SELECT version_id,qa_iteration,status FROM theme_studio_visual_qa_runs WHERE project_id=$1",
          [b.projectId],
        ),
      ).toEqual({ version_id: hiddenB, qa_iteration: 3, status: "queued" });
      // Stop reveals the hidden version it was checking, as a failed result.
      expect(
        await stopThemeStudioChecks(actor, {
          projectId: b.projectId,
          expectedRevision: await revisionOf(b.projectId),
        }),
      ).toMatchObject({ status: "ready", stopped: { reviews: 1 } });
      expect(await versionRow(hiddenB)).toMatchObject({
        visibility: "operator",
        qa_status: "failed",
      });
      expect(
        await one(
          "SELECT current_version_id FROM theme_studio_projects WHERE id=$1",
          [b.projectId],
        ),
      ).toEqual({ current_version_id: hiddenB });

      // Retry automatic QA on that failed version: an operator's key, its
      // repair rounds kept, and never in place.
      const retry = await queueThemeStudioCapture(actor, {
        projectId: b.projectId,
        versionId: hiddenB,
        expectedRevision: await revisionOf(b.projectId),
        expectedPackageDigest: (await versionRow(hiddenB))
          .package_digest as string,
        idempotencyKey: `retry-${randomUUID()}`,
      });
      expect(
        await one(
          "SELECT automatic,qa_iteration,previous_status FROM theme_studio_captures WHERE id=$1",
          [retry.captureId],
        ),
      ).toEqual({
        automatic: true,
        qa_iteration: 0,
        previous_status: "generating",
      });
      const claimRetry = await claimThemeStudioCapture();
      expect(claimRetry?.captureId).toBe(retry.captureId);
      expect(claimRetry?.shots.length).toBeGreaterThan(0);
      // Stop while the job is photographing: the lease is fenced, so its
      // answer is refused and no version is made.
      const versionsBeforeStop = await versionCount(b.projectId);
      expect(
        await stopThemeStudioChecks(actor, {
          projectId: b.projectId,
          expectedRevision: await revisionOf(b.projectId),
        }),
      ).toMatchObject({ status: "ready", stopped: { captures: 1 } });
      expect(await answer(claimRetry!)).toEqual({ status: "lost" });
      expect(await versionCount(b.projectId)).toBe(versionsBeforeStop);
      // And Delete works after Stop.
      expect(
        await deleteThemeStudioProject(actor, {
          projectId: b.projectId,
          expectedRevision: await revisionOf(b.projectId),
          confirmation: b.themeId,
        }),
      ).toEqual({ themeId: b.themeId });
      expect(
        (
          await pg.query("SELECT 1 FROM theme_studio_projects WHERE id=$1", [
            b.projectId,
          ])
        ).rowCount,
      ).toBe(0);

      // ── C. Catalogue pictures with automatic checks on ───────────────────
      const c = await project({ candidate: true });
      const catalogue = await queueThemeStudioCapture(actor, {
        projectId: c.projectId,
        versionId: c.versionId,
        expectedRevision: await revisionOf(c.projectId),
        expectedPackageDigest: digest,
        idempotencyKey: `catalogue-${randomUUID()}`,
      });
      expect(
        await one(
          "SELECT automatic,qa_iteration,previous_status,phase FROM theme_studio_captures WHERE id=$1",
          [catalogue.captureId],
        ),
      ).toEqual({
        automatic: true,
        qa_iteration: 3,
        previous_status: "generating",
        phase: "final",
      });
      const claimC = await claimThemeStudioCapture();
      expect(claimC?.shots.length).toBeGreaterThan(0);
      const settledC = await answer(claimC!);
      const hiddenC = (settledC as { versionId: string }).versionId;
      expect(hiddenC).not.toBe(c.versionId);
      // No longer "Ready with no review": a hidden version under the checks.
      expect(await versionRow(hiddenC)).toMatchObject({
        visibility: "internal",
        qa_status: "pending",
      });
      expect(
        await one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [c.projectId],
        ),
      ).toEqual({ status: "generating", current_version_id: c.versionId });
      expect(
        await one(
          "SELECT version_id,status FROM theme_studio_visual_qa_runs WHERE project_id=$1",
          [c.projectId],
        ),
      ).toEqual({ version_id: hiddenC, status: "queued" });

      // ── D. A capture nobody took, and Stop on a queued one ──────────────
      const stuck = await project({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      const stuckCapture = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_captures(id,project_id,version_id,package_digest,previous_status,automatic,phase,qa_iteration,max_attempts,idempotency_key,created_by,created_at,updated_at)
         VALUES($1,$2,$3,$4,'generating',true,'final',0,5,$5,$6,now()-interval '20 minutes',now()-interval '20 minutes')`,
        [
          stuckCapture,
          stuck.projectId,
          stuck.versionId,
          digest,
          `auto_final_${stuckCapture}`,
          operator,
        ],
      );
      const fresh = await project({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      const freshCapture = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_captures(id,project_id,version_id,package_digest,previous_status,automatic,phase,qa_iteration,max_attempts,idempotency_key,created_by)
         VALUES($1,$2,$3,$4,'generating',true,'final',0,5,$5,$6)`,
        [
          freshCapture,
          fresh.projectId,
          fresh.versionId,
          digest,
          `auto_final_${freshCapture}`,
          operator,
        ],
      );
      expect(await sweepStaleThemeStudioCaptures()).toEqual({ failed: 1 });
      expect(
        await one(
          "SELECT status,error_code FROM theme_studio_captures WHERE id=$1",
          [stuckCapture],
        ),
      ).toEqual({ status: "failed", error_code: "capture_not_started" });
      expect(
        await one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [stuck.projectId],
        ),
      ).toEqual({ status: "ready", current_version_id: stuck.versionId });
      expect(await versionRow(stuck.versionId)).toMatchObject({
        visibility: "operator",
        qa_status: "failed",
      });
      expect(logWarn).toHaveBeenCalledWith(
        "theme_studio.capture_stale",
        expect.objectContaining({ captureId: stuckCapture, status: "queued" }),
      );
      expect(
        await one("SELECT status FROM theme_studio_captures WHERE id=$1", [
          freshCapture,
        ]),
      ).toEqual({ status: "queued" });
      // The fresh one is stopped by hand instead; then Delete works.
      expect(
        await stopThemeStudioChecks(actor, {
          projectId: fresh.projectId,
          expectedRevision: await revisionOf(fresh.projectId),
        }),
      ).toMatchObject({ status: "ready", stopped: { captures: 1 } });
      expect(
        await one(
          "SELECT status,error_code FROM theme_studio_captures WHERE id=$1",
          [freshCapture],
        ),
      ).toEqual({ status: "failed", error_code: "cancelled" });
      expect(
        await one(
          "SELECT current_version_id FROM theme_studio_projects WHERE id=$1",
          [fresh.projectId],
        ),
      ).toEqual({ current_version_id: fresh.versionId });
      expect(
        await deleteThemeStudioProject(actor, {
          projectId: fresh.projectId,
          expectedRevision: await revisionOf(fresh.projectId),
          confirmation: fresh.themeId,
        }),
      ).toEqual({ themeId: fresh.themeId });

      // ── E. The retention sweep never removes a store a capture measures ──
      const e = await project({ status: "generating" });
      const otherVersion = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_versions(id,project_id,origin,parent_version_id,version_number,intent_json,intent_digest,package_json,package_digest,edit_detail)
         VALUES($1,$2,'asset_edit',$3,2,'{}',$4,$5,$6,'{"slots":["slot-1"]}')`,
        [
          otherVersion,
          e.projectId,
          e.versionId,
          "a".repeat(64),
          JSON.stringify(pkg),
          digest,
        ],
      );
      await pg.query(
        `INSERT INTO theme_studio_captures(project_id,version_id,package_digest,previous_status,automatic,phase,qa_iteration,max_attempts,idempotency_key,created_by,status,lease_owner,lease_expires_at,attempt_count,started_at)
         VALUES($1,$2,$3,'generating',true,'final',0,5,$4,$5,'running',$6,now()+interval '5 minutes',1,now())`,
        [
          e.projectId,
          e.versionId,
          digest,
          `auto_final_${randomUUID()}`,
          operator,
          randomUUID(),
        ],
      );
      const previewFor = async (versionId: string) => {
        const storeId = randomUUID();
        await pg.query(
          `INSERT INTO stores(id,slug,name,status,plan,settings) VALUES($1,$2,'Preview','active','free',$3)`,
          [
            storeId,
            `studio-preview-${randomUUID().slice(0, 12)}`,
            JSON.stringify({
              demo: true,
              studioPreview: { projectId: e.projectId, versionId },
            }),
          ],
        );
        await pg.query(
          `INSERT INTO theme_studio_previews(project_id,version_id,store_id,status,created_at,updated_at,last_opened_at,expires_at)
           VALUES($1,$2,$3,'ready',now()-interval '2 days',now()-interval '2 days',now()-interval '2 days',now()-interval '1 day')`,
          [e.projectId, versionId, storeId],
        );
        return storeId;
      };
      const measuredStore = await previewFor(e.versionId);
      const idleStore = await previewFor(otherVersion);
      expect(await sweepThemeStudioPreviews(50)).toEqual({ removed: 1 });
      expect(
        (await pg.query("SELECT 1 FROM stores WHERE id=$1", [measuredStore]))
          .rowCount,
      ).toBe(1);
      expect(
        (await pg.query("SELECT 1 FROM stores WHERE id=$1", [idleStore]))
          .rowCount,
      ).toBe(0);

      // ── F. A theme left generating with nothing holding it ──────────────
      // A first build whose design review the queue had to close on its own
      // (visual-qa.ts settleOnItsOwn): its only version is still hidden. Stop
      // shows that version as a stopped check instead of failing the theme.
      const f = await project({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      expect(
        await stopThemeStudioChecks(actor, {
          projectId: f.projectId,
          expectedRevision: await revisionOf(f.projectId),
        }),
      ).toEqual({
        status: "ready",
        stopped: { captures: 0, reviews: 0, runs: 0, browserChecks: 0 },
        cancelling: false,
      });
      expect(
        await one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [f.projectId],
        ),
      ).toEqual({ status: "ready", current_version_id: f.versionId });
      expect(await versionRow(f.versionId)).toMatchObject({
        visibility: "operator",
        qa_status: "failed",
      });
      expect(
        await one(
          "SELECT detail FROM theme_studio_events WHERE project_id=$1 AND event_type='auto_qa_failed'",
          [f.projectId],
        ),
      ).toEqual({ detail: { versionId: f.versionId, errorCode: "cancelled" } });
      // An older hidden version is a leftover: it never replaces the newer
      // design the theme already shows.
      const g = await project({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      const shown = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_versions(id,project_id,origin,parent_version_id,version_number,intent_json,intent_digest,package_json,package_digest,edit_detail)
         VALUES($1,$2,'asset_edit',$3,2,'{}',$4,$5,$6,'{"slots":["slot-1"]}')`,
        [
          shown,
          g.projectId,
          g.versionId,
          "a".repeat(64),
          JSON.stringify(pkg),
          digest,
        ],
      );
      await pg.query(
        "UPDATE theme_studio_projects SET current_version_id=$2 WHERE id=$1",
        [g.projectId, shown],
      );
      expect(
        await stopThemeStudioChecks(actor, {
          projectId: g.projectId,
          expectedRevision: await revisionOf(g.projectId),
        }),
      ).toMatchObject({ status: "ready" });
      expect(
        await one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [g.projectId],
        ),
      ).toEqual({ status: "ready", current_version_id: shown });
      expect(await versionRow(g.versionId)).toMatchObject({
        visibility: "internal",
        qa_status: "pending",
      });

      // ── H. The list reads the newest checks, never the old mark ──────────
      const h = await project({ status: "ready" });
      const listed = async () =>
        (await listThemeStudioProjects()).find((p) => p.id === h.projectId)!;
      expect(await listed()).toMatchObject({
        currentQaStatus: "passed",
        currentChecksFailed: false,
      });
      const outcome = (type: string, minutesAgo: number) =>
        pg.query(
          `INSERT INTO theme_studio_events(project_id,actor_kind,event_type,detail,created_at)
           VALUES($1,'worker',$2,$3,now()-($4::int * interval '1 minute'))`,
          [
            h.projectId,
            type,
            JSON.stringify({
              versionId: h.versionId,
              errorCode: type === "auto_qa_failed" ? "checks_incomplete" : null,
            }),
            minutesAgo,
          ],
        );
      // Check again stopped it after it passed: the mark still says passed.
      await outcome("auto_qa_passed", 10);
      await outcome("auto_qa_failed", 5);
      expect(await listed()).toMatchObject({
        currentQaStatus: "passed",
        currentChecksFailed: true,
      });
      // And a newer pass clears it.
      await outcome("auto_qa_passed", 1);
      expect((await listed()).currentChecksFailed).toBe(false);
    } finally {
      await pg.query("ROLLBACK");
      await pg.end();
      vi.unstubAllEnvs();
    }
  },
  60_000,
);
