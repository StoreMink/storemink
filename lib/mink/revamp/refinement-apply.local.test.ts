/** A redesign with more than one version, applied against the real local
 * database (chat-1): the real personalisation preview over revamp jobs whose
 * earlier versions were applied or undone after a refinement was asked for,
 * and over a card whose refinement is still being made.
 *
 * Run with MINK_REVAMP_LOCAL_TEST=1. The fixed loopback database keeps it
 * away from Cloud SQL, and every store it makes is deleted in `afterAll`.
 * ★ The point is the SQL: the job lock, the refinement read and the lock of
 *   each earlier version run as written, which a faked database cannot show.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import type { MinkActorContext } from "../types";
import type { RevampStoredPlan } from "./contract";

vi.hoisted(() => {
  // ★ Set before any module reads them: the real database client builds its
  //   pool from these on first use.
  if (process.env.MINK_REVAMP_LOCAL_TEST === "1") {
    process.env.DB_HOST = "127.0.0.1";
    process.env.DB_PORT = "5544";
    process.env.DB_NAME = "storemink_local";
    process.env.DB_USER = process.env.USER ?? "postgres";
    process.env.DB_POOL_MAX = "4";
    delete process.env.DB_PASSWORD;
  }
});

vi.mock("@/lib/notifications/record", () => ({
  emitEvent: vi.fn(),
  recordEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: vi.fn(async () => undefined),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: vi.fn(),
}));

const OWNER = "revamp-refine-owner";
/** The merchant's product as a request stores it. */
const SHAKE = {
  key: "p1",
  name: "Almond shake",
  description: "Cold-pressed almonds and dates.",
  sizes: [{ label: "", price: 120, mrp: null }],
  photoUrl: null,
  categorySlug: "shakes",
};
const SHAKES = {
  action: "create",
  name: "Shakes",
  slug: "shakes",
  description: null,
  newPhoto: false,
};

function request(
  kind: "full" | "refine",
  carried: { products: unknown[]; categories: unknown[] },
) {
  return {
    kind,
    brief: {
      business: "A shake bar in Pune",
      look: "",
      audience: "",
      facts: [],
      avoid: "",
      language: "English",
    },
    products: carried.products,
    categories: carried.categories,
    pages: null,
    instruction: kind === "refine" ? "Make it warmer" : null,
    refineScope:
      kind === "refine"
        ? {
            design: true,
            copy: false,
            layout: false,
            photos: null,
            pages: null,
            products: false,
          }
        : null,
  };
}

function emptyPlan(revampId: string): RevampStoredPlan {
  return {
    schemaVersion: 2,
    revampId,
    kind: "refine",
    summary: "A warmer look for a shake bar.",
    pages: [],
    chrome: null,
    brand: null,
    categories: [],
    products: { hide: [], create: [] },
    photos: [],
    checks: [],
    skipped: [],
    notes: [],
    explanation: "Mink AI redesigned your storefront.",
    credits: {
      pages: 0,
      photos: 0,
      design: 0,
      chrome: 0,
      categories: 0,
      productPhotos: 0,
      total: 0,
    },
    free: false,
  };
}

const enabled = process.env.MINK_REVAMP_LOCAL_TEST === "1";
describe.skipIf(!enabled)(
  "a redesign with more than one version, on local Postgres (chat-1)",
  () => {
    let client: Client;
    let closePool: () => Promise<void>;
    let actions: typeof import("../storefront-personalization-actions");
    let errors: typeof import("../errors");
    let codeContract: typeof import("../storefront-code-contract");
    const stores: string[] = [];

    /** A store, its owner's chat and run. */
    async function store(): Promise<{
      actor: MinkActorContext;
      conversationId: string;
    }> {
      const storeId = crypto.randomUUID();
      stores.push(storeId);
      await client.query(
        `insert into stores(id, slug, name, status, plan, settings)
         values ($1, $2, 'Shake Bar', 'active', 'pro', $3)`,
        [
          storeId,
          `revamp-refine-${storeId.slice(0, 8)}`,
          { launched: true, brand: { name: "Shake Bar" } },
        ],
      );
      const adminId = `${OWNER}-${storeId.slice(0, 8)}`;
      const conversationId = crypto.randomUUID();
      await client.query(
        `insert into mink_conversations(id, store_id, admin_id, title)
         values ($1, $2, $3, 'Customise my store')`,
        [conversationId, storeId, adminId],
      );
      const runId = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      await client.query(
        `insert into mink_runs(id, store_id, conversation_id, requested_by, request_id, model)
         values ($1, $2, $3, $4, $5, 'fixture')`,
        [runId, storeId, conversationId, adminId, requestId],
      );
      return {
        conversationId,
        actor: {
          storeId,
          adminId,
          email: "owner@shake.example",
          roleSlug: "superadmin",
          permissions: {},
          isSuperadmin: true,
          effectivePlan: "pro",
          locationIds: null,
          analyticsTimeZone: "Asia/Kolkata",
          currency: "INR",
          defaultLowStockThreshold: 5,
          requestId,
          runId,
          draftingEnabled: true,
        },
      };
    }

    /** A revamp job; a ready one gets its card's draft (same id). */
    async function revamp(
      owner: { actor: MinkActorContext; conversationId: string },
      input: {
        kind: "full" | "refine";
        status: string;
        parentId?: string | null;
        carried?: { products: unknown[]; categories: unknown[] };
        appliedAt?: string | null;
        undoneAt?: string | null;
        errorCode?: string | null;
      },
    ): Promise<string> {
      const id = crypto.randomUUID();
      const { actor } = owner;
      if (input.status === "ready") {
        const plan = emptyPlan(id);
        await client.query(
          `insert into mink_drafts(id, store_id, admin_id, run_id, kind, destination_type,
             destination_label, destination_path, title, content_json,
             expected_credits, charged_credits, credit_source)
           values ($1, $2, $3, $4, 'storefront_personalization', 'storefront',
             'Whole storefront', '/dashboard/builder', 'Your store redesign', $5,
             0, 0, 'free')`,
          [
            id,
            actor.storeId,
            actor.adminId,
            actor.runId,
            {
              plan_json: JSON.stringify(plan),
              plan_digest: codeContract.digestMinkStorefrontValue(plan),
              explanation: plan.explanation,
            },
          ],
        );
      }
      await client.query(
        `insert into mink_revamps(id, store_id, admin_id, conversation_id, origin_run_id,
           parent_id, kind, status, step, request, draft_id, applied_at, undone_at,
           error_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'card', $9, $10, $11, $12, $13)`,
        [
          id,
          actor.storeId,
          actor.adminId,
          owner.conversationId,
          actor.runId,
          input.parentId ?? null,
          input.kind,
          input.status,
          request(
            input.kind,
            input.carried ?? { products: [], categories: [] },
          ),
          input.status === "ready" ? id : null,
          input.appliedAt ?? null,
          input.undoneAt ?? null,
          input.errorCode ?? null,
        ],
      );
      return id;
    }

    async function preview(actor: MinkActorContext, revampId: string) {
      return actions.previewMinkStorefrontPersonalizationAction({
        actor,
        draftId: revampId,
        expectedDraftVersion: 0,
        idempotencyKey: crypto.randomUUID(),
      });
    }

    async function refusal(promise: Promise<unknown>) {
      const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(errors.MinkRequestError);
      return error as InstanceType<typeof errors.MinkRequestError>;
    }

    const carriedShake = { products: [SHAKE], categories: [SHAKES] };

    beforeAll(async () => {
      const pg = await import("pg");
      const { postgresStringTimestampTypes } =
        await import("@/lib/db/pg-types");
      client = new pg.Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: process.env.USER,
        types: postgresStringTimestampTypes,
      });
      await client.connect();
      actions = await import("../storefront-personalization-actions");
      errors = await import("../errors");
      codeContract = await import("../storefront-code-contract");
      ({ closePool } = await import("@/lib/db/client"));
    }, 60_000);

    afterAll(async () => {
      if (client) {
        for (const storeId of stores) {
          try {
            await client.query("begin");
            await client.query("set constraints all deferred");
            await client.query("delete from stores where id = $1", [storeId]);
            await client.query("commit");
          } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
          }
        }
      }
      await client?.end();
      await closePool?.();
    }, 60_000);

    it("★★ refuses a refinement whose earlier version was applied after it was asked for", async () => {
      const owner = await store();
      // A asked for the shake and its category; B, asked for while A was not
      // applied, carries both; A was applied since.
      const a = await revamp(owner, {
        kind: "full",
        status: "superseded",
        carried: carriedShake,
        appliedAt: new Date().toISOString(),
      });
      const b = await revamp(owner, {
        kind: "refine",
        status: "ready",
        parentId: a,
        carried: carriedShake,
      });
      const error = await refusal(preview(owner.actor, b));
      expect(error.code).toBe("mink_revamp_parent_applied");
    });

    it("★★ refuses a refinement whose earlier version was undone after it was asked for, two versions up", async () => {
      const owner = await store();
      // A was on the store when B and then C were asked for, so neither
      // carries the shake; A was undone since.
      const a = await revamp(owner, {
        kind: "full",
        status: "superseded",
        carried: carriedShake,
        appliedAt: "2026-10-20T10:00:00Z",
        undoneAt: "2026-10-22T10:00:00Z",
      });
      const b = await revamp(owner, {
        kind: "refine",
        status: "superseded",
        parentId: a,
      });
      const c = await revamp(owner, {
        kind: "refine",
        status: "ready",
        parentId: b,
      });
      const error = await refusal(preview(owner.actor, c));
      expect(error.code).toBe("mink_revamp_parent_undone");
    });

    it("previews a refinement that still fits its earlier versions", async () => {
      const owner = await store();
      const a = await revamp(owner, {
        kind: "full",
        status: "superseded",
        carried: carriedShake,
      });
      const b = await revamp(owner, {
        kind: "refine",
        status: "ready",
        parentId: a,
        carried: carriedShake,
      });
      expect((await preview(owner.actor, b)).status).toBe("pending");
    });

    it("★★ refuses a card while its refinement is being made, and previews it once that stopped", async () => {
      const owner = await store();
      const a = await revamp(owner, { kind: "full", status: "ready" });
      const building = await revamp(owner, {
        kind: "refine",
        status: "queued",
        parentId: a,
      });
      const error = await refusal(preview(owner.actor, a));
      expect(error.code).toBe("mink_revamp_refinement_building");
      await client.query(
        "update mink_revamps set status = 'failed', error_code = 'internal' where id = $1",
        [building],
      );
      expect((await preview(owner.actor, a)).status).toBe("pending");
    });
  },
);
