import { NextResponse } from "next/server";
import { after } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { purgeStoreMinkAttachments } from "@/lib/mink/attachments";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import {
  deleteMinkConversation,
  getMinkConversation,
  listMinkConversations,
} from "@/lib/mink/conversation-history";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * One of the viewer's chats, newest 50 messages, or the 50 before `?before=`
 * (an opaque position from `earlierCursor`). ★ Opening a chat is using it:
 * this keeps it 90 days from now (conversation-history.ts, at most hourly).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }

  const { conversationId } = await params;
  if (!UUID_PATTERN.test(conversationId)) {
    return NextResponse.json(
      { error: "Invalid Mink AI conversation." },
      { status: 400 },
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
    const before = new URL(request.url).searchParams.get("before");
    const conversation = await getMinkConversation(actor, conversationId, {
      before,
    });
    return NextResponse.json(
      { conversation },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.history: conversation rejected", {
        requestId,
        conversationId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    logError("mink.history: conversation failed", error, {
      requestId,
      conversationId,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't load that conversation." },
      { status: 503 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }

  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;

  const { conversationId } = await params;
  if (!UUID_PATTERN.test(conversationId)) {
    return NextResponse.json(
      { error: "Invalid Mink AI conversation." },
      { status: 400 },
    );
  }

  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-history-write:${actor.storeId}:${actor.adminId}`,
      { max: 20, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink AI history is receiving too many requests." },
        { status: 429 },
      );
    }
    await deleteMinkConversation(actor, conversationId);
    // ★ The chat's attached pictures were marked for deletion in the retiring
    //   transaction (conversation-retire.ts); their objects go once the
    //   response is out, best effort (Cloud Run throttles the CPU after the
    //   response), and the nightly purge is the guarantee. The store's purge
    //   runs full batches until one is short (at most 5, none started after
    //   10 seconds: review R10), so a chat with more pictures than one batch,
    //   or a store with older marks waiting, still loses this chat's pictures
    //   now; after the delete the rows carry no chat id, so the purge cannot
    //   be aimed at them. A refused delete threw above, so nothing is
    //   scheduled for it. purgeStoreMinkAttachments never throws (it logs).
    after(() => purgeStoreMinkAttachments(actor.storeId));
    // ★ The first page, for a browser still running the previous bundle,
    //   which replaces its list with it. The current client removes the chat
    //   itself and ignores this; drop it in a later release.
    const page = await listMinkConversations(actor);
    return NextResponse.json(page, {
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.history: deletion rejected", {
        requestId,
        conversationId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    logError("mink.history: deletion failed", error, {
      requestId,
      conversationId,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't delete that conversation." },
      { status: 503 },
    );
  }
}
