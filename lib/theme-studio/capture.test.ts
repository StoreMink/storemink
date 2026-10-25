import { afterEach, describe, expect, it, vi } from "vitest";

const withService = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({ withService }));
vi.mock("@/lib/observability/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/logger")>()),
  logWarn,
}));
vi.mock("./contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./contracts")>()),
  validateThemePackageV2: vi.fn(() => ({ ok: true, value: {} })),
}));
vi.mock("./capture-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capture-core")>()),
  captureBlockers: vi.fn(() => []),
}));
const openPreview = vi.hoisted(() => vi.fn());
vi.mock("./preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./preview")>()),
  openThemeStudioPreview: openPreview,
}));
// TS-3A seams: the capture job's start after queueing, the operator's
// notice, and the layout check settled inside the finish.
const { startNow, startAfterCommit, notify, settleLayout } = vi.hoisted(() => ({
  startNow: vi.fn(async () => "started"),
  startAfterCommit: vi.fn(() => {}),
  notify: vi.fn(async () => {}),
  settleLayout: vi.fn(async () => "layout_passed"),
}));
vi.mock("./capture-start", () => ({
  startCaptureJobForQueued: startNow,
  startCaptureJobAfterCommit: startAfterCommit,
}));
// Builder 3B's notice for a caller with no transaction open: sent only
// after the settling transaction has committed.
vi.mock("./notify", () => ({ sendThemeStudioNotice: notify }));
vi.mock("./visual-qa", () => ({
  settleThemeStudioLayoutCheck: settleLayout,
}));

/** An UPDATE's `where`: awaited as is, or `.returning()` the rows it moved
 * (one, unless the test says none). */
function updated(rows: unknown[] = [{ id: "moved" }]) {
  return Object.assign(Promise.resolve([]), {
    returning: async () => rows,
  });
}

import {
  queueThemeStudioCapture,
  queueThemeStudioRecheck,
  queueThemeStudioRecheckWithDb,
  finishThemeStudioCapture,
  claimThemeStudioCapture,
  sweepStaleThemeStudioCaptures,
} from "./capture";
import { captureBlockers, captureShots, recheckReasonOf } from "./capture-core";
import {
  themeStudioCaptures,
  themeStudioEvents,
  themeStudioProjects,
} from "@/drizzle/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "op@test.dev",
};
const input = {
  projectId: "22222222-2222-4222-8222-222222222222",
  versionId: "33333333-3333-4333-8333-333333333333",
  expectedRevision: 1,
  expectedPackageDigest: "d".repeat(64),
  idempotencyKey: "capture-test-key-01",
};

function queueDb({
  qaStatus = "failed",
  revision = 1,
  currentVersionId = input.versionId,
  prior = null,
}: {
  qaStatus?: string;
  revision?: number;
  currentVersionId?: string;
  prior?: { id: string; projectId: string } | null;
} = {}) {
  const results = [
    [{ id: input.projectId, status: "ready", revision, currentVersionId }],
    prior ? [prior] : [],
    [{ packageJson: {}, packageDigest: input.expectedPackageDigest, qaStatus }],
  ];
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    select: () => {
      const query = {
        from: () => query,
        where: () => query,
        for: () => query,
        limit: async () => results.shift(),
      };
      return query;
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { returning: async () => [{ id: "capture-id" }] };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { where: () => updated() };
      },
    }),
  };
  withService.mockImplementation(async (work) => work(db));
  return writes;
}

describe("Theme Studio catalog capture deployment gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["earlier-build"])(
    "retries automatic results from an earlier build (%s) before saving images",
    async (buildId) => {
      vi.stubEnv("THEME_STUDIO_BUILD_ID", "current-build");
      const held = {
        id: input.versionId,
        automatic: true,
        attemptCount: 1,
        maxAttempts: 5,
      };
      const writes: Record<string, unknown>[] = [];
      const inserted: unknown[] = [];
      const db = {
        select: () => {
          const query = {
            from: () => query,
            where: () => query,
            limit: () => query,
            for: () => query,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve([held]).then(resolve),
          };
          return query;
        },
        update: () => ({
          set: (values: Record<string, unknown>) => {
            writes.push(values);
            return { where: () => updated() };
          },
        }),
        insert: (table: unknown) => {
          inserted.push(table);
          return { values: async () => [] };
        },
      };
      withService.mockImplementation(async (work) => work(db));
      expect(
        await finishThemeStudioCapture({
          captureId: input.versionId,
          leaseToken: actor.id,
          images: [],
          qa: { buildId, evidence: {}, screenshots: [] },
        }),
      ).toEqual({ status: "requeued" });
      expect(writes).toEqual([
        { status: "queued", leaseOwner: null, leaseExpiresAt: null },
      ]);
      // Nothing saved but the retry's own event (TS-3A): no picture, no
      // version.
      expect(inserted).toEqual([themeStudioEvents]);
    },
  );

  it("restarts failed automatic QA with browser evidence and a bounded retry budget", async () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
    vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", "true");
    const writes = queueDb();
    expect(await queueThemeStudioCapture(actor, input)).toEqual({
      captureId: "capture-id",
      duplicate: false,
    });
    expect(
      writes.find((write) => write.table === themeStudioCaptures)?.values,
    ).toMatchObject({
      versionId: input.versionId,
      packageDigest: input.expectedPackageDigest,
      automatic: true,
      previousStatus: "generating",
      qaIteration: 0,
      maxAttempts: 5,
    });
    expect(
      writes.find((write) => write.table === themeStudioProjects)?.values,
    ).toEqual({ status: "generating", revision: 2 });
  });

  it.each(["not_required", "passed"])(
    "★ checks catalogue pictures of a %s version with automatic checks on, at the repair ceiling",
    async (qaStatus) => {
      vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
      vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", "true");
      const writes = queueDb({ qaStatus });
      await queueThemeStudioCapture(actor, input);
      // A new hidden version through the full checks and the design review,
      // never a paid restyle the operator did not ask for.
      expect(
        writes.find((write) => write.table === themeStudioCaptures)?.values,
      ).toMatchObject({
        phase: "final",
        automatic: true,
        previousStatus: "generating",
        qaIteration: 3,
        maxAttempts: 5,
        idempotencyKey: input.idempotencyKey,
      });
      expect(
        writes.find((write) => write.table === themeStudioProjects)?.values,
      ).toEqual({ status: "generating", revision: 2 });
    },
  );

  it.each(["not_required", "passed", "failed"])(
    "keeps a manual capture of a %s version only with automatic checks off",
    async (qaStatus) => {
      vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
      vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", "false");
      const writes = queueDb({ qaStatus });
      await queueThemeStudioCapture(actor, input);
      const capture = writes.find(
        (write) => write.table === themeStudioCaptures,
      )?.values;
      expect(capture).toHaveProperty("previousStatus", "ready");
      expect(capture).not.toHaveProperty("automatic");
      expect(capture).not.toHaveProperty("maxAttempts");
    },
  );

  it.each([
    "recheck_check_again_0f6b4c1e-8f3a-4d2b-9c7e-1a2b3c4d5e6f",
    "auto_recapture_0f6b4c1e-8f3a-4d2b-9c7e-1a2b3c4d5e6f",
    "auto_final_0f6b4c1e-8f3a-4d2b",
  ])(
    "★ refuses an operator key that would pass for the server's own (%s)",
    async (idempotencyKey) => {
      vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
      vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", "true");
      await expect(
        queueThemeStudioCapture(actor, { ...input, idempotencyKey }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(withService).not.toHaveBeenCalled();
    },
  );

  it("replays the same request without scheduling a second capture", async () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
    const writes = queueDb({
      revision: 2,
      prior: { id: "prior", projectId: input.projectId },
    });
    expect(await queueThemeStudioCapture(actor, input)).toEqual({
      captureId: "prior",
      duplicate: true,
    });
    expect(writes).toEqual([]);
  });

  it.each([{ revision: 2 }, { currentVersionId: "another-version" }])(
    "refuses a recovery based on stale project state %j",
    async (state) => {
      vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
      const writes = queueDb(state);
      await expect(queueThemeStudioCapture(actor, input)).rejects.toThrow();
      expect(writes).toEqual([]);
    },
  );

  it("does not restart QA while artwork remains unfinished", async () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
    vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", "true");
    const writes = queueDb();
    vi.mocked(captureBlockers)
      .mockReturnValueOnce(["Missing category imagery"])
      .mockReturnValueOnce(["Missing category imagery"]);
    await expect(queueThemeStudioCapture(actor, input)).rejects.toThrow(
      "Missing category imagery",
    );
    expect(writes).toEqual([]);
  });

  it("refuses a direct queue call before touching the database", async () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "false");

    await expect(
      queueThemeStudioCapture(
        { id: "11111111-1111-4111-8111-111111111111", email: "op@test.dev" },
        {
          projectId: "22222222-2222-4222-8222-222222222222",
          versionId: "33333333-3333-4333-8333-333333333333",
          expectedRevision: 1,
          expectedPackageDigest: "d".repeat(64),
          idempotencyKey: "capture-test-key-01",
        },
      ),
    ).rejects.toThrow(/browser worker is deployed/i);
    expect(withService).not.toHaveBeenCalled();
  });
});

/** One last-attempt capture whose every read answers `held`. */
function finishDb(held: Record<string, unknown>) {
  const writes: Record<string, unknown>[] = [];
  const db = {
    select: () => {
      const query = {
        from: () => query,
        where: () => query,
        limit: () => query,
        for: () => query,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve([held]).then(resolve),
      };
      return query;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        writes.push(values);
        return { where: () => updated() };
      },
    }),
    insert: () => ({ values: async () => [] }),
  };
  withService.mockImplementation(async (work) => work(db));
  return writes;
}

describe("why an automatic capture failed", () => {
  afterEach(() => vi.unstubAllEnvs());
  const lastAttempt = {
    id: input.versionId,
    projectId: input.projectId,
    versionId: input.versionId,
    automatic: true,
    attemptCount: 5,
    maxAttempts: 5,
  };

  it("fails an outdated capture job at once, without spending its remaining attempts", async () => {
    vi.stubEnv("THEME_STUDIO_BUILD_ID", "current-build");
    const writes = finishDb({ ...lastAttempt, attemptCount: 1 });
    expect(
      await finishThemeStudioCapture({
        captureId: input.versionId,
        leaseToken: actor.id,
        images: [],
        qa: { evidence: {}, screenshots: [] },
      }),
    ).toEqual({ status: "failed", errorCode: "capture_job_outdated" });
    expect(writes[0]).toMatchObject({
      status: "failed",
      errorCode: "capture_job_outdated",
    });
    expect(writes).not.toContainEqual(
      expect.objectContaining({ status: "queued" }),
    );
  });

  it.each([
    [undefined, "capture_job_outdated"],
    ["earlier-build", "capture_build_changed"],
  ])(
    "tells an outdated capture job (build %s) apart from a deploy: %s",
    async (buildId, code) => {
      vi.stubEnv("THEME_STUDIO_BUILD_ID", "current-build");
      const writes = finishDb(lastAttempt);
      expect(
        await finishThemeStudioCapture({
          captureId: input.versionId,
          leaseToken: actor.id,
          images: [],
          qa: { buildId, evidence: {}, screenshots: [] },
        }),
      ).toEqual({ status: "failed", errorCode: code });
      expect(writes[0]).toMatchObject({ status: "failed", errorCode: code });
    },
  );

  it.each([
    ["screenshots", { images: [], screenshots: [{ key: "390:home" }] }],
    ["catalog pictures", { images: [{ slot: "preview" }], screenshots: [] }],
  ])(
    "fails a job that answers a layout check with %s as outdated, not invalid evidence",
    async (_label, answer) => {
      vi.stubEnv("THEME_STUDIO_BUILD_ID", "current-build");
      const writes = finishDb({
        ...lastAttempt,
        attemptCount: 1,
        phase: "layout",
      });
      expect(
        await finishThemeStudioCapture({
          captureId: input.versionId,
          leaseToken: actor.id,
          images: answer.images as never,
          qa: {
            buildId: "current-build",
            evidence: {},
            screenshots: answer.screenshots as never,
          },
        }),
      ).toEqual({ status: "failed", errorCode: "capture_job_outdated" });
      expect(writes).not.toContainEqual(
        expect.objectContaining({ status: "queued" }),
      );
    },
  );

  it("reports a missing QA payload as invalid evidence, not a build change", async () => {
    vi.stubEnv("THEME_STUDIO_BUILD_ID", "current-build");
    finishDb({ ...lastAttempt, origin: "run", editDetail: {} });
    expect(
      await finishThemeStudioCapture({
        captureId: input.versionId,
        leaseToken: actor.id,
        images: [],
      }),
    ).toEqual({ status: "failed", errorCode: "qa_report_invalid" });
  });
});

describe("claiming a capture", () => {
  afterEach(() => vi.unstubAllEnvs());

  function claimDb({
    automatic = true,
    role = "superadmin",
    version = {},
  }: {
    automatic?: boolean;
    role?: string;
    version?: Record<string, unknown>;
  }) {
    const capture = {
      id: "44444444-4444-4444-8444-444444444444",
      projectId: input.projectId,
      versionId: input.versionId,
      packageDigest: input.expectedPackageDigest,
      automatic,
      attemptCount: 0,
      maxAttempts: 5,
      createdBy: actor.id,
    };
    const reads = [
      [],
      [capture],
      [
        {
          packageJson: {},
          packageDigest: input.expectedPackageDigest,
          origin: "run",
          visibility: "internal",
          qaStatus: "pending",
          editDetail: {},
          ...version,
        },
      ],
      [{ ...actor, role }],
    ];
    const writes: Record<string, unknown>[] = [];
    const db = {
      select: () => {
        const result = reads.shift();
        const query = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          for: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(result).then(resolve),
        };
        return query;
      },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          return { where: () => updated() };
        },
      }),
      insert: () => ({ values: async () => [] }),
    };
    withService.mockImplementation(async (work) => work(db));
    return writes;
  }

  it("refuses an automatic capture for a demoted owner before any browser work", async () => {
    const writes = claimDb({ role: "member" });
    expect(await claimThemeStudioCapture()).toBeNull();
    expect(openPreview).not.toHaveBeenCalled();
    expect(writes.at(-1)).toBeDefined();
    expect(
      writes.find((w) => w.errorCode === "operator_not_superadmin"),
    ).toBeDefined();
  });

  it("asks for no catalog shots when re-measuring a version a capture already produced", async () => {
    vi.stubEnv("CRON_SECRET", "x".repeat(40));
    openPreview.mockResolvedValueOnce({
      origin: "http://studio-preview-ab.localhost:3000",
      storeId: "55555555-5555-4555-8555-555555555555",
      pages: [{ surface: "home", path: "/", label: "Home" }],
    });
    claimDb({
      version: { origin: "asset_edit", editDetail: { kind: "capture" } },
    });
    const claim = await claimThemeStudioCapture();
    expect(claim?.shots).toEqual([]);
    expect(claim?.qa?.pages).toEqual([{ surface: "home", path: "/" }]);
  });
});

// ── Re-checks: the capture half of the re-check contract ────────────────

const passedVersion = {
  packageJson: {},
  packageDigest: input.expectedPackageDigest,
  origin: "asset_edit",
  visibility: "operator",
  qaStatus: "passed",
  editDetail: { kind: "capture" },
};

/** Reads answer in order: the project, then whether a capture, a design
 * review or a run is active, then (approved only) a publication in progress,
 * then the version. */
function recheckDb({
  status = "candidate",
  revision = 4,
  currentVersionId = input.versionId,
  active = null,
  publishing = false,
  version = passedVersion,
}: {
  status?: string;
  revision?: number;
  currentVersionId?: string | null;
  active?: "capture" | "review" | "run" | null;
  publishing?: boolean;
  version?: Record<string, unknown> | null;
} = {}) {
  const results: unknown[][] = [
    [{ id: input.projectId, status, revision, currentVersionId }],
    active === "capture" ? [{ id: "c" }] : [],
    ...(active === "capture" ? [] : [active === "review" ? [{ id: "q" }] : []]),
    ...(active === "capture" || active === "review"
      ? []
      : [active === "run" ? [{ id: "r" }] : []]),
    ...(active
      ? []
      : status === "approved"
        ? [publishing ? [{ id: "p" }] : []]
        : []),
    ...(active || (status === "approved" && publishing)
      ? []
      : [version ? [version] : []]),
  ];
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    select: () => {
      const query = {
        from: () => query,
        where: () => query,
        for: () => query,
        limit: async () => results.shift(),
      };
      return query;
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { returning: async () => [{ id: "recheck-capture" }] };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { where: () => updated() };
      },
    }),
  };
  withService.mockImplementation(async (work) => work(db));
  return writes;
}

describe("queueThemeStudioRecheck", () => {
  afterEach(() => vi.unstubAllEnvs());
  const recheck = {
    projectId: input.projectId,
    versionId: input.versionId,
    expectedRevision: 4,
    reason: "publish_recheck" as const,
  };
  const on = () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
    vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", "true");
  };

  it.each(["candidate", "ready", "approved"])(
    "★ moves a %s theme to generating and queues one automatic final capture at the repair ceiling",
    async (status) => {
      on();
      const writes = recheckDb({ status });
      expect(await queueThemeStudioRecheck(actor, recheck)).toEqual({
        captureId: "recheck-capture",
        inPlace: true,
      });
      const capture = writes.find(
        (write) => write.table === themeStudioCaptures,
      )!.values;
      // The live capture CHECK: an automatic capture says "generating".
      expect(capture).toMatchObject({
        projectId: input.projectId,
        versionId: input.versionId,
        packageDigest: input.expectedPackageDigest,
        phase: "final",
        previousStatus: "generating",
        automatic: true,
        qaIteration: 3,
        maxAttempts: 5,
        createdBy: actor.id,
      });
      const key = capture.idempotencyKey as string;
      expect(recheckReasonOf(key)).toBe("publish_recheck");
      expect(key.length).toBeLessThanOrEqual(80);
      expect(
        writes.find((write) => write.table === themeStudioProjects)?.values,
      ).toEqual({ status: "generating", revision: 5 });
      expect(
        writes.find((write) => write.table === themeStudioEvents)?.values,
      ).toMatchObject({
        eventType: "capture_requested",
        detail: {
          captureId: "recheck-capture",
          versionId: input.versionId,
          recheck: "publish_recheck",
          inPlace: true,
          qaIteration: 3,
        },
      });
    },
  );

  it("takes a fresh key for every re-check, so none replays an earlier one", async () => {
    on();
    const first = recheckDb();
    await queueThemeStudioRecheck(actor, { ...recheck, reason: "check_again" });
    const second = recheckDb();
    await queueThemeStudioRecheck(actor, { ...recheck, reason: "check_again" });
    const key = (writes: typeof first) =>
      writes.find((write) => write.table === themeStudioCaptures)!.values
        .idempotencyKey;
    expect(key(first)).not.toBe(key(second));
    expect(recheckReasonOf(key(first) as string)).toBe("check_again");
  });

  it("re-checks a version that never passed through a new hidden version", async () => {
    on();
    recheckDb({ version: { ...passedVersion, qaStatus: "failed" } });
    expect(await queueThemeStudioRecheck(actor, recheck)).toMatchObject({
      inPlace: false,
    });
  });

  it.each([
    [{ revision: 5 }, "stale"],
    [{ status: "generating" }, "illegal_state"],
    [{ status: "published" }, "illegal_state"],
    [{ status: "blocked" }, "illegal_state"],
    [{ currentVersionId: "another-version" }, "illegal_state"],
    [{ active: "capture" as const }, "illegal_state"],
    [{ active: "review" as const }, "illegal_state"],
    [{ active: "run" as const }, "illegal_state"],
    [{ status: "approved", publishing: true }, "illegal_state"],
    [{ version: null }, "not_found"],
  ])("refuses %j without writing anything", async (state, code) => {
    on();
    const writes = recheckDb(state);
    await expect(queueThemeStudioRecheck(actor, recheck)).rejects.toMatchObject(
      { code },
    );
    expect(writes).toEqual([]);
  });

  it("refuses a version whose art is unfinished, with the reason", async () => {
    on();
    const writes = recheckDb();
    vi.mocked(captureBlockers).mockReturnValueOnce([
      "2 images are still a placeholder.",
    ]);
    await expect(queueThemeStudioRecheck(actor, recheck)).rejects.toThrow(
      "2 images are still a placeholder.",
    );
    expect(writes).toEqual([]);
  });

  it.each([
    ["true", "false"],
    ["false", "true"],
  ])(
    "refuses before touching the database when capture is %s and automatic checks %s",
    async (capture, auto) => {
      vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", capture);
      vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", auto);
      await expect(
        queueThemeStudioRecheck(actor, recheck),
      ).rejects.toMatchObject({ code: "generation_disabled" });
      expect(withService).not.toHaveBeenCalled();
    },
  );

  it.each([
    { reason: "deploy" },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { projectId: "not-a-uuid" },
  ])("refuses a malformed request %j", async (bad) => {
    on();
    await expect(
      queueThemeStudioRecheck(actor, { ...recheck, ...bad } as never),
    ).rejects.toThrow();
    expect(withService).not.toHaveBeenCalled();
  });
});

describe("which captures re-measure in place", () => {
  afterEach(() => vi.unstubAllEnvs());
  const uuid = "0f6b4c1e-8f3a-4d2b-9c7e-1a2b3c4d5e6f";

  function claimFor(idempotencyKey: string, version: Record<string, unknown>) {
    const capture = {
      id: "44444444-4444-4444-8444-444444444444",
      projectId: input.projectId,
      versionId: input.versionId,
      packageDigest: input.expectedPackageDigest,
      automatic: true,
      phase: "final",
      idempotencyKey,
      attemptCount: 0,
      maxAttempts: 5,
      createdBy: actor.id,
    };
    const reads = [
      [],
      [capture],
      [{ ...version, packageDigest: input.expectedPackageDigest }],
      [{ ...actor, role: "superadmin" }],
    ];
    const db = {
      select: () => {
        const result = reads.shift();
        const query = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          for: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(result).then(resolve),
        };
        return query;
      },
      update: () => ({ set: () => ({ where: () => updated() }) }),
      insert: () => ({ values: async () => [] }),
    };
    withService.mockImplementation(async (work) => work(db));
    vi.stubEnv("CRON_SECRET", "x".repeat(40));
    openPreview.mockResolvedValueOnce({
      origin: "http://studio-preview-ab.localhost:3000",
      storeId: "55555555-5555-4555-8555-555555555555",
      pages: [{ surface: "home", path: "/", label: "Home" }],
    });
    return claimThemeStudioCapture();
  }

  it.each([
    [`recheck_publish_recheck_${uuid}`, "passed", true],
    [`recheck_check_again_${uuid}`, "passed", true],
    [`auto_recapture_${uuid}`, "passed", true],
    // Never passed: a new hidden version with fresh catalogue pictures.
    [`recheck_check_again_${uuid}`, "failed", false],
    [`auto_recapture_${uuid}`, "failed", false],
    // Retry automatic QA always takes the new-hidden-version path.
    ["retry-key-0123456789", "failed", false],
    ["retry-key-0123456789", "passed", false],
  ])(
    "★ %s of a visible %s version: in place %s",
    async (key, qaStatus, inPlace) => {
      // A real package: catalogue shots are computed from it.
      const actual =
        await vi.importActual<typeof import("./contracts")>("./contracts");
      const contracts = await import("./contracts");
      vi.mocked(contracts.validateThemePackageV2).mockImplementation(
        actual.validateThemePackageV2,
      );
      const { operatorImagePackage } = await import("./_test-helpers");
      const pkg = operatorImagePackage();
      vi.mocked(contracts.validateThemePackageV2).mockReturnValue({
        ok: true,
        value: pkg,
      } as never);
      const claim = await claimFor(key, {
        packageJson: {},
        origin: "asset_edit",
        visibility: "operator",
        qaStatus,
        editDetail: { kind: "capture" },
      });
      // In place: no catalogue shots. Otherwise every catalogue slot is shot
      // again for the new hidden version.
      expect(claim?.shots).toHaveLength(inPlace ? 0 : captureShots(pkg).length);
      expect(captureShots(pkg).length).toBeGreaterThan(0);
      expect(claim?.qa?.phase).toBe("final");
    },
  );
});

describe("captures nobody takes", () => {
  it("★ fails each capture queued or lapsed for 15 minutes as capture_not_started, and logs it", async () => {
    const stale = {
      id: "66666666-6666-4666-8666-666666666666",
      projectId: input.projectId,
      versionId: input.versionId,
      automatic: true,
      status: "queued",
      phase: "final",
      attemptCount: 0,
      updatedAt: "2026-09-29 09:32:27+05:30",
      leaseExpiresAt: null,
    };
    let where: unknown = null;
    const writes: { table: unknown; values: Record<string, unknown> }[] = [];
    const db = {
      select: () => {
        const query = {
          from: () => query,
          where: (cond: unknown) => {
            where = cond;
            return query;
          },
          orderBy: () => query,
          for: () => query,
          limit: async () => [stale],
        };
        return query;
      },
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          writes.push({ table, values });
          return { where: () => updated() };
        },
      }),
      insert: (table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          writes.push({ table, values });
        },
      }),
    };
    withService.mockImplementation(async (work) => work(db));
    expect(await sweepStaleThemeStudioCaptures()).toEqual({ failed: 1 });
    const { sql } = new PgDialect().sqlToQuery(where as SQL);
    expect(sql).toMatch(/"status" = 'queued'/);
    expect(sql).toMatch(
      /"updated_at" <= now\(\) - \(\$1::int \* interval '1 minute'\)/,
    );
    expect(sql).toMatch(/"status" = 'running'/);
    expect(sql).toMatch(/"lease_expires_at" <= now\(\) - \(\$2::int/);
    expect(
      writes.find((write) => write.table === themeStudioCaptures)?.values,
    ).toMatchObject({ status: "failed", errorCode: "capture_not_started" });
    // An automatic capture gives its theme back: generating -> ready.
    expect(
      writes.find((write) => write.table === themeStudioProjects)?.values,
    ).toMatchObject({ status: "ready", currentVersionId: input.versionId });
    expect(
      writes.find((write) => write.table === themeStudioEvents)?.values,
    ).toMatchObject({
      eventType: "capture_failed",
      detail: { captureId: stale.id, errorCode: "capture_not_started" },
    });
    expect(logWarn).toHaveBeenCalledWith(
      "theme_studio.capture_stale",
      expect.objectContaining({
        captureId: stale.id,
        projectId: input.projectId,
        status: "queued",
      }),
    );
  });

  it("never throws into the request it rides on", async () => {
    withService.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await sweepStaleThemeStudioCaptures()).toEqual({ failed: 0 });
  });
});

describe("words an operator reads", () => {
  it("never carry a long dash: capture errors and blockers reach the screen", async () => {
    const fs = await import("node:fs/promises");
    for (const file of ["./capture.ts", "./capture-core.ts"]) {
      const source = await fs.readFile(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/[–—]/);
    }
  });
});

// ── TS-3A ────────────────────────────────────────────────────────────────

/** A capture whose try just reported an error. Selects of a capture answer
 * the held row; selects of events answer the try before it (as the
 * database's own filter on `attempt` would); the project update answers
 * whether the theme stopped. */
function erroredDb({
  attemptCount = 1,
  previous = null,
  moved = true,
}: {
  attemptCount?: number;
  previous?: string | null;
  moved?: boolean;
} = {}) {
  const held = {
    id: input.versionId,
    projectId: input.projectId,
    versionId: input.versionId,
    phase: "final",
    automatic: true,
    attemptCount,
    maxAttempts: 5,
  };
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    select: () => {
      let table: unknown;
      const query = {
        from: (t: unknown) => {
          table = t;
          return query;
        },
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        for: () => query,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(
            table === themeStudioEvents
              ? previous
                ? [
                    {
                      detail: {
                        captureId: held.id,
                        attempt: attemptCount - 1,
                        retryAfter: previous,
                      },
                    },
                  ]
                : []
              : [held],
          ).then(resolve),
      };
      return query;
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { where: () => updated(moved ? [{ id: "moved" }] : []) };
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push({ table, values });
      },
    }),
  };
  withService.mockImplementation(async (work) => work(db));
  return { writes, inserts };
}

const report = (error: string, errorSurface?: string) =>
  finishThemeStudioCapture({
    captureId: input.versionId,
    leaseToken: actor.id,
    error,
    ...(errorSurface ? { errorSurface } : {}),
  });

describe("★ a capture error a retry cannot fix fails at once (owner, 24 Oct 2026)", () => {
  it("a deterministic error fails on its first report, with four tries left", async () => {
    const { writes } = erroredDb();
    expect(await report("qa_screenshot_too_large")).toEqual({
      status: "failed",
      errorCode: "qa_screenshot_too_large",
    });
    expect(
      writes.find((w) => w.table === themeStudioCaptures)?.values,
    ).toMatchObject({ status: "failed", errorCode: "qa_screenshot_too_large" });
    expect(writes).not.toContainEqual(
      expect.objectContaining({
        values: expect.objectContaining({ status: "queued" }),
      }),
    );
    // One content-free line with the code and the try.
    expect(logWarn).toHaveBeenCalledWith(
      "theme_studio.capture_attempt_failed",
      {
        captureId: input.versionId,
        phase: "final",
        automatic: true,
        errorCode: "qa_screenshot_too_large",
        errorKind: "deterministic",
        attempt: 1,
        maxAttempts: 5,
        outcome: "failed",
      },
    );
    // The theme stopped: its operator hears it needs them, after the commit.
    expect(notify).toHaveBeenCalledWith({
      projectId: input.projectId,
      kind: "needs_fix",
    });
  });

  it("★ one of our own pages answering 404 is tried again (a short database outage answers 404 too), and fails when the next try reports it again", async () => {
    erroredDb();
    expect(await report("preview_status_404", "home")).toEqual({
      status: "requeued",
    });
    // The page it came from rides on the failed try's line, content-free.
    expect(logWarn).toHaveBeenCalledWith(
      "theme_studio.capture_attempt_failed",
      expect.objectContaining({
        errorCode: "preview_status_404",
        errorKind: "other",
        surface: "home",
        outcome: "requeued",
      }),
    );
    erroredDb({ attemptCount: 2, previous: "preview_status_404" });
    expect(await report("preview_status_404", "home")).toMatchObject({
      status: "failed",
      errorCode: "preview_status_404",
    });
    erroredDb();
    expect(await report("preview_status_200", "not_found")).toEqual({
      status: "requeued",
    });
  });

  it("a transient error still retries, even when it repeats", async () => {
    const { writes, inserts } = erroredDb({
      attemptCount: 2,
      previous: "capture_timeout",
    });
    expect(await report("capture_timeout")).toEqual({ status: "requeued" });
    expect(writes.find((w) => w.table === themeStudioCaptures)?.values).toEqual(
      { status: "queued", leaseOwner: null, leaseExpiresAt: null },
    );
    // The next try is judged against this one's code.
    expect(inserts).toContainEqual({
      table: themeStudioEvents,
      values: expect.objectContaining({
        eventType: "capture_requested",
        actorKind: "worker",
        detail: {
          captureId: input.versionId,
          versionId: input.versionId,
          attempt: 2,
          retryAfter: "capture_timeout",
        },
      }),
    });
    expect(logWarn).toHaveBeenCalledWith(
      "theme_studio.capture_attempt_failed",
      expect.objectContaining({
        errorKind: "transient",
        attempt: 2,
        outcome: "requeued",
      }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("a non-transient error seen twice in a row fails on the second", async () => {
    erroredDb({ attemptCount: 1 });
    expect(await report("capture_browser_error")).toEqual({
      status: "requeued",
    });
    erroredDb({ attemptCount: 2, previous: "capture_browser_error" });
    expect(await report("capture_browser_error")).toEqual({
      status: "failed",
      errorCode: "capture_browser_error",
    });
  });

  it("a non-transient error after a different one is tried again", async () => {
    erroredDb({ attemptCount: 2, previous: "capture_timeout" });
    expect(await report("capture_browser_error")).toEqual({
      status: "requeued",
    });
  });

  it("tells nobody when the theme had already moved on", async () => {
    erroredDb({ moved: false });
    await report("qa_screenshot_too_large");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("★ the capture job starts right after a capture is queued (TS-3A)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const on = () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
    vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", "true");
  };

  it("an operator's capture starts the job once its transaction has committed", async () => {
    on();
    const order: string[] = [];
    queueDb();
    withService.mockImplementationOnce(async (work) => {
      const value = await (
        withService.getMockImplementation() as (w: unknown) => unknown
      )(work);
      order.push("committed");
      return value;
    });
    startNow.mockImplementationOnce(async () => {
      order.push("started");
      return "started";
    });
    await queueThemeStudioCapture(actor, input);
    expect(order).toEqual(["committed", "started"]);
    expect(startAfterCommit).not.toHaveBeenCalled();
  });

  it("a replayed request starts nothing", async () => {
    on();
    queueDb({
      revision: 2,
      prior: { id: "prior", projectId: input.projectId },
    });
    await queueThemeStudioCapture(actor, input);
    expect(startNow).not.toHaveBeenCalled();
  });

  it("a re-check starts the job after its own commit; inside a caller's transaction it waits for that commit", async () => {
    on();
    const recheck = {
      projectId: input.projectId,
      versionId: input.versionId,
      expectedRevision: 4,
      reason: "check_again" as const,
    };
    recheckDb();
    await queueThemeStudioRecheck(actor, recheck);
    expect(startNow).toHaveBeenCalledOnce();
    expect(startAfterCommit).not.toHaveBeenCalled();
    recheckDb();
    const db = await new Promise<unknown>((resolve) =>
      withService.getMockImplementation()!(async (d: unknown) => resolve(d)),
    );
    const queued = await queueThemeStudioRecheckWithDb(
      db as never,
      actor,
      recheck,
    );
    expect(startAfterCommit).toHaveBeenCalledWith(queued.captureId);
    expect(startNow).toHaveBeenCalledOnce();
  });
});
