// @vitest-environment jsdom
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChat } from "./chat-context";
import { MinkEarlierMessages } from "./mink-earlier-messages";
import type { MinkMessage, MinkRevealTarget } from "./mink-ai";

vi.mock("./chat-context", () => ({ useChat: vi.fn() }));

const scrollIntoView = vi.fn();

function chatState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [] as MinkMessage[],
    hasEarlierMessages: false,
    earlierStatus: { loading: false, error: null },
    loadEarlierMessages: vi.fn(async () => {}),
    revealTarget: null as MinkRevealTarget | null,
    clearRevealTarget: vi.fn(),
    ...overrides,
  };
}

function withChatState(value: ReturnType<typeof chatState>) {
  vi.mocked(useChat).mockReturnValue(
    value as unknown as ReturnType<typeof useChat>,
  );
  return value;
}

/** The thread as dashboard-chat.tsx renders it: only questions carry an id. */
function thread(messages: MinkMessage[]) {
  return createElement(
    "div",
    { className: "mink-message-scroll", "data-testid": "scroller" },
    createElement(MinkEarlierMessages),
    ...messages.map((message) =>
      createElement("div", {
        key: String(message.id),
        ...(message.role === "user"
          ? { "data-mink-message-id": String(message.id) }
          : {}),
        ref: (node: HTMLElement | null) => {
          if (node) node.scrollIntoView = scrollIntoView;
        },
      }),
    ),
  );
}

function sized(element: HTMLElement, scrollHeight: number, scrollTop: number) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  element.scrollTop = scrollTop;
}

const message = (
  id: string,
  role: "user" | "assistant",
  runId: string,
): MinkMessage => ({ id, role, text: id, runId });

afterEach(() => {
  scrollIntoView.mockReset();
  vi.restoreAllMocks();
});

describe("★★ a long chat's earlier messages", () => {
  it("offers them only while there are some", () => {
    withChatState(chatState());
    const view = render(thread([]));
    expect(
      screen.queryByRole("button", { name: "Show earlier messages" }),
    ).not.toBeInTheDocument();
    withChatState(chatState({ hasEarlierMessages: true }));
    view.rerender(thread([]));
    expect(
      screen.getByRole("button", { name: "Show earlier messages" }),
    ).toBeInTheDocument();
  });

  it("★ adds them above without moving what the merchant is reading", () => {
    const shown = [
      message("m-3", "user", "r-3"),
      message("m-4", "assistant", "r-3"),
    ];
    const state = withChatState(
      chatState({ hasEarlierMessages: true, messages: shown }),
    );
    const view = render(thread(shown));
    const scroller = screen.getByTestId("scroller");
    sized(scroller, 1000, 100); // 900 px from the bottom
    fireEvent.click(
      screen.getByRole("button", { name: "Show earlier messages" }),
    );
    expect(state.loadEarlierMessages).toHaveBeenCalledTimes(1);

    const more = [
      message("m-1", "user", "r-1"),
      message("m-2", "assistant", "r-1"),
      ...shown,
    ];
    sized(scroller, 1600, 100);
    withChatState(chatState({ hasEarlierMessages: false, messages: more }));
    view.rerender(thread(more));
    expect(scroller.scrollTop).toBe(700);
  });

  it("leaves the scroll alone when another chat opens instead", () => {
    const shown = [message("m-3", "user", "r-3")];
    withChatState(chatState({ hasEarlierMessages: true, messages: shown }));
    const view = render(thread(shown));
    const scroller = screen.getByTestId("scroller");
    sized(scroller, 1000, 100);
    fireEvent.click(
      screen.getByRole("button", { name: "Show earlier messages" }),
    );
    const other = [message("x-1", "user", "r-x")];
    sized(scroller, 400, 0);
    withChatState(chatState({ messages: other }));
    view.rerender(thread(other));
    expect(scroller.scrollTop).toBe(0);
  });

  it("says when they could not be loaded, with Try again", () => {
    const state = withChatState(
      chatState({
        hasEarlierMessages: true,
        earlierStatus: {
          loading: false,
          error: { code: "http_503", message: "Busy" },
        },
      }),
    );
    render(thread([]));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load earlier messages.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.loadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("★ R6: scrolls a search result's answer into view by the question of its run, then lets go", async () => {
    const messages = [
      message("m-1", "user", "r-1"),
      message("m-2", "assistant", "r-1"),
      message("m-3", "user", "r-2"),
      message("m-4", "assistant", "r-2"),
    ];
    const state = withChatState(
      chatState({
        messages,
        revealTarget: { messageId: "m-2", runId: "r-1", role: "assistant" },
      }),
    );
    render(thread(messages));
    await waitFor(() => expect(state.clearRevealTarget).toHaveBeenCalled());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(scrollIntoView.mock.contexts[0]).toBe(
      document.querySelector('[data-mink-message-id="m-1"]'),
    );
  });

  it("scrolls a search result's question into view by its own id", async () => {
    const messages = [
      message("m-1", "user", "r-1"),
      message("m-3", "user", "r-2"),
    ];
    const state = withChatState(
      chatState({
        messages,
        revealTarget: { messageId: "m-3", runId: "r-2", role: "user" },
      }),
    );
    render(thread(messages));
    await waitFor(() => expect(state.clearRevealTarget).toHaveBeenCalled());
    expect(scrollIntoView.mock.contexts[0]).toBe(
      document.querySelector('[data-mink-message-id="m-3"]'),
    );
  });
});
