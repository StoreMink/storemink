"use client";

import { useEffect, useRef } from "react";
import { Square, X } from "lucide-react";
import { MinkMark } from "./mink-mark";
import { MinkWaveform } from "./mink-waveform";
import type { MinkVoiceMode } from "./mink-voice-mode";

/**
 * What voice chat is doing, in the merchant's words. Transcription counts as
 * thinking: the microphone has closed and Mink is working out what was said.
 */
export function minkVoiceStatus(
  voice: Pick<MinkVoiceMode, "state" | "mic">,
): string {
  switch (voice.state) {
    case "speaking":
      return "Speaking…";
    case "waiting":
      return "Thinking…";
    case "sending":
      return "Sending…";
    case "listening":
      if (voice.mic === "starting") return "Starting microphone…";
      if (voice.mic === "transcribing") return "Thinking…";
      return "Listening…";
    default:
      return "";
  }
}

/**
 * The full-screen voice view: it replaces the thread inside the chat surface
 * while voice chat is on, so the merchant sees the waveform, what Mink heard,
 * the sentence it is saying and one way out. The written answers and their
 * cards collect in the chat behind it and are there when voice chat ends.
 */
export function MinkVoiceView({
  voice,
  isReplying,
  onStopReply,
}: {
  voice: MinkVoiceMode;
  /** Mink is still producing the written answer. */
  isReplying: boolean;
  onStopReply: () => void;
}) {
  const endRef = useRef<HTMLButtonElement>(null);
  // Focus lands on End: the toggle that opened this view is now hidden, so
  // without it focus would fall to the page.
  useEffect(() => {
    endRef.current?.focus({ preventScroll: true });
  }, []);
  const status = minkVoiceStatus(voice);
  const speaking = voice.state === "speaking";
  return (
    <div
      role="region"
      aria-label="Voice chat with Mink"
      data-testid="mink-voice-view"
      className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto overscroll-contain px-6 py-8 text-center"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          voice.toggle();
        }
      }}
    >
      <div className="flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-6">
        <MinkMark size="lg" />
        <p
          role="status"
          aria-live="polite"
          className="text-sm font-medium text-[#5b3fd0]"
        >
          {status}
        </p>
        <MinkWaveform
          levelRef={voice.levelRef}
          live={voice.mic === "open"}
          size="lg"
          className={`w-full ${speaking ? "text-[#1a1a1a]" : "text-[#6d4dff]"}`}
        />
        {voice.heard ? (
          <div className="w-full">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[#8c9196]">
              You said
            </p>
            <p className="mx-auto line-clamp-4 max-w-md rounded-2xl bg-[#f3efff] px-4 py-2 text-sm text-[#1a1a1a]">
              {voice.heard}
            </p>
          </div>
        ) : null}
        {voice.said ? (
          <div className="w-full">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[#8c9196]">
              Mink
            </p>
            <p className="line-clamp-4 text-base leading-relaxed text-[#1a1a1a]">
              {voice.said}
            </p>
          </div>
        ) : null}
        {voice.notice ? (
          <p
            role="alert"
            className="rounded-lg bg-[#fff4e5] px-3 py-2 text-xs text-[#8a5a00]"
          >
            {voice.notice}
          </p>
        ) : null}
      </div>
      <div className="mt-6 flex shrink-0 items-center gap-3">
        {isReplying ? (
          <button
            type="button"
            onClick={onStopReply}
            aria-label="Stop Mink AI"
            title="Stop Mink AI"
            className="inline-flex h-11 items-center gap-2 rounded-full border border-[#e5e5e5] bg-white px-4 text-sm font-medium text-[#1a1a1a] transition hover:bg-[#f6f6f6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff]"
          >
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
            Stop
          </button>
        ) : null}
        <button
          ref={endRef}
          type="button"
          aria-label="Stop voice chat"
          title="End voice chat"
          onClick={() => voice.toggle()}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-[#1a1a1a] px-5 text-sm font-medium text-white transition hover:bg-[#333] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] focus-visible:ring-offset-2"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          End
        </button>
      </div>
    </div>
  );
}
