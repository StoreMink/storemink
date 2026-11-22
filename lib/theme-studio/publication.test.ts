import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The refusals that must happen before the database is touched, and the
// decisions Publish makes inside its first transaction, over a scripted
// database. The whole publish, re-check, retry, hide and show sequence, and
// every database rule behind it, runs against a real PostgreSQL in
// publication-postgres.test.ts (THEME_STUDIO_RECOVERY_DB_TEST=1).
// ---------------------------------------------------------------------------

const { evidence, recheck, config, storage, writeStoreObject, catalogue } =
  vi.hoisted(() => ({
    /** The public catalogue a publish is compared with; empty by default. */
    catalogue: { themes: [] as unknown[] },
    evidence: vi.fn(),
    recheck: vi.fn(),
    config: { autoQaEnabled: true },
    /** Whether media storage reads as configured (the default deps need it). */
    storage: { configured: false },
    writeStoreObject: vi.fn(),
  }));
// The catalogue read is its own query (publish-distinctness.ts); each test
// here says what is in the catalogue.
vi.mock("./publish-distinctness", () => ({
  publishedThemeFingerprints: vi.fn(async () => catalogue.themes),
}));

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/storage/gcs", () => ({
  get gcsConfigured() {
    return storage.configured;
  },
  gcsPathFromUrl: () => null,
  gcsPublicUrl: (path: string) =>
    `https://storage.googleapis.com/media-bucket/${path}`,
  gcsUploadObject: vi.fn(async () => {
    throw new Error("publication writes through writeStoreObject");
  }),
}));
// Release images go through the re-upload guard's one writer (takedown A8);
// every test here says what it answers.
vi.mock("@/lib/storage/store-objects", () => ({ writeStoreObject }));
vi.mock("./acceptance", async (original) => ({
  ...(await original<typeof import("./acceptance")>()),
  publishEvidenceWithDb: evidence,
}));
vi.mock("./capture", () => ({ queueThemeStudioRecheck: recheck }));
vi.mock("./config", async (original) => {
  const actual = await original<typeof import("./config")>();
  return {
    ...actual,
    getThemeStudioConfig: () => ({
      ...actual.getThemeStudioConfig({}),
      autoQaEnabled: config.autoQaEnabled,
    }),
  };
});
vi.mock("./repository", async (original) => ({
  ...(await original<typeof import("./repository")>()),
  recordThemeStudioEvent: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import {
  themeCatalogAudit,
  themeCatalogEntries,
  themeReleases,
  themeStudioAssets,
  themeStudioProjects,
  themeStudioPublications,
  themeStudioVersions,
} from "@/drizzle/schema";
import { operatorImagePackage, placeholderPackage } from "./_test-helpers";
import { gate } from "./acceptance-gates";
import { themeFingerprint } from "./fingerprint";
import type { ThemePackageV2 } from "./contracts";
import {
  changeThemeStudioCatalog,
  getThemeStudioReleaseState,
  publishThemeStudioProject,
  recheckStartedMessage,
  type PublicationDeps,
} from "./publication";
import { recordThemeStudioEvent, ThemeStudioError } from "./repository";
import { BlockedUploadError } from "@/lib/moderation/upload-guard";
import { hex } from "./_test-helpers";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "owner@storemink.com",
};
const projectId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const reviewId = "55555555-5555-4555-8555-555555555555";

describe("Phase 6 input boundary", () => {
  beforeEach(() => {
    vi.mocked(withService).mockClear();
  });

  it("refuses an unknown project id everywhere", async () => {
    await expect(
      publishThemeStudioProject(actor, {
        projectId: "nope",
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(ThemeStudioError);
    await expect(
      changeThemeStudioCatalog(actor, { projectId: "nope", change: {} }),
    ).rejects.toThrow(/no longer exists/);
    expect(await getThemeStudioReleaseState("nope")).toBeNull();
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses to publish when media storage is not configured", async () => {
    await expect(
      publishThemeStudioProject(actor, {
        projectId,
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/Media storage is not configured/);
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses an unknown catalog change before touching the database", async () => {
    await expect(
      changeThemeStudioCatalog(actor, {
        projectId,
        change: { action: "delete" },
      }),
    ).rejects.toThrow(/Unknown catalog change/);
    expect(withService).not.toHaveBeenCalled();
  });
});

// ── A scripted database: reads come from fixed rows per table, writes are
// recorded. Enough of drizzle's chain for publication's own queries. ──────

type Row = Record<string, unknown>;

function scriptedDb(tables: Map<unknown, Row[]>) {
  const updates: { table: unknown; values: Row }[] = [];
  const inserts: { table: unknown; values: Row }[] = [];
  const chain = (rows: Row[]) => {
    const link: Record<string, unknown> = {
      then: (resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    for (const step of [
      "where",
      "for",
      "limit",
      "orderBy",
      "leftJoin",
      "innerJoin",
    ]) {
      link[step] = () => link;
    }
    return link;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => chain(tables.get(table) ?? []),
    }),
    execute: async () => [],
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: async () => {
          updates.push({ table, values });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        inserts.push({ table, values });
        const result = {
          returning: async () => [{ id: "attempt-1" }],
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        };
        return result;
      },
    }),
  };
  vi.mocked(withService).mockImplementation((async (
    work: (db: unknown) => unknown,
  ) => work(db)) as never);
  return { updates, inserts };
}

function project(input: Partial<Row> = {}): Row {
  return {
    id: projectId,
    themeId: "clay-co",
    status: "candidate",
    revision: 7,
    currentVersionId: versionId,
    ...input,
  };
}

function version(pkg: ThemePackageV2 = operatorImagePackage()): Row {
  return {
    id: versionId,
    projectId,
    versionNumber: 4,
    packageJson: pkg,
    packageDigest: "d".repeat(64),
  };
}

const passedEvidence = (review: "passed" | "none" = "passed") => ({
  ok: true as const,
  acceptanceRunId: runId,
  evidenceDigest: "e".repeat(64),
  buildId: "build-today",
  gates: [
    gate("routes.render", []),
    gate("browser.tap_targets", [
      {
        code: "small_target",
        message: "A 20x20 tap target.",
        where: "phone390 · home",
      },
    ]),
  ],
  severityRules: "severity-v1",
  review:
    review === "passed"
      ? {
          id: reviewId,
          severity: {
            outcome: "taste" as const,
            serious: [],
            warnings: [{ code: "palette_only" }],
          },
        }
      : null,
});

/** Storage that refuses to be reached: these tests stop after the attempt
 * row, because no stored picture exists in the scripted database. */
const deps: PublicationDeps = {
  storeObject: vi.fn(async () => {
    throw new Error("storage must not be reached");
  }),
  publicUrl: (path) => `https://storage.googleapis.com/test-bucket/${path}`,
  checkDemo: vi.fn(async () => []),
  now: () => new Date("2026-10-24T10:00:00Z"),
};

const events = () =>
  vi.mocked(recordThemeStudioEvent).mock.calls.map(([, event]) => event);

describe("Publish on today's evidence (owner decision 4)", () => {
  beforeEach(() => {
    config.autoQaEnabled = true;
    catalogue.themes = [];
  });

  it("★★ refuses a theme too close to one already in the catalogue, before measuring or writing anything", async () => {
    const { updates, inserts } = scriptedDb(
      new Map<unknown, Row[]>([
        [themeStudioProjects, [project()]],
        [themeStudioVersions, [version()]],
      ]),
    );
    // The catalogue already holds this very design under another name.
    catalogue.themes = [
      {
        themeId: "harbour",
        name: "Harbour",
        fingerprint: themeFingerprint(operatorImagePackage().definition, {
          styling: true,
        }),
      },
    ];
    await expect(
      publishThemeStudioProject(
        actor,
        { projectId, expectedRevision: 7 },
        deps,
      ),
    ).rejects.toThrow(
      /looks too much like "Harbour", which is already in the catalogue: they are 100% alike/,
    );
    expect(evidence).not.toHaveBeenCalled();
    expect(recheck).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("re-checks a design checked on an earlier build instead of publishing, and writes nothing itself", async () => {
    const { updates, inserts } = scriptedDb(
      new Map<unknown, Row[]>([
        [themeStudioProjects, [project()]],
        [themeStudioVersions, [version()]],
      ]),
    );
    evidence.mockResolvedValue({
      ok: false,
      reason: "old_build",
      detail: "StoreMink was updated since these checks.",
    });
    recheck.mockResolvedValue({ captureId: "capture-1", inPlace: true });
    const result = await publishThemeStudioProject(
      actor,
      { projectId, expectedRevision: 7 },
      deps,
    );
    expect(result).toEqual({
      ok: false,
      kind: "rechecking",
      problems: [recheckStartedMessage("old_build")],
      captureId: "capture-1",
      inPlace: true,
      reason: "old_build",
    });
    // The re-check is queued after the publish transaction, with the
    // revision it read, so any change in between refuses it.
    expect(recheck).toHaveBeenCalledWith(actor, {
      projectId,
      versionId,
      expectedRevision: 7,
      reason: "publish_recheck",
    });
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
    expect(events()).toEqual([]);
  });

  it("re-checks on Try again too: a publish that did not finish never resumes on an earlier build's evidence", async () => {
    scriptedDb(
      new Map<unknown, Row[]>([
        [themeStudioProjects, [project({ status: "approved", revision: 9 })]],
        [themeStudioVersions, [version()]],
        [
          themeStudioPublications,
          [
            {
              id: "attempt-0",
              status: "failed",
              versionId,
              releaseId: "release-0",
              releaseVersion: "1.0.0",
              updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
            },
          ],
        ],
      ]),
    );
    evidence.mockResolvedValue({
      ok: false,
      reason: "old_build",
      detail: "StoreMink was updated since these checks.",
    });
    recheck.mockResolvedValue({ captureId: "capture-2", inPlace: true });
    const result = await publishThemeStudioProject(
      actor,
      { projectId, expectedRevision: 9 },
      deps,
    );
    expect(result).toMatchObject({ kind: "rechecking", reason: "old_build" });
    expect(recheck).toHaveBeenCalledWith(actor, {
      projectId,
      versionId,
      expectedRevision: 9,
      reason: "publish_recheck",
    });
  });

  it("re-checks a check run with no design review of its own (the in-browser runner's)", async () => {
    scriptedDb(
      new Map<unknown, Row[]>([
        [themeStudioProjects, [project()]],
        [themeStudioVersions, [version()]],
      ]),
    );
    evidence.mockResolvedValue({
      ok: false,
      reason: "no_review",
      detail: "No passed design review belongs to the newest check.",
    });
    recheck.mockResolvedValue({ captureId: "capture-3", inPlace: true });
    const result = await publishThemeStudioProject(
      actor,
      { projectId, expectedRevision: 7 },
      deps,
    );
    expect(result).toMatchObject({
      ok: false,
      kind: "rechecking",
      reason: "no_review",
      problems: [recheckStartedMessage("no_review")],
    });
  });

  it("with the automatic checks off, refuses old evidence with its reason and starts nothing", async () => {
    config.autoQaEnabled = false;
    const { updates, inserts } = scriptedDb(
      new Map<unknown, Row[]>([
        [themeStudioProjects, [project()]],
        [themeStudioVersions, [version()]],
      ]),
    );
    evidence.mockResolvedValue({
      ok: false,
      reason: "old_build",
      detail:
        "The evidence was rendered by an earlier build. Run the checks again.",
    });
    await expect(
      publishThemeStudioProject(
        actor,
        { projectId, expectedRevision: 7 },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "stale",
      message:
        "The evidence was rendered by an earlier build. Run the checks again.",
    });
    expect(recheck).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it.each([
    [
      "a stale tab",
      project({ revision: 8 }),
      [],
      { code: "stale", message: /changed in another tab/ },
    ],
    [
      "a theme that is not ready to publish",
      project({ status: "ready" }),
      [],
      { code: "illegal_state", message: /checks have passed/ },
    ],
    [
      "a publish already in progress",
      project({ status: "approved" }),
      [
        {
          id: "attempt-0",
          status: "publishing",
          versionId,
          releaseId: null,
          releaseVersion: "1.0.0",
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
      { code: "illegal_state", message: /already in progress/ },
    ],
  ] as const)(
    "refuses %s before reading any evidence or starting a re-check",
    async (_label, row, attempts, refusal) => {
      scriptedDb(
        new Map<unknown, Row[]>([
          [themeStudioProjects, [row]],
          [themeStudioVersions, [version()]],
          [themeStudioPublications, [...attempts]],
        ]),
      );
      await expect(
        publishThemeStudioProject(
          actor,
          { projectId, expectedRevision: 7 },
          deps,
        ),
      ).rejects.toMatchObject({
        code: refusal.code,
        message: expect.stringMatching(refusal.message),
      });
      expect(evidence).not.toHaveBeenCalled();
      expect(recheck).not.toHaveBeenCalled();
    },
  );

  it("refuses a package that could never be published before measuring anything again", async () => {
    scriptedDb(
      new Map<unknown, Row[]>([
        [themeStudioProjects, [project()]],
        [themeStudioVersions, [version(placeholderPackage())]],
      ]),
    );
    await expect(
      publishThemeStudioProject(
        actor,
        { projectId, expectedRevision: 7 },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "illegal_state",
      message: expect.stringMatching(/placeholder/),
    });
    expect(evidence).not.toHaveBeenCalled();
    expect(recheck).not.toHaveBeenCalled();
  });

  it("publishes on today's evidence with its warnings, records them with severity-v1, and writes no project_approved", async () => {
    const { updates, inserts } = scriptedDb(
      new Map<unknown, Row[]>([
        [themeStudioProjects, [project()]],
        [themeStudioVersions, [version()]],
      ]),
    );
    evidence.mockResolvedValue(passedEvidence());
    const result = await publishThemeStudioProject(
      actor,
      { projectId, expectedRevision: 7 },
      deps,
    );
    // The scripted database stores no picture, so the attempt then fails as
    // a recorded failure; the decisions before it are what this pins.
    expect(result).toMatchObject({
      ok: false,
      kind: "failed",
      publicationId: "attempt-1",
    });
    expect(recheck).not.toHaveBeenCalled();
    expect(updates[0]).toEqual({
      table: themeStudioProjects,
      values: { status: "approved", revision: 8 },
    });
    expect(inserts[0]).toMatchObject({
      table: themeStudioPublications,
      values: { acceptanceRunId: runId, versionId, releaseVersion: "1.0.0" },
    });
    const types = events().map((e) => e.eventType);
    expect(types).toEqual(["publication_started", "publication_failed"]);
    expect(types).not.toContain("project_approved");
    expect(events()[0].detail).toEqual({
      publicationId: "attempt-1",
      versionId,
      releaseVersion: "1.0.0",
      resumed: false,
      acceptanceRunId: runId,
      severityRules: "severity-v1",
      measuredUnder: "severity-v1",
      designReview: "passed",
      designReviewId: reviewId,
      warnings: {
        count: 2,
        kinds: [
          {
            source: "checks",
            gate: "browser.tap_targets",
            code: "small_target",
            count: 1,
          },
          { source: "review", gate: null, code: "palette_only", count: 1 },
        ],
        omitted: 0,
      },
    });
  });

  it("labels the exception where the automatic checks are off: a passed run alone, no review", async () => {
    config.autoQaEnabled = false;
    scriptedDb(
      new Map<unknown, Row[]>([
        [themeStudioProjects, [project()]],
        [themeStudioVersions, [version()]],
      ]),
    );
    evidence.mockResolvedValue(passedEvidence("none"));
    await publishThemeStudioProject(
      actor,
      { projectId, expectedRevision: 7 },
      deps,
    );
    expect(events()[0].detail).toMatchObject({
      designReview: "not_configured",
      designReviewId: null,
    });
  });

  it("retires an abandoned attempt and resumes the release that version already stored", async () => {
    const { updates, inserts } = scriptedDb(
      new Map<unknown, Row[]>([
        [themeStudioProjects, [project({ status: "approved" })]],
        [themeStudioVersions, [version()]],
        [
          themeStudioPublications,
          [
            {
              id: "attempt-0",
              status: "publishing",
              versionId,
              releaseId: "release-0",
              releaseVersion: "1.0.0",
              manifestDigest: "f".repeat(64),
              updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
            },
          ],
        ],
      ]),
    );
    evidence.mockResolvedValue(passedEvidence());
    await publishThemeStudioProject(
      actor,
      { projectId, expectedRevision: 7 },
      deps,
    );
    expect(updates[0]).toMatchObject({
      table: themeStudioPublications,
      values: { status: "failed" },
    });
    // A retry: the project is already approved, so it is not written again.
    expect(updates.some((u) => u.table === themeStudioProjects)).toBe(false);
    expect(inserts[0].values).toMatchObject({
      releaseId: "release-0",
      releaseVersion: "1.0.0",
      acceptanceRunId: runId,
    });
    expect(events()[0].detail).toMatchObject({ resumed: true });
  });

  it("says what happens next without a long dash or a credit count", () => {
    for (const reason of ["old_build", "no_review", "none"] as const) {
      const message = recheckStartedMessage(reason);
      expect(message).toMatch(/checked again on today's build first/);
      expect(message).toMatch(/3 to 5 minutes/);
      expect(message).not.toMatch(/[\u2013\u2014]|credit/i);
    }
  });
});

describe("release images through the re-upload guard (takedown D4, A8)", () => {
  const BLOCK = "b0000000-0000-4000-8000-000000000001";

  /** The stored WebP bytes of every image the package names, whose digest
   * is the one the package declares. */
  function storedImages(pkg: ThemePackageV2): Row[] {
    return pkg.assets.map((asset) => {
      const bytes = new Uint8Array(Buffer.from(`image-${asset.id}`));
      return {
        sha256: hex(`image-${asset.id}`),
        mediaType: "image/webp",
        bytes,
      };
    });
  }

  function publishableDb() {
    const pkg = operatorImagePackage();
    return {
      pkg,
      ...scriptedDb(
        new Map<unknown, Row[]>([
          [themeStudioProjects, [project()]],
          [themeStudioVersions, [version(pkg)]],
          [themeStudioAssets, storedImages(pkg)],
        ]),
      ),
    };
  }

  beforeEach(() => {
    vi.mocked(recordThemeStudioEvent).mockClear();
    evidence.mockResolvedValue(passedEvidence());
    config.autoQaEnabled = true;
    storage.configured = true;
  });

  afterEach(() => {
    storage.configured = false;
  });

  it("writes every release image with no store and the one-minute cache", async () => {
    const { pkg } = publishableDb();
    writeStoreObject.mockRejectedValue(new Error("storage unavailable"));
    const result = await publishThemeStudioProject(actor, {
      projectId,
      expectedRevision: 7,
    });
    expect(writeStoreObject).toHaveBeenCalledTimes(pkg.assets.length);
    for (const [path, bytes, type, options] of writeStoreObject.mock.calls) {
      expect(path).toMatch(
        /^theme-releases\/[a-z0-9-]+\/1\.0\.0\/[a-z0-9-]+-[a-f0-9]{16}\.webp$/,
      );
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(type).toBe("image/webp");
      expect(options).toEqual({
        storeId: null,
        cacheControl: "public, max-age=60",
        via: "theme_studio_publication",
        actor: "owner@storemink.com",
      });
    }
    // A plain storage failure keeps its own sentence.
    expect(result).toMatchObject({ ok: false, kind: "failed" });
    if (result.kind !== "failed") throw new Error("expected a failure");
    expect(result.problems).toEqual(
      pkg.assets.map((a) => `Image ${a.id} could not be copied to storage.`),
    );
  });

  it("names a blocked image to the operator, and stores no release", async () => {
    const { pkg, inserts } = publishableDb();
    const blocked = pkg.assets[0].id;
    writeStoreObject.mockImplementation(async (path: string) => {
      if (path.includes(`/${blocked}-`)) {
        throw new BlockedUploadError({
          told: false,
          kindWord: "image",
          blockId: BLOCK,
        });
      }
      return `https://storage.googleapis.com/media-bucket/${path}`;
    });
    const result = await publishThemeStudioProject(actor, {
      projectId,
      expectedRevision: 7,
    });
    expect(result).toMatchObject({ ok: false, kind: "failed" });
    if (result.kind !== "failed") throw new Error("expected a failure");
    expect(result.problems).toEqual([
      `Image ${blocked} is a file StoreMink has blocked (block ${BLOCK}), so it can't be published. Replace the image, then publish again.`,
    ]);
    // The other images were still written, and nothing points at a release.
    expect(writeStoreObject).toHaveBeenCalledTimes(pkg.assets.length);
    expect(inserts.some((i) => i.table === themeReleases)).toBe(false);
    expect(events().map((e) => e.eventType)).toEqual([
      "publication_started",
      "publication_failed",
    ]);
  });
});

describe("the release state", () => {
  beforeEach(() => {
    config.autoQaEnabled = true;
    catalogue.themes = [];
  });

  const tables = (
    row: Row,
    extra: { pkg?: ThemePackageV2; publications?: Row[] } = {},
  ) =>
    new Map<unknown, Row[]>([
      [themeStudioProjects, [row]],
      [themeStudioVersions, [version(extra.pkg)]],
      [themeStudioPublications, extra.publications ?? []],
      [themeCatalogEntries, []],
      [themeReleases, []],
      [themeCatalogAudit, []],
      [themeStudioAssets, []],
    ]);

  it("★★ shows the similarity refusal before Publish is pressed, and offers no re-check that could not help", async () => {
    scriptedDb(tables(project()));
    evidence.mockResolvedValue({
      ok: false,
      reason: "old_build",
      detail: "StoreMink was updated since these checks.",
    });
    catalogue.themes = [
      {
        themeId: "harbour",
        name: "Harbour",
        fingerprint: themeFingerprint(operatorImagePackage().definition, {
          styling: true,
        }),
      },
    ];
    const state = await getThemeStudioReleaseState(projectId);
    expect(state?.blockers).toHaveLength(1);
    expect(state?.blockers[0]).toMatch(/looks too much like "Harbour"/);
    expect(state?.recheckOnPublish).toBe(false);
  });

  it("offers a re-check on Publish when Ready to publish evidence is from an earlier build", async () => {
    scriptedDb(tables(project()));
    evidence.mockResolvedValue({
      ok: false,
      reason: "old_build",
      detail: "StoreMink was updated since these checks.",
    });
    expect(await getThemeStudioReleaseState(projectId)).toMatchObject({
      evidence: {
        ok: false,
        reason: "StoreMink was updated since these checks.",
      },
      evidenceGap: "old_build",
      recheckOnPublish: true,
      blockers: [],
      warnings: [],
    });
  });

  it("offers no re-check where the automatic checks are off, or before the theme is ready", async () => {
    evidence.mockResolvedValue({
      ok: false,
      reason: "old_build",
      detail: "The evidence was rendered by an earlier build.",
    });
    scriptedDb(tables(project({ status: "ready" })));
    expect(await getThemeStudioReleaseState(projectId)).toMatchObject({
      evidenceGap: "old_build",
      recheckOnPublish: false,
    });
    config.autoQaEnabled = false;
    scriptedDb(tables(project()));
    expect(await getThemeStudioReleaseState(projectId)).toMatchObject({
      recheckOnPublish: false,
    });
  });

  it("offers no re-check where Publish would refuse first: a package that can never publish, or a publish still running", async () => {
    evidence.mockResolvedValue({
      ok: false,
      reason: "old_build",
      detail: "StoreMink was updated since these checks.",
    });
    scriptedDb(tables(project(), { pkg: placeholderPackage() }));
    expect(await getThemeStudioReleaseState(projectId)).toMatchObject({
      recheckOnPublish: false,
      blockers: [expect.stringMatching(/placeholder/)],
    });
    scriptedDb(
      tables(project({ status: "approved" }), {
        publications: [
          {
            id: "attempt-0",
            status: "publishing",
            versionId,
            releaseVersion: "1.0.0",
            failure: [],
            createdByEmail: actor.email,
            createdAt: new Date().toISOString(),
            updatedAt: new Date(Date.now() - 60_000).toISOString(),
            completedAt: null,
          },
        ],
      }),
    );
    expect(await getThemeStudioReleaseState(projectId)).toMatchObject({
      recheckOnPublish: false,
    });
  });

  it("lists the warnings it would go live with when today's evidence holds", async () => {
    scriptedDb(tables(project()));
    evidence.mockResolvedValue(passedEvidence());
    const state = await getThemeStudioReleaseState(projectId);
    expect(state).toMatchObject({
      evidence: { ok: true, runId, evidenceDigest: "e".repeat(64) },
      evidenceGap: null,
      recheckOnPublish: false,
    });
    expect(state!.warnings.map((w) => [w.source, w.code])).toEqual([
      ["checks", "small_target"],
      ["review", "palette_only"],
    ]);
  });
});
