import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import { retireMinkConversation } from "./conversation-retire";
import {
  MINK_RETENTION_MAX_HEAL_ROUNDS,
  MINK_RETENTION_RETRY_FAILED_AFTER_DAYS,
  healExpiringChatsQuery,
  pruneIdleMinkConversations,
  retirableChatsQuery,
} from "./conversation-retention";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
// The retirement statements are pinned in conversation-retire.test.ts; the
// strip of redesigns without a chat is its real builder.
vi.mock("./conversation-retire", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./conversation-retire")>()),
  retireMinkConversation: vi.fn(async () => "deleted"),
}));
// History's module graph stays light; nothing here may load drafts.
vi.mock("./drafts", () => {
  throw new Error("The sweep loaded draft execution dependencies");
});

const FLOOR = "2026-07-28T03:00:00.000Z";
const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chat = (n: number) => ({
  id: `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`,
  store_id: STORE,
});

const compiled = (query: unknown) =>
  new PgDialect()
    .sqlToQuery(query as SQL)
    .sql.replace(/\s+/g, " ")
    .trim();
const paramsOf = (query: unknown) =>
  new PgDialect().sqlToQuery(query as SQL).params;

type Answer = (
  text: string,
  params: unknown[],
) => unknown[] | Error | undefined;

/**
 * A database per `withService` scope that records compiled statements and
 * answers by statement text. Scopes run one after the other.
 */
function useDatabase(answer: Answer) {
  const scopes: { text: string; params: unknown[] }[][] = [];
  vi.mocked(withService).mockImplementation(async (fn) => {
    const statements: { text: string; params: unknown[] }[] = [];
    scopes.push(statements);
    const db = {
      execute: vi.fn(async (query: SQL) => {
        const text = compiled(query);
        const params = paramsOf(query);
        statements.push({ text, params });
        const rows = answer(text, params);
        if (rows instanceof Error) throw rows;
        return { rows: rows ?? [] };
      }),
    };
    return fn(db as unknown as Db);
  });
  return scopes;
}

beforeEach(() => {
  vi.mocked(withService).mockReset();
  vi.mocked(retireMinkConversation).mockReset();
  vi.mocked(retireMinkConversation).mockResolvedValue("deleted");
  vi.mocked(logError).mockClear();
  vi.mocked(logInfo).mockClear();
});

describe("the heal", () => {
  it("★ moves an expiry about to pass up to last message + 90 days, bounded per batch", () => {
    const text = compiled(healExpiringChatsQuery(50));
    expect(text).toContain(
      "set expires_at = c.last_message_at + make_interval(days => 90)",
    );
    expect(text).toContain("c2.status = 'active'");
    expect(text).toContain("c2.expires_at <= now() + interval '2 days'");
    expect(text).toContain("order by c2.expires_at, c2.id limit $1");
    expect(paramsOf(healExpiringChatsQuery(50))).toEqual([50]);
  });

  it("★ F3: heals only an expiry more than an hour short (a reply's own minutes never count), re-checked on the row it writes", () => {
    const text = compiled(healExpiringChatsQuery(50));
    expect(text).toContain(
      "c2.expires_at < c2.last_message_at + make_interval(days => 90) - interval '1 hour'",
    );
    // The row being written repeats the condition, so an open that moved the
    // expiry meanwhile is left alone.
    expect(text).toMatch(
      /\) and c\.status = 'active' and c\.expires_at < c\.last_message_at \+ make_interval\(days => 90\) - interval '1 hour' returning c\.id$/,
    );
  });
});

describe("the strip of redesigns whose chat is gone", () => {
  it("★ F2: runs every batch, in its own scope, and is counted", async () => {
    const scopes = useDatabase((text) => {
      if (text.startsWith("update public.mink_revamps v"))
        return [{ id: "r1" }, { id: "r2" }];
      return [];
    });
    await pruneIdleMinkConversations(FLOOR, 50);
    expect(scopes).toHaveLength(3);
    expect(scopes[1]).toHaveLength(1);
    expect(scopes[1][0].text).toContain("where v.id in (");
    expect(scopes[1][0].params).toEqual([50]);
    expect(logInfo).toHaveBeenCalledWith("mink.retention: batch", {
      healed: 0,
      stripped: 2,
      deleted: 0,
      reduced: 0,
      skipped: 0,
      failed: 0,
    });
  });
});

describe("the candidates", () => {
  it("★ need BOTH a passed expiry AND a last message 90 days old, and nothing running or being made", () => {
    const query = retirableChatsQuery(FLOOR, 50);
    const text = compiled(query);
    expect(text).toContain("c.status = 'active'");
    expect(text).toContain("c.expires_at <= now()");
    expect(text).toContain("c.last_message_at <= $1::timestamptz");
    expect(text).toContain(
      `(c.retention_failed_at is null or c.retention_failed_at < now() - make_interval(days => ${MINK_RETENTION_RETRY_FAILED_AFTER_DAYS}))`,
    );
    expect(text).toContain(
      "r.store_id = c.store_id and r.conversation_id = c.id and r.status = 'running'",
    );
    expect(text).toContain(
      "v.store_id = c.store_id and v.conversation_id = c.id",
    );
    expect(text).toContain("v.status in ('queued', 'running')");
    expect(text).toContain("child.parent_id = v.id");
    expect(text).toMatch(/order by c\.expires_at, c\.id limit \$2$/);
    expect(paramsOf(query)).toEqual([FLOOR, 50]);
    expect(MINK_RETENTION_RETRY_FAILED_AFTER_DAYS).toBe(7);
  });
});

describe("pruneIdleMinkConversations", () => {
  it("★ heals, reads candidates, then retires each in its own savepoint, in three scopes one after another", async () => {
    vi.mocked(retireMinkConversation)
      .mockResolvedValueOnce("deleted")
      .mockResolvedValueOnce("reduced");
    const scopes = useDatabase((text) => {
      if (text.startsWith("update public.mink_conversations c set expires_at"))
        return [{ id: "healed-1" }];
      if (text.startsWith("select c.id, c.store_id")) return [chat(1), chat(2)];
      if (text.includes(" as locked")) return [{ locked: true }];
      if (text.startsWith("select c.id from public.mink_conversations c"))
        return [{ id: "still" }];
      return [];
    });
    await expect(pruneIdleMinkConversations(FLOOR, 50)).resolves.toBe(2);
    expect(scopes).toHaveLength(4);
    const batch = scopes[3].map(({ text }) =>
      text.split(" ").slice(0, 3).join(" "),
    );
    expect(batch).toEqual([
      "SAVEPOINT mink_retention_chat",
      "select pg_try_advisory_xact_lock(hashtextextended($1, 0))",
      "select c.id from",
      "RELEASE SAVEPOINT mink_retention_chat",
      "SAVEPOINT mink_retention_chat",
      "select pg_try_advisory_xact_lock(hashtextextended($1, 0))",
      "select c.id from",
      "RELEASE SAVEPOINT mink_retention_chat",
    ]);
    expect(scopes[3][1].params).toEqual([`mink-conversation:${chat(1).id}`]);
    // The re-read repeats the candidate's conditions, under a row lock.
    expect(scopes[3][2].text).toContain("c.expires_at <= now()");
    expect(scopes[3][2].text).toContain("c.last_message_at <= $3::timestamptz");
    expect(scopes[3][2].text).toMatch(/for update$/);
    expect(retireMinkConversation).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      { storeId: STORE, conversationId: chat(1).id },
    );
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith("mink.retention: batch", {
      healed: 1,
      stripped: 0,
      deleted: 1,
      reduced: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it("★ skips a chat whose lock is busy, or that changed since it was read, without writing", async () => {
    let reads = 0;
    const scopes = useDatabase((text) => {
      if (text.startsWith("select c.id, c.store_id")) return [chat(1), chat(2)];
      if (text.includes(" as locked")) {
        reads += 1;
        return [{ locked: reads === 2 }];
      }
      // Chat 2: locked, but no longer retirable (used or deleted meanwhile).
      if (text.startsWith("select c.id from public.mink_conversations c"))
        return [];
      return [];
    });
    await expect(pruneIdleMinkConversations(FLOOR, 50)).resolves.toBe(0);
    expect(retireMinkConversation).not.toHaveBeenCalled();
    expect(scopes[3].some(({ text }) => text.startsWith("update"))).toBe(false);
    expect(logInfo).toHaveBeenCalledWith("mink.retention: batch", {
      healed: 0,
      stripped: 0,
      deleted: 0,
      reduced: 0,
      skipped: 2,
      failed: 0,
    });
  });

  it("★ a chat that fails is rolled back alone, marked for 7 days and logged with ids only", async () => {
    vi.mocked(retireMinkConversation)
      .mockRejectedValueOnce(
        Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      )
      .mockResolvedValueOnce("deleted");
    const scopes = useDatabase((text) => {
      if (text.startsWith("select c.id, c.store_id")) return [chat(1), chat(2)];
      if (text.includes(" as locked")) return [{ locked: true }];
      if (text.startsWith("select c.id from public.mink_conversations c"))
        return [{ id: "still" }];
      return [];
    });
    await expect(pruneIdleMinkConversations(FLOOR, 50)).resolves.toBe(1);
    const texts = scopes[3].map(({ text }) => text);
    const rollback = texts.indexOf("ROLLBACK TO SAVEPOINT mink_retention_chat");
    expect(rollback).toBeGreaterThan(0);
    expect(texts[rollback + 1]).toBe("RELEASE SAVEPOINT mink_retention_chat");
    expect(texts[rollback + 2]).toContain("set retention_failed_at = now()");
    expect(scopes[3][rollback + 2].params).toEqual([chat(1).id, STORE]);
    expect(logError).toHaveBeenCalledWith(
      "mink.retention: chat not retired",
      expect.any(Error),
      { storeId: STORE, conversationId: chat(1).id },
    );
    // The next chat is still retired in the same batch.
    expect(retireMinkConversation).toHaveBeenCalledTimes(2);
  });

  it("★ F3: keeps healing while a round heals a full batch, at most ten rounds", async () => {
    let rounds = 0;
    const scopes = useDatabase((text) => {
      if (
        text.startsWith("update public.mink_conversations c set expires_at")
      ) {
        rounds += 1;
        // Three full rounds, then a short one.
        return Array.from({ length: rounds <= 3 ? 2 : 1 }, (_, n) => ({
          id: `healed-${rounds}-${n}`,
        }));
      }
      return [];
    });
    await pruneIdleMinkConversations(FLOOR, 2);
    expect(rounds).toBe(4);
    expect(scopes).toHaveLength(4 + 2);
    expect(logInfo).toHaveBeenCalledWith(
      "mink.retention: batch",
      expect.objectContaining({ healed: 7 }),
    );

    rounds = 0;
    useDatabase((text) =>
      text.startsWith("update public.mink_conversations c set expires_at")
        ? ((rounds += 1), [{ id: "a" }, { id: "b" }])
        : [],
    );
    await pruneIdleMinkConversations(FLOOR, 2);
    expect(rounds).toBe(MINK_RETENTION_MAX_HEAL_ROUNDS);
    expect(MINK_RETENTION_MAX_HEAL_ROUNDS).toBe(10);
  });

  it("opens no batch when nothing is retirable, and still reports the night", async () => {
    const scopes = useDatabase(() => []);
    await expect(pruneIdleMinkConversations(FLOOR, 50)).resolves.toBe(0);
    expect(scopes).toHaveLength(3);
    expect(logInfo).toHaveBeenCalledWith("mink.retention: batch", {
      healed: 0,
      stripped: 0,
      deleted: 0,
      reduced: 0,
      skipped: 0,
      failed: 0,
    });
  });
});
