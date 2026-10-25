import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { readThemeStudioCheckScreenshot } from "@/lib/theme-studio/progress";
import { isUuid } from "@/lib/theme-studio/repository";

// One check screenshot's bytes (owner-approved, 24 Oct 2026; wave TS-2
// contract section 5), for the Checks tab's "What the checks saw".
// GET /api/platform/theme-studio/projects/[projectId]/check-screenshots/[assetId]
//
// ★ Superadmin only, exactly like the progress route, answered in plain
// text: no session 401, not a superadmin 403. Then the asset must be a
// check screenshot (purpose `qa_screenshot`) of THIS project: a theme
// picture, a reference (someone else's website), another project's file or
// an unknown id all answer 404 "Not found", the same as a malformed id.
// ★ The bytes are the stored WebP (or PNG for a page taller than 16,383 px,
// visual-evidence.ts), sent with their stored type and the reference
// route's lock-down headers: private, never cached, not sniffed, rendered
// as nothing but an image, same-origin only, never indexed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAIN = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "private, no-store",
};

function plain(text: string, status: number) {
  return new Response(text, { status, headers: PLAIN });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; assetId: string }> },
) {
  if (!(await getServerUser())) {
    return plain("Your session has ended. Sign in again.", 401);
  }
  if (!(await getThemeStudioActor())) {
    return plain("Only a platform superadmin can use Theme Studio.", 403);
  }
  const { projectId, assetId } = await params;
  if (!isUuid(projectId) || !isUuid(assetId)) return plain("Not found", 404);
  let file;
  try {
    file = await withService((db) =>
      readThemeStudioCheckScreenshot(db, { projectId, assetId }),
    );
  } catch (error) {
    logError("theme studio: check screenshot read failed", error, {
      projectId,
      assetId,
    });
    return plain("The screenshot could not be read. Try again.", 500);
  }
  if (!file) return plain("Not found", 404);
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Robots-Tag": "noindex",
    },
  });
}
