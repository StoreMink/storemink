// @vitest-environment jsdom
import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "./chat-context";
import {
  MINK_HISTORY_FOOTNOTE,
  MINK_HISTORY_SEARCH_DEBOUNCE_MS,
  MinkHistorySidebar,
} from "./mink-history-sidebar";
import type { MinkConversationSummary, MinkHistorySearch } from "./mink-ai";

vi.mock("./chat-context", () => ({ useChat: vi.fn() }));

function rows(count: number, from = 0): MinkConversationSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(from + index).padStart(12, "0")}`,
    title: `Chat ${from + index}`,
    lastMessageAt: "2026-10-26 07:00:00.123456+00",
    createdAt: "2026-10-01 00:00:00+00",
  }));
}

function chatState(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    conversations: rows(2),
    activeConversationId: null,
    isReplying: false,
    isHistoryLoading: false,
    deletingConversationId: null,
    hasMoreConversations: false,
    historyStatus: { loadingMore: false, error: null, failed: null },
    refreshConversations: vi.fn(async () => {}),
    loadMoreConversations: vi.fn(async () => {}),
    historySearchText: "",
    setHistorySearchText: vi.fn(),
    historySearch: null as MinkHistorySearch | null,
    searchConversations: vi.fn(async () => {}),
    loadMoreSearchResults: vi.fn(async () => {}),
    ...overrides,
  };
}

function searchState(
  overrides: Partial<MinkHistorySearch> = {},
): MinkHistorySearch {
  return {
    query: "zebracode",
    words: ["zebracode"],
    results: [],
    cursor: null,
    loading: false,
    loadingMore: false,
    error: null,
    ...overrides,
  };
}

const props = {
  isOverlay: true,
  onNewConversation: vi.fn(),
  onSelect: vi.fn(),
  onDelete: vi.fn(),
};
const sidebar = () => createElement(MinkHistorySidebar, props);

function withChatState(value: ReturnType<typeof chatState>) {
  vi.mocked(useChat).mockReturnValue(
    value as unknown as ReturnType<typeof useChat>,
  );
  return value;
}

beforeEach(() => {
  props.onSelect.mockReset();
  props.onDelete.mockReset();
  props.onNewConversation.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("★★ the History sidebar", () => {
  it("offers a search field a phone does not zoom into, and says how long chats are kept", () => {
    withChatState(chatState());
    render(sidebar());
    const field = screen.getByLabelText("Search chats");
    expect(field).toHaveAttribute("type", "search");
    expect(field).toHaveAttribute("placeholder", "Search chats");
    expect(field).toHaveClass("text-base", "sm:text-sm");
    expect(screen.getByText(MINK_HISTORY_FOOTNOTE)).toBeInTheDocument();
    expect(MINK_HISTORY_FOOTNOTE).toBe(
      "Chats are deleted 90 days after you last use them.",
    );
  });

  it("has no search field while Mink AI is off", () => {
    withChatState(chatState({ enabled: false }));
    render(sidebar());
    expect(screen.queryByLabelText("Search chats")).not.toBeInTheDocument();
  });

  it("★ R14: searches 300 ms after the last keystroke, a timer the text alone restarts", () => {
    vi.useFakeTimers();
    const state = withChatState(chatState({ historySearchText: "co" }));
    const view = render(sidebar());
    act(() => {
      vi.advanceTimersByTime(MINK_HISTORY_SEARCH_DEBOUNCE_MS - 100);
    });
    // A context update with the same words (an answer streaming).
    withChatState({ ...state });
    view.rerender(sidebar());
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(state.searchConversations).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Search chats"), {
      target: { value: "coupon" },
    });
    expect(state.setHistorySearchText).toHaveBeenCalledWith("coupon");
  });

  it("★ R14: keeps its words across closing and opening (they live in the chat state)", () => {
    withChatState(chatState({ historySearchText: "priya" }));
    const first = render(sidebar());
    expect(screen.getByLabelText("Search chats")).toHaveValue("priya");
    first.unmount();
    render(sidebar());
    expect(screen.getByLabelText("Search chats")).toHaveValue("priya");
  });

  it("Escape and Clear search clear the words", () => {
    const state = withChatState(chatState({ historySearchText: "coupon" }));
    render(sidebar());
    fireEvent.keyDown(screen.getByLabelText("Search chats"), {
      key: "Escape",
    });
    expect(state.setHistorySearchText).toHaveBeenLastCalledWith("");
    state.setHistorySearchText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(state.setHistorySearchText).toHaveBeenLastCalledWith("");
  });

  it("★ bolds the matched words of a snippet, and of a title by the words searched", () => {
    const result = {
      ...rows(1)[0],
      title: "Zebracode coupon ideas",
      snippet: "Your «zebracode» coupon saved 20 orders",
      matchMessageId: "message-1",
    };
    withChatState(
      chatState({
        historySearchText: "zebracode",
        historySearch: searchState({ results: [result] }),
      }),
    );
    render(sidebar());
    const bold = Array.from(document.querySelectorAll("strong")).map(
      (node) => node.textContent,
    );
    expect(bold).toEqual(["Zebracode", "zebracode"]);
    expect(
      screen.getByText(
        (_, node) =>
          node?.textContent === "Your zebracode coupon saved 20 orders" &&
          node.tagName === "SPAN",
      ),
    ).toBeInTheDocument();
  });

  it("★ choosing a result opens its chat onto the matching message; a list row opens at the newest", () => {
    const result = { ...rows(1)[0], matchMessageId: "message-7", snippet: "x" };
    withChatState(
      chatState({
        historySearch: searchState({ results: [result] }),
        historySearchText: "zebracode",
      }),
    );
    const view = render(sidebar());
    fireEvent.click(screen.getByRole("button", { name: /^Chat 0/ }));
    expect(props.onSelect).toHaveBeenCalledWith(result, {
      revealMessageId: "message-7",
    });

    withChatState(chatState());
    view.rerender(sidebar());
    fireEvent.click(screen.getByRole("button", { name: /^Chat 1/ }));
    expect(props.onSelect).toHaveBeenLastCalledWith(rows(2)[1], {});
  });

  it("says when nothing matches, and when nothing searchable was typed", () => {
    withChatState(
      chatState({ historySearch: searchState({ query: "zebra" }) }),
    );
    const view = render(sidebar());
    expect(screen.getByText("No chats match “zebra”.")).toBeInTheDocument();

    withChatState(
      chatState({ historySearch: searchState({ query: "a b", words: [] }) }),
    );
    view.rerender(sidebar());
    expect(
      screen.getByText("Type at least 2 letters or numbers."),
    ).toBeInTheDocument();
  });

  it("★ Show more chats loads the next page and goes when there is none", () => {
    const state = withChatState(chatState({ hasMoreConversations: true }));
    const view = render(sidebar());
    fireEvent.click(screen.getByRole("button", { name: "Show more chats" }));
    expect(state.loadMoreConversations).toHaveBeenCalledTimes(1);

    const searching = withChatState(
      chatState({
        historySearch: searchState({ results: rows(1), cursor: "c-1" }),
      }),
    );
    view.rerender(sidebar());
    fireEvent.click(screen.getByRole("button", { name: "Show more chats" }));
    expect(searching.loadMoreSearchResults).toHaveBeenCalledTimes(1);

    withChatState(chatState({ hasMoreConversations: false }));
    view.rerender(sidebar());
    expect(
      screen.queryByRole("button", { name: "Show more chats" }),
    ).not.toBeInTheDocument();
  });

  it("★ R18: History's failures stay here, each with Try again for what failed", () => {
    const more = withChatState(
      chatState({
        hasMoreConversations: true,
        historyStatus: {
          loadingMore: false,
          error: { code: "http_503", message: "Busy" },
          failed: "more",
        },
      }),
    );
    const view = render(sidebar());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load more chats.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(more.loadMoreConversations).toHaveBeenCalledTimes(1);

    const list = withChatState(
      chatState({
        conversations: [],
        historyStatus: {
          loadingMore: false,
          error: { code: "http_503", message: "Busy" },
          failed: "list",
        },
      }),
    );
    view.rerender(sidebar());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load your chats.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(list.refreshConversations).toHaveBeenCalledTimes(1);

    const search = withChatState(
      chatState({
        historySearch: searchState({
          error: {
            code: "history_search_timeout",
            message: "Searching your chats took too long. Try a longer word.",
          },
        }),
      }),
    );
    view.rerender(sidebar());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Searching your chats took too long. Try a longer word.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(search.searchConversations).toHaveBeenCalledTimes(1);
  });

  it("★★ R17: 50 context updates while an answer streams render no row again, with one shared date formatter", () => {
    const many = rows(300);
    const state = chatState({ conversations: many });
    withChatState(state);
    // Every row's date is one read of a formatter's `format`.
    // (`format` is an accessor on the prototype, typed as a method.)
    const format = vi.spyOn(
      Intl.DateTimeFormat.prototype as unknown as Record<"format", unknown>,
      "format",
      "get",
    );
    const view = render(sidebar());
    expect(format).toHaveBeenCalledTimes(300);
    for (let update = 0; update < 50; update += 1) {
      // A new context value each time, as the provider gives one per piece.
      withChatState({ ...state, isHistoryLoading: update % 2 === 0 });
      view.rerender(sidebar());
    }
    expect(format).toHaveBeenCalledTimes(300);
    // One formatter for all of them.
    expect(new Set(format.mock.contexts).size).toBe(1);
  });
});
