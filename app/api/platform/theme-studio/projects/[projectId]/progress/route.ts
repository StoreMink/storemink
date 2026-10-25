import { NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { readThemeStudioProgress } from "@/lib/theme-studio/progress";
import { isUuid } from "@/lib/theme-studio/repository";

// One theme's progress, polled by the theme page (wave TS-2; plan section 4
// "Progress without slowing your clicks"; contract section 5):
// GET /api/platform/theme-studio/projects/[projectId]/progress answers
// ThemeStudioProgress, unwrapped.
//
// ★ A ROUTE, NOT A SERVER ACTION: Next.js runs server actions one at a time
// per browser, so a poll in flight would hold back Publish, Send and Stop.
// The page asks every 3 s while a theme works (use-studio-progress.ts,
// through lib/pos/use-poll.ts), slower while nothing changes.
//
// ★ /api is outside proxy.ts, so this route is its own gate, in this order:
// no session 401 (the page tells the operator to sign in again), a
// signed-in user who is not a superadmin 403, a malformed or unknown theme
// 404. The read runs only after the first two, inside one service
// transaction, and reads narrow columns only (lib/theme-studio/progress.ts):
// never picture bytes, whole model answers or the theme file. Never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
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
  const { projectId } = await params;
  if (!isUuid(projectId)) {
    return json({ error: "That theme no longer exists." }, 404);
  }
  try {
    const progress = await withService((db) =>
      readThemeStudioProgress(db, { projectId }),
    );
    if (!progress) {
      return json({ error: "That theme no longer exists." }, 404);
    }
    return json(progress, 200);
  } catch (error) {
    logError("theme studio: progress read failed", error, { projectId });
    return json(
      { error: "This theme's progress could not be read. Try again." },
      500,
    );
  }
}
