// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type {
  PublicationWarning,
  ThemeStudioReleaseState,
} from "@/lib/theme-studio/publication";
import type { StudioStatus } from "../studio-status";
import {
  EM,
  EN,
  PROJECT_ID,
  V1,
  V2,
  projectDetail,
  versionView,
} from "./_test-helpers";
import type {
  ReleaseLiveFacts,
  ReleasePanelProps,
  ReleasePublishFacts,
} from "./release/release-workspace";

// The release controls' server part (wave TS-2, builder 2C; contract
// section 6.4): which buttons show (the status function's actions, never
// the "..." menu's), and the facts and words handed to the client part.

const data = vi.hoisted(() => ({
  project: null as unknown,
  release: null as unknown,
  actor: null as unknown,
}));
vi.mock("./tab-reads", () => ({
  readStudioProject: vi.fn(async () => data.project),
  readStudioReleaseState: vi.fn(async () => data.release),
}));
vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => data.actor),
}));
vi.mock("@/lib/store/host", () => ({
  subdomainOrigin: (slug: string) => `https://${slug}.storemink.com`,
}));
vi.mock("./release/release-workspace", () => ({
  ReleasePanel: () => null,
}));
import { readStudioReleaseState } from "./tab-reads";
import {
  ReleaseControls,
  dayWords,
  publishWarningLine,
} from "./release-controls";

function release(
  overrides: Partial<ThemeStudioReleaseState> = {},
): ThemeStudioReleaseState {
  return {
    evidence: { ok: true, runId: "run", evidenceDigest: "e".repeat(64) },
    evidenceGap: null,
    recheckOnPublish: false,
    packageDigest: "d".repeat(64),
    versionNumber: 2,
    blockers: [],
    warnings: [],
    publications: [],
    catalog: null,
    publishedReleases: [],
    audit: [],
    ...overrides,
  };
}

function status(overrides: Partial<StudioStatus>): StudioStatus {
  return {
    row: 15,
    words: "Ready to publish",
    tone: "success",
    primary: { kind: "publish", label: "Publish" },
    secondary: [
      {
        kind: "remove_from_list",
        label: "Remove from list (keeps its history)",
      },
      { kind: "delete", label: "Delete" },
    ],
    ...overrides,
  };
}

async function controls(
  overrides: Partial<StudioStatus> = {},
  versionId: string | null = V2,
): Promise<ReleasePanelProps> {
  const element = (await ReleaseControls({
    projectId: PROJECT_ID,
    versionId,
    revision: 7,
    status: status(overrides),
  })) as ReactElement<ReleasePanelProps>;
  return element.props;
}

const tapWarning: PublicationWarning = {
  source: "checks",
  gate: "browser.tap_targets",
  code: "small_target",
  count: 3,
  message: "20×20px interactive target (.chip); minimum is 24×24px.",
  where: ["phone390 · shop", "phone390 · product"],
  platform: true,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T08:00:00Z"));
  data.project = projectDetail({
    versions: [
      versionView({ createdAt: "2026-10-25T06:10:00Z" }),
      versionView({ id: V1, versionNumber: 1, parentVersionId: null }),
    ],
  });
  data.release = release();
  data.actor = { id: "a", email: "Maker@StoreMink.com" };
});
afterEach(() => vi.useRealTimers());

describe("the facts for Publish", () => {
  it("names the current design, when it was made, the warnings, and who is told", async () => {
    data.release = release({ warnings: [tapWarning] });
    const props = await controls();
    expect(props.actions).toEqual([{ kind: "publish", label: "Publish" }]);
    expect(props.demoOrigin).toBe("https://demo-aurora.storemink.com");
    const publish = props.publish as ReleasePublishFacts;
    expect(publish).toMatchObject({
      designNumber: 2,
      madeAt: "11:40",
      viewingNumber: null,
      recheck: false,
      waitReason: null,
      lastReasons: [],
      notifies: true,
    });
    expect(publish.warnings).toEqual([
      "Button sizes on phones (Shop at 390 px, Product at 390 px): A button or link is 20 by 20 px; the smallest easy size to tap is 24 by 24 px. This is in StoreMink's shared storefront code, not in this theme. StoreMink has been told.",
    ]);
  });

  it("says when another design is on screen, and tells only the operator who started the theme", async () => {
    data.actor = { id: "b", email: "someone@storemink.com" };
    const publish = (await controls({}, V1)).publish as ReleasePublishFacts;
    expect(publish.viewingNumber).toBe(1);
    expect(publish.notifies).toBe(false);
  });

  it("re-checks first, with the reason, when the checks are not today's", async () => {
    data.release = release({
      evidence: { ok: false, reason: "StoreMink was updated." },
      evidenceGap: "old_build",
      recheckOnPublish: true,
      warnings: [tapWarning],
    });
    const publish = (
      await controls({
        row: 16,
        words: "Ready to publish (StoreMink was updated)",
      })
    ).publish as ReleasePublishFacts;
    expect(publish).toMatchObject({
      recheck: true,
      recheckReason: "StoreMink was updated since these checks.",
      waitReason: null,
      warnings: [],
    });
  });

  it("waits with a reason when Publish can do nothing now", async () => {
    data.release = release({
      blockers: [
        `2 image slots still have a placeholder ${EM} replace them.`,
        "Another.",
      ],
    });
    expect(((await controls()).publish as ReleasePublishFacts).waitReason).toBe(
      "This theme can't be published as it is: 2 image slots still have a placeholder, replace them. (and 1 more)",
    );
    data.release = release({
      evidence: {
        ok: false,
        reason: `These checks ran on an earlier build ${EN} run them again.`,
      },
      evidenceGap: "old_build",
      recheckOnPublish: false,
    });
    expect(((await controls()).publish as ReleasePublishFacts).waitReason).toBe(
      "These checks ran on an earlier build, run them again.",
    );
  });

  it("puts the last attempt's reasons beside Try again", async () => {
    data.release = release({
      publications: [
        {
          id: "pub",
          status: "failed",
          releaseVersion: "1.0.0",
          versionId: V2,
          failure: [`The demo store didn't build ${EM} storage was busy.`],
          createdByEmail: "maker@storemink.com",
          createdAt: "2026-10-25T07:00:00Z",
          completedAt: null,
        },
      ],
    });
    const props = await controls({
      row: 3,
      words: "Publish didn't finish: the demo store didn't build",
      tone: "warning",
      primary: { kind: "retry_publish", label: "Try again" },
    });
    expect(props.actions).toEqual([
      { kind: "retry_publish", label: "Try again" },
    ]);
    expect((props.publish as ReleasePublishFacts).lastReasons).toEqual([
      "The demo store didn't build, storage was busy.",
    ]);
  });
});

describe("the facts for a live theme", () => {
  it("says whether it is offered, its release and since when, with the visible actions only", async () => {
    data.release = release({
      catalog: { visibility: "public", releaseVersion: "1.0.0" },
      publications: [
        {
          id: "pub",
          status: "published",
          releaseVersion: "1.0.0",
          versionId: V2,
          failure: [],
          createdByEmail: "maker@storemink.com",
          createdAt: "2026-10-01T05:00:00Z",
          completedAt: "2026-10-01T05:04:00Z",
        },
      ],
    });
    const props = await controls({
      row: 1,
      words: "Live, v1.0.0",
      primary: { kind: "open_live_demo", label: "Open live demo" },
      secondary: [
        { kind: "stop_offering", label: "Stop offering this theme" },
        {
          kind: "start_new_from_brief",
          label: "Start a new theme from this brief",
        },
        { kind: "delete", label: "Delete" },
      ],
    });
    expect(props.actions.map((a) => a.kind)).toEqual([
      "open_live_demo",
      "stop_offering",
      "start_new_from_brief",
    ]);
    expect(props.live as ReleaseLiveFacts).toEqual({
      offered: true,
      version: "1.0.0",
      since: "1 Oct",
    });
    expect(props.publish).toBeNull();
  });

  it("is not offered when the catalog hides it", async () => {
    data.release = release({
      catalog: { visibility: "hidden", releaseVersion: "1.0.0" },
    });
    const props = await controls({
      row: 1,
      words: "Not offered to new stores",
      primary: { kind: "offer_again", label: "Offer again" },
      secondary: [],
    });
    expect((props.live as ReleaseLiveFacts).offered).toBe(false);
  });
});

describe("publishing now", () => {
  it("reads nothing more than the project", async () => {
    const props = await controls({
      row: 2,
      words: "Publishing",
      tone: "info",
      primary: null,
      secondary: [],
    });
    expect(props.row).toBe(2);
    expect(props.live).toBeNull();
    expect(props.publish).toBeNull();
    expect(readStudioReleaseState).not.toHaveBeenCalled();
  });
});

describe("words", () => {
  it("words a warning from the design review by its row or total", () => {
    expect(
      publishWarningLine({
        source: "review",
        gate: null,
        code: "low_total",
        count: 1,
        message: null,
        where: ["32 of 40"],
        platform: false,
      }),
    ).toBe("The design review gave 32 of 40 in all; it asks for 34.");
    expect(
      publishWarningLine({
        source: "review",
        gate: null,
        code: "low_score",
        count: 2,
        message: null,
        where: ["typography 3 of 5", "imagery 3 of 5"],
        platform: false,
      }),
    ).toBe(
      "The design review scored the typography 3 of 5; it asks for 4. The design review scored the photos 3 of 5; it asks for 4.",
    );
    expect(
      publishWarningLine({
        source: "review",
        gate: null,
        code: "image_redraw",
        count: 1,
        message: null,
        where: ["hero-main"],
        platform: false,
      }),
    ).toMatch(/^A photo was flagged for something small/);
  });

  it("names StoreMink's shared code even when the stored warning lost its selectors", () => {
    const line = publishWarningLine({
      source: "checks",
      gate: "browser.overflow",
      code: "horizontal_overflow",
      count: 1,
      message: "The page is 12px wider than the viewport.",
      where: ["phone390 · home"],
      platform: true,
    });
    expect(line).toBe(
      "Fits the screen (Home at 390 px): The page is 12 px wider than the screen, so it scrolls sideways. This is in StoreMink's shared storefront code; StoreMink has been told.",
    );
    expect(line.includes(EM) || line.includes(EN)).toBe(false);
  });

  it("writes a day in India time, with the year only when it is not this year's", () => {
    const now = "2026-10-25T08:00:00Z";
    expect(dayWords("2026-10-01T05:04:00Z", now)).toBe("1 Oct");
    // 31 Dec 2025 in UTC is already 1 Jan 2026 in India: this year's.
    expect(dayWords("2025-12-31T20:00:00Z", now)).toBe("1 Jan");
    expect(dayWords("2025-06-01T05:00:00Z", now)).toBe("1 Jun 2025");
    expect(dayWords(null, now)).toBeNull();
    expect(dayWords("garbage", now)).toBeNull();
  });
});
