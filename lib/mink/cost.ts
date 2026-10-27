import type { MinkUsage } from "./types";

/**
 * Share of the ordinary input rate charged for a prompt token the provider
 * served from a context cache — the published context-caching discount.
 *
 * ⚠ AN ASSUMED RATE, AND DELIBERATELY THE ONLY ASSUMED NUMBER HERE. The ledger
 * stores `cached_tokens` as a raw provider fact alongside the derived cost, so
 * every historical row can be repriced if this proves wrong; the multiplier is
 * stamped into `pricingVersion` precisely so rows priced under a wrong rate are
 * identifiable rather than silently mixed with correct ones. Change this and
 * the version string changes with it, for free.
 */
export const CACHED_INPUT_RATE_MULTIPLIER = 0.25;

/**
 * The cached-token count as it may safely be priced AND stored: never negative,
 * never above the prompt count it is a subset of.
 *
 * ⚠ ONE implementation, exported, because it has TWO callers that must agree —
 * the cost estimate and the ledger insert. The ledger's CHECK constraint
 * (cached_tokens <= input_tokens) sits inside the same transaction as the run's
 * completion row and its assistant message, so a value that violated it would
 * roll back an answer the merchant has already been shown. A second, drifting
 * copy of this clamp is therefore not a rounding bug; it is a lost reply.
 */
export function cachedPromptTokens(usage: MinkUsage): number {
  return Math.min(
    Math.max(0, usage.cachedTokens),
    Math.max(0, usage.promptTokens),
  );
}

/**
 * The base prompt count as it may safely be STORED: never negative, never
 * above the prompt total it is the first step's share of.
 *
 * ⚠ ONE implementation, for `cachedPromptTokens`' reason exactly. The ledger's
 * `base_prompt_tokens` CHECK sits in the same transaction as the run-completion
 * update and the assistant message, so a value that tripped it would roll back
 * a reply the merchant has already read. A clamp written twice is not a
 * rounding bug here; it is a lost answer.
 */
export function basePromptTokens(usage: MinkUsage): number {
  return Math.min(
    Math.max(0, usage.basePromptTokens),
    Math.max(0, usage.promptTokens),
  );
}

export interface MinkCostEstimate {
  estimatedCostMicrousd: number | null;
  pricingVersion: string | null;
}

/**
 * Shadow-cost one run using the public on-demand token price in effect when it
 * ran. A null estimate is deliberate: an unknown model must not be presented
 * to operators as free.
 */
export function estimateMinkCost(input: {
  model: string;
  location: string;
  usage: MinkUsage;
  at?: Date;
}): MinkCostEstimate {
  const leaf = modelLeaf(input.model);
  if (leaf === "gemini-3.5-flash-lite") return estimateLiteCost(input);
  if (leaf === "gemini-3.5-flash") return estimateFlash35Cost(input);
  if (leaf !== "gemini-3.7-flash") {
    return { estimatedCostMicrousd: null, pricingVersion: null };
  }

  const global = isGlobal(input.location);
  const intro = (input.at ?? new Date()) < new Date("2027-01-01T00:00:00Z");
  const inputRate = intro ? (global ? 0.75 : 0.825) : global ? 1.5 : 1.65;
  const outputRate = intro ? (global ? 3.75 : 4.125) : global ? 7.5 : 8.25;
  return {
    estimatedCostMicrousd: tokenCostMicrousd(
      input.usage,
      inputRate,
      outputRate,
    ),
    // The multiplier is part of the identity: a ledger row can be recomputed
    // against a corrected rate only if the version says which one produced it.
    pricingVersion: `gemini-3.7-flash-${global ? "global" : "regional"}-${intro ? "2026-intro" : "2027-standard"}-c${CACHED_INPUT_RATE_MULTIPLIER}`,
  };
}

/**
 * The lite tier (`config.liteModel`): Gemini 3.5 Flash-Lite at Google's list
 * price, $0.30 per million input tokens and $2.50 per million output tokens
 * (ai.google.dev pricing, read 2026-10-19), with no announced 2027 change.
 *
 * ⚠ GLOBAL ONLY. Mink calls Vertex at `global`; a regional rate for this model
 * has not been checked, and an unknown cost stays unknown (null) rather than
 * borrowing 3.7 Flash's regional uplift.
 */
function estimateLiteCost(input: {
  model: string;
  location: string;
  usage: MinkUsage;
}): MinkCostEstimate {
  if (!isGlobal(input.location)) {
    return { estimatedCostMicrousd: null, pricingVersion: null };
  }
  return {
    estimatedCostMicrousd: tokenCostMicrousd(input.usage, 0.3, 2.5),
    pricingVersion: `gemini-3.5-flash-lite-global-2026-list-c${CACHED_INPUT_RATE_MULTIPLIER}`,
  };
}

/**
 * The Mink fallback (`config.fallbackModel`), where voice turns start and
 * where a busy or refusing main model's turns go: Gemini 3.5 Flash at
 * Google's list price, $1.50 per million input tokens and $9.00 per million
 * output tokens at `global` (robustness audit B24, 2026-10-23), with Google's
 * 10% uplift at every other location, $1.65 and $9.90 (Vertex pricing page,
 * read 2026-10-23; the same uplift 3.7 Flash carries above). Mink calls it at
 * asia-south1, so the regional rate is the one its runs carry. No 2027 change
 * has been announced for it.
 *
 * ★ A NEW PRICE, A NEW VERSION. Until this existed a run the fallback
 *   answered stored a null estimate and a null pricing version ("Unknown" on
 *   the operator console); every row priced here names its version, so the
 *   two stay told apart and an old row can be repriced from its stored token
 *   counts.
 */
function estimateFlash35Cost(input: {
  model: string;
  location: string;
  usage: MinkUsage;
}): MinkCostEstimate {
  const global = isGlobal(input.location);
  return {
    estimatedCostMicrousd: tokenCostMicrousd(
      input.usage,
      global ? 1.5 : 1.65,
      global ? 9.0 : 9.9,
    ),
    pricingVersion: `gemini-3.5-flash-${global ? "global" : "regional"}-2026-list-c${CACHED_INPUT_RATE_MULTIPLIER}`,
  };
}

/**
 * One run's tokens at a model's USD-per-million rates, in micro-USD (a
 * USD-per-million-token rate is numerically micro-USD per token).
 *
 * ★ The provider prices visible response and reasoning as text output, and the
 *   SDK reports candidate and thought tokens separately, so both are billed.
 * ★ Cached prompt tokens are a SUBSET of promptTokens, never an addition, so
 *   they are subtracted before the full rate applies. Clamped
 *   (`cachedPromptTokens`) because a provider that reported more cached than
 *   prompt tokens must not drive the fresh count, and so the estimate,
 *   negative.
 */
function tokenCostMicrousd(
  usage: MinkUsage,
  inputRate: number,
  outputRate: number,
): number {
  const outputTokens = usage.outputTokens + usage.thoughtTokens;
  const cachedTokens = cachedPromptTokens(usage);
  const freshTokens = usage.promptTokens - cachedTokens;
  return Math.max(
    0,
    Math.round(
      freshTokens * inputRate +
        cachedTokens * inputRate * CACHED_INPUT_RATE_MULTIPLIER +
        outputTokens * outputRate,
    ),
  );
}

function isGlobal(location: string): boolean {
  return location.trim().toLowerCase() === "global";
}

/** "publishers/google/models/gemini-3.7-flash" and "gemini-3.7-flash" alike. */
function modelLeaf(model: string): string {
  return model.trim().toLowerCase().split("/").at(-1) ?? "";
}
