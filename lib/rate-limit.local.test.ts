/** Rollback-only checks of the weighted rate limiter against the local
 * database. Run with RATE_LIMIT_LOCAL_TEST=1; the fixed loopback address
 * keeps it off Cloud SQL, it runs as app_service (the role `withService`
 * uses, the only one granted the function), and everything it writes is
 * rolled back. */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
}));
vi.mock("@/lib/db/client", () => ({
  async withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const name = `rate_limit_${++service.count}`;
    await service.client!.query(`SAVEPOINT ${name}`);
    try {
      const value = await fn(service.db!);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await service.client!.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  },
}));

import { rateLimit } from "./rate-limit";

const enabled = process.env.RATE_LIMIT_LOCAL_TEST === "1";

describe.skipIf(!enabled)(
  "the weighted rate limiter on the local database",
  () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.USER,
      });
      await client.connect();
      await client.query("BEGIN");
      // Already applied on a current local database; re-running is harmless.
      await client.query(
        readFileSync(
          "drizzle/migrations/sql/20261019_0229_rate_limit_cost.sql",
          "utf8",
        ),
      );
      await client.query("SET LOCAL ROLE app_service");
      service.client = client;
      service.db = drizzle(client) as unknown as Db;
    });

    afterAll(async () => {
      await client?.query("ROLLBACK");
      await client?.end();
    });

    it("spends each call's cost, and refuses the call that would overspend", async () => {
      const key = `local-test:chars:${crypto.randomUUID()}`;
      const budget = { max: 40, windowSeconds: 60 };
      expect(await rateLimit(key, { ...budget, cost: 25 })).toEqual({
        allowed: true,
      });
      expect(await rateLimit(key, { ...budget, cost: 15 })).toEqual({
        allowed: true,
      });
      expect(await rateLimit(key, { ...budget, cost: 1 })).toEqual({
        allowed: false,
      });
      const { rows } = await client.query(
        "select count from public.rate_limits where key = $1",
        [key],
      );
      expect(rows[0].count).toBe(41);
    });

    it("still counts one per call without a cost", async () => {
      const key = `local-test:requests:${crypto.randomUUID()}`;
      expect(
        (await rateLimit(key, { max: 2, windowSeconds: 60 })).allowed,
      ).toBe(true);
      expect(
        (await rateLimit(key, { max: 2, windowSeconds: 60 })).allowed,
      ).toBe(true);
      expect(
        (await rateLimit(key, { max: 2, windowSeconds: 60 })).allowed,
      ).toBe(false);
    });

    it("refuses the app's user role outright", async () => {
      await client.query("SAVEPOINT as_user");
      await client.query("SET LOCAL ROLE app_user");
      await expect(
        client.query(
          "select public.check_rate_limit_cost('local-test:user', 10, 60, 1)",
        ),
      ).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK TO SAVEPOINT as_user");
      await client.query("SET LOCAL ROLE app_service");
    });
  },
);
