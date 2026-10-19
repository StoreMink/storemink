"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import {
  useMinkAi,
  type MinkConversationSummary,
  type MinkMemoryPrompt,
  type MinkMessage,
  type MinkRunStep,
  type MinkUiError,
} from "./mink-ai";
import type { MinkFeedbackIssue, MinkFeedbackRating } from "@/lib/mink/types";
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
  // Home "Ask anything…" box → open the chat in full view AND send the message.
  startExpandedChat: (message: string) => void;
  // The shared Mink AI conversation (one thread across the Home box + panel).
  messages: MinkMessage[];
  conversations: MinkConversationSummary[];
  activeConversationId: string | null;
  activeConversationTitle: string | null;
  input: string;
  setInput: (value: string) => void;
  isReplying: boolean;
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
  error: { code: string; message: string } | null;
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
  cancel: () => void;
  retry: () => void;
  reset: () => void;
  loadConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<MinkUiError | null>;
  submitFeedback: (input: {
    runId: string;
    rating: MinkFeedbackRating;
    issueCategory?: MinkFeedbackIssue | null;
    details?: string;
  }) => Promise<MinkUiError | null>;
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

  const toggleChat = useCallback(() => setIsChatOpen((prev) => !prev), []);
  const closeChat = useCallback(() => {
    setIsChatOpen(false);
    setIsExpanded(false);
  }, []);
  const toggleExpand = useCallback(() => setIsExpanded((prev) => !prev), []);

  const startExpandedChat = useCallback(
    (message: string) => {
      setIsChatOpen(true);
      setIsExpanded(true);
      send(message);
    },
    [send],
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
      ...mink,
      send,
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
      mink,
      send,
    ],
  );

  return (
    <ChatContext.Provider value={value}>
      <MinkVoiceContext.Provider value={voice}>
        {children}
        {spotlight ? (
          <MinkSpotlight highlight={spotlight} onDone={clearSpotlight} />
        ) : null}
      </MinkVoiceContext.Provider>
    </ChatContext.Provider>
  );
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
      messages: [],
      conversations: [],
      activeConversationId: null,
      activeConversationTitle: null,
      input: "",
      setInput: () => {},
      isReplying: false,
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
      cancel: () => {},
      retry: () => {},
      reset: () => {},
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
