import { NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import {
  THEME_STUDIO_LIST_FILTERS,
  listThemeStudioProjectsForConsole,
  type ThemeStudioListFilter,
} from "@/lib/theme-studio/progress";

// The Theme Studio list, as JSON (wave TS-2; contract section 5):
// GET /api/platform/theme-studio/projects?filter=<all|needs_you|building|ready|live|archived>
// answers ThemeStudioList, the rows of one filter and every filter's count.
//
// ★ /api is outside proxy.ts, so this route is its own gate, in this order:
// no session 401, a signed-in user who is not a superadmin (a platform
// member included) 403, an unknown filter 400. The read runs only after
// both. Never cached: every answer is `no-store` and the route is dynamic.
// Logs name the filter and codes, never a theme's name or brief.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  if (rejectForeignMinkOrigin(request)) {
    return json({ error: "Requests from another site are not allowed." }, 403);
  }
  if (!(await getServerUser())) {
    return json({ error: "Your session has ended. Sign in again." }, 401);
  }
  if (!(await getThemeStudioActor())) {
    return json(
      { error: "Only a platform superadmin can use Theme Studio." },
      403,
    );
  }
  const asked = new URL(request.url).searchParams.get("filter") ?? "all";
  if (!(THEME_STUDIO_LIST_FILTERS as readonly string[]).includes(asked)) {
    return json({ error: "Unknown filter." }, 400);
  }
  const filter = asked as ThemeStudioListFilter;
  try {
    const list = await withService((db) =>
      listThemeStudioProjectsForConsole(db, { filter }),
    );
    return json(list, 200);
  } catch (error) {
    logError("theme studio: list read failed", error, { filter });
    return json(
      { error: "The Theme Studio list could not be read. Try again." },
      500,
    );
  }
}
