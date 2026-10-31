import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { logWarn } from "@/lib/observability/logger";
import {
  MINK_REDUCED_CHAT_TITLE,
  retireMinkConversation,
  stripOrphanedRedesignsQuery,
} from "./conversation-retire";

vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// ★★ The db is a recorder of COMPILED statements: a mock never parses SQL, so
// only the compiled text can show a missing parenthesis or a dropped guard
// (the rule of sql-array-binding.test.ts; this absorbs the old
// persistence-prune-sql.test.ts). The local database test runs the same
// statements for real (conversation-retention.local.test.ts).
// ---------------------------------------------------------------------------

const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function recorder(options: { holds: boolean; deleteError?: unknown }) {
  const statements: { text: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const compiled = new PgDialect().sqlToQuery(query);
    const text = compiled.sql.replace(/\s+/g, " ").trim();
    statements.push({ text, params: compiled.params });
    if (text.includes(" as holds")) return { rows: [{ holds: options.holds }] };
    if (
      options.deleteError &&
      text.startsWith("delete from public.mink_conversations")
    )
      throw options.deleteError;
    return { rows: [] };
  });
  return { db: { execute } as unknown as Db, statements };
}

/** What each statement is, in order, by its opening words. */
function shapes(statements: { text: string }[]): string[] {
  return statements.map(({ text }) => {
    if (text.startsWith("select a.id")) return "lock approvals";
    if (text.startsWith("select d.id")) return "lock drafts";
    if (text.startsWith("select v.id")) return "lock redesigns";
    if (text.startsWith("update public.mink_revamps")) return "strip";
    if (text.startsWith("update public.mink_attachments"))
      return "mark pictures";
    if (text.includes(" as holds")) return "records check";
    if (text.startsWith("SAVEPOINT")) return "savepoint";
    if (text.startsWith("RELEASE SAVEPOINT")) return "release";
    if (text.startsWith("ROLLBACK TO SAVEPOINT"))
      return "rollback to savepoint";
    if (text.startsWith("delete from public.mink_conversations"))
      return "delete chat";
    if (text.startsWith("delete from public.mink_messages"))
      return "delete messages";
    if (text.startsWith("delete from public.mink_feedback"))
      return "delete feedback";
    if (text.startsWith("delete from public.mink_action_approvals"))
      return "delete previews";
    if (text.startsWith("delete from public.mink_drafts"))
      return "delete drafts";
    if (text.startsWith("delete from public.mink_runs")) return "delete runs";
    if (text.startsWith("update public.mink_runs")) return "clear paths";
    if (text.startsWith("update public.mink_conversations")) return "hide chat";
    return `unknown: ${text.slice(0, 40)}`;
  });
}

const statementOf = (
  statements: { text: string; params: unknown[] }[],
  shape: string,
) => {
  const index = shapes(statements).indexOf(shape);
  expect(index, shape).toBeGreaterThanOrEqual(0);
  return statements[index];
};

const REDUCE = [
  "delete messages",
  "delete feedback",
  "delete previews",
  "delete drafts",
  "delete runs",
  "clear paths",
  "hide chat",
];

beforeEach(() => {
  vi.mocked(logWarn).mockClear();
});

describe("retireMinkConversation", () => {
  it("★ locks, strips and checks first, then DELETES a chat with no record", async () => {
    const { db, statements } = recorder({ holds: false });
    await expect(
      retireMinkConversation(db, { storeId: STORE, conversationId: CHAT }),
    ).resolves.toBe("deleted");
    expect(shapes(statements)).toEqual([
      "lock approvals",
      "lock drafts",
      "lock redesigns",
      "strip",
      "mark pictures",
      "records check",
      "savepoint",
      "delete chat",
      "release",
    ]);
  });

  it("★ REDUCES a chat holding a record, and never deletes the chat row", async () => {
    const { db, statements } = recorder({ holds: true });
    await expect(
      retireMinkConversation(db, { storeId: STORE, conversationId: CHAT }),
    ).resolves.toBe("reduced");
    expect(shapes(statements)).toEqual([
      "lock approvals",
      "lock drafts",
      "lock redesigns",
      "strip",
      "mark pictures",
      "records check",
      ...REDUCE,
    ]);
  });

  it("★ reduces instead when a foreign key refuses the delete, and says so without content", async () => {
    const refused = Object.assign(new Error("fk"), {
      code: "23503",
      constraint: "some_new_record_fkey",
    });
    const { db, statements } = recorder({ holds: false, deleteError: refused });
    await expect(
      retireMinkConversation(db, { storeId: STORE, conversationId: CHAT }),
    ).resolves.toBe("reduced");
    expect(shapes(statements)).toEqual([
      "lock approvals",
      "lock drafts",
      "lock redesigns",
      "strip",
      "mark pictures",
      "records check",
      "savepoint",
      "delete chat",
      "rollback to savepoint",
      "release",
      ...REDUCE,
    ]);
    expect(logWarn).toHaveBeenCalledWith(
      "mink.retire: delete refused, reducing",
      {
        storeId: STORE,
        conversationId: CHAT,
        constraint: "some_new_record_fkey",
      },
    );
  });

  it("lets any other failure of the delete through, reducing nothing", async () => {
    const deadlock = Object.assign(new Error("deadlock"), { code: "40P01" });
    const { db, statements } = recorder({
      holds: false,
      deleteError: deadlock,
    });
    await expect(
      retireMinkConversation(db, { storeId: STORE, conversationId: CHAT }),
    ).rejects.toBe(deadlock);
    expect(shapes(statements).slice(-2)).toEqual(["savepoint", "delete chat"]);
  });

  it("★ locks in the order every execution takes them: approvals, drafts, redesigns", async () => {
    const { db, statements } = recorder({ holds: true });
    await retireMinkConversation(db, { storeId: STORE, conversationId: CHAT });
    expect(statementOf(statements, "lock approvals").text).toMatch(
      /order by a\.id for update of a$/,
    );
    expect(statementOf(statements, "lock drafts").text).toMatch(
      /order by d\.id for update of d$/,
    );
    expect(statementOf(statements, "lock redesigns").text).toMatch(
      /order by v\.id for update$/,
    );
  });

  it("★ strips only never-applied, finished redesigns, keeping billing facts and the photo claim", async () => {
    const { db, statements } = recorder({ holds: true });
    await retireMinkConversation(db, { storeId: STORE, conversationId: CHAT });
    const strip = statementOf(statements, "strip").text;
    expect(strip).toContain("v.applied_at is null");
    expect(strip).toContain(
      "v.status in ('ready', 'failed', 'cancelled', 'superseded')",
    );
    expect(strip).toContain(
      "status = case when v.status = 'ready' then 'superseded' else v.status end",
    );
    expect(strip).toContain("request = jsonb_build_object('kind', v.kind)");
    expect(strip).toContain("requester_email = null");
    expect(strip).toContain(
      "snapshot = null, plan = null, error_detail = null",
    );
    expect(strip).toContain(
      "then jsonb_build_object('photoHold', v.result -> 'photoHold')",
    );
    expect(strip).toContain("draft_id = null, origin_run_id = null");
    // Never the billing facts.
    expect(strip).not.toMatch(/\bfree\s*=|\bcredits\s*=|\busage\s*=/);
  });

  it("★ the records check parenthesises every exists and names every kind of record", async () => {
    const { db, statements } = recorder({ holds: false });
    await retireMinkConversation(db, { storeId: STORE, conversationId: CHAT });
    const check = statementOf(statements, "records check").text;
    expect(check).not.toMatch(/exists\s+select/i);
    expect(check).toContain("from public.mink_action_audit x");
    expect(check).toContain("a.status <> 'pending'");
    expect(check).toContain("from public.mink_blog_publications p");
    expect(check).toContain("join public.email_campaigns e");
    expect(check).toContain(
      "(v.applied_at is not null or v.status in ('queued', 'running', 'ready'))",
    );
    for (const { text } of statements) {
      expect(text).not.toMatch(/exists\s+select/i);
    }
  });

  it("★ deletes only previews nobody confirmed and nothing names", async () => {
    const { db, statements } = recorder({ holds: true });
    await retireMinkConversation(db, { storeId: STORE, conversationId: CHAT });
    const previews = statementOf(statements, "delete previews").text;
    expect(previews).toContain("a.status = 'pending'");
    expect(previews).toContain(
      "not exists (select 1 from public.mink_action_audit x",
    );
    expect(previews).toContain(
      "not exists (select 1 from public.mink_blog_publications p where p.approval_id = a.id",
    );
    expect(previews).toContain(
      "not exists (select 1 from public.email_campaigns e where e.mink_approval_id = a.id",
    );
    expect(previews).toContain("child.source_approval_id = a.id");
  });

  it("★ keeps a card's draft only while its redesign is applied or still live", async () => {
    const { db, statements } = recorder({ holds: true });
    await retireMinkConversation(db, { storeId: STORE, conversationId: CHAT });
    const drafts = statementOf(statements, "delete drafts").text;
    expect(drafts).toContain("(v.draft_id = d.id or v.id = d.id)");
    expect(drafts).toContain(
      "(v.applied_at is not null or v.status in ('queued', 'running', 'ready'))",
    );
    // ★ F1: a draft that still holds an approval (deleting it would cascade
    //   to the approval and its audit row) or a blog publication stays.
    expect(drafts).toContain(
      "and not exists (select 1 from public.mink_action_approvals a where a.draft_id = d.id and a.store_id = d.store_id)",
    );
    expect(drafts).toContain(
      "and not exists (select 1 from public.mink_blog_publications p where p.draft_id = d.id and p.store_id = d.store_id)",
    );
    const runs = statementOf(statements, "delete runs").text;
    expect(runs).toContain("from public.mink_drafts d where d.run_id = r.id");
    expect(runs).toContain(
      "from public.mink_draft_credit_usage u where u.run_id = r.id",
    );
    expect(runs).toContain("v.origin_run_id = r.id");
  });

  it("hides the reduced chat and forgets its words", async () => {
    const { db, statements } = recorder({ holds: true });
    await retireMinkConversation(db, { storeId: STORE, conversationId: CHAT });
    const hide = statementOf(statements, "hide chat");
    expect(hide.text).toContain("set status = 'deleted', title = $1");
    expect(hide.text).toContain("summary_json = null");
    expect(hide.text).toContain("summarized_message_count = 0");
    expect(hide.text).toContain("retention_failed_at = null");
    expect(hide.params[0]).toBe(MINK_REDUCED_CHAT_TITLE);
    expect(statementOf(statements, "clear paths").text).toContain(
      "set current_path = null",
    );
  });

  it("★ scopes every statement by the store and the chat", async () => {
    for (const holds of [true, false]) {
      const { db, statements } = recorder({ holds });
      await retireMinkConversation(db, {
        storeId: STORE,
        conversationId: CHAT,
      });
      for (const statement of statements) {
        if (/SAVEPOINT/.test(statement.text)) continue;
        expect(statement.params, statement.text).toContain(STORE);
        expect(statement.params, statement.text).toContain(CHAT);
      }
    }
  });

  it("★ marks the chat's attached pictures for the purge on both paths, before any delete could unlink them", async () => {
    for (const holds of [false, true]) {
      const { db, statements } = recorder({ holds });
      await retireMinkConversation(db, {
        storeId: STORE,
        conversationId: CHAT,
      });
      const order = shapes(statements);
      const mark = order.indexOf("mark pictures");
      expect(mark, `holds ${holds}`).toBe(order.indexOf("strip") + 1);
      expect(mark).toBeLessThan(order.indexOf("records check"));
      if (!holds) expect(mark).toBeLessThan(order.indexOf("delete chat"));
      expect(order.filter((shape) => shape === "mark pictures")).toHaveLength(
        1,
      );
      const statement = statementOf(statements, "mark pictures");
      expect(statement.text).toBe(
        "update public.mink_attachments set discard_requested_at = now() where store_id = $1 and conversation_id = $2 and discard_requested_at is null",
      );
      expect(statement.params).toEqual([STORE, CHAT]);
    }
  });
});

describe("stripOrphanedRedesignsQuery", () => {
  const compile = (query: SQL) => {
    const out = new PgDialect().sqlToQuery(query);
    return { text: out.sql.replace(/\s+/g, " ").trim(), params: out.params };
  };

  it("★ F2: strips, with the chat strip's own SET list, never-applied finished redesigns whose chat is gone", async () => {
    const { text, params } = compile(stripOrphanedRedesignsQuery(50));
    const { db, statements } = recorder({ holds: true });
    await retireMinkConversation(db, { storeId: STORE, conversationId: CHAT });
    const chatStrip = statementOf(statements, "strip").text;
    const setList = (statement: string) =>
      statement.slice(statement.indexOf(" set "), statement.indexOf(" where "));
    expect(setList(text)).toBe(setList(chatStrip));
    for (const alias of ["o", "v"]) {
      expect(text).toContain(`${alias}.conversation_id is null`);
      expect(text).toContain(`${alias}.applied_at is null`);
      expect(text).toContain(
        `${alias}.status in ('ready', 'failed', 'cancelled', 'superseded')`,
      );
    }
    expect(text).toContain("order by o.id limit $1 for update skip locked");
    expect(params).toEqual([50]);
  });

  it("★ F2: touches only rows that still hold something to strip, so a night never rewrites a stripped one", () => {
    const { text } = compile(stripOrphanedRedesignsQuery(50));
    for (const clause of [
      "o.status = 'ready'",
      "o.request is distinct from jsonb_build_object('kind', o.kind)",
      "o.requester_email is not null",
      "o.snapshot is not null or o.plan is not null",
      "o.error_detail is not null",
      "o.draft_id is not null or o.origin_run_id is not null",
      "o.lease_token is not null or o.lease_until is not null",
      "(o.result is not null and (jsonb_typeof(o.result -> 'photoHold') is distinct from 'object' or o.result - 'photoHold' <> '{}'::jsonb))",
    ])
      expect(text).toContain(clause);
    expect(text).not.toMatch(/exists\s+select/i);
  });
});
