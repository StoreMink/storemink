import { beforeEach, expect, it, vi } from "vitest";
import { MinkRequestError } from "@/lib/mink/errors";
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  review: vi.fn(),
  approve: vi.fn(),
  tag: vi.fn(),
  path: vi.fn(),
  publish: vi.fn(),
  event: vi.fn(),
  after: vi.fn(),
  enabled: true,
  allowed: true,
}));
vi.mock("next/cache", () => ({
  revalidateTag: mocks.tag,
  revalidatePath: mocks.path,
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ enabled: mocks.enabled, betaRequireInvite: false }),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: mocks.actor,
}));
vi.mock("@/lib/mink/builder-actions", () => ({
  readMinkBuilderReview: mocks.review,
  approveMinkBuilderProposal: mocks.approve,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ allowed: mocks.allowed }),
}));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: mocks.publish,
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: mocks.event }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
import { GET, POST } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ draftId: id }) };
const actor = {
  storeId: "authenticated-store",
  adminId: "authenticated-admin",
  email: null,
};
const request = (value: unknown, origin = "https://shop.storemink.com") =>
  new Request("https://shop.storemink.com/api/mink/test", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.allowed = true;
  mocks.actor.mockResolvedValue(actor);
  mocks.review.mockResolvedValue({
    executed: false,
    operation: "chrome_update",
  });
  mocks.approve.mockResolvedValue({
    operation: "chrome_update",
    pageSlug: "home",
    approvalId: "approved",
    repeated: false,
    resultId: "store",
  });
});
it("refuses foreign origins before authentication", async () => {
  expect(
    (
      await POST(
        request(
          { action: "approve", idempotencyKey: key },
          "https://attacker.example",
        ),
        context,
      )
    ).status,
  ).toBe(403);
  expect(mocks.actor).not.toHaveBeenCalled();
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("loads an owner review privately without executing it", async () => {
  const response = await GET(
    new Request("https://shop.storemink.com/api/mink/test"),
    context,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("private, no-store");
  expect(mocks.review).toHaveBeenCalledWith(actor, id);
  expect(mocks.approve).not.toHaveBeenCalled();
});
it.each(["storeId", "patch", "changes", "operation"])(
  "rejects browser-supplied %s",
  async (field) => {
    expect(
      (
        await POST(
          request({
            action: "approve",
            idempotencyKey: key,
            [field]: "attacker-value",
          }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
  },
);
it("approves only the stored draft under the authenticated actor and expires cache tags immediately", async () => {
  const response = await POST(
    request({ action: "approve", idempotencyKey: key, browserChecks: {} }),
    context,
  );
  expect(response.status).toBe(200);
  expect(mocks.approve).toHaveBeenCalledWith(actor, id, key, {});
  expect(mocks.path).toHaveBeenCalledWith("/dashboard/builder");
  expect(mocks.path).toHaveBeenCalledWith("/", "layout");
  expect(
    mocks.tag.mock.calls.every(
      (call) => JSON.stringify(call[1]) === '{"expire":0}',
    ),
  ).toBe(true);
  expect(mocks.event).not.toHaveBeenCalled();
});
it("returns a stale conflict without cache invalidation or publication", async () => {
  mocks.approve.mockRejectedValueOnce(
    new MinkRequestError("stale", "Builder changed.", 409),
  );
  expect(
    (await POST(request({ action: "approve", idempotencyKey: key }), context))
      .status,
  ).toBe(409);
  expect(mocks.tag).not.toHaveBeenCalled();
  expect(mocks.event).not.toHaveBeenCalled();
});
it("bounds streamed input even without a content-length header", async () => {
  expect(
    (
      await POST(
        request({
          action: "approve",
          idempotencyKey: key,
          browserChecks: "x".repeat(33000),
        }),
        context,
      )
    ).status,
  ).toBe(413);
  expect(mocks.approve).not.toHaveBeenCalled();
});
it("emits publication once and schedules ordinary storefront indexing", async () => {
  mocks.approve.mockResolvedValueOnce({
    operation: "page_publish",
    pageSlug: "size-guide",
    approvalId: "approved",
    repeated: false,
    resultId: "page",
  });
  expect(
    (await POST(request({ action: "approve", idempotencyKey: key }), context))
      .status,
  ).toBe(200);
  expect(mocks.event).toHaveBeenCalledWith(
    expect.objectContaining({ type: "page.published", storeId: actor.storeId }),
  );
  await mocks.after.mock.calls[0][0]();
  expect(mocks.publish).toHaveBeenCalledWith({
    storeId: actor.storeId,
    paths: ["/size-guide", "/"],
  });
  mocks.approve.mockResolvedValueOnce({
    operation: "page_publish",
    pageSlug: "size-guide",
    approvalId: "approved",
    repeated: true,
    resultId: "page",
  });
  await POST(request({ action: "approve", idempotencyKey: key }), context);
  expect(mocks.event).toHaveBeenCalledTimes(1);
});
it("honors runtime disable and rate limits", async () => {
  mocks.enabled = false;
  expect(
    (await POST(request({ action: "approve", idempotencyKey: key }), context))
      .status,
  ).toBe(404);
  mocks.enabled = true;
  mocks.allowed = false;
  expect(
    (await POST(request({ action: "approve", idempotencyKey: key }), context))
      .status,
  ).toBe(429);
  expect(mocks.approve).not.toHaveBeenCalled();
});
