export class MinkRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryCount: number,
  ) {
    super("Mink provider request failed after bounded retries.");
    this.name = "MinkRetryError";
  }
}

/**
 * A provider attempt that went quiet: no first chunk, or no next chunk, within
 * its deadline (`vertex-client.ts`). Retried like a 503.
 *
 * ★ A STALL IS THE PROVIDER NOT ANSWERING, NOT A SLOW ANSWER. Production's
 * failed runs on 2026-10-19 sat silent until the 180 s run deadline, and the
 * live eval's stalls (295 of 424 attempts on gemini-3.7-flash) all answered on
 * a re-ask; a healthy first chunk arrives in 2 to 8 s. Waiting longer only
 * spends the merchant's patience.
 */
export class MinkStallError extends Error {
  constructor(
    public readonly phase: "first_chunk" | "idle",
    public readonly waitedMs: number,
  ) {
    super(
      phase === "first_chunk"
        ? `The model sent nothing for ${waitedMs} ms.`
        : `The model's stream went quiet for ${waitedMs} ms.`,
    );
    this.name = "MinkStallError";
  }
}

/**
 * A reply that opened with the model's own reasoning, written as ordinary
 * text: a first line reading just "thought", then its working, then a draft
 * of the answer and the answer again. Retried like a 503, so the merchant
 * never sees it.
 *
 * ★ SEEN ON THE FALLBACK (gemini-3.5-flash, storemink-staging, 2026-10-19):
 *   the reasoning arrived as plain text parts, not as `thought` parts, so the
 *   stream's thought filter could not drop it.
 */
export class MinkLeakedReasoningError extends Error {
  constructor() {
    super("The model wrote its reasoning into the answer.");
    this.name = "MinkLeakedReasoningError";
  }
}

/**
 * Whether streamed text opens with leaked reasoning, or could still turn out
 * to: `undefined` while the text so far is only a prefix of the marker.
 * ★ Lowercase "thought" alone on the first line: no answer starts that way,
 *   and "The …" or "Thanks" rule it out from the first character.
 */
export function leakedReasoningAt(text: string): boolean | undefined {
  const start = text.trimStart();
  const marker = "thought";
  if (start.length <= marker.length) {
    return marker.startsWith(start) ? undefined : false;
  }
  if (!start.startsWith(marker)) return false;
  const rest = start.slice(marker.length);
  const line = /^[ \t]*(\r?\n)?/.exec(rest);
  if (line?.[1]) return true;
  // Spaces after the word but no line break yet: keep waiting.
  return /^[ \t]*$/.test(rest) ? undefined : false;
}

/** One model at one Vertex location: the thing a turn is sent to. */
export type MinkProviderTarget = { model: string; location: string };

export function sameMinkTarget(
  left: MinkProviderTarget,
  right: MinkProviderTarget,
): boolean {
  return left.model === right.model && left.location === right.location;
}

export type MinkFailoverEvent = {
  target: MinkProviderTarget;
  error: unknown;
  /**
   * `retryable` (429, 5xx, a dropped connection, a stall) is tried again;
   * `fatal` is not, except on the fallback, which is then dropped for the
   * rest of the session and the turn goes back to the main model.
   * `history`: the main model refused (400) a conversation the fallback had
   * been answering, so the turn goes back to the fallback; neither model is
   * at fault, so neither is marked down.
   */
  kind: "retryable" | "fatal" | "history";
  /** Retries spent so far, this attempt included. */
  retryCount: number;
};

/**
 * Sends one model turn, failing over between the main model and a fallback.
 *
 * ★★ THE FIRST RETRY GOES TO THE OTHER POOL, AND ONLY A SAME-POOL RETRY WAITS.
 * The commonest failure is Google's shared capacity at `global` refusing or
 * stalling for minutes at a time, and a retry 250 ms later on the same pool
 * meets the same wall; a different model at another location is a different
 * pool and is asked at once. With no fallback (or one that refused), retries
 * stay on the main model with the old 250 ms, 500 ms, 1 s backoff.
 * ★ `start` IS WHERE THE LAST TURN WAS ANSWERED. A run whose main model failed
 * once stays on the fallback for its remaining turns rather than paying the
 * stall again on every step; it goes back only if the fallback fails too.
 * ★ A FALLBACK THAT REFUSES OUTRIGHT IS DROPPED, NOT FATAL. A 404 or 403 from
 * the fallback means it is misconfigured or not enabled on the project, which
 * must never turn a transient main-model failure into a failed run: the
 * fallback is reported (`onFailure`, kind `fatal`) and the turn returns to the
 * main model. A fatal answer from the main model ends the turn, as before.
 * ★★ A CONVERSATION THE FALLBACK WROTE MAY NOT READ ON THE MAIN MODEL.
 * Only one direction was ever probed (3.5 Flash answering a call 3.7 made); a
 * run that has been answering on the fallback carries the fallback's own
 * function calls and thought signatures, and a 400 from the main model on
 * that history is not a verdict on the request. The turn goes back to the
 * fallback, which wrote it, and stays there for the rest of this turn.
 * ★ AN ABORTED RUN IS NEVER RETRIED: its own error goes back unwrapped, which
 * is what the stream route reads as cancelled or timed out.
 */
export async function withMinkFailover<T>(input: {
  attempt: (target: MinkProviderTarget, retryCount: number) => Promise<T>;
  primary: MinkProviderTarget;
  fallback: MinkProviderTarget | null;
  start?: MinkProviderTarget;
  maxRetries: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
  onFailure?: (event: MinkFailoverEvent) => void;
}): Promise<{
  value: T;
  retryCount: number;
  target: MinkProviderTarget;
  /** False once the fallback refused outright; the caller stops offering it. */
  fallbackUsable: boolean;
}> {
  let fallback =
    input.fallback && !sameMinkTarget(input.fallback, input.primary)
      ? input.fallback
      : null;
  let target =
    input.start && fallback && sameMinkTarget(input.start, fallback)
      ? fallback
      : input.primary;
  // The history this turn is sent with was written by the model that
  // answered the last turn: `start`, when that is the fallback.
  const historyOnFallback =
    fallback !== null && sameMinkTarget(target, fallback);
  let mainRefusesHistory = false;
  let retryCount = 0;
  let sameTargetRetries = 0;
  let mainError: unknown;
  let mainFailed = false;
  for (;;) {
    try {
      const value = await input.attempt(target, retryCount);
      return { value, retryCount, target, fallbackUsable: fallback !== null };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const onFallback = fallback !== null && sameMinkTarget(target, fallback);
      const refusedHistory =
        !onFallback &&
        fallback !== null &&
        historyOnFallback &&
        providerStatus(error) === 400;
      const kind = refusedHistory
        ? "history"
        : isRetryableProviderError(error)
          ? "retryable"
          : "fatal";
      input.onFailure?.({ target, error, kind, retryCount });
      if (!onFallback) {
        mainError = error;
        mainFailed = true;
      }
      if (kind === "history") mainRefusesHistory = true;
      if (kind === "fatal" && !onFallback) {
        throw new MinkRetryError(error, retryCount);
      }
      if (retryCount >= input.maxRetries) {
        // A fallback that refused outright says nothing about why the turn
        // failed; the main model's own error does.
        throw new MinkRetryError(
          kind === "fatal" && mainFailed ? mainError : error,
          retryCount,
        );
      }
      retryCount += 1;
      let next: MinkProviderTarget;
      if (kind === "fatal") {
        fallback = null;
        next = input.primary;
      } else if (mainRefusesHistory && fallback) {
        next = fallback;
      } else {
        next = fallback && !onFallback ? fallback : input.primary;
      }
      if (sameMinkTarget(next, target)) {
        sameTargetRetries += 1;
        await abortableDelay(
          (input.baseDelayMs ?? 250) * 2 ** (sameTargetRetries - 1),
          input.signal,
        );
      }
      target = next;
    }
  }
}

export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof MinkStallError) return true;
  if (error instanceof MinkLeakedReasoningError) return true;
  const status = providerStatus(error);
  if (status !== null) {
    return status === 408 || status === 429 || status >= 500;
  }
  // fetch/undici uses TypeError for connection resets, DNS failures and other
  // failures that happen before an HTTP response exists.
  return error instanceof TypeError;
}

function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

export function abortableDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}
