/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock ADC token minting so the Vertex AI path can be tested without real
// Google Cloud credentials. GoogleAuth is a plain class so it survives the
// other suites' restoreAllMocks; the token fn is re-armed per test.
const { mockGetAccessToken } = vi.hoisted(() => ({
  mockGetAccessToken: vi.fn(async () => ({ token: "vertex-token" })),
}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getClient() {
      return Promise.resolve({ getAccessToken: mockGetAccessToken });
    }
  },
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AI_UNUSABLE_MESSAGE,
  DEFAULT_GEMINI_FALLBACK_MODEL,
  DEFAULT_GEMINI_MODEL,
  GEMINI_ATTEMPT_TIMEOUT_MS,
  AI_PROMPT_FIELD_MAX,
  NO_LONG_DASH_RULE,
  THINKING_HEADROOM_TOKENS,
  brandSystemText,
  callGemini,
  geminiModels,
  promptText,
  vertexHost,
  withoutNothingChargedClaim,
} from "./gemini";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";

/** A fetch Response; only `ok`, `status` and `text()` are read. */
function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const okReply = (text: string, finishReason = "STOP") =>
  reply(200, {
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 12,
      totalTokenCount: 172,
    },
  });

const googleError = (status: number, googleStatus: string, message: string) =>
  reply(status, { error: { code: status, status: googleStatus, message } });

/** A fetch that never answers, and rejects once its signal aborts. */
function hangingFetch(_url: string, init: { signal: AbortSignal }) {
  return new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener("abort", () =>
      reject(new DOMException("This operation was aborted", "AbortError")),
    );
  });
}

const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;
const urlOf = (call: number) => fetchMock().mock.calls[call][0] as string;
const bodyOf = (call: number) =>
  JSON.parse(fetchMock().mock.calls[call][1].body as string);

/** Everything logged, as one string, to prove what never reaches a log. */
const everythingLogged = () =>
  JSON.stringify([
    vi.mocked(logInfo).mock.calls,
    vi.mocked(logWarn).mock.calls,
    vi.mocked(logError).mock.calls,
  ]);

describe("brandSystemText", () => {
  it("embeds the brand text and appends the brand's soul instruction", () => {
    const brand = "We are WholeSip.";
    const out = brandSystemText(brand);
    expect(out).toContain(brand);
    expect(out).toContain("The text above is the brand's soul");
    expect(out).toContain("You ARE this brand speaking.");
    expect(out.indexOf(brand)).toBeLessThan(out.indexOf("brand's soul"));
  });
});

describe("the merchant-facing messages", () => {
  // The owner's wording (2026-10-23), exactly.
  it("reads exactly as decided", () => {
    expect(AI_BUSY_MESSAGE).toBe(
      "AI is busy right now. Nothing was charged; try again in a minute.",
    );
    expect(AI_UNAVAILABLE_MESSAGE).toBe(
      "AI isn't available right now. Nothing was charged.",
    );
  });

  it("never blames a quota and never uses a long dash", () => {
    for (const message of [
      AI_BUSY_MESSAGE,
      AI_UNAVAILABLE_MESSAGE,
      AI_UNUSABLE_MESSAGE,
    ]) {
      expect(message).not.toMatch(/quota/i);
      expect(message).not.toMatch(/[–—]/);
      expect(message).toContain("Nothing was charged");
    }
  });
});

describe("geminiModels", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 3.5 Flash-Lite with 3.5 Flash as its fallback", () => {
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("GEMINI_FALLBACK_MODEL", "");
    expect(geminiModels()).toEqual({
      main: "gemini-3.5-flash-lite",
      fallback: "gemini-3.5-flash",
    });
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-3.5-flash-lite");
    expect(DEFAULT_GEMINI_FALLBACK_MODEL).toBe("gemini-3.5-flash");
  });

  it("lets an override pin a version of the same family", () => {
    vi.stubEnv("GEMINI_MODEL", " Gemini-3.5-Flash-Lite-001 ");
    vi.stubEnv("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash-preview-09-2026");
    expect(geminiModels()).toEqual({
      main: "gemini-3.5-flash-lite-001",
      fallback: "gemini-3.5-flash-preview-09-2026",
    });
  });

  // ★ The B2 case among them: a .env that still says gemini-2.5-flash.
  it.each([
    "gemini-2.5-flash",
    "gemini-3.5-flash",
    "gemini-3.8-flash-lite-tts",
    "gemini-3.5-flash-lite-image",
    "gemini-3.1-pro-preview",
    "claude-opus",
  ])("refuses %s as the main model", (value) => {
    vi.stubEnv("GEMINI_MODEL", value);
    expect(geminiModels().main).toBe(DEFAULT_GEMINI_MODEL);
  });

  it.each([
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-image",
    "gemini-3.5-flash-tts",
    "gemini-3.1-pro",
    "off",
  ])("refuses %s as the fallback", (value) => {
    vi.stubEnv("GEMINI_FALLBACK_MODEL", value);
    expect(geminiModels().fallback).toBe(DEFAULT_GEMINI_FALLBACK_MODEL);
  });

  it("says once that a refused override is ignored", () => {
    vi.stubEnv("GEMINI_MODEL", "gemini-2.0-flash-once");
    geminiModels();
    geminiModels();
    const warnings = vi
      .mocked(logWarn)
      .mock.calls.filter(([message]) => message.includes("override ignored"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toMatchObject({
      variable: "GEMINI_MODEL",
      model: "gemini-2.0-flash-once",
      using: DEFAULT_GEMINI_MODEL,
    });
  });
});

describe("vertexHost", () => {
  // The rule @google/genai applies: global, a multi-region, a region.
  it("is right for global, a multi-region and a region", () => {
    expect(vertexHost("global")).toBe("aiplatform.googleapis.com");
    expect(vertexHost("asia-south1")).toBe(
      "asia-south1-aiplatform.googleapis.com",
    );
    expect(vertexHost("us")).toBe("aiplatform.us.rep.googleapis.com");
    expect(vertexHost("eu")).toBe("aiplatform.eu.rep.googleapis.com");
  });
});

describe("callGemini (Gemini Developer API)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    // Pin this suite to the Developer API path regardless of a local .env.
    vi.stubEnv("GCP_PROJECT_ID", "");
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("GEMINI_FALLBACK_MODEL", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("sends LOW thinking, the answer's budget plus headroom, and the dash rule", async () => {
    fetchMock().mockResolvedValue(okReply("  hello  "));

    const result = await callGemini("system prompt", "user prompt");
    expect(result).toEqual({ text: "hello" });
    expect(fetch).toHaveBeenCalledTimes(1);

    expect(urlOf(0)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    const init = fetchMock().mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = bodyOf(0);
    expect(body.systemInstruction.parts[0].text).toBe(
      `system prompt\n\n${NO_LONG_DASH_RULE}`,
    );
    expect(body.contents[0]).toEqual({
      role: "user",
      parts: [{ text: "user prompt" }],
    });
    expect(body.generationConfig.temperature).toBe(0.7);
    // ★ The REST form of conversation-namer's ThinkingLevel.LOW, and no
    // 2.5-only thinkingBudget.
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "LOW",
    });
    expect(JSON.stringify(body)).not.toContain("thinkingBudget");
    expect(body.generationConfig.maxOutputTokens).toBe(
      1024 + THINKING_HEADROOM_TOKENS,
    );
    expect(body.generationConfig.responseMimeType).toBeUndefined();
    expect(body.generationConfig.responseJsonSchema).toBeUndefined();
    expect(logInfo).toHaveBeenCalledWith(
      "ai.generate: ok",
      expect.objectContaining({
        backend: "developer",
        model: "gemini-3.5-flash-lite",
        attempts: 1,
        promptTokens: 120,
        outputTokens: 40,
        thoughtTokens: 12,
      }),
    );
  });

  it("honours a caller's temperature and answer budget", async () => {
    fetchMock().mockResolvedValue(okReply("ok"));
    await callGemini("s", "u", { temperature: 0.2, maxOutputTokens: 256 });
    const body = bodyOf(0);
    expect(body.generationConfig.temperature).toBe(0.2);
    expect(body.generationConfig.maxOutputTokens).toBe(
      256 + THINKING_HEADROOM_TOKENS,
    );
  });

  // The field lib/mink and lib/theme-studio send live; never responseSchema.
  it("sends a JSON schema as responseJsonSchema", async () => {
    fetchMock().mockResolvedValue(okReply('{"name":"x"}'));
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    };
    await callGemini("s", "u", {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    });
    const config = bodyOf(0).generationConfig;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toEqual(schema);
    expect(config.responseSchema).toBeUndefined();
  });

  it("rewrites a long dash the model wrote anyway", async () => {
    fetchMock().mockResolvedValue(
      okReply("Rich and creamy — made for mornings. Serves 2–4."),
    );
    expect(await callGemini("s", "u")).toEqual({
      text: "Rich and creamy, made for mornings. Serves 2 to 4.",
    });
  });

  it("leaves dash-free text exactly as the model wrote it", async () => {
    fetchMock().mockResolvedValue(okReply("Hello, . world"));
    expect(await callGemini("s", "u")).toEqual({ text: "Hello, . world" });
  });

  it("joins the answer's parts and never returns a thought", async () => {
    fetchMock().mockResolvedValue(
      reply(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: "I should mention the almonds.", thought: true },
                { text: "foo" },
                { text: "bar" },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
    );
    expect(await callGemini("s", "u")).toEqual({ text: "foobar" });
  });

  // ★ Each of these sends the call once more, on the fallback model.
  it.each([
    ["a 429", () => googleError(429, "RESOURCE_EXHAUSTED", "busy")],
    ["a 503", () => googleError(503, "UNAVAILABLE", "overloaded")],
    ["a 500", () => googleError(500, "INTERNAL", "oops")],
    ["a 408", () => reply(408, "timeout")],
  ])("asks the fallback after %s", async (_label, first) => {
    fetchMock()
      .mockResolvedValueOnce(first())
      .mockResolvedValueOnce(okReply("recovered"));

    expect(await callGemini("s", "u")).toEqual({ text: "recovered" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(urlOf(1)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    );
    // The same request, only the model differs.
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(logWarn).toHaveBeenCalledWith(
      "ai.generate: main model failed, asking the fallback",
      expect.objectContaining({ model: "gemini-3.5-flash-lite" }),
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it("asks the fallback after a dropped connection", async () => {
    fetchMock()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okReply("recovered"));
    expect(await callGemini("s", "u")).toEqual({ text: "recovered" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up on a silent main model after 30 s and asks the fallback", async () => {
    vi.useFakeTimers();
    fetchMock()
      .mockImplementationOnce(hangingFetch)
      .mockResolvedValueOnce(okReply("recovered"));

    const pending = callGemini("s", "u");
    await vi.advanceTimersByTimeAsync(GEMINI_ATTEMPT_TIMEOUT_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ text: "recovered" });
    expect(fetch).toHaveBeenCalledTimes(2);
    // The abandoned request was told to stop.
    expect(fetchMock().mock.calls[0][1].signal.aborted).toBe(true);
    expect(GEMINI_ATTEMPT_TIMEOUT_MS).toBe(30_000);
  });

  // ★ The deadline is a race as well as an abort: a request that ignores its
  // signal still ends on time.
  it("ends the attempt on time even when the request ignores the abort", async () => {
    vi.useFakeTimers();
    fetchMock()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockResolvedValueOnce(okReply("recovered"));

    const pending = callGemini("s", "u");
    await vi.advanceTimersByTimeAsync(GEMINI_ATTEMPT_TIMEOUT_MS);
    expect(await pending).toEqual({ text: "recovered" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // ★ A retired or misconfigured main model must not take the feature down,
  // and must not go unnoticed either.
  it.each([404, 400, 403])(
    "asks the fallback after a %s on the main model, and logs it as an error",
    async (status) => {
      fetchMock()
        .mockResolvedValueOnce(
          googleError(status, "NOT_FOUND", "Publisher model was not found"),
        )
        .mockResolvedValueOnce(okReply("recovered"));

      expect(await callGemini("s", "u")).toEqual({ text: "recovered" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(urlOf(1)).toContain("/models/gemini-3.5-flash:generateContent");
      expect(logError).toHaveBeenCalledWith(
        "ai.generate: main model refused",
        undefined,
        expect.objectContaining({
          model: "gemini-3.5-flash-lite",
          status,
          googleStatus: "NOT_FOUND",
          message: "Publisher model was not found",
        }),
      );
    },
  );

  it("takes the fallback's 400 as final", async () => {
    fetchMock()
      .mockResolvedValueOnce(googleError(429, "RESOURCE_EXHAUSTED", "busy"))
      .mockResolvedValueOnce(googleError(400, "INVALID_ARGUMENT", "bad"));

    // Google was busy on the main model, so waiting a minute may help.
    expect(await callGemini("s", "u")).toEqual({ error: AI_BUSY_MESSAGE });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a configuration problem when both models refuse", async () => {
    fetchMock()
      .mockResolvedValueOnce(googleError(404, "NOT_FOUND", "no such model"))
      .mockResolvedValueOnce(googleError(400, "INVALID_ARGUMENT", "bad"));

    expect(await callGemini("s", "u")).toEqual({
      error: AI_UNAVAILABLE_MESSAGE,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is busy when both pools are", async () => {
    fetchMock().mockResolvedValue(
      googleError(429, "RESOURCE_EXHAUSTED", "Resource exhausted"),
    );
    expect(await callGemini("s", "u")).toEqual({ error: AI_BUSY_MESSAGE });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is busy when both models are silent, after about a minute", async () => {
    vi.useFakeTimers();
    fetchMock().mockImplementation(hangingFetch);
    const pending = callGemini("s", "u");
    await vi.advanceTimersByTimeAsync(2 * GEMINI_ATTEMPT_TIMEOUT_MS);
    expect(await pending).toEqual({ error: AI_BUSY_MESSAGE });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401: the fallback has the same credentials", async () => {
    fetchMock().mockResolvedValue(
      googleError(401, "UNAUTHENTICATED", "API key not valid"),
    );
    expect(await callGemini("s", "u")).toEqual({
      error: AI_UNAVAILABLE_MESSAGE,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an empty reply", () => okReply("   ")],
    ["no candidates", () => reply(200, {})],
    ["a reply cut short", () => okReply("Half a descrip", "MAX_TOKENS")],
    ["a safety stop", () => okReply("Something", "SAFETY")],
    [
      "a blocked prompt",
      () => reply(200, { promptFeedback: { blockReason: "SAFETY" } }),
    ],
    ["an unreadable body", () => reply(200, "<html>not json</html>")],
  ])("takes %s as unusable, with no second attempt", async (_label, make) => {
    fetchMock().mockResolvedValue(make());
    expect(await callGemini("s", "u")).toEqual({ error: AI_UNUSABLE_MESSAGE });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops at once, with no fallback, when the caller aborts", async () => {
    const controller = new AbortController();
    fetchMock().mockImplementation(hangingFetch);
    const pending = callGemini("s", "u", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect(await pending).toEqual({ error: AI_BUSY_MESSAGE });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("does not call Google for a caller that has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await callGemini("s", "u", { signal: controller.signal })).toEqual({
      error: AI_BUSY_MESSAGE,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  // ★ The detail goes to logError, never the merchant, and never the words.
  it("logs Google's status and message, cut to 500 characters, and no content", async () => {
    const long = "x".repeat(900);
    fetchMock().mockResolvedValue(googleError(429, "RESOURCE_EXHAUSTED", long));

    const result = await callGemini("SECRET-SYSTEM", "SECRET-PROMPT");
    expect(result).toEqual({ error: AI_BUSY_MESSAGE });

    const failed = vi
      .mocked(logError)
      .mock.calls.find(([message]) => message === "ai.generate: failed");
    expect(failed).toBeDefined();
    const attempts = (failed![2] as any).attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      role: "main",
      model: "gemini-3.5-flash-lite",
      location: "developer-api",
      kind: "busy",
      status: 429,
      googleStatus: "RESOURCE_EXHAUSTED",
    });
    expect(attempts[0].message).toHaveLength(500);
    expect(attempts[1]).toMatchObject({
      role: "fallback",
      model: "gemini-3.5-flash",
    });
    expect(everythingLogged()).not.toContain("SECRET-PROMPT");
    expect(everythingLogged()).not.toContain("SECRET-SYSTEM");
    expect(everythingLogged()).not.toContain("test-key");
  });

  it("reports a configuration problem when no backend is configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(await callGemini("s", "u")).toEqual({
      error: AI_UNAVAILABLE_MESSAGE,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a pinned model version", async () => {
    vi.stubEnv("GEMINI_MODEL", "gemini-3.5-flash-lite-001");
    fetchMock().mockResolvedValue(okReply("ok"));
    await callGemini("s", "u");
    expect(urlOf(0)).toContain(
      "/models/gemini-3.5-flash-lite-001:generateContent",
    );
  });
});

describe("callGemini (Vertex AI)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    // A configured GCP project and no API key switches the backend to Vertex.
    vi.stubEnv("GCP_PROJECT_ID", "my-project");
    vi.stubEnv("GCP_LOCATION", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("GEMINI_FALLBACK_MODEL", "");
    vi.stubEnv("MINK_FALLBACK_LOCATION", "");
    mockGetAccessToken.mockResolvedValue({ token: "vertex-token" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("asks the main model at the global host with a bearer token", async () => {
    fetchMock().mockResolvedValue(okReply("hi"));
    expect(await callGemini("sys", "user")).toEqual({ text: "hi" });

    expect(urlOf(0)).toBe(
      "https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/google/models/gemini-3.5-flash-lite:generateContent",
    );
    const init = fetchMock().mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer vertex-token");
    expect(init.headers["x-goog-api-key"]).toBeUndefined();
    // The request body is the Developer API's, LOW thinking included.
    const body = bodyOf(0);
    expect(body.systemInstruction.parts[0].text).toBe(
      `sys\n\n${NO_LONG_DASH_RULE}`,
    );
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "LOW",
    });
  });

  // ★ The Mink chat's fallback target: 3.5 Flash in Mumbai.
  it("asks the fallback at the Mink fallback location", async () => {
    fetchMock()
      .mockResolvedValueOnce(googleError(429, "RESOURCE_EXHAUSTED", "busy"))
      .mockResolvedValueOnce(okReply("recovered"));

    expect(await callGemini("s", "u")).toEqual({ text: "recovered" });
    expect(urlOf(1)).toBe(
      "https://asia-south1-aiplatform.googleapis.com/v1/projects/my-project/locations/asia-south1/publishers/google/models/gemini-3.5-flash:generateContent",
    );
    expect(logInfo).toHaveBeenCalledWith(
      "ai.generate: ok",
      expect.objectContaining({
        backend: "vertex",
        model: "gemini-3.5-flash",
        location: "asia-south1",
        attempts: 2,
      }),
    );
  });

  // One setting moves the chat's fallback and this one together.
  it("follows MINK_FALLBACK_LOCATION", async () => {
    vi.stubEnv("MINK_FALLBACK_LOCATION", "asia-south2");
    fetchMock()
      .mockResolvedValueOnce(googleError(503, "UNAVAILABLE", "busy"))
      .mockResolvedValueOnce(okReply("recovered"));
    await callGemini("s", "u");
    expect(urlOf(1)).toBe(
      "https://asia-south2-aiplatform.googleapis.com/v1/projects/my-project/locations/asia-south2/publishers/google/models/gemini-3.5-flash:generateContent",
    );
  });

  it("asks the main model in its region when GCP_LOCATION names one", async () => {
    vi.stubEnv("GCP_LOCATION", "asia-south1");
    fetchMock().mockResolvedValue(okReply("hi"));
    await callGemini("s", "u");
    expect(urlOf(0)).toBe(
      "https://asia-south1-aiplatform.googleapis.com/v1/projects/my-project/locations/asia-south1/publishers/google/models/gemini-3.5-flash-lite:generateContent",
    );
  });

  it("reports a configuration problem, without calling Google, when ADC is missing", async () => {
    mockGetAccessToken.mockRejectedValue(new Error("no ADC"));
    expect(await callGemini("s", "u")).toEqual({
      error: AI_UNAVAILABLE_MESSAGE,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prefers the free Developer API key when BOTH it and GCP_PROJECT_ID are set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "free-key");
    fetchMock().mockResolvedValue(okReply("hi"));

    expect(await callGemini("sys", "user")).toEqual({ text: "hi" });
    expect(urlOf(0)).toContain("generativelanguage.googleapis.com");
    const init = fetchMock().mock.calls[0][1];
    expect(init.headers["x-goog-api-key"]).toBe("free-key");
    expect(init.headers.Authorization).toBeUndefined();
    expect(mockGetAccessToken).not.toHaveBeenCalled();
  });
});

// ★ What the merchant reads when the credit could not be given back: the
// same sentence, without the claim that nothing was charged.
describe("withoutNothingChargedClaim", () => {
  it.each([AI_BUSY_MESSAGE, AI_UNAVAILABLE_MESSAGE, AI_UNUSABLE_MESSAGE])(
    "takes the claim out of %j",
    (message) => {
      expect(message).toMatch(/Nothing was charged/);
      const honest = withoutNothingChargedClaim(message);
      expect(honest).not.toMatch(/charged|credit|\u2014|\u2013/i);
      expect(honest.length).toBeGreaterThan(10);
    },
  );

  it("leaves any other message as it is", () => {
    expect(withoutNothingChargedClaim("Add a product name first.")).toBe(
      "Add a product name first.",
    );
  });
});

// ★★ What a merchant's field may carry into a prompt: bounded on the server,
// because a server action is reachable without its form.
describe("promptText", () => {
  it("trims, and cuts to the bound", () => {
    expect(promptText("  almonds  ")).toBe("almonds");
    expect(promptText("x".repeat(AI_PROMPT_FIELD_MAX + 50))).toHaveLength(
      AI_PROMPT_FIELD_MAX,
    );
    expect(promptText("abcdef", 3)).toBe("abc");
  });

  it("reads anything that is not text as nothing", () => {
    expect(promptText(undefined)).toBe("");
    expect(promptText(null)).toBe("");
    expect(promptText(42)).toBe("");
    expect(promptText({ toString: () => "x" })).toBe("");
  });

  it("never ends on half an emoji", () => {
    // "ab" then an emoji (two UTF-16 units): a cut at 3 would split it.
    expect(promptText("ab\u{1F600}cd", 3)).toBe("ab");
  });
});
