import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/platform/theme-studio/projects?filter= (TS-2A): superadmin only,
// 401 before 403, an unknown filter 400, never cached, the read only after
// both checks.

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  actor: null as null | { id: string; email: string },
}));
const { serverUser, actorOf, list, logError } = vi.hoisted(() => ({
  serverUser: vi.fn(async () => state.user),
  actorOf: vi.fn(async () => state.actor),
  list: vi.fn(async () => ({
    rows: [],
    counts: {
      all: 0,
      needs_you: 0,
      building: 0,
      ready: 0,
      live: 0,
      archived: 0,
    },
  })),
  logError: vi.fn(),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: serverUser }));
vi.mock("@/lib/theme-studio/access", () => ({ getThemeStudioActor: actorOf }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: (db: unknown) => unknown) => fn("db")),
}));
vi.mock("@/lib/observability/logger", () => ({ logError }));
vi.mock("@/lib/theme-studio/progress", () => ({
  THEME_STUDIO_LIST_FILTERS: [
    "all",
    "needs_you",
    "building",
    "ready",
    "live",
    "archived",
  ],
  listThemeStudioProjectsForConsole: list,
}));

import { GET } from "./route";

const get = (query = "", headers: Record<string, string> = {}) =>
  GET(
    new Request(
      `https://storemink.com/api/platform/theme-studio/projects${query}`,
      {
        headers,
      },
    ),
  );

describe("the Theme Studio list route", () => {
  beforeEach(() => {
    state.user = { id: "u1", email: "owner@storemink.com" };
    state.actor = { id: "a1", email: "owner@storemink.com" };
  });

  it("answers 401 to a lost session, before anything else is read", async () => {
    state.user = null;
    const response = await get();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Your session has ended. Sign in again.",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(actorOf).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("answers 403 to a signed-in user who is not a superadmin", async () => {
    state.actor = null;
    const response = await get();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Only a platform superadmin can use Theme Studio.",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses another site's browser", async () => {
    const response = await get("", { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(serverUser).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("answers the list, all by default, never cached", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      rows: [],
      counts: {
        all: 0,
        needs_you: 0,
        building: 0,
        ready: 0,
        live: 0,
        archived: 0,
      },
    });
    expect(list).toHaveBeenCalledWith("db", { filter: "all" });
  });

  it("passes a known filter through and refuses any other with 400", async () => {
    await get("?filter=needs_you");
    expect(list).toHaveBeenLastCalledWith("db", { filter: "needs_you" });
    const response = await get("?filter=candidate");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unknown filter." });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("answers 500 in plain words when the read fails, logging codes and the filter only", async () => {
    list.mockRejectedValueOnce(new Error("boom"));
    const response = await get("?filter=ready");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "The Theme Studio list could not be read. Try again.",
    });
    expect(logError).toHaveBeenCalledWith(
      "theme studio: list read failed",
      expect.any(Error),
      { filter: "ready" },
    );
  });
});
