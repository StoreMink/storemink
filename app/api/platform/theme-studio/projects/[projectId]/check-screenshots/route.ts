import { NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { listThemeStudioCheckScreenshots } from "@/lib/theme-studio/progress";
import { isUuid } from "@/lib/theme-studio/repository";

// What a design's newest final check saw (owner-approved, 24 Oct 2026; wave
// TS-2 contract section 5): the screenshots by page and width, and what was
// really measured, so the operator can see by eye that the theme is
// responsive, phone-friendly and accurate.
// GET /api/platform/theme-studio/projects/[projectId]/check-screenshots?versionId=<uuid>
// answers ThemeStudioCheckScreenshots, unwrapped; no `versionId` means the
// current design.
//
// ★ Superadmin only, exactly like the progress route: no session 401, not a
// superadmin 403, a malformed or unknown theme, or a design that is not an
// operator-visible version of it, 404; a malformed `versionId` 400. It
// lists the screenshots' ids and sizes only: their bytes come one at a
// time from check-screenshots/[assetId]. Private and never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: PRIVATE });
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
  const asked = new URL(request.url).searchParams.get("versionId");
  if (asked !== null && !isUuid(asked)) {
    return json({ error: "Unknown design." }, 400);
  }
  try {
    const screenshots = await withService((db) =>
      listThemeStudioCheckScreenshots(db, {
        projectId,
        versionId: asked,
      }),
    );
    if (!screenshots) {
      return json(
        {
          error: asked
            ? "That design is not part of this theme."
            : "That theme no longer exists.",
        },
        404,
      );
    }
    return json(screenshots, 200);
  } catch (error) {
    logError("theme studio: check screenshots read failed", error, {
      projectId,
      versionId: asked,
    });
    return json(
      { error: "The check screenshots could not be read. Try again." },
      500,
    );
  }
}
