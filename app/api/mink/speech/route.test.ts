import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  config: vi.fn(),
  settings: vi.fn(),
  stream: vi.fn(),
  rateLimit: vi.fn(),
  log: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/mink/actor-context", () => ({ getMinkActorContext: h.actor }));
vi.mock("@/lib/mink/config", () => ({ getMinkConfig: h.config }));
vi.mock("@/lib/mink/voice-settings", () => ({
  getMinkSpeechSettings: h.settings,
}));
vi.mock("@/lib/mink/speech-synthesis", async () => {
  class MinkSpeechUnsupportedError extends Error {}
  return {
    MINK_SPEECH_MAX_CHARS: 2_000,
    MinkSpeechUnsupportedError,
    streamMinkSpeech: h.stream,
  };
});
vi.mock("@/lib/rate-limit", () => ({ rateLimit: h.rateLimit }));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: h.log,
  logError: h.logError,
}));

import { GET, POST } from "./route";
import { MinkSpeechUnsupportedError } from "@/lib/mink/speech-synthesis";

const url = "https://echos.dev.storemink.com/api/mink/speech";
const req = (
  body: unknown,
  origin = new URL(url).origin,
  signal?: AbortSignal,
) =>
  new Request(url, {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

async function* chunks(...parts: number[][]): AsyncGenerator<Buffer> {
  for (const part of parts) yield Buffer.from(part);
}

/** A stream that holds its slot until the request's signal is aborted. */
function heldOpen(signal: AbortSignal) {
  async function* pcm(): AsyncGenerator<Buffer> {
    yield Buffer.from([0, 0]);
    await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  }
  return { sampleRate: 24_000, pcm: pcm() };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.config.mockReturnValue({ enabled: true });
  h.actor.mockResolvedValue({ storeId: "echos", adminId: "owner" });
  h.settings.mockResolvedValue({
    enabled: true,
    provider: "bulbul_v4_flash",
  });
  h.rateLimit.mockResolvedValue({ allowed: true });
  h.stream.mockImplementation(async () => ({
    sampleRate: 24_000,
    pcm: chunks([1, 2, 3, 4], [5, 6]),
  }));
});

describe("POST /api/mink/speech", () => {
  it("streams the chosen model's PCM as it arrives, with its format", async () => {
    const response = await POST(
      req({ text: "आज पाँच ऑर्डर आए।", lang: "hi-IN" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("X-Mink-Audio")).toBe("pcm16le;rate=24000");
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(h.stream).toHaveBeenCalledWith(
      "bulbul_v4_flash",
      "आज पाँच ऑर्डर आए।",
      "hi-IN",
      expect.any(AbortSignal),
    );
    expect(h.log).toHaveBeenCalledWith(
      "mink.speech.completed",
      expect.objectContaining({ bytes: 6, provider: "bulbul_v4_flash" }),
    );
    // The text being read never reaches the log.
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("ऑर्डर");
  });

  it("answers 204 off when no read-aloud model is switched on", async () => {
    h.settings.mockResolvedValue({
      enabled: false,
      provider: "gemini_3_8_flash_lite_tts",
    });
    const response = await POST(req({ text: "Hello", lang: "en-IN" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("X-Mink-Speech")).toBe("off");
    expect(h.stream).not.toHaveBeenCalled();
  });

  it("answers 204 unsupported for a language the model has no voice for", async () => {
    h.stream.mockRejectedValue(new MinkSpeechUnsupportedError("ml-IN"));
    const response = await POST(req({ text: "ഇന്ന്", lang: "ml-IN" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("X-Mink-Speech")).toBe("unsupported");
    expect(h.logError).not.toHaveBeenCalled();
  });

  it("refuses empty or overlong text, a junk language becomes en-IN", async () => {
    expect((await POST(req({ text: "  " }))).status).toBe(400);
    expect((await POST(req({ text: "x".repeat(2_001) }))).status).toBe(400);
    const response = await POST(req({ text: "Hi", lang: "<script>" }));
    await response.arrayBuffer();
    expect(h.stream).toHaveBeenLastCalledWith(
      "bulbul_v4_flash",
      "Hi",
      "en-IN",
      expect.any(AbortSignal),
    );
  });

  it("is rate limited per admin and per store", async () => {
    h.rateLimit.mockResolvedValueOnce({ allowed: false });
    const response = await POST(req({ text: "Hello" }));
    expect(response.status).toBe(429);
    expect(h.stream).not.toHaveBeenCalled();
    expect(h.rateLimit).toHaveBeenCalledWith("mink-speech:admin:echos:owner", {
      max: 20,
      windowSeconds: 60,
    });
    expect(h.rateLimit).toHaveBeenCalledWith("mink-speech:store:echos", {
      max: 300,
      windowSeconds: 3_600,
    });
  });

  it("reports a provider outage before any audio as 503 and logs it", async () => {
    h.stream.mockRejectedValue(new Error("Gemini TTS returned 500."));
    const response = await POST(req({ text: "Hello" }));
    expect(response.status).toBe(503);
    expect(h.logError).toHaveBeenCalledWith(
      "mink.speech.failed",
      expect.any(Error),
      expect.objectContaining({ provider: "bulbul_v4_flash" }),
    );
  });

  it("errors the body when the provider fails mid-answer, and logs it", async () => {
    h.stream.mockImplementation(async () => ({
      sampleRate: 24_000,
      pcm: (async function* () {
        yield Buffer.from([1, 2]);
        throw new Error("Gemini TTS stream failed (INTERNAL).");
      })(),
    }));
    const response = await POST(req({ text: "Hello" }));
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(h.logError).toHaveBeenCalledWith(
      "mink.speech.stream_failed",
      expect.any(Error),
      expect.objectContaining({ bytes: 2 }),
    );
  });

  it("holds a slot per open stream and gives it back when the listener stops", async () => {
    h.stream.mockImplementation(async (_p, _t, _l, signal: AbortSignal) =>
      heldOpen(signal),
    );
    const open: Response[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await POST(req({ text: `Answer ${i}` }));
      expect(response.status).toBe(200);
      open.push(response);
    }
    const busy = await POST(req({ text: "One too many" }));
    expect(busy.status).toBe(429);

    // Stopping one stream (voice chat ended) frees its slot at once and
    // cancels the provider call through the shared signal.
    const signal = h.stream.mock.calls[0][3] as AbortSignal;
    await open[0].body!.cancel();
    expect(signal.aborted).toBe(true);
    const next = await POST(req({ text: "Next" }));
    expect(next.status).toBe(200);
    await next.body!.cancel();
    await Promise.all(open.slice(1).map((response) => response.body!.cancel()));
  });

  it("★ frees a slot nobody is draining when the request is aborted", async () => {
    // A connection that stays open but stops reading never reaches `pull`,
    // so only the signal can give its slot back: here the request's own
    // abort stands in for the 60-second ceiling, which shares that signal.
    h.stream.mockImplementation(async (_p, _t, _l, signal: AbortSignal) =>
      heldOpen(signal),
    );
    const stalled = new AbortController();
    const open: Response[] = [];
    open.push(await POST(req({ text: "Stalled" }, undefined, stalled.signal)));
    for (let i = 1; i < 12; i += 1)
      open.push(await POST(req({ text: `Answer ${i}` })));
    expect((await POST(req({ text: "One too many" }))).status).toBe(429);

    stalled.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const providerSignal = h.stream.mock.calls[0][3] as AbortSignal;
    expect(providerSignal.aborted).toBe(true);
    const next = await POST(req({ text: "Next" }));
    expect(next.status).toBe(200);
    // The stalled response's body is errored, never left readable.
    await expect(open[0].arrayBuffer()).rejects.toThrow();
    await next.body!.cancel();
    await Promise.all(open.slice(1).map((response) => response.body!.cancel()));
  });

  it("refuses another site and a disabled Mink before any work", async () => {
    expect(
      (await POST(req({ text: "Hi" }, "https://evil.example"))).status,
    ).toBe(403);
    h.config.mockReturnValue({ enabled: false });
    expect((await POST(req({ text: "Hi" }))).status).toBe(404);
    expect(h.actor).not.toHaveBeenCalled();
  });
});

describe("GET /api/mink/speech", () => {
  it("tells voice chat whether a model reads answers", async () => {
    expect(await (await GET()).json()).toEqual({ enabled: true });
    h.settings.mockResolvedValue({
      enabled: false,
      provider: "bulbul_v4_flash",
    });
    expect(await (await GET()).json()).toEqual({ enabled: false });
  });

  it("is bounded per actor like every other Mink read", async () => {
    h.rateLimit.mockResolvedValueOnce({ allowed: false });
    const response = await GET();
    expect(response.status).toBe(429);
    expect(h.rateLimit).toHaveBeenCalledWith("mink-speech:ask:echos:owner", {
      max: 30,
      windowSeconds: 60,
    });
    expect(h.settings).not.toHaveBeenCalled();
  });
});
