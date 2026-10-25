import "server-only";

export interface MinkConfig {
  enabled: boolean;
  betaRequireInvite: boolean;
  projectId: string | null;
  location: string;
  model: string;
  /** The image model has its own override even when it shares Vertex's region. */
  imageModel: string;
  imageLocation: string;
  maxSteps: number;
  maxToolCalls: number;
  maxParallelReadTools: number;
  maxOutputTokens: number;
  /**
   * Further provider attempts after the first, per model turn. A retry goes to
   * the fallback model when there is one (see `fallbackModel`).
   */
  maxModelRetries: number;
  runTimeoutMs: number;
  /**
   * How long a model turn may take to produce its first chunk before the
   * attempt is abandoned as a stall and asked again (`vertex-client.ts`). A
   * HIGH-thinking turn waits four times as long, because its reasoning comes
   * before any output; a voice turn waits at most 12 s.
   */
  firstChunkTimeoutMs: number;
  /** How long a turn that has started streaming may go quiet before it is a stall. */
  streamIdleTimeoutMs: number;
  /**
   * The model a turn is retried on when the main one is unavailable: a 429,
   * a 5xx, a dropped connection or a stall. Null switches the fallback off
   * (`MINK_FALLBACK_MODEL` "off" or empty).
   *
   * ★ IT IS A DIFFERENT CAPACITY POOL, WHICH IS THE POINT. gemini-3.7-flash is
   * served only at `global`, where Google's shared capacity refused or stalled
   * most of a 300-attempt pass on 2026-10-19 (`mink-tool-routing.md`), and a
   * retry on the same pool usually meets the same wall. Gemini 3.5 Flash at
   * asia-south1 answered the same tool flow, was two to three times faster,
   * and accepted a conversation whose tool call 3.7 had made (probed on
   * storemink-staging, 2026-10-19).
   */
  fallbackModel: string | null;
  fallbackLocation: string;
  /**
   * Whether a voice chat turn starts on the fallback model (gemini-3.5-flash
   * at asia-south1) rather than the main one, with the main model as its own
   * failover. ON unless `MINK_VOICE_ON_FALLBACK` is "false" or "0".
   *
   * ★ OWNER'S DECISION (2026-10-20), for speed: measured on storemink-staging
   * with the real routed prompt (a personalise request, one tool call), the
   * answer to a spoken question started 15 to 18 s after it was sent on
   * gemini-3.7-flash at global and 6 to 10 s on 3.5 Flash in Mumbai; the
   * spoken "let me check" came at 5 to 9 s against 1.5 to 5.5 s. Typed chat
   * stays on the main model. ⚠ 3.5 Flash costs about twice 3.7 Flash's 2026
   * rate per token, and `estimateMinkCost` prices it at Google's regional
   * rate, $1.65 / $9.90 per million tokens at asia-south1 (credits are
   * band-based and unaffected).
   */
  voiceStartsOnFallback: boolean;
  /**
   * Whether a conversation actually spends the merchant's Mink credits.
   *
   * ★★ ON BY DEFAULT since 2026-09-21 (owner's decision). It shipped OPT-IN so
   * that billing something which had always been free could not be reached by
   * forgetting to set a variable, and it then stayed unset in every
   * environment — `MINK_CHARGE_CREDITS` was in no `cloudbuild.yaml`
   * substitution and on no Cloud Run revision — so the shadow meter ran for
   * weeks while nothing was billed. Measured on production before the flip:
   * 28 runs, 6 credits charged (both of them PROPOSAL weights, never the
   * conversation) against 80 the meter says it would have charged.
   *
   * ★ IT IS `enabled()`, NOT A LITERAL `true`, so `MINK_CHARGE_CREDITS=false`
   * is a real emergency stop — the same shape as `MINK_AI_ENABLED`, and the
   * reason the variable stays wired through the deploy rather than being
   * deleted now that the default covers it.
   *
   * ⚠ IT STILL DOES TWO JOBS AT ONCE, and that pairing is load-bearing rather
   * than incidental: `aiAllowanceFor` reads the same flag, so charging on also
   * moves every plan's included allowance from 3/10/50 to 20/100/300. Billing
   * 1–8-credit runs against caps sized for ₹0.90 product descriptions would
   * give a Free store one question a month.
   *
   * ⚠ THE MARGIN AT A BAND CEILING IS ~1.09× UNCACHED. A run sitting just under
   * the light or standard ceiling costs ₹1.98 or ₹5.94 against ₹2.15 or ₹6.45
   * of credit. Caching is what fixes that, not tighter bands — tightening would
   * triple the charge on ordinary runs.
   */
  chargeCredits: boolean;
  /**
   * Whether a run starts with only the tools its message needs
   * (`tool-routing.ts`). ON unless `MINK_TOOL_ROUTING` is "false" or "0":
   * a narrowed run can always ask for the rest (`request_more_tools`).
   */
  toolRouting: boolean;
  /** The cheaper model a light route may start on (`liteRouting`). */
  liteModel: string;
  /**
   * Whether a light route (a narrow, read-only, ordinary question) starts on
   * `liteModel`. ⚠ OFF unless `MINK_LITE_ROUTING` is "true" or "1": it
   * changes who answers, so it is switched on only after the live eval
   * (`lib/mink/live-eval.local.test.ts`) shows the answers hold.
   */
  liteRouting: boolean;
}

/**
 * The lite tier may only be a Flash-Lite model: a typo or another family
 * must not quietly become the model ordinary questions are answered by.
 */
const LITE_MODEL = /^gemini-\d+(?:\.\d+)?-flash-lite(?:-[0-9a-z.-]+)?$/;
const DEFAULT_LITE_MODEL = "gemini-3.5-flash-lite";

function liteModel(value: string | undefined): string {
  const model = value?.trim().toLowerCase();
  return model && LITE_MODEL.test(model) ? model : DEFAULT_LITE_MODEL;
}

/** Off unless explicitly "true" or "1". */
function optIn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

function enabled(value: string | undefined): boolean {
  return value === undefined || value === "true" || value === "1";
}

/**
 * On unless explicitly switched off, normalising the value first.
 *
 * ★★ NOT `enabled()`, AND THE DIFFERENCE IS THE FAILURE DIRECTION. That helper
 * treats anything it does not recognise as OFF — right for `MINK_AI_ENABLED`,
 * where off means Mink stops answering and somebody notices within minutes.
 * Here off means every conversation is silently free, which is the exact fault
 * that went unnoticed for weeks. So `MINK_CHARGE_CREDITS=TRUE`, or a value with
 * a stray space, must not quietly stop the billing it was set to start:
 * only a deliberate, recognisable "false"/"0" turns this off.
 */
function optOut(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "false" && normalized !== "0";
}

/**
 * The fallback model: a Gemini id, or null when switched off. Anything that is
 * not a plain Gemini model id is read as off rather than trusted, because a
 * typo here would otherwise send every retry to a model that does not exist.
 */
const GEMINI_MODEL = /^gemini-[0-9a-z.-]+$/;
const DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash";

function fallbackModel(value: string | undefined): string | null {
  if (value === undefined) return DEFAULT_FALLBACK_MODEL;
  const model = value.trim().toLowerCase();
  if (!model || model === "off" || model === "none" || model === "false")
    return null;
  return GEMINI_MODEL.test(model) ? model : null;
}

function boundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    return fallback;
  return parsed;
}

/** Read at request time so Cloud Run revisions and tests can change config safely. */
export function getMinkConfig(): MinkConfig {
  return {
    // Available to every store; the global flag is an emergency runtime stop.
    enabled: enabled(process.env.MINK_AI_ENABLED),
    betaRequireInvite: false,
    projectId: process.env.GCP_PROJECT_ID?.trim() || null,
    location:
      process.env.MINK_VERTEX_LOCATION?.trim() ||
      process.env.GCP_LOCATION?.trim() ||
      "global",
    model: process.env.MINK_VERTEX_MODEL?.trim() || "gemini-3.7-flash",
    // ★★ ONE IMAGE MODEL FOR EVERY PICTURE (owner, 25 Oct 2026): Nano Banana
    // 2.1, as in Theme Studio (lib/theme-studio/image-models.ts). It was
    // gemini-3.1-flash-image; MINK_IMAGE_MODEL (cloudbuild.yaml's
    // _MINK_IMAGE_MODEL) can still name another model, which is then sent
    // no thinking level (media-generation.ts requestMinkImage).
    imageModel:
      process.env.MINK_IMAGE_MODEL?.trim() || "gemini-nano-banana-2.1",
    // Gemini image generation is served at the global Vertex endpoint. Keep a
    // separate override so an operator can move it without moving chat.
    imageLocation: process.env.MINK_IMAGE_LOCATION?.trim() || "global",
    maxSteps: boundedInt(process.env.MINK_MAX_STEPS_PER_RUN, 12, 1, 20),
    maxToolCalls: boundedInt(
      process.env.MINK_MAX_TOOL_CALLS_PER_RUN,
      16,
      1,
      40,
    ),
    maxParallelReadTools: boundedInt(
      process.env.MINK_MAX_PARALLEL_READ_TOOLS,
      4,
      1,
      8,
    ),
    maxOutputTokens: boundedInt(
      process.env.MINK_MAX_OUTPUT_TOKENS,
      2_048,
      256,
      8_192,
    ),
    // On unless explicitly switched off — see MinkConfig.chargeCredits.
    chargeCredits: optOut(process.env.MINK_CHARGE_CREDITS),
    // ★ TWO RETRIES, AND THE FIRST GOES TO ANOTHER POOL. One retry on the same
    // model was the policy until 2026-10-20, and against a capacity window it
    // spent its one chance 250 ms later on the same exhausted pool: production
    // failed 6 of 11 runs in five minutes on 2026-10-19. Main, fallback, main.
    maxModelRetries: boundedInt(process.env.MINK_MAX_MODEL_RETRIES, 2, 0, 3),
    runTimeoutMs:
      boundedInt(process.env.MINK_RUN_TIMEOUT_SECONDS, 180, 15, 300) * 1_000,
    firstChunkTimeoutMs:
      boundedInt(process.env.MINK_FIRST_CHUNK_SECONDS, 20, 5, 120) * 1_000,
    streamIdleTimeoutMs:
      boundedInt(process.env.MINK_STREAM_IDLE_SECONDS, 20, 5, 120) * 1_000,
    fallbackModel: fallbackModel(process.env.MINK_FALLBACK_MODEL),
    fallbackLocation:
      process.env.MINK_FALLBACK_LOCATION?.trim() || "asia-south1",
    voiceStartsOnFallback: optOut(process.env.MINK_VOICE_ON_FALLBACK),
    toolRouting: optOut(process.env.MINK_TOOL_ROUTING),
    liteModel: liteModel(process.env.MINK_LITE_MODEL),
    liteRouting: optIn(process.env.MINK_LITE_ROUTING),
  };
}
