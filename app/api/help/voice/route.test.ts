import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: vi.fn(),
  reserve: vi.fn(),
  validate: vi.fn(),
  provider: vi.fn(),
  transcribe: vi.fn(),
  log: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/mink/config", () => ({ getMinkConfig: h.config }));
vi.mock("@/lib/mink/input-limits", () => ({ reserveHelpVoice: h.reserve }));
vi.mock("@/lib/mink/input-validation", () => ({
  validateMinkInput: h.validate,
}));
vi.mock("@/lib/mink/voice-settings", () => ({
  getMinkVoiceProvider: h.provider,
}));
vi.mock("@/lib/mink/voice-transcription", () => ({
  transcribeMinkVoice: h.transcribe,
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: h.log,
  logError: h.logError,
}));

import { MinkRequestError } from "@/lib/mink/errors";
import { POST } from "./route";

const url = "http://help.localhost:3000/api/help/voice";
const requestKey = "11111111-1111-4111-8111-111111111111";
const req = (headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: {
      host: "help.localhost:3000",
      origin: "http://help.localhost:3000",
      "Content-Type": "audio/wav",
      "X-Mink-Request-Key": requestKey,
      "x-forwarded-for": "203.0.113.9",
      ...headers,
    },
    body: new Uint8Array([1, 2, 3]),
  });

beforeEach(() => {
  vi.resetAllMocks();
  h.config.mockReturnValue({ enabled: true });
  h.validate.mockImplementation(async (input) => ({
    kind: "audio",
    bytes: input.bytes,
  }));
  h.provider.mockResolvedValue("chirp_3");
  h.transcribe.mockResolvedValue({
    text: "How do I add a product?",
    languageCode: "en-IN",
  });
});

describe("public Help Centre voice", () => {
  it("returns one transcript and spends the visitor's own buckets", async () => {
    const response = await POST(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: "How do I add a product?",
      languageCode: "en-IN",
    });
    expect(h.reserve).toHaveBeenCalledWith(expect.any(String), requestKey);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("never logs the words", async () => {
    await POST(req());
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("add a product");
  });

  it("answers only on the Help Centre host", async () => {
    const response = await POST(
      req({
        "x-forwarded-host": "echos.localhost:3000",
        origin: "http://echos.localhost:3000",
      }),
    );
    expect(response.status).toBe(404);
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it("refuses a request from another origin", async () => {
    const response = await POST(req({ origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it("is off while Mink AI is switched off", async () => {
    h.config.mockReturnValue({ enabled: false });
    const response = await POST(req());
    expect(response.status).toBe(404);
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it("refuses anything but WAV and a request key, before spending", async () => {
    expect((await POST(req({ "Content-Type": "audio/webm" }))).status).toBe(
      415,
    );
    expect((await POST(req({ "X-Mink-Request-Key": "nope" }))).status).toBe(
      400,
    );
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it("passes a limit refusal through in its own words", async () => {
    h.reserve.mockRejectedValue(
      new MinkRequestError(
        "voice_rate_limit",
        "Voice has reached its limit.",
        429,
      ),
    );
    const response = await POST(req());
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "voice_rate_limit" });
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it("treats a clip with no words as an ordinary answer", async () => {
    h.transcribe.mockResolvedValue({ text: "", languageCode: null });
    const response = await POST(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "", languageCode: null });
  });

  it("reports a provider failure as 503 without its details", async () => {
    h.transcribe.mockRejectedValue(new Error("PERMISSION_DENIED"));
    const response = await POST(req());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/type your question/);
    expect(JSON.stringify(body)).not.toContain("PERMISSION");
    expect(h.logError).toHaveBeenCalled();
  });
});
