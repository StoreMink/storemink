// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type {
  StudioStatusInput,
  ThemeStudioProgress,
} from "@/lib/theme-studio/progress";
import {
  STUDIO_PROGRESS_POLL_MS,
  studioProgressUrl,
  useStudioProgress,
} from "./use-studio-progress";

// ---------------------------------------------------------------------------
// TS-2A: the theme page's poll. A GET route through lib/pos/use-poll.ts, every
// 3 s only while the theme changes by itself (rows 2, 5 and 6), slower while
// nothing changes, stopping for good on 401, 403 and 404, keeping the last
// answer on any other failure, and handing the page the newer of its own
// answer and the poll's, with flags for a new revision or a new design.
// ---------------------------------------------------------------------------

const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-25T10:00:00.000Z";

function status(overrides: Partial<StudioStatusInput> = {}): StudioStatusInput {
  return {
    now: NOW,
    projectStatus: "generating",
    archivedAt: null,
    hasCurrentVersion: false,
    release: null,
    publishAttempt: null,
    working: {
      kind: "building",
      step: "Drawing pictures",
      since: "2026-10-25T09:40:00.000Z",
      lastProgressAt: "2026-10-25T09:59:00.000Z",
      nextTryAt: null,
    },
    questions: {
      open: false,
      count: 0,
      askedAt: null,
      rounds: 0,
      tooManyRounds: false,
    },
    stop: null,
    checks: null,
    evidence: null,
    pictures: { missing: 0, lastRun: null },
    switches: { buildingOff: false, modelOff: false, checksOff: false },
    ...overrides,
  };
}

function progress(
  overrides: Partial<ThemeStudioProgress> = {},
): ThemeStudioProgress {
  return {
    projectId: PROJECT,
    revision: 4,
    versionIds: [],
    currentVersionId: null,
    status: status(),
    steps: [],
    updatedAt: "2026-10-25T09:59:00.000Z",
    ...overrides,
  };
}

const READY = status({
  projectStatus: "ready",
  working: null,
  hasCurrentVersion: true,
});

let fetchMock: ReturnType<typeof vi.fn>;

function answer(body: unknown, init: { status?: number } = {}) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function tick(ms = STUDIO_PROGRESS_POLL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useStudioProgress", () => {
  it("asks the progress route every 3 s while the theme works, never a server action", async () => {
    const later = progress({
      status: status({ now: "2026-10-25T10:00:03.000Z" }),
      updatedAt: "2026-10-25T10:00:02.000Z",
    });
    fetchMock.mockImplementation(() => answer(later));
    const { result } = renderHook(() => useStudioProgress(PROJECT, progress()));
    expect(result.current.polling).toBe(true);
    expect(result.current.status.row).toBe(5);
    expect(fetchMock).not.toHaveBeenCalled();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/platform/theme-studio/projects/${PROJECT}/progress`);
    expect(url).toBe(studioProgressUrl(PROJECT));
    expect(init).toMatchObject({ cache: "no-store" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method ?? "GET").toBe("GET");
    expect(result.current.progress).toEqual(later);
    expect(result.current.revisionChanged).toBe(false);
  });

  it("does not poll a theme that does not change by itself", async () => {
    const { result } = renderHook(() =>
      useStudioProgress(PROJECT, progress({ status: READY })),
    );
    expect(result.current.polling).toBe(false);
    await tick(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls a publish and stuck work too", () => {
    const publishing = renderHook(() =>
      useStudioProgress(
        PROJECT,
        progress({
          status: status({
            projectStatus: "approved",
            working: null,
            publishAttempt: {
              state: "publishing",
              startedAt: "2026-10-25T09:58:00.000Z",
              lastWriteAt: "2026-10-25T09:59:00.000Z",
              reasons: [],
            },
          }),
        }),
      ),
    );
    expect(publishing.result.current.status.row).toBe(2);
    expect(publishing.result.current.polling).toBe(true);
    const stuck = renderHook(() =>
      useStudioProgress(
        PROJECT,
        progress({
          status: status({
            working: {
              kind: "building",
              step: null,
              since: "2026-10-25T08:00:00.000Z",
              lastProgressAt: "2026-10-25T09:00:00.000Z",
              nextTryAt: null,
            },
          }),
        }),
      ),
    );
    expect(stuck.result.current.status.row).toBe(6);
    expect(stuck.result.current.polling).toBe(true);
  });

  it("slows down while nothing but the clock changes", async () => {
    let n = 0;
    fetchMock.mockImplementation(() =>
      answer(
        progress({ status: status({ now: `2026-10-25T10:0${n++}:00.000Z` }) }),
      ),
    );
    renderHook(() => useStudioProgress(PROJECT, progress()));
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Unchanged: the next waits 6 s, then 12 s.
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(6_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(6_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /** Five answers that only moved the clock: the poll now waits 48 s. */
  async function slowDown() {
    for (const [ms, calls] of [
      [3_000, 1],
      [6_000, 2],
      [12_000, 3],
      [24_000, 4],
      [48_000, 5],
    ] as const) {
      await tick(ms);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
    await tick(24_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  }

  it("asks again 3 s after polling starts again, whatever it slowed to before", async () => {
    let n = 0;
    fetchMock.mockImplementation(() =>
      answer(
        progress({
          revision: n < 5 ? 4 : 6,
          status: status({ now: `2026-10-25T10:${10 + n++}:00.000Z` }),
        }),
      ),
    );
    const { result, rerender } = renderHook(
      ({ initial }) => useStudioProgress(PROJECT, initial),
      { initialProps: { initial: progress() } },
    );
    await slowDown();
    // Stop: the page re-renders at rest, and the poll is off.
    rerender({ initial: progress({ revision: 5, status: READY }) });
    expect(result.current.polling).toBe(false);
    await tick(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // Continue building: working again, and the first ask comes after 3 s.
    rerender({ initial: progress({ revision: 6 }) });
    expect(result.current.polling).toBe(true);
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    // That first answer was news, so the count starts again: 3 s, then 6 s.
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("asks again 3 s after an action while it polls, not after the stretched wait", async () => {
    let n = 0;
    fetchMock.mockImplementation(() =>
      answer(
        progress({
          status: status({ now: `2026-10-25T10:${10 + n++}:00.000Z` }),
        }),
      ),
    );
    const { rerender } = renderHook(
      ({ initial }) => useStudioProgress(PROJECT, initial),
      { initialProps: { initial: progress() } },
    );
    await slowDown();
    // Stop and check again: still working, a new revision from the server.
    rerender({ initial: progress({ revision: 6 }) });
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    // The first answer after a restart counts as news even when it only
    // moved the clock: the count starts again from 3 s.
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("keeps the base interval while the answer changes", async () => {
    let n = 0;
    fetchMock.mockImplementation(() =>
      answer(progress({ updatedAt: `2026-10-25T10:00:0${n++}.000Z` })),
    );
    renderHook(() => useStudioProgress(PROJECT, progress()));
    for (let i = 1; i <= 3; i += 1) {
      await tick(3_000);
      expect(fetchMock).toHaveBeenCalledTimes(i);
    }
  });

  it.each([
    [401, "signed_out"],
    [403, "forbidden"],
    [404, "missing"],
  ] as const)("stops for good on %i", async (code, problem) => {
    fetchMock.mockImplementation(() =>
      answer({ error: "no" }, { status: code }),
    );
    const { result } = renderHook(() => useStudioProgress(PROJECT, progress()));
    await tick();
    expect(result.current.problem).toBe(problem);
    expect(result.current.polling).toBe(false);
    await tick(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The last answer stays on screen.
    expect(result.current.progress).toEqual(progress());
  });

  it("keeps the last answer when a poll fails, and tries again", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.reject(new TypeError("offline")))
      .mockImplementationOnce(() => answer({ error: "busy" }, { status: 500 }))
      .mockImplementationOnce(() =>
        Promise.resolve(new Response("not json", { status: 200 })),
      )
      .mockImplementation(() => answer(progress({ revision: 5 })));
    const { result } = renderHook(() => useStudioProgress(PROJECT, progress()));
    await tick(3_000);
    expect(result.current.progress.revision).toBe(4);
    expect(result.current.problem).toBeNull();
    await tick(6_000);
    await tick(12_000);
    expect(result.current.progress.revision).toBe(4);
    await tick(24_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.current.progress.revision).toBe(5);
  });

  it("flags a new revision or design for the page to refresh, and clears once the page has it", async () => {
    const newer = progress({
      revision: 6,
      versionIds: ["v2", "v1"],
      status: status({ now: "2026-10-25T10:00:03.000Z" }),
    });
    fetchMock.mockImplementation(() => answer(newer));
    const { result, rerender } = renderHook(
      ({ initial }) => useStudioProgress(PROJECT, initial),
      { initialProps: { initial: progress({ versionIds: ["v1"] }) } },
    );
    await tick();
    expect(result.current.progress.revision).toBe(6);
    expect(result.current.revisionChanged).toBe(true);
    expect(result.current.versionsChanged).toBe(true);
    // The page re-rendered with fresh server data at least as new.
    rerender({ initial: newer });
    expect(result.current.revisionChanged).toBe(false);
    expect(result.current.versionsChanged).toBe(false);
    // An older poll never wins over a newer initial.
    rerender({
      initial: progress({
        revision: 7,
        versionIds: ["v2", "v1"],
        status: READY,
      }),
    });
    expect(result.current.progress.revision).toBe(7);
    expect(result.current.polling).toBe(false);
  });

  it("prefers the newer read at the same revision", async () => {
    const polled = progress({
      status: status({ now: "2026-10-25T10:00:03.000Z", stop: null }),
      updatedAt: "x",
    });
    fetchMock.mockImplementation(() => answer(polled));
    const { result, rerender } = renderHook(
      ({ initial }) => useStudioProgress(PROJECT, initial),
      { initialProps: { initial: progress() } },
    );
    await tick();
    expect(result.current.progress.updatedAt).toBe("x");
    rerender({
      initial: progress({
        status: status({ now: "2026-10-25T10:00:09.000Z" }),
        updatedAt: "y",
      }),
    });
    expect(result.current.progress.updatedAt).toBe("y");
  });

  it("stops polling once the theme stops working", async () => {
    fetchMock.mockImplementation(() =>
      answer(progress({ revision: 5, status: READY })),
    );
    const { result } = renderHook(() => useStudioProgress(PROJECT, progress()));
    await tick();
    expect(result.current.status.row).toBe(19);
    expect(result.current.polling).toBe(false);
    await tick(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an answer for another theme, as nothing new", async () => {
    let n = 0;
    fetchMock.mockImplementation(() =>
      answer(
        progress({
          projectId: "22222222-2222-4222-8222-222222222222",
          revision: 9,
          updatedAt: `2026-10-25T10:00:0${n++}.000Z`,
        }),
      ),
    );
    const { result } = renderHook(() => useStudioProgress(PROJECT, progress()));
    await tick();
    expect(result.current.progress.revision).toBe(4);
    // It never counts as news, so the poll slows down: 6 s to the next.
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
