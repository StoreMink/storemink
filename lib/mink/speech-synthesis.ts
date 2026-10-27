import "server-only";

import { MINK_SPEECH_PIECE_MAX, normalizeSpeechLanguage } from "./speech-text";
import { googleAccessToken, refusalReason } from "./voice-transcription";
import type { MinkSpeechProvider } from "./voice-provider";
import { streamWavPcm } from "./speech-wav-stream";

/**
 * Reads a Mink answer aloud with the platform's chosen text-to-speech model,
 * as a STREAM of raw 16-bit mono PCM the browser plays while it arrives.
 *
 * ★★ STREAMING IS THE WHOLE OPTIMISATION. Measured 2026-10-18 against Vertex
 * (storemink-staging): waiting for the complete clip took 3.0 s for a sentence,
 * 4.2 s for 154 characters and 8.4 s for 567, while `streamGenerateContent`
 * delivered the first audio in 1.2 to 1.6 s whatever the length, and finished
 * sooner too (5.9 s for the 567). Gemini makes one streamed call per piece;
 * the browser supplies sentence-sized pieces as the answer arrives.
 *
 * ★ Sarvam Bulbul V4 Flash streams WAV over HTTP for each bounded piece.
 * The browser owns short-first segmentation and one-piece-ahead prefetch;
 * splitting here again adds round trips and provider requests unnecessarily.
 * MINK_SARVAM_TTS_TRANSPORT=rest retains the complete-clip path for rollback.
 *
 * ★ NOTHING IS STORED. Text goes to the provider, audio straight back to the
 * merchant's browser; neither is logged or saved.
 */

/**
 * One piece of an answer per request. ★ It was 2,000 characters (a whole
 * answer) while the rate limits rose fourfold for the sentence-by-sentence
 * voice chat, which quadrupled what one merchant could have read aloud for
 * free. The voice chat never sends more than a piece.
 */
export const MINK_SPEECH_MAX_CHARS = MINK_SPEECH_PIECE_MAX;

/** Raised when the model cannot read this language; the browser voice takes over. */
export class MinkSpeechUnsupportedError extends Error {}

export type MinkSpeechStream = {
  /** Samples per second of every chunk in `pcm`. */
  sampleRate: number;
  /** Raw signed 16-bit little-endian mono PCM. */
  pcm: AsyncGenerator<Buffer>;
};

type PcmPart = { rate: number; pcm: Buffer };

const GEMINI_TTS_MODEL = "gemini-3.8-flash-lite-tts";
const SARVAM_SAMPLE_RATE = 24_000;

/**
 * Sarvam's Bulbul V4 Flash voices each belong to one language, so the voice
 * follows the answer's language. Conversational or customer-service voices
 * where the catalogue has them; Tamil has only narration voices so far.
 * (Checked against the published catalogue on 2026-10-28: every id below
 * exists for `bulbul:v4-flash`.)
 */
export const BULBUL_V4_FLASH_SPEAKERS: Record<string, string> = {
  "en-IN": "simran_en_customer",
  "hi-IN": "ritu_hi_customer",
  "bn-IN": "roopa_bn_conversational",
  "gu-IN": "pooja_gu_customer",
  "kn-IN": "chaitra_kn_conversation",
  "mr-IN": "ishita_mr_conversational",
  "pa-IN": "anand_pa_customer",
  "ta-IN": "gokul_ta_narration",
  "te-IN": "kavitha_te_conversation",
};

/**
 * ★ MALAYALAM AND ODIA READ ON BULBUL V3. V4 Flash accepts `ml-IN` and
 *   `od-IN` but its catalogue has no voice for either, and Sarvam's own
 *   migration guidance is to keep that traffic on `bulbul:v3`, whose
 *   speakers read all eleven languages (its published samples use `ishita`
 *   for both). Those merchants heard the browser's voice, or none; now the
 *   same Sarvam call, one model version back. ⚠ Not yet heard live from
 *   here: a refusal falls back to the browser voice exactly as before.
 */
export const BULBUL_V3_SPEAKERS: Record<string, string> = {
  "ml-IN": "ishita",
  "od-IN": "ishita",
};

/** Bulbul's own code for a language: Odia is `od-IN` there, `or-IN` to a browser. */
const BULBUL_LANGUAGE_CODES: Record<string, string> = { "or-IN": "od-IN" };

/**
 * The language code Bulbul is asked for. Latin-script text arrives tagged with
 * the browser's own language (en-US, en-GB…), which Bulbul does not accept, so
 * every English variant reads as Indian English; anything else it has no
 * voice for is refused.
 */
export function bulbulLanguageFor(lang: string): string | null {
  const normalized = normalizeSpeechLanguage(lang) ?? lang.trim();
  if (/^en(-|$)/i.test(normalized)) return "en-IN";
  const tag = BULBUL_LANGUAGE_CODES[normalized] ?? normalized;
  return tag in BULBUL_V4_FLASH_SPEAKERS || tag in BULBUL_V3_SPEAKERS
    ? tag
    : null;
}

/** The model and voice that read `languageCode`: V4 Flash, or V3 where only it has a voice. */
export function bulbulVoiceFor(
  languageCode: string,
  text: string,
): { model: "bulbul:v4-flash" | "bulbul:v3"; speaker: string } {
  return languageCode in BULBUL_V4_FLASH_SPEAKERS
    ? {
        model: "bulbul:v4-flash",
        speaker: bulbulSpeakerFor(languageCode, text),
      }
    : { model: "bulbul:v3", speaker: BULBUL_V3_SPEAKERS[languageCode] };
}

/**
 * The PCM inside a WAV file, walking its chunks rather than assuming a
 * 44-byte header (providers add LIST and other chunks). Only 16-bit mono PCM
 * is accepted, because that is what the browser player decodes; a
 * WAVE_FORMAT_EXTENSIBLE header whose sub-format is PCM counts, since many
 * encoders write that header for 16-bit audio and the data is plain PCM.
 */
export function parseWav(audio: Buffer): PcmPart | null {
  if (
    audio.length < 12 ||
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.toString("ascii", 8, 12) !== "WAVE"
  )
    return null;
  let offset = 12;
  let format: {
    code: number;
    channels: number;
    rate: number;
    bits: number;
  } | null = null;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= audio.length) {
      let code = audio.readUInt16LE(body);
      // Extensible: cbSize(2) validBits(2) channelMask(4) then the sub-format
      // GUID, whose first two bytes are the real format tag.
      if (
        code === 0xfffe &&
        size >= 40 &&
        body + 26 <= audio.length &&
        audio.readUInt16LE(body + 24) === 1
      )
        code = 1;
      format = {
        code,
        channels: audio.readUInt16LE(body + 2),
        rate: audio.readUInt32LE(body + 4),
        bits: audio.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (
        !format ||
        format.code !== 1 ||
        format.channels !== 1 ||
        format.bits !== 16
      )
        return null;
      const end =
        size === 0xffffffff || body + size > audio.length
          ? audio.length
          : body + size;
      return { rate: format.rate, pcm: audio.subarray(body, end) };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** A Gemini audio part: raw `audio/l16; rate=…` PCM, or a WAV file. */
function geminiAudioPart(mimeType: string, data: string): PcmPart | null {
  const bytes = Buffer.from(data, "base64");
  if (/^audio\/(l16|pcm)/i.test(mimeType))
    return {
      rate: Number(/rate=(\d+)/i.exec(mimeType)?.[1]) || 24_000,
      pcm: bytes,
    };
  return parseWav(bytes);
}

function geminiModel(): string {
  const override = process.env.MINK_TTS_GEMINI_MODEL?.trim();
  // Only a dated version of the same model; another family is a different
  // product the operator choice never offered.
  return override && override.startsWith(GEMINI_TTS_MODEL)
    ? override
    : GEMINI_TTS_MODEL;
}

/**
 * Gemini 3.8 Flash-Lite TTS on Vertex (global only, Preview), streamed over
 * SSE. Verified 2026-10-18: each event carries one `audio/l16; rate=24000;
 * channels=1` part; the language is read from the text itself.
 */
async function* geminiPcm(
  text: string,
  signal: AbortSignal,
): AsyncGenerator<PcmPart> {
  const project = process.env.GCP_PROJECT_ID;
  if (!project) throw new Error("GCP_PROJECT_ID is not configured.");
  const voice = process.env.MINK_TTS_GEMINI_VOICE?.trim() || "Kore";
  const token = await googleAccessToken();
  const response = await fetch(
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/global/publishers/google/models/${encodeURIComponent(geminiModel())}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { voice } },
        },
      }),
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok || !response.body)
    throw new Error(
      `Gemini TTS returned ${response.status}${await refusalReason(response)}.`,
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const partsOf = (line: string): PcmPart[] => {
    if (!line.startsWith("data:")) return [];
    const event = JSON.parse(line.slice(5)) as {
      error?: { status?: unknown };
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { mimeType?: unknown; data?: unknown };
          }>;
        };
      }>;
    };
    // An error after the stream opened arrives as an event, not a status.
    // Only its status code is kept: the message may quote the request back.
    if (event.error)
      throw new Error(
        `Gemini TTS stream failed${typeof event.error.status === "string" ? ` (${event.error.status})` : ""}.`,
      );
    const found: PcmPart[] = [];
    for (const part of event.candidates?.[0]?.content?.parts ?? []) {
      const inline = part.inlineData;
      if (typeof inline?.data !== "string") continue;
      const audio = geminiAudioPart(
        typeof inline.mimeType === "string" ? inline.mimeType : "",
        inline.data,
      );
      if (!audio) throw new Error("Gemini TTS returned unreadable audio.");
      found.push(audio);
    }
    return found;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        yield* partsOf(line);
      }
    }
    yield* partsOf(buffered.trim());
  } finally {
    // An early stop (the merchant ended voice chat) closes the provider call.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Hindi and English-Hindi copy share one customer-service persona
 * (`simran_enhi_customer`), the same Simran who reads English
 * (`simran_en_customer`), so an answer whose sentences move between the two
 * keeps one voice. \u2605 Sarvam's guidance reserves the `_enhi_` personas for
 *   genuinely mixed speech, not for English with a loan word: so an English
 *   piece switches to it only when at least two Hindi words, or more than a
 *   quarter of its letters, are Devanagari. Pure Hindi stays on it rather than on a
 *   `_hi_` persona because no `simran_hi_customer` exists, and a Hinglish
 *   answer would otherwise change voice from one sentence to the next.
 */
export function bulbulSpeakerFor(languageCode: string, text: string): string {
  if (languageCode === "hi-IN") return "simran_enhi_customer";
  if (languageCode === "en-IN" && genuinelyMixedHindi(text))
    return "simran_enhi_customer";
  return BULBUL_V4_FLASH_SPEAKERS[languageCode];
}

function genuinelyMixedHindi(text: string): boolean {
  const devanagariWords = text.match(/[\u0900-\u097f]+/gu) ?? [];
  if (devanagariWords.length === 0 || !/[A-Za-z]/.test(text)) return false;
  if (devanagariWords.length >= 2) return true;
  const devanagari = devanagariWords.join("").length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return devanagari > (devanagari + latin) / 4;
}

/**
 * One piece of an answer, as Bulbul is asked for it. `enable_preprocessing`
 * has the provider read numbers, dates and rupee amounts the Indian way and
 * handle the mixed-script copy the spoken prompt writes; 24 kHz is the
 * ceiling of the streaming endpoint; pace 1.0 is Sarvam's own starting point
 * for a conversational agent. (`pitch`, `loudness` and `temperature` are
 * left at their defaults: the API reference and the best-practice guide
 * disagree about which models honour the first two.)
 */
function bulbulRequest(text: string, languageCode: string) {
  return {
    text,
    language_code: languageCode,
    ...bulbulVoiceFor(languageCode, text),
    speech_sample_rate: SARVAM_SAMPLE_RATE,
    output_audio_codec: "wav",
    enable_preprocessing: true,
    pace: 1.0,
  };
}

/** Rollback transport: one complete WAV at 24 kHz. */
async function bulbulPiece(
  text: string,
  languageCode: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<PcmPart> {
  const response = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bulbulRequest(text, languageCode)),
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new Error(
      `Bulbul V4 Flash returned ${response.status}${await refusalReason(response)}.`,
    );
  const data = (await response.json()) as { audios?: unknown };
  const first = Array.isArray(data.audios) ? data.audios[0] : null;
  if (typeof first !== "string" || !first)
    throw new Error("Bulbul V4 Flash returned no audio.");
  const audio = parseWav(Buffer.from(first, "base64"));
  if (!audio) throw new Error("Bulbul V4 Flash returned unreadable audio.");
  return audio;
}

/**
 * Sarvam Bulbul V4 Flash. The browser has already segmented this text to at
 * most 600 characters, comfortably within Sarvam's 2,500-character REST cap.
 */
async function* bulbulPcm(
  text: string,
  lang: string,
  signal: AbortSignal,
): AsyncGenerator<PcmPart> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY is not configured.");
  const languageCode = bulbulLanguageFor(lang);
  if (!languageCode)
    throw new MinkSpeechUnsupportedError(`Bulbul has no voice for ${lang}.`);
  if (process.env.MINK_SARVAM_TTS_TRANSPORT === "rest") {
    yield await bulbulPiece(text, languageCode, apiKey, signal);
    return;
  }
  const response = await fetch("https://api.sarvam.ai/text-to-speech/stream", {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bulbulRequest(text, languageCode)),
    cache: "no-store",
    signal,
  });
  if (!response.ok || !response.body)
    throw new Error(
      `Bulbul V4 Flash stream returned ${response.status}${await refusalReason(response)}.`,
    );
  // No paid REST retry: a pre-audio failure uses the existing browser fallback.
  yield* streamWavPcm(response.body);
}

/**
 * Starts reading `text` aloud and resolves once the first audio exists, so a
 * provider refusal or an unsupported language is known before the route
 * commits to a streamed 200. Later chunks follow through `pcm`.
 */
export async function streamMinkSpeech(
  provider: MinkSpeechProvider,
  text: string,
  lang: string,
  signal: AbortSignal,
): Promise<MinkSpeechStream> {
  signal.throwIfAborted();
  if (!text.trim() || text.length > MINK_SPEECH_MAX_CHARS)
    throw new Error("Read-aloud requires one bounded piece of text.");
  const source =
    provider === "bulbul_v4_flash"
      ? bulbulPcm(text, lang, signal)
      : geminiPcm(text, signal);
  const first = await source.next();
  if (first.done) throw new Error("The read-aloud model returned no audio.");
  const head = first.value;
  const sampleRate = head.rate;
  async function* pcm(): AsyncGenerator<Buffer> {
    try {
      yield head.pcm;
      for await (const part of source) {
        if (part.rate !== sampleRate)
          throw new Error(
            "The read-aloud audio changed sample rate mid-answer.",
          );
        yield part.pcm;
      }
    } finally {
      // A stop while the first chunk was still in hand never reached the
      // for-await, so the provider call is closed here instead.
      await source.return(undefined);
    }
  }
  const output = pcm();
  const finish = output.return.bind(output);
  // Returning an async generator before its first next() skips its finally.
  // The provider has already produced the primed head, so it needs explicit
  // closure even when the listener leaves before consuming that head.
  output.return = async (value) => {
    try {
      return await finish(value);
    } finally {
      await source.return(undefined);
    }
  };
  return { sampleRate, pcm: output };
}
