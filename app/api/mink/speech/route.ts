import { NextResponse } from "next/server";
import { getMinkConfig } from "@/lib/mink/config";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { MinkRequestError } from "@/lib/mink/errors";
import { getMinkSpeechSettings } from "@/lib/mink/voice-settings";
import {
  MINK_SPEECH_MAX_CHARS,
  MinkSpeechUnsupportedError,
  synthesizeMinkSpeech,
} from "@/lib/mink/speech-synthesis";
import type { MinkSpeechProvider } from "@/lib/mink/voice-provider";
import { rateLimit } from "@/lib/rate-limit";
import { logError, logInfo } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LANG = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** No model audio: `off` for the whole voice chat, `unsupported` for this answer. */
const browserVoice = (reason: "off" | "unsupported") =>
  new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store, private", "X-Mink-Speech": reason },
  });

let processing = 0;

/**
 * Whether answers are read by a model at all, asked once when voice chat
 * turns on (while the merchant is still speaking), so a store on the browser
 * voice does not pay a round trip before every answer.
 */
export async function GET() {
  if (!getMinkConfig().enabled) return json({ enabled: false });
  try {
    await getMinkActorContext(crypto.randomUUID());
    const settings = await getMinkSpeechSettings();
    return json({ enabled: settings.enabled });
  } catch (error) {
    if (error instanceof MinkRequestError)
      return json({ error: error.message, code: error.code }, error.status);
    return json({ enabled: false });
  }
}

/**
 * Reads one stretch of a Mink answer aloud for voice chat.
 *
 * ★ 204 MEANS "USE THE BROWSER VOICE". When the operator has no read-aloud
 * model switched on, the browser falls back to its own speechSynthesis for
 * the rest of the voice chat; that is also the answer to any provider failure
 * the browser can recover from, so a model outage costs voice quality, never
 * the answer.
 *
 * ★ NO CREDITS, like dictation: the cost is bounded by the rate limits here
 * and by the answer length the voice chat sends (≤600 characters a request,
 * ≤1,500 an answer).
 */
export async function POST(request: Request) {
  const origin = rejectForeignMinkOrigin(request);
  if (origin) return origin;
  if (!getMinkConfig().enabled)
    return json({ error: "Voice chat is not enabled." }, 404);
  if (processing >= 4)
    return json({ error: "Read-aloud is busy. Try again shortly." }, 429);

  processing++;
  const requestId = crypto.randomUUID();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  let provider: MinkSpeechProvider | null = null;
  try {
    const actor = await getMinkActorContext(requestId);
    const settings = await getMinkSpeechSettings();
    if (!settings.enabled) return browserVoice("off");
    provider = settings.provider;

    const body = await readMinkBoundedJson(request, 8_192, signal);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > MINK_SPEECH_MAX_CHARS)
      throw new MinkRequestError(
        "invalid_speech",
        "Nothing to read aloud.",
        400,
      );
    const lang =
      typeof body.lang === "string" && LANG.test(body.lang)
        ? body.lang
        : "en-IN";

    const [perAdmin, perStore] = await Promise.all([
      rateLimit(`mink-speech:admin:${actor.storeId}:${actor.adminId}`, {
        max: 60,
        windowSeconds: 60,
      }),
      rateLimit(`mink-speech:store:${actor.storeId}`, {
        max: 600,
        windowSeconds: 3_600,
      }),
    ]);
    if (!perAdmin.allowed || !perStore.allowed)
      throw new MinkRequestError(
        "speech_rate_limited",
        "Read-aloud is resting for a moment.",
        429,
      );

    const started = Date.now();
    const result = await synthesizeMinkSpeech(provider, text, lang, signal);
    signal.throwIfAborted();
    logInfo("mink.speech.completed", {
      requestId,
      storeId: actor.storeId,
      provider,
      chars: text.length,
      bytes: result.audio.length,
      ms: Date.now() - started,
    });
    return new NextResponse(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        "Content-Type": result.mimeType,
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof MinkSpeechUnsupportedError) {
      // A language the chosen model has no voice for: the browser reads it.
      logInfo("mink.speech.unsupported_language", { requestId, provider });
      return browserVoice("unsupported");
    }
    // ★ The text being read is never logged, only the transport failure.
    logError("mink.speech.failed", error, { requestId, provider });
    if (error instanceof MinkRequestError)
      return json({ error: error.message, code: error.code }, error.status);
    return json({ error: "Read-aloud is unavailable right now." }, 503);
  } finally {
    processing--;
  }
}
