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
 * text: a first line reading just "thought" (or "Thinking:"), then its
 * working, then a draft of the answer and the answer again. Retried like a
 * 503, so the merchant never sees it.
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

/** A first line that is only a reasoning label: no answer opens with one. */
const LEAKED_REASONING_LINE = /^(?:thought|thinking)[ \t]*:?[ \t]*$/i;
const LEAKED_REASONING_WORDS = ["thought", "thinking"];

/**
 * Whether streamed text opens with leaked reasoning, or could still turn out
 * to: `undefined` while the first line is still arriving and could become
 * the marker.
 *
 * ★ THE WHOLE FIRST LINE IS THE MARKER: "thought" or "thinking", in any case,
 *   with or without a trailing colon (robustness audit B21, 2026-10-23: the
 *   guard caught only a lowercase "thought", so "Thinking:" or "Thought"
 *   reached the merchant). Anything else on that line makes it an answer:
 *   "Thought you might like these", "Thinking of a gift?", and the plural
 *   "Thoughts:", which heads a real list of ideas.
 * ★ It waits only while the text could still become that line: a prefix of
 *   either word, or the word (and colon) with no line break yet. "The …",
 *   "Thanks" and "Twelve" are released as soon as they rule it out.
 */
export function leakedReasoningAt(text: string): boolean | undefined {
  const start = text.trimStart();
  const lineBreak = /\r?\n/.exec(start);
  if (lineBreak) {
    return LEAKED_REASONING_LINE.test(start.slice(0, lineBreak.index));
  }
  // No line break yet. A carriage return at the very end may be the first
  // half of "\r\n" split across two chunks.
  const line = start.endsWith("\r") ? start.slice(0, -1) : start;
  if (LEAKED_REASONING_LINE.test(line)) return undefined;
  const typed = line.toLowerCase();
  return LEAKED_REASONING_WORDS.some((word) => word.startsWith(typed))
    ? undefined
    : false;
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
   * `refused`: the MAIN model answered 404 or 403 (retired, a wrong id, not
   * enabled at its location), so the turn goes to the fallback once and the
   * main model is not asked again in this turn;
   * `fatal`: the main model answered a non-retryable error other than 403
   * or 404, so the turn ends; or the FALLBACK answered 404 or 403 (a wrong
   * id, not enabled at its location), so it is dropped for the rest of the
   * session and the turn goes back to the main model.
   * `history`: one model refused (400) a conversation the OTHER had been
   * answering, so the turn goes back to the model that wrote it and stays
   * there; neither model is at fault, so neither is marked down.
   * `rejected`: the FALLBACK answered a non-retryable error other than 404,
   * 403 or a history refusal (a 400 on a conversation it wrote itself, say):
   * a verdict on this request, not a misconfigured model, so the turn goes
   * back to the main model and stays there, nothing is marked, and the
   * fallback stays on offer for later turns.
   */
  kind: "retryable" | "refused" | "fatal" | "history" | "rejected";
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
 * main model. Any other fatal answer from the main model (a 400, a credential
 * failure) ends the turn, as before.
 * ★★ ONLY A 404 OR 403 DROPS THE FALLBACK. Any other non-retryable answer from
 * it (a 400, a 401) is about one request, not about the model: it is reported
 * as `rejected` (or `history`, below), the turn goes back to the main model,
 * and the fallback is neither dropped nor marked down. Treating a 400 as a
 * refusal benched the fallback for every run on the instance, voice turns
 * included, over one request it would not read.
 * ★★ A MAIN MODEL THAT REFUSES OUTRIGHT GOES TO THE FALLBACK, ONCE (robustness
 * audit B9, 2026-10-23). A 404 or 403 from the main model ended the turn, so
 * one retired or mistyped model id took every chat down while the fallback
 * stood ready. It is reported (`onFailure`, kind `refused`) and the turn goes
 * to the fallback, which gets one attempt: the main model is not asked again
 * in this turn, since a refusal does not change 250 ms later, and when that
 * attempt fails too the turn ends on the main model's refusal, the fault an
 * operator has to fix. A voice turn that started on the fallback goes back
 * to it the same way.
 * ★★ A CONVERSATION ONE MODEL WROTE MAY NOT READ ON THE OTHER.
 * Only one direction was ever probed (3.5 Flash answering a call 3.7 made); a
 * run that has been answering on the fallback carries the fallback's own
 * function calls and thought signatures, and a 400 from the main model on
 * that history is not a verdict on the request. The turn goes back to the
 * fallback, which wrote it, and stays there for the rest of this turn. The
 * reverse holds too: a 400 from the fallback on a conversation the main model
 * wrote sends the turn back to the main model, and marks nothing.
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
  // The fallback refused the main model's history (400), or rejected this
  // turn's request: the rest of the turn stays on the main model.
  let fallbackRefusesTurn = false;
  // The main model answered 404 or 403 in this turn: it is not asked again.
  let mainRefused = false;
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
      const status = providerStatus(error);
      // A 400 from one model on a conversation the OTHER one wrote.
      const refusedHistory =
        status === 400 &&
        fallback !== null &&
        (onFallback ? !historyOnFallback : historyOnFallback);
      const kind: MinkFailoverEvent["kind"] = refusedHistory
        ? "history"
        : isRetryableProviderError(error)
          ? "retryable"
          : status === 403 || status === 404
            ? onFallback
              ? "fatal"
              : "refused"
            : onFallback
              ? "rejected"
              : "fatal";
      input.onFailure?.({ target, error, kind, retryCount });
      if (!onFallback) {
        mainError = error;
        mainFailed = true;
      }
      if (kind === "history" && !onFallback) mainRefusesHistory = true;
      if ((kind === "history" || kind === "rejected") && onFallback) {
        fallbackRefusesTurn = true;
      }
      if (kind === "fatal" && !onFallback) {
        throw new MinkRetryError(error, retryCount);
      }
      // The fallback's one attempt after the main model refused has failed
      // too: the turn ends on the main model's refusal, the fault to fix.
      if (mainRefused) throw new MinkRetryError(mainError, retryCount);
      if (kind === "refused") {
        mainRefused = true;
        if (!fallback) throw new MinkRetryError(error, retryCount);
      }
      if (retryCount >= input.maxRetries) {
        // A fallback that refused or rejected this turn says nothing about
        // why the turn failed; the main model's own error does.
        throw new MinkRetryError(
          onFallback && kind !== "retryable" && mainFailed ? mainError : error,
          retryCount,
        );
      }
      retryCount += 1;
      let next: MinkProviderTarget;
      if (kind === "fatal") {
        fallback = null;
        next = input.primary;
      } else if ((kind === "refused" || mainRefusesHistory) && fallback) {
        next = fallback;
      } else if (fallbackRefusesTurn) {
        next = input.primary;
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
