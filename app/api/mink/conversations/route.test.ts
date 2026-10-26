import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  enabled: true,
  actor: vi.fn(),
  list: vi.fn(),
  allowed: true,
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: holder.enabled })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/conversation-history", () => ({
  listMinkConversations: holder.list,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.allowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { MinkRequestError } from "@/lib/mink/errors";
import { rateLimit } from "@/lib/rate-limit";
import { GET } from "./route";

function request(query = "") {
  return new Request(
    `https://echos.storemink.com/api/mink/conversations${query}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  holder.enabled = true;
  holder.allowed = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
  });
  holder.list.mockResolvedValue({
    conversations: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Published products",
        lastMessageAt: "2026-08-29T09:00:00.000Z",
        createdAt: "2026-08-29T08:59:00.000Z",
        hasRedesignCard: false,
      },
    ],
    nextCursor: "next-page",
  });
});

describe("GET /api/mink/conversations", () => {
  it("lists only conversations returned for the trusted actor, a page at a time", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.list).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      { cursor: null },
    );
    expect(body.conversations).toHaveLength(1);
    expect(body.nextCursor).toBe("next-page");
  });

  it("passes the cursor through, and never searches over GET", async () => {
    await GET(request("?cursor=abc_DEF-1&q=priya"));
    expect(holder.list).toHaveBeenCalledWith(expect.anything(), {
      cursor: "abc_DEF-1",
    });
  });

  it("answers 400 for a cursor the server refuses", async () => {
    holder.list.mockRejectedValueOnce(
      new MinkRequestError(
        "invalid_cursor",
        "That list of chats is out of date. Close and reopen your chats.",
        400,
      ),
    );
    const response = await GET(request("?cursor=%25%25"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_cursor" });
  });

  it("is unavailable while the private Mink flag is off", async () => {
    holder.enabled = false;
    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("rate limits history reads per actor", async () => {
    holder.allowed = false;
    const response = await GET(request());

    expect(response.status).toBe(429);
    expect(holder.list).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledWith("mink-history:store-1:admin-1", {
      max: 60,
      windowSeconds: 60,
    });
  });
});
