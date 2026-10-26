"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { useChat } from "./chat-context";
import type { MinkMessage, MinkRevealTarget } from "./mink-ai";

// ---------------------------------------------------------------------------
// ★★ A LONG CHAT'S EARLIER MESSAGES, AND THE MESSAGE A SEARCH RESULT OPENS
// ONTO (review finding R6). A chat opens at its newest 50 messages; every one
// of them is kept and searchable for 90 days, so the rest are a button away.
// Rendered as the first child of the thread's scroller (dashboard-chat.tsx);
// message rendering itself is left alone.
//   - "Show earlier messages" adds the page above without moving what the
//     merchant is reading: the distance from the bottom is restored.
//   - A search result's match is scrolled into view once the chat renders,
//     after the thread's own scroll (one frame), so two frames later. Only
//     the merchant's rows carry `data-mink-message-id`, so an answer is
//     reached through the question of its run.
// ---------------------------------------------------------------------------

export function MinkEarlierMessages() {
  const {
    messages,
    hasEarlierMessages = false,
    earlierStatus = EARLIER_IDLE,
    loadEarlierMessages,
    revealTarget = null,
    clearRevealTarget,
  } = useChat();
  const anchorRef = useRef<HTMLDivElement>(null);
  // Where the merchant was, measured from the bottom, while a page loads.
  const keepPlace = useRef<{
    fromBottom: number;
    firstId: MinkMessage["id"] | undefined;
  } | null>(null);

  const scroller = () =>
    anchorRef.current?.closest<HTMLElement>(".mink-message-scroll") ?? null;

  const showEarlier = () => {
    const element = scroller();
    keepPlace.current = element
      ? {
          fromBottom: element.scrollHeight - element.scrollTop,
          firstId: messages[0]?.id,
        }
      : null;
    void loadEarlierMessages?.();
  };

  // ★ Restored only when the page really went in above (the old first
  //   message is still there, no longer first): another chat, or a failed
  //   page, leaves the scroll alone.
  useLayoutEffect(() => {
    const kept = keepPlace.current;
    const element = anchorRef.current?.closest<HTMLElement>(
      ".mink-message-scroll",
    );
    if (!kept || !element) return;
    const first = messages[0]?.id;
    if (first === kept.firstId) return;
    keepPlace.current = null;
    if (messages.some((message) => message.id === kept.firstId))
      element.scrollTop = element.scrollHeight - kept.fromBottom;
  }, [messages]);

  useEffect(() => {
    if (earlierStatus.error) keepPlace.current = null;
  }, [earlierStatus.error]);

  useEffect(() => {
    if (!revealTarget) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        const element = anchorRef.current?.closest<HTMLElement>(
          ".mink-message-scroll",
        );
        if (element) revealRow(element, revealTarget, messages);
        clearRevealTarget?.();
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [revealTarget, messages, clearRevealTarget]);

  return (
    <div ref={anchorRef}>
      {hasEarlierMessages || earlierStatus.error ? (
        <div className="mx-auto mb-4 flex w-full max-w-3xl flex-col items-center gap-1.5">
          {earlierStatus.error ? (
            <p
              role="alert"
              className="text-center text-xs leading-5 text-[#8a1c13]"
            >
              Couldn&apos;t load earlier messages.{" "}
              <button
                type="button"
                onClick={showEarlier}
                className="font-semibold underline underline-offset-2"
              >
                Try again
              </button>
            </p>
          ) : (
            <button
              type="button"
              onClick={showEarlier}
              disabled={earlierStatus.loading}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e5e5] bg-white px-3 py-1.5 text-xs font-medium text-[#5c5f62] shadow-sm transition-colors hover:bg-[#f9f9f9] disabled:opacity-60"
            >
              {earlierStatus.loading && (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              )}
              Show earlier messages
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

const EARLIER_IDLE = { loading: false, error: null };

/**
 * Scrolls the row of the revealed message into the middle of the thread: a
 * question by its own id, an answer by the question of the same run.
 */
function revealRow(
  scroller: HTMLElement,
  target: MinkRevealTarget,
  messages: readonly MinkMessage[],
) {
  const rowId =
    target.role === "user"
      ? target.messageId
      : messages.find(
          (message) =>
            message.role === "user" &&
            target.runId !== null &&
            message.runId === target.runId,
        )?.id;
  if (rowId === undefined) return;
  for (const row of scroller.querySelectorAll<HTMLElement>(
    "[data-mink-message-id]",
  )) {
    if (row.dataset.minkMessageId === String(rowId)) {
      row.scrollIntoView?.({ block: "center" });
      return;
    }
  }
}
