// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({ pathname: "/orders/abc" }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AccountNav } from "./account-nav";

describe("AccountNav", () => {
  it("links the three account pages and marks the one the shopper is on", () => {
    render(<AccountNav />);
    const nav = screen.getByRole("navigation", { name: "Account" });
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/profile",
      "/orders",
      "/notifications",
    ]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([
      null,
      "page",
      null,
    ]);
  });
});
