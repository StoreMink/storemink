/** Rollback-only checks, against local Postgres, of the Overview's four
 * takedown queues (takedown stage T16a, design 6.1), through the real
 * `getPlatformInsights` statement:
 *
 * - an open complaint whose deadline has passed counts as due, and stops
 *   counting once it is resolved;
 * - a complaint whose next deadline is a day away does not count;
 * - an active store hold counts once its review date (India time) is reached,
 *   and not before.
 *
 * Counts are compared as changes from the figure before each case, since the
 * local database may already hold complaints and holds of its own.
 *
 * Run with MODERATION_LOCAL_TEST=1 after `npm run db:migrate:local -- apply`
 * (migration 20261030_0269_content_takedown). The fixed loopback database
 * keeps it away from Cloud SQL; everything happens inside one transaction that
 * is rolled back, each case in its own savepoint. The code under test runs as
 * `app_service`, the role `withService` takes in production. Nothing reaches a
 * network: `fetch` throws. Identity values (grievance_complaints.ref_no) are
 * never rolled back, so each run moves that sequence on.
 */
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  pending: Promise.resolve(),
}));
vi.mock("@/lib/db/client", () => {
  async function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const previous = service.pending;
    let release!: () => void;
    service.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `t16a_scope_${++service.count}`;
    await service.client!.query(`SAVEPOINT ${name}`);
    try {
      await service.client!.query("SET ROLE app_service");
      const value = await fn(service.db!);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await service.client!.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await service.client!.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally {
      await service.client!.query("RESET ROLE");
      release();
    }
  }
  const notUsed = () => {
    throw new Error("Only withService is used by the code under test.");
  };
  return { withService, withUser: notUsed, withAnon: notUsed };
});
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { logComplaint, resolveComplaint } from "@/lib/moderation/complaints";
import { setStoreHold } from "@/lib/moderation/holds";
import { getPlatformInsights } from "./overview";

const enabled = process.env.MODERATION_LOCAL_TEST === "1";

const MIGRATION = "20261030_0269_content_takedown";
const HOUR = 60 * 60 * 1000;
const CASE_MS = 30_000;
const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const OPS = { email: `t16a-${tag}-ops@probe.test`, role: "member" as const };
const SUPER = {
  email: `t16a-${tag}-super@probe.test`,
  role: "superadmin" as const,
};

type Row = Record<string, unknown>;

/** "YYYY-MM-DD" of India time, `days` from today. */
function istDate(days: number): string {
  const ist = new Date(Date.now() + 5.5 * HOUR + days * 24 * HOUR);
  return ist.toISOString().slice(0, 10);
}

describe.skipIf(!enabled)(
  "the Overview's takedown queues (local database)",
  () => {
    let client: Client;
    let heldStoreId = "";

    const one = async (text: string, params: unknown[] = []) =>
      ((await client.query(text, params)).rows[0] ?? null) as Row | null;

    async function attention() {
      const insights = await getPlatformInsights();
      expect(insights.ok).toBe(true);
      return insights.attention;
    }

    async function logged(kind: string, receivedAgoH: number) {
      const result = await logComplaint(
        {
          receivedAt: new Date(Date.now() - receivedAgoH * HOUR),
          channel: "email",
          kind,
          complainantName: "Asha Rao",
          complainantContact: "asha@example.com",
          storeId: null,
          urls: [],
          summary: "Please remove the photo of me.",
        },
        OPS,
      );
      if (!result.ok) throw new Error(`logComplaint refused: ${result.error}`);
      return result.complaint;
    }

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.MODERATION_LOCAL_TEST_USER || process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      service.client = client;
      service.db = drizzle(client, { schema: { ...schema, ...relations } });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("No network in this test.");
        }),
      );
      const ledger = await one(
        "select 1 as ok from public.schema_migrations where id = $1",
        [MIGRATION],
      );
      if (!ledger) {
        throw new Error(
          `${MIGRATION} is not applied to storemink_local: run npm run db:migrate:local -- apply first.`,
        );
      }
      // Any store with no active hold: one active hold per store.
      const store = await one(
        `select s.id from public.stores s
          where not exists (select 1 from public.store_legal_holds h
                             where h.store_id = s.id and h.released_at is null)
          order by s.created_at, s.id limit 1`,
      );
      if (!store) throw new Error("No local store without a hold.");
      heldStoreId = String(store.id);
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      if (!client) return;
      await client.query("ROLLBACK");
      await client.end();
    });

    beforeEach(async () => {
      await client.query("SAVEPOINT t16a_case");
    });
    afterEach(async () => {
      await client.query("ROLLBACK TO SAVEPOINT t16a_case");
      await client.query("RELEASE SAVEPOINT t16a_case");
    });

    it(
      "counts an overdue open complaint as due, and stops once it is resolved",
      async () => {
        const before = (await attention()).complaintsDue;
        // A court order received 4 hours ago: its 3-hour deadline has passed.
        const complaint = await logged("court_order", 4);
        expect((await attention()).complaintsDue).toBe(before + 1);
        const resolved = await resolveComplaint(
          complaint.id,
          { outcome: "removed" },
          OPS,
        );
        expect(resolved.ok).toBe(true);
        expect((await attention()).complaintsDue).toBe(before);
      },
      CASE_MS,
    );

    it(
      "does not count a complaint whose next deadline is a day away",
      async () => {
        const before = (await attention()).complaintsDue;
        // An "Other complaint" received now: acknowledge within 24 hours.
        await logged("grievance", 0);
        expect((await attention()).complaintsDue).toBe(before);
      },
      CASE_MS,
    );

    it(
      "counts a hold whose review date has come",
      async () => {
        const before = (await attention()).holdsToReview;
        const held = await setStoreHold(
          {
            storeId: heldStoreId,
            reason: "Police enquiry",
            reviewOn: istDate(0),
          },
          SUPER,
        );
        expect(held.ok).toBe(true);
        expect((await attention()).holdsToReview).toBe(before + 1);
      },
      CASE_MS,
    );

    it(
      "does not count a hold whose review date is tomorrow",
      async () => {
        const before = (await attention()).holdsToReview;
        const held = await setStoreHold(
          {
            storeId: heldStoreId,
            reason: "Police enquiry",
            reviewOn: istDate(1),
          },
          SUPER,
        );
        expect(held.ok).toBe(true);
        expect((await attention()).holdsToReview).toBe(before);
      },
      CASE_MS,
    );
  },
);
