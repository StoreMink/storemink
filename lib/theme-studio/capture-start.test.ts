/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  where: null as unknown,
  allowed: true,
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (run: (db: unknown) => unknown) =>
    run({
      select: () => ({
        from: () => ({
          where: (cond: unknown) => {
            state.where = cond;
            return { limit: async () => state.rows };
          },
        }),
      }),
    }),
  ),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: state.allowed })),
}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function (this: any) {
    this.getClient = async () => ({
      getAccessToken: async () => ({ token: "access-token" }),
    });
  }),
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import { rateLimit } from "@/lib/rate-limit";
import { logInfo, logWarn } from "@/lib/observability/logger";
import { captureJobTarget, startCaptureJobIfWaiting } from "./capture-start";

const PROD: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  GCP_PROJECT_ID: "storemink-prod",
  K_SERVICE: "storemink-web-prod",
  THEME_STUDIO_CAPTURE_ENABLED: "true",
};

const fetchMock = vi.fn();

beforeEach(() => {
  state.rows = [];
  state.where = null;
  state.allowed = true;
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("captureJobTarget", () => {
  it("derives the job from the service, as cloudbuild.yaml does", () => {
    expect(captureJobTarget(PROD)).toEqual({
      project: "storemink-prod",
      region: "asia-south1",
      job: "storemink-theme-studio-capture",
    });
    expect(
      captureJobTarget({ ...PROD, K_SERVICE: "storemink-web-dev" })?.job,
    ).toBe("storemink-theme-studio-capture-dev");
    // The private workers copy the web env and are named per environment.
    expect(
      captureJobTarget({ ...PROD, K_SERVICE: "storemink-theme-studio-qa-prod" })
        ?.job,
    ).toBe("storemink-theme-studio-capture");
    expect(
      captureJobTarget({
        ...PROD,
        K_SERVICE: "storemink-theme-studio-model-dev",
      })?.job,
    ).toBe("storemink-theme-studio-capture-dev");
  });

  it("has no job off Cloud Run, for other services, or without a project", () => {
    expect(captureJobTarget({ ...PROD, K_SERVICE: undefined })).toBeNull();
    expect(
      captureJobTarget({ ...PROD, K_SERVICE: "storemink-web" }),
    ).toBeNull();
    expect(captureJobTarget({ ...PROD, GCP_PROJECT_ID: "" })).toBeNull();
  });

  it("takes an explicit job and region, but only well-formed names", () => {
    expect(
      captureJobTarget({
        ...PROD,
        THEME_STUDIO_CAPTURE_JOB: "other-job",
        THEME_STUDIO_CAPTURE_REGION: "us-central1",
      }),
    ).toEqual({
      project: "storemink-prod",
      region: "us-central1",
      job: "other-job",
    });
    expect(
      captureJobTarget({ ...PROD, THEME_STUDIO_CAPTURE_JOB: "a/../b" }),
    ).toBeNull();
  });
});

describe("startCaptureJobIfWaiting", () => {
  it("★ starts nothing while no capture waits, which is almost always", async () => {
    expect(await startCaptureJobIfWaiting(PROD)).toBe("idle");
    expect(rateLimit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("★ starts the job through the Admin API when a capture waits", async () => {
    state.rows = [{ id: "capture-1" }];
    expect(await startCaptureJobIfWaiting(PROD)).toBe("started");
    expect(rateLimit).toHaveBeenCalledWith(
      "theme-studio:capture-start:storemink-theme-studio-capture",
      { max: 1, windowSeconds: 90 },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://run.googleapis.com/v2/projects/storemink-prod/locations/asia-south1/jobs/storemink-theme-studio-capture:run",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer access-token",
        }),
      }),
    );
    expect(logInfo).toHaveBeenCalledWith("theme_studio.capture_job_started", {
      job: "storemink-theme-studio-capture",
    });
  });

  it("asks the claim's own question: queued, or running on a lapsed lease", async () => {
    await startCaptureJobIfWaiting(PROD);
    const { sql } = new PgDialect().sqlToQuery(state.where as any);
    expect(sql).toMatch(/"status" = 'queued'/);
    expect(sql).toMatch(/"status" = 'running'/);
    expect(sql).toMatch(/"lease_expires_at" <= now\(\)/);
    // A long-stuck capture stops starting the job.
    expect(sql).toMatch(/"created_at" > now\(\) -/);
  });

  it("starts once per window while the job boots", async () => {
    state.rows = [{ id: "capture-1" }];
    state.allowed = false;
    expect(await startCaptureJobIfWaiting(PROD)).toBe("throttled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing off Cloud Run or with capture switched off", async () => {
    state.rows = [{ id: "capture-1" }];
    expect(
      await startCaptureJobIfWaiting({ ...PROD, K_SERVICE: undefined }),
    ).toBe("unconfigured");
    expect(
      await startCaptureJobIfWaiting({
        ...PROD,
        THEME_STUDIO_CAPTURE_ENABLED: "false",
      }),
    ).toBe("unconfigured");
    expect(withService).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a refused start and never throws into the worker", async () => {
    state.rows = [{ id: "capture-1" }];
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    expect(await startCaptureJobIfWaiting(PROD)).toBe("failed");
    expect(logWarn).toHaveBeenCalledWith(
      "theme_studio.capture_job_start_failed",
      { job: "storemink-theme-studio-capture", status: 403 },
    );
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await startCaptureJobIfWaiting(PROD)).toBe("failed");
    vi.mocked(withService).mockRejectedValueOnce(new Error("db down"));
    expect(await startCaptureJobIfWaiting(PROD)).toBe("failed");
  });
});
