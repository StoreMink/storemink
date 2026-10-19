// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MinkMessage } from "./mink-ai";
import {
  MAX_EMPTY_TRANSCRIPTS,
  MINK_BARGE_IN_GRACE_MS,
  MINK_ECHO_NOTICE,
  MINK_VOICE_NOTICE_MS,
  useMinkVoiceMode,
  voiceChatSupport,
  type MinkVoiceModeInput,
} from "./mink-voice-mode";
import {
  MINK_BARGE_IN_GATE,
  MINK_SPEECH_GATE,
} from "@/lib/mink/voice-recorder";
import {
  MinkVoiceCaptureError,
  type MinkVoiceCapture,
} from "@/lib/mink/voice-turn";
import type {
  createMinkSpeechSession,
  MinkSpeechSessionEvents,
} from "./mink-speech-session";

type CaptureInput = Parameters<MinkVoiceCapture["capture"]>[0];
type CaptureCall = {
  input: CaptureInput;
  resolve: (text: string | null) => void;
  reject: (error: unknown) => void;
};

/**
 * A microphone the test drives: speech starts and transcripts land on cue.
 * One is created per voice chat, as the loop keeps its microphone open.
 */
function makeCapture() {
  const calls: CaptureCall[] = [];
  const capture = vi.fn(
    (input: CaptureInput) =>
      new Promise<string | null>((resolve, reject) => {
        calls.push({ input, resolve, reject });
        input.signal.addEventListener("abort", () =>
          reject(new DOMException("Voice capture cancelled.", "AbortError")),
        );
      }),
  );
  const close = vi.fn();
  const createCapture = vi.fn((): MinkVoiceCapture => ({ capture, close }));
  return {
    createCapture,
    close,
    calls,
    last: () => calls[calls.length - 1],
  };
}

type FakeSession = {
  options: Parameters<typeof createMinkSpeechSession>[0];
  events: MinkSpeechSessionEvents;
  enqueue: ReturnType<typeof vi.fn>;
  dropPending: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  reopen: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  active: boolean;
};

function makeSessions() {
  const sessions: FakeSession[] = [];
  const createSession = vi.fn(
    (options: Parameters<typeof createMinkSpeechSession>[0]) => {
      const session: FakeSession = {
        options,
        events: options.events,
        enqueue: vi.fn(),
        dropPending: vi.fn(),
        end: vi.fn(),
        reopen: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        cancel: vi.fn(),
        active: false,
      };
      sessions.push(session);
      return session;
    },
  );
  return {
    createSession: createSession as unknown as typeof createMinkSpeechSession,
    sessions,
    last: () => sessions[sessions.length - 1],
  };
}

const synth = { speak: vi.fn(), cancel: vi.fn(), speaking: false };
class FakeUtterance {}
/** Model audio plays through a context started by the toggle click. */
const contexts: Array<{
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> = [];

function installBrowser(options: { speech?: boolean; mic?: boolean } = {}) {
  const { speech = true, mic = true } = options;
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(window, "AudioContext", {
    value: mic
      ? class {
          resume = vi.fn(async () => {});
          close = vi.fn(async () => {});
          constructor() {
            contexts.push(this);
          }
        }
      : undefined,
    configurable: true,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    value: mic ? { getUserMedia: vi.fn() } : undefined,
    configurable: true,
  });
  Object.defineProperty(window, "speechSynthesis", {
    value: speech ? synth : undefined,
    configurable: true,
  });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    value: speech ? FakeUtterance : undefined,
    configurable: true,
  });
}

function assistant(
  id: number | string,
  text: string,
  spoken: string | null = null,
): MinkMessage {
  return { id, role: "assistant", text, spoken };
}
function user(id: number | string, text: string): MinkMessage {
  return { id, role: "user", text };
}

type Harness = ReturnType<typeof makeHarness>;
function makeHarness(overrides: Partial<MinkVoiceModeInput> = {}) {
  const mic = makeCapture();
  const speech = makeSessions();
  const input: MinkVoiceModeInput = {
    messages: [assistant("old", "Hello before voice mode")],
    isReplying: false,
    isChatOpen: true,
    error: null,
    spokenText: "",
    spokenEnded: false,
    send: vi.fn(() => true),
    cancel: vi.fn(),
    langFallback: "en-IN",
    createCapture: mic.createCapture,
    createSession: speech.createSession,
    ...overrides,
  };
  const hook = renderHook(
    (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
    {
      initialProps: input,
    },
  );
  const send = input.send as ReturnType<typeof vi.fn>;
  const cancel = input.cancel as ReturnType<typeof vi.fn>;
  return { ...hook, input, mic, speech, send, cancel };
}

/** Toggle on, open the mic, say `text`, and let the transcript land. */
async function say(h: Harness, text: string) {
  const call = h.mic.last();
  act(() => {
    call.input.onPhase?.("open");
  });
  let accepted = false;
  act(() => {
    accepted = call.input.onSpeechStart();
  });
  expect(accepted).toBe(true);
  await act(async () => call.resolve(text));
}

beforeEach(() => {
  synth.speak.mockReset();
  synth.cancel.mockReset();
  contexts.length = 0;
  installBrowser();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ enabled: true }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useMinkVoiceMode", () => {
  it("★★ speaks the answer sentence by sentence while it streams, mic open throughout", async () => {
    const h = makeHarness();
    expect(h.result.current.enabled).toBe(false);
    expect(h.result.current.support.ok).toBe(true);

    await act(async () => h.result.current.toggle());
    expect(h.result.current.enabled).toBe(true);
    expect(h.result.current.state).toBe("listening");
    expect(h.result.current.mic).toBe("starting");
    expect(h.mic.calls).toHaveLength(1);
    // The ordinary floor while listening.
    expect(h.mic.calls[0].input.gate.current).toBe(MINK_SPEECH_GATE);

    act(() => h.mic.calls[0].input.onPhase?.("open"));
    expect(h.result.current.mic).toBe("open");
    await say(h, "How many orders today?");
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith("How many orders today?", {
      voice: true,
    });
    expect(h.result.current.state).toBe("waiting");
    expect(h.result.current.heard).toBe("How many orders today?");
    // The microphone is re-armed at once, under the stricter floor.
    expect(h.mic.calls).toHaveLength(2);
    expect(h.mic.calls[1].input.gate).toBe(h.mic.calls[0].input.gate);
    expect(h.mic.calls[1].input.gate.current).toBe(MINK_BARGE_IN_GATE);
    expect(h.speech.sessions).toHaveLength(1);
    const session = h.speech.last();
    expect(session.options.voice).toBe("model");
    expect(session.options.audio).toBe(contexts[0]);

    const messages = [
      ...h.input.messages,
      user("u1", "How many orders today?"),
    ];
    h.rerender({ ...h.input, messages, isReplying: true });
    expect(session.enqueue).not.toHaveBeenCalled();

    // The first sentence is handed over the moment it provably ends.
    h.rerender({
      ...h.input,
      messages,
      isReplying: true,
      spokenText: "You have twelve orders today. Seven are",
    });
    expect(session.enqueue).toHaveBeenCalledTimes(1);
    expect(session.enqueue).toHaveBeenCalledWith(
      "You have twelve orders today.",
      "en-IN",
    );
    expect(session.end).not.toHaveBeenCalled();

    act(() => session.events.onStart());
    expect(h.result.current.state).toBe("speaking");
    act(() => session.events.onPieceStart("You have twelve orders today."));
    expect(h.result.current.said).toBe("You have twelve orders today.");

    // The block closes: the tail goes out and the session is told it is the end.
    h.rerender({
      ...h.input,
      messages,
      isReplying: true,
      spokenText: "You have twelve orders today. Seven are still open.",
      spokenEnded: true,
    });
    expect(session.enqueue).toHaveBeenCalledTimes(2);
    expect(session.enqueue).toHaveBeenLastCalledWith(
      "Seven are still open.",
      "en-IN",
    );
    expect(session.end).toHaveBeenCalledOnce();

    // The written answer keeps streaming; nothing more is enqueued.
    h.rerender({
      ...h.input,
      messages,
      isReplying: true,
      spokenText: "You have twelve orders today. Seven are still open.",
      spokenEnded: true,
    });
    expect(session.enqueue).toHaveBeenCalledTimes(2);

    // Speech finishes before the written answer has: back to listening,
    // with the same microphone still open.
    act(() => session.events.onIdle("done"));
    expect(h.result.current.state).toBe("listening");
    expect(h.mic.calls).toHaveLength(2);
    expect(h.mic.calls[1].input.gate.current).toBe(MINK_SPEECH_GATE);

    h.rerender({
      ...h.input,
      messages: [
        ...messages,
        assistant(
          "a1",
          "You have **12 orders** today.",
          "You have twelve orders today. Seven are still open.",
        ),
      ],
      isReplying: false,
    });
    expect(session.enqueue).toHaveBeenCalledTimes(2);
    expect(session.end).toHaveBeenCalledOnce();
    expect(h.result.current.state).toBe("listening");
    expect(h.speech.sessions).toHaveLength(1);
  });

  it("★ reads the written answer when the reply carried no spoken block", async () => {
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    await say(h, "Show the CSV");
    const session = h.speech.last();
    h.rerender({
      ...h.input,
      messages: [
        ...h.input.messages,
        user("u1", "Show the CSV"),
        assistant("a1", "Sales are **up** this week."),
      ],
      isReplying: false,
    });
    expect(session.enqueue).toHaveBeenCalledWith(
      "Sales are up this week.",
      "en-IN",
    );
    expect(session.end).toHaveBeenCalledOnce();
    // Nothing speakable at all: the session ends empty and the loop listens.
    await say(h, "And the code?");
    const second = h.speech.last();
    h.rerender({
      ...h.input,
      messages: [
        ...h.input.messages,
        user("u2", "And the code?"),
        assistant("a2", "```\nonly,code\n```"),
      ],
      isReplying: false,
    });
    expect(second.enqueue).not.toHaveBeenCalled();
    expect(second.end).toHaveBeenCalledOnce();
    act(() => second.events.onIdle("done"));
    expect(h.result.current.state).toBe("listening");
  });

  it("picks the utterance language from each piece's script", async () => {
    const h = makeHarness({ langFallback: "en-GB" });
    await act(async () => h.result.current.toggle());
    await say(h, "आज कितने ऑर्डर आए?");
    const session = h.speech.last();
    h.rerender({
      ...h.input,
      isReplying: true,
      spokenText: "आज बारह ऑर्डर आए हैं। ",
      spokenEnded: true,
    });
    expect(session.enqueue).toHaveBeenCalledWith(
      "आज बारह ऑर्डर आए हैं।",
      "hi-IN",
    );
  });

  it("★ a withdrawn spoken text forgets what has not played yet", async () => {
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    await say(h, "Sales?");
    const session = h.speech.last();
    h.rerender({
      ...h.input,
      isReplying: true,
      spokenText: "Sales are up. Orders are up too. Let me",
    });
    // Two short sentences travel as one piece: the first fetch is the one
    // that decides how soon the merchant hears anything.
    expect(session.enqueue).toHaveBeenCalledOnce();
    expect(session.enqueue).toHaveBeenCalledWith(
      "Sales are up. Orders are up too.",
      "en-IN",
    );
    // A tool call withdrew the working-out; React batched the reset with
    // the regrowth, so the text is simply no longer an extension.
    h.rerender({
      ...h.input,
      isReplying: true,
      spokenText: "Checked the figures: sales are up five per cent. And",
    });
    expect(session.dropPending).toHaveBeenCalledOnce();
    expect(session.enqueue).toHaveBeenCalledTimes(2);
    expect(session.enqueue).toHaveBeenLastCalledWith(
      "Checked the figures: sales are up five per cent.",
      "en-IN",
    );
  });

  describe("★★ interrupting Mink by speaking", () => {
    async function speaking(h: Harness) {
      await act(async () => h.result.current.toggle());
      await say(h, "Sales?");
      const session = h.speech.last();
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "Sales are up this week. Orders are up too.",
        spokenEnded: true,
      });
      act(() => session.events.onStart());
      expect(h.result.current.state).toBe("speaking");
      return session;
    }

    it("while speaking: holds the voice, ends it once words arrive, leaves a finished answer alone and takes the new question", async () => {
      vi.useFakeTimers();
      const h = makeHarness();
      const session = await speaking(h);
      // The written answer already landed.
      h.rerender({
        ...h.input,
        messages: [
          ...h.input.messages,
          user("u1", "Sales?"),
          assistant("a1", "Sales are up.", "Sales are up this week."),
        ],
        isReplying: false,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MINK_BARGE_IN_GRACE_MS + 10);
      });
      const mic = h.mic.last();
      let accepted = false;
      act(() => {
        accepted = mic.input.onSpeechStart();
      });
      expect(accepted).toBe(true);
      // Loudness alone only holds the voice; the transcript decides.
      expect(session.pause).toHaveBeenCalledOnce();
      expect(session.cancel).not.toHaveBeenCalled();
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.result.current.state).toBe("listening");
      await act(async () => mic.resolve("What about returns?"));
      expect(session.cancel).toHaveBeenCalledOnce();
      expect(session.resume).not.toHaveBeenCalled();
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.send).toHaveBeenLastCalledWith("What about returns?", {
        voice: true,
      });
      expect(h.speech.sessions).toHaveLength(2);
    });

    it("inside the grace window the recorder is told to keep listening", async () => {
      vi.useFakeTimers();
      const h = makeHarness();
      const session = await speaking(h);
      let accepted = true;
      act(() => {
        accepted = h.mic.last().input.onSpeechStart();
      });
      expect(accepted).toBe(false);
      expect(session.cancel).not.toHaveBeenCalled();
      expect(h.result.current.state).toBe("speaking");
    });

    it("★ while Mink is still thinking: cancels the reply, and asks the whole question once the chat is free", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      await say(h, "Sales?");
      const first = h.speech.last();
      h.rerender({ ...h.input, isReplying: true });
      expect(h.result.current.state).toBe("waiting");
      const mic = h.mic.last();
      let accepted = false;
      act(() => {
        accepted = mic.input.onSpeechStart();
      });
      expect(accepted).toBe(true);
      expect(h.cancel).toHaveBeenCalledOnce();
      expect(first.cancel).toHaveBeenCalledOnce();
      expect(h.result.current.state).toBe("listening");
      // The cancelled run is still closing when the transcript lands.
      await act(async () => mic.resolve("Actually, show returns."));
      expect(h.send).toHaveBeenCalledOnce();
      expect(h.result.current.state).toBe("sending");
      expect(h.result.current.heard).toBe("Sales? Actually, show returns.");
      // The run ends with no answer: nothing is spoken, and the parked
      // transcript goes out exactly once, carrying the cancelled question's
      // words and taking its place in the thread.
      h.rerender({ ...h.input, isReplying: false });
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.send).toHaveBeenLastCalledWith(
        "Sales? Actually, show returns.",
        { voice: true, replaceUnanswered: true },
      );
      expect(h.result.current.state).toBe("waiting");
      h.rerender({ ...h.input, isReplying: false });
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.speech.sessions).toHaveLength(2);
    });

    it("a transcript that is Mink's own voice coming back is not a question", async () => {
      vi.useFakeTimers();
      const h = makeHarness();
      const session = await speaking(h);
      act(() =>
        session.events.onPieceStart(
          "Sales are up this week, orders are up too.",
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MINK_BARGE_IN_GRACE_MS + 10);
      });
      const mic = h.mic.last();
      act(() => {
        mic.input.onSpeechStart();
      });
      await act(async () =>
        mic.resolve("sales are up this week orders are up too"),
      );
      expect(h.send).toHaveBeenCalledOnce();
      // Its voice carries on where it paused, and the mic listens again.
      expect(session.pause).toHaveBeenCalledOnce();
      expect(session.resume).toHaveBeenCalledOnce();
      expect(session.cancel).not.toHaveBeenCalled();
      expect(h.mic.calls).toHaveLength(3);
      expect(h.result.current.state).toBe("speaking");
    });

    it("★★ over Mink's voice while the answer is still being written: the voice ends, the run does not", async () => {
      vi.useFakeTimers();
      const h = makeHarness();
      const session = await speaking(h);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MINK_BARGE_IN_GRACE_MS + 10);
      });
      const mic = h.mic.last();
      let accepted = false;
      act(() => {
        accepted = mic.input.onSpeechStart();
      });
      expect(accepted).toBe(true);
      expect(session.pause).toHaveBeenCalledOnce();
      // The answer, its cards and its drafts still land in the chat.
      expect(h.cancel).not.toHaveBeenCalled();
      await act(async () => mic.resolve("And returns?"));
      expect(session.cancel).toHaveBeenCalledOnce();
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.send).toHaveBeenCalledOnce();
      h.rerender({
        ...h.input,
        messages: [
          ...h.input.messages,
          user("u1", "Sales?"),
          assistant("a1", "Sales are up.", "Sales are up this week."),
        ],
        isReplying: false,
      });
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.send).toHaveBeenLastCalledWith("And returns?", { voice: true });
    });

    it("★ Mink heard through the speaker: its own clip is not sent, its voice carries on, it says so once, and it then finishes speaking", async () => {
      vi.useFakeTimers();
      const h = makeHarness();
      const session = await speaking(h);
      act(() => session.events.onPieceStart("Sales are up this week."));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MINK_BARGE_IN_GRACE_MS + 10);
      });
      const mic = h.mic.last();
      act(() => {
        mic.input.onSpeechStart();
      });
      // The fraction of a second of Mink's voice before it was held.
      await act(async () => mic.resolve("Sales are"));
      expect(h.send).toHaveBeenCalledOnce();
      expect(h.result.current.notice).toBe(MINK_ECHO_NOTICE);
      expect(h.result.current.enabled).toBe(true);
      // ★ Mink never cuts itself off: the pause its own voice caused is given back.
      expect(session.resume).toHaveBeenCalledOnce();
      expect(session.cancel).not.toHaveBeenCalled();
      expect(h.result.current.state).toBe("speaking");
      // The interrupted answer finishes writing; the next question follows.
      h.rerender({
        ...h.input,
        messages: [
          ...h.input.messages,
          user("u1", "Sales?"),
          assistant("a1", "Sales are up.", "Sales are up this week."),
        ],
        isReplying: false,
      });
      // Mink finishes the answer it was saying, then listens.
      act(() => session.events.onIdle("done"));
      expect(h.result.current.state).toBe("listening");
      await say(h, "Orders?");
      expect(h.speech.sessions).toHaveLength(2);
      const next = h.speech.last();
      act(() => next.events.onStart());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MINK_BARGE_IN_GRACE_MS + 10);
      });
      let accepted = true;
      act(() => {
        accepted = h.mic.last().input.onSpeechStart();
      });
      expect(accepted).toBe(false);
      expect(next.cancel).not.toHaveBeenCalled();
      expect(h.result.current.state).toBe("speaking");
    });

    it("★★ a cough over Mink's voice gives it back where it paused, however many times", async () => {
      vi.useFakeTimers();
      const h = makeHarness();
      const session = await speaking(h);
      for (let i = 1; i <= MAX_EMPTY_TRANSCRIPTS + 1; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MINK_BARGE_IN_GRACE_MS + 10);
        });
        const mic = h.mic.last();
        let accepted = false;
        act(() => {
          accepted = mic.input.onSpeechStart();
        });
        expect(accepted).toBe(true);
        expect(session.pause).toHaveBeenCalledTimes(i);
        expect(h.result.current.state).toBe("listening");
        // Nobody said anything: a cough, a door.
        await act(async () => mic.resolve(null));
        expect(session.resume).toHaveBeenCalledTimes(i);
        expect(h.result.current.state).toBe("speaking");
        // Not a merchant who went quiet, so it never turns voice chat off.
        expect(h.result.current.enabled).toBe(true);
      }
      expect(session.cancel).not.toHaveBeenCalled();
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.send).toHaveBeenCalledOnce();
    });

    it("★ a cough while Mink thinks about a typed question holds its answer's voice, then gives it back", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      act(() => h.result.current.noteSend());
      h.rerender({ ...h.input, isReplying: true });
      const session = h.speech.last();
      const mic = h.mic.last();
      act(() => {
        mic.input.onSpeechStart();
      });
      expect(h.cancel).not.toHaveBeenCalled();
      expect(session.pause).toHaveBeenCalledOnce();
      expect(session.cancel).not.toHaveBeenCalled();
      await act(async () => mic.resolve(null));
      expect(session.resume).toHaveBeenCalledOnce();
      expect(h.result.current.state).toBe("waiting");
      // Its answer is still read aloud when it comes.
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "Here you go. ",
        spokenEnded: true,
      });
      expect(session.enqueue).toHaveBeenCalledWith("Here you go.", "en-IN");
    });

    it("★ an echo is judged against the answer playing now, not an earlier one", async () => {
      vi.useFakeTimers();
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      await say(h, "Sales?");
      const first = h.speech.last();
      act(() => first.events.onStart());
      act(() =>
        first.events.onPieceStart(
          "Your sales today are twelve thousand rupees.",
        ),
      );
      act(() => first.events.onIdle("done"));
      await say(h, "Orders?");
      const second = h.speech.last();
      act(() => second.events.onStart());
      act(() => second.events.onPieceStart("Three orders need packing."));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MINK_BARGE_IN_GRACE_MS + 10);
      });
      const mic = h.mic.last();
      act(() => {
        mic.input.onSpeechStart();
      });
      await act(async () => mic.resolve("twelve thousand rupees"));
      expect(h.send).toHaveBeenLastCalledWith("twelve thousand rupees", {
        voice: true,
      });
    });

    it("★ a barge-in that said nothing asks the cancelled question again, instead of losing it", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      await say(h, "Sales?");
      h.rerender({ ...h.input, isReplying: true });
      const mic = h.mic.last();
      act(() => {
        mic.input.onSpeechStart();
      });
      expect(h.cancel).toHaveBeenCalledOnce();
      // A cough crossed the floor; nobody said anything.
      await act(async () => mic.resolve(null));
      h.rerender({ ...h.input, isReplying: false });
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.send).toHaveBeenLastCalledWith("Sales?", {
        voice: true,
        replaceUnanswered: true,
      });
      expect(h.result.current.enabled).toBe(true);
    });

    it("★ speech while Mink thinks about a typed question waits for it instead of cancelling it", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      act(() => h.result.current.noteSend());
      expect(h.cancel).not.toHaveBeenCalled();
      h.rerender({ ...h.input, isReplying: true });
      const mic = h.mic.last();
      act(() => {
        mic.input.onSpeechStart();
      });
      expect(h.cancel).not.toHaveBeenCalled();
      await act(async () => mic.resolve("And returns?"));
      h.rerender({ ...h.input, isReplying: false });
      expect(h.send).toHaveBeenLastCalledWith("And returns?", { voice: true });
    });
  });

  describe("★ a spoken turn that takes staged files along", () => {
    it("waits for the upload, then opens the turn; speech never cancels it", async () => {
      let resolveSend!: (taken: boolean) => void;
      const h = makeHarness({
        send: vi.fn(
          () =>
            new Promise<boolean>((resolve) => {
              resolveSend = resolve;
            }),
        ),
      });
      await act(async () => h.result.current.toggle());
      await say(h, "Make a product from this photo");
      expect(h.result.current.state).toBe("sending");
      expect(h.speech.sessions).toHaveLength(0);
      expect(h.mic.calls).toHaveLength(1);
      await act(async () => resolveSend(true));
      expect(h.result.current.state).toBe("waiting");
      expect(h.speech.sessions).toHaveLength(1);
      expect(h.mic.calls).toHaveLength(2);
      h.rerender({ ...h.input, isReplying: true });
      act(() => {
        h.mic.last().input.onSpeechStart();
      });
      expect(h.cancel).not.toHaveBeenCalled();
    });

    it("stops voice chat with a notice when it could not be sent", async () => {
      let resolveSend!: (taken: boolean) => void;
      const h = makeHarness({
        send: vi.fn(
          () =>
            new Promise<boolean>((resolve) => {
              resolveSend = resolve;
            }),
        ),
      });
      await act(async () => h.result.current.toggle());
      await say(h, "Make a product from this photo");
      await act(async () => resolveSend(false));
      expect(h.result.current.enabled).toBe(false);
      expect(h.result.current.notice).toBe(
        "Voice chat turned off: the message could not be sent.",
      );
    });
  });

  describe("★ spoken blocks that end oddly", () => {
    it("a withdrawn sentence (a retried turn) does not silence the answer after it", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      await say(h, "How many orders?");
      const session = h.speech.last();
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "Let me check your orders.",
        spokenEnded: true,
      });
      expect(session.enqueue).toHaveBeenCalledWith(
        "Let me check your orders.",
        "en-IN",
      );
      expect(session.end).toHaveBeenCalledOnce();
      act(() => session.events.onStart());
      act(() => session.events.onIdle("done"));
      expect(h.result.current.state).toBe("listening");
      // A retry withdraws it; the answer comes in a block of its own.
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "",
        spokenEnded: false,
      });
      expect(session.reopen).toHaveBeenCalledOnce();
      expect(h.result.current.state).toBe("waiting");
      expect(h.mic.last().input.gate.current).toBe(MINK_BARGE_IN_GATE);
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "You have twelve orders today.",
        spokenEnded: true,
      });
      expect(session.enqueue).toHaveBeenLastCalledWith(
        "You have twelve orders today.",
        "en-IN",
      );
      expect(session.end).toHaveBeenCalledTimes(2);
    });

    it("an empty spoken block leaves the written answer to be read", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      await say(h, "Sales?");
      const session = h.speech.last();
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "",
        spokenEnded: true,
      });
      expect(session.end).not.toHaveBeenCalled();
      h.rerender({
        ...h.input,
        messages: [
          ...h.input.messages,
          user("u1", "Sales?"),
          assistant("a1", "Sales are **up** this week."),
        ],
        isReplying: false,
      });
      expect(session.enqueue).toHaveBeenCalledWith(
        "Sales are up this week.",
        "en-IN",
      );
      expect(session.end).toHaveBeenCalledOnce();
    });

    it("a withdrawn sentence does not stop a written answer with no block being read", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      await say(h, "Sales?");
      const session = h.speech.last();
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "Let me check. One",
      });
      expect(session.enqueue).toHaveBeenCalledWith("Let me check.", "en-IN");
      h.rerender({ ...h.input, isReplying: true, spokenText: "" });
      expect(session.dropPending).toHaveBeenCalledOnce();
      h.rerender({
        ...h.input,
        messages: [
          ...h.input.messages,
          user("u1", "Sales?"),
          assistant("a1", "Sales are **up** this week."),
        ],
        isReplying: false,
        spokenText: "",
      });
      expect(session.enqueue).toHaveBeenLastCalledWith(
        "Sales are up this week.",
        "en-IN",
      );
    });
  });

  describe("★★ an acknowledgement before a tool call", () => {
    it("plays while the tools run, shows Thinking after it, then plays the answer after it", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      await say(h, "How many orders?");
      const session = h.speech.last();
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "Let me check your orders.",
        spokenEnded: true,
      });
      expect(session.enqueue).toHaveBeenCalledWith(
        "Let me check your orders.",
        "en-IN",
      );
      // The run keeps it: nothing is withdrawn or cut.
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "",
        spokenEnded: false,
        spokenKept: "Let me check your orders.",
      });
      expect(session.dropPending).not.toHaveBeenCalled();
      expect(session.reopen).not.toHaveBeenCalled();
      act(() => session.events.onStart());
      expect(h.result.current.state).toBe("speaking");
      act(() => session.events.onIdle("done"));
      // Played out, and the answer is still being worked out.
      expect(h.result.current.state).toBe("waiting");
      expect(h.mic.last().input.gate.current).toBe(MINK_BARGE_IN_GATE);
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "You have twelve orders today.",
        spokenEnded: true,
        spokenKept: "Let me check your orders.",
      });
      expect(session.reopen).toHaveBeenCalledOnce();
      expect(session.enqueue).toHaveBeenLastCalledWith(
        "You have twelve orders today.",
        "en-IN",
      );
      // Spoken once each: the acknowledgement is never said again.
      expect(
        session.enqueue.mock.calls.filter(
          ([text]) => text === "Let me check your orders.",
        ),
      ).toHaveLength(1);
      h.rerender({
        ...h.input,
        messages: [
          ...h.input.messages,
          user("u1", "How many orders?"),
          assistant("a1", "**12** today.", "You have twelve orders today."),
        ],
        isReplying: false,
        spokenText: "",
        spokenEnded: false,
        spokenKept: "",
      });
      expect(session.enqueue).toHaveBeenCalledTimes(2);
      act(() => session.events.onIdle("done"));
      expect(h.result.current.state).toBe("listening");
    });

    it("says an acknowledgement whose close it never saw (the events arrived together)", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      await say(h, "How many orders?");
      const session = h.speech.last();
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "",
        spokenEnded: false,
        spokenKept: "Let me check your orders.",
      });
      expect(session.enqueue).toHaveBeenCalledWith(
        "Let me check your orders.",
        "en-IN",
      );
      expect(session.end).toHaveBeenCalledOnce();
      expect(session.dropPending).not.toHaveBeenCalled();
    });

    it("reads the written answer when the answer after it carried no spoken block", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      await say(h, "Sales?");
      const session = h.speech.last();
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenKept: "Let me check.",
      });
      act(() => session.events.onStart());
      act(() => session.events.onIdle("done"));
      expect(h.result.current.state).toBe("waiting");
      h.rerender({
        ...h.input,
        messages: [
          ...h.input.messages,
          user("u1", "Sales?"),
          assistant("a1", "Sales are **up** this week."),
        ],
        isReplying: false,
        spokenKept: "",
      });
      expect(session.reopen).toHaveBeenCalledOnce();
      expect(session.enqueue).toHaveBeenLastCalledWith(
        "Sales are up this week.",
        "en-IN",
      );
      expect(session.end).toHaveBeenCalledTimes(2);
    });

    it("goes back to Thinking when the acknowledgement had already played before the run kept it", async () => {
      const h = makeHarness();
      await act(async () => h.result.current.toggle());
      await say(h, "How many orders?");
      const session = h.speech.last();
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "Let me check your orders.",
        spokenEnded: true,
      });
      act(() => session.events.onStart());
      act(() => session.events.onIdle("done"));
      expect(h.result.current.state).toBe("listening");
      h.rerender({
        ...h.input,
        isReplying: true,
        spokenText: "",
        spokenEnded: false,
        spokenKept: "Let me check your orders.",
      });
      expect(h.result.current.state).toBe("waiting");
      expect(h.mic.last().input.gate.current).toBe(MINK_BARGE_IN_GATE);
    });
  });

  it("★ a reply after Mink finished is never mistaken for its echo, even in Mink's own words", async () => {
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    await say(h, "Publish the blog");
    const session = h.speech.last();
    act(() => session.events.onStart());
    act(() =>
      session.events.onPieceStart(
        "Should I keep it as a draft or publish it now?",
      ),
    );
    act(() => session.events.onIdle("done"));
    expect(h.result.current.state).toBe("listening");
    await say(h, "keep it as a draft");
    expect(h.send).toHaveBeenLastCalledWith("keep it as a draft", {
      voice: true,
    });
  });

  it("★ a run that ends without an answer puts the loop back to listening", async () => {
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    await say(h, "Sales?");
    const session = h.speech.last();
    h.rerender({ ...h.input, isReplying: true });
    h.rerender({ ...h.input, isReplying: false });
    expect(session.cancel).toHaveBeenCalledOnce();
    expect(h.result.current.state).toBe("listening");
    expect(h.result.current.enabled).toBe(true);
  });

  it("a typed send while voice chat is on gets a spoken answer too", async () => {
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    act(() => h.result.current.noteSend());
    expect(h.result.current.state).toBe("waiting");
    expect(h.speech.sessions).toHaveLength(1);
    const session = h.speech.last();
    h.rerender({
      ...h.input,
      isReplying: true,
      spokenText: "Here you go. ",
      spokenEnded: true,
    });
    expect(session.enqueue).toHaveBeenCalledWith("Here you go.", "en-IN");
    // A second typed send cuts the first answer's voice, and never cancels
    // the run the chat has just started for it.
    act(() => session.events.onStart());
    act(() => h.result.current.noteSend());
    expect(session.cancel).toHaveBeenCalledOnce();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.result.current.state).toBe("waiting");
    expect(h.speech.sessions).toHaveLength(2);
  });

  it("never speaks history present when the mode was switched on, or an answer nobody asked for", async () => {
    const h = makeHarness({
      messages: [user("u0", "Hi"), assistant("a0", "Restored answer")],
    });
    await act(async () => h.result.current.toggle());
    h.rerender({ ...h.input, messages: [...h.input.messages] });
    h.rerender({
      ...h.input,
      messages: [user("x", "Other"), assistant("a9", "Loaded from history")],
    });
    expect(h.speech.sessions).toHaveLength(0);
    expect(h.result.current.state).toBe("listening");
  });

  it("re-arms on an empty transcript and stops after three in a row", async () => {
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    for (let i = 1; i < MAX_EMPTY_TRANSCRIPTS; i++) {
      await act(async () => h.mic.last().resolve(i % 2 ? null : "   "));
      expect(h.result.current.enabled).toBe(true);
      expect(h.result.current.state).toBe("listening");
      expect(h.mic.calls).toHaveLength(i + 1);
    }
    await act(async () => h.mic.last().resolve(null));
    expect(h.result.current.enabled).toBe(false);
    expect(h.result.current.state).toBe("idle");
    expect(h.result.current.notice).toBe(
      "Voice chat turned off: nothing was heard.",
    );
  });

  it("a real transcript resets the empty count, and the mic's own cap during an answer is silent", async () => {
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    await act(async () => h.mic.last().resolve(null));
    await act(async () => h.mic.last().resolve(null));
    await say(h, "Hello");
    // Waiting for the answer: the recorder closed on its ceiling.
    await act(async () => h.mic.last().resolve(null));
    await act(async () => h.mic.last().resolve(null));
    await act(async () => h.mic.last().resolve(null));
    expect(h.result.current.enabled).toBe(true);
    expect(h.result.current.state).toBe("waiting");
  });

  it("stops on toggle off, a closed chat, a hidden tab, a chat error and a refused send", async () => {
    let h = makeHarness();
    await act(async () => h.result.current.toggle());
    const signal = h.mic.last().input.signal;
    await act(async () => h.result.current.toggle());
    expect(h.result.current.enabled).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(h.result.current.notice).toBeNull();
    h.unmount();

    h = makeHarness();
    await act(async () => h.result.current.toggle());
    h.rerender({ ...h.input, isChatOpen: false });
    expect(h.result.current.enabled).toBe(false);
    h.unmount();

    h = makeHarness();
    await act(async () => h.result.current.toggle());
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    expect(h.result.current.enabled).toBe(false);
    expect(h.result.current.notice).toBe(
      "Voice chat turned off while the tab was hidden.",
    );
    h.unmount();

    const stale = { code: "old", message: "Earlier" };
    h = makeHarness({ error: stale });
    await act(async () => h.result.current.toggle());
    h.rerender({ ...h.input, error: stale });
    expect(h.result.current.enabled).toBe(true);
    h.rerender({ ...h.input, error: { code: "run_failed", message: "Boom" } });
    expect(h.result.current.enabled).toBe(false);
    expect(h.result.current.notice).toBe(
      "Voice chat turned off after an error.",
    );
    h.unmount();

    h = makeHarness({ send: vi.fn(() => false) });
    await act(async () => h.result.current.toggle());
    await say(h, "Too long");
    expect(h.result.current.enabled).toBe(false);
    expect(h.result.current.notice).toBe(
      "Voice chat turned off: the message could not be sent.",
    );
    h.unmount();
  });

  it("★★ keeps one microphone for the whole chat, and closes it when voice chat ends", async () => {
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    expect(h.mic.createCapture).toHaveBeenCalledOnce();
    await say(h, "Sales?");
    const first = h.speech.last();
    h.rerender({
      ...h.input,
      messages: [
        ...h.input.messages,
        user("u1", "Sales?"),
        assistant("a1", "Sales are up."),
      ],
      isReplying: false,
    });
    act(() => first.events.onIdle("done"));
    await say(h, "Orders?");
    // Every turn records on the same microphone.
    expect(h.mic.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.mic.createCapture).toHaveBeenCalledOnce();
    expect(h.mic.close).not.toHaveBeenCalled();
    await act(async () => h.result.current.toggle());
    expect(h.mic.close).toHaveBeenCalledOnce();
    await act(async () => h.result.current.toggle());
    expect(h.mic.createCapture).toHaveBeenCalledTimes(2);
  });

  it("★ clears the last session's notice when voice chat is turned on again", async () => {
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    for (let i = 0; i < MAX_EMPTY_TRANSCRIPTS; i += 1)
      await act(async () => h.mic.last().resolve(null));
    expect(h.result.current.notice).toBe(
      "Voice chat turned off: nothing was heard.",
    );
    await act(async () => h.result.current.toggle());
    expect(h.result.current.enabled).toBe(true);
    expect(h.result.current.notice).toBeNull();
  });

  it("stops when the microphone cannot start or transcription fails, naming which", async () => {
    let h = makeHarness();
    await act(async () => h.result.current.toggle());
    await act(async () =>
      h.mic
        .last()
        .reject(new MinkVoiceCaptureError("mic", "Permission denied.")),
    );
    expect(h.result.current.enabled).toBe(false);
    expect(h.result.current.notice).toBe(
      "Voice chat turned off: the microphone could not start.",
    );
    h.unmount();

    h = makeHarness();
    await act(async () => h.result.current.toggle());
    await act(async () =>
      h.mic
        .last()
        .reject(
          new MinkVoiceCaptureError(
            "transcription",
            "The voice service is busy.",
          ),
        ),
    );
    expect(h.result.current.enabled).toBe(false);
    expect(h.result.current.notice).toBe(
      "The voice service is busy. Voice chat turned off.",
    );
  });

  it("stopping clears a parked transcript and cuts the answer's voice, and the reply still lands in the chat", async () => {
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    await say(h, "Sales?");
    const session = h.speech.last();
    h.rerender({ ...h.input, isReplying: true });
    const mic = h.mic.last();
    act(() => {
      mic.input.onSpeechStart();
    });
    await act(async () => mic.resolve("Parked question"));
    expect(h.send).toHaveBeenCalledOnce();
    await act(async () => h.result.current.toggle());
    expect(session.cancel).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalled();
    h.rerender({ ...h.input, isReplying: false });
    expect(h.send).toHaveBeenCalledOnce();
    // A reply still running is not cancelled by ending voice chat.
    expect(h.cancel).toHaveBeenCalledOnce();
  });

  it("surfaces a session notice and clears it, and closes the audio once the model is known to be off", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    await say(h, "Sales?");
    const session = h.speech.last();
    act(() =>
      session.events.onNotice(
        "The rest of that answer could not be read aloud.",
      ),
    );
    expect(h.result.current.notice).toBe(
      "The rest of that answer could not be read aloud.",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINK_VOICE_NOTICE_MS + 1);
    });
    expect(h.result.current.notice).toBeNull();
    act(() => session.events.onVoiceOff());
    expect(contexts[0].close).not.toHaveBeenCalled();
    act(() => session.events.onIdle("done"));
    expect(contexts[0].close).toHaveBeenCalled();
    // The next turn starts on the browser voice.
    await say(h, "Orders?");
    expect(h.speech.last().options.voice).toBe("browser");
    expect(h.speech.last().options.audio).toBeNull();
  });

  it("uses the browser voice straight away when no model is on, and ignores a late answer from an earlier session", async () => {
    let answerFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => (answerFirst = resolve));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockImplementation(async () => ({
          ok: true,
          json: async () => ({ enabled: true }),
        })),
    );
    const h = makeHarness();
    await act(async () => h.result.current.toggle());
    await act(async () => h.result.current.toggle());
    await act(async () => h.result.current.toggle());
    await act(async () => {
      answerFirst({ ok: true, json: async () => ({ enabled: false }) });
    });
    await say(h, "Sales?");
    // The current session's "on" stands, and its context was not closed.
    expect(h.speech.last().options.voice).toBe("model");
    expect(contexts[1].close).not.toHaveBeenCalled();
    h.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ enabled: false }) })),
    );
    const off = makeHarness();
    await act(async () => off.result.current.toggle());
    await say(off, "Sales?");
    expect(off.speech.last().options.voice).toBe("browser");
    expect(contexts[2].close).toHaveBeenCalled();
  });

  it("reports why the browser cannot run voice chat", async () => {
    installBrowser({ speech: false });
    expect(voiceChatSupport()).toEqual({
      ok: false,
      reason: "Voice chat needs a browser that can read answers aloud.",
    });
    installBrowser({ mic: false });
    expect(voiceChatSupport()).toEqual({
      ok: false,
      reason: "Voice chat needs a browser with microphone support.",
    });
    const h = makeHarness();
    expect(h.result.current.support.ok).toBe(false);
    await act(async () => h.result.current.toggle());
    expect(h.result.current.enabled).toBe(false);
    expect(h.mic.calls).toHaveLength(0);
    expect(h.result.current.notice).toBe(
      "Voice chat needs a browser with microphone support.",
    );
  });
});
