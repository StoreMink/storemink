// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  pathname: "/help",
  search: "",
}));
const { openHelpMink } = vi.hoisted(() => ({ openHelpMink: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("./mink-launch", () => ({ openHelpMink }));
vi.mock("./help-assistant", () => ({
  HelpAssistant: () => <div data-testid="assistant" />,
}));
vi.mock("../../platform/brand-mark", () => ({
  BrandMark: () => <span data-testid="mark" />,
}));
vi.mock("@/app/actions/help-actions", () => ({
  suggestHelpArticles: vi.fn(async () => []),
}));

import { HelpHeader, isHelpHomePath, isHelpSearchPath } from "./help-header";

beforeEach(() => {
  nav.pathname = "/help";
  nav.search = "";
});

describe("help header paths", () => {
  it("treats every form of the home address as home", () => {
    expect(isHelpHomePath("/")).toBe(true);
    expect(isHelpHomePath("/help")).toBe(true);
    expect(isHelpHomePath("/help/")).toBe(true);
    expect(isHelpHomePath("/help/domains")).toBe(false);
    expect(isHelpHomePath(null)).toBe(false);
  });

  it("knows the search page by either address", () => {
    expect(isHelpSearchPath("/search")).toBe(true);
    expect(isHelpSearchPath("/help/search")).toBe(true);
    expect(isHelpSearchPath("/help/searching/x")).toBe(false);
  });
});

describe("HelpHeader", () => {
  it("shows the section links on the home page instead of a second search", () => {
    render(<HelpHeader voiceEnabled />);
    const links = screen.getAllByRole("navigation", { name: "Help Centre" })[0];
    expect(within(links).getByRole("link", { name: "Guides" })).toHaveAttribute(
      "href",
      "/help#topics",
    );
    expect(
      within(links).getByRole("link", { name: "Contact support" }),
    ).toHaveAttribute("href", "/help#contact");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

    fireEvent.click(within(links).getByRole("button", { name: "Mink AI" }));
    expect(openHelpMink).toHaveBeenCalledWith({ expand: true });
  });

  it("keeps the search that was made in the box on the results page", () => {
    nav.pathname = "/search";
    nav.search = "q=domain";
    render(<HelpHeader voiceEnabled />);
    expect(screen.getByRole("searchbox")).toHaveValue("domain");
  });

  it("starts the box empty on a guide page", () => {
    nav.pathname = "/help/domains/connect-a-domain";
    nav.search = "q=ignored";
    render(<HelpHeader voiceEnabled />);
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("opens and closes the menu, and Escape returns focus to its button", () => {
    render(<HelpHeader voiceEnabled />);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Close menu");
    const menu = document.getElementById("hc-mobile-menu");
    expect(menu).not.toBeNull();
    expect(
      within(menu as HTMLElement).getByRole("link", {
        name: "Create your store",
      }),
    ).toHaveAttribute("href", "https://storemink.com/signup");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("hc-mobile-menu")).toBeNull();
    expect(toggle).toHaveFocus();
  });

  it("closes the menu when Mink AI is opened from it", () => {
    render(<HelpHeader voiceEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const menu = document.getElementById("hc-mobile-menu") as HTMLElement;
    fireEvent.click(within(menu).getByRole("button", { name: "Mink AI" }));
    expect(openHelpMink).toHaveBeenCalledWith({ expand: true });
    expect(document.getElementById("hc-mobile-menu")).toBeNull();
  });
});
