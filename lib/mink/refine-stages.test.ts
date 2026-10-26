import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ★★ Refine stages (lib/mink/refine-stages.ts): a refined photo is staged in
// the PRIVATE bucket, charged, then published; a paid photo whose publish
// failed is published by the per-minute sweep, and an unpaid stage is
// deleted. ★ Each database sweeps only its own prefix, because one private
// bucket serves several databases.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  configured: true,
  privateConfigured: true,
  listed: [] as { name: string; createdAt: number | null }[],
  listCalls: [] as { kind: string; prefix: string; max: number }[],
  uploads: [] as { path: string; bytes: Uint8Array; type: string }[],
  uploadFailures: 0,
  downloads: [] as { path: string; max: number; kind: string }[],
  deletes: [] as { paths: string[]; kind: string }[],
  deleteLeft: [] as string[],
  /** Whether the Media Library still holds the refined photo. */
  inLibrary: true,
  libraryQueries: [] as string[],
  /** Every storage and database call, in order. */
  events: [] as string[],
}));

vi.mock("@/lib/storage/gcs", () => ({
  get gcsConfigured() {
    return state.configured;
  },
  get gcsPrivateConfigured() {
    return state.privateConfigured;
  },
  gcsListObjects: vi.fn(async (kind: string, prefix: string, max: number) => {
    state.listCalls.push({ kind, prefix, max });
    state.events.push("list");
    return state.listed;
  }),
  gcsUploadObject: vi.fn(
    async (path: string, bytes: Uint8Array, type: string) => {
      state.events.push("upload");
      if (state.uploadFailures > 0) {
        state.uploadFailures -= 1;
        throw new Error("upload failed");
      }
      state.uploads.push({ path, bytes, type });
      return `https://storage.googleapis.com/bucket/${path}`;
    },
  ),
  gcsDownloadObject: vi.fn(async (path: string, max: number, kind: string) => {
    state.downloads.push({ path, max, kind });
    state.events.push("download");
    return new Uint8Array([1, 2, 3]);
  }),
  gcsDeletePaths: vi.fn(async (paths: string[], kind: string) => {
    state.deletes.push({ paths, kind });
    state.events.push("delete");
    return state.deleteLeft;
  }),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(
    async (
      operation: (db: {
        execute: (query: unknown) => Promise<{ rows: unknown[] }>;
      }) => unknown,
    ) =>
      operation({
        execute: async (query: unknown) => {
          state.libraryQueries.push(JSON.stringify(query));
          state.events.push("library");
          return { rows: state.inLibrary ? [{ kept: 1 }] : [] };
        },
      }),
  ),
}));
vi.mock("./refine-stop", () => ({
  abandonRefineStage: vi.fn(async () => "discard"),
}));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { gcsListObjects, gcsUploadObject } from "@/lib/storage/gcs";
import { abandonRefineStage } from "./refine-stop";
import {
  REFINE_STAGE_SWEEP_AGE_MS,
  REFINE_STAGE_SWEEP_BUDGET_MS,
  REFINE_STAGE_SWEEP_LIMIT,
  publishRefinedCopy,
  refinePublicPath,
  refineStageDatabase,
  refineStagePath,
  refineStagePrefix,
  sweepRefineStages,
} from "./refine-stages";

const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REFINE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = Date.parse("2026-10-26T08:00:00Z");
const OLD = NOW - REFINE_STAGE_SWEEP_AGE_MS - 1_000;

const refineId = (n: number) =>
  `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
const stage = (refinementId = REFINE, createdAt: number | null = OLD) => ({
  name: `refine-stage/storemink_local/${STORE}/${refinementId}.webp`,
  createdAt,
});

beforeEach(() => {
  vi.stubEnv("DB_NAME", "storemink_local");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.configured = true;
  state.privateConfigured = true;
  state.listed = [];
  state.listCalls = [];
  state.uploads = [];
  state.uploadFailures = 0;
  state.downloads = [];
  state.deletes = [];
  state.deleteLeft = [];
  state.inLibrary = true;
  state.libraryQueries = [];
  state.events = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("★★ paths: stages are filed by database", () => {
  it("files a stage under refine-stage/{DB_NAME}/, and the public copy under the store's refined/", () => {
    expect(refineStagePath(STORE, REFINE)).toBe(
      `refine-stage/storemink_local/${STORE}/${REFINE}.webp`,
    );
    expect(refinePublicPath(STORE, REFINE)).toBe(
      `stores/${STORE}/refined/${REFINE}.webp`,
    );
    vi.stubEnv("DB_NAME", "storemink_staging");
    expect(refineStagePrefix()).toBe("refine-stage/storemink_staging/");
  });

  it("★ an unset or malformed DB_NAME files under refine-stage/default/", () => {
    for (const name of ["", "a/b", "../x", "db name", "x".repeat(64)]) {
      vi.stubEnv("DB_NAME", name);
      expect(refineStageDatabase()).toBe("default");
      expect(refineStagePath(STORE, REFINE)).toBe(
        `refine-stage/default/${STORE}/${REFINE}.webp`,
      );
    }
    delete process.env.DB_NAME;
    expect(refineStagePrefix()).toBe("refine-stage/default/");
  });
});

describe("★★ publishRefinedCopy: three tries, never a throw", () => {
  it("publishes the bytes as WebP on the first try", async () => {
    const bytes = new Uint8Array([9]);
    await expect(
      publishRefinedCopy(`stores/${STORE}/refined/${REFINE}.webp`, bytes),
    ).resolves.toBe(true);
    expect(state.uploads).toEqual([
      {
        path: `stores/${STORE}/refined/${REFINE}.webp`,
        bytes,
        type: "image/webp",
      },
    ]);
  });

  it("★ retries after the given waits, true on a later success", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    state.uploadFailures = 2;
    const published = publishRefinedCopy("p.webp", new Uint8Array([1]), {
      waitsMs: [0, 300, 1_000],
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(state.uploads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.uploads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(published).resolves.toBe(true);
    expect(state.uploads).toHaveLength(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("★★ false after three failures, logged once with the path", async () => {
    state.uploadFailures = 3;
    await expect(
      publishRefinedCopy("p.webp", new Uint8Array([1]), { waitsMs: [0, 0, 0] }),
    ).resolves.toBe(false);
    expect(logError).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(
      "mink.image-refine: publish failed",
      expect.any(Error),
      { path: "p.webp" },
    );
  });
});

describe("★★ sweepRefineStages", () => {
  it("is a no-op without a private bucket (or any bucket)", async () => {
    state.privateConfigured = false;
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 0,
      failed: 0,
    });
    state.privateConfigured = true;
    state.configured = false;
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 0,
      failed: 0,
    });
    expect(state.listCalls).toEqual([]);
  });

  it("★★ lists exactly this database's prefix, with its trailing slash", async () => {
    await sweepRefineStages();
    expect(state.listCalls).toEqual([
      { kind: "private", prefix: "refine-stage/storemink_local/", max: 100 },
    ]);
  });

  it("★★ never decides another database's stage, even when listed", async () => {
    state.listed = [
      {
        name: `refine-stage/storemink_staging/${STORE}/${REFINE}.webp`,
        createdAt: OLD,
      },
      {
        name: `refine-stage/storemink_local_old/${STORE}/${REFINE}.webp`,
        createdAt: OLD,
      },
    ];
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 0,
      failed: 0,
    });
    expect(abandonRefineStage).not.toHaveBeenCalled();
    expect(state.deletes).toEqual([]);
    expect(state.uploads).toEqual([]);
  });

  it("★ skips a young stage, an undated one and a malformed name, deleting none (each warned once a pass)", async () => {
    state.listed = [
      stage(REFINE, NOW - 60_000),
      stage(refineId(2), null),
      stage(refineId(3), null),
      { name: "refine-stage/storemink_local/notes.txt", createdAt: OLD },
      { name: `refine-stage/storemink_local/${STORE}/x.webp`, createdAt: OLD },
    ];
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 0,
      failed: 0,
    });
    expect(abandonRefineStage).not.toHaveBeenCalled();
    expect(state.deletes).toEqual([]);
    // ★ An undated stage would never age, so it is said, not silently kept.
    expect(logWarn).toHaveBeenCalledTimes(2);
    expect(logWarn).toHaveBeenCalledWith(
      "mink.image-refine: unexpected stage name",
      { path: "refine-stage/storemink_local/notes.txt" },
    );
    expect(logWarn).toHaveBeenCalledWith(
      "mink.image-refine: stage without a creation time",
      { path: stage(refineId(2), null).name },
    );
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("★★ discard deletes the PRIVATE stage and publishes nothing", async () => {
    state.listed = [stage()];
    vi.mocked(abandonRefineStage).mockResolvedValueOnce("discard");
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 1,
      failed: 0,
    });
    expect(abandonRefineStage).toHaveBeenCalledWith(STORE, REFINE);
    expect(state.deletes).toEqual([{ paths: [stage().name], kind: "private" }]);
    expect(state.uploads).toEqual([]);
    expect(state.downloads).toEqual([]);
    expect(logInfo).toHaveBeenCalledWith("mink.image-refine: stages swept", {
      published: 0,
      deleted: 1,
      failed: 0,
    });
  });

  it("★★ publish downloads the PRIVATE stage, uploads it to the ledger path, then deletes the stage", async () => {
    state.listed = [stage()];
    const publicPath = `stores/${STORE}/refined/${REFINE}.webp`;
    vi.mocked(abandonRefineStage).mockResolvedValueOnce({
      publish: publicPath,
    });
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 1,
      deleted: 0,
      failed: 0,
    });
    expect(state.downloads).toEqual([
      { path: stage().name, max: 8 * 1024 * 1024, kind: "private" },
    ]);
    expect(state.uploads).toEqual([
      {
        path: publicPath,
        bytes: new Uint8Array([1, 2, 3]),
        type: "image/webp",
      },
    ]);
    expect(state.deletes).toEqual([{ paths: [stage().name], kind: "private" }]);
    // ★★ The Media Library is asked first, and the stage goes only once its
    //   photo is public.
    expect(state.events).toEqual([
      "list",
      "library",
      "download",
      "upload",
      "delete",
    ]);
    expect(state.libraryQueries).toHaveLength(1);
    expect(state.libraryQueries[0]).toContain("media_assets");
    expect(state.libraryQueries[0]).toContain(STORE);
    expect(state.libraryQueries[0]).toContain(publicPath);
  });

  it("★★ an upload that fails keeps the stage for the next pass: a paid photo is never lost", async () => {
    state.listed = [stage()];
    state.uploadFailures = 1;
    vi.mocked(abandonRefineStage).mockResolvedValueOnce({
      publish: refinePublicPath(STORE, REFINE),
    });
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 0,
      failed: 1,
    });
    expect(state.deletes).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "mink.image-refine: stage sweep failed",
      expect.any(Error),
      { path: stage().name },
    );
  });

  it("★★ a paid photo deleted from the Media Library since is not published again: its stage goes", async () => {
    state.listed = [stage()];
    state.inLibrary = false;
    vi.mocked(abandonRefineStage).mockResolvedValueOnce({
      publish: refinePublicPath(STORE, REFINE),
    });
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 1,
      failed: 0,
    });
    expect(state.downloads).toEqual([]);
    expect(state.uploads).toEqual([]);
    expect(state.deletes).toEqual([{ paths: [stage().name], kind: "private" }]);
  });

  it("a failed query is logged by its reason (its parameters stay out of the log)", async () => {
    state.listed = [stage()];
    vi.mocked(abandonRefineStage).mockRejectedValueOnce(
      Object.assign(
        new Error(`Failed query: update ...\nparams: ${STORE},${REFINE}`),
        { cause: new Error("canceling statement due to statement timeout") },
      ),
    );
    await sweepRefineStages();
    expect(logError).toHaveBeenCalledWith(
      "mink.image-refine: stage sweep failed",
      "canceling statement due to statement timeout",
      { path: stage().name },
    );
  });

  it("★ a ledger path that is not the expected one is skipped and logged", async () => {
    state.listed = [stage()];
    vi.mocked(abandonRefineStage).mockResolvedValueOnce({
      publish: `stores/${STORE}/refined/someone-else.webp`,
    });
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 0,
      failed: 1,
    });
    expect(state.uploads).toEqual([]);
    expect(state.deletes).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "mink.image-refine: stage ledger path unexpected",
      undefined,
      { path: stage().name },
    );
  });

  it("★ one stage's error is counted, its stage kept, and the next still decided", async () => {
    state.listed = [stage(refineId(1)), stage(refineId(2))];
    vi.mocked(abandonRefineStage)
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockResolvedValueOnce("discard");
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 1,
      failed: 1,
    });
    expect(state.deletes).toEqual([
      { paths: [stage(refineId(2)).name], kind: "private" },
    ]);
    expect(logError).toHaveBeenCalledWith(
      "mink.image-refine: stage sweep failed",
      expect.any(Error),
      { path: stage(refineId(1)).name },
    );
  });

  it("a delete that fails is counted as failed (gcs.ts has logged it)", async () => {
    state.listed = [stage()];
    state.deleteLeft = [stage().name];
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 0,
      failed: 1,
    });
  });

  it("★ decides at most REFINE_STAGE_SWEEP_LIMIT stages a pass", async () => {
    state.listed = Array.from({ length: 25 }, (_, n) => stage(refineId(n)));
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: REFINE_STAGE_SWEEP_LIMIT,
      failed: 0,
    });
    expect(abandonRefineStage).toHaveBeenCalledTimes(REFINE_STAGE_SWEEP_LIMIT);
  });

  it("★ stops once its ten-second budget is spent; a stage it ran out of time for is kept", async () => {
    state.listed = Array.from({ length: 5 }, (_, n) => stage(refineId(n)));
    vi.mocked(abandonRefineStage).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 6_000);
      return "discard";
    });
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 1,
      failed: 1,
    });
    expect(abandonRefineStage).toHaveBeenCalledTimes(2);
    // The second's delete would have started after the budget: not sent.
    expect(state.deletes).toEqual([
      { paths: [stage(refineId(0)).name], kind: "private" },
    ]);
  });

  it("★★ the listing's time counts against the budget", async () => {
    state.listed = [stage()];
    vi.mocked(gcsListObjects).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + REFINE_STAGE_SWEEP_BUDGET_MS);
      return state.listed;
    });
    await expect(sweepRefineStages()).resolves.toEqual({
      published: 0,
      deleted: 0,
      failed: 0,
    });
    expect(abandonRefineStage).not.toHaveBeenCalled();
  });

  it("★★ a storage call that hangs ends the pass at its budget, and its stage is kept", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    state.listed = [stage(refineId(1)), stage(refineId(2))];
    vi.mocked(abandonRefineStage).mockImplementation(
      async (storeId, refinementId) => ({
        publish: refinePublicPath(storeId, refinementId),
      }),
    );
    // An upload has no timeout of its own: this one never answers.
    vi.mocked(gcsUploadObject).mockImplementationOnce(
      () => new Promise<string>(() => {}),
    );
    let swept: unknown = null;
    void sweepRefineStages().then((counts) => {
      swept = counts;
    });
    await vi.advanceTimersByTimeAsync(REFINE_STAGE_SWEEP_BUDGET_MS - 1);
    expect(swept).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(swept).toEqual({ published: 0, deleted: 0, failed: 1 });
    expect(abandonRefineStage).toHaveBeenCalledTimes(1);
    expect(state.deletes).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "mink.image-refine: stage sweep failed",
      expect.objectContaining({ message: "The stage sweep ran out of time." }),
      { path: stage(refineId(1)).name },
    );
  });

  it("★ a listing that hangs fails the pass at its budget (the heartbeat logs it)", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.mocked(gcsListObjects).mockImplementationOnce(
      () => new Promise<never>(() => {}),
    );
    const failed = sweepRefineStages().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(REFINE_STAGE_SWEEP_BUDGET_MS);
    await expect(failed).resolves.toMatchObject({
      message: "The stage sweep ran out of time.",
    });
  });
});
