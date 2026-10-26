import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  viewer: vi.fn(),
  requestStop: vi.fn(),
  stopLive: vi.fn(),
  rateAllowed: true,
  enabled: true,
}));

vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: holder.viewer,
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: holder.enabled })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: vi.fn(async () => {
    throw new Error("a stop must not build the Mink actor context");
  }),
}));
vi.mock("@/lib/mink/refine-stop", () => ({
  requestRefineStop: holder.requestStop,
  stopLiveRefine: holder.stopLive,
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
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { readRefineStopAnswer } from "@/lib/mink/refine-stop-types";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

const TOKEN = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const HOST = "https://acme.storemink.com";

/**
 * Every logError call so far, replayed through the REAL logger, as the text
 * it writes (its message, the error's message and cause): what a log reader
 * would see.
 */
async function writtenByRealLogError(): Promise<string> {
  const real = await vi.importActual<
    typeof import("@/lib/observability/logger")
  >("@/lib/observability/logger");
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const [message, error, context] of vi.mocked(logError).mock.calls) {
      real.logError(message, error, context);
    }
    return spy.mock.calls.flat().map(String).join("\n");
  } finally {
    spy.mockRestore();
  }
}

function request(
  init: {
    origin?: string;
    body?: string;
    contentType?: string;
  } = {},
) {
  return new Request(`${HOST}/api/mink/image-refine/stop`, {
    method: "POST",
    headers: {
      // ★ A beacon's string body is text/plain.
      "content-type": init.contentType ?? "text/plain;charset=UTF-8",
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: init.body ?? JSON.stringify({ stopToken: TOKEN }),
  });
}

function viewer(overrides: Record<string, unknown> = {}) {
  return {
    userId: "admin-1",
    userEmail: "owner@example.com",
    storeId: "store-1",
    isSuperadmin: false,
    isPlatformAdmin: false,
    profile: { id: "admin-row" },
    permissions: { dashboard: ["view"] },
    ...overrides,
  };
}

beforeEach(() => {
  holder.rateAllowed = true;
  holder.enabled = true;
  holder.viewer.mockResolvedValue(viewer());
  holder.requestStop.mockResolvedValue({ outcome: "stopped" });
});

describe("POST /api/mink/image-refine/stop", () => {
  it("★★ stops the signed-in admin's own refine in their own store, and stops it here at once", async () => {
    const response = await POST(request({ origin: HOST }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const key = { storeId: "store-1", adminId: "admin-1", stopToken: TOKEN };
    expect(holder.requestStop).toHaveBeenCalledWith(key);
    expect(holder.stopLive).toHaveBeenCalledWith(key);
    expect(readRefineStopAnswer(await response.json())).toEqual({
      outcome: "stopped",
    });
    expect(rateLimit).toHaveBeenCalledWith("mink-refine-stop:store-1:admin-1", {
      max: 30,
      windowSeconds: 60,
    });
  });

  it("★ lower-cases the token for the key", async () => {
    await POST(
      request({ body: JSON.stringify({ stopToken: TOKEN.toUpperCase() }) }),
    );
    expect(holder.requestStop).toHaveBeenCalledWith(
      expect.objectContaining({ stopToken: TOKEN }),
    );
  });

  it("★ recorded and too_late are decided answers (200), with no live stop", async () => {
    holder.requestStop.mockResolvedValueOnce({ outcome: "recorded" });
    const recorded = await POST(request());
    expect(recorded.status).toBe(200);
    expect(await recorded.json()).toEqual({ outcome: "recorded" });

    const url = "https://storage.googleapis.com/b/stores/s/refined/r.webp";
    holder.requestStop.mockResolvedValueOnce({ outcome: "too_late", url });
    const late = await POST(request());
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ outcome: "too_late", url });
    expect(holder.stopLive).not.toHaveBeenCalled();
  });

  it("★★ works while Mink is switched off, and never builds the Mink actor context", async () => {
    holder.enabled = false;
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(getMinkActorContext).not.toHaveBeenCalled();
  });

  it("★ refuses a foreign origin before anything else", async () => {
    const response = await POST(request({ origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(holder.viewer).not.toHaveBeenCalled();
    expect(holder.requestStop).not.toHaveBeenCalled();
  });

  it("maps the viewer as the Mink actor context does, each with outcome unknown", async () => {
    const cases: Array<[unknown, number, string]> = [
      [null, 401, "not_signed_in"],
      [
        viewer({ dbError: true, profile: null }),
        503,
        "permissions_unavailable",
      ],
      [viewer({ profile: null }), 403, "store_access_denied"],
      [viewer({ permissions: {} }), 403, "mink_access_denied"],
    ];
    for (const [value, status, code] of cases) {
      holder.viewer.mockResolvedValueOnce(value);
      const response = await POST(request());
      expect(response.status, code).toBe(status);
      expect(await response.json()).toMatchObject({ code, outcome: "unknown" });
    }
    expect(holder.requestStop).not.toHaveBeenCalled();
  });

  it("a superadmin without the explicit permission may still stop", async () => {
    holder.viewer.mockResolvedValueOnce(
      viewer({ isSuperadmin: true, permissions: {} }),
    );
    const response = await POST(request());
    expect(response.status).toBe(200);
  });

  it("is rate limited per admin", async () => {
    holder.rateAllowed = false;
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "Too many stop requests. Try again shortly.",
      outcome: "unknown",
    });
    expect(holder.requestStop).not.toHaveBeenCalled();
  });

  it("refuses a body over 1 KiB, bad JSON, and a missing or malformed token", async () => {
    const tooLarge = await POST(
      request({
        body: JSON.stringify({ stopToken: TOKEN, pad: "x".repeat(1_100) }),
      }),
    );
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ outcome: "unknown" });

    const badJson = await POST(request({ body: "{not json" }));
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ outcome: "unknown" });

    for (const body of [
      "{}",
      JSON.stringify({ stopToken: "not-a-token" }),
      JSON.stringify({ stopToken: 42 }),
      "[]",
    ]) {
      const response = await POST(request({ body }));
      expect(response.status, body).toBe(400);
      expect(await response.json()).toMatchObject({ outcome: "unknown" });
    }
    expect(holder.requestStop).not.toHaveBeenCalled();
  });

  it("★ a database error answers 503 unknown, and is logged without the token", async () => {
    // ★ Drizzle's own message for a failed query carries its parameters,
    //   and the stop's include the token; only the database's reason may
    //   reach the log.
    holder.requestStop.mockRejectedValueOnce(
      Object.assign(
        new Error(
          `Failed query: insert into public.mink_refine_requests as r ...\nparams: store-1,admin-1,${TOKEN}`,
        ),
        { cause: new Error("canceling statement due to statement timeout") },
      ),
    );
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Couldn't stop that refine right now.",
      outcome: "unknown",
    });
    expect(logError).toHaveBeenCalledWith(
      "mink.image-refine: stop failed",
      "canceling statement due to statement timeout",
      { requestId: expect.any(String) },
    );
    const written = await writtenByRealLogError();
    expect(written).toContain("canceling statement due to statement timeout");
    expect(written).not.toContain(TOKEN);
  });

  it("an error that is not a failed query is logged as it came (its stack names the line)", async () => {
    const bug = new TypeError("x is not a function");
    holder.requestStop.mockRejectedValueOnce(bug);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(logError).toHaveBeenCalledWith(
      "mink.image-refine: stop failed",
      bug,
      { requestId: expect.any(String) },
    );
  });

  it("★ logs ids and the outcome, never the token", async () => {
    await POST(request());
    expect(logInfo).toHaveBeenCalledWith("mink.image-refine: stop", {
      requestId: expect.any(String),
      storeId: "store-1",
      adminId: "admin-1",
      outcome: "stopped",
    });
    for (const log of [logInfo, logWarn, logError]) {
      expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(TOKEN);
    }
  });
});
