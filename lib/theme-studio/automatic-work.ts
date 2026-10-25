import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  themeStudioCaptures,
  themeStudioMessages,
  themeStudioRuns,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { AUTOMATIC_CAPTURE_MAX_ATTEMPTS } from "./capture-core";
import { startCaptureJobAfterCommit } from "./capture-start";
import { getThemeStudioImageConfig } from "./image-models";
import {
  THEME_STUDIO_IMAGE_FAKE_PROMPT_VERSION,
  THEME_STUDIO_IMAGE_PROMPT_VERSION,
} from "./image-provider";
import { IMAGE_CRASH_ATTEMPTS } from "./image-recovery";
import { sendThemeStudioNotice } from "./notify";
import { recordThemeStudioEvent } from "./repository";

export interface AutomaticWork {
  id: string;
  projectId: string;
  provider: string;
  modelKey: string;
  qaIteration: number;
  createdBy: string | null;
}

export function automaticImageProvider(run: AutomaticWork) {
  if (run.provider === "fake") {
    return {
      providerModel: "fake",
      promptVersion: THEME_STUDIO_IMAGE_FAKE_PROMPT_VERSION,
    };
  }
  const image = getThemeStudioImageConfig();
  return image
    ? {
        providerModel: image.providerModel,
        promptVersion: THEME_STUDIO_IMAGE_PROMPT_VERSION,
      }
    : null;
}

/**
 * Queue an automatic capture inside the caller's transaction. ★ The capture
 * job starts as soon as that transaction commits
 * (`startCaptureJobAfterCommit`, capture-start.ts), not at the next minute
 * tick. `startJob: false` is for a caller running inside the capture job's
 * own finish: the job claims the new capture itself, so starting another
 * execution would only bill a second minute.
 */
export async function queueAutomaticCapture(
  db: Db,
  run: AutomaticWork,
  version: { id: string },
  packageDigest: string,
  phase: "layout" | "final" = "final",
  options: { startJob?: boolean } = {},
) {
  const [capture] = await db
    .insert(themeStudioCaptures)
    .values({
      projectId: run.projectId,
      versionId: version.id,
      packageDigest,
      previousStatus: "generating",
      idempotencyKey: `auto_${phase}_${run.id}`,
      phase,
      automatic: true,
      qaIteration: run.qaIteration,
      maxAttempts: AUTOMATIC_CAPTURE_MAX_ATTEMPTS,
      createdBy: run.createdBy,
    })
    .returning({ id: themeStudioCaptures.id });
  await recordThemeStudioEvent(db, {
    projectId: run.projectId,
    actor: "worker",
    eventType: "capture_requested",
    detail: {
      captureId: capture.id,
      versionId: version.id,
      phase,
      automatic: true,
      qaIteration: run.qaIteration,
    },
  });
  if (options.startJob !== false) startCaptureJobAfterCommit(capture.id);
}

export async function queueAutomaticImages(
  db: Db,
  run: AutomaticWork,
  version: { id: string },
  packageDigest: string,
  slots: number,
  imageSlotIds: string[] = [],
  corrections: Record<string, string> = {},
): Promise<string | null> {
  const resolved = automaticImageProvider(run);
  if (!resolved) return null;
  const [message] = await db
    .insert(themeStudioMessages)
    .values({
      projectId: run.projectId,
      kind: "images",
      body: imageSlotIds.length
        ? JSON.stringify({ qaImageCorrections: corrections })
        : `Automatically generate images for ${slots} slot${slots === 1 ? "" : "s"} before visual QA.`,
      referenceAssetIds: [],
      createdBy: run.createdBy,
    })
    .returning({ id: themeStudioMessages.id });
  const [imageRun] = await db
    .insert(themeStudioRuns)
    .values({
      projectId: run.projectId,
      messageId: message.id,
      kind: "images",
      baseVersionId: version.id,
      basePackageDigest: packageDigest,
      contextMessageIds: [],
      provider: run.provider,
      modelKey: run.modelKey,
      providerModel: resolved.providerModel,
      promptVersion: resolved.promptVersion,
      idempotencyKey: `auto_images_${run.id}`,
      maxAttempts: IMAGE_CRASH_ATTEMPTS,
      imageSlotIds,
      automatic: true,
      qaIteration: run.qaIteration,
      createdBy: run.createdBy,
    })
    .returning({ id: themeStudioRuns.id });
  await recordThemeStudioEvent(db, {
    projectId: run.projectId,
    runId: imageRun.id,
    actor: "worker",
    eventType: "images_requested",
    detail: {
      versionId: version.id,
      slots,
      automatic: true,
      qaIteration: run.qaIteration,
    },
  });
  return imageRun.id;
}

/** What the operator who started a theme is told (decision 8). */
export type ThemeStudioOperatorNotice = "ready" | "needs_fix";

interface OperatorNotice {
  projectId: string;
  kind: ThemeStudioOperatorNotice;
}

/** The notices noted inside the settlement now running (one per call of
 * `withServiceAndNotices`, nested by `withNoticeScope`). */
const noticeOutbox = new AsyncLocalStorage<OperatorNotice[]>();

/**
 * Note that the operator who started a theme should hear it is ready to
 * publish, or needs them. Nothing is sent here: the settlement this runs in
 * sends it once its transaction has committed (`withServiceAndNotices`), so
 * a notice is never sent for a change that rolled back, and no transaction
 * holds its locks while the notice is recorded and its email worker kicked
 * (lib/notifications/record.ts kicks it, and says it must never be kicked
 * before the caller commits).
 */
export function noteThemeStudioOperatorNotice(notice: OperatorNotice): void {
  const outbox = noticeOutbox.getStore();
  if (outbox) {
    outbox.push(notice);
    return;
  }
  // Every settlement that can stop or finish a theme runs in one; reaching
  // this is a bug, never a reason to fail the settlement.
  logError("theme studio: operator notice noted outside a settlement", null, {
    projectId: notice.projectId,
    kind: notice.kind,
  });
}

/**
 * Run `work` with its own notices: those it notes join the enclosing
 * settlement's only if it returns, so a savepoint that rolls the work back
 * drops them too.
 */
export async function withNoticeScope<T>(work: () => Promise<T>): Promise<T> {
  const parent = noticeOutbox.getStore();
  const own: OperatorNotice[] = [];
  const result = await noticeOutbox.run(own, work);
  if (parent) parent.push(...own);
  else await sendOperatorNotices(own);
  return result;
}

/**
 * `withService` for a settlement that may stop or finish a theme: the
 * notices it notes are sent after its transaction commits, each project and
 * kind once, by builder 3B's `sendThemeStudioNotice` (notify.ts: an in-app
 * notice and an email, only to the operator who started the theme). A
 * transaction that throws sends nothing. Sending never throws.
 */
export async function withServiceAndNotices<T>(
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const outbox: OperatorNotice[] = [];
  const result = await noticeOutbox.run(outbox, () => withService(fn));
  await sendOperatorNotices(outbox);
  return result;
}

async function sendOperatorNotices(
  notices: readonly OperatorNotice[],
): Promise<void> {
  const seen = new Set<string>();
  for (const notice of notices) {
    const key = `${notice.projectId}:${notice.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await sendThemeStudioNotice(notice);
    } catch (error) {
      logError("theme studio: operator notice not sent", error, {
        projectId: notice.projectId,
        kind: notice.kind,
      });
    }
  }
}
