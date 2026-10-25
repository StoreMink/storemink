import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { runQa, startCaptureJob, logWaiting, settleStarts } = vi.hoisted(() => ({
  runQa: vi.fn(),
  startCaptureJob: vi.fn(),
  logWaiting: vi.fn(async () => 0),
  settleStarts: vi.fn(async () => {}),
}));
vi.mock("@/lib/theme-studio/visual-qa", () => ({
  runThemeStudioVisualQaWorker: runQa,
  logThemeStudioQaWaiting: logWaiting,
}));
vi.mock("@/lib/theme-studio/capture-start", () => ({
  startCaptureJobIfWaiting: startCaptureJob,
  settleCaptureJobStarts: settleStarts,
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
import { POST } from "./route";

const request = (token?: string) =>
  new Request("https://storemink.com/api/internal/theme-studio/qa", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secret");
  runQa.mockReset().mockResolvedValue({ claimed: 0 });
});
afterEach(() => vi.unstubAllEnvs());
describe("independent QA worker", () => {
  it("requires an exact configured bearer token", async () => {
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request("wrong"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(request("secret"))).status).toBe(401);
    expect(runQa).not.toHaveBeenCalled();
  });
  it("drains two lanes without waiting on a generation request", async () => {
    expect((await POST(request("secret"))).status).toBe(200);
    expect(runQa).toHaveBeenCalledTimes(2);
  });
  // ★ This per-minute call is what starts the capture job now; the job's own
  // every-minute schedule billed a full minute per start (capture-start.ts).
  it("starts the capture job from an authorized call only", async () => {
    startCaptureJob.mockResolvedValue("started");
    expect((await POST(request("wrong"))).status).toBe(401);
    expect(startCaptureJob).not.toHaveBeenCalled();
    const response = await POST(request("secret"));
    expect(startCaptureJob).toHaveBeenCalledOnce();
    expect((await response.json()).captureJob).toBe("started");
  });
  it("runs one QA lane per isolated request and refuses the other role", async () => {
    vi.stubEnv("THEME_STUDIO_WORKER_ONLY", "true");
    vi.stubEnv("THEME_STUDIO_WORKER_ROLE", "qa");
    expect((await POST(request("secret"))).status).toBe(200);
    expect(runQa).toHaveBeenCalledOnce();
    vi.stubEnv("THEME_STUDIO_WORKER_ROLE", "generation");
    expect((await POST(request("secret"))).status).toBe(404);
    expect(runQa).toHaveBeenCalledOnce();
  });
  it("does not abandon the other lane on failure", async () => {
    let finish!: () => void;
    runQa
      .mockRejectedValueOnce(new Error("private detail"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ claimed: 1 });
          }),
      );
    let settled = false;
    const pending = POST(request("secret")).then((response) => {
      settled = true;
      return response;
    });
    await Promise.resolve();
    expect(runQa).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    finish();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });
  // ★ TS-3A: the capture job wakes this route the moment its captures are
  // done; the count an alert watches and any capture-job start a lane's
  // settlement scheduled run inside the same request, after the lanes.
  it("counts the reviews waiting too long and waits for capture-job starts, after the lanes", async () => {
    const order: string[] = [];
    runQa.mockImplementation(async () => {
      order.push("lane");
      return { claimed: 1 };
    });
    logWaiting.mockImplementationOnce(async () => {
      order.push("waiting count");
      return 0;
    });
    settleStarts.mockImplementationOnce(async () => {
      order.push("capture starts");
    });
    expect((await POST(request("secret"))).status).toBe(200);
    expect(order).toEqual(["lane", "lane", "waiting count", "capture starts"]);
  });
  it("still answers when the count or the starts have nothing to say", async () => {
    runQa.mockRejectedValueOnce(new Error("lane failed"));
    expect((await POST(request("secret"))).status).toBe(503);
    expect(logWaiting).toHaveBeenCalledOnce();
    expect(settleStarts).toHaveBeenCalledOnce();
  });
});
