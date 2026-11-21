import "server-only";

import { logWarn } from "@/lib/observability/logger";
import {
  elevenLabsAspectRatio,
  elevenLabsModelDef,
  type ElevenLabsImageModel,
} from "@/lib/mink/image-provider-settings";
import {
  assertThemeImageRequest,
  ZERO_IMAGE_USAGE,
  type ThemeImageReference,
  type ThemeImageResult,
  type ThemeStudioImageClient,
} from "./image-provider";

// ---------------------------------------------------------------------------
// ElevenLabs as an image provider (owner, 21 Nov 2026), for a storefront
// redesign's pictures when the operator switch says so
// (lib/mink/image-provider-store.ts).
//
// ★ ASYNC JOBS, NOT ONE CALL. POST /v1/flows/image answers an id at once; the
//   picture is fetched by polling GET /v1/flows/image/{id} (ElevenLabs asks
//   for no more than once every 2 seconds) and then downloading its signed
//   `content_url`, which carries no key: the key is never sent to it.
//
// ★ NO VERTEX PACING. Vertex allows 2 image starts a minute per project and
//   model, which is why its calls queue on the shared capacity
//   (provider-capacity.ts). ElevenLabs has no such limit, so these calls
//   never touch that capacity; a per-process semaphore keeps one instance
//   from starting more than `concurrency` at once, and a 429 (rate or
//   concurrency) is waited out and asked again. A 429 is refused before any
//   picture is made, so asking again is never a second bill.
//
// ★ THE SAME RESULT VOCABULARY AS VERTEX (image-provider.ts), so the photos
//   step needs no new rule: a moderated picture is `refused` with its
//   reason; a create the stop or drain prevented is `cancelled` with no
//   attempt; a job the stop cut off after it was created is `cancelled` and,
//   for a caller that asks, `stoppedInFlight` (it may still be charged).
//   ElevenLabs does not charge a failed generation.
//
// ★ LABELS GO INTO THE PROMPT. Vertex sends each reference after a text label
//   (ANCHOR:, SET:, PRODUCT:; image-vertex.ts). ElevenLabs takes a plain list
//   of images, so the prompt names each one by its place in the list.
//
// ★ CONTENT-FREE LOGS: model, status, ElevenLabs' error code and request id,
//   never the prompt, a reference, the picture or the key.
// ---------------------------------------------------------------------------

export const ELEVENLABS_IMAGE_API = "https://api.elevenlabs.io/v1/flows/image";

/** One picture's whole clock: create, polls and download (Vertex's too). */
export const ELEVENLABS_IMAGE_TIMEOUT_MS = 180_000;
/** ElevenLabs' own guidance: poll an image no more than every 2 seconds. */
export const ELEVENLABS_POLL_MS = 2_000;
/** Pictures one process draws at once; ElevenLabs' 429 decides the rest. */
export const ELEVENLABS_DEFAULT_CONCURRENCY = 6;
/** 429 retries per picture, each after a jittered wait. */
export const ELEVENLABS_RATE_LIMIT_RETRIES = 8;
const RATE_LIMIT_WAIT_MS = [3_000, 6_000, 10_000, 15_000] as const;
/** The largest picture accepted (a 4K PNG is far below this). */
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

const REFERENCE_NAMES: Record<ThemeImageReference["role"], string> = {
  anchor: "ANCHOR",
  set: "SET",
  product: "PRODUCT",
};

export interface ElevenLabsImageInput {
  prompt: string;
  /** A ratio from THEME_IMAGE_ASPECT_RATIOS; mapped to the model's nearest. */
  aspectRatio: string;
  images: ReadonlyArray<{ mediaType: string; base64: string }>;
}

export interface ElevenLabsImageOptions {
  apiKey: string;
  model: ElevenLabsImageModel;
  /** The deadline's drain: no create is started once it has fired. */
  draining?: AbortSignal;
  /** Say so when the stop cut off a job already created (D3). */
  markStoppedInFlight?: boolean;
  concurrency?: number;
  /** For tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** The prompt with each reference named by its place in the image list. */
export function elevenLabsPrompt(
  prompt: string,
  references: readonly Pick<ThemeImageReference, "role">[],
): string {
  if (references.length === 0) return prompt;
  const names = references
    .map(
      (reference, index) =>
        `Image ${index + 1} is the reference labelled ${REFERENCE_NAMES[reference.role]}.`,
    )
    .join(" ");
  return `${prompt}\n\nREFERENCE IMAGES, IN THE ORDER ATTACHED\n${names}`;
}

// ── A per-process gate, shared by every client in this process ──────────────

interface Gate {
  active: number;
  waiters: Array<() => void>;
}

const GATE_KEY = Symbol.for("storemink.elevenlabs.imageGate");

function gate(): Gate {
  const holder = globalThis as unknown as Record<symbol, Gate | undefined>;
  holder[GATE_KEY] ??= { active: 0, waiters: [] };
  return holder[GATE_KEY];
}

async function acquire(limit: number, signal: AbortSignal): Promise<boolean> {
  const g = gate();
  while (g.active >= limit) {
    if (signal.aborted) return false;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        g.waiters = g.waiters.filter((waiter) => waiter !== wake);
        resolve();
      };
      const wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      g.waiters.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  if (signal.aborted) return false;
  g.active += 1;
  return true;
}

function release(): void {
  const g = gate();
  g.active = Math.max(0, g.active - 1);
  g.waiters.shift()?.();
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// ── The call ────────────────────────────────────────────────────────────────

interface ErrorDetail {
  code: string | null;
  requestId: string | null;
}

async function errorDetail(response: Response): Promise<ErrorDetail> {
  try {
    const body = (await response.json()) as {
      detail?: { code?: unknown; status?: unknown; request_id?: unknown };
    };
    const detail = body?.detail;
    const code =
      typeof detail?.code === "string"
        ? detail.code
        : typeof detail?.status === "string"
          ? detail.status
          : null;
    return {
      code: code ? code.slice(0, 60) : null,
      requestId:
        typeof detail?.request_id === "string"
          ? detail.request_id.slice(0, 80)
          : null,
    };
  } catch {
    return { code: null, requestId: null };
  }
}

function mediaTypeOf(
  declared: string | undefined,
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) {
    return "image/webp";
  }
  if (
    declared === "image/png" ||
    declared === "image/jpeg" ||
    declared === "image/webp"
  ) {
    return declared;
  }
  return null;
}

/**
 * One picture from ElevenLabs. Never throws: every outcome is a
 * ThemeImageResult, with operational timing.
 */
export async function requestElevenLabsImage(
  input: ElevenLabsImageInput,
  signal: AbortSignal,
  options: ElevenLabsImageOptions,
): Promise<ThemeImageResult> {
  const doFetch = options.fetch ?? fetch;
  // ★ A wait never throws into the call: a stop ends the wait and is read
  //   as the stop, so the call still returns a result rather than rejecting.
  const sleep = (ms: number, waitSignal: AbortSignal) =>
    (options.sleep ?? defaultSleep)(ms, waitSignal).catch(() => undefined);
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const model = elevenLabsModelDef(options.model);
  const started = now();
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(), ELEVENLABS_IMAGE_TIMEOUT_MS);
  const callSignal = AbortSignal.any([signal, clock.signal]);
  let attempts = 0;
  let created = false;
  let capacityWaitMs = 0;
  const finish = (
    result:
      | Omit<Extract<ThemeImageResult, { kind: "ok" }>, "timing">
      | Omit<Extract<ThemeImageResult, { kind: "refused" }>, "timing">
      | Omit<Extract<ThemeImageResult, { kind: "error" }>, "timing">,
  ): ThemeImageResult => {
    const stopped =
      result.kind === "error" &&
      result.code === "cancelled" &&
      created &&
      options.markStoppedInFlight === true;
    return {
      ...result,
      timing: {
        durationMs: now() - started,
        capacityWaitMs,
        providerAttempts: attempts,
        ...(stopped ? { stoppedInFlight: true as const } : {}),
      },
    } as ThemeImageResult;
  };
  const ended = (): ThemeImageResult =>
    signal.aborted
      ? finish({ kind: "error", code: "cancelled", usage: ZERO_IMAGE_USAGE })
      : finish({
          kind: "error",
          code: "provider_timeout",
          usage: ZERO_IMAGE_USAGE,
        });

  const waitStarted = now();
  const admitted = await acquire(
    Math.max(1, options.concurrency ?? ELEVENLABS_DEFAULT_CONCURRENCY),
    options.draining
      ? AbortSignal.any([callSignal, options.draining])
      : callSignal,
  );
  capacityWaitMs = now() - waitStarted;
  if (!admitted) {
    clearTimeout(timer);
    if (options.draining?.aborted || signal.aborted) {
      return finish({
        kind: "error",
        code: "cancelled",
        usage: ZERO_IMAGE_USAGE,
      });
    }
    return ended();
  }
  const log = (event: string, fields: Record<string, unknown>) =>
    logWarn(`theme_studio.elevenlabs_${event}`, { model: model.id, ...fields });

  try {
    // ── Create, waiting out 429s ──────────────────────────────────────────
    const body = JSON.stringify({
      model_id: model.id,
      prompt: input.prompt,
      aspect_ratio: elevenLabsAspectRatio(model, input.aspectRatio),
      ...(model.resolution ? { resolution: model.resolution } : {}),
      ...(input.images.length > 0
        ? {
            images: input.images.map((image) => ({
              type: "inline_base64",
              content_base64: image.base64,
              mime_type: image.mediaType,
            })),
          }
        : {}),
    });
    let id: string | null = null;
    for (let retry = 0; id === null; retry += 1) {
      if (options.draining?.aborted || signal.aborted) {
        return finish({
          kind: "error",
          code: "cancelled",
          usage: ZERO_IMAGE_USAGE,
        });
      }
      if (clock.signal.aborted) return ended();
      attempts += 1;
      let response: Response;
      try {
        response = await doFetch(ELEVENLABS_IMAGE_API, {
          method: "POST",
          headers: {
            "xi-api-key": options.apiKey,
            "content-type": "application/json",
          },
          body,
          signal: callSignal,
        });
      } catch {
        if (callSignal.aborted) return ended();
        log("create_failed", { reason: "network" });
        return finish({
          kind: "error",
          code: "provider_unavailable",
          usage: ZERO_IMAGE_USAGE,
        });
      }
      if (response.ok) {
        const answer = (await response.json().catch(() => null)) as {
          id?: unknown;
        } | null;
        if (typeof answer?.id !== "string" || !answer.id) {
          log("create_failed", { reason: "no_id", status: response.status });
          return finish({
            kind: "error",
            code: "provider_unavailable",
            usage: ZERO_IMAGE_USAGE,
          });
        }
        id = answer.id;
        created = true;
        break;
      }
      const detail = await errorDetail(response);
      if (response.status === 429) {
        if (retry >= ELEVENLABS_RATE_LIMIT_RETRIES) {
          log("rate_limited", { ...detail, retries: retry });
          return finish({
            kind: "error",
            code: "rate_limited",
            usage: ZERO_IMAGE_USAGE,
          });
        }
        const base =
          RATE_LIMIT_WAIT_MS[Math.min(retry, RATE_LIMIT_WAIT_MS.length - 1)];
        await sleep(Math.round(base * (0.75 + random() * 0.5)), callSignal);
        continue;
      }
      log("create_refused", { status: response.status, ...detail });
      const code =
        response.status === 401 || response.status === 403
          ? "provider_auth"
          : response.status >= 500
            ? "provider_unavailable"
            : "provider_rejected";
      return finish({ kind: "error", code, usage: ZERO_IMAGE_USAGE });
    }

    // ── Poll until it is done ─────────────────────────────────────────────
    for (;;) {
      await sleep(ELEVENLABS_POLL_MS, callSignal);
      if (callSignal.aborted) return ended();
      let response: Response;
      try {
        response = await doFetch(
          `${ELEVENLABS_IMAGE_API}/${encodeURIComponent(id)}`,
          {
            headers: { "xi-api-key": options.apiKey },
            signal: callSignal,
          },
        );
      } catch {
        if (callSignal.aborted) return ended();
        continue; // A blip while it draws: ask again on the next poll.
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          log("poll_refused", { status: response.status });
          return finish({
            kind: "error",
            code: "provider_auth",
            usage: ZERO_IMAGE_USAGE,
          });
        }
        continue;
      }
      const job = (await response.json().catch(() => null)) as {
        status?: unknown;
        content_url?: unknown;
        content_mime_type?: unknown;
        failure_reason?: unknown;
        error_message?: unknown;
      } | null;
      if (job?.status === "failed") {
        const reason =
          typeof job.failure_reason === "string" ? job.failure_reason : null;
        log("failed", { reason });
        if (reason === "moderated") {
          return finish({
            kind: "refused",
            reason:
              typeof job.error_message === "string"
                ? job.error_message.slice(0, 300)
                : "moderated",
            usage: ZERO_IMAGE_USAGE,
          });
        }
        return finish({
          kind: "error",
          code:
            reason === "timeout"
              ? "provider_timeout"
              : reason === "invalid_parameters"
                ? "provider_rejected"
                : "provider_unavailable",
          usage: ZERO_IMAGE_USAGE,
        });
      }
      if (job?.status !== "completed") continue;
      const url = typeof job.content_url === "string" ? job.content_url : "";
      if (!url.startsWith("https://")) {
        log("failed", { reason: "bad_content_url" });
        return finish({
          kind: "error",
          code: "provider_unavailable",
          usage: ZERO_IMAGE_USAGE,
        });
      }
      // ★ The signed URL carries its own permission: no key goes to it.
      let file: Response;
      try {
        file = await doFetch(url, { signal: callSignal });
      } catch {
        if (callSignal.aborted) return ended();
        log("failed", { reason: "download" });
        return finish({
          kind: "error",
          code: "provider_unavailable",
          usage: ZERO_IMAGE_USAGE,
        });
      }
      const size = Number(file.headers.get("content-length") ?? 0);
      if (!file.ok || size > MAX_DOWNLOAD_BYTES) {
        log("failed", { reason: "download", status: file.status });
        return finish({
          kind: "error",
          code: "provider_unavailable",
          usage: ZERO_IMAGE_USAGE,
        });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mediaType = mediaTypeOf(
        typeof job.content_mime_type === "string"
          ? job.content_mime_type
          : undefined,
        bytes,
      );
      if (
        !mediaType ||
        bytes.length === 0 ||
        bytes.length > MAX_DOWNLOAD_BYTES
      ) {
        log("failed", { reason: "unreadable_image" });
        return finish({
          kind: "error",
          code: "provider_unavailable",
          usage: ZERO_IMAGE_USAGE,
        });
      }
      return finish({ kind: "ok", bytes, mediaType, usage: ZERO_IMAGE_USAGE });
    }
  } finally {
    clearTimeout(timer);
    release();
  }
}

/**
 * Theme Studio's image client over ElevenLabs, for the storefront redesign's
 * photos step: the same interface as the Vertex client (image-vertex.ts).
 */
export function createElevenLabsImageClient(
  options: ElevenLabsImageOptions,
): ThemeStudioImageClient {
  return {
    provider: "elevenlabs",
    async generateImage(request, signal) {
      assertThemeImageRequest(request);
      return requestElevenLabsImage(
        {
          prompt: elevenLabsPrompt(request.prompt, request.references),
          aspectRatio: request.aspectRatio,
          images: request.references,
        },
        signal,
        options,
      );
    },
  };
}
