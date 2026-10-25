// ---------------------------------------------------------------------------
// The retry rule in front of the one model call: a busy main model (a 429, a
// 5xx or a stall) is asked once more, then the Mink fallback once, then the
// chat goes to a person; a refusal of the request itself is final at once.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: vi.fn(),
  generate: vi.fn(),
  genaiConstructed: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@google/genai", () => ({
  ThinkingLevel: { LOW: "LOW", HIGH: "HIGH" },
  GoogleGenAI: class {
    constructor(options: unknown) {
      h.genaiConstructed(options);
    }
  },
}));
vi.mock("@/lib/mink/vertex-clients", () => ({ minkVertexClient: h.client }));
vi.mock("@/lib/mink/whatsapp-prompt", () => ({
  renderMinkWhatsAppPrompt: () => "SYSTEM INSTRUCTION",
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: h.logWarn,
  logError: h.logError,
}));

import type { MinkConfig } from "@/lib/mink/config";
import {
  MINK_WHATSAPP_MODEL_ATTEMPTS,
  MINK_WHATSAPP_RETRY_DELAY_MS,
  MinkWhatsAppModelStalled,
  callMinkWhatsAppModel,
  callMinkWhatsAppModelWithRetry,
  isModelStall,
  type MinkWhatsAppModelInput,
  type MinkWhatsAppModelResult,
} from "./mink-model";

const config = { projectId: "p", location: "global", model: "m" } as MinkConfig;
/** The deployed shape: the Mink fallback in Mumbai (lib/mink/config.ts). */
const withFallback = {
  ...config,
  model: "gemini-3.7-flash",
  fallbackModel: "gemini-3.5-flash",
  fallbackLocation: "asia-south1",
} as MinkConfig;
const input = {
  facts: {
    store: { name: "Echoss", url: null, email: null },
    hours: null,
    orders: [],
    products: [],
    delivery: null,
    offers: [],
    policies: [],
    recent: [],
  },
  message: "hi",
  now: new Date("2026-10-14T06:30:00Z"),
  timeZone: "Asia/Kolkata",
} satisfies MinkWhatsAppModelInput;

const answered: MinkWhatsAppModelResult = {
  parsed: { outcome: "answer", reply: "ok", reason: "" },
  finishReason: "STOP",
  model: "m",
  inputTokens: 1,
  outputTokens: 1,
};

/** A call that never answers: it rejects only when its budget fires, the way
 *  the SDK does, wrapping the abort in a plain Error as seen live. */
const stall = () =>
  vi.fn(
    (_c: MinkConfig, _i: MinkWhatsAppModelInput, signal?: AbortSignal) =>
      new Promise<MinkWhatsAppModelResult>((_, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new Error("This operation was aborted")),
        );
      }),
  );
const status = (code: number) =>
  Object.assign(new Error(`status ${code}`), { status: code });
/** Answers with the model it was sent to, as the real call reports it. */
const answersAs = async (c: MinkConfig) => ({ ...answered, model: c.model });

beforeEach(() => {
  h.client.mockImplementation(() => ({
    models: { generateContent: h.generate },
  }));
});

describe("callMinkWhatsAppModelWithRetry", () => {
  it("the main model gets two attempts by default", () => {
    expect(MINK_WHATSAPP_MODEL_ATTEMPTS).toBe(2);
    expect(MINK_WHATSAPP_RETRY_DELAY_MS).toBe(1_000);
  });

  it("★ a stall is followed by exactly one more attempt, and the answer says so", async () => {
    const call = stall();
    call.mockImplementationOnce(call.getMockImplementation()!);
    call.mockImplementationOnce(async () => answered);
    const result = await callMinkWhatsAppModelWithRetry(config, input, {
      timeoutMs: 20,
      call,
    });
    expect(result).toMatchObject({ ...answered, attempts: 2 });
    expect(call).toHaveBeenCalledTimes(2);
    // Each attempt gets its own, unexpired budget.
    const signals = call.mock.calls.map((c) => c[2]);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("★ with no fallback, two stalls end as a stall, never a third call", async () => {
    const call = stall();
    await expect(
      callMinkWhatsAppModelWithRetry(config, input, { timeoutMs: 20, call }),
    ).rejects.toMatchObject({
      name: "MinkWhatsAppModelStalled",
      attempts: 2,
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 422])(
    "★ a %i is final: thrown as it came, after one call, never to the fallback",
    async (code) => {
      const refused = status(code);
      const call = vi.fn(async () => {
        throw refused;
      });
      await expect(
        callMinkWhatsAppModelWithRetry(withFallback, input, {
          timeoutMs: 20,
          retryDelayMs: 0,
          call,
        }),
      ).rejects.toBe(refused);
      expect(call).toHaveBeenCalledTimes(1);
    },
  );

  it.each([403, 404])(
    "★★ a %i from the main model goes straight to the fallback, which answers",
    async (code) => {
      // A retired, mistyped or not-enabled main model: the rule the dashboard
      // chat, the attachment reader and Generate with AI follow.
      const refused = status(code);
      const call = vi.fn(answersAs).mockRejectedValueOnce(refused);
      const result = await callMinkWhatsAppModelWithRetry(withFallback, input, {
        retryDelayMs: 0,
        call,
      });
      expect(result).toMatchObject({ model: "gemini-3.5-flash", attempts: 2 });
      // The main model is not asked a second time.
      expect(call.mock.calls.map(([c]) => `${c.model}@${c.location}`)).toEqual([
        "gemini-3.7-flash@global",
        "gemini-3.5-flash@asia-south1",
      ]);
      expect(h.logError).toHaveBeenCalledWith(
        "whatsapp mink: main refused",
        refused,
        expect.objectContaining({
          model: "gemini-3.7-flash",
          location: "global",
          status: code,
        }),
      );
    },
  );

  it("★ a main refusal with a busy fallback hands over on the refusal, the fault to fix", async () => {
    const refused = status(404);
    const call = vi
      .fn(answersAs)
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(status(429));
    await expect(
      callMinkWhatsAppModelWithRetry(withFallback, input, {
        retryDelayMs: 0,
        call,
      }),
    ).rejects.toBe(refused);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("a main refusal with no fallback is thrown as it came, after one call", async () => {
    const refused = status(404);
    const call = vi.fn(async () => {
      throw refused;
    });
    await expect(
      callMinkWhatsAppModelWithRetry(config, input, { retryDelayMs: 0, call }),
    ).rejects.toBe(refused);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("a single-attempt budget stalls once and stops", async () => {
    const call = stall();
    await expect(
      callMinkWhatsAppModelWithRetry(config, input, {
        timeoutMs: 20,
        attempts: 1,
        call,
      }),
    ).rejects.toBeInstanceOf(MinkWhatsAppModelStalled);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("an answer on the first attempt reports one attempt", async () => {
    const call = vi.fn(async () => answered);
    expect(
      await callMinkWhatsAppModelWithRetry(config, input, { call }),
    ).toMatchObject({ attempts: 1 });
  });

  it("★ a 429 is asked once more on the main model, after a second's pause", async () => {
    vi.useFakeTimers();
    try {
      const call = vi
        .fn(answersAs)
        .mockRejectedValueOnce(status(429))
        .mockImplementationOnce(answersAs);
      const pending = callMinkWhatsAppModelWithRetry(withFallback, input, {
        call,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(call).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        model: "gemini-3.7-flash",
        attempts: 2,
      });
      expect(call.mock.calls.map(([c]) => `${c.model}@${c.location}`)).toEqual([
        "gemini-3.7-flash@global",
        "gemini-3.7-flash@global",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["two 429s", [status(429), status(429)]],
    ["a 503 and a 500", [status(503), status(500)]],
    [
      "a dropped connection and a 429",
      [new TypeError("fetch failed"), status(429)],
    ],
  ])(
    "★★ %s from the main model go to the Mink fallback in Mumbai, which answers",
    async (_label, errors) => {
      const call = vi
        .fn(answersAs)
        .mockRejectedValueOnce(errors[0])
        .mockRejectedValueOnce(errors[1]);
      const result = await callMinkWhatsAppModelWithRetry(withFallback, input, {
        retryDelayMs: 0,
        call,
      });
      expect(result).toMatchObject({ model: "gemini-3.5-flash", attempts: 3 });
      expect(call.mock.calls.map(([c]) => `${c.model}@${c.location}`)).toEqual([
        "gemini-3.7-flash@global",
        "gemini-3.7-flash@global",
        "gemini-3.5-flash@asia-south1",
      ]);
    },
  );

  it("★★ two stalls go to the fallback too", async () => {
    const call = stall();
    call.mockImplementationOnce(call.getMockImplementation()!);
    call.mockImplementationOnce(call.getMockImplementation()!);
    call.mockImplementationOnce(answersAs);
    await expect(
      callMinkWhatsAppModelWithRetry(withFallback, input, {
        timeoutMs: 20,
        call,
      }),
    ).resolves.toMatchObject({ model: "gemini-3.5-flash", attempts: 3 });
  });

  it("★ all three busy: the chat goes to a person with the last failure", async () => {
    const last = status(429);
    const call = vi
      .fn(answersAs)
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(status(503))
      .mockRejectedValueOnce(last);
    await expect(
      callMinkWhatsAppModelWithRetry(withFallback, input, {
        retryDelayMs: 0,
        call,
      }),
    ).rejects.toBe(last);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("all three stalled ends as a stall after three attempts", async () => {
    const call = stall();
    await expect(
      callMinkWhatsAppModelWithRetry(withFallback, input, {
        timeoutMs: 20,
        call,
      }),
    ).rejects.toMatchObject({
      name: "MinkWhatsAppModelStalled",
      attempts: 3,
    });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("★ a fallback that refuses is logged loudly, and the main model's failure is thrown", async () => {
    const mainBusy = status(503);
    const notFound = status(404);
    const call = vi
      .fn(answersAs)
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(mainBusy)
      .mockRejectedValueOnce(notFound);
    await expect(
      callMinkWhatsAppModelWithRetry(withFallback, input, {
        retryDelayMs: 0,
        call,
      }),
    ).rejects.toBe(mainBusy);
    expect(h.logError).toHaveBeenCalledWith(
      "whatsapp mink: fallback refused",
      notFound,
      expect.objectContaining({
        model: "gemini-3.5-flash",
        location: "asia-south1",
        status: 404,
      }),
    );
  });

  it.each([
    ["switched off in config", { ...withFallback, fallbackModel: null }, {}],
    [
      "the same as the main model",
      {
        ...withFallback,
        fallbackModel: "gemini-3.7-flash",
        fallbackLocation: "global",
      },
      {},
    ],
    ["switched off by the caller", withFallback, { fallback: null }],
  ])("the fallback is not asked when %s", async (_label, cfg, extra) => {
    const call = vi
      .fn(answersAs)
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(status(429));
    await expect(
      callMinkWhatsAppModelWithRetry(cfg as MinkConfig, input, {
        retryDelayMs: 0,
        call,
        ...extra,
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("★ its logs are content-free: never the store, the facts or the message", async () => {
    const call = vi
      .fn(answersAs)
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(status(404));
    const secret = {
      ...input,
      message: "where is my parcel 7781 for Priya",
      facts: {
        ...input.facts,
        store: { ...input.facts.store, name: "Secret Bakery" },
      },
    };
    await callMinkWhatsAppModelWithRetry(withFallback, secret, {
      retryDelayMs: 0,
      call,
    }).catch(() => undefined);
    expect(h.logWarn).toHaveBeenCalledWith(
      "whatsapp mink: model attempt failed",
      expect.objectContaining({
        model: "gemini-3.7-flash",
        location: "global",
        attempt: 1,
        status: 429,
        stalled: false,
      }),
    );
    const logged = JSON.stringify([
      ...h.logWarn.mock.calls,
      ...h.logError.mock.calls.map(([message, , context]) => [
        message,
        context,
      ]),
    ]);
    expect(logged).not.toMatch(/Secret Bakery|7781|Priya/);
  });
});

describe("★ callMinkWhatsAppModel (B25: the shared Vertex client)", () => {
  it("asks the shared client for the target's location and sends the verified request shape", async () => {
    h.generate.mockResolvedValue({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "thinking", thought: true },
              { text: '{"outcome":"answer","reply":"ok","reason":"r"}' },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 2,
      },
    });
    const signal = new AbortController().signal;
    const first = await callMinkWhatsAppModel(config, input, signal);
    await callMinkWhatsAppModel(config, input, signal);

    expect(first).toEqual({
      parsed: { outcome: "answer", reply: "ok", reason: "r" },
      finishReason: "STOP",
      model: "m",
      inputTokens: 10,
      outputTokens: 6,
    });
    // One client per project and location, never one per message.
    expect(h.client.mock.calls).toEqual([
      ["p", "global"],
      ["p", "global"],
    ]);
    expect(h.genaiConstructed).not.toHaveBeenCalled();
    const request = h.generate.mock.calls[0][0];
    expect(request.model).toBe("m");
    expect(request.config).toMatchObject({
      abortSignal: signal,
      systemInstruction: "SYSTEM INSTRUCTION",
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingLevel: "LOW" },
      responseMimeType: "application/json",
    });
    expect(request.config.responseJsonSchema).toBeTruthy();
    expect(request.config.tools).toBeUndefined();
  });

  it("★★ the fallback attempt goes to the Mumbai client with the same request, and its model is recorded", async () => {
    h.generate
      .mockRejectedValueOnce(status(429))
      .mockRejectedValueOnce(status(429))
      .mockResolvedValueOnce({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { text: '{"outcome":"answer","reply":"ok","reason":""}' },
              ],
            },
          },
        ],
      });
    const result = await callMinkWhatsAppModelWithRetry(withFallback, input, {
      retryDelayMs: 0,
    });
    expect(result).toMatchObject({ model: "gemini-3.5-flash", attempts: 3 });
    expect(h.client.mock.calls).toEqual([
      ["p", "global"],
      ["p", "global"],
      ["p", "asia-south1"],
    ]);
    const [mainRequest, , fallbackRequest] = h.generate.mock.calls.map(
      ([request]) => request,
    );
    expect(fallbackRequest.model).toBe("gemini-3.5-flash");
    // Byte for byte the main request apart from the model and the budget.
    const { abortSignal: _a, ...mainShape } = mainRequest.config;
    const { abortSignal: _b, ...fallbackShape } = fallbackRequest.config;
    void _a;
    void _b;
    expect(fallbackShape).toEqual(mainShape);
    expect(fallbackRequest.contents).toEqual(mainRequest.contents);
  });
});

describe("isModelStall", () => {
  it("reads the signal first, then the abort names, and nothing else", () => {
    const fired = AbortSignal.abort();
    const live = new AbortController().signal;
    expect(isModelStall(new Error("This operation was aborted"), fired)).toBe(
      true,
    );
    expect(
      isModelStall(
        Object.assign(new Error("x"), { name: "TimeoutError" }),
        live,
      ),
    ).toBe(true);
    expect(
      isModelStall(Object.assign(new Error("x"), { name: "AbortError" }), live),
    ).toBe(true);
    expect(isModelStall(new Error("permission denied"), live)).toBe(false);
    expect(isModelStall("not an error", live)).toBe(false);
  });
});
