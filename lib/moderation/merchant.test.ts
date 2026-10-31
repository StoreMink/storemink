import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * The store's side of a takedown (stage T18a): the notices list, one notice,
 * the "seen" mark, the home banner's count, the item marks and the store's
 * reply. The database is a small fake that keeps blocks and messages in
 * memory and HONOURS the predicates the real queries carry (the store id,
 * `b.tell_store`, `b.erased_at is null`), so a query that drops one of them
 * shows the wrong rows here exactly as it would in production. The
 * notification and the record are mocks.
 */

interface FakeBlock {
  id: string;
  store_id: string;
  store_label: string;
  parent_block_id: string | null;
  item_kind: string;
  item_id: string | null;
  item_label: string;
  object_path: string | null;
  file_source: string | null;
  author_user_id: string | null;
  reason_kind: string;
  complaint_id: string | null;
  ref_no: number | null;
  store_message: string;
  lift_note: string;
  tell_store: boolean;
  erased_at: string | null;
  blocked_at: string;
  lifted_at: string | null;
  merchant_seen_at: string | null;
  item_exists: boolean;
}

interface FakeMessage {
  id: string;
  block_id: string;
  from_side: "store" | "storemink";
  author: string;
  body: string;
  asks_review: boolean;
  created_at: string;
}

const h = vi.hoisted(() => ({
  blocks: [] as FakeBlock[],
  messages: [] as FakeMessage[],
  executed: [] as { text: string; params: unknown[] }[],
  scopes: 0,
  fail: null as RegExp | null,
}));

function param(text: string, params: unknown[], pattern: RegExp): unknown {
  const match = pattern.exec(text);
  return match ? params[Number(match[1]) - 1] : undefined;
}

/** Whether a block passes the store-side predicates the query text carries. */
function passes(text: string, params: unknown[], row: FakeBlock): boolean {
  const store = param(text, params, /b\.store_id = \$(\d+)/);
  if (store !== undefined && row.store_id !== store) return false;
  if (/\bb\.tell_store\b/.test(text) && !row.tell_store) return false;
  if (/b\.erased_at is null/.test(text) && row.erased_at) return false;
  return true;
}

vi.mock("@/lib/db/client", () => {
  const dialect = new PgDialect();
  const db = {
    execute: async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      const text = compiled.sql.replace(/\s+/g, " ").trim();
      const params = compiled.params;
      h.executed.push({ text, params });
      if (h.fail?.test(text)) throw new Error("database down");
      const visible = (row: FakeBlock) => passes(text, params, row);

      if (
        /as item_exists from public\.content_blocks b where b\.id = \$/.test(
          text,
        )
      ) {
        const id = param(text, params, /b\.id = \$(\d+)/);
        const row = h.blocks.find((b) => b.id === id && visible(b));
        return { rows: row ? [row] : [] };
      }
      if (
        /from public\.content_block_messages m where m\.block_id = \$/.test(
          text,
        )
      ) {
        const id = param(text, params, /m\.block_id = \$(\d+)/);
        return {
          rows: h.messages
            .filter((m) => m.block_id === id)
            .sort((a, b) => a.created_at.localeCompare(b.created_at)),
        };
      }
      if (/where b\.parent_block_id = \$\d+::uuid and b\.store_id/.test(text)) {
        const parent = param(text, params, /b\.parent_block_id = \$(\d+)/);
        return {
          rows: h.blocks.filter(
            (b) => b.parent_block_id === parent && visible(b),
          ),
        };
      }
      if (/count\(\*\)::int as unopened/.test(text)) {
        const rows = h.blocks
          .filter(visible)
          .filter(
            (b) => !b.parent_block_id && !b.lifted_at && !b.merchant_seen_at,
          )
          .sort((a, b) => b.blocked_at.localeCompare(a.blocked_at));
        return {
          rows: [{ unopened: rows.length, first_id: rows[0]?.id ?? null }],
        };
      }
      if (/as item_key/.test(text)) {
        const kind = param(text, params, /b\.item_kind = \$(\d+)/);
        return {
          rows: h.blocks
            .filter(visible)
            .filter((b) => !b.lifted_at && b.item_kind === kind)
            .map((b) => ({ item_key: b.item_id ?? b.object_path, id: b.id })),
        };
      }
      if (/for share of b/.test(text)) {
        const id = param(text, params, /b\.id = \$(\d+)/);
        const row = h.blocks.find((b) => b.id === id && visible(b));
        return { rows: row ? [row] : [] };
      }
      if (/^insert into public\.content_block_messages/.test(text)) {
        const [blockId, author, body, asksReview] = params as [
          string,
          string,
          string,
          boolean,
        ];
        const id = `00000000-0000-4000-8000-${String(h.messages.length + 1).padStart(12, "0")}`;
        h.messages.push({
          id,
          block_id: blockId,
          from_side: "store",
          author,
          body,
          asks_review: asksReview,
          created_at: "2026-10-30 09:00:00+00",
        });
        return { rows: [{ id }] };
      }
      if (
        /^select b\.id::text as id from public\.content_blocks b where b\.id = \$/.test(
          text,
        )
      ) {
        const id = param(text, params, /b\.id = \$(\d+)/);
        const row = h.blocks.find((b) => b.id === id && visible(b));
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (/^select b\.id::text as id, b\.parent_block_id::text/.test(text)) {
        return {
          rows: h.blocks
            .filter(visible)
            .sort(
              (a, b) =>
                b.blocked_at.localeCompare(a.blocked_at) ||
                a.id.localeCompare(b.id),
            ),
        };
      }
      return { rows: [] };
    },
  };
  return {
    withService: vi.fn(async (fn: (value: typeof db) => Promise<unknown>) => {
      h.scopes += 1;
      return fn(db);
    }),
    withUser: vi.fn(() => {
      throw new Error("not used");
    }),
    withAnon: vi.fn(() => {
      throw new Error("not used");
    }),
  };
});
vi.mock("./notify", () => ({
  notifyTakedownReply: vi.fn(async () => "event-1"),
}));
vi.mock("./record", () => ({
  recordModerationEvent: vi.fn(async () => "record-1"),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  blockedItemIds,
  getStoreNotice,
  listStoreNotices,
  markNoticeSeen,
  replyToStoreNotice,
  storeNoticeSummary,
  storeReplyBody,
} from "./merchant";
import { NOTICE, NOTICE_REPLY } from "./copy";
import { notifyTakedownReply } from "./notify";
import { recordModerationEvent } from "./record";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";

const STORE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_STORE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const PRODUCT = "11111111-1111-4111-8111-111111111111";
const BLOCK = "22222222-2222-4222-8222-222222222222";
const IMAGE = "33333333-3333-4333-8333-333333333333";
const HIDDEN = "44444444-4444-4444-8444-444444444444";
const FOREIGN = "55555555-5555-4555-8555-555555555555";
const ERASED = "66666666-6666-4666-8666-666666666666";
const FILE_BLOCK = "77777777-7777-4777-8777-777777777777";
const COMPLAINT = "88888888-8888-4888-8888-888888888888";
const VIEWER = { uid: "staff-uid", email: "Owner@Shop.test" };

function block(over: Partial<FakeBlock>): FakeBlock {
  return {
    id: BLOCK,
    store_id: STORE,
    store_label: "Shop (shop.storemink.com)",
    parent_block_id: null,
    item_kind: "product",
    item_id: PRODUCT,
    item_label: "Blue mug",
    object_path: null,
    file_source: null,
    author_user_id: null,
    reason_kind: "court_order",
    complaint_id: null,
    ref_no: null,
    store_message: "A court asked us to block this.",
    lift_note: "",
    tell_store: true,
    erased_at: null,
    blocked_at: "2026-10-29 10:00:00+00",
    lifted_at: null,
    merchant_seen_at: null,
    item_exists: true,
    ...over,
  };
}

function seed() {
  h.blocks = [
    block({ id: BLOCK, complaint_id: COMPLAINT, ref_no: 123 }),
    block({
      id: IMAGE,
      parent_block_id: BLOCK,
      item_kind: "file",
      item_id: null,
      object_path: `stores/${STORE}/uploads/mug.webp`,
      file_source: "bucket",
      item_label: "mug.webp",
    }),
    block({
      id: HIDDEN,
      item_label: "Secret",
      tell_store: false,
      blocked_at: "2026-10-29 12:00:00+00",
    }),
    block({ id: FOREIGN, store_id: OTHER_STORE, item_label: "Theirs" }),
    block({
      id: ERASED,
      item_label: "Erased",
      store_message: "Erased",
      erased_at: "2026-10-29 13:00:00+00",
      lifted_at: "2026-10-29 11:00:00+00",
    }),
    block({
      id: FILE_BLOCK,
      item_kind: "file",
      item_id: null,
      object_path: `stores/${STORE}/uploads/report.pdf`,
      file_source: "bucket",
      item_label: "report.pdf",
      reason_kind: "terms_breach",
      blocked_at: "2026-10-28 10:00:00+00",
      lifted_at: "2026-10-29 09:00:00+00",
      lift_note: "Fixed.",
    }),
  ];
  h.messages = [
    {
      id: "99999999-9999-4999-8999-999999999991",
      block_id: BLOCK,
      from_side: "storemink",
      author: "operator@storemink.com",
      body: "Please send proof.",
      asks_review: false,
      created_at: "2026-10-29 11:00:00+00",
    },
    {
      id: "99999999-9999-4999-8999-999999999992",
      block_id: BLOCK,
      from_side: "store",
      author: "owner@shop.test",
      body: "Here it is.",
      asks_review: true,
      created_at: "2026-10-29 12:00:00+00",
    },
  ];
}

beforeEach(() => {
  h.executed = [];
  h.scopes = 0;
  h.fail = null;
  seed();
});

describe("listStoreNotices", () => {
  it("lists only this store's told blocks, newest first, images under their item", async () => {
    const rows = await listStoreNotices(STORE);
    expect(rows.map((r) => r.blockId)).toEqual([BLOCK, FILE_BLOCK]);
    expect(rows[0]).toMatchObject({
      kind: "product",
      itemLabel: "Blue mug",
      reasonKind: "court_order",
      liftedAt: null,
      seen: false,
      images: [{ blockId: IMAGE, label: "mug.webp", lifted: false }],
    });
    expect(rows[1]).toMatchObject({
      kind: "file",
      contentType: null,
      liftedAt: "2026-10-29T09:00:00.000Z",
    });
  });

  it("never shows a block kept from the store, another store's or an erased one", async () => {
    const ids = (await listStoreNotices(STORE)).flatMap((r) => [
      r.blockId,
      ...r.images.map((i) => i.blockId),
    ]);
    expect(ids).not.toContain(HIDDEN);
    expect(ids).not.toContain(FOREIGN);
    expect(ids).not.toContain(ERASED);
    const [query] = h.executed;
    expect(query.text).toContain("b.tell_store");
    expect(query.text).toContain("b.erased_at is null");
    expect(query.params).toContain(STORE);
  });

  it("shows an image as its own notice when its item is not listed", async () => {
    h.blocks = h.blocks.filter((b) => b.id !== BLOCK);
    const rows = await listStoreNotices(STORE);
    expect(rows.map((r) => r.blockId)).toContain(IMAGE);
    expect(rows.find((r) => r.blockId === IMAGE)?.contentType).toBe(
      "image/webp",
    );
  });

  it("asks nothing for a malformed store id", async () => {
    expect(await listStoreNotices("not-a-uuid")).toEqual([]);
    expect(h.scopes).toBe(0);
  });

  it("throws on a database error rather than reading as no notices", async () => {
    h.fail = /from public\.content_blocks b/;
    await expect(listStoreNotices(STORE)).rejects.toThrow("database down");
  });
});

describe("getStoreNotice", () => {
  it("returns the notice with its reference, conversation and images", async () => {
    const notice = await getStoreNotice(STORE, BLOCK);
    expect(notice).toMatchObject({
      blockId: BLOCK,
      reference: "SM-000123",
      complaintId: COMPLAINT,
      storeMessage: "A court asked us to block this.",
      edit: { href: `/dashboard/products/${PRODUCT}`, section: "products" },
      images: [{ blockId: IMAGE, label: "mug.webp", lifted: false }],
    });
    expect(notice?.messages).toEqual([
      expect.objectContaining({
        fromStoreMink: true,
        author: NOTICE.storeMinkAuthor,
        body: "Please send proof.",
      }),
      expect.objectContaining({
        fromStoreMink: false,
        author: "owner@shop.test",
        asksReview: true,
      }),
    ]);
  });

  it("never gives the store an operator's address", async () => {
    const notice = await getStoreNotice(STORE, BLOCK);
    expect(JSON.stringify(notice)).not.toContain("operator@storemink.com");
  });

  it("is not found for a block kept from the store, another store's, an erased one or a bad id", async () => {
    expect(await getStoreNotice(STORE, HIDDEN)).toBeNull();
    expect(await getStoreNotice(STORE, FOREIGN)).toBeNull();
    expect(await getStoreNotice(STORE, ERASED)).toBeNull();
    expect(await getStoreNotice(STORE, "nope")).toBeNull();
    expect(await getStoreNotice(OTHER_STORE, BLOCK)).toBeNull();
  });

  it("offers no edit link once the item is gone", async () => {
    h.blocks[0].item_exists = false;
    expect((await getStoreNotice(STORE, BLOCK))?.edit).toBeNull();
  });

  it("links each kind to the screen that edits it", async () => {
    const link = async (over: Partial<FakeBlock>) => {
      h.blocks = [block({ id: BLOCK, ...over })];
      return (await getStoreNotice(STORE, BLOCK))?.edit;
    };
    expect(await link({ item_kind: "page" })).toEqual({
      href: "/dashboard/builder",
      section: "builder",
    });
    expect(await link({ item_kind: "blog_post" })).toEqual({
      href: "/dashboard/blogs",
      section: "blogs",
    });
    expect(await link({ item_kind: "collection" })).toEqual({
      href: "/dashboard/categories",
      section: "categories",
    });
    expect(
      await link({ item_kind: "review", author_user_id: "user 1" }),
    ).toEqual({
      href: "/dashboard/users/user%201",
      section: "users",
    });
    expect(
      await link({
        item_kind: "file",
        item_id: null,
        object_path: "x/y.png",
        file_source: "bucket",
      }),
    ).toEqual({ href: "/dashboard/media", section: "media" });
    expect(await link({ item_kind: "blog_comment" })).toBeNull();
  });

  it("names the image type of a blocked file", async () => {
    expect((await getStoreNotice(STORE, IMAGE))?.contentType).toBe(
      "image/webp",
    );
  });
});

describe("markNoticeSeen", () => {
  it("marks the block, its images, StoreMink's messages and the viewer's bell", async () => {
    expect(await markNoticeSeen(STORE, BLOCK, VIEWER)).toBe(true);
    const updates = h.executed.filter((q) => q.text.startsWith("update"));
    expect(updates).toHaveLength(3);
    const [blocks, messages, bell] = updates;
    expect(blocks.text).toContain("set merchant_seen_at = now()");
    expect(blocks.text).toContain("b.parent_block_id = $");
    expect(blocks.text).toContain("a.is_suspended is not true");
    expect(blocks.params).toContain("staff-uid");
    expect(messages.text).toContain("m.from_side = 'storemink'");
    expect(messages.text).toContain("b.tell_store");
    expect(bell.text).toContain("n.recipient_id = $");
    expect(bell.text).toContain("e.subject_type = 'content_block'");
    expect(bell.params).toContainEqual([
      "store.content_blocked",
      "store.content_block_lifted",
      "store.content_block_reply",
    ]);
  });

  it("marks nothing for a block kept from the store or another store's", async () => {
    expect(await markNoticeSeen(STORE, HIDDEN, VIEWER)).toBe(false);
    expect(await markNoticeSeen(STORE, FOREIGN, VIEWER)).toBe(false);
    expect(h.executed.some((q) => q.text.startsWith("update"))).toBe(false);
  });

  it("asks nothing for malformed input", async () => {
    expect(await markNoticeSeen(STORE, "x", VIEWER)).toBe(false);
    expect(await markNoticeSeen(STORE, BLOCK, { uid: "", email: null })).toBe(
      false,
    );
    expect(h.scopes).toBe(0);
  });
});

describe("storeNoticeSummary", () => {
  it("counts live notices nobody has opened and names the only one", async () => {
    expect(await storeNoticeSummary(STORE)).toEqual({
      unopened: 1,
      onlyBlockId: BLOCK,
    });
    const [query] = h.executed;
    expect(query.text).toContain("b.parent_block_id is null");
    expect(query.text).toContain("b.lifted_at is null");
    expect(query.text).toContain("b.merchant_seen_at is null");
  });

  it("names no notice when several are unopened", async () => {
    const file = h.blocks.find((b) => b.id === FILE_BLOCK);
    if (file) file.lifted_at = null;
    expect(await storeNoticeSummary(STORE)).toEqual({
      unopened: 2,
      onlyBlockId: null,
    });
  });

  it("fails soft to no banner", async () => {
    h.fail = /unopened/;
    expect(await storeNoticeSummary(STORE)).toEqual({
      unopened: 0,
      onlyBlockId: null,
    });
    expect(logError).toHaveBeenCalled();
  });
});

describe("blockedItemIds", () => {
  it("maps each live told item to its notice", async () => {
    const products = await blockedItemIds(STORE, "product");
    expect([...products]).toEqual([[PRODUCT, BLOCK]]);
    const files = await blockedItemIds(STORE, "file");
    expect([...files]).toEqual([[`stores/${STORE}/uploads/mug.webp`, IMAGE]]);
  });

  it("never marks an item kept from the store", async () => {
    h.blocks = [block({ id: HIDDEN, tell_store: false })];
    expect((await blockedItemIds(STORE, "product")).size).toBe(0);
  });

  it("fails soft to no marks", async () => {
    h.fail = /item_key/;
    expect((await blockedItemIds(STORE, "product")).size).toBe(0);
    expect(logError).toHaveBeenCalled();
  });

  it("asks nothing for an unknown kind or a bad store", async () => {
    expect((await blockedItemIds(STORE, "store" as never)).size).toBe(0);
    expect((await blockedItemIds("x", "product")).size).toBe(0);
    expect(h.scopes).toBe(0);
  });
});

describe("storeReplyBody", () => {
  it("trims, and refuses empty or too long", () => {
    expect(storeReplyBody("  hi  ")).toBe("hi");
    expect(storeReplyBody("   ")).toEqual({ error: NOTICE_REPLY.errors.empty });
    expect(storeReplyBody(42)).toEqual({ error: NOTICE_REPLY.errors.empty });
    expect(storeReplyBody("x".repeat(4001))).toEqual({
      error: NOTICE_REPLY.errors.tooLong,
    });
  });
});

describe("replyToStoreNotice", () => {
  it("saves the reply signed by the sender, records it, then tells StoreMink", async () => {
    const result = await replyToStoreNotice(
      STORE,
      { blockId: BLOCK, body: "  We fixed it.  ", asksReview: true },
      VIEWER,
    );
    expect(result).toEqual({
      ok: true,
      messageId: expect.any(String),
      notified: true,
    });
    const saved = h.messages.at(-1);
    expect(saved).toMatchObject({
      block_id: BLOCK,
      from_side: "store",
      author: "owner@shop.test",
      body: "We fixed it.",
      asks_review: true,
    });
    expect(recordModerationEvent).toHaveBeenCalledWith(expect.anything(), {
      actor: "owner@shop.test",
      action: "store_replied",
      blockId: BLOCK,
      storeId: STORE,
      detail: { messageId: saved?.id, asksReview: true },
    });
    expect(notifyTakedownReply).toHaveBeenCalledWith({
      blockId: BLOCK,
      itemLabel: "Blue mug",
      storeName: "Shop (shop.storemink.com)",
      askedForReview: true,
    });
    const recorded = vi.mocked(recordModerationEvent).mock
      .invocationCallOrder[0];
    const notified = vi.mocked(notifyTakedownReply).mock.invocationCallOrder[0];
    expect(notified).toBeGreaterThan(recorded);
  });

  it("refuses an empty or over-long reply before any query", async () => {
    expect(
      await replyToStoreNotice(
        STORE,
        { blockId: BLOCK, body: " ", asksReview: false },
        VIEWER,
      ),
    ).toEqual({ ok: false, error: NOTICE_REPLY.errors.empty });
    expect(
      await replyToStoreNotice(
        STORE,
        { blockId: BLOCK, body: "x".repeat(4001), asksReview: false },
        VIEWER,
      ),
    ).toEqual({ ok: false, error: NOTICE_REPLY.errors.tooLong });
    expect(h.scopes).toBe(0);
  });

  it("is not found for a block kept from the store or another store's", async () => {
    for (const blockId of [HIDDEN, FOREIGN, "bad"]) {
      expect(
        await replyToStoreNotice(
          STORE,
          { blockId, body: "Hi", asksReview: false },
          VIEWER,
        ),
      ).toEqual({ ok: false, error: NOTICE.notFound });
    }
    expect(h.messages).toHaveLength(2);
    expect(notifyTakedownReply).not.toHaveBeenCalled();
  });

  it("refuses a reply on a lifted block", async () => {
    expect(
      await replyToStoreNotice(
        STORE,
        { blockId: FILE_BLOCK, body: "Hi", asksReview: false },
        VIEWER,
      ),
    ).toEqual({ ok: false, error: NOTICE_REPLY.errors.lifted });
    expect(h.messages).toHaveLength(2);
  });

  it("reports a failed save and tells nobody", async () => {
    h.fail = /^insert into public\.content_block_messages/;
    expect(
      await replyToStoreNotice(
        STORE,
        { blockId: BLOCK, body: "Hi", asksReview: false },
        VIEWER,
      ),
    ).toEqual({ ok: false, error: NOTICE_REPLY.failed });
    expect(logError).toHaveBeenCalled();
    expect(notifyTakedownReply).not.toHaveBeenCalled();
  });

  it("keeps the reply when telling StoreMink fails", async () => {
    vi.mocked(notifyTakedownReply).mockRejectedValueOnce(
      new Error("bell down"),
    );
    const result = await replyToStoreNotice(
      STORE,
      { blockId: BLOCK, body: "Hi", asksReview: false },
      VIEWER,
    );
    expect(result).toMatchObject({ ok: true, notified: false });
    expect(h.messages).toHaveLength(3);
  });

  it("runs in one service scope and never nests another", async () => {
    await replyToStoreNotice(
      STORE,
      { blockId: BLOCK, body: "Hi", asksReview: false },
      VIEWER,
    );
    expect(withService).toHaveBeenCalledTimes(1);
  });
});
