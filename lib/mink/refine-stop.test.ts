import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withService, type Db } from "@/lib/db/client";
import { logError, logWarn } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// ★★ The Refine stop handshake (26 Oct 2026): a stop the browser sends wins
// only before the charge is claimed, and the charge is claimed only while no
// stop is recorded. Both are conditional writes of the refine's own row in
// mink_refine_requests (migration 0247); these pin, without a database, the
// predicates that make exactly one of them win, and 0247's own SQL and
// manifest entry. The race itself, under real row locks, is proven against
// Postgres in refine-stop.local.test.ts (opt-in).
// ---------------------------------------------------------------------------

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  abandonRefineStage,
  beginRefineRequest,
  claimRefineCharge,
  isRefineStopRequested,
  refineChargeCommitted,
  registerLiveRefine,
  requestRefineStop,
  stopLiveRefine,
  watchRefineStop,
  type RefineStopKey,
} from "./refine-stop";

const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REFINEMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADMIN = "admin-1";
const KEY: RefineStopKey = { storeId: STORE, adminId: ADMIN, stopToken: TOKEN };

/** Each execute answers the next entry: rows, or an Error that it throws. */
let answers: Array<Record<string, unknown>[] | Error>;
let executed: SQL[];
const db = {
  execute: vi.fn(async (query: SQL) => {
    executed.push(query);
    const next = answers.shift() ?? [];
    if (next instanceof Error) throw next;
    return { rows: next };
  }),
};

function database(rows: Array<Record<string, unknown>[] | Error> = []) {
  answers = [...rows];
  executed = [];
  db.execute.mockImplementation(async (query: SQL) => {
    executed.push(query);
    const next = answers.shift() ?? [];
    if (next instanceof Error) throw next;
    return { rows: next };
  });
  vi.mocked(withService).mockImplementation(async (fn) =>
    fn(db as unknown as Db),
  );
}

/** The SQL text (whitespace folded) and parameters a statement compiles to. */
function compiled(query: SQL) {
  const { sql, params } = new PgDialect().sqlToQuery(query);
  return { sql: sql.replace(/\s+/g, " ").trim(), params };
}

beforeEach(() => database());

describe("★★ beginRefineRequest: every refine has its row", () => {
  it("★★ fresh: inserts the row with the server's refinement id", async () => {
    database([[{ begun: 1 }]]);
    await expect(beginRefineRequest(KEY, REFINEMENT)).resolves.toBe("fresh");
    expect(executed).toHaveLength(1);
    const insert = compiled(executed[0]);
    expect(insert.sql).toContain(
      "insert into public.mink_refine_requests (store_id, admin_id, stop_token, refinement_id)",
    );
    expect(insert.sql).toContain(
      "on conflict (store_id, admin_id, stop_token) do nothing",
    );
    expect(insert.params).toEqual([STORE, ADMIN, TOKEN, REFINEMENT]);
  });

  it("★★ stopped: a stop for this token arrived first", async () => {
    database([[], [{ stopped: true }]]);
    await expect(beginRefineRequest(KEY, REFINEMENT)).resolves.toBe("stopped");
    const read = compiled(executed[1]);
    expect(read.sql).toContain("select (stop_requested_at is not null)");
    expect(read.params).toEqual([STORE, ADMIN, TOKEN]);
  });

  it("★ duplicate: the token is already refining (or its row vanished)", async () => {
    database([[], [{ stopped: false }]]);
    await expect(beginRefineRequest(KEY, REFINEMENT)).resolves.toBe(
      "duplicate",
    );
    database([[], []]);
    await expect(beginRefineRequest(KEY, REFINEMENT)).resolves.toBe(
      "duplicate",
    );
  });

  it("★ unavailable on a missing table, warned once per process", async () => {
    const missing = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    database([missing, missing]);
    await expect(beginRefineRequest(KEY, REFINEMENT)).resolves.toBe(
      "unavailable",
    );
    await expect(beginRefineRequest(KEY, REFINEMENT)).resolves.toBe(
      "unavailable",
    );
    expect(logWarn).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledWith(
      "mink.image-refine: stop table missing",
      {},
    );
  });

  it("★★ any other error is rethrown (the refine refuses before anything is reserved)", async () => {
    const busy = Object.assign(new Error("too many clients"), {
      code: "53300",
    });
    database([busy]);
    await expect(beginRefineRequest(KEY, REFINEMENT)).rejects.toBe(busy);
  });
});

describe("★★ requestRefineStop: the stop wins only before the charge is claimed", () => {
  it("★★ records the stop only while the charge is unclaimed, keeping the first time", async () => {
    database([[{ refinement_id: REFINEMENT }]]);
    await expect(requestRefineStop(KEY)).resolves.toEqual({
      outcome: "stopped",
    });
    const stop = compiled(executed[0]);
    expect(stop.sql).toContain(
      "on conflict (store_id, admin_id, stop_token) do update set stop_requested_at = coalesce(r.stop_requested_at, excluded.stop_requested_at) where r.charge_claimed_at is null",
    );
    expect(stop.sql).toContain("returning r.refinement_id");
    expect(stop.params).toEqual([STORE, ADMIN, TOKEN]);
    // Decided by its one write: nothing else ran.
    expect(executed).toHaveLength(1);
  });

  it("★ recorded: no refine has begun with this token (a stop may overtake its refine)", async () => {
    database([[{ refinement_id: null }]]);
    await expect(requestRefineStop(KEY)).resolves.toEqual({
      outcome: "recorded",
    });
  });

  it("★★ too_late with the photo's URL, read through this store's, admin's and token's row", async () => {
    const url = `https://storage.googleapis.com/bucket/stores/${STORE}/refined/${REFINEMENT}.webp`;
    database([[], [{ result_url: url }]]);
    await expect(requestRefineStop(KEY)).resolves.toEqual({
      outcome: "too_late",
      url,
    });
    const read = compiled(executed[1]);
    expect(read.sql).toContain("left join public.mink_image_refinements m");
    expect(read.sql).toContain(
      "on m.id = q.refinement_id and m.store_id = q.store_id",
    );
    expect(read.sql).toContain(
      "where q.store_id = $1::uuid and q.admin_id = $2 and q.stop_token = $3::uuid",
    );
    expect(read.params).toEqual([STORE, ADMIN, TOKEN]);
  });

  it("too_late without a URL when the ledger has none", async () => {
    database([[], [{ result_url: null }]]);
    await expect(requestRefineStop(KEY)).resolves.toEqual({
      outcome: "too_late",
      url: null,
    });
    database([[], []]);
    await expect(requestRefineStop(KEY)).resolves.toEqual({
      outcome: "too_late",
      url: null,
    });
  });
});

describe("★★ claimRefineCharge: the charge transaction's first statement", () => {
  it("★★ runs on the db it is given, and only while nobody asked to stop", async () => {
    const own = {
      execute: vi.fn<(query: SQL) => Promise<{ rows: unknown[] }>>(
        async () => ({ rows: [{ claimed: 1 }] }),
      ),
    };
    await expect(
      claimRefineCharge(own as unknown as Db, KEY, REFINEMENT),
    ).resolves.toBe(true);
    expect(withService).not.toHaveBeenCalled();
    const claim = compiled(own.execute.mock.calls[0][0]);
    expect(claim.sql).toContain(
      "update public.mink_refine_requests set charge_claimed_at = now()",
    );
    expect(claim.sql).toContain("and refinement_id = $4::uuid");
    expect(claim.sql).toContain(
      "and stop_requested_at is null and charge_claimed_at is null",
    );
    expect(claim.params).toEqual([STORE, ADMIN, TOKEN, REFINEMENT]);
  });

  it("★★ false when a stop won", async () => {
    const own = { execute: vi.fn(async () => ({ rows: [] })) };
    await expect(
      claimRefineCharge(own as unknown as Db, KEY, REFINEMENT),
    ).resolves.toBe(false);
  });
});

describe("refineChargeCommitted: the ledger read (unguarded refines only)", () => {
  it("asks for this store's charged ledger row with a path", async () => {
    database([[{ result_path: "x" }], []]);
    await expect(refineChargeCommitted(STORE, REFINEMENT)).resolves.toBe(true);
    await expect(refineChargeCommitted(STORE, REFINEMENT)).resolves.toBe(false);
    const read = compiled(executed[0]);
    expect(read.sql).toContain(
      "from public.mink_image_refinements where id = $1::uuid and store_id = $2::uuid and result_path is not null",
    );
    expect(read.params).toEqual([REFINEMENT, STORE]);
  });

  it("throws on a database error", async () => {
    database([new Error("connection dropped")]);
    await expect(refineChargeCommitted(STORE, REFINEMENT)).rejects.toThrow(
      "connection dropped",
    );
  });
});

describe("★★ abandonRefineStage: the sweep's and a failed charge's arbiter", () => {
  const path = `stores/${STORE}/refined/${REFINEMENT}.webp`;

  it("★★ discard when the abandon itself won, and reads no ledger", async () => {
    database([[{ abandoned: 1 }]]);
    await expect(abandonRefineStage(STORE, REFINEMENT)).resolves.toBe(
      "discard",
    );
    expect(executed).toHaveLength(1);
    const abandon = compiled(executed[0]);
    expect(abandon.sql).toContain(
      "set stop_requested_at = coalesce(stop_requested_at, now())",
    );
    expect(abandon.sql).toContain(
      "where store_id = $1::uuid and refinement_id = $2::uuid and charge_claimed_at is null",
    );
    expect(abandon.params).toEqual([STORE, REFINEMENT]);
  });

  it("★★ publish with the ledger's path when the charge was claimed: the abandon runs FIRST", async () => {
    database([[], [{ result_path: path }]]);
    await expect(abandonRefineStage(STORE, REFINEMENT)).resolves.toEqual({
      publish: path,
    });
    expect(compiled(executed[0]).sql).toMatch(
      /^update public\.mink_refine_requests/,
    );
    expect(compiled(executed[1]).sql).toMatch(
      /^select result_path from public\.mink_image_refinements/,
    );
    // ★ One scope: the read sees whatever the waited-for transaction did.
    expect(withService).toHaveBeenCalledOnce();
  });

  it("★ discard when neither a request row nor a charged ledger row exists", async () => {
    database([[], []]);
    await expect(abandonRefineStage(STORE, REFINEMENT)).resolves.toBe(
      "discard",
    );
  });

  it("throws on a database error (the caller keeps the stage)", async () => {
    database([new Error("statement timeout")]);
    await expect(abandonRefineStage(STORE, REFINEMENT)).rejects.toThrow(
      "statement timeout",
    );
  });
});

describe("isRefineStopRequested", () => {
  it("reads this key's row; no row is no stop", async () => {
    database([[{ stopped: true }], [{ stopped: false }], []]);
    await expect(isRefineStopRequested(KEY)).resolves.toBe(true);
    await expect(isRefineStopRequested(KEY)).resolves.toBe(false);
    await expect(isRefineStopRequested(KEY)).resolves.toBe(false);
    expect(compiled(executed[0]).params).toEqual([STORE, ADMIN, TOKEN]);
  });
});

describe("★ watchRefineStop: labelled by store and admin, never the token", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("★ logs a failed read and a throwing onStop without the token", async () => {
    database([new Error("pool busy"), [{ stopped: true }]]);
    const watch = watchRefineStop(KEY, () => {
      throw new Error("listener failed");
    });
    await vi.advanceTimersByTimeAsync(1_200);
    expect(logWarn).toHaveBeenCalledWith(
      "mink.image-refine: watch read skipped",
      { storeId: STORE, adminId: ADMIN, reason: "Error" },
    );
    await vi.advanceTimersByTimeAsync(1_200);
    expect(logError).toHaveBeenCalledWith(
      "mink.image-refine: watch stop failed",
      expect.any(Error),
      { storeId: STORE, adminId: ADMIN },
    );
    watch.close();
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(vi.mocked(logError).mock.calls)).not.toContain(TOKEN);
  });

  it("★ checkNow() reads this key's row", async () => {
    database([[{ stopped: true }]]);
    const onStop = vi.fn();
    const watch = watchRefineStop(KEY, onStop);
    await expect(watch.checkNow()).resolves.toBe(true);
    expect(onStop).toHaveBeenCalledOnce();
    expect(compiled(executed[0]).params).toEqual([STORE, ADMIN, TOKEN]);
  });
});

describe("★ the same-instance fast path", () => {
  it("★ stops only this store's, admin's and token's refine, whatever the token's case", () => {
    const onStop = vi.fn();
    const unregister = registerLiveRefine(
      { ...KEY, stopToken: TOKEN.toUpperCase() },
      onStop,
    );
    stopLiveRefine({ ...KEY, adminId: "someone-else" });
    stopLiveRefine({ ...KEY, storeId: REFINEMENT });
    expect(onStop).not.toHaveBeenCalled();
    stopLiveRefine(KEY);
    expect(onStop).toHaveBeenCalledOnce();
    unregister();
    stopLiveRefine(KEY);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("logs a stop callback that throws with store and admin, never the token", () => {
    const unregister = registerLiveRefine(KEY, () => {
      throw new Error("listener failed");
    });
    expect(() => stopLiveRefine(KEY)).not.toThrow();
    expect(logError).toHaveBeenCalledWith(
      "mink.image-refine: live stop failed",
      expect.any(Error),
      { storeId: STORE, adminId: ADMIN },
    );
    unregister();
  });
});

// ★★ THE TABLE THAT DECIDES WHETHER A MERCHANT WHO LEFT IS CHARGED, pinned on
// the migration's own SQL and manifest entry. refine-stop.local.test.ts proves
// it against a real Postgres, but it is opt-in and CI skips it, while 0247 is
// still pending on staging and production: an edit that dropped a predicate
// or a grant would otherwise pass every check.
describe("migration 0247: mink_refine_requests", () => {
  const sql = readFileSync(
    "drizzle/migrations/sql/20261026_0247_mink_refine_stop.sql",
    "utf8",
  )
    // The statements only: the header explains them in words.
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("keys one row per refine on store, admin and token, with a unique refine id", () => {
    expect(sql).toContain(
      "CONSTRAINT mink_refine_requests_pkey PRIMARY KEY (store_id, admin_id, stop_token)",
    );
    expect(sql).toContain(
      "CONSTRAINT mink_refine_requests_refinement_key UNIQUE (refinement_id)",
    );
    expect(sql).toContain(
      "store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE",
    );
  });

  it("★★ keeps all three CHECKs, verbatim", () => {
    expect(sql).toContain(
      "CONSTRAINT mink_refine_requests_stop_or_charge_check CHECK (stop_requested_at IS NULL OR charge_claimed_at IS NULL)",
    );
    expect(sql).toContain(
      "CONSTRAINT mink_refine_requests_charge_has_refinement_check CHECK (charge_claimed_at IS NULL OR refinement_id IS NOT NULL)",
    );
    expect(sql).toContain(
      "CONSTRAINT mink_refine_requests_started_or_stopped_check CHECK (refinement_id IS NOT NULL OR stop_requested_at IS NOT NULL)",
    );
  });

  it("★★ is service-only: RLS on, both REVOKEs, and the exact GRANT with DELETE", () => {
    expect(sql).toContain(
      "ALTER TABLE public.mink_refine_requests ENABLE ROW LEVEL SECURITY;",
    );
    expect(sql).toContain(
      "REVOKE ALL ON public.mink_refine_requests FROM PUBLIC;",
    );
    expect(sql).toContain(
      "REVOKE ALL ON public.mink_refine_requests FROM app_user;",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.mink_refine_requests TO app_service;",
    );
    expect(sql).not.toMatch(/GRANT [^;]* TO (app_user|PUBLIC)/i);
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });

  it("★★ its manifest entry checks each grant on its own, and the cascade", () => {
    const manifest = JSON.parse(
      readFileSync("drizzle/migrations/manifest.json", "utf8"),
    ) as {
      migrations: Array<{
        id: string;
        verify?: Record<string, unknown>;
        applyVerify?: { queries: Array<{ sql: string; equals: string }> };
      }>;
    };
    const entry = manifest.migrations.find(
      (migration) => migration.id === "20261026_0247_mink_refine_stop",
    );
    expect(entry).toBeDefined();
    const queries = entry!.applyVerify!.queries;
    expect(queries).toHaveLength(7);
    // ★ One has_table_privilege per privilege, ANDed: a comma list is true
    //   when ANY privilege is held (the flaw 0150 retired).
    const grants = queries.find((query) =>
      query.sql.includes("has_table_privilege('app_service'"),
    )!;
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(grants.sql).toContain(
        `has_table_privilege('app_service', 'public.mink_refine_requests', '${privilege}')`,
      );
    }
    expect(grants.sql).not.toMatch(
      /has_table_privilege\('app_service', [^)]*,[^)]*,[^)]*,/,
    );
    expect(grants.equals).toBe("true");
    const cascade = queries.find((query) => query.sql.includes("confdeltype"))!;
    expect(cascade.sql).toContain("mink_refine_requests_store_id_fkey");
    expect(cascade.equals).toBe("c");
    // ★ Durable verify names structure only (AGENTS.md: never wording).
    expect(entry!.verify).not.toHaveProperty("queries");
    expect(entry!.verify).toMatchObject({
      tables: ["mink_refine_requests"],
      rlsTables: ["mink_refine_requests"],
    });
  });
});
