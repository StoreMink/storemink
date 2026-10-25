// The Cloud SQL data layer (GCP migration Phase 5). Replaces the Supabase
// client factories with Drizzle over a pg Pool, enforcing the 2A tenancy model:
// every query runs inside a transaction that SETs LOCAL the DB role (and, for
// user requests, the app.current_user_id GUC the RLS shim reads). Because
// SET LOCAL is transaction-scoped, identity can NEVER leak across pooled
// connections.
//
// Three scoped runners map 1:1 onto the old Supabase clients:
//   withService  → app_service (BYPASSRLS)  ~ createAdminClient()
//   withUser     → app_user + GUC (RLS)     ~ createClient() (cookie, signed-in)
//   withAnon     → app_user, no GUC (RLS)   ~ createPublicClient() (storefront)
//
// Connection config comes from env: locally DB_HOST=127.0.0.1:DB_PORT via the
// Cloud SQL Auth Proxy; on Cloud Run DB_HOST=/cloudsql/<INSTANCE_CONNECTION_NAME>
// (unix socket). Auth is the `app` login role (member of app_user + app_service).

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as schema from "../../drizzle/schema";
import * as relations from "../../drizzle/relations";
import { pgErrorCode } from "./errors";
import { postgresStringTimestampTypes } from "./pg-types";
import { logWarn } from "@/lib/observability/logger";

const fullSchema = { ...schema, ...relations };
export type Db = NodePgDatabase<typeof fullSchema>;

// ★★ ONE POOL PER PROCESS, HELD ON globalThis (B26). A module-level `let`
// gives every bundle that includes this file its own pool, and a Next build
// includes it several times: the Oct 20 production build carries it in three
// server chunks (the route handlers, the proxy, the app pages), each loaded by
// its own runtime with its own module cache. So one Cloud Run process could
// hold three pools of DB_POOL_MAX each (one server was measured holding 14 to
// 19 connections against a database that allows about 25). globalThis is the
// one object every bundle in a process shares, and Symbol.for returns the same
// key from all of them. A dev hot reload therefore keeps the pool too (no leak),
// so a change to the settings below needs a dev server restart.
const POOL_KEY = Symbol.for("storemink.db.pool");
const processGlobal = globalThis as typeof globalThis &
  Record<symbol, Pool | undefined>;

// ★★ THE LIMITS EVERY POOL GETS, web and Theme Studio worker alike (B27). They
// are the values the private workers (THEME_STUDIO_WORKER_ONLY) already had;
// the web pool had none, so a burst queued for a connection without end, a
// stuck statement or an abandoned transaction could hold a connection slot
// (and its locks) for ever, and "too many clients" failed the request at once.
//   ★ 5 s to get a connection. pg-pool applies it to BOTH waiting in its queue
//     for a free pooled client and opening a new one.
//   ★ 30 s per statement. The longest legitimate statements are well below it:
//     a 12-month analytics read over 200k orders takes about 1 s (205 ms and
//     843 ms measured locally, 2026-10-23), CSV import and export work one
//     row or one 500-row page per transaction, Help embeddings are fetched
//     before their transaction opens, redesign writes are many short
//     statements, and advisory or row lock waits last only as long as the
//     short transaction holding the lock. It counts lock waits, so it also
//     bounds a pile-up behind one stuck transaction. Those that need more
//     SET LOCAL their own statement_timeout: deleteStore's purge
//     (app/actions/platform.ts) and the two analytics rollups
//     (lib/analytics/storefront-rollup.ts), 5 min each, measured 2026-10-24.
//   ★ 60 s idle inside a transaction. No transaction awaits network work
//     (model calls, gateways, GCS, email) before it commits: each is done
//     before the transaction opens or after it closes (every scoped callback
//     was scanned for it, 2026-10-23). So a transaction idle for a minute was
//     abandoned, and Postgres ends that session rather than let it pin a slot
//     and its row locks.
//   ★ Never open a scope inside another's callback (a `withService` inside a
//     `withService`). The private Theme Studio workers run DB_POOL_MAX=1,
//     where the inner one waits the 5 s above and fails as DatabaseBusyError;
//     on the web it holds two of the pool's connections at once. The photo
//     check before a design review did so until 2026-10-25 (pinned by
//     lib/theme-studio/photo-check-pool-postgres.test.ts); it now takes
//     `withService` itself, not a `db`, and opens its scopes one at a time.
// Migrations never come through here: scripts/db-migrate.mjs opens its own
// client as DB_ADMIN_USER, so a long CREATE INDEX is not cut off by these.
const POOL_LIMITS = {
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000,
} as const;

/**
 * Names this process's connections in pg_stat_activity: role, Cloud Run
 * revision and a tag drawn once per pool. One tag per process is what proves
 * there is one pool per process, and the revision separates the old and new
 * pools during a deploy. Postgres keeps the first 63 bytes.
 */
function applicationName(): string {
  const role =
    process.env.THEME_STUDIO_WORKER_ONLY === "true" ? "worker" : "web";
  const revision = process.env.K_REVISION || "local";
  const tag = Math.random().toString(36).slice(2, 8);
  return `storemink-${role}:${revision}:${tag}`.slice(0, 63);
}

function createPool(): Pool {
  const host = process.env.DB_HOST;
  const isUnixSocket = host?.startsWith("/");
  const pool = new Pool({
    host,
    // Unix socket (Cloud Run) ignores port; TCP (local proxy) needs it.
    port: isUnixSocket ? undefined : Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // Dedicated Studio workers run with DB_POOL_MAX=1
    // (scripts/theme-studio-workers.py); the web takes _DB_POOL_MAX from
    // cloudbuild.yaml. Unset or unreadable falls back to 10, as before.
    max: Number(process.env.DB_POOL_MAX ?? 10),
    ...POOL_LIMITS,
    application_name: applicationName(),
    // Keep the full PostgreSQL timestamp text. Converting through JS Date
    // would discard microseconds and break exact optimistic-lock predicates.
    types: postgresStringTimestampTypes,
    // The Auth Proxy / unix socket already provide a secure channel.
    ssl: false,
    // Keep sockets warm so an idle connection isn't silently dropped by the
    // Cloud SQL Auth Proxy — a dropped idle socket surfaces as ECONNRESET on
    // its next use.
    keepAlive: true,
  });
  // ★ An IDLE pooled connection the server or socket drops is emitted on
  // the pool. With no listener Node reports it as an uncaughtException
  // (production, 2026-10-03: two idle Cloud SQL sockets mid Theme Studio
  // run). pg already discards that client and opens a fresh one on the next
  // acquire, so this is a log line, not a failure — and it must not be able
  // to crash a script or worker that has no framework handler.
  pool.on("error", (error) => {
    logWarn("db.idle_client_error", {
      code: (error as { code?: unknown }).code ?? null,
      message: error.message,
    });
  });
  return pool;
}

function getPool(): Pool {
  return (processGlobal[POOL_KEY] ??= createPool());
}

// The DB roles are fixed internal constants (never user input), so interpolating
// them into SET LOCAL ROLE — which cannot take a bind parameter — is safe.
type AppRole = "app_service" | "app_user";

// Transient connection errors worth a quick retry: on a flaky link (or when the
// Cloud SQL Auth Proxy recycles an idle socket) ACQUIRING a connection can fail
// with these before any statement has run.
const TRANSIENT_CONN_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  // PostgreSQL connection-class failures and server shutdown/recovery. These
  // can surface on the first query of an idle pooled socket rather than from
  // pool.connect(), so acquisition-only retry is not sufficient.
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
]);
function isTransientConnError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_CONN_CODES.has(code);
}

/** SQLSTATE `too_many_connections`: every connection slot on the server is taken. */
export const TOO_MANY_CLIENTS = "53300";
function isTooManyClients(err: unknown): boolean {
  return pgErrorCode(err) === TOO_MANY_CLIENTS;
}

// pg-pool's own words when `connectionTimeoutMillis` passes with every pooled
// client still checked out (pg-pool 3.14.0; client.test.ts pins it against
// the real library, so an upgrade that rewords it fails a test).
export const POOL_WAIT_TIMEOUT_MESSAGE =
  "timeout exceeded when trying to connect";
function isPoolWaitTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === POOL_WAIT_TIMEOUT_MESSAGE;
}

/**
 * The database had no connection to give: every server slot was taken
 * (SQLSTATE 53300) even after one short retry, or none of this process's
 * pooled connections came free within the 5-second wait. Nothing ran, so the
 * caller may say "busy, try again" rather than report a failure of its own.
 * The original error is the `cause`; `code` stays 53300 for the first, so
 * `pgErrorCode` still reads it.
 */
export class DatabaseBusyError extends Error {
  readonly reason: "too_many_clients" | "pool_wait_timeout";
  readonly code: string | undefined;

  constructor(reason: DatabaseBusyError["reason"], cause: unknown) {
    super(
      reason === "too_many_clients"
        ? "The database has no free connections right now (too many clients), even after a retry. Try again in a moment."
        : `No database connection came free within ${POOL_LIMITS.connectionTimeoutMillis / 1000} seconds. Try again in a moment.`,
      { cause },
    );
    this.name = "DatabaseBusyError";
    this.reason = reason;
    this.code = reason === "too_many_clients" ? TOO_MANY_CLIENTS : undefined;
  }
}

/** Is this the database saying it had no connection to give right now? */
export function isDatabaseBusy(err: unknown): err is DatabaseBusyError {
  return err instanceof DatabaseBusyError;
}

// ★ ONE SHORT RETRY when the server is out of connection slots, per scoped
// call, spent on whichever step met it first (connecting, or BEGIN and the
// identity setup). A slot frees as soon as any pool anywhere closes an idle
// client or finishes a transaction; the jitter keeps the requests of one burst
// from all coming back in the same millisecond. A second refusal is reported
// as DatabaseBusyError, never retried again: waiting longer here only holds
// the merchant's request open.
const TOO_MANY_CLIENTS_RETRY_MS = 250;
const TOO_MANY_CLIENTS_RETRY_JITTER_MS = 250;
interface BusyBudget {
  retried: boolean;
}
async function retryOnceWhenFull(
  budget: BusyBudget,
  err: unknown,
): Promise<void> {
  if (budget.retried) throw new DatabaseBusyError("too_many_clients", err);
  budget.retried = true;
  logWarn("db.too_many_clients_retry", { code: TOO_MANY_CLIENTS });
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      TOO_MANY_CLIENTS_RETRY_MS +
        Math.random() * TOO_MANY_CLIENTS_RETRY_JITTER_MS,
    ),
  );
}

// Acquire a pooled connection, retrying briefly on transient network errors.
// Retrying the ACQUIRE is safe (no statement has run yet); we never retry a
// statement or a whole transaction — that could double-apply a write.
async function acquireClient(
  budget: BusyBudget,
  retries = 2,
): Promise<PoolClient> {
  for (let attempt = 0; ; ) {
    try {
      return await getPool().connect();
    } catch (err) {
      if (isTooManyClients(err)) {
        await retryOnceWhenFull(budget, err);
        continue;
      }
      if (isPoolWaitTimeout(err))
        throw new DatabaseBusyError("pool_wait_timeout", err);
      if (attempt >= retries || !isTransientConnError(err)) throw err;
      attempt++;
      await new Promise((r) => setTimeout(r, 120 * attempt));
    }
  }
}

async function runScoped<T>(
  role: AppRole,
  identity: { uid?: string; email?: string } | null,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const busy: BusyBudget = { retried: false };
  for (let attempt = 0; ; ) {
    const client = await acquireClient(busy);
    // ★★ A CHECKED-OUT CLIENT HAS NO ERROR LISTENER UNLESS WE ADD ONE. pg-pool
    // removes its own while the client is lent out, and the server can end the
    // session while nothing is running on it (the 60 s idle-in-transaction
    // limit, a restart): pg then emits `error` on the client, which with no
    // listener is an uncaught exception. The next statement on it fails, so
    // the scope still throws; this keeps the cause and destroys the socket.
    let connectionError: Error | undefined;
    const onClientError = (error: Error) => {
      connectionError ??= error;
      logWarn("db.checked_out_client_error", {
        code: (error as { code?: unknown }).code ?? null,
        message: error.message,
      });
    };
    client.on("error", onClientError);
    let callbackStarted = false;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      if (identity?.uid) {
        // set_config(..., is_local => true) == SET LOCAL; value is parameterised.
        await client.query(
          "SELECT set_config('app.current_user_id', $1, true)",
          [identity.uid],
        );
      }
      if (identity?.email) {
        await client.query(
          "SELECT set_config('app.current_user_email', $1, true)",
          [identity.email],
        );
      }
      const db = drizzle(client, { schema: fullSchema });
      callbackStarted = true;
      const result = await fn(db);
      await client.query("COMMIT");
      client.removeListener("error", onClientError);
      if (connectionError) client.release(true);
      else client.release();
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      client.removeListener("error", onClientError);
      // Passing true destroys a broken pooled socket instead of returning it
      // for the next request. Never retry after fn starts: it may have written,
      // and replaying an uncertain transaction could duplicate business work.
      const full = isTooManyClients(err);
      if (connectionError || full || isTransientConnError(err)) {
        client.release(true);
      } else {
        client.release();
      }
      if (callbackStarted) throw err;
      if (full) {
        await retryOnceWhenFull(busy, err);
        continue;
      }
      if (attempt >= 2 || !isTransientConnError(err)) throw err;
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, 120 * attempt));
    }
  }
}

/**
 * Service-role scope: BYPASSRLS. Tenant scoping is the caller's responsibility
 * (explicit `.eq(store_id, …)`), exactly as the Supabase service client worked.
 */
export function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return runScoped("app_service", null, fn);
}

/**
 * A verified caller opening a user-scoped transaction. BOTH fields are
 * required (email may be null) — see withUser for why omitting the email is a
 * silent authorisation bug rather than a missing nicety.
 */
export interface UserIdentity {
  /** Verified uid → `app.current_user_id` → `auth.uid()`. */
  uid: string;
  /**
   * Verified email → `app.current_user_email` → `auth.email()`. Null only for
   * an account that genuinely has no email. Get it from `getServerUser()` or a
   * gate that returns an identity (`getManagerIdentity`) — never invent one.
   */
  email: string | null;
}

/**
 * Signed-in user scope: RLS enforced, with app.current_user_id AND
 * app.current_user_email set so `auth.uid()`/`auth.email()` both resolve
 * inside every policy.
 *
 * `email` is REQUIRED (nullable) on purpose. The store-admin RLS helper is
 *   is_store_admin(store) := is_platform_admin() OR <admins row for store>
 * and `is_platform_admin()` matches `platform_admins` BY EMAIL via
 * `auth.email()`. With no email GUC, `auth.email()` is NULL, that branch is
 * dead, and a StoreMink platform operator — who has god access at the app
 * layer but no `admins` row for the store they're managing — matches no
 * policy. Postgres then returns zero rows and reports NO error: reads look
 * empty and writes look successful. That is precisely how `/dashboard/orders`
 * came to show "No orders yet" for a store whose analytics page showed nine.
 * Making the field required means the compiler, not a future incident,
 * catches the omission.
 */
export function withUser<T>(
  identity: UserIdentity,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return runScoped(
    "app_user",
    { uid: identity.uid, email: identity.email ?? undefined },
    fn,
  );
}

/**
 * Anonymous scope: RLS enforced with NO identity set, so only the public
 * (published/active) policy branches match — the storefront read path.
 */
export function withAnon<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return runScoped("app_user", null, fn);
}

/**
 * Close the process's pool (tests / graceful shutdown). The slot is cleared
 * before the pool ends, so a call that arrives meanwhile opens a fresh pool
 * instead of borrowing from one that is closing.
 */
export async function closePool(): Promise<void> {
  const pool = processGlobal[POOL_KEY];
  processGlobal[POOL_KEY] = undefined;
  await pool?.end();
}
