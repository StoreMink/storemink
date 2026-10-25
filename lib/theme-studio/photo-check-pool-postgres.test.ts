// Opt-in local PostgreSQL regression (whole-branch review, 25 Oct 2026): the
// photo check before a design review on a pool of ONE database connection,
// which is what the private QA worker runs with (DB_POOL_MAX=1,
// scripts/theme-studio-workers.py WORKER_POOL). Before the fix, visual-qa.ts
// held a `withService` transaction open through checkUncheckedPhotos, whose
// claim and record of each photo open a transaction of their own: on a pool
// of one that second connection never comes, the 5 s pool wait throws
// DatabaseBusyError, the claim reads it as "waiting", and the theme shows
// "Checking pictures" until it ends as could not finish. The review lane's
// other suites give `withService` a harness that never refuses a call, so
// they could not see it; photo-recheck.test.ts pins the check's own runner
// form, and this file runs the whole review lane on a pool that refuses.
//
// Here `withService` is a POOL OF ONE: every call takes the one connection in
// turn (a savepoint of this test's rolled-back transaction stands for its own
// transaction), and a call that cannot get it within POOL_WAIT_MS fails as
// the real pool does (DatabaseBusyError, pool_wait_timeout). The first test
// pins that the real lib/db/client behaves that way with DB_POOL_MAX=1.
// Every fixture and write rolls back; the photo check and the design review
// answer offline: no network, no model call, nothing paid.
// Run THEME_STUDIO_RECOVERY_DB_TEST=1 with Vitest.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import sharp from "sharp";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import type { Db } from "@/lib/db/client";
import { gate, GATE_LABELS, type GateId } from "./acceptance-gates";
import type { ThemePackageV2 } from "./contracts";

const { service, review, verify, notice, logs } = vi.hoisted(() => ({
  service: vi.fn(),
  review: vi.fn(),
  verify: vi.fn(),
  notice: vi.fn(async () => {}),
  logs: { warn: vi.fn(), error: vi.fn() },
}));
// The real module (DatabaseBusyError, the pool's own wording) with only
// `withService` replaced by the pool of one below.
vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  withService: service,
}));
vi.mock("./config", () => ({
  getThemeStudioConfig: () => ({
    provider: "fake",
    generationEnabled: true,
    captureEnabled: true,
    autoQaEnabled: true,
    disabledModels: new Set(),
  }),
}));
// The design reviewer is the offline client answering from a stub; the photo
// check is the offline image reviewer the worker uses for a "fake" photo run
// (image-fake.ts), which passes every photo.
vi.mock("./fake-provider", async (original) => ({
  ...(await original<typeof import("./fake-provider")>()),
  createFakeModelClient: () => ({ provider: "fake", generate: review }),
}));
// The read-only evidence verifier has its own tests; the database's own guard
// (migration 0151) still refuses a candidate without a passed check run.
vi.mock("./acceptance", async (original) => ({
  ...(await original<typeof import("./acceptance")>()),
  verifyCandidateEvidenceWithDb: verify,
}));
vi.mock("./notify", () => ({ sendThemeStudioNotice: notice }));
vi.mock("@/lib/observability/logger", async (original) => ({
  ...(await original<typeof import("@/lib/observability/logger")>()),
  logWarn: logs.warn,
  logError: logs.error,
}));
import {
  DatabaseBusyError,
  POOL_WAIT_TIMEOUT_MESSAGE,
  withService,
} from "@/lib/db/client";
import { checkUncheckedPhotos } from "./image-recovery";
import { runThemeStudioVisualQaWorker } from "./visual-qa";
import { currentAcceptanceBuildId } from "./acceptance";
import { runThemeGeneration } from "./pipeline";
import {
  applyGeneratedImages,
  generatableSlots,
} from "./image-generation-core";
import { digestThemeStudioJson } from "./repository";

const ENABLED = process.env.THEME_STUDIO_RECOVERY_DB_TEST === "1";

beforeEach(() => {
  vi.clearAllMocks();
});
/** The pool's wait for a free connection; the real one is 5 s. */
const POOL_WAIT_MS = 1_000;

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Every gate passing, performance advisory, as a real passing run stores. */
const passingGates = () =>
  (Object.keys(GATE_LABELS) as GateId[]).map((id) =>
    gate(id, [], { required: id !== "browser.performance" }),
  );

function localClient() {
  return new Client({
    host: "127.0.0.1",
    port: 5544,
    database: "storemink_local",
    user: "postgres",
    password: process.env.DB_ADMIN_PASSWORD,
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * `withService` with ONE connection. Calls take it in turn; one that waits
 * POOL_WAIT_MS fails as the real pool does. `nested` counts the calls made
 * while their own caller still held the connection: on a real pool of one
 * such a call can never be served.
 */
function poolOfOne(pg: Client) {
  const db = drizzle(pg);
  const inside = new AsyncLocalStorage<true>();
  const waiting: (() => void)[] = [];
  const stats = { calls: 0, nested: 0, busy: 0 };
  let held = false;
  const acquire = () =>
    new Promise<void>((resolve, reject) => {
      if (!held) {
        held = true;
        resolve();
        return;
      }
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(grant), 1);
        stats.busy += 1;
        reject(
          new DatabaseBusyError(
            "pool_wait_timeout",
            new Error(POOL_WAIT_TIMEOUT_MESSAGE),
          ),
        );
      }, POOL_WAIT_MS);
      waiting.push(grant);
    });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else held = false;
  };
  service.mockImplementation(async (fn: (db: unknown) => Promise<unknown>) => {
    if (inside.getStore()) stats.nested += 1;
    await acquire();
    try {
      const savepoint = `pool_of_one_${++stats.calls}`;
      await pg.query(`SAVEPOINT ${savepoint}`);
      await pg.query("SET LOCAL ROLE app_service");
      try {
        const value = await inside.run(true, () => fn(db));
        await pg.query("RESET ROLE");
        await pg.query(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await pg.query("RESET ROLE");
        throw error;
      }
    } finally {
      release();
    }
  });
  return { db, stats };
}

/**
 * One rolled-back transaction: a theme whose design review is due, on a
 * version whose photo was kept unchecked when it was drawn (its check stayed
 * unavailable), exactly what the review's photo check exists for.
 */
async function withUncheckedPhoto(
  work: (ctx: {
    pg: Client;
    db: Db;
    stats: { calls: number; nested: number; busy: number };
    projectId: string;
    versionId: string;
    photoRunId: string;
    qaId: string;
    drawn: ThemePackageV2;
  }) => Promise<void>,
) {
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "local-pool-regression-only");
  const pg = localClient();
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
    const operator = { id: randomUUID(), email: `${randomUUID()}@pool.test` };
    await pg.query(
      "INSERT INTO platform_admins(id,email,role) VALUES($1,$2,'superadmin')",
      [operator.id, operator.email],
    );

    // The offline provider's theme, with one photo drawn into it.
    const actual =
      await vi.importActual<typeof import("./fake-provider")>(
        "./fake-provider",
      );
    const facts = {
      name: "Pool of one",
      themeId: "pool-of-one",
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
    const slot = generatableSlots(outcome.package, outcome.intent)[0];
    const webp = (r: number) =>
      sharp({
        create: {
          width: slot.target.width,
          height: slot.target.height,
          channels: 3,
          background: { r, g: 120, b: 90 },
        },
      })
        .webp()
        .toBuffer();
    const photo = await webp(200);
    const anchorBytes = await webp(40);
    const applied = applyGeneratedImages(
      outcome.package,
      [
        {
          slotId: slot.slotId,
          sha256: sha(photo),
          width: slot.target.width,
          height: slot.target.height,
        },
      ],
      2,
      "gemini-nano-banana-2.1",
    );
    if (!applied.ok) throw new Error(applied.error);
    const drawn = applied.value;

    const projectId = randomUUID();
    const brief = randomUUID();
    await pg.query(
      `INSERT INTO theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by,created_by_email)
       VALUES($1,$2,'Pool of one','generating','{home}','{small}','gemini-3.8-flash','A calm ceramics shop',$3,$4)`,
      [projectId, `pool-of-one-${projectId}`, operator.id, operator.email],
    );
    await pg.query(
      "INSERT INTO theme_studio_messages(id,project_id,kind,body,created_by) VALUES($1,$2,'brief','A calm ceramics shop',$3)",
      [brief, projectId, operator.id],
    );
    const anchor = randomUUID();
    await pg.query(
      `INSERT INTO theme_studio_assets(id,project_id,purpose,media_type,bytes,byte_size,width,height,sha256,original_media_type,original_byte_size)
       VALUES($1,$2,'anchor','image/webp',$3,$4,$5,$6,$7,'image/webp',$4),
             ($8,$2,'image','image/webp',$9,$10,$5,$6,$11,'image/webp',$10)`,
      [
        anchor,
        projectId,
        anchorBytes,
        anchorBytes.length,
        slot.target.width,
        slot.target.height,
        sha(anchorBytes),
        randomUUID(),
        photo,
        photo.length,
        sha(photo),
      ],
    );
    const run = async (
      kind: "generate" | "images",
      base: { id: string; digest: string } | null,
      detail: Record<string, unknown> = {},
    ) => {
      const id = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,base_version_id,base_package_digest,created_by,status,attempt_count,finished_at,outcome_detail)
         VALUES($1,$2,$3,$4,'fake','gemini-3.8-flash','fake','theme-studio-fake-v1',$5,$6,$7,$8,'succeeded',1,now(),$9)`,
        [
          id,
          projectId,
          brief,
          kind,
          `pool_of_one_${id}`,
          base?.id ?? null,
          base?.digest ?? null,
          operator.id,
          JSON.stringify(detail),
        ],
      );
      return id;
    };
    const version = async (
      runId: string,
      number: number,
      pkg: ThemePackageV2,
      parent: string | null,
    ) => {
      const id = randomUUID();
      const packageDigest = digestThemeStudioJson(pkg);
      await pg.query(
        `INSERT INTO theme_studio_versions(id,project_id,run_id,parent_version_id,version_number,intent_json,intent_digest,package_json,package_digest,visibility,qa_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'internal','pending')`,
        [
          id,
          projectId,
          runId,
          parent,
          number,
          JSON.stringify(outcome.intent),
          digestThemeStudioJson(outcome.intent),
          JSON.stringify(pkg),
          packageDigest,
        ],
      );
      return { id, digest: packageDigest };
    };
    // v1 from the design run; v2 from the photo run, whose check stayed
    // unavailable, so the photo was kept unchecked.
    const v1 = await version(
      await run("generate", null),
      1,
      outcome.package,
      null,
    );
    const photoRunId = await run("images", v1, {
      kind: "images",
      anchorAssetId: anchor,
      outcomes: [
        {
          slotId: slot.slotId,
          status: "generated",
          attempts: 1,
          review: "unreviewed",
        },
      ],
    });
    const v2 = await version(photoRunId, 2, drawn, v1.id);

    // The final capture's passed check run and the review bound to it.
    const buildId = currentAcceptanceBuildId();
    const acceptanceRunId = randomUUID();
    const hex = createHash("sha256").update(acceptanceRunId).digest("hex");
    await pg.query(
      `INSERT INTO theme_studio_acceptance_runs(id,project_id,version_id,package_digest,assets_digest,build_id,status,server_report,browser_report,evidence_digest,created_by,created_by_email,completed_at)
       VALUES($1,$2,$3,$4,$5,$6,'passed',$7,'{"gates":[]}',$5,$8,$9,now())`,
      [
        acceptanceRunId,
        projectId,
        v2.id,
        v2.digest,
        hex,
        buildId,
        JSON.stringify({ gates: passingGates() }),
        operator.id,
        operator.email,
      ],
    );
    const png = await sharp({
      create: { width: 390, height: 844, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const [shot] = (
      await pg.query(
        `INSERT INTO theme_studio_assets(project_id,purpose,media_type,bytes,byte_size,width,height,sha256,original_media_type,original_byte_size)
         VALUES($1,'qa_screenshot','image/png',$2,$3,390,844,$4,'image/png',$3) RETURNING id`,
        [projectId, png, png.byteLength, sha(png)],
      )
    ).rows;
    const qaId = randomUUID();
    await pg.query(
      `INSERT INTO theme_studio_visual_qa_runs(id,project_id,version_id,package_digest,qa_iteration,browser_report,screenshot_asset_ids,created_by)
       VALUES($1,$2,$3,$4,0,$5,$6,$7)`,
      [
        qaId,
        projectId,
        v2.id,
        v2.digest,
        JSON.stringify({
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
        }),
        [shot.id],
        operator.id,
      ],
    );

    const { db, stats } = poolOfOne(pg);
    await work({
      pg,
      db: db as unknown as Db,
      stats,
      projectId,
      versionId: v2.id,
      photoRunId,
      qaId,
      drawn,
    });
  } finally {
    await pg.query("ROLLBACK");
    await pg.end();
    vi.unstubAllEnvs();
  }
}

/** The photo's entry on the run that drew it, as the design review reads it. */
async function photoEntry(pg: Client, runId: string) {
  return (
    await pg.query(
      "SELECT outcome_detail->'outcomes'->0 AS entry FROM theme_studio_runs WHERE id=$1",
      [runId],
    )
  ).rows[0].entry as Record<string, unknown>;
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
const passingReview = () =>
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

describe.skipIf(!ENABLED)("the photo check on a pool of one connection", () => {
  it("the real pool of one: a transaction opened inside another fails as busy after the pool's wait; side by side ones take turns", async () => {
    // The local database only, as its superuser (withService still sets
    // the app_service role); the QA worker's pool size.
    vi.stubEnv("DB_HOST", "127.0.0.1");
    vi.stubEnv("DB_PORT", "5544");
    vi.stubEnv("DB_NAME", "storemink_local");
    vi.stubEnv("DB_USER", "postgres");
    vi.stubEnv("DB_PASSWORD", process.env.DB_ADMIN_PASSWORD ?? "");
    vi.stubEnv("DB_POOL_MAX", "1");
    const real =
      await vi.importActual<typeof import("@/lib/db/client")>(
        "@/lib/db/client",
      );
    try {
      const started = Date.now();
      await expect(
        real.withService(() => real.withService(async () => "inner")),
      ).rejects.toMatchObject({
        name: "DatabaseBusyError",
        reason: "pool_wait_timeout",
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      expect(
        await Promise.all(
          [1, 2, 3].map((n) =>
            real.withService(async (db) => {
              await db.execute(sql`SELECT 1`);
              return n;
            }),
          ),
        ),
      ).toEqual([1, 2, 3]);
    } finally {
      await real.closePool();
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it("★ the review's photo check claims, checks and records the photo with nothing held: no transaction opens inside another", async () => {
    await withUncheckedPhoto(async ({ pg, stats, photoRunId, qaId }) => {
      verify.mockResolvedValue({ ok: true });
      passingReview();
      const result = await runThemeStudioVisualQaWorker({
        providers: ["fake"],
      });
      expect(stats.nested).toBe(0);
      expect(stats.busy).toBe(0);
      expect(logs.warn).not.toHaveBeenCalledWith(
        "theme_studio.photo_check_deferred",
        expect.anything(),
      );
      // The photo was claimed and recorded on the run that drew it...
      const entry = await photoEntry(pg, photoRunId);
      expect(entry).toMatchObject({
        review: "passed",
        recheckedAt: expect.any(String),
      });
      expect(entry).not.toHaveProperty("recheck");
      // ...and the review went on in the same claim: no "Checking pictures"
      // wait, one design review, settled.
      expect(result).toMatchObject({ claimed: 1, photosWaiting: 0, passed: 1 });
      expect(review).toHaveBeenCalledTimes(1);
      const [row] = (
        await pg.query(
          "SELECT status, vision_report->'photoCheck'->>'state' AS state FROM theme_studio_visual_qa_runs WHERE id=$1",
          [qaId],
        )
      ).rows;
      expect(row.state).not.toBe("waiting");
    });
  }, 60_000);

  it("negative control: the call visual-qa.ts made before the fix (the check inside a held transaction) cannot claim on a pool of one", async () => {
    await withUncheckedPhoto(
      async ({ pg, stats, projectId, versionId, photoRunId }) => {
        // The old shape, with this test's own fixture writes hidden from the
        // check's "has written nothing" guard, as a fresh transaction's are.
        const hideFixtureWrites = (db: Db) =>
          new Proxy(db, {
            get(target, key, receiver) {
              if (key !== "execute") return Reflect.get(target, key, receiver);
              return async (query: Parameters<Db["execute"]>[0]) => {
                const result = await target.execute(query);
                return "held" in (result.rows[0] ?? {})
                  ? { ...result, rows: [{ held: false }] }
                  : result;
              };
            },
          }) as Db;
        const outcome = await withService((db) =>
          checkUncheckedPhotos(hideFixtureWrites(db), {
            projectId,
            versionId,
            signal: new AbortController().signal,
          }),
        );
        expect(outcome).toBe("waiting");
        expect(stats.nested).toBeGreaterThan(0);
        expect(stats.busy).toBeGreaterThan(0);
        expect(logs.warn).toHaveBeenCalledWith(
          "theme_studio.photo_check_deferred",
          expect.objectContaining({ error: "DatabaseBusyError" }),
        );
        // Nothing was claimed or recorded: the photo is still unchecked.
        expect(await photoEntry(pg, photoRunId)).toMatchObject({
          review: "unreviewed",
        });
        expect(await photoEntry(pg, photoRunId)).not.toHaveProperty("recheck");
      },
    );
  }, 60_000);
});
