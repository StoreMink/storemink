import "server-only";
import { GoogleAuth } from "google-auth-library";
import { eq, sql } from "drizzle-orm";
import { themeStudioCaptures } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { getThemeStudioConfig } from "./config";

// Starting the Chromium capture job only when a capture is waiting.
//
// ★★ THE JOB USED TO START EVERY MINUTE, AND A CLOUD RUN JOB IS BILLED FOR AT
// LEAST A MINUTE. Two Cloud Scheduler entries (prod and dev) started a
// 2 vCPU / 2 GiB execution every minute whether or not anything was queued,
// and almost every one found nothing. Measured on the October 2026 bill:
// "Jobs CPU" + "Jobs Memory" were ₹5,819 of Cloud Run's ₹5,972 in ten days,
// 3.03 million vCPU-seconds, which is 2,880 executions a day at the one-minute
// minimum. The web service, on request-based billing, cost ₹152.
//
// ★ So the existing per-minute Theme Studio routes (themselves cheap web
// requests) ask one question first: is a capture claimable? Only then do they
// start the job, through the Cloud Run Admin API. That covers every way a
// capture becomes claimable without threading a call through each worker
// transaction: an operator's capture, an automatic one, a QA recapture, a
// failed attempt sent back to the queue, and a lapsed lease. The capture
// schedules can then be paused (docs/theme-studio-capture-job.md).
//
// ★ A shared rate limit allows one start per window per job, because a
// claimable capture stays claimable until the started job has booted and
// claimed it. A capture older than STALE_AFTER no longer starts anything, so a
// broken job cannot be started every window for ever.
//
// ★ AND A CAPTURE THE JOB NEVER TAKES IS FAILED, NOT LEFT WAITING (TS-1E).
// Every call first fails the captures nobody took within 15 minutes
// (`sweepStaleThemeStudioCaptures`, capture.ts: `capture_not_started` and the
// `theme_studio.capture_stale` log line), whether or not this deployment can
// start the job: an unconfigured or switched-off job is exactly the case
// where nothing else would ever end them.
//
// ★★ AND THE JOB STARTS RIGHT AFTER A CAPTURE IS QUEUED (TS-3A, plan
// optimisation 2). Waiting for the next minute tick cost a theme about half a
// minute per capture. Where the queueing transaction is our own (an
// operator's capture, a re-check), `startCaptureJobForQueued` runs once it
// has committed. Where it is a caller's (a build step's settle in worker.ts,
// a picture save, Make current, a deploy re-capture), the start cannot run
// inside it (no transaction awaits network work, lib/db/client.ts), so
// `startCaptureJobAfterCommit` waits for the capture row to become visible,
// which happens only on commit, and then starts the job. The minute ticks
// stay as the safety net, and the rate limit below still allows one start
// per window, so a capture the job is about to claim anyway costs no second
// execution. A capture the capture job itself queues while it finishes (the
// final capture after a passing layout check) starts nothing: the running
// job claims it next.

const START_WINDOW_SECONDS = 90;
/** When `startCaptureJobAfterCommit` looks for the queued capture, in ms
 * after the call: about 16 s in all. A capture still not visible by then was
 * rolled back, and the minute ticks cover a commit slower than that. */
export const COMMIT_POLL_DELAYS_MS = [
  100, 250, 500, 1_000, 2_000, 4_000, 8_000,
] as const;
const STALE_AFTER = "6 hours";
const NAME = /^[a-z][a-z0-9-]{0,62}$/;

export interface CaptureJobTarget {
  project: string;
  region: string;
  job: string;
}

/**
 * The capture job this deployment starts, or null where there is none (local
 * development, a service outside the prod/dev pair, a missing project id).
 *
 * The job name is derived from Cloud Run's own K_SERVICE the way
 * cloudbuild.yaml's capture-deploy step derives it from _SERVICE: every
 * Theme Studio service ends in -prod or -dev, including the private workers,
 * which copy THEME_STUDIO_* and GCP_PROJECT_ID from the web service.
 * THEME_STUDIO_CAPTURE_JOB / _REGION override it.
 */
export function captureJobTarget(
  env: NodeJS.ProcessEnv = process.env,
): CaptureJobTarget | null {
  const project = env.GCP_PROJECT_ID?.trim() ?? "";
  const region = env.THEME_STUDIO_CAPTURE_REGION?.trim() || "asia-south1";
  const service = env.K_SERVICE?.trim() ?? "";
  const job =
    env.THEME_STUDIO_CAPTURE_JOB?.trim() ||
    (service.endsWith("-prod")
      ? "storemink-theme-studio-capture"
      : service.endsWith("-dev")
        ? "storemink-theme-studio-capture-dev"
        : "");
  if (!NAME.test(project) || !NAME.test(region) || !NAME.test(job)) {
    return null;
  }
  return { project, region, job };
}

export type CaptureJobStart =
  | "unconfigured"
  | "idle"
  | "throttled"
  | "started"
  | "failed";

let authClient: GoogleAuth | null = null;
function auth(): GoogleAuth {
  authClient ??= new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return authClient;
}

/** Is a capture waiting for the job? The claim's own predicate (queued, or
 *  running on a lapsed lease, which the claim also settles when its attempts
 *  are spent), bounded to recent rows. */
async function captureWaiting(): Promise<boolean> {
  const rows = await withService((db) =>
    db
      .select({ id: themeStudioCaptures.id })
      .from(themeStudioCaptures)
      .where(
        sql`(${themeStudioCaptures.status} = 'queued'
              AND ${themeStudioCaptures.createdAt} > now() - ${STALE_AFTER}::interval)
            OR (${themeStudioCaptures.status} = 'running'
              AND ${themeStudioCaptures.leaseExpiresAt} <= now()
              AND ${themeStudioCaptures.leaseExpiresAt} > now() - ${STALE_AFTER}::interval)`,
      )
      .limit(1),
  );
  return rows.length > 0;
}

/**
 * Start the capture job if a capture is waiting. Never throws: a failure here
 * must not fail the worker request it rides on.
 */
export async function startCaptureJobIfWaiting(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptureJobStart> {
  try {
    // Loaded at call time: capture.ts starts the job itself after queueing,
    // so a static import here would make the two modules import each other.
    const { sweepStaleThemeStudioCaptures } = await import("./capture");
    // Never throws either; a stuck capture it fails is no longer waiting below.
    await sweepStaleThemeStudioCaptures();
  } catch (error) {
    logError("theme studio: stale capture sweep could not run", error);
  }
  return startJob(env);
}

/**
 * Start the capture job for a capture the caller has just queued and
 * committed. The same start as the minute ticks', without their stale sweep
 * (they still run it). Answers "unconfigured" without touching the database
 * where this deployment has no job. Never throws.
 */
export function startCaptureJobForQueued(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptureJobStart> {
  return startJob(env);
}

/** Starts scheduled by `startCaptureJobAfterCommit`, still running. */
const pendingStarts = new Set<Promise<void>>();

/** The committed status of one capture, or null while it is not visible. */
async function committedCaptureStatus(
  captureId: string,
): Promise<string | null> {
  const [row] = await withService((db) =>
    db
      .select({ status: themeStudioCaptures.status })
      .from(themeStudioCaptures)
      .where(eq(themeStudioCaptures.id, captureId))
      .limit(1),
  );
  return row?.status ?? null;
}

/**
 * Start the capture job once the transaction that queued `captureId`
 * commits, for a caller whose transaction is still open. Returns at once:
 * the start runs beside the caller, looking for the capture at
 * `COMMIT_POLL_DELAYS_MS`, and starts the job when it is visible and still
 * queued (one already claimed or ended needs nothing). Routes that queue
 * captures await `settleCaptureJobStarts` before they answer, so the start
 * stays inside their request. Does nothing where this deployment has no job.
 * Never throws.
 */
export function startCaptureJobAfterCommit(
  captureId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!captureJobTarget(env) || !getThemeStudioConfig(env).captureEnabled) {
    return;
  }
  const started: Promise<void> = (async () => {
    for (const delay of COMMIT_POLL_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const status = await committedCaptureStatus(captureId);
      // Not visible: still committing, or rolled back. Look again.
      if (status === null) continue;
      if (status === "queued") await startJob(env);
      return;
    }
  })()
    .catch((error) => {
      // Not the start's own failure line (an alert watches that one): the
      // look-up failed, and the minute ticks start the job instead.
      logError("theme studio: capture start after commit failed", error, {
        captureId,
      });
    })
    .finally(() => {
      pendingStarts.delete(started);
    });
  pendingStarts.add(started);
}

/** Wait for every start `startCaptureJobAfterCommit` has scheduled in this
 * process (at most about 16 s each). Never throws. */
export async function settleCaptureJobStarts(): Promise<void> {
  while (pendingStarts.size > 0) {
    await Promise.allSettled([...pendingStarts]);
  }
}

/** The start itself: the job's target, a waiting capture, the rate limit,
 * then the Cloud Run Admin API. Never throws. */
async function startJob(env: NodeJS.ProcessEnv): Promise<CaptureJobStart> {
  const target = captureJobTarget(env);
  if (!target || !getThemeStudioConfig(env).captureEnabled) {
    return "unconfigured";
  }
  try {
    if (!(await captureWaiting())) return "idle";
    const { allowed } = await rateLimit(
      `theme-studio:capture-start:${target.job}`,
      { max: 1, windowSeconds: START_WINDOW_SECONDS },
    );
    if (!allowed) return "throttled";
    const client = await auth().getClient();
    const token = await client.getAccessToken();
    const response = await fetch(
      `https://run.googleapis.com/v2/projects/${target.project}/locations/${target.region}/jobs/${target.job}:run`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.token ?? ""}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      // 403 means the service account lacks roles/run.invoker on the job.
      logWarn("theme_studio.capture_job_start_failed", {
        job: target.job,
        status: response.status,
      });
      return "failed";
    }
    logInfo("theme_studio.capture_job_started", { job: target.job });
    return "started";
  } catch (error) {
    logWarn("theme_studio.capture_job_start_failed", {
      job: target.job,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return "failed";
  }
}
