import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runRevampJob: vi.fn(async () => ({ outcome: "ready" })),
  defaultRevampDeps: vi.fn(() => ({ fake: "deps" })),
  getMinkConfig: vi.fn(() => ({ enabled: true })),
  logError: vi.fn(),
}));
vi.mock("@/lib/mink/revamp/runner", () => ({
  runRevampJob: mocks.runRevampJob,
}));
vi.mock("@/lib/mink/revamp/deps", () => ({
  defaultRevampDeps: mocks.defaultRevampDeps,
}));
vi.mock("@/lib/mink/config", () => ({ getMinkConfig: mocks.getMinkConfig }));
vi.mock("@/lib/observability/logger", () => ({ logError: mocks.logError }));

import * as route from "./route";

const ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "test-cron-secret";

function post(body: unknown, auth: string | null = `Bearer ${SECRET}`) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (auth !== null) headers.authorization = auth;
  return new Request("http://localhost/api/internal/mink/revamps/run", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let previousSecret: string | undefined;
beforeEach(() => {
  previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
});
afterEach(() => {
  if (previousSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousSecret;
});

describe("POST /api/internal/mink/revamps/run", () => {
  it("declares a long-lived Node route", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.maxDuration).toBe(1200);
    expect(route.dynamic).toBe("force-dynamic");
  });

  it.each([
    ["no header", null],
    ["a wrong secret", "Bearer nope"],
    ["a bare secret", SECRET],
  ])("refuses %s", async (_label, auth) => {
    const response = await route.POST(post({ revampId: ID }, auth));
    expect(response.status).toBe(401);
    expect(mocks.runRevampJob).not.toHaveBeenCalled();
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const response = await route.POST(post({ revampId: ID }, "Bearer "));
    expect(response.status).toBe(401);
  });

  it.each([
    ["not JSON", "{oops"],
    ["no id", {}],
    ["a malformed id", { revampId: "not-a-uuid" }],
    ["an array", [ID]],
    ["an oversized body", { revampId: ID, pad: "x".repeat(2_000) }],
  ])("refuses %s with 400", async (_label, body) => {
    const response = await route.POST(post(body));
    expect(response.status).toBe(400);
    expect(mocks.runRevampJob).not.toHaveBeenCalled();
  });

  it("claims nothing while Mink is switched off", async () => {
    mocks.getMinkConfig.mockReturnValueOnce({ enabled: false });
    const response = await route.POST(post({ revampId: ID }));
    expect(response.status).toBe(503);
    expect(mocks.runRevampJob).not.toHaveBeenCalled();
  });

  it("runs the revamp with the production deps and reports the outcome", async () => {
    mocks.runRevampJob.mockResolvedValueOnce({ outcome: "handover" });
    const response = await route.POST(post({ revampId: ID.toUpperCase() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "handover" });
    expect(mocks.runRevampJob).toHaveBeenCalledTimes(1);
    const [input] = mocks.runRevampJob.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(input).toEqual({
      revampId: ID,
      deps: { fake: "deps" },
      requestId: expect.any(String),
    });
    // Not tied to the request: the kick disconnects after five seconds.
    expect(input).not.toHaveProperty("signal");
  });

  it("★ answers 429 with a retry hint when this process is already running a revamp (jobs-1)", async () => {
    mocks.runRevampJob.mockResolvedValueOnce({ outcome: "busy" });
    const response = await route.POST(post({ revampId: ID }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({ outcome: "busy" });
  });

  it("answers 500 when the runner itself crashes", async () => {
    mocks.runRevampJob.mockRejectedValueOnce(new Error("boom"));
    const response = await route.POST(post({ revampId: ID }));
    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalled();
  });

  it("★ logs the crash with the error itself and the redesign id (B22)", async () => {
    const crash = new Error("lease lost");
    mocks.runRevampJob.mockRejectedValueOnce(crash);
    await route.POST(post({ revampId: ID }));
    // The error as logError's error argument, so it reports "lease lost" and
    // its stack, never "[object Object]"; the id in the context.
    expect(mocks.logError).toHaveBeenCalledWith(
      "mink.revamp: runner crashed",
      crash,
      { revampId: ID },
    );
  });

  it("★ a database crash is logged by the database's reason, never the query's parameters", async () => {
    // Drizzle's message carries the query and its parameters, which for a
    // redesign include the merchant's copy.
    const crash = Object.assign(
      new Error(
        'Failed query: update mink_revamps set result = $1\nparams: {"tagline":"Secret Bakery, baked daily"}',
      ),
      { cause: new Error("deadlock detected") },
    );
    mocks.runRevampJob.mockRejectedValueOnce(crash);
    await route.POST(post({ revampId: ID }));
    expect(mocks.logError).toHaveBeenCalledWith(
      "mink.revamp: runner crashed",
      "deadlock detected",
      { revampId: ID },
    );
    // An error is written out the way logError reports it.
    const logged = JSON.stringify(mocks.logError.mock.calls, (_k, v) =>
      v instanceof Error
        ? {
            message: v.message,
            cause: v.cause instanceof Error ? v.cause.message : v.cause,
          }
        : v,
    );
    expect(logged).not.toContain("Secret Bakery");
  });
});
