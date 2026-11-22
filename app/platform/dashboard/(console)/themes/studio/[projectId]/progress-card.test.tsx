// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  StudioStatusInput,
  ThemeStudioProgress,
  ThemeStudioProgressStep,
} from "@/lib/theme-studio/progress";
import type { StudioStatus } from "../studio-status";
import { ProgressCard } from "./progress-card";

// The progress card (plan section 4, "Theme page, building"): named rows with
// their times, a "next try" only when there is one, the build-time sentence,
// and the AI's plan.

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const NOW = "2026-10-25T05:00:00.000Z";

const facts: StudioStatusInput = {
  now: NOW,
  projectStatus: "generating",
  archivedAt: null,
  hasCurrentVersion: false,
  release: null,
  publishAttempt: null,
  working: {
    kind: "building",
    step: "Drawing pictures",
    since: "2026-10-25T04:34:00.000Z",
    lastProgressAt: "2026-10-25T04:59:00.000Z",
    nextTryAt: null,
  },
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

function step(
  key: ThemeStudioProgressStep["key"],
  label: string,
  state: ThemeStudioProgressStep["state"],
  extra: Partial<ThemeStudioProgressStep> = {},
): ThemeStudioProgressStep {
  return {
    key,
    label,
    state,
    detail: null,
    startedAt: null,
    finishedAt: null,
    nextTryAt: null,
    ...extra,
  };
}

const steps: ThemeStudioProgressStep[] = [
  step("brief", "Read the brief", "done", {
    startedAt: "2026-10-25T04:34:00.000Z",
    finishedAt: "2026-10-25T04:34:50.000Z",
  }),
  step("design", "Designed the pages", "done", {
    startedAt: "2026-10-25T04:34:50.000Z",
    finishedAt: "2026-10-25T04:38:29.000Z",
  }),
  step("layout_check", "Layout check", "done", {
    detail: `Fixed 2 problems ${EM} contrast`,
    startedAt: "2026-10-25T04:38:29.000Z",
    finishedAt: "2026-10-25T04:39:51.000Z",
  }),
  step("repair_1", "Fixing what the review found (round 1 of 3)", "done", {
    startedAt: "2026-10-25T04:40:00.000Z",
    finishedAt: "2026-10-25T04:41:00.000Z",
  }),
  step("pictures", "Drawing pictures", "running", {
    detail: "8 of 18. Google is accepting pictures slowly",
    startedAt: "2026-10-25T04:41:00.000Z",
    nextTryAt: "2026-10-25T05:01:00.000Z",
  }),
  step("final_check", "Catalogue pictures and final checks", "waiting"),
  step("design_review", "Design review", "waiting"),
];

function progress(
  overrides: Partial<ThemeStudioProgress> = {},
  status: Partial<StudioStatusInput> = {},
): ThemeStudioProgress {
  return {
    projectId: "p",
    revision: 3,
    versionIds: [],
    currentVersionId: null,
    status: { ...facts, ...status },
    steps,
    updatedAt: NOW,
    ...overrides,
  };
}

const building: StudioStatus = {
  row: 5,
  words: "Building: drawing pictures (26 min)",
  tone: "info",
  primary: null,
  secondary: [{ kind: "stop", label: "Stop" }],
};

afterEach(() => cleanup());

describe("the progress card", () => {
  it("names each step with its time, never a step number", () => {
    const view = render(
      <ProgressCard progress={progress()} status={building} plan={null} />,
    );
    const card = screen.getByRole("region", {
      name: "Theme Studio is building",
    });
    const rows = within(card).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "done",
      "done",
      "running",
      "waiting",
      "waiting",
    ]);
    expect(rows[0].textContent).toContain("Done: Read the brief");
    expect(rows[0].textContent).toContain("50 s");
    expect(rows[1].textContent).toContain("3 min 39 s");
    expect(rows[2].textContent).toContain("1 min 22 s");
    // A repair round is its own named row.
    expect(rows[3].textContent).toContain(
      "Fixing what the review found (round 1 of 3)",
    );
    expect(rows[4].textContent).toContain(
      "Working on it now: Drawing pictures",
    );
    expect(rows[4].textContent).toContain("8 of 18");
    expect(rows[5].textContent).toContain("Not started yet");
    expect(view.container.textContent).not.toMatch(/step \d+ of \d+/i);
  });

  it("shows a next try only on a step that waits for a set time", () => {
    render(
      <ProgressCard progress={progress()} status={building} plan={null} />,
    );
    const rows = screen.getAllByRole("listitem");
    // One sentence after another: the detail gets its full stop first.
    expect(rows[4].querySelector(".studio-step-detail")?.textContent).toBe(
      "8 of 18. Google is accepting pictures slowly. Next try at 10:31.",
    );
    expect(
      rows.filter((row) => /Next try/.test(row.textContent ?? "")),
    ).toHaveLength(1);
  });

  it("never doubles a detail's own full stop before the next try", () => {
    render(
      <ProgressCard
        progress={progress({
          steps: [
            step("pictures", "Drawing pictures", "running", {
              detail: "Waiting for the picture model.",
              startedAt: "2026-10-25T04:41:00.000Z",
              nextTryAt: "2026-10-25T05:01:00.000Z",
            }),
          ],
        })}
        status={building}
        plan={null}
      />,
    );
    expect(
      screen.getByRole("listitem").querySelector(".studio-step-detail")
        ?.textContent,
    ).toBe("Waiting for the picture model. Next try at 10:31.");
  });

  it("shows no time estimate and no leave-this-page line while it builds", () => {
    // Owner, 22 Nov 2026: the line "Usually 35 to 75 minutes. You can leave
    // this page. We'll let you know when it's ready." was removed.
    const view = render(
      <ProgressCard progress={progress()} status={building} plan={null} />,
    );
    const text = view.container.textContent ?? "";
    expect(text).not.toMatch(/Usually|leave this page|let you know/);
    expect(view.container.querySelector(".studio-progress-foot")).toBeNull();
    // The steps are still there.
    expect(text).toContain("Drawing pictures");
  });

  it("names a re-check", () => {
    render(
      <ProgressCard
        progress={progress(
          {},
          {
            working: { ...facts.working!, kind: "rechecking", step: null },
          },
        )}
        status={{ ...building, words: "Checking on today's StoreMink build" }}
        plan={null}
      />,
    );
    expect(
      screen.getByRole("region", {
        name: "Checking again on today's StoreMink build",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/About 3 to 5 minutes/)).toBeNull();
  });

  it("tells a screen reader the step working now in one short line", () => {
    render(
      <ProgressCard progress={progress()} status={building} plan={null} />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Working on: Drawing pictures",
    );
  });

  it("folds into a summary once the work finished well", () => {
    const done = steps.map((s) => ({
      ...s,
      state: "done" as const,
      startedAt: s.startedAt ?? NOW,
      finishedAt: s.finishedAt ?? NOW,
    }));
    const view = render(
      <ProgressCard
        progress={progress({ steps: done }, { working: null })}
        status={{
          row: 15,
          words: "Ready to publish",
          tone: "success",
          primary: { kind: "publish", label: "Publish" },
          secondary: [],
        }}
        plan={null}
      />,
    );
    const details = view.container.querySelector("details.studio-progress");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe(
      "What Theme Studio did last",
    );
    expect(screen.queryByText(/You can leave this page/)).toBeNull();
  });

  it("stays open on a stopped step and on stuck work", () => {
    const stopped = steps.map((s) =>
      s.key === "pictures" ? { ...s, state: "failed" as const } : s,
    );
    render(
      <ProgressCard
        progress={progress({ steps: stopped }, { working: null })}
        status={{
          row: 10,
          words: "Stopped",
          tone: "neutral",
          primary: null,
          secondary: [],
        }}
        plan={null}
      />,
    );
    expect(
      screen.getByRole("region", { name: "What Theme Studio did last" }),
    ).toBeTruthy();
    cleanup();
    render(
      <ProgressCard
        progress={progress()}
        status={{ ...building, row: 6, words: "Stuck since 10:20" }}
        plan={null}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Stuck since 10:20" }),
    ).toBeTruthy();
  });

  it("shows the AI's plan: its assumptions and what it left out", () => {
    render(
      <ProgressCard
        progress={progress({ steps: [] }, { working: null })}
        status={{ ...building, row: 19, words: "Not checked yet" }}
        plan={{
          assumptions: ["Ships across India", `Prices in 3${EN}5 tiers`],
          leftOut: ["A size quiz"],
        }}
      />,
    );
    expect(
      screen.getByText("Plan: 2 assumptions, 1 thing left out"),
    ).toBeTruthy();
    expect(screen.getByText("Prices in 3 to 5 tiers")).toBeTruthy();
    expect(
      screen.getByText("Left out, StoreMink can't show it yet: A size quiz"),
    ).toBeTruthy();
  });

  it("renders nothing when nothing was ever started", () => {
    const view = render(
      <ProgressCard
        progress={progress({ steps: [] }, { working: null })}
        status={{ ...building, row: 18, words: "Not started" }}
        plan={null}
      />,
    );
    expect(view.container.innerHTML).toBe("");
  });

  it("keeps long dashes out of stored step words", () => {
    const view = render(
      <ProgressCard progress={progress()} status={building} plan={null} />,
    );
    const text = view.container.textContent ?? "";
    expect(text.includes(EM) || text.includes(EN)).toBe(false);
    expect(text).toContain("Fixed 2 problems, contrast");
  });
});
