import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  /** What each limit check answers, in order. */
  allowed: [] as boolean[],
  /** Every statement, rendered, with the transaction it ran in. */
  statements: [] as Array<{ tx: number; sql: string; params: unknown[] }>,
  committed: [] as number[],
  rolledBack: [] as number[],
  failWith: null as Error | null,
  logWarn: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  // A transaction that commits when its callback returns and rolls back when
  // it throws, the way `withService` wraps BEGIN/COMMIT.
  withService: vi.fn(
    async (fn: (db: { execute: (q: SQL) => unknown }) => unknown) => {
      if (h.failWith) throw h.failWith;
      const tx = h.committed.length + h.rolledBack.length + 1;
      const db = {
        execute: async (query: SQL) => {
          const rendered = new PgDialect().sqlToQuery(query);
          h.statements.push({
            tx,
            sql: rendered.sql.replace(/\s+/g, " ").trim(),
            params: rendered.params,
          });
          return { rows: [{ allowed: h.allowed.shift() ?? true }] };
        },
      };
      try {
        const result = await fn(db);
        h.committed.push(tx);
        return result;
      } catch (error) {
        h.rolledBack.push(tx);
        throw error;
      }
    },
  ),
}));
vi.mock("@/lib/observability/logger", () => ({ logWarn: h.logWarn }));

import {
  claimSpendLimits,
  MINK_IMAGE_GLOBAL_LIMIT,
  releaseSpendLimits,
} from "./spend-limits";

const owner = { key: "owner", max: 3, windowSeconds: 60 };
const store = { key: "store", max: 10, windowSeconds: 3_600, cost: 4 };

beforeEach(() => {
  h.allowed = [];
  h.statements = [];
  h.committed = [];
  h.rolledBack = [];
  h.failWith = null;
});

describe("★★ claimSpendLimits: every limit counts the call, or none does", () => {
  it("claims every limit in one transaction", async () => {
    await expect(
      claimSpendLimits([owner, store, MINK_IMAGE_GLOBAL_LIMIT]),
    ).resolves.toEqual({ ok: true });
    expect(h.statements.map((s) => s.tx)).toEqual([1, 1, 1]);
    expect(h.committed).toEqual([1]);
    expect(h.rolledBack).toEqual([]);
  });

  it("★ rolls back the counts already taken when a later limit refuses, and names it", async () => {
    // `check_rate_limit` adds before it compares, so a refusal by the second
    // limit has already spent the first one's count: only a rollback gives
    // it back.
    h.allowed = [true, false];
    await expect(
      claimSpendLimits([owner, store, MINK_IMAGE_GLOBAL_LIMIT]),
    ).resolves.toEqual({ ok: false, refusedKey: "store" });
    expect(h.statements).toHaveLength(2);
    expect(h.committed).toEqual([]);
    expect(h.rolledBack).toEqual([1]);
  });

  it("weighs a limit with a cost, and counts a plain one", async () => {
    await claimSpendLimits([owner, store]);
    expect(h.statements[0].sql).toContain("check_rate_limit(");
    expect(h.statements[0].params).toEqual(["owner", 3, 60]);
    expect(h.statements[1].sql).toContain("check_rate_limit_cost(");
    expect(h.statements[1].params).toEqual(["store", 10, 3_600, 4]);
  });

  it("★ fails closed: a database error is thrown, never read as allowed", async () => {
    h.failWith = new Error("connection refused");
    await expect(claimSpendLimits([owner])).rejects.toThrow(
      "connection refused",
    );
  });

  it("claims nothing for no limits", async () => {
    await expect(claimSpendLimits([])).resolves.toEqual({ ok: true });
    expect(h.statements).toHaveLength(0);
  });
});

describe("releaseSpendLimits", () => {
  it("gives back each limit's cost, never below zero", async () => {
    await releaseSpendLimits([{ key: "owner" }, { key: "store", cost: 4 }]);
    expect(h.statements.map((s) => s.params)).toEqual([
      [1, "owner"],
      [4, "store"],
    ]);
    expect(h.statements[0].sql).toContain("greatest(count -");
    expect(h.committed).toEqual([1]);
  });

  it("★ never throws: a refund that does not land is logged", async () => {
    h.failWith = new Error("connection refused");
    await expect(
      releaseSpendLimits([{ key: "owner" }]),
    ).resolves.toBeUndefined();
    expect(h.logWarn).toHaveBeenCalledWith(
      "mink.spend: release failed",
      expect.objectContaining({ keys: "owner" }),
    );
  });
});
