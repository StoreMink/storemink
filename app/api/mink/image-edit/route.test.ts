import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinkRequestError, MinkToolInputError } from "@/lib/mink/errors";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  edit: vi.fn(),
}));

vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/image-edit", () => ({ editProductPhoto: holder.edit }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { POST } from "./route";

const URL_OK = "https://storage.googleapis.com/bucket/stores/s/uploads/a.png";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://echos.storemink.com/api/mink/image-edit", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  holder.actor.mockResolvedValue({ storeId: "store-1", adminId: "admin-1" });
  holder.edit.mockResolvedValue({
    id: "e1",
    url: "https://storage.googleapis.com/bucket/stores/s/edited/ai-e1.webp",
    width: 1200,
    height: 1600,
    chargedCredits: 5,
  });
});

describe("POST /api/mink/image-edit", () => {
  it("turns a preset into its request on the server", async () => {
    const response = await POST(
      request({ url: URL_OK, spec: "product", preset: "garden" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.edit).toHaveBeenCalledWith({
      actor: expect.objectContaining({ storeId: "store-1" }),
      sourceUrl: URL_OK,
      specKey: "product",
      instruction: expect.stringMatching(/^Photograph the product .*garden/),
    });
  });

  it("passes the merchant's own words, tidied, when no preset is named", async () => {
    await POST(
      request({
        url: URL_OK,
        spec: "product",
        instruction: "  worn by a model\non a city street ",
      }),
    );
    expect(holder.edit.mock.calls[0][0].instruction).toBe(
      "worn by a model on a city street",
    );
  });

  it("refuses an unknown slot, a missing photo and an empty request", async () => {
    for (const body of [
      { url: URL_OK, spec: "poster", preset: "garden" },
      { spec: "product", preset: "garden" },
      { url: URL_OK, spec: "product", preset: "disco" },
      { url: URL_OK, spec: "product", instruction: " " },
    ]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect(holder.edit).not.toHaveBeenCalled();
  });

  it("returns a refusal's own status and words", async () => {
    holder.edit.mockRejectedValueOnce(
      new MinkRequestError("edit_insufficient_credits", "No credits.", 402),
    );
    const response = await POST(
      request({ url: URL_OK, spec: "product", preset: "studio" }),
    );
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      error: "No credits.",
      code: "edit_insufficient_credits",
    });
  });

  it("turns an image-generation permission refusal into a 403", async () => {
    holder.edit.mockRejectedValueOnce(
      new MinkToolInputError("Image generation is not enabled for this store."),
    );
    const response = await POST(
      request({ url: URL_OK, spec: "product", preset: "studio" }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a request from another site", async () => {
    const response = await POST(
      request(
        { url: URL_OK, spec: "product", preset: "studio" },
        { origin: "https://evil.example" },
      ),
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
  });
});
