import { describe, expect, it, vi } from "vitest";

// ★ TS-3D: the photo check a Theme Studio image run uses (worker.ts
// `imageReviewerFor`, reached through `themeImageReviewerFor`).

const h = vi.hoisted(() => ({
  disabled: new Set<string>(),
  vertex: { projectId: "studio-project", region: "global" } as {
    projectId: string;
    region: string;
  } | null,
  options: [] as Record<string, unknown>[],
  /** Where each request went: the location of the SDK client that sent it. */
  sentTo: [] as string[],
  next: null as null | ((location: string) => Promise<unknown>),
}));

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: class {
      readonly location: string;
      models = {
        generateContent: () => {
          h.sentTo.push(this.location);
          return h.next
            ? h.next(this.location)
            : Promise.reject(new Error("no network in tests"));
        },
      };
      constructor(opts: Record<string, unknown>) {
        this.location = String(opts.location);
      }
    },
  };
});
vi.mock("./gemini-vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gemini-vertex")>();
  return {
    ...actual,
    getVertexConfig: () => h.vertex,
    // The real client, with the options the worker built it with recorded.
    createVertexModelClient: (
      config: Parameters<typeof actual.createVertexModelClient>[0],
      options: Parameters<typeof actual.createVertexModelClient>[1],
    ) => {
      h.options.push(options as Record<string, unknown>);
      return actual.createVertexModelClient(config, options);
    },
  };
});
vi.mock("./provider-capacity-store", () => ({
  sharedProviderCapacity: vi.fn(
    (_project: string, location: string, model: string) => ({
      row: `${location}/${model}`,
      run: (
        operation: (permit: {
          signal: AbortSignal;
          succeeded(): void;
          rateLimited(ms: number): Promise<void>;
        }) => Promise<unknown>,
        signal: AbortSignal,
      ) => operation({ signal, succeeded() {}, async rateLimited() {} }),
    }),
  ),
}));
vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  getThemeStudioConfig: () => ({ disabledModels: h.disabled }),
}));

import { maxDuration as qaRouteMaxDuration } from "@/app/api/internal/theme-studio/qa/route";
import { COMMIT_POLL_DELAYS_MS } from "./capture-start";
import { IMAGE_REVIEW_TRY_TIMEOUT_MS } from "./gemini-vertex";
import {
  PHOTO_RECHECK_CALL_MS,
  PHOTO_RECHECK_MIN_CLOCK_MS,
} from "./image-recovery";
import {
  PHOTO_CHECK_BUDGET_MS,
  PHOTO_CHECK_INLINE_MS,
  QA_TIMEOUT_MS,
} from "./visual-qa";
import { THEME_IMAGE_REVIEW_MODEL_KEY } from "./image-review";
import { resolveThemeStudioModel } from "./models";
import type { ProviderCapacity } from "./provider-capacity";
import { sharedProviderCapacity } from "./provider-capacity-store";
import {
  THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS,
  themeImageReviewerFor,
} from "./worker";

function reset() {
  h.disabled.clear();
  h.vertex = { projectId: "studio-project", region: "global" };
  h.options.length = 0;
  h.sentTo.length = 0;
  h.next = null;
}

describe("Theme Studio's photo check (worker.ts imageReviewerFor, TS-3D)", () => {
  it("★★ goes to the US first and to global after, each try on its location's shared row, on Theme Studio's own clock", () => {
    reset();
    const reviewer = themeImageReviewerFor("vertex-gemini");
    expect(reviewer?.providerModel).toBe(
      resolveThemeStudioModel(THEME_IMAGE_REVIEW_MODEL_KEY).providerModel,
    );
    expect(h.options).toHaveLength(1);
    const options = h.options[0];
    // ★ A capacity that knows the location, never the one-location capacity.
    expect(options.capacity).toBeUndefined();
    expect(options.imageReviewTryTimeoutMs).toBe(
      THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS,
    );
    const at = options.capacityAt as (
      model: string,
      location: string,
    ) => ProviderCapacity & { row: string };
    expect(at("gemini-3.8-flash-preview", "us").row).toBe(
      "us/gemini-3.8-flash-preview",
    );
    expect(at("gemini-3.8-flash-preview", "global").row).toBe(
      "global/gemini-3.8-flash-preview",
    );
    // ★ The checks' shared row of each location (no scope), the one the
    //   redesigns' checks use too.
    expect(vi.mocked(sharedProviderCapacity).mock.calls).toEqual([
      ["studio-project", "us", "gemini-3.8-flash-preview"],
      ["studio-project", "global", "gemini-3.8-flash-preview"],
    ]);
  });

  it("★★ the clock: 120 s, longer than the redesigns' 75 s, past every answered check of 4 Oct, and two tries fit the budget the design review's photo check really gets", () => {
    expect(THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS).toBe(120_000);
    expect(THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS).toBeGreaterThan(
      IMAGE_REVIEW_TRY_TIMEOUT_MS,
    );
    // The slowest answered check of the 4 Oct benchmark took 110.9 s from
    // its first ask (evals/theme-studio/full-live-2026-10-04.json).
    expect(THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS).toBeGreaterThan(110_921);
    // ★ The check of a photo still unchecked has one production caller, the
    // design review (visual-qa.ts), whose checks must answer by
    // PHOTO_CHECK_BUDGET_MS after its claim: the first checks get a whole
    // try at the US and one at global, with 10 s to be admitted. (A 90 s
    // budget stopped every slow US try before its own clock could send the
    // check on to global, TS-3 review.)
    expect(
      2 * THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS + 10_000,
    ).toBeLessThanOrEqual(PHOTO_CHECK_BUDGET_MS);
    // A check started later still gets a whole US try and a minute at
    // global, or waits for the next claim.
    expect(
      THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS + 60_000,
    ).toBeLessThanOrEqual(PHOTO_RECHECK_MIN_CLOCK_MS);
    expect(PHOTO_RECHECK_MIN_CLOCK_MS).toBeLessThan(PHOTO_CHECK_BUDGET_MS);
    // And both tries fit a check's own clock when no deadline is given.
    expect(2 * THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS).toBeLessThan(
      PHOTO_RECHECK_CALL_MS,
    );
  });

  it("★★ one claim of the review route stays inside its five minutes: its photo checks, or its review, never both past the deadline", () => {
    // The route's limit; the storemink-theme-studio-qa schedule's attempt
    // deadline and the capture job's wake (WAKE_TIMEOUT_MS) are 300 s too.
    const limit = qaRouteMaxDuration * 1000;
    expect(limit).toBe(300_000);
    // Each pooled step may wait up to 5 s for a connection (lib/db/client.ts).
    const step = 5_000;
    // After its lanes the route counts the waiting reviews and awaits the
    // capture-job starts its settlements scheduled.
    const routeAfter =
      step + COMMIT_POLL_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    // A claim whose photo checks take long: they answer by the deadline,
    // then the last check is recorded and the review sent back.
    expect(PHOTO_CHECK_BUDGET_MS + 2 * step + routeAfter).toBeLessThan(limit);
    // A claim whose review follows its checks: they ended within
    // PHOTO_CHECK_INLINE_MS of the claim, then the "checked" mark, the
    // review's whole clock and its settlement.
    expect(
      PHOTO_CHECK_INLINE_MS + step + QA_TIMEOUT_MS + step + routeAfter,
    ).toBeLessThan(limit);
  });

  it("★★ a real check: refused at the US, answered at global, each try on a 120 s clock", async () => {
    reset();
    const timer = vi.spyOn(AbortSignal, "timeout");
    try {
      h.next = (location) =>
        location === "us"
          ? Promise.reject(Object.assign(new Error("busy"), { status: 429 }))
          : Promise.resolve({
              candidates: [
                {
                  finishReason: "STOP",
                  content: { parts: [{ text: '{"problems":[]}' }] },
                },
              ],
            });
      const reviewer = themeImageReviewerFor("vertex-gemini")!;
      const result = await reviewer.client.generate(
        {
          stage: "image_review",
          modelKey: THEME_IMAGE_REVIEW_MODEL_KEY,
          providerModel: reviewer.providerModel,
          system: "system",
          content: [{ type: "text", text: "check" }],
          schema: {},
          effort: "high",
        },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ kind: "ok", value: { problems: [] } });
      expect(h.sentTo).toEqual(["us", "global"]);
      expect(timer.mock.calls.map((c) => c[0])).toEqual([120_000, 120_000]);
    } finally {
      timer.mockRestore();
    }
  });

  it("is unchanged for the offline provider, a switched-off model and no Vertex settings", () => {
    reset();
    expect(themeImageReviewerFor("fake")).toMatchObject({
      providerModel: "fake",
    });
    expect(themeImageReviewerFor("other")).toBeNull();
    h.disabled.add(THEME_IMAGE_REVIEW_MODEL_KEY);
    expect(themeImageReviewerFor("vertex-gemini")).toBeNull();
    h.disabled.clear();
    h.vertex = null;
    expect(themeImageReviewerFor("vertex-gemini")).toBeNull();
    expect(h.options).toEqual([]);
  });
});
