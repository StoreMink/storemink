// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The picture runs the theme page starts (wave TS-2, builder 2C): one click
// with a small confirm that names how many, instead of "Generate images"
// then "Draw N images"; the cost at list price only inside the confirm; an
// intent only opens the confirm.

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const nav = vi.hoisted(() => ({ search: "" }));
const actions = vi.hoisted(() => ({
  queueThemeStudioImagesAction: vi.fn(async () => ({ ok: true, id: "run" })),
  retryThemeStudioRunAction: vi.fn(async () => ({ ok: true, id: "run" })),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/app/actions/theme-studio-actions", () => actions);
vi.mock("sonner", () => ({ toast }));

import {
  GenerateImagesButton,
  PictureIntentFallback,
  RedrawPicturesButton,
  RetryPicturesButton,
} from "./generate-images-button";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

const target = {
  projectId: "p",
  versionId: "v",
  versionNumber: 4,
  revision: 9,
  packageDigest: "d".repeat(64),
};
const estimate = { images: 7, expectedUsd: 0.72, mostUsd: 1.44 };

beforeEach(() => {
  nav.search = "";
  window.history.replaceState(
    null,
    "",
    "/dashboard/themes/studio/p?tab=pictures",
  );
});
afterEach(() => cleanup());

describe("Draw missing pictures", () => {
  it("is one click, then a small confirm that names how many and what it may cost", async () => {
    const { container } = render(
      <GenerateImagesButton
        {...target}
        slots={6}
        estimate={estimate}
        blockedReason={null}
      />,
    );
    // The main view carries no cost line.
    expect(container.textContent).not.toMatch(/\$/);
    fireEvent.click(
      screen.getByRole("button", { name: "Draw missing pictures" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Draw 6 missing pictures?")).toBeTruthy();
    expect(dialog.textContent).toMatch(/each of the 6 placeholders/);
    expect(dialog.textContent).toMatch(/Design 4 stays as it is/);
    expect(dialog.textContent).toMatch(
      /That is 7 pictures, about \$0\.72 at list price, or at most \$1\.44/,
    );
    expect(actions.queueThemeStudioImagesAction).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Draw 6 pictures" }),
    );
    await waitFor(() =>
      expect(actions.queueThemeStudioImagesAction).toHaveBeenCalledTimes(1),
    );
    const sent = (
      actions.queueThemeStudioImagesAction.mock.calls[0] as unknown[]
    )[0] as { slotIds?: unknown; idempotencyKey: string };
    expect(sent).toMatchObject({
      projectId: "p",
      versionId: "v",
      expectedRevision: 9,
      expectedPackageDigest: "d".repeat(64),
    });
    // Every placeholder: no slots named.
    expect(sent.slotIds).toBeUndefined();
    expect(sent.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.refresh).toHaveBeenCalled();
  });

  it("names the offline test provider as free, and shows nothing when no placeholder is left", () => {
    render(
      <GenerateImagesButton
        {...target}
        slots={1}
        estimate={null}
        blockedReason={null}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Draw missing pictures" }),
    );
    expect(screen.getByText("Draw 1 missing picture?")).toBeTruthy();
    expect(
      screen.getByText(
        /offline test provider draws placeholder pictures at no cost/,
      ),
    ).toBeTruthy();
    cleanup();
    const { container } = render(
      <GenerateImagesButton
        {...target}
        slots={0}
        estimate={null}
        blockedReason={null}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("waits, with the reason written under it, when it cannot draw", () => {
    render(
      <GenerateImagesButton
        {...target}
        slots={3}
        estimate={estimate}
        blockedReason="Building is switched off on this deployment, so pictures can't be drawn now."
      />,
    );
    const button = screen.getByRole("button", {
      name: "Draw missing pictures",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.textContent).toMatch(
      /Building is switched off/,
    );
  });

  it("keeps the confirm open with the server's refusal", async () => {
    actions.queueThemeStudioImagesAction.mockResolvedValueOnce({
      ok: false,
      error: `This project changed in another tab ${EM} reload to see it.`,
    } as never);
    render(
      <GenerateImagesButton
        {...target}
        slots={2}
        estimate={null}
        blockedReason={null}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Draw missing pictures" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Draw 2 pictures" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "This project changed in another tab, reload to see it.",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("Redraw", () => {
  it("draws exactly the slots named, after a confirm that names how many and which", async () => {
    render(
      <RedrawPicturesButton
        {...target}
        slotIds={["hero-main", "category-bowls"]}
        slotNames={["Hero main", "Category bowls"]}
        estimate={{ images: 2, expectedUsd: 0.16, mostUsd: 0.48 }}
        blockedReason={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Redraw 2 pictures" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Redraw 2 pictures?")).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Hero main", "Category bowls"]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Redraw 2 pictures" }),
    );
    await waitFor(() =>
      expect(actions.queueThemeStudioImagesAction).toHaveBeenCalledWith(
        expect.objectContaining({ slotIds: ["hero-main", "category-bowls"] }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Redrawing 2 pictures. The theme page follows it.",
    );
  });

  it("opens its confirm for do=redraw, and only opens it", async () => {
    nav.search = "tab=pictures&do=redraw";
    window.history.replaceState(
      null,
      "",
      "/dashboard/themes/studio/p?tab=pictures&do=redraw",
    );
    render(
      <RedrawPicturesButton
        {...target}
        slotIds={["hero-main"]}
        slotNames={["Hero main"]}
        estimate={null}
        blockedReason={null}
        intent="redraw"
      />,
    );
    expect(await screen.findByText("Redraw 1 picture?")).toBeTruthy();
    expect(actions.queueThemeStudioImagesAction).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?tab=pictures");
  });

  it("moves focus to the reason it cannot draw instead", async () => {
    nav.search = "do=redraw";
    window.history.replaceState(
      null,
      "",
      "/dashboard/themes/studio/p?do=redraw",
    );
    render(
      <RedrawPicturesButton
        {...target}
        slotIds={["hero-main"]}
        slotNames={["Hero main"]}
        estimate={null}
        blockedReason="Theme Studio is working on this theme. Change the pictures once it finishes."
        intent="redraw"
      />,
    );
    // A disabled button can't take focus, so its reason does.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "Theme Studio is working on this theme. Change the pictures once it finishes.",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes with Escape and gives focus back to its button", async () => {
    render(
      <RedrawPicturesButton
        {...target}
        slotIds={["a"]}
        slotNames={["A"]}
        estimate={null}
        blockedReason={null}
      />,
    );
    const button = screen.getByRole("button", { name: "Redraw 1 picture" });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});

describe("Retry", () => {
  it("picks up a stopped picture run after a confirm, keeping what it drew", async () => {
    render(
      <RetryPicturesButton
        projectId="p"
        runId="r1"
        drawn={5}
        blockedReason={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(
      /The 5 pictures already drawn are kept and reused/,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(actions.retryThemeStudioRunAction).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "p", runId: "r1" }),
      ),
    );
  });

  it("opens for do=retry_pictures", async () => {
    nav.search = "do=retry_pictures";
    window.history.replaceState(
      null,
      "",
      "/dashboard/themes/studio/p?do=retry_pictures",
    );
    render(
      <RetryPicturesButton
        projectId="p"
        runId="r1"
        drawn={null}
        blockedReason={null}
        intent="retry_pictures"
      />,
    );
    expect(
      await screen.findByText("Try drawing the pictures again?"),
    ).toBeTruthy();
    expect(actions.retryThemeStudioRunAction).not.toHaveBeenCalled();
  });
});

describe("a picture intent with nothing to act on", () => {
  it("only moves focus to the picture list", async () => {
    nav.search = "do=draw_missing_pictures";
    window.history.replaceState(
      null,
      "",
      "/dashboard/themes/studio/p?do=draw_missing_pictures",
    );
    render(
      <>
        <h2 id="list" tabIndex={-1}>
          The pictures
        </h2>
        <PictureIntentFallback
          kinds={["redraw", "draw_missing_pictures", "retry_pictures"]}
          focusId="list"
        />
      </>,
    );
    await waitFor(() => expect(document.activeElement?.id).toBe("list"));
    expect(window.location.search).toBe("");
  });
});

it("never words a picture run with a long dash", async () => {
  render(
    <RedrawPicturesButton
      {...target}
      slotIds={["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]}
      slotNames={["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]}
      estimate={estimate}
      blockedReason={null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Redraw 10 pictures" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toMatch(/and 2 more/);
  const text = document.body.textContent ?? "";
  expect(text.includes(EM) || text.includes(EN)).toBe(false);
});
