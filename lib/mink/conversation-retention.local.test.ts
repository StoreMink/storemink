/** Rollback-only checks, against local Postgres, of Mink AI chat history
 * (migrations 0248 to 0250): the 90-day sweep, the merchant's delete, the
 * strip of redesigns nobody applied, the records a retired chat keeps, the
 * History list and search, and the foreign keys all of that relies on. Run
 * with MINK_HISTORY_LOCAL_TEST=1; the fixed loopback database keeps it away
 * from Cloud SQL, and everything happens inside one transaction that is
 * rolled back. Built like persistence.local.test.ts.
 *
 * ★ Inside one transaction `now()` is frozen at its start: the fixtures set
 *   every timestamp by hand.
 * ★ The code under test runs as `app_service`, the role `withService` takes in
 *   production, so a write that role may not make fails here too.
 * ⚠ The execution race (design 9.4 case 14) needs two connections and
 *   commits, so it is not here: this file never commits. */
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
import type { MinkActorContext } from "./types";

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
    const name = `history_${++service.count}`;
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
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { logWarn } from "@/lib/observability/logger";
import { storefrontImageUsage } from "@/lib/media/image-usage";
import {
  deleteMinkConversation,
  getMinkConversation,
  listMinkConversations,
  searchMinkConversations,
} from "./conversation-history";
import { retireMinkConversation } from "./conversation-retire";
import { pruneIdleMinkConversations } from "./conversation-retention";
import {
  REVIEWED_DOCUMENT_MARKER,
  addReviewedMinkDocument,
} from "./document-input";
import { addSavedMinkMediaReference } from "./media-attachment";
import { startMinkRun } from "./persistence";
import { getLatestMinkProductAction } from "./product-actions";
import { readEarlierRevampPlans } from "./revamp/jobs";

const ADMIN = "history-owner";
const OTHER_ADMIN = "history-staff";
const DAY_MS = 86_400_000;
const HASH = "c".repeat(64);
/** These migrations are what this file tests; applied here when the local ledger lacks them. */
const MIGRATIONS = [
  "20261026_0248_mink_chat_history_retention",
  "20261026_0249_mink_chat_history_search_index",
  "20261026_0250_mink_approval_outlives_product",
];

/** The sweep's floor, as `sweepPolicy` passes it: 90 days ago. */
function floor(): string {
  return new Date(Date.now() - 90 * DAY_MS).toISOString();
}

const enabled = process.env.MINK_HISTORY_LOCAL_TEST === "1";
describe.skipIf(!enabled)("Mink AI chat history, on local Postgres", () => {
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
    // ★ Case 9 runs 0248's DDL inside this transaction: a lock another
    //   session holds fails it within 5 s instead of hanging every case.
    await client.query("SET LOCAL lock_timeout = '5s'");
    service.client = client;
    service.db = drizzle(client, { schema: { ...schema, ...relations } });
    const manifest = JSON.parse(
      readFileSync("drizzle/migrations/manifest.json", "utf8"),
    );
    const applied = new Set(
      (await client.query("select id from public.schema_migrations")).rows.map(
        (row) => row.id,
      ),
    );
    for (const id of MIGRATIONS) {
      const migration = manifest.migrations.find(
        (entry: { id: string }) => entry.id === id,
      );
      if (!applied.has(id)) {
        await client.query(
          readFileSync(`drizzle/migrations/${migration.file}`, "utf8"),
        );
      }
    }
  }, 30_000);

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  beforeEach(async () => {
    vi.mocked(logWarn).mockClear();
    await client.query("SAVEPOINT history_fixture");
    storeId = crypto.randomUUID();
    await client.query(
      "insert into stores(id,slug,name,status,plan,settings) values($1,$2,'Lumen','active','pro',$3)",
      [storeId, `history-${storeId}`, { brand: { name: "Lumen" } }],
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK TO SAVEPOINT history_fixture");
    await client.query("RELEASE SAVEPOINT history_fixture");
  });

  // ---------------------------------------------------------------------------
  // Fixtures. Times are days before the transaction's frozen now().
  // ---------------------------------------------------------------------------

  function actor(adminId = ADMIN): MinkActorContext {
    return {
      storeId,
      adminId,
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
      draftingEnabled: true,
    } as MinkActorContext;
  }

  /**
   * A chat last messaged `idleDays` ago. Its expiry is last message + 90 days
   * unless given (`expiresInDays`, negative for a past one).
   */
  async function chat(
    options: {
      title?: string;
      idleDays?: number;
      createdDaysAgo?: number;
      expiresInDays?: number;
      admin?: string;
    } = {},
  ): Promise<string> {
    const idle = options.idleDays ?? 0;
    const created = options.createdDaysAgo ?? idle;
    const expires = options.expiresInDays ?? 90 - idle;
    const { rows } = await client.query(
      `insert into mink_conversations(store_id,admin_id,title,last_message_at,created_at,expires_at)
       values($1,$2,$3,
              now() - make_interval(secs => $4::double precision * 86400),
              now() - make_interval(secs => $5::double precision * 86400),
              now() + make_interval(secs => $6::double precision * 86400))
       returning id`,
      [
        storeId,
        options.admin ?? ADMIN,
        options.title ?? "Chat",
        idle,
        created,
        expires,
      ],
    );
    return rows[0].id as string;
  }

  async function run(
    conversationId: string,
    options: {
      status?: string;
      stopped?: boolean;
      currentPath?: string | null;
      admin?: string;
    } = {},
  ): Promise<string> {
    const status = options.status ?? "succeeded";
    const { rows } = await client.query(
      `insert into mink_runs(store_id,conversation_id,requested_by,request_id,model,status,completed_at,error_code,stop_requested_at,current_path)
       values($1,$2,$3,gen_random_uuid(),'fixture',$4,
              case when $4 = 'running' then null else now() end,
              case when $5::boolean then 'stopped' when $4 in ('failed','cancelled') then 'run_failed' else null end,
              case when $5::boolean then now() else null end,
              $6)
       returning id`,
      [
        storeId,
        conversationId,
        options.admin ?? ADMIN,
        status,
        options.stopped === true,
        options.currentPath ?? null,
      ],
    );
    return rows[0].id as string;
  }

  async function message(
    conversationId: string,
    runId: string,
    role: "user" | "assistant",
    text: string,
    minutesAgo = 0,
  ): Promise<string> {
    const { rows } = await client.query(
      `insert into mink_messages(store_id,conversation_id,run_id,role,content_json,created_at)
       values($1,$2,$3,$4,$5,now() - make_interval(mins => $6))
       returning id`,
      [storeId, conversationId, runId, role, { text }, minutesAgo],
    );
    return rows[0].id as string;
  }

  async function draft(
    runId: string,
    options: { id?: string; kind?: string } = {},
  ): Promise<string> {
    const kind = options.kind ?? "coupon_create";
    const { rows } = await client.query(
      `insert into mink_drafts(id,store_id,admin_id,run_id,kind,destination_type,destination_label,destination_path,title,content_json,expected_credits)
       values(coalesce($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,'Proposal',$9,1)
       returning id`,
      kind === "storefront_personalization"
        ? [
            options.id ?? null,
            storeId,
            ADMIN,
            runId,
            kind,
            "storefront",
            "Whole storefront",
            "/dashboard/builder",
            {
              plan_json: "{}",
              plan_digest: "digest",
              explanation: "Redesign",
            },
          ]
        : [
            options.id ?? null,
            storeId,
            ADMIN,
            runId,
            kind,
            "coupon",
            "Coupons",
            "/dashboard/coupons",
            {},
          ],
    );
    return rows[0].id as string;
  }

  async function approval(
    draftId: string,
    options: {
      status?: string;
      audited?: boolean;
      tool?: string;
      resourceType?: string;
      resourceId?: string | null;
      productId?: string | null;
      productVersion?: string | null;
    } = {},
  ): Promise<string> {
    const status = options.status ?? "executed";
    const tool = options.tool ?? "create_coupon";
    const resourceType = options.resourceType ?? "coupon";
    const executed = status === "executed";
    const { rows } = await client.query(
      `insert into mink_action_approvals(store_id,admin_id,draft_id,resource_type,resource_id,result_id,product_id,product_version,tool_name,operation,status,draft_version,before_json,after_json,request_hash,idempotency_key,expires_at,approved_at,executed_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,'apply',$10,$11,$12,$13,$14,gen_random_uuid(),now() + interval '10 minutes',
              case when $15::boolean then now() else null end,
              case when $15::boolean then now() else null end)
       returning id`,
      [
        storeId,
        ADMIN,
        draftId,
        resourceType,
        options.resourceId ?? null,
        executed && tool === "apply_storefront_personalization"
          ? storeId
          : null,
        options.productId ?? null,
        options.productVersion ?? null,
        tool,
        status,
        tool === "apply_storefront_personalization" ? 0 : 1,
        tool === "apply_storefront_personalization"
          ? { plan_digest: "a" }
          : tool === "apply_product_description"
            ? { description: "Old words" }
            : {},
        tool === "apply_storefront_personalization"
          ? { plan_digest: "b" }
          : tool === "apply_product_description"
            ? { description: "New words" }
            : {},
        HASH,
        executed,
      ],
    );
    const approvalId = rows[0].id as string;
    if (options.audited ?? executed) {
      await client.query(
        `insert into mink_action_audit(approval_id,store_id,admin_id,draft_id,resource_type,resource_id,result_id,product_id,tool_name,operation,outcome,before_json,after_json,request_hash)
         select id,store_id,admin_id,draft_id,resource_type,resource_id,result_id,product_id,tool_name,operation,'executed',before_json,after_json,request_hash
           from mink_action_approvals where id = $1`,
        [approvalId],
      );
    }
    return approvalId;
  }

  /**
   * A storefront redesign of `conversationId`; a ready (or applied) one has
   * its card draft under `runId`, keyed by the redesign's own id as jobs.ts
   * writes it.
   */
  async function redesign(
    conversationId: string,
    runId: string,
    options: {
      status: string;
      kind?: "full" | "refine";
      free?: boolean;
      applied?: boolean;
      parentId?: string | null;
      plan?: string;
      withDraft?: boolean;
      photoHold?: boolean;
    },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const kind = options.kind ?? "full";
    const withDraft =
      options.withDraft ?? (options.status === "ready" || !!options.applied);
    if (withDraft) {
      await draft(runId, { id, kind: "storefront_personalization" });
    }
    await client.query(
      `insert into mink_revamps(id,store_id,admin_id,requester_email,conversation_id,origin_run_id,parent_id,kind,status,step,request,plan,snapshot,result,draft_id,free,applied_at,error_code,error_detail,finished_at)
       values($1,$2,$3,'owner@example.com',$4,$5,$6,$7,$8,
              case when $8 in ('queued','running') then 'snapshot' else 'card' end,
              $9,$10,$11,$12,$13,$14,
              case when $15::boolean then now() else null end,
              case when $8 = 'failed' then 'plan_failed' else null end,
              case when $8 = 'failed' then 'model said: interview words' else null end,
              case when $8 in ('queued','running') then null else now() end)`,
      [
        id,
        storeId,
        ADMIN,
        conversationId,
        runId,
        options.parentId ?? null,
        kind,
        options.status,
        kind === "full"
          ? {
              kind,
              brief: {
                business:
                  "We bake every morning from 5 am in our Aundh kitchen.",
              },
            }
          : { kind, instruction: "warmer" },
        options.plan
          ? { stage: "compiled", plan: { summary: options.plan } }
          : null,
        options.applied ? { pages: [] } : null,
        options.photoHold
          ? { photoHold: { units: ["u1", "u2"] }, pages: ["home"] }
          : { pages: ["home"] },
        withDraft ? id : null,
        options.free ?? false,
        options.applied ?? false,
      ],
    );
    return id;
  }

  async function one<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return (await client.query(text, params)).rows[0] as T | undefined;
  }

  async function count(text: string, params: unknown[] = []): Promise<number> {
    return Number((await one<{ n: string }>(text, params))?.n ?? 0);
  }

  async function chatRow(id: string) {
    return one<{
      status: string;
      title: string;
      summary_json: unknown;
      expires_at: string;
    }>(
      "select status, title, summary_json, expires_at::text from mink_conversations where id = $1",
      [id],
    );
  }

  const sweep = () => pruneIdleMinkConversations(floor(), 50);

  // ---------------------------------------------------------------------------
  // 1-4: retiring by the sweep.
  // ---------------------------------------------------------------------------

  it("1. ★ deletes an idle chat with no record, and everything in it", async () => {
    const idle = await chat({ idleDays: 91, createdDaysAgo: 100 });
    const runId = await run(idle);
    await message(idle, runId, "user", "How many orders?");
    await message(idle, runId, "assistant", "Twelve.");
    await draft(runId);
    // ★ A preview nobody confirmed is not a record (D3): the chat is deleted.
    await approval(await draft(runId), { status: "pending", audited: false });
    await client.query(
      "insert into mink_tool_calls(store_id,run_id,sequence,tool_name) values($1,$2,1,'store_data')",
      [storeId, runId],
    );
    await client.query(
      "insert into mink_usage_ledger(store_id,admin_id,run_id,model,input_tokens,output_tokens,thought_tokens,total_tokens) values($1,$2,$3,'fixture',1,1,0,2)",
      [storeId, ADMIN, runId],
    );
    await client.query(
      "insert into mink_feedback(store_id,run_id,admin_id,rating,details_redacted) values($1,$2,$3,'unhelpful','my words')",
      [storeId, runId, ADMIN],
    );

    expect(await sweep()).toBeGreaterThanOrEqual(1);

    expect(await chatRow(idle)).toBeUndefined();
    for (const table of [
      "mink_runs",
      "mink_messages",
      "mink_tool_calls",
      "mink_usage_ledger",
      "mink_feedback",
      "mink_drafts",
      "mink_action_approvals",
    ]) {
      expect(
        await count(`select count(*) as n from ${table} where store_id = $1`, [
          storeId,
        ]),
        table,
      ).toBe(0);
    }
  });

  it("2. ★ reduces an idle chat holding an approved change: its words go, the record stays, and it is invisible everywhere", async () => {
    const idle = await chat({
      title: "Zebracode coupon",
      idleDays: 91,
      createdDaysAgo: 100,
    });
    const kept = await run(idle, { currentPath: "/dashboard/users?q=Ramesh" });
    const other = await run(idle);
    await message(idle, kept, "user", "Make a zebracode coupon");
    await message(idle, kept, "assistant", "Done: zebracode saves 10%.");
    await client.query(
      "insert into mink_feedback(store_id,run_id,admin_id,rating,details_redacted) values($1,$2,$3,'helpful','my words')",
      [storeId, kept, ADMIN],
    );
    await client.query(
      'update mink_conversations set summary_json = \'{"text":"summary words"}\' where id = $1',
      [idle],
    );
    const record = await draft(kept);
    const executed = await approval(record);
    const unbacked = await draft(other);
    const previewed = await draft(other);
    const preview = await approval(previewed, {
      status: "pending",
      audited: false,
    });

    expect(await sweep()).toBeGreaterThanOrEqual(1);

    expect(await chatRow(idle)).toMatchObject({
      status: "deleted",
      title: "Deleted chat",
      summary_json: null,
    });
    expect(
      await count(
        "select count(*) as n from mink_messages where conversation_id = $1",
        [idle],
      ),
    ).toBe(0);
    expect(
      await count(
        "select count(*) as n from mink_feedback where store_id = $1",
        [storeId],
      ),
    ).toBe(0);
    const drafts = (
      await client.query(
        "select id from mink_drafts where store_id = $1 order by id",
        [storeId],
      )
    ).rows.map((row) => row.id);
    expect(drafts).toEqual([record]);
    expect(drafts).not.toContain(unbacked);
    expect(
      await one("select id from mink_action_approvals where id = $1", [
        preview,
      ]),
    ).toBeUndefined();
    expect(
      await one("select status from mink_action_approvals where id = $1", [
        executed,
      ]),
    ).toEqual({ status: "executed" });
    expect(
      await count(
        "select count(*) as n from mink_action_audit where approval_id = $1",
        [executed],
      ),
    ).toBe(1);
    // The run behind the kept draft stays, without the dashboard address; the
    // other run held nothing kept and went.
    expect(
      (
        await client.query(
          "select id, current_path from mink_runs where store_id = $1",
          [storeId],
        )
      ).rows,
    ).toEqual([{ id: kept, current_path: null }]);

    // Invisible everywhere a chat is listed, opened or continued.
    const page = await listMinkConversations(actor());
    expect(page.conversations.map((row) => row.id)).not.toContain(idle);
    expect(
      (await searchMinkConversations(actor(), { query: "zebracode" }))
        .conversations,
    ).toEqual([]);
    await expect(getMinkConversation(actor(), idle)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      startMinkRun({
        actor: actor(),
        conversationId: idle,
        message: "Hello again",
        model: "fixture",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("3. ★ reduces an idle chat whose draft became a blog post, without a foreign-key error", async () => {
    const idle = await chat({ idleDays: 91, createdDaysAgo: 100 });
    const runId = await run(idle);
    const post = await draft(runId);
    const publish = await approval(post, {
      status: "pending",
      audited: false,
      tool: "publish_blog",
      resourceType: "blog",
    });
    const blog = (
      await client.query(
        "insert into blogs(store_id,title,slug) values($1,'Diwali hampers','diwali-hampers') returning id",
        [storeId],
      )
    ).rows[0].id as string;
    await client.query(
      `insert into mink_blog_publications(store_id,admin_id,draft_id,approval_id,blog_id,mode,status,blog_version,published_at)
       values($1,$2,$3,$4,$5,'publish_now','published',now(),now())`,
      [storeId, ADMIN, post, publish, blog],
    );

    await sweep();

    expect((await chatRow(idle))?.status).toBe("deleted");
    expect(
      await count(
        "select count(*) as n from mink_blog_publications where approval_id = $1 and draft_id = $2",
        [publish, post],
      ),
    ).toBe(1);
    // ★ The records check knew it: the delete was never tried and refused.
    expect(logWarn).not.toHaveBeenCalledWith(
      "mink.retire: delete refused, reducing",
      expect.anything(),
    );
  });

  it("4. ★ reduces an idle chat whose approval an email campaign names; the campaign stays", async () => {
    const idle = await chat({ idleDays: 91, createdDaysAgo: 100 });
    const runId = await run(idle);
    const proposal = await draft(runId);
    const send = await approval(proposal, {
      status: "pending",
      audited: false,
      tool: "send_campaign",
      resourceType: "campaign",
      resourceId: crypto.randomUUID(),
    });
    const campaign = (
      await client.query(
        `insert into email_campaigns(store_id,subject,body,code,discount_label,mink_approval_id,audience_mode,audience_label,sender_address,brand_snapshot,confirmed_at,status)
         values($1,'Diwali','Hello','DIWALI','10% off',$2,'all','All customers','shop@example.com','{}',now(),'done') returning id`,
        [storeId, send],
      )
    ).rows[0].id as string;

    await sweep();

    expect((await chatRow(idle))?.status).toBe("deleted");
    expect(
      await one("select mink_approval_id from email_campaigns where id = $1", [
        campaign,
      ]),
    ).toEqual({ mink_approval_id: send });
    expect(logWarn).not.toHaveBeenCalledWith(
      "mink.retire: delete refused, reducing",
      expect.anything(),
    );
  });

  // ---------------------------------------------------------------------------
  // 5: storefront redesigns (D2, D7).
  // ---------------------------------------------------------------------------

  it("5a. ★ deletes a chat whose only redesign is a ready, never-applied free card; the row is stripped and still holds the free redesign", async () => {
    const active = await chat({ title: "Redesign my store" });
    const runId = await run(active);
    await message(active, runId, "user", "We bake every morning from 5 am");
    const card = await redesign(active, runId, {
      status: "ready",
      free: true,
      plan: "Warm bakery",
      photoHold: true,
    });
    await client.query(
      `insert into mink_draft_credit_usage(draft_id,store_id,run_id,draft_kind,period,expected_credits,charged_credits,plan_credits,balance_credits,source)
       values($1,$2,$3,'storefront_personalization','2026-10',1,0,0,0,'plan')`,
      [card, storeId, runId],
    );
    const image = {
      url: `https://storage.googleapis.com/b/stores/${storeId}/mink-generated/a.webp`,
      path: `stores/${storeId}/mink-generated/a.webp`,
    };
    await client.query(
      `insert into mink_revamp_images(id,revamp_id,store_id,role,slot_id,url,path,sha256,width,height)
       values(gen_random_uuid(),$1,$2,'slot','hero',$3,$4,$5,800,600)`,
      [card, storeId, image.url, image.path, "a".repeat(64)],
    );
    expect((await storefrontImageUsage(storeId, image)).redesignCard).toBe(
      true,
    );

    // ★ D2: a ready card no longer refuses the merchant's delete.
    await expect(deleteMinkConversation(actor(), active)).resolves.toBe(
      "deleted",
    );

    expect(await chatRow(active)).toBeUndefined();
    expect(
      await one(
        `select status, free, request, requester_email, snapshot, plan, error_detail,
                result, draft_id, origin_run_id, conversation_id
           from mink_revamps where id = $1`,
        [card],
      ),
    ).toEqual({
      status: "superseded",
      free: true,
      request: { kind: "full" },
      requester_email: null,
      snapshot: null,
      plan: null,
      error_detail: null,
      result: { photoHold: { units: ["u1", "u2"] } },
      draft_id: null,
      origin_run_id: null,
      conversation_id: null,
    });
    // The free redesign stays used (jobs.ts FREE_HOLDING_STATUSES), and the
    // photo claim can still be settled.
    expect(
      await count(
        `select count(*) as n from mink_revamps
          where store_id = $1 and kind = 'full' and free
            and status in ('queued','running','ready','superseded')
            and jsonb_typeof(result -> 'photoHold') = 'object'`,
        [storeId],
      ),
    ).toBe(1);
    expect(
      await count("select count(*) as n from mink_drafts where store_id = $1", [
        storeId,
      ]),
    ).toBe(0);
    expect((await storefrontImageUsage(storeId, image)).redesignCard).toBe(
      false,
    );
  });

  it("5b-d. ★ strips never-applied redesigns, keeps applied ones whole, and the redo memory forgets only what nobody applied", async () => {
    // b: an audited coupon and a never-applied PAID card in one chat.
    const b = await chat({ idleDays: 91, createdDaysAgo: 100 });
    const couponRun = await run(b, {
      currentPath: "/dashboard/users?q=Ramesh",
    });
    const cardRun = await run(b);
    const coupon = await draft(couponRun);
    const couponApproval = await approval(coupon);
    const paid = await redesign(b, cardRun, {
      status: "ready",
      plan: "Paid look",
    });
    await client.query(
      `insert into mink_draft_credit_usage(draft_id,store_id,run_id,draft_kind,period,expected_credits,charged_credits,plan_credits,balance_credits,source)
       values($1,$2,$3,'storefront_personalization','2026-10',5,5,0,5,'credit')`,
      [paid, storeId, cardRun],
    );
    // c: an applied refinement of a never-applied parent.
    const c = await chat({ idleDays: 91, createdDaysAgo: 100 });
    const parentRun = await run(c);
    const refineRun = await run(c);
    const parent = await redesign(c, parentRun, {
      status: "superseded",
      plan: "First look",
      withDraft: true,
    });
    const refined = await redesign(c, refineRun, {
      status: "ready",
      kind: "refine",
      parentId: parent,
      applied: true,
      plan: "Warmer look",
    });
    await client.query(
      "update mink_revamps set superseded_by = $1 where id = $2",
      [refined, parent],
    );
    const applyApproval = await approval(refined, {
      tool: "apply_storefront_personalization",
      resourceType: "storefront",
      resourceId: storeId,
    });
    // d: a failed and a cancelled redesign, nothing else.
    const d = await chat({ idleDays: 91, createdDaysAgo: 100 });
    const dRun = await run(d, { status: "failed" });
    const failed = await redesign(d, dRun, { status: "failed", free: true });
    const cancelled = await redesign(d, dRun, { status: "cancelled" });

    await sweep();

    // b: reduced; the card's draft, credit row and run went; the coupon stays.
    expect((await chatRow(b))?.status).toBe("deleted");
    expect(
      await one(
        "select status, draft_id, plan from mink_revamps where id = $1",
        [paid],
      ),
    ).toEqual({ status: "superseded", draft_id: null, plan: null });
    expect(
      await count("select count(*) as n from mink_drafts where id = $1", [
        paid,
      ]),
    ).toBe(0);
    expect(
      await count(
        "select count(*) as n from mink_draft_credit_usage where draft_id = $1",
        [paid],
      ),
    ).toBe(0);
    expect(
      await count("select count(*) as n from mink_runs where id = $1", [
        cardRun,
      ]),
    ).toBe(0);
    expect(
      await one("select current_path from mink_runs where id = $1", [
        couponRun,
      ]),
    ).toEqual({ current_path: null });
    expect(
      await count(
        "select count(*) as n from mink_action_audit where approval_id = $1",
        [couponApproval],
      ),
    ).toBe(1);

    // c: reduced; the parent stripped with its draft and run gone, the
    // applied refinement untouched.
    expect((await chatRow(c))?.status).toBe("deleted");
    expect(
      await one(
        "select status, plan, request, draft_id from mink_revamps where id = $1",
        [parent],
      ),
    ).toEqual({
      status: "superseded",
      plan: null,
      request: { kind: "full" },
      draft_id: null,
    });
    expect(
      await count("select count(*) as n from mink_runs where id = $1", [
        parentRun,
      ]),
    ).toBe(0);
    expect(
      await one(
        `select status, draft_id, plan -> 'plan' as plan, snapshot, request
           from mink_revamps where id = $1`,
        [refined],
      ),
    ).toEqual({
      status: "ready",
      draft_id: refined,
      plan: { summary: "Warmer look" },
      snapshot: { pages: [] },
      request: { kind: "refine", instruction: "warmer" },
    });
    expect(
      await count(
        "select count(*) as n from mink_action_audit where approval_id = $1",
        [applyApproval],
      ),
    ).toBe(1);

    // d: deleted, both redesigns stripped.
    expect(await chatRow(d)).toBeUndefined();
    for (const id of [failed, cancelled]) {
      expect(
        await one(
          "select request, requester_email, error_detail, conversation_id from mink_revamps where id = $1",
          [id],
        ),
      ).toEqual({
        request: { kind: "full" },
        requester_email: null,
        error_detail: null,
        conversation_id: null,
      });
    }
    expect(
      await one("select status, error_code from mink_revamps where id = $1", [
        failed,
      ]),
    ).toEqual({ status: "failed", error_code: "plan_failed" });

    // The redo memory now knows only the applied version.
    expect(
      await readEarlierRevampPlans({
        storeId,
        revampId: crypto.randomUUID(),
        limit: 10,
      }),
    ).toEqual([{ summary: "Warmer look" }]);
  });

  // ---------------------------------------------------------------------------
  // 6-7: what the sweep leaves alone.
  // ---------------------------------------------------------------------------

  it("5e. ★ an applied redesign, even one since replaced, is a record on its own", async () => {
    const idle = await chat({ idleDays: 91, createdDaysAgo: 100 });
    const runId = await run(idle);
    const applied = await redesign(idle, runId, {
      status: "superseded",
      applied: true,
      plan: "Applied, then replaced",
    });
    await sweep();
    expect((await chatRow(idle))?.status).toBe("deleted");
    // Its draft and the run behind it stay: ownership.ts reads them.
    expect(
      await one(
        "select draft_id, origin_run_id from mink_revamps where id = $1",
        [applied],
      ),
    ).toEqual({ draft_id: applied, origin_run_id: runId });
    expect(
      await count("select count(*) as n from mink_drafts where id = $1", [
        applied,
      ]),
    ).toBe(1);
  });

  it("5f. ★ F2: strips the redesigns nobody applied whose chat was deleted before, every night, and never an applied one", async () => {
    const gone = await chat();
    const goneRun = await run(gone);
    const cancelled = await redesign(gone, goneRun, {
      status: "cancelled",
      plan: "Never applied",
      photoHold: true,
    });
    const applied = await redesign(gone, goneRun, {
      status: "superseded",
      applied: true,
      withDraft: false,
      plan: "Applied",
    });
    // The delete of the revision being replaced: no strip, the chat simply
    // goes and the foreign key keeps its redesigns with no chat.
    await client.query("delete from mink_conversations where id = $1", [gone]);
    expect(
      await count(
        "select count(*) as n from mink_revamps where id = any($1::uuid[]) and conversation_id is null",
        [[cancelled, applied]],
      ),
    ).toBe(2);

    await sweep();
    expect(
      await one(
        "select status, request, requester_email, plan, snapshot, error_detail, result from mink_revamps where id = $1",
        [cancelled],
      ),
    ).toEqual({
      status: "cancelled",
      request: { kind: "full" },
      requester_email: null,
      plan: null,
      snapshot: null,
      error_detail: null,
      result: { photoHold: { units: ["u1", "u2"] } },
    });
    expect(
      await one(
        "select requester_email, plan from mink_revamps where id = $1",
        [applied],
      ),
    ).toEqual({
      requester_email: "owner@example.com",
      plan: { stage: "compiled", plan: { summary: "Applied" } },
    });
    // A stripped row is never written again (its row version stays).
    const version = await one(
      "select ctid::text from mink_revamps where id = $1",
      [cancelled],
    );
    await sweep();
    expect(
      await one("select ctid::text from mink_revamps where id = $1", [
        cancelled,
      ]),
    ).toEqual(version);
  });

  it("6a. leaves an idle chat whose redesign is still being made", async () => {
    const idle = await chat({ idleDays: 91, createdDaysAgo: 100 });
    await redesign(idle, await run(idle), { status: "queued" });
    await sweep();
    expect((await chatRow(idle))?.status).toBe("active");
  });

  it("6b. leaves an idle chat one of whose redesigns is being refined", async () => {
    const idle = await chat({ idleDays: 91, createdDaysAgo: 100 });
    const runId = await run(idle);
    const ready = await redesign(idle, runId, {
      status: "ready",
      plan: "Look",
    });
    const elsewhere = await chat();
    await redesign(elsewhere, await run(elsewhere), {
      status: "queued",
      kind: "refine",
      parentId: ready,
    });
    await sweep();
    expect((await chatRow(idle))?.status).toBe("active");
  });

  it("6c. leaves an idle chat with a reply still running", async () => {
    const idle = await chat({ idleDays: 91, createdDaysAgo: 100 });
    await run(idle, { status: "running" });
    await sweep();
    expect((await chatRow(idle))?.status).toBe("active");
  });

  it("7. ★ keeps a chat used in the last 90 days, by message or by opening it, and heals one the older revision used", async () => {
    const recent = await chat({ idleDays: 89 });
    // Last message 91 days ago, but opened since: listed until it is opened.
    const opened = await chat({
      idleDays: 91,
      createdDaysAgo: 100,
      expiresInDays: 0.1,
    });
    const idle = await chat({ idleDays: 91, createdDaysAgo: 100 });
    // The replaced revision wrote only its last message an hour ago: its
    // expiry, created + 90 days, has passed.
    const usedByOldRevision = await chat({
      idleDays: 1 / 24,
      createdDaysAgo: 95,
      expiresInDays: -5,
    });

    await getMinkConversation(actor(), opened);
    expect(
      await one(
        "select expires_at > now() + interval '89 days' as moved from mink_conversations where id = $1",
        [opened],
      ),
    ).toEqual({ moved: true });

    await sweep();

    expect((await chatRow(recent))?.status).toBe("active");
    expect((await chatRow(opened))?.status).toBe("active");
    expect(await chatRow(idle)).toBeUndefined();
    expect((await chatRow(usedByOldRevision))?.status).toBe("active");
    expect(
      await one(
        "select expires_at = last_message_at + interval '90 days' as healed from mink_conversations where id = $1",
        [usedByOldRevision],
      ),
    ).toEqual({ healed: true });
    const listed = (await listMinkConversations(actor())).conversations.map(
      (row) => row.id,
    );
    expect(listed).toEqual(
      expect.arrayContaining([recent, opened, usedByOldRevision]),
    );
  });

  // ---------------------------------------------------------------------------
  // 8: the merchant's delete.
  // ---------------------------------------------------------------------------

  it("7b. ★ never retires a chat whose last message is recent, even one the heal has not reached yet", async () => {
    // Two chats the replaced revision used an hour ago; a batch of one heals
    // only the first, and the last-message floor alone keeps the second.
    const first = await chat({
      idleDays: 1 / 24,
      createdDaysAgo: 95,
      expiresInDays: -6,
    });
    const second = await chat({
      idleDays: 1 / 24,
      createdDaysAgo: 95,
      expiresInDays: -5,
    });
    expect(await pruneIdleMinkConversations(floor(), 1)).toBe(0);
    expect((await chatRow(first))?.status).toBe("active");
    expect((await chatRow(second))?.status).toBe("active");
  });

  it("7c. ★ F3: the heal leaves a chat whose expiry is short only by its reply's own seconds", async () => {
    // Asked 89 days ago; the answer landed 40 seconds after the run start
    // set the expiry, as every answered chat's does.
    const answered = await chat({ idleDays: 89 });
    await client.query(
      "update mink_conversations set expires_at = last_message_at + interval '90 days' - interval '40 seconds' where id = $1",
      [answered],
    );
    const usedByOldRevision = await chat({
      idleDays: 1 / 24,
      createdDaysAgo: 89,
      expiresInDays: 1,
    });
    const before = await one(
      "select expires_at::text from mink_conversations where id = $1",
      [answered],
    );
    await sweep();
    expect(
      await one(
        "select expires_at::text from mink_conversations where id = $1",
        [answered],
      ),
    ).toEqual(before);
    expect(
      await one(
        "select expires_at = last_message_at + interval '90 days' as healed from mink_conversations where id = $1",
        [usedByOldRevision],
      ),
    ).toEqual({ healed: true });
  });

  it("8. ★ the merchant's delete keeps approved work: reduces, and refuses only a redesign being made", async () => {
    const approved = await chat();
    const approvedRun = await run(approved);
    await message(approved, approvedRun, "user", "Make a coupon");
    const executed = await approval(await draft(approvedRun));
    await expect(deleteMinkConversation(actor(), approved)).resolves.toBe(
      "reduced",
    );
    expect((await chatRow(approved))?.status).toBe("deleted");
    expect(
      await count(
        "select count(*) as n from mink_action_audit where approval_id = $1",
        [executed],
      ),
    ).toBe(1);
    // Asked again: it is gone for the merchant, from the list and search too
    // (its expiry is still months away, so only its status hides it).
    await expect(
      deleteMinkConversation(actor(), approved),
    ).rejects.toMatchObject({ code: "conversation_not_found", status: 404 });
    expect(
      (await listMinkConversations(actor())).conversations.map((row) => row.id),
    ).not.toContain(approved);
    expect(
      (await searchMinkConversations(actor(), { query: "deleted chat" }))
        .conversations,
    ).toEqual([]);

    // A chat holding a ready, APPLIED card: reduced, the redesign untouched.
    const appliedChat = await chat();
    const appliedRun = await run(appliedChat);
    const applied = await redesign(appliedChat, appliedRun, {
      status: "ready",
      applied: true,
      plan: "Applied look",
    });
    await approval(applied, {
      tool: "apply_storefront_personalization",
      resourceType: "storefront",
      resourceId: storeId,
    });
    await expect(deleteMinkConversation(actor(), appliedChat)).resolves.toBe(
      "reduced",
    );
    expect(
      await one("select status, draft_id from mink_revamps where id = $1", [
        applied,
      ]),
    ).toEqual({ status: "ready", draft_id: applied });

    // Another admin's chat is not found for this one.
    const theirs = await chat({ admin: OTHER_ADMIN });
    await expect(deleteMinkConversation(actor(), theirs)).rejects.toMatchObject(
      { status: 404 },
    );
    expect((await chatRow(theirs))?.status).toBe("active");
  });

  it("8b. ★ refuses while a redesign is still being made, in plain words", async () => {
    const making = await chat();
    await redesign(making, await run(making), { status: "running" });
    await expect(deleteMinkConversation(actor(), making)).rejects.toMatchObject(
      {
        code: "conversation_has_redesign",
        status: 409,
        message:
          "A storefront redesign from this chat is still being made. Wait for it to finish, or stop it from its card, then delete this chat.",
      },
    );
    expect((await chatRow(making))?.status).toBe("active");
  });

  // ---------------------------------------------------------------------------
  // 9: the 0248 backfill.
  // ---------------------------------------------------------------------------

  it("9. ★ the backfill lists a chat begun long ago but used recently, and leaves an idle one hidden", async () => {
    const usedRecently = await chat({
      idleDays: 10,
      createdDaysAgo: 100,
      expiresInDays: -10,
    });
    const idle = await chat({
      idleDays: 95,
      createdDaysAgo: 100,
      expiresInDays: -10,
    });
    await client.query(
      readFileSync(
        "drizzle/migrations/sql/20261026_0248_mink_chat_history_retention.sql",
        "utf8",
      ),
    );
    expect(
      await one(
        "select expires_at = last_message_at + interval '90 days' as backfilled from mink_conversations where id = $1",
        [usedRecently],
      ),
    ).toEqual({ backfilled: true });
    const listed = (await listMinkConversations(actor())).conversations.map(
      (row) => row.id,
    );
    expect(listed).toContain(usedRecently);
    expect(listed).not.toContain(idle);
  });

  // ---------------------------------------------------------------------------
  // 10: search, and the stopped question.
  // ---------------------------------------------------------------------------

  it("10. ★ searches titles and visible messages in any script, the viewer's own chats only", async () => {
    const hindi = await chat({ title: "Orders" });
    const hindiRun = await run(hindi);
    const hindiMessage = await message(
      hindi,
      hindiRun,
      "user",
      "मेरा ऑर्डर स्टेटस बताओ",
    );
    const punjabi = await chat({ title: "Totals" });
    await message(
      punjabi,
      await run(punjabi),
      "assistant",
      "ਅੱਜ ਦੇ ਟੋਟਲ ਕਿੰਨੇ ਆਰਡਰ ਆਏ",
    );
    const hinglish = await chat({ title: "Delivery" });
    await message(
      hinglish,
      await run(hinglish),
      "user",
      "mera order kab aayega",
    );
    const titled = await chat({ title: "Zebracode coupon ideas" });
    // A failed run's hidden message holds the same word: never the snippet.
    await message(
      titled,
      await run(titled, { status: "failed" }),
      "user",
      "zebracode HIDDEN failed run words",
    );
    const theirs = await chat({ title: "Zebracode", admin: OTHER_ADMIN });
    await message(
      theirs,
      await run(theirs, { admin: OTHER_ADMIN }),
      "user",
      "zebracode from staff",
    );
    // A chat whose older visible message matches and newer hidden one too.
    const mixed = await chat({ title: "Coupons" });
    const visible = await message(
      mixed,
      await run(mixed),
      "assistant",
      "Your zebracode coupon saved 20 orders",
      10,
    );
    await message(
      mixed,
      await run(mixed, { status: "failed" }),
      "user",
      "zebracode newer hidden words",
      1,
    );

    const search = async (query: string) =>
      (await searchMinkConversations(actor(), { query })).conversations;

    const devanagari = await search("स्टे");
    expect(devanagari.map((row) => row.id)).toEqual([hindi]);
    expect(devanagari[0].snippet).toContain("«स्टेटस»");
    expect(devanagari[0].matchMessageId).toBe(hindiMessage);
    expect((await search("ਆਰਡ")).map((row) => row.id)).toEqual([punjabi]);
    expect((await search("kab aayega")).map((row) => row.id)).toEqual([
      hinglish,
    ]);

    const zebra = await search("zebracode");
    expect(zebra.map((row) => row.id).sort()).toEqual([titled, mixed].sort());
    expect(zebra.find((row) => row.id === titled)).toMatchObject({
      snippet: null,
      matchMessageId: null,
    });
    expect(zebra.find((row) => row.id === mixed)).toMatchObject({
      snippet: expect.stringContaining("«zebracode»"),
      matchMessageId: visible,
    });
    expect(zebra.map((row) => row.id)).not.toContain(theirs);
    expect(await search("HIDDEN")).toEqual([]);
  });

  it("10b. ★ a stopped question shows in its chat and is found, and the model never gets it back", async () => {
    const stoppedChat = await chat({ title: "Dikhao" });
    const stoppedRun = await run(stoppedChat, {
      status: "cancelled",
      stopped: true,
    });
    const question = await message(
      stoppedChat,
      stoppedRun,
      "user",
      "Pichle hafte ke zebrastop orders dikhao",
    );
    // A run that failed by itself stays hidden, as before.
    await message(
      stoppedChat,
      await run(stoppedChat, { status: "failed" }),
      "user",
      "zebrafailed words",
    );

    const detail = await getMinkConversation(actor(), stoppedChat);
    expect(detail.messages.map((row) => [row.id, row.role])).toEqual([
      [question, "user"],
    ]);
    const found = (
      await searchMinkConversations(actor(), { query: "zebrastop" })
    ).conversations;
    expect(found).toMatchObject([
      { id: stoppedChat, matchMessageId: question },
    ]);
    expect(found[0].snippet).toContain("«zebrastop»");
    expect(
      (await searchMinkConversations(actor(), { query: "zebrafailed" }))
        .conversations,
    ).toEqual([]);

    // Continuing the chat replays only answered turns to Mink.
    const started = await startMinkRun({
      actor: actor(),
      conversationId: stoppedChat,
      message: "Ab dikhao",
      model: "fixture",
    });
    expect(started.history).toEqual([]);
  });

  it("10c. ★ F6: finds the exact identifiers a merchant copies from a chat, in any script", async () => {
    const ZWJ = String.fromCharCode(0x200d);
    const facts: [string, string][] = [
      ["Please email priya.sharma@gmail.com about the refund", "Refund"],
      ["Customer phone +919876543210 called", "Phone"],
      ["Customer phone +91 98765 43210 called", "Spaced phone"],
      ["Call 98765-43210 today", "Hyphen phone"],
      ["The price is 1299.50 now", "Price"],
      ["Use coupon DIWALI-20 at checkout", "Coupon"],
      ["Invoice INV-2026-0001 is ready", "Invoice"],
      ["Visit shop.example.com today", "Website"],
      ["Attached report.pdf here", "File"],
      ["Order the t-shirt in blue", "Shirt"],
      ["ஆர்டர் நிலை சொல்லுங்கள்", "Tamil"],
      ["অর্ডার দেখাও", "Bengali"],
      [`ওয়েবসাইটের র${ZWJ}্যাংকিং বাড়ান`, "Bengali joiner"],
    ];
    const chats = new Map<string, string>();
    for (const [text, title] of facts) {
      const id = await chat({ title });
      await message(id, await run(id), "assistant", text);
      chats.set(title, id);
    }
    const search = async (query: string) =>
      (await searchMinkConversations(actor(), { query })).conversations.map(
        (row) => row.id,
      );
    const cases: [string, string][] = [
      ["priya.sharma@gmail.com", "Refund"],
      // Typed halfway: the address whole is a prefix.
      ["priya.sharma@gm", "Refund"],
      ["+919876543210", "Phone"],
      ["+91 98765 43210", "Spaced phone"],
      ["98765-43210", "Hyphen phone"],
      ["1299.50", "Price"],
      ["DIWALI-20", "Coupon"],
      ["INV-2026-0001", "Invoice"],
      ["shop.example.com", "Website"],
      ["report.pdf", "File"],
      ["t-shirt", "Shirt"],
      ["ஆர்", "Tamil"],
      ["অর্ডা", "Bengali"],
      [`র${ZWJ}্যাংকিং`, "Bengali joiner"],
    ];
    for (const [query, title] of cases) {
      expect(await search(query), query).toEqual([chats.get(title)]);
    }
  });

  it("10d. ★ F16: searches what the chat shows, never an attachment's hidden marker, address or reading", async () => {
    const withFiles = await chat({ title: "Launch" });
    const filesRun = await run(withFiles);
    const sent = addReviewedMinkDocument(
      addSavedMinkMediaReference("Use this photo for the zebralaunch banner", {
        url: "https://storage.googleapis.com/bucket/stores/x/media/zebrafile.webp",
        filename: "zebrafile.webp",
      }),
      "Kaju katli zebrareading box of 500 g",
      { filename: "notes.txt", kind: "document" },
    );
    const question = await message(withFiles, filesRun, "user", sent);
    // A message of files alone: the marker has lost its blank line.
    const filesOnly = await chat({ title: "Untitled" });
    await message(
      filesOnly,
      await run(filesOnly),
      "user",
      addSavedMinkMediaReference("", {
        url: "https://storage.googleapis.com/bucket/stores/x/media/zebraonly.webp",
        filename: "zebraonly.webp",
      }),
    );
    // Mink's answers are searched whole, even one quoting a marker.
    const answered = await chat({ title: "Quote" });
    await message(
      answered,
      await run(answered),
      "assistant",
      `You wrote:${REVIEWED_DOCUMENT_MARKER}zebraquoted`,
    );

    const search = async (query: string) =>
      (await searchMinkConversations(actor(), { query })).conversations;
    const found = await search("zebralaunch");
    expect(found.map((row) => row.id)).toEqual([withFiles]);
    expect(found[0].matchMessageId).toBe(question);
    expect(found[0].snippet).toContain("«zebralaunch»");
    expect(found[0].snippet).not.toMatch(/untrusted|Media Library|https|\{/);
    for (const hidden of ["zebrafile", "zebraonly", "zebrareading"]) {
      expect(await search(hidden), hidden).toEqual([]);
    }
    // The marker's own words and the JSON's keys find only the answer that
    // quotes a marker, never a chat for its files.
    for (const hidden of ["untrusted", "instructions", "filename", "storage"]) {
      const ids = (await search(hidden)).map((row) => row.id);
      expect(ids, hidden).not.toContain(withFiles);
      expect(ids, hidden).not.toContain(filesOnly);
    }
    expect((await search("zebraquoted")).map((row) => row.id)).toEqual([
      answered,
    ]);
    expect((await search("untrusted")).map((row) => row.id)).toEqual([
      answered,
    ]);
  });

  it("10e. ★ F10: a stopped question asked again shows once, as the question asked again", async () => {
    const voice = await chat({ title: "Voice" });
    const stoppedRun = await run(voice, { status: "cancelled", stopped: true });
    const stopped = await message(
      voice,
      stoppedRun,
      "user",
      "Show me zebravoice orders",
      3,
    );
    const askedRun = await run(voice);
    const asked = await message(
      voice,
      askedRun,
      "user",
      "Show me zebravoice orders from last week",
      2,
    );
    await message(voice, askedRun, "assistant", "Here they are.", 1);

    const detail = await getMinkConversation(actor(), voice);
    expect(detail.messages.map((row) => row.id)).not.toContain(stopped);
    expect(detail.messages.map((row) => row.id)).toContain(asked);
    const found = (
      await searchMinkConversations(actor(), { query: "zebravoice" })
    ).conversations;
    expect(found).toMatchObject([{ id: voice, matchMessageId: asked }]);

    // Asked again, but that reply failed (hidden): the stopped one stays.
    const kept = await chat({ title: "Kept" });
    const keptQuestion = await message(
      kept,
      await run(kept, { status: "cancelled", stopped: true }),
      "user",
      "zebrakept stock",
      3,
    );
    await message(
      kept,
      await run(kept, { status: "failed" }),
      "user",
      "zebrakept stock please",
      2,
    );
    // A different next question: the stopped one stays too.
    const other = await chat({ title: "Other" });
    const otherQuestion = await message(
      other,
      await run(other, { status: "cancelled", stopped: true }),
      "user",
      "zebraother sales",
      3,
    );
    await message(other, await run(other), "user", "Something else", 2);
    expect(
      (await getMinkConversation(actor(), kept)).messages.map((row) => row.id),
    ).toEqual([keptQuestion]);
    expect(
      (await getMinkConversation(actor(), other)).messages.map((row) => row.id),
    ).toContain(otherQuestion);
  });

  // ---------------------------------------------------------------------------
  // 11-13: privileges, the frozen foreign keys, and D6.
  // ---------------------------------------------------------------------------

  it("11. ★ reducing needs each DELETE grant of 0248, and they are enough", async () => {
    const approved = await chat();
    const runId = await run(approved);
    await message(approved, runId, "user", "Make a coupon");
    await approval(await draft(runId));
    // An unconfirmed preview: the reduce deletes it from the approvals.
    await approval(await draft(runId), { status: "pending" });
    const grants = readFileSync(
      "drizzle/migrations/sql/20261026_0248_mink_chat_history_retention.sql",
      "utf8",
    )
      .split("\n")
      .filter((line) => line.startsWith("GRANT DELETE ON TABLE"));
    expect(grants).toHaveLength(3);
    for (const table of [
      "mink_messages",
      "mink_feedback",
      "mink_action_approvals",
    ]) {
      // A database without the default privileges: this one grant missing.
      await client.query("SAVEPOINT history_revoked");
      await client.query(
        `revoke delete on table public.${table} from app_service`,
      );
      await expect(
        deleteMinkConversation(actor(), approved),
        table,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      // 0248's grants put it back.
      for (const grant of grants) await client.query(grant);
      await expect(deleteMinkConversation(actor(), approved)).resolves.toBe(
        "reduced",
      );
      await client.query("ROLLBACK TO SAVEPOINT history_revoked");
      await client.query("RELEASE SAVEPOINT history_revoked");
    }
  });

  it("12. ★ the foreign keys in and out of every Mink record table are the ones retiring was designed for", async () => {
    // Any new key, in or out: decide whether retireMinkConversation or the
    // privacy wording must change, then update this list.
    const { rows } = await client.query(`
      with t(name) as (values ('mink_conversations'),('mink_runs'),('mink_messages'),
        ('mink_drafts'),('mink_draft_versions'),('mink_draft_credit_usage'),
        ('mink_action_approvals'),('mink_action_audit'),('mink_blog_publications'),
        ('mink_revamps'),('mink_revamp_images'),('mink_feedback'),('mink_tool_calls'),
        ('mink_usage_ledger'))
      select con.conname || ' ' || con.conrelid::regclass::text || ' -> ' ||
             con.confrelid::regclass::text || ' ' || con.confdeltype::text as key
        from pg_constraint con
       where con.contype = 'f'
         and (con.conrelid::regclass::text in (select name from t)
              or con.confrelid::regclass::text in (select name from t))
       order by 1`);
    expect(rows.map((row) => row.key)).toEqual([
      "email_campaigns_mink_approval_store_fkey email_campaigns -> mink_action_approvals a",
      "mink_action_approvals_draft_store_fkey mink_action_approvals -> mink_drafts c",
      "mink_action_approvals_source_store_fkey mink_action_approvals -> mink_action_approvals c",
      "mink_action_approvals_store_id_fkey mink_action_approvals -> stores c",
      "mink_action_audit_approval_store_fkey mink_action_audit -> mink_action_approvals c",
      "mink_attachments_conversation_fkey mink_attachments -> mink_conversations n",
      "mink_blog_publications_approval_store_fkey mink_blog_publications -> mink_action_approvals a",
      "mink_blog_publications_blog_store_fkey mink_blog_publications -> blogs c",
      "mink_blog_publications_draft_store_fkey mink_blog_publications -> mink_drafts a",
      "mink_blog_publications_store_id_fkey mink_blog_publications -> stores c",
      "mink_conversations_store_id_fkey mink_conversations -> stores c",
      "mink_draft_credit_usage_draft_store_fkey mink_draft_credit_usage -> mink_drafts c",
      "mink_draft_credit_usage_run_store_fkey mink_draft_credit_usage -> mink_runs c",
      "mink_draft_versions_draft_store_fkey mink_draft_versions -> mink_drafts c",
      "mink_drafts_run_store_fkey mink_drafts -> mink_runs c",
      "mink_drafts_store_id_fkey mink_drafts -> stores c",
      "mink_feedback_run_store_fkey mink_feedback -> mink_runs c",
      "mink_feedback_store_id_fkey mink_feedback -> stores c",
      "mink_messages_conversation_store_fkey mink_messages -> mink_conversations c",
      "mink_messages_run_store_fkey mink_messages -> mink_runs c",
      "mink_messages_store_id_fkey mink_messages -> stores c",
      "mink_revamp_images_revamp_id_fkey mink_revamp_images -> mink_revamps c",
      "mink_revamp_images_store_id_fkey mink_revamp_images -> stores c",
      "mink_revamps_conversation_id_fkey mink_revamps -> mink_conversations n",
      "mink_revamps_draft_id_fkey mink_revamps -> mink_drafts n",
      "mink_revamps_origin_run_id_fkey mink_revamps -> mink_runs n",
      "mink_revamps_parent_id_fkey mink_revamps -> mink_revamps n",
      "mink_revamps_store_id_fkey mink_revamps -> stores c",
      "mink_revamps_superseded_by_fkey mink_revamps -> mink_revamps n",
      "mink_runs_conversation_store_fkey mink_runs -> mink_conversations c",
      "mink_runs_store_id_fkey mink_runs -> stores c",
      "mink_tool_calls_run_store_fkey mink_tool_calls -> mink_runs c",
      "mink_tool_calls_store_id_fkey mink_tool_calls -> stores c",
      "mink_usage_ledger_run_store_fkey mink_usage_ledger -> mink_runs c",
      "mink_usage_ledger_store_id_fkey mink_usage_ledger -> stores c",
    ]);
    // ★ D6 (0250): no key from an approval to its product. The name 0042's
    //   durable verify checks survives as an always-true CHECK; never drop it.
    expect(
      (
        await client.query(
          `select contype, pg_get_constraintdef(oid) as definition
             from pg_constraint
            where conname = 'mink_action_approvals_product_store_fkey'`,
        )
      ).rows,
    ).toEqual([
      {
        contype: "c",
        definition: "CHECK (((product_id IS NULL) OR (store_id IS NOT NULL)))",
      },
    ]);
  });

  it("13. ★ D6: deleting a product keeps the Mink AI approval that changed it, and its audit row", async () => {
    const product = (
      await client.query(
        "insert into products(store_id,name,slug) values($1,'Almond shake','almond-shake') returning id",
        [storeId],
      )
    ).rows[0].id as string;
    const active = await chat();
    const runId = await run(active);
    const proposal = await draft(runId, { kind: "product_description" });
    const executed = await approval(proposal, {
      tool: "apply_product_description",
      resourceType: "product",
      resourceId: product,
      productId: product,
      productVersion: "2026-10-26 07:00:00+00",
    });

    await client.query("SET ROLE app_service");
    await client.query("delete from products where id = $1 and store_id = $2", [
      product,
      storeId,
    ]);
    await client.query("RESET ROLE");

    expect(
      await one(
        "select status, product_id from mink_action_approvals where id = $1",
        [executed],
      ),
    ).toEqual({ status: "executed", product_id: product });
    expect(
      await count(
        "select count(*) as n from mink_action_audit where approval_id = $1",
        [executed],
      ),
    ).toBe(1);
    // The product draft's card reads no last change, as it did before.
    await expect(
      getLatestMinkProductAction(actor(), proposal),
    ).resolves.toBeNull();
  });

  it("retires through one function: an ordinary chat is deleted directly", async () => {
    const plain = await chat();
    await message(plain, await run(plain), "user", "Hi");
    await expect(
      service.db
        ? retireMinkConversation(service.db, {
            storeId,
            conversationId: plain,
          })
        : Promise.reject(new Error("no db")),
    ).resolves.toBe("deleted");
    expect(await chatRow(plain)).toBeUndefined();
  });
});
