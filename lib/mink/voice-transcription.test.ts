import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ token: vi.fn(), getClient: vi.fn() }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getClient = h.getClient;
  },
}));

import {
  SAARAS_KEYTERMS,
  SAARAS_LANGUAGE_FLOOR,
  transcribeMinkVoice,
} from "./voice-transcription";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GCP_PROJECT_ID", "storemink-test");
  vi.stubEnv("MINK_CHIRP_LOCATION", "");
  vi.stubEnv("SARVAM_API_KEY", "sarvam-secret");
  h.token.mockResolvedValue({ token: "adc-token" });
  h.getClient.mockResolvedValue({ getAccessToken: h.token });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("googleAccessToken", () => {
  it("★ a failed token read forgets only its own client", async () => {
    const { googleAccessToken } = await import("./voice-transcription");
    let failA!: (reason: Error) => void;
    let failC!: (reason: Error) => void;
    const tokenA = new Promise<never>((_, reject) => (failA = reject));
    const tokenC = new Promise<never>((_, reject) => (failC = reject));
    h.token
      .mockReturnValueOnce(tokenA)
      .mockReturnValueOnce(tokenC)
      .mockResolvedValue({ token: "fresh" });
    // Two callers share the one cached client while its tokens are pending.
    const a = googleAccessToken();
    const c = googleAccessToken();
    a.catch(() => {});
    c.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const built = h.getClient.mock.calls.length;
    // A fails: the shared client is forgotten and the next call builds one.
    failA(new Error("token endpoint hiccup"));
    await expect(a).rejects.toThrow("token endpoint hiccup");
    await expect(googleAccessToken()).resolves.toBe("fresh");
    expect(h.getClient).toHaveBeenCalledTimes(built + 1);
    // C, still on the old client, fails late: the fresh client survives it.
    failC(new Error("late failure"));
    await expect(c).rejects.toThrow("late failure");
    await expect(googleAccessToken()).resolves.toBe("fresh");
    expect(h.getClient).toHaveBeenCalledTimes(built + 1);
  });
});

describe("Mink voice providers", () => {
  it("asks Chirp 3 to detect the language automatically", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              alternatives: [{ transcript: "hello store" }],
              languageCode: "en-IN",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await expect(
      transcribeMinkVoice(
        "chirp_3",
        Buffer.from("wav"),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "hello store", languageCode: "en-IN" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      "us-speech.googleapis.com/v2/projects/storemink-test",
    );
    expect(init.headers).toMatchObject({ Authorization: "Bearer adc-token" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      config: { languageCodes: ["auto"], model: "chirp_3" },
    });
  });

  it("sends WAV to Saaras v4 with automatic language detection", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ transcript: "नमस्ते", language_code: "hi-IN" }),
        { status: 200 },
      ),
    );
    await expect(
      transcribeMinkVoice(
        "saaras_v4",
        Buffer.from("wav"),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "नमस्ते", languageCode: "hi-IN" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sarvam.ai/speech-to-text");
    expect(init.headers).toEqual({ "api-subscription-key": "sarvam-secret" });
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("model")).toBe("saaras:v4");
    expect(JSON.parse(String((init.body as FormData).get("keyterms")))).toEqual(
      SAARAS_KEYTERMS,
    );
    expect((init.body as FormData).get("language_code")).toBe("unknown");
  });

  it("★ tells Saaras the product's own names, within its keyterm limits", () => {
    // At most 50 terms of 64 characters, one phrase each (no commas).
    expect(SAARAS_KEYTERMS.length).toBeLessThanOrEqual(50);
    for (const term of SAARAS_KEYTERMS) {
      expect(term.length).toBeLessThanOrEqual(64);
      expect(term).not.toContain(",");
    }
    expect(SAARAS_KEYTERMS).toContain("StoreMink");
    expect(SAARAS_KEYTERMS).toContain("Website Builder");
    expect(new Set(SAARAS_KEYTERMS).size).toBe(SAARAS_KEYTERMS.length);
  });

  it("★ keeps a confident language guess and drops a doubtful one, never the words", async () => {
    const answer = (probability: number) =>
      new Response(
        JSON.stringify({
          transcript: "order ready hai",
          language_code: "hi-IN",
          language_probability: probability,
        }),
        { status: 200 },
      );
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValueOnce(answer(0.93));
    await expect(
      transcribeMinkVoice("saaras_v4", Buffer.from("wav"), signal),
    ).resolves.toEqual({
      text: "order ready hai",
      languageCode: "hi-IN",
      languageProbability: 0.93,
    });
    fetchMock.mockResolvedValueOnce(answer(SAARAS_LANGUAGE_FLOOR - 0.01));
    await expect(
      transcribeMinkVoice("saaras_v4", Buffer.from("wav"), signal),
    ).resolves.toEqual({
      text: "order ready hai",
      languageCode: null,
      languageProbability: SAARAS_LANGUAGE_FLOOR - 0.01,
    });
  });

  it("★ returns no words as an empty transcript rather than throwing", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    await expect(
      transcribeMinkVoice(
        "chirp_3",
        Buffer.from("wav"),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "", languageCode: null });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ transcript: "  " }), { status: 200 }),
    );
    await expect(
      transcribeMinkVoice(
        "saaras_v4",
        Buffer.from("wav"),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "", languageCode: null });
  });
});

// ---------------------------------------------------------------------------
// ★★ A REFUSAL HAS TO NAME ITSELF IN THE LOG.
//
// The merchant is told only "Voice transcription is unavailable or timed out",
// deliberately — so the thrown message is the ONLY place the cause survives.
// It used to be a bare status code, which is identical for an API nobody
// enabled on the project, a service account without `roles/speech.client` and
// an expired credential: three remedies, two of them outside this codebase.
// Verified against the live endpoint, which answered a real dictation attempt
// with 403 PERMISSION_DENIED / SERVICE_DISABLED.
// ---------------------------------------------------------------------------
describe("a provider refusal", () => {
  const googleRefusal = JSON.stringify({
    error: {
      code: 403,
      message:
        "Cloud Speech-to-Text API has not been used in project storemink-staging before or it is disabled.",
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
        },
      ],
    },
  });

  it("★★ names Google's own reason, so a disabled API is not read as a timeout", async () => {
    fetchMock.mockResolvedValue(new Response(googleRefusal, { status: 403 }));
    await expect(
      transcribeMinkVoice(
        "chirp_3",
        Buffer.from("wav"),
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "Chirp 3 returned 403 (PERMISSION_DENIED, SERVICE_DISABLED).",
    );
  });

  it("★ carries the enum codes and NOT the provider's prose", async () => {
    fetchMock.mockResolvedValue(new Response(googleRefusal, { status: 403 }));
    const error = await transcribeMinkVoice(
      "chirp_3",
      Buffer.from("wav"),
      new AbortController().signal,
    ).catch((thrown: Error) => thrown);
    // The message is free text the provider may change and may quote the
    // request back; only the closed vocabulary is safe to carry.
    expect((error as Error).message).not.toContain("has not been used");
    expect((error as Error).message).not.toContain("storemink-staging");
  });

  it("does not leak free text disguised as a provider reason into server logs", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            status: "request containing private transcript",
            details: [
              { reason: "SECRET=private" },
              { reason: "RESOURCE_EXHAUSTED" },
            ],
          },
        }),
        { status: 429 },
      ),
    );
    await expect(
      transcribeMinkVoice(
        "chirp_3",
        Buffer.from("wav"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Chirp 3 returned 429 (RESOURCE_EXHAUSTED).");
  });

  it("★ still reports the status when the body explains nothing", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>502</html>", { status: 502 }),
    );
    await expect(
      transcribeMinkVoice(
        "saaras_v4",
        Buffer.from("wav"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Saaras v4 returned 502.");
  });
});
