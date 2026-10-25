import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What the tabs read themselves (wave TS-2, builder 2C): the newest final
// design review of a design, by JSON path only, and the nearest design in
// the Design list a design was made from. A scripted database records the
// SQL; both queries were also run against the local database.

const dialect = new PgDialect();
const db = vi.hoisted(() => ({
  queries: [] as { sql: string; params: unknown[] }[],
  rows: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) =>
    fn({
      execute: async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement);
        db.queries.push({ sql: query.sql, params: query.params });
        return { rows: db.rows };
      },
    }),
  ),
}));
vi.mock("@/lib/theme-studio/repository", async () => ({
  isUuid: (value: unknown) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    ),
  getThemeStudioProject: vi.fn(async () => null),
}));
import { readStudioDesignReview, readStudioShownAncestor } from "./tab-reads";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  db.queries = [];
  db.rows = [];
});

describe("readStudioDesignReview", () => {
  it("reads the newest final review by JSON path, never the model's whole answer or a picture", async () => {
    db.rows = [
      {
        id: "rev",
        status: "failed",
        errorCode: null,
        createdAt: new Date("2026-10-25T06:26:00Z"),
        finishedAt: "2026-10-25T06:28:00Z",
        checkRunId: "run",
        build: "build-1",
        reviewSeverity: {
          outcome: "serious",
          serious: [{ code: "inaccessible_copy" }, { code: "BAD CODE" }],
          warnings: [{ code: "low_total", score: 31 }],
        },
      },
    ];
    const review = await readStudioDesignReview(PROJECT, VERSION);
    expect(review).toEqual({
      id: "rev",
      status: "failed",
      errorCode: null,
      createdAt: "2026-10-25T06:26:00.000Z",
      finishedAt: "2026-10-25T06:28:00.000Z",
      checkRunId: "run",
      build: "build-1",
      severity: {
        outcome: "serious",
        serious: [{ code: "inaccessible_copy" }],
        warnings: [{ code: "low_total", score: 31 }],
      },
    });
    expect(db.queries).toHaveLength(1);
    const { sql, params } = db.queries[0];
    expect(sql).toContain("q.vision_report -> 'reviewSeverity'");
    expect(sql).toContain(
      "coalesce(q.browser_report ->> 'phase', 'final') = 'final'",
    );
    expect(sql).toMatch(/ORDER BY q\.created_at DESC, q\.id DESC\s+LIMIT 1/);
    expect(sql).not.toMatch(/\*|screenshot_asset_ids|bytes/);
    // Only JSON paths of the two reports, never a whole one.
    expect(
      sql.replace(/q\.(vision|browser)_report\s*-{1,2}>>?\s*'\w+'/g, ""),
    ).not.toMatch(/vision_report|browser_report/);
    expect(params).toEqual([PROJECT, VERSION]);
  });

  it("answers null for no review, and reads nothing for a malformed id", async () => {
    expect(await readStudioDesignReview(PROJECT, VERSION)).toBeNull();
    expect(await readStudioDesignReview("garbage", VERSION)).toBeNull();
    expect(await readStudioDesignReview(PROJECT, "garbage")).toBeNull();
    expect(db.queries).toHaveLength(1);
  });

  it("never invents a verdict from a review that recorded none, and words an unknown state as failed", async () => {
    db.rows = [
      {
        id: "rev",
        status: "exploded",
        errorCode: "qa_provider_unavailable",
        createdAt: "bad date",
        finishedAt: null,
        checkRunId: null,
        build: "",
        reviewSeverity: null,
      },
    ];
    expect(await readStudioDesignReview(PROJECT, VERSION)).toEqual({
      id: "rev",
      status: "failed",
      errorCode: "qa_provider_unavailable",
      createdAt: null,
      finishedAt: null,
      checkRunId: null,
      build: null,
      severity: null,
    });
  });
});

describe("readStudioShownAncestor", () => {
  it("walks back past hidden drafts to the nearest design in the Design list", async () => {
    db.rows = [{ id: "v1", versionNumber: 1, depth: 3 }];
    expect(await readStudioShownAncestor(PROJECT, VERSION)).toEqual({
      id: "v1",
      versionNumber: 1,
      between: 2,
    });
    const { sql, params } = db.queries[0];
    expect(sql).toMatch(/WITH RECURSIVE chain/);
    expect(sql).toContain("depth > 0 AND visibility = 'operator' AND packaged");
    expect(sql).toMatch(/ORDER BY depth\s+LIMIT 1/);
    expect(sql).not.toMatch(/package_json|intent_json|\*/);
    // Within one project, and at most 50 steps back.
    expect(params).toEqual([VERSION, PROJECT, 50, PROJECT]);
  });

  it("is null where the theme started, and reads nothing for a malformed id", async () => {
    expect(await readStudioShownAncestor(PROJECT, VERSION)).toBeNull();
    expect(await readStudioShownAncestor(PROJECT, "x")).toBeNull();
    expect(db.queries).toHaveLength(1);
  });

  it("counts no drafts in between for a direct parent", async () => {
    db.rows = [{ id: "v1", versionNumber: 1, depth: 1 }];
    expect((await readStudioShownAncestor(PROJECT, VERSION))?.between).toBe(0);
  });
});
