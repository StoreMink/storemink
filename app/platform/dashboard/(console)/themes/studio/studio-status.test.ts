import { describe, expect, it } from "vitest";
import type {
  StudioStatusChecks,
  StudioStatusInput,
  StudioStatusWorking,
} from "@/lib/theme-studio/progress";
import {
  STUDIO_ACTION_KINDS,
  STUDIO_ACTION_LABELS,
  STUDIO_BUILDING_KINDS,
  STUDIO_MENU_KINDS,
  STUDIO_RELEASE_ROWS,
  STUDIO_STUCK_MINUTES,
  isStudioMenuKind,
  studioListFilter,
  studioStatus,
  type StudioActionKind,
  type StudioStatus,
} from "./studio-status";
import { PUBLISH_ATTEMPT_MINUTES } from "./studio-ui";

// ---------------------------------------------------------------------------
// TS-2A: the one status function (plan section 4, "Status words"). A test
// per row of the 19, the 15-minute publish boundary, the 20-minute stuck
// rule, the traps the contract names (row 5 against 6, row 12 only for the
// checks, an unknown code never reaching "Describe a fix", a theme-change
// stop at row 14), the switches, the list filters, and the words: never a
// state name of the code's, never a long dash.
// ---------------------------------------------------------------------------

const NOW = "2026-10-25T10:00:00.000Z";
const at = (minutesAgo: number) =>
  new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

function checks(
  overrides: Partial<StudioStatusChecks> = {},
): StudioStatusChecks {
  return {
    versionId: "v1",
    checkRun: null,
    review: null,
    serious: 0,
    seriousStoreMink: 0,
    seriousPictures: 0,
    warnings: 0,
    allSeriousAreStoreMink: false,
    ...overrides,
  };
}

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
    checks: checks(),
    evidence: null,
    pictures: { missing: 0, lastRun: null },
    switches: { buildingOff: false, modelOff: false, checksOff: false },
    ...overrides,
  };
}

function working(
  overrides: Partial<StudioStatusWorking> = {},
): StudioStatusWorking {
  return {
    kind: "building",
    step: "Drawing pictures",
    since: at(26),
    lastProgressAt: at(1),
    nextTryAt: null,
    ...overrides,
  };
}

const kinds = (status: StudioStatus) => ({
  primary: status.primary?.kind ?? null,
  secondary: status.secondary.map((a) => a.kind),
});

describe("the 19 rows, first match wins", () => {
  it("1: live, offered or not, whatever the project's state", () => {
    const live = studioStatus(
      input({
        projectStatus: "archived",
        archivedAt: at(5),
        release: { version: "1.0.0", publishedAt: at(60), offered: true },
        working: working(),
      }),
    );
    expect(live).toMatchObject({
      row: 1,
      words: "Live, v1.0.0",
      tone: "success",
    });
    expect(kinds(live)).toEqual({
      primary: "open_live_demo",
      secondary: ["stop_offering", "start_new_from_brief", "delete"],
    });
    const hidden = studioStatus(
      input({
        release: { version: "1.2.0", publishedAt: at(60), offered: false },
      }),
    );
    expect(hidden).toMatchObject({
      row: 1,
      words: "Not offered to new stores",
      tone: "neutral",
    });
    expect(kinds(hidden).primary).toBe("offer_again");
    // Remove from list is never offered for a live theme.
    expect(kinds(live).secondary).not.toContain("remove_from_list");
    expect(kinds(hidden).secondary).not.toContain("remove_from_list");
  });

  it("2: publishing, while its last write is under 15 minutes old", () => {
    const publishing = (minutesAgo: number) =>
      studioStatus(
        input({
          projectStatus: "approved",
          publishAttempt: {
            state: "publishing",
            startedAt: at(minutesAgo + 1),
            lastWriteAt: at(minutesAgo),
            reasons: [],
          },
        }),
      );
    expect(PUBLISH_ATTEMPT_MINUTES).toBe(15);
    expect(publishing(14.99)).toMatchObject({
      row: 2,
      words: "Publishing",
      tone: "info",
      primary: null,
      secondary: [],
    });
    // The boundary: at 15 minutes the attempt is abandoned (row 3).
    expect(publishing(15).row).toBe(3);
    expect(publishing(15).words).toBe(
      "Publish didn't finish: it stopped answering",
    );
  });

  it("3: a publish that did not finish, with its first reason and Try again", () => {
    const failed = studioStatus(
      input({
        projectStatus: "approved",
        publishAttempt: {
          state: "failed",
          startedAt: at(30),
          lastWriteAt: at(29),
          reasons: ["The demo store's home page did not load.", "Second."],
        },
      }),
    );
    expect(failed).toMatchObject({
      row: 3,
      words: "Publish didn't finish: the demo store's home page did not load",
      tone: "warning",
    });
    expect(kinds(failed)).toEqual({
      primary: "retry_publish",
      secondary: ["remove_from_list", "delete"],
    });
    expect(studioStatus(input({ projectStatus: "approved" })).words).toBe(
      "Publish didn't finish",
    );
  });

  it("4: removed from the list, Delete in the menu only", () => {
    const removed = studioStatus(
      input({ projectStatus: "archived", archivedAt: at(10) }),
    );
    expect(removed).toMatchObject({
      row: 4,
      words: "Removed from list",
      tone: "neutral",
      primary: null,
    });
    expect(kinds(removed).secondary).toEqual(["delete"]);
  });

  it("5: working, in words for each kind of work, Stop in the menu", () => {
    const words = (w: Partial<StudioStatusWorking>) =>
      studioStatus(input({ projectStatus: "generating", working: working(w) }));
    expect(words({})).toMatchObject({
      row: 5,
      words: "Building: drawing pictures (26 min)",
      tone: "info",
      primary: null,
    });
    expect(kinds(words({})).secondary).toEqual(["stop"]);
    expect(
      words({ kind: "waiting", since: "2026-10-25T04:35:00.000Z" }).words,
    ).toBe("Waiting to start (since 10:05)");
    expect(words({ kind: "rechecking" }).words).toBe(
      "Checking on today's StoreMink build",
    );
    expect(words({ kind: "checking_pictures" }).words).toBe(
      "Checking pictures",
    );
    expect(words({ kind: "checking_change" }).words).toBe(
      "Checking your change",
    );
    expect(words({ step: null, since: at(3.5) }).words).toBe(
      "Building (3 min 30 s)",
    );
    expect(
      words({ step: "Fixing what the review found (round 2 of 3)" }).words,
    ).toBe("Building: fixing what the review found (round 2 of 3) (26 min)");
  });

  it("6: stuck, after 20 quiet minutes with no wait pending (row 5 must not hide it)", () => {
    expect(STUDIO_STUCK_MINUTES).toBe(20);
    const quiet = (minutes: number, nextTryAt: string | null = null) =>
      studioStatus(
        input({
          projectStatus: "generating",
          working: working({
            lastProgressAt: "2026-10-25T05:10:00.000Z",
            nextTryAt,
          }),
          now: new Date(
            Date.parse("2026-10-25T05:10:00.000Z") + minutes * 60_000,
          ).toISOString(),
        }),
      );
    expect(quiet(19.99).row).toBe(5);
    const stuck = quiet(20);
    expect(stuck).toMatchObject({
      row: 6,
      words: "Stuck since 10:40",
      tone: "warning",
    });
    expect(kinds(stuck)).toEqual({
      primary: "stop_and_check_again",
      secondary: ["stop"],
    });
    // A real next try in the future is waiting, not stuck; a past one is not.
    const nowAt = new Date(
      Date.parse("2026-10-25T05:10:00.000Z") + 30 * 60_000,
    );
    expect(
      quiet(30, new Date(nowAt.getTime() + 60_000).toISOString()).row,
    ).toBe(5);
    expect(
      quiet(30, new Date(nowAt.getTime() - 60_000).toISOString()).row,
    ).toBe(6);
    // With no design yet there is nothing to check again: Stop stays in the menu.
    const first = studioStatus(
      input({
        projectStatus: "generating",
        hasCurrentVersion: false,
        checks: null,
        working: working({ lastProgressAt: at(45) }),
      }),
    );
    expect(first.row).toBe(6);
    expect(kinds(first)).toEqual({ primary: null, secondary: ["stop"] });
  });

  it("7: the AI asked questions", () => {
    const asked = studioStatus(
      input({
        projectStatus: "blocked",
        questions: {
          open: true,
          count: 2,
          askedAt: at(12),
          rounds: 1,
          tooManyRounds: false,
        },
      }),
    );
    expect(asked).toMatchObject({
      row: 7,
      words: "Needs your answer",
      tone: "warning",
    });
    expect(kinds(asked).primary).toBe("answer");
  });

  it("8: too many rounds of questions", () => {
    const tooMany = studioStatus(
      input({
        projectStatus: "blocked",
        questions: {
          open: true,
          count: 1,
          askedAt: at(2),
          rounds: 20,
          tooManyRounds: true,
        },
      }),
    );
    expect(tooMany).toMatchObject({
      row: 8,
      words: "Needs a new start: too many questions",
      tone: "warning",
    });
    expect(kinds(tooMany).primary).toBe("start_new_from_brief");
  });

  it("9: blocked with no questions open is a security problem", () => {
    const security = studioStatus(input({ projectStatus: "blocked" }));
    expect(security).toMatchObject({
      row: 9,
      words: "Can't publish: security problem",
      tone: "danger",
    });
    expect(kinds(security).primary).toBe("describe_fix");
  });

  it("10: stopped by the operator: Continue building a step, Check again a check", () => {
    const run = studioStatus(
      input({
        stop: { kind: "run", code: "cancelled", at: at(3), runId: "r1" },
      }),
    );
    expect(run).toMatchObject({ row: 10, words: "Stopped", tone: "neutral" });
    expect(kinds(run).primary).toBe("continue_building");
    const review = studioStatus(
      input({
        stop: { kind: "review", code: "cancelled", at: at(3), runId: null },
      }),
    );
    expect(kinds(review).primary).toBe("check_again");
    const capture = studioStatus(
      input({
        stop: { kind: "capture", code: "cancelled", at: at(3), runId: null },
      }),
    );
    expect(kinds(capture).primary).toBe("check_again");
    // A stopped first build: no design to check, the step to continue.
    const first = studioStatus(
      input({
        projectStatus: "failed",
        hasCurrentVersion: false,
        checks: null,
        stop: { kind: "run", code: "cancelled", at: at(3), runId: "r1" },
      }),
    );
    expect(first.row).toBe(10);
    expect(kinds(first).primary).toBe("continue_building");
  });

  it("11: every serious finding is StoreMink's (or a StoreMink-fix stop)", () => {
    const ours = studioStatus(
      input({
        checks: checks({
          serious: 2,
          seriousStoreMink: 2,
          allSeriousAreStoreMink: true,
        }),
      }),
    );
    expect(ours).toMatchObject({
      row: 11,
      words: "Needs a StoreMink fix",
      tone: "warning",
      primary: null,
    });
    expect(kinds(ours).secondary).toEqual([
      "copy_details",
      "remove_from_list",
      "delete",
    ]);
    expect(
      studioStatus(
        input({
          stop: {
            kind: "review",
            code: "renderer_fix_required",
            at: at(4),
            runId: null,
          },
        }),
      ).row,
    ).toBe(11);
  });

  it("12: the checks could not finish, with a plain reason and Check again", () => {
    const couldNot = studioStatus(
      input({
        stop: {
          kind: "review",
          code: "checks_incomplete",
          at: at(4),
          runId: null,
        },
        checks: checks({ serious: 3 }),
      }),
    );
    expect(couldNot).toMatchObject({
      row: 12,
      words:
        "Couldn't finish the checks: the checks could not finish, so the theme was not judged",
      tone: "warning",
    });
    expect(kinds(couldNot).primary).toBe("check_again");
    expect(
      studioStatus(
        input({
          stop: {
            kind: "capture",
            code: "capture_timeout",
            at: at(4),
            runId: null,
          },
        }),
      ).words,
    ).toBe("Couldn't finish the checks: the capture took too long");
  });

  it("an unknown stop code falls to row 12, never to Describe a fix", () => {
    for (const kind of ["capture", "review"] as const) {
      const unknown = studioStatus(
        input({
          stop: { kind, code: "brand_new_code", at: at(4), runId: null },
          checks: checks({ serious: 4 }),
        }),
      );
      expect(unknown.row).toBe(12);
      expect(kinds(unknown).primary).toBe("check_again");
      expect(kinds(unknown).secondary).not.toContain("describe_fix");
    }
    // A build step's unknown code, once the theme has a design, likewise.
    const run = studioStatus(
      input({
        stop: { kind: "run", code: "brand_new_code", at: at(4), runId: "r1" },
        checks: checks({ serious: 4 }),
      }),
    );
    expect(run.row).toBe(12);
    expect(run.words).toBe("Couldn't finish the checks: this step stopped");
  });

  it("row 12 never takes a failed first build (row 17) or a theme-change stop (row 14)", () => {
    const firstBuild = studioStatus(
      input({
        projectStatus: "failed",
        hasCurrentVersion: false,
        checks: null,
        stop: { kind: "run", code: "brand_new_code", at: at(4), runId: "r1" },
      }),
    );
    expect(firstBuild.row).toBe(17);
    // Even were a failed theme to keep a design, a build step's stop is row 17.
    expect(
      studioStatus(
        input({
          projectStatus: "failed",
          stop: { kind: "run", code: "brand_new_code", at: at(4), runId: "r1" },
        }),
      ).row,
    ).toBe(17);
    for (const code of [
      "quality_bar_not_met",
      "qa_no_progress",
      "repair_not_supported",
    ]) {
      const themeChange = studioStatus(
        input({ stop: { kind: "review", code, at: at(4), runId: null } }),
      );
      expect(themeChange.row, code).toBe(14);
      expect(kinds(themeChange).primary).toBe("describe_fix");
    }
    // A known build-step code is not row 12 either: the rows below decide.
    expect(
      studioStatus(
        input({
          stop: { kind: "run", code: "images_none", at: at(4), runId: "r1" },
          pictures: { missing: 3, lastRun: null },
        }),
      ).row,
    ).toBe(13);
  });

  it("13: pictures missing, or the last picture run failed", () => {
    const missing = studioStatus(
      input({ pictures: { missing: 3, lastRun: null } }),
    );
    expect(missing).toMatchObject({
      row: 13,
      words: "Pictures missing (3)",
      tone: "warning",
    });
    expect(kinds(missing).primary).toBe("draw_missing_pictures");
    const failedRun = {
      id: "img1",
      state: "failed" as const,
      errorCode: "images_none",
      finishedAt: at(5),
    };
    const retry = studioStatus(
      input({ pictures: { missing: 3, lastRun: failedRun } }),
    );
    expect(kinds(retry).primary).toBe("retry_pictures");
    const redrawFailed = studioStatus(
      input({ pictures: { missing: 0, lastRun: failedRun } }),
    );
    expect(redrawFailed).toMatchObject({
      row: 13,
      words: "Drawing pictures didn't finish",
    });
    expect(kinds(redrawFailed).primary).toBe("retry_pictures");
  });

  it("14: serious findings left: Describe a fix, or Redraw when they are pictures", () => {
    const fix = studioStatus(input({ checks: checks({ serious: 2 }) }));
    expect(fix).toMatchObject({
      row: 14,
      words: "Needs a fix (2 problems)",
      tone: "danger",
    });
    expect(kinds(fix)).toEqual({
      primary: "describe_fix",
      secondary: ["remove_from_list", "delete"],
    });
    expect(studioStatus(input({ checks: checks({ serious: 1 }) })).words).toBe(
      "Needs a fix (1 problem)",
    );
    // Every serious finding that is not StoreMink's is a picture one.
    const pictures = studioStatus(
      input({
        checks: checks({ serious: 3, seriousStoreMink: 1, seriousPictures: 2 }),
      }),
    );
    expect(kinds(pictures)).toEqual({
      primary: "redraw",
      secondary: ["describe_fix", "remove_from_list", "delete"],
    });
    // Some are pictures, some are not: Describe a fix first, Redraw beside it.
    const mixed = studioStatus(
      input({ checks: checks({ serious: 3, seriousPictures: 1 }) }),
    );
    expect(kinds(mixed)).toEqual({
      primary: "describe_fix",
      secondary: ["redraw", "remove_from_list", "delete"],
    });
  });

  it("15: Ready to publish on today's evidence, with its warnings", () => {
    const ready = studioStatus(
      input({
        projectStatus: "candidate",
        evidence: { ok: true, acceptanceRunId: "a1" },
        checks: checks({ warnings: 2 }),
      }),
    );
    expect(ready).toMatchObject({
      row: 15,
      words: "Ready to publish, 2 warnings",
      tone: "success",
    });
    expect(kinds(ready).primary).toBe("publish");
    expect(
      studioStatus(
        input({
          projectStatus: "candidate",
          evidence: { ok: true, acceptanceRunId: "a1" },
        }),
      ).words,
    ).toBe("Ready to publish");
    expect(
      studioStatus(
        input({
          projectStatus: "candidate",
          evidence: { ok: true, acceptanceRunId: "a1" },
          checks: checks({ warnings: 1 }),
        }),
      ).words,
    ).toBe("Ready to publish, 1 warning");
  });

  it("16: Ready to publish, but its evidence is not today's: Publish offers the re-check", () => {
    const updated = studioStatus(
      input({
        projectStatus: "candidate",
        evidence: { ok: false, reason: "old_build" },
      }),
    );
    expect(updated).toMatchObject({
      row: 16,
      words: "Ready to publish (StoreMink was updated)",
      tone: "success",
    });
    expect(kinds(updated).primary).toBe("publish");
    expect(
      studioStatus(
        input({
          projectStatus: "candidate",
          evidence: { ok: false, reason: "no_review" },
        }),
      ).words,
    ).toBe("Ready to publish (needs a quick re-check)");
    // Not read (null): the safe row, Publish re-checks first.
    expect(studioStatus(input({ projectStatus: "candidate" })).row).toBe(16);
  });

  it("17: a first build that failed: Try again, or a new theme for a declined brief", () => {
    const failed = studioStatus(
      input({
        projectStatus: "failed",
        hasCurrentVersion: false,
        checks: null,
        stop: { kind: "run", code: "run_timeout", at: at(4), runId: "r1" },
      }),
    );
    expect(failed).toMatchObject({
      row: 17,
      words: "Couldn't finish: the step ran out of time",
      tone: "danger",
    });
    expect(kinds(failed).primary).toBe("retry_build");
    for (const code of ["model_declined", "model_refused"]) {
      const declined = studioStatus(
        input({
          projectStatus: "failed",
          hasCurrentVersion: false,
          checks: null,
          stop: { kind: "run", code, at: at(4), runId: "r1" },
        }),
      );
      expect(kinds(declined).primary, code).toBe("start_new_from_brief");
    }
    expect(
      studioStatus(
        input({
          projectStatus: "failed",
          hasCurrentVersion: false,
          checks: null,
        }),
      ),
    ).toMatchObject({ row: 17, words: "Couldn't finish", primary: null });
  });

  it("18: not started", () => {
    const draft = studioStatus(
      input({ projectStatus: "draft", hasCurrentVersion: false, checks: null }),
    );
    expect(draft).toMatchObject({
      row: 18,
      words: "Not started",
      tone: "neutral",
    });
    expect(kinds(draft).primary).toBe("start_building");
  });

  it("19: anything else: not checked yet, or not on today's build", () => {
    const fresh = studioStatus(input());
    expect(fresh).toMatchObject({
      row: 19,
      words: "Not checked yet",
      tone: "neutral",
    });
    expect(kinds(fresh).primary).toBe("check_again");
    expect(
      studioStatus(input({ evidence: { ok: false, reason: "old_build" } }))
        .words,
    ).toBe("Not checked on today's build");
    // A design that passed on today's build is never "not checked": only a
    // check marks the theme Ready to publish again.
    const passed = studioStatus(
      input({ evidence: { ok: true, acceptanceRunId: "a" } }),
    );
    expect(passed).toMatchObject({
      row: 19,
      words: "Checked on today's build; check it again to publish",
    });
    expect(kinds(passed).primary).toBe("check_again");
    expect(
      studioStatus(
        input({
          projectStatus: "published",
          hasCurrentVersion: false,
          checks: null,
        }),
      ).primary,
    ).toBeNull();
  });

  it("19: a change that stopped for a known reason says so, with Try again and Check again", () => {
    for (const code of [
      "provider_unavailable",
      "provider_timeout",
      "rate_limited",
      "invalid_output",
      "run_timeout",
    ]) {
      for (const evidence of [
        { ok: true as const, acceptanceRunId: "a" },
        { ok: false as const, reason: "old_build" as const },
        null,
      ]) {
        const stopped = studioStatus(
          input({
            evidence,
            stop: { kind: "run", code, at: at(3), runId: "r9" },
          }),
        );
        expect(stopped.row, code).toBe(19);
        expect(stopped.words, code).toMatch(/^Your change didn't finish: /);
        expect(stopped.words, code).not.toMatch(/Not checked/);
        expect(stopped.tone).toBe("warning");
        expect(kinds(stopped), code).toEqual({
          primary: "retry_build",
          secondary: ["check_again", "remove_from_list", "delete"],
        });
      }
    }
    expect(
      studioStatus(
        input({
          stop: {
            kind: "run",
            code: "provider_timeout",
            at: at(3),
            runId: "r9",
          },
        }),
      ).words,
    ).toBe(
      "Your change didn't finish: the model provider took too long to answer",
    );
    // A declined change is not tried again as it was: Check again brings the
    // design it kept back to Ready to publish.
    for (const code of ["model_declined", "model_refused"]) {
      const declined = studioStatus(
        input({ stop: { kind: "run", code, at: at(3), runId: "r9" } }),
      );
      expect(declined.row, code).toBe(19);
      expect(kinds(declined), code).toEqual({
        primary: "check_again",
        secondary: ["remove_from_list", "delete"],
      });
    }
    // With building switched off, Try again is not offered; Check again is.
    const off = studioStatus(
      input({
        stop: { kind: "run", code: "provider_error", at: at(3), runId: "r9" },
        switches: { buildingOff: true, modelOff: false, checksOff: false },
      }),
    );
    expect(off.primary).toBeNull();
    expect(off.words).toMatch(/, building is switched off$/);
    expect(kinds(off).secondary).toEqual([
      "check_again",
      "remove_from_list",
      "delete",
    ]);
  });
});

describe("switched off", () => {
  it("says building is off where the main button builds, and offers no main button", () => {
    const off = { buildingOff: true, modelOff: false, checksOff: false };
    const draft = studioStatus(
      input({
        projectStatus: "draft",
        hasCurrentVersion: false,
        checks: null,
        switches: off,
      }),
    );
    expect(draft).toMatchObject({
      row: 18,
      words: "Not started, building is switched off",
      primary: null,
    });
    const asked = studioStatus(
      input({
        projectStatus: "blocked",
        questions: {
          open: true,
          count: 1,
          askedAt: at(1),
          rounds: 1,
          tooManyRounds: false,
        },
        switches: off,
      }),
    );
    expect(asked).toMatchObject({
      words: "Needs your answer, building is switched off",
      primary: null,
    });
    // Every building action leaves the secondary list too.
    const pictures = studioStatus(
      input({
        checks: checks({ serious: 2, seriousPictures: 1 }),
        switches: off,
      }),
    );
    expect(pictures.primary).toBeNull();
    expect(kinds(pictures).secondary).toEqual(["remove_from_list", "delete"]);
    // The model's own switch turns off what runs that model, not pictures.
    const model = { buildingOff: false, modelOff: true, checksOff: false };
    expect(
      studioStatus(input({ projectStatus: "blocked", switches: model })).words,
    ).toBe("Can't publish: security problem, this model is switched off");
    expect(
      kinds(
        studioStatus(
          input({ pictures: { missing: 2, lastRun: null }, switches: model }),
        ),
      ).primary,
    ).toBe("draw_missing_pictures");
  });

  it("says the automatic checks are off where the main button checks again", () => {
    const off = { buildingOff: false, modelOff: false, checksOff: true };
    expect(studioStatus(input({ switches: off }))).toMatchObject({
      row: 19,
      words: "Not checked yet, automatic checks are switched off",
      primary: null,
    });
    expect(
      studioStatus(
        input({
          projectStatus: "candidate",
          evidence: { ok: false, reason: "old_build" },
          switches: off,
        }),
      ),
    ).toMatchObject({
      row: 16,
      words:
        "Ready to publish (StoreMink was updated), automatic checks are switched off",
      primary: null,
    });
    // Ready to publish on today's evidence still publishes.
    expect(
      studioStatus(
        input({
          projectStatus: "candidate",
          evidence: { ok: true, acceptanceRunId: "a" },
          switches: off,
        }),
      ).primary?.kind,
    ).toBe("publish");
    expect(
      studioStatus(
        input({
          projectStatus: "generating",
          working: working({ lastProgressAt: at(30) }),
          switches: off,
        }),
      ),
    ).toMatchObject({
      row: 6,
      words: "Stuck since 15:00, automatic checks are switched off",
      primary: null,
    });
  });
});

describe("list filters", () => {
  it("puts every row in exactly one filter besides all", () => {
    const expected: Record<number, string> = {
      1: "live",
      2: "building",
      5: "building",
      15: "ready",
      16: "ready",
      4: "archived",
    };
    for (let row = 1; row <= 19; row += 1)
      expect(studioListFilter({ row }), String(row)).toBe(
        expected[row] ?? "needs_you",
      );
  });
});

describe("words and actions", () => {
  /** Inputs across every row and switch, for the checks below. */
  function every(): StudioStatusInput[] {
    const stops = [
      null,
      { kind: "run" as const, code: "cancelled", at: at(1), runId: "r" },
      {
        kind: "review" as const,
        code: "checks_incomplete",
        at: at(1),
        runId: null,
      },
      {
        kind: "review" as const,
        code: "quality_bar_not_met",
        at: at(1),
        runId: null,
      },
      { kind: "capture" as const, code: "x_unknown", at: at(1), runId: null },
      { kind: "run" as const, code: "model_declined", at: at(1), runId: "r" },
    ];
    const out: StudioStatusInput[] = [];
    const states = [
      "draft",
      "generating",
      "ready",
      "candidate",
      "approved",
      "published",
      "failed",
      "blocked",
      "archived",
    ] as const;
    for (const projectStatus of states)
      for (const stop of stops)
        for (const switches of [
          { buildingOff: false, modelOff: false, checksOff: false },
          { buildingOff: true, modelOff: true, checksOff: true },
        ])
          for (const extra of [
            {},
            { working: working() },
            { working: working({ lastProgressAt: at(50) }) },
            { checks: checks({ serious: 2, warnings: 3, seriousPictures: 1 }) },
            { pictures: { missing: 2, lastRun: null } },
            { evidence: { ok: true as const, acceptanceRunId: "a" } },
            { evidence: { ok: false as const, reason: "old_build" as const } },
            {
              publishAttempt: {
                state: "publishing" as const,
                startedAt: at(2),
                lastWriteAt: at(1),
                reasons: [],
              },
            },
            {
              questions: {
                open: true,
                count: 2,
                askedAt: at(3),
                rounds: 1,
                tooManyRounds: false,
              },
            },
            {
              release: { version: "1.0.0", publishedAt: at(9), offered: true },
            },
          ])
            out.push(input({ projectStatus, stop, switches, ...extra }));
    return out;
  }

  it("never shows the code's state names; Ready only as Ready to publish", () => {
    for (const facts of every()) {
      const status = studioStatus(facts);
      const shown = [
        status.words,
        status.primary?.label ?? "",
        ...status.secondary.map((a) => a.label),
      ];
      for (const text of shown) {
        expect(text).not.toMatch(/candidate|approved|blocked/i);
        expect(text.replace(/Ready to publish/g, "")).not.toMatch(/\bready\b/i);
        expect(text.includes(EM) || text.includes(EN), text).toBe(false);
        expect(text).not.toMatch(/credit/i);
      }
      expect(status.row).toBeGreaterThanOrEqual(1);
      expect(status.row).toBeLessThanOrEqual(19);
    }
  });

  it("offers only known actions, each once, menu kinds after the buttons", () => {
    for (const facts of every()) {
      const status = studioStatus(facts);
      const all = [
        status.primary?.kind,
        ...status.secondary.map((a) => a.kind),
      ].filter((k): k is StudioActionKind => !!k);
      for (const kind of all) expect(STUDIO_ACTION_KINDS).toContain(kind);
      expect(new Set(all).size).toBe(all.length);
      const firstMenu = status.secondary.findIndex((a) =>
        isStudioMenuKind(a.kind),
      );
      if (firstMenu >= 0)
        expect(
          status.secondary
            .slice(firstMenu)
            .every((a) => isStudioMenuKind(a.kind)),
        ).toBe(true);
      if (facts.switches.buildingOff)
        for (const kind of all)
          expect(STUDIO_BUILDING_KINDS).not.toContain(kind);
    }
  });

  it("labels every action in plain words", () => {
    for (const kind of STUDIO_ACTION_KINDS) {
      expect(STUDIO_ACTION_LABELS[kind]).toBeTruthy();
      expect(STUDIO_ACTION_LABELS[kind]).not.toMatch(/_/);
    }
    expect(STUDIO_MENU_KINDS).toEqual(["stop", "remove_from_list", "delete"]);
    expect(STUDIO_RELEASE_ROWS).toEqual([1, 2, 3, 15, 16]);
    expect(STUDIO_ACTION_LABELS.remove_from_list).toBe(
      "Remove from list (keeps its history)",
    );
  });
});
