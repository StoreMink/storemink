import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { STUDIO_WORK_STARTERS } from "@/app/platform/dashboard/(console)/themes/studio/studio-ui";
import {
  studioListFilter,
  studioStatus,
} from "@/app/platform/dashboard/(console)/themes/studio/studio-status";
import { stopReasonWords } from "@/app/platform/dashboard/(console)/themes/studio/studio-words";
import type { Db } from "@/lib/db/client";
import {
  currentAcceptanceBuildId,
  currentPublishEvidence,
  type PublishEvidence,
} from "./acceptance";
import {
  GATE_LABELS,
  THEME_STUDIO_QA_VIEWPORTS,
  gateBlocks,
  type GateFinding,
  type GateStatus,
} from "./acceptance-gates";
import { MAX_AUTOMATIC_QA_REPAIRS } from "./automatic-qa-policy";
import { recheckReasonOf } from "./capture-core";
import { CHROME_STATES } from "./chrome-states";
import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import { getThemeStudioConfig } from "./config";
import type { ThemeStudioProjectState } from "./contracts";
import { isPlatformFinding, isSeriousFinding } from "./finding-severity";
import type { ThemeStudioModelKey } from "./models";

// ---------------------------------------------------------------------------
// Theme Studio progress: the narrow reads behind the theme page's progress
// card and status words, the Theme Studio list, the build-time range and the
// check screenshots (wave TS-2, plan section 4; contract in
// revamp-handoff/scratchpad/progress/ts2-contract.md).
//
// ★ A READ, NEVER A WRITE. Every function takes the caller's `db` (the
// routes and pages open `withService` behind the superadmin gate) and only
// reads. No picture bytes (except readThemeStudioCheckScreenshot, which is
// the bytes of one screenshot), no whole theme file, no whole model answer
// and no whole browser report: narrow columns and JSON paths only. Image
// checkpoints are counted without reading `image_bytes`.
//
// ★ STATE COMES FROM THE NEWEST RECORDS, NEVER FROM THE VERSION'S OLD MARK.
// A re-check cannot rewrite a version's "passed" mark (migration 0144), so
// the status facts are read from the newest check run, design review,
// capture and run of the current version (re-check contract item 4).
//
// ★ A FIXED NUMBER OF QUERIES, NEVER ONE PER ROW. One query reads every
// project's facts (Q1), one the records of each project's newest piece of
// work (Q2: its runs, captures and design reviews, as narrow JSON), and two
// more fill caches of things that never change: the findings of a finished
// check run (Q3, by run id) and a version's missing pictures and catalogue
// card (Q4, by version id). The theme page adds currentPublishEvidence when
// it can decide a row (ready or Ready to publish, nothing working).
//
// ★ "THE NEWEST PIECE OF WORK" starts at the operator's newest start (the
// events studio-ui.tsx STUDIO_WORK_STARTERS lists, recorded by the operator),
// or the project's creation. Its records are the runs, captures and design
// reviews created since, plus whatever is still queued or running.
//
// ★ PLAIN TEXT ONLY. Every string a person reads (step labels, details,
// reasons) carries no em dash or en dash and never states a number of Mink
// credits. Codes stay codes; studio-words.ts turns them into sentences.
// ---------------------------------------------------------------------------

/** What a working theme is doing (status rows 5 and 6). */
export type StudioWorkKind =
  /** Queued, and no worker or capture job has picked it up yet. */
  | "waiting"
  /** A build or a change: designing, the layout check, drawing pictures, a
   * repair round, the final check or the design review of a new design. */
  | "building"
  /** Check again, or Publish's re-check, on today's StoreMink build
   * (capture.ts queueThemeStudioRecheck, reasons `check_again` and
   * `publish_recheck`). */
  | "rechecking"
  /** The photo check of unchecked photos before the final design review
   * (image-recovery.ts checkUncheckedPhotos; the design-review row carries
   * `vision_report.photoCheck` with state `checking` or `waiting`). */
  | "checking_pictures"
  /** The automatic check of an operator's own change that redesigns
   * nothing: saved pictures, a version made current that is checked again,
   * a manual photo run's final check. */
  | "checking_change";

/** Work under way (rows 5 and 6). */
export interface StudioStatusWorking {
  kind: StudioWorkKind;
  /** The running step's label (`ThemeStudioProgressStep.label`), for
   * "Building: drawing pictures"; null unless `kind` is "building". */
  step: string | null;
  /** When this piece of work started: the operator's start, or the queue
   * time while it waits (ISO 8601). */
  since: string;
  /** The newest record of progress (ISO 8601): a step started or finished,
   * a picture drawn (an image checkpoint), an event recorded. A lease
   * renewal is not progress: it moves `updated_at` on a live worker that
   * may be stuck. Row 6 ("Stuck since") compares it with `now`. */
  lastProgressAt: string;
  /** A real "next try at" time (ISO 8601): a run's `retry_not_before`
   * (provider cooldowns, review deferrals, provider waits), or a queued
   * design review's cooldown before its retry. Null when nothing is
   * waiting out a delay. Row 6 never applies while it is in the future. */
  nextTryAt: string | null;
}

/** Why the newest work on the theme stopped (rows 10, 12 and 17). */
export interface StudioStatusStop {
  /** Which record carries the code: a build step (theme_studio_runs), a
   * capture (theme_studio_captures) or the design review
   * (theme_studio_visual_qa_runs). */
  kind: "run" | "capture" | "review";
  /** The stored error code as written (`^[a-z0-9_]{1,64}$`), for example
   * `cancelled`, `checks_incomplete`, `quality_bar_not_met`,
   * `model_declined`. studio-words.ts turns it into a sentence; an unknown
   * code falls to row 12, never to "Describe a fix". */
  code: string;
  /** When it stopped (ISO 8601). */
  at: string;
  /** The run "Continue building" (row 10) and "Try again" (row 17) retry,
   * when `kind` is "run"; null otherwise. */
  runId: string | null;
}

/** The current version's newest check run and design review (rows 11, 14,
 * 15 and 16), and what they found. */
export interface StudioStatusChecks {
  /** The version these describe: the project's current version. */
  versionId: string;
  /** The newest check run of that version (theme_studio_acceptance_runs).
   * `running` covers `running` and `awaiting_browser`; `incomplete` covers
   * `error` and `expired`. `todaysBuild`: its build_id is
   * currentAcceptanceBuildId(). Null when no check ever ran on it. */
  checkRun: {
    id: string;
    state: "running" | "passed" | "failed" | "blocked" | "incomplete";
    build: string;
    todaysBuild: boolean;
    finishedAt: string | null;
  } | null;
  /** The newest FINAL design review of that version
   * (theme_studio_visual_qa_runs whose browser_report phase is final):
   * its row state, its own verdict (`vision_report.reviewSeverity.outcome`,
   * acceptance.ts readReviewSeverity; null on a review from before
   * severity-v1 or one that has not judged yet), and whether it judged
   * `checkRun` (`browser_report.acceptanceRunId` = checkRun.id). Null when
   * no final review exists. */
  review: {
    id: string;
    state: "queued" | "running" | "passed" | "failed" | "revision_queued";
    outcome: "pass" | "taste" | "serious" | null;
    boundToCheckRun: boolean;
  } | null;
  /** Serious problems left on that check run and review, counted as the
   * screens list them: the serious findings of blocking gates
   * (acceptance-gates.ts gateBlocks; finding-severity.ts isSeriousFinding,
   * a stored finding with no severity counts as serious) grouped by check
   * and code, a blocking gate with nothing serious in it as one, plus the
   * review's serious list (by code and row or picture). The list and the
   * theme page count the same way. */
  serious: number;
  /** Of `serious`, those in StoreMink's own storefront code (every finding
   * of the group is finding-severity.ts isPlatformFinding). Words only,
   * never severity. */
  seriousStoreMink: number;
  /** Of `serious`, those a picture redraw can clear: a flagged photo with a
   * hard problem, an unchecked photo, a missing, broken or too small
   * picture of a named slot, a picture still a placeholder. */
  seriousPictures: number;
  /** Warnings: the kinds of warning that go live with a publish, grouped as
   * the Publish dialog groups them (publication-core.ts publicationWarnings:
   * a check's code, or the review's code). */
  warnings: number;
  /** Row 11: serious > 0 and every serious finding is StoreMink's. */
  allSeriousAreStoreMink: boolean;
}

/** The newest picture run of the current version (row 13). */
export interface StudioStatusPictureRun {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  errorCode: string | null;
  finishedAt: string | null;
}

/**
 * Every fact the status function (studio-status.ts `studioStatus`, plan
 * section 4 "Status words", 19 rows, first match wins) needs, as one plain
 * JSON-serialisable object. The progress route sends it, the list sends one
 * per row, and the screens never derive a fact the server did not send.
 */
export interface StudioStatusInput {
  /** When these facts were read (ISO 8601, the database's clock). The
   * status function measures every age against it and never reads the
   * clock, so each row, the 15-minute publish boundary and the 20-minute
   * stuck rule included, is testable. A screen re-rendering between polls
   * may pass a newer `now` with the same facts. */
  now: string;
  /** theme_studio_projects.status, as stored. */
  projectStatus: ThemeStudioProjectState;
  /** theme_studio_projects.archived_at: non-null exactly when
   * `projectStatus` is "archived" ("Removed from list", row 4). Row 1
   * outranks it: an archived theme can still be live. */
  archivedAt: string | null;
  /** The project has a current version (current_version_id is set). */
  hasCurrentVersion: boolean;
  /** Row 1: the release this project published (its theme_studio_publications
   * row with status `published`), whatever the project's status; null when it
   * never published. `offered`: the theme's catalog entry is public
   * (theme_catalog_entries.visibility = 'public'); false reads "Not offered
   * to new stores". */
  release: { version: string; publishedAt: string; offered: boolean } | null;
  /** Rows 2 and 3: the newest publish attempt that has not published
   * (theme_studio_publications, status `publishing` or `failed`) while the
   * project waits on it (`projectStatus` "approved"); null otherwise. Row 2
   * while `state` is "publishing" and `lastWriteAt` (the row's updated_at,
   * the server's own abandonment clock, publication.ts) is less than
   * PUBLISH_ATTEMPT_MINUTES (15) before `now`; row 3 otherwise. `reasons`:
   * the attempt's stored failure lines, plain text, at most 3. */
  publishAttempt: {
    state: "publishing" | "failed";
    startedAt: string;
    lastWriteAt: string;
    reasons: string[];
  } | null;
  /** Rows 5 and 6: work under way; null when nothing is working. */
  working: StudioStatusWorking | null;
  /** Rows 7 and 8. `open`: the newest run ended by asking questions and no
   * version was made current since (repository.ts questionsOpen). `count`:
   * how many it asked. `askedAt`: when (its finished_at). `rounds`: rounds
   * of questions since the newest design was made. `tooManyRounds`: the
   * server would refuse another answer (repository.ts
   * MAX_REVISION_MESSAGES). */
  questions: {
    open: boolean;
    count: number;
    askedAt: string | null;
    rounds: number;
    tooManyRounds: boolean;
  };
  /** Rows 10, 12 and 17: why the newest work on the theme ended without
   * reaching Ready to publish: the newest settled record of the newest piece
   * of work (a build step, a capture or a design review, the operator's
   * newest start or the project's creation onwards), when it failed or was
   * stopped; a design review's hand-over to a re-capture after a deploy
   * (`acceptance_build_changed`) is not a stop. Null when that work
   * finished well or is still running. */
  stop: StudioStatusStop | null;
  /** Rows 11 and 14 (and 15 and 16 for the warning count); null when there
   * is no current version. */
  checks: StudioStatusChecks | null;
  /** Rows 15, 16 and 19: acceptance.ts `currentPublishEvidence` for the
   * current version, exactly (the list computes the same three conditions
   * in its own query without validating the theme file again). Null when
   * there is no current version, and when it cannot decide the row: it is
   * read only when `projectStatus` is ready or candidate, nothing is
   * working and nothing was published (it validates the whole theme file,
   * too heavy for every poll). */
  evidence: PublishEvidence | null;
  /** Row 13. `missing`: pictures the current version still needs drawn
   * (artwork placeholders, placeholders minus catalogue placeholders, plus
   * categories without a picture, as repository.ts packageSummary counts
   * them); catalogue pictures are not counted, every final capture takes
   * them. Counted with JSON paths in SQL, never by loading the theme file;
   * a version never changes, so the count is cached by version.
   * `lastRun`: the newest picture run of the current version (one drawing
   * on it, or the one that made it), or null. A failed one counts only while
   * it belongs to the newest piece of work: once a Check again, a Make
   * current or a change started since, it is history (Log tab), never a
   * reason to hold the theme at row 13. */
  pictures: { missing: number; lastRun: StudioStatusPictureRun | null };
  /** This deployment's switches (config.ts): `buildingOff` is
   * generationEnabled false; `modelOff`, the project's model is in
   * THEME_STUDIO_DISABLED_MODELS; `checksOff`, autoQaEnabled false (local
   * development only). Rows that need a switched-off thing say so and show
   * no main button. */
  switches: { buildingOff: boolean; modelOff: boolean; checksOff: boolean };
}

/** A progress-card row's key: one per named step, unique in a list.
 * `repair_<n>` is the nth repair round after a check. */
export type ThemeStudioProgressStepKey =
  /** The build or change run's first stage: reading the brief or the
   * change (its intent stage). */
  | "brief"
  /** Its second stage: designing, or changing, the pages (draft stage). */
  | "design"
  /** The layout capture and its check. */
  | "layout_check"
  /** Drawing missing pictures (picture runs and fill rounds). */
  | "pictures"
  /** "Fixing what the review found (round 2 of 3)". */
  | `repair_${number}`
  /** Checking unchecked photos before the final review. */
  | "photo_check"
  /** The final capture: catalogue pictures and the page checks. */
  | "final_check"
  /** The design review bound to that check. */
  | "design_review";

/** One row of the progress card. Every row comes from records that already
 * exist (runs, captures, design reviews, image checkpoints, events). */
export interface ThemeStudioProgressStep {
  key: ThemeStudioProgressStepKey;
  /** Plain words, for example "Read the brief", "Drawing pictures",
   * "Fixing what the review found (round 2 of 3)". Never a code. */
  label: string;
  state: "done" | "running" | "waiting" | "failed" | "skipped";
  /** One short plain line, or null: "8 of 18. Google is accepting pictures
   * slowly", "Fixed 2 problems", a stop sentence on a failed row. */
  detail: string | null;
  /** ISO 8601, or null while it has not started. */
  startedAt: string | null;
  /** ISO 8601, or null while it has not finished. */
  finishedAt: string | null;
  /** Only when the step really waits for a set time (ISO 8601), else null. */
  nextTryAt: string | null;
}

/** GET /api/platform/theme-studio/projects/[projectId]/progress answers this. */
export interface ThemeStudioProgress {
  projectId: string;
  /** theme_studio_projects.revision. */
  revision: number;
  /** Every operator-visible version (visibility `operator`), newest first by
   * version number: the set getThemeStudioProject returns. */
  versionIds: string[];
  currentVersionId: string | null;
  status: StudioStatusInput;
  /** The progress card's rows for the newest piece of work (since the
   * operator last started work, or the project was created): started rows
   * in the order they started, then the rows still to come; empty when
   * nothing was ever started. */
  steps: ThemeStudioProgressStep[];
  /** The newest change the read saw (ISO 8601): the latest of the project
   * row's updated_at, the newest event, every step's start and finish, the
   * newest publish attempt's updated_at and `status.working.lastProgressAt`. */
  updatedAt: string;
}

/** The Theme Studio list's filter chips. Every project is in "all" and in
 * exactly one of the others (studio-status.ts `studioListFilter`). */
export type ThemeStudioListFilter =
  | "all"
  | "needs_you"
  | "building"
  | "ready"
  | "live"
  | "archived";

/** Every filter, in the list's order. */
export const THEME_STUDIO_LIST_FILTERS: readonly ThemeStudioListFilter[] = [
  "all",
  "needs_you",
  "building",
  "ready",
  "live",
  "archived",
];

/** One row of the Theme Studio list. */
export interface ThemeStudioListRow {
  projectId: string;
  name: string;
  /** For the demo link (`demo-<themeId>`); shown nowhere else. */
  themeId: string;
  /** theme_studio_projects.updated_at (ISO 8601). */
  updatedAt: string;
  /** The same facts the theme page gets, so the list says the same words.
   * `evidence` is computed in the list's own query from the same three
   * conditions as currentPublishEvidence (newest check run passed over the
   * version's package, on today's build, with a passed final review bound
   * to it) without re-validating the theme file and its pictures, which
   * only Publish and the theme page need. */
  status: StudioStatusInput;
  /** The step working now, for the second line ("Drawing pictures, 8 of
   * 18"); null when nothing is working. */
  activeStep: ThemeStudioProgressStep | null;
  /** A same-origin address of the current version's captured catalogue card
   * (the public picture route); null while it is still a placeholder or
   * there is no version. */
  pictureUrl: string | null;
}

/** GET /api/platform/theme-studio/projects?filter= answers this. */
export interface ThemeStudioList {
  /** The rows of the asked filter, most recently changed first, at most 100. */
  rows: ThemeStudioListRow[];
  /** How many projects each chip holds; "all" is their total. */
  counts: Record<ThemeStudioListFilter, number>;
}

/** "Usually 35 to 75 minutes" on New theme and the progress card. */
export interface ThemeStudioBuildTimeRange {
  /** The shortest and longest of this deployment's last 10 finished builds
   * (from the first build run's creation to the first time the theme
   * reached Ready to publish), whole minutes, rounded outward to 5. */
  fromMinutes: number;
  toMinutes: number;
  /** 10 when measured; 0 when fewer than 10 builds finished. */
  basedOn: number;
  /** "default": fewer than 10 finished builds, so 35 to 75 minutes, the
   * 4 Oct 2026 benchmark (measured). */
  source: "measured" | "default";
}

/** One stored screenshot of a check (owner-approved, 24 Oct 2026). */
export interface ThemeStudioCheckScreenshotSample {
  /** theme_studio_assets.id (purpose `qa_screenshot`). */
  assetId: string;
  /** The page measured: an AcceptanceSurface (`home`, `shop`, `product`,
   * `cart`, `content`, `not_found`). */
  page: string;
  /** The screen width's key: an AcceptanceViewport (`phone360`,
   * `phone390`, `tablet768`, `laptop1024`, `desktop1440`). */
  viewport: string;
  /** The stored picture's own size in pixels (full page: at most 1440 wide,
   * often very tall). */
  width: number;
  height: number;
}

/**
 * The screenshots one check took, so the operator can see by eye that the
 * theme is responsive, phone-friendly and accurate (owner-approved, 24 Oct
 * 2026). GET .../check-screenshots?versionId= answers this.
 */
export interface ThemeStudioCheckScreenshots {
  /** The version asked for, or the current version when none was asked
   * for; null only when none was asked for and there is no current
   * version. */
  versionId: string | null;
  /** The check run the screenshots belong to (the design-review row's
   * `browser_report.acceptanceRunId`); null when no final check of the
   * version stored screenshots (layout checks store none). */
  checkRunId: string | null;
  /** When the check stored them (the design-review row's created_at). */
  capturedAt: string | null;
  /** The StoreMink build that rendered them (`browser_report.buildId`).
   * Shown only in Technical details. */
  build: string | null;
  coverage: {
    /** Pages measured, in the order measured, each once. */
    pages: string[];
    /** Screen widths measured in pixels, ascending, each once. */
    widths: number[];
    /** Header panels opened and measured on the home page (chrome-states.ts
     * keys: `menu`, `search`, `cart`, `account`, `sign_in`), in that order. */
    panels: string[];
    /** The cart page or the cart drawer was measured, and it was empty.
     * Today's capture never puts a product in the cart, so this is true
     * whenever either was measured; false when neither was. */
    cartWasEmpty: boolean;
  };
  /** In the order the check stored them (screenshot_asset_ids order). */
  samples: ThemeStudioCheckScreenshotSample[];
}

/** One stored check screenshot, for the bytes route. */
export interface ThemeStudioCheckScreenshotFile {
  bytes: Buffer;
  /** The stored media type: the capture's JPEG is re-encoded before it is
   * stored (visual-evidence.ts prepareVisualScreenshot), as WebP, or PNG
   * for a page taller than 16,383 px. Never a JPEG. */
  contentType: "image/webp" | "image/png";
}

// ------------------------------------------------------------------ constants

/** A revision reads at most this many messages, so the server refuses an
 * answer once a revision that asked holds this many (repository.ts
 * MAX_REVISION_MESSAGES, not exported; progress.test.ts reads that source
 * and fails if the two differ). */
export const MAX_REVISION_MESSAGES = 20;

/** A design review sent back after a failed try waits this long to be
 * claimed (visual-qa.ts QA_RETRY_COOLDOWN_SECONDS; progress.test.ts reads
 * that source and fails if the two differ, because importing visual-qa.ts
 * would load the review's model client into every poll). */
export const QA_RETRY_COOLDOWN_SECONDS = 60;

/** Rows the list returns for one filter (the list's limit since Phase 2). */
export const THEME_STUDIO_LIST_LIMIT = 100;

/** Projects the list reads to count its filters. */
const LIST_SCAN_LIMIT = 1000;

/** The 4 Oct 2026 production benchmark (measured): 35 to 75 minutes. */
const DEFAULT_BUILD_TIME: ThemeStudioBuildTimeRange = {
  fromMinutes: 35,
  toMinutes: 75,
  basedOn: 0,
  source: "default",
};

/** Builds the range is measured over. */
const BUILD_TIME_SAMPLE = 10;

const SECOND = 1000;

/** A project, version or asset id (repository.ts isUuid's rule). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------- helpers

/** A timestamp as ISO 8601 (Postgres text, JSON text or a Date). */
function toIso(value: unknown): string | null {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function msOf(iso: string | null | undefined): number {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : NaN;
}

function int(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : 0;
}

function maybeInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function latest(...values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (best === null || msOf(value) > msOf(best)) best = value;
  }
  return best;
}

/** A small bounded memo for things that never change (a finished check
 * run's findings, a version's pictures): the oldest entry goes first. */
const CACHE_LIMIT = 500;

function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

/** The SQL text of a JSON array at a path, or an empty array when the value
 * there is anything else (jsonb_array_elements refuses a non-array). */
function jsonArray(expression: SQL): SQL {
  return sql`(CASE WHEN jsonb_typeof(${expression}) = 'array' THEN ${expression} ELSE '[]'::jsonb END)`;
}

type RunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

const RUN_STATES: readonly string[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

function runState(value: unknown): RunState {
  return (RUN_STATES.includes(String(value)) ? value : "failed") as RunState;
}

// --------------------------------------------------- Q1: every project's facts

interface FactRow {
  readAt: unknown;
  projectId: string;
  name: string;
  themeId: string;
  status: string;
  archivedAt: unknown;
  revision: unknown;
  modelKey: string;
  createdAt: unknown;
  updatedAt: unknown;
  currentVersionId: string | null;
  currentPackageDigest: string | null;
  releaseVersion: string | null;
  releasedAt: unknown;
  catalogVisibility: string | null;
  attemptStatus: string | null;
  attemptStartedAt: unknown;
  attemptLastWriteAt: unknown;
  attemptReasons: unknown;
  latestRunKind: string | null;
  latestRunStatus: string | null;
  latestOutcomeKind: string | null;
  latestQuestionCount: unknown;
  latestRunFinishedAt: unknown;
  latestContextCount: unknown;
  questionsSetAside: boolean | null;
  questionRounds: unknown;
  checkRunId: string | null;
  checkRunStatus: string | null;
  checkRunBuild: string | null;
  checkRunFinishedAt: unknown;
  reviewId: string | null;
  reviewStatus: string | null;
  reviewOutcome: string | null;
  reviewAcceptanceRunId: string | null;
  reviewSerious: unknown;
  reviewWarnings: unknown;
  pictureRunId: string | null;
  pictureRunStatus: string | null;
  pictureRunError: string | null;
  pictureRunFinishedAt: unknown;
  verdictRunId: string | null;
  verdictRunStatus: string | null;
  verdictRunBuild: string | null;
  verdictRunDigest: string | null;
  verdictRunHasEvidence: boolean | null;
  boundReviewStatus: string | null;
  boundReviewDigest: string | null;
  boundReviewBuild: string | null;
  versionIds?: unknown;
}

/**
 * Q1. One row per project: the project row, its current version's digest,
 * its release and publish attempt, its newest run (questions), the newest
 * check run, final review and picture run of its current version, and the
 * newest check run that reached a verdict with the review bound to it (the
 * list's evidence). Narrow columns and JSON paths only: the review's
 * serious and warning lists are small arrays of codes.
 */
async function readFacts(
  db: Db,
  where: SQL,
  options: { versionIds: boolean; limit: number },
): Promise<FactRow[]> {
  const reviewSeverity = sql`q.vision_report -> 'reviewSeverity'`;
  const result = await db.execute(sql`
    SELECT clock_timestamp() AS "readAt",
      p.id AS "projectId", p.name, p.theme_id AS "themeId", p.status,
      p.archived_at AS "archivedAt", p.revision, p.model_key AS "modelKey",
      p.created_at AS "createdAt", p.updated_at AS "updatedAt",
      p.current_version_id AS "currentVersionId",
      cv.package_digest AS "currentPackageDigest",
      rel.release_version AS "releaseVersion", rel.completed_at AS "releasedAt",
      ce.visibility AS "catalogVisibility",
      att.status AS "attemptStatus", att.created_at AS "attemptStartedAt",
      att.updated_at AS "attemptLastWriteAt", att.reasons AS "attemptReasons",
      lr.kind AS "latestRunKind", lr.status AS "latestRunStatus",
      lr.outcome_kind AS "latestOutcomeKind",
      lr.question_count AS "latestQuestionCount",
      lr.finished_at AS "latestRunFinishedAt",
      lr.context_count AS "latestContextCount",
      (lr.finished_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM theme_studio_events e
         WHERE e.project_id = p.id AND e.event_type = 'version_restored'
           AND e.created_at >= lr.finished_at
      )) AS "questionsSetAside",
      (SELECT count(*)::int FROM theme_studio_runs r2
        WHERE r2.project_id = p.id AND r2.status = 'succeeded'
          AND r2.outcome_detail ->> 'kind' = 'clarify'
          AND r2.created_at > coalesce((
            SELECT max(v2.created_at) FROM theme_studio_versions v2
             WHERE v2.project_id = p.id
          ), '-infinity'::timestamptz)) AS "questionRounds",
      chk.id AS "checkRunId", chk.status AS "checkRunStatus",
      chk.build_id AS "checkRunBuild", chk.completed_at AS "checkRunFinishedAt",
      rev.id AS "reviewId", rev.status AS "reviewStatus",
      rev.outcome AS "reviewOutcome",
      rev.acceptance_run_id AS "reviewAcceptanceRunId",
      rev.serious AS "reviewSerious", rev.warnings AS "reviewWarnings",
      pic.id AS "pictureRunId", pic.status AS "pictureRunStatus",
      pic.error_code AS "pictureRunError", pic.finished_at AS "pictureRunFinishedAt",
      ver.id AS "verdictRunId", ver.status AS "verdictRunStatus",
      ver.build_id AS "verdictRunBuild", ver.package_digest AS "verdictRunDigest",
      ver.has_evidence AS "verdictRunHasEvidence",
      bound.status AS "boundReviewStatus", bound.package_digest AS "boundReviewDigest",
      bound.build_id AS "boundReviewBuild"
      ${
        options.versionIds
          ? sql`, ARRAY(
              SELECT v3.id FROM theme_studio_versions v3
               WHERE v3.project_id = p.id AND v3.visibility = 'operator'
               ORDER BY v3.version_number DESC
            ) AS "versionIds"`
          : sql``
      }
    FROM theme_studio_projects p
    LEFT JOIN theme_studio_versions cv
      ON cv.id = p.current_version_id AND cv.project_id = p.id
    LEFT JOIN LATERAL (
      SELECT pub.release_version, pub.completed_at
        FROM theme_studio_publications pub
       WHERE pub.project_id = p.id AND pub.status = 'published'
       ORDER BY pub.completed_at DESC NULLS LAST, pub.created_at DESC
       LIMIT 1
    ) rel ON true
    LEFT JOIN theme_catalog_entries ce
      ON rel.release_version IS NOT NULL AND ce.theme_id = p.theme_id
    LEFT JOIN LATERAL (
      SELECT pub.status, pub.created_at, pub.updated_at,
        ARRAY(
          SELECT left(f.value, 300)
            FROM jsonb_array_elements_text(${jsonArray(sql`pub.failure`)})
                 WITH ORDINALITY AS f(value, n)
           ORDER BY f.n LIMIT 3
        ) AS reasons
        FROM theme_studio_publications pub
       WHERE pub.project_id = p.id AND pub.status IN ('publishing', 'failed')
       ORDER BY pub.created_at DESC
       LIMIT 1
    ) att ON p.status = 'approved'
    LEFT JOIN LATERAL (
      SELECT r.kind, r.status, r.finished_at,
        r.outcome_detail ->> 'kind' AS outcome_kind,
        CASE WHEN jsonb_typeof(r.outcome_detail -> 'questions') = 'array'
          THEN jsonb_array_length(r.outcome_detail -> 'questions') ELSE 0 END
          AS question_count,
        cardinality(r.context_message_ids) AS context_count
        FROM theme_studio_runs r
       WHERE r.project_id = p.id
       ORDER BY r.created_at DESC
       LIMIT 1
    ) lr ON true
    LEFT JOIN LATERAL (
      SELECT a.id, a.status, a.build_id, a.completed_at
        FROM theme_studio_acceptance_runs a
       WHERE a.version_id = p.current_version_id AND a.project_id = p.id
       ORDER BY a.created_at DESC
       LIMIT 1
    ) chk ON true
    LEFT JOIN LATERAL (
      SELECT q.id, q.status,
        ${reviewSeverity} ->> 'outcome' AS outcome,
        q.browser_report ->> 'acceptanceRunId' AS acceptance_run_id,
        ${jsonArray(sql`${reviewSeverity} -> 'serious'`)} AS serious,
        ${jsonArray(sql`${reviewSeverity} -> 'warnings'`)} AS warnings
        FROM theme_studio_visual_qa_runs q
       WHERE q.version_id = p.current_version_id AND q.project_id = p.id
         AND coalesce(q.browser_report ->> 'phase', 'final') = 'final'
       ORDER BY q.created_at DESC, q.id DESC
       LIMIT 1
    ) rev ON true
    LEFT JOIN LATERAL (
      SELECT r.id, r.status, r.error_code, r.finished_at
        FROM theme_studio_runs r
       WHERE r.project_id = p.id AND r.kind = 'images'
         AND (r.base_version_id = p.current_version_id OR r.id = cv.run_id)
       ORDER BY r.created_at DESC
       LIMIT 1
    ) pic ON p.current_version_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT a.id, a.status, a.build_id, a.package_digest,
        (a.evidence_digest IS NOT NULL) AS has_evidence
        FROM theme_studio_acceptance_runs a
       WHERE a.version_id = p.current_version_id AND a.project_id = p.id
         AND a.status IN ('passed', 'failed', 'blocked')
       ORDER BY a.completed_at DESC NULLS LAST, a.created_at DESC
       LIMIT 1
    ) ver ON p.status IN ('ready', 'candidate')
    LEFT JOIN LATERAL (
      SELECT q.status, q.package_digest, q.browser_report ->> 'buildId' AS build_id
        FROM theme_studio_visual_qa_runs q
       WHERE q.version_id = p.current_version_id AND q.project_id = p.id
         AND coalesce(q.browser_report ->> 'phase', 'final') = 'final'
         AND q.browser_report ->> 'acceptanceRunId' = ver.id::text
       ORDER BY q.created_at DESC, q.id DESC
       LIMIT 1
    ) bound ON ver.id IS NOT NULL
    WHERE ${where}
    ORDER BY p.updated_at DESC, p.id
    LIMIT ${options.limit}
  `);
  return result.rows as unknown as FactRow[];
}

// ----------------------------------------- Q2: the newest piece of work

interface PieceRun {
  id: string;
  kind: "generate" | "revise" | "images";
  status: RunState;
  errorCode: string | null;
  automatic: boolean;
  qaIteration: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  retryNotBefore: string | null;
  rateLimitDeferrals: number;
  retryOfRunId: string | null;
  slotIds: number;
  outcomeKind: string | null;
  outcomeStage: string | null;
  questions: number;
  intentMs: number | null;
  draftMs: number | null;
  drawn: number;
  checkpointAt: string | null;
  responses: number;
  firstResponseAt: string | null;
  lastResponseAt: string | null;
  slotsRequested: number | null;
  outcomeSlots: number | null;
  generated: number | null;
}

interface PieceCapture {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  errorCode: string | null;
  phase: "layout" | "final";
  versionId: string;
  key: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
}

interface PieceReview {
  id: string;
  status: "queued" | "running" | "passed" | "failed" | "revision_queued";
  errorCode: string | null;
  phase: "layout" | "final";
  versionId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  photoState: "checking" | "waiting" | "failed" | null;
  photoUnchecked: number | null;
  revisionRunId: string | null;
  repairs: number;
}

interface Piece {
  projectId: string;
  /** The operator's newest start, or the project's creation. */
  since: string;
  starter: {
    type: string;
    recheck: string | null;
    outcome: string | null;
    automaticQa: boolean;
  } | null;
  lastEventAt: string | null;
  runs: PieceRun[];
  captures: PieceCapture[];
  reviews: PieceReview[];
}

/**
 * Q2. For each project, the newest piece of work as one narrow JSON value:
 * when it started, the start event's own facts (a re-check's reason, Make
 * current's outcome, saved pictures being checked), the newest event since,
 * and the runs, captures and design reviews created since (plus any still
 * queued or running). A run carries its stage times from its usage
 * telemetry (`usage.calls[].durationMs`), how many pictures its checkpoints
 * hold (counted, never `image_bytes`), how many saved model answers it has
 * (their times only) and the slots it was asked to draw; a design review
 * its photo-check marker and how many repairs it asked for.
 */
async function readPieces(
  db: Db,
  projectIds: readonly string[],
): Promise<Map<string, Piece>> {
  const pieces = new Map<string, Piece>();
  if (!projectIds.length) return pieces;
  const calls = (stage: string) => sql`(
    SELECT sum((c ->> 'durationMs')::numeric)
      FROM jsonb_array_elements(${jsonArray(sql`r.usage -> 'calls'`)}) c
     WHERE c ->> 'stage' = ${stage} AND jsonb_typeof(c -> 'durationMs') = 'number'
  )`;
  const result = await db.execute(sql`
    WITH proj AS (
      SELECT p.id AS project_id, coalesce(st.created_at, p.created_at) AS since,
        st.event_type AS starter, st.recheck, st.outcome, st.automatic_qa
        FROM theme_studio_projects p
        LEFT JOIN LATERAL (
          SELECT e.created_at, e.event_type,
            e.detail ->> 'recheck' AS recheck,
            e.detail ->> 'outcome' AS outcome,
            e.detail ->> 'automaticQa' AS automatic_qa
            FROM theme_studio_events e
           WHERE e.project_id = p.id AND e.actor_kind = 'operator'
             AND e.event_type = ANY(${sql.param([...STUDIO_WORK_STARTERS])}::text[])
           -- Make current and saved pictures record their capture in the
           -- same transaction (one timestamp): the operator's own action
           -- names the work, so a capture_requested loses a tie.
           ORDER BY e.created_at DESC, (e.event_type = 'capture_requested'), e.id DESC
           LIMIT 1
        ) st ON true
       WHERE p.id = ANY(${sql.param([...projectIds])}::uuid[])
    )
    SELECT proj.project_id AS "projectId", jsonb_build_object(
      'since', proj.since,
      'starter', proj.starter,
      'recheck', proj.recheck,
      'outcome', proj.outcome,
      'automaticQa', proj.automatic_qa,
      'lastEventAt', (
        SELECT max(e.created_at) FROM theme_studio_events e
         WHERE e.project_id = proj.project_id AND e.created_at >= proj.since
      ),
      'runs', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', r.id, 'kind', r.kind, 'status', r.status,
          'errorCode', r.error_code, 'automatic', r.automatic,
          'qaIteration', r.qa_iteration, 'createdAt', r.created_at,
          'startedAt', r.started_at, 'finishedAt', r.finished_at,
          'updatedAt', r.updated_at, 'retryNotBefore', r.retry_not_before,
          'rateLimitDeferrals', r.rate_limit_deferrals,
          'retryOfRunId', r.retry_of_run_id,
          'slotIds', cardinality(r.image_slot_ids),
          'outcomeKind', r.outcome_detail ->> 'kind',
          'outcomeStage', r.outcome_detail ->> 'stage',
          'questions', CASE WHEN jsonb_typeof(r.outcome_detail -> 'questions') = 'array'
            THEN jsonb_array_length(r.outcome_detail -> 'questions') ELSE 0 END,
          'intentMs', CASE WHEN r.kind <> 'images' THEN ${calls("intent")} END,
          'draftMs', CASE WHEN r.kind <> 'images' THEN ${calls("draft")} END,
          'drawn', CASE WHEN r.kind = 'images' THEN (
            SELECT count(*) FROM theme_studio_image_checkpoints k
             WHERE k.run_id = r.id AND k.response_json ->> 'stage' = 'draw'
               AND k.response_json -> 'response' ->> 'kind' = 'ok'
          ) ELSE 0 END,
          'checkpointAt', CASE WHEN r.kind = 'images' THEN (
            SELECT max(k.created_at) FROM theme_studio_image_checkpoints k
             WHERE k.run_id = r.id
          ) END,
          'responses', CASE WHEN r.kind <> 'images' THEN (
            SELECT count(*) FROM theme_studio_generation_responses g WHERE g.run_id = r.id
          ) ELSE 0 END,
          'firstResponseAt', CASE WHEN r.kind <> 'images' THEN (
            SELECT min(g.created_at) FROM theme_studio_generation_responses g WHERE g.run_id = r.id
          ) END,
          'lastResponseAt', CASE WHEN r.kind <> 'images' THEN (
            SELECT max(g.created_at) FROM theme_studio_generation_responses g WHERE g.run_id = r.id
          ) END,
          'slotsRequested', CASE WHEN r.kind = 'images' THEN (
            SELECT e.detail ->> 'slots' FROM theme_studio_events e
             WHERE e.project_id = r.project_id AND e.run_id = r.id
               AND e.event_type = 'images_requested'
             ORDER BY e.created_at LIMIT 1
          ) END,
          'outcomeSlots', CASE WHEN jsonb_typeof(r.outcome_detail -> 'outcomes') = 'array'
            THEN jsonb_array_length(r.outcome_detail -> 'outcomes') END,
          'generated', CASE WHEN jsonb_typeof(r.outcome_detail -> 'outcomes') = 'array' THEN (
            SELECT count(*) FROM jsonb_array_elements(r.outcome_detail -> 'outcomes') o
             WHERE o ->> 'status' = 'generated'
          ) END
        ) ORDER BY r.created_at, r.id)
          FROM theme_studio_runs r
         WHERE r.project_id = proj.project_id
           AND (r.created_at >= proj.since OR r.status IN ('queued', 'running'))
      ), '[]'::jsonb),
      'captures', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', c.id, 'status', c.status, 'errorCode', c.error_code,
          'phase', c.phase, 'versionId', c.version_id, 'key', c.idempotency_key,
          'createdAt', c.created_at, 'startedAt', c.started_at,
          'finishedAt', c.finished_at, 'updatedAt', c.updated_at
        ) ORDER BY c.created_at, c.id)
          FROM theme_studio_captures c
         WHERE c.project_id = proj.project_id
           AND (c.created_at >= proj.since OR c.status IN ('queued', 'running'))
      ), '[]'::jsonb),
      'reviews', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', q.id, 'status', q.status, 'errorCode', q.error_code,
          'phase', coalesce(q.browser_report ->> 'phase', 'final'),
          'versionId', q.version_id, 'createdAt', q.created_at,
          'startedAt', q.started_at, 'finishedAt', q.finished_at,
          'updatedAt', q.updated_at,
          'photoState', q.vision_report -> 'photoCheck' ->> 'state',
          'photoUnchecked', q.vision_report -> 'photoCheck' ->> 'unchecked',
          'revisionRunId', q.revision_run_id,
          'repairs', CASE WHEN jsonb_typeof(q.vision_report -> 'repairs') = 'array'
            THEN jsonb_array_length(q.vision_report -> 'repairs') ELSE 0 END
        ) ORDER BY q.created_at, q.id)
          FROM theme_studio_visual_qa_runs q
         WHERE q.project_id = proj.project_id
           AND (q.created_at >= proj.since OR q.status IN ('queued', 'running'))
      ), '[]'::jsonb)
    ) AS "piece"
    FROM proj
  `);
  for (const row of result.rows as { projectId: string; piece: unknown }[]) {
    pieces.set(row.projectId, readPiece(row.projectId, row.piece));
  }
  return pieces;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function readPiece(projectId: string, value: unknown): Piece {
  const raw = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const starterType = text(raw.starter);
  return {
    projectId,
    since: toIso(raw.since) ?? new Date(0).toISOString(),
    starter: starterType
      ? {
          type: starterType,
          recheck: text(raw.recheck),
          outcome: text(raw.outcome),
          automaticQa: raw.automaticQa === "true",
        }
      : null,
    lastEventAt: toIso(raw.lastEventAt),
    runs: list(raw.runs).map((r) => ({
      id: String(r.id),
      kind: (["generate", "revise", "images"].includes(String(r.kind))
        ? r.kind
        : "generate") as PieceRun["kind"],
      status: runState(r.status),
      errorCode: text(r.errorCode),
      automatic: r.automatic === true,
      qaIteration: int(r.qaIteration),
      createdAt: toIso(r.createdAt) ?? new Date(0).toISOString(),
      startedAt: toIso(r.startedAt),
      finishedAt: toIso(r.finishedAt),
      updatedAt: toIso(r.updatedAt),
      retryNotBefore: toIso(r.retryNotBefore),
      rateLimitDeferrals: int(r.rateLimitDeferrals),
      retryOfRunId: text(r.retryOfRunId),
      slotIds: int(r.slotIds),
      outcomeKind: text(r.outcomeKind),
      outcomeStage: text(r.outcomeStage),
      questions: int(r.questions),
      intentMs: maybeInt(r.intentMs),
      draftMs: maybeInt(r.draftMs),
      drawn: int(r.drawn),
      checkpointAt: toIso(r.checkpointAt),
      responses: int(r.responses),
      firstResponseAt: toIso(r.firstResponseAt),
      lastResponseAt: toIso(r.lastResponseAt),
      slotsRequested: maybeInt(r.slotsRequested),
      outcomeSlots: maybeInt(r.outcomeSlots),
      generated: maybeInt(r.generated),
    })),
    captures: list(raw.captures).map((c) => ({
      id: String(c.id),
      status: (["queued", "running", "succeeded", "failed"].includes(
        String(c.status),
      )
        ? c.status
        : "failed") as PieceCapture["status"],
      errorCode: text(c.errorCode),
      phase: c.phase === "layout" ? "layout" : "final",
      versionId: String(c.versionId),
      key: String(c.key ?? ""),
      createdAt: toIso(c.createdAt) ?? new Date(0).toISOString(),
      startedAt: toIso(c.startedAt),
      finishedAt: toIso(c.finishedAt),
      updatedAt: toIso(c.updatedAt),
    })),
    reviews: list(raw.reviews).map((q) => ({
      id: String(q.id),
      status: ([
        "queued",
        "running",
        "passed",
        "failed",
        "revision_queued",
      ].includes(String(q.status))
        ? q.status
        : "failed") as PieceReview["status"],
      errorCode: text(q.errorCode),
      phase: q.phase === "layout" ? "layout" : "final",
      versionId: String(q.versionId),
      createdAt: toIso(q.createdAt) ?? new Date(0).toISOString(),
      startedAt: toIso(q.startedAt),
      finishedAt: toIso(q.finishedAt),
      updatedAt: toIso(q.updatedAt),
      photoState: (["checking", "waiting", "failed"].includes(
        String(q.photoState),
      )
        ? q.photoState
        : null) as PieceReview["photoState"],
      photoUnchecked: maybeInt(q.photoUnchecked),
      revisionRunId: text(q.revisionRunId),
      repairs: int(q.repairs),
    })),
  };
}

// ------------------------------------- Q3: what a check run found, counted

/** One kind of problem or warning, as the screens group them. */
interface FindingKind {
  key: string;
  storeMink: boolean;
  picture: boolean;
}

interface CheckRunCounts {
  serious: FindingKind[];
  /** Warning kinds, keyed as publicationWarnings groups them. */
  warnings: string[];
}

/** Codes a picture redraw can clear, by check: a named slot's picture is
 * missing, too small or in the wrong format, or still a placeholder. */
const PICTURE_FINDINGS: Readonly<Record<string, readonly string[]>> = {
  "assets.integrity": [
    "missing",
    "too_small",
    "wrong_format",
    "format",
    "size",
  ],
  "assets.provenance": ["placeholder"],
};

/** Review findings a redraw clears. */
const PICTURE_REVIEW_CODES: ReadonlySet<string> = new Set([
  "image_unchecked",
  "image_hard_problem",
]);

const checkRunCache = new Map<string, CheckRunCounts>();

/** A check run's status that never changes again (its counts are cached). */
const FINISHED_RUN_STATES: ReadonlySet<string> = new Set([
  "passed",
  "failed",
  "blocked",
  "error",
  "expired",
]);

interface StoredGate {
  id: string;
  required: boolean;
  status: string;
  findingsArray: boolean;
  findings: {
    code: string;
    severity?: unknown;
    where?: string;
    targets?: string[];
    contrast?: { target: string }[];
  }[];
}

/** Judge one check run's stored gates the way the server does
 * (acceptance-gates.ts gateBlocks, finding-severity.ts), grouped by kind. */
export function countCheckRunFindings(
  gates: readonly StoredGate[],
): CheckRunCounts {
  const serious = new Map<string, FindingKind>();
  const warnings = new Set<string>();
  for (const gate of gates) {
    // readAcceptanceReport's own filter: a known check with a findings list.
    if (!(gate.id in GATE_LABELS) || !gate.findingsArray) continue;
    // Only what the rules read: a severity that is not "minor" (none at
    // all, from before severity-v1, included) counts as serious.
    const findings: GateFinding[] = gate.findings.map((f) => ({
      code: f.code,
      message: "",
      ...(typeof f.where === "string" ? { where: f.where } : {}),
      ...(Array.isArray(f.targets) ? { targets: f.targets } : {}),
      ...(Array.isArray(f.contrast)
        ? {
            contrast: f.contrast.map((c) => ({
              target: c.target,
              ratio: Number.NaN,
              required: Number.NaN,
            })),
          }
        : {}),
      ...(f.severity === "minor" || f.severity === "serious"
        ? { severity: f.severity }
        : {}),
    }));
    const blocks = gateBlocks({
      required: gate.required,
      status: gate.status as GateStatus,
      findings,
    });
    if (!blocks) {
      for (const finding of findings)
        warnings.add(`checks|${gate.id}|${finding.code}`);
      continue;
    }
    const seriousFindings = findings.filter(isSeriousFinding);
    if (!seriousFindings.length) {
      serious.set(`checks|${gate.id}|`, {
        key: `checks|${gate.id}|`,
        storeMink: false,
        picture: false,
      });
      continue;
    }
    for (const finding of seriousFindings) {
      const key = `checks|${gate.id}|${finding.code}`;
      const platform = isPlatformFinding(gate.id, finding);
      const existing = serious.get(key);
      serious.set(key, {
        key,
        storeMink: existing ? existing.storeMink && platform : platform,
        picture: (PICTURE_FINDINGS[gate.id] ?? []).includes(finding.code),
      });
    }
  }
  return { serious: [...serious.values()], warnings: [...warnings] };
}

/** Q3. The narrow projection of each check run's gates (id, required,
 * status) and findings (code, severity, place, selectors): never messages,
 * metrics or the browser's samples. Finished runs come from the cache. */
async function readCheckRunCounts(
  db: Db,
  runs: readonly { id: string; status: string }[],
): Promise<Map<string, CheckRunCounts>> {
  const out = new Map<string, CheckRunCounts>();
  const missing: string[] = [];
  for (const run of runs) {
    const cached = FINISHED_RUN_STATES.has(run.status)
      ? checkRunCache.get(run.id)
      : undefined;
    if (cached) out.set(run.id, cached);
    else if (!missing.includes(run.id)) missing.push(run.id);
  }
  if (!missing.length) return out;
  const result = await db.execute(sql`
    SELECT a.id, a.status, coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', g ->> 'id',
        'required', coalesce((g -> 'required') = 'true'::jsonb, false),
        'status', g ->> 'status',
        'findingsArray', jsonb_typeof(g -> 'findings') = 'array',
        'findings', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'code', f ->> 'code',
            'severity', f -> 'severity',
            'where', f ->> 'where',
            'targets', CASE WHEN jsonb_typeof(f -> 'targets') = 'array'
              THEN f -> 'targets' END,
            'contrast', CASE WHEN jsonb_typeof(f -> 'contrast') = 'array' THEN (
              SELECT coalesce(jsonb_agg(jsonb_build_object('target', c ->> 'target')), '[]'::jsonb)
                FROM jsonb_array_elements(f -> 'contrast') c
            ) END
          ) ORDER BY fo)
            FROM jsonb_array_elements(${jsonArray(sql`g -> 'findings'`)})
                 WITH ORDINALITY AS ff(f, fo)
        ), '[]'::jsonb)
      ) ORDER BY go)
        FROM jsonb_array_elements(
          ${jsonArray(sql`a.server_report -> 'gates'`)} ||
          ${jsonArray(sql`a.browser_report -> 'gates'`)}
        ) WITH ORDINALITY AS gg(g, go)
    ), '[]'::jsonb) AS gates
      FROM theme_studio_acceptance_runs a
     WHERE a.id = ANY(${sql.param(missing)}::uuid[])
  `);
  for (const row of result.rows as {
    id: string;
    status: string;
    gates: unknown;
  }[]) {
    const gates: StoredGate[] = list(row.gates).map((g) => ({
      id: String(g.id ?? ""),
      required: g.required === true,
      status: String(g.status ?? ""),
      findingsArray: g.findingsArray === true,
      findings: list(g.findings).map((f) => ({
        code: String(f.code ?? ""),
        severity: f.severity,
        ...(typeof f.where === "string" ? { where: f.where } : {}),
        ...(Array.isArray(f.targets)
          ? {
              targets: f.targets.filter(
                (t): t is string => typeof t === "string",
              ),
            }
          : {}),
        ...(Array.isArray(f.contrast)
          ? {
              contrast: list(f.contrast).map((c) => ({
                target: typeof c.target === "string" ? c.target : "",
              })),
            }
          : {}),
      })),
    }));
    const counts = countCheckRunFindings(gates);
    out.set(row.id, counts);
    if (FINISHED_RUN_STATES.has(row.status))
      remember(checkRunCache, row.id, counts);
  }
  return out;
}

// --------------------------------- Q4: a version's pictures and catalogue card

interface VersionFacts {
  missing: number;
  previewAssetId: string | null;
}

const versionCache = new Map<string, VersionFacts>();

/** Q4. Per version, by JSON paths over its stored package (never loaded
 * into this process): artwork placeholders (placeholders whose path is not
 * a catalogue picture's) plus categories without a picture, and the stored
 * picture behind the catalogue card when it is no longer a placeholder.
 * A version never changes, so the answer is cached by version and digest. */
async function readVersionFacts(
  db: Db,
  versions: readonly { id: string; digest: string | null }[],
): Promise<Map<string, VersionFacts>> {
  const out = new Map<string, VersionFacts>();
  const missing: string[] = [];
  for (const version of versions) {
    const cached = versionCache.get(`${version.id}:${version.digest ?? ""}`);
    if (cached) out.set(version.id, cached);
    else if (!missing.includes(version.id)) missing.push(version.id);
  }
  if (!missing.length) return out;
  const assets = jsonArray(sql`v.package_json -> 'assets'`);
  const catalogPaths = sql`(ARRAY[coalesce(v.package_json #>> '{definition,catalog,previewImage}', '')] || ARRAY(
    SELECT coalesce(s ->> 'src', '')
      FROM jsonb_array_elements(${jsonArray(sql`v.package_json #> '{definition,catalog,screenshots}'`)}) s
  ))`;
  const result = await db.execute(sql`
    SELECT v.id, v.package_digest AS digest,
      (SELECT count(*)::int FROM jsonb_array_elements(${assets}) a
        WHERE a ->> 'licenseNote' = ${PLACEHOLDER_LICENSE_NOTE}
          AND NOT (coalesce(a ->> 'path', '') = ANY(${catalogPaths}))) AS art,
      (SELECT count(*)::int
         FROM jsonb_array_elements(${jsonArray(sql`v.package_json #> '{definition,preset,sampleData,categories}'`)}) c
        WHERE coalesce(btrim(c ->> 'image_url'), '') = '') AS categories,
      (SELECT x.id FROM theme_studio_assets x
        WHERE x.project_id = v.project_id AND x.purpose = 'image'
          AND x.sha256 = (
            SELECT a ->> 'sha256' FROM jsonb_array_elements(${assets}) a
             WHERE a ->> 'path' = v.package_json #>> '{definition,catalog,previewImage}'
               AND coalesce(a ->> 'licenseNote', '') <> ${PLACEHOLDER_LICENSE_NOTE}
             LIMIT 1)
        LIMIT 1) AS "previewAssetId"
      FROM theme_studio_versions v
     WHERE v.id = ANY(${sql.param(missing)}::uuid[])
  `);
  for (const row of result.rows as {
    id: string;
    digest: string | null;
    art: unknown;
    categories: unknown;
    previewAssetId: string | null;
  }[]) {
    const facts = {
      missing: int(row.art) + int(row.categories),
      previewAssetId: text(row.previewAssetId),
    };
    out.set(row.id, facts);
    remember(versionCache, `${row.id}:${row.digest ?? ""}`, facts);
  }
  return out;
}

/** Forget the cached findings and pictures (tests only). */
export function resetThemeStudioProgressCaches(): void {
  checkRunCache.clear();
  versionCache.clear();
}

// ---------------------------------------------------------- the steps

const REPAIRS = MAX_AUTOMATIC_QA_REPAIRS;

type StepState = ThemeStudioProgressStep["state"];

/** Canonical order of the named steps. */
const STEP_ORDER: readonly string[] = [
  "brief",
  "design",
  "layout_check",
  "repair",
  "pictures",
  "photo_check",
  "final_check",
  "design_review",
];

function orderOf(key: ThemeStudioProgressStepKey): number {
  return STEP_ORDER.indexOf(key.startsWith("repair_") ? "repair" : key);
}

function labelFor(
  key: ThemeStudioProgressStepKey,
  state: StepState,
  variant: {
    change?: boolean;
    answer?: boolean;
    recheck?: boolean;
    round?: number;
    phase?: "layout" | "final";
  } = {},
): string {
  const doing = state === "running" || state === "waiting";
  const done = state === "done";
  switch (key) {
    case "brief":
      if (variant.answer)
        return state === "running" ? "Reading your answer" : "Read your answer";
      if (variant.change)
        return state === "running" ? "Reading your change" : "Read your change";
      return state === "running" ? "Reading the brief" : "Read the brief";
    case "design":
      if (variant.change)
        return state === "running"
          ? "Changing the pages"
          : done
            ? "Changed the pages"
            : "Change the pages";
      return state === "running"
        ? "Designing the pages"
        : done
          ? "Designed the pages"
          : "Design the pages";
    case "layout_check":
      return state === "running" ? "Checking the layout" : "Layout check";
    case "pictures":
      return state === "running"
        ? "Drawing pictures"
        : done
          ? "Drew the pictures"
          : "Draw the pictures";
    case "photo_check":
      return state === "running"
        ? "Checking pictures"
        : done
          ? "Checked the pictures"
          : "Check the pictures";
    case "final_check":
      if (variant.recheck)
        return state === "running"
          ? "Checking every page on today's build"
          : done
            ? "Checked every page on today's build"
            : "Check every page on today's build";
      return state === "running"
        ? "Taking catalogue pictures and checking every page"
        : "Catalogue pictures and final checks";
    case "design_review":
      return state === "running" ? "Reviewing the design" : "Design review";
    default: {
      const found =
        variant.phase === "layout"
          ? "the layout check found"
          : "the review found";
      const round = `(round ${variant.round ?? 1} of ${REPAIRS})`;
      return doing || state === "failed"
        ? `Fixing what ${found} ${round}`
        : `Fixed what ${found} ${round}`;
    }
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function step(
  key: ThemeStudioProgressStepKey,
  state: StepState,
  fields: Partial<Omit<ThemeStudioProgressStep, "key" | "state" | "label">> & {
    label: string;
  },
): ThemeStudioProgressStep {
  return {
    key,
    label: fields.label,
    state,
    detail: fields.detail ?? null,
    startedAt: fields.startedAt ?? null,
    finishedAt: fields.finishedAt ?? null,
    nextTryAt: fields.nextTryAt ?? null,
  };
}

function isActive(status: string): boolean {
  return status === "queued" || status === "running";
}

/** The run a design review asked to repair it (its revision_run_id), the
 * phase that asked, and retries of it. */
function repairsOf(piece: Piece): Map<string, "layout" | "final"> {
  const repairs = new Map<string, "layout" | "final">();
  for (const review of piece.reviews)
    if (review.revisionRunId) repairs.set(review.revisionRunId, review.phase);
  for (const run of piece.runs) {
    if (repairs.has(run.id)) continue;
    const of = run.retryOfRunId ? repairs.get(run.retryOfRunId) : undefined;
    if (of) repairs.set(run.id, of);
    else if (run.kind === "revise" && run.automatic)
      repairs.set(run.id, "final");
  }
  return repairs;
}

interface StepContext {
  nowIso: string;
  checksOn: boolean;
  working: boolean;
}

/** A time still to come, or null: a next try already past is not a wait
 * (the work is ready and waits only for a worker to claim it). */
function stillAhead(at: string | null, nowIso: string): string | null {
  return at !== null && msOf(at) > msOf(nowIso) ? at : null;
}

/** A queued design review that tried before waits out its cooldown. */
function reviewNextTry(review: PieceReview, nowIso: string): string | null {
  if (review.status !== "queued" || !review.startedAt || !review.updatedAt)
    return null;
  return stillAhead(
    new Date(
      msOf(review.updatedAt) + QA_RETRY_COOLDOWN_SECONDS * SECOND,
    ).toISOString(),
    nowIso,
  );
}

/** A run that waits for a set time (a provider cooldown, a deferral). */
function runNextTry(run: PieceRun, nowIso: string): string | null {
  return run.status === "queued"
    ? stillAhead(run.retryNotBefore, nowIso)
    : null;
}

function runStopWords(run: PieceRun): string {
  return stopReasonWords(
    run.status === "cancelled" ? "cancelled" : run.errorCode,
    "run",
  );
}

/** "8 of 18", plus "Google is accepting pictures slowly" after a 429. The
 * next try is the step's own `nextTryAt` (the card words it), never also
 * this line's, so it is said once. */
function drawingDetail(
  drawn: number,
  total: number | null,
  run: PieceRun | null,
): string | null {
  const parts: string[] = [];
  if (total !== null && total > 0)
    parts.push(`${Math.min(drawn, total)} of ${total}`);
  if (run && run.rateLimitDeferrals > 0)
    parts.push("Google is accepting pictures slowly");
  return parts.length ? parts.join(". ") : null;
}

/**
 * The progress card's rows for one piece of work (plan section 4, "Theme
 * page, building"): named steps, never "step 4 of 7", because a repair goes
 * back through the layout check. A repair is its own row; the checks after
 * it show the newest round (an older round's check is summed up by the
 * repair row that followed it, and a check that has not run again yet is
 * still to come, or left out once nothing is working). A row's next try
 * appears only when the run really waits for a set time.
 */
export function buildThemeStudioSteps(
  piece: Piece,
  context: StepContext,
): ThemeStudioProgressStep[] {
  const steps: ThemeStudioProgressStep[] = [];
  const sinceMs = msOf(piece.since);
  const inPiece = <T extends { createdAt: string; status: string }>(
    items: readonly T[],
  ) =>
    items.filter(
      (item) => msOf(item.createdAt) >= sinceMs || isActive(item.status),
    );
  const runs = inPiece(piece.runs);
  const captures = inPiece(piece.captures);
  const reviews = inPiece(piece.reviews);
  const repairs = repairsOf(piece);
  const starter = piece.starter?.type ?? null;
  const recheckPiece =
    (starter === "capture_requested" && !!piece.starter?.recheck) ||
    (starter === "version_restored" && piece.starter?.outcome === "rechecking");

  // The operator's run: the first build or change run that is no repair.
  const lead = runs.find(
    (run) => run.kind !== "images" && !repairs.has(run.id),
  );
  if (lead) {
    const variant = {
      change: lead.kind === "revise",
      answer: starter === "details_added",
    };
    const label = (key: "brief" | "design", state: StepState) =>
      labelFor(key, state, variant);
    const started = lead.startedAt;
    const briefEnd =
      lead.firstResponseAt ??
      (started && lead.intentMs !== null
        ? new Date(msOf(started) + lead.intentMs).toISOString()
        : null);
    const next = runNextTry(lead, context.nowIso);
    if (lead.status === "queued" && !started) {
      steps.push(
        step("brief", "waiting", {
          label: label("brief", "waiting"),
          nextTryAt: next,
        }),
        step("design", "waiting", { label: label("design", "waiting") }),
      );
    } else if (isActive(lead.status)) {
      const pastBrief = lead.responses > 0;
      steps.push(
        pastBrief
          ? step("brief", "done", {
              label: label("brief", "done"),
              startedAt: started,
              finishedAt: briefEnd,
            })
          : step("brief", lead.status === "queued" ? "waiting" : "running", {
              label: label(
                "brief",
                lead.status === "queued" ? "waiting" : "running",
              ),
              startedAt: started,
              nextTryAt: next,
            }),
        pastBrief
          ? step("design", lead.status === "queued" ? "waiting" : "running", {
              label: label(
                "design",
                lead.status === "queued" ? "waiting" : "running",
              ),
              startedAt: briefEnd,
              nextTryAt: next,
            })
          : step("design", "waiting", { label: label("design", "waiting") }),
      );
    } else if (lead.status === "succeeded") {
      if (lead.outcomeKind === "clarify") {
        steps.push(
          step("brief", "done", {
            label: label("brief", "done"),
            detail: `Asked ${plural(lead.questions, "question", "questions")}`,
            startedAt: started,
            finishedAt: lead.finishedAt,
          }),
          step("design", "skipped", { label: label("design", "skipped") }),
        );
      } else {
        steps.push(
          step("brief", "done", {
            label: label("brief", "done"),
            startedAt: started,
            finishedAt: briefEnd,
          }),
          step("design", "done", {
            label: label("design", "done"),
            startedAt: briefEnd ?? started,
            finishedAt: lead.finishedAt,
          }),
        );
      }
    } else {
      // Failed or stopped: the stage that was running carries the reason.
      const inDraft = lead.outcomeStage === "draft" || lead.responses > 0;
      const words = runStopWords(lead);
      steps.push(
        inDraft
          ? step("brief", "done", {
              label: label("brief", "done"),
              startedAt: started,
              finishedAt: briefEnd,
            })
          : step("brief", "failed", {
              label: label("brief", "failed"),
              detail: words,
              startedAt: started,
              finishedAt: lead.finishedAt,
            }),
        inDraft
          ? step("design", "failed", {
              label: label("design", "failed"),
              detail: words,
              startedAt: briefEnd ?? started,
              finishedAt: lead.finishedAt,
            })
          : step("design", "skipped", { label: label("design", "skipped") }),
      );
    }
  }

  // Repair rounds: each its own row.
  const repairRuns = runs.filter((run) => repairs.has(run.id));
  const byRound = new Map<number, PieceRun>();
  for (const run of repairRuns) byRound.set(Math.max(1, run.qaIteration), run);
  for (const [round, run] of byRound) {
    const phase = repairs.get(run.id) ?? "final";
    const state: StepState =
      run.status === "succeeded"
        ? "done"
        : run.status === "running"
          ? "running"
          : run.status === "queued"
            ? run.startedAt
              ? "running"
              : "waiting"
            : "failed";
    steps.push(
      step(`repair_${round}`, state, {
        label: labelFor(`repair_${round}`, state, { round, phase }),
        detail:
          state === "failed"
            ? runStopWords(run)
            : run.kind === "images" && state !== "done"
              ? drawingDetail(run.drawn, run.slotsRequested ?? run.slotIds, run)
              : null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        nextTryAt: runNextTry(run, context.nowIso),
      }),
    );
  }

  // The checks of the newest round only: a repair sends the design back
  // through them.
  const lastRepair = repairRuns.reduce<number>(
    (at, run) => Math.max(at, msOf(run.createdAt)),
    -Infinity,
  );
  const inRound = <T extends { createdAt: string }>(items: readonly T[]) =>
    items.filter((item) => msOf(item.createdAt) >= lastRepair);
  const roundCaptures = inRound(captures);
  const roundReviews = inRound(reviews);
  const roundPictures = inRound(
    runs.filter((run) => run.kind === "images" && !repairs.has(run.id)),
  );
  const finalCapture = roundCaptures.filter((c) => c.phase === "final").at(-1);
  const finalReview = roundReviews.filter((q) => q.phase === "final").at(-1);
  const reachedFinal = !!finalCapture || !!finalReview;

  const buildPiece = !!lead || repairRuns.length > 0;
  const imagesPiece = starter === "images_requested";
  const expected = new Set<ThemeStudioProgressStepKey>();
  if (context.checksOn && context.working) {
    if (buildPiece) {
      expected.add("layout_check");
      expected.add("pictures");
    }
    if (imagesPiece) expected.add("pictures");
    if (buildPiece || imagesPiece || recheckPiece || starter) {
      expected.add("final_check");
      expected.add("design_review");
    }
  }

  // Layout check.
  const layoutCapture = roundCaptures
    .filter((c) => c.phase === "layout")
    .at(-1);
  const layoutReview = roundReviews
    .filter(
      (q) =>
        q.phase === "layout" &&
        (!layoutCapture || msOf(q.createdAt) >= msOf(layoutCapture.createdAt)),
    )
    .at(-1);
  const fixedInLayout = reviews
    .filter((q) => q.phase === "layout" && q.status === "revision_queued")
    .reduce((sum, q) => sum + q.repairs, 0);
  if (layoutCapture || layoutReview) {
    const startedAt =
      layoutCapture?.startedAt ??
      layoutCapture?.createdAt ??
      layoutReview?.startedAt ??
      null;
    let state: StepState;
    let detail: string | null = null;
    let finishedAt: string | null = null;
    if (layoutReview) {
      state =
        layoutReview.status === "passed" ||
        layoutReview.status === "revision_queued"
          ? "done"
          : layoutReview.status === "failed"
            ? "failed"
            : "running";
      finishedAt = layoutReview.finishedAt;
      if (state === "failed")
        detail = stopReasonWords(layoutReview.errorCode, "review");
      else if (state === "done" && fixedInLayout > 0)
        detail = `Fixed ${plural(fixedInLayout, "problem", "problems")}`;
    } else {
      const capture = layoutCapture!;
      state =
        capture.status === "failed"
          ? "failed"
          : capture.status === "succeeded"
            ? "done"
            : capture.status === "running" || capture.startedAt
              ? "running"
              : "waiting";
      finishedAt = capture.finishedAt;
      if (state === "failed")
        detail = stopReasonWords(capture.errorCode, "capture");
    }
    steps.push(
      step("layout_check", state, {
        label: labelFor("layout_check", state),
        detail,
        startedAt: state === "waiting" ? null : startedAt,
        finishedAt: state === "done" || state === "failed" ? finishedAt : null,
      }),
    );
  } else if (expected.has("layout_check")) {
    steps.push(
      reachedFinal
        ? step("layout_check", "skipped", {
            label: labelFor("layout_check", "skipped"),
          })
        : step("layout_check", "waiting", {
            label: labelFor("layout_check", "waiting"),
          }),
    );
  }

  // Pictures: the round's picture runs (a first run and its fill rounds).
  if (roundPictures.length) {
    const newest = roundPictures.at(-1)!;
    const first = roundPictures[0];
    const total =
      first.slotsRequested ??
      (first.slotIds > 0 ? first.slotIds : first.outcomeSlots);
    const drawn = roundPictures.reduce(
      (sum, run) =>
        sum + (isActive(run.status) ? run.drawn : (run.generated ?? run.drawn)),
      0,
    );
    const state: StepState =
      newest.status === "succeeded"
        ? "done"
        : newest.status === "running"
          ? "running"
          : newest.status === "queued"
            ? newest.startedAt || roundPictures.length > 1
              ? "running"
              : "waiting"
            : "failed";
    steps.push(
      step("pictures", state, {
        label: labelFor("pictures", state),
        detail:
          state === "failed"
            ? runStopWords(newest)
            : state === "done"
              ? total !== null && drawn < total
                ? `Drew ${drawn} of ${total} pictures`
                : `Drew ${plural(drawn, "picture", "pictures")}`
              : drawingDetail(drawn, total, newest),
        startedAt:
          state === "waiting" ? null : (first.startedAt ?? first.createdAt),
        finishedAt:
          state === "done" || state === "failed" ? newest.finishedAt : null,
        nextTryAt: runNextTry(newest, context.nowIso),
      }),
    );
  } else if (expected.has("pictures")) {
    steps.push(
      reachedFinal
        ? step("pictures", "skipped", {
            label: labelFor("pictures", "skipped"),
            detail: "No pictures to draw",
          })
        : step("pictures", "waiting", {
            label: labelFor("pictures", "waiting"),
          }),
    );
  }

  // The photo check before the design review.
  if (finalReview?.photoState) {
    const state: StepState =
      finalReview.photoState === "failed"
        ? "failed"
        : finalReview.photoState === "waiting" ||
            finalReview.status === "queued"
          ? "waiting"
          : "running";
    const unchecked = finalReview.photoUnchecked;
    steps.push(
      step("photo_check", state, {
        label: labelFor("photo_check", state),
        detail:
          state === "failed"
            ? "The picture check could not run on every photo. Check again."
            : unchecked && unchecked > 0
              ? `${plural(unchecked, "photo", "photos")} to check`
              : null,
        startedAt: finalReview.startedAt,
        finishedAt: state === "failed" ? finalReview.finishedAt : null,
        nextTryAt: reviewNextTry(finalReview, context.nowIso),
      }),
    );
  }

  // The final capture and its checks.
  const recheckCapture =
    recheckPiece ||
    (!!finalCapture && recheckReasonOf(finalCapture.key) !== null);
  if (finalCapture) {
    const state: StepState =
      finalCapture.status === "succeeded"
        ? "done"
        : finalCapture.status === "failed"
          ? "failed"
          : finalCapture.status === "running" || finalCapture.startedAt
            ? "running"
            : "waiting";
    steps.push(
      step("final_check", state, {
        label: labelFor("final_check", state, { recheck: recheckCapture }),
        detail:
          state === "failed"
            ? stopReasonWords(finalCapture.errorCode, "capture")
            : null,
        startedAt:
          state === "waiting"
            ? null
            : (finalCapture.startedAt ?? finalCapture.createdAt),
        finishedAt:
          state === "done" || state === "failed"
            ? finalCapture.finishedAt
            : null,
      }),
    );
  } else if (expected.has("final_check")) {
    steps.push(
      step("final_check", "waiting", {
        label: labelFor("final_check", "waiting", { recheck: recheckCapture }),
      }),
    );
  }

  // The design review.
  if (finalReview && finalReview.status !== "revision_queued") {
    const photoFirst =
      finalReview.photoState === "checking" ||
      finalReview.photoState === "waiting";
    const state: StepState =
      finalReview.status === "passed"
        ? "done"
        : finalReview.status === "failed"
          ? "failed"
          : finalReview.status === "running" && !photoFirst
            ? "running"
            : "waiting";
    steps.push(
      step("design_review", state, {
        label: labelFor("design_review", state),
        detail:
          state === "failed"
            ? stopReasonWords(finalReview.errorCode, "review")
            : null,
        startedAt: state === "waiting" ? null : finalReview.startedAt,
        finishedAt:
          state === "done" || state === "failed"
            ? finalReview.finishedAt
            : null,
        nextTryAt: photoFirst
          ? null
          : reviewNextTry(finalReview, context.nowIso),
      }),
    );
  } else if (expected.has("design_review")) {
    steps.push(
      step("design_review", "waiting", {
        label: labelFor("design_review", "waiting"),
      }),
    );
  }

  // Rows that started, in the order they started (a skipped row just before
  // the step after it), then the rows still to come, in their usual order.
  const startOf = (s: ThemeStudioProgressStep) => msOf(s.startedAt);
  const anchored = steps.map((s) => {
    if (Number.isFinite(startOf(s))) return { s, at: startOf(s) };
    if (s.state === "skipped") {
      const after = steps
        .filter(
          (o) => orderOf(o.key) > orderOf(s.key) && Number.isFinite(startOf(o)),
        )
        .map(startOf);
      if (after.length) return { s, at: Math.min(...after) - 0.5 };
    }
    return { s, at: NaN };
  });
  return [
    ...anchored
      .filter((a) => Number.isFinite(a.at))
      .sort((a, b) => a.at - b.at || orderOf(a.s.key) - orderOf(b.s.key))
      .map((a) => a.s),
    ...anchored
      .filter((a) => !Number.isFinite(a.at))
      .sort((a, b) => orderOf(a.s.key) - orderOf(b.s.key))
      .map((a) => a.s),
  ];
}

// ------------------------------------------------------------ status input

interface WorkFacts {
  working: StudioStatusWorking | null;
  stop: StudioStatusStop | null;
  steps: ThemeStudioProgressStep[];
  /** Newest progress the piece saw (for updatedAt). */
  lastProgressAt: string | null;
  /** The runs of the newest piece of work (Q2 takes them by `created_at`
   * in SQL, so membership is exact), or null when the read had no piece. */
  runIds: ReadonlySet<string> | null;
}

/** Working, stopped, and the steps, from one piece of work. */
function workFacts(
  piece: Piece | undefined,
  project: { status: string; updatedAt: string },
  context: { nowIso: string; checksOn: boolean },
): WorkFacts {
  if (!piece) {
    // Read with no piece of work (a theme the piece query did not cover):
    // a generating theme is still working, timed from its own row.
    const working: StudioStatusWorking | null =
      project.status === "generating"
        ? {
            kind: "building",
            step: null,
            since: project.updatedAt,
            lastProgressAt: project.updatedAt,
            nextTryAt: null,
          }
        : null;
    return {
      working,
      stop: null,
      steps: [],
      lastProgressAt: null,
      runIds: null,
    };
  }
  const runIds: ReadonlySet<string> = new Set(piece.runs.map((r) => r.id));
  const activeRun = piece.runs.find((r) => isActive(r.status)) ?? null;
  const activeCapture = piece.captures.find((c) => isActive(c.status)) ?? null;
  const activeReview = piece.reviews.find((q) => isActive(q.status)) ?? null;
  const isWorking =
    project.status === "generating" ||
    !!activeRun ||
    !!activeCapture ||
    !!activeReview;
  const steps = buildThemeStudioSteps(piece, {
    nowIso: context.nowIso,
    checksOn: context.checksOn,
    working: isWorking,
  });

  const sinceMs = msOf(piece.since);
  const records = [
    ...piece.runs.map((r) => ({ ...r, source: "run" as const })),
    ...piece.captures.map((c) => ({ ...c, source: "capture" as const })),
    ...piece.reviews.map((q) => ({ ...q, source: "review" as const })),
  ].filter((r) => msOf(r.createdAt) >= sinceMs || isActive(r.status));

  const lastProgressAt = latest(
    piece.since,
    piece.lastEventAt,
    // A record made is a step handed on; a queued record's own updated_at
    // moves only when it is sent back to wait (no lease renews it).
    ...records.flatMap((r) => [
      r.createdAt,
      r.startedAt,
      r.finishedAt,
      r.status === "queued" ? r.updatedAt : null,
    ]),
    ...piece.runs.flatMap((r) => [r.checkpointAt, r.lastResponseAt]),
  );

  // The stop: the newest settled record, when it failed or was stopped. A
  // review's hand-over to a re-capture after a deploy is not a stop.
  const rank = { run: 0, capture: 1, review: 2 } as const;
  const settled = records
    .filter((r) => !isActive(r.status) && r.finishedAt)
    .filter(
      (r) =>
        !(r.source === "review" && r.errorCode === "acceptance_build_changed"),
    )
    .sort(
      (a, b) =>
        msOf(b.finishedAt) - msOf(a.finishedAt) ||
        rank[a.source] - rank[b.source],
    );
  const newest = settled[0];
  let stop: StudioStatusStop | null = null;
  if (newest && (newest.status === "failed" || newest.status === "cancelled")) {
    stop = {
      kind: newest.source,
      code:
        newest.status === "cancelled"
          ? "cancelled"
          : (newest.errorCode ?? "worker_error"),
      at: newest.finishedAt!,
      runId: newest.source === "run" ? newest.id : null,
    };
  }

  if (!isWorking) return { working: null, stop, steps, lastProgressAt, runIds };

  const photo =
    activeReview?.phase === "final" &&
    (activeReview.photoState === "checking" ||
      activeReview.photoState === "waiting");
  // The operator's own change names the work first: Make current of a design
  // that never passed checks it with a re-check's capture key, but it is
  // still "Checking your change".
  const imagesRunActive = activeRun?.kind === "images";
  const change =
    (piece.starter?.type === "version_restored" &&
      piece.starter.outcome === "checking") ||
    (piece.starter?.type === "slot_images_replaced" &&
      piece.starter.automaticQa) ||
    (piece.starter?.type === "images_requested" &&
      !imagesRunActive &&
      (!!activeCapture || !!activeReview));
  const recheck =
    (piece.starter?.type === "capture_requested" && !!piece.starter.recheck) ||
    (piece.starter?.type === "version_restored" &&
      piece.starter.outcome === "rechecking") ||
    (!!activeCapture && recheckReasonOf(activeCapture.key) !== null);
  const anyStarted = records.some((r) => !!r.startedAt);
  const kind: StudioWorkKind = photo
    ? "checking_pictures"
    : change
      ? "checking_change"
      : recheck
        ? "rechecking"
        : anyStarted
          ? "building"
          : "waiting";

  const current =
    steps.find((s) => s.state === "running") ??
    steps.find((s) => s.state === "waiting") ??
    null;
  const nextTryAt =
    (activeRun ? runNextTry(activeRun, context.nowIso) : null) ??
    (activeReview ? reviewNextTry(activeReview, context.nowIso) : null);
  return {
    working: {
      kind,
      step: kind === "building" ? (current?.label ?? null) : null,
      since: piece.since,
      lastProgressAt: lastProgressAt ?? piece.since,
      nextTryAt,
    },
    stop,
    steps,
    lastProgressAt,
    runIds,
  };
}

function reviewFindings(value: unknown): {
  code: string;
  row: string | null;
  slotId: string | null;
}[] {
  return list(value)
    .filter((f) => typeof f.code === "string" && f.code)
    .map((f) => ({
      code: String(f.code),
      row: typeof f.row === "string" ? f.row : null,
      slotId: typeof f.slotId === "string" ? f.slotId : null,
    }));
}

type CheckRunState = NonNullable<StudioStatusChecks["checkRun"]>["state"];

const CHECK_STATE: Readonly<Record<string, CheckRunState>> = {
  running: "running",
  awaiting_browser: "running",
  passed: "passed",
  failed: "failed",
  blocked: "blocked",
  error: "incomplete",
  expired: "incomplete",
};

function checksFrom(
  fact: FactRow,
  counts: CheckRunCounts | undefined,
  buildId: string,
): StudioStatusChecks | null {
  if (!fact.currentVersionId) return null;
  const serious = new Map<string, FindingKind>();
  for (const kind of counts?.serious ?? []) serious.set(kind.key, kind);
  const warnings = new Set(counts?.warnings ?? []);
  if (fact.reviewId) {
    for (const finding of reviewFindings(fact.reviewSerious)) {
      const key = `review|${finding.code}|${finding.row ?? finding.slotId ?? ""}`;
      serious.set(key, {
        key,
        storeMink: false,
        picture: PICTURE_REVIEW_CODES.has(finding.code),
      });
    }
    for (const finding of reviewFindings(fact.reviewWarnings))
      warnings.add(`review|${finding.code}`);
  }
  const kinds = [...serious.values()];
  const storeMink = kinds.filter((k) => k.storeMink).length;
  return {
    versionId: fact.currentVersionId,
    checkRun: fact.checkRunId
      ? {
          id: fact.checkRunId,
          state: CHECK_STATE[fact.checkRunStatus ?? ""] ?? "incomplete",
          build: fact.checkRunBuild ?? "",
          todaysBuild: fact.checkRunBuild === buildId,
          finishedAt: toIso(fact.checkRunFinishedAt),
        }
      : null,
    review: fact.reviewId
      ? {
          id: fact.reviewId,
          state: ([
            "queued",
            "running",
            "passed",
            "failed",
            "revision_queued",
          ].includes(String(fact.reviewStatus))
            ? fact.reviewStatus
            : "failed") as NonNullable<StudioStatusChecks["review"]>["state"],
          outcome:
            fact.reviewOutcome === "pass" ||
            fact.reviewOutcome === "taste" ||
            fact.reviewOutcome === "serious"
              ? fact.reviewOutcome
              : null,
          boundToCheckRun:
            !!fact.checkRunId && fact.reviewAcceptanceRunId === fact.checkRunId,
        }
      : null,
    serious: kinds.length,
    seriousStoreMink: storeMink,
    seriousPictures: kinds.filter((k) => k.picture).length,
    warnings: warnings.size,
    allSeriousAreStoreMink: kinds.length > 0 && storeMink === kinds.length,
  };
}

/** The list's evidence: currentPublishEvidence's three conditions from
 * Q1's columns, without validating the theme file and its pictures. */
function listEvidence(
  fact: FactRow,
  buildId: string,
  checksOn: boolean,
): PublishEvidence | null {
  if (!fact.currentVersionId) return null;
  if (fact.status !== "ready" && fact.status !== "candidate") return null;
  if (
    !fact.verdictRunId ||
    fact.verdictRunStatus !== "passed" ||
    !fact.verdictRunHasEvidence ||
    fact.verdictRunDigest !== fact.currentPackageDigest
  )
    return { ok: false, reason: "none" };
  if (fact.verdictRunBuild !== buildId)
    return { ok: false, reason: "old_build" };
  if (
    checksOn &&
    (fact.boundReviewStatus !== "passed" ||
      fact.boundReviewDigest !== fact.currentPackageDigest ||
      fact.boundReviewBuild !== fact.verdictRunBuild)
  )
    return { ok: false, reason: "no_review" };
  return { ok: true, acceptanceRunId: fact.verdictRunId };
}

/**
 * Row 13's picture run: the newest picture run of the current version.
 *
 * ★ A FAILED ONE COUNTS ONLY WHILE IT BELONGS TO THE NEWEST PIECE OF WORK.
 * Once the operator started something since (Check again, Make current, a
 * change, another picture run), that work has moved on from it: counting it
 * would hold the theme at "Drawing pictures didn't finish" ahead of Ready to
 * publish for good, even after a re-check passed, although the failed run
 * changed nothing (a picture run that fails makes no design). It stays in
 * the Log tab with its Retry. With no piece read, it counts as before.
 */
function lastPictureRun(
  fact: FactRow,
  work: WorkFacts,
): StudioStatusPictureRun | null {
  if (!fact.pictureRunId) return null;
  const run: StudioStatusPictureRun = {
    id: fact.pictureRunId,
    state: runState(fact.pictureRunStatus),
    errorCode: fact.pictureRunError,
    finishedAt: toIso(fact.pictureRunFinishedAt),
  };
  if (run.state === "failed" && work.runIds && !work.runIds.has(run.id))
    return null;
  return run;
}

const PROJECT_STATES: readonly string[] = [
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

function statusInput(
  fact: FactRow,
  work: WorkFacts,
  context: {
    nowIso: string;
    buildId: string;
    config: ReturnType<typeof getThemeStudioConfig>;
    counts: CheckRunCounts | undefined;
    version: VersionFacts | undefined;
    evidence: PublishEvidence | null;
  },
): StudioStatusInput {
  const status = (
    PROJECT_STATES.includes(fact.status) ? fact.status : "ready"
  ) as ThemeStudioProjectState;
  const questionsOpen =
    fact.latestRunStatus === "succeeded" &&
    fact.latestOutcomeKind === "clarify" &&
    fact.questionsSetAside !== true;
  const attemptState =
    fact.attemptStatus === "publishing" || fact.attemptStatus === "failed"
      ? fact.attemptStatus
      : null;
  return {
    now: context.nowIso,
    projectStatus: status,
    archivedAt: toIso(fact.archivedAt),
    hasCurrentVersion: !!fact.currentVersionId,
    release: fact.releaseVersion
      ? {
          version: fact.releaseVersion,
          publishedAt: toIso(fact.releasedAt) ?? context.nowIso,
          offered: fact.catalogVisibility === "public",
        }
      : null,
    publishAttempt:
      status === "approved" && attemptState
        ? {
            state: attemptState,
            startedAt: toIso(fact.attemptStartedAt) ?? context.nowIso,
            lastWriteAt: toIso(fact.attemptLastWriteAt) ?? context.nowIso,
            reasons: (Array.isArray(fact.attemptReasons)
              ? fact.attemptReasons
              : []
            )
              .filter((r): r is string => typeof r === "string" && !!r.trim())
              .slice(0, 3),
          }
        : null,
    working: work.working,
    questions: {
      open: questionsOpen,
      count: questionsOpen ? int(fact.latestQuestionCount) : 0,
      askedAt: questionsOpen ? toIso(fact.latestRunFinishedAt) : null,
      rounds: int(fact.questionRounds),
      tooManyRounds:
        questionsOpen &&
        fact.latestRunKind === "revise" &&
        int(fact.latestContextCount) >= MAX_REVISION_MESSAGES,
    },
    stop: work.stop,
    checks: checksFrom(fact, context.counts, context.buildId),
    evidence: context.evidence,
    pictures: {
      missing: fact.currentVersionId ? (context.version?.missing ?? 0) : 0,
      lastRun: lastPictureRun(fact, work),
    },
    switches: {
      buildingOff: !context.config.generationEnabled,
      modelOff: context.config.disabledModels.has(
        fact.modelKey as ThemeStudioModelKey,
      ),
      checksOff: !context.config.autoQaEnabled,
    },
  };
}

/** Whether the theme's facts can decide a row that reads the evidence (15,
 * 16 or 19): ready or Ready to publish, nothing working, never published. */
function needsEvidence(fact: FactRow, work: WorkFacts): boolean {
  return (
    !!fact.currentVersionId &&
    (fact.status === "ready" || fact.status === "candidate") &&
    !work.working &&
    !fact.releaseVersion
  );
}

// ------------------------------------------------------------ public reads

/**
 * The theme page's progress: status facts, the progress card's steps, the
 * revision and the version list. Null for an unknown project (the route
 * answers 404).
 *
 * Queries: Q1 (this project's facts and version ids), Q2 (its newest piece
 * of work), Q3 only when its newest check run is not cached, Q4 only when
 * its current version is not cached, and currentPublishEvidence's own reads
 * only when the row needs it (ready or Ready to publish with nothing
 * working). A poll while building costs Q1 and Q2.
 */
export async function readThemeStudioProgress(
  db: Db,
  input: { projectId: string },
): Promise<ThemeStudioProgress | null> {
  if (!UUID_RE.test(input.projectId)) return null;
  const [fact] = await readFacts(db, sql`p.id = ${input.projectId}::uuid`, {
    versionIds: true,
    limit: 1,
  });
  if (!fact) return null;
  const nowIso = toIso(fact.readAt) ?? new Date().toISOString();
  const config = getThemeStudioConfig();
  const buildId = currentAcceptanceBuildId();
  const pieces = await readPieces(db, [fact.projectId]);
  const work = workFacts(
    pieces.get(fact.projectId),
    { status: fact.status, updatedAt: toIso(fact.updatedAt) ?? nowIso },
    { nowIso, checksOn: config.autoQaEnabled },
  );
  const counts = fact.checkRunId
    ? (
        await readCheckRunCounts(db, [
          { id: fact.checkRunId, status: fact.checkRunStatus ?? "" },
        ])
      ).get(fact.checkRunId)
    : undefined;
  const version = fact.currentVersionId
    ? (
        await readVersionFacts(db, [
          { id: fact.currentVersionId, digest: fact.currentPackageDigest },
        ])
      ).get(fact.currentVersionId)
    : undefined;
  const evidence = needsEvidence(fact, work)
    ? await currentPublishEvidence(db, { projectId: fact.projectId })
    : null;
  const status = statusInput(fact, work, {
    nowIso,
    buildId,
    config,
    counts,
    version,
    evidence,
  });
  const versionIds = Array.isArray(fact.versionIds)
    ? fact.versionIds.filter((id): id is string => typeof id === "string")
    : [];
  const updatedAt =
    latest(
      toIso(fact.updatedAt),
      work.lastProgressAt,
      status.publishAttempt?.lastWriteAt,
      status.working?.lastProgressAt,
      ...work.steps.flatMap((s) => [s.startedAt, s.finishedAt]),
    ) ?? nowIso;
  return {
    projectId: fact.projectId,
    revision: int(fact.revision),
    versionIds,
    currentVersionId: fact.currentVersionId,
    status,
    steps: work.steps,
    updatedAt,
  };
}

/**
 * The Theme Studio list: the rows of one filter and every filter's count,
 * in a fixed number of narrow queries (never one per row, never the theme
 * file or picture bytes): Q1 for every project (up to 1000, newest change
 * first), Q2 for the projects that are neither live nor removed from the
 * list, and Q3 and Q4 for what the caches do not hold yet.
 */
export async function listThemeStudioProjectsForConsole(
  db: Db,
  input: { filter: ThemeStudioListFilter },
): Promise<ThemeStudioList> {
  const facts = await readFacts(db, sql`true`, {
    versionIds: false,
    limit: LIST_SCAN_LIMIT,
  });
  const counts = Object.fromEntries(
    THEME_STUDIO_LIST_FILTERS.map((filter) => [filter, 0]),
  ) as Record<ThemeStudioListFilter, number>;
  if (!facts.length) return { rows: [], counts };
  const nowIso = toIso(facts[0].readAt) ?? new Date().toISOString();
  const config = getThemeStudioConfig();
  const buildId = currentAcceptanceBuildId();
  const pieces = await readPieces(
    db,
    facts
      .filter((f) => !f.releaseVersion && f.status !== "archived")
      .map((f) => f.projectId),
  );
  const checkRuns = await readCheckRunCounts(
    db,
    facts
      .filter(
        (f) => f.checkRunId && !f.releaseVersion && f.status !== "archived",
      )
      .map((f) => ({ id: f.checkRunId!, status: f.checkRunStatus ?? "" })),
  );
  const versions = await readVersionFacts(
    db,
    facts
      .filter((f) => f.currentVersionId)
      .map((f) => ({
        id: f.currentVersionId!,
        digest: f.currentPackageDigest,
      })),
  );
  const rows: ThemeStudioListRow[] = [];
  for (const fact of facts) {
    const work = workFacts(
      pieces.get(fact.projectId),
      { status: fact.status, updatedAt: toIso(fact.updatedAt) ?? nowIso },
      { nowIso, checksOn: config.autoQaEnabled },
    );
    const version = fact.currentVersionId
      ? versions.get(fact.currentVersionId)
      : undefined;
    const status = statusInput(fact, work, {
      nowIso,
      buildId,
      config,
      counts: fact.checkRunId ? checkRuns.get(fact.checkRunId) : undefined,
      version,
      evidence: needsEvidence(fact, work)
        ? listEvidence(fact, buildId, config.autoQaEnabled)
        : null,
    });
    const filter = studioListFilter(studioStatus(status));
    counts.all += 1;
    counts[filter] += 1;
    if (input.filter !== "all" && input.filter !== filter) continue;
    if (rows.length >= THEME_STUDIO_LIST_LIMIT) continue;
    rows.push({
      projectId: fact.projectId,
      name: fact.name,
      themeId: fact.themeId,
      updatedAt: toIso(fact.updatedAt) ?? nowIso,
      status,
      activeStep: status.working
        ? (work.steps.find((s) => s.state === "running") ??
          work.steps.find((s) => s.state === "waiting") ??
          null)
        : null,
      pictureUrl: version?.previewAssetId
        ? `/api/theme-studio/images/${version.previewAssetId}`
        : null,
    });
  }
  return { rows, counts };
}

/** Round down to a multiple of 5 (at least 5). */
function floorTo5(minutes: number): number {
  return Math.max(5, Math.floor(minutes / 5) * 5);
}

/** Round up to a multiple of 5. */
function ceilTo5(minutes: number): number {
  return Math.max(5, Math.ceil(minutes / 5) * 5);
}

/**
 * "Usually N to M minutes", from this deployment's last 10 finished builds:
 * from each theme's first build run (kind `generate`) to its first
 * `auto_qa_passed` (Ready to publish), the 10 that finished most recently.
 * Builds on the offline provider (`fake`) take seconds and say nothing about
 * a real build, so they are left out. Fewer than 10: the 4 Oct benchmark.
 */
export async function readThemeStudioBuildTimeRange(
  db: Db,
): Promise<ThemeStudioBuildTimeRange> {
  const result = await db.execute(sql`
    SELECT extract(epoch FROM (ready.at - first.created_at)) AS seconds
      FROM (
        SELECT DISTINCT ON (r.project_id) r.project_id, r.created_at, r.provider
          FROM theme_studio_runs r
         WHERE r.kind = 'generate'
         ORDER BY r.project_id, r.created_at, r.id
      ) first
      JOIN (
        SELECT e.project_id, min(e.created_at) AS at
          FROM theme_studio_events e
         WHERE e.event_type = 'auto_qa_passed'
         GROUP BY e.project_id
      ) ready ON ready.project_id = first.project_id
     WHERE first.provider <> 'fake' AND ready.at > first.created_at
     ORDER BY ready.at DESC
     LIMIT ${BUILD_TIME_SAMPLE}
  `);
  const minutes = (result.rows as { seconds: unknown }[])
    .map((row) => Number(row.seconds) / 60)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (minutes.length < BUILD_TIME_SAMPLE) return { ...DEFAULT_BUILD_TIME };
  const from = floorTo5(Math.min(...minutes));
  const to = Math.max(from + 5, ceilTo5(Math.max(...minutes)));
  return {
    fromMinutes: from,
    toMinutes: to,
    basedOn: minutes.length,
    source: "measured",
  };
}

const VIEWPORT_WIDTH = new Map<string, number>(
  Object.entries(THEME_STUDIO_QA_VIEWPORTS).map(([key, size]) => [
    key,
    size.width,
  ]),
);

const EMPTY_COVERAGE: ThemeStudioCheckScreenshots["coverage"] = {
  pages: [],
  widths: [],
  panels: [],
  cartWasEmpty: false,
};

/**
 * The screenshots of a version's newest final check that stored any. Null
 * when the project is unknown or `versionId` is not an operator-visible
 * version of it (the route answers 404); `versionId` null means the
 * current version. Never reads picture bytes: the samples' page, width and
 * opened panels come from the review row's browser report by JSON path, and
 * each screenshot's size from its asset row.
 */
export async function listThemeStudioCheckScreenshots(
  db: Db,
  input: { projectId: string; versionId: string | null },
): Promise<ThemeStudioCheckScreenshots | null> {
  if (!UUID_RE.test(input.projectId)) return null;
  if (input.versionId !== null && !UUID_RE.test(input.versionId)) return null;
  const projects = await db.execute(sql`
    SELECT p.current_version_id AS "currentVersionId",
      v.id AS "versionId", v.visibility
      FROM theme_studio_projects p
      LEFT JOIN theme_studio_versions v
        ON v.project_id = p.id
       AND v.id = coalesce(${input.versionId}::uuid, p.current_version_id)
     WHERE p.id = ${input.projectId}::uuid
  `);
  const project = projects.rows[0] as
    | {
        currentVersionId: string | null;
        versionId: string | null;
        visibility: string | null;
      }
    | undefined;
  if (!project) return null;
  if (
    input.versionId !== null &&
    (!project.versionId || project.visibility !== "operator")
  )
    return null;
  const versionId = project.versionId;
  const empty: ThemeStudioCheckScreenshots = {
    versionId: input.versionId ?? project.currentVersionId,
    checkRunId: null,
    capturedAt: null,
    build: null,
    coverage: { ...EMPTY_COVERAGE },
    samples: [],
  };
  if (!versionId) return empty;
  const reviews = await db.execute(sql`
    SELECT q.created_at AS "capturedAt", q.screenshot_asset_ids AS "assetIds",
      q.browser_report ->> 'acceptanceRunId' AS "checkRunId",
      q.browser_report ->> 'buildId' AS "build",
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'surface', s ->> 'surface',
          'viewport', s ->> 'viewport',
          'states', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'state', st ->> 'state', 'measured', st -> 'measured'
            ) ORDER BY so)
              FROM jsonb_array_elements(${jsonArray(sql`s -> 'states'`)})
                   WITH ORDINALITY AS sts(st, so)
          ), '[]'::jsonb)
        ) ORDER BY o)
          FROM jsonb_array_elements(${jsonArray(sql`q.browser_report -> 'evidence' -> 'samples'`)})
               WITH ORDINALITY AS ss(s, o)
      ), '[]'::jsonb) AS samples
      FROM theme_studio_visual_qa_runs q
     WHERE q.project_id = ${input.projectId}::uuid
       AND q.version_id = ${versionId}::uuid
       AND coalesce(q.browser_report ->> 'phase', 'final') = 'final'
       AND cardinality(q.screenshot_asset_ids) > 0
     ORDER BY q.created_at DESC, q.id DESC
     LIMIT 1
  `);
  const review = reviews.rows[0] as
    | {
        capturedAt: unknown;
        assetIds: unknown;
        checkRunId: string | null;
        build: string | null;
        samples: unknown;
      }
    | undefined;
  if (!review) return { ...empty, versionId };
  const assetIds = Array.isArray(review.assetIds)
    ? review.assetIds.filter((id): id is string => typeof id === "string")
    : typeof review.assetIds === "string"
      ? parsePgUuidArray(review.assetIds)
      : [];
  const samples = list(review.samples).map((s) => ({
    surface: typeof s.surface === "string" ? s.surface : "",
    viewport: typeof s.viewport === "string" ? s.viewport : "",
    states: list(s.states).map((st) => ({
      state: typeof st.state === "string" ? st.state : "",
      measured: st.measured === true,
    })),
  }));
  const sizes = assetIds.length
    ? await db.execute(sql`
        SELECT a.id, a.width, a.height
          FROM theme_studio_assets a
         WHERE a.project_id = ${input.projectId}::uuid
           AND a.purpose = 'qa_screenshot'
           AND a.id = ANY(${sql.param([...new Set(assetIds)])}::uuid[])
      `)
    : { rows: [] };
  const sizeOf = new Map(
    (sizes.rows as { id: string; width: unknown; height: unknown }[]).map(
      (row) => [row.id, { width: int(row.width), height: int(row.height) }],
    ),
  );
  const pages: string[] = [];
  const widths = new Set<number>();
  const panels = new Set<string>();
  for (const sample of samples) {
    if (sample.surface && !pages.includes(sample.surface))
      pages.push(sample.surface);
    const width = VIEWPORT_WIDTH.get(sample.viewport);
    if (width !== undefined) widths.add(width);
    if (sample.surface === "home")
      for (const state of sample.states)
        if (state.measured) panels.add(state.state);
  }
  const paired: ThemeStudioCheckScreenshotSample[] = [];
  assetIds.forEach((assetId, index) => {
    const sample = samples[index];
    const size = sizeOf.get(assetId);
    if (!sample || !size) return;
    paired.push({
      assetId,
      page: sample.surface,
      viewport: sample.viewport,
      width: size.width,
      height: size.height,
    });
  });
  const opened = CHROME_STATES.filter((state) => panels.has(state));
  return {
    versionId,
    checkRunId: review.checkRunId,
    capturedAt: toIso(review.capturedAt),
    build: review.build,
    coverage: {
      pages,
      widths: [...widths].sort((a, b) => a - b),
      panels: opened,
      cartWasEmpty: pages.includes("cart") || opened.includes("cart"),
    },
    samples: paired,
  };
}

/** A Postgres uuid[] in its text form ("{a,b}"), should a driver hand it
 * over unparsed. */
function parsePgUuidArray(value: string): string[] {
  return value
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => UUID_RE.test(id));
}

/**
 * The bytes and media type of one stored check screenshot, or null when
 * `assetId` is not a check screenshot (purpose `qa_screenshot`) of that
 * project: never a theme picture, a reference or another project's file.
 */
export async function readThemeStudioCheckScreenshot(
  db: Db,
  input: { projectId: string; assetId: string },
): Promise<ThemeStudioCheckScreenshotFile | null> {
  if (!UUID_RE.test(input.projectId) || !UUID_RE.test(input.assetId))
    return null;
  const result = await db.execute(sql`
    SELECT a.bytes, a.media_type AS "mediaType"
      FROM theme_studio_assets a
     WHERE a.id = ${input.assetId}::uuid
       AND a.project_id = ${input.projectId}::uuid
       AND a.purpose = 'qa_screenshot'
     LIMIT 1
  `);
  const row = result.rows[0] as
    | { bytes: unknown; mediaType: unknown }
    | undefined;
  if (!row || !Buffer.isBuffer(row.bytes) || row.bytes.length === 0)
    return null;
  if (row.mediaType !== "image/webp" && row.mediaType !== "image/png")
    return null;
  return { bytes: row.bytes, contentType: row.mediaType };
}

export type {
  Piece as ThemeStudioWorkPiece,
  PieceRun as ThemeStudioPieceRun,
  PieceCapture as ThemeStudioPieceCapture,
  PieceReview as ThemeStudioPieceReview,
  StoredGate as ThemeStudioStoredGate,
};
