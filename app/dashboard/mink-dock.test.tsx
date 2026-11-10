// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MinkSkill } from "@/lib/mink/skills";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/orders",
}));

type ChatValue = Record<string, unknown>;
const chat = vi.hoisted(() => ({ value: null as ChatValue | null }));

vi.mock("./chat-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-context")>();
  return {
    ...actual,
    // Null: the real hook outside a provider (the platform console).
    useChat: () => chat.value ?? actual.useChat(),
  };
});

import {
  MINK_DOCK_CLOSE_DELAY_MS,
  MINK_DOCK_OPEN_DELAY_MS,
  MinkDock,
} from "./mink-dock";

const SKILLS: MinkSkill[] = [
  {
    id: "pending-orders",
    slash: "pending-orders",
    label: "Pending orders",
    description: "Orders waiting to ship",
    prompt: "Which orders are waiting to ship?",
    section: "orders",
    action: "view",
    starterOn: ["/dashboard/orders"],
  },
];

const askInPanel = vi.fn();
const openChat = vi.fn();

function setChat(overrides: ChatValue = {}) {
  chat.value = {
    enabled: true,
    isChatOpen: false,
    skills: SKILLS,
    pageSuggestion: null,
    askInPanel,
    openChat,
    ...overrides,
  };
}

function mockPointer(coarse: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

const tab = () => screen.getByRole("button", { name: "Ask Mink AI" });
const field = () =>
  screen.getByRole("textbox", { name: "Ask Mink AI anything" });
const dock = () => document.querySelector("[data-mink-dock]") as HTMLElement;

beforeEach(() => {
  askInPanel.mockReset();
  openChat.mockReset();
  mockPointer(false);
  setChat();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  chat.value = null;
});

describe("MinkDock", () => {
  it("renders nothing while Mink AI is off", () => {
    setChat({ enabled: false });
    const { container } = render(<MinkDock />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing outside a chat provider (the platform console)", () => {
    chat.value = null;
    const { container } = render(<MinkDock />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the chat is open: the panel replaces it", () => {
    setChat({ isChatOpen: true });
    const { container } = render(<MinkDock />);
    expect(container).toBeEmptyDOMElement();
  });

  it("rests as a tab, with the bar and its suggestion out of reach", () => {
    render(<MinkDock />);
    expect(tab()).toHaveAttribute("aria-expanded", "false");
    expect(tab()).toHaveAttribute("aria-controls", "mink-dock-bar");
    expect(
      screen.queryByRole("button", { name: "Ask: Pending orders" }),
    ).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("focus on the tab opens the bar and leaves focus on the tab (WCAG 3.2.1)", () => {
    render(<MinkDock />);
    act(() => tab().focus());
    expect(dock()).toHaveAttribute("data-open", "true");
    expect(tab()).toHaveFocus();
    expect(tab()).toHaveAttribute("aria-expanded", "true");
    // Still in the tab order, so the next Tab reaches the field.
    expect(tab()).not.toHaveAttribute("tabindex", "-1");
    expect(
      screen.getByRole("button", { name: "Ask: Pending orders" }),
    ).toBeVisible();
  });

  it("activating the tab moves focus into the field", () => {
    render(<MinkDock />);
    act(() => tab().focus());
    fireEvent.click(tab());
    expect(field()).toHaveFocus();
  });

  it("submitting the form asks in the panel and clears the field", () => {
    render(<MinkDock />);
    act(() => tab().focus());
    fireEvent.change(field(), { target: { value: "How were sales today?" } });
    fireEvent.submit(field().closest("form") as HTMLFormElement);
    expect(askInPanel).toHaveBeenCalledWith("How were sales today?");
    act(() => tab().blur());
    act(() => tab().focus());
    expect(field()).toHaveValue("");
  });

  it("clears the draft after a send", () => {
    render(<MinkDock />);
    act(() => tab().focus());
    fireEvent.change(field(), { target: { value: "Stock?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(askInPanel).toHaveBeenCalledWith("Stock?");
    act(() => tab().blur());
    act(() => tab().focus());
    expect(field()).toHaveValue("");
  });

  it("an empty send opens the panel without a question", () => {
    render(<MinkDock />);
    act(() => tab().focus());
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(askInPanel).toHaveBeenCalledWith("");
  });

  it("the suggestion sends its prompt", () => {
    render(<MinkDock />);
    act(() => tab().focus());
    fireEvent.click(
      screen.getByRole("button", { name: "Ask: Pending orders" }),
    );
    expect(askInPanel).toHaveBeenCalledWith(
      "Which orders are waiting to ship?",
    );
  });

  it("a page's own suggestion wins over the skills", () => {
    setChat({
      pageSuggestion: {
        label: "How do I add my first product?",
        prompt: "How do I add my first product?",
      },
    });
    render(<MinkDock />);
    act(() => tab().focus());
    fireEvent.click(
      screen.getByRole("button", {
        name: "Ask: How do I add my first product?",
      }),
    );
    expect(askInPanel).toHaveBeenCalledWith("How do I add my first product?");
  });

  it("offers no suggestion when there is none", () => {
    setChat({ skills: [] });
    render(<MinkDock />);
    act(() => tab().focus());
    expect(screen.queryByRole("button", { name: /^Ask: / })).toBeNull();
    expect(field()).toBeInTheDocument();
  });

  it("Escape closes the bar, returns focus to the tab, and hover waits for the pointer to leave", () => {
    vi.useFakeTimers();
    render(<MinkDock />);
    act(() => tab().focus());
    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS));
    expect(dock()).toHaveAttribute("data-open", "true");

    act(() => field().focus());
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(dock()).toHaveAttribute("data-open", "false");
    expect(tab()).toHaveFocus();

    // Still pointing at it: it stays in.
    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS * 2));
    expect(dock()).toHaveAttribute("data-open", "false");

    // Leave and come back: it opens again.
    fireEvent.mouseLeave(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_CLOSE_DELAY_MS));
    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS));
    expect(dock()).toHaveAttribute("data-open", "true");
  });

  it("Escape closes a bar the pointer opened, wherever focus is", () => {
    vi.useFakeTimers();
    render(<MinkDock />);
    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS));
    expect(dock()).toHaveAttribute("data-open", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dock()).toHaveAttribute("data-open", "false");
  });

  it("a bar closed with Escape stays closed when the pointer leaves, and opens on the next visit", () => {
    vi.useFakeTimers();
    render(<MinkDock />);
    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS + 10));
    expect(dock()).toHaveAttribute("data-open", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dock()).toHaveAttribute("data-open", "false");

    // The bar is gone, so the pointer is outside the small tab: it leaves.
    fireEvent.mouseLeave(dock());
    expect(dock()).toHaveAttribute("data-open", "false");
    act(() => vi.advanceTimersByTime(MINK_DOCK_CLOSE_DELAY_MS * 2));
    expect(dock()).toHaveAttribute("data-open", "false");

    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS));
    expect(dock()).toHaveAttribute("data-open", "true");
  });

  it("a bar closed with Escape from the field does not flash when the pointer crosses the dock", () => {
    vi.useFakeTimers();
    render(<MinkDock />);
    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS));
    fireEvent.click(tab());
    expect(field()).toHaveFocus();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(dock()).toHaveAttribute("data-open", "false");
    fireEvent.mouseLeave(dock());
    expect(dock()).toHaveAttribute("data-open", "false");
    act(() => vi.advanceTimersByTime(MINK_DOCK_CLOSE_DELAY_MS));
    expect(dock()).toHaveAttribute("data-open", "false");
  });

  it("after Escape on a hover-opened bar, the keyboard can still open it while the pointer rests there", () => {
    vi.useFakeTimers();
    render(<MinkDock />);
    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dock()).toHaveAttribute("data-open", "false");
    act(() => tab().focus());
    expect(dock()).toHaveAttribute("data-open", "true");
    expect(tab()).toHaveFocus();
  });

  it("forgets its hover when the chat opens by another route", () => {
    vi.useFakeTimers();
    const { rerender } = render(<MinkDock />);
    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS));
    expect(dock()).toHaveAttribute("data-open", "true");
    // The chat opens (Enter on the face): the bar goes with no mouseleave.
    setChat({ isChatOpen: true });
    rerender(<MinkDock />);
    expect(dock()).toBeNull();
    setChat({ isChatOpen: false });
    rerender(<MinkDock />);
    expect(dock()).toHaveAttribute("data-open", "false");
  });

  it("hover opens after a short delay and closes after the pointer leaves", () => {
    vi.useFakeTimers();
    render(<MinkDock />);
    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS - 1));
    expect(dock()).toHaveAttribute("data-open", "false");
    act(() => vi.advanceTimersByTime(1));
    expect(dock()).toHaveAttribute("data-open", "true");
    fireEvent.mouseLeave(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_CLOSE_DELAY_MS));
    expect(dock()).toHaveAttribute("data-open", "false");
  });

  it("does not close while focus is inside it", () => {
    vi.useFakeTimers();
    render(<MinkDock />);
    fireEvent.mouseEnter(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_OPEN_DELAY_MS));
    act(() => field().focus());
    fireEvent.mouseLeave(dock());
    act(() => vi.advanceTimersByTime(MINK_DOCK_CLOSE_DELAY_MS * 3));
    expect(dock()).toHaveAttribute("data-open", "true");
    expect(field()).toHaveFocus();
  });

  it("on a touch screen a tap opens the chat and no field renders", () => {
    mockPointer(true);
    render(<MinkDock />);
    fireEvent.click(tab());
    expect(openChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(tab()).not.toHaveAttribute("aria-expanded");
  });

  it("gives every control its own name", () => {
    render(<MinkDock />);
    act(() => tab().focus());
    const names = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    names.push(field().getAttribute("aria-label") ?? "");
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("Mink AI");
  });

  it("marks itself so screen reading and the spotlight skip it", () => {
    render(<MinkDock />);
    expect(dock()).toHaveAttribute("data-mink-dock");
  });
});
