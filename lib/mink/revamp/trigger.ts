import "server-only";

// ---------------------------------------------------------------------------
// The revamp runner's self-kick (docs/mink-storefront-revamp.md section 4.3).
//
// A revamp runs in `/api/internal/mink/revamps/run`, one leased invocation of
// up to 20 minutes at a time. Nothing schedules it (owner's rule: no
// schedulers on dev), so whoever has a reason to move a job sends this kick:
// the start and refine tools after the insert, the runner itself when it
// hands over at its deadline, the status poll for a stalled job, and the
// production minute heartbeat's sweep.
//
// ★ THE `lib/help/embedding-trigger.ts` PATTERN, ON PURPOSE. CRON_SECRET as a
//   bearer, the CURRENT request's origin first (so a kick from a local or
//   staging dashboard wakes that same environment, never production), the
//   platform origin only with no request scope, and a five-second bound that
//   is not an error: the runner is already working when the delivery request
//   times out, and holding the caller open for twenty minutes is the thing
//   this exists to avoid.
//
// ★ IT NEVER THROWS. A kick is a nudge, not a commitment: a lost kick costs at
//   most one status-poll cooldown, because the next poll or sweep sends another.
// ---------------------------------------------------------------------------

import { PLATFORM_URL } from "@/lib/store/host";
import { getRequestOrigin } from "@/lib/request-url";
import { logInfo, logWarn } from "@/lib/observability/logger";

const RUN_PATH = "/api/internal/mink/revamps/run";
const KICK_TIMEOUT_MS = 5_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Ask the runner to claim and continue one revamp. Best effort; never throws. */
export async function kickRevampRunner(revampId: string): Promise<void> {
  // A malformed id would only earn a 400 from the run route; sending it is a
  // request nobody needs.
  if (typeof revampId !== "string" || !UUID_PATTERN.test(revampId)) return;
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logWarn(
      "Mink revamp runner not kicked (CRON_SECRET unset); the status poll will try again.",
      { revampId },
    );
    return;
  }
  let origin: string = PLATFORM_URL;
  try {
    origin = (await getRequestOrigin()) ?? PLATFORM_URL;
  } catch {
    // getRequestOrigin already returns null outside a request; anything else
    // still falls back to the platform rather than losing the kick.
  }
  try {
    const response = await fetch(`${origin}${RUN_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ revampId }),
      cache: "no-store",
      signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
    });
    // ★ 429: the instance that took the kick is already running a revamp
    //   (runner.ts, one per process). Nothing was claimed, and the job is
    //   kicked again when that one ends, so it is not a failure to report.
    if (response.status === 429) {
      logInfo("Mink revamp runner busy; the job waits for the next kick", {
        revampId,
      });
      return;
    }
    if (!response.ok) {
      logWarn("Mink revamp runner kick failed", {
        revampId,
        origin,
        status: response.status,
      });
    }
  } catch (error) {
    // The runner keeps working after the five-second delivery bound: a
    // timeout here means the kick landed, not that it failed.
    if (error instanceof Error && error.name === "TimeoutError") return;
    // A fetch failure names the network fault ("fetch failed", a refused
    // connection), never anything the merchant wrote: the body is only the id.
    logWarn("Mink revamp runner kick failed", {
      revampId,
      origin,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
