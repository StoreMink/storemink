// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => ({
  open: vi.fn(),
}));
vi.mock("@/app/actions/theme-studio-actions", () => ({
  openThemeStudioPreviewAction: preview.open,
}));
import {
  PreviewFrame,
  previewScale,
  previewStartViewport,
} from "./preview-frame";

// The Preview tab's frame (plan section 4): it fits the width AND the height
// of its box, starts smaller than Desktop in a narrow box, and the pop-out
// opens its window inside the tap.

const viewports = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

const opened = {
  ok: true,
  preview: {
    previewId: "pv",
    storeId: "s",
    origin: "https://preview-abc.storemink.com",
    enterToken: "tok",
    pages: [
      { surface: "home", label: "Home", path: "/" },
      { surface: "shop", label: "Shop", path: "/shop" },
    ],
    expiresAt: "2026-10-25T06:00:00Z",
  },
};

/** A ResizeObserver that reports one box size to every observer. */
let box = { width: 1200, height: 700 };
class FakeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(element: Element) {
    Object.defineProperty(element, "clientWidth", {
      configurable: true,
      get: () => box.width,
    });
    Object.defineProperty(element, "clientHeight", {
      configurable: true,
      get: () => box.height,
    });
    this.callback([], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function frameBox(): { width: number; height: number } {
  const frame = document.querySelector<HTMLElement>(".studio-preview-frame")!;
  return {
    width: Number.parseFloat(frame.style.width),
    height: Number.parseFloat(frame.style.height),
  };
}

describe("fitting the preview", () => {
  it("scales to whichever of the width or the height is tighter, never above real size", () => {
    expect(previewScale({ width: 720, height: 2000 }, viewports.desktop)).toBe(
      0.5,
    );
    expect(previewScale({ width: 2000, height: 450 }, viewports.desktop)).toBe(
      0.5,
    );
    expect(previewScale({ width: 3000, height: 3000 }, viewports.desktop)).toBe(
      1,
    );
    // A phone frame fits the screen's height instead of running past it.
    expect(
      previewScale({ width: 390, height: 600 }, viewports.mobile),
    ).toBeCloseTo(600 / 844);
  });

  it("starts at Tablet below about 900 px of box, and at Phone on a phone", () => {
    expect(previewStartViewport(1200)).toBe("desktop");
    expect(previewStartViewport(899)).toBe("tablet");
    expect(previewStartViewport(600)).toBe("tablet");
    expect(previewStartViewport(599)).toBe("mobile");
  });

  it("draws the frame at the fitted size of its box", async () => {
    preview.open.mockResolvedValue(opened);
    box = { width: 1200, height: 500 };
    render(<PreviewFrame projectId="p" versionId="v" viewports={viewports} />);
    await screen.findByRole("button", { name: "Home" });
    // 1440 by 900 into 1200 by 500: the height is tighter (500 / 900).
    expect(frameBox().width).toBeCloseTo(800);
    expect(frameBox().height).toBeCloseTo(500);
    expect(
      screen
        .getByRole("button", { name: /Desktop/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("opens at Tablet in a narrow box until the operator picks a size", async () => {
    preview.open.mockResolvedValue(opened);
    box = { width: 700, height: 1000 };
    render(<PreviewFrame projectId="p" versionId="v" viewports={viewports} />);
    await screen.findByRole("button", { name: "Home" });
    expect(
      screen
        .getByRole("button", { name: /Tablet/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Phone/ }));
    expect(
      screen
        .getByRole("button", { name: /Phone/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(frameBox().height).toBeCloseTo(
      844 * Math.min(1, 700 / 390, 1000 / 844),
    );
  });

  it("keeps the screen sizes in the buttons' names only, in a box too narrow for them", async () => {
    preview.open.mockResolvedValue(opened);
    box = { width: 332, height: 520 };
    const view = render(
      <PreviewFrame projectId="p" versionId="v" viewports={viewports} />,
    );
    await screen.findByRole("button", { name: "Home" });
    const phone = screen.getByRole("button", { name: /Phone/ });
    // Still named with its size for a screen reader...
    expect(phone.textContent).toContain("390×844");
    // ...but not drawn: with the sizes the group is about 470 px wide.
    const size = [...phone.querySelectorAll("span")].find((span) =>
      span.textContent?.includes("390×844"),
    );
    expect(size?.className).toBe("sr-only");
    view.unmount();
    box = { width: 1200, height: 700 };
    render(<PreviewFrame projectId="p" versionId="v" viewports={viewports} />);
    await screen.findByRole("button", { name: "Home" });
    const wide = [
      ...screen.getByRole("button", { name: /Phone/ }).querySelectorAll("span"),
    ].find((span) => span.textContent?.includes("390×844"));
    expect(wide?.className).toBe("studio-muted");
  });
});

describe("Open full page", () => {
  it("opens the window inside the tap and fills in its address when the token arrives", async () => {
    box = { width: 1200, height: 700 };
    preview.open.mockResolvedValueOnce({ ok: false, error: "Not yet." });
    const win = {
      opener: {} as unknown,
      closed: false,
      document: { title: "", body: { textContent: "" } },
      location: { replace: vi.fn() },
      close: vi.fn(),
    };
    const open = vi.fn(() => win);
    vi.stubGlobal("open", open);
    render(<PreviewFrame projectId="p" versionId="v" viewports={viewports} />);
    await screen.findByRole("alert");
    let resolve: (value: typeof opened) => void = () => {};
    preview.open.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Open full page/ }));
    // The window exists before the server answered: a browser allows it only
    // inside the tap.
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(win.opener).toBeNull();
    expect(win.location.replace).not.toHaveBeenCalled();
    await act(async () => resolve(opened));
    await waitFor(() =>
      expect(win.location.replace).toHaveBeenCalledWith(
        "https://preview-abc.storemink.com/api/theme-studio/preview/enter?token=tok&path=%2F",
      ),
    );
  });

  it("opens the address at once when a fresh token is at hand", async () => {
    box = { width: 1200, height: 700 };
    preview.open.mockResolvedValue(opened);
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    render(<PreviewFrame projectId="p" versionId="v" viewports={viewports} />);
    await screen.findByRole("button", { name: "Home" });
    fireEvent.click(screen.getByRole("button", { name: /Open full page/ }));
    expect(open).toHaveBeenCalledWith(
      "https://preview-abc.storemink.com/api/theme-studio/preview/enter?token=tok&path=%2F",
      "_blank",
      "noopener",
    );
    expect(preview.open).toHaveBeenCalledTimes(1);
  });

  it("closes the blank window when the preview can't be opened", async () => {
    box = { width: 1200, height: 700 };
    preview.open.mockResolvedValue({ ok: false, error: "No preview here." });
    const win = {
      opener: null,
      closed: false,
      document: { title: "", body: { textContent: "" } },
      location: { replace: vi.fn() },
      close: vi.fn(),
    };
    vi.stubGlobal(
      "open",
      vi.fn(() => win),
    );
    render(<PreviewFrame projectId="p" versionId="v" viewports={viewports} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /Open full page/ }));
    await waitFor(() => expect(win.close).toHaveBeenCalled());
    expect(win.location.replace).not.toHaveBeenCalled();
  });
});
