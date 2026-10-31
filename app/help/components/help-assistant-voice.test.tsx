// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HelpAssistant } from "./help-assistant";
import { openHelpMink } from "./mink-launch";

const { askHelpAssistant, support, captureClosed } = vi.hoisted(() => ({
  askHelpAssistant: vi.fn(),
  support: { microphone: true, speech: true },
  captureClosed: { count: 0 },
}));

vi.mock("@/app/actions/help-assistant-actions", () => ({
  askHelpAssistant: (...args: unknown[]) => askHelpAssistant(...args),
}));

vi.mock("./help-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./help-voice")>();
  return { ...actual, useHelpVoiceSupport: () => support };
});

// The real capture would ask the browser for a microphone; this one waits
// until voice chat ends.
vi.mock("@/lib/mink/voice-turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mink/voice-turn")>();
  return {
    ...actual,
    createMinkVoiceCapture: () => ({
      capture: (input: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          input.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("ended"), { name: "AbortError" })),
          ),
        ),
      close: () => {
        captureClosed.count += 1;
      },
    }),
  };
});

describe("HelpAssistant voice", () => {
  beforeEach(() => {
    localStorage.clear();
    support.microphone = true;
    support.speech = true;
    captureClosed.count = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    askHelpAssistant.mockReset();
    askHelpAssistant.mockResolvedValue({
      success: true,
      data: {
        answer: "Open Products and select Add product.",
        steps: [],
        notes: [],
        sources: [
          {
            title: "Add your first product",
            url: "/help/products/add-your-first-product",
            excerpt: "Create a product.",
          },
        ],
        clarificationPrompts: [],
        followUps: [],
        needsHuman: false,
      },
    });
  });

  it("offers dictation and a spoken conversation when voice is on", () => {
    render(<HelpAssistant voiceEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));

    expect(
      screen.getByRole("button", { name: "Dictate your question" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Talk with Mink AI" }).length,
    ).toBeGreaterThan(0);
  });

  it("offers no voice controls while voice is off for the platform", () => {
    render(<HelpAssistant voiceEnabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));

    expect(
      screen.queryByRole("button", { name: "Dictate your question" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Talk with Mink AI" }),
    ).not.toBeInTheDocument();
  });

  it("offers dictation but not a conversation when the browser cannot speak", () => {
    support.speech = false;
    render(<HelpAssistant voiceEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));

    expect(
      screen.getByRole("button", { name: "Dictate your question" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Talk with Mink AI" }),
    ).not.toBeInTheDocument();
  });

  it("swaps the message box for the voice bar, and End puts it back", async () => {
    render(<HelpAssistant voiceEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Talk with Mink AI" })[0],
    );

    expect(
      screen.getByRole("group", { name: "Voice chat with Mink AI" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Listening/)).toBeInTheDocument(),
    );
    expect(
      screen.queryByLabelText("Ask Mink AI a StoreMink question"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "End voice chat" }));
    expect(
      screen.queryByRole("group", { name: "Voice chat with Mink AI" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Ask Mink AI a StoreMink question"),
    ).toBeInTheDocument();
    expect(captureClosed.count).toBe(1);
  });

  it("opens and asks a question sent from elsewhere on the page", async () => {
    render(<HelpAssistant voiceEnabled />);
    act(() => openHelpMink({ question: "How do I add my first product?" }));

    expect(
      screen.getByRole("dialog", { name: "Mink AI Help Assistant" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(askHelpAssistant).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "How do I add my first product?",
        }),
      ),
    );
    expect(
      await screen.findByText("Open Products and select Add product."),
    ).toBeInTheDocument();
  });

  it("opens straight into a spoken conversation from the page's Talk button", async () => {
    render(<HelpAssistant voiceEnabled />);
    act(() => openHelpMink({ mode: "talk" }));

    expect(
      screen.getByRole("group", { name: "Voice chat with Mink AI" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Close Mink AI" })[0],
    );
    expect(captureClosed.count).toBe(1);
  });
});
