import type { ThemeStudioProjectState } from "@/lib/theme-studio/contracts";
import type {
  ThemeStudioEventView,
  ThemeStudioRunView,
} from "@/lib/theme-studio/repository";
import { SCORECARD_DIMENSIONS } from "@/lib/theme-studio/scorecard";
import type { StudioStatus, StudioTone } from "./studio-status";
import { STOP_REASON_CODES, stopReasonWords } from "./studio-words";

// Small presentational pieces and the plain words shared by the Studio pages.
// Server-safe and client-safe: no hooks, no server-only imports (types only
// from the repository; scorecard.ts imports nothing; studio-words.ts is
// pure).
//
// ★ PLAIN WORDS (TS-1F, 24 Oct 2026). One step publishes, with no second
// person, so no screen speaks of approval or review by another operator; a
// stopped step is told in a sentence, never a raw code alone; the Activity
// list says what happened. The words candidate, approved, ready and blocked
// never reach the screen: they are the code's names for "Ready to publish",
// "a publish that has not finished", "not checked yet" and "needs you".
//
// ★ ONE BADGE (TS-2A). The status words and their tone come from
// studio-status.ts `studioStatus`, shown by `StudioBadge` in the Studio CSS
// file's `studio-badge` (its words in the dashboard's ink on a soft tint, so
// they stay readable: the dashboard's own amber and green badges are below
// the AA line as text); "Blocked" no longer means two things in one amber.
// ⚠ NO SCREEN USES THE OLD HELPERS BELOW since TS-2: `StudioStatusBadge`,
// `studioStatusLabel`, `studioStatusTone`, `currentQaFailed` and
// `currentChecksFailed` (and repository.ts `listThemeStudioProjects`) are
// imported only by their tests. They decide "the current version's checks
// failed" from other reads than `studioStatus`, so they can drift from it
// unnoticed: never build a screen on them; they are listed for the TS-4C
// clean-up (Theme Studio plan, section 8, row 4).

/** The words for a project state alone, when the page has no status facts
 * (studioStatus is the rule wherever it has them). */
const STATUS_WORD: Record<ThemeStudioProjectState, string> = {
  draft: "Not started",
  generating: "Building",
  ready: "Needs checks",
  candidate: "Ready to publish",
  approved: "Publish didn't finish",
  published: "Live",
  failed: "Couldn't finish",
  blocked: "Needs you",
  archived: "Removed from list",
};

/** The tone of a project state alone, in studioStatus's tones. */
const STATUS_TONE: Record<ThemeStudioProjectState, StudioTone> = {
  draft: "neutral",
  generating: "info",
  ready: "neutral",
  candidate: "success",
  approved: "warning",
  published: "success",
  failed: "danger",
  blocked: "warning",
  archived: "neutral",
};

/**
 * The status words in the Studio's badge: `studioStatus`'s words and tone
 * (studio.css `studio-badge[data-tone]`, readable on every backdrop).
 */
export function StudioBadge({
  status,
}: {
  status: Pick<StudioStatus, "words" | "tone">;
}) {
  return (
    <span className="studio-badge" data-tone={status.tone}>
      {status.words}
    </span>
  );
}

/**
 * ★ STUDIO COLOURS ARE THE DASHBOARD'S TOKENS, AND THE WORDS STAY READABLE
 * (plan section 4: `dash-*` classes and tokens only, never a raw Tailwind
 * palette colour). The controls and notices TS-1 added use these, and their
 * buttons `dash-btn`. Measured from dashboard.css: the dashboard's amber and
 * green are 3.3 to 1 or less as text (under 2.9 on their own tints), so a
 * notice keeps its tone in a soft tint and a border and its words in the
 * dashboard's ink. Red words are 4.8 to 1 on white only (4.3 on the page and
 * less on a tint), so `error` goes on a white card or in a dialog and nowhere
 * else. A stop code is in the second ink (4.6 to 1 or more on the page, a
 * card or a tint): it is copied for support, not hidden. studio-ui.test.ts
 * measures every pair. The older Studio screens keep their raw classes until
 * TS-2 rebuilds them, with its own CSS file.
 */
export const STUDIO_TONE = {
  /** Needs the operator: the checks stopped, an earlier build. */
  warn: "border-[var(--dash-amber)]/40 bg-[var(--dash-amber-soft)] text-[var(--dash-text)]",
  /** Ready to publish, the checks passed. */
  ok: "border-[var(--dash-green)]/30 bg-[var(--dash-green-soft)] text-[var(--dash-text)]",
  /** Work under way. */
  info: "border-[var(--dash-accent)]/25 bg-[var(--dash-accent-soft)] text-[var(--dash-text)]",
  /** The main words of a card or a dialog. */
  ink: "text-[var(--dash-text)]",
  /** Words beside a control or under a heading. */
  muted: "text-[var(--dash-text-2)]",
  /** A stop code, copied for support. */
  code: "font-mono text-[var(--dash-text-2)]",
  /** A link inside muted words. */
  link: "font-medium text-[var(--dash-text)] underline underline-offset-2",
  /** What went wrong: on a white card or in a dialog only. */
  error: "text-[var(--dash-red)]",
} as const;

export interface StudioStatusContext {
  /** Automatic checks failed the current version. */
  qaFailed?: boolean;
  /** A publish attempt is running now (see `publishRunningFromEvents`).
   * Without it an `approved` project reads "Publish didn't finish": the
   * state a failed attempt waits in, for as long as nobody tries again. */
  publishing?: boolean;
  /** The theme is generating because its design is being checked (a
   * re-check, a Make current or saved pictures), not built. */
  checking?: boolean;
  /** For a `blocked` theme: the AI's questions wait for an answer
   * (`questionsOpen`); false when its security check failed instead.
   * Unknown, a blocked theme reads "Needs you". */
  questionsOpen?: boolean;
}

/**
 * The label for a project state when the page has no status facts. Where it
 * has them, `studioStatus` (studio-status.ts) decides. `ready` is the
 * unverified state, so it reads "Needs checks", unless the automatic checks
 * already judged the current version and failed it ("Needs attention"). A
 * blocked theme reads "Needs your answer" or "Can't publish: security
 * problem", never "Blocked".
 */
export function studioStatusLabel(
  status: ThemeStudioProjectState,
  context: StudioStatusContext = {},
): string {
  if (status === "ready" && context.qaFailed) return "Needs attention";
  if (status === "approved" && context.publishing) return "Publishing";
  if (status === "generating" && context.checking) return "Checking";
  if (status === "blocked" && context.questionsOpen === true)
    return "Needs your answer";
  if (status === "blocked" && context.questionsOpen === false)
    return "Can't publish: security problem";
  return STATUS_WORD[status] ?? "Needs you";
}

/** The tone that goes with `studioStatusLabel`. */
export function studioStatusTone(
  status: ThemeStudioProjectState,
  context: StudioStatusContext = {},
): StudioTone {
  if (status === "ready" && context.qaFailed) return "danger";
  if (status === "approved" && context.publishing) return "info";
  if (status === "blocked" && context.questionsOpen === false) return "danger";
  return STATUS_TONE[status] ?? "neutral";
}

/**
 * Today's badge, for the screens that have only the project's state. With
 * `studio` (a `studioStatus` result) it shows exactly that; otherwise the
 * state's own words and tone. Both render as `StudioBadge`.
 */
export function StudioStatusBadge({
  status,
  qaFailed = false,
  publishing = false,
  checking = false,
  questionsOpen,
  studio,
}: {
  status: ThemeStudioProjectState;
  studio?: Pick<StudioStatus, "words" | "tone">;
} & StudioStatusContext) {
  const context = { qaFailed, publishing, checking, questionsOpen };
  return (
    <StudioBadge
      status={
        studio ?? {
          words: studioStatusLabel(status, context),
          tone: studioStatusTone(status, context),
        }
      }
    />
  );
}

/** Whether automatic QA failed the project's current version, by its mark.
 * Prefer `currentChecksFailed` where Activity is at hand. */
export function currentQaFailed(project: {
  currentVersionId: string | null;
  versions: readonly { id: string; qaStatus: string }[];
}): boolean {
  return (
    project.versions.find((v) => v.id === project.currentVersionId)
      ?.qaStatus === "failed"
  );
}

/** Whether the current version's newest checks stopped on it. The version's
 * own mark cannot be rewritten after a re-check (migration 0144), so the
 * newest outcome in Activity decides, and the mark only without one. */
export function currentChecksFailed(project: {
  currentVersionId: string | null;
  versions: readonly { id: string; qaStatus: string }[];
  events: readonly EventLike[];
}): boolean {
  if (!project.currentVersionId) return false;
  const outcome = checksOutcome(project.currentVersionId, project.events);
  return outcome ? !outcome.passed : currentQaFailed(project);
}

export function studioDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

export function SuperadminOnly() {
  return (
    <div className="dash-card">
      <div className="dash-empty">
        <h2 className="dash-empty-title">
          Theme Studio is limited to superadmins
        </h2>
        <p className={`mx-auto mt-1 max-w-md text-sm ${STUDIO_TONE.muted}`}>
          Studio prompts, reference images and generated drafts are superadmin
          data. Ask a superadmin if you need a project opened.
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ plain text

/**
 * Stored words without a long dash: a model's summary or question, or a
 * finding measured before severity-v1 joined its examples with one. No
 * screen shows an em dash or an en dash (the product's dash rule); a range
 * of numbers reads "3 to 5", anything else a comma.
 */
export function plainText(text: string): string {
  return text
    .replace(/(\d)\s*\u2013\s*(\d)/g, "$1 to $2")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ");
}

// ------------------------------------------------------------ time and order

function time(iso: string | null | undefined): number {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : 0;
}

/** Newest first, whatever order the rows arrived in. */
function newestFirst<T>(rows: readonly T[], at: (row: T) => string): T[] {
  return [...rows].sort((a, b) => time(at(b)) - time(at(a)));
}

type EventLike = Pick<
  ThemeStudioEventView,
  "eventType" | "actorKind" | "createdAt" | "detail"
> & { runId?: string | null };

// ------------------------------------------------------------------ publishing

/** A publish attempt still `publishing` this long after it started is
 * abandoned, and "Try again" may start another: the server's own limit
 * (publication.ts ABANDONED_ATTEMPT_MINUTES, capture.ts
 * PUBLISH_IN_PROGRESS_MINUTES). */
export const PUBLISH_ATTEMPT_MINUTES = 15;

const PUBLISH_EVENTS = new Set([
  "publication_started",
  "publication_failed",
  "theme_published",
]);

/**
 * Whether a publish attempt is running now, read from Activity: its newest
 * publish event is `publication_started` (no failure or publish after it),
 * less than `PUBLISH_ATTEMPT_MINUTES` old. A publish that failed, or one
 * abandoned longer ago, is "Publish didn't finish".
 */
export function publishRunningFromEvents(
  events: readonly EventLike[],
  now: number = Date.now(),
): boolean {
  const [last] = newestFirst(
    events.filter((e) => PUBLISH_EVENTS.has(e.eventType)),
    (e) => e.createdAt,
  );
  return (
    last?.eventType === "publication_started" &&
    now - time(last.createdAt) < PUBLISH_ATTEMPT_MINUTES * 60_000
  );
}

// ------------------------------------------------------------------ questions

/**
 * Whether the theme waits for answers to questions the model asked: the
 * newest run is a finished clarification and no version was made current
 * since (which sets the questions aside). The client copy of the server's
 * rule (repository.ts `questionsOpen`); a theme that is `blocked` with no
 * questions open (its security check failed) can be changed straight away.
 */
export function questionsOpen(project: {
  runs: readonly Pick<
    ThemeStudioRunView,
    "status" | "questions" | "createdAt" | "finishedAt"
  >[];
  events: readonly Pick<ThemeStudioEventView, "eventType" | "createdAt">[];
}): boolean {
  const [latest] = newestFirst(project.runs, (r) => r.createdAt);
  if (!latest || latest.status !== "succeeded" || !latest.questions.length)
    return false;
  const asked = time(latest.finishedAt ?? latest.createdAt);
  return !project.events.some(
    (e) => e.eventType === "version_restored" && time(e.createdAt) >= asked,
  );
}

// ------------------------------------------------------------ work under way

/** What a `generating` theme is doing, as far as the operator started it. */
export type StudioWork =
  | "publish_recheck"
  | "check_again"
  | "checking_version"
  | "checking_pictures"
  | "capturing"
  | "building";

/** Events an operator's own click records when it starts work. The newest
 * one begins "the newest piece of work" the progress card shows
 * (lib/theme-studio/progress.ts reads the same list). */
export const STUDIO_WORK_STARTERS: readonly string[] = [
  "run_queued",
  "run_retried",
  "revision_requested",
  "details_added",
  "images_requested",
  "slot_images_replaced",
  "version_restored",
  "capture_requested",
];

const WORK_STARTERS: ReadonlySet<string> = new Set(STUDIO_WORK_STARTERS);

/**
 * What the theme is working on, from the newest piece of work an operator
 * started: a re-check before Publish or from Check again, a check of a
 * version made current or of saved pictures, a catalogue capture, or a build.
 * Null unless the theme is `generating`.
 */
export function workUnderway(project: {
  status: ThemeStudioProjectState;
  events: readonly EventLike[];
}): StudioWork | null {
  if (project.status !== "generating") return null;
  const [started] = newestFirst(
    project.events.filter(
      (e) => e.actorKind === "operator" && WORK_STARTERS.has(e.eventType),
    ),
    (e) => e.createdAt,
  );
  if (!started) return "building";
  const detail = started.detail ?? {};
  if (started.eventType === "capture_requested") {
    if (detail.recheck === "publish_recheck") return "publish_recheck";
    if (detail.recheck === "check_again") return "check_again";
    return "capturing";
  }
  if (started.eventType === "version_restored") {
    if (detail.outcome === "rechecking") return "check_again";
    if (detail.outcome === "checking") return "checking_version";
  }
  if (
    started.eventType === "slot_images_replaced" &&
    detail.automaticQa === true
  )
    return "checking_pictures";
  return "building";
}

/** Work that checks a design rather than building one. */
export function isCheckingWork(work: StudioWork | null): boolean {
  return (
    work === "publish_recheck" ||
    work === "check_again" ||
    work === "checking_version" ||
    work === "checking_pictures"
  );
}

const AWAY = "This takes about 3 to 5 minutes, and you can leave this page.";

const WORK_TEXT: Record<StudioWork, string> = {
  publish_recheck: `Re-checking on today's StoreMink build before publishing: the pages and the design review are measured again, nothing is redrawn. ${AWAY} Publish again once it is ready.`,
  check_again: `Checking this design again on today's StoreMink build: the pages and the design review are measured again, nothing is redrawn. ${AWAY}`,
  checking_version: `Checking the version you made current on today's StoreMink build, with fresh catalogue pictures and the design review. ${AWAY}`,
  checking_pictures: `Checking your new pictures: one capture of the storefront, then the design review. ${AWAY}`,
  capturing:
    "Capturing the catalogue pictures and checking the theme. You can leave this page and come back.",
  building:
    "Building your theme: designing it, drawing missing pictures, checking every page and the design, and fixing what it can by itself. You can leave this page and come back.",
};

export function workingText(work: StudioWork | null): string {
  return WORK_TEXT[work ?? "building"];
}

// ------------------------------------------------------------------ stop codes

export type StopKind = "run" | "capture" | "review";

/**
 * The plain sentence for a stop code of a run, a capture or the design
 * review. Every code StoreMink writes has its own; an unknown one gets its
 * kind's general sentence, so a screen never shows a raw code alone. The
 * sentences live in studio-words.ts (`stopReasonWords`); this name stays for
 * its importers.
 */
export function stopText(code: string | null | undefined, kind: StopKind) {
  return stopReasonWords(code, kind);
}

/** Every code with its own sentence, by kind (for tests and reviewers). */
export const STOP_CODES: Record<StopKind, readonly string[]> =
  STOP_REASON_CODES;

/** Stops a change to the theme can clear: a serious finding the automatic
 * fixes left, a security problem, a fix the automatic repair had no setting
 * or picture for, or an automatic fix that asked a question instead. */
const THEME_CHANGE_STOPS: ReadonlySet<string> = new Set([
  "quality_bar_not_met",
  "qa_no_progress",
  "repair_not_supported",
  "acceptance_security_failed",
  "auto_revision_clarified",
]);

/**
 * Whether a stopped check asks for a change to the theme. Every other stop
 * asks for something else: a check that could not finish or was stopped is
 * checked again, a fix in StoreMink's own code is ours to make, a photo is
 * redrawn. An unknown code never asks for a change, which would be paid for
 * and could not help (plan section 4: unknown codes read "Couldn't finish").
 */
export function stopNeedsThemeChange(code: string | null | undefined): boolean {
  return typeof code === "string" && THEME_CHANGE_STOPS.has(code);
}

/** The next step after a version's checks stopped, in one sentence: only a
 * stop a theme change can clear suggests describing a fix. */
export function stoppedNextStep(
  code: string | null | undefined,
  kind: StopKind = "review",
): string {
  if (stopNeedsThemeChange(code))
    return "Describe a fix in the chat, or press Check again once the cause is fixed.";
  if (code === "renderer_fix_required")
    return "It needs a fix in StoreMink's own storefront code, not in the theme: press Check again once StoreMink is updated.";
  if (code === "image_check_required")
    return "Redraw the photos it names on the Pictures tab, or press Check again.";
  if (kind === "run")
    return "Retry the stopped step from the Log tab, or press Check again.";
  return "Press Check again: the theme itself does not need a change.";
}

// ------------------------------------------------------------- design review

/**
 * How the automatic checks last ended for one version, from Activity: the
 * newest `auto_qa_passed` or `auto_qa_failed` naming it. The version's own
 * "passed" mark cannot be rewritten (migration 0144), so after a re-check it
 * is this, not the mark, that says where the version stands. Null when
 * Activity holds neither.
 */
export function checksOutcome(
  versionId: string,
  events: readonly EventLike[],
): { passed: boolean; code: string | null; kind: StopKind } | null {
  const [last] = newestFirst(
    events.filter(
      (e) =>
        (e.eventType === "auto_qa_passed" ||
          e.eventType === "auto_qa_failed") &&
        e.detail?.versionId === versionId,
    ),
    (e) => e.createdAt,
  );
  if (!last) return null;
  return {
    passed: last.eventType === "auto_qa_passed",
    code:
      typeof last.detail.errorCode === "string" ? last.detail.errorCode : null,
    // Run steps record the same event when they reveal their version.
    kind: last.detail.qaRunId || !last.runId ? "review" : "run",
  };
}

// ------------------------------------------------------------------- Activity

const ACTIVITY_WORDS: Record<string, string> = {
  project_created: "Created the theme",
  reference_added: "Added a screenshot",
  reference_removed: "Deleted an unused screenshot",
  run_started: "Started working",
  run_succeeded: "Finished a step",
  run_cancel_requested: "Asked a step to stop",
  run_cancelled: "Stopped a step",
  run_retried: "Tried a step again",
  project_archived: "Archived the theme",
  clarification_requested: "Asked you some questions",
  details_added: "Answered the questions",
  revision_requested: "Asked for a change",
  preview_created: "Opened a preview",
  preview_failed: "A preview could not be built",
  preview_expired: "A preview was removed",
  acceptance_started: "Started checking the pages",
  acceptance_passed: "The page checks passed",
  acceptance_failed: "The page checks found problems",
  acceptance_blocked: "The security check failed",
  slot_image_uploaded: "Uploaded a picture",
  capture_succeeded: "Captured the storefront",
  auto_qa_started: "Started the automatic checks",
  auto_qa_browser_finished: "Finished measuring the pages",
  auto_qa_revision_queued: "Fixing what the checks found",
};

/** Events from the two-person approval that ended on 3 Oct 2026: kept in the
 * database (events are append-only), never shown. */
const HIDDEN_EVENTS = new Set(["project_approved", "review_submitted"]);

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function versionWord(detail: Record<string, unknown>): string {
  const n = count(detail.versionNumber);
  return n === null ? "a version" : `version ${n}`;
}

/** One Activity line in plain words: what happened, and the stop sentence
 * with its code when something stopped. Null for a line that is hidden. */
export function activityLine(event: EventLike): {
  text: string;
  /** A stored reason, in plain text (a publish that did not finish). */
  note?: string;
  stop?: { sentence: string; code: string };
} | null {
  if (HIDDEN_EVENTS.has(event.eventType)) return null;
  const detail = event.detail ?? {};
  const code =
    typeof detail.errorCode === "string" && detail.errorCode
      ? detail.errorCode
      : null;
  const stop = (kind: StopKind) =>
    code ? { sentence: stopText(code, kind), code } : undefined;
  const worker = event.actorKind === "worker";
  switch (event.eventType) {
    case "run_queued":
      if (worker && detail.reason === "rate_limited")
        return { text: "Waiting for the model provider, then trying again" };
      if (worker && detail.reason === "image_review_unavailable")
        return { text: "Waiting to check the pictures, then trying again" };
      return { text: "Asked Theme Studio to build the theme" };
    case "run_failed":
      return { text: "A step stopped", stop: stop("run") };
    case "version_created":
      if (detail.automaticQa === true)
        return { text: "Made a draft for the automatic checks" };
      if (Array.isArray(detail.captured))
        return {
          text: `Captured the catalogue pictures as ${versionWord(detail)}`,
        };
      return { text: `Made ${versionWord(detail)}` };
    case "version_restored": {
      const base = `Made ${versionWord(detail)} current`;
      if (detail.outcome === "ready_to_publish")
        return { text: `${base}, Ready to publish` };
      if (detail.outcome === "rechecking")
        return { text: `${base}, checking it again on today's build` };
      if (detail.outcome === "checking")
        return { text: `${base}, checking it now` };
      return { text: base };
    }
    case "slot_images_replaced":
      return {
        text:
          detail.automaticQa === true
            ? `Saved new pictures as ${versionWord(detail)}, checking them now`
            : `Saved new pictures as ${versionWord(detail)}`,
      };
    case "images_requested":
      return {
        text: worker ? "Drawing missing pictures" : "Asked for new pictures",
      };
    case "capture_requested":
      if (detail.recheck === "publish_recheck")
        return {
          text: "Started checking again on today's build before publishing",
        };
      if (detail.recheck === "check_again")
        return { text: "Started checking again on today's build" };
      if (detail.reason === "acceptance_build_changed")
        return {
          text: "StoreMink was updated during the checks, so the pages are measured again",
        };
      return { text: "Started capturing the storefront" };
    case "capture_failed":
      return { text: "The capture stopped", stop: stop("capture") };
    case "auto_qa_passed": {
      const warnings = Array.isArray(detail.warnings)
        ? detail.warnings.length
        : 0;
      return {
        text: warnings
          ? `The automatic checks passed, with ${warnings} kind${warnings === 1 ? "" : "s"} of warning`
          : "The automatic checks passed",
      };
    }
    case "auto_qa_failed":
      return {
        text: "The automatic checks stopped",
        stop: stop(detail.qaRunId || !event.runId ? "review" : "run"),
      };
    case "publication_started":
      return {
        text:
          detail.resumed === true
            ? "Tried publishing again"
            : "Started publishing",
      };
    case "theme_published":
      return {
        text:
          typeof detail.releaseVersion === "string"
            ? `Published v${detail.releaseVersion}`
            : "Published the theme",
      };
    case "catalog_visibility_changed":
      return {
        text:
          detail.visibility === "hidden"
            ? "Hid it from new stores"
            : "Offered it to new stores again",
      };
    case "catalog_release_selected":
      return { text: "Changed the release new stores get" };
  }
  if (event.eventType === "publication_failed") {
    const [first] = Array.isArray(detail.problems) ? detail.problems : [];
    return typeof first === "string" && first
      ? { text: "Publish didn't finish", note: plainText(first) }
      : { text: "Publish didn't finish" };
  }
  const known = ACTIVITY_WORDS[event.eventType];
  if (known) return { text: known, stop: stop("run") };
  const words = event.eventType.replace(/_/g, " ");
  return { text: words.charAt(0).toUpperCase() + words.slice(1) };
}

/** Who did it, in Activity. */
export function activityActor(event: {
  actorKind: "operator" | "worker";
  actorEmail: string | null;
}): string {
  return event.actorKind === "worker"
    ? "Theme Studio"
    : (event.actorEmail ?? "An operator");
}

// ------------------------------------------------------------------- warnings

const WARNING_WORDS: Record<string, string> = {
  small_target: "Small buttons on phones",
  extreme_crop: "Photos cropped very tightly",
  lcp: "The main content is slow to show",
  cls: "Content moves while the page loads",
  clipped_text: "Text cut off by a pixel or two",
  over_budget: "Pictures larger than their size budget",
  preview_over_budget: "The catalogue picture is larger than its size budget",
  below_target: "Pictures narrower than their slot, so they can look soft",
  unused: "Files the theme does not use",
  indexable: "The preview page is missing its noindex tag",
  lang: "A page is missing its language in the markup",
  img_alt: "A picture is missing its description in the markup",
  "color-contrast": "Text the accessibility checker flagged, measured readable",
  contrast: "Text the accessibility checker flagged, measured readable",
  palette_only:
    "The design mostly changes colours, fonts or section order of an existing theme",
  generic_surface: "Some shop, product, cart or phone views look generic",
  needs_custom_code: "Parts of the design would need custom code",
  low_score: "A design review score below the bar",
  low_total: "The design review total is below the bar",
  revise_requested: "The design review asked for small changes",
  image_redraw: "A photo the picture check flagged for something small",
};

/** The words for a warning code on the checks or in the design review. An
 * accessibility rule without its own words is named as one. */
export function warningWords(code: string, gate?: string | null): string {
  const own = WARNING_WORDS[code];
  if (own) return own;
  if (gate === "browser.accessibility")
    return `A minor accessibility finding (${code})`;
  return `Another warning (${code})`;
}

const ROW_LABEL = new Map<string, string>(
  SCORECARD_DIMENSIONS.map((row) => [row.key, row.label]),
);

/** A place a warning was found, readable: the design review's rows by name. */
export function warningPlace(place: string): string {
  const [row, ...rest] = place.split(" ");
  const label = ROW_LABEL.get(row);
  return label ? [label, ...rest].join(" ") : place;
}
