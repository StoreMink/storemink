import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pgErrorCode } from "./errors";

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

import {
  closePool,
  DatabaseBusyError,
  isDatabaseBusy,
  POOL_WAIT_TIMEOUT_MESSAGE,
  TOO_MANY_CLIENTS,
  withService,
  withUser,
} from "./client";

type FakeClient = EventEmitter & {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

// A pooled client is an EventEmitter in pg, and the scope listens on it while
// the client is lent out, so the fake has to be one too.
function client(
  query: (sql: string) => Promise<unknown> = async () => ({}),
): FakeClient {
  return Object.assign(new EventEmitter(), {
    query: vi.fn(query),
    release: vi.fn(),
  });
}

function tooManyClients(): Error {
  return Object.assign(new Error("sorry, too many clients already"), {
    code: TOO_MANY_CLIENTS,
  });
}

function lastPoolOptions(): Record<string, unknown> {
  return mocks.poolOptions.mock.lastCall?.[0] as Record<string, unknown>;
}

const POOL_KEY = Symbol.for("storemink.db.pool");
const slot = () => (globalThis as unknown as Record<symbol, unknown>)[POOL_KEY];

beforeEach(async () => {
  await closePool();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one pool per process", () => {
  it("keeps the pool on globalThis, so a reloaded copy of this module reuses it", async () => {
    mocks.connect.mockResolvedValue(client());
    await withService(async () => undefined);
    expect(mocks.poolOptions).toHaveBeenCalledOnce();
    const pool = slot();
    expect(pool).toBeDefined();

    // A second bundle in the same process is a second module instance.
    vi.resetModules();
    const reloaded = await import("./client");
    await reloaded.withService(async () => undefined);
    await reloaded.withUser({ uid: "uid-1", email: null }, async () => null);

    expect(mocks.poolOptions).toHaveBeenCalledOnce();
    expect(slot()).toBe(pool);
    expect(mocks.connect).toHaveBeenCalledTimes(3);
  });

  it("clears the slot on closePool, and the next scope opens a fresh pool", async () => {
    mocks.connect.mockResolvedValue(client());
    await withService(async () => undefined);
    await closePool();

    expect(mocks.end).toHaveBeenCalledOnce();
    expect(slot()).toBeUndefined();
    await withService(async () => undefined);
    expect(mocks.poolOptions).toHaveBeenCalledTimes(2);
  });

  it("never lends from a pool that is closing", async () => {
    mocks.connect.mockResolvedValue(client());
    await withService(async () => undefined);
    let finishEnd: () => void = () => {};
    mocks.end.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishEnd = () => resolve(undefined);
        }),
    );

    const closing = closePool();
    await withService(async () => undefined);

    expect(mocks.poolOptions).toHaveBeenCalledTimes(2);
    finishEnd();
    await closing;
  });
});

describe("pool options", () => {
  it("gives the web pool a 5 s wait, a 30 s statement limit and a 60 s idle-transaction limit", async () => {
    vi.stubEnv("THEME_STUDIO_WORKER_ONLY", "false");
    vi.stubEnv("DB_HOST", "/cloudsql/storemink-prod:asia-south1:db");
    vi.stubEnv("DB_POOL_MAX", "5");
    vi.stubEnv("K_REVISION", "storemink-web-prod-00123-abc");
    mocks.connect.mockResolvedValue(client());

    await withService(async () => undefined);

    expect(mocks.poolOptions).toHaveBeenCalledOnce();
    expect(lastPoolOptions()).toEqual(
      expect.objectContaining({
        host: "/cloudsql/storemink-prod:asia-south1:db",
        port: undefined,
        max: 5,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 30_000,
        idle_in_transaction_session_timeout: 60_000,
        application_name: expect.stringMatching(
          /^storemink-web:storemink-web-prod-00123-abc:[a-z0-9]{1,6}$/,
        ),
        ssl: false,
        keepAlive: true,
      }),
    );
  });

  it("keeps the Theme Studio worker pool exactly as it was", async () => {
    vi.stubEnv("THEME_STUDIO_WORKER_ONLY", "true");
    vi.stubEnv("DB_POOL_MAX", "1");
    mocks.connect.mockResolvedValue(client());

    await withService(async () => undefined);

    expect(lastPoolOptions()).toEqual(
      expect.objectContaining({
        max: 1,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 30_000,
        idle_in_transaction_session_timeout: 60_000,
        application_name: expect.stringMatching(/^storemink-worker:/),
      }),
    );
  });

  it("reads the TCP port locally and falls back to a pool of 10 when DB_POOL_MAX is unset", async () => {
    vi.stubEnv("DB_HOST", "127.0.0.1");
    vi.stubEnv("DB_PORT", "5544");
    vi.stubEnv("DB_POOL_MAX", undefined);
    vi.stubEnv("K_REVISION", undefined);
    mocks.connect.mockResolvedValue(client());

    await withService(async () => undefined);

    expect(lastPoolOptions()).toEqual(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 5544,
        max: 10,
        application_name: expect.stringMatching(/^storemink-web:local:/),
      }),
    );
  });
});

describe("idle pooled connections", () => {
  it("logs a dropped idle connection instead of leaving it uncaught", async () => {
    mocks.connect.mockResolvedValue(client());
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

describe("checked-out clients", () => {
  it("listens while a client is lent out, then hands it back with no listener of ours left", async () => {
    const lent = client();
    mocks.connect.mockResolvedValue(lent);
    let listenersDuringWork = 0;

    await expect(
      withService(async () => {
        listenersDuringWork = lent.listenerCount("error");
        return "ok";
      }),
    ).resolves.toBe("ok");

    expect(listenersDuringWork).toBe(1);
    expect(lent.listenerCount("error")).toBe(0);
    expect(lent.release).toHaveBeenCalledWith();
  });

  it("catches the server ending a session mid-transaction and destroys that socket", async () => {
    const lent = client();
    mocks.connect.mockResolvedValue(lent);
    // What Postgres sends when the 60 s idle-in-transaction limit passes.
    const ended = Object.assign(
      new Error("terminating connection due to idle-in-transaction timeout"),
      { code: "25P03" },
    );
    const nextStatement = new Error(
      "Client has encountered a connection error and is not queryable",
    );
    const work = vi.fn(async () => {
      lent.emit("error", ended);
      throw nextStatement;
    });

    await expect(withService(work)).rejects.toBe(nextStatement);

    expect(lent.release).toHaveBeenCalledWith(true);
    expect(lent.listenerCount("error")).toBe(0);
    expect(mocks.logWarn).toHaveBeenCalledWith("db.checked_out_client_error", {
      code: "25P03",
      message: "terminating connection due to idle-in-transaction timeout",
    });
    expect(work).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledOnce();
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

describe("too many clients (SQLSTATE 53300)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("retries one refusal on connect after a short pause, then runs the work once", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const healthy = client();
    mocks.connect
      .mockRejectedValueOnce(tooManyClients())
      .mockResolvedValueOnce(healthy);
    const work = vi.fn(async () => "done");

    const running = withService(work);
    await vi.advanceTimersByTimeAsync(249);
    expect(mocks.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(running).resolves.toBe("done");
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledOnce();
    expect(mocks.logWarn).toHaveBeenCalledWith("db.too_many_clients_retry", {
      code: TOO_MANY_CLIENTS,
    });
    random.mockRestore();
  });

  it("gives up after that one retry with a clear DatabaseBusyError", async () => {
    const second = tooManyClients();
    mocks.connect
      .mockRejectedValueOnce(tooManyClients())
      .mockRejectedValueOnce(second)
      .mockResolvedValue(client());
    const work = vi.fn(async () => "done");

    const outcome = withService(work).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;

    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect(isDatabaseBusy(error)).toBe(true);
    expect(error).toMatchObject({
      name: "DatabaseBusyError",
      reason: "too_many_clients",
      code: TOO_MANY_CLIENTS,
      cause: second,
    });
    expect((error as Error).message).toMatch(/too many clients/);
    expect(pgErrorCode(error)).toBe(TOO_MANY_CLIENTS);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(work).not.toHaveBeenCalled();
  });

  it("retries a refusal at BEGIN on a fresh client", async () => {
    const refused = client(async (sql) => {
      if (sql === "BEGIN") throw tooManyClients();
      return {};
    });
    const healthy = client();
    mocks.connect.mockResolvedValueOnce(refused).mockResolvedValueOnce(healthy);
    const work = vi.fn(async () => "done");

    const running = withUser({ uid: "uid-1", email: null }, work);
    await vi.advanceTimersByTimeAsync(500);

    await expect(running).resolves.toBe("done");
    expect(refused.release).toHaveBeenCalledWith(true);
    expect(healthy.release).toHaveBeenCalledWith();
    expect(work).toHaveBeenCalledOnce();
  });

  it("spends the one retry across connect and BEGIN together", async () => {
    const refused = client(async (sql) => {
      if (sql === "BEGIN") throw tooManyClients();
      return {};
    });
    mocks.connect
      .mockRejectedValueOnce(tooManyClients())
      .mockResolvedValueOnce(refused)
      .mockResolvedValue(client());
    const work = vi.fn(async () => "done");

    const outcome = withService(work).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toBeInstanceOf(DatabaseBusyError);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(refused.release).toHaveBeenCalledWith(true);
    expect(work).not.toHaveBeenCalled();
  });

  it("never retries or rewraps a 53300 once the callback has started", async () => {
    const connected = client();
    mocks.connect.mockResolvedValue(connected);
    const refusal = tooManyClients();
    const work = vi.fn(async () => {
      throw refusal;
    });

    const outcome = withService(work).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toBe(refusal);
    expect(work).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledOnce();
  });
});

describe("waiting for a pooled connection", () => {
  it("reports a pool that stayed full for 5 s as DatabaseBusyError, without retrying", async () => {
    const timeout = new Error(POOL_WAIT_TIMEOUT_MESSAGE);
    mocks.connect.mockRejectedValue(timeout);

    const error = await withService(async () => "done").catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({
      name: "DatabaseBusyError",
      reason: "pool_wait_timeout",
      cause: timeout,
    });
    expect((error as Error).message).toMatch(/within 5 seconds/);
    expect(pgErrorCode(error)).toBeUndefined();
    expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it("matches pg-pool's own wording for that wait running out", async () => {
    const { Pool: RealPool } = await vi.importActual<typeof import("pg")>("pg");
    class InstantClient extends EventEmitter {
      _queryable = true;
      _ending = false;
      connect(callback: (error?: Error) => void) {
        setImmediate(() => callback());
      }
      end(callback?: () => void) {
        callback?.();
      }
    }
    const pool = new RealPool({
      max: 1,
      connectionTimeoutMillis: 20,
      Client: InstantClient as never,
    });

    const held = await pool.connect();
    await expect(pool.connect()).rejects.toMatchObject({
      message: POOL_WAIT_TIMEOUT_MESSAGE,
    });
    held.release();
    await pool.end();
  });
});
