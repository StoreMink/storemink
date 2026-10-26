"use client";

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { MINK_CONVERSATION_RETENTION_DAYS } from "@/lib/mink/chat-session";
import { historyInstant } from "@/lib/mink/chat-history-list";
import { splitSnippet, splitTitleMatches } from "@/lib/search/prefix-search";
import { useChat } from "./chat-context";
import type { MinkConversationSummary } from "./mink-ai";

// ---------------------------------------------------------------------------
// ★★ MINK AI HISTORY: every chat used in the last 90 days, newest activity
// first, loaded a page at a time as the list scrolls, and searchable (owner's
// decision, 25 Oct 2026). The state lives in useMinkAi (app/dashboard/
// mink-ai.ts); this reads it from the chat context.
//   - ★ R19: it reads `useChat()` itself, so the chat view hands it only view
//     callbacks, and never touches the destructuring that holds Stop's state.
//   - ★ R17: it re-renders with every streamed piece of an answer (it is a
//     context consumer), so its rows are memoised and its dates come from one
//     shared formatter: a long History costs nothing while Mink writes.
//   - ★ R18: History's own failures stay here, each with Try again.
// ---------------------------------------------------------------------------

/** How long the search field waits after the last keystroke. */
export const MINK_HISTORY_SEARCH_DEBOUNCE_MS = 300;

/** What the list says under itself, the rule Help states. */
export const MINK_HISTORY_FOOTNOTE = `Chats are deleted ${MINK_CONVERSATION_RETENTION_DAYS} days after you last use them.`;

type SelectOptions = { revealMessageId?: string };

export function MinkHistorySidebar({
  isOverlay,
  onNewConversation,
  onSelect,
  onDelete,
}: {
  isOverlay: boolean;
  onNewConversation: () => void;
  /** `revealMessageId`: a search result's match, which the chat opens onto. */
  onSelect: (
    conversation: MinkConversationSummary,
    options: SelectOptions,
  ) => void;
  onDelete: (conversation: MinkConversationSummary) => void;
}) {
  const {
    enabled = false,
    conversations,
    activeConversationId,
    isReplying,
    isHistoryLoading,
    deletingConversationId,
    hasMoreConversations = false,
    historyStatus = IDLE_STATUS,
    refreshConversations,
    loadMoreConversations,
    historySearchText = "",
    setHistorySearchText,
    historySearch = null,
    searchConversations,
    loadMoreSearchResults,
  } = useChat();
  const searchId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // ★ The debounce depends on the words alone (the search is a stable
  //   function), so a remounted sidebar asks again only for new words, and
  //   the search itself skips words already searched.
  useEffect(() => {
    if (!searchConversations) return;
    const timer = window.setTimeout(
      () => void searchConversations(),
      MINK_HISTORY_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [historySearchText, searchConversations]);

  const searching = historySearch !== null;
  const rows = searching ? historySearch.results : conversations;
  const words = searching ? historySearch.words : NO_WORDS;
  const more = searching ? Boolean(historySearch.cursor) : hasMoreConversations;
  const loadingMore = searching
    ? historySearch.loadingMore
    : historyStatus.loadingMore;
  const loadMore = searching ? loadMoreSearchResults : loadMoreConversations;

  // The next page loads as the end of the list scrolls into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (
      !more ||
      !sentinel ||
      !loadMore ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { root: listRef.current, rootMargin: "160px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [more, loadMore, rows.length]);

  const clearSearch = useCallback(
    () => setHistorySearchText?.(""),
    [setHistorySearchText],
  );
  const escapeClears = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || !historySearchText) return;
    event.preventDefault();
    event.stopPropagation();
    clearSearch();
  };

  const busy =
    isHistoryLoading || loadingMore || (searching && historySearch.loading);
  const failure = historyFailure();

  return (
    <aside
      aria-label="Mink AI conversations"
      className={
        isOverlay
          ? "absolute inset-y-0 left-0 z-40 flex w-[min(320px,100%)] shrink-0 flex-col overscroll-contain border-r border-[#e7e7e7] bg-[#f7f7f8] shadow-xl md:static md:z-auto md:w-72 md:shadow-none"
          : "absolute inset-y-0 left-0 z-40 flex w-[min(300px,100%)] flex-col overscroll-contain border-r border-[#e7e7e7] bg-[#f7f7f8] shadow-xl"
      }
    >
      <div className="p-3">
        <button
          type="button"
          onClick={onNewConversation}
          disabled={isReplying}
          className="flex w-full items-center gap-2 rounded-xl border border-[#dedede] bg-white px-3 py-2.5 text-left text-sm font-semibold text-[#1a1a1a] shadow-sm transition-colors hover:border-[#cfc4ff] hover:bg-[#fbfaff] disabled:opacity-50"
        >
          <MessageSquarePlus className="h-4 w-4 text-[#6d4dff]" />
          New conversation
        </button>
      </div>

      {enabled && (
        <div className="px-3 pb-2">
          <label htmlFor={searchId} className="sr-only">
            Search chats
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8c9196]"
            />
            <input
              id={searchId}
              type="search"
              value={historySearchText}
              onChange={(event) => setHistorySearchText?.(event.target.value)}
              onKeyDown={escapeClears}
              placeholder="Search chats"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-xl border border-[#dedede] bg-white py-2 pl-8 pr-9 text-base text-[#1a1a1a] placeholder:text-[#8c9196] focus:border-[#cfc4ff] focus:outline-none sm:text-sm [&::-webkit-search-cancel-button]:hidden"
            />
            {historySearchText ? (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="Clear search"
                title="Clear search"
                className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-[#8c9196] hover:bg-[#f1f1f1] hover:text-[#1a1a1a]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
        <div className="flex h-8 items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8c9196]">
          <span>{searching ? "Results" : "Recent"}</span>
          {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
        </div>
        <div ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {rows.map((conversation) => {
            const deleting = deletingConversationId === conversation.id;
            return (
              <HistoryRow
                key={conversation.id}
                conversation={conversation}
                selected={conversation.id === activeConversationId}
                deleting={deleting}
                disabled={isReplying || deleting}
                words={words}
                searching={searching}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            );
          })}
          {failure ? (
            <div
              role="alert"
              className="mx-1 mt-1 rounded-lg bg-[#fff4f4] px-3 py-2.5 text-xs leading-5 text-[#8a1c13]"
            >
              {failure.message}{" "}
              <button
                type="button"
                onClick={() => void failure.retry?.()}
                className="font-semibold underline underline-offset-2"
              >
                Try again
              </button>
            </div>
          ) : searching ? (
            historySearch.words.length === 0 ? (
              <Note>Type at least 2 letters or numbers.</Note>
            ) : !historySearch.loading && rows.length === 0 ? (
              <Note>No chats match “{historySearch.query}”.</Note>
            ) : null
          ) : rows.length === 0 && !isHistoryLoading ? (
            <Note>Your recent conversations will appear here.</Note>
          ) : null}
          {more && !failure && (
            <div ref={sentinelRef} className="px-2 pt-1">
              <button
                type="button"
                onClick={() => void loadMore?.()}
                disabled={loadingMore}
                className="w-full rounded-lg px-2 py-2 text-xs font-medium text-[#5c5f62] hover:bg-[#ededee] disabled:opacity-50"
              >
                Show more chats
              </button>
            </div>
          )}
        </div>
        <p className="px-2 pt-2 text-[11px] leading-4 text-[#8c9196]">
          {MINK_HISTORY_FOOTNOTE}
        </p>
      </div>
    </aside>
  );

  /** A failure of the list or the search, shown with Try again. */
  function historyFailure(): {
    message: string;
    retry: (() => Promise<void>) | undefined;
  } | null {
    if (historySearch) {
      if (!historySearch.error) return null;
      return {
        message: historySearch.error.message,
        // Page 1 failed (nothing found yet), or a next page did.
        retry:
          historySearch.results.length > 0
            ? loadMoreSearchResults
            : searchConversations,
      };
    }
    if (historyStatus.failed === "list")
      return {
        message: "Couldn't load your chats.",
        retry: refreshConversations,
      };
    if (historyStatus.failed === "more")
      return {
        message: "Couldn't load more chats.",
        retry: loadMoreConversations,
      };
    return null;
  }
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-5 text-center text-xs leading-5 text-[#8c9196]">
      {children}
    </div>
  );
}

const NO_WORDS: readonly string[] = [];
const IDLE_STATUS = { loadingMore: false, error: null, failed: null } as const;

/**
 * One chat in the list. ★ R17: memoised, and every prop is stable while an
 * answer streams (the row object, the booleans, the search's words and the
 * chat view's callbacks), so a long History is not rendered again with
 * every piece of the answer.
 */
const HistoryRow = memo(function HistoryRow({
  conversation,
  selected,
  deleting,
  disabled,
  words,
  searching,
  onSelect,
  onDelete,
}: {
  conversation: MinkConversationSummary;
  selected: boolean;
  deleting: boolean;
  disabled: boolean;
  /** The words searched, bolded in the title; none in the plain list. */
  words: readonly string[];
  searching: boolean;
  onSelect: (
    conversation: MinkConversationSummary,
    options: SelectOptions,
  ) => void;
  onDelete: (conversation: MinkConversationSummary) => void;
}) {
  const snippet = searching ? conversation.snippet : null;
  return (
    <div
      className={`group relative rounded-xl transition-colors ${
        selected
          ? "bg-[#eee9ff]"
          : "hover:bg-[#ededee] focus-within:bg-[#ededee]"
      }`}
    >
      <button
        type="button"
        onClick={() =>
          onSelect(
            conversation,
            searching && conversation.matchMessageId
              ? { revealMessageId: conversation.matchMessageId }
              : {},
          )
        }
        disabled={disabled}
        aria-current={selected ? "page" : undefined}
        className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 pr-10 text-left disabled:opacity-50"
      >
        <MessageSquare
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            selected ? "text-[#6d4dff]" : "text-[#8c9196]"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[#1a1a1a]">
            {splitTitleMatches(conversation.title, words).map((part, index) =>
              part.hit ? (
                <strong key={index} className="font-bold">
                  {part.text}
                </strong>
              ) : (
                <Fragment key={index}>{part.text}</Fragment>
              ),
            )}
          </span>
          {snippet ? (
            <span className="mt-0.5 line-clamp-2 block text-xs leading-4 text-[#5c5f62]">
              {splitSnippet(snippet).map((part, index) =>
                part.hit ? (
                  <strong key={index} className="font-semibold text-[#1a1a1a]">
                    {part.text}
                  </strong>
                ) : (
                  <Fragment key={index}>{part.text}</Fragment>
                ),
              )}
            </span>
          ) : null}
          <span className="mt-0.5 block text-[11px] text-[#8c9196]">
            {formatConversationDate(conversation.lastMessageAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDelete(conversation)}
        disabled={disabled}
        aria-label={`Delete ${conversation.title}`}
        title="Delete conversation"
        className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[#8c9196] transition hover:bg-white hover:text-[#b42318] focus:opacity-100 disabled:opacity-40 ${
          selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        {deleting ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
});

/** ★ One formatter for every row, made on first use (R17). */
let conversationDateFormat: Intl.DateTimeFormat | null = null;

/** A row's date: Postgres's timestamp text, read in every browser. */
export function formatConversationDate(value: string): string {
  const [time] = historyInstant(value);
  if (!Number.isFinite(time)) return "Recent";
  conversationDateFormat ??= new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return conversationDateFormat.format(time);
}
