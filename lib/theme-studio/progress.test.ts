import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// TS-2A: the narrow reads behind the theme page and the list
// (lib/theme-studio/progress.ts), with a scripted database: which facts each
// read takes and how it assembles them, the progress card's named steps,
// the counts the list and the page share, the caches of things that never
// change, a fixed number of queries for the list, and SQL that never selects
// picture bytes or a whole stored document. The real-database half is
// progress-postgres.test.ts.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  config: {
    generationEnabled: true,
    provider: "fake",
    disabledModels: new Set<string>(),
    dailySpendMicroUsd: null,
    captureEnabled: true,
    autoQaEnabled: true,
    performanceRequired: false,
  },
  evidence: { ok: true, acceptanceRunId: "a1" } as
    | { ok: true; acceptanceRunId: string }
    | { ok: false; reason: "old_build" | "no_review" | "none" },
}));
vi.mock("./config", () => ({ getThemeStudioConfig: vi.fn(() => h.config) }));
const { evidenceRead } = vi.hoisted(() => ({
  evidenceRead: vi.fn(async () => h.evidence),
}));
vi.mock("./acceptance", () => ({
  currentAcceptanceBuildId: vi.fn(() => "build-today"),
  currentPublishEvidence: evidenceRead,
}));

import {
  MAX_REVISION_MESSAGES,
  QA_RETRY_COOLDOWN_SECONDS,
  buildThemeStudioSteps,
  countCheckRunFindings,
  listThemeStudioCheckScreenshots,
  listThemeStudioProjectsForConsole,
  readThemeStudioBuildTimeRange,
  readThemeStudioCheckScreenshot,
  readThemeStudioProgress,
  resetThemeStudioProgressCaches,
  type ThemeStudioPieceCapture,
  type ThemeStudioPieceReview,
  type ThemeStudioPieceRun,
  type ThemeStudioWorkPiece,
} from "./progress";
import { studioStatus } from "@/app/platform/dashboard/(console)/themes/studio/studio-status";

const ROOT = join(__dirname, "../..");
const dialect = new PgDialect();
const NOW = "2026-10-25T10:00:00.000Z";
const at = (minutesAgo: number) =>
  new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
const P = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333";

// ------------------------------------------------------------- the database

type Query = { sql: string; params: unknown[] };

function scripted(answer: (query: Query) => unknown[]) {
  const seen: Query[] = [];
  const db = {
    execute: vi.fn(async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      seen.push(query);
      return { rows: answer(query) };
    }),
  };
  return { db: db as unknown as Db, seen };
}

/** The project ids Q2 was asked for (its other array is the start events). */
function projectIdsOf(q: Query): string[] {
  return (
    (q.params.filter(Array.isArray) as string[][]).find((ids) =>
      ids.every((id) => /^[0-9a-f-]{36}$/.test(id)),
    ) ?? []
  );
}

const isFacts = (q: Query) => q.sql.includes("clock_timestamp()");
const isPiece = (q: Query) => q.sql.includes("WITH proj AS");
const isFindings = (q: Query) => q.sql.includes("a.server_report -> 'gates'");
const isVersion = (q: Query) => q.sql.includes('AS "previewAssetId"');

function fact(overrides: Record<string, unknown> = {}) {
  return {
    readAt: "2026-10-25 15:30:00+05:30",
    projectId: P,
    name: "Aurora",
    themeId: "aurora",
    status: "ready",
    archivedAt: null,
    revision: 4,
    modelKey: "gemini-3.8-flash",
    createdAt: "2026-10-25 14:00:00+05:30",
    updatedAt: "2026-10-25 15:20:00+05:30",
    currentVersionId: V,
    currentPackageDigest: "d".repeat(64),
    releaseVersion: null,
    releasedAt: null,
    catalogVisibility: null,
    attemptStatus: null,
    attemptStartedAt: null,
    attemptLastWriteAt: null,
    attemptReasons: [],
    latestRunKind: "generate",
    latestRunStatus: "succeeded",
    latestOutcomeKind: "version",
    latestQuestionCount: 0,
    latestRunFinishedAt: "2026-10-25 14:10:00+05:30",
    latestContextCount: 0,
    questionsSetAside: false,
    questionRounds: 0,
    checkRunId: null,
    checkRunStatus: null,
    checkRunBuild: null,
    checkRunFinishedAt: null,
    reviewId: null,
    reviewStatus: null,
    reviewOutcome: null,
    reviewAcceptanceRunId: null,
    reviewSerious: [],
    reviewWarnings: [],
    pictureRunId: null,
    pictureRunStatus: null,
    pictureRunError: null,
    pictureRunFinishedAt: null,
    verdictRunId: null,
    verdictRunStatus: null,
    verdictRunBuild: null,
    verdictRunDigest: null,
    verdictRunHasEvidence: null,
    boundReviewStatus: null,
    boundReviewDigest: null,
    boundReviewBuild: null,
    versionIds: [V],
    ...overrides,
  };
}

function run(
  overrides: Partial<ThemeStudioPieceRun> = {},
): ThemeStudioPieceRun {
  return {
    id: "run-1",
    kind: "generate",
    status: "succeeded",
    errorCode: null,
    automatic: false,
    qaIteration: 0,
    createdAt: at(30),
    startedAt: at(29),
    finishedAt: at(25),
    updatedAt: at(25),
    retryNotBefore: null,
    rateLimitDeferrals: 0,
    retryOfRunId: null,
    slotIds: 0,
    outcomeKind: "version",
    outcomeStage: null,
    questions: 0,
    intentMs: 50_000,
    draftMs: 219_000,
    drawn: 0,
    checkpointAt: null,
    responses: 0,
    firstResponseAt: null,
    lastResponseAt: null,
    slotsRequested: null,
    outcomeSlots: null,
    generated: null,
    ...overrides,
  };
}

function capture(
  overrides: Partial<ThemeStudioPieceCapture> = {},
): ThemeStudioPieceCapture {
  return {
    id: "cap-1",
    status: "succeeded",
    errorCode: null,
    phase: "layout",
    versionId: V,
    key: "auto_layout_run-1",
    createdAt: at(24),
    startedAt: at(24),
    finishedAt: at(23),
    updatedAt: at(23),
    ...overrides,
  };
}

function review(
  overrides: Partial<ThemeStudioPieceReview> = {},
): ThemeStudioPieceReview {
  return {
    id: "qa-1",
    status: "passed",
    errorCode: null,
    phase: "layout",
    versionId: V,
    createdAt: at(23),
    startedAt: at(23),
    finishedAt: at(22.5),
    updatedAt: at(22.5),
    photoState: null,
    photoUnchecked: null,
    revisionRunId: null,
    repairs: 0,
    ...overrides,
  };
}

function piece(
  overrides: Partial<ThemeStudioWorkPiece> = {},
): ThemeStudioWorkPiece {
  return {
    projectId: P,
    since: at(30),
    starter: {
      type: "run_queued",
      recheck: null,
      outcome: null,
      automaticQa: false,
    },
    lastEventAt: at(5),
    runs: [],
    captures: [],
    reviews: [],
    ...overrides,
  };
}

/** The piece as Q2 answers it (JSON, as Postgres writes it). */
function pieceRow(p: ThemeStudioWorkPiece) {
  return {
    projectId: p.projectId,
    piece: {
      since: p.since,
      starter: p.starter?.type ?? null,
      recheck: p.starter?.recheck ?? null,
      outcome: p.starter?.outcome ?? null,
      automaticQa: p.starter?.automaticQa ? "true" : null,
      lastEventAt: p.lastEventAt,
      runs: p.runs,
      captures: p.captures,
      reviews: p.reviews,
    },
  };
}

const context = { nowIso: NOW, checksOn: true, working: true };
const shape = (steps: ReturnType<typeof buildThemeStudioSteps>) =>
  steps.map((s) => [s.key, s.state, s.label, s.detail]);

beforeEach(() => {
  resetThemeStudioProgressCaches();
  h.config.autoQaEnabled = true;
  h.config.generationEnabled = true;
  h.config.disabledModels = new Set();
  h.evidence = { ok: true, acceptanceRunId: "a1" };
});

// ---------------------------------------------------------- copied constants

describe("constants copied from files this read must not load", () => {
  it("refuses an answer at the same count as the server (repository.ts)", () => {
    const own = /const MAX_REVISION_MESSAGES = (\d+);/.exec(
      readFileSync(join(ROOT, "lib/theme-studio/repository.ts"), "utf8"),
    )?.[1];
    expect(Number(own)).toBe(MAX_REVISION_MESSAGES);
  });

  it("waits out the design review's retry cooldown (visual-qa.ts)", () => {
    const own = /export const QA_RETRY_COOLDOWN_SECONDS = (\d+);/.exec(
      readFileSync(join(ROOT, "lib/theme-studio/visual-qa.ts"), "utf8"),
    )?.[1];
    expect(Number(own)).toBe(QA_RETRY_COOLDOWN_SECONDS);
  });
});

// ------------------------------------------------------------------- counts

describe("countCheckRunFindings: the server's own rules, grouped by kind", () => {
  it("counts serious findings of blocking gates by check and code", () => {
    const counts = countCheckRunFindings([
      {
        id: "browser.accessibility",
        required: true,
        status: "fail",
        findingsArray: true,
        findings: [
          {
            code: "color-contrast",
            severity: "serious",
            where: "phone390 · product",
            contrast: [{ target: ".pdp-price-base" }],
          },
          {
            code: "color-contrast",
            severity: "serious",
            where: "phone360 · product",
            contrast: [{ target: ".pdp-price-base" }],
          },
          { code: "region", severity: "minor" },
        ],
      },
      {
        id: "routes.links",
        required: true,
        status: "fail",
        findingsArray: true,
        // Stored before severity-v1: serious.
        findings: [{ code: "broken", where: "/about" }],
      },
      {
        id: "assets.integrity",
        required: true,
        status: "fail",
        findingsArray: true,
        findings: [
          { code: "missing", severity: "serious", where: "hero-main" },
        ],
      },
    ]);
    expect(counts.serious).toEqual([
      {
        key: "checks|browser.accessibility|color-contrast",
        storeMink: true,
        picture: false,
      },
      { key: "checks|routes.links|broken", storeMink: false, picture: false },
      {
        key: "checks|assets.integrity|missing",
        storeMink: false,
        picture: true,
      },
    ]);
    expect(counts.warnings).toEqual([]);
  });

  it("makes every finding of a gate that does not block a warning, by kind", () => {
    const counts = countCheckRunFindings([
      {
        id: "browser.tap_targets",
        required: true,
        status: "fail",
        findingsArray: true,
        findings: [
          { code: "small_target", severity: "minor" },
          { code: "small_target", severity: "minor" },
        ],
      },
      {
        id: "browser.performance",
        required: false,
        status: "advisory",
        findingsArray: true,
        findings: [{ code: "lcp", severity: "minor" }],
      },
      {
        id: "assets.integrity",
        required: true,
        status: "pass",
        findingsArray: true,
        findings: [{ code: "below_target", severity: "minor" }],
      },
    ]);
    expect(counts.serious).toEqual([]);
    expect(counts.warnings).toEqual([
      "checks|browser.tap_targets|small_target",
      "checks|browser.performance|lcp",
      "checks|assets.integrity|below_target",
    ]);
  });

  it("counts a blocking gate with nothing serious in it once, and skips what readAcceptanceReport skips", () => {
    const counts = countCheckRunFindings([
      {
        id: "browser.coverage",
        required: true,
        status: "skipped",
        findingsArray: true,
        findings: [],
      },
      {
        id: "not.a.gate",
        required: true,
        status: "fail",
        findingsArray: true,
        findings: [{ code: "x" }],
      },
      {
        id: "routes.render",
        required: true,
        status: "fail",
        findingsArray: false,
        findings: [],
      },
    ]);
    expect(counts.serious).toEqual([
      { key: "checks|browser.coverage|", storeMink: false, picture: false },
    ]);
  });

  it("is StoreMink's only when every finding of the kind is", () => {
    const counts = countCheckRunFindings([
      {
        id: "browser.accessibility",
        required: true,
        status: "fail",
        findingsArray: true,
        findings: [
          {
            code: "color-contrast",
            severity: "serious",
            contrast: [{ target: ".pdp-price-base" }],
          },
          {
            code: "color-contrast",
            severity: "serious",
            contrast: [{ target: "h1.hero" }],
          },
        ],
      },
    ]);
    expect(counts.serious[0].storeMink).toBe(false);
  });
});

// -------------------------------------------------------------------- steps

describe("the progress card's steps", () => {
  it("names each step of a build, with times, pictures so far and what is still to come", () => {
    const steps = buildThemeStudioSteps(
      piece({
        runs: [
          run(),
          run({
            id: "img-1",
            kind: "images",
            status: "running",
            automatic: true,
            createdAt: at(22),
            startedAt: at(21),
            finishedAt: null,
            outcomeKind: null,
            intentMs: null,
            draftMs: null,
            drawn: 8,
            checkpointAt: at(1),
            slotsRequested: 18,
            rateLimitDeferrals: 2,
          }),
        ],
        captures: [capture()],
        reviews: [review({ repairs: 0 })],
      }),
      context,
    );
    expect(shape(steps)).toEqual([
      ["brief", "done", "Read the brief", null],
      ["design", "done", "Designed the pages", null],
      ["layout_check", "done", "Layout check", null],
      [
        "pictures",
        "running",
        "Drawing pictures",
        "8 of 18. Google is accepting pictures slowly",
      ],
      ["final_check", "waiting", "Catalogue pictures and final checks", null],
      ["design_review", "waiting", "Design review", null],
    ]);
    // The brief took its intent stage's 50 s.
    expect(
      Date.parse(steps[0].finishedAt!) - Date.parse(steps[0].startedAt!),
    ).toBe(50_000);
    expect(steps[1].finishedAt).toBe(at(25));
    expect(steps[4].startedAt).toBeNull();
  });

  it("shows a repair as its own row and the checks of the newest round only", () => {
    const steps = buildThemeStudioSteps(
      piece({
        runs: [
          run(),
          run({
            id: "repair-1",
            kind: "revise",
            status: "running",
            automatic: true,
            qaIteration: 2,
            createdAt: at(6),
            startedAt: at(5),
            finishedAt: null,
          }),
        ],
        captures: [
          capture(),
          capture({
            id: "cap-2",
            phase: "final",
            key: "auto_final_x",
            createdAt: at(15),
            startedAt: at(15),
            finishedAt: at(13),
          }),
        ],
        reviews: [
          review(),
          review({
            id: "qa-2",
            phase: "final",
            status: "revision_queued",
            createdAt: at(13),
            startedAt: at(12),
            finishedAt: at(6),
            revisionRunId: "repair-1",
          }),
        ],
      }),
      context,
    );
    expect(shape(steps)).toEqual([
      ["brief", "done", "Read the brief", null],
      ["design", "done", "Designed the pages", null],
      [
        "repair_2",
        "running",
        "Fixing what the review found (round 2 of 3)",
        null,
      ],
      ["layout_check", "waiting", "Layout check", null],
      ["pictures", "waiting", "Draw the pictures", null],
      ["final_check", "waiting", "Catalogue pictures and final checks", null],
      ["design_review", "waiting", "Design review", null],
    ]);
    expect(new Set(steps.map((s) => s.key)).size).toBe(steps.length);
  });

  it("says how many problems the layout check fixed, and a fix from the layout check", () => {
    const steps = buildThemeStudioSteps(
      piece({
        runs: [
          run(),
          run({
            id: "repair-1",
            kind: "revise",
            automatic: true,
            qaIteration: 1,
            createdAt: at(20),
            startedAt: at(20),
            finishedAt: at(18),
          }),
        ],
        captures: [
          capture(),
          capture({
            id: "cap-2",
            createdAt: at(17),
            startedAt: at(17),
            finishedAt: at(16),
          }),
        ],
        reviews: [
          review({
            status: "revision_queued",
            revisionRunId: "repair-1",
            repairs: 2,
            finishedAt: at(20),
          }),
          review({
            id: "qa-2",
            createdAt: at(16),
            startedAt: at(16),
            finishedAt: at(15.5),
          }),
        ],
      }),
      context,
    );
    const repair = steps.find((s) => s.key === "repair_1")!;
    expect(repair.label).toBe(
      "Fixed what the layout check found (round 1 of 3)",
    );
    expect(repair.state).toBe("done");
    expect(steps.find((s) => s.key === "layout_check")).toMatchObject({
      state: "done",
      detail: "Fixed 2 problems",
    });
    expect(steps.map((s) => s.key).indexOf("repair_1")).toBeLessThan(
      steps.map((s) => s.key).indexOf("layout_check"),
    );
  });

  it("waits to start, with a next try only when the run really waits for one", () => {
    const queued = buildThemeStudioSteps(
      piece({
        runs: [
          run({
            status: "queued",
            startedAt: null,
            finishedAt: null,
            intentMs: null,
            draftMs: null,
          }),
        ],
      }),
      context,
    );
    expect(
      queued.slice(0, 2).map((s) => [s.key, s.state, s.nextTryAt]),
    ).toEqual([
      ["brief", "waiting", null],
      ["design", "waiting", null],
    ]);
    const deferred = buildThemeStudioSteps(
      piece({
        runs: [
          run({
            status: "queued",
            finishedAt: null,
            responses: 1,
            firstResponseAt: at(28),
            retryNotBefore: at(-2),
            intentMs: null,
            draftMs: null,
          }),
        ],
      }),
      context,
    );
    expect(deferred[0]).toMatchObject({
      key: "brief",
      state: "done",
      finishedAt: at(28),
    });
    expect(deferred[1]).toMatchObject({
      key: "design",
      state: "waiting",
      label: "Design the pages",
      nextTryAt: at(-2),
    });
  });

  it("reads a change, an answer and a check in their own words", () => {
    const change = buildThemeStudioSteps(
      piece({
        starter: {
          type: "revision_requested",
          recheck: null,
          outcome: null,
          automaticQa: false,
        },
        runs: [
          run({
            kind: "revise",
            status: "running",
            finishedAt: null,
            responses: 1,
            firstResponseAt: at(28),
          }),
        ],
      }),
      context,
    );
    expect(change.slice(0, 2).map((s) => s.label)).toEqual([
      "Read your change",
      "Changing the pages",
    ]);
    const answer = buildThemeStudioSteps(
      piece({
        starter: {
          type: "details_added",
          recheck: null,
          outcome: null,
          automaticQa: false,
        },
        runs: [run({ status: "running", finishedAt: null })],
      }),
      context,
    );
    expect(answer[0].label).toBe("Reading your answer");
    const recheck = buildThemeStudioSteps(
      piece({
        starter: {
          type: "capture_requested",
          recheck: "publish_recheck",
          outcome: null,
          automaticQa: false,
        },
        captures: [
          capture({
            phase: "final",
            status: "running",
            key: "recheck_publish_recheck_x",
            finishedAt: null,
          }),
        ],
      }),
      context,
    );
    expect(shape(recheck)).toEqual([
      ["final_check", "running", "Checking every page on today's build", null],
      ["design_review", "waiting", "Design review", null],
    ]);
  });

  it("asks questions, fails with a reason, and skips a layout check the change did not need", () => {
    expect(
      shape(
        buildThemeStudioSteps(
          piece({ runs: [run({ outcomeKind: "clarify", questions: 2 })] }),
          { ...context, working: false },
        ),
      ),
    ).toEqual([
      ["brief", "done", "Read the brief", "Asked 2 questions"],
      ["design", "skipped", "Design the pages", null],
    ]);
    const failed = buildThemeStudioSteps(
      piece({
        runs: [
          run({
            status: "failed",
            errorCode: "output_truncated",
            outcomeStage: "draft",
          }),
        ],
      }),
      { ...context, working: false },
    );
    expect(failed[1]).toMatchObject({
      key: "design",
      state: "failed",
      detail: "The model ran out of room before it finished.",
    });
    const skipped = buildThemeStudioSteps(
      piece({
        runs: [run()],
        captures: [
          capture({
            phase: "final",
            key: "auto_final_x",
            createdAt: at(20),
            startedAt: at(20),
            finishedAt: null,
            status: "running",
          }),
        ],
      }),
      context,
    );
    expect(shape(skipped)).toEqual([
      ["brief", "done", "Read the brief", null],
      ["design", "done", "Designed the pages", null],
      ["layout_check", "skipped", "Layout check", null],
      ["pictures", "skipped", "Draw the pictures", "No pictures to draw"],
      [
        "final_check",
        "running",
        "Taking catalogue pictures and checking every page",
        null,
      ],
      ["design_review", "waiting", "Design review", null],
    ]);
  });

  it("checks pictures before the design review, waiting out the review's cooldown", () => {
    const steps = buildThemeStudioSteps(
      piece({
        runs: [run()],
        captures: [capture({ phase: "final", key: "auto_final_x" })],
        reviews: [
          review({
            phase: "final",
            status: "queued",
            finishedAt: null,
            updatedAt: at(0.5),
            photoState: "waiting",
            photoUnchecked: 3,
          }),
        ],
      }),
      context,
    );
    expect(steps.find((s) => s.key === "photo_check")).toMatchObject({
      state: "waiting",
      detail: "3 photos to check",
      nextTryAt: new Date(Date.parse(at(0.5)) + 60_000).toISOString(),
    });
    expect(steps.find((s) => s.key === "design_review")).toMatchObject({
      state: "waiting",
      nextTryAt: null,
    });
    // The cooldown is over: the review waits only for a worker to claim it.
    const due = buildThemeStudioSteps(
      piece({
        runs: [run()],
        captures: [capture({ phase: "final", key: "auto_final_x" })],
        reviews: [
          review({
            phase: "final",
            status: "queued",
            finishedAt: null,
            updatedAt: at(2),
            photoState: "waiting",
            photoUnchecked: 3,
          }),
        ],
      }),
      context,
    );
    expect(due.find((s) => s.key === "photo_check")?.nextTryAt).toBeNull();
  });

  it("says a picture run's next try once, and only while it is still to come", () => {
    const drawing = (retryNotBefore: string) =>
      buildThemeStudioSteps(
        piece({
          runs: [
            run(),
            run({
              id: "img-1",
              kind: "images",
              status: "queued",
              automatic: true,
              createdAt: at(22),
              startedAt: at(21),
              finishedAt: null,
              outcomeKind: null,
              intentMs: null,
              draftMs: null,
              drawn: 8,
              checkpointAt: at(3),
              slotsRequested: 18,
              rateLimitDeferrals: 1,
              retryNotBefore,
            }),
          ],
          captures: [capture()],
          reviews: [review()],
        }),
        context,
      ).find((s) => s.key === "pictures")!;
    const waiting = drawing(at(-3));
    expect(waiting).toMatchObject({
      state: "running",
      detail: "8 of 18. Google is accepting pictures slowly",
      nextTryAt: at(-3),
    });
    // A next try already past is no wait: the run waits only for a worker.
    const due = drawing(at(2));
    expect(due).toMatchObject({
      state: "running",
      detail: "8 of 18. Google is accepting pictures slowly",
      nextTryAt: null,
    });
    for (const step of [waiting, due])
      expect(step.detail).not.toMatch(/next try/i);
  });

  it("leaves out the checks a stopped repair will not run again", () => {
    const steps = buildThemeStudioSteps(
      piece({
        runs: [
          run(),
          run({
            id: "repair-1",
            kind: "revise",
            automatic: true,
            qaIteration: 1,
            status: "failed",
            errorCode: "invalid_output",
            createdAt: at(6),
            startedAt: at(5),
            finishedAt: at(2),
          }),
        ],
        captures: [capture()],
        reviews: [
          review({
            status: "revision_queued",
            revisionRunId: "repair-1",
            finishedAt: at(6),
          }),
        ],
      }),
      { ...context, working: false },
    );
    expect(shape(steps)).toEqual([
      ["brief", "done", "Read the brief", null],
      ["design", "done", "Designed the pages", null],
      [
        "repair_1",
        "failed",
        "Fixing what the layout check found (round 1 of 3)",
        "The model's answer still failed its checks after its repair attempts.",
      ],
    ]);
  });

  it("is empty when nothing was ever started", () => {
    expect(
      buildThemeStudioSteps(piece({ starter: null }), {
        ...context,
        working: false,
      }),
    ).toEqual([]);
  });
});

// -------------------------------------------------- readThemeStudioProgress

describe("readThemeStudioProgress", () => {
  it("answers null for a malformed or unknown project, reading nothing for the first", async () => {
    const { db, seen } = scripted(() => []);
    expect(await readThemeStudioProgress(db, { projectId: "nope" })).toBeNull();
    expect(seen).toEqual([]);
    expect(await readThemeStudioProgress(db, { projectId: P })).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("assembles a building theme from two queries, without the evidence", async () => {
    const work = piece({
      runs: [
        run(),
        run({
          id: "img-1",
          kind: "images",
          status: "running",
          automatic: true,
          createdAt: at(22),
          startedAt: at(21),
          finishedAt: null,
          drawn: 8,
          checkpointAt: at(1),
          slotsRequested: 18,
        }),
      ],
      captures: [capture()],
      reviews: [review()],
    });
    const { db, seen } = scripted((q) =>
      isFacts(q)
        ? [fact({ status: "generating", currentVersionId: V })]
        : isPiece(q)
          ? [pieceRow(work)]
          : isVersion(q)
            ? [
                {
                  id: V,
                  digest: "d".repeat(64),
                  art: 3,
                  categories: 0,
                  previewAssetId: null,
                },
              ]
            : [],
    );
    const progress = (await readThemeStudioProgress(db, { projectId: P }))!;
    expect(progress.status.working).toEqual({
      kind: "building",
      step: "Drawing pictures",
      since: at(30),
      lastProgressAt: at(1),
      nextTryAt: null,
    });
    expect(progress.status.now).toBe(NOW);
    expect(progress.revision).toBe(4);
    expect(progress.versionIds).toEqual([V]);
    expect(progress.status.pictures.missing).toBe(3);
    // No 429 met: no word about Google.
    expect(progress.steps.find((s) => s.key === "pictures")?.detail).toBe(
      "8 of 18",
    );
    expect(progress.steps.map((s) => s.key)).toEqual([
      "brief",
      "design",
      "layout_check",
      "pictures",
      "final_check",
      "design_review",
    ]);
    expect(studioStatus(progress.status)).toMatchObject({
      row: 5,
      words: "Building: drawing pictures (30 min)",
    });
    // Working: the theme file is not validated for the evidence.
    expect(evidenceRead).not.toHaveBeenCalled();
    expect(progress.status.evidence).toBeNull();
    expect(seen.filter(isFacts)).toHaveLength(1);
    expect(seen.filter(isPiece)).toHaveLength(1);
    expect(progress.updatedAt).toBe(at(1));
  });

  it("reads the evidence for a theme Ready to publish, counts its warnings, and caches what never changes", async () => {
    const answer = (q: Query) =>
      isFacts(q)
        ? [
            fact({
              status: "candidate",
              checkRunId: A,
              checkRunStatus: "passed",
              checkRunBuild: "build-today",
              checkRunFinishedAt: "2026-10-25 15:00:00+05:30",
              reviewId: "qa-9",
              reviewStatus: "passed",
              reviewOutcome: "taste",
              reviewAcceptanceRunId: A,
              reviewWarnings: [
                { code: "low_score", row: "imagery", score: 3 },
                { code: "low_score", row: "typography", score: 3 },
              ],
            }),
          ]
        : isPiece(q)
          ? [pieceRow(piece({ runs: [run()] }))]
          : isFindings(q)
            ? [
                {
                  id: A,
                  status: "passed",
                  gates: [
                    {
                      id: "browser.tap_targets",
                      required: true,
                      status: "fail",
                      findingsArray: true,
                      findings: [
                        {
                          code: "small_target",
                          severity: "minor",
                          where: "phone390 · shop",
                        },
                      ],
                    },
                  ],
                },
              ]
            : isVersion(q)
              ? [
                  {
                    id: V,
                    digest: "d".repeat(64),
                    art: 0,
                    categories: 0,
                    previewAssetId: "44444444-4444-4444-8444-444444444444",
                  },
                ]
              : [];
    const { db, seen } = scripted(answer);
    const first = (await readThemeStudioProgress(db, { projectId: P }))!;
    expect(evidenceRead).toHaveBeenCalledWith(db, { projectId: P });
    expect(first.status.evidence).toEqual({ ok: true, acceptanceRunId: "a1" });
    expect(first.status.checks).toMatchObject({
      serious: 0,
      warnings: 2,
      checkRun: { id: A, state: "passed", todaysBuild: true },
      review: { id: "qa-9", outcome: "taste", boundToCheckRun: true },
    });
    expect(studioStatus(first.status)).toMatchObject({
      row: 15,
      words: "Ready to publish, 2 warnings",
    });
    // A second read: the finished check run and the version come from memory.
    await readThemeStudioProgress(db, { projectId: P });
    expect(seen.filter(isFindings)).toHaveLength(1);
    expect(seen.filter(isVersion)).toHaveLength(1);
  });

  it("opens the questions, and refuses another round at the server's limit", async () => {
    const asked = (overrides: Record<string, unknown>) => {
      const { db } = scripted((q) =>
        isFacts(q)
          ? [
              fact({
                status: "blocked",
                latestOutcomeKind: "clarify",
                latestQuestionCount: 2,
                questionRounds: 1,
                ...overrides,
              }),
            ]
          : isPiece(q)
            ? [
                pieceRow(
                  piece({
                    runs: [run({ outcomeKind: "clarify", questions: 2 })],
                  }),
                ),
              ]
            : [],
      );
      return readThemeStudioProgress(db, { projectId: P });
    };
    const open = (await asked({}))!;
    expect(open.status.questions).toEqual({
      open: true,
      count: 2,
      askedAt: "2026-10-25T08:40:00.000Z",
      rounds: 1,
      tooManyRounds: false,
    });
    expect(studioStatus(open.status).row).toBe(7);
    const limit = (await asked({
      latestRunKind: "revise",
      latestContextCount: MAX_REVISION_MESSAGES,
    }))!;
    expect(limit.status.questions.tooManyRounds).toBe(true);
    expect(studioStatus(limit.status).row).toBe(8);
    const setAside = (await asked({ questionsSetAside: true }))!;
    expect(setAside.status.questions.open).toBe(false);
  });

  it("finds the stop of the newest piece of work, and never a deploy's re-capture", async () => {
    const read = async (work: ThemeStudioWorkPiece) => {
      const { db } = scripted((q) =>
        isFacts(q) ? [fact()] : isPiece(q) ? [pieceRow(work)] : [],
      );
      return (await readThemeStudioProgress(db, { projectId: P }))!.status.stop;
    };
    expect(
      await read(
        piece({
          runs: [run()],
          captures: [
            capture({
              status: "failed",
              errorCode: "capture_timeout",
              finishedAt: at(2),
            }),
          ],
        }),
      ),
    ).toEqual({
      kind: "capture",
      code: "capture_timeout",
      at: at(2),
      runId: null,
    });
    expect(
      await read(
        piece({
          runs: [run({ status: "cancelled", finishedAt: at(1) })],
          reviews: [
            review({
              status: "failed",
              errorCode: "cancelled",
              finishedAt: at(1),
            }),
          ],
        }),
      ),
    ).toEqual({ kind: "run", code: "cancelled", at: at(1), runId: "run-1" });
    expect(
      await read(
        piece({
          runs: [run()],
          reviews: [
            review({
              phase: "final",
              status: "failed",
              errorCode: "acceptance_build_changed",
              finishedAt: at(1),
            }),
          ],
        }),
      ),
    ).toBeNull();
    // Settled well since: no stop.
    expect(
      await read(
        piece({
          runs: [run()],
          captures: [
            capture({
              status: "failed",
              errorCode: "capture_timeout",
              finishedAt: at(10),
            }),
            capture({ id: "cap-2", createdAt: at(9), finishedAt: at(8) }),
          ],
        }),
      ),
    ).toBeNull();
  });

  it("counts a failed picture run only while it belongs to the newest piece of work", async () => {
    const failedRun = {
      pictureRunId: "img-1",
      pictureRunStatus: "failed",
      pictureRunError: "image_provider_unavailable",
      pictureRunFinishedAt: "2026-10-25 15:25:00+05:30",
    };
    const redraw = run({
      id: "img-1",
      kind: "images",
      status: "failed",
      errorCode: "image_provider_unavailable",
      createdAt: at(10),
      startedAt: at(9),
      finishedAt: at(5),
      outcomeKind: null,
      intentMs: null,
      draftMs: null,
    });
    const read = async (status: string, work: ThemeStudioWorkPiece | null) => {
      const { db } = scripted((q) =>
        isFacts(q)
          ? [fact({ status, ...failedRun })]
          : isPiece(q)
            ? work
              ? [pieceRow(work)]
              : []
            : [],
      );
      return (await readThemeStudioProgress(db, { projectId: P }))!.status;
    };
    // A Redraw that failed just now: Retry, ahead of everything below it.
    const fresh = await read(
      "ready",
      piece({
        since: at(10),
        starter: {
          type: "images_requested",
          recheck: null,
          outcome: null,
          automaticQa: false,
        },
        runs: [redraw],
      }),
    );
    expect(fresh.pictures.lastRun).toMatchObject({
      id: "img-1",
      state: "failed",
      errorCode: "image_provider_unavailable",
    });
    expect(studioStatus(fresh)).toMatchObject({
      row: 13,
      words: "Drawing pictures didn't finish",
      primary: { kind: "retry_pictures" },
    });
    // Check again passed since: the failed run is history, Publish is back.
    const rechecked = await read(
      "candidate",
      piece({
        since: at(4),
        starter: {
          type: "capture_requested",
          recheck: "check_again",
          outcome: null,
          automaticQa: false,
        },
        captures: [
          capture({
            phase: "final",
            key: "recheck_check_again_x",
            createdAt: at(4),
            startedAt: at(4),
            finishedAt: at(3),
          }),
        ],
        reviews: [
          review({
            phase: "final",
            createdAt: at(3),
            startedAt: at(3),
            finishedAt: at(2),
          }),
        ],
      }),
    );
    expect(rechecked.pictures.lastRun).toBeNull();
    expect(studioStatus(rechecked)).toMatchObject({
      row: 15,
      primary: { kind: "publish" },
    });
    // Make current moved on from it the same way.
    const restored = await read(
      "ready",
      piece({
        since: at(4),
        starter: {
          type: "version_restored",
          recheck: null,
          outcome: "ready",
          automaticQa: false,
        },
      }),
    );
    expect(restored.pictures.lastRun).toBeNull();
    expect(studioStatus(restored).row).not.toBe(13);
    // With no piece of work read, it counts as before.
    expect((await read("ready", null)).pictures.lastRun?.state).toBe("failed");
  });

  it("never reads the evidence while something works, whatever the state says", async () => {
    const { db } = scripted((q) =>
      isFacts(q)
        ? [fact({ status: "candidate" })]
        : isPiece(q)
          ? [
              pieceRow(
                piece({
                  captures: [
                    capture({
                      phase: "final",
                      status: "queued",
                      startedAt: null,
                      finishedAt: null,
                      createdAt: at(1),
                    }),
                  ],
                }),
              ),
            ]
          : [],
    );
    const progress = (await readThemeStudioProgress(db, { projectId: P }))!;
    expect(progress.status.working).not.toBeNull();
    expect(evidenceRead).not.toHaveBeenCalled();
    expect(progress.status.evidence).toBeNull();
  });

  it("names the operator's own change before the capture that checks it", async () => {
    const read = async (starter: ThemeStudioWorkPiece["starter"]) => {
      const { db } = scripted((q) =>
        isFacts(q)
          ? [fact({ status: "generating" })]
          : isPiece(q)
            ? [
                pieceRow(
                  piece({
                    starter,
                    captures: [
                      capture({
                        phase: "final",
                        status: "running",
                        key: "recheck_check_again_44444444-4444-4444-8444-444444444444",
                        finishedAt: null,
                      }),
                    ],
                  }),
                ),
              ]
            : [],
      );
      return (await readThemeStudioProgress(db, { projectId: P }))!.status
        .working?.kind;
    };
    // Make current of a design that never passed: still your change.
    expect(
      await read({
        type: "version_restored",
        recheck: null,
        outcome: "checking",
        automaticQa: false,
      }),
    ).toBe("checking_change");
    expect(
      await read({
        type: "slot_images_replaced",
        recheck: null,
        outcome: null,
        automaticQa: true,
      }),
    ).toBe("checking_change");
    // Check again, or Make current of a design that passed: a re-check.
    expect(
      await read({
        type: "capture_requested",
        recheck: "check_again",
        outcome: null,
        automaticQa: false,
      }),
    ).toBe("rechecking");
    expect(
      await read({
        type: "version_restored",
        recheck: null,
        outcome: "rechecking",
        automaticQa: false,
      }),
    ).toBe("rechecking");
    // A re-check's capture alone says so too.
    expect(await read(null)).toBe("rechecking");
  });

  it("reads the switches, and stuck work past 20 minutes", async () => {
    h.config.generationEnabled = false;
    h.config.disabledModels = new Set(["gemini-3.8-flash"]);
    h.config.autoQaEnabled = false;
    const { db } = scripted((q) =>
      isFacts(q)
        ? [fact({ status: "generating" })]
        : isPiece(q)
          ? [
              pieceRow(
                piece({
                  lastEventAt: at(40),
                  runs: [run()],
                  captures: [
                    capture({
                      phase: "final",
                      status: "queued",
                      startedAt: null,
                      finishedAt: null,
                      createdAt: at(40),
                      updatedAt: at(40),
                    }),
                  ],
                }),
              ),
            ]
          : [],
    );
    const progress = (await readThemeStudioProgress(db, { projectId: P }))!;
    expect(progress.status.switches).toEqual({
      buildingOff: true,
      modelOff: true,
      checksOff: true,
    });
    expect(progress.status.working?.lastProgressAt).toBe(at(25));
    expect(studioStatus(progress.status).row).toBe(6);
  });
});

// -------------------------------------------------------------------- list

describe("listThemeStudioProjectsForConsole", () => {
  const ids = Array.from(
    { length: 6 },
    (_, i) => `${i}1111111-1111-4111-8111-111111111111`,
  );
  const facts = [
    fact({
      projectId: ids[0],
      status: "candidate",
      verdictRunId: A,
      verdictRunStatus: "passed",
      verdictRunBuild: "build-today",
      verdictRunDigest: "d".repeat(64),
      verdictRunHasEvidence: true,
      boundReviewStatus: "passed",
      boundReviewDigest: "d".repeat(64),
      boundReviewBuild: "build-today",
    }),
    fact({
      projectId: ids[1],
      status: "candidate",
      verdictRunId: A,
      verdictRunStatus: "passed",
      verdictRunBuild: "build-old",
      verdictRunDigest: "d".repeat(64),
      verdictRunHasEvidence: true,
      // Its review is bound and passed: only the build is not today's.
      boundReviewStatus: "passed",
      boundReviewDigest: "d".repeat(64),
      boundReviewBuild: "build-old",
    }),
    fact({ projectId: ids[2], status: "generating" }),
    fact({
      projectId: ids[3],
      status: "archived",
      archivedAt: "2026-10-25 12:00:00+05:30",
    }),
    fact({
      projectId: ids[4],
      status: "published",
      releaseVersion: "1.0.0",
      releasedAt: "2026-10-20 12:00:00+05:30",
      catalogVisibility: "public",
    }),
    fact({
      projectId: ids[5],
      status: "draft",
      currentVersionId: null,
      currentPackageDigest: null,
    }),
  ];

  function database() {
    return scripted((q) => {
      if (isFacts(q)) return facts;
      if (isPiece(q))
        return projectIdsOf(q).map((id) =>
          pieceRow(
            piece({
              projectId: id,
              runs:
                id === ids[2]
                  ? [run({ status: "running", finishedAt: null })]
                  : [],
            }),
          ),
        );
      if (isVersion(q))
        return [
          {
            id: V,
            digest: "d".repeat(64),
            art: 0,
            categories: 0,
            previewAssetId: "55555555-5555-4555-8555-555555555555",
          },
        ];
      return [];
    });
  }

  it("counts every filter and returns the asked one's rows, in a fixed number of queries", async () => {
    const { db, seen } = database();
    const list = await listThemeStudioProjectsForConsole(db, { filter: "all" });
    expect(list.counts).toEqual({
      all: 6,
      ready: 2,
      building: 1,
      archived: 1,
      live: 1,
      needs_you: 1,
    });
    expect(list.rows.map((r) => r.projectId)).toEqual(ids);
    expect(list.rows.map((r) => studioStatus(r.status).row)).toEqual([
      15, 16, 5, 4, 1, 18,
    ]);
    // The list's evidence: the same three conditions as Publish.
    expect(list.rows.map((r) => r.status.evidence)).toEqual([
      { ok: true, acceptanceRunId: A },
      { ok: false, reason: "old_build" },
      null,
      null,
      null,
      null,
    ]);
    // Never one query per row: the facts, the pieces, the versions.
    expect(seen.length).toBeLessThanOrEqual(4);
    expect(projectIdsOf(seen.filter(isPiece)[0])).toEqual([
      ids[0],
      ids[1],
      ids[2],
      ids[5],
    ]);
    // The list never validates a theme file for its evidence.
    expect(evidenceRead).not.toHaveBeenCalled();
    expect(list.rows[2].activeStep).toMatchObject({
      key: "brief",
      state: "running",
    });
    expect(list.rows[0].activeStep).toBeNull();
    expect(list.rows[4].pictureUrl).toBe(
      "/api/theme-studio/images/55555555-5555-4555-8555-555555555555",
    );
    expect(list.rows[5].pictureUrl).toBeNull();
  });

  it("returns only the asked filter's rows, with the same counts", async () => {
    const { db } = database();
    const ready = await listThemeStudioProjectsForConsole(db, {
      filter: "ready",
    });
    expect(ready.rows.map((r) => r.projectId)).toEqual([ids[0], ids[1]]);
    expect(ready.counts.all).toBe(6);
    const live = await listThemeStudioProjectsForConsole(db, {
      filter: "live",
    });
    expect(live.rows.map((r) => r.name)).toEqual(["Aurora"]);
  });

  it("answers an empty list with zero counts", async () => {
    const { db } = scripted(() => []);
    expect(
      await listThemeStudioProjectsForConsole(db, { filter: "all" }),
    ).toEqual({
      rows: [],
      counts: {
        all: 0,
        needs_you: 0,
        building: 0,
        ready: 0,
        live: 0,
        archived: 0,
      },
    });
  });
});

// ---------------------------------------------------------- build time range

describe("readThemeStudioBuildTimeRange", () => {
  it("says 35 to 75 minutes until 10 builds finished", async () => {
    const { db, seen } = scripted(() => [{ seconds: 2400 }, { seconds: 3000 }]);
    expect(await readThemeStudioBuildTimeRange(db)).toEqual({
      fromMinutes: 35,
      toMinutes: 75,
      basedOn: 0,
      source: "default",
    });
    expect(seen[0].sql).toContain("provider <> 'fake'");
    expect(seen[0].sql).toContain("'auto_qa_passed'");
  });

  it("rounds the shortest and longest of the last 10 outward to 5", async () => {
    const minutes = [22.4, 31, 40, 44, 51, 52, 58, 61, 63, 66.2];
    const { db } = scripted(() =>
      minutes.map((m) => ({ seconds: String(m * 60) })),
    );
    expect(await readThemeStudioBuildTimeRange(db)).toEqual({
      fromMinutes: 20,
      toMinutes: 70,
      basedOn: 10,
      source: "measured",
    });
  });
});

// --------------------------------------------------------- check screenshots

describe("check screenshots", () => {
  const sample = (
    surface: string,
    viewport: string,
    states: { state: string; measured: boolean }[] = [],
  ) => ({
    surface,
    viewport,
    states,
  });
  const shot = (n: number) => `6666666${n}-6666-4666-8666-666666666666`;

  it("pairs each screenshot with the page and width it shows, and derives the coverage", async () => {
    const { db, seen } = scripted((q) => {
      if (q.sql.includes("p.current_version_id AS"))
        return [{ currentVersionId: V, versionId: V, visibility: "operator" }];
      if (q.sql.includes("screenshot_asset_ids"))
        return [
          {
            capturedAt: "2026-10-25 15:00:00+05:30",
            assetIds: [shot(1), shot(2), shot(3), shot(4), shot(5)],
            checkRunId: A,
            build: "build-today",
            samples: [
              sample("home", "phone390", [
                { state: "cart", measured: true },
                { state: "menu", measured: true },
                { state: "account", measured: false },
              ]),
              sample("cart", "phone390"),
              // Panels count only on the home page, where the probe opens them.
              sample("shop", "phone390", [
                { state: "sign_in", measured: true },
              ]),
              sample("home", "desktop1440", [
                { state: "search", measured: true },
              ]),
              sample("not_found", "desktop1440"),
            ],
          },
        ];
      if (q.sql.includes("a.width"))
        return [
          { id: shot(1), width: 390, height: 4100 },
          { id: shot(2), width: 390, height: 1200 },
          { id: shot(4), width: 1440, height: 5200 },
          { id: shot(5), width: 1440, height: 900 },
        ];
      return [];
    });
    const result = (await listThemeStudioCheckScreenshots(db, {
      projectId: P,
      versionId: null,
    }))!;
    expect(result).toEqual({
      versionId: V,
      checkRunId: A,
      capturedAt: "2026-10-25T09:30:00.000Z",
      build: "build-today",
      coverage: {
        pages: ["home", "cart", "shop", "not_found"],
        widths: [390, 1440],
        panels: ["menu", "search", "cart"],
        cartWasEmpty: true,
      },
      samples: [
        {
          assetId: shot(1),
          page: "home",
          viewport: "phone390",
          width: 390,
          height: 4100,
        },
        {
          assetId: shot(2),
          page: "cart",
          viewport: "phone390",
          width: 390,
          height: 1200,
        },
        // shot 3's asset row is gone: left out, never invented.
        {
          assetId: shot(4),
          page: "home",
          viewport: "desktop1440",
          width: 1440,
          height: 5200,
        },
        {
          assetId: shot(5),
          page: "not_found",
          viewport: "desktop1440",
          width: 1440,
          height: 900,
        },
      ],
    });
    const sizes = seen.find((q) => q.sql.includes("a.width"))!;
    expect(sizes.sql).toContain("a.purpose = 'qa_screenshot'");
    expect(sizes.params).toContain(P);
    const reviewQuery = seen.find((q) =>
      q.sql.includes("screenshot_asset_ids"),
    )!;
    expect(reviewQuery.sql).toContain(
      "cardinality(q.screenshot_asset_ids) > 0",
    );
    expect(reviewQuery.sql).toContain(
      "coalesce(q.browser_report ->> 'phase', 'final') = 'final'",
    );
  });

  it("calls the cart empty when only the cart drawer was measured, and never when neither was", async () => {
    const read = async (samples: unknown[]) => {
      const { db } = scripted((q) => {
        if (q.sql.includes("p.current_version_id AS"))
          return [
            { currentVersionId: V, versionId: V, visibility: "operator" },
          ];
        if (q.sql.includes("screenshot_asset_ids"))
          return [
            {
              capturedAt: "2026-10-25 15:00:00+05:30",
              assetIds: [shot(1)],
              checkRunId: A,
              build: "b",
              samples,
            },
          ];
        return [];
      });
      return (await listThemeStudioCheckScreenshots(db, {
        projectId: P,
        versionId: null,
      }))!.coverage.cartWasEmpty;
    };
    expect(
      await read([
        sample("home", "phone390", [{ state: "cart", measured: true }]),
      ]),
    ).toBe(true);
    expect(
      await read([
        sample("home", "phone390", [{ state: "cart", measured: false }]),
      ]),
    ).toBe(false);
  });

  it("refuses an unknown project or a design that is not an operator-visible version of it", async () => {
    const none = scripted(() => []);
    expect(
      await listThemeStudioCheckScreenshots(none.db, {
        projectId: P,
        versionId: null,
      }),
    ).toBeNull();
    const hidden = scripted((q) =>
      q.sql.includes("p.current_version_id AS")
        ? [{ currentVersionId: V, versionId: V, visibility: "internal" }]
        : [],
    );
    expect(
      await listThemeStudioCheckScreenshots(hidden.db, {
        projectId: P,
        versionId: V,
      }),
    ).toBeNull();
    const foreign = scripted((q) =>
      q.sql.includes("p.current_version_id AS")
        ? [{ currentVersionId: V, versionId: null, visibility: null }]
        : [],
    );
    expect(
      await listThemeStudioCheckScreenshots(foreign.db, {
        projectId: P,
        versionId: A,
      }),
    ).toBeNull();
    expect(
      await listThemeStudioCheckScreenshots(none.db, {
        projectId: "x",
        versionId: null,
      }),
    ).toBeNull();
    expect(
      await listThemeStudioCheckScreenshots(none.db, {
        projectId: P,
        versionId: "x",
      }),
    ).toBeNull();
  });

  it("answers empty lists for a design no final check photographed, or no design at all", async () => {
    const noDesign = scripted((q) =>
      q.sql.includes("p.current_version_id AS")
        ? [{ currentVersionId: null, versionId: null, visibility: null }]
        : [],
    );
    expect(
      await listThemeStudioCheckScreenshots(noDesign.db, {
        projectId: P,
        versionId: null,
      }),
    ).toEqual({
      versionId: null,
      checkRunId: null,
      capturedAt: null,
      build: null,
      coverage: { pages: [], widths: [], panels: [], cartWasEmpty: false },
      samples: [],
    });
    const unphotographed = scripted((q) =>
      q.sql.includes("p.current_version_id AS")
        ? [{ currentVersionId: V, versionId: V, visibility: "operator" }]
        : [],
    );
    expect(
      (await listThemeStudioCheckScreenshots(unphotographed.db, {
        projectId: P,
        versionId: V,
      }))!.samples,
    ).toEqual([]);
  });

  it("serves one screenshot's bytes only as a check screenshot of that project", async () => {
    const bytes = Buffer.from("RIFF0000WEBPdata");
    const { db, seen } = scripted(() => [{ bytes, mediaType: "image/webp" }]);
    expect(
      await readThemeStudioCheckScreenshot(db, {
        projectId: P,
        assetId: shot(1),
      }),
    ).toEqual({
      bytes,
      contentType: "image/webp",
    });
    expect(seen[0].sql).toContain("a.purpose = 'qa_screenshot'");
    expect(seen[0].sql).toContain("a.project_id = $2::uuid");
    expect(seen[0].params).toEqual([shot(1), P]);
    const png = scripted(() => [{ bytes, mediaType: "image/png" }]);
    expect(
      (
        await readThemeStudioCheckScreenshot(png.db, {
          projectId: P,
          assetId: shot(1),
        })
      )?.contentType,
    ).toBe("image/png");
    // Anything else stored there is never served.
    const jpeg = scripted(() => [{ bytes, mediaType: "image/jpeg" }]);
    expect(
      await readThemeStudioCheckScreenshot(jpeg.db, {
        projectId: P,
        assetId: shot(1),
      }),
    ).toBeNull();
    const missing = scripted(() => []);
    expect(
      await readThemeStudioCheckScreenshot(missing.db, {
        projectId: P,
        assetId: shot(1),
      }),
    ).toBeNull();
    expect(
      await readThemeStudioCheckScreenshot(missing.db, {
        projectId: P,
        assetId: "x",
      }),
    ).toBeNull();
  });
});

// ------------------------------------------------------------ narrow reads

describe("narrow reads", () => {
  it("never selects picture bytes or a whole stored document in the progress and list reads", async () => {
    const { db, seen } = scripted((q) =>
      isFacts(q)
        ? [fact({ checkRunId: A, checkRunStatus: "running" })]
        : isPiece(q)
          ? [pieceRow(piece())]
          : [],
    );
    await readThemeStudioProgress(db, { projectId: P });
    await listThemeStudioProjectsForConsole(db, { filter: "all" });
    await listThemeStudioCheckScreenshots(db, {
      projectId: P,
      versionId: null,
    });
    expect(seen.length).toBeGreaterThan(4);
    for (const query of seen) {
      expect(query.sql).not.toMatch(/\bimage_bytes\b/);
      expect(query.sql).not.toMatch(/\bbytes\b/);
      // Stored documents only through a JSON path.
      expect(query.sql).not.toMatch(
        /\b(?:package_json|browser_report|vision_report|server_report|usage|outcome_detail|response_json|intent_json)\b(?!\s*(?:->|#>))/,
      );
    }
  });
});
