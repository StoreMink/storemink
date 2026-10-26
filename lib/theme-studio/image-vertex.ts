import "server-only";

import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Modality,
  ProminentPeople,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
  type ThinkingLevel,
} from "@google/genai";
import { logInfo, logWarn } from "@/lib/observability/logger";
import { classifyProviderError, providerErrorFacts } from "./gemini-vertex";
import { abortable } from "./abortable";
import { imageRequestPool } from "./image-request-pool";
import {
  uncoordinatedProviderCapacity,
  ProviderCapacityLost,
  type ProviderCapacity,
} from "./provider-capacity";
import type { ImageCallUsage } from "./cost";
import {
  imageRequestConfig,
  type RequestedImageSize,
  type ThemeStudioImageConfig,
} from "./image-models";
import {
  ZERO_IMAGE_USAGE,
  assertThemeImageRequest,
  type ImageUsage,
  type ThemeImageReference,
  type ThemeImageRequest,
  type ThemeImageResult,
  type ThemeStudioImageClient,
} from "./image-provider";
import {
  RATE_LIMIT_BACKOFF,
  SHARED_RATE_LIMIT_PAUSE_MAX_MS,
  rateLimitDelayMs,
  sleepUnlessAborted,
} from "./rate-limit-backoff";

// ---------------------------------------------------------------------------
// Gemini image generation on Vertex AI, for Theme Studio ONLY.
//
// ★ ONE PAID ATTEMPT PER IMAGE. A timeout or a 5xx may come after the model ran
// and billed, so the SDK does not retry (merchant Mink's rule). Only a 429 is
// retried: Vertex refuses a rate-limited request before running the model, so
// another attempt cannot charge twice.
//
// ★★ A REFUSED IMAGE GOES BACK THROUGH THE START PACER, NOT TO SLEEP
// (owner's decision, 2026-10-23). It waits at most the shared pause it
// registers for everyone else (SHARED_RATE_LIMIT_PAUSE_MAX_MS, 15 s), then
// queues again; the shared capacity spaces image starts and widens the gap
// after the refusal (IMAGE_START_PACING, provider-capacity.ts). It used to
// sleep its own 7.5 to 120 s on top, so a slot sat idle for minutes while the
// line had room. Still at most five retries.
//
// ★ THE SAFETY SETTINGS ARE FIXED HERE, NOT PASSED IN, and match Mink's
// verified call: four harm filters at BLOCK_LOW_AND_ABOVE, prominent people
// blocked, one JPEG candidate. The one per-request value is whether ADULTS
// may appear (request.people, chosen by the Stage A brief under prompt v28,
// the setting Mink's Refine already uses); children are never allowed.
// A theme's demo images must meet the same bar as a merchant's.
// Gemini-generated images carry SynthID by default on Vertex.
//
// ★★ THE SIZE AND THE THINKING LEVEL ARE THE CALLER'S (owner, 25 Oct 2026):
// each caller states both when it makes the client (Theme Studio's worker:
// 2K, the homepage hero slides 4K, HIGH; the redesign's photos: 2K, MEDIUM),
// and image-models.ts imageRequestConfig fits the request to the model that
// receives it: never a sampling parameter to Nano Banana 2.1, and no thinking
// config to the owner's Pro rollback (whose request is otherwise the same).
//
// ★ A REFUSAL IS A NORMAL OUTCOME, NOT AN ERROR, and there is no fallback to
// another model (the registry rule). Its reason goes back to the caller; the
// provider's own error text goes only to the log, never into a stored result.
//
// References are sent INLINE (Theme Studio's assets are rows in Postgres, not
// objects in a bucket), each after a text label naming its role.
// ---------------------------------------------------------------------------

const SAFETY_CATEGORIES = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
] as const;

/** A 2K Pro image with one reference measured 26 s, and Nano Banana 2.1 drew
 *  2K photos in 16 to 24 s and a 4K hero in 41 s (25 Oct 2026); a request
 *  carrying up to three references on a busy shared project is given generous
 *  room, since a timed-out image may still have been billed. */
export const IMAGE_REQUEST_TIMEOUT_MS = 180_000;

/** What one picture is drawn with, as its caller stated it: the model the
 *  request goes to, the size and how long 2.1 thinks before it draws. */
export interface ThemeImageSettings {
  model: string;
  imageSize: RequestedImageSize;
  thinkingLevel: ThinkingLevel;
}

/** The provider configuration for one image, fitted to the model that
 *  receives it (image-models.ts imageRequestConfig). Exported so a test can
 *  pin every safety value rather than trust a comment. Throws, before
 *  anything is sent, for a request that states no size. */
export function themeImageConfig(
  request: ThemeImageRequest,
  settings: ThemeImageSettings,
): GenerateContentConfig {
  return imageRequestConfig(settings.model, {
    // Gemini image models require TEXT together with IMAGE; only the final
    // image part is kept (parseThemeImageResponse).
    responseModalities: [Modality.TEXT, Modality.IMAGE],
    candidateCount: 1,
    safetySettings: SAFETY_CATEGORIES.map((category) => ({
      category,
      threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
    })),
    imageConfig: {
      aspectRatio: request.aspectRatio,
      imageSize: settings.imageSize,
      // Adults only when the brief asked for them (request.people, prompt
      // v28); never children, and prominent people stay blocked either way.
      personGeneration:
        request.people === "adults" ? "ALLOW_ADULT" : "ALLOW_NONE",
      prominentPeople: ProminentPeople.BLOCK_PROMINENT_PEOPLE,
      outputMimeType: "image/jpeg",
      outputCompressionQuality: 95,
    },
    // Sent to Nano Banana 2.1 only (imageRequestConfig).
    thinkingConfig: { thinkingLevel: settings.thinkingLevel },
  });
}

/** The label each reference is sent after, the word the prompt names it by. */
const REFERENCE_LABELS: Record<ThemeImageReference["role"], string> = {
  anchor: "ANCHOR:",
  set: "SET:",
  // A Mink storefront redesign's own product photograph (B16).
  product: "PRODUCT:",
};

/** The request's parts: the prompt, then each reference after its label. */
export function themeImageParts(request: ThemeImageRequest): Part[] {
  return [
    { text: request.prompt },
    ...request.references.flatMap((reference) => [
      { text: REFERENCE_LABELS[reference.role] },
      {
        inlineData: { mimeType: reference.mediaType, data: reference.base64 },
      },
    ]),
  ];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

/**
 * The usage of one answer, as it is priced and stored. ★ Since 25 Oct 2026 it
 * also counts the thinking Google billed (`thoughtsTokenCount`: about 1,250
 * to 1,360 tokens a photo at HIGH on Nano Banana 2.1, none reported at
 * MINIMAL) and names the model that answered, so cost.ts prices it at that
 * model's rates, and a saved draw that is replayed still says which model it
 * came from. A picture's tokens are `outputTokens` (candidatesTokenCount); the
 * draft picture sent before it is not counted there (cost.ts).
 */
export function imageUsageOf(
  response: GenerateContentResponse | null | undefined,
  model?: string,
): ImageUsage {
  const usage = response?.usageMetadata;
  if (!usage) return ZERO_IMAGE_USAGE;
  const counted: ImageCallUsage = {
    inputTokens: count(usage.promptTokenCount),
    outputTokens: count(usage.candidatesTokenCount),
    thinkingTokens: count(usage.thoughtsTokenCount),
  };
  if (model) counted.model = model;
  return counted;
}

const OUTPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Reads one response into a result: the final image, a refusal with its
 *  reason, or an unexplained empty answer. `model` is the model that
 *  answered, named in the usage (imageUsageOf).
 *  ★★ THE FINAL IMAGE IS THE LAST IMAGE PART THAT IS NOT A THOUGHT
 *  (2026-10-23). Since about 22 Oct, gemini-3-pro-image answers with a draft
 *  first: a "thought" image (`thought: true`) at about 1 MP, then the picture
 *  at the size asked for (storemink-staging, a 21:9 2K request: a 1584x672
 *  thought image, then 3168x1344). Keeping the first inline part kept the
 *  draft, so every photo came back at 1K. ★ Nano Banana 2.1 sends a draft
 *  before EVERY final picture (11 of 11 answers on storemink-staging,
 *  25 Oct 2026), and at HIGH thinking two thought TEXT parts as well. ★ A
 *  thought image is never kept, even alone: it is a draft, and the final
 *  picture may have been withheld. */
export function parseThemeImageResponse(
  response: GenerateContentResponse,
  model?: string,
): ThemeImageResult {
  const usage = imageUsageOf(response, model);
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    return {
      kind: "refused",
      reason:
        response.promptFeedback?.blockReasonMessage?.trim() || String(blocked),
      usage,
    };
  }
  const candidate = response.candidates?.[0];
  const inline = (candidate?.content?.parts ?? [])
    .filter((part) => part.thought !== true && Boolean(part.inlineData?.data))
    .at(-1)?.inlineData;
  const finish = candidate?.finishReason
    ? String(candidate.finishReason)
    : null;
  if (inline?.data) {
    const mediaType = (inline.mimeType || "image/jpeg").toLowerCase();
    if (!OUTPUT_TYPES.has(mediaType)) {
      return { kind: "error", code: "provider_rejected", usage };
    }
    return {
      kind: "ok",
      bytes: new Uint8Array(Buffer.from(inline.data, "base64")),
      mediaType: mediaType as "image/jpeg" | "image/png" | "image/webp",
      usage,
    };
  }
  // No image. A named stop is the provider withholding it; nothing at all is
  // an unexplained failure, never an empty success.
  if (finish && finish !== "STOP") {
    return {
      kind: "refused",
      reason: candidate?.finishMessage?.trim() || finish,
      usage,
    };
  }
  return { kind: "error", code: "provider_unavailable", usage };
}

export interface ImageClientOptions {
  /**
   * ★★ The size every picture is drawn at, stated by the caller (owner,
   * 25 Oct 2026): one size, or one chosen per request (Theme Studio's
   * homepage hero slides at 4K, image-models.ts themeStudioImageSize).
   */
  imageSize:
    | RequestedImageSize
    | ((request: ThemeImageRequest) => RequestedImageSize);
  /** ★★ How long Nano Banana 2.1 thinks before it draws, stated by the
   *  caller; sent to 2.1 only (image-models.ts imageRequestConfig). */
  thinkingLevel: ThinkingLevel;
  /**
   * ★★ Say when a call our own stop ended while its last try was on the wire
   * (`timing.stoppedInFlight`, robustness audit B3): sent, not refused with
   * 429, and unanswered when `outer` aborted, so Google may have drawn and
   * billed it. For a caller that keeps its own account of every call (the
   * storefront redesign's photos); Theme Studio's own runs never ask, so the
   * results they return and journal are as they were.
   */
  markStoppedInFlight?: boolean;
  /** Test seams; production uses real timers and Math.random. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  random?: () => number;
  pool?: ReturnType<typeof imageRequestPool>;
  capacity?: ProviderCapacity;
  /** Test seam for the SDK call: the request, and the configuration it is
   *  sent with (themeImageConfig). */
  send?: (
    request: ThemeImageRequest,
    signal: AbortSignal,
    sent: GenerateContentConfig,
  ) => Promise<GenerateContentResponse>;
}

export function createVertexImageClient(
  config: ThemeStudioImageConfig,
  options: ImageClientOptions,
): ThemeStudioImageClient {
  const sleep = options.sleep ?? sleepUnlessAborted;
  const random = options.random ?? Math.random;
  const capacity = options.capacity ?? uncoordinatedProviderCapacity;
  const pool =
    options.pool ??
    imageRequestPool(config.projectId, config.location, config.providerModel);
  let ai: GoogleGenAI | null = null;
  const send =
    options.send ??
    ((
      request: ThemeImageRequest,
      signal: AbortSignal,
      sent: GenerateContentConfig,
    ) => {
      ai ??= new GoogleGenAI({
        enterprise: true,
        project: config.projectId,
        location: config.location,
        apiVersion: "v1",
        // One attempt: see the header.
        httpOptions: {
          timeout: IMAGE_REQUEST_TIMEOUT_MS,
          retryOptions: { attempts: 1 },
        },
      });
      return ai.models.generateContent({
        model: config.providerModel,
        contents: [{ role: "user", parts: themeImageParts(request) }],
        config: { ...sent, abortSignal: signal },
      });
    });
  /** The caller's size and thinking level for this request. */
  const settingsFor = (request: ThemeImageRequest): ThemeImageSettings => ({
    model: config.providerModel,
    imageSize:
      typeof options.imageSize === "function"
        ? options.imageSize(request)
        : options.imageSize,
    thinkingLevel: options.thinkingLevel,
  });

  return {
    provider: "vertex-gemini",
    async generateImage(request, outer) {
      assertThemeImageRequest(request);
      // ★ The request exactly as the model receives it, fitted to that
      //   model; one with no size is refused here, before anything queues.
      const sent = themeImageConfig(request, settingsFor(request));
      try {
        return await generate(request, sent, outer);
      } catch (error) {
        // ★ Never silent: an error that escaped the call is logged with
        //   whatever it says, unless the run itself was cancelled.
        if (!outer.aborted) {
          logWarn("theme_studio.image_provider_error", {
            purpose: request.purpose,
            brief: request.briefId,
            model: config.providerModel,
            code: "provider_unavailable",
            ...providerErrorFacts(error),
          });
        }
        return {
          kind: "error",
          code: outer.aborted ? "cancelled" : "provider_unavailable",
          usage: ZERO_IMAGE_USAGE,
        };
      }
    },
  };

  async function generate(
    request: ThemeImageRequest,
    sent: GenerateContentConfig,
    outer: AbortSignal,
  ): Promise<ThemeImageResult> {
    let waitedMs = 0;
    const started = Date.now();
    let capacityWaitMs = 0;
    let providerAttempts = 0;
    // ★ The last try left and Google has not refused it with 429. The safe
    //   side: an answer that came back as the call stopped counts too.
    let onTheWire = false;
    const timed = (result: ThemeImageResult): ThemeImageResult => ({
      ...result,
      timing: {
        durationMs: Date.now() - started,
        capacityWaitMs,
        providerAttempts,
        ...(options.markStoppedInFlight &&
        onTheWire &&
        result.kind === "error" &&
        result.code === "cancelled"
          ? { stoppedInFlight: true as const }
          : {}),
      },
    });
    for (let retry = 0; ; retry++) {
      let signal = outer;
      let pendingWait: Promise<boolean> | null = null;
      let retryDelay: number | null = null;
      const queuedAt = Date.now();
      try {
        return timed(
          await pool.run(
            (epoch) =>
              capacity.run(async (permit) => {
                capacityWaitMs += Date.now() - queuedAt;
                // The attempt clock starts when a permit is acquired. Waiting behind
                // another theme is bounded by the run signal, not provider latency.
                signal = AbortSignal.any([
                  outer,
                  permit.signal,
                  AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
                ]);
                // Cooldowns consume no active permit; admission waits until the
                // shared pause settles and, on a start-paced key, until the
                // key's next start, then resumes at the reduced probe limit.
                providerAttempts++;
                try {
                  const response = await abortable(() => {
                    onTheWire = true;
                    return send(request, signal, sent);
                  }, signal);
                  const result = parseThemeImageResponse(
                    response,
                    config.providerModel,
                  );
                  pool.recovered(epoch);
                  permit.succeeded();
                  logThemeImageAnswer(request, config, sent, response, result);
                  return result;
                } catch (error) {
                  // Register the shared pause BEFORE releasing this permit, so
                  // queued slots cannot surge into the same exhausted capacity.
                  if (
                    !signal.aborted &&
                    classifyProviderError(error) === "rate_limited"
                  ) {
                    // Refused before the model ran: nothing on the wire.
                    onTheWire = false;
                    // ★ The pause the others see and this call's own wait
                    //   before it queues again: never past the shared ceiling.
                    const delay = Math.min(
                      rateLimitDelayMs(retry, random),
                      SHARED_RATE_LIMIT_PAUSE_MAX_MS,
                    );
                    await permit.rateLimited(delay).catch(() => {
                      logWarn("theme_studio.image_shared_cooldown_failed", {
                        purpose: request.purpose,
                        brief: request.briefId,
                      });
                    });
                    if (
                      retry < RATE_LIMIT_BACKOFF.retries &&
                      waitedMs + delay <= RATE_LIMIT_BACKOFF.totalMs
                    ) {
                      retryDelay = delay;
                      pendingWait = sleep(delay, outer);
                    }
                    pool.coolDown(pendingWait ?? Promise.resolve());
                  }
                  throw error;
                }
              }, outer),
            outer,
          ),
        );
      } catch (error) {
        const code = outer.aborted
          ? "cancelled"
          : signal.reason instanceof ProviderCapacityLost
            ? "provider_unavailable"
            : signal.aborted
              ? "provider_timeout"
              : classifyProviderError(error);
        const delay =
          code === "rate_limited" && retry < RATE_LIMIT_BACKOFF.retries
            ? retryDelay
            : null;
        // ★ Google's status, message and the quota it names ride on every
        //   refusal and failure, so a quota limit can be told from the
        //   shared pool's contention (robustness audit B23).
        const facts = providerErrorFacts(error);
        if (delay === null || waitedMs + delay > RATE_LIMIT_BACKOFF.totalMs) {
          // ★ One line per call that ends on a refusal, a timeout or a
          //   provider error; a cancelled call is ours, not Google's.
          if (code !== "cancelled") {
            logWarn("theme_studio.image_provider_error", {
              purpose: request.purpose,
              brief: request.briefId,
              model: config.providerModel,
              code,
              tries: providerAttempts,
              ...facts,
            });
          }
          return timed({ kind: "error", code, usage: ZERO_IMAGE_USAGE });
        }
        // Purpose, brief id and Google's answer only: never the prompt or the
        // references.
        logWarn("theme_studio.image_rate_limited_retry", {
          purpose: request.purpose,
          brief: request.briefId,
          retry: retry + 1,
          waitMs: delay,
          ...facts,
        });
        const waitStarted = Date.now();
        if (!(await pendingWait)) {
          capacityWaitMs += Date.now() - waitStarted;
          return timed({
            kind: "error",
            code: "cancelled",
            usage: ZERO_IMAGE_USAGE,
          });
        }
        capacityWaitMs += Date.now() - waitStarted;
        waitedMs += delay;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// What an answer carried, for the log.
//
// ★★ ONE INFO LINE PER ANSWER, AND A WARNING ONLY WHEN THE PICTURE KEPT IS
// UNDER THE SIZE ASKED FOR (robustness audit P0-3). Every gemini-3-pro-image
// answer now carries a 1K thought draft ahead of its final picture
// (storemink-staging, 23 Oct 2026), so a warning per draft would fire on
// every call and be read by nobody: the draft count goes on the info line.
// The warning is the early sign that 1K photos are back; they went unseen
// through two redesign runs (22 and 23 Oct) because nothing logged a size.
//
// ★ The size is read from the picture's own header (JPEG, PNG or WebP), never
// by decoding it, and a header that cannot be read logs no size rather than
// failing a paid image. imageDimensions is copied from
// scripts/revamp-priority-test.ts, which reads its passes' photos the same way.
// ---------------------------------------------------------------------------

/** How many inline image parts an answer carried, and how many of them were
 *  "thought" drafts (the parts parseThemeImageResponse never keeps). */
export function themeImageAnswerParts(response: GenerateContentResponse): {
  imageParts: number;
  thoughtImages: number;
} {
  const images = (response.candidates?.[0]?.content?.parts ?? []).filter(
    (part) => Boolean(part.inlineData?.data),
  );
  return {
    imageParts: images.length,
    thoughtImages: images.filter((part) => part.thought === true).length,
  };
}

/** The long edge of a SQUARE picture at each size the model is asked for.
 *  Every other frame's long edge at that size is longer (a 21:9 2K picture is
 *  3168x1344): the model keeps about the same pixel count at a size whatever
 *  the frame, 1K about 1 MP, 2K about 4 and 4K about 16. */
const SQUARE_EDGE_PX = new Map([
  ["1K", 1024],
  ["2K", 2048],
  ["4K", 4096],
]);

/**
 * ★★ A PICTURE WHOSE LONG EDGE IS UNDER 85% OF ITS SIZE'S SQUARE EDGE IS
 * UNDER THE SIZE ASKED FOR. The square has the shortest long edge of any
 * frame at a size, so no real 2K picture, whatever its frame, is under 2048;
 * the widest 1K frame (21:9 at 1584x672) is still under 85% of 2048 (1741).
 * So the rule never warns for a real 2K answer and always warns for a 1K
 * draft, and likewise one size up: the widest 2K edge, 3168, is under 3482.
 */
export const BELOW_REQUESTED_SIZE_SHARE = 0.85;

/** The shortest long edge a picture of `imageSize` may have before it is
 *  logged as under the size asked for; null for a size this cannot judge. */
export function minimumLongEdgePx(
  imageSize: string | null | undefined,
): number | null {
  const edge = imageSize ? SQUARE_EDGE_PX.get(imageSize) : undefined;
  return edge ? Math.round(edge * BELOW_REQUESTED_SIZE_SHARE) : null;
}

/** ★ One line per answer, and never a throw: a log line never costs a paid
 *  image. Purpose, brief id, model, frame, size and thinking level asked
 *  for, counts and pixel sizes only; never the prompt, the references or the
 *  picture. */
function logThemeImageAnswer(
  request: ThemeImageRequest,
  config: ThemeStudioImageConfig,
  sent: GenerateContentConfig,
  response: GenerateContentResponse,
  result: ThemeImageResult,
): void {
  try {
    // The size the request asked for, from the config it was sent with.
    const requestedSize = sent.imageConfig?.imageSize ?? null;
    const size = result.kind === "ok" ? imageDimensions(result.bytes) : null;
    const finish = response.candidates?.[0]?.finishReason;
    const context = {
      purpose: request.purpose,
      brief: request.briefId,
      model: config.providerModel,
      aspectRatio: request.aspectRatio,
      requestedSize,
      thinkingLevel: sent.thinkingConfig?.thinkingLevel ?? null,
      outcome: result.kind,
      finishReason: finish ? String(finish) : null,
      ...themeImageAnswerParts(response),
      width: size?.width ?? null,
      height: size?.height ?? null,
    };
    logInfo("theme_studio.image_answer", context);
    const minimum = minimumLongEdgePx(requestedSize);
    const longEdge = size ? Math.max(size.width, size.height) : null;
    if (longEdge !== null && minimum !== null && longEdge < minimum) {
      logWarn("theme_studio.image_below_requested_size", {
        ...context,
        longEdge,
        minimumLongEdge: minimum,
      });
    }
  } catch {
    // The answer stands without its log line.
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** JPEG start-of-frame markers: C0 to CF except DHT (C4), JPG (C8), DAC (CC). */
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

/** Width and height read from a JPEG, PNG or WebP header, without decoding;
 *  null when the bytes are none of those or the header is cut short. */
export function imageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    ascii(bytes, 12, 4) === "IHDR"
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker === 0xff) {
        at += 1; // a fill byte
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        at += 2; // a marker with no length
        continue;
      }
      const length = (bytes[at + 2] << 8) | bytes[at + 3];
      if (isStartOfFrame(marker)) {
        if (at + 8 >= bytes.length) return null;
        return {
          height: (bytes[at + 5] << 8) | bytes[at + 6],
          width: (bytes[at + 7] << 8) | bytes[at + 8],
        };
      }
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }
  if (
    bytes.length >= 30 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8X") {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
    if (chunk === "VP8 ") {
      return {
        width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
        height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits =
        (bytes[21] |
          (bytes[22] << 8) |
          (bytes[23] << 16) |
          (bytes[24] << 24)) >>>
        0;
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
  }
  return null;
}
