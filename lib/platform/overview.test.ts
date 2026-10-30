import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";

// ---------------------------------------------------------------------------
// The Overview's four takedown queues (design 6.1): they ride in the one
// summary statement as console-read.ts's own subqueries, so each counts
// exactly what its Complaints tab lists, and a resolved complaint never
// counts as due.
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  statements: [] as SQL[],
  rows: [] as Record<string, unknown>[][],
  fail: false,
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
    if (db.fail) throw new Error("database unreachable");
    return run({
      execute: vi.fn(async (statement: SQL) => {
        db.statements.push(statement);
        return { rows: db.rows.shift() ?? [] };
      }),
    });
  }),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(() => undefined),
  logWarn: vi.fn(() => undefined),
  logInfo: vi.fn(() => undefined),
}));

import { sqlText } from "@/app/actions/_test-helpers";
import { moderationQueueSql } from "@/lib/moderation/console-read";
import { getPlatformInsights } from "./overview";

beforeEach(() => {
  db.statements = [];
  db.rows = [];
  db.fail = false;
});

/** The literal text between two markers of the summary statement. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start + from.length, end).trim();
}

describe("the Overview's takedown queues", () => {
  it("carries console-read's four subqueries in the one summary statement", async () => {
    db.rows = [[{ stores: 0 }], [], []];
    await getPlatformInsights();
    const summary = sqlText(db.statements[0]);
    const queues = moderationQueueSql();
    expect(between(summary, "open_reconciliation,", "as complaints_due")).toBe(
      sqlText(queues.complaintsDue).trim(),
    );
    expect(between(summary, "as complaints_due,", "as store_replies")).toBe(
      sqlText(queues.storeReplies).trim(),
    );
    expect(between(summary, "as store_replies,", "as files_to_finish")).toBe(
      sqlText(queues.filesToFinish).trim(),
    );
    expect(between(summary, "as files_to_finish,", "as holds_to_review")).toBe(
      sqlText(queues.holdsToReview).trim(),
    );
  });

  it("counts a complaint as due only while it is not resolved", async () => {
    db.rows = [[{ stores: 0 }], [], []];
    await getPlatformInsights();
    const due = between(
      sqlText(db.statements[0]),
      "open_reconciliation,",
      "as complaints_due",
    );
    expect(due).toContain("from public.grievance_complaints c");
    expect(due).toContain("case when c.resolved_at is null then least(");
  });

  it("maps the four counts onto the attention block", async () => {
    db.rows = [
      [
        {
          stores: 3,
          complaints_due: 2,
          store_replies: "1",
          files_to_finish: 4,
          holds_to_review: 1,
        },
      ],
      [],
      [],
    ];
    const insights = await getPlatformInsights();
    expect(insights.ok).toBe(true);
    expect(insights.attention).toMatchObject({
      complaintsDue: 2,
      storeReplies: 1,
      filesToFinish: 4,
      holdsToReview: 1,
    });
  });

  it("answers ok: false with every queue at zero when the read fails", async () => {
    db.fail = true;
    const insights = await getPlatformInsights();
    expect(insights.ok).toBe(false);
    expect(insights.attention).toMatchObject({
      complaintsDue: 0,
      storeReplies: 0,
      filesToFinish: 0,
      holdsToReview: 0,
    });
  });
});
