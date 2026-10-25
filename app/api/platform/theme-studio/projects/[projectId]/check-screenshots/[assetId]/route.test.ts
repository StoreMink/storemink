import { beforeEach, describe, expect, it, vi } from "vitest";

// GET .../projects/[projectId]/check-screenshots/[assetId] (TS-2A): one
// check screenshot's bytes, superadmin only exactly like the progress route
// (in plain text), and only a check screenshot of THIS project: the read
// (progress.ts readThemeStudioCheckScreenshot, which filters purpose and
// project in SQL) answers null for anything else, and the route says 404.

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  actor: null as null | { id: string; email: string },
  file: null as null | {
    bytes: Buffer;
    contentType: "image/webp" | "image/png";
  },
}));
const { serverUser, actorOf, read, logError } = vi.hoisted(() => ({
  serverUser: vi.fn(async () => state.user),
  actorOf: vi.fn(async () => state.actor),
  read: vi.fn(async () => state.file),
  logError: vi.fn(),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: serverUser }));
vi.mock("@/lib/theme-studio/access", () => ({ getThemeStudioActor: actorOf }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: (db: unknown) => unknown) => fn("db")),
}));
vi.mock("@/lib/observability/logger", () => ({ logError }));
vi.mock("@/lib/theme-studio/progress", () => ({
  readThemeStudioCheckScreenshot: read,
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
const ASSET = "44444444-4444-4444-8444-444444444444";
const get = (projectId = PROJECT, assetId = ASSET) =>
  GET(
    new Request(
      `https://storemink.com/api/platform/theme-studio/projects/${projectId}/check-screenshots/${assetId}`,
    ),
    { params: Promise.resolve({ projectId, assetId }) },
  );

describe("the check screenshot bytes route", () => {
  beforeEach(() => {
    state.user = { id: "u1", email: "owner@storemink.com" };
    state.actor = { id: "a1", email: "owner@storemink.com" };
    state.file = {
      bytes: Buffer.from("RIFF0000WEBPdata"),
      contentType: "image/webp",
    };
  });

  it("answers 401 and 403 in plain text, reading nothing", async () => {
    state.user = null;
    const signedOut = await get();
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).toBe(
      "Your session has ended. Sign in again.",
    );
    expect(signedOut.headers.get("cache-control")).toBe("private, no-store");
    state.user = { id: "u1", email: "member@storemink.com" };
    state.actor = null;
    const member = await get();
    expect(member.status).toBe(403);
    expect(await member.text()).toBe(
      "Only a platform superadmin can use Theme Studio.",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("serves a check screenshot of this project, private and locked down", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "RIFF0000WEBPdata",
    );
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/webp",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": "inline",
      "cross-origin-resource-policy": "same-origin",
      "x-robots-tag": "noindex",
    });
    expect(read).toHaveBeenCalledWith("db", {
      projectId: PROJECT,
      assetId: ASSET,
    });
  });

  it("sends a tall page's PNG as PNG", async () => {
    state.file = { bytes: Buffer.from("png"), contentType: "image/png" };
    expect((await get()).headers.get("content-type")).toBe("image/png");
  });

  it("answers 404 for a theme picture, a reference or another project's screenshot", async () => {
    // The read refuses all three (wrong purpose or wrong project): null.
    state.file = null;
    const refused = await get();
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe("Not found");
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 404 for a malformed id without reading", async () => {
    expect((await get("nope", ASSET)).status).toBe(404);
    expect((await get(PROJECT, "nope")).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers 500 when the read fails, logging ids only", async () => {
    read.mockRejectedValueOnce(new Error("boom"));
    expect((await get()).status).toBe(500);
    expect(logError).toHaveBeenCalledWith(
      "theme studio: check screenshot read failed",
      expect.any(Error),
      { projectId: PROJECT, assetId: ASSET },
    );
  });
});
