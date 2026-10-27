import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  enabled: true,
  actor: vi.fn(),
  search: vi.fn(),
  allowed: true,
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: holder.enabled })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/conversation-history", () => ({
  searchMinkConversations: holder.search,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.allowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { MinkRequestError } from "@/lib/mink/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import * as route from "./route";

const { POST } = route;
const URL_ = "https://echos.storemink.com/api/mink/conversations/search";

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Every logged value, flattened, to prove the words never reach a log. */
function logged(): string {
  return JSON.stringify([
    vi.mocked(logWarn).mock.calls,
    vi.mocked(logError).mock.calls,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  holder.enabled = true;
  holder.allowed = true;
  holder.actor.mockResolvedValue({ storeId: "store-1", adminId: "admin-1" });
  holder.search.mockResolvedValue({ conversations: [], nextCursor: null });
});

describe("POST /api/mink/conversations/search", () => {
  it("★ refuses a foreign origin before reading anything", async () => {
    const response = await POST(
      post({ q: "priya" }, { origin: "https://attacker.example" }),
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.search).not.toHaveBeenCalled();
  });

  it("★ searches the trimmed, collapsed words of the body, cut to 80 characters", async () => {
    const long = `  Priya   ${"x".repeat(200)}  `;
    const response = await POST(post({ q: long, cursor: "next-1" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const [actor, options] = holder.search.mock.calls[0];
    expect(actor).toMatchObject({ storeId: "store-1", adminId: "admin-1" });
    expect(options.cursor).toBe("next-1");
    expect(options.query.startsWith("Priya x")).toBe(true);
    expect(Array.from(options.query)).toHaveLength(80);
    expect(await response.json()).toEqual({
      conversations: [],
      nextCursor: null,
    });
  });

  it("★ keeps the words out of the URL and every log line", async () => {
    holder.search.mockRejectedValueOnce(
      Object.assign(new Error("Failed query: ... params: priya,9876543210"), {
        code: "XX000",
      }),
    );
    const response = await POST(post({ q: "priya 9876543210" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Mink AI couldn't search your chats.",
    });
    expect(logError).toHaveBeenCalledWith(
      "mink.history: search failed",
      undefined,
      expect.objectContaining({ code: "XX000" }),
    );
    expect(logged()).not.toContain("priya");
    expect(logged()).not.toContain("9876543210");
  });

  it("refuses a body that is not JSON, too large, or whose q is not text", async () => {
    for (const request of [
      post("not json"),
      post({ q: 42 }),
      post({ q: "ok", cursor: 7 }),
      post([1, 2]),
      post({ q: "x".repeat(2100) }),
    ]) {
      const response = await POST(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Type what to search for.",
        code: "invalid_search",
      });
    }
    expect(holder.search).not.toHaveBeenCalled();
  });

  it(
    "★ F9: stops reading a body that declares no size once it passes 2 KB",
    { timeout: 3000 },
    async () => {
      // 64 KB in 1 KB pieces, with no Content-Length (a chunked upload).
      let pulled = 0;
      const large = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
          if (pulled === 64) controller.close();
        },
      });
      const request = new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: large,
        duplex: "half",
      } as RequestInit);
      expect(request.headers.get("content-length")).toBeNull();
      const response = await POST(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Type what to search for.",
        code: "invalid_search",
      });
      expect(pulled).toBeLessThanOrEqual(5);
      expect(holder.actor).not.toHaveBeenCalled();
      expect(holder.search).not.toHaveBeenCalled();
    },
  );

  it("is limited in its own bucket", async () => {
    holder.allowed = false;
    const response = await POST(post({ q: "coupon" }));
    expect(response.status).toBe(429);
    expect(rateLimit).toHaveBeenCalledWith(
      "mink-history-search:store-1:admin-1",
      { max: 60, windowSeconds: 60 },
    );
    expect(holder.search).not.toHaveBeenCalled();
  });

  it("passes a busy search through as 409, for the client to try again", async () => {
    holder.search.mockRejectedValueOnce(
      new MinkRequestError(
        "history_search_busy",
        "Still searching your chats. Try again in a moment.",
        409,
      ),
    );
    const response = await POST(post({ q: "coupon" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Still searching your chats. Try again in a moment.",
      code: "history_search_busy",
    });
  });

  it("★ answers a search that outran its time limit in plain words", async () => {
    holder.search.mockRejectedValueOnce(
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014",
      }),
    );
    const response = await POST(post({ q: "co" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Searching your chats took too long. Try a longer word.",
      code: "history_search_timeout",
    });
  });

  it("is unavailable while Mink is off, and offers no GET", async () => {
    holder.enabled = false;
    const response = await POST(post({ q: "coupon" }));
    expect(response.status).toBe(404);
    expect(holder.actor).not.toHaveBeenCalled();
    // Next.js answers 405 for a method the route does not export.
    expect("GET" in route).toBe(false);
  });
});
