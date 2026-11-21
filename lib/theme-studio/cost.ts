import { isAllowedProviderVersion, type ThemeStudioModelKey } from "./models";
import { ZERO_USAGE, type ProviderUsage } from "./provider";

// A cost ESTIMATE, recorded beside the raw token counts it was computed from.
//
// ★ The rates are Google's published Gemini list prices (ai.google.dev pricing
// page, standard tier, read 2026-09-23). Vertex AI's global endpoint has matched
// them for Gemini 3 Flash so far (lib/mink/cost.ts carries the same figures for
// 3.7 Flash), but Vertex billing is the source of truth. The pricing version
// names the source, so a wrong rate is repairable later from the stored raw
// counts rather than silently mixed with correct ones.
//
// ★★ PRICED PER CALL, NEVER FROM RUN TOTALS. Gemini 3.1 Pro's rate depends on
// the size of the PROMPT OF THAT REQUEST (≤200k vs >200k tokens), so summing a
// run's calls first and then pricing the sum would put two ordinary 120k-token
// requests into the >200k tier and double their price.
//
// ★ Cached tokens are a SUBSET of input tokens, never an addition (the provider
// counts cached content inside promptTokenCount — the lib/mink/cost.ts rule).
// Thinking tokens are billed as output.
//
// ★★ PRICED WHERE IT WAS SERVED (TS-3D, 2026-10-25). Google's multi-region
// endpoints cost 1.1 times global (the Vertex AI pricing page, read 23 Oct
// 2026 for scripts/revamp-priority-test.ts, NON_GLOBAL_MULTIPLIER), and a
// check of an image now goes to the US endpoint first (gemini-vertex.ts,
// IMAGE_REVIEW_FIRST_LOCATION). The client that sent a request marks the
// usage it returns with the location that served it (markServedLocation),
// and estimateCostMicroUsd prices that usage there: a check the US answered
// costs 1.1 times, one the global endpoint answered after the US refused it
// costs what it always did, and every caller (reviewThemeImage, the
// redesign's studio-photo check) prices the usage object the client returned
// with no change of its own. The version names this table:
// "gemini-api-list-2026-09" (until 25 Oct 2026) priced every call at global.

export const THEME_STUDIO_PRICING_VERSION = "gemini-api-list-2026-09-us-1.1x";

/**
 * A location's price as a multiple of global's: Google's US and EU
 * multi-region endpoints cost 1.1 times (read on the price sheet). Any other
 * location but global is priced the same way: Theme Studio's models run at
 * global and the US only (THEME_STUDIO_VERTEX_LOCATION is `global` in every
 * deploy), and over-estimating is the safe direction for a number the daily
 * spend cap reads.
 */
export const NON_GLOBAL_PRICE_FACTOR = 1.1;

export function locationPriceFactor(location: string): number {
  return location === "global" ? 1 : NON_GLOBAL_PRICE_FACTOR;
}

/**
 * ★ The mark lives BESIDE the usage object, never in it: a usage is stored
 *   and compared as its four token counts, exactly as Google reported them.
 *   A copy carries no mark and is priced at global, so an estimate must be
 *   made from the object the client returned, as both checks do.
 */
const servedAt = new WeakMap<ProviderUsage, string>();

/**
 * Notes the location that served the request this usage was reported for,
 * and returns the same object. The shared zero usage is never marked: it is
 * every unanswered call's, and costs nothing anywhere.
 */
export function markServedLocation<T extends ProviderUsage>(
  usage: T,
  location: string,
): T {
  if (usage !== ZERO_USAGE) servedAt.set(usage, location);
  return usage;
}

/** Where the request behind this usage was served, if its client said. */
export function servedLocationOf(usage: ProviderUsage): string | null {
  return servedAt.get(usage) ?? null;
}

interface Rate {
  input: number;
  output: number;
  cached: number;
}

/** USD per million tokens for one request at the global endpoint
 *  (locationPriceFactor gives another location's multiple). */
export function ratesFor(
  modelKey: ThemeStudioModelKey,
  promptTokens: number,
  at: Date,
): Rate {
  switch (modelKey) {
    case "gemini-3.8-flash":
      return at < new Date("2027-01-01T00:00:00Z")
        ? { input: 0.75, output: 3.75, cached: 0.075 }
        : { input: 1.5, output: 7.5, cached: 0.15 };
    case "gemini-3.1-pro":
      return promptTokens > 200_000
        ? { input: 4, output: 18, cached: 0.4 }
        : { input: 2, output: 12, cached: 0.2 };
  }
}

/** Whole micro-USD for ONE request, so a run's calls sum exactly, at the
 *  location that served it (global unless its client marked another). */
export function estimateCostMicroUsd(
  modelKey: ThemeStudioModelKey,
  usage: ProviderUsage,
  at: Date = new Date(),
): number {
  const rate = ratesFor(modelKey, usage.inputTokens, at);
  const cached = Math.min(Math.max(usage.cachedTokens, 0), usage.inputTokens);
  const dollars =
    ((usage.inputTokens - cached) * rate.input +
      cached * rate.cached +
      (usage.outputTokens + usage.thinkingTokens) * rate.output) /
    1_000_000;
  const location = servedLocationOf(usage);
  const factor = location === null ? 1 : locationPriceFactor(location);
  return Math.round(dollars * factor * 1_000_000);
}

// ── Images ───────────────────────────────────────────────────────────────────
//
// ★★ PRICED AT THE RATES OF THE MODEL THAT DREW IT (25 Oct 2026). The usage an
// image client returns names the model that answered and counts its thinking
// (image-vertex.ts imageUsageOf), and is priced here at that model's list
// rates, in USD per million tokens:
// - gemini-nano-banana-2.1, every picture since 25 Oct 2026 (owner: one image
//   model for all image generation): input $1.50 (text and image), picture
//   output $30, text and thinking output $7.50. A picture is 1,120 tokens at
//   1K (about $0.0336), 1,680 at 2K (about $0.0504) and 3,780 at 4K (about
//   $0.113). Google's pricing page, read through search results on 25 Oct;
//   ⚠ third parties give 2,520 tokens for 4K, but the 25 Oct smoke test's 4K
//   hero reported 3,780 (and 1,680 at 2K, 1,120 at 1K). ⚠ The $7.50 thinking
//   rate is from third parties only. That test thought about 1,250 to 1,360
//   tokens at HIGH and reported none at MINIMAL; all in, a 2K photo was about
//   $0.050 to $0.052 at MINIMAL, $0.059 at MEDIUM and $0.061 to $0.062 at
//   HIGH, and the 4K hero $0.125.
// - gemini-3-pro-image, every Theme Studio photo from 29 Sep to 25 Oct 2026
//   and the owner's rollback since (image-models.ts): input $2, picture $120
//   (1,120 tokens at 1K and 2K, about $0.134), text and thinking $12.
// - gemini-3.1-flash-image, Theme Studio before 29 Sep and Mink before
//   25 Oct, and a MINK_IMAGE_MODEL rollback: input $0.50, picture $60 (1,680
//   tokens at 2K, about $0.101), text and thinking $3.
// ★ A usage that names no model was recorded before 25 Oct by the Pro client
//   (a saved draw replayed after the release is one), and is priced at Pro's
//   rates, as it always was; so is a model this table does not know: the
//   dearest rates are the safe direction for a number the daily spend cap
//   reads. Before 25 Oct no image call counted its thinking.
// ★ All output tokens are priced at the picture rate. An answer may carry a
//   few text tokens beside the picture (18 at HIGH on 25 Oct); pricing them as
//   picture tokens overstates the estimate by a fraction of a cent, the safe
//   direction.
// ★ The draft picture 2.1 sends before every final one (thought: true; Pro
//   has done the same since about 22 Oct) is not in the usage Google reports:
//   a 2K answer reports exactly 1,680 picture tokens. Whether it is billed is
//   an open question to Google.
// ⚠ List prices, not reconciled against a Vertex invoice: Vertex billing is
//   the source of truth, and the version names this table so a wrong rate is
//   repairable from the stored counts. "gemini-pro-image-list-2026-09" (until
//   25 Oct 2026) priced every call at Pro's rates and counted no thinking;
//   runs before 29 Sep 2026 carry an older string still.

export const THEME_STUDIO_IMAGE_PRICING_VERSION = "gemini-image-list-2026-10";

/** USD per million tokens of one image call. */
export interface ImageRates {
  input: number;
  /** Every output token, priced as picture (see above). */
  picture: number;
  /** Text and thinking output. */
  text: number;
}

const IMAGE_RATES: ReadonlyArray<{ family: string; rates: ImageRates }> = [
  {
    family: "gemini-nano-banana-2.1",
    rates: { input: 1.5, picture: 30, text: 7.5 },
  },
  {
    family: "gemini-3-pro-image",
    rates: { input: 2, picture: 120, text: 12 },
  },
  {
    family: "gemini-3.1-flash-image",
    rates: { input: 0.5, picture: 60, text: 3 },
  },
];

const PRO_IMAGE_RATES = IMAGE_RATES[1].rates;

/** Picture tokens of one 2.1 picture at each size (see above). */
export const NANO_BANANA_PICTURE_TOKENS = {
  "1K": 1_120,
  "2K": 1_680,
  "4K": 3_780,
} as const;

/** The rates of the model that drew a picture, or of a published version of
 *  it; Pro's for no model or one this table does not know. */
export function imageRatesFor(model: string | null | undefined): ImageRates {
  if (!model) return PRO_IMAGE_RATES;
  return (
    IMAGE_RATES.find(({ family }) => isAllowedProviderVersion(family, model))
      ?.rates ?? PRO_IMAGE_RATES
  );
}

/**
 * What one image call is priced from: the counts Google reported and, since
 * 25 Oct 2026, the thinking it billed and the model that answered (set by
 * image-vertex.ts on every usage it returns, and kept in a stored call).
 */
export interface ImageCallUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  model?: string;
  /** A per-picture price from a provider that reports no tokens. */
  flatCostMicroUsd?: number;
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** The thinking tokens a usage counted; 0 for one recorded before
 *  25 Oct 2026, when no image call counted them. */
export function imageThinkingTokens(usage: ImageCallUsage): number {
  return tokens(usage.thinkingTokens);
}

/** Whole micro-USD for ONE image request, at the rates of the model that
 *  drew it. */
export function estimateImageCostMicroUsd(usage: ImageCallUsage): number {
  // ★ A provider that bills by the picture (ElevenLabs) states its cost; with
  //   no tokens to price, Google's rates would call every such picture free.
  if (
    typeof usage.flatCostMicroUsd === "number" &&
    Number.isFinite(usage.flatCostMicroUsd) &&
    usage.flatCostMicroUsd > 0
  ) {
    return Math.round(usage.flatCostMicroUsd);
  }
  const rate = imageRatesFor(usage.model);
  return Math.round(
    tokens(usage.inputTokens) * rate.input +
      tokens(usage.outputTokens) * rate.picture +
      imageThinkingTokens(usage) * rate.text,
  );
}
