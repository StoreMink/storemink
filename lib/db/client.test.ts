import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(async () => undefined),
  drizzle: vi.fn(() => ({ scope: "db" })),
  on: vi.fn(),
  logWarn: vi.fn(),
  poolOptions: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("pg", () => ({
  Pool: class {
    constructor(options: unknown) {
      mocks.poolOptions(options);
    }
    connect = mocks.connect;
    end = mocks.end;
    on = mocks.on;
  },
}));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: mocks.drizzle,
}));
vi.mock("./pg-types", () => ({ postgresStringTimestampTypes: {} }));
vi.mock("@/lib/observability/logger", () => ({ logWarn: mocks.logWarn }));

import { closePool, withService } from "./client";

function client(query: (sql: string) => Promise<unknown>) {
  return { query: vi.fn(query), release: vi.fn() };
}

beforeEach(async () => {
  await closePool();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it("bounds private worker connections without changing the merchant web pool", async () => {
  mocks.connect.mockResolvedValue(client(async () => ({})));
  vi.stubEnv("THEME_STUDIO_WORKER_ONLY", "true");
  vi.stubEnv("DB_POOL_MAX", "1");
  await withService(async () => undefined);
  expect(mocks.poolOptions).toHaveBeenLastCalledWith(
    expect.objectContaining({
      max: 1,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 60_000,
    }),
  );
  await closePool();
  vi.stubEnv("THEME_STUDIO_WORKER_ONLY", "false");
  await withService(async () => undefined);
  const options = mocks.poolOptions.mock.lastCall?.[0] as Record<
    string,
    unknown
  >;
  expect(options).not.toHaveProperty("connectionTimeoutMillis");
  expect(options).not.toHaveProperty("statement_timeout");
  expect(options).not.toHaveProperty("idle_in_transaction_session_timeout");
});

describe("idle pooled connections", () => {
  it("logs a dropped idle connection instead of leaving it uncaught", async () => {
    mocks.connect.mockResolvedValue(client(async () => ({})));
    await withService(async () => undefined);
    const [event, handler] = mocks.on.mock.calls[0] as unknown as [
      string,
      (error: Error) => void,
    ];
    expect(event).toBe("error");
    expect(() =>
      handler(new Error("Connection terminated unexpectedly")),
    ).not.toThrow();
    expect(mocks.logWarn).toHaveBeenCalledWith("db.idle_client_error", {
      code: null,
      message: "Connection terminated unexpectedly",
    });
  });
});

describe("database scope connection recovery", () => {
  it("destroys and retries a stale pooled socket that fails before work starts", async () => {
    const reset = Object.assign(new Error("socket reset"), {
      code: "ECONNRESET",
    });
    const stale = client(async (sql) => {
      if (sql === "BEGIN") throw reset;
      return {};
    });
    const healthy = client(async () => ({}));
    mocks.connect.mockResolvedValueOnce(stale).mockResolvedValueOnce(healthy);
    const work = vi.fn(async (db) => db);

    await expect(withService(work)).resolves.toEqual({ scope: "db" });

    expect(stale.release).toHaveBeenCalledWith(true);
    expect(healthy.release).toHaveBeenCalledWith();
    expect(work).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("never replays work after the transaction callback has started", async () => {
    const reset = Object.assign(new Error("socket reset"), {
      code: "08006",
    });
    const connected = client(async () => ({}));
    mocks.connect.mockResolvedValue(connected);
    const work = vi.fn(async () => {
      throw reset;
    });

    await expect(withService(work)).rejects.toBe(reset);

    expect(work).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(connected.release).toHaveBeenCalledWith(true);
  });
});
