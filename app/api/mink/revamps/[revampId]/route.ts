import { after, NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import {
  cancelRevamp,
  kickRevampIfStalled,
  readRevampStatus,
} from "@/lib/mink/revamp/jobs";
import { publishRevamp, undoRevamp } from "@/lib/mink/revamp/publish";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// One storefront revamp for its requester (docs/mink-storefront-revamp.md
// section 3): the card polls GET every few seconds while the store is being
// rebuilt, and POSTs the merchant's clicks.
//
// ★ THE POLL KEEPS THE JOB MOVING. Nothing schedules the runner on dev (owner's
//   rule), so a GET for a job that is waiting with nobody working on it kicks
//   the runner, after the response, at most once per cooldown per job (the
//   cooldown is claimed in the database, so ten open tabs send one kick).
//
// ★ Same boundary as the personalisation route: same-origin, a UUID before any
//   session is read, a bounded JSON body, per-actor rate limits, Mink's global
//   switch, private no-store JSON, and logs that name codes, never content.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1_024;

/**
 * The actions the card may post: stop a running redesign, publish an applied
 * one, or undo it. ★ None of them takes any other field: which pages, which
 * store and whose redesign all come from the server, never the body.
 * Anything not listed is a 400.
 */
const REVAMP_ACTIONS = ["cancel", "publish", "undo"] as const;
type RevampAction = (typeof REVAMP_ACTIONS)[number];
type RevampMutation = { action: RevampAction };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ revampId: string }> },
) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const { revampId } = await params;
  if (!UUID_PATTERN.test(revampId)) {
    return privateJson({ error: "Invalid Mink AI redesign." }, 400);
  }
  const config = getMinkConfig();
  if (!config.enabled) {
    return privateJson({ error: "Mink AI is not enabled." }, 404);
  }
  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-revamp-read:${actor.storeId}:${actor.adminId}`,
      { max: 120, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return privateJson(
        { error: "Mink AI redesigns are receiving too many requests." },
        429,
      );
    }
    const revamp = await readRevampStatus(actor, revampId);
    if (!revamp) {
      return privateJson({ error: "That redesign is not available." }, 404);
    }
    if (revamp.status === "queued" || revamp.status === "running") {
      // After the response: the kick may wait up to five seconds for the
      // runner to accept, and a poll must answer at once.
      after(async () => {
        await kickRevampIfStalled(revampId);
      });
    }
    return privateJson({ revamp });
  } catch (error) {
    return failure(error, { requestId, revampId, operation: "read" });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ revampId: string }> },
) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const { revampId } = await params;
  if (!UUID_PATTERN.test(revampId)) {
    return privateJson({ error: "Invalid Mink AI redesign." }, 400);
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return privateJson(
      { error: "Mink AI redesign request is too large." },
      413,
    );
  }
  let mutation: RevampMutation;
  try {
    mutation = readMutation(await readBoundedJson(request));
  } catch (error) {
    return privateJson(
      {
        error:
          error instanceof BodyTooLargeError
            ? "Mink AI redesign request is too large."
            : error instanceof SyntaxError
              ? error.message
              : "Invalid Mink AI redesign request.",
      },
      error instanceof BodyTooLargeError ? 413 : 400,
    );
  }
  const config = getMinkConfig();
  if (!config.enabled) {
    return privateJson({ error: "Mink AI is not enabled." }, 404);
  }
  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-revamp-action:${actor.storeId}:${actor.adminId}`,
      { max: 10, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return privateJson(
        { error: "Mink AI redesigns are receiving too many requests." },
        429,
      );
    }
    switch (mutation.action) {
      case "cancel": {
        const revamp = await cancelRevamp(actor, revampId);
        if (!revamp) {
          return privateJson({ error: "That redesign is not available." }, 404);
        }
        return privateJson({ revamp });
      }
      // ★ Both are idempotent: a second click answers with the first result.
      case "publish": {
        const result = await publishRevamp(actor, revampId);
        return privateJson({ result });
      }
      case "undo": {
        const result = await undoRevamp(actor, revampId);
        return privateJson({ result });
      }
      default:
        return privateJson({ error: "Unknown Mink AI redesign action." }, 400);
    }
  } catch (error) {
    return failure(error, {
      requestId,
      revampId,
      operation: mutation.action,
    });
  }
}

function failure(
  error: unknown,
  context: { requestId: string; revampId: string; operation: string },
) {
  if (error instanceof MinkRequestError) {
    logWarn("mink.revamp: request rejected", {
      ...context,
      code: error.code,
      status: error.status,
    });
    return privateJson(
      { error: error.message, code: error.code },
      error.status,
    );
  }
  logError("mink.revamp: request failed", error, context);
  return privateJson(
    {
      error:
        context.operation === "read"
          ? "Mink AI couldn't load that redesign."
          : "Mink AI couldn't update that redesign.",
    },
    503,
  );
}

function readMutation(value: unknown): RevampMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Mink AI redesign request must be a JSON object.");
  }
  const row = value as Record<string, unknown>;
  // ★ The TYPE before the allowlist, and the value checked is the one returned:
  //   `["cancel"]` stringifies to "cancel", and the workflow route once ran
  //   the wrong branch for exactly that body.
  const action = row.action;
  if (typeof action !== "string" || !isRevampAction(action)) {
    throw new SyntaxError("Unknown Mink AI redesign action.");
  }
  assertOnlyKeys(row, ["action"]);
  return { action };
}

function isRevampAction(value: string): value is RevampAction {
  return (REVAMP_ACTIONS as readonly string[]).includes(value);
}

function assertOnlyKeys(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some((key) => !allowed.includes(key))) {
    throw new SyntaxError("Mink AI redesign request has unsupported fields.");
  }
}

class BodyTooLargeError extends Error {}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body)
    throw new SyntaxError("Mink AI redesign request is empty.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  try {
    return JSON.parse(body);
  } catch {
    throw new SyntaxError("Mink AI redesign request is not valid JSON.");
  }
}

function privateJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
