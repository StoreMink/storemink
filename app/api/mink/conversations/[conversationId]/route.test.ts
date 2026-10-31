import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  enabled: true,
  actor: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  allowed: true,
  after: vi.fn(),
  purge: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: holder.after,
}));
vi.mock("@/lib/mink/attachments", () => ({
  purgeStoreMinkAttachments: holder.purge,
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: holder.enabled })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/conversation-history", () => ({
  getMinkConversation: holder.get,
  deleteMinkConversation: holder.delete,
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
import { DELETE, GET } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  holder.enabled = true;
  holder.allowed = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
  });
  holder.get.mockResolvedValue({
    id: ID,
    title: "Published products",
    messages: [
      { id: "message-1", role: "user", text: "How many?" },
      { id: "message-2", role: "assistant", text: "**14** products." },
    ],
    earlierCursor: "earlier-page",
  });
  holder.delete.mockResolvedValue("deleted");
  holder.list.mockResolvedValue({ conversations: [], nextCursor: null });
});

describe("GET /api/mink/conversations/[conversationId]", () => {
  it("loads a conversation through the trusted actor scope", async () => {
    const response = await GET(request(), context(ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(holder.get).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      ID,
      { before: null },
    );
    expect(body.conversation.messages).toHaveLength(2);
    expect(body.conversation.earlierCursor).toBe("earlier-page");
  });

  it("reads earlier messages below the cursor it is given", async () => {
    await GET(request({}, "?before=abc_DEF-1"), context(ID));
    expect(holder.get).toHaveBeenCalledWith(expect.anything(), ID, {
      before: "abc_DEF-1",
    });
  });

  it("answers 400 for an earlier-messages cursor the server refuses", async () => {
    holder.get.mockRejectedValueOnce(
      new MinkRequestError(
        "invalid_cursor",
        "That list of chats is out of date. Close and reopen your chats.",
        400,
      ),
    );
    const response = await GET(request({}, "?before=%25"), context(ID));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_cursor" });
  });

  it("rejects an invalid id before resolving dashboard authority", async () => {
    const response = await GET(request(), context("not-a-uuid"));

    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("does not expose history while Mink is disabled", async () => {
    holder.enabled = false;
    const response = await GET(request(), context(ID));

    expect(response.status).toBe(404);
    expect(holder.get).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/mink/conversations/[conversationId]", () => {
  it("deletes through the trusted actor scope and returns remaining history", async () => {
    const response = await DELETE(request(), context(ID));

    expect(response.status).toBe(200);
    expect(holder.delete).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      ID,
    );
    // ★ The first page, for a browser still on the previous bundle.
    expect(holder.list).toHaveBeenCalledOnce();
    expect(holder.list).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
    );
    expect(await response.json()).toEqual({
      conversations: [],
      nextCursor: null,
    });
  });

  it("passes a still-building redesign's refusal through in its own words", async () => {
    const message =
      "A storefront redesign from this chat is still being made. Wait for it to finish, or stop it from its card, then delete this chat.";
    holder.delete.mockRejectedValueOnce(
      new MinkRequestError("conversation_has_redesign", message, 409),
    );
    const response = await DELETE(request(), context(ID));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: message,
      code: "conversation_has_redesign",
    });
    expect(holder.list).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin deletion before resolving dashboard authority", async () => {
    const response = await DELETE(
      request({ origin: "https://attacker.example" }),
      context(ID),
    );

    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.delete).not.toHaveBeenCalled();
    expect(holder.after).not.toHaveBeenCalled();
  });

  it("★ schedules the store's attachment purge after a successful delete, outside the response", async () => {
    const response = await DELETE(request(), context(ID));
    expect(response.status).toBe(200);
    // Scheduled, not run: the response goes out first.
    expect(holder.after).toHaveBeenCalledOnce();
    expect(holder.purge).not.toHaveBeenCalled();
    const scheduled = holder.after.mock.calls[0][0] as () => unknown;
    await scheduled();
    expect(holder.purge).toHaveBeenCalledOnce();
    expect(holder.purge).toHaveBeenCalledWith("store-1");
    // The purge was scheduled after the delete committed, never before it.
    expect(holder.delete.mock.invocationCallOrder[0]).toBeLessThan(
      holder.after.mock.invocationCallOrder[0],
    );
  });

  it("★ schedules no purge when the delete is refused", async () => {
    holder.delete.mockRejectedValueOnce(
      new MinkRequestError(
        "conversation_busy",
        "Mink AI is still answering in this conversation. Wait for the reply to finish, then delete it.",
        409,
      ),
    );
    const response = await DELETE(request(), context(ID));
    expect(response.status).toBe(409);
    expect(holder.after).not.toHaveBeenCalled();
    expect(holder.purge).not.toHaveBeenCalled();
  });
});

function request(headers: Record<string, string> = {}, query = "") {
  return new Request(
    `https://echos.storemink.com/api/mink/conversations/${ID}${query}`,
    { headers },
  );
}

function context(conversationId: string) {
  return { params: Promise.resolve({ conversationId }) };
}
