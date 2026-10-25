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
 * The line under the status: what Mink is saying right now (its spoken words
 * are not part of the written answer in the thread), or, while a transcript
 * waits to be sent, the words that were heard.
 */
export function minkVoiceCaption(
  voice: Pick<MinkVoiceMode, "state" | "heard" | "said">,
): { who: "Mink" | "You"; text: string } | null {
  if (voice.state === "speaking" && voice.said)
    return { who: "Mink", text: voice.said };
  if (voice.state === "sending" && voice.heard)
    return { who: "You", text: voice.heard };
  return null;
}

/**
 * ★★ VOICE CHAT LIVES INSIDE THE CHAT (owner's decision, 2026-10-20). This
 * bar takes the composer's place while voice chat is on, and the thread stays
 * on screen above it, so every written answer and every card (the storefront
 * card's Apply, a link, a chart) can be read and used without ending voice
 * chat, the way ChatGPT's voice has worked since late 2025. The full-screen
 * view it replaces hid the thread: an answer that said "check the review
 * card" left the merchant nothing to check.
 */
export function MinkVoiceBar({
  voice,
  isReplying,
  onStopReply,
  columnClass = "",
}: {
  voice: MinkVoiceMode;
  /** Mink is still producing the written answer. */
  isReplying: boolean;
  onStopReply: () => void;
  /** The thread's column, so the bar lines up with the messages above it. */
  columnClass?: string;
}) {
  const endRef = useRef<HTMLButtonElement>(null);
  // Focus lands on End: the toggle that started voice chat is in the
  // composer, which is hidden now, so without it focus would fall to the page.
  useEffect(() => {
    endRef.current?.focus({ preventScroll: true });
  }, []);
  const status = minkVoiceStatus(voice);
  const caption = minkVoiceCaption(voice);
  const speaking = voice.state === "speaking";
  return (
    <div
      role="region"
      aria-label="Voice chat with Mink"
      data-testid="mink-voice-bar"
      className="shrink-0 border-t border-[#f1f1f1] p-3 sm:p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          voice.toggle();
        }
      }}
    >
      {/* ★ SIZED BY ITS OWN WIDTH, NOT THE WINDOW'S: the side panel can be
          380px wide on a large screen, so a viewport breakpoint would crowd
          the status out between the waveform and the buttons. */}
      <div className={`@container ${columnClass}`}>
        {voice.notice ? (
          <p
            role="alert"
            className="mb-2 rounded-xl border border-[#f2ddb4] bg-[#fdf9ef] px-3 py-2 text-[11px] text-[#8a5a12]"
          >
            {voice.notice}
          </p>
        ) : null}
        <div className="flex min-w-0 items-center gap-3 rounded-3xl border border-[#e5e5e5] bg-white px-3 py-2.5 shadow-sm">
          <MinkMark size="sm" />
          <div className="min-w-0 flex-1">
            <p
              role="status"
              aria-live="polite"
              className="text-xs font-semibold text-[#5b3fd0]"
            >
              {status}
            </p>
            {caption ? (
              <p
                className="truncate text-xs text-[#5c5f62]"
                title={caption.text}
              >
                <span className="font-medium text-[#1a1a1a]">
                  {caption.who}:
                </span>{" "}
                {caption.text}
              </p>
            ) : null}
          </div>
          {/* Off in a narrow panel: the status says the same, and the
              buttons need the room. */}
          <div className="hidden w-20 shrink-0 @md:block @lg:w-28">
            <MinkWaveform
              levelRef={voice.levelRef}
              live={voice.mic === "open"}
              className={`w-full ${speaking ? "text-[#1a1a1a]" : "text-[#6d4dff]"}`}
            />
          </div>
          {isReplying ? (
            <button
              type="button"
              onClick={onStopReply}
              aria-label="Stop Mink AI"
              title="Stop Mink AI"
              className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-[#e5e5e5] bg-white px-3 text-sm pointer-coarse:h-11 pointer-coarse:min-w-11 font-medium text-[#1a1a1a] transition hover:bg-[#f6f6f6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff]"
            >
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
              <span className="hidden @md:inline">Stop</span>
            </button>
          ) : null}
          <button
            ref={endRef}
            type="button"
            aria-label="Stop voice chat"
            title="End voice chat"
            onClick={() => voice.toggle()}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-[#1a1a1a] px-3.5 text-sm pointer-coarse:h-11 font-medium text-white transition hover:bg-[#333] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] focus-visible:ring-offset-2"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            End
          </button>
        </div>
      </div>
    </div>
  );
}
