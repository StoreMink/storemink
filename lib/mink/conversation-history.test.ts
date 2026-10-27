import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "@/app/actions/_test-helpers";
import { minkConversations, minkMessages } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { retireMinkConversation } from "./conversation-retire";
import { MINK_CSV_MARKER } from "./csv-input";
import { REVIEWED_DOCUMENT_MARKER } from "./document-input";
import { SAVED_MEDIA_MARKER } from "./media-attachment";
import { closeStaleMinkRuns } from "./persistence";
import { MAX_RUN_BUDGET_MS } from "./tools/registry";
import type { MinkActorContext } from "./types";
import {
  MINK_STALE_RUN_MS,
  buildingRevampOfConversation,
  decodeHistoryCursor,
  deleteMinkConversation,
  encodeHistoryCursor,
  getMinkConversation,
  historyPageQuery,
  historySearchQuery,
  listMinkConversations,
  searchMinkConversations,
  staleMinkRunCondition,
  visibleMinkRun,
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
// The retirement statements are pinned in conversation-retire.test.ts.
vi.mock("./conversation-retire", () => ({
  retireMinkConversation: vi.fn(async () => "deleted"),
}));

/** The SQL a fragment compiles to: the db mock never parses SQL. */
const compiled = (fragment: unknown) =>
  new PgDialect()
    .sqlToQuery(fragment as SQL)
    .sql.replace(/\s+/g, " ")
    .trim();
const paramsOf = (fragment: unknown) =>
  new PgDialect().sqlToQuery(fragment as SQL).params;

const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const actor = { storeId: STORE, adminId: "admin-a" } as MinkActorContext;
let mock: ReturnType<typeof makeDbMock>;

function useDb(options: Parameters<typeof makeDbMock>[0] = {}) {
  mock = makeDbMock(options);
  vi.mocked(withService).mockImplementation(async (fn) => fn(mock.db));
}

/** A History row as Postgres returns it (timestamps as its own text). */
function chatRow(index: number) {
  const id = `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return {
    id,
    title: `Chat ${index}`,
    lastMessageAt: `2026-10-26 07:00:${String(59 - index).padStart(2, "0")}.123456+00`,
    createdAt: "2026-10-20 07:00:00.5+00",
    hasRedesignCard: index === 1,
  };
}

beforeEach(() => {
  useDb();
  vi.mocked(closeStaleMinkRuns).mockClear();
  vi.mocked(logError).mockClear();
  vi.mocked(retireMinkConversation).mockClear();
});

describe("History cursors", () => {
  it("★ round-trip Postgres's own timestamp text and an id, microseconds included", () => {
    const at = "2026-10-26 07:07:12.123456+05:30";
    const cursor = encodeHistoryCursor(at, CHAT);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeHistoryCursor(cursor)).toEqual({ at, id: CHAT });
    expect(decodeHistoryCursor(null)).toBeNull();
    expect(decodeHistoryCursor("")).toBeNull();
  });

  it("★ refuses a cursor that is malformed, too long or names no chat id", () => {
    const bad = [
      "not base64!",
      Buffer.from("[1,2]").toString("base64url"),
      Buffer.from(JSON.stringify(["yesterday", CHAT])).toString("base64url"),
      Buffer.from(
        JSON.stringify(["2026-10-26 07:00:00+00", "not-a-uuid"]),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify(["2026-10-26 07:00:00+00'; drop table x;--", CHAT]),
      ).toString("base64url"),
      encodeHistoryCursor("2026-10-26 07:00:00+00", CHAT) + "A".repeat(200),
    ];
    for (const cursor of bad) {
      expect(() => decodeHistoryCursor(cursor), cursor).toThrow(
        expect.objectContaining({ code: "invalid_cursor", status: 400 }),
      );
    }
  });
});

describe("the History list", () => {
  it("★ lists only the actor's listed chats, newest activity first, a page and one more", () => {
    const text = compiled(
      historyPageQuery({ storeId: STORE, adminId: "admin-a", cursor: null }),
    );
    expect(text).toContain("where c.store_id = $1 and c.admin_id = $2");
    expect(text).toContain("c.status = 'active' and c.expires_at > now()");
    expect(text).toContain("order by c.last_message_at desc, c.id desc");
    expect(text).toMatch(/limit 31$/);
    expect(text).toMatch(
      /exists \( select 1 from public\.mink_revamps v where v\.conversation_id = c\.id and v\.store_id = c\.store_id and \(v\.status = 'ready' or \(v\.status = 'superseded' and v\.applied_at is not null\)\) \) as "hasRedesignCard"/,
    );
    expect(text).not.toContain("(c.last_message_at, c.id) <");
  });

  it("★ continues strictly below the cursor's chat", () => {
    const query = historyPageQuery({
      storeId: STORE,
      adminId: "admin-a",
      cursor: { at: "2026-10-26 07:00:00.123456+00", id: CHAT },
    });
    expect(compiled(query)).toContain(
      "and (c.last_message_at, c.id) < ($3::timestamptz, $4::uuid)",
    );
    expect(paramsOf(query)).toEqual([
      STORE,
      "admin-a",
      "2026-10-26 07:00:00.123456+00",
      CHAT,
    ]);
  });

  it("returns 30 chats and a cursor for the 30th when a 31st exists", async () => {
    const rows = Array.from({ length: 31 }, (_, index) => chatRow(index + 1));
    useDb({ executeQueue: [rows] });
    const page = await listMinkConversations(actor);
    expect(page.conversations).toHaveLength(30);
    expect(page.conversations[0]).toEqual({
      id: rows[0].id,
      title: "Chat 1",
      lastMessageAt: rows[0].lastMessageAt,
      createdAt: rows[0].createdAt,
      hasRedesignCard: true,
    });
    expect(page.conversations[1].hasRedesignCard).toBe(false);
    expect(decodeHistoryCursor(page.nextCursor)).toEqual({
      at: rows[29].lastMessageAt,
      id: rows[29].id,
    });
    expect(paramsOf(mock.calls.execute[0])).toEqual([STORE, "admin-a"]);
  });

  it("has no next page when 30 or fewer chats exist", async () => {
    useDb({ executeQueue: [[chatRow(1), chatRow(2)]] });
    const page = await listMinkConversations(actor, { cursor: null });
    expect(page.conversations.map((row) => row.title)).toEqual([
      "Chat 1",
      "Chat 2",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("★ refuses a bad cursor before any query", async () => {
    await expect(
      listMinkConversations(actor, { cursor: "%%%" }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(withService).not.toHaveBeenCalled();
  });
});

/** The lexemes Postgres's parser returns for each searched word (mocked). */
function lexemeRows(...words: [string, string[]][]) {
  return words.map(([word, lexemes], index) => ({
    ord: index + 1,
    word,
    lexemes,
  }));
}

describe("History search", () => {
  it("★ runs one search at a time per admin, under a statement timeout, before searching", async () => {
    useDb({
      executeQueue: [
        [],
        [{ locked: true }],
        [],
        lexemeRows(["zebracode", ["zebracode"]], ["coupon", ["coupon"]]),
        [chatRow(1)],
      ],
    });
    await searchMinkConversations(actor, { query: "Zebracode coupon" });
    expect(compiled(mock.calls.execute[0])).toBe(
      "set local statement_timeout = '5s'",
    );
    expect(compiled(mock.calls.execute[1])).toContain(
      "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked",
    );
    expect(paramsOf(mock.calls.execute[1])).toEqual([
      `mink-history-search:${STORE}:admin-a`,
    ]);
    expect(compiled(mock.calls.execute[4])).toMatch(/^with hits as \(/);
  });

  it("★ F8: keeps the planner on the message index for this transaction, after the lock", async () => {
    useDb({
      executeQueue: [
        [],
        [{ locked: true }],
        [],
        lexemeRows(["order", ["order"]]),
        [],
      ],
    });
    await searchMinkConversations(actor, { query: "order" });
    expect(compiled(mock.calls.execute[2])).toBe(
      "select set_config('enable_seqscan', 'off', true), set_config('jit', 'off', true)",
    );
  });

  it("★ F6: asks Postgres's own parser for each word's lexemes, and searches those", async () => {
    useDb({
      executeQueue: [
        [],
        [{ locked: true }],
        [],
        lexemeRows(
          ["98765-43210", ["-43210", "98765"]],
          ["priya.sharma@gm", ["gm", "priya.sharma"]],
          ["t-shirt", ["shirt", "t", "t-shirt"]],
        ),
        [],
      ],
    });
    await searchMinkConversations(actor, {
      query: "98765-43210 Priya.Sharma@gm t-shirt",
    });
    const lexemeQuery = mock.calls.execute[3];
    expect(compiled(lexemeQuery)).toContain(
      "unnest(to_tsvector('simple', w.word))",
    );
    expect(compiled(lexemeQuery)).toContain(
      "from unnest($1::text[]) with ordinality as w(word, ord)",
    );
    // Words are cut at spaces only: the parser decides the rest.
    expect(paramsOf(lexemeQuery)).toEqual([
      ["98765-43210", "priya.sharma@gm", "t-shirt"],
    ]);
    const params = paramsOf(mock.calls.execute[4]);
    expect(params).toContain(
      "('-43210':* & '98765':* | '98765-43210':*) & ('priya.sharma':* & 'gm':* | 'priya.sharma@gm':*) & ('t-shirt':* & 'shirt':*)",
    );
    expect(params).toContainEqual([
      "%98765-43210%",
      "%priya.sharma@gm%",
      "%t-shirt%",
    ]);
  });

  it("★ a second search while one runs is refused as busy and searches nothing", async () => {
    useDb({ executeQueue: [[], [{ locked: false }]] });
    await expect(
      searchMinkConversations(actor, { query: "coupon" }),
    ).rejects.toMatchObject({ code: "history_search_busy", status: 409 });
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("★ without a searchable word, runs no SQL and finds nothing (never the plain list)", async () => {
    for (const query of ["", "a b", "??", "🙂"]) {
      await expect(searchMinkConversations(actor, { query })).resolves.toEqual({
        conversations: [],
        nextCursor: null,
      });
    }
    expect(withService).not.toHaveBeenCalled();
  });

  it("★ binds the escaped title patterns as one array, and the built query as tsquery input", async () => {
    useDb({
      executeQueue: [
        [],
        [{ locked: true }],
        [],
        lexemeRows(
          ["50%_off", ["50", "off"]],
          ["a\\b", ["a", "b"]],
          ["ऑर्डर", ["ऑर्डर"]],
        ),
        [],
      ],
    });
    await searchMinkConversations(actor, { query: "50%_off a\\b ऑर्डर" });
    const params = paramsOf(mock.calls.execute[4]);
    // Words keep every character, so % _ and \ are escaped for ILIKE; a
    // word whose lexemes are all one letter is searched whole.
    expect(params).toContainEqual(["%50\\%\\_off%", "%a\\\\b%", "%ऑर्डर%"]);
    expect(params).toContain(
      "('off':* & '50':* | '50%_off':*) & 'a\\\\b':* & 'ऑर्डर':*",
    );
    expect(compiled(mock.calls.execute[4])).toMatch(
      /c\.title ilike all \(\$\d+::text\[\]\)/,
    );
  });

  it("finds nothing, and runs no search, when the parser left no word to match", async () => {
    useDb({ executeQueue: [[], [{ locked: true }], [], []] });
    await expect(
      searchMinkConversations(actor, { query: "zebra" }),
    ).resolves.toEqual({ conversations: [], nextCursor: null });
    expect(mock.calls.execute).toHaveLength(4);
  });

  it("★ matches and snippets come only from VISIBLE messages of this admin's own listed chats", () => {
    const query = historySearchQuery({
      storeId: STORE,
      adminId: "admin-a",
      cursor: null,
      tsquery: "'zebracode':*",
      patterns: ["%zebracode%"],
    });
    const text = compiled(query);
    // hits joins mink_runs UNALIASED with the one rule, keeping each chat's
    // newest matching visible message; the snippet reads that one message.
    expect(text).toMatch(
      /with hits as \( select distinct on \(m\.conversation_id\) m\.conversation_id, m\.id as message_id from public\.mink_messages m join public\.mink_runs on mink_runs\.id = m\.run_id and mink_runs\.store_id = \$1 and \( "mink_runs"\."status" = 'succeeded' or \("mink_runs"\."status" in \('failed', 'cancelled'\) and exists \( select 1 from "mink_messages" as kept where kept\.run_id = "mink_runs"\."id"/,
    );
    expect(text).toContain(
      "order by m.conversation_id, m.created_at desc, m.id desc ), page as (",
    );
    expect(text).toContain(
      `"mink_runs"."stop_requested_at" is not null and m.role = 'user' and not exists`,
    );
    expect(text).toContain("left join hits h on h.conversation_id = c.id");
    expect(text).toContain("where c.store_id = $");
    expect(text).toMatch(
      /c\.admin_id = \$\d+ and c\.status = 'active' and c\.expires_at > now\(\)/,
    );
    expect(text).toContain("or h.message_id is not null)");
    expect(text).toContain(
      "left join public.mink_messages m on m.id = p.message_id and m.store_id = p.store_id",
    );
    expect(text).toContain(`m.id as "matchMessageId"`);
    expect(text).toMatch(/order by p\.last_message_at desc, p\.id desc$/);
    expect(paramsOf(query)).toContain(
      "MaxFragments=1, MaxWords=14, MinWords=6, StartSel=«, StopSel=», FragmentDelimiter=…",
    );
  });

  it("★ F8: finds ONE store's matches through the store-scoped index, never by a store filter on messages", () => {
    const query = historySearchQuery({
      storeId: STORE,
      adminId: "admin-a",
      cursor: null,
      tsquery: "'th':*",
      patterns: ["%th%"],
    });
    const text = compiled(query);
    const hits = text.slice(0, text.indexOf("), page as ("));
    expect(hits).toMatch(
      /where public\.mink_message_search_vector\(m\.store_id, m\.role, m\.content_json\) @@ \(\$\d+::tsquery && public\.mink_message_search_store\(\$\d+::uuid\)\)/,
    );
    // ★ An indexable store filter on the messages lets the planner read and
    //   parse every message of the store (over a second for 20,000).
    expect(hits).not.toMatch(/m\.store_id = \$/);
    expect(hits).toContain("mink_runs.store_id = $1");
    expect(paramsOf(query).filter((value) => value === STORE)).toHaveLength(3);
  });

  it("★ F16: the snippet reads what the chat shows, through the index's own function", () => {
    const text = compiled(
      historySearchQuery({
        storeId: STORE,
        adminId: "admin-a",
        cursor: null,
        tsquery: "'photo':*",
        patterns: ["%photo%"],
      }),
    );
    expect(text).toMatch(
      /case when m\.id is null then null else ts_headline\('simple', public\.mink_message_search_text\(m\.role, m\.content_json\), \$\d+::tsquery, \$\d+\) end as snippet/,
    );
    expect(text).not.toContain("content_json ->> 'text', 4000");
  });

  it("★ F16: migration 0249 strips exactly the attachment markers the thread turns into file cards", () => {
    const migration = readFileSync(
      "drizzle/migrations/sql/20261026_0249_mink_chat_history_search_index.sql",
      "utf8",
    );
    for (const marker of [
      SAVED_MEDIA_MARKER,
      REVIEWED_DOCUMENT_MARKER,
      MINK_CSV_MARKER,
    ]) {
      // Matched by its words: a message of files alone has lost the
      // marker's opening blank line (lib/mink/conversation-title.ts).
      const words = marker.trim();
      expect(words.length).toBeGreaterThan(40);
      expect(migration).toContain(`'${words.replace(/'/g, "''")}', 1)`);
    }
    expect(migration).toContain(
      "USING gin (public.mink_message_search_vector(store_id, role, content_json))",
    );
  });

  it("refuses to build a search without a title pattern (ILIKE ALL of nothing is true)", () => {
    expect(() =>
      historySearchQuery({
        storeId: STORE,
        adminId: "admin-a",
        cursor: null,
        tsquery: "x:*",
        patterns: [],
      }),
    ).toThrow();
  });

  it("reads the snippet and the matching message's id", async () => {
    useDb({
      executeQueue: [
        [],
        [{ locked: true }],
        [],
        lexemeRows(["zebracode", ["zebracode"]]),
        [
          {
            ...chatRow(1),
            snippet: "Your «zebracode» coupon",
            matchMessageId: CHAT,
          },
          { ...chatRow(2), snippet: null, matchMessageId: null },
        ],
      ],
    });
    const page = await searchMinkConversations(actor, { query: "zebracode" });
    expect(page.conversations[0]).toMatchObject({
      snippet: "Your «zebracode» coupon",
      matchMessageId: CHAT,
    });
    expect(page.conversations[1]).toMatchObject({
      snippet: null,
      matchMessageId: null,
    });
  });
});

describe("a chat's messages", () => {
  it("rejects a conversation absent from the actor's scope before reading messages or writing", async () => {
    await expect(getMinkConversation(actor, CHAT)).rejects.toMatchObject({
      code: "conversation_not_found",
      status: 404,
    });
    expect(sqlParamValues(mock.calls.where[0])).toEqual([
      CHAT,
      STORE,
      "admin-a",
      "active",
      expect.any(String),
    ]);
    expect(mock.calls.select).toHaveLength(1);
    expect(mock.calls.update).toHaveLength(0);
  });

  it("★ opening a chat keeps it 90 days from now, at most once an hour", async () => {
    useDb({ selectQueue: [[{ id: CHAT, title: "Products" }], []] });
    await getMinkConversation(actor, CHAT);
    expect(mock.calls.update).toEqual([minkConversations]);
    expect(compiled((mock.calls.set[0] as { expiresAt: SQL }).expiresAt)).toBe(
      "now() + make_interval(days => 90)",
    );
    const guard = mock.calls.where[1];
    expect(sqlParamValues(guard)).toEqual([CHAT, STORE, "admin-a", "active"]);
    expect(compiled(guard)).toContain(
      `"mink_conversations"."expires_at" < now() + make_interval(days => 90) - interval '1 hour'`,
    );
  });

  it("loads chronological visible messages and actor-scoped feedback", async () => {
    useDb({
      selectQueue: [
        [{ id: CHAT, title: "Products" }],
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
    const result = await getMinkConversation(actor, CHAT);
    expect(result.messages.map((m) => m.id)).toEqual(["prompt", "reply"]);
    expect(result.messages[1].feedback).toEqual({
      rating: "helpful",
      issueCategory: null,
    });
    expect(result.earlierCursor).toBeNull();
    // ★ B4 and the stopped question: one visibility rule.
    const join = compiled(mock.calls.innerJoin[0][1]);
    expect(join).toContain(`"mink_runs"."status" = 'succeeded'`);
    expect(join).toContain(
      `"mink_runs"."status" in ('failed', 'cancelled') and exists ( select 1 from "mink_messages" as kept`,
    );
    expect(sqlParamValues(mock.calls.leftJoin[0][1])).toEqual([
      STORE,
      "admin-a",
    ]);
    expect(mock.calls.limit).toEqual([1, 51]);
  });

  it("★ F7: asks for a kept answer with a literal the kept-answer index can serve, never a parameter", () => {
    const rule = visibleMinkRun(minkMessages);
    expect(compiled(rule)).toContain(
      `and kept.role = 'assistant' and kept.content_json @> '{"interrupted":true}'::jsonb )`,
    );
    expect(sqlParamValues(rule)).toEqual([]);
  });

  it("★ shows the merchant's own words of a run they stopped, and nothing else of it", () => {
    const text = compiled(visibleMinkRun(minkMessages));
    expect(text).toContain(
      `"mink_runs"."status" in ('failed', 'cancelled') and "mink_runs"."stop_requested_at" is not null and "mink_messages"."role" = 'user' and not exists`,
    );
  });

  it("★ F10: hides a stopped question once the chat's next question, answered or stopped, begins with its words", () => {
    const text = compiled(visibleMinkRun(minkMessages));
    const arm = text.slice(text.indexOf("and not exists"));
    expect(arm).toContain(
      `where next_question.store_id = "mink_messages"."store_id" and next_question.conversation_id = "mink_messages"."conversation_id" and next_question.role = 'user' and (next_question.created_at, next_question.id) > ("mink_messages"."created_at", "mink_messages"."id") order by next_question.created_at, next_question.id limit 1 ) asked`,
    );
    expect(arm).toContain(
      `on asked_run.id = asked.run_id and asked_run.store_id = "mink_messages"."store_id" where (asked_run.status = 'succeeded' or asked_run.stop_requested_at is not null) and starts_with(asked.text, "mink_messages"."content_json" ->> 'text')`,
    );
  });

  it("★ a 51st message means earlier ones exist, read from below the 50th", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      role: index % 2 ? "user" : "assistant",
      content: { text: `Message ${index}` },
      runId: "run-a",
      createdAt: `2026-10-26 07:${String(59 - index).padStart(2, "0")}:00.000001+00`,
      feedbackRating: null,
      feedbackIssueCategory: null,
    }));
    useDb({ selectQueue: [[{ id: CHAT, title: "Long" }], rows] });
    const result = await getMinkConversation(actor, CHAT);
    expect(result.messages).toHaveLength(50);
    expect(result.messages[0].text).toBe("Message 49");
    expect(result.messages[49].text).toBe("Message 0");
    expect(decodeHistoryCursor(result.earlierCursor)).toEqual({
      at: rows[49].createdAt,
      id: rows[49].id,
    });
  });

  it("★ reads earlier messages strictly below the cursor", async () => {
    const before = encodeHistoryCursor("2026-10-26 07:00:00.5+00", CHAT);
    useDb({ selectQueue: [[{ id: CHAT, title: "Long" }], []] });
    const result = await getMinkConversation(actor, CHAT, { before });
    const where = mock.calls.where[2];
    expect(compiled(where)).toContain(
      `("mink_messages"."created_at", "mink_messages"."id") < ($3::timestamptz, $4::uuid)`,
    );
    expect(sqlParamValues(where)).toEqual([
      STORE,
      CHAT,
      "2026-10-26 07:00:00.5+00",
      CHAT,
    ]);
    expect(result.earlierCursor).toBeNull();
  });

  it("refuses a bad earlier-messages cursor before any query", async () => {
    await expect(
      getMinkConversation(actor, CHAT, { before: "!!" }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(withService).not.toHaveBeenCalled();
  });
});

describe("deleting a chat", () => {
  it("refuses deletion while a scoped run is still running", async () => {
    // No dead run; a young one is running.
    useDb({ selectQueue: [[], [{ id: "running-a" }]] });
    await expect(deleteMinkConversation(actor, CHAT)).rejects.toMatchObject({
      code: "conversation_busy",
      status: 409,
    });
    expect(retireMinkConversation).not.toHaveBeenCalled();
    // ★ A run within its limit is never closed.
    expect(closeStaleMinkRuns).not.toHaveBeenCalled();
  });

  it("★ B7: closes a dead run of the actor's chat first, then retires it", async () => {
    useDb({ selectQueue: [[{ id: "dead-run" }], [], [{ id: CHAT }]] });
    await expect(deleteMinkConversation(actor, CHAT)).resolves.toBe("deleted");
    expect(closeStaleMinkRuns).toHaveBeenCalledWith({
      storeId: STORE,
      adminId: "admin-a",
      conversationId: CHAT,
    });
    expect(retireMinkConversation).toHaveBeenCalledTimes(1);
    // The dead-run read: this store, this chat, this admin, and the stale rule.
    const deadRead = mock.calls.where[0];
    expect(sqlParamValues(deadRead)).toEqual([
      STORE,
      CHAT,
      "admin-a",
      MINK_STALE_RUN_MS,
      MINK_STALE_RUN_MS,
    ]);
    expect(compiled(deadRead)).toContain(`"mink_runs"."status" = 'running'`);
  });

  it("B7: a dead run that could not be closed keeps the chat busy, and is logged", async () => {
    vi.mocked(closeStaleMinkRuns).mockRejectedValueOnce(new Error("down"));
    useDb({ selectQueue: [[{ id: "dead-run" }], [{ id: "dead-run" }]] });
    await expect(deleteMinkConversation(actor, CHAT)).rejects.toMatchObject({
      code: "conversation_busy",
      status: 409,
    });
    expect(logError).toHaveBeenCalledWith(
      "mink.history: dead runs not closed",
      expect.any(Error),
      { storeId: STORE, conversationId: CHAT },
    );
    expect(retireMinkConversation).not.toHaveBeenCalled();
  });

  it("★ refuses only while a redesign of the chat is still being made, in plain words", async () => {
    useDb({ executeQueue: [[], [{ building: true }]] });
    await expect(deleteMinkConversation(actor, CHAT)).rejects.toMatchObject({
      code: "conversation_has_redesign",
      status: 409,
      message:
        "A storefront redesign from this chat is still being made. Wait for it to finish, or stop it from its card, then delete this chat.",
    });
    expect(retireMinkConversation).not.toHaveBeenCalled();
    expect(paramsOf(mock.calls.execute[1])).toEqual([STORE, CHAT]);
  });

  it("★ a ready card no longer holds the chat: only queued or running redesigns, or a refinement of one, do", () => {
    const text = compiled(buildingRevampOfConversation(STORE, CHAT));
    expect(text).toContain("v.status in ('queued', 'running')");
    expect(text).toContain("child.parent_id = v.id");
    expect(text).toContain("child.status in ('queued', 'running')");
    expect(text).not.toContain("ready");
  });

  it("★ retires only the actor's own listed chat, locked, after taking the chat's lock", async () => {
    useDb({ selectQueue: [[], [], [{ id: CHAT }]] });
    await deleteMinkConversation(actor, CHAT);
    expect(sqlParamValues(mock.calls.execute[0])).toEqual([
      `mink-conversation:${CHAT}`,
    ]);
    // where[0] is the dead-run read, where[1] the running check.
    expect(sqlParamValues(mock.calls.where[2])).toEqual([
      CHAT,
      STORE,
      "admin-a",
      "active",
    ]);
    expect(mock.calls.forUpdate).toEqual(["update"]);
    expect(retireMinkConversation).toHaveBeenCalledWith(mock.db, {
      storeId: STORE,
      conversationId: CHAT,
    });
    expect(closeStaleMinkRuns).not.toHaveBeenCalled();
  });

  it("answers 404 for a chat that is not the actor's (or is gone)", async () => {
    useDb({ selectQueue: [[], [], []] });
    await expect(deleteMinkConversation(actor, CHAT)).rejects.toMatchObject({
      code: "conversation_not_found",
      status: 404,
    });
    expect(retireMinkConversation).not.toHaveBeenCalled();
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
