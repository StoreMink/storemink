"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MinkArtifact,
  MinkFeedbackIssue,
  MinkFeedbackRating,
} from "@/lib/mink/types";
import { readMinkArtifacts } from "./mink-artifact-parser";
import {
  minkToolLabel,
  minkToolStatus,
  type MinkToolState,
} from "@/lib/mink/tool-labels";
import {
  minkRandomUuid,
  readMinkMemorySuggestion,
  type MinkMemorySuggestion,
} from "@/lib/mink/memory-suggestion";
import { readMinkScreen } from "./mink-screen";
import {
  clearMinkActiveChat,
  isMinkChatStale,
  minkSessionStorage,
  readMinkActiveChat,
  writeMinkActiveChat,
} from "@/lib/mink/chat-session";

export const ASSISTANT_NAME = "Mink AI";
export const CANNED_REPLY = `Hi, I'm ${ASSISTANT_NAME} - your store assistant. I'm coming soon, and I'll be able to answer questions about your products, orders and customers right here.`;
const REPLY_DELAY_MS = 500;

/** One tool the run called, as the progress list shows it. */
export type MinkRunStep = {
  sequence: number;
  name: string;
  label: string;
  status: string;
  state: MinkToolState;
};

export type MinkMessage = {
  id: number | string;
  role: "user" | "assistant";
  text: string;
  /**
   * What Mink said aloud for a voice turn, kept apart from the written text
   * (which is what the chat shows and the server persists). Null on a written
   * turn; absent on a message restored from history.
   */
  spoken?: string | null;
  runId?: string;
  artifacts?: MinkArtifact[];
  /** What the run read or prepared, kept on the answer for this session only. */
  toolSteps?: MinkRunStep[];
  feedback?: {
    rating: MinkFeedbackRating;
    issueCategory: MinkFeedbackIssue | null;
  } | null;
  /**
   * What a just-sent message carries while Mink reads it, shown in the
   * bubble until the finished message (with its file references) replaces it.
   */
  pendingAttachments?: MinkPendingAttachment[];
  /**
   * This session's own copies of the pictures the merchant sent, so the
   * bubble keeps showing the photo they chose instead of reloading it.
   * Keys are `url:<saved media url>` or `file:<file name>`; never persisted.
   */
  localPreviews?: Record<string, string>;
};

/** One attachment of a message that is still being read. */
export type MinkPendingAttachment = {
  name: string;
  kind: "image" | "document";
  /** A local object URL for an image; null for a document. */
  previewUrl: string | null;
};

/**
 * A message whose attachments still need uploading and reading. It goes into
 * the chat at once, ChatGPT-style, and `prepare` finishes the work while Mink
 * shows what it is doing; `restore` hands everything back to the composer if
 * that cannot be done (or the merchant stops it first).
 */
export type MinkPreparedSend = {
  /** The typed words; may be empty when only attachments are sent. */
  draft: string;
  attachments: MinkPendingAttachment[];
  prepare: (input: {
    signal: AbortSignal;
    setStatus: (text: string) => void;
  }) => Promise<{
    message: string;
    /** Local pictures for the finished bubble (see `localPreviews`). */
    previews?: Record<string, string>;
  }>;
  /**
   * The message did not go: give it back, with the reason when it failed.
   * False when the composer that sent it has closed (the chat was closed or
   * swapped views), so only the words could go back and the chat must say
   * why itself.
   */
  restore: (error: MinkUiError | null) => boolean;
  /** The message went without its attachments: drop them. */
  discard: () => void;
};

export type MinkConversationSummary = {
  id: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
};

export type MinkUiError = {
  code: string;
  message: string;
  /** False when Retry cannot help, so the chat does not offer it. */
  retryable?: boolean;
};

/** "Remember this?" under the newest answer, and what happened to it. */
export type MinkMemoryPrompt = {
  suggestion: MinkMemorySuggestion;
  status: "offered" | "saving" | "saved" | "failed";
  error?: string;
};

export type MinkSendOptions = {
  /** A spoken turn: the server asks Mink for a short spoken block first. */
  voice?: boolean;
  /** Replace the last question when it got no answer (see `run`). */
  replaceUnanswered?: boolean;
};

type SsePayload = Record<string, unknown>;

export function useMinkAi({ enabled }: { enabled: boolean }) {
  const [messages, setMessages] = useState<MinkMessage[]>([]);
  const [memoryPrompt, setMemoryPromptState] =
    useState<MinkMemoryPrompt | null>(null);
  const memoryPromptRef = useRef<MinkMemoryPrompt | null>(null);
  const setMemoryPrompt = useCallback((next: MinkMemoryPrompt | null) => {
    memoryPromptRef.current = next;
    setMemoryPromptState(next);
  }, []);
  const [conversations, setConversations] = useState<MinkConversationSummary[]>(
    [],
  );
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [activeConversationTitle, setActiveConversationTitle] = useState<
    string | null
  >(null);
  const [input, setInput] = useState("");
  const [isReplying, setIsReplying] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState<
    string | null
  >(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  // The answer as it streams in, before the finished message replaces it.
  const [streamingText, setStreamingText] = useState("");
  // ★ The spoken block of a voice turn as it streams in, and whether the
  // server has seen its close. The voice loop cuts it into sentences and
  // starts reading before the written answer has finished; nothing here is
  // shown or kept.
  const [spokenText, setSpokenText] = useState("");
  const [spokenEnded, setSpokenEnded] = useState(false);
  // ★ What this reply has already said and KEPT: a short acknowledgement
  // ("Let me check today's orders.") spoken before a tool call. `spokenText`
  // is only the block now streaming; the voice loop reads this to finish the
  // acknowledgement it may not have seen whole, and to keep playing it rather
  // than withdrawing it when the tool call resets the text.
  const [spokenKept, setSpokenKept] = useState("");
  const [steps, setSteps] = useState<MinkRunStep[]>([]);
  const stepsRef = useRef<MinkRunStep[]>([]);
  const [error, setError] = useState<MinkUiError | null>(null);
  const [feedbackSubmittingRunId, setFeedbackSubmittingRunId] = useState<
    string | null
  >(null);
  const nextId = useRef(0);
  const isReplyingRef = useRef(false);
  const conversationId = useRef<string | null>(null);
  const lastFailedMessage = useRef<string | null>(null);
  const shouldRestoreLatest = useRef(true);
  const deletingConversationRef = useRef<string | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const historyAbortController = useRef<AbortController | null>(null);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When the open chat last had a message (null for an empty chat), which
  // decides whether reopening Mink continues it (see lib/mink/chat-session).
  const lastActivityAt = useRef<number | null>(null);
  // ★ Bumped by every send. A history load that began before a send must not
  // replace the thread the merchant has just written into when it lands.
  const sendSerial = useRef(0);
  // Object URLs the chat now owns (sent pictures), released with the thread.
  const ownedPreviews = useRef(new Set<string>());

  const setReplying = useCallback((value: boolean) => {
    isReplyingRef.current = value;
    setIsReplying(value);
  }, []);

  const releasePreviews = useCallback(() => {
    for (const url of ownedPreviews.current) URL.revokeObjectURL(url);
    ownedPreviews.current.clear();
  }, []);

  /** Records activity on the open chat and remembers it for this tab. */
  const touchActivity = useCallback((at = Date.now()) => {
    lastActivityAt.current = at;
    if (conversationId.current)
      writeMinkActiveChat(minkSessionStorage(), {
        id: conversationId.current,
        lastActivityAt: at,
      });
  }, []);

  const loadConversation = useCallback(
    async (id: string, options: { lastActivityAt?: number } = {}) => {
      if (!enabled || isReplyingRef.current) return;
      shouldRestoreLatest.current = false;
      historyAbortController.current?.abort();
      const controller = new AbortController();
      historyAbortController.current = controller;
      const serial = sendSerial.current;
      setIsHistoryLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/mink/conversations/${encodeURIComponent(id)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw await responseError(response);
        const body = (await response.json()) as unknown;
        const detail = readConversationDetail(body);
        // A message sent meanwhile owns the thread now; keep it.
        if (sendSerial.current !== serial) return;
        conversationId.current = detail.id;
        // Opening a chat from History is using it; a reload's restore keeps
        // the time of its last real message.
        touchActivity(options.lastActivityAt ?? Date.now());
        releasePreviews();
        setActiveConversationId(detail.id);
        setActiveConversationTitle(detail.title);
        setMessages(detail.messages);
        setMemoryPrompt(null);
        setInput("");
        setStatusText(null);
        lastFailedMessage.current = null;
      } catch (caught) {
        if (!controller.signal.aborted && sendSerial.current === serial)
          setError(toUiError(caught));
      } finally {
        if (historyAbortController.current === controller) {
          historyAbortController.current = null;
          setIsHistoryLoading(false);
        }
      }
    },
    [enabled, setMemoryPrompt, touchActivity, releasePreviews],
  );

  const loadConversations = useCallback(
    async (restoreLatest = false) => {
      if (!enabled) return;
      try {
        const response = await fetch("/api/mink/conversations", {
          cache: "no-store",
        });
        if (!response.ok) throw await responseError(response);
        const body = (await response.json()) as unknown;
        const recent = readConversationSummaries(body);
        setConversations(recent);
        if (
          restoreLatest &&
          shouldRestoreLatest.current &&
          !conversationId.current &&
          !isReplyingRef.current
        ) {
          shouldRestoreLatest.current = false;
          // ★ Only THIS tab's chat, and only while it is recent: a new tab,
          // or one left for hours, starts a new chat with History beside it.
          const storage = minkSessionStorage();
          const active = readMinkActiveChat(storage, Date.now());
          if (active && recent.some((item) => item.id === active.id)) {
            await loadConversation(active.id, {
              lastActivityAt: active.lastActivityAt,
            });
          } else {
            clearMinkActiveChat(storage);
          }
        }
      } catch (caught) {
        setError(toUiError(caught));
      }
    },
    [enabled, loadConversation],
  );

  const deleteConversation = useCallback(
    async (id: string): Promise<MinkUiError | null> => {
      if (
        !enabled ||
        isReplyingRef.current ||
        deletingConversationRef.current
      ) {
        return {
          code: "conversation_delete_unavailable",
          message: "Wait for Mink AI to finish before deleting a conversation.",
        };
      }
      shouldRestoreLatest.current = false;
      deletingConversationRef.current = id;
      setDeletingConversationId(id);
      setError(null);
      try {
        const response = await fetch(
          `/api/mink/conversations/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        if (!response.ok) throw await responseError(response);
        const body = (await response.json()) as unknown;
        const recent = readConversationSummaries(body);
        setConversations(recent);

        if (conversationId.current === id) {
          // ★ Deleting the open chat leaves a new, empty one, as ChatGPT and
          // Claude do. It used to open the next recent thread, so the next
          // question went into a conversation the merchant had not chosen.
          historyAbortController.current?.abort();
          conversationId.current = null;
          lastActivityAt.current = null;
          clearMinkActiveChat(minkSessionStorage());
          lastFailedMessage.current = null;
          releasePreviews();
          setActiveConversationId(null);
          setActiveConversationTitle(null);
          setMessages([]);
          setInput("");
          setStatusText(null);
        }
        return null;
      } catch (caught) {
        const nextError = toUiError(caught);
        setError(nextError);
        return nextError;
      } finally {
        deletingConversationRef.current = null;
        setDeletingConversationId(null);
      }
    },
    [enabled, releasePreviews],
  );

  useEffect(() => {
    if (enabled) void loadConversations(true);
    return () => {
      // Detached first, like `reset`: leaving abandons a half-sent message.
      const running = abortController.current;
      abortController.current = null;
      running?.abort();
      historyAbortController.current?.abort();
      if (replyTimer.current) clearTimeout(replyTimer.current);
      releasePreviews();
    };
  }, [enabled, loadConversations, releasePreviews]);

  const run = useCallback(
    async (
      text: string,
      appendUser: boolean,
      options: MinkSendOptions = {},
      prepared?: MinkPreparedSend,
    ) => {
      if ((!text && !prepared) || isReplyingRef.current) return;
      shouldRestoreLatest.current = false;
      // ★★ A MESSAGE THE MERCHANT SENDS NEVER DISAPPEARS. A history load
      // still in flight (a reload's restore, a chat picked a moment ago)
      // would otherwise land after this and replace the thread with an old
      // one, question and all.
      sendSerial.current += 1;
      if (historyAbortController.current) {
        historyAbortController.current.abort();
        historyAbortController.current = null;
        setIsHistoryLoading(false);
      }
      touchActivity();
      const userMessageId = nextId.current++;
      // With Mink switched off nothing reads the files, and `discard` frees
      // their pictures, so the bubble shows them as file cards instead.
      const pendingAttachments = prepared?.attachments.length
        ? enabled
          ? prepared.attachments
          : prepared.attachments.map((item) => ({ ...item, previewUrl: null }))
        : null;
      if (appendUser) {
        setMessages((previous) => {
          // ★ A spoken question asked again with the words that followed it
          // replaces the half that was cancelled. That half got no answer,
          // and only answered turns are in the conversation's history, so it
          // would vanish on reload while the model never saw it.
          const unanswered =
            options.replaceUnanswered &&
            previous[previous.length - 1]?.role === "user";
          return [
            ...(unanswered ? previous.slice(0, -1) : previous),
            {
              id: userMessageId,
              role: "user",
              text,
              ...(pendingAttachments ? { pendingAttachments } : {}),
            },
          ];
        });
      }
      setInput("");
      setError(null);
      lastFailedMessage.current = null;
      setStatusText(
        prepared && enabled
          ? minkReadingStatus(prepared.attachments)
          : enabled
            ? "Thinking…"
            : "Getting ready…",
      );
      setStreamingText("");
      setSpokenText("");
      setSpokenEnded(false);
      setSpokenKept("");
      stepsRef.current = [];
      setSteps([]);
      setMemoryPrompt(null);
      setReplying(true);

      if (!enabled) {
        // Mink is switched off: there is nothing to read the attachments for.
        prepared?.discard();
        replyTimer.current = setTimeout(() => {
          setMessages((previous) => [
            ...previous,
            {
              id: nextId.current++,
              role: "assistant",
              text: CANNED_REPLY,
            },
          ]);
          setStatusText(null);
          setReplying(false);
        }, REPLY_DELAY_MS);
        return;
      }

      const controller = new AbortController();
      abortController.current = controller;
      let receivedMessage = false;
      let streamedError: MinkUiError | null = null;
      let message = text;
      // What the header calls a new chat until the server's title arrives.
      const titleSource =
        text || prepared?.attachments[0]?.name || "Attachment";

      if (prepared) {
        // ★★ THE MESSAGE IS ALREADY IN THE CHAT; ITS FILES ARE READ HERE.
        // The composer used to keep the photo and spin a second loader over
        // it while every attachment was uploaded and read, and the question
        // reached the thread only afterwards. ChatGPT, Claude and Sidekick
        // move the message into the conversation at once and show the work
        // as the assistant's first step, which is what this does.
        let finished: Awaited<ReturnType<MinkPreparedSend["prepare"]>>;
        try {
          finished = await prepared.prepare({
            signal: controller.signal,
            setStatus: (status) => {
              if (abortController.current === controller) setStatusText(status);
            },
          });
          if (controller.signal.aborted)
            throw new DOMException("Aborted", "AbortError");
        } catch (caught) {
          setMessages((previous) =>
            previous.filter((item) => item.id !== userMessageId),
          );
          if (abortController.current !== controller) {
            // A new chat (or leaving the dashboard) replaced this one: the
            // half-sent message is abandoned with it.
            prepared.discard();
            return;
          }
          // Nothing reached Mink: the words and files go back to the box,
          // with the reason when it failed rather than being stopped.
          const failure = controller.signal.aborted
            ? null
            : toPrepareError(caught);
          if (!prepared.restore(failure) && failure)
            setError({
              code: failure.code,
              message: `${failure.message} Attach the file again to send it.`,
              retryable: false,
            });
          abortController.current = null;
          setStatusText(null);
          setReplying(false);
          return;
        }
        message = finished.message;
        const previews = finished.previews ?? {};
        for (const url of Object.values(previews))
          ownedPreviews.current.add(url);
        setMessages((previous) =>
          previous.map((item) =>
            item.id === userMessageId
              ? {
                  id: item.id,
                  role: item.role,
                  text: message,
                  ...(Object.keys(previews).length
                    ? { localPreviews: previews }
                    : {}),
                }
              : item,
          ),
        );
        setStatusText("Thinking…");
      }

      try {
        const response = await fetch("/api/mink/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            ...(conversationId.current
              ? { conversationId: conversationId.current }
              : {}),
            // `voice: true` marks a spoken turn: the server asks Mink for a
            // short spoken block before the written answer. Style only; the
            // server re-derives every permission as it always did.
            context: {
              ...minkBrowserContext(),
              ...(options.voice ? { voice: true } : {}),
            },
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw await responseError(response);
        if (!response.body) {
          throw new Error("Mink AI returned an unreadable response.");
        }

        await consumeMinkSse(response.body, (event, data) => {
          if (event === "status") {
            if (typeof data.conversationId === "string") {
              conversationId.current = data.conversationId;
              touchActivity();
              setActiveConversationId(data.conversationId);
              setActiveConversationTitle(
                (current) => current ?? conversationTitle(titleSource),
              );
            }
            setStatusText("Thinking…");
          } else if (event === "tool") {
            const name =
              typeof data.name === "string" ? data.name : "store_data";
            const state: MinkToolState =
              data.state === "failed"
                ? "failed"
                : data.state === "completed"
                  ? "completed"
                  : "running";
            const sequence =
              typeof data.sequence === "number"
                ? data.sequence
                : stepsRef.current.length + 1;
            const step: MinkRunStep = {
              sequence,
              name,
              label: minkToolLabel(name),
              status: minkToolStatus(name, state),
              state,
            };
            stepsRef.current = upsertRunStep(stepsRef.current, step);
            setSteps(stepsRef.current);
            // ★ A tool call is working-out: any text that streamed before it
            // is withdrawn (the server says so too), and the status line names
            // what is being read rather than the generic "Thinking…".
            if (state === "running") {
              setStreamingText("");
              setSpokenText("");
              setSpokenEnded(false);
            }
            setStatusText(state === "completed" ? "Thinking…" : step.status);
          } else if (event === "delta" && typeof data.text === "string") {
            const fragment = data.text;
            setStreamingText((previous) => previous + fragment);
            setStatusText("Writing…");
          } else if (event === "spoken" && typeof data.text === "string") {
            const fragment = data.text;
            setSpokenText((previous) => previous + fragment);
            setStatusText("Writing…");
          } else if (event === "spoken_end") {
            setSpokenEnded(true);
          } else if (event === "delta_reset") {
            // The turn's text is withdrawn: a retry, or working-out before a
            // tool call. A voice turn's finished acknowledgement survives the
            // second (`keepSpoken`, with the words the server split out): it
            // moves to `spokenKept`, and the next block starts empty.
            const said =
              data.keepSpoken === true && typeof data.spoken === "string"
                ? data.spoken.trim()
                : "";
            if (said)
              setSpokenKept((previous) =>
                previous ? `${previous} ${said}` : said,
              );
            setStreamingText("");
            setSpokenText("");
            setSpokenEnded(false);
            setStatusText("Thinking…");
          } else if (event === "message" && typeof data.text === "string") {
            const responseText = data.text;
            const runId =
              typeof data.runId === "string" ? data.runId : undefined;
            receivedMessage = true;
            touchActivity();
            setMessages((previous) => [
              ...previous,
              {
                id: nextId.current++,
                role: "assistant",
                text: responseText,
                spoken: typeof data.spoken === "string" ? data.spoken : null,
                ...(runId ? { runId } : {}),
                artifacts: readMinkArtifacts(data.artifacts),
                ...(stepsRef.current.length
                  ? { toolSteps: stepsRef.current }
                  : {}),
                feedback: null,
              },
            ]);
            setStreamingText("");
            setSpokenText("");
            setSpokenEnded(false);
            setSpokenKept("");
          } else if (event === "memory_suggestion") {
            const suggestion = readMinkMemorySuggestion(data);
            if (suggestion) setMemoryPrompt({ suggestion, status: "offered" });
          } else if (event === "error") {
            streamedError = {
              code: typeof data.code === "string" ? data.code : "mink_failed",
              message:
                typeof data.message === "string"
                  ? data.message
                  : "Mink AI couldn't complete that request.",
            };
          }
        });

        if (streamedError) throw streamedError;
        if (!receivedMessage) {
          throw new Error("Mink AI finished without an answer.");
        }
        void loadConversations();
      } catch (caught) {
        if (!controller.signal.aborted) {
          const nextError = toUiError(caught);
          setError(nextError);
          // The finished message, file references and all: a retry resends
          // it without reading the attachments again.
          lastFailedMessage.current = message;
        }
      } finally {
        if (abortController.current === controller) {
          abortController.current = null;
          setStatusText(null);
          setStreamingText("");
          setSpokenText("");
          setSpokenEnded(false);
          setSpokenKept("");
          setSteps([]);
          setReplying(false);
        }
      }
    },
    [enabled, loadConversations, setReplying, setMemoryPrompt, touchActivity],
  );

  /**
   * Returns whether the message was taken: false for an empty box or while
   * a reply is running, which is what lets the voice loop park a transcript
   * instead of losing it to `run`'s silent early return.
   */
  const send = useCallback(
    (raw?: string, options: MinkSendOptions = {}): boolean => {
      const text = (raw ?? input).trim();
      if (!text || isReplyingRef.current) return false;
      void run(text, true, options);
      return true;
    },
    [input, run],
  );

  /**
   * A message whose attachments the composer has handed over: it shows in
   * the chat at once and Mink reads the files as its first step (see `run`).
   */
  const sendPrepared = useCallback(
    (prepared: MinkPreparedSend): boolean => {
      if (isReplyingRef.current) return false;
      void run(prepared.draft.trim(), true, {}, prepared);
      return true;
    },
    [run],
  );

  const cancel = useCallback(() => {
    setStatusText("Stopping…");
    abortController.current?.abort();
  }, []);

  const retry = useCallback(() => {
    const text = lastFailedMessage.current;
    if (text) void run(text, false);
  }, [run]);

  /** Leaves the open chat for a new, empty one; History keeps the old. */
  const reset = useCallback(() => {
    shouldRestoreLatest.current = false;
    // ★ Detached before it is stopped, so a send still reading its files
    // knows it was replaced (and abandons the message) rather than stopped
    // (which gives the message back to the box).
    const running = abortController.current;
    abortController.current = null;
    running?.abort();
    historyAbortController.current?.abort();
    // A history load that lands late must not fill the new chat.
    sendSerial.current += 1;
    if (replyTimer.current) clearTimeout(replyTimer.current);
    conversationId.current = null;
    lastActivityAt.current = null;
    clearMinkActiveChat(minkSessionStorage());
    lastFailedMessage.current = null;
    releasePreviews();
    setActiveConversationId(null);
    setActiveConversationTitle(null);
    setMessages([]);
    setInput("");
    setStatusText(null);
    setStreamingText("");
    setSpokenText("");
    setSpokenEnded(false);
    setSpokenKept("");
    stepsRef.current = [];
    setSteps([]);
    setMemoryPrompt(null);
    setError(null);
    setIsHistoryLoading(false);
    setReplying(false);
  }, [setReplying, setMemoryPrompt, releasePreviews]);

  /** "New chat": the header button, a question from Home, "Ask Mink". */
  const startNewChat = useCallback(() => reset(), [reset]);

  /**
   * Opening Mink continues the open chat while it is recent, and starts a
   * new one once it has had no message for MINK_CHAT_RESUME_MS (the way a
   * new tab or a reload after that long already does). A chat that is
   * replying, or still empty, is left exactly as it is.
   */
  const resumeOrStartFresh = useCallback(() => {
    if (isReplyingRef.current || !conversationId.current) return;
    if (isMinkChatStale(lastActivityAt.current, Date.now())) reset();
  }, [reset]);

  /**
   * One tap saves the offered sentence through the same memories API the
   * Memories page uses: the same explicit confirmation, the same ten-memory
   * limit and a 90-day retention. Nothing is written until this is called.
   */
  const saveMemorySuggestion =
    useCallback(async (): Promise<MinkUiError | null> => {
      const prompt = memoryPromptRef.current;
      if (!prompt || prompt.status === "saving" || prompt.status === "saved") {
        return null;
      }
      setMemoryPrompt({ suggestion: prompt.suggestion, status: "saving" });
      try {
        const response = await fetch("/api/mink/memories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "save",
            id: minkRandomUuid(),
            version: 0,
            requestKey: minkRandomUuid(),
            title: prompt.suggestion.title,
            content: prompt.suggestion.content,
            kind: prompt.suggestion.kind,
            days: 90,
            confirmed: true,
          }),
        });
        if (!response.ok) throw await responseError(response);
        setMemoryPrompt({ suggestion: prompt.suggestion, status: "saved" });
        return null;
      } catch (caught) {
        const error = toUiError(caught);
        setMemoryPrompt({
          suggestion: prompt.suggestion,
          status: "failed",
          error: error.message,
        });
        return error;
      }
    }, [setMemoryPrompt]);

  const dismissMemorySuggestion = useCallback(
    () => setMemoryPrompt(null),
    [setMemoryPrompt],
  );

  const submitFeedback = useCallback(
    async (input: {
      runId: string;
      rating: MinkFeedbackRating;
      issueCategory?: MinkFeedbackIssue | null;
      details?: string;
    }): Promise<MinkUiError | null> => {
      if (!enabled || feedbackSubmittingRunId) {
        return {
          code: "feedback_unavailable",
          message: "Wait for the current feedback request to finish.",
        };
      }
      setFeedbackSubmittingRunId(input.runId);
      try {
        const response = await fetch("/api/mink/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) throw await responseError(response);
        setMessages((previous) =>
          previous.map((message) =>
            message.runId === input.runId
              ? {
                  ...message,
                  feedback: {
                    rating: input.rating,
                    issueCategory: input.issueCategory ?? null,
                  },
                }
              : message,
          ),
        );
        return null;
      } catch (caught) {
        return toUiError(caught);
      } finally {
        setFeedbackSubmittingRunId(null);
      }
    },
    [enabled, feedbackSubmittingRunId],
  );

  return {
    enabled,
    messages,
    conversations,
    activeConversationId,
    activeConversationTitle,
    input,
    setInput,
    isReplying,
    isHistoryLoading,
    deletingConversationId,
    statusText,
    streamingText,
    spokenText,
    spokenEnded,
    spokenKept,
    steps,
    error,
    feedbackSubmittingRunId,
    memoryPrompt,
    saveMemorySuggestion,
    dismissMemorySuggestion,
    send,
    sendPrepared,
    cancel,
    retry,
    reset,
    startNewChat,
    resumeOrStartFresh,
    loadConversation,
    deleteConversation,
    submitFeedback,
  };
}

/** What Mink is doing first when a message carries attachments. */
export function minkReadingStatus(attachments: MinkPendingAttachment[]) {
  const images = attachments.filter((item) => item.kind === "image").length;
  const documents = attachments.length - images;
  if (images && documents) return "Reading your attachments…";
  if (images)
    return images > 1 ? "Looking at your photos…" : "Looking at your photo…";
  return documents > 1 ? "Reading your files…" : "Reading your file…";
}

export async function consumeMinkSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: SsePayload) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let separator = buffer.match(/\r?\n\r?\n/);
    while (separator?.index !== undefined) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      emitSseBlock(block, onEvent);
      separator = buffer.match(/\r?\n\r?\n/);
    }
    if (done) break;
  }
  if (buffer.trim()) emitSseBlock(buffer, onEvent);
}

function emitSseBlock(
  block: string,
  onEvent: (event: string, data: SsePayload) => void,
) {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:"))
      dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return;
  const parsed = JSON.parse(dataLines.join("\n")) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    onEvent(event, parsed as SsePayload);
  }
}

async function responseError(response: Response): Promise<MinkUiError> {
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") {
      return {
        code:
          typeof body.code === "string" ? body.code : `http_${response.status}`,
        message: body.error,
      };
    }
  } catch {
    // Fall through to the safe status-based message.
  }
  return {
    code: `http_${response.status}`,
    message: "Mink AI couldn't start that request. Try again.",
  };
}

/** Why a message's attachments could not be read, in the merchant's words. */
function toPrepareError(error: unknown): MinkUiError {
  if (error instanceof Error && error.message)
    return { code: "attachment_failed", message: error.message };
  return toUiError(error);
}

function toUiError(error: unknown): MinkUiError {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return error as MinkUiError;
  }
  return {
    code: "mink_failed",
    message: "Mink AI couldn't complete that request. Try again.",
  };
}

function readConversationSummaries(value: unknown): MinkConversationSummary[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const conversations = (value as Record<string, unknown>).conversations;
  if (!Array.isArray(conversations)) return [];
  return conversations.flatMap((conversation) => {
    if (!conversation || typeof conversation !== "object") return [];
    const row = conversation as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.title !== "string" ||
      typeof row.lastMessageAt !== "string" ||
      typeof row.createdAt !== "string"
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        title: row.title,
        lastMessageAt: row.lastMessageAt,
        createdAt: row.createdAt,
      },
    ];
  });
}

function readConversationDetail(value: unknown): {
  id: string;
  title: string;
  messages: MinkMessage[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid conversation response.");
  }
  const conversation = (value as Record<string, unknown>).conversation;
  if (!conversation || typeof conversation !== "object") {
    throw new Error("Invalid conversation response.");
  }
  const row = conversation as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.title !== "string" ||
    !Array.isArray(row.messages)
  ) {
    throw new Error("Invalid conversation response.");
  }
  const messages = row.messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const item = message as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.text !== "string"
    ) {
      return [];
    }
    const role: MinkMessage["role"] = item.role;
    const feedback = readMinkFeedback(item.feedback);
    return [
      {
        id: item.id,
        role,
        text: item.text,
        ...(typeof item.runId === "string" ? { runId: item.runId } : {}),
        artifacts: readMinkArtifacts(item.artifacts),
        feedback,
      },
    ];
  });
  return { id: row.id, title: row.title, messages };
}

function minkBrowserContext() {
  if (typeof window === "undefined") return {};
  const selected = document.querySelector<HTMLElement>(
    "[data-mink-resource-type][data-mink-resource-id]",
  );
  const type = selected?.dataset.minkResourceType;
  const id = selected?.dataset.minkResourceId;
  const screen = readMinkScreen();
  return {
    currentPath: `${window.location.pathname}${window.location.search}`,
    ...((type === "product" || type === "order") && id
      ? { selectedResource: { type, id } }
      : {}),
    ...(screen ? { screen } : {}),
  };
}

function readMinkFeedback(value: unknown): MinkMessage["feedback"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.rating !== "helpful" && row.rating !== "unhelpful") return null;
  const issueCategory =
    row.issueCategory === "incorrect" ||
    row.issueCategory === "missing_context" ||
    row.issueCategory === "privacy" ||
    row.issueCategory === "slow" ||
    row.issueCategory === "other"
      ? row.issueCategory
      : null;
  return { rating: row.rating, issueCategory };
}

function conversationTitle(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= 80) return compact;
  return `${characters.slice(0, 77).join("").trimEnd()}…`;
}

/** Replace the step with the same sequence, else append; sorted by sequence. */
export function upsertRunStep(
  steps: MinkRunStep[],
  step: MinkRunStep,
): MinkRunStep[] {
  const next = steps.some((existing) => existing.sequence === step.sequence)
    ? steps.map((existing) =>
        existing.sequence === step.sequence ? step : existing,
      )
    : [...steps, step];
  return next.sort((a, b) => a.sequence - b.sequence).slice(0, 40);
}
