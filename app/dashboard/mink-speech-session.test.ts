// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMinkSpeechSession,
  MINK_SPEECH_TRUNCATED_NOTICE,
  speechWatchdogMs,
  type MinkSpeechSessionEvents,
} from "./mink-speech-session";
import type {
  MinkSpeechFetch,
  MinkSpeechHead,
  MinkSpeechRead,
} from "./mink-speech-player";

type FakeSource = {
  buffer: { duration: number } | null;
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

class FakeAudioContext {
  state: "running" | "suspended" = "running";
  currentTime = 10;
  destination = {};
  sources: FakeSource[] = [];
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

class FakeUtterance {
  text: string;
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}
const synth = {
  speak: vi.fn<(utterance: FakeUtterance) => void>(),
  cancel: vi.fn(),
};

/**
 * A scripted speech request: the head, then reads served from a queue the
 * test fills, each `push` waking a waiting read.
 */
function scripted(head: MinkSpeechHead = { kind: "pcm", rate: 24_000 }) {
  const reads: MinkSpeechRead[] = [];
  let waiting: ((value: MinkSpeechRead) => void) | null = null;
  const signalHolder: { signal: AbortSignal | null } = { signal: null };
  const fetched: MinkSpeechFetch & {
    push(read: MinkSpeechRead): void;
    aborted(): boolean;
  } = {
    head: Promise.resolve(head),
    read: () =>
      new Promise<MinkSpeechRead>((resolve) => {
        const next = reads.shift();
        if (next) resolve(next);
        else waiting = resolve;
      }),
    abort: vi.fn(),
    push(read) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(read);
      } else reads.push(read);
    },
    aborted: () => signalHolder.signal?.aborted === true,
  };
  return { fetched, signalHolder };
}
const samples = (count: number) => ({
  done: false as const,
  samples: new Int16Array(count).fill(1000),
});
const done = (truncated = false) => ({ done: true as const, truncated });

function events() {
  return {
    onStart: vi.fn<MinkSpeechSessionEvents["onStart"]>(),
    onPieceStart: vi.fn<MinkSpeechSessionEvents["onPieceStart"]>(),
    onIdle: vi.fn<MinkSpeechSessionEvents["onIdle"]>(),
    onNotice: vi.fn<MinkSpeechSessionEvents["onNotice"]>(),
    onVoiceOff: vi.fn<MinkSpeechSessionEvents["onVoiceOff"]>(),
  } satisfies MinkSpeechSessionEvents;
}

/** Scripts one request per enqueued piece, in order. */
function scriptedFetches(scripts: ReturnType<typeof scripted>[]) {
  let index = 0;
  const fetchSpeech = vi.fn((input: { signal: AbortSignal }) => {
    const script = scripts[index++];
    if (!script) throw new Error("More pieces than scripts.");
    script.signalHolder.signal = input.signal;
    return script.fetched;
  });
  return fetchSpeech;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  synth.speak.mockReset();
  synth.cancel.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("createMinkSpeechSession", () => {
  it("★ plays the second piece where the first one ends, fetching it ahead", async () => {
    const audio = new FakeAudioContext();
    const one = scripted();
    const two = scripted();
    const fetchSpeech = scriptedFetches([one, two]);
    const on = events();
    const session = createMinkSpeechSession({
      audio: audio as unknown as AudioContext,
      voice: "model",
      events: on,
      fetchSpeech,
    });
    session.enqueue("First sentence.", "en-IN");
    session.enqueue("Second sentence.", "en-IN");
    await tick();
    // Both requests are in flight before the first has delivered a byte.
    expect(fetchSpeech).toHaveBeenCalledTimes(2);
    one.fetched.push(samples(24_000));
    await tick();
    expect(on.onStart).toHaveBeenCalledOnce();
    expect(on.onPieceStart).toHaveBeenLastCalledWith("First sentence.");
    // The second piece's audio arrives while the first is still playing.
    two.fetched.push(samples(12_000));
    two.fetched.push(done());
    one.fetched.push(done());
    await tick();
    await tick();
    expect(audio.sources).toHaveLength(2);
    const firstAt = audio.sources[0].start.mock.calls[0][0] as number;
    expect(firstAt).toBeCloseTo(10.25);
    // No gap: exactly where the first second of audio ends.
    expect(audio.sources[1].start.mock.calls[0][0]).toBeCloseTo(firstAt + 1);
    expect(on.onPieceStart).toHaveBeenLastCalledWith("Second sentence.");
    session.end();
    await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
    expect(on.onStart).toHaveBeenCalledOnce();
  });

  it("cancel aborts every request, stops every source and never goes idle", async () => {
    const audio = new FakeAudioContext();
    audio.autoEnd = false;
    const one = scripted();
    const two = scripted();
    const on = events();
    const session = createMinkSpeechSession({
      audio: audio as unknown as AudioContext,
      voice: "model",
      events: on,
      fetchSpeech: scriptedFetches([one, two]),
    });
    session.enqueue("One.", "en-IN");
    session.enqueue("Two.", "en-IN");
    await tick();
    one.fetched.push(samples(2_400));
    await tick();
    expect(session.active).toBe(true);
    session.end();
    session.cancel();
    expect(one.fetched.aborted()).toBe(true);
    expect(two.fetched.aborted()).toBe(true);
    for (const source of audio.sources) expect(source.stop).toHaveBeenCalled();
    one.fetched.push(done());
    await tick();
    await tick();
    expect(on.onIdle).not.toHaveBeenCalled();
    expect(session.active).toBe(false);
    // A late enqueue on a cancelled session is ignored.
    session.enqueue("Three.", "en-IN");
    expect(session.active).toBe(false);
  });

  it("dropPending forgets what has not started and keeps the piece playing", async () => {
    const audio = new FakeAudioContext();
    const one = scripted();
    const two = scripted();
    const on = events();
    const session = createMinkSpeechSession({
      audio: audio as unknown as AudioContext,
      voice: "model",
      events: on,
      fetchSpeech: scriptedFetches([one, two]),
    });
    session.enqueue("One.", "en-IN");
    session.enqueue("Two.", "en-IN");
    await tick();
    one.fetched.push(samples(2_400));
    await tick();
    session.dropPending();
    expect(two.fetched.aborted()).toBe(true);
    expect(one.fetched.aborted()).toBe(false);
    one.fetched.push(done());
    session.end();
    await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
    expect(on.onPieceStart).toHaveBeenCalledTimes(1);
  });

  it("★ a broken piece is noticed once and the next one still plays", async () => {
    const audio = new FakeAudioContext();
    const one = scripted();
    const two = scripted();
    const three = scripted();
    const on = events();
    const session = createMinkSpeechSession({
      audio: audio as unknown as AudioContext,
      voice: "model",
      events: on,
      fetchSpeech: scriptedFetches([one, two, three]),
    });
    session.enqueue("One.", "en-IN");
    session.enqueue("Two.", "en-IN");
    session.enqueue("Three.", "en-IN");
    await tick();
    one.fetched.push(samples(2_400));
    one.fetched.push(done(true));
    await tick();
    await tick();
    two.fetched.push(samples(2_400));
    two.fetched.push(done(true));
    await tick();
    await tick();
    three.fetched.push(samples(2_400));
    three.fetched.push(done());
    session.end();
    await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("truncated"));
    expect(on.onNotice).toHaveBeenCalledTimes(1);
    expect(on.onNotice).toHaveBeenCalledWith(MINK_SPEECH_TRUNCATED_NOTICE);
    expect(on.onPieceStart.mock.calls.map((call) => call[0])).toEqual([
      "One.",
      "Two.",
      "Three.",
    ]);
  });

  it("reads a piece the model refused with the browser voice after the audio drains, then resumes", async () => {
    const audio = new FakeAudioContext();
    const one = scripted();
    const two = scripted({ kind: "browser" });
    const three = scripted();
    const on = events();
    const session = createMinkSpeechSession({
      audio: audio as unknown as AudioContext,
      voice: "model",
      events: on,
      fetchSpeech: scriptedFetches([one, two, three]),
      synth: synth as unknown as SpeechSynthesis,
      utteranceClass:
        FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    });
    session.enqueue("One.", "en-IN");
    session.enqueue("ഇന്ന് രണ്ട്.", "ml-IN");
    session.enqueue("Three.", "en-IN");
    await tick();
    one.fetched.push(samples(2_400));
    one.fetched.push(done());
    await vi.waitFor(() => expect(synth.speak).toHaveBeenCalledOnce());
    const utterance = synth.speak.mock.calls[0][0];
    expect(utterance.text).toBe("ഇന്ന് രണ്ട്.");
    expect(utterance.lang).toBe("ml-IN");
    expect(on.onPieceStart).toHaveBeenLastCalledWith("ഇന്ന് രണ്ട്.");
    utterance.onend?.();
    await tick();
    three.fetched.push(samples(2_400));
    three.fetched.push(done());
    session.end();
    await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
    expect(on.onPieceStart).toHaveBeenLastCalledWith("Three.");
    expect(audio.sources).toHaveLength(2);
  });

  it("★ switches the whole answer to the browser voice when no model is on", async () => {
    const audio = new FakeAudioContext();
    const one = scripted({ kind: "off" });
    const two = scripted();
    const on = events();
    const fetchSpeech = scriptedFetches([one, two]);
    const session = createMinkSpeechSession({
      audio: audio as unknown as AudioContext,
      voice: "model",
      events: on,
      fetchSpeech,
      synth: synth as unknown as SpeechSynthesis,
      utteranceClass:
        FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    });
    session.enqueue("One.", "en-IN");
    session.enqueue("Two.", "en-IN");
    await vi.waitFor(() => expect(synth.speak).toHaveBeenCalledOnce());
    expect(on.onVoiceOff).toHaveBeenCalledOnce();
    // The prefetched second request is abandoned; the browser reads it.
    expect(two.fetched.aborted()).toBe(true);
    synth.speak.mock.calls[0][0].onend?.();
    await vi.waitFor(() => expect(synth.speak).toHaveBeenCalledTimes(2));
    expect(synth.speak.mock.calls[1][0].text).toBe("Two.");
    expect(fetchSpeech).toHaveBeenCalledTimes(2);
    session.end();
    synth.speak.mock.calls[1][0].onend?.();
    await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
    expect(audio.sources).toHaveLength(0);
  });

  it("goes idle at once when ended with nothing queued", async () => {
    const on = events();
    const session = createMinkSpeechSession({
      audio: new FakeAudioContext() as unknown as AudioContext,
      voice: "model",
      events: on,
      fetchSpeech: scriptedFetches([]),
    });
    session.end();
    await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
    expect(on.onStart).not.toHaveBeenCalled();
  });

  it("browser voice from the start: in order, watched, and silenced by cancel", async () => {
    vi.useFakeTimers();
    const on = events();
    const session = createMinkSpeechSession({
      audio: null,
      voice: "browser",
      events: on,
      fetchSpeech: scriptedFetches([]),
      synth: synth as unknown as SpeechSynthesis,
      utteranceClass:
        FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    });
    session.enqueue("First.", "en-IN");
    session.enqueue("दूसरा।", "hi-IN");
    await vi.advanceTimersByTimeAsync(0);
    expect(synth.speak).toHaveBeenCalledOnce();
    expect(on.onStart).toHaveBeenCalledOnce();
    const first = synth.speak.mock.calls[0][0];
    expect(first.text).toBe("First.");
    // A missing end event is treated as the end after the watchdog.
    await vi.advanceTimersByTimeAsync(speechWatchdogMs("First.") + 1);
    expect(synth.cancel).toHaveBeenCalledOnce();
    expect(synth.speak).toHaveBeenCalledTimes(2);
    expect(synth.speak.mock.calls[1][0].lang).toBe("hi-IN");
    synth.cancel.mockClear();
    session.cancel();
    expect(synth.cancel).toHaveBeenCalledOnce();
    synth.speak.mock.calls[1][0].onend?.();
    session.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(on.onIdle).not.toHaveBeenCalled();
  });
});
