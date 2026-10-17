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
import { readStoredMinkReplyLanguage } from "@/lib/mink/reply-language";
import { readMinkScreen } from "./mink-screen";

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
  runId?: string;
  artifacts?: MinkArtifact[];
  /** What the run read or prepared, kept on the answer for this session only. */
  toolSteps?: MinkRunStep[];
  feedback?: {
    rating: MinkFeedbackRating;
    issueCategory: MinkFeedbackIssue | null;
  } | null;
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
};

/** "Remember this?" under the newest answer, and what happened to it. */
export type MinkMemoryPrompt = {
  suggestion: MinkMemorySuggestion;
  status: "offered" | "saving" | "saved" | "failed";
  error?: string;
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

  const setReplying = useCallback((value: boolean) => {
    isReplyingRef.current = value;
    setIsReplying(value);
  }, []);

  const loadConversation = useCallback(
    async (id: string) => {
      if (!enabled || isReplyingRef.current) return;
      shouldRestoreLatest.current = false;
      historyAbortController.current?.abort();
      const controller = new AbortController();
      historyAbortController.current = controller;
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
        conversationId.current = detail.id;
        setActiveConversationId(detail.id);
        setActiveConversationTitle(detail.title);
        setMessages(detail.messages);
        setMemoryPrompt(null);
        setInput("");
        setStatusText(null);
        lastFailedMessage.current = null;
      } catch (caught) {
        if (!controller.signal.aborted) setError(toUiError(caught));
      } finally {
        if (historyAbortController.current === controller) {
          historyAbortController.current = null;
          setIsHistoryLoading(false);
        }
      }
    },
    [enabled, setMemoryPrompt],
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
          !isReplyingRef.current &&
          recent[0]
        ) {
          shouldRestoreLatest.current = false;
          await loadConversation(recent[0].id);
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
          historyAbortController.current?.abort();
          conversationId.current = null;
          lastFailedMessage.current = null;
          setActiveConversationId(null);
          setActiveConversationTitle(null);
          setMessages([]);
          setInput("");
          setStatusText(null);
          if (recent[0]) await loadConversation(recent[0].id);
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
    [enabled, loadConversation],
  );

  useEffect(() => {
    if (enabled) void loadConversations(true);
    return () => {
      abortController.current?.abort();
      historyAbortController.current?.abort();
      if (replyTimer.current) clearTimeout(replyTimer.current);
    };
  }, [enabled, loadConversations]);

  const run = useCallback(
    async (text: string, appendUser: boolean) => {
      if (!text || isReplyingRef.current) return;
      shouldRestoreLatest.current = false;
      if (appendUser) {
        setMessages((previous) => [
          ...previous,
          { id: nextId.current++, role: "user", text },
        ]);
      }
      setInput("");
      setError(null);
      lastFailedMessage.current = null;
      setStatusText(enabled ? "Thinking…" : "Getting ready…");
      setStreamingText("");
      stepsRef.current = [];
      setSteps([]);
      setMemoryPrompt(null);
      setReplying(true);

      if (!enabled) {
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

      try {
        const response = await fetch("/api/mink/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            ...(conversationId.current
              ? { conversationId: conversationId.current }
              : {}),
            context: minkBrowserContext(),
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
              setActiveConversationId(data.conversationId);
              setActiveConversationTitle(
                (current) => current ?? conversationTitle(text),
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
            if (state === "running") setStreamingText("");
            setStatusText(state === "completed" ? "Thinking…" : step.status);
          } else if (event === "delta" && typeof data.text === "string") {
            const fragment = data.text;
            setStreamingText((previous) => previous + fragment);
            setStatusText("Writing…");
          } else if (event === "delta_reset") {
            setStreamingText("");
            setStatusText("Thinking…");
          } else if (event === "message" && typeof data.text === "string") {
            const responseText = data.text;
            const runId =
              typeof data.runId === "string" ? data.runId : undefined;
            receivedMessage = true;
            setMessages((previous) => [
              ...previous,
              {
                id: nextId.current++,
                role: "assistant",
                text: responseText,
                ...(runId ? { runId } : {}),
                artifacts: readMinkArtifacts(data.artifacts),
                ...(stepsRef.current.length
                  ? { toolSteps: stepsRef.current }
                  : {}),
                feedback: null,
              },
            ]);
            setStreamingText("");
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
          lastFailedMessage.current = text;
        }
      } finally {
        if (abortController.current === controller) {
          abortController.current = null;
          setStatusText(null);
          setStreamingText("");
          setSteps([]);
          setReplying(false);
        }
      }
    },
    [enabled, loadConversations, setReplying, setMemoryPrompt],
  );

  const send = useCallback(
    (raw?: string) => {
      const text = (raw ?? input).trim();
      void run(text, true);
    },
    [input, run],
  );

  const cancel = useCallback(() => {
    setStatusText("Stopping…");
    abortController.current?.abort();
  }, []);

  const retry = useCallback(() => {
    const text = lastFailedMessage.current;
    if (text) void run(text, false);
  }, [run]);

  const reset = useCallback(() => {
    shouldRestoreLatest.current = false;
    abortController.current?.abort();
    historyAbortController.current?.abort();
    if (replyTimer.current) clearTimeout(replyTimer.current);
    conversationId.current = null;
    lastFailedMessage.current = null;
    setActiveConversationId(null);
    setActiveConversationTitle(null);
    setMessages([]);
    setInput("");
    setStatusText(null);
    setStreamingText("");
    stepsRef.current = [];
    setSteps([]);
    setMemoryPrompt(null);
    setError(null);
    setIsHistoryLoading(false);
    setReplying(false);
  }, [setReplying, setMemoryPrompt]);

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
    steps,
    error,
    feedbackSubmittingRunId,
    memoryPrompt,
    saveMemorySuggestion,
    dismissMemorySuggestion,
    send,
    cancel,
    retry,
    reset,
    loadConversation,
    deleteConversation,
    submitFeedback,
  };
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
  const replyLanguage = readStoredMinkReplyLanguage();
  return {
    currentPath: `${window.location.pathname}${window.location.search}`,
    ...((type === "product" || type === "order") && id
      ? { selectedResource: { type, id } }
      : {}),
    ...(screen ? { screen } : {}),
    ...(replyLanguage !== "auto" ? { replyLanguage } : {}),
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
