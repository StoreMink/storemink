/* eslint-disable @typescript-eslint/no-explicit-any */

import { vi } from "vitest";
import { getTableName } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Mock Drizzle db (GCP migration Phase 5). Mirrors the fragment of the Drizzle
// query API our ported server actions use, recording the args so tests can
// assert on insert/update payloads without a real database. Pair it with a
// mock of `@/lib/db/client` whose with* runners invoke the callback with .db:
//
//   const dbHolder = vi.hoisted(() => ({ current: null as any }));
//   vi.mock("@/lib/db/client", () => ({
//     // Promise.resolve() assimilates the thenable query steps into REAL
//     // promises, so action code may call .catch() on a with* result.
//     withUser: vi.fn((_id: any, fn: any) =>
//       Promise.resolve(fn(dbHolder.current.db))),
//     withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
//     withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
//   }));
//   beforeEach(() => { dbHolder.current = makeDbMock({ returning: [{ id: "c1" }] }); });
// ---------------------------------------------------------------------------

export interface DbMock {
  db: any;
  calls: {
    insert: any[];
    values: any[];
    update: any[];
    set: any[];
    delete: any[];
    where: any[];
    select: any[];
    onConflict: any[];
    execute: any[];
    limit: any[];
    offset: any[];
    forUpdate: any[];
    innerJoin: any[];
    leftJoin: any[];
  };
}

export function makeDbMock(
  opts: {
    returning?: any[];
    // Optional per-write returning rows. Each .returning() consumes one entry;
    // useful when one action performs multiple conditional updates.
    returningQueue?: any[][];
    // An `Error` entry makes THAT select reject — for testing how an action
    // reports a failed read. Needed once reads run concurrently: which batch
    // failed decides which message the user sees.
    selectQueue?: (any[] | Error)[];
    /**
     * Select results keyed by TABLE instead of by call order.
     *
     * ★★ WHY THIS EXISTS. `selectQueue` is positional — the Nth select gets
     * the Nth entry — which makes a read you cannot count to untestable. The
     * gift-product read in `placeOrder` (docs/offers-plan.md Phase G) is one:
     * it happens after the offers resolve, behind a conditional, among reads
     * whose number varies with the cart, so no fixed position reaches it. All
     * eight were tried; none did. The consequence was a real bug shipping
     * unpinned — see the regression test in `checkout-actions.test.ts`.
     *
     * ★ A QUEUE PER TABLE, not one value per table, because the same table is
     * legitimately read twice with different expected rows: `placeOrder` reads
     * `products` for the cart AND again for the gift. So the Nth read of a
     * table gets that table's Nth entry.
     *
     * ★ INDEPENDENT OF `selectQueue`. A table-matched read consumes NO
     * positional entry, so the two can be mixed: name the reads you care
     * about, and let everything else fall through to the queue (or to `[]`).
     *
     * ★ Exhausted queue → `[]`, exactly as the positional queue does. Reusing
     * the last entry would be more convenient and would hide an unexpected
     * extra read, which is the thing a mock most needs to surface.
     */
    selectByTable?: Record<string, (any[] | Error)[]>;
    executeQueue?: any[][];
    // Tables whose insert().values(...) / update().set(...).where(...) should
    // REJECT when awaited — for rollback-path tests. Compare by table identity.
    failInsertFor?: any[];
    failUpdateFor?: any[];
    failDeleteFor?: any[];
  } = {},
): DbMock {
  const returning = opts.returning ?? [{ id: "row-1" }];
  const returningQueue = [...(opts.returningQueue ?? [])];
  const failInsertFor = opts.failInsertFor ?? [];
  const failUpdateFor = opts.failUpdateFor ?? [];
  const failDeleteFor = opts.failDeleteFor ?? [];
  // A step whose await / terminals reject — models a failing write.
  const failStep = (): any => ({
    where: vi.fn(() => failStep()),
    returning: vi.fn(() => Promise.reject(new Error("db write failed"))),
    then: (_res: any, rej: any) => rej(new Error("db write failed")),
  });
  // Each db.select() consumes the next entry (an action doing a slug lookup
  // then an image prefetch gets queue[0] then queue[1]); empty queue → [].
  const selectQueue = [...(opts.selectQueue ?? [])];
  // Per-table queues, drained independently of the positional one.
  const selectByTable = new Map<string, (any[] | Error)[]>(
    Object.entries(opts.selectByTable ?? {}).map(([t, rows]) => [t, [...rows]]),
  );
  // Each db.execute() (raw-SQL RPC calls) consumes the next `.rows` entry.
  const executeQueue = [...(opts.executeQueue ?? [])];
  const calls: DbMock["calls"] = {
    insert: [],
    values: [],
    update: [],
    set: [],
    delete: [],
    where: [],
    select: [],
    onConflict: [],
    execute: [],
    limit: [],
    offset: [],
    forUpdate: [],
    innerJoin: [],
    leftJoin: [],
  };

  // A thenable step that also exposes .where()/.returning() terminals, so both
  // `await db.update().set().where()` and `db.insert().values().returning()`
  // resolve correctly.
  const step = (result: any): any => ({
    where: vi.fn((c: any) => {
      calls.where.push(c);
      return step(result);
    }),
    onConflictDoUpdate: vi.fn((c: any) => {
      calls.onConflict.push(c);
      return step(result);
    }),
    onConflictDoNothing: vi.fn((c: any) => {
      calls.onConflict.push(c);
      return step(result);
    }),
    returning: vi.fn(async () =>
      returningQueue.length ? returningQueue.shift()! : returning,
    ),
    then: (resolve: any) => Promise.resolve(result).then(resolve),
  });

  const nextPositional = (): any[] | Error =>
    selectQueue.length ? selectQueue.shift()! : [];

  /**
   * A fully-chainable select step.
   *
   * ★ ROWS ARE CHOSEN AT `.from(table)`, NOT AT `db.select()`, so a table can
   * decide what a read returns. Safe for the positional queue too: Drizzle
   * always chains `.from()` onto `.select()` in the same expression, so the
   * two are synchronous neighbours and the order entries are consumed in is
   * unchanged — verified against every deferred-`from` caller in the tree.
   */
  const selectStep = (): any => {
    // Undecided until `.from(table)` names the table.
    let rows: any[] | Error | undefined;
    const s: any = {
      from: vi.fn((table: any) => {
        if (rows !== undefined) return s;
        let name: string | null = null;
        try {
          name = getTableName(table);
        } catch {
          // A subquery or alias has no plain name — fall through to the queue.
        }
        const queued = name ? selectByTable.get(name) : undefined;
        rows = queued
          ? queued.length
            ? queued.shift()!
            : []
          : nextPositional();
        return s;
      }),
      where: vi.fn((c: any) => {
        calls.where.push(c);
        return s;
      }),
      leftJoin: vi.fn((...args: any[]) => {
        calls.leftJoin.push(args);
        return s;
      }),
      innerJoin: vi.fn((...args: any[]) => {
        calls.innerJoin.push(args);
        return s;
      }),
      groupBy: vi.fn(() => s),
      orderBy: vi.fn(() => s),
      limit: vi.fn((n: any) => {
        calls.limit.push(n);
        return s;
      }),
      offset: vi.fn((n: any) => {
        calls.offset.push(n);
        return s;
      }),
      // SELECT ... FOR UPDATE — the row lock refund-actions takes so two
      // concurrent refunds on one order serialise instead of both passing the
      // cap. Recorded so a test can assert the lock is still there.
      for: vi.fn((mode: any) => {
        calls.forUpdate.push(mode);
        return s;
      }),
      then: (resolve: any, reject: any) => {
        // `.from()` is always called in practice; this only guards a bare
        // `await db.select(...)`, which keeps the old positional behaviour.
        if (rows === undefined) rows = nextPositional();
        return rows instanceof Error
          ? Promise.reject(rows).then(resolve, reject)
          : Promise.resolve(rows).then(resolve);
      },
    };
    return s;
  };

  const db: any = {
    select: vi.fn((projection?: any) => {
      calls.select.push(projection);
      return selectStep();
    }),
    execute: vi.fn(async (query: any) => {
      calls.execute.push(query);
      return { rows: executeQueue.length ? executeQueue.shift()! : [] };
    }),
    insert: vi.fn((t: any) => {
      calls.insert.push(t);
      const fail = failInsertFor.includes(t);
      return {
        values: vi.fn((v: any) => {
          calls.values.push(v);
          return fail ? failStep() : step(returning);
        }),
      };
    }),
    update: vi.fn((t: any) => {
      calls.update.push(t);
      const fail = failUpdateFor.includes(t);
      return {
        set: vi.fn((v: any) => {
          calls.set.push(v);
          return fail ? failStep() : step({ rowCount: 1 });
        }),
      };
    }),
    delete: vi.fn((t: any) => {
      calls.delete.push(t);
      return failDeleteFor.includes(t) ? failStep() : step({ rowCount: 1 });
    }),
  };

  return { db, calls };
}

/**
 * The bound parameter VALUES of a Drizzle SQL object, in order — lets tests
 * assert what a raw-SQL RPC call (db.execute) was invoked with. In a sql``
 * template, interpolated values sit INLINE in queryChunks as raw primitives
 * (incl. null); literal SQL text is a StringChunk whose `value` is an array.
 */
export function sqlParamValues(sqlObj: any): any[] {
  const out: any[] = [];
  const walk = (chunk: any) => {
    if (chunk === null || typeof chunk !== "object") {
      out.push(chunk); // a raw bound value
      return;
    }
    if (Array.isArray(chunk)) {
      chunk.forEach(walk);
      return;
    }
    if (chunk.queryChunks) {
      walk(chunk.queryChunks); // nested SQL
      return;
    }
    if (Array.isArray(chunk.value)) return; // StringChunk (literal SQL text)
    if ("value" in chunk) out.push(chunk.value); // Param wrapper
  };
  if (sqlObj?.queryChunks) walk(sqlObj.queryChunks);
  return out;
}

/**
 * The literal SQL text of a Drizzle sql`` object (the StringChunk pieces joined),
 * so a test can tell WHICH raw-SQL RPC a db.execute() call ran — e.g.
 * `sqlText(call).includes("increment_coupon_usage")`.
 */
export function sqlText(sqlObj: any): string {
  let out = "";
  const walk = (chunk: any) => {
    if (chunk === null || typeof chunk !== "object") return;
    if (Array.isArray(chunk)) {
      chunk.forEach(walk);
      return;
    }
    if (chunk.queryChunks) {
      walk(chunk.queryChunks);
      return;
    }
    if (Array.isArray(chunk.value)) out += chunk.value.join(""); // StringChunk
  };
  if (sqlObj?.queryChunks) walk(sqlObj.queryChunks);
  return out;
}
