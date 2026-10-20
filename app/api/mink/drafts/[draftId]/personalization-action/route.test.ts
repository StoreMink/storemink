import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinkRequestError } from "@/lib/mink/errors";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  latest: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
  tag: vi.fn(),
  path: vi.fn(),
  enabled: true,
  allowed: true,
}));
vi.mock("next/cache", () => ({
  revalidateTag: mocks.tag,
  revalidatePath: mocks.path,
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ enabled: mocks.enabled, betaRequireInvite: false }),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: mocks.actor,
}));
vi.mock("@/lib/mink/storefront-personalization-actions", () => ({
  getLatestMinkStorefrontPersonalizationAction: mocks.latest,
  previewMinkStorefrontPersonalizationAction: mocks.preview,
  executeMinkStorefrontPersonalizationAction: mocks.execute,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ allowed: mocks.allowed }),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { GET, POST } from "./route";

const draftId = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const approvalId = "33333333-3333-4333-8333-333333333333";
const context = { params: Promise.resolve({ draftId }) };
const actor = { storeId: "store", adminId: "admin", email: null };

function post(value: unknown, origin = "https://shop.storemink.com") {
  return new Request("https://shop.storemink.com/api/mink/test", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
function get() {
  return new Request("https://shop.storemink.com/api/mink/test", {
    headers: { Origin: "https://shop.storemink.com" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.allowed = true;
  mocks.actor.mockResolvedValue(actor);
  mocks.preview.mockResolvedValue({ id: approvalId, status: "pending" });
  mocks.execute.mockResolvedValue({
    approval: { id: approvalId, status: "executed" },
    auditId: "audit",
    repeated: false,
  });
  mocks.latest.mockResolvedValue(null);
});

describe("POST /api/mink/drafts/[draftId]/personalization-action", () => {
  it("refuses a foreign origin before reading anyone's session", async () => {
    const response = await POST(
      post({ action: "execute", approvalId }, "https://attacker.example"),
      context,
    );
    expect(response.status).toBe(403);
    expect(mocks.actor).not.toHaveBeenCalled();
  });

  it("accepts only the approval vocabulary, never a plan from the browser", async () => {
    for (const body of [
      { action: "execute", approvalId, plan: { pages: [] } },
      { action: "preview", expectedDraftVersion: 3, idempotencyKey: key },
      { action: "preview", expectedDraftVersion: 0, idempotencyKey: "nope" },
      { action: "publish" },
    ]) {
      expect((await POST(post(body), context)).status).toBe(400);
    }
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("previews with the server-derived actor", async () => {
    const response = await POST(
      post({ action: "preview", expectedDraftVersion: 0, idempotencyKey: key }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(mocks.preview).toHaveBeenCalledWith({
      actor,
      draftId,
      expectedDraftVersion: 0,
      idempotencyKey: key,
    });
  });

  it("★ expires the live caches at once after a first apply, and not on a replay", async () => {
    await POST(post({ action: "execute", approvalId }), context);
    expect(mocks.tag).toHaveBeenCalledWith("storefront:categories", {
      expire: 0,
    });
    expect(mocks.tag).toHaveBeenCalledWith("storefront:products", {
      expire: 0,
    });
    expect(mocks.tag).toHaveBeenCalledWith("stores", { expire: 0 });

    mocks.tag.mockClear();
    mocks.execute.mockResolvedValueOnce({
      approval: { id: approvalId, status: "executed" },
      auditId: "audit",
      repeated: true,
    });
    await POST(post({ action: "execute", approvalId }), context);
    expect(mocks.tag).not.toHaveBeenCalled();
  });

  it("passes a conflict through as itself, and hides an unexpected failure", async () => {
    mocks.execute.mockRejectedValueOnce(
      new MinkRequestError(
        "mink_personalization_target_conflict",
        "Part of the storefront changed.",
        409,
      ),
    );
    const conflict = await POST(
      post({ action: "execute", approvalId }),
      context,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "mink_personalization_target_conflict",
    });

    mocks.execute.mockRejectedValueOnce(new Error("relation does not exist"));
    const failed = await POST(post({ action: "execute", approvalId }), context);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("relation");
  });

  it("is rate limited per admin", async () => {
    mocks.allowed = false;
    expect(
      (await POST(post({ action: "execute", approvalId }), context)).status,
    ).toBe(429);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("is off when Mink AI is off", async () => {
    mocks.enabled = false;
    expect(
      (await POST(post({ action: "execute", approvalId }), context)).status,
    ).toBe(404);
  });
});

describe("GET /api/mink/drafts/[draftId]/personalization-action", () => {
  it("returns what this card already did", async () => {
    mocks.latest.mockResolvedValueOnce({ auditId: "audit", repeated: true });
    const response = await GET(get(), context);
    expect(await response.json()).toEqual({
      result: { auditId: "audit", repeated: true },
    });
  });

  it("reports nothing rather than an error for a draft it can no longer read", async () => {
    mocks.latest.mockRejectedValueOnce(
      new MinkRequestError("mink_personalization_draft_invalid", "x", 400),
    );
    const response = await GET(get(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: null });
  });

  it("refuses a malformed draft id", async () => {
    const response = await GET(get(), {
      params: Promise.resolve({ draftId: "x" }),
    });
    expect(response.status).toBe(400);
  });
});
