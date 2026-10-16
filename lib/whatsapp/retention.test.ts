/* eslint-disable @typescript-eslint/no-explicit-any */
// Deleting closed WhatsApp conversations two years after their last message.
// The rule every case defends: a customer's photo never outlives its chat,
// and a chat that is still going is never touched.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
const gcs = vi.hoisted(() => ({ configured: true, privateConfigured: true }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));
vi.mock("@/lib/storage/gcs", () => ({
  get gcsConfigured() {
    return gcs.configured;
  },
  get gcsPrivateConfigured() {
    return gcs.privateConfigured;
  },
  gcsDeletePrefix: vi.fn(async () => ({ deleted: 2, failed: 0 })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { conversationMediaPrefix, pruneClosedConversations } from "./retention";
import { gcsDeletePrefix } from "@/lib/storage/gcs";

const STORE = "11111111-1111-4111-8111-111111111111";
const FLOOR = "2024-10-13T00:00:00.000Z";
const dialect = new PgDialect();
const query = (q: any) => dialect.sqlToQuery(q);
const text = (q: any) => query(q).sql.replace(/\s+/g, " ");

function setup(candidates: any[], deleted = candidates.length) {
  dbHolder.current = makeDbMock({ executeQueue: [candidates] });
  // The delete reports rowCount, which the queue's { rows } shape lacks.
  const original = dbHolder.current.db.execute;
  let call = 0;
  dbHolder.current.db.execute = vi.fn(async (q: any) => {
    call++;
    if (call === 1) return original(q);
    dbHolder.current.calls.execute.push(q);
    return { rows: [], rowCount: deleted };
  });
  return dbHolder.current;
}

beforeEach(() => {
  gcs.configured = true;
  gcs.privateConfigured = true;
});

describe("pruneClosedConversations", () => {
  it("★ selects only CLOSED conversations, by their last message", async () => {
    const mock = setup([]);
    expect(await pruneClosedConversations(FLOOR, 50)).toBe(0);
    const select = text(mock.calls.execute[0]);
    expect(select).toMatch(/c\.status = 'closed'/);
    expect(select).toMatch(/coalesce\(c\.last_message_at, c\.updated_at\) </);
    expect(query(mock.calls.execute[0]).params).toEqual([FLOOR, 7, 50]);
  });

  it("★★ leaves out a conversation whose media failed within the last week", async () => {
    const mock = setup([]);
    await pruneClosedConversations(FLOOR, 50);
    expect(text(mock.calls.execute[0])).toMatch(
      /c\.retention_failed_at is null or c\.retention_failed_at < now\(\) - make_interval\(days => \$2\)/,
    );
  });

  it("deletes the media folder, then the conversation (messages cascade)", async () => {
    const mock = setup([
      { id: "c1", store_id: STORE, has_media: true },
      { id: "c2", store_id: STORE, has_media: false },
    ]);
    expect(await pruneClosedConversations(FLOOR, 50)).toBe(2);
    // ★ Both buckets: chat media is private now, older chats' is public.
    expect(gcsDeletePrefix).toHaveBeenCalledTimes(2);
    expect(gcsDeletePrefix).toHaveBeenCalledWith(
      `stores/${STORE}/whatsapp/c1/`,
      "private",
    );
    expect(gcsDeletePrefix).toHaveBeenCalledWith(
      `stores/${STORE}/whatsapp/c1/`,
      "public",
    );
    const del = query(mock.calls.execute[1]);
    expect(del.sql).toMatch(/delete from public\.whatsapp_conversations/);
    expect(del.params[0]).toEqual(["c1", "c2"]);
  });

  it("★★ re-checks, inside the delete, that it is still closed and stale", async () => {
    const mock = setup([{ id: "c1", store_id: STORE, has_media: false }]);
    await pruneClosedConversations(FLOOR, 50);
    const del = text(mock.calls.execute[1]);
    expect(del).toMatch(/and status = 'closed'/);
    expect(del).toMatch(/coalesce\(last_message_at, updated_at\) </);
  });

  it("★★ keeps a conversation whose media could not be deleted", async () => {
    vi.mocked(gcsDeletePrefix).mockResolvedValueOnce({
      deleted: 1,
      failed: 1,
    });
    const mock = setup(
      [
        { id: "c1", store_id: STORE, has_media: true },
        { id: "c2", store_id: STORE, has_media: false },
      ],
      1,
    );
    expect(await pruneClosedConversations(FLOOR, 50)).toBe(1);
    // The stuck one is marked, so tomorrow's batch moves past it.
    const mark = query(mock.calls.execute[1]);
    expect(mark.sql).toMatch(/set retention_failed_at = now\(\)/);
    expect(mark.params[0]).toEqual(["c1"]);
    expect(query(mock.calls.execute[2]).params[0]).toEqual(["c2"]);
  });

  it("★ keeps a conversation whose OLD public-bucket media failed", async () => {
    vi.mocked(gcsDeletePrefix)
      .mockResolvedValueOnce({ deleted: 1, failed: 0 })
      .mockResolvedValueOnce({ deleted: 0, failed: 0, error: "down" });
    const mock = setup([{ id: "c1", store_id: STORE, has_media: true }]);
    expect(await pruneClosedConversations(FLOOR, 50)).toBe(0);
    expect(query(mock.calls.execute[1]).params[0]).toEqual(["c1"]);
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("deletes nothing at all when every candidate's media failed", async () => {
    vi.mocked(gcsDeletePrefix).mockResolvedValueOnce({
      deleted: 0,
      failed: 0,
      error: "down",
    });
    const mock = setup([{ id: "c1", store_id: STORE, has_media: true }]);
    expect(await pruneClosedConversations(FLOOR, 50)).toBe(0);
    // The select and the stuck mark; no delete.
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("without a bucket (local development) there is no media to delete", async () => {
    gcs.configured = false;
    gcs.privateConfigured = false;
    setup([{ id: "c1", store_id: STORE, has_media: true }]);
    expect(await pruneClosedConversations(FLOOR, 50)).toBe(1);
    expect(gcsDeletePrefix).not.toHaveBeenCalled();
  });

  it("names one conversation's folder exactly", () => {
    expect(conversationMediaPrefix(STORE, "c1")).toBe(
      `stores/${STORE}/whatsapp/c1/`,
    );
  });
});
