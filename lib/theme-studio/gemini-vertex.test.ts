import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  constructed: [] as Record<string, unknown>[],
  /** Where each request went: the location of the client that sent it. */
  sentTo: [] as string[],
  next: null as null | ((location: string) => Promise<unknown>),
}));

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: class {
      readonly location: string;
      models = {
        generateContent: (params: Record<string, unknown>) => {
          state.requests.push(params);
          state.sentTo.push(this.location);
          return state.next
            ? state.next(this.location)
            : Promise.reject(new Error("unset"));
        },
      };
      constructor(opts: Record<string, unknown>) {
        state.constructed.push(opts);
        this.location = String(opts.location);
      }
    },
  };
});

// The client's log lines, off the console and readable by the tests.
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@google/genai";
import { logWarn } from "@/lib/observability/logger";
import { estimateCostMicroUsd, servedLocationOf } from "./cost";
import {
  IMAGE_REVIEW_FIRST_LOCATION,
  IMAGE_REVIEW_RATE_LIMIT_RETRIES,
  IMAGE_REVIEW_TRY_TIMEOUT_MS,
  PROVIDER_ERROR_MESSAGE_MAX,
  classifyProviderError,
  createVertexModelClient,
  getVertexConfig,
  imageReviewRateLimitDelayMs,
  providerErrorFacts,
  quotaNamedIn,
  type VertexClientOptions,
} from "./gemini-vertex";
import {
  THEME_IMAGE_REVIEW_MODEL_KEY,
  reviewThemeImage,
  themeImageReviewContent,
  themeImageReviewSystem,
} from "./image-review";
import type { StructuredRequest } from "./provider";
import {
  ProviderCapacityLost,
  coordinatedProviderCapacity,
  providerCapacityKey,
  type CapacityStore,
  type ProviderCapacity,
} from "./provider-capacity";
import {
  RATE_LIMIT_BACKOFF,
  rateLimitDelayMs,
  sleepUnlessAborted,
} from "./rate-limit-backoff";

const request: StructuredRequest = {
  stage: "intent",
  modelKey: "gemini-3.1-pro",
  providerModel: "gemini-3.1-pro-preview",
  system: "system text",
  content: [
    { type: "text", text: "brief" },
    { type: "image", mediaType: "image/webp", base64: "AAAA" },
  ],
  schema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {},
  },
  maxTokens: 16000,
  effort: "high",
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: '{"decision":"proceed"}' }] },
      },
    ],
    usageMetadata: {
      promptTokenCount: 1200,
      cachedContentTokenCount: 800,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 300,
    },
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  state.requests = [];
  state.constructed = [];
  state.sentTo = [];
  state.next = null;
});

describe("Gemini on Vertex client", () => {
  it("reads config only from server environment", () => {
    expect(getVertexConfig({})).toBeNull();
    expect(getVertexConfig({ GCP_PROJECT_ID: "p" })).toEqual({
      projectId: "p",
      region: "global",
    });
    expect(
      getVertexConfig({
        GCP_PROJECT_ID: "p",
        THEME_STUDIO_GCP_PROJECT_ID: "studio",
        THEME_STUDIO_VERTEX_LOCATION: "us-central1",
      }),
    ).toEqual({ projectId: "studio", region: "us-central1" });
  });

  it("sends a tool-free structured request with images and high thinking", async () => {
    state.next = () => Promise.resolve(response());
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    const result = await client.generate(request, signal());
    expect(result).toMatchObject({
      kind: "ok",
      value: { decision: "proceed" },
    });
    expect(state.constructed[0]).toMatchObject({
      enterprise: true,
      project: "p",
      location: "global",
    });
    const sent = state.requests[0] as {
      model: string;
      contents: { parts: unknown[] }[];
      config: Record<string, unknown>;
    };
    expect(sent.model).toBe("gemini-3.1-pro-preview");
    expect(sent.contents[0].parts).toEqual([
      { text: "brief" },
      {
        inlineData: { mimeType: "image/webp", data: "AAAA" },
        // Every image is read at the most detailed resolution offered.
        mediaResolution: { level: "MEDIA_RESOLUTION_ULTRA_HIGH" },
      },
    ]);
    expect(sent.config).toMatchObject({
      systemInstruction: "system text",
      maxOutputTokens: 16000,
      responseMimeType: "application/json",
      responseJsonSchema: request.schema,
      thinkingConfig: { thinkingLevel: "HIGH" },
    });
    expect(sent.config).not.toHaveProperty("tools");
  });

  it("omits the provider output cap when the request has no app ceiling", async () => {
    state.next = () => Promise.resolve(response());
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });

    await client.generate({ ...request, maxTokens: undefined }, signal());

    const sent = state.requests[0] as { config: Record<string, unknown> };
    expect(sent.config).not.toHaveProperty("maxOutputTokens");
  });

  it("reports cached tokens as a subset and thinking separately", async () => {
    state.next = () => Promise.resolve(response());
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    const result = await client.generate(request, signal());
    expect(result.usage).toEqual({
      inputTokens: 1200,
      cachedTokens: 800,
      outputTokens: 40,
      thinkingTokens: 300,
    });
    state.next = () =>
      Promise.resolve(
        response({
          usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 99 },
        }),
      );
    expect((await client.generate(request, signal())).usage.cachedTokens).toBe(
      10,
    );
  });

  it("ignores thought parts when reading the answer", async () => {
    state.next = () =>
      Promise.resolve(
        response({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  { text: "thinking about it", thought: true },
                  { text: '{"a":1}' },
                ],
              },
            },
          ],
        }),
      );
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "ok",
      value: { a: 1 },
    });
  });

  it("maps safety blocks, truncation, bad JSON and unexplained stops", async () => {
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    state.next = () =>
      Promise.resolve(
        response({
          candidates: [],
          promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
        }),
      );
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "refused",
      category: "PROHIBITED_CONTENT",
    });
    state.next = () =>
      Promise.resolve(
        response({
          candidates: [
            {
              finishReason: "SAFETY",
              safetyRatings: [
                { category: "HARM_CATEGORY_HARASSMENT", blocked: true },
              ],
            },
          ],
        }),
      );
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "refused",
      category: "HARM_CATEGORY_HARASSMENT",
    });
    state.next = () =>
      Promise.resolve(
        response({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
      );
    expect((await client.generate(request, signal())).kind).toBe("truncated");
    state.next = () =>
      Promise.resolve(
        response({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "not json" }] },
            },
          ],
        }),
      );
    expect((await client.generate(request, signal())).kind).toBe(
      "invalid_json",
    );
    // An answer that did not finish normally is re-asked (invalid_json),
    // never a terminal "no provider" error, and keeps its paid usage.
    for (const finish of ["OTHER", "LANGUAGE", "FINISH_REASON_UNSPECIFIED"]) {
      state.next = () =>
        Promise.resolve(
          response({
            candidates: [
              { finishReason: finish, content: { parts: [{ text: "{}" }] } },
            ],
          }),
        );
      const result = await client.generate(request, signal());
      expect(result.kind).toBe("invalid_json");
    }
    state.next = () => Promise.resolve(response({ candidates: [] }));
    expect((await client.generate(request, signal())).kind).toBe(
      "invalid_json",
    );
  });

  it("classifies provider errors into the closed vocabulary", async () => {
    const withStatus = (s: number) =>
      Object.assign(new Error("x"), { status: s });
    expect(classifyProviderError(withStatus(429))).toBe("rate_limited");
    expect(classifyProviderError(withStatus(403))).toBe("provider_auth");
    expect(classifyProviderError(new Error("invalid_grant: reauth"))).toBe(
      "provider_auth",
    );
    expect(classifyProviderError(withStatus(404))).toBe("provider_rejected");
    expect(classifyProviderError(withStatus(504))).toBe("provider_timeout");
    expect(classifyProviderError(withStatus(503))).toBe("provider_unavailable");
    const aborted = new AbortController();
    aborted.abort();
    expect(classifyProviderError(withStatus(503), aborted.signal)).toBe(
      "cancelled",
    );

    state.next = () => Promise.reject(withStatus(403));
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "error",
      code: "provider_auth",
    });
  });
});

describe("waiting out a rate limit", () => {
  const rateLimited = () =>
    Promise.reject(
      Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }),
    );

  const sleeper = (result: boolean) =>
    vi.fn(async (ms: number, abort?: AbortSignal) => {
      void ms;
      void abort;
      return result;
    });

  function clientWith(sleep = sleeper(true)) {
    return {
      sleep,
      client: createVertexModelClient(
        { projectId: "p", region: "global" },
        { sleep, random: () => 1 },
      ),
    };
  }

  it("hands 429 to its own backoff, not the SDK's fast retry", () => {
    clientWith();
    const retry = (
      state.constructed[0] as {
        httpOptions: { retryOptions: { httpStatusCodes: number[] } };
      }
    ).httpOptions.retryOptions;
    expect(retry.httpStatusCodes).not.toContain(429);
    expect(retry.httpStatusCodes).toEqual(
      expect.arrayContaining([500, 503, 504]),
    );
  });

  it("waits and tries again, and a later success is an ordinary answer", async () => {
    let calls = 0;
    state.next = () =>
      ++calls < 3 ? rateLimited() : Promise.resolve(response());
    const { client, sleep } = clientWith();
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "ok",
      value: { decision: "proceed" },
    });
    expect(state.requests).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([15_000, 30_000]);
  });

  it("preserves 429 backoff when shared cooldown persistence fails", async () => {
    let calls = 0;
    state.next = () =>
      ++calls === 1 ? rateLimited() : Promise.resolve(response());
    const sleep = vi.fn(async () => true);
    const capacity: ProviderCapacity = {
      run: (operation, signal) =>
        operation({
          signal,
          succeeded() {},
          async rateLimited() {
            throw new Error("DB timeout");
          },
        }),
    };
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      { capacity: () => capacity, sleep, random: () => 0 },
    );
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "ok",
    });
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("registers the same jittered cooldown before shared release and acquires a new permit for the retry", async () => {
    const events: string[] = [];
    const pause = vi.fn(async (ms: number) => {
      void ms;
      events.push("pause");
    });
    const capacity: ProviderCapacity = {
      async run(operation, signal) {
        events.push("admit");
        try {
          return await operation({
            signal,
            succeeded: () => {
              events.push("success");
            },
            rateLimited: pause,
          });
        } finally {
          events.push("release");
        }
      },
    };
    const scope = vi.fn(() => capacity);
    const random = vi.fn().mockReturnValueOnce(0.3).mockReturnValue(0.9);
    const sleep = vi.fn(async (ms: number) => {
      void ms;
      events.push("sleep");
      return true;
    });
    let calls = 0;
    state.next = () => {
      events.push("send");
      return ++calls === 1 ? rateLimited() : Promise.resolve(response());
    };
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      { capacity: scope, random, sleep },
    );
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "ok",
    });
    expect(scope).toHaveBeenCalledWith(request.providerModel);
    expect(random).toHaveBeenCalledOnce();
    expect(pause.mock.calls[0][0]).toBe(sleep.mock.calls[0][0]);
    expect(events).toEqual([
      "admit",
      "send",
      "pause",
      "release",
      "sleep",
      "admit",
      "send",
      "success",
      "release",
    ]);
  });

  it("gives up after five retries and says it was rate limited", async () => {
    state.next = rateLimited;
    const { client, sleep } = clientWith();
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "error",
      code: "rate_limited",
    });
    expect(state.requests).toHaveLength(6);
    const waits = sleep.mock.calls.map((c) => c[0]);
    expect(waits).toEqual([15_000, 30_000, 60_000, 120_000, 120_000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      RATE_LIMIT_BACKOFF.totalMs,
    );
  });

  it("counts retries, not just waiting time, so short jittered waits still stop", async () => {
    state.next = rateLimited;
    const sleep = sleeper(true);
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      { sleep, random: () => 0 },
    );
    await client.generate(request, signal());
    // Half-length waits total 172.5s, well inside the time budget, so only
    // the retry count can be what stopped it.
    expect(state.requests).toHaveLength(6);
  });

  it("stops at once when the run is aborted mid-wait", async () => {
    state.next = rateLimited;
    const { client } = clientWith(sleeper(false));
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "error",
      code: "cancelled",
    });
    expect(state.requests).toHaveLength(1);
  });

  it("never waits on anything but a rate limit", async () => {
    state.next = () =>
      Promise.reject(Object.assign(new Error("x"), { status: 503 }));
    const { client, sleep } = clientWith();
    expect(await client.generate(request, signal())).toMatchObject({
      code: "provider_unavailable",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(state.requests).toHaveLength(1);
  });
});

describe("rateLimitDelayMs", () => {
  it("doubles from 15s, caps at two minutes, and jitters down to half", () => {
    expect([0, 1, 2, 3, 4, 9].map((n) => rateLimitDelayMs(n, () => 1))).toEqual(
      [15_000, 30_000, 60_000, 120_000, 120_000, 120_000],
    );
    expect(rateLimitDelayMs(0, () => 0)).toBe(7_500);
    expect(rateLimitDelayMs(3, () => 0)).toBe(60_000);
  });
});

describe("sleepUnlessAborted", () => {
  it("resolves false as soon as the run is aborted", async () => {
    const controller = new AbortController();
    const waiting = sleepUnlessAborted(60_000, controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
    expect(await sleepUnlessAborted(1, controller.signal)).toBe(false);
    expect(await sleepUnlessAborted(1)).toBe(true);
  });
});

describe("a check of an image (image_review)", () => {
  const review: StructuredRequest = {
    ...request,
    stage: "image_review",
    modelKey: "gemini-3.8-flash",
    providerModel: "gemini-3.8-flash-preview",
    effort: "high",
  };
  delete (review as { maxTokens?: number }).maxTokens;
  const rateLimited = () =>
    Promise.reject(
      Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }),
    );

  it("★★ gives each try its own 75 s clock, never one for the whole call, without capping tokens", async () => {
    const clocks: AbortController[] = [];
    const timer = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const clock = new AbortController();
      clocks.push(clock);
      return clock.signal;
    });
    try {
      let calls = 0;
      state.next = () =>
        ++calls === 1 ? rateLimited() : new Promise(() => {});
      const sleep = vi.fn(async () => true);
      const client = createVertexModelClient(
        { projectId: "p", region: "global" },
        { sleep, random: () => 0.5 },
      );
      const pending = client.generate(review, signal());
      await vi.waitFor(() => expect(state.requests).toHaveLength(2));
      // ★ One clock per try, each of IMAGE_REVIEW_TRY_TIMEOUT_MS, set when
      //   the try was admitted; no 180 s clock for the whole call.
      expect(timer.mock.calls.map((c) => c[0])).toEqual([
        IMAGE_REVIEW_TRY_TIMEOUT_MS,
        IMAGE_REVIEW_TRY_TIMEOUT_MS,
      ]);
      expect(IMAGE_REVIEW_TRY_TIMEOUT_MS).toBe(75_000);
      const config = state.requests[1].config as Record<string, unknown>;
      expect(config).not.toHaveProperty("maxOutputTokens");
      // The second try's clock running out ends the call as a timeout.
      clocks[1].abort(new Error("deadline"));
      await expect(pending).resolves.toMatchObject({
        kind: "error",
        code: "provider_timeout",
      });
      expect(state.requests).toHaveLength(2);
    } finally {
      timer.mockRestore();
    }
  });

  it("★★ waits a jittered 10 to 20 s after a 429, at most twice, and tells the caller of each", async () => {
    state.next = rateLimited;
    const sleep = vi.fn(async (ms: number, abort?: AbortSignal) => {
      void ms;
      void abort;
      return true;
    });
    const random = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValue(0.5);
    const onRetry = vi.fn();
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      { sleep, random, onRetry },
    );
    expect(await client.generate(review, signal())).toMatchObject({
      kind: "error",
      code: "rate_limited",
    });
    expect(state.requests).toHaveLength(1 + IMAGE_REVIEW_RATE_LIMIT_RETRIES);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10_000, 20_000]);
    expect(onRetry.mock.calls.map((c) => c[0])).toEqual([
      {
        stage: "image_review",
        providerModel: "gemini-3.8-flash-preview",
        waitMs: 10_000,
      },
      {
        stage: "image_review",
        providerModel: "gemini-3.8-flash-preview",
        waitMs: 20_000,
      },
    ]);
  });

  it("★ the wait after a 429 is the caller's time, not the refused try's clock", async () => {
    const clocks: AbortController[] = [];
    const timer = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const clock = new AbortController();
      clocks.push(clock);
      return clock.signal;
    });
    try {
      let calls = 0;
      state.next = () =>
        ++calls === 1 ? rateLimited() : Promise.resolve(response());
      const outer = new AbortController();
      const waited: AbortSignal[] = [];
      const sleep = vi.fn(async (_ms: number, abort?: AbortSignal) => {
        // The refused try's clock runs out during the wait.
        clocks[0].abort(new Error("deadline"));
        if (abort) waited.push(abort);
        return !abort?.aborted;
      });
      const client = createVertexModelClient(
        { projectId: "p", region: "global" },
        { sleep, random: () => 0 },
      );
      expect(await client.generate(review, outer.signal)).toMatchObject({
        kind: "ok",
      });
      expect(waited).toEqual([outer.signal]);
    } finally {
      timer.mockRestore();
    }
  });

  it("a counter that throws never fails the check", async () => {
    let calls = 0;
    state.next = () =>
      ++calls === 1 ? rateLimited() : Promise.resolve(response());
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      {
        sleep: async () => true,
        random: () => 0,
        onRetry: () => {
          throw new Error("counter broke");
        },
      },
    );
    expect(await client.generate(review, signal())).toMatchObject({
      kind: "ok",
    });
  });

  it("imageReviewRateLimitDelayMs stays between 10 and 20 s", () => {
    expect(imageReviewRateLimitDelayMs(() => 0)).toBe(10_000);
    expect(imageReviewRateLimitDelayMs(() => 1)).toBe(20_000);
    expect(imageReviewRateLimitDelayMs(() => 0.5)).toBe(15_000);
    expect(imageReviewRateLimitDelayMs(() => 7)).toBe(20_000);
    expect(imageReviewRateLimitDelayMs(() => -1)).toBe(10_000);
  });

  it("every other stage keeps its one clock for the whole call", async () => {
    const timer = vi.spyOn(AbortSignal, "timeout");
    try {
      let calls = 0;
      state.next = () =>
        ++calls < 3 ? rateLimited() : Promise.resolve(response());
      const client = createVertexModelClient(
        { projectId: "p", region: "global" },
        { sleep: async () => true, random: () => 1 },
      );
      expect(
        await client.generate({ ...request, stage: "visual_qa" }, signal()),
      ).toMatchObject({ kind: "ok" });
      expect(timer.mock.calls.map((c) => c[0])).toEqual([10 * 60 * 1000]);
    } finally {
      timer.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// What Google said, in the log (robustness audit B23).
// ---------------------------------------------------------------------------

/** The shared pay-as-you-go pool's 429, exactly as measured on
 *  storemink-staging (23 Oct 2026): it names no quota. */
const SHARED_POOL_BODY =
  '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}';

const SHARED_POOL_MESSAGE = "Resource has been exhausted (e.g. check quota).";

const QUOTA_METRIC =
  "aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model";

const QUOTA_LIMIT = "GenerateContentRequestsPerMinutePerProjectPerBaseModel";

/** A project quota's 429 naming itself in an ErrorInfo, with the shared
 *  pool's words, so only the details can name it. */
const ERROR_INFO_BODY = JSON.stringify({
  error: {
    code: 429,
    message: SHARED_POOL_MESSAGE,
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "RATE_LIMIT_EXCEEDED",
        domain: "googleapis.com",
        metadata: {
          quota_metric: QUOTA_METRIC,
          quota_limit: QUOTA_LIMIT,
          quota_limit_value: "60",
          consumer: "projects/123456",
          service: "aiplatform.googleapis.com",
        },
      },
    ],
  },
});

const ONLINE_METRIC =
  "aiplatform.googleapis.com/online_prediction_requests_per_base_model";

/** A project quota's 429 naming itself in a QuotaFailure violation. */
const QUOTA_FAILURE_BODY = JSON.stringify({
  error: {
    code: 429,
    message: SHARED_POOL_MESSAGE,
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            subject: "project:123456",
            description: "The request was refused.",
            quotaMetric: ONLINE_METRIC,
            quotaId: "OnlinePredictionRequestsPerMinutePerProjectPerBaseModel",
            quotaValue: "2",
          },
        ],
      },
    ],
  },
});

/** Vertex's own wording for a project quota, with no details. */
const MESSAGE_FORM_BODY = JSON.stringify({
  error: {
    code: 429,
    message: `Quota exceeded for ${QUOTA_METRIC} with base model: gemini-3.8-flash. Please submit a quota increase request.`,
    status: "RESOURCE_EXHAUSTED",
  },
});

const apiError = (body: string, status = 429) =>
  new ApiError({ message: body, status });

/** The contexts one log line was written with, in order. */
function warned(message: string) {
  return vi
    .mocked(logWarn)
    .mock.calls.filter(([m]) => m === message)
    .map(([, context]) => context);
}

describe("what Google said, in the log (B23)", () => {
  // Markers, so a test can prove neither reaches a log line.
  const marked: StructuredRequest = {
    ...request,
    system: "SYSTEM-MARKER",
    content: [{ type: "text", text: "PROMPT-MARKER" }],
  };

  function clientWith(sleep = vi.fn(async () => true)) {
    return createVertexModelClient(
      { projectId: "p", region: "global" },
      { sleep, random: () => 0 },
    );
  }

  it("★★ a 429 with the shared pool's real body logs its status and words, and names no quota", async () => {
    let calls = 0;
    state.next = () =>
      ++calls === 1
        ? Promise.reject(apiError(SHARED_POOL_BODY))
        : Promise.resolve(response());
    expect(await clientWith().generate(marked, signal())).toMatchObject({
      kind: "ok",
    });
    expect(warned("theme_studio.rate_limited_retry")).toEqual([
      {
        stage: "intent",
        model: "gemini-3.1-pro",
        retry: 1,
        waitMs: 7_500,
        httpStatus: 429,
        errorStatus: "RESOURCE_EXHAUSTED",
        errorMessage: SHARED_POOL_MESSAGE,
        quotaNamed: null,
      },
    ]);
    // Content-free: neither the prompt nor the system text is logged.
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toMatch(/MARKER/);
  });

  it("★ an ErrorInfo body logs the quota its metadata names, on every retry and on the line the call ends with", async () => {
    state.next = () => Promise.reject(apiError(ERROR_INFO_BODY));
    expect(await clientWith().generate(marked, signal())).toMatchObject({
      kind: "error",
      code: "rate_limited",
    });
    const named = `${QUOTA_METRIC}, limit ${QUOTA_LIMIT}, value 60`;
    expect(
      warned("theme_studio.rate_limited_retry").map((c) => c?.quotaNamed),
    ).toEqual(Array(5).fill(named));
    expect(warned("theme_studio.provider_error")).toEqual([
      {
        stage: "intent",
        model: "gemini-3.1-pro",
        code: "rate_limited",
        tries: 6,
        httpStatus: 429,
        errorStatus: "RESOURCE_EXHAUSTED",
        errorMessage: SHARED_POOL_MESSAGE,
        quotaNamed: named,
      },
    ]);
  });

  it("★ a QuotaFailure body logs the quota its violation names", async () => {
    let calls = 0;
    state.next = () =>
      ++calls === 1
        ? Promise.reject(apiError(QUOTA_FAILURE_BODY))
        : Promise.resolve(response());
    await clientWith().generate(marked, signal());
    expect(warned("theme_studio.rate_limited_retry")).toEqual([
      expect.objectContaining({
        httpStatus: 429,
        errorStatus: "RESOURCE_EXHAUSTED",
        quotaNamed: `${ONLINE_METRIC}, value 2`,
      }),
    ]);
  });

  it("★ a message that names its quota logs it", async () => {
    let calls = 0;
    state.next = () =>
      ++calls === 1
        ? Promise.reject(apiError(MESSAGE_FORM_BODY))
        : Promise.resolve(response());
    await clientWith().generate(marked, signal());
    expect(warned("theme_studio.rate_limited_retry")).toEqual([
      expect.objectContaining({
        httpStatus: 429,
        errorMessage: expect.stringMatching(/^Quota exceeded for /),
        quotaNamed: QUOTA_METRIC,
      }),
    ]);
  });

  it("ends a failed call with one line in Google's words, and a cancelled call with none", async () => {
    state.next = () =>
      Promise.reject(
        apiError(
          '{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}',
          503,
        ),
      );
    expect(await clientWith().generate(marked, signal())).toMatchObject({
      kind: "error",
      code: "provider_unavailable",
    });
    expect(warned("theme_studio.provider_error")).toEqual([
      {
        stage: "intent",
        model: "gemini-3.1-pro",
        code: "provider_unavailable",
        tries: 1,
        httpStatus: 503,
        errorStatus: "UNAVAILABLE",
        errorMessage: "The model is overloaded. Please try again later.",
        quotaNamed: null,
      },
    ]);
    vi.mocked(logWarn).mockClear();
    // Cancelled while it waited out a 429: the run's own doing, not Google's.
    state.next = () => Promise.reject(apiError(SHARED_POOL_BODY));
    expect(
      await clientWith(vi.fn(async () => false)).generate(marked, signal()),
    ).toMatchObject({ kind: "error", code: "cancelled" });
    expect(warned("theme_studio.provider_error")).toEqual([]);
  });

  it("a check whose try runs out its clock logs the timeout", async () => {
    const clock = new AbortController();
    const timer = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(clock.signal);
    try {
      state.next = () => new Promise(() => {});
      const pending = clientWith().generate(
        { ...marked, stage: "image_review" },
        signal(),
      );
      await vi.waitFor(() => expect(state.requests).toHaveLength(1));
      clock.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
      await expect(pending).resolves.toMatchObject({
        kind: "error",
        code: "provider_timeout",
      });
      expect(warned("theme_studio.provider_error")).toEqual([
        {
          stage: "image_review",
          model: "gemini-3.1-pro",
          code: "provider_timeout",
          tries: 1,
          httpStatus: null,
          errorStatus: null,
          errorMessage: "The operation was aborted due to timeout",
          quotaNamed: null,
        },
      ]);
    } finally {
      timer.mockRestore();
    }
  });
});

describe("providerErrorFacts", () => {
  it("reads a streamed refusal's body after its 'got status' prefix, and a body sent as a list", () => {
    for (const message of [
      `got status: RESOURCE_EXHAUSTED. ${ERROR_INFO_BODY}`,
      `[${ERROR_INFO_BODY}]`,
    ]) {
      expect(providerErrorFacts(apiError(message))).toEqual({
        httpStatus: 429,
        errorStatus: "RESOURCE_EXHAUSTED",
        errorMessage: SHARED_POOL_MESSAGE,
        quotaNamed: `${QUOTA_METRIC}, limit ${QUOTA_LIMIT}, value 60`,
      });
    }
  });

  it("cuts Google's message to 500 characters, whitespace collapsed, but reads the quota from all of it", () => {
    const long = `${"Busy\n  ".repeat(150)}Quota  exceeded\nfor ${QUOTA_METRIC} with base model: x.`;
    const facts = providerErrorFacts(
      apiError(JSON.stringify({ error: { message: long, code: 429 } })),
    );
    expect(facts.errorMessage).toHaveLength(PROVIDER_ERROR_MESSAGE_MAX);
    expect(facts.errorMessage).toMatch(/^Busy Busy Busy /);
    expect(facts.quotaNamed).toBe(QUOTA_METRIC);
    expect(facts.errorStatus).toBeNull();
  });

  it("a network failure keeps the cause that names why; a bare object never logs [object Object]", () => {
    expect(
      providerErrorFacts(
        new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }),
      ),
    ).toEqual({
      httpStatus: null,
      errorStatus: null,
      errorMessage: "fetch failed; cause: read ECONNRESET",
      quotaNamed: null,
    });
    expect(providerErrorFacts({ status: 500 })).toEqual({
      httpStatus: 500,
      errorStatus: null,
      errorMessage: null,
      quotaNamed: null,
    });
    expect(providerErrorFacts(undefined).errorMessage).toBeNull();
    expect(providerErrorFacts("plain words").errorMessage).toBe("plain words");
  });
});

describe("quotaNamedIn", () => {
  it("names a violation by its id when it has no metric, reads a number value, and a description's quota", () => {
    expect(
      quotaNamedIn(
        [
          {
            violations: [
              { quotaId: "GenerateRequestsPerMinute", quotaValue: 5 },
              {
                description:
                  "Quota exceeded for quota metric 'Generate content requests' and limit 'per minute'.",
              },
            ],
          },
        ],
        SHARED_POOL_MESSAGE,
      ),
    ).toBe("GenerateRequestsPerMinute, value 5; Generate content requests");
  });

  it("never names who was limited, only which quota", () => {
    expect(
      quotaNamedIn(
        [{ violations: [{ subject: "clientip:10.0.0.1" }] }],
        SHARED_POOL_MESSAGE,
      ),
    ).toBeNull();
  });

  it("reads Google's older quoted form from a message", () => {
    expect(
      quotaNamedIn(
        undefined,
        "Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'per region' of service 'aiplatform.googleapis.com'.",
      ),
    ).toBe("Generate Content API requests per minute");
    expect(quotaNamedIn(undefined, SHARED_POOL_MESSAGE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ★★ A check goes to Google's US endpoint first (TS-3D; owner's decision,
// 23 Oct 2026, 19:45 IST), and to global once when the US refuses or times
// out. Never a third try.
// ---------------------------------------------------------------------------

describe("★★ a check at the US endpoint first (TS-3D)", () => {
  const MODEL = "gemini-3.8-flash-preview";
  const check: StructuredRequest = {
    stage: "image_review",
    modelKey: "gemini-3.8-flash",
    providerModel: MODEL,
    system: "SYSTEM-MARKER",
    content: [
      { type: "text", text: "PROMPT-MARKER" },
      { type: "image", mediaType: "image/webp", base64: "AAAA" },
    ],
    schema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
    effort: "high",
  };
  const withStatus = (code: number, message = `status ${code}`) =>
    Object.assign(new Error(message), { status: code });

  /** One capacity row per location, recording each turn and what its permit
   *  was told, in order. There is no third place to ask for a row. */
  function rows() {
    const events: string[] = [];
    const at = vi.fn(
      (model: string, location: string): ProviderCapacity => ({
        run: (operation, signal) => {
          if (location !== "us" && location !== "global") {
            throw new Error(`a third try, at ${location}`);
          }
          events.push(`${location}:admit`);
          return operation({
            signal,
            succeeded: () => {
              events.push(`${location}:succeeded`);
            },
            rateLimited: async (ms) => {
              events.push(`${location}:paused:${ms}`);
            },
          });
        },
      }),
    );
    return { at, events };
  }

  function usFirst(extra: VertexClientOptions = {}) {
    const { at, events } = rows();
    const sleep = vi.fn(async () => true);
    const onRetry = vi.fn();
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      { capacityAt: at, sleep, random: () => 0.5, onRetry, ...extra },
    );
    return { client, at, events, sleep, onRetry };
  }

  /** A US answer that fails with `failure`, then global answers. */
  const usFailsThen =
    (failure: () => Promise<unknown>) => (location: string) =>
      location === "us" ? failure() : Promise.resolve(response());

  it("★★ sends a check to the US first on its own row and client, built as the priority script builds its US client", async () => {
    state.next = () => Promise.resolve(response());
    const { client, at, events, sleep, onRetry } = usFirst();
    expect(IMAGE_REVIEW_FIRST_LOCATION).toBe("us");
    const result = await client.generate(check, signal());
    expect(result).toMatchObject({
      kind: "ok",
      value: { decision: "proceed" },
    });
    expect(state.sentTo).toEqual(["us"]);
    expect(at.mock.calls).toEqual([[MODEL, "us"]]);
    expect(events).toEqual(["us:admit", "us:succeeded"]);
    expect(sleep).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    // The client's own (global, SDK retries) first, then the check's US client:
    // ADC, v1, the 600 s timeout and ONE attempt (scripts/revamp-priority-
    // test.ts `clientOptions`).
    expect(state.constructed).toHaveLength(2);
    expect(state.constructed[0]).toMatchObject({ location: "global" });
    expect(state.constructed[1]).toEqual({
      enterprise: true,
      project: "p",
      location: "us",
      apiVersion: "v1",
      httpOptions: { timeout: 600_000, retryOptions: { attempts: 1 } },
    });
    // ★ The real SDK sends that client to the US multi-region host.
    const { GoogleGenAI } =
      await vi.importActual<typeof import("@google/genai")>("@google/genai");
    const real = new GoogleGenAI(
      state.constructed[1] as ConstructorParameters<typeof GoogleGenAI>[0],
    ) as unknown as { apiClient: { getBaseUrl(): string } };
    expect(real.apiClient.getBaseUrl()).toBe(
      "https://aiplatform.us.rep.googleapis.com/",
    );
    // A second check reuses the US client.
    await client.generate(check, signal());
    expect(state.constructed).toHaveLength(2);
  });

  it("★★ prices a US answer at 1.1 times, and a global answer after a US refusal as before", async () => {
    state.next = () => Promise.resolve(response());
    const atUs = await usFirst().client.generate(check, signal());
    expect(servedLocationOf(atUs.usage)).toBe("us");
    // response(): 1,200 input (800 cached), 40 output, 300 thinking on
    // 3.8 Flash: $0.001635 at global, 1.1 times at the US.
    expect(estimateCostMicroUsd("gemini-3.8-flash", { ...atUs.usage })).toBe(
      1635,
    );
    expect(estimateCostMicroUsd("gemini-3.8-flash", atUs.usage)).toBe(1799);

    state.next = usFailsThen(() => Promise.reject(withStatus(429)));
    const atGlobal = await usFirst().client.generate(check, signal());
    expect(atGlobal.kind).toBe("ok");
    expect(servedLocationOf(atGlobal.usage)).toBe("global");
    expect(estimateCostMicroUsd("gemini-3.8-flash", atGlobal.usage)).toBe(1635);
  });

  it("★★ the check's priced review records the US price end to end (reviewThemeImage)", async () => {
    state.next = () =>
      Promise.resolve(
        response({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: '{"problems":[]}' }] },
            },
          ],
        }),
      );
    const review = await reviewThemeImage(
      usFirst().client,
      MODEL,
      {
        purpose: "hero",
        brief: { subject: "A bowl", artDirection: "", aspectRatio: "4:5" },
        candidate: "Q0FORA",
        anchor: null,
        set: null,
        attempt: 1,
      },
      signal(),
    );
    expect(review).toMatchObject({ kind: "reviewed", problems: [] });
    expect(review.estimatedCostMicroUsd).toBe(1799);
    expect(
      estimateCostMicroUsd(THEME_IMAGE_REVIEW_MODEL_KEY, { ...review.usage }),
    ).toBe(1635);
  });

  it("★★ a US 429 pauses only the US row, and the try at global takes a permit of the global row", async () => {
    const calls: string[] = [];
    const named = (key: string) =>
      key === providerCapacityKey("p", "us", MODEL)
        ? "us"
        : key === providerCapacityKey("p", "global", MODEL)
          ? "global"
          : "other";
    const store: CapacityStore = {
      async claim(key, id) {
        calls.push(`claim:${named(key)}`);
        return { id, epoch: 1 };
      },
      async renew() {
        return true;
      },
      async release(key, _lease, succeeded) {
        calls.push(`release:${named(key)}:${succeeded ? "ok" : "failed"}`);
      },
      async pause(key, delayMs) {
        calls.push(`pause:${named(key)}:${delayMs}`);
      },
    };
    state.next = usFailsThen(() =>
      Promise.reject(apiError(SHARED_POOL_BODY, 429)),
    );
    const onRetry = vi.fn();
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      {
        capacityAt: (model, location) =>
          coordinatedProviderCapacity(
            store,
            providerCapacityKey("p", location, model),
          ),
        random: () => 0.5,
        onRetry,
      },
    );
    expect(await client.generate(check, signal())).toMatchObject({
      kind: "ok",
    });
    expect(state.sentTo).toEqual(["us", "global"]);
    // ★ The US row is paused (the checks' 10 to 20 s pause, here 15 s); the
    //   global row only admits and releases its permit as a success.
    expect(calls).toEqual([
      "claim:us",
      "pause:us:15000",
      "release:us:failed",
      "claim:global",
      "release:global:ok",
    ]);
    // The refused try is counted, and the next went on at once.
    expect(onRetry.mock.calls).toEqual([
      [
        {
          stage: "image_review",
          providerModel: MODEL,
          waitMs: 0,
          location: "us",
        },
      ],
    ]);
    expect(warned("theme_studio.image_review_fallback")).toEqual([
      {
        stage: "image_review",
        model: "gemini-3.8-flash",
        from: "us",
        to: "global",
        code: "rate_limited",
        httpStatus: 429,
        errorStatus: "RESOURCE_EXHAUSTED",
        errorMessage: SHARED_POOL_MESSAGE,
        quotaNamed: null,
      },
    ]);
    // Content-free: neither the prompt nor the system text is logged.
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toMatch(/MARKER/);
  });

  it.each([
    ["a 5xx such as UNAVAILABLE", 503, "provider_unavailable"],
    ["a 500", 500, "provider_unavailable"],
    ["a 502", 502, "provider_unavailable"],
    ["a 504", 504, "provider_timeout"],
    ["a 408", 408, "provider_timeout"],
    ["an outright 403", 403, "provider_auth"],
    ["an outright 404 (the model not served there)", 404, "provider_rejected"],
  ])(
    "★ goes on to global when the US answers %s",
    async (_name, code, classified) => {
      state.next = usFailsThen(() => Promise.reject(withStatus(code)));
      const { client, at, events, onRetry } = usFirst();
      expect(await client.generate(check, signal())).toMatchObject({
        kind: "ok",
      });
      expect(state.sentTo).toEqual(["us", "global"]);
      expect(at.mock.calls).toEqual([
        [MODEL, "us"],
        [MODEL, "global"],
      ]);
      // Only a 429 pauses a row; nothing was refused at global.
      expect(events).toEqual(["us:admit", "global:admit", "global:succeeded"]);
      expect(onRetry).not.toHaveBeenCalled();
      expect(warned("theme_studio.image_review_fallback")).toEqual([
        expect.objectContaining({ from: "us", to: "global", code: classified }),
      ]);
    },
  );

  it("★ goes on to global when the US cannot be reached at all (a network failure with no answer)", async () => {
    state.next = usFailsThen(() =>
      Promise.reject(
        new TypeError("fetch failed", { cause: new Error("ENOTFOUND") }),
      ),
    );
    const { client } = usFirst();
    expect(await client.generate(check, signal())).toMatchObject({
      kind: "ok",
    });
    expect(state.sentTo).toEqual(["us", "global"]);
    expect(warned("theme_studio.image_review_fallback")).toEqual([
      expect.objectContaining({
        code: "provider_unavailable",
        httpStatus: null,
        errorMessage: "fetch failed; cause: ENOTFOUND",
      }),
    ]);
  });

  it.each([
    [
      "a 400 (a bad request is bad everywhere)",
      () => withStatus(400),
      "provider_rejected",
    ],
    ["a 422", () => withStatus(422), "provider_rejected"],
    ["a 401", () => withStatus(401), "provider_auth"],
    [
      "a credential failure",
      () => new Error("invalid_grant: reauth related error"),
      "provider_auth",
    ],
  ])(
    "never goes on from %s: it is final, at the US",
    async (_name, failure, code) => {
      state.next = usFailsThen(() => Promise.reject(failure()));
      const { client, at } = usFirst();
      expect(await client.generate(check, signal())).toMatchObject({
        kind: "error",
        code,
      });
      expect(state.sentTo).toEqual(["us"]);
      expect(at.mock.calls).toEqual([[MODEL, "us"]]);
      expect(warned("theme_studio.image_review_fallback")).toEqual([]);
      expect(warned("theme_studio.provider_error")).toEqual([
        expect.objectContaining({ code, tries: 1, location: "us" }),
      ]);
    },
  );

  it("★★ a US try that runs out its clock goes on to global, on a fresh clock of the caller's length", async () => {
    const clocks: AbortController[] = [];
    const timer = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const clock = new AbortController();
      clocks.push(clock);
      return clock.signal;
    });
    try {
      state.next = (location) =>
        location === "us" ? new Promise(() => {}) : Promise.resolve(response());
      const { client } = usFirst({ imageReviewTryTimeoutMs: 120_000 });
      const pending = client.generate(check, signal());
      await vi.waitFor(() => expect(state.sentTo).toEqual(["us"]));
      // The US try's own clock runs out.
      clocks[0].abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
      await expect(pending).resolves.toMatchObject({ kind: "ok" });
      expect(state.sentTo).toEqual(["us", "global"]);
      // ★ One clock per try, each the caller's 120 s, set when admitted.
      expect(timer.mock.calls.map((c) => c[0])).toEqual([120_000, 120_000]);
      expect(warned("theme_studio.image_review_fallback")).toEqual([
        expect.objectContaining({
          from: "us",
          to: "global",
          code: "provider_timeout",
        }),
      ]);
    } finally {
      timer.mockRestore();
    }
  });

  it("★★ a failure at global after the US is final: never a third try, and no 429 wait", async () => {
    state.next = (location) =>
      Promise.reject(
        location === "us" ? withStatus(503) : apiError(SHARED_POOL_BODY, 429),
      );
    const { client, events, sleep, onRetry } = usFirst();
    expect(await client.generate(check, signal())).toMatchObject({
      kind: "error",
      code: "rate_limited",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(state.sentTo).toEqual(["us", "global"]);
    expect(sleep).not.toHaveBeenCalled();
    // The call ends on the global 429 (in its result), so it is not "a try
    // followed by another"; the global row is paused for the others.
    expect(onRetry).not.toHaveBeenCalled();
    expect(events).toEqual(["us:admit", "global:admit", "global:paused:15000"]);
    expect(warned("theme_studio.provider_error")).toEqual([
      {
        stage: "image_review",
        model: "gemini-3.8-flash",
        code: "rate_limited",
        tries: 2,
        location: "global",
        httpStatus: 429,
        errorStatus: "RESOURCE_EXHAUSTED",
        errorMessage: SHARED_POOL_MESSAGE,
        quotaNamed: null,
      },
    ]);
  });

  it("★★ every refusal everywhere still sends exactly two requests", async () => {
    state.next = () => Promise.reject(withStatus(429));
    const { client } = usFirst();
    expect(await client.generate(check, signal())).toMatchObject({
      kind: "error",
      code: "rate_limited",
    });
    expect(state.requests).toHaveLength(2);
  });

  it("★★ the drain stops a check waiting for its turn at the US: nothing sent, and never sent to global", async () => {
    const drain = new AbortController();
    const claims: string[] = [];
    // Every row's next start is 40 s away; only a stop or the admission
    // signal ends the wait.
    const store: CapacityStore = {
      async claim(key) {
        claims.push(key);
        return { retryAfterMs: 40_000 };
      },
      async renew() {
        return true;
      },
      async release() {},
      async pause() {},
    };
    /** The redesigns' drain (photos.ts `revampDrainingCapacity`), as it
     *  wraps each location's capacity: its admission signal ends the wait,
     *  and a wait it ended reads as not sent (an AbortError). */
    const drained = (capacity: ProviderCapacity): ProviderCapacity => ({
      run: async (operation, runSignal) => {
        try {
          return await capacity.run(
            async (permit) => {
              if (drain.signal.aborted) throw notSent();
              return operation(permit);
            },
            runSignal,
            { admission: drain.signal },
          );
        } catch (error) {
          if (drain.signal.aborted && !runSignal.aborted) throw notSent();
          throw error;
        }
      },
    });
    const notSent = () =>
      Object.assign(new Error("Not sent: the deadline."), {
        name: "AbortError",
      });
    const at = vi.fn((model: string, location: string) =>
      drained(
        coordinatedProviderCapacity(
          store,
          providerCapacityKey("p", location, model),
        ),
      ),
    );
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      { capacityAt: at },
    );
    const pending = client.generate(check, signal());
    await vi.waitFor(() => expect(claims).toHaveLength(1));
    drain.abort(new Error("revamp halted: deadline"));
    await expect(pending).resolves.toMatchObject({
      kind: "error",
      code: "cancelled",
    });
    expect(claims).toEqual([providerCapacityKey("p", "us", MODEL)]);
    expect(at.mock.calls).toEqual([[MODEL, "us"]]);
    expect(state.requests).toEqual([]);
    // A stop is ours: no fallback, no provider error.
    expect(warned("theme_studio.image_review_fallback")).toEqual([]);
    expect(warned("theme_studio.provider_error")).toEqual([]);
  });

  it.each([
    ["an abort", undefined],
    // ★ The redesigns stop a check whose budget ran out with a reason of
    //   their own, which names no abort: still the caller's stop.
    ["its own reason", new Error("the photo's budget ran out")],
  ])(
    "a caller's stop during the US try (%s) is final and quiet",
    async (_name, reason) => {
      const outer = new AbortController();
      state.next = () => {
        outer.abort(reason);
        return new Promise(() => {});
      };
      const { client, at } = usFirst();
      expect(await client.generate(check, outer.signal)).toMatchObject({
        kind: "error",
        code: "cancelled",
      });
      expect(state.sentTo).toEqual(["us"]);
      expect(at.mock.calls).toEqual([[MODEL, "us"]]);
      expect(warned("theme_studio.provider_error")).toEqual([]);
      expect(warned("theme_studio.image_review_fallback")).toEqual([]);
    },
  );

  it("a US row that cannot give a turn (its store failed) sent nothing to refuse: final, never sent to global", async () => {
    const at = vi.fn(
      (): ProviderCapacity => ({
        run: async () => {
          throw new Error("Connection terminated due to connection timeout");
        },
      }),
    );
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      { capacityAt: at },
    );
    expect(await client.generate(check, signal())).toMatchObject({
      kind: "error",
      code: "provider_unavailable",
    });
    expect(state.requests).toEqual([]);
    expect(at).toHaveBeenCalledTimes(1);
    expect(warned("theme_studio.provider_error")).toEqual([
      expect.objectContaining({ tries: 1, location: "us" }),
    ]);
  });

  it("a permit lost during the US try is no refusal by the US: final, never sent to global", async () => {
    const lost = new AbortController();
    const at = vi.fn(
      (): ProviderCapacity => ({
        run: (operation, runSignal) =>
          operation({
            signal: AbortSignal.any([runSignal, lost.signal]),
            succeeded() {},
            async rateLimited() {},
          }),
      }),
    );
    state.next = () => {
      lost.abort(new ProviderCapacityLost());
      return new Promise(() => {});
    };
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      { capacityAt: at },
    );
    expect(await client.generate(check, signal())).toMatchObject({
      kind: "error",
      code: "provider_unavailable",
    });
    expect(state.sentTo).toEqual(["us"]);
    expect(at).toHaveBeenCalledTimes(1);
  });

  it("an answer the US gave is the answer: a refusal, a truncation or bad JSON never goes on", async () => {
    for (const answer of [
      response({
        candidates: [],
        promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
      }),
      response({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
      response({
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: "not json" }] } },
        ],
      }),
    ]) {
      state.sentTo = [];
      state.next = () => Promise.resolve(answer);
      const result = await usFirst().client.generate(check, signal());
      expect(result.kind).not.toBe("ok");
      expect(result.kind).not.toBe("error");
      expect(state.sentTo).toEqual(["us"]);
    }
    // An unexplained stop says where it was served.
    state.next = () =>
      Promise.resolve(response({ candidates: [{ finishReason: "OTHER" }] }));
    await usFirst().client.generate(check, signal());
    expect(warned("theme_studio.unexpected_finish_reason")).toEqual([
      {
        stage: "image_review",
        model: "gemini-3.8-flash",
        finishReason: "OTHER",
        candidates: 1,
        location: "us",
      },
    ]);
  });

  it("a cooldown that cannot be written still goes on to global, and says where", async () => {
    state.next = usFailsThen(() => Promise.reject(withStatus(429)));
    const at = vi.fn(
      (model: string, location: string): ProviderCapacity => ({
        run: (operation, runSignal) =>
          operation({
            signal: runSignal,
            succeeded() {},
            rateLimited: async () => {
              if (location === "us") throw new Error("DB timeout");
            },
          }),
      }),
    );
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      {
        capacityAt: at,
        onRetry: () => {
          throw new Error("counter broke");
        },
      },
    );
    expect(await client.generate(check, signal())).toMatchObject({
      kind: "ok",
    });
    expect(warned("theme_studio.shared_cooldown_failed")).toEqual([
      { stage: "image_review", model: "gemini-3.8-flash", location: "us" },
    ]);
  });

  it("★★ sends the same request bytes to the US and to global, and the same as a one-location client: Theme Studio's review text unchanged", async () => {
    const GOLDEN = JSON.parse(
      readFileSync(join(__dirname, "image-prompt.golden.json"), "utf8"),
    ) as { reviewSystem: string; reviewContents: Record<string, unknown> };
    const input = {
      purpose: "category" as const,
      brief: {
        id: "category-bowls",
        purpose: "the photograph for the bowls category",
        subject: "Three nesting bowls in oat and olive glazes",
        artDirection: "",
        aspectRatio: "1:1",
      },
      candidate: "Q0FORA",
      anchor: null,
      set: null,
      attempt: 1,
    };
    // The golden capture of Theme Studio's check text (image-review.test.ts).
    expect(themeImageReviewSystem()).toBe(GOLDEN.reviewSystem);
    expect(JSON.stringify(themeImageReviewContent(input))).toBe(
      JSON.stringify(GOLDEN.reviewContents.categoryNoAnchor),
    );
    const answer = response({
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: '{"problems":[]}' }] },
        },
      ],
    });
    // Refused at the US, answered at global.
    state.next = usFailsThen(() => Promise.reject(withStatus(503)));
    const original = state.next;
    state.next = (location) =>
      location === "us" ? original(location) : Promise.resolve(answer);
    await reviewThemeImage(usFirst().client, MODEL, input, signal());
    // The same check from a client with one location.
    state.next = () => Promise.resolve(answer);
    await reviewThemeImage(
      createVertexModelClient({ projectId: "p", region: "global" }),
      MODEL,
      input,
      signal(),
    );
    expect(state.sentTo).toEqual(["us", "global", "global"]);
    const bytes = state.requests.map((sent) => {
      const { abortSignal, ...config } = sent.config as Record<string, unknown>;
      expect(abortSignal).toBeInstanceOf(AbortSignal);
      return JSON.stringify({ ...sent, config });
    });
    expect(bytes[0]).toBe(bytes[1]);
    expect(bytes[1]).toBe(bytes[2]);
    const sent = state.requests[0] as {
      contents: { parts: { text?: string }[] }[];
      config: { systemInstruction: string };
    };
    expect(sent.config.systemInstruction).toBe(GOLDEN.reviewSystem);
    expect(
      sent.contents[0].parts.filter((part) => part.text !== undefined),
    ).toEqual(
      (
        GOLDEN.reviewContents.categoryNoAnchor as {
          type: string;
          text?: string;
        }[]
      )
        .filter((block) => block.type === "text")
        .map((block) => ({ text: block.text })),
    );
  });
});

describe("a client without capacityAt keeps its one location (TS-3D)", () => {
  const check: StructuredRequest = {
    ...request,
    stage: "image_review",
    modelKey: "gemini-3.8-flash",
    providerModel: "gemini-3.8-flash-preview",
  };

  it("★ a check's 429 is waited out and asked again at the same place, on the one capacity it was given", async () => {
    let calls = 0;
    state.next = () =>
      ++calls === 1
        ? Promise.reject(Object.assign(new Error("x"), { status: 429 }))
        : Promise.resolve(response());
    const scope = vi.fn(
      (model: string): ProviderCapacity => ({
        run: (operation, runSignal) => {
          void model;
          return operation({
            signal: runSignal,
            succeeded() {},
            async rateLimited() {},
          });
        },
      }),
    );
    const sleep = vi.fn(async (ms: number) => {
      void ms;
      return true;
    });
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      { capacity: scope, sleep, random: () => 0 },
    );
    expect(await client.generate(check, signal())).toMatchObject({
      kind: "ok",
    });
    expect(state.sentTo).toEqual(["global", "global"]);
    expect(state.constructed).toHaveLength(1);
    expect(scope.mock.calls).toEqual([["gemini-3.8-flash-preview"]]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10_000]);
    // Its log lines stay as they were: no location.
    expect(warned("theme_studio.rate_limited_retry")).toEqual([
      expect.not.objectContaining({ location: expect.anything() }),
    ]);
    // ★ Priced at global, where its client sends everything.
    const answered = await client.generate(check, signal());
    expect(servedLocationOf(answered.usage)).toBe("global");
    expect(estimateCostMicroUsd("gemini-3.8-flash", answered.usage)).toBe(1635);
  });

  it("★ every other stage of a client given capacityAt stays at its own location, on that location's row", async () => {
    state.next = () => Promise.resolve(response());
    const at = vi.fn(
      (): ProviderCapacity => ({
        run: (operation, runSignal) =>
          operation({
            signal: runSignal,
            succeeded() {},
            async rateLimited() {},
          }),
      }),
    );
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      {
        capacityAt: at,
        capacity: () => {
          throw new Error("capacityAt takes the place of capacity");
        },
      },
    );
    for (const stage of ["intent", "draft", "visual_qa"] as const) {
      expect(
        await client.generate({ ...request, stage }, signal()),
      ).toMatchObject({ kind: "ok" });
    }
    expect(state.sentTo).toEqual(["global", "global", "global"]);
    expect(at.mock.calls).toEqual([
      ["gemini-3.1-pro-preview", "global"],
      ["gemini-3.1-pro-preview", "global"],
      ["gemini-3.1-pro-preview", "global"],
    ]);
    // Only the client's own SDK client: no US client is made.
    expect(state.constructed).toHaveLength(1);
  });

  it("★ a client already at the US has nowhere else to go: today's waits, on the US row", async () => {
    let calls = 0;
    state.next = () =>
      ++calls === 1
        ? Promise.reject(Object.assign(new Error("x"), { status: 429 }))
        : Promise.resolve(response());
    const at = vi.fn(
      (): ProviderCapacity => ({
        run: (operation, runSignal) =>
          operation({
            signal: runSignal,
            succeeded() {},
            async rateLimited() {},
          }),
      }),
    );
    const sleep = vi.fn(async () => true);
    const client = createVertexModelClient(
      { projectId: "p", region: "us" },
      { capacityAt: at, sleep, random: () => 0 },
    );
    const result = await client.generate(check, signal());
    expect(result).toMatchObject({ kind: "ok" });
    expect(state.sentTo).toEqual(["us", "us"]);
    expect(at.mock.calls).toEqual([["gemini-3.8-flash-preview", "us"]]);
    expect(sleep).toHaveBeenCalledOnce();
    expect(servedLocationOf(result.usage)).toBe("us");
  });

  it("★ the check clock is 75 s unless the caller sets a usable one, and never longer than the client's own timeout", async () => {
    const timer = vi.spyOn(AbortSignal, "timeout");
    try {
      state.next = () => Promise.resolve(response());
      for (const [given, used] of [
        [undefined, IMAGE_REVIEW_TRY_TIMEOUT_MS],
        [120_000, 120_000],
        [Number.NaN, IMAGE_REVIEW_TRY_TIMEOUT_MS],
        [0, IMAGE_REVIEW_TRY_TIMEOUT_MS],
        [-5, IMAGE_REVIEW_TRY_TIMEOUT_MS],
        [Number.POSITIVE_INFINITY, IMAGE_REVIEW_TRY_TIMEOUT_MS],
        [900_000, 600_000],
      ] as const) {
        timer.mockClear();
        const client = createVertexModelClient(
          { projectId: "p", region: "global" },
          given === undefined ? {} : { imageReviewTryTimeoutMs: given },
        );
        await client.generate(check, signal());
        expect(
          timer.mock.calls.map((c) => c[0]),
          String(given),
        ).toEqual([used]);
      }
    } finally {
      timer.mockRestore();
    }
  });
});
