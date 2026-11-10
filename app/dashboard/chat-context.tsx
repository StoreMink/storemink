"use client";

import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { MINK_CHAT_PARAM, readMinkChatParam } from "@/lib/mink/chat-session";
import {
  useMinkAi,
  type MinkConversationSummary,
  type MinkEarlierStatus,
  type MinkHistorySearch,
  type MinkHistoryStatus,
  type MinkMemoryPrompt,
  type MinkMessage,
  type MinkPreparedSend,
  type MinkRevealTarget,
  type MinkRunStep,
  type MinkUiError,
} from "./mink-ai";
import type { MinkFeedbackIssue, MinkFeedbackRating } from "@/lib/mink/types";
import type { MinkStopResult } from "@/lib/mink/run-stop-types";
import type { MinkSkill } from "@/lib/mink/skills";
import type { MinkHighlight } from "@/lib/mink/guide-targets";
import { MinkSpotlight } from "./mink-spotlight";
import {
  useMinkVoiceMode,
  type MinkVoiceMode,
  type MinkVoiceSendOptions,
} from "./mink-voice-mode";

interface ChatContextType {
  isChatOpen: boolean;
  /** `media` manage, resolved in the dashboard layout — see MinkMultimodalInput. */
  canSaveMedia: boolean;
  /** The "/" skills this viewer may run, permission-filtered on the server. */
  skills: MinkSkill[];
  // Full-view "takeover" mode (Shopify Sidekick style) vs the narrow side panel.
  isExpanded: boolean;
  toggleChat: () => void;
  closeChat: () => void;
  toggleExpand: () => void;
  // Home "Ask anything…" box → open the chat in full view AND send the
  // message, in a new chat (see lib/mink/chat-session).
  startExpandedChat: (message: string) => void;
  /**
   * The top-bar "Ask Mink AI" bar: opens the docked side panel (never the
   * full view), starts a new chat and sends. While a reply runs the question
   * waits in the box. An empty message opens the panel on the current chat.
   */
  askInPanel: (message: string) => void;
  /** Opens the docked panel on the current chat; never toggles or expands. */
  openChat: () => void;
  /** A better question the current page offers (the go-live card's task). */
  pageSuggestion: MinkPageSuggestionValue | null;
  setPageSuggestion: (suggestion: MinkPageSuggestionValue | null) => void;
  /** Bumped by each entry point that should land focus in the composer. */
  focusComposerOnOpen: number;
  /** Mink AI is switched on for this store (History's search shows only then). */
  enabled: boolean;
  // The shared Mink AI conversation (one thread across the Home box + panel).
  messages: MinkMessage[];
  /** History: every chat loaded so far, newest activity first. */
  conversations: MinkConversationSummary[];
  /** History has more chats to load as the sidebar scrolls. */
  hasMoreConversations: boolean;
  /** History's own loading and failures, shown in the sidebar. */
  historyStatus: MinkHistoryStatus;
  /** History's first page again (Try again after it failed). */
  refreshConversations: () => Promise<void>;
  loadMoreConversations: () => Promise<void>;
  /** The History search field's words (kept while the sidebar is closed). */
  historySearchText: string;
  setHistorySearchText: (text: string) => void;
  /** The current search and its results; null shows the plain list. */
  historySearch: MinkHistorySearch | null;
  searchConversations: () => Promise<void>;
  loadMoreSearchResults: () => Promise<void>;
  /** The open chat has messages before those shown. */
  hasEarlierMessages: boolean;
  earlierStatus: MinkEarlierStatus;
  loadEarlierMessages: () => Promise<void>;
  /** The message a search result opened the chat onto, until scrolled to. */
  revealTarget: MinkRevealTarget | null;
  clearRevealTarget: () => void;
  activeConversationId: string | null;
  activeConversationTitle: string | null;
  input: string;
  setInput: (value: string) => void;
  isReplying: boolean;
  /**
   * The server refused a Stop (the run had already started something, or
   * the answer could not be had): the reply finishes and Stop is not offered;
   * `statusText` says why.
   */
  stopRefused: boolean;
  isHistoryLoading: boolean;
  deletingConversationId: string | null;
  statusText: string | null;
  /** The answer so far while Mink is still writing it. */
  streamingText: string;
  /** A voice turn's spoken words so far; empty on a typed turn. */
  spokenText: string;
  /** The spoken block has closed; the written answer follows. */
  spokenEnded: boolean;
  /** The tools the current run has called, in order. */
  steps: MinkRunStep[];
  error: MinkUiError | null;
  feedbackSubmittingRunId: string | null;
  /** A control Mink is pointing at on the current page, until dismissed. */
  spotlight: MinkHighlight | null;
  showSpotlight: (highlight: MinkHighlight | null) => void;
  /** "Remember this?" offered after the newest answer, until the next message. */
  memoryPrompt: MinkMemoryPrompt | null;
  saveMemorySuggestion: () => Promise<MinkUiError | null>;
  dismissMemorySuggestion: () => void;
  minkCredits: MinkCreditSummary | null;
  /** `voice` marks a transcript from voice chat; a typed send leaves it unset. */
  send: (raw?: string, options?: { voice?: boolean }) => void;
  /**
   * A typed message with attachments: it shows in the chat at once and Mink
   * reads the files as its first step. False when it could not be taken.
   */
  sendPrepared: (prepared: MinkPreparedSend) => boolean;
  /**
   * Asks the server to stop the reply and resolves with its answer; the
   * stream is let go only on `stopped` (see `useMinkAi`).
   */
  cancel: () => Promise<MinkStopResult>;
  retry: () => void;
  reset: () => void;
  /** Leaves the open chat for a new, empty one; History keeps it. */
  startNewChat: () => void;
  /**
   * How many times this tab has opened a chat from the dashboard address
   * (`?chat=`); the chat view meets each one at its newest message.
   */
  addressOpens: number;
  /** `revealMessageId`: a search result's match, which the chat opens onto. */
  loadConversation: (
    id: string,
    options?: { revealMessageId?: string },
  ) => Promise<void>;
  deleteConversation: (id: string) => Promise<MinkUiError | null>;
  submitFeedback: (input: {
    runId: string;
    rating: MinkFeedbackRating;
    issueCategory?: MinkFeedbackIssue | null;
    details?: string;
  }) => Promise<MinkUiError | null>;
}

export interface MinkPageSuggestionValue {
  label: string;
  prompt: string;
}

export interface MinkCreditSummary {
  used: number;
  cap: number | null;
  creditBalance: number;
  resetsAt: string;
}

/**
 * A summary held in state is, by construction, one the server could really
 * read: `cap: null` means an unmetered plan and nothing else. ★ getAiUsage
 * reports the same `cap: null` when its READ FAILS, so a payload that is not
 * explicitly `available` is discarded rather than rendered — otherwise a
 * transient database failure would paint a full green ring reading "Unlimited
 * Mink credits" over a store with nothing left.
 */
function readMinkCredits(value: unknown): MinkCreditSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    row.available !== true ||
    typeof row.used !== "number" ||
    (typeof row.cap !== "number" && row.cap !== null) ||
    typeof row.creditBalance !== "number" ||
    typeof row.resetsAt !== "string"
  ) {
    return null;
  }
  return {
    used: row.used,
    cap: row.cap,
    creditBalance: row.creditBalance,
    resetsAt: row.resetsAt,
  };
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

/**
 * The composer's half of a spoken turn. Given the transcript, it puts the
 * draft in the box in front of it, uploads and reads the staged attachments,
 * and hands the finished message to `deliver`, resolving whether it went.
 * Null when nothing is staged, so the transcript is sent on its own.
 */
export type MinkVoiceComposer = (
  transcript: string,
  deliver: (message: string) => boolean,
) => Promise<boolean> | null;

export type MinkVoiceChat = MinkVoiceMode & {
  /**
   * The mounted composer offers to carry each spoken turn; returns the
   * unregister. ★ Voice chat keeps the composer mounted but hidden, so a
   * draft and staged attachments wait in it. A spoken turn used to bypass it:
   * the attachments were never sent, the run cleared the draft, and the
   * composer's remount for the new conversation deleted the uploads.
   */
  registerComposer: (composer: MinkVoiceComposer) => () => void;
};

/**
 * The spoken conversation, in its own context so the captions it updates
 * several times a second while Mink talks do not re-render every consumer
 * of the chat. Outside a provider (the platform console) the toggle is
 * simply disabled.
 */
const NO_VOICE: MinkVoiceChat = {
  enabled: false,
  muted: false,
  toggleMute: () => {},
  state: "idle",
  mic: "closed",
  support: { ok: false, reason: "Voice chat is unavailable here." },
  levelRef: { current: 0 },
  heard: null,
  said: null,
  notice: null,
  toggle: () => {},
  noteSend: () => {},
  registerComposer: () => () => {},
};
const MinkVoiceContext = createContext<MinkVoiceChat>(NO_VOICE);

export function useMinkVoice(): MinkVoiceChat {
  return useContext(MinkVoiceContext);
}

export function ChatProvider({
  children,
  minkEnabled,
  canSaveMedia = false,
  skills = [],
}: {
  children: ReactNode;
  minkEnabled: boolean;
  canSaveMedia?: boolean;
  skills?: MinkSkill[];
}) {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  // Lives here, not in the panel: a spotlight must outlive the panel closing
  // on a phone, where opening a page also closes the chat.
  const [spotlight, setSpotlight] = useState<MinkHighlight | null>(null);
  const showSpotlight = useCallback(
    (highlight: MinkHighlight | null) => setSpotlight(highlight),
    [],
  );
  const clearSpotlight = useCallback(() => setSpotlight(null), []);
  const [minkCredits, setMinkCredits] = useState<MinkCreditSummary | null>(
    null,
  );
  // Conversation state lives here (not in each surface) so a message typed in
  // the Home box carries over into the panel/full view that opens.
  const mink = useMinkAi({ enabled: minkEnabled });
  const minkSend = mink.send;
  const voiceComposer = useRef<MinkVoiceComposer | null>(null);
  const registerComposer = useCallback((composer: MinkVoiceComposer) => {
    voiceComposer.current = composer;
    return () => {
      if (voiceComposer.current === composer) voiceComposer.current = null;
    };
  }, []);
  // A spoken turn goes through the composer when something is staged there,
  // and straight to the chat when nothing is.
  const voiceSend = useCallback(
    (text: string, options: MinkVoiceSendOptions) => {
      const deliver = (message: string) => minkSend(message, options);
      return voiceComposer.current?.(text, deliver) ?? deliver(text);
    },
    [minkSend],
  );
  // ★ THE VOICE LOOP LIVES HERE, NOT IN THE COMPOSER. The composer is keyed
  // on the conversation and remounts when a new conversation gets its id or
  // the panel swaps with the full view; a loop inside it ended on every such
  // remount, mid-sentence.
  const voiceMode = useMinkVoiceMode({
    messages: mink.messages,
    isReplying: mink.isReplying,
    isChatOpen,
    error: mink.error,
    spokenText: mink.spokenText,
    spokenEnded: mink.spokenEnded,
    spokenKept: mink.spokenKept,
    send: voiceSend,
    cancel: mink.cancel,
    langFallback:
      typeof navigator !== "undefined" ? navigator.language : undefined,
  });
  const voice = useMemo(
    () => ({ ...voiceMode, registerComposer }),
    [voiceMode, registerComposer],
  );
  const { noteSend } = voiceMode;
  // A typed, Home-box or card send while voice chat is on gets a spoken
  // answer too; the loop's own sends mark themselves `voice` and skip this.
  const send = useCallback(
    (raw?: string, options?: { voice?: boolean }) => {
      if (!minkSend(raw, options)) return;
      if (!options?.voice) noteSend();
    },
    [minkSend, noteSend],
  );
  const minkSendPrepared = mink.sendPrepared;
  const sendPrepared = useCallback(
    (prepared: MinkPreparedSend) => {
      if (!minkSendPrepared(prepared)) return false;
      noteSend();
      return true;
    },
    [minkSendPrepared, noteSend],
  );
  const {
    isReplying,
    setInput,
    startNewChat,
    resumeOrStartFresh,
    openConversationFromAddress,
  } = mink;

  const refreshMinkCredits = useCallback(async () => {
    if (!minkEnabled) return;
    try {
      const response = await fetch("/api/mink/credits", { cache: "no-store" });
      if (!response.ok) return;
      const summary = readMinkCredits(await response.json());
      if (summary) setMinkCredits(summary);
    } catch {
      // The balance is helpful chrome, never a reason to take chat offline.
    }
  }, [minkEnabled]);

  useEffect(() => {
    if (mink.isReplying) return;
    const timer = window.setTimeout(() => void refreshMinkCredits(), 0);
    return () => window.clearTimeout(timer);
  }, [mink.isReplying, refreshMinkCredits]);

  // ★ Opening Mink continues the chat it was showing, unless that chat has
  // gone quiet for hours, when a new one starts (ChatGPT, Claude, Sidekick).
  const toggleChat = useCallback(() => {
    if (!isChatOpen) resumeOrStartFresh();
    setIsChatOpen(!isChatOpen);
  }, [isChatOpen, resumeOrStartFresh]);
  const closeChat = useCallback(() => {
    setIsChatOpen(false);
    setIsExpanded(false);
  }, []);
  const toggleExpand = useCallback(() => setIsExpanded((prev) => !prev), []);

  // A page that knows a better question than the skills catalogue (the
  // go-live card's open task) offers it here; the top-bar bar and the panel's
  // empty state show it first.
  const [pageSuggestion, setPageSuggestionState] =
    useState<MinkPageSuggestionValue | null>(null);
  const setPageSuggestion = useCallback(
    (next: MinkPageSuggestionValue | null) =>
      setPageSuggestionState((prev) =>
        prev?.label === next?.label && prev?.prompt === next?.prompt
          ? prev
          : next,
      ),
    [],
  );
  const [focusComposerOnOpen, setFocusComposerOnOpen] = useState(0);

  // The top-bar tab's tap on a touch screen: open, never toggle, never expand.
  const openChat = useCallback(() => {
    if (!isChatOpen) resumeOrStartFresh();
    setIsChatOpen(true);
    setIsExpanded(false);
    setFocusComposerOnOpen((n) => n + 1);
  }, [isChatOpen, resumeOrStartFresh]);

  // ★ A question from Home or an "Ask Mink" button is a new topic, so it
  // starts a new chat rather than landing in whatever thread was open last.
  // While Mink is still answering, the question waits in the box instead:
  // starting a new chat then would stop that answer.
  const startExpandedChat = useCallback(
    (message: string) => {
      setIsChatOpen(true);
      setIsExpanded(true);
      if (isReplying) {
        setInput(message);
        return;
      }
      startNewChat();
      send(message);
    },
    [isReplying, setInput, startNewChat, send],
  );

  // The top-bar "Ask Mink AI" bar asks in the docked panel: the rules of
  // startExpandedChat, without the full view. An empty question just opens.
  const askInPanel = useCallback(
    (message: string) => {
      const text = message.trim();
      if (!text) {
        openChat();
        return;
      }
      setIsChatOpen(true);
      setIsExpanded(false);
      setFocusComposerOnOpen((n) => n + 1);
      if (isReplying) {
        setInput(text);
        return;
      }
      startNewChat();
      send(text);
    },
    [openChat, isReplying, setInput, startNewChat, send],
  );

  // ★★ An address that names a chat (`?chat=<id>`, robustness audit B20; the
  // "redesign ready" notice links there) opens it in the full view, the way
  // choosing it in History does; `openConversationFromAddress` keeps it to the
  // viewer's own chats. Nothing opens while Mink AI is off.
  const openChatFromAddress = useCallback(
    (conversationId: string | null) => {
      if (!minkEnabled) return;
      setIsChatOpen(true);
      setIsExpanded(true);
      void openConversationFromAddress(conversationId);
    },
    [minkEnabled, openConversationFromAddress],
  );

  const value = useMemo(
    () => ({
      isChatOpen,
      isExpanded,
      canSaveMedia,
      skills,
      spotlight,
      showSpotlight,
      minkCredits,
      toggleChat,
      closeChat,
      toggleExpand,
      startExpandedChat,
      askInPanel,
      openChat,
      pageSuggestion,
      setPageSuggestion,
      focusComposerOnOpen,
      ...mink,
      send,
      sendPrepared,
    }),
    [
      isChatOpen,
      isExpanded,
      canSaveMedia,
      skills,
      spotlight,
      showSpotlight,
      minkCredits,
      toggleChat,
      closeChat,
      toggleExpand,
      startExpandedChat,
      askInPanel,
      openChat,
      pageSuggestion,
      setPageSuggestion,
      focusComposerOnOpen,
      mink,
      send,
      sendPrepared,
    ],
  );

  return (
    <ChatContext.Provider value={value}>
      <MinkVoiceContext.Provider value={voice}>
        {/* ★ Its own Suspense boundary: reading the address must never hold
            back the dashboard's own prerendered shell. */}
        <Suspense fallback={null}>
          <MinkChatAddress onOpen={openChatFromAddress} />
        </Suspense>
        {children}
        {spotlight ? (
          <MinkSpotlight highlight={spotlight} onDone={clearSpotlight} />
        ) : null}
      </MinkVoiceContext.Provider>
    </ChatContext.Provider>
  );
}

/**
 * ★★ Reads `?chat=` once (B20). The parameter is taken off the address
 *   before the chat opens (`history.replaceState`, which Next's router
 *   follows), so a reload, Back or a shared link of the page never reopens
 *   the chat, and the same link clicked again later (the notification once
 *   more) is a new value and opens it again. An address that names no chat
 *   that could exist still opens Mink, on a new chat, as an id that is not
 *   the viewer's does.
 */
function MinkChatAddress({
  onOpen,
}: {
  onOpen: (conversationId: string | null) => void;
}) {
  // Null outside the App Router (a test that renders the provider alone).
  const params = useSearchParams();
  const raw = params?.get(MINK_CHAT_PARAM) ?? null;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (raw === null) {
      handled.current = null;
      return;
    }
    // A render before the address catches up must not open it twice.
    if (handled.current === raw) return;
    handled.current = raw;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete(MINK_CHAT_PARAM);
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      // An address that cannot be rewritten still opens the chat once.
    }
    onOpen(readMinkChatParam(raw));
  }, [raw, onOpen]);
  return null;
}

export function useChat() {
  const context = useContext(ChatContext);
  if (context === undefined) {
    // Defensive default so a stray consumer never crashes the shell — the
    // shared DashboardTopbar is also rendered by the platform console layout,
    // which intentionally has no ChatProvider (the assistant is a store-only
    // feature). Mirrors useMobileNav's non-throwing fallback.
    return {
      isChatOpen: false,
      isExpanded: false,
      canSaveMedia: false,
      skills: [],
      spotlight: null,
      showSpotlight: () => {},
      toggleChat: () => {},
      closeChat: () => {},
      toggleExpand: () => {},
      startExpandedChat: () => {},
      askInPanel: () => {},
      openChat: () => {},
      pageSuggestion: null,
      setPageSuggestion: () => {},
      focusComposerOnOpen: 0,
      enabled: false,
      messages: [],
      conversations: [],
      hasMoreConversations: false,
      historyStatus: { loadingMore: false, error: null, failed: null },
      refreshConversations: async () => {},
      loadMoreConversations: async () => {},
      historySearchText: "",
      setHistorySearchText: () => {},
      historySearch: null,
      searchConversations: async () => {},
      loadMoreSearchResults: async () => {},
      hasEarlierMessages: false,
      earlierStatus: { loading: false, error: null },
      loadEarlierMessages: async () => {},
      revealTarget: null,
      clearRevealTarget: () => {},
      activeConversationId: null,
      activeConversationTitle: null,
      input: "",
      setInput: () => {},
      isReplying: false,
      stopRefused: false,
      isHistoryLoading: false,
      deletingConversationId: null,
      statusText: null,
      streamingText: "",
      spokenText: "",
      spokenEnded: false,
      steps: [],
      error: null,
      feedbackSubmittingRunId: null,
      memoryPrompt: null,
      saveMemorySuggestion: async () => null,
      dismissMemorySuggestion: () => {},
      minkCredits: null,
      send: () => {},
      sendPrepared: () => false,
      // Nothing runs outside a provider, so there is nothing to stop.
      cancel: async (): Promise<MinkStopResult> => ({ outcome: "finished" }),
      retry: () => {},
      reset: () => {},
      startNewChat: () => {},
      addressOpens: 0,
      loadConversation: async () => {},
      deleteConversation: async () => ({
        code: "mink_unavailable",
        message: "Mink AI is unavailable.",
      }),
      submitFeedback: async () => ({
        code: "mink_unavailable",
        message: "Mink AI is unavailable.",
      }),
    } satisfies ChatContextType;
  }
  return context;
}
