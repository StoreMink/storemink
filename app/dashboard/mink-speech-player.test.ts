// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playMinkServerSpeech } from "./mink-speech-player";

type FakeSource = {
  buffer: { duration: number; data: Float32Array } | null;
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

/** Just enough of an AudioContext: buffers, sources and a settable clock. */
class FakeAudioContext {
  state: "running" | "suspended" = "running";
  currentTime = 10;
  destination = {};
  sources: FakeSource[] = [];
  /** Sources end on their own unless a test holds them playing. */
  autoEnd = true;
  resume = vi.fn(async () => {
    this.state = "running";
  });
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, data, getChannelData: () => data };
  }
  createBufferSource() {
    const source: FakeSource = {
      buffer: null,
      onended: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(() => {
        if (this.autoEnd) setTimeout(() => source.onended?.(), 0);
      }),
      stop: vi.fn(),
    };
    this.sources.push(source);
    return source;
  }
}

const fetchMock = vi.fn();

/** A streamed PCM answer delivered in the given network chunks. */
function pcmResponse(chunks: number[][], { rate = 24_000, fail = false } = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "X-Mink-Audio": `pcm16le;rate=${rate}` }),
    // Pulled one chunk at a time: an error() in start() would discard
    // chunks already queued, which is not how a dropped connection behaves.
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(new Uint8Array(next));
        else if (fail) controller.error(new Error("network dropped"));
        else controller.close();
      },
    }),
  };
}
const noModel = (reason: "off" | "unsupported") => ({
  ok: true,
  status: 204,
  headers: new Headers({ "X-Mink-Speech": reason }),
  body: null,
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function play(
  audio: FakeAudioContext,
  signal = new AbortController().signal,
  onStart = vi.fn(),
) {
  return playMinkServerSpeech({
    text: "Sales are up today.",
    lang: "en-IN",
    audio: audio as unknown as AudioContext,
    signal,
    onStart,
  });
}

describe("playMinkServerSpeech", () => {
  it("asks once, then plays each chunk back to back as it lands", async () => {
    // 0x4000 = +0.5, 0xC000 = -0.5 (little-endian 16-bit).
    fetchMock.mockResolvedValue(
      pcmResponse([
        [0x00, 0x40, 0x00, 0xc0],
        [0x00, 0x40],
      ]),
    );
    const audio = new FakeAudioContext();
    const onStart = vi.fn();
    const result = await play(audio, undefined, onStart);
    expect(result).toEqual({ outcome: "done" });
    expect(onStart).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      text: "Sales are up today.",
      lang: "en-IN",
    });
    expect(audio.sources).toHaveLength(2);
    expect([...audio.sources[0].buffer!.data]).toEqual([0.5, -0.5]);
    // The first chunk waits a short lead; the second starts where it ends.
    const firstAt = audio.sources[0].start.mock.calls[0][0] as number;
    expect(firstAt).toBeCloseTo(10.25);
    expect(audio.sources[1].start.mock.calls[0][0]).toBeCloseTo(
      firstAt + 2 / 24_000,
    );
  });

  it("joins a sample split across two network chunks", async () => {
    fetchMock.mockResolvedValue(pcmResponse([[0x00], [0x40, 0x00, 0xc0]]));
    const audio = new FakeAudioContext();
    expect(await play(audio)).toEqual({ outcome: "done" });
    expect(audio.sources).toHaveLength(1);
    expect([...audio.sources[0].buffer!.data]).toEqual([0.5, -0.5]);
  });

  it("starts a context the browser suspended", async () => {
    fetchMock.mockResolvedValue(pcmResponse([[0x00, 0x40]]));
    const audio = new FakeAudioContext();
    audio.state = "suspended";
    await play(audio);
    expect(audio.resume).toHaveBeenCalled();
  });

  it("hands the whole voice chat to the browser when no model is on", async () => {
    fetchMock.mockResolvedValue(noModel("off"));
    const audio = new FakeAudioContext();
    expect(await play(audio)).toEqual({
      outcome: "off",
      remaining: "Sales are up today.",
    });
    fetchMock.mockResolvedValue(noModel("unsupported"));
    expect(await play(audio)).toEqual({
      outcome: "browser",
      remaining: "Sales are up today.",
    });
    expect(audio.sources).toHaveLength(0);
  });

  it("lets the browser read it when the model fails before any audio", async () => {
    const audio = new FakeAudioContext();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: new Headers(),
      body: null,
    });
    expect((await play(audio)).outcome).toBe("browser");
    // A 200 that is not the PCM format the player decodes.
    fetchMock.mockResolvedValueOnce({
      ...pcmResponse([[0, 0]]),
      headers: new Headers({ "Content-Type": "audio/mpeg" }),
    });
    expect((await play(audio)).outcome).toBe("browser");
    // A stream that broke before its first byte.
    fetchMock.mockResolvedValueOnce(pcmResponse([], { fail: true }));
    expect((await play(audio)).outcome).toBe("browser");
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect((await play(audio)).outcome).toBe("browser");
  });

  it("plays what arrived when the stream breaks partway", async () => {
    fetchMock.mockResolvedValue(pcmResponse([[0x00, 0x40]], { fail: true }));
    const audio = new FakeAudioContext();
    expect(await play(audio)).toEqual({ outcome: "done" });
    expect(audio.sources).toHaveLength(1);
  });

  it("stops every scheduled chunk when voice chat is stopped", async () => {
    const controller = new AbortController();
    const audio = new FakeAudioContext();
    audio.autoEnd = false;
    fetchMock.mockResolvedValue(
      pcmResponse([
        [0x00, 0x40],
        [0x00, 0x40],
      ]),
    );
    const pending = play(audio, controller.signal);
    await vi.waitFor(() => expect(audio.sources).toHaveLength(2));
    controller.abort();
    expect(await pending).toEqual({ outcome: "cancelled" });
    for (const source of audio.sources) expect(source.stop).toHaveBeenCalled();
  });

  it("reports a stop before the answer arrived as cancelled, not a failure", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    expect(await play(new FakeAudioContext(), controller.signal)).toEqual({
      outcome: "cancelled",
    });
  });
});
