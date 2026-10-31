// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpSearchBox } from "./search-box";

const push = vi.fn();
const suggestHelpArticles = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/app/actions/help-actions", () => ({
  suggestHelpArticles: (query: string) => suggestHelpArticles(query),
}));

describe("HelpSearchBox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    push.mockReset();
    suggestHelpArticles.mockReset();
    suggestHelpArticles.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not reopen autocomplete over submitted results", async () => {
    render(
      <HelpSearchBox initialQuery="how to add GA4 Measurement ID" autoFocus />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(suggestHelpArticles).not.toHaveBeenCalled();
    expect(screen.queryByText(/No title match/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "how to add GA4 Measurement IDs" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(suggestHelpArticles).toHaveBeenCalledWith(
      "how to add GA4 Measurement IDs",
    );
    expect(screen.getByText(/No title match/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.queryByText(/No title match/i)).not.toBeInTheDocument();
    expect(push).toHaveBeenCalledWith(
      "/help/search?q=how%20to%20add%20GA4%20Measurement%20IDs",
    );
  });

  it("clears the box with one tap and keeps the cursor in it", async () => {
    render(<HelpSearchBox compact initialQuery="domain" />);
    const box = screen.getByRole("searchbox");
    expect(box).toHaveValue("domain");

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Clear search" }),
    ).not.toBeInTheDocument();
  });

  it("offers no clear button while the box is empty", () => {
    render(<HelpSearchBox compact />);
    expect(
      screen.queryByRole("button", { name: "Clear search" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "g" },
    });
    expect(
      screen.getByRole("button", { name: "Clear search" }),
    ).toBeInTheDocument();
  });
});
