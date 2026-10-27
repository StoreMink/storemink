import { NextResponse } from "next/server";
import { logError } from "@/lib/observability/logger";
import {
  MAX_CAPTURE_BYTES,
  MAX_QA_SCREENSHOT_BYTES,
  finishThemeStudioCapture,
  type CaptureFinish,
} from "@/lib/theme-studio/capture";
import { cronAuthorized } from "../auth";

// The capture job's answer (Track 3.6): the pictures it took, or an error.
//
// ★ Bound to the lease the claim issued: a job whose lease lapsed (and whose
// capture another claim now holds) is told it lost, and its pictures are
// discarded. Every picture is re-decoded, cropped and compressed server-side
// (capture.ts); the body is read with a hard ceiling before any of that.
//
// ★ A report this route refuses as invalid (a malformed picture or QA
// report, a screenshot set it cannot take) is the same on every try, so once
// the body names its lease it is answered as that try's error, which fails
// the capture at once (capture-core.ts `captureErrorKind`). Answering 400
// instead stopped the job and left the lease to lapse, and the capture was
// tried again, identically, up to five times.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

/** A preview surface name, as preview.ts names them. */
const SURFACE_RE = /^[a-z_]{1,32}$/;

/** Three JPEG shots, base64 in JSON, with room to spare. */
const MAX_BODY_BYTES =
  3 * Math.ceil((MAX_CAPTURE_BYTES * 4) / 3) +
  30 * Math.ceil((MAX_QA_SCREENSHOT_BYTES * 4) / 3) +
  6 * 1024 * 1024 +
  64 * 1024;

async function readBody(request: Request): Promise<unknown | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** Answer a settlement: 409 to a job that lost its lease, 503 if it threw. */
async function answer(
  captureId: string,
  finish: () => Promise<CaptureFinish>,
): Promise<NextResponse> {
  try {
    const result = await finish();
    return NextResponse.json(result, {
      status: result.status === "lost" ? 409 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logError("theme studio capture finish failed", error, { captureId });
    return NextResponse.json(
      { error: "The capture could not be saved." },
      { status: 503 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ captureId: string }> },
) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { captureId } = await params;
  const body = (await readBody(request)) as {
    leaseToken?: unknown;
    error?: unknown;
    failedSurface?: unknown;
    images?: unknown;
    qa?: unknown;
  } | null;
  if (!body || typeof body.leaseToken !== "string") {
    return NextResponse.json({ error: "Malformed body." }, { status: 400 });
  }
  const leaseToken = body.leaseToken;
  /** A refused report, answered as this try's error under its lease. */
  const refused = (error: string) =>
    answer(captureId, () =>
      finishThemeStudioCapture({ captureId, leaseToken, error }),
    );
  let images: { slotId: string; bytes: Uint8Array }[] | undefined;
  if (Array.isArray(body.images)) {
    images = [];
    for (const item of body.images) {
      const slotId = (item as { slotId?: unknown })?.slotId;
      const data = (item as { base64?: unknown })?.base64;
      if (typeof slotId !== "string" || typeof data !== "string") {
        return refused("capture_unusable");
      }
      images.push({
        slotId,
        bytes: new Uint8Array(Buffer.from(data, "base64")),
      });
    }
  }
  let qa:
    | {
        buildId?: string;
        packageDigest?: string;
        routes?: unknown;
        timing?: unknown;
        evidence: unknown;
        screenshots: {
          key: string;
          viewport: string;
          surface: string;
          path: string;
          bytes: Uint8Array;
        }[];
      }
    | undefined;
  if (body.qa !== undefined) {
    const raw = body.qa as {
      buildId?: unknown;
      packageDigest?: unknown;
      routes?: unknown;
      timing?: unknown;
      evidence?: unknown;
      screenshots?: unknown;
    };
    if (!raw || !Array.isArray(raw.screenshots)) {
      return refused("qa_report_invalid");
    }
    const screenshots = [];
    for (const item of raw.screenshots) {
      const shot = item as Record<string, unknown>;
      if (
        typeof shot.key !== "string" ||
        typeof shot.viewport !== "string" ||
        typeof shot.surface !== "string" ||
        typeof shot.path !== "string" ||
        typeof shot.base64 !== "string"
      ) {
        return refused("qa_screenshots_invalid");
      }
      const bytes = new Uint8Array(Buffer.from(shot.base64, "base64"));
      if (bytes.byteLength === 0) return refused("qa_screenshot_unusable");
      if (bytes.byteLength > MAX_QA_SCREENSHOT_BYTES) {
        return refused("qa_screenshot_too_large");
      }
      screenshots.push({
        key: shot.key,
        viewport: shot.viewport,
        surface: shot.surface,
        path: shot.path,
        bytes,
      });
    }
    qa = {
      buildId: typeof raw.buildId === "string" ? raw.buildId : undefined,
      packageDigest:
        typeof raw.packageDigest === "string" ? raw.packageDigest : undefined,
      routes: raw.routes,
      timing: raw.timing,
      evidence: raw.evidence,
      screenshots,
    };
  }
  // The page a status error came from (`preview_status_404` on the home
  // page, say), logged with the failed try. It does not decide how the error
  // is retried: a preview answers 404 during a short database outage too, so
  // a 4xx fails only when the next try reports it again.
  const errorSurface =
    typeof body.failedSurface === "string" &&
    SURFACE_RE.test(body.failedSurface)
      ? body.failedSurface
      : undefined;
  return answer(captureId, () =>
    finishThemeStudioCapture({
      captureId,
      leaseToken,
      images,
      qa,
      error: typeof body.error === "string" ? body.error : undefined,
      ...(errorSurface ? { errorSurface } : {}),
    }),
  );
}
