import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { logInfo, logWarn } from "@/lib/observability/logger";
import {
  canonicalJson,
  validateThemeIntent,
  validateThemePackageV2,
  type ThemePackageV2,
} from "./contracts";
import {
  estimateImageCostMicroUsd,
  THEME_STUDIO_IMAGE_PRICING_VERSION,
  THEME_STUDIO_PRICING_VERSION,
} from "./cost";
import type {
  ImageCall,
  ImageRunOptions,
  ReviewCall,
  ThemeImageReviewer,
} from "./image-generation";
import {
  generatableSlots,
  productSetReferenceSha,
} from "./image-generation-core";
import type {
  ThemeImageResult,
  ThemeStudioImageClient,
} from "./image-provider";
import {
  reviewThemeImage,
  THEME_IMAGE_REVIEW_MODEL_KEY,
  THEME_IMAGE_REVIEW_PROMPT_VERSION,
  type ThemeImageReview,
  type ThemeImageReviewInput,
} from "./image-review";
import { qaImageIssues, type QaImageIssue } from "./qa-image-issues";

/** Separate from crash attempts: two delayed retries of the same photographs. */
export const IMAGE_REVIEW_DEFERRALS = 2;
export const IMAGE_CRASH_ATTEMPTS = 3;
export function imageReviewRecoveryDelayMs(deferrals: number): number | null {
  return deferrals < IMAGE_REVIEW_DEFERRALS ? 60_000 * 2 ** deferrals : null;
}

export type ImageCheckpoint =
  | {
      stage: "draw";
      response: ThemeImageResult;
      call: ImageCall;
    }
  | { stage: "review"; response: ThemeImageReview; call: ReviewCall };

export interface ImageCheckpointStore {
  read(digest: string): Promise<ImageCheckpoint | null>;
  write(digest: string, checkpoint: ImageCheckpoint): Promise<void>;
}

/** A storage/lease failure must stop settlement, not become a missing slot. */
export class ImageCheckpointError extends Error {
  constructor() {
    super("Image checkpoint unavailable.");
  }
}

const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Only known free admission failures may be retried. An unknown-usage timeout
 * or cancellation after transport starts can still have incurred spend. */
function retryableUnbilledDraw(response: ThemeImageResult): boolean {
  return (
    response.kind === "error" &&
    response.usage.inputTokens + response.usage.outputTokens === 0 &&
    (response.code === "rate_limited" ||
      response.timing?.providerAttempts === 0)
  );
}

/** Exact requests, including all reference bytes. Slot-local ordinals keep
 * parallel completion order from changing keys, and distinguish paid retakes. */
export function resumableImageClient(
  client: ThemeStudioImageClient,
  providerModel: string,
  promptVersion: string,
  store: ImageCheckpointStore,
): ThemeStudioImageClient {
  const ordinals = new Map<string, number>();
  return {
    provider: client.provider,
    async generateImage(request, signal) {
      signal.throwIfAborted();
      const slot = `${request.purpose}:${request.briefId}`;
      const ordinal = ordinals.get(slot) ?? 0;
      ordinals.set(slot, ordinal + 1);
      let key = digest({
        stage: "draw",
        provider: client.provider,
        providerModel,
        promptVersion,
        ordinal,
        request,
      });
      let saved = await store.read(key);
      // Old deployments journalled free 429s. Preserve their immutable rows,
      // but use a separate deterministic key for the first billable replacement.
      if (
        !saved ||
        (saved.stage === "draw" && retryableUnbilledDraw(saved.response))
      ) {
        const replacementKey = digest({
          retryOf: key,
          unbilledAdmission: true,
        });
        const replacement = await store.read(replacementKey);
        // Retry ancestry excludes free errors but may contain their paid
        // replacement. Probe that key even when the original read is empty.
        if (saved || replacement) {
          key = replacementKey;
          saved = replacement;
        }
      }
      signal.throwIfAborted();
      if (saved?.stage === "draw") return saved.response;
      const started = Date.now();
      const response = await client.generateImage(request, signal);
      if (retryableUnbilledDraw(response)) return response;
      // Commit the original bytes BEFORE processing or review. Even a late
      // cancel retains incurred spend, while final settlement writes no version.
      await store.write(key, {
        stage: "draw",
        response,
        call: {
          briefId: request.briefId,
          purpose: request.purpose,
          ...response.usage,
          estimatedCostMicroUsd: estimateImageCostMicroUsd(response.usage),
          durationMs: Date.now() - started,
          referenceRoles: request.references.map((r) => r.role),
          ...(response.timing
            ? {
                capacityWaitMs: response.timing.capacityWaitMs,
                providerAttempts: response.timing.providerAttempts,
              }
            : {}),
        },
      });
      return response;
    },
  };
}

/** Successful evidence is immutable and bound to the candidate, anchor, SET,
 * brief, model and prompt. Unavailable reviews are journalled once per recovery
 * pass; reclaims never repeat them, later passes retry only the review. */
export function resumableImageReview(
  store: ImageCheckpointStore,
  recoveryPass: number,
): NonNullable<ImageRunOptions["review"]> {
  return async (reviewer, input, signal, briefId) => {
    signal.throwIfAborted();
    const binding = {
      stage: "review",
      briefId,
      provider: reviewer.client.provider,
      providerModel: reviewer.providerModel,
      modelKey: THEME_IMAGE_REVIEW_MODEL_KEY,
      promptVersion: THEME_IMAGE_REVIEW_PROMPT_VERSION,
      input,
    };
    const key = digest(binding);
    const attemptKey = digest({ ...binding, recoveryPass });
    const saved = (await store.read(key)) ?? (await store.read(attemptKey));
    signal.throwIfAborted();
    if (saved?.stage === "review") return saved.response;
    const started = Date.now();
    const response = await reviewThemeImage(
      reviewer.client,
      reviewer.providerModel,
      input,
      signal,
    );
    // Zero-usage cancellation is not evidence. Journal any returned paid usage
    // even if a cancellation arrives after the provider has answered.
    if (
      !signal.aborted ||
      response.usage.inputTokens +
        response.usage.outputTokens +
        response.usage.thinkingTokens >
        0
    ) {
      await store.write(response.kind === "reviewed" ? key : attemptKey, {
        stage: "review",
        response,
        call: {
          briefId,
          attempt: input.attempt,
          outcome:
            response.kind === "unavailable"
              ? "unavailable"
              : response.problems.length
                ? "problems"
                : "passed",
          problems: response.kind === "reviewed" ? response.problems : [],
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          thinkingTokens: response.usage.thinkingTokens,
          estimatedCostMicroUsd: response.estimatedCostMicroUsd,
          durationMs: Date.now() - started,
          ...(response.kind === "unavailable"
            ? { errorCode: response.code }
            : {}),
        },
      });
    }
    return response;
  };
}

/** Only metadata is read for accounting, never all raw photographs. Each
 * primary key contributes once, including failed reviews and rejected draws. */
export function imageCheckpointUsage(
  checkpoints: Pick<ImageCheckpoint, "stage" | "call">[],
) {
  const calls = checkpoints
    .filter((c) => c.stage === "draw")
    .map((c) => c.call as ImageCall);
  const reviews = checkpoints
    .filter((c) => c.stage === "review")
    .map((c) => c.call as ReviewCall);
  const reviewCostMicroUsd = reviews.reduce(
    (n, c) => n + c.estimatedCostMicroUsd,
    0,
  );
  return {
    calls,
    reviews,
    totals: calls.reduce(
      (sum, c) => ({
        inputTokens: sum.inputTokens + c.inputTokens,
        outputTokens: sum.outputTokens + c.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    ),
    estimatedCostMicroUsd: calls.reduce(
      (n, c) => n + c.estimatedCostMicroUsd,
      reviewCostMicroUsd,
    ),
    reviewCostMicroUsd,
    pricingVersion: THEME_STUDIO_IMAGE_PRICING_VERSION,
    reviewPricingVersion: THEME_STUDIO_PRICING_VERSION,
    reviewPromptVersion: THEME_IMAGE_REVIEW_PROMPT_VERSION,
    reviewModelKey: THEME_IMAGE_REVIEW_MODEL_KEY,
  };
}

// ── A photo still unchecked, checked before the final capture (TS-3B) ──────
//
// ★★ AN UNCHECKED PHOTO IS CHECKED, NOT TRUSTED (plan section 3, optimisation
// 3). A photo run keeps a photo whose check stayed unavailable through its
// waits (worker.ts), and photos carried over from earlier versions may never
// have been checked (2 of 84 kept photos on 4 Oct). Such a photo stays
// serious until its own check passes on its exact bytes (qa-image-issues.ts):
// the design review judges art direction, not the check's list of hard
// problems. So before a final capture's design review, every photo of the
// version still unchecked is checked here: the same check (reviewThemeImage,
// the same model, prompt and hard-problem list), with the reviewer of the
// provider that drew it.
//
// ★ THE RESULT IS RECORDED WHERE THE CHECK OF A DRAWN PHOTO IS: on the photo's
//   entry in `outcome_detail.outcomes` of the image run that drew it, the
//   nearest in the version's ancestry (the row visual-qa.ts reads, DISTINCT
//   ON the bytes, nearest first). So the design review, the Pictures tab and
//   the next redraw all see it, every later version that carries the photo
//   sees it, and the same bytes are never paid for twice. Its spend is added
//   to that run's usage, as the photo's first check was.
// ★ ONE CALLER AT A TIME PER PHOTO, AND NOTHING HELD ACROSS GOOGLE. A try is
//   claimed on that entry (`recheck.until`) in a short transaction of its
//   own, the check runs outside any transaction, and its result is written
//   in another; a second caller meanwhile waits rather than paying for the
//   same bytes. A crashed caller's claim lapses (PHOTO_RECHECK_CLAIM_MS).
// ★ "WAITING", THEN "FAILED". A check that cannot answer is tried again on a
//   later call, 1 and then 2 minutes later, PHOTO_RECHECK_TRIES tries in all;
//   then the photo is "failed" (the theme shows "Couldn't finish the
//   checks") for PHOTO_RECHECK_RESET_MS, after which a later call (Check
//   again) starts a fresh round. A reviewer switched off
//   (THEME_STUDIO_DISABLED_MODELS) or a photo whose bytes, brief or record
//   cannot be read is "failed" at once: it can never pass as it is. A check
//   the caller stopped (its signal) is not a try: the photo waits.
// ★★ NO CONNECTION IS HELD THROUGH A CHECK (TS-3 fixer, 25 Oct 2026). Called
//   with a transaction runner (`withService`, as the design review does), the
//   function reads the version, its photos and their bytes in one short
//   transaction of its own, which has committed before any check is sent,
//   and claims and records each try in short transactions of their own. So a
//   check of up to minutes pins none of the web's 5 pooled connections, and
//   the claim and record transactions never wait on a connection the same
//   lane is holding (with the older form below, a worker with a pool of 1
//   could never claim a photo at all).
// ★ The older form, a `db` the caller holds open, is still accepted: it is
//   only read, before any check; the caller's transaction must hold no row
//   lock and have written nothing (the function refuses otherwise, before
//   paying for anything), and while checks run it is kept from the 60-second
//   idle limit (lib/db/client.ts) with a `SELECT 1` every 20 s. ⚠ That holds
//   one pooled connection through the checks: no production caller uses it.
// ★ A CALLER'S DEADLINE IS THE CHECK'S OWN CLOCK, NEVER A STOP. Given
//   `deadline`, a photo's check is started only with at least
//   PHOTO_RECHECK_MIN_CLOCK_MS left (a whole try at the US endpoint and a
//   minute at global), and its clock is what is left (at most
//   PHOTO_RECHECK_CALL_MS). A check that clock cuts counts as a try, so the
//   same bytes are not sent again and again; one the caller's `signal`
//   stops (a lost lease) still does not. A photo not started waits.
// ★ "passed" means no photo of the version is left unchecked. A photo the
//   check flagged is judged by the design review as any flagged photo is
//   (a hard problem stays serious until a redraw passes).

export type UncheckedPhotosResult = "passed" | "waiting" | "failed";

/** Tries of one photo's check before the photo is "failed". */
export const PHOTO_RECHECK_TRIES = 3;
/** One check's own clock (its tries and 429 waits inside it). */
export const PHOTO_RECHECK_CALL_MS = 5 * 60_000;
/** A caller's claim on one photo's check: past the check's own clock. */
export const PHOTO_RECHECK_CLAIM_MS = PHOTO_RECHECK_CALL_MS + 60_000;
/**
 * The least time a photo's check is started with when its caller set a
 * `deadline`: one whole try at Google's US endpoint on Theme Studio's own
 * clock (120 s, worker.ts THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS) and a
 * minute for the try at global, where a check answers in about 9 s (median,
 * 4 Oct). So a deadline never cuts a US try before its own clock could send
 * the check on to global.
 */
export const PHOTO_RECHECK_MIN_CLOCK_MS = 180_000;
/** How long an exhausted photo stays "failed" before a fresh round. */
export const PHOTO_RECHECK_RESET_MS = 30 * 60_000;
/** The wait after `tries` unavailable tries: 1 minute, then 2. */
export function photoRecheckDelayMs(tries: number): number {
  return 60_000 * 2 ** Math.max(0, tries - 1);
}
const PHOTO_RECHECK_CONCURRENCY = 3;
const CALLER_KEEPALIVE_MS = 20_000;
/** theme_studio_runs_outcome_detail_check: at most 16 KiB of JSON. */
const OUTCOME_DETAIL_MAX_BYTES = 16_384;

/** What a photo's entry carries about checks made after its run. */
export type PhotoRecheckState = { tries: number; at?: string; until?: string };

type PhotoRow = {
  sha256: string;
  review: string | null;
  note: string | null;
  problems: unknown;
  runId: string;
  provider: string;
  index: number;
  sourceSlotId: string;
  attempts: number;
  recheck: unknown;
  anchorAssetId: string | null;
};

type PhotoOutcome = "checked" | "waiting" | "failed";
type Transaction = <T>(work: (db: Db) => Promise<T>) => Promise<T>;

export interface UncheckedPhotoCheckDeps {
  /** The reviewer for the provider that drew a photo. Default: the worker's
   * own (worker.ts `themeImageReviewerFor`, loaded lazily). */
  reviewerFor?: (
    provider: string,
  ) => ThemeImageReviewer | null | Promise<ThemeImageReviewer | null>;
  /** Test seam: the photo check itself. */
  review?: typeof reviewThemeImage;
  /** Test seam: the function's own short transactions. */
  transaction?: Transaction;
  now?: () => number;
  keepaliveMs?: number;
}

export function photoRecheckState(value: unknown): PhotoRecheckState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { tries: 0 };
  const raw = value as Record<string, unknown>;
  const tries =
    typeof raw.tries === "number" && Number.isFinite(raw.tries)
      ? Math.max(0, Math.floor(raw.tries))
      : 0;
  return {
    tries,
    ...(typeof raw.at === "string" ? { at: raw.at } : {}),
    ...(typeof raw.until === "string" ? { until: raw.until } : {}),
  };
}

const timeOf = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** What a call may do with one photo's check now. */
export function photoRecheckDecision(
  state: PhotoRecheckState,
  now: number,
): "try" | "busy" | "not_due" | "exhausted" {
  if (state.until && now < timeOf(state.until)) return "busy";
  if (state.tries >= PHOTO_RECHECK_TRIES)
    return now < timeOf(state.at) + PHOTO_RECHECK_RESET_MS
      ? "exhausted"
      : "try";
  if (
    state.tries > 0 &&
    now < timeOf(state.at) + photoRecheckDelayMs(state.tries)
  )
    return "not_due";
  return "try";
}

/** The photos of a version and the check each one has, read as the design
 * review reads them (visual-qa.ts): per stored bytes, the nearest image run
 * in the version's ancestry that drew them. */
async function readPhotoRows(
  db: Db,
  projectId: string,
  versionId: string,
): Promise<PhotoRow[]> {
  const rows = await db.execute(sql`
    WITH RECURSIVE chain(id, parent, run_id, depth) AS (
      SELECT v.id, v.parent_version_id, v.run_id, 0 FROM theme_studio_versions v
       WHERE v.id=${versionId}::uuid AND v.project_id=${projectId}::uuid
      UNION ALL
      SELECT v.id, v.parent_version_id, v.run_id, c.depth+1 FROM theme_studio_versions v
       JOIN chain c ON v.id=c.parent WHERE c.depth<50 AND v.project_id=${projectId}::uuid
    )
    SELECT DISTINCT ON (asset->>'sha256') asset->>'sha256' AS "sha256",
      o.outcome->>'review' AS "review", o.outcome->>'note' AS "note",
      o.outcome->'problems' AS "problems",
      r.id AS "runId", r.provider AS "provider", (o.ord - 1)::int AS "index",
      o.outcome->>'slotId' AS "sourceSlotId",
      CASE WHEN jsonb_typeof(o.outcome->'attempts') = 'number'
        THEN (o.outcome->>'attempts')::numeric::int ELSE 1 END AS "attempts",
      o.outcome->'recheck' AS "recheck",
      r.outcome_detail->>'anchorAssetId' AS "anchorAssetId"
      FROM chain c JOIN theme_studio_versions v ON v.id=c.id
      JOIN theme_studio_runs r ON r.id=c.run_id AND r.project_id=${projectId}::uuid AND r.kind='images'
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.outcome_detail->'outcomes', '[]'::jsonb)) WITH ORDINALITY o(outcome, ord)
      CROSS JOIN LATERAL jsonb_array_elements(v.package_json->'assets') asset
     WHERE o.outcome->>'status'='generated' AND asset->>'id'=o.outcome->>'slotId'
     ORDER BY asset->>'sha256', c.depth
  `);
  return rows.rows as PhotoRow[];
}

/** A stored WebP's bytes, as base64 (the form the check is sent). */
async function readWebp(
  db: Db,
  projectId: string,
  where: { sha256: string } | { anchorId: string },
): Promise<string | null> {
  const rows = await db.execute(sql`
    SELECT bytes AS "bytes" FROM theme_studio_assets
     WHERE project_id=${projectId}::uuid AND media_type='image/webp'
       AND ${
         "sha256" in where
           ? sql`purpose='image' AND sha256=${where.sha256}`
           : sql`purpose='anchor' AND id=${where.anchorId}::uuid`
       }
     LIMIT 1`);
  const bytes = (rows.rows[0] as { bytes?: unknown } | undefined)?.bytes;
  return Buffer.isBuffer(bytes) && bytes.length
    ? bytes.toString("base64")
    : null;
}

type PlannedCheck = {
  row: PhotoRow;
  slotId: string;
  input: ThemeImageReviewInput;
};

/** The version's photos still unchecked, read as the design review reads
 *  them. */
type UncheckedRead = {
  pkg: ThemePackageV2;
  intentJson: unknown;
  rows: PhotoRow[];
  unchecked: QaImageIssue[];
};

/** What one call does: nothing more (`done`), or the photos it may try now
 *  with the bytes each is sent with, and the outcome of each it may not. */
type PhotoPlan =
  | { done: UncheckedPhotosResult }
  | { photos: number; outcomes: PhotoOutcome[]; planned: PlannedCheck[] };

/** 1. The version and its photos; `done` when every photo has its check (the
 *  usual case) or the version cannot be read. */
async function readUncheckedPhotos(
  db: Db,
  projectId: string,
  versionId: string,
  unrecordable: (reason: string) => void,
): Promise<UncheckedRead | { done: UncheckedPhotosResult }> {
  const [version] = (
    await db.execute(sql`
      SELECT package_json AS "packageJson", intent_json AS "intentJson"
        FROM theme_studio_versions
       WHERE id=${versionId}::uuid AND project_id=${projectId}::uuid`)
  ).rows as { packageJson: unknown; intentJson: unknown }[];
  const pkg = version ? validateThemePackageV2(version.packageJson) : null;
  if (!pkg?.ok) {
    unrecordable(version ? "package_invalid" : "version_missing");
    return { done: "failed" };
  }
  const rows = await readPhotoRows(db, projectId, versionId);
  const unchecked = qaImageIssues(
    pkg.value,
    rows.map((row) => ({ ...row, review: row.review ?? "" })),
  ).filter((issue) => issue.review === "unreviewed");
  // The usual case: every photo was checked as it was drawn.
  if (unchecked.length === 0) return { done: "passed" };
  return { pkg: pkg.value, intentJson: version.intentJson, rows, unchecked };
}

/** A caller's own transaction stays open while the checks run, so it must
 *  hold no row lock and have written nothing: refused before any payment. */
async function refuseHeldTransaction(db: Db): Promise<void> {
  const [held] = (
    await db.execute(
      sql`SELECT txid_current_if_assigned() IS NOT NULL AS "held"`,
    )
  ).rows as { held?: boolean }[];
  if (held?.held)
    throw new Error(
      "checkUncheckedPhotos waits on photo checks: call it with a transaction that holds no lock and has written nothing.",
    );
}

/** 2. Each unchecked photo: whether its check may be tried now, and the
 *  bytes it is sent with (its stored crop, its run's anchor, a SET). */
async function planPhotoChecks(
  db: Db,
  projectId: string,
  found: UncheckedRead,
  now: () => number,
  unrecordable: (reason: string) => void,
): Promise<PhotoPlan> {
  const { pkg, rows, unchecked } = found;
  const intent = validateThemeIntent(found.intentJson);
  const byBytes = new Map(rows.map((row) => [row.sha256, row]));
  const passedShas = rows
    .filter((row) => row.review === "passed")
    .map((row) => row.sha256);
  const anchors = new Map<string, string | null>();
  const outcomes: PhotoOutcome[] = [];
  const planned: PlannedCheck[] = [];
  for (const issue of unchecked) {
    const row = byBytes.get(issue.sha256);
    if (!row || !Number.isInteger(row.index) || row.index < 0) {
      unrecordable("no_photo_record");
      outcomes.push("failed");
      continue;
    }
    const decision = photoRecheckDecision(
      photoRecheckState(row.recheck),
      now(),
    );
    if (decision !== "try") {
      outcomes.push(decision === "exhausted" ? "failed" : "waiting");
      continue;
    }
    const slot = intent.ok
      ? generatableSlots(pkg, intent.value, [issue.slotId])[0]
      : undefined;
    const candidate = slot
      ? await readWebp(db, projectId, { sha256: issue.sha256 })
      : null;
    if (!slot || !candidate) {
      unrecordable(slot ? "photo_missing" : "no_brief");
      outcomes.push("failed");
      continue;
    }
    if (row.anchorAssetId && !anchors.has(row.anchorAssetId))
      anchors.set(
        row.anchorAssetId,
        await readWebp(db, projectId, { anchorId: row.anchorAssetId }),
      );
    const setSha =
      slot.purpose === "product"
        ? productSetReferenceSha(pkg, [issue.slotId], passedShas)
        : null;
    planned.push({
      row,
      slotId: issue.slotId,
      input: {
        purpose: slot.purpose,
        brief: slot.brief,
        candidate,
        anchor: row.anchorAssetId
          ? (anchors.get(row.anchorAssetId) ?? null)
          : null,
        set:
          setSha && setSha !== issue.sha256
            ? await readWebp(db, projectId, { sha256: setSha })
            : null,
        attempt: Math.max(1, row.attempts || 1),
      },
    });
  }
  return { photos: unchecked.length, outcomes, planned };
}

export async function checkUncheckedPhotos(
  source: Db | Transaction,
  input: {
    projectId: string;
    versionId: string;
    /** The caller's stop (a lost lease): a check it stops is not a try. */
    signal: AbortSignal;
    /** When every check must have answered, in ms on `deps.now`'s clock: a
     *  check starts only with PHOTO_RECHECK_MIN_CLOCK_MS left, and its own
     *  clock is what is left. Without it, each check's clock is
     *  PHOTO_RECHECK_CALL_MS. */
    deadline?: number;
  },
  deps: UncheckedPhotoCheckDeps = {},
): Promise<UncheckedPhotosResult> {
  const { projectId, versionId, signal, deadline } = input;
  const now = deps.now ?? Date.now;
  const unrecordable = (reason: string) =>
    logWarn("theme_studio.photo_check_unrecordable", {
      projectId,
      versionId,
      reason,
    });
  // ★ A transaction runner (`withService`): the reads below run in a short
  //   transaction of its own, committed before any check is sent, and the
  //   runner is the function's own transaction for its claims and records.
  //   A `db`: the caller's own open transaction, read through as before.
  const callerDb = typeof source === "function" ? null : source;
  const runner = typeof source === "function" ? source : null;

  // 1 and 2. Read only: the version, its photos and the bytes to send.
  const read = async (db: Db): Promise<PhotoPlan> => {
    const found = await readUncheckedPhotos(
      db,
      projectId,
      versionId,
      unrecordable,
    );
    if ("done" in found) return found;
    if (signal.aborted) return { done: "waiting" };
    if (callerDb) await refuseHeldTransaction(db);
    return planPhotoChecks(db, projectId, found, now, unrecordable);
  };
  const plan =
    typeof source === "function" ? await source(read) : await read(source);
  if ("done" in plan) return plan.done;
  const { outcomes, planned } = plan;

  // 3. The checks, outside any transaction of ours, a few at a time.
  if (planned.length) {
    const reviewers = new Map<string, ThemeImageReviewer | null>();
    const reviewerFor = async (provider: string) => {
      if (!reviewers.has(provider))
        reviewers.set(
          provider,
          deps.reviewerFor
            ? await deps.reviewerFor(provider)
            : (await import("./worker")).themeImageReviewerFor(provider),
        );
      return reviewers.get(provider) ?? null;
    };
    // Only a caller's own lock-free transaction is still open: it is kept
    // from the idle limit meanwhile. A runner's reads have committed.
    let keepalive: Promise<unknown> = Promise.resolve();
    const timer = callerDb
      ? setInterval(() => {
          keepalive = keepalive
            .then(() => callerDb.execute(sql`SELECT 1`))
            .catch(() => {});
        }, deps.keepaliveMs ?? CALLER_KEEPALIVE_MS)
      : null;
    try {
      const queue = [...planned];
      await Promise.all(
        Array.from(
          { length: Math.min(PHOTO_RECHECK_CONCURRENCY, queue.length) },
          async () => {
            for (let next = queue.shift(); next; next = queue.shift()) {
              // ★ Too little time left before the caller's deadline for a
              //   whole try at the US and one at global: the photo is left
              //   for a later call, unclaimed and unpaid.
              if (
                deadline !== undefined &&
                deadline - now() < PHOTO_RECHECK_MIN_CLOCK_MS
              ) {
                outcomes.push("waiting");
                continue;
              }
              const reviewer = await reviewerFor(next.row.provider);
              if (!reviewer) {
                unrecordable("reviewer_unavailable");
                outcomes.push("failed");
                continue;
              }
              outcomes.push(
                await checkOnePhoto({
                  projectId,
                  planned: next,
                  reviewer,
                  review: deps.review ?? reviewThemeImage,
                  transaction: deps.transaction ?? runner ?? withService,
                  now,
                  signal,
                  deadline,
                }),
              );
            }
          },
        ),
      );
    } finally {
      if (timer) clearInterval(timer);
      await keepalive;
    }
  }

  const count = (o: PhotoOutcome) => outcomes.filter((x) => x === o).length;
  const result: UncheckedPhotosResult = count("failed")
    ? "failed"
    : count("waiting")
      ? "waiting"
      : "passed";
  // Ids and counts only.
  logInfo("theme_studio.photo_check", {
    projectId,
    versionId,
    outcome: result,
    photos: plan.photos,
    checked: count("checked"),
    waiting: count("waiting"),
    failed: count("failed"),
  });
  return result;
}

/** The photo's entry in its run's outcomes, confirmed to be that photo. */
function photoEntry(
  detail: unknown,
  row: PhotoRow,
): {
  detail: Record<string, unknown>;
  outcomes: Record<string, unknown>[];
  entry: Record<string, unknown>;
} | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail))
    return null;
  const outcomes = (detail as { outcomes?: unknown }).outcomes;
  if (!Array.isArray(outcomes)) return null;
  const entry = outcomes[row.index] as Record<string, unknown> | undefined;
  if (
    !entry ||
    typeof entry !== "object" ||
    entry.slotId !== row.sourceSlotId ||
    entry.status !== "generated"
  )
    return null;
  return {
    detail: detail as Record<string, unknown>,
    outcomes: outcomes as Record<string, unknown>[],
    entry,
  };
}

const checkedAlready = (entry: Record<string, unknown>) =>
  entry.review === "passed" || entry.review === "flagged";

async function lockPhotoRun(db: Db, projectId: string, row: PhotoRow) {
  const [locked] = (
    await db.execute(sql`
      SELECT outcome_detail AS "detail", usage AS "usage" FROM theme_studio_runs
       WHERE id=${row.runId}::uuid AND project_id=${projectId}::uuid
         AND kind='images' AND status='succeeded'
       FOR UPDATE`)
  ).rows as { detail: unknown; usage: unknown }[];
  if (!locked) return null;
  const found = photoEntry(locked.detail, row);
  return found ? { ...found, usage: locked.usage } : null;
}

/** False when the amended record would not fit the column's 16 KiB. */
async function writePhotoRun(
  db: Db,
  runId: string,
  detail: Record<string, unknown>,
  usage?: Record<string, unknown>,
): Promise<boolean> {
  const text = JSON.stringify(detail);
  if (Buffer.byteLength(text) > OUTCOME_DETAIL_MAX_BYTES) return false;
  await db.execute(sql`
    UPDATE theme_studio_runs
       SET outcome_detail=${text}::jsonb${
         usage ? sql`, usage=${JSON.stringify(usage)}::jsonb` : sql``
       }
     WHERE id=${runId}::uuid`);
  return true;
}

/** The run's usage with this check's call and spend added. */
function withCheckSpend(
  usage: unknown,
  call: ReviewCall & { recheck: true },
): Record<string, unknown> {
  const base =
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? { ...(usage as Record<string, unknown>) }
      : {};
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    ...base,
    reviews: [...(Array.isArray(base.reviews) ? base.reviews : []), call],
    estimatedCostMicroUsd:
      num(base.estimatedCostMicroUsd) + call.estimatedCostMicroUsd,
    reviewCostMicroUsd:
      num(base.reviewCostMicroUsd) + call.estimatedCostMicroUsd,
  };
}

type Claim = { at: string; tries: number; previous: PhotoRecheckState };

async function checkOnePhoto(ctx: {
  projectId: string;
  planned: PlannedCheck;
  reviewer: ThemeImageReviewer;
  review: typeof reviewThemeImage;
  transaction: Transaction;
  now: () => number;
  signal: AbortSignal;
  /** The caller's deadline: the check's own clock ends there. */
  deadline?: number;
}): Promise<PhotoOutcome> {
  const { projectId, planned, now } = ctx;
  const { row } = planned;
  try {
    // a. Claim the try, in a short transaction of its own.
    const claim = await ctx.transaction(
      async (db): Promise<PhotoOutcome | Claim> => {
        const found = await lockPhotoRun(db, projectId, row);
        if (!found) return "failed";
        if (checkedAlready(found.entry)) return "checked";
        const previous = photoRecheckState(found.entry.recheck);
        const at = now();
        const decision = photoRecheckDecision(previous, at);
        if (decision !== "try")
          return decision === "exhausted" ? "failed" : "waiting";
        // A fresh round after the reset counts from zero again.
        const tries =
          previous.tries >= PHOTO_RECHECK_TRIES ? 0 : previous.tries;
        const stamp = new Date(at).toISOString();
        found.entry.recheck = {
          tries,
          at: stamp,
          until: new Date(at + PHOTO_RECHECK_CLAIM_MS).toISOString(),
        };
        const claimed = await writePhotoRun(db, row.runId, {
          ...found.detail,
          outcomes: found.outcomes,
        });
        return claimed ? { at: stamp, tries, previous } : "failed";
      },
    );
    if (typeof claim === "string") return claim;

    // b. The check itself, outside any transaction, on its own clock: five
    //    minutes, or what is left before the caller's deadline. A cut by
    //    that clock is a try like any timeout (step c).
    const started = now();
    const clockMs =
      ctx.deadline === undefined
        ? PHOTO_RECHECK_CALL_MS
        : Math.max(1, Math.min(PHOTO_RECHECK_CALL_MS, ctx.deadline - started));
    const result = await ctx.review(
      ctx.reviewer.client,
      ctx.reviewer.providerModel,
      planned.input,
      AbortSignal.any([ctx.signal, AbortSignal.timeout(clockMs)]),
    );
    const durationMs = Math.max(0, now() - started);
    const stoppedByCaller = ctx.signal.aborted && result.kind !== "reviewed";

    // c. Record what came back, in another short transaction.
    return await ctx.transaction(async (db): Promise<PhotoOutcome> => {
      const found = await lockPhotoRun(db, projectId, row);
      if (!found) return "failed";
      const paid =
        result.usage.inputTokens +
          result.usage.outputTokens +
          result.usage.thinkingTokens >
        0;
      const usage =
        paid || result.kind === "reviewed"
          ? withCheckSpend(found.usage, {
              briefId: planned.slotId,
              attempt: planned.input.attempt,
              outcome:
                result.kind === "unavailable"
                  ? "unavailable"
                  : result.problems.length
                    ? "problems"
                    : "passed",
              problems: result.kind === "reviewed" ? result.problems : [],
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              thinkingTokens: result.usage.thinkingTokens,
              estimatedCostMicroUsd: result.estimatedCostMicroUsd,
              durationMs,
              ...(result.kind === "unavailable"
                ? { errorCode: result.code }
                : {}),
              recheck: true,
            })
          : undefined;
      if (result.kind === "reviewed") {
        // Evidence on these exact bytes, whoever holds the claim now.
        if (!checkedAlready(found.entry)) {
          found.entry.review = result.problems.length ? "flagged" : "passed";
          if (result.problems.length) {
            found.entry.problems = result.problems;
            found.entry.note = result.note;
          }
          found.entry.recheckedAt = claim.at;
          delete found.entry.recheck;
        }
        const detail = { ...found.detail, outcomes: found.outcomes };
        if (await writePhotoRun(db, row.runId, detail, usage)) return "checked";
        // Too large with the note: keep the problems, which decide.
        delete found.entry.note;
        return (await writePhotoRun(db, row.runId, detail, usage))
          ? "checked"
          : "failed";
      }
      if (photoRecheckState(found.entry.recheck).at !== claim.at) {
        // Our claim lapsed and another caller holds the photo now.
        if (usage) await writePhotoRun(db, row.runId, found.detail, usage);
        return "waiting";
      }
      if (stoppedByCaller) {
        // A check the caller stopped is not a try: the claim is released
        // and the photo is left as it was before it.
        found.entry.recheck = {
          tries: claim.previous.tries,
          ...(claim.previous.at ? { at: claim.previous.at } : {}),
        };
        await writePhotoRun(
          db,
          row.runId,
          { ...found.detail, outcomes: found.outcomes },
          usage,
        );
        return "waiting";
      }
      const tries = claim.tries + 1;
      found.entry.recheck = { tries, at: claim.at };
      await writePhotoRun(
        db,
        row.runId,
        { ...found.detail, outcomes: found.outcomes },
        usage,
      );
      return tries >= PHOTO_RECHECK_TRIES ? "failed" : "waiting";
    });
  } catch (error) {
    logWarn("theme_studio.photo_check_deferred", {
      projectId,
      runId: row.runId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return "waiting";
  }
}
