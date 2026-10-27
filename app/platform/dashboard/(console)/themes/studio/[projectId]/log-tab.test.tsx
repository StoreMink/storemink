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
import type { ThemeStudioReleaseState } from "@/lib/theme-studio/publication";
import {
  EM,
  EN,
  PROJECT_ID,
  V2,
  projectDetail,
  runView,
} from "./_test-helpers";

// The Log tab (wave TS-2; 2B's round-1 tab finished by 2C): the theme's ID,
// model, creator and today's build; the runs with codes, tokens and costs
// (Cancel, Retry); Publish history with each attempt's reasons and the
// catalog audit; Activity; Copy details.

const data = vi.hoisted(() => ({
  project: null as unknown,
  release: null as unknown,
}));
vi.mock("./tab-reads", () => ({
  readStudioProject: vi.fn(async () => data.project),
  readStudioReleaseState: vi.fn(async () => data.release),
}));
vi.mock("@/lib/theme-studio/acceptance", () => ({
  currentAcceptanceBuildId: () => "build-9",
}));
vi.mock("./workspace", () => ({
  CancelRunButton: ({ runId }: { runId: string }) => (
    <button type="button">Cancel {runId}</button>
  ),
  RetryRunButton: ({ runId }: { runId: string }) => (
    <button type="button">Retry {runId}</button>
  ),
}));
import { LogTab } from "./log-tab";

const props = { projectId: PROJECT_ID, versionId: V2, revision: 7 };

function release(
  overrides: Partial<ThemeStudioReleaseState> = {},
): ThemeStudioReleaseState {
  return {
    evidence: { ok: false, reason: "Not yet." },
    evidenceGap: null,
    recheckOnPublish: false,
    packageDigest: null,
    versionNumber: 2,
    warnings: [],
    blockers: [],
    publications: [],
    catalog: null,
    publishedReleases: [],
    audit: [],
    ...overrides,
  };
}

async function show(element: Promise<ReactElement>) {
  return render(await element);
}

beforeEach(() => {
  data.project = projectDetail({
    status: "ready",
    runs: [
      runView({
        id: "r3",
        kind: "images",
        status: "failed",
        errorCode: "images_none",
        baseVersionId: V2,
        finishedAt: "2026-10-25T06:00:00Z",
      }),
      runView({ id: "r2", status: "running", finishedAt: null }),
      runView({
        id: "r1",
        status: "failed",
        errorCode: "provider_timeout",
        usage: {
          inputTokens: 12000,
          outputTokens: 3400,
          thinkingTokens: 0,
          cachedTokens: 0,
          estimatedCostMicroUsd: 50_000,
          repairs: 1,
        } as never,
      }),
    ],
    events: [
      {
        id: "e1",
        eventType: "run_failed",
        actorKind: "worker",
        actorEmail: null,
        runId: "r3",
        detail: { errorCode: "images_none" },
        createdAt: "2026-10-25T06:00:00Z",
      },
    ],
  });
  data.release = release();
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
});
afterEach(() => cleanup());

describe("the Log tab", () => {
  it("names the theme's ID, model, creator and today's StoreMink build", async () => {
    await show(LogTab(props));
    const theme = screen
      .getByRole("heading", { name: "This theme" })
      .closest("section")!;
    expect(within(theme).getByText("aurora")).toBeTruthy();
    expect(within(theme).getByText(/maker@storemink\.com on/)).toBeTruthy();
    expect(within(theme).getByText("build-9")).toBeTruthy();
    expect(within(theme).getByText("Model")).toBeTruthy();
  });

  it("keeps the runs with their codes, tokens and costs, Cancel, and Retry on the newest that stopped", async () => {
    await show(LogTab(props));
    const runs = screen.getByRole("region", { name: "Runs" });
    expect(within(runs).getByRole("button", { name: "Retry r3" })).toBeTruthy();
    expect(within(runs).queryByRole("button", { name: "Retry r1" })).toBeNull();
    expect(
      within(runs).getByRole("button", { name: "Cancel r2" }),
    ).toBeTruthy();
    expect(within(runs).getByText("(images_none)")).toBeTruthy();
    expect(within(runs).getByText(/12,000 tokens in/)).toBeTruthy();
    expect(within(runs).getByText(/about \$0\.05/)).toBeTruthy();
  });

  it("copies a stopped run's details for an engineer", async () => {
    await show(LogTab(props));
    const runs = screen.getByRole("region", { name: "Runs" });
    fireEvent.click(
      within(runs).getAllByRole("button", { name: "Copy details" })[0],
    );
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalled(),
    );
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(copied).toContain("Code: images_none");
    expect(copied).toContain("Check: pictures run r3");
    expect(copied).toContain("Design: Design 2 (version 2)");
  });

  it("keeps Publish history with each attempt's reasons, and the catalog audit", async () => {
    data.release = release({
      publications: [
        {
          id: "pub-2",
          status: "published",
          releaseVersion: "1.0.1",
          versionId: V2,
          failure: [],
          createdByEmail: "maker@storemink.com",
          createdAt: "2026-10-25T07:00:00Z",
          completedAt: "2026-10-25T07:03:00Z",
        },
        {
          id: "pub-1",
          status: "failed",
          releaseVersion: "1.0.0",
          versionId: V2,
          failure: [`The demo store didn't build ${EM} storage was busy.`],
          createdByEmail: "maker@storemink.com",
          createdAt: "2026-10-25T06:50:00Z",
          completedAt: null,
        },
      ],
      audit: [
        {
          id: "a1",
          action: "hide",
          visibility: "hidden",
          previousVisibility: "public",
          releaseVersion: "1.0.1",
          reason: "Hidden from new stores.",
          createdByEmail: "boss@storemink.com",
          createdAt: "2026-10-25T08:00:00Z",
        },
      ],
    });
    const view = await show(LogTab(props));
    const history = screen.getByRole("region", { name: "Publish history" });
    expect(
      within(history).getByText(/Publish v1\.0\.1/).parentElement?.textContent,
    ).toMatch(/of Design 2: Published/);
    expect(
      within(history).getByText(
        "The demo store didn't build, storage was busy.",
      ),
    ).toBeTruthy();
    expect(
      within(history).getByText("Stopped offering it to new stores"),
    ).toBeTruthy();
    const text = view.container.textContent ?? "";
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
  });

  it("says when a theme was never published, and keeps Activity", async () => {
    await show(LogTab(props));
    expect(screen.getByText("This theme has not been published.")).toBeTruthy();
    const activity = screen.getByRole("region", { name: "Activity" });
    expect(within(activity).getByText("A step stopped")).toBeTruthy();
    expect(within(activity).getByText("(images_none)")).toBeTruthy();
  });

  it("says so when the theme no longer exists", async () => {
    data.project = null;
    const view = await show(LogTab(props));
    expect(view.container.textContent).toBe("This theme no longer exists.");
  });
});
