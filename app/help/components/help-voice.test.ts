// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MinkSpeechSession } from "@/app/dashboard/mink-speech-session";
import type { MinkVoiceCapture } from "@/lib/mink/voice-turn";
import {
  HELP_TALK_EMPTY_LIMIT,
  HELP_VOICE_ENDPOINT,
  microphoneMessage,
  spokenHelpAnswer,
  transcribeHelpRecording,
  useHelpReadAloud,
  useHelpTalk,
  type HelpTalkReply,
} from "./help-voice";
import { openHelpMink, readOpenHelpMinkDetail } from "./mink-launch";

type Events = Parameters<
  typeof import("@/app/dashboard/mink-speech-session").createMinkSpeechSession
>[0]["events"];

/** A speech session that records what it was asked to say. */
function fakeSessions() {
  const said: string[] = [];
  const sessions: Array<{ events: Events; cancelled: boolean }> = [];
  const create = vi.fn((options: { events: Events }) => {
    const record = { events: options.events, cancelled: false };
    sessions.push(record);
    const session: MinkSpeechSession = {
      enqueue: (text) => {
        options.events.onStart();
        options.events.onPieceStart(text);
        said.push(text);
      },
      dropPending: () => {},
      end: () => {
        // Speech "finishes" on the next tick, as a real voice would later.
        setTimeout(() => {
          if (!record.cancelled) options.events.onIdle("done");
        }, 0);
      },
      reopen: () => {},
      pause: () => {},
      resume: () => {},
      cancel: () => {
        record.cancelled = true;
      },
      active: true,
    };
    return session;
  });
  return { said, sessions, create };
}

/** A microphone that hears each scripted turn once, then waits for a stop. */
function scriptedCapture(turns: Array<string | null>) {
  const calls: number[] = [];
  let closed = false;
  const capture: MinkVoiceCapture = {
    capture: vi.fn((input) => {
      calls.push(calls.length);
      const next = turns.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise<string | null>((_, reject) => {
        input.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    }),
    close: vi.fn(() => {
      closed = true;
    }),
  };
  return { capture, calls, isClosed: () => closed };
}

describe("spokenHelpAnswer", () => {
  it("reads each step with the chat language's word for a step", () => {
    expect(
      spokenHelpAnswer(
        { answer: "ठीक है।", steps: ["Products खोलें।"] },
        "चरण",
      ),
    ).toBe("ठीक है। चरण 1: Products खोलें।");
  });

  it("reads the answer, then each step by number, without Markdown", () => {
    expect(
      spokenHelpAnswer({
        answer: "Open **Products** to add one.",
        steps: ["Select Add product.", "Save."],
      }),
    ).toBe(
      "Open Products to add one. Step 1: Select Add product. Step 2: Save.",
    );
  });
});

describe("microphoneMessage", () => {
  it("says what the visitor can do, never the browser's words", () => {
    expect(microphoneMessage({ name: "NotAllowedError" })).toMatch(
      /Microphone access is blocked/,
    );
    expect(microphoneMessage({ name: "NotFoundError" })).toMatch(
      /No microphone was found/,
    );
    expect(
      microphoneMessage(new Error("Microphone recording needs HTTPS")),
    ).toMatch(/secure connection/);
    expect(microphoneMessage(new Error("weird"))).toMatch(/couldn't start/);
  });
});

describe("transcribeHelpRecording", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to the public Help route, never the dashboard's", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ text: " how do I add a product " }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const text = await transcribeHelpRecording(
      new File([new Uint8Array(8)], "clip.wav", { type: "audio/wav" }),
    );
    expect(text).toBe("how do I add a product");
    expect(fetchMock).toHaveBeenCalledWith(
      HELP_VOICE_ENDPOINT,
      expect.objectContaining({ method: "POST" }),
    );
    expect(HELP_VOICE_ENDPOINT).toBe("/api/help/voice");
  });
});

describe("useHelpTalk", () => {
  beforeEach(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  it("listens, asks the question, reads the answer aloud, then listens again", async () => {
    const mic = scriptedCapture(["How do I add a product?"]);
    const speech = fakeSessions();
    const ask = vi.fn(
      async (): Promise<HelpTalkReply> => ({
        answer: { answer: "Open Products.", steps: ["Select Add product."] },
      }),
    );
    const { result, unmount } = renderHook(() =>
      useHelpTalk({
        ask,
        createCapture: () => mic.capture,
        createSession: speech.create,
      }),
    );

    act(() => result.current.start());
    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith("How do I add a product?"),
    );
    await waitFor(() => expect(mic.calls).toHaveLength(2));
    expect(speech.said.join(" ")).toContain("Open Products.");
    expect(speech.said.join(" ")).toContain("Step 1: Select Add product.");
    expect(result.current.phase).toBe("listening");

    act(() => result.current.stop());
    expect(result.current.active).toBe(false);
    expect(mic.isClosed()).toBe(true);
    unmount();
  });

  it("ends the conversation after three turns with no words, asking nothing", async () => {
    const mic = scriptedCapture(
      Array.from({ length: HELP_TALK_EMPTY_LIMIT }, () => null),
    );
    const ask = vi.fn();
    const { result } = renderHook(() =>
      useHelpTalk({
        ask,
        createCapture: () => mic.capture,
        createSession: fakeSessions().create,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.active).toBe(false));
    expect(result.current.notice).toMatch(/didn't hear anything/);
    expect(ask).not.toHaveBeenCalled();
    expect(mic.isClosed()).toBe(true);
  });

  it("asks again aloud when the words were not a question", async () => {
    const mic = scriptedCapture(["um"]);
    const speech = fakeSessions();
    const { result } = renderHook(() =>
      useHelpTalk({
        ask: async () => ({ unclear: true }),
        createCapture: () => mic.capture,
        createSession: speech.create,
      }),
    );

    act(() => result.current.start());
    await waitFor(() =>
      expect(speech.said.join(" ")).toMatch(/didn't catch a question/),
    );
    act(() => result.current.stop());
  });

  it("skip stops the answer and goes back to listening", async () => {
    const mic = scriptedCapture(["How do I connect my domain?"]);
    const neverEnds = vi.fn((options: { events: Events }) => {
      const session: MinkSpeechSession = {
        enqueue: () => options.events.onStart(),
        dropPending: () => {},
        end: () => {},
        reopen: () => {},
        pause: () => {},
        resume: () => {},
        cancel: vi.fn(),
        active: true,
      };
      return session;
    });
    const { result } = renderHook(() =>
      useHelpTalk({
        ask: async () => ({ answer: { answer: "Open Domain.", steps: [] } }),
        createCapture: () => mic.capture,
        createSession: neverEnds,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("speaking"));
    act(() => result.current.skip());
    await waitFor(() => expect(mic.calls).toHaveLength(2));
    expect(result.current.phase).toBe("listening");
    act(() => result.current.stop());
  });

  it("ends when the page is hidden, and says why", async () => {
    const mic = scriptedCapture([]);
    const { result } = renderHook(() =>
      useHelpTalk({
        ask: vi.fn(),
        createCapture: () => mic.capture,
        createSession: fakeSessions().create,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("listening"));
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.active).toBe(false);
    expect(result.current.notice).toMatch(/page was hidden/);
    expect(mic.isClosed()).toBe(true);
  });

  it("closes the microphone when the assistant unmounts", async () => {
    const mic = scriptedCapture([]);
    const { result, unmount } = renderHook(() =>
      useHelpTalk({
        ask: vi.fn(),
        createCapture: () => mic.capture,
        createSession: fakeSessions().create,
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(mic.calls).toHaveLength(1));
    unmount();
    expect(mic.isClosed()).toBe(true);
  });
});

describe("useHelpReadAloud", () => {
  it("reads one answer and clears when it finishes", async () => {
    const speech = fakeSessions();
    const { result } = renderHook(() => useHelpReadAloud(speech.create));
    act(() => result.current.speak(4, "Open **Settings**."));
    expect(result.current.speakingId).toBe(4);
    expect(speech.said).toEqual(["Open Settings."]);
    await waitFor(() => expect(result.current.speakingId).toBeNull());
  });

  it("starting another answer stops the first", () => {
    const speech = fakeSessions();
    const { result } = renderHook(() => useHelpReadAloud(speech.create));
    act(() => result.current.speak(1, "First."));
    act(() => result.current.speak(2, "Second."));
    expect(speech.sessions[0].cancelled).toBe(true);
    expect(result.current.speakingId).toBe(2);
    act(() => result.current.stop());
    expect(result.current.speakingId).toBeNull();
  });
});

describe("mink launch event", () => {
  it("carries a trimmed question and a mode, and nothing else", () => {
    const seen: Array<ReturnType<typeof readOpenHelpMinkDetail>> = [];
    const listener = (event: Event) => seen.push(readOpenHelpMinkDetail(event));
    window.addEventListener("sm-help:open-mink", listener);
    openHelpMink({ mode: "talk" });
    openHelpMink({ question: "   How do I add a product?  " });
    openHelpMink({ expand: true });
    window.removeEventListener("sm-help:open-mink", listener);
    expect(seen).toEqual([
      { mode: "talk", question: undefined },
      { mode: "chat", question: "How do I add a product?" },
      { mode: "chat", question: undefined, expand: true },
    ]);
    expect(
      readOpenHelpMinkDetail(
        new CustomEvent("x", { detail: { mode: "shout", question: 42 } }),
      ),
    ).toEqual({ mode: "chat", question: undefined });
  });
});
