import { describe, expect, it, vi } from "vitest";
import {
  isRetryableProviderError,
  leakedReasoningAt,
  MinkLeakedReasoningError,
  MinkRetryError,
  MinkStallError,
  withMinkFailover,
  type MinkProviderTarget,
} from "./retry";

const MAIN: MinkProviderTarget = {
  model: "gemini-3.7-flash",
  location: "global",
};
const FALLBACK: MinkProviderTarget = {
  model: "gemini-3.5-flash",
  location: "asia-south1",
};
const busy = () => Object.assign(new Error("busy"), { status: 429 });
/** An attempt that answers "ok" unless told otherwise. */
const answering = () =>
  vi.fn(
    async (target: MinkProviderTarget, retryCount: number): Promise<string> => {
      void target;
      void retryCount;
      return "ok";
    },
  );

describe("withMinkFailover with no fallback", () => {
  it("retries one transient provider failure and reports the attempt", async () => {
    const attempt = answering()
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce("ok");

    await expect(
      withMinkFailover({
        attempt,
        primary: MAIN,
        fallback: null,
        maxRetries: 1,
        baseDelayMs: 0,
      }),
    ).resolves.toMatchObject({ value: "ok", retryCount: 1, target: MAIN });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls.map(([target]) => target)).toEqual([MAIN, MAIN]);
  });

  it("does not retry a non-transient provider rejection", async () => {
    const rejection = Object.assign(new Error("bad request"), { status: 400 });
    const attempt = vi.fn(async () => {
      throw rejection;
    });

    await expect(
      withMinkFailover({
        attempt,
        primary: MAIN,
        fallback: null,
        maxRetries: 2,
        baseDelayMs: 0,
      }),
    ).rejects.toMatchObject({
      originalError: rejection,
      retryCount: 0,
    } satisfies Partial<MinkRetryError>);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("stops immediately when the enclosing run is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = new TypeError("network");
    const attempt = vi.fn(async () => {
      throw failure;
    });

    await expect(
      withMinkFailover({
        attempt,
        primary: MAIN,
        fallback: FALLBACK,
        maxRetries: 2,
        signal: controller.signal,
        baseDelayMs: 0,
      }),
    ).rejects.toBe(failure);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("treats a fallback identical to the main model as no fallback", async () => {
    const attempt = answering().mockRejectedValueOnce(busy());
    const result = await withMinkFailover({
      attempt,
      primary: MAIN,
      fallback: { ...MAIN },
      maxRetries: 1,
      baseDelayMs: 0,
    });
    expect(result.fallbackUsable).toBe(false);
    expect(attempt.mock.calls.map(([target]) => target)).toEqual([MAIN, MAIN]);
  });
});

describe("★★ withMinkFailover with a fallback", () => {
  it("sends the first retry to the fallback at once, without the backoff", async () => {
    const attempt = answering().mockRejectedValueOnce(busy());
    const started = Date.now();

    const result = await withMinkFailover({
      attempt,
      primary: MAIN,
      fallback: FALLBACK,
      maxRetries: 2,
      // A same-pool retry would wait this long; another pool is asked now.
      baseDelayMs: 2_000,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({
      value: "ok",
      retryCount: 1,
      target: FALLBACK,
      fallbackUsable: true,
    });
    expect(attempt.mock.calls).toEqual([
      [MAIN, 0],
      [FALLBACK, 1],
    ]);
  });

  it("alternates main, fallback, main, and a stall counts like a 503", async () => {
    const attempt = answering()
      .mockRejectedValueOnce(new MinkStallError("first_chunk", 20_000))
      .mockRejectedValueOnce(Object.assign(new Error("down"), { status: 503 }));

    const result = await withMinkFailover({
      attempt,
      primary: MAIN,
      fallback: FALLBACK,
      maxRetries: 2,
      baseDelayMs: 0,
    });

    expect(result).toMatchObject({ value: "ok", retryCount: 2, target: MAIN });
    expect(attempt.mock.calls.map(([target]) => target)).toEqual([
      MAIN,
      FALLBACK,
      MAIN,
    ]);
  });

  it("starts where the last turn was answered, so a run stays on the fallback", async () => {
    const attempt = answering();
    const result = await withMinkFailover({
      attempt,
      primary: MAIN,
      fallback: FALLBACK,
      start: FALLBACK,
      maxRetries: 2,
      baseDelayMs: 0,
    });
    expect(result.target).toEqual(FALLBACK);
    expect(attempt).toHaveBeenCalledWith(FALLBACK, 0);
  });

  it("goes back to the main model when the fallback fails too", async () => {
    const attempt = answering().mockRejectedValueOnce(busy());
    const result = await withMinkFailover({
      attempt,
      primary: MAIN,
      fallback: FALLBACK,
      start: FALLBACK,
      maxRetries: 1,
      baseDelayMs: 0,
    });
    expect(result.target).toEqual(MAIN);
  });

  it("★ drops a fallback that refuses outright and returns the turn to the main model", async () => {
    // A 404 from the fallback is a configuration fault (wrong id, not
    // enabled at that location): it must never fail a run the main model
    // could still answer.
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    const attempt = answering()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(notFound);
    const onFailure = vi.fn();

    const result = await withMinkFailover({
      attempt,
      primary: MAIN,
      fallback: FALLBACK,
      maxRetries: 2,
      baseDelayMs: 0,
      onFailure,
    });

    expect(result).toMatchObject({
      target: MAIN,
      retryCount: 2,
      fallbackUsable: false,
    });
    expect(attempt.mock.calls.map(([target]) => target)).toEqual([
      MAIN,
      FALLBACK,
      MAIN,
    ]);
    expect(onFailure.mock.calls.map(([event]) => event.kind)).toEqual([
      "retryable",
      "fatal",
    ]);
  });

  it("reports the main model's error when a refusing fallback used the last retry", async () => {
    const mainError = busy();
    const attempt = answering()
      .mockRejectedValueOnce(mainError)
      .mockRejectedValueOnce(
        Object.assign(new Error("not found"), { status: 404 }),
      );

    await expect(
      withMinkFailover({
        attempt,
        primary: MAIN,
        fallback: FALLBACK,
        maxRetries: 1,
        baseDelayMs: 0,
      }),
    ).rejects.toMatchObject({ originalError: mainError, retryCount: 1 });
  });

  it("★★ returns to the fallback when the main model refuses the conversation the fallback wrote", async () => {
    // The fallback answered the last turn, so the history carries its
    // thought signatures; a 400 from the main model on that history is the
    // history, not the request, and the fallback can still answer.
    const badRequest = Object.assign(new Error("bad request"), {
      status: 400,
    });
    const attempt = answering()
      .mockRejectedValueOnce(Object.assign(new Error("down"), { status: 503 }))
      .mockRejectedValueOnce(badRequest);
    const onFailure = vi.fn();

    const result = await withMinkFailover({
      attempt,
      primary: MAIN,
      fallback: FALLBACK,
      start: FALLBACK,
      maxRetries: 2,
      baseDelayMs: 0,
      onFailure,
    });

    expect(result).toMatchObject({ target: FALLBACK, retryCount: 2 });
    expect(attempt.mock.calls.map(([target]) => target)).toEqual([
      FALLBACK,
      MAIN,
      FALLBACK,
    ]);
    expect(onFailure.mock.calls.map(([event]) => event.kind)).toEqual([
      "retryable",
      "history",
    ]);
  });

  it("keeps the turn on the fallback once the main model has refused its history", async () => {
    const attempt = answering()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(Object.assign(new Error("bad"), { status: 400 }))
      .mockRejectedValueOnce(busy());

    const result = await withMinkFailover({
      attempt,
      primary: MAIN,
      fallback: FALLBACK,
      start: FALLBACK,
      maxRetries: 3,
      baseDelayMs: 0,
    });

    expect(attempt.mock.calls.map(([target]) => target)).toEqual([
      FALLBACK,
      MAIN,
      FALLBACK,
      FALLBACK,
    ]);
    expect(result.target).toEqual(FALLBACK);
  });

  it("a 400 on a conversation the main model wrote is still the end of the turn", async () => {
    const badRequest = Object.assign(new Error("bad request"), {
      status: 400,
    });
    const attempt = answering().mockRejectedValueOnce(badRequest);
    const onFailure = vi.fn();

    await expect(
      withMinkFailover({
        attempt,
        primary: MAIN,
        fallback: FALLBACK,
        maxRetries: 2,
        baseDelayMs: 0,
        onFailure,
      }),
    ).rejects.toMatchObject({ originalError: badRequest, retryCount: 0 });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0].kind).toBe("fatal");
  });

  it("gives up after the retry budget with the last error", async () => {
    const last = Object.assign(new Error("down"), { status: 503 });
    const attempt = answering()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(last);

    await expect(
      withMinkFailover({
        attempt,
        primary: MAIN,
        fallback: FALLBACK,
        maxRetries: 2,
        baseDelayMs: 0,
      }),
    ).rejects.toMatchObject({ originalError: last, retryCount: 2 });
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});

describe("isRetryableProviderError", () => {
  it.each([
    [Object.assign(new Error("x"), { status: 408 }), true],
    [Object.assign(new Error("x"), { status: 429 }), true],
    [Object.assign(new Error("x"), { status: 500 }), true],
    [Object.assign(new Error("x"), { status: 503 }), true],
    [new TypeError("fetch failed"), true],
    [new MinkStallError("idle", 20_000), true],
    [new MinkLeakedReasoningError(), true],
    [Object.assign(new Error("x"), { status: 400 }), false],
    [Object.assign(new Error("x"), { status: 403 }), false],
    [Object.assign(new Error("x"), { status: 404 }), false],
    [new Error("invalid_grant"), false],
  ])("%o → %s", (error, expected) => {
    expect(isRetryableProviderError(error)).toBe(expected);
  });
});

describe("★★ leakedReasoningAt", () => {
  it.each([
    ["thought\nNow I need to reply in Hinglish.", true],
    ["thought\r\nThe merchant asked", true],
    ["  thought  \nworking", true],
    ["thought\n", true],
  ])("%j is leaked reasoning", (text, expected) => {
    expect(leakedReasoningAt(text)).toBe(expected);
  });

  it.each([
    ["", undefined],
    ["   ", undefined],
    ["t", undefined],
    ["thou", undefined],
    ["thought", undefined],
    ["thought  ", undefined],
  ])("%j cannot be judged yet", (text, expected) => {
    expect(leakedReasoningAt(text)).toBe(expected);
  });

  it.each([
    ["Thanks! You had twelve orders.", false],
    ["The store sold ₹4,200 today.", false],
    ["Thought about it: twelve orders.", false],
    ["thoughtful packaging sells well", false],
    ["thought it through: twelve orders", false],
    ["Twelve orders.", false],
    ["आज 12 ऑर्डर आए।", false],
  ])("%j is an ordinary answer", (text, expected) => {
    expect(leakedReasoningAt(text)).toBe(expected);
  });
});
