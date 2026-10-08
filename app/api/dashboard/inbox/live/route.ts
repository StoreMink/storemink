// Everything the inbox polls to stay fresh, over ONE authenticated GET.
//
// ★ A ROUTE, NOT A SERVER ACTION — the /api/pos/live rule. Next dispatches
// Server Actions one at a time per client, so a ten-second list refresh in
// flight would sit in front of the staff member's Send. Reads only.
//
// Each branch delegates to the action, which owns the permission gate and the
// store scope; the route adds only the no-store headers and the status codes
// a poller expects (401 signed out, 503 transient).

import { NextResponse, type NextRequest } from "next/server";
import { getViewerContext } from "@/app/dashboard/lib/access";
import {
  getInboxConversations,
  getInboxNeedsReplyCount,
  getInboxThread,
} from "@/app/actions/inbox-actions";
import type { InboxFilter } from "@/lib/whatsapp/inbox-types";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const need = params.get("need");
  try {
    // A signed-out poll gets a 401 it can act on, not the login page's HTML
    // (the action gate would redirect, which a fetch follows and cannot parse).
    const ctx = await getViewerContext();
    if (!ctx) {
      return NextResponse.json(
        { error: "signed-out" },
        { status: 401, headers: NO_STORE },
      );
    }
    switch (need) {
      case "count": {
        const res = await getInboxNeedsReplyCount();
        return respond(res, res.error);
      }
      case "list": {
        const filter = params.get("filter") ?? "all";
        const res = await getInboxConversations({
          filter: filter as InboxFilter,
          q: params.get("q") ?? "",
          page: Number(params.get("page") ?? "1") || 1,
        });
        return respond(res, res.error);
      }
      case "thread": {
        const res = await getInboxThread(params.get("id") ?? "");
        return respond(res, res.error);
      }
      default:
        return NextResponse.json(
          { error: "unknown need" },
          { status: 400, headers: NO_STORE },
        );
    }
  } catch {
    return NextResponse.json(
      { error: "unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
}

function respond(body: unknown, error: string | undefined) {
  const status = error?.startsWith("You don't have permission")
    ? 403
    : error === "unavailable"
      ? 503
      : 200;
  return NextResponse.json(body, { status, headers: NO_STORE });
}
