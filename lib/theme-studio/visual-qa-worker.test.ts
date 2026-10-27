import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  themeStudioProjects,
  themeStudioVersions,
  themeStudioRuns,
  themeStudioMessages,
  themeStudioCaptures,
  themeStudioAssets,
  themeStudioVisualQaRuns,
} from "@/drizzle/schema";
import { gate, GATE_LABELS, type GateId } from "./acceptance-gates";
import { qaProgress } from "./qa-diagnosis";
import { repairTargets } from "./targeted-repair";
import { runThemeGeneration } from "./pipeline";
import type { ThemeIntent } from "./contracts";
import { operatorImagePackage } from "./_test-helpers";
import { qaImageIssues } from "./qa-image-issues";
import type { GateResult } from "./acceptance-gates";
import { recordThemeStudioEvent } from "./repository";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { service, generate, verify, decide } = vi.hoisted(() => ({
  service: vi.fn(),
  generate: vi.fn(),
  verify: vi.fn(),
  decide: vi.fn(),
}));
// ★ automaticQaDecision is builder 1A's (finding-severity rules); this suite
// pins the signature agreed in the plan (section 9) so it tests only how
// visual-qa.ts routes each decision: the review's outcome replaces the old
// yes or no, `null` (no review ran) is never a pass, taste passes once the
// repair rounds are used up, serious never passes. Gate rules as before.
vi.mock("./automatic-qa-policy", async (original) => ({
  ...(await original<typeof import("./automatic-qa-policy")>()),
  automaticQaDecision: decide,
}));
const LAYOUT_GATES = [
  "browser.coverage",
  "browser.overflow",
  "browser.clipped_text",
  "browser.tap_targets",
  "browser.image_crops",
  "browser.accessibility",
  "browser.media",
  "browser.performance",
];
function agreedDecision(
  gates: readonly GateResult[],
  review: { outcome: "pass" | "taste" | "serious" } | null,
  iteration: number,
  phase: "layout" | "final" = "final",
) {
  const required = phase === "layout" ? LAYOUT_GATES : Object.keys(GATE_LABELS);
  if (required.some((id) => !gates.some((g) => g.id === id)))
    return "attention" as const;
  const failed = gates.filter((g) => g.required && g.status !== "pass");
  if (failed.some((g) => g.id === "package.security"))
    return "blocked" as const;
  if (
    failed.some(
      (g) =>
        ["demo.materialize", "browser.coverage", "assets.integrity"].includes(
          g.id,
        ) ||
        g.findings.some((f) => f.code === "budget" || f.code === "timeout"),
    )
  )
    return "attention" as const;
  const atCeiling = iteration >= 3;
  if (failed.length)
    return atCeiling ? ("attention" as const) : ("revise" as const);
  if (phase === "layout") return "pass" as const;
  if (review?.outcome === "pass") return "pass" as const;
  if (review?.outcome === "taste")
    return atCeiling ? ("pass" as const) : ("revise" as const);
  if (review?.outcome === "serious")
    return atCeiling ? ("attention" as const) : ("revise" as const);
  return "attention" as const; // no review ran: never a pass
}
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./repository", () => ({ recordThemeStudioEvent: vi.fn() }));
// TS-3A seams: builder 3B's photo check (image-recovery.ts) and operator
// notice (notify.ts, through automatic-work.ts), and the capture job's start
// after a settlement commits.
const { checkPhotos, notify, startAfterCommit } = vi.hoisted(() => ({
  checkPhotos: vi.fn<(...args: unknown[]) => Promise<string>>(
    async () => "passed",
  ),
  notify: vi.fn(async () => {}),
  startAfterCommit: vi.fn(() => {}),
}));
vi.mock("./image-recovery", async (original) => ({
  ...(await original<typeof import("./image-recovery")>()),
  checkUncheckedPhotos: checkPhotos,
}));
vi.mock("./notify", () => ({ sendThemeStudioNotice: notify }));
// The leases the worker takes, so a test can tell the lease's own signal
// from one a budget timer was mixed into.
const { leases } = vi.hoisted(() => ({
  leases: [] as { signal: AbortSignal }[],
}));
vi.mock("./worker-lease", async (original) => {
  const actual = await original<typeof import("./worker-lease")>();
  return {
    ...actual,
    startWorkerLease: (...args: Parameters<typeof actual.startWorkerLease>) => {
      const lease = actual.startWorkerLease(...args);
      leases.push(lease);
      return lease;
    },
  };
});
vi.mock("./capture-start", () => ({
  startCaptureJobAfterCommit: startAfterCommit,
}));
vi.mock("./acceptance", () => ({
  currentAcceptanceBuildId: () => "build-new",
  verifyCandidateEvidenceWithDb: verify,
}));
const configState = vi.hoisted(() => ({
  provider: "fake" as "fake" | "vertex-gemini",
  disabledModels: new Set<string>(),
}));
vi.mock("./config", () => ({
  getThemeStudioConfig: () => ({
    provider: configState.provider,
    autoQaEnabled: true,
    disabledModels: configState.disabledModels,
  }),
}));
// The Vertex client and the shared capacity, for the review's own capacity
// row (TS-3A, optimisation 8); every other test runs the offline provider.
const { vertexClient, sharedCapacity, logWarn } = vi.hoisted(() => ({
  vertexClient: vi.fn(),
  sharedCapacity: vi.fn(() => ({ capacity: true })),
  logWarn: vi.fn(),
}));
vi.mock("./gemini-vertex", async (original) => ({
  ...(await original<typeof import("./gemini-vertex")>()),
  createVertexModelClient: vertexClient,
  getVertexConfig: () => ({ projectId: "studio-project", region: "global" }),
}));
vi.mock("./provider-capacity-store", async (original) => ({
  ...(await original<typeof import("./provider-capacity-store")>()),
  sharedProviderCapacity: sharedCapacity,
}));
vi.mock("@/lib/observability/logger", async (original) => ({
  ...(await original<typeof import("@/lib/observability/logger")>()),
  logWarn,
}));
vi.mock("./fake-provider", () => ({
  createFakeModelClient: () => ({ generate }),
}));
import {
  DESIGN_REVIEW_CAP,
  PHOTO_CHECK_BUDGET_MS,
  PHOTO_CHECK_INLINE_MS,
  PHOTO_CHECK_WAIT_LIMIT_MS,
  QA_RETRY_COOLDOWN_SECONDS,
  THEME_STUDIO_REVIEW_CAPACITY_SCOPE,
  logThemeStudioQaWaiting,
  runThemeStudioVisualQaWorker,
  settleThemeStudioLayoutCheck,
} from "./visual-qa";

const passing = () =>
  (Object.keys(GATE_LABELS) as GateId[]).map((id) =>
    gate(id, [], { required: id !== "browser.performance" }),
  );
const report = {
  verdict: "pass",
  scores: {
    artDirection: 5,
    distinctness: 5,
    commerceClarity: 5,
    typography: 5,
    imagery: 5,
    responsiveComposition: 5,
    detailQuality: 5,
    brandAdaptability: 5,
  },
  rejections: [],
  findings: [],
  revisionBrief: null,
};

function fixture({
  fail = false,
  iteration = 0,
  oldBuild = false,
  lostLease = false,
  claimStatus = "generating",
  settleStatus = "generating",
  acceptanceStatus = undefined as string | undefined,
  recaptures = 0,
  history = [] as unknown[],
  phase = "final",
  failId = "browser.accessibility" as GateId,
  pkg = operatorImagePackage(),
  intent = undefined as ThemeIntent | undefined,
  imageHistory = undefined as
    | { sha256: string | null; review: string; note?: string }[]
    | undefined,
  missingImage = false,
  // TS-3A: final reviews running on live leases when the claim counts them;
  // the row's own report (failed-call cost, a photo-check wait); the try
  // the held row is on; whether a stop moved the theme; and the entry
  // point (the review worker, or the layout check settled in a finish).
  running = 0,
  visionReport = {} as Record<string, unknown>,
  heldAttempt = undefined as number | undefined,
  projectMoved = true,
  entry = "worker" as "worker" | "finish",
} = {}) {
  const gates = passing()
    .filter((g) => phase !== "layout" || g.id.startsWith("browser."))
    .map((g) =>
      fail && g.id === failId
        ? gate(g.id, [
            {
              code: "contrast",
              where: "phone360 · home",
              message: "Improve price contrast",
            },
          ])
        : g,
    );
  const buildId = oldBuild ? "build-old" : "build-new";
  const qa = {
    id: "qa",
    projectId: "project",
    versionId: "version",
    packageDigest: "digest",
    screenshotAssetIds: [],
    qaIteration: iteration,
    createdBy: "operator",
    attemptCount: 0,
    maxAttempts: 3,
    visionReport,
    browserReport: {
      ...(phase === "final" ? { acceptanceRunId: "acceptance" } : {}),
      phase,
      buildId,
      gates,
    },
  };
  const held =
    heldAttempt === undefined ? qa : { ...qa, attemptCount: heldAttempt };
  const reads = [
    // The worker's claim: worn-out rows, then the count of design reviews
    // running on live leases (the cap). A finish claims its row by id.
    ...(entry === "worker" ? [[], [{ running }]] : []),
    [qa],
    [{ name: "Crave", modelKey: "gemini-3.8-flash", status: claimStatus }],
    [{ packageJson: pkg }],
    [],
    lostLease ? [] : [held],
    [{ status: settleStatus }],
    ...(phase === "final"
      ? [
          [
            {
              id: "acceptance",
              packageDigest: "digest",
              buildId,
              status: acceptanceStatus ?? (fail ? "failed" : "passed"),
              serverReport: { gates },
              browserReport: { gates: [] },
            },
          ],
        ]
      : !fail && !oldBuild
        ? [[{ intentJson: intent, packageDigest: "digest" }]]
        : []),
    // Prior build recaptures of this version (read only on a build change).
    ...(oldBuild ? [[{ n: recaptures }]] : []),
    ...(!oldBuild && iteration > 0 && iteration < 3 ? [history] : []),
  ];
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  let assetReads = 0;
  const db = {
    execute: vi.fn(async () => ({
      rows:
        imageHistory ??
        pkg.assets
          .filter((a) => a.source === "generated")
          .map((a) => ({ sha256: a.sha256, review: "passed" })),
    })),
    select: () => {
      let result: unknown;
      const query = {
        from: (table: unknown) => {
          result =
            table === themeStudioAssets && assetReads++ > 0
              ? missingImage
                ? []
                : [
                    {
                      bytes: Buffer.from("saved-artwork"),
                      mediaType: "image/webp",
                    },
                  ]
              : reads.shift();
          return query;
        },
        where: () => query,
        for: () => query,
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (result: unknown) => unknown) =>
          Promise.resolve(result).then(resolve),
      };
      return query;
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        // Awaited as is, or `.returning()` the row it moved (revealFailed
        // tells the operator only when the theme stopped generating).
        return {
          where: () =>
            Object.assign(Promise.resolve([]), {
              returning: async () =>
                projectMoved || table !== themeStudioProjects
                  ? [{ id: "project" }]
                  : [],
            }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { returning: async () => [{ id: "inserted" }] };
      },
    }),
  };
  service.mockImplementation(async (work) => work(db));
  return writes;
}

beforeEach(() => {
  vi.clearAllMocks();
  configState.provider = "fake";
  configState.disabledModels = new Set();
  decide.mockImplementation(agreedDecision);
  generate.mockResolvedValue({ kind: "ok", value: report, usage: {} });
  verify.mockResolvedValue({ ok: true });
});

describe("automatic acceptance and visual settlement", () => {
  it("cannot approve generated artwork without assessing its exact current bytes", async () => {
    const pkg = operatorImagePackage();
    pkg.assets.forEach((a) => {
      a.source = "generated";
    });
    const generated = qaImageIssues(pkg, []);
    const writes = fixture({ pkg, imageHistory: [] });
    expect(
      (await runThemeStudioVisualQaWorker({ providers: ["fake"] })).passed,
    ).toBe(0);
    expect(generate).toHaveBeenCalledOnce();
    expect(
      generate.mock.calls[0][0].content.filter(
        (b: { type: string }) => b.type === "image",
      ),
    ).toHaveLength(generated.length);
    expect(
      writes.some(
        (w) =>
          w.table === themeStudioProjects && w.values.status === "candidate",
      ),
    ).toBe(false);
    expect(
      writes.find(
        (w) => w.table !== themeStudioProjects && w.values.status === "queued",
      ),
    ).toBeDefined();
  });
  it("requires and records an explicit assessment of flagged art before approval", async () => {
    const pkg = operatorImagePackage();
    pkg.assets.forEach((a) => {
      a.source = "generated";
    });
    const art = qaImageIssues(pkg, [])[0];
    const history = pkg.assets.map((a) => ({
      sha256: a.sha256,
      review: a.id === art.slotId ? "flagged" : "passed",
      note: "Background needs inspection",
    }));
    generate.mockResolvedValue({
      kind: "ok",
      value: {
        ...report,
        imageAssessments: [
          {
            slotId: art.slotId,
            approved: true,
            reason: "The actual backdrop matches the explicit art direction.",
          },
        ],
      },
      usage: {},
    });
    const writes = fixture({ pkg, imageHistory: history });
    expect(
      (await runThemeStudioVisualQaWorker({ providers: ["fake"] })).passed,
    ).toBe(1);
    const content = generate.mock.calls[0][0].content;
    expect(
      content.some((b: { type: string; text?: string }) =>
        b.text?.includes(art.sha256),
      ),
    ).toBe(true);
    expect(
      content.filter((b: { type: string }) => b.type === "image"),
    ).toHaveLength(1);
    expect(
      writes.find((w) =>
        Array.isArray(
          (
            w.values.visionReport as typeof report & {
              imageAssessments?: unknown[];
            }
          )?.imageAssessments,
        ),
      ),
    ).toBeDefined();
  });
  it("does not buy a visual verdict when unresolved artwork bytes are missing", async () => {
    const pkg = operatorImagePackage();
    pkg.assets.forEach((a) => {
      a.source = "generated";
    });
    fixture({ pkg, imageHistory: [], missingImage: true });
    expect(
      (await runThemeStudioVisualQaWorker({ providers: ["fake"] })).passed,
    ).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });
  it("delivers a candidate only after both checks and current evidence verification pass", async () => {
    const writes = fixture();
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ passed: 1, failed: 0 });
    expect(generate).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(
      writes
        .filter((w) => w.table === themeStudioProjects)
        .map((w) => w.values.status),
    ).toEqual(["ready", "candidate"]);
    expect(writes.find((w) => w.table === themeStudioVersions)?.values).toEqual(
      { visibility: "operator", qaStatus: "passed" },
    );
  });
  it("queues targeted repairs without spending a vision call on failed deterministic checks", async () => {
    const writes = fixture({ fail: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1, passed: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(
      writes.find((w) => w.table === themeStudioMessages)?.values.body,
    ).toContain("phone360 · home: Improve price contrast");
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({
      baseVersionId: "version",
      automatic: true,
      qaIteration: 1,
    });
    expect(writes.some((w) => w.table === themeStudioVersions)).toBe(false);
  });
  it("uses the same bounded repair loop for a failed visual verdict", async () => {
    generate.mockResolvedValue({
      kind: "ok",
      value: {
        ...report,
        verdict: "revise",
        findings: ["Strengthen hierarchy"],
        revisionBrief: "Increase heading size",
      },
      usage: {},
    });
    const writes = fixture();
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1 });
    expect(
      writes.find((w) => w.table === themeStudioMessages)?.values.body,
    ).toContain("Increase heading size");
  });
  it("repairs a low score even if the model says pass without supplying a brief", async () => {
    generate.mockResolvedValue({
      kind: "ok",
      value: { ...report, scores: { ...report.scores, typography: 2 } },
      usage: {},
    });
    const writes = fixture();
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1, passed: 0 });
    const brief = writes.find((w) => w.table === themeStudioMessages)?.values
      .body;
    expect(brief).toContain('"typography":2');
    expect(brief).toContain("Raise every row to at least 4");
  });

  it("stops after three repairs without marking failed work passed", async () => {
    const writes = fixture({ fail: true, iteration: 3 });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, passed: 0, revisionQueued: 0 });
    expect(
      writes.find((w) => w.table === themeStudioVersions)?.values.qaStatus,
    ).toBe("failed");
    expect(
      writes.some(
        (w) => w.table === themeStudioRuns || w.values.status === "candidate",
      ),
    ).toBe(false);
  });
  it("still repairs at the second iteration, queueing the third and final attempt", async () => {
    const writes = fixture({ fail: true, iteration: 2 });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1, failed: 0 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({ qaIteration: 3 });
  });
  it("recaptures after a deployment without regenerating the theme", async () => {
    const writes = fixture({ oldBuild: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ recaptureQueued: 1, revisionQueued: 0, passed: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(
      writes.find((w) => w.table === themeStudioCaptures)?.values,
    ).toMatchObject({ versionId: "version", automatic: true, qaIteration: 0 });
    expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
  });
  it("stops recapturing a version whose evidence keeps going stale", async () => {
    const writes = fixture({ oldBuild: true, recaptures: 2 });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, recaptureQueued: 0 });
    expect(writes.some((w) => w.table === themeStudioCaptures)).toBe(false);
    expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
      "acceptance_build_unstable",
    );
  });
  it("refuses stale asset evidence and results from a lost lease", async () => {
    verify.mockResolvedValue({ ok: false, reason: "Assets changed" });
    let writes = fixture();
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, passed: 0 });
    expect(writes.some((w) => w.values.status === "candidate")).toBe(false);
    writes = fixture({ lostLease: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ passed: 0, failed: 0 });
    expect(writes).toHaveLength(1); // Claim only; no late settlement.
  });
  it("stops, rather than paying for a revision, when passing gates disagree with a non-passed stored outcome", async () => {
    const writes = fixture({ acceptanceStatus: "failed" });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, passed: 0, revisionQueued: 0 });
    expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
    expect(writes.some((w) => w.values.status === "candidate")).toBe(false);
    expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
      "acceptance_outcome_mismatch",
    );
  });
  it("closes a run whose project stopped generating before paying for vision", async () => {
    const writes = fixture({ claimStatus: "archived" });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ claimed: 0, passed: 0, failed: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(writes.at(-1)?.values).toMatchObject({
      status: "failed",
      errorCode: "project_state_changed",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(writes.some((w) => w.table === themeStudioVersions)).toBe(false);
    expect(writes.some((w) => w.table === themeStudioProjects)).toBe(false);
  });
  it("releases the lease when the project stops generating during the vision call", async () => {
    const writes = fixture({ settleStatus: "archived" });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, passed: 0 });
    expect(writes.at(-1)?.values).toMatchObject({
      status: "failed",
      errorCode: "project_state_changed",
      leaseOwner: null,
    });
    // The version stays hidden and the project is left as the operator set it.
    expect(writes.some((w) => w.table === themeStudioVersions)).toBe(false);
    expect(writes.some((w) => w.table === themeStudioProjects)).toBe(false);
  });
});

async function draft() {
  const actual =
    await vi.importActual<typeof import("./fake-provider")>("./fake-provider");
  const outcome = await runThemeGeneration(
    actual.createFakeModelClient({
      name: "Clay",
      brief: "A ceramics shop",
      industries: ["home"],
      catalogSizes: ["small"],
      requiredFeatures: [],
      referenceCount: 0,
    }),
    {
      facts: {
        themeId: "clay",
        name: "Clay",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        baseThemeName: null,
      },
      compile: {
        themeId: "clay",
        name: "Clay",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        baseEngine: null,
        versionNumber: 1,
        modelKey: "gemini-3.8-flash",
        modelLabel: "Gemini",
        referenceDigests: [],
      },
      providerModel: "fake",
      promptVersion: "test",
      messages: [{ kind: "brief", body: "A ceramics shop" }],
      references: [],
    },
    new AbortController().signal,
  );
  if (outcome.kind !== "version") throw new Error(outcome.kind);
  return { pkg: outcome.package, intent: outcome.intent };
}

describe("layout preflight and failure routing", () => {
  it("queues artwork after layout passes without vision, publication evidence or another version", async () => {
    const writes = fixture({ phase: "layout", ...(await draft()) });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ layoutPassed: 1, passed: 0, failed: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({
      kind: "images",
      baseVersionId: "version",
      qaIteration: 0,
    });
    expect(
      writes.some(
        (w) =>
          w.table === themeStudioVersions || w.table === themeStudioProjects,
      ),
    ).toBe(false);
  });
  it("recaptures stale preflight builds in the same phase", async () => {
    const writes = fixture({ phase: "layout", oldBuild: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ recaptureQueued: 1 });
    expect(
      writes.find((w) => w.table === themeStudioCaptures)?.values.phase,
    ).toBe("layout");
    expect(generate).not.toHaveBeenCalled();
  });
  it("stops a tap-target defect before purchasing artwork or a settings repair", async () => {
    const writes = fixture({
      phase: "layout",
      fail: true,
      failId: "browser.tap_targets",
    });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, revisionQueued: 0 });
    expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
      "renderer_fix_required",
    );
    expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });
  it("routes a preflight contrast failure to the focused settings repair", async () => {
    const writes = fixture({ phase: "layout", fail: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({ kind: "revise", automatic: true, qaIteration: 1 });
    expect(generate).not.toHaveBeenCalled();
  });
  it("stops identical failed settings evidence at the first non-improving revision", async () => {
    const bad = passing().map((g) =>
      g.id === "browser.accessibility"
        ? gate(g.id, [
            {
              code: "contrast",
              where: "phone360 · home",
              message: "Improve price contrast",
            },
          ])
        : g,
    );
    const writes = fixture({
      fail: true,
      iteration: 1,
      history: [{ visionReport: { progress: qaProgress(bad) } }],
    });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, revisionQueued: 0 });
    expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
      "qa_no_progress",
    );
    expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
  });
  it("redraws only the named generated slot and binds the QA correction to that image run", async () => {
    const pkg = operatorImagePackage();
    const slot = pkg.assets.find(
      (a) =>
        a.path !== pkg.definition.catalog.previewImage &&
        !pkg.definition.catalog.screenshots.some((s) => s.src === a.path),
    )!;
    slot.source = "generated";
    generate.mockResolvedValue({
      kind: "ok",
      usage: {},
      value: {
        ...report,
        verdict: "revise",
        repairs: [
          {
            kind: "image",
            target: slot.id,
            reason: "Match the existing SET backdrop",
          },
        ],
      },
    });
    const writes = fixture({ pkg });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({
      kind: "images",
      imageSlotIds: [slot.id],
      qaIteration: 1,
    });
    expect(
      writes.find((w) => w.table === themeStudioMessages)?.values.body,
    ).toContain("Match the existing SET backdrop");
    expect(
      writes.find((w) => w.values.status === "revision_queued")?.values
        .revisionRunId,
    ).toBe("inserted");
  });
  it("repairs settings first for a mixed settings/artwork verdict without sending redraw instructions to the text model", async () => {
    const pkg = operatorImagePackage();
    const slot = pkg.assets.find(
      (a) =>
        a.path !== pkg.definition.catalog.previewImage &&
        !pkg.definition.catalog.screenshots.some((s) => s.src === a.path),
    )!;
    slot.source = "generated";
    const setting = repairTargets(pkg)[0].path;
    generate.mockResolvedValue({
      kind: "ok",
      usage: {},
      value: {
        ...report,
        verdict: "revise",
        revisionBrief: "Change settings and redraw all imagery",
        repairs: [
          {
            kind: "settings",
            target: setting,
            reason: "Improve heading hierarchy",
          },
          {
            kind: "image",
            target: slot.id,
            reason: "Fix the warped mug handle",
          },
        ],
      },
    });
    const writes = fixture({ pkg });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1, failed: 0 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({ kind: "revise", qaIteration: 1 });
    const brief = writes.find((w) => w.table === themeStudioMessages)?.values
      .body;
    expect(brief).toContain(setting);
    expect(brief).toContain("Improve heading hierarchy");
    expect(brief).not.toContain("Fix the warped mug handle");
    expect(brief).not.toContain("redraw all imagery");
  });
  it("never redraws an owner upload or accepts an invented setting target", async () => {
    const pkg = operatorImagePackage();
    for (const repair of [
      { kind: "image", target: pkg.assets[0].id, reason: "Redraw" },
      { kind: "settings", target: "/css/font", reason: "Fix CSS" },
    ]) {
      // A serious finding no supported repair can reach stops the theme.
      generate.mockResolvedValue({
        kind: "ok",
        usage: {},
        value: {
          ...report,
          verdict: "revise",
          rejections: ["unfinished_surface"],
          repairs: [repair],
        },
      });
      let writes = fixture({ pkg });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ failed: 1 });
      expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
        "repair_not_supported",
      );
      expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
      // Taste no repair can reach is a warning: the theme goes on, and
      // still nothing is redrawn or revised.
      generate.mockResolvedValue({
        kind: "ok",
        usage: {},
        value: { ...report, verdict: "revise", repairs: [repair] },
      });
      writes = fixture({ pkg });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ passed: 1, failed: 0 });
      expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
      expect(writes.some((w) => w.table === themeStudioMessages)).toBe(false);
    }
  });
});

describe("fix it, then allow Publish (TS-1B)", () => {
  const run = () => runThemeStudioVisualQaWorker({ providers: ["fake"] });
  const answer = (value: Record<string, unknown>) =>
    generate.mockResolvedValue({ kind: "ok", usage: {}, value });
  const taste = {
    ...report,
    verdict: "revise",
    scores: { ...report.scores, artDirection: 3 },
    findings: ["Busier than the brief"],
    revisionBrief: "Calm the hero",
  };
  const settled = (writes: ReturnType<typeof fixture>) =>
    writes.find(
      (w) =>
        w.table === themeStudioVisualQaRuns &&
        ["passed", "failed"].includes(String(w.values.status)),
    )?.values as
      | {
          status: string;
          errorCode?: string;
          visionReport: {
            diagnosis?: string;
            severityRules?: string;
            reviewSeverity?: {
              outcome: string;
              serious: unknown[];
              warnings: unknown[];
            };
          };
        }
      | undefined;
  const paid = (writes: ReturnType<typeof fixture>) =>
    writes.some(
      (w) => w.table === themeStudioRuns || w.table === themeStudioMessages,
    );
  /** A package whose generated photos all passed their check except `slot`. */
  function photos(history: (sha256: string) => Record<string, unknown>[]) {
    const pkg = operatorImagePackage();
    pkg.assets.forEach((a) => {
      a.source = "generated";
    });
    const slot = qaImageIssues(pkg, [])[0];
    const imageHistory = pkg.assets
      .filter((a) => a.id !== slot.slotId)
      .map((a) => ({ sha256: a.sha256, review: "passed" }))
      .concat(history(slot.sha256) as never[]);
    return { pkg, slot, imageHistory };
  }

  it("asks the policy with the review's outcome: null when no review ran on a final check, a pass for the layout check", async () => {
    fixture({ fail: true });
    await run();
    expect(decide).toHaveBeenLastCalledWith(
      expect.any(Array),
      null,
      0,
      "final",
    );
    decide.mockClear();
    fixture({ phase: "layout", ...(await draft()) });
    await run();
    expect(decide).toHaveBeenLastCalledWith(
      expect.any(Array),
      { outcome: "pass" },
      0,
      "layout",
    );
    decide.mockClear();
    answer(taste);
    fixture();
    await run();
    expect(decide).toHaveBeenLastCalledWith(
      expect.any(Array),
      { outcome: "taste" },
      0,
      "final",
    );
  });

  it("taste left after the repair rounds is a warning: the theme is ready to publish, the warnings and rule version saved", async () => {
    answer(taste);
    const writes = fixture({ iteration: 3 });
    expect(await run()).toMatchObject({ passed: 1, revisionQueued: 0 });
    expect(
      writes
        .filter((w) => w.table === themeStudioProjects)
        .map((w) => w.values.status),
    ).toEqual(["ready", "candidate"]);
    expect(settled(writes)).toMatchObject({
      status: "passed",
      visionReport: {
        severityRules: "severity-v1",
        reviewSeverity: {
          outcome: "taste",
          serious: [],
          warnings: [{ code: "low_score", row: "artDirection", score: 3 }],
        },
      },
    });
    expect(vi.mocked(recordThemeStudioEvent)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "auto_qa_passed",
        detail: expect.objectContaining({
          severityRules: "severity-v1",
          warnings: ["low_score"],
        }),
      }),
    );
    expect(paid(writes)).toBe(false);
  });

  it("a serious review finding is repaired below the ceiling and stops at it with its reason, never buying a repair", async () => {
    answer({
      ...report,
      verdict: "revise",
      rejections: ["unsupported_claim"],
      findings: ["An award badge the brief never mentions"],
      revisionBrief: "Remove the award badge",
    });
    let writes = fixture();
    expect(await run()).toMatchObject({ revisionQueued: 1 });
    const brief = writes.find((w) => w.table === themeStudioMessages)?.values
      .body;
    expect(brief).toContain("Visual rejection: unsupported_claim");
    expect(brief).toContain("Remove the award badge");
    expect(brief).not.toMatch(/pre-review/);

    answer({
      ...report,
      verdict: "revise",
      rejections: ["inaccessible_copy"],
      findings: ["Hero copy unreadable on the photo"],
    });
    writes = fixture({ iteration: 3 });
    expect(await run()).toMatchObject({ failed: 1, passed: 0 });
    expect(settled(writes)).toMatchObject({
      status: "failed",
      errorCode: "quality_bar_not_met",
      visionReport: {
        reviewSeverity: {
          outcome: "serious",
          serious: [{ code: "inaccessible_copy" }],
        },
      },
    });
    expect(settled(writes)?.visionReport.diagnosis).toContain(
      "Some text cannot be read",
    );
    expect(paid(writes)).toBe(false);
    expect(writes.some((w) => w.values.status === "candidate")).toBe(false);
  });

  it("a check that could not finish, or a broken preview, stops as checks_incomplete with Check again, never 'describe a fix'", async () => {
    // A page the capture never measured, at the repair ceiling (where every
    // Check again and Publish re-check runs) and below it.
    for (const iteration of [3, 0]) {
      const writes = fixture({
        fail: true,
        failId: "browser.coverage",
        iteration,
      });
      expect(await run()).toMatchObject({ failed: 1, revisionQueued: 0 });
      expect(settled(writes)).toMatchObject({
        status: "failed",
        errorCode: "checks_incomplete",
      });
      expect(settled(writes)?.visionReport.diagnosis).toContain(
        "The checks could not finish",
      );
      expect(settled(writes)?.visionReport.diagnosis).toContain("Check again");
      expect(settled(writes)?.visionReport.diagnosis).not.toMatch(
        /Serious problems remain/,
      );
      expect(paid(writes)).toBe(false);
    }
    // StoreMink's preview did not work: the demo store could not be built.
    const runtime = fixture({
      fail: true,
      failId: "demo.materialize",
      iteration: 3,
    });
    await run();
    expect(settled(runtime)?.errorCode).toBe("checks_incomplete");
    expect(settled(runtime)?.visionReport.diagnosis).toContain(
      "A change to the theme will not fix this",
    );
    // A serious finding left after the repairs keeps its own code.
    const serious = fixture({ fail: true, iteration: 3 });
    await run();
    expect(settled(serious)).toMatchObject({
      status: "failed",
      errorCode: "quality_bar_not_met",
    });
    expect(settled(serious)?.visionReport.diagnosis).toContain(
      "Serious problems remain",
    );
  });

  it("decision 3: a very low score blocks only on its rows; one point higher is a warning", async () => {
    answer({
      ...report,
      verdict: "revise",
      scores: { ...report.scores, commerceClarity: 2 },
    });
    let writes = fixture({ iteration: 3 });
    expect(await run()).toMatchObject({ failed: 1 });
    expect(settled(writes)?.visionReport.diagnosis).toContain(
      "commerce clarity 2 out of 5",
    );
    answer({
      ...report,
      verdict: "revise",
      scores: { ...report.scores, commerceClarity: 3, imagery: 1 },
    });
    writes = fixture({ iteration: 3 });
    expect(await run()).toMatchObject({ passed: 1 });
    expect(settled(writes)?.visionReport.reviewSeverity?.warnings).toEqual([
      { code: "low_score", row: "commerceClarity", score: 3 },
      { code: "low_score", row: "imagery", score: 1 },
    ]);
  });

  it("an unchecked photo the review approves stops for its picture check, never a paid revision", async () => {
    const { pkg, slot, imageHistory } = photos(() => []);
    answer({
      ...report,
      imageAssessments: [
        { slotId: slot.slotId, approved: true, reason: "Looks right" },
      ],
    });
    const writes = fixture({ pkg, imageHistory });
    expect(await run()).toMatchObject({ failed: 1, revisionQueued: 0 });
    expect(settled(writes)).toMatchObject({
      status: "failed",
      errorCode: "image_check_required",
      visionReport: {
        reviewSeverity: {
          outcome: "serious",
          serious: [{ code: "image_unchecked", slotId: slot.slotId }],
        },
      },
    });
    expect(settled(writes)?.visionReport.diagnosis).toContain(slot.slotId);
    expect(paid(writes)).toBe(false);
  });

  it("an unchecked photo the review rejects is redrawn, and the redraw is checked as it is drawn", async () => {
    const { pkg, slot, imageHistory } = photos(() => []);
    answer({
      ...report,
      verdict: "revise",
      imageAssessments: [
        { slotId: slot.slotId, approved: false, reason: "Melted handle" },
      ],
      repairs: [
        { kind: "image", target: slot.slotId, reason: "Melted handle" },
      ],
    });
    const writes = fixture({ pkg, imageHistory });
    expect(await run()).toMatchObject({ revisionQueued: 1, failed: 0 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({ kind: "images", imageSlotIds: [slot.slotId] });
  });

  it("a photo flagged with a hard problem stays serious even when the review approves it; a small flag is a warning", async () => {
    let { pkg, slot, imageHistory } = photos((sha256) => [
      {
        sha256,
        review: "flagged",
        note: "Lettering on the jar",
        problems: ["text_or_logo"],
      },
    ]);
    answer({
      ...report,
      imageAssessments: [
        { slotId: slot.slotId, approved: true, reason: "Looks right" },
      ],
    });
    let writes = fixture({ pkg, imageHistory });
    expect(await run()).toMatchObject({ failed: 1 });
    expect(settled(writes)?.errorCode).toBe("image_check_required");
    expect(settled(writes)?.visionReport.diagnosis).toContain(
      "The picture check found a problem it does not allow",
    );

    ({ pkg, slot, imageHistory } = photos((sha256) => [
      {
        sha256,
        review: "flagged",
        note: "Backdrop warmer than the set",
        problems: ["off_style"],
      },
    ]));
    answer({
      ...report,
      verdict: "revise",
      imageAssessments: [
        { slotId: slot.slotId, approved: false, reason: "Too warm" },
      ],
      repairs: [{ kind: "image", target: slot.slotId, reason: "Too warm" }],
    });
    writes = fixture({ pkg, imageHistory, iteration: 3 });
    expect(await run()).toMatchObject({ passed: 1 });
    expect(settled(writes)?.visionReport.reviewSeverity).toMatchObject({
      outcome: "taste",
      warnings: [{ code: "image_redraw", slotId: slot.slotId }],
    });
  });

  it("taste only a StoreMink fix could change, or that stopped improving, is a warning below the ceiling too", async () => {
    answer({
      ...report,
      verdict: "revise",
      rejections: ["needs_custom_code"],
      repairs: [
        { kind: "renderer", target: null, reason: "Needs a custom carousel" },
      ],
    });
    let writes = fixture();
    expect(await run()).toMatchObject({ passed: 1, failed: 0 });
    expect(paid(writes)).toBe(false);

    answer({
      ...report,
      verdict: "revise",
      rejections: ["inaccessible_copy"],
      repairs: [
        { kind: "renderer", target: null, reason: "Drawer text on a photo" },
      ],
    });
    writes = fixture();
    expect(await run()).toMatchObject({ failed: 1 });
    expect(settled(writes)?.errorCode).toBe("renderer_fix_required");

    answer(taste);
    writes = fixture({
      iteration: 1,
      history: [{ visionReport: { progress: qaProgress(passing(), taste) } }],
    });
    expect(await run()).toMatchObject({ passed: 1, revisionQueued: 0 });
    expect(paid(writes)).toBe(false);
  });

  it("the deploy re-capture still guards the review, and its stop says why in plain words", async () => {
    const writes = fixture({ oldBuild: true, recaptures: 2 });
    expect(await run()).toMatchObject({ failed: 1, recaptureQueued: 0 });
    expect(generate).not.toHaveBeenCalled();
    const diagnosis = settled(writes)?.visionReport.diagnosis ?? "";
    expect(diagnosis).toContain("StoreMink was updated");
    expect(diagnosis).not.toMatch(/[\u2013\u2014]/);
  });
});

// ── TS-3A: the design-review lane on the shared web service ─────────────

/** A database for the claim alone: each select answers the next result and
 * keeps its `where`, so a test can read the claim's own SQL. */
function claimDb(results: unknown[][]) {
  const wheres: unknown[] = [];
  const executed: unknown[] = [];
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    execute: vi.fn(async (statement: unknown) => {
      executed.push(statement);
      return { rows: [] };
    }),
    select: () => {
      const query = {
        from: () => query,
        where: (condition: unknown) => {
          wheres.push(condition);
          return query;
        },
        for: () => query,
        orderBy: () => query,
        limit: () => query,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(results.shift() ?? []).then(resolve),
      };
      return query;
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return {
          where: () =>
            Object.assign(Promise.resolve([]), {
              returning: async () => [],
            }),
        };
      },
    }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
  };
  service.mockImplementation(async (work) => work(db));
  return { wheres, executed, writes };
}

const render = (condition: unknown) =>
  new PgDialect().sqlToQuery(condition as SQL);

describe("★ at most two design reviews at once on the platform, checked when one is claimed", () => {
  it("claims none at the cap: nothing is leased and no model is paid", async () => {
    const { executed, writes } = claimDb([
      [],
      [{ running: DESIGN_REVIEW_CAP }],
      // At the cap only a layout check may be claimed: none is waiting.
      [],
      // A design review is waiting.
      [{ id: "waiting-review" }],
    ]);
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ claimed: 0, capped: 1 });
    expect(writes).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    // The one-at-a-time lock of the claim, held by its own transaction only.
    expect(render(executed[0]).sql).toBe(
      "select pg_advisory_xact_lock(hashtextextended('theme-studio:design-review-claim', 0))",
    );
  });

  it("counts only final reviews running on live leases, and at the cap looks for a layout check alone", async () => {
    const { wheres } = claimDb([[], [{ running: DESIGN_REVIEW_CAP }], [], []]);
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ claimed: 0, capped: 0 });
    const count = render(wheres[1]).sql;
    expect(count).toMatch(/"status" = 'running'/);
    expect(count).toMatch(/"lease_expires_at" > now\(\)/);
    expect(count).toMatch(/coalesce\(.*'phase', 'final'\) <> 'layout'/);
    expect(render(wheres[2]).sql).toMatch(/->>'phase' = 'layout'/);
  });

  it("below the cap claims any review, and a retried one only after its cooldown", async () => {
    const { wheres } = claimDb([[], [{ running: DESIGN_REVIEW_CAP - 1 }], []]);
    await runThemeStudioVisualQaWorker({ providers: ["fake"] });
    const next = render(wheres[2]);
    expect(next.sql).not.toMatch(/->>'phase' = 'layout'/);
    // A row never claimed has no started_at; a retried one waits.
    expect(next.sql).toMatch(/"started_at" IS NULL/);
    expect(next.sql).toMatch(
      /"updated_at" <= now\(\) - \(\$\d+::int \* interval '1 second'\)/,
    );
    expect(next.params).toContain(QA_RETRY_COOLDOWN_SECONDS);
  });

  it("★ two claims at once never both pass the count: the claim lock serializes them", async () => {
    // One review already running, two waiting: one slot left. The fake
    // database answers each statement of the claim and honours the advisory
    // lock as Postgres does, holding it until the claiming transaction ends.
    let running = 1;
    const queue = ["review-a", "review-b"];
    let lockHeld: Promise<void> | null = null;
    const claimed: string[] = [];
    const text = (statement: unknown) => render(statement).sql;
    service.mockImplementation(async (work) => {
      let release: () => void = () => {};
      let ownsLock = false;
      let reviewSelects = 0;
      const db = {
        execute: vi.fn(async (statement: unknown) => {
          if (text(statement).includes("pg_advisory_xact_lock")) {
            while (lockHeld) await lockHeld;
            lockHeld = new Promise<void>((resolve) => {
              release = () => {
                lockHeld = null;
                resolve();
              };
            });
            ownsLock = true;
          }
          return { rows: [] };
        }),
        select: (fields?: Record<string, unknown>) => {
          let table: unknown;
          let where: unknown;
          const query = {
            from: (t: unknown) => {
              table = t;
              return query;
            },
            where: (condition: unknown) => {
              where = condition;
              return query;
            },
            for: () => query,
            orderBy: () => query,
            limit: () => query,
            then: async (resolve: (value: unknown) => unknown) => {
              // Let the other claim run between statements.
              await new Promise((r) => setTimeout(r, 1));
              if (fields && "running" in fields) return resolve([{ running }]);
              if (table === themeStudioVisualQaRuns && !fields) {
                reviewSelects += 1;
                // The worn-out rows: none.
                if (reviewSelects === 1) return resolve([]);
                // At the cap only a layout check is asked for: none waits.
                if (text(where).includes("'phase' = 'layout'"))
                  return resolve([]);
                const id = queue.shift();
                return resolve(id ? [claimRow(id)] : []);
              }
              if (table === themeStudioVisualQaRuns)
                return resolve(queue.length ? [{ id: queue[0] }] : []);
              if (table === themeStudioProjects)
                // Not generating: the claim closes the row, so the test
                // stops at the claim it is about.
                return resolve([
                  {
                    name: "Crave",
                    modelKey: "gemini-3.8-flash",
                    status: "archived",
                  },
                ]);
              return resolve([]);
            },
          };
          return query;
        },
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: () => {
              if (values.status === "running") {
                running += 1;
                claimed.push(String(values.leaseOwner));
              }
              return Object.assign(Promise.resolve([]), {
                returning: async () => [],
              });
            },
          }),
        }),
        insert: () => ({ values: () => ({ returning: async () => [] }) }),
      };
      try {
        return await work(db);
      } finally {
        if (ownsLock) release();
      }
    });
    const results = await Promise.all([
      runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ]);
    expect(claimed).toHaveLength(1);
    expect(running).toBe(DESIGN_REVIEW_CAP);
    expect(results.map((r) => r.capped).sort()).toEqual([0, 1]);
  });
});

function claimRow(id: string) {
  return {
    id,
    projectId: "project",
    versionId: "version",
    packageDigest: "digest",
    screenshotAssetIds: [],
    qaIteration: 0,
    createdBy: "operator",
    attemptCount: 0,
    maxAttempts: 2,
    visionReport: {},
    browserReport: { phase: "final", buildId: "build-new" },
  };
}

/** A generated package whose photos have no check on their bytes. */
function uncheckedPhotos() {
  const pkg = operatorImagePackage();
  pkg.assets.forEach((a) => {
    a.source = "generated";
  });
  return pkg;
}

describe("★ the photo check before the design review (K4)", () => {
  it("checks an unchecked photo before the review is paid for", async () => {
    const order: string[] = [];
    checkPhotos.mockImplementationOnce(async () => {
      order.push("photo check");
      return "passed";
    });
    generate.mockImplementationOnce(async () => {
      order.push("review");
      return { kind: "ok", value: report, usage: {} };
    });
    fixture({ pkg: uncheckedPhotos(), imageHistory: [] });
    leases.length = 0;
    const before = Date.now();
    await runThemeStudioVisualQaWorker({ providers: ["fake"] });
    const after = Date.now();
    expect(order).toEqual(["photo check", "review"]);
    expect(checkPhotos).toHaveBeenCalledWith(service, {
      projectId: "project",
      versionId: "version",
      signal: expect.any(AbortSignal),
      deadline: expect.any(Number),
    });
    // ★ The checks' own clock ends PHOTO_CHECK_BUDGET_MS after the claim,
    // and the signal is the lease alone: no budget timer stops a check as
    // the caller (that would never be counted as a try).
    const { deadline, signal } = checkPhotos.mock.calls[0][1] as {
      deadline: number;
      signal: AbortSignal;
    };
    expect(deadline).toBeGreaterThanOrEqual(before + PHOTO_CHECK_BUDGET_MS);
    expect(deadline).toBeLessThanOrEqual(after + PHOTO_CHECK_BUDGET_MS);
    expect(leases).toHaveLength(1);
    expect(signal).toBe(leases[0].signal);
  });

  it("★★ holds no connection while the photo checks run: they get withService itself, never a transaction of the lane's", async () => {
    let open = 0;
    let openDuringCheck: number | null = null;
    checkPhotos.mockImplementationOnce(async () => {
      openDuringCheck = open;
      return "passed";
    });
    fixture({ pkg: uncheckedPhotos(), imageHistory: [] });
    const inner = service.getMockImplementation()!;
    service.mockImplementation(async (work: unknown) => {
      open += 1;
      try {
        return await inner(work);
      } finally {
        open -= 1;
      }
    });
    await runThemeStudioVisualQaWorker({ providers: ["fake"] });
    expect(checkPhotos).toHaveBeenCalledOnce();
    expect(checkPhotos.mock.calls[0][0]).toBe(service);
    expect(openDuringCheck).toBe(0);
  });

  it("★★ checks that took longer than PHOTO_CHECK_INLINE_MS end the claim: the review goes back with no try spent, claimable at once, and is not paid for in this claim", async () => {
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + skew);
    try {
      checkPhotos.mockImplementationOnce(async () => {
        skew += PHOTO_CHECK_INLINE_MS + 1_000;
        return "passed";
      });
      const writes = fixture({
        pkg: uncheckedPhotos(),
        imageHistory: [],
        heldAttempt: 1,
      });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({
        claimed: 1,
        photosChecked: 1,
        photosWaiting: 0,
        passed: 0,
        failed: 0,
      });
      expect(generate).not.toHaveBeenCalled();
      const back = writes
        .filter((w) => w.table === themeStudioVisualQaRuns)
        .map((w) => w.values)
        .find((v) => v.status === "queued");
      expect(back).toMatchObject({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        attemptCount: 0,
        visionReport: { photoCheck: { state: "checked" } },
      });
      expect(notify).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("checks that passed within PHOTO_CHECK_INLINE_MS leave the review its whole clock: it follows in the same claim, and the row stops saying Checking pictures", async () => {
    checkPhotos.mockImplementationOnce(async () => "passed");
    const writes = fixture({ pkg: uncheckedPhotos(), imageHistory: [] });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ claimed: 1, photosChecked: 0, photosWaiting: 0 });
    expect(generate).toHaveBeenCalledOnce();
    // The marks on the held row (no status change): checking, then checked
    // before the review's model call.
    expect(
      writes
        .filter(
          (w) => w.table === themeStudioVisualQaRuns && !("status" in w.values),
        )
        .map(
          (w) =>
            (w.values.visionReport as { photoCheck?: { state?: string } })
              ?.photoCheck?.state,
        ),
    ).toEqual(["checking", "checked"]);
  });

  it("asks nothing when every photo has its check", async () => {
    fixture();
    await runThemeStudioVisualQaWorker({ providers: ["fake"] });
    expect(checkPhotos).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("waiting: the review goes back to wait without spending a try, showing Checking pictures", async () => {
    checkPhotos.mockImplementationOnce(async () => "waiting");
    const writes = fixture({
      pkg: uncheckedPhotos(),
      imageHistory: [],
      heldAttempt: 1,
    });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ claimed: 1, photosWaiting: 1, failed: 0, passed: 0 });
    expect(generate).not.toHaveBeenCalled();
    const marks = writes
      .filter((w) => w.table === themeStudioVisualQaRuns)
      .map((w) => w.values);
    // While it ran, then the wait itself (a count, never a picture).
    expect(marks).toContainEqual({
      visionReport: {
        photoCheck: {
          state: "checking",
          since: expect.any(String),
          unchecked: expect.any(Number),
        },
      },
    });
    const wait = marks.find((v) => v.status === "queued");
    expect(wait).toMatchObject({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      visionReport: { photoCheck: { state: "waiting" } },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("failed: the checks stop as could not finish, with Check again, and the operator is told", async () => {
    checkPhotos.mockImplementationOnce(async () => "failed");
    const writes = fixture({ pkg: uncheckedPhotos(), imageHistory: [] });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, passed: 0 });
    expect(generate).not.toHaveBeenCalled();
    const stop = writes.find((w) => w.values.errorCode)?.values;
    expect(stop).toMatchObject({
      status: "failed",
      errorCode: "checks_incomplete",
      visionReport: {
        photoCheck: { state: "failed" },
        diagnosis: expect.stringMatching(/picture check.*Check again\.$/),
      },
    });
    // Words an operator reads: never a long dash.
    expect(
      String((stop?.visionReport as { diagnosis?: string }).diagnosis),
    ).not.toMatch(/[\u2013\u2014]/);
    expect(notify).toHaveBeenCalledWith({
      projectId: "project",
      kind: "needs_fix",
    });
  });

  it("stops a review that has waited past the limit without paying for another check", async () => {
    const since = new Date(
      Date.now() - PHOTO_CHECK_WAIT_LIMIT_MS - 1_000,
    ).toISOString();
    const writes = fixture({
      pkg: uncheckedPhotos(),
      imageHistory: [],
      visionReport: { photoCheck: { state: "waiting", since, unchecked: 2 } },
    });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1 });
    expect(checkPhotos).not.toHaveBeenCalled();
    expect(writes.find((w) => w.values.errorCode)?.values).toMatchObject({
      errorCode: "checks_incomplete",
      visionReport: { photoCheck: { state: "failed", since } },
    });
  });

  it("a photo check that throws waits, it never fails the review on its own", async () => {
    checkPhotos.mockImplementationOnce(async () => {
      throw new Error("reviewer unreachable");
    });
    fixture({ pkg: uncheckedPhotos(), imageHistory: [], heldAttempt: 1 });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ photosWaiting: 1, failed: 0 });
  });
});

describe("★ retries: our own input errors, the cost of failed calls", () => {
  it("our own missing input fails at once as qa_input_missing, never a provider failure", async () => {
    // A photo the review must assess has no stored bytes.
    const pkg = uncheckedPhotos();
    const writes = fixture({
      pkg,
      imageHistory: pkg.assets.map((a) => ({
        sha256: a.sha256,
        review: "flagged",
      })),
      missingImage: true,
    });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1 });
    expect(generate).not.toHaveBeenCalled();
    expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
      "qa_input_missing",
    );
    expect(writes.some((w) => w.values.status === "queued")).toBe(false);
  });

  it("a paid call that could not be used keeps its cost on the row for the retry", async () => {
    const usage = {
      inputTokens: 1200,
      cachedTokens: 200,
      outputTokens: 30,
      thinkingTokens: 70,
    };
    generate.mockResolvedValueOnce({ kind: "refused", category: null, usage });
    const writes = fixture({
      visionReport: {
        failedCalls: 1,
        failedCallUsage: {
          inputTokens: 1000,
          cachedTokens: 0,
          outputTokens: 10,
          thinkingTokens: 0,
        },
      },
      heldAttempt: 1,
    });
    await runThemeStudioVisualQaWorker({ providers: ["fake"] });
    const retry = writes.find(
      (w) =>
        w.table === themeStudioVisualQaRuns && w.values.status === "queued",
    )?.values;
    expect(retry).toEqual({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      visionReport: {
        failedCalls: 2,
        failedCallUsage: {
          inputTokens: 2200,
          cachedTokens: 200,
          outputTokens: 40,
          thinkingTokens: 70,
        },
      },
    });
  });

  it("the last try's failure closes with every failed call's cost", async () => {
    const usage = {
      inputTokens: 500,
      cachedTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
    };
    generate.mockResolvedValueOnce({ kind: "invalid_json", usage });
    const writes = fixture({ heldAttempt: 3 });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1 });
    expect(writes.find((w) => w.values.errorCode)?.values).toMatchObject({
      errorCode: "qa_provider_failed",
      visionReport: { failedCalls: 1, failedCallUsage: usage },
    });
  });

  it("a review that passes after a failed call still reports what that call cost", async () => {
    const failed = {
      failedCalls: 1,
      failedCallUsage: {
        inputTokens: 900,
        cachedTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
      },
    };
    const writes = fixture({ visionReport: failed });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ passed: 1 });
    expect(
      writes.find(
        (w) =>
          w.table === themeStudioVisualQaRuns && w.values.status === "passed",
      )?.values.visionReport,
    ).toMatchObject(failed);
  });
});

describe("★ the operator who started the theme is told (decision 8)", () => {
  it("ready to publish, once the settlement has committed", async () => {
    const order: string[] = [];
    fixture();
    const work = service.getMockImplementation()!;
    service.mockImplementation(async (fn) => {
      const value = await work(fn);
      order.push("committed");
      return value;
    });
    notify.mockImplementationOnce(async () => {
      order.push("told");
    });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ passed: 1 });
    expect(notify).toHaveBeenCalledWith({
      projectId: "project",
      kind: "ready",
    });
    expect(order.at(-1)).toBe("told");
    expect(order.slice(0, -1).every((step) => step === "committed")).toBe(true);
  });

  it("needs a fix when the checks stop the theme", async () => {
    fixture({ fail: true, iteration: 3 });
    await runThemeStudioVisualQaWorker({ providers: ["fake"] });
    expect(notify).toHaveBeenCalledWith({
      projectId: "project",
      kind: "needs_fix",
    });
  });

  it("nobody, when the theme had already moved on", async () => {
    fixture({ fail: true, iteration: 3, projectMoved: false });
    await runThemeStudioVisualQaWorker({ providers: ["fake"] });
    expect(notify).not.toHaveBeenCalled();
  });

  it("nobody, when the settlement rolls back", async () => {
    fixture({ fail: true, iteration: 3 });
    const work = service.getMockImplementation()!;
    let calls = 0;
    service.mockImplementation(async (fn) => {
      calls += 1;
      const value = await work(fn);
      // The settling transaction (the third: claim, history, settle) fails
      // to commit.
      if (calls === 2) throw new Error("commit failed");
      return value;
    });
    await runThemeStudioVisualQaWorker({ providers: ["fake"] }).catch(() => {});
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("★ the design review has its own capacity row (optimisation 8)", () => {
  it("passes Theme Studio's review scope to the shared capacity", async () => {
    configState.provider = "vertex-gemini";
    vertexClient.mockImplementation(() => ({
      provider: "vertex-gemini",
      generate,
    }));
    fixture();
    await runThemeStudioVisualQaWorker({ providers: ["vertex-gemini"] });
    expect(vertexClient).toHaveBeenCalledOnce();
    const options = vertexClient.mock.calls[0][1] as {
      capacity: (model: string) => unknown;
    };
    options.capacity("gemini-3.8-flash");
    expect(sharedCapacity).toHaveBeenCalledWith(
      "studio-project",
      "global",
      "gemini-3.8-flash",
      { scope: THEME_STUDIO_REVIEW_CAPACITY_SCOPE },
    );
    expect(THEME_STUDIO_REVIEW_CAPACITY_SCOPE).toBe("theme-studio-review");
  });
});

describe("★ each step starts the next at once (optimisation 2)", () => {
  it("settles a layout check inside the capture's finish: photos queued, no model call", async () => {
    const writes = fixture({
      phase: "layout",
      entry: "finish",
      ...(await draft()),
    });
    expect(await settleThemeStudioLayoutCheck("qa")).toBe("layout_passed");
    expect(generate).not.toHaveBeenCalled();
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({ kind: "images", baseVersionId: "version" });
    expect(
      writes.find(
        (w) =>
          w.table === themeStudioVisualQaRuns && w.values.status === "passed",
      ),
    ).toBeDefined();
  });

  it("a layout check whose photos are all there queues the final capture for the job already running, starting no second one", async () => {
    const { intent } = await draft();
    fixture({
      phase: "layout",
      entry: "finish",
      pkg: operatorImagePackage(),
      intent,
    });
    expect(await settleThemeStudioLayoutCheck("qa")).toBe("layout_passed");
    expect(startAfterCommit).not.toHaveBeenCalled();
    // The same check settled by the review worker does start the job.
    fixture({ phase: "layout", pkg: operatorImagePackage(), intent });
    await runThemeStudioVisualQaWorker({ providers: ["fake"] });
    expect(startAfterCommit).toHaveBeenCalledWith("inserted");
  });

  it("leaves a layout check that is not queued, or whose model is switched off, to the review route", async () => {
    claimDb([[]]);
    expect(await settleThemeStudioLayoutCheck("qa")).toBeNull();
    configState.disabledModels = new Set(["gemini-3.8-flash"]);
    fixture({ phase: "layout", entry: "finish", ...(await draft()) });
    expect(await settleThemeStudioLayoutCheck("qa")).toBeNull();
  });

  it("a deploy re-capture starts the capture job once the settlement commits", async () => {
    fixture({ oldBuild: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ recaptureQueued: 1 });
    expect(startAfterCommit).toHaveBeenCalledWith("inserted");
  });
});

describe("theme_studio.qa_waiting", () => {
  it("logs how many reviews waited over ten minutes, content-free, and nothing when none did", async () => {
    service.mockImplementationOnce(async () => [
      { waiting: 2, oldestMinutes: 14 },
    ]);
    expect(await logThemeStudioQaWaiting()).toBe(2);
    expect(logWarn).toHaveBeenCalledWith("theme_studio.qa_waiting", {
      waiting: 2,
      oldestMinutes: 14,
      overMinutes: 10,
      cap: 2,
    });
    logWarn.mockClear();
    service.mockImplementationOnce(async () => [
      { waiting: 0, oldestMinutes: null },
    ]);
    expect(await logThemeStudioQaWaiting()).toBe(0);
    expect(logWarn).not.toHaveBeenCalled();
    service.mockRejectedValueOnce(new Error("db down"));
    expect(await logThemeStudioQaWaiting()).toBe(0);
  });
});
