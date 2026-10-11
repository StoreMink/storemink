/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  where: null as unknown,
  columns: null as unknown,
  fail: null as Error | null,
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (run: (db: unknown) => unknown) => {
    if (state.fail) throw state.fail;
    return run({
      select: (columns: unknown) => {
        state.columns = columns;
        return {
          from: () => ({
            where: async (cond: unknown) => {
              state.where = cond;
              return state.rows;
            },
          }),
        };
      },
    });
  }),
}));
vi.mock("@/lib/store/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store/host")>()),
  ROOT_DOMAIN: "storemink.com",
}));
vi.mock("./authorized-domains", () => ({
  ensureAuthorizedHosts: vi.fn(async (hosts: string[]) => ({ added: hosts })),
  removeAuthorizedHosts: vi.fn(async () => ({ removed: [] })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  ensureAuthorizedHosts,
  removeAuthorizedHosts,
} from "./authorized-domains";
import { syncStoreAuthHosts } from "./store-auth-hosts-sync";

beforeEach(() => {
  state.rows = [];
  state.where = null;
  state.columns = null;
  state.fail = null;
});

const ROWS = [
  { id: "s1", slug: "echoss", customDomain: null, settings: {} },
  {
    id: "s2",
    slug: "wholesip",
    customDomain: "wholesip.com",
    settings: { custom_domain_verified: true },
  },
  {
    id: "s3",
    slug: "pending",
    customDomain: "pending.com",
    settings: { custom_domain_verified: false },
  },
  {
    id: "s4",
    slug: "demo-vitrine",
    customDomain: null,
    settings: { demo: true },
  },
];

describe("syncStoreAuthHosts", () => {
  it("★ reads active stores and sends every expected host in ONE call", async () => {
    state.rows = ROWS;
    const r = await syncStoreAuthHosts();

    expect(ensureAuthorizedHosts).toHaveBeenCalledTimes(1);
    expect(ensureAuthorizedHosts).toHaveBeenCalledWith([
      "echoss.storemink.com",
      "wholesip.storemink.com",
      "wholesip.com",
      "www.wholesip.com",
      "pending.storemink.com",
    ]);
    expect(r).toEqual({
      stores: 4,
      expected: 5,
      added: [
        "echoss.storemink.com",
        "wholesip.storemink.com",
        "wholesip.com",
        "www.wholesip.com",
        "pending.storemink.com",
      ],
    });

    // Only the columns it needs, and only active stores.
    expect(Object.keys(state.columns as object).sort()).toEqual([
      "customDomain",
      "id",
      "settings",
      "slug",
    ]);
    const q = new PgDialect().sqlToQuery(state.where as any);
    expect(q.sql).toContain('"status" = $1');
    expect(q.params).toEqual(["active"]);
  });

  it("★ is add-only: it never removes an entry", async () => {
    state.rows = ROWS;
    await syncStoreAuthHosts();
    expect(removeAuthorizedHosts).not.toHaveBeenCalled();
  });

  it("dedupes hosts shared across rows", async () => {
    state.rows = [ROWS[0], { ...ROWS[0], id: "dup" }];
    const r = await syncStoreAuthHosts();
    expect(ensureAuthorizedHosts).toHaveBeenCalledWith([
      "echoss.storemink.com",
    ]);
    expect(r.expected).toBe(1);
  });

  it("passes on the write's error without throwing", async () => {
    state.rows = ROWS.slice(0, 1);
    vi.mocked(ensureAuthorizedHosts).mockResolvedValueOnce({
      added: [],
      error: "HTTP 403 refused",
    });
    expect(await syncStoreAuthHosts()).toEqual({
      stores: 1,
      expected: 1,
      added: [],
      error: "HTTP 403 refused",
    });
  });

  it("never throws when the read fails, and makes no write", async () => {
    state.fail = new Error("db down");
    expect(await syncStoreAuthHosts()).toEqual({
      stores: 0,
      expected: 0,
      added: [],
      error: "db down",
    });
    expect(ensureAuthorizedHosts).not.toHaveBeenCalled();
  });

  it("never throws when the write itself throws", async () => {
    state.rows = ROWS.slice(0, 1);
    vi.mocked(ensureAuthorizedHosts).mockRejectedValueOnce(new Error("boom"));
    expect(await syncStoreAuthHosts()).toEqual({
      stores: 1,
      expected: 1,
      added: [],
      error: "boom",
    });
  });
});
