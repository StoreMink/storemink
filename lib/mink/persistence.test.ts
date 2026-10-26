import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "@/app/actions/_test-helpers";
import { minkConversations } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { startMinkRun } from "./persistence";
import type { MinkActorContext } from "./types";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const actor = {
  storeId: STORE,
  adminId: "owner",
  requestId: "request-1",
  draftingEnabled: false,
} as MinkActorContext;

const compiled = (fragment: unknown) =>
  new PgDialect().sqlToQuery(fragment as SQL).sql;

let mock: ReturnType<typeof makeDbMock>;

function useDb(options: Parameters<typeof makeDbMock>[0] = {}) {
  mock = makeDbMock(options);
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
}

/** The update of the chat row that records the merchant's message (the last one). */
function conversationUpdate() {
  // Each db.update(table).set(values) records one entry in each list.
  const index = mock.calls.update.lastIndexOf(minkConversations);
  expect(index).toBeGreaterThanOrEqual(0);
  return mock.calls.set[index] as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(withService).mockReset();
});

describe("starting a Mink run", () => {
  it("★ a new chat deletes nothing and takes no per-admin lock, however many chats exist", async () => {
    useDb({ returningQueue: [[{ id: CHAT }], [{ id: "run-1" }]] });
    const started = await startMinkRun({
      actor,
      message: "How many orders today?",
      model: "fixture",
    });
    expect(started.conversationId).toBe(CHAT);
    expect(mock.calls.offset).toEqual([]);
    expect(mock.calls.delete).toEqual([]);
    for (const query of mock.calls.execute) {
      for (const value of sqlParamValues(query)) {
        expect(String(value)).not.toMatch(/^mink-conversations:/);
      }
    }
  });

  it("★ sending a message keeps a new chat 90 days from now", async () => {
    useDb({ returningQueue: [[{ id: CHAT }], [{ id: "run-1" }]] });
    await startMinkRun({ actor, message: "Hello", model: "fixture" });
    const set = conversationUpdate();
    expect(set.lastMessageAt).toEqual(expect.any(String));
    expect(compiled(set.expiresAt)).toBe("now() + make_interval(days => 90)");
  });

  it("★ sending a message in a continued chat keeps it 90 days from now", async () => {
    useDb({
      selectQueue: [[{ id: CHAT }], []],
      returningQueue: [[{ id: "run-1" }]],
    });
    await startMinkRun({
      actor,
      conversationId: CHAT,
      message: "And yesterday?",
      model: "fixture",
    });
    // Its own chat's lock, never the old per-admin one.
    expect(sqlParamValues(mock.calls.execute[0])).toEqual([
      `mink-conversation:${CHAT}`,
    ]);
    const set = conversationUpdate();
    expect(compiled(set.expiresAt)).toBe("now() + make_interval(days => 90)");
    expect(mock.calls.delete).toEqual([]);
  });

  it("refuses a chat that is not the actor's listed chat", async () => {
    useDb({ selectQueue: [[]] });
    await expect(
      startMinkRun({
        actor,
        conversationId: CHAT,
        message: "Hi",
        model: "fixture",
      }),
    ).rejects.toMatchObject({ code: "conversation_not_found", status: 404 });
    expect(sqlParamValues(mock.calls.where[0])).toEqual([
      CHAT,
      STORE,
      "owner",
      "active",
      expect.any(String),
    ]);
  });
});
