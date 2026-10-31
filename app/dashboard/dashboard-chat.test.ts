// @vitest-environment jsdom
import { createElement, Fragment } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampMinkPanelWidth,
  DashboardChat,
  isMinkInAppLinkClick,
  isMinkScrollNearBottom,
  latestMinkUserMessageId,
  minkCheckedLine,
  minkComposerHeight,
  minkCreditIndicatorState,
  minkCreditWarning,
  minkHistoryStartsOpen,
  minkTurnAnchorSpace,
  revampIdsShownBefore,
  shouldSubmitMinkComposer,
} from "./dashboard-chat";
import { MINK_MAX_RUN_CREDITS } from "@/lib/mink/metering";
import type { RevampArtifact, RevampStatus } from "@/lib/mink/revamp/contract";
import { useChat } from "./chat-context";
import { addSavedMinkMediaReference } from "@/lib/mink/media-attachment";

const voiceChat = vi.hoisted(() => ({
  value: {
    enabled: false,
    state: "idle",
    mic: "closed",
    support: { ok: true },
    levelRef: { current: 0 },
    heard: null as string | null,
    said: null as string | null,
    notice: null as string | null,
    toggle: vi.fn(),
    noteSend: vi.fn(),
    registerComposer: vi.fn(() => () => {}),
  },
}));
vi.mock("./chat-context", () => ({
  useChat: vi.fn(),
  useMinkVoice: vi.fn(() => voiceChat.value),
}));
// A plain anchor stands in for next/link, so a click can be observed without
// an app router: it runs the link's own onClick and stops the browser there.
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({
      href,
      onClick,
      children,
      ...rest
    }: {
      href: string;
      onClick?: (event: { preventDefault(): void }) => void;
      children?: unknown;
    }) =>
      h(
        "a",
        {
          ...rest,
          href,
          onClick: (event: { preventDefault(): void }) => {
            onClick?.(event);
            event.preventDefault();
          },
        },
        children as never,
      ),
  };
});
const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: routerPush })),
  usePathname: vi.fn(() => "/dashboard"),
}));

const baseChatState = {
  isChatOpen: true,
  isExpanded: true,
  canSaveMedia: true,
  closeChat: vi.fn(),
  toggleExpand: vi.fn(),
  messages: [],
  conversations: [],
  activeConversationId: null,
  activeConversationTitle: null,
  input: "",
  setInput: vi.fn(),
  isReplying: false,
  isHistoryLoading: false,
  deletingConversationId: null,
  statusText: null,
  error: null,
  feedbackSubmittingRunId: null,
  minkCredits: null,
  send: vi.fn(),
  sendPrepared: vi.fn(() => true),
  cancel: vi.fn(),
  retry: vi.fn(),
  reset: vi.fn(),
  startNewChat: vi.fn(),
  addressOpens: 0,
  showSpotlight: vi.fn(),
  loadConversation: vi.fn(),
  deleteConversation: vi.fn(),
  submitFeedback: vi.fn(),
  // Chat history (the sidebar and the earlier messages read these).
  enabled: true,
  hasMoreConversations: false,
  historyStatus: { loadingMore: false, error: null, failed: null },
  refreshConversations: vi.fn(),
  loadMoreConversations: vi.fn(),
  historySearchText: "",
  setHistorySearchText: vi.fn(),
  historySearch: null,
  searchConversations: vi.fn(),
  loadMoreSearchResults: vi.fn(),
  hasEarlierMessages: false,
  earlierStatus: { loading: false, error: null },
  loadEarlierMessages: vi.fn(),
  revealTarget: null,
  clearRevealTarget: vi.fn(),
};

const scrollIntoView = vi.fn();
const scrollTo = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  scrollTo.mockReset();
  scrollIntoView.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  // ⚠ jsdom reports 0 for every clientHeight, and the tail room is now measured
  // from the scroller rather than expressed as a percentage — so without this
  // the reservation is a truthful "0px" and the assertion below proves nothing.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    value: 600,
  });
  vi.mocked(useChat).mockReturnValue(
    baseChatState as unknown as ReturnType<typeof useChat>,
  );
  voiceChat.value.enabled = false;
  voiceChat.value.notice = null;
  voiceChat.value.said = null;
  voiceChat.value.heard = null;
  voiceChat.value.state = "idle";
});

describe("★★ voice chat happens inside the chat", () => {
  it("keeps the thread and its cards on screen, with the voice bar in the composer's place", () => {
    // Owner's decision (2026-10-20): Mink said "check the review card" while
    // a full-screen voice view hid the thread, so there was nothing to check.
    voiceChat.value.enabled = true;
    voiceChat.value.state = "speaking";
    voiceChat.value.said = "Your storefront card is ready.";
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        { id: "u1", role: "user", text: "Personalise my storefront" },
        {
          id: "a1",
          role: "assistant",
          text: "Your card is ready: review it and apply.",
          artifacts: [
            {
              type: "navigation" as const,
              title: "Website Builder",
              path: "/dashboard/builder",
              label: "Open Website Builder",
            },
          ],
        },
      ],
      isReplying: true,
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));
    // The conversation and its card stay usable while Mink talks.
    expect(screen.getByTestId("mink-message-scroller")).toBeInTheDocument();
    expect(screen.getByText("Personalise my storefront")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open Website Builder/i }),
    ).toHaveAttribute("href", "/dashboard/builder");
    const bar = screen.getByRole("region", { name: "Voice chat with Mink" });
    expect(bar).toHaveTextContent("Speaking…");
    expect(bar).toHaveTextContent("Your storefront card is ready.");
    // No way into the history while talking.
    expect(
      screen.queryByRole("button", { name: /conversation sidebar/i }),
    ).toBeNull();
    // The composer survives (its draft and staged uploads with it) but is
    // out of the way; the bar's buttons are the voice controls.
    const composer = screen.getByLabelText("Mink AI composer");
    expect(composer.closest("[hidden]")).not.toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Stop Mink AI" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop voice chat" }));
    expect(voiceChat.value.toggle).toHaveBeenCalledOnce();
  });

  it("shows the composer again, and no voice bar, once voice chat is off", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        { id: "u1", role: "user", text: "How many orders today?" },
        { id: "a1", role: "assistant", text: "Twelve orders today." },
      ],
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.queryByTestId("mink-voice-bar")).toBeNull();
    expect(
      screen.getByLabelText("Mink AI composer").closest("[hidden]"),
    ).toBeNull();
  });

  it("shows the loop's notice above the composer once voice chat is off", () => {
    voiceChat.value.notice = "Voice chat turned off: nothing was heard.";
    render(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.queryByTestId("mink-voice-bar")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Voice chat turned off: nothing was heard.",
    );
  });
});

describe("Mink full view", () => {
  it("keeps the Builder panel above the fixed canvas without changing ordinary dashboard layout", () => {
    const css = readFileSync(
      join(process.cwd(), "app/dashboard/dashboard.css"),
      "utf8",
    );
    const rule = css.match(
      /\.dashboard-shell:has\(\.sm-builder\) \.dash-chat\s*\{([^}]+)\}/,
    )?.[1];
    expect(rule).toContain("position: fixed");
    expect(rule).toContain("top: 56px");
    expect(rule).toContain("right: 0");
    expect(rule).toContain("bottom: 0");
    expect(rule).toContain("z-index: 45");
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      isExpanded: false,
      input: "Make this look better on mobile",
    } as unknown as ReturnType<typeof useChat>);
    const view = render(createElement(DashboardChat, { variant: "panel" }));
    expect(screen.getByTestId("mink-chat-surface")).toHaveClass("dash-chat");
    expect(screen.getByLabelText("Message Mink AI")).toHaveValue(
      "Make this look better on mobile",
    );
    expect(
      screen.getByRole("separator", { name: "Resize Mink AI panel" }),
    ).toBeInTheDocument();
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      isChatOpen: false,
    } as unknown as ReturnType<typeof useChat>);
    view.rerender(createElement(DashboardChat, { variant: "panel" }));
    expect(screen.queryByTestId("mink-chat-surface")).not.toBeInTheDocument();
  });

  it("covers the entire viewport above the dashboard chrome", () => {
    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(screen.getByTestId("mink-chat-surface")).toHaveClass(
      "fixed",
      "inset-0",
      "z-[90]",
      "h-[100dvh]",
      "max-w-full",
    );
  });

  it("starts without the in-flow history column on a phone", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });

    render(createElement(DashboardChat, { variant: "overlay" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Show conversation sidebar" }),
      ).toHaveAttribute("aria-expanded", "false"),
    );
    expect(
      screen.queryByRole("complementary", {
        name: "Mink AI conversations",
      }),
    ).not.toBeInTheDocument();
  });

  describe("★★ chat history in the full view (26 Oct 2026)", () => {
    const chats = [
      {
        id: "chat-a",
        title: "Diwali coupon",
        lastMessageAt: "2026-10-24T10:00:00.000Z",
        createdAt: "2026-10-24T09:00:00.000Z",
        hasRedesignCard: false,
      },
      {
        id: "chat-b",
        title: "Storefront redesign",
        lastMessageAt: "2026-10-23T10:00:00.000Z",
        createdAt: "2026-10-23T09:00:00.000Z",
        hasRedesignCard: true,
      },
    ];
    const history = () =>
      screen.queryByRole("complementary", { name: "Mink AI conversations" });
    let view: ReturnType<typeof render>;
    async function openHistory(width: number) {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: width,
      });
      vi.mocked(useChat).mockReturnValue({
        ...baseChatState,
        conversations: chats,
      } as unknown as ReturnType<typeof useChat>);
      view = render(createElement(DashboardChat, { variant: "overlay" }));
      const toggle = await screen.findByRole("button", {
        name: /conversation sidebar/,
      });
      // The full view decides in a frame whether History starts open.
      await act(async () => {
        await new Promise((resolve) =>
          window.requestAnimationFrame(() => resolve(null)),
        );
      });
      expect(toggle).toHaveAttribute(
        "aria-expanded",
        minkHistoryStartsOpen(width) ? "true" : "false",
      );
      if (toggle.getAttribute("aria-expanded") !== "true")
        fireEvent.click(toggle);
      return screen.findByRole("complementary", {
        name: "Mink AI conversations",
      });
    }
    const row = (sidebar: HTMLElement, title: string) =>
      Array.from(sidebar.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith(title),
      )!;

    it("★ R14: on a phone, choosing a chat closes History so the chat is not left under it", async () => {
      const sidebar = await openHistory(390);
      fireEvent.click(row(sidebar, "Diwali coupon"));
      expect(baseChatState.loadConversation).toHaveBeenCalledWith("chat-a");
      expect(history()).not.toBeInTheDocument();
    });

    it("on a phone, New conversation closes it too", async () => {
      const sidebar = await openHistory(390);
      fireEvent.click(
        Array.from(sidebar.querySelectorAll("button")).find(
          (button) => button.textContent === "New conversation",
        )!,
      );
      expect(history()).not.toBeInTheDocument();
    });

    it("on a wide screen, History stays beside the chat chosen", async () => {
      const sidebar = await openHistory(1280);
      fireEvent.click(row(sidebar, "Diwali coupon"));
      expect(history()).toBeInTheDocument();
    });

    it("★ the delete dialog says approved work stays, and names the redesign card only where there is one", async () => {
      const sidebar = await openHistory(1280);
      fireEvent.click(
        screen.getByRole("button", { name: "Delete Diwali coupon" }),
      );
      expect(screen.getByRole("alertdialog")).toHaveTextContent(
        "“Diwali coupon” and its messages will be permanently deleted. Changes you approved or published from this chat stay in your store.",
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(sidebar).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "Delete Storefront redesign" }),
      );
      expect(screen.getByRole("alertdialog")).toHaveTextContent(
        "“Storefront redesign” and its messages will be permanently deleted, along with its storefront redesign card, so you can no longer apply or undo that redesign from Mink AI. Changes you approved or published from this chat stay in your store.",
      );
    });

    it("★ the delete dialog reads History again and names a redesign card that became ready after the list was read", async () => {
      vi.mocked(baseChatState.refreshConversations).mockClear();
      await openHistory(1280);
      fireEvent.click(
        screen.getByRole("button", { name: "Delete Diwali coupon" }),
      );
      expect(baseChatState.refreshConversations).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alertdialog")).toHaveTextContent(
        "“Diwali coupon” and its messages will be permanently deleted. Changes you approved or published from this chat stay in your store.",
      );
      // History's first page comes back: the chat's redesign card is ready now.
      vi.mocked(useChat).mockReturnValue({
        ...baseChatState,
        conversations: chats.map((chat) =>
          chat.id === "chat-a" ? { ...chat, hasRedesignCard: true } : chat,
        ),
      } as unknown as ReturnType<typeof useChat>);
      view.rerender(createElement(DashboardChat, { variant: "overlay" }));
      expect(screen.getByRole("alertdialog")).toHaveTextContent(
        "“Diwali coupon” and its messages will be permanently deleted, along with its storefront redesign card, so you can no longer apply or undo that redesign from Mink AI. Changes you approved or published from this chat stay in your store.",
      );
    });
  });

  it("uses a contained message scroller and a no-zoom mobile composer", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [{ id: "user-1", role: "user", text: "Hi" }],
    } as unknown as ReturnType<typeof useChat>);

    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(screen.getByTestId("mink-message-scroller")).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
      "overscroll-contain",
    );
    expect(screen.getByLabelText("Message Mink AI")).toHaveClass(
      "min-w-0",
      "text-base",
    );
  });

  it("shows StoreMink attribution and an inspectable live Mink credit balance below the composer", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      minkCredits: {
        used: 8,
        cap: 20,
        creditBalance: 5,
        resetsAt: "2026-10-15T06:30:00.000Z",
      },
    } as unknown as ReturnType<typeof useChat>);

    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(
      screen.getByText(
        (_content, node) =>
          node?.tagName === "SPAN" &&
          node.textContent?.replace(/\s+/g, " ").trim() ===
            "Powered by StoreMink",
      ),
    ).toBeVisible();
    const balance = screen.getByRole("button", {
      name: "17 Mink credits left",
    });
    expect(balance).toBeVisible();
    fireEvent.click(balance);
    expect(
      screen.getByRole("dialog", { name: "Mink credit balance" }),
    ).toHaveTextContent("12 included + 5 top-up remaining");
    expect(
      screen.getByRole("link", { name: "View credits and usage" }),
    ).toHaveAttribute("href", "/dashboard/plans");
  });

  it("keeps a submitted question at the top while a long answer grows below it", async () => {
    const send = vi.fn();
    const previousMessages = [
      { id: "user-1", role: "user" as const, text: "Hi" },
      {
        id: "assistant-1",
        role: "assistant" as const,
        text: "How can I help?",
      },
    ];
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: previousMessages,
      input: "How can I add my own domain?",
      send,
    } as unknown as ReturnType<typeof useChat>);
    const view = render(createElement(DashboardChat, { variant: "overlay" }));

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(send).toHaveBeenCalledTimes(1);

    const submittedMessages = [
      ...previousMessages,
      {
        id: "user-2",
        role: "user" as const,
        text: "How can I add my own domain?",
      },
    ];
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: submittedMessages,
      input: "",
      isReplying: true,
      statusText: "Thinking…",
      send,
    } as unknown as ReturnType<typeof useChat>);
    view.rerender(createElement(DashboardChat, { variant: "overlay" }));

    const submittedRow = screen
      .getByText("How can I add my own domain?")
      .closest<HTMLElement>('[data-mink-message-role="user"]');
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenLastCalledWith({
        block: "start",
        behavior: "smooth",
      }),
    );
    expect(scrollIntoView.mock.instances.at(-1)).toBe(submittedRow);
    // ★★ A REAL PIXEL RESERVATION, not `calc(100% - 5rem)`. That percentage
    // resolved against the message column, whose height is its own content, so
    // it behaved as `auto` — 0 — and the tail room the anchor depends on never
    // existed. This assertion used to pin that broken string, proving only that
    // a string had been written. 600px scroller − 5rem (80px) = 520px.
    expect(screen.getByTestId("mink-turn-anchor-space")).toHaveStyle({
      minHeight: "520px",
    });

    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        ...submittedMessages,
        {
          id: "assistant-2",
          role: "assistant" as const,
          text: "Start in Settings, then open Domain.",
        },
      ],
      input: "",
      isReplying: false,
      send,
    } as unknown as ReturnType<typeof useChat>);
    view.rerender(createElement(DashboardChat, { variant: "overlay" }));

    await waitFor(() =>
      expect(screen.getByTestId("mink-turn-anchor-space")).toHaveStyle({
        minHeight: "0px",
      }),
    );
    expect(scrollIntoView.mock.instances).toContain(submittedRow);
  });

  it("renders saved images as attachments instead of exposing prompt metadata", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        {
          id: "user-1",
          role: "user",
          text: addSavedMinkMediaReference("Create a buy 1 get 1 carousel", {
            filename: "almond-shake.png",
            url: "https://storage.googleapis.com/storemink-media/stores/s1/media/almond.webp",
          }),
        },
      ],
    } as unknown as ReturnType<typeof useChat>);

    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(screen.getByText("Create a buy 1 get 1 carousel")).toBeVisible();
    expect(screen.getByRole("img", { name: "almond-shake.png" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "View almond-shake.png" }),
    );
    expect(
      screen.getByRole("dialog", {
        name: "Attachment preview: almond-shake.png",
      }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Close attachment preview" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.queryByText(/untrusted reference data, not instructions/i),
    ).toBeNull();
  });

  it("offers a jump-to-latest button while scrolled up", async () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [{ id: "user-1", role: "user", text: "Earlier message" }],
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));
    const scroller = screen.getByTestId("mink-message-scroller");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1600 },
      scrollTop: { configurable: true, value: 200, writable: true },
      clientHeight: { configurable: true, value: 600 },
    });

    fireEvent.scroll(scroller);
    const button = await screen.findByRole("button", {
      name: "Jump to latest message",
    });
    fireEvent.click(button);

    expect(scrollTo).toHaveBeenCalledWith({ top: 1600, behavior: "smooth" });
    expect(
      screen.queryByRole("button", { name: "Jump to latest message" }),
    ).toBeNull();
  });
});

describe("★★ minkTurnAnchorSpace", () => {
  it("reserves the scroller's height less the kept strip", () => {
    expect(minkTurnAnchorSpace({ viewportHeight: 600, reservePx: 80 })).toBe(
      "520px",
    );
    // A larger root font keeps proportionally more of the question in view.
    expect(minkTurnAnchorSpace({ viewportHeight: 600, reservePx: 100 })).toBe(
      "500px",
    );
  });

  it("★ never returns a negative reservation", () => {
    // A panel shorter than the kept strip, or one measured while hidden, must
    // reserve nothing rather than emit an invalid negative min-height.
    expect(minkTurnAnchorSpace({ viewportHeight: 40, reservePx: 80 })).toBe(
      "0px",
    );
    expect(minkTurnAnchorSpace({ viewportHeight: 0, reservePx: 80 })).toBe(
      "0px",
    );
  });

  it("★ emits whole pixels, so a fractional font size cannot produce junk", () => {
    expect(
      minkTurnAnchorSpace({ viewportHeight: 611.5, reservePx: 82.5 }),
    ).toBe("529px");
  });
});

describe("Mink credit indicator", () => {
  const summary = {
    cap: 20,
    creditBalance: 0,
    resetsAt: "2026-10-15T06:30:00.000Z",
  };

  it("moves from green to yellow to red as usable credits run out", () => {
    expect(minkCreditIndicatorState({ ...summary, used: 5 }).color).toBe(
      "#16a34a",
    );
    expect(minkCreditIndicatorState({ ...summary, used: 14 }).color).toBe(
      "#f59e0b",
    );
    expect(minkCreditIndicatorState({ ...summary, used: 18 }).color).toBe(
      "#dc2626",
    );
  });

  it("includes non-expiring top-ups in the displayed balance", () => {
    expect(
      minkCreditIndicatorState({
        ...summary,
        used: 20,
        creditBalance: 7,
      }),
    ).toMatchObject({ includedLeft: 0, totalLeft: 7 });
  });
});

describe("minkHistoryStartsOpen", () => {
  it("keeps history closed on compact screens and open beside desktop chat", () => {
    expect(minkHistoryStartsOpen(390)).toBe(false);
    expect(minkHistoryStartsOpen(767)).toBe(false);
    expect(minkHistoryStartsOpen(768)).toBe(true);
    expect(minkHistoryStartsOpen(1440)).toBe(true);
  });
});

describe("isMinkScrollNearBottom", () => {
  it("follows streaming output only while the reader remains near the end", () => {
    expect(
      isMinkScrollNearBottom({
        scrollHeight: 1200,
        scrollTop: 744,
        clientHeight: 400,
      }),
    ).toBe(true);
    expect(
      isMinkScrollNearBottom({
        scrollHeight: 1200,
        scrollTop: 500,
        clientHeight: 400,
      }),
    ).toBe(false);
  });
});

describe("latestMinkUserMessageId", () => {
  it("selects the question that owns the newest answer", () => {
    expect(
      latestMinkUserMessageId([
        { id: "u1", role: "user" },
        { id: "a1", role: "assistant" },
        { id: "u2", role: "user" },
        { id: "a2", role: "assistant" },
      ]),
    ).toBe("u2");
    expect(latestMinkUserMessageId([])).toBeNull();
  });
});

describe("Mink compact scroll ownership", () => {
  it("pins the phone drawer to the viewport and locks the dashboard behind it", () => {
    const css = readFileSync(
      join(process.cwd(), "app/dashboard/dashboard.css"),
      "utf8",
    );

    expect(css).toContain("@media (max-width: 639px)");
    expect(css).toContain("width: 100vw;");
    expect(css).toContain("height: 100dvh;");
    expect(css).toContain(
      ".dashboard-frame:has(.mink-chat-surface) .dash-content",
    );
    expect(css).toContain(".dashboard-shell .mink-message-scroll");
    expect(css).toContain("overscroll-behavior-y: contain;");
  });
});

describe("clampMinkPanelWidth", () => {
  it("keeps desktop resizing within the usable dashboard range", () => {
    expect(clampMinkPanelWidth(100, 1920)).toBe(320);
    expect(clampMinkPanelWidth(900, 1920)).toBe(720);
    expect(clampMinkPanelWidth(512, 1920)).toBe(512);
  });

  it("keeps the overlay inside a small viewport", () => {
    expect(clampMinkPanelWidth(720, 390)).toBe(358);
    expect(clampMinkPanelWidth(100, 300)).toBe(276);
  });
});

describe("Mink composer", () => {
  it("grows with wrapped content and caps before becoming scrollable", () => {
    expect(minkComposerHeight(8)).toBe(24);
    expect(minkComposerHeight(96.2)).toBe(97);
    expect(minkComposerHeight(400)).toBe(160);
  });

  it("submits on Enter while preserving Shift+Enter and IME composition", () => {
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe(true);
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
      }),
    ).toBe(false);
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe(false);
  });
});

describe("★★ minkCreditWarning", () => {
  const summary = (cap: number | null, used: number, creditBalance = 0) => ({
    cap,
    used,
    creditBalance,
    resetsAt: "2026-10-01T00:00:00.000Z",
  });

  it("says nothing while there is room for the heaviest run", () => {
    expect(minkCreditWarning(summary(300, 0))).toBeNull();
    expect(minkCreditWarning(summary(20, 12))).toBeNull();
  });

  // ★★ ABSOLUTE CREDITS, NOT A FRACTION. The ring turns amber at 20%, which is
  // 60 credits on Pro — not low — and 4 on Free. What decides whether the next
  // request fits is the heaviest band, and that is the same number for both.
  it("warns the same way on a big plan and a small one", () => {
    const pro = minkCreditWarning(summary(300, 295));
    const free = minkCreditWarning(summary(20, 15));
    expect(pro?.level).toBe("low");
    expect(free?.level).toBe("low");
    expect(pro?.message).toBe(free?.message);
  });

  it("scales with the heaviest band rather than a literal", () => {
    expect(
      minkCreditWarning(summary(300, 300 - MINK_MAX_RUN_CREDITS)),
    ).toBeNull();
    expect(
      minkCreditWarning(summary(300, 300 - MINK_MAX_RUN_CREDITS + 1))?.level,
    ).toBe("low");
  });

  // ⚠ 1-7 credits is NOT blocked: minkRunAffordability allows a run whenever
  //   anything is left and settlement clamps. Saying "blocked" here would be a
  //   lie the server contradicts a second later.
  it("does not claim a low balance is blocked", () => {
    expect(minkCreditWarning(summary(20, 19))?.level).toBe("low");
    expect(minkCreditWarning(summary(20, 20))?.level).toBe("empty");
  });

  it("counts purchased credits, not only the plan allowance", () => {
    expect(minkCreditWarning(summary(20, 20, 50))).toBeNull();
    expect(minkCreditWarning(summary(20, 20, 2))?.level).toBe("low");
  });

  // ⚠ cap null is an unmetered plan AND what a failed read looks like; neither
  //   should produce a warning.
  it("stays silent on an unmetered plan", () => {
    expect(minkCreditWarning(summary(null, 0))).toBeNull();
  });
});

describe("★★ panel chrome density", () => {
  const withAnswer = {
    ...baseChatState,
    activeConversationTitle: "Which blogs are there?",
    messages: [
      { id: "u1", role: "user", text: "which blogs are there?" },
      {
        id: "a1",
        role: "assistant",
        text: "Here are your blogs.",
        runId: "r1",
      },
    ],
  };

  // ★★ The header carried 8 things in a ~380px panel, so the conversation
  // title truncated to "whic…". Memories and Watches are destinations, not
  // reading controls, so they sit behind one overflow.
  it("keeps Memories and Watches out of the header bar", () => {
    render(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.queryByRole("link", { name: "Memories" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Watches" })).toBeNull();
    const menu = screen.getByRole("button", { name: "Mink options" });
    expect(menu).toBeVisible();
    fireEvent.click(menu);
    expect(screen.getByRole("menuitem", { name: "Memories" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Watches" })).toBeVisible();
  });

  it("closes that menu on Escape", () => {
    render(createElement(DashboardChat, { variant: "overlay" }));
    fireEvent.click(screen.getByRole("button", { name: "Mink options" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: "Memories" })).toBeNull();
  });

  // ★ The wordmark said what the avatar beside it already said, and cost the
  //   title the width it needed.
  it("shows the conversation title without a wordmark above it", () => {
    vi.mocked(useChat).mockReturnValue(
      withAnswer as unknown as ReturnType<typeof useChat>,
    );
    render(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.getByText("Which blogs are there?")).toBeVisible();
    // The name survives in the empty state and the composer label, never as a
    // header wordmark stacked on the title.
    expect(screen.queryByText("Mink AI", { selector: "header *" })).toBeNull();
  });

  // ★ ChatGPT and Claude call a chat "New chat" until its title arrives.
  it("calls a chat with no title yet New chat", () => {
    render(createElement(DashboardChat, { variant: "overlay" }));
    expect(
      screen.getByText("New chat", { selector: "header *" }),
    ).toBeVisible();
    expect(
      screen.queryByText("New conversation", { selector: "header *" }),
    ).toBeNull();
  });

  // ★★ Alignment already says who is speaking, so stamping every answer with
  //    the name is repetition down the length of a thread.
  it("does not label each answer with the assistant name", () => {
    vi.mocked(useChat).mockReturnValue(
      withAnswer as unknown as ReturnType<typeof useChat>,
    );
    render(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.getByText("Here are your blogs.")).toBeVisible();
    expect(screen.queryByText("Mink AI")).toBeNull();
  });
});

describe("★★ streamed answers in the panel", () => {
  it("shows the tool ladder and the answer so far while Mink is still writing", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        { id: "user-1", role: "user" as const, text: "How are sales?" },
      ],
      isReplying: true,
      statusText: "Writing…",
      streamingText: "Sales are **up**",
      steps: [
        {
          sequence: 1,
          name: "get_store_profile",
          label: "store details",
          status: "Read store details",
          state: "completed" as const,
        },
        {
          sequence: 2,
          name: "get_sales_summary",
          label: "sales",
          status: "Reading sales…",
          state: "running" as const,
        },
      ],
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));

    const pending = screen.getByTestId("mink-pending-answer");
    // ★ One polite live region for the whole pending row: the answer is
    //   announced as it streams, and the status is not announced twice.
    expect(pending).toHaveAttribute("aria-live", "polite");
    expect(pending.querySelector('[role="status"]')).toBeNull();
    expect(pending).toHaveTextContent("Read store details");
    expect(pending).toHaveTextContent("Reading sales…");
    expect(pending).toHaveTextContent("Sales are up");
    expect(pending).toHaveTextContent("Writing…");
    const details = screen.getByText("1 earlier step").closest("details")!;
    expect(details.open).toBe(false);
    expect(screen.getByText("Reading sales…")).toBeVisible();
    expect(screen.getByText("Read store details")).not.toBeVisible();
    fireEvent.click(details.querySelector("summary")!);
    expect(screen.getByText("Read store details")).toBeVisible();
  });

  it("labels a finished answer with what was checked, in merchant words", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        { id: "user-1", role: "user" as const, text: "How are sales?" },
        {
          id: "assistant-1",
          role: "assistant" as const,
          text: "Up 12%.",
          toolSteps: [
            {
              sequence: 1,
              name: "get_sales_summary",
              label: "sales",
              status: "Read sales",
              state: "completed" as const,
            },
          ],
        },
      ],
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.getByText("Checked sales")).toBeInTheDocument();
  });
});

describe("minkCheckedLine", () => {
  it("lists completed reads once each, drops articles, and caps the list", () => {
    const step = (
      name: string,
      label: string,
      state: "completed" | "failed",
    ) => ({
      sequence: 1,
      name,
      label,
      status: "",
      state,
    });
    expect(minkCheckedLine(undefined)).toBeNull();
    expect(minkCheckedLine([step("a", "the catalogue", "failed")])).toBeNull();
    expect(
      minkCheckedLine([
        step("a", "the catalogue", "completed"),
        step("b", "sales", "completed"),
        step("c", "sales", "completed"),
      ]),
    ).toBe("Checked catalogue and sales");
    expect(
      minkCheckedLine(
        ["a", "b", "c", "d", "e", "f"].map((label) =>
          step(label, label, "completed"),
        ),
      ),
    ).toBe("Checked a, b, c and d and 2 more");
  });
});

describe("★ Remember this?", () => {
  const prompt = {
    suggestion: {
      title: "From now on, always keep answers short",
      content: "From now on, always keep answers short.",
      kind: "preference" as const,
    },
    status: "offered" as const,
  };
  const thread = [
    {
      id: 1,
      role: "user" as const,
      text: "From now on, always keep answers short.",
    },
    { id: 2, role: "assistant" as const, text: "Understood." },
  ];

  it("offers the exact sentence under the newest answer and saves on one tap", () => {
    const saveMemorySuggestion = vi.fn(async () => null);
    const dismissMemorySuggestion = vi.fn();
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: thread,
      memoryPrompt: prompt,
      saveMemorySuggestion,
      dismissMemorySuggestion,
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));
    const card = screen.getByTestId("mink-memory-prompt");
    expect(card).toHaveTextContent("Remember this?");
    expect(card).toHaveTextContent("From now on, always keep answers short.");
    expect(card).toHaveTextContent("Preference");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMemorySuggestion).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(dismissMemorySuggestion).toHaveBeenCalledOnce();
  });

  it("confirms a save with a link to the Memories page, and shows nothing while Mink is still replying", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: thread,
      memoryPrompt: { ...prompt, status: "saved" },
    } as unknown as ReturnType<typeof useChat>);
    const view = render(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.getByTestId("mink-memory-prompt")).toHaveTextContent(
      "Saved to your memories.",
    );
    expect(
      screen.getByRole("link", { name: "Manage memories" }),
    ).toHaveAttribute("href", "/dashboard/mink-memories");
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: thread,
      memoryPrompt: prompt,
      isReplying: true,
    } as unknown as ReturnType<typeof useChat>);
    view.rerender(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.queryByTestId("mink-memory-prompt")).not.toBeInTheDocument();
  });
});

describe("★★ a followed link leaves the full view", () => {
  const ORIGIN = "https://echoss.storemink.com";
  const clickOn = (html: string, overrides: Partial<MouseEvent> = {}) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    const target = host.querySelector("[data-hit]") ?? host.firstElementChild;
    return isMinkInAppLinkClick(
      {
        target,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...overrides,
      },
      ORIGIN,
    );
  };

  it("counts a plain click on a dashboard link, including one inside the link", () => {
    expect(clickOn('<a href="/dashboard/orders?q=ORD1">ORD1</a>')).toBe(true);
    expect(clickOn('<a href="/dashboard">Home</a>')).toBe(true);
    expect(
      clickOn(
        '<a href="/dashboard/products/p1"><span data-hit>Shoe</span></a>',
      ),
    ).toBe(true);
    expect(clickOn(`<a href="${ORIGIN}/dashboard/orders">Orders</a>`)).toBe(
      true,
    );
  });

  it("ignores new-tab, modified, download and off-dashboard clicks", () => {
    const link = '<a href="/dashboard/orders">Orders</a>';
    expect(clickOn('<a href="/dashboard/orders" target="_blank">x</a>')).toBe(
      false,
    );
    expect(clickOn('<a href="/dashboard/orders" download>x</a>')).toBe(false);
    expect(clickOn(link, { metaKey: true })).toBe(false);
    expect(clickOn(link, { ctrlKey: true })).toBe(false);
    expect(clickOn(link, { shiftKey: true })).toBe(false);
    expect(clickOn(link, { button: 1 })).toBe(false);
    expect(clickOn('<a href="/shop/almond-shake">Shop</a>')).toBe(false);
    expect(clickOn('<a href="/dashboardish">x</a>')).toBe(false);
    expect(
      clickOn('<a href="https://help.storemink.com/dashboard/x">Help</a>'),
    ).toBe(false);
    expect(clickOn("<button data-hit>Send</button>")).toBe(false);
  });

  const withLink = (isExpanded: boolean) =>
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      isExpanded,
      messages: [
        {
          id: "assistant-1",
          role: "assistant" as const,
          text: "The oldest is [ORD101010726](/dashboard/orders?q=ORD101010726).",
        },
      ],
    } as unknown as ReturnType<typeof useChat>);

  it("collapses the full view to the side panel when an answer link is clicked", () => {
    withLink(true);
    render(createElement(DashboardChat, { variant: "overlay" }));
    fireEvent.click(screen.getByRole("link", { name: "ORD101010726" }));
    expect(baseChatState.toggleExpand).toHaveBeenCalledTimes(1);
    expect(baseChatState.closeChat).not.toHaveBeenCalled();
  });

  it("closes the chat on a phone, where any surface covers the page", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    withLink(false);
    render(createElement(DashboardChat, { variant: "panel" }));
    fireEvent.click(screen.getByRole("link", { name: "ORD101010726" }));
    expect(baseChatState.closeChat).toHaveBeenCalledTimes(1);
    expect(baseChatState.toggleExpand).not.toHaveBeenCalled();
  });

  it("leaves the desktop side panel open, beside the page it opened", () => {
    withLink(false);
    render(createElement(DashboardChat, { variant: "panel" }));
    fireEvent.click(screen.getByRole("link", { name: "ORD101010726" }));
    expect(baseChatState.toggleExpand).not.toHaveBeenCalled();
    expect(baseChatState.closeChat).not.toHaveBeenCalled();
  });
});

describe("★★ a page Mink finds opens only when the merchant clicks it", () => {
  const answer = {
    id: 7,
    role: "assistant" as const,
    text: "Use **New product** on the Products page.",
    artifacts: [
      {
        type: "navigation" as const,
        title: "Products",
        path: "/dashboard/products",
        label: "Open Products",
        highlight: { target: "add_product" as const, label: "New product" },
      },
    ],
  };

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("does not navigate, close or collapse the chat when the answer arrives", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        { id: 6, role: "user", text: "Where do I add a product?" },
        answer,
      ],
    } as unknown as ReturnType<typeof useChat>);

    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(
      screen.getByRole("link", { name: /Open Products/i }),
    ).toHaveAttribute("href", "/dashboard/products");
    expect(routerPush).not.toHaveBeenCalled();
    expect(baseChatState.closeChat).not.toHaveBeenCalled();
    expect(baseChatState.toggleExpand).not.toHaveBeenCalled();
    expect(baseChatState.showSpotlight).not.toHaveBeenCalled();
  });

  it("opens the page, points out the control and steps the chat aside on a click", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [answer],
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));

    fireEvent.click(screen.getByRole("link", { name: /Open Products/i }));

    expect(baseChatState.showSpotlight).toHaveBeenCalledWith(
      answer.artifacts[0]!.highlight,
    );
    // The full view collapses so the page behind it can be seen.
    expect(baseChatState.toggleExpand).toHaveBeenCalledOnce();
  });

  it("hands a prefilled form its fields at the click, and only then", () => {
    const prefilled = {
      ...answer,
      artifacts: [
        {
          type: "navigation" as const,
          title: "New product",
          path: "/dashboard/products/new",
          label: "Open the product form",
          prefill: {
            kind: "product" as const,
            fields: { name: "Almond shake" },
          },
        },
      ],
    };
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [prefilled],
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));
    const link = screen.getByRole("link", { name: /Open the product form/i });

    expect(link).toHaveAttribute(
      "href",
      "/dashboard/products/new?prefill=mink",
    );
    expect(window.sessionStorage.length).toBe(0);

    fireEvent.click(link);

    expect(window.sessionStorage.length).toBe(1);
  });

  it("asks for no spotlight on a new-tab click, which leaves this page where it is", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [answer],
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));

    fireEvent.click(screen.getByRole("link", { name: /Open Products/i }), {
      metaKey: true,
    });

    expect(baseChatState.showSpotlight).not.toHaveBeenCalled();
    expect(baseChatState.toggleExpand).not.toHaveBeenCalled();
  });
});

describe("★★ New chat and messages with attachments", () => {
  it("starts a new chat from the header, but not while Mink is answering", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [{ id: "user-1", role: "user", text: "Earlier message" }],
    } as unknown as ReturnType<typeof useChat>);
    const view = render(createElement(DashboardChat, { variant: "overlay" }));

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(baseChatState.startNewChat).toHaveBeenCalledOnce();

    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [{ id: "user-1", role: "user", text: "Earlier message" }],
      isReplying: true,
    } as unknown as ReturnType<typeof useChat>);
    view.rerender(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });

  it("shows a sent photo in the message at once while Mink looks at it", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        {
          id: 1,
          role: "user",
          text: "Is this in stock?",
          pendingAttachments: [
            { name: "shoe.jpg", kind: "image", previewUrl: "blob:shoe" },
            { name: "sizes.pdf", kind: "document", previewUrl: null },
          ],
        },
      ],
      isReplying: true,
      statusText: "Looking at your photo…",
    } as unknown as ReturnType<typeof useChat>);

    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(screen.getByText("Is this in stock?")).toBeVisible();
    expect(screen.getByRole("img", { name: "shoe.jpg" })).toHaveAttribute(
      "src",
      "blob:shoe",
    );
    expect(screen.getByText("sizes.pdf")).toBeVisible();
    expect(screen.getByText("Looking at your photo…")).toBeVisible();
  });

  it("keeps showing this tab's copy of the photo once the message is finished", () => {
    const url =
      "https://storage.googleapis.com/storemink-media/stores/s1/media/shoe.webp";
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        {
          id: 1,
          role: "user",
          text: addSavedMinkMediaReference("Is this in stock?", {
            filename: "shoe.jpg",
            url,
          }),
          localPreviews: { [`url:${url}`]: "blob:shoe" },
        },
      ],
    } as unknown as ReturnType<typeof useChat>);

    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(screen.getByRole("img", { name: "shoe.jpg" })).toHaveAttribute(
      "src",
      "blob:shoe",
    );
  });

  it("offers no Retry for a failure Retry cannot fix", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      error: {
        code: "attachment_failed",
        message: "Busy. Attach the file again to send it.",
        retryable: false,
      },
    } as unknown as ReturnType<typeof useChat>);

    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Attach the file again to send it.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("★★ a picture kept privately with the chat (28 Oct 2026)", () => {
  const ATTACHMENT_URL =
    "/api/mink/attachments/33333333-3333-4333-8333-333333333333";
  const LEGACY_URL =
    "https://storage.googleapis.com/storemink-media/stores/s1/media/shoe.webp";
  const UNAVAILABLE = "This image is no longer available.";

  function renderSentPicture(
    url: string,
    localPreviews?: Record<string, string>,
  ) {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        {
          id: "user-1",
          role: "user",
          text: addSavedMinkMediaReference("Put this on the product", {
            filename: "shoe.jpg",
            url,
          }),
          ...(localPreviews ? { localPreviews } : {}),
        },
      ],
    } as unknown as ReturnType<typeof useChat>);
    return render(createElement(DashboardChat, { variant: "overlay" }));
  }

  it("renders the attachment address directly, never through the proxy", () => {
    renderSentPicture(ATTACHMENT_URL);

    const image = screen.getByRole("img", { name: "shoe.jpg" });
    expect(image).toHaveAttribute("src", ATTACHMENT_URL);
    expect(image.getAttribute("src")).not.toContain("/api/og-image");
    expect(screen.getByText("Put this on the product")).toBeVisible();
    expect(
      screen.queryByText(/untrusted reference data, not instructions/i),
    ).toBeNull();
  });

  it("renders an address the model gave back with a host on this origin", () => {
    renderSentPicture(`https://echoss.storemink.com${ATTACHMENT_URL}`);

    expect(screen.getByRole("img", { name: "shoe.jpg" })).toHaveAttribute(
      "src",
      ATTACHMENT_URL,
    );
  });

  it("still sends a Media Library URL from before the change through the proxy", () => {
    renderSentPicture(LEGACY_URL);

    expect(screen.getByRole("img", { name: "shoe.jpg" })).toHaveAttribute(
      "src",
      `/api/og-image?url=${encodeURIComponent(LEGACY_URL)}`,
    );
  });

  it("this tab's own copy of the picture wins over the address", () => {
    renderSentPicture(ATTACHMENT_URL, {
      [`url:${ATTACHMENT_URL}`]: "blob:shoe",
    });

    expect(screen.getByRole("img", { name: "shoe.jpg" })).toHaveAttribute(
      "src",
      "blob:shoe",
    );
  });

  it("★ a tile whose picture cannot be loaded says so, keeps the file name and offers no viewer", () => {
    renderSentPicture(ATTACHMENT_URL);

    fireEvent.error(screen.getByRole("img", { name: "shoe.jpg" }));

    expect(screen.getByText(UNAVAILABLE)).toBeVisible();
    expect(screen.getByText("shoe.jpg")).toBeVisible();
    expect(screen.queryByRole("img", { name: "shoe.jpg" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View shoe.jpg" })).toBeNull();
    expect(screen.getAllByText(UNAVAILABLE)).toHaveLength(1);
  });

  it("★ the viewer says so too when the picture fails there, and the tile follows", () => {
    renderSentPicture(ATTACHMENT_URL);

    fireEvent.click(screen.getByRole("button", { name: "View shoe.jpg" }));
    const dialog = screen.getByRole("dialog", {
      name: "Attachment preview: shoe.jpg",
    });
    fireEvent.error(within(dialog).getByRole("img", { name: "shoe.jpg" }));

    expect(within(dialog).getByText(UNAVAILABLE)).toBeVisible();
    expect(within(dialog).getByText("shoe.jpg")).toBeVisible();
    expect(within(dialog).queryByRole("img")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Close attachment preview" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // The tile shows the same picture, so it says the same thing now.
    expect(screen.getByText(UNAVAILABLE)).toBeVisible();
    expect(screen.getByText("shoe.jpg")).toBeVisible();
    expect(screen.queryByRole("button", { name: "View shoe.jpg" })).toBeNull();
  });
});

describe("★★ a chat opened from the address opens at its newest message (B20)", () => {
  const chatA = [
    { id: "a-u1", role: "user" as const, text: "How are sales this week?" },
    { id: "a-a1", role: "assistant" as const, text: "Up 12% on last week." },
  ];
  const chatB = [
    { id: "b-u1", role: "user" as const, text: "Redesign my store" },
    {
      id: "b-a1",
      role: "assistant" as const,
      text: "Your storefront redesign is ready. You can review it here.",
    },
  ];

  function chat(state: Record<string, unknown>) {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      ...state,
    } as unknown as ReturnType<typeof useChat>);
  }
  const overlay = () => createElement(DashboardChat, { variant: "overlay" });
  const jumpButton = () =>
    screen.queryByRole("button", { name: "Jump to latest message" });

  /** jsdom lays nothing out: give the scroller what a browser would measure. */
  function sized(
    scroller: HTMLElement,
    scrollHeight: number,
    scrollTop: number,
  ) {
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: scrollHeight },
      scrollTop: { configurable: true, value: scrollTop, writable: true },
      clientHeight: { configurable: true, value: 600 },
    });
    return scroller;
  }

  /**
   * One animation frame, run after every frame queued before it, as a browser
   * runs them. ★ Waiting on a frame rather than on the jump button: the
   * button can appear while a frame queued earlier is still pending, and that
   * stale frame then decides what a test sees.
   */
  const nextFrame = () =>
    act(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        }),
    );

  /** The full view on chat A, left scrolled up (it stops following). */
  async function leftScrolledUp() {
    chat({ messages: chatA });
    const view = render(overlay());
    const scroller = sized(
      screen.getByTestId("mink-message-scroller"),
      1600,
      200,
    );
    fireEvent.scroll(scroller);
    await screen.findByRole("button", { name: "Jump to latest message" });
    return { view, scroller };
  }

  it("★★ opens a view last left scrolled up at the chat's newest message, and follows new output", async () => {
    const { view } = await leftScrolledUp();
    // The full view is closed; its scroll-follow state outlives it.
    chat({ messages: chatA, isChatOpen: false });
    view.rerender(overlay());
    expect(screen.queryByTestId("mink-message-scroller")).toBeNull();

    // The "redesign ready" notice: the address open is counted before the
    // chat loads, and the full view opens on what it had...
    chat({ messages: chatA, addressOpens: 1, isHistoryLoading: true });
    view.rerender(overlay());
    const reopened = sized(
      screen.getByTestId("mink-message-scroller"),
      2400,
      0,
    );
    // ...then the named chat lands.
    chat({ messages: chatB, addressOpens: 1 });
    view.rerender(overlay());

    await waitFor(() => expect(reopened.scrollTop).toBe(2400));
    expect(jumpButton()).toBeNull();

    // ★ And it follows what arrives next (the card a stopped reply kept).
    sized(reopened, 3200, 2400);
    chat({
      messages: [
        ...chatB,
        { id: "b-a2", role: "assistant" as const, text: "Here is the card." },
      ],
      addressOpens: 1,
    });
    view.rerender(overlay());
    await waitFor(() => expect(reopened.scrollTop).toBe(3200));
    expect(jumpButton()).toBeNull();
  });

  it("★★ the chat already open, loaded again from the address, moves to its newest message too, its draft untouched", async () => {
    chat({ messages: chatA });
    const view = render(overlay());
    const scroller = sized(
      screen.getByTestId("mink-message-scroller"),
      1600,
      200,
    );
    // ★ The merchant reads scrolled up for a while: every frame the view
    //   queued has run, so only the address open can hide the button. With a
    //   frame from the view's mount still pending, that frame hid it and this
    //   test passed without the address open's own hide.
    await nextFrame();
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    await nextFrame();
    expect(jumpButton()).not.toBeNull();

    chat({
      messages: chatA,
      addressOpens: 1,
      isHistoryLoading: true,
      input: "Make the colours warmer",
    });
    view.rerender(overlay());
    // The button goes before the chat lands, as when History is used.
    await nextFrame();
    expect(jumpButton()).toBeNull();

    sized(scroller, 2000, 200);
    chat({
      messages: [
        ...chatA.map((message) => ({ ...message })),
        {
          id: "a-a2",
          role: "assistant" as const,
          text: "Your storefront redesign is ready. You can review it here.",
        },
      ],
      addressOpens: 1,
      input: "Make the colours warmer",
    });
    view.rerender(overlay());

    await waitFor(() => expect(scroller.scrollTop).toBe(2000));
    expect(jumpButton()).toBeNull();
    expect(screen.getByLabelText("Message Mink AI")).toHaveValue(
      "Make the colours warmer",
    );
    expect(baseChatState.setInput).not.toHaveBeenCalled();
  });

  it("★★ opens at the newest message after the full view was closed mid-reply, not at the question that reply anchored", async () => {
    const asked = [
      ...chatA,
      { id: "a-u2", role: "user" as const, text: "Redesign my store" },
    ];
    const answered = [
      ...asked,
      {
        id: "a-a2",
        role: "assistant" as const,
        text: "I have started your storefront redesign.",
      },
    ];
    chat({ messages: chatA });
    const view = render(overlay());
    sized(screen.getByTestId("mink-message-scroller"), 1200, 600);
    await nextFrame();

    // A question: the reply runs with it anchored at the top of the view.
    chat({ messages: asked, isReplying: true, statusText: "Thinking…" });
    view.rerender(overlay());
    await nextFrame();
    expect(scrollIntoView).toHaveBeenCalled();

    // The full view is closed while Mink is still answering, and the answer
    // lands while it is closed, so nothing positions it.
    chat({
      messages: asked,
      isReplying: true,
      statusText: "Thinking…",
      isChatOpen: false,
    });
    view.rerender(overlay());
    chat({ messages: answered, isChatOpen: false });
    view.rerender(overlay());
    await nextFrame();
    scrollIntoView.mockClear();

    // The "redesign ready" notice opens the same chat from the address.
    chat({ messages: answered, addressOpens: 1, isHistoryLoading: true });
    view.rerender(overlay());
    const reopened = sized(
      screen.getByTestId("mink-message-scroller"),
      2400,
      0,
    );
    await nextFrame();
    chat({
      messages: [
        ...answered.map((message) => ({ ...message })),
        {
          id: "a-a3",
          role: "assistant" as const,
          text: "Your storefront redesign is ready. You can review it here.",
        },
      ],
      addressOpens: 1,
    });
    view.rerender(overlay());

    // ★ The old question is not scrolled back into view: the card is.
    await waitFor(() => expect(reopened.scrollTop).toBe(2400));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(jumpButton()).toBeNull();
  });

  it("leaves a reader scrolled up where they are while no chat is opened from the address", async () => {
    const { view, scroller } = await leftScrolledUp();
    sized(scroller, 2000, 200);
    chat({
      messages: [
        ...chatA,
        { id: "a-a2", role: "assistant" as const, text: "And one more thing." },
      ],
    });
    view.rerender(overlay());

    await waitFor(() => expect(jumpButton()).not.toBeNull());
    expect(scroller.scrollTop).toBe(200);
  });

  it("★ choosing a chat in History does the same, at once", async () => {
    const { view, scroller } = await leftScrolledUp();
    chat({
      messages: chatA,
      conversations: [
        {
          id: "chat-b",
          title: "Storefront redesign",
          lastMessageAt: "2026-10-24T10:00:00.000Z",
          createdAt: "2026-10-24T09:00:00.000Z",
        },
      ],
    });
    view.rerender(overlay());
    const history = await screen.findByRole("complementary", {
      name: "Mink AI conversations",
    });
    fireEvent.click(
      Array.from(history.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Storefront redesign"),
      )!,
    );

    expect(baseChatState.loadConversation).toHaveBeenCalledWith("chat-b");
    expect(jumpButton()).toBeNull();
    sized(scroller, 2400, 200);
    chat({ messages: chatB });
    view.rerender(overlay());
    await waitFor(() => expect(scroller.scrollTop).toBe(2400));
  });

  describe("★ a search result chosen in History", () => {
    const searched = (state: Record<string, unknown> = {}) =>
      chat({
        messages: chatA,
        historySearchText: "redesign",
        historySearch: {
          query: "redesign",
          words: ["redesign"],
          results: [
            {
              id: "chat-b",
              title: "Storefront redesign",
              lastMessageAt: "2026-10-24T10:00:00.000Z",
              createdAt: "2026-10-24T09:00:00.000Z",
              hasRedesignCard: true,
              snippet: "Your storefront «redesign» is ready.",
              matchMessageId: "b-a1",
            },
          ],
          cursor: null,
          loading: false,
          loadingMore: false,
          error: null,
        },
        ...state,
      });
    const chatBWithRuns = [
      { ...chatB[0], runId: "run-b1" },
      { ...chatB[1], runId: "run-b1" },
    ];

    async function chooseResult(view: ReturnType<typeof render>) {
      searched();
      view.rerender(overlay());
      const history = await screen.findByRole("complementary", {
        name: "Mink AI conversations",
      });
      fireEvent.click(
        Array.from(history.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Storefront redesign"),
        )!,
      );
    }

    it("★ F11/F14: asks for its match, and opens at the newest message when the match could not be loaded", async () => {
      const { view, scroller } = await leftScrolledUp();
      await chooseResult(view);

      expect(baseChatState.loadConversation).toHaveBeenCalledWith("chat-b", {
        revealMessageId: "b-a1",
      });
      expect(jumpButton()).toBeNull();
      // The match was further back than the pages read: nothing to reveal,
      // so the chat starts at its newest message, not where chat A was left.
      sized(scroller, 2400, 200);
      searched({ messages: chatBWithRuns, revealTarget: null });
      view.rerender(overlay());
      await waitFor(() => expect(scroller.scrollTop).toBe(2400));
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("★ F11: a match that loaded is scrolled to after the thread's own scroll, so the match is what shows", async () => {
      const { view, scroller } = await leftScrolledUp();
      await chooseResult(view);
      const scrolledFrom: number[] = [];
      scrollIntoView.mockImplementation(() => {
        scrolledFrom.push(scroller.scrollTop);
      });

      sized(scroller, 2400, 200);
      searched({
        messages: chatBWithRuns,
        revealTarget: { messageId: "b-a1", runId: "run-b1", role: "assistant" },
      });
      view.rerender(overlay());
      // The answer is reached through its question's row, in the middle.
      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" }),
      );
      expect(scrolledFrom).toEqual([2400]);
      expect(baseChatState.clearRevealTarget).toHaveBeenCalled();
    });
  });

  // ★★ The thread's scroller is a new element each time the chat appears: the
  //   panel opened again, or the switch between the side panel and the full
  //   view (two instances, each with its own scroller). A new element starts
  //   at its top, and nothing else moved it while the chat itself was
  //   unchanged.
  describe("★★ a scroller mounted over a chat in memory starts at its newest message", () => {
    const panel = () => createElement(DashboardChat, { variant: "panel" });
    const both = () =>
      createElement(
        Fragment,
        null,
        createElement(DashboardChat, { variant: "panel" }),
        createElement(DashboardChat, { variant: "overlay" }),
      );
    const scroller = () => screen.getByTestId("mink-message-scroller");

    /** The merchant scrolls up and reads: the view stops following. */
    async function scrollUp(element: HTMLElement) {
      element.scrollTop = 200;
      fireEvent.scroll(element);
      await nextFrame();
      expect(jumpButton()).not.toBeNull();
    }

    it("★★ the panel opened again, even one left scrolled up", async () => {
      chat({ messages: chatA, isExpanded: false });
      const view = render(panel());
      await nextFrame();
      await scrollUp(sized(scroller(), 1600, 200));

      chat({ messages: chatA, isExpanded: false, isChatOpen: false });
      view.rerender(panel());
      expect(screen.queryByTestId("mink-message-scroller")).toBeNull();

      chat({ messages: chatA, isExpanded: false });
      view.rerender(panel());
      const reopened = sized(scroller(), 1600, 0);
      await nextFrame();

      expect(reopened.scrollTop).toBe(1600);
      expect(jumpButton()).toBeNull();
    });

    it("★★ the side panel to the full view and back", async () => {
      chat({ messages: chatA, isExpanded: false });
      const view = render(both());
      await nextFrame();
      await scrollUp(sized(scroller(), 1600, 200));

      chat({ messages: chatA });
      view.rerender(both());
      const full = sized(scroller(), 2400, 0);
      await nextFrame();
      expect(full.scrollTop).toBe(2400);
      expect(jumpButton()).toBeNull();

      await scrollUp(full);
      chat({ messages: chatA, isExpanded: false });
      view.rerender(both());
      const side = sized(scroller(), 1600, 0);
      await nextFrame();
      expect(side.scrollTop).toBe(1600);
      expect(jumpButton()).toBeNull();
    });

    it("★ while Mink is answering, the question stays anchored at the top, with its tail room", async () => {
      const asked = [
        ...chatA,
        { id: "a-u2", role: "user" as const, text: "Redesign my store" },
      ];
      chat({ messages: chatA });
      const view = render(overlay());
      sized(scroller(), 1200, 600);
      await nextFrame();
      chat({ messages: asked, isReplying: true, statusText: "Thinking…" });
      view.rerender(overlay());
      await nextFrame();
      expect(scrollIntoView).toHaveBeenCalledOnce();

      // Closed and opened again before the answer lands.
      chat({
        messages: asked,
        isReplying: true,
        statusText: "Thinking…",
        isChatOpen: false,
      });
      view.rerender(overlay());
      chat({ messages: asked, isReplying: true, statusText: "Thinking…" });
      view.rerender(overlay());
      const reopened = sized(scroller(), 2400, 0);
      await nextFrame();

      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(scrollIntoView).toHaveBeenLastCalledWith({
        block: "start",
        behavior: "smooth",
      });
      expect(reopened.scrollTop).toBe(0);
      expect(
        screen.getByTestId("mink-turn-anchor-space").style.minHeight,
      ).not.toBe("0px");
    });
  });
});

describe("★★ Stop asks the server, and is not offered once it refused (25 Oct 2026)", () => {
  const REFUSED = "Mink has already started this, so it will finish.";
  const asking = [{ id: "u1", role: "user", text: "Redesign my store" }];

  it("asks the chat to stop the reply, once per press", () => {
    const cancel = vi.fn(async () => ({ outcome: "stopped" as const }));
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: asking,
      isReplying: true,
      statusText: "Thinking…",
      cancel,
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Mink AI" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("★ once refused, offers no Stop; the status line says why and the next message waits", () => {
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: asking,
      input: "Make it blue",
      isReplying: true,
      stopRefused: true,
      statusText: REFUSED,
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.queryByRole("button", { name: "Stop Mink AI" })).toBeNull();
    expect(screen.getByTestId("mink-pending-answer")).toHaveTextContent(
      REFUSED,
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("★ the voice bar offers no Stop once refused either", () => {
    voiceChat.value.enabled = true;
    voiceChat.value.state = "waiting";
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: asking,
      isReplying: true,
      stopRefused: true,
      statusText: REFUSED,
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));
    expect(screen.getByTestId("mink-voice-bar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Mink AI" })).toBeNull();
    expect(screen.getByTestId("mink-pending-answer")).toHaveTextContent(
      REFUSED,
    );
  });
});

describe("★★ one card per storefront redesign in a thread (25 Oct 2026)", () => {
  const REVAMP_ID = "44444444-4444-4444-8444-444444444444";
  const OTHER_ID = "55555555-5555-4555-8555-555555555555";
  const revamp = (
    revampId: string,
    status: RevampStatus = "running",
  ): RevampArtifact => ({
    type: "storefront_revamp",
    revampId,
    kind: "full",
    status,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("revampIdsShownBefore: each message sees the redesigns earlier messages show", () => {
    const shown = revampIdsShownBefore([
      { artifacts: [] },
      { artifacts: [revamp(REVAMP_ID)] },
      {},
      { artifacts: [revamp(REVAMP_ID, "queued"), revamp(OTHER_ID)] },
      { artifacts: [revamp(OTHER_ID, "ready")] },
    ]);
    expect(shown.map((ids) => [...ids])).toEqual([
      [],
      [],
      [REVAMP_ID],
      [REVAMP_ID],
      [REVAMP_ID, OTHER_ID],
    ]);
  });

  it("★★ a later answer with the same redesign points back to its card, and Show it goes there", () => {
    // The card reads its job on mount; held here, it shows what the answer said.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    vi.mocked(useChat).mockReturnValue({
      ...baseChatState,
      messages: [
        { id: "u1", role: "user", text: "Redesign my store" },
        {
          id: "a1",
          role: "assistant",
          text: "Your storefront redesign has started.",
          artifacts: [revamp(REVAMP_ID)],
        },
        { id: "u2", role: "user", text: "Redesign it again" },
        {
          id: "a2",
          role: "assistant",
          text: "Your redesign is still being made.",
          artifacts: [revamp(REVAMP_ID, "queued")],
        },
      ],
    } as unknown as ReturnType<typeof useChat>);
    render(createElement(DashboardChat, { variant: "overlay" }));
    expect(
      screen.getAllByRole("heading", { name: "Your store redesign" }),
    ).toHaveLength(1);
    expect(
      screen.getByText("Your storefront redesign card is above."),
    ).toBeVisible();
    const card = document.getElementById(`revamp-card-${REVAMP_ID}`);
    expect(card).not.toBeNull();
    const goTo = vi.fn();
    Object.defineProperty(card!, "scrollIntoView", { value: goTo });
    fireEvent.click(screen.getByRole("button", { name: "Show it" }));
    expect(goTo).toHaveBeenCalledOnce();
    expect(card).toHaveFocus();
  });
});
