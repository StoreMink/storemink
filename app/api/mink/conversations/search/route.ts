import { NextResponse } from "next/server";
import { pgErrorCode } from "@/lib/db/errors";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { getMinkConfig } from "@/lib/mink/config";
import { searchMinkConversations } from "@/lib/mink/conversation-history";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { normaliseSearchQuery } from "@/lib/search/prefix-search";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// ★★ SEARCH IS A POST, SO THE MERCHANT'S WORDS NEVER REACH A REQUEST LOG.
// Cloud Run's request logs keep the full URL, query string included, and a
// History search is often a customer's name or phone number. The words travel
// in the body; nothing here logs them (request id and codes only).
// ---------------------------------------------------------------------------

/** The largest body a search may send. */
const MAX_BODY_BYTES = 2048;
/** Postgres `query_canceled`: the search outran its statement timeout. */
const STATEMENT_TIMEOUT = "57014";

const INVALID_SEARCH = "Type what to search for.";

export async function POST(request: Request) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }

  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;

  const body = await readSearch(request);
  if (!body) {
    return NextResponse.json(
      { error: INVALID_SEARCH, code: "invalid_search" },
      { status: 400 },
    );
  }

  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    // ★ Its own bucket, so a merchant searching hard can still open the chat
    //   they found (the list and the chat share `mink-history:`).
    const limited = await rateLimit(
      `mink-history-search:${actor.storeId}:${actor.adminId}`,
      { max: 60, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink AI history is receiving too many requests." },
        { status: 429 },
      );
    }
    const page = await searchMinkConversations(actor, {
      query: body.q,
      cursor: body.cursor,
    });
    return NextResponse.json(page, {
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.history: search rejected", {
        requestId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    const code = pgErrorCode(error) ?? null;
    if (code === STATEMENT_TIMEOUT) {
      logWarn("mink.history: search timed out", { requestId });
      return NextResponse.json(
        {
          error: "Searching your chats took too long. Try a longer word.",
          code: "history_search_timeout",
        },
        { status: 503 },
      );
    }
    // ★ Codes only: a failed query's message can carry its parameters, which
    //   are the merchant's search words.
    logError("mink.history: search failed", undefined, {
      requestId,
      code,
      name: error instanceof Error ? error.name : null,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't search your chats." },
      { status: 503 },
    );
  }
}

/**
 * `{ q, cursor? }`, at most 2 KB: the typed text trimmed, its runs of spaces
 * collapsed and cut to 80 characters. Null for anything else.
 * ★ Read as a stream that stops at 2 KB (lib/mink/bounded-json.ts): this runs
 *   before the merchant is known, and a body with no Content-Length (a
 *   chunked one) would otherwise be read whole before its size was checked.
 */
async function readSearch(
  request: Request,
): Promise<{ q: string; cursor: string | null } | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let value: Record<string, unknown>;
  try {
    value = await readMinkBoundedJson(request, MAX_BODY_BYTES);
  } catch {
    return null;
  }
  const { q, cursor } = value;
  if (typeof q !== "string") return null;
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string")
    return null;
  return { q: normaliseSearchQuery(q), cursor: cursor ?? null };
}
