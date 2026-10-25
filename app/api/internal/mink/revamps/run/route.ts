import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { loggableError } from "@/lib/db/errors";
import { getMinkConfig } from "@/lib/mink/config";
import { defaultRevampDeps } from "@/lib/mink/revamp/deps";
import { runRevampJob } from "@/lib/mink/revamp/runner";
import { logError } from "@/lib/observability/logger";

// The storefront revamp runner (docs/mink-storefront-revamp.md).
//
// ★ A REVAMP OUTLIVES ITS KICK. lib/mink/revamp/trigger.ts posts here and
//   stops listening after five seconds by design, so the run is NOT tied to
//   `request.signal`: a disconnect that aborted it would stop every revamp
//   five seconds in. The runner bounds itself (its deadline hands over well
//   inside maxDuration) and every write it makes is fenced on its lease.
// ★ IT TAKES ONE THING FROM THE CALLER: the revamp id. Everything else (the
//   store, the requester, what they may do) is read from service-owned rows
//   by the runner, and the job layer refuses an id it cannot claim.
export const runtime = "nodejs";
export const maxDuration = 1200;
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** CRON_SECRET as a bearer token, as every internal job authenticates. */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (typeof secret !== "string" || secret.length === 0) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readRevampId(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const revampId = (body as Record<string, unknown>).revampId;
  return typeof revampId === "string" && UUID_PATTERN.test(revampId)
    ? revampId.toLowerCase()
    : null;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const revampId = await readRevampId(request);
  if (!revampId) {
    return NextResponse.json({ error: "Invalid revamp id" }, { status: 400 });
  }
  // The global emergency stop: nothing is claimed, so the job waits intact
  // for Mink to come back rather than failing.
  if (!getMinkConfig().enabled) {
    return NextResponse.json(
      { error: "Mink AI is switched off" },
      { status: 503 },
    );
  }
  try {
    const { outcome } = await runRevampJob({
      revampId,
      deps: defaultRevampDeps(),
      requestId: crypto.randomUUID(),
    });
    // ★ This process already runs a revamp (runner.ts, one per process):
    //   nothing was claimed, and the job is kicked again when that one ends,
    //   by the card's poll, or by the sweep.
    if (outcome === "busy") {
      return NextResponse.json(
        { outcome },
        { status: 429, headers: { "Retry-After": "30" } },
      );
    }
    return NextResponse.json({ outcome });
  } catch (error) {
    // ★ The error is logError's SECOND argument and the redesign id its
    //   context (robustness audit B22): passed as one object, the context
    //   became the "error" and the log read "[object Object]" with no id.
    logError(
      "mink.revamp: runner crashed",
      loggableError(error, "database error"),
      {
        revampId,
      },
    );
    return NextResponse.json({ error: "Runner failed" }, { status: 500 });
  }
}
