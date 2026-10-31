// Log retention: the stopping rules.
//
// ── What these tests can and cannot cover ─────────────────────────────────
// `deleteBatch` is injected, so everything with a decision in it (when to
// stop, how big the final batch may be, whether one table's failure stops the
// next) is exercised here without a database. What is NOT covered is the
// drizzle closure `batchDeleter` builds: that it selects by `created_at` and
// deletes those ids is verified by reading it, the same way
// lib/domains/reconcile.ts is. The invariant it depends on (a `created_at`
// index on all three tables) is asserted in the SQL files, not here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

// The module builds real drizzle closures at import time; nothing here calls
// them, but the client must not open a pool just to load the file.
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn({})),
}));

// The takedown deleters are checked here for what the sweep hands them; their
// own SQL is lib/moderation/retention.test.ts's.
vi.mock("@/lib/moderation/archive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/archive")>()),
  purgeDueArchives: vi.fn(async () => 3),
}));
vi.mock("@/lib/moderation/complaints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/complaints")>()),
  eraseResolvedComplaints: vi.fn(async () => 2),
}));

import {
  RETENTION_POLICIES,
  retentionFloor,
  runRetentionSweep,
  sweepPolicy,
  type RetentionBatchContext,
  type RetentionPolicy,
} from "./prune";
import { withService } from "@/lib/db/client";
import { pruneIdleMinkConversations } from "@/lib/mink/conversation-retention";
import {
  MINK_ATTACHMENT_UNSENT_DAYS,
  purgeMinkAttachments,
} from "@/lib/mink/attachments";
import { moveLegacyMinkAttachments } from "@/lib/mink/attachments-legacy";
import { purgeDueArchives } from "@/lib/moderation/archive";
import { eraseResolvedComplaints } from "@/lib/moderation/complaints";
import {
  pruneModerationEvents,
  purgeTakedownArchives,
} from "@/lib/moderation/retention";

/** The windows shorter than a week, each a deliberate decision below. */
const SHORT_WINDOWS = new Set([
  "pos_parked_sales",
  "mink_csv_files",
  "mink_attachments",
  "mink_attachments_legacy",
]);

/** A policy whose batches return the given counts, in order. */
function policyReturning(
  counts: number[],
  table = "t",
): RetentionPolicy & { calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  return {
    table,
    days: 90,
    reason: "test",
    calls,
    deleteBatch: async (_floor: string, limit: number) => {
      calls.push(limit);
      // Clamped to `limit` because the real deleter selects with .limit(n) and
      // so cannot return more than it was asked for. A fake that overshoots
      // tests a contract the database would never break.
      return Math.min(counts[i++] ?? 0, limit);
    },
  };
}

beforeEach(() => vi.clearAllMocks());

/** A context for calling one deleter directly. */
const context = (): RetentionBatchContext => ({
  deadline: Number.POSITIVE_INFINITY,
  clock: Date.now,
  skip: new Set(),
  outOfTime: false,
});

describe("retentionFloor", () => {
  it("returns the instant a row of that age was created", () => {
    const now = new Date("2026-08-07T00:00:00.000Z");
    expect(retentionFloor(90, now)).toBe("2026-05-09T00:00:00.000Z");
  });

  it("treats 0 days as 'delete everything up to now'", () => {
    const now = new Date("2026-08-07T00:00:00.000Z");
    expect(retentionFloor(0, now)).toBe(now.toISOString());
  });
});

describe("sweepPolicy", () => {
  it("drains heavy rows using the policy's smaller batches", async () => {
    const policy = { ...policyReturning([50, 50, 3]), batchSize: 50 };
    expect(await sweepPolicy(policy)).toMatchObject({
      deleted: 103,
      stop: "drained",
    });
    expect(policy.calls).toEqual([50, 50, 50]);
  });
  it("stops as soon as a batch comes back short", async () => {
    const policy = policyReturning([10]);
    const result = await sweepPolicy(policy, { batchSize: 1000 });

    expect(result).toMatchObject({ deleted: 10, stop: "drained" });
    expect(policy.calls).toHaveLength(1);
  });

  it("keeps going while batches come back full", async () => {
    const policy = policyReturning([100, 100, 40]);
    const result = await sweepPolicy(policy, { batchSize: 100 });

    expect(result).toMatchObject({ deleted: 240, stop: "drained" });
    expect(policy.calls).toEqual([100, 100, 100]);
  });

  it("costs one extra empty batch when the table drains exactly", async () => {
    // A full final batch is indistinguishable from more work, so the loop asks
    // once more and gets nothing. Cheap, and the alternative is stopping early
    // on a table that still has rows.
    const policy = policyReturning([100, 0]);
    const result = await sweepPolicy(policy, { batchSize: 100 });

    expect(result).toMatchObject({ deleted: 100, stop: "drained" });
    expect(policy.calls).toEqual([100, 100]);
  });

  it("stops at the cap and never deletes past it", async () => {
    const policy = policyReturning([100, 100, 100]);
    const result = await sweepPolicy(policy, { batchSize: 100, maxRows: 250 });

    expect(result).toMatchObject({ deleted: 250, stop: "cap" });
    // The final batch is narrowed to the remaining headroom, not the full size.
    expect(policy.calls).toEqual([100, 100, 50]);
  });

  it("stops when the time budget is spent, keeping what it deleted", async () => {
    let t = 0;
    const clock = () => (t += 50); // each check advances 50ms
    const policy = policyReturning([100, 100, 100, 100]);

    const result = await sweepPolicy(policy, {
      batchSize: 100,
      clock,
      deadline: 150,
    });

    expect(result.stop).toBe("budget");
    expect(result.deleted).toBeGreaterThan(0);
  });

  it("reports a failed batch without losing the rows already deleted", async () => {
    const policy: RetentionPolicy = {
      table: "t",
      days: 90,
      reason: "test",
      deleteBatch: vi
        .fn()
        .mockResolvedValueOnce(100)
        .mockRejectedValueOnce(new Error("deadlock detected")),
    };

    const result = await sweepPolicy(policy, { batchSize: 100 });

    expect(result).toMatchObject({
      deleted: 100,
      stop: "error",
      error: "deadlock detected",
    });
  });

  it("passes the same floor to every batch of a run", async () => {
    const floors: string[] = [];
    const policy: RetentionPolicy = {
      table: "t",
      days: 90,
      reason: "test",
      deleteBatch: async (floor) => {
        floors.push(floor);
        return floors.length < 3 ? 100 : 0;
      },
    };

    await sweepPolicy(policy, { batchSize: 100 });

    // A floor recomputed per batch would creep forward mid-run.
    expect(new Set(floors).size).toBe(1);
  });

  it("★ R2: every batch of one sweep gets the same context, with the run's deadline and clock", async () => {
    const seen: RetentionBatchContext[] = [];
    const clock = () => 1_000;
    const policy: RetentionPolicy = {
      table: "t",
      days: 90,
      reason: "test",
      deleteBatch: async (_floor, _limit, batch) => {
        seen.push(batch);
        batch.skip.add(`id-${seen.length}`);
        return seen.length < 3 ? 100 : 0;
      },
    };

    await sweepPolicy(policy, { batchSize: 100, clock, deadline: 5_000 });

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0].deadline).toBe(5_000);
    expect(seen[0].clock).toBe(clock);
    // What a batch set aside is still there for the next one.
    expect([...seen[0].skip]).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("★ R2: a deleter that stops for the clock is reported as budget, never drained, and is not asked again", async () => {
    const calls: number[] = [];
    const policy: RetentionPolicy = {
      table: "t",
      days: 90,
      reason: "test",
      deleteBatch: async (_floor, limit, batch) => {
        calls.push(limit);
        batch.outOfTime = true;
        return 3;
      },
    };

    const result = await sweepPolicy(policy, {
      batchSize: 25,
      clock: () => 0,
      deadline: 240_000,
    });

    expect(result).toMatchObject({ deleted: 3, stop: "budget" });
    expect(calls).toEqual([25]);
  });

  it("★ R2: a full batch that stops for the clock is budget too, not asked again", async () => {
    let calls = 0;
    const policy: RetentionPolicy = {
      table: "t",
      days: 90,
      reason: "test",
      deleteBatch: async (_floor, limit, batch) => {
        calls += 1;
        batch.outOfTime = true;
        return limit;
      },
    };
    const result = await sweepPolicy(policy, {
      batchSize: 25,
      clock: () => 0,
      deadline: 240_000,
    });
    expect(result).toMatchObject({ deleted: 25, stop: "budget" });
    expect(calls).toBe(1);
  });
});

describe("runRetentionSweep", () => {
  it("★ R2: each table's deleter gets the run's one deadline, in a context of its own", async () => {
    const seen: RetentionBatchContext[] = [];
    const recorder = (table: string): RetentionPolicy => ({
      table,
      days: 90,
      reason: "test",
      deleteBatch: async (_floor, _limit, batch) => {
        seen.push(batch);
        return 0;
      },
    });

    await runRetentionSweep([recorder("a"), recorder("b")], {
      clock: () => 0,
      deadline: 123_000,
    });

    expect(seen.map((batch) => batch.deadline)).toEqual([123_000, 123_000]);
    // A set-aside id never crosses tables.
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0].skip).not.toBe(seen[1].skip);
  });

  it("★ R2: a deleter out of time makes the run incomplete, not failed", async () => {
    const slow: RetentionPolicy = {
      table: "slow",
      days: 90,
      reason: "test",
      deleteBatch: async (_floor, _limit, batch) => {
        batch.outOfTime = true;
        return 0;
      },
    };
    const sweep = await runRetentionSweep([slow], {
      clock: () => 0,
      deadline: 240_000,
    });
    expect(sweep.results[0].stop).toBe("budget");
    expect(sweep.incomplete).toBe(true);
    expect(sweep.failed).toBe(false);
  });

  it("keeps sweeping after one table fails, and flags the run", async () => {
    const failing: RetentionPolicy = {
      table: "first",
      days: 90,
      reason: "test",
      deleteBatch: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const healthy = policyReturning([7], "second");

    const sweep = await runRetentionSweep([failing, healthy]);

    expect(sweep.failed).toBe(true);
    expect(sweep.deleted).toBe(7);
    expect(sweep.results.map((r) => r.stop)).toEqual(["error", "drained"]);
  });

  it("is not 'failed' merely because a backlog is still draining", async () => {
    const policy = policyReturning([100, 100], "big");
    const sweep = await runRetentionSweep([policy], {
      batchSize: 100,
      maxRows: 200,
    });

    expect(sweep.failed).toBe(false);
    expect(sweep.incomplete).toBe(true);
  });

  it("shares one deadline across tables rather than resetting per table", async () => {
    // Otherwise N tables could each burn the full budget and the route would
    // be killed before it reported anything.
    let t = 0;
    const clock = () => (t += 100);
    const first = policyReturning([100, 100, 100, 100], "first");
    const second = policyReturning([50], "second");

    const sweep = await runRetentionSweep([first, second], {
      batchSize: 100,
      clock,
      deadline: 250,
    });

    expect(sweep.results[0].stop).toBe("budget");
    expect(sweep.results[1].stop).toBe("budget");
    expect(sweep.results[1].deleted).toBe(0);
  });
});

describe("RETENTION_POLICIES", () => {
  it("keeps raw storefront events and attribution for only 14 days", () => {
    const byTable = new Map(
      RETENTION_POLICIES.map((policy) => [policy.table, policy.days]),
    );
    expect(byTable.get("storefront_events")).toBe(14);
    expect(byTable.get("storefront_order_attribution")).toBe(14);
  });

  it("prunes notifications before activity_events", () => {
    // notifications.event_id → activity_events ON DELETE CASCADE, so doing it
    // the other way round leaves the event sweep cascading through rows the
    // notification sweep would have taken cheaply.
    const order = RETENTION_POLICIES.map((p) => p.table);
    expect(order.indexOf("notifications")).toBeLessThan(
      order.indexOf("activity_events"),
    );
  });

  it("keeps the audit trail longest and the bodies shortest", () => {
    const days = Object.fromEntries(
      RETENTION_POLICIES.map((p) => [p.table, p.days]),
    );
    expect(days.activity_events).toBe(365);
    expect(days.notifications).toBe(90);
    expect(days.email_logs).toBe(90);
    expect(days.store_search_metrics).toBe(488);
  });

  it("★★ expires held sales, because the CAP is what runs out", () => {
    // pos_parked_sales allows 20 per LOCATION. Abandoned carts do not merely
    // accumulate: they fill the list and eventually stop a counter parking a
    // real one. A ceiling with nothing ageing out of it becomes a wall.
    const byTable = new Map(
      RETENTION_POLICIES.map((policy) => [policy.table, policy.days]),
    );
    expect(byTable.get("pos_parked_sales")).toBe(7);
  });

  it("held sales and temporary chat CSVs have the shortest retention", () => {
    // Deliberate: it holds no stock and no prices, so discarding one costs a
    // re-scan. Everything else in this registry is history somebody may need.
    const days = Object.fromEntries(
      RETENTION_POLICIES.map((p) => [p.table, p.days]),
    );
    expect(days.mink_csv_files).toBe(7);
    const others = Object.entries(days)
      .filter(([t]) => !SHORT_WINDOWS.has(t))
      .map(([, d]) => d as number);
    expect(Math.min(...others)).toBeGreaterThan(
      days.pos_parked_sales as number,
    );
  });

  it("★ an unsent Mink AI picture is the shortest window of all: 2 days, for both attachment entries", () => {
    // The unsent-picture floor (lib/mink/attachments.ts): a picture still
    // staged in an open composer at deploy time is left alone.
    const byTable = new Map(
      RETENTION_POLICIES.map((policy) => [policy.table, policy.days]),
    );
    expect(MINK_ATTACHMENT_UNSENT_DAYS).toBe(2);
    expect(byTable.get("mink_attachments")).toBe(MINK_ATTACHMENT_UNSENT_DAYS);
    expect(byTable.get("mink_attachments_legacy")).toBe(
      MINK_ATTACHMENT_UNSENT_DAYS,
    );
    expect(MINK_ATTACHMENT_UNSENT_DAYS).toBeLessThan(
      byTable.get("pos_parked_sales") as number,
    );
  });

  it("★ purges Mink AI chat pictures straight after the chats, in batches of 50", () => {
    // A chat retired tonight has marked its pictures; the purge must read
    // those marks in the same run.
    const tables = RETENTION_POLICIES.map((entry) => entry.table);
    expect(tables.indexOf("mink_attachments")).toBe(
      tables.indexOf("mink_conversations") + 1,
    );
    const policy = RETENTION_POLICIES.find(
      (entry) => entry.table === "mink_attachments",
    );
    expect(policy?.batchSize).toBe(50);
    expect(policy?.reason).toContain("deleted with its chat");
    expect(policy?.reason).toContain("never sent is deleted 2 days after");
    expect(policy?.deleteBatch).toBe(purgeMinkAttachments);
  });

  it("★ the legacy move is the LAST entry, in batches of 25, and counts what it handled", () => {
    // Last because it is slow and the run shares one deadline; temporary,
    // removed once production reports nothing left for a week.
    const last = RETENTION_POLICIES.at(-1);
    expect(last?.table).toBe("mink_attachments_legacy");
    expect(last?.batchSize).toBe(25);
    expect(last?.days).toBe(MINK_ATTACHMENT_UNSENT_DAYS);
    expect(last?.reason).toContain("before they were stored privately");
    expect(last?.reason).toContain("moves to private storage with that chat");
    expect(last?.deleteBatch).toBe(moveLegacyMinkAttachments);
    expect(
      RETENTION_POLICIES.filter(
        (entry) => entry.table === "mink_attachments_legacy",
      ),
    ).toHaveLength(1);
  });

  it("keeps a closed WhatsApp conversation two years after its last message", () => {
    const byTable = new Map(
      RETENTION_POLICIES.map((policy) => [policy.table, policy.days]),
    );
    expect(byTable.get("whatsapp_conversations")).toBe(730);
  });

  it("★ retires a Mink AI chat 90 days after its last use, in small batches", () => {
    const policy = RETENTION_POLICIES.find(
      (entry) => entry.table === "mink_conversations",
    );
    expect(policy?.days).toBe(90);
    expect(policy?.batchSize).toBe(50);
    expect(policy?.reason).toContain("last sent a message in it");
    expect(policy?.deleteBatch).toBe(pruneIdleMinkConversations);
  });

  it("★ forgets a Generate with AI refund after 90 days, one page of its own rows at a time", async () => {
    // ai_quota_refunds (migration 0237) has no Drizzle table, so its deleter
    // is raw SQL: the page is chosen by created_at, deleted by take_id.
    const policy = RETENTION_POLICIES.find(
      (entry) => entry.table === "ai_quota_refunds",
    );
    expect(policy?.days).toBe(90);
    const execute = vi.fn<
      (query: SQL) => Promise<{ rows: unknown[]; rowCount: number }>
    >(async () => ({ rows: [], rowCount: 7 }));
    vi.mocked(withService).mockImplementationOnce(async (fn) =>
      fn({ execute } as never),
    );

    const floor = "2026-07-26T00:00:00.000Z";
    expect(await policy!.deleteBatch(floor, 1000, context())).toBe(7);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql.replace(/\s+/g, " ").trim()).toBe(
      "DELETE FROM public.ai_quota_refunds WHERE take_id IN ( SELECT take_id FROM public.ai_quota_refunds WHERE created_at < $1::timestamptz LIMIT $2 )",
    );
    expect(query.params).toEqual([floor, 1000]);
  });

  it("★ forgets a Refine with Mink AI stop after 30 days, by its composite key", async () => {
    // mink_refine_requests (migration 0247) is written by raw SQL only: the
    // page is chosen by created_at, deleted by (store_id, admin_id, stop_token).
    const policy = RETENTION_POLICIES.find(
      (entry) => entry.table === "mink_refine_requests",
    );
    expect(policy?.days).toBe(30);
    const execute = vi.fn<
      (query: SQL) => Promise<{ rows: unknown[]; rowCount: number }>
    >(async () => ({ rows: [], rowCount: 4 }));
    vi.mocked(withService).mockImplementationOnce(async (fn) =>
      fn({ execute } as never),
    );

    const floor = "2026-09-26T00:00:00.000Z";
    expect(await policy!.deleteBatch(floor, 1000, context())).toBe(4);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql.replace(/\s+/g, " ").trim()).toBe(
      "DELETE FROM public.mink_refine_requests WHERE (store_id, admin_id, stop_token) IN ( SELECT store_id, admin_id, stop_token FROM public.mink_refine_requests WHERE created_at < $1::timestamptz LIMIT $2 )",
    );
    expect(query.params).toEqual([floor, 1000]);
  });

  it("★ forgets a Help Centre answer rating after a year, by its primary key", async () => {
    // help_assistant_feedback (migration 0272) is written by raw SQL only.
    const policy = RETENTION_POLICIES.find(
      (entry) => entry.table === "help_assistant_feedback",
    );
    expect(policy?.days).toBe(365);
    const execute = vi.fn<
      (query: SQL) => Promise<{ rows: unknown[]; rowCount: number }>
    >(async () => ({ rows: [], rowCount: 3 }));
    vi.mocked(withService).mockImplementationOnce(async (fn) =>
      fn({ execute } as never),
    );

    const floor = "2025-10-30T00:00:00.000Z";
    expect(await policy!.deleteBatch(floor, 1000, context())).toBe(3);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql.replace(/\s+/g, " ").trim()).toBe(
      "DELETE FROM public.help_assistant_feedback WHERE id IN ( SELECT id FROM public.help_assistant_feedback WHERE created_at < $1::timestamptz LIMIT $2 )",
    );
    expect(query.params).toEqual([floor, 1000]);
  });

  describe("content takedown (design 8.2)", () => {
    const TAKEDOWN = [
      "content_block_archives",
      "moderation_events",
      "grievance_complaints",
      "content_blocks",
    ];
    const entry = (table: string) =>
      RETENTION_POLICIES.find((policy) => policy.table === table)!;

    it("adds four entries, in order, straight before the legacy move", () => {
      const tables = RETENTION_POLICIES.map((policy) => policy.table);
      const first = tables.indexOf("content_block_archives");
      expect(tables.slice(first, first + 5)).toEqual([
        ...TAKEDOWN,
        "mink_attachments_legacy",
      ]);
      for (const table of TAKEDOWN) {
        expect(tables.filter((name) => name === table)).toHaveLength(1);
      }
    });

    it("keeps each window and batch the design names", () => {
      expect(entry("content_block_archives").days).toBe(180);
      expect(entry("content_block_archives").batchSize).toBe(20);
      expect(entry("moderation_events").days).toBe(1095);
      expect(entry("moderation_events").batchSize).toBeUndefined();
      expect(entry("grievance_complaints").days).toBe(1095);
      expect(entry("grievance_complaints").batchSize).toBe(500);
      expect(entry("content_blocks").days).toBe(1095);
      expect(entry("content_blocks").batchSize).toBe(200);
    });

    it("carries each reason exactly as the design writes it", () => {
      expect(entry("content_block_archives").reason).toBe(
        "IT Rules 3(1)(g): what StoreMink removes, with its records, is kept 180 days, or longer when a court or an authority asks (a later date or a legal hold). The row stays, emptied, with its fingerprint.",
      );
      expect(entry("moderation_events").reason).toBe(
        "The record of every takedown action is kept 3 years (owner's decision D3), never while its store is held or its archive is kept.",
      );
      expect(entry("grievance_complaints").reason).toBe(
        "A complainant's name, contact, reference, addresses and words, and the outcome note, are erased 3 years after the complaint was resolved (owner's decision D3); the dates, kind, outcome and blocks stay.",
      );
      expect(entry("content_blocks").reason).toBe(
        "A lifted block's item name, address, legal basis, message and lift note, and the words and senders of its conversation, are erased 3 years after the lift, unless its store or archive is held (owner's decision D3); what was blocked, when, why and by whom stays.",
      );
    });

    it("hands the archive purge the sweep's own context, 20 at a time", async () => {
      const policy = entry("content_block_archives");
      expect(policy.deleteBatch).toBe(purgeTakedownArchives);
      const batch = context();
      expect(await policy.deleteBatch(retentionFloor(180), 20, batch)).toBe(3);
      expect(purgeDueArchives).toHaveBeenCalledWith(20, batch);
      expect(vi.mocked(purgeDueArchives).mock.calls[0][1]).toBe(batch);
    });

    it("prunes the record through its one SECURITY DEFINER function", async () => {
      const policy = entry("moderation_events");
      expect(policy.deleteBatch).toBe(pruneModerationEvents);
      const execute = vi.fn<
        (query: SQL) => Promise<{ rows: unknown[]; rowCount: number }>
      >(async () => ({ rows: [{ deleted: 5 }], rowCount: 1 }));
      vi.mocked(withService).mockImplementationOnce(async (fn) =>
        fn({ execute } as never),
      );
      const floor = retentionFloor(1095);
      expect(await policy.deleteBatch(floor, 1000, context())).toBe(5);
      const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
      expect(query.sql).toBe(
        "select public.moderation_prune_events($1::timestamptz, $2::integer) as deleted",
      );
      expect(query.params).toEqual([floor, 1000]);
    });

    it("erases resolved complaints through complaints.ts", async () => {
      const floor = retentionFloor(1095);
      expect(
        await entry("grievance_complaints").deleteBatch(floor, 500, context()),
      ).toBe(2);
      expect(eraseResolvedComplaints).toHaveBeenCalledWith(floor, 500);
    });

    it("erases lifted blocks with the floor and the limit, never the context", async () => {
      const execute = vi.fn<
        (query: SQL) => Promise<{ rows: unknown[]; rowCount: number }>
      >(async () => ({ rows: [], rowCount: 0 }));
      vi.mocked(withService).mockImplementationOnce(async (fn) =>
        fn({ execute } as never),
      );
      const floor = retentionFloor(1095);
      expect(
        await entry("content_blocks").deleteBatch(floor, 200, context()),
      ).toBe(0);
      const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
      expect(query.sql).toContain("for update of b skip locked");
      expect(query.params).toContain(floor);
      expect(query.params).toContain(200);
    });
  });

  it("documents why every window is what it is", () => {
    // The number and its reason live together so they cannot drift apart.
    for (const policy of RETENTION_POLICIES) {
      expect(policy.reason.length).toBeGreaterThan(20);
      expect(policy.days).toBeGreaterThan(0);
    }
  });
});
