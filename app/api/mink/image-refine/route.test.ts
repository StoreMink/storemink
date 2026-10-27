import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinkRequestError } from "@/lib/mink/errors";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  refine: vi.fn(),
}));

vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ enabled: true, betaRequireInvite: false }),
}));
vi.mock("@/lib/mink/image-refine", () => ({
  refineStoreImage: holder.refine,
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { POST, maxDuration } from "./route";

const URL_OK = "https://storage.googleapis.com/bucket/stores/s/uploads/a.png";

function request(body: unknown, init: { signal?: AbortSignal } = {}) {
  return new Request("https://echos.storemink.com/api/mink/image-refine", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

beforeEach(() => {
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    isSuperadmin: true,
    permissions: {},
  });
  holder.refine.mockResolvedValue({
    url: "https://storage.googleapis.com/bucket/stores/s/refined/x.webp",
    width: 1200,
    height: 1600,
    chargedCredits: 2,
  });
});

describe("POST /api/mink/image-refine", () => {
  it("★★ gives the refine a stop and a deadline, so the provider call ends with the request (B6)", async () => {
    const before = Date.now();
    const response = await POST(request({ url: URL_OK, spec: "product" }));
    expect(response.status).toBe(200);
    const input = holder.refine.mock.calls[0][0] as {
      signal: AbortSignal;
      deadlineAt: number;
      sourceUrl: string;
      specKey: string;
    };
    expect(input).toMatchObject({ sourceUrl: URL_OK, specKey: "product" });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.signal.aborted).toBe(false);
    // 150 s to answer, inside the route's own limit.
    expect(input.deadlineAt).toBeGreaterThanOrEqual(before + 150_000);
    expect(input.deadlineAt).toBeLessThan(before + maxDuration * 1_000);
  });

  it("★ the request's own signal still reaches the refine (locally; behind the load balancer it never fires, which is why the browser sends a stop)", async () => {
    const leaving = new AbortController();
    holder.refine.mockImplementationOnce(
      async (input: { signal: AbortSignal }) => {
        leaving.abort();
        expect(input.signal.aborted).toBe(true);
        throw new MinkRequestError(
          "refine_stopped",
          "Refining took too long. Nothing was charged; try again.",
          504,
        );
      },
    );
    const response = await POST(
      request({ url: URL_OK, spec: "product" }, { signal: leaving.signal }),
    );
    expect(response.status).toBe(504);
  });

  it("★★ passes the browser's stop token through", async () => {
    const token = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
    const response = await POST(
      request({ url: URL_OK, spec: "product", stopToken: token }),
    );
    expect(response.status).toBe(200);
    expect(holder.refine.mock.calls[0][0]).toMatchObject({ stopToken: token });
  });

  it("★ a tab without a token passes none (the server makes one)", async () => {
    await POST(request({ url: URL_OK, spec: "product" }));
    const input = holder.refine.mock.calls[0][0] as Record<string, unknown>;
    expect(input.stopToken).toBeUndefined();
  });

  it("★ refuses a malformed stop token before anything runs", async () => {
    for (const stopToken of ["not-a-token", 42, null, ""]) {
      const response = await POST(
        request({ url: URL_OK, spec: "product", stopToken }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          "This refine couldn't be started. Reload the page and try again.",
      });
    }
    expect(holder.refine).not.toHaveBeenCalled();
  });

  it("refuses an unknown slot before anything runs", async () => {
    const response = await POST(request({ url: URL_OK, spec: "poster" }));
    expect(response.status).toBe(400);
    expect(holder.refine).not.toHaveBeenCalled();
  });
});
