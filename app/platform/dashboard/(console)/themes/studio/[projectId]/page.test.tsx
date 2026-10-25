// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThemeStudioProjectDetail,
  ThemeStudioVersionView,
} from "@/lib/theme-studio/repository";
import type { ThemeStudioProgress } from "@/lib/theme-studio/progress";
import type { StudioStatus } from "../studio-status";

// The theme page's server part (contract section 6.2): the superadmin gate
// first, one tab rendered (the open one), the version fallback, the release
// controls only on their rows, and the retired ?repairAcceptance.

const data = vi.hoisted(() => ({
  actor: null as unknown,
  projects: [] as unknown[],
  progress: null as unknown,
  status: null as unknown,
  reads: { project: 0, progress: 0 },
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock("../../../require-operator", () => ({
  requireOperator: vi.fn(async () => ({ email: "op@storemink.com" })),
}));
vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => data.actor),
}));
vi.mock("@/lib/theme-studio/repository", () => ({
  getThemeStudioProject: vi.fn(async () => {
    data.reads.project += 1;
    return data.projects.length > 1
      ? data.projects.shift()
      : (data.projects[0] ?? null);
  }),
}));
vi.mock("@/lib/theme-studio/progress", () => ({
  readThemeStudioProgress: vi.fn(async () => {
    data.reads.progress += 1;
    // A list answers its reads in turn (the last one stays).
    return Array.isArray(data.progress)
      ? data.progress.length > 1
        ? data.progress.shift()
        : data.progress[0]
      : data.progress;
  }),
  readThemeStudioBuildTimeRange: vi.fn(async () => ({
    fromMinutes: 35,
    toMinutes: 75,
    basedOn: 0,
    source: "default",
  })),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) => fn({})),
}));
vi.mock("@/lib/theme-studio/config", () => ({
  getThemeStudioConfig: vi.fn(() => ({ provider: "fake" })),
}));
vi.mock("../studio-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../studio-status")>()),
  studioStatus: vi.fn(() => data.status),
}));
vi.mock("./checks-tab", () => ({ ChecksTab: vi.fn(() => null) }));
vi.mock("./pictures-tab", () => ({ PicturesTab: vi.fn(() => null) }));
vi.mock("./changes-tab", () => ({ ChangesTab: vi.fn(() => null) }));
vi.mock("./log-tab", () => ({ LogTab: vi.fn(() => null) }));
vi.mock("./release-controls", () => ({ ReleaseControls: vi.fn(() => null) }));
vi.mock("./workspace", () => ({ ProjectWorkspace: vi.fn(() => null) }));
// The page reads the project through the request's cache that the tabs and
// the release controls share; here it answers from the repository's mock.
vi.mock("./tab-reads", async () => {
  const repository = await import("@/lib/theme-studio/repository");
  return {
    readStudioProject: vi.fn((projectId: string) =>
      repository.getThemeStudioProject(projectId),
    ),
  };
});
import ThemeStudioProjectPage from "./page";
import { ChecksTab } from "./checks-tab";
import { LogTab } from "./log-tab";
import { ReleaseControls } from "./release-controls";
import { ProjectWorkspace } from "./workspace";
import { readStudioProject } from "./tab-reads";

const ID = "11111111-1111-4111-8111-111111111111";

function version(
  id: string,
  versionNumber: number,
  hasPackage = true,
): ThemeStudioVersionView {
  return {
    id,
    versionNumber,
    parentVersionId: null,
    runId: null,
    origin: "run",
    editedSlots: [],
    intentDigest: "d",
    packageDigest: "p",
    packageSummary: null,
    summary: "",
    assumptions: [],
    hasPackage,
    qaStatus: "passed",
    qaIteration: 0,
    createdAt: "2026-10-25T04:00:00Z",
  };
}

function project(
  overrides: Partial<ThemeStudioProjectDetail> = {},
): ThemeStudioProjectDetail {
  return {
    id: ID,
    themeId: "aurora",
    name: "Aurora",
    status: "ready",
    modelKey: "gemini-3.8-flash",
    industries: ["home"],
    catalogSizes: ["small"],
    requiredFeatures: [],
    baseThemeId: null,
    draftBrief: "",
    currentVersionId: "v2",
    revision: 5,
    createdByEmail: "Op@StoreMink.com",
    createdAt: "2026-10-25T04:00:00Z",
    updatedAt: "2026-10-25T04:00:00Z",
    references: [],
    messages: [],
    runs: [],
    versions: [version("v3", 3), version("v2", 2), version("v1", 1)],
    previews: [],
    events: [],
    ...overrides,
  };
}

function progress(revision = 5): ThemeStudioProgress {
  return {
    projectId: ID,
    revision,
    versionIds: ["v3", "v2", "v1"],
    currentVersionId: "v2",
    status: {} as ThemeStudioProgress["status"],
    steps: [],
    updatedAt: "2026-10-25T05:00:00Z",
  };
}

function statusRow(row: number): StudioStatus {
  return { row, words: "x", tone: "neutral", primary: null, secondary: [] };
}

async function open(search: Record<string, string | string[]> = {}) {
  return (await ThemeStudioProjectPage({
    params: Promise.resolve({ projectId: ID }),
    searchParams: Promise.resolve(search),
  })) as ReactElement<Record<string, unknown>>;
}

beforeEach(() => {
  data.actor = { id: "a", email: "op@storemink.com" };
  data.projects = [project()];
  data.progress = progress();
  data.status = statusRow(19);
  data.reads = { project: 0, progress: 0 };
});
afterEach(() => cleanup());

describe("the theme page's server part", () => {
  it("shows only the superadmin sentence to anyone else, and reads nothing", async () => {
    data.actor = null;
    const view = render(await open());
    expect(
      view.container.firstElementChild?.classList.contains("studio-root"),
    ).toBe(true);
    expect(
      screen.getByText("Theme Studio is limited to superadmins"),
    ).toBeTruthy();
    expect(data.reads).toEqual({ project: 0, progress: 0 });
  });

  it("answers not found for an unknown theme", async () => {
    data.projects = [];
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the workspace with the progress it read and the Preview tab by default", async () => {
    const page = await open();
    expect(page.type).toBe(ProjectWorkspace);
    expect(page.props.tab).toBe("preview");
    expect(page.props.explicitTab).toBe(false);
    expect(page.props.tabContent).toBeNull();
    expect(page.props.initialProgress).toEqual(progress());
    expect(page.props.buildTime).toMatchObject({ fromMinutes: 35 });
    expect(page.props.testProvider).toBe(true);
    expect(page.props.draftLayout).toBeNull();
    // The viewer started the theme (emails compared without case).
    expect(page.props.notifiesViewer).toBe(true);
  });

  it("renders exactly one tab's server part, the open one", async () => {
    const page = await open({ tab: "checks" });
    const tab = page.props.tabContent as ReactElement<Record<string, unknown>>;
    expect(tab.type).toBe(ChecksTab);
    expect(tab.props).toEqual({ projectId: ID, versionId: "v2", revision: 5 });
    expect(page.props.explicitTab).toBe(true);
    const log = await open({ tab: "log" });
    expect((log.props.tabContent as ReactElement).type).toBe(LogTab);
    const unknown = await open({ tab: "everything" });
    expect(unknown.props.tab).toBe("preview");
    expect(unknown.props.tabContent).toBeNull();
  });

  it("shows another design only when it is one of this theme's, else the current one", async () => {
    expect((await open({ version: "v3" })).props.versionId).toBe("v3");
    expect(
      (await open({ version: "hidden-or-another-theme" })).props.versionId,
    ).toBe("v2");
    expect((await open({ version: ["v1", "v3"] })).props.versionId).toBe("v1");
    data.projects = [project({ currentVersionId: null })];
    expect((await open()).props.versionId).toBe("v3");
    data.projects = [project({ currentVersionId: null, versions: [] })];
    expect((await open()).props.versionId).toBeNull();
  });

  it("passes the release controls only on their rows", async () => {
    for (const row of [1, 2, 3, 15, 16]) {
      data.status = statusRow(row);
      const page = await open();
      const controls = page.props.releaseControls as ReactElement<
        Record<string, unknown>
      >;
      expect(controls.type).toBe(ReleaseControls);
      expect(controls.props.status).toEqual(statusRow(row));
    }
    for (const row of [4, 5, 6, 9, 14, 18, 19]) {
      data.status = statusRow(row);
      expect((await open()).props.releaseControls).toBeNull();
    }
  });

  it("reads the whole theme once, through the cache the tabs share, by the id the progress names", async () => {
    const page = await open({ tab: "checks" });
    expect(data.reads).toEqual({ project: 1, progress: 1 });
    expect(readStudioProject).toHaveBeenCalledTimes(1);
    expect(readStudioProject).toHaveBeenCalledWith(ID);
    // The open tab and the release controls get the same id, so they hit
    // the same cache entry instead of reading the theme again.
    const tab = page.props.tabContent as ReactElement<Record<string, unknown>>;
    expect(tab.props.projectId).toBe(ID);
  });

  it("reads the progress again when the theme changed between its two reads", async () => {
    data.progress = [progress(5), progress(6)];
    data.projects = [project({ revision: 6 })];
    const page = await open();
    expect(data.reads).toEqual({ project: 1, progress: 2 });
    expect((page.props.project as ThemeStudioProjectDetail).revision).toBe(6);
    expect((page.props.initialProgress as ThemeStudioProgress).revision).toBe(
      6,
    );
  });

  it("tells the workspace the row it rendered the release controls for", async () => {
    for (const row of [2, 3, 15, 19]) {
      data.status = statusRow(row);
      expect((await open()).props.serverRow).toBe(row);
    }
  });

  it("sends the retired Describe a fix address to the Checks tab", async () => {
    await expect(
      open({ repairAcceptance: "run-1", version: "v1", tab: "log" }),
    ).rejects.toThrow(
      `NEXT_REDIRECT /dashboard/themes/studio/${ID}?version=v1&tab=checks&do=describe_fix`,
    );
  });

  it("does not tell a viewer who did not start the theme that notices reach them", async () => {
    data.actor = { id: "b", email: "someone@storemink.com" };
    expect((await open()).props.notifiesViewer).toBe(false);
  });
});
