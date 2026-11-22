// Opt-in local PostgreSQL regression for Publish (Theme Studio TS-1C): the
// one-step publish with warnings, a failed demo and its resume, a stale tab,
// abandoned and live attempts, hide and show, and owner decision 4: Publish,
// and "Try again" on a publish that did not finish, measure the design again
// on today's build whenever the newest check is from an earlier build or has
// no design review bound to it, and never publish on old browser evidence.
// Real guards throughout (0134, 0143, 0144, 0151) and the real capture half
// of the re-check (capture.ts). Every write rolls back. Storage, the demo
// render and the preview store are stubbed; the design review's settle is
// written the way visual-qa.ts writes it (its own suite drives the real
// worker). No network, browser or model call.
// Run THEME_STUDIO_RECOVERY_DB_TEST=1 with Vitest.
import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import sharp from "sharp";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import { CHROME_STATES } from "./chrome-states";
import {
  acceptanceAssetsDigest,
  acceptanceEvidenceDigest,
  gate,
  GATE_LABELS,
  THEME_STUDIO_QA_VIEWPORTS,
  type GateFinding,
  type GateId,
  type GateResult,
} from "./acceptance-gates";
import { operatorImagePackage } from "./_test-helpers";
import { validateThemePackageV2, type ThemePackageV2 } from "./contracts";

const { service, openPreview, config } = vi.hoisted(() => ({
  service: vi.fn(),
  openPreview: vi.fn(),
  config: { autoQaEnabled: true },
}));
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./config", async (original) => ({
  ...(await original<typeof import("./config")>()),
  getThemeStudioConfig: () => ({
    provider: "fake",
    generationEnabled: true,
    captureEnabled: true,
    autoQaEnabled: config.autoQaEnabled,
    performanceRequired: false,
    dailySpendMicroUsd: null,
    disabledModels: new Set(),
  }),
}));
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
// gate() logs content-free platform lines for every fixture warning.
vi.mock("@/lib/observability/logger", async (original) => ({
  ...(await original<typeof import("@/lib/observability/logger")>()),
  logWarn: vi.fn(),
}));

import {
  assetRowsFor,
  currentPublishEvidence,
  submitThemeStudioBrowserEvidence,
} from "./acceptance";
import {
  claimThemeStudioCapture,
  finishThemeStudioCapture,
  type ClaimedCapture,
} from "./capture";
import { recheckReasonOf } from "./capture-core";
import { previewPagesFor } from "./preview";
import {
  changeThemeStudioCatalog,
  publishThemeStudioProject,
  type PublicationDeps,
} from "./publication";
import { restingStatusSql } from "./published-version";
import {
  digestThemeStudioJson,
  restoreThemeStudioVersion,
  reviseThemeStudioVersion,
} from "./repository";
import { themeStudioProjects } from "@/drizzle/schema";
import { eq, sql } from "drizzle-orm";

const ENABLED = process.env.THEME_STUDIO_RECOVERY_DB_TEST === "1";
const BUILD = "publish-build-today";
const OLD_BUILD = "publish-build-yesterday";

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** A package Publish can take: every slot a real stored WebP of its declared
 * size, the theme id the project's. */
async function publishablePackage(themeId: string) {
  const base = operatorImagePackage();
  const images = await Promise.all(
    base.assets.map(async (asset, i) => {
      const width = asset.width ?? 1600;
      const height = asset.height ?? 1200;
      const bytes = await sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: (i * 37) % 255, g: 90, b: 140 },
        },
      })
        .webp()
        .toBuffer();
      return { assetId: asset.id, bytes, width, height, sha: sha256(bytes) };
    }),
  );
  const shaFor = new Map(images.map((image) => [image.assetId, image.sha]));
  const pkg: ThemePackageV2 = {
    ...base,
    definition: {
      ...base.definition,
      id: themeId,
      demo: { ...base.definition.demo, slug: `demo-${themeId}` },
    },
    assets: base.assets.map((asset) => ({
      ...asset,
      sha256: shaFor.get(asset.id)!,
    })),
  };
  const parsed = validateThemePackageV2(pkg);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return { pkg: parsed.value, images };
}

const SMALL_TAP: GateFinding = {
  code: "small_target",
  message: "A 20x20 tap target.",
  where: "phone390 · home",
};

/** Every gate a passed automatic run stores; the tap-target gate holds one
 * warning, so the run passes with it (severity-v1). */
function passedGates(extra: Partial<Record<GateId, GateFinding[]>> = {}) {
  const findings: Partial<Record<GateId, GateFinding[]>> = {
    "browser.tap_targets": [SMALL_TAP],
    ...extra,
  };
  return (Object.keys(GATE_LABELS) as GateId[]).map((id) =>
    gate(id, findings[id] ?? [], { required: id !== "browser.performance" }),
  );
}

interface Seeded {
  projectId: string;
  versionId: string;
  themeId: string;
  pkg: ThemePackageV2;
  packageDigest: string;
  assetsDigest: string;
  runId: string;
  reviewId: string | null;
}

interface Ctx {
  pg: Client;
  actor: { id: string; email: string };
  one: <T = Record<string, unknown>>(
    sql: string,
    args?: unknown[],
  ) => Promise<T>;
  count: (sql: string, args?: unknown[]) => Promise<number>;
  revisionOf: (projectId: string) => Promise<number>;
  seed: (input: {
    build: string;
    review?: boolean;
    gates?: GateResult[];
    approved?: boolean;
  }) => Promise<Seeded>;
  insertRun: (
    seeded: Pick<
      Seeded,
      "projectId" | "versionId" | "packageDigest" | "assetsDigest"
    >,
    input: {
      build: string;
      minutesAgo: number;
      gates?: GateResult[];
      status?: "passed" | "failed";
    },
  ) => Promise<string>;
  /** A design-review row as visual-qa.ts leaves it, at a given age. */
  insertReview: (
    seeded: Pick<Seeded, "projectId" | "versionId" | "packageDigest">,
    input: {
      build: string;
      phase: "layout" | "final";
      status: "passed" | "failed";
      minutesFromNow: number;
      runId?: string;
    },
  ) => Promise<string>;
  /** The design review's settle, as visual-qa.ts writes it. */
  settleReview: (
    projectId: string,
    outcome: "passed" | "failed",
  ) => Promise<void>;
  /** The capture job's answer to a claim: every page at every width, clean. */
  answer: (claim: ClaimedCapture, pkg: ThemePackageV2) => Promise<unknown>;
}

/**
 * One rolled-back transaction per test. The code under test runs as
 * app_service inside a savepoint per `withService` call, so a statement the
 * database refuses rolls back only that call, as a real transaction would.
 */
async function withRollback(work: (ctx: Ctx) => Promise<void>) {
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "local-publish-regression-only");
  vi.stubEnv("THEME_STUDIO_BUILD_ID", BUILD);
  config.autoQaEnabled = true;
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
    const actor = { id: randomUUID(), email: `${randomUUID()}@publish.test` };
    await pg.query(
      "INSERT INTO platform_admins(id,email,role) VALUES($1,$2,'superadmin')",
      [actor.id, actor.email],
    );
    const db = drizzle(pg);
    let serial: Promise<unknown> = Promise.resolve();
    let calls = 0;
    service.mockImplementation((fn: (db: unknown) => Promise<unknown>) => {
      const result = serial.then(async () => {
        const savepoint = `service_call_${++calls}`;
        await pg.query(`SAVEPOINT ${savepoint}`);
        await pg.query("SET LOCAL ROLE app_service");
        try {
          const value = await fn(db);
          await pg.query("RESET ROLE");
          await pg.query(`RELEASE SAVEPOINT ${savepoint}`);
          return value;
        } catch (error) {
          await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await pg.query("RESET ROLE");
          throw error;
        }
      });
      serial = result.catch(() => {});
      return result;
    });

    const one = async <T = Record<string, unknown>>(
      sql: string,
      args: unknown[] = [],
    ) => (await pg.query(sql, args)).rows[0] as T;
    const count = async (sql: string, args: unknown[] = []) =>
      Number((await pg.query(sql, args)).rows[0].n);
    const revisionOf = async (projectId: string) =>
      (
        await one<{ revision: number }>(
          "SELECT revision FROM theme_studio_projects WHERE id=$1",
          [projectId],
        )
      ).revision;

    const insertRun: Ctx["insertRun"] = async (seeded, input) => {
      const runId = randomUUID();
      const gates = input.gates ?? passedGates();
      const server = gates.filter((g) => !g.id.startsWith("browser."));
      const browser = gates.filter((g) => g.id.startsWith("browser."));
      const evidenceDigest = acceptanceEvidenceDigest(
        {
          runId,
          versionId: seeded.versionId,
          packageDigest: seeded.packageDigest,
          assetsDigest: seeded.assetsDigest,
          buildId: input.build,
        },
        gates,
      );
      await pg.query(
        `INSERT INTO theme_studio_acceptance_runs(id,project_id,version_id,package_digest,assets_digest,build_id,status,server_report,browser_report,evidence_digest,created_by,created_by_email,created_at,updated_at,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,$13,$7,$8,$9,$10,$11,now()-($12::int*interval '1 minute'),now()-($12::int*interval '1 minute'),now()-($12::int*interval '1 minute'))`,
        [
          runId,
          seeded.projectId,
          seeded.versionId,
          seeded.packageDigest,
          seeded.assetsDigest,
          input.build,
          JSON.stringify({
            version: 2,
            severityRules: "severity-v1",
            gates: server,
            surfaces: previewPagesFor(operatorImagePackage()).map(
              (page) => page.surface,
            ),
            automatic: true,
          }),
          JSON.stringify({
            version: 2,
            severityRules: "severity-v1",
            gates: browser,
          }),
          evidenceDigest,
          actor.id,
          actor.email,
          input.minutesAgo,
          input.status ?? "passed",
        ],
      );
      return runId;
    };

    const insertReview: Ctx["insertReview"] = async (seeded, input) => {
      const id = randomUUID();
      const layout = input.phase === "layout";
      await pg.query(
        `INSERT INTO theme_studio_visual_qa_runs(id,project_id,version_id,package_digest,qa_iteration,status,error_code,browser_report,screenshot_asset_ids,vision_report,created_by,created_at,updated_at,finished_at)
         VALUES($1,$2,$3,$4,0,$5,$6,$7,$8,'{}',$9,now()+($10::int*interval '1 minute'),now()+($10::int*interval '1 minute'),now()+($10::int*interval '1 minute'))`,
        [
          id,
          seeded.projectId,
          seeded.versionId,
          seeded.packageDigest,
          input.status,
          input.status === "failed" ? "quality_bar_not_met" : null,
          JSON.stringify(
            layout
              ? {
                  phase: "layout",
                  buildId: input.build,
                  evidence: { userAgent: "x", samples: [] },
                  gates: [],
                }
              : {
                  ...(input.runId ? { acceptanceRunId: input.runId } : {}),
                  buildId: input.build,
                },
          ),
          layout ? [] : [randomUUID()],
          actor.id,
          input.minutesFromNow,
        ],
      );
      return id;
    };

    const seed: Ctx["seed"] = async (input) => {
      const projectId = randomUUID(),
        messageId = randomUUID(),
        generationId = randomUUID(),
        versionId = randomUUID();
      const themeId = `pubtest-${projectId.slice(0, 8)}`;
      const { pkg, images } = await publishablePackage(themeId);
      const packageDigest = digestThemeStudioJson(pkg);
      await pg.query(
        `INSERT INTO theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by,created_by_email)
         VALUES($1,$2,'Publish test','ready','{home}','{small}','gemini-3.8-flash','A calm ceramics shop',$3,$4)`,
        [projectId, themeId, actor.id, actor.email],
      );
      await pg.query(
        "INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by) VALUES($1,$2,'brief','A calm ceramics shop',$3)",
        [messageId, projectId, actor.id],
      );
      await pg.query(
        `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,finished_at,created_by)
         VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$4,'succeeded',now(),$5)`,
        [
          generationId,
          projectId,
          messageId,
          `publish_${generationId}`,
          actor.id,
        ],
      );
      await pg.query(
        `INSERT INTO theme_studio_versions(id,project_id,run_id,version_number,intent_json,intent_digest,package_json,package_digest,visibility,qa_status)
         VALUES($1,$2,$3,1,'{}',$4,$5,$6,'operator','passed')`,
        [
          versionId,
          projectId,
          generationId,
          "a".repeat(64),
          JSON.stringify(pkg),
          packageDigest,
        ],
      );
      for (const image of images) {
        await pg.query(
          `INSERT INTO theme_studio_assets(project_id,purpose,media_type,bytes,byte_size,width,height,sha256,original_media_type,original_byte_size,created_by)
           VALUES($1,'image','image/webp',$2,$3,$4,$5,$6,'image/webp',$3,$7)`,
          [
            projectId,
            image.bytes,
            image.bytes.byteLength,
            image.width,
            image.height,
            image.sha,
            actor.id,
          ],
        );
      }
      await pg.query(
        "UPDATE theme_studio_projects SET current_version_id=$2 WHERE id=$1",
        [projectId, versionId],
      );
      const assetsDigest = acceptanceAssetsDigest(
        pkg,
        await assetRowsFor(db as never, projectId, pkg),
      );
      const base = { projectId, versionId, packageDigest, assetsDigest };
      // The check that made it Ready to publish, two hours ago.
      const runId = await insertRun(base, {
        build: input.build,
        minutesAgo: 120,
        gates: input.gates,
      });
      let reviewId: string | null = null;
      if (input.review !== false) {
        reviewId = randomUUID();
        await pg.query(
          `INSERT INTO theme_studio_visual_qa_runs(id,project_id,version_id,package_digest,qa_iteration,status,browser_report,screenshot_asset_ids,vision_report,created_by,created_at,updated_at,finished_at)
           VALUES($1,$2,$3,$4,0,'passed',$5,$6,$7,$8,now()-interval '119 minutes',now()-interval '119 minutes',now()-interval '119 minutes')`,
          [
            reviewId,
            projectId,
            versionId,
            packageDigest,
            JSON.stringify({ acceptanceRunId: runId, buildId: input.build }),
            [randomUUID()],
            JSON.stringify({
              severityRules: "severity-v1",
              reviewSeverity: {
                outcome: "taste",
                serious: [],
                warnings: [{ code: "palette_only" }],
              },
            }),
            actor.id,
          ],
        );
      }
      // 0151: a candidate needs a passed run over this exact package.
      await pg.query(
        "UPDATE theme_studio_projects SET status='candidate',revision=revision+1 WHERE id=$1",
        [projectId],
      );
      if (input.approved) {
        await pg.query(
          "UPDATE theme_studio_projects SET status='approved',revision=revision+1 WHERE id=$1",
          [projectId],
        );
      }
      return {
        projectId,
        versionId,
        themeId,
        pkg,
        packageDigest,
        assetsDigest,
        runId,
        reviewId,
      };
    };

    const settleReview: Ctx["settleReview"] = async (projectId, outcome) => {
      const { id } = await one<{ id: string }>(
        "SELECT id FROM theme_studio_visual_qa_runs WHERE project_id=$1 AND status='queued'",
        [projectId],
      );
      if (outcome === "passed") {
        await pg.query(
          "UPDATE theme_studio_visual_qa_runs SET status='passed',vision_report=$2,finished_at=now() WHERE id=$1",
          [
            id,
            JSON.stringify({
              severityRules: "severity-v1",
              reviewSeverity: { outcome: "pass", serious: [], warnings: [] },
            }),
          ],
        );
        // generating -> ready -> candidate: the two steps 0151 allows.
        await pg.query(
          "UPDATE theme_studio_projects SET status='ready',revision=revision+1 WHERE id=$1",
          [projectId],
        );
        await pg.query(
          "UPDATE theme_studio_projects SET status='candidate' WHERE id=$1",
          [projectId],
        );
      } else {
        await pg.query(
          "UPDATE theme_studio_visual_qa_runs SET status='failed',error_code='quality_bar_not_met',vision_report=$2,finished_at=now() WHERE id=$1",
          [
            id,
            JSON.stringify({
              severityRules: "severity-v1",
              reviewSeverity: {
                outcome: "serious",
                serious: [{ code: "inaccessible_copy" }],
                warnings: [],
              },
            }),
          ],
        );
        await pg.query(
          "UPDATE theme_studio_projects SET status='ready',revision=revision+1 WHERE id=$1",
          [projectId],
        );
      }
    };

    const answer: Ctx["answer"] = async (claim, pkg) => {
      const pages = previewPagesFor(pkg);
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
      return finishThemeStudioCapture({
        captureId: claim.captureId,
        leaseToken: claim.leaseToken,
        images: [],
        qa: {
          buildId: claim.qa!.buildId,
          packageDigest: claim.qa!.packageDigest,
          routes: pages.map((page) => ({
            path: page.path,
            surface: page.surface,
            status: page.surface === "not_found" ? 404 : 200,
            html: '<html lang="en"><head><meta name="robots" content="noindex"></head><body><main class="storefront-root sm-themed-type">Theme</main></body></html>',
            robots: "noindex",
          })),
          evidence: { userAgent: "local integration", samples },
          screenshots,
        },
      });
    };

    openPreview.mockImplementation(async () => ({
      previewId: randomUUID(),
      storeId: randomUUID(),
      origin: "https://preview.example.test",
      enterToken: "unused",
      pages: previewPagesFor(operatorImagePackage()),
      expiresAt: "2099-01-01 00:00:00+00",
    }));

    await work({
      pg,
      actor,
      one,
      count,
      revisionOf,
      seed,
      insertRun,
      insertReview,
      settleReview,
      answer,
    });
  } finally {
    await pg.query("ROLLBACK");
    await pg.end();
    vi.unstubAllEnvs();
    config.autoQaEnabled = true;
  }
}

/** Storage and the demo render, injected: nothing leaves the laptop. */
function deps(demoProblems: string[][] = []): PublicationDeps & {
  stored: string[];
  checked: { host: string; paths: string[] }[];
} {
  const stored: string[] = [];
  const checked: { host: string; paths: string[] }[] = [];
  return {
    stored,
    checked,
    async storeObject(objectPath) {
      stored.push(objectPath);
    },
    publicUrl: (path) => `https://storage.googleapis.com/test-bucket/${path}`,
    async checkDemo(input) {
      checked.push(input);
      return demoProblems.shift() ?? [];
    },
    now: () => new Date("2026-10-24T10:00:00Z"),
  };
}

const eventsOf = async (ctx: Ctx, projectId: string) =>
  (
    await ctx.pg.query(
      "SELECT event_type, detail FROM theme_studio_events WHERE project_id=$1",
      [projectId],
    )
  ).rows as { event_type: string; detail: Record<string, unknown> }[];

// A test may wait for another queue suite's test to finish (the advisory lock
// in withRollback), so each gets more than the default five seconds.
describe.skipIf(!ENABLED)(
  "Publish against the real database",
  { timeout: 60_000 },
  () => {
    it("publishes in one step with its warnings recorded under severity-v1, then hides and shows it", async () => {
      await withRollback(async (ctx) => {
        const s = await ctx.seed({ build: BUILD });
        const io = deps();
        const result = await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          io,
        );
        expect(result).toEqual({
          ok: true,
          kind: "published",
          publicationId: expect.any(String),
          themeId: s.themeId,
          releaseVersion: "1.0.0",
          demoSlug: `demo-${s.themeId}`,
        });
        expect(
          await ctx.one(
            "SELECT status FROM theme_studio_projects WHERE id=$1",
            [s.projectId],
          ),
        ).toEqual({ status: "published" });
        expect(
          await ctx.one(
            "SELECT status, acceptance_run_id, release_version FROM theme_studio_publications WHERE project_id=$1",
            [s.projectId],
          ),
        ).toEqual({
          status: "published",
          acceptance_run_id: s.runId,
          release_version: "1.0.0",
        });
        const release = await ctx.one<{ id: string; manifest_digest: string }>(
          "SELECT id, release_status, source, manifest_digest FROM theme_releases WHERE theme_id=$1",
          [s.themeId],
        );
        expect(release).toMatchObject({
          release_status: "published",
          source: "theme-studio",
        });
        expect(
          await ctx.one(
            "SELECT visibility, current_release_id FROM theme_catalog_entries WHERE theme_id=$1",
            [s.themeId],
          ),
        ).toEqual({ visibility: "public", current_release_id: release.id });
        // Every picture copied to its immutable release object; the demo's
        // four pages rendered.
        expect(io.stored).toHaveLength(s.pkg.assets.length);
        expect(
          io.stored.every((p) =>
            p.startsWith(`theme-releases/${s.themeId}/1.0.0/`),
          ),
        ).toBe(true);
        expect(io.checked[0].paths.slice(0, 2)).toEqual(["/", "/shop"]);

        const events = await eventsOf(ctx, s.projectId);
        const types = events.map((e) => e.event_type);
        // One click, one Activity line: no project_approved any more.
        expect(types).not.toContain("project_approved");
        expect(types).toEqual(
          expect.arrayContaining(["publication_started", "theme_published"]),
        );
        for (const type of ["publication_started", "theme_published"]) {
          expect(
            events.find((e) => e.event_type === type)!.detail,
          ).toMatchObject({
            acceptanceRunId: s.runId,
            severityRules: "severity-v1",
            measuredUnder: "severity-v1",
            designReview: "passed",
            designReviewId: s.reviewId,
            warnings: {
              count: 2,
              kinds: [
                {
                  source: "checks",
                  gate: "browser.tap_targets",
                  code: "small_target",
                  count: 1,
                },
                {
                  source: "review",
                  gate: null,
                  code: "palette_only",
                  count: 1,
                },
              ],
              omitted: 0,
            },
          });
        }

        // Hide, then show: the catalog moves, the immutable release does not.
        expect(
          await changeThemeStudioCatalog(ctx.actor, {
            projectId: s.projectId,
            change: { action: "hide" },
          }),
        ).toEqual({ changed: true });
        expect(
          await ctx.one(
            "SELECT visibility FROM theme_catalog_entries WHERE theme_id=$1",
            [s.themeId],
          ),
        ).toEqual({ visibility: "hidden" });
        expect(
          await changeThemeStudioCatalog(ctx.actor, {
            projectId: s.projectId,
            change: { action: "show" },
          }),
        ).toEqual({ changed: true });
        // One transaction here, so one timestamp: compare the set of actions.
        expect(
          (
            await ctx.pg.query(
              "SELECT action FROM theme_catalog_audit WHERE theme_id=$1",
              [s.themeId],
            )
          ).rows
            .map((r) => r.action)
            .sort(),
        ).toEqual(["hide", "publish", "show"]);
        expect(
          await ctx.one(
            "SELECT visibility FROM theme_catalog_entries WHERE theme_id=$1",
            [s.themeId],
          ),
        ).toEqual({ visibility: "public" });
        expect(
          await ctx.one(
            "SELECT manifest_digest FROM theme_releases WHERE id=$1",
            [release.id],
          ),
        ).toEqual({ manifest_digest: release.manifest_digest });
      });
    });

    it("records a failed demo, exposes nothing, and Try again resumes the same stored release", async () => {
      await withRollback(async (ctx) => {
        const s = await ctx.seed({ build: BUILD });
        const io = deps([["/shop answered 500."]]);
        const failed = await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          io,
        );
        expect(failed).toMatchObject({
          ok: false,
          kind: "failed",
          problems: ["Demo: /shop answered 500."],
        });
        expect(
          await ctx.one(
            "SELECT status FROM theme_studio_projects WHERE id=$1",
            [s.projectId],
          ),
        ).toEqual({ status: "approved" });
        expect(
          await ctx.count(
            "SELECT count(*) AS n FROM theme_catalog_entries WHERE theme_id=$1",
            [s.themeId],
          ),
        ).toBe(0);
        const stored = await ctx.one<{ id: string }>(
          "SELECT id FROM theme_releases WHERE theme_id=$1",
          [s.themeId],
        );

        const retried = await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          io,
        );
        expect(retried).toMatchObject({
          ok: true,
          kind: "published",
          releaseVersion: "1.0.0",
        });
        expect(
          await ctx.count(
            "SELECT count(*) AS n FROM theme_releases WHERE theme_id=$1",
            [s.themeId],
          ),
        ).toBe(1);
        expect(
          (
            await ctx.pg.query(
              "SELECT status, release_id FROM theme_studio_publications WHERE project_id=$1 ORDER BY created_at, id",
              [s.projectId],
            )
          ).rows
            .map((r) => [r.status, r.release_id])
            .sort(),
        ).toEqual(
          [
            ["failed", stored.id],
            ["published", stored.id],
          ].sort(),
        );
        const started = (await eventsOf(ctx, s.projectId)).filter(
          (e) => e.event_type === "publication_started",
        );
        expect(started.map((e) => String(e.detail.resumed)).sort()).toEqual([
          "false",
          "true",
        ]);
      });
    });

    it("refuses a stale tab, and a publish already in progress, writing nothing; retires an abandoned attempt", async () => {
      await withRollback(async (ctx) => {
        const s = await ctx.seed({ build: BUILD, approved: true });
        const revision = await ctx.revisionOf(s.projectId);
        await expect(
          publishThemeStudioProject(
            ctx.actor,
            { projectId: s.projectId, expectedRevision: revision - 1 },
            deps(),
          ),
        ).rejects.toMatchObject({ code: "stale" });

        const live = randomUUID();
        await ctx.pg.query(
          `INSERT INTO theme_studio_publications(id,project_id,version_id,acceptance_run_id,theme_id,release_version,created_by,created_by_email,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,'1.0.0',$6,$7,now()-interval '1 minute',now()-interval '1 minute')`,
          [
            live,
            s.projectId,
            s.versionId,
            s.runId,
            s.themeId,
            ctx.actor.id,
            ctx.actor.email,
          ],
        );
        await expect(
          publishThemeStudioProject(
            ctx.actor,
            { projectId: s.projectId, expectedRevision: revision },
            deps(),
          ),
        ).rejects.toMatchObject({
          code: "illegal_state",
          message: "A publication is already in progress.",
        });
        expect(
          await ctx.count(
            "SELECT count(*) AS n FROM theme_studio_publications WHERE project_id=$1",
            [s.projectId],
          ),
        ).toBe(1);

        // The same attempt, abandoned: its last write 20 minutes ago.
        const t = await withAbandoned(ctx, s, live);
        const published = await publishThemeStudioProject(
          ctx.actor,
          { projectId: s.projectId, expectedRevision: revision },
          deps(),
        );
        expect(published).toMatchObject({ ok: true, kind: "published" });
        expect(
          await ctx.one(
            "SELECT status, failure FROM theme_studio_publications WHERE id=$1",
            [t],
          ),
        ).toEqual({
          status: "failed",
          failure: ["The attempt was abandoned before it finished."],
        });
      });
    });

    it("re-checks a Ready to publish design whose checks ran on an earlier build, writes no publication or check run, and publishes once the in-place re-check passes", async () => {
      await withRollback(async (ctx) => {
        const s = await ctx.seed({ build: OLD_BUILD });
        const versionBefore = await ctx.one(
          "SELECT * FROM theme_studio_versions WHERE id=$1",
          [s.versionId],
        );
        expect(
          await currentPublishEvidence(drizzleOf(ctx), {
            projectId: s.projectId,
          }),
        ).toEqual({
          ok: false,
          reason: "old_build",
        });
        const revision = await ctx.revisionOf(s.projectId);
        const result = await publishThemeStudioProject(
          ctx.actor,
          { projectId: s.projectId, expectedRevision: revision },
          deps(),
        );
        expect(result).toMatchObject({
          ok: false,
          kind: "rechecking",
          reason: "old_build",
          inPlace: true,
        });
        if (result.kind !== "rechecking") throw new Error("not rechecking");
        expect(
          await ctx.one(
            "SELECT status, revision FROM theme_studio_projects WHERE id=$1",
            [s.projectId],
          ),
        ).toEqual({ status: "generating", revision: revision + 1 });
        const capture = await ctx.one<Record<string, unknown>>(
          "SELECT * FROM theme_studio_captures WHERE id=$1",
          [result.captureId],
        );
        expect(capture).toMatchObject({
          status: "queued",
          phase: "final",
          automatic: true,
          previous_status: "generating",
          qa_iteration: 3,
          version_id: s.versionId,
        });
        expect(recheckReasonOf(capture.idempotency_key as string)).toBe(
          "publish_recheck",
        );
        // Nothing published, nothing measured: no attempt, and no check run
        // that would mix the old browser data with today's build.
        expect(
          await ctx.count(
            "SELECT count(*) AS n FROM theme_studio_publications WHERE project_id=$1",
            [s.projectId],
          ),
        ).toBe(0);
        expect(
          await ctx.count(
            "SELECT count(*) AS n FROM theme_studio_acceptance_runs WHERE project_id=$1",
            [s.projectId],
          ),
        ).toBe(1);
        // A second press finds the theme being checked.
        await expect(
          publishThemeStudioProject(
            ctx.actor,
            { projectId: s.projectId, expectedRevision: revision + 1 },
            deps(),
          ),
        ).rejects.toMatchObject({ code: "illegal_state" });

        // The capture job measures it in place on today's build.
        const claim = await claimThemeStudioCapture();
        expect(claim?.captureId).toBe(result.captureId);
        expect(claim?.shots).toEqual([]);
        expect(await ctx.answer(claim!, s.pkg)).toEqual({
          status: "succeeded",
          versionId: s.versionId,
          // The job wakes the review route for it (TS-3A).
          designReview: "waiting",
        });
        const today = await ctx.one<{ id: string; status: string }>(
          "SELECT id, status FROM theme_studio_acceptance_runs WHERE project_id=$1 AND build_id=$2",
          [s.projectId, BUILD],
        );
        expect(today.status).toBe("passed");
        // A complete new run on today's build; the old one is untouched.
        expect(
          await ctx.one(
            "SELECT build_id, browser_report->'evidence'->>'userAgent' AS agent FROM theme_studio_acceptance_runs WHERE id=$1",
            [today.id],
          ),
        ).toEqual({ build_id: BUILD, agent: "local integration" });
        expect(
          await ctx.one(
            "SELECT build_id FROM theme_studio_acceptance_runs WHERE id=$1",
            [s.runId],
          ),
        ).toEqual({ build_id: OLD_BUILD });
        // Until its own review passes, Publish cannot use it.
        expect(
          await currentPublishEvidence(drizzleOf(ctx), {
            projectId: s.projectId,
          }),
        ).toEqual({
          ok: false,
          reason: "no_review",
        });
        await ctx.settleReview(s.projectId, "passed");
        expect(
          await currentPublishEvidence(drizzleOf(ctx), {
            projectId: s.projectId,
          }),
        ).toEqual({
          ok: true,
          acceptanceRunId: today.id,
        });
        const published = await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          deps(),
        );
        expect(published).toMatchObject({ ok: true, kind: "published" });
        expect(
          await ctx.one(
            "SELECT acceptance_run_id FROM theme_studio_publications WHERE project_id=$1",
            [s.projectId],
          ),
        ).toEqual({ acceptance_run_id: today.id });
        // The version row was never written by the re-check.
        expect(
          await ctx.one("SELECT * FROM theme_studio_versions WHERE id=$1", [
            s.versionId,
          ]),
        ).toEqual(versionBefore);
      });
    });

    it("re-checks a newest check run that has no design review of its own (the in-browser runner's)", async () => {
      await withRollback(async (ctx) => {
        const s = await ctx.seed({ build: BUILD });
        // A newer in-browser pass on today's build, with no review bound.
        await ctx.insertRun(s, { build: BUILD, minutesAgo: 30 });
        const result = await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          deps(),
        );
        expect(result).toMatchObject({
          kind: "rechecking",
          reason: "no_review",
        });
        expect(
          await ctx.count(
            "SELECT count(*) AS n FROM theme_studio_publications WHERE project_id=$1",
            [s.projectId],
          ),
        ).toBe(0);
      });
    });

    it("never lets an older pass outweigh a newer check that failed", async () => {
      await withRollback(async (ctx) => {
        const s = await ctx.seed({ build: BUILD });
        expect(
          await currentPublishEvidence(drizzleOf(ctx), {
            projectId: s.projectId,
          }),
        ).toEqual({ ok: true, acceptanceRunId: s.runId });
        // A later check of the same design on the same build failed.
        await ctx.insertRun(s, {
          build: BUILD,
          minutesAgo: 30,
          status: "failed",
          gates: passedGates({
            "browser.overflow": [
              {
                code: "overflow",
                message: "Scrolls sideways.",
                where: "phone360 · home",
              },
            ],
          }),
        });
        expect(
          await currentPublishEvidence(drizzleOf(ctx), {
            projectId: s.projectId,
          }),
        ).toEqual({ ok: false, reason: "none" });
        expect(
          await publishThemeStudioProject(
            ctx.actor,
            {
              projectId: s.projectId,
              expectedRevision: await ctx.revisionOf(s.projectId),
            },
            deps(),
          ),
        ).toMatchObject({ kind: "rechecking", reason: "none" });
      });
    });

    it("a failed in-place re-measure, then a passing in-browser run on the same build, neither promotes nor publishes", async () => {
      await withRollback(async (ctx) => {
        const s = await ctx.seed({ build: OLD_BUILD });
        const result = await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          deps(),
        );
        expect(result).toMatchObject({ kind: "rechecking" });
        const claim = await claimThemeStudioCapture();
        await ctx.answer(claim!, s.pkg);
        await ctx.settleReview(s.projectId, "failed");
        expect(
          await ctx.one(
            "SELECT status FROM theme_studio_projects WHERE id=$1",
            [s.projectId],
          ),
        ).toEqual({ status: "ready" });

        // Reviews that must not count for the manual promotion: a passed
        // layout check on this build (newer), a passed final review from
        // another build (newest), and an older passed final review on this
        // build. Only the newest FINAL review on the run's own build does.
        await ctx.insertReview(s, {
          build: BUILD,
          phase: "layout",
          status: "passed",
          minutesFromNow: 1,
        });
        await ctx.insertReview(s, {
          build: "publish-build-elsewhere",
          phase: "final",
          status: "passed",
          minutesFromNow: 2,
          runId: s.runId,
        });
        await ctx.insertReview(s, {
          build: BUILD,
          phase: "final",
          status: "passed",
          minutesFromNow: -180,
          runId: s.runId,
        });

        // The in-browser runner passes on the same build.
        const nonce = "a-local-browser-nonce-only-for-this-test";
        const manual = randomUUID();
        const pages = previewPagesFor(s.pkg);
        await ctx.pg.query(
          `INSERT INTO theme_studio_acceptance_runs(id,project_id,version_id,package_digest,assets_digest,build_id,status,server_report,browser_nonce_hash,browser_expires_at,created_by,created_by_email)
         VALUES($1,$2,$3,$4,$5,$6,'awaiting_browser',$7,$8,now()+interval '30 minutes',$9,$10)`,
          [
            manual,
            s.projectId,
            s.versionId,
            s.packageDigest,
            s.assetsDigest,
            BUILD,
            JSON.stringify({
              version: 2,
              severityRules: "severity-v1",
              gates: passedGates().filter((g) => !g.id.startsWith("browser.")),
              surfaces: pages.map((page) => page.surface),
            }),
            sha256(nonce),
            ctx.actor.id,
            ctx.actor.email,
          ],
        );
        const submitted = await submitThemeStudioBrowserEvidence(ctx.actor, {
          projectId: s.projectId,
          runId: manual,
          nonce,
          evidence: browserEvidence(pages),
        });
        // The run passed, but the newest final review on this build failed:
        // an older pass never stands in for it.
        expect(submitted).toEqual({
          status: "passed",
          candidate: false,
          visualQa: "required",
        });
        expect(
          await ctx.one(
            "SELECT status FROM theme_studio_projects WHERE id=$1",
            [s.projectId],
          ),
        ).toEqual({ status: "ready" });
        await expect(
          publishThemeStudioProject(
            ctx.actor,
            {
              projectId: s.projectId,
              expectedRevision: await ctx.revisionOf(s.projectId),
            },
            deps(),
          ),
        ).rejects.toMatchObject({ code: "illegal_state" });

        // Even made Ready to publish by hand (the database allows it: a passed
        // run covers the package), Publish will not publish this evidence.
        await ctx.pg.query(
          "UPDATE theme_studio_projects SET status='candidate' WHERE id=$1",
          [s.projectId],
        );
        const again = await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          deps(),
        );
        expect(again).toMatchObject({
          kind: "rechecking",
          reason: "no_review",
        });
        expect(
          await ctx.count(
            "SELECT count(*) AS n FROM theme_studio_publications WHERE project_id=$1",
            [s.projectId],
          ),
        ).toBe(0);
      });
    });

    it("Try again after a code change re-checks first, then resumes the release the first attempt stored", async () => {
      await withRollback(async (ctx) => {
        const s = await ctx.seed({ build: BUILD });
        const io = deps([["/cart answered 502."]]);
        expect(
          await publishThemeStudioProject(
            ctx.actor,
            {
              projectId: s.projectId,
              expectedRevision: await ctx.revisionOf(s.projectId),
            },
            io,
          ),
        ).toMatchObject({ kind: "failed" });
        const stored = await ctx.one<{ id: string }>(
          "SELECT id FROM theme_releases WHERE theme_id=$1",
          [s.themeId],
        );

        // StoreMink is deployed: today's build is a new one.
        vi.stubEnv("THEME_STUDIO_BUILD_ID", "publish-build-tomorrow");
        const retry = await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          io,
        );
        expect(retry).toMatchObject({
          kind: "rechecking",
          reason: "old_build",
          inPlace: true,
        });
        expect(
          await ctx.one(
            "SELECT status FROM theme_studio_projects WHERE id=$1",
            [s.projectId],
          ),
        ).toEqual({ status: "generating" });
        const claim = await claimThemeStudioCapture();
        expect(claim?.qa?.buildId).toBe("publish-build-tomorrow");
        await ctx.answer(claim!, s.pkg);
        await ctx.settleReview(s.projectId, "passed");

        const published = await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          io,
        );
        expect(published).toMatchObject({
          ok: true,
          kind: "published",
          releaseVersion: "1.0.0",
        });
        expect(
          await ctx.one(
            "SELECT release_id FROM theme_studio_publications WHERE project_id=$1 AND status='published'",
            [s.projectId],
          ),
        ).toEqual({ release_id: stored.id });
        expect(
          await ctx.count(
            "SELECT count(*) AS n FROM theme_releases WHERE theme_id=$1",
            [s.themeId],
          ),
        ).toBe(1);
      });
    });

    it("with the automatic checks off, publishes on a passed run alone and labels it; refuses an earlier build's run with today's words", async () => {
      await withRollback(async (ctx) => {
        config.autoQaEnabled = false;
        const old = await ctx.seed({ build: OLD_BUILD, review: false });
        await expect(
          publishThemeStudioProject(
            ctx.actor,
            {
              projectId: old.projectId,
              expectedRevision: await ctx.revisionOf(old.projectId),
            },
            deps(),
          ),
        ).rejects.toMatchObject({
          code: "stale",
          message:
            "The evidence was rendered by an earlier build. Run the checks again.",
        });
        expect(
          await ctx.count(
            "SELECT count(*) AS n FROM theme_studio_captures WHERE project_id=$1",
            [old.projectId],
          ),
        ).toBe(0);

        const s = await ctx.seed({ build: BUILD, review: false });
        expect(
          await publishThemeStudioProject(
            ctx.actor,
            {
              projectId: s.projectId,
              expectedRevision: await ctx.revisionOf(s.projectId),
            },
            deps(),
          ),
        ).toMatchObject({ ok: true, kind: "published" });
        const published = (await eventsOf(ctx, s.projectId)).find(
          (e) => e.event_type === "theme_published",
        );
        expect(published?.detail).toMatchObject({
          designReview: "not_configured",
          designReviewId: null,
        });
      });
    });

    it("records any number of warnings within the event's 4 KiB", async () => {
      await withRollback(async (ctx) => {
        // Twenty moderate accessibility rules with long names: all warnings.
        const rules = Array.from({ length: 20 }, (_, i) => ({
          code: `${"moderate-rule-with-a-long-name-".repeat(2)}${i}`,
          message: "A moderate rule.",
          where: `phone390 · page ${i}`,
          impact: "moderate" as const,
          nodes: 1,
        }));
        const s = await ctx.seed({
          build: BUILD,
          gates: passedGates({ "browser.accessibility": rules }),
        });
        expect(
          await publishThemeStudioProject(
            ctx.actor,
            {
              projectId: s.projectId,
              expectedRevision: await ctx.revisionOf(s.projectId),
            },
            deps(),
          ),
        ).toMatchObject({ ok: true, kind: "published" });
        const published = (await eventsOf(ctx, s.projectId)).find(
          (e) => e.event_type === "theme_published",
        )!;
        const log = published.detail.warnings as {
          count: number;
          kinds: unknown[];
          omitted: number;
        };
        expect(log.count).toBe(22);
        expect(log.kinds).toHaveLength(16);
        expect(log.omitted).toBe(6);
      });
    });

    it("★ a published theme takes a change: publishing it is the next release, and the first release stays as it was (migration 0288)", async () => {
      await withRollback(async (ctx) => {
        const s = await ctx.seed({ build: BUILD });
        const first = deps();
        await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          first,
        );
        const statusOf = async () =>
          await ctx.one<{ status: string; current_version_id: string }>(
            "SELECT status, current_version_id FROM theme_studio_projects WHERE id=$1",
            [s.projectId],
          );
        const releaseOne = await ctx.one<{
          id: string;
          manifest_digest: string;
        }>(
          "SELECT id, manifest_digest FROM theme_releases WHERE theme_id=$1 AND version='1.0.0'",
          [s.themeId],
        );
        expect(await statusOf()).toEqual({
          status: "published",
          current_version_id: s.versionId,
        });

        // 1. A live theme takes a change. It was refused before 0288
        //    ("This project can't start a revision right now.").
        const change = await reviseThemeStudioVersion(ctx.actor, {
          projectId: s.projectId,
          versionId: s.versionId,
          expectedRevision: await ctx.revisionOf(s.projectId),
          expectedPackageDigest: s.packageDigest,
          body: "Make the home page heading shorter.",
          idempotencyKey: `change_live_${randomUUID()}`,
        });
        expect(change.duplicate).toBe(false);
        expect((await statusOf()).status).toBe("generating");
        // The release new stores get did not move.
        const catalogAt = async () =>
          (
            await ctx.one<{ current_release_id: string }>(
              "SELECT current_release_id FROM theme_catalog_entries WHERE theme_id=$1",
              [s.themeId],
            )
          ).current_release_id;
        expect(await catalogAt()).toBe(releaseOne.id);

        // 2. The change does not finish and nothing new is current: the
        //    theme is simply live again (worker.ts and stop.ts settle with
        //    this same expression).
        await service(async (db: ReturnType<typeof drizzle>) => {
          await db
            .update(themeStudioProjects)
            .set({
              status: restingStatusSql(),
              revision: sql`${themeStudioProjects.revision} + 1`,
            })
            .where(eq(themeStudioProjects.id, s.projectId));
        });
        expect(await statusOf()).toEqual({
          status: "published",
          current_version_id: s.versionId,
        });

        // 3. A changed design, as a finished change leaves it: a second
        //    version, current, with the theme at ready.
        const changed: ThemePackageV2 = {
          ...s.pkg,
          definition: {
            ...s.pkg.definition,
            description: `${s.pkg.definition.description} Now with a shorter heading.`,
          },
        };
        const parsed = validateThemePackageV2(changed);
        if (!parsed.ok) throw new Error(parsed.issues.join("; "));
        const secondDigest = digestThemeStudioJson(parsed.value);
        expect(secondDigest).not.toBe(s.packageDigest);
        const secondId = randomUUID();
        await ctx.pg.query(
          `INSERT INTO theme_studio_versions(id,project_id,run_id,parent_version_id,version_number,intent_json,intent_digest,package_json,package_digest,visibility,qa_status)
           VALUES($1,$2,$3,$4,2,'{}',$5,$6,$7,'operator','passed')`,
          [
            secondId,
            s.projectId,
            change.runId,
            s.versionId,
            "b".repeat(64),
            JSON.stringify(parsed.value),
            secondDigest,
          ],
        );
        await ctx.pg.query(
          "UPDATE theme_studio_projects SET status='generating',revision=revision+1 WHERE id=$1",
          [s.projectId],
        );
        await ctx.pg.query(
          "UPDATE theme_studio_projects SET status='ready',current_version_id=$2,revision=revision+1 WHERE id=$1",
          [s.projectId, secondId],
        );
        // ★ The database's rule holds from every state: a theme is published
        //   only on a design a publication published. The changed design
        //   has none yet.
        await ctx.pg.query("SAVEPOINT never_published");
        await expect(
          ctx.pg.query(
            "UPDATE theme_studio_projects SET status='published' WHERE id=$1",
            [s.projectId],
          ),
        ).rejects.toThrow(/published only by a publication/);
        await ctx.pg.query("ROLLBACK TO SAVEPOINT never_published");

        // 4. The published design made current again: live, nothing to
        //    check or publish.
        expect(
          await restoreThemeStudioVersion(ctx.actor, {
            projectId: s.projectId,
            versionId: s.versionId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          }),
        ).toEqual({ changed: true, outcome: "live" });
        expect(await statusOf()).toEqual({
          status: "published",
          current_version_id: s.versionId,
        });
        expect(
          await ctx.count(
            "SELECT count(*)::int AS n FROM theme_studio_captures WHERE project_id=$1 AND status='queued'",
            [s.projectId],
          ),
        ).toBe(0);

        // 5. The changed design passed its checks on today's build, and is
        //    made current on the live theme: Ready to publish.
        const secondRun = await ctx.insertRun(
          {
            projectId: s.projectId,
            versionId: secondId,
            packageDigest: secondDigest,
            assetsDigest: s.assetsDigest,
          },
          { build: BUILD, minutesAgo: 10 },
        );
        await ctx.pg.query(
          `INSERT INTO theme_studio_visual_qa_runs(id,project_id,version_id,package_digest,qa_iteration,status,browser_report,screenshot_asset_ids,vision_report,created_by,created_at,updated_at,finished_at)
           VALUES($1,$2,$3,$4,0,'passed',$5,$6,$7,$8,now()-interval '9 minutes',now()-interval '9 minutes',now()-interval '9 minutes')`,
          [
            randomUUID(),
            s.projectId,
            secondId,
            secondDigest,
            JSON.stringify({ acceptanceRunId: secondRun, buildId: BUILD }),
            [randomUUID()],
            JSON.stringify({
              severityRules: "severity-v1",
              reviewSeverity: { outcome: "pass", serious: [], warnings: [] },
            }),
            ctx.actor.id,
          ],
        );
        expect(
          await restoreThemeStudioVersion(ctx.actor, {
            projectId: s.projectId,
            versionId: secondId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          }),
        ).toEqual({ changed: true, outcome: "ready_to_publish" });
        expect(await statusOf()).toEqual({
          status: "candidate",
          current_version_id: secondId,
        });

        // 6. Publishing it stores the theme's NEXT release.
        const second = deps();
        const result = await publishThemeStudioProject(
          ctx.actor,
          {
            projectId: s.projectId,
            expectedRevision: await ctx.revisionOf(s.projectId),
          },
          second,
        );
        expect(result).toMatchObject({
          ok: true,
          kind: "published",
          releaseVersion: "1.1.0",
        });
        expect(await statusOf()).toEqual({
          status: "published",
          current_version_id: secondId,
        });
        expect(
          second.stored.every((p) =>
            p.startsWith(`theme-releases/${s.themeId}/1.1.0/`),
          ),
        ).toBe(true);
        expect(
          (
            await ctx.pg.query(
              "SELECT release_version, version_id FROM theme_studio_publications WHERE project_id=$1 AND status='published' ORDER BY release_version",
              [s.projectId],
            )
          ).rows,
        ).toEqual([
          { release_version: "1.0.0", version_id: s.versionId },
          { release_version: "1.1.0", version_id: secondId },
        ]);
        const releaseTwo = await ctx.one<{ id: string }>(
          "SELECT id FROM theme_releases WHERE theme_id=$1 AND version='1.1.0'",
          [s.themeId],
        );
        // New installs read the catalogue, which now names 1.1.0 ...
        expect(await catalogAt()).toBe(releaseTwo.id);
        // ★ ... and 1.0.0, which a store that installed the theme pins, is
        //   the very row it was: same id, same content address, published.
        expect(
          await ctx.one(
            "SELECT id, manifest_digest, release_status FROM theme_releases WHERE theme_id=$1 AND version='1.0.0'",
            [s.themeId],
          ),
        ).toEqual({ ...releaseOne, release_status: "published" });

        // 7. One release per design: the same design is never stored twice.
        await ctx.pg.query(
          "UPDATE theme_studio_projects SET status='ready',revision=revision+1 WHERE id=$1",
          [s.projectId],
        );
        await ctx.pg.query(
          "UPDATE theme_studio_projects SET status='candidate',revision=revision+1 WHERE id=$1",
          [s.projectId],
        );
        await expect(
          publishThemeStudioProject(
            ctx.actor,
            {
              projectId: s.projectId,
              expectedRevision: await ctx.revisionOf(s.projectId),
            },
            deps(),
          ),
        ).rejects.toThrow(/already published as v1\.1\.0/);
        expect(
          await ctx.count(
            "SELECT count(*)::int AS n FROM theme_releases WHERE theme_id=$1",
            [s.themeId],
          ),
        ).toBe(2);
      });
    });
  },
);

/** The rolled-back connection as the code's own database handle. */
function drizzleOf(ctx: Ctx) {
  return drizzle(ctx.pg) as never;
}

/** Make a `publishing` attempt look abandoned: its last write 20 minutes ago.
 * The publication guard refreshes updated_at on any update, so the row is
 * replaced rather than edited (the guard allows no delete; a fresh id). */
async function withAbandoned(
  ctx: Ctx,
  s: Seeded,
  live: string,
): Promise<string> {
  // Fail the live one as a crashed instance's attempt would be left, by the
  // only path the guard allows: a final status. Then write the abandoned one.
  await ctx.pg.query(
    "UPDATE theme_studio_publications SET status='failed',completed_at=now(),failure='[\"test setup\"]' WHERE id=$1",
    [live],
  );
  const abandoned = randomUUID();
  await ctx.pg.query(
    `INSERT INTO theme_studio_publications(id,project_id,version_id,acceptance_run_id,theme_id,release_version,created_by,created_by_email,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,'1.0.0',$6,$7,now()-interval '20 minutes',now()-interval '20 minutes')`,
    [
      abandoned,
      s.projectId,
      s.versionId,
      s.runId,
      s.themeId,
      ctx.actor.id,
      ctx.actor.email,
    ],
  );
  return abandoned;
}

/** Every page at every width, measured clean, chrome states on the home page. */
function browserEvidence(pages: ReturnType<typeof previewPagesFor>) {
  return {
    userAgent: "in-browser runner",
    samples: Object.entries(THEME_STUDIO_QA_VIEWPORTS).flatMap(
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
        })),
    ),
  };
}
