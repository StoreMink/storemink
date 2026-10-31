// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HelpAssistant } from "./help-assistant";
import { OPEN_HELP_MINK_EVENT, openHelpMink } from "./mink-launch";
import { MINK_STRINGS, minkIntro } from "./mink-strings";
import { RECENT_CHATS_KEY, type RecentChat } from "./recent-chats";

const askHelpAssistant = vi.fn();
const scrollIntoView = vi.fn();

vi.mock("@/app/actions/help-assistant-actions", () => ({
  askHelpAssistant: (...args: unknown[]) => askHelpAssistant(...args),
}));

const rateHelpAnswer = vi.fn();
vi.mock("@/app/actions/help-assistant-feedback-actions", () => ({
  rateHelpAnswer: (...args: unknown[]) => rateHelpAnswer(...args),
}));

describe("HelpAssistant", () => {
  beforeEach(() => {
    localStorage.clear();
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    askHelpAssistant.mockReset();
    askHelpAssistant.mockResolvedValue({
      success: true,
      data: {
        answer: "Use the Sell screen to complete the checkout.",
        steps: ["Open Sell.", "Add products.", "Select Take payment."],
        notes: ["Review the live total before completing the sale."],
        sources: [
          {
            title: "Process an in-store sale",
            url: "/help/point-of-sale/process-an-in-store-sale",
            excerpt: "Complete a counter checkout.",
          },
        ],
        clarificationPrompts: [],
        followUps: ["How do I split a payment?"],
        needsHuman: false,
      },
    });
  });

  it("opens accessibly and renders structured, sourced guidance", async () => {
    render(<HelpAssistant />);

    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    expect(
      screen.getByRole("dialog", { name: "Mink AI Help Assistant" }),
    ).toBeInTheDocument();
    const credit = screen.getByLabelText("Powered by StoreMink");
    expect(credit.children).toHaveLength(3);
    expect(credit.children[0]).toHaveTextContent("Powered by");
    expect(credit.children[1]).toHaveAttribute(
      "src",
      expect.stringContaining("storemink-mark.webp"),
    );
    expect(credit.children[2]).toHaveTextContent("StoreMink");

    fireEvent.change(
      screen.getByLabelText("Ask Mink AI a StoreMink question"),
      {
        target: { value: "How do I complete a POS sale?" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));

    expect(
      await screen.findByText("Use the Sell screen to complete the checkout."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenLastCalledWith({
        block: "start",
        behavior: "smooth",
      }),
    );
    expect(scrollIntoView.mock.instances.at(-1)).toBe(
      screen
        .getByText("Use the Sell screen to complete the checkout.")
        .closest("[data-message-id]"),
    );
    expect(screen.getByText("Select Take payment.")).toBeInTheDocument();
    expect(screen.getByText("Source guides")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Process an in-store sale/i }),
    ).toHaveAttribute("href", "/help/point-of-sale/process-an-in-store-sale");
    expect(askHelpAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do I complete a POS sale?",
        history: [expect.objectContaining({ role: "assistant" })],
      }),
    );
  });

  it("supports suggested follow-ups and resetting the conversation", async () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    fireEvent.click(
      screen.getByRole("button", { name: "How do I process a POS sale?" }),
    );
    await screen.findByText("How do I split a payment?");

    fireEvent.click(
      screen.getByRole("button", { name: "How do I split a payment?" }),
    );
    await waitFor(() => expect(askHelpAssistant).toHaveBeenCalledTimes(2));

    fireEvent.click(
      screen.getByRole("button", { name: "Start a new conversation" }),
    );
    expect(
      screen.getByText(/Tell me what you want to do/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Use the Sell screen to complete the checkout."),
    ).not.toBeInTheDocument();
  });

  it("renders clarification guidance without turning it into a user message", async () => {
    askHelpAssistant.mockResolvedValueOnce({
      success: true,
      data: {
        answer: "Add more detail so I can find the right published guide.",
        steps: [],
        notes: [],
        sources: [],
        clarificationPrompts: [
          "The StoreMink page or menu you are using",
          "What happened after your last step",
        ],
        followUps: [],
        needsHuman: true,
      },
    });
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    fireEvent.click(
      screen.getByRole("button", { name: "How do I process a POS sale?" }),
    );

    expect(
      await screen.findByText("Include these details in your reply"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The StoreMink page or menu you are using"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "The StoreMink page or menu you are using",
      }),
    ).not.toBeInTheDocument();
    expect(askHelpAssistant).toHaveBeenCalledTimes(1);
  });

  it("rejects keyboard noise instead of reusing an earlier topic", async () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    const input = screen.getByLabelText("Ask Mink AI a StoreMink question");

    fireEvent.change(input, { target: { value: "ll" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await screen.findByText(/Please enter a complete StoreMink question/i),
    ).toBeInTheDocument();
    expect(askHelpAssistant).not.toHaveBeenCalled();
  });

  it("supports accessible keyboard resizing and remembers the width", async () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    const resizer = screen.getByRole("separator", {
      name: "Resize Mink AI drawer",
    });

    expect(resizer).toHaveAttribute("aria-valuenow", "480");
    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(resizer).toHaveAttribute("aria-valuenow", "504");
    expect(localStorage.getItem("sm-help-mink-width")).toBe("504");
  });

  it("maximizes to the full viewport and restores the resizable drawer", () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));

    const dialog = screen.getByRole("dialog", {
      name: "Mink AI Help Assistant",
    });
    fireEvent.click(screen.getByRole("button", { name: "Mink AI options" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize Mink AI" }));

    expect(dialog).toHaveClass("is-maximized");
    expect(
      screen.queryByRole("separator", { name: "Resize Mink AI drawer" }),
    ).not.toBeInTheDocument();
    // Choosing the full window closes the menu.
    expect(
      screen.queryByRole("button", { name: "Restore Mink AI drawer" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mink AI options" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Restore Mink AI drawer" }),
    );
    expect(dialog).not.toHaveClass("is-maximized");
    expect(
      screen.getByRole("separator", { name: "Resize Mink AI drawer" }),
    ).toBeInTheDocument();
  });

  // The header is the title menu, New chat and Close; recent chats, the
  // language and the full window live in the menu under "Mink AI".
  it("keeps the header to the title menu, New chat and Close", () => {
    render(<HelpAssistant />);
    const launcher = screen.getByRole("button", { name: "Ask Mink AI" });
    fireEvent.click(launcher);

    // The launcher keeps its name while open and says so with aria-expanded.
    expect(launcher).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Start a new conversation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close Mink AI" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    const options = screen.getByRole("button", { name: "Mink AI options" });
    expect(options).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(options);
    expect(options).toHaveAttribute("aria-expanded", "true");
    expect(options).toHaveAttribute("aria-controls", "hc-assistant-menu");
    const menu = document.getElementById("hc-assistant-menu");
    if (!menu) throw new Error("The header menu is not shown.");
    expect(
      within(menu).getByRole("button", { name: /Recent chats/ }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("combobox", { name: "Language" }),
    ).toHaveValue("en");
    expect(
      within(menu).getByRole("button", { name: "Maximize Mink AI" }),
    ).toHaveAttribute("aria-pressed", "false");

    // Escape closes the menu first and gives focus back to its button; the
    // chat stays open until a second Escape.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("hc-assistant-menu")).toBeNull();
    expect(options).toHaveFocus();
    expect(
      screen.getByRole("dialog", { name: "Mink AI Help Assistant" }),
    ).toBeInTheDocument();

    // A press outside the menu closes it too.
    fireEvent.click(options);
    expect(document.getElementById("hc-assistant-menu")).not.toBeNull();
    fireEvent.pointerDown(
      screen.getByLabelText("Ask Mink AI a StoreMink question"),
    );
    expect(document.getElementById("hc-assistant-menu")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // ★★ THE DRAWER MUST LEAVE THE HEADER. `.hc-topbar` carries
  // `backdrop-filter: blur(18px)`, which makes it the containing block for
  // every `position: fixed` descendant — so a drawer rendered in place
  // resolved top/right/bottom against the 73px header and opened as a 360x8px
  // sliver at its bottom edge (measured live on help.storemink.com). Nothing
  // threw and every assertion above still passed, which is why this pins the
  // PARENT rather than any visible state: jsdom computes no layout, so the
  // only observable difference is where the panel is mounted.
  it("portals the drawer out of the backdrop-filtered header", () => {
    const header = document.createElement("header");
    header.className = "hc-topbar";
    const overlayHost = document.createElement("div");
    overlayHost.id = "hc-overlay-root";
    document.body.append(header, overlayHost);

    render(<HelpAssistant />, { container: header });
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));

    const dialog = screen.getByRole("dialog", {
      name: "Mink AI Help Assistant",
    });
    expect(overlayHost).toContainElement(dialog);
    expect(header.contains(dialog)).toBe(false);
    expect(header.querySelector(".hc-assistant-backdrop")).toBeNull();
    expect(overlayHost.querySelector(".hc-assistant-backdrop")).not.toBeNull();

    header.remove();
    overlayHost.remove();
  });
});

describe("HelpAssistant: language, ratings, recent chats and launching", () => {
  const ANSWER = {
    answer: "Use the Sell screen to complete the checkout.",
    steps: ["Open Sell.", "Add products.", "Select Take payment."],
    notes: ["Review the live total before completing the sale."],
    sources: [
      {
        title: "Process an in-store sale",
        url: "/help/point-of-sale/process-an-in-store-sale",
        excerpt: "Complete a counter checkout.",
      },
    ],
    clarificationPrompts: [],
    followUps: ["How do I split a payment?"],
    needsHuman: false,
  };
  const QUESTION = "How do I process a POS sale?";
  const ANSWER_TEXT = [
    ANSWER.answer,
    "1. Open Sell.",
    "2. Add products.",
    "3. Select Take payment.",
    "Important: Review the live total before completing the sale.",
  ].join("\n");
  const ID = /^[A-Za-z0-9_-]{8,64}$/;

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    askHelpAssistant.mockResolvedValue({ success: true, data: ANSWER });
    rateHelpAnswer.mockResolvedValue({ ok: true });
  });

  function openDrawer() {
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
  }

  async function askStarter() {
    fireEvent.click(screen.getByRole("button", { name: QUESTION }));
    await screen.findByText(ANSWER.answer);
  }

  function savedChats(): RecentChat[] {
    return JSON.parse(localStorage.getItem(RECENT_CHATS_KEY) ?? "[]");
  }

  function sidebar(): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      ".hc-assistant-sidebar",
    );
    if (!element) throw new Error("The recent chats sidebar is not shown.");
    return element;
  }

  it("changes the drawer's words to the chosen language and asks in it", async () => {
    const hi = MINK_STRINGS.hi;
    render(<HelpAssistant />);
    openDrawer();

    fireEvent.change(
      screen.getByLabelText("Ask Mink AI a StoreMink question"),
      { target: { value: "How do I complete a POS sale?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    await screen.findByText(ANSWER.answer);
    // Until a language is picked, none is sent.
    expect(askHelpAssistant.mock.calls[0][0]).not.toHaveProperty("language");

    fireEvent.click(screen.getByRole("button", { name: "Mink AI options" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), {
      target: { value: "hi" },
    });

    expect(
      screen.getByRole("dialog", { name: hi.dialogLabel }),
    ).toHaveAttribute("lang", "hi");
    expect(screen.getByRole("combobox", { name: hi.language })).toHaveValue(
      "hi",
    );
    const input = screen.getByLabelText(hi.inputLabel);
    expect(input).toHaveAttribute("placeholder", hi.placeholder);
    expect(
      screen.queryByLabelText("Ask Mink AI a StoreMink question"),
    ).not.toBeInTheDocument();
    // The answer already on screen speaks the new language too.
    expect(
      screen.getByRole("button", { name: hi.helpful }),
    ).toBeInTheDocument();
    expect(localStorage.getItem("sm-help-mink-language")).toBe("hi");

    fireEvent.change(input, { target: { value: "How do I refund a sale?" } });
    fireEvent.click(screen.getByRole("button", { name: hi.send }));
    await waitFor(() =>
      expect(screen.getAllByText(ANSWER.answer)).toHaveLength(2),
    );
    expect(askHelpAssistant).toHaveBeenCalledTimes(2);
    const next = askHelpAssistant.mock.calls[1][0];
    expect(next).toEqual(
      expect.objectContaining({
        message: "How do I refund a sale?",
        language: "hi",
      }),
    );
    // The conversation is sent from the opening message in that language.
    expect(next.history[0]).toEqual({
      role: "assistant",
      content: minkIntro(hi),
    });
    expect(savedChats()[0].language).toBe("hi");
  });

  it("opens in the language picked on an earlier visit, and in English for anything else", () => {
    localStorage.setItem("sm-help-mink-language", "ta");
    const first = render(<HelpAssistant />);
    openDrawer();
    expect(
      screen.getByLabelText(MINK_STRINGS.ta.inputLabel),
    ).toBeInTheDocument();
    first.unmount();

    localStorage.setItem("sm-help-mink-language", "xx");
    render(<HelpAssistant />);
    openDrawer();
    expect(
      screen.getByLabelText("Ask Mink AI a StoreMink question"),
    ).toBeInTheDocument();
  });

  it("sends a thumbs up, clears it when pressed again and switches to thumbs down", async () => {
    const thanks = MINK_STRINGS.en.thanks;
    render(<HelpAssistant />);
    openDrawer();
    await askStarter();

    const helpful = () => screen.getByRole("button", { name: "Helpful" });
    const notHelpful = () =>
      screen.getByRole("button", { name: "Not helpful" });
    expect(helpful()).toHaveAttribute("aria-pressed", "false");
    expect(notHelpful()).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(helpful());
    await waitFor(() => expect(rateHelpAnswer).toHaveBeenCalledTimes(1));
    const first = rateHelpAnswer.mock.calls[0][0];
    expect(first).toEqual({
      conversationId: expect.stringMatching(ID),
      messageKey: expect.stringMatching(ID),
      rating: "up",
      language: null,
      question: QUESTION,
      answer: ANSWER_TEXT,
      sources: [
        {
          title: "Process an in-store sale",
          url: "/help/point-of-sale/process-an-in-store-sale",
          category: undefined,
        },
      ],
    });
    expect(helpful()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(thanks)).toBeInTheDocument();

    fireEvent.click(helpful());
    await waitFor(() => expect(rateHelpAnswer).toHaveBeenCalledTimes(2));
    expect(rateHelpAnswer.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        rating: null,
        conversationId: first.conversationId,
        messageKey: first.messageKey,
      }),
    );
    expect(helpful()).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(thanks)).not.toBeInTheDocument();

    fireEvent.click(notHelpful());
    await waitFor(() => expect(rateHelpAnswer).toHaveBeenCalledTimes(3));
    expect(rateHelpAnswer.mock.calls[2][0]).toEqual(
      expect.objectContaining({
        rating: "down",
        conversationId: first.conversationId,
        messageKey: first.messageKey,
      }),
    );
    expect(notHelpful()).toHaveAttribute("aria-pressed", "true");
    expect(helpful()).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(thanks)).toBeInTheDocument();

    // The rating is kept with the chat in this browser.
    expect(savedChats()[0].messages[1]).toMatchObject({ rating: "down" });
    // The chat id sent with a rating is the id the chat is saved under.
    expect(savedChats()[0].id).toBe(first.conversationId);
  });

  it("puts the rating back and says why when it cannot be saved", async () => {
    render(<HelpAssistant />);
    openDrawer();
    await askStarter();

    rateHelpAnswer.mockResolvedValueOnce({
      ok: false,
      error: "Too many ratings for now. Please try again later.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Helpful" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many ratings for now. Please try again later.",
    );
    expect(screen.getByRole("button", { name: "Helpful" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByText(MINK_STRINGS.en.thanks)).not.toBeInTheDocument();

    rateHelpAnswer.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Not helpful" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        MINK_STRINGS.en.ratingError,
      ),
    );
    expect(screen.getByRole("button", { name: "Not helpful" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("saves an answered chat, lists it in the full view, reopens it and deletes it", async () => {
    render(<HelpAssistant />);
    openDrawer();
    await askStarter();

    const [saved] = savedChats();
    expect(savedChats()).toHaveLength(1);
    expect(saved).toMatchObject({ title: QUESTION, language: null });
    expect(saved.id).toMatch(ID);
    expect(saved.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(saved.messages[1]).toMatchObject({
      content: ANSWER.answer,
      answer: { answer: ANSWER.answer, steps: ANSWER.steps },
    });

    fireEvent.click(screen.getByRole("button", { name: "Mink AI options" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize Mink AI" }));
    const entry = () =>
      within(sidebar()).getByRole("button", { name: QUESTION });
    expect(entry()).toHaveAttribute("aria-current", "true");

    fireEvent.click(
      screen.getByRole("button", { name: "Start a new conversation" }),
    );
    expect(screen.queryByText(ANSWER.answer)).not.toBeInTheDocument();
    expect(entry()).not.toHaveAttribute("aria-current");

    fireEvent.click(entry());
    expect(screen.getByText(ANSWER.answer)).toBeInTheDocument();
    expect(screen.getByText("Select Take payment.")).toBeInTheDocument();
    expect(entry()).toHaveAttribute("aria-current", "true");
    // Opening a saved chat asks nothing again.
    expect(askHelpAssistant).toHaveBeenCalledTimes(1);

    fireEvent.click(
      within(sidebar()).getByRole("button", {
        name: `Delete chat: ${QUESTION}`,
      }),
    );
    expect(
      within(sidebar()).getByText(MINK_STRINGS.en.noRecent),
    ).toBeInTheDocument();
    expect(savedChats()).toEqual([]);
    // The chat on screen was the one deleted, so the drawer starts afresh.
    expect(screen.queryByText(ANSWER.answer)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Tell me what you want to do/i),
    ).toBeInTheDocument();
  });

  it("lists a chat saved earlier, restores it, and keeps the open chat when another is deleted", async () => {
    const earlier: RecentChat = {
      id: "earlier_chat_0001",
      title: "",
      updatedAt: 1,
      language: null,
      messages: [
        {
          key: "earlier_q_0001",
          role: "user",
          content: "How do I set up shipping?",
        },
        {
          key: "earlier_a_0001",
          role: "assistant",
          content: "Open the shipping settings.",
          rating: "up",
          answer: {
            answer: "Open the shipping settings.",
            steps: ["Open Settings.", "Choose Shipping and delivery."],
            notes: [],
            sources: [],
            clarificationPrompts: [],
            followUps: [],
            needsHuman: false,
          },
        },
      ],
    };
    localStorage.setItem(RECENT_CHATS_KEY, JSON.stringify([earlier]));
    render(<HelpAssistant />);
    openDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Mink AI options" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize Mink AI" }));

    fireEvent.click(
      within(sidebar()).getByRole("button", {
        name: "How do I set up shipping?",
      }),
    );
    expect(screen.getByText("Open the shipping settings.")).toBeInTheDocument();
    expect(
      screen.getByText("Choose Shipping and delivery."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Helpful" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Start a new conversation" }),
    );
    await askStarter();
    const titles = within(sidebar())
      .getAllByRole("button", { name: /^How do I/ })
      .map((button) => button.textContent);
    expect(titles).toEqual([QUESTION, "How do I set up shipping?"]);

    fireEvent.click(
      within(sidebar()).getByRole("button", {
        name: "Delete chat: How do I set up shipping?",
      }),
    );
    expect(savedChats().map((chat) => chat.title)).toEqual([QUESTION]);
    expect(screen.getByText(ANSWER.answer)).toBeInTheDocument();
    expect(
      within(sidebar()).queryByRole("button", {
        name: "How do I set up shipping?",
      }),
    ).not.toBeInTheDocument();
  });

  it("opens maximized from the open-Mink event when it asks to expand", () => {
    render(<HelpAssistant />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => openHelpMink({ expand: true }));

    const dialog = screen.getByRole("dialog", {
      name: "Mink AI Help Assistant",
    });
    expect(dialog).toHaveClass("is-maximized");
    fireEvent.click(screen.getByRole("button", { name: "Mink AI options" }));
    expect(
      screen.getByRole("button", { name: "Restore Mink AI drawer" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("separator", { name: "Resize Mink AI drawer" }),
    ).not.toBeInTheDocument();
    expect(sidebar()).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("opens as the drawer without expand, and asks the question the event carries", async () => {
    render(<HelpAssistant />);

    act(() => openHelpMink({ question: "  How do I complete a POS sale?  " }));

    const dialog = screen.getByRole("dialog", {
      name: "Mink AI Help Assistant",
    });
    expect(dialog).not.toHaveClass("is-maximized");
    expect(
      screen.getByRole("separator", { name: "Resize Mink AI drawer" }),
    ).toBeInTheDocument();
    await screen.findByText(ANSWER.answer);
    expect(askHelpAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ message: "How do I complete a POS sale?" }),
    );
  });

  it("does not expand for an expand value that is not exactly true", () => {
    render(<HelpAssistant />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_HELP_MINK_EVENT, { detail: { expand: "yes" } }),
      );
    });
    expect(
      screen.getByRole("dialog", { name: "Mink AI Help Assistant" }),
    ).not.toHaveClass("is-maximized");
  });
});
