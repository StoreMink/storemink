import "server-only";

/**
 * One picture from ElevenLabs' Image API (GPT Image 2.5 Sunburst), drawn with
 * the fewest calls that can produce it.
 *
 * The API is asynchronous: POST /v1/flows/image answers with a job id, GET
 * /v1/flows/image/{id} says when it is done, and the picture is downloaded
 * from a signed URL that expires in about an hour. Measured on 22 Nov 2026:
 * 13 to 22 seconds a picture, five and ten at once accepted.
 *
 * ★★ ONE PICTURE, ONE JOB. The rules that keep an extra image from ever being
 *    drawn or paid for:
 *    1. Before submitting, an uncollected job for the same picture is looked
 *       for (elevenlabs-generations.ts) and waited on instead.
 *    2. A submit is retried only after an answer that PROVES no job was made
 *       (HTTP 429: refused for rate or concurrency). A submit that timed out,
 *       dropped or met a 5xx may have made a job, so it is never sent again
 *       by this module; the caller is told a job may exist.
 *    3. Once a job id is known, nothing here submits again. A slow or failing
 *       status read is read again; a failed download asks for a fresh URL.
 *    4. `quality` and `resolution` are sent on every request. The API's own
 *       default quality is `high`, which costs more than was asked for.
 *    5. Exactly one picture per job: the API draws one, and no "variations"
 *       parameter exists to ask for more.
 * ★ A job the provider FAILED (moderated, model error, its own timeout) was
 *   not charged ("Failed generations are not charged"), and is reported as
 *   such, so the caller's own budget does not count it.
 * ★ No request text, picture or key is ever logged: ids, statuses and
 *   timings only.
 */

import { createHash } from "node:crypto";
import { logInfo, logWarn } from "@/lib/observability/logger";
import {
  postgresGenerationStore,
  type GenerationStore,
} from "./elevenlabs-generations";
import type {
  ElevenLabsImageQuality,
  ElevenLabsImageResolution,
} from "./provider-settings";

export const ELEVENLABS_IMAGE_MODEL = "gpt-image-2.5-sunburst";
export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

/** The shapes the model draws (the API's own list, less `auto`). */
export const ELEVENLABS_ASPECT_RATIOS = [
  "1:1",
  "4:5",
  "5:4",
  "3:4",
  "4:3",
  "2:3",
  "3:2",
  "1:2",
  "2:1",
  "9:16",
  "16:9",
  "21:9",
  "1:3",
  "3:1",
] as const;
export type ElevenLabsAspectRatio = (typeof ELEVENLABS_ASPECT_RATIOS)[number];

/** The API allows ten reference images. */
export const ELEVENLABS_MAX_REFERENCES = 10;

/** One request's clock for the submit. */
export const ELEVENLABS_SUBMIT_TIMEOUT_MS = 30_000;
/** "Poll no more than once every 2 seconds" (their guide). */
export const ELEVENLABS_POLL_INTERVAL_MS = 2_000;
/** Their guide: back off when a job runs long. */
export const ELEVENLABS_POLL_SLOW_AFTER_MS = 30_000;
export const ELEVENLABS_POLL_MAX_INTERVAL_MS = 10_000;
/** How long one draw waits on its job. A job not done by then is left for
 *  the next try to collect; it is not drawn again. */
export const ELEVENLABS_WAIT_CEILING_MS = 150_000;
/** Submits refused with 429 (no job was made) that are sent again. */
export const ELEVENLABS_RATE_LIMIT_RETRIES = 3;
export const ELEVENLABS_RATE_LIMIT_WAIT_MS = { min: 2_000, max: 6_000 };
const DOWNLOAD_TRIES = 3;

export interface ElevenLabsReference {
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  base64: string;
}

export interface ElevenLabsDrawInput {
  prompt: string;
  aspectRatio: ElevenLabsAspectRatio;
  quality: ElevenLabsImageQuality;
  resolution: ElevenLabsImageResolution;
  references: readonly ElevenLabsReference[];
  /** Whose picture this is (a redesign's id, a Theme Studio project's id): a
   *  job is only ever collected inside the scope that submitted it. */
  scope: string;
}

export type ElevenLabsErrorCode =
  | "rate_limited"
  | "rejected"
  | "auth"
  | "timeout"
  | "unavailable"
  | "cancelled";

export type ElevenLabsDrawOutcome = (
  | {
      kind: "ok";
      bytes: Uint8Array;
      mediaType: "image/jpeg" | "image/png" | "image/webp";
      generationId: string;
    }
  /** Turned down by content moderation. Not charged. */
  | { kind: "refused"; reason: string | null }
  | { kind: "error"; code: ElevenLabsErrorCode }
) & {
  /**
   * True when a job exists or may exist for this call: one was submitted (or
   * a submit's answer was lost), or an earlier job was collected. False when
   * provably nothing was drawn: refused before a job, or never sent.
   */
  jobMayExist: boolean;
  /** True when the picture came from a job an earlier try had submitted. */
  adopted: boolean;
  /** Submits sent by THIS call (0 when a job was collected or nothing sent). */
  submits: number;
  durationMs: number;
};

export interface ElevenLabsDeps {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  store?: GenerationStore;
  /** Re-encode (and for 1K enlarge) the provider's picture. Null keeps it. */
  finish?:
    | ((
        bytes: Uint8Array,
        resolution: ElevenLabsImageResolution,
      ) => Promise<{
        bytes: Uint8Array;
        mediaType: "image/jpeg" | "image/png" | "image/webp";
      } | null>)
    | null;
}

/** The digest that makes two requests "the same picture". */
export function elevenLabsRequestDigest(input: ElevenLabsDrawInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        ELEVENLABS_IMAGE_MODEL,
        input.quality,
        input.resolution,
        input.aspectRatio,
        input.prompt,
        input.references.map((reference) => [
          reference.mediaType,
          createHash("sha256").update(reference.base64).digest("hex"),
        ]),
      ]),
    )
    .digest("hex");
}

/** The body of one job: every field the cost depends on is stated. */
export function elevenLabsRequestBody(input: ElevenLabsDrawInput) {
  return {
    model_id: ELEVENLABS_IMAGE_MODEL,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
    quality: input.quality,
    ...(input.references.length > 0
      ? {
          images: input.references.map((reference) => ({
            type: "inline_base64" as const,
            content_base64: reference.base64,
            mime_type: reference.mediaType,
          })),
        }
      : {}),
  };
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

type SubmitAnswer =
  | { kind: "created"; id: string }
  /** Refused for rate or concurrency: no job was made. */
  | { kind: "rate_limited" }
  /** Refused outright: no job was made. */
  | { kind: "rejected"; status: number; code: string | null }
  | { kind: "auth"; status: number; code: string | null }
  /** No usable answer: a job may have been made. */
  | { kind: "unknown" };

function errorCodeOf(body: unknown): string | null {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const code =
      (detail as { code?: unknown }).code ??
      (detail as { status?: unknown }).status;
    return typeof code === "string" ? code : null;
  }
  return null;
}

async function submit(
  input: ElevenLabsDrawInput,
  signal: AbortSignal,
  deps: Required<Pick<ElevenLabsDeps, "apiKey" | "fetch">>,
): Promise<SubmitAnswer> {
  const clock = AbortSignal.timeout(ELEVENLABS_SUBMIT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await deps.fetch(`${ELEVENLABS_API_BASE}/v1/flows/image`, {
      method: "POST",
      headers: {
        "xi-api-key": deps.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(elevenLabsRequestBody(input)),
      signal: AbortSignal.any([signal, clock]),
      cache: "no-store",
    });
  } catch {
    // The request may have arrived: never "nothing was sent".
    return { kind: "unknown" };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) {
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === "string" && id
      ? { kind: "created", id }
      : { kind: "unknown" };
  }
  const code = errorCodeOf(body);
  if (response.status === 429) return { kind: "rate_limited" };
  if ([401, 402, 403].includes(response.status)) {
    return { kind: "auth", status: response.status, code };
  }
  if (response.status >= 400 && response.status < 500) {
    return { kind: "rejected", status: response.status, code };
  }
  // 5xx: their side broke part way, and a job may exist.
  return { kind: "unknown" };
}

type JobState =
  | { kind: "running" }
  | { kind: "completed"; url: string; mime: string | null }
  | { kind: "failed"; reason: string | null }
  /** The job is not there (never existed, or is gone). */
  | { kind: "gone" }
  /** The read itself failed; ask again. */
  | { kind: "retry"; slow: boolean };

async function readJob(
  id: string,
  signal: AbortSignal,
  deps: Required<Pick<ElevenLabsDeps, "apiKey" | "fetch">>,
): Promise<JobState> {
  let response: Response;
  try {
    response = await deps.fetch(
      `${ELEVENLABS_API_BASE}/v1/flows/image/${encodeURIComponent(id)}`,
      {
        headers: { "xi-api-key": deps.apiKey },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        cache: "no-store",
      },
    );
  } catch {
    return { kind: "retry", slow: false };
  }
  if (response.status === 404) return { kind: "gone" };
  // "Sustained aggressive polling can return 429 responses".
  if (response.status === 429) return { kind: "retry", slow: true };
  if (!response.ok) return { kind: "retry", slow: false };
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return { kind: "retry", slow: false };
  }
  if (body?.status === "completed" && typeof body.content_url === "string") {
    return {
      kind: "completed",
      url: body.content_url,
      mime:
        typeof body.content_mime_type === "string"
          ? body.content_mime_type
          : null,
    };
  }
  if (body?.status === "failed") {
    return {
      kind: "failed",
      reason:
        typeof body.failure_reason === "string" ? body.failure_reason : null,
    };
  }
  return { kind: "running" };
}

function sniff(
  bytes: Uint8Array,
): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) {
    return "image/webp";
  }
  return null;
}

async function download(
  url: string,
  signal: AbortSignal,
  fetchFn: typeof fetch,
): Promise<Uint8Array | null> {
  try {
    const response = await fetchFn(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return sniff(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * The provider's picture as StoreMink keeps it: a JPEG, and for a 1K draw
 * enlarged to twice its size.
 *
 * ★★ WHY A 1K PICTURE IS ENLARGED. Theme Studio and the redesign size every
 *    photo for its place on the page (1,600 or 2,400 px on the long edge) and
 *    treat a picture smaller than its frame as a fault: the redesign draws it
 *    AGAIN, once, and if it is still small marks it "not done" and does not
 *    charge for it. A 1K picture (832x1040, 1280x720) is smaller than every
 *    frame, so without this each photo would be drawn twice and then given
 *    away. Enlarging it here, once, means nothing downstream redraws for
 *    size. It adds no detail: a 1K photo is softer than a 2K one, which is
 *    what choosing 1K means.
 */
export async function finishElevenLabsPicture(
  bytes: Uint8Array,
  resolution: ElevenLabsImageResolution,
): Promise<{
  bytes: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
} | null> {
  try {
    const sharp = (await import("sharp")).default;
    let image = sharp(bytes, { failOn: "error" });
    if (resolution === "1K") {
      const meta = await image.metadata();
      if (!meta.width || !meta.height) return null;
      image = image.resize(meta.width * 2, meta.height * 2, {
        kernel: "lanczos3",
        fit: "fill",
      });
    }
    const out = await image
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer();
    return { bytes: new Uint8Array(out), mediaType: "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * Draw one picture. Never throws: every outcome is a value, and each says
 * whether a job exists for it (`jobMayExist`).
 */
export async function drawElevenLabsImage(
  input: ElevenLabsDrawInput,
  signal: AbortSignal,
  options: ElevenLabsDeps,
): Promise<ElevenLabsDrawOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const store = options.store ?? postgresGenerationStore;
  const finish =
    options.finish === undefined ? finishElevenLabsPicture : options.finish;
  const deps = { apiKey: options.apiKey, fetch: options.fetch ?? fetch };
  const startedAt = now();
  let submits = 0;
  let adopted = false;
  const end = (
    outcome:
      | {
          kind: "ok";
          bytes: Uint8Array;
          mediaType: "image/jpeg" | "image/png" | "image/webp";
          generationId: string;
        }
      | { kind: "refused"; reason: string | null }
      | { kind: "error"; code: ElevenLabsErrorCode },
    jobMayExist: boolean,
  ): ElevenLabsDrawOutcome => ({
    ...outcome,
    jobMayExist,
    adopted,
    submits,
    durationMs: Math.max(0, now() - startedAt),
  });

  if (signal.aborted) return end({ kind: "error", code: "cancelled" }, false);
  if (
    !ELEVENLABS_ASPECT_RATIOS.includes(input.aspectRatio) ||
    input.references.length > ELEVENLABS_MAX_REFERENCES ||
    !input.prompt.trim()
  ) {
    // Refused here, before anything is sent: nothing was drawn.
    return end({ kind: "error", code: "rejected" }, false);
  }

  const digest = elevenLabsRequestDigest(input);

  // ── 1. A job already paid for, for this very picture? Collect it. ────────
  let generationId = await store.claimUndelivered(
    input.scope,
    digest,
    new Date(now()),
  );
  if (generationId) {
    adopted = true;
    logInfo("images.elevenlabs: collecting an earlier job", {
      scope: input.scope,
      generationId,
    });
  }

  for (;;) {
    // ── 2. Otherwise submit ONE job ────────────────────────────────────────
    if (!generationId) {
      let answer: SubmitAnswer = { kind: "rate_limited" };
      for (let attempt = 0; ; attempt += 1) {
        if (signal.aborted) {
          return end({ kind: "error", code: "cancelled" }, false);
        }
        submits += 1;
        answer = await submit(input, signal, deps);
        if (answer.kind !== "rate_limited") break;
        // 429: no job was made, so asking again cannot make two.
        submits -= 1;
        if (attempt >= ELEVENLABS_RATE_LIMIT_RETRIES) break;
        const wait =
          ELEVENLABS_RATE_LIMIT_WAIT_MS.min +
          Math.floor(
            random() *
              (ELEVENLABS_RATE_LIMIT_WAIT_MS.max -
                ELEVENLABS_RATE_LIMIT_WAIT_MS.min),
          );
        await sleep(wait * (attempt + 1), signal);
      }
      if (answer.kind === "rate_limited") {
        return end({ kind: "error", code: "rate_limited" }, false);
      }
      if (answer.kind === "rejected" || answer.kind === "auth") {
        logWarn("images.elevenlabs: submit refused", {
          scope: input.scope,
          status: answer.status,
          code: answer.code,
        });
        return end(
          { kind: "error", code: answer.kind === "auth" ? "auth" : "rejected" },
          false,
        );
      }
      if (answer.kind === "unknown") {
        // ★★ A job may exist and its id is not known. It is NOT sent again
        //    here: that is how one picture becomes two.
        logWarn("images.elevenlabs: submit got no answer", {
          scope: input.scope,
        });
        return end(
          {
            kind: "error",
            code: signal.aborted ? "cancelled" : "timeout",
          },
          true,
        );
      }
      generationId = answer.id;
      await store.recordSubmitted(
        input.scope,
        digest,
        generationId,
        new Date(now()),
      );
    }

    // ── 3. Wait for THAT job. Nothing below submits again. ─────────────────
    const waitFrom = now();
    let interval = ELEVENLABS_POLL_INTERVAL_MS;
    let gone = false;
    for (;;) {
      if (signal.aborted) {
        // The job goes on and is paid for: leave it for the next try.
        await store.release(generationId, new Date(now()));
        return end({ kind: "error", code: "cancelled" }, true);
      }
      if (now() - waitFrom >= ELEVENLABS_WAIT_CEILING_MS) {
        await store.release(generationId, new Date(now()));
        logWarn("images.elevenlabs: job not done in time, left to collect", {
          scope: input.scope,
          generationId,
        });
        return end({ kind: "error", code: "timeout" }, true);
      }
      await sleep(interval, signal);
      if (signal.aborted) continue;
      const state = await readJob(generationId, signal, deps);
      if (state.kind === "retry") {
        if (state.slow) {
          interval = Math.min(interval * 2, ELEVENLABS_POLL_MAX_INTERVAL_MS);
        }
        continue;
      }
      if (state.kind === "running") {
        if (now() - waitFrom >= ELEVENLABS_POLL_SLOW_AFTER_MS) {
          interval = Math.min(interval * 2, ELEVENLABS_POLL_MAX_INTERVAL_MS);
        }
        continue;
      }
      if (state.kind === "gone") {
        await store.settle(generationId, "failed", new Date(now()));
        gone = true;
        break;
      }
      if (state.kind === "failed") {
        // "Failed generations are not charged."
        await store.settle(generationId, "failed", new Date(now()));
        logInfo("images.elevenlabs: job failed at the provider", {
          scope: input.scope,
          generationId,
          reason: state.reason,
        });
        if (state.reason === "moderated") {
          return end({ kind: "refused", reason: state.reason }, false);
        }
        return end(
          {
            kind: "error",
            code:
              state.reason === "invalid_parameters"
                ? "rejected"
                : state.reason === "charging_failed"
                  ? "auth"
                  : "unavailable",
          },
          false,
        );
      }

      // ── 4. Completed: download it, once ──────────────────────────────────
      let url = state.url;
      let raw: Uint8Array | null = null;
      for (let attempt = 0; attempt < DOWNLOAD_TRIES && !raw; attempt += 1) {
        if (signal.aborted) break;
        raw = await download(url, signal, deps.fetch);
        if (raw) break;
        // The signed URL may have lapsed: the job itself gives a fresh one.
        await sleep(ELEVENLABS_POLL_INTERVAL_MS, signal);
        const again = await readJob(generationId, signal, deps);
        if (again.kind === "completed") url = again.url;
      }
      if (!raw) {
        // The picture exists and is paid for: leave it to be collected.
        await store.release(generationId, new Date(now()));
        return end(
          { kind: "error", code: signal.aborted ? "cancelled" : "unavailable" },
          true,
        );
      }
      const finished = finish ? await finish(raw, input.resolution) : null;
      const picture = finished ?? { bytes: raw, mediaType: sniff(raw)! };
      await store.settle(generationId, "delivered", new Date(now()));
      logInfo("images.elevenlabs: picture drawn", {
        scope: input.scope,
        generationId,
        adopted,
        ms: Math.max(0, now() - startedAt),
        quality: input.quality,
        resolution: input.resolution,
        references: input.references.length,
      });
      return end(
        {
          kind: "ok",
          bytes: picture.bytes,
          mediaType: picture.mediaType,
          generationId,
        },
        true,
      );
    }

    // A job that was COLLECTED and turned out to be gone was never this
    // call's to count: submit the one job this call is owed. A job this call
    // submitted itself and that then vanished is an error, not a second try.
    if (gone && adopted && submits === 0) {
      adopted = false;
      generationId = null;
      continue;
    }
    return end({ kind: "error", code: "unavailable" }, false);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// What a picture costs, for StoreMink's own spend records.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Credits one picture used. ElevenLabs publishes no per-image price, so
 * these come from the 22 Nov 2026 measurements through this API: about 130
 * for a picture with no reference at 1K medium, 141 at 2K medium in their
 * app, and about 475 (low) to 560 (medium) once a reference photo is
 * attached. The reference is what costs; the quality setting moves the price
 * little. ⚠ A picture with no reference at LOW was not measured: 110 is an
 * assumption a little under the medium figure.
 */
export function elevenLabsCreditsEstimate(input: {
  quality: ElevenLabsImageQuality;
  resolution: ElevenLabsImageResolution;
  references: number;
}): number {
  const size = input.resolution === "2K" ? 141 / 130 : 1;
  const base =
    input.references > 0
      ? input.quality === "medium"
        ? 562
        : 475
      : input.quality === "medium"
        ? 130
        : 110;
  return Math.round(base * size);
}

/** The Scale plan's list price: $299 for 1.8M credits (22 Nov 2026). */
export const ELEVENLABS_MICRO_USD_PER_CREDIT = 166;

/** An estimate in whole micro-USD, for the spend ledgers. */
export function elevenLabsCostMicroUsd(input: {
  quality: ElevenLabsImageQuality;
  resolution: ElevenLabsImageResolution;
  references: number;
}): number {
  return elevenLabsCreditsEstimate(input) * ELEVENLABS_MICRO_USD_PER_CREDIT;
}
