"use server";

// ---------------------------------------------------------------------------
// Mink AI Theme Studio: operator mutations (Phase 2).
//
// ★ EVERY EXPORT HERE IS A PUBLIC POST ENDPOINT. A server action can be called
// without the page that renders its button, so each one re-derives the actor
// from the session (`getThemeStudioActor`, superadmin only) before touching
// anything. The page gate is a courtesy; this is the boundary.
//
// ★ These are thin adapters. Validation, locking, caps and idempotency live in
// lib/theme-studio/repository.ts (and stop.ts, capture.ts, publication.ts),
// which are deliberately NOT "use server" modules: their reads are
// platform-wide and must not be reachable directly.
//
// ★ Nothing here accepts an actor id, a provider model id, a file path or a
// run's inputs. The browser names a project, a run, a model KEY and an
// idempotency key; everything else is server-owned.
// ---------------------------------------------------------------------------

import { after } from "next/server";
import { revalidatePath, updateTag } from "next/cache";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import {
  deleteThemeStudioProject,
  type DeleteThemeStudioProjectInput,
} from "@/lib/theme-studio/deletion";
import { THEME_REGISTRY_TAG } from "@/lib/themes/runtime-registry";
import { STORE_TAG } from "@/lib/store/resolve";
import {
  queueThemeStudioCapture,
  queueThemeStudioRecheck,
} from "@/lib/theme-studio/capture";
import { getThemeStudioConfig } from "@/lib/theme-studio/config";
import type { ThemeStudioProjectState } from "@/lib/theme-studio/contracts";
import { stopThemeStudioChecks } from "@/lib/theme-studio/stop";
import {
  archiveThemeStudioProject,
  cancelThemeStudioRun,
  createThemeStudioProject,
  queueThemeStudioGeneration,
  removeThemeStudioReference,
  restoreThemeStudioVersion,
  retryThemeStudioRun,
  queueThemeStudioImages,
  reviseThemeStudioVersion,
  submitThemeStudioDetails,
  ThemeStudioError,
  validateProjectInput,
  type CreateThemeStudioProjectInput,
  type ThemeStudioRestoreOutcome,
} from "@/lib/theme-studio/repository";
import {
  discardProjectPreviews,
  openThemeStudioPreview,
  type OpenedPreview,
} from "@/lib/theme-studio/preview";
import { runThemeStudioWorker } from "@/lib/theme-studio/worker";
import { replaceThemeStudioSlotImages } from "@/lib/theme-studio/slot-images";
import {
  changeThemeStudioCatalog,
  publishThemeStudioProject,
} from "@/lib/theme-studio/publication";
import {
  startThemeStudioAcceptance,
  submitThemeStudioBrowserEvidence,
  type AcceptanceBrowserPlan,
  type ManualVisualQaEvidence,
} from "@/lib/theme-studio/acceptance";

export interface ThemeStudioActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const NOT_AUTHORIZED: ThemeStudioActionResult = {
  ok: false,
  error: "Only a platform superadmin can use Theme Studio.",
};

const STUDIO_PATH = "/dashboard/themes/studio";

function failure(error: unknown, context: string): ThemeStudioActionResult {
  if (error instanceof ThemeStudioError)
    return { ok: false, error: error.message };
  logError(`theme studio: ${context} failed`, error);
  return { ok: false, error: "Something went wrong. Nothing was changed." };
}

/** Kick the in-process worker after the response. The per-minute heartbeat is
 * the durable backstop if this instance is recycled first.
 *
 * ★ OFFLINE PROVIDER ONLY. The pass claims only runs queued against the fake
 * provider, which finish at once. With a model provider configured, new runs
 * are queued against that provider, so the pass would claim nothing and only
 * cost a database round trip after every click; a model run is executed by
 * the dedicated worker route instead. */
function kickWorker() {
  if (getThemeStudioConfig().provider !== "fake") return;
  after(async () => {
    try {
      // Offline runs only: they finish instantly. A model run takes minutes
      // and is executed by the dedicated worker route instead.
      await runThemeStudioWorker({
        maxRuns: 2,
        budgetMs: 20_000,
        providers: ["fake"],
      });
    } catch (error) {
      logError("theme studio: after-response worker failed", error);
    }
  });
}

export async function createThemeStudioProjectAction(
  input: CreateThemeStudioProjectInput,
): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const valid = validateProjectInput(input);
    const { id } = await createThemeStudioProject(actor, valid);
    revalidatePath(STUDIO_PATH);
    return { ok: true, id };
  } catch (error) {
    return failure(error, "create project");
  }
}

export async function queueThemeStudioGenerationAction(input: {
  projectId: string;
  expectedRevision: number;
  body?: string;
  referenceAssetIds?: string[];
  idempotencyKey: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) {
    return {
      ok: false,
      error: "The request is malformed. Reload and try again.",
    };
  }
  try {
    const { runId } = await queueThemeStudioGeneration(actor, {
      projectId: String(input.projectId),
      expectedRevision: input.expectedRevision,
      referenceAssetIds: input.referenceAssetIds,
      body: input.body,
      idempotencyKey: String(input.idempotencyKey),
    });
    kickWorker();
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true, id: runId };
  } catch (error) {
    return failure(error, "queue generation");
  }
}

export async function cancelThemeStudioRunAction(input: {
  projectId: string;
  runId: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    await cancelThemeStudioRun(actor, {
      projectId: String(input.projectId),
      runId: String(input.runId),
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true };
  } catch (error) {
    return failure(error, "cancel run");
  }
}

export async function retryThemeStudioRunAction(input: {
  projectId: string;
  runId: string;
  idempotencyKey: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const { runId } = await retryThemeStudioRun(actor, {
      projectId: String(input.projectId),
      runId: String(input.runId),
      idempotencyKey: String(input.idempotencyKey),
    });
    kickWorker();
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true, id: runId };
  } catch (error) {
    return failure(error, "retry run");
  }
}

/** Answer the model's clarifying questions and regenerate. */
export async function submitThemeStudioDetailsAction(input: {
  projectId: string;
  expectedRevision: number;
  body: string;
  referenceAssetIds?: string[];
  idempotencyKey: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) {
    return {
      ok: false,
      error: "The request is malformed. Reload and try again.",
    };
  }
  try {
    const { runId } = await submitThemeStudioDetails(actor, {
      projectId: String(input.projectId),
      expectedRevision: input.expectedRevision,
      body: String(input.body ?? ""),
      referenceAssetIds: input.referenceAssetIds,
      idempotencyKey: String(input.idempotencyKey),
    });
    kickWorker();
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true, id: runId };
  } catch (error) {
    return failure(error, "submit details");
  }
}

export async function removeThemeStudioReferenceAction(input: {
  projectId: string;
  assetId: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    await removeThemeStudioReference(
      actor,
      String(input.projectId),
      String(input.assetId),
    );
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true };
  } catch (error) {
    return failure(error, "remove reference");
  }
}

export async function archiveThemeStudioProjectAction(input: {
  projectId: string;
  expectedRevision: number;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) {
    return {
      ok: false,
      error: "The request is malformed. Reload and try again.",
    };
  }
  try {
    await archiveThemeStudioProject(actor, {
      projectId: String(input.projectId),
      expectedRevision: input.expectedRevision,
    });
    // An archived project keeps no previews. The heartbeat sweep is the
    // backstop if this instance is recycled before the discard runs.
    const projectId = String(input.projectId);
    after(async () => {
      try {
        await discardProjectPreviews(projectId);
      } catch (error) {
        logError("theme studio: preview discard failed", error);
      }
    });
    revalidatePath(STUDIO_PATH);
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true };
  } catch (error) {
    return failure(error, "archive project");
  }
}

export async function deleteThemeStudioProjectAction(
  input: DeleteThemeStudioProjectInput,
): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    await deleteThemeStudioProject(actor, input);
  } catch (error) {
    return failure(error, "delete theme");
  }
  // Removal has committed. A cache failure must not claim nothing changed or
  // invite the operator to believe the deleted theme is still recoverable.
  try {
    updateTag(THEME_REGISTRY_TAG);
    updateTag(STORE_TAG);
    revalidatePath(STUDIO_PATH);
    revalidatePath("/dashboard/themes");
    revalidatePath("/themes");
  } catch (error) {
    logError("theme studio: deleted theme cache invalidation failed", error);
  }
  return { ok: true };
}

const MALFORMED: ThemeStudioActionResult = {
  ok: false,
  error: "The request is malformed. Reload and try again.",
};

/** Ask for a revision of one version (the current one, or an older one to
 * branch from). Bound to the version's content address on screen. */
export async function reviseThemeStudioVersionAction(input: {
  projectId: string;
  versionId: string;
  expectedRevision: number;
  expectedPackageDigest: string;
  body: string;
  referenceAssetIds?: string[];
  idempotencyKey: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) return MALFORMED;
  try {
    const { runId } = await reviseThemeStudioVersion(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
      expectedRevision: input.expectedRevision,
      expectedPackageDigest: String(input.expectedPackageDigest ?? ""),
      body: String(input.body ?? ""),
      referenceAssetIds: input.referenceAssetIds,
      idempotencyKey: String(input.idempotencyKey),
    });
    kickWorker();
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true, id: runId };
  } catch (error) {
    return failure(error, "revise version");
  }
}

/** Ask Theme Studio to draw a version's images (Track 3.2). */
export async function queueThemeStudioImagesAction(input: {
  projectId: string;
  versionId: string;
  expectedRevision: number;
  expectedPackageDigest: string;
  idempotencyKey: string;
  /** Redraw exactly these slots; absent draws every placeholder. */
  slotIds?: string[];
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) return MALFORMED;
  if (
    input.slotIds !== undefined &&
    (!Array.isArray(input.slotIds) ||
      input.slotIds.some((id) => typeof id !== "string"))
  ) {
    return MALFORMED;
  }
  try {
    const { runId } = await queueThemeStudioImages(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
      expectedRevision: input.expectedRevision,
      expectedPackageDigest: String(input.expectedPackageDigest ?? ""),
      idempotencyKey: String(input.idempotencyKey),
      ...(input.slotIds ? { slotIds: input.slotIds } : {}),
    });
    kickWorker();
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true, id: runId };
  } catch (error) {
    return failure(error, "generate images");
  }
}

/**
 * Queue a capture of the current version's catalog card and screenshots
 * (Track 3.6). The headless-Chromium job runs separately and picks it up on
 * its next pass; nothing is kicked here, and a capture costs no model spend.
 */
export async function queueThemeStudioCaptureAction(input: {
  projectId: string;
  versionId: string;
  expectedRevision: number;
  expectedPackageDigest: string;
  idempotencyKey: string;
}): Promise<ThemeStudioActionResult> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) return MALFORMED;
  try {
    const { captureId } = await queueThemeStudioCapture(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
      expectedRevision: input.expectedRevision,
      expectedPackageDigest: String(input.expectedPackageDigest ?? ""),
      idempotencyKey: String(input.idempotencyKey),
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`);
    return { ok: true, id: captureId };
  } catch (error) {
    return failure(error, "capture the catalog pictures");
  }
}

/** Make an earlier version current again. With the automatic checks on, the
 * outcome says where that left the theme: Ready to publish at once, checking
 * again on today's build, checking a new hidden version, or just current. */
export async function restoreThemeStudioVersionAction(input: {
  projectId: string;
  versionId: string;
  expectedRevision: number;
}): Promise<
  ThemeStudioActionResult & {
    changed?: boolean;
    outcome?: ThemeStudioRestoreOutcome;
  }
> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) return MALFORMED;
  try {
    const { changed, outcome } = await restoreThemeStudioVersion(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
      expectedRevision: input.expectedRevision,
    });
    revalidatePath(STUDIO_PATH);
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`, "layout");
    return { ok: true, changed, outcome };
  } catch (error) {
    return failure(error, "restore version");
  }
}

/**
 * Stop whatever is working on a theme (lib/theme-studio/stop.ts): a capture
 * or a design review at once, a build step within a few seconds, which keeps
 * the pictures it already drew. `cancelling` means a build step is still
 * finishing its stop, and the theme stays generating until it has.
 */
export async function stopThemeStudioChecksAction(input: {
  projectId: string;
  expectedRevision: number;
}): Promise<
  ThemeStudioActionResult & {
    status?: ThemeStudioProjectState;
    cancelling?: boolean;
  }
> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) return MALFORMED;
  try {
    const result = await stopThemeStudioChecks(actor, {
      projectId: String(input.projectId),
      expectedRevision: input.expectedRevision,
    });
    revalidatePath(STUDIO_PATH);
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`, "layout");
    return { ok: true, status: result.status, cancelling: result.cancelling };
  } catch (error) {
    return failure(error, "stop checks");
  }
}

/**
 * "Check again": measure the current version once more on today's StoreMink
 * build in the capture job, with its design review (the re-check contract,
 * capture.ts `queueThemeStudioRecheck`). Nothing is redrawn and no paid
 * restyle can follow. `inPlace` is true for a version that passed before,
 * which is measured as it is; any other gets fresh catalogue pictures in a
 * new hidden version. The reason is the server's to choose: Publish starts
 * its own re-check, so the browser can only ask for `check_again`.
 */
export async function recheckThemeStudioVersionAction(input: {
  projectId: string;
  versionId: string;
  expectedRevision: number;
}): Promise<ThemeStudioActionResult & { inPlace?: boolean }> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  if (!Number.isInteger(input?.expectedRevision)) return MALFORMED;
  try {
    const { captureId, inPlace } = await queueThemeStudioRecheck(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
      expectedRevision: input.expectedRevision,
      reason: "check_again",
    });
    revalidatePath(STUDIO_PATH);
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`, "layout");
    return { ok: true, id: captureId, inPlace };
  } catch (error) {
    return failure(error, "check again");
  }
}

/** Open a version's private preview, building it first if needed. Returns a
 * ten-minute token to enter it, never the grant itself, which is issued on
 * the preview host so it can be host-only. */
export async function openThemeStudioPreviewAction(input: {
  projectId: string;
  versionId: string;
}): Promise<ThemeStudioActionResult & { preview?: OpenedPreview }> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const preview = await openThemeStudioPreview(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
    });
    return { ok: true, id: preview.previewId, preview };
  } catch (error) {
    return failure(error, "open preview");
  }
}

/**
 * Run the automated acceptance gates on the project's current version. The
 * server stage runs inside this request; when it returns a plan, the browser
 * stage runs in the operator's page and reports back through the next action.
 * The operator's own session cookie travels with the server's page fetches,
 * because the preview gate requires it wherever the session is shared.
 */
export async function startThemeStudioAcceptanceAction(input: {
  projectId: string;
  versionId: string;
}): Promise<
  ThemeStudioActionResult & {
    status?: "awaiting_browser" | "failed" | "blocked";
    plan?: AcceptanceBrowserPlan | null;
  }
> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const jar = await cookies();
    const result = await startThemeStudioAcceptance(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
      sessionCookie: jar.get(SESSION_COOKIE)?.value ?? null,
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`, "layout");
    return {
      ok: true,
      id: result.runId,
      status: result.status,
      plan: result.plan,
    };
  } catch (error) {
    return failure(error, "start acceptance");
  }
}

/** Submit the browser stage's raw measurements. The verdict is computed on
 * the server; nothing the browser claims about passing is read. */
export async function submitThemeStudioBrowserEvidenceAction(input: {
  projectId: string;
  runId: string;
  nonce: string;
  evidence: unknown;
}): Promise<
  ThemeStudioActionResult & {
    status?: "passed" | "failed" | "blocked";
    candidate?: boolean;
    visualQa?: ManualVisualQaEvidence | null;
  }
> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const result = await submitThemeStudioBrowserEvidence(actor, {
      projectId: String(input.projectId),
      runId: String(input.runId),
      nonce: input.nonce,
      evidence: input.evidence,
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`, "layout");
    return {
      ok: true,
      id: input.runId,
      status: result.status,
      candidate: result.candidate,
      visualQa: result.visualQa,
    };
  } catch (error) {
    return failure(error, "submit browser evidence");
  }
}

/**
 * Save staged slot images as ONE new version of the project, parented to the
 * version edited. Uploads happen through the slot-image route; this names only
 * asset ids the project already holds, and the server re-checks each one.
 * `checking`: with the automatic checks on and the pictures complete, the
 * new version stays hidden while one capture and the design review check it
 * (slot-images.ts), and the theme shows it when they finish.
 */
export async function replaceThemeStudioSlotImagesAction(input: {
  projectId: string;
  versionId: string;
  expectedRevision: number;
  expectedPackageDigest: string;
  replacements: unknown;
}): Promise<
  ThemeStudioActionResult & { versionNumber?: number; checking?: boolean }
> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const result = await replaceThemeStudioSlotImages(actor, {
      projectId: String(input.projectId),
      versionId: String(input.versionId),
      expectedRevision: Number(input.expectedRevision),
      expectedPackageDigest: String(input.expectedPackageDigest),
      replacements: input.replacements,
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`, "layout");
    return {
      ok: true,
      id: result.versionId,
      versionNumber: result.versionNumber,
      checking: result.checking,
    };
  } catch (error) {
    return failure(error, "replace slot images");
  }
}

/**
 * Publish a theme that is Ready to publish in one step: store the release,
 * seed and render its live demo, then expose it in the theme catalog and
 * every store's Theme library. A failure after the attempt starts is
 * recorded and returned with its reasons; nothing becomes public, and the
 * same button tries again.
 *
 * ★ `kind: "rechecking"` is not a failure. When the theme's checks are not
 * from today's StoreMink build (or have no design review bound to them),
 * Publish starts a re-check on today's build instead (owner decision 4) and
 * says so in `message`; the operator publishes once it passes.
 */
export async function publishThemeStudioProjectAction(input: {
  projectId: string;
  expectedRevision: number;
}): Promise<
  ThemeStudioActionResult & {
    kind?: "published" | "failed" | "rechecking";
    releaseVersion?: string;
    demoSlug?: string;
    problems?: string[];
    message?: string;
    inPlace?: boolean;
  }
> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const result = await publishThemeStudioProject(actor, {
      projectId: String(input.projectId),
      expectedRevision: Number(input.expectedRevision),
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`, "layout");
    revalidatePath("/dashboard/themes");
    if (result.kind === "rechecking") {
      revalidatePath(STUDIO_PATH);
      return {
        ok: true,
        kind: "rechecking",
        id: result.captureId,
        message: result.problems[0],
        inPlace: result.inPlace,
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        kind: "failed",
        id: result.publicationId,
        error: result.problems[0],
        problems: result.problems,
      };
    }
    revalidatePath(STUDIO_PATH);
    return {
      ok: true,
      kind: "published",
      id: result.publicationId,
      releaseVersion: result.releaseVersion,
      demoSlug: result.demoSlug,
    };
  } catch (error) {
    return failure(error, "publish theme");
  }
}

/** Hide from new installs, show again, or restore an earlier release. */
export async function changeThemeStudioCatalogAction(input: {
  projectId: string;
  change: unknown;
}): Promise<ThemeStudioActionResult & { changed?: boolean }> {
  const actor = await getThemeStudioActor();
  if (!actor) return NOT_AUTHORIZED;
  try {
    const { changed } = await changeThemeStudioCatalog(actor, {
      projectId: String(input.projectId),
      change: input.change,
    });
    revalidatePath(`${STUDIO_PATH}/${input.projectId}`, "layout");
    revalidatePath("/dashboard/themes");
    return { ok: true, changed };
  } catch (error) {
    return failure(error, "change catalog");
  }
}
