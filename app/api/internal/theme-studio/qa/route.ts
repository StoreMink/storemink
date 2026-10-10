import { NextResponse } from "next/server";
import { cronAuthorized } from "../captures/auth";
import { runThemeStudioVisualQaWorker } from "@/lib/theme-studio/visual-qa";
import { startCaptureJobIfWaiting } from "@/lib/theme-studio/capture-start";
import { logError } from "@/lib/observability/logger";
import { configureWorkerImages } from "@/lib/theme-studio/worker-runtime";

// Independent schedule: a long image/model request must not hold completed
// captures in the QA queue. Existing worker QA remains a safe fallback.
// Each call also starts the capture job when a capture is waiting, which is
// what lets the job's own every-minute schedule stay paused.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!cronAuthorized(request))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const isolated = process.env.THEME_STUDIO_WORKER_ONLY === "true";
  if (isolated && process.env.THEME_STUDIO_WORKER_ROLE !== "qa")
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  configureWorkerImages();
  const captureJob = startCaptureJobIfWaiting();
  const lanes = await Promise.allSettled(
    Array.from({ length: isolated ? 1 : 2 }, () =>
      runThemeStudioVisualQaWorker({ providers: ["vertex-gemini", "fake"] }),
    ),
  );
  const failed = lanes.find((lane) => lane.status === "rejected");
  if (failed?.status === "rejected") {
    logError("theme studio: QA worker failed", failed.reason);
    await captureJob;
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    lanes: lanes.flatMap((lane) =>
      lane.status === "fulfilled" ? [lane.value] : [],
    ),
    captureJob: await captureJob,
  });
}
