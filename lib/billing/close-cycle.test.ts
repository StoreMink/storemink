/* eslint-disable @typescript-eslint/no-explicit-any */
// Closing the invoices of cycles a plan will never enter (design 6.1, R3).
//
// The db mock does not evaluate a WHERE clause, so which rows are closed is
// pinned by rendering the statement with the real Postgres dialect: a predicate
// dropped or widened (>= instead of >, every kind instead of subscriptions)
// changes the rendered text and fails here. The statement itself was run
// against storemink_local in a rolled-back transaction (RC4 report).

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeDbMock } from "@/app/actions/_test-helpers";
import { closeUnreachedInvoices } from "./close-cycle";

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");

function render(query: unknown) {
  const q = new PgDialect().sqlToQuery(query as any);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

function run(
  rows: any[] = [],
  input: Partial<Parameters<typeof closeUnreachedInvoices>[1]> = {},
) {
  const mock = makeDbMock({ executeQueue: [rows] });
  const result = closeUnreachedInvoices(mock.db, {
    storeId: STORE,
    lastReachedSeq: 4,
    now: NOW,
    ...input,
  });
  return { mock, result };
}

describe("closeUnreachedInvoices", () => {
  it("★★ closes draft, open, processing and paid invoices above the last reached cycle", async () => {
    const { mock, result } = run();
    await result;
    expect(mock.calls.execute).toHaveLength(1);
    const { sql } = render(mock.calls.execute[0]);
    expect(sql).toContain(
      "and i.status in ('draft', 'open', 'processing', 'paid')",
    );
    expect(sql).toContain("and i.cycle_seq > $2");
    expect(sql).toContain("set status = 'void', updated_at = $3");
  });

  it("★★ changes ONLY status and updated_at, so the immutability guard allows it", async () => {
    // Money, number, kind, cycle, issue date and parties are frozen by
    // billing_invoices_guard_immutable; touching any of them would raise inside
    // the plan end's transaction and roll the plan end back with it.
    const { mock, result } = run();
    await result;
    const { sql } = render(mock.calls.execute[0]);
    const set = sql.slice(sql.indexOf(" set "), sql.indexOf(" from closing"));
    expect(set).toBe(" set status = 'void', updated_at = $3");
  });

  it("★★ leaves the current and earlier cycles, other kinds and other stores", async () => {
    // Strictly ABOVE the last reached cycle: the cycle the merchant is in, and
    // every one before it, are what they paid for and keep.
    const { mock, result } = run();
    await result;
    const { sql, params } = render(mock.calls.execute[0]);
    expect(sql).toContain("where i.store_id = $1");
    expect(sql).toContain("and i.kind = 'subscription'");
    expect(sql).toContain("and i.cycle_seq > $2");
    expect(sql).not.toContain("cycle_seq >= ");
    expect(params).toEqual([STORE, 4, NOW.toISOString()]);
  });

  it("★ locks the invoice rows it closes", async () => {
    const { mock, result } = run();
    await result;
    const { sql } = render(mock.calls.execute[0]);
    expect(sql).toMatch(/with closing as \( select i\.id, .* for update \)/);
  });

  it("★★ without issuedOnly a draft is closed too (a renewal draft finalize left behind)", async () => {
    const { mock, result } = run();
    await result;
    expect(render(mock.calls.execute[0]).sql).not.toContain("finalized_at");
  });

  it("★★ issuedOnly skips drafts: only issued invoices are closed (deleteStore)", async () => {
    const { mock, result } = run([], { issuedOnly: true });
    await result;
    const { sql, params } = render(mock.calls.execute[0]);
    expect(sql).toContain("and i.finalized_at is not null");
    // The flag adds a predicate, never a parameter: the order stays $1..$3.
    expect(params).toEqual([STORE, 4, NOW.toISOString()]);
    expect(sql).toContain("set status = 'void', updated_at = $3");
  });

  it("★★ returns what it closed, as each invoice stood before", async () => {
    // A bigint comes back from a raw query as text; it is a number here.
    const { result } = run([
      {
        id: "inv-5",
        previous_status: "paid",
        total_paise: "240000",
        invoice_ref: "SM/2026-27/00005",
      },
      {
        id: "inv-6",
        previous_status: "draft",
        total_paise: 240000,
        invoice_ref: null,
      },
    ]);
    expect(await result).toEqual([
      {
        id: "inv-5",
        previousStatus: "paid",
        totalPaise: 240000,
        invoiceRef: "SM/2026-27/00005",
      },
      {
        id: "inv-6",
        previousStatus: "draft",
        totalPaise: 240000,
        invoiceRef: null,
      },
    ]);
  });

  it("★ reports the PREVIOUS status from the locking read, not the new one", async () => {
    const { mock, result } = run();
    await result;
    expect(render(mock.calls.execute[0]).sql).toContain(
      "returning c.id, c.status as previous_status, c.total_paise, c.invoice_ref",
    );
  });

  it("returns an empty list when nothing was above the cycle", async () => {
    const { result } = run([]);
    expect(await result).toEqual([]);
  });

  it("★ a database error rejects, so the caller's plan end rolls back with it", async () => {
    const mock = makeDbMock();
    mock.db.execute = async () => {
      throw new Error("db down");
    };
    await expect(
      closeUnreachedInvoices(mock.db, {
        storeId: STORE,
        lastReachedSeq: 4,
        now: NOW,
      }),
    ).rejects.toThrow("db down");
  });
});
