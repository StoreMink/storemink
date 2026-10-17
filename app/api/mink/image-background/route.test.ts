import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinkRequestError, MinkToolInputError } from "@/lib/mink/errors";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  replace: vi.fn(),
  scenes: vi.fn(),
}));

vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/media/background-edit", () => ({
  replaceProductBackground: holder.replace,
}));
vi.mock("@/lib/mink/image-scenes", () => ({
  listStoreScenes: holder.scenes,
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { GET, POST } from "./route";

const URL_OK = "https://storage.googleapis.com/bucket/stores/s/uploads/a.png";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://echos.storemink.com/api/mink/image-background", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    isSuperadmin: true,
    permissions: {},
  });
  holder.scenes.mockResolvedValue([
    {
      id: "s1",
      preset: "marble",
      url: "https://x/s1.webp",
      path: "p",
      createdAt: "",
    },
  ]);
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
      actor: expect.objectContaining({
        storeId: "store-1",
        adminId: "admin-1",
      }),
      sourceUrl: URL_OK,
      specKey: "product",
      background: { kind: "colour", hex: "#f2ede4" },
      shadow: false,
      newScene: false,
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

describe("scenes and shadows", () => {
  it("passes a scene, the shadow and a new-scene request through, only when literally true", async () => {
    await POST(
      request({
        url: URL_OK,
        spec: "product",
        background: { kind: "scene", preset: "marble" },
        shadow: true,
        newScene: true,
      }),
    );
    expect(holder.replace.mock.calls[0][0]).toMatchObject({
      background: { kind: "scene", preset: "marble" },
      shadow: true,
      newScene: true,
    });
    await POST(
      request({
        url: URL_OK,
        spec: "product",
        background: { kind: "white" },
        shadow: "yes",
        newScene: 1,
      }),
    );
    expect(holder.replace.mock.calls[1][0]).toMatchObject({
      shadow: false,
      newScene: false,
    });
  });

  it("turns an image-generation permission refusal into a 403", async () => {
    holder.replace.mockRejectedValueOnce(
      new MinkToolInputError("Image generation is not enabled for this store."),
    );
    const response = await POST(
      request({
        url: URL_OK,
        spec: "product",
        background: { kind: "scene", preset: "marble" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("lists the store's saved scenes for a product slot", async () => {
    const response = await GET(
      new Request(
        "https://echos.storemink.com/api/mink/image-background?spec=product",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scenes: [{ preset: "marble", url: "https://x/s1.webp" }],
    });
    expect(holder.scenes).toHaveBeenCalledWith(
      "store-1",
      expect.objectContaining({ width: 1200, height: 1600 }),
    );
  });

  it("has no scenes for a slot that is a scene itself, and needs Media", async () => {
    const banner = await GET(
      new Request(
        "https://echos.storemink.com/api/mink/image-background?spec=hero_wide",
      ),
    );
    expect(banner.status).toBe(400);
    holder.actor.mockResolvedValueOnce({
      storeId: "store-1",
      adminId: "admin-1",
      isSuperadmin: false,
      permissions: {},
    });
    const denied = await GET(
      new Request(
        "https://echos.storemink.com/api/mink/image-background?spec=product",
      ),
    );
    expect(denied.status).toBe(403);
  });
});
