import { NextResponse } from "next/server";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { loggableError } from "@/lib/db/errors";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { MinkRequestError } from "@/lib/mink/errors";
import { requestRefineStop, stopLiveRefine } from "@/lib/mink/refine-stop";
import { REFINE_STOP_TOKEN_PATTERN } from "@/lib/mink/refine-stop-types";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The browser sends `{ stopToken }`. */
const MAX_BODY_BYTES = 1_024;
const HEADERS = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
};

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: HEADERS });

/**
 * Stop a Refine with Mink AI request: `200 { outcome }`
 * (lib/mink/refine-stop-types.ts: `stopped`, `recorded` or `too_late` with
 * the photo's URL). Anything else is read as `unknown`.
 *
 * ★★ A STOP IS A REQUEST THE REFINE'S OWN ROW DECIDES, NOT AN ABORTED FETCH
 *   (26 Oct 2026). Behind the production load balancer an aborted browser
 *   fetch never reaches Cloud Run, so a merchant who left mid-refine was
 *   still charged. The editor sends its refine's random stop token here when
 *   the page goes away (as a beacon), when its request dies, or when the
 *   merchant removes the photo; the stop wins only before the charge is
 *   claimed (lib/mink/refine-stop.ts).
 * ★ NOT GATED ON `getMinkConfig().enabled`: a refine already running must
 *   still be stoppable while Mink is being switched off.
 * ★ THE VIEWER, NOT THE MINK ACTOR CONTEXT: a stop needs only who is asking
 *   in which store. The actor context adds a user transaction for plan and
 *   settings and a brand-voice read, each of which can fail and let the
 *   charge win. Media manage is not required: a stop only reaches the
 *   caller's own refines (the row is keyed by store, admin and token).
 * ★ A token this admin never used is `recorded`, never "not found": a stop
 *   may overtake its own refine, and a 404 would tell a caller which tokens
 *   exist. "Too late" is a decided answer, so it is a 200 too.
 */
export async function POST(request: Request) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const requestId = crypto.randomUUID();
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      throw new MinkRequestError("not_signed_in", "Not signed in.", 401);
    }
    if (viewer.dbError) {
      throw new MinkRequestError(
        "permissions_unavailable",
        "Mink AI can't check your permissions right now. Try again shortly.",
        503,
      );
    }
    if (!viewer.profile) {
      throw new MinkRequestError(
        "store_access_denied",
        "You don't have access to this store.",
        403,
      );
    }
    if (!can(viewer.permissions, "dashboard", "view", viewer.isSuperadmin)) {
      throw new MinkRequestError(
        "mink_access_denied",
        "You don't have permission to use Mink AI for this store.",
        403,
      );
    }
    // The same values the refine's actor carries (lib/mink/actor-context.ts).
    const storeId = viewer.storeId;
    const adminId = viewer.userId;

    const limited = await rateLimit(`mink-refine-stop:${storeId}:${adminId}`, {
      max: 30,
      windowSeconds: 60,
    });
    if (!limited.allowed) {
      return json(
        {
          error: "Too many stop requests. Try again shortly.",
          outcome: "unknown",
        },
        429,
      );
    }

    // ★ Parsed whatever the Content-Type: a beacon's string body arrives as
    //   text/plain.
    const body = await readMinkBoundedJson(
      request,
      MAX_BODY_BYTES,
      AbortSignal.timeout(5_000),
    );
    const token = body.stopToken;
    if (typeof token !== "string" || !REFINE_STOP_TOKEN_PATTERN.test(token)) {
      return json({ error: "Invalid stop request.", outcome: "unknown" }, 400);
    }
    const key = { storeId, adminId, stopToken: token.toLowerCase() };
    const answer = await requestRefineStop(key);
    // ★ At once when this instance is running the refine; on another one,
    //   its watcher reads the recorded stop within about a second.
    if (answer.outcome === "stopped") stopLiveRefine(key);
    // Content-free: ids and the outcome, never the token.
    logInfo("mink.image-refine: stop", {
      requestId,
      storeId,
      adminId,
      outcome: answer.outcome,
    });
    return json(answer);
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.image-refine: stop rejected", {
        requestId,
        code: error.code,
        status: error.status,
      });
      return json(
        { error: error.message, code: error.code, outcome: "unknown" },
        error.status,
      );
    }
    // ★ loggableError: a failed query's own message carries its parameters,
    //   and the stop's include the token.
    logError("mink.image-refine: stop failed", loggableError(error), {
      requestId,
    });
    // The browser reads any failure as "unknown".
    return json(
      { error: "Couldn't stop that refine right now.", outcome: "unknown" },
      503,
    );
  }
}
