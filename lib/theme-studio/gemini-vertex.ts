import "server-only";

import {
  GoogleGenAI,
  PartMediaResolutionLevel,
  ThinkingLevel,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GoogleGenAIOptions,
  type Part,
} from "@google/genai";
import { logWarn } from "@/lib/observability/logger";
import { THEME_STUDIO_LIMITS } from "./contracts";
import { abortable } from "./abortable";
import { markServedLocation } from "./cost";
import {
  uncoordinatedProviderCapacity,
  ProviderCapacityLost,
  type ProviderCapacity,
} from "./provider-capacity";
import {
  RATE_LIMIT_BACKOFF,
  rateLimitDelayMs,
  sleepUnlessAborted,
} from "./rate-limit-backoff";
import {
  ZERO_USAGE,
  type ProviderUsage,
  type StructuredRequest,
  type StructuredResult,
  type ThemeStudioModelClient,
} from "./provider";

// ---------------------------------------------------------------------------
// Gemini models on Vertex AI, for Theme Studio ONLY.
//
// ★ A dedicated client, deliberately not shared with merchant Mink even though
// both use @google/genai: Mink's session carries tools, memories and a chat
// history, and a generation stage here must carry none of them. Nothing
// outside lib/theme-studio constructs this client, so "these models exist only
// for this task" is a property of the code rather than of a dropdown.
//
// ★ Credentials are Application Default Credentials; there is no API key. The
// project and region come from server environment only.
//
// ★ No tools are declared. The request has a system instruction, one user
// turn, and a response JSON schema — so the model can return JSON and nothing
// else, and nothing it writes is ever executed.
//
// ★ A safety block is a normal outcome, not an exception, and there is no
// fallback to another model: silently substituting one would be the
// substitution the Phase 0 registry forbids.
//
// ★★ A CHECK OF AN IMAGE MAY BE SENT TO A SECOND PLACE, NEVER A SECOND MODEL
// (TS-3D): a client given `capacityAt` sends every `image_review` call to
// Google's US endpoint first and once to its own location when the US refuses
// or times out (IMAGE_REVIEW_FIRST_LOCATION). The model and the request are
// the same at both.
// ---------------------------------------------------------------------------

export interface VertexConfig {
  projectId: string;
  region: string;
}

export function getVertexConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VertexConfig | null {
  const projectId =
    env.THEME_STUDIO_GCP_PROJECT_ID?.trim() || env.GCP_PROJECT_ID?.trim();
  if (!projectId) return null;
  return {
    projectId,
    region: env.THEME_STUDIO_VERTEX_LOCATION?.trim() || "global",
  };
}

/** Per-request ceiling. The run's own deadline (the Phase 0 wall time) is the
 * outer bound; this keeps one hung stage from consuming all of it. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * ★★ ONE CHECK OF AN IMAGE (`image_review`) GETS A CLOCK PER TRY, NOT ONE FOR
 * THE WHOLE CALL. A check used to run on one 180 s clock that also counted
 * its 429 waits, so a try that finally got through after two refusals could
 * be cut off half way, and one photo's check held a redesign's card for 15
 * minutes (storemink-staging, 2026-10-23). Each try now has 75 s from the
 * moment it is admitted: a successful check took 5 to 14 s under light load
 * and up to 164 s with four shops at once (run 2), so 75 s keeps most of
 * those while a held request is let go well before the old clock. How long
 * a check may take IN ALL is the caller's budget, passed as the signal
 * (photos.ts, products.ts); Theme Studio's own deferrals bound its runs.
 * ★ The default: a caller sets its own with `imageReviewTryTimeoutMs`
 *   (TS-3D). The redesigns keep 75 s; Theme Studio's worker sets a longer
 *   clock from its own measured checks (worker.ts,
 *   THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS).
 */
export const IMAGE_REVIEW_TRY_TIMEOUT_MS = 75_000;

/**
 * ★★ WHERE A CHECK OF AN IMAGE GOES FIRST: GOOGLE'S US ENDPOINT (owner's
 * decision, 23 Oct 2026, 19:45 IST; TS-3D). `us` is a multi-region location,
 * which the SDK sends to `aiplatform.us.rep.googleapis.com`, a separate pool
 * from global. Measured on storemink-staging (23 Oct, evening): 3.8 Flash
 * checks there answered 20 of 20, median 8.8 s; at global 6 of 20 answered
 * and 13 timed out.
 * ★ Only for a client given `capacityAt`, and only for `image_review`: every
 *   other stage stays at the client's own location.
 * ★ A check the US REFUSES (a 429, a 5xx such as UNAVAILABLE, an outright
 *   403 or 404: the model not served there), one whose try TIMES OUT (its own
 *   clock, or a 408), or one that could not reach the US at all (a network
 *   failure with no answer) is sent once to the client's own location (global
 *   in production). A 400 is a bad request, a 401 or a credential failure is
 *   ours, and neither goes anywhere else. NEVER A THIRD TRY: both tries are
 *   single SDK attempts, with no 429 wait between or after them.
 * ★ The US costs 1.1 times global: the answer's usage is marked with the
 *   location that served it and priced there (cost.ts, markServedLocation).
 */
export const IMAGE_REVIEW_FIRST_LOCATION = "us";

/**
 * ★ A 429 inside a check waits a short jittered 10 to 20 s before the next
 *   try, not the 15 s to 2 min backoff a generation waits. A check is a few
 *   seconds of model time that a merchant is waiting on, and the caller asks
 *   again on its own schedule when even these tries are refused, so a long
 *   wait here only holds the card.
 * ★ A check sent to the US first (a client given `capacityAt`) never waits:
 *   a 429 there sends it to global at once, and this is only the pause its
 *   row's other callers take (the store holds it to 15 s).
 */
export const IMAGE_REVIEW_RATE_LIMIT_WAIT_MS = {
  min: 10_000,
  max: 20_000,
} as const;

/** Tries after the first that a check makes when it is refused with 429, at
 *  a client's one location. A check sent to the US first makes one more try
 *  in all, at global, whatever refused it. */
export const IMAGE_REVIEW_RATE_LIMIT_RETRIES = 2;

/** The wait before a check's next try after a 429: 10 to 20 s, jittered. */
export function imageReviewRateLimitDelayMs(
  random: () => number = Math.random,
): number {
  const { min, max } = IMAGE_REVIEW_RATE_LIMIT_WAIT_MS;
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(min + (max - min) * r);
}

// Finish reasons that mean the provider withheld the answer on policy grounds.
// Anything else that is not STOP or MAX_TOKENS is an unexplained stop and is
// treated as a provider failure, never as a usable answer.
const REFUSAL_FINISH_REASONS = new Set([
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

export function usageOf(
  response: GenerateContentResponse | null | undefined,
): ProviderUsage {
  const usage = response?.usageMetadata;
  if (!usage) return ZERO_USAGE;
  const input = count(usage.promptTokenCount);
  return {
    inputTokens: input,
    // A SUBSET of the prompt count, clamped so a provider quirk can never make
    // the estimate bill cached tokens twice or go negative.
    cachedTokens: Math.min(count(usage.cachedContentTokenCount), input),
    outputTokens: count(usage.candidatesTokenCount),
    thinkingTokens: count(usage.thoughtsTokenCount),
  };
}

function status(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /\babort/i.test(error.message))
  );
}

function isCredentialError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "object"
          ? (current as { message?: unknown }).message
          : undefined;
    if (
      typeof message === "string" &&
      /invalid_(?:grant|rapt)|reauth|credential/i.test(message)
    ) {
      return true;
    }
    current =
      typeof current === "object" ? (current as { cause?: unknown }).cause : 0;
  }
  return false;
}

/** The closed-vocabulary code for an SDK failure. Most specific first. */
export function classifyProviderError(
  error: unknown,
  signal?: AbortSignal,
): Extract<StructuredResult, { kind: "error" }>["code"] {
  if (signal?.aborted || isAbort(error)) return "cancelled";
  const code = status(error);
  if (code === 429) return "rate_limited";
  if (code === 401 || code === 403 || isCredentialError(error))
    return "provider_auth";
  if (code === 408 || code === 504) return "provider_timeout";
  if (code === 400 || code === 404 || code === 422) return "provider_rejected";
  return "provider_unavailable";
}

/**
 * ★ Every image is read at ULTRA_HIGH media resolution: 2,240 tokens per image
 * instead of the default 1,120 (countTokens, gemini-3.8-flash, 2026-09-29), so
 * a reference screenshot's small type, card spacing and photography, and the
 * reviewer's view of a lettered label, are read at twice the detail. Accepted
 * by both allowlisted models in a live call with a JSON schema and HIGH
 * thinking. Cost is not the constraint here (owner, 2026-09-29).
 */
function toParts(request: StructuredRequest): Part[] {
  return request.content.map((block) =>
    block.type === "text"
      ? { text: block.text }
      : {
          inlineData: { mimeType: block.mediaType, data: block.base64 },
          mediaResolution: {
            level: PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH,
          },
        },
  );
}

/** Status codes the SDK retries on its own, fast. 429 is deliberately absent:
 * it gets the slower backoff below (rate-limit-backoff.ts). */
const SDK_RETRY_STATUS_CODES = [408, 500, 502, 503, 504];

export interface VertexClientOptions {
  /** Test seams; production uses real timers and Math.random. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  random?: () => number;
  /** The capacity every call queues on, at the client's one location. */
  capacity?: (providerModel: string) => ProviderCapacity;
  /**
   * ★★ A CAPACITY THAT KNOWS THE LOCATION (TS-3D). Given it, every check of
   * an image (`image_review`) goes to Google's US endpoint first and, when
   * the US refuses it or its try times out, once to the client's own location
   * (IMAGE_REVIEW_FIRST_LOCATION), each try queuing on ITS location's row: a
   * US 429 pauses only the US row, and the try after it takes a permit of the
   * global row. Every other stage stays at the client's own location, on
   * `capacityAt(model, config.region)`.
   * ★ It takes the place of `capacity`, so one client never queues one
   *   location's calls on another location's row; a client without it keeps
   *   its one location for every call, as before.
   * ★ A caller that wraps its capacity (the redesigns' deadline drain,
   *   `revampDrainingCapacity`) wraps each location's, so its admission
   *   signal ends a wait at either.
   */
  capacityAt?: (providerModel: string, location: string) => ProviderCapacity;
  /**
   * One check try's clock (`image_review`), from the moment the try is
   * admitted: IMAGE_REVIEW_TRY_TIMEOUT_MS (75 s) unless the caller sets it
   * (TS-3D). Every other stage keeps its one ten-minute clock.
   */
  imageReviewTryTimeoutMs?: number;
  /**
   * Told of every try the provider refused with 429 that is followed by
   * another try (the one the call ends on is in its result). ★ For a caller
   * that counts refusals per model, the revamp's usage, so a live run can
   * say how many requests the shared pool turned away. Never throws into the
   * call: a counter that fails costs the count, not the answer.
   * ★ A check the US refused with 429 goes on to its try at the client's own
   *   location at once: `waitMs` 0, and `location` names where the refused
   *   try was sent (only a client given `capacityAt` names it).
   */
  onRetry?: (event: {
    stage: StructuredRequest["stage"];
    providerModel: string;
    waitMs: number;
    location?: string;
  }) => void;
}

type ErrorCode = Extract<StructuredResult, { kind: "error" }>["code"];

/** One check try's clock: the caller's when it is a usable duration, never
 *  longer than the client's own ten-minute request timeout. */
function checkTryClockMs(requested: number | undefined): number {
  return typeof requested === "number" &&
    Number.isFinite(requested) &&
    requested >= 1
    ? Math.min(Math.round(requested), REQUEST_TIMEOUT_MS)
    : IMAGE_REVIEW_TRY_TIMEOUT_MS;
}

/**
 * The SDK client for one try of a check sent to the US first, at `location`:
 * built the way scripts/revamp-priority-test.ts builds its check clients
 * (`clientOptions`): Vertex with Application Default Credentials, v1, the
 * ten-minute timeout production's check client sends Google, and ONE
 * attempt, so the SDK never retries a refused try on its own and a check is
 * never sent a third time. Location `us` reaches
 * `aiplatform.us.rep.googleapis.com` (the SDK's rule for multi-region
 * locations).
 */
function singleAttemptOptions(
  config: VertexConfig,
  location: string,
): GoogleGenAIOptions {
  return {
    enterprise: true,
    project: config.projectId,
    location,
    apiVersion: "v1",
    httpOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: 1 },
    },
  };
}

/**
 * Whether a check's failed try at the US goes on to the client's own
 * location: the US refused it (a 429, any 5xx, an outright 403 or 404), its
 * try timed out (its own clock, or a 408), or it never reached the US (a
 * network failure with no answer). Never a 400 (bad everywhere), a 401 or a
 * credential failure (ours, everywhere), nor an abort; the caller rules out
 * its own stop and a lost permit first.
 */
function goesOnFromUs(error: unknown, timedOut: boolean): boolean {
  if (timedOut) return true;
  const code = status(error);
  if (code === null) return !isAbort(error) && !isCredentialError(error);
  return (
    code === 403 ||
    code === 404 ||
    code === 408 ||
    code === 429 ||
    (code >= 500 && code <= 599)
  );
}

/** The one request a call sends, at any location: tool-free, with its
 *  system text, content and JSON schema, the same bytes everywhere. */
function contentRequest(
  request: StructuredRequest,
  signal: AbortSignal,
): GenerateContentParameters {
  return {
    model: request.providerModel,
    contents: [{ role: "user", parts: toParts(request) }],
    config: {
      abortSignal: signal,
      systemInstruction: request.system,
      ...(request.maxTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxTokens }),
      responseMimeType: "application/json",
      responseJsonSchema: request.schema,
      thinkingConfig: {
        thinkingLevel:
          request.effort === "high" ? ThinkingLevel.HIGH : ThinkingLevel.LOW,
      },
    },
  };
}

/**
 * A call that ended on a refusal, a timeout or a provider error says so
 * once, in Google's own words; a cancelled call is ours, not theirs.
 * ★ `location` is named by a client that sends checks to two places.
 */
function failedCall(
  request: StructuredRequest,
  code: ErrorCode,
  tries: number,
  facts: ProviderErrorFacts,
  location?: string,
): StructuredResult {
  if (code !== "cancelled") {
    logWarn("theme_studio.provider_error", {
      stage: request.stage,
      model: request.modelKey,
      code,
      tries,
      ...(location === undefined ? {} : { location }),
      ...facts,
    });
  }
  return { kind: "error", code, usage: ZERO_USAGE };
}

/**
 * What an answer is: a refusal, a truncation, an unexplained stop or a JSON
 * value. ★ Its usage is marked with the location that served it, so the
 * estimate prices it there (cost.ts, markServedLocation). `named` adds the
 * location to its log line (a client that sends checks to two places).
 */
function answerOf(
  response: GenerateContentResponse,
  request: StructuredRequest,
  location: string,
  named: boolean,
): StructuredResult {
  const usage = markServedLocation(usageOf(response), location);
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    return { kind: "refused", category: String(blocked), usage };
  }
  const candidate = response.candidates?.[0];
  const finish = candidate?.finishReason
    ? String(candidate.finishReason)
    : null;
  if (finish && REFUSAL_FINISH_REASONS.has(finish)) {
    const rating = candidate?.safetyRatings?.find((r) => r.blocked);
    return {
      kind: "refused",
      category: rating?.category ? String(rating.category) : finish,
      usage,
    };
  }
  if (finish === "MAX_TOKENS") return { kind: "truncated", usage };
  if (finish !== "STOP") {
    // ★ The model ANSWERED (and was paid for) but did not finish normally:
    // OTHER, LANGUAGE, FINISH_REASON_UNSPECIFIED, a missing candidate.
    // This used to be a terminal `provider_unavailable` ("No provider was
    // available for this run") after three minutes of paid thinking
    // (production, 2026-10-03, run 927acb04), and nothing recorded which
    // reason it was. It is an answer that cannot be trusted as complete,
    // which is what `invalid_json` means to every caller: the generation
    // pipeline re-asks within its bounded repair attempts instead of
    // ending the run. The reason is a closed enum, never response text.
    logWarn("theme_studio.unexpected_finish_reason", {
      stage: request.stage,
      model: request.modelKey,
      finishReason: finish ?? "none",
      candidates: response.candidates?.length ?? 0,
      ...(named ? { location } : {}),
    });
    return { kind: "invalid_json", usage };
  }

  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown, usage };
  } catch {
    return { kind: "invalid_json", usage };
  }
}

export function createVertexModelClient(
  config: VertexConfig,
  options: VertexClientOptions = {},
): ThemeStudioModelClient {
  const sleep = options.sleep ?? sleepUnlessAborted;
  const random = options.random ?? Math.random;
  const checkClockMs = checkTryClockMs(options.imageReviewTryTimeoutMs);
  const { capacityAt } = options;
  const ai = new GoogleGenAI({
    enterprise: true,
    project: config.projectId,
    location: config.region,
    apiVersion: "v1",
    httpOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      // The SDK retries transient failures; the first attempt plus the Phase 0
      // retry budget. A refusal or a schema miss is never retried here.
      retryOptions: {
        attempts: THEME_STUDIO_LIMITS.modelRetries + 1,
        httpStatusCodes: SDK_RETRY_STATUS_CODES,
      },
    },
  });
  // ★ The single-attempt clients of a check sent to the US first, one per
  //   location, made when a try is first admitted there.
  const checkClients = new Map<string, GoogleGenAI>();
  const checkClientAt = (location: string): GoogleGenAI => {
    let client = checkClients.get(location);
    if (!client) {
      client = new GoogleGenAI(singleAttemptOptions(config, location));
      checkClients.set(location, client);
    }
    return client;
  };
  const tellRetry = (
    event: Parameters<NonNullable<VertexClientOptions["onRetry"]>>[0],
  ) => {
    try {
      options.onRetry?.(event);
    } catch {
      // A counter that fails costs the count, never the call.
    }
  };

  /**
   * ★★ One try of a check sent to the US first: admitted on `location`'s
   * own capacity row, on its own clock (`imageReviewTryTimeoutMs`), as one
   * SDK attempt. A 429 pauses that row (the checks' 10 to 20 s pause, which
   * the store holds to 15 s) and is never waited out here.
   */
  async function checkTryAt(
    request: StructuredRequest,
    outer: AbortSignal,
    capacity: ProviderCapacity,
    location: string,
  ): Promise<
    | { kind: "answered"; response: GenerateContentResponse }
    | {
        kind: "failed";
        code: ErrorCode;
        facts: ProviderErrorFacts;
        goesOn: boolean;
      }
  > {
    let signal = outer;
    let admitted = false;
    try {
      const response = await capacity.run(async (permit) => {
        admitted = true;
        const trySignal = AbortSignal.any([
          outer,
          AbortSignal.timeout(checkClockMs),
          permit.signal,
        ]);
        signal = trySignal;
        const client = checkClientAt(location);
        try {
          const value = await abortable(
            () =>
              client.models.generateContent(contentRequest(request, trySignal)),
            trySignal,
          );
          permit.succeeded();
          return value;
        } catch (error) {
          if (
            !trySignal.aborted &&
            classifyProviderError(error) === "rate_limited"
          ) {
            await permit
              .rateLimited(imageReviewRateLimitDelayMs(random))
              .catch(() => {
                logWarn("theme_studio.shared_cooldown_failed", {
                  stage: request.stage,
                  model: request.modelKey,
                  location,
                });
              });
          }
          throw error;
        }
      }, outer);
      return { kind: "answered", response };
    } catch (error) {
      const lost = signal.reason instanceof ProviderCapacityLost;
      const timedOut = !outer.aborted && !lost && signal.aborted;
      const code: ErrorCode = outer.aborted
        ? "cancelled"
        : lost
          ? "provider_unavailable"
          : timedOut
            ? "provider_timeout"
            : classifyProviderError(error);
      return {
        kind: "failed",
        code,
        // ★ Google's status, message and the quota it names, as on every
        //   refusal (robustness audit B23).
        facts: providerErrorFacts(error),
        // ★ Only a try that was admitted and SENT goes on: a wait the caller
        //   or its drain ended, or a permit lost mid-call, is no refusal by
        //   the US.
        goesOn:
          admitted &&
          code !== "cancelled" &&
          !lost &&
          goesOnFromUs(error, timedOut),
      };
    }
  }

  /**
   * ★★ A check sent to the US first (IMAGE_REVIEW_FIRST_LOCATION), then once
   * to the client's own location when the US refused it, its try timed out
   * or it never reached the US; the try at the client's own location is the
   * last, whatever it meets.
   */
  async function checkUsFirst(
    request: StructuredRequest,
    outer: AbortSignal,
    capacityAt: NonNullable<VertexClientOptions["capacityAt"]>,
  ): Promise<StructuredResult> {
    const route = [IMAGE_REVIEW_FIRST_LOCATION, config.region];
    for (let index = 0; ; index++) {
      const location = route[index];
      const tried = await checkTryAt(
        request,
        outer,
        capacityAt(request.providerModel, location),
        location,
      );
      if (tried.kind === "answered") {
        return answerOf(tried.response, request, location, true);
      }
      const next = route[index + 1];
      if (next === undefined || !tried.goesOn) {
        return failedCall(
          request,
          tried.code,
          index + 1,
          tried.facts,
          location,
        );
      }
      // Content-free: where the try went, where the next goes, and Google's
      // answer; never the prompt or the picture.
      logWarn("theme_studio.image_review_fallback", {
        stage: request.stage,
        model: request.modelKey,
        from: location,
        to: next,
        code: tried.code,
        ...tried.facts,
      });
      if (tried.code === "rate_limited") {
        tellRetry({
          stage: request.stage,
          providerModel: request.providerModel,
          waitMs: 0,
          location,
        });
      }
    }
  }

  return {
    provider: "vertex-gemini",
    async generate(request, outer) {
      // ★ TS-3D: a check goes to the US first when the client knows each
      //   location's capacity; one already set at the US has nowhere else.
      if (
        request.stage === "image_review" &&
        capacityAt &&
        config.region !== IMAGE_REVIEW_FIRST_LOCATION
      ) {
        return checkUsFirst(request, outer, capacityAt);
      }
      // Keep HIGH thinking and the full output allowance, but bound wall time
      // across SDK retries, auth and 429 backoff, not just one HTTP attempt.
      const capacity = capacityAt
        ? capacityAt(request.providerModel, config.region)
        : (options.capacity?.(request.providerModel) ??
          uncoordinatedProviderCapacity);
      // ★ A check (image_review) runs each try on its own clock and waits a
      //   short while after a 429 (IMAGE_REVIEW_TRY_TIMEOUT_MS, or the
      //   caller's `imageReviewTryTimeoutMs`); every other stage keeps one
      //   clock for the whole call and the long backoff.
      const perTry = request.stage === "image_review";
      const retries = perTry
        ? IMAGE_REVIEW_RATE_LIMIT_RETRIES
        : RATE_LIMIT_BACKOFF.retries;
      const delayFor = (retry: number) =>
        perTry
          ? imageReviewRateLimitDelayMs(random)
          : rateLimitDelayMs(retry, random);
      let deadline: AbortSignal | undefined;
      let signal = outer;
      let response: GenerateContentResponse | undefined;
      let waitedMs = 0;
      for (let retry = 0; !response; retry++) {
        let retryDelay: number | undefined;
        // A fresh clock for each try of a check, set when it is admitted; the
        // last try's spent clock must not judge an admission that failed.
        if (perTry) {
          deadline = undefined;
          signal = outer;
        }
        try {
          response = await capacity.run(
            async (permit) => {
              deadline ??= AbortSignal.timeout(
                perTry ? checkClockMs : REQUEST_TIMEOUT_MS,
              );
              signal = AbortSignal.any([outer, deadline, permit.signal]);
              try {
                const value = await abortable(send, signal);
                permit.succeeded();
                return value;
              } catch (error) {
                if (
                  !signal.aborted &&
                  classifyProviderError(error) === "rate_limited"
                ) {
                  retryDelay = delayFor(retry);
                  await permit.rateLimited(retryDelay).catch(() => {
                    logWarn("theme_studio.shared_cooldown_failed", {
                      stage: request.stage,
                      model: request.modelKey,
                    });
                  });
                }
                throw error;
              }
            },
            deadline ? AbortSignal.any([outer, deadline]) : outer,
          );
        } catch (error) {
          const code = outer.aborted
            ? "cancelled"
            : signal.reason instanceof ProviderCapacityLost
              ? "provider_unavailable"
              : signal.aborted
                ? "provider_timeout"
                : classifyProviderError(error);
          // ★ Google's status, message and the quota it names ride on every
          //   refusal and failure, so a quota limit can be told from the
          //   shared pool's contention (robustness audit B23).
          const facts = providerErrorFacts(error);
          const delay =
            code === "rate_limited" && retry < retries
              ? (retryDelay ?? delayFor(retry))
              : null;
          if (delay === null || waitedMs + delay > RATE_LIMIT_BACKOFF.totalMs) {
            return failedCall(request, code, retry + 1, facts);
          }
          // Stage, model and Google's answer only: never the prompt or the
          // references.
          logWarn("theme_studio.rate_limited_retry", {
            stage: request.stage,
            model: request.modelKey,
            retry: retry + 1,
            waitMs: delay,
            ...facts,
          });
          tellRetry({
            stage: request.stage,
            providerModel: request.providerModel,
            waitMs: delay,
          });
          // ★ A check's wait is the caller's time, not the refused try's: its
          //   clock would end the wait early and report a timeout that was a
          //   429. Every other stage waits inside its one clock, as before.
          const waitSignal = perTry ? outer : signal;
          if (!(await sleep(delay, waitSignal))) {
            return failedCall(
              request,
              waitSignal.aborted && !outer.aborted
                ? "provider_timeout"
                : "cancelled",
              retry + 1,
              facts,
            );
          }
          waitedMs += delay;
        }
      }

      function send() {
        return ai.models.generateContent(contentRequest(request, signal));
      }

      return answerOf(response, request, config.region, false);
    },
  };
}

// ---------------------------------------------------------------------------
// What Google said when it refused or failed a call, for the log. Shared with
// the image client (image-vertex.ts), like classifyProviderError.
//
// ★★ ONLY THE BODY TELLS THE SHARED POOL'S 429 FROM A REAL QUOTA'S
// (robustness audit B23). Google's shared pay-as-you-go pool answers exactly
//   {"error":{"code":429,"message":"Resource has been exhausted (e.g. check
//   quota).","status":"RESOURCE_EXHAUSTED"}}
// (storemink-staging, 23 Oct 2026), which names no quota. A project quota
// names itself: in google.rpc.ErrorInfo metadata (quota_metric, quota_limit,
// quota_limit_value), in google.rpc.QuotaFailure violations (quotaMetric,
// quotaId, quotaValue) or in its message ("Quota exceeded for ..."). The
// retry logs kept only the stage and the wait, so a quota limit could never
// have been seen. Adapted from errorFacts / quotaNamedIn in
// scripts/revamp-priority-test.ts (scripts/ is never imported), and not the
// same: this reading lets the quota patterns span any whitespace, also reads
// a streamed call's body after its "got status" prefix, keeps 500 characters
// of the message where the script keeps 300, and words a cause its own way.
// ★ Neither reads a QuotaFailure violation's `subject`: it names WHO was
// limited ("project:123456"), never which quota, and taking it for one would
// make the shared pool's 429 read as a project quota.
//
// ★ @google/genai's ApiError (2.27.0) carries the HTTP status as `.status`
// and, as its message, the JSON of the error body; a streamed call prefixes
// it with "got status: ...". Anything else (a timeout, an abort, a network
// failure) keeps its own words, with its cause's: "fetch failed" names why
// only there.
//
// ★ Content-free: a status, Google's message cut to 500 characters and the
// quota it names. The request never reaches this.
// ---------------------------------------------------------------------------

/** Google's error message is cut to this many characters for the log. */
export const PROVIDER_ERROR_MESSAGE_MAX = 500;
const QUOTA_NAMED_MAX = 300;

export interface ProviderErrorFacts {
  /** The HTTP status Google answered with; null when nothing came back. */
  httpStatus: number | null;
  /** The body's error.status, such as RESOURCE_EXHAUSTED. */
  errorStatus: string | null;
  /** The body's error.message, else the error's own words, cut short. */
  errorMessage: string | null;
  /** The quota the refusal names; null for the shared pool's, which names
   *  none. */
  quotaNamed: string | null;
}

export function providerErrorFacts(error: unknown): ProviderErrorFacts {
  const own = wordsOf(error);
  const body = own ? errorBodyOf(own) : null;
  const cause = body ? null : wordsOf(objectOf(error)?.cause);
  const message =
    textOf(body?.message) ??
    (own && cause ? `${own}; cause: ${cause}` : (own ?? cause));
  return {
    httpStatus: status(error),
    errorStatus: textOf(body?.status),
    errorMessage:
      message
        ?.replace(/\s+/g, " ")
        .trim()
        .slice(0, PROVIDER_ERROR_MESSAGE_MAX) || null,
    quotaNamed: quotaNamedIn(body?.details, message ?? ""),
  };
}

/** "Quota exceeded for quota metric 'X' ..." (Google's older form) or
 *  "Quota exceeded for aiplatform.googleapis.com/x with base model: ..."
 *  (Vertex). The shared pool's "Resource has been exhausted (e.g. check
 *  quota)." matches neither. */
const QUOTA_QUOTED =
  /quota\s+exceeded\s+for\s+(?:quota\s+metric\s+)?'([^']+)'/i;
const QUOTA_BARE = /quota\s+exceeded\s+for\s+([a-z0-9_.\/-]+)/i;

function quotaInText(value: string): string | null {
  return (QUOTA_QUOTED.exec(value) ?? QUOTA_BARE.exec(value))?.[1] ?? null;
}

/** The quota a refusal names: ErrorInfo's metadata, QuotaFailure's
 *  violations, else the message's own words; null when none is named. */
export function quotaNamedIn(details: unknown, message: string): string | null {
  const named: string[] = [];
  for (const detail of Array.isArray(details) ? details : []) {
    const metadata = objectOf(objectOf(detail)?.metadata);
    const metric = textOf(metadata?.quota_metric);
    const limit = textOf(metadata?.quota_limit);
    const value = textOf(metadata?.quota_limit_value);
    if (metric || limit) {
      named.push(
        [
          metric ?? limit,
          metric && limit ? `limit ${limit}` : null,
          value ? `value ${value}` : null,
        ]
          .filter(Boolean)
          .join(", "),
      );
    }
    const violations = objectOf(detail)?.violations;
    for (const violation of Array.isArray(violations) ? violations : []) {
      const v = objectOf(violation);
      // ★ Not `subject`: it names who was limited (a project, a client IP),
      //   never which quota.
      const quota =
        textOf(v?.quotaMetric) ??
        textOf(v?.quotaId) ??
        quotaInText(textOf(v?.description) ?? "");
      // An int64 arrives as a string in JSON; a number is read too.
      const raw = v?.quotaValue;
      const amount = typeof raw === "number" ? String(raw) : textOf(raw);
      if (quota) named.push(amount ? `${quota}, value ${amount}` : quota);
    }
  }
  if (!named.length) {
    const fromMessage = quotaInText(message);
    if (fromMessage) named.push(fromMessage);
  }
  return named.length
    ? [...new Set(named)].join("; ").slice(0, QUOTA_NAMED_MAX)
    : null;
}

/** The error object of a JSON error body, read whole or after a "got status"
 *  prefix; a body sent as a one-element list is read too. */
function errorBodyOf(message: string): Record<string, unknown> | null {
  const start = message.indexOf("{");
  const candidates = start > 0 ? [message, message.slice(start)] : [message];
  for (const candidate of candidates) {
    try {
      const body: unknown = JSON.parse(candidate);
      const error = objectOf(
        objectOf(Array.isArray(body) ? body[0] : body)?.error,
      );
      if (error) return error;
    } catch {
      // Not JSON from here: try the next start, else keep the words.
    }
  }
  return null;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A string error, or the message of an Error or an error-like object; never
 *  "[object Object]". */
function wordsOf(value: unknown): string | null {
  return typeof value === "string"
    ? textOf(value)
    : textOf(objectOf(value)?.message);
}
