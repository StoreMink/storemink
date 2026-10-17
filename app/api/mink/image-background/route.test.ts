import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinkRequestError } from "@/lib/mink/errors";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/media/background-edit", () => ({
  replaceProductBackground: holder.replace,
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { POST } from "./route";

const URL_OK = "https://storage.googleapis.com/bucket/stores/s/uploads/a.png";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://echos.storemink.com/api/mink/image-background", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  holder.actor.mockResolvedValue({ storeId: "store-1", adminId: "admin-1" });
  holder.replace.mockResolvedValue({
    url: "https://storage.googleapis.com/bucket/stores/s/edited/x.webp",
    width: 1200,
    height: 1600,
    chargedCredits: 1,
    reused: false,
    checks: [],
  });
});

describe("POST /api/mink/image-background", () => {
  it("passes a parsed background and the server-derived actor through", async () => {
    const response = await POST(
      request({
        url: URL_OK,
        spec: "product",
        background: { kind: "colour", hex: "#F2EDE4" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.replace).toHaveBeenCalledWith({
      actor: { storeId: "store-1", adminId: "admin-1" },
      sourceUrl: URL_OK,
      specKey: "product",
      background: { kind: "colour", hex: "#f2ede4" },
    });
    expect(await response.json()).toMatchObject({ chargedCredits: 1 });
  });

  it("refuses a background that is not white, a #rrggbb colour or transparent", async () => {
    const response = await POST(
      request({
        url: URL_OK,
        spec: "product",
        background: { kind: "colour", hex: "red" },
      }),
    );
    expect(response.status).toBe(400);
    expect(holder.replace).not.toHaveBeenCalled();
  });

  it("refuses an unknown slot and a missing photo", async () => {
    expect(
      (
        await POST(
          request({
            url: URL_OK,
            spec: "poster",
            background: { kind: "white" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await POST(request({ spec: "product", background: { kind: "white" } })))
        .status,
    ).toBe(400);
    expect(holder.replace).not.toHaveBeenCalled();
  });

  it("returns a refusal's own status and words", async () => {
    holder.replace.mockRejectedValueOnce(
      new MinkRequestError(
        "cutout_insufficient_credits",
        "No credits left.",
        402,
      ),
    );
    const response = await POST(
      request({ url: URL_OK, spec: "product", background: { kind: "white" } }),
    );
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      error: "No credits left.",
      code: "cutout_insufficient_credits",
    });
  });

  it("does not claim nothing was charged when something unexpected fails", async () => {
    holder.replace.mockRejectedValueOnce(new Error("boom"));
    const response = await POST(
      request({ url: URL_OK, spec: "product", background: { kind: "white" } }),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toMatch(/nothing was charged/i);
  });

  it("refuses a request from another site", async () => {
    const response = await POST(
      request(
        { url: URL_OK, spec: "product", background: { kind: "white" } },
        { origin: "https://evil.example" },
      ),
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
  });
});
