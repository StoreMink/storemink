import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  read: vi.fn(),
  cancel: vi.fn(),
  publish: vi.fn(),
  undo: vi.fn(),
  kick: vi.fn(async () => true),
  after: vi.fn(),
  rateAllowed: true,
  enabled: true,
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: holder.after,
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
vi.mock("@/lib/mink/revamp/jobs", () => ({
  readRevampStatus: holder.read,
  cancelRevamp: holder.cancel,
  kickRevampIfStalled: holder.kick,
}));
vi.mock("@/lib/mink/revamp/publish", () => ({
  publishRevamp: holder.publish,
  undoRevamp: holder.undo,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.rateAllowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: holder.error,
  logWarn: holder.warn,
}));

import { rateLimit } from "@/lib/rate-limit";
import { MinkRequestError } from "@/lib/mink/errors";
import { GET, POST } from "./route";

const REVAMP_ID = "22222222-2222-4222-8222-222222222222";
const URL_BASE = `https://acme.storemink.com/api/mink/revamps/${REVAMP_ID}`;
const params = (revampId = REVAMP_ID) => ({
  params: Promise.resolve({ revampId }),
});
const view = (status: string) => ({
  id: REVAMP_ID,
  kind: "full",
  status,
  step: "photos",
  progress: [],
  draftId: null,
  error: null,
  review: null,
  supersededBy: null,
  appliedAt: null,
  publishedAt: null,
  undoneAt: null,
  createdAt: "2026-10-21T05:00:00.000Z",
  finishedAt: null,
});

function post(body: unknown, init: RequestInit = {}) {
  return new Request(URL_BASE, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

beforeEach(() => {
  holder.rateAllowed = true;
  holder.enabled = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    isSuperadmin: true,
    permissions: {},
  });
  holder.read.mockResolvedValue(view("running"));
  holder.cancel.mockResolvedValue(view("cancelled"));
  holder.publish.mockResolvedValue({
    published: ["Homepage", "Header and footer"],
    skipped: [],
  });
  holder.undo.mockResolvedValue({ restored: ["Homepage"], kept: [] });
});

describe("GET /api/mink/revamps/[revampId]", () => {
  it("reads through the trusted actor and answers private, uncached JSON", async () => {
    const response = await GET(new Request(URL_BASE), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revamp: view("running") });
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(holder.read).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      REVAMP_ID,
    );
    expect(rateLimit).toHaveBeenCalledWith("mink-revamp-read:store-1:admin-1", {
      max: 120,
      windowSeconds: 60,
    });
  });

  it("★ kicks a waiting job only after the response, and never a finished one", async () => {
    await GET(new Request(URL_BASE), params());
    expect(holder.after).toHaveBeenCalledOnce();
    expect(holder.kick).not.toHaveBeenCalled();
    const task = holder.after.mock.calls[0][0] as () => Promise<void>;
    await task();
    expect(holder.kick).toHaveBeenCalledWith(REVAMP_ID);

    holder.after.mockClear();
    holder.read.mockResolvedValueOnce(view("queued"));
    await GET(new Request(URL_BASE), params());
    expect(holder.after).toHaveBeenCalledOnce();

    for (const status of ["ready", "failed", "cancelled", "superseded"]) {
      holder.after.mockClear();
      holder.read.mockResolvedValueOnce(view(status));
      await GET(new Request(URL_BASE), params());
      expect(holder.after).not.toHaveBeenCalled();
    }
  });

  it("refuses a foreign origin before reading the session", async () => {
    const response = await GET(
      new Request(URL_BASE, { headers: { origin: "https://evil.example" } }),
      params(),
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("refuses a malformed id before authentication", async () => {
    const response = await GET(
      new Request(`${URL_BASE}x`),
      params("not-a-uuid"),
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.read).not.toHaveBeenCalled();
  });

  it("answers 404 while Mink AI is switched off, without a session read", async () => {
    holder.enabled = false;
    const response = await GET(new Request(URL_BASE), params());
    expect(response.status).toBe(404);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("passes the actor's refusal through with its status and code", async () => {
    holder.actor.mockRejectedValueOnce(
      new MinkRequestError("mink_unauthorized", "Sign in to use Mink AI.", 401),
    );
    const unauth = await GET(new Request(URL_BASE), params());
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({
      error: "Sign in to use Mink AI.",
      code: "mink_unauthorized",
    });

    holder.read.mockRejectedValueOnce(
      new MinkRequestError(
        "mink_revamp_access_denied",
        "You no longer have permission to view this redesign.",
        403,
      ),
    );
    const denied = await GET(new Request(URL_BASE), params());
    expect(denied.status).toBe(403);
    expect(holder.warn).toHaveBeenCalledWith(
      "mink.revamp: request rejected",
      expect.objectContaining({ code: "mink_revamp_access_denied" }),
    );
  });

  it("rate-limits per store and admin", async () => {
    holder.rateAllowed = false;
    const response = await GET(new Request(URL_BASE), params());
    expect(response.status).toBe(429);
    expect(holder.read).not.toHaveBeenCalled();
  });

  it("answers 404 for someone else's revamp and 503 for an outage", async () => {
    holder.read.mockResolvedValueOnce(null);
    expect((await GET(new Request(URL_BASE), params())).status).toBe(404);

    holder.read.mockRejectedValueOnce(new Error("connection terminated"));
    const outage = await GET(new Request(URL_BASE), params());
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({
      error: "Mink AI couldn't load that redesign.",
    });
    expect(holder.error).toHaveBeenCalled();
  });
});

describe("POST /api/mink/revamps/[revampId]", () => {
  it("cancels for the requester and returns the status view", async () => {
    const response = await POST(post({ action: "cancel" }), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revamp: view("cancelled") });
    expect(holder.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1" }),
      REVAMP_ID,
    );
    expect(rateLimit).toHaveBeenCalledWith(
      "mink-revamp-action:store-1:admin-1",
      { max: 10, windowSeconds: 60 },
    );
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("answers 404 when there is nothing of theirs to cancel", async () => {
    holder.cancel.mockResolvedValueOnce(null);
    expect((await POST(post({ action: "cancel" }), params())).status).toBe(404);
  });

  it("★★ publishes for the requester through the same boundary as cancel", async () => {
    const response = await POST(post({ action: "publish" }), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: { published: ["Homepage", "Header and footer"], skipped: [] },
    });
    expect(holder.publish).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      REVAMP_ID,
    );
    expect(rateLimit).toHaveBeenCalledWith(
      "mink-revamp-action:store-1:admin-1",
      { max: 10, windowSeconds: 60 },
    );
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(holder.undo).not.toHaveBeenCalled();
  });

  it("★★ undoes for the requester and answers with what was restored and kept", async () => {
    const response = await POST(post({ action: "undo" }), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: { restored: ["Homepage"], kept: [] },
    });
    expect(holder.undo).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1" }),
      REVAMP_ID,
    );
    expect(holder.publish).not.toHaveBeenCalled();
  });

  it("★ maps a publish or undo refusal to its status and an outage to 503", async () => {
    holder.publish.mockRejectedValueOnce(
      new MinkRequestError(
        "mink_revamp_not_applied",
        "Apply this redesign to your Website Builder draft first.",
        409,
      ),
    );
    const refused = await POST(post({ action: "publish" }), params());
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "Apply this redesign to your Website Builder draft first.",
      code: "mink_revamp_not_applied",
    });
    holder.undo.mockRejectedValueOnce(new Error("connection terminated"));
    const outage = await POST(post({ action: "undo" }), params());
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({
      error: "Mink AI couldn't update that redesign.",
    });
    expect(holder.error).toHaveBeenCalledWith(
      "mink.revamp: request failed",
      expect.any(Error),
      expect.objectContaining({ operation: "undo" }),
    );
  });

  it("★ refuses extra fields on publish and undo, and both while Mink is off", async () => {
    for (const action of ["publish", "undo"]) {
      const extra = await POST(post({ action, pages: ["home"] }), params());
      expect(extra.status).toBe(400);
    }
    holder.enabled = false;
    expect((await POST(post({ action: "publish" }), params())).status).toBe(
      404,
    );
    expect((await POST(post({ action: "undo" }), params())).status).toBe(404);
    expect(holder.publish).not.toHaveBeenCalled();
    expect(holder.undo).not.toHaveBeenCalled();
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("★ refuses an unknown action, and an action that is not a string", async () => {
    for (const body of [
      { action: "apply" },
      { action: "delete" },
      { action: ["publish"] },
      { action: ["undo"] },
      { action: ["cancel"] },
      { action: { toString: "cancel" } },
      {},
      [],
      "null",
      "7",
    ]) {
      const response = await POST(post(body), params());
      expect(response.status).toBe(400);
    }
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.cancel).not.toHaveBeenCalled();
    expect(holder.publish).not.toHaveBeenCalled();
    expect(holder.undo).not.toHaveBeenCalled();
  });

  it("refuses extra fields and broken JSON", async () => {
    const extra = await POST(
      post({ action: "cancel", storeId: "other" }),
      params(),
    );
    expect(extra.status).toBe(400);
    expect(await extra.json()).toEqual({
      error: "Mink AI redesign request has unsupported fields.",
    });
    expect((await POST(post("{not json"), params())).status).toBe(400);
    expect(holder.cancel).not.toHaveBeenCalled();
  });

  it("refuses an oversized body by header and by bytes", async () => {
    const declared = await POST(
      post({ action: "cancel" }, { headers: { "content-length": "5000" } }),
      params(),
    );
    expect(declared.status).toBe(413);
    const streamed = await POST(
      post({ action: "cancel", pad: "x".repeat(2_000) }),
      params(),
    );
    expect(streamed.status).toBe(413);
    expect(holder.cancel).not.toHaveBeenCalled();
  });

  it("refuses a foreign origin and a malformed id before anything else", async () => {
    const foreign = await POST(
      post(
        { action: "cancel" },
        { headers: { origin: "https://evil.example" } },
      ),
      params(),
    );
    expect(foreign.status).toBe(403);
    const malformed = await POST(post({ action: "cancel" }), params("nope"));
    expect(malformed.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("rate-limits mutations separately and maps an outage to 503", async () => {
    holder.rateAllowed = false;
    expect((await POST(post({ action: "cancel" }), params())).status).toBe(429);
    holder.rateAllowed = true;
    holder.cancel.mockRejectedValueOnce(new Error("connection terminated"));
    const outage = await POST(post({ action: "cancel" }), params());
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({
      error: "Mink AI couldn't update that redesign.",
    });
  });

  it("answers 404 while Mink AI is switched off", async () => {
    holder.enabled = false;
    expect((await POST(post({ action: "cancel" }), params())).status).toBe(404);
    expect(holder.actor).not.toHaveBeenCalled();
  });
});
