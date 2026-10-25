// Shared Gemini access for every AI copy feature: product descriptions and
// SEO, brand-voice setup and coupon emails (each spends a Mink credit), plus
// the public Help assistant, Help search and the Help console's AI command
// (none of which do). Plain server module, NOT a "use server" file, so it can
// export sync helpers, constants and types alongside the call.
//
// The brand "soul" is PER-STORE data: lib/ai/brand-voice.ts
// (store_brand_profiles); it replaced an earlier file-based loader.
//
// TWO BACKENDS, chosen at call time:
//   * the Gemini Developer API whenever GEMINI_API_KEY is set (local and
//     staging, where it is free). It has no location.
//   * Vertex AI through Application Default Credentials when only
//     GCP_PROJECT_ID is set (production): a bearer token, no API key.
// The request body and the reply are the same on both; only the address and
// the auth header differ. Callers see the same {text, error} contract.
//
// ★★ THE MODEL IS gemini-3.5-flash-lite, WITH gemini-3.5-flash AS ITS
// FALLBACK (owner's decision, 2026-10-23; robustness audit B2). It was
// gemini-2.5-flash, whose Vertex retirement date was 20 Oct, and moving off it
// took code, not a setting: the request switched thinking off with
// `thinkingBudget: 0`, a 2.5-only knob newer models may refuse. It now asks for
// LOW thinking in the shape lib/mink/conversation-namer.ts already runs live
// with gemini-3.5-flash-lite through @google/genai, written out in REST form.
// The SDK's request converters (generateContentConfigToVertex and
// generateContentConfigToMldev) copy `config.thinkingConfig` to
// `generationConfig.thinkingConfig` unchanged on both backends, and
// `ThinkingLevel.LOW` is the string "LOW", so the wire shape is exactly
// `{ thinkingConfig: { thinkingLevel: "LOW" } }`.
//
// ★★ AT MOST TWO ATTEMPTS: THE MAIN MODEL, THEN THE FALLBACK, 30 s EACH.
// This replaced a loop of three tries on ONE model, 0.6 s and 1.2 s apart,
// with no time limit at all. A busy pool is still busy 1.8 s later, so those
// tries hit the same wall, and with no deadline one stalled request held the
// merchant's spinner for as long as the socket stayed open. Now each attempt
// has its own clock (its token, request and reply all inside it). A 408, 429,
// 5xx, dropped connection or timeout on the main model is asked once more on
// the fallback, which is a different model and, on Vertex, the Mink chat's
// fallback region (MINK_FALLBACK_LOCATION, asia-south1 by default): another
// capacity pool, the one the chat already fails over to. A 400, 403 or 404 on
// the MAIN model goes there too, so a retired or misconfigured model cannot
// take Generate with AI down. Anything on the fallback is final. Worst case
// about a minute.
//
// ★ WHAT THE MERCHANT READS is one of three plain sentences (no status, no
// model, never "quota" for Google's refusal, which is not the store's quota);
// the detail goes to the log. Every caller either gave the credit back or
// never took one, so each sentence can say nothing was charged.

import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getMinkConfig } from "@/lib/mink/config";
import { hasLongDash, withoutLongDashes } from "@/lib/text/long-dashes";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-3.5-flash";

/** One attempt (credentials, request and reply) never takes longer than this. */
export const GEMINI_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Added to every caller's answer budget. ★ LOW thinking draws on the same
 * output allowance as the answer (Theme Studio measured it: Gemini counts
 * thoughts and answer against one maxOutputTokens), and the budgets callers
 * pass were sized when thinking was off. Without the headroom a 512-token SEO
 * reply could be cut short by its own reasoning and fail as MAX_TOKENS. Unused
 * headroom costs nothing: only generated tokens are billed.
 */
export const THINKING_HEADROOM_TOKENS = 1_024;

/** Google was busy or slow on an attempt, and nothing answered. */
export const AI_BUSY_MESSAGE =
  "AI is busy right now. Nothing was charged; try again in a minute.";
/** A configuration problem: credentials, a refused model, a bad request. */
export const AI_UNAVAILABLE_MESSAGE =
  "AI isn't available right now. Nothing was charged.";
/** The model answered, but with nothing usable (empty, blocked, cut short). */
export const AI_UNUSABLE_MESSAGE =
  "AI couldn't finish writing this. Nothing was charged; try again.";

/**
 * The same message without its "Nothing was charged" claim, for a request
 * whose credit could not be given back (refundAiQuota answered "failed", which
 * it logs for an operator to grant back). ★ The merchant is never told nothing
 * was charged while the credit stays spent. Any other message comes back as
 * it is.
 */
export function withoutNothingChargedClaim(message: string): string {
  switch (message) {
    case AI_BUSY_MESSAGE:
      return "AI is busy right now. Try again in a minute.";
    case AI_UNAVAILABLE_MESSAGE:
      return "AI isn't available right now.";
    case AI_UNUSABLE_MESSAGE:
      return "AI couldn't finish writing this. Try again.";
    default:
      return message;
  }
}

/** The most of one long merchant-typed field a prompt carries (notes, a
 *  description, an instruction). */
export const AI_PROMPT_FIELD_MAX = 4_000;
/** The most of one short field a prompt carries (a name, a label, a code). */
export const AI_PROMPT_SHORT_FIELD_MAX = 300;

/**
 * A merchant's text as a prompt may carry it: trimmed and cut to `max`
 * characters ("" for anything that is not text).
 *
 * ★★ SERVER-SIDE, BECAUSE A SERVER ACTION IS REACHABLE WITHOUT ITS FORM, and
 *   since a failed request gives its credit back (audit B1), input size was
 *   the one thing left to bound what one request costs Google: a field of
 *   megabytes would reach the model, both attempts could run out of time and
 *   both be billed, and the merchant would get the credit back. ★ CUT, NOT
 *   REFUSED: copy needs only the start of a long description, and refusing
 *   would stop Generate SEO working for a product with a long one.
 */
export function promptText(value: unknown, max = AI_PROMPT_FIELD_MAX): string {
  if (typeof value !== "string") return "";
  let text = value.trim();
  if (text.length > max) {
    text = text.slice(0, max);
    // Never end on half of a surrogate pair (an emoji cut in two).
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

// ★ AN OVERRIDE MAY ONLY PIN A VERSION OF THE SAME FAMILY, the rule
// lib/mink/config.ts applies to MINK_LITE_MODEL: a typo or another family must
// not quietly become the model every merchant's copy is written by. The main
// model must be a Flash-Lite id and the fallback a Flash id; either may carry
// a version pin ("-001", "-09-2026", "-preview-06-17"). A suffix that starts
// with a letter names a different model ("-lite" on the fallback, "-tts",
// "-image") and is refused, as is anything else; a refused value falls back to
// the default. ★ `.env` files that still say gemini-2.5-flash are refused here,
// which is the point of B2.
const VERSION_PIN = "(?:-(?:preview-)?\\d[0-9a-z.-]*)?";
const FLASH_LITE_FAMILY = new RegExp(
  `^gemini-\\d+(?:\\.\\d+)?-flash-lite${VERSION_PIN}$`,
);
const FLASH_FAMILY = new RegExp(
  `^gemini-\\d+(?:\\.\\d+)?-flash${VERSION_PIN}$`,
);

const reportedOverrides = new Set<string>();

function pinnedModel(
  variable: string,
  value: string | undefined,
  family: RegExp,
  fallback: string,
): string {
  const model = value?.trim().toLowerCase();
  if (!model) return fallback;
  if (family.test(model)) return model;
  // Once per process and value: whoever set it needs to know it is ignored,
  // not on every generation.
  const key = `${variable}=${model}`;
  if (!reportedOverrides.has(key)) {
    reportedOverrides.add(key);
    logWarn("ai.generate: model override ignored", {
      variable,
      model,
      using: fallback,
    });
  }
  return fallback;
}

/** The two models Generate with AI uses, read at call time. */
export function geminiModels(): { main: string; fallback: string } {
  return {
    main: pinnedModel(
      "GEMINI_MODEL",
      process.env.GEMINI_MODEL,
      FLASH_LITE_FAMILY,
      DEFAULT_GEMINI_MODEL,
    ),
    fallback: pinnedModel(
      "GEMINI_FALLBACK_MODEL",
      process.env.GEMINI_FALLBACK_MODEL,
      FLASH_FAMILY,
      DEFAULT_GEMINI_FALLBACK_MODEL,
    ),
  };
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

// ★ THE VERTEX HOST FOLLOWS THE KIND OF LOCATION, the rule @google/genai
// applies (its MULTI_REGIONAL_LOCATIONS): `global` has no prefix, the two
// multi-regions use the regional-endpoint host, and a region prefixes the
// host. The old rule prefixed every location that was not global, which is a
// host that does not exist for the multi-regions. Nothing here routes to a
// multi-region (the main model stays at GCP_LOCATION, global by default, and
// the fallback at the Mink fallback location); the rule is right for them so
// that no location setting can produce a dead address.
const MULTI_REGIONS = new Set(["us", "eu"]);

/** The Vertex AI host serving `location`. Pure. */
export function vertexHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (MULTI_REGIONS.has(location)) {
    return `aiplatform.${location}.rep.googleapis.com`;
  }
  return `${location}-aiplatform.googleapis.com`;
}

type GoogleAuthClient = Awaited<
  ReturnType<import("google-auth-library").GoogleAuth["getClient"]>
>;
let authClient: Promise<GoogleAuthClient> | null = null;

/**
 * A Google Cloud access token from Application Default Credentials. Lazily
 * imported so the Developer API path never loads the auth library. ★ One client
 * per process (lib/mink/voice-transcription.ts does the same): it caches its
 * token and refreshes it itself, where a new client per call fetched a fresh
 * token from the metadata server every time. A failed client is forgotten so
 * the next call can try again. An `error` when credentials cannot be
 * resolved (no ADC on this machine, or a token request that failed).
 */
async function vertexAccessToken(): Promise<
  { token: string } | { error: string }
> {
  const client = (authClient ??= import("google-auth-library").then(
    ({ GoogleAuth }) =>
      new GoogleAuth({
        scopes: "https://www.googleapis.com/auth/cloud-platform",
      }).getClient(),
  ));
  try {
    const { token } = await (await client).getAccessToken();
    if (token) return { token };
    if (authClient === client) authClient = null;
    return { error: "no token" };
  } catch (error) {
    // Forget only the client that failed: a concurrent caller may already
    // have replaced it with one that works.
    if (authClient === client) authClient = null;
    return { error: errorText(error) };
  }
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

// The brand soul becomes Gemini's system instruction: its persistent identity.
export function brandSystemText(brand: string): string {
  return `${brand}

The text above is the brand's soul: its voice, tone, values and vocabulary. You ARE this brand speaking. Everything you write must sound exactly like it.`;
}

// StoreMink copy never uses a long dash, and models reach for them constantly.
// Every AI copy feature goes through callGemini, so the rule is added here once
// and the reply is cleaned of any dash the model wrote anyway.
export const NO_LONG_DASH_RULE =
  'Never use an em dash or an en dash. Use a comma, a colon, a full stop or a plain hyphen instead, and write number ranges as "2 to 4".';

export interface GeminiOptions {
  temperature?: number;
  /**
   * The ANSWER's budget in tokens (default 1,024). The request asks for this
   * plus THINKING_HEADROOM_TOKENS, because LOW thinking shares the allowance.
   */
  maxOutputTokens?: number;
  /** "application/json" together with `responseJsonSchema` for a JSON reply. */
  responseMimeType?: string;
  /**
   * A JSON Schema for the reply, sent as `responseJsonSchema`: the field
   * lib/mink and lib/theme-studio send live through @google/genai, whose
   * converters pass it through unchanged on both backends. Standard JSON
   * Schema in Gemini's subset: lowercase types, `properties`, `required`,
   * `items`, item counts, `enum`, `additionalProperties`; no string bounds.
   */
  responseJsonSchema?: Record<string, unknown>;
  /** Stops the call, and any retry, when it aborts. */
  signal?: AbortSignal;
}

type Backend = "vertex" | "developer";

interface Target {
  role: "main" | "fallback";
  model: string;
  /** Vertex only; the Developer API has no location. */
  location: string | null;
}

type AttemptKind =
  | "ok"
  // 2xx, but empty, blocked, cut short or not readable: final.
  | "unusable"
  // 408, 429, 5xx, a dropped connection or the attempt's own deadline.
  | "busy"
  // 400, 403 or 404: a bad request, a refused or retired model.
  | "refused"
  // No credentials, a 401, any other client error.
  | "config"
  // The caller's own signal aborted.
  | "cancelled";

/** Content-free: what the log may say about one attempt. */
interface AttemptDetail {
  attempt: number;
  role: Target["role"];
  model: string;
  location: string;
  kind: AttemptKind;
  reason: string;
  ms: number;
  status?: number;
  googleStatus?: string;
  /** Google's own message, cut to 500 characters. */
  message?: string;
}

interface Usage {
  promptTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

interface AttemptOutcome {
  detail: AttemptDetail;
  text?: string;
  usage?: Usage;
}

/** Google's error message, at most this long, in a log line. */
const PROVIDER_MESSAGE_MAX = 500;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, PROVIDER_MESSAGE_MAX);
}

/** Google's `{ error: { status, message } }`, read without trusting it. Pure. */
function providerError(raw: string): {
  googleStatus?: string;
  message?: string;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const error =
      first && typeof first === "object"
        ? (first as { error?: { status?: unknown; message?: unknown } }).error
        : undefined;
    const status = error?.status;
    const message = error?.message;
    return {
      googleStatus: typeof status === "string" ? status : undefined,
      message:
        typeof message === "string"
          ? message.slice(0, PROVIDER_MESSAGE_MAX)
          : undefined,
    };
  } catch {
    const message = raw.trim().slice(0, PROVIDER_MESSAGE_MAX);
    return message ? { message } : {};
  }
}

function kindForStatus(status: number): AttemptKind {
  if (status === 408 || status === 429 || status >= 500) return "busy";
  if (status === 400 || status === 403 || status === 404) return "refused";
  return "config";
}

interface GeminiReply {
  candidates?: {
    content?: { parts?: { text?: unknown; thought?: unknown }[] };
    finishReason?: unknown;
  }[];
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

/** Reads a 2xx reply. Thought parts are never the answer. Pure. */
function readReply(raw: string): {
  text?: string;
  reason: string;
  usage?: Usage;
} {
  let reply: GeminiReply | null;
  try {
    reply = JSON.parse(raw) as GeminiReply;
  } catch {
    return { reason: "unreadable" };
  }
  const usage: Usage = {
    promptTokens: reply?.usageMetadata?.promptTokenCount,
    outputTokens: reply?.usageMetadata?.candidatesTokenCount,
    thoughtTokens: reply?.usageMetadata?.thoughtsTokenCount,
    totalTokens: reply?.usageMetadata?.totalTokenCount,
  };
  const candidate = reply?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => part?.thought !== true)
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
  const finishReason = candidate?.finishReason;
  const finish = typeof finishReason === "string" ? finishReason : null;
  const blocked = reply?.promptFeedback?.blockReason;
  if (!text) {
    return {
      reason:
        typeof blocked === "string"
          ? `blocked_${blocked}`
          : finish
            ? `empty_${finish}`
            : "empty",
      usage,
    };
  }
  // ★ A reply cut short (MAX_TOKENS) or stopped for safety is not the copy
  // the merchant asked for, however it reads: half a description is refunded,
  // not delivered.
  if (finish && finish !== "STOP") return { reason: `finish_${finish}`, usage };
  return { text, reason: "ok", usage };
}

async function sendAttempt(
  input: {
    backend: Backend;
    target: Target;
    projectId: string | undefined;
    apiKey: string | undefined;
    body: string;
  },
  signal: AbortSignal,
): Promise<
  Omit<AttemptOutcome, "detail"> & {
    kind: AttemptKind;
    reason: string;
    status?: number;
    googleStatus?: string;
    message?: string;
  }
> {
  const { target } = input;
  let url: string;
  let auth: Record<string, string>;
  if (input.backend === "vertex") {
    const location = target.location ?? "global";
    const credentials = await vertexAccessToken();
    if ("error" in credentials) {
      return {
        kind: "config",
        reason: "no_credentials",
        message: credentials.error,
      };
    }
    url = `https://${vertexHost(location)}/v1/projects/${input.projectId}/locations/${location}/publishers/google/models/${target.model}:generateContent`;
    auth = { Authorization: `Bearer ${credentials.token}` };
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${target.model}:generateContent`;
    auth = { "x-goog-api-key": input.apiKey ?? "" };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: input.body,
      cache: "no-store",
      signal,
    });
  } catch (error) {
    return {
      kind: "busy",
      reason: signal.aborted ? "timeout" : "network",
      message: errorText(error),
    };
  }

  let raw: string;
  try {
    raw = await res.text();
  } catch (error) {
    return {
      kind: "busy",
      reason: signal.aborted ? "timeout" : "network",
      status: res.status,
      message: errorText(error),
    };
  }

  if (!res.ok) {
    return {
      kind: kindForStatus(res.status),
      reason: `status_${res.status}`,
      status: res.status,
      ...providerError(raw),
    };
  }
  const reply = readReply(raw);
  return reply.text
    ? { kind: "ok", reason: "ok", text: reply.text, usage: reply.usage }
    : { kind: "unusable", reason: reply.reason, usage: reply.usage };
}

/**
 * One attempt on one target, inside its own deadline. ★ The deadline is a race
 * as well as an abort, so the attempt ends on time even if the fetch (or the
 * token request) does not stop when told to. The caller's signal ends it at
 * once as `cancelled`.
 */
async function runAttempt(input: {
  attempt: number;
  backend: Backend;
  target: Target;
  projectId: string | undefined;
  apiKey: string | undefined;
  body: string;
  signal: AbortSignal | undefined;
}): Promise<AttemptOutcome> {
  const startedAt = Date.now();
  const outcomeOf = (
    result: Awaited<ReturnType<typeof sendAttempt>>,
  ): AttemptOutcome => ({
    text: result.text,
    usage: result.usage,
    detail: {
      attempt: input.attempt,
      role: input.target.role,
      model: input.target.model,
      location: input.target.location ?? "developer-api",
      kind: result.kind,
      reason: result.reason,
      ms: Date.now() - startedAt,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.googleStatus ? { googleStatus: result.googleStatus } : {}),
      ...(result.message ? { message: result.message } : {}),
    },
  });
  if (input.signal?.aborted) {
    return outcomeOf({ kind: "cancelled", reason: "cancelled" });
  }

  const controller = new AbortController();
  let stop: (outcome: AttemptOutcome) => void = () => {};
  const stopped = new Promise<AttemptOutcome>((resolve) => {
    stop = resolve;
  });
  const timer = setTimeout(() => {
    controller.abort();
    stop(outcomeOf({ kind: "busy", reason: "timeout" }));
  }, GEMINI_ATTEMPT_TIMEOUT_MS);
  const onCallerAbort = () => {
    controller.abort();
    stop(outcomeOf({ kind: "cancelled", reason: "cancelled" }));
  };
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    return await Promise.race([
      sendAttempt(input, controller.signal).then(outcomeOf),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function requestBody(
  systemText: string,
  userText: string,
  options: GeminiOptions,
): string {
  return JSON.stringify({
    systemInstruction: {
      parts: [{ text: `${systemText}\n\n${NO_LONG_DASH_RULE}` }],
    },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens:
        (options.maxOutputTokens ?? 1024) + THINKING_HEADROOM_TOKENS,
      thinkingConfig: { thinkingLevel: "LOW" },
      ...(options.responseMimeType
        ? { responseMimeType: options.responseMimeType }
        : {}),
      ...(options.responseJsonSchema
        ? { responseJsonSchema: options.responseJsonSchema }
        : {}),
    },
  });
}

/**
 * One shared call into Gemini: the main model, then once on the fallback when
 * the main model was busy, slow or refused (see the header). Returns the text,
 * or one of the three plain messages above. Credentials are read here and
 * never leave the server; prompts and replies are never logged.
 */
export async function callGemini(
  systemText: string,
  userText: string,
  options: GeminiOptions = {},
): Promise<{ text?: string; error?: string }> {
  const startedAt = Date.now();
  // Resolve the backend at call time (so env stubbing and hot config work).
  //
  // Backend precedence: the FREE Gemini Developer API key wins whenever one
  // is set (local and staging set GEMINI_API_KEY so their AI costs nothing),
  // and Vertex AI through ADC (GCP_PROJECT_ID) is used only when no key is
  // present. Production omits GEMINI_API_KEY and sets GCP_PROJECT_ID.
  const apiKey = process.env.GEMINI_API_KEY?.trim() || undefined;
  const projectId = process.env.GCP_PROJECT_ID?.trim() || undefined;
  const backend: Backend = apiKey ? "developer" : "vertex";
  if (!apiKey && !projectId) {
    logError("ai.generate: not configured", undefined, {
      reason: "neither GEMINI_API_KEY nor GCP_PROJECT_ID is set",
    });
    return { error: AI_UNAVAILABLE_MESSAGE };
  }

  const models = geminiModels();
  const targets: Target[] =
    backend === "vertex"
      ? [
          {
            role: "main",
            model: models.main,
            location: process.env.GCP_LOCATION?.trim() || "global",
          },
          {
            role: "fallback",
            model: models.fallback,
            // ★ The Mink chat's own fallback region, read through its config
            // so one setting (MINK_FALLBACK_LOCATION) moves both.
            location: getMinkConfig().fallbackLocation,
          },
        ]
      : [
          { role: "main", model: models.main, location: null },
          { role: "fallback", model: models.fallback, location: null },
        ];
  const body = requestBody(systemText, userText, options);

  const attempts: AttemptDetail[] = [];
  let last: AttemptOutcome | null = null;
  for (const target of targets) {
    last = await runAttempt({
      attempt: attempts.length + 1,
      backend,
      target,
      projectId,
      apiKey,
      body,
      signal: options.signal,
    });
    const detail = last.detail;
    attempts.push(detail);
    if (detail.kind === "ok") break;
    const toFallback =
      target.role === "main" &&
      (detail.kind === "busy" || detail.kind === "refused");
    if (!toFallback) break;
    // ★ A refusal on the main model is an error even when the fallback then
    // answers: a retired or misconfigured model would otherwise run every
    // generation on the fallback, unnoticed, for good.
    if (detail.kind === "refused") {
      logError("ai.generate: main model refused", undefined, {
        backend,
        ...detail,
      });
    } else {
      logWarn("ai.generate: main model failed, asking the fallback", {
        backend,
        ...detail,
      });
    }
  }

  const final = last!.detail;
  if (final.kind === "ok" && last!.text) {
    const usage = last!.usage ?? {};
    logInfo("ai.generate: ok", {
      backend,
      model: final.model,
      location: final.location,
      attempts: attempts.length,
      ms: Date.now() - startedAt,
      ...usage,
    });
    const text = last!.text;
    return { text: hasLongDash(text) ? withoutLongDashes(text) : text };
  }

  const context = { backend, attempts, ms: Date.now() - startedAt };
  if (final.kind === "cancelled") {
    logInfo("ai.generate: cancelled by the caller", context);
    return { error: AI_BUSY_MESSAGE };
  }
  logError("ai.generate: failed", undefined, context);
  if (final.kind === "unusable") return { error: AI_UNUSABLE_MESSAGE };
  // ★ Busy if Google was busy or slow on ANY attempt: the main model's pool is
  // likely to answer in a minute even when the fallback refused. Unavailable
  // only when every attempt failed for a reason waiting will not fix.
  return {
    error: attempts.some((attempt) => attempt.kind === "busy")
      ? AI_BUSY_MESSAGE
      : AI_UNAVAILABLE_MESSAGE,
  };
}
