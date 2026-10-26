import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { requestMinkRunStop, stopLiveMinkRun } from "@/lib/mink/run-stop";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The browser sends `{}`; the body is never read. */
const MAX_BODY_BYTES = 1_024;
const HEADERS = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
};

/**
 * Ask a Mink run to stop: `200 { outcome, status? }` (lib/mink/run-stop-types.ts).
 *
 * ★★ A STOP IS A REQUEST THE RUN'S OWN ROW DECIDES, NOT AN ABORTED FETCH
 *   (25 Oct 2026). Behind the production load balancer an aborted browser
 *   fetch never reaches Cloud Run, so a reply the merchant stopped kept going
 *   and once started a storefront redesign whose card never showed. The
 *   browser now asks here and lets go of the reply only on `stopped`; on
 *   `acted` (the run already started something) the reply finishes and lands.
 * ★ NOT GATED ON `getMinkConfig().enabled`: a run already going must still be
 *   stoppable while Mink is being switched off.
 * ★ POST only, same-origin only: a page on another site must not be able to
 *   stop somebody's reply. Another admin's run, another store's run, a
 *   malformed id and a run that does not exist all answer the same 404, so
 *   the answer says nothing about runs that are not the caller's.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Stop request is too large." },
      { status: 413, headers: HEADERS },
    );
  }
  const { runId } = await params;
  if (!UUID_PATTERN.test(runId)) return notFound();
  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: getMinkConfig().betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-stop:${actor.storeId}:${actor.adminId}`,
      { max: 30, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        {
          error: "Mink is receiving too many stop requests. Try again shortly.",
        },
        { status: 429, headers: HEADERS },
      );
    }
    const answer = await requestMinkRunStop({
      runId,
      storeId: actor.storeId,
      adminId: actor.adminId,
    });
    // ★ At once when this instance is answering the run; on another one, its
    //   watcher reads the recorded stop within about two seconds.
    if (answer.outcome === "stopped") stopLiveMinkRun(runId);
    // Content-free: ids and the outcome.
    logInfo("mink.stop: requested", {
      requestId,
      runId,
      storeId: actor.storeId,
      adminId: actor.adminId,
      outcome: answer.outcome,
    });
    if (answer.outcome === "not_found") return notFound();
    return NextResponse.json(answer, { headers: HEADERS });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.stop: request rejected", {
        requestId,
        runId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: HEADERS },
      );
    }
    logError("mink.stop: request failed", error, { requestId, runId });
    // The browser reads any failure as "unknown" and keeps the reply.
    return NextResponse.json(
      { error: "Mink couldn't stop that reply right now." },
      { status: 503, headers: HEADERS },
    );
  }
}

function notFound() {
  return NextResponse.json(
    { error: "That reply is not running." },
    { status: 404, headers: HEADERS },
  );
}
