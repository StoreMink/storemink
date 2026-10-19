// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MinkVoiceView, minkVoiceStatus } from "./mink-voice-view";
import type { MinkVoiceMode } from "./mink-voice-mode";

function voice(overrides: Partial<MinkVoiceMode> = {}): MinkVoiceMode {
  return {
    enabled: true,
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
      "Thinking…",
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

describe("MinkVoiceView", () => {
  it("shows the status, the captions and End, with focus on End", () => {
    const v = voice({
      state: "speaking",
      heard: "How many orders today?",
      said: "You have twelve orders today.",
    });
    render(
      <MinkVoiceView voice={v} isReplying={false} onStopReply={vi.fn()} />,
    );
    expect(
      screen.getByRole("region", { name: "Voice chat with Mink" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Speaking…");
    expect(screen.getByText("You said")).toBeInTheDocument();
    expect(screen.getByText("How many orders today?")).toBeInTheDocument();
    expect(screen.getByText("Mink")).toBeInTheDocument();
    expect(
      screen.getByText("You have twelve orders today."),
    ).toBeInTheDocument();
    const end = screen.getByRole("button", { name: "Stop voice chat" });
    expect(end).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Stop Mink AI" })).toBeNull();
    fireEvent.click(end);
    expect(v.toggle).toHaveBeenCalledOnce();
  });

  it("omits empty captions, offers Stop only while Mink is replying, and ends on Escape", () => {
    const v = voice();
    const stop = vi.fn();
    render(<MinkVoiceView voice={v} isReplying onStopReply={stop} />);
    expect(screen.queryByText("You said")).toBeNull();
    expect(screen.queryByText("Mink")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop Mink AI" }));
    expect(stop).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByTestId("mink-voice-view"), { key: "Escape" });
    expect(v.toggle).toHaveBeenCalledOnce();
  });

  it("renders a notice as an alert", () => {
    render(
      <MinkVoiceView
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
