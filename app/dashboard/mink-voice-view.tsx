"use client";

import { useEffect, useRef } from "react";
import { Mic, MicOff, Square, X } from "lucide-react";
import { MinkMark } from "./mink-mark";
import { MinkWaveform } from "./mink-waveform";
import type { MinkVoiceMode } from "./mink-voice-mode";

/**
 * What voice chat is doing, in the merchant's words. Transcription is
 * distinct from waiting for the answer.
 */
export function minkVoiceStatus(
  voice: Pick<MinkVoiceMode, "state" | "mic"> &
    Partial<Pick<MinkVoiceMode, "muted">>,
): string {
  switch (voice.state) {
    case "speaking":
      return "Speaking…";
    case "waiting":
      return "Thinking…";
    case "sending":
      return "Sending…";
    case "listening":
      if (voice.muted) return "Microphone muted";
      if (voice.mic === "starting") return "Starting microphone…";
      if (voice.mic === "transcribing") return "Transcribing…";
      return "Listening…";
    default:
      return "";
  }
}

/**
 * The expandable caption: what Mink is saying right now (its spoken words
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
  stopRefused = false,
  onStopReply,
  columnClass = "",
}: {
  voice: MinkVoiceMode;
  /** Mink is still producing the written answer. */
  isReplying: boolean;
  /**
   * The server refused a Stop: the reply finishes, so Stop is not offered
   * (the thread's status line says why), as in the composer.
   */
  stopRefused?: boolean;
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
      className="mink-composer-footer shrink-0 border-t border-[#f1f1f1] p-3 sm:p-4"
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
        <div className="rounded-3xl border border-[#e5e5e5] bg-white p-3 shadow-sm">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 basis-32 items-center gap-2">
              <MinkMark size="sm" />
              <div className="min-w-0 flex-1">
                <p
                  role="status"
                  aria-live="polite"
                  className="text-sm font-semibold text-[#5b3fd0]"
                >
                  {status}
                </p>
                <p className="mt-0.5 text-xs text-[#65616c]">
                  {voice.muted
                    ? "Mic off · Replies stay on"
                    : speaking
                      ? "You can interrupt by speaking"
                      : "Voice conversation"}
                </p>
              </div>
            </div>
            <div className="hidden w-16 shrink-0 @lg:block">
              <MinkWaveform
                levelRef={voice.levelRef}
                live={voice.mic === "open" && !voice.muted}
                className="w-full text-[#6d4dff]"
              />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={voice.toggleMute}
                aria-label={
                  voice.muted ? "Unmute microphone" : "Mute microphone"
                }
                aria-pressed={voice.muted}
                title={voice.muted ? "Unmute microphone" : "Mute microphone"}
                className={`inline-flex h-11 w-11 items-center justify-center rounded-full border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] ${voice.muted ? "border-[#dfd3ff] bg-[#f4efff] text-[#5b3fd0]" : "border-[#e5e5e5] text-[#454149] hover:bg-[#f6f6f6]"}`}
              >
                {voice.muted ? (
                  <MicOff className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <Mic className="h-5 w-5" aria-hidden="true" />
                )}
              </button>
              {isReplying && !stopRefused ? (
                <button
                  type="button"
                  onClick={onStopReply}
                  aria-label="Stop Mink AI"
                  title="Stop Mink AI"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-[#e5e5e5] text-[#1a1a1a] hover:bg-[#f6f6f6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff]"
                >
                  <Square className="h-4 w-4 fill-current" aria-hidden="true" />
                </button>
              ) : null}
              <button
                ref={endRef}
                type="button"
                aria-label="Stop voice chat"
                title="End voice chat"
                onClick={() => voice.toggle()}
                className="inline-flex h-11 items-center gap-1.5 rounded-full bg-[#1a1a1a] px-3 text-sm font-medium text-white hover:bg-[#333] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] focus-visible:ring-offset-2"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                End
              </button>
            </div>
          </div>
          {caption ? (
            <details className="mt-2 border-t border-[#eeebf2] pt-1">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs text-[#65616c] focus-visible:outline-[#6d4dff]">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold">{caption.who}:</span>{" "}
                  {caption.text}
                </span>
                <span className="shrink-0 font-medium text-[#5b3fd0]">
                  Captions
                </span>
              </summary>
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words pb-2 text-sm leading-6 text-[#343038]">
                {caption.text}
              </p>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
