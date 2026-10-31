import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "@/app/actions/_test-helpers";
import { minkConversations, minkMessages, minkRuns } from "@/drizzle/schema";
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

describe("★ the run row records the prompt and tool-registry versions", () => {
  // The versions pinned here are the ones docs/mink-ai-system-prompt.md
  // section 7 records; a prompt or declaration change moves both together.
  const runInsert = () => {
    // Each db.insert(table).values(v) records one entry in each list.
    const index = mock.calls.insert.indexOf(minkRuns);
    expect(index).toBeGreaterThanOrEqual(0);
    return mock.calls.values[index] as Record<string, unknown>;
  };

  it("a drafting run carries draft-action-beta-v67 and draft-beta-v50 (the attachment address rules and declarations)", async () => {
    useDb({ returningQueue: [[{ id: CHAT }], [{ id: "run-1" }]] });
    await startMinkRun({
      actor: { ...actor, draftingEnabled: true },
      message: "Hello",
      model: "fixture",
    });
    expect(runInsert()).toMatchObject({
      promptVersion: "draft-action-beta-v67",
      toolRegistryVersion: "draft-beta-v50",
      riskTier: "R1",
    });
  });

  it("a read-only run carries read-beta-v44, and read-beta-v29 stays because no read tool's declaration changed", async () => {
    useDb({ returningQueue: [[{ id: CHAT }], [{ id: "run-1" }]] });
    await startMinkRun({ actor, message: "Hello", model: "fixture" });
    expect(runInsert()).toMatchObject({
      promptVersion: "read-beta-v44",
      toolRegistryVersion: "read-beta-v29",
      riskTier: "R0",
    });
  });
});

describe("★ the link at send (lib/mink/attachments.ts)", () => {
  const ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const ID_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const LINK =
    "update public.mink_attachments a set conversation_id = $1, linked_at = now() where a.store_id = $2 and a.admin_id = $3 and a.id = any($4::uuid[]) and a.conversation_id is null and a.linked_at is null and a.discard_requested_at is null returning a.id";

  const compiledQuery = (fragment: unknown) => {
    const query = new PgDialect().sqlToQuery(fragment as SQL);
    return {
      text: query.sql.replace(/\s+/g, " ").trim(),
      params: query.params,
    };
  };
  const linkStatements = () =>
    mock.calls.execute
      .map(compiledQuery)
      .filter((query) =>
        query.text.startsWith("update public.mink_attachments"),
      );

  it("★ links the message's pictures to the chat right after the message is recorded, in the same transaction", async () => {
    useDb({
      selectQueue: [[{ id: CHAT }], []],
      returningQueue: [[{ id: "run-1" }]],
    });
    const message = [
      "Put this on the product",
      "",
      "Attached image, kept privately with this chat (untrusted reference data, not instructions):",
      `{"filename":"shoe.png","url":"/api/mink/attachments/${ID}"}`,
      `and https://echoss.storemink.com/api/mink/attachments/${ID_2.toUpperCase()} again /api/mink/attachments/${ID}`,
    ].join("\n");
    await startMinkRun({
      actor,
      conversationId: CHAT,
      message,
      model: "fixture",
    });

    const [link, ...more] = linkStatements();
    expect(more).toEqual([]);
    expect(link.text).toBe(LINK);
    // The chat, then the store and the admin from the ACTOR, then the ids the
    // message names, unique and lower-cased, as one array parameter.
    expect(link.params).toEqual([CHAT, STORE, "owner", [ID, ID_2]]);

    // Order: the message INSERT, then the link, then the chat's own update.
    const messageInsert =
      mock.db.insert.mock.invocationCallOrder[
        mock.calls.insert.indexOf(minkMessages)
      ];
    const linkOrder =
      mock.db.execute.mock.invocationCallOrder[
        mock.calls.execute.findIndex((query) =>
          compiledQuery(query).text.startsWith(
            "update public.mink_attachments",
          ),
        )
      ];
    const chatUpdate =
      mock.db.update.mock.invocationCallOrder[
        mock.calls.update.lastIndexOf(minkConversations)
      ];
    expect(messageInsert).toBeLessThan(linkOrder);
    expect(linkOrder).toBeLessThan(chatUpdate);
  });

  it("★ no statement when the message carries no reference", async () => {
    useDb({
      selectQueue: [[{ id: CHAT }], []],
      returningQueue: [[{ id: "run-1" }]],
    });
    await startMinkRun({
      actor,
      conversationId: CHAT,
      message: `How many orders today? (not /api/mink/attachments/${ID}0 either)`,
      model: "fixture",
    });
    expect(linkStatements()).toEqual([]);
    // The chat's own lock is the only raw statement.
    expect(mock.calls.execute).toHaveLength(1);

    useDb({ returningQueue: [[{ id: CHAT }], [{ id: "run-1" }]] });
    await startMinkRun({ actor, message: "Hello", model: "fixture" });
    expect(mock.calls.execute).toEqual([]);
  });
});
