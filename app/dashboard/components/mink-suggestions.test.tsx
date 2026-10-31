// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MinkHomeSuggestion } from "@/lib/mink/home-suggestion-rules";
import { MinkSuggestions } from "./mink-suggestions";

const startExpandedChat = vi.hoisted(() => vi.fn());

vi.mock("../chat-context", () => ({
  useChat: vi.fn(() => ({ startExpandedChat })),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const SUGGESTIONS: MinkHomeSuggestion[] = [
  {
    id: "stale_orders",
    title: "2 orders have waited over 48 hours",
    detail:
      "2 still pending, placed more than 48 hours ago and not shipped yet.",
    href: "/dashboard/orders?status=pending",
    askMink: "Which of my orders have been pending for more than 48 hours?",
  },
  {
    id: "out_of_stock",
    title: "3 items are out of stock",
    detail: "Nobody can buy an item at zero stock.",
    href: "/dashboard/inventory?filter=out",
    askMink: "Which items are out of stock right now?",
  },
];

describe("MinkSuggestions", () => {
  it("renders nothing when there is nothing to suggest", () => {
    const { container } = render(
      <MinkSuggestions suggestions={[]} canAskMink />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the ranked list with a verb link per row", () => {
    render(<MinkSuggestions suggestions={SUGGESTIONS} canAskMink />);

    expect(
      screen.getByRole("heading", { name: "Mink suggests" }),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("1");
    expect(rows[0]).toHaveTextContent("2 orders have waited over 48 hours");
    expect(rows[0]).toHaveTextContent("2 still pending");
    expect(rows[1]).toHaveTextContent("3 items are out of stock");

    expect(screen.getByRole("link", { name: /Open orders/ })).toHaveAttribute(
      "href",
      "/dashboard/orders?status=pending",
    );
    expect(
      screen.getByRole("link", { name: /Open inventory/ }),
    ).toHaveAttribute("href", "/dashboard/inventory?filter=out");
  });

  it("opens the chat with the row's question on Ask Mink", () => {
    render(<MinkSuggestions suggestions={SUGGESTIONS} canAskMink />);

    const buttons = screen.getAllByRole("button", { name: /Ask Mink/ });
    expect(buttons).toHaveLength(2);
    // Mink's face, not a generic sparkle, and hidden from screen readers.
    const face = buttons[0].querySelector("svg[data-mink-face]");
    expect(face?.getAttribute("width")).toBe("18");
    expect(face?.getAttribute("aria-hidden")).toBe("true");
    expect(buttons[0].querySelector(".lucide-sparkles")).toBeNull();
    fireEvent.click(buttons[1]);
    expect(startExpandedChat).toHaveBeenCalledTimes(1);
    expect(startExpandedChat).toHaveBeenCalledWith(
      "Which items are out of stock right now?",
    );
  });

  it("keeps the link but hides Ask Mink when Mink is off", () => {
    render(<MinkSuggestions suggestions={SUGGESTIONS} canAskMink={false} />);

    expect(screen.queryByRole("button", { name: /Ask Mink/ })).toBeNull();
    expect(
      screen.getByRole("link", { name: /Open orders/ }),
    ).toBeInTheDocument();
  });

  it("stacks the actions on a phone and rows them from sm", () => {
    render(<MinkSuggestions suggestions={SUGGESTIONS} canAskMink />);

    const row = screen.getAllByRole("listitem")[0];
    expect(row).toHaveClass("flex-col", "sm:flex-row");
    const actions = screen.getByRole("link", { name: /Open orders/ })
      .parentElement as HTMLElement;
    expect(actions).toHaveClass(
      "w-full",
      "flex-col",
      "sm:w-auto",
      "sm:flex-row",
    );
  });

  it("never renders an em dash", () => {
    const { container } = render(
      <MinkSuggestions suggestions={SUGGESTIONS} canAskMink />,
    );
    expect(container.textContent).not.toContain("—");
  });
});
