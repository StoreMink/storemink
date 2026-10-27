import { beforeEach, describe, expect, it, vi } from "vitest";

// GET .../projects/[projectId]/progress (TS-2A): the theme page's poll.
// Superadmin only, 401 before 403 before 404, never cached, the read only
// after the checks, the answer unwrapped.

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  actor: null as null | { id: string; email: string },
  progress: null as unknown,
}));
const { serverUser, actorOf, read, logError } = vi.hoisted(() => ({
  serverUser: vi.fn(async () => state.user),
  actorOf: vi.fn(async () => state.actor),
  read: vi.fn(async () => state.progress),
  logError: vi.fn(),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: serverUser }));
vi.mock("@/lib/theme-studio/access", () => ({ getThemeStudioActor: actorOf }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: (db: unknown) => unknown) => fn("db")),
}));
vi.mock("@/lib/observability/logger", () => ({ logError }));
vi.mock("@/lib/theme-studio/progress", () => ({
  readThemeStudioProgress: read,
}));
vi.mock("@/lib/theme-studio/repository", () => ({
  isUuid: (value: unknown) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ),
}));

import { GET } from "./route";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const get = (projectId = PROJECT, headers: Record<string, string> = {}) =>
  GET(
    new Request(
      `https://storemink.com/api/platform/theme-studio/projects/${projectId}/progress`,
      { headers },
    ),
    { params: Promise.resolve({ projectId }) },
  );

describe("the progress route", () => {
  beforeEach(() => {
    state.user = { id: "u1", email: "owner@storemink.com" };
    state.actor = { id: "a1", email: "owner@storemink.com" };
    state.progress = {
      projectId: PROJECT,
      revision: 3,
      versionIds: [],
      currentVersionId: null,
      status: { now: "2026-10-25T10:00:00.000Z" },
      steps: [],
      updatedAt: "2026-10-25T10:00:00.000Z",
    };
  });

  it("answers 401 when the session is gone, reading nothing", async () => {
    state.user = null;
    const response = await get();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Your session has ended. Sign in again.",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(actorOf).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("answers 403 to a platform member or any other user", async () => {
    state.actor = null;
    const response = await get();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Only a platform superadmin can use Theme Studio.",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed theme id without reading, and for an unknown one", async () => {
    const malformed = await get("nope");
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({
      error: "That theme no longer exists.",
    });
    expect(read).not.toHaveBeenCalled();
    state.progress = null;
    const unknown = await get();
    expect(unknown.status).toBe(404);
    expect(read).toHaveBeenCalledWith("db", { projectId: PROJECT });
  });

  it("answers the progress itself, unwrapped and never cached", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(state.progress);
  });

  it("refuses another site's browser", async () => {
    const response = await get(PROJECT, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers 500 when the read fails, logging the theme id only", async () => {
    read.mockRejectedValueOnce(new Error("boom"));
    const response = await get();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "This theme's progress could not be read. Try again.",
    });
    expect(logError).toHaveBeenCalledWith(
      "theme studio: progress read failed",
      expect.any(Error),
      { projectId: PROJECT },
    );
  });
});
