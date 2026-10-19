import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({
  withService: (fn: (db: unknown) => unknown) => fn({ execute: h.execute }),
}));

import { rateLimit } from "./rate-limit";

const query = (call = 0) =>
  new PgDialect().sqlToQuery(h.execute.mock.calls[call][0]);

beforeEach(() => {
  h.execute.mockResolvedValue({ rows: [{ allowed: true }] });
});

describe("rateLimit", () => {
  it("counts one per call by default", async () => {
    expect(await rateLimit("k", { max: 5, windowSeconds: 60 })).toEqual({
      allowed: true,
    });
    expect(query().sql).toContain("check_rate_limit(");
    expect(query().sql).not.toContain("check_rate_limit_cost");
    expect(query().params).toEqual(["k", 5, 60]);
  });

  it("★ spends a cost against a budget counted in its own units", async () => {
    await rateLimit("chars", { max: 40_000, windowSeconds: 60, cost: 120 });
    expect(query().sql).toContain("check_rate_limit_cost(");
    expect(query().params).toEqual(["chars", 40_000, 60, 120]);
  });

  it("sends the database a whole cost of at least one", async () => {
    await rateLimit("a", { max: 10, windowSeconds: 60, cost: 2.2 });
    await rateLimit("b", { max: 10, windowSeconds: 60, cost: 0 });
    await rateLimit("c", { max: 10, windowSeconds: 60, cost: Number.NaN });
    expect(query(0).params[3]).toBe(3);
    expect(query(1).params[3]).toBe(1);
    expect(query(2).params[3]).toBe(1);
  });

  it("refuses only on an explicit no, and fails open on a database error", async () => {
    h.execute.mockResolvedValue({ rows: [{ allowed: false }] });
    expect((await rateLimit("k", { max: 1, windowSeconds: 1 })).allowed).toBe(
      false,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.execute.mockRejectedValue(new Error("db down"));
    expect(
      (await rateLimit("k", { max: 1, windowSeconds: 1, cost: 5 })).allowed,
    ).toBe(true);
  });
});
