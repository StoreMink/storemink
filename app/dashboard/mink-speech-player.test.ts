// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playMinkServerSpeech } from "./mink-speech-player";

class FakePlayer {
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  played: string[] = [];
  pause = vi.fn();
  play = vi.fn(() => {
    this.played.push(this.src);
    queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  });
}

const fetchMock = vi.fn();
const audio = (status = 200, type = "audio/wav") => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ "Content-Type": type }),
  blob: async () => new Blob(["x"], { type }),
});
const off = () => ({
  ok: true,
  status: 204,
  headers: new Headers({ "X-Mink-Speech": "off" }),
});

let urls = 0;
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  urls = 0;
  URL.createObjectURL = vi.fn(() => `blob:${++urls}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

const longAnswer = Array.from(
  { length: 8 },
  (_, i) => `This is sentence ${i + 1} of a longer spoken answer for the shop.`,
).join(" ");

describe("playMinkServerSpeech", () => {
  it("plays every piece in order, starting before the rest is ready", async () => {
    fetchMock.mockImplementation(async () => audio());
    const player = new FakePlayer();
    const onStart = vi.fn();
    const result = await playMinkServerSpeech({
      text: longAnswer,
      lang: "en-IN",
      player: player as unknown as HTMLAudioElement,
      signal: new AbortController().signal,
      onStart,
    });
    expect(result).toEqual({ outcome: "done" });
    expect(onStart).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(player.played).toEqual(
      fetchMock.mock.calls.map((_, i) => `blob:${i + 1}`),
    );
    const sent = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init.body).text as string,
    );
    expect(sent.join(" ")).toBe(longAnswer);
    expect(sent[0].length).toBeLessThanOrEqual(160);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(sent.length);
  });

  it("hands the whole answer to the browser when no model is on", async () => {
    fetchMock.mockImplementation(async () => off());
    const player = new FakePlayer();
    const result = await playMinkServerSpeech({
      text: "Short answer.",
      lang: "en-IN",
      player: player as unknown as HTMLAudioElement,
      signal: new AbortController().signal,
      onStart: vi.fn(),
    });
    expect(result).toEqual({ outcome: "off", remaining: "Short answer." });
    expect(player.play).not.toHaveBeenCalled();
  });

  it("hands the unplayed rest to the browser after a failed piece", async () => {
    fetchMock
      .mockImplementationOnce(async () => audio())
      .mockImplementation(async () => audio(503, "application/json"));
    const player = new FakePlayer();
    const result = await playMinkServerSpeech({
      text: longAnswer,
      lang: "en-IN",
      player: player as unknown as HTMLAudioElement,
      signal: new AbortController().signal,
      onStart: vi.fn(),
    });
    expect(result.outcome).toBe("browser");
    const remaining = (result as { remaining: string }).remaining;
    expect(longAnswer.endsWith(remaining)).toBe(true);
    expect(remaining.length).toBeLessThan(longAnswer.length);
    expect(player.played).toHaveLength(1);
  });

  it("falls back when the browser refuses to play", async () => {
    fetchMock.mockImplementation(async () => audio());
    const player = new FakePlayer();
    player.play.mockImplementation(() =>
      Promise.reject(new DOMException("blocked", "NotAllowedError")),
    );
    const result = await playMinkServerSpeech({
      text: "Short answer.",
      lang: "en-IN",
      player: player as unknown as HTMLAudioElement,
      signal: new AbortController().signal,
      onStart: vi.fn(),
    });
    expect(result).toEqual({ outcome: "browser", remaining: "Short answer." });
  });

  it("stops quietly when cancelled mid-answer", async () => {
    fetchMock.mockImplementation(async () => audio());
    const controller = new AbortController();
    const player = new FakePlayer();
    player.play.mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    const result = await playMinkServerSpeech({
      text: longAnswer,
      lang: "en-IN",
      player: player as unknown as HTMLAudioElement,
      signal: controller.signal,
      onStart: vi.fn(),
    });
    expect(result).toEqual({ outcome: "cancelled" });
    expect(player.pause).toHaveBeenCalled();
  });
});
