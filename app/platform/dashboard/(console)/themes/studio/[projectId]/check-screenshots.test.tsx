// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThemeStudioCheckScreenshotSample } from "@/lib/theme-studio/progress";
import {
  CheckScreenshots,
  screenshotSequence,
  screenshotUrl,
  screenshotWidths,
} from "./check-screenshots";

// The Checks tab's Screenshots section (owner-approved, 24 Oct 2026): closed
// until opened, one width at a time, lazy thumbnails from the bytes route,
// and an in-app viewer driven by the arrow keys and swipes.

afterEach(() => cleanup());

function sample(
  page: string,
  viewport: string,
  n: number,
): ThemeStudioCheckScreenshotSample {
  return {
    assetId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    page,
    viewport,
    width: viewport === "desktop1440" ? 1440 : 390,
    height: 4000 + n,
  };
}

// Stored in the capture's order: by width, then page.
const samples = [
  sample("home", "phone390", 1),
  sample("product", "phone390", 2),
  sample("home", "phone360", 3),
  sample("product", "phone360", 4),
  sample("home", "desktop1440", 5),
];

function show() {
  render(
    <CheckScreenshots
      projectId="p 1"
      samples={samples}
      takenAt="25 Oct 2026, 10:05"
    />,
  );
}

function images() {
  return document.querySelectorAll("img");
}

describe("the screenshots section", () => {
  it("says plainly when the check stored none", () => {
    render(<CheckScreenshots projectId="p" samples={[]} takenAt={null} />);
    expect(screen.getByText(/No screenshots yet/).textContent).toMatch(
      /a layout check takes none/,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(images()).toHaveLength(0);
  });

  it("loads nothing until it is opened, then one width at a time, lazily, from the bytes route", () => {
    show();
    expect(images()).toHaveLength(0);
    const toggle = screen.getByRole("button", {
      name: "Show the screenshots (5)",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The narrowest width first, whatever order the check stored them in.
    const widths = screen.getByRole("group", { name: "Screen width" });
    expect(
      within(widths)
        .getAllByRole("button")
        .map((b) => [b.textContent, b.getAttribute("aria-pressed")]),
    ).toEqual([
      ["Phone 360", "true"],
      ["Phone 390", "false"],
      ["Desktop 1440", "false"],
    ]);
    const shown = [...images()];
    expect(shown).toHaveLength(2);
    for (const img of shown) {
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("decoding")).toBe("async");
      expect(img.getAttribute("src")).toMatch(
        /^\/api\/platform\/theme-studio\/projects\/p%201\/check-screenshots\/[0-9a-f-]{36}$/,
      );
      expect(img.getAttribute("src")).not.toMatch(/^data:/);
    }
    expect(shown[0].getAttribute("width")).toBe("390");
    expect(shown[0].getAttribute("height")).toBe("4003");
    expect(screen.getByText("Taken 25 Oct 2026, 10:05")).toBeTruthy();
  });

  it("switches width, showing only that width's pages", () => {
    show();
    fireEvent.click(
      screen.getByRole("button", { name: /Show the screenshots/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Desktop 1440" }));
    expect(
      screen
        .getByRole("button", { name: "Desktop 1440" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(images()).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "Open Home, Desktop 1440, full size",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Phone 360, full size/ }),
    ).toBeNull();
  });
});

describe("the viewer", () => {
  function open(name: string) {
    show();
    fireEvent.click(
      screen.getByRole("button", { name: /Show the screenshots/ }),
    );
    const thumb = screen.getByRole("button", { name });
    fireEvent.click(thumb);
    return thumb;
  }

  it("shows one picture full size, named under it, with only that picture loaded", async () => {
    open("Open Product, Phone 360, full size");
    const dialog = await screen.findByRole("dialog");
    const big = within(dialog).getByRole("img");
    expect(big.getAttribute("alt")).toBe("Product, Phone 360, the whole page");
    expect(big.getAttribute("src")).toBe(
      screenshotUrl("p 1", samples[3].assetId),
    );
    expect(within(dialog).getByText(/Product, Phone 360/).tagName).toBe(
      "FIGCAPTION",
    );
    expect(within(dialog).getByText("(2 of 5)")).toBeTruthy();
  });

  it("moves with the arrow keys between the pages and on to the next width", async () => {
    open("Open Product, Phone 360, full size");
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(within(dialog).getByRole("img").getAttribute("alt")).toBe(
      "Home, Phone 390, the whole page",
    );
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(within(dialog).getByRole("img").getAttribute("alt")).toBe(
      "Home, Phone 360, the whole page",
    );
    // At the first picture it stays, and Previous waits.
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(within(dialog).getByText("(1 of 5)")).toBeTruthy();
    const previous = within(dialog).getByRole("button", { name: "Previous" });
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(previous);
    expect(within(dialog).getByText("(1 of 5)")).toBeTruthy();
  });

  it("keeps focus on Next at the last picture, so the arrow keys still work", async () => {
    open("Open Product, Phone 360, full size");
    const dialog = await screen.findByRole("dialog");
    for (let i = 0; i < 3; i += 1)
      fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(within(dialog).getByText("(5 of 5)")).toBeTruthy();
    const next = within(dialog).getByRole("button", { name: "Next" });
    // Focusable at the end (a disabled button would drop focus out of the
    // dialog, where the arrow keys do nothing).
    expect((next as HTMLButtonElement).disabled).toBe(false);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    next.focus();
    fireEvent.click(next);
    expect(document.activeElement).toBe(next);
    expect(within(dialog).getByText("(5 of 5)")).toBeTruthy();
    fireEvent.keyDown(next, { key: "ArrowLeft" });
    expect(within(dialog).getByText("(4 of 5)")).toBeTruthy();
    expect(next.getAttribute("aria-disabled")).toBe("false");
  });

  it("moves with a sideways swipe, never with a scroll", async () => {
    open("Open Home, Phone 360, full size");
    const dialog = await screen.findByRole("dialog");
    const holder = within(dialog).getByRole("img").parentElement!;
    fireEvent.pointerDown(holder, { clientX: 300, clientY: 100 });
    fireEvent.pointerUp(holder, { clientX: 100, clientY: 110 });
    expect(within(dialog).getByText("(2 of 5)")).toBeTruthy();
    // Mostly up or down: a scroll, not a swipe.
    fireEvent.pointerDown(holder, { clientX: 300, clientY: 100 });
    fireEvent.pointerUp(holder, { clientX: 240, clientY: 400 });
    expect(within(dialog).getByText("(2 of 5)")).toBeTruthy();
    fireEvent.pointerDown(holder, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(holder, { clientX: 300, clientY: 100 });
    expect(within(dialog).getByText("(1 of 5)")).toBeTruthy();
  });

  it("closes with Escape and gives focus back to the thumbnail", async () => {
    const thumb = open("Open Product, Phone 360, full size");
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(thumb));
  });
});

describe("ordering", () => {
  it("orders the widths narrowest first and the pictures width by width", () => {
    expect(screenshotWidths(samples)).toEqual([
      "phone360",
      "phone390",
      "desktop1440",
    ]);
    expect(screenshotSequence(samples).map((s) => s.assetId)).toEqual([
      samples[2].assetId,
      samples[3].assetId,
      samples[0].assetId,
      samples[1].assetId,
      samples[4].assetId,
    ]);
    expect(
      screenshotWidths([...samples, sample("home", "watch200", 9)]).at(-1),
    ).toBe("watch200");
  });
});
