// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MinkVoiceBar,
  minkVoiceCaption,
  minkVoiceFace,
  minkVoiceStatus,
} from "./mink-voice-view";
import type { MinkVoiceMode } from "./mink-voice-mode";

function voice(overrides: Partial<MinkVoiceMode> = {}): MinkVoiceMode {
  return {
    enabled: true,
    muted: false,
    toggleMute: vi.fn(),
    state: "listening",
    mic: "open",
    support: { ok: true },
    levelRef: { current: 0 },
    heard: null,
    said: null,
    notice: null,
    toggle: vi.fn(),
    noteSend: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("minkVoiceStatus", () => {
  it("names each state in the merchant's words", () => {
    expect(minkVoiceStatus({ state: "listening", mic: "starting" })).toBe(
      "Starting microphone…",
    );
    expect(minkVoiceStatus({ state: "listening", mic: "open" })).toBe(
      "Listening…",
    );
    expect(minkVoiceStatus({ state: "listening", mic: "transcribing" })).toBe(
      "Transcribing…",
    );
    expect(minkVoiceStatus({ state: "sending", mic: "closed" })).toBe(
      "Sending…",
    );
    expect(minkVoiceStatus({ state: "waiting", mic: "open" })).toBe(
      "Thinking…",
    );
    expect(minkVoiceStatus({ state: "speaking", mic: "open" })).toBe(
      "Speaking…",
    );
    expect(minkVoiceStatus({ state: "idle", mic: "closed" })).toBe("");
  });
});

describe("minkVoiceFace", () => {
  it("gives the Mink face the expression for what voice chat is doing", () => {
    expect(minkVoiceFace(voice({ state: "listening", mic: "open" }))).toBe(
      "listening",
    );
    expect(minkVoiceFace(voice({ state: "listening", mic: "starting" }))).toBe(
      "default",
    );
    expect(
      minkVoiceFace(voice({ state: "listening", mic: "open", muted: true })),
    ).toBe("default");
    expect(
      minkVoiceFace(voice({ state: "listening", mic: "transcribing" })),
    ).toBe("thinking");
    expect(minkVoiceFace(voice({ state: "sending" }))).toBe("thinking");
    expect(minkVoiceFace(voice({ state: "waiting" }))).toBe("thinking");
    expect(minkVoiceFace(voice({ state: "speaking" }))).toBe("talking");
    expect(minkVoiceFace(voice({ state: "idle" }))).toBe("default");
  });

  it("draws the face in the bar, in that expression", () => {
    const { container } = render(
      <MinkVoiceBar
        voice={voice({ state: "speaking", said: "Hello" })}
        isReplying={false}
        onStopReply={vi.fn()}
      />,
    );
    const face = container.querySelector("[data-mink-face]");
    expect(face?.getAttribute("data-state")).toBe("talking");
  });
});

describe("minkVoiceCaption", () => {
  it("captions what Mink is saying, or the words waiting to be sent", () => {
    expect(
      minkVoiceCaption({
        state: "speaking",
        heard: "How many orders?",
        said: "Twelve today.",
      }),
    ).toEqual({ who: "Mink", text: "Twelve today." });
    expect(
      minkVoiceCaption({
        state: "sending",
        heard: "And yesterday?",
        said: "Twelve today.",
      }),
    ).toEqual({ who: "You", text: "And yesterday?" });
    // Listening or thinking: the thread already shows both sides.
    expect(
      minkVoiceCaption({
        state: "listening",
        heard: "How many orders?",
        said: "Twelve today.",
      }),
    ).toBeNull();
    expect(
      minkVoiceCaption({ state: "waiting", heard: "How many?", said: null }),
    ).toBeNull();
  });
});

describe("MinkVoiceBar", () => {
  it("shows the status, Mink's words and End, with focus on End", () => {
    const v = voice({
      state: "speaking",
      heard: "How many orders today?",
      said: "You have twelve orders today.",
    });
    render(<MinkVoiceBar voice={v} isReplying={false} onStopReply={vi.fn()} />);
    const bar = screen.getByRole("region", { name: "Voice chat with Mink" });
    expect(bar).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Speaking…");
    expect(bar).toHaveTextContent("Mink: You have twelve orders today.");
    // What was heard is a message in the thread by now, not repeated here.
    expect(bar).not.toHaveTextContent("How many orders today?");
    const end = screen.getByRole("button", { name: "Stop voice chat" });
    expect(end).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Stop Mink AI" })).toBeNull();
    fireEvent.click(end);
    expect(v.toggle).toHaveBeenCalledOnce();
  });

  it("offers Stop only while Mink is replying, and ends on Escape", () => {
    const v = voice();
    const stop = vi.fn();
    render(<MinkVoiceBar voice={v} isReplying onStopReply={stop} />);
    expect(screen.getByRole("status")).toHaveTextContent("Listening…");
    fireEvent.click(screen.getByRole("button", { name: "Stop Mink AI" }));
    expect(stop).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByTestId("mink-voice-bar"), {
      key: "Escape",
    });
    expect(v.toggle).toHaveBeenCalledOnce();
  });

  it("★ offers no Stop once the server refused it: the reply finishes, and End still works", () => {
    // 25 Oct 2026: the run had already started something, so a Stop that
    // cannot stop it is worse than none. The thread's status line says why.
    const v = voice({ state: "waiting" });
    const stop = vi.fn();
    render(
      <MinkVoiceBar voice={v} isReplying stopRefused onStopReply={stop} />,
    );
    expect(screen.queryByRole("button", { name: "Stop Mink AI" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop voice chat" }));
    expect(v.toggle).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it("renders a notice as an alert", () => {
    render(
      <MinkVoiceBar
        voice={voice({
          notice: "The rest of that answer could not be read aloud.",
        })}
        isReplying={false}
        onStopReply={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The rest of that answer could not be read aloud.",
    );
  });
});

it("offers independent mute and expandable full captions", () => {
  const v = voice({
    muted: true,
    state: "speaking",
    said: "Your orders are ready to review.",
  });
  render(<MinkVoiceBar voice={v} isReplying={false} onStopReply={vi.fn()} />);
  const mute = screen.getByRole("button", { name: "Unmute microphone" });
  expect(mute).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(mute);
  expect(v.toggleMute).toHaveBeenCalledOnce();
  expect(v.toggle).not.toHaveBeenCalled();
  const details = screen.getByText("Captions").closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(details.querySelector("summary")!);
  expect(details.open).toBe(true);
  expect(details.querySelector("p")).toHaveTextContent(v.said!);
});
