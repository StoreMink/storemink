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
  suspend = vi.fn(async () => {
    this.state = "suspended";
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
    vi.useFakeTimers();
    const settle = async () => {
      for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(0);
    };
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
    await settle();
    // Both requests are in flight before the first has delivered a byte.
    expect(fetchSpeech).toHaveBeenCalledTimes(2);
    one.fetched.push(samples(24_000));
    await settle();
    // ★ Queued a quarter-second ahead: nothing is said before it is heard.
    expect(on.onStart).not.toHaveBeenCalled();
    audio.currentTime = 10.25;
    await vi.advanceTimersByTimeAsync(250);
    expect(on.onStart).toHaveBeenCalledOnce();
    expect(on.onPieceStart).toHaveBeenLastCalledWith("First sentence.");
    // The second piece's audio arrives while the first is still playing.
    two.fetched.push(samples(12_000));
    two.fetched.push(done());
    one.fetched.push(done());
    await settle();
    expect(audio.sources).toHaveLength(2);
    const firstAt = audio.sources[0].start.mock.calls[0][0] as number;
    expect(firstAt).toBeCloseTo(10.25);
    // No gap: exactly where the first second of audio ends.
    expect(audio.sources[1].start.mock.calls[0][0]).toBeCloseTo(firstAt + 1);
    // ★ The caption is still the sentence being heard, not the one queued.
    expect(on.onPieceStart).toHaveBeenLastCalledWith("First sentence.");
    audio.currentTime = 11.25;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(on.onPieceStart).toHaveBeenLastCalledWith("Second sentence.");
    session.end();
    await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
    expect(on.onStart).toHaveBeenCalledOnce();
  });

  it("★ announces every piece still waiting, in order, before it goes idle", async () => {
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
    one.fetched.push(samples(2_400));
    one.fetched.push(done());
    two.fetched.push(samples(2_400));
    two.fetched.push(done());
    session.end();
    // The audio "ends" at once here, before either piece's moment arrives.
    await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
    expect(on.onPieceStart.mock.calls.map((call) => call[0])).toEqual([
      "One.",
      "Two.",
    ]);
    expect(on.onPieceStart.mock.invocationCallOrder[1]).toBeLessThan(
      on.onIdle.mock.invocationCallOrder[0],
    );
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
    // One is being heard by now: it finishes.
    audio.currentTime = 10.3;
    session.dropPending();
    expect(two.fetched.aborted()).toBe(true);
    expect(one.fetched.aborted()).toBe(false);
    one.fetched.push(done());
    session.end();
    await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
    expect(on.onPieceStart.mock.calls.map((call) => call[0])).toEqual(["One."]);
  });

  describe("★★ holding the voice for speech over it", () => {
    it("holds the model's audio and its captions, then carries on", async () => {
      vi.useFakeTimers();
      const audio = new FakeAudioContext();
      const one = scripted();
      const on = events();
      const session = createMinkSpeechSession({
        audio: audio as unknown as AudioContext,
        voice: "model",
        events: on,
        fetchSpeech: scriptedFetches([one]),
      });
      session.enqueue("One.", "en-IN");
      one.fetched.push(samples(24_000));
      for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(0);
      expect(audio.sources).toHaveLength(1);
      session.pause();
      expect(audio.suspend).toHaveBeenCalledOnce();
      // The clock has stopped: however long the merchant talks, nothing is
      // put on screen as heard.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(on.onStart).not.toHaveBeenCalled();
      session.resume();
      expect(audio.resume).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(on.onPieceStart).toHaveBeenCalledWith("One.");
    });

    it("does not caption a piece whose audio arrives during the pause", async () => {
      vi.useFakeTimers();
      const audio = new FakeAudioContext();
      const one = scripted();
      const on = events();
      const session = createMinkSpeechSession({
        audio: audio as unknown as AudioContext,
        voice: "model",
        events: on,
        fetchSpeech: scriptedFetches([one]),
      });
      session.pause();
      session.enqueue("One.", "en-IN");
      one.fetched.push(samples(24_000));
      for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(0);
      expect(audio.sources).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(on.onPieceStart).not.toHaveBeenCalled();
      session.resume();
      await vi.advanceTimersByTimeAsync(250);
      expect(on.onPieceStart).toHaveBeenCalledWith("One.");
    });

    it("does not call paused audio finished, however long the pause", async () => {
      vi.useFakeTimers();
      const audio = new FakeAudioContext();
      audio.autoEnd = false;
      const one = scripted();
      const on = events();
      const session = createMinkSpeechSession({
        audio: audio as unknown as AudioContext,
        voice: "model",
        events: on,
        fetchSpeech: scriptedFetches([one]),
      });
      session.enqueue("One.", "en-IN");
      one.fetched.push(samples(24_000));
      one.fetched.push(done());
      session.end();
      for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(0);
      session.pause();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(on.onIdle).not.toHaveBeenCalled();
      session.resume();
      audio.sources[0].onended?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(on.onIdle).toHaveBeenCalledWith("done");
    });

    it("leaves a context it paused paused when the next piece starts", async () => {
      const audio = new FakeAudioContext();
      audio.autoEnd = false;
      const one = scripted();
      const two = scripted();
      const session = createMinkSpeechSession({
        audio: audio as unknown as AudioContext,
        voice: "model",
        events: events(),
        fetchSpeech: scriptedFetches([one, two]),
      });
      session.enqueue("One.", "en-IN");
      session.enqueue("Two.", "en-IN");
      one.fetched.push(samples(2_400));
      await vi.waitFor(() => expect(audio.sources).toHaveLength(1));
      session.pause();
      await tick();
      expect(audio.state).toBe("suspended");
      one.fetched.push(done());
      two.fetched.push(samples(2_400));
      await vi.waitFor(() => expect(audio.sources).toHaveLength(2));
      // Queued behind the held audio, not played over the merchant.
      expect(audio.resume).not.toHaveBeenCalled();
      session.resume();
      expect(audio.resume).toHaveBeenCalledOnce();
    });

    it("stops the browser voice mid-sentence and says that sentence again, captioned once", async () => {
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
      session.enqueue("Sales are up this week.", "en-IN");
      session.enqueue("Orders are steady.", "en-IN");
      await vi.waitFor(() => expect(synth.speak).toHaveBeenCalledOnce());
      session.pause();
      expect(synth.cancel).toHaveBeenCalledOnce();
      // The cancel ends the utterance; nothing new starts while paused.
      synth.speak.mock.calls[0][0].onend?.();
      await tick();
      expect(synth.speak).toHaveBeenCalledOnce();
      session.resume();
      await vi.waitFor(() => expect(synth.speak).toHaveBeenCalledTimes(2));
      expect(synth.speak.mock.calls[1][0].text).toBe("Sales are up this week.");
      synth.speak.mock.calls[1][0].onend?.();
      await vi.waitFor(() => expect(synth.speak).toHaveBeenCalledTimes(3));
      expect(synth.speak.mock.calls[2][0].text).toBe("Orders are steady.");
      expect(on.onPieceStart.mock.calls.map((call) => call[0])).toEqual([
        "Sales are up this week.",
        "Orders are steady.",
      ]);
      expect(on.onStart).toHaveBeenCalledOnce();
    });

    it("cancelled while paused: nothing more fires, and the context runs again", async () => {
      const audio = new FakeAudioContext();
      audio.autoEnd = false;
      const one = scripted();
      const on = events();
      const session = createMinkSpeechSession({
        audio: audio as unknown as AudioContext,
        voice: "model",
        events: on,
        fetchSpeech: scriptedFetches([one]),
      });
      session.enqueue("One.", "en-IN");
      one.fetched.push(samples(2_400));
      await vi.waitFor(() => expect(audio.sources).toHaveLength(1));
      session.end();
      session.pause();
      session.cancel();
      expect(audio.sources[0].stop).toHaveBeenCalled();
      expect(audio.resume).toHaveBeenCalled();
      // A resume after the end changes nothing.
      session.resume();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(on.onStart).not.toHaveBeenCalled();
      expect(on.onIdle).not.toHaveBeenCalled();
    });
  });

  describe("★ dropping withdrawn speech that has not been heard", () => {
    it("cuts a sentence scheduled after the one playing and drops the one being fetched", async () => {
      const audio = new FakeAudioContext();
      audio.autoEnd = false;
      const one = scripted();
      const two = scripted();
      const three = scripted();
      const four = scripted();
      const on = events();
      const session = createMinkSpeechSession({
        audio: audio as unknown as AudioContext,
        voice: "model",
        events: on,
        fetchSpeech: scriptedFetches([one, two, three, four]),
      });
      session.enqueue("One.", "en-IN");
      session.enqueue("Two.", "en-IN");
      session.enqueue("Three.", "en-IN");
      one.fetched.push(samples(24_000));
      one.fetched.push(done());
      two.fetched.push(samples(12_000));
      two.fetched.push(done());
      await vi.waitFor(() => expect(audio.sources).toHaveLength(2));
      // One plays from 10.25 to 11.25; Two is queued on the playhead after it.
      expect(audio.sources[1].start.mock.calls[0][0]).toBeCloseTo(11.25);
      audio.currentTime = 10.5;
      session.dropPending();
      // Two never plays; Three, still being fetched, is abandoned.
      expect(audio.sources[1].stop).toHaveBeenCalled();
      expect(audio.sources[0].stop).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(three.fetched.aborted()).toBe(true));
      // What follows the withdrawal is placed straight after what is heard.
      session.enqueue("Four.", "en-IN");
      four.fetched.push(samples(2_400));
      four.fetched.push(done());
      await vi.waitFor(() => expect(audio.sources).toHaveLength(3));
      expect(audio.sources[2].start.mock.calls[0][0]).toBeCloseTo(11.25);
      session.end();
      audio.currentTime = 11.4;
      for (const source of audio.sources) source.onended?.();
      await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
      expect(on.onPieceStart.mock.calls.map((call) => call[0])).toEqual([
        "One.",
        "Four.",
      ]);
    });

    it("never announces a piece withdrawn inside its lead", async () => {
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
      session.enqueue("Let me check your orders.", "en-IN");
      one.fetched.push(samples(2_400));
      await vi.waitFor(() => expect(audio.sources).toHaveLength(1));
      // Scheduled for 10.25; the clock is still at 10, so nothing is heard.
      session.dropPending();
      expect(audio.sources[0].stop).toHaveBeenCalled();
      session.enqueue("You have twelve orders.", "en-IN");
      two.fetched.push(samples(2_400));
      two.fetched.push(done());
      await vi.waitFor(() => expect(audio.sources).toHaveLength(2));
      session.end();
      for (const source of audio.sources) source.onended?.();
      await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
      expect(on.onPieceStart.mock.calls.map((call) => call[0])).toEqual([
        "You have twelve orders.",
      ]);
      expect(on.onStart).toHaveBeenCalledOnce();
    });

    it("drops a piece waiting for the model's audio to give it to the browser voice", async () => {
      const audio = new FakeAudioContext();
      audio.autoEnd = false;
      const one = scripted();
      const two = scripted({ kind: "browser" });
      const on = events();
      const session = createMinkSpeechSession({
        audio: audio as unknown as AudioContext,
        voice: "model",
        events: on,
        fetchSpeech: scriptedFetches([one, two]),
        synth: synth as unknown as SpeechSynthesis,
        utteranceClass:
          FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
      });
      session.enqueue("One.", "en-IN");
      session.enqueue("ഇന്ന് രണ്ട്.", "ml-IN");
      one.fetched.push(samples(2_400));
      one.fetched.push(done());
      await vi.waitFor(() => expect(audio.sources).toHaveLength(1));
      await tick();
      audio.currentTime = 10.3;
      session.dropPending();
      session.end();
      for (const source of audio.sources) source.onended?.();
      await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledWith("done"));
      expect(synth.speak).not.toHaveBeenCalled();
      expect(on.onPieceStart.mock.calls.map((call) => call[0])).toEqual([
        "One.",
      ]);
    });
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

  describe("★ reopening an ended session", () => {
    function browserSession(on: ReturnType<typeof events>) {
      return createMinkSpeechSession({
        audio: null,
        voice: "browser",
        events: on,
        fetchSpeech: scriptedFetches([]),
        synth: synth as unknown as SpeechSynthesis,
        utteranceClass:
          FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
      });
    }

    it("takes pieces again after it went idle, and starts and idles again", async () => {
      vi.useFakeTimers();
      const on = events();
      const session = browserSession(on);
      session.enqueue("Let me check your orders.", "en-IN");
      session.end();
      await vi.advanceTimersByTimeAsync(0);
      synth.speak.mock.calls[0][0].onend?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(on.onIdle).toHaveBeenCalledOnce();
      // Ended and idle: a piece is refused until the session is reopened.
      session.enqueue("Ignored.", "en-IN");
      await vi.advanceTimersByTimeAsync(0);
      expect(synth.speak).toHaveBeenCalledOnce();
      session.reopen();
      session.enqueue("You have twelve orders.", "en-IN");
      session.end();
      await vi.advanceTimersByTimeAsync(0);
      expect(synth.speak).toHaveBeenCalledTimes(2);
      expect(synth.speak.mock.calls[1][0].text).toBe("You have twelve orders.");
      expect(on.onStart).toHaveBeenCalledTimes(2);
      synth.speak.mock.calls[1][0].onend?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(on.onIdle).toHaveBeenCalledTimes(2);
    });

    it("reopened while the last audio drains: no idle for the first end, and the next piece plays", async () => {
      const on = events();
      const audio = new FakeAudioContext();
      audio.autoEnd = false;
      const one = scripted();
      const two = scripted();
      const session = createMinkSpeechSession({
        audio: audio as unknown as AudioContext,
        voice: "model",
        events: on,
        fetchSpeech: scriptedFetches([one, two]),
      });
      session.enqueue("Let me check your orders.", "en-IN");
      session.end();
      one.fetched.push(samples(2_400));
      one.fetched.push(done());
      await vi.waitFor(() => expect(on.onStart).toHaveBeenCalledOnce());
      await tick();
      // Still draining the first piece's audio when the run withdraws it.
      session.reopen();
      session.enqueue("You have twelve orders.", "en-IN");
      two.fetched.push(samples(2_400));
      two.fetched.push(done());
      for (const source of audio.sources) source.onended?.();
      await vi.waitFor(() =>
        expect(on.onPieceStart).toHaveBeenLastCalledWith(
          "You have twelve orders.",
        ),
      );
      expect(on.onIdle).not.toHaveBeenCalled();
      session.end();
      await tick();
      for (const source of audio.sources) source.onended?.();
      await vi.waitFor(() => expect(on.onIdle).toHaveBeenCalledOnce());
    });
  });
});
