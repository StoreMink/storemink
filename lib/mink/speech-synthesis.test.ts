import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./voice-transcription", () => ({
  googleAccessToken: vi.fn(async () => "token"),
  refusalReason: vi.fn(async () => " (PERMISSION_DENIED)"),
}));

import {
  BULBUL_V4_FLASH_SPEAKERS,
  bulbulLanguageFor,
  MinkSpeechUnsupportedError,
  pcm16ToWav,
  sniffAudioMime,
  synthesizeMinkSpeech,
} from "./speech-synthesis";

const fetchMock = vi.fn();
const wav = pcm16ToWav(Buffer.alloc(480), 24_000);
const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20)]);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  process.env.GCP_PROJECT_ID = "storemink-staging";
  process.env.SARVAM_API_KEY = "sarvam-key";
  delete process.env.MINK_TTS_GEMINI_MODEL;
  delete process.env.MINK_TTS_GEMINI_VOICE;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const signal = new AbortController().signal;

describe("audio helpers", () => {
  it("wraps raw PCM in a valid WAV header", () => {
    const out = pcm16ToWav(Buffer.alloc(100), 24_000);
    expect(out.length).toBe(144);
    expect(out.toString("ascii", 0, 4)).toBe("RIFF");
    expect(out.readUInt32LE(24)).toBe(24_000);
    expect(out.readUInt32LE(40)).toBe(100);
  });

  it("reads the format from the bytes", () => {
    expect(sniffAudioMime(wav)).toBe("audio/wav");
    expect(sniffAudioMime(mp3)).toBe("audio/mpeg");
    expect(
      sniffAudioMime(
        Buffer.from([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBe("audio/mpeg");
    expect(sniffAudioMime(Buffer.from("<html>error</html>"))).toBeNull();
  });

  it("maps every English variant to Indian English and refuses unvoiced languages", () => {
    expect(bulbulLanguageFor("en-US")).toBe("en-IN");
    expect(bulbulLanguageFor("en")).toBe("en-IN");
    expect(bulbulLanguageFor("hi-IN")).toBe("hi-IN");
    expect(bulbulLanguageFor("ml-IN")).toBeNull();
    expect(bulbulLanguageFor("fr-FR")).toBeNull();
  });
});

describe("Gemini 3.8 Flash-Lite TTS", () => {
  it("sends the verified request shape and returns the WAV it answers", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "audio/wav",
                    data: wav.toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    const result = await synthesizeMinkSpeech(
      "gemini_3_8_flash_lite_tts",
      "Aaj paanch orders aaye.",
      "en-IN",
      signal,
    );
    expect(result.mimeType).toBe("audio/wav");
    expect(result.audio.equals(wav)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/storemink-staging/locations/global/publishers/google/models/gemini-3.8-flash-lite-tts:generateContent",
    );
    expect(init.headers.Authorization).toBe("Bearer token");
    expect(JSON.parse(init.body)).toEqual({
      contents: [
        { role: "user", parts: [{ text: "Aaj paanch orders aaye." }] },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { voice: "Kore" } },
      },
    });
  });

  it("wraps raw PCM answers and refuses another model family as an override", async () => {
    process.env.MINK_TTS_GEMINI_MODEL = "gemini-2.5-pro";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "audio/L16;codec=pcm;rate=24000",
                    data: Buffer.alloc(48).toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    const result = await synthesizeMinkSpeech(
      "gemini_3_8_flash_lite_tts",
      "Hello",
      "en-IN",
      signal,
    );
    expect(result.mimeType).toBe("audio/wav");
    expect(result.audio.length).toBe(92);
    expect(fetchMock.mock.calls[0][0]).toContain("gemini-3.8-flash-lite-tts");
  });

  it("names the provider's refusal for the log", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(
      synthesizeMinkSpeech("gemini_3_8_flash_lite_tts", "Hi", "en-IN", signal),
    ).rejects.toThrow("Gemini TTS returned 403 (PERMISSION_DENIED).");
  });
});

describe("Sarvam Bulbul V4 Flash", () => {
  it("asks for the language's own voice and MP3, and returns the audio", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        request_id: "r1",
        audios: [mp3.toString("base64")],
      }),
    });
    const result = await synthesizeMinkSpeech(
      "bulbul_v4_flash",
      "आज पाँच ऑर्डर आए।",
      "hi-IN",
      signal,
    );
    expect(result.mimeType).toBe("audio/mpeg");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.sarvam.ai/text-to-speech");
    expect(init.headers["api-subscription-key"]).toBe("sarvam-key");
    expect(JSON.parse(init.body)).toEqual({
      text: "आज पाँच ऑर्डर आए।",
      language_code: "hi-IN",
      model: "bulbul:v4-flash",
      speaker: BULBUL_V4_FLASH_SPEAKERS["hi-IN"],
      speech_sample_rate: 24000,
      output_audio_codec: "mp3",
    });
  });

  it("hands a language it has no voice for to the browser without calling out", async () => {
    await expect(
      synthesizeMinkSpeech("bulbul_v4_flash", "ഇന്ന്", "ml-IN", signal),
    ).rejects.toBeInstanceOf(MinkSpeechUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an answer with no audio in it", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ audios: [] }),
    });
    await expect(
      synthesizeMinkSpeech("bulbul_v4_flash", "Hi", "en-IN", signal),
    ).rejects.toThrow("Bulbul V4 Flash returned no audio.");
  });
});
