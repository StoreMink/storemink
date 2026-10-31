// @vitest-environment jsdom
// The operator's view of Mink AI ratings from the Help Centre: it opens on
// "Not helpful", pages by address, and says so when the read fails rather
// than showing an empty list.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  countHelpFeedback: vi.fn(),
  listHelpFeedback: vi.fn(),
}));

vi.mock("../../require-operator", () => ({
  requireOperator: state.requireOperator,
}));
vi.mock("@/lib/help/assistant-feedback", () => ({
  countHelpFeedback: state.countHelpFeedback,
  listHelpFeedback: state.listHelpFeedback,
}));
vi.mock("@/lib/site", () => ({ HELP_URL: "https://help.storemink.com" }));

import HelpFeedbackPage from "./page";

afterEach(() => {
  cleanup();
});

const COUNTS = { up: 7, down: 3, last30Up: 4, last30Down: 2 };

const ROW = {
  id: "f1",
  rating: "down" as const,
  language: "hi",
  question: "मैं अपना डोमेन कैसे जोड़ूँ?",
  answer: "Open Settings, then Domain.",
  sources: [
    {
      title: "Connect a domain you own",
      url: "/help/storefront-setup/connect-a-custom-domain",
      category: "Custom Domain",
    },
  ],
  createdAt: "2026-10-30T05:00:00.000Z",
  updatedAt: "2026-10-30T05:00:00.000Z",
};

async function renderPage(params: Record<string, string> = {}) {
  render(await HelpFeedbackPage({ searchParams: Promise.resolve(params) }));
}

describe("Mink AI feedback page", () => {
  it("gates on the operator and opens on Not helpful", async () => {
    state.countHelpFeedback.mockResolvedValue(COUNTS);
    state.listHelpFeedback.mockResolvedValue({ rows: [ROW], hasMore: false });

    await renderPage();

    expect(state.requireOperator).toHaveBeenCalled();
    expect(state.listHelpFeedback).toHaveBeenCalledWith({
      filter: "down",
      page: 1,
    });
    expect(screen.getByText(ROW.question)).toBeTruthy();
    expect(screen.getByText("Hindi")).toBeTruthy();
    const guide = screen.getByRole("link", {
      name: "Connect a domain you own",
    });
    expect(guide.getAttribute("href")).toBe(
      "https://help.storemink.com/help/storefront-setup/connect-a-custom-domain",
    );
    expect(
      screen
        .getByRole("link", { name: "Not helpful" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("reads the filter and page from the address and links to the next page", async () => {
    state.countHelpFeedback.mockResolvedValue(COUNTS);
    state.listHelpFeedback.mockResolvedValue({
      rows: [{ ...ROW, rating: "up" as const }],
      hasMore: true,
    });

    await renderPage({ filter: "up", page: "2" });

    expect(state.listHelpFeedback).toHaveBeenCalledWith({
      filter: "up",
      page: 2,
    });
    expect(
      screen.getByRole("link", { name: "Older" }).getAttribute("href"),
    ).toBe("/dashboard/help/feedback?filter=up&page=3");
    expect(
      screen.getByRole("link", { name: "Newer" }).getAttribute("href"),
    ).toBe("/dashboard/help/feedback?filter=up");
  });

  it("treats an unknown filter as Not helpful", async () => {
    state.countHelpFeedback.mockResolvedValue(COUNTS);
    state.listHelpFeedback.mockResolvedValue({ rows: [], hasMore: false });

    await renderPage({ filter: "everything" });

    expect(state.listHelpFeedback).toHaveBeenCalledWith({
      filter: "down",
      page: 1,
    });
    expect(
      screen.getByText("No one has marked an answer as not helpful."),
    ).toBeTruthy();
  });

  it("says when the feedback cannot be read instead of showing none", async () => {
    state.countHelpFeedback.mockRejectedValue(new Error("db down"));
    state.listHelpFeedback.mockResolvedValue({ rows: [], hasMore: false });

    await renderPage();

    expect(screen.getByRole("alert").textContent).toContain("couldn't be read");
    expect(screen.queryByText("No feedback yet.")).toBeNull();
  });
});
