import { NextResponse } from "next/server";
import { getMinkConfig } from "@/lib/mink/config";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { readMinkBoundedBytes } from "@/lib/mink/bounded-json";
import { validateMinkInput } from "@/lib/mink/input-validation";
import { reserveHelpVoice } from "@/lib/mink/input-limits";
import { MinkRequestError } from "@/lib/mink/errors";
import { getMinkVoiceProvider } from "@/lib/mink/voice-settings";
import { transcribeMinkVoice } from "@/lib/mink/voice-transcription";
import { MINK_AUDIO_RATE, MINK_AUDIO_SECONDS } from "@/lib/mink/input-policy";
import type { MinkVoiceProvider } from "@/lib/mink/voice-provider";
import { isHelpHost } from "@/lib/store/host";
import { clientIp } from "@/lib/client-ip";
import { logError, logInfo } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The public Help Centre's microphone: one WAV in, one transcript out.
 *
 * ★ PUBLIC, SO EVERY GUARD IS ITS OWN. `/api/mink/voice` needs a signed-in
 * merchant, and help.storemink.com has no sign-in, so this route checks the
 * host is the Help Centre, the browser origin is the same, and spends the
 * visitor's own buckets (`reserveHelpVoice`, keyed by the client address,
 * fail-closed) before it decodes a byte. The audio and the words are never
 * stored or logged; only sizes, timings and the language tag are.
 * ★ IT ANSWERS NOTHING BUT A TRANSCRIPT. The question itself still goes
 * through the ordinary `askHelpAssistant` action, with its own limits, so a
 * spoken question can do nothing a typed one cannot.
 * ★ Mink AI's platform switch (`MINK_AI_ENABLED=false`) turns it off with the
 * dashboard's voice, because the two share one transcription provider bill.
 */

const MAX_WAV_BYTES = 44 + MINK_AUDIO_RATE * MINK_AUDIO_SECONDS * 2;
const REQUEST_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Concurrent transcriptions per instance; the dashboard route's reasoning. */
const MAX_TRANSCRIPTIONS = 6;

let processing = 0;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });

function requestHost(request: Request) {
  return (
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    new URL(request.url).host
  );
}

export async function POST(request: Request) {
  if (!isHelpHost(requestHost(request)))
    return json({ error: "Not found." }, 404);
  const origin = rejectForeignMinkOrigin(request);
  if (origin) return origin;
  if (!getMinkConfig().enabled)
    return json({ error: "Voice isn't available right now." }, 404);
  if (processing >= MAX_TRANSCRIPTIONS)
    return json(
      { error: "Voice is busy right now. Try again in a moment." },
      429,
    );

  processing++;
  const requestId = crypto.randomUUID();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
  let provider: MinkVoiceProvider | null = null;
  try {
    if (request.headers.get("content-type") !== "audio/wav")
      throw new MinkRequestError(
        "invalid_voice",
        "Use microphone-recorded WAV audio.",
        415,
      );
    const requestKey = request.headers.get("x-mink-request-key") ?? "";
    if (!REQUEST_KEY.test(requestKey))
      throw new MinkRequestError(
        "invalid_voice",
        "Invalid voice request.",
        400,
      );
    await reserveHelpVoice(clientIp(request.headers), requestKey);
    const bytes = await readMinkBoundedBytes(request, MAX_WAV_BYTES, signal);
    const checked = await validateMinkInput(
      { kind: "audio", bytes, name: "voice-note.wav", requestKey },
      signal,
    );
    if (checked.bytes.length > MAX_WAV_BYTES)
      throw new MinkRequestError(
        "invalid_voice",
        "Voice recording is too long.",
        400,
      );
    provider = await getMinkVoiceProvider();
    signal.throwIfAborted();
    const started = Date.now();
    const result = await transcribeMinkVoice(provider, checked.bytes, signal);
    const providerMs = Date.now() - started;
    signal.throwIfAborted();
    if (result.text.length > 4_000)
      throw new MinkRequestError(
        "invalid_voice",
        "Voice transcript is invalid.",
        400,
      );
    logInfo(result.text ? "help.voice.completed" : "help.voice.empty", {
      requestId,
      provider,
      providerMs,
      audioBytes: checked.bytes.length,
      languageCode: result.languageCode,
    });
    return json({ text: result.text, languageCode: result.languageCode });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logInfo("help.voice.refused", { requestId, code: error.code });
      return json({ error: error.message, code: error.code }, error.status);
    }
    logError("help.voice.failed", error, { requestId, provider });
    return json(
      {
        error:
          "Voice isn't working right now. Try again, or type your question.",
      },
      503,
    );
  } finally {
    processing--;
  }
}
