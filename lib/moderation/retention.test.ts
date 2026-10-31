import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  queries: [] as unknown[],
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) =>
    fn({
      execute: async (query: unknown) => {
        h.queries.push(query);
        return { rows: h.rows, rowCount: h.rows.length };
      },
    }),
  ),
}));
vi.mock("./record", () => ({
  recordModerationEvent: vi.fn(async () => "event-id"),
}));
vi.mock("./archive", () => ({
  purgeDueArchives: vi.fn(async () => 4),
}));
vi.mock("./complaints", () => ({
  eraseResolvedComplaints: vi.fn(async () => 6),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  ARCHIVE_KEEP_DAYS,
  ARCHIVE_PURGE_BATCH,
  BLOCK_ERASE_BATCH_MAX,
  ERASED_AUTHOR,
  ERASED_LABEL,
  MODERATION_RECORD_DAYS,
  eraseLiftedBlocks,
  eraseTakedownComplaints,
  pruneModerationEvents,
  purgeTakedownArchives,
} from "./retention";
import { withService } from "@/lib/db/client";
import { recordModerationEvent } from "./record";
import { purgeDueArchives } from "./archive";
import { eraseResolvedComplaints } from "./complaints";
import { logInfo } from "@/lib/observability/logger";
import type { RetentionBatchContext } from "@/lib/retention/prune";

const dialect = new PgDialect();
const compiled = (index = 0) => {
  const query = dialect.sqlToQuery(h.queries[index] as SQL);
  return { ...query, text: query.sql.replace(/\s+/g, " ").trim() };
};

const NOW = new Date("2026-10-30T06:00:00.000Z");
const THREE_YEARS_AGO = "2023-10-31T06:00:00.000Z";

function context(): RetentionBatchContext {
  return {
    deadline: Number.POSITIVE_INFINITY,
    clock: Date.now,
    skip: new Set(),
    outOfTime: false,
  };
}

function reset(rows: unknown[] = []) {
  h.rows = rows;
  h.queries = [];
}

describe("the windows", () => {
  it("keeps archives 180 days and the record 3 years", () => {
    expect(ARCHIVE_KEEP_DAYS).toBe(180);
    expect(MODERATION_RECORD_DAYS).toBe(1095);
    expect(ARCHIVE_PURGE_BATCH).toBe(20);
    expect(BLOCK_ERASE_BATCH_MAX).toBe(200);
    expect(ERASED_LABEL).toBe("Erased");
    expect(ERASED_AUTHOR).toBe("erased");
  });
});

describe("purgeTakedownArchives", () => {
  it("hands purgeDueArchives the sweep's context and at most 20", async () => {
    const batch = context();
    expect(await purgeTakedownArchives(THREE_YEARS_AGO, 50, batch)).toBe(4);
    expect(purgeDueArchives).toHaveBeenCalledWith(20, batch);
    expect(vi.mocked(purgeDueArchives).mock.calls[0][1]).toBe(batch);
  });

  it("passes a smaller limit through, and ignores the floor", async () => {
    await purgeTakedownArchives("not a date", 7, context());
    expect(vi.mocked(purgeDueArchives).mock.calls[0][0]).toBe(7);
  });
});

describe("pruneModerationEvents", () => {
  it("calls the record's only delete with the floor and the limit", async () => {
    reset([{ deleted: 12 }]);
    expect(await pruneModerationEvents(THREE_YEARS_AGO, 1000)).toBe(12);
    const query = compiled();
    expect(query.text).toBe(
      "select public.moderation_prune_events($1::timestamptz, $2::integer) as deleted",
    );
    expect(query.params).toEqual([THREE_YEARS_AGO, 1000]);
  });

  it("reads no row as nothing deleted", async () => {
    reset([]);
    expect(await pruneModerationEvents(THREE_YEARS_AGO, 1000)).toBe(0);
  });
});

describe("eraseTakedownComplaints", () => {
  it("delegates to complaints.ts with the floor and the limit", async () => {
    expect(await eraseTakedownComplaints(THREE_YEARS_AGO, 500)).toBe(6);
    expect(eraseResolvedComplaints).toHaveBeenCalledWith(THREE_YEARS_AGO, 500);
  });
});

describe("eraseLiftedBlocks", () => {
  it("refuses a floor that is not a time", async () => {
    await expect(eraseLiftedBlocks("soon", 10, { now: NOW })).rejects.toThrow(
      RangeError,
    );
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses a floor less than a year old", async () => {
    await expect(
      eraseLiftedBlocks("2026-01-01T00:00:00.000Z", 10, { now: NOW }),
    ).rejects.toThrow("at least a year ago");
    expect(withService).not.toHaveBeenCalled();
  });

  it("does nothing for a batch of none", async () => {
    expect(await eraseLiftedBlocks(THREE_YEARS_AGO, 0, { now: NOW })).toBe(0);
    expect(await eraseLiftedBlocks(THREE_YEARS_AGO, -5, { now: NOW })).toBe(0);
    expect(withService).not.toHaveBeenCalled();
  });

  it("locks the oldest lifts first, skipping held stores, held complaints and kept archives", async () => {
    reset([]);
    expect(await eraseLiftedBlocks(THREE_YEARS_AGO, 1000, { now: NOW })).toBe(
      0,
    );
    const { text, params } = compiled();
    expect(text).toContain("b.erased_at is null");
    expect(text).toContain("b.lifted_at is not null");
    expect(text).toContain("b.lifted_at < $1::timestamptz");
    expect(text).toContain(
      "select 1 from public.store_legal_holds h where h.released_at is null and (h.store_id = b.store_id or (b.complaint_id is not null and h.complaint_id = b.complaint_id))",
    );
    expect(text).toContain(
      "select 1 from public.content_block_archives a where a.block_id = b.id and (a.legal_hold or a.purged_at is null)",
    );
    expect(text).toContain("order by b.lifted_at, b.id limit $2");
    expect(text).toContain("for update of b skip locked");
    expect(params[0]).toBe(THREE_YEARS_AGO);
    // The batch is clamped to 200.
    expect(params[1]).toBe(200);
  });

  it("blanks the block's words and its conversation's, keeping what was blocked", async () => {
    reset([]);
    await eraseLiftedBlocks(THREE_YEARS_AGO, 10, { now: NOW });
    const { text, params } = compiled();
    expect(text).toContain(
      "set item_label = $3, item_url = '', legal_basis = '', lift_note = '', store_message = $4, erased_at = now(), updated_at = now()",
    );
    expect(text).toContain(
      "update public.content_block_messages m set body = $5, author = $6 from erased where m.block_id = erased.id",
    );
    expect(params.slice(2, 6)).toEqual([
      "Erased",
      "Erased",
      "Erased",
      "erased",
    ]);
    // Nothing else about the block is written.
    expect(text).not.toMatch(/item_kind\s*=|blocked_at\s*=|reason\s*=/);
  });

  it("records block_erased for each block in the same transaction and logs the count", async () => {
    reset([
      { id: "block-1", store_id: "store-1", messages: 3 },
      { id: "block-2", store_id: null, messages: 0 },
    ]);
    expect(
      await eraseLiftedBlocks(THREE_YEARS_AGO, 10, {
        now: NOW,
        actor: "operator@storemink.com",
      }),
    ).toBe(2);
    expect(withService).toHaveBeenCalledTimes(1);
    expect(recordModerationEvent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordModerationEvent).mock.calls[0][1]).toEqual({
      actor: "operator@storemink.com",
      action: "block_erased",
      blockId: "block-1",
      storeId: "store-1",
      detail: { messages: 3 },
    });
    expect(vi.mocked(recordModerationEvent).mock.calls[1][1]).toMatchObject({
      blockId: "block-2",
      storeId: null,
      detail: { messages: 0 },
    });
    expect(logInfo).toHaveBeenCalledWith(
      "moderation.retention: blocks erased",
      {
        erased: 2,
      },
    );
  });

  it("is the system's act by default, and says nothing when nothing went", async () => {
    reset([{ id: "block-1", store_id: "store-1", messages: 1 }]);
    await eraseLiftedBlocks(new Date(THREE_YEARS_AGO), 10, { now: NOW });
    expect(vi.mocked(recordModerationEvent).mock.calls[0][1]).toMatchObject({
      actor: "system",
    });
    vi.mocked(logInfo).mockClear();
    reset([]);
    await eraseLiftedBlocks(THREE_YEARS_AGO, 10, { now: NOW });
    expect(logInfo).not.toHaveBeenCalled();
  });
});
