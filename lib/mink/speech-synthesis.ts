import "server-only";

import { googleAccessToken, refusalReason } from "./voice-transcription";
import type { MinkSpeechProvider } from "./voice-provider";

/**
 * Reads one stretch of a Mink answer aloud with the platform's chosen
 * text-to-speech model. The voice chat asks for an answer a few sentences at
 * a time (`splitSpeechChunks`), so each call here is short.
 *
 * ★ NOTHING IS STORED. The text goes to the provider and the audio comes
 * straight back to the merchant's browser; neither is logged or saved.
 */

export type MinkSpeechAudio = { audio: Buffer; mimeType: string };

/** The longest stretch one request may carry; the browser sends ≤600. */
export const MINK_SPEECH_MAX_CHARS = 1_000;

/** Raised when the model cannot read this language; the browser voice takes over. */
export class MinkSpeechUnsupportedError extends Error {}

const GEMINI_TTS_MODEL = "gemini-3.8-flash-lite-tts";

/**
 * Sarvam's Bulbul V4 Flash voices each belong to one language, so the voice
 * follows the answer's language. Conversational or customer-service voices
 * where the catalogue has them; Tamil has only narration voices so far.
 * Malayalam and Odia have no V4 Flash voice yet and are read by the browser.
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
 * The language code Bulbul is asked for. Latin-script text arrives tagged with
 * the browser's own language (en-US, en-GB…), which Bulbul does not accept, so
 * every English variant reads as Indian English; anything else it has no
 * voice for is refused.
 */
export function bulbulLanguageFor(lang: string): string | null {
  const tag = lang.trim();
  if (/^en(-|$)/i.test(tag)) return "en-IN";
  return tag in BULBUL_V4_FLASH_SPEAKERS ? tag : null;
}

/** What the bytes are, read from the bytes rather than trusted from a header. */
export function sniffAudioMime(audio: Buffer): string | null {
  if (audio.length < 12) return null;
  if (
    audio.toString("ascii", 0, 4) === "RIFF" &&
    audio.toString("ascii", 8, 12) === "WAVE"
  )
    return "audio/wav";
  if (audio.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
  if (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}

/** Raw 16-bit mono PCM (Gemini's `audio/L16`) wrapped in a WAV header. */
export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function geminiModel(): string {
  const override = process.env.MINK_TTS_GEMINI_MODEL?.trim();
  // Only a dated version of the same model; another family is a different
  // product the operator switch never offered.
  return override && override.startsWith(GEMINI_TTS_MODEL)
    ? override
    : GEMINI_TTS_MODEL;
}

/**
 * Gemini 3.8 Flash-Lite TTS on Vertex (global only, Preview). Verified
 * 2026-10-18 against storemink-staging: `voiceConfig.voice` takes a voice
 * name and the answer is one complete 24 kHz mono WAV in `inlineData`. The
 * language is read from the text itself.
 */
async function synthesizeWithGemini(
  text: string,
  signal: AbortSignal,
): Promise<MinkSpeechAudio> {
  const project = process.env.GCP_PROJECT_ID;
  if (!project) throw new Error("GCP_PROJECT_ID is not configured.");
  const voice = process.env.MINK_TTS_GEMINI_VOICE?.trim() || "Kore";
  const token = await googleAccessToken();
  const response = await fetch(
    `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/global/publishers/google/models/${encodeURIComponent(geminiModel())}:generateContent`,
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
  if (!response.ok)
    throw new Error(
      `Gemini TTS returned ${response.status}${await refusalReason(response)}.`,
    );
  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ inlineData?: { mimeType?: unknown; data?: unknown } }>;
      };
    }>;
  };
  const inline = data.candidates?.[0]?.content?.parts?.find(
    (part) => typeof part.inlineData?.data === "string",
  )?.inlineData;
  if (!inline || typeof inline.data !== "string")
    throw new Error("Gemini TTS returned no audio.");
  const bytes = Buffer.from(inline.data, "base64");
  const declared = typeof inline.mimeType === "string" ? inline.mimeType : "";
  // Earlier Gemini TTS models answered raw PCM (`audio/L16;rate=24000`).
  if (/^audio\/(l16|pcm)/i.test(declared)) {
    const rate = Number(/rate=(\d+)/i.exec(declared)?.[1]) || 24_000;
    return { audio: pcm16ToWav(bytes, rate), mimeType: "audio/wav" };
  }
  const mimeType = sniffAudioMime(bytes);
  if (!mimeType) throw new Error("Gemini TTS returned unreadable audio.");
  return { audio: bytes, mimeType };
}

/**
 * Sarvam Bulbul V4 Flash (`bulbul:v4-flash`). The request needs the language
 * and a voice from that language; MP3 keeps a long answer small. The answer
 * is base64 audio in `audios`.
 */
async function synthesizeWithBulbul(
  text: string,
  lang: string,
  signal: AbortSignal,
): Promise<MinkSpeechAudio> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY is not configured.");
  const languageCode = bulbulLanguageFor(lang);
  if (!languageCode)
    throw new MinkSpeechUnsupportedError(
      `Bulbul V4 Flash has no voice for ${lang}.`,
    );
  const response = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      language_code: languageCode,
      model: "bulbul:v4-flash",
      speaker: BULBUL_V4_FLASH_SPEAKERS[languageCode],
      speech_sample_rate: 24000,
      output_audio_codec: "mp3",
    }),
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
  const bytes = Buffer.from(first, "base64");
  const mimeType = sniffAudioMime(bytes);
  if (!mimeType) throw new Error("Bulbul V4 Flash returned unreadable audio.");
  return { audio: bytes, mimeType };
}

export function synthesizeMinkSpeech(
  provider: MinkSpeechProvider,
  text: string,
  lang: string,
  signal: AbortSignal,
): Promise<MinkSpeechAudio> {
  return provider === "bulbul_v4_flash"
    ? synthesizeWithBulbul(text, lang, signal)
    : synthesizeWithGemini(text, signal);
}
