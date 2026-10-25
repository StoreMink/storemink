// The storefront analytics rollup: each platform-wide rebuild runs in its own
// transaction with its own bounded statement limit, set before the rebuild.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  /** One entry per withService call: the SQL text of each statement, in order. */
  transactions: [] as string[][],
  rowCounts: [] as number[],
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => {
    const statements: string[] = [];
    h.transactions.push(statements);
    return fn({
      execute: async (query: SQL) => {
        statements.push(
          new PgDialect().sqlToQuery(query).sql.replace(/\s+/g, " ").trim(),
        );
        return { rows: [], rowCount: h.rowCounts.shift() ?? 0 };
      },
    });
  }),
}));

import {
  runStorefrontAnalyticsRollup,
  runStorefrontDimensionRollup,
} from "./storefront-rollup";

const LIMIT = "set local statement_timeout = '5min'";

beforeEach(() => {
  h.transactions = [];
  h.rowCounts = [];
});

describe("runStorefrontAnalyticsRollup", () => {
  it("★★ sets a 5-minute statement limit first in each rebuild's own transaction", async () => {
    // The limit's own statement, the buckets (4), the limit again, the
    // dimensions' delete, then the dimensions (9).
    h.rowCounts = [0, 4, 0, 0, 9];
    expect(await runStorefrontAnalyticsRollup()).toBe(13);

    expect(h.transactions).toHaveLength(2);
    const [buckets, dimensions] = h.transactions;
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toBe(LIMIT);
    expect(buckets[1]).toMatch(/^WITH ordered AS/);
    expect(buckets[1]).toContain("INSERT INTO storefront_daily (");
    expect(dimensions).toHaveLength(3);
    expect(dimensions[0]).toBe(LIMIT);
    expect(dimensions[1]).toMatch(/^DELETE FROM storefront_daily_dimensions/);
    expect(dimensions[2]).toContain("INSERT INTO storefront_daily_dimensions");
  });

  it("the dimension rebuild alone keeps its limit ahead of the DELETE and the INSERT", async () => {
    h.rowCounts = [0, 0, 5];
    expect(await runStorefrontDimensionRollup()).toBe(5);
    expect(h.transactions).toHaveLength(1);
    expect(h.transactions[0][0]).toBe(LIMIT);
    expect(
      h.transactions[0].filter((statement) => statement === LIMIT),
    ).toHaveLength(1);
  });
});
