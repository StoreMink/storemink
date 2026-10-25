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
import type { ThemeStudioSlotView } from "@/lib/theme-studio/slot-images";

// The Pictures tab's picture editor (wave TS-2, builder 2C): each picture
// says how it came to be and what the image model is asked for; ticked
// pictures are redrawn with one click and a small confirm; uploads are saved
// as a new design; no cost line on the main view; the dashboard's tokens.

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const nav = vi.hoisted(() => ({ search: "" }));
const actions = vi.hoisted(() => ({
  queueThemeStudioImagesAction: vi.fn(async () => ({ ok: true, id: "run" })),
  retryThemeStudioRunAction: vi.fn(async () => ({ ok: true })),
  replaceThemeStudioSlotImagesAction: vi.fn(async () => ({
    ok: true,
    id: "v9",
    versionNumber: 9,
    checking: false,
  })),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/app/actions/theme-studio-actions", () => actions);
vi.mock("sonner", () => ({ toast }));

import { StudioPageProvider } from "../../../studio-tabs";
import type { StudioPageApi } from "../../../tab-types";
import { SlotImagesEditor, historyLine } from "./slot-images-editor";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

const api: StudioPageApi = {
  putInChat: vi.fn(),
  openTab: vi.fn(),
  requestIntent: vi.fn(),
};

const slot = (over: Partial<ThemeStudioSlotView>): ThemeStudioSlotView =>
  ({
    id: "slot",
    path: "theme-asset://slot",
    kind: "product",
    width: 1280,
    height: 1600,
    alt: "Alt",
    source: "generated",
    licenseNote: null,
    placeholder: false,
    catalogPreview: false,
    catalogScreenshot: false,
    usage: [],
    url: null,
    redrawable: true,
    brief: null,
    history: null,
    ...over,
  }) as ThemeStudioSlotView;

const history = (
  over: Partial<NonNullable<ThemeStudioSlotView["history"]>>,
): NonNullable<ThemeStudioSlotView["history"]> => ({
  runId: "r",
  createdAt: "2026-09-27",
  status: "generated",
  attempts: 1,
  review: "passed",
  problems: [],
  note: "",
  reason: null,
  costMicroUsd: 103_000,
  redraw: false,
  ...over,
});

const slots: ThemeStudioSlotView[] = [
  slot({
    id: "home-hero",
    kind: "hero",
    brief: {
      purpose: "Homepage hero",
      subject: "Stoneware on linen",
      artDirection: "Soft window light.",
      aspectRatio: "16:9",
    },
    history: history({ attempts: 2 }),
  }),
  slot({
    id: "product-photo--mug",
    placeholder: true,
    brief: {
      purpose: "Product photography",
      subject: "Speckled mug",
      artDirection: "",
      aspectRatio: "4:5",
    },
  }),
  slot({
    id: "category-bowls",
    kind: "category",
    source: "operator-owned",
    redrawable: false,
  }),
];

function renderEditor(
  over: Partial<Parameters<typeof SlotImagesEditor>[0]> = {},
) {
  const view = render(
    <StudioPageProvider api={api}>
      <SlotImagesEditor
        projectId="p"
        versionId="v"
        versionNumber={2}
        packageDigest={"d".repeat(64)}
        revision={5}
        canEdit
        blockedReason={null}
        slots={slots}
        anchorReusable
        prices={{ imageUsd: 0.1, reviewUsd: 0.003 }}
        {...over}
      />
    </StudioPageProvider>,
  );
  // Show drawn pictures as well as placeholders.
  fireEvent.click(screen.getByLabelText("Show only slots with a placeholder"));
  return view;
}

const card = (name: string) =>
  screen.getByRole("heading", { name }).closest("li")!;

beforeEach(() => {
  nav.search = "";
  window.history.replaceState(null, "", "/dashboard/themes/studio/p");
});
afterEach(() => cleanup());

describe("each picture", () => {
  it("says how it came to be and what the image model is asked for, with no cost on the main view", () => {
    const { container } = renderEditor();
    const hero = within(card("Home hero"));
    expect(hero.getByText("Drawn and checked after a redraw.")).toBeTruthy();
    expect(hero.getByText("What the image model is asked for")).toBeTruthy();
    expect(hero.getByText("Stoneware on linen")).toBeTruthy();
    expect(hero.getByText("Soft window light.")).toBeTruthy();
    expect(hero.getByText("16:9")).toBeTruthy();
    expect(container.textContent).not.toMatch(/\$|estimated|cost/i);
    expect(hero.getByText("Drawn by Theme Studio")).toBeTruthy();
    expect(
      within(card("Product photo mug")).getByText("Placeholder"),
    ).toBeTruthy();
  });

  it("offers a redraw only for a placeholder or a drawn picture", () => {
    renderEditor();
    expect(within(card("Home hero")).getByLabelText("Redraw")).toBeTruthy();
    expect(
      within(card("Product photo mug")).getByLabelText("Draw"),
    ).toBeTruthy();
    expect(within(card("Category bowls")).queryByRole("checkbox")).toBeNull();
  });

  it("shows only the placeholders at first, and says so when there are none", () => {
    render(
      <StudioPageProvider api={api}>
        <SlotImagesEditor
          projectId="p"
          versionId="v"
          versionNumber={2}
          packageDigest={"d".repeat(64)}
          revision={5}
          canEdit
          blockedReason={null}
          slots={slots}
          anchorReusable
          prices={null}
        />
      </StudioPageProvider>,
    );
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Product photo mug",
    ]);
    cleanup();
    render(
      <StudioPageProvider api={api}>
        <SlotImagesEditor
          projectId="p"
          versionId="v"
          versionNumber={2}
          packageDigest={"d".repeat(64)}
          revision={5}
          canEdit
          blockedReason={null}
          slots={[slots[0]]}
          anchorReusable
          prices={null}
        />
      </StudioPageProvider>,
    );
    // No placeholder: the box starts unticked; ticked, the list is empty.
    fireEvent.click(
      screen.getByLabelText("Show only slots with a placeholder"),
    );
    expect(
      screen.getByText(/Every slot in Design 2 already has a real picture/),
    ).toBeTruthy();
  });
});

describe("redrawing", () => {
  it("is one click and a small confirm that names how many, then sends the chosen slots in page order", async () => {
    renderEditor();
    fireEvent.click(within(card("Product photo mug")).getByLabelText("Draw"));
    fireEvent.click(within(card("Home hero")).getByLabelText("Redraw"));
    fireEvent.click(screen.getByRole("button", { name: "Redraw 2 pictures" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Redraw 2 pictures?")).toBeTruthy();
    // The estimate is in the confirm only.
    expect(dialog.textContent).toMatch(
      /That is 2 pictures, about \$0\.21 at list price, or at most \$0\.62/,
    );
    expect(actions.queueThemeStudioImagesAction).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Redraw 2 pictures" }),
    );
    await waitFor(() =>
      expect(actions.queueThemeStudioImagesAction).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p",
          versionId: "v",
          expectedRevision: 5,
          expectedPackageDigest: "d".repeat(64),
          slotIds: ["home-hero", "product-photo--mug"],
        }),
      ),
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("counts a new art-direction picture, and names the offline test provider as free", async () => {
    renderEditor({ anchorReusable: false });
    fireEvent.click(within(card("Home hero")).getByLabelText("Redraw"));
    fireEvent.click(screen.getByRole("button", { name: "Redraw 1 picture" }));
    expect((await screen.findByRole("dialog")).textContent).toMatch(
      /That is 2 pictures, about \$0\.21 at list price/,
    );
    cleanup();
    renderEditor({ prices: null });
    fireEvent.click(within(card("Home hero")).getByLabelText("Redraw"));
    fireEvent.click(screen.getByRole("button", { name: "Redraw 1 picture" }));
    expect((await screen.findByRole("dialog")).textContent).toMatch(
      /offline test provider draws placeholder pictures at no cost/,
    );
  });

  it("can't be ticked or started while the theme can't change, with the reason written", () => {
    renderEditor({
      canEdit: false,
      blockedReason: "Theme Studio is working on this theme.",
    });
    expect(
      (within(card("Home hero")).getByLabelText("Redraw") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getAllByText("Theme Studio is working on this theme.").length,
    ).toBeGreaterThan(0);
  });

  it("waits for building to be switched on, saying so under Redraw", () => {
    renderEditor({
      drawBlockedReason:
        "Building is switched off on this deployment, so pictures can't be drawn now.",
    });
    fireEvent.click(within(card("Home hero")).getByLabelText("Redraw"));
    const button = screen.getByRole("button", {
      name: "Redraw 1 picture",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.textContent).toMatch(
      /Building is switched off/,
    );
  });
});

describe("saving uploads", () => {
  function stage() {
    renderEditor();
    const file = new File(["x"], "mug.png", { type: "image/png" });
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        id: "asset-1",
        url: "/img/asset-1",
        width: 800,
        height: 1000,
        bytes: 40_000,
      }),
    ) as typeof fetch;
    const input = within(card("Product photo mug")).getByLabelText(
      /Upload a picture/,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("saves the staged pictures as a new design and opens it", async () => {
    stage();
    const save = await screen.findByRole("button", {
      name: "Save 1 picture as a new design",
    });
    expect(screen.getByText("New, 800 by 1000 px, 39 KB")).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() =>
      expect(actions.replaceThemeStudioSlotImagesAction).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p",
          versionId: "v",
          expectedRevision: 5,
          replacements: [
            expect.objectContaining({
              slotId: "product-photo--mug",
              assetId: "asset-1",
            }),
          ],
        }),
      ),
    );
    await waitFor(() =>
      expect(api.openTab).toHaveBeenCalledWith("pictures", { versionId: "v9" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Saved as Design 9.");
  });

  it("warns before a reload throws staged pictures away", async () => {
    stage();
    await screen.findByRole("button", {
      name: "Save 1 picture as a new design",
    });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    cleanup();
    renderEditor();
    const calm = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(calm);
    expect(calm.defaultPrevented).toBe(false);
  });

  it("stays on the design shown while a saved design is checked", async () => {
    actions.replaceThemeStudioSlotImagesAction.mockResolvedValueOnce({
      ok: true,
      id: "v9",
      versionNumber: 9,
      checking: true,
    });
    stage();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Save 1 picture as a new design",
      }),
    );
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(api.openTab).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      "Saved as Design 9. Checking it now, about 3 to 5 minutes; you can leave this page.",
    );
  });

  it("shows the server's refusal beside Save, without a long dash", async () => {
    actions.replaceThemeStudioSlotImagesAction.mockResolvedValueOnce({
      ok: false,
      error: `Licensed pictures need a licence note ${EN} add one.`,
    } as never);
    stage();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Save 1 picture as a new design",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Licensed pictures need a licence note, add one.",
    );
  });
});

describe("the history line", () => {
  it("names what the check found, and says when a placeholder was kept", () => {
    expect(
      historyLine(
        history({
          review: "flagged",
          attempts: 2,
          problems: ["staging_mismatch"],
          note: `Different backdrop ${EM} warmer.`,
        }),
      ),
    ).toEqual({
      text: "Drawn after a redraw; kept with a different setup from the other products: Different backdrop, warmer.",
      tone: "warn",
    });
    expect(
      historyLine(
        history({
          status: "rejected",
          attempts: 2,
          review: null,
          problems: ["text_or_logo", "person"],
          note: "",
        }),
      ),
    ).toEqual({
      text: "Failed its check twice (lettering or a logo, a person). The placeholder was kept.",
      tone: "bad",
    });
    expect(historyLine(history({ review: "unreviewed" }))).toEqual({
      text: "Drawn; not checked yet.",
      tone: "warn",
    });
  });

  it("says a provider's reason in words, never a bare code", () => {
    expect(
      historyLine(history({ status: "refused", reason: "IMAGE_SAFETY" })).text,
    ).toBe("The image model refused it.");
    expect(
      historyLine(history({ status: "failed", reason: "rate_limited" })).text,
    ).toBe("Not drawn.");
    expect(
      historyLine(
        history({ status: "refused", reason: "It showed a real person" }),
      ).text,
    ).toBe("The image model refused it (It showed a real person).");
  });
});
