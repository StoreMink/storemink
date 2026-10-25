import { beforeEach, describe, expect, it, vi } from "vitest";

// GET .../projects/[projectId]/check-screenshots?versionId= (TS-2A, the
// owner-approved check screenshots): superadmin only like the progress
// route, a malformed design 400, a design that is not this theme's 404,
// private and never cached.

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  actor: null as null | { id: string; email: string },
  screenshots: null as unknown,
}));
const { serverUser, actorOf, read, logError } = vi.hoisted(() => ({
  serverUser: vi.fn(async () => state.user),
  actorOf: vi.fn(async () => state.actor),
  read: vi.fn(async () => state.screenshots),
  logError: vi.fn(),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: serverUser }));
vi.mock("@/lib/theme-studio/access", () => ({ getThemeStudioActor: actorOf }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: (db: unknown) => unknown) => fn("db")),
}));
vi.mock("@/lib/observability/logger", () => ({ logError }));
vi.mock("@/lib/theme-studio/progress", () => ({
  listThemeStudioCheckScreenshots: read,
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
const VERSION = "22222222-2222-4222-8222-222222222222";
const get = (query = "", projectId = PROJECT) =>
  GET(
    new Request(
      `https://storemink.com/api/platform/theme-studio/projects/${projectId}/check-screenshots${query}`,
    ),
    { params: Promise.resolve({ projectId }) },
  );

const SCREENSHOTS = {
  versionId: VERSION,
  checkRunId: "33333333-3333-4333-8333-333333333333",
  capturedAt: "2026-10-25T09:30:00.000Z",
  build: "build-1",
  coverage: {
    pages: ["home"],
    widths: [390],
    panels: ["menu"],
    cartWasEmpty: false,
  },
  samples: [
    {
      assetId: "44444444-4444-4444-8444-444444444444",
      page: "home",
      viewport: "phone390",
      width: 390,
      height: 2400,
    },
  ],
};

describe("the check screenshots route", () => {
  beforeEach(() => {
    state.user = { id: "u1", email: "owner@storemink.com" };
    state.actor = { id: "a1", email: "owner@storemink.com" };
    state.screenshots = SCREENSHOTS;
  });

  it("answers 401, then 403, before reading anything", async () => {
    state.user = null;
    const signedOut = await get();
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("cache-control")).toBe("private, no-store");
    expect(actorOf).not.toHaveBeenCalled();
    state.user = { id: "u1", email: "member@storemink.com" };
    state.actor = null;
    const member = await get();
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({
      error: "Only a platform superadmin can use Theme Studio.",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the current design without a versionId, and answers it unwrapped and private", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(SCREENSHOTS);
    expect(read).toHaveBeenCalledWith("db", {
      projectId: PROJECT,
      versionId: null,
    });
  });

  it("reads the asked design, refusing a malformed one with 400", async () => {
    await get(`?versionId=${VERSION}`);
    expect(read).toHaveBeenLastCalledWith("db", {
      projectId: PROJECT,
      versionId: VERSION,
    });
    const malformed = await get("?versionId=not-a-design");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Unknown design." });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a malformed or unknown theme, and a design that is not this theme's", async () => {
    expect((await get("", "nope")).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    state.screenshots = null;
    const unknown = await get();
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "That theme no longer exists.",
    });
    const foreign = await get(`?versionId=${VERSION}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({
      error: "That design is not part of this theme.",
    });
  });

  it("answers 500 when the read fails, logging ids only", async () => {
    read.mockRejectedValueOnce(new Error("boom"));
    const response = await get(`?versionId=${VERSION}`);
    expect(response.status).toBe(500);
    expect(logError).toHaveBeenCalledWith(
      "theme studio: check screenshots read failed",
      expect.any(Error),
      { projectId: PROJECT, versionId: VERSION },
    );
  });
});
