import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  config: vi.fn(),
  settings: vi.fn(),
  synthesize: vi.fn(),
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
    MINK_SPEECH_MAX_CHARS: 1_000,
    MinkSpeechUnsupportedError,
    synthesizeMinkSpeech: h.synthesize,
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
const req = (body: unknown, origin = new URL(url).origin) =>
  new Request(url, {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  h.config.mockReturnValue({ enabled: true });
  h.actor.mockResolvedValue({ storeId: "echos", adminId: "owner" });
  h.settings.mockResolvedValue({
    enabled: true,
    provider: "bulbul_v4_flash",
  });
  h.rateLimit.mockResolvedValue({ allowed: true });
  h.synthesize.mockResolvedValue({
    audio: Buffer.from("ID3audio"),
    mimeType: "audio/mpeg",
  });
});

describe("POST /api/mink/speech", () => {
  it("returns the chosen model's audio for one stretch of an answer", async () => {
    const response = await POST(
      req({ text: "आज पाँच ऑर्डर आए।", lang: "hi-IN" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "ID3audio",
    );
    expect(h.synthesize).toHaveBeenCalledWith(
      "bulbul_v4_flash",
      "आज पाँच ऑर्डर आए।",
      "hi-IN",
      expect.any(AbortSignal),
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
    expect(h.synthesize).not.toHaveBeenCalled();
  });

  it("answers 204 unsupported for a language the model has no voice for", async () => {
    h.synthesize.mockRejectedValue(new MinkSpeechUnsupportedError("ml-IN"));
    const response = await POST(req({ text: "ഇന്ന്", lang: "ml-IN" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("X-Mink-Speech")).toBe("unsupported");
    expect(h.logError).not.toHaveBeenCalled();
  });

  it("refuses empty or overlong text, a junk language becomes en-IN", async () => {
    expect((await POST(req({ text: "  " }))).status).toBe(400);
    expect((await POST(req({ text: "x".repeat(1_001) }))).status).toBe(400);
    await POST(req({ text: "Hi", lang: "<script>" }));
    expect(h.synthesize).toHaveBeenLastCalledWith(
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
    expect(h.synthesize).not.toHaveBeenCalled();
    expect(h.rateLimit).toHaveBeenCalledWith("mink-speech:admin:echos:owner", {
      max: 60,
      windowSeconds: 60,
    });
  });

  it("reports a provider outage as 503 and logs it", async () => {
    h.synthesize.mockRejectedValue(new Error("Gemini TTS returned 500."));
    const response = await POST(req({ text: "Hello" }));
    expect(response.status).toBe(503);
    expect(h.logError).toHaveBeenCalledWith(
      "mink.speech.failed",
      expect.any(Error),
      expect.objectContaining({ provider: "bulbul_v4_flash" }),
    );
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
});
