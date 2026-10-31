import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * The store's notice actions (takedown stage T18a) over the REAL
 * lib/moderation/merchant.ts. The database is a fake that keeps blocks in
 * memory and honours the predicates the queries carry (the store id,
 * `b.tell_store`, `b.erased_at is null`), so a block kept from the store
 * (D21) is found only if a query forgets to ask. Access, the notification and
 * the record are mocks.
 */

interface FakeBlock {
  id: string;
  store_id: string;
  store_label: string;
  item_label: string;
  tell_store: boolean;
  erased_at: string | null;
  lifted_at: string | null;
  item_kind: string;
  reason_kind: string;
  blocked_at: string;
}

const h = vi.hoisted(() => ({
  blocks: [] as FakeBlock[],
  inserted: [] as unknown[][],
  updates: [] as { text: string; params: unknown[] }[],
  fail: null as RegExp | null,
}));

function param(text: string, params: unknown[], pattern: RegExp): unknown {
  const match = pattern.exec(text);
  return match ? params[Number(match[1]) - 1] : undefined;
}

vi.mock("@/lib/db/client", () => {
  const dialect = new PgDialect();
  const db = {
    execute: async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      const text = compiled.sql.replace(/\s+/g, " ").trim();
      const params = compiled.params;
      if (h.fail?.test(text)) throw new Error("database down");
      const visible = (row: FakeBlock) => {
        const store = param(text, params, /b\.store_id = \$(\d+)/);
        if (store !== undefined && row.store_id !== store) return false;
        if (/\bb\.tell_store\b/.test(text) && !row.tell_store) return false;
        if (/b\.erased_at is null/.test(text) && row.erased_at) return false;
        return true;
      };
      if (text.startsWith("update")) {
        h.updates.push({ text, params });
        return { rows: [] };
      }
      if (text.startsWith("insert into public.content_block_messages")) {
        h.inserted.push(params);
        return { rows: [{ id: "99999999-9999-4999-8999-999999999999" }] };
      }
      if (/^select b\.id::text as id, b\.parent_block_id::text/.test(text)) {
        // The notices list: every block the predicates let through.
        return { rows: h.blocks.filter(visible) };
      }
      if (/^select b\.id::text as id/.test(text)) {
        const id = param(text, params, /b\.id = \$(\d+)/);
        const row = h.blocks.find((b) => b.id === id && visible(b));
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };
  return {
    withService: vi.fn(async (fn: (value: typeof db) => Promise<unknown>) =>
      fn(db),
    ),
    withUser: vi.fn(() => {
      throw new Error("not used");
    }),
    withAnon: vi.fn(() => {
      throw new Error("not used");
    }),
  };
});
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(async () => ({
    uid: "staff-uid",
    email: "owner@shop.test",
  })),
  getActingStoreId: vi.fn(async () => STORE_ID),
  getViewerContext: vi.fn(async () => viewer()),
}));
vi.mock("@/lib/moderation/notify", () => ({
  notifyTakedownReply: vi.fn(async () => "event-1"),
}));
vi.mock("@/lib/moderation/record", () => ({
  recordModerationEvent: vi.fn(async () => "record-1"),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

const STORE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function viewer(over: Record<string, unknown> = {}) {
  return {
    userId: "staff-uid",
    userEmail: "owner@shop.test",
    profile: { email: "owner@shop.test", role: "member" },
    isSuperadmin: false,
    permissions: { settings: ["view", "manage"] },
    storeId: STORE_ID,
    isPlatformAdmin: false,
    ...over,
  };
}

import {
  markStoreNoticeSeenAction,
  replyToStoreNoticeAction,
} from "./store-notice-actions";
import {
  getActingStoreId,
  getManagerIdentity,
  getViewerContext,
} from "@/app/dashboard/lib/access";
import { notifyTakedownReply } from "@/lib/moderation/notify";
import { recordModerationEvent } from "@/lib/moderation/record";
import { NOTICE, NOTICE_REPLY } from "@/lib/moderation/copy";
import { listStoreNotices } from "@/lib/moderation/merchant";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";

const OTHER_STORE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const TOLD = "22222222-2222-4222-8222-222222222222";
const KEPT = "44444444-4444-4444-8444-444444444444";
const THEIRS = "55555555-5555-4555-8555-555555555555";
const LIFTED = "66666666-6666-4666-8666-666666666666";

beforeEach(() => {
  h.inserted = [];
  h.updates = [];
  h.fail = null;
  const base = {
    store_id: STORE_ID,
    store_label: "Shop",
    item_label: "Blue mug",
    tell_store: true,
    erased_at: null,
    lifted_at: null,
    item_kind: "product",
    reason_kind: "court_order",
    blocked_at: "2026-10-29 10:00:00+00",
  };
  h.blocks = [
    { ...base, id: TOLD },
    // A court order that says the store must not be told (D21).
    { ...base, id: KEPT, tell_store: false },
    { ...base, id: THEIRS, store_id: OTHER_STORE },
    { ...base, id: LIFTED, lifted_at: "2026-10-29 10:00:00+00" },
  ];
});

describe("a block kept from the store", () => {
  it("is not found to reply to", async () => {
    expect(await replyToStoreNoticeAction(KEPT, "Why?", false)).toEqual({
      ok: false,
      error: NOTICE.notFound,
    });
    expect(h.inserted).toHaveLength(0);
    expect(notifyTakedownReply).not.toHaveBeenCalled();
  });

  it("is not found to mark seen", async () => {
    expect(await markStoreNoticeSeenAction(KEPT)).toEqual({
      ok: false,
      error: NOTICE.notFound,
    });
    expect(h.updates).toHaveLength(0);
  });

  it("is not in the notices list the pages read", async () => {
    const listed = (await listStoreNotices(STORE_ID)).map((n) => n.blockId);
    expect(listed).toContain(TOLD);
    expect(listed).not.toContain(KEPT);
    expect(listed).not.toContain(THEIRS);
  });
});

describe("another store's block", () => {
  it("is not found either way", async () => {
    expect(await replyToStoreNoticeAction(THEIRS, "Hi", false)).toEqual({
      ok: false,
      error: NOTICE.notFound,
    });
    expect(await markStoreNoticeSeenAction(THEIRS)).toEqual({
      ok: false,
      error: NOTICE.notFound,
    });
    expect(h.inserted).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
  });

  it("is judged against the store of the request host, never the browser", async () => {
    vi.mocked(getActingStoreId).mockResolvedValueOnce(OTHER_STORE);
    expect((await replyToStoreNoticeAction(THEIRS, "Hi", false)).ok).toBe(true);
    expect(h.inserted[0]?.[0]).toBe(THEIRS);
  });
});

describe("replyToStoreNoticeAction", () => {
  it("sends the reply, records it, then tells StoreMink", async () => {
    expect(await replyToStoreNoticeAction(TOLD, " Fixed. ", true)).toEqual({
      ok: true,
    });
    expect(h.inserted).toEqual([[TOLD, "owner@shop.test", "Fixed.", true]]);
    expect(recordModerationEvent).toHaveBeenCalledTimes(1);
    expect(notifyTakedownReply).toHaveBeenCalledWith({
      blockId: TOLD,
      itemLabel: "Blue mug",
      storeName: "Shop",
      askedForReview: true,
    });
    expect(
      vi.mocked(notifyTakedownReply).mock.invocationCallOrder[0],
    ).toBeGreaterThan(vi.mocked(withService).mock.invocationCallOrder[0]);
  });

  it("needs Settings manage", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValueOnce(null);
    expect(await replyToStoreNoticeAction(TOLD, "Hi", false)).toEqual({
      ok: false,
      error: NOTICE_REPLY.errors.noPermission,
    });
    expect(getManagerIdentity).toHaveBeenCalledWith("settings");
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses an empty or too-long reply", async () => {
    expect(await replyToStoreNoticeAction(TOLD, "  ", false)).toEqual({
      ok: false,
      error: NOTICE_REPLY.errors.empty,
    });
    expect(
      await replyToStoreNoticeAction(TOLD, "x".repeat(4001), false),
    ).toEqual({ ok: false, error: NOTICE_REPLY.errors.tooLong });
    expect(h.inserted).toHaveLength(0);
  });

  it("refuses a lifted block", async () => {
    expect(await replyToStoreNoticeAction(LIFTED, "Hi", false)).toEqual({
      ok: false,
      error: NOTICE_REPLY.errors.lifted,
    });
  });

  it("says the reply was not sent when the save fails", async () => {
    h.fail = /^insert into public\.content_block_messages/;
    expect(await replyToStoreNoticeAction(TOLD, "Hi", false)).toEqual({
      ok: false,
      error: NOTICE_REPLY.failed,
    });
    expect(notifyTakedownReply).not.toHaveBeenCalled();
  });

  it("says the reply was not sent when the permission read fails", async () => {
    vi.mocked(getManagerIdentity).mockRejectedValueOnce(new Error("db down"));
    expect(await replyToStoreNoticeAction(TOLD, "Hi", false)).toEqual({
      ok: false,
      error: NOTICE_REPLY.failed,
    });
    expect(logError).toHaveBeenCalled();
  });

  it("treats junk from the browser as nothing", async () => {
    expect(
      await replyToStoreNoticeAction(TOLD, ["Hi"] as never, "yes" as never),
    ).toEqual({ ok: false, error: NOTICE_REPLY.errors.empty });
    expect(
      await replyToStoreNoticeAction({ id: TOLD } as never, "Hi", false),
    ).toEqual({ ok: false, error: NOTICE.notFound });
    expect(h.inserted).toHaveLength(0);
  });
});

describe("markStoreNoticeSeenAction", () => {
  it("marks a told block seen for a viewer with Settings view", async () => {
    vi.mocked(getViewerContext).mockResolvedValueOnce(
      viewer({ permissions: { settings: ["view"] } }) as never,
    );
    expect(await markStoreNoticeSeenAction(TOLD)).toEqual({ ok: true });
    expect(h.updates).toHaveLength(3);
    expect(h.updates[0].params).toContain("staff-uid");
  });

  it("is not found without Settings view", async () => {
    vi.mocked(getViewerContext).mockResolvedValueOnce(
      viewer({ permissions: { orders: ["view"] } }) as never,
    );
    expect(await markStoreNoticeSeenAction(TOLD)).toEqual({
      ok: false,
      error: NOTICE.notFound,
    });
    expect(h.updates).toHaveLength(0);
  });

  it("is not found with no profile, no session or a failed lookup", async () => {
    for (const ctx of [
      null,
      viewer({ profile: null }),
      viewer({ profile: null, dbError: true }),
    ]) {
      vi.mocked(getViewerContext).mockResolvedValueOnce(ctx as never);
      expect(await markStoreNoticeSeenAction(TOLD)).toEqual({
        ok: false,
        error: NOTICE.notFound,
      });
    }
    expect(h.updates).toHaveLength(0);
  });

  it("lets a superadmin mark it seen whatever the map says", async () => {
    vi.mocked(getViewerContext).mockResolvedValueOnce(
      viewer({ isSuperadmin: true, permissions: {} }) as never,
    );
    expect(await markStoreNoticeSeenAction(TOLD)).toEqual({ ok: true });
  });
});
