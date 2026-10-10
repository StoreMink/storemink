import "server-only";
import { GoogleAuth } from "google-auth-library";
import { sql } from "drizzle-orm";
import { themeStudioCaptures } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logInfo, logWarn } from "@/lib/observability/logger";
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

const START_WINDOW_SECONDS = 90;
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
