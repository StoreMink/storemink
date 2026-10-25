// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
}));
import {
  StudioPageProvider,
  StudioPopover,
  StudioTabList,
  useStudioIntent,
  useStudioPage,
  type StudioTabItem,
} from "./studio-tabs";
import type { StudioPageApi } from "./tab-types";

const items: StudioTabItem[] = [
  { key: "chat", label: "Chat", phoneOnly: true },
  { key: "preview", label: "Preview" },
  { key: "checks", label: "Checks", count: 2 },
  { key: "log", label: "Log" },
];

function phone(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function Tabs({ onSelect }: { onSelect?: (key: string) => void }) {
  const [selected, setSelected] = useState("preview");
  return (
    <StudioTabList
      label="Theme views"
      idPrefix="t"
      items={items}
      selected={selected}
      onSelect={(key) => {
        setSelected(key);
        onSelect?.(key);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  nav.search = "";
});

describe("the tab bar (WAI-ARIA tabs, manual activation)", () => {
  it("keeps only the selected tab in the Tab order and names its panel", () => {
    render(<Tabs />);
    const preview = screen.getByRole("tab", { name: "Preview" });
    expect(preview.getAttribute("aria-selected")).toBe("true");
    expect(preview.tabIndex).toBe(0);
    expect(preview.getAttribute("aria-controls")).toBe("t-panel-preview");
    expect(preview.id).toBe("t-tab-preview");
    for (const name of ["Log", /Checks/]) {
      const tab = screen.getByRole("tab", { name });
      expect(tab.getAttribute("aria-selected")).toBe("false");
      expect(tab.tabIndex).toBe(-1);
    }
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe(
      "Theme views",
    );
  });

  it("moves focus with the arrow keys, Home and End, and opens only on Enter or a click", () => {
    phone(false);
    const onSelect = vi.fn();
    render(<Tabs onSelect={onSelect} />);
    const preview = screen.getByRole("tab", { name: "Preview" });
    const checks = screen.getByRole("tab", { name: /Checks/ });
    const log = screen.getByRole("tab", { name: "Log" });
    preview.focus();
    fireEvent.keyDown(preview, { key: "ArrowRight" });
    expect(document.activeElement).toBe(checks);
    // Focus alone opens nothing: every other tab is a request.
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(checks, { key: "ArrowRight" });
    expect(document.activeElement).toBe(log);
    // Wraps to the first wide-screen tab; the phone-only Chat is skipped.
    fireEvent.keyDown(log, { key: "ArrowRight" });
    expect(document.activeElement).toBe(preview);
    fireEvent.keyDown(preview, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(log);
    fireEvent.keyDown(log, { key: "Home" });
    expect(document.activeElement).toBe(preview);
    fireEvent.keyDown(preview, { key: "End" });
    expect(document.activeElement).toBe(log);
    fireEvent.click(log);
    expect(onSelect).toHaveBeenCalledWith("log");
    expect(log.getAttribute("aria-selected")).toBe("true");
    expect(log.tabIndex).toBe(0);
    expect(preview.tabIndex).toBe(-1);
  });

  it("includes the Chat tab in the arrow keys on a phone", () => {
    phone(true);
    render(<Tabs />);
    const preview = screen.getByRole("tab", { name: "Preview" });
    preview.focus();
    fireEvent.keyDown(preview, { key: "Home" });
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Chat" }),
    );
  });

  it("shows a count beside a label, never a zero", () => {
    render(<Tabs />);
    expect(screen.getByRole("tab", { name: /Checks/ }).textContent).toBe(
      "Checks, 2",
    );
    expect(screen.getByRole("tab", { name: "Log" }).textContent).toBe("Log");
  });
});

describe("useStudioPage", () => {
  it("throws outside the theme page, so a misplaced part fails its test", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useStudioPage())).toThrow(
      /outside the theme page/,
    );
  });

  it("gives the page's API inside it", () => {
    const api: StudioPageApi = {
      putInChat: vi.fn(),
      openTab: vi.fn(),
      requestIntent: vi.fn(),
    };
    const { result } = renderHook(() => useStudioPage(), {
      wrapper: ({ children }) => (
        <StudioPageProvider api={api}>{children}</StudioPageProvider>
      ),
    });
    result.current.putInChat("Fix the header");
    expect(api.putInChat).toHaveBeenCalledWith("Fix the header");
  });
});

describe("useStudioIntent (?do=)", () => {
  it("acts once on its own kind and takes it out of the address", () => {
    window.history.replaceState(null, "", "/x?tab=log&do=stop");
    nav.search = "tab=log&do=stop";
    const replace = vi.spyOn(window.history, "replaceState");
    const onIntent = vi.fn();
    const view = renderHook(() => useStudioIntent(["stop"], onIntent));
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent).toHaveBeenCalledWith("stop");
    expect(replace).toHaveBeenLastCalledWith(null, "", "/x?tab=log");
    view.rerender();
    expect(onIntent).toHaveBeenCalledTimes(1);
    // Gone from the address, then asked for again: acts again.
    nav.search = "tab=log";
    view.rerender();
    nav.search = "tab=log&do=stop";
    view.rerender();
    expect(onIntent).toHaveBeenCalledTimes(2);
    replace.mockRestore();
  });

  it("leaves another control's intent, and a made-up one, alone", () => {
    window.history.replaceState(null, "", "/x?do=publish");
    nav.search = "do=publish";
    const replace = vi.spyOn(window.history, "replaceState");
    const onIntent = vi.fn();
    renderHook(() => useStudioIntent(["stop"], onIntent));
    nav.search = "do=burn_it_all";
    renderHook(() => useStudioIntent(["stop"], onIntent));
    expect(onIntent).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it("keeps the intent when the handler passes it on to a tab", () => {
    window.history.replaceState(null, "", "/x?do=describe_fix");
    nav.search = "do=describe_fix";
    const replace = vi.spyOn(window.history, "replaceState");
    renderHook(() => useStudioIntent(["describe_fix"], () => "keep"));
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });
});

describe("StudioPopover", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    return (
      <div>
        <button
          ref={trigger}
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Designs
        </button>
        <StudioPopover
          id="list"
          open={open}
          onOpenChange={setOpen}
          triggerRef={trigger}
          label="Designs list"
        >
          <p>Plain words</p>
          <button type="button">Design 2</button>
        </StudioPopover>
        <button type="button">Elsewhere</button>
      </div>
    );
  }

  it("moves focus in, and Escape closes it and gives focus back", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Designs" });
    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: "Designs list" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Design 2" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Designs list" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a press outside, but not on its own words", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Designs" }));
    fireEvent.pointerDown(screen.getByText("Plain words"));
    expect(screen.getByRole("group", { name: "Designs list" })).toBeTruthy();
    act(() => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    });
    expect(screen.queryByRole("group", { name: "Designs list" })).toBeNull();
  });

  it("stays open through a press on the phone's dim backdrop, and closes on its click", () => {
    const { container } = render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Designs" });
    fireEvent.click(trigger);
    const backdrop = container.querySelector(".studio-popover-backdrop");
    expect(backdrop).toBeTruthy();
    // Closed at pointerdown, the backdrop would be gone before the tap
    // ended, and the tap's click would land on the page beneath it.
    act(() => {
      fireEvent.pointerDown(backdrop!);
    });
    expect(screen.getByRole("group", { name: "Designs list" })).toBeTruthy();
    expect(container.querySelector(".studio-popover-backdrop")).toBe(backdrop);
    act(() => {
      fireEvent.click(backdrop!);
    });
    expect(screen.queryByRole("group", { name: "Designs list" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("a tab strip wider than its room", () => {
  function measure(
    node: HTMLElement,
    sizes: { scroll: number; client: number },
  ) {
    Object.defineProperty(node, "scrollWidth", {
      configurable: true,
      value: sizes.scroll,
    });
    Object.defineProperty(node, "clientWidth", {
      configurable: true,
      value: sizes.client,
    });
  }

  it("marks the side that has more tabs, as it scrolls", () => {
    render(<Tabs />);
    const strip = screen.getByRole("tablist", { name: "Theme views" });
    // Everything fits (jsdom measures nothing): no fade.
    expect(strip.hasAttribute("data-more-start")).toBe(false);
    expect(strip.hasAttribute("data-more-end")).toBe(false);
    measure(strip, { scroll: 485, client: 336 });
    strip.scrollLeft = 0;
    fireEvent.scroll(strip);
    expect(strip.hasAttribute("data-more-start")).toBe(false);
    expect(strip.hasAttribute("data-more-end")).toBe(true);
    strip.scrollLeft = 60;
    fireEvent.scroll(strip);
    expect(strip.hasAttribute("data-more-start")).toBe(true);
    expect(strip.hasAttribute("data-more-end")).toBe(true);
    strip.scrollLeft = 149;
    fireEvent.scroll(strip);
    expect(strip.hasAttribute("data-more-start")).toBe(true);
    expect(strip.hasAttribute("data-more-end")).toBe(false);
  });
});
