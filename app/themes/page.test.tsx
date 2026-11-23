// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/themes/runtime-registry", async () => {
  const { THEME_META } = await import("@/lib/themes/meta");
  return { getThemeCatalog: vi.fn(async () => [...THEME_META]) };
});

import ThemesPage from "./page";
import {
  THEME_META,
  canPreviewTheme,
  isThemeSelectable,
  newestThemesFirst,
} from "@/lib/themes/meta";

// Derived from THEME_META rather than hardcoded: these assertions are about the
// catalog's RULES (only a healthy demo is linked; newest releases lead), not
// about which themes happen to exist today. Publishing a theme used to break
// these with no rule having changed.
const selectable = THEME_META.filter(isThemeSelectable);
const showcaseOrder = newestThemesFirst(selectable);

describe("public theme catalog", () => {
  it("renders catalog metadata and never links an unhealthy demo", async () => {
    render(await ThemesPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("heading", {
        name: /make your store impossible to scroll past/i,
      }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Basket" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Studio" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ritual" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Vitrine" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Home & Decor" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Beauty" })).toBeVisible();
    expect(screen.getByText("Live preview being restored")).toBeVisible();
    // Exactly the themes with a healthy demo get a live link — no more, no
    // fewer — and each points at that theme's own demo host.
    expect(
      screen
        .getAllByRole("link", { name: /view live store/i })
        .map((link) => link.getAttribute("href"))
        .sort(),
    ).toEqual(
      selectable
        .filter(canPreviewTheme)
        .map((t) => `https://${t.demo.slug}.storemink.com`)
        .sort(),
    );
    expect(selectable.some((t) => !canPreviewTheme(t))).toBe(true);
    expect(
      screen.getByRole("link", { name: /start with basket/i }),
    ).toHaveAttribute("href", "https://storemink.com/signup");
  });

  it("supports server-rendered industry filters", async () => {
    render(
      await ThemesPage({
        searchParams: Promise.resolve({ industry: "food-and-drink" }),
      }),
    );

    expect(
      screen.getByRole("link", { name: "Food & Beverages" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Basket" })).toBeVisible();
  });

  it("lists every theme at once, newest first, in one grid", async () => {
    render(await ThemesPage({ searchParams: Promise.resolve({}) }));

    const grid = screen.getByRole("list", { name: "Theme collection" });
    expect(
      within(grid)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(showcaseOrder.map((theme) => theme.name));
    expect(within(grid).getAllByRole("listitem")).toHaveLength(
      showcaseOrder.length,
    );
    expect(
      screen.getByText(
        `${showcaseOrder.length} ${showcaseOrder.length === 1 ? "theme" : "themes"}`,
      ),
    ).toBeVisible();
    // Nothing to page through: the sideways rail and its buttons are gone.
    expect(screen.queryByRole("button")).toBeNull();
  });

  // Owner, 23 Nov 2026: "no need of theme descriptions to show on the page".
  // A card is its picture, its name, its plans and what it suits.
  it("shows no theme description and no feature list on a card", async () => {
    const { container } = render(
      await ThemesPage({ searchParams: Promise.resolve({}) }),
    );

    for (const theme of selectable) {
      expect(theme.description.length).toBeGreaterThan(20);
      expect(container.textContent).not.toContain(theme.description);
      // The feature ticks were a list inside the card; a card holds none now.
      const card = container.querySelector<HTMLElement>(`#${theme.id}`)!;
      expect(within(card).queryByRole("list")).toBeNull();
      expect(card.querySelectorAll("p")).toHaveLength(1);
    }
    const card = container.querySelector<HTMLElement>("#basket")!;
    expect(within(card).getByText("Food & Beverages")).toBeVisible();
    expect(within(card).getByText("All plans")).toBeVisible();
  });

  it("opens the live store from the picture only when the demo is healthy", async () => {
    render(await ThemesPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen
        .getAllByRole("link", { name: /^preview .+ theme$/i })
        .map((link) => link.getAttribute("href"))
        .sort(),
    ).toEqual(
      selectable
        .filter(canPreviewTheme)
        .map((t) => `https://${t.demo.slug}.storemink.com`)
        .sort(),
    );
    // Every card still shows its picture, linked or not.
    for (const theme of selectable) {
      expect(
        screen.getByAltText(`${theme.name} theme storefront preview`),
      ).toBeInTheDocument();
    }
  });

  it("names the catalogue after the chosen category", async () => {
    render(
      await ThemesPage({
        searchParams: Promise.resolve({ industry: "food-and-drink" }),
      }),
    );

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Food & Beverages themes",
      }),
    ).toBeVisible();
    const grid = screen.getByRole("list", { name: "Theme collection" });
    expect(
      within(grid)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(
      showcaseOrder
        .filter((theme) => theme.catalog.industries.includes("food-and-drink"))
        .map((theme) => theme.name),
    );
  });
});
