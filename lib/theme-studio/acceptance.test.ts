import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

import { withService } from "@/lib/db/client";
import {
  themeStudioAcceptanceRuns,
  themeStudioAssets,
  themeStudioProjects,
  themeStudioVersions,
  themeStudioVisualQaRuns,
} from "@/drizzle/schema";
import type { Db } from "@/lib/db/client";
import { operatorImagePackage } from "./_test-helpers";
import {
  currentAcceptanceBuildId,
  currentPublishEvidence,
  manualAcceptanceTransition,
  publishEvidenceWithDb,
  readReviewSeverity,
  startThemeStudioAcceptance,
  submitThemeStudioBrowserEvidence,
  verifyThemeStudioCandidateEvidence,
} from "./acceptance";
import { acceptanceAssetsDigest, gate } from "./acceptance-gates";
import { ThemeStudioError } from "./repository";

// The orchestration's database work is exercised against a real PostgreSQL
// (docs/mink-ai-theme-studio-phase5.md, "Verification"); these pin the
// refusals that must happen BEFORE any row is read or written.

const actor = { id: "00000000-0000-4000-8000-000000000001", email: "a@b.c" };
const UUID = "00000000-0000-4000-8000-0000000000aa";

afterEach(() => {
  delete process.env.THEME_STUDIO_BUILD_ID;
  delete process.env.K_REVISION;
  vi.unstubAllEnvs();
});

describe("acceptance build identity", () => {
  it("prefers an explicit build id, then the Cloud Run revision", () => {
    expect(currentAcceptanceBuildId()).toBe("development");
    process.env.K_REVISION = "storemink-web-prod-00042-abc";
    expect(currentAcceptanceBuildId()).toBe("storemink-web-prod-00042-abc");
    process.env.THEME_STUDIO_BUILD_ID = "release-7";
    expect(currentAcceptanceBuildId()).toBe("release-7");
  });
});

describe("acceptance refusals before any database work", () => {
  it("refuses malformed ids on start", async () => {
    await expect(
      startThemeStudioAcceptance(actor, {
        projectId: "nope",
        versionId: UUID,
        sessionCookie: null,
      }),
    ).rejects.toBeInstanceOf(ThemeStudioError);
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses a malformed browser report without touching the run", async () => {
    await expect(
      submitThemeStudioBrowserEvidence(actor, {
        projectId: UUID,
        runId: UUID,
        nonce: "x",
        evidence: { samples: [] },
      }),
    ).rejects.toThrow(/no samples/);
    await expect(
      submitThemeStudioBrowserEvidence(actor, {
        projectId: UUID,
        runId: UUID,
        nonce: "x",
        evidence: {
          samples: [
            { viewport: "desktop1440", surface: "home", width: "1440" },
          ],
        },
      }),
    ).rejects.toThrow(/measurement/);
    expect(withService).not.toHaveBeenCalled();
  });

  it("an unknown project has no current evidence", async () => {
    expect(await verifyThemeStudioCandidateEvidence("nope")).toEqual({
      ok: false,
      reason: "Unknown project.",
    });
    expect(withService).not.toHaveBeenCalled();
  });
});

// The manual (operator-browser) path must not bypass the visual-QA scorecard
// where automatic QA is deployed; where it is not, promotion is still allowed
// but labelled, so a candidate made that way is identifiable.
describe("manual acceptance → candidate transition", () => {
  const base = {
    outcome: "pass" as const,
    projectStatus: "ready",
    versionIsCurrent: true,
    autoQaEnabled: true,
    finalVisualQaPassed: true,
  };

  it("promotes when every gate AND the final visual review passed", () => {
    expect(manualAcceptanceTransition(base)).toEqual({
      nextState: "candidate",
      visualQa: "passed",
    });
  });

  it("holds at ready when gates passed but visual QA has not", () => {
    expect(
      manualAcceptanceTransition({ ...base, finalVisualQaPassed: false }),
    ).toEqual({ nextState: null, visualQa: "required" });
  });

  it("promotes with a label where automatic QA is not deployed", () => {
    expect(
      manualAcceptanceTransition({
        ...base,
        autoQaEnabled: false,
        finalVisualQaPassed: false,
      }),
    ).toEqual({ nextState: "candidate", visualQa: "not_configured" });
  });

  it("never moves a project for a non-current version", () => {
    expect(
      manualAcceptanceTransition({ ...base, versionIsCurrent: false }),
    ).toEqual({ nextState: null, visualQa: null });
  });

  it("demotes a failed candidate and blocks a security failure as before", () => {
    expect(
      manualAcceptanceTransition({
        ...base,
        outcome: "fail",
        projectStatus: "candidate",
      }),
    ).toEqual({ nextState: "ready", visualQa: null });
    expect(manualAcceptanceTransition({ ...base, outcome: "blocked" })).toEqual(
      { nextState: "blocked", visualQa: null },
    );
    expect(
      manualAcceptanceTransition({
        ...base,
        outcome: "fail",
        projectStatus: "ready",
      }),
    ).toEqual({ nextState: null, visualQa: null });
  });
});

// ── Publish evidence (owner decision 4). The SQL that picks the newest run
// and its bound review runs against a real PostgreSQL in
// publication-postgres.test.ts; here a scripted database returns exactly the
// rows those queries would, so every decision is pinned. ───────────────────

type Row = Record<string, unknown>;

function scripted(tables: Map<unknown, Row[]>): Db {
  const chain = (rows: Row[]) => {
    const link: Record<string, unknown> = {
      then: (resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    for (const step of ["where", "orderBy", "limit", "for"]) {
      link[step] = () => link;
    }
    return link;
  };
  return {
    select: () => ({
      from: (table: unknown) => chain(tables.get(table) ?? []),
    }),
  } as unknown as Db;
}

describe("publish evidence: today's build and a review bound to the run", () => {
  const PROJECT = "00000000-0000-4000-8000-0000000000b1";
  const VERSION = "00000000-0000-4000-8000-0000000000c1";
  const RUN = "00000000-0000-4000-8000-0000000000d1";
  const REVIEW = "00000000-0000-4000-8000-0000000000e1";
  const pkg = operatorImagePackage();
  const assets = pkg.assets.map((asset, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    purpose: "image",
    mediaType: "image/webp",
    byteSize: 90_000,
    width: asset.width,
    height: asset.height,
    sha256: asset.sha256,
  }));
  const project = { id: PROJECT, currentVersionId: VERSION };
  const version = {
    id: VERSION,
    packageJson: pkg,
    packageDigest: "p".repeat(64),
  };
  const run = (input: Row = {}): Row => ({
    id: RUN,
    status: "passed",
    packageDigest: "p".repeat(64),
    assetsDigest: acceptanceAssetsDigest(pkg, assets as never),
    buildId: "build-today",
    evidenceDigest: "e".repeat(64),
    serverReport: {
      version: 2,
      severityRules: "severity-v1",
      gates: [gate("routes.render", [])],
    },
    browserReport: {
      version: 2,
      severityRules: "severity-v1",
      gates: [
        gate("browser.tap_targets", [
          { code: "small_target", message: "Small.", where: "phone390 · home" },
        ]),
      ],
    },
    ...input,
  });
  const review = (input: Row = {}): Row => ({
    id: REVIEW,
    status: "passed",
    packageDigest: "p".repeat(64),
    buildId: "build-today",
    visionReport: {
      severityRules: "severity-v1",
      reviewSeverity: {
        outcome: "taste",
        serious: [],
        warnings: [{ code: "low_score", row: "artDirection", score: 3 }],
      },
    },
    ...input,
  });
  const db = (input: { run?: Row | null; review?: Row | null } = {}) =>
    scripted(
      new Map<unknown, Row[]>([
        [themeStudioProjects, [project]],
        [themeStudioVersions, [version]],
        [
          themeStudioAcceptanceRuns,
          input.run === null ? [] : [input.run ?? run()],
        ],
        [themeStudioAssets, assets],
        [
          themeStudioVisualQaRuns,
          input.review === null ? [] : [input.review ?? review()],
        ],
      ]),
    );
  const checksOn = () => {
    vi.stubEnv("THEME_STUDIO_BUILD_ID", "build-today");
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
    vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", "true");
  };

  it("publishes on the newest passed run of today's build with its passed review", async () => {
    checksOn();
    expect(await publishEvidenceWithDb(db(), project)).toEqual({
      ok: true,
      acceptanceRunId: RUN,
      evidenceDigest: "e".repeat(64),
      buildId: "build-today",
      gates: [
        ...(run().serverReport as { gates: unknown[] }).gates,
        ...(run().browserReport as { gates: unknown[] }).gates,
      ],
      severityRules: "severity-v1",
      review: {
        id: REVIEW,
        severity: {
          outcome: "taste",
          serious: [],
          warnings: [{ code: "low_score", row: "artDirection", score: 3 }],
        },
      },
    });
    // The shared shape, exactly: { ok, acceptanceRunId }.
    expect(await currentPublishEvidence(db(), { projectId: PROJECT })).toEqual({
      ok: true,
      acceptanceRunId: RUN,
    });
  });

  it("is old_build when the run is from an earlier build, and says Publish checks it again", async () => {
    checksOn();
    const evidence = await publishEvidenceWithDb(
      db({ run: run({ buildId: "build-yesterday" }) }),
      project,
    );
    expect(evidence).toMatchObject({ ok: false, reason: "old_build" });
    expect(!evidence.ok && evidence.detail).toMatch(
      /checks this design again on today's build first/,
    );
    expect(
      await currentPublishEvidence(db({ run: run({ buildId: "x" }) }), {
        projectId: PROJECT,
      }),
    ).toEqual({
      ok: false,
      reason: "old_build",
    });
  });

  it.each([
    ["no run reached a verdict", { run: null }],
    ["the newest verdict failed", { run: run({ status: "failed" }) }],
    [
      "the newest verdict was a security block",
      { run: run({ status: "blocked" }) },
    ],
    [
      "a passed run with no evidence digest",
      { run: run({ evidenceDigest: null }) },
    ],
    [
      "the run judged another package",
      { run: run({ packageDigest: "q".repeat(64) }) },
    ],
    [
      "the pictures changed since",
      { run: run({ assetsDigest: "a".repeat(64) }) },
    ],
  ] as const)("is none when %s", async (_label, input) => {
    checksOn();
    expect(await publishEvidenceWithDb(db(input), project)).toMatchObject({
      ok: false,
      reason: "none",
    });
  });

  it("is none for a project with no current version, without reading anything", async () => {
    checksOn();
    expect(
      await publishEvidenceWithDb(db(), {
        id: PROJECT,
        currentVersionId: null,
      }),
    ).toMatchObject({ ok: false, reason: "none" });
  });

  it.each([
    ["no review is bound to the run", { review: null }],
    ["the bound review failed", { review: review({ status: "failed" }) }],
    [
      "the bound review is still waiting",
      { review: review({ status: "queued" }) },
    ],
    [
      "the bound review judged another package",
      { review: review({ packageDigest: "q".repeat(64) }) },
    ],
    [
      "the bound review is from another build",
      { review: review({ buildId: "build-yesterday" }) },
    ],
  ] as const)("is no_review when %s", async (_label, input) => {
    checksOn();
    expect(await publishEvidenceWithDb(db(input), project)).toMatchObject({
      ok: false,
      reason: "no_review",
    });
  });

  it("checks the build before the review: an old run with no review is old_build", async () => {
    checksOn();
    expect(
      await publishEvidenceWithDb(
        db({ run: run({ buildId: "build-yesterday" }), review: null }),
        project,
      ),
    ).toMatchObject({ ok: false, reason: "old_build" });
  });

  it("with the automatic checks off, a passed run alone publishes (the labelled exception)", async () => {
    vi.stubEnv("THEME_STUDIO_BUILD_ID", "build-today");
    expect(
      await publishEvidenceWithDb(db({ review: null }), project),
    ).toMatchObject({
      ok: true,
      acceptanceRunId: RUN,
      review: null,
    });
    const old = await publishEvidenceWithDb(
      db({ run: run({ buildId: "build-yesterday" }) }),
      project,
    );
    expect(!old.ok && old.detail).toBe(
      "The evidence was rendered by an earlier build. Run the checks again.",
    );
  });

  it("reads a run from before severity-v1 as unlabelled, never as severity-v1", async () => {
    checksOn();
    const evidence = await publishEvidenceWithDb(
      db({
        run: run({
          serverReport: { version: 2, gates: [] },
          browserReport: { version: 2, gates: [] },
        }),
      }),
      project,
    );
    expect(evidence).toMatchObject({
      ok: true,
      severityRules: null,
      gates: [],
    });
  });

  it("refuses a malformed project id or an unknown project without guessing", async () => {
    expect(
      await currentPublishEvidence(scripted(new Map()), { projectId: "nope" }),
    ).toEqual({
      ok: false,
      reason: "none",
    });
    expect(
      await currentPublishEvidence(scripted(new Map()), { projectId: PROJECT }),
    ).toEqual({
      ok: false,
      reason: "none",
    });
  });
});

describe("the design review's own split, as stored", () => {
  it("reads outcome, serious findings and warnings", () => {
    expect(
      readReviewSeverity({
        reviewSeverity: {
          outcome: "serious",
          serious: [
            { code: "copied" },
            { code: "very_low_score", row: "commerceClarity", score: 2 },
          ],
          warnings: [{ code: "image_redraw", slotId: "slot-3" }],
        },
      }),
    ).toEqual({
      outcome: "serious",
      serious: [
        { code: "copied" },
        { code: "very_low_score", row: "commerceClarity", score: 2 },
      ],
      warnings: [{ code: "image_redraw", slotId: "slot-3" }],
    });
  });

  it("is null for a review from before the split, or an unknown outcome", () => {
    expect(readReviewSeverity({ scores: {} })).toBeNull();
    expect(readReviewSeverity(null)).toBeNull();
    expect(
      readReviewSeverity({ reviewSeverity: { outcome: "maybe" } }),
    ).toBeNull();
  });

  it("drops what it cannot read rather than inventing it", () => {
    expect(
      readReviewSeverity({
        reviewSeverity: {
          outcome: "taste",
          serious: "none",
          warnings: [
            { code: "Not A Code" },
            { code: "low_score", row: "notARow", score: "3" },
            7,
          ],
        },
      }),
    ).toEqual({
      outcome: "taste",
      serious: [],
      warnings: [{ code: "low_score" }],
    });
  });
});
