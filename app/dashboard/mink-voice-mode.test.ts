// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MinkMessage } from "./mink-ai";
import {
  MAX_EMPTY_TRANSCRIPTS,
  MINK_BARGE_IN_GRACE_MS,
  MINK_VOICE_NOTICE_MS,
  useMinkVoiceMode,
  voiceChatSupport,
  type MinkVoiceModeInput,
} from "./mink-voice-mode";
import {
  MINK_BARGE_IN_GATE,
  MINK_SPEECH_GATE,
} from "@/lib/mink/voice-recorder";
import type { captureMinkVoiceTurn } from "@/lib/mink/voice-turn";
import { MinkVoiceCaptureError } from "@/lib/mink/voice-turn";
import type {
  createMinkSpeechSession,
  MinkSpeechSessionEvents,
} from "./mink-speech-session";

type CaptureInput = Parameters<typeof captureMinkVoiceTurn>[0];
type CaptureCall = {
  input: CaptureInput;
  resolve: (text: string | null) => void;
  reject: (error: unknown) => void;
};

/** A microphone the test drives: speech starts and transcripts land on cue. */
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
  return {
    capture: capture as unknown as typeof captureMinkVoiceTurn,
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
    streamingText: "",
    send: vi.fn(() => true),
    cancel: vi.fn(),
    langFallback: "en-IN",
    capture: mic.capture,
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
      streamingText: "You have **12 orders** today",
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

    it("while speaking: stops the voice, leaves a finished answer alone, and takes the new question", async () => {
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
      expect(session.cancel).toHaveBeenCalledOnce();
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.result.current.state).toBe("listening");
      await act(async () => mic.resolve("What about returns?"));
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

    it("★ while Mink is still thinking: cancels the reply, and sends the new words once the chat is free", async () => {
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
      expect(h.result.current.heard).toBe("Actually, show returns.");
      // The run ends with no answer: nothing is spoken, and the parked
      // transcript goes out exactly once.
      h.rerender({ ...h.input, isReplying: false });
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.send).toHaveBeenLastCalledWith("Actually, show returns.", {
        voice: true,
      });
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
      // Listening again, with a fresh microphone.
      expect(h.mic.calls).toHaveLength(3);
      expect(h.result.current.state).toBe("listening");
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
    // A second typed send cuts the first answer's voice.
    act(() => session.events.onStart());
    act(() => h.result.current.noteSend());
    expect(session.cancel).toHaveBeenCalledOnce();
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
