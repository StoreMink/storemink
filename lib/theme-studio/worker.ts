import "server-only";

import { randomUUID } from "node:crypto";
import { ThinkingLevel } from "@google/genai";
import { and, asc, count, eq, gt, inArray, lte, max, sql } from "drizzle-orm";
import {
  themeStudioAssets,
  themeStudioGenerationResponses,
  themeStudioMessages,
  themeStudioProjects,
  themeStudioRuns,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getThemeDefinition, isBundledThemeId } from "@/lib/themes";
import type {
  ThemeCatalogSize,
  ThemeFeature,
  ThemeIndustry,
} from "@/lib/themes/meta";
import { createVertexModelClient, getVertexConfig } from "./gemini-vertex";
import { sharedProviderCapacity } from "./provider-capacity-store";
import { themePromptFeatures } from "./prompt-features";
import { loadVarietyContext, VarietyLeaseLostError } from "./variety-context";
import {
  readDistinctnessReport,
  type ExistingThemeFingerprint,
  type DistinctnessReport,
} from "./fingerprint";
import { getThemeStudioConfig, type ThemeStudioProvider } from "./config";
import {
  THEME_STUDIO_LIMITS,
  validateThemeIntent,
  validateThemePackageV2,
  type ThemeIntent,
  type ThemePackageV2,
} from "./contracts";
import { createFakeModelClient } from "./fake-provider";
import {
  createFakeImageClient,
  createFakeImageReviewClient,
} from "./image-fake";
import { THEME_IMAGE_REVIEW_MODEL_KEY } from "./image-review";
import {
  applyGeneratedImages,
  generatableSlots,
  productSetReferenceSha,
} from "./image-generation-core";
import { captureBlockers, captureShots } from "./capture-core";
import {
  runThemeImageGeneration,
  type ThemeImageReviewer,
  type ThemeImageRunResult,
} from "./image-generation";
import {
  THEME_STUDIO_IMAGE_MODEL_KEY,
  getThemeStudioImageConfig,
  homepageOpeningPhotoIds,
  themeStudioImageSize,
} from "./image-models";
import { describeSlots } from "./slot-images-core";
import { MAX_AUTOMATIC_QA_REPAIRS } from "./automatic-qa-policy";
import type { ThemeStudioImageClient } from "./image-provider";
import { createVertexImageClient } from "./image-vertex";
import { ELEVENLABS_IMAGE_MODEL } from "@/lib/images/elevenlabs-images";
import {
  createElevenLabsImageClient,
  type ElevenLabsThemeClientOptions,
} from "@/lib/images/elevenlabs-theme-client";
import {
  elevenLabsApiKey,
  resolveImageProvider,
} from "@/lib/images/provider-settings-store";
import {
  THEME_STUDIO_MODELS,
  resolveThemeStudioModel,
  type ThemeStudioModelKey,
} from "./models";
import { runThemeGeneration, type GenerationOutcome } from "./pipeline";
import type { ThemeStudioModelClient } from "./provider";
import {
  generationRecoveryDelayMs,
  isWaitedProviderFailure,
  providerFailureDelayMs,
  resumableGenerationClient,
  type SavedModelResponse,
} from "./generation-recovery";
import { sendThemeStudioNotice, type ThemeStudioNoticeKind } from "./notify";
import { digestThemeStudioJson, recordThemeStudioEvent } from "./repository";
import { restingStatusSql } from "./published-version";
import { runThemeStudioVisualQaWorker } from "./visual-qa";
import {
  automaticImageProvider,
  queueAutomaticCapture,
  queueAutomaticImages,
} from "./automatic-work";
import { createImageCheckpointStore } from "./image-checkpoint-store";
import { startWorkerLease, WORKER_LEASE_SECONDS } from "./worker-lease";
import { renewStudioLease } from "./worker-lease-store";
import {
  IMAGE_CRASH_ATTEMPTS,
  IMAGE_REVIEW_DEFERRALS,
  ImageCheckpointError,
  imageReviewRecoveryDelayMs,
  resumableImageClient,
  resumableImageReview,
} from "./image-recovery";

// ---------------------------------------------------------------------------
// The Theme Studio run worker.
//
// ★ IT ACCEPTS NO OPERATOR INPUT. It claims a queued row and derives every
// other fact — the brief, the references, the model — from service-owned
// storage. Nothing a browser sent reaches it except through those rows.
//
// ★ A LEASE, NOT A LOCK HELD ACROSS WORK. A claim is one short transaction
// that marks the run `running` with an expiry; the provider call happens
// outside any transaction, and a second short transaction records the
// outcome only if this worker still holds the lease. A crashed worker's run
// becomes claimable again when its lease expires, until its attempts run out.
//
// ★ EXACTLY ONE VERSION PER RUN. `theme_studio_versions.run_id` is UNIQUE, so
// a finish that somehow ran twice cannot create a second version.
//
// ★ Logs carry ids, provider, model key, status and safe codes — never the
// brief, a reference, or model output (Phase 0 threat model).
// ---------------------------------------------------------------------------

const LEASE_SECONDS = WORKER_LEASE_SECONDS;

/**
 * ★ THEME STUDIO'S LONG TEXT CALLS QUEUE ON A CAPACITY ROW OF THEIR OWN (plan
 * optimisation 8, TS-3B). Designing, revising and repairing a theme are
 * calls of minutes on the same model the photo checks use (3.8 Flash), so on
 * the shared row a design call held a permit that a photo check, a Theme
 * Studio one or a merchant redesign's, was waiting for. A scope gives them
 * their own permits, pause and pace (provider-capacity.ts
 * `providerCapacityKey`; the row is created on first use, no migration). The
 * photo checks stay on the shared row and the design review has its own lane
 * (TS-3A).
 */
export const THEME_STUDIO_TEXT_CAPACITY_SCOPE = "theme-studio-text";

/**
 * ★ A FRESH PHOTO RUN STARTS ONLY WITH 9 MINUTES OF ITS REQUEST LEFT (plan
 * optimisation 4). A photo run starts with its style photo, and one started
 * near the end of the 19-minute request was cut during it. A run that has
 * started already (`started_at` is set: a continuation, a review wait, a
 * crash) carries on with whatever time is left, because everything it drew
 * is saved and replays at once.
 */
export const FRESH_PHOTO_RUN_MIN_MS = 9 * 60_000;

/**
 * ★ A PHOTO RUN CUT BY ITS REQUEST'S DEADLINE CONTINUES IN THE NEXT REQUEST
 * (plan optimisation 4). Two of five first photo runs were cut at exactly 19
 * minutes on 4 Oct, which failed the theme during the style photo
 * (`images_anchor_cancelled`) or spent one of the three fill rounds. Now the
 * run goes back to the queue as it is: its drawings and checks are saved
 * (image checkpoints), so the next claim replays them without paying again
 * and draws only what is left. A continuation is a delayed recovery
 * (`retry_not_before`), never one of the three crash attempts, and it is
 * counted from the run's own `run_queued` events (reason `deadline`). After
 * this many the run settles with what it has and the fill rounds finish it.
 */
export const PHOTO_RUN_CONTINUATIONS = 3;

export interface ThemeStudioWorkerResult {
  claimed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  requeued: number;
  reaped: number;
}

type ClaimedRun = {
  id: string;
  projectId: string;
  messageId: string;
  kind: "generate" | "revise" | "images";
  baseVersionId: string | null;
  basePackageDigest: string | null;
  contextMessageIds: string[];
  /** Image runs: the slots to redraw; empty means every placeholder. */
  imageSlotIds: string[];
  provider: string;
  modelKey: string;
  providerModel: string;
  promptVersion: string;
  attemptCount: number;
  maxAttempts: number;
  rateLimitDeferrals: number;
  imageReviewDeferrals: number;
  automatic: boolean;
  qaIteration: number;
  createdBy: string | null;
};

/** What settling one claimed run did, for the worker's counters, its log
 * line and the operator's notice (sent after the settling transaction). */
type Settlement = {
  settled: "succeeded" | "failed" | "cancelled" | "requeued" | "lost";
  /** The code a failed run was given, or why a requeued one waits. */
  errorCode?: string;
  /** A failed photo run whose slots a fill round it queued draws again (a
   * style photo refused or rejected, or nothing drawn): the theme is still
   * generating, so the run's log line says so and no alert fires. */
  continues?: true;
  /** Set when this settlement ended the theme's work and needs the operator. */
  notice?: ThemeStudioNoticeKind;
};

/**
 * Tell the operator who started the theme, once the settling transaction has
 * committed: a short read, then the notice in its own short transaction,
 * never one inside the other (notify.ts). Never throws.
 */
function sendNotice(projectId: string, kind: ThemeStudioNoticeKind) {
  return sendThemeStudioNotice({ projectId, kind });
}

/**
 * How many times this run already went back to the queue for `reason`,
 * counted from its own `run_queued` events (the event detail records the
 * reason), so a wait needs no column of its own and survives every reclaim.
 */
async function countRunWaits(
  db: Db,
  run: Pick<ClaimedRun, "id" | "projectId">,
  reason: string,
): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS "n" FROM theme_studio_events
    WHERE project_id = ${run.projectId}::uuid AND run_id = ${run.id}::uuid
      AND event_type = 'run_queued' AND detail->>'reason' = ${reason}`);
  return Number((rows.rows[0] as { n?: unknown } | undefined)?.n ?? 0) || 0;
}

async function reapExhaustedLeases(
  db: Db,
): Promise<{ reaped: number; notices: string[] }> {
  // Two kinds of dead lease end here instead of being re-run: one out of
  // attempts, and one whose operator already asked to cancel it. Reclaiming the
  // second would pay for a whole provider call only to throw the result away.
  const rows = await db.execute(sql`
    WITH expired AS (
      SELECT id, project_id, (cancel_requested_at IS NOT NULL) AS cancelled
      FROM theme_studio_runs
      WHERE status = 'running' AND lease_expires_at <= now()
        AND (attempt_count >= max_attempts OR cancel_requested_at IS NOT NULL)
      ORDER BY created_at
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    UPDATE theme_studio_runs r
    SET status = CASE WHEN expired.cancelled THEN 'cancelled' ELSE 'failed' END,
        error_code = CASE WHEN expired.cancelled THEN NULL ELSE 'lease_expired' END,
        lease_owner = NULL, lease_expires_at = NULL,
        finished_at = now(), updated_at = now()
    FROM expired WHERE r.id = expired.id
    RETURNING r.id AS "id", r.project_id AS "projectId", r.status AS "status",
              r.automatic AS "automatic", r.base_version_id AS "baseVersionId"
  `);
  const reaped = rows.rows as {
    id: string;
    projectId: string;
    status: "failed" | "cancelled";
    automatic: boolean;
    baseVersionId: string | null;
  }[];
  // A run whose lease ran out of attempts stopped the theme: its operator is
  // told (after this transaction commits). A cancelled one was their choice.
  const notices: string[] = [];
  for (const run of reaped) {
    const stopped = await settleStoppedProject(
      db,
      run,
      run.status === "cancelled" ? "cancelled" : "lease_expired",
    );
    if (stopped && run.status === "failed") notices.push(run.projectId);
    await recordThemeStudioEvent(db, {
      projectId: run.projectId,
      runId: run.id,
      actor: "worker",
      eventType: run.status === "cancelled" ? "run_cancelled" : "run_failed",
      detail: run.status === "cancelled" ? {} : { errorCode: "lease_expired" },
    });
  }
  return { reaped: reaped.length, notices };
}

async function claimRun(
  db: Db,
  workerId: string,
  providers: readonly ThemeStudioProvider[],
  remainingMs = RUN_DEADLINE_MS,
): Promise<ClaimedRun | null> {
  const providerList = sql.join(
    providers.map((p) => sql`${p}`),
    sql`, `,
  );
  // Older workers cannot reclaim retryable image runs without durable replay.
  // Migration 0150 gates claims on this transaction-local protocol declaration.
  // ★ A fresh photo run needs FRESH_PHOTO_RUN_MIN_MS of the request; one that
  //   has started continues with less (optimisation 4).
  // ★ AUTOMATIC REPAIRS GO TO THE FRONT OF THE QUEUE (optimisation 7): a
  //   repair takes 3 to 23 s of model time but waited a median 117 s behind
  //   other work (measured 4 Oct), and the theme it repairs waits with it.
  const rows = await db.execute(sql`
    WITH protocol AS MATERIALIZED (
      SELECT set_config('app.theme_studio_image_recovery','v1',true)
    ), candidate AS (
      SELECT id FROM theme_studio_runs CROSS JOIN protocol
      WHERE provider IN (${providerList})
        AND (${remainingMs}::int >= 600000
             OR (kind='images' AND (started_at IS NOT NULL OR ${remainingMs}::int >= ${FRESH_PHOTO_RUN_MIN_MS}::int))
             OR (kind='revise' AND automatic))
        AND ((status = 'queued' AND cancel_requested_at IS NULL
              AND (retry_not_before IS NULL OR retry_not_before <= now()))
         OR (status = 'running' AND lease_expires_at <= now()
             AND attempt_count < max_attempts AND cancel_requested_at IS NULL))
      ORDER BY (kind = 'revise' AND automatic) DESC, created_at
      LIMIT 1
      FOR UPDATE OF theme_studio_runs SKIP LOCKED
    )
    UPDATE theme_studio_runs r
    SET status = 'running',
        max_attempts = CASE WHEN r.kind='images' THEN ${IMAGE_CRASH_ATTEMPTS} ELSE r.max_attempts END,
        lease_owner = ${workerId}::uuid,
        lease_expires_at = now() + (${LEASE_SECONDS}::int * interval '1 second'),
        attempt_count = r.attempt_count + CASE WHEN r.retry_not_before IS NULL THEN 1 ELSE 0 END,
        retry_not_before = NULL,
        started_at = coalesce(r.started_at, now()),
        updated_at = now()
    FROM candidate WHERE r.id = candidate.id
    RETURNING r.id AS "id", r.project_id AS "projectId", r.message_id AS "messageId",
              r.kind AS "kind", r.base_version_id AS "baseVersionId",
              r.base_package_digest AS "basePackageDigest",
              r.context_message_ids AS "contextMessageIds",
              r.image_slot_ids AS "imageSlotIds",
              r.provider AS "provider", r.model_key AS "modelKey",
              r.provider_model AS "providerModel", r.prompt_version AS "promptVersion",
              r.attempt_count AS "attemptCount", r.max_attempts AS "maxAttempts",
              r.rate_limit_deferrals AS "rateLimitDeferrals",
              r.image_review_deferrals AS "imageReviewDeferrals",
              r.automatic AS "automatic", r.qa_iteration AS "qaIteration",
              r.created_by AS "createdBy"
  `);
  const row = rows.rows[0] as ClaimedRun | undefined;
  return row ?? null;
}

/**
 * ★★ AN IMAGE RUN WITH GAPS IS KEPT AND REFILLED, NEVER THROWN AWAY.
 * Measured in production (2026-09-29): an automatic run drew 14 of 18 images
 * (~$2.22) and failed as `auto_images_incomplete`, because four slots were
 * rate-limited or refused — so version 1 was revealed with every placeholder
 * and the operator had to press Generate again, which then left five more.
 * Now the images that came back are saved as a version and a FILL run is
 * queued for exactly the slots still missing, reusing the same art-direction
 * image, up to IMAGE_FILL_ROUNDS times. Only then does automatic QA capture
 * (or reveal the most complete version). A manual run is refilled the same
 * way, so "Generate images" means every image, not most of them.
 *
 * The round is recorded in the fill run's idempotency key,
 * `images_fill_<first image run id>_<round>`, which bounds the chain with no
 * new column and lets the unique key refuse a double-queue.
 */
export const IMAGE_FILL_ROUNDS = 3;
const FILL_KEY = /^images_fill_([0-9a-f-]{36})_(\d+)$/;

function fillPosition(
  runId: string,
  idempotencyKey: string | null,
): { root: string; round: number } {
  const match = idempotencyKey ? FILL_KEY.exec(idempotencyKey) : null;
  return match
    ? { root: match[1], round: Number(match[2]) }
    : { root: runId, round: 0 };
}

async function queueFillImages(
  db: Db,
  run: ClaimedRun,
  base: { id: string; packageDigest: string },
  slotIds: readonly string[],
  next: { root: string; round: number },
): Promise<boolean> {
  const resolved = automaticImageProvider(run);
  if (!resolved || slotIds.length === 0) return false;
  const [message] = await db
    .insert(themeStudioMessages)
    .values({
      projectId: run.projectId,
      kind: "images",
      body: `Draw the ${slotIds.length} image${slotIds.length === 1 ? "" : "s"} the last run could not finish (round ${next.round} of ${IMAGE_FILL_ROUNDS}).`,
      referenceAssetIds: [],
      createdBy: run.createdBy,
    })
    .returning({ id: themeStudioMessages.id });
  const [fillRun] = await db
    .insert(themeStudioRuns)
    .values({
      projectId: run.projectId,
      messageId: message.id,
      kind: "images",
      baseVersionId: base.id,
      basePackageDigest: base.packageDigest,
      contextMessageIds: [],
      provider: run.provider,
      modelKey: run.modelKey,
      providerModel: resolved.providerModel,
      promptVersion: resolved.promptVersion,
      idempotencyKey: `images_fill_${next.root}_${next.round}`,
      maxAttempts: IMAGE_CRASH_ATTEMPTS,
      imageSlotIds: [...slotIds],
      automatic: run.automatic,
      qaIteration: run.qaIteration,
      createdBy: run.createdBy,
    })
    .onConflictDoNothing({ target: themeStudioRuns.idempotencyKey })
    .returning({ id: themeStudioRuns.id });
  if (!fillRun) return false;
  await recordThemeStudioEvent(db, {
    projectId: run.projectId,
    runId: fillRun.id,
    actor: "worker",
    eventType: "images_requested",
    detail: {
      versionId: base.id,
      slots: slotIds.length,
      automatic: run.automatic,
      qaIteration: run.qaIteration,
      fillRound: next.round,
    },
  });
  return true;
}

/** Reveal the most complete version with a failed QA result for recovery.
 * True when it was revealed. */
async function revealIncomplete(
  db: Db,
  run: ClaimedRun,
  versionId: string,
): Promise<boolean> {
  const revealed = await revealAutomaticBase(
    db,
    { ...run, baseVersionId: versionId },
    "auto_images_incomplete",
  );
  return revealed ? revealed.settled : false;
}

/** Only legal from `generating`; a project in any other state is left alone.
 * True when the project left `generating` here (the theme stopped). */
async function settleProjectWithoutVersion(
  db: Db,
  projectId: string,
): Promise<boolean> {
  const settled = await db
    .update(themeStudioProjects)
    .set({
      // `published` when the design it kept is a published one: a change to
      // a live theme that did not finish leaves it live (0288).
      status: restingStatusSql(),
      revision: sql`${themeStudioProjects.revision} + 1`,
    })
    .where(
      and(
        eq(themeStudioProjects.id, projectId),
        eq(themeStudioProjects.status, "generating"),
      ),
    )
    .returning({ id: themeStudioProjects.id });
  return settled.length > 0;
}

/** An automated child failed after its hidden base existed. Reveal that last
 * complete base as a clearly failed QA result instead of stranding the
 * project with no operator-visible outcome. False when there was none to
 * reveal; otherwise whether the project left `generating` here. */
async function revealAutomaticBase(
  db: Db,
  run: Pick<ClaimedRun, "id" | "projectId" | "automatic" | "baseVersionId">,
  errorCode: string,
): Promise<false | { settled: boolean }> {
  if (!run.automatic || !run.baseVersionId) return false;
  const revealed = await db
    .update(themeStudioVersions)
    .set({ visibility: "operator", qaStatus: "failed" })
    .where(
      and(
        eq(themeStudioVersions.id, run.baseVersionId),
        eq(themeStudioVersions.projectId, run.projectId),
        eq(themeStudioVersions.visibility, "internal"),
        eq(themeStudioVersions.qaStatus, "pending"),
      ),
    )
    .returning({ id: themeStudioVersions.id });
  if (revealed.length === 0) return false;
  const settled = await db
    .update(themeStudioProjects)
    .set({
      status: "ready",
      currentVersionId: run.baseVersionId,
      revision: sql`${themeStudioProjects.revision} + 1`,
    })
    .where(
      and(
        eq(themeStudioProjects.id, run.projectId),
        eq(themeStudioProjects.status, "generating"),
      ),
    )
    .returning({ id: themeStudioProjects.id });
  await recordThemeStudioEvent(db, {
    projectId: run.projectId,
    runId: run.id,
    actor: "worker",
    eventType: "auto_qa_failed",
    detail: { versionId: run.baseVersionId, errorCode },
  });
  return { settled: settled.length > 0 };
}

/**
 * Settle the project of a step that stopped: reveal the automatic chain's
 * hidden base when there is one, else end `generating` with no new version.
 * True only when the project left `generating` here, which is when the
 * operator who started the theme is told (never for a project something
 * else had already moved).
 */
async function settleStoppedProject(
  db: Db,
  run: Pick<ClaimedRun, "id" | "projectId" | "automatic" | "baseVersionId">,
  errorCode: string,
): Promise<boolean> {
  const revealed = await revealAutomaticBase(db, run, errorCode);
  return revealed
    ? revealed.settled
    : settleProjectWithoutVersion(db, run.projectId);
}

type RunInput = {
  existingThemes?: ExistingThemeFingerprint[];
  project: typeof themeStudioProjects.$inferSelect;
  messages: { kind: "brief" | "revision"; body: string }[];
  references: { bytes: Buffer; sha256: string; createdAt: string }[];
  versionNumber: number;
  revision: { baseIntent: ThemeIntent; basePackage: ThemePackageV2 } | null;
};

async function loadRunInput(
  run: ClaimedRun,
  workerId: string,
): Promise<RunInput | { errorCode: string } | null> {
  return withService(async (db) => {
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, run.projectId))
      .limit(1);
    const [message] = await db
      .select({
        createdAt: themeStudioMessages.createdAt,
        referenceAssetIds: themeStudioMessages.referenceAssetIds,
      })
      .from(themeStudioMessages)
      .where(
        and(
          eq(themeStudioMessages.id, run.messageId),
          eq(themeStudioMessages.projectId, run.projectId),
        ),
      )
      .limit(1);
    if (!project || !message) return null;

    let messages: { kind: "brief" | "revision"; body: string }[];
    let citedReferenceIds = message.referenceAssetIds;
    let revision: RunInput["revision"] = null;
    if (run.kind === "revise") {
      // ★ Exactly the messages the run was queued with, in that order. A
      // revision never reads the original brief (its intent already carries
      // it) or a sibling branch's requests.
      const rows = run.contextMessageIds.length
        ? await db
            .select({
              id: themeStudioMessages.id,
              kind: themeStudioMessages.kind,
              body: themeStudioMessages.body,
              referenceAssetIds: themeStudioMessages.referenceAssetIds,
            })
            .from(themeStudioMessages)
            .where(
              and(
                eq(themeStudioMessages.projectId, run.projectId),
                inArray(themeStudioMessages.id, run.contextMessageIds),
              ),
            )
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = run.contextMessageIds.map((id) => byId.get(id));
      if (ordered.length === 0 || ordered.some((m) => !m)) return null;
      messages = ordered.map((m) => ({
        kind: m!.kind as "brief" | "revision",
        body: m!.body,
      }));
      // Each reply snapshots its own selected attachments. In particular,
      // screenshots added while answering a question must reach this run.
      citedReferenceIds = ordered.at(-1)!.referenceAssetIds;

      if (!run.baseVersionId || !run.basePackageDigest) return null;
      const [base] = await db
        .select({
          intentJson: themeStudioVersions.intentJson,
          packageJson: themeStudioVersions.packageJson,
          packageDigest: themeStudioVersions.packageDigest,
        })
        .from(themeStudioVersions)
        .where(
          and(
            eq(themeStudioVersions.id, run.baseVersionId),
            eq(themeStudioVersions.projectId, run.projectId),
          ),
        )
        .limit(1);
      if (!base || !base.packageJson) return { errorCode: "base_missing" };
      // ★ The content address is recomputed, not only compared as stored: a
      // run revises exactly the package the operator was shown.
      if (
        base.packageDigest !== run.basePackageDigest ||
        digestThemeStudioJson(base.packageJson) !== run.basePackageDigest
      ) {
        return { errorCode: "base_changed" };
      }
      const intent = validateThemeIntent(base.intentJson);
      const pkg = validateThemePackageV2(base.packageJson);
      if (!intent.ok || !pkg.ok) return { errorCode: "base_invalid" };
      revision = { baseIntent: intent.value, basePackage: pkg.value };
    } else {
      // Every message up to and including the run's own: the brief plus any
      // answers to earlier clarifying questions, in order.
      messages = (await db
        .select({
          kind: themeStudioMessages.kind,
          body: themeStudioMessages.body,
        })
        .from(themeStudioMessages)
        .where(
          and(
            eq(themeStudioMessages.projectId, run.projectId),
            lte(themeStudioMessages.createdAt, message.createdAt),
          ),
        )
        .orderBy(asc(themeStudioMessages.createdAt))) as {
        kind: "brief" | "revision";
        body: string;
      }[];
    }
    const references =
      citedReferenceIds.length > 0
        ? await db
            .select({
              id: themeStudioAssets.id,
              bytes: themeStudioAssets.bytes,
              sha256: themeStudioAssets.sha256,
              createdAt: themeStudioAssets.createdAt,
            })
            .from(themeStudioAssets)
            .where(
              and(
                eq(themeStudioAssets.projectId, run.projectId),
                eq(themeStudioAssets.purpose, "reference"),
                inArray(themeStudioAssets.id, citedReferenceIds),
              ),
            )
            .orderBy(asc(themeStudioAssets.createdAt))
        : [];
    const [{ latest }] = await db
      .select({ latest: max(themeStudioVersions.versionNumber) })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.projectId, run.projectId));
    return {
      project,
      messages,
      ...(themePromptFeatures(run.promptVersion).variety
        ? {
            existingThemes: await loadVarietyContext(
              db,
              run.id,
              run.projectId,
              project.themeId,
              workerId,
            ),
          }
        : {}),
      references: references.sort(
        (a, b) =>
          citedReferenceIds.indexOf(a.id) - citedReferenceIds.indexOf(b.id),
      ),
      versionNumber: (latest ?? 0) + 1,
      revision,
    };
  });
}

/**
 * What a recreate starts from: the brief the project was first generated from
 * (and any answers it needed before the first version existed), with that
 * brief's own screenshots. Revision requests in between are deliberately left
 * out — they described changes to a design the operator is discarding.
 */
async function loadRecreateContext(projectId: string): Promise<{
  messages: { kind: "brief" | "revision"; body: string }[];
  references: { base64: string; sha256: string }[];
}> {
  return withService(async (db) => {
    const rows = await db.execute<{
      kind: string;
      body: string;
      referenceAssetIds: string[];
    }>(sql`
      SELECT m.kind, m.body, m.reference_asset_ids AS "referenceAssetIds"
      FROM theme_studio_messages m
      WHERE m.project_id = ${projectId}::uuid
        AND m.kind IN ('brief', 'revision')
        AND m.created_at <= coalesce(
          (SELECT min(v.created_at) FROM theme_studio_versions v
            WHERE v.project_id = ${projectId}::uuid),
          now())
        AND NOT EXISTS (
          SELECT 1 FROM theme_studio_runs r
          WHERE r.message_id = m.id AND r.automatic)
      ORDER BY m.created_at ASC
      LIMIT 6`);
    const messages = rows.rows;
    const firstBrief = messages.findIndex((m) => m.kind === "brief");
    const kept = firstBrief >= 0 ? messages.slice(firstBrief) : messages;
    const referenceIds = kept[0]?.referenceAssetIds ?? [];
    const references = referenceIds.length
      ? await db
          .select({
            id: themeStudioAssets.id,
            bytes: themeStudioAssets.bytes,
            sha256: themeStudioAssets.sha256,
          })
          .from(themeStudioAssets)
          .where(
            and(
              eq(themeStudioAssets.projectId, projectId),
              eq(themeStudioAssets.purpose, "reference"),
              inArray(themeStudioAssets.id, referenceIds),
            ),
          )
      : [];
    return {
      messages: kept.map((m, index) => ({
        kind: index === 0 ? ("brief" as const) : ("revision" as const),
        body: m.body,
      })),
      references: references
        .sort((a, b) => referenceIds.indexOf(a.id) - referenceIds.indexOf(b.id))
        .map((r) => ({ base64: r.bytes.toString("base64"), sha256: r.sha256 })),
    };
  });
}

type Outcome =
  | { kind: "generated"; result: GenerationOutcome; versionNumber: number }
  | {
      kind: "images";
      result: ThemeImageRunResult;
      distinctnessReport?: DistinctnessReport | null;
      intent: ThemeIntent;
      package: ThemePackageV2;
      versionNumber: number;
      /** A redraw's reused art-direction image, recorded like a new one. */
      reusedAnchorAssetId: string | null;
    }
  | { kind: "failed"; errorCode: string; detail?: Record<string, unknown> }
  | {
      kind: "retry";
      errorCode: string;
      /** A photo run cut by its request's deadline: it continues in the next
       * request without spending a crash attempt (PHOTO_RUN_CONTINUATIONS). */
      continuation?: true;
    };

/** The run's own deadline, inside its lease so a finish always holds it. */
const RUN_DEADLINE_MS = (THEME_STUDIO_LIMITS.runWallTimeSeconds - 60) * 1000;
const CANCEL_POLL_MS = 10_000;

function clientFor(
  provider: string,
  input: RunInput,
): ThemeStudioModelClient | null {
  if (provider === "fake") {
    return createFakeModelClient({
      name: input.project.name,
      brief: input.messages.map((m) => m.body).join("\n\n"),
      industries: input.project.industries as ThemeIndustry[],
      catalogSizes: input.project.catalogSizes as ThemeCatalogSize[],
      requiredFeatures: input.project.requiredFeatures as ThemeFeature[],
      referenceCount: input.references.length,
      answered: input.revision
        ? input.messages.length > 1
        : input.messages.some((m) => m.kind === "revision"),
    });
  }
  if (provider === "vertex-gemini") {
    const vertex = getVertexConfig();
    return vertex
      ? createVertexModelClient(vertex, {
          // Its own lane: THEME_STUDIO_TEXT_CAPACITY_SCOPE.
          capacity: (model) =>
            sharedProviderCapacity(vertex.projectId, vertex.region, model, {
              scope: THEME_STUDIO_TEXT_CAPACITY_SCOPE,
            }),
        })
      : null;
  }
  return null;
}

async function cancelRequested(runId: string): Promise<boolean> {
  const [row] = await withService((db) =>
    db
      .select({ at: themeStudioRuns.cancelRequestedAt })
      .from(themeStudioRuns)
      .where(eq(themeStudioRuns.id, runId))
      .limit(1),
  );
  return Boolean(row?.at);
}

// ── Image runs (Track 3.2) ────────────────────────────────────────────────

type ImageRunInput = {
  distinctnessReport: DistinctnessReport | null;
  corrections: Record<string, string>;
  intent: ThemeIntent;
  package: ThemePackageV2;
  versionNumber: number;
};

/** The version an image run fills, re-verified exactly as a revision's is. */
async function loadImageRunInput(
  run: ClaimedRun,
): Promise<ImageRunInput | { errorCode: string }> {
  return withService(async (db) => {
    if (!run.baseVersionId || !run.basePackageDigest) {
      return { errorCode: "base_missing" };
    }
    const [base] = await db
      .select({
        distinctnessReport: themeStudioVersions.distinctnessReport,
        correctionBody: sql<
          string | null
        >`(SELECT m.body FROM theme_studio_messages m WHERE m.id=${run.messageId}::uuid AND m.project_id=${run.projectId}::uuid AND EXISTS (SELECT 1 FROM theme_studio_runs r WHERE r.message_id=m.id AND r.automatic))`,
        intentJson: themeStudioVersions.intentJson,
        packageJson: themeStudioVersions.packageJson,
        packageDigest: themeStudioVersions.packageDigest,
      })
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, run.baseVersionId),
          eq(themeStudioVersions.projectId, run.projectId),
        ),
      )
      .limit(1);
    if (!base || !base.packageJson) return { errorCode: "base_missing" };
    // ★ Recomputed, not only compared as stored: the run draws images for
    // exactly the package the operator was shown.
    if (
      base.packageDigest !== run.basePackageDigest ||
      digestThemeStudioJson(base.packageJson) !== run.basePackageDigest
    ) {
      return { errorCode: "base_changed" };
    }
    const intent = validateThemeIntent(base.intentJson);
    const pkg = validateThemePackageV2(base.packageJson);
    if (!intent.ok || !pkg.ok) return { errorCode: "base_invalid" };
    const [{ latest }] = await db
      .select({ latest: max(themeStudioVersions.versionNumber) })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.projectId, run.projectId));
    const corrections: Record<string, string> = {};
    if (run.automatic && run.imageSlotIds.length && base.correctionBody) {
      try {
        const parsed = JSON.parse(base.correctionBody)?.qaImageCorrections;
        for (const id of run.imageSlotIds)
          if (typeof parsed?.[id] === "string" && parsed[id].length <= 800)
            corrections[id] = parsed[id];
      } catch {
        /* Older automatic image messages contain plain text. */
      }
    }
    return {
      corrections,
      distinctnessReport: readDistinctnessReport(base.distinctnessReport),
      intent: intent.value,
      package: pkg.value,
      versionNumber: (latest ?? 0) + 1,
    };
  });
}

/**
 * What a redraw reuses (Track 3.5): the art-direction image the version's
 * images were drawn to match, and a product photo to stage products against.
 *
 * ★ The anchor is found by walking up the version's parents to the nearest
 * image run that recorded one: an operator upload or an earlier redraw in
 * between writes a new version but keeps the lineage. None found (images
 * only ever uploaded) means the redraw draws a fresh anchor, like a full run.
 *
 * ★ The set shot is the first product slot in package order that is NOT
 * being redrawn and has a real image — generated or uploaded, both show the
 * staging the redrawn products should match.
 */
async function loadImageSeed(
  run: ClaimedRun,
  pkg: ThemePackageV2,
): Promise<{
  seed: {
    anchor: { bytes: Uint8Array; mediaType: "image/webp" };
    set: { bytes: Uint8Array; mediaType: "image/webp" } | null;
  };
  anchorAssetId: string;
} | null> {
  if (!run.baseVersionId) return null;
  return withService(async (db) => {
    const anchors = await db.execute(sql`
      WITH RECURSIVE chain(id, parent, run_id, depth) AS (
        SELECT v.id, v.parent_version_id, v.run_id, 0
          FROM theme_studio_versions v
         WHERE v.id = ${run.baseVersionId}::uuid AND v.project_id = ${run.projectId}::uuid
        UNION ALL
        SELECT v.id, v.parent_version_id, v.run_id, c.depth + 1
          FROM theme_studio_versions v
          JOIN chain c ON v.id = c.parent
         WHERE c.depth < 50 AND v.project_id = ${run.projectId}::uuid
      )
      SELECT a.id AS "id", a.bytes AS "bytes",
        ARRAY(
          SELECT DISTINCT asset ->> 'sha256'
            FROM chain history
            JOIN theme_studio_versions v ON v.id = history.id
            JOIN theme_studio_runs image_run ON image_run.id = history.run_id
             AND image_run.project_id = ${run.projectId}::uuid AND image_run.kind = 'images'
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(image_run.outcome_detail -> 'outcomes', '[]'::jsonb)) outcome
            CROSS JOIN LATERAL jsonb_array_elements(v.package_json -> 'assets') asset
           WHERE outcome ->> 'status' = 'generated'
             AND outcome ->> 'review' = 'passed'
             AND asset ->> 'id' = outcome ->> 'slotId'
             AND asset ->> 'kind' = 'product'
        ) AS "passedProducts"
        FROM chain c
        JOIN theme_studio_runs r ON r.id = c.run_id AND r.kind = 'images'
        JOIN theme_studio_assets a
          ON a.project_id = ${run.projectId}::uuid
         AND a.purpose = 'anchor'
         AND a.media_type = 'image/webp'
         AND a.id::text = r.outcome_detail ->> 'anchorAssetId'
       ORDER BY c.depth
       LIMIT 1
    `);
    const anchor = anchors.rows[0] as
      | { id: string; bytes: Buffer; passedProducts: string[] }
      | undefined;
    if (!anchor) return null;

    const sha = productSetReferenceSha(
      pkg,
      run.imageSlotIds,
      anchor.passedProducts,
    );
    let set: { bytes: Uint8Array; mediaType: "image/webp" } | null = null;
    if (sha) {
      const [row] = await db
        .select({ bytes: themeStudioAssets.bytes })
        .from(themeStudioAssets)
        .where(
          and(
            eq(themeStudioAssets.projectId, run.projectId),
            eq(themeStudioAssets.sha256, sha),
            eq(themeStudioAssets.purpose, "image"),
            eq(themeStudioAssets.mediaType, "image/webp"),
          ),
        )
        .limit(1);
      if (row)
        set = { bytes: new Uint8Array(row.bytes), mediaType: "image/webp" };
    }
    return {
      seed: {
        anchor: {
          bytes: new Uint8Array(anchor.bytes),
          mediaType: "image/webp",
        },
        set,
      },
      anchorAssetId: anchor.id,
    };
  });
}

/**
 * The operator's ElevenLabs choice for one run's photos, or null for Google
 * (the default, a failed read, or an environment with no key).
 */
async function chosenElevenLabs(
  scope: string,
): Promise<Omit<ElevenLabsThemeClientOptions, "deps"> | null> {
  const settings = await resolveImageProvider();
  const apiKey = elevenLabsApiKey();
  if (settings.provider !== "elevenlabs" || !apiKey) return null;
  return {
    apiKey,
    quality: settings.elevenlabsQuality,
    resolution: settings.elevenlabsResolution,
    scope,
  };
}

/**
 * The image client for a photo run. ★★ Owner, 25 Oct 2026: Nano Banana 2.1
 * (image-models.ts) draws every Theme Studio photo at "2K" and the
 * homepage's hero slides at "4K" (themeStudioImageSize), thinking HIGH:
 * these photos set the look of every store that installs the theme. The
 * owner's rollback to Pro (THEME_STUDIO_IMAGE_MODEL) is sent the same sizes
 * and no thinking level (image-models.ts imageRequestConfig).
 * ★ `homepageSlides` names the slots of the photos the homepage opens with
 * (image-models.ts homepageOpeningPhotoIds, from the run's package): only
 * those may be drawn at "4K", never a wide hero that opens another page.
 */
export function imageClientFor(
  provider: string,
  homepageSlides: ReadonlySet<string> = new Set(),
  /**
   * Set when a platform operator has chosen ElevenLabs for photos and this
   * environment holds its key (`chosenElevenLabs`, 22 Nov 2026): the run's
   * photos are then drawn by GPT Image 2.5 Sunburst, with no Google start
   * pacing. ★ The run's own `provider` stays "vertex-gemini": it still names
   * the text and review models, which do not change.
   */
  elevenLabs: Omit<ElevenLabsThemeClientOptions, "deps"> | null = null,
): ThemeStudioImageClient | null {
  if (provider === "fake") return createFakeImageClient();
  if (provider === "vertex-gemini" && elevenLabs) {
    return createElevenLabsImageClient(elevenLabs);
  }
  if (provider === "vertex-gemini") {
    const config = getThemeStudioImageConfig();
    return config
      ? createVertexImageClient(config, {
          imageSize: (request) => themeStudioImageSize(request, homepageSlides),
          thinkingLevel: ThinkingLevel.HIGH,
          capacity: sharedProviderCapacity(
            config.projectId,
            config.location,
            config.providerModel,
          ),
        })
      : null;
  }
  return null;
}

/**
 * ★★ THEME STUDIO'S OWN CLOCK FOR ONE TRY OF A PHOTO CHECK (TS-3D, plan H1),
 * longer than the redesigns' 75 s (gemini-vertex.ts,
 * IMAGE_REVIEW_TRY_TIMEOUT_MS). Set from the 103 checks of the 4 Oct
 * production benchmark (evals/theme-studio/full-live-2026-10-04.json): median
 * 9.07 s, and the 102 that answered all took 111 s or less (79.5, 83.1, 83.1,
 * 86.4 and 110.9 s were the five over 75 s; the one unanswered hit the old
 * 180 s clock). Those times count from the first ask, the permit and 429
 * waits included, where a try's clock starts when it is admitted, so 120 s
 * lets every answered check of that day finish on its first try, with room.
 * ★ A try that hangs holds its permit up to 120 s before the check goes on
 *   from the US to global, so one check takes at most two clocks: 240 s, inside
 *   the five-minute clock of the photo check before a final capture
 *   (image-recovery.ts, PHOTO_RECHECK_CALL_MS).
 */
export const THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS = 120_000;

/**
 * The vision reviewer for an image run (Track 3.4): the fast Studio text
 * model. Null when the provider has no reviewer or an operator has switched
 * that model off — the run then keeps its images, marked unreviewed, rather
 * than failing: the review is a quality check, not the safety boundary.
 * ★★ TS-3D: each check goes to Google's US endpoint first and to global when
 *   the US refuses or times out (gemini-vertex.ts, `capacityAt`), each try
 *   on its location's shared row, with Theme Studio's own longer clock.
 */
function imageReviewerFor(provider: string): ThemeImageReviewer | null {
  if (provider === "fake") {
    return { client: createFakeImageReviewClient(), providerModel: "fake" };
  }
  if (provider !== "vertex-gemini") return null;
  if (getThemeStudioConfig().disabledModels.has(THEME_IMAGE_REVIEW_MODEL_KEY)) {
    return null;
  }
  const vertex = getVertexConfig();
  if (!vertex) return null;
  return {
    client: createVertexModelClient(vertex, {
      capacityAt: (model, location) =>
        sharedProviderCapacity(vertex.projectId, location, model),
      imageReviewTryTimeoutMs: THEME_STUDIO_IMAGE_REVIEW_TRY_TIMEOUT_MS,
    }),
    providerModel: resolveThemeStudioModel(THEME_IMAGE_REVIEW_MODEL_KEY)
      .providerModel,
  };
}

/**
 * The same photo check an image run uses (imageReviewerFor, unchanged), for
 * the check of a photo still unchecked before a final capture
 * (image-recovery.ts `checkUncheckedPhotos`, which loads it lazily so the two
 * modules do not import each other). A photo is re-checked with the reviewer
 * of the provider that drew it.
 */
export function themeImageReviewerFor(
  provider: string,
): ThemeImageReviewer | null {
  return imageReviewerFor(provider);
}

async function executeImages(
  run: ClaimedRun,
  workerId: string,
  leaseSignal: AbortSignal,
  deadlineAt?: number,
): Promise<Outcome> {
  if (!getThemeStudioConfig().generationEnabled) {
    return { kind: "failed", errorCode: "generation_disabled" };
  }
  const input = await loadImageRunInput(run);
  if ("errorCode" in input) {
    return { kind: "failed", errorCode: input.errorCode };
  }
  const only = run.imageSlotIds.length > 0 ? run.imageSlotIds : undefined;
  if (generatableSlots(input.package, input.intent, only).length === 0) {
    return { kind: "failed", errorCode: "images_nothing_to_draw" };
  }
  // ★ Only the photos the homepage opens with are drawn at 4K.
  // ★ The ElevenLabs job record's scope is the PROJECT, not the run: a Retry
  //   is a new run, and it must collect a job its earlier run paid for and
  //   never received, not draw that picture again (elevenlabs-generations.ts).
  const client = imageClientFor(
    run.provider,
    homepageOpeningPhotoIds(input.package),
    run.provider === "vertex-gemini"
      ? await chosenElevenLabs(`theme-project:${run.projectId}`)
      : null,
  );
  if (!client) return { kind: "failed", errorCode: "provider_unavailable" };
  // The model that really draws: a saved draw is only ever replayed for the
  // provider and model that made it (image-recovery.ts).
  const drawModel =
    client.provider === "elevenlabs"
      ? ELEVENLABS_IMAGE_MODEL
      : run.providerModel;
  // Filling new slots beside finished artwork must keep the original style.
  // A wholly new art set may establish a fresh anchor.
  const hasFinishedArt = describeSlots(input.package).some(
    (slot) =>
      !slot.placeholder &&
      ["hero", "product", "category", "content"].includes(slot.kind),
  );
  const reuse =
    only || hasFinishedArt ? await loadImageSeed(run, input.package) : null;
  // Read before drawing: whether a cut by this request's deadline may still
  // continue in the next request (PHOTO_RUN_CONTINUATIONS).
  const continuations = await withService((db) =>
    countRunWaits(db, run, "deadline"),
  );

  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, leaseSignal]);
  let timedOut = false;
  const deadline = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.min(
      RUN_DEADLINE_MS,
      deadlineAt
        ? Math.max(1, deadlineAt - Date.now() - 15_000)
        : RUN_DEADLINE_MS,
    ),
  );
  const poll = setInterval(() => {
    void cancelRequested(run.id)
      .then((yes) => {
        if (yes) controller.abort();
      })
      .catch(() => {});
  }, CANCEL_POLL_MS);
  try {
    // An abort stops drawing new images but keeps those already drawn: a
    // timeout's images are paid for and good, and a cancel is settled by
    // finish(), which sees cancel_requested_at and writes no version.
    const store = createImageCheckpointStore({
      id: run.id,
      projectId: run.projectId,
      workerId,
    });
    const result = await runThemeImageGeneration(
      resumableImageClient(client, drawModel, run.promptVersion, store),
      {
        pkg: input.package,
        intent: input.intent,
        reviewer: imageReviewerFor(run.provider),
        ...(only ? { only } : {}),
        seed: reuse?.seed ?? null,
      },
      signal,
      {
        review: resumableImageReview(store, run.imageReviewDeferrals),
        // ★★ THE LAST PASS KEEPS A PHOTO WHOSE CHECK IS STILL UNAVAILABLE
        //   AS UNCHECKED, INSTEAD OF FAILING THE WHOLE RUN (optimisation 3).
        //   A check that cannot answer pauses the run twice (60 s, 120 s,
        //   IMAGE_REVIEW_DEFERRALS); the third pass tries each check once
        //   more and keeps the photos it still could not check, marked
        //   unchecked, where `image_review_unavailable` used to throw away a
        //   photo run already drawn and paid for. An unchecked photo stays
        //   serious until its own check passes on its bytes, which runs
        //   before the final capture (image-recovery.ts checkUncheckedPhotos).
        deferUnavailableReviews:
          run.imageReviewDeferrals < IMAGE_REVIEW_DEFERRALS,
        corrections: input.corrections,
      },
    );
    // A cut by the request's deadline is not the end of the photo run: it
    // goes back to the queue and the next request carries on from its saved
    // drawings and checks (PHOTO_RUN_CONTINUATIONS). What came back here is
    // not settled, so no slot it did not finish is lost to a fill round and
    // a style photo it was drawing is not a failed run.
    if (timedOut && continuations < PHOTO_RUN_CONTINUATIONS) {
      return { kind: "retry", errorCode: "run_timeout", continuation: true };
    }
    return {
      kind: "images",
      distinctnessReport: input.distinctnessReport,
      result,
      intent: input.intent,
      package: input.package,
      versionNumber: input.versionNumber,
      reusedAnchorAssetId: reuse?.anchorAssetId ?? null,
    };
  } finally {
    clearTimeout(deadline);
    clearInterval(poll);
  }
}

async function execute(
  run: ClaimedRun,
  workerId: string,
  leaseSignal: AbortSignal,
  deadlineAt?: number,
): Promise<Outcome> {
  if (run.kind === "images")
    return executeImages(run, workerId, leaseSignal, deadlineAt);
  const config = getThemeStudioConfig();
  // Re-checked at execution, not only at queue time: the emergency stop and a
  // disabled model must also stop work that was already waiting.
  if (!config.generationEnabled) {
    return { kind: "failed", errorCode: "generation_disabled" };
  }
  if (config.disabledModels.has(run.modelKey as ThemeStudioModelKey)) {
    return { kind: "failed", errorCode: "model_disabled" };
  }
  const input = await loadRunInput(run, workerId);
  if (!input) return { kind: "failed", errorCode: "input_missing" };
  if ("errorCode" in input)
    return { kind: "failed", errorCode: input.errorCode };
  const client = clientFor(run.provider, input);
  if (!client) return { kind: "failed", errorCode: "provider_unavailable" };

  const modelKey = input.project.modelKey as ThemeStudioModelKey;
  const baseEngine =
    input.project.baseThemeId && isBundledThemeId(input.project.baseThemeId)
      ? getThemeDefinition(input.project.baseThemeId).engine
      : null;
  const baseThemeName =
    input.project.baseThemeId && isBundledThemeId(input.project.baseThemeId)
      ? getThemeDefinition(input.project.baseThemeId).name
      : null;

  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, leaseSignal]);
  let timedOut = false;
  const deadline = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.min(
      RUN_DEADLINE_MS,
      deadlineAt
        ? Math.max(1, deadlineAt - Date.now() - 15_000)
        : RUN_DEADLINE_MS,
    ),
  );
  // An operator's Cancel stops the provider call mid-flight rather than paying
  // for the rest of a run that will be thrown away.
  const poll = setInterval(() => {
    void cancelRequested(run.id)
      .then((yes) => {
        if (yes) controller.abort();
      })
      .catch(() => {});
  }, CANCEL_POLL_MS);
  try {
    const result = await runThemeGeneration(
      run.provider === "vertex-gemini"
        ? resumableGenerationClient(client, {
            read: (digest) =>
              withService(async (db) => {
                const [saved] = await db
                  .select({
                    response: themeStudioGenerationResponses.responseJson,
                  })
                  .from(themeStudioGenerationResponses)
                  .where(
                    and(
                      eq(themeStudioGenerationResponses.runId, run.id),
                      eq(themeStudioGenerationResponses.requestDigest, digest),
                    ),
                  )
                  .limit(1);
                return (
                  (saved?.response as SavedModelResponse | undefined) ?? null
                );
              }),
            write: (digest, response) =>
              withService(async (db) => {
                // Fence the checkpoint with the same lease as the final version.
                // Locking only for this short write never holds up a model call.
                const [lease] = await db
                  .select({ id: themeStudioRuns.id })
                  .from(themeStudioRuns)
                  .where(
                    and(
                      eq(themeStudioRuns.id, run.id),
                      eq(themeStudioRuns.status, "running"),
                      eq(themeStudioRuns.leaseOwner, workerId),
                    ),
                  )
                  .for("update")
                  .limit(1);
                if (!lease) throw new Error("Theme generation lost its lease.");
                await db
                  .insert(themeStudioGenerationResponses)
                  .values({
                    runId: run.id,
                    requestDigest: digest,
                    responseJson: response,
                  })
                  .onConflictDoNothing();
              }),
          })
        : client,
      {
        facts: {
          name: input.project.name,
          themeId: input.project.themeId,
          industries: input.project.industries as ThemeIndustry[],
          catalogSizes: input.project.catalogSizes,
          requiredFeatures: input.project.requiredFeatures,
          baseThemeName,
        },
        compile: {
          themeId: input.project.themeId,
          name: input.project.name,
          industries: input.project.industries as ThemeIndustry[],
          catalogSizes: input.project.catalogSizes as ThemeCatalogSize[],
          requiredFeatures: input.project.requiredFeatures as ThemeFeature[],
          baseEngine,
          versionNumber: input.versionNumber,
          modelKey,
          modelLabel:
            THEME_STUDIO_MODELS.find((m) => m.key === modelKey)?.label ??
            modelKey,
          referenceDigests: input.references.map((r) => r.sha256),
        },
        providerModel: run.providerModel,
        promptVersion: run.promptVersion,
        messages: input.messages,
        existingThemes: input.existingThemes,
        // The offline drill rebuilds a bundled theme: see GenerationInput.
        ...(run.provider === "fake" ? { skipCatalogueFloor: true } : {}),
        references: input.references.map((r) => ({
          base64: r.bytes.toString("base64"),
          sha256: r.sha256,
        })),
        ...(input.revision ? { revision: input.revision } : {}),
        // Old queued runs must retain their original request sequence so paid
        // Stage A checkpoints remain replayable and included in their usage.
        automaticRepair:
          run.automatic &&
          run.kind === "revise" &&
          themePromptFeatures(run.promptVersion).targetedRepair,
        // An operator's revision is scoped first (edit / revise / recreate).
        // The original brief is read only if the decision is to recreate.
        ...(!run.automatic &&
        run.kind === "revise" &&
        themePromptFeatures(run.promptVersion).changeScope
          ? {
              operatorChange: {
                recreateContext: () => loadRecreateContext(run.projectId),
              },
            }
          : {}),
      },
      signal,
    );
    if (signal.aborted) {
      return timedOut
        ? { kind: "retry", errorCode: "run_timeout" }
        : { kind: "generated", result, versionNumber: input.versionNumber };
    }
    return { kind: "generated", result, versionNumber: input.versionNumber };
  } catch (error) {
    if (signal.aborted) {
      // A cancel is settled by finish(), which sees cancel_requested_at.
      return timedOut
        ? { kind: "retry", errorCode: "run_timeout" }
        : { kind: "failed", errorCode: "cancelled" };
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    clearInterval(poll);
  }
}

type RunRow = typeof themeStudioRuns.$inferSelect;

function usageRecord(run: ClaimedRun, outcome: Outcome) {
  const telemetry =
    outcome.kind === "generated" || outcome.kind === "images"
      ? outcome.result.telemetry
      : undefined;
  return {
    provider: run.provider,
    // An image run records the image model it actually called; the run row's
    // model_key column keeps the project's text model.
    modelKey:
      run.kind === "images" ? THEME_STUDIO_IMAGE_MODEL_KEY : run.modelKey,
    providerModel: run.providerModel,
    promptVersion: run.promptVersion,
    ...(telemetry ?? {}),
  };
}

async function finish(
  workerId: string,
  run: ClaimedRun,
  outcome: Outcome,
): Promise<Settlement> {
  return withService(async (db): Promise<Settlement> => {
    const rows = await db
      .select()
      .from(themeStudioRuns)
      .where(
        and(
          eq(themeStudioRuns.id, run.id),
          eq(themeStudioRuns.status, "running"),
          eq(themeStudioRuns.leaseOwner, workerId),
          gt(themeStudioRuns.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .for("update")
      .limit(1);
    if (!rows[0]) return { settled: "lost" }; // lease expired and another worker took it
    const locked: RunRow = rows[0];
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, run.projectId))
      .for("update")
      .limit(1);

    const usage = {
      // A cancelled/timed-out replay can stop before it reconstructs telemetry.
      // Keep spend already recorded by an earlier capacity wait in that case.
      ...(outcome.kind !== "generated" && outcome.kind !== "images"
        ? (locked.usage as Record<string, unknown>)
        : {}),
      ...usageRecord(run, outcome),
      // Checkpoints own image spend, including calls from earlier claims.
      ...(run.kind === "images"
        ? (locked.usage as Record<string, unknown>)
        : {}),
    };
    const terminal = {
      leaseOwner: null,
      leaseExpiresAt: null,
      retryNotBefore: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
      usage,
    };
    const event = (eventType: string, detail: Record<string, unknown> = {}) =>
      recordThemeStudioEvent(db, {
        projectId: run.projectId,
        runId: run.id,
        actor: "worker",
        eventType,
        detail,
      });
    // ★ A failure that stops the theme (its project leaves `generating`)
    //   tells the operator who started it, once this transaction commits.
    const failRun = async (
      errorCode: string,
      outcomeDetail: Record<string, unknown> = {},
    ): Promise<Settlement> => {
      await db
        .update(themeStudioRuns)
        .set({ ...terminal, status: "failed", errorCode, outcomeDetail })
        .where(eq(themeStudioRuns.id, run.id));
      const stopped =
        project !== undefined &&
        (await settleStoppedProject(db, run, errorCode));
      await event("run_failed", { errorCode });
      return {
        settled: "failed",
        errorCode,
        ...(stopped ? { notice: "needs_fix" as const } : {}),
      };
    };

    if (locked.cancelRequestedAt) {
      // Spend already incurred is still recorded, so the cap counts it.
      await db
        .update(themeStudioRuns)
        .set({ ...terminal, status: "cancelled" })
        .where(eq(themeStudioRuns.id, run.id));
      if (!(await revealAutomaticBase(db, run, "cancelled"))) {
        await settleProjectWithoutVersion(db, run.projectId);
      }
      await event("run_cancelled");
      return { settled: "cancelled" };
    }

    if (outcome.kind === "retry") {
      if (outcome.continuation) {
        // ★ A photo run cut by its request's deadline goes back as it is,
        //   due at once: a delayed recovery (`retry_not_before`), so its
        //   next claim spends no crash attempt, and its saved drawings and
        //   checks replay there (PHOTO_RUN_CONTINUATIONS, counted from this
        //   event).
        await db
          .update(themeStudioRuns)
          .set({
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            retryNotBefore: sql`now()`,
            usage,
            updatedAt: sql`now()`,
          })
          .where(eq(themeStudioRuns.id, run.id));
        await event("run_queued", { reason: "deadline" });
        return { settled: "requeued", errorCode: outcome.errorCode };
      }
      // A deadline or renewal failure on the final claim must terminate. A
      // queued row at maxAttempts would make its next claim violate the DB
      // attempt constraint and could poison every scheduler invocation.
      if (locked.attemptCount >= locked.maxAttempts)
        return failRun(outcome.errorCode);
      await db
        .update(themeStudioRuns)
        .set({
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          usage,
          updatedAt: sql`now()`,
        })
        .where(eq(themeStudioRuns.id, run.id));
      return { settled: "requeued", errorCode: outcome.errorCode };
    }
    if (!project || project.status !== "generating") {
      return failRun("project_state_changed");
    }
    if (outcome.kind === "failed")
      return failRun(outcome.errorCode, outcome.detail);

    if (outcome.kind === "images") {
      return finishImages(db, {
        run,
        project,
        outcome,
        terminal,
        event,
        failRun,
      });
    }

    const result = outcome.result;
    if (
      result.kind === "failed" &&
      result.errorCode === "rate_limited" &&
      run.provider === "vertex-gemini"
    ) {
      const delay = generationRecoveryDelayMs(locked.rateLimitDeferrals);
      if (delay !== null) {
        const retryNotBefore = new Date(Date.now() + delay).toISOString();
        await db
          .update(themeStudioRuns)
          .set({
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            retryNotBefore,
            rateLimitDeferrals: locked.rateLimitDeferrals + 1,
            usage,
            outcomeDetail: {
              kind: "rate_limit_wait",
              stage: result.detail.stage,
            },
            updatedAt: sql`now()`,
          })
          .where(eq(themeStudioRuns.id, run.id));
        await event("run_queued", {
          reason: "rate_limited",
          retryNotBefore,
          recovery: locked.rateLimitDeferrals + 1,
        });
        return { settled: "requeued", errorCode: "rate_limited" };
      }
    }
    if (
      result.kind === "failed" &&
      run.provider === "vertex-gemini" &&
      isWaitedProviderFailure(result.errorCode)
    ) {
      // ★ An outage or a timed-out call is waited out like a 429, on a
      //   shorter clock and a smaller budget (generation-recovery.ts
      //   PROVIDER_FAILURE_WAITS): unavailable twice, a timeout once. The
      //   saved answers of the stages that did answer replay on the next
      //   claim, so only the call that failed is sent again.
      const waits = await countRunWaits(db, run, result.errorCode);
      const delay = providerFailureDelayMs(result.errorCode, waits);
      if (delay !== null) {
        const retryNotBefore = new Date(Date.now() + delay).toISOString();
        await db
          .update(themeStudioRuns)
          .set({
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            retryNotBefore,
            usage,
            outcomeDetail: {
              kind: "provider_wait",
              reason: result.errorCode,
              stage: result.detail.stage,
            },
            updatedAt: sql`now()`,
          })
          .where(eq(themeStudioRuns.id, run.id));
        await event("run_queued", {
          reason: result.errorCode,
          retryNotBefore,
          recovery: waits + 1,
        });
        return { settled: "requeued", errorCode: result.errorCode };
      }
    }
    if (result.kind === "failed")
      return failRun(result.errorCode, result.detail);
    if (result.kind === "declined") {
      return failRun("model_declined", {
        kind: "declined",
        reason: result.reason,
      });
    }
    if (result.kind === "clarify") {
      if (run.automatic) return failRun("auto_revision_clarified");
      await db
        .update(themeStudioRuns)
        .set({
          ...terminal,
          status: "succeeded",
          outcomeDetail: { kind: "clarify", questions: result.questions },
        })
        .where(eq(themeStudioRuns.id, run.id));
      await db
        .update(themeStudioProjects)
        .set({ status: "blocked", revision: project.revision + 1 })
        .where(eq(themeStudioProjects.id, run.projectId));
      await event("run_succeeded");
      await event("clarification_requested", {
        questions: result.questions.length,
      });
      // The brief needs the operator's answers before anything is designed.
      return { settled: "succeeded", notice: "questions" };
    }

    // A version. Its number was fixed before the provider call because the
    // package's release version embeds it; one active run per project makes a
    // mismatch impossible in practice, and if it happens the run fails rather
    // than writing a package that disagrees with its own row.
    const [{ latest }] = await db
      .select({ latest: max(themeStudioVersions.versionNumber) })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.projectId, run.projectId));
    if ((latest ?? 0) + 1 !== outcome.versionNumber) {
      return failRun("project_state_changed");
    }
    for (const image of result.placeholders.values()) {
      await db
        .insert(themeStudioAssets)
        .values({
          projectId: run.projectId,
          purpose: "placeholder",
          mediaType: "image/webp",
          bytes: image.bytes,
          byteSize: image.bytes.byteLength,
          width: image.width,
          height: image.height,
          sha256: image.sha256,
          originalMediaType: "image/webp",
          originalByteSize: image.bytes.byteLength,
        })
        .onConflictDoNothing({
          target: [themeStudioAssets.projectId, themeStudioAssets.sha256],
        });
    }
    const intentDigest = digestThemeStudioJson(result.intent);
    const packageDigest = digestThemeStudioJson(result.package);
    const automaticQa = run.automatic || getThemeStudioConfig().autoQaEnabled;
    const automaticSlots = automaticQa
      ? generatableSlots(result.package, result.intent).length
      : 0;
    if (run.automatic && !getThemeStudioConfig().autoQaEnabled) {
      return failRun("auto_qa_disabled");
    }
    const editRedraws = Object.keys(result.imageRedraws ?? {});
    if (
      (automaticSlots > 0 || (automaticQa && editRedraws.length > 0)) &&
      !automaticImageProvider(run)
    ) {
      return failRun("image_provider_unavailable");
    }
    const [version] = await db
      .insert(themeStudioVersions)
      .values({
        projectId: run.projectId,
        runId: run.id,
        // A revision's parent is the version it revised — which is how a
        // revision of an older version becomes a branch.
        parentVersionId: run.baseVersionId ?? project.currentVersionId,
        versionNumber: outcome.versionNumber,
        intentJson: result.intent,
        intentDigest,
        packageJson: result.package,
        distinctnessReport: result.distinctness ?? null,
        packageDigest,
        ...(automaticQa
          ? {
              visibility: "internal",
              qaStatus: "pending",
              qaIteration: run.qaIteration,
            }
          : {}),
      })
      .returning({
        id: themeStudioVersions.id,
        versionNumber: themeStudioVersions.versionNumber,
      });
    await db
      .update(themeStudioRuns)
      .set({
        ...terminal,
        status: "succeeded",
        ...(result.change
          ? {
              outcomeDetail: {
                kind: "change",
                ...result.change,
                // Without automatic QA there is no image lane to hand the
                // redraws to; the operator draws them from Images instead.
                ...(!automaticQa && editRedraws.length
                  ? { redrawsDeferred: true }
                  : {}),
              },
            }
          : {}),
      })
      .where(eq(themeStudioRuns.id, run.id));
    await db
      .update(themeStudioProjects)
      .set({
        status: automaticQa ? "generating" : "ready",
        ...(automaticQa ? {} : { currentVersionId: version.id }),
        revision: project.revision + 1,
      })
      .where(eq(themeStudioProjects.id, run.projectId));
    await event("run_succeeded");
    await event("version_created", {
      versionId: version.id,
      versionNumber: version.versionNumber,
      intentDigest,
      packageDigest,
      placeholders: result.placeholders.size,
      parentVersionId: run.baseVersionId ?? project.currentVersionId,
      automaticQa,
      qaIteration: run.qaIteration,
      // The event vocabulary is constrained in the database, so an operator
      // revision's scope rides on the version it produced.
      ...(result.change
        ? {
            changeScope: result.change.scope,
            changedSettings: result.change.changed.length,
            redraws: result.change.redraws.length,
            ...(result.change.fellBackFrom
              ? { fellBackFrom: result.change.fellBackFrom }
              : {}),
          }
        : {}),
    });
    if (automaticQa) {
      await event("auto_qa_started", {
        versionId: version.id,
        qaIteration: run.qaIteration,
      });
      const redraws = editRedraws;
      if (redraws.length) {
        // An edit that asked for new pictures draws exactly those slots,
        // matched to the theme's existing art direction, then goes straight to
        // final capture and the full acceptance and visual checks. Nothing
        // else about the version is redrawn.
        const imageRunId = await queueAutomaticImages(
          db,
          run,
          version,
          packageDigest,
          redraws.length,
          redraws,
          Object.fromEntries(
            Object.entries(result.imageRedraws!).map(([slot, direction]) => [
              slot,
              `The operator asked for a different picture here. This direction replaces the subject and art direction above wherever they conflict: ${direction}`,
            ]),
          ),
        );
        if (!imageRunId)
          await queueAutomaticCapture(
            db,
            run,
            version,
            packageDigest,
            "layout",
          );
      } else {
        // Measure the native layout with its planned image ratios before
        // paying for artwork. Passing this stage cannot create acceptance
        // evidence. An edit or a late repair of a theme whose pictures are
        // all there has no artwork to pay for, so it goes straight to the
        // final capture (firstCapturePhase).
        await queueAutomaticCapture(
          db,
          run,
          version,
          packageDigest,
          firstCapturePhase(result.package),
        );
      }
    }
    return { settled: "succeeded" };
  });
}

/**
 * ★ WHICH CAPTURE A NEW VERSION'S CHECKS START WITH (plan optimisation 5).
 * The layout capture exists to measure the layout before photos are paid
 * for. A version that can be captured for real already (no placeholder art,
 * catalogue pictures capturable, captureBlockers(pkg, "final") empty: an
 * operator's edit or a late repair of a finished theme) has none to pay
 * for, so the layout capture would only add about 2.2 minutes: it goes
 * straight to the final capture, which measures everything the layout
 * capture does and more, and pays for no design review unless those
 * measurements pass. A first build always has placeholders: layout first.
 */
export function firstCapturePhase(pkg: ThemePackageV2): "layout" | "final" {
  return captureBlockers(pkg, "final").length === 0 ? "final" : "layout";
}

/**
 * Whether a photo run's result can reach the automatic final check: nothing
 * stands between it and a final capture but the slots a fill round still
 * owes (`owed`). Placeholders the run was never asked to draw (a redraw of
 * two pictures in a theme with others still empty), or catalogue pictures
 * that cannot be captured, leave nothing to check yet. With nothing owed this
 * is exactly "captureBlockers(pkg, 'final') is empty".
 */
export function reachesFinalCheck(
  pkg: ThemePackageV2,
  owed: readonly string[],
): boolean {
  if (captureBlockers(pkg, "layout").length > 0) return false;
  if (captureShots(pkg).length === 0) return false;
  const pending = new Set(owed);
  return describeSlots(pkg).every(
    (slot) =>
      slot.catalogPreview ||
      slot.catalogScreenshot ||
      !slot.placeholder ||
      pending.has(slot.id),
  );
}

/**
 * Settle an image run: store the anchor and each generated image, then write
 * ONE version whose package points at them and whose parent is the version
 * filled. Nothing generated is a failure that keeps the base version current.
 *
 * ★ EVERY CHANGE IS CHECKED (TS-1D). With automatic checks on, an operator's
 * own photo run ("Generate images", a redraw, or a Retry of one) goes
 * through the same automatic final check as a theme's own photos: its
 * version is HIDDEN, a round that fills what it missed is queued as automatic
 * work (so Stop, a cancel and a failure reveal that version, as for any
 * automatic step), and once complete the version gets one final capture and
 * the design review. All of it at the repair ceiling: checking a photo run
 * the operator chose never buys a paid restyle. No layout check, because only
 * pictures changed. A result that cannot reach the check (a placeholder the
 * run was not asked to draw) becomes current at once, as before.
 */
/** The run's error code when its style photo (the anchor) did not come back. */
function anchorFailureCode(
  failure: NonNullable<ThemeImageRunResult["anchorFailure"]>,
): string {
  return failure.kind === "refused"
    ? "images_anchor_refused"
    : failure.kind === "rejected"
      ? "images_anchor_rejected"
      : `images_anchor_${failure.code}`.slice(0, 64);
}

async function finishImages(
  db: Db,
  ctx: {
    run: ClaimedRun;
    project: typeof themeStudioProjects.$inferSelect;
    outcome: Extract<Outcome, { kind: "images" }>;
    terminal: Record<string, unknown>;
    event: (type: string, detail?: Record<string, unknown>) => Promise<void>;
    failRun: (
      errorCode: string,
      detail?: Record<string, unknown>,
    ) => Promise<Settlement>;
  },
): Promise<Settlement> {
  const { run, project, outcome, terminal, event, failRun } = ctx;
  const result = outcome.result;
  const detail = {
    kind: "images",
    outcomes: result.outcomes,
    ...(result.anchorFailure ? { anchorFailure: result.anchorFailure } : {}),
    ...(result.anchorFailure?.kind === "refused"
      ? { category: result.anchorFailure.reason ?? "IMAGE_SAFETY" }
      : {}),
  };
  const pending = result.outcomes.filter(
    (o) => o.status === "failed" && o.code === "image_review_pending",
  );
  if (
    (result.anchorFailure?.kind === "failed" &&
      result.anchorFailure.code === "image_review_pending") ||
    pending.length
  ) {
    const delay = imageReviewRecoveryDelayMs(run.imageReviewDeferrals);
    if (delay === null) return failRun("image_review_unavailable", detail);
    const retryNotBefore = new Date(Date.now() + delay).toISOString();
    await db
      .update(themeStudioRuns)
      .set({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        retryNotBefore,
        imageReviewDeferrals: run.imageReviewDeferrals + 1,
        usage: terminal.usage,
        outcomeDetail: { ...detail, kind: "image_review_wait" },
        updatedAt: sql`now()`,
      })
      .where(eq(themeStudioRuns.id, run.id));
    await event("run_queued", {
      reason: "image_review_unavailable",
      retryNotBefore,
      recovery: run.imageReviewDeferrals + 1,
    });
    return { settled: "requeued", errorCode: "image_review_unavailable" };
  }
  const missing = result.outcomes
    .filter((o) => o.status !== "generated")
    .map((o) => o.slotId);
  const [self] = await db
    .select({ idempotencyKey: themeStudioRuns.idempotencyKey })
    .from(themeStudioRuns)
    .where(eq(themeStudioRuns.id, run.id))
    .limit(1);
  const position = fillPosition(run.id, self?.idempotencyKey ?? null);
  const nextFill =
    missing.length > 0 && position.round < IMAGE_FILL_ROUNDS
      ? { root: position.root, round: position.round + 1 }
      : null;
  // An operator's photo run joins the automatic final check whenever its
  // result can reach it: from here on its work is automatic, at the repair
  // ceiling. Anything else carries on exactly as `run` says.
  const checkedChain = (
    pkg: ThemePackageV2,
    owed: readonly string[],
  ): ClaimedRun =>
    !run.automatic &&
    getThemeStudioConfig().autoQaEnabled &&
    reachesFinalCheck(pkg, owed)
      ? { ...run, automatic: true, qaIteration: MAX_AUTOMATIC_QA_REPAIRS }
      : run;
  if (result.anchorFailure || result.images.length === 0) {
    // Nothing came back: a rate-limit storm, or ★ a style photo (the anchor
    // every other photo is matched to) that was refused, rejected or did not
    // come back (section 7: 82 of 189 Pro attempts were refused inside runs).
    // Either way nothing was drawn to keep, so the same slots are tried
    // again on the same base while fill rounds remain, and a round with no
    // anchor to reuse draws a fresh style photo; the run itself still
    // records why it stopped. Only the last round fails the theme.
    const errorCode = result.anchorFailure
      ? anchorFailureCode(result.anchorFailure)
      : "images_none";
    if (nextFill && run.baseVersionId && run.basePackageDigest) {
      await db
        .update(themeStudioRuns)
        .set({
          ...terminal,
          status: "failed",
          errorCode,
          outcomeDetail: detail,
        })
        .where(eq(themeStudioRuns.id, run.id));
      await event("run_failed", { errorCode });
      if (
        await queueFillImages(
          db,
          checkedChain(outcome.package, missing),
          { id: run.baseVersionId, packageDigest: run.basePackageDigest },
          missing,
          nextFill,
        )
      ) {
        // The chain goes on: nothing to tell the operator yet, and the
        // run's log line says it continues (alert 16 ignores it).
        return { settled: "failed", errorCode, continues: true };
      }
      const stopped = await settleStoppedProject(db, run, errorCode);
      return {
        settled: "failed",
        errorCode,
        ...(stopped ? { notice: "needs_fix" as const } : {}),
      };
    }
    return failRun(errorCode, detail);
  }
  if (run.automatic && !getThemeStudioConfig().autoQaEnabled) {
    return failRun("auto_qa_disabled", detail);
  }

  const [{ latest }] = await db
    .select({ latest: max(themeStudioVersions.versionNumber) })
    .from(themeStudioVersions)
    .where(eq(themeStudioVersions.projectId, run.projectId));
  if ((latest ?? 0) + 1 !== outcome.versionNumber) {
    return failRun("project_state_changed");
  }
  const applied = applyGeneratedImages(
    outcome.package,
    result.images.map(({ slotId, image }) => ({
      slotId,
      sha256: image.sha256,
      width: image.width,
      height: image.height,
    })),
    outcome.versionNumber,
    THEME_STUDIO_IMAGE_MODEL_KEY,
  );
  if (!applied.ok) return failRun("images_package_invalid", detail);

  const store = async (
    image: ThemeImageRunResult["images"][number]["image"],
    purpose: "image" | "anchor",
  ) => {
    await db
      .insert(themeStudioAssets)
      .values({
        projectId: run.projectId,
        purpose,
        mediaType: "image/webp",
        bytes: Buffer.from(image.bytes),
        byteSize: image.bytes.byteLength,
        width: image.width,
        height: image.height,
        sha256: image.sha256,
        originalMediaType: image.originalMediaType,
        originalByteSize: image.originalByteSize,
      })
      .onConflictDoNothing({
        target: [themeStudioAssets.projectId, themeStudioAssets.sha256],
      });
    const [row] = await db
      .select({ id: themeStudioAssets.id, purpose: themeStudioAssets.purpose })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, run.projectId),
          eq(themeStudioAssets.sha256, image.sha256),
        ),
      )
      .limit(1);
    return row ?? null;
  };
  for (const { image } of result.images) {
    const row = await store(image, "image");
    // The same bytes stored earlier under another purpose would be served and
    // published by the wrong rules; refuse rather than point a slot at it.
    if (!row || row.purpose !== "image") {
      return failRun("images_asset_conflict", detail);
    }
  }
  const anchorRow = result.anchor ? await store(result.anchor, "anchor") : null;

  const intentDigest = digestThemeStudioJson(outcome.intent);
  const packageDigest = digestThemeStudioJson(applied.value);
  // The chain this version belongs to: the run's own, or for an operator's
  // photo run under the automatic checks, the checked chain (see above).
  const chain = checkedChain(applied.value, nextFill ? missing : []);
  const hidden = chain.automatic;
  const [version] = await db
    .insert(themeStudioVersions)
    .values({
      projectId: run.projectId,
      runId: run.id,
      parentVersionId: run.baseVersionId,
      versionNumber: outcome.versionNumber,
      distinctnessReport: outcome.distinctnessReport ?? null,
      intentJson: outcome.intent,
      intentDigest,
      packageJson: applied.value,
      packageDigest,
      ...(hidden
        ? {
            visibility: "internal",
            qaStatus: "pending",
            qaIteration: chain.qaIteration,
          }
        : {}),
    })
    .returning({
      id: themeStudioVersions.id,
      versionNumber: themeStudioVersions.versionNumber,
    });
  await db
    .update(themeStudioRuns)
    .set({
      ...terminal,
      status: "succeeded",
      outcomeDetail: {
        ...detail,
        // A redraw records the anchor it reused, so the next redraw finds it
        // on this run without walking further.
        ...(anchorRow?.purpose === "anchor"
          ? { anchorAssetId: anchorRow.id }
          : outcome.reusedAnchorAssetId
            ? { anchorAssetId: outcome.reusedAnchorAssetId }
            : {}),
      },
    })
    .where(eq(themeStudioRuns.id, run.id));
  // A fill run is queued in this transaction, before the project settles, so
  // a manual chain stays `generating` until every round is done.
  const filling = nextFill
    ? await queueFillImages(
        db,
        chain,
        { id: version.id, packageDigest },
        missing,
        nextFill,
      )
    : false;
  await db
    .update(themeStudioProjects)
    .set({
      status: hidden || filling ? "generating" : "ready",
      ...(hidden ? {} : { currentVersionId: version.id }),
      revision: project.revision + 1,
    })
    .where(eq(themeStudioProjects.id, run.projectId));
  await event("run_succeeded");
  await event("version_created", {
    versionId: version.id,
    versionNumber: version.versionNumber,
    intentDigest,
    packageDigest,
    images: result.images.length,
    imagesMissing: missing.length,
    fillQueued: filling,
    parentVersionId: run.baseVersionId,
    automaticQa: hidden,
    qaIteration: chain.qaIteration,
  });
  if (hidden && !run.automatic) {
    await event("auto_qa_started", {
      versionId: version.id,
      qaIteration: chain.qaIteration,
    });
  }
  if (hidden && !filling) {
    // Every round is spent: capture only a complete version, otherwise reveal
    // the most complete one as a failed QA result (and tell the operator:
    // the theme stopped there).
    if (captureBlockers(applied.value).length > 0) {
      if (await revealIncomplete(db, chain, version.id))
        return { settled: "succeeded", notice: "needs_fix" };
    } else {
      await queueAutomaticCapture(db, chain, version, packageDigest);
    }
  }
  return { settled: "succeeded" };
}

/** Drain a bounded amount of queued work. Safe to call concurrently: claims
 * use SKIP LOCKED and finishes are fenced on the lease owner. */
export async function runThemeStudioWorker(
  options: {
    maxRuns?: number;
    budgetMs?: number;
    /** Which providers this invocation may execute. The shared heartbeat and
     * the after-response kick pass only `fake`, which finishes instantly; a
     * model run can take many minutes and runs only on the dedicated worker
     * route, where it has its own long request. */
    providers?: readonly ThemeStudioProvider[];
    /** The dedicated route gives visual QA its own concurrent lane. */
    skipVisualQa?: boolean;
    /** Absolute HTTP deadline, including input loading and settlement. */
    deadlineAt?: number;
  } = {},
): Promise<ThemeStudioWorkerResult> {
  const maxRuns = options.maxRuns ?? 5;
  const providers = options.providers ?? (["fake", "vertex-gemini"] as const);
  const deadline = Date.now() + (options.budgetMs ?? 40_000);
  const workerId = randomUUID();
  const result: ThemeStudioWorkerResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    requeued: 0,
    reaped: 0,
  };
  const reaped = await withService(reapExhaustedLeases);
  result.reaped = reaped.reaped;
  for (const projectId of reaped.notices)
    await sendNotice(projectId, "needs_fix");

  while (
    result.claimed < maxRuns &&
    Date.now() < deadline &&
    (!options.deadlineAt || Date.now() + 240_000 < options.deadlineAt)
  ) {
    const claimStarted = Date.now();
    const run = await withService((db) =>
      claimRun(
        db,
        workerId,
        providers,
        options.deadlineAt
          ? Math.max(0, options.deadlineAt - Date.now())
          : RUN_DEADLINE_MS,
      ),
    );
    if (!run) break;
    result.claimed += 1;
    const lease = startWorkerLease(
      () =>
        withService((db) =>
          renewStudioLease(db, "generation", run.id, workerId),
        ),
      undefined,
      WORKER_LEASE_SECONDS * 1000 - (Date.now() - claimStarted),
    );
    let outcome: Outcome;
    try {
      outcome = await execute(run, workerId, lease.signal, options.deadlineAt);
    } catch (error) {
      // Losing the lease to a reclaim is expected and already safe: the
      // variety freeze uses finish()'s own fence (running + lease owner), so
      // finish() below finds no row and settles this run as `lost`.
      if (error instanceof VarietyLeaseLostError)
        logWarn("theme studio: run lease lost before start", {
          runId: run.id,
        });
      else
        logError("theme studio: run execution threw", error, {
          runId: run.id,
        });
      outcome =
        run.attemptCount < run.maxAttempts
          ? { kind: "retry", errorCode: "worker_error" }
          : {
              kind: "failed",
              errorCode:
                error instanceof ImageCheckpointError
                  ? "image_checkpoint_unavailable"
                  : "worker_error",
            };
    }
    // A lost/uncertain lease must never publish even a successful paid result.
    if (lease.signal.aborted)
      outcome = { kind: "retry", errorCode: "lease_renewal_failed" };
    let settlement: Settlement;
    try {
      settlement = await finish(workerId, run, outcome);
    } finally {
      await lease.stop();
    }
    const settled = settlement.settled;
    if (settled !== "lost") result[settled] += 1;
    // ★ Content-free, and an alert reads it (plan P6): `outcome` says how the
    //   run ended, `errorCode` the code a failed run was given or why a
    //   requeued one waits (absent when there is none), and `continues` that
    //   a failed photo run's slots are drawn again in a fill round it queued
    //   (the theme is still generating; scripts/prod-monitoring.py alert 16
    //   leaves it out).
    logInfo("theme studio: run settled", {
      runId: run.id,
      provider: run.provider,
      modelKey: run.modelKey,
      attempt: run.attemptCount,
      outcome: settled,
      ...(settlement.errorCode ? { errorCode: settlement.errorCode } : {}),
      ...(settlement.continues ? { continues: true } : {}),
      rssMiB: Math.ceil(process.memoryUsage().rss / 1_048_576),
    });
    // After the settling transaction committed, never inside it.
    if (settlement.notice) await sendNotice(run.projectId, settlement.notice);
    // A requeued run is picked up again next pass, not in a tight loop.
    if (settled === "requeued") break;
  }
  if (!options.skipVisualQa && Date.now() < deadline) {
    const qa = await runThemeStudioVisualQaWorker({ providers });
    if (qa.claimed > 0) {
      logInfo("theme studio: visual QA settled", { ...qa });
    }
  }
  return result;
}

/** How much work is waiting, for the heartbeat's response body. */
export async function countQueuedThemeStudioRuns(): Promise<number> {
  const [{ n }] = await withService((db) =>
    db
      .select({ n: count() })
      .from(themeStudioRuns)
      .where(eq(themeStudioRuns.status, "queued")),
  );
  return Number(n);
}
