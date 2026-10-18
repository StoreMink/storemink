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
  streamMinkSpeech,
} from "@/lib/mink/speech-synthesis";
import type { MinkSpeechProvider } from "@/lib/mink/voice-provider";
import { rateLimit } from "@/lib/rate-limit";
import { logError, logInfo } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LANG = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
/**
 * Concurrent read-aloud streams per instance. A 429 here does not make Cloud
 * Run add an instance, so the cap sits above ordinary use: each stream is
 * network-bound (a few hundred KB through memory at a time), and 1 GiB
 * instances hold many.
 */
const MAX_STREAMS = 12;

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

let streaming = 0;

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
 * Reads one Mink answer aloud for voice chat, as a stream of raw 16-bit mono
 * PCM (`X-Mink-Audio: pcm16le;rate=…`) the browser plays as it arrives.
 *
 * ★ 204 MEANS "USE THE BROWSER VOICE": no model switched on (`off`), or a
 * language the model has no voice for (`unsupported`). A provider failure
 * before any audio is a 503, which the browser also answers with its own
 * voice, so an outage costs voice quality, never the answer.
 *
 * ★ THE SLOT IS HELD UNTIL THE STREAM ENDS, not until this handler returns,
 * and the merchant stopping voice chat cancels the provider call through the
 * request's own signal.
 *
 * ★ NO CREDITS, like dictation: the cost is bounded by the rate limits here
 * and the ≤1,500-character answers the voice chat sends.
 */
export async function POST(request: Request) {
  const origin = rejectForeignMinkOrigin(request);
  if (origin) return origin;
  if (!getMinkConfig().enabled)
    return json({ error: "Voice chat is not enabled." }, 404);
  if (streaming >= MAX_STREAMS)
    return json({ error: "Read-aloud is busy. Try again shortly." }, 429);

  streaming++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    streaming--;
  };
  const requestId = crypto.randomUUID();
  const stop = new AbortController();
  const signal = AbortSignal.any([
    request.signal,
    stop.signal,
    AbortSignal.timeout(60_000),
  ]);
  let provider: MinkSpeechProvider | null = null;
  try {
    const actor = await getMinkActorContext(requestId);
    const settings = await getMinkSpeechSettings();
    if (!settings.enabled) {
      release();
      return browserVoice("off");
    }
    provider = settings.provider;

    const body = await readMinkBoundedJson(request, 12_288, signal);
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
        max: 20,
        windowSeconds: 60,
      }),
      rateLimit(`mink-speech:store:${actor.storeId}`, {
        max: 300,
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
    const speech = await streamMinkSpeech(provider, text, lang, signal);
    const firstAudioMs = Date.now() - started;
    const iterator = speech.pcm;
    const streamProvider = provider;
    let bytes = 0;
    const finish = () => {
      release();
      logInfo("mink.speech.completed", {
        requestId,
        storeId: actor.storeId,
        provider: streamProvider,
        chars: text.length,
        bytes,
        firstAudioMs,
        ms: Date.now() - started,
      });
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await iterator.next();
          if (done) {
            controller.close();
            finish();
            return;
          }
          bytes += value.length;
          controller.enqueue(new Uint8Array(value));
        } catch (error) {
          release();
          // The text being read is never logged, only the transport failure.
          if (!signal.aborted)
            logError("mink.speech.stream_failed", error, {
              requestId,
              provider: streamProvider,
              bytes,
            });
          controller.error(error);
        }
      },
      async cancel() {
        // The slot goes back first: the iterator may be mid-read, and a
        // return() queued behind that read settles only once it does.
        release();
        stop.abort();
        await iterator.return(undefined).catch(() => undefined);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Mink-Audio": `pcm16le;rate=${speech.sampleRate}`,
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    release();
    stop.abort();
    if (error instanceof MinkSpeechUnsupportedError) {
      // A language the chosen model has no voice for: the browser reads it.
      logInfo("mink.speech.unsupported_language", { requestId, provider });
      return browserVoice("unsupported");
    }
    if (error instanceof MinkRequestError)
      return json({ error: error.message, code: error.code }, error.status);
    // The text being read is never logged, only the transport failure.
    logError("mink.speech.failed", error, { requestId, provider });
    return json({ error: "Read-aloud is unavailable right now." }, 503);
  }
}
