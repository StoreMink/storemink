import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "@/app/actions/_test-helpers";
import { withService } from "@/lib/db/client";
import type { MinkActorContext } from "./types";
import {
  deleteMinkConversation,
  getMinkConversation,
  listMinkConversations,
} from "./conversation-history";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
// Opening history must not load mutation tooling, even if it is unavailable.
vi.mock("./drafts", () => {
  throw new Error("History loaded draft execution dependencies");
});

const actor = { storeId: "store-a", adminId: "admin-a" } as MinkActorContext;
let mock: ReturnType<typeof makeDbMock>;

beforeEach(() => {
  mock = makeDbMock();
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
});

describe("independent conversation history", () => {
  it("lists only the actor's active, unexpired conversations with bounded retention", async () => {
    await listMinkConversations(actor);
    expect(sqlParamValues(mock.calls.where[0])).toEqual([
      "store-a",
      "admin-a",
      "active",
      expect.any(String),
    ]);
    expect(mock.calls.limit).toEqual([10]);
  });

  it("rejects a conversation absent from the actor's scope before reading messages", async () => {
    await expect(
      getMinkConversation(actor, "conversation-b"),
    ).rejects.toMatchObject({
      code: "conversation_not_found",
      status: 404,
    });
    expect(sqlParamValues(mock.calls.where[0])).toEqual([
      "conversation-b",
      "store-a",
      "admin-a",
      "active",
      expect.any(String),
    ]);
    expect(mock.calls.select).toHaveLength(1);
  });

  it("loads chronological successful messages and actor-scoped feedback", async () => {
    mock = makeDbMock({
      selectQueue: [
        [{ id: "conversation-a", title: "Products" }],
        [
          {
            id: "reply",
            role: "assistant",
            content: { text: "Done", artifacts: [] },
            runId: "run-a",
            createdAt: "2026-10-05",
            feedbackRating: "helpful",
            feedbackIssueCategory: null,
          },
          {
            id: "prompt",
            role: "user",
            content: { text: "Help" },
            runId: "run-a",
            createdAt: "2026-10-04",
            feedbackRating: null,
            feedbackIssueCategory: null,
          },
        ],
      ],
    });
    const result = await getMinkConversation(actor, "conversation-a");
    expect(result.messages.map((m) => m.id)).toEqual(["prompt", "reply"]);
    expect(result.messages[1].feedback).toEqual({
      rating: "helpful",
      issueCategory: null,
    });
    expect(sqlParamValues(mock.calls.innerJoin[0][1])).toContain("succeeded");
    expect(sqlParamValues(mock.calls.leftJoin[0][1])).toEqual([
      "store-a",
      "admin-a",
    ]);
    expect(mock.calls.limit).toEqual([1, 50]);
  });

  it("refuses deletion while a scoped run is still running", async () => {
    mock = makeDbMock({ selectQueue: [[{ id: "running-a" }]] });
    await expect(
      deleteMinkConversation(actor, "conversation-a"),
    ).rejects.toMatchObject({ code: "conversation_busy", status: 409 });
    expect(mock.calls.delete).toHaveLength(0);
  });

  it("deletes only the actor's conversation after acquiring its lock", async () => {
    mock = makeDbMock({ returning: [{ id: "conversation-a" }] });
    await deleteMinkConversation(actor, "conversation-a");
    expect(sqlParamValues(mock.calls.execute[0])).toEqual([
      "mink-conversation:conversation-a",
    ]);
    expect(sqlParamValues(mock.calls.where[1])).toEqual([
      "conversation-a",
      "store-a",
      "admin-a",
    ]);
  });
});
