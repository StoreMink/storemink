import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ThemeStudioProjectState } from "@/lib/theme-studio/contracts";
import {
  PUBLISH_ATTEMPT_MINUTES,
  STOP_CODES,
  STUDIO_TONE,
  activityActor,
  activityLine,
  checksOutcome,
  currentChecksFailed,
  isCheckingWork,
  plainText,
  publishRunningFromEvents,
  questionsOpen,
  stopNeedsThemeChange,
  stoppedNextStep,
  stopText,
  STUDIO_WORK_STARTERS,
  StudioBadge,
  StudioStatusBadge,
  studioStatusLabel,
  studioStatusTone,
  warningPlace,
  warningWords,
  workUnderway,
  workingText,
  type StopKind,
  type StudioWork,
} from "./studio-ui";

// ---------------------------------------------------------------------------
// TS-1F: the plain words of today's Studio screens. Every stop code gets a
// sentence, Activity says what happened (never the old approval lines), a
// failed publish reads "Publish didn't finish", and no word on screen
// carries an em dash or an en dash.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, "../../../../../..");
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const NOW = Date.parse("2026-10-24T10:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

type Event = {
  eventType: string;
  actorKind: "operator" | "worker";
  actorEmail?: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
  runId?: string | null;
};
const event = (
  eventType: string,
  minutesAgo: number,
  detail: Record<string, unknown> = {},
  extra: Partial<Event> = {},
): Event => ({
  eventType,
  actorKind: "operator",
  actorEmail: "op@storemink.com",
  createdAt: ago(minutesAgo),
  detail,
  ...extra,
});

function noLongDash(text: string) {
  expect(text.includes(EM), text).toBe(false);
  expect(text.includes(EN), text).toBe(false);
}

const STATES: ThemeStudioProjectState[] = [
  "draft",
  "generating",
  "ready",
  "candidate",
  "approved",
  "published",
  "failed",
  "blocked",
  "archived",
];

describe("status words", () => {
  it("never shows the code's names for a state (Ready to publish is the one Ready)", () => {
    for (const status of STATES) {
      for (const context of [
        {},
        { qaFailed: true },
        { publishing: true },
        { checking: true },
        { questionsOpen: true },
        { questionsOpen: false },
      ]) {
        const label = studioStatusLabel(status, context);
        expect(label).not.toMatch(/candidate|approved|blocked/i);
        expect(label.replace(/Ready to publish/g, "")).not.toMatch(/ready/i);
        noLongDash(label);
        expect(studioStatusTone(status, context)).toMatch(
          /^(neutral|info|success|warning|danger)$/,
        );
      }
    }
    expect(studioStatusLabel("candidate")).toBe("Ready to publish");
  });

  it("no longer says Blocked: a question for you and a security problem read apart", () => {
    expect(studioStatusLabel("blocked", { questionsOpen: true })).toBe(
      "Needs your answer",
    );
    expect(studioStatusTone("blocked", { questionsOpen: true })).toBe(
      "warning",
    );
    expect(studioStatusLabel("blocked", { questionsOpen: false })).toBe(
      "Can't publish: security problem",
    );
    expect(studioStatusTone("blocked", { questionsOpen: false })).toBe(
      "danger",
    );
    // Not knowing which, it says what both mean.
    expect(studioStatusLabel("blocked")).toBe("Needs you");
  });

  it("uses studioStatus's words for the other states", () => {
    expect(studioStatusLabel("draft")).toBe("Not started");
    expect(studioStatusLabel("published")).toBe("Live");
    expect(studioStatusLabel("failed")).toBe("Couldn't finish");
    expect(studioStatusLabel("archived")).toBe("Removed from list");
    expect(studioStatusTone("failed")).toBe("danger");
    expect(studioStatusTone("candidate")).toBe("success");
    expect(studioStatusTone("approved")).toBe("warning");
    expect(studioStatusTone("approved", { publishing: true })).toBe("info");
    expect(studioStatusTone("ready", { qaFailed: true })).toBe("danger");
  });

  it('reads "Publish didn\'t finish" for a publish attempt that is not running', () => {
    expect(studioStatusLabel("approved")).toBe("Publish didn't finish");
    expect(studioStatusLabel("approved", { publishing: false })).toBe(
      "Publish didn't finish",
    );
    expect(studioStatusLabel("approved", { publishing: true })).toBe(
      "Publishing",
    );
  });

  it("says Needs attention only for a ready theme whose checks stopped", () => {
    expect(studioStatusLabel("ready")).toBe("Needs checks");
    expect(studioStatusLabel("ready", { qaFailed: true })).toBe(
      "Needs attention",
    );
    expect(studioStatusLabel("candidate", { qaFailed: true })).toBe(
      "Ready to publish",
    );
  });

  it("says Checking for a theme whose design is being checked, not built", () => {
    expect(studioStatusLabel("generating")).toBe("Building");
    expect(studioStatusLabel("generating", { checking: true })).toBe(
      "Checking",
    );
    expect(studioStatusLabel("ready", { checking: true })).toBe("Needs checks");
  });
});

describe("publishRunningFromEvents", () => {
  it("is running only while the newest publish event is a start younger than the server's limit", () => {
    expect(PUBLISH_ATTEMPT_MINUTES).toBe(15);
    expect(
      publishRunningFromEvents([event("publication_started", 2)], NOW),
    ).toBe(true);
    expect(
      publishRunningFromEvents([event("publication_started", 14.9)], NOW),
    ).toBe(true);
    expect(
      publishRunningFromEvents([event("publication_started", 15)], NOW),
    ).toBe(false);
    expect(
      publishRunningFromEvents([event("publication_started", 40)], NOW),
    ).toBe(false);
  });

  it("is not running once the attempt failed or published, whatever the order the events arrive in", () => {
    const failed = [
      event("publication_started", 3),
      event("publication_failed", 2),
    ];
    expect(publishRunningFromEvents(failed, NOW)).toBe(false);
    expect(publishRunningFromEvents([...failed].reverse(), NOW)).toBe(false);
    expect(
      publishRunningFromEvents(
        [event("publication_started", 3), event("theme_published", 1)],
        NOW,
      ),
    ).toBe(false);
    // A new attempt after an older failure is running.
    expect(
      publishRunningFromEvents(
        [event("publication_failed", 30), event("publication_started", 1)],
        NOW,
      ),
    ).toBe(true);
    expect(publishRunningFromEvents([], NOW)).toBe(false);
    // Other events never count.
    expect(
      publishRunningFromEvents(
        [event("publication_started", 5), event("capture_requested", 1)],
        NOW,
      ),
    ).toBe(true);
  });
});

describe("questionsOpen (the client copy of the server rule)", () => {
  const clarify = {
    status: "succeeded" as const,
    questions: ["Which header?"],
    createdAt: ago(20),
    finishedAt: ago(18),
  };

  it("is open while the newest run is a finished clarification", () => {
    expect(questionsOpen({ runs: [clarify], events: [] })).toBe(true);
  });

  it("is closed once a version was made current at or after the questions", () => {
    expect(
      questionsOpen({
        runs: [clarify],
        events: [event("version_restored", 10)],
      }),
    ).toBe(false);
    expect(
      questionsOpen({
        runs: [clarify],
        events: [event("version_restored", 18)],
      }),
    ).toBe(false);
    // One made current before the questions does not set them aside.
    expect(
      questionsOpen({
        runs: [clarify],
        events: [event("version_restored", 30)],
      }),
    ).toBe(true);
  });

  it("is closed when the newest run asked nothing or did not succeed", () => {
    const newer = {
      status: "succeeded" as const,
      questions: [],
      createdAt: ago(5),
      finishedAt: ago(4),
    };
    expect(questionsOpen({ runs: [newer, clarify], events: [] })).toBe(false);
    expect(questionsOpen({ runs: [clarify, newer], events: [] })).toBe(false);
    expect(
      questionsOpen({
        runs: [{ ...clarify, status: "failed" as const }],
        events: [],
      }),
    ).toBe(false);
    expect(questionsOpen({ runs: [], events: [] })).toBe(false);
  });
});

describe("workUnderway", () => {
  const generating = (events: Event[]) =>
    workUnderway({ status: "generating", events });

  it("is nothing unless the theme is generating", () => {
    expect(
      workUnderway({
        status: "ready",
        events: [event("capture_requested", 1, { recheck: "publish_recheck" })],
      }),
    ).toBeNull();
  });

  it("names the re-check before Publish and Check again", () => {
    expect(
      generating([
        event("capture_requested", 1, { recheck: "publish_recheck" }),
      ]),
    ).toBe("publish_recheck");
    expect(
      generating([event("capture_requested", 1, { recheck: "check_again" })]),
    ).toBe("check_again");
    expect(generating([event("capture_requested", 1)])).toBe("capturing");
  });

  it("names Make current and saved pictures that are being checked", () => {
    expect(
      generating([event("version_restored", 1, { outcome: "rechecking" })]),
    ).toBe("check_again");
    expect(
      generating([event("version_restored", 1, { outcome: "checking" })]),
    ).toBe("checking_version");
    expect(
      generating([event("slot_images_replaced", 1, { automaticQa: true })]),
    ).toBe("checking_pictures");
    expect(
      generating([event("slot_images_replaced", 1, { automaticQa: false })]),
    ).toBe("building");
  });

  it("follows the newest work an operator started, never the worker's own steps", () => {
    expect(
      generating([
        event("capture_requested", 3, { recheck: "publish_recheck" }),
        // A deploy during the re-check: the worker captures again.
        event(
          "capture_requested",
          1,
          { reason: "acceptance_build_changed" },
          { actorKind: "worker", actorEmail: null },
        ),
      ]),
    ).toBe("publish_recheck");
    expect(
      generating([
        event("capture_requested", 30, { recheck: "check_again" }),
        event("revision_requested", 2),
      ]),
    ).toBe("building");
    expect(generating([])).toBe("building");
  });

  it("has words for every kind of work, and only checks count as checking", () => {
    const all: StudioWork[] = [
      "publish_recheck",
      "check_again",
      "checking_version",
      "checking_pictures",
      "capturing",
      "building",
    ];
    for (const work of all) noLongDash(workingText(work));
    expect(workingText("publish_recheck")).toMatch(
      /^Re-checking on today's StoreMink build/,
    );
    expect(workingText(null)).toBe(workingText("building"));
    expect(all.filter(isCheckingWork)).toEqual([
      "publish_recheck",
      "check_again",
      "checking_version",
      "checking_pictures",
    ]);
    expect(isCheckingWork(null)).toBe(false);
  });
});

/** Stop codes StoreMink writes, read from the source by their simple call
 * forms, so a new code without a sentence fails here. */
function codesInSource(file: string, patterns: RegExp[]): string[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const found = new Set<string>();
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

describe("stopText", () => {
  it("gives every stop code its own plain sentence, never a code", () => {
    for (const kind of Object.keys(STOP_CODES) as StopKind[]) {
      for (const code of STOP_CODES[kind]) {
        const sentence = stopText(code, kind);
        expect(sentence, `${kind}:${code}`).not.toBe(stopText(null, kind));
        expect(sentence).toMatch(/[.]$/);
        expect(sentence).not.toMatch(/[a-z]+_[a-z]+/);
        expect(sentence).not.toMatch(/credit/i);
        noLongDash(sentence);
      }
    }
  });

  it("covers every code the workers write today", () => {
    const run = [
      ...codesInSource("lib/theme-studio/worker.ts", [
        /failRun\(\s*"([a-z0-9_]+)"/g,
        /errorCode: "([a-z0-9_]+)"/g,
      ]),
      ...codesInSource("lib/theme-studio/pipeline.ts", [
        /errorCode: "([a-z0-9_]+)"/g,
      ]),
      // The provider's closed vocabulary (provider.ts ProviderErrorCode).
      "rate_limited",
      "provider_unavailable",
      "provider_rejected",
      "provider_auth",
      "provider_timeout",
      "cancelled",
    ];
    const capture = [
      ...codesInSource("lib/theme-studio/capture.ts", [
        /failCapture\(\s*db,\s*\w+,\s*"([a-z0-9_]+)"/g,
        /\bfail\(\s*"([a-z0-9_]+)"/g,
        /failNow\(\s*"([a-z0-9_]+)"/g,
        /error: "([a-z0-9_]+)"/g,
      ]),
      ...codesInSource("jobs/theme-studio-capture/capture-job.mjs", [
        /CaptureError\(\s*"([a-z0-9_]+)"/g,
        /return "([a-z0-9_]+)";/g,
      ]),
      "cancelled",
      "capture_failed",
    ];
    const review = [
      ...codesInSource("lib/theme-studio/visual-qa.ts", [
        /revealFailed\(\s*db,\s*\w+,\s*"([a-z0-9_]+)"/g,
        /settleOnItsOwn\(\s*db,\s*[\w.]+,\s*"([a-z0-9_]+)"/g,
        /closeRun\(\s*db,\s*\w+,\s*"([a-z0-9_]+)"/g,
        /const CHECKS_INCOMPLETE = "([a-z0-9_]+)"/g,
        /errorCode: "([a-z0-9_]+)"/g,
        /\?\s*"([a-z0-9_]+)"\s*:\s*"[a-z0-9_]+"/g,
        /\?\s*"[a-z0-9_]+"\s*:\s*"([a-z0-9_]+)"/g,
        // Ternaries also pick up phase names and outcomes, which are not
        // stop codes.
      ]).filter(
        (code) => !["revision_queued", "layout", "final"].includes(code),
      ),
      "cancelled",
    ];
    // The parsers did find the codes (a broken pattern would pass vacuously).
    expect(run).toContain("auto_revision_clarified");
    expect(capture).toContain("capture_not_started");
    expect(capture).toContain("qa_probe_missing");
    expect(review).toContain("quality_bar_not_met");
    expect(review).toContain("acceptance_build_unstable");
    expect(review).toContain("checks_incomplete");
    for (const [kind, codes] of [
      ["run", run],
      ["capture", capture],
      ["review", review],
    ] as const) {
      const missing = codes.filter((code) => !STOP_CODES[kind].includes(code));
      expect(missing, kind).toEqual([]);
    }
  });

  it("says who stopped it in the operator's words", () => {
    // Drawn pictures are reused only by a Retry of the same step.
    expect(stopText("cancelled", "run")).toBe(
      "It was stopped. Pictures already drawn are kept: press Retry on this step to use them.",
    );
    expect(stopText("cancelled", "capture")).toBe("You stopped it.");
    expect(stopText("cancelled", "review")).toBe("You stopped it.");
    expect(stopText("capture_not_started", "capture")).toBe(
      "The check never started, so it was stopped after 15 minutes. Check again.",
    );
  });

  it("falls back to its kind's sentence for a code it does not know", () => {
    expect(stopText("brand_new_code", "run")).toBe("This step stopped.");
    expect(stopText("brand_new_code", "capture")).toBe("The capture stopped.");
    expect(stopText("brand_new_code", "review")).toBe(
      "The automatic checks stopped.",
    );
    expect(stopText(undefined, "run")).toBe("This step stopped.");
    expect(stopText("images_anchor_timeout", "run")).toBe(
      "The style picture could not be drawn, so nothing else was.",
    );
  });
});

describe("what a stopped check asks for", () => {
  it("suggests describing a fix only for a stop a theme change can clear", () => {
    for (const code of [
      "quality_bar_not_met",
      "qa_no_progress",
      "repair_not_supported",
      "acceptance_security_failed",
      "auto_revision_clarified",
    ]) {
      expect(stopNeedsThemeChange(code), code).toBe(true);
      expect(stoppedNextStep(code)).toMatch(/^Describe a fix/);
    }
    // A check that could not finish, Stop, StoreMink's own fix, a photo to
    // redraw, any other stop and an unknown code never ask for a change.
    for (const code of [
      "checks_incomplete",
      "cancelled",
      "renderer_fix_required",
      "image_check_required",
      "qa_lease_expired",
      "acceptance_build_unstable",
      "brand_new_code",
      null,
      undefined,
    ]) {
      expect(stopNeedsThemeChange(code), String(code)).toBe(false);
      expect(stoppedNextStep(code), String(code)).not.toMatch(/describe/i);
    }
    expect(stoppedNextStep("checks_incomplete")).toBe(
      "Press Check again: the theme itself does not need a change.",
    );
    expect(stoppedNextStep("renderer_fix_required")).toMatch(
      /StoreMink's own storefront code/,
    );
    expect(stoppedNextStep("image_check_required")).toBe(
      "Redraw the photos it names on the Pictures tab, or press Check again.",
    );
    expect(stoppedNextStep("auto_images_incomplete", "run")).toMatch(
      /Retry the stopped step from the Log tab/,
    );
  });

  it("tells a check that could not finish apart from serious problems", () => {
    expect(stopText("checks_incomplete", "review")).toBe(
      "The checks could not finish, so the theme was not judged. A change to the theme will not help. Check again.",
    );
    expect(stopText("quality_bar_not_met", "review")).toMatch(/describe a fix/);
  });
});

describe("checksOutcome", () => {
  it("takes the newest passed or failed outcome of that version", () => {
    const events = [
      event(
        "auto_qa_passed",
        30,
        { versionId: "v1", qaRunId: "q1" },
        { actorKind: "worker" },
      ),
      event(
        "auto_qa_failed",
        5,
        { versionId: "v1", qaRunId: "q2", errorCode: "quality_bar_not_met" },
        { actorKind: "worker" },
      ),
      event(
        "auto_qa_passed",
        1,
        { versionId: "v2", qaRunId: "q3" },
        { actorKind: "worker" },
      ),
    ];
    expect(checksOutcome("v1", events)).toEqual({
      passed: false,
      code: "quality_bar_not_met",
      kind: "review",
    });
    expect(checksOutcome("v1", [...events].reverse())?.passed).toBe(false);
    expect(checksOutcome("v2", events)).toEqual({
      passed: true,
      code: null,
      kind: "review",
    });
    expect(checksOutcome("v3", events)).toBeNull();
  });

  it("reads a run step's stop as a run code", () => {
    expect(
      checksOutcome("v1", [
        event(
          "auto_qa_failed",
          1,
          { versionId: "v1", errorCode: "images_none" },
          { actorKind: "worker", runId: "r1" },
        ),
      ]),
    ).toEqual({ passed: false, code: "images_none", kind: "run" });
  });

  it("lets the newest outcome, not the version's mark, decide whether the current version stopped", () => {
    const versions = [{ id: "v1", qaStatus: "passed" }];
    const failedRecheck = [
      event(
        "auto_qa_failed",
        1,
        { versionId: "v1", qaRunId: "q", errorCode: "quality_bar_not_met" },
        { actorKind: "worker" },
      ),
    ];
    expect(
      currentChecksFailed({
        currentVersionId: "v1",
        versions,
        events: failedRecheck,
      }),
    ).toBe(true);
    expect(
      currentChecksFailed({ currentVersionId: "v1", versions, events: [] }),
    ).toBe(false);
    expect(
      currentChecksFailed({
        currentVersionId: "v1",
        versions: [{ id: "v1", qaStatus: "failed" }],
        events: [],
      }),
    ).toBe(true);
    expect(
      currentChecksFailed({ currentVersionId: null, versions, events: [] }),
    ).toBe(false);
  });
});

/** The event types the database allows (the newest migration that defines
 * theme_studio_events_type_check). */
function allowedEventTypes(): string[] {
  const dir = join(ROOT, "drizzle/migrations/sql");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) =>
      readFileSync(join(dir, f), "utf8").includes(
        "theme_studio_events_type_check",
      ),
    );
  const sql = readFileSync(join(dir, files.at(-1)!), "utf8");
  const check = sql.slice(sql.lastIndexOf("CHECK (event_type IN ("));
  return [...check.slice(0, check.indexOf("))")).matchAll(/'([a-z_]+)'/g)].map(
    (m) => m[1],
  );
}

describe("Activity", () => {
  it("has plain words for every event type the database allows", () => {
    const types = allowedEventTypes();
    expect(types.length).toBeGreaterThanOrEqual(41);
    for (const type of types) {
      const line = activityLine(event(type, 1));
      if (type === "project_approved" || type === "review_submitted") {
        expect(line).toBeNull();
        continue;
      }
      expect(line, type).not.toBeNull();
      expect(line!.text).not.toBe(type);
      expect(line!.text).not.toMatch(/_/);
      expect(line!.text).not.toMatch(/approv|second|reviewer/i);
      noLongDash(line!.text);
    }
  });

  it("hides the approval lines from before one-step publish", () => {
    expect(activityLine(event("project_approved", 1))).toBeNull();
    expect(activityLine(event("review_submitted", 1))).toBeNull();
  });

  it("says why a step stopped in a sentence, with its code beside it", () => {
    expect(
      activityLine(
        event(
          "run_failed",
          1,
          { errorCode: "images_none" },
          { actorKind: "worker" },
        ),
      ),
    ).toEqual({
      text: "A step stopped",
      stop: {
        sentence: "No picture came back, so no version was made.",
        code: "images_none",
      },
    });
    expect(
      activityLine(
        event("capture_failed", 1, { errorCode: "capture_not_started" }),
      )?.stop?.sentence,
    ).toBe(
      "The check never started, so it was stopped after 15 minutes. Check again.",
    );
    // The design review's own stop, and a run step that revealed its version.
    expect(
      activityLine(
        event("auto_qa_failed", 1, {
          qaRunId: "q",
          errorCode: "renderer_fix_required",
        }),
      )?.stop?.sentence,
    ).toMatch(/StoreMink's own storefront code/);
    expect(
      activityLine(
        event(
          "auto_qa_failed",
          1,
          { errorCode: "images_none" },
          { runId: "r" },
        ),
      )?.stop?.sentence,
    ).toBe("No picture came back, so no version was made.");
  });

  it("tells what Make current, Check again and Publish did", () => {
    expect(
      activityLine(
        event("version_restored", 1, {
          versionNumber: 4,
          outcome: "ready_to_publish",
        }),
      )?.text,
    ).toBe("Made version 4 current, Ready to publish");
    expect(
      activityLine(
        event("version_restored", 1, {
          versionNumber: 4,
          outcome: "rechecking",
        }),
      )?.text,
    ).toBe("Made version 4 current, checking it again on today's build");
    expect(
      activityLine(event("capture_requested", 1, { recheck: "check_again" }))
        ?.text,
    ).toBe("Started checking again on today's build");
    expect(
      activityLine(
        event("capture_requested", 1, { recheck: "publish_recheck" }),
      )?.text,
    ).toBe("Started checking again on today's build before publishing");
    expect(
      activityLine(
        event("publication_failed", 1, {
          problems: [`Demo: /shop answered 500 ${EM} try again.`],
        }),
      ),
    ).toEqual({
      text: "Publish didn't finish",
      note: "Demo: /shop answered 500, try again.",
    });
    expect(
      activityLine(event("theme_published", 1, { releaseVersion: "1.0.0" }))
        ?.text,
    ).toBe("Published v1.0.0");
    expect(
      activityLine(
        event("slot_images_replaced", 1, {
          versionNumber: 7,
          automaticQa: true,
        }),
      )?.text,
    ).toBe("Saved new pictures as version 7, checking them now");
  });

  it("names Theme Studio for the worker and the operator by email", () => {
    expect(activityActor({ actorKind: "worker", actorEmail: null })).toBe(
      "Theme Studio",
    );
    expect(
      activityActor({ actorKind: "operator", actorEmail: "op@storemink.com" }),
    ).toBe("op@storemink.com");
  });
});

describe("warnings and stored words", () => {
  it("words every warning code severity-v1 and the design review produce", () => {
    for (const code of [
      "small_target",
      "extreme_crop",
      "lcp",
      "cls",
      "clipped_text",
      "over_budget",
      "preview_over_budget",
      "below_target",
      "unused",
      "indexable",
      "lang",
      "img_alt",
      "color-contrast",
      "palette_only",
      "generic_surface",
      "needs_custom_code",
      "low_score",
      "low_total",
      "revise_requested",
      "image_redraw",
    ]) {
      const words = warningWords(code);
      expect(words, code).not.toMatch(/Another warning/);
      expect(words).not.toBe(code);
      expect(words).not.toMatch(/_/);
      noLongDash(words);
    }
    expect(warningWords("region", "browser.accessibility")).toBe(
      "A minor accessibility finding (region)",
    );
    expect(warningWords("mystery")).toBe("Another warning (mystery)");
  });

  it("names the design review's rows", () => {
    expect(warningPlace("typography 3 of 5")).toBe("Typography 3 of 5");
    expect(warningPlace("phone390 · home")).toBe("phone390 · home");
  });

  it("removes long dashes from stored words", () => {
    expect(plainText(`Contrast 2.1 ${EM} examples: .a, .b`)).toBe(
      "Contrast 2.1, examples: .a, .b",
    );
    expect(plainText(`Describe it in 3${EN}200 characters.`)).toBe(
      "Describe it in 3 to 200 characters.",
    );
    expect(plainText("No dash here.")).toBe("No dash here.");
  });
});

// ---------------------------------------------------------------------------
// STUDIO_TONE: the controls and notices TS-1 added are coloured with the
// dashboard's tokens, never a raw Tailwind palette class, and every word
// reads at 4.5 to 1 or more wherever it is shown, measured from
// dashboard.css. A stop code in light red read 2.9 to 1 on a white card.
// ---------------------------------------------------------------------------

const DASHBOARD_CSS = readFileSync(
  join(ROOT, "app/dashboard/dashboard.css"),
  "utf8",
);
const RAW_COLOUR =
  /\b(?:bg|text|border|ring|from|to|via)-(?:red|blue|green|yellow|orange|purple|pink|indigo|sky|teal|emerald|amber|lime|cyan|fuchsia|rose|slate|gray|zinc|neutral|stone|violet)-\d{2,3}\b/;
type Rgb = [number, number, number];

/** A `--dash-*` token's value in dashboard.css. */
function dashToken(name: string): string {
  const found = DASHBOARD_CSS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!found) throw new Error(`dashboard.css has no --${name}`);
  return found[1].trim();
}

/** A colour as it shows over `under`: "#rrggbb" or "rgba(r, g, b, a)". */
function paint(value: string, under: Rgb): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex)
    return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as Rgb;
  const rgba = value.match(
    /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/,
  );
  if (!rgba) throw new Error(`Unreadable colour ${value}`);
  const alpha = Number(rgba[4]);
  return [1, 2, 3].map(
    (i, k) => alpha * Number(rgba[i]) + (1 - alpha) * under[k],
  ) as Rgb;
}

/** WCAG 2 contrast ratio. */
function contrast(a: Rgb, b: Rgb): number {
  const luminance = (rgb: Rgb) => {
    const [r, g, bl] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The --dash-* token a tone's text or background arbitrary-value class
 * names. (Written in words: Tailwind scans test files too, and a class
 * spelled out here would land in the production stylesheet.) */
function toneToken(tone: string, utility: "text" | "bg"): string | null {
  const found = tone.match(
    new RegExp(`(?:^|\\s)${utility}-\\[var\\(--(dash-[a-z0-9-]+)\\)\\]`),
  );
  return found ? found[1] : null;
}

describe("STUDIO_TONE", () => {
  it("uses the dashboard's tokens only, never a raw Tailwind colour", () => {
    for (const [name, tone] of Object.entries(STUDIO_TONE)) {
      expect(tone, name).not.toMatch(RAW_COLOUR);
      for (const value of tone.matchAll(/(?:text|bg|border)-\[([^\]]+)\]/g))
        expect(value[1], name).toMatch(/^var\(--dash-[a-z0-9-]+\)$/);
      expect(toneToken(tone, "text"), `${name} sets no text colour`).not.toBe(
        null,
      );
    }
    for (const name of ["warn", "ok", "info"] as const)
      expect(
        toneToken(STUDIO_TONE[name], "bg"),
        `${name} has no tint`,
      ).not.toBe(null);
  });

  it("keeps every word at 4.5 to 1 or more wherever it is shown", () => {
    // A white card or a dialog, and the page under the cards.
    const white = paint(dashToken("dash-surface"), [255, 255, 255]);
    const page = paint(
      DASHBOARD_CSS.match(
        /\.dashboard-shell \.dash-main \{[^}]*?background-color:\s*(#[0-9a-f]{6})/i,
      )?.[1] ?? "(no .dash-main background-color)",
      white,
    );
    const tints = (["warn", "ok", "info"] as const).flatMap((name) =>
      [white, page].map((under) =>
        paint(dashToken(toneToken(STUDIO_TONE[name], "bg") ?? "-"), under),
      ),
    );
    /** Where each tone's words are shown (STUDIO_TONE's own comment). */
    const shownOn: Record<keyof typeof STUDIO_TONE, Rgb[]> = {
      warn: [white, page],
      ok: [white, page],
      info: [white, page],
      ink: [white, page],
      muted: [white, page],
      // Beside a stop sentence on a card, on the page, or in a tinted notice.
      code: [white, page, ...tints],
      link: [white, page],
      // Red words never go on the page or a tint: 4.3 to 1 or less there.
      error: [white],
    };
    for (const [name, backdrops] of Object.entries(shownOn)) {
      const tone = STUDIO_TONE[name as keyof typeof STUDIO_TONE];
      const ink = dashToken(toneToken(tone, "text") ?? "-");
      const tint = toneToken(tone, "bg");
      for (const under of backdrops) {
        const behind = tint ? paint(dashToken(tint), under) : under;
        expect(
          contrast(paint(ink, behind), behind),
          `${name} over rgb(${under.map(Math.round).join(",")})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("StudioBadge (TS-2A)", () => {
  it("shows studioStatus's words in the Studio's readable badge, by tone", () => {
    const html = renderToStaticMarkup(
      createElement(StudioBadge, {
        status: { words: "Ready to publish, 2 warnings", tone: "success" },
      }),
    );
    expect(html).toBe(
      '<span class="studio-badge" data-tone="success">Ready to publish, 2 warnings</span>',
    );
  });

  it("keeps today's badge for the screens that have only a state, with no raw colour", () => {
    const blocked = renderToStaticMarkup(
      createElement(StudioStatusBadge, {
        status: "blocked",
        questionsOpen: false,
      }),
    );
    expect(blocked).toBe(
      '<span class="studio-badge" data-tone="danger">Can&#x27;t publish: security problem</span>',
    );
    const publishing = renderToStaticMarkup(
      createElement(StudioStatusBadge, {
        status: "approved",
        publishing: true,
      }),
    );
    expect(publishing).toContain('data-tone="info"');
    expect(publishing).toContain(">Publishing<");
    // A studioStatus result wins over the state's own words.
    const studio = renderToStaticMarkup(
      createElement(StudioStatusBadge, {
        status: "generating",
        studio: { words: "Stuck since 10:40", tone: "warning" },
      }),
    );
    expect(studio).toContain(">Stuck since 10:40<");
    expect(studio).toContain('data-tone="warning"');
  });

  it("carries no raw Tailwind colour or violet anywhere in studio-ui.tsx", () => {
    const source = readFileSync(
      join(
        ROOT,
        "app/platform/dashboard/(console)/themes/studio/studio-ui.tsx",
      ),
      "utf8",
    );
    expect(source).not.toMatch(RAW_COLOUR);
    expect(source).not.toMatch(/violet/i);
  });

  it("lists the operator events that start a piece of work, once each", () => {
    expect(new Set(STUDIO_WORK_STARTERS).size).toBe(
      STUDIO_WORK_STARTERS.length,
    );
    expect(STUDIO_WORK_STARTERS).toContain("capture_requested");
    expect(STUDIO_WORK_STARTERS).toContain("run_queued");
  });
});
