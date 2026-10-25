import { createHash } from "node:crypto";
import { canonicalJson } from "./contracts";
import type { StructuredResult, ThemeStudioModelClient } from "./provider";

// Separate from crash/lease attempts: a capacity refusal did not start the
// refused model call. Keep waiting bounded, even when capacity never returns.
export const MAX_RATE_LIMIT_DEFERRALS = 4;

export function generationRecoveryDelayMs(
  deferrals: number,
  random: () => number = Math.random,
): number | null {
  if (deferrals >= MAX_RATE_LIMIT_DEFERRALS) return null;
  const step = Math.min(5 * 60_000 * 2 ** deferrals, 20 * 60_000);
  return Math.round(step * (0.75 + 0.25 * Math.min(1, Math.max(0, random()))));
}

/**
 * ★★ A TEXT CALL GOOGLE COULD NOT SERVE IS WAITED OUT, NOT THE END OF THE RUN
 * (TS-3B). Only a 429 used to wait; an `UNAVAILABLE` (5xx after the SDK's own
 * fast retries) or a timed-out call failed the theme at once, and 3.9% of 3.8
 * Flash calls were refused in production (robustness audit). So:
 *   ★ `provider_unavailable` waits twice and `provider_timeout` once, each
 *     wait counted from the run's own `run_queued` events (reason = the code),
 *     so no column is needed and the count survives every reclaim;
 *   ★ the wait is short (about 2, then 4 minutes, jittered to 75 to 100%):
 *     these are outages, not the quota a 429 waits out over 5 to 20 minutes;
 *   ★ the run is requeued with `retry_not_before`, so a wait never spends a
 *     crash attempt, and its saved answers replay (resumableGenerationClient):
 *     a stage that already answered is never paid for twice; only the call
 *     that failed is sent again.
 * Every other failure (a rejected request, credentials, a refusal) still ends
 * the run: waiting cannot change those answers.
 */
export const PROVIDER_FAILURE_WAITS = {
  provider_unavailable: 2,
  provider_timeout: 1,
} as const;

export type WaitedProviderFailure = keyof typeof PROVIDER_FAILURE_WAITS;

export function isWaitedProviderFailure(
  code: string,
): code is WaitedProviderFailure {
  return Object.prototype.hasOwnProperty.call(PROVIDER_FAILURE_WAITS, code);
}

/** The wait before the next try after `waits` earlier waits for the same
 * failure, or null when that failure has had all its waits. */
export function providerFailureDelayMs(
  code: string,
  waits: number,
  random: () => number = Math.random,
): number | null {
  if (!isWaitedProviderFailure(code)) return null;
  if (waits >= PROVIDER_FAILURE_WAITS[code]) return null;
  const step = 2 * 60_000 * 2 ** Math.max(0, waits);
  return Math.round(step * (0.75 + 0.25 * Math.min(1, Math.max(0, random()))));
}

export type SavedModelResponse = Exclude<StructuredResult, { kind: "error" }>;

export interface GenerationResponseStore {
  read(digest: string): Promise<SavedModelResponse | null>;
  write(digest: string, response: SavedModelResponse): Promise<void>;
}

/** Exact request matching, scoped to one run by the store. Replaying saved
 * answers lets the ordinary validator/repair pipeline reconstruct its state
 * without repeating completed paid calls. Refusals from capacity are never
 * saved, so the refused request reaches the provider again after cooldown. */
export function resumableGenerationClient(
  client: ThemeStudioModelClient,
  store: GenerationResponseStore,
): ThemeStudioModelClient {
  let callIndex = 0;
  return {
    provider: client.provider,
    async generate(request, signal) {
      signal.throwIfAborted();
      if (request.stage !== "intent" && request.stage !== "draft") {
        throw new Error("Generation checkpoints support intent/draft only.");
      }
      const digest = createHash("sha256")
        .update(
          canonicalJson({
            provider: client.provider,
            callIndex: callIndex++,
            request,
          }),
        )
        .digest("hex");
      const saved = await store.read(digest);
      signal.throwIfAborted();
      if (saved) return saved;
      const response = await client.generate(request, signal);
      if (response.kind !== "error") await store.write(digest, response);
      return response;
    },
  };
}
