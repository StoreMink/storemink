"use client";

import Image from "next/image";
import Link from "next/link";
import { STOREMINK_MARK } from "@/lib/brand-assets";
import {
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  AudioLines,
  BookOpen,
  Check,
  ChevronDown,
  Globe,
  History,
  Maximize2,
  Mic,
  Minimize2,
  Search,
  SquarePen,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  askHelpAssistant,
  type HelpAssistantAnswer,
  type HelpAssistantTurn,
} from "@/app/actions/help-assistant-actions";
import { rateHelpAnswer } from "@/app/actions/help-assistant-feedback-actions";
import {
  HELP_ASSISTANT_MAX_MESSAGE_LENGTH,
  helpAssistantQuestionError,
  normalizeHelpAssistantQuestion,
} from "@/lib/help/assistant-input";
import {
  HELP_LANGUAGES,
  helpLanguage,
  isHelpLanguageCode,
  type HelpLanguageCode,
} from "@/lib/help/languages";
import { MinkFace, type MinkFaceState } from "@/components/mink/mink-face";
import { formatMinkClock, MinkWaveform } from "@/app/dashboard/mink-waveform";
import {
  useHelpDictation,
  useHelpReadAloud,
  useHelpTalk,
  useHelpVoiceSupport,
  type HelpTalkReply,
} from "./help-voice";
import { OPEN_HELP_MINK_EVENT, readOpenHelpMinkDetail } from "./mink-launch";
import { MinkAnswer } from "./mink-answer";
import { MinkRecentList } from "./mink-recent";
import { minkIntro, minkStrings } from "./mink-strings";
import {
  deleteRecentChat,
  loadRecentChats,
  newMinkId,
  saveRecentChat,
  type HelpRating,
  type RecentChat,
  type StoredMessage,
} from "./recent-chats";

type UserMessage = {
  id: number;
  key: string;
  role: "user";
  content: string;
  /** Asked out loud in a voice chat. */
  spoken?: boolean;
};

type AssistantMessage = {
  id: number;
  key: string;
  role: "assistant";
  content: string;
  answer?: HelpAssistantAnswer;
  rating?: HelpRating;
};

type ChatMessage = UserMessage | AssistantMessage;

type ScrollTarget = { kind: "end" } | { kind: "message"; messageId: number };

const DRAWER_MIN_WIDTH = 360;
const DRAWER_MAX_WIDTH = 760;
const DRAWER_DEFAULT_WIDTH = 480;
const DRAWER_PAGE_FLOOR = 280;
const DRAWER_WIDTH_STORAGE_KEY = "sm-help-mink-width";
const LANGUAGE_STORAGE_KEY = "sm-help-mink-language";
/** How long the face smiles after an answer lands. */
const DONE_FLASH_MS = 1_800;

function assistantHistoryText(answer: HelpAssistantAnswer): string {
  return [
    answer.answer,
    answer.steps.length
      ? `Steps: ${answer.steps.map((step, index) => `${index + 1}. ${step}`).join(" ")}`
      : "",
    answer.notes.length ? `Important: ${answer.notes.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1_200);
}

/** The whole answer as plain text, for Copy, Listen and a rating. */
function answerText(
  message: AssistantMessage,
  important = "Important",
): string {
  const answer = message.answer;
  if (!answer) return message.content;
  return [
    answer.answer,
    ...answer.steps.map((step, index) => `${index + 1}. ${step}`),
    ...(answer.notes.length ? [`${important}: ${answer.notes.join(" ")}`] : []),
  ].join("\n");
}

function clampWidth(value: number, maximum: number) {
  return Math.min(Math.max(value, DRAWER_MIN_WIDTH), maximum);
}

function viewportDrawerMaximum() {
  if (typeof window === "undefined") return DRAWER_MAX_WIDTH;
  return Math.max(
    DRAWER_MIN_WIDTH,
    Math.min(DRAWER_MAX_WIDTH, window.innerWidth - DRAWER_PAGE_FLOOR),
  );
}

function persistDrawerWidth(value: number) {
  try {
    localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(value));
  } catch {
    // Storage can be disabled; resizing should continue for the current visit.
  }
}

function readStoredLanguage(): HelpLanguageCode | null {
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isHelpLanguageCode(value) ? value : null;
  } catch {
    return null;
  }
}

function storeLanguage(code: HelpLanguageCode) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    // The choice still holds for this visit.
  }
}

function toStored(messages: ChatMessage[]): StoredMessage[] {
  return messages.map((message) =>
    message.role === "user"
      ? {
          key: message.key,
          role: "user",
          content: message.content,
          ...(message.spoken ? { spoken: true } : {}),
        }
      : {
          key: message.key,
          role: "assistant",
          content: message.content,
          ...(message.answer ? { answer: message.answer } : {}),
          ...(message.rating ? { rating: message.rating } : {}),
        },
  );
}

export function HelpAssistant({
  voiceEnabled = false,
}: {
  /** The platform allows voice (Mink AI is switched on); read on the server. */
  voiceEnabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The conversation, without the opening message (minkIntro), which only
  // ever goes into the history a question is sent with.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_DEFAULT_WIDTH);
  const [drawerMaximum, setDrawerMaximum] = useState(DRAWER_MAX_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const [justAnswered, setJustAnswered] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [thankedId, setThankedId] = useState<number | null>(null);
  const [language, setLanguage] = useState<HelpLanguageCode | null>(null);
  const [recent, setRecent] = useState<RecentChat[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // The header's "Mink AI ▾" menu: recent chats, language, full window.
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const nextId = useRef(1);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // Read by the document's Escape handler, which is set up once per opening.
  const menuOpenRef = useRef(false);
  const chatIdRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollTargetRef = useRef<ScrollTarget | null>(null);
  const doneTimer = useRef<number | undefined>(undefined);
  const copyTimer = useRef<number | undefined>(undefined);
  const t = minkStrings(language);
  const speechLang = language ? helpLanguage(language).speech : null;
  const hasConversationContext = messages.some(
    (message) => message.role === "user",
  );
  const draftError = helpAssistantQuestionError(draft, {
    hasConversationContext,
  });

  const support = useHelpVoiceSupport();
  const canDictate = voiceEnabled && support.microphone;
  const canTalk = canDictate && support.speech;
  const canListen = support.speech;

  const dictation = useHelpDictation({
    onTranscript: (text) => {
      setError("");
      setDraft((current) =>
        current.trim() ? `${current.trimEnd()} ${text}` : text,
      );
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    onError: setError,
  });
  const readAloud = useHelpReadAloud();
  const talk = useHelpTalk({
    ask: (text) => sendMessage(text, { spoken: true }),
    phrases: t.phrases,
    speechLang,
  });

  const { cancel: cancelDictation } = dictation;
  const { stop: stopReading } = readAloud;
  const { stop: stopTalk, start: startTalkLoop } = talk;

  const closeAssistant = useCallback(() => {
    stopTalk();
    cancelDictation();
    stopReading();
    setIsResizing(false);
    setIsMaximized(false);
    setShowHistory(false);
    setMenuOpen(false);
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  }, [cancelDictation, stopReading, stopTalk]);

  useEffect(() => {
    menuOpenRef.current = menuOpen;
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const startTalk = useCallback(() => {
    cancelDictation();
    stopReading();
    setError("");
    setShowHistory(false);
    startTalkLoop();
  }, [cancelDictation, startTalkLoop, stopReading]);

  // ★★ THE DRAWER CANNOT RENDER WHERE THE LAUNCHER LIVES. The launcher sits in
  // `.hc-topbar`, which carries `backdrop-filter: blur(18px)` — and a
  // backdrop-filtered element becomes the CONTAINING BLOCK for every
  // `position: fixed` descendant, so the panel and its backdrop resolved
  // top/right/bottom against the 73px header rather than the viewport. Measured
  // live on help.storemink.com: the panel opened at 360x8px against the header's
  // bottom edge. Nothing reported an error — `open` was true, the focus trap
  // armed and the launcher said "Close" — there was simply nothing to see. It
  // also frees the drawer from the header's own `z-index: 20` stacking context.
  // `#hc-overlay-root` is a child of `.hc` (app/help/layout.tsx), so the panel
  // keeps its `--hc-*` tokens and font; `document.body` is the fallback for
  // callers that render the component without the Help layout.
  useEffect(() => {
    setOverlayHost(document.getElementById("hc-overlay-root") ?? document.body);
    setLanguage(readStoredLanguage());
  }, []);

  useEffect(() => {
    function syncWidth() {
      const maximum = viewportDrawerMaximum();
      setDrawerMaximum(maximum);
      setDrawerWidth((current) => clampWidth(current, maximum));
    }

    const maximum = viewportDrawerMaximum();
    setDrawerMaximum(maximum);
    try {
      const saved = Number(localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY));
      if (Number.isFinite(saved) && saved > 0) {
        setDrawerWidth(clampWidth(saved, maximum));
      } else {
        setDrawerWidth(clampWidth(DRAWER_DEFAULT_WIDTH, maximum));
      }
    } catch {
      setDrawerWidth(clampWidth(DRAWER_DEFAULT_WIDTH, maximum));
    }

    window.addEventListener("resize", syncWidth);
    return () => window.removeEventListener("resize", syncWidth);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(doneTimer.current);
      window.clearTimeout(copyTimer.current);
    },
    [],
  );

  // The recent chats are read each time the chat opens, so a chat saved in
  // another tab shows up.
  useEffect(() => {
    if (open) setRecent(loadRecentChats());
  }, [open]);

  // Saves the conversation to this browser after a question, an answer or a
  // rating; opening a saved chat does not move it to the top.
  useEffect(() => {
    if (!dirtyRef.current) return;
    const id = chatIdRef.current;
    if (!id || !messages.some((message) => message.role === "user")) return;
    dirtyRef.current = false;
    setRecent(
      saveRecentChat({
        id,
        title: "",
        updatedAt: Date.now(),
        language,
        messages: toStored(messages),
      }),
    );
  }, [language, messages]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        // The first Escape closes the header menu, not the whole chat.
        if (menuOpenRef.current) {
          setMenuOpen(false);
          menuButtonRef.current?.focus();
          return;
        }
        closeAssistant();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const candidates = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      // Controls a breakpoint hides (maximize on a phone, the back arrow on a
      // computer) have no boxes; without layout (tests) every one counts.
      const shown = candidates.filter(
        (element) => element.getClientRects().length > 0,
      );
      const focusable = shown.length > 0 ? shown : candidates;
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeAssistant, open]);

  useEffect(() => {
    // The welcome screen reads from its top; only a conversation opens at
    // its end.
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (!messagesRef.current?.querySelector("[data-message-id]")) return;
      endRef.current?.scrollIntoView?.({ block: "end" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || !scrollTargetRef.current) return;
    const target = scrollTargetRef.current;
    const frame = requestAnimationFrame(() => {
      if (target.kind === "end") {
        endRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
      } else {
        messagesRef.current
          ?.querySelector<HTMLElement>(
            `[data-message-id="${target.messageId}"]`,
          )
          ?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      }
      if (scrollTargetRef.current === target) scrollTargetRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, open, pending]);

  useEffect(() => {
    if (!open || !isMaximized) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMaximized, open]);

  useEffect(() => {
    if (!isResizing) return;
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function resize(event: PointerEvent) {
      setDrawerWidth(
        clampWidth(window.innerWidth - event.clientX, drawerMaximum),
      );
    }
    function finish(event: PointerEvent) {
      const width = clampWidth(
        window.innerWidth - event.clientX,
        drawerMaximum,
      );
      setDrawerWidth(width);
      persistDrawerWidth(width);
      setIsResizing(false);
    }
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
    };
  }, [drawerMaximum, isResizing]);

  function conversationHistory(): HelpAssistantTurn[] {
    const intro: HelpAssistantTurn = {
      role: "assistant",
      content: minkIntro(t),
    };
    const turns: HelpAssistantTurn[] = messages.map((message) => ({
      role: message.role,
      content:
        message.role === "assistant" && message.answer
          ? assistantHistoryText(message.answer)
          : message.content,
    }));
    return [intro, ...turns].slice(-8);
  }

  async function sendMessage(
    value: string = draft,
    options: { spoken?: boolean } = {},
  ): Promise<HelpTalkReply> {
    const content = normalizeHelpAssistantQuestion(value);
    const validationError = helpAssistantQuestionError(content, {
      hasConversationContext,
    });
    if (pending) return { error: t.stillAnswering };
    if (validationError) {
      if (!options.spoken) setError(validationError);
      return { error: validationError, unclear: true };
    }
    const history = conversationHistory();
    if (!chatIdRef.current) {
      chatIdRef.current = newMinkId();
      setChatId(chatIdRef.current);
    }
    const userMessage: UserMessage = {
      id: nextId.current++,
      key: newMinkId(),
      role: "user",
      content: content.slice(0, HELP_ASSISTANT_MAX_MESSAGE_LENGTH),
      spoken: options.spoken,
    };
    scrollTargetRef.current = { kind: "end" };
    dirtyRef.current = true;
    setShowHistory(false);
    setMessages((current) => [...current, userMessage]);
    if (!options.spoken) setDraft("");
    setError("");
    setPending(true);
    window.clearTimeout(doneTimer.current);
    setJustAnswered(false);
    try {
      const result = await askHelpAssistant({
        message: userMessage.content,
        history,
        ...(language ? { language } : {}),
      });
      if (!result.success) {
        setError(result.error);
        return { error: result.error };
      }
      const assistantMessage: AssistantMessage = {
        id: nextId.current++,
        key: newMinkId(),
        role: "assistant",
        content: result.data.answer,
        answer: result.data,
      };
      scrollTargetRef.current = {
        kind: "message",
        messageId: assistantMessage.id,
      };
      dirtyRef.current = true;
      setMessages((current) => [...current, assistantMessage]);
      setJustAnswered(true);
      doneTimer.current = window.setTimeout(
        () => setJustAnswered(false),
        DONE_FLASH_MS,
      );
      return { answer: result.data };
    } catch {
      setError(t.connectionError);
      return { error: t.connectionError };
    } finally {
      setPending(false);
    }
  }

  // Ask Mink from anywhere on a Help page (the hero, "Still need help?", the
  // header's Mink AI link, which opens the full view).
  const latestSend = useRef(sendMessage);
  useEffect(() => {
    latestSend.current = sendMessage;
  });
  useEffect(() => {
    function onOpen(event: Event) {
      const detail = readOpenHelpMinkDetail(event);
      setOpen(true);
      if (detail.expand) setIsMaximized(true);
      if (detail.mode === "talk" && canTalk) startTalk();
      else if (detail.question) void latestSend.current(detail.question);
    }
    window.addEventListener(OPEN_HELP_MINK_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_HELP_MINK_EVENT, onOpen);
  }, [canTalk, startTalk]);

  function stopVoice() {
    stopTalk();
    cancelDictation();
    stopReading();
  }

  function resetConversation() {
    stopVoice();
    scrollTargetRef.current = { kind: "end" };
    chatIdRef.current = null;
    setChatId(null);
    dirtyRef.current = false;
    setMessages([]);
    setDraft("");
    setError("");
    setJustAnswered(false);
    setThankedId(null);
    setShowHistory(false);
    setMenuOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function openRecentChat(chat: RecentChat) {
    stopVoice();
    chatIdRef.current = chat.id;
    setChatId(chat.id);
    dirtyRef.current = false;
    const restored = chat.messages.map((message) => ({
      ...message,
      id: nextId.current++,
    }));
    setMessages(restored);
    // Open at the last question, the way a chat app does, not at the bottom
    // of its answer.
    const lastQuestion = restored.findLast(
      (message) => message.role === "user",
    );
    scrollTargetRef.current = lastQuestion
      ? { kind: "message", messageId: lastQuestion.id }
      : { kind: "end" };
    setDraft("");
    setError("");
    setThankedId(null);
    setShowHistory(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function removeRecentChat(chat: RecentChat) {
    setRecent(deleteRecentChat(chat.id));
    if (chat.id === chatIdRef.current) resetConversation();
  }

  function chooseLanguage(value: string) {
    if (!isHelpLanguageCode(value)) return;
    stopVoice();
    setLanguage(value);
    storeLanguage(value);
  }

  async function copyAnswer(message: AssistantMessage) {
    try {
      await navigator.clipboard?.writeText(answerText(message, t.important));
      setCopiedId(message.id);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 1_800);
    } catch {
      setError(t.copyError);
    }
  }

  async function rateAnswer(message: AssistantMessage, choice: HelpRating) {
    const conversationId = chatIdRef.current;
    if (!conversationId) return;
    const previous = message.rating;
    const next = previous === choice ? null : choice;
    const index = messages.findIndex((item) => item.id === message.id);
    const question = messages
      .slice(0, Math.max(index, 0))
      .reverse()
      .find((item) => item.role === "user");
    const setRating = (rating: HelpRating | undefined) => {
      dirtyRef.current = true;
      setMessages((current) =>
        current.map((item) =>
          item.id === message.id && item.role === "assistant"
            ? { ...item, rating }
            : item,
        ),
      );
    };
    setRating(next ?? undefined);
    setThankedId(next ? message.id : null);
    try {
      const result = await rateHelpAnswer({
        conversationId,
        messageKey: message.key,
        rating: next,
        language,
        question: question?.content ?? "",
        answer: answerText(message, t.important),
        sources: (message.answer?.sources ?? []).map((source) => ({
          title: source.title,
          url: source.url,
          category: source.category,
        })),
      });
      if (!result.ok) {
        setRating(previous);
        setThankedId(null);
        setError(result.error || t.ratingError);
      }
    } catch {
      setRating(previous);
      setThankedId(null);
      setError(t.ratingError);
    }
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = drawerWidth + 24;
    if (event.key === "ArrowRight") next = drawerWidth - 24;
    if (event.key === "Home") next = DRAWER_MIN_WIDTH;
    if (event.key === "End") next = drawerMaximum;
    if (next === null) return;
    event.preventDefault();
    const width = clampWidth(next, drawerMaximum);
    setDrawerWidth(width);
    persistDrawerWidth(width);
  }

  function startResizing(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
  }

  const faceState: MinkFaceState =
    talk.phase === "listening"
      ? "listening"
      : talk.phase === "speaking" || readAloud.speakingId !== null
        ? "talking"
        : talk.phase === "transcribing" ||
            talk.phase === "thinking" ||
            pending ||
            dictation.state === "transcribing"
          ? "thinking"
          : dictation.state === "recording"
            ? "listening"
            : justAnswered
              ? "done"
              : "default";

  const recording =
    dictation.state === "recording" || dictation.state === "starting";
  const conversationStarted = messages.length > 0;

  // The header menu. It stays open while the language changes, so the
  // visitor sees the new choice take hold; the other two items close it.
  const headerMenu = menuOpen && (
    <div id="hc-assistant-menu" className="hc-assistant-menu">
      <button
        type="button"
        className="hc-assistant-menu-item hc-assistant-history-toggle"
        onClick={() => {
          setMenuOpen(false);
          setShowHistory(true);
        }}
      >
        <History size={16} aria-hidden />
        <span>{t.recentChats}</span>
      </button>
      <label className="hc-assistant-menu-item hc-assistant-language">
        <Globe size={16} aria-hidden />
        <span>{t.language}</span>
        <span className="hc-assistant-language-value">
          <select
            value={language ?? "en"}
            onChange={(event) => chooseLanguage(event.target.value)}
            aria-label={t.language}
          >
            {HELP_LANGUAGES.map((option) => (
              <option key={option.code} value={option.code} lang={option.code}>
                {option.native}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden />
        </span>
      </label>
      <button
        type="button"
        className="hc-assistant-menu-item hc-assistant-maximize"
        onClick={() => {
          setMenuOpen(false);
          setIsResizing(false);
          setShowHistory(false);
          setIsMaximized((current) => !current);
        }}
        aria-pressed={isMaximized}
      >
        {isMaximized ? (
          <Minimize2 size={16} aria-hidden />
        ) : (
          <Maximize2 size={16} aria-hidden />
        )}
        <span>{isMaximized ? t.restore : t.maximize}</span>
      </button>
    </div>
  );

  return (
    <div className="hc-assistant">
      {/* A disclosure button: it keeps its name while the chat is open (the
          chat has its own close), so the header never shows two Close
          buttons. */}
      <button
        ref={launcherRef}
        type="button"
        className={`hc-assistant-launcher${open ? " is-open" : ""}`}
        onClick={() => (open ? closeAssistant() : setOpen(true))}
        aria-expanded={open}
        aria-controls="hc-mink-ai-drawer"
        aria-label="Ask Mink AI"
      >
        <MinkFace size={26} animated className="hc-assistant-launcher-face" />
        <span className="hc-assistant-launcher-label">Ask Mink AI</span>
      </button>

      {open &&
        overlayHost &&
        createPortal(
          <>
            <div
              className="hc-assistant-backdrop"
              onClick={closeAssistant}
              aria-hidden
            />
            <section
              id="hc-mink-ai-drawer"
              ref={panelRef}
              className={`hc-assistant-panel${isResizing ? " is-resizing" : ""}${isMaximized ? " is-maximized" : ""}${talk.active ? " is-talking" : ""}${showHistory ? " is-history" : ""}`}
              style={isMaximized ? undefined : { width: drawerWidth }}
              role="dialog"
              aria-modal="true"
              aria-label={t.dialogLabel}
              aria-describedby="hc-assistant-description"
              lang={language ?? undefined}
            >
              {!isMaximized && (
                <div
                  className="hc-assistant-resizer"
                  role="separator"
                  aria-label="Resize Mink AI drawer"
                  aria-orientation="vertical"
                  aria-valuemin={DRAWER_MIN_WIDTH}
                  aria-valuemax={drawerMaximum}
                  aria-valuenow={drawerWidth}
                  tabIndex={0}
                  onPointerDown={startResizing}
                  onKeyDown={resizeWithKeyboard}
                />
              )}

              {isMaximized && (
                <aside className="hc-assistant-sidebar">
                  <MinkRecentList
                    chats={recent}
                    activeId={chatId}
                    strings={t}
                    onOpen={openRecentChat}
                    onDelete={removeRecentChat}
                    onNewChat={resetConversation}
                  />
                  <nav className="hc-assistant-sidebar-links">
                    <Link href="/help#topics" onClick={closeAssistant}>
                      <BookOpen size={16} aria-hidden />
                      <span>{t.browseGuides}</span>
                    </Link>
                    <Link href="/help/search" onClick={closeAssistant}>
                      <Search size={16} aria-hidden />
                      <span>{t.searchGuides}</span>
                    </Link>
                  </nav>
                </aside>
              )}

              <div className="hc-assistant-main">
                <header className="hc-assistant-header">
                  <button
                    type="button"
                    className="hc-assistant-back"
                    onClick={
                      showHistory ? () => setShowHistory(false) : closeAssistant
                    }
                    aria-label={t.back}
                  >
                    <ArrowLeft size={20} aria-hidden />
                  </button>
                  <div className="hc-assistant-title" ref={menuRef}>
                    <h2>
                      <button
                        ref={menuButtonRef}
                        type="button"
                        className="hc-assistant-title-button"
                        onClick={() => setMenuOpen((current) => !current)}
                        aria-expanded={menuOpen}
                        aria-controls="hc-assistant-menu"
                        aria-label={`Mink AI ${t.options}`}
                      >
                        <MinkFace
                          size={28}
                          animated
                          state={faceState}
                          className="hc-assistant-avatar"
                        />
                        <span>Mink AI</span>
                        <ChevronDown
                          size={16}
                          aria-hidden
                          className="hc-assistant-title-chevron"
                        />
                      </button>
                    </h2>
                    <p
                      id="hc-assistant-description"
                      className="hc-assistant-sr-only"
                    >
                      {t.subtitle}
                    </p>
                    {headerMenu}
                  </div>
                  <div className="hc-assistant-header-actions">
                    <button
                      type="button"
                      className="hc-assistant-icon hc-assistant-new"
                      onClick={resetConversation}
                      aria-label={t.newChatLabel}
                      title={t.newChat}
                    >
                      <SquarePen size={18} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="hc-assistant-icon hc-assistant-close"
                      onClick={closeAssistant}
                      aria-label={t.close}
                    >
                      <X size={19} aria-hidden />
                    </button>
                  </div>
                </header>

                {showHistory ? (
                  <div className="hc-assistant-history">
                    <h3>{t.recentChats}</h3>
                    <MinkRecentList
                      chats={recent}
                      activeId={chatId}
                      strings={t}
                      onOpen={openRecentChat}
                      onDelete={removeRecentChat}
                      onNewChat={resetConversation}
                    />
                  </div>
                ) : (
                  <div
                    ref={messagesRef}
                    className="hc-assistant-messages"
                    aria-live="polite"
                  >
                    <div className="hc-assistant-thread">
                      {!conversationStarted ? (
                        <div className="hc-assistant-welcome">
                          <MinkFace
                            size={48}
                            animated
                            state={faceState}
                            className="hc-assistant-welcome-face"
                          />
                          <h3>{t.welcomeTitle}</h3>
                          <p>{t.welcomeText}</p>
                          <div
                            className="hc-assistant-starters"
                            role="group"
                            aria-label={t.examplesLabel}
                          >
                            {t.starters.map((question) => (
                              <button
                                type="button"
                                onClick={() => void sendMessage(question)}
                                key={question}
                              >
                                <span>{question}</span>
                                <ArrowUpRight size={15} aria-hidden />
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        messages.map((message) => (
                          <div
                            className={`hc-assistant-row ${message.role}`}
                            key={message.id}
                            data-message-id={message.id}
                          >
                            <div className="hc-assistant-message">
                              {message.role === "user" && message.spoken && (
                                <span className="hc-assistant-spoken">
                                  <Mic size={12} aria-hidden /> {t.saidAloud}
                                </span>
                              )}
                              <p>{message.content}</p>
                              {message.role === "assistant" &&
                                message.answer && (
                                  <MinkAnswer
                                    answer={message.answer}
                                    strings={t}
                                    language={language}
                                    rating={message.rating}
                                    thanked={thankedId === message.id}
                                    copied={copiedId === message.id}
                                    speaking={
                                      readAloud.speakingId === message.id
                                    }
                                    canListen={canListen && !talk.active}
                                    followUpsDisabled={pending || talk.active}
                                    onOpenGuide={closeAssistant}
                                    onFollowUp={(question) =>
                                      void sendMessage(question)
                                    }
                                    onCopy={() => void copyAnswer(message)}
                                    onListen={() =>
                                      readAloud.speakingId === message.id
                                        ? readAloud.stop()
                                        : readAloud.speak(
                                            message.id,
                                            answerText(message, t.important),
                                            speechLang,
                                          )
                                    }
                                    onRate={(rating) =>
                                      void rateAnswer(message, rating)
                                    }
                                  />
                                )}
                            </div>
                          </div>
                        ))
                      )}

                      {pending && (
                        <div className="hc-assistant-row assistant">
                          <div
                            className="hc-assistant-thinking"
                            role="status"
                            aria-label={t.thinkingLabel}
                          >
                            <span />
                            <span />
                            <span />
                            <em aria-hidden>{t.thinking}</em>
                          </div>
                        </div>
                      )}
                      {error && (
                        <div className="hc-assistant-error" role="alert">
                          {error}
                        </div>
                      )}
                      <div ref={endRef} />
                    </div>
                  </div>
                )}

                {talk.notice && !talk.active && (
                  <div className="hc-assistant-notice" role="status">
                    <span>{talk.notice}</span>
                    <button
                      type="button"
                      onClick={talk.clearNotice}
                      aria-label={t.dismiss}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}

                {talk.active ? (
                  <div
                    className={`hc-assistant-voicebar is-${talk.phase}`}
                    role="group"
                    aria-label={t.voiceGroup}
                  >
                    <MinkFace
                      size={36}
                      animated
                      state={faceState}
                      className="hc-assistant-voicebar-face"
                    />
                    <div className="hc-assistant-voicebar-body">
                      <p className="hc-assistant-voicebar-status" role="status">
                        {talk.phase === "off" ? "" : t.talkStatus[talk.phase]}
                      </p>
                      {talk.phase === "listening" ? (
                        <MinkWaveform
                          levelRef={talk.levelRef}
                          live
                          className="hc-assistant-wave"
                        />
                      ) : (
                        <p className="hc-assistant-voicebar-caption">
                          {talk.caption}
                        </p>
                      )}
                    </div>
                    <div className="hc-assistant-voicebar-actions">
                      {talk.phase === "speaking" && (
                        <button
                          type="button"
                          className="hc-assistant-voicebar-skip"
                          onClick={talk.skip}
                          aria-label={t.skipLabel}
                        >
                          {t.skip}
                        </button>
                      )}
                      <button
                        type="button"
                        className="hc-assistant-voicebar-end"
                        onClick={() => talk.stop()}
                        aria-label={t.endLabel}
                      >
                        <X size={16} aria-hidden />
                        <span>{t.end}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <form
                    className={`hc-assistant-composer${recording ? " is-recording" : ""}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void sendMessage();
                    }}
                  >
                    {recording ? (
                      <div className="hc-assistant-recording">
                        <span
                          className="hc-assistant-recording-dot"
                          aria-hidden
                        />
                        <MinkWaveform
                          levelRef={dictation.levelRef}
                          live={dictation.state === "recording"}
                          className="hc-assistant-wave"
                        />
                        <span className="hc-assistant-recording-clock">
                          {formatMinkClock(dictation.seconds)}
                        </span>
                      </div>
                    ) : (
                      <>
                        <label
                          htmlFor="hc-assistant-input"
                          className="hc-assistant-sr-only"
                        >
                          {t.inputLabel}
                        </label>
                        <textarea
                          id="hc-assistant-input"
                          ref={inputRef}
                          value={draft}
                          onChange={(event) => {
                            setDraft(event.target.value);
                            if (error) setError("");
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault();
                              void sendMessage();
                            }
                          }}
                          placeholder={
                            dictation.state === "transcribing"
                              ? t.placeholderTranscribing
                              : t.placeholder
                          }
                          // Same keyboard contract as the dashboard composer — Return
                          // sends here too, and an un-hinted field in a <form> gets iOS's
                          // password/card/address bar instead of word suggestions.
                          enterKeyHint="send"
                          autoComplete="off"
                          autoCapitalize="sentences"
                          autoCorrect="on"
                          rows={1}
                          maxLength={HELP_ASSISTANT_MAX_MESSAGE_LENGTH}
                          disabled={
                            pending || dictation.state === "transcribing"
                          }
                        />
                      </>
                    )}
                    <div className="hc-assistant-composer-actions">
                      {recording ? (
                        <>
                          <button
                            type="button"
                            className="hc-assistant-tool"
                            onClick={dictation.cancel}
                            aria-label={t.cancelDictation}
                          >
                            <X size={17} />
                          </button>
                          <button
                            type="button"
                            className="hc-assistant-done"
                            onClick={dictation.finish}
                            disabled={dictation.state !== "recording"}
                            aria-label={t.finishDictation}
                          >
                            <Check size={16} aria-hidden />
                            <span>{t.done}</span>
                          </button>
                        </>
                      ) : (
                        <>
                          {canDictate && (
                            <button
                              type="button"
                              className="hc-assistant-tool hc-assistant-dictate"
                              onClick={() => {
                                stopReading();
                                setError("");
                                void dictation.start();
                              }}
                              disabled={
                                pending || dictation.state === "transcribing"
                              }
                              aria-label={t.dictate}
                              title={t.dictate}
                            >
                              <Mic size={18} />
                            </button>
                          )}
                          {canTalk && (
                            <button
                              type="button"
                              className="hc-assistant-tool hc-assistant-talk"
                              onClick={startTalk}
                              disabled={
                                pending || dictation.state === "transcribing"
                              }
                              aria-label={t.talk}
                              title={t.talk}
                            >
                              <AudioLines size={18} />
                            </button>
                          )}
                          <button
                            type="submit"
                            className="hc-assistant-send"
                            aria-label={t.send}
                            disabled={pending || Boolean(draftError)}
                          >
                            <ArrowUp size={18} />
                          </button>
                        </>
                      )}
                    </div>
                  </form>
                )}
                <footer className="hc-assistant-footer">
                  <div
                    className="hc-assistant-powered"
                    aria-label="Powered by StoreMink"
                  >
                    <span>Powered by</span>
                    <Image
                      src={STOREMINK_MARK}
                      alt=""
                      width={16}
                      height={16}
                      aria-hidden
                    />
                    <strong>StoreMink</strong>
                  </div>
                  <span className="hc-assistant-disclaimer">
                    {t.disclaimer}
                  </span>
                </footer>
              </div>
            </section>
          </>,
          overlayHost,
        )}
    </div>
  );
}
