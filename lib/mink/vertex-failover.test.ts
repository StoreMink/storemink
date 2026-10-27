import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = {
  location: string;
  model: string;
  message: unknown;
  config: { abortSignal?: AbortSignal; systemInstruction?: unknown };
};

const h = vi.hoisted(() => ({
  create: vi.fn(),
  /** What each send does, in order; the last one repeats. */
  plan: [] as Array<(call: Call) => Promise<AsyncIterable<unknown>>>,
  calls: [] as Call[],
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  ThinkingLevel: { HIGH: "HIGH", LOW: "LOW" },
  GoogleGenAI: class {
    location: string;
    chats: { create: (params: unknown) => unknown };
    constructor(options: { location: string }) {
      this.location = options.location;
      this.chats = { create: (params) => h.create(this.location, params) };
    }
  },
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: h.logWarn,
  logError: h.logError,
}));

import { createVertexMinkSession } from "./vertex-client";
import { resetMinkModelHealth } from "./provider-health";
import type { MinkConfig } from "./config";
import type { MinkActorContext } from "./types";

const actor: MinkActorContext = {
  storeId: "store",
  adminId: "owner",
  email: null,
  effectivePlan: "pro",
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request",
};
const config = {
  projectId: "project",
  model: "gemini-3.7-flash",
  location: "global",
  maxOutputTokens: 100,
  maxModelRetries: 2,
  firstChunkTimeoutMs: 20_000,
  streamIdleTimeoutMs: 20_000,
  fallbackModel: "gemini-3.5-flash",
  fallbackLocation: "asia-south1",
} as MinkConfig;

function stream(...texts: string[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const text of texts)
      yield { candidates: [{ content: { parts: [{ text }] } }] };
  })();
}
const answer =
  (...texts: string[]) =>
  async () =>
    stream(...texts);
/** Never opens: the provider sent nothing at all. */
const silent = () => new Promise<never>(() => {});
/** Opens, says something, then goes quiet. */
const goesQuiet = (text: string) => async () =>
  (async function* () {
    yield { candidates: [{ content: { parts: [{ text }] } }] };
    await new Promise(() => {});
  })();
const status = (code: number) => async () => {
  throw Object.assign(new Error(`status ${code}`), { status: code });
};

beforeEach(() => {
  resetMinkModelHealth();
  h.plan = [];
  h.calls = [];
  h.create.mockImplementation(
    (location: string, params: { model: string; history?: unknown[] }) => ({
      sendMessageStream: (call: {
        message: unknown;
        config: Call["config"];
      }) => {
        const record = {
          location,
          model: params.model,
          message: call.message,
          config: call.config,
        };
        h.calls.push(record);
        const step = h.plan.length > 1 ? h.plan.shift()! : h.plan[0];
        return step(record);
      },
      getHistory: (curated?: boolean) => {
        expect(curated).toBe(true);
        return params.history ?? [];
      },
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

const session = (
  options: Partial<Parameters<typeof createVertexMinkSession>[3]> = {},
  overrides: Partial<MinkActorContext> = {},
) =>
  createVertexMinkSession(config, { ...actor, ...overrides }, [], {
    history: [{ role: "user", text: "earlier" }],
    ...options,
  });

describe("★★ a stalled turn", () => {
  it("is abandoned at its first-chunk deadline and asked again on the fallback, from the same history", async () => {
    vi.useFakeTimers();
    h.plan = [silent, answer("Twelve orders.")];
    const mink = session();
    const turn = mink.sendUserMessage("How many orders today?");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(turn).resolves.toMatchObject({
      text: "Twelve orders.",
      retryCount: 1,
    });
    expect(h.calls.map((call) => `${call.location}/${call.model}`)).toEqual([
      "global/gemini-3.7-flash",
      "asia-south1/gemini-3.5-flash",
    ]);
    // A new chat at the fallback's location, from the history the main chat
    // had: the stalled attempt added nothing to it.
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.create.mock.calls[1][0]).toBe("asia-south1");
    expect(h.create.mock.calls[1][1]).toMatchObject({
      model: "gemini-3.5-flash",
      history: [{ role: "user", parts: [{ text: "earlier" }] }],
    });
    expect(mink.model).toBe("gemini-3.5-flash");
    expect(mink.location).toBe("asia-south1");
    // The abandoned request was told to stop.
    expect(h.calls[0].config.abortSignal?.aborted).toBe(true);
    expect(h.logWarn).toHaveBeenCalledWith(
      "mink.model: attempt failed",
      expect.objectContaining({
        model: "gemini-3.7-flash",
        stall: "first_chunk",
      }),
    );
  });

  it("withdraws what streamed before a stream went quiet, then retries", async () => {
    vi.useFakeTimers();
    h.plan = [goesQuiet("Half "), answer("A whole answer.")];
    const deltas: string[] = [];
    const resets = vi.fn();
    const turn = session().sendUserMessage("Hi", {
      onDelta: (text) => deltas.push(text),
      onReset: resets,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(turn).resolves.toMatchObject({ text: "A whole answer." });
    expect(deltas).toEqual(["Half ", "A whole answer."]);
    expect(resets).toHaveBeenCalledOnce();
  });

  it("stays on the fallback for the rest of the run once it has answered", async () => {
    h.plan = [status(429), answer("ok")];
    const mink = session();
    await mink.sendUserMessage("first");
    await mink.sendToolResponses([{ id: "1", name: "tool", response: {} }]);
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash",
    ]);
    // No third chat: the second turn went to the chat that answered.
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it("gives a voice turn at most 12 s, and a HIGH-thinking turn four times the deadline", async () => {
    vi.useFakeTimers();
    h.plan = [silent, answer("ok")];
    const voice = session({}, { answerMedium: "spoken" }).sendUserMessage("Hi");
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(voice).resolves.toMatchObject({ retryCount: 1 });

    resetMinkModelHealth();
    h.calls = [];
    h.plan = [silent, answer("ok")];
    const deep = session({ thinkingLevel: "high" }).sendUserMessage("Code");
    await vi.advanceTimersByTimeAsync(79_999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(deep).resolves.toMatchObject({ retryCount: 1 });
  });

  it("★★ a stall only the voice deadline called does not send every run on the instance to the fallback", async () => {
    // A healthy main model can take 13 s to a first chunk on a large tool
    // result; voice gives up at 12, a written chat waits 20.
    vi.useFakeTimers();
    h.plan = [silent, answer("ok")];
    const voice = session({}, { answerMedium: "spoken" }).sendUserMessage("Hi");
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(voice).resolves.toMatchObject({ retryCount: 1 });
    expect(session().model).toBe("gemini-3.7-flash");
  });

  it("a written chat's stall still does", async () => {
    vi.useFakeTimers();
    h.plan = [silent, answer("ok")];
    const turn = session().sendUserMessage("Hi");
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(turn).resolves.toMatchObject({ retryCount: 1 });
    expect(session().model).toBe("gemini-3.5-flash");
  });

  it("is not retried when the run itself was stopped", async () => {
    h.plan = [silent];
    const controller = new AbortController();
    const turn = session({ abortSignal: controller.signal }).sendUserMessage(
      "Hi",
    );
    await Promise.resolve();
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(h.calls).toHaveLength(1);
  });
});

describe("★ the fallback", () => {
  it("is dropped when it refuses outright, and the turn goes back to the main model", async () => {
    h.plan = [status(429), status(404), answer("ok")];
    const mink = session();
    await expect(mink.sendUserMessage("Hi")).resolves.toMatchObject({
      text: "ok",
      retryCount: 2,
    });
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.5-flash",
      "gemini-3.7-flash",
    ]);
    expect(h.logError).toHaveBeenCalledWith(
      "mink.model: fallback refused",
      expect.anything(),
      expect.objectContaining({ model: "gemini-3.5-flash", status: 404 }),
    );
    // Never offered again in this session: a later failure retries the main model.
    h.calls = [];
    h.plan = [status(503), answer("ok")];
    await mink.sendToolResponses([{ id: "1", name: "tool", response: {} }]);
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.7-flash",
    ]);
  });

  it("★★ takes the turn back when the main model refuses a conversation the fallback has been answering", async () => {
    // The run moved to the fallback, which then made calls with its own
    // thought signatures; a 400 from the main model on that history is not
    // a verdict on the request, so the fallback that wrote it is asked again.
    h.plan = [status(429), answer("first")];
    const mink = session();
    await mink.sendUserMessage("Hi");
    h.calls = [];
    h.plan = [status(503), status(400), answer("second")];
    await expect(
      mink.sendToolResponses([{ id: "1", name: "tool", response: {} }]),
    ).resolves.toMatchObject({ text: "second", retryCount: 2 });
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.5-flash",
      "gemini-3.7-flash",
      "gemini-3.5-flash",
    ]);
    expect(h.logWarn).toHaveBeenCalledWith(
      "mink.model: history refused",
      expect.objectContaining({ model: "gemini-3.7-flash", status: 400 }),
    );
  });

  it("a 400 on the main model's own conversation is still the end of the turn", async () => {
    h.plan = [status(400)];
    await expect(session().sendUserMessage("Hi")).rejects.toMatchObject({
      code: "provider_request_rejected",
    });
    expect(h.calls).toHaveLength(1);
  });

  it("is not used at all when switched off", async () => {
    h.plan = [status(429), answer("ok")];
    const mink = createVertexMinkSession(
      { ...config, fallbackModel: null },
      actor,
      [],
      { history: [] },
    );
    await mink.sendUserMessage("Hi");
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.7-flash",
    ]);
  });

  it("★ is where a new run starts while the main model is cooling down on this instance", async () => {
    vi.useFakeTimers();
    h.plan = [status(429), answer("ok")];
    await session().sendUserMessage("Hi");

    h.calls = [];
    const next = session();
    expect(next.model).toBe("gemini-3.5-flash");
    await next.sendUserMessage("Hi again");
    expect(h.calls.map((call) => call.model)).toEqual(["gemini-3.5-flash"]);

    // A minute later the main model is tried first again.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(session().model).toBe("gemini-3.7-flash");
  });

  it("★★ is where a voice turn starts, and the main model is its failover", async () => {
    // Owner's decision (2026-10-20): 3.5 Flash in Mumbai answered a spoken
    // question in about half the time 3.7 Flash at global took.
    const voiceConfig = { ...config, voiceStartsOnFallback: true };
    const voice = () =>
      createVertexMinkSession(
        voiceConfig,
        { ...actor, answerMedium: "spoken" },
        [],
        { history: [] },
      );
    expect(voice().model).toBe("gemini-3.5-flash");
    expect(voice().location).toBe("asia-south1");
    // A typed turn still starts on the main model.
    expect(
      createVertexMinkSession(voiceConfig, actor, [], { history: [] }).model,
    ).toBe("gemini-3.7-flash");

    h.plan = [status(429), answer("ok")];
    await expect(voice().sendUserMessage("Hi")).resolves.toMatchObject({
      text: "ok",
      retryCount: 1,
    });
    expect(h.calls.map((call) => `${call.model}@${call.location}`)).toEqual([
      "gemini-3.5-flash@asia-south1",
      "gemini-3.7-flash@global",
    ]);
    // The fallback this instance just watched fail is not where the next
    // voice turn starts.
    expect(voice().model).toBe("gemini-3.7-flash");
  });

  it("★ stops starting voice turns on a fallback that refused outright", async () => {
    // Verified at asia-south1 on staging only: if production refuses it, each
    // voice turn must not pay that refusal before reaching the main model.
    const voiceConfig = { ...config, voiceStartsOnFallback: true };
    const voice = () =>
      createVertexMinkSession(
        voiceConfig,
        { ...actor, answerMedium: "spoken" },
        [],
        { history: [] },
      );
    h.plan = [status(404), answer("ok")];
    await expect(voice().sendUserMessage("Hi")).resolves.toMatchObject({
      text: "ok",
    });
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.5-flash",
      "gemini-3.7-flash",
    ]);
    expect(voice().model).toBe("gemini-3.7-flash");
  });

  it("★★ keeps starting voice turns on a fallback that leaked its reasoning once", async () => {
    // A reply that opens with its working is a glitch of a model that
    // answered, not a sign it is down: asked again on the main model, but
    // the next voice turn still starts on the fallback.
    const voiceConfig = { ...config, voiceStartsOnFallback: true };
    const voice = () =>
      createVertexMinkSession(
        voiceConfig,
        { ...actor, answerMedium: "spoken" },
        [],
        { history: [] },
      );
    h.plan = [answer("Thinking:\nThe user wants a count.\n"), answer("ok")];
    await expect(voice().sendUserMessage("Hi")).resolves.toMatchObject({
      text: "ok",
      retryCount: 1,
    });
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.5-flash",
      "gemini-3.7-flash",
    ]);
    expect(voice().model).toBe("gemini-3.5-flash");
  });

  it("★★ is not dropped or marked for a 400 on a conversation the main model wrote", async () => {
    // The turn started on the main model, failed over, and the fallback would
    // not read the main model's history: one request, not a broken model.
    const voiceConfig = { ...config, voiceStartsOnFallback: true };
    h.plan = [status(429), status(400), answer("ok")];
    const mink = session();
    await expect(mink.sendUserMessage("Hi")).resolves.toMatchObject({
      text: "ok",
      retryCount: 2,
    });
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.5-flash",
      "gemini-3.7-flash",
    ]);
    expect(h.logError).not.toHaveBeenCalledWith(
      "mink.model: fallback refused",
      expect.anything(),
      expect.anything(),
    );
    expect(h.logWarn).toHaveBeenCalledWith(
      "mink.model: history refused",
      expect.objectContaining({ model: "gemini-3.5-flash", status: 400 }),
    );
    // Still offered: a later failure in this session goes to it again ...
    h.calls = [];
    h.plan = [status(503), answer("again")];
    await mink.sendToolResponses([{ id: "1", name: "tool", response: {} }]);
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.5-flash",
    ]);
    // ... and a voice turn on this instance still starts there.
    expect(
      createVertexMinkSession(
        voiceConfig,
        { ...actor, answerMedium: "spoken" },
        [],
        { history: [] },
      ).model,
    ).toBe("gemini-3.5-flash");
  });

  it("★ a 400 on the fallback's own conversation is a rejected request: back to the main model, nothing marked", async () => {
    const voiceConfig = { ...config, voiceStartsOnFallback: true };
    const voice = () =>
      createVertexMinkSession(
        voiceConfig,
        { ...actor, answerMedium: "spoken" },
        [],
        { history: [] },
      );
    h.plan = [status(400), answer("ok")];
    await expect(voice().sendUserMessage("Hi")).resolves.toMatchObject({
      text: "ok",
      retryCount: 1,
    });
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.5-flash",
      "gemini-3.7-flash",
    ]);
    expect(h.logWarn).toHaveBeenCalledWith(
      "mink.model: fallback rejected the request",
      expect.objectContaining({ model: "gemini-3.5-flash", status: 400 }),
    );
    expect(h.logError).not.toHaveBeenCalledWith(
      "mink.model: fallback refused",
      expect.anything(),
      expect.anything(),
    );
    expect(voice().model).toBe("gemini-3.5-flash");
  });

  it("leaves voice turns on the main model when switched off", () => {
    expect(
      createVertexMinkSession(
        { ...config, voiceStartsOnFallback: false },
        { ...actor, answerMedium: "spoken" },
        [],
        { history: [] },
      ).model,
    ).toBe("gemini-3.7-flash");
  });

  it("sends each attempt with the full chat config and its own abort signal", async () => {
    h.plan = [answer("ok")];
    const controller = new AbortController();
    await session({ abortSignal: controller.signal }).sendUserMessage("Hi");
    const sent = h.calls[0].config;
    expect(sent.systemInstruction).toEqual(expect.any(String));
    expect(sent.abortSignal).toBeInstanceOf(AbortSignal);
    // Linked to the run, never the run's own signal (each attempt can be
    // abandoned without stopping the run).
    expect(sent.abortSignal).not.toBe(controller.signal);
  });
});

describe("★★ a main model that refuses outright (B9)", () => {
  it.each([404, 403])(
    "a typed turn whose main model answers %i is answered by the fallback, logged loudly and remembered for a minute",
    async (code) => {
      vi.useFakeTimers();
      h.plan = [status(code), answer("Twelve orders.")];
      const mink = session();
      await expect(mink.sendUserMessage("Hi")).resolves.toMatchObject({
        text: "Twelve orders.",
        retryCount: 1,
      });
      expect(h.calls.map((call) => `${call.model}@${call.location}`)).toEqual([
        "gemini-3.7-flash@global",
        "gemini-3.5-flash@asia-south1",
      ]);
      expect(h.logError).toHaveBeenCalledWith(
        "mink.model: main refused",
        expect.objectContaining({ status: code }),
        expect.objectContaining({
          model: "gemini-3.7-flash",
          location: "global",
          status: code,
        }),
      );
      // Remembered on the instance: the next run starts on the fallback.
      expect(session().model).toBe("gemini-3.5-flash");
      // A minute later the main model is asked first again.
      await vi.advanceTimersByTimeAsync(60_001);
      expect(session().model).toBe("gemini-3.7-flash");
    },
  );

  it("★★ a voice turn that started on the fallback goes back to it when the main model refuses", async () => {
    const voiceConfig = { ...config, voiceStartsOnFallback: true };
    h.plan = [status(429), status(404), answer("ok")];
    const voice = createVertexMinkSession(
      voiceConfig,
      { ...actor, answerMedium: "spoken" },
      [],
      { history: [] },
    );
    await expect(voice.sendUserMessage("Hi")).resolves.toMatchObject({
      text: "ok",
      retryCount: 2,
    });
    expect(h.calls.map((call) => `${call.model}@${call.location}`)).toEqual([
      "gemini-3.5-flash@asia-south1",
      "gemini-3.7-flash@global",
      "gemini-3.5-flash@asia-south1",
    ]);
    expect(h.logError).toHaveBeenCalledWith(
      "mink.model: main refused",
      expect.anything(),
      expect.objectContaining({ model: "gemini-3.7-flash", status: 404 }),
    );
    // A typed run on this instance now starts on the fallback too.
    expect(session().model).toBe("gemini-3.5-flash");
  });

  it.each([
    [404, "provider_request_rejected"],
    [403, "provider_auth_failed"],
  ])(
    "when the fallback's one attempt fails too, the turn ends on the main model's %i",
    async (code, expected) => {
      h.plan = [status(code), status(429)];
      await expect(session().sendUserMessage("Hi")).rejects.toMatchObject({
        code: expected,
      });
      // The main model is not asked again, and the fallback only once.
      expect(h.calls.map((call) => call.model)).toEqual([
        "gemini-3.7-flash",
        "gemini-3.5-flash",
      ]);
    },
  );
});

describe("★★ a reply that opens with the model's own reasoning", () => {
  it("is never shown, and is asked again on the other model", async () => {
    // Seen on the fallback (2026-10-19): "thought" on a line of its own, its
    // working, a draft of the answer, then the answer, all as plain text.
    h.plan = [
      answer(
        "thou",
        "ght\nNow I need to reply to the user in Hinglish.\n\n",
        "Aapka draft ready hai.",
      ),
      answer("Twelve orders."),
    ];
    const deltas: string[] = [];
    const resets = vi.fn();
    await expect(
      session().sendUserMessage("Hi", {
        onDelta: (text) => deltas.push(text),
        onReset: resets,
      }),
    ).resolves.toMatchObject({ text: "Twelve orders.", retryCount: 1 });
    expect(deltas).toEqual(["Twelve orders."]);
    expect(resets).not.toHaveBeenCalled();
    expect(h.calls.map((call) => call.model)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.5-flash",
    ]);
    expect(h.logWarn).toHaveBeenCalledWith(
      "mink.model: attempt failed",
      expect.objectContaining({ leakedReasoning: true }),
    );
    // The model answered; it is not marked down for its working.
    expect(session().model).toBe("gemini-3.7-flash");
  });

  it("an ordinary answer is released from its first character", async () => {
    h.plan = [answer("Thanks! ", "You had twelve orders.")];
    const deltas: string[] = [];
    await session().sendUserMessage("Hi", {
      onDelta: (text) => deltas.push(text),
    });
    expect(deltas).toEqual(["Thanks! ", "You had twelve orders."]);
  });
});
