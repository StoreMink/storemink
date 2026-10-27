import { NextResponse } from "next/server";
import { runMinkWorkflowWorker } from "@/lib/mink/workflows";
import { scheduleMinkWatches, reconcileMinkWatches } from "@/lib/mink/watches";
import { logError } from "@/lib/observability/logger";
import { purgeExpiredMinkMemories } from "@/lib/mink/memories";
import { reconcileMinkRunCredits } from "@/lib/mink/run-credit-reconcile";
import { getMinkConfig } from "@/lib/mink/config";
import {
  MINK_STALE_RUN_SWEEP_LIMIT,
  closeStaleMinkRuns,
} from "@/lib/mink/persistence";
import { sweepRefineStages } from "@/lib/mink/refine-stages";
import { closeStoppedMinkRuns } from "@/lib/mink/run-stop";
import { sweepStalledRevamps } from "@/lib/mink/revamp/jobs";
import { sweepThemeStudioPreviews } from "@/lib/theme-studio/preview";
import { runThemeStudioWorker } from "@/lib/theme-studio/worker";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return (
    typeof secret === "string" &&
    secret.length > 0 &&
    request.headers.get("authorization") === `Bearer ${secret}`
  );
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Independent passes: a scheduler failure must not strand manual workflows.
    let passError: unknown = null;
    let watchesQueued = 0;
    try {
      watchesQueued = await scheduleMinkWatches();
    } catch (error) {
      passError = error;
    }
    let result: Awaited<ReturnType<typeof runMinkWorkflowWorker>> | null = null;
    try {
      result = await runMinkWorkflowWorker();
    } catch (error) {
      passError ??= error;
    }
    let watchAlerts = 0;
    try {
      watchAlerts = await reconcileMinkWatches();
    } catch (error) {
      passError ??= error;
    }
    try {
      await purgeExpiredMinkMemories();
    } catch (error) {
      passError ??= error;
    }
    // ★ It rides this heartbeat rather than taking a Cloud Scheduler entry of
    //   its own: docs/cron-jobs.md records three jobs that were documented and
    //   never created, and this one is already per-minute, already Mink-scoped
    //   and already authorised. ⚠ Its own errors are swallowed inside the
    //   reconciler, so a billing sweep can never fail the workflow worker.
    let creditsSettled = 0;
    try {
      ({ settled: creditsSettled } = await reconcileMinkRunCredits(
        getMinkConfig().chargeCredits,
      ));
    } catch (error) {
      passError ??= error;
    }
    // ★ Theme Studio rides this heartbeat for the same reason the credit
    //   reconciler does: it needs a per-minute authorised backstop, and a new
    //   Scheduler entry is the kind that gets documented and never created.
    //   It is a BACKSTOP — queueing kicks the worker in-process — and it is
    //   isolated: a Studio failure must never fail merchant Mink workflows,
    //   so its error is logged and deliberately not propagated.
    let themeStudio: Awaited<ReturnType<typeof runThemeStudioWorker>> | null =
      null;
    try {
      // Offline runs and lease reaping only. Model runs take minutes and have
      // their own worker route, so they never hold this heartbeat open.
      themeStudio = await runThemeStudioWorker({
        maxRuns: 5,
        budgetMs: 15_000,
        providers: ["fake"],
      });
    } catch (error) {
      logError("mink workflow cron: theme studio pass failed", error);
    }
    // Theme Studio preview retention, isolated the same way: an idle or
    // abandoned preview store is removed; a failure waits for the next pass.
    let themeStudioPreviewsRemoved = 0;
    try {
      ({ removed: themeStudioPreviewsRemoved } =
        await sweepThemeStudioPreviews());
    } catch (error) {
      logError("mink workflow cron: theme studio preview sweep failed", error);
    }
    // ★ A chat run the merchant stopped whose instance went away before it
    //   saw the stop (a live one sees it within about two seconds): closed as
    //   cancelled with code `stopped` three minutes after the stop, through
    //   the same failure record (lib/mink/run-stop.ts). BEFORE the stale
    //   sweep, so a run that is both is recorded as the stop it was, not as
    //   abandoned. Isolated like the passes below.
    let stoppedRuns: { closed: number; failed: number } | null = null;
    try {
      stoppedRuns = await closeStoppedMinkRuns();
    } catch (error) {
      logError("mink workflow cron: stopped run sweep failed", error);
    }
    // ★ A chat run still "running" past the longest any run can live is dead
    //   (its process went away mid-answer), and it blocks deleting its chat
    //   from History for ever. Closed here as failed, through the stream
    //   route's own failure record, at most MINK_STALE_RUN_SWEEP_LIMIT a tick;
    //   a redesign it started is kept, with its card (robustness audit B7).
    //   Isolated like the passes below, so it never touches `passError`.
    let staleRuns: { closed: number; failed: number } | null = null;
    try {
      staleRuns = await closeStaleMinkRuns({
        limit: MINK_STALE_RUN_SWEEP_LIMIT,
      });
    } catch (error) {
      logError("mink workflow cron: stale run sweep failed", error);
    }
    // ★ Storefront revamps whose runner died get one kick each (at most five
    //   a tick), and ones that ran out of attempts are failed, so a merchant
    //   who closed the card still gets an answer (docs/mink-storefront-revamp.md
    //   section 4.3). Isolated like Theme Studio: a revamp failure is logged and
    //   never fails the merchant workflow worker above, which is why it does
    //   not touch `passError`.
    let revamps: { kicked: number; failed: number } | null = null;
    try {
      revamps = await sweepStalledRevamps(5);
    } catch (error) {
      logError("mink workflow cron: revamp sweep failed", error);
    }
    // ★ Refine with Mink AI stages (lib/mink/refine-stages.ts): a paid refined
    //   photo whose publish failed is published from its private stage, and a
    //   stage nobody paid for is deleted, five minutes after it was written,
    //   only this database's. Isolated like the passes above: a failure is
    //   logged and never fails the heartbeat. ★ LAST: the only pass that waits
    //   on storage (ten seconds at most), so a storage stall never delays the
    //   database backstops above.
    let refineStages: {
      published: number;
      deleted: number;
      failed: number;
    } | null = null;
    try {
      refineStages = await sweepRefineStages();
    } catch (error) {
      logError("mink workflow cron: refine stage sweep failed", error);
    }
    if (passError) throw passError;
    if (!result) throw new Error("Workflow heartbeat returned no result.");
    return NextResponse.json({
      ok: result.workflowsFailed === 0,
      ...result,
      watchesQueued,
      watchAlerts,
      creditsSettled,
      themeStudio,
      themeStudioPreviewsRemoved,
      stoppedRuns,
      refineStages,
      staleRuns,
      revamps,
    });
  } catch (error) {
    // 503, not an unhandled 500, so Cloud Scheduler's retries engage — the
    // same contract prune-logs and seo-refresh answer on a failed pass. A
    // workflow that failed its own retries is still a 200 with `ok: false`:
    // that is the queue working, not an outage.
    logError("mink workflow cron: heartbeat failed", error);
    return NextResponse.json(
      { ok: false, error: "Mink workflow heartbeat failed." },
      { status: 503 },
    );
  }
}

export const GET = handle;
export const POST = handle;
