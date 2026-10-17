"use client";

import {
  createContext,
  useContext,
  useEffect,
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
  send: (raw?: string) => void;
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
  const { send } = mink;

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
    ],
  );

  return (
    <ChatContext.Provider value={value}>
      {children}
      {spotlight ? (
        <MinkSpotlight highlight={spotlight} onDone={clearSpotlight} />
      ) : null}
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
