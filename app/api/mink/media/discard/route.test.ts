import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  discard: vi.fn(),
  deleteMedia: vi.fn(),
}));

vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/attachments", () => ({
  discardUnsentMinkAttachment: holder.discard,
}));
vi.mock("@/app/actions/media-actions", () => ({
  deleteMediaAsset: holder.deleteMedia,
}));

import { POST } from "./route";
import { MinkRequestError } from "@/lib/mink/errors";

const ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://echos.storemink.com";

function request(init: { origin?: string | null; body?: string } = {}) {
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  return new Request(`${ORIGIN}/api/mink/media/discard`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: init.body ?? JSON.stringify({ id: ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  holder.actor.mockResolvedValue({ storeId: "store-1", adminId: "admin-1" });
  holder.discard.mockResolvedValue(true);
  holder.deleteMedia.mockResolvedValue({ success: true });
});

describe("POST /api/mink/media/discard", () => {
  it("★★ discards the actor's own unsent attachment and never touches the Media Library", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ discarded: true });
    expect(holder.discard).toHaveBeenCalledOnce();
    expect(holder.discard).toHaveBeenCalledWith({
      storeId: "store-1",
      adminId: "admin-1",
      id: ID,
    });
    expect(holder.deleteMedia).not.toHaveBeenCalled();
  });

  it("★ the store and the admin are the actor's, never the body's, and the id is lower-cased", async () => {
    const response = await POST(
      request({
        body: JSON.stringify({
          id: ID.toUpperCase(),
          storeId: "store-2",
          adminId: "admin-2",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(holder.discard).toHaveBeenCalledWith({
      storeId: "store-1",
      adminId: "admin-1",
      id: ID,
    });
  });

  it("★★ falls back to the Media Library row when no attachment was found (a tab from before the deploy)", async () => {
    holder.discard.mockResolvedValue(false);

    const response = await POST(request());

    await expect(response.json()).resolves.toEqual({ discarded: true });
    expect(holder.deleteMedia).toHaveBeenCalledOnce();
    expect(holder.deleteMedia).toHaveBeenCalledWith(ID);
    // The attachment is asked first; the Library only once it found nothing.
    expect(holder.discard.mock.invocationCallOrder[0]).toBeLessThan(
      holder.deleteMedia.mock.invocationCallOrder[0],
    );
  });

  it("reports a Media Library refusal as not discarded, still with a 200", async () => {
    holder.discard.mockResolvedValue(false);
    holder.deleteMedia.mockResolvedValue({
      error: "You don't have access to the media library.",
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ discarded: false });
  });

  it("refuses a malformed id before anything is read", async () => {
    for (const id of ["not-a-uuid", ID.slice(0, -1), 42, null]) {
      const response = await POST(request({ body: JSON.stringify({ id }) }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid item.",
      });
    }
    expect(holder.discard).not.toHaveBeenCalled();
    expect(holder.deleteMedia).not.toHaveBeenCalled();
  });

  it("refuses a foreign origin before resolving the actor", async () => {
    const response = await POST(
      request({ origin: "https://attacker.example" }),
    );

    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.discard).not.toHaveBeenCalled();
    expect(holder.deleteMedia).not.toHaveBeenCalled();
  });

  it("answers 503 when the actor is refused, calling nothing", async () => {
    holder.actor.mockRejectedValue(
      new MinkRequestError("unauthenticated", "Not signed in.", 401),
    );

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Unavailable." });
    expect(holder.discard).not.toHaveBeenCalled();
    expect(holder.deleteMedia).not.toHaveBeenCalled();
  });

  it("answers 503 when the attachment discard throws, without falling back to the Library", async () => {
    holder.discard.mockRejectedValue(new Error("connection reset"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(holder.deleteMedia).not.toHaveBeenCalled();
  });

  it("refuses a body over the bound without reading an id", async () => {
    const response = await POST(
      request({ body: JSON.stringify({ id: ID, pad: "x".repeat(2048) }) }),
    );

    expect(response.status).toBe(503);
    expect(holder.discard).not.toHaveBeenCalled();
    expect(holder.deleteMedia).not.toHaveBeenCalled();
  });
});
