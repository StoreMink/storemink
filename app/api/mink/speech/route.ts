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

/**
 * ★★ THE FREE ALLOWANCE IS COUNTED IN CHARACTERS. Read-aloud costs the
 * merchant no credits and the provider bills StoreMink per character, so the
 * spend ceiling is a character budget: 40,000 a minute per admin and 600,000
 * an hour per store, exactly what the old limits allowed (20 and 300 requests
 * of up to 2,000 characters each). Voice chat sends a sentence or two per
 * request, so it needs far more requests than reading whole answers did; the
 * request limits below were raised for that, and on their own they let 1.2
 * times the old characters through.
 */
const CHARS_PER_ADMIN_MINUTE = 40_000;
const CHARS_PER_STORE_HOUR = 600_000;
/** Requests, for the overhead each one costs; the budget above bounds the spend. */
const REQUESTS_PER_ADMIN_MINUTE = 60;
const REQUESTS_PER_STORE_HOUR = 1_200;

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
    const actor = await getMinkActorContext(crypto.randomUUID());
    // Resolving the actor alone costs a permissions read, a store/locations
    // read and the brand-voice read, so this is bounded per actor like every
    // other Mink read route; voice chat asks once per session.
    const limited = await rateLimit(
      `mink-speech:ask:${actor.storeId}:${actor.adminId}`,
      { max: 30, windowSeconds: 60 },
    );
    if (!limited.allowed)
      return json(
        {
          error: "Read-aloud is receiving too many requests.",
          code: "speech_rate_limited",
        },
        429,
      );
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
 * request's own signal. ★ THE SIGNAL FREES THE SLOT TOO: `pull` runs only
 * while the consumer drains, so a connection that stays open but stops
 * reading (a backgrounded tab on a poor link) never reaches `pull` again,
 * and the 60-second ceiling used to abort the provider call while leaving
 * the slot counted until the socket finally closed.
 *
 * ★ NO CREDITS, like dictation: the cost is bounded by the character budget
 * here and the one piece of an answer (at most `MINK_SPEECH_MAX_CHARS`) each
 * request carries.
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

    const limits = await Promise.all([
      rateLimit(`mink-speech:admin:${actor.storeId}:${actor.adminId}`, {
        max: REQUESTS_PER_ADMIN_MINUTE,
        windowSeconds: 60,
      }),
      rateLimit(`mink-speech:store:${actor.storeId}`, {
        max: REQUESTS_PER_STORE_HOUR,
        windowSeconds: 3_600,
      }),
      rateLimit(`mink-speech-chars:admin:${actor.storeId}:${actor.adminId}`, {
        max: CHARS_PER_ADMIN_MINUTE,
        windowSeconds: 60,
        cost: text.length,
      }),
      rateLimit(`mink-speech-chars:store:${actor.storeId}`, {
        max: CHARS_PER_STORE_HOUR,
        windowSeconds: 3_600,
        cost: text.length,
      }),
    ]);
    if (limits.some((limit) => !limit.allowed))
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
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const onAbort = () => {
      release();
      void iterator.return(undefined).catch(() => undefined);
      // A no-op once the stream has already closed or errored.
      controller?.error(signal.reason ?? new Error("Read-aloud stopped."));
    };
    /** The slot goes back and the abort listener with it. */
    const settle = () => {
      release();
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      settle();
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
      start(c) {
        controller = c;
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull(c) {
        try {
          const { value, done } = await iterator.next();
          if (done) {
            c.close();
            finish();
            return;
          }
          bytes += value.length;
          c.enqueue(new Uint8Array(value));
        } catch (error) {
          settle();
          // The text being read is never logged, only the transport failure.
          if (!signal.aborted)
            logError("mink.speech.stream_failed", error, {
              requestId,
              provider: streamProvider,
              bytes,
            });
          c.error(error);
        }
      },
      async cancel() {
        // The slot goes back first: the iterator may be mid-read, and a
        // return() queued behind that read settles only once it does. The
        // listener comes off before the abort, or it would error a stream
        // the consumer has just cancelled.
        settle();
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
