// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import type {
  ThemeStudioEventView,
  ThemeStudioProjectDetail,
  ThemeStudioRunView,
  ThemeStudioVersionView,
} from "@/lib/theme-studio/repository";
import type {
  StudioStatusInput,
  ThemeStudioProgress,
} from "@/lib/theme-studio/progress";
import type { StudioStatus } from "../studio-status";

const { router, nav } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), replace: vi.fn(), push: vi.fn() },
  nav: { search: "" },
}));
const actions = vi.hoisted(() => ({
  archiveThemeStudioProjectAction: vi.fn(),
  cancelThemeStudioRunAction: vi.fn(),
  queueThemeStudioGenerationAction: vi.fn(),
  removeThemeStudioReferenceAction: vi.fn(),
  restoreThemeStudioVersionAction: vi.fn(),
  retryThemeStudioRunAction: vi.fn(),
  reviseThemeStudioVersionAction: vi.fn(),
  submitThemeStudioDetailsAction: vi.fn(),
  stopThemeStudioChecksAction: vi.fn(),
  recheckThemeStudioVersionAction: vi.fn(),
  deleteThemeStudioProjectAction: vi.fn(),
}));
const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
const hook = vi.hoisted(() => ({
  state: null as unknown,
}));
const preview = vi.hoisted(() => ({ mounts: 0 }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/app/actions/theme-studio-actions", () => actions);
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../use-studio-progress", () => ({
  useStudioProgress: () => hook.state,
}));
vi.mock("./versions/[versionId]/preview-frame", async () => {
  const { useEffect } = await import("react");
  return {
    PreviewFrame: ({ versionId }: { versionId: string }) => {
      useEffect(() => {
        preview.mounts += 1;
      }, []);
      return <div data-testid="preview-frame" data-version={versionId} />;
    },
  };
});
import {
  ProjectWorkspace,
  parseChatPrefs,
  recheckMessage,
  restoredMessage,
  stoppedMessage,
  varietyCorrectionNote,
  type ProjectWorkspaceProps,
} from "./workspace";
import { useStudioPage } from "./studio-tabs";

// The theme page (wave TS-2, builder 2B): the full-width page, the tabs that
// keep the preview loaded, the header's status and main button, the Design
// list, the "..." menu with its dialogs, the intents, the phone bar, and the
// controls TS-1 added, each in its new home.

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const NOW = "2026-10-25T05:00:00.000Z";

function version(
  overrides: Partial<ThemeStudioVersionView> = {},
): ThemeStudioVersionView {
  return {
    id: "v2",
    versionNumber: 2,
    parentVersionId: "v1",
    parentVersionNumber: 1,
    runId: "r2",
    origin: "run",
    editedSlots: [],
    intentDigest: "digest",
    packageDigest: "package",
    packageSummary: null,
    summary: "A warm grocery theme.",
    assumptions: [],
    hasPackage: true,
    qaStatus: "passed",
    qaIteration: 0,
    createdAt: "2026-10-25T04:40:00.000Z",
    ...overrides,
  };
}

const base: ThemeStudioProjectDetail = {
  id: "p",
  themeId: "crave",
  name: "Crave",
  status: "ready",
  modelKey: "gemini-3.8-flash",
  industries: ["home"],
  catalogSizes: ["small"],
  requiredFeatures: [],
  baseThemeId: null,
  draftBrief: "Grocery shop",
  currentVersionId: "v2",
  revision: 3,
  createdByEmail: "operator@example.com",
  createdAt: "2026-10-25T04:00:00Z",
  updatedAt: "2026-10-25T04:50:00Z",
  references: [],
  messages: [],
  runs: [],
  versions: [
    version(),
    version({
      id: "v1",
      versionNumber: 1,
      parentVersionId: null,
      parentVersionNumber: null,
      createdAt: "2026-10-25T04:20:00.000Z",
    }),
  ],
  previews: [],
  events: [],
};

const facts: StudioStatusInput = {
  now: NOW,
  projectStatus: "ready",
  archivedAt: null,
  hasCurrentVersion: true,
  release: null,
  publishAttempt: null,
  working: null,
  questions: {
    open: false,
    count: 0,
    askedAt: null,
    rounds: 0,
    tooManyRounds: false,
  },
  stop: null,
  checks: null,
  evidence: null,
  pictures: { missing: 0, lastRun: null },
  switches: { buildingOff: false, modelOff: false, checksOff: false },
};

const IDLE = [
  {
    kind: "remove_from_list" as const,
    label: "Remove from list (keeps its history)",
  },
  { kind: "delete" as const, label: "Delete" },
];

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    row: 19,
    words: "Not checked yet",
    tone: "neutral",
    primary: { kind: "check_again", label: "Check again" },
    secondary: IDLE,
    ...overrides,
  };
}

const WORKING = status({
  row: 5,
  words: "Building: drawing pictures (26 min)",
  tone: "info",
  primary: null,
  secondary: [{ kind: "stop", label: "Stop" }],
});

function progress(
  input: Partial<StudioStatusInput> = {},
  overrides: Partial<ThemeStudioProgress> = {},
): ThemeStudioProgress {
  return {
    projectId: "p",
    revision: 3,
    versionIds: ["v2", "v1"],
    currentVersionId: "v2",
    status: { ...facts, ...input },
    steps: [],
    updatedAt: NOW,
    ...overrides,
  };
}

function setLive(
  s: StudioStatus,
  input: Partial<StudioStatusInput> = {},
  extra: Partial<{
    revisionChanged: boolean;
    versionsChanged: boolean;
    problem: "signed_out" | "forbidden" | "missing" | null;
    revision: number;
  }> = {},
) {
  hook.state = {
    progress: progress(input, { revision: extra.revision ?? 3 }),
    status: s,
    revisionChanged: extra.revisionChanged ?? false,
    versionsChanged: extra.versionsChanged ?? false,
    problem: extra.problem ?? null,
    polling: false,
  };
}

function props(
  overrides: Partial<ProjectWorkspaceProps> = {},
): ProjectWorkspaceProps {
  return {
    project: base,
    initialProgress: progress(),
    buildTime: {
      fromMinutes: 35,
      toMinutes: 75,
      basedOn: 0,
      source: "default",
    },
    tab: "preview",
    explicitTab: false,
    versionId: "v2",
    tabContent: null,
    releaseControls: null,
    viewports: {
      desktop: { width: 1440, height: 900 },
      tablet: { width: 768, height: 1024 },
      mobile: { width: 390, height: 844 },
    },
    testProvider: false,
    referenceLimit: 10,
    notifiesViewer: true,
    // The server rendered the row the live state shows, unless a test says
    // otherwise.
    serverRow: (hook.state as { status: StudioStatus }).status.row,
    ...overrides,
  };
}

function page(overrides: Partial<ProjectWorkspaceProps> = {}) {
  return render(<ProjectWorkspace {...props(overrides)} />);
}

function ev(
  eventType: string,
  createdAt: string,
  detail: Record<string, unknown> = {},
): ThemeStudioEventView {
  return {
    id: `${eventType}-${createdAt}`,
    eventType,
    actorKind: "worker",
    actorEmail: null,
    runId: null,
    detail,
    createdAt,
  };
}

function run(overrides: Partial<ThemeStudioRunView>): ThemeStudioRunView {
  return {
    id: "run",
    kind: "generate",
    status: "succeeded",
    provider: "vertex-gemini",
    modelKey: "gemini-3.8-flash",
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: null,
    cancelRequested: false,
    retryOfRunId: null,
    baseVersionId: null,
    createdAt: "2026-10-25T04:00:00Z",
    startedAt: "2026-10-25T04:00:00Z",
    finishedAt: "2026-10-25T04:10:00Z",
    usage: null,
    images: null,
    imageSlotIds: [],
    questions: [],
    declineReason: null,
    refusalCategory: null,
    change: null,
    ...overrides,
  };
}

const more = () =>
  screen.getByRole("button", { name: "More actions for Crave" });

beforeEach(() => {
  setLive(status());
  preview.mounts = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/dashboard/themes/studio/p");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  nav.search = "";
});

describe("the full-width page", () => {
  it("hides the console sidebar while it is open, the analytics editor's way", () => {
    const frame = document.createElement("div");
    frame.className = "dashboard-frame";
    document.body.appendChild(frame);
    const view = render(<ProjectWorkspace {...props()} />, {
      container: frame,
    });
    expect(frame.classList.contains("studio-fullwidth")).toBe(true);
    view.unmount();
    expect(frame.classList.contains("studio-fullwidth")).toBe(false);
    frame.remove();
  });

  it("carries the Studio's root class, which gives touch screens 44 px controls", () => {
    const view = page();
    expect(
      view.container.firstElementChild?.classList.contains("studio-root"),
    ).toBe(true);
  });

  it("names the theme, links back to the list and shows the status words", () => {
    setLive(status({ words: "Ready to publish, 2 warnings", tone: "success" }));
    page();
    expect(screen.getByRole("heading", { name: "Crave" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Themes/ }).getAttribute("href"),
    ).toBe("/dashboard/themes/studio");
    const badge = screen
      .getAllByText("Ready to publish, 2 warnings")
      .find((node) => node.classList.contains("studio-badge"));
    expect(badge?.getAttribute("data-tone")).toBe("success");
  });

  it("keeps codes, the model and the creator off the main view", () => {
    const view = page();
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("operator@example.com");
    expect(text).not.toMatch(/gemini/i);
    expect(text).not.toContain("crave");
    expect(text).not.toMatch(/\b(candidate|approved|blocked)\b/i);
  });
});

describe("the tabs", () => {
  it("opens a tab with a soft navigation and keeps the preview loaded", () => {
    const view = page();
    expect(preview.mounts).toBe(1);
    fireEvent.click(screen.getByRole("tab", { name: "Checks" }));
    expect(router.replace).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p?tab=checks",
      { scroll: false },
    );
    expect(
      screen.getByRole("tab", { name: "Checks" }).getAttribute("aria-selected"),
    ).toBe("true");
    // The server answers with the Checks tab rendered.
    view.rerender(
      <ProjectWorkspace
        {...props({ tab: "checks", tabContent: <p>Checks content</p> })}
      />,
    );
    const checks = screen.getByRole("tabpanel", { name: "Checks" });
    expect(within(checks).getByText("Checks content")).toBeTruthy();
    // The preview is hidden, not unmounted.
    const frame = screen.getByTestId("preview-frame");
    expect(frame.closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(true);
    expect(preview.mounts).toBe(1);
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    view.rerender(<ProjectWorkspace {...props({ tab: "preview" })} />);
    expect(preview.mounts).toBe(1);
    expect(
      screen
        .getByTestId("preview-frame")
        .closest("[role=tabpanel]")
        ?.hasAttribute("hidden"),
    ).toBe(false);
  });

  it("renders only the open tab's server part, in its own panel", () => {
    page({ tab: "log", explicitTab: true, tabContent: <p>The log</p> });
    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    const withLog = panels.filter((panel) =>
      panel.textContent?.includes("The log"),
    );
    expect(withLog).toHaveLength(1);
    expect(withLog[0].getAttribute("aria-labelledby")).toBe("studio-tab-log");
  });

  it("offers Try again when a tab didn't load", () => {
    page();
    fireEvent.click(screen.getByRole("tab", { name: "Log" }));
    const panel = screen.getByRole("tabpanel", { name: "Log" });
    expect(within(panel).getByRole("alert").textContent).toMatch(
      /Log didn't load/,
    );
    router.replace.mockClear();
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(router.replace).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p?tab=log",
      { scroll: false },
    );
  });

  it("counts the checks' findings and the missing pictures on their tabs", () => {
    setLive(status(), {
      checks: {
        versionId: "v2",
        checkRun: null,
        review: null,
        serious: 1,
        seriousStoreMink: 0,
        seriousPictures: 0,
        warnings: 2,
        allSeriousAreStoreMink: false,
      },
      pictures: { missing: 4, lastRun: null },
    });
    page();
    expect(screen.getByRole("tab", { name: /Checks/ }).textContent).toBe(
      "Checks, 3",
    );
    expect(screen.getByRole("tab", { name: /Pictures/ }).textContent).toBe(
      "Pictures, 4",
    );
  });
});

describe("refreshing", () => {
  it("never re-renders on a timer, and refreshes once when the theme changed", () => {
    vi.useFakeTimers();
    const view = page();
    vi.advanceTimersByTime(30_000);
    expect(router.refresh).not.toHaveBeenCalled();
    setLive(WORKING, {}, { revisionChanged: true, revision: 4 });
    view.rerender(<ProjectWorkspace {...props()} />);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    view.rerender(<ProjectWorkspace {...props()} />);
    vi.advanceTimersByTime(30_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes once when a release row comes or goes at the same revision", () => {
    // A publish that did not finish writes no project row: the poll answers
    // row 3 at the revision the server rendered row 2 with.
    const publishing = status({
      row: 2,
      words: "Publishing",
      tone: "info",
      primary: null,
      secondary: [],
    });
    setLive(publishing);
    const controls = { serverRow: 2, releaseControls: <p>Publishing now</p> };
    const view = page(controls);
    expect(router.refresh).not.toHaveBeenCalled();
    setLive(
      status({
        row: 3,
        words: "Publish didn't finish: the demo pages did not open",
        tone: "warning",
        primary: { kind: "retry_publish", label: "Try again" },
      }),
    );
    view.rerender(<ProjectWorkspace {...props(controls)} />);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    view.rerender(<ProjectWorkspace {...props(controls)} />);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // The server answers with row 3's controls: nothing more to refresh.
    view.rerender(
      <ProjectWorkspace
        {...props({ serverRow: 3, releaseControls: <p>Try again</p> })}
      />,
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh for a row change no release row is part of", () => {
    setLive(WORKING);
    const view = page({
      serverRow: 5,
      project: { ...base, status: "generating" },
    });
    setLive(
      status({
        row: 6,
        words: "Stuck since 10:40",
        tone: "warning",
        primary: {
          kind: "stop_and_check_again",
          label: "Stop and check again",
        },
        secondary: [{ kind: "stop", label: "Stop" }],
      }),
    );
    view.rerender(
      <ProjectWorkspace
        {...props({ serverRow: 5, project: { ...base, status: "generating" } })}
      />,
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("says so, and stops, when the session ended", () => {
    setLive(status(), {}, { problem: "signed_out" });
    page();
    expect(screen.getByRole("alert").textContent).toMatch(
      /Your session has ended/,
    );
    expect(
      screen.getByRole("link", { name: "Sign in again" }).getAttribute("href"),
    ).toBe("/dashboard/login");
  });
});

describe('the "..." menu', () => {
  it("stops work behind a dialog that says what is kept", async () => {
    setLive(WORKING, {
      working: {
        kind: "building",
        step: "Drawing pictures",
        since: NOW,
        lastProgressAt: NOW,
        nextTryAt: null,
      },
    });
    actions.stopThemeStudioChecksAction.mockResolvedValueOnce({
      ok: true,
      status: "ready",
      cancelling: false,
    });
    page({ project: { ...base, status: "generating" } });
    fireEvent.click(more());
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(actions.stopThemeStudioChecksAction).not.toHaveBeenCalled();
    const words = screen.getByText(
      /Pictures already drawn are saved/,
    ).textContent;
    expect(words).toMatch(/Continue building reuses them/);
    expect(words).toMatch(/goes back to its last design/);
    fireEvent.click(screen.getByRole("button", { name: "Stop now" }));
    await waitFor(() =>
      expect(actions.stopThemeStudioChecksAction).toHaveBeenCalledWith({
        projectId: "p",
        expectedRevision: 3,
      }),
    );
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(
        "Stopped. The theme is back on its last design.",
      ),
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("keeps a refusal in the dialog, and Keep going closes it", async () => {
    setLive(WORKING);
    actions.stopThemeStudioChecksAction.mockResolvedValueOnce({
      ok: false,
      error: `This theme is saving a step right now ${EM} try Stop again.`,
    });
    page({ project: { ...base, status: "generating" } });
    fireEvent.click(more());
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop now" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This theme is saving a step right now, try Stop again.",
    );
    const keep = screen.getByRole("button", { name: "Keep going" });
    await waitFor(() =>
      expect((keep as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(keep);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop now" })).toBeNull(),
    );
  });

  it("closes a dialog with Escape and gives focus back to the menu button", async () => {
    setLive(WORKING);
    page({ project: { ...base, status: "generating" } });
    fireEvent.click(more());
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more()));
  });

  it("holds Delete back, with the reason under it, while Theme Studio works", () => {
    setLive(WORKING);
    page({ project: { ...base, status: "generating" } });
    fireEvent.click(more());
    const remove = screen.getByRole("button", { name: "Delete" });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        "Stop the work first: a theme can't be deleted while Theme Studio works on it.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Remove from list/ }),
    ).toBeNull();
  });

  it("removes a theme from the list behind a dialog that keeps its history", async () => {
    actions.archiveThemeStudioProjectAction.mockResolvedValueOnce({ ok: true });
    page();
    fireEvent.click(more());
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove from list (keeps its history)",
      }),
    );
    expect(
      screen.getByText(/designs, checks and history are kept/),
    ).toBeTruthy();
    expect(actions.archiveThemeStudioProjectAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove from list" }));
    await waitFor(() =>
      expect(actions.archiveThemeStudioProjectAction).toHaveBeenCalledWith({
        projectId: "p",
        expectedRevision: 3,
      }),
    );
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(
        "Removed from the list. Its history is kept.",
      ),
    );
  });

  it("never offers Remove from list for a live theme; Delete stays", () => {
    setLive(
      status({
        row: 1,
        words: "Live, v1.0.0",
        tone: "success",
        primary: { kind: "open_live_demo", label: "Open live demo" },
        secondary: [
          { kind: "stop_offering", label: "Stop offering this theme" },
          { kind: "delete", label: "Delete" },
          // Even if a row offered it, a live theme never shows it.
          {
            kind: "remove_from_list",
            label: "Remove from list (keeps its history)",
          },
        ],
      }),
      {
        release: { version: "1.0.0", publishedAt: NOW, offered: true },
      },
    );
    page({ releaseControls: <button type="button">Open live demo</button> });
    fireEvent.click(more());
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Remove from list/ }),
    ).toBeNull();
  });

  it("deletes behind the dialog that asks for the theme ID", () => {
    page();
    fireEvent.click(more());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByLabelText(/Type crave to confirm/)).toBeTruthy();
  });
});

describe("the main button", () => {
  it("checks the current design again on today's build", async () => {
    actions.recheckThemeStudioVersionAction.mockResolvedValueOnce({
      ok: true,
      id: "cap",
      inPlace: true,
    });
    page();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(actions.recheckThemeStudioVersionAction).toHaveBeenCalledWith({
        projectId: "p",
        versionId: "v2",
        expectedRevision: 3,
      }),
    );
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(recheckMessage(2, true)),
    );
  });

  it("stops stuck work and checks again with the revision the stop left", async () => {
    setLive(
      status({
        row: 6,
        words: "Stuck since 10:20",
        tone: "warning",
        primary: {
          kind: "stop_and_check_again",
          label: "Stop and check again",
        },
        secondary: [{ kind: "stop", label: "Stop" }],
      }),
    );
    actions.stopThemeStudioChecksAction.mockResolvedValueOnce({
      ok: true,
      status: "ready",
      cancelling: false,
    });
    actions.recheckThemeStudioVersionAction.mockResolvedValueOnce({
      ok: true,
      inPlace: true,
    });
    const view = page({ project: { ...base, status: "generating" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Stop and check again" }),
    );
    expect(screen.getByText(/stuck work holds the theme/)).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Stop and check again",
      }),
    );
    await waitFor(() =>
      expect(actions.stopThemeStudioChecksAction).toHaveBeenCalledWith({
        projectId: "p",
        expectedRevision: 3,
      }),
    );
    expect(actions.recheckThemeStudioVersionAction).not.toHaveBeenCalled();
    // The page shows the stop: a newer revision.
    view.rerender(
      <ProjectWorkspace {...props({ project: { ...base, revision: 4 } })} />,
    );
    await waitFor(() =>
      expect(actions.recheckThemeStudioVersionAction).toHaveBeenCalledWith({
        projectId: "p",
        versionId: "v2",
        expectedRevision: 4,
      }),
    );
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(recheckMessage(2, true)),
    );
  });

  it("says a build step is still finishing its stop instead of checking", async () => {
    setLive(
      status({
        row: 6,
        words: "Stuck since 10:20",
        tone: "warning",
        primary: {
          kind: "stop_and_check_again",
          label: "Stop and check again",
        },
        secondary: [],
      }),
    );
    actions.stopThemeStudioChecksAction.mockResolvedValueOnce({
      ok: true,
      status: "generating",
      cancelling: true,
    });
    page({ project: { ...base, status: "generating" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Stop and check again" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Stop and check again",
      }),
    );
    expect(
      await screen.findByText(/A build step is still finishing its stop/),
    ).toBeTruthy();
    expect(actions.recheckThemeStudioVersionAction).not.toHaveBeenCalled();
  });

  it("continues a stopped build from its step, reusing what it drew", async () => {
    setLive(
      status({
        row: 10,
        words: "Stopped",
        primary: { kind: "continue_building", label: "Continue building" },
      }),
      { stop: { kind: "run", code: "cancelled", at: NOW, runId: "r9" } },
    );
    actions.retryThemeStudioRunAction.mockResolvedValueOnce({ ok: true });
    page();
    fireEvent.click(screen.getByRole("button", { name: "Continue building" }));
    await waitFor(() =>
      expect(actions.retryThemeStudioRunAction).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "p", runId: "r9" }),
      ),
    );
  });

  it("tries a failed first build again from its newest run when the stop names none", async () => {
    setLive(
      status({
        row: 17,
        words: "Couldn't finish",
        tone: "danger",
        primary: { kind: "retry_build", label: "Try again" },
      }),
    );
    actions.retryThemeStudioRunAction.mockResolvedValueOnce({ ok: true });
    page({
      project: {
        ...base,
        status: "failed",
        currentVersionId: null,
        versions: [],
        runs: [
          run({ id: "r-new", status: "failed", errorCode: "provider_timeout" }),
        ],
      },
      versionId: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(actions.retryThemeStudioRunAction).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "r-new" }),
      ),
    );
  });

  it("sends Describe a fix to the Checks tab, which puts it in the chat", () => {
    setLive(
      status({
        row: 14,
        words: "Needs a fix (1 problem)",
        tone: "danger",
        primary: { kind: "describe_fix", label: "Describe a fix" },
      }),
    );
    page();
    fireEvent.click(screen.getByRole("button", { name: "Describe a fix" }));
    expect(router.replace).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p?tab=checks&do=describe_fix",
      { scroll: false },
    );
  });

  it("sends Redraw to the Pictures tab", () => {
    setLive(
      status({
        row: 14,
        words: "Needs a fix (1 problem)",
        tone: "danger",
        primary: { kind: "redraw", label: "Redraw" },
      }),
    );
    page();
    fireEvent.click(screen.getByRole("button", { name: "Redraw" }));
    expect(router.replace).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p?tab=pictures&do=redraw",
      { scroll: false },
    );
  });

  it("opens the header's fix on the current design, never the other one shown", () => {
    window.history.replaceState(
      null,
      "",
      "/dashboard/themes/studio/p?version=v1",
    );
    nav.search = "version=v1";
    setLive(
      status({
        row: 14,
        words: "Needs a fix (2 problems)",
        tone: "danger",
        primary: { kind: "describe_fix", label: "Describe a fix" },
        secondary: [{ kind: "redraw", label: "Redraw" }, ...IDLE],
      }),
    );
    page({ versionId: "v1" });
    fireEvent.click(screen.getByRole("button", { name: "Describe a fix" }));
    expect(router.replace).toHaveBeenLastCalledWith(
      "/dashboard/themes/studio/p?tab=checks&do=describe_fix",
      { scroll: false },
    );
    fireEvent.click(screen.getByRole("button", { name: "Redraw" }));
    expect(router.replace).toHaveBeenLastCalledWith(
      "/dashboard/themes/studio/p?tab=pictures&do=redraw",
      { scroll: false },
    );
  });

  it("retries with a key even where crypto.randomUUID is missing", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: real.getRandomValues.bind(real),
    });
    setLive(
      status({
        row: 10,
        words: "Stopped",
        primary: { kind: "continue_building", label: "Continue building" },
      }),
      { stop: { kind: "run", code: "cancelled", at: NOW, runId: "r9" } },
    );
    actions.retryThemeStudioRunAction.mockResolvedValueOnce({ ok: true });
    page();
    fireEvent.click(screen.getByRole("button", { name: "Continue building" }));
    await waitFor(() =>
      expect(actions.retryThemeStudioRunAction).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "r9",
          idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{16,80}$/),
        }),
      ),
    );
    vi.unstubAllGlobals();
  });

  it("links Start a new theme from this brief to New theme", () => {
    setLive(
      status({
        row: 8,
        words: "Needs a new start: too many questions",
        primary: {
          kind: "start_new_from_brief",
          label: "Start a new theme from this brief",
        },
      }),
    );
    page();
    expect(
      screen
        .getByRole("link", { name: "Start a new theme from this brief" })
        .getAttribute("href"),
    ).toBe("/dashboard/themes/studio/new?from=p");
  });

  it("leaves the release rows' buttons to the release controls", () => {
    setLive(
      status({
        row: 15,
        words: "Ready to publish",
        tone: "success",
        primary: { kind: "publish", label: "Publish" },
      }),
    );
    page({ releaseControls: <button type="button">Publish from 2C</button> });
    expect(
      screen.getByRole("button", { name: "Publish from 2C" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });
});

describe("the Design list", () => {
  it("shows a design, and makes another current with its outcome", async () => {
    actions.restoreThemeStudioVersionAction.mockResolvedValueOnce({
      ok: true,
      changed: true,
      outcome: "ready_to_publish",
    });
    page();
    fireEvent.click(screen.getByRole("button", { name: /^Design 2/ }));
    const list = screen.getByRole("group", { name: "Designs" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0].textContent).toContain("Design 2");
    expect(items[0].textContent).toContain("changed from Design 1");
    expect(items[1].textContent).toContain("Design 1");
    fireEvent.click(within(items[1]).getByRole("button", { name: "Show it" }));
    expect(router.replace).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p?tab=preview&version=v1",
      { scroll: false },
    );
    fireEvent.click(screen.getByRole("button", { name: /^Design 2/ }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Designs" })).getByRole(
        "button",
        { name: "Make current" },
      ),
    );
    await waitFor(() =>
      expect(actions.restoreThemeStudioVersionAction).toHaveBeenCalledWith({
        projectId: "p",
        versionId: "v1",
        expectedRevision: 3,
      }),
    );
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(
        "Design 1 is current and Ready to publish.",
      ),
    );
  });

  it("holds Make current back while Theme Studio works, and says why", () => {
    setLive(WORKING);
    page({ project: { ...base, status: "generating" } });
    fireEvent.click(screen.getByRole("button", { name: /^Design 2/ }));
    expect(
      (
        screen.getByRole("button", {
          name: "Make current",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/Make another design current once it finishes/),
    ).toBeTruthy();
  });

  it("says which design is shown when it is not the current one", () => {
    page({ versionId: "v1" });
    expect(
      screen.getByRole("button", { name: /^Design 1/ }).textContent,
    ).toContain("not current");
  });
});

describe("intents (?do=)", () => {
  it("opens the Stop dialog for do=stop, then takes it out of the address", async () => {
    setLive(WORKING);
    window.history.replaceState(null, "", "/dashboard/themes/studio/p?do=stop");
    nav.search = "do=stop";
    const replace = vi.spyOn(window.history, "replaceState");
    page({ project: { ...base, status: "generating" } });
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/Stop work on Crave/)).toBeTruthy();
    expect(replace).toHaveBeenCalledWith(
      null,
      "",
      "/dashboard/themes/studio/p",
    );
    expect(actions.stopThemeStudioChecksAction).not.toHaveBeenCalled();
  });

  it("moves to the Checks tab for describe_fix, keeping the intent for it", () => {
    nav.search = "do=describe_fix";
    window.history.replaceState(
      null,
      "",
      "/dashboard/themes/studio/p?do=describe_fix",
    );
    const replace = vi.spyOn(window.history, "replaceState");
    page();
    expect(router.replace).toHaveBeenCalledWith(
      "/dashboard/themes/studio/p?do=describe_fix&tab=checks",
      { scroll: false },
    );
    // The Checks tab acts on it: the page leaves it in the address.
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?do=describe_fix");
  });

  it("only moves focus to Check again: an intent never starts work", () => {
    nav.search = "do=check_again";
    page();
    expect(document.activeElement?.textContent).toBe("Check again");
    expect(actions.recheckThemeStudioVersionAction).not.toHaveBeenCalled();
  });
});

describe("the chat column", () => {
  it("folds to a rail and remembers it", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: "Fold the chat" }));
    expect(
      parseChatPrefs(window.localStorage.getItem("studio:chat") ?? ""),
    ).toEqual({ width: 400, folded: true });
    expect(
      screen
        .getByRole("textbox", { name: "Message Theme Studio", hidden: true })
        .closest("[hidden]"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the chat" }));
    expect(
      parseChatPrefs(window.localStorage.getItem("studio:chat") ?? "").folded,
    ).toBe(false);
  });

  it("gives focus to the control that undoes a fold, never to the page's start", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: "Fold the chat" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open the chat" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the chat" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Fold the chat" }),
    );
  });

  it("puts the tab bar right before its panels, so Tab goes from a tab into its panel", () => {
    const view = page();
    const body = view.container.querySelector(".studio-body")!;
    expect([...body.children].map((part) => part.classList[0])).toEqual([
      "studio-chat",
      "studio-resizer",
      "studio-tabbar",
      "studio-panels",
    ]);
  });

  it("puts the tab bar first on a phone, where the chat is the Chat tab's panel", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const view = page();
    const body = view.container.querySelector(".studio-body")!;
    expect([...body.children].map((part) => part.classList[0])).toEqual([
      "studio-tabbar",
      "studio-chat",
      "studio-resizer",
      "studio-panels",
    ]);
    vi.unstubAllGlobals();
  });

  it("keeps its width from the keyboard, within its limits", () => {
    page();
    const separator = screen.getByRole("separator", { name: "Chat width" });
    expect(separator.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(
      parseChatPrefs(window.localStorage.getItem("studio:chat") ?? "").width,
    ).toBe(416);
    fireEvent.keyDown(separator, { key: "Home" });
    expect(
      parseChatPrefs(window.localStorage.getItem("studio:chat") ?? "").width,
    ).toBe(300);
  });

  it("ignores stored chat settings it can't read", () => {
    expect(parseChatPrefs("{oops")).toEqual({ width: 400, folded: false });
    expect(parseChatPrefs(JSON.stringify({ width: 9999 }))).toEqual({
      width: 640,
      folded: false,
    });
  });

  it("lets a tab put a draft in the chat for the operator to send", () => {
    function Draft(): ReactNode {
      const api = useStudioPage();
      return (
        <button type="button" onClick={() => api.putInChat("Fix the price.")}>
          Describe it
        </button>
      );
    }
    window.localStorage.setItem(
      "studio:chat",
      JSON.stringify({ width: 400, folded: true }),
    );
    page({ tab: "checks", explicitTab: true, tabContent: <Draft /> });
    fireEvent.click(screen.getByRole("button", { name: "Describe it" }));
    const composer = screen.getByRole("textbox", {
      name: "Message Theme Studio",
    }) as HTMLTextAreaElement;
    expect(composer.value).toBe("Fix the price.");
    expect(composer.closest("[hidden]")).toBeNull();
    expect(actions.reviseThemeStudioVersionAction).not.toHaveBeenCalled();
  });

  it("takes a change from a theme its security check blocked", () => {
    setLive(
      status({
        row: 9,
        words: "Can't publish: security problem",
        tone: "danger",
        primary: { kind: "describe_fix", label: "Describe a fix" },
      }),
    );
    page({ project: { ...base, status: "blocked" } });
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Theme Studio",
        }) as HTMLTextAreaElement
      ).disabled,
    ).toBe(false);
  });

  it("shows a start New theme could not make, once", async () => {
    window.sessionStorage.setItem(
      "studio:start-refused:p",
      "Building is switched off on this deployment.",
    );
    setLive(
      status({
        row: 18,
        words: "Not started",
        primary: { kind: "start_building", label: "Start building" },
      }),
    );
    page({
      project: {
        ...base,
        status: "draft",
        versions: [],
        currentVersionId: null,
      },
      versionId: null,
    });
    expect(
      await screen.findByText(
        /couldn't start building: Building is switched off/,
      ),
    ).toBeTruthy();
    expect(window.sessionStorage.getItem("studio:start-refused:p")).toBeNull();
  });
});

describe("banners and the phone bar", () => {
  it("says when building is switched off, and when the provider is the test one", () => {
    setLive(status(), {
      switches: { buildingOff: true, modelOff: false, checksOff: false },
    });
    page({ testProvider: true });
    expect(
      screen.getByText(
        /Building is switched off on this deployment\. You can look/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/offline test provider/)).toBeTruthy();
  });

  it("shows the status while building and hides while the composer is the action", () => {
    setLive(WORKING);
    page({ project: { ...base, status: "generating" } });
    const bar = screen.getByRole("region", { name: "Theme status" });
    expect(bar.textContent).toBe(
      "Building: drawing pictures (26 min). We'll let you know when it's ready.",
    );
    fireEvent.focus(
      screen.getByRole("textbox", { name: "Message Theme Studio" }),
    );
    expect(screen.queryByRole("region", { name: "Theme status" })).toBeNull();
  });

  it("never promises a notice for a publish: none is sent when one ends", () => {
    setLive(
      status({
        row: 2,
        words: "Publishing",
        tone: "info",
        primary: null,
        secondary: [],
      }),
    );
    page({ notifiesViewer: true });
    expect(
      screen.getByRole("region", { name: "Theme status" }).textContent,
    ).toBe("Publishing. You can leave this page.");
  });

  it("holds the phone bar's Publish back with the release controls' reason", () => {
    const reason =
      "This theme can't be published as it is: 2 image slots still have a placeholder.";
    function Waits() {
      const api = useStudioPage();
      useEffect(() => {
        api.reportPublishWait?.(reason);
      }, [api]);
      return null;
    }
    setLive(
      status({
        row: 15,
        words: "Ready to publish",
        tone: "success",
        primary: { kind: "publish", label: "Publish" },
      }),
    );
    const replace = vi.spyOn(window.history, "replaceState");
    page({ releaseControls: <Waits /> });
    const bar = screen.getByRole("region", { name: "Theme status" });
    const button = within(bar).getByRole("button", { name: "Publish" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const written = within(bar).getByText(reason);
    expect(button.getAttribute("aria-describedby")).toBe(written.id);
    replace.mockClear();
    fireEvent.click(button);
    expect(replace).not.toHaveBeenCalled();
  });

  it("asks the release controls to publish from the phone bar", () => {
    setLive(
      status({
        row: 15,
        words: "Ready to publish",
        tone: "success",
        primary: { kind: "publish", label: "Publish" },
      }),
    );
    const replace = vi.spyOn(window.history, "replaceState");
    page();
    fireEvent.click(
      within(screen.getByRole("region", { name: "Theme status" })).getByRole(
        "button",
        { name: "Publish" },
      ),
    );
    expect(replace).toHaveBeenLastCalledWith(
      null,
      "",
      "/dashboard/themes/studio/p?do=publish",
    );
  });
});

describe("words", () => {
  it("names designs by number and never uses a long dash", () => {
    expect(restoredMessage(2, "ready_to_publish")).toBe(
      "Design 2 is current and Ready to publish.",
    );
    expect(restoredMessage(4, "rechecking")).toBe(
      "Design 4 is current. Checking it again on today's StoreMink build, about 3 to 5 minutes.",
    );
    expect(restoredMessage(4, "checking")).toBe(
      "Design 4 is current. Checking it now, about 3 to 5 minutes.",
    );
    expect(restoredMessage(4, "ready")).toBe("Design 4 is current.");
    expect(restoredMessage(4, "ready", false)).toBe(
      "Design 4 is already current.",
    );
    expect(recheckMessage(3, true)).toBe(
      "Checking Design 3 again on today's StoreMink build. About 3 to 5 minutes; you can leave this page.",
    );
    expect(stoppedMessage({ cancelling: true })).toBe(
      "Stopping. The build step stops within a few seconds.",
    );
    expect(stoppedMessage({ status: "failed" })).toBe(
      "Stopped. This theme has no design yet: press Continue building to start it again.",
    );
    for (const text of [
      restoredMessage(1, "rechecking"),
      recheckMessage(1, true),
      recheckMessage(1, false),
      stoppedMessage({ status: "ready" }),
    ]) {
      expect(text.includes(EM) || text.includes(EN)).toBe(false);
      expect(text).not.toMatch(/version \d/i);
    }
  });

  it("says whether the automatic variety correction changed the design", () => {
    const report = {
      version: 1 as const,
      score: 0.41,
      threshold: 0.35,
      nearestThemeId: "studio",
      sharedAttributes: [],
      changedAxes: 3,
      status: "distinct" as const,
      repairAttempted: true,
    };
    expect(varietyCorrectionNote({ ...report, beforeScore: 0.12 })).toBe(
      "One automatic variety correction raised distinctness from 12% to 41%.",
    );
    expect(varietyCorrectionNote(report)).toBe(
      "One automatic variety correction was attempted.",
    );
  });

  it("keeps long dashes out of everything on the page", () => {
    setLive(status({ words: `Not checked ${EM} yet` }));
    const view = page({
      project: {
        ...base,
        versions: [version({ summary: `Warm ${EM} calm ${EN} kind` })],
        events: [ev("auto_qa_passed", NOW, { versionId: "v2" })],
      },
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /^Design 2/ }));
    });
    const text = view.container.textContent ?? "";
    expect(text).toContain("Warm, calm, kind");
    // Even status words carrying a stored reason are shown without one.
    expect(text).toContain("Not checked, yet");
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
  });
});
