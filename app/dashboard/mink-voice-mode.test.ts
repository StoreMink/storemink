// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MinkMessage } from "./mink-ai";
import {
  MAX_EMPTY_TRANSCRIPTS,
  speechWatchdogMs,
  useMinkVoiceMode,
  voiceChatSupport,
  type MinkVoiceModeInput,
} from "./mink-voice-mode";

const speechPlayer = vi.hoisted(() => ({
  play: vi.fn(),
  silent: vi.fn(() => "blob:silent"),
}));
vi.mock("./mink-speech-player", () => ({
  playMinkServerSpeech: speechPlayer.play,
  silentWavUrl: speechPlayer.silent,
}));

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
  speaking: false,
};

function installBrowser(options: { speech?: boolean; mic?: boolean } = {}) {
  const { speech = true, mic = true } = options;
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(window, "AudioContext", {
    value: mic ? class {} : undefined,
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

function assistant(id: number | string, text: string): MinkMessage {
  return { id, role: "assistant", text };
}
function user(id: number | string, text: string): MinkMessage {
  return { id, role: "user", text };
}

function makeInput(
  overrides: Partial<MinkVoiceModeInput> = {},
): MinkVoiceModeInput & {
  listen: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  stopListening: ReturnType<typeof vi.fn>;
  onNotice: ReturnType<typeof vi.fn>;
} {
  return {
    messages: [assistant("old", "Hello before voice mode")],
    isReplying: false,
    isChatOpen: true,
    error: null,
    listen: vi.fn(async () => true),
    stopListening: vi.fn(),
    send: vi.fn(async () => true),
    onNotice: vi.fn(),
    langFallback: "en-IN",
    ...overrides,
  } as never;
}

function lastUtterance(): FakeUtterance {
  const calls = synth.speak.mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  synth.speak.mockReset();
  synth.cancel.mockReset();
  installBrowser();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMinkVoiceMode", () => {
  it("runs listen, send, wait, speak, listen as one hands-free loop", async () => {
    const input = makeInput();
    const { result, rerender } = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    expect(result.current.enabled).toBe(false);
    expect(result.current.state).toBe("idle");
    expect(result.current.support.ok).toBe(true);

    await act(async () => result.current.toggle());
    expect(result.current.enabled).toBe(true);
    expect(result.current.state).toBe("listening");
    expect(input.listen).toHaveBeenCalledOnce();

    await act(async () =>
      result.current.reportTranscript("How many orders today?"),
    );
    expect(input.send).toHaveBeenCalledWith("How many orders today?");
    expect(result.current.state).toBe("waiting");

    // The user turn lands and Mink starts replying: nothing is spoken yet.
    rerender({
      ...input,
      messages: [...input.messages, user("u1", "How many orders today?")],
      isReplying: true,
    });
    expect(synth.speak).not.toHaveBeenCalled();

    rerender({
      ...input,
      messages: [
        ...input.messages,
        user("u1", "How many orders today?"),
        assistant("a1", "You have **12 orders** today."),
      ],
      isReplying: false,
    });
    expect(result.current.state).toBe("speaking");
    expect(synth.cancel).toHaveBeenCalled();
    expect(synth.speak).toHaveBeenCalledOnce();
    expect(lastUtterance().text).toBe("You have 12 orders today.");
    expect(lastUtterance().lang).toBe("en-IN");

    await act(async () => lastUtterance().onend?.());
    expect(result.current.state).toBe("listening");
    expect(input.listen).toHaveBeenCalledTimes(2);
  });

  it("never speaks history present when the mode was switched on, or an answer nobody asked for", async () => {
    const input = makeInput({
      messages: [user("u0", "Hi"), assistant("a0", "Restored answer")],
    });
    const { result, rerender } = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    await act(async () => result.current.toggle());
    // A re-render with the same baseline answer, before anything was sent.
    rerender({ ...input, messages: [...input.messages] });
    expect(synth.speak).not.toHaveBeenCalled();
    // A conversation loaded while listening (nothing sent) stays silent.
    rerender({
      ...input,
      messages: [user("x", "Other"), assistant("a9", "Loaded from history")],
    });
    expect(synth.speak).not.toHaveBeenCalled();
    expect(result.current.state).toBe("listening");
  });

  it("speaks an answer to a typed send and cancels speech when a new send starts", async () => {
    const input = makeInput();
    const { result, rerender } = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    await act(async () => result.current.toggle());
    await act(async () => result.current.noteSend());
    expect(result.current.state).toBe("waiting");
    rerender({
      ...input,
      messages: [...input.messages, assistant("a1", "First answer.")],
    });
    expect(result.current.state).toBe("speaking");
    const first = lastUtterance();
    synth.cancel.mockClear();

    await act(async () => result.current.noteSend());
    expect(synth.cancel).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("waiting");
    // The cancelled utterance's end event must not re-arm the mic.
    await act(async () => first.onend?.());
    expect(input.listen).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("waiting");
  });

  it("picks the utterance language from the answer's script", async () => {
    const input = makeInput({ langFallback: "en-GB" });
    const { result, rerender } = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    await act(async () => result.current.toggle());
    await act(async () =>
      result.current.reportTranscript("आज कितने ऑर्डर आए?"),
    );
    rerender({
      ...input,
      messages: [...input.messages, assistant("a1", "आज 12 ऑर्डर आए हैं।")],
    });
    expect(lastUtterance().lang).toBe("hi-IN");
  });

  it("re-arms on an empty transcript and stops after three in a row", async () => {
    const input = makeInput();
    const { result } = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    await act(async () => result.current.toggle());
    for (let i = 1; i < MAX_EMPTY_TRANSCRIPTS; i++) {
      await act(async () =>
        result.current.reportTranscript(i % 2 ? null : "   "),
      );
      expect(result.current.enabled).toBe(true);
      expect(result.current.state).toBe("listening");
      expect(input.listen).toHaveBeenCalledTimes(i + 1);
    }
    await act(async () => result.current.reportTranscript(null));
    expect(result.current.enabled).toBe(false);
    expect(result.current.state).toBe("idle");
    expect(input.onNotice).toHaveBeenCalledWith(
      "Voice chat turned off: nothing was heard.",
    );
    expect(input.stopListening).toHaveBeenCalled();
  });

  it("a real transcript resets the empty count", async () => {
    const input = makeInput();
    const { result, rerender } = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    await act(async () => result.current.toggle());
    await act(async () => result.current.reportTranscript(null));
    await act(async () => result.current.reportTranscript(null));
    await act(async () => result.current.reportTranscript("Hello"));
    rerender({
      ...input,
      messages: [...input.messages, assistant("a1", "Hi.")],
    });
    await act(async () => lastUtterance().onend?.());
    await act(async () => result.current.reportTranscript(null));
    await act(async () => result.current.reportTranscript(null));
    expect(result.current.enabled).toBe(true);
  });

  it("stops on toggle off, a closed chat, a hidden tab, a chat error and a refused send", async () => {
    // Toggle off.
    let input = makeInput();
    let hook = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      {
        initialProps: input,
      },
    );
    await act(async () => hook.result.current.toggle());
    await act(async () => hook.result.current.toggle());
    expect(hook.result.current.enabled).toBe(false);
    expect(input.stopListening).toHaveBeenCalledOnce();
    expect(input.onNotice).not.toHaveBeenCalled();
    hook.unmount();

    // The chat closes.
    input = makeInput();
    hook = renderHook((props: MinkVoiceModeInput) => useMinkVoiceMode(props), {
      initialProps: input,
    });
    await act(async () => hook.result.current.toggle());
    hook.rerender({ ...input, isChatOpen: false });
    expect(hook.result.current.enabled).toBe(false);
    hook.unmount();

    // The tab goes hidden.
    input = makeInput();
    hook = renderHook((props: MinkVoiceModeInput) => useMinkVoiceMode(props), {
      initialProps: input,
    });
    await act(async () => hook.result.current.toggle());
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
    expect(hook.result.current.enabled).toBe(false);
    expect(input.onNotice).toHaveBeenCalledWith(
      "Voice chat turned off while the tab was hidden.",
    );
    hook.unmount();

    // A send error from the chat (a pre-existing error does not count).
    const stale = { code: "old", message: "Earlier" };
    input = makeInput({ error: stale });
    hook = renderHook((props: MinkVoiceModeInput) => useMinkVoiceMode(props), {
      initialProps: input,
    });
    await act(async () => hook.result.current.toggle());
    hook.rerender({ ...input, error: stale });
    expect(hook.result.current.enabled).toBe(true);
    hook.rerender({ ...input, error: { code: "run_failed", message: "Boom" } });
    expect(hook.result.current.enabled).toBe(false);
    expect(input.onNotice).toHaveBeenCalledWith(
      "Voice chat turned off after an error.",
    );
    hook.unmount();

    // The composer refuses the send.
    input = makeInput({ send: vi.fn(async () => false) });
    hook = renderHook((props: MinkVoiceModeInput) => useMinkVoiceMode(props), {
      initialProps: input,
    });
    await act(async () => hook.result.current.toggle());
    await act(async () => hook.result.current.reportTranscript("Too long"));
    expect(hook.result.current.enabled).toBe(false);
    expect(input.onNotice).toHaveBeenCalledWith(
      "Voice chat turned off: the message could not be sent.",
    );
    hook.unmount();
  });

  it("stops when the microphone cannot start or transcription fails", async () => {
    let input = makeInput({ listen: vi.fn(async () => false) });
    let hook = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      {
        initialProps: input,
      },
    );
    await act(async () => hook.result.current.toggle());
    expect(hook.result.current.enabled).toBe(false);
    expect(input.onNotice).toHaveBeenCalledWith(
      "Voice chat turned off: the microphone could not start.",
    );
    hook.unmount();

    input = makeInput();
    hook = renderHook((props: MinkVoiceModeInput) => useMinkVoiceMode(props), {
      initialProps: input,
    });
    await act(async () => hook.result.current.toggle());
    await act(async () => hook.result.current.reportTranscriptionFailure());
    expect(hook.result.current.enabled).toBe(false);
    hook.unmount();
  });

  it("cancels speech and aborts the mic on unmount", async () => {
    const input = makeInput();
    const { result, rerender, unmount } = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    await act(async () => result.current.toggle());
    await act(async () => result.current.reportTranscript("Hello"));
    rerender({
      ...input,
      messages: [...input.messages, assistant("a1", "Hi there.")],
    });
    const utterance = lastUtterance();
    synth.cancel.mockClear();
    unmount();
    expect(synth.cancel).toHaveBeenCalledOnce();
    expect(input.stopListening).toHaveBeenCalled();
    await act(async () => utterance.onend?.());
    expect(input.listen).toHaveBeenCalledOnce();
  });

  it("re-arms without speaking when the answer has nothing speakable", async () => {
    const input = makeInput();
    const { result, rerender } = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    await act(async () => result.current.toggle());
    await act(async () => result.current.reportTranscript("Show the CSV"));
    await act(async () => {
      rerender({
        ...input,
        messages: [...input.messages, assistant("a1", "```\nonly,code\n```")],
      });
    });
    expect(synth.speak).not.toHaveBeenCalled();
    expect(result.current.state).toBe("listening");
    expect(input.listen).toHaveBeenCalledTimes(2);
  });

  it("treats a missing end event as the end after the watchdog", async () => {
    vi.useFakeTimers();
    const input = makeInput();
    const { result, rerender } = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    await act(async () => result.current.toggle());
    await act(async () => result.current.reportTranscript("Hello"));
    rerender({
      ...input,
      messages: [...input.messages, assistant("a1", "Hi there.")],
    });
    expect(result.current.state).toBe("speaking");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(speechWatchdogMs("Hi there.") + 1);
    });
    expect(result.current.state).toBe("listening");
    expect(input.listen).toHaveBeenCalledTimes(2);
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
    const input = makeInput();
    const { result } = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    expect(result.current.support.ok).toBe(false);
    await act(async () => result.current.toggle());
    expect(result.current.enabled).toBe(false);
    expect(input.listen).not.toHaveBeenCalled();
  });
});

describe("★★ read-aloud model", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function speakOneAnswer(enabled: boolean) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ enabled }) })),
    );
    const input = makeInput();
    const hook = renderHook(
      (props: MinkVoiceModeInput) => useMinkVoiceMode(props),
      { initialProps: input },
    );
    await act(async () => hook.result.current.toggle());
    await act(async () => hook.result.current.reportTranscript("Sales?"));
    hook.rerender({
      ...input,
      messages: [...input.messages, assistant("a1", "Sales are **up**.")],
    });
    return { ...hook, input };
  }

  it("plays the answer through the model, Thinking until the audio starts", async () => {
    let finish!: (value: unknown) => void;
    speechPlayer.play.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const { result, input } = await speakOneAnswer(true);
    expect(speechPlayer.play).toHaveBeenCalledOnce();
    const call = speechPlayer.play.mock.calls[0][0];
    expect(call.text).toBe("Sales are up.");
    expect(call.lang).toBe("en-IN");
    expect(synth.speak).not.toHaveBeenCalled();
    expect(result.current.state).toBe("waiting");
    act(() => call.onStart());
    expect(result.current.state).toBe("speaking");
    await act(async () => finish({ outcome: "done" }));
    expect(input.listen).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe("listening");
  });

  it("lets the browser voice read whatever the model could not", async () => {
    speechPlayer.play.mockResolvedValue({
      outcome: "browser",
      remaining: "Sales are up.",
    });
    await speakOneAnswer(true);
    await act(async () => {});
    expect(synth.speak).toHaveBeenCalledOnce();
    expect(lastUtterance().text).toBe("Sales are up.");
  });

  it("uses the browser voice straight away when no model is on", async () => {
    await speakOneAnswer(false);
    expect(speechPlayer.play).not.toHaveBeenCalled();
    expect(synth.speak).toHaveBeenCalledOnce();
  });

  it("stopping voice chat cancels model playback", async () => {
    speechPlayer.play.mockImplementation(() => new Promise(() => {}));
    const { result } = await speakOneAnswer(true);
    const { signal } = speechPlayer.play.mock.calls[0][0];
    expect(signal.aborted).toBe(false);
    await act(async () => result.current.toggle());
    expect(signal.aborted).toBe(true);
  });
});
