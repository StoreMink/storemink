// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemesTabs } from "./themes-tabs";

// The Themes page's two tabs (wave TS-2, builder 2D): each is an address,
// and the tab list behaves like one from the keyboard.

const ids = { catalog: "tab-catalog", studio: "tab-studio" };

function renderTabs(selected: "catalog" | "studio" = "catalog") {
  return render(
    <ThemesTabs
      selected={selected}
      counts={{ catalog: 7, studio: null }}
      panelId="panel"
      tabId={ids}
    />,
  );
}

afterEach(cleanup);

describe("the Themes tabs", () => {
  it("are two links in a tab list; only the open one is in the tab order", () => {
    renderTabs("studio");
    const [catalog, studio] = screen.getAllByRole("tab");
    expect(catalog.getAttribute("href")).toBe("/dashboard/themes");
    expect(studio.getAttribute("href")).toBe("/dashboard/themes/studio");
    expect(studio.getAttribute("aria-selected")).toBe("true");
    expect(catalog.getAttribute("aria-selected")).toBe("false");
    expect(studio.getAttribute("tabindex")).toBe("0");
    expect(catalog.getAttribute("tabindex")).toBe("-1");
    expect(studio.getAttribute("aria-controls")).toBe("panel");
    expect(catalog.getAttribute("aria-controls")).toBeNull();
    expect(studio.id).toBe("tab-studio");
    // A count that could not be read shows no number.
    expect(catalog.textContent).toBe("Catalog7");
    expect(studio.textContent).toBe("Theme Studio");
  });

  it("moves with the arrow keys, Home and End, wrapping round", () => {
    renderTabs("catalog");
    const [catalog, studio] = screen.getAllByRole("tab");
    catalog.focus();
    fireEvent.keyDown(catalog, { key: "ArrowRight" });
    expect(document.activeElement).toBe(studio);
    fireEvent.keyDown(studio, { key: "ArrowRight" });
    expect(document.activeElement).toBe(catalog);
    fireEvent.keyDown(catalog, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(studio);
    fireEvent.keyDown(studio, { key: "Home" });
    expect(document.activeElement).toBe(catalog);
    fireEvent.keyDown(catalog, { key: "End" });
    expect(document.activeElement).toBe(studio);
  });

  it("opens a tab with Space as well as Enter", () => {
    renderTabs("catalog");
    const studio = screen.getAllByRole("tab")[1];
    const clicked = vi.fn((event: MouseEvent) => event.preventDefault());
    studio.addEventListener("click", clicked);
    fireEvent.keyDown(studio, { key: " " });
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
