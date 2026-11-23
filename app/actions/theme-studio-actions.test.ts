import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeStudioProjectState } from "@/lib/theme-studio/contracts";

// ---------------------------------------------------------------------------
// The gate, not the plumbing. Every export of the actions module is a public
// POST endpoint, so each one must refuse a non-superadmin BEFORE any
// repository call: a forged request from a member or a signed-out browser
// must not read or mutate a Studio project.
// ---------------------------------------------------------------------------

const repo = vi.hoisted(() => ({
  deleteThemeStudioProject: vi.fn(async () => ({
    themeId: "clay-co",
    storesKept: 2,
  })),
  createThemeStudioProject: vi.fn(async () => ({ id: "p1" })),
  queueThemeStudioGeneration: vi.fn(async () => ({
    runId: "r1",
    duplicate: false,
  })),
  cancelThemeStudioRun: vi.fn(async () => ({ status: "cancelled" })),
  retryThemeStudioRun: vi.fn(async () => ({ runId: "r2", duplicate: false })),
  submitThemeStudioDetails: vi.fn(async () => ({
    runId: "r3",
    duplicate: false,
  })),
  removeThemeStudioReference: vi.fn(async () => undefined),
  archiveThemeStudioProject: vi.fn(async () => undefined),
  // Phase 6 (lib/theme-studio/publication), mocked below.
  publishThemeStudioProject: vi.fn(async () => ({
    ok: true as const,
    publicationId: "pub1",
    themeId: "clay-co",
    releaseVersion: "1.0.0",
    demoSlug: "demo-clay-co",
  })),
  changeThemeStudioCatalog: vi.fn(async () => ({ changed: true })),
  restoreThemeStudioVersion: vi.fn(async () => ({
    changed: true,
    outcome: "rechecking" as const,
  })),
  // TS-1E (lib/theme-studio/stop.ts and capture.ts), mocked below.
  stopThemeStudioChecks: vi.fn(async () => ({
    status: "ready" as ThemeStudioProjectState,
    stopped: { captures: 1, reviews: 0, runs: 0, browserChecks: 0 },
    cancelling: false,
  })),
  queueThemeStudioRecheck: vi.fn(async () => ({
    captureId: "cap1",
    inPlace: true,
  })),
  queueThemeStudioCapture: vi.fn(async () => ({
    captureId: "cap0",
    duplicate: false,
  })),
  replaceThemeStudioSlotImages: vi.fn(async () => ({
    versionId: "v9",
    versionNumber: 9,
    checking: true,
  })),
}));
const actorState = vi.hoisted(() => ({
  actor: null as null | { id: string; email: string },
}));

vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => actorState.actor),
}));
vi.mock("@/lib/theme-studio/repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/theme-studio/repository")>();
  return { ...actual, ...repo };
});
vi.mock("@/lib/theme-studio/deletion", () => ({
  deleteThemeStudioProject: repo.deleteThemeStudioProject,
}));
vi.mock("@/lib/theme-studio/publication", () => ({
  publishThemeStudioProject: repo.publishThemeStudioProject,
  changeThemeStudioCatalog: repo.changeThemeStudioCatalog,
}));
vi.mock("@/lib/theme-studio/stop", () => ({
  stopThemeStudioChecks: repo.stopThemeStudioChecks,
}));
vi.mock("@/lib/theme-studio/capture", () => ({
  queueThemeStudioRecheck: repo.queueThemeStudioRecheck,
  queueThemeStudioCapture: repo.queueThemeStudioCapture,
}));
vi.mock("@/lib/theme-studio/slot-images", () => ({
  replaceThemeStudioSlotImages: repo.replaceThemeStudioSlotImages,
}));
vi.mock("@/lib/theme-studio/worker", () => ({
  runThemeStudioWorker: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

import * as actions from "./theme-studio-actions";
import { updateTag } from "next/cache";
import { after } from "next/server";

const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const superadmin = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "owner@storemink.com",
};

const calls: [
  string,
  () => Promise<{ ok: boolean; error?: string }>,
  keyof typeof repo,
][] = [
  [
    "create",
    () =>
      actions.createThemeStudioProjectAction({
        name: "Clay",
        themeId: "clay-co",
        brief: "calm",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        baseThemeId: null,
        modelKey: "gemini-3.8-flash",
      }),
    "createThemeStudioProject",
  ],
  [
    "queue",
    () =>
      actions.queueThemeStudioGenerationAction({
        projectId,
        expectedRevision: 0,
        idempotencyKey: "k".repeat(20),
      }),
    "queueThemeStudioGeneration",
  ],
  [
    "cancel",
    () => actions.cancelThemeStudioRunAction({ projectId, runId }),
    "cancelThemeStudioRun",
  ],
  [
    "retry",
    () =>
      actions.retryThemeStudioRunAction({
        projectId,
        runId,
        idempotencyKey: "k".repeat(20),
      }),
    "retryThemeStudioRun",
  ],
  [
    "submit details",
    () =>
      actions.submitThemeStudioDetailsAction({
        projectId,
        expectedRevision: 0,
        body: "Photography comes from the operator.",
        idempotencyKey: "k".repeat(20),
      }),
    "submitThemeStudioDetails",
  ],
  [
    "remove reference",
    () =>
      actions.removeThemeStudioReferenceAction({ projectId, assetId: runId }),
    "removeThemeStudioReference",
  ],
  [
    "delete",
    () =>
      actions.deleteThemeStudioProjectAction({
        projectId,
        expectedRevision: 0,
        confirmation: "clay-co",
      }),
    "deleteThemeStudioProject",
  ],
  [
    "archive",
    () =>
      actions.archiveThemeStudioProjectAction({
        projectId,
        expectedRevision: 0,
      }),
    "archiveThemeStudioProject",
  ],
  [
    "publish",
    () =>
      actions.publishThemeStudioProjectAction({
        projectId,
        expectedRevision: 0,
      }),
    "publishThemeStudioProject",
  ],
  [
    "change catalog",
    () =>
      actions.changeThemeStudioCatalogAction({
        projectId,
        change: { action: "hide" },
      }),
    "changeThemeStudioCatalog",
  ],
  [
    "make current",
    () =>
      actions.restoreThemeStudioVersionAction({
        projectId,
        versionId,
        expectedRevision: 0,
      }),
    "restoreThemeStudioVersion",
  ],
  [
    "stop",
    () =>
      actions.stopThemeStudioChecksAction({
        projectId,
        expectedRevision: 0,
      }),
    "stopThemeStudioChecks",
  ],
  [
    "check again",
    () =>
      actions.recheckThemeStudioVersionAction({
        projectId,
        versionId,
        expectedRevision: 0,
      }),
    "queueThemeStudioRecheck",
  ],
  [
    "capture",
    () =>
      actions.queueThemeStudioCaptureAction({
        projectId,
        versionId,
        expectedRevision: 0,
        expectedPackageDigest: "d".repeat(64),
        idempotencyKey: "k".repeat(20),
      }),
    "queueThemeStudioCapture",
  ],
  [
    "save pictures",
    () =>
      actions.replaceThemeStudioSlotImagesAction({
        projectId,
        versionId,
        expectedRevision: 0,
        expectedPackageDigest: "d".repeat(64),
        replacements: [],
      }),
    "replaceThemeStudioSlotImages",
  ],
];

describe("Theme Studio actions", () => {
  beforeEach(() => {
    actorState.actor = null;
  });

  it.each(calls)(
    "%s refuses a non-superadmin before touching data",
    async (_name, call, fn) => {
      const result = await call();
      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(/superadmin/),
      });
      expect(repo[fn]).not.toHaveBeenCalled();
    },
  );

  it.each(calls)(
    "%s passes the session actor, never a client-supplied one",
    async (_name, call, fn) => {
      actorState.actor = {
        id: "11111111-1111-4111-8111-111111111111",
        email: "owner@storemink.com",
      };
      const result = await call();
      expect(result.ok).toBe(true);
      const mock = repo[fn] as unknown as { mock: { calls: unknown[][] } };
      expect(mock.mock.calls[0][0]).toEqual(actorState.actor);
    },
  );

  it("returns a repository refusal as a sentence, not a crash", async () => {
    actorState.actor = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@storemink.com",
    };
    const { ThemeStudioError } = await import("@/lib/theme-studio/repository");
    repo.queueThemeStudioGeneration.mockRejectedValueOnce(
      new ThemeStudioError("stale", "This project changed in another tab."),
    );
    await expect(
      actions.queueThemeStudioGenerationAction({
        projectId,
        expectedRevision: 0,
        idempotencyKey: "k".repeat(20),
      }),
    ).resolves.toEqual({
      ok: false,
      error: "This project changed in another tab.",
    });
  });

  it("returns a failed publication's reasons without calling it a crash", async () => {
    actorState.actor = superadmin;
    repo.publishThemeStudioProject.mockResolvedValueOnce({
      ok: false,
      kind: "failed",
      publicationId: "pub2",
      problems: ["Demo: /shop answered 500."],
    } as never);
    await expect(
      actions.publishThemeStudioProjectAction({
        projectId,
        expectedRevision: 0,
      }),
    ).resolves.toEqual({
      ok: false,
      kind: "failed",
      id: "pub2",
      error: "Demo: /shop answered 500.",
      problems: ["Demo: /shop answered 500."],
    });
  });

  it("answers a re-check before Publish as news, not an error", async () => {
    actorState.actor = superadmin;
    const sentence =
      "StoreMink was updated since this design was checked, so it is being checked again on today's build first.";
    repo.publishThemeStudioProject.mockResolvedValueOnce({
      ok: false,
      kind: "rechecking",
      problems: [sentence],
      captureId: "cap7",
      inPlace: true,
      reason: "old_build",
    } as never);
    const result = await actions.publishThemeStudioProjectAction({
      projectId,
      expectedRevision: 4,
    });
    expect(result).toEqual({
      ok: true,
      kind: "rechecking",
      id: "cap7",
      message: sentence,
      inPlace: true,
    });
    expect(result.error).toBeUndefined();
  });

  it("marks a publish that went live", async () => {
    actorState.actor = superadmin;
    await expect(
      actions.publishThemeStudioProjectAction({
        projectId,
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({
      ok: true,
      id: "pub1",
      releaseVersion: "1.0.0",
      demoSlug: "demo-clay-co",
    });
  });

  it("only ever asks for Check again: the reason is the server's, never the browser's", async () => {
    actorState.actor = superadmin;
    const result = await actions.recheckThemeStudioVersionAction({
      projectId,
      versionId,
      expectedRevision: 6,
      reason: "publish_recheck",
    } as never);
    expect(result).toEqual({ ok: true, id: "cap1", inPlace: true });
    expect(repo.queueThemeStudioRecheck).toHaveBeenCalledWith(superadmin, {
      projectId,
      versionId,
      expectedRevision: 6,
      reason: "check_again",
    });
  });

  it("stops and says whether a build step is still finishing its stop", async () => {
    actorState.actor = superadmin;
    repo.stopThemeStudioChecks.mockResolvedValueOnce({
      status: "generating",
      stopped: { captures: 0, reviews: 0, runs: 1, browserChecks: 0 },
      cancelling: true,
    });
    await expect(
      actions.stopThemeStudioChecksAction({ projectId, expectedRevision: 9 }),
    ).resolves.toEqual({ ok: true, status: "generating", cancelling: true });
    expect(repo.stopThemeStudioChecks).toHaveBeenCalledWith(superadmin, {
      projectId,
      expectedRevision: 9,
    });
  });

  it("refuses a malformed revision before Stop or Check again touch anything", async () => {
    actorState.actor = superadmin;
    for (const call of [
      () =>
        actions.stopThemeStudioChecksAction({
          projectId,
          expectedRevision: "1" as never,
        }),
      () =>
        actions.recheckThemeStudioVersionAction({
          projectId,
          versionId,
          expectedRevision: 1.5,
        }),
    ]) {
      await expect(call()).resolves.toEqual({
        ok: false,
        error: "The request is malformed. Reload and try again.",
      });
    }
    expect(repo.stopThemeStudioChecks).not.toHaveBeenCalled();
    expect(repo.queueThemeStudioRecheck).not.toHaveBeenCalled();
  });

  it("returns Stop's and Check again's refusals as sentences", async () => {
    actorState.actor = superadmin;
    const { ThemeStudioError } = await import("@/lib/theme-studio/repository");
    repo.stopThemeStudioChecks.mockRejectedValueOnce(
      new ThemeStudioError(
        "illegal_state",
        "Nothing is running on this theme. Reload to see where it is.",
      ),
    );
    await expect(
      actions.stopThemeStudioChecksAction({ projectId, expectedRevision: 1 }),
    ).resolves.toEqual({
      ok: false,
      error: "Nothing is running on this theme. Reload to see where it is.",
    });
    repo.queueThemeStudioRecheck.mockRejectedValueOnce(
      new ThemeStudioError(
        "generation_disabled",
        "Checking a theme again needs the automatic checks, and they are switched off here.",
      ),
    );
    await expect(
      actions.recheckThemeStudioVersionAction({
        projectId,
        versionId,
        expectedRevision: 1,
      }),
    ).resolves.toEqual({
      ok: false,
      error:
        "Checking a theme again needs the automatic checks, and they are switched off here.",
    });
  });

  it("passes Make current's outcome and a checked picture save through", async () => {
    actorState.actor = superadmin;
    await expect(
      actions.restoreThemeStudioVersionAction({
        projectId,
        versionId,
        expectedRevision: 2,
      }),
    ).resolves.toEqual({ ok: true, changed: true, outcome: "rechecking" });
    await expect(
      actions.replaceThemeStudioSlotImagesAction({
        projectId,
        versionId,
        expectedRevision: 2,
        expectedPackageDigest: "d".repeat(64),
        replacements: [],
      }),
    ).resolves.toEqual({
      ok: true,
      id: "v9",
      versionNumber: 9,
      checking: true,
    });
  });
});

describe("the after-response worker pass", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs only with the offline provider", async () => {
    actorState.actor = superadmin;
    vi.stubEnv("THEME_STUDIO_PROVIDER", "vertex-gemini");
    const queue = () =>
      actions.queueThemeStudioGenerationAction({
        projectId,
        expectedRevision: 0,
        idempotencyKey: "k".repeat(20),
      });
    await expect(queue()).resolves.toMatchObject({ ok: true });
    expect(after).not.toHaveBeenCalled();
    vi.stubEnv("THEME_STUDIO_PROVIDER", "fake");
    await expect(queue()).resolves.toMatchObject({ ok: true });
    expect(after).toHaveBeenCalledTimes(1);
  });
});

it("does not report a committed deletion as unchanged when cache invalidation fails", async () => {
  actorState.actor = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "owner@storemink.com",
  };
  vi.mocked(updateTag).mockImplementationOnce(() => {
    throw new Error("cache unavailable");
  });
  const result = await actions.deleteThemeStudioProjectAction({
    projectId,
    expectedRevision: 0,
    confirmation: "clay-co",
  });
  // ★ And says how many stores keep the deleted theme.
  expect(result).toEqual({ ok: true, storesKept: 2 });
});
