// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  StudioStatusInput,
  ThemeStudioList,
  ThemeStudioListRow,
} from "@/lib/theme-studio/progress";
import type { StudioStatus } from "./studio-status";

// ---------------------------------------------------------------------------
// The Theme Studio list (wave TS-2, builder 2D; contract section 8.3): the
// filters with their counts; each row's picture, name, status words, time
// and main button, and its second line; the main button never acts by
// itself (a link to the theme page with `?do=`, the demo, or New theme from
// this brief). studioStatus is builder 2A's, so it is stood in for here: the
// list's own job is to render what it decides.
// ---------------------------------------------------------------------------

const statuses = vi.hoisted(() => new Map<unknown, StudioStatus>());
vi.mock("./studio-status", () => ({
  studioStatus: vi.fn((input: unknown) => {
    const status = statuses.get(input);
    if (!status) throw new Error("no status for this row");
    return status;
  }),
}));
vi.mock("./studio-ui", () => ({
  StudioBadge: ({
    status,
  }: {
    status: Pick<StudioStatus, "words" | "tone">;
  }) => (
    <span className="studio-badge" data-tone={status.tone}>
      {status.words}
    </span>
  ),
  plainText: (text: string) =>
    text
      .replace(/(\d)\s*\u2013\s*(\d)/g, "$1 to $2")
      .replace(/\s*[\u2013\u2014]\s*/g, ", "),
}));
vi.mock("./studio-words", () => ({
  durationWords: (ms: number) => `${Math.round(ms / 60_000)} min`,
}));

import {
  agoWords,
  listHref,
  parseListFilter,
  rowActionTarget,
  StudioList,
} from "./studio-list";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const NOW = "2026-10-25T06:00:00.000Z";

function input(overrides: Partial<StudioStatusInput> = {}): StudioStatusInput {
  return {
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
    ...overrides,
  };
}

function row(
  projectId: string,
  name: string,
  status: StudioStatus,
  overrides: Partial<ThemeStudioListRow> = {},
  facts: Partial<StudioStatusInput> = {},
): ThemeStudioListRow {
  const statusInput = input(facts);
  statuses.set(statusInput, status);
  return {
    projectId,
    name,
    themeId: name.toLowerCase(),
    updatedAt: "2026-10-25T05:48:00.000Z",
    status: statusInput,
    activeStep: null,
    pictureUrl: `/api/theme-studio/images/${projectId}-card`,
    ...overrides,
  };
}

const COUNTS: ThemeStudioList["counts"] = {
  all: 12,
  needs_you: 2,
  building: 1,
  ready: 2,
  live: 3,
  archived: 4,
};

function status(
  rowNumber: number,
  words: string,
  primary: StudioStatus["primary"],
  tone: StudioStatus["tone"] = "neutral",
): StudioStatus {
  return { row: rowNumber, words, tone, primary, secondary: [] };
}

afterEach(() => {
  cleanup();
  statuses.clear();
});

describe("the filters", () => {
  it("shows every filter with its count, and marks the open one", () => {
    render(
      <StudioList list={{ rows: [], counts: COUNTS }} filter="needs_you" />,
    );
    const nav = screen.getByRole("navigation", { name: "Show themes" });
    const links = within(nav).getAllByRole("link");
    expect(
      links.map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["All12", "/dashboard/themes/studio"],
      ["Needs you2", "/dashboard/themes/studio?filter=needs_you"],
      ["Building1", "/dashboard/themes/studio?filter=building"],
      ["Ready2", "/dashboard/themes/studio?filter=ready"],
      ["Live3", "/dashboard/themes/studio?filter=live"],
      ["Archived4", "/dashboard/themes/studio?filter=archived"],
    ]);
    const open = within(nav).getByRole("link", { current: "page" });
    expect(open.textContent).toBe("Needs you2");
    expect(open.className).toContain("active");
    expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
  });

  it("reads ?filter= strictly: anything unknown is All", () => {
    expect(parseListFilter("live")).toBe("live");
    expect(parseListFilter("archived")).toBe("archived");
    expect(parseListFilter(undefined)).toBe("all");
    expect(parseListFilter("ready_to_publish")).toBe("all");
    expect(parseListFilter(["live", "ready"])).toBe("all");
    expect(listHref("all")).toBe("/dashboard/themes/studio");
  });
});

describe("a row", () => {
  it("has the catalogue card, the name, the status words, the time and the main button", () => {
    const rows = [
      row(
        "p-aurora",
        "Aurora",
        status(
          7,
          "Needs your answer",
          { kind: "answer", label: "Answer" },
          "warning",
        ),
        {},
        {
          projectStatus: "blocked",
          questions: {
            open: true,
            count: 2,
            askedAt: NOW,
            rounds: 1,
            tooManyRounds: false,
          },
        },
      ),
      row(
        "p-pantry",
        "Pantry",
        status(5, "Building: drawing pictures (34 min)", null, "info"),
        {
          pictureUrl: null,
          activeStep: {
            key: "pictures",
            label: "Drawing pictures",
            state: "running",
            detail: "8 of 18",
            startedAt: NOW,
            finishedAt: null,
            nextTryAt: null,
          },
        },
        {
          projectStatus: "generating",
          working: {
            kind: "building",
            step: "Drawing pictures",
            since: "2026-10-25T05:26:00.000Z",
            lastProgressAt: NOW,
            nextTryAt: null,
          },
        },
      ),
    ];
    const view = render(
      <StudioList list={{ rows, counts: COUNTS }} filter="all" />,
    );
    const [aurora, pantry] = within(
      screen.getByRole("list", { name: "Themes" }),
    ).getAllByRole("listitem");

    // The picture is the captured catalogue card, or a plain block.
    expect(aurora.querySelector("img")?.getAttribute("src")).toBe(
      "/api/theme-studio/images/p-aurora-card",
    );
    expect(pantry.querySelector("img")).toBeNull();
    expect(pantry.querySelector('[data-picture="none"]')).toBeTruthy();

    // The name opens the theme page.
    expect(
      within(aurora).getByRole("link", { name: "Aurora" }).getAttribute("href"),
    ).toBe("/dashboard/themes/studio/p-aurora");
    // The status words, in the readable badge.
    const badge = within(aurora).getByText("Needs your answer");
    expect(badge.className).toBe("studio-badge");
    expect(badge.getAttribute("data-tone")).toBe("warning");
    // The time: when it last changed, or how long the work has run.
    expect(within(aurora).getByText("12 min ago")).toBeTruthy();
    expect(within(pantry).getByText("34 min so far")).toBeTruthy();
    // The second line: the question count, or the step working now.
    expect(within(aurora).getByText("2 questions for you")).toBeTruthy();
    expect(within(pantry).getByText("Drawing pictures, 8 of 18")).toBeTruthy();
    // The main button opens the theme page with the action in the address.
    expect(
      within(aurora)
        .getByRole("link", { name: "Answer: Aurora" })
        .getAttribute("href"),
    ).toBe("/dashboard/themes/studio/p-aurora?do=answer");
    // No main button while it builds: the row itself opens the theme.
    expect(within(pantry).getAllByRole("link")).toHaveLength(1);

    const text = view.container.textContent ?? "";
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
  });

  it("never shows the model, the creator or a code", () => {
    const rows = [
      row(
        "p-1",
        "Aurora",
        status(19, "Not checked yet", {
          kind: "check_again",
          label: "Check again",
        }),
      ),
    ];
    const view = render(
      <StudioList list={{ rows, counts: COUNTS }} filter="all" />,
    );
    const text = view.container.textContent ?? "";
    expect(text).not.toMatch(/gemini|@storemink\.com|op@|aurora\b/);
    expect(text).not.toMatch(/\b(candidate|approved|blocked)\b/i);
  });

  it("the second line takes plain words, even from stored text with a long dash", () => {
    const rows = [
      row(
        "p-1",
        "Aurora",
        status(5, "Checking pictures", null, "info"),
        {
          activeStep: {
            key: "photo_check",
            label: "Checking pictures",
            state: "running",
            detail: `3${EN}5 left ${EM} Google is slow`,
            startedAt: NOW,
            finishedAt: null,
            nextTryAt: null,
          },
        },
        {
          working: {
            kind: "checking_pictures",
            step: null,
            since: NOW,
            lastProgressAt: NOW,
            nextTryAt: null,
          },
        },
      ),
    ];
    render(<StudioList list={{ rows, counts: COUNTS }} filter="all" />);
    expect(
      screen.getByText("Checking pictures, 3 to 5 left, Google is slow"),
    ).toBeTruthy();
  });
});

describe("the main button never acts by itself", () => {
  const target = { projectId: "p-1", themeId: "luxe" };

  it("opens the live demo store in a new tab", () => {
    const rows = [
      row(
        "p-1",
        "Luxe",
        status(
          1,
          "Live, v1.0.0",
          {
            kind: "open_live_demo",
            label: "Open live demo",
          },
          "success",
        ),
      ),
    ];
    render(<StudioList list={{ rows, counts: COUNTS }} filter="live" />);
    const demo = screen.getByRole("link", { name: /Open live demo/ });
    expect(demo.getAttribute("href")).toBe("https://demo-luxe.storemink.com");
    expect(demo.getAttribute("target")).toBe("_blank");
    expect(demo.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("opens New theme from this theme's brief, by its id only", () => {
    expect(
      rowActionTarget(target, {
        kind: "start_new_from_brief",
        label: "Start a new theme from this brief",
      }),
    ).toEqual({
      href: "/dashboard/themes/studio/new?from=p-1",
      label: "Start a new theme from this brief",
      external: false,
    });
  });

  it("carries every other action to the theme page as ?do=", () => {
    for (const kind of [
      "publish",
      "retry_publish",
      "stop_and_check_again",
      "describe_fix",
      "redraw",
      "continue_building",
      "check_again",
      "draw_missing_pictures",
      "retry_pictures",
      "retry_build",
      "start_building",
      "offer_again",
    ] as const) {
      expect(rowActionTarget(target, { kind, label: "x" })?.href).toBe(
        `/dashboard/themes/studio/p-1?do=${kind}`,
      );
    }
    expect(rowActionTarget(target, null)).toBeNull();
  });
});

describe("the list's words", () => {
  it("says no themes yet, with a way to make one", () => {
    render(
      <StudioList
        list={{
          rows: [],
          counts: {
            all: 0,
            needs_you: 0,
            building: 0,
            ready: 0,
            live: 0,
            archived: 0,
          },
        }}
        filter="all"
      />,
    );
    expect(screen.getByText("No themes yet")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /New theme/ }).getAttribute("href"),
    ).toBe("/dashboard/themes/studio/new");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("says when only the 100 most recent are shown", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row(`p-${i}`, `Theme ${i}`, status(18, "Not started", null)),
    );
    render(
      <StudioList
        list={{ rows, counts: { ...COUNTS, all: 140 } }}
        filter="all"
      />,
    );
    expect(
      screen.getByText("Showing the 100 most recently changed of 140."),
    ).toBeTruthy();
  });

  it("measures ages against the server's read time, in India time for dates", () => {
    expect(agoWords("2026-10-25T05:59:40.000Z", NOW)).toBe("Just now");
    expect(agoWords("2026-10-25T05:48:00.000Z", NOW)).toBe("12 min ago");
    expect(agoWords("2026-10-25T02:30:00.000Z", NOW)).toBe("3 h ago");
    expect(agoWords("2026-10-24T05:00:00.000Z", NOW)).toBe("1 day ago");
    expect(agoWords("2026-10-21T05:00:00.000Z", NOW)).toBe("4 days ago");
    // 30 Sep 20:00 UTC is 1 Oct in India.
    expect(agoWords("2026-09-30T20:00:00.000Z", NOW)).toBe("1 Oct");
    expect(agoWords("2025-10-01T06:00:00.000Z", NOW)).toBe("1 Oct 2025");
    expect(agoWords("not a date", NOW)).toBe("");
    // A clock a little ahead never reads as the future.
    expect(agoWords("2026-10-25T06:00:30.000Z", NOW)).toBe("Just now");
  });
});
