import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./voice-transcription", () => ({
  googleAccessToken: vi.fn(async () => "token"),
  refusalReason: vi.fn(async () => " (PERMISSION_DENIED)"),
}));

import { MINK_MODEL_VOICE_LANGUAGES } from "./speech-text";
import {
  BULBUL_V3_SPEAKERS,
  BULBUL_V4_FLASH_SPEAKERS,
  bulbulLanguageFor,
  bulbulSpeakerFor,
  MINK_SPEECH_MAX_CHARS,
  MinkSpeechUnsupportedError,
  parseWav,
  streamMinkSpeech,
} from "./speech-synthesis";
import { MINK_SPEECH_PIECE_MAX } from "./speech-text";

const fetchMock = vi.fn();
const signal = new AbortController().signal;
const encoder = new TextEncoder();

/** A WAV file, with an optional LIST chunk ahead of the data like Sarvam's. */
function wavOf(
  pcm: Buffer,
  {
    rate = 24_000,
    channels = 1,
    bits = 16,
    list = false,
  }: { rate?: number; channels?: number; bits?: number; list?: boolean } = {},
): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * (bits / 8), 16);
  fmt.writeUInt16LE(channels * (bits / 8), 20);
  fmt.writeUInt16LE(bits, 22);
  const extra = list
    ? Buffer.concat([
        Buffer.from("LIST"),
        Buffer.from([3, 0, 0, 0, 1, 2, 3, 0]),
      ])
    : Buffer.alloc(0);
  const dataHead = Buffer.alloc(8);
  dataHead.write("data", 0, "ascii");
  dataHead.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([fmt, extra, dataHead, pcm]);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WAVE", 8, "ascii");
  return Buffer.concat([head, body]);
}

const pcmEvent = (bytes: number[], mimeType = "audio/l16; rate=24000") =>
  `data: ${JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: Buffer.from(bytes).toString("base64"),
              },
            },
          ],
        },
      },
    ],
  })}\r\n\r\n`;

/** An SSE response delivered in the given network chunks. */
function sse(chunks: string[], onCancel = vi.fn()) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
      cancel: onCancel,
    }),
  };
}

async function drain(pcm: AsyncGenerator<Buffer>): Promise<number[][]> {
  const out: number[][] = [];
  for await (const chunk of pcm) out.push([...chunk]);
  return out;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  process.env.GCP_PROJECT_ID = "storemink-staging";
  process.env.SARVAM_API_KEY = "sarvam-key";
  delete process.env.MINK_TTS_GEMINI_MODEL;
  delete process.env.MINK_TTS_GEMINI_VOICE;
  vi.stubEnv("MINK_SARVAM_TTS_TRANSPORT", "rest");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseWav", () => {
  it("finds the PCM past extra chunks rather than assuming a 44-byte header", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const parsed = parseWav(wavOf(pcm, { list: true, rate: 22_050 }));
    expect(parsed?.rate).toBe(22_050);
    expect([...(parsed?.pcm ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it("★ accepts an extensible header whose sub-format is PCM", () => {
    const pcm = Buffer.from([5, 6, 7, 8]);
    const file = wavOf(pcm);
    // Rebuild the fmt chunk as WAVE_FORMAT_EXTENSIBLE (40 bytes).
    const fmt = Buffer.alloc(48);
    fmt.write("fmt ", 0, "ascii");
    fmt.writeUInt32LE(40, 4);
    fmt.writeUInt16LE(0xfffe, 8);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(24_000, 12);
    fmt.writeUInt32LE(24_000 * 2, 16);
    fmt.writeUInt16LE(2, 20);
    fmt.writeUInt16LE(16, 22);
    fmt.writeUInt16LE(22, 24); // cbSize
    fmt.writeUInt16LE(16, 26); // valid bits
    fmt.writeUInt32LE(4, 28); // channel mask
    fmt.writeUInt16LE(1, 32); // sub-format: PCM
    const extensible = Buffer.concat([
      file.subarray(0, 12),
      fmt,
      file.subarray(12 + 24),
    ]);
    const parsed = parseWav(extensible);
    expect(parsed?.rate).toBe(24_000);
    expect([...(parsed?.pcm ?? [])]).toEqual([5, 6, 7, 8]);
    // An extensible header carrying a non-PCM sub-format is still refused.
    fmt.writeUInt16LE(3, 32);
    expect(
      parseWav(Buffer.concat([file.subarray(0, 12), fmt, file.subarray(36)])),
    ).toBeNull();
  });

  it("refuses anything the browser player cannot decode", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    expect(parseWav(wavOf(pcm, { channels: 2 }))).toBeNull();
    expect(parseWav(wavOf(pcm, { bits: 8 }))).toBeNull();
    expect(parseWav(Buffer.from("ID3 not a wav file at all"))).toBeNull();
  });

  it("reads a streaming header's unknown data length to the end of the file", () => {
    const file = wavOf(Buffer.from([9, 8, 7, 6]));
    file.writeUInt32LE(0xffffffff, file.length - 8);
    expect([...(parseWav(file)?.pcm ?? [])]).toEqual([9, 8, 7, 6]);
  });

  it("maps every English variant to Indian English and refuses unvoiced languages", () => {
    expect(bulbulLanguageFor("en-US")).toBe("en-IN");
    expect(bulbulLanguageFor("en")).toBe("en-IN");
    expect(bulbulLanguageFor("hi-IN")).toBe("hi-IN");
    // Malayalam and Odia read on V3; Odia is `od-IN` to Bulbul, `or-IN` to a browser.
    expect(bulbulLanguageFor("ml-IN")).toBe("ml-IN");
    expect(bulbulLanguageFor("or-IN")).toBe("od-IN");
    expect(bulbulLanguageFor("od-IN")).toBe("od-IN");
    expect(bulbulLanguageFor("mai-IN")).toBeNull();
    expect(bulbulLanguageFor("fr-FR")).toBeNull();
  });

  it("★ the browser's list of voiced languages is Bulbul's, so a hint never asks for a voice that is not there", () => {
    const voiced = [
      ...Object.keys(BULBUL_V4_FLASH_SPEAKERS),
      ...Object.keys(BULBUL_V3_SPEAKERS),
    ].map((tag) => (tag === "od-IN" ? "or" : tag.split("-")[0]));
    expect([...new Set(voiced)].sort()).toEqual(
      [...MINK_MODEL_VOICE_LANGUAGES].sort(),
    );
  });
});

describe("Gemini 3.8 Flash-Lite TTS (streamed)", () => {
  it("streams the verified request shape and yields PCM as each event lands", async () => {
    const first = pcmEvent([1, 0, 2, 0]);
    // The second event is split across two network chunks.
    const second = pcmEvent([3, 0]);
    fetchMock.mockResolvedValue(
      sse([first, second.slice(0, 20), second.slice(20)]),
    );
    const speech = await streamMinkSpeech(
      "gemini_3_8_flash_lite_tts",
      "Aaj paanch orders aaye.",
      "en-IN",
      signal,
    );
    expect(speech.sampleRate).toBe(24_000);
    expect(await drain(speech.pcm)).toEqual([
      [1, 0, 2, 0],
      [3, 0],
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/storemink-staging/locations/global/publishers/google/models/gemini-3.8-flash-lite-tts:streamGenerateContent?alt=sse",
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

  it("reads a WAV part too, and refuses another model family as an override", async () => {
    process.env.MINK_TTS_GEMINI_MODEL = "gemini-2.5-pro";
    const wav = wavOf(Buffer.from([5, 0, 6, 0]), { rate: 16_000 });
    fetchMock.mockResolvedValue(
      sse([
        `data: ${JSON.stringify({
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
        })}\n\n`,
      ]),
    );
    const speech = await streamMinkSpeech(
      "gemini_3_8_flash_lite_tts",
      "Hello",
      "en-IN",
      signal,
    );
    expect(speech.sampleRate).toBe(16_000);
    expect(await drain(speech.pcm)).toEqual([[5, 0, 6, 0]]);
    expect(fetchMock.mock.calls[0][0]).toContain("gemini-3.8-flash-lite-tts:");
  });

  it("names the provider's refusal before committing to a stream", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, body: null });
    await expect(
      streamMinkSpeech("gemini_3_8_flash_lite_tts", "Hi", "en-IN", signal),
    ).rejects.toThrow("Gemini TTS returned 403 (PERMISSION_DENIED).");
  });

  it("refuses a stream with no audio in it, or an error event", async () => {
    fetchMock.mockResolvedValueOnce(sse(['data: {"candidates":[]}\n\n']));
    await expect(
      streamMinkSpeech("gemini_3_8_flash_lite_tts", "Hi", "en-IN", signal),
    ).rejects.toThrow("The read-aloud model returned no audio.");
    fetchMock.mockResolvedValueOnce(
      sse([
        `data: ${JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Hi was too long" } })}\n\n`,
      ]),
    );
    await expect(
      streamMinkSpeech("gemini_3_8_flash_lite_tts", "Hi", "en-IN", signal),
    ).rejects.toThrow("Gemini TTS stream failed (RESOURCE_EXHAUSTED).");
  });

  it("refuses a sample rate change within a Gemini stream", async () => {
    fetchMock.mockResolvedValueOnce(
      sse([pcmEvent([1, 0]), pcmEvent([2, 0], "audio/l16; rate=8000")]),
    );
    const speech = await streamMinkSpeech(
      "gemini_3_8_flash_lite_tts",
      "Hello",
      "en-IN",
      signal,
    );
    await expect(drain(speech.pcm)).rejects.toThrow("changed sample rate");
  });

  it("closes the provider call when the listener stops after the first chunk", async () => {
    const cancelled = vi.fn();
    fetchMock.mockResolvedValue(
      sse([pcmEvent([1, 0]), pcmEvent([2, 0])], cancelled),
    );
    const speech = await streamMinkSpeech(
      "gemini_3_8_flash_lite_tts",
      "Hi",
      "en-IN",
      signal,
    );
    expect((await speech.pcm.next()).value).toEqual(Buffer.from([1, 0]));
    await speech.pcm.return(undefined);
    expect(cancelled).toHaveBeenCalled();
  });
});

describe("Sarvam Bulbul V4 Flash (piece by piece)", () => {
  const words = (n: number, word: string) =>
    `${Array.from({ length: n }, () => word).join(" ")}.`;
  const answer = [words(15, "Sales"), words(50, "Orders")].join(" ");

  const bulbul = (pcm: number[]) => ({
    ok: true,
    json: async () => ({
      request_id: "r1",
      audios: [wavOf(Buffer.from(pcm), { list: true }).toString("base64")],
    }),
  });

  it("does not split an already-segmented voice-chat piece into extra requests", async () => {
    fetchMock.mockResolvedValueOnce(bulbul([1, 0]));
    expect(answer.length).toBeGreaterThan(160);
    expect(answer.length).toBeLessThanOrEqual(MINK_SPEECH_MAX_CHARS);
    const speech = await streamMinkSpeech(
      "bulbul_v4_flash",
      answer,
      "hi-IN",
      signal,
    );
    expect(speech.sampleRate).toBe(24_000);
    expect(await drain(speech.pcm)).toEqual([[1, 0]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.sarvam.ai/text-to-speech");
    expect(init.headers["api-subscription-key"]).toBe("sarvam-key");
    expect(JSON.parse(init.body)).toEqual({
      text: answer,
      language_code: "hi-IN",
      model: "bulbul:v4-flash",
      speaker: "simran_enhi_customer",
      enable_preprocessing: true,
      pace: 1,
      speech_sample_rate: 24000,
      output_audio_codec: "wav",
    });
  });

  it("hands a language it has no voice for to the browser without calling out", async () => {
    await expect(
      streamMinkSpeech(
        "bulbul_v4_flash",
        "अहाँक ऑर्डर तैयार अछि",
        "mai-IN",
        signal,
      ),
    ).rejects.toBeInstanceOf(MinkSpeechUnsupportedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ reads Malayalam and Odia on Bulbul V3, which has their voices", async () => {
    fetchMock.mockResolvedValueOnce(bulbul([3, 1]));
    const speech = await streamMinkSpeech(
      "bulbul_v4_flash",
      "നിങ്ങളുടെ ഓർഡർ തയ്യാറാണ്.",
      "ml-IN",
      signal,
    );
    expect(await drain(speech.pcm)).toEqual([[3, 1]]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      language_code: "ml-IN",
      model: "bulbul:v3",
      speaker: BULBUL_V3_SPEAKERS["ml-IN"],
      enable_preprocessing: true,
    });
    fetchMock.mockResolvedValueOnce(bulbul([2]));
    await drain(
      (
        await streamMinkSpeech(
          "bulbul_v4_flash",
          "ଆପଣଙ୍କ ଅର୍ଡର ପ୍ରସ୍ତୁତ।",
          "or-IN",
          signal,
        )
      ).pcm,
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      language_code: "od-IN",
      model: "bulbul:v3",
    });
  });

  it("refuses an answer with no audio, or audio the player cannot decode", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ audios: [] }),
    });
    await expect(
      streamMinkSpeech("bulbul_v4_flash", "Hi", "en-IN", signal),
    ).rejects.toThrow("Bulbul V4 Flash returned no audio.");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        audios: [Buffer.from("ID3mp3").toString("base64")],
      }),
    });
    await expect(
      streamMinkSpeech("bulbul_v4_flash", "Hi", "en-IN", signal),
    ).rejects.toThrow("Bulbul V4 Flash returned unreadable audio.");
  });
});

describe("Sarvam HTTP streaming", () => {
  it("starts playback before the provider closes the complete clip", async () => {
    vi.stubEnv("MINK_SARVAM_TTS_TRANSPORT", "");
    const wav = wavOf(Buffer.from([1, 0, 2, 0]), { list: true });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          c.enqueue(wav.subarray(0, wav.length - 2));
        },
        cancel,
      }),
    });
    const speech = await streamMinkSpeech(
      "bulbul_v4_flash",
      "आपका order तैयार है।",
      "hi-IN",
      signal,
    );
    expect((await speech.pcm.next()).value).toEqual(Buffer.from([1, 0]));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.sarvam.ai/text-to-speech/stream",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: "bulbul:v4-flash",
      speaker: "simran_enhi_customer",
      output_audio_codec: "wav",
      enable_preprocessing: true,
    });
    controller.enqueue(wav.subarray(-2));
    controller.close();
    expect(await drain(speech.pcm)).toEqual([[2, 0]]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "cancels the upstream stream, including before playback starts (%s)",
    async (consumeHead) => {
      vi.stubEnv("MINK_SARVAM_TTS_TRANSPORT", "");
      const wav = wavOf(Buffer.from([1, 0, 2, 0]));
      const cancel = vi.fn();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(wav.subarray(0, wav.length - 2));
          },
          cancel,
        }),
      });
      const speech = await streamMinkSpeech(
        "bulbul_v4_flash",
        "Hello.",
        "en-IN",
        signal,
      );
      if (consumeHead) await speech.pcm.next();
      await speech.pcm.return(undefined);
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("does not spend a second paid request when streaming fails", async () => {
    vi.stubEnv("MINK_SARVAM_TTS_TRANSPORT", "");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(
      streamMinkSpeech("bulbul_v4_flash", "Hello.", "en-IN", signal),
    ).rejects.toThrow("429");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the mixed Hindi-English persona without changing Marathi's voice", () => {
    expect(bulbulSpeakerFor("en-IN", "आपका order तैयार है")).toBe(
      "simran_enhi_customer",
    );
    expect(bulbulSpeakerFor("hi-IN", "Order taiyar hai")).toBe(
      "simran_enhi_customer",
    );
    // ★ A loan word is not code-mixing (Sarvam's rule for `_enhi_`): English
    //   with one Hindi word keeps the English persona, the same Simran.
    expect(
      bulbulSpeakerFor("en-IN", "नमस्ते, your order was shipped today."),
    ).toBe("simran_en_customer");
    expect(bulbulSpeakerFor("en-IN", "Chaliye, आपका order देखते हैं")).toBe(
      "simran_enhi_customer",
    );
    expect(bulbulSpeakerFor("mr-IN", "तुमची order तयार आहे")).toBe(
      BULBUL_V4_FLASH_SPEAKERS["mr-IN"],
    );
    expect(bulbulLanguageFor("mr")).toBe("mr-IN");
    expect(bulbulLanguageFor("TA-in")).toBe("ta-IN");
  });
});

describe("★ the read-aloud request cap", () => {
  it.each(["bulbul_v4_flash", "gemini_3_8_flash_lite_tts"] as const)(
    "%s refuses empty, oversized or already-cancelled work before a paid call",
    async (provider) => {
      for (const text of [" ", "a".repeat(MINK_SPEECH_MAX_CHARS + 1)]) {
        await expect(
          streamMinkSpeech(provider, text, "en-IN", signal),
        ).rejects.toThrow("bounded piece");
      }
      const stopped = new AbortController();
      stopped.abort();
      await expect(
        streamMinkSpeech(provider, "Hello", "en-IN", stopped.signal),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("is one piece of an answer, the most the voice chat ever sends", () => {
    expect(MINK_SPEECH_MAX_CHARS).toBe(MINK_SPEECH_PIECE_MAX);
    expect(MINK_SPEECH_MAX_CHARS).toBeLessThanOrEqual(600);
  });
});
