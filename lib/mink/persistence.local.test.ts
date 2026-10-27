/** Rollback-only checks, against local Postgres, of what the chat's own
 * records do to a storefront revamp: a failed or stopped chat run KEEPS the
 * revamp it started and saves its card (B4, which replaced money-3's
 * cancellation), a run a dead server left running is closed through the same
 * record (B7), a new chat deletes nothing, and the History delete never
 * reaches a conversation whose revamp is still being made (money-5). Run with
 * MINK_REVAMP_LOCAL_TEST=1; the fixed loopback database keeps it away from
 * Cloud SQL, and everything happens inside one transaction that is rolled back.
 *
 * ★ Inside one transaction `now()` is frozen at its start, so a lease never
 *   expires by waiting: the tests move timestamps by hand.
 * ★ The code under test runs as `app_service`, the role `withService` takes in
 *   production, so a write that role may not make fails here too. */
import { readFileSync } from "node:fs";
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
import type { MinkActorContext, MinkRunProgress } from "./types";

const service = vi.hoisted(() => ({
  db: null as Db | null,
  client: null as Client | null,
  count: 0,
  pending: Promise.resolve(),
}));
vi.mock("@/lib/db/client", () => ({
  async withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const previous = service.pending;
    let release!: () => void;
    service.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const name = `persistence_${++service.count}`;
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
  },
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ enabled: true, chargeCredits: true }),
}));
vi.mock("./revamp/trigger", () => ({
  kickRevampRunner: vi.fn(async () => undefined),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  deleteMinkConversation,
  getMinkConversation,
} from "./conversation-history";
import { closeStaleMinkRuns, failMinkRun, startMinkRun } from "./persistence";
import type { RevampRequest } from "./revamp/contract";
import {
  claimRevampJob,
  createRevampJob,
  failRevampJob,
  finishRevampReady,
  renewRevampLease,
  type RevampJobRow,
} from "./revamp/jobs";
import { ZERO_REVAMP_USAGE } from "./revamp/ports";

const ADMIN = "persistence-owner";

const EMPTY_PROGRESS: MinkRunProgress = {
  steps: 1,
  toolCalls: 1,
  retryCount: 0,
  usage: {
    promptTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    basePromptTokens: 0,
  },
};

function fullRequest(): RevampRequest {
  return {
    kind: "full",
    brief: {
      business: "Hand-poured soy candles",
      look: "Warm and calm",
      audience: "Gift buyers",
      facts: ["Poured in Pune"],
      avoid: "",
      language: "English",
    },
    products: [],
    categories: [],
    pages: null,
    instruction: null,
    refineScope: null,
  };
}

const enabled = process.env.MINK_REVAMP_LOCAL_TEST === "1";
describe.skipIf(!enabled)(
  "chat records and the storefront revamp, on local Postgres",
  () => {
    let client: Client;
    let storeId: string;

    beforeAll(async () => {
      client = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      await client.query("BEGIN");
      service.client = client;
      service.db = drizzle(client, { schema: { ...schema, ...relations } });
      // ★ The migration the revamp tables come from, applied inside the
      //   rolled-back transaction when the local database has not run it yet.
      const manifest = JSON.parse(
        readFileSync("drizzle/migrations/manifest.json", "utf8"),
      );
      const applied = new Set(
        (
          await client.query("select id from public.schema_migrations")
        ).rows.map((row) => row.id),
      );
      const migration = manifest.migrations.find(
        (entry: { id: string }) =>
          entry.id === "20261021_0234_mink_storefront_revamp",
      );
      if (!applied.has(migration.id)) {
        await client.query(
          readFileSync(`drizzle/migrations/${migration.file}`, "utf8"),
        );
      }
    }, 30_000);

    afterAll(async () => {
      if (client) {
        await client.query("ROLLBACK");
        await client.end();
      }
    });

    beforeEach(async () => {
      await client.query("SAVEPOINT persistence_fixture");
      storeId = crypto.randomUUID();
      await client.query(
        "insert into stores(id,slug,name,status,plan,settings) values($1,$2,'Lumen','active','pro',$3)",
        [storeId, `persistence-${storeId}`, { brand: { name: "Lumen" } }],
      );
    });

    afterEach(async () => {
      await client.query("ROLLBACK TO SAVEPOINT persistence_fixture");
      await client.query("RELEASE SAVEPOINT persistence_fixture");
    });

    // -------------------------------------------------------------------------
    // Fixtures.
    // -------------------------------------------------------------------------

    async function conversation(hoursAgo = 0): Promise<string> {
      const id = crypto.randomUUID();
      await client.query(
        `insert into mink_conversations(id,store_id,admin_id,title,last_message_at,created_at)
       values($1,$2,$3,'Chat',now() - make_interval(hours => $4),now() - make_interval(hours => $4))`,
        [id, storeId, ADMIN, hoursAgo],
      );
      return id;
    }

    async function run(
      conversationId: string,
      status = "running",
    ): Promise<string> {
      const id = crypto.randomUUID();
      await client.query(
        `insert into mink_runs(id,store_id,conversation_id,requested_by,request_id,model,status,completed_at)
       values($1,$2,$3,$4,$5,'fixture',$6,CASE WHEN $6 = 'running' THEN NULL ELSE now() END)`,
        [id, storeId, conversationId, ADMIN, crypto.randomUUID(), status],
      );
      return id;
    }

    function actorFor(runId: string | undefined): MinkActorContext {
      return {
        storeId,
        adminId: ADMIN,
        email: "owner@example.com",
        roleSlug: "superadmin",
        permissions: {},
        isSuperadmin: true,
        effectivePlan: "pro",
        locationIds: null,
        analyticsTimeZone: "Asia/Kolkata",
        currency: "INR",
        defaultLowStockThreshold: 5,
        requestId: crypto.randomUUID(),
        runId,
        draftingEnabled: true,
      } as MinkActorContext;
    }

    async function revamp(
      conversationId: string,
      runId: string,
    ): Promise<RevampJobRow> {
      const created = await createRevampJob({
        actor: actorFor(runId),
        conversationId,
        kind: "full",
        request: fullRequest(),
        parentId: null,
        budgetCredits: null,
      });
      if (!created.ok) throw new Error("expected a new revamp");
      return created.job;
    }

    /** A revamp that finished: its card is a draft of the run that started it. */
    async function readyRevamp(
      conversationId: string,
      runId: string,
    ): Promise<{ revampId: string; draftId: string }> {
      const job = await revamp(conversationId, runId);
      const claimed = await claimRevampJob(job.id);
      if (!claimed) throw new Error("expected a claim");
      const draftId = (
        await client.query(
          `insert into mink_drafts(store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits)
         values($1,$2,$3,'storefront_personalization','storefront','Whole storefront','/dashboard/builder','Store redesign',$4,1)
         returning id`,
          [
            storeId,
            ADMIN,
            runId,
            { plan_json: "{}", plan_digest: "digest", explanation: "Redesign" },
          ],
        )
      ).rows[0].id as string;
      const ok = await finishRevampReady({
        revampId: job.id,
        leaseToken: claimed.leaseToken,
        draftId,
        credits: 0,
        result: { checked: true },
        usage: ZERO_REVAMP_USAGE,
      });
      expect(ok).toBe(true);
      return { revampId: job.id, draftId };
    }

    async function revampRow(id: string) {
      return (
        await client.query("select * from mink_revamps where id = $1", [id])
      ).rows[0];
    }

    async function fail(
      conversationId: string,
      runId: string,
      status: "failed" | "cancelled" = "cancelled",
    ) {
      return failMinkRun({
        actor: actorFor(runId),
        started: { conversationId, runId },
        status,
        errorCode: status === "cancelled" ? "cancelled" : "run_timeout",
        latencyMs: 1_000,
        model: "fixture",
        pricingLocation: "global",
        progress: EMPTY_PROGRESS,
        usageStatus: "unavailable",
      });
    }

    async function cardMessages(runId: string) {
      return (
        await client.query(
          "select role, content_json, model from mink_messages where run_id = $1 and role = 'assistant' order by created_at",
          [runId],
        )
      ).rows as Array<{
        role: string;
        content_json: {
          text: string;
          artifacts: Array<Record<string, unknown>>;
          interrupted?: boolean;
        };
        model: string | null;
      }>;
    }

    async function balance(): Promise<number> {
      return (
        await client.query(
          "select balance from ai_credit_balances where store_id = $1",
          [storeId],
        )
      ).rows[0].balance as number;
    }

    /** An unseen proposal of the run, charged from the purchased balance. */
    async function proposal(runId: string, credits: number): Promise<string> {
      const id = (
        await client.query(
          `insert into mink_drafts(store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits,charged_credits,credit_source)
         values($1,$2,$3,'customer_message','customer_message','Customers','/dashboard/users','Welcome message','{}'::jsonb,$4,$4,'credit')
         returning id`,
          [storeId, ADMIN, runId, credits],
        )
      ).rows[0].id as string;
      await client.query(
        `insert into mink_draft_credit_usage(draft_id,store_id,run_id,draft_kind,period,expected_credits,charged_credits,plan_credits,balance_credits,source)
       values($1,$2,$3,'customer_message','2026-10',$4,$4,0,$4,'credit')`,
        [id, storeId, runId, credits],
      );
      return id;
    }

    /** A paid card: its credit row is the run's, as card.ts writes it. */
    async function paidReadyRevamp(chat: string, runId: string) {
      const card = await readyRevamp(chat, runId);
      await client.query(
        `insert into mink_draft_credit_usage(draft_id,store_id,run_id,draft_kind,period,expected_credits,charged_credits,plan_credits,balance_credits,source)
       values($1,$2,$3,'storefront_personalization','2026-10',4,4,0,4,'credit')`,
        [card.draftId, storeId, runId],
      );
      await client.query(
        "update mink_revamps set free = false, credits = 4 where id = $1",
        [card.revampId],
      );
      return card;
    }

    async function draftExists(id: string): Promise<boolean> {
      return (
        (await client.query("select id from mink_drafts where id = $1", [id]))
          .rows.length === 1
      );
    }

    // -------------------------------------------------------------------------
    // B4: a failed or stopped chat run keeps the revamp it started.
    // -------------------------------------------------------------------------

    describe("a chat run that fails or is stopped (B4)", () => {
      it("★ keeps the queued revamp it started, still the free one, and saves its card", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        const job = await revamp(chat, runId);
        expect(job.free).toBe(true);

        const record = await fail(chat, runId, "cancelled");

        expect(await revampRow(job.id)).toMatchObject({
          status: "queued",
          free: true,
          cancel_requested_at: null,
        });
        const artifact = {
          type: "storefront_revamp",
          revampId: job.id,
          kind: "full",
          status: "queued",
        };
        expect(record).toEqual({
          closed: true,
          card: {
            text: "Your storefront redesign is being made. You can follow it here.",
            artifacts: [artifact],
          },
        });
        expect(await cardMessages(runId)).toEqual([
          {
            role: "assistant",
            model: null,
            content_json: {
              text: "Your storefront redesign is being made. You can follow it here.",
              artifacts: [artifact],
              interrupted: true,
            },
          },
        ]);
      });

      it("★ never asks a revamp being worked on to stop: its runner carries on", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        const job = await revamp(chat, runId);
        const claimed = await claimRevampJob(job.id);
        expect(claimed).not.toBeNull();

        await fail(chat, runId, "failed");

        const row = await revampRow(job.id);
        expect(row.status).toBe("running");
        expect(row.cancel_requested_at).toBeNull();
        expect(await renewRevampLease(job.id, claimed!.leaseToken)).toEqual({
          ok: true,
          cancelRequested: false,
        });
      });

      it("keeps a running revamp nobody holds", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        const job = await revamp(chat, runId);
        await claimRevampJob(job.id);
        await client.query(
          "update mink_revamps set lease_until = now() - interval '1 second' where id = $1",
          [job.id],
        );

        await fail(chat, runId, "failed");

        expect((await revampRow(job.id)).status).toBe("running");
      });

      it("★★ keeps a card that finished before the run failed, with its draft and its charge", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        await client.query(
          "insert into ai_credit_balances(store_id,balance) values($1,10)",
          [storeId],
        );
        const { revampId, draftId } = await paidReadyRevamp(chat, runId);

        const record = await fail(chat, runId, "cancelled");

        expect(await revampRow(revampId)).toMatchObject({
          status: "ready",
          draft_id: draftId,
          credits: 4,
        });
        expect(await draftExists(draftId)).toBe(true);
        // Never refunded.
        expect(await balance()).toBe(10);
        expect(record.card?.text).toBe(
          "Your storefront redesign is ready. You can review it here.",
        );
      });

      it("★ keeps a card drafted under the revamp's own id before the revamp names it", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        const job = await revamp(chat, runId);
        await claimRevampJob(job.id);
        await client.query(
          `insert into mink_drafts(id,store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits)
         values($1,$2,$3,$4,'storefront_personalization','storefront','Whole storefront','/dashboard/builder','Store redesign',$5,1)`,
          [
            job.id,
            storeId,
            ADMIN,
            runId,
            { plan_json: "{}", plan_digest: "digest", explanation: "Redesign" },
          ],
        );

        await fail(chat, runId, "failed");

        expect(await draftExists(job.id)).toBe(true);
      });

      it("★★ beside a kept card, discards and refunds only the other proposals", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        await client.query(
          "insert into ai_credit_balances(store_id,balance) values($1,10)",
          [storeId],
        );
        const { revampId, draftId } = await paidReadyRevamp(chat, runId);
        const other = await proposal(runId, 2);

        await fail(chat, runId, "failed");

        expect(await draftExists(draftId)).toBe(true);
        expect(await draftExists(other)).toBe(false);
        // Only the other proposal's 2 credits come back; the card's 4 stay.
        expect(await balance()).toBe(12);
        expect(
          (
            await client.query(
              "select delta from ai_credit_ledger where store_id = $1 and ref = $2",
              [storeId, `mink-draft-refund:${other}`],
            )
          ).rows,
        ).toEqual([{ delta: 2 }]);
        expect(await revampRow(revampId)).toMatchObject({
          status: "ready",
          draft_id: draftId,
        });
        // The holder run is gone; the conversation holds only the real run.
        expect(
          (
            await client.query(
              "select id, status from mink_runs where conversation_id = $1",
              [chat],
            )
          ).rows,
        ).toEqual([{ id: runId, status: "failed" }]);
      });

      it("discards and refunds a run's proposals as before when it started no redesign", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        await client.query(
          "insert into ai_credit_balances(store_id,balance) values($1,10)",
          [storeId],
        );
        const other = await proposal(runId, 2);

        const record = await fail(chat, runId, "cancelled");

        expect(await draftExists(other)).toBe(false);
        expect(await balance()).toBe(12);
        expect(record).toEqual({ closed: true, card: null });
        expect(await cardMessages(runId)).toEqual([]);
      });

      it("★ shows the kept card in History after a reload, and keeps other failed runs hidden", async () => {
        const chat = await conversation();
        const asked = await run(chat);
        await client.query(
          `insert into mink_messages(store_id,conversation_id,run_id,role,content_json)
         values($1,$2,$3,'user','{"text":"Redesign my store"}')`,
          [storeId, chat, asked],
        );
        const job = await revamp(chat, asked);
        await fail(chat, asked, "failed");
        const other = await run(chat);
        await client.query(
          `insert into mink_messages(store_id,conversation_id,run_id,role,content_json)
         values($1,$2,$3,'user','{"text":"And my sales?"}')`,
          [storeId, chat, other],
        );
        await fail(chat, other, "failed");

        const detail = await getMinkConversation(actorFor(undefined), chat);

        expect(detail.messages.map((message) => message.text)).toEqual([
          "Redesign my store",
          "Your storefront redesign is being made. You can follow it here.",
        ]);
        expect(detail.messages[1].artifacts).toEqual([
          {
            type: "storefront_revamp",
            revampId: job.id,
            kind: "full",
            status: "queued",
          },
        ]);
      });

      it("★ saves no second card when the run is recorded twice", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        await revamp(chat, runId);

        await fail(chat, runId, "failed");
        const again = await fail(chat, runId, "failed");

        expect(again).toEqual({ closed: false, card: null });
        expect(await cardMessages(runId)).toHaveLength(1);
      });

      it("★ refuses a run that succeeded and changes nothing", async () => {
        const chat = await conversation();
        const runId = await run(chat, "succeeded");
        const job = await revamp(chat, runId);

        await expect(fail(chat, runId, "failed")).rejects.toThrow(
          "Mink failed-run record scope rejected",
        );

        expect((await revampRow(job.id)).status).toBe("queued");
        expect(await cardMessages(runId)).toEqual([]);
        expect(
          (
            await client.query("select status from mink_runs where id = $1", [
              runId,
            ])
          ).rows[0].status,
        ).toBe("succeeded");
      });

      it("keeps a refinement's card, and the redesign it replaced stays replaced", async () => {
        const chat = await conversation();
        const earlier = await run(chat, "succeeded");
        const parent = await readyRevamp(chat, earlier);
        const runId = await run(chat);
        const created = await createRevampJob({
          actor: actorFor(runId),
          conversationId: chat,
          kind: "refine",
          request: {
            ...fullRequest(),
            kind: "refine",
            instruction: "Warmer colours",
            refineScope: {
              design: true,
              copy: false,
              layout: false,
              photos: null,
              pages: null,
              products: false,
            },
          },
          parentId: parent.revampId,
          budgetCredits: null,
        });
        if (!created.ok) throw new Error("expected a refinement");
        const claimed = await claimRevampJob(created.job.id);
        const draftId = (
          await client.query(
            `insert into mink_drafts(store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits)
           values($1,$2,$3,'storefront_personalization','storefront','Whole storefront','/dashboard/builder','Store redesign',$4,1)
           returning id`,
            [
              storeId,
              ADMIN,
              runId,
              {
                plan_json: "{}",
                plan_digest: "digest",
                explanation: "Redesign",
              },
            ],
          )
        ).rows[0].id as string;
        await finishRevampReady({
          revampId: created.job.id,
          leaseToken: claimed!.leaseToken,
          draftId,
          credits: 0,
          result: { checked: true },
          usage: ZERO_REVAMP_USAGE,
        });

        await fail(chat, runId, "failed");

        expect(await revampRow(created.job.id)).toMatchObject({
          status: "ready",
          draft_id: draftId,
        });
        expect((await revampRow(parent.revampId)).status).toBe("superseded");
      });

      it("leaves a revamp another run started alone, with no card on this run", async () => {
        const chat = await conversation();
        const startedBy = await run(chat);
        const job = await revamp(chat, startedBy);
        const later = await run(chat);

        const record = await fail(chat, later, "cancelled");

        expect((await revampRow(job.id)).status).toBe("queued");
        expect(record.card).toBeNull();
        expect(await cardMessages(later)).toEqual([]);
      });

      it("saves no card for a finished revamp and leaves its status alone", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        const job = await revamp(chat, runId);
        const claimed = await claimRevampJob(job.id);
        await failRevampJob({
          revampId: job.id,
          leaseToken: claimed!.leaseToken,
          code: "model_unavailable",
          detail: "fixture",
        });

        const record = await fail(chat, runId, "failed");

        expect(await revampRow(job.id)).toMatchObject({
          status: "failed",
          error_code: "model_unavailable",
        });
        expect(record.card).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // B7: a run a dead server left running.
    // -------------------------------------------------------------------------

    describe("a run a dead server left running (B7)", () => {
      async function age(runId: string, minutes: number) {
        await client.query(
          "update mink_runs set started_at = now() - make_interval(mins => $2) where id = $1",
          [runId, minutes],
        );
      }

      async function runRow(runId: string) {
        return (
          await client.query(
            "select status, error_code, latency_ms, completed_at from mink_runs where id = $1",
            [runId],
          )
        ).rows[0];
      }

      it("★ is closed through the failure record, and its chat can then be deleted", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        await age(runId, 25);
        // A tool call it started before it died, outside the window.
        await client.query(
          `insert into mink_tool_calls(store_id,run_id,sequence,tool_name,started_at)
         values($1,$2,1,'get_store_profile',now() - interval '20 minutes')`,
          [storeId, runId],
        );

        const result = await closeStaleMinkRuns({ storeId });

        expect(result).toEqual({ closed: 1, failed: 0 });
        expect(await runRow(runId)).toMatchObject({
          status: "failed",
          error_code: "run_abandoned",
          latency_ms: 1_500_000,
        });
        expect(
          (
            await client.query(
              "select tool_call_count from mink_runs where id = $1",
              [runId],
            )
          ).rows[0].tool_call_count,
        ).toBe(1);
        expect(
          (
            await client.query(
              "select status, error_code from mink_tool_calls where run_id = $1",
              [runId],
            )
          ).rows,
        ).toEqual([{ status: "failed", error_code: "run_failed" }]);
        await deleteMinkConversation(actorFor(undefined), chat);
        expect(
          (
            await client.query(
              "select id from mink_conversations where id = $1",
              [chat],
            )
          ).rows,
        ).toHaveLength(0);
      });

      it("★ the History delete closes it itself, then deletes", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        await age(runId, 20);

        await deleteMinkConversation(actorFor(undefined), chat);

        expect(
          (
            await client.query(
              "select id from mink_conversations where id = $1",
              [chat],
            )
          ).rows,
        ).toHaveLength(0);
      });

      it("★ a dead run's redesign is kept with its card, and the chat then refuses deletion for the redesign", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        const job = await revamp(chat, runId);
        await age(runId, 20);

        await expect(
          deleteMinkConversation(actorFor(undefined), chat),
        ).rejects.toMatchObject({
          code: "conversation_has_redesign",
          status: 409,
        });

        expect((await runRow(runId)).status).toBe("failed");
        expect((await revampRow(job.id)).status).toBe("queued");
        expect(await cardMessages(runId)).toHaveLength(1);
      });

      it("★ a run within its limit still keeps its chat busy", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        await age(runId, 2);

        await expect(
          deleteMinkConversation(actorFor(undefined), chat),
        ).rejects.toMatchObject({ code: "conversation_busy", status: 409 });
        expect((await runRow(runId)).status).toBe("running");
        expect(await closeStaleMinkRuns({ storeId })).toEqual({
          closed: 0,
          failed: 0,
        });
      });

      it("★ a run that started long ago but called a tool recently is not dead", async () => {
        const chat = await conversation();
        const runId = await run(chat);
        await age(runId, 30);
        await client.query(
          `insert into mink_tool_calls(store_id,run_id,sequence,tool_name,started_at)
         values($1,$2,1,'generate_storefront_image',now() - interval '2 minutes')`,
          [storeId, runId],
        );

        expect(await closeStaleMinkRuns({ storeId })).toEqual({
          closed: 0,
          failed: 0,
        });
        expect((await runRow(runId)).status).toBe("running");
      });

      it("★ closes at most twenty a pass, oldest first", async () => {
        const chat = await conversation();
        const runs: string[] = [];
        for (let i = 0; i < 21; i += 1) {
          const runId = await run(chat);
          await age(runId, 60 - i);
          runs.push(runId);
        }

        expect(await closeStaleMinkRuns({ storeId, limit: 500 })).toEqual({
          closed: 20,
          failed: 0,
        });
        // The youngest of the dead is the one left for the next pass.
        expect((await runRow(runs[20])).status).toBe("running");
        expect(await closeStaleMinkRuns({ storeId })).toEqual({
          closed: 1,
          failed: 0,
        });
      });
    });

    // -------------------------------------------------------------------------
    // money-5: a new chat deletes nothing; the History delete keeps a chat
    // whose revamp is still being made, and retires the rest
    // (conversation-retire.ts; conversation-retention.local.test.ts has the
    // rest of the rules).
    // -------------------------------------------------------------------------

    describe("starting and deleting conversations", () => {
      async function fillHistory(count: number) {
        for (let i = 1; i <= count; i += 1) await conversation(i);
      }

      async function chatCount(): Promise<number> {
        return Number(
          (
            await client.query(
              "select count(*) as n from mink_conversations where store_id = $1",
              [storeId],
            )
          ).rows[0].n,
        );
      }

      it("★ a new chat deletes nothing, however many chats exist", async () => {
        // The oldest of fifteen conversations holds a ready card.
        const oldest = await conversation(48);
        const oldRun = await run(oldest, "succeeded");
        const { revampId, draftId } = await readyRevamp(oldest, oldRun);
        await fillHistory(14);
        expect(await chatCount()).toBe(15);

        const started = await startMinkRun({
          actor: actorFor(undefined),
          message: "How many orders today?",
          model: "fixture",
        });

        expect(started.conversationId).not.toBe(oldest);
        expect(await chatCount()).toBe(16);
        expect(await revampRow(revampId)).toMatchObject({
          status: "ready",
          draft_id: draftId,
        });
      });

      it("★ deletes a conversation whose redesign card is ready: the card goes with it, stripped", async () => {
        const chat = await conversation();
        const chatRun = await run(chat, "succeeded");
        const { revampId } = await readyRevamp(chat, chatRun);

        await expect(
          deleteMinkConversation(actorFor(undefined), chat),
        ).resolves.toBe("deleted");

        expect(
          (
            await client.query(
              "select id from mink_conversations where id = $1",
              [chat],
            )
          ).rows,
        ).toHaveLength(0);
        expect(await revampRow(revampId)).toMatchObject({
          status: "superseded",
          draft_id: null,
          conversation_id: null,
          requester_email: null,
          plan: null,
          request: { kind: "full" },
        });
      });

      it("refuses to delete a conversation whose redesign is still being made", async () => {
        const chat = await conversation();
        const chatRun = await run(chat, "succeeded");
        await revamp(chat, chatRun);

        await expect(
          deleteMinkConversation(actorFor(undefined), chat),
        ).rejects.toMatchObject({
          code: "conversation_has_redesign",
          status: 409,
        });
      });

      it("deletes a conversation whose redesign failed, stripping the redesign", async () => {
        const chat = await conversation();
        const chatRun = await run(chat, "succeeded");
        const job = await revamp(chat, chatRun);
        const claimed = await claimRevampJob(job.id);
        await failRevampJob({
          revampId: job.id,
          leaseToken: claimed!.leaseToken,
          code: "model_unavailable",
          detail: "fixture",
        });

        await deleteMinkConversation(actorFor(undefined), chat);

        expect(
          (
            await client.query(
              "select id from mink_conversations where id = $1",
              [chat],
            )
          ).rows,
        ).toHaveLength(0);
        expect(await revampRow(job.id)).toMatchObject({
          status: "failed",
          error_code: "model_unavailable",
          error_detail: null,
          request: { kind: "full" },
        });
      });
    });
  },
);
