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
import type { ReactElement } from "react";
import { gate } from "@/lib/theme-studio/acceptance-gates";
import type { ThemeStudioSlotView } from "@/lib/theme-studio/slot-images";
import {
  DIGEST,
  EM,
  EN,
  PROJECT_ID,
  V2,
  checkRun,
  designReview,
  projectDetail,
  runView,
  slotView,
} from "./_test-helpers";
import type { StudioPageApi } from "./tab-types";

// The Pictures tab (wave TS-2, builder 2C): Redraw of exactly the pictures
// the checks flagged, Draw missing pictures and Retry, each one click with a
// small confirm; the address's picture intents open those confirms; the
// placeholder filter and the image model's brief keep their home; no
// "Capture catalogue pictures" button; no cost on the main view.

const data = vi.hoisted(() => ({
  project: null as unknown,
  runs: [] as unknown[],
  review: null as unknown,
  listing: null as unknown,
  config: {} as Record<string, unknown>,
}));
const nav = vi.hoisted(() => ({ search: "" }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const actions = vi.hoisted(() => ({
  queueThemeStudioImagesAction: vi.fn(async () => ({ ok: true, id: "r" })),
  retryThemeStudioRunAction: vi.fn(async () => ({ ok: true, id: "r" })),
  replaceThemeStudioSlotImagesAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./tab-reads", () => ({
  readStudioProject: vi.fn(async () => data.project),
  readStudioCheckRuns: vi.fn(async () => data.runs),
  readStudioDesignReview: vi.fn(async () => data.review),
}));
vi.mock("@/lib/theme-studio/slot-images", () => ({
  listThemeStudioSlots: vi.fn(async () => data.listing),
}));
vi.mock("@/lib/theme-studio/config", () => ({
  getThemeStudioConfig: vi.fn(() => data.config),
}));
vi.mock("@/app/actions/theme-studio-actions", () => actions);
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { PicturesTab } from "./pictures-tab";
import { StudioPageProvider } from "./studio-tabs";

const api: StudioPageApi = {
  putInChat: vi.fn(),
  openTab: vi.fn(),
  requestIntent: vi.fn(),
};
const props = { projectId: PROJECT_ID, versionId: V2, revision: 7 };

function listing(slots: ThemeStudioSlotView[], generatable = 0) {
  return {
    versionNumber: 2,
    packageDigest: DIGEST,
    generatable,
    anchorReusable: true,
    captureBlockers: [],
    layoutCaptureBlockers: [],
    slots,
  };
}

const catalogCard = slotView({
  id: "catalog-preview",
  catalogPreview: true,
  redrawable: false,
  url: "/img/card",
});
const hero = slotView({ id: "hero-main", kind: "hero" });
const mug = slotView({ id: "product-mug", placeholder: true });

async function show(element: Promise<ReactElement>) {
  const tree = await element;
  return render(<StudioPageProvider api={api}>{tree}</StudioPageProvider>);
}

function intent(kind: string) {
  nav.search = `tab=pictures&do=${kind}`;
  window.history.replaceState(
    null,
    "",
    `/dashboard/themes/studio/${PROJECT_ID}?tab=pictures&do=${kind}`,
  );
}

beforeEach(() => {
  data.project = projectDetail({ status: "ready" });
  data.runs = [];
  data.review = null;
  data.listing = listing([catalogCard, hero, mug]);
  data.config = {
    generationEnabled: true,
    provider: "vertex-gemini",
    disabledModels: new Set(),
    captureEnabled: true,
    autoQaEnabled: true,
  };
  nav.search = "";
  window.history.replaceState(
    null,
    "",
    `/dashboard/themes/studio/${PROJECT_ID}?tab=pictures`,
  );
});
afterEach(() => cleanup());

describe("the Pictures tab", () => {
  it("lists the pictures with the placeholder filter and the brief, and no capture button or cost", async () => {
    const { container } = await show(PicturesTab(props));
    expect(screen.getByText(/Every picture Design 2 shows/)).toBeTruthy();
    expect(
      screen.getByLabelText("Show only slots with a placeholder"),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "In the theme catalog" }),
    ).toBeTruthy();
    // The checks take the catalogue card, so the list leaves it out, even
    // with every picture shown.
    fireEvent.click(
      screen.getByLabelText("Show only slots with a placeholder"),
    );
    expect(screen.getByRole("heading", { name: "Hero main" })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Catalog preview" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /capture/i })).toBeNull();
    expect(container.textContent).not.toMatch(/\$/);
    const text = container.textContent ?? "";
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
  });

  it("lists the catalogue pictures for upload where the browser job is off", async () => {
    data.config = { ...data.config, captureEnabled: false };
    await show(PicturesTab(props));
    fireEvent.click(
      screen.getByLabelText("Show only slots with a placeholder"),
    );
    expect(
      screen.getByRole("heading", { name: "Catalog preview" }),
    ).toBeTruthy();
  });

  it("redraws exactly the pictures the checks flagged, after a confirm that names how many", async () => {
    data.runs = [
      checkRun([
        gate("assets.integrity", [
          { code: "missing", where: "hero-main", message: "Gone." },
        ]),
      ]),
    ];
    await show(PicturesTab(props));
    expect(
      screen.getByText(
        /The checks found a picture that must be drawn again before publishing: Hero main\./,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redraw 1 picture" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Hero main")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Redraw 1 picture" }),
    );
    await waitFor(() =>
      expect(actions.queueThemeStudioImagesAction).toHaveBeenCalledWith(
        expect.objectContaining({
          versionId: V2,
          expectedRevision: 7,
          expectedPackageDigest: DIGEST,
          slotIds: ["hero-main"],
        }),
      ),
    );
  });

  it("redraws the serious pictures first, never mixing in the ones flagged for something small", async () => {
    data.runs = [
      checkRun([
        gate("assets.integrity", [
          { code: "missing", where: "hero-main", message: "Gone." },
        ]),
      ]),
    ];
    data.review = designReview({
      severity: {
        outcome: "taste",
        serious: [],
        warnings: [{ code: "image_redraw", slotId: "product-mug" }],
      },
    });
    await show(PicturesTab(props));
    expect(
      screen.getByText(/must be drawn again before publishing: Hero main\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redraw 1 picture" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Hero main")).toBeTruthy();
    expect(within(dialog).queryByText("Product mug")).toBeNull();
  });

  it("offers a Redraw of photos flagged for something small, when nothing is serious", async () => {
    data.review = designReview({
      severity: {
        outcome: "taste",
        serious: [],
        warnings: [{ code: "image_redraw", slotId: "hero-main" }],
      },
    });
    await show(PicturesTab(props));
    expect(
      screen.getByText(
        /flagged a photo for something small: Hero main\. You can publish as they are/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Redraw 1 picture" }),
    ).toBeTruthy();
  });

  it("opens the Redraw confirm for do=redraw, and only opens it", async () => {
    data.runs = [
      checkRun([
        gate("assets.integrity", [
          { code: "missing", where: "hero-main", message: "Gone." },
        ]),
      ]),
    ];
    intent("redraw");
    await show(PicturesTab(props));
    expect(await screen.findByText("Redraw 1 picture?")).toBeTruthy();
    expect(actions.queueThemeStudioImagesAction).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?tab=pictures");
  });

  it("draws the missing pictures with one click and a confirm, also for do=draw_missing_pictures", async () => {
    data.listing = listing([hero, mug], 1);
    intent("draw_missing_pictures");
    await show(PicturesTab(props));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Draw 1 missing picture?")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Draw 1 picture" }),
    );
    await waitFor(() =>
      expect(actions.queueThemeStudioImagesAction).toHaveBeenCalledTimes(1),
    );
    expect(
      (actions.queueThemeStudioImagesAction.mock.calls[0] as unknown[])[0],
    ).not.toHaveProperty("slotIds");
  });

  it("retries a picture run that stopped, keeping what it drew", async () => {
    data.project = projectDetail({
      status: "ready",
      runs: [
        runView({
          id: "pic-run",
          kind: "images",
          status: "failed",
          baseVersionId: V2,
          images: {
            generated: 4,
            pendingReview: 0,
          } as never,
        }),
      ],
    });
    intent("retry_pictures");
    await show(PicturesTab(props));
    expect(screen.getByText(/The last picture run didn't finish/)).toBeTruthy();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/The 4 pictures already drawn are kept/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(actions.retryThemeStudioRunAction).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "pic-run" }),
      ),
    );
  });

  it("moves focus to the picture list for a picture intent with nothing to act on", async () => {
    intent("retry_pictures");
    await show(PicturesTab(props));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "The pictures of Design 2",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("?tab=pictures");
  });

  it("holds every picture change while Theme Studio works, with the reason written", async () => {
    data.project = projectDetail({ status: "generating" });
    data.listing = listing([hero, mug], 1);
    await show(PicturesTab(props));
    const draw = screen.getByRole("button", {
      name: "Draw missing pictures",
    }) as HTMLButtonElement;
    expect(draw.disabled).toBe(true);
    expect(draw.parentElement?.textContent).toMatch(
      /Theme Studio is working on this theme/,
    );
  });

  it("answers no design, or a design with no pictures, in a sentence", async () => {
    let view = await show(PicturesTab({ ...props, versionId: null }));
    expect(view.container.textContent).toMatch(/There are no pictures yet/);
    cleanup();
    data.project = projectDetail({
      versions: [{ ...projectDetail().versions[0], hasPackage: false }],
    });
    view = await show(PicturesTab(props));
    expect(view.container.textContent).toMatch(/This design has no pictures/);
  });
});
