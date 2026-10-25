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
import type { ThemeStudioAcceptanceRunView } from "@/lib/theme-studio/acceptance";
import type { ThemeStudioProjectDetail } from "@/lib/theme-studio/repository";
import {
  DIGEST,
  EM,
  EN,
  PROJECT_ID,
  RUN_ID,
  V1,
  V2,
  checkRun,
  designReview,
  projectDetail,
  screenshots,
  slotView,
  textOutside,
} from "./_test-helpers";
import type { StudioDesignReview } from "./tab-reads";
import type { StudioPageApi } from "./tab-types";

// The Checks tab (wave TS-2, builder 2C): Must fix, Warnings, Passed,
// Screenshots and Technical details; "Fix it" by kind; Copy details; the
// tab's intents. The server component runs here as a function and its
// client parts render in jsdom inside the page's API.

const data = vi.hoisted(() => ({
  project: null as unknown,
  runs: [] as unknown[],
  review: null as unknown,
  shots: null as unknown,
  slots: null as unknown,
  config: {} as Record<string, unknown>,
}));
const nav = vi.hoisted(() => ({ search: "" }));
const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
const actions = vi.hoisted(() => ({
  queueThemeStudioImagesAction: vi.fn(async () => ({ ok: true, id: "r" })),
  retryThemeStudioRunAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./tab-reads", () => ({
  readStudioProject: vi.fn(async () => data.project),
  readStudioCheckRuns: vi.fn(async () => data.runs),
  readStudioDesignReview: vi.fn(async () => data.review),
  readStudioCheckScreenshots: vi.fn(async () => data.shots),
}));
vi.mock("@/lib/theme-studio/slot-images", () => ({
  listThemeStudioSlots: vi.fn(async () => data.slots),
}));
vi.mock("@/lib/theme-studio/config", () => ({
  getThemeStudioConfig: vi.fn(() => data.config),
}));
vi.mock("./workspace", () => ({
  CheckAgainButton: ({ versionNumber }: { versionNumber: number }) => (
    <button type="button">Check again {versionNumber}</button>
  ),
}));
vi.mock("./versions/[versionId]/acceptance/acceptance-runner", () => ({
  AcceptanceRunner: ({ blockedReason }: { blockedReason: string | null }) => (
    <div data-testid="runner">{blockedReason ?? "runner ready"}</div>
  ),
}));
vi.mock("@/app/actions/theme-studio-actions", () => actions);
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { ChecksTab } from "./checks-tab";
import { StudioPageProvider } from "./studio-tabs";

const props = { projectId: PROJECT_ID, versionId: V2, revision: 7 };

const contrast = {
  code: "color-contrast",
  where: "phone390 · product",
  message: "Low contrast in .hero-title",
  targets: [".hero-title"],
  contrast: [{ target: ".hero-title", ratio: 3.91, required: 4.5 }],
};
const buttonName = {
  code: "button-name",
  where: "phone390 · home",
  message: "Buttons must have discernible text (2 elements, serious)",
  impact: "serious" as const,
  nodes: 2,
};

/** A design that needs a fix: theme problems, one of StoreMink's own, a
 * missing picture, a warning of each kind, and two checks that passed. */
function needsFix(): {
  runs: ThemeStudioAcceptanceRunView[];
  review: StudioDesignReview;
} {
  return {
    runs: [
      checkRun([
        gate("browser.accessibility", [contrast, buttonName]),
        gate("routes.links", [
          { code: "broken", where: "/sale", message: "Returned 404." },
        ]),
        gate("assets.integrity", [
          {
            code: "missing",
            where: "hero-main",
            message: "No stored image matches the asset's digest.",
          },
        ]),
        gate("browser.tap_targets", [
          {
            code: "small_target",
            where: "phone390 · shop",
            message: "20×20px interactive target (.chip); minimum is 24×24px.",
          },
        ]),
        gate("routes.render", []),
        gate("package.security", []),
      ]),
    ],
    review: designReview({
      status: "failed",
      severity: {
        outcome: "serious",
        serious: [{ code: "inaccessible_copy" }],
        warnings: [{ code: "low_total", score: 31 }],
      },
    }),
  };
}

const api: StudioPageApi = {
  putInChat: vi.fn(),
  openTab: vi.fn(),
  requestIntent: vi.fn(),
};

async function show(
  element: Promise<ReactElement>,
): Promise<ReturnType<typeof render>> {
  const tree = await element;
  return render(<StudioPageProvider api={api}>{tree}</StudioPageProvider>);
}

function useNeedsFix(project: Partial<ThemeStudioProjectDetail> = {}) {
  const { runs, review } = needsFix();
  data.project = projectDetail({ status: "ready", ...project });
  data.runs = runs;
  data.review = review;
}

beforeEach(() => {
  data.project = projectDetail();
  data.runs = [];
  data.review = null;
  data.shots = screenshots({ samples: [] });
  data.slots = {
    versionNumber: 2,
    packageDigest: DIGEST,
    generatable: 0,
    anchorReusable: true,
    captureBlockers: [],
    layoutCaptureBlockers: [],
    slots: [slotView({ id: "hero-main" })],
  };
  data.config = {
    generationEnabled: true,
    provider: "vertex-gemini",
    disabledModels: new Set(),
    captureEnabled: true,
    autoQaEnabled: true,
    performanceRequired: false,
    dailySpendMicroUsd: null,
  };
  nav.search = "";
  window.history.replaceState(
    null,
    "",
    `/dashboard/themes/studio/${PROJECT_ID}?tab=checks`,
  );
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
});
afterEach(() => cleanup());

function section(name: RegExp) {
  return screen.getByRole("heading", { name }).closest("section")!;
}

describe("a design that needs a fix", () => {
  it("lists Must fix, Warnings and Passed by kind, in plain words", async () => {
    useNeedsFix();
    await show(ChecksTab(props));
    const mustFix = section(/^Must fix before publishing: 5$/);
    expect(
      within(mustFix).getByText(
        "Some text is hard to read (3.9 to 1, needs 4.5 to 1).",
      ),
    ).toBeTruthy();
    expect(within(mustFix).getByText(/Product at 390 px/)).toBeTruthy();
    expect(
      within(mustFix).getByText(
        /A link leads to a page that answered with status 404/,
      ),
    ).toBeTruthy();
    expect(
      within(mustFix).getByText(/A picture's file is missing/),
    ).toBeTruthy();
    expect(
      within(mustFix).getByText(/Some words are hard or impossible to read/),
    ).toBeTruthy();
    const warnings = section(/^Warnings \(you can still publish\): 2$/);
    expect(
      within(warnings).getByText(/A button or link is 20 by 20 px/),
    ).toBeTruthy();
    expect(
      within(warnings).getByText(/The design review gave 31 of 40 in all/),
    ).toBeTruthy();
    // A check holding only warnings has passed, with warnings.
    const passed = screen.getByText("Passed: 3").closest("section")!;
    expect(within(passed).getByText("Pages open")).toBeTruthy();
    expect(within(passed).getByText("Security")).toBeTruthy();
    expect(
      within(passed).getByText(/^Button sizes on phones/).textContent,
    ).toBe("Button sizes on phones (with warnings)");
  });

  it("keeps codes, the build and run ids in Technical details only", async () => {
    useNeedsFix();
    const { container } = await show(ChecksTab(props));
    const technical = container.querySelector<HTMLElement>(
      "#studio-checks-technical",
    )!;
    const main = textOutside(container, technical);
    for (const code of [
      RUN_ID,
      "build-1",
      "button-name",
      "color-contrast",
      "small_target",
      "routes.links",
    ])
      expect(main, code).not.toContain(code);
    const details = technical.textContent ?? "";
    expect(details).toContain(RUN_ID);
    expect(details).toContain("build-1");
    expect(details).toContain("button-name");
    expect(details).toContain("Design 2 (version 2, current)");
  });

  it("puts a draft of the serious theme problems in the chat, never sending it", async () => {
    useNeedsFix();
    await show(ChecksTab(props));
    fireEvent.click(screen.getByRole("button", { name: "Describe a fix" }));
    expect(api.putInChat).toHaveBeenCalledTimes(1);
    const draft = vi.mocked(api.putInChat).mock.calls[0][0];
    expect(draft).toContain("Design 2");
    expect(draft).toContain("Readable text:");
    expect(draft).toContain("Links:");
    expect(draft).toContain("Design review: Some words are hard");
    // Not StoreMink's own code, not the picture, not the warnings, no run id.
    expect(draft).not.toContain(RUN_ID);
    expect(draft).not.toMatch(
      /screen reader|hero-main|hero main|button or link|31 of 40/i,
    );
    expect(
      screen.getByText(/The summary is in the chat\. Read it/),
    ).toBeTruthy();
  });

  it("gives StoreMink's own problem no fix button, only Copy details for an engineer", async () => {
    useNeedsFix();
    await show(ChecksTab(props));
    const mustFix = section(/^Must fix before publishing/);
    const storeMink = within(mustFix)
      .getByText(/A button has no name a screen reader can say/)
      .closest("li")!;
    expect(storeMink.textContent).toMatch(/StoreMink has been told/);
    expect(storeMink.textContent).toMatch(/Publish waits until StoreMink/);
    expect(
      within(storeMink).queryByRole("button", {
        name: /Describe a fix|Redraw/,
      }),
    ).toBeNull();
    fireEvent.click(
      within(storeMink).getByRole("button", {
        name: "Copy details for an engineer",
      }),
    );
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalled(),
    );
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(copied).toContain("Theme: Aurora (aurora)");
    expect(copied).toContain("Check: browser.accessibility");
    expect(copied).toContain("Code: button-name");
    expect(copied).toContain("Design: Design 2 (version 2)");
    expect(copied).toContain("Build: build-1");
    expect(copied).toMatch(/Time: 25 Oct 2026, 11:55 India time/);
    expect(await screen.findByText(/Copied\. Paste it/)).toBeTruthy();
  });

  it("redraws exactly the flagged picture after a confirm that names how many", async () => {
    useNeedsFix();
    await show(ChecksTab(props));
    fireEvent.click(screen.getByRole("button", { name: "Redraw 1 picture" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Redraw 1 picture?")).toBeTruthy();
    expect(within(dialog).getByText("Hero main")).toBeTruthy();
    expect(dialog.textContent).toMatch(/about \$\d+\.\d\d at list price/);
    expect(actions.queueThemeStudioImagesAction).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Redraw 1 picture" }),
    );
    await waitFor(() =>
      expect(actions.queueThemeStudioImagesAction).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          versionId: V2,
          expectedRevision: 7,
          expectedPackageDigest: DIGEST,
          slotIds: ["hero-main"],
        }),
      ),
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("offers Describe a change on a matter of taste, which opens the chat empty", async () => {
    useNeedsFix();
    await show(ChecksTab(props));
    const warnings = section(/^Warnings/);
    fireEvent.click(
      within(warnings).getByRole("button", { name: "Describe a change" }),
    );
    expect(api.putInChat).toHaveBeenCalledWith("");
  });

  it("holds Describe a fix back while Theme Studio works, with the reason under it", async () => {
    useNeedsFix({ status: "generating" });
    await show(ChecksTab(props));
    const button = screen.getByRole("button", {
      name: "Describe a fix",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The reason is written under the button, never in a tooltip.
    expect(button.parentElement?.textContent).toMatch(
      /You can send a change when it finishes/,
    );
    expect(
      screen.getByText(/Theme Studio is working on this theme\. These are/),
    ).toBeTruthy();
  });

  it("says Theme Studio already tried its automatic fixes", async () => {
    useNeedsFix({
      versions: [
        projectDetail().versions[0],
        { ...projectDetail().versions[0], id: V1, versionNumber: 1 },
      ].map((v) => (v.id === V2 ? { ...v, qaIteration: 2 } : v)),
    });
    await show(ChecksTab(props));
    expect(
      screen.getByText(
        /already tried 2 automatic fixes before showing you this/,
      ),
    ).toBeTruthy();
  });

  it("has no Capture catalogue pictures button, no long dash and none of the code's state names", async () => {
    useNeedsFix();
    const { container } = await show(ChecksTab(props));
    expect(screen.queryByRole("button", { name: /capture/i })).toBeNull();
    const text = container.textContent ?? "";
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
    expect(text).not.toMatch(/\b(candidate|approved|blocked)\b/i);
  });
});

describe("a design that is ready", () => {
  it("starts with what the checks covered and says nothing stops Publish", async () => {
    data.runs = [
      checkRun([gate("routes.render", []), gate("routes.links", [])], {
        status: "passed",
      }),
    ];
    data.review = designReview();
    data.shots = screenshots();
    const { container } = await show(ChecksTab(props));
    const first = container.querySelector("p");
    expect(first?.textContent).toMatch(/^Checked 4 sample pages/);
    expect(first?.textContent).toMatch(/the cart while empty/);
    expect(
      screen.getByRole("heading", { name: "Must fix before publishing: none" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Nothing stops Publish in these checks."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Describe a fix" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check again 2" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Show the screenshots (1)" }),
    ).toBeTruthy();
  });

  it("says when the checks are from an earlier StoreMink build", async () => {
    data.runs = [
      checkRun([gate("routes.render", [])], {
        status: "passed",
        currentBuild: false,
      }),
    ];
    data.review = designReview();
    await show(ChecksTab(props));
    expect(
      screen.getByText(
        /These checks ran on an earlier StoreMink build\. Publish checks this design again/,
      ),
    ).toBeTruthy();
  });
});

describe("before and around the checks", () => {
  it("says plainly that a design has not been checked yet", async () => {
    await show(ChecksTab(props));
    expect(
      screen.getByRole("heading", {
        name: "Must fix before publishing: not checked yet",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Design 2 has not been checked yet/)).toBeTruthy();
    expect(screen.getByText(/No screenshots yet/)).toBeTruthy();
  });

  it("never calls checks that did not finish a pass", async () => {
    data.runs = [checkRun([gate("routes.render", [])], { status: "passed" })];
    data.review = designReview({
      status: "failed",
      errorCode: "qa_provider_unavailable",
      severity: null,
    });
    await show(ChecksTab(props));
    expect(
      screen.getByRole("heading", {
        name: "Must fix before publishing: not known yet",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByText("Nothing stops Publish in these checks."),
    ).toBeNull();
    expect(
      screen.getByText(/The design review of Design 2 didn't finish/),
    ).toBeTruthy();
  });

  it("shows a design review from before severity-v1 as one problem to describe", async () => {
    data.project = projectDetail({
      status: "ready",
      versions: [
        {
          ...projectDetail().versions[0],
          qaFindings: [`Hero copy ${EM} unreadable over the photo.`],
        },
        projectDetail().versions[1],
      ],
    });
    data.runs = [checkRun([gate("routes.render", [])], { status: "passed" })];
    data.review = designReview({
      status: "failed",
      errorCode: "quality_bar_not_met",
      severity: null,
    });
    await show(ChecksTab(props));
    const mustFix = section(/^Must fix before publishing: 1$/);
    expect(mustFix.textContent).toMatch(
      /Serious problems are left after the automatic fixes/,
    );
    expect(mustFix.textContent).toMatch(
      /Hero copy, unreadable over the photo\./,
    );
    expect(screen.queryByText(/didn't finish/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Describe a fix" }));
    expect(vi.mocked(api.putInChat).mock.calls[0][0]).toContain(
      "Design review: Hero copy, unreadable over the photo.",
    );
  });

  it("counts the problems of a stop that a change answers", async () => {
    useNeedsFix();
    data.project = projectDetail({
      status: "ready",
      events: [
        {
          id: "e",
          eventType: "auto_qa_failed",
          actorKind: "worker",
          actorEmail: null,
          runId: null,
          detail: {
            versionId: V2,
            errorCode: "quality_bar_not_met",
            qaRunId: "q",
          },
          createdAt: "2026-10-25T06:30:00Z",
        },
      ],
    });
    await show(ChecksTab(props));
    expect(
      screen.getByRole("heading", { name: "Must fix before publishing: 5" }),
    ).toBeTruthy();
    expect(screen.queryByText(/stopped before they finished/)).toBeNull();
  });

  it("never says nothing stops Publish when the checks stopped with nothing listed", async () => {
    data.project = projectDetail({
      status: "ready",
      events: [
        {
          id: "e",
          eventType: "auto_qa_failed",
          actorKind: "worker",
          actorEmail: null,
          runId: null,
          detail: { versionId: V2, errorCode: "qa_no_progress", qaRunId: "q" },
          createdAt: "2026-10-25T06:30:00Z",
        },
      ],
    });
    data.runs = [checkRun([gate("routes.render", [])], { status: "passed" })];
    await show(ChecksTab(props));
    expect(
      screen.getByRole("heading", {
        name: "Must fix before publishing: not known yet",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/stopped before they finished/)).toBeTruthy();
    expect(
      screen.queryByText("Nothing stops Publish in these checks."),
    ).toBeNull();
  });

  it("says why the automatic checks stopped, with the code in Technical details only", async () => {
    data.project = projectDetail({
      status: "ready",
      events: [
        {
          id: "e",
          eventType: "auto_qa_failed",
          actorKind: "worker",
          actorEmail: null,
          runId: null,
          detail: { versionId: V2, errorCode: "cancelled", qaRunId: "q" },
          createdAt: "2026-10-25T06:30:00Z",
        },
      ],
    });
    data.runs = [checkRun([gate("routes.render", [])], { status: "passed" })];
    const { container } = await show(ChecksTab(props));
    const notice = screen.getByText(/The automatic checks stopped on Design 2/);
    expect(notice.textContent).not.toContain("cancelled");
    const technical = container.querySelector<HTMLElement>(
      "#studio-checks-technical",
    )!;
    expect(technical.textContent).toContain("review: cancelled");
  });

  it("checks only the current design, and says so for another", async () => {
    await show(ChecksTab({ ...props, versionId: V1 }));
    expect(screen.queryByRole("button", { name: /Check again/ })).toBeNull();
    expect(screen.getByTestId("runner").textContent).toBe(
      "Only the current design can be checked. Make Design 1 current first.",
    );
  });

  it("answers a theme with no design, or a design with no theme file, in a sentence", async () => {
    let view = await show(ChecksTab({ ...props, versionId: null }));
    expect(view.container.textContent).toMatch(/no design to check yet/);
    cleanup();
    data.project = projectDetail({
      versions: [{ ...projectDetail().versions[0], hasPackage: false }],
    });
    view = await show(ChecksTab(props));
    expect(view.container.textContent).toMatch(/has no theme to check/);
  });
});

describe("the tab's intents", () => {
  it("puts the draft in the chat for do=describe_fix, once, and takes it out of the address", async () => {
    useNeedsFix();
    nav.search = "tab=checks&do=describe_fix";
    window.history.replaceState(
      null,
      "",
      `/dashboard/themes/studio/${PROJECT_ID}?tab=checks&do=describe_fix`,
    );
    await show(ChecksTab(props));
    await waitFor(() => expect(api.putInChat).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.putInChat).mock.calls[0][0]).toContain("Design 2");
    expect(window.location.search).toBe("?tab=checks");
    expect(actions.queueThemeStudioImagesAction).not.toHaveBeenCalled();
  });

  it("opens Technical details at the first Copy details button for do=copy_details", async () => {
    useNeedsFix();
    nav.search = "do=copy_details";
    window.history.replaceState(
      null,
      "",
      `/dashboard/themes/studio/${PROJECT_ID}?do=copy_details`,
    );
    const { container } = await show(ChecksTab(props));
    const technical = container.querySelector<HTMLDetailsElement>(
      "#studio-checks-technical",
    )!;
    await waitFor(() => expect(technical.open).toBe(true));
    expect(document.activeElement?.id).toBe("studio-copy-storemink");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("moves focus to Must fix when there is nothing to describe", async () => {
    data.runs = [checkRun([gate("routes.render", [])], { status: "passed" })];
    nav.search = "do=describe_fix";
    window.history.replaceState(
      null,
      "",
      `/dashboard/themes/studio/${PROJECT_ID}?do=describe_fix`,
    );
    await show(ChecksTab(props));
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("studio-checks-must-fix"),
    );
    expect(api.putInChat).not.toHaveBeenCalled();
  });
});
