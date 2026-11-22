import { describe, expect, it } from "vitest";
import type { ThemeStudioProjectState } from "@/lib/theme-studio/contracts";
import type { ThemeStudioModelKey } from "@/lib/theme-studio/models";
import type { ThemeStudioRunView } from "@/lib/theme-studio/repository";
import {
  changeBlockedReason,
  newestPictureRun,
  pictureDrawBlockedReason,
  pictureEditBlockedReason,
  pictureRetryBlockedReason,
} from "./tab-rules";

// When the tabs' buttons can act, and the sentence under them when they
// cannot (wave TS-2, builder 2C): client copies of the server's rules.

const MODEL = "gemini-3.8-flash" as ThemeStudioModelKey;
const on = {
  generationEnabled: true,
  disabledModels: new Set<ThemeStudioModelKey>(),
};

function run(over: Partial<ThemeStudioRunView>): ThemeStudioRunView {
  return {
    id: "r",
    kind: "images",
    status: "failed",
    provider: "fake",
    modelKey: MODEL,
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: null,
    cancelRequested: false,
    retryOfRunId: null,
    baseVersionId: null,
    createdAt: "2026-10-25T04:00:00Z",
    startedAt: null,
    finishedAt: null,
    usage: null,
    images: null,
    imageSlotIds: [],
    questions: [],
    declineReason: null,
    refusalCategory: null,
    change: null,
    ...over,
  } as ThemeStudioRunView;
}

function project(
  status: ThemeStudioProjectState,
  runs: ThemeStudioRunView[] = [],
) {
  return { status, modelKey: MODEL, runs, events: [] };
}

describe("changeBlockedReason (Describe a fix, Describe a change)", () => {
  it("lets a change through where the server takes one", () => {
    for (const status of ["ready", "candidate", "approved", "blocked"] as const)
      expect(changeBlockedReason(project(status), on), status).toBeNull();
  });

  it("says why it waits: switches first, then the theme's state", () => {
    expect(
      changeBlockedReason(project("ready"), {
        ...on,
        generationEnabled: false,
      }),
    ).toMatch(/Building is switched off/);
    expect(
      changeBlockedReason(project("ready"), {
        ...on,
        disabledModels: new Set([MODEL]),
      }),
    ).toMatch(/model is switched off/);
    expect(changeBlockedReason(project("generating"), on)).toMatch(
      /working on this theme/,
    );
    // ★ A live theme takes a change (migration 0288): publishing it is the
    //   theme's next release, and stores keep the one they installed.
    expect(changeBlockedReason(project("published"), on)).toBeNull();
    expect(changeBlockedReason(project("archived"), on)).toMatch(
      /removed from the list/,
    );
    expect(changeBlockedReason(project("draft"), on)).toMatch(/no design/);
    expect(changeBlockedReason(project("failed"), on)).toMatch(/no design/);
  });

  it("waits for the answers when the AI's questions are open", () => {
    const asked = project("blocked", [
      run({
        kind: "generate",
        status: "succeeded",
        questions: ["Which prices?"],
        finishedAt: "2026-10-25T04:10:00Z",
      }),
    ]);
    expect(changeBlockedReason(asked, on)).toBe(
      "Answer the questions in the chat first.",
    );
  });
});

describe("picture changes", () => {
  it("are taken while the theme is ready, Ready to publish or live", () => {
    expect(pictureEditBlockedReason(project("ready"))).toBeNull();
    expect(pictureEditBlockedReason(project("candidate"))).toBeNull();
    // A live theme's pictures can be changed (migration 0288).
    expect(pictureEditBlockedReason(project("published"))).toBeNull();
    expect(pictureDrawBlockedReason(project("published"), on)).toBeNull();
    for (const status of [
      "generating",
      "approved",
      "archived",
      "blocked",
      "draft",
      "failed",
    ] as const)
      expect(pictureEditBlockedReason(project(status)), status).toMatch(/\./);
  });

  it("draw only with building switched on", () => {
    expect(pictureDrawBlockedReason(project("ready"), on)).toBeNull();
    expect(
      pictureDrawBlockedReason(project("ready"), {
        ...on,
        generationEnabled: false,
      }),
    ).toMatch(/Building is switched off/);
    expect(pictureDrawBlockedReason(project("generating"), on)).toMatch(
      /working on this theme/,
    );
  });

  it("retry a stopped picture run only where the server would", () => {
    const failed = run({ status: "failed" });
    expect(pictureRetryBlockedReason(project("ready"), failed, on)).toBeNull();
    expect(pictureRetryBlockedReason(project("failed"), failed, on)).toBeNull();
    expect(
      pictureRetryBlockedReason(
        project("ready"),
        run({ status: "cancelled" }),
        on,
      ),
    ).toBeNull();
    expect(
      pictureRetryBlockedReason(
        project("ready"),
        run({ status: "succeeded" }),
        on,
      ),
    ).toMatch(/stopped/);
    expect(pictureRetryBlockedReason(project("candidate"), failed, on)).toMatch(
      /draw the pictures again/,
    );
    expect(
      pictureRetryBlockedReason(project("ready"), failed, {
        ...on,
        generationEnabled: false,
      }),
    ).toMatch(/Building is switched off/);
  });

  it("finds the newest picture run drawing on a design or the one that made it", () => {
    const runs = [
      run({
        id: "old",
        baseVersionId: "v2",
        createdAt: "2026-10-25T01:00:00Z",
      }),
      run({ id: "made", createdAt: "2026-10-25T02:00:00Z" }),
      run({
        id: "other",
        baseVersionId: "v1",
        createdAt: "2026-10-25T05:00:00Z",
      }),
      run({
        id: "build",
        kind: "generate",
        baseVersionId: "v2",
        createdAt: "2026-10-25T06:00:00Z",
      }),
    ];
    expect(newestPictureRun({ runs }, { id: "v2", runId: "made" })?.id).toBe(
      "made",
    );
    expect(newestPictureRun({ runs }, { id: "v2", runId: null })?.id).toBe(
      "old",
    );
    expect(
      newestPictureRun({ runs: [] }, { id: "v2", runId: null }),
    ).toBeNull();
  });
});
