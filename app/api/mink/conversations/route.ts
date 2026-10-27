import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { listMinkConversations } from "@/lib/mink/conversation-history";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * One page of the viewer's chats: no parameter is the first page, `?cursor=`
 * the next one (an opaque position, never the merchant's words). ★ Search is
 * POST /api/mink/conversations/search, so search words never reach a request
 * log; any `q` here is ignored.
 */
export async function GET(request: Request) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }

  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-history:${actor.storeId}:${actor.adminId}`,
      { max: 60, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink AI history is receiving too many requests." },
        { status: 429 },
      );
    }
    const cursor = new URL(request.url).searchParams.get("cursor");
    const page = await listMinkConversations(actor, { cursor });
    return NextResponse.json(page, {
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.history: request rejected", {
        requestId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    logError("mink.history: list failed", error, { requestId });
    return NextResponse.json(
      { error: "Mink AI couldn't load recent conversations." },
      { status: 503 },
    );
  }
}
