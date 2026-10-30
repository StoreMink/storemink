"use client";
import Link from "next/link";

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  FileText,
  LoaderCircle,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
} from "react";
import { usePathname } from "next/navigation";
import { useChat, useMinkVoice } from "./chat-context";
import { MinkAnswer } from "./mink-answer";
import { suggestMinkFollowUps } from "@/lib/mink/follow-ups";
import { MEMORY_KIND_LABELS } from "@/lib/mink/memory-suggestion";
import { MinkLink } from "./mink-link";
import type { MinkMemoryPrompt } from "./mink-ai";
import {
  matchMinkSkills,
  minkSlashQuery,
  minkStarterSkills,
  type MinkSkill,
} from "@/lib/mink/skills";
import {
  ASSISTANT_NAME,
  type MinkConversationSummary,
  type MinkMessage,
  type MinkPendingAttachment,
  type MinkPreparedSend,
  type MinkRunStep,
} from "./mink-ai";
import { MinkMark } from "./mink-mark";
import { MinkEarlierMessages } from "./mink-earlier-messages";
import { MinkHistorySidebar } from "./mink-history-sidebar";
import { MinkMultimodalInput } from "./mink-multimodal-input";
import { MinkVoiceBar } from "./mink-voice-view";
import { MinkArtifacts } from "./mink-artifacts";
import { MinkFeedbackControls } from "./mink-feedback";
import { readMinkCsvReference } from "@/lib/mink/csv-input";
import { readReviewedMinkDocument } from "@/lib/mink/document-input";
import { readSavedMinkMediaReference } from "@/lib/mink/media-attachment";
import {
  minkAttachmentIdOf,
  minkAttachmentUrl,
} from "@/lib/mink/attachment-ref";
import { MINK_MESSAGE_MAX_CHARS } from "@/lib/mink/input-policy";
import { MINK_NEW_CHAT_TITLE } from "@/lib/mink/chat-session";
import { BrandMark } from "@/app/platform/brand-mark";
import { MINK_MAX_RUN_CREDITS } from "@/lib/mink/metering";
import type { MinkCreditSummary } from "./chat-context";

const PANEL_WIDTH_KEY = "storemink:mink-panel-width";
const DEFAULT_PANEL_WIDTH = 380;
const MAX_PANEL_WIDTH = 720;
const MAX_COMPOSER_HEIGHT = 160;
const HISTORY_SIDEBAR_BREAKPOINT = 768;

export function clampMinkPanelWidth(width: number, viewportWidth: number) {
  const safeViewport = Math.max(280, viewportWidth);
  const min = Math.min(320, Math.floor(safeViewport * 0.92));
  const max =
    safeViewport < 1200
      ? Math.floor(safeViewport * 0.92)
      : Math.min(MAX_PANEL_WIDTH, Math.floor(safeViewport * 0.62));
  return Math.min(Math.max(Math.round(width), min), Math.max(min, max));
}

export function minkComposerHeight(scrollHeight: number) {
  return Math.min(Math.max(Math.ceil(scrollHeight), 24), MAX_COMPOSER_HEIGHT);
}

export function minkHistoryStartsOpen(viewportWidth: number) {
  return viewportWidth >= HISTORY_SIDEBAR_BREAKPOINT;
}

export function isMinkScrollNearBottom(input: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  threshold?: number;
}) {
  const distance = input.scrollHeight - input.scrollTop - input.clientHeight;
  return distance <= (input.threshold ?? 56);
}

export function latestMinkUserMessageId(
  messages: Array<{ id: number | string; role: "user" | "assistant" }>,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.id;
  }
  return null;
}

const NO_REVAMPS: ReadonlySet<string> = new Set();

/**
 * For each message, the storefront redesigns whose card an earlier message
 * in the thread already shows; that message points back to the card instead
 * of showing a second one (MinkArtifacts). ★ One redesign can reach a thread
 * twice: the answer that started it, and a later start or refine answered
 * with the same card because it is still being made. A set is shared until a
 * message adds to it, so a long thread costs one set per redesign.
 */
export function revampIdsShownBefore(
  messages: ReadonlyArray<Pick<MinkMessage, "artifacts">>,
): ReadonlySet<string>[] {
  const shownBefore: ReadonlySet<string>[] = [];
  let shown = NO_REVAMPS;
  for (const message of messages) {
    shownBefore.push(shown);
    for (const artifact of message.artifacts ?? []) {
      if (artifact.type !== "storefront_revamp") continue;
      if (!shown.has(artifact.revampId))
        shown = new Set([...shown, artifact.revampId]);
    }
  }
  return shownBefore;
}

/** How much of the viewport the anchored question is allowed to keep. */
export const MINK_TURN_ANCHOR_RESERVE_REM = 5;

/**
 * The temporary tail room under a newly submitted question, IN PIXELS.
 *
 * ★★ PIXELS, BECAUSE THE PERCENTAGE RESOLVED TO NOTHING. This was written as
 * `min-height: calc(100% - 5rem)`, and the spacer's containing block is the
 * message column — a plain block whose height is its own content. A percentage
 * min-height against an indefinite containing-block height behaves as `auto`,
 * which is 0 for a block box (CSS Sizing 3; CSS 2.1 §10.7). So the reserved
 * space the anchor depends on never existed: `scrollIntoView({block:"start"})`
 * just clamped at the end of the content, and a question submitted into a short
 * conversation stayed wherever it was — the exact case the reservation is for
 * ("the browser cannot place a newly submitted question at the top while only
 * the Thinking row exists"). The SCROLLER has a definite height, because it is
 * a flex child with `min-h-0 flex-1`, so measuring that is what makes the
 * reservation real.
 *
 * ⚠ A TEST MUST STUB `clientHeight`: jsdom reports 0 for every element, so it
 * yields "0px" there. Asserting the old `calc()` string proved only that a
 * string had been written to the attribute, never that any space resulted.
 */
export function minkTurnAnchorSpace(input: {
  viewportHeight: number;
  reservePx: number;
}) {
  const space = Math.round(input.viewportHeight - input.reservePx);
  return `${Math.max(0, space)}px`;
}

/** `rem` is only meaningful against the root font size, so read it. */
function rootFontSizePx() {
  const size = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(size) && size > 0 ? size : 16;
}

export function shouldSubmitMinkComposer(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}) {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}

/**
 * ★★ A LINK THE MERCHANT FOLLOWS LEAVES THE FULL VIEW, as a navigation
 * artifact does. MinkLink keeps the click client-side so the chat survives
 * it, but the full view covers the whole dashboard, so the page opened
 * BEHIND the takeover and a merchant clicking an order reference saw nothing
 * change and read the link as broken. Only a plain left click on a
 * same-origin `/dashboard` link counts: a new-tab or modified click, a
 * download, and a link to the storefront or Help leave the chat as it is.
 */
export function isMinkInAppLinkClick(
  event: {
    target: EventTarget | null;
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  origin: string,
) {
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest("a[href]");
  if (!anchor) return false;
  const opensIn = anchor.getAttribute("target");
  if (opensIn && opensIn !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  let url: URL;
  try {
    url = new URL(anchor.getAttribute("href") ?? "", origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  return (
    url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")
  );
}

// Two surfaces, one conversation (state lives in ChatProvider):
//  - "panel"   → the resizable right sheet opened from the topbar
//  - "overlay" → the full-view takeover opened from Home/maximize
export function DashboardChat({
  variant = "panel",
}: {
  variant?: "panel" | "overlay";
}) {
  const {
    isChatOpen,
    isExpanded,
    canSaveMedia,
    skills = [],
    closeChat,
    toggleExpand,
    messages,
    activeConversationId,
    activeConversationTitle,
    input,
    setInput,
    isReplying,
    stopRefused = false,
    isHistoryLoading,
    deletingConversationId,
    statusText,
    streamingText = "",
    steps = [],
    error,
    feedbackSubmittingRunId,
    minkCredits,
    send,
    sendPrepared,
    cancel,
    retry,
    startNewChat,
    addressOpens,
    loadConversation,
    deleteConversation,
    conversations,
    refreshConversations,
    submitFeedback,
    memoryPrompt,
    saveMemorySuggestion,
    dismissMemorySuggestion,
  } = useChat();
  // The spoken conversation, run by ChatProvider. While it is on, the thread
  // stays on screen (cards included) and the voice bar takes the composer's
  // place; the composer stays mounted but hidden (unmounting it would discard
  // staged attachments).
  const voiceChat = useMinkVoice();
  const isOverlay = variant === "overlay";
  const pathname = usePathname();
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const latestUserMessageIdRef = useRef<number | string | null>(null);
  const anchoredUserMessageIdRef = useRef<number | string | null>(null);
  const autoAnchorSubmissionRef = useRef(true);
  const turnAnchorSpaceRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // A dictated transcript can arrive while the empty box is hidden behind the
  // recorder, so focusing it inside onAdd misses; this retries after the
  // render that shows it again.
  const focusComposerAfterAdd = useRef(false);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] =
    useState<MinkConversationSummary | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  // The "/" skills menu: which match is highlighted, and the query the
  // merchant dismissed with Escape (so the menu stays shut until they type).
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const slashQuery = minkSlashQuery(input);
  const slashMatches =
    slashQuery !== null && slashDismissed !== input
      ? matchMinkSkills(skills, slashQuery).slice(0, 8)
      : [];
  const slashOpen = slashMatches.length > 0;

  // The page the merchant is about to look at sits behind the chat: the
  // full-view takeover collapses to the side panel and a phone-width panel
  // closes.
  //
  // ★★ ONLY WHEN THEY CLICK A LINK. A page Mink finds is a link card in its
  // answer (mink-artifacts, NavigationArtifact) and never opens by itself:
  // the panel used to navigate as soon as such an answer arrived, which on a
  // phone also shut the chat, so the merchant was taken to a page they had
  // only asked about, mid-conversation.
  const leaveForPage = useCallback(() => {
    if (window.innerWidth < 640) closeChat();
    else if (isExpanded) toggleExpand();
  }, [closeChat, isExpanded, toggleExpand]);

  // Capture phase: MinkLink's own click handler (next/link) cancels the
  // browser default on the way back up, so a bubbling listener cannot tell a
  // followed link from one that did nothing.
  const leaveForLinkedPage = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isMinkInAppLinkClick(event, window.location.origin)) leaveForPage();
  };

  useEffect(() => {
    if (!isOverlay || !isChatOpen || !isExpanded) return;
    // The desktop takeover benefits from persistent history beside the thread.
    // On a phone that same 288px column left the conversation a ~100px sliver,
    // so compact takeovers start with history closed and expose it on demand.
    const frame = window.requestAnimationFrame(() => {
      const shouldOpen = minkHistoryStartsOpen(window.innerWidth);
      setHistoryOpen((open) => (open === shouldOpen ? open : shouldOpen));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isChatOpen, isExpanded, isOverlay]);

  useEffect(() => {
    if (isOverlay) return;
    const resize = () =>
      setPanelWidth((width) => clampMinkPanelWidth(width, window.innerWidth));
    const restoreFrame = window.requestAnimationFrame(() => {
      try {
        const stored = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
        if (Number.isFinite(stored) && stored > 0) {
          setPanelWidth(clampMinkPanelWidth(stored, window.innerWidth));
        } else {
          resize();
        }
      } catch {
        resize();
      }
    });
    window.addEventListener("resize", resize);
    return () => {
      window.cancelAnimationFrame(restoreFrame);
      window.removeEventListener("resize", resize);
    };
  }, [isOverlay]);

  useEffect(() => {
    if (isOverlay) return;
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      // A private browser may disable storage; resizing still works in-session.
    }
  }, [isOverlay, panelWidth]);

  /**
   * A chat opened whole (chosen in History, opened from the address, a new
   * one, or shown in a new scroller) starts at its newest message and follows
   * new output. The caller hides the jump button too, at once or in a frame
   * (`setShowJumpToLatest(false)`).
   */
  const followNewestMessage = useCallback(() => {
    followLatestRef.current = true;
    latestUserMessageIdRef.current = null;
    anchoredUserMessageIdRef.current = null;
    if (turnAnchorSpaceRef.current) {
      turnAnchorSpaceRef.current.style.minHeight = "0px";
    }
  }, []);

  // ★★ A chat opened from the address (`?chat=`, robustness audit B20: the
  // "redesign ready" notice) opens as one chosen in History does. A view
  // keeps its scroll-follow state while it is closed, so a view last left
  // scrolled up opened the named chat at its top, the card it was opened for
  // out of sight below. A view the address opens gets a new scroller, which
  // the scroll effect also resets; this reset is what moves a view that was
  // already open, whose scroller stays. ★ Declared before the scroll effect:
  // when the count and the loaded chat land in one render, the reset comes
  // first. The button waits for a frame, as state set in an effect body would
  // cascade.
  const seenAddressOpens = useRef(addressOpens);
  useEffect(() => {
    if (seenAddressOpens.current === addressOpens) return;
    seenAddressOpens.current = addressOpens;
    followNewestMessage();
    const frame = window.requestAnimationFrame(() =>
      setShowJumpToLatest(false),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [addressOpens, followNewestMessage]);

  // ★★ A NEW SCROLLER STARTS AT THE NEWEST MESSAGE. The thread's scroller is
  // a new element each time the chat appears: the panel opened again, the
  // switch between the side panel and the full view (two instances, each with
  // its own scroller), or a chat's first message. A new element starts at its
  // top, and this effect ran only when the chat changed, so opening the panel
  // over a chat in memory showed its oldest messages. A mount now counts as a
  // chat opened whole, as one chosen in History. A reply still running loses
  // nothing: its question is still the newest one, so it is anchored at the
  // top again, tail room included. `isChatOpen` and `isExpanded` are in the
  // dependencies for the mount alone.
  const seenScrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (scroller !== seenScrollerRef.current) {
      seenScrollerRef.current = scroller;
      followNewestMessage();
    }
    const latestUserId = latestMinkUserMessageId(messages);
    const receivedNewUserMessage =
      latestUserId !== null && latestUserId !== latestUserMessageIdRef.current;
    latestUserMessageIdRef.current = latestUserId;

    if (isReplying && receivedNewUserMessage) {
      followLatestRef.current = false;
      autoAnchorSubmissionRef.current = true;
      anchoredUserMessageIdRef.current = latestUserId;
      if (turnAnchorSpaceRef.current) {
        turnAnchorSpaceRef.current.style.minHeight = minkTurnAnchorSpace({
          viewportHeight: scroller.clientHeight,
          reservePx: MINK_TURN_ANCHOR_RESERVE_REM * rootFontSizePx(),
        });
      }
    }

    const frame = window.requestAnimationFrame(() => {
      const anchoredUserMessageId = anchoredUserMessageIdRef.current;
      if (anchoredUserMessageId !== null) {
        if (autoAnchorSubmissionRef.current) {
          const userRows = scroller.querySelectorAll<HTMLElement>(
            '[data-mink-message-role="user"]',
          );
          const latestUserRow = userRows.item(userRows.length - 1);
          if (
            latestUserRow?.dataset.minkMessageId ===
            String(anchoredUserMessageId)
          ) {
            latestUserRow.scrollIntoView?.({
              block: "start",
              behavior: "smooth",
            });
          }
        }
        // Keep one viewport of temporary tail room until the completed answer
        // has been positioned. Without it the browser cannot place a newly
        // submitted question at the top while only the Thinking row exists.
        if (!isReplying) {
          anchoredUserMessageIdRef.current = null;
          if (turnAnchorSpaceRef.current) {
            turnAnchorSpaceRef.current.style.minHeight = "0px";
          }
        }
        setShowJumpToLatest(!isMinkScrollNearBottom(scroller));
        return;
      }
      if (followLatestRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
        setShowJumpToLatest(false);
      } else {
        setShowJumpToLatest(!isMinkScrollNearBottom(scroller));
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    messages,
    isReplying,
    error,
    statusText,
    isChatOpen,
    isExpanded,
    followNewestMessage,
  ]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    const height = minkComposerHeight(composer.scrollHeight);
    composer.style.height = `${height}px`;
    composer.style.overflowY =
      composer.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
  }, [historyOpen, input, isOverlay, panelWidth]);

  useEffect(() => {
    if (!deleteTarget) return;
    deleteButtonRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !deletingConversationId) {
        setDeleteTarget(null);
        setDeleteFailure(null);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [deleteTarget, deletingConversationId]);

  const updateWidth = useCallback((width: number) => {
    setPanelWidth(clampMinkPanelWidth(width, window.innerWidth));
  }, []);

  const sendFromChat = useCallback(
    (raw?: string) => {
      // A new turn belongs at the top of the reading viewport. The completed
      // answer may be much taller than the panel, so chasing its bottom would
      // make the reader lose the question and the beginning of Mink's answer.
      followLatestRef.current = false;
      autoAnchorSubmissionRef.current = true;
      send(raw);
    },
    [send],
  );

  // The same anchoring for a message whose attachments Mink reads in the chat.
  const sendPreparedFromChat = useCallback(
    (prepared: MinkPreparedSend) => {
      followLatestRef.current = false;
      autoAnchorSubmissionRef.current = true;
      return sendPrepared(prepared);
    },
    [sendPrepared],
  );

  /** New chat, from the header or the History sidebar. */
  const startFreshChat = useCallback(() => {
    followNewestMessage();
    setShowJumpToLatest(false);
    startNewChat();
  }, [followNewestMessage, startNewChat]);

  // ★ R14: after a choice the sidebar closes wherever it covers the chat: the
  // side panel always, and the full view on a phone, where it used to stay
  // open over the chat just chosen. On a wide full view it stays beside it.
  const closeHistoryAfterChoice = useCallback(() => {
    if (!isOverlay || !minkHistoryStartsOpen(window.innerWidth))
      setHistoryOpen(false);
  }, [isOverlay]);

  // ★ R17: stable, so History's memoised rows are not rendered again while
  // an answer streams.
  const chooseConversation = useCallback(
    (
      conversation: MinkConversationSummary,
      options: { revealMessageId?: string },
    ) => {
      // ★ Every chat chosen opens at its newest message. A search result's
      // match, once loaded, is scrolled to two frames after the thread's own
      // scroll (mink-earlier-messages.tsx), so it wins; one too far back to
      // load opens here rather than where the last chat was left.
      followNewestMessage();
      setShowJumpToLatest(false);
      void (options.revealMessageId
        ? loadConversation(conversation.id, {
            revealMessageId: options.revealMessageId,
          })
        : loadConversation(conversation.id));
      closeHistoryAfterChoice();
    },
    [followNewestMessage, loadConversation, closeHistoryAfterChoice],
  );

  const newConversationFromHistory = useCallback(() => {
    startFreshChat();
    closeHistoryAfterChoice();
  }, [startFreshChat, closeHistoryAfterChoice]);

  // ★ A row's redesign flag is as old as the list it came in: a redesign card
  // that became ready after History's first page was last read would get the
  // plain sentence, although the delete takes that card with it. So History's
  // first page is read again as the dialog opens, and the dialog reads the
  // flag from the chat's row as History now has it (`deleteRow`).
  const askToDelete = useCallback(
    (conversation: MinkConversationSummary) => {
      setDeleteFailure(null);
      setDeleteTarget(conversation);
      void refreshConversations();
    },
    [setDeleteFailure, setDeleteTarget, refreshConversations],
  );
  const deleteRow = deleteTarget
    ? (conversations.find((row) => row.id === deleteTarget.id) ?? deleteTarget)
    : null;

  const chooseSkill = useCallback(
    (skill: MinkSkill) => {
      setInput(skill.prompt);
      setSlashDismissed(null);
      setSlashIndex(0);
      composerRef.current?.focus();
    },
    [setInput, setSlashDismissed, setSlashIndex],
  );

  const jumpToLatest = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    followLatestRef.current = true;
    autoAnchorSubmissionRef.current = false;
    anchoredUserMessageIdRef.current = null;
    if (turnAnchorSpaceRef.current) {
      turnAnchorSpaceRef.current.style.minHeight = "0px";
    }
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    setShowJumpToLatest(false);
  }, []);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    updateWidth(resize.startWidth + resize.startX - event.clientX);
  };

  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      updateWidth(panelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      updateWidth(panelWidth - step);
    }
  };

  useEffect(() => {
    if (!focusComposerAfterAdd.current) return;
    focusComposerAfterAdd.current = false;
    composerRef.current?.focus();
  }, [input]);

  // A redesign's card shows once in the thread; later mentions point to it.
  const revampsShownBefore = useMemo(
    () => revampIdsShownBefore(messages),
    [messages],
  );

  if (!isChatOpen) return null;
  if (isOverlay !== isExpanded) return null;

  // ★ Stop ASKS the server (`useMinkAi().cancel`), and is not offered once it
  // refused: the run had already started something, so a Stop that cannot
  // stop it is worse than none. The status line says why.
  const stopReply = (
    <button
      type="button"
      onClick={() => void cancel()}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] text-white"
      aria-label="Stop Mink AI"
    >
      <Square className="h-4 w-4 fill-current" />
    </button>
  );
  // A photo or a file on its own is a message too, as in ChatGPT and Claude.
  // `waiting`: a reply Stop could not stop is finishing; the next message
  // goes once it has.
  const sendButton = (hasAttachments: boolean, waiting = false) => (
    <button
      type="submit"
      disabled={
        waiting || (!input.trim() && !hasAttachments) || isHistoryLoading
      }
      className="flex h-9 w-9 items-center justify-center rounded-full bg-[#6d4dff] text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
      aria-label="Send message"
    >
      <ArrowUp className="h-4 w-4" />
    </button>
  );

  const hasThread = messages.length > 0 || isReplying || Boolean(error);
  const creditWarning = minkCredits ? minkCreditWarning(minkCredits) : null;
  const starterSkills = minkStarterSkills(skills, pathname);
  const latestAssistantIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") return index;
    }
    return -1;
  })();
  const wrapperClass = isOverlay
    ? "mink-chat-surface fixed inset-0 z-[90] flex h-[100dvh] w-screen max-w-full min-h-0 flex-col overflow-hidden overscroll-none bg-white"
    : "mink-chat-surface dash-chat relative flex h-full flex-shrink-0 flex-col overflow-hidden overscroll-none border-l border-t border-[#e5e5e5] bg-white shadow-sm";
  const columnClass = isOverlay ? "mx-auto w-full max-w-3xl" : "w-full";
  const panelStyle = isOverlay
    ? undefined
    : ({ "--mink-chat-width": `${panelWidth}px` } as CSSProperties);

  return (
    <div
      data-testid="mink-chat-surface"
      className={wrapperClass}
      style={panelStyle}
      onClickCapture={leaveForLinkedPage}
    >
      {!isOverlay && (
        <div
          role="separator"
          aria-label="Resize Mink AI panel"
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuemax={MAX_PANEL_WIDTH}
          aria-valuenow={panelWidth}
          tabIndex={0}
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onKeyDown={resizeWithKeyboard}
          className="mink-chat-resizer group absolute inset-y-0 left-0 z-30 hidden w-2 -translate-x-1/2 touch-none cursor-col-resize outline-none sm:block"
        >
          <span className="absolute inset-y-0 left-1/2 w-px bg-transparent transition-colors group-hover:bg-[#7f4afa]" />
        </div>
      )}

      <header className="flex min-h-[64px] w-full max-w-full shrink-0 items-center justify-between gap-3 border-b border-[#ededed] px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {!voiceChat.enabled && (
            <button
              type="button"
              onClick={() => setHistoryOpen((open) => !open)}
              aria-label={
                historyOpen
                  ? "Hide conversation sidebar"
                  : "Show conversation sidebar"
              }
              aria-expanded={historyOpen}
              className="rounded-lg p-2 text-[#5c5f62] transition-colors hover:bg-[#f1f1f1] hover:text-[#1a1a1a]"
            >
              {historyOpen ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeftOpen className="h-4 w-4" />
              )}
            </button>
          )}
          <MinkMark />
          {/* ★ ONE LINE, NOT TWO. The purple ASSISTANT_NAME wordmark sat above
              the title saying what the avatar beside it and the topbar button
              that opened this panel both already say — and in a ~380px panel
              the width it took is why the conversation title truncated to
              "whic…". The title is the only part of this block that carries
              information the merchant does not already have. */}
          <span className="min-w-0 truncate text-sm font-semibold text-[#1a1a1a]">
            {activeConversationTitle ?? MINK_NEW_CHAT_TITLE}
          </span>
          {isHistoryLoading && (
            <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-[#8c9196]" />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 text-[#5c5f62]">
          {!voiceChat.enabled && (
            <button
              type="button"
              onClick={startFreshChat}
              disabled={isReplying || !hasThread}
              className="rounded-md p-1.5 transition-colors hover:bg-[#f1f1f1] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              aria-label="New chat"
              title={
                isReplying
                  ? "Wait for Mink to finish, or stop it, to start a new chat"
                  : "New chat"
              }
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
          )}
          <MinkHeaderMenu onNavigate={closeChat} />
          <button
            type="button"
            onClick={toggleExpand}
            className="hidden rounded-md p-1.5 transition-colors hover:bg-[#f1f1f1] sm:inline-flex"
            aria-label={
              isOverlay ? "Collapse to side panel" : "Expand to full view"
            }
          >
            {isOverlay ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={closeChat}
            className="rounded-md p-1.5 transition-colors hover:bg-[#f1f1f1]"
            aria-label="Close chat"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {historyOpen && !voiceChat.enabled && (
          <MinkHistorySidebar
            isOverlay={isOverlay}
            onNewConversation={newConversationFromHistory}
            onSelect={chooseConversation}
            onDelete={askToDelete}
          />
        )}

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
          {!hasThread ? (
            <div className="flex min-h-0 flex-1 touch-pan-y flex-col items-center justify-center overflow-y-auto overscroll-contain p-6 text-center">
              <div className="mb-4">
                <MinkMark size="lg" />
              </div>
              <h2 className="mb-1 text-lg font-semibold text-[#1a1a1a]">
                Hey there
              </h2>
              <h3 className="mb-6 text-xl font-bold text-[#1a1a1a]">
                I&apos;m {ASSISTANT_NAME}. How can I help?
              </h3>
              {starterSkills.length > 0 ? (
                <div
                  className="flex max-w-md flex-wrap justify-center gap-2"
                  aria-label="Suggested prompts"
                >
                  {starterSkills.map((skill) => (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => sendFromChat(skill.prompt)}
                      title={skill.description}
                      className="flex items-center gap-2 rounded-full border border-[#e5e5e5] px-4 py-2 text-sm font-medium text-[#1a1a1a] shadow-sm transition-colors hover:bg-[#f9f9f9]"
                    >
                      <div className="h-2 w-2 rounded-full bg-[#6d4dff]" />
                      {skill.label}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => sendFromChat("What's new?")}
                  className="flex items-center gap-2 rounded-full border border-[#e5e5e5] px-4 py-2 text-sm font-medium text-[#1a1a1a] shadow-sm transition-colors hover:bg-[#f9f9f9]"
                >
                  <div className="h-2 w-2 rounded-full bg-[#6d4dff]" />
                  What&apos;s new?
                </button>
              )}
              {skills.length > 0 ? (
                <p className="mt-4 text-[11px] text-[#8c9196]">
                  Type <span className="font-semibold">/</span> in the box for
                  saved prompts.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="relative min-h-0 flex-1">
              <div
                ref={scrollRef}
                data-testid="mink-message-scroller"
                onScroll={() => {
                  const scroller = scrollRef.current;
                  if (!scroller) return;
                  const nearBottom = isMinkScrollNearBottom(scroller);
                  followLatestRef.current = nearBottom;
                  setShowJumpToLatest(!nearBottom);
                }}
                onPointerDown={() => {
                  autoAnchorSubmissionRef.current = false;
                }}
                onTouchStart={() => {
                  autoAnchorSubmissionRef.current = false;
                }}
                onWheel={() => {
                  autoAnchorSubmissionRef.current = false;
                }}
                className="mink-message-scroll h-full min-h-0 touch-pan-y overflow-y-auto overscroll-contain px-4 py-4"
              >
                <MinkEarlierMessages />
                <div className={`${columnClass} space-y-6`}>
                  {messages.map((message, index) =>
                    message.role === "user" ? (
                      <div
                        key={message.id}
                        data-mink-message-id={String(message.id)}
                        data-mink-message-role="user"
                        className="flex scroll-mt-4 justify-end"
                      >
                        <MinkUserMessage
                          text={message.text}
                          pending={message.pendingAttachments}
                          localPreviews={message.localPreviews}
                        />
                      </div>
                    ) : (
                      /* ★ NO PER-MESSAGE ATTRIBUTION. The avatar and the name
                         were stamped on every answer, which in a two-party
                         conversation repeats what the layout already says: the
                         merchant's turns are right-aligned in a lavender
                         bubble and Mink's are not. Dropping them also gives an
                         answer the full column width, which the artifact cards
                         need more than a label does. */
                      <div
                        key={message.id}
                        className="mink-answer-row flex min-w-0 py-1"
                      >
                        <div className="min-w-0 flex-1">
                          <MinkCheckedLine steps={message.toolSteps} />
                          <div className="pr-1">
                            <MinkAnswer text={message.text} />
                          </div>
                          <MinkArtifacts
                            artifacts={message.artifacts ?? []}
                            onPrompt={sendFromChat}
                            promptDisabled={isReplying || isHistoryLoading}
                            shownRevampIds={revampsShownBefore[index]}
                          />
                          {index === latestAssistantIndex &&
                          !isReplying &&
                          !error ? (
                            <MinkFollowUps
                              message={message}
                              disabled={isHistoryLoading}
                              onPrompt={sendFromChat}
                            />
                          ) : null}
                          {index === latestAssistantIndex &&
                          !isReplying &&
                          memoryPrompt ? (
                            <MinkMemoryPromptCard
                              prompt={memoryPrompt}
                              onSave={() => void saveMemorySuggestion()}
                              onDismiss={dismissMemorySuggestion}
                            />
                          ) : null}
                          <MinkFeedbackControls
                            message={message}
                            submitting={
                              feedbackSubmittingRunId === message.runId
                            }
                            submit={submitFeedback}
                          />
                        </div>
                      </div>
                    ),
                  )}

                  {isReplying && (
                    <div
                      className="mink-answer-row flex min-w-0 py-1"
                      // The whole pending row is one polite live region, so a
                      // screen reader hears the answer as it streams and the
                      // status beneath it; a second live region nested inside
                      // would announce the status twice.
                      aria-live="polite"
                      data-testid="mink-pending-answer"
                    >
                      <div className="min-w-0 flex-1">
                        <MinkRunSteps steps={steps} />
                        {streamingText ? (
                          <div className="pr-1">
                            <MinkAnswer text={streamingText} />
                          </div>
                        ) : null}
                        <div className="flex items-center gap-2.5 py-2 text-sm text-[#5c5f62]">
                          <MinkMark size="sm" />
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#6d4dff]" />
                          {statusText ?? "Thinking…"}
                        </div>
                      </div>
                    </div>
                  )}

                  {error && (
                    <div className="flex gap-2.5" role="alert">
                      <MinkMark size="sm" />
                      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-[#fff4f4] px-3.5 py-2.5 text-sm text-[#5c1b14]">
                        <div>{error.message}</div>
                        {error.retryable !== false && (
                          <button
                            type="button"
                            onClick={() => {
                              followLatestRef.current = true;
                              retry();
                            }}
                            className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#6d4dff] hover:underline"
                          >
                            <RotateCcw className="h-3 w-3" />
                            Retry
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <div
                    ref={turnAnchorSpaceRef}
                    aria-hidden="true"
                    data-testid="mink-turn-anchor-space"
                    className="shrink-0"
                    style={{ minHeight: 0 }}
                  />
                </div>
              </div>
              {showJumpToLatest && (
                <button
                  type="button"
                  aria-label="Jump to latest message"
                  title="Jump to latest"
                  onClick={jumpToLatest}
                  className="absolute bottom-4 left-1/2 z-20 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-[#d9d9d9] bg-white text-[#303030] shadow-md transition hover:bg-[#f7f7f7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff]"
                >
                  <ArrowDown className="h-5 w-5" aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {voiceChat.enabled ? (
            <MinkVoiceBar
              voice={voiceChat}
              isReplying={isReplying}
              stopRefused={stopRefused}
              onStopReply={() => void cancel()}
              columnClass={columnClass}
            />
          ) : null}
          <div
            hidden={voiceChat.enabled}
            className="mink-composer-footer shrink-0 border-t border-[#f1f1f1] p-3 sm:p-4"
          >
            <div className={columnClass}>
              {voiceChat.notice ? (
                <div
                  role="alert"
                  className="mb-2 rounded-xl border border-[#f2ddb4] bg-[#fdf9ef] px-3 py-2 text-[11px] text-[#8a5a12]"
                >
                  {voiceChat.notice}
                </div>
              ) : null}
              {creditWarning ? (
                <div
                  role="status"
                  className={`mb-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] ${
                    creditWarning.level === "empty"
                      ? "border-[#f3c2c2] bg-[#fdf3f3] text-[#a62828]"
                      : "border-[#f2ddb4] bg-[#fdf9ef] text-[#8a5a12]"
                  }`}
                >
                  <AlertTriangle
                    className="mt-px h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{creditWarning.message}</span>
                </div>
              ) : null}
              <MinkMultimodalInput
                key={`multimodal:${activeConversationId ?? "new"}`}
                message={input}
                onAdd={(value) => {
                  setInput(value);
                  focusComposerAfterAdd.current = true;
                  composerRef.current?.focus();
                }}
                disabled={isReplying || isHistoryLoading}
                canSaveMedia={canSaveMedia}
                onSubmit={sendFromChat}
                onSubmitPrepared={sendPreparedFromChat}
              >
                {({
                  attach,
                  attachment,
                  voice,
                  submit,
                  recorder,
                  recording,
                  hasAttachments,
                }) => (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submit();
                    }}
                    className="flex w-full min-w-0 max-w-full flex-col gap-2 rounded-3xl border border-[#e5e5e5] bg-white px-3 py-3 shadow-sm transition-all focus-within:border-[#6d4dff] focus-within:ring-1 focus-within:ring-[#6d4dff]"
                  >
                    {attachment}
                    {slashOpen ? (
                      <div
                        role="listbox"
                        aria-label="Saved prompts"
                        className="max-h-56 overflow-y-auto rounded-2xl border border-[#e9e6f3] bg-[#fcfbff] p-1"
                      >
                        {slashMatches.map((skill, index) => {
                          const selected = index === slashIndex;
                          return (
                            <button
                              key={skill.id}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              onMouseEnter={() => setSlashIndex(index)}
                              onClick={() => chooseSkill(skill)}
                              className={`flex w-full items-baseline gap-2 rounded-xl px-3 py-2 text-left ${
                                selected ? "bg-[#eee9ff]" : "hover:bg-[#f3f0fb]"
                              }`}
                            >
                              <span className="shrink-0 text-xs font-semibold text-[#5b3fd0]">
                                /{skill.slash}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-medium text-[#1a1a1a]">
                                  {skill.label}
                                </span>
                                <span className="block truncate text-[10px] text-[#8c9196]">
                                  {skill.description}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    <textarea
                      ref={composerRef}
                      rows={1}
                      maxLength={MINK_MESSAGE_MAX_CHARS}
                      value={input}
                      onChange={(event) => {
                        setSlashDismissed(null);
                        setSlashIndex(0);
                        setInput(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (slashOpen) {
                          if (event.key === "ArrowDown") {
                            event.preventDefault();
                            setSlashIndex(
                              (current) => (current + 1) % slashMatches.length,
                            );
                            return;
                          }
                          if (event.key === "ArrowUp") {
                            event.preventDefault();
                            setSlashIndex(
                              (current) =>
                                (current - 1 + slashMatches.length) %
                                slashMatches.length,
                            );
                            return;
                          }
                          if (
                            (event.key === "Enter" && !event.shiftKey) ||
                            event.key === "Tab"
                          ) {
                            event.preventDefault();
                            const skill =
                              slashMatches[slashIndex] ?? slashMatches[0];
                            if (skill) chooseSkill(skill);
                            return;
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setSlashDismissed(input);
                            return;
                          }
                        }
                        if (
                          !shouldSubmitMinkComposer({
                            key: event.key,
                            shiftKey: event.shiftKey,
                            isComposing: event.nativeEvent.isComposing,
                          })
                        ) {
                          return;
                        }
                        event.preventDefault();
                        if (
                          (input.trim() || hasAttachments) &&
                          !isHistoryLoading &&
                          !isReplying
                        ) {
                          void submit();
                        }
                      }}
                      placeholder="Ask anything..."
                      aria-label={`Message ${ASSISTANT_NAME}`}
                      // ★ THESE FOUR SHAPE THE PHONE KEYBOARD, and without them iOS
                      // guesses. A field inside a <form> with no autocomplete hint
                      // gets the AUTOFILL accessory bar — passwords, cards,
                      // addresses — above the keys instead of QuickType word
                      // suggestions: useless for a chat, and the reason the composer
                      // reads as unfinished next to a native messaging app.
                      //
                      // `enterKeyHint` is honest rather than decorative. A phone has
                      // no Shift, so shouldSubmitMinkComposer means Return ALWAYS
                      // sends here, and the key should say so instead of showing a
                      // generic newline arrow.
                      enterKeyHint="send"
                      autoComplete="off"
                      autoCapitalize="sentences"
                      autoCorrect="on"
                      className={`min-h-6 max-h-40 w-full min-w-0 resize-none border-none bg-transparent px-2 py-0.5 text-base leading-6 text-[#1a1a1a] outline-none placeholder:text-[#71757a] ${
                        recording === "dictation" && !input ? "hidden" : ""
                      }`}
                    />
                    {recording ? (
                      <div className="flex w-full min-w-0 items-center gap-2">
                        {recorder}
                      </div>
                    ) : (
                      <div className="flex w-full items-center justify-between">
                        {attach}
                        <div className="flex items-center gap-2">
                          {voice}
                          {isReplying
                            ? stopRefused
                              ? sendButton(hasAttachments, true)
                              : stopReply
                            : sendButton(hasAttachments)}
                        </div>
                      </div>
                    )}
                  </form>
                )}
              </MinkMultimodalInput>
              <div className="relative mt-2 flex min-h-6 items-center justify-center px-1">
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#8c9196]">
                  Powered by <BrandMark size={13} /> StoreMink
                </span>
                <div className="absolute right-1 top-0">
                  <MinkCreditIndicator summary={minkCredits} />
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>

      {deleteTarget && (
        <div
          className="absolute inset-0 z-[70] flex items-center justify-center bg-black/30 p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="mink-delete-title"
          aria-describedby="mink-delete-description"
        >
          <div className="w-full max-w-sm rounded-2xl border border-[#dedede] bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#fff1f0] text-[#b42318]">
                <Trash2 className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2
                  id="mink-delete-title"
                  className="text-base font-semibold text-[#1a1a1a]"
                >
                  Delete conversation?
                </h2>
                <p
                  id="mink-delete-description"
                  className="mt-1 text-sm leading-5 text-[#5c5f62]"
                >
                  {deleteRow?.hasRedesignCard
                    ? `“${deleteTarget.title}” and its messages will be permanently deleted, along with its storefront redesign card, so you can no longer apply or undo that redesign from Mink AI. Changes you approved or published from this chat stay in your store.`
                    : `“${deleteTarget.title}” and its messages will be permanently deleted. Changes you approved or published from this chat stay in your store.`}
                </p>
                {deleteFailure && (
                  <p
                    role="alert"
                    className="mt-2 rounded-lg bg-[#fff4f4] px-2.5 py-2 text-xs leading-5 text-[#8a1c13]"
                  >
                    {deleteFailure}
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteFailure(null);
                }}
                disabled={Boolean(deletingConversationId)}
                className="rounded-lg border border-[#dedede] px-3 py-2 text-sm font-medium text-[#1a1a1a] hover:bg-[#f6f6f7] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                ref={deleteButtonRef}
                type="button"
                disabled={Boolean(deletingConversationId)}
                onClick={async () => {
                  setDeleteFailure(null);
                  const failure = await deleteConversation(deleteTarget.id);
                  if (!failure) {
                    setDeleteTarget(null);
                  } else {
                    setDeleteFailure(failure.message);
                  }
                }}
                className="inline-flex min-w-[76px] items-center justify-center gap-1.5 rounded-lg bg-[#b42318] px-3 py-2 text-sm font-semibold text-white hover:bg-[#912018] disabled:opacity-60"
              >
                {deletingConversationId === deleteTarget.id && (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                )}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Memories and Watches, behind one control.
 *
 * ★★ THEY WERE TWO TEXT LINKS IN A ~380px HEADER, competing for width with the
 * conversation title — which is why the title rendered as "whic…". They are
 * destinations a merchant visits occasionally, not controls they use while
 * reading an answer, so they belong behind an overflow the way Shopify's
 * Sidekick puts its equivalents behind one icon. Nothing moved further away
 * than one extra click.
 *
 * ★ Same popover mechanics as MinkCreditIndicator below — pointerdown outside
 * and Escape both close it — rather than a second, differently-behaving menu.
 */
function MinkHeaderMenu({ onNavigate }: { onNavigate: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const item =
    "block rounded-md px-3 py-2 text-left text-xs text-[#1a1a1a] hover:bg-[#f4f4f4]";
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Mink options"
        aria-expanded={open}
        title="Mink options"
        onClick={() => setOpen((value) => !value)}
        className="rounded-md p-1.5 transition-colors hover:bg-[#f1f1f1]"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-30 w-44 rounded-xl border border-[#e5e5e5] bg-white p-1 shadow-lg"
        >
          <Link
            href="/dashboard/mink-memories"
            role="menuitem"
            onNavigate={() => {
              setOpen(false);
              onNavigate();
            }}
            className={item}
          >
            Memories
          </Link>
          <Link
            href="/dashboard/mink-watches"
            role="menuitem"
            onNavigate={() => {
              setOpen(false);
              onNavigate();
            }}
            className={item}
          >
            Watches
          </Link>
        </div>
      )}
    </div>
  );
}

function MinkCreditIndicator({
  summary,
}: {
  summary: MinkCreditSummary | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const state = summary ? minkCreditIndicatorState(summary) : null;
  const includedLeft = state?.includedLeft ?? null;
  const totalLeft = state?.totalLeft ?? null;
  const fraction = state?.fraction ?? 0;
  const color = state?.color ?? "#dc2626";
  const circumference = 2 * Math.PI * 8;

  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!summary) return null;
  const label =
    totalLeft === null
      ? "Unlimited Mink credits"
      : `${totalLeft} Mink credit${totalLeft === 1 ? "" : "s"} left`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 w-6 items-center justify-center rounded-full transition hover:bg-[#f2f2f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff]"
      >
        <svg
          viewBox="0 0 20 20"
          className="h-5 w-5 -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke="#e5e7eb"
            strokeWidth="3"
          />
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
          />
        </svg>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Mink credit balance"
          className="absolute bottom-8 right-0 z-50 w-64 rounded-xl border border-[#dedede] bg-white p-3 text-left shadow-xl"
        >
          <p className="text-sm font-semibold text-[#1a1a1a]">Mink credits</p>
          <p className="mt-1 text-2xl font-bold text-[#1a1a1a]">
            {totalLeft === null ? "Unlimited" : totalLeft}
          </p>
          {totalLeft !== null && (
            <p className="text-xs text-[#6b7280]">
              {includedLeft} included + {summary.creditBalance} top-up remaining
            </p>
          )}
          <p className="mt-2 border-t border-[#ededed] pt-2 text-xs text-[#6b7280]">
            Included credits reset{" "}
            {new Date(summary.resetsAt).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
            .
          </p>
          <Link
            href="/dashboard/plans"
            onNavigate={() => setOpen(false)}
            className="mt-2 inline-flex text-xs font-semibold text-[#6d4dff] hover:underline"
          >
            View credits and usage
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * The composer's low-balance warning, or null when there is nothing to say.
 *
 * ★★ MEASURED IN CREDITS, NOT IN A PERCENTAGE, and that is the whole reason it
 * is not just the ring's colour. "Can I afford my next request" is an ABSOLUTE
 * question: the heaviest run costs `MINK_MAX_RUN_CREDITS` whoever is asking,
 * so a Pro store on 15 of 300 and a Free store on 15 of 20 are in the same
 * practical position — two more big requests each. The ring goes amber at 20%,
 * which is 60 credits on Pro (not low at all) and 4 on Free (nearly out), so a
 * fraction is the wrong unit for a warning even though it is a fine one for a
 * gradient.
 *
 * ★ IT IS WORDS, NOT A COLOUR. The ring is 20 pixels and shows its number only
 * on hover or click, so "nearly out of credits" was information a merchant
 * could only find by going to look for it — and the first real signal was the
 * request being refused.
 *
 * ★ TWO LEVELS, because they need different actions. At zero the next request
 * is refused outright and the only way forward is to buy or upgrade; above it
 * the merchant can still work but should know a large request may take the
 * rest. ⚠ `minkRunAffordability` deliberately allows a run whenever anything
 * is left and lets settlement clamp, so 1-7 credits is NOT blocked — saying so
 * would be a lie the server contradicts a second later.
 *
 * ⚠ An unmetered plan (`cap === null`) warns about nothing. It is also what a
 * FAILED usage read looks like, which is exactly why `readMinkCredits` refuses
 * to store an unavailable summary — see MinkCreditSummary.
 */
export function minkCreditWarning(
  summary: MinkCreditSummary,
): { level: "empty" | "low"; message: string } | null {
  const { totalLeft } = minkCreditIndicatorState(summary);
  if (totalLeft === null) return null;
  if (totalLeft <= 0)
    return {
      level: "empty",
      message:
        "You have no Mink credits left. Buy more under Plans & Billing, or upgrade the plan, to keep using Mink.",
    };
  if (totalLeft < MINK_MAX_RUN_CREDITS)
    return {
      level: "low",
      message: `Only ${totalLeft} Mink credit${totalLeft === 1 ? "" : "s"} left. Top up under Plans & Billing to keep using Mink.`,
    };
  return null;
}

export function minkCreditIndicatorState(summary: MinkCreditSummary) {
  const includedLeft =
    summary.cap === null ? null : Math.max(0, summary.cap - summary.used);
  const totalLeft =
    includedLeft === null ? null : includedLeft + summary.creditBalance;
  const fraction =
    summary.cap === null
      ? 1
      : Math.min(1, (totalLeft ?? 0) / Math.max(summary.cap, 1));
  return {
    includedLeft,
    totalLeft,
    fraction,
    color: fraction > 0.5 ? "#16a34a" : fraction > 0.2 ? "#f59e0b" : "#dc2626",
  };
}

/**
 * The tools a run has called so far, one line each, while it is still
 * working. Sidekick shows the same "Reading orders" ladder; without it a
 * twelve-second run is a single pulsing dot and nothing says what is taking
 * the time.
 */
export function MinkRunSteps({ steps }: { steps: MinkRunStep[] }) {
  if (steps.length === 0) return null;
  const current =
    [...steps].reverse().find((step) => step.state === "running") ??
    steps[steps.length - 1];
  const previous = steps.filter((step) => step.sequence !== current.sequence);
  const stepLine = (step: MinkRunStep) => (
    <span className="flex items-start gap-2">
      {step.state === "running" ? (
        <LoaderCircle
          className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin text-[#6d4dff] motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : step.state === "failed" ? (
        <AlertTriangle
          className="mt-1 h-3.5 w-3.5 shrink-0 text-[#b45309]"
          aria-hidden="true"
        />
      ) : (
        <Check
          className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-700"
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 break-words">{step.status}</span>
    </span>
  );
  return (
    <div
      aria-label="What Mink AI is doing"
      className="mb-3 space-y-1 text-sm text-[#5c5f62]"
    >
      {stepLine(current)}
      {previous.length > 0 && (
        <details className="mink-progress-details">
          <summary className="cursor-pointer py-2 text-xs font-medium text-[#67616f] focus-visible:outline-[#6d4dff]">
            {previous.length} earlier {previous.length === 1 ? "step" : "steps"}
            {previous.some((step) => step.state === "failed")
              ? " · Includes an issue"
              : ""}
          </summary>
          <ol className="space-y-2 border-l border-[#e5e5e5] py-1 pl-3">
            {previous.map((step) => (
              <li key={step.sequence}>{stepLine(step)}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** "Checked sales, orders and products", above an answer that read them. */
export function minkCheckedLine(
  steps: MinkRunStep[] | undefined,
): string | null {
  if (!steps?.length) return null;
  const labels: string[] = [];
  for (const step of steps) {
    if (step.state !== "completed") continue;
    const label = step.label.replace(/^(the|a|an|your|this) /, "");
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length === 0) return null;
  const shown = labels.slice(0, 4);
  const rest = labels.length - shown.length;
  const joined =
    shown.length === 1
      ? shown[0]
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return `Checked ${joined}${rest > 0 ? ` and ${rest} more` : ""}`;
}

function MinkCheckedLine({ steps }: { steps?: MinkRunStep[] }) {
  const line = minkCheckedLine(steps);
  if (!line) return null;
  return (
    <p className="mb-1 flex items-center gap-1 text-[11px] text-[#8c9196]">
      <Check className="h-3 w-3" aria-hidden="true" />
      {line}
    </p>
  );
}

/** Up to three next questions under the newest answer. */
function MinkFollowUps({
  message,
  disabled,
  onPrompt,
}: {
  message: {
    text: string;
    artifacts?: Parameters<typeof suggestMinkFollowUps>[0]["artifacts"];
  };
  disabled: boolean;
  onPrompt: (prompt: string) => void;
}) {
  const prompts = suggestMinkFollowUps(message);
  if (prompts.length === 0) return null;
  return (
    <div
      className="mt-2 flex flex-wrap gap-1.5"
      aria-label="Suggested follow-ups"
    >
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          disabled={disabled}
          onClick={() => onPrompt(prompt)}
          className="rounded-full border border-[#e5e5e5] bg-white px-3 py-1 text-[11px] font-medium text-[#3e3262] transition-colors hover:border-[#cfc4ff] hover:bg-[#fbfaff] disabled:opacity-50"
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}

/**
 * "Remember this?": the lasting sentence of the merchant's own message,
 * saved with one tap through the ordinary memories API (90 days). The card
 * shows the exact text that will be kept, because a memory the merchant did
 * not read is one they cannot trust later.
 */
function MinkMemoryPromptCard({
  prompt,
  onSave,
  onDismiss,
}: {
  prompt: MinkMemoryPrompt;
  onSave: () => void;
  onDismiss: () => void;
}) {
  const { suggestion, status, error } = prompt;
  return (
    <div
      data-testid="mink-memory-prompt"
      role="group"
      aria-label="Remember this?"
      className="mt-2 rounded-xl border border-[#ddd6f5] bg-[#f8f5ff] px-3 py-2 text-[12px] text-[#3e3262]"
    >
      {status === "saved" ? (
        <p className="flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
          Saved to your memories.
          <MinkLink
            href="/dashboard/mink-memories"
            className="font-semibold text-[#5b3fd0] underline-offset-2 hover:underline"
          >
            Manage memories
          </MinkLink>
        </p>
      ) : (
        <>
          <p className="flex items-center gap-1.5 font-semibold text-[#2d2350]">
            <Sparkles
              className="h-3.5 w-3.5 text-[#5b3fd0]"
              aria-hidden="true"
            />
            Remember this?
          </p>
          <p className="mt-1">{suggestion.content}</p>
          <p className="mt-1 text-[11px] text-[#6f6a8a]">
            {MEMORY_KIND_LABELS[suggestion.kind]} · kept for 90 days, only for
            you, only in this store
          </p>
          {status === "failed" && error ? (
            <p role="alert" className="mt-1 text-[11px] text-[#b4232c]">
              {error}
            </p>
          ) : null}
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={onSave}
              disabled={status === "saving"}
              className="rounded-lg bg-[#6d4dff] px-3 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === "saving"
                ? "Saving…"
                : status === "failed"
                  ? "Try again"
                  : "Save"}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              disabled={status === "saving"}
              className="rounded-lg border border-[#ddd6f5] bg-white px-3 py-1 text-[11px] font-semibold text-[#5b3fd0] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The merchant's own message. ★ A message that is still being read carries
 * its attachments as `pending` (the photo they picked, from this tab), so it
 * shows in full the moment they press Enter, the way ChatGPT and Claude show
 * a sent photo, instead of waiting in the composer under a spinner. Once read,
 * the finished text's file references take over, and `localPreviews` keeps the
 * same picture on screen rather than reloading it from storage.
 */
function MinkUserMessage({
  text,
  pending,
  localPreviews,
}: {
  text: string;
  pending?: MinkPendingAttachment[];
  localPreviews?: Record<string, string>;
}) {
  const [viewingImage, setViewingImage] = useState<{
    filename: string;
    src: string;
  } | null>(null);
  // Pictures whose load failed (a chat attachment already purged, or one the
  // viewer may no longer read): the tile keeps its place and the file name
  // and says so, instead of a broken image.
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markUnavailable = (src: string) =>
    setUnavailable((current) =>
      current.has(src) ? current : new Set(current).add(src),
    );
  let visibleText = text;
  const attachments: Array<
    | { kind: "media"; filename: string; src: string }
    | { kind: "reference"; filename: string; sourceKind: string }
  > = [];

  if (pending?.length) {
    for (const item of pending) {
      if (item.previewUrl)
        attachments.push({
          kind: "media",
          filename: item.name,
          src: item.previewUrl,
        });
      else
        attachments.push({
          kind: "reference",
          filename: item.name,
          sourceKind: item.kind === "image" ? "Image" : "Document",
        });
    }
  } else {
    while (true) {
      const csv = readMinkCsvReference(visibleText);
      if (csv) {
        visibleText = csv.message;
        attachments.unshift({
          kind: "reference",
          filename: csv.file.filename,
          sourceKind: "Product CSV",
        });
        continue;
      }
      const document = readReviewedMinkDocument(visibleText);
      if (document) {
        visibleText = document.message;
        const filename = document.attachment.filename || "Reviewed reference";
        const local =
          document.attachment.kind === "image"
            ? localPreviews?.[`file:${document.attachment.filename}`]
            : undefined;
        attachments.unshift(
          local
            ? { kind: "media", filename, src: local }
            : {
                kind: "reference",
                filename,
                sourceKind:
                  document.attachment.kind === "image" ? "Image" : "Document",
              },
        );
        continue;
      }
      const media = readSavedMinkMediaReference(visibleText);
      if (media) {
        visibleText = media.message;
        const local = localPreviews?.[`url:${media.asset.url}`];
        // ★ A picture kept privately with the chat is read from its own
        //   route on this origin (which answers only the person who attached
        //   it); a Media Library URL from before the change still goes
        //   through the proxy.
        const attachmentId = minkAttachmentIdOf(media.asset.url);
        const src =
          local ??
          (attachmentId
            ? minkAttachmentUrl(attachmentId)
            : isRenderableMinkMediaUrl(media.asset.url)
              ? `/api/og-image?url=${encodeURIComponent(media.asset.url)}`
              : "");
        attachments.unshift({
          kind: "media",
          filename: media.asset.filename,
          src,
        });
        continue;
      }
      break;
    }
  }
  const imageNames = new Set(
    attachments
      .filter((attachment) => attachment.kind === "media")
      .map((attachment) => attachment.filename),
  );
  const renderedAttachments = attachments.filter(
    (attachment) =>
      attachment.kind === "media" ||
      attachment.sourceKind !== "Image" ||
      !imageNames.has(attachment.filename),
  );

  return (
    <>
      <div className="max-w-[85%] space-y-2 rounded-2xl rounded-br-sm bg-[#f4f0ff] px-3.5 py-2.5 text-[15px] leading-6 text-[#1a1a1a]">
        {renderedAttachments.length > 0 && (
          <div
            className="flex flex-wrap gap-2"
            aria-label="Message attachments"
          >
            {renderedAttachments.map((attachment, index) =>
              attachment.kind === "media" ? (
                <div
                  key={`${attachment.filename}:${index}`}
                  className="min-w-0 overflow-hidden rounded-xl border border-black/10 bg-white/80"
                >
                  {attachment.src && unavailable.has(attachment.src) ? (
                    <p className="flex h-28 w-44 max-w-full items-center justify-center px-3 text-center text-xs text-[#777]">
                      {MINK_IMAGE_UNAVAILABLE}
                    </p>
                  ) : attachment.src ? (
                    <button
                      type="button"
                      aria-label={`View ${attachment.filename || "attached image"}`}
                      className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6d4dff]"
                      onClick={() => setViewingImage(attachment)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={attachment.src}
                        alt={attachment.filename || "Attached storefront image"}
                        className="h-28 w-44 max-w-full object-cover"
                        onError={() => markUnavailable(attachment.src)}
                      />
                    </button>
                  ) : null}
                  <div className="max-w-44 truncate px-2.5 py-2 text-xs font-medium">
                    {attachment.filename || "Storefront image"}
                  </div>
                </div>
              ) : (
                <div
                  key={`${attachment.filename}:${index}`}
                  className="flex max-w-full items-center gap-2 rounded-xl border border-black/10 bg-white/80 px-3 py-2"
                >
                  <FileText
                    className="h-5 w-5 shrink-0 text-[#6d4dff]"
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">
                      {attachment.filename}
                    </span>
                    <span className="block text-[10px] text-[#777]">
                      {attachment.sourceKind}
                    </span>
                  </span>
                </div>
              ),
            )}
          </div>
        )}
        {visibleText && (
          <div className="whitespace-pre-wrap break-words">{visibleText}</div>
        )}
      </div>
      {viewingImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Attachment preview: ${viewingImage.filename}`}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setViewingImage(null)}
        >
          <div
            className="relative max-h-[90dvh] max-w-5xl overflow-auto rounded-2xl bg-white p-3 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close attachment preview"
              className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/65 text-white"
              onClick={() => setViewingImage(null)}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
            {unavailable.has(viewingImage.src) ? (
              <div className="flex min-h-52 min-w-64 flex-col items-center justify-center gap-2 rounded-xl bg-[#f6f4fb] p-8 text-center">
                <p className="text-sm font-medium text-[#252525]">
                  {MINK_IMAGE_UNAVAILABLE}
                </p>
                <p className="max-w-sm break-all text-xs text-[#777]">
                  {viewingImage.filename || "Attached image"}
                </p>
              </div>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={viewingImage.src}
                alt={viewingImage.filename || "Attached image"}
                className="max-h-[82dvh] max-w-full rounded-xl object-contain"
                onError={() => markUnavailable(viewingImage.src)}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** What a tile and the viewer say in place of a picture that failed to load. */
const MINK_IMAGE_UNAVAILABLE = "This image is no longer available.";

function isRenderableMinkMediaUrl(value: string) {
  // A chat attachment's own address (`/api/mink/attachments/{id}`, with or
  // without a host) is read from its route, which answers only the person
  // who attached it, so it is rendered directly and never through the proxy.
  if (minkAttachmentIdOf(value)) return true;
  // Otherwise the browser fetches only our same-origin proxy. Its server-side
  // bucket pin rejects a hand-authored marker pointing at someone else's GCS
  // object.
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "storage.googleapis.com" ||
        url.hostname.endsWith(".storage.googleapis.com"))
    );
  } catch {
    return false;
  }
}
