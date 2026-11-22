import type {
  StudioStatusInput,
  StudioStatusStop,
  ThemeStudioListFilter,
} from "@/lib/theme-studio/progress";
import { PUBLISH_ATTEMPT_MINUTES, stopNeedsThemeChange } from "./studio-ui";
import {
  clockWords,
  durationWords,
  isKnownStopCode,
  reasonPhrase,
  stopPhrase,
} from "./studio-words";

// ---------------------------------------------------------------------------
// The one status function of Theme Studio (wave TS-2, plan section 4 "Status
// words"; contract in revamp-handoff/scratchpad/progress/ts2-contract.md).
//
// ★ ONE FUNCTION DECIDES THE WORDS AND THE MAIN BUTTON for the list, the
// header and the versions list. It is total: every state has a row, the
// first matching row of the 19 wins, and each row has a test. It is pure: it
// reads only its input (ages are measured against `input.now`), so the
// server, the list and the theme page all say the same thing.
//
// ★ Client-safe and server-safe: no React hooks, no server-only import
// (types only from lib/theme-studio/progress.ts).
//
// ★ WORDS. Plain sentences; the code's state names (candidate, approved,
// ready, blocked) never appear on screen as words of their own: the plan's
// phrases are "Ready to publish" (and the list chip "Ready", which means it),
// "Publish didn't finish", "Needs your answer", "Can't publish: security
// problem". No em dash or en dash; no number of Mink credits.
//
// ★ SWITCHED OFF. A row whose main button needs building (BUILDING_KINDS) says
// so in its words when building is switched off, or the theme's own model
// is (MODEL_KINDS), and shows no main button; a row whose main button checks
// the design again says so when the automatic checks are off (local
// development only). The page shows the banner.
//
// ★ AN UNKNOWN STOP CODE NEVER REACHES "Describe a fix": a capture or review
// stop that no theme change, redraw or StoreMink fix answers is row 12, and
// so is a build step's unknown code once the theme has a design. Only a stop
// a theme change can clear (studio-ui.tsx stopNeedsThemeChange) is row 14.
// ---------------------------------------------------------------------------

/**
 * Every main button and secondary action of section 4 and its status table,
 * as a closed list. A screen renders an action by its kind; the label comes
 * with it. Where each kind is handled is in the contract ("Where each action
 * is handled"): a kind never runs paid work from an address alone, it opens
 * its control's dialog or confirm.
 */
export const STUDIO_ACTION_KINDS = [
  /** Row 1: the live demo store, in a new tab. */
  "open_live_demo",
  /** Row 1, not offered: show it to new stores again. */
  "offer_again",
  /** Row 1, offered: "Stop offering this theme" (it also hides the theme from
   * existing stores that have not installed it). */
  "stop_offering",
  /** Rows 15 and 16: open the Publish dialog (row 16's offers the re-check). */
  "publish",
  /** Row 3: "Try again" on a publish that did not finish. */
  "retry_publish",
  /** Row 5, in the "..." menu: Stop, behind a dialog that says what is kept. */
  "stop",
  /** Row 6: one dialog that stops the stuck work, then checks again. */
  "stop_and_check_again",
  /** Row 7: answer the AI's questions in the chat. */
  "answer",
  /** Rows 8 and 17 (a declined brief) and the live panel: New theme, filled
   * in from this theme's brief. */
  "start_new_from_brief",
  /** Rows 9 and 14: put a short summary of the serious findings in the chat
   * for the operator to read and send. Never sends by itself. */
  "describe_fix",
  /** Row 14 (pictures): redraw exactly the pictures the findings name,
   * after a small confirm that names how many. */
  "redraw",
  /** Row 10: retry the stopped step (it reuses what it already drew). */
  "continue_building",
  /** Row 11: the details of a StoreMink problem, for an engineer. */
  "copy_details",
  /** Rows 12 and 19: measure the current design again on today's build. */
  "check_again",
  /** Row 13: draw the missing pictures, after a small confirm. */
  "draw_missing_pictures",
  /** Row 13: retry the picture run that failed, after a small confirm. */
  "retry_pictures",
  /** Row 17: retry the first build that failed; row 19: retry a change that
   * stopped on a theme that kept its design. */
  "retry_build",
  /** Row 18: start building from the saved brief. */
  "start_building",
  /** The "..." menu: "Remove from list (keeps its history)"; hidden for a
   * live theme. */
  "remove_from_list",
  /** The "..." menu: Delete, which erases the theme's history. */
  "delete",
  /** The Design list and the Publish dialog: make another design current. */
  "make_current",
] as const;

export type StudioActionKind = (typeof STUDIO_ACTION_KINDS)[number];

/** A button: what it does and its words, for example
 * `{ kind: "publish", label: "Publish" }`. */
export interface StudioAction {
  kind: StudioActionKind;
  label: string;
}

/** The kinds that always go in the header's "..." menu (phones too); every
 * other secondary action is a visible button beside the main one. */
export const STUDIO_MENU_KINDS = [
  "stop",
  "remove_from_list",
  "delete",
] as const satisfies readonly StudioActionKind[];

/** The rows whose main and secondary actions (all but the menu kinds) are
 * rendered by 2C's release controls (`[projectId]/release-controls.tsx`):
 * live, publishing, publish didn't finish, Ready to publish. */
export const STUDIO_RELEASE_ROWS = [1, 2, 3, 15, 16] as const;

/** Row 6's rule: working, nothing new for this long, and no wait pending. */
export const STUDIO_STUCK_MINUTES = 20;

/** How a status is coloured. The Studio CSS file maps each one to the
 * dashboard's tokens with readable words (`studio-badge[data-tone]`). */
export type StudioTone = "neutral" | "info" | "success" | "warning" | "danger";

/** What studioStatus decides. */
export interface StudioStatus {
  /** The row of section 4's table that matched, 1 to 19. */
  row: number;
  /** The status words, for example "Ready to publish, 2 warnings" or
   * "Building: drawing pictures (26 min)". Times are India time. */
  words: string;
  tone: StudioTone;
  /** The one main button, or null (rows 2, 4, 5 and 11, and any row whose
   * action needs a switched-off thing). */
  primary: StudioAction | null;
  /** Other actions this state offers, in display order; the menu kinds
   * (STUDIO_MENU_KINDS) go in the "..." menu. */
  secondary: StudioAction[];
  /** The release that stays live while a change to a published theme is
   * built, checked or waiting to be published ("1.0.0"); null on row 1
   * (the words already say it) and for a theme that never published. A
   * screen shows it beside the words: "v1.0.0 stays live". */
  liveVersion?: string | null;
}

/** The words for `liveVersion`, for the badge beside the status. */
export function liveVersionWords(version: string): string {
  return `v${version} stays live`;
}

/** Every action's words, one label per kind. */
export const STUDIO_ACTION_LABELS: Readonly<Record<StudioActionKind, string>> =
  {
    open_live_demo: "Open live demo",
    offer_again: "Offer again",
    stop_offering: "Stop offering this theme",
    publish: "Publish",
    retry_publish: "Try again",
    stop: "Stop",
    stop_and_check_again: "Stop and check again",
    answer: "Answer",
    start_new_from_brief: "Start a new theme from this brief",
    describe_fix: "Describe a fix",
    redraw: "Redraw",
    continue_building: "Continue building",
    copy_details: "Copy details",
    check_again: "Check again",
    draw_missing_pictures: "Draw missing pictures",
    retry_pictures: "Retry",
    retry_build: "Try again",
    start_building: "Start building",
    remove_from_list: "Remove from list (keeps its history)",
    delete: "Delete",
    make_current: "Make current",
  };

/** An action of this kind with its words. */
export function studioAction(kind: StudioActionKind): StudioAction {
  return { kind, label: STUDIO_ACTION_LABELS[kind] };
}

/** Whether an action belongs in the header's "..." menu. */
export function isStudioMenuKind(kind: StudioActionKind): boolean {
  return (STUDIO_MENU_KINDS as readonly StudioActionKind[]).includes(kind);
}

/** Actions that start building work (a paid model run): switched off with
 * building (THEME_STUDIO_GENERATION_ENABLED=false). */
export const STUDIO_BUILDING_KINDS: readonly StudioActionKind[] = [
  "answer",
  "describe_fix",
  "redraw",
  "continue_building",
  "draw_missing_pictures",
  "retry_pictures",
  "retry_build",
  "start_building",
];

/** Building actions that run the theme's own model, so its own switch
 * (THEME_STUDIO_DISABLED_MODELS) turns them off too. Picture actions use the
 * picture model. */
const MODEL_KINDS: ReadonlySet<StudioActionKind> = new Set([
  "answer",
  "describe_fix",
  "continue_building",
  "retry_build",
  "start_building",
]);

/** Actions that measure the design again in the capture job. */
const CHECKING_KINDS: ReadonlySet<StudioActionKind> = new Set([
  "check_again",
  "stop_and_check_again",
]);

const MINUTE = 60_000;

function time(iso: string | null | undefined): number {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : NaN;
}

/** A step's label after "Building: ", starting lower case unless it starts
 * with a name. */
function stepPhrase(label: string): string {
  return reasonPhrase(label);
}

const BUILDING_OFF = ", building is switched off";
const MODEL_OFF = ", this model is switched off";
const CHECKS_OFF = ", automatic checks are switched off";

interface Draft {
  row: number;
  words: string;
  tone: StudioTone;
  primary: StudioActionKind | null;
  secondary: StudioActionKind[];
  /** The main button checks the design again (row 16's Publish). */
  primaryChecks?: boolean;
}

/** Apply the switches: an action that needs a switched-off thing is not
 * offered, and the words say why when it was the main button. */
function settle(draft: Draft, input: StudioStatusInput): StudioStatus {
  const { buildingOff, modelOff, checksOff } = input.switches;
  const blockedBy = (
    kind: StudioActionKind,
    primary: boolean,
  ): string | null => {
    if (STUDIO_BUILDING_KINDS.includes(kind)) {
      if (buildingOff) return BUILDING_OFF;
      if (modelOff && MODEL_KINDS.has(kind)) return MODEL_OFF;
    }
    if (
      checksOff &&
      (CHECKING_KINDS.has(kind) || (primary && draft.primaryChecks))
    )
      return CHECKS_OFF;
    return null;
  };
  let words = draft.words;
  let primary: StudioAction | null = null;
  if (draft.primary) {
    const reason = blockedBy(draft.primary, true);
    if (reason) words += reason;
    else primary = studioAction(draft.primary);
  }
  const secondary = draft.secondary
    .filter(
      (kind) =>
        kind !== draft.primary &&
        !blockedBy(kind, false) &&
        // A theme with a release is never removed from the list, on any row:
        // stores are using it. (Delete says what it does to them.)
        !(kind === "remove_from_list" && input.release),
    )
    .map(studioAction);
  return {
    row: draft.row,
    words,
    tone: draft.tone,
    primary,
    secondary,
    liveVersion:
      draft.row !== 1 && input.release ? input.release.version : null,
  };
}

/** The "..." menu of a theme nothing is working on that is not live. */
const IDLE_MENU: StudioActionKind[] = ["remove_from_list", "delete"];

/** A build step's code nobody has words for, once the theme has a design:
 * "Couldn't finish the checks" with Check again, never "Describe a fix". */
function unknownRunStop(
  stop: StudioStatusStop,
  input: StudioStatusInput,
): boolean {
  return (
    stop.kind === "run" &&
    !isKnownStopCode(stop.code, "run") &&
    input.hasCurrentVersion &&
    input.projectStatus !== "failed"
  );
}

/** Row 12: a check that could not finish, for a reason that no theme change,
 * redraw or StoreMink fix answers. */
function checksCouldNotFinish(
  stop: StudioStatusStop | null,
  input: StudioStatusInput,
): boolean {
  if (!stop) return false;
  if (stop.kind === "run") return unknownRunStop(stop, input);
  return (
    !stopNeedsThemeChange(stop.code) &&
    stop.code !== "image_check_required" &&
    stop.code !== "renderer_fix_required"
  );
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The words and the actions for one theme's facts. Pure and total. */
export function studioStatus(input: StudioStatusInput): StudioStatus {
  const now = time(input.now);
  const stop = input.stop;
  const checks = input.checks;

  // 1. Live: the theme rests on a published design. ★ A published theme
  // can be changed (migration 0288): while the change is built, checked or
  // waiting to be published the project is in the ordinary working states,
  // its own row below applies, and `liveVersion` names the release that
  // stays live meanwhile. Removed from the list, a live theme is still row 1.
  if (
    input.release &&
    (input.projectStatus === "published" || input.projectStatus === "archived")
  ) {
    return settle(
      input.release.offered
        ? {
            row: 1,
            words: `Live, v${input.release.version}`,
            tone: "success",
            primary: "open_live_demo",
            secondary: ["stop_offering", "start_new_from_brief", "delete"],
          }
        : {
            row: 1,
            words: "Not offered to new stores",
            tone: "neutral",
            primary: "offer_again",
            secondary: ["open_live_demo", "start_new_from_brief", "delete"],
          },
      input,
    );
  }

  // 2. A publish attempt running, its last write under 15 minutes old.
  const attempt = input.publishAttempt;
  if (
    attempt?.state === "publishing" &&
    now - time(attempt.lastWriteAt) < PUBLISH_ATTEMPT_MINUTES * MINUTE
  ) {
    return settle(
      {
        row: 2,
        words: "Publishing",
        tone: "info",
        primary: null,
        secondary: [],
      },
      input,
    );
  }

  // 3. A publish that did not finish: it failed, or stopped answering.
  if (input.projectStatus === "approved") {
    const reason = attempt?.reasons.find((r) => reasonPhrase(r));
    const words = reason
      ? `Publish didn't finish: ${reasonPhrase(reason)}`
      : attempt?.state === "publishing"
        ? "Publish didn't finish: it stopped answering"
        : "Publish didn't finish";
    return settle(
      {
        row: 3,
        words,
        tone: "warning",
        primary: "retry_publish",
        secondary: IDLE_MENU,
      },
      input,
    );
  }

  // 4. Removed from the list, never published.
  if (input.projectStatus === "archived") {
    return settle(
      {
        row: 4,
        words: "Removed from list",
        tone: "neutral",
        primary: null,
        secondary: ["delete"],
      },
      input,
    );
  }

  // 5 and 6. Working; stuck when nothing new happened for 20 minutes and no
  // wait time is pending.
  const working = input.working;
  if (working) {
    const quietFor = now - time(working.lastProgressAt);
    const waitingOut =
      working.nextTryAt !== null && time(working.nextTryAt) > now;
    if (quietFor >= STUDIO_STUCK_MINUTES * MINUTE && !waitingOut) {
      return settle(
        {
          row: 6,
          words: `Stuck since ${clockWords(working.lastProgressAt, input.now)}`,
          tone: "warning",
          primary: input.hasCurrentVersion ? "stop_and_check_again" : null,
          secondary: ["stop"],
        },
        input,
      );
    }
    const since = now - time(working.since);
    const words =
      working.kind === "waiting"
        ? `Waiting to start (since ${clockWords(working.since, input.now)})`
        : working.kind === "rechecking"
          ? "Checking on today's StoreMink build"
          : working.kind === "checking_pictures"
            ? "Checking pictures"
            : working.kind === "checking_change"
              ? "Checking your change"
              : working.step
                ? `Building: ${stepPhrase(working.step)} (${durationWords(since)})`
                : `Building (${durationWords(since)})`;
    return settle(
      { row: 5, words, tone: "info", primary: null, secondary: ["stop"] },
      input,
    );
  }

  // 7. The AI asked questions.
  if (
    input.projectStatus === "blocked" &&
    input.questions.open &&
    !input.questions.tooManyRounds
  ) {
    return settle(
      {
        row: 7,
        words: "Needs your answer",
        tone: "warning",
        primary: "answer",
        secondary: IDLE_MENU,
      },
      input,
    );
  }

  // 8. Too many rounds of questions: the server refuses another answer.
  if (input.questions.open && input.questions.tooManyRounds) {
    return settle(
      {
        row: 8,
        words: "Needs a new start: too many questions",
        tone: "warning",
        primary: "start_new_from_brief",
        secondary: IDLE_MENU,
      },
      input,
    );
  }

  // 9. Blocked with no questions open: its security check failed.
  if (input.projectStatus === "blocked") {
    return settle(
      {
        row: 9,
        words: "Can't publish: security problem",
        tone: "danger",
        primary: "describe_fix",
        secondary: IDLE_MENU,
      },
      input,
    );
  }

  // 10. The operator stopped it.
  if (stop?.code === "cancelled") {
    return settle(
      {
        row: 10,
        words: "Stopped",
        tone: "neutral",
        primary:
          stop.kind === "run"
            ? stop.runId
              ? "continue_building"
              : null
            : input.hasCurrentVersion
              ? "check_again"
              : null,
        secondary: IDLE_MENU,
      },
      input,
    );
  }

  // 11. Serious findings that are all StoreMink's own code.
  if (
    checks?.allSeriousAreStoreMink ||
    stop?.code === "renderer_fix_required"
  ) {
    return settle(
      {
        row: 11,
        words: "Needs a StoreMink fix",
        tone: "warning",
        primary: null,
        secondary: ["copy_details", ...IDLE_MENU],
      },
      input,
    );
  }

  // 12. The checks could not finish (and any code nobody has words for).
  if (stop && checksCouldNotFinish(stop, input)) {
    const phrase = stopPhrase(stop.code, stop.kind);
    return settle(
      {
        row: 12,
        words: phrase
          ? `Couldn't finish the checks: ${phrase}`
          : "Couldn't finish the checks",
        tone: "warning",
        primary: input.hasCurrentVersion ? "check_again" : null,
        secondary: IDLE_MENU,
      },
      input,
    );
  }

  // 13. Pictures missing, or the last picture run failed.
  const pictureRunFailed = input.pictures.lastRun?.state === "failed";
  if (input.pictures.missing > 0 || pictureRunFailed) {
    return settle(
      {
        row: 13,
        words:
          input.pictures.missing > 0
            ? `Pictures missing (${input.pictures.missing})`
            : "Drawing pictures didn't finish",
        tone: "warning",
        primary: pictureRunFailed ? "retry_pictures" : "draw_missing_pictures",
        secondary: IDLE_MENU,
      },
      input,
    );
  }

  // 14. Serious findings left after the repairs, or a stop a theme change
  // can clear: Describe a fix, or Redraw when every serious finding that is
  // not StoreMink's is a picture one.
  const serious = checks?.serious ?? 0;
  if (serious > 0 || (stop !== null && stopNeedsThemeChange(stop.code))) {
    const pictures = checks?.seriousPictures ?? 0;
    const theirs = serious - (checks?.seriousStoreMink ?? 0);
    const redrawFirst = pictures > 0 && pictures >= theirs;
    return settle(
      {
        row: 14,
        words:
          serious > 0
            ? `Needs a fix (${count(serious, "problem", "problems")})`
            : "Needs a fix",
        tone: "danger",
        primary: redrawFirst ? "redraw" : "describe_fix",
        secondary: [
          ...(redrawFirst
            ? (["describe_fix"] as const)
            : pictures > 0
              ? (["redraw"] as const)
              : []),
          ...IDLE_MENU,
        ],
      },
      input,
    );
  }

  // 15 and 16. Ready to publish; on today's evidence, or re-checked first.
  if (input.projectStatus === "candidate") {
    if (input.evidence?.ok) {
      const warnings = checks?.warnings ?? 0;
      return settle(
        {
          row: 15,
          words:
            warnings > 0
              ? `Ready to publish, ${count(warnings, "warning", "warnings")}`
              : "Ready to publish",
          tone: "success",
          primary: "publish",
          secondary: IDLE_MENU,
        },
        input,
      );
    }
    return settle(
      {
        row: 16,
        words:
          input.evidence?.reason === "old_build"
            ? "Ready to publish (StoreMink was updated)"
            : "Ready to publish (needs a quick re-check)",
        tone: "success",
        primary: "publish",
        primaryChecks: true,
        secondary: IDLE_MENU,
      },
      input,
    );
  }

  // 17. A first build that failed.
  if (input.projectStatus === "failed") {
    const declined =
      stop?.code === "model_declined" || stop?.code === "model_refused";
    const phrase = stop ? stopPhrase(stop.code, stop.kind) : "";
    return settle(
      {
        row: 17,
        words: phrase ? `Couldn't finish: ${phrase}` : "Couldn't finish",
        tone: "danger",
        primary: declined
          ? "start_new_from_brief"
          : stop?.kind === "run" && stop.runId
            ? "retry_build"
            : null,
        secondary: IDLE_MENU,
      },
      input,
    );
  }

  // 18. Brief saved, nothing sent.
  if (input.projectStatus === "draft") {
    return settle(
      {
        row: 18,
        words: "Not started",
        tone: "neutral",
        primary: "start_building",
        secondary: IDLE_MENU,
      },
      input,
    );
  }

  // 19. Anything else. First, a build step that stopped for a known reason
  // on a theme that keeps its design (worker.ts settles it back on that
  // design, at ready): its reason, Try again, and Check again, which brings
  // the design it kept back to Ready to publish without the change. A
  // declined request is not tried again as it was.
  if (stop?.kind === "run" && input.hasCurrentVersion) {
    const phrase = stopPhrase(stop.code, stop.kind);
    const retry =
      !!stop.runId &&
      stop.code !== "model_declined" &&
      stop.code !== "model_refused";
    return settle(
      {
        row: 19,
        words: phrase
          ? `Your change didn't finish: ${phrase}`
          : "Your change didn't finish",
        tone: "warning",
        primary: retry ? "retry_build" : "check_again",
        secondary: [...(retry ? (["check_again"] as const) : []), ...IDLE_MENU],
      },
      input,
    );
  }

  // Then a design no check has judged, one judged only on an earlier
  // StoreMink build, or one that passed on today's build while the theme is
  // not marked Ready to publish (only a check marks it again).
  const evidence = input.evidence;
  return settle(
    {
      row: 19,
      words: evidence?.ok
        ? "Checked on today's build; check it again to publish"
        : evidence && !evidence.ok && evidence.reason === "old_build"
          ? "Not checked on today's build"
          : "Not checked yet",
      tone: "neutral",
      primary: input.hasCurrentVersion ? "check_again" : null,
      secondary: IDLE_MENU,
    },
    input,
  );
}

/**
 * The list chip a status belongs to (every project is in "all" too):
 * "live" row 1; "building" rows 2 and 5; "ready" rows 15 and 16;
 * "archived" row 4; "needs_you" every other row (3, 6 to 14, 17 to 19).
 */
export function studioListFilter(
  status: Pick<StudioStatus, "row">,
): Exclude<ThemeStudioListFilter, "all"> {
  switch (status.row) {
    case 1:
      return "live";
    case 2:
    case 5:
      return "building";
    case 15:
    case 16:
      return "ready";
    case 4:
      return "archived";
    default:
      return "needs_you";
  }
}
