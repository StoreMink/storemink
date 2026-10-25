// Opt-in local PostgreSQL regression (Theme Studio TS-1D): every change is
// checked. A picture saved by hand, an operator's photo run and a Retry go
// through the automatic final check; Make current is never a dead end; a
// blocked theme can be revised; the concurrency cap counts only what an
// operator started. Every fixture and write rolls back. The preview store is
// stubbed and the design reviewer answers from a stub: no network, no model
// call, nothing paid. Run THEME_STUDIO_RECOVERY_DB_TEST=1 with Vitest.
import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import sharp from "sharp";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import { THEME_STUDIO_QA_VIEWPORTS } from "./acceptance-gates";
import { CHROME_STATES } from "./chrome-states";
import type { ThemeIntent, ThemePackageV2 } from "./contracts";
import type { ThemeImageRequest } from "./image-provider";

const { service, review, openPreview, evidence, config, failing } = vi.hoisted(
  () => ({
    service: vi.fn(),
    review: vi.fn(),
    openPreview: vi.fn(),
    evidence: vi.fn(),
    config: { autoQaEnabled: true },
    /** A photo brief the fake image client refuses to draw while set. */
    failing: { briefId: null as string | null },
  }),
);
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
// The design reviewer is the offline text client; each test says what it
// answers. Photo runs keep the real offline image client and its checker.
vi.mock("./fake-provider", async (original) => ({
  ...(await original<typeof import("./fake-provider")>()),
  createFakeModelClient: () => ({ provider: "fake", generate: review }),
}));
vi.mock("./image-fake", async (original) => {
  const actual = await original<typeof import("./image-fake")>();
  return {
    ...actual,
    createFakeImageClient: (
      ...args: Parameters<typeof actual.createFakeImageClient>
    ) => {
      const client = actual.createFakeImageClient(...args);
      return {
        ...client,
        generateImage: (request: ThemeImageRequest, signal: AbortSignal) =>
          request.briefId === failing.briefId
            ? Promise.resolve({
                kind: "error" as const,
                code: "provider_unavailable" as const,
                usage: { inputTokens: 0, outputTokens: 0 },
              })
            : client.generateImage(request, signal),
      };
    },
  };
});
// Make current reads the publish evidence through this; it is the real one
// unless a test says otherwise.
vi.mock("./acceptance", async (original) => ({
  ...(await original<typeof import("./acceptance")>()),
  currentPublishEvidence: evidence,
}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

import {
  prepareSlotImage,
  replaceThemeStudioSlotImages,
  slotUploadTarget,
  storeThemeStudioSlotImage,
} from "./slot-images";
import {
  applySlotReplacements,
  describeSlots,
  slotByteLimit,
  slotTargetSize,
  type SlotImageRow,
} from "./slot-images-core";
import {
  claimThemeStudioCapture,
  finishThemeStudioCapture,
  type ClaimedCapture,
} from "./capture";
import { captureShots, recheckReasonOf } from "./capture-core";
import { generatableSlots } from "./image-generation-core";
import { previewPagesFor } from "./preview";
import { runThemeStudioVisualQaWorker } from "./visual-qa";
import { runThemeStudioWorker } from "./worker";
import { stopThemeStudioChecks } from "./stop";
import { runThemeGeneration } from "./pipeline";
import {
  cancelThemeStudioRun,
  digestThemeStudioJson,
  queueThemeStudioImages,
  restoreThemeStudioVersion,
  retryThemeStudioRun,
  reviseThemeStudioVersion,
} from "./repository";

const ENABLED = process.env.THEME_STUDIO_RECOVERY_DB_TEST === "1";
const BUILD = "change-checks-build-1";

let draftCache: { pkg: ThemePackageV2; intent: ThemeIntent } | null = null;

/** The offline provider's own design (what a first build makes): every
 * picture is a placeholder. */
async function draft() {
  if (draftCache) return draftCache;
  const actual =
    await vi.importActual<typeof import("./fake-provider")>("./fake-provider");
  const facts = {
    name: "Change checks",
    themeId: "change-checks",
    industries: ["home" as const],
    catalogSizes: ["small" as const],
    requiredFeatures: [],
  };
  const outcome = await runThemeGeneration(
    actual.createFakeModelClient({
      ...facts,
      brief: "A calm ceramics shop",
      referenceCount: 0,
    }),
    {
      facts: { ...facts, baseThemeName: null },
      compile: {
        ...facts,
        baseEngine: null,
        versionNumber: 1,
        modelKey: "gemini-3.8-flash",
        modelLabel: "Gemini 3.8 Flash",
        referenceDigests: [],
      },
      providerModel: "fake",
      promptVersion: "theme-studio-fake-v1",
      messages: [{ kind: "brief", body: "A calm ceramics shop" }],
      references: [],
    },
    new AbortController().signal,
  );
  if (outcome.kind !== "version") throw new Error(outcome.kind);
  draftCache = { pkg: outcome.package, intent: outcome.intent };
  return draftCache;
}

const fives = {
  artDirection: 5,
  distinctness: 5,
  commerceClarity: 5,
  typography: 5,
  imagery: 5,
  responsiveComposition: 5,
  detailQuality: 5,
  brandAdaptability: 5,
};

/** A plain solid picture of the given size; `seed` keeps the bytes unique. */
function solid(width: number, height: number, seed: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: {
        r: (seed * 37) % 256,
        g: (seed * 91 + 40) % 256,
        b: (seed * 53 + 80) % 256,
      },
    },
  })
    .png()
    .toBuffer();
}

type Ctx = {
  pg: Client;
  actor: { id: string; email: string };
  one: <T = Record<string, unknown>>(
    sql: string,
    args?: unknown[],
  ) => Promise<T>;
  count: (sql: string, args?: unknown[]) => Promise<number>;
  revisionOf: (projectId: string) => Promise<number>;
  /** A project at the given status whose current version holds `pkg` (or
   * what `pkg` builds once the project exists, for its stored pictures). */
  project: (input: {
    pkg: ThemePackageV2 | ((projectId: string) => Promise<ThemePackageV2>);
    status?: "ready" | "candidate" | "blocked";
    qaStatus?: "passed" | "failed" | "not_required";
    acceptanceBuild?: string | null;
  }) => Promise<{
    projectId: string;
    versionId: string;
    digest: string;
    messageId: string;
    pkg: ThemePackageV2;
  }>;
  /** Insert another visible version of a project. */
  version: (
    projectId: string,
    pkg: ThemePackageV2,
    input?: { visibility?: "operator" | "internal"; qaStatus?: string },
  ) => Promise<{ versionId: string; digest: string }>;
  /** Every picture of `pkg` stored for real, then put in the package. */
  complete: (
    projectId: string,
    pkg: ThemePackageV2,
    /** "generated": as a photo run leaves it, so a redraw may take it. */
    source?: "operator-owned" | "generated",
  ) => Promise<ThemePackageV2>;
  /** The capture job's answer: every page at every width (the home page with
   * its menus, search, cart, account and sign-in measured), a screenshot per
   * sample, the themed HTML each page served, and the catalogue shots asked. */
  answer: (
    claim: ClaimedCapture,
    pkg: ThemePackageV2,
  ) => ReturnType<typeof finishThemeStudioCapture>;
  /** The capture job's claim, which must be of `projectId`: a capture of any
   * other project would be answered with this test's package. */
  claim: (projectId: string) => Promise<ClaimedCapture | null>;
};

/**
 * One rolled-back transaction per test. The code under test runs as
 * app_service inside a savepoint per `withService` call, so a statement the
 * database refuses rolls back only that call, as a real transaction would.
 */
async function withRollback(work: (ctx: Ctx) => Promise<void>) {
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "local-change-checks-only");
  vi.stubEnv("THEME_STUDIO_BUILD_ID", BUILD);
  config.autoQaEnabled = true;
  failing.briefId = null;
  review.mockReset();
  evidence.mockReset();
  const actual =
    await vi.importActual<typeof import("./acceptance")>("./acceptance");
  evidence.mockImplementation(actual.currentPublishEvidence);
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
    // One queue suite at a time (capture-recheck, change-checks, layout-
    // preflight, publication and visual-qa): each isolates the shared
    // capture and design-review queues in its own rolled-back transaction,
    // then claims from them. Run side by side, one would claim a committed
    // local row the other held while isolating (a capture queued since
    // 29 Sep did exactly that). Taken before the lock timeout is set, so
    // waiting for another suite's test never times the wait out; the
    // ROLLBACK releases it.
    await pg.query(
      "SELECT pg_advisory_xact_lock(hashtext('theme_studio_queue_db_tests'))",
    );
    await pg.query("SET LOCAL lock_timeout = '5s'");
    // Isolate the local queues inside this rolled-back transaction: every
    // active row, never skipped, so no claim below can take another
    // project's work.
    await pg.query(
      "UPDATE theme_studio_runs SET retry_not_before=now()+interval '1 hour' WHERE status='queued'",
    );
    await pg.query(
      "UPDATE theme_studio_runs SET lease_expires_at=now()+interval '1 hour' WHERE status='running'",
    );
    await pg.query(
      "UPDATE theme_studio_captures SET status='failed',error_code='test_isolation',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE status IN ('queued','running')",
    );
    await pg.query(
      "UPDATE theme_studio_visual_qa_runs SET status='failed',error_code='test_isolation',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE status IN ('queued','running')",
    );
    const actor = {
      id: randomUUID(),
      email: `${randomUUID()}@change-checks.test`,
    };
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
    const { intent } = await draft();

    const version: Ctx["version"] = async (projectId, pkg, input = {}) => {
      const versionId = randomUUID();
      const digest = digestThemeStudioJson(pkg);
      const number =
        ((
          await one<{ latest: number | null }>(
            "SELECT max(version_number) AS latest FROM theme_studio_versions WHERE project_id=$1",
            [projectId],
          )
        ).latest ?? 0) + 1;
      const parent =
        number === 1
          ? null
          : (
              await one<{ id: string }>(
                "SELECT id FROM theme_studio_versions WHERE project_id=$1 ORDER BY version_number LIMIT 1",
                [projectId],
              )
            ).id;
      await pg.query(
        `INSERT INTO theme_studio_versions(id,project_id,origin,run_id,parent_version_id,edit_detail,version_number,intent_json,intent_digest,package_json,package_digest,visibility,qa_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          versionId,
          projectId,
          parent ? "asset_edit" : "run",
          parent
            ? null
            : (
                await one<{ id: string }>(
                  "SELECT id FROM theme_studio_runs WHERE project_id=$1 ORDER BY created_at LIMIT 1",
                  [projectId],
                )
              ).id,
          parent,
          JSON.stringify(parent ? { fromVersionId: parent, slots: [] } : {}),
          number,
          JSON.stringify(intent),
          digestThemeStudioJson(intent),
          JSON.stringify(pkg),
          digest,
          input.visibility ?? "operator",
          input.qaStatus ??
            (input.visibility === "internal" ? "pending" : "passed"),
        ],
      );
      return { versionId, digest };
    };

    const project: Ctx["project"] = async (input) => {
      const projectId = randomUUID();
      const messageId = randomUUID();
      const runId = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by,created_by_email)
         VALUES($1,$2,'Change checks','generating','{home}','{small}','gemini-3.8-flash','A calm ceramics shop',$3,$4)`,
        [projectId, `change-checks-${projectId}`, actor.id, actor.email],
      );
      await pg.query(
        "INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by) VALUES($1,$2,'brief','A calm ceramics shop',$3)",
        [messageId, projectId, actor.id],
      );
      await pg.query(
        `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,created_by,status,finished_at,created_at)
         VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$4,$5,'succeeded',now(),now()-interval '1 day')`,
        [runId, projectId, messageId, `change_checks_${runId}`, actor.id],
      );
      const pkg =
        typeof input.pkg === "function"
          ? await input.pkg(projectId)
          : input.pkg;
      const { versionId, digest } = await version(projectId, pkg, {
        qaStatus: input.qaStatus ?? "passed",
      });
      await pg.query(
        "UPDATE theme_studio_projects SET status='ready',current_version_id=$2 WHERE id=$1",
        [projectId, versionId],
      );
      if (input.acceptanceBuild !== null) {
        const id = randomUUID();
        const hex = createHash("sha256").update(id).digest("hex");
        await pg.query(
          `INSERT INTO theme_studio_acceptance_runs(id,project_id,version_id,package_digest,assets_digest,build_id,status,evidence_digest,created_by,created_by_email,completed_at)
           VALUES($1,$2,$3,$4,$5,$6,'passed',$5,$7,$8,now()-interval '1 day')`,
          [
            id,
            projectId,
            versionId,
            digest,
            hex,
            input.acceptanceBuild ?? "an-earlier-build",
            actor.id,
            actor.email,
          ],
        );
      }
      if (input.status && input.status !== "ready") {
        await pg.query(
          "UPDATE theme_studio_projects SET status=$2 WHERE id=$1",
          [projectId, input.status],
        );
      }
      return { projectId, versionId, digest, messageId, pkg };
    };

    let seed = 0;
    const complete: Ctx["complete"] = async (
      projectId,
      pkg,
      source = "operator-owned",
    ) => {
      const rows = new Map<string, SlotImageRow>();
      const replacements = [];
      for (const slot of describeSlots(pkg)) {
        const target = slotTargetSize(slot);
        if (!target) throw new Error(`no target for ${slot.id}`);
        const prepared = await prepareSlotImage(
          await solid(target.width, target.height, ++seed),
          target,
          slotByteLimit(slot),
        );
        if (!prepared.ok) throw new Error(prepared.code);
        const image = prepared.value;
        const [row] = (
          await pg.query(
            `INSERT INTO theme_studio_assets(project_id,purpose,media_type,bytes,byte_size,width,height,sha256,original_media_type,original_byte_size,created_by)
             VALUES($1,'image','image/webp',$2,$3,$4,$5,$6,'image/png',$7,$8)
             RETURNING id,purpose,sha256,width,height`,
            [
              projectId,
              image.bytes,
              image.bytes.byteLength,
              image.width,
              image.height,
              image.sha256,
              image.originalByteSize,
              actor.id,
            ],
          )
        ).rows;
        rows.set(row.id, row);
        replacements.push({
          slotId: slot.id,
          assetId: row.id as string,
          alt: (slot.alt.length >= 15
            ? slot.alt
            : `${slot.alt} on the storefront`
          ).slice(0, 200),
          // A drawn picture's source, cast past the operator-only type.
          source: source as "operator-owned",
          licenseNote: "Photographed for this theme by its owner.",
        });
      }
      const applied = applySlotReplacements(pkg, replacements, rows, 1);
      if (!applied.ok) throw new Error(applied.error);
      return applied.value;
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
          bytes: new Uint8Array(await solid(48, 96, 900 + index)),
        })),
      );
      const images = await Promise.all(
        claim.shots.map(async (shot, index) => ({
          slotId: shot.slotId,
          bytes: new Uint8Array(
            await solid(
              shot.viewport.width * shot.deviceScaleFactor,
              shot.viewport.height * shot.deviceScaleFactor,
              700 + index,
            ),
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
            html: '<html lang="en"><head><meta name="robots" content="noindex"></head><body><div class="storefront-root sm-themed-type">Theme</div></body></html>',
            robots: "noindex",
          })),
          evidence: { userAgent: "local integration", samples },
          screenshots,
        },
      });
    };

    openPreview.mockImplementation(
      async (_actor: unknown, input: { versionId: string }) => {
        const [row] = (
          await pg.query(
            "SELECT package_json FROM theme_studio_versions WHERE id=$1",
            [input.versionId],
          )
        ).rows;
        return {
          previewId: randomUUID(),
          storeId: randomUUID(),
          origin: "https://preview.example.test",
          enterToken: "unused",
          pages: previewPagesFor(row.package_json as ThemePackageV2),
          expiresAt: "2099-01-01 00:00:00+00",
        };
      },
    );

    const claim = async (projectId: string) => {
      const claimed = await claimThemeStudioCapture();
      if (claimed) {
        const owner = await one<{ project_id: string; name: string }>(
          "SELECT c.project_id, p.name FROM theme_studio_captures c JOIN theme_studio_projects p ON p.id = c.project_id WHERE c.id=$1",
          [claimed.captureId],
        );
        expect(
          owner.project_id,
          `claimed a capture of another project (${owner.name})`,
        ).toBe(projectId);
      }
      return claimed;
    };

    await work({
      pg,
      actor,
      one,
      count,
      revisionOf,
      project,
      version,
      complete,
      answer,
      claim,
    });
  } finally {
    await pg.query("ROLLBACK");
    await pg.end();
    vi.unstubAllEnvs();
  }
}

const passReview = () =>
  review.mockResolvedValue({
    kind: "ok",
    usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 },
    value: {
      verdict: "pass",
      scores: fives,
      rejections: [],
      findings: [],
      revisionBrief: null,
      repairs: [],
      imageAssessments: [],
    },
  });

/** A theme Ready to publish whose one picture was replaced by hand and then
 * checked end to end: the state the regression below asserts step by step. */
async function checkedPictureChange(ctx: Ctx) {
  const { pkg: placeholders } = await draft();
  const theme = await ctx.project({
    pkg: (projectId) => ctx.complete(projectId, placeholders),
    status: "candidate",
  });
  const slot = describeSlots(theme.pkg).find(
    (s) => !s.catalogPreview && !s.catalogScreenshot,
  )!;
  const upload = await slotUploadTarget(
    theme.projectId,
    theme.versionId,
    slot.id,
  );
  const prepared = await prepareSlotImage(
    await solid(upload!.target.width, upload!.target.height, 5151),
    upload!.target,
    upload!.byteLimit,
  );
  if (!prepared.ok) throw new Error(prepared.code);
  const stored = await storeThemeStudioSlotImage(ctx.actor, {
    projectId: theme.projectId,
    slotId: slot.id,
    image: prepared.value,
  });
  const saved = await replaceThemeStudioSlotImages(ctx.actor, {
    projectId: theme.projectId,
    versionId: theme.versionId,
    expectedRevision: await ctx.revisionOf(theme.projectId),
    expectedPackageDigest: theme.digest,
    replacements: [
      {
        slotId: slot.id,
        assetId: stored.id,
        alt: "A hand-thrown stoneware mug",
        source: "operator-owned",
        licenseNote: "Photographed by the merchant.",
      },
    ],
  });
  const edited = await ctx.one<{ package_json: ThemePackageV2 }>(
    "SELECT package_json FROM theme_studio_versions WHERE id=$1",
    [saved.versionId],
  );
  const finished = await ctx.answer(
    (await ctx.claim(theme.projectId))!,
    edited.package_json,
  );
  const checkedId = (finished as { versionId: string }).versionId;
  passReview();
  await runThemeStudioVisualQaWorker({ providers: ["fake"] });
  const acceptance = await ctx.one<{ id: string }>(
    "SELECT id FROM theme_studio_acceptance_runs WHERE version_id=$1",
    [checkedId],
  );
  expect(
    await ctx.one(
      "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
      [theme.projectId],
    ),
  ).toEqual({ status: "candidate", current_version_id: checkedId });
  return { theme, saved, checkedId, acceptanceId: acceptance.id };
}

/** The physical row: any UPDATE gives it a new ctid, so an unchanged ctid
 * proves the row was never written. */
const rowIdentity = (ctx: Ctx, table: string, id: string) =>
  ctx.one(`SELECT ctid::text AS ctid, * FROM ${table} WHERE id=$1`, [id]);

describe.skipIf(!ENABLED)("every change is checked (real database)", () => {
  it("replacing one picture on a theme that is Ready to publish reaches Ready to publish again, checked, with no chat message", async () => {
    await withRollback(async (ctx) => {
      const { pg, actor, one, count } = ctx;
      const { pkg: placeholders } = await draft();
      const theme = await ctx.project({
        pkg: (projectId) => ctx.complete(projectId, placeholders),
        status: "candidate",
      });
      const pkg = theme.pkg;
      const messages = () =>
        count(
          "SELECT count(*)::int AS n FROM theme_studio_messages WHERE project_id=$1",
          [theme.projectId],
        );
      const runs = () =>
        count(
          "SELECT count(*)::int AS n FROM theme_studio_runs WHERE project_id=$1",
          [theme.projectId],
        );
      const messagesBefore = await messages();
      const runsBefore = await runs();

      // The operator uploads one new picture for an art slot and saves it
      // with no alt text.
      const slot = describeSlots(pkg).find(
        (s) => !s.catalogPreview && !s.catalogScreenshot,
      )!;
      const upload = await slotUploadTarget(
        theme.projectId,
        theme.versionId,
        slot.id,
      );
      const prepared = await prepareSlotImage(
        await solid(upload!.target.width, upload!.target.height, 4242),
        upload!.target,
        upload!.byteLimit,
      );
      if (!prepared.ok) throw new Error(prepared.code);
      const stored = await storeThemeStudioSlotImage(actor, {
        projectId: theme.projectId,
        slotId: slot.id,
        image: prepared.value,
      });
      const saved = await replaceThemeStudioSlotImages(actor, {
        projectId: theme.projectId,
        versionId: theme.versionId,
        expectedRevision: await ctx.revisionOf(theme.projectId),
        expectedPackageDigest: theme.digest,
        replacements: [
          {
            slotId: slot.id,
            assetId: stored.id,
            alt: "   ",
            source: "operator-owned",
            licenseNote: "Photographed by the merchant.",
          },
        ],
      });
      expect(saved).toMatchObject({ versionNumber: 2, checking: true });

      // A hidden version at the repair ceiling, the theme checking it, the
      // version the operator saw still current.
      const edited = await one<Record<string, unknown>>(
        "SELECT origin,visibility,qa_status,qa_iteration,parent_version_id,package_json FROM theme_studio_versions WHERE id=$1",
        [saved.versionId],
      );
      expect(edited).toMatchObject({
        origin: "asset_edit",
        visibility: "internal",
        qa_status: "pending",
        qa_iteration: 3,
        parent_version_id: theme.versionId,
      });
      const editedAsset = (edited.package_json as ThemePackageV2).assets.find(
        (a) => a.id === slot.id,
      )!;
      // No alt text given: the slot's own description, never a licence note.
      expect(editedAsset.alt).toBe(slot.alt);
      expect(editedAsset.licenseNote).toBe("Photographed by the merchant.");
      expect(
        await one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [theme.projectId],
        ),
      ).toEqual({ status: "generating", current_version_id: theme.versionId });
      // Straight to the final check: no layout check, since only pictures
      // changed.
      expect(
        (
          await pg.query(
            "SELECT version_id,phase,automatic,qa_iteration,previous_status,idempotency_key FROM theme_studio_captures WHERE project_id=$1",
            [theme.projectId],
          )
        ).rows,
      ).toEqual([
        {
          version_id: saved.versionId,
          phase: "final",
          automatic: true,
          qa_iteration: 3,
          previous_status: "generating",
          idempotency_key: `auto_final_${saved.versionId}`,
        },
      ]);
      expect(
        (
          await pg.query(
            "SELECT event_type,detail FROM theme_studio_events WHERE project_id=$1 AND event_type IN ('slot_images_replaced','auto_qa_started','capture_requested') ORDER BY event_type",
            [theme.projectId],
          )
        ).rows,
      ).toMatchObject([
        { event_type: "auto_qa_started", detail: { qaIteration: 3 } },
        {
          event_type: "capture_requested",
          detail: { phase: "final", automatic: true, qaIteration: 3 },
        },
        {
          event_type: "slot_images_replaced",
          detail: {
            automaticQa: true,
            altFromSlot: 1,
            previousStatus: "candidate",
          },
        },
      ]);

      // The capture job photographs the edited storefront (new catalogue
      // pictures) and measures every page on today's build.
      const claim = await ctx.claim(theme.projectId);
      expect(claim?.qa).toMatchObject({ phase: "final", buildId: BUILD });
      expect(claim?.shots.map((s) => s.slotId)).toEqual(
        captureShots(edited.package_json as ThemePackageV2).map(
          (s) => s.slotId,
        ),
      );
      const finished = await ctx.answer(
        claim!,
        edited.package_json as ThemePackageV2,
      );
      expect(finished.status).toBe("succeeded");
      const checkedId = (finished as { versionId: string }).versionId;
      expect(checkedId).not.toBe(saved.versionId);
      const acceptance = await one<{ id: string; status: string }>(
        "SELECT id,status,server_report,browser_report FROM theme_studio_acceptance_runs WHERE version_id=$1",
        [checkedId],
      );
      expect(acceptance.status).toBe("passed");
      expect(
        await one(
          "SELECT version_id,qa_iteration,status,browser_report->>'acceptanceRunId' AS bound FROM theme_studio_visual_qa_runs WHERE project_id=$1 AND status='queued'",
          [theme.projectId],
        ),
      ).toEqual({
        version_id: checkedId,
        qa_iteration: 3,
        status: "queued",
        bound: acceptance.id,
      });

      // The design review passes: Ready to publish, on today's build.
      passReview();
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, passed: 1, revisionQueued: 0 });
      expect(review).toHaveBeenCalledOnce();
      expect(
        await one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [theme.projectId],
        ),
      ).toEqual({ status: "candidate", current_version_id: checkedId });
      expect(
        await one(
          "SELECT visibility,qa_status FROM theme_studio_versions WHERE id=$1",
          [checkedId],
        ),
      ).toEqual({ visibility: "operator", qa_status: "passed" });
      const actual =
        await vi.importActual<typeof import("./acceptance")>("./acceptance");
      expect(
        await service((db: never) =>
          actual.currentPublishEvidence(db, { projectId: theme.projectId }),
        ),
      ).toEqual({ ok: true, acceptanceRunId: acceptance.id });
      // Nothing was said in the chat, and nothing paid was queued.
      expect(await messages()).toBe(messagesBefore);
      expect(await runs()).toBe(runsBefore);
    });
  }, 120_000);

  it("a picture saved with a placeholder left, or with the checks off, becomes current at once as before", async () => {
    await withRollback(async (ctx) => {
      const { pkg: placeholders } = await draft();
      // A theme still full of placeholders: nothing to check yet.
      const early = await ctx.project({
        pkg: placeholders,
        qaStatus: "not_required",
      });
      const slot = describeSlots(placeholders).find(
        (s) => !s.catalogPreview && !s.catalogScreenshot,
      )!;
      const save = async (theme: {
        projectId: string;
        versionId: string;
        digest: string;
      }) => {
        const upload = await slotUploadTarget(
          theme.projectId,
          theme.versionId,
          slot.id,
        );
        const prepared = await prepareSlotImage(
          await solid(upload!.target.width, upload!.target.height, 6060),
          upload!.target,
          upload!.byteLimit,
        );
        if (!prepared.ok) throw new Error(prepared.code);
        const stored = await storeThemeStudioSlotImage(ctx.actor, {
          projectId: theme.projectId,
          slotId: slot.id,
          image: prepared.value,
        });
        return replaceThemeStudioSlotImages(ctx.actor, {
          projectId: theme.projectId,
          versionId: theme.versionId,
          expectedRevision: await ctx.revisionOf(theme.projectId),
          expectedPackageDigest: theme.digest,
          replacements: [
            {
              slotId: slot.id,
              assetId: stored.id,
              alt: "Stoneware on linen",
              source: "licensed",
              licenseNote: "Licensed from the photographer.",
            },
          ],
        });
      };
      const savedEarly = await save(early);
      expect(savedEarly).toMatchObject({ checking: false });
      expect(
        await ctx.one(
          "SELECT visibility,qa_status FROM theme_studio_versions WHERE id=$1",
          [savedEarly.versionId],
        ),
      ).toEqual({ visibility: "operator", qa_status: "not_required" });
      expect(
        await ctx.one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [early.projectId],
        ),
      ).toEqual({ status: "ready", current_version_id: savedEarly.versionId });
      expect(
        await ctx.count(
          "SELECT count(*)::int AS n FROM theme_studio_captures WHERE project_id=$1",
          [early.projectId],
        ),
      ).toBe(0);

      // A blank alt for a slot the version does not have is refused by
      // name, never saved with a stand-in.
      await expect(
        replaceThemeStudioSlotImages(ctx.actor, {
          projectId: early.projectId,
          versionId: savedEarly.versionId,
          expectedRevision: await ctx.revisionOf(early.projectId),
          expectedPackageDigest: (
            await ctx.one<{ package_digest: string }>(
              "SELECT package_digest FROM theme_studio_versions WHERE id=$1",
              [savedEarly.versionId],
            )
          ).package_digest,
          replacements: [
            {
              slotId: "no-such-slot",
              assetId: randomUUID(),
              alt: "",
              source: "licensed",
              licenseNote: "Licensed from the photographer.",
            },
          ],
        }),
      ).rejects.toThrow(/has no slot no-such-slot/);

      // With the automatic checks off (local development), as before.
      config.autoQaEnabled = false;
      const off = await ctx.project({
        pkg: (projectId) => ctx.complete(projectId, placeholders),
        status: "candidate",
      });
      const savedOff = await save(off);
      expect(savedOff).toMatchObject({ checking: false });
      expect(
        await ctx.one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [off.projectId],
        ),
      ).toEqual({ status: "ready", current_version_id: savedOff.versionId });
      expect(
        await ctx.count(
          "SELECT count(*)::int AS n FROM theme_studio_captures WHERE project_id=$1",
          [off.projectId],
        ),
      ).toBe(0);
    });
  }, 120_000);

  it("an operator's photo run is checked: hidden at the repair ceiling, its fill round automatic, then one final capture with no layout check", async () => {
    await withRollback(async (ctx) => {
      const { pkg: placeholders, intent } = await draft();
      const theme = await ctx.project({
        pkg: placeholders,
        qaStatus: "not_required",
      });
      const drawn = generatableSlots(placeholders, intent).map((s) => s.slotId);
      expect(drawn.length).toBeGreaterThan(1);
      const queued = await queueThemeStudioImages(ctx.actor, {
        projectId: theme.projectId,
        versionId: theme.versionId,
        expectedRevision: await ctx.revisionOf(theme.projectId),
        expectedPackageDigest: theme.digest,
        idempotencyKey: `images-${randomUUID()}`,
      });
      // One picture cannot be drawn this time.
      failing.briefId = drawn.at(-1)!;
      expect(
        await runThemeStudioWorker({
          maxRuns: 1,
          providers: ["fake"],
          skipVisualQa: true,
        }),
      ).toMatchObject({ claimed: 1, succeeded: 1 });
      const first = await ctx.one<Record<string, unknown>>(
        "SELECT id,visibility,qa_status,qa_iteration FROM theme_studio_versions WHERE run_id=$1",
        [queued.runId],
      );
      expect(first).toMatchObject({
        visibility: "internal",
        qa_status: "pending",
        qa_iteration: 3,
      });
      expect(
        await ctx.one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [theme.projectId],
        ),
      ).toEqual({ status: "generating", current_version_id: theme.versionId });
      // The round that fills it is the theme's own automatic work.
      const fill = await ctx.one<Record<string, unknown>>(
        "SELECT id,automatic,qa_iteration,image_slot_ids,base_version_id,idempotency_key FROM theme_studio_runs WHERE project_id=$1 AND status='queued'",
        [theme.projectId],
      );
      expect(fill).toMatchObject({
        automatic: true,
        qa_iteration: 3,
        image_slot_ids: [failing.briefId],
        base_version_id: first.id,
        idempotency_key: `images_fill_${queued.runId}_1`,
      });
      expect(
        await ctx.count(
          "SELECT count(*)::int AS n FROM theme_studio_captures WHERE project_id=$1",
          [theme.projectId],
        ),
      ).toBe(0);

      failing.briefId = null;
      expect(
        await runThemeStudioWorker({
          maxRuns: 1,
          providers: ["fake"],
          skipVisualQa: true,
        }),
      ).toMatchObject({ claimed: 1, succeeded: 1 });
      const filled = await ctx.one<Record<string, unknown>>(
        "SELECT id,visibility,qa_status,qa_iteration FROM theme_studio_versions WHERE run_id=$1",
        [fill.id],
      );
      expect(filled).toMatchObject({
        visibility: "internal",
        qa_status: "pending",
        qa_iteration: 3,
      });
      // Straight to the final check: only pictures changed.
      expect(
        (
          await ctx.pg.query(
            "SELECT version_id,phase,automatic,qa_iteration,idempotency_key FROM theme_studio_captures WHERE project_id=$1",
            [theme.projectId],
          )
        ).rows,
      ).toEqual([
        {
          version_id: filled.id,
          phase: "final",
          automatic: true,
          qa_iteration: 3,
          idempotency_key: `auto_final_${fill.id}`,
        },
      ]);
      expect(
        await ctx.one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [theme.projectId],
        ),
      ).toEqual({ status: "generating", current_version_id: theme.versionId });
      expect(
        (
          await ctx.pg.query(
            "SELECT detail FROM theme_studio_events WHERE project_id=$1 AND event_type='auto_qa_started'",
            [theme.projectId],
          )
        ).rows,
      ).toEqual([{ detail: { versionId: first.id, qaIteration: 3 } }]);

      // A redraw that leaves other placeholders has nothing to check yet: it
      // becomes current at once, as before.
      const partial = await ctx.project({
        pkg: placeholders,
        qaStatus: "not_required",
      });
      const redraw = await queueThemeStudioImages(ctx.actor, {
        projectId: partial.projectId,
        versionId: partial.versionId,
        expectedRevision: await ctx.revisionOf(partial.projectId),
        expectedPackageDigest: partial.digest,
        idempotencyKey: `redraw-${randomUUID()}`,
        slotIds: [drawn[0]],
      });
      expect(
        await runThemeStudioWorker({
          maxRuns: 1,
          providers: ["fake"],
          skipVisualQa: true,
        }),
      ).toMatchObject({ claimed: 1, succeeded: 1 });
      const redrawn = await ctx.one<Record<string, unknown>>(
        "SELECT id,visibility,qa_status FROM theme_studio_versions WHERE run_id=$1",
        [redraw.runId],
      );
      expect(redrawn).toMatchObject({
        visibility: "operator",
        qa_status: "not_required",
      });
      expect(
        await ctx.one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [partial.projectId],
        ),
      ).toEqual({ status: "ready", current_version_id: redrawn.id });

      // A redraw of a finished theme whose one picture comes back empty: the
      // round that tries it again is automatic, at the repair ceiling, on
      // the version the operator saw.
      const finished = await ctx.project({
        pkg: (projectId) => ctx.complete(projectId, placeholders, "generated"),
        qaStatus: "not_required",
      });
      failing.briefId = drawn[0];
      const empty = await queueThemeStudioImages(ctx.actor, {
        projectId: finished.projectId,
        versionId: finished.versionId,
        expectedRevision: await ctx.revisionOf(finished.projectId),
        expectedPackageDigest: finished.digest,
        idempotencyKey: `redraw-${randomUUID()}`,
        slotIds: [drawn[0]],
      });
      await runThemeStudioWorker({
        maxRuns: 1,
        providers: ["fake"],
        skipVisualQa: true,
      });
      expect(
        await ctx.one(
          "SELECT status,error_code FROM theme_studio_runs WHERE id=$1",
          [empty.runId],
        ),
      ).toEqual({ status: "failed", error_code: "images_none" });
      expect(
        await ctx.one(
          "SELECT automatic,qa_iteration,base_version_id,image_slot_ids FROM theme_studio_runs WHERE project_id=$1 AND status='queued'",
          [finished.projectId],
        ),
      ).toEqual({
        automatic: true,
        qa_iteration: 3,
        base_version_id: finished.versionId,
        image_slot_ids: [drawn[0]],
      });
      expect(
        await ctx.one("SELECT status FROM theme_studio_projects WHERE id=$1", [
          finished.projectId,
        ]),
      ).toEqual({ status: "generating" });
    });
  }, 120_000);

  it("a Retry keeps an automatic step's flags while the checks are on, and is the operator's own run with them off", async () => {
    await withRollback(async (ctx) => {
      const { pkg: placeholders } = await draft();
      const failedStep = async () => {
        const theme = await ctx.project({
          pkg: placeholders,
          qaStatus: "failed",
        });
        const messageId = randomUUID();
        const runId = randomUUID();
        await ctx.pg.query(
          "INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by) VALUES($1,$2,'images','Automatically generate images',$3)",
          [messageId, theme.projectId, ctx.actor.id],
        );
        await ctx.pg.query(
          `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,max_attempts,base_version_id,base_package_digest,automatic,qa_iteration,status,error_code,finished_at,created_by)
           VALUES($1,$2,$3,'images','fake','gemini-3.8-flash','fake','theme-studio-image-fake-v1',$4,3,$5,$6,true,2,'failed','images_none',now(),$7)`,
          [
            runId,
            theme.projectId,
            messageId,
            `auto_images_${randomUUID()}`,
            theme.versionId,
            theme.digest,
            ctx.actor.id,
          ],
        );
        return { ...theme, runId };
      };
      const on = await failedStep();
      const retried = await retryThemeStudioRun(ctx.actor, {
        projectId: on.projectId,
        runId: on.runId,
        idempotencyKey: `retry-${randomUUID()}`,
      });
      expect(
        await ctx.one(
          "SELECT automatic,qa_iteration,retry_of_run_id,status FROM theme_studio_runs WHERE id=$1",
          [retried.runId],
        ),
      ).toEqual({
        automatic: true,
        qa_iteration: 2,
        retry_of_run_id: on.runId,
        status: "queued",
      });
      expect(
        (
          await ctx.one<{ detail: Record<string, unknown> }>(
            "SELECT detail FROM theme_studio_events WHERE project_id=$1 AND event_type='run_retried'",
            [on.projectId],
          )
        ).detail,
      ).toEqual({ retryOfRunId: on.runId, automatic: true, qaIteration: 2 });

      config.autoQaEnabled = false;
      const off = await failedStep();
      const manual = await retryThemeStudioRun(ctx.actor, {
        projectId: off.projectId,
        runId: off.runId,
        idempotencyKey: `retry-${randomUUID()}`,
      });
      expect(
        await ctx.one(
          "SELECT automatic,qa_iteration FROM theme_studio_runs WHERE id=$1",
          [manual.runId],
        ),
      ).toEqual({ automatic: false, qa_iteration: 0 });
    });
  }, 120_000);

  it("the concurrency cap counts only work the operator started", async () => {
    await withRollback(async (ctx) => {
      const { pkg: placeholders } = await draft();
      const queueRun = async (input: {
        automatic: boolean;
        key?: string;
        retryOf?: string;
      }) => {
        const theme = await ctx.project({
          pkg: placeholders,
          qaStatus: "not_required",
        });
        const messageId = randomUUID();
        const runId = randomUUID();
        await ctx.pg.query(
          "INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by) VALUES($1,$2,'images','Draw',$3)",
          [messageId, theme.projectId, ctx.actor.id],
        );
        await ctx.pg.query(
          `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,max_attempts,base_version_id,base_package_digest,automatic,qa_iteration,retry_of_run_id,created_by)
           VALUES($1,$2,$3,'images','fake','gemini-3.8-flash','fake','theme-studio-image-fake-v1',$4,3,$5,$6,$7,$8,$9,$10)`,
          [
            runId,
            theme.projectId,
            messageId,
            input.key ?? `cap_${randomUUID()}`,
            theme.versionId,
            theme.digest,
            input.automatic,
            input.automatic ? 3 : 0,
            input.retryOf ?? null,
            ctx.actor.id,
          ],
        );
        await ctx.pg.query(
          "UPDATE theme_studio_projects SET status='generating' WHERE id=$1",
          [theme.projectId],
        );
        return runId;
      };
      const ask = async () => {
        const theme = await ctx.project({
          pkg: placeholders,
          qaStatus: "not_required",
        });
        return queueThemeStudioImages(ctx.actor, {
          projectId: theme.projectId,
          versionId: theme.versionId,
          expectedRevision: await ctx.revisionOf(theme.projectId),
          expectedPackageDigest: theme.digest,
          idempotencyKey: `cap-ask-${randomUUID()}`,
        });
      };
      // Two themes drawing their own photos and two rounds filling an
      // operator's photo run: none of it was started by the operator, and
      // any two of them would reach the cap of two.
      await queueRun({ automatic: true });
      await queueRun({ automatic: true });
      await queueRun({
        automatic: false,
        key: `images_fill_${randomUUID()}_1`,
      });
      await queueRun({
        automatic: false,
        key: `images_fill_${randomUUID()}_2`,
      });
      const first = await ask();
      expect(first.runId).toBeTruthy();
      // A Retry is the operator's, even of an automatic step: with the photo
      // run above, two.
      await queueRun({ automatic: true, retryOf: first.runId });
      await expect(ask()).rejects.toMatchObject({ code: "limit" });
    });
  }, 120_000);

  it("a blocked theme with no open questions can be revised; open questions are answered or set aside first", async () => {
    await withRollback(async (ctx) => {
      const { pkg: placeholders } = await draft();
      const revise = async (theme: {
        projectId: string;
        versionId: string;
        digest: string;
      }) =>
        reviseThemeStudioVersion(ctx.actor, {
          projectId: theme.projectId,
          versionId: theme.versionId,
          expectedRevision: await ctx.revisionOf(theme.projectId),
          expectedPackageDigest: theme.digest,
          body: "Make the hero calmer.",
          idempotencyKey: `revise-${randomUUID()}`,
        });
      // Blocked by its checks (a security finding): revisable.
      const security = await ctx.project({
        pkg: placeholders,
        qaStatus: "failed",
        status: "blocked",
      });
      const revised = await revise(security);
      expect(
        await ctx.one(
          "SELECT kind,status,base_version_id FROM theme_studio_runs WHERE id=$1",
          [revised.runId],
        ),
      ).toEqual({
        kind: "revise",
        status: "queued",
        base_version_id: security.versionId,
      });
      expect(
        await ctx.one("SELECT status FROM theme_studio_projects WHERE id=$1", [
          security.projectId,
        ]),
      ).toEqual({ status: "generating" });

      // Blocked by the model's questions: answer them first.
      const asked = await ctx.project({
        pkg: placeholders,
        qaStatus: "not_required",
        status: "blocked",
      });
      await ctx.pg.query(
        `INSERT INTO theme_studio_runs(project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,finished_at,outcome_detail,created_by)
         VALUES($1,$2,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$3,'succeeded',now(),$4,$5)`,
        [
          asked.projectId,
          asked.messageId,
          `asked_${randomUUID()}`,
          JSON.stringify({ kind: "clarify", questions: ["What do you sell?"] }),
          ctx.actor.id,
        ],
      );
      await expect(revise(asked)).rejects.toMatchObject({
        code: "illegal_state",
        message: expect.stringMatching(/Answer the questions first/),
      });
      // Questions set aside by making a version current, then blocked by a
      // later check: revisable again.
      await ctx.pg.query(
        "INSERT INTO theme_studio_events(project_id,actor_kind,event_type,detail) VALUES($1,'worker','version_restored','{}')",
        [asked.projectId],
      );
      expect((await revise(asked)).runId).toBeTruthy();
    });
  }, 120_000);

  it("Make current is never a dead end: Ready to publish at once, a re-check in place, or the check on a new version", async () => {
    await withRollback(async (ctx) => {
      const { theme, checkedId, acceptanceId } =
        await checkedPictureChange(ctx);
      const status = () =>
        ctx.one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [theme.projectId],
        );
      const make = async (versionId: string) =>
        restoreThemeStudioVersion(ctx.actor, {
          projectId: theme.projectId,
          versionId,
          expectedRevision: await ctx.revisionOf(theme.projectId),
        });

      // The first version passed, but on an earlier build: it is measured
      // again in place on today's build, and its row is never written.
      const firstRow = await rowIdentity(
        ctx,
        "theme_studio_versions",
        theme.versionId,
      );
      expect(await make(theme.versionId)).toEqual({
        changed: true,
        outcome: "rechecking",
      });
      expect(await status()).toEqual({
        status: "generating",
        current_version_id: theme.versionId,
      });
      const recheck = await ctx.one<Record<string, unknown>>(
        "SELECT version_id,phase,automatic,qa_iteration,previous_status,idempotency_key FROM theme_studio_captures WHERE project_id=$1 AND status='queued'",
        [theme.projectId],
      );
      expect(recheck).toMatchObject({
        version_id: theme.versionId,
        phase: "final",
        automatic: true,
        qa_iteration: 3,
        previous_status: "generating",
      });
      expect(recheckReasonOf(recheck.idempotency_key as string)).toBe(
        "check_again",
      );
      expect((await ctx.claim(theme.projectId))?.shots).toEqual([]);
      expect(
        await rowIdentity(ctx, "theme_studio_versions", theme.versionId),
      ).toEqual(firstRow);
      await stopThemeStudioChecks(ctx.actor, {
        projectId: theme.projectId,
        expectedRevision: await ctx.revisionOf(theme.projectId),
      });
      expect(await status()).toEqual({
        status: "ready",
        current_version_id: theme.versionId,
      });

      // The checked version: its evidence still holds on today's build, so it
      // is Ready to publish at once (ready, then candidate).
      expect(await make(checkedId)).toEqual({
        changed: true,
        outcome: "ready_to_publish",
      });
      expect(await status()).toEqual({
        status: "candidate",
        current_version_id: checkedId,
      });
      expect(
        (
          await ctx.one<{ detail: Record<string, unknown> }>(
            "SELECT detail FROM theme_studio_events WHERE project_id=$1 AND event_type='version_restored' AND detail->>'versionId'=$2",
            [theme.projectId, checkedId],
          )
        ).detail,
      ).toMatchObject({
        outcome: "ready_to_publish",
        acceptanceRunId: acceptanceId,
      });
      // Making the current version current again changes nothing.
      expect(await make(checkedId)).toEqual({
        changed: false,
        outcome: "ready_to_publish",
      });

      // A version that never passed is checked on a new hidden version.
      const { pkg: placeholders } = await draft();
      const failed = await ctx.version(theme.projectId, theme.pkg, {
        qaStatus: "failed",
      });
      evidence.mockClear();
      expect(await make(failed.versionId)).toEqual({
        changed: true,
        outcome: "checking",
      });
      expect(evidence).not.toHaveBeenCalled();
      const claim = await ctx.claim(theme.projectId);
      expect(claim?.shots.length).toBeGreaterThan(0);
      await stopThemeStudioChecks(ctx.actor, {
        projectId: theme.projectId,
        expectedRevision: await ctx.revisionOf(theme.projectId),
      });

      // A version with a placeholder left has nothing to check yet.
      const early = await ctx.version(theme.projectId, placeholders, {
        qaStatus: "not_required",
      });
      expect(await make(early.versionId)).toEqual({
        changed: true,
        outcome: "ready",
      });
      expect(await status()).toEqual({
        status: "ready",
        current_version_id: early.versionId,
      });
      expect(
        await ctx.count(
          "SELECT count(*)::int AS n FROM theme_studio_captures WHERE project_id=$1 AND status IN ('queued','running')",
          [theme.projectId],
        ),
      ).toBe(0);

      // A hidden version is part of a check.
      const hidden = await ctx.version(theme.projectId, theme.pkg, {
        visibility: "internal",
      });
      await expect(make(hidden.versionId)).rejects.toMatchObject({
        code: "illegal_state",
        message: expect.stringMatching(/part of a check/),
      });

      // With the checks off (local development), as before: ready.
      config.autoQaEnabled = false;
      evidence.mockClear();
      expect(await make(checkedId)).toEqual({
        changed: true,
        outcome: "ready",
      });
      expect(evidence).not.toHaveBeenCalled();
      expect(await status()).toEqual({
        status: "ready",
        current_version_id: checkedId,
      });
    });
  }, 120_000);

  it("cancelling a queued automatic step shows the hidden version it was building", async () => {
    await withRollback(async (ctx) => {
      const { pkg: placeholders } = await draft();
      const theme = await ctx.project({
        pkg: placeholders,
        qaStatus: "not_required",
      });
      const hidden = await ctx.version(theme.projectId, placeholders, {
        visibility: "internal",
      });
      const queue = async (
        automatic: boolean,
        base: string,
        digest: string,
      ) => {
        const messageId = randomUUID();
        const runId = randomUUID();
        await ctx.pg.query(
          "INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by) VALUES($1,$2,'images','Draw',$3)",
          [messageId, theme.projectId, ctx.actor.id],
        );
        await ctx.pg.query(
          `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,max_attempts,base_version_id,base_package_digest,automatic,qa_iteration,created_by)
           VALUES($1,$2,$3,'images','fake','gemini-3.8-flash','fake','theme-studio-image-fake-v1',$4,3,$5,$6,$7,$8,$9)`,
          [
            runId,
            theme.projectId,
            messageId,
            `cancel_${randomUUID()}`,
            base,
            digest,
            automatic,
            automatic ? 3 : 0,
            ctx.actor.id,
          ],
        );
        await ctx.pg.query(
          "UPDATE theme_studio_projects SET status='generating' WHERE id=$1",
          [theme.projectId],
        );
        return runId;
      };
      const step = await queue(true, hidden.versionId, hidden.digest);
      expect(
        await cancelThemeStudioRun(ctx.actor, {
          projectId: theme.projectId,
          runId: step,
        }),
      ).toEqual({ status: "cancelled" });
      expect(
        await ctx.one(
          "SELECT visibility,qa_status FROM theme_studio_versions WHERE id=$1",
          [hidden.versionId],
        ),
      ).toEqual({ visibility: "operator", qa_status: "failed" });
      expect(
        await ctx.one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [theme.projectId],
        ),
      ).toEqual({ status: "ready", current_version_id: hidden.versionId });
      expect(
        (
          await ctx.one<{ detail: Record<string, unknown> }>(
            "SELECT detail FROM theme_studio_events WHERE project_id=$1 AND event_type='auto_qa_failed'",
            [theme.projectId],
          )
        ).detail,
      ).toEqual({ versionId: hidden.versionId, errorCode: "cancelled" });

      // An operator's own queued run leaves the version it would change as
      // it is.
      const before = await rowIdentity(
        ctx,
        "theme_studio_versions",
        theme.versionId,
      );
      const own = await queue(false, theme.versionId, theme.digest);
      await cancelThemeStudioRun(ctx.actor, {
        projectId: theme.projectId,
        runId: own,
      });
      expect(
        await rowIdentity(ctx, "theme_studio_versions", theme.versionId),
      ).toEqual(before);
      expect(
        await ctx.one(
          "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
          [theme.projectId],
        ),
      ).toEqual({ status: "ready", current_version_id: hidden.versionId });
    });
  }, 120_000);
});
