import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  requestStop: vi.fn(),
  stopLive: vi.fn(),
  rateAllowed: true,
  enabled: true,
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({
    enabled: holder.enabled,
    betaRequireInvite: true,
  })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/run-stop", () => ({
  requestMinkRunStop: holder.requestStop,
  stopLiveMinkRun: holder.stopLive,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.rateAllowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { POST } from "./route";
import { MinkRequestError } from "@/lib/mink/errors";
import { readMinkStopResult } from "@/lib/mink/run-stop-types";
import { logInfo } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PARAMS = { params: Promise.resolve({ runId: RUN_ID }) };

function request(
  init: {
    origin?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return new Request(
    `https://acme.storemink.com/api/mink/runs/${RUN_ID}/stop`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(init.origin ? { origin: init.origin } : {}),
        ...init.headers,
      },
      body: init.body ?? "{}",
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  holder.rateAllowed = true;
  holder.enabled = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    isSuperadmin: true,
    permissions: {},
  });
  holder.requestStop.mockResolvedValue({ outcome: "stopped" });
});

describe("POST /api/mink/runs/[runId]/stop", () => {
  it("★★ stops only the signed-in admin's own run in their own store", async () => {
    const response = await POST(
      request({ origin: "https://acme.storemink.com" }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ outcome: "stopped" });
    // The scope comes from the trusted actor, never from the request.
    expect(holder.requestStop).toHaveBeenCalledWith({
      runId: RUN_ID,
      storeId: "store-1",
      adminId: "admin-1",
    });
  });

  it("★★ stops the run at once when this instance is answering it", async () => {
    await POST(request(), PARAMS);
    expect(holder.stopLive).toHaveBeenCalledWith(RUN_ID);
  });

  it("★★ answers each outcome as the browser reads it, and stops nothing on a refusal", async () => {
    for (const answer of [
      { outcome: "acted" },
      { outcome: "finished", status: "succeeded" },
      { outcome: "finished", status: "cancelled" },
      { outcome: "finished" },
    ]) {
      holder.requestStop.mockResolvedValueOnce(answer);
      const response = await POST(request(), PARAMS);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(answer);
      expect(readMinkStopResult(body)).toEqual(answer);
    }
    // ★ A run that acted (or ended) is never aborted: its answer must land.
    expect(holder.stopLive).not.toHaveBeenCalled();
  });

  it("★★ answers 404 for a run that is not this admin's, in this store, or at all", async () => {
    holder.requestStop.mockResolvedValueOnce({ outcome: "not_found" });
    const response = await POST(request(), PARAMS);
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("outcome");
    expect(holder.stopLive).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed id before authentication or the database", async () => {
    for (const runId of ["not-a-uuid", `${RUN_ID}x`, ""]) {
      const response = await POST(request(), {
        params: Promise.resolve({ runId }),
      });
      expect(response.status).toBe(404);
    }
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.requestStop).not.toHaveBeenCalled();
  });

  it("★★ refuses a stop from another site before authentication", async () => {
    const response = await POST(
      request({ origin: "https://attacker.example" }),
      PARAMS,
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.requestStop).not.toHaveBeenCalled();
  });

  it("refuses an oversized body before authentication", async () => {
    const response = await POST(
      request({
        body: JSON.stringify({ padding: "x".repeat(1_100) }),
        headers: { "content-length": "1120" },
      }),
      PARAMS,
    );
    expect(response.status).toBe(413);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller with the actor's own answer", async () => {
    holder.actor.mockRejectedValueOnce(
      new MinkRequestError("not_signed_in", "Not signed in.", 401),
    );
    const response = await POST(request(), PARAMS);
    expect(response.status).toBe(401);
    expect(holder.requestStop).not.toHaveBeenCalled();
  });

  it("rate limits per store and admin", async () => {
    holder.rateAllowed = false;
    const response = await POST(request(), PARAMS);
    expect(response.status).toBe(429);
    expect(rateLimit).toHaveBeenCalledWith("mink-stop:store-1:admin-1", {
      max: 30,
      windowSeconds: 60,
    });
    expect(holder.requestStop).not.toHaveBeenCalled();
  });

  it("★ still stops a run while Mink is being switched off", async () => {
    holder.enabled = false;
    const response = await POST(request(), PARAMS);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "stopped" });
  });

  it("★ a failure is never read as stopped: the browser keeps the reply", async () => {
    holder.requestStop.mockRejectedValueOnce(
      new Error("connection refused at 10.0.0.1"),
    );
    const response = await POST(request(), PARAMS);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("10.0.0.1");
    expect(readMinkStopResult(body)).toEqual({ outcome: "unknown" });
    expect(holder.stopLive).not.toHaveBeenCalled();
  });

  it("logs the outcome with ids only", async () => {
    await POST(request(), PARAMS);
    expect(logInfo).toHaveBeenCalledWith("mink.stop: requested", {
      requestId: expect.any(String),
      runId: RUN_ID,
      storeId: "store-1",
      adminId: "admin-1",
      outcome: "stopped",
    });
  });
});
