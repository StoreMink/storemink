/**
 * The testable part of scripts/mink-whatsapp-eval.ts: how a live case calls
 * the model, and how the report tells a recovered answer's retries apart.
 *
 * ★ THE GRADE IS THE CONFIGURED MODEL'S ALONE. The live path
 *   (callMinkWhatsAppModelWithRetry, lib/whatsapp/mink-model.ts) now asks the
 *   Mink fallback after the main model's attempts come back busy, so an eval
 *   run on the live options would grade whichever model answered. The eval
 *   switches the fallback off (`fallback: null`) and keeps the rest of the
 *   live rule: one more attempt on the main model after a 429, a 5xx, a
 *   dropped connection or a stall.
 */
import { isRetryableProviderError } from "@/lib/mink/retry";
import {
  callMinkWhatsAppModel,
  isModelStall,
  type MinkWhatsAppModelRetryOptions,
} from "@/lib/whatsapp/mink-model";

/** Why the model was asked again during one case. */
export interface EvalRetries {
  /** Attempts whose own budget ran out with no answer. */
  stalls: number;
  /** Attempts the provider answered busy: a 429, a 5xx, a dropped connection. */
  busy: number;
}

/** A fresh tally for one case. */
export function noRetries(): EvalRetries {
  return { stalls: 0, busy: 0 };
}

/**
 * The model call, watched: each attempt that did not answer is counted as a
 * stall (the budget mink-model.ts gives every attempt fired) or as busy (a
 * failure mink-model.ts asks again after). A refusal of the request itself
 * (a 400, a 403, a 404) is counted as neither: it ends the case, it is not
 * retried.
 */
export function watchedCall(
  retries: EvalRetries,
  call: typeof callMinkWhatsAppModel = callMinkWhatsAppModel,
): typeof callMinkWhatsAppModel {
  return async (config, input, signal) => {
    try {
      return await call(config, input, signal);
    } catch (error) {
      if (signal && isModelStall(error, signal)) retries.stalls += 1;
      else if (isRetryableProviderError(error)) retries.busy += 1;
      throw error;
    }
  };
}

/** The options a live case passes: the configured model only, watched. */
export function evalModelOptions(
  retries: EvalRetries,
  call?: typeof callMinkWhatsAppModel,
): MinkWhatsAppModelRetryOptions {
  return {
    timeoutMs: 30_000,
    // ★ No fallback: the grade is the configured model's (see the header).
    fallback: null,
    call: watchedCall(retries, call),
  };
}

/** What the summary needs from one case. */
export interface EvalRetryRecord {
  /** Model attempts the answer took; 0 offline, at the gate or on failure. */
  attempts: number;
  /** The model that answered; null when none did. */
  model: string | null;
  retries: EvalRetries;
}

/**
 * The answers that needed more than one attempt, split by why: answered by
 * a model other than the configured one (the fallback, which an eval run
 * switches off, so this stays 0 unless that changes), answered after a stall,
 * or answered after a busy refusal. Each such answer is counted once.
 */
export function retrySplit(
  results: readonly EvalRetryRecord[],
  configuredModel: string,
): { stalls: number; busyRetries: number; fallbackAnswers: number } {
  const split = { stalls: 0, busyRetries: 0, fallbackAnswers: 0 };
  for (const result of results) {
    if (result.attempts <= 1) continue;
    if (result.model !== null && result.model !== configuredModel) {
      split.fallbackAnswers += 1;
    } else if (result.retries.stalls > 0) {
      split.stalls += 1;
    } else {
      split.busyRetries += 1;
    }
  }
  return split;
}
