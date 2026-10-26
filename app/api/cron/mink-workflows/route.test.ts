import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runWorker = vi.fn();
const schedule = vi.fn();
const reconcile = vi.fn();
vi.mock("@/lib/mink/memories", () => ({
  purgeExpiredMinkMemories: vi.fn(async () => ({ rows: [] })),
}));
vi.mock("@/lib/mink/watches", () => ({
  scheduleMinkWatches: schedule,
  reconcileMinkWatches: reconcile,
}));

vi.mock("@/lib/mink/workflows", () => ({
  runMinkWorkflowWorker: runWorker,
}));
const runStudio = vi.fn();
vi.mock("@/lib/theme-studio/worker", () => ({
  runThemeStudioWorker: runStudio,
}));
const sweepRevamps = vi.fn();
vi.mock("@/lib/mink/revamp/jobs", () => ({
  sweepStalledRevamps: sweepRevamps,
}));
const closeStale = vi.fn();
vi.mock("@/lib/mink/persistence", () => ({
  MINK_STALE_RUN_SWEEP_LIMIT: 20,
  closeStaleMinkRuns: closeStale,
}));
const closeStopped = vi.fn();
vi.mock("@/lib/mink/run-stop", () => ({
  closeStoppedMinkRuns: closeStopped,
}));
const sweepStages = vi.fn();
vi.mock("@/lib/mink/refine-stages", () => ({
  sweepRefineStages: sweepStages,
}));

describe("Mink workflow cron", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    schedule.mockReset().mockResolvedValue(0);
    reconcile.mockReset().mockResolvedValue(0);
    sweepRevamps.mockReset().mockResolvedValue({ kicked: 1, failed: 0 });
    closeStale.mockReset().mockResolvedValue({ closed: 2, failed: 0 });
    closeStopped.mockReset().mockResolvedValue({ closed: 1, failed: 0 });
    sweepStages
      .mockReset()
      .mockResolvedValue({ published: 1, deleted: 2, failed: 0 });
    runStudio.mockReset().mockResolvedValue({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      requeued: 0,
      reaped: 0,
    });
    runWorker.mockReset().mockResolvedValue({
      claims: 3,
      stepsCompleted: 3,
      workflowsCompleted: 1,
      workflowsCancelled: 0,
      retriesScheduled: 0,
      workflowsFailed: 0,
      notificationsDelivered: 1,
    });
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("fails closed without the exact cron bearer token", async () => {
    const { GET, POST } = await import("./route");
    const missing = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows"),
    );
    const wrong = await POST(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(runWorker).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("answers 503 rather than an unhandled 500 when the heartbeat throws", async () => {
    // ★ THE CRON CONTRACT prune-logs and seo-refresh already follow: a thrown
    // pass is 503 so Cloud Scheduler's retries engage. A workflow that
    // exhausted its OWN retries is still 200 with ok:false — that is the queue
    // working, not an outage.
    runWorker.mockRejectedValueOnce(new Error("connection terminated"));
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        method: "POST",
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(503);
    expect(reconcile).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("reports a workflow that exhausted its own retries as 200, not an outage", async () => {
    runWorker.mockResolvedValueOnce({
      claims: 1,
      stepsCompleted: 0,
      workflowsCompleted: 0,
      workflowsCancelled: 0,
      retriesScheduled: 0,
      workflowsFailed: 1,
      notificationsDelivered: 0,
    });
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("runs one bounded heartbeat for either supported cron method", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      claims: 3,
      workflowsCompleted: 1,
      notificationsDelivered: 1,
    });
    expect(runWorker).toHaveBeenCalledTimes(1);
  });
  it("still runs manual workflows and delivery after a watch scheduling failure", async () => {
    schedule.mockRejectedValueOnce(new Error("watch scheduler unavailable"));
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(503);
    expect(runWorker).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("drains Theme Studio runs, and a Studio failure never fails Mink", async () => {
    const { GET } = await import("./route");
    const request = () =>
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      });
    const ok = await GET(request());
    expect(ok.status).toBe(200);
    expect(runStudio).toHaveBeenCalledTimes(1);
    // A paid model run can take many minutes; it must never execute on this
    // shared per-minute heartbeat, only on the dedicated worker route.
    expect(runStudio.mock.calls[0][0].providers).toEqual(["fake"]);
    expect((await ok.json()).themeStudio).toMatchObject({ succeeded: 1 });

    runStudio.mockRejectedValueOnce(new Error("studio down"));
    const isolated = await GET(request());
    expect(isolated.status).toBe(200);
    expect(runWorker).toHaveBeenCalledTimes(2);
  });

  it("sweeps stalled storefront revamps, at most five a tick", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(sweepRevamps).toHaveBeenCalledWith(5);
    expect((await response.json()).revamps).toEqual({ kicked: 1, failed: 0 });
  });

  it("★ a revamp sweep failure is logged and never fails merchant workflows", async () => {
    sweepRevamps.mockRejectedValueOnce(new Error("revamp sweep down"));
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(runWorker).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.revamps).toBeNull();
  });

  it("★ B7: closes chat runs a dead server left running, at most twenty a tick", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(closeStale).toHaveBeenCalledTimes(1);
    expect(closeStale).toHaveBeenCalledWith({ limit: 20 });
    expect((await response.json()).staleRuns).toEqual({ closed: 2, failed: 0 });
  });

  it("★ a stale-run sweep failure is logged and never fails merchant workflows", async () => {
    closeStale.mockRejectedValueOnce(new Error("stale sweep down"));
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(runWorker).toHaveBeenCalledOnce();
    expect(sweepRevamps).toHaveBeenCalledWith(5);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.staleRuns).toBeNull();
  });

  it("★ closes chat runs the merchant stopped whose server went away, before the stale sweep", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(closeStopped).toHaveBeenCalledTimes(1);
    // A run both stopped and stale is recorded as the stop it was.
    expect(closeStopped.mock.invocationCallOrder[0]).toBeLessThan(
      closeStale.mock.invocationCallOrder[0],
    );
    expect((await response.json()).stoppedRuns).toEqual({
      closed: 1,
      failed: 0,
    });
  });

  it("★ a stopped-run sweep failure is logged and never fails merchant workflows", async () => {
    closeStopped.mockRejectedValueOnce(new Error("stopped sweep down"));
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(runWorker).toHaveBeenCalledOnce();
    expect(closeStale).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.stoppedRuns).toBeNull();
    expect(body.staleRuns).toEqual({ closed: 2, failed: 0 });
  });

  it("★ publishes or clears Refine stages, and reports them", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(sweepStages).toHaveBeenCalledTimes(1);
    expect((await response.json()).refineStages).toEqual({
      published: 1,
      deleted: 2,
      failed: 0,
    });
    // ★ LAST: the only pass that waits on storage, so a storage stall never
    //   delays the database backstops.
    for (const pass of [runStudio, closeStopped, closeStale, sweepRevamps]) {
      expect(pass.mock.invocationCallOrder[0]).toBeLessThan(
        sweepStages.mock.invocationCallOrder[0],
      );
    }
  });

  it("★ a Refine stage sweep failure is logged and never fails merchant workflows", async () => {
    sweepStages.mockRejectedValueOnce(new Error("bucket unreachable"));
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(runWorker).toHaveBeenCalledOnce();
    expect(closeStale).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.refineStages).toBeNull();
    expect(body.staleRuns).toEqual({ closed: 2, failed: 0 });
  });

  it("is not reached without the cron bearer token", async () => {
    const { GET } = await import("./route");
    await GET(new Request("https://storemink.com/api/cron/mink-workflows"));
    expect(sweepRevamps).not.toHaveBeenCalled();
    expect(closeStale).not.toHaveBeenCalled();
    expect(closeStopped).not.toHaveBeenCalled();
    expect(sweepStages).not.toHaveBeenCalled();
  });
});
