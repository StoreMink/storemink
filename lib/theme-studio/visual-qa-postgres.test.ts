// Opt-in local PostgreSQL regression for the design review (Theme Studio
// TS-1B): the stall bug and the design-review half of the re-check contract.
// Every fixture, DDL and worker write rolls back. Previews are stubbed and
// the reviewer answers from a stub: no network, no model call, nothing paid.
import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import sharp from "sharp";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import {
  gate,
  GATE_LABELS,
  THEME_STUDIO_QA_VIEWPORTS,
  type BrowserSample,
  type GateId,
  type GateResult,
} from "./acceptance-gates";
import type { ThemeIntent, ThemePackageV2 } from "./contracts";

const { service, review, openPreview, verify } = vi.hoisted(() => ({
  service: vi.fn(),
  review: vi.fn(),
  openPreview: vi.fn(),
  verify: vi.fn(),
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
// The design reviewer is the offline client; each test says what it answers.
vi.mock("./fake-provider", async (original) => ({
  ...(await original<typeof import("./fake-provider")>()),
  createFakeModelClient: () => ({ provider: "fake", generate: review }),
}));
// The read-only evidence verifier (assets and digests) has its own tests; the
// database's own guard (migration 0151) still refuses a candidate without a
// passed check run over the exact package.
vi.mock("./acceptance", async (original) => ({
  ...(await original<typeof import("./acceptance")>()),
  verifyCandidateEvidenceWithDb: verify,
}));
// TS-3A: the operator's notice (builder 3B's notify.ts) is sent after each
// settlement commits; here it only records what would be sent, so no
// notification or email worker runs inside the rolled-back transaction.
const { notice, checkPhotos } = vi.hoisted(() => ({
  notice: vi.fn(async () => {}),
  checkPhotos: vi.fn(async () => "passed"),
}));
vi.mock("./notify", () => ({ sendThemeStudioNotice: notice }));
// Builder 3B's photo check (image-recovery.ts): each test says what it
// answers; nothing is checked or paid for.
vi.mock("./image-recovery", async (original) => ({
  ...(await original<typeof import("./image-recovery")>()),
  checkUncheckedPhotos: checkPhotos,
}));
import {
  DESIGN_REVIEW_CAP,
  PHOTO_CHECK_INLINE_MS,
  STOPPED_REVIEW_HOLDS_SLOT_MS,
  logThemeStudioQaWaiting,
  runThemeStudioVisualQaWorker,
} from "./visual-qa";
import { THEME_STUDIO_STOP_CODE } from "./stop";
import { operatorImagePackage } from "./_test-helpers";
import {
  claimThemeStudioCapture,
  finishThemeStudioCapture,
  queueThemeStudioCapture,
} from "./capture";
import { previewPagesFor } from "./preview";
import { currentAcceptanceBuildId } from "./acceptance";
import { runThemeGeneration } from "./pipeline";
import { digestThemeStudioJson } from "./repository";

const ENABLED = process.env.THEME_STUDIO_RECOVERY_DB_TEST === "1";

const LAYOUT_GATES: GateId[] = [
  "browser.coverage",
  "browser.overflow",
  "browser.clipped_text",
  "browser.tap_targets",
  "browser.image_crops",
  "browser.accessibility",
  "browser.media",
  "browser.performance",
];

/** Every gate passing, performance advisory, as a real passing run stores. */
function passingGates(
  ids: readonly GateId[] = Object.keys(GATE_LABELS) as GateId[],
) {
  return ids.map((id) =>
    gate(id, [], { required: id !== "browser.performance" }),
  );
}

/** A layout check that could not measure every page: never a pass, and no
 * revision can fix it, so the review stops and shows the theme. */
function unmeasuredLayout(): GateResult[] {
  return passingGates(LAYOUT_GATES).map((g) =>
    g.id === "browser.coverage"
      ? gate("browser.coverage", [
          {
            code: "missing",
            message: "Not measured.",
            where: "phone360 · home",
          },
        ])
      : g,
  );
}

async function draftPackage() {
  const actual =
    await vi.importActual<typeof import("./fake-provider")>("./fake-provider");
  const facts = {
    name: "Review DB",
    themeId: "review-db",
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
  return { pkg: outcome.package, intent: outcome.intent };
}

interface Seeded {
  projectId: string;
  versionId: string;
  packageDigest: string;
}

/**
 * One rolled-back transaction per test. The code under test runs as
 * app_service inside a savepoint per `withService` call, so a statement the
 * database refuses rolls back only that call, as a real transaction would.
 */
async function withRollback(
  work: (ctx: {
    pg: Client;
    operator: { id: string; email: string };
    draft: { pkg: ThemePackageV2; intent: ThemeIntent };
    seed: (input: {
      status: string;
      visibility: "internal" | "operator";
      qaStatus: "pending" | "passed" | "failed";
      pkg?: ThemePackageV2;
    }) => Promise<Seeded>;
    insertQa: (
      seeded: Seeded,
      input: {
        browserReport: Record<string, unknown>;
        qaIteration?: number;
        screenshotAssetIds?: string[];
      },
    ) => Promise<string>;
    count: (sql: string, args: unknown[]) => Promise<number>;
  }) => Promise<void>,
) {
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "local-review-regression-only");
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
    const operator = {
      id: randomUUID(),
      email: `${randomUUID()}@review.test`,
    };
    await pg.query(
      "INSERT INTO platform_admins(id,email,role) VALUES($1,$2,'superadmin')",
      [operator.id, operator.email],
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
    const draft = await draftPackage();
    let projects = 0;
    const seed = async (input: {
      status: string;
      visibility: "internal" | "operator";
      qaStatus: "pending" | "passed" | "failed";
      pkg?: ThemePackageV2;
    }): Promise<Seeded> => {
      const projectId = randomUUID(),
        messageId = randomUUID(),
        runId = randomUUID(),
        versionId = randomUUID();
      const pkg = input.pkg ?? draft.pkg;
      const packageDigest = digestThemeStudioJson(pkg);
      await pg.query(
        `INSERT INTO theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by,created_by_email)
         VALUES($1,$2,$3,'generating','{home}','{small}','gemini-3.8-flash','A calm ceramics shop',$4,$5)`,
        [
          projectId,
          `review-${projectId}`,
          `Review ${++projects}`,
          operator.id,
          operator.email,
        ],
      );
      await pg.query(
        "INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by) VALUES($1,$2,'brief','A calm ceramics shop',$3)",
        [messageId, projectId, operator.id],
      );
      await pg.query(
        `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,created_by,status,finished_at)
         VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$4,$5,'succeeded',now())`,
        [runId, projectId, messageId, `review_${runId}`, operator.id],
      );
      await pg.query(
        `INSERT INTO theme_studio_versions(id,project_id,run_id,version_number,intent_json,intent_digest,package_json,package_digest,visibility,qa_status)
         VALUES($1,$2,$3,1,$4,$5,$6,$7,'internal','pending')`,
        [
          versionId,
          projectId,
          runId,
          JSON.stringify(draft.intent),
          digestThemeStudioJson(draft.intent),
          JSON.stringify(pkg),
          packageDigest,
        ],
      );
      // The only legal reveal (migration 0144): hidden and pending, once.
      if (input.visibility === "operator")
        await pg.query(
          "UPDATE theme_studio_versions SET visibility='operator',qa_status=$2 WHERE id=$1",
          [versionId, input.qaStatus],
        );
      if (input.status !== "generating") {
        await pg.query(
          "UPDATE theme_studio_projects SET status='ready',current_version_id=$2,revision=revision+1 WHERE id=$1",
          [projectId, versionId],
        );
        if (input.status !== "ready")
          await pg.query(
            "UPDATE theme_studio_projects SET status=$2 WHERE id=$1",
            [projectId, input.status],
          );
      }
      return { projectId, versionId, packageDigest };
    };
    const insertQa = async (
      seeded: Seeded,
      input: {
        browserReport: Record<string, unknown>;
        qaIteration?: number;
        screenshotAssetIds?: string[];
      },
    ) => {
      const id = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_visual_qa_runs(id,project_id,version_id,package_digest,qa_iteration,browser_report,screenshot_asset_ids,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          seeded.projectId,
          seeded.versionId,
          seeded.packageDigest,
          input.qaIteration ?? 0,
          JSON.stringify(input.browserReport),
          input.screenshotAssetIds ?? [],
          operator.id,
        ],
      );
      return id;
    };
    const count = async (sql: string, args: unknown[]) =>
      Number((await pg.query(sql, args)).rows[0].n);
    await work({ pg, operator, draft, seed, insertQa, count });
  } finally {
    await pg.query("ROLLBACK");
    await pg.end();
    vi.unstubAllEnvs();
  }
}

const layoutReport = (gates: GateResult[]) => ({
  phase: "layout",
  buildId: currentAcceptanceBuildId(),
  evidence: { userAgent: "local integration", samples: [] },
  gates,
});

/** The row's physical identity changes on any UPDATE, so an unchanged ctid
 * proves the version row was never written. */
async function versionRow(pg: Client, id: string) {
  return (
    await pg.query(
      "SELECT visibility,qa_status,ctid::text AS ctid FROM theme_studio_versions WHERE id=$1",
      [id],
    )
  ).rows[0];
}

async function projectRow(pg: Client, id: string) {
  return (
    await pg.query(
      "SELECT status,current_version_id FROM theme_studio_projects WHERE id=$1",
      [id],
    )
  ).rows[0];
}

describe.skipIf(!ENABLED)("design review against the real database", () => {
  it("a failed version with a placeholder, retried, whose layout check fails, ends ready and leaves the queue claimable", async () => {
    await withRollback(async ({ pg, operator, seed, insertQa }) => {
      // The failed version an operator retries: visible, failed, and still
      // carrying placeholder artwork, so the retry starts at the layout check.
      const failed = await seed({
        status: "ready",
        visibility: "operator",
        qaStatus: "failed",
      });
      const before = await versionRow(pg, failed.versionId);
      const [{ revision }] = (
        await pg.query(
          "SELECT revision FROM theme_studio_projects WHERE id=$1",
          [failed.projectId],
        )
      ).rows;
      await queueThemeStudioCapture(operator, {
        projectId: failed.projectId,
        versionId: failed.versionId,
        expectedRevision: revision,
        expectedPackageDigest: failed.packageDigest,
        idempotencyKey: `retry_${randomUUID()}`,
      });
      const [capture] = (
        await pg.query(
          "SELECT version_id,phase FROM theme_studio_captures WHERE project_id=$1 AND status='queued'",
          [failed.projectId],
        )
      ).rows;
      expect(capture.phase).toBe("layout");
      const [measured] = (
        await pg.query(
          "SELECT package_json FROM theme_studio_versions WHERE id=$1",
          [capture.version_id],
        )
      ).rows;
      const pages = previewPagesFor(measured.package_json as ThemePackageV2);
      openPreview.mockResolvedValue({
        origin: "https://preview.example.test",
        storeId: randomUUID(),
        pages,
      });
      const claim = await claimThemeStudioCapture();
      expect(claim?.qa?.phase).toBe("layout");
      // The layout check fails: the phone home page was never measured.
      const samples: BrowserSample[] = Object.entries(
        THEME_STUDIO_QA_VIEWPORTS,
      ).flatMap(([viewport, size]) =>
        pages
          .filter(
            (page) => !(viewport === "phone360" && page.surface === "home"),
          )
          .map((page) => ({
            viewport: viewport as BrowserSample["viewport"],
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
      // ★ TS-3A: the layout check needs no model call, so the capture's own
      // finish settles it (nothing is left for the review route, which the
      // answer says by naming no waiting review). Before the stall fix the
      // version update raised inside settlement, the run was retried until
      // worn out, and then every claim raised for good.
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
      ).toEqual({ status: "succeeded", versionId: capture.version_id });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 0 });
      expect(review).not.toHaveBeenCalled();
      // The theme stopped: its operator hears it, once the finish committed.
      expect(notice).toHaveBeenCalledWith({
        projectId: failed.projectId,
        kind: "needs_fix",
      });
      expect(await projectRow(pg, failed.projectId)).toEqual({
        status: "ready",
        current_version_id: capture.version_id,
      });
      // The version the operator saw is never rewritten (the 0144 guard).
      expect(await versionRow(pg, failed.versionId)).toEqual(before);
      expect(
        (
          await pg.query(
            "SELECT status,error_code FROM theme_studio_visual_qa_runs WHERE project_id=$1",
            [failed.projectId],
          )
        ).rows,
      ).toEqual([{ status: "failed", error_code: "checks_incomplete" }]);

      // The queue stays claimable: the next project's review is taken at once.
      const next = await seed({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      const nextQa = await insertQa(next, {
        browserReport: layoutReport(unmeasuredLayout()),
      });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, failed: 1 });
      expect(
        (
          await pg.query(
            "SELECT status FROM theme_studio_visual_qa_runs WHERE id=$1",
            [nextQa],
          )
        ).rows[0].status,
      ).toBe("failed");
      expect(await versionRow(pg, next.versionId)).toMatchObject({
        visibility: "operator",
        qa_status: "failed",
      });
    });
  }, 60_000);

  it("a worn-out review of a visible version is closed in the claim step and the next review is still claimed", async () => {
    await withRollback(async ({ pg, seed, insertQa }) => {
      // A re-check of a theme the operator already sees, whose lease ran out
      // after its last attempt.
      const visible = await seed({
        status: "ready",
        visibility: "operator",
        qaStatus: "passed",
      });
      await pg.query(
        "UPDATE theme_studio_projects SET status='generating' WHERE id=$1",
        [visible.projectId],
      );
      const before = await versionRow(pg, visible.versionId);
      const worn = await insertQa(visible, {
        browserReport: layoutReport(unmeasuredLayout()),
        qaIteration: 3,
      });
      await pg.query(
        "UPDATE theme_studio_visual_qa_runs SET status='running',attempt_count=max_attempts,lease_owner=$2,lease_expires_at=now()-interval '1 minute',started_at=now()-interval '20 minutes' WHERE id=$1",
        [worn, randomUUID()],
      );
      const healthy = await seed({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      const healthyQa = await insertQa(healthy, {
        browserReport: layoutReport(unmeasuredLayout()),
      });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, failed: 1 });
      const qaRow = async (id: string) =>
        (
          await pg.query(
            "SELECT status,error_code,lease_owner FROM theme_studio_visual_qa_runs WHERE id=$1",
            [id],
          )
        ).rows[0];
      expect(await qaRow(worn)).toEqual({
        status: "failed",
        error_code: "qa_lease_expired",
        lease_owner: null,
      });
      expect(await qaRow(healthyQa)).toEqual({
        status: "failed",
        error_code: "checks_incomplete",
        lease_owner: null,
      });
      expect(await projectRow(pg, visible.projectId)).toEqual({
        status: "ready",
        current_version_id: visible.versionId,
      });
      expect(await versionRow(pg, visible.versionId)).toEqual(before);
    });
  }, 60_000);

  it("a worn-out row whose settlement keeps failing is closed on its own, and the rest of the queue is still claimed", async () => {
    await withRollback(async ({ pg, seed, insertQa, count }) => {
      const stuck = await seed({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      // Make this one project refuse every write, whatever the reason.
      await pg.query(
        `CREATE FUNCTION public.ts1b_refuse_project() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.id = '${stuck.projectId}'::uuid THEN
             RAISE EXCEPTION 'test: this project refuses every write';
           END IF;
           RETURN NEW;
         END $$`,
      );
      await pg.query(
        "CREATE TRIGGER ts1b_refuse_project BEFORE UPDATE ON theme_studio_projects FOR EACH ROW EXECUTE FUNCTION public.ts1b_refuse_project()",
      );
      const worn = await insertQa(stuck, {
        browserReport: layoutReport(unmeasuredLayout()),
      });
      await pg.query(
        "UPDATE theme_studio_visual_qa_runs SET status='running',attempt_count=max_attempts,lease_owner=$2,lease_expires_at=now()-interval '1 minute',started_at=now()-interval '20 minutes' WHERE id=$1",
        [worn, randomUUID()],
      );
      const healthy = await seed({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      const healthyQa = await insertQa(healthy, {
        browserReport: layoutReport(unmeasuredLayout()),
      });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, failed: 1 });
      // The bad row is closed without touching its project (Stop recovers
      // it); the other project's review was claimed and settled.
      expect(
        (
          await pg.query(
            "SELECT status,error_code,lease_owner FROM theme_studio_visual_qa_runs WHERE id=$1",
            [worn],
          )
        ).rows[0],
      ).toEqual({
        status: "failed",
        error_code: "qa_lease_expired",
        lease_owner: null,
      });
      expect((await projectRow(pg, stuck.projectId)).status).toBe("generating");
      expect(
        (
          await pg.query(
            "SELECT status FROM theme_studio_visual_qa_runs WHERE id=$1",
            [healthyQa],
          )
        ).rows[0].status,
      ).toBe("failed");
      expect((await projectRow(pg, healthy.projectId)).status).toBe("ready");
      // And the claim step does not trip on it again.
      expect(
        await count(
          "SELECT count(*)::int AS n FROM theme_studio_visual_qa_runs WHERE project_id=$1 AND status IN ('queued','running')",
          [stuck.projectId],
        ),
      ).toBe(0);
      await pg.query(
        "DROP TRIGGER ts1b_refuse_project ON theme_studio_projects",
      );
    });
  }, 60_000);

  it("a worn-out row whose settlement only timed out is left for the next claim, which reveals its version", async () => {
    await withRollback(async ({ pg, seed, insertQa }) => {
      const waiting = await seed({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      // Every write to this one project first waits for a lock another
      // session holds, as a long capture finish would hold its row.
      const key = `ts1-fix:${waiting.projectId}`;
      await pg.query(
        `CREATE FUNCTION public.ts1fix_wait_project() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.id = '${waiting.projectId}'::uuid THEN
             PERFORM pg_advisory_xact_lock(hashtext('${key}'));
           END IF;
           RETURN NEW;
         END $$`,
      );
      await pg.query(
        "CREATE TRIGGER ts1fix_wait_project BEFORE UPDATE ON theme_studio_projects FOR EACH ROW EXECUTE FUNCTION public.ts1fix_wait_project()",
      );
      const worn = await insertQa(waiting, {
        browserReport: layoutReport(unmeasuredLayout()),
      });
      await pg.query(
        "UPDATE theme_studio_visual_qa_runs SET status='running',attempt_count=max_attempts,lease_owner=$2,lease_expires_at=now()-interval '1 minute',started_at=now()-interval '20 minutes' WHERE id=$1",
        [worn, randomUUID()],
      );
      const healthy = await seed({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      const healthyQa = await insertQa(healthy, {
        browserReport: layoutReport(unmeasuredLayout()),
      });
      const holder = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: "postgres",
        password: process.env.DB_ADMIN_PASSWORD,
        connectionTimeoutMillis: 5000,
      });
      await holder.connect();
      const qaRow = async (id: string) =>
        (
          await pg.query(
            "SELECT status,error_code,attempt_count=max_attempts AS worn_out FROM theme_studio_visual_qa_runs WHERE id=$1",
            [id],
          )
        ).rows[0];
      try {
        await holder.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
        await pg.query("SET LOCAL lock_timeout = '300ms'");
        // The settlement times out (55P03): the row is left as it was and
        // the next review in the queue is claimed and settled.
        expect(
          await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
        ).toMatchObject({ claimed: 1, failed: 1 });
        expect(await qaRow(worn)).toEqual({
          status: "running",
          error_code: null,
          worn_out: true,
        });
        expect(await projectRow(pg, waiting.projectId)).toEqual({
          status: "generating",
          current_version_id: null,
        });
        expect(await versionRow(pg, waiting.versionId)).toMatchObject({
          visibility: "internal",
          qa_status: "pending",
        });
        expect((await qaRow(healthyQa)).status).toBe("failed");
        expect((await projectRow(pg, healthy.projectId)).status).toBe("ready");
      } finally {
        await holder.query("SELECT pg_advisory_unlock_all()");
        await holder.end();
        await pg.query("SET LOCAL lock_timeout = '5s'");
      }
      // Once the lock is free, the next claim settles it: the version the
      // review was judging is shown, as a failed check, and becomes current.
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 0 });
      expect(await qaRow(worn)).toEqual({
        status: "failed",
        error_code: "qa_lease_expired",
        worn_out: true,
      });
      expect(await projectRow(pg, waiting.projectId)).toEqual({
        status: "ready",
        current_version_id: waiting.versionId,
      });
      expect(await versionRow(pg, waiting.versionId)).toMatchObject({
        visibility: "operator",
        qa_status: "failed",
      });
      await pg.query(
        "DROP TRIGGER ts1fix_wait_project ON theme_studio_projects",
      );
    });
  }, 60_000);

  /** A theme at Ready to publish whose re-check is under way: the state the
   * capture half of the re-check contract (TS-1E) leaves for the review. */
  async function seedRecheck(
    ctx: Parameters<Parameters<typeof withRollback>[0]>[0],
    input: {
      buildId?: string;
      recapturesBefore?: number;
      recapturesSince?: number;
      pkg?: ThemePackageV2;
    } = {},
  ) {
    const { pg, operator, seed, insertQa } = ctx;
    const theme = await seed({
      status: "ready",
      visibility: "operator",
      qaStatus: "passed",
      pkg: input.pkg,
    });
    const acceptance = async (buildId: string) => {
      const id = randomUUID();
      const hex = createHash("sha256").update(id).digest("hex");
      await pg.query(
        `INSERT INTO theme_studio_acceptance_runs(id,project_id,version_id,package_digest,assets_digest,build_id,status,server_report,browser_report,evidence_digest,created_by,created_by_email,completed_at)
         VALUES($1,$2,$3,$4,$5,$6,'passed',$7,'{"gates":[]}',$5,$8,$9,now())`,
        [
          id,
          theme.projectId,
          theme.versionId,
          theme.packageDigest,
          hex,
          buildId,
          JSON.stringify({ gates: passingGates() }),
          operator.id,
          operator.email,
        ],
      );
      return id;
    };
    const capture = (key: string, age: string) =>
      pg.query(
        `INSERT INTO theme_studio_captures(project_id,version_id,package_digest,status,previous_status,idempotency_key,automatic,qa_iteration,phase,result_version_id,attempt_count,created_by,created_at,finished_at)
         VALUES($1,$2,$3,'succeeded','generating',$4,true,3,'final',$2,1,$5,now()-$6::interval,now()-$6::interval)`,
        [
          theme.projectId,
          theme.versionId,
          theme.packageDigest,
          key,
          operator.id,
          age,
        ],
      );
    // The check that made it Ready to publish, on an earlier build, and the
    // deploys that check met.
    await acceptance("earlier-build");
    await pg.query(
      "UPDATE theme_studio_projects SET status='candidate' WHERE id=$1",
      [theme.projectId],
    );
    for (let i = 0; i < (input.recapturesBefore ?? 0); i++)
      await capture(`auto_recapture_${randomUUID()}`, `${2 + i} days`);
    // The re-check: generating, an in-place final capture at the repair
    // ceiling, a complete new check run and the review bound to it.
    await pg.query(
      "UPDATE theme_studio_projects SET status='generating',revision=revision+1 WHERE id=$1",
      [theme.projectId],
    );
    await capture(`recheck_publish_recheck_${randomUUID()}`, "1 hour");
    for (let i = 0; i < (input.recapturesSince ?? 0); i++)
      await capture(`auto_recapture_${randomUUID()}`, `${30 - i} minutes`);
    const buildId = input.buildId ?? currentAcceptanceBuildId();
    const acceptanceRunId = await acceptance(buildId);
    const png = await sharp({
      create: { width: 390, height: 844, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const [shot] = (
      await pg.query(
        `INSERT INTO theme_studio_assets(project_id,purpose,media_type,bytes,byte_size,width,height,sha256,original_media_type,original_byte_size)
         VALUES($1,'qa_screenshot','image/png',$2,$3,390,844,$4,'image/png',$3) RETURNING id`,
        [
          theme.projectId,
          png,
          png.byteLength,
          createHash("sha256").update(png).digest("hex"),
        ],
      )
    ).rows;
    const qaId = await insertQa(theme, {
      qaIteration: 3,
      screenshotAssetIds: [shot.id],
      browserReport: {
        phase: "final",
        buildId,
        acceptanceRunId,
        surfaces: ["home"],
        gates: passingGates(),
        evidence: {
          userAgent: "local integration",
          samples: [
            {
              viewport: "phone390",
              surface: "home",
              path: "/",
              width: 390,
              height: 844,
            },
          ],
        },
      },
    });
    return { ...theme, qaId, acceptanceRunId };
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
  const answer = (value: Record<string, unknown>) =>
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
        ...value,
      },
    });
  const repairRuns = (pg: Client, projectId: string) =>
    pg
      .query(
        "SELECT count(*)::int AS n FROM theme_studio_runs WHERE project_id=$1 AND kind IN ('revise','images')",
        [projectId],
      )
      .then((r) => Number(r.rows[0].n));
  const qaRow = (pg: Client, id: string) =>
    pg
      .query(
        "SELECT status,error_code,vision_report FROM theme_studio_visual_qa_runs WHERE id=$1",
        [id],
      )
      .then((r) => r.rows[0]);

  it("re-check: a passed review ends Ready to publish, taste kept as warnings, and the version row is never written", async () => {
    await withRollback(async (ctx) => {
      verify.mockResolvedValue({ ok: true });
      for (const value of [
        {},
        {
          verdict: "revise",
          scores: { ...fives, artDirection: 3 },
          rejections: ["generic_surface"],
        },
      ]) {
        review.mockReset();
        answer(value);
        const theme = await seedRecheck(ctx);
        const before = await versionRow(ctx.pg, theme.versionId);
        expect(
          await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
        ).toMatchObject({ claimed: 1, passed: 1, revisionQueued: 0 });
        expect(review).toHaveBeenCalledOnce();
        expect(await projectRow(ctx.pg, theme.projectId)).toEqual({
          status: "candidate",
          current_version_id: theme.versionId,
        });
        expect(await versionRow(ctx.pg, theme.versionId)).toEqual(before);
        const row = await qaRow(ctx.pg, theme.qaId);
        expect(row.status).toBe("passed");
        expect(row.vision_report).toMatchObject({
          severityRules: "severity-v1",
          acceptanceRunId: theme.acceptanceRunId,
          reviewSeverity: { outcome: "verdict" in value ? "taste" : "pass" },
        });
        expect(await repairRuns(ctx.pg, theme.projectId)).toBe(0);
      }
    });
  }, 60_000);

  it("re-check: a serious review finding ends Ready with its reason and no repair run", async () => {
    await withRollback(async (ctx) => {
      answer({
        verdict: "revise",
        rejections: ["inaccessible_copy"],
        findings: ["The hero copy cannot be read on the photograph"],
        revisionBrief: "Move the hero copy off the photograph",
      });
      const theme = await seedRecheck(ctx);
      const before = await versionRow(ctx.pg, theme.versionId);
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, failed: 1, passed: 0, revisionQueued: 0 });
      expect(await projectRow(ctx.pg, theme.projectId)).toEqual({
        status: "ready",
        current_version_id: theme.versionId,
      });
      expect(await versionRow(ctx.pg, theme.versionId)).toEqual(before);
      const row = await qaRow(ctx.pg, theme.qaId);
      expect(row).toMatchObject({
        status: "failed",
        error_code: "quality_bar_not_met",
        vision_report: {
          reviewSeverity: {
            outcome: "serious",
            serious: [{ code: "inaccessible_copy" }],
          },
        },
      });
      expect(row.vision_report.diagnosis).toContain("Some text cannot be read");
      expect(await repairRuns(ctx.pg, theme.projectId)).toBe(0);
      expect(verify).not.toHaveBeenCalled();
    });
  }, 60_000);

  it("re-check: a deploy during it re-captures the same version in place, counted from the re-check, and stops with a plain reason after two", async () => {
    await withRollback(async (ctx) => {
      // Two deploys met the theme's first check long ago; they do not count.
      const theme = await seedRecheck(ctx, {
        buildId: "a-build-before-today",
        recapturesBefore: 2,
      });
      const before = await versionRow(ctx.pg, theme.versionId);
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, recaptureQueued: 1, failed: 0 });
      expect(review).not.toHaveBeenCalled();
      expect(
        (
          await ctx.pg.query(
            "SELECT version_id,previous_status,automatic,phase,qa_iteration FROM theme_studio_captures WHERE idempotency_key=$1 AND status='queued'",
            [`auto_recapture_${theme.qaId}`],
          )
        ).rows,
      ).toEqual([
        {
          version_id: theme.versionId,
          previous_status: "generating",
          automatic: true,
          phase: "final",
          qa_iteration: 3,
        },
      ]);
      expect(await qaRow(ctx.pg, theme.qaId)).toMatchObject({
        status: "failed",
        error_code: "acceptance_build_changed",
      });
      expect((await projectRow(ctx.pg, theme.projectId)).status).toBe(
        "generating",
      );
      expect(await versionRow(ctx.pg, theme.versionId)).toEqual(before);
    });
    await withRollback(async (ctx) => {
      // Two deploys during this re-check already: stop, and say why.
      const theme = await seedRecheck(ctx, {
        buildId: "a-build-before-today",
        recapturesSince: 2,
      });
      const before = await versionRow(ctx.pg, theme.versionId);
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, recaptureQueued: 0, failed: 1 });
      const row = await qaRow(ctx.pg, theme.qaId);
      expect(row.error_code).toBe("acceptance_build_unstable");
      expect(row.vision_report.diagnosis).toContain("StoreMink was updated");
      expect(await projectRow(ctx.pg, theme.projectId)).toEqual({
        status: "ready",
        current_version_id: theme.versionId,
      });
      expect(await versionRow(ctx.pg, theme.versionId)).toEqual(before);
    });
  }, 60_000);

  // ── TS-3A ──────────────────────────────────────────────────────────────

  /** A final review row already running on a live lease, for its own
   * project (one active review per project). */
  async function runningReview(
    ctx: Parameters<Parameters<typeof withRollback>[0]>[0],
  ) {
    const theme = await ctx.seed({
      status: "generating",
      visibility: "internal",
      qaStatus: "pending",
    });
    const id = await ctx.insertQa(theme, {
      screenshotAssetIds: [randomUUID()],
      browserReport: { phase: "final", buildId: currentAcceptanceBuildId() },
    });
    await ctx.pg.query(
      "UPDATE theme_studio_visual_qa_runs SET status='running',lease_owner=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',attempt_count=1,started_at=now() WHERE id=$1",
      [id],
    );
    return id;
  }

  it("★ the cap: with two design reviews running on live leases a claim takes none, but a layout check still goes", async () => {
    await withRollback(async (ctx) => {
      const running: string[] = [];
      for (let i = 0; i < DESIGN_REVIEW_CAP; i++)
        running.push(await runningReview(ctx));
      const waiting = await seedRecheck(ctx);
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 0, capped: 1 });
      expect(review).not.toHaveBeenCalled();
      expect((await qaRow(ctx.pg, waiting.qaId)).status).toBe("queued");
      // A layout check makes no model call: it is claimed at the cap.
      const layout = await ctx.seed({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      const layoutQa = await ctx.insertQa(layout, {
        browserReport: layoutReport(unmeasuredLayout()),
      });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, failed: 1 });
      expect((await qaRow(ctx.pg, layoutQa)).status).toBe("failed");
      expect((await qaRow(ctx.pg, waiting.qaId)).status).toBe("queued");
      // One running review finishes: its slot goes to the waiting review.
      await ctx.pg.query(
        "UPDATE theme_studio_visual_qa_runs SET status='failed',error_code='test_finished',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [running[0]],
      );
      verify.mockResolvedValue({ ok: true });
      answer({});
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1 });
    });
  }, 60_000);

  it("★ Stop frees a review's slot only once its worker can have stopped: a review Stop ended counts against the cap for STOPPED_REVIEW_HOLDS_SLOT_MS", async () => {
    await withRollback(async (ctx) => {
      const running: string[] = [];
      for (let i = 0; i < DESIGN_REVIEW_CAP; i++)
        running.push(await runningReview(ctx));
      const waiting = await seedRecheck(ctx);
      // Stop ends one running review exactly as stop.ts writes it: failed
      // with the stop code, its lease cleared at once.
      await ctx.pg.query(
        "UPDATE theme_studio_visual_qa_runs SET status='failed',error_code=$2,finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [running[0], THEME_STUDIO_STOP_CODE],
      );
      // Its worker learns so at its next lease renewal, and its model call
      // runs until then: the slot is still taken.
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 0, capped: 1 });
      expect(review).not.toHaveBeenCalled();
      expect((await qaRow(ctx.pg, waiting.qaId)).status).toBe("queued");
      // Past that window the slot is free (the guard stamps rows itself,
      // so step around it to age the stop).
      await ctx.pg.query("SET LOCAL session_replication_role = replica");
      await ctx.pg.query(
        "UPDATE theme_studio_visual_qa_runs SET finished_at=now()-($2::int * interval '1 millisecond')-interval '1 second' WHERE id=$1",
        [running[0], STOPPED_REVIEW_HOLDS_SLOT_MS],
      );
      await ctx.pg.query("SET LOCAL session_replication_role = origin");
      verify.mockResolvedValue({ ok: true });
      answer({});
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1 });
    });
  }, 60_000);

  it("a review Stop ended before it ever started holds no slot: no model call of it can be running", async () => {
    await withRollback(async (ctx) => {
      for (let i = 0; i < DESIGN_REVIEW_CAP - 1; i++) await runningReview(ctx);
      const never = await ctx.seed({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      const neverId = await ctx.insertQa(never, {
        screenshotAssetIds: [randomUUID()],
        browserReport: { phase: "final", buildId: currentAcceptanceBuildId() },
      });
      await ctx.pg.query(
        "UPDATE theme_studio_visual_qa_runs SET status='failed',error_code=$2,finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND started_at IS NULL",
        [neverId, THEME_STUDIO_STOP_CODE],
      );
      expect((await qaRow(ctx.pg, neverId)).error_code).toBe(
        THEME_STUDIO_STOP_CODE,
      );
      await seedRecheck(ctx);
      verify.mockResolvedValue({ ok: true });
      answer({});
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1 });
    });
  }, 60_000);

  it("★ two claims at once: a claim waits for the one-at-a-time lock another claim holds, so they never both pass the count", async () => {
    await withRollback(async (ctx) => {
      await seedRecheck(ctx);
      const other = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: "postgres",
        password: process.env.DB_ADMIN_PASSWORD,
        connectionTimeoutMillis: 5000,
      });
      await other.connect();
      try {
        // A second claim, in another session, holds the claim lock for its
        // transaction.
        await other.query("BEGIN");
        await other.query(
          "select pg_advisory_xact_lock(hashtextextended('theme-studio:design-review-claim', 0))",
        );
        const [{ pid }] = (await ctx.pg.query("SELECT pg_backend_pid() AS pid"))
          .rows;
        let done = false;
        verify.mockResolvedValue({ ok: true });
        answer({});
        const claim = runThemeStudioVisualQaWorker({
          providers: ["fake"],
        }).then((result) => {
          done = true;
          return result;
        });
        // This claim waits on exactly that lock.
        let waitingOnLock = false;
        for (let i = 0; i < 50 && !waitingOnLock; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          waitingOnLock =
            (
              await other.query(
                "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
                [pid],
              )
            ).rowCount === 1;
        }
        expect(waitingOnLock).toBe(true);
        expect(done).toBe(false);
        expect(review).not.toHaveBeenCalled();
        await other.query("COMMIT");
        expect(await claim).toMatchObject({ claimed: 1 });
      } finally {
        await other.query("ROLLBACK").catch(() => {});
        await other.end();
      }
    });
  }, 60_000);

  it("★ cooldown: a review sent back after a failed try waits before it can be claimed again", async () => {
    await withRollback(async (ctx) => {
      const theme = await seedRecheck(ctx);
      review.mockResolvedValue({
        kind: "refused",
        category: null,
        usage: {
          inputTokens: 40,
          cachedTokens: 0,
          outputTokens: 2,
          thinkingTokens: 3,
        },
      });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, failed: 0 });
      const sentBack = await qaRow(ctx.pg, theme.qaId);
      expect(sentBack.status).toBe("queued");
      // What the refused call cost stays on the row.
      expect(sentBack.vision_report).toEqual({
        failedCalls: 1,
        failedCallUsage: {
          inputTokens: 40,
          cachedTokens: 0,
          outputTokens: 2,
          thinkingTokens: 3,
        },
      });
      // Within the cooldown nothing is claimed.
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 0 });
      // A minute on (the guard stamps updated_at itself, so step around it).
      await ctx.pg.query("SET LOCAL session_replication_role = replica");
      await ctx.pg.query(
        "UPDATE theme_studio_visual_qa_runs SET updated_at=now()-interval '61 seconds' WHERE id=$1",
        [theme.qaId],
      );
      await ctx.pg.query("SET LOCAL session_replication_role = origin");
      verify.mockResolvedValue({ ok: true });
      answer({});
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, passed: 1 });
      // The pass still reports what the refused call cost.
      expect((await qaRow(ctx.pg, theme.qaId)).vision_report).toMatchObject({
        failedCalls: 1,
        failedCallUsage: { inputTokens: 40 },
      });
      expect(notice).toHaveBeenCalledWith({
        projectId: theme.projectId,
        kind: "ready",
      });
    });
  }, 60_000);

  it("theme_studio.qa_waiting counts the reviews waiting over ten minutes", async () => {
    await withRollback(async (ctx) => {
      expect(await logThemeStudioQaWaiting()).toBe(0);
      const theme = await ctx.seed({
        status: "generating",
        visibility: "internal",
        qaStatus: "pending",
      });
      await ctx.pg.query(
        `INSERT INTO theme_studio_visual_qa_runs(project_id,version_id,package_digest,qa_iteration,browser_report,screenshot_asset_ids,created_by,created_at)
         VALUES($1,$2,$3,0,$4,'{}',$5,now()-interval '11 minutes')`,
        [
          theme.projectId,
          theme.versionId,
          theme.packageDigest,
          JSON.stringify(layoutReport(unmeasuredLayout())),
          ctx.operator.id,
        ],
      );
      expect(await logThemeStudioQaWaiting()).toBe(1);
    });
  }, 60_000);

  /** A Ready-to-publish design whose drawn photos have no check on their
   * bytes (one put off while drawing, or carried over unchecked). */
  function uncheckedPhotos() {
    const pkg = operatorImagePackage();
    pkg.assets.forEach((asset) => {
      asset.source = "generated";
    });
    return pkg;
  }

  it("★ photo check waiting: the review goes back without spending its try, and the theme shows Checking pictures", async () => {
    await withRollback(async (ctx) => {
      checkPhotos.mockResolvedValueOnce("waiting");
      const theme = await seedRecheck(ctx, { pkg: uncheckedPhotos() });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, photosWaiting: 1, failed: 0 });
      expect(review).not.toHaveBeenCalled();
      const row = (
        await ctx.pg.query(
          "SELECT status,attempt_count,lease_owner,vision_report FROM theme_studio_visual_qa_runs WHERE id=$1",
          [theme.qaId],
        )
      ).rows[0];
      expect(row).toMatchObject({
        status: "queued",
        attempt_count: 0,
        lease_owner: null,
        vision_report: {
          photoCheck: {
            state: "waiting",
            since: expect.any(String),
            unchecked: expect.any(Number),
          },
        },
      });
      expect(await projectRow(ctx.pg, theme.projectId)).toMatchObject({
        status: "generating",
      });
    });
  }, 60_000);

  it("★ photo checks that took their own claim: the review goes back with no try spent and is claimable at once, past the cooldown", async () => {
    await withRollback(async (ctx) => {
      const realNow = Date.now.bind(Date);
      let skew = 0;
      const clock = vi
        .spyOn(Date, "now")
        .mockImplementation(() => realNow() + skew);
      try {
        // The checks passed, but only after PHOTO_CHECK_INLINE_MS.
        checkPhotos.mockImplementationOnce(async () => {
          skew += PHOTO_CHECK_INLINE_MS + 1_000;
          return "passed";
        });
        const theme = await seedRecheck(ctx, { pkg: uncheckedPhotos() });
        expect(
          await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
        ).toMatchObject({ claimed: 1, photosChecked: 1, failed: 0 });
        expect(review).not.toHaveBeenCalled();
        expect(
          (
            await ctx.pg.query(
              "SELECT status,attempt_count,lease_owner,started_at IS NOT NULL AS started,vision_report FROM theme_studio_visual_qa_runs WHERE id=$1",
              [theme.qaId],
            )
          ).rows[0],
        ).toMatchObject({
          status: "queued",
          attempt_count: 0,
          lease_owner: null,
          started: true,
          vision_report: { photoCheck: { state: "checked" } },
        });
      } finally {
        clock.mockRestore();
      }
      // Claimed again at once: no cooldown after its checks (a review sent
      // back after a failed try would wait QA_RETRY_COOLDOWN_SECONDS).
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1 });
      expect(checkPhotos).toHaveBeenCalledTimes(2);
    });
  }, 60_000);

  it("★ photo check failed: the checks stop as could not finish, the visible version untouched", async () => {
    await withRollback(async (ctx) => {
      checkPhotos.mockResolvedValueOnce("failed");
      const theme = await seedRecheck(ctx, { pkg: uncheckedPhotos() });
      const before = await versionRow(ctx.pg, theme.versionId);
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, failed: 1 });
      const row = await qaRow(ctx.pg, theme.qaId);
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("checks_incomplete");
      expect(row.vision_report.photoCheck.state).toBe("failed");
      expect(await projectRow(ctx.pg, theme.projectId)).toEqual({
        status: "ready",
        current_version_id: theme.versionId,
      });
      expect(await versionRow(ctx.pg, theme.versionId)).toEqual(before);
      expect(notice).toHaveBeenCalledWith({
        projectId: theme.projectId,
        kind: "needs_fix",
      });
    });
  }, 60_000);

  it("★ our own missing input fails at once as qa_input_missing, with its second try unspent", async () => {
    await withRollback(async (ctx) => {
      // The photos passed their check, but their stored bytes are gone.
      checkPhotos.mockResolvedValueOnce("passed");
      const theme = await seedRecheck(ctx, { pkg: uncheckedPhotos() });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, failed: 1 });
      expect(review).not.toHaveBeenCalled();
      const row = (
        await ctx.pg.query(
          "SELECT status,error_code,attempt_count,max_attempts FROM theme_studio_visual_qa_runs WHERE id=$1",
          [theme.qaId],
        )
      ).rows[0];
      expect(row).toEqual({
        status: "failed",
        error_code: "qa_input_missing",
        attempt_count: 1,
        max_attempts: 2,
      });
    });
  }, 60_000);

  it("★ owner, 24 Oct: a capture error a retry cannot fix fails at once; one seen twice in a row fails on the second; a transient one keeps its tries", async () => {
    await withRollback(async ({ pg, operator, seed }) => {
      openPreview.mockImplementation(async () => ({
        origin: "https://preview.example.test",
        storeId: randomUUID(),
        pages: [],
      }));
      /** A queued automatic layout capture of its own generating theme. */
      const queued = async () => {
        const theme = await seed({
          status: "generating",
          visibility: "internal",
          qaStatus: "pending",
        });
        const [{ id }] = (
          await pg.query(
            `INSERT INTO theme_studio_captures(project_id,version_id,package_digest,previous_status,idempotency_key,phase,automatic,qa_iteration,max_attempts,created_by)
             VALUES($1,$2,$3,'generating',$4,'layout',true,0,5,$5) RETURNING id`,
            [
              theme.projectId,
              theme.versionId,
              theme.packageDigest,
              `auto_layout_${randomUUID()}`,
              operator.id,
            ],
          )
        ).rows;
        return { ...theme, captureId: id as string };
      };
      const tryOnce = async (error: string, errorSurface?: string) => {
        const claim = await claimThemeStudioCapture();
        expect(claim).not.toBeNull();
        return finishThemeStudioCapture({
          captureId: claim!.captureId,
          leaseToken: claim!.leaseToken,
          error,
          ...(errorSurface ? { errorSurface } : {}),
        });
      };
      const captureRow = async (id: string) =>
        (
          await pg.query(
            "SELECT status,error_code,attempt_count FROM theme_studio_captures WHERE id=$1",
            [id],
          )
        ).rows[0];

      // Deterministic: the first report fails it, four tries unspent.
      const shot = await queued();
      expect(await tryOnce("qa_screenshot_too_large")).toEqual({
        status: "failed",
        errorCode: "qa_screenshot_too_large",
      });
      expect(await captureRow(shot.captureId)).toEqual({
        status: "failed",
        error_code: "qa_screenshot_too_large",
        attempt_count: 1,
      });
      expect(await projectRow(pg, shot.projectId)).toEqual({
        status: "ready",
        current_version_id: shot.versionId,
      });
      expect(notice).toHaveBeenCalledWith({
        projectId: shot.projectId,
        kind: "needs_fix",
      });

      // Neither kind: tried again once, failed when it repeats.
      const crash = await queued();
      expect(await tryOnce("capture_browser_error")).toEqual({
        status: "requeued",
      });
      const [retry] = (
        await pg.query(
          "SELECT actor_kind,detail FROM theme_studio_events WHERE project_id=$1 AND event_type='capture_requested'",
          [crash.projectId],
        )
      ).rows;
      expect(retry).toEqual({
        actor_kind: "worker",
        detail: {
          captureId: crash.captureId,
          versionId: crash.versionId,
          attempt: 1,
          retryAfter: "capture_browser_error",
        },
      });
      expect(await tryOnce("capture_browser_error")).toEqual({
        status: "failed",
        errorCode: "capture_browser_error",
      });
      expect(await captureRow(crash.captureId)).toMatchObject({
        status: "failed",
        attempt_count: 2,
      });

      // ★ A preview page's 404 (what a short database outage answers too):
      // tried again; a different result in between is not a repeat; the
      // same 404 on two tries in a row fails.
      const missing = await queued();
      expect(await tryOnce("preview_status_404", "home")).toEqual({
        status: "requeued",
      });
      expect(await tryOnce("capture_timeout")).toEqual({ status: "requeued" });
      expect(await tryOnce("preview_status_404", "home")).toEqual({
        status: "requeued",
      });
      expect(await tryOnce("preview_status_404", "home")).toEqual({
        status: "failed",
        errorCode: "preview_status_404",
      });
      expect(await captureRow(missing.captureId)).toEqual({
        status: "failed",
        error_code: "preview_status_404",
        attempt_count: 4,
      });

      // Transient: every try, even when it repeats.
      const slow = await queued();
      for (let attempt = 1; attempt <= 3; attempt++)
        expect(await tryOnce("capture_timeout")).toEqual({
          status: "requeued",
        });
      expect(await captureRow(slow.captureId)).toEqual({
        status: "queued",
        error_code: null,
        attempt_count: 3,
      });
    });
  }, 60_000);
});
