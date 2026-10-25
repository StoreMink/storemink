import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "@/app/actions/_test-helpers";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { closeStaleMinkRuns } from "./persistence";
import { MAX_RUN_BUDGET_MS } from "./tools/registry";
import type { MinkActorContext } from "./types";
import {
  MINK_STALE_RUN_MS,
  deleteMinkConversation,
  getMinkConversation,
  listMinkConversations,
  staleMinkRunCondition,
} from "./conversation-history";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
// Opening history must not load mutation tooling, even if it is unavailable.
vi.mock("./drafts", () => {
  throw new Error("History loaded draft execution dependencies");
});
// ★ The failure record (which loads drafts) is reached only for a dead run,
//   by a dynamic import: mocked here so a test can see it called.
vi.mock("./persistence", () => ({
  closeStaleMinkRuns: vi.fn(async () => ({ closed: 1, failed: 0 })),
}));

/** The SQL a fragment compiles to: the db mock never parses SQL. */
const compiled = (fragment: unknown) =>
  new PgDialect().sqlToQuery(fragment as SQL).sql;

const actor = { storeId: "store-a", adminId: "admin-a" } as MinkActorContext;
let mock: ReturnType<typeof makeDbMock>;

beforeEach(() => {
  mock = makeDbMock();
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
  vi.mocked(closeStaleMinkRuns).mockClear();
  vi.mocked(logError).mockClear();
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
    // ★ B4: a failed or stopped run shows only when its record kept an answer.
    expect(sqlParamValues(mock.calls.innerJoin[0][1])).toEqual(
      expect.arrayContaining([
        "failed",
        "cancelled",
        JSON.stringify({ interrupted: true }),
      ]),
    );
    expect(sqlParamValues(mock.calls.leftJoin[0][1])).toEqual([
      "store-a",
      "admin-a",
    ]);
    expect(mock.calls.limit).toEqual([1, 50]);
  });

  it("refuses deletion while a scoped run is still running", async () => {
    // No dead run; a young one is running.
    mock = makeDbMock({ selectQueue: [[], [{ id: "running-a" }]] });
    await expect(
      deleteMinkConversation(actor, "conversation-a"),
    ).rejects.toMatchObject({ code: "conversation_busy", status: 409 });
    expect(mock.calls.delete).toHaveLength(0);
    // ★ A run within its limit is never closed.
    expect(closeStaleMinkRuns).not.toHaveBeenCalled();
  });

  it("★ B7: closes a dead run of the actor's chat first, then deletes", async () => {
    mock = makeDbMock({
      selectQueue: [[{ id: "dead-run" }], []],
      returning: [{ id: "conversation-a" }],
    });
    await deleteMinkConversation(actor, "conversation-a");
    expect(closeStaleMinkRuns).toHaveBeenCalledWith({
      storeId: "store-a",
      adminId: "admin-a",
      conversationId: "conversation-a",
    });
    expect(mock.calls.delete).toHaveLength(1);
    // The dead-run read: this store, this chat, this admin, and the stale rule.
    const deadRead = mock.calls.where[0];
    expect(sqlParamValues(deadRead)).toEqual([
      "store-a",
      "conversation-a",
      "admin-a",
      MINK_STALE_RUN_MS,
      MINK_STALE_RUN_MS,
    ]);
    expect(compiled(deadRead)).toContain(`"mink_runs"."status" = 'running'`);
  });

  it("B7: a dead run that could not be closed keeps the chat busy, and is logged", async () => {
    vi.mocked(closeStaleMinkRuns).mockRejectedValueOnce(new Error("down"));
    mock = makeDbMock({
      selectQueue: [[{ id: "dead-run" }], [{ id: "dead-run" }]],
    });
    await expect(
      deleteMinkConversation(actor, "conversation-a"),
    ).rejects.toMatchObject({ code: "conversation_busy", status: 409 });
    expect(logError).toHaveBeenCalledWith(
      "mink.history: dead runs not closed",
      expect.any(Error),
      { storeId: "store-a", conversationId: "conversation-a" },
    );
    expect(mock.calls.delete).toHaveLength(0);
  });

  it("★ refuses deletion while the conversation holds a live storefront revamp", async () => {
    // Its runs cascade to the card's draft (persistence.local.test.ts).
    mock = makeDbMock({ executeQueue: [[], [{ live: true }]] });
    await expect(
      deleteMinkConversation(actor, "conversation-a"),
    ).rejects.toMatchObject({ code: "conversation_has_redesign", status: 409 });
    expect(mock.calls.delete).toHaveLength(0);
    expect(sqlParamValues(mock.calls.execute[1])).toEqual([
      "conversation-a",
      "store-a",
      "queued",
      "running",
      "ready",
    ]);
  });

  it("deletes only the actor's conversation after acquiring its lock", async () => {
    mock = makeDbMock({ returning: [{ id: "conversation-a" }] });
    await deleteMinkConversation(actor, "conversation-a");
    expect(sqlParamValues(mock.calls.execute[0])).toEqual([
      "mink-conversation:conversation-a",
    ]);
    // where[0] is the dead-run read, where[1] the running check.
    expect(sqlParamValues(mock.calls.where[2])).toEqual([
      "conversation-a",
      "store-a",
      "admin-a",
    ]);
    expect(closeStaleMinkRuns).not.toHaveBeenCalled();
  });
});

describe("B7: the stale-run rule", () => {
  it("★ is the longest run budget plus ten minutes", () => {
    expect(MINK_STALE_RUN_MS).toBe(MAX_RUN_BUDGET_MS + 10 * 60_000);
  });

  it("★ needs the run still running, started past the window, and no tool call started within it", () => {
    const text = compiled(staleMinkRunCondition());
    expect(text).toContain(`"mink_runs"."status" = 'running'`);
    expect(text).toContain(`"mink_runs"."started_at" < now() -`);
    expect(text).toMatch(/and not exists \(\s*select 1 from "mink_tool_calls"/);
    expect(text).toContain(`"mink_tool_calls"."run_id" = "mink_runs"."id"`);
    expect(text).toContain(
      `"mink_tool_calls"."store_id" = "mink_runs"."store_id"`,
    );
    expect(text).toContain(`"mink_tool_calls"."started_at" >= now() -`);
    expect(sqlParamValues(staleMinkRunCondition())).toEqual([
      MINK_STALE_RUN_MS,
      MINK_STALE_RUN_MS,
    ]);
  });
});
